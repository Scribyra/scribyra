//! Organisation routes (org-sync slice 1): device-key sign-in, the signed membership
//! log, key wraps and encrypted append-only project logs. The service checks every
//! signature and membership rule with the same Rust code as the browser
//! (`scribyra_core::orgsync`) but never holds a project key or decrypts anything.
use crate::store::{GLOBAL_SCOPE, Store, StoreError};
use crate::blobs::{BlobKey, Bytes};
use axum::{
    Json, Router,
    body::{Body, to_bytes},
    extract::{Path, Query, State},
    http::{HeaderMap, StatusCode, header},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use scribyra_core::orgsync::{self as core, KeyRole, OrgState};
use serde::Deserialize;
use sqlx::Row;
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

const CHALLENGE_SECONDS: u64 = 60;
const SESSION_SECONDS: u64 = 12 * 3600;
const MAX_CHALLENGES: usize = 4096;
const MAX_CHALLENGES_PER_ORG: usize = 64;
const MAX_SESSIONS_PER_KEY: usize = 8;
const MAX_CACHED_ORGS: usize = 1024;
const MAX_WRAPS_PER_ORG: i64 = 100_000;
const MAX_WRAPS_PER_REQUEST: usize = 64;
const MAX_LOG_PAGE: i64 = 256;
const MAX_EVENT_PAGE: i64 = 1000;
const MAX_LOG_PAGE_BYTES: usize = 16 * 1024 * 1024;

pub struct Orgs {
    store: Arc<Store>,
    public_url: Option<String>,
    challenges: Mutex<HashMap<String, (String, Instant)>>,
    sessions: Mutex<HashMap<String, Session>>,
    states: Mutex<HashMap<String, Arc<tokio::sync::Mutex<Option<OrgState>>>>>,
}
#[derive(Clone)]
struct Session {
    org: String,
    key: String,
    until: Instant,
}
type Shared = Arc<Orgs>;

fn error(status: StatusCode, message: &'static str) -> Response {
    (status, Json(serde_json::json!({"error": message}))).into_response()
}
fn store_error(e: StoreError) -> Response {
    match e {
        StoreError::Quota => error(StatusCode::INSUFFICIENT_STORAGE, "quota"),
        other => other.status().into_response(),
    }
}
fn internal<E>(_: E) -> Response {
    StatusCode::INTERNAL_SERVER_ERROR.into_response()
}
fn random_hex() -> String {
    let mut bytes = [0u8; 32];
    getrandom::fill(&mut bytes).expect("operating system randomness");
    core::hex(&bytes)
}
pub fn org_scope(org: &str) -> String {
    format!("org:{org}")
}
pub fn entry_key(project: &str, hash: &str) -> Result<BlobKey, StoreError> {
    BlobKey::new(format!("entries/{project}/{hash}")).map_err(|_| StoreError::BadRequest)
}

impl Orgs {
    pub fn new(store: Arc<Store>) -> Shared {
        let public_url = store.config.public_url.clone();
        Arc::new(Self { store, public_url, challenges: Mutex::default(), sessions: Mutex::default(), states: Mutex::default() })
    }
    /// The per-organisation state slot. Only existing organisations get one, and the cache
    /// drops idle entries (no handler holds them) once it is full.
    async fn slot(&self, org: &str) -> Result<Arc<tokio::sync::Mutex<Option<OrgState>>>, Response> {
        if !core::is_hex(org, 32) {
            return Err(error(StatusCode::BAD_REQUEST, "invalid organisation"));
        }
        if let Some(slot) = self.states.lock().unwrap().get(org) {
            return Ok(slot.clone());
        }
        let exists: Option<i32> = sqlx::query_scalar("SELECT 1 FROM orgs WHERE org = $1").bind(org).fetch_optional(&self.store.pool).await.map_err(internal)?;
        if exists.is_none() {
            return Err(error(StatusCode::NOT_FOUND, "unknown organisation"));
        }
        let mut states = self.states.lock().unwrap();
        if states.len() >= MAX_CACHED_ORGS {
            states.retain(|_, slot| Arc::strong_count(slot) > 1);
        }
        Ok(states.entry(org.to_string()).or_default().clone())
    }
    /// Loads (once) and returns the replayed membership state of an existing org.
    async fn state<'a>(&self, guard: &'a mut tokio::sync::MutexGuard<'_, Option<OrgState>>, org: &str) -> Result<&'a mut OrgState, Response> {
        if guard.is_none() {
            let enrol: Option<String> = sqlx::query_scalar("SELECT enrol FROM orgs WHERE org = $1")
                .bind(org)
                .fetch_optional(&self.store.pool)
                .await
                .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response())?;
            let Some(enrol) = enrol else { return Err(error(StatusCode::NOT_FOUND, "unknown organisation")) };
            let mut state = OrgState::new(org).map_err(|_| StatusCode::BAD_REQUEST.into_response())?;
            let rows = sqlx::query("SELECT raw FROM org_events WHERE org = $1 ORDER BY seq")
                .bind(org)
                .fetch_all(&self.store.pool)
                .await
                .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response())?;
            for row in rows {
                let raw: String = row.get(0);
                // Stored events were validated on append; a failure here means tampering.
                state.apply(&raw, Some(&enrol)).map_err(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response())?;
            }
            state.enrol = Some(enrol);
            **guard = Some(state);
        }
        Ok(guard.as_mut().unwrap())
    }
    fn session(&self, headers: &HeaderMap) -> Result<Session, Response> {
        let token = headers
            .get(header::AUTHORIZATION)
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.strip_prefix("Scribyra "))
            .filter(|t| core::is_hex(t, 32))
            .ok_or_else(|| error(StatusCode::UNAUTHORIZED, "sign in required"))?;
        let digest = core::hex(&core::sha256(token.as_bytes()));
        let mut sessions = self.sessions.lock().unwrap();
        match sessions.get(&digest) {
            Some(s) if s.until > Instant::now() => Ok(s.clone()),
            Some(_) => {
                sessions.remove(&digest);
                Err(error(StatusCode::UNAUTHORIZED, "session expired"))
            }
            None => Err(error(StatusCode::UNAUTHORIZED, "sign in required")),
        }
    }
    /// The session's current role in its org; refuses keys that are no longer active.
    fn role(state: &OrgState, session: &Session) -> Result<KeyRole, Response> {
        state.key_role(&session.key).ok_or_else(|| error(StatusCode::FORBIDDEN, "key is not active"))
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ChallengeRequest {
    org: String,
}
async fn challenge(State(o): State<Shared>, Json(request): Json<ChallengeRequest>) -> Response {
    if !core::is_hex(&request.org, 32) {
        return error(StatusCode::BAD_REQUEST, "invalid organisation");
    }
    if let Err(r) = o.slot(&request.org).await {
        return r;
    }
    let challenge = random_hex();
    let mut challenges = o.challenges.lock().unwrap();
    let now = Instant::now();
    challenges.retain(|_, (_, until)| *until > now);
    if challenges.len() >= MAX_CHALLENGES || challenges.values().filter(|(org, _)| *org == request.org).count() >= MAX_CHALLENGES_PER_ORG {
        return error(StatusCode::SERVICE_UNAVAILABLE, "too many sign-ins in progress");
    }
    challenges.insert(challenge.clone(), (request.org, now + Duration::from_secs(CHALLENGE_SECONDS)));
    Json(serde_json::json!({"challenge": challenge})).into_response()
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct SessionRequest {
    org: String,
    key: String,
    challenge: String,
    sig: String,
}
async fn session(State(o): State<Shared>, Json(request): Json<SessionRequest>) -> Response {
    let Some(public_url) = o.public_url.clone() else {
        return error(StatusCode::NOT_FOUND, "organisations are not enabled on this service");
    };
    // Single use: the challenge is consumed whether or not the signature verifies.
    let issued = o.challenges.lock().unwrap().remove(&request.challenge);
    let Some((org, until)) = issued else { return error(StatusCode::UNAUTHORIZED, "unknown challenge") };
    if org != request.org || until <= Instant::now() {
        return error(StatusCode::UNAUTHORIZED, "unknown challenge");
    }
    let message = format!("scribyra-auth/1\n{public_url}\n{org}\n{}\n{}", request.key, request.challenge);
    if !core::ed25519_verify(&request.key, message.as_bytes(), &request.sig) {
        return error(StatusCode::UNAUTHORIZED, "invalid signature");
    }
    let slot = match o.slot(&org).await {
        Ok(slot) => slot,
        Err(r) => return r,
    };
    let mut guard = slot.lock().await;
    let state = match o.state(&mut guard, &org).await {
        Ok(s) => s,
        Err(r) => return r,
    };
    let (person, role) = match state.key_role(&request.key) {
        Some(KeyRole::Device { person }) => (person, "device"),
        Some(KeyRole::Recovery { person }) => (person, "recovery"),
        None => return error(StatusCode::FORBIDDEN, "key is not active"),
    };
    let token = random_hex();
    let mut sessions = o.sessions.lock().unwrap();
    let now = Instant::now();
    sessions.retain(|_, s| s.until > now);
    // One key holds a few sessions at most; its oldest makes room for a new one.
    let mine: Vec<(String, Instant)> = sessions.iter().filter(|(_, s)| s.key == request.key && s.org == org).map(|(k, s)| (k.clone(), s.until)).collect();
    if mine.len() >= MAX_SESSIONS_PER_KEY {
        if let Some((oldest, _)) = mine.iter().min_by_key(|(_, until)| *until) {
            sessions.remove(oldest);
        }
    }
    if sessions.len() >= o.store.config.sessions {
        return error(StatusCode::SERVICE_UNAVAILABLE, "too many sessions");
    }
    sessions.insert(core::hex(&core::sha256(token.as_bytes())), Session { org, key: request.key, until: now + Duration::from_secs(SESSION_SECONDS) });
    Json(serde_json::json!({"token": token, "expires": SESSION_SECONDS, "person": person, "role": role})).into_response()
}

#[derive(Deserialize)]
struct After {
    #[serde(default)]
    after: i64,
    #[serde(default)]
    limit: Option<i64>,
}
/// One page of the membership log after `after`, with the log's length so clients know
/// whether to read on.
async fn events(State(o): State<Shared>, Path(org): Path<String>, Query(q): Query<After>, headers: HeaderMap) -> Response {
    let session = match o.session(&headers) {
        Ok(s) => s,
        Err(r) => return r,
    };
    if session.org != org || q.after < 0 {
        return error(StatusCode::FORBIDDEN, "wrong organisation");
    }
    let count = {
        let slot = match o.slot(&org).await {
            Ok(slot) => slot,
            Err(r) => return r,
        };
        let mut guard = slot.lock().await;
        match o.state(&mut guard, &org).await {
            Ok(state) => {
                if let Err(r) = Orgs::role(state, &session) {
                    return r;
                }
                state.count as i64
            }
            Err(r) => return r,
        }
    };
    let limit = q.limit.unwrap_or(MAX_EVENT_PAGE).clamp(1, MAX_EVENT_PAGE);
    let rows = sqlx::query("SELECT raw FROM org_events WHERE org = $1 AND seq > $2 AND seq <= $3 ORDER BY seq LIMIT $4")
        .bind(&org)
        .bind(q.after)
        .bind(count)
        .bind(limit)
        .fetch_all(&o.store.pool)
        .await;
    match rows {
        Ok(rows) => Json(serde_json::json!({"events": rows.iter().map(|r| r.get::<String, _>(0)).collect::<Vec<_>>(), "count": count})).into_response(),
        Err(_) => StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    }
}
async fn append_event(State(o): State<Shared>, Path(org): Path<String>, headers: HeaderMap, body: Body) -> Response {
    let Ok(bytes) = to_bytes(body, core::MAX_EVENT_BYTES).await else {
        return error(StatusCode::PAYLOAD_TOO_LARGE, "event too large");
    };
    let Ok(raw) = String::from_utf8(bytes.to_vec()) else { return error(StatusCode::BAD_REQUEST, "invalid event") };
    let Ok(value) = serde_json::from_str::<serde_json::Value>(&raw) else { return error(StatusCode::BAD_REQUEST, "invalid event") };
    let kind = value.get("type").and_then(|v| v.as_str()).unwrap_or_default().to_string();
    let signer = value.get("signer").and_then(|v| v.as_str()).unwrap_or_default().to_string();
    let slot = match o.slot(&org).await {
        Ok(slot) => slot,
        Err(r) => return r,
    };
    let mut guard = slot.lock().await;
    let state = match o.state(&mut guard, &org).await {
        Ok(s) => s,
        Err(r) => return r,
    };
    if state.genesis.is_none() {
        // The setup code's signature inside genesis authenticates the first event.
        if kind != "genesis" {
            return error(StatusCode::CONFLICT, "the organisation has no genesis yet");
        }
    } else {
        let session = match o.session(&headers) {
            Ok(s) => s,
            Err(r) => return r,
        };
        let role = match Orgs::role(state, &session) {
            Ok(r) => r,
            Err(r) => return r,
        };
        if session.org != org || session.key != signer || (matches!(role, KeyRole::Recovery { .. }) && kind != "device.add") {
            return error(StatusCode::FORBIDDEN, "this session cannot sign that event");
        }
    }
    let mut next = state.clone();
    let enrol = state.enrol.clone();
    let hash = match next.apply(&raw, enrol.as_deref()) {
        Ok(hash) => hash,
        Err(e) if e.0 == "membership event does not follow the current head" || e.0 == "the organisation already has a genesis" => return error(StatusCode::CONFLICT, e.0),
        Err(e) => return error(StatusCode::BAD_REQUEST, e.0),
    };
    let result = async {
        let mut tx = o.store.pool.begin().await?;
        sqlx::query("INSERT INTO org_events (org, seq, hash, raw) VALUES ($1, $2, $3, $4)")
            .bind(&org)
            .bind(next.count as i64)
            .bind(&hash)
            .bind(&raw)
            .execute(&mut *tx)
            .await?;
        // A replaced recovery kit or device agreement key must not keep opening project
        // keys: drop every wrap addressed to a key the event retired.
        let retired: Vec<String> = state.agreement_keys().difference(&next.agreement_keys()).cloned().collect();
        if !retired.is_empty() {
            sqlx::query("DELETE FROM wraps WHERE org = $1 AND recipient = ANY($2)").bind(&org).bind(&retired).execute(&mut *tx).await?;
        }
        if kind == "project.create" {
            let project = value["body"]["project"].as_str().unwrap_or_default();
            sqlx::query("INSERT INTO projects (project, org, epoch, head_chain) VALUES ($1, $2, 1, $1)")
                .bind(project)
                .bind(&org)
                .execute(&mut *tx)
                .await?;
        }
        tx.commit().await
    }
    .await;
    if result.is_err() {
        // The commit may have happened; reload from the database next time.
        *guard = None;
        return StatusCode::INTERNAL_SERVER_ERROR.into_response();
    }
    let seq = next.count;
    *guard = Some(next);
    (StatusCode::CREATED, Json(serde_json::json!({"seq": seq, "hash": hash}))).into_response()
}

async fn put_wraps(State(o): State<Shared>, Path(org): Path<String>, headers: HeaderMap, body: Body) -> Response {
    let session = match o.session(&headers) {
        Ok(s) => s,
        Err(r) => return r,
    };
    let Ok(bytes) = to_bytes(body, MAX_WRAPS_PER_REQUEST * (core::MAX_WRAP_BYTES + 8) + 2).await else {
        return error(StatusCode::PAYLOAD_TOO_LARGE, "too many wraps");
    };
    let Ok(wraps) = serde_json::from_slice::<Vec<String>>(&bytes) else { return error(StatusCode::BAD_REQUEST, "invalid wraps") };
    if session.org != org || wraps.is_empty() || wraps.len() > MAX_WRAPS_PER_REQUEST {
        return error(StatusCode::BAD_REQUEST, "invalid wraps");
    }
    let checked = {
        let slot = match o.slot(&org).await {
        Ok(slot) => slot,
        Err(r) => return r,
    };
        let mut guard = slot.lock().await;
        let state = match o.state(&mut guard, &org).await {
            Ok(s) => s,
            Err(r) => return r,
        };
        if !matches!(Orgs::role(state, &session), Ok(KeyRole::Device { .. })) {
            return error(StatusCode::FORBIDDEN, "only a device can publish keys");
        }
        let mut checked = Vec::new();
        for raw in &wraps {
            match core::check_wrap(state, raw) {
                Ok(w) if w.sender == session.key => checked.push((w, raw.clone())),
                Ok(_) => return error(StatusCode::FORBIDDEN, "wraps must be signed by this device"),
                Err(e) => return error(StatusCode::BAD_REQUEST, e.0),
            }
        }
        checked
    };
    let stored: i64 = match sqlx::query_scalar("SELECT count(*) FROM wraps WHERE org = $1").bind(&org).fetch_one(&o.store.pool).await {
        Ok(n) => n,
        Err(_) => return StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    };
    if stored + checked.len() as i64 > MAX_WRAPS_PER_ORG {
        return error(StatusCode::INSUFFICIENT_STORAGE, "quota");
    }
    let result = async {
        let mut tx = o.store.pool.begin().await?;
        for (w, raw) in &checked {
            sqlx::query("INSERT INTO wraps (org, project, epoch, recipient, raw) VALUES ($1, $2, $3, $4, $5) ON CONFLICT (org, project, epoch, recipient) DO UPDATE SET raw = EXCLUDED.raw, received = now()")
                .bind(&org)
                .bind(&w.project)
                .bind(w.epoch as i32)
                .bind(&w.recipient)
                .bind(raw)
                .execute(&mut *tx)
                .await?;
        }
        tx.commit().await
    }
    .await;
    match result {
        Ok(()) => StatusCode::NO_CONTENT.into_response(),
        Err(_) => StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    }
}
async fn get_wraps(State(o): State<Shared>, Path(org): Path<String>, headers: HeaderMap) -> Response {
    let session = match o.session(&headers) {
        Ok(s) => s,
        Err(r) => return r,
    };
    if session.org != org {
        return error(StatusCode::FORBIDDEN, "wrong organisation");
    }
    let recipients = {
        let slot = match o.slot(&org).await {
        Ok(slot) => slot,
        Err(r) => return r,
    };
        let mut guard = slot.lock().await;
        let state = match o.state(&mut guard, &org).await {
            Ok(s) => s,
            Err(r) => return r,
        };
        let Ok(KeyRole::Device { person }) = Orgs::role(state, &session) else {
            return error(StatusCode::FORBIDDEN, "only a device can read keys");
        };
        // This device's own key, and the person's recovery key (so a newly enrolled
        // device can restore). Never another person's wraps.
        let mut keys = vec![state.devices[&session.key].agreement.clone()];
        if let Some(r) = state.persons.get(&person).and_then(|p| p.recovery_agreement.clone()) {
            keys.push(r);
        }
        keys
    };
    let rows = sqlx::query("SELECT raw FROM wraps WHERE org = $1 AND recipient = ANY($2) ORDER BY project, epoch LIMIT 10000")
        .bind(&org)
        .bind(&recipients)
        .fetch_all(&o.store.pool)
        .await;
    match rows {
        Ok(rows) => Json(serde_json::json!({"wraps": rows.iter().map(|r| r.get::<String, _>(0)).collect::<Vec<_>>()})).into_response(),
        Err(_) => StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    }
}

/// Checks the session may use this project's log; returns its org and current epoch.
async fn project_access(o: &Orgs, session: &Session, project: &str) -> Result<u32, Response> {
    let slot = o.slot(&session.org).await?;
    let mut guard = slot.lock().await;
    let state = o.state(&mut guard, &session.org).await?;
    let Ok(KeyRole::Device { person }) = Orgs::role(state, session) else {
        return Err(error(StatusCode::FORBIDDEN, "only a device can use project logs"));
    };
    if !state.can_access(&person, project) {
        return Err(error(StatusCode::FORBIDDEN, "not a member of this project"));
    }
    Ok(state.projects[project].epoch)
}
async fn append(State(o): State<Shared>, Path(project): Path<String>, headers: HeaderMap, body: Body) -> Response {
    let session = match o.session(&headers) {
        Ok(s) => s,
        Err(r) => return r,
    };
    if !core::is_hex(&project, 32) {
        return error(StatusCode::BAD_REQUEST, "invalid project");
    }
    let epoch = match project_access(&o, &session, &project).await {
        Ok(e) => e,
        Err(r) => return r,
    };
    let limit = o.store.config.object_bytes;
    let Ok(bytes) = to_bytes(body, limit).await else {
        return error(StatusCode::PAYLOAD_TOO_LARGE, "entry too large");
    };
    let (header, raw, ciphertext) = match core::split_entry(&bytes) {
        Ok(v) => v,
        Err(e) => return error(StatusCode::BAD_REQUEST, e.0),
    };
    if header.org != session.org || header.project != project || header.device != session.key {
        return error(StatusCode::FORBIDDEN, "entries must be signed by this device for this project");
    }
    if header.epoch != epoch {
        return error(StatusCode::CONFLICT, "epoch");
    }
    if let Err(e) = core::verify_entry(&header, ciphertext) {
        return error(StatusCode::BAD_REQUEST, e.0);
    }
    let hash = core::hex(&core::entry_hash(raw, ciphertext));
    match record(&o, &session.org, &project, &header, &hash, Bytes::from(bytes.to_vec())).await {
        Ok((status, seq, chain)) => (status, Json(serde_json::json!({"seq": seq, "chain": chain}))).into_response(),
        Err(r) => r,
    }
}
async fn record(o: &Orgs, org: &str, project: &str, header: &core::EntryHeader, hash: &str, bytes: Bytes) -> Result<(StatusCode, i64, String), Response> {
    let config = &o.store.config;
    sqlx::query("INSERT INTO usage (scope) VALUES ($1) ON CONFLICT DO NOTHING").bind(org_scope(org)).execute(&o.store.pool).await.map_err(internal)?;
    // Large bodies are made durable before any row lock is taken, so a slow blob store never
    // holds up other appends. The key is content-addressed; an unused blob is removed below.
    let inline = bytes.len() <= config.entry_inline_bytes;
    let key = entry_key(project, hash).map_err(store_error)?;
    if !inline {
        o.store.blobs.put(&key, bytes.clone()).await.map_err(internal)?;
    }
    let outcome = record_locked(o, org, project, header, hash, &bytes, inline).await;
    if !inline && !matches!(outcome, Ok((StatusCode::CREATED | StatusCode::OK, _, _))) {
        let referenced: Option<i32> = sqlx::query_scalar("SELECT 1 FROM entries WHERE project = $1 AND entry_hash = $2 LIMIT 1").bind(project).bind(hash).fetch_optional(&o.store.pool).await.unwrap_or(Some(1));
        if referenced.is_none() {
            let _ = o.store.blobs.delete(&key).await;
        }
    }
    outcome
}
async fn record_locked(o: &Orgs, org: &str, project: &str, header: &core::EntryHeader, hash: &str, bytes: &Bytes, inline: bool) -> Result<(StatusCode, i64, String), Response> {
    let config = &o.store.config;
    let size = bytes.len() as i64;
    let mut tx = o.store.pool.begin().await.map_err(internal)?;
    // The project row serialises appends to one log; quotas lock global then org.
    let head = sqlx::query("SELECT head_seq, head_chain FROM projects WHERE project = $1 AND org = $2 FOR UPDATE")
        .bind(project)
        .bind(org)
        .fetch_optional(&mut *tx)
        .await
        .map_err(internal)?
        .ok_or_else(|| error(StatusCode::NOT_FOUND, "unknown project"))?;
    let (head_seq, head_chain): (i64, String) = (head.get(0), head.get(1));
    let existing = sqlx::query("SELECT seq, chain, entry_hash FROM entries WHERE project = $1 AND device = $2 AND client_seq = $3")
        .bind(project)
        .bind(&header.device)
        .bind(header.client_seq as i64)
        .fetch_optional(&mut *tx)
        .await
        .map_err(internal)?;
    if let Some(row) = existing {
        let _ = tx.rollback().await;
        // An identical retry gets its original acknowledgement; different bytes never replace it.
        return if row.get::<String, _>(2) == hash {
            Ok((StatusCode::OK, row.get(0), row.get(1)))
        } else {
            Err(error(StatusCode::CONFLICT, "different entry at this client sequence"))
        };
    }
    let last: Option<i64> = sqlx::query_scalar("SELECT max(client_seq) FROM entries WHERE project = $1 AND device = $2")
        .bind(project)
        .bind(&header.device)
        .fetch_one(&mut *tx)
        .await
        .map_err(internal)?;
    if header.client_seq as i64 != last.unwrap_or(0) + 1 {
        let _ = tx.rollback().await;
        return Err(error(StatusCode::CONFLICT, "client sequence must follow the last accepted entry"));
    }
    for (scope, max) in [(GLOBAL_SCOPE.to_string(), config.total_bytes), (org_scope(org), config.org_bytes)] {
        let used: i64 = sqlx::query_scalar("SELECT bytes FROM usage WHERE scope = $1 FOR UPDATE").bind(&scope).fetch_one(&mut *tx).await.map_err(internal)?;
        if used as u64 + size as u64 > max {
            let _ = tx.rollback().await;
            return Err(error(StatusCode::INSUFFICIENT_STORAGE, "quota"));
        }
    }
    let previous: [u8; 32] = core::unhex(&head_chain, 32).map_err(|_| internal(()))?.try_into().unwrap();
    let entry_hash: [u8; 32] = core::unhex(hash, 32).unwrap().try_into().unwrap();
    let chain = core::hex(&core::chain_next(&previous, &entry_hash));
    let seq = head_seq + 1;
    let written = async {
        sqlx::query("INSERT INTO entries (project, seq, device, client_seq, epoch, entry_hash, chain, size, inline) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)")
            .bind(project)
            .bind(seq)
            .bind(&header.device)
            .bind(header.client_seq as i64)
            .bind(header.epoch as i32)
            .bind(hash)
            .bind(&chain)
            .bind(size)
            .bind(if inline { Some(bytes.to_vec()) } else { None })
            .execute(&mut *tx)
            .await?;
        sqlx::query("UPDATE projects SET head_seq = $2, head_chain = $3, bytes = bytes + $4 WHERE project = $1")
            .bind(project)
            .bind(seq)
            .bind(&chain)
            .bind(size)
            .execute(&mut *tx)
            .await?;
        sqlx::query("UPDATE usage SET bytes = bytes + $2, objects = objects + 1 WHERE scope = ANY($1)")
            .bind(vec![GLOBAL_SCOPE.to_string(), org_scope(org)])
            .bind(size)
            .execute(&mut *tx)
            .await?;
        Ok::<_, sqlx::Error>(())
    }
    .await;
    if written.is_err() {
        let _ = tx.rollback().await;
        return Err(internal(()));
    }
    tx.commit().await.map_err(internal)?;
    Ok((StatusCode::CREATED, seq, chain))
}
async fn read_log(State(o): State<Shared>, Path(project): Path<String>, Query(q): Query<After>, headers: HeaderMap) -> Response {
    let session = match o.session(&headers) {
        Ok(s) => s,
        Err(r) => return r,
    };
    if !core::is_hex(&project, 32) || q.after < 0 {
        return error(StatusCode::BAD_REQUEST, "invalid request");
    }
    if let Err(r) = project_access(&o, &session, &project).await {
        return r;
    }
    // The head is read first: a page never reaches past it, and clients read on until they reach it.
    let head: i64 = match sqlx::query_scalar("SELECT head_seq FROM projects WHERE project = $1 AND org = $2").bind(&project).bind(&session.org).fetch_optional(&o.store.pool).await {
        Ok(Some(head)) => head,
        Ok(None) => return error(StatusCode::NOT_FOUND, "unknown project"),
        Err(_) => return StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    };
    let limit = q.limit.unwrap_or(MAX_LOG_PAGE).clamp(1, MAX_LOG_PAGE);
    let rows = match sqlx::query("SELECT seq, chain, entry_hash, size, inline FROM entries WHERE project = $1 AND seq > $2 AND seq <= $3 ORDER BY seq LIMIT $4")
        .bind(&project)
        .bind(q.after)
        .bind(head)
        .bind(limit)
        .fetch_all(&o.store.pool)
        .await
    {
        Ok(rows) => rows,
        Err(_) => return StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    };
    let mut out = Vec::new();
    for row in rows {
        let (seq, chain, hash, size): (i64, String, String, i64) = (row.get(0), row.get(1), row.get(2), row.get(3));
        let body = match row.get::<Option<Vec<u8>>, _>(4) {
            Some(bytes) => bytes,
            None => {
                let Ok(key) = entry_key(&project, &hash) else { return StatusCode::INTERNAL_SERVER_ERROR.into_response() };
                match o.store.blobs.get(&key, size as usize).await {
                    Ok(bytes) => bytes,
                    Err(_) => return StatusCode::INTERNAL_SERVER_ERROR.into_response(),
                }
            }
        };
        if body.len() as i64 != size || !out.is_empty() && out.len() + body.len() > MAX_LOG_PAGE_BYTES {
            if body.len() as i64 != size {
                return StatusCode::INTERNAL_SERVER_ERROR.into_response();
            }
            break;
        }
        out.extend_from_slice(&(seq as u64).to_be_bytes());
        out.extend_from_slice(&core::unhex(&chain, 32).unwrap_or_default());
        out.extend_from_slice(&(body.len() as u32).to_be_bytes());
        out.extend_from_slice(&body);
    }
    ([(header::CONTENT_TYPE, "application/octet-stream".to_string()), (header::CACHE_CONTROL, "no-store".to_string()), (header::HeaderName::from_static("scribyra-log-head"), head.to_string())], out).into_response()
}

pub fn routes(o: Shared) -> Router {
    Router::new()
        .route("/v1/auth/challenge", post(challenge))
        .route("/v1/auth/session", post(session))
        .route("/v1/orgs/{org}/events", get(events).post(append_event))
        .route("/v1/orgs/{org}/keys", get(get_wraps).put(put_wraps))
        .route("/v1/projects/{project}/log", get(read_log).post(append))
        .with_state(o)
}

/// `scribyra-sync org create`: a new organisation and its single-use setup code. Runs beside
/// a live service (it takes no ownership lock); the service must have migrated the database.
pub async fn create_org(config: &crate::config::Config, label: &str) -> Result<(String, String), crate::store::Error> {
    use sqlx::Connection;
    let public_url = config.public_url.clone().ok_or("set public_url before creating organisations")?;
    if label.is_empty() || label.len() > 64 || !label.bytes().all(|b| b.is_ascii_alphanumeric() || b"-_. ".contains(&b)) {
        return Err("labels use 1-64 letters, digits, spaces, dots, dashes or underscores".into());
    }
    let options: sqlx::postgres::PgConnectOptions = config.database_url().map_err(|e| e.to_string())?.parse()?;
    let mut db = sqlx::PgConnection::connect_with(&options.application_name("scribyra-sync-admin")).await?;
    let migrated: Option<i64> = sqlx::query_scalar("SELECT version FROM _sqlx_migrations WHERE version = 2 AND success")
        .fetch_optional(&mut db)
        .await
        .unwrap_or(None);
    if migrated.is_none() {
        return Err("start the service once so it can upgrade the database, then try again".into());
    }
    let org = random_hex();
    let mut secret = [0u8; 32];
    getrandom::fill(&mut secret)?;
    let enrol = core::hex(&core::ed25519_public(&core::enrol_seed(&secret)?)?);
    sqlx::query("INSERT INTO orgs (org, label, enrol) VALUES ($1, $2, $3)")
        .bind(&org)
        .bind(label)
        .bind(&enrol)
        .execute(&mut db)
        .await?;
    let setup = format!("scribyra-setup:1:{}:{org}:{}", base64url(public_url.as_bytes()), base64url(&secret));
    secret.fill(0);
    Ok((org, setup))
}
fn base64url(bytes: &[u8]) -> String {
    const A: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    let mut out = String::new();
    for chunk in bytes.chunks(3) {
        let n = chunk.iter().enumerate().fold(0u32, |n, (i, &b)| n | (b as u32) << (16 - 8 * i));
        for i in 0..=chunk.len() {
            out.push(A[((n >> (18 - 6 * i)) & 63) as usize] as char);
        }
    }
    out
}
