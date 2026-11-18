//! End-to-end organisation routes (Appendix A of the design): device sessions bound to an
//! OpenID Connect login, the signed membership log, key wraps and encrypted append-only project
//! logs. The service checks every signature and membership rule with the same Rust code as the
//! browser (`scribyra_core::orgsync`) but never holds a project key or decrypts anything.
//!
//! The routes serve the deployment's one organisation, and only when the deployment is end to
//! end encrypted. Nothing here signs anyone in by itself: a device session needs a live login of
//! the person the device belongs to, and the genesis needs a configured administrator's login.
use crate::store::{GLOBAL_SCOPE, PutOutcome, Quota, Store, StoreError, namespace_scope, object_key};
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
const MAX_CHALLENGES_PER_ORG: usize = 1024;
/// Open challenges per client address; a further one replaces that address's oldest.
const MAX_CHALLENGES_PER_SOURCE: usize = 8;
const MAX_SESSIONS_PER_KEY: usize = 8;
const MAX_CACHED_ORGS: usize = 1024;
const MAX_WRAPS_PER_ORG: i64 = 100_000;
const MAX_WRAPS_PER_REQUEST: usize = 64;
const MAX_LOG_PAGE: i64 = 256;
const MAX_EVENT_PAGE: i64 = 1000;
const MAX_LOG_PAGE_BYTES: usize = 16 * 1024 * 1024;

