//! One-time import of a milestone-S data directory (`metadata.sqlite` + `blobs/<ns>-<hash>`)
//! into PostgreSQL and the configured blob store. Every object is verified before anything is
//! written, and again when it is copied. Re-running skips objects already present.
use crate::store::{Error, GLOBAL_SCOPE, PutOutcome, Quota, Store, namespace_scope};
use rusqlite::{Connection, OpenFlags};
use scribyra_core::blob;
use std::{
    fs::File,
    io::Read,
    path::{Path, PathBuf},
};

#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct ImportReport {
    pub objects: u64,
    pub imported: u64,
    pub existing: u64,
}

struct Source {
    blobs: PathBuf,
    rows: Vec<(String, String, usize)>,
    _lock: Option<File>,
}

fn open_source(dir: &Path) -> Result<Source, Error> {
    // A running milestone-S service holds this lock; refuse to copy a live directory.
    let lock = match File::options()
        .read(true)
        .write(true)
        .open(dir.join("service.lock"))
    {
        Ok(file) => {
            file.try_lock()
                .map_err(|_| "the old service is still running")?;
            Some(file)
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
        Err(error) => return Err(error.into()),
    };
    let db = Connection::open_with_flags(
        dir.join("metadata.sqlite"),
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )?;
    let version: u32 = db.query_row("PRAGMA user_version", [], |r| r.get(0))?;
    let tables: Vec<String> = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")?
        .query_map([], |r| r.get(0))?
        .collect::<Result<_, _>>()?;
    let mut rows = Vec::new();
    match version {
        0 if tables.is_empty() => {}
        0 => return Err("not a milestone-S service database".into()),
        1 => {
            let columns: Vec<String> = db
                .prepare("SELECT name FROM pragma_table_info('objects') ORDER BY cid")?
                .query_map([], |r| r.get(0))?
                .collect::<Result<_, _>>()?;
            if tables != ["objects"] || columns != ["namespace", "hash", "size"] {
                return Err("unexpected schema-1 layout".into());
            }
            let mut query = db.prepare("SELECT namespace, hash, size FROM objects")?;
            for row in query.query_map([], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, i64>(2)?,
                ))
            })? {
                let (namespace, hash, size) = row?;
                if !blob::valid_hash(&namespace)
                    || !blob::valid_hash(&hash)
                    || size < 0
                    || size as usize > blob::MAX_BLOB_BYTES
                {
                    return Err("invalid object metadata".into());
                }
                rows.push((namespace, hash, size as usize));
            }
        }
        _ => return Err("unsupported (future) schema".into()),
    }
    Ok(Source {
        blobs: dir.join("blobs"),
        rows,
        _lock: lock,
    })
}

fn read_verified(blobs: &Path, namespace: &str, hash: &str, size: usize) -> Result<Vec<u8>, Error> {
    let file = File::open(blobs.join(format!("{namespace}-{hash}"))).map_err(|_| "missing blob")?;
    if file.metadata()?.len() != size as u64 {
        return Err("blob size differs from metadata".into());
    }
    let mut bytes = Vec::with_capacity(size);
    file.take(size as u64 + 1).read_to_end(&mut bytes)?;
    if bytes.len() != size || !blob::verify(hash, &bytes) {
        return Err("corrupt blob".into());
    }
    Ok(bytes)
}

/// Copy every object of an S data directory into `store`. Quotas are charged but not
/// enforced: the import preserves data the old service had already acknowledged.
pub async fn migrate_sqlite(store: &Store, dir: &Path) -> Result<ImportReport, Error> {
    let dir = dir.to_path_buf();
    let source = tokio::task::spawn_blocking(move || -> Result<Source, Error> {
        let source = open_source(&dir)?;
        // Refuse before writing anything if any acknowledged object is missing or corrupt.
        for (namespace, hash, size) in &source.rows {
            read_verified(&source.blobs, namespace, hash, *size)?;
        }
        Ok(source)
    })
    .await??;
    let mut report = ImportReport::default();
    for (namespace, hash, size) in &source.rows {
        let (blobs, ns, h, size) = (source.blobs.clone(), namespace.clone(), hash.clone(), *size);
        let bytes =
            tokio::task::spawn_blocking(move || read_verified(&blobs, &ns, &h, size)).await??;
        let quotas = [
            Quota::unlimited(GLOBAL_SCOPE),
            Quota::unlimited(namespace_scope(namespace)),
        ];
        match store
            .put_object_with(namespace, hash, bytes.into(), &quotas)
            .await
            .map_err(|e| format!("import failed: {e:?}"))?
        {
            PutOutcome::Created => report.imported += 1,
            PutOutcome::Existing => report.existing += 1,
        }
        report.objects += 1;
    }
    Ok(report)
}
