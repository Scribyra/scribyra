//! Write-ahead folder transactions. Only explicit connection/apply calls mutate
//! this directory. The browser must separately acknowledge its durable save.
use crate::{
    Data, Entry, MAX_BYTES, Plan, Request, Resolution, Root, Snapshot, invalid, plan, verify_review,
};
use cap_fs_ext::{DirExt, FollowSymlinks, OpenOptionsFollowExt};
use cap_std::fs::{Dir, DirBuilder, OpenOptions};
use scribyra_core::blob;
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use std::{
    collections::{BTreeMap, BTreeSet},
    io::{self, Read, Write},
};

const RECORD_LIMIT: usize = 8 * MAX_BYTES + 8 * 1024 * 1024;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Owner {
    pub project_id: String,
    pub scope: String,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum Phase {
    Prepared,
    DiskApplied,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RecoveryVersion {
    Base,
    Local,
    Disk,
    Result,
    Claimed,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Pending {
    pub id: String,
    pub phase: Phase,
    pub request: Request,
    pub review: Plan,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct State {
    pub version: u8,
    pub owner: Owner,
    pub baseline: Snapshot,
    pub pending: Option<Pending>,
    pub last_confirmed: Option<String>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Preview {
    pub request: Request,
    pub review: Plan,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum RecoveryStatus {
    Prepared,
    DiskApplied,
    Confirmed,
    Abandoned,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RecoverySummary {
    pub version: u8,
    pub id: String,
    pub owner: Owner,
    pub created_at: u64,
    pub status: RecoveryStatus,
    pub files: usize,
    pub result_hash: String,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Receipt {
    pub id: String,
    pub result: Snapshot,
    pub confirmed: bool,
}
#[derive(Clone, Debug)]
pub struct Progress {
    pub operation: &'static str,
    pub path: Option<String>,
}
pub struct Session {
    root: Root,
    control: Dir,
    objects: Dir,
    transactions: Dir,
    lock: std::fs::File,
    state: State,
    needs_reopen: bool,
}
impl Drop for Session {
    fn drop(&mut self) {
        // Explicit unlock also releases a briefly inherited descriptor during a
        // concurrent fork/exec; waiting only for close can leave a transient lock.
        let _ = self.lock.unlock();
    }
}

fn scope_valid(value: &str, limit: usize) -> bool {
    !value.is_empty() && value.len() <= limit && !value.chars().any(char::is_control)
}
fn sync_dir(dir: &Dir) -> io::Result<()> {
    #[cfg(unix)]
    // Directory capabilities may use O_PATH; fsync needs a readable handle.
    dir.open_with(".", &open_options(false, false))?
        .sync_all()?;
    Ok(())
}
fn open_options(write: bool, create_new: bool) -> OpenOptions {
    let mut o = OpenOptions::new();
    o.read(!create_new)
        .write(write)
        .create_new(create_new)
        .follow(FollowSymlinks::No);
    #[cfg(unix)]
    {
        use cap_std::fs::OpenOptionsExt;
        o.mode(0o600)
            .custom_flags(rustix::fs::OFlags::NONBLOCK.bits() as i32);
    }
    o
}
fn read_bytes(dir: &Dir, name: &str, limit: usize) -> io::Result<Vec<u8>> {
    let mut f = dir.open_with(name, &open_options(false, false))?;
    let before = f.metadata()?;
    if !before.is_file() || before.len() > limit as u64 {
        return Err(invalid("Recovery entry is not a bounded regular file."));
    }
    let mut bytes = Vec::new();
    Read::by_ref(&mut f)
        .take(limit as u64 + 1)
        .read_to_end(&mut bytes)?;
    let after = f.metadata()?;
    if bytes.len() > limit
        || bytes.len() as u64 != after.len()
        || before.len() != after.len()
        || before.modified()? != after.modified()?
    {
        return Err(invalid("A recovery/file entry changed while being read."));
    }
    Ok(bytes)
}
fn read_json<T: DeserializeOwned>(dir: &Dir, name: &str) -> io::Result<T> {
    serde_json::from_slice(&read_bytes(dir, name, RECORD_LIMIT)?)
        .map_err(|e| invalid(e.to_string()))
}
fn private_dir(parent: &Dir, name: &str) -> io::Result<Dir> {
    let mut builder = DirBuilder::new();
    #[cfg(unix)]
    {
        use cap_std::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    match parent.create_dir_with(name, &builder) {
        Ok(()) => sync_dir(parent)?,
        Err(e) if e.kind() == io::ErrorKind::AlreadyExists => {}
        Err(e) => return Err(e),
    }
    parent.open_dir_nofollow(name)
}
fn write_new(dir: &Dir, name: &str, bytes: &[u8]) -> io::Result<()> {
    let mut f = dir.open_with(name, &open_options(true, true))?;
    let result = f
        .write_all(bytes)
        .and_then(|_| f.sync_all())
        .and_then(|_| sync_dir(dir));
    if result.is_err() {
        drop(f);
        let _ = dir.remove_file(name);
        let _ = sync_dir(dir);
    }
    result
}
fn atomic_json<T: Serialize>(dir: &Dir, name: &str, value: &T) -> io::Result<()> {
    let bytes = serde_json::to_vec(value).map_err(|e| invalid(e.to_string()))?;
    if bytes.len() > RECORD_LIMIT {
        return Err(invalid("Recovery metadata exceeds 520 MiB."));
    }
    let temporary = format!(".pending-{}", uuid::Uuid::new_v4().simple());
    write_new(dir, &temporary, &bytes)?;
    if let Err(error) = dir.rename(&temporary, dir, name) {
        let _ = dir.remove_file(&temporary);
        return Err(error);
    }
    sync_dir(dir)
}
fn exists(dir: &Dir, name: &str) -> io::Result<bool> {
    match dir.symlink_metadata(name) {
        Ok(_) => Ok(true),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(false),
        Err(e) => Err(e),
    }
}
fn raw(snapshot: &Snapshot) -> Snapshot {
    let mut result = snapshot.clone();
    for e in &mut result.entries {
        e.id = None;
    }
    result.entries.sort_by(|a, b| a.path.cmp(&b.path));
    result
}
fn payload(entry: &Entry) -> (String, usize) {
    match &entry.data {
        Data::Text { content } => (blob::hash(content.as_bytes()), content.len()),
        Data::Binary { sha256, size } => (sha256.clone(), *size),
        Data::Folder {} => unreachable!("folders have no payload"),
    }
}
fn matches_bytes(entry: &Entry, bytes: &[u8]) -> bool {
    let (hash, size) = payload(entry);
    size == bytes.len() && blob::verify(&hash, bytes)
}
fn parent_dir(root: &Dir, path: &str) -> io::Result<(Dir, String)> {
    if !crate::allowed_path(path) {
        return Err(invalid("Invalid project destination."));
    }
    let mut parts = path.split('/').collect::<Vec<_>>();
    let name = parts.pop().unwrap().to_string();
    let mut dir = root.try_clone()?;
    for part in parts {
        dir = dir.open_dir_nofollow(part)?;
    }
    Ok((dir, name))
}
fn file_changes(before: &Snapshot, after: &Snapshot) -> (Vec<Entry>, Vec<Entry>) {
    let changed = |a: &Snapshot, b: &Snapshot| {
        let mut entries = a
            .entries
            .iter()
            .filter(|e| !matches!(e.data, Data::Folder {}))
            .filter(|e| {
                !b.entries.iter().any(|other| {
                    e.path == other.path
                        && !matches!(other.data, Data::Folder {})
                        && payload(e) == payload(other)
                })
            })
            .cloned()
            .collect::<Vec<_>>();
        entries.sort_by(|a, b| a.path.cmp(&b.path));
        entries
    };
    (changed(before, after), changed(after, before))
}

impl Session {
    /// Existing bindings only. Status/recovery callers cannot enroll a new root.
    pub fn open(root: Root, owner: Owner) -> io::Result<Self> {
        let control = root.dir.open_dir_nofollow(".scribyra-sync")?;
        if !exists(&control, "session.json")? {
            return Err(invalid(
                "Connect this folder explicitly before opening its session.",
            ));
        }
        Self::connect(root, owner)
    }
    /// Explicit local authority: the caller must have already granted this root
    /// and project/scope. No request body can choose a new ambient path.
    pub fn connect(root: Root, owner: Owner) -> io::Result<Self> {
        if !scope_valid(&owner.project_id, 256) || !scope_valid(&owner.scope, 2048) {
            return Err(invalid("Invalid folder owner scope."));
        }
        let control = private_dir(&root.dir, ".scribyra-sync")?;
        let mut options = open_options(true, false);
        options.create(true);
        let lock = control.open_with("lock", &options)?.into_std();
        if !lock.metadata()?.is_file() {
            return Err(invalid("Folder lock must be a regular file."));
        }
        lock.try_lock().map_err(|error| match error {
            std::fs::TryLockError::WouldBlock => io::Error::new(
                io::ErrorKind::WouldBlock,
                "This folder is already in use by another Scribyra session.",
            ),
            std::fs::TryLockError::Error(error) => error,
        })?;
        let state = if exists(&control, "session.json")? {
            read_json::<State>(&control, "session.json")?
        } else {
            let s = State {
                version: 1,
                owner: owner.clone(),
                baseline: Snapshot::default(),
                pending: None,
                last_confirmed: None,
            };
            atomic_json(&control, "session.json", &s)?;
            s
        };
        if state.version != 1 || state.owner != owner {
            return Err(invalid(
                "This folder is bound to another project or origin. Its data was not changed.",
            ));
        }
        if exists(&control, ".gitignore")? {
            if read_bytes(&control, ".gitignore", 16)? != b"*\n" {
                return Err(invalid(
                    "Unexpected Git ignore policy in the private sync directory.",
                ));
            }
        } else {
            write_new(&control, ".gitignore", b"*\n")?;
        }
        state.baseline.validate(true).map_err(invalid)?;
        if let Some(p) = &state.pending {
            if !blob::valid_hash(&p.id)
                || p.request.project_id != owner.project_id
                || p.request.base.digest() != state.baseline.digest()
                || p.request.disk.entries.iter().any(|e| e.id.is_some())
            {
                return Err(invalid("Invalid pending folder transaction scope."));
            }
            verify_review(&p.review, &p.request).map_err(invalid)?;
        }
        let objects = private_dir(&control, "objects")?;
        let transactions = private_dir(&control, "transactions")?;
        Ok(Self {
            root,
            control,
            objects,
            transactions,
            lock,
            state,
            needs_reopen: false,
        })
    }
    fn healthy(&self) -> io::Result<()> {
        if self.needs_reopen {
            return Err(invalid(
                "Storage acknowledgement failed. Close and reopen the folder session before continuing.",
            ));
        }
        Ok(())
    }
    pub fn state(&self) -> io::Result<&State> {
        self.healthy()?;
        Ok(&self.state)
    }
    fn save_state(&mut self, next: State) -> io::Result<()> {
        if let Err(e) = atomic_json(&self.control, "session.json", &next) {
            self.needs_reopen = true;
            return Err(e);
        }
        self.state = next;
        Ok(())
    }
    pub fn preview(&self, local: Snapshot, resolutions: Vec<Resolution>) -> io::Result<Preview> {
        self.healthy()?;
        if self.state.pending.is_some() {
            return Err(invalid(
                "Finish or abandon the pending folder transaction before reviewing new changes.",
            ));
        }
        local.validate(true).map_err(invalid)?;
        // Disk bytes at an agreed path keep the agreed type. A project-side
        // type replacement must not reclassify the still-unchanged disk version.
        let kinds = local
            .entries
            .iter()
            .chain(&self.state.baseline.entries)
            .filter(|e| !matches!(e.data, Data::Folder {}))
            .map(|e| (e.path.clone(), matches!(e.data, Data::Text { .. })))
            .collect();
        let scan = self.root.scan_kinds(&kinds)?;
        let request = Request {
            version: 1,
            project_id: self.state.owner.project_id.clone(),
            base: self.state.baseline.clone(),
            local,
            disk: scan.snapshot,
            resolutions,
        };
        let review = plan(&request).map_err(invalid)?;
        Ok(Preview { request, review })
    }
    fn object(&self, hash: &str, size: usize) -> io::Result<Vec<u8>> {
        if !blob::valid_hash(hash) || size > MAX_BYTES {
            return Err(invalid("Invalid recovery object reference."));
        }
        let bytes = read_bytes(&self.objects, hash, size)?;
        if bytes.len() != size || !blob::verify(hash, &bytes) {
            return Err(invalid("Recovery object checksum differs."));
        }
        Ok(bytes)
    }
    fn retain(&self, hash: &str, bytes: &[u8]) -> io::Result<()> {
        if !blob::verify(hash, bytes) {
            return Err(invalid("Attached recovery object checksum differs."));
        }
        if exists(&self.objects, hash)? {
            self.object(hash, bytes.len())?;
            return Ok(());
        }
        // Interrupted payload writes never occupy the content-addressed final name.
        let temp = format!(".pending-{}", uuid::Uuid::new_v4().simple());
        write_new(&self.objects, &temp, bytes)?;
        self.objects.rename(&temp, &self.objects, hash)?;
        sync_dir(&self.objects)
    }
    pub fn prepare(
        &mut self,
        preview: &Preview,
        attachments: &BTreeMap<String, Vec<u8>>,
    ) -> io::Result<Pending> {
        self.healthy()?;
        if self.state.pending.is_some() {
            return Err(invalid("A folder transaction is already pending."));
        }
        let request = &preview.request;
        if request.project_id != self.state.owner.project_id
            || request.base.digest() != self.state.baseline.digest()
            || request.disk.entries.iter().any(|e| e.id.is_some())
        {
            return Err(invalid(
                "Folder review has a different project, baseline or disk scope.",
            ));
        }
        let after = verify_review(&preview.review, request).map_err(invalid)?;
        let scan = self
            .root
            .verify(&preview.review.disk_hash, Some(&request.disk))?;
        let expected = request
            .base
            .entries
            .iter()
            .chain(&request.local.entries)
            .chain(&request.disk.entries)
            .chain(&after.entries)
            .filter(|e| matches!(e.data, Data::Binary { .. }))
            .map(payload)
            .collect::<BTreeSet<_>>();
        let mut attached = 0usize;
        for (hash, bytes) in attachments {
            attached = attached
                .checked_add(bytes.len())
                .ok_or_else(|| invalid("Attachment byte overflow."))?;
            if attached > 3 * MAX_BYTES
                || !expected.contains(&(hash.clone(), bytes.len()))
                || !blob::verify(hash, bytes)
            {
                return Err(invalid(
                    "Unexpected, excessive or invalid folder attachment.",
                ));
            }
        }
        // Retain every reviewed version, including choices that will lose.
        for entry in request
            .base
            .entries
            .iter()
            .chain(&request.local.entries)
            .chain(&request.disk.entries)
            .chain(&after.entries)
            .filter(|e| !matches!(e.data, Data::Folder {}))
        {
            let (hash, size) = payload(entry);
            match &entry.data {
                Data::Text { content } => self.retain(&hash, content.as_bytes())?,
                _ => {
                    if let Some(bytes) = attachments.get(&hash).or_else(|| scan.objects.get(&hash))
                    {
                        self.retain(&hash, bytes)?;
                    } else {
                        self.object(&hash, size)?;
                    }
                }
            }
        }
        let id = blob::hash(uuid::Uuid::new_v4().as_bytes());
        let tx = private_dir(&self.transactions, &id)?;
        let staged = private_dir(&tx, "staged")?;
        private_dir(&tx, "claimed")?;
        let (_, installs) = file_changes(&request.disk, &after);
        for (index, entry) in installs.iter().enumerate() {
            let (hash, size) = payload(entry);
            let bytes = self.object(&hash, size)?;
            write_new(&staged, &index.to_string(), &bytes)?;
        }
        let pending = Pending {
            id,
            phase: Phase::Prepared,
            request: request.clone(),
            review: preview.review.clone(),
        };
        atomic_json(&tx, "record.json", &pending)?;
        self.root
            .verify(&preview.review.disk_hash, Some(&request.disk))?;
        let summary = RecoverySummary {
            version: 1,
            id: pending.id.clone(),
            owner: self.state.owner.clone(),
            created_at: std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis() as u64,
            status: RecoveryStatus::Prepared,
            files: after
                .entries
                .iter()
                .filter(|e| !matches!(e.data, Data::Folder {}))
                .count(),
            result_hash: after.digest(),
        };
        atomic_json(&tx, "summary.json", &summary)?;
        let mut next = self.state.clone();
        next.pending = Some(pending.clone());
        self.save_state(next)?;
        Ok(pending)
    }
    fn pending(&self, id: &str) -> io::Result<Pending> {
        self.healthy()?;
        self.state
            .pending
            .as_ref()
            .filter(|p| p.id == id)
            .cloned()
            .ok_or_else(|| invalid("Pending transaction identity differs."))
    }
    fn verify_claimed(&self, pending: &Pending, result: &Snapshot) -> io::Result<()> {
        let claimed = self
            .transactions
            .open_dir_nofollow(&pending.id)?
            .open_dir_nofollow("claimed")?;
        let (removed, _) = file_changes(&pending.request.disk, result);
        for (index, entry) in removed.iter().enumerate() {
            let key = index.to_string();
            let bytes = read_bytes(&claimed, &key, MAX_BYTES)?;
            if !matches_bytes(entry, &bytes) {
                return Err(invalid(format!(
                    "A late external edit was retained in recovery for {}. Review it before confirming.",
                    entry.path
                )));
            }
        }
        Ok(())
    }
    pub fn apply(&mut self, id: &str) -> io::Result<Receipt> {
        self.apply_with(id, |_| Ok(()))
    }
    /// Callback boundaries support cancellation and progress. A stopped operation
    /// remains recoverable; reopening the same root resumes this exact journal.
    pub fn apply_with(
        &mut self,
        id: &str,
        mut checkpoint: impl FnMut(Progress) -> io::Result<()>,
    ) -> io::Result<Receipt> {
        let mut pending = self.pending(id)?;
        let after = verify_review(&pending.review, &pending.request).map_err(invalid)?;
        let expected = raw(&after);
        if pending.phase == Phase::DiskApplied {
            self.verify_claimed(&pending, &after)?;
            self.root.verify(&expected.digest(), Some(&after))?;
            return Ok(Receipt {
                id: id.into(),
                result: after,
                confirmed: false,
            });
        }
        let tx = self.transactions.open_dir_nofollow(id)?;
        let staged = tx.open_dir_nofollow("staged")?;
        let claimed = tx.open_dir_nofollow("claimed")?;
        let (removals, installs) = file_changes(&pending.request.disk, &after);
        for (index, entry) in removals.iter().enumerate() {
            let key = index.to_string();
            #[cfg(target_os = "linux")]
            if !exists(&claimed, &key)?
                && let Some((new_index, new_entry)) = installs
                    .iter()
                    .enumerate()
                    .find(|(_, new)| new.path == entry.path)
            {
                let stage_key = new_index.to_string();
                let staged_bytes = read_bytes(&staged, &stage_key, MAX_BYTES)?;
                let (parent, name) = parent_dir(&self.root.dir, &entry.path)?;
                if matches_bytes(new_entry, &staged_bytes) {
                    let before = read_bytes(&parent, &name, MAX_BYTES)?;
                    if !matches_bytes(entry, &before) {
                        return Err(invalid(format!(
                            "File changed after review: {}.",
                            entry.path
                        )));
                    }
                    // Exchange preserves whichever inode is at the target at
                    // this exact instant, including an atomic external save.
                    checkpoint(Progress {
                        operation: "file-before-exchange",
                        path: Some(entry.path.clone()),
                    })?;
                    rustix::fs::renameat_with(
                        &staged,
                        &stage_key,
                        &parent,
                        &name,
                        rustix::fs::RenameFlags::EXCHANGE,
                    )
                    .map_err(|e| io::Error::from_raw_os_error(e.raw_os_error()))?;
                    sync_dir(&parent)?;
                    sync_dir(&staged)?;
                    checkpoint(Progress {
                        operation: "file-exchanged",
                        path: Some(entry.path.clone()),
                    })?;
                }
                // A crash between exchange and claim leaves the old inode
                // at this staging name. Never exchange it a second time.
                staged.rename(&stage_key, &claimed, &key)?;
                sync_dir(&staged)?;
                sync_dir(&claimed)?;
                checkpoint(Progress {
                    operation: "file-claimed",
                    path: Some(entry.path.clone()),
                })?;
                checkpoint(Progress {
                    operation: "file-published",
                    path: Some(entry.path.clone()),
                })?;
            }
            if !exists(&claimed, &key)? {
                let (parent, name) = parent_dir(&self.root.dir, &entry.path)?;
                let bytes = read_bytes(&parent, &name, MAX_BYTES)?;
                if !matches_bytes(entry, &bytes) {
                    return Err(invalid(format!(
                        "File changed after review: {}. Retained versions remain available.",
                        entry.path
                    )));
                }
                parent.rename(&name, &claimed, &key)?;
                sync_dir(&parent)?;
                sync_dir(&claimed)?;
                checkpoint(Progress {
                    operation: "file-claimed",
                    path: Some(entry.path.clone()),
                })?;
            }
            let bytes = read_bytes(&claimed, &key, MAX_BYTES)?;
            if !matches_bytes(entry, &bytes) {
                return Err(invalid(format!(
                    "A racing edit was retained in recovery for {}. Review it before continuing.",
                    entry.path
                )));
            }
        }
        let mut old_dirs = pending
            .request
            .disk
            .entries
            .iter()
            .filter(|e| matches!(e.data, Data::Folder {}))
            .filter(|e| {
                !after
                    .entries
                    .iter()
                    .any(|a| a.path == e.path && matches!(a.data, Data::Folder {}))
            })
            .collect::<Vec<_>>();
        old_dirs.sort_by_key(|e| std::cmp::Reverse(e.path.split('/').count()));
        for entry in old_dirs {
            let (parent, name) = match parent_dir(&self.root.dir, &entry.path) {
                Ok(p) => p,
                Err(e) if e.kind() == io::ErrorKind::NotFound => continue,
                Err(e) => return Err(e),
            };
            match parent.symlink_metadata(&name) {
                Err(e) if e.kind() == io::ErrorKind::NotFound => {}
                Ok(m) if m.is_dir() => {
                    parent.remove_dir(&name)?;
                    sync_dir(&parent)?;
                    checkpoint(Progress {
                        operation: "directory-removed",
                        path: Some(entry.path.clone()),
                    })?;
                }
                Ok(m)
                    if m.is_file()
                        && after.entries.iter().any(|e| {
                            e.path == entry.path && !matches!(e.data, Data::Folder {})
                        }) => {}
                Ok(_) => {
                    return Err(invalid(
                        "A directory was replaced externally. Retained versions remain available.",
                    ));
                }
                Err(e) => return Err(e),
            }
        }
        let mut new_dirs = after
            .entries
            .iter()
            .filter(|e| matches!(e.data, Data::Folder {}))
            .collect::<Vec<_>>();
        new_dirs.sort_by_key(|e| e.path.split('/').count());
        for entry in new_dirs {
            let (parent, name) = parent_dir(&self.root.dir, &entry.path)?;
            if !exists(&parent, &name)? {
                parent.create_dir(&name)?;
                sync_dir(&parent)?;
                checkpoint(Progress {
                    operation: "directory-created",
                    path: Some(entry.path.clone()),
                })?;
            }
            parent.open_dir_nofollow(&name)?;
        }
        for (index, entry) in installs.iter().enumerate() {
            let (parent, name) = parent_dir(&self.root.dir, &entry.path)?;
            if exists(&parent, &name)? {
                let current = read_bytes(&parent, &name, MAX_BYTES)?;
                if !matches_bytes(entry, &current) {
                    return Err(invalid(format!(
                        "New external contents at {} were kept. Review them before resuming.",
                        entry.path
                    )));
                }
            } else {
                let key = index.to_string();
                let bytes = read_bytes(&staged, &key, MAX_BYTES)?;
                if !matches_bytes(entry, &bytes) {
                    return Err(invalid(
                        "Staged file checksum differs. Recovery has not been overwritten.",
                    ));
                }
                // Atomic no-clobber publication of a complete file. Never link a
                // working file to the immutable content-addressed object store.
                staged.hard_link(&key, &parent, &name)?;
                sync_dir(&parent)?;
                checkpoint(Progress {
                    operation: "file-published",
                    path: Some(entry.path.clone()),
                })?;
            }
        }
        self.verify_claimed(&pending, &after)?;
        self.root.verify(&expected.digest(), Some(&after))?;
        checkpoint(Progress {
            operation: "disk-verified",
            path: None,
        })?;
        pending.phase = Phase::DiskApplied;
        atomic_json(&tx, "record.json", &pending)?;
        self.mark_summary(id, RecoveryStatus::DiskApplied)?;
        checkpoint(Progress {
            operation: "disk-journaled",
            path: None,
        })?;
        let mut next = self.state.clone();
        next.pending = Some(pending);
        self.save_state(next)?;
        checkpoint(Progress {
            operation: "session-applied",
            path: None,
        })?;
        Ok(Receipt {
            id: id.into(),
            result: after,
            confirmed: false,
        })
    }
    /// Invoke only after the matching browser result has been applied and saved.
    pub fn confirm(&mut self, id: &str, result_hash: &str) -> io::Result<Receipt> {
        self.healthy()?;
        if self.state.pending.is_none()
            && self.state.last_confirmed.as_deref() == Some(id)
            && self.state.baseline.digest() == result_hash
        {
            return Ok(Receipt {
                id: id.into(),
                result: self.state.baseline.clone(),
                confirmed: true,
            });
        }
        let pending = self.pending(id)?;
        if pending.phase != Phase::DiskApplied {
            return Err(invalid(
                "Apply the folder transaction before confirming the browser save.",
            ));
        }
        let after = verify_review(&pending.review, &pending.request).map_err(invalid)?;
        if after.digest() != result_hash {
            return Err(invalid(
                "Browser confirmation refers to a different reviewed result.",
            ));
        }
        self.root.verify(&raw(&after).digest(), Some(&after))?;
        self.verify_claimed(&pending, &after)?;
        self.mark_summary(id, RecoveryStatus::Confirmed)?;
        let mut next = self.state.clone();
        next.baseline = after.clone();
        next.pending = None;
        next.last_confirmed = Some(id.into());
        self.save_state(next)?;
        Ok(Receipt {
            id: id.into(),
            result: after,
            confirmed: true,
        })
    }
    /// Explicitly stop following a journal, retaining its records, object copies
    /// and claimed files. Current disk bytes and the agreed baseline stay put.
    pub fn abandon(&mut self, id: &str) -> io::Result<()> {
        let pending = self.pending(id)?;
        let tx = self.transactions.open_dir_nofollow(id)?;
        atomic_json(&tx, "abandoned.json", &pending)?;
        self.mark_summary(id, RecoveryStatus::Abandoned)?;
        let mut next = self.state.clone();
        next.pending = None;
        self.save_state(next)
    }
    pub fn retained_object(&self, hash: &str, size: usize) -> io::Result<Vec<u8>> {
        self.healthy()?;
        self.object(hash, size)
    }
    fn mark_summary(&self, id: &str, status: RecoveryStatus) -> io::Result<()> {
        let tx = self.transactions.open_dir_nofollow(id)?;
        let mut summary: RecoverySummary =
            serde_json::from_slice(&read_bytes(&tx, "summary.json", 8192)?)
                .map_err(|e| invalid(e.to_string()))?;
        if summary.id != id || summary.owner != self.state.owner {
            return Err(invalid("Recovery summary scope differs."));
        }
        summary.status = status;
        atomic_json(&tx, "summary.json", &summary)
    }
    pub fn recoveries(&self) -> io::Result<Vec<RecoverySummary>> {
        self.healthy()?;
        let mut summaries = Vec::new();
        for entry in self.transactions.entries()? {
            let entry = entry?;
            let Some(id) = entry.file_name().to_str().map(str::to_string) else {
                continue;
            };
            if !blob::valid_hash(&id) {
                continue;
            }
            if summaries.len() >= 10_000 {
                return Err(invalid(
                    "Recovery inventory exceeds 10,000 transactions; export and archive older records.",
                ));
            }
            let tx = self.transactions.open_dir_nofollow(&id)?;
            if !exists(&tx, "summary.json")? {
                continue;
            }
            let mut summary: RecoverySummary =
                serde_json::from_slice(&read_bytes(&tx, "summary.json", 8192)?)
                    .map_err(|e| invalid(e.to_string()))?;
            if summary.version != 1
                || summary.id != id
                || summary.owner != self.state.owner
                || !blob::valid_hash(&summary.result_hash)
                || summary.files > 512
            {
                return Err(invalid("Invalid recovery summary scope or bounds."));
            }
            if let Some(pending) = self.state.pending.as_ref().filter(|p| p.id == id) {
                summary.status = if pending.phase == Phase::Prepared {
                    RecoveryStatus::Prepared
                } else {
                    RecoveryStatus::DiskApplied
                };
            }
            summaries.push(summary);
        }
        summaries.sort_by(|a, b| {
            b.created_at
                .cmp(&a.created_at)
                .then_with(|| a.id.cmp(&b.id))
        });
        Ok(summaries)
    }
    /// Export complete reviewed versions. Claimed includes a late external edit
    /// captured by the atomic rename, rather than assuming it still equals disk.
    pub fn recovery(&self, id: &str, version: RecoveryVersion) -> io::Result<crate::Scan> {
        self.healthy()?;
        if !blob::valid_hash(id) {
            return Err(invalid("Invalid recovery identity."));
        }
        let tx = self.transactions.open_dir_nofollow(id)?;
        let pending: Pending = read_json(&tx, "record.json")?;
        if pending.id != id || pending.request.project_id != self.state.owner.project_id {
            return Err(invalid("Recovery scope differs."));
        }
        let result = verify_review(&pending.review, &pending.request).map_err(invalid)?;
        let mut snapshot = match version {
            RecoveryVersion::Base => pending.request.base.clone(),
            RecoveryVersion::Local => pending.request.local.clone(),
            RecoveryVersion::Disk | RecoveryVersion::Claimed => pending.request.disk.clone(),
            RecoveryVersion::Result => result.clone(),
        };
        let mut objects = BTreeMap::new();
        if matches!(version, RecoveryVersion::Claimed) {
            let claimed = tx.open_dir_nofollow("claimed")?;
            let (removed, _) = file_changes(&pending.request.disk, &result);
            for (index, entry) in removed.iter().enumerate() {
                let key = index.to_string();
                let claimed_bytes = if exists(&claimed, &key)? {
                    Some(read_bytes(&claimed, &key, MAX_BYTES)?)
                } else {
                    #[cfg(target_os = "linux")]
                    {
                        let (_, installs) = file_changes(&pending.request.disk, &result);
                        if let Some((stage_index, new_entry)) = installs
                            .iter()
                            .enumerate()
                            .find(|(_, e)| e.path == entry.path)
                        {
                            let staged = tx.open_dir_nofollow("staged")?;
                            let bytes = read_bytes(&staged, &stage_index.to_string(), MAX_BYTES)?;
                            if !matches_bytes(new_entry, &bytes) {
                                Some(bytes)
                            } else {
                                None
                            }
                        } else {
                            None
                        }
                    }
                    #[cfg(not(target_os = "linux"))]
                    {
                        None
                    }
                };
                if let Some(bytes) = claimed_bytes {
                    let data = if matches!(entry.data, Data::Text { .. })
                        && std::str::from_utf8(&bytes).is_ok()
                    {
                        Data::Text {
                            content: String::from_utf8(bytes).unwrap(),
                        }
                    } else {
                        let hash = blob::hash(&bytes);
                        let size = bytes.len();
                        objects.insert(hash.clone(), bytes);
                        Data::Binary { sha256: hash, size }
                    };
                    snapshot
                        .entries
                        .iter_mut()
                        .find(|e| e.path == entry.path)
                        .unwrap()
                        .data = data;
                }
            }
        }
        snapshot
            .validate(!matches!(
                version,
                RecoveryVersion::Disk | RecoveryVersion::Claimed
            ))
            .map_err(invalid)?;
        for e in &snapshot.entries {
            if let Data::Binary { sha256, size } = &e.data
                && !objects.contains_key(sha256)
            {
                objects.insert(sha256.clone(), self.object(sha256, *size)?);
            }
        }
        Ok(crate::Scan { snapshot, objects })
    }
}
