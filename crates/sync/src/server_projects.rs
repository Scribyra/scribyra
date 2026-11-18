//! Server-readable projects (design sections 1, 4 and 7): the server is the authority for an
//! organisation project's log of Yjs updates. It sequences, validates (`yrs`) and stores each
//! update sealed at rest, answers catch-up reads, writes snapshots, materialises a project's
//! files, and lets owners and editors share by email invitation.
//!
//! Everything durable is in PostgreSQL and the blob store; replicas share nothing in memory.
//! A change (entry, rename, share, deletion) is announced with `NOTIFY scribyra_sr`, naming the
//! project, and a change to the projects an account can see (or to its sessions) with
//! `a:<account>`; every replica `LISTEN`s and wakes only the heads polls those notices concern.
//! Payloads only route wake-ups: a woken poll reads everything it answers from the database.
//!
//! **Sealing.** Each project has a random 32-byte data key, stored only wrapped by the master
//! key (`service_key_file`) with XChaCha20-Poly1305 and associated data naming the deployment
//! and the project. Entry bodies, snapshots and objects are sealed under the data key with
//! associated data naming the project, the kind and the sequence number or hash, so sealed
//! bytes cannot be moved between projects or slots. Deleting a project clears the wrapped key
//! in the same transaction (crypto-erase); a background pass then removes rows and blobs.
//!
//! The routes answer `404` unless the deployment's `encryption` is `"server"`. Sessions are the
//! sign-in tokens of [`crate::sso`] (`Authorization: ScribyraSSO <token>`). Never logged:
//! content, names, emails, tokens.
use crate::{
    blobs::{BlobKey, Bytes},
    config::Encryption,
    sso::{Role, Sso},
    store::{Error, Store},
};
use axum::{
    Json, Router,
    body::{Body, to_bytes},
    extract::{Path, Query, State},
    http::{HeaderMap, HeaderValue, StatusCode, header},
    response::{IntoResponse, Response},
    routing::{get, post, put},
};
use scribyra_core::{blob, orgsync};
use serde::Deserialize;
use serde_json::{Value, json};
use sqlx::{PgPool, Row};
use std::{
    collections::{BTreeSet, HashMap, HashSet},
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::sync::{Notify, Semaphore, watch};
use yrs::{Any, GetString, Map, Options, Out, ReadTxn, StateVector, Transact, Update, updates::decoder::Decode};

/// The PostgreSQL notification channel; the payload is a project ID or `a:<account>`.
pub const CHANNEL: &str = "scribyra_sr";
/// The longest a heads poll waits.
pub const MAX_HEADS_WAIT_SECS: u64 = 25;
/// Heads polls one account may keep waiting on one replica; a further one ends the oldest.
pub const MAX_POLLS_PER_ACCOUNT: usize = 4;
const MAX_LOG_PAGE: i64 = 1000;
const DEFAULT_LOG_PAGE: i64 = 256;
const MAX_LOG_PAGE_BYTES: usize = 16 * 1024 * 1024;
const MAX_NAME_CHARS: usize = 200;
const DEPLOYMENT_SCOPE: &str = "sr:deployment";
const SEAL_OVERHEAD: usize = 24 + 16;

fn error(status: StatusCode, message: &'static str) -> Response {
    (status, [(header::CACHE_CONTROL, "no-store")], Json(json!({"error": message}))).into_response()
}
fn internal<E>(_: E) -> Response {
    error(StatusCode::INTERNAL_SERVER_ERROR, "internal error")
}
fn not_found() -> Response {
    error(StatusCode::NOT_FOUND, "unknown project")
}
fn random_bytes<const N: usize>() -> [u8; N] {
    let mut bytes = [0u8; N];
    getrandom::fill(&mut bytes).expect("operating system randomness");
    bytes
}
fn random_hex() -> String {
    orgsync::hex(&random_bytes::<32>())
}
/// The ID of the project an account creates with the request ID `key`:
/// SHA-256 of `scribyra-sr-project/1\n<account>\n<key>`, in hex.
pub fn project_id(account: &str, key: &str) -> String {
    blob::hash(format!("scribyra-sr-project/1\n{account}\n{key}").as_bytes())
}
fn is_id(text: &str) -> bool {
    blob::valid_hash(text)
}
fn ok_json(status: StatusCode, body: Value) -> Response {
    (status, [(header::CACHE_CONTROL, "no-store")], Json(body)).into_response()
}

/// Associated data of a sealed project item: `kind` is `update`, `snapshot` or `object`, `slot`
/// the sequence number or the plaintext hash.
pub fn item_ad(project: &str, kind: &str, slot: &str) -> Vec<u8> {
    format!("scribyra-sr/1\n{project}\n{kind}\n{slot}").into_bytes()
}
fn key_ad(deployment: &str, project: &str) -> Vec<u8> {
    format!("scribyra-sr-key/1\n{deployment}\n{project}").into_bytes()
}
/// nonce ‖ XChaCha20-Poly1305(key, nonce, ad, plaintext).
pub fn seal(key: &[u8], ad: &[u8], plaintext: &[u8]) -> Vec<u8> {
    let nonce = random_bytes::<24>();
    let mut out = nonce.to_vec();
    out.extend(orgsync::seal(key, &nonce, ad, plaintext).expect("32-byte key and 24-byte nonce"));
    out
}
pub fn open(key: &[u8], ad: &[u8], sealed: &[u8]) -> Option<Vec<u8>> {
    if sealed.len() < SEAL_OVERHEAD {
        return None;
    }
    orgsync::open(key, &sealed[..24], ad, &sealed[24..]).ok()
}

/// A project's role for the caller. Admins have no extra project rights in this slice.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Access {
    Owner,
    Editor,
    Reviewer,
    Viewer,
}
impl Access {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Owner => "owner",
            Self::Editor => "editor",
            Self::Reviewer => "reviewer",
            Self::Viewer => "viewer",
        }
    }
    fn share(text: &str) -> Option<Self> {
        match text {
            "editor" => Some(Self::Editor),
            "reviewer" => Some(Self::Reviewer),
            "viewer" => Some(Self::Viewer),
            _ => None,
        }
    }
    /// Owners and editors write updates and objects, rename and share.
    pub fn writes(self) -> bool {
        matches!(self, Self::Owner | Self::Editor)
    }
}

/// One file of a materialised project.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct File {
    pub id: String,
    /// The project path (folders without a trailing slash).
    pub path: String,
    /// Set when the tree shows the node as a conflict (for example a name clash after a merge).
    pub conflict: Option<String>,
    pub content: Content,
}
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Content {
    Folder,
    Text(String),
    /// A binary asset: its object's hash and size, and its bytes when the object is stored.
    Asset { hash: String, size: u64, bytes: Option<Vec<u8>> },
}
/// A project's files at a sequence number: what export (slice 10) and compile (slice 11) use.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Materialised {
    pub seq: i64,
    /// `meta.name` when the document has one, else the project's name on the server.
    pub name: String,
    /// The main file's path (`meta.mainFile`), if it names an existing file.
    pub main_file: Option<String>,
    pub files: Vec<File>,
}

/// The storage side of server-readable projects: sealing, appends, snapshots, materialisation
/// and maintenance. Usable without HTTP (tests, and slices 10 and 11).
pub struct Projects {
    pub store: Arc<Store>,
    master: [u8; 32],
    deployment: String,
    /// Projects this process is compacting now (another replica may race; that is harmless).
    compacting: Mutex<HashSet<String>>,
    /// Wakes the maintenance task early (after a deletion).
    pub kick: Notify,
}
/// What an append did.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Appended {
    /// Newly sequenced (201).
    Created(i64),
    /// An identical retry of an entry already sequenced (200).
    Repeated(i64),
}
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AppendError {
    NotFound,
    /// The same client sequence number with other bytes (409).
    Conflict,
    /// A quota would be exceeded (507).
    Quota,
    /// Storage or database failure (500).
    Internal,
}
impl From<sqlx::Error> for AppendError {
    fn from(_: sqlx::Error) -> Self {
        Self::Internal
    }
}

impl Projects {
    /// `None` unless the deployment is server-readable (and so has a master key).
    pub fn new(store: Arc<Store>) -> Result<Option<Arc<Self>>, Error> {
        let server = store.config.deployment.as_ref().is_some_and(|d| d.encryption == Encryption::Server);
        let (true, Some(deployment)) = (server, store.org.clone()) else { return Ok(None) };
        let master = store.config.master_key().map_err(|e| e.to_string())?.ok_or("server-readable deployments need service_key_file")?;
        Ok(Some(Arc::new(Self { store, master, deployment, compacting: Mutex::default(), kick: Notify::new() })))
    }
    fn pool(&self) -> &PgPool {
        &self.store.pool
    }
    fn quotas(&self) -> crate::config::Quotas {
        self.store.config.deployment.as_ref().map(|d| d.quotas.clone()).unwrap_or_default()
    }
    /// The project's data key, unwrapped (`None` when erased or tampered with).
    fn data_key(&self, project: &str, wrapped: Option<&[u8]>) -> Option<Vec<u8>> {
        open(&self.master, &key_ad(&self.deployment, project), wrapped?)
    }
    fn wrap(&self, project: &str, key: &[u8]) -> Vec<u8> {
        seal(&self.master, &key_ad(&self.deployment, project), key)
    }
    async fn read_body(&self, inline: Option<Vec<u8>>, blob: Option<String>, size: i64) -> Result<Vec<u8>, Error> {
        if let Some(bytes) = inline {
            return Ok(bytes);
        }
        let key = BlobKey::new(blob.ok_or("entry body was removed")?)?;
        Ok(self.store.blobs.get(&key, size as usize).await?)
    }
    /// Stores sealed bytes inline (small) or as a blob; returns (inline, blob key).
    async fn put_sealed(&self, project: &str, kind: &str, slot: &str, sealed: Vec<u8>) -> Result<(Option<Vec<u8>>, Option<String>), Error> {
        if sealed.len() <= self.store.config.entry_inline_bytes && kind != "o" {
            return Ok((Some(sealed), None));
        }
        let key = format!("sr/{project}/{kind}/{slot}-{}", orgsync::hex(&random_bytes::<8>()));
        self.store.blobs.put(&BlobKey::new(key.clone())?, Bytes::from(sealed)).await?;
        Ok((None, Some(key)))
    }
    async fn forget_blob(&self, key: Option<String>) {
        if let Some(key) = key
            && let Ok(key) = BlobKey::new(key)
        {
            let _ = self.store.blobs.delete(&key).await;
        }
    }

    /// Creates an empty project owned by `owner`. A repeat by the same owner is `Ok(false)` (the
    /// project exists); an ID someone else holds is `Err(Conflict)` (with IDs derived from the
    /// owner, only by a SHA-256 collision).
    pub async fn create(&self, id: &str, owner: &str, name: &str) -> Result<bool, AppendError> {
        let key = random_bytes::<32>();
        let mut tx = self.pool().begin().await?;
        let inserted = sqlx::query("INSERT INTO sr_projects (project, owner, name, data_key_wrapped) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING")
            .bind(id)
            .bind(owner)
            .bind(name)
            .bind(self.wrap(id, &key))
            .execute(&mut *tx)
            .await?;
        if inserted.rows_affected() == 0 {
            let existing: Option<(String, bool)> = sqlx::query_as("SELECT owner, deleted IS NULL FROM sr_projects WHERE project = $1").bind(id).fetch_optional(&mut *tx).await?;
            return match existing {
                Some((o, true)) if o == owner => Ok(false),
                _ => Err(AppendError::Conflict),
            };
        }
        notify(&mut tx, id).await?;
        notify_account(&mut tx, owner).await?;
        tx.commit().await?;
        Ok(true)
    }