pub struct Orgs {
    store: Arc<Store>,
    sso: Arc<crate::sso::Sso>,
    public_url: Option<String>,
    /// The deployment's organisation, when the deployment is end to end encrypted.
    org: Option<String>,
    /// Open challenges: (org, client address, expiry).
    challenges: Mutex<HashMap<String, (String, Option<std::net::IpAddr>, Instant)>>,
    sessions: Mutex<HashMap<String, Session>>,
    states: Mutex<HashMap<String, Arc<tokio::sync::Mutex<Option<OrgState>>>>>,
    /// Per-organisation change counter for the long-poll heads notice.
    changes: Mutex<HashMap<String, tokio::sync::watch::Sender<u64>>>,
    /// Memory budget for object downloads (bytes held in responses at once).
    downloads: Arc<tokio::sync::Semaphore>,
}
#[derive(Clone)]
struct Session {
    org: String,
    key: String,
    person: String,
    until: Instant,
    /// When the session opened: a key's oldest session makes room for a new one. (`until` does
    /// not order them, since it follows each login's expiry.)
    opened: Instant,
}
/// What a device signs to open a session: this service, the organisation, its key, the login it
/// presents (its token's SHA-256) and a single-use challenge.
pub fn session_message(public_url: &str, org: &str, key: &str, login_hash: &str, challenge: &str) -> String {
    format!("scribyra-auth/2\n{public_url}\n{org}\n{key}\n{login_hash}\n{challenge}")
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
/// Object-store namespace of a project's encrypted objects. The `p-` prefix keeps it apart from
/// capability namespaces (64 hex characters), which can never name it.
pub fn object_namespace(project: &str) -> String {
    format!("p-{project}")
}
pub fn entry_key(project: &str, hash: &str) -> Result<BlobKey, StoreError> {
    BlobKey::new(format!("entries/{project}/{hash}")).map_err(|_| StoreError::BadRequest)
}

impl Orgs {
    pub fn new(store: Arc<Store>, sso: Arc<crate::sso::Sso>) -> Shared {
        let public_url = store.config.public_url.clone();
        let e2ee = store.config.deployment.as_ref().is_some_and(|d| d.encryption == crate::config::Encryption::E2ee);
        let org = store.org.clone().filter(|_| e2ee);
        let mut revocations = sso.revocations();
        let downloads = Arc::new(tokio::sync::Semaphore::new(store.config.response_bytes));
        let orgs = Arc::new(Self { store, sso, public_url, org, challenges: Mutex::default(), sessions: Mutex::default(), states: Mutex::default(), changes: Mutex::default(), downloads });
        // When the identity provider disables someone, or they sign out, their device sessions
        // close at once.
        let weak = Arc::downgrade(&orgs);
        if let Ok(runtime) = tokio::runtime::Handle::try_current() {
            runtime.spawn(async move {
                loop {
                    match revocations.recv().await {
                        Ok((org, person)) => {
                            let Some(orgs) = weak.upgrade() else { break };
                            orgs.sessions.lock().unwrap().retain(|_, s| !(s.org == org && s.person == person));
                        }
                        // Missed revocations: close every org session; devices sign in again (and
                        // a revoked or blocked person cannot).
                        Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {
                            let Some(orgs) = weak.upgrade() else { break };
                            orgs.sessions.lock().unwrap().clear();
                        }
                        Err(_) => break,
                    }
                }
            });
        }
        orgs
    }
    fn changes(&self, org: &str) -> tokio::sync::watch::Receiver<u64> {
        let mut changes = self.changes.lock().unwrap();
        if changes.len() >= MAX_CACHED_ORGS {
            changes.retain(|_, tx| tx.receiver_count() > 0);
        }
        changes.entry(org.to_string()).or_insert_with(|| tokio::sync::watch::channel(0).0).subscribe()
    }
    /// Wakes every long poll of an organisation (a project or the membership log moved).
    fn changed(&self, org: &str) {
        if let Some(tx) = self.changes.lock().unwrap().get(org) {
            tx.send_modify(|n| *n += 1);
        }
    }
    /// The per-organisation state slot. Only the deployment's organisation has one (and only in
    /// an end-to-end deployment), and the cache drops idle entries once it is full.
    async fn slot(&self, org: &str) -> Result<Arc<tokio::sync::Mutex<Option<OrgState>>>, Response> {
        if !core::is_hex(org, 32) {
            return Err(error(StatusCode::BAD_REQUEST, "invalid organisation"));
        }
        if self.org.as_deref() != Some(org) {
            return Err(error(StatusCode::NOT_FOUND, "unknown organisation"));
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
            let mut state = OrgState::new(org).map_err(|_| StatusCode::BAD_REQUEST.into_response())?;
            let rows = sqlx::query("SELECT raw FROM org_events WHERE org = $1 ORDER BY seq")
                .bind(org)
                .fetch_all(&self.store.pool)
                .await
                .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response())?;
            for row in rows {
                let raw: String = row.get(0);
                // Stored events were validated on append; a failure here means tampering.
                state.apply(&raw).map_err(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response())?;
            }
            **guard = Some(state);
        }
        Ok(guard.as_mut().unwrap())
    }
    fn session(&self, headers: &HeaderMap) -> Result<Session, Response> {
        // Only an end-to-end deployment has these routes at all.
        if self.org.is_none() {
            return Err(error(StatusCode::NOT_FOUND, "unknown organisation"));
        }
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
    /// The SSO login presented with `Authorization: ScribyraSSO <token>`, if any, for this org.
    async fn sso_login(&self, headers: &HeaderMap, org: &str) -> Result<Option<crate::sso::Login>, Response> {
        let Some(token) = crate::sso::bearer(headers) else { return Ok(None) };
        match self.sso.login(token).await {
            Ok(Some(login)) if login.org == org => Ok(Some(login)),
            Ok(Some(_)) => Err(error(StatusCode::FORBIDDEN, "this single sign-on belongs to another organisation")),
            Ok(None) => Err(error(StatusCode::UNAUTHORIZED, "single sign-on expired")),
            Err(_) => Err(StatusCode::INTERNAL_SERVER_ERROR.into_response()),
        }
    }
    /// Joining (a join request, or the genesis): a live login for this org whose identity is not
    /// yet anyone's.
    async fn sso_gate(&self, headers: &HeaderMap, org: &str, person: Option<&str>) -> Result<crate::sso::Login, Response> {
        let Some(login) = self.sso_login(headers, org).await? else {
            return Err(error(StatusCode::FORBIDDEN, "single sign-on is required"));
        };
        match self.sso.linked_person(&login).await {
            Ok(None) => {}
            // A retried join of the same person (linked by an attempt whose answer was lost).
            Ok(Some((linked, false))) if Some(linked.as_str()) == person => {}
            Ok(Some(_)) => return Err(error(StatusCode::CONFLICT, "this single sign-on identity already belongs to a member")),
            Err(_) => return Err(StatusCode::INTERNAL_SERVER_ERROR.into_response()),
        }
        Ok(login)
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
async fn challenge(State(o): State<Shared>, source: Option<axum::Extension<crate::service::Source>>, Json(request): Json<ChallengeRequest>) -> Response {
    let source = source.map(|axum::Extension(crate::service::Source(ip))| ip);
    if !core::is_hex(&request.org, 32) {
        return error(StatusCode::BAD_REQUEST, "invalid organisation");
    }
    if let Err(r) = o.slot(&request.org).await {
        return r;
    }
    let challenge = random_hex();
    let mut challenges = o.challenges.lock().unwrap();
    let now = Instant::now();
    challenges.retain(|_, (_, _, until)| *until > now);
    // Nobody is refused for room (review M2): a source past its own few replaces its oldest, and
    // a full table (or organisation) drops its oldest, so one client cannot lock others out.
    type Open = (String, Option<std::net::IpAddr>, Instant);
    let rules: [(usize, Box<dyn Fn(&Open) -> bool>); 3] = [
        (MAX_CHALLENGES_PER_SOURCE, Box::new(|v: &Open| v.1 == source)),
        (MAX_CHALLENGES_PER_ORG, Box::new(|v: &Open| v.0 == request.org)),
        (MAX_CHALLENGES, Box::new(|_: &Open| true)),
    ];
    for (limit, applies) in rules {
        while challenges.values().filter(|v| applies(v)).count() >= limit {
            let Some(key) = challenges.iter().filter(|(_, v)| applies(v)).min_by_key(|(_, v)| v.2).map(|(k, _)| k.clone()) else { break };
            challenges.remove(&key);
        }
    }
    challenges.insert(challenge.clone(), (request.org, source, now + Duration::from_secs(CHALLENGE_SECONDS)));
    Json(serde_json::json!({"challenge": challenge})).into_response()
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct SessionRequest {
    org: String,
    key: String,
    challenge: String,
    sig: String,
    /// The OpenID Connect login token of the person this key belongs to. Always required: a
    /// device (or recovery) key alone never opens a session.
    sso: String,
}
async fn session(State(o): State<Shared>, Json(request): Json<SessionRequest>) -> Response {
    let Some(public_url) = o.public_url.clone() else {
        return error(StatusCode::NOT_FOUND, "organisations are not enabled on this service");
    };
    // Single use: the challenge is consumed whether or not the signature verifies.
    let issued = o.challenges.lock().unwrap().remove(&request.challenge);
    let Some((org, _, until)) = issued else { return error(StatusCode::UNAUTHORIZED, "unknown challenge") };
    if org != request.org || until <= Instant::now() {
        return error(StatusCode::UNAUTHORIZED, "unknown challenge");
    }
    let login_hash = core::hex(&core::sha256(request.sso.as_bytes()));
    let message = session_message(&public_url, &org, &request.key, &login_hash, &request.challenge);
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
    drop(guard);
    let login = match o.sso.login(&request.sso).await {
        Ok(Some(login)) if login.org == org => login,
        Ok(Some(_)) => return error(StatusCode::FORBIDDEN, "this single sign-on belongs to another organisation"),
        Ok(None) => return error(StatusCode::UNAUTHORIZED, "single sign-on is required"),
        Err(_) => return StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    };
    // The login must be the identity linked to this key's person (linked when they joined), and
    // not blocked by the identity provider.
    match o.sso.linked_person(&login).await {
        Ok(Some((p, false))) if p == person => {}
        Ok(Some((p, true))) if p == person => return error(StatusCode::FORBIDDEN, "disabled at your organisation's identity provider"),
        Ok(_) => return error(StatusCode::FORBIDDEN, "this single sign-on identity is not linked to this member"),
        Err(_) => return StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    }
    // A device session never outlives the login behind it.
    let mut until = Instant::now() + Duration::from_secs(SESSION_SECONDS);
    if let Ok(left) = login.expires.duration_since(std::time::SystemTime::now()) {
        until = until.min(Instant::now() + left);
    }
    let token = random_hex();
    let mut sessions = o.sessions.lock().unwrap();
    let now = Instant::now();
    sessions.retain(|_, s| s.until > now);
    // One key holds a few sessions at most; its oldest makes room for a new one.
    let mine: Vec<(String, Instant)> = sessions.iter().filter(|(_, s)| s.key == request.key && s.org == org).map(|(k, s)| (k.clone(), s.opened)).collect();
    if mine.len() >= MAX_SESSIONS_PER_KEY {
        if let Some((oldest, _)) = mine.iter().min_by_key(|(_, opened)| *opened) {
            sessions.remove(oldest);
        }
    }
    if sessions.len() >= o.store.config.sessions {
        return error(StatusCode::SERVICE_UNAVAILABLE, "too many sessions");
    }
    let expires = until.saturating_duration_since(now).as_secs();
    sessions.insert(core::hex(&core::sha256(token.as_bytes())), Session { org, key: request.key, person: person.clone(), until, opened: now });
    Json(serde_json::json!({"token": token, "expires": expires, "person": person, "role": role})).into_response()
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
    // The login a genesis or a join request brings along, linked to the new person before the
    // event commits.
    let mut joining_login = None;
    if state.genesis.is_none() {
        // The genesis is accepted once, from a sign-in of a configured administrator.
        if kind != "genesis" {
            return error(StatusCode::CONFLICT, "the organisation has no genesis yet");
        }
        let login = match o.sso_gate(&headers, &org, value["body"]["person"].as_str()).await {
            Ok(login) => login,
            Err(r) => return r,
        };
        if login.role != crate::sso::Role::Admin {
            return error(StatusCode::FORBIDDEN, "only a deployment administrator can create the organisation");
        }
        joining_login = Some(login);
    } else {
        match kind.as_str() {
            "genesis" => return error(StatusCode::CONFLICT, "the organisation already has a genesis"),
            // Asking to join needs a sign-in whose identity is nobody's yet.
            "person.request" => match o.sso_gate(&headers, &org, value["body"]["person"].as_str()).await {
                Ok(login) => joining_login = Some(login),
                Err(r) => return r,
            },
            _ => {
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
        }
    }
    let mut next = state.clone();
    let hash = match next.apply(&raw) {
        Ok(hash) => hash,
        Err(e) if e.0 == "membership event does not follow the current head" || e.0 == "the organisation already has a genesis" => return error(StatusCode::CONFLICT, e.0),
        Err(e) => return error(StatusCode::BAD_REQUEST, e.0),
    };
    // The identity is linked before the event commits (a refused link refuses it), so one
    // identity can never end up behind two people.
    if let (Some(login), Some(person)) = (&joining_login, value["body"]["person"].as_str())
        && o.sso.link(login, person).await.is_err()
    {
        return error(StatusCode::CONFLICT, "this single sign-on identity already belongs to a member");
    }
    let result = async {
        let mut tx = o.store.pool.begin().await?;
        // A new project epoch takes effect at the log's current head, under the project row's
        // lock, so no append races it; `after` may not reach past what the log holds.
        if kind == "project.epoch" {
            let project = value["body"]["project"].as_str().unwrap_or_default();
            let after = value["body"]["after"].as_u64().unwrap_or(u64::MAX);
            let head: Option<i64> = sqlx::query_scalar("SELECT head_seq FROM projects WHERE project = $1 AND org = $2 FOR UPDATE").bind(project).bind(&org).fetch_optional(&mut *tx).await?;
            match head {
                Some(head) if after <= head as u64 => {
                    sqlx::query("UPDATE projects SET epoch = $2, epoch_cutover = head_seq WHERE project = $1").bind(project).bind(value["body"]["epoch"].as_i64().unwrap_or(0) as i32).execute(&mut *tx).await?;
                }
                _ => {
                    tx.rollback().await?;
                    return Ok(Err(error(StatusCode::BAD_REQUEST, "a new epoch cannot start after the log's head")));
                }
            }
        }
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
        tx.commit().await.map(Ok)
    }
    .await;
    match result {
        Ok(Ok(())) => {}
        Ok(Err(refusal)) => return refusal,
        Err(_) => {
            // The commit may have happened; reload from the database next time.
            *guard = None;
            return StatusCode::INTERNAL_SERVER_ERROR.into_response();
        }
    }
    let seq = next.count;
    // Removed people and devices lose their sessions at once.
    o.sessions.lock().unwrap().retain(|_, s| s.org != org || next.key_role(&s.key).is_some());
    if kind == "device.add"
        && let Some(link) = value["body"]["link"].as_str()
    {
        let _ = sqlx::query("DELETE FROM device_links WHERE org = $1 AND link = $2").bind(&org).bind(link).execute(&o.store.pool).await;
    }
    *guard = Some(next);
    drop(guard);
    // A removed person's SSO identity is released, so it can be invited again later.
    if kind == "person.remove"
        && let Some(person) = value["body"]["person"].as_str()
    {
        let _ = o.sso.unlink(&org, person).await;
    }
    o.changed(&org);
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
            // One wrap per sender: nobody can overwrite another member's wrap.
            sqlx::query("INSERT INTO wraps (org, project, epoch, recipient, sender, raw) VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (org, project, epoch, recipient, sender) DO UPDATE SET raw = EXCLUDED.raw, received = now()")
                .bind(&org)
                .bind(&w.project)
                .bind(w.epoch as i32)
                .bind(&w.recipient)
                .bind(&w.sender)
                .bind(raw)
                .execute(&mut *tx)
                .await?;
        }
        tx.commit().await
    }
    .await;
    match result {
        Ok(()) => {
            // Recipients learn through the long poll that keys arrived for them.
            o.changed(&org);
            StatusCode::NO_CONTENT.into_response()
        }
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
    // Newest epochs first: if a device has more wraps than one answer holds, the keys it needs to
    // write now arrive before history keys.
    let rows = sqlx::query("SELECT raw FROM wraps WHERE org = $1 AND recipient = ANY($2) ORDER BY epoch DESC, project LIMIT 10000")
        .bind(&org)
        .bind(&recipients)
        .fetch_all(&o.store.pool)
        .await;
    match rows {
        Ok(rows) => Json(serde_json::json!({"wraps": rows.iter().map(|r| r.get::<String, _>(0)).collect::<Vec<_>>()})).into_response(),
        Err(_) => StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct BadWrap {
    project: String,
    epoch: u32,
    sender: String,
}
/// A device reports a wrap addressed to it that does not open to the key the log commits to.
/// The service cannot check that (it cannot open wraps), so it believes the recipient: only the
/// recipient's own wrap is dropped, and the key is listed as missing again for honest members.
async fn report_wrap(State(o): State<Shared>, Path(org): Path<String>, headers: HeaderMap, Json(bad): Json<BadWrap>) -> Response {
    let session = match o.session(&headers) {
        Ok(s) => s,
        Err(r) => return r,
    };
    if session.org != org || !core::is_hex(&bad.project, 32) || !core::is_hex(&bad.sender, 32) {
        return error(StatusCode::BAD_REQUEST, "invalid report");
    }
    let recipient = {
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
            return error(StatusCode::FORBIDDEN, "only a device can report its keys");
        }
        state.devices[&session.key].agreement.clone()
    };
    match sqlx::query("DELETE FROM wraps WHERE org = $1 AND project = $2 AND epoch = $3 AND recipient = $4 AND sender = $5").bind(&org).bind(&bad.project).bind(bad.epoch as i32).bind(&recipient).bind(&bad.sender).execute(&o.store.pool).await {
        Ok(_) => StatusCode::NO_CONTENT.into_response(),
        Err(_) => StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    }
}
/// Checks the session may read (or, with `write`, append to) this project's log; returns the
/// project's current epoch.
async fn project_access(o: &Orgs, session: &Session, project: &str, write: bool) -> Result<u32, Response> {
    let slot = o.slot(&session.org).await?;
    let mut guard = slot.lock().await;
    let state = o.state(&mut guard, &session.org).await?;
    let Ok(KeyRole::Device { person }) = Orgs::role(state, session) else {
        return Err(error(StatusCode::FORBIDDEN, "only a device can use project logs"));
    };
    if !state.can_access(&person, project) {
        return Err(error(StatusCode::FORBIDDEN, "not a member of this project"));
    }
    if write && !state.can_write(&person, project) {
        return Err(error(StatusCode::FORBIDDEN, "only editors can change this project"));
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
    let epoch = match project_access(&o, &session, &project, true).await {
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
    // An epoch the membership log does not have yet is refused here; an older one under the
    // project row's lock below, where an identical repeat of an entry already held still passes.
    if header.epoch > epoch {
        return error(StatusCode::CONFLICT, "epoch");
    }
    if let Err(e) = core::verify_entry(&header, ciphertext) {
        return error(StatusCode::BAD_REQUEST, e.0);
    }
    let hash = core::hex(&core::entry_hash(raw, ciphertext));
    match record(&o, &session.org, &project, &header, &hash, Bytes::from(bytes.to_vec())).await {
        Ok((status, seq, chain)) => {
            o.changed(&session.org);
            (status, Json(serde_json::json!({"seq": seq, "chain": chain}))).into_response()
        }
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
    let head = sqlx::query("SELECT head_seq, head_chain, epoch FROM projects WHERE project = $1 AND org = $2 FOR UPDATE")
        .bind(project)
        .bind(org)
        .fetch_optional(&mut *tx)
        .await
        .map_err(internal)?
        .ok_or_else(|| error(StatusCode::NOT_FOUND, "unknown project"))?;
    let (head_seq, head_chain, current_epoch): (i64, String, i32) = (head.get(0), head.get(1), head.get(2));
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
    // After a cutover only the new epoch is accepted (409 epoch): the client re-encrypts.
    if header.epoch as i32 != current_epoch {
        let _ = tx.rollback().await;
        return Err(error(StatusCode::CONFLICT, "epoch"));
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
    if let Err(r) = project_access(&o, &session, &project, false).await {
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

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ObjectQuery {
    epoch: u32,
}
/// Uploads one encrypted object part under its keyed ID (editors only, under the project's
/// current epoch). The service checks nothing about the content but its size; it stores the
/// ciphertext content-addressed, charges the global, organisation and project quotas, and keeps
/// the ID → ciphertext mapping write-once.
async fn put_object(State(o): State<Shared>, Path((project, id)): Path<(String, String)>, Query(q): Query<ObjectQuery>, headers: HeaderMap, body: Body) -> Response {
    let session = match o.session(&headers) {
        Ok(s) => s,
        Err(r) => return r,
    };
    if !core::is_hex(&project, 32) || !core::is_hex(&id, 32) {
        return error(StatusCode::BAD_REQUEST, "invalid object");
    }
    let epoch = match project_access(&o, &session, &project, true).await {
        Ok(e) => e,
        Err(r) => return r,
    };
    if q.epoch != epoch {
        return error(StatusCode::CONFLICT, "epoch");
    }
    let config = &o.store.config;
    let Ok(bytes) = to_bytes(body, config.object_bytes).await else {
        return error(StatusCode::PAYLOAD_TOO_LARGE, "object too large");
    };
    if bytes.len() < core::OBJECT_OVERHEAD {
        return error(StatusCode::BAD_REQUEST, "object too short");
    }
    let hash = core::hex(&core::sha256(&bytes));
    let namespace = object_namespace(&project);
    let mapped = |row: Option<String>| -> Option<Response> {
        match row {
            Some(stored) if stored == hash => Some(StatusCode::NO_CONTENT.into_response()),
            Some(_) => Some(error(StatusCode::CONFLICT, "a different object is stored under this ID")),
            None => None,
        }
    };
    let existing: Option<String> = match sqlx::query_scalar("SELECT hash FROM project_objects WHERE project = $1 AND id = $2").bind(&project).bind(&id).fetch_optional(&o.store.pool).await {
        Ok(row) => row,
        Err(_) => return StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    };
    if existing.as_deref() == Some(hash.as_str()) {
        // The same bytes again: repair the stored copy if the blob store lost or damaged it.
        if let Ok(key) = object_key(&namespace, &hash) {
            let intact = matches!(o.store.blobs.get(&key, bytes.len()).await, Ok(stored) if core::sha256(&stored) == core::sha256(&bytes));
            if !intact && o.store.blobs.put(&key, Bytes::from(bytes.to_vec())).await.is_err() {
                return StatusCode::INTERNAL_SERVER_ERROR.into_response();
            }
        }
        return StatusCode::NO_CONTENT.into_response();
    }
    if let Some(r) = mapped(existing) {
        return r;
    }
    // Every ID counts against the project's object limit, also when its ciphertext is already
    // stored (otherwise one small ciphertext under endless IDs would grow the database for free).
    let ids: i64 = match sqlx::query_scalar("SELECT count(*) FROM project_objects WHERE project = $1").bind(&project).fetch_one(&o.store.pool).await {
        Ok(n) => n,
        Err(_) => return StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    };
    if ids as u64 >= config.namespace_objects {
        return error(StatusCode::INSUFFICIENT_STORAGE, "quota");
    }
    let quotas = [
        Quota { scope: GLOBAL_SCOPE.into(), max_bytes: config.total_bytes, max_objects: config.total_objects },
        Quota { scope: org_scope(&session.org), max_bytes: config.org_bytes, max_objects: u64::MAX },
        Quota { scope: namespace_scope(&namespace), max_bytes: config.namespace_bytes, max_objects: config.namespace_objects },
    ];
    let size = bytes.len() as i64;
    let outcome = match o.store.put_object_with(&namespace, &hash, Bytes::from(bytes.to_vec()), &quotas).await {
        Ok(outcome) => outcome,
        Err(e) => return store_error(e),
    };
    let inserted = sqlx::query("INSERT INTO project_objects (project, id, epoch, hash, size, device) VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT DO NOTHING")
        .bind(&project)
        .bind(&id)
        .bind(epoch as i32)
        .bind(&hash)
        .bind(size)
        .bind(&session.key)
        .execute(&o.store.pool)
        .await;
    match inserted {
        Ok(done) if done.rows_affected() == 1 => match outcome {
            PutOutcome::Created => StatusCode::CREATED.into_response(),
            PutOutcome::Existing => StatusCode::NO_CONTENT.into_response(),
        },
        // A concurrent upload of the same ID won.
        Ok(_) => {
            let row = sqlx::query_scalar("SELECT hash FROM project_objects WHERE project = $1 AND id = $2").bind(&project).bind(&id).fetch_optional(&o.store.pool).await.unwrap_or(None);
            mapped(row).unwrap_or_else(|| StatusCode::INTERNAL_SERVER_ERROR.into_response())
        }
        Err(_) => StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    }
}
/// Downloads one encrypted object part (any project member). The stored ciphertext is checked
/// against its hash before it is sent; a damaged copy is a 500, never wrong bytes.
async fn get_object(State(o): State<Shared>, Path((project, id)): Path<(String, String)>, headers: HeaderMap) -> Response {
    let session = match o.session(&headers) {
        Ok(s) => s,
        Err(r) => return r,
    };
    if !core::is_hex(&project, 32) || !core::is_hex(&id, 32) {
        return error(StatusCode::BAD_REQUEST, "invalid object");
    }
    if let Err(r) = project_access(&o, &session, &project, false).await {
        return r;
    }
    let hash: Option<String> = match sqlx::query_scalar("SELECT hash FROM project_objects WHERE project = $1 AND id = $2").bind(&project).bind(&id).fetch_optional(&o.store.pool).await {
        Ok(row) => row,
        Err(_) => return StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    };
    let Some(hash) = hash else { return error(StatusCode::NOT_FOUND, "unknown object") };
    match o.store.get_object(&object_namespace(&project), &hash, o.downloads.clone()).await {
        Ok((bytes, _permit)) => ([(header::CONTENT_TYPE, "application/octet-stream"), (header::CACHE_CONTROL, "no-store"), (header::X_CONTENT_TYPE_OPTIONS, "nosniff")], bytes).into_response(),
        Err(e) => store_error(e),
    }
}

/// What a browser needs before it signs anything: whether the org has a genesis, and the
/// log's head and length (a join request is signed at the head).
async fn info(State(o): State<Shared>, Path(org): Path<String>) -> Response {
    let slot = match o.slot(&org).await {
        Ok(slot) => slot,
        Err(r) => return r,
    };
    // The head lets someone holding an invitation sign their join at the current position.
    let (genesis, head, count, name) = {
        let mut guard = slot.lock().await;
        match o.state(&mut guard, &org).await {
            Ok(state) => (state.genesis.is_some(), state.head.clone(), state.count, state.name.clone()),
            Err(r) => return r,
        }
    };
    // The org's name is sealed under the directory key.
    Json(serde_json::json!({"genesis": genesis, "head": head, "count": count, "name": name})).into_response()
}
/// Keys this device's person could hand out but has not yet: for every project the person can
/// open (and the org directory), the entitled X25519 keys that have no wrap for the current
/// epoch. Any member's app fulfils these, so new devices and new members get keys as soon as
/// someone who holds them is online.
async fn pending(State(o): State<Shared>, Path(org): Path<String>, headers: HeaderMap) -> Response {
    let session = match o.session(&headers) {
        Ok(s) => s,
        Err(r) => return r,
    };
    if session.org != org {
        return error(StatusCode::FORBIDDEN, "wrong organisation");
    }
    let wanted: Vec<(String, u32, std::collections::BTreeSet<String>)> = {
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
            return error(StatusCode::FORBIDDEN, "only a device can hand out keys");
        };
        std::iter::once(org.clone())
            .chain(state.projects.keys().cloned())
            .filter(|project| state.may_wrap(&person, project))
            // Every epoch: members keep (and new members get) earlier keys to read the history.
            .flat_map(|project| {
                let recipients = state.wrap_recipients(&project);
                (1..=state.key_epoch(&project).unwrap_or(0)).map(move |epoch| (project.clone(), epoch, recipients.clone()))
            })
            .collect()
    };
    let rows = match sqlx::query("SELECT project, epoch, recipient FROM wraps WHERE org = $1").bind(&org).fetch_all(&o.store.pool).await {
        Ok(rows) => rows,
        Err(_) => return StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    };
    let have: std::collections::HashSet<(String, i32, String)> = rows.iter().map(|r| (r.get(0), r.get(1), r.get(2))).collect();
    let mut out = Vec::new();
    for (project, epoch, recipients) in wanted {
        let missing: Vec<String> = recipients.into_iter().filter(|r| !have.contains(&(project.clone(), epoch as i32, r.clone()))).collect();
        if !missing.is_empty() {
            out.push(serde_json::json!({"project": project, "epoch": epoch, "recipients": missing}));
        }
    }
    Json(serde_json::json!({"pending": out})).into_response()
}

/// The longest a heads long poll waits for a change.
pub const MAX_HEADS_WAIT_SECS: u64 = 25;
#[derive(Deserialize)]
struct Heads {
    #[serde(default)]
    since: Option<u64>,
    #[serde(default)]
    wait: u64,
}
/// A notice, not a delivery: the membership log's length and the head of every project this
/// device's person can read. With `since` equal to the current change counter it waits (up to
/// `wait` seconds, at most 25) for the next change. Clients read the logs themselves afterwards.
async fn heads(State(o): State<Shared>, Path(org): Path<String>, Query(q): Query<Heads>, headers: HeaderMap) -> Response {
    let session = match o.session(&headers) {
        Ok(s) => s,
        Err(r) => return r,
    };
    if session.org != org {
        return error(StatusCode::FORBIDDEN, "wrong organisation");
    }
    let mut rx = o.changes(&org);
    if q.since == Some(*rx.borrow_and_update()) && q.wait > 0 {
        let _ = tokio::time::timeout(Duration::from_secs(q.wait.min(MAX_HEADS_WAIT_SECS)), rx.changed()).await;
    }
    let version = *rx.borrow();
    let slot = match o.slot(&org).await {
        Ok(slot) => slot,
        Err(r) => return r,
    };
    let (count, readable) = {
        let mut guard = slot.lock().await;
        let state = match o.state(&mut guard, &org).await {
            Ok(s) => s,
            Err(r) => return r,
        };
        let Ok(KeyRole::Device { person }) = Orgs::role(state, &session) else {
            return error(StatusCode::FORBIDDEN, "only a device can follow projects");
        };
        let readable: std::collections::HashSet<String> = state.projects.keys().filter(|p| state.can_access(&person, p)).cloned().collect();
        (state.count, readable)
    };
    let rows = match sqlx::query("SELECT project, head_seq FROM projects WHERE org = $1").bind(&org).fetch_all(&o.store.pool).await {
        Ok(rows) => rows,
        Err(_) => return StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    };
    let heads: serde_json::Map<String, serde_json::Value> = rows.iter().filter(|r| readable.contains(&r.get::<String, _>(0))).map(|r| (r.get::<String, _>(0), r.get::<i64, _>(1).into())).collect();
    Json(serde_json::json!({"version": version, "events": count, "heads": heads})).into_response()
}

const LINK_SECONDS: i64 = 15 * 60;
const MAX_LINKS_PER_PERSON: i64 = 4;
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct SsoLinkRequest {
    link: String,
    device: String,
    agreement: String,
    proof: String,
    /// A keyed check over the new keys under a code only the new browser shows; the existing
    /// device asks the person to type that code, so the service cannot swap the keys.
    mac: String,
}
/// A new browser signed in as an existing member asks to become one of their devices. It waits
/// until one of that person's devices (or their recovery kit) compares a code and signs
/// device.add; the service alone cannot add it.
async fn sso_link_request(State(o): State<Shared>, Path(org): Path<String>, headers: HeaderMap, Json(request): Json<SsoLinkRequest>) -> Response {
    if !core::is_hex(&request.link, 16) || !core::is_hex(&request.device, 32) || !core::valid_agreement_key(&request.agreement) || !core::is_hex(&request.mac, 32) {
        return error(StatusCode::BAD_REQUEST, "invalid device request");
    }
    let login = match o.sso_login(&headers, &org).await {
        Ok(Some(login)) => login,
        Ok(None) => return error(StatusCode::UNAUTHORIZED, "single sign-on is required"),
        Err(r) => return r,
    };
    let person = match o.sso.linked_person(&login).await {
        Ok(Some((person, false))) => person,
        Ok(Some(_)) => return error(StatusCode::FORBIDDEN, "disabled at your organisation's identity provider"),
        Ok(None) => return error(StatusCode::FORBIDDEN, "this single sign-on identity is not a member yet"),
        Err(_) => return StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    };
    let proof = core::device_proof_message(&org, &core::link_binding(&request.link), &person, &request.device, &request.agreement);
    if !core::ed25519_verify(&request.device, &proof, &request.proof) {
        return error(StatusCode::FORBIDDEN, "the new device did not prove possession of its key");
    }
    let stored = serde_json::json!({"device": request.device, "agreement": request.agreement, "proof": request.proof, "mac": request.mac, "via": "sso", "email": login.email.as_ref().filter(|_| login.email_verified), "provider": login.provider});
    let result = async {
        let mut tx = o.store.pool.begin().await?;
        sqlx::query("DELETE FROM device_links WHERE org = $1 AND expires < now()").bind(&org).execute(&mut *tx).await?;
        let open: i64 = sqlx::query_scalar("SELECT count(*) FROM device_links WHERE org = $1 AND person = $2").bind(&org).bind(&person).fetch_one(&mut *tx).await?;
        if open >= MAX_LINKS_PER_PERSON {
            return Ok(false);
        }
        let inserted = sqlx::query("INSERT INTO device_links (org, link, person, link_key, expires, request) VALUES ($1, $2, $3, $4, now() + make_interval(secs => $5), $6) ON CONFLICT DO NOTHING")
            .bind(&org)
            .bind(&request.link)
            .bind(&person)
            .bind(&request.device)
            .bind(LINK_SECONDS as f64)
            .bind(&stored)
            .execute(&mut *tx)
            .await?;
        tx.commit().await?;
        Ok::<_, sqlx::Error>(inserted.rows_affected() == 1)
    }
    .await;
    match result {
        Ok(true) => {
            o.changed(&org);
            (StatusCode::ACCEPTED, Json(serde_json::json!({"person": person}))).into_response()
        }
        Ok(false) => error(StatusCode::TOO_MANY_REQUESTS, "too many open device requests"),
        Err(_) => StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    }
}
/// The open device requests of this device's person, waiting for approval.
async fn list_links(State(o): State<Shared>, Path(org): Path<String>, headers: HeaderMap) -> Response {
    let session = match o.session(&headers) {
        Ok(s) => s,
        Err(r) => return r,
    };
    if session.org != org {
        return error(StatusCode::FORBIDDEN, "wrong organisation");
    }
    let person = {
        let slot = match o.slot(&org).await {
            Ok(slot) => slot,
            Err(r) => return r,
        };
        let mut guard = slot.lock().await;
        let state = match o.state(&mut guard, &org).await {
            Ok(s) => s,
            Err(r) => return r,
        };
        match Orgs::role(state, &session) {
            Ok(KeyRole::Device { person }) => person,
            Ok(_) => return error(StatusCode::FORBIDDEN, "only a device can add another"),
            Err(r) => return r,
        }
    };
    match sqlx::query("SELECT link, request FROM device_links WHERE org = $1 AND person = $2 AND expires > now() ORDER BY expires").bind(&org).bind(&person).fetch_all(&o.store.pool).await {
        Ok(rows) => Json(serde_json::json!({"links": rows.iter().map(|r| serde_json::json!({"link": r.get::<String, _>(0), "request": r.get::<Option<serde_json::Value>, _>(1)})).collect::<Vec<_>>()})).into_response(),
        Err(_) => StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    }
}

/// The member directory: the email the identity provider vouched for (verified emails only;
/// `null` otherwise) and which configured provider it came from (an equal email at two providers
/// is two accounts), by person (names in the log are sealed). An administrator's app shows it
/// beside a join request, and members see whom they share with. Device sessions only.
async fn identities(State(o): State<Shared>, Path(org): Path<String>, headers: HeaderMap) -> Response {
    let session = match o.session(&headers) {
        Ok(s) => s,
        Err(r) => return r,
    };
    if session.org != org {
        return error(StatusCode::FORBIDDEN, "wrong organisation");
    }
    {
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
            return error(StatusCode::FORBIDDEN, "only a device can read the directory");
        }
    }
    let rows = sqlx::query(
        "SELECT l.person, CASE WHEN a.email_verified THEN a.email END, a.provider FROM sso_links l
         LEFT JOIN accounts a ON a.issuer = l.issuer AND a.subject = l.subject WHERE l.org = $1 ORDER BY a.last_seen",
    )
    .bind(&org)
    .fetch_all(&o.store.pool)
    .await;
    let deployment = o.store.config.deployment.as_ref();
    match rows {
        Ok(rows) => {
            let people = rows.iter().map(|r| {
                let provider: Option<String> = r.get(2);
                let label = provider.as_deref().and_then(|p| deployment?.provider(p)).map(|p| p.label.clone());
                (r.get::<String, _>(0), serde_json::json!({"email": r.get::<Option<String>, _>(1), "provider": provider, "providerLabel": label}))
            });
            Json(serde_json::json!({"people": people.collect::<serde_json::Map<_, _>>()})).into_response()
        }
        Err(_) => StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    }
}

pub fn routes(o: Shared) -> Router {
    Router::new()
        .route("/v1/auth/challenge", post(challenge))
        .route("/v1/auth/session", post(session))
        .route("/v1/orgs/{org}/events", get(events).post(append_event))
        .route("/v1/orgs/{org}/keys", get(get_wraps).put(put_wraps))
        .route("/v1/orgs/{org}/keys/report", post(report_wrap))
        .route("/v1/orgs/{org}/info", get(info))
        .route("/v1/orgs/{org}/pending", get(pending))
        .route("/v1/orgs/{org}/people", get(identities))
        .route("/v1/orgs/{org}/heads", get(heads))
        .route("/v1/orgs/{org}/device-links", get(list_links))
        .route("/v1/orgs/{org}/device-links/sso", post(sso_link_request))
        .route("/v1/projects/{project}/log", get(read_log).post(append))
        .route("/v1/projects/{project}/objects/{id}", get(get_object).put(put_object))
        .with_state(o)
}
