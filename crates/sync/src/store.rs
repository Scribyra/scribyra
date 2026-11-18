//! Metadata in PostgreSQL, bytes in a [`BlobStore`].
//!
//! Invariants: a metadata row exists only after its blob is durable; every read verifies the
//! hash; quota scopes are locked `FOR UPDATE` in a fixed order (global first) and charged in
//! the same transaction as the insert; one process owns the database (advisory lock), except in
//! a server-readable deployment, whose replicas keep no state in memory and share it.
use crate::{
    blobs::{BlobError, BlobKey, BlobStore, Bytes, FsBlobStore, S3BlobStore},
    config::{BlobBackend, Config},
};
use axum::http::StatusCode;
use scribyra_core::blob;
use sqlx::{
    Connection, PgConnection, PgPool, Row,
    postgres::{PgConnectOptions, PgPoolOptions},
};
use std::{fs::File, str::FromStr, sync::Arc, time::Duration};
use tokio::sync::{Mutex, OwnedSemaphorePermit, Semaphore};

pub type Error = Box<dyn std::error::Error + Send + Sync>;
/// Migrations in `crates/sync/migrations`, embedded at compile time and applied at startup.
pub static MIGRATOR: sqlx::migrate::Migrator = sqlx::migrate!();
/// `pg_try_advisory_lock` key held for the process lifetime ("SCRYSYNC").
pub const LOCK_KEY: i64 = 0x5343_5259_5359_4e43;
/// Charged scope for the whole service.
pub const GLOBAL_SCOPE: &str = "global";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StoreError {
    /// Invalid identifiers, size or hash (400).
    BadRequest,
    /// No such object (404).
    NotFound,
    /// A quota would be exceeded (507).
    Quota,
    /// The response-bytes budget is exhausted (503).
    Busy,
    /// Database or blob failure, or a stored object failed verification (500).
    Internal,
}
impl StoreError {
    pub fn status(self) -> StatusCode {
        match self {
            Self::BadRequest => StatusCode::BAD_REQUEST,
            Self::NotFound => StatusCode::NOT_FOUND,
            Self::Quota => StatusCode::INSUFFICIENT_STORAGE,
            Self::Busy => StatusCode::SERVICE_UNAVAILABLE,
            Self::Internal => StatusCode::INTERNAL_SERVER_ERROR,
        }
    }
}
impl From<sqlx::Error> for StoreError {
    fn from(_: sqlx::Error) -> Self {
        Self::Internal
    }
}
impl From<BlobError> for StoreError {
    fn from(_: BlobError) -> Self {
        Self::Internal
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PutOutcome {
    /// Newly stored (201).
    Created,
    /// The identical object already existed; no quota was consumed (204).
    Existing,
}
impl PutOutcome {
    pub fn status(self) -> StatusCode {
        match self {
            Self::Created => StatusCode::CREATED,
            Self::Existing => StatusCode::NO_CONTENT,
        }
    }
}

/// One quota scope charged by a write. Scopes are locked in slice order, so every caller must
/// pass them in the same global order: `global`, then `org:<id>`, then `namespace:<id>`.
#[derive(Debug, Clone)]
pub struct Quota {
    pub scope: String,
    pub max_bytes: u64,
    pub max_objects: u64,
}
impl Quota {
    pub fn unlimited(scope: impl Into<String>) -> Self {
        Self {
            scope: scope.into(),
            max_bytes: u64::MAX,
            max_objects: u64::MAX,
        }
    }
}
pub fn namespace_scope(namespace: &str) -> String {
    format!("namespace:{namespace}")
}
/// Blob key of an object: `objects/<namespace>/<sha256>`.
pub fn object_key(namespace: &str, hash: &str) -> Result<BlobKey, StoreError> {
    if !blob::valid_hash(hash) {
        return Err(StoreError::BadRequest);
    }
    BlobKey::new(format!("objects/{namespace}/{hash}")).map_err(|_| StoreError::BadRequest)
}

#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct VerifyReport {
    pub objects: u64,
    pub missing: u64,
    pub corrupt: u64,
    /// Usage rows (global or namespace) that differ from the stored objects.
    pub usage_mismatch: u64,
}
impl VerifyReport {
    pub fn ok(&self) -> bool {
        self.missing == 0 && self.corrupt == 0 && self.usage_mismatch == 0
    }
}

pub struct Store {
    pub pool: PgPool,
    pub blobs: Arc<dyn BlobStore>,
    pub config: Config,
    /// The organisation this deployment serves (set when the configuration has a deployment).
    pub org: Option<String>,
    /// Dedicated connection holding the advisory lock; never returned to the pool.
    owner: Mutex<PgConnection>,
    /// Exclusive lock on the filesystem blob directory, if any.
    _directory: Option<File>,
}

/// Records the deployment's encryption mode and organisation at its first start, and refuses to
/// start when the configuration later names the other mode (moving between modes is an export
/// and import, never a silent switch). The organisation gets a random ID at first start; a
/// database that already holds exactly one organisation (from before deployments) keeps it.
async fn record_deployment(pool: &PgPool, deployment: &crate::config::Deployment) -> Result<String, Error> {
    let mut tx = pool.begin().await?;
    sqlx::query("LOCK TABLE deployment IN EXCLUSIVE MODE").execute(&mut *tx).await?;
    let recorded: Option<(String, String)> = sqlx::query_as("SELECT encryption, org FROM deployment").fetch_optional(&mut *tx).await?;
    let org = match recorded {
        Some((encryption, _)) if encryption != deployment.encryption.as_str() => {
            println!("{}", serde_json::json!({"event": "deployment_encryption_changed", "recorded": encryption, "configured": deployment.encryption.as_str()}));
            return Err("the deployment's encryption mode cannot change".into());
        }
        Some((_, org)) => org,
        None => {
            let existing: Vec<String> = sqlx::query_scalar("SELECT org FROM orgs LIMIT 2").fetch_all(&mut *tx).await?;
            let org = match existing.as_slice() {
                [only] => only.clone(),
                _ => {
                    let mut id = [0u8; 32];
                    getrandom::fill(&mut id)?;
                    let org = scribyra_core::orgsync::hex(&id);
                    sqlx::query("INSERT INTO orgs (org, label) VALUES ($1, $2)").bind(&org).bind(&deployment.name).execute(&mut *tx).await?;
                    org
                }
            };
            sqlx::query("INSERT INTO deployment (encryption, org) VALUES ($1, $2)").bind(deployment.encryption.as_str()).bind(&org).execute(&mut *tx).await?;
            org
        }
    };
    sqlx::query("UPDATE orgs SET label = $2 WHERE org = $1").bind(&org).bind(&deployment.name).execute(&mut *tx).await?;
    tx.commit().await?;
    Ok(org)
}

/// Whether the database schema matches the migrations this build embeds.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Schema {
    Current,
    /// Migrations this build has are not applied (run `scribyra-sync migrate`).
    Behind,
    /// The database has migrations this build does not know (a newer version migrated it).
    Ahead,
}
impl Schema {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Current => "current",
            Self::Behind => "behind",
            Self::Ahead => "ahead",
        }
    }
}
/// Compares the applied migrations with [`MIGRATOR`] (version and checksum).
pub async fn schema(pool: &PgPool) -> Result<Schema, Error> {
    let exists: bool = sqlx::query_scalar("SELECT to_regclass('_sqlx_migrations') IS NOT NULL").fetch_one(pool).await?;
    if !exists {
        return Ok(Schema::Behind);
    }
    let applied: Vec<(i64, Vec<u8>)> = sqlx::query_as("SELECT version, checksum FROM _sqlx_migrations WHERE success").fetch_all(pool).await?;
    if applied.iter().any(|(v, _)| !MIGRATOR.iter().any(|m| m.version == *v)) {
        return Ok(Schema::Ahead);
    }
    for m in MIGRATOR.iter() {
        match applied.iter().find(|(v, _)| *v == m.version) {
            None => return Ok(Schema::Behind),
            Some((_, checksum)) if checksum.as_slice() != &*m.checksum => return Err("an applied migration differs from this build's".into()),
            Some(_) => {}
        }
    }
    Ok(Schema::Current)
}
/// `scribyra-sync migrate`: applies pending migrations and returns how many there were. Takes no
/// ownership lock (the migrator takes its own), so it can run while replicas serve.
pub async fn migrate(config: &Config) -> Result<usize, Error> {
    let options = PgConnectOptions::from_str(&config.database_url().map_err(|e| e.to_string())?)?.application_name("scribyra-sync-migrate");
    let pool = PgPoolOptions::new().max_connections(1).acquire_timeout(Duration::from_secs(30)).connect_with(options).await?;
    let before: i64 = match schema(&pool).await? {
        Schema::Ahead => return Err("the database schema is newer than this build".into()),
        _ => sqlx::query_scalar("SELECT count(*) FROM _sqlx_migrations WHERE success").fetch_one(&pool).await.unwrap_or(0),
    };
    MIGRATOR.run(&pool).await?;
    let after: i64 = sqlx::query_scalar("SELECT count(*) FROM _sqlx_migrations WHERE success").fetch_one(&pool).await?;
    pool.close().await;
    Ok((after - before).max(0) as usize)
}