    /// Appends one update (already checked to decode). Idempotent per (account, client, client_seq):
    /// identical bytes get the original sequence number, other bytes `Conflict`. The answer is
    /// given only after commit, with the body durable (inline, or in the blob store first).
    pub async fn append(&self, project: &str, account: &str, client: &str, client_seq: i64, body: &[u8]) -> Result<Appended, AppendError> {
        let body_hash = blob::hash(body);
        let mut tx = self.pool().begin().await?;
        // The project row serialises appends to one log; then the deployment's usage row.
        let row = sqlx::query("SELECT head_seq, data_key_wrapped, owner, bytes FROM sr_projects WHERE project = $1 AND deleted IS NULL FOR UPDATE")
            .bind(project)
            .fetch_optional(&mut *tx)
            .await?
            .ok_or(AppendError::NotFound)?;
        let (head, wrapped, owner, project_bytes): (i64, Option<Vec<u8>>, String, i64) = (row.get(0), row.get(1), row.get(2), row.get(3));
        // A slot is (account, client, client sequence): another member reusing this client ID
        // has slots of their own and cannot block these (review L1).
        let existing: Option<(i64, String)> = sqlx::query_as("SELECT seq, body_hash FROM sr_entries WHERE project = $1 AND account = $2 AND client = $3 AND client_seq = $4")
            .bind(project)
            .bind(account)
            .bind(client)
            .bind(client_seq)
            .fetch_optional(&mut *tx)
            .await?;
        if let Some((seq, hash)) = existing {
            let _ = tx.rollback().await;
            return if hash == body_hash { Ok(Appended::Repeated(seq)) } else { Err(AppendError::Conflict) };
        }
        let key = self.data_key(project, wrapped.as_deref()).ok_or(AppendError::Internal)?;
        let seq = head + 1;
        let sealed = seal(&key, &item_ad(project, "update", &seq.to_string()), body);
        let size = sealed.len() as i64;
        let (inline, blob_key) = self.put_sealed(project, "e", &seq.to_string(), sealed).await.map_err(|_| AppendError::Internal)?;
        let written = async {
            let used: i64 = sqlx::query_scalar("SELECT bytes FROM usage WHERE scope = $1 FOR UPDATE").bind(DEPLOYMENT_SCOPE).fetch_one(&mut *tx).await?;
            let member: i64 = sqlx::query_scalar("SELECT COALESCE(sum(bytes), 0)::bigint FROM sr_projects WHERE owner = $1 AND deleted IS NULL").bind(&owner).fetch_one(&mut *tx).await?;
            let q = self.quotas();
            if (used + size) as u64 > q.deployment_bytes || (project_bytes + size) as u64 > q.project_bytes || (member + size) as u64 > q.member_bytes {
                return Ok(false);
            }
            sqlx::query("INSERT INTO sr_entries (project, seq, account, client, client_seq, body_hash, size, inline_sealed, blob) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)")
                .bind(project)
                .bind(seq)
                .bind(account)
                .bind(client)
                .bind(client_seq)
                .bind(&body_hash)
                .bind(size)
                .bind(&inline)
                .bind(&blob_key)
                .execute(&mut *tx)
                .await?;
            sqlx::query("UPDATE sr_projects SET head_seq = $2, bytes = bytes + $3, updated = now() WHERE project = $1").bind(project).bind(seq).bind(size).execute(&mut *tx).await?;
            sqlx::query("UPDATE usage SET bytes = bytes + $2, objects = objects + 1 WHERE scope = $1").bind(DEPLOYMENT_SCOPE).bind(size).execute(&mut *tx).await?;
            notify(&mut tx, project).await?;
            Ok::<_, sqlx::Error>(true)
        }
        .await;
        match written {
            Ok(true) => {}
            Ok(false) => {
                let _ = tx.rollback().await;
                self.forget_blob(blob_key).await;
                return Err(AppendError::Quota);
            }
            Err(_) => {
                let _ = tx.rollback().await;
                self.forget_blob(blob_key).await;
                return Err(AppendError::Internal);
            }
        }
        // If the commit's outcome is unknown the blob stays: the row may now reference it.
        tx.commit().await?;
        Ok(Appended::Created(seq))
    }

    /// Whether the project is due a snapshot (entries or bytes since the last one).
    pub async fn due(&self, project: &str) -> Result<bool, Error> {
        let (count, bytes): (i64, i64) = sqlx::query_as(
            "SELECT count(*), COALESCE(sum(e.size), 0)::bigint FROM sr_entries e JOIN sr_projects p USING (project) WHERE e.project = $1 AND e.seq > p.snapshot_seq",
        )
        .bind(project)
        .fetch_one(self.pool())
        .await?;
        let c = &self.store.config;
        Ok(count as u64 >= c.sr_snapshot_entries || bytes as u64 >= c.sr_snapshot_bytes)
    }

