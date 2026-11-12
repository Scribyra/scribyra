//! Native folder capabilities, bounded snapshots and recoverable transactions.
pub mod transaction;
use cap_fs_ext::{DirExt, FollowSymlinks, OpenOptionsFollowExt};
use cap_std::{
    ambient_authority,
    fs::{Dir, OpenOptions},
};
use scribyra_core::blob;
pub use scribyra_core::reconciliation::*;
use std::{
    collections::BTreeMap,
    io::{self, Read},
    path::Path,
};
#[derive(Debug)]
pub struct Scan {
    pub snapshot: Snapshot,
    /// Immutable binary payloads are separate from the JSON planning contract.
    pub objects: BTreeMap<String, Vec<u8>>,
}
impl Scan {
    pub fn revision(&self) -> String {
        self.snapshot.digest()
    }
}
pub struct Root {
    dir: Dir,
}
fn invalid(message: impl Into<String>) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, message.into())
}
pub fn text_path(path: &str) -> bool {
    matches!(
        path.rsplit('.')
            .next()
            .unwrap_or("")
            .to_ascii_lowercase()
            .as_str(),
        "tex"
            | "bib"
            | "sty"
            | "cls"
            | "txt"
            | "md"
            | "csv"
            | "bst"
            | "cfg"
            | "def"
            | "json"
            | "yaml"
            | "yml"
            | "toml"
    )
}
fn control(name: &str) -> bool {
    name.eq_ignore_ascii_case(".git") || scribyra_core::reconciliation::private_state_path(name)
}
impl Root {
    /// Ambient authority is used only for this explicitly selected root. Every
    /// subsequent operation is relative to its open directory capability.
    pub fn open(path: impl AsRef<Path>) -> io::Result<Self> {
        Ok(Self {
            dir: Dir::open_ambient_dir(path, ambient_authority())?,
        })
    }
    fn once(&self, kinds: &BTreeMap<String, bool>) -> io::Result<Scan> {
        let mut scan = Scan {
            snapshot: Snapshot::default(),
            objects: BTreeMap::new(),
        };
        let mut total = 0;
        fn visit(
            dir: &Dir,
            prefix: &str,
            kinds: &BTreeMap<String, bool>,
            scan: &mut Scan,
            total: &mut usize,
        ) -> io::Result<()> {
            let mut children = dir
                .entries()?
                .take(MAX_ENTRIES + 1)
                .collect::<io::Result<Vec<_>>>()?;
            if children.len() > MAX_ENTRIES {
                return Err(invalid("Directory exceeds 1,024 entries."));
            }
            children.sort_by_key(|e| e.file_name());
            for child in children {
                let name = child
                    .file_name()
                    .into_string()
                    .map_err(|_| invalid("Folder filenames must be UTF-8."))?;
                if control(&name) {
                    continue;
                }
                let path = if prefix.is_empty() {
                    name.clone()
                } else {
                    format!("{prefix}/{name}")
                };
                if !allowed_path(&path) {
                    return Err(invalid(format!(
                        "Invalid or nonportable project path: {path}"
                    )));
                }
                if scan.snapshot.entries.len() >= MAX_ENTRIES {
                    return Err(invalid("Folder exceeds 1,024 entries."));
                }
                let metadata = dir.symlink_metadata(&name)?;
                if metadata.file_type().is_symlink() {
                    return Err(invalid(format!("Symlinks are not synchronized: {path}")));
                }
                if metadata.is_dir() {
                    let nested = dir.open_dir_nofollow(&name)?;
                    scan.snapshot.entries.push(Entry {
                        id: None,
                        path: path.clone(),
                        data: Data::Folder {},
                    });
                    visit(&nested, &path, kinds, scan, total)?;
                } else if metadata.is_file() {
                    if scan
                        .snapshot
                        .entries
                        .iter()
                        .filter(|e| !matches!(e.data, Data::Folder {}))
                        .count()
                        >= 512
                    {
                        return Err(invalid("Folder exceeds 512 files."));
                    }
                    let remaining = MAX_BYTES.saturating_sub(*total);
                    if metadata.len() > remaining as u64 {
                        return Err(invalid("Folder exceeds 64 MiB."));
                    }
                    let mut options = OpenOptions::new();
                    options.read(true).follow(FollowSymlinks::No);
                    #[cfg(unix)]
                    {
                        use cap_std::fs::OpenOptionsExt;
                        options.custom_flags(rustix::fs::OFlags::NONBLOCK.bits() as i32);
                    }
                    let mut file = dir.open_with(&name, &options)?;
                    let before = file.metadata()?;
                    if !before.is_file() {
                        return Err(invalid(format!("Non-regular file is unsupported: {path}")));
                    }
                    let mut bytes = Vec::new();
                    Read::by_ref(&mut file)
                        .take(remaining as u64 + 1)
                        .read_to_end(&mut bytes)?;
                    let after = file.metadata()?;
                    if bytes.len() > remaining {
                        return Err(invalid("Folder grew beyond 64 MiB while being read."));
                    }
                    if before.len() != after.len()
                        || before.modified()? != after.modified()?
                        || bytes.len() as u64 != after.len()
                    {
                        return Err(invalid("A file changed while being read. Scan again."));
                    }
                    *total += bytes.len();
                    let is_text = kinds
                        .get(&path)
                        .copied()
                        .unwrap_or_else(|| text_path(&path));
                    let data = if is_text {
                        Data::Text {
                            content: String::from_utf8(bytes)
                                .map_err(|_| invalid(format!("Text file is not UTF-8: {path}")))?,
                        }
                    } else {
                        let sha256 = blob::hash(&bytes);
                        let size = bytes.len();
                        scan.objects.entry(sha256.clone()).or_insert(bytes);
                        Data::Binary { sha256, size }
                    };
                    scan.snapshot.entries.push(Entry {
                        id: None,
                        path,
                        data,
                    });
                } else {
                    return Err(invalid(format!("Non-regular entry is unsupported: {path}")));
                }
            }
            Ok(())
        }
        visit(&self.dir, "", kinds, &mut scan, &mut total)?;
        scan.snapshot.entries.sort_by(|a, b| a.path.cmp(&b.path));
        scan.snapshot.validate(false).map_err(invalid)?;
        Ok(scan)
    }
    /// Two matching observations catch ordinary save/rename activity during a
    /// scan. This is an optimistic snapshot, not a filesystem-wide lock.
    pub fn scan(&self, known: Option<&Snapshot>) -> io::Result<Scan> {
        if let Some(known) = known {
            known.validate(false).map_err(invalid)?;
        }
        let kinds = known
            .map(|s| {
                s.entries
                    .iter()
                    .map(|e| (e.path.clone(), matches!(e.data, Data::Text { .. })))
                    .collect()
            })
            .unwrap_or_default();
        self.scan_kinds(&kinds)
    }
    fn scan_kinds(&self, kinds: &BTreeMap<String, bool>) -> io::Result<Scan> {
        let first = self.once(kinds)?;
        let second = self.once(kinds)?;
        if first.snapshot != second.snapshot {
            return Err(invalid(
                "Folder changed during inspection. Scan again before reviewing.",
            ));
        }
        Ok(second)
    }
    pub fn verify(&self, revision: &str, known: Option<&Snapshot>) -> io::Result<Scan> {
        if !blob::valid_hash(revision) {
            return Err(invalid("Invalid folder revision."));
        }
        let scan = self.scan(known)?;
        if scan.revision() != revision {
            return Err(invalid(
                "Folder changed after review. Scan and review again.",
            ));
        }
        Ok(scan)
    }
}