impl Store {
    /// Connect, take ownership, apply migrations (or, with `migrate_on_start: false`, check that
    /// they are applied) and open the blob store. End-to-end and plain deployments take
    /// single-process ownership; server-readable replicas share it.
    /// Does not read stored objects: use [`Store::verify`] for a full check.
    pub async fn open(config: Config) -> Result<Self, Error> {
        let options =
            PgConnectOptions::from_str(&config.database_url().map_err(|e| e.to_string())?)?
                .application_name("scribyra-sync");
        let mut owner = PgConnection::connect_with(&options).await?;
        let shared = config.deployment.as_ref().is_some_and(|d| d.encryption == crate::config::Encryption::Server);
        let locked: bool = sqlx::query_scalar(if shared { "SELECT pg_try_advisory_lock_shared($1)" } else { "SELECT pg_try_advisory_lock($1)" })
            .bind(LOCK_KEY)
            .fetch_one(&mut owner)
            .await?;
        if !locked {
            return Err("database is owned by another process".into());
        }
        let pool = PgPoolOptions::new()
            .max_connections(config.database_connections)
            .acquire_timeout(Duration::from_secs(10))
            .connect_with(options)
            .await?;
        if config.migrate_on_start {
            MIGRATOR.run(&pool).await?;
        } else {
            let found = schema(&pool).await?;
            if found != Schema::Current {
                println!("{}", serde_json::json!({"event": "schema_mismatch", "schema": found.as_str()}));
                return Err("the database schema does not match this build".into());
            }
        }
        let (blobs, directory): (Arc<dyn BlobStore>, _) = match config.blob_store {
            BlobBackend::Filesystem => {
                let data = config.data.clone();
                let (store, lock) = tokio::task::spawn_blocking(move || -> Result<_, Error> {
                    // Lock before removing temporaries, so a second process cannot delete
                    // another one's in-flight writes.
                    if let Err(error) = std::fs::create_dir(&data)
                        && error.kind() != std::io::ErrorKind::AlreadyExists
                    {
                        return Err(error.into());
                    }
                    let lock = File::options()
                        .read(true)
                        .write(true)
                        .create(true)
                        .truncate(false)
                        .open(data.join(".lock"))?;
                    lock.try_lock().map_err(|_| "blob directory is locked")?;
                    Ok((FsBlobStore::open(&data)?, lock))
                })
                .await??;
                (Arc::new(store), Some(lock))
            }
            BlobBackend::S3 => {
                let settings = config
                    .s3_settings()
                    .map_err(|e| e.to_string())?
                    .ok_or("missing s3 settings")?;
                (Arc::new(S3BlobStore::new(settings)?), None)
            }
        };
        let org = match &config.deployment {
            Some(deployment) => Some(record_deployment(&pool, deployment).await?),
            None => None,
        };
        let store = Self {
            pool,
            blobs,
            org,
            config,
            owner: Mutex::new(owner),
            _directory: directory,
        };
        store.ready().await?;
        Ok(store)
    }