    /// Replays the latest snapshot and the entries after it into a document that keeps every
    /// tombstone (no garbage collection); returns it with the head it covers.
    pub async fn replay(&self, project: &str) -> Result<(yrs::Doc, i64), Error> {
        let row = sqlx::query("SELECT head_seq, data_key_wrapped FROM sr_projects WHERE project = $1 AND deleted IS NULL").bind(project).fetch_optional(self.pool()).await?.ok_or("unknown project")?;
        let (head, wrapped): (i64, Option<Vec<u8>>) = (row.get(0), row.get(1));
        let key = self.data_key(project, wrapped.as_deref()).ok_or("the project key does not open")?;
        let doc = yrs::Doc::with_options(Options { skip_gc: true, ..Options::default() });
        let snapshot = sqlx::query("SELECT seq, size, inline_sealed, blob FROM sr_snapshots WHERE project = $1 AND seq <= $2 ORDER BY seq DESC LIMIT 1").bind(project).bind(head).fetch_optional(self.pool()).await?;
        let mut after = 0;
        let mut updates = Vec::new();
        if let Some(s) = snapshot {
            after = s.get::<i64, _>(0);
            let sealed = self.read_body(s.get(2), s.get(3), s.get(1)).await?;
            updates.push(open(&key, &item_ad(project, "snapshot", &after.to_string()), &sealed).ok_or("a snapshot does not open")?);
        }
        let rows = sqlx::query("SELECT seq, size, inline_sealed, blob FROM sr_entries WHERE project = $1 AND seq > $2 AND seq <= $3 ORDER BY seq").bind(project).bind(after).bind(head).fetch_all(self.pool()).await?;
        for r in rows {
            let seq: i64 = r.get(0);
            let sealed = self.read_body(r.get(2), r.get(3), r.get(1)).await?;
            let update = open(&key, &item_ad(project, "update", &seq.to_string()), &sealed).ok_or("an entry does not open")?;
            // Entries are checked again (stored before the check existed, or by another build);
            // snapshots are the server's own `yrs` output.
            crate::update_check::check(&update)?;
            updates.push(update);
        }
        // A panic inside `yrs` fails this replay, not the process or the replica's task.
        let applied = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| -> Result<(), Error> {
            let mut txn = doc.transact_mut();
            for update in updates {
                txn.apply_update(Update::decode_v1(&update)?)?;
            }
            Ok(())
        }));
        applied.map_err(|_| "yrs panicked while replaying the log")??;
        Ok((doc, head))
    }

    /// Writes a snapshot covering the head (if newer than the last) and, with a zero retention
    /// window, moves the floor to it at once. Returns the snapshot's sequence number.
    pub async fn compact(&self, project: &str) -> Result<Option<i64>, Error> {
        if !self.compacting.lock().unwrap().insert(project.to_owned()) {
            return Ok(None);
        }
        // Cleared however this ends: returned, failed, panicked or dropped (review L3).
        struct Claim<'a>(&'a Mutex<HashSet<String>>, &'a str);
        impl Drop for Claim<'_> {
            fn drop(&mut self) {
                self.0.lock().unwrap_or_else(|e| e.into_inner()).remove(self.1);
            }
        }
        let claim = Claim(&self.compacting, project);
        let result = self.compact_now(project).await;
        drop(claim);
        if result.as_ref().is_ok_and(Option::is_some) && self.store.config.sr_retention_seconds == 0 {
            self.move_floor(project).await?;
        }
        result
    }
    async fn compact_now(&self, project: &str) -> Result<Option<i64>, Error> {
        let (doc, head) = self.replay(project).await?;
        let state = doc.transact().encode_state_as_update_v1(&StateVector::default());
        let wrapped: Option<Vec<u8>> = sqlx::query_scalar("SELECT data_key_wrapped FROM sr_projects WHERE project = $1 AND deleted IS NULL").bind(project).fetch_optional(self.pool()).await?.flatten();
        let key = self.data_key(project, wrapped.as_deref()).ok_or("the project key does not open")?;
        let sealed = seal(&key, &item_ad(project, "snapshot", &head.to_string()), &state);
        if sealed.len() > blob::MAX_BLOB_BYTES {
            println!("{}", json!({"event": "sr_snapshot_skipped", "reason": "too_large"}));
            return Ok(None);
        }
        let size = sealed.len() as i64;
        let (inline, blob_key) = self.put_sealed(project, "s", &head.to_string(), sealed).await?;
        let mut tx = self.pool().begin().await?;
        let current: Option<i64> = sqlx::query_scalar("SELECT snapshot_seq FROM sr_projects WHERE project = $1 AND deleted IS NULL FOR UPDATE").bind(project).fetch_optional(&mut *tx).await?;
        if current.is_none_or(|s| s >= head) {
            let _ = tx.rollback().await;
            self.forget_blob(blob_key).await;
            return Ok(None);
        }
        // The server's own snapshots are charged but never refused: they make reads cheaper.
        sqlx::query("SELECT bytes FROM usage WHERE scope = $1 FOR UPDATE").bind(DEPLOYMENT_SCOPE).execute(&mut *tx).await?;
        sqlx::query("INSERT INTO sr_snapshots (project, seq, size, inline_sealed, blob) VALUES ($1, $2, $3, $4, $5)").bind(project).bind(head).bind(size).bind(&inline).bind(&blob_key).execute(&mut *tx).await?;
        sqlx::query("UPDATE sr_projects SET snapshot_seq = $2, bytes = bytes + $3 WHERE project = $1").bind(project).bind(head).bind(size).execute(&mut *tx).await?;
        sqlx::query("UPDATE usage SET bytes = bytes + $2 WHERE scope = $1").bind(DEPLOYMENT_SCOPE).bind(size).execute(&mut *tx).await?;
        tx.commit().await?;
        Ok(Some(head))
    }
    /// Moves the floor to the newest snapshot older than the retention window: bodies of
    /// entries at or below it, and older snapshots, are dropped (their blobs queued for removal);
    /// the entry rows stay for idempotent retries.
    pub async fn move_floor(&self, project: &str) -> Result<Option<i64>, Error> {
        let mut tx = self.pool().begin().await?;
        let Some(floor): Option<i64> = sqlx::query_scalar("SELECT floor_seq FROM sr_projects WHERE project = $1 AND deleted IS NULL FOR UPDATE SKIP LOCKED").bind(project).fetch_optional(&mut *tx).await? else {
            return Ok(None);
        };
        let target: Option<i64> = sqlx::query_scalar("SELECT max(seq) FROM sr_snapshots WHERE project = $1 AND created <= now() - make_interval(secs => $2)")
            .bind(project)
            .bind(self.store.config.sr_retention_seconds as f64)
            .fetch_one(&mut *tx)
            .await?;
        let Some(target) = target.filter(|t| *t > floor) else {
            let _ = tx.rollback().await;
            return Ok(None);
        };
        sqlx::query("INSERT INTO sr_garbage (blob) SELECT blob FROM sr_entries WHERE project = $1 AND seq <= $2 AND blob IS NOT NULL ON CONFLICT DO NOTHING").bind(project).bind(target).execute(&mut *tx).await?;
        let freed: i64 = sqlx::query_scalar(
            "WITH gone AS (UPDATE sr_entries SET inline_sealed = NULL, blob = NULL WHERE project = $1 AND seq <= $2 AND (inline_sealed IS NOT NULL OR blob IS NOT NULL) RETURNING size)
             SELECT COALESCE(sum(size), 0)::bigint FROM gone",
        )
        .bind(project)
        .bind(target)
        .fetch_one(&mut *tx)
        .await?;
        let snapshots: i64 = sqlx::query_scalar(
            "WITH gone AS (DELETE FROM sr_snapshots WHERE project = $1 AND seq < $2 RETURNING size, blob),
             queued AS (INSERT INTO sr_garbage (blob) SELECT blob FROM gone WHERE blob IS NOT NULL ON CONFLICT DO NOTHING)
             SELECT COALESCE(sum(size), 0)::bigint FROM gone",
        )
        .bind(project)
        .bind(target)
        .fetch_one(&mut *tx)
        .await?;
        sqlx::query("SELECT bytes FROM usage WHERE scope = $1 FOR UPDATE").bind(DEPLOYMENT_SCOPE).execute(&mut *tx).await?;
        sqlx::query("UPDATE sr_projects SET floor_seq = $2, bytes = bytes - $3 WHERE project = $1").bind(project).bind(target).bind(freed + snapshots).execute(&mut *tx).await?;
        sqlx::query("UPDATE usage SET bytes = greatest(bytes - $2, 0) WHERE scope = $1").bind(DEPLOYMENT_SCOPE).bind(freed + snapshots).execute(&mut *tx).await?;
        tx.commit().await?;
        self.kick.notify_one();
        Ok(Some(target))
    }

    /// The project's files, texts, asset objects and main file at its head.
    pub async fn materialise(&self, project: &str) -> Result<Materialised, Error> {
        let (doc, seq) = self.replay(project).await?;
        let server_name: String = sqlx::query_scalar("SELECT name FROM sr_projects WHERE project = $1").bind(project).fetch_one(self.pool()).await?;
        let files_map = doc.get_or_insert_map("files");
        let trash_map = doc.get_or_insert_map("trash");
        let meta = doc.get_or_insert_map("meta");
        let assets = doc.get_or_insert_map("assets");
        let mut nodes = Vec::new();
        let (reserved, main, name, refs) = {
            let txn = doc.transact();
            for (_, value) in files_map.iter(&txn) {
                let Out::Any(Any::Map(record)) = value else { continue };
                let text = |k: &str| match record.get(k) {
                    Some(Any::String(s)) => Some(s.to_string()),
                    _ => None,
                };
                let flag = |k: &str| matches!(record.get(k), Some(Any::Bool(true)));
                let Some(id) = text("id") else { continue };
                nodes.push(scribyra_core::tree::Node { id, path: String::new(), name: text("name"), parent_id: text("parentId"), binary: flag("binary"), folder: flag("folder"), conflict: None });
            }
            let reserved: Vec<String> = trash_map.keys(&txn).map(str::to_owned).collect();
            let string = |o: Option<Out>| match o {
                Some(Out::Any(Any::String(s))) => Some(s.to_string()),
                _ => None,
            };
            let refs: Vec<(String, Out)> = assets.iter(&txn).map(|(k, v)| (k.to_owned(), v)).collect();
            (reserved, string(meta.get(&txn, "mainFile")), string(meta.get(&txn, "name")), refs)
        };
        let nodes = scribyra_core::tree::execute(scribyra_core::tree::Request { nodes, reserved, command: scribyra_core::tree::Command::Inspect })?;
        let mut files = Vec::new();
        for node in &nodes {
            let content = if node.folder {
                Content::Folder
            } else if node.binary {
                match refs.iter().find(|(k, _)| *k == node.id).map(|(_, v)| v) {
                    Some(Out::Any(Any::Map(r))) => {
                        let hash = match r.get("hash") {
                            Some(Any::String(h)) if blob::valid_hash(h) => h.to_string(),
                            _ => continue,
                        };
                        let size = match r.get("size") {
                            Some(Any::Number(n)) if *n >= 0.0 => *n as u64,
                            Some(Any::BigInt(n)) if *n >= 0 => *n as u64,
                            _ => continue,
                        };
                        let bytes = self.object(project, &hash).await?;
                        Content::Asset { hash, size, bytes }
                    }
                    // Projects from before content-addressed assets keep the bytes inline.
                    Some(Out::Any(Any::Buffer(b))) => Content::Asset { hash: blob::hash(b), size: b.len() as u64, bytes: Some(b.to_vec()) },
                    _ => continue,
                }
            } else {
                let text = doc.get_or_insert_text(format!("text:{}", node.id));
                Content::Text(text.get_string(&doc.transact()))
            };
            files.push(File { id: node.id.clone(), path: node.path.clone(), conflict: node.conflict.clone(), content });
        }
        let main_file = main.and_then(|id| nodes.iter().find(|n| n.id == id && !n.folder).map(|n| n.path.clone()));
        Ok(Materialised { seq, name: name.filter(|n| !n.trim().is_empty()).unwrap_or(server_name), main_file, files })
    }

    /// A stored object's plaintext (checked against its hash), or `None` if it is not stored.
    pub async fn object(&self, project: &str, hash: &str) -> Result<Option<Vec<u8>>, Error> {
        let row = sqlx::query("SELECT o.sealed_size, o.blob, p.data_key_wrapped FROM sr_objects o JOIN sr_projects p USING (project) WHERE o.project = $1 AND o.hash = $2 AND p.deleted IS NULL")
            .bind(project)
            .bind(hash)
            .fetch_optional(self.pool())
            .await?;
        let Some(row) = row else { return Ok(None) };
        let key = self.data_key(project, row.get::<Option<Vec<u8>>, _>(2).as_deref()).ok_or("the project key does not open")?;
        let sealed = self.read_body(None, row.get(1), row.get(0)).await?;
        let plain = open(&key, &item_ad(project, "object", hash), &sealed).ok_or("an object does not open")?;
        if !blob::verify(hash, &plain) {
            return Err("a stored object does not match its hash".into());
        }
        Ok(Some(plain))
    }
    /// Stores an object (its hash already checked): `Ok(true)` if new, `Ok(false)` if it was there.
    pub async fn put_object(&self, project: &str, hash: &str, bytes: &[u8]) -> Result<bool, AppendError> {
        let present: Option<i32> = sqlx::query_scalar("SELECT 1 FROM sr_objects WHERE project = $1 AND hash = $2").bind(project).bind(hash).fetch_optional(self.pool()).await?;
        if present.is_some() {
            return Ok(false);
        }
        let wrapped: Option<Vec<u8>> = sqlx::query_scalar("SELECT data_key_wrapped FROM sr_projects WHERE project = $1 AND deleted IS NULL").bind(project).fetch_optional(self.pool()).await?.ok_or(AppendError::NotFound)?;
        let key = self.data_key(project, wrapped.as_deref()).ok_or(AppendError::Internal)?;
        let sealed = seal(&key, &item_ad(project, "object", hash), bytes);
        let size = sealed.len() as i64;
        let (_, blob_key) = self.put_sealed(project, "o", hash, sealed).await.map_err(|_| AppendError::Internal)?;
        let mut tx = self.pool().begin().await?;
        let outcome = async {
            let Some((owner, project_bytes)): Option<(String, i64)> = sqlx::query_as("SELECT owner, bytes FROM sr_projects WHERE project = $1 AND deleted IS NULL FOR UPDATE").bind(project).fetch_optional(&mut *tx).await? else {
                return Ok(Err(AppendError::NotFound));
            };
            let present: Option<i32> = sqlx::query_scalar("SELECT 1 FROM sr_objects WHERE project = $1 AND hash = $2").bind(project).bind(hash).fetch_optional(&mut *tx).await?;
            if present.is_some() {
                return Ok(Ok(false));
            }
            let used: i64 = sqlx::query_scalar("SELECT bytes FROM usage WHERE scope = $1 FOR UPDATE").bind(DEPLOYMENT_SCOPE).fetch_one(&mut *tx).await?;
            let member: i64 = sqlx::query_scalar("SELECT COALESCE(sum(bytes), 0)::bigint FROM sr_projects WHERE owner = $1 AND deleted IS NULL").bind(&owner).fetch_one(&mut *tx).await?;
            let q = self.quotas();
            if (used + size) as u64 > q.deployment_bytes || (project_bytes + size) as u64 > q.project_bytes || (member + size) as u64 > q.member_bytes {
                return Ok(Err(AppendError::Quota));
            }
            sqlx::query("INSERT INTO sr_objects (project, hash, size, sealed_size, blob) VALUES ($1, $2, $3, $4, $5)").bind(project).bind(hash).bind(bytes.len() as i64).bind(size).bind(&blob_key).execute(&mut *tx).await?;
            sqlx::query("UPDATE sr_projects SET bytes = bytes + $2 WHERE project = $1").bind(project).bind(size).execute(&mut *tx).await?;
            sqlx::query("UPDATE usage SET bytes = bytes + $2, objects = objects + 1 WHERE scope = $1").bind(DEPLOYMENT_SCOPE).bind(size).execute(&mut *tx).await?;
            Ok::<_, sqlx::Error>(Ok(true))
        }
        .await;
        match outcome {
            Ok(Ok(true)) => {
                tx.commit().await?;
                Ok(true)
            }
            Ok(other) => {
                let _ = tx.rollback().await;
                self.forget_blob(blob_key).await;
                other
            }
            Err(_) => {
                let _ = tx.rollback().await;
                self.forget_blob(blob_key).await;
                Err(AppendError::Internal)
            }
        }
    }

    /// Crypto-erase: the wrapped key goes in the same transaction that marks the project
    /// deleted, so everything sealed under it is unreadable from then on; maintenance removes
    /// the rows and blobs.
    pub async fn delete(&self, project: &str) -> Result<bool, Error> {
        let mut tx = self.pool().begin().await?;
        let bytes: Option<i64> = sqlx::query_scalar("UPDATE sr_projects SET deleted = now(), data_key_wrapped = NULL WHERE project = $1 AND deleted IS NULL RETURNING bytes").bind(project).fetch_optional(&mut *tx).await?;
        let Some(bytes) = bytes else { return Ok(false) };
        sqlx::query("SELECT bytes FROM usage WHERE scope = $1 FOR UPDATE").bind(DEPLOYMENT_SCOPE).execute(&mut *tx).await?;
        sqlx::query("UPDATE usage SET bytes = greatest(bytes - $2, 0) WHERE scope = $1").bind(DEPLOYMENT_SCOPE).bind(bytes).execute(&mut *tx).await?;
        notify(&mut tx, project).await?;
        tx.commit().await?;
        self.kick.notify_one();
        Ok(true)
    }

    /// One maintenance pass (any replica; rows are claimed with `SKIP LOCKED`): erased projects'
    /// rows go and their blobs are queued, floors move past the retention window, and queued
    /// blobs are removed. Returns how many blobs were removed.
    pub async fn maintain(&self) -> Result<u64, Error> {
        loop {
            let mut tx = self.pool().begin().await?;
            let erased: Vec<String> = sqlx::query_scalar("SELECT project FROM sr_projects WHERE deleted IS NOT NULL ORDER BY deleted LIMIT 16 FOR UPDATE SKIP LOCKED").fetch_all(&mut *tx).await?;
            if erased.is_empty() {
                break;
            }
            for table in ["sr_entries", "sr_snapshots", "sr_objects"] {
                sqlx::query(&format!("INSERT INTO sr_garbage (blob) SELECT blob FROM {table} WHERE project = ANY($1) AND blob IS NOT NULL ON CONFLICT DO NOTHING")).bind(&erased).execute(&mut *tx).await?;
            }
            sqlx::query("DELETE FROM sr_projects WHERE project = ANY($1)").bind(&erased).execute(&mut *tx).await?;
            tx.commit().await?;
        }
        let due: Vec<String> = sqlx::query_scalar(
            "SELECT p.project FROM sr_projects p WHERE p.deleted IS NULL AND p.snapshot_seq > p.floor_seq
               AND EXISTS (SELECT 1 FROM sr_snapshots s WHERE s.project = p.project AND s.seq > p.floor_seq AND s.created <= now() - make_interval(secs => $1)) LIMIT 64",
        )
        .bind(self.store.config.sr_retention_seconds as f64)
        .fetch_all(self.pool())
        .await?;
        for project in due {
            self.move_floor(&project).await?;
        }
        let mut removed = 0;
        loop {
            let mut tx = self.pool().begin().await?;
            let keys: Vec<String> = sqlx::query_scalar("SELECT blob FROM sr_garbage ORDER BY queued LIMIT 64 FOR UPDATE SKIP LOCKED").fetch_all(&mut *tx).await?;
            if keys.is_empty() {
                break;
            }
            for key in &keys {
                if let Ok(k) = BlobKey::new(key.clone()) {
                    match self.store.blobs.delete(&k).await {
                        Ok(()) | Err(crate::blobs::BlobError::NotFound) => {}
                        Err(e) => return Err(e.into()),
                    }
                }
            }
            sqlx::query("DELETE FROM sr_garbage WHERE blob = ANY($1)").bind(&keys).execute(&mut *tx).await?;
            tx.commit().await?;
            removed += keys.len() as u64;
        }
        Ok(removed)
    }
}

