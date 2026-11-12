//! Three-way folder/project reconciliation. Pure policy shared by native and WASM;
//! plans do not read files, mutate a document, or authorize filesystem access.
use crate::blob;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};
use unicode_normalization::UnicodeNormalization;
pub const MAX_BYTES: usize = 64 * 1024 * 1024;
pub const MAX_ENTRIES: usize = 1024;
pub const MAX_MERGE_BYTES: usize = 256 * 1024;
pub const MAX_MERGE_LINES: usize = 4000;
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "lowercase", deny_unknown_fields)]
pub enum Data {
    Folder {},
    Text { content: String },
    Binary { sha256: String, size: usize },
}
impl Data {
    pub fn size(&self) -> usize {
        match self {
            Self::Folder {} => 0,
            Self::Text { content } => content.len(),
            Self::Binary { size, .. } => *size,
        }
    }
    pub fn digest(&self) -> String {
        match self {
            Self::Folder {} => "folder".into(),
            Self::Text { content } => format!("text:{}", blob::hash(content.as_bytes())),
            Self::Binary { sha256, size } => format!("binary:{sha256}:{size}"),
        }
    }
    fn folder(&self) -> bool {
        matches!(self, Self::Folder {})
    }
}
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Entry {
    pub id: Option<String>,
    pub path: String,
    pub data: Data,
}
#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Snapshot {
    pub entries: Vec<Entry>,
}
fn id_valid(id: &str) -> bool {
    !id.is_empty() && id.len() <= 256 && !id.chars().any(char::is_control)
}
fn path_key(path: &str) -> String {
    path.nfc().flat_map(char::to_lowercase).collect()
}
pub fn allowed_path(path: &str) -> bool {
    crate::valid_path(path)
        && !path.contains(['<', '>', '"', '|', '?', '*'])
        && !path.split('/').any(|part| {
            let lower = part.to_ascii_lowercase();
            let stem = lower
                .split('.')
                .next()
                .unwrap()
                .trim_end_matches([' ', '.']);
            let device = matches!(stem, "con" | "prn" | "aux" | "nul" | "conin$" | "conout$")
                || ["com", "lpt"].iter().any(|prefix| {
                    stem.strip_prefix(prefix).is_some_and(|suffix| {
                        matches!(
                            suffix,
                            "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" | "¹" | "²" | "³"
                        )
                    })
                });
            part.ends_with([' ', '.'])
                || device
                || lower == ".git"
                || lower == ".scribyra-sync"
                || lower.starts_with(".scribyra-sync-")
        })
}
/// Native sync/recovery state is never source content. Browser directory and ZIP
/// adapters share this namespace check without adopting OS path restrictions.
pub fn private_state_path(path: &str) -> bool {
    path.split('/').any(|part| {
        let lower = part.to_ascii_lowercase();
        lower == ".scribyra-sync" || lower.starts_with(".scribyra-sync-")
    })
}
impl Snapshot {
    pub fn validate(&self, require_ids: bool) -> Result<(), String> {
        if self.entries.len() > MAX_ENTRIES {
            return Err("A folder snapshot exceeds 1,024 entries.".into());
        }
        let (mut paths, mut ids) = (BTreeMap::new(), BTreeSet::new());
        let (mut bytes, mut files) = (0usize, 0usize);
        for entry in &self.entries {
            if !allowed_path(&entry.path) || paths.insert(path_key(&entry.path), entry).is_some() {
                return Err("Folder paths are invalid, reserved, or collide under Unicode/case normalization.".into());
            }
            if require_ids && entry.id.is_none() {
                return Err("Agreed and project snapshots require stable entry IDs.".into());
            }
            if let Some(id) = &entry.id {
                if !id_valid(id) || !ids.insert(id) {
                    return Err("Duplicate or invalid folder entry IDs.".into());
                }
            }
            if let Data::Binary { sha256, size } = &entry.data {
                if !blob::valid_hash(sha256) || *size > MAX_BYTES {
                    return Err("Invalid binary checksum or size.".into());
                }
            }
            bytes = bytes
                .checked_add(entry.data.size())
                .ok_or("Folder size overflow.")?;
            files += usize::from(!entry.data.folder());
        }
        if bytes > MAX_BYTES || files > 512 {
            return Err("A folder snapshot exceeds 512 files or 64 MiB.".into());
        }
        for entry in &self.entries {
            if let Some((parent, _)) = entry.path.rsplit_once('/') {
                if !paths
                    .get(&path_key(parent))
                    .is_some_and(|p| p.path == parent && p.data.folder())
                {
                    return Err(
                        "Every parent directory must be present with its exact spelling.".into(),
                    );
                }
            }
        }
        Ok(())
    }
    pub fn digest(&self) -> String {
        let mut entries = self.entries.clone();
        entries.sort_by(|a, b| a.path.cmp(&b.path));
        blob::hash(&serde_json::to_vec(&entries).expect("snapshot serialization"))
    }
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(
    tag = "choice",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum Choice {
    Local,
    Disk,
    Base,
    Delete,
    Custom {
        entry: Entry,
    },
    Both {
        local_path: String,
        disk_path: String,
    },
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Resolution {
    pub id: String,
    pub decision: Choice,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Request {
    pub version: u8,
    pub project_id: String,
    pub base: Snapshot,
    pub local: Snapshot,
    pub disk: Snapshot,
    #[serde(default)]
    pub resolutions: Vec<Resolution>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Conflict {
    pub id: String,
    pub kind: String,
    pub message: String,
    pub base: Option<Entry>,
    pub local: Option<Entry>,
    pub disk: Option<Entry>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Identity {
    pub id: String,
    pub before: Option<String>,
    pub after: String,
    pub evidence: String,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Plan {
    pub version: u8,
    pub input_hash: String,
    pub base_hash: String,
    pub local_hash: String,
    pub disk_hash: String,
    pub identities: Vec<Identity>,
    pub conflicts: Vec<Conflict>,
    pub result: Option<Snapshot>,
}
fn parent(path: &str) -> Option<&str> {
    path.rsplit_once('/').map(|(p, _)| p)
}
fn descriptors(snapshot: &Snapshot) -> Vec<String> {
    // Hash source contents once, rather than again for each ancestor folder.
    let digests = snapshot
        .entries
        .iter()
        .map(|e| e.data.digest())
        .collect::<Vec<_>>();
    snapshot
        .entries
        .iter()
        .enumerate()
        .map(|(index, entry)| {
            if !entry.data.folder() {
                return digests[index].clone();
            }
            let prefix = entry.path.clone() + "/";
            let mut children = snapshot
                .entries
                .iter()
                .zip(&digests)
                .filter_map(|(e, digest)| {
                    e.path.strip_prefix(&prefix).map(|suffix| (suffix, digest))
                })
                .collect::<Vec<_>>();
            children.sort();
            format!(
                "folder:{}",
                blob::hash(&serde_json::to_vec(&children).expect("folder signature"))
            )
        })
        .collect()
}
fn match_disk(request: &Request) -> Result<(Snapshot, Vec<Identity>), String> {
    let base = &request.base.entries;
    let mut disk = request.disk.clone();
    let mut assigned = BTreeSet::new();
    let mut identities = Vec::new();
    let base_ids = base
        .iter()
        .map(|e| (e.id.as_deref().unwrap(), e))
        .collect::<BTreeMap<_, _>>();
    let local_ids = request
        .local
        .entries
        .iter()
        .map(|e| (e.id.as_deref().unwrap(), e))
        .collect::<BTreeMap<_, _>>();
    for entry in &disk.entries {
        if let Some(id) = &entry.id {
            if !base_ids.contains_key(id.as_str()) && !local_ids.contains_key(id.as_str()) {
                return Err(
                    "Disk-supplied IDs must belong to the agreed or project snapshot.".into(),
                );
            }
            assigned.insert(id.clone());
        }
    }
    let base_desc = base
        .iter()
        .zip(descriptors(&request.base))
        .map(|(e, signature)| (e.id.as_ref().unwrap().clone(), signature))
        .collect::<BTreeMap<_, _>>();
    let disk_desc = descriptors(&request.disk);
    let assign = |disk: &mut Snapshot,
                  index: usize,
                  entry: &Entry,
                  evidence: &str,
                  assigned: &mut BTreeSet<String>,
                  identities: &mut Vec<Identity>| {
        let id = entry.id.as_ref().unwrap().clone();
        assigned.insert(id.clone());
        disk.entries[index].id = Some(id.clone());
        if disk.entries[index].path != entry.path {
            identities.push(Identity {
                id,
                before: Some(entry.path.clone()),
                after: disk.entries[index].path.clone(),
                evidence: evidence.into(),
            });
        }
    };
    // Exact unchanged entries anchor duplicate-content files before rename inference.
    for (index, signature) in disk_desc.iter().enumerate() {
        if disk.entries[index].id.is_none() {
            if let Some(entry) = base.iter().find(|b| {
                !assigned.contains(b.id.as_ref().unwrap())
                    && b.path == disk.entries[index].path
                    && base_desc[b.id.as_ref().unwrap()] == *signature
            }) {
                assign(
                    &mut disk,
                    index,
                    entry,
                    "unchanged-path",
                    &mut assigned,
                    &mut identities,
                );
            }
        }
    }
    loop {
        let mut progress = false;
        let mut bg: BTreeMap<&str, Vec<&Entry>> = BTreeMap::new();
        let mut dg: BTreeMap<&str, Vec<usize>> = BTreeMap::new();
        for entry in base {
            if !assigned.contains(entry.id.as_ref().unwrap()) {
                bg.entry(&base_desc[entry.id.as_ref().unwrap()])
                    .or_default()
                    .push(entry);
            }
        }
        for (i, entry) in disk.entries.iter().enumerate() {
            if entry.id.is_none() {
                dg.entry(&disk_desc[i]).or_default().push(i);
            }
        }
        for (signature, entries) in bg {
            if entries.len() == 1 {
                if let Some(indexes) = dg.get(signature) {
                    if indexes.len() == 1 {
                        assign(
                            &mut disk,
                            indexes[0],
                            entries[0],
                            "unique-content",
                            &mut assigned,
                            &mut identities,
                        );
                        progress = true;
                    }
                }
            }
        }
        // Consistent matched child identities can establish a renamed parent folder.
        let mut folders: BTreeMap<String, BTreeSet<String>> = BTreeMap::new();
        for entry in &disk.entries {
            if let Some(old) = entry.id.as_deref().and_then(|id| base_ids.get(id)) {
                if let (Some(before), Some(after)) = (parent(&old.path), parent(&entry.path)) {
                    if let Some(folder) = base.iter().find(|e| e.path == before && e.data.folder())
                    {
                        if !assigned.contains(folder.id.as_ref().unwrap()) {
                            folders
                                .entry(folder.id.as_ref().unwrap().clone())
                                .or_default()
                                .insert(after.into());
                        }
                    }
                }
            }
        }
        let mut used_targets = BTreeMap::<String, usize>::new();
        for values in folders.values() {
            for path in values {
                *used_targets.entry(path.clone()).or_default() += 1;
            }
        }
        for (id, paths) in folders {
            if paths.len() == 1 {
                let path = paths.iter().next().unwrap();
                if used_targets[path] == 1 {
                    if let Some(index) = disk
                        .entries
                        .iter()
                        .position(|e| e.id.is_none() && e.path == *path && e.data.folder())
                    {
                        assign(
                            &mut disk,
                            index,
                            base_ids[id.as_str()],
                            "matched-descendants",
                            &mut assigned,
                            &mut identities,
                        );
                        progress = true;
                    }
                }
            }
        }
        if !progress {
            for i in 0..disk.entries.len() {
                if disk.entries[i].id.is_none() {
                    if let Some(entry) = base.iter().find(|b| {
                        !assigned.contains(b.id.as_ref().unwrap())
                            && b.path == disk.entries[i].path
                            && b.data.folder() == disk.entries[i].data.folder()
                    }) {
                        assign(
                            &mut disk,
                            i,
                            entry,
                            "existing-path",
                            &mut assigned,
                            &mut identities,
                        );
                        progress = true;
                    }
                }
            }
        }
        if !progress {
            break;
        }
    }
    for entry in &mut disk.entries {
        if entry.id.is_none() {
            if let Some(local) = request.local.entries.iter().find(|l| {
                !assigned.contains(l.id.as_ref().unwrap())
                    && l.path == entry.path
                    && !base_ids.contains_key(l.id.as_deref().unwrap())
            }) {
                entry.id = local.id.clone();
                assigned.insert(local.id.as_ref().unwrap().clone());
            } else {
                let mut salt = 0;
                loop {
                    let id = format!(
                        "folder-{}",
                        blob::hash(
                            format!("{}\0{}\0{salt}", request.project_id, entry.path).as_bytes()
                        )
                    );
                    if !assigned.contains(&id)
                        && !base_ids.contains_key(id.as_str())
                        && !local_ids.contains_key(id.as_str())
                    {
                        assigned.insert(id.clone());
                        entry.id = Some(id);
                        break;
                    }
                    salt += 1;
                }
            }
        }
    }
    disk.validate(true)?;
    identities.sort_by(|a, b| a.id.cmp(&b.id));
    Ok((disk, identities))
}
#[derive(Clone, Debug, PartialEq, Eq)]
struct Node {
    id: String,
    name: String,
    parent: Option<String>,
    data: Data,
}
fn graph(snapshot: &Snapshot) -> BTreeMap<String, Node> {
    let paths = snapshot
        .entries
        .iter()
        .map(|e| (e.path.as_str(), e.id.as_ref().unwrap()))
        .collect::<BTreeMap<_, _>>();
    snapshot
        .entries
        .iter()
        .map(|e| {
            let id = e.id.as_ref().unwrap().clone();
            (
                id.clone(),
                Node {
                    id,
                    name: e.path.rsplit('/').next().unwrap().into(),
                    parent: parent(&e.path).map(|p| paths[p].clone()),
                    data: e.data.clone(),
                },
            )
        })
        .collect()
}
fn field<T: Clone + PartialEq>(base: &T, local: &T, disk: &T) -> Option<T> {
    if local == disk || disk == base {
        Some(local.clone())
    } else if local == base {
        Some(disk.clone())
    } else {
        None
    }
}
fn merge_node(
    base: Option<&Node>,
    local: Option<&Node>,
    disk: Option<&Node>,
) -> Result<Option<Node>, (&'static str, &'static str)> {
    if local == disk {
        return Ok(local.cloned());
    }
    if local == base {
        return Ok(disk.cloned());
    }
    if disk == base {
        return Ok(local.cloned());
    }
    let (Some(base), Some(local), Some(disk)) = (base, local, disk) else {
        return Err((
            "delete-or-create",
            "Both sides changed a file's existence. Review the versions before applying.",
        ));
    };
    let name = field(&base.name, &local.name, &disk.name)
        .ok_or(("rename", "Both sides renamed this entry differently."))?;
    let parent = field(&base.parent, &local.parent, &disk.parent)
        .ok_or(("move", "Both sides moved this entry to different folders."))?;
    let data = if let Some(data) = field(&base.data, &local.data, &disk.data) {
        data
    } else {
        match (&base.data, &local.data, &disk.data) {
            (Data::Text { content: b }, Data::Text { content: l }, Data::Text { content: d }) => {
                if [b, l, d].iter().any(|text| {
                    text.len() > MAX_MERGE_BYTES || text.lines().count() > MAX_MERGE_LINES
                }) {
                    return Err((
                        "large-text",
                        "Concurrent text exceeds the automatic merge bound; review a manual result.",
                    ));
                }
                Data::Text {
                    content: diffy::merge(b, l, d).map_err(|_| {
                        (
                            "text",
                            "Both sides changed overlapping text. Choose or edit a result.",
                        )
                    })?,
                }
            }
            _ => {
                return Err((
                    "content",
                    "Both sides changed this file's type or binary contents.",
                ));
            }
        }
    };
    Ok(Some(Node {
        id: local.id.clone(),
        name,
        parent,
        data,
    }))
}
struct StructureError {
    ids: Vec<String>,
    message: String,
}
fn structure(ids: Vec<String>, message: impl Into<String>) -> StructureError {
    StructureError {
        ids,
        message: message.into(),
    }
}
fn materialize(nodes: &BTreeMap<String, Node>) -> Result<Snapshot, StructureError> {
    let mut entries = Vec::new();
    let mut paths = BTreeMap::<String, String>::new();
    for node in nodes.values() {
        let mut parts = vec![node.name.clone()];
        let mut seen = BTreeSet::from([node.id.as_str()]);
        let mut ancestor = node.parent.as_deref();
        while let Some(id) = ancestor {
            if !seen.insert(id) {
                return Err(structure(
                    seen.iter().map(|id| id.to_string()).collect(),
                    "Concurrent moves form a folder cycle. Choose a consistent parent before applying.",
                ));
            }
            let p = nodes.get(id).ok_or_else(|| {
                structure(
                    vec![node.id.clone(), id.into()],
                    "A merged entry has a deleted parent. Review the folder deletion.",
                )
            })?;
            if !p.data.folder() {
                return Err(structure(
                    vec![node.id.clone(), id.into()],
                    "A merged parent is no longer a directory.",
                ));
            }
            parts.push(p.name.clone());
            ancestor = p.parent.as_deref();
        }
        parts.reverse();
        let path = parts.join("/");
        if !allowed_path(&path) {
            return Err(structure(
                vec![node.id.clone()],
                "A merged path is invalid, reserved or too long.",
            ));
        }
        if let Some(other) = paths.insert(path_key(&path), node.id.clone()) {
            return Err(structure(
                vec![node.id.clone(), other],
                "Merged paths collide under Unicode/case normalization. Review their names.",
            ));
        }
        entries.push(Entry {
            id: Some(node.id.clone()),
            path,
            data: node.data.clone(),
        });
    }
    entries.sort_by(|a, b| a.path.cmp(&b.path));
    let snapshot = Snapshot { entries };
    snapshot
        .validate(true)
        .map_err(|message| structure(nodes.keys().cloned().collect(), message))?;
    Ok(snapshot)
}
pub fn plan(request: &Request) -> Result<Plan, String> {
    if request.version != 1 || !id_valid(&request.project_id) {
        return Err("Unsupported folder protocol or invalid project identity.".into());
    }
    request.base.validate(true)?;
    request.local.validate(true)?;
    request.disk.validate(false)?;
    if request.resolutions.len() > MAX_ENTRIES {
        return Err("Too many folder resolutions.".into());
    }
    let (base_hash, local_hash, disk_hash) = (
        request.base.digest(),
        request.local.digest(),
        request.disk.digest(),
    );
    let mut decisions = request.resolutions.iter().collect::<Vec<_>>();
    decisions.sort_by(|a, b| a.id.cmp(&b.id));
    let input_hash = blob::hash(
        &serde_json::to_vec(&(
            request.version,
            &request.project_id,
            &base_hash,
            &local_hash,
            &disk_hash,
            decisions,
        ))
        .map_err(|_| "Cannot encode folder request.")?,
    );
    let (disk, identities) = match_disk(request)?;
    let (base, local, remote) = (graph(&request.base), graph(&request.local), graph(&disk));
    let ids = base
        .keys()
        .chain(local.keys())
        .chain(remote.keys())
        .cloned()
        .collect::<BTreeSet<_>>();
    let mut nodes = BTreeMap::new();
    let mut conflicts = Vec::new();
    let mut resolutions = BTreeMap::new();
    for resolution in &request.resolutions {
        if !ids.contains(&resolution.id)
            || resolutions
                .insert(resolution.id.clone(), &resolution.decision)
                .is_some()
        {
            return Err("Duplicate resolution or unknown entry identity.".into());
        }
    }
    let entry_for = |snapshot: &Snapshot, id: &str| {
        snapshot
            .entries
            .iter()
            .find(|e| e.id.as_deref() == Some(id))
            .cloned()
    };
    for id in &ids {
        let choose = resolutions.get(id);
        let result = if let Some(choice) = choose {
            match choice {
                Choice::Local => Ok(local.get(id).cloned()),
                Choice::Disk => Ok(remote.get(id).cloned()),
                Choice::Base => Ok(base.get(id).cloned()),
                Choice::Delete => Ok(None),
                Choice::Custom { entry } => {
                    if entry.id.as_deref() != Some(id) {
                        return Err("Custom resolution must preserve its entry identity.".into());
                    }
                    let mut snapshot = request.local.clone();
                    snapshot.entries.retain(|e| e.id.as_ref() != Some(id));
                    snapshot.entries.push(entry.clone());
                    snapshot.validate(true)?;
                    Ok(graph(&snapshot).get(id).cloned())
                }
                Choice::Both {
                    local_path,
                    disk_path,
                } => {
                    let (Some(l), Some(d)) = (entry_for(&request.local, id), entry_for(&disk, id))
                    else {
                        return Err("Keep both requires two existing file versions.".into());
                    };
                    if l.data.folder() || d.data.folder() {
                        return Err(
                            "Review directory moves individually before keeping both.".into()
                        );
                    }
                    let mut both = Snapshot {
                        entries: vec![
                            Entry {
                                id: Some(id.clone()),
                                path: local_path.clone(),
                                data: l.data,
                            },
                            Entry {
                                id: Some(format!(
                                    "copy-{}",
                                    blob::hash(
                                        format!("{}\0{id}\0{input_hash}", request.project_id)
                                            .as_bytes()
                                    )
                                )),
                                path: disk_path.clone(),
                                data: d.data,
                            },
                        ],
                    };
                    // Destination parents must already exist in the project. They retain stable IDs.
                    both.entries.extend(
                        request
                            .local
                            .entries
                            .iter()
                            .filter(|e| e.data.folder())
                            .cloned(),
                    );
                    both.validate(true)?;
                    for (key, node) in graph(&both) {
                        if !node.data.folder() {
                            if nodes.insert(key, node).is_some() {
                                return Err(
                                    "A keep-both identity collides with another entry.".into()
                                );
                            }
                        }
                    }
                    continue;
                }
            }
        } else {
            merge_node(base.get(id), local.get(id), remote.get(id))
        };
        match result {
            Ok(Some(node)) => {
                if nodes.insert(id.clone(), node).is_some() {
                    return Err("Resolution identities collide.".into());
                }
            }
            Ok(None) => {}
            Err((kind, message)) => conflicts.push(Conflict {
                id: id.clone(),
                kind: kind.into(),
                message: message.into(),
                base: entry_for(&request.base, id),
                local: entry_for(&request.local, id),
                disk: entry_for(&disk, id),
            }),
        }
    }
    let result = if conflicts.is_empty() {
        match materialize(&nodes) {
            Ok(snapshot) => Some(snapshot),
            Err(issue) => {
                for id in issue.ids {
                    conflicts.push(Conflict {
                        id: id.clone(),
                        kind: "structure".into(),
                        message: issue.message.clone(),
                        base: entry_for(&request.base, &id),
                        local: entry_for(&request.local, &id),
                        disk: entry_for(&disk, &id),
                    });
                }
                None
            }
        }
    } else {
        None
    };
    Ok(Plan {
        version: 1,
        input_hash,
        base_hash,
        local_hash,
        disk_hash,
        identities,
        conflicts,
        result,
    })
}
pub fn parse_request(input: &str) -> Result<Request, String> {
    if input.len() > 3 * MAX_BYTES + 1024 * 1024 {
        return Err("Folder request exceeds its bound.".into());
    }
    serde_json::from_str(input).map_err(|e| format!("Invalid folder request: {e}"))
}
pub fn parse_plan(input: &str) -> Result<Plan, String> {
    plan(&parse_request(input)?)
}

/// Apply adapters must recompute the reviewed result against current inputs.
/// Comparing only a caller-provided hash would not detect a forged result.
pub fn verify_review(review: &Plan, current: &Request) -> Result<Snapshot, String> {
    let recomputed = plan(current)?;
    if serde_json::to_vec(review).map_err(|_| "Invalid reviewed plan.")?
        != serde_json::to_vec(&recomputed).map_err(|_| "Invalid current plan.")?
    {
        return Err(
            "Folder/project inputs or reviewed decisions changed. Scan and review again.".into(),
        );
    }
    recomputed
        .result
        .ok_or_else(|| "Resolve every folder conflict before applying.".into())
}