    /// Readiness: a pooled round trip, the schema this build expects, the ownership connection,
    /// and a blob store probe.
    pub async fn ready(&self) -> Result<(), Error> {
        if schema(&self.pool).await? != Schema::Current {
            return Err("schema mismatch".into());
        }
        self.owner_alive().await?;
        self.blobs.probe().await?;
        Ok(())
    }
    /// Fails if the connection holding the advisory lock is gone (the lock is then released).
    pub async fn owner_alive(&self) -> Result<(), Error> {
        let mut owner = self.owner.lock().await;
        tokio::time::timeout(Duration::from_secs(5), owner.ping())
            .await
            .map_err(|_| "ownership check timed out")??;
        Ok(())
    }

    /// Quotas applied to `/v1/objects/<namespace>/...` writes, in lock order.
    pub fn object_quotas(&self, namespace: &str) -> Vec<Quota> {
        vec![
            Quota {
                scope: GLOBAL_SCOPE.into(),
                max_bytes: self.config.total_bytes,
                max_objects: self.config.total_objects,
            },
            Quota {
                scope: namespace_scope(namespace),
                max_bytes: self.config.namespace_bytes,
                max_objects: self.config.namespace_objects,
            },
        ]
    }

    /// PUT semantics of `/v1/objects`: 16 bytes to `object_bytes`, hash of the opaque bytes.
    pub async fn put_object(
        &self,
        namespace: &str,
        hash: &str,
        bytes: Bytes,
    ) -> Result<PutOutcome, StoreError> {
        if bytes.len() < 16 || bytes.len() > self.config.object_bytes {
            return Err(StoreError::BadRequest);
        }
        let quotas = self.object_quotas(namespace);
        self.put_object_with(namespace, hash, bytes, &quotas).await
    }