async fn notify(tx: &mut sqlx::Transaction<'_, sqlx::Postgres>, project: &str) -> Result<(), sqlx::Error> {
    sqlx::query("SELECT pg_notify($1, $2)").bind(CHANNEL).bind(project).execute(&mut **tx).await?;
    Ok(())
}
/// Tells the account's heads polls that the projects it can see (or its sessions) changed.
pub async fn notify_account(tx: &mut sqlx::PgConnection, account: &str) -> Result<(), sqlx::Error> {
    sqlx::query("SELECT pg_notify($1, $2)").bind(CHANNEL).bind(format!("a:{account}")).execute(&mut *tx).await?;
    Ok(())
}

/// Turns pending, unexpired invitations to the account's verified email into shares (called at
/// every sign-in of a server-readable deployment). An unverified email matches nothing, and an
/// invitation counts only for the provider it names or, naming none, for a provider whose
/// `email_domains` vouch for the email (review H2).
pub async fn accept_invitations(pool: &PgPool, account: &str, deployment: &crate::config::Deployment) -> Result<(), sqlx::Error> {
    let mut tx = pool.begin().await?;
    let row: Option<(String, String)> = sqlx::query_as("SELECT email, provider FROM accounts WHERE account = $1 AND email_verified AND email IS NOT NULL AND state = 'active'").bind(account).fetch_optional(&mut *tx).await?;
    let Some((email, provider)) = row else { return Ok(()) };
    let email = crate::sso::normalise_email(&email);
    let vouched = deployment.provider(&provider).is_some_and(|p| crate::sso::vouches(p, &email));
    let accepted: Vec<(String, String, Option<String>)> = sqlx::query_as(
        "UPDATE sr_invitations i SET state = 'accepted' FROM sr_projects p
         WHERE i.project = p.project AND p.deleted IS NULL AND p.owner <> $2 AND i.state = 'pending' AND i.email = $1 AND i.expires > now()
           AND (i.provider = $3 OR (i.provider IS NULL AND $4))
         RETURNING i.project, i.role, i.created_by",
    )
    .bind(&email)
    .bind(account)
    .bind(&provider)
    .bind(vouched)
    .fetch_all(&mut *tx)
    .await?;
    for (project, role, by) in &accepted {
        sqlx::query("INSERT INTO sr_shares (project, account, role, created_by) VALUES ($1, $2, $3, $4) ON CONFLICT (project, account) DO UPDATE SET role = EXCLUDED.role")
            .bind(project)
            .bind(account)
            .bind(role)
            .bind(by)
            .execute(&mut *tx)
            .await?;
        notify(&mut tx, project).await?;
    }
    if !accepted.is_empty() {
        notify_account(&mut tx, account).await?;
    }
    tx.commit().await
}

/// The heads polls waiting on this replica, indexed by account and by the projects each one's
/// account could see when it last looked (review M4: every notice used to wake every poll).
#[derive(Default)]
pub struct Polls {
    next: u64,
    polls: HashMap<u64, Poll>,
    by_project: HashMap<String, HashSet<u64>>,
    by_account: HashMap<String, BTreeSet<u64>>,
}
struct Poll {
    account: String,
    projects: HashSet<String>,
    wake: Arc<Notify>,
    superseded: bool,
}
impl Polls {
    /// Registers a poll; past [`MAX_POLLS_PER_ACCOUNT`] the account's oldest is superseded
    /// (woken to answer at once). Returns the poll's ID and its wake-up.
    pub fn register(&mut self, account: &str) -> (u64, Arc<Notify>) {
        let id = self.next;
        self.next += 1;
        let mine = self.by_account.entry(account.to_owned()).or_default();
        let live: Vec<u64> = mine.iter().copied().filter(|p| !self.polls[p].superseded).collect();
        if live.len() >= MAX_POLLS_PER_ACCOUNT {
            let oldest = self.polls.get_mut(&live[0]).expect("indexed poll");
            oldest.superseded = true;
            oldest.wake.notify_one();
        }
        mine.insert(id);
        let wake = Arc::new(Notify::new());
        self.polls.insert(id, Poll { account: account.to_owned(), projects: HashSet::new(), wake: wake.clone(), superseded: false });
        (id, wake)
    }
    /// Records the projects the poll's account can see; returns whether any is new to it.
    pub fn watch<'a>(&mut self, id: u64, projects: impl IntoIterator<Item = &'a String>) -> bool {
        let Some(poll) = self.polls.get_mut(&id) else { return false };
        let now: HashSet<String> = projects.into_iter().cloned().collect();
        let added = now.difference(&poll.projects).cloned().collect::<Vec<_>>();
        for gone in poll.projects.difference(&now) {
            if let Some(set) = self.by_project.get_mut(gone) {
                set.remove(&id);
                if set.is_empty() {
                    self.by_project.remove(gone);
                }
            }
        }
        for project in &added {
            self.by_project.entry(project.clone()).or_default().insert(id);
        }
        poll.projects = now;
        !added.is_empty()
    }
    pub fn superseded(&self, id: u64) -> bool {
        self.polls.get(&id).is_some_and(|p| p.superseded)
    }
    pub fn remove(&mut self, id: u64) {
        let Some(poll) = self.polls.remove(&id) else { return };
        self.watch_none(&poll.projects, id);
        if let Some(set) = self.by_account.get_mut(&poll.account) {
            set.remove(&id);
            if set.is_empty() {
                self.by_account.remove(&poll.account);
            }
        }
    }
    fn watch_none(&mut self, projects: &HashSet<String>, id: u64) {
        for project in projects {
            if let Some(set) = self.by_project.get_mut(project) {
                set.remove(&id);
                if set.is_empty() {
                    self.by_project.remove(project);
                }
            }
        }
    }
    /// Wakes the polls a notice concerns (a project ID, or `a:<account>`); returns how many.
    pub fn route(&self, payload: &str) -> usize {
        let ids: Vec<u64> = match payload.strip_prefix("a:") {
            Some(account) => self.by_account.get(account).map(|s| s.iter().copied().collect()).unwrap_or_default(),
            None => self.by_project.get(payload).map(|s| s.iter().copied().collect()).unwrap_or_default(),
        };
        for id in &ids {
            self.polls[id].wake.notify_one();
        }
        ids.len()
    }
    /// Wakes every poll (the listener reconnected, so notices may have been lost).
    pub fn wake_all(&self) {
        for poll in self.polls.values() {
            poll.wake.notify_one();
        }
    }
    pub fn len(&self) -> usize {
        self.polls.len()
    }
    pub fn is_empty(&self) -> bool {
        self.polls.is_empty()
    }
}

/// The HTTP side: routes, the heads long poll and the background tasks.
pub struct Sr {
    projects: Option<Arc<Projects>>,
    sso: Arc<Sso>,
    polls: Mutex<Polls>,
    shutdown: watch::Receiver<bool>,
    uploads: Arc<Semaphore>,
}
/// Unregisters a heads poll however its request ends.
struct PollGuard<'a>(&'a Sr, u64);
impl Drop for PollGuard<'_> {
    fn drop(&mut self) {
        self.0.polls.lock().unwrap().remove(self.1);
    }
}
type Shared = Arc<Sr>;

/// The caller of a server-readable route.
struct Caller {
    account: String,
    role: Role,
}

