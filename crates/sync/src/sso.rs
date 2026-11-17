//! OpenID Connect single sign-on: the service as a confidential relying party of each
//! organisation's identity provider (authorization code flow with PKCE).
//!
//! Flow: the app sends `POST /v1/sso/start` with a SHA-256 challenge of its own 32-byte
//! verifier and gets the provider's authorization URL. The provider redirects the browser to
//! `GET /v1/sso/callback`, where the service exchanges the code (client secret and its own
//! PKCE verifier), verifies the ID token ([`jose`]) and redirects back to the app with a
//! one-time grant in the URL fragment. The app redeems the grant with its verifier
//! (`POST /v1/sso/redeem`) for an SSO login token (`Authorization: ScribyraSSO <token>`).
//!
//! An SSO login proves an identity-provider subject; it is not an organisation session and
//! grants no keys. The organisation module links subjects to people ([`Sso::link`]) and closes
//! device sessions when [`Sso::revocations`] fires. A background task rechecks logins that hold
//! a refresh token: when the provider refuses it (`invalid_grant`, for example because the
//! account was disabled) the login is revoked and the link blocked.
//!
//! Never logged: tokens, codes, client secrets, ID tokens, emails or provider error text.
pub mod jose;

use crate::{config::Config, store::Store, store::StoreError};
use axum::{
    Form, Json, Router,
    extract::{Path, Query, State},
    http::{HeaderMap, HeaderValue, StatusCode, header},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use jose::{ClaimError, Expect, Identity, JoseError};
use serde::Deserialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use sqlx::Row;
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use subtle::ConstantTimeEq;
use tokio::sync::{Semaphore, broadcast};

const FLOW_SECONDS: u64 = 600;
const GRANT_SECONDS: u64 = 120;
const MAX_FLOWS: usize = 4096;
const MAX_FLOWS_PER_ORG: usize = 256;
const MAX_GRANTS: usize = 4096;
const MAX_LOGOUT_JTIS: usize = 4096;
const DISCOVERY_SECONDS: u64 = 3600;
const JWKS_SECONDS: u64 = 3600;
const HTTP_SECONDS: u64 = 10;
const MAX_DOCUMENT_BYTES: u64 = 256 * 1024;
const MAX_OUTBOUND: usize = 16;
const RECHECK_BATCH: i64 = 200;
pub const DEFAULT_SESSION_SECONDS: i32 = 12 * 3600;
pub const DEFAULT_RECHECK_SECONDS: i32 = 600;
const BASE_SCOPES: &str = "openid email profile";

/// An organisation's sign-in policy, as the app and the org module need it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Policy {
    /// Members must sign in with SSO (enforced by the org module).
    pub required: bool,
    pub issuer: String,
    /// People added at or before this membership log position may be linked on first sign-in.
    pub linked_before: u64,
}
/// A valid (unexpired, unrevoked) SSO login.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Login {
    pub org: String,
    pub issuer: String,
    pub subject: String,
    pub email: Option<String>,
    pub email_verified: bool,
    pub name: Option<String>,
    pub groups: Vec<String>,
    pub expires: SystemTime,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LinkError {
    /// The subject is linked to another person, or the person to another subject.
    Conflict,
    /// The person ID is not 64 lowercase hex.
    Invalid,
    Store(StoreError),
}
impl From<sqlx::Error> for LinkError {
    fn from(_: sqlx::Error) -> Self {
        Self::Store(StoreError::Internal)
    }
}

/// Per-organisation identity provider settings (table `org_sso`).
#[derive(Clone)]
struct Settings {
    issuer: String,
    client_id: String,
    client_secret: String,
    required: bool,
    email_domain: Option<String>,
    groups_claim: Option<String>,
    session_seconds: i32,
    scopes: String,
    linked_before: i64,
}
/// The endpoints named by a provider's discovery document.
#[derive(Clone)]
struct Provider {
    authorization_endpoint: String,
    token_endpoint: String,
    jwks_uri: String,
}
struct Flow {
    org: String,
    issuer: String,
    return_to: String,
    challenge: String,
    nonce: String,
    verifier: String,
    until: Instant,
}
struct Grant {
    org: String,
    issuer: String,
    challenge: String,
    identity: Identity,
    refresh_token: Option<String>,
    session_seconds: i32,
    until: Instant,
}
struct Keys {
    keys: Arc<Vec<jose::Jwk>>,
    fetched: Instant,
}

/// The SSO relying party. Create one per service with [`Sso::new`] and share it.
pub struct Sso {
    store: Arc<Store>,
    origins: Vec<String>,
    public_url: Option<String>,
    agent: ureq::Agent,
    outbound: Arc<Semaphore>,
    jwks_refetch: Duration,
    recheck_tick: Duration,
    discovery: Mutex<HashMap<String, (Provider, Instant)>>,
    jwks: Mutex<HashMap<String, Keys>>,
    flows: Mutex<HashMap<String, Flow>>,
    grants: Mutex<HashMap<String, Grant>>,
    logout_jtis: Mutex<HashMap<String, Instant>>,
    revoked: broadcast::Sender<(String, String)>,
}
type Shared = Arc<Sso>;

