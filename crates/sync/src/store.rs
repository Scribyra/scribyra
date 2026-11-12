use crate::config::Config;
use axum::http::StatusCode;
use rusqlite::{Connection, OptionalExtension, params};
use scribyra_core::blob;
use std::{
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    path::PathBuf,
    sync::Arc,
};

use tokio::sync::{OwnedSemaphorePermit, Semaphore};

type Result<T> = std::result::Result<T, Box<dyn std::error::Error>>;
pub struct Store {
    db: Connection,
    blobs: PathBuf,
    _lock: File,
    config: Config,
}
impl Store {
    pub fn open(config: Config) -> Result<Self> {
        match fs::create_dir(&config.data) {
            Ok(()) => {
                let parent = config
                    .data
                    .parent()
                    .filter(|p| !p.as_os_str().is_empty())
                    .unwrap_or(std::path::Path::new("."));
                File::open(parent)?.sync_all()?;
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
            Err(error) => return Err(error.into()),
        }
        let lock = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(config.data.join("service.lock"))?;
        lock.try_lock()?;
        let blobs = config.data.join("blobs");
        fs::create_dir_all(&blobs)?;
        File::open(&config.data)?.sync_all()?;
        let db = Connection::open(config.data.join("metadata.sqlite"))?;
        db.execute_batch("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;")?;
        let version: u32 = db.query_row("PRAGMA user_version", [], |row| row.get(0))?;
        if version > 1 {
            return Err("unsupported schema".into());
        }
        if version == 0 {
            let tables: u32 = db.query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type='table'",
                [],
                |r| r.get(0),
            )?;
            if tables != 0 {
                return Err("legacy database is not a service database".into());
            }
            db.execute_batch("BEGIN IMMEDIATE; CREATE TABLE objects(namespace TEXT NOT NULL, hash TEXT NOT NULL, size INTEGER NOT NULL, PRIMARY KEY(namespace,hash)); PRAGMA user_version=1; COMMIT;")?;
        }
        let store = Self {
            db,
            blobs,
            _lock: lock,
            config,
        };
        // Recover only unacknowledged remnants; never silently discard a committed object.
        {
            let mut query = store
                .db
                .prepare("SELECT namespace,hash,size FROM objects")?;
            let rows = query.query_map([], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, i64>(2)? as usize,
                ))
            })?;
            for row in rows {
                let (namespace, hash, size) = row?;
                if !blob::valid_hash(&namespace)
                    || !blob::valid_hash(&hash)
                    || size > blob::MAX_BLOB_BYTES
                {
                    return Err("invalid object metadata".into());
                }
                let bytes = fs::read(store.path(&namespace, &hash))?;
                if bytes.len() != size || !blob::verify(&hash, &bytes) {
                    return Err("corrupt object".into());
                }
            }
        }
        for entry in fs::read_dir(&store.blobs)? {
            let entry = entry?;
            let name = entry.file_name();
            let name = name.to_str().ok_or("invalid blob name")?;
            let keep = if let Some((ns, hash)) = name.split_once('-') {
                store.exists(ns, hash)?
            } else {
                false
            };
            if !keep {
                fs::remove_file(entry.path())?;
            }
        }
        File::open(&store.blobs)?.sync_all()?;
        store.ready()?;
        Ok(store)
    }
    fn path(&self, namespace: &str, hash: &str) -> PathBuf {
        self.blobs.join(format!("{namespace}-{hash}"))
    }
    fn exists(&self, ns: &str, hash: &str) -> rusqlite::Result<bool> {
        self.db
            .query_row(
                "SELECT 1 FROM objects WHERE namespace=?1 AND hash=?2",
                params![ns, hash],
                |_| Ok(()),
            )
            .optional()
            .map(|v| v.is_some())
    }
    pub fn ready(&self) -> Result<()> {
        self.db.execute_batch("BEGIN IMMEDIATE; ROLLBACK;")?;
        let path = self.blobs.join("probe");
        let f = File::create(&path)?;
        f.sync_all()?;
        fs::remove_file(path)?;
        File::open(&self.blobs)?.sync_all()?;
        Ok(())
    }
    pub fn get(
        &self,
        ns: &str,
        hash: &str,
        budget: Arc<Semaphore>,
    ) -> std::result::Result<(Vec<u8>, OwnedSemaphorePermit), StatusCode> {
        let size: u32 = self
            .db
            .query_row(
                "SELECT size FROM objects WHERE namespace=?1 AND hash=?2",
                params![ns, hash],
                |r| r.get(0),
            )
            .optional()
            .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
            .ok_or(StatusCode::NOT_FOUND)?;
        let size = size as usize;
        if size > blob::MAX_BLOB_BYTES {
            return Err(StatusCode::INTERNAL_SERVER_ERROR);
        }
        let memory = budget
            .try_acquire_many_owned(size as u32)
            .map_err(|_| StatusCode::SERVICE_UNAVAILABLE)?;
        // Metadata bounds allocation even if a committed file is replaced or grows.
        let mut bytes = vec![0; size];
        let mut file =
            File::open(self.path(ns, hash)).map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
        file.read_exact(&mut bytes)
            .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
        let mut extra = [0];
        if file
            .read(&mut extra)
            .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
            != 0
            || !blob::verify(hash, &bytes)
        {
            return Err(StatusCode::INTERNAL_SERVER_ERROR);
        }
        Ok((bytes, memory))
    }
    pub fn put(
        &mut self,
        ns: &str,
        hash: &str,
        bytes: &[u8],
    ) -> std::result::Result<StatusCode, StatusCode> {
        if bytes.len() < 16 || bytes.len() > self.config.object_bytes || !blob::verify(hash, bytes)
        {
            return Err(StatusCode::BAD_REQUEST);
        }
        let work = || -> Result<StatusCode> {
            if self.exists(ns, hash)? {
                if fs::read(self.path(ns, hash))? != bytes {
                    return Err("corrupt object".into());
                }
                return Ok(StatusCode::NO_CONTENT);
            }
            let usage = |namespace: Option<&str>| -> rusqlite::Result<(u64, u64)> {
                self.db.query_row("SELECT COALESCE(SUM(size),0), COUNT(*) FROM objects WHERE ?1 IS NULL OR namespace=?1", [namespace], |r| Ok((r.get::<_, i64>(0)? as u64,r.get::<_, i64>(1)? as u64)))
            };
            let (size, count) = usage(Some(ns))?;
            let (total, objects) = usage(None)?;
            if size + bytes.len() as u64 > self.config.namespace_bytes
                || count >= self.config.namespace_objects
                || total + bytes.len() as u64 > self.config.total_bytes
                || objects >= self.config.total_objects
            {
                return Ok(StatusCode::INSUFFICIENT_STORAGE);
            }
            let temp = self.blobs.join("pending");
            let mut file = File::create(&temp)?;
            file.write_all(bytes)?;
            file.sync_all()?;
            fs::rename(temp, self.path(ns, hash))?;
            File::open(&self.blobs)?.sync_all()?;
            if let Err(error) = self.db.execute(
                "INSERT INTO objects(namespace,hash,size) VALUES(?1,?2,?3)",
                params![ns, hash, bytes.len() as i64],
            ) {
                // A failed commit must not accumulate uncharged objects on a writable blob disk.
                fs::remove_file(self.path(ns, hash))?;
                File::open(&self.blobs)?.sync_all()?;
                return Err(error.into());
            }
            Ok(StatusCode::CREATED)
        };
        work().map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)
    }
}