impl Sr {
    pub fn new(store: Arc<Store>, sso: Arc<Sso>, shutdown: watch::Receiver<bool>) -> Result<Shared, Error> {
        let uploads = Arc::new(Semaphore::new(store.config.uploads));
        let projects = Projects::new(store.clone())?;
        let sr = Arc::new(Self { projects, sso, polls: Mutex::default(), shutdown, uploads });
        if sr.projects.is_some()
            && let Ok(runtime) = tokio::runtime::Handle::try_current()
        {
            runtime.spawn(listen(Arc::downgrade(&sr), store.pool.clone()));
            runtime.spawn(maintain(Arc::downgrade(&sr)));
        }
        Ok(sr)
    }
    fn projects(&self) -> Result<&Arc<Projects>, Response> {
        self.projects.as_ref().ok_or_else(|| error(StatusCode::NOT_FOUND, "this deployment does not store server-readable projects"))
    }
    async fn caller(&self, headers: &HeaderMap) -> Result<(&Arc<Projects>, Caller), Response> {
        let projects = self.projects()?;
        let Some(token) = crate::sso::bearer(headers) else { return Err(error(StatusCode::UNAUTHORIZED, "sign in required")) };
        let login = self.sso.login(token).await.map_err(internal)?.ok_or_else(|| error(StatusCode::UNAUTHORIZED, "sign in required"))?;
        let Some(account) = login.account else { return Err(error(StatusCode::UNAUTHORIZED, "sign in again")) };
        let _ = sqlx::query("UPDATE accounts SET last_seen = now() WHERE account = $1 AND last_seen < now() - interval '1 minute'").bind(&account).execute(&projects.store.pool).await;
        Ok((projects, Caller { account, role: login.role }))
    }
    /// The caller's access to a live project; non-members get `404`, as if it did not exist.
    async fn access(&self, projects: &Projects, caller: &Caller, project: &str) -> Result<Access, Response> {
        if !is_id(project) {
            return Err(not_found());
        }
        let row: Option<(String, Option<String>)> = sqlx::query_as("SELECT p.owner, s.role FROM sr_projects p LEFT JOIN sr_shares s ON s.project = p.project AND s.account = $2 WHERE p.project = $1 AND p.deleted IS NULL")
            .bind(project)
            .bind(&caller.account)
            .fetch_optional(&projects.store.pool)
            .await
            .map_err(internal)?;
        match row {
            Some((owner, _)) if owner == caller.account => Ok(Access::Owner),
            Some((_, Some(role))) => Access::share(&role).ok_or_else(|| internal(())),
            _ => Err(not_found()),
        }
    }
    /// Owners and editors who are not guests may share; others are refused (`403`).
    fn may_share(caller: &Caller, access: Access) -> Result<(), Response> {
        if !access.writes() || caller.role == Role::Guest {
            return Err(error(StatusCode::FORBIDDEN, "only the owner and editors can share this project"));
        }
        Ok(())
    }
    async fn details(&self, projects: &Projects, caller: &Caller, project: &str, access: Access) -> Result<Value, Response> {
        let pool = &projects.store.pool;
        let row = sqlx::query(
            "SELECT p.name, p.head_seq, p.floor_seq, p.snapshot_seq, p.bytes, (extract(epoch FROM p.created) * 1000)::bigint, (extract(epoch FROM p.updated) * 1000)::bigint,
                    o.account, o.name, CASE WHEN o.email_verified THEN o.email END, o.provider
             FROM sr_projects p JOIN accounts o ON o.account = p.owner WHERE p.project = $1 AND p.deleted IS NULL",
        )
        .bind(project)
        .fetch_optional(pool)
        .await
        .map_err(internal)?
        .ok_or_else(not_found)?;
        let owner = json!({"account": row.get::<String, _>(7), "name": row.get::<Option<String>, _>(8), "email": row.get::<Option<String>, _>(9), "provider": row.get::<String, _>(10), "role": "owner"});
        let mut members = vec![owner.clone()];
        let shares = sqlx::query("SELECT a.account, a.name, CASE WHEN a.email_verified THEN a.email END, s.role, a.provider FROM sr_shares s JOIN accounts a USING (account) WHERE s.project = $1 ORDER BY s.created, a.account")
            .bind(project)
            .fetch_all(pool)
            .await
            .map_err(internal)?;
        for s in shares {
            members.push(json!({"account": s.get::<String, _>(0), "name": s.get::<Option<String>, _>(1), "email": s.get::<Option<String>, _>(2), "provider": s.get::<String, _>(4), "role": s.get::<String, _>(3)}));
        }
        let mut invitations = Vec::new();
        if access.writes() && caller.role != Role::Guest {
            let rows = sqlx::query("SELECT invitation, email, role, (extract(epoch FROM created) * 1000)::bigint, (extract(epoch FROM expires) * 1000)::bigint, provider FROM sr_invitations WHERE project = $1 AND state = 'pending' AND expires > now() ORDER BY created")
                .bind(project)
                .fetch_all(pool)
                .await
                .map_err(internal)?;
            for r in rows {
                invitations.push(json!({"id": r.get::<String, _>(0), "email": r.get::<String, _>(1), "provider": r.get::<Option<String>, _>(5), "role": r.get::<String, _>(2), "created": r.get::<i64, _>(3), "expires": r.get::<i64, _>(4)}));
            }
        }
        Ok(json!({
            "id": project, "name": row.get::<String, _>(0), "role": access.as_str(), "owner": owner,
            "head": row.get::<i64, _>(1), "floor": row.get::<i64, _>(2), "snapshot": row.get::<i64, _>(3), "size": row.get::<i64, _>(4),
            "created": row.get::<i64, _>(5), "updated": row.get::<i64, _>(6), "members": members, "invitations": invitations,
        }))
    }
    /// The caller's projects and their heads, roles and names; `version` digests them.
    async fn heads_now(&self, projects: &Projects, caller: &Caller) -> Result<(String, Value), Response> {
        let rows = sqlx::query(
            "SELECT p.project, p.head_seq, CASE WHEN p.owner = $1 THEN 'owner' ELSE s.role END, p.name
             FROM sr_projects p LEFT JOIN sr_shares s ON s.project = p.project AND s.account = $1
             WHERE p.deleted IS NULL AND (p.owner = $1 OR s.account IS NOT NULL) ORDER BY p.project",
        )
        .bind(&caller.account)
        .fetch_all(&projects.store.pool)
        .await
        .map_err(internal)?;
        let mut map = serde_json::Map::new();
        for r in rows {
            map.insert(r.get(0), json!({"head": r.get::<i64, _>(1), "role": r.get::<String, _>(2), "name": r.get::<String, _>(3)}));
        }
        let value = Value::Object(map);
        Ok((blob::hash(value.to_string().as_bytes())[..32].to_owned(), value))
    }
}

/// Follows `NOTIFY scribyra_sr` on a dedicated connection, reconnecting after failures. A
/// notice wakes the polls it concerns; (re)connecting wakes every poll, since notices may have
/// been lost meanwhile.
async fn listen(sr: std::sync::Weak<Sr>, pool: PgPool) {
    loop {
        if let Ok(mut listener) = sqlx::postgres::PgListener::connect_with(&pool).await
            && listener.listen(CHANNEL).await.is_ok()
        {
            let Some(s) = sr.upgrade() else { return };
            s.polls.lock().unwrap().wake_all();
            drop(s);
            loop {
                let notice = listener.try_recv().await;
                let Some(s) = sr.upgrade() else { return };
                match notice {
                    Ok(Some(n)) => {
                        s.polls.lock().unwrap().route(n.payload());
                    }
                    Ok(None) | Err(_) => break,
                }
            }
        }
        let Some(s) = sr.upgrade() else { return };
        s.polls.lock().unwrap().wake_all();
        drop(s);
        tokio::time::sleep(Duration::from_secs(1)).await;
    }
}
async fn maintain(sr: std::sync::Weak<Sr>) {
    loop {
        let Some(projects) = sr.upgrade().and_then(|s| s.projects.clone()) else { return };
        if projects.maintain().await.is_err() {
            println!("{}", json!({"event": "sr_maintenance_failed"}));
        }
        let pause = Duration::from_secs(projects.store.config.sr_maintenance_seconds);
        let _ = tokio::time::timeout(pause, projects.kick.notified()).await;
    }
}

async fn list(State(sr): State<Shared>, headers: HeaderMap) -> Response {
    let (projects, caller) = match sr.caller(&headers).await {
        Ok(c) => c,
        Err(r) => return r,
    };
    let rows = sqlx::query(
        "SELECT p.project, p.name, CASE WHEN p.owner = $1 THEN 'owner' ELSE s.role END, p.head_seq, p.bytes,
                (extract(epoch FROM p.created) * 1000)::bigint, (extract(epoch FROM p.updated) * 1000)::bigint, o.account, o.name, CASE WHEN o.email_verified THEN o.email END, o.provider
         FROM sr_projects p JOIN accounts o ON o.account = p.owner LEFT JOIN sr_shares s ON s.project = p.project AND s.account = $1
         WHERE p.deleted IS NULL AND (p.owner = $1 OR s.account IS NOT NULL) ORDER BY p.updated DESC, p.project",
    )
    .bind(&caller.account)
    .fetch_all(&projects.store.pool)
    .await;
    let rows = match rows {
        Ok(rows) => rows,
        Err(e) => return internal(e),
    };
    let list: Vec<Value> = rows
        .iter()
        .map(|r| {
            json!({"id": r.get::<String, _>(0), "name": r.get::<String, _>(1), "role": r.get::<String, _>(2), "head": r.get::<i64, _>(3), "size": r.get::<i64, _>(4),
                   "created": r.get::<i64, _>(5), "updated": r.get::<i64, _>(6), "owner": {"account": r.get::<String, _>(7), "name": r.get::<Option<String>, _>(8), "email": r.get::<Option<String>, _>(9), "provider": r.get::<String, _>(10)}})
        })
        .collect();
    ok_json(StatusCode::OK, json!({"account": caller.account, "role": caller.role.as_str(), "projects": list}))
}

fn valid_name(name: &str) -> bool {
    !name.trim().is_empty() && name.chars().count() <= MAX_NAME_CHARS && !name.chars().any(char::is_control)
}
fn client_id(text: &str) -> bool {
    !text.is_empty() && text.len() <= 64 && text.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}