fn now_seconds() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0)
}
fn random_bytes() -> [u8; 32] {
    let mut bytes = [0u8; 32];
    getrandom::fill(&mut bytes).expect("operating system randomness");
    bytes
}
fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}
fn random_hex() -> String {
    hex(&random_bytes())
}
fn sha256_hex(bytes: &[u8]) -> String {
    hex(&Sha256::digest(bytes))
}
fn is_hex64(text: &str) -> bool {
    text.len() == 64 && text.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
fn decode_hex(text: &str) -> Option<Vec<u8>> {
    if !text.len().is_multiple_of(2) {
        return None;
    }
    (0..text.len()).step_by(2).map(|i| u8::from_str_radix(text.get(i..i + 2)?, 16).ok()).collect()
}
/// `https`, or `http` only on a loopback host; no credentials or fragment.
pub fn secure_url(text: &str) -> bool {
    let Ok(url) = url::Url::parse(text) else { return false };
    let loopback = matches!(url.host(), Some(url::Host::Domain("localhost")))
        || matches!(url.host(), Some(url::Host::Ipv4(ip)) if ip.is_loopback())
        || matches!(url.host(), Some(url::Host::Ipv6(ip)) if ip.is_loopback());
    (url.scheme() == "https" || url.scheme() == "http" && loopback)
        && url.host().is_some()
        && url.username().is_empty()
        && url.password().is_none()
        && url.fragment().is_none()
}
/// Fixed-field log line; `reason` is always one of this module's static codes.
fn log(event: &'static str, reason: &'static str) {
    println!("{}", json!({"event": event, "reason": reason}));
}
fn error(status: StatusCode, message: &'static str) -> Response {
    (status, [(header::CACHE_CONTROL, "no-store")], Json(json!({"error": message}))).into_response()
}
fn internal<E>(_: E) -> Response {
    error(StatusCode::INTERNAL_SERVER_ERROR, "internal error")
}
fn form_encode(text: &str) -> String {
    url::form_urlencoded::byte_serialize(text.as_bytes()).collect()
}

enum Outbound {
    Get(String),
    /// A token endpoint request authenticated with `client_secret_basic`.
    Token { url: String, client_id: String, client_secret: String, form: Vec<(&'static str, String)> },
}
/// An outbound call failed before an HTTP status arrived (network, TLS, size, timeout).
struct Unreachable;

impl Sso {
    pub fn new(store: Arc<Store>) -> Shared {
        let config: &Config = &store.config;
        let agent = ureq::Agent::config_builder()
            .http_status_as_error(false)
            .max_redirects(0)
            .timeout_global(Some(Duration::from_secs(HTTP_SECONDS)))
            .user_agent("scribyra-sync")
            .build()
            .into();
        Arc::new(Self {
            origins: config.origins.clone(),
            public_url: config.public_url.clone(),
            jwks_refetch: Duration::from_secs(config.sso_jwks_refetch_seconds),
            recheck_tick: Duration::from_secs(config.sso_recheck_tick_seconds),
            store,
            agent,
            outbound: Arc::new(Semaphore::new(MAX_OUTBOUND)),
            discovery: Mutex::default(),
            jwks: Mutex::default(),
            flows: Mutex::default(),
            grants: Mutex::default(),
            logout_jtis: Mutex::default(),
            revoked: broadcast::channel(1024).0,
        })
    }

    /// The organisation's SSO policy, or `None` when SSO is not configured for it.
    pub async fn policy(&self, org: &str) -> Result<Option<Policy>, StoreError> {
        Ok(self.settings(org).await?.map(|s| Policy { required: s.required, issuer: s.issuer, linked_before: s.linked_before as u64 }))
    }
    /// The login for a bearer token, if it is valid, unexpired and unrevoked and its org still
    /// uses the provider that issued it.
    pub async fn login(&self, token: &str) -> Result<Option<Login>, StoreError> {
        if !is_hex64(token) {
            return Ok(None);
        }
        let row = sqlx::query(
            "SELECT l.org, l.issuer, l.subject, l.email, l.email_verified, l.name, l.groups::text,
                    extract(epoch FROM l.expires)::bigint
             FROM sso_logins l JOIN org_sso s ON s.org = l.org AND s.issuer = l.issuer
             WHERE l.token_hash = $1 AND NOT l.revoked AND l.expires > now()",
        )
        .bind(sha256_hex(token.as_bytes()))
        .fetch_optional(&self.store.pool)
        .await?;
        Ok(row.map(|row| Login {
            org: row.get(0),
            issuer: row.get(1),
            subject: row.get(2),
            email: row.get(3),
            email_verified: row.get(4),
            name: row.get(5),
            groups: serde_json::from_str(&row.get::<String, _>(6)).unwrap_or_default(),
            expires: UNIX_EPOCH + Duration::from_secs(row.get::<i64, _>(7).max(0) as u64),
        }))
    }
    /// The person this login's subject is linked to, and whether that link is blocked.
    pub async fn linked_person(&self, login: &Login) -> Result<Option<(String, bool)>, StoreError> {
        let row = sqlx::query("SELECT person, state FROM sso_links WHERE org = $1 AND issuer = $2 AND subject = $3")
            .bind(&login.org)
            .bind(&login.issuer)
            .bind(&login.subject)
            .fetch_optional(&self.store.pool)
            .await?;
        Ok(row.map(|r| (r.get(0), r.get::<String, _>(1) == "blocked")))
    }
    /// Links the SSO subject to a person: Ok if newly linked or already linked to the same
    /// person (a blocked link stays blocked); Err(Conflict) if the subject or the person is
    /// linked elsewhere.
    pub async fn link(&self, login: &Login, person: &str) -> Result<(), LinkError> {
        if !scribyra_core::orgsync::is_uuid(person) {
            return Err(LinkError::Invalid);
        }
        let mut tx = self.store.pool.begin().await?;
        let existing = sqlx::query("SELECT issuer, subject, person FROM sso_links WHERE org = $1 AND ((issuer = $2 AND subject = $3) OR person = $4) FOR UPDATE")
            .bind(&login.org)
            .bind(&login.issuer)
            .bind(&login.subject)
            .bind(person)
            .fetch_all(&mut *tx)
            .await?;
        for row in &existing {
            let same = row.get::<String, _>(0) == login.issuer && row.get::<String, _>(1) == login.subject && row.get::<String, _>(2) == person;
            if !same {
                return Err(LinkError::Conflict);
            }
        }
        if existing.is_empty() {
            let inserted = sqlx::query("INSERT INTO sso_links (org, issuer, subject, person, email) VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING")
                .bind(&login.org)
                .bind(&login.issuer)
                .bind(&login.subject)
                .bind(person)
                .bind(&login.email)
                .execute(&mut *tx)
                .await?;
            // A concurrent link of the same subject or person won the race.
            if inserted.rows_affected() == 0 {
                return Err(LinkError::Conflict);
            }
        }
        tx.commit().await?;
        Ok(())
    }
    /// The SSO identity linked to a person, if any: (issuer, subject, blocked).
    pub async fn person_link(&self, org: &str, person: &str) -> Result<Option<(String, String, bool)>, StoreError> {
        let row = sqlx::query("SELECT issuer, subject, state FROM sso_links WHERE org = $1 AND person = $2").bind(org).bind(person).fetch_optional(&self.store.pool).await?;
        Ok(row.map(|r| (r.get(0), r.get(1), r.get::<String, _>(2) == "blocked")))
    }
    /// Removes the person's link (also clearing a block); a later login can link again.
    pub async fn unlink(&self, org: &str, person: &str) -> Result<(), StoreError> {
        sqlx::query("DELETE FROM sso_links WHERE org = $1 AND person = $2").bind(org).bind(person).execute(&self.store.pool).await?;
        Ok(())
    }
    /// Fires (org, person) whenever a login of a linked person is revoked or a link is
    /// blocked, so device sessions can be closed. Logins of unlinked subjects fire nothing.
    pub fn revocations(&self) -> broadcast::Receiver<(String, String)> {
        self.revoked.subscribe()
    }

    async fn settings(&self, org: &str) -> Result<Option<Settings>, StoreError> {
        let row = sqlx::query("SELECT issuer, client_id, client_secret, required, email_domain, groups_claim, session_seconds, scopes, linked_before FROM org_sso WHERE org = $1")
            .bind(org)
            .fetch_optional(&self.store.pool)
            .await?;
        Ok(row.map(|r| Settings {
            issuer: r.get(0),
            client_id: r.get(1),
            client_secret: r.get(2),
            required: r.get(3),
            email_domain: r.get(4),
            groups_claim: r.get(5),
            session_seconds: r.get(6),
            scopes: r.get(7),
            linked_before: r.get(8),
        }))
    }
    async fn org_exists(&self, org: &str) -> Result<bool, StoreError> {
        let found: Option<i32> = sqlx::query_scalar("SELECT 1 FROM orgs WHERE org = $1").bind(org).fetch_optional(&self.store.pool).await?;
        Ok(found.is_some())
    }

    /// One outbound HTTP call on a blocking thread; returns (status, body).
    async fn call(&self, request: Outbound) -> Result<(u16, Vec<u8>), Unreachable> {
        let permit = self.outbound.clone().acquire_owned().await.map_err(|_| Unreachable)?;
        let agent = self.agent.clone();
        tokio::task::spawn_blocking(move || {
            let _permit = permit;
            let response = match request {
                Outbound::Get(url) => agent.get(&url).header("Accept", "application/json").call(),
                Outbound::Token { url, client_id, client_secret, form } => {
                    // RFC 6749 section 2.3.1: form-encode each part before base64.
                    let basic = base64::Engine::encode(
                        &base64::engine::general_purpose::STANDARD,
                        format!("{}:{}", form_encode(&client_id), form_encode(&client_secret)),
                    );
                    agent
                        .post(&url)
                        .header("Authorization", &format!("Basic {basic}"))
                        .header("Accept", "application/json")
                        .send_form(form.iter().map(|(k, v)| (*k, v.as_str())))
                }
            };
            let mut response = response.map_err(|_| Unreachable)?;
            let status = response.status().as_u16();
            let body = response.body_mut().with_config().limit(MAX_DOCUMENT_BYTES).read_to_vec().map_err(|_| Unreachable)?;
            Ok((status, body))
        })
        .await
        .map_err(|_| Unreachable)?
    }
    /// The provider's discovery document, cached for an hour. Its `issuer` must equal the
    /// configured issuer exactly and every endpoint must be https (http only on loopback).
    async fn provider(&self, issuer: &str) -> Result<Provider, &'static str> {
        if let Some((provider, fetched)) = self.discovery.lock().unwrap().get(issuer)
            && fetched.elapsed() < Duration::from_secs(DISCOVERY_SECONDS)
        {
            return Ok(provider.clone());
        }
        let url = format!("{}/.well-known/openid-configuration", issuer.trim_end_matches('/'));
        let (status, body) = self.call(Outbound::Get(url)).await.map_err(|_| "unavailable")?;
        if status != 200 {
            return Err("unavailable");
        }
        let document: Value = serde_json::from_slice(&body).map_err(|_| "discovery")?;
        let field = |name: &str| document.get(name).and_then(Value::as_str).filter(|u| secure_url(u)).map(str::to_owned);
        if document.get("issuer").and_then(Value::as_str) != Some(issuer) {
            log("sso_refused", "discovery_issuer");
            return Err("discovery");
        }
        let provider = Provider {
            authorization_endpoint: field("authorization_endpoint").ok_or("discovery")?,
            token_endpoint: field("token_endpoint").ok_or("discovery")?,
            jwks_uri: field("jwks_uri").ok_or("discovery")?,
        };
        self.discovery.lock().unwrap().insert(issuer.to_owned(), (provider.clone(), Instant::now()));
        Ok(provider)
    }
    /// The provider's keys: cached for an hour; `refresh` refetches them unless they were
    /// fetched less than `sso_jwks_refetch_seconds` ago (one refetch a minute by default).
    async fn keys(&self, uri: &str, refresh: bool) -> Result<Arc<Vec<jose::Jwk>>, &'static str> {
        if let Some(cached) = self.jwks.lock().unwrap().get(uri) {
            let age = cached.fetched.elapsed();
            if (!refresh && age < Duration::from_secs(JWKS_SECONDS)) || (refresh && age < self.jwks_refetch) {
                return Ok(cached.keys.clone());
            }
        }
        let (status, body) = self.call(Outbound::Get(uri.to_owned())).await.map_err(|_| "unavailable")?;
        if status != 200 {
            return Err("unavailable");
        }
        let keys = Arc::new(jose::parse_jwks(&body).map_err(|_| "unavailable")?);
        self.jwks.lock().unwrap().insert(uri.to_owned(), Keys { keys: keys.clone(), fetched: Instant::now() });
        Ok(keys)
    }
    /// Verify a JWS from this provider, refetching the key set once on an unknown `kid`.
    async fn verify(&self, provider: &Provider, token: &str) -> Result<jose::Verified, &'static str> {
        let keys = self.keys(&provider.jwks_uri, false).await?;
        let result = match jose::verify(token, &keys) {
            Err(JoseError::UnknownKey) => {
                let fresh = self.keys(&provider.jwks_uri, true).await?;
                jose::verify(token, &fresh)
            }
            other => other,
        };
        result.map_err(|e| {
            log(
                "sso_refused",
                match e {
                    JoseError::Malformed => "jws_malformed",
                    JoseError::Algorithm => "jws_algorithm",
                    JoseError::UnknownKey => "jws_unknown_key",
                    JoseError::AmbiguousKey => "jws_ambiguous_key",
                    JoseError::KeyMismatch => "jws_key_mismatch",
                    JoseError::Signature => "jws_signature",
                },
            );
            "id_token"
        })
    }
    /// Revoke logins and fire the hook for each linked person whose login ended.
    async fn revoke_where(&self, sql: &str, binds: &[Option<&str>], block: bool) -> Result<u64, StoreError> {
        let mut query = sqlx::query(sql);
        for bind in binds {
            query = query.bind(*bind);
        }
        let mut tx = self.store.pool.begin().await?;
        let rows = query.fetch_all(&mut *tx).await?;
        let mut fired = Vec::new();
        for row in &rows {
            let (org, issuer, subject): (String, String, String) = (row.get(0), row.get(1), row.get(2));
            let person: Option<String> = if block {
                sqlx::query_scalar("UPDATE sso_links SET state = 'blocked' WHERE org = $1 AND issuer = $2 AND subject = $3 RETURNING person")
            } else {
                sqlx::query_scalar("SELECT person FROM sso_links WHERE org = $1 AND issuer = $2 AND subject = $3")
            }
            .bind(&org)
            .bind(&issuer)
            .bind(&subject)
            .fetch_optional(&mut *tx)
            .await?;
            if let Some(person) = person {
                fired.push((org, person));
            }
        }
        tx.commit().await?;
        fired.dedup();
        for event in fired {
            let _ = self.revoked.send(event);
        }
        Ok(rows.len() as u64)
    }

    /// Start the background recheck (every `sso_recheck_tick_seconds`, default one minute).
    pub fn spawn_recheck(self: &Arc<Self>) -> tokio::task::JoinHandle<()> {
        let sso = self.clone();
        tokio::spawn(async move {
            loop {
                tokio::time::sleep(sso.recheck_tick).await;
                sso.recheck().await;
            }
        })
    }
    /// One recheck pass: refresh each unrevoked login whose last check is older than its org's
    /// `recheck_seconds`. A refused refresh token (`invalid_grant`) revokes every login of
    /// that subject and blocks its link; any other 4xx revokes that login only; network and
    /// server errors keep the login and retry on the next pass.
    pub async fn recheck(&self) {
        // Expired or revoked logins are kept a week for operators, then deleted.
        let _ = sqlx::query("DELETE FROM sso_logins WHERE expires < now() - interval '7 days' OR (revoked AND created < now() - interval '7 days')")
            .execute(&self.store.pool)
            .await;
        let rows = sqlx::query(
            "SELECT l.token_hash, l.org, l.issuer, l.subject, l.refresh_token
             FROM sso_logins l JOIN org_sso s ON s.org = l.org AND s.issuer = l.issuer
             WHERE NOT l.revoked AND l.refresh_token IS NOT NULL AND l.expires > now()
               AND l.checked <= now() - make_interval(secs => s.recheck_seconds)
             ORDER BY l.checked LIMIT $1",
        )
        .bind(RECHECK_BATCH)
        .fetch_all(&self.store.pool)
        .await;
        let Ok(rows) = rows else {
            log("sso_recheck_failed", "database");
            return;
        };
        let (mut refreshed, mut revoked, mut failed) = (0u32, 0u32, 0u32);
        for row in &rows {
            let (token_hash, org, issuer, subject, refresh): (String, String, String, String, String) = (row.get(0), row.get(1), row.get(2), row.get(3), row.get(4));
            let Ok(Some(settings)) = self.settings(&org).await else {
                failed += 1;
                continue;
            };
            let Ok(provider) = self.provider(&settings.issuer).await else {
                failed += 1;
                continue;
            };
            let outcome = self
                .call(Outbound::Token {
                    url: provider.token_endpoint,
                    client_id: settings.client_id,
                    client_secret: settings.client_secret,
                    form: vec![("grant_type", "refresh_token".into()), ("refresh_token", refresh)],
                })
                .await;
            let result = match outcome {
                Ok((200, body)) => {
                    let rotated = serde_json::from_slice::<Value>(&body).ok().and_then(|v| v.get("refresh_token").and_then(Value::as_str).map(str::to_owned));
                    refreshed += 1;
                    sqlx::query("UPDATE sso_logins SET checked = now(), refresh_token = COALESCE($2, refresh_token) WHERE token_hash = $1")
                        .bind(&token_hash)
                        .bind(rotated)
                        .execute(&self.store.pool)
                        .await
                        .map(|_| ())
                        .map_err(StoreError::from)
                }
                // 408 and 429 are transient: keep the login and retry on the next pass.
                Ok((status, body)) if (400..500).contains(&status) && status != 408 && status != 429 => {
                    revoked += 1;
                    let invalid_grant = serde_json::from_slice::<Value>(&body).ok().is_some_and(|v| v.get("error").and_then(Value::as_str) == Some("invalid_grant"));
                    if invalid_grant {
                        self.revoke_where(
                            "UPDATE sso_logins SET revoked = true WHERE org = $1 AND issuer = $2 AND subject = $3 AND NOT revoked RETURNING org, issuer, subject",
                            &[Some(&org), Some(&issuer), Some(&subject)],
                            true,
                        )
                        .await
                        .map(|_| ())
                    } else {
                        self.revoke_where("UPDATE sso_logins SET revoked = true WHERE token_hash = $1 AND NOT revoked RETURNING org, issuer, subject", &[Some(&token_hash)], false)
                            .await
                            .map(|_| ())
                    }
                }
                _ => {
                    failed += 1;
                    Ok(())
                }
            };
            if result.is_err() {
                failed += 1;
            }
        }
        if !rows.is_empty() {
            println!("{}", json!({"event": "sso_recheck", "checked": rows.len(), "refreshed": refreshed, "revoked": revoked, "failed": failed}));
        }
    }
}