    /// Store an immutable object and charge `quotas` atomically. The hash is verified; an
    /// existing identical object returns [`PutOutcome::Existing`] without charging anything.
    /// The blob is durable before the metadata transaction commits; nothing is acknowledged
    /// on failure. Writers charging a common scope serialize on its row lock.
    pub async fn put_object_with(
        &self,
        namespace: &str,
        hash: &str,
        bytes: Bytes,
        quotas: &[Quota],
    ) -> Result<PutOutcome, StoreError> {
        let key = object_key(namespace, hash)?;
        if bytes.len() > blob::MAX_BLOB_BYTES || !blob::verify(hash, &bytes) {
            return Err(StoreError::BadRequest);
        }
        if let Some(size) = self.object_size(namespace, hash).await? {
            return self.existing(&key, hash, size, bytes.len()).await;
        }
        let scopes: Vec<&str> = quotas.iter().map(|q| q.scope.as_str()).collect();
        sqlx::query("INSERT INTO usage (scope) SELECT unnest($1::text[]) ON CONFLICT DO NOTHING")
            .bind(&scopes)
            .execute(&self.pool)
            .await?;
        let mut tx = self.pool.begin().await?;
        let mut within = true;
        for quota in quotas {
            let row = sqlx::query("SELECT bytes, objects FROM usage WHERE scope = $1 FOR UPDATE")
                .bind(&quota.scope)
                .fetch_one(&mut *tx)
                .await?;
            let used_bytes = row.try_get::<i64, _>(0)? as u64;
            let used_objects = row.try_get::<i64, _>(1)? as u64;
            within &= used_bytes.saturating_add(bytes.len() as u64) <= quota.max_bytes
                && used_objects < quota.max_objects;
        }
        // A concurrent writer may have committed the same object while we waited for locks.
        let size: Option<i64> =
            sqlx::query_scalar("SELECT size FROM objects WHERE namespace = $1 AND hash = $2")
                .bind(namespace)
                .bind(hash)
                .fetch_optional(&mut *tx)
                .await?;
        if let Some(size) = size {
            tx.rollback().await?;
            return self.existing(&key, hash, size, bytes.len()).await;
        }
        if !within {
            tx.rollback().await?;
            return Err(StoreError::Quota);
        }
        let length = bytes.len() as i64;
        self.blobs.put(&key, bytes).await?;
        let recorded = async {
            sqlx::query("INSERT INTO objects (namespace, hash, size) VALUES ($1, $2, $3)")
                .bind(namespace)
                .bind(hash)
                .bind(length)
                .execute(&mut *tx)
                .await?;
            sqlx::query(
                "UPDATE usage SET bytes = bytes + $2, objects = objects + 1 WHERE scope = ANY($1)",
            )
            .bind(&scopes)
            .bind(length)
            .execute(&mut *tx)
            .await?;
            Ok::<_, sqlx::Error>(())
        }
        .await;
        if recorded.is_err() {
            // Still holding the scope locks: no other writer can have referenced this blob.
            // A failed insert must not leave uncharged bytes behind.
            let _ = self.blobs.delete(&key).await;
            let _ = tx.rollback().await;
            return Err(StoreError::Internal);
        }
        // If the commit outcome is unknown the blob stays: it may now be referenced.
        tx.commit().await?;
        Ok(PutOutcome::Created)
    }