const MAX_CLIENT_SEQ: i64 = 1 << 53;
/// Untrusted bytes reach `yrs` only through [`crate::update_check`] (review C1), on a blocking
/// thread (a large update takes a while to walk and apply).
async fn decodes(update: bytes::Bytes) -> bool {
    tokio::task::spawn_blocking(move || crate::update_check::decodes(&update)).await.unwrap_or(false)
}
fn append_response(outcome: Result<Appended, AppendError>) -> Response {
    match outcome {
        Ok(Appended::Created(seq)) => ok_json(StatusCode::CREATED, json!({"seq": seq})),
        Ok(Appended::Repeated(seq)) => ok_json(StatusCode::OK, json!({"seq": seq})),
        Err(AppendError::NotFound) => not_found(),
        Err(AppendError::Conflict) => error(StatusCode::CONFLICT, "different update at this client sequence"),
        Err(AppendError::Quota) => error(StatusCode::INSUFFICIENT_STORAGE, "quota"),
        Err(AppendError::Internal) => internal(()),
    }
}
/// After an append: snapshot in the background when due.
fn after_append(projects: &Arc<Projects>, project: &str) {
    let (projects, project) = (projects.clone(), project.to_owned());
    tokio::spawn(async move {
        if matches!(projects.due(&project).await, Ok(true)) && projects.compact(&project).await.is_err() {
            println!("{}", json!({"event": "sr_compaction_failed"}));
        }
    });
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct CreateRequest {
    #[serde(default)]
    id: Option<String>,
    name: String,
    /// Base64 (standard) of a Yjs update: the project's initial state, appended as entry 1.
    #[serde(default)]
    state: Option<String>,
    #[serde(default)]
    client: Option<String>,
    #[serde(default)]
    client_seq: Option<i64>,
}
async fn create(State(sr): State<Shared>, headers: HeaderMap, body: Body) -> Response {
    let (projects, caller) = match sr.caller(&headers).await {
        Ok(c) => c,
        Err(r) => return r,
    };
    if caller.role == Role::Guest {
        return error(StatusCode::FORBIDDEN, "guests cannot create projects");
    }
    let limit = projects.store.config.sr_entry_bytes / 3 * 4 + 64 * 1024;
    let Ok(bytes) = to_bytes(body, limit).await else { return error(StatusCode::PAYLOAD_TOO_LARGE, "initial state too large") };
    let Ok(request) = serde_json::from_slice::<CreateRequest>(&bytes) else { return error(StatusCode::BAD_REQUEST, "invalid request") };
    if !valid_name(&request.name) || request.id.as_deref().is_some_and(|id| !is_id(id)) || request.client.as_deref().is_some_and(|c| !client_id(c)) || request.client_seq.is_some_and(|n| !(1..=MAX_CLIENT_SEQ).contains(&n)) {
        return error(StatusCode::BAD_REQUEST, "invalid request");
    }
    let state = match &request.state {
        Some(text) => match base64::Engine::decode(&base64::engine::general_purpose::STANDARD, text) {
            Ok(state) if state.len() > projects.store.config.sr_entry_bytes => return error(StatusCode::PAYLOAD_TOO_LARGE, "initial state too large"),
            Ok(state) if decodes(bytes::Bytes::from(state.clone())).await => Some(state),
            _ => return error(StatusCode::BAD_REQUEST, "the initial state is not a Yjs update"),
        },
        None => None,
    };
    // With `id`, the project's ID is derived from the caller's account and it, so a retry finds
    // the project it created and nobody can learn, by trying an ID, that someone else's project
    // has it (review L5). The app can compute it before the request.
    let id = match &request.id {
        Some(key) => project_id(&caller.account, key),
        None => random_hex(),
    };
    let created = match projects.create(&id, &caller.account, request.name.trim()).await {
        Ok(created) => created,
        Err(e) => return internal(e),
    };
    let mut seq = None;
    if let Some(state) = state {
        let client = request.client.clone().unwrap_or_else(|| "initial".into());
        match projects.append(&id, &caller.account, &client, request.client_seq.unwrap_or(1), &state).await {
            Ok(Appended::Created(n) | Appended::Repeated(n)) => seq = Some(n),
            Err(e) => {
                // A new project whose first state cannot be stored is not left behind empty.
                if created {
                    let _ = projects.delete(&id).await;
                }
                return append_response(Err(e));
            }
        }
        after_append(projects, &id);
    }
    match sr.details(projects, &caller, &id, Access::Owner).await {
        Ok(details) => ok_json(if created { StatusCode::CREATED } else { StatusCode::OK }, json!({"project": details, "seq": seq})),
        Err(r) => r,
    }
}
async fn project(State(sr): State<Shared>, Path(p): Path<String>, headers: HeaderMap) -> Response {
    let (projects, caller) = match sr.caller(&headers).await {
        Ok(c) => c,
        Err(r) => return r,
    };
    let access = match sr.access(projects, &caller, &p).await {
        Ok(a) => a,
        Err(r) => return r,
    };
    match sr.details(projects, &caller, &p, access).await {
        Ok(details) => ok_json(StatusCode::OK, details),
        Err(r) => r,
    }
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Rename {
    name: String,
}
async fn rename(State(sr): State<Shared>, Path(p): Path<String>, headers: HeaderMap, Json(request): Json<Rename>) -> Response {
    let (projects, caller) = match sr.caller(&headers).await {
        Ok(c) => c,
        Err(r) => return r,
    };
    let access = match sr.access(projects, &caller, &p).await {
        Ok(a) => a,
        Err(r) => return r,
    };
    if !access.writes() {
        return error(StatusCode::FORBIDDEN, "only the owner and editors can rename this project");
    }
    if !valid_name(&request.name) {
        return error(StatusCode::BAD_REQUEST, "invalid name");
    }
    let done = async {
        let mut tx = projects.store.pool.begin().await?;
        sqlx::query("UPDATE sr_projects SET name = $2, updated = now() WHERE project = $1 AND deleted IS NULL").bind(&p).bind(request.name.trim()).execute(&mut *tx).await?;
        notify(&mut tx, &p).await?;
        tx.commit().await
    };
    if let Err(e) = done.await {
        return internal(e);
    }
    match sr.details(projects, &caller, &p, access).await {
        Ok(details) => ok_json(StatusCode::OK, details),
        Err(r) => r,
    }
}
async fn delete_project(State(sr): State<Shared>, Path(p): Path<String>, headers: HeaderMap) -> Response {
    let (projects, caller) = match sr.caller(&headers).await {
        Ok(c) => c,
        Err(r) => return r,
    };
    match sr.access(projects, &caller, &p).await {
        Ok(Access::Owner) => {}
        Ok(_) => return error(StatusCode::FORBIDDEN, "only the owner can delete this project"),
        Err(r) => return r,
    }
    match projects.delete(&p).await {
        Ok(true) => StatusCode::NO_CONTENT.into_response(),
        Ok(false) => not_found(),
        Err(e) => internal(e),
    }
}

fn header_text<'a>(headers: &'a HeaderMap, name: &str) -> Option<&'a str> {
    headers.get(name).and_then(|v| v.to_str().ok())
}
async fn append(State(sr): State<Shared>, Path(p): Path<String>, headers: HeaderMap, body: Body) -> Response {
    let (projects, caller) = match sr.caller(&headers).await {
        Ok(c) => c,
        Err(r) => return r,
    };
    let access = match sr.access(projects, &caller, &p).await {
        Ok(a) => a,
        Err(r) => return r,
    };
    if !access.writes() {
        return error(StatusCode::FORBIDDEN, "only the owner and editors can change this project");
    }
    let client = header_text(&headers, "scribyra-client").filter(|c| client_id(c));
    let client_seq = header_text(&headers, "scribyra-client-seq").and_then(|n| n.parse::<i64>().ok()).filter(|n| (1..=MAX_CLIENT_SEQ).contains(n));
    let (Some(client), Some(client_seq)) = (client, client_seq) else {
        return error(StatusCode::BAD_REQUEST, "Scribyra-Client and Scribyra-Client-Seq are required");
    };
    let Ok(bytes) = to_bytes(body, projects.store.config.sr_entry_bytes).await else { return error(StatusCode::PAYLOAD_TOO_LARGE, "update too large") };
    if !decodes(bytes.clone()).await {
        return error(StatusCode::BAD_REQUEST, "the body is not a Yjs update");
    }
    let outcome = projects.append(&p, &caller.account, client, client_seq, &bytes).await;
    if matches!(outcome, Ok(Appended::Created(_))) {
        after_append(projects, &p);
    }
    append_response(outcome)
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct After {
    #[serde(default)]
    after: i64,
    #[serde(default)]
    limit: Option<i64>,
}
fn log_headers(head: i64, floor: i64, snapshot: i64) -> [(header::HeaderName, HeaderValue); 4] {
    [
        (header::CACHE_CONTROL, HeaderValue::from_static("no-store")),
        (header::HeaderName::from_static("scribyra-log-head"), HeaderValue::from(head)),
        (header::HeaderName::from_static("scribyra-log-floor"), HeaderValue::from(floor)),
        (header::HeaderName::from_static("scribyra-snapshot-seq"), HeaderValue::from(snapshot)),
    ]
}
/// Entries after `after` as frames: seq (u64, big-endian), length (u32, big-endian), the Yjs
/// update. Read to the `Scribyra-Log-Head` header. Below the floor: `410` with the snapshot.
async fn read_log(State(sr): State<Shared>, Path(p): Path<String>, Query(q): Query<After>, headers: HeaderMap) -> Response {
    let (projects, caller) = match sr.caller(&headers).await {
        Ok(c) => c,
        Err(r) => return r,
    };
    if let Err(r) = sr.access(projects, &caller, &p).await {
        return r;
    }
    if q.after < 0 {
        return error(StatusCode::BAD_REQUEST, "invalid request");
    }
    let pool = &projects.store.pool;
    let row = match sqlx::query("SELECT head_seq, floor_seq, snapshot_seq, data_key_wrapped FROM sr_projects WHERE project = $1 AND deleted IS NULL").bind(&p).fetch_optional(pool).await {
        Ok(Some(row)) => row,
        Ok(None) => return not_found(),
        Err(e) => return internal(e),
    };
    let (head, floor, snapshot, wrapped): (i64, i64, i64, Option<Vec<u8>>) = (row.get(0), row.get(1), row.get(2), row.get(3));
    let compacted = |floor: i64, snapshot: i64| (StatusCode::GONE, log_headers(head, floor, snapshot), Json(json!({"error": "compacted", "floor": floor, "snapshot": snapshot}))).into_response();
    if q.after < floor {
        return compacted(floor, snapshot);
    }
    // A body that cannot be read because the floor has passed it since (garbage removal ran
    // meanwhile) is `410` like any compacted read, not `500` (review L4).
    let lost = |seq: i64| {
        let p = p.clone();
        async move {
            match sqlx::query_as::<_, (i64, i64)>("SELECT floor_seq, snapshot_seq FROM sr_projects WHERE project = $1 AND deleted IS NULL").bind(&p).fetch_optional(pool).await {
                Ok(Some((floor, snapshot))) if floor >= seq => compacted(floor, snapshot),
                Ok(None) => not_found(),
                _ => internal(()),
            }
        }
    };
    let Some(key) = projects.data_key(&p, wrapped.as_deref()) else { return internal(()) };
    let limit = q.limit.unwrap_or(DEFAULT_LOG_PAGE).clamp(1, MAX_LOG_PAGE);
    let rows = match sqlx::query("SELECT seq, size, inline_sealed, blob FROM sr_entries WHERE project = $1 AND seq > $2 AND seq <= $3 ORDER BY seq LIMIT $4").bind(&p).bind(q.after).bind(head).bind(limit).fetch_all(pool).await {
        Ok(rows) => rows,
        Err(e) => return internal(e),
    };
    let mut out = Vec::new();
    for r in rows {
        let seq: i64 = r.get(0);
        let (inline, blob_key): (Option<Vec<u8>>, Option<String>) = (r.get(2), r.get(3));
        if inline.is_none() && blob_key.is_none() {
            // The floor moved while this page was read.
            return lost(seq).await;
        }
        let Ok(sealed) = projects.read_body(inline, blob_key, r.get(1)).await else { return lost(seq).await };
        let Some(body) = open(&key, &item_ad(&p, "update", &seq.to_string()), &sealed) else { return internal(()) };
        if !out.is_empty() && out.len() + body.len() > MAX_LOG_PAGE_BYTES {
            break;
        }
        out.extend_from_slice(&(seq as u64).to_be_bytes());
        out.extend_from_slice(&(body.len() as u32).to_be_bytes());
        out.extend_from_slice(&body);
    }
    let mut response = (StatusCode::OK, log_headers(head, floor, snapshot), out).into_response();
    response.headers_mut().insert(header::CONTENT_TYPE, HeaderValue::from_static("application/octet-stream"));
    response
}
/// The latest snapshot: the whole Yjs state at `Scribyra-Snapshot-Seq`.
async fn snapshot(State(sr): State<Shared>, Path(p): Path<String>, headers: HeaderMap) -> Response {
    let (projects, caller) = match sr.caller(&headers).await {
        Ok(c) => c,
        Err(r) => return r,
    };
    if let Err(r) = sr.access(projects, &caller, &p).await {
        return r;
    }
    let pool = &projects.store.pool;
    let row = sqlx::query(
        "SELECT p.head_seq, p.floor_seq, p.data_key_wrapped, s.seq, s.size, s.inline_sealed, s.blob FROM sr_projects p JOIN sr_snapshots s USING (project)
         WHERE p.project = $1 AND p.deleted IS NULL ORDER BY s.seq DESC LIMIT 1",
    )
    .bind(&p)
    .fetch_optional(pool)
    .await;
    let row = match row {
        Ok(Some(row)) => row,
        Ok(None) => return error(StatusCode::NOT_FOUND, "no snapshot"),
        Err(e) => return internal(e),
    };
    let (head, floor, seq): (i64, i64, i64) = (row.get(0), row.get(1), row.get(3));
    let Some(key) = projects.data_key(&p, row.get::<Option<Vec<u8>>, _>(2).as_deref()) else { return internal(()) };
    let Ok(sealed) = projects.read_body(row.get(5), row.get(6), row.get(4)).await else {
        // A newer snapshot replaced this one (and its blob went) while it was read: `410`, so
        // the reader asks again (review L4).
        let newer: Result<Option<(i64, i64)>, _> = sqlx::query_as("SELECT p.floor_seq, max(s.seq) FROM sr_projects p JOIN sr_snapshots s USING (project) WHERE p.project = $1 AND p.deleted IS NULL GROUP BY p.floor_seq")
            .bind(&p)
            .fetch_optional(pool)
            .await;
        return match newer {
            Ok(Some((floor, latest))) if latest > seq => (StatusCode::GONE, log_headers(head, floor, latest), Json(json!({"error": "compacted", "floor": floor, "snapshot": latest}))).into_response(),
            _ => internal(()),
        };
    };
    let Some(state) = open(&key, &item_ad(&p, "snapshot", &seq.to_string()), &sealed) else { return internal(()) };
    let mut response = (StatusCode::OK, log_headers(head, floor, seq), state).into_response();
    response.headers_mut().insert(header::CONTENT_TYPE, HeaderValue::from_static("application/octet-stream"));
    response
}
async fn put_object(State(sr): State<Shared>, Path((p, hash)): Path<(String, String)>, headers: HeaderMap, body: Body) -> Response {
    let (projects, caller) = match sr.caller(&headers).await {
        Ok(c) => c,
        Err(r) => return r,
    };
    let access = match sr.access(projects, &caller, &p).await {
        Ok(a) => a,
        Err(r) => return r,
    };
    if !access.writes() {
        return error(StatusCode::FORBIDDEN, "only the owner and editors can change this project");
    }
    if !blob::valid_hash(&hash) {
        return error(StatusCode::BAD_REQUEST, "invalid object hash");
    }
    let Ok(_slot) = sr.uploads.clone().try_acquire_owned() else { return error(StatusCode::SERVICE_UNAVAILABLE, "too many uploads") };
    let Ok(bytes) = to_bytes(body, projects.store.config.sr_object_bytes).await else { return error(StatusCode::PAYLOAD_TOO_LARGE, "object too large") };
    if !blob::verify(&hash, &bytes) {
        return error(StatusCode::BAD_REQUEST, "the body does not match its SHA-256");
    }
    match projects.put_object(&p, &hash, &bytes).await {
        Ok(true) => StatusCode::CREATED.into_response(),
        Ok(false) => StatusCode::NO_CONTENT.into_response(),
        Err(e) => append_response(Err(e)),
    }
}
async fn get_object(State(sr): State<Shared>, Path((p, hash)): Path<(String, String)>, headers: HeaderMap) -> Response {
    let (projects, caller) = match sr.caller(&headers).await {
        Ok(c) => c,
        Err(r) => return r,
    };
    if let Err(r) = sr.access(projects, &caller, &p).await {
        return r;
    }
    if !blob::valid_hash(&hash) {
        return error(StatusCode::BAD_REQUEST, "invalid object hash");
    }
    match projects.object(&p, &hash).await {
        Ok(Some(bytes)) => ([(header::CONTENT_TYPE, "application/octet-stream"), (header::CACHE_CONTROL, "no-store"), (header::X_CONTENT_TYPE_OPTIONS, "nosniff")], bytes).into_response(),
        Ok(None) => error(StatusCode::NOT_FOUND, "unknown object"),
        Err(e) => internal(e),
    }
}

fn valid_email(text: &str) -> bool {
    text.len() <= 254 && text.split_once('@').is_some_and(|(local, domain)| !local.is_empty() && domain.contains('.') && !domain.contains('@') && !domain.starts_with('.') && !domain.ends_with('.')) && !text.chars().any(|c| c.is_whitespace() || c.is_control())
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Invite {
    email: String,
    role: String,
}
/// Shares at once with every active account whose verified email this is at a provider that
/// counts for it (`200` when the share existed, `201` when new), or records a pending invitation
/// that the first such sign-in accepts (`201`, `status: "pending"`). `email` is `provider:email`
/// (that provider's accounts only) or a plain email: then any provider whose `email_domains`
/// vouch for its domain, or the deployment's only provider; with several providers and none
/// vouching, the inviter must name one (`400`). Review H2.
async fn invite(State(sr): State<Shared>, Path(p): Path<String>, headers: HeaderMap, Json(request): Json<Invite>) -> Response {
    let (projects, caller) = match sr.caller(&headers).await {
        Ok(c) => c,
        Err(r) => return r,
    };
    let access = match sr.access(projects, &caller, &p).await {
        Ok(a) => a,
        Err(r) => return r,
    };
    if let Err(r) = Sr::may_share(&caller, access) {
        return r;
    }
    let Some(deployment) = projects.store.config.deployment.as_ref() else { return internal(()) };
    let text = request.email.trim();
    let (named, email) = match text.split_once(':') {
        Some((id, email)) => match deployment.provider(id) {
            Some(provider) => (Some(provider), crate::sso::normalise_email(email)),
            None => return error(StatusCode::BAD_REQUEST, "unknown provider"),
        },
        None => (None, crate::sso::normalise_email(text)),
    };
    if !valid_email(&email) || Access::share(&request.role).is_none() {
        return error(StatusCode::BAD_REQUEST, "invalid email or role");
    }
    // The providers whose accounts this email names, and the one the invitation records.
    let (providers, recorded): (Vec<String>, Option<String>) = match named {
        Some(provider) => (vec![provider.id.clone()], Some(provider.id.clone())),
        None => {
            let vouching: Vec<String> = deployment.providers.iter().filter(|d| crate::sso::vouches(d, &email)).map(|d| d.id.clone()).collect();
            match (vouching.is_empty(), deployment.providers.as_slice()) {
                (false, _) => (vouching, None),
                (true, [only]) => (vec![only.id.clone()], Some(only.id.clone())),
                (true, _) => return error(StatusCode::BAD_REQUEST, "no provider vouches for this email's domain: name one as provider:email"),
            }
        }
    };
    let days = projects.store.config.sr_invitation_days as f64;
    let done = async {
        let mut tx = projects.store.pool.begin().await?;
        let owner: String = sqlx::query_scalar("SELECT owner FROM sr_projects WHERE project = $1 AND deleted IS NULL FOR UPDATE").bind(&p).fetch_one(&mut *tx).await?;
        let accounts: Vec<String> = sqlx::query_scalar("SELECT account FROM accounts WHERE email = $1 AND email_verified AND state = 'active' AND provider = ANY($2) ORDER BY account")
            .bind(&email)
            .bind(&providers)
            .fetch_all(&mut *tx)
            .await?;
        let others: Vec<&String> = accounts.iter().filter(|a| **a != owner).collect();
        let outcome = if !accounts.is_empty() {
            let mut fresh = false;
            for account in &others {
                let inserted: bool = sqlx::query_scalar(
                    "INSERT INTO sr_shares (project, account, role, created_by) VALUES ($1, $2, $3, $4)
                     ON CONFLICT (project, account) DO UPDATE SET role = EXCLUDED.role RETURNING (xmax = 0)",
                )
                .bind(&p)
                .bind(account)
                .bind(&request.role)
                .bind(&caller.account)
                .fetch_one(&mut *tx)
                .await?;
                fresh |= inserted;
                notify_account(&mut tx, account).await?;
            }
            sqlx::query("UPDATE sr_invitations SET state = 'accepted' WHERE project = $1 AND email = $2 AND state = 'pending'").bind(&p).bind(&email).execute(&mut *tx).await?;
            (if fresh { StatusCode::CREATED } else { StatusCode::OK }, json!({"status": if others.is_empty() { "owner" } else { "shared" }}))
        } else {
            let (id, expires): (String, i64) = sqlx::query_as(
                "INSERT INTO sr_invitations (invitation, project, email, role, created_by, expires, provider) VALUES ($1, $2, $3, $4, $5, now() + make_interval(days => $6::int), $7)
                 ON CONFLICT (project, email) WHERE state = 'pending' DO UPDATE SET role = EXCLUDED.role, created_by = EXCLUDED.created_by, expires = EXCLUDED.expires, provider = EXCLUDED.provider
                 RETURNING invitation, (extract(epoch FROM expires) * 1000)::bigint",
            )
            .bind(random_hex())
            .bind(&p)
            .bind(&email)
            .bind(&request.role)
            .bind(&caller.account)
            .bind(days as i32)
            .bind(&recorded)
            .fetch_one(&mut *tx)
            .await?;
            (StatusCode::CREATED, json!({"status": "pending", "invitation": {"id": id, "email": email, "provider": recorded, "role": request.role, "expires": expires}}))
        };
        notify(&mut tx, &p).await?;
        tx.commit().await?;
        Ok::<_, sqlx::Error>(outcome)
    };
    let (status, mut body) = match done.await {
        Ok(v) => v,
        Err(e) => return internal(e),
    };
    if body["status"] == "owner" {
        return error(StatusCode::CONFLICT, "that is the project's owner");
    }
    match sr.details(projects, &caller, &p, access).await {
        Ok(details) => {
            body["project"] = details;
            ok_json(status, body)
        }
        Err(r) => r,
    }
}
async fn withdraw(State(sr): State<Shared>, Path((p, invitation)): Path<(String, String)>, headers: HeaderMap) -> Response {
    let (projects, caller) = match sr.caller(&headers).await {
        Ok(c) => c,
        Err(r) => return r,
    };
    let access = match sr.access(projects, &caller, &p).await {
        Ok(a) => a,
        Err(r) => return r,
    };
    if let Err(r) = Sr::may_share(&caller, access) {
        return r;
    }
    let done = async {
        let mut tx = projects.store.pool.begin().await?;
        let n = sqlx::query("UPDATE sr_invitations SET state = 'withdrawn' WHERE invitation = $1 AND project = $2 AND state = 'pending'").bind(&invitation).bind(&p).execute(&mut *tx).await?.rows_affected();
        notify(&mut tx, &p).await?;
        tx.commit().await?;
        Ok::<_, sqlx::Error>(n)
    };
    match done.await {
        Ok(0) => error(StatusCode::NOT_FOUND, "unknown invitation"),
        Ok(_) => StatusCode::NO_CONTENT.into_response(),
        Err(e) => internal(e),
    }
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ChangeRole {
    role: String,
}
async fn change_member(State(sr): State<Shared>, Path((p, account)): Path<(String, String)>, headers: HeaderMap, Json(request): Json<ChangeRole>) -> Response {
    let (projects, caller) = match sr.caller(&headers).await {
        Ok(c) => c,
        Err(r) => return r,
    };
    let access = match sr.access(projects, &caller, &p).await {
        Ok(a) => a,
        Err(r) => return r,
    };
    if let Err(r) = Sr::may_share(&caller, access) {
        return r;
    }
    if Access::share(&request.role).is_none() {
        return error(StatusCode::BAD_REQUEST, "invalid role");
    }
    let done = async {
        let mut tx = projects.store.pool.begin().await?;
        let n = sqlx::query("UPDATE sr_shares SET role = $3 WHERE project = $1 AND account = $2").bind(&p).bind(&account).bind(&request.role).execute(&mut *tx).await?.rows_affected();
        notify(&mut tx, &p).await?;
        tx.commit().await?;
        Ok::<_, sqlx::Error>(n)
    };
    match done.await {
        Ok(0) => error(StatusCode::NOT_FOUND, "not a member of this project"),
        Ok(_) => match sr.details(projects, &caller, &p, access).await {
            Ok(details) => ok_json(StatusCode::OK, details),
            Err(r) => r,
        },
        Err(e) => internal(e),
    }
}
/// Removes a share: owners and editors remove others; anyone but the owner may leave.
async fn remove_member(State(sr): State<Shared>, Path((p, account)): Path<(String, String)>, headers: HeaderMap) -> Response {
    let (projects, caller) = match sr.caller(&headers).await {
        Ok(c) => c,
        Err(r) => return r,
    };
    let access = match sr.access(projects, &caller, &p).await {
        Ok(a) => a,
        Err(r) => return r,
    };
    if account == caller.account {
        if access == Access::Owner {
            return error(StatusCode::CONFLICT, "the owner cannot leave; transfer the project or delete it");
        }
    } else if let Err(r) = Sr::may_share(&caller, access) {
        return r;
    }
    let done = async {
        let mut tx = projects.store.pool.begin().await?;
        let n = sqlx::query("DELETE FROM sr_shares WHERE project = $1 AND account = $2").bind(&p).bind(&account).execute(&mut *tx).await?.rows_affected();
        notify(&mut tx, &p).await?;
        tx.commit().await?;
        Ok::<_, sqlx::Error>(n)
    };
    match done.await {
        Ok(0) => error(StatusCode::NOT_FOUND, "not a member of this project"),
        Ok(_) => StatusCode::NO_CONTENT.into_response(),
        Err(e) => internal(e),
    }
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Transfer {
    account: String,
}
/// The owner hands the project to a member who is not a guest; the old owner becomes an editor.
async fn transfer(State(sr): State<Shared>, Path(p): Path<String>, headers: HeaderMap, Json(request): Json<Transfer>) -> Response {
    let (projects, caller) = match sr.caller(&headers).await {
        Ok(c) => c,
        Err(r) => return r,
    };
    match sr.access(projects, &caller, &p).await {
        Ok(Access::Owner) => {}
        Ok(_) => return error(StatusCode::FORBIDDEN, "only the owner can transfer this project"),
        Err(r) => return r,
    }
    let done = async {
        let mut tx = projects.store.pool.begin().await?;
        let target: Option<String> = sqlx::query_scalar("SELECT a.role FROM sr_shares s JOIN accounts a USING (account) WHERE s.project = $1 AND s.account = $2 AND a.state = 'active' FOR UPDATE OF s").bind(&p).bind(&request.account).fetch_optional(&mut *tx).await?;
        match target.as_deref() {
            None => return Ok(Err(error(StatusCode::NOT_FOUND, "not a member of this project"))),
            Some("guest") => return Ok(Err(error(StatusCode::CONFLICT, "guests cannot own projects"))),
            _ => {}
        }
        sqlx::query("DELETE FROM sr_shares WHERE project = $1 AND account = $2").bind(&p).bind(&request.account).execute(&mut *tx).await?;
        sqlx::query("UPDATE sr_projects SET owner = $2, updated = now() WHERE project = $1").bind(&p).bind(&request.account).execute(&mut *tx).await?;
        sqlx::query("INSERT INTO sr_shares (project, account, role, created_by) VALUES ($1, $2, 'editor', $2)").bind(&p).bind(&caller.account).execute(&mut *tx).await?;
        notify(&mut tx, &p).await?;
        tx.commit().await?;
        Ok::<_, sqlx::Error>(Ok(()))
    };
    match done.await {
        Ok(Ok(())) => match sr.details(projects, &caller, &p, Access::Editor).await {
            Ok(details) => ok_json(StatusCode::OK, details),
            Err(r) => r,
        },
        Ok(Err(r)) => r,
        Err(e) => internal(e),
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct HeadsQuery {
    #[serde(default)]
    since: Option<String>,
    #[serde(default)]
    wait: u64,
}
/// A notice, not a delivery: the caller's projects with head, role and name, and a `version`.
/// With `since` equal to the current version it waits (up to `wait` seconds, at most 25) until
/// something the caller can see changes, on any replica. Ends at once when the service stops.
/// Only notices for the caller's projects or account wake it; an account keeps at most
/// [`MAX_POLLS_PER_ACCOUNT`] waiting per replica, and a further one ends the oldest at once
/// (`superseded: true`).
async fn heads(State(sr): State<Shared>, Query(q): Query<HeadsQuery>, headers: HeaderMap) -> Response {
    let (projects, caller) = match sr.caller(&headers).await {
        Ok(c) => c,
        Err(r) => return r,
    };
    let deadline = tokio::time::Instant::now() + Duration::from_secs(q.wait.min(MAX_HEADS_WAIT_SECS));
    let (id, wake) = sr.polls.lock().unwrap().register(&caller.account);
    let _registered = PollGuard(&sr, id);
    let mut shutdown = sr.shutdown.clone();
    let mut woken = false;
    loop {
        // A revocation notifies the account's polls: each checks that its session still holds
        // (review L6).
        if std::mem::take(&mut woken) {
            match crate::sso::bearer(&headers).map(|t| sr.sso.login(t)) {
                Some(login) => match login.await {
                    Ok(Some(_)) => {}
                    Ok(None) => return error(StatusCode::UNAUTHORIZED, "sign in required"),
                    Err(e) => return internal(e),
                },
                None => return error(StatusCode::UNAUTHORIZED, "sign in required"),
            }
        }
        let (version, heads) = match sr.heads_now(projects, &caller).await {
            Ok(v) => v,
            Err(r) => return r,
        };
        let (added, superseded) = {
            let mut polls = sr.polls.lock().unwrap();
            (polls.watch(id, heads.as_object().map(|m| m.keys()).into_iter().flatten()), polls.superseded(id))
        };
        if q.since.as_deref() != Some(version.as_str()) || *shutdown.borrow() || tokio::time::Instant::now() >= deadline || superseded {
            let mut body = json!({"version": version, "projects": heads});
            if superseded {
                body["superseded"] = json!(true);
            }
            return ok_json(StatusCode::OK, body);
        }
        // A project just added to the watch could have changed between the query and the
        // watch: look once more before waiting.
        if added {
            continue;
        }
        tokio::select! {
            _ = wake.notified() => woken = true,
            _ = shutdown.changed() => {}
            _ = tokio::time::sleep_until(deadline) => {}
        }
    }
}

/// The server-readable routes; merged into [`crate::service::router`].
pub fn routes(sr: Shared) -> Router {
    Router::new()
        .route("/v1/sr/projects", get(list).post(create))
        .route("/v1/sr/projects/{project}", get(project).patch(rename).delete(delete_project))
        .route("/v1/sr/projects/{project}/log", get(read_log).post(append))
        .route("/v1/sr/projects/{project}/snapshot", get(snapshot))
        .route("/v1/sr/projects/{project}/objects/{hash}", get(get_object).put(put_object))
        .route("/v1/sr/projects/{project}/invitations", post(invite))
        .route("/v1/sr/projects/{project}/invitations/{invitation}", axum::routing::delete(withdraw))
        .route("/v1/sr/projects/{project}/members/{account}", put(change_member).delete(remove_member))
        .route("/v1/sr/projects/{project}/owner", post(transfer))
        .route("/v1/sr/heads", get(heads))
        .with_state(sr)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn polls_wake_only_for_their_projects_and_accounts() {
        let mut polls = Polls::default();
        let (a, wake_a) = polls.register("ana");
        let (b, _) = polls.register("ben");
        let (p, q) = ("p".repeat(64), "q".repeat(64));
        assert!(polls.watch(a, [&p, &q]));
        assert!(!polls.watch(a, [&p, &q]));
        assert!(polls.watch(b, [&q]));
        // A notice for a project wakes only the polls that can see it; another account's notice
        // wakes nobody else.
        assert_eq!(polls.route(&p), 1);
        assert_eq!(polls.route(&q), 2);
        assert_eq!(polls.route(&"r".repeat(64)), 0);
        assert_eq!(polls.route("a:ben"), 1);
        assert_eq!(polls.route("a:cat"), 0);
        // The stored permit means a wake-up between looking and waiting is not lost.
        assert!(futures_util::FutureExt::now_or_never(wake_a.notified()).is_some());
        // Watching fewer projects stops their wake-ups; removing a poll unindexes it.
        polls.watch(a, [&q]);
        assert_eq!(polls.route(&p), 0);
        polls.remove(b);
        assert_eq!((polls.route(&q), polls.route("a:ben"), polls.len()), (1, 0, 1));
        polls.remove(a);
        assert!(polls.is_empty() && polls.by_project.is_empty() && polls.by_account.is_empty());
    }

    #[test]
    fn an_account_keeps_at_most_four_polls_and_the_oldest_gives_way() {
        let mut polls = Polls::default();
        let ids: Vec<u64> = (0..MAX_POLLS_PER_ACCOUNT).map(|_| polls.register("ana").0).collect();
        assert!(ids.iter().all(|id| !polls.superseded(*id)));
        let (other, _) = polls.register("ben");
        let (fifth, _) = polls.register("ana");
        assert!(polls.superseded(ids[0]) && !polls.superseded(ids[1]) && !polls.superseded(fifth) && !polls.superseded(other));
        // The superseded one stays until its request ends; a sixth then ends the next oldest.
        polls.register("ana");
        assert!(polls.superseded(ids[1]) && !polls.superseded(ids[2]));
    }
}