fn login_json(login: &Login, link: Option<(String, bool)>) -> Value {
    let state = match &link {
        None => "unlinked",
        Some((_, false)) => "linked",
        Some((_, true)) => "blocked",
    };
    json!({
        "expires": login.expires.duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0),
        "org": login.org,
        "subject": {"email": login.email, "name": login.name, "groups": login.groups},
        "person": link.map(|(p, _)| p),
        "state": state,
    })
}
/// The SSO login token from `Authorization: ScribyraSSO <token>`, if well formed.
pub fn bearer(headers: &HeaderMap) -> Option<&str> {
    headers.get(header::AUTHORIZATION).and_then(|v| v.to_str().ok()).and_then(|v| v.strip_prefix("ScribyraSSO ")).filter(|t| is_hex64(t))
}

async fn policy_route(State(s): State<Shared>, Path(org): Path<String>) -> Response {
    if !is_hex64(&org) {
        return error(StatusCode::BAD_REQUEST, "invalid organisation");
    }
    match s.org_exists(&org).await {
        Ok(true) => {}
        Ok(false) => return error(StatusCode::NOT_FOUND, "unknown organisation"),
        Err(e) => return internal(e),
    }
    match s.settings(&org).await {
        Ok(Some(settings)) => Json(json!({"enabled": true, "required": settings.required, "issuer": settings.issuer})).into_response(),
        Ok(None) => Json(json!({"enabled": false, "required": false, "issuer": null})).into_response(),
        Err(e) => internal(e),
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct StartRequest {
    org: String,
    #[serde(rename = "return")]
    return_to: String,
    challenge: String,
}
async fn start(State(s): State<Shared>, Json(request): Json<StartRequest>) -> Response {
    let Some(public_url) = s.public_url.clone() else {
        return error(StatusCode::NOT_FOUND, "single sign-on needs public_url on this service");
    };
    if !is_hex64(&request.org) || !is_hex64(&request.challenge) {
        return error(StatusCode::BAD_REQUEST, "invalid request");
    }
    if !s.origins.contains(&request.return_to) {
        return error(StatusCode::BAD_REQUEST, "return origin not allowed");
    }
    let settings = match s.settings(&request.org).await {
        Ok(Some(settings)) => settings,
        Ok(None) => return error(StatusCode::NOT_FOUND, "single sign-on is not configured"),
        Err(e) => return internal(e),
    };
    let provider = match s.provider(&settings.issuer).await {
        Ok(p) => p,
        Err(_) => return error(StatusCode::BAD_GATEWAY, "identity provider unavailable"),
    };
    let (state, nonce) = (random_hex(), random_hex());
    let verifier = jose::b64_encode(&random_bytes());
    let idp_challenge = jose::b64_encode(&Sha256::digest(verifier.as_bytes()));
    let Ok(mut url) = url::Url::parse(&provider.authorization_endpoint) else {
        return error(StatusCode::BAD_GATEWAY, "identity provider unavailable");
    };
    let mut scope = BASE_SCOPES.to_string();
    if settings.scopes.split(' ').any(|s| s == "offline_access") {
        scope.push_str(" offline_access");
    }
    url.query_pairs_mut()
        .append_pair("response_type", "code")
        .append_pair("client_id", &settings.client_id)
        .append_pair("redirect_uri", &format!("{public_url}/v1/sso/callback"))
        .append_pair("scope", &scope)
        .append_pair("state", &state)
        .append_pair("nonce", &nonce)
        .append_pair("code_challenge", &idp_challenge)
        .append_pair("code_challenge_method", "S256");
    {
        let mut flows = s.flows.lock().unwrap();
        let now = Instant::now();
        flows.retain(|_, f| f.until > now);
        if flows.len() >= MAX_FLOWS || flows.values().filter(|f| f.org == request.org).count() >= MAX_FLOWS_PER_ORG {
            return error(StatusCode::SERVICE_UNAVAILABLE, "too many sign-ins in progress");
        }
        flows.insert(
            state,
            Flow {
                org: request.org,
                issuer: settings.issuer,
                return_to: request.return_to,
                challenge: request.challenge,
                nonce,
                verifier,
                until: now + Duration::from_secs(FLOW_SECONDS),
            },
        );
    }
    (StatusCode::OK, [(header::CACHE_CONTROL, "no-store")], Json(json!({"url": url.as_str()}))).into_response()
}

fn redirect(location: String) -> Response {
    let Ok(value) = HeaderValue::from_str(&location) else {
        return error(StatusCode::INTERNAL_SERVER_ERROR, "internal error");
    };
    (
        StatusCode::FOUND,
        [(header::LOCATION, value), (header::CACHE_CONTROL, HeaderValue::from_static("no-store")), (header::REFERRER_POLICY, HeaderValue::from_static("no-referrer"))],
    )
        .into_response()
}
fn fail(return_to: &str, code: &'static str) -> Response {
    log("sso_refused", code);
    redirect(format!("{return_to}/#scribyra-sso-error={code}"))
}
async fn callback(State(s): State<Shared>, Query(query): Query<HashMap<String, String>>) -> Response {
    // Single use: the state is consumed whatever happens next.
    let flow = query.get("state").and_then(|state| s.flows.lock().unwrap().remove(state));
    let Some(flow) = flow else {
        log("sso_refused", "state");
        return error(StatusCode::BAD_REQUEST, "unknown or expired sign-in");
    };
    if flow.until <= Instant::now() {
        return fail(&flow.return_to, "expired");
    }
    if query.contains_key("error") {
        return fail(&flow.return_to, "idp_error");
    }
    // RFC 9207: a provider that names itself in the response must name the right issuer.
    if query.get("iss").is_some_and(|iss| *iss != flow.issuer) {
        return fail(&flow.return_to, "idp_error");
    }
    let Some(code) = query.get("code").filter(|c| !c.is_empty() && c.len() <= 4096) else {
        return fail(&flow.return_to, "idp_error");
    };
    let settings = match s.settings(&flow.org).await {
        Ok(Some(settings)) if settings.issuer == flow.issuer => settings,
        Ok(_) => return fail(&flow.return_to, "not_configured"),
        Err(_) => return fail(&flow.return_to, "unavailable"),
    };
    let provider = match s.provider(&settings.issuer).await {
        Ok(p) => p,
        Err(code) => return fail(&flow.return_to, code),
    };
    let Some(public_url) = s.public_url.clone() else { return fail(&flow.return_to, "not_configured") };
    let exchanged = s
        .call(Outbound::Token {
            url: provider.token_endpoint.clone(),
            client_id: settings.client_id.clone(),
            client_secret: settings.client_secret.clone(),
            form: vec![
                ("grant_type", "authorization_code".into()),
                ("code", code.clone()),
                ("redirect_uri", format!("{public_url}/v1/sso/callback")),
                ("code_verifier", flow.verifier.clone()),
            ],
        })
        .await;
    let body = match exchanged {
        Ok((200, body)) => body,
        Ok(_) => return fail(&flow.return_to, "token_exchange"),
        Err(_) => return fail(&flow.return_to, "unavailable"),
    };
    let tokens: Value = serde_json::from_slice(&body).unwrap_or(Value::Null);
    let Some(id_token) = tokens.get("id_token").and_then(Value::as_str) else {
        return fail(&flow.return_to, "token_exchange");
    };
    let verified = match s.verify(&provider, id_token).await {
        Ok(v) => v,
        Err(code) => return fail(&flow.return_to, code),
    };
    let expect = Expect {
        issuer: &settings.issuer,
        client_id: &settings.client_id,
        nonce: Some(&flow.nonce),
        email_domain: settings.email_domain.as_deref(),
        groups_claim: settings.groups_claim.as_deref(),
        now: now_seconds(),
    };
    let identity = match jose::check_id_token(&verified.claims, &expect) {
        Ok(identity) => identity,
        Err(e) => {
            log(
                "sso_refused",
                match e {
                    ClaimError::Issuer => "claim_iss",
                    ClaimError::Audience => "claim_aud",
                    ClaimError::Expired => "claim_exp",
                    ClaimError::IssuedAt => "claim_iat",
                    ClaimError::Nonce => "claim_nonce",
                    ClaimError::Subject => "claim_sub",
                    _ => "claim_email",
                },
            );
            return fail(&flow.return_to, e.code());
        }
    };
    let refresh_token = tokens.get("refresh_token").and_then(Value::as_str).filter(|t| t.len() <= 8192).map(str::to_owned);
    let grant = random_hex();
    {
        let mut grants = s.grants.lock().unwrap();
        let now = Instant::now();
        grants.retain(|_, g| g.until > now);
        if grants.len() >= MAX_GRANTS {
            drop(grants);
            return fail(&flow.return_to, "unavailable");
        }
        grants.insert(
            grant.clone(),
            Grant {
                org: flow.org.clone(),
                issuer: settings.issuer,
                challenge: flow.challenge,
                identity,
                refresh_token,
                session_seconds: settings.session_seconds,
                until: now + Duration::from_secs(GRANT_SECONDS),
            },
        );
    }
    log("sso_callback", "ok");
    redirect(format!("{}/#scribyra-sso={grant}&org={}", flow.return_to, flow.org))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RedeemRequest {
    code: String,
    verifier: String,
}
async fn redeem(State(s): State<Shared>, Json(request): Json<RedeemRequest>) -> Response {
    // Single use: a redeem attempt consumes the grant even when the verifier is wrong.
    let grant = s.grants.lock().unwrap().remove(&request.code);
    let Some(grant) = grant.filter(|g| g.until > Instant::now()) else {
        return error(StatusCode::UNAUTHORIZED, "unknown or expired grant");
    };
    let Some(verifier) = decode_hex(&request.verifier).filter(|v| v.len() == 32) else {
        return error(StatusCode::UNAUTHORIZED, "wrong verifier");
    };
    if !bool::from(sha256_hex(&verifier).as_bytes().ct_eq(grant.challenge.as_bytes())) {
        return error(StatusCode::UNAUTHORIZED, "wrong verifier");
    }
    let token = random_hex();
    let id = &grant.identity;
    let row = sqlx::query(
        "INSERT INTO sso_logins (token_hash, org, issuer, subject, email, email_verified, name, groups, sid, refresh_token, expires)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, now() + make_interval(secs => $11))
         RETURNING extract(epoch FROM expires)::bigint",
    )
    .bind(sha256_hex(token.as_bytes()))
    .bind(&grant.org)
    .bind(&grant.issuer)
    .bind(&id.subject)
    .bind(&id.email)
    .bind(id.email_verified)
    .bind(&id.name)
    .bind(serde_json::to_string(&id.groups).unwrap_or_else(|_| "[]".into()))
    .bind(&id.sid)
    .bind(&grant.refresh_token)
    .bind(grant.session_seconds)
    .fetch_one(&s.store.pool)
    .await;
    let expires = match row {
        Ok(row) => row.get::<i64, _>(0),
        Err(e) => return internal(e),
    };
    let login = Login {
        org: grant.org,
        issuer: grant.issuer,
        subject: id.subject.clone(),
        email: id.email.clone(),
        email_verified: id.email_verified,
        name: id.name.clone(),
        groups: id.groups.clone(),
        expires: UNIX_EPOCH + Duration::from_secs(expires.max(0) as u64),
    };
    let link = match s.linked_person(&login).await {
        Ok(link) => link,
        Err(e) => return internal(e),
    };
    let mut body = login_json(&login, link);
    body["token"] = json!(token);
    log("sso_login", "ok");
    (StatusCode::OK, [(header::CACHE_CONTROL, "no-store")], Json(body)).into_response()
}
async fn me(State(s): State<Shared>, headers: HeaderMap) -> Response {
    let Some(token) = bearer(&headers) else { return error(StatusCode::UNAUTHORIZED, "sign in required") };
    let login = match s.login(token).await {
        Ok(Some(login)) => login,
        Ok(None) => return error(StatusCode::UNAUTHORIZED, "sign in required"),
        Err(e) => return internal(e),
    };
    match s.linked_person(&login).await {
        Ok(link) => (StatusCode::OK, [(header::CACHE_CONTROL, "no-store")], Json(login_json(&login, link))).into_response(),
        Err(e) => internal(e),
    }
}
async fn logout(State(s): State<Shared>, headers: HeaderMap) -> Response {
    let Some(token) = bearer(&headers) else { return error(StatusCode::UNAUTHORIZED, "sign in required") };
    let hash = sha256_hex(token.as_bytes());
    match s
        .revoke_where("UPDATE sso_logins SET revoked = true WHERE token_hash = $1 AND NOT revoked AND expires > now() RETURNING org, issuer, subject", &[Some(&hash)], false)
        .await
    {
        Ok(0) => error(StatusCode::UNAUTHORIZED, "sign in required"),
        Ok(_) => Json(json!({"revoked": true})).into_response(),
        Err(e) => internal(e),
    }
}
/// OpenID Connect Back-Channel Logout 1.0: the provider posts a signed `logout_token`.
async fn backchannel(State(s): State<Shared>, Form(form): Form<HashMap<String, String>>) -> Response {
    let refuse = || {
        log("sso_refused", "backchannel");
        error(StatusCode::BAD_REQUEST, "invalid_request")
    };
    let Some(token) = form.get("logout_token") else { return refuse() };
    // The unverified claims only choose which organisations' settings to verify against.
    let Ok(peek) = jose::unverified_claims(token) else { return refuse() };
    let Some(issuer) = peek.get("iss").and_then(Value::as_str) else { return refuse() };
    let rows = match sqlx::query("SELECT org, client_id FROM org_sso WHERE issuer = $1 LIMIT 100").bind(issuer).fetch_all(&s.store.pool).await {
        Ok(rows) => rows,
        Err(e) => return internal(e),
    };
    let audiences: Vec<&str> = match peek.get("aud") {
        Some(Value::String(a)) => vec![a.as_str()],
        Some(Value::Array(list)) => list.iter().filter_map(Value::as_str).collect(),
        _ => vec![],
    };
    // Only configured issuers are ever contacted: an unknown `iss` must not make the service
    // fetch an attacker-chosen URL.
    if rows.is_empty() {
        return refuse();
    }
    let Ok(provider) = s.provider(issuer).await else { return refuse() };
    let mut matched = false;
    for row in rows {
        let (org, client_id): (String, String) = (row.get(0), row.get(1));
        if !audiences.contains(&client_id.as_str()) {
            continue;
        }
        let Ok(verified) = s.verify(&provider, token).await else { return refuse() };
        let expect = Expect { issuer, client_id: &client_id, nonce: None, email_domain: None, groups_claim: None, now: now_seconds() };
        let Ok(logout) = jose::check_logout_token(&verified.claims, &expect) else { return refuse() };
        {
            let mut jtis = s.logout_jtis.lock().unwrap();
            let now = Instant::now();
            jtis.retain(|_, until| *until > now);
            let key = format!("{org}\n{}", logout.jti);
            if jtis.contains_key(&key) || jtis.len() >= MAX_LOGOUT_JTIS {
                return refuse();
            }
            jtis.insert(key, now + Duration::from_secs(900));
        }
        let revoked = s
            .revoke_where(
                "UPDATE sso_logins SET revoked = true WHERE org = $1 AND issuer = $2 AND NOT revoked
                   AND ($3::text IS NULL OR subject = $3) AND ($4::text IS NULL OR sid = $4)
                 RETURNING org, issuer, subject",
                &[Some(&org), Some(issuer), logout.subject.as_deref(), logout.sid.as_deref()],
                false,
            )
            .await;
        if revoked.is_err() {
            return internal(());
        }
        matched = true;
    }
    if !matched {
        return refuse();
    }
    log("sso_backchannel", "ok");
    (StatusCode::OK, [(header::CACHE_CONTROL, "no-store")]).into_response()
}

/// The SSO routes; merged into [`crate::service::router`].
pub fn routes(s: Shared) -> Router {
    Router::new()
        .route("/v1/orgs/{org}/sso", get(policy_route))
        .route("/v1/sso/start", post(start))
        .route("/v1/sso/callback", get(callback))
        .route("/v1/sso/redeem", post(redeem))
        .route("/v1/sso/me", get(me))
        .route("/v1/sso/logout", post(logout))
        .route("/v1/sso/backchannel", post(backchannel))
        .with_state(s)
}

/// `scribyra-sync org sso …`: set or remove an organisation's identity provider. Runs beside a
/// live service, like `org create`. Returns the JSON line to print; errors are fixed strings
/// that never contain the secret or database details.
pub async fn command(config: &Config, args: &[String]) -> Result<Value, &'static str> {
    use sqlx::Connection;
    let mut org = None;
    let (mut off, mut issuer, mut client_id, mut secret_file, mut required) = (false, None, None, None, false);
    let (mut email_domain, mut groups_claim, mut offline) = (None, None, false);
    let (mut session_seconds, mut recheck_seconds) = (DEFAULT_SESSION_SECONDS, DEFAULT_RECHECK_SECONDS);
    let mut rest = args.iter();
    while let Some(flag) = rest.next() {
        let mut value = || rest.next().cloned().ok_or("missing value for a flag");
        match flag.as_str() {
            "--org" => org = Some(value()?),
            "--off" => off = true,
            "--issuer" => issuer = Some(value()?),
            "--client-id" => client_id = Some(value()?),
            "--client-secret-file" => secret_file = Some(value()?),
            "--required" => required = true,
            "--email-domain" => email_domain = Some(value()?.to_ascii_lowercase()),
            "--groups-claim" => groups_claim = Some(value()?),
            "--offline-access" => offline = true,
            "--session-hours" => {
                let hours: i32 = value()?.parse().map_err(|_| "--session-hours takes 1-720")?;
                if !(1..=720).contains(&hours) {
                    return Err("--session-hours takes 1-720");
                }
                session_seconds = hours * 3600;
            }
            "--recheck-minutes" => {
                let minutes: i32 = value()?.parse().map_err(|_| "--recheck-minutes takes 1-1440")?;
                if !(1..=1440).contains(&minutes) {
                    return Err("--recheck-minutes takes 1-1440");
                }
                recheck_seconds = minutes * 60;
            }
            _ => return Err("unknown flag"),
        }
    }
    let org = org.filter(|o| is_hex64(o)).ok_or("--org takes an organisation ID (64 lowercase hex)")?;
    let settings = if off {
        if issuer.is_some() || client_id.is_some() || secret_file.is_some() || required || email_domain.is_some() || groups_claim.is_some() {
            return Err("--off takes no other settings");
        }
        None
    } else {
        let issuer = issuer.ok_or("--issuer is required")?;
        if issuer.len() > 512 || !secure_url(&issuer) || url::Url::parse(&issuer).is_ok_and(|u| u.query().is_some()) {
            return Err("--issuer must be an https URL (http only on loopback) without query or fragment");
        }
        let client_id = client_id.filter(|c| !c.is_empty() && c.len() <= 255 && c.bytes().all(|b| b.is_ascii_graphic())).ok_or("--client-id is required (printable, at most 255 characters)")?;
        let path = secret_file.ok_or("--client-secret-file is required")?;
        let text = std::fs::read_to_string(&path).map_err(|_| "cannot read the client secret file")?;
        let secret = text.trim_end_matches(['\n', '\r']);
        if secret.is_empty() || secret.len() > 1024 || secret.contains(['\n', '\r']) {
            return Err("the client secret file must hold one non-empty line");
        }
        if email_domain.as_ref().is_some_and(|d| d.len() > 253 || !d.contains('.') || d.starts_with(['.', '-']) || !d.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'.' || b == b'-')) {
            return Err("--email-domain must be a domain name such as example.org");
        }
        if groups_claim.as_ref().is_some_and(|c| c.is_empty() || c.len() > 128 || !c.bytes().all(|b| b.is_ascii_alphanumeric() || b"_-.:/".contains(&b))) {
            return Err("--groups-claim must be a claim name");
        }
        Some((issuer, client_id, secret.to_owned()))
    };
    let url = config.database_url().map_err(|_| "cannot read the database URL")?;
    let options: sqlx::postgres::PgConnectOptions = url.parse().map_err(|_| "invalid database URL")?;
    let mut db = sqlx::PgConnection::connect_with(&options.application_name("scribyra-sync-admin")).await.map_err(|_| "cannot connect to the database")?;
    let migrated: Option<i64> = sqlx::query_scalar("SELECT version FROM _sqlx_migrations WHERE version = 4 AND success").fetch_optional(&mut db).await.unwrap_or(None);
    if migrated.is_none() {
        return Err("start the service once so it can upgrade the database, then try again");
    }
    let exists: Option<i32> = sqlx::query_scalar("SELECT 1 FROM orgs WHERE org = $1").bind(&org).fetch_optional(&mut db).await.map_err(|_| "database error")?;
    if exists.is_none() {
        return Err("unknown organisation");
    }
    let Some((issuer, client_id, secret)) = settings else {
        sqlx::query("DELETE FROM org_sso WHERE org = $1").bind(&org).execute(&mut db).await.map_err(|_| "database error")?;
        return Ok(json!({"event": "org_sso", "org": org, "enabled": false}));
    };
    let scopes = if offline { format!("{BASE_SCOPES} offline_access") } else { BASE_SCOPES.to_owned() };
    sqlx::query(
        "INSERT INTO org_sso (org, issuer, client_id, client_secret, required, email_domain, groups_claim, session_seconds, recheck_seconds, scopes, linked_before)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, (SELECT count(*) FROM org_events WHERE org = $1))
         ON CONFLICT (org) DO UPDATE SET issuer = $2, client_id = $3, client_secret = $4, required = $5, email_domain = $6,
           groups_claim = $7, session_seconds = $8, recheck_seconds = $9, scopes = $10",
    )
    .bind(&org)
    .bind(&issuer)
    .bind(&client_id)
    .bind(&secret)
    .bind(required)
    .bind(&email_domain)
    .bind(&groups_claim)
    .bind(session_seconds)
    .bind(recheck_seconds)
    .bind(&scopes)
    .execute(&mut db)
    .await
    .map_err(|_| "database error")?;
    let redirect_uri = config.public_url.as_ref().map(|u| format!("{u}/v1/sso/callback"));
    Ok(json!({"event": "org_sso", "org": org, "enabled": true, "issuer": issuer, "required": required, "redirect_uri": redirect_uri}))
}