    async fn existing(
        &self,
        key: &BlobKey,
        hash: &str,
        size: i64,
        length: usize,
    ) -> Result<PutOutcome, StoreError> {
        // Same hash means same bytes, provided the stored copy still verifies.
        if size != length as i64 {
            return Err(StoreError::Internal);
        }
        let stored = self.blobs.get(key, length).await?;
        if !blob::verify(hash, &stored) {
            return Err(StoreError::Internal);
        }
        Ok(PutOutcome::Existing)
    }

    pub async fn object_size(
        &self,
        namespace: &str,
        hash: &str,
    ) -> Result<Option<i64>, StoreError> {
        Ok(
            sqlx::query_scalar("SELECT size FROM objects WHERE namespace = $1 AND hash = $2")
                .bind(namespace)
                .bind(hash)
                .fetch_optional(&self.pool)
                .await?,
        )
    }

    /// Read a verified object. The metadata-declared size is reserved from `budget` before
    /// any allocation; the permit must be held until the bytes are released.
    pub async fn get_object(
        &self,
        namespace: &str,
        hash: &str,
        budget: Arc<Semaphore>,
    ) -> Result<(Vec<u8>, OwnedSemaphorePermit), StoreError> {
        let key = object_key(namespace, hash)?;
        let size = self
            .object_size(namespace, hash)
            .await?
            .ok_or(StoreError::NotFound)?;
        if size < 0 || size as usize > blob::MAX_BLOB_BYTES {
            return Err(StoreError::Internal);
        }
        let size = size as usize;
        let memory = budget
            .try_acquire_many_owned(size as u32)
            .map_err(|_| StoreError::Busy)?;
        let bytes = self.blobs.get(&key, size).await?;
        if !blob::verify(hash, &bytes) {
            return Err(StoreError::Internal);
        }
        Ok((bytes, memory))
    }

    /// Check every object's presence, length and hash, one object in memory at a time, and
    /// compare the global and namespace usage rows with the stored objects.
    pub async fn verify(&self) -> Result<VerifyReport, Error> {
        let mut report = VerifyReport::default();
        let mut after = (String::new(), String::new());
        loop {
            let rows = sqlx::query(
                "SELECT namespace, hash, size FROM objects WHERE (namespace, hash) > ($1, $2) \
                 ORDER BY namespace, hash LIMIT 500",
            )
            .bind(&after.0)
            .bind(&after.1)
            .fetch_all(&self.pool)
            .await?;
            let Some(last) = rows.last() else { break };
            after = (last.try_get(0)?, last.try_get(1)?);
            for row in rows {
                let (namespace, hash, size): (String, String, i64) =
                    (row.try_get(0)?, row.try_get(1)?, row.try_get(2)?);
                report.objects += 1;
                let Ok(key) = object_key(&namespace, &hash) else {
                    report.corrupt += 1;
                    continue;
                };
                if size < 0 || size as usize > blob::MAX_BLOB_BYTES {
                    report.corrupt += 1;
                    continue;
                }
                match self.blobs.get(&key, size as usize).await {
                    Ok(bytes) if blob::verify(&hash, &bytes) => {}
                    Ok(_) | Err(BlobError::Length) => report.corrupt += 1,
                    Err(BlobError::NotFound) => report.missing += 1,
                    Err(error) => return Err(error.into()),
                }
            }
        }
        report.usage_mismatch = sqlx::query_scalar::<_, i64>(
            "WITH actual AS ( \
               SELECT 'global' AS scope, COALESCE(SUM(size), 0)::bigint AS bytes, COUNT(*) AS objects FROM objects \
               UNION ALL \
               SELECT 'namespace:' || namespace, SUM(size)::bigint, COUNT(*) FROM objects GROUP BY namespace) \
             SELECT COUNT(*) FROM actual FULL JOIN \
               (SELECT * FROM usage WHERE scope = 'global' OR scope LIKE 'namespace:%') u USING (scope) \
             WHERE COALESCE(actual.bytes, 0) <> COALESCE(u.bytes, 0) \
                OR COALESCE(actual.objects, 0) <> COALESCE(u.objects, 0)",
        )
        .fetch_one(&self.pool)
        .await? as u64;
        Ok(report)
    }
}
