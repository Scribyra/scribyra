//! OpenID Connect sign-in: the service as a confidential relying party of each provider the
//! deployment configures (authorization code flow with PKCE). It is the only way anyone signs
//! in: the service has no passwords, passkeys, setup codes or sign-in links of its own.
//!
//! Flow: the app sends `POST /v1/sso/start` with a provider ID and a SHA-256 challenge of its
//! own 32-byte verifier and gets the provider's authorization URL. The provider redirects the
//! browser to `GET /v1/sso/callback`, where the service exchanges the code (client secret and
//! its own PKCE verifier), verifies the ID token ([`jose`]), applies the deployment's guest and
//! group rules, and redirects back to the app with a one-time grant in the URL fragment. The app
//! redeems the grant with its verifier (`POST /v1/sso/redeem`) for a login token
//! (`Authorization: ScribyraSSO <token>`).
//!
//! A login proves an identity-provider subject and carries the deployment role (administrator,
//! member or guest) that the configuration and the provider's groups give it; it grants no
//! keys. The organisation module links subjects to people ([`Sso::link`]) and closes device
//! sessions when [`Sso::revocations`] fires. A background task rechecks logins that hold a
//! refresh token: when the provider refuses it (`invalid_grant`, for example because the
//! account was disabled) the login is revoked and the link blocked; when a refreshed ID token
//! shows the account no longer passes the group rules, its logins are revoked.
//!
//! Every sign-in makes or updates an **account** (`accounts`, one per provider and subject), and
//! sign-ins in progress, one-time grants and sessions live in PostgreSQL, so a sign-in started
//! on one replica can finish on another.
//!
//! Never logged: tokens, codes, client secrets, ID tokens, emails or provider error text.
pub mod jose;

use crate::{
    config::{Config, Deployment, Guests, Provider as Configured},
    store::{Store, StoreError},
};
use axum::{
    Form, Json, Router,
    extract::{Query, State},
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
const MAX_FLOWS_PER_PROVIDER: usize = 256;
/// Sign-ins in progress per client address; a further one replaces that address's oldest.
const MAX_FLOWS_PER_SOURCE: usize = 8;
const MAX_GRANTS: usize = 4096;
const MAX_LOGOUT_JTIS: usize = 4096;
const DISCOVERY_SECONDS: u64 = 3600;
const JWKS_SECONDS: u64 = 3600;
const HTTP_SECONDS: u64 = 10;
const MAX_DOCUMENT_BYTES: u64 = 256 * 1024;
const MAX_OUTBOUND: usize = 16;
const RECHECK_BATCH: i64 = 200;

/// What a login may do in the deployment (design section 3, "Accounts and roles").
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Role {
    Admin,
    Member,
    Guest,
}
impl Role {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Admin => "admin",
            Self::Member => "member",
            Self::Guest => "guest",
        }
    }
}
/// A valid (unexpired, unrevoked, still admitted) login.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Login {
    pub org: String,
    /// The account this login belongs to (logins from before accounts existed have none).
    pub account: Option<String>,
    /// The configured provider's ID.
    pub provider: String,
    pub issuer: String,
    pub subject: String,
    pub email: Option<String>,
    pub email_verified: bool,
    pub name: Option<String>,
    pub groups: Vec<String>,
    pub guest: bool,
    pub role: Role,
    pub expires: SystemTime,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LinkError {
    /// The subject is linked to another person, or the person to another subject.
    Conflict,
    /// The person ID is not a person ID.
    Invalid,
    Store(StoreError),
}
impl From<sqlx::Error> for LinkError {
    fn from(_: sqlx::Error) -> Self {
        Self::Store(StoreError::Internal)
    }
}

/// Whether an `admins` entry names this verified (lowercased) email at this provider: a plain
/// email only through a provider whose `email_domains` vouch for its domain (otherwise any
/// provider could claim it), `provider:email` through that provider only.
fn admin_email_matches(entry: &str, provider: &Configured, email: &str) -> bool {
    if entry.contains('#') {
        return false;
    }
    match entry.split_once(':') {
        Some((id, listed)) => id == provider.id && listed == email,
        None => entry == email && email.rsplit_once('@').is_some_and(|(_, domain)| provider.email_domains.iter().any(|d| d == domain)),
    }
}
/// The deployment role of an identity, or the code of the rule that refuses it: guests when the
/// deployment admits none, and people outside `member_groups` when the provider names some.
/// Administrators are the `admins` list (a verified email at a provider whose `email_domains`
/// include its domain, `provider:email`, or `issuer#subject`) and members of
/// `admin_groups`; a guest account is never an administrator.
pub fn admit(deployment: &Deployment, provider: &Configured, subject: &str, email: Option<&str>, email_verified: bool, groups: &[String], guest: bool) -> Result<Role, &'static str> {
    if guest {
        return match deployment.guests {
            Guests::Off => Err("guest"),
            Guests::Shared => Ok(Role::Guest),
        };
    }
    let pair = format!("{}#{subject}", provider.issuer);
    let email = email.filter(|_| email_verified).map(str::to_lowercase);
    let listed = deployment.admins.iter().any(|a| *a == pair || email.as_deref().is_some_and(|e| admin_email_matches(a, provider, e)));
    let admin = listed || groups.iter().any(|g| provider.admin_groups.contains(g));
    if !admin && !provider.member_groups.is_empty() && !groups.iter().any(|g| provider.member_groups.contains(g)) {
        return Err("not_member");
    }
    Ok(if admin { Role::Admin } else { Role::Member })
}

/// The endpoints named by a provider's discovery document.
#[derive(Clone)]
struct Endpoints {
    authorization_endpoint: String,
    token_endpoint: String,
    jwks_uri: String,
}
/// A sign-in in progress (a row of `sso_flows`, consumed by the callback).
struct Flow {
    provider: String,
    return_to: String,
    challenge: String,
    nonce: String,
    verifier: String,
    live: bool,
}
/// A one-time grant (a row of `sso_grants`, consumed by the redeem).
struct Grant {
    provider: String,
    challenge: String,
    identity: Identity,
    refresh_token: Option<String>,
    session_seconds: i64,
}
fn identity_json(id: &Identity) -> Value {
    json!({"subject": id.subject, "email": id.email, "email_verified": id.email_verified, "name": id.name, "groups": id.groups, "sid": id.sid, "guest": id.guest})
}
fn identity_from_json(text: &str) -> Option<Identity> {
    let v: Value = serde_json::from_str(text).ok()?;
    let text = |name: &str| v.get(name).and_then(Value::as_str).map(str::to_owned);
    Some(Identity {
        subject: text("subject")?,
        email: text("email"),
        email_verified: v.get("email_verified")?.as_bool()?,
        name: text("name"),
        groups: v.get("groups")?.as_array()?.iter().filter_map(|g| g.as_str().map(str::to_owned)).collect(),
        sid: text("sid"),
        guest: v.get("guest")?.as_bool()?,
    })
}
struct Keys {
    keys: Arc<Vec<jose::Jwk>>,
    fetched: Instant,
}

/// The relying party. Create one per service with [`Sso::new`] and share it.
pub struct Sso {
    store: Arc<Store>,
    origins: Vec<String>,
    public_url: Option<String>,
    deployment: Option<Deployment>,
    org: Option<String>,
    agent: ureq::Agent,
    outbound: Arc<Semaphore>,
    jwks_refetch: Duration,
    recheck_tick: Duration,
    discovery: Mutex<HashMap<String, (Endpoints, Instant)>>,
    jwks: Mutex<HashMap<String, Keys>>,
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
fn claim_reason(e: ClaimError) -> &'static str {
    match e {
        ClaimError::Issuer => "claim_iss",
        ClaimError::Audience => "claim_aud",
        ClaimError::Expired => "claim_exp",
        ClaimError::IssuedAt => "claim_iat",
        ClaimError::Nonce => "claim_nonce",
        ClaimError::Subject => "claim_sub",
        _ => "claim_email",
    }
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
            deployment: config.deployment.clone(),
            org: store.org.clone(),
            jwks_refetch: Duration::from_secs(config.sso_jwks_refetch_seconds),
            recheck_tick: Duration::from_secs(config.sso_recheck_tick_seconds),
            store,
            agent,
            outbound: Arc::new(Semaphore::new(MAX_OUTBOUND)),
            discovery: Mutex::default(),
            jwks: Mutex::default(),
            revoked: broadcast::channel(1024).0,
        })
    }

    /// The deployment and the provider with this ID, if both are configured.
    fn configured(&self, provider: &str) -> Option<(&Deployment, &Configured)> {
        let deployment = self.deployment.as_ref()?;
        Some((deployment, deployment.provider(provider)?))
    }
    /// The login for a bearer token, if it is valid, unexpired and unrevoked, its provider is
    /// still configured with the same issuer, and the account still passes the deployment's
    /// rules (which are applied again here, so a changed configuration takes effect at once).
    pub async fn login(&self, token: &str) -> Result<Option<Login>, StoreError> {
        if !is_hex64(token) {
            return Ok(None);
        }
        let Some(org) = &self.org else { return Ok(None) };
        let row = sqlx::query(
            "SELECT l.provider, l.issuer, l.subject, l.email, l.email_verified, l.name, l.groups::text, l.guest, extract(epoch FROM l.expires)::bigint, l.account
             FROM sso_logins l LEFT JOIN accounts a ON a.account = l.account
             WHERE l.token_hash = $1 AND l.org = $2 AND NOT l.revoked AND l.expires > now() AND l.provider IS NOT NULL
               AND (a.account IS NULL OR a.state = 'active')",
        )
        .bind(sha256_hex(token.as_bytes()))
        .bind(org)
        .fetch_optional(&self.store.pool)
        .await?;
        let Some(row) = row else { return Ok(None) };
        let (provider, issuer): (String, String) = (row.get(0), row.get(1));
        let Some((deployment, configured)) = self.configured(&provider).filter(|(_, p)| p.issuer == issuer) else { return Ok(None) };
        let (subject, email, email_verified): (String, Option<String>, bool) = (row.get(2), row.get(3), row.get(4));
        let groups: Vec<String> = serde_json::from_str(&row.get::<String, _>(6)).unwrap_or_default();
        let guest: bool = row.get(7);
        let Ok(role) = admit(deployment, configured, &subject, email.as_deref(), email_verified, &groups, guest) else { return Ok(None) };
        Ok(Some(Login {
            org: org.clone(),
            account: row.get(9),
            provider,
            issuer,
            subject,
            email,
            email_verified,
            name: row.get(5),
            groups,
            guest,
            role,
            expires: UNIX_EPOCH + Duration::from_secs(row.get::<i64, _>(8).max(0) as u64),
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
    /// Links the subject to a person: Ok if newly linked or already linked to the same person (a
    /// blocked link stays blocked); Err(Conflict) if the subject or the person is linked elsewhere.
    pub async fn link(&self, login: &Login, person: &str) -> Result<(), LinkError> {
        let mut tx = self.store.pool.begin().await?;
        Self::link_in(&mut tx, login, person).await?;
        tx.commit().await?;
        Ok(())
    }
    /// [`Sso::link`] inside the caller's transaction, so the link commits (or not) with what
    /// it belongs to, such as the membership event that admits the person.
    pub async fn link_in(tx: &mut sqlx::PgConnection, login: &Login, person: &str) -> Result<(), LinkError> {
        if !scribyra_core::orgsync::is_uuid(person) {
            return Err(LinkError::Invalid);
        }
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
                .bind(login.email.as_ref().filter(|_| login.email_verified))
                .execute(&mut *tx)
                .await?;
            // A concurrent link of the same subject or person won the race.
            if inserted.rows_affected() == 0 {
                return Err(LinkError::Conflict);
            }
        }
        Ok(())
    }
    /// The identity linked to a person, if any: (issuer, subject, blocked).
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
    async fn endpoints(&self, issuer: &str) -> Result<Endpoints, &'static str> {
        if let Some((endpoints, fetched)) = self.discovery.lock().unwrap().get(issuer)
            && fetched.elapsed() < Duration::from_secs(DISCOVERY_SECONDS)
        {
            return Ok(endpoints.clone());
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
        let endpoints = Endpoints {
            authorization_endpoint: field("authorization_endpoint").ok_or("discovery")?,
            token_endpoint: field("token_endpoint").ok_or("discovery")?,
            jwks_uri: field("jwks_uri").ok_or("discovery")?,
        };
        self.discovery.lock().unwrap().insert(issuer.to_owned(), (endpoints.clone(), Instant::now()));
        Ok(endpoints)
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
    async fn verify(&self, endpoints: &Endpoints, token: &str) -> Result<jose::Verified, &'static str> {
        let keys = self.keys(&endpoints.jwks_uri, false).await?;
        let result = match jose::verify(token, &keys) {
            Err(JoseError::UnknownKey) => {
                let fresh = self.keys(&endpoints.jwks_uri, true).await?;
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
            if block {
                sqlx::query("UPDATE accounts SET state = 'blocked' WHERE issuer = $1 AND subject = $2 AND state = 'active'").bind(&issuer).bind(&subject).execute(&mut *tx).await?;
            }
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
    /// One recheck pass: refresh each unrevoked login whose last check is older than its
    /// provider's `recheck_minutes`. A refused refresh token (`invalid_grant`) revokes every
    /// login of that subject and blocks its link; any other 4xx revokes that login only; network
    /// and server errors keep the login and retry on the next pass. A refreshed ID token updates
    /// the login's groups and guest mark, and an account that no longer passes the group and
    /// guest rules has its logins revoked (not blocked: the provider still vouches for it).
    pub async fn recheck(&self) {
        // Expired or revoked logins are kept a week for operators, then deleted.
        let _ = sqlx::query("DELETE FROM sso_logins WHERE expires < now() - interval '7 days' OR (revoked AND created < now() - interval '7 days')")
            .execute(&self.store.pool)
            .await;
        let (Some(deployment), Some(org)) = (&self.deployment, &self.org) else { return };
        let (mut checked, mut refreshed, mut revoked, mut failed) = (0usize, 0u32, 0u32, 0u32);
        for configured in &deployment.providers {
            let rows = sqlx::query(
                "SELECT token_hash, issuer, subject, refresh_token FROM sso_logins
                 WHERE org = $1 AND provider = $2 AND NOT revoked AND refresh_token IS NOT NULL AND expires > now()
                   AND checked <= now() - make_interval(secs => $3)
                 ORDER BY checked LIMIT $4",
            )
            .bind(org)
            .bind(&configured.id)
            .bind(configured.recheck_minutes as f64 * 60.0)
            .bind(RECHECK_BATCH)
            .fetch_all(&self.store.pool)
            .await;
            let Ok(rows) = rows else {
                log("sso_recheck_failed", "database");
                return;
            };
            checked += rows.len();
            for row in &rows {
                let (token_hash, issuer, subject, refresh): (String, String, String, String) = (row.get(0), row.get(1), row.get(2), row.get(3));
                if issuer != configured.issuer {
                    failed += 1;
                    continue;
                }
                match self.recheck_one(deployment, configured, org, &token_hash, &subject, refresh).await {
                    Ok(Recheck::Kept) => refreshed += 1,
                    Ok(Recheck::Revoked) => revoked += 1,
                    Ok(Recheck::Retry) | Err(_) => failed += 1,
                }
            }
        }
        if checked > 0 {
            println!("{}", json!({"event": "sso_recheck", "checked": checked, "refreshed": refreshed, "revoked": revoked, "failed": failed}));
        }
    }
    async fn recheck_one(&self, deployment: &Deployment, configured: &Configured, org: &str, token_hash: &str, subject: &str, refresh: String) -> Result<Recheck, StoreError> {
        let (Ok(endpoints), Ok(secret)) = (self.endpoints(&configured.issuer).await, configured.client_secret()) else { return Ok(Recheck::Retry) };
        let outcome = self
            .call(Outbound::Token {
                url: endpoints.token_endpoint.clone(),
                client_id: configured.client_id.clone(),
                client_secret: secret,
                form: vec![("grant_type", "refresh_token".into()), ("refresh_token", refresh)],
            })
            .await;
        let same_subject = "UPDATE sso_logins SET revoked = true WHERE org = $1 AND issuer = $2 AND subject = $3 AND NOT revoked RETURNING org, issuer, subject";
        match outcome {
            Ok((200, body)) => {
                let tokens: Value = serde_json::from_slice(&body).unwrap_or(Value::Null);
                let rotated = tokens.get("refresh_token").and_then(Value::as_str).filter(|t| t.len() <= 8192).map(str::to_owned);
                // A refreshed ID token (when the provider sends one) carries current groups.
                let mut identity = None;
                if let Some(id_token) = tokens.get("id_token").and_then(Value::as_str) {
                    let Ok(verified) = self.verify(&endpoints, id_token).await else { return Ok(Recheck::Retry) };
                    let expect = expect(configured, None);
                    match jose::check_refreshed_id_token(&verified.claims, &expect) {
                        Ok(id) if id.subject == subject => identity = Some(id),
                        Ok(_) => return Ok(Recheck::Retry),
                        Err(e) => {
                            log("sso_refused", claim_reason(e));
                            return Ok(Recheck::Retry);
                        }
                    }
                }
                sqlx::query("UPDATE sso_logins SET checked = now(), refresh_token = COALESCE($2, refresh_token) WHERE token_hash = $1")
                    .bind(token_hash)
                    .bind(rotated)
                    .execute(&self.store.pool)
                    .await?;
                let Some(id) = identity else { return Ok(Recheck::Kept) };
                sqlx::query("UPDATE sso_logins SET email = $4, email_verified = $5, name = $6, groups = $7::jsonb, guest = $8 WHERE org = $1 AND issuer = $2 AND subject = $3 AND NOT revoked")
                    .bind(org)
                    .bind(&configured.issuer)
                    .bind(subject)
                    .bind(&id.email)
                    .bind(id.email_verified)
                    .bind(&id.name)
                    .bind(serde_json::to_string(&id.groups).unwrap_or_else(|_| "[]".into()))
                    .bind(id.guest)
                    .execute(&self.store.pool)
                    .await?;
                let admitted = admit(deployment, configured, subject, id.email.as_deref(), id.email_verified, &id.groups, id.guest);
                if let Ok(role) = admitted {
                    sqlx::query("UPDATE accounts SET email = $3, email_verified = $4, name = $5, role = $6, guest = $7 WHERE provider = $1 AND subject = $2")
                        .bind(&configured.id)
                        .bind(subject)
                        .bind(&id.email)
                        .bind(id.email_verified)
                        .bind(&id.name)
                        .bind(role.as_str())
                        .bind(id.guest)
                        .execute(&self.store.pool)
                        .await?;
                }
                if admitted.is_err() {
                    log("sso_refused", "recheck_rules");
                    self.revoke_where(same_subject, &[Some(org), Some(&configured.issuer), Some(subject)], false).await?;
                    return Ok(Recheck::Revoked);
                }
                Ok(Recheck::Kept)
            }
            // 408 and 429 are transient: keep the login and retry on the next pass.
            Ok((status, body)) if (400..500).contains(&status) && status != 408 && status != 429 => {
                let invalid_grant = serde_json::from_slice::<Value>(&body).ok().is_some_and(|v| v.get("error").and_then(Value::as_str) == Some("invalid_grant"));
                if invalid_grant {
                    self.revoke_where(same_subject, &[Some(org), Some(&configured.issuer), Some(subject)], true).await?;
                } else {
                    self.revoke_where("UPDATE sso_logins SET revoked = true WHERE token_hash = $1 AND NOT revoked RETURNING org, issuer, subject", &[Some(token_hash)], false).await?;
                }
                Ok(Recheck::Revoked)
            }
            _ => Ok(Recheck::Retry),
        }
    }
}
enum Recheck {
    Kept,
    Revoked,
    Retry,
}
/// What an ID token of this provider must satisfy.
fn expect<'a>(configured: &'a Configured, nonce: Option<&'a str>) -> Expect<'a> {
    Expect {
        issuer: &configured.issuer,
        client_id: &configured.client_id,
        nonce,
        email_domains: &configured.email_domains,
        groups_claim: configured.groups_claim.as_deref(),
        guest: configured.guest.as_ref().map(|g| (g.claim.as_str(), g.equals.as_str())),
        now: now_seconds(),
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
        "provider": login.provider,
        "role": login.role.as_str(),
        "subject": {"email": login.email, "name": login.name, "groups": login.groups},
        "person": link.map(|(p, _)| p),
        "state": state,
        "account": login.account,
        "email": login.email.as_ref().filter(|_| login.email_verified),
        "name": login.name,
    })
}
/// The login token from `Authorization: ScribyraSSO <token>`, if well formed.
pub fn bearer(headers: &HeaderMap) -> Option<&str> {
    headers.get(header::AUTHORIZATION).and_then(|v| v.to_str().ok()).and_then(|v| v.strip_prefix("ScribyraSSO ")).filter(|t| is_hex64(t))
}

/// `GET /v1/deployment`: what the app needs before anyone signs in. Public; no secret and no
/// provider client setting leaves the service.
async fn deployment_route(State(s): State<Shared>) -> Response {
    let (Some(d), Some(org)) = (&s.deployment, &s.org) else { return error(StatusCode::NOT_FOUND, "this service has no deployment") };
    let providers: Vec<Value> = d.providers.iter().map(|p| json!({"id": p.id, "label": p.label})).collect();
    (
        [(header::CACHE_CONTROL, "no-store")],
        Json(json!({"name": d.name, "encryption": d.encryption.as_str(), "offline": d.offline, "compile": d.compile, "linkSharing": d.link_sharing, "providers": providers, "org": org})),
    )
        .into_response()
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct StartRequest {
    provider: String,
    #[serde(rename = "return")]
    return_to: String,
    challenge: String,
}
async fn start(State(s): State<Shared>, source: Option<axum::Extension<crate::service::Source>>, Json(request): Json<StartRequest>) -> Response {
    let source = source.map(|axum::Extension(crate::service::Source(ip))| ip.to_string()).unwrap_or_default();
    let Some(public_url) = s.public_url.clone() else {
        return error(StatusCode::NOT_FOUND, "sign-in needs public_url on this service");
    };
    if !is_hex64(&request.challenge) || request.provider.len() > 32 {
        return error(StatusCode::BAD_REQUEST, "invalid request");
    }
    if !s.origins.contains(&request.return_to) {
        return error(StatusCode::BAD_REQUEST, "return origin not allowed");
    }
    let Some((_, configured)) = s.configured(&request.provider) else {
        return error(StatusCode::NOT_FOUND, "unknown provider");
    };
    let endpoints = match s.endpoints(&configured.issuer).await {
        Ok(p) => p,
        Err(_) => return error(StatusCode::BAD_GATEWAY, "identity provider unavailable"),
    };
    let (state, nonce) = (random_hex(), random_hex());
    let verifier = jose::b64_encode(&random_bytes());
    let idp_challenge = jose::b64_encode(&Sha256::digest(verifier.as_bytes()));
    let Ok(mut url) = url::Url::parse(&endpoints.authorization_endpoint) else {
        return error(StatusCode::BAD_GATEWAY, "identity provider unavailable");
    };
    url.query_pairs_mut()
        .append_pair("response_type", "code")
        .append_pair("client_id", &configured.client_id)
        .append_pair("redirect_uri", &format!("{public_url}/v1/sso/callback"))
        .append_pair("scope", &configured.scope())
        .append_pair("state", &state)
        .append_pair("nonce", &nonce)
        .append_pair("code_challenge", &idp_challenge)
        .append_pair("code_challenge_method", "S256");
    // In PostgreSQL, so the provider's redirect may reach any replica. Nobody is refused for
    // room: a source past its own few sign-ins replaces its oldest, and a full table (or
    // provider) drops its oldest, so one client cannot lock others out (review M2).
    let stored = async {
        let mut tx = s.store.pool.begin().await?;
        sqlx::query("DELETE FROM sso_flows WHERE expires <= now()").execute(&mut *tx).await?;
        sqlx::query("LOCK TABLE sso_flows IN SHARE ROW EXCLUSIVE MODE").execute(&mut *tx).await?;
        let (all, provider, mine): (i64, i64, i64) = sqlx::query_as("SELECT count(*), count(*) FILTER (WHERE provider = $1), count(*) FILTER (WHERE source = $2) FROM sso_flows")
            .bind(&request.provider)
            .bind(&source)
            .fetch_one(&mut *tx)
            .await?;
        let oldest = |filter: &'static str, value: String, over: i64| {
            let sql = format!("DELETE FROM sso_flows WHERE state_hash IN (SELECT state_hash FROM sso_flows WHERE {filter} ORDER BY expires LIMIT $2)");
            (sql, value, over)
        };
        for (sql, value, over) in [
            oldest("source = $1", source.clone(), mine - MAX_FLOWS_PER_SOURCE as i64 + 1),
            oldest("provider = $1", request.provider.clone(), provider - MAX_FLOWS_PER_PROVIDER as i64 + 1),
            oldest("$1 = $1", String::new(), all - MAX_FLOWS as i64 + 1),
        ] {
            if over > 0 {
                sqlx::query(&sql).bind(value).bind(over).execute(&mut *tx).await?;
            }
        }
        sqlx::query("INSERT INTO sso_flows (state_hash, provider, return_to, challenge, nonce, verifier, expires, source) VALUES ($1, $2, $3, $4, $5, $6, now() + make_interval(secs => $7), $8)")
            .bind(sha256_hex(state.as_bytes()))
            .bind(&request.provider)
            .bind(&request.return_to)
            .bind(&request.challenge)
            .bind(&nonce)
            .bind(&verifier)
            .bind(FLOW_SECONDS as f64)
            .bind(&source)
            .execute(&mut *tx)
            .await?;
        tx.commit().await
    };
    if let Err(e) = stored.await {
        return internal(e);
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
    let flow = match query.get("state") {
        Some(state) => sqlx::query_as::<_, (String, String, String, String, String, bool)>(
            "DELETE FROM sso_flows WHERE state_hash = $1 RETURNING provider, return_to, challenge, nonce, verifier, expires > now()",
        )
        .bind(sha256_hex(state.as_bytes()))
        .fetch_optional(&s.store.pool)
        .await,
        None => Ok(None),
    };
    let flow = match flow {
        Ok(Some((provider, return_to, challenge, nonce, verifier, live))) => Flow { provider, return_to, challenge, nonce, verifier, live },
        Ok(None) => {
            log("sso_refused", "state");
            return error(StatusCode::BAD_REQUEST, "unknown or expired sign-in");
        }
        Err(e) => return internal(e),
    };
    if !flow.live {
        return fail(&flow.return_to, "expired");
    }
    let (Some((deployment, configured)), Some(org)) = (s.configured(&flow.provider), s.org.clone()) else {
        return fail(&flow.return_to, "not_configured");
    };
    if query.contains_key("error") {
        return fail(&flow.return_to, "idp_error");
    }
    // RFC 9207: a provider that names itself in the response must name the right issuer.
    if query.get("iss").is_some_and(|iss| *iss != configured.issuer) {
        return fail(&flow.return_to, "idp_error");
    }
    let Some(code) = query.get("code").filter(|c| !c.is_empty() && c.len() <= 4096) else {
        return fail(&flow.return_to, "idp_error");
    };
    let endpoints = match s.endpoints(&configured.issuer).await {
        Ok(p) => p,
        Err(code) => return fail(&flow.return_to, code),
    };
    let (Some(public_url), Ok(secret)) = (s.public_url.clone(), configured.client_secret()) else { return fail(&flow.return_to, "not_configured") };
    let exchanged = s
        .call(Outbound::Token {
            url: endpoints.token_endpoint.clone(),
            client_id: configured.client_id.clone(),
            client_secret: secret,
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
    let verified = match s.verify(&endpoints, id_token).await {
        Ok(v) => v,
        Err(code) => return fail(&flow.return_to, code),
    };
    let identity = match jose::check_id_token(&verified.claims, &expect(configured, Some(&flow.nonce))) {
        Ok(identity) => identity,
        Err(e) => {
            log("sso_refused", claim_reason(e));
            return fail(&flow.return_to, e.code());
        }
    };
    // Guests (when the deployment admits none) and people outside the member groups stop here.
    if let Err(code) = admit(deployment, configured, &identity.subject, identity.email.as_deref(), identity.email_verified, &identity.groups, identity.guest) {
        return fail(&flow.return_to, code);
    }
    let refresh_token = tokens.get("refresh_token").and_then(Value::as_str).filter(|t| t.len() <= 8192).map(str::to_owned);
    let grant = random_hex();
    let stored = async {
        let mut tx = s.store.pool.begin().await?;
        sqlx::query("DELETE FROM sso_grants WHERE expires <= now()").execute(&mut *tx).await?;
        let count: i64 = sqlx::query_scalar("SELECT count(*) FROM sso_grants").fetch_one(&mut *tx).await?;
        if count as usize >= MAX_GRANTS {
            return Ok(false);
        }
        sqlx::query("INSERT INTO sso_grants (code_hash, provider, challenge, identity, refresh_token, session_seconds, expires) VALUES ($1, $2, $3, $4::jsonb, $5, $6, now() + make_interval(secs => $7))")
            .bind(sha256_hex(grant.as_bytes()))
            .bind(&flow.provider)
            .bind(&flow.challenge)
            .bind(identity_json(&identity).to_string())
            .bind(&refresh_token)
            .bind(configured.session_hours as i64 * 3600)
            .bind(GRANT_SECONDS as f64)
            .execute(&mut *tx)
            .await?;
        tx.commit().await?;
        Ok::<_, sqlx::Error>(true)
    };
    match stored.await {
        Ok(true) => {}
        Ok(false) | Err(_) => return fail(&flow.return_to, "unavailable"),
    }
    log("sso_callback", "ok");
    redirect(format!("{}/#scribyra-sso={grant}&org={org}", flow.return_to))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RedeemRequest {
    code: String,
    verifier: String,
}
async fn redeem(State(s): State<Shared>, Json(request): Json<RedeemRequest>) -> Response {
    // Single use: a redeem attempt consumes the grant even when the verifier is wrong.
    let grant = sqlx::query_as::<_, (String, String, String, Option<String>, i64)>(
        "DELETE FROM sso_grants WHERE code_hash = $1 AND expires > now() RETURNING provider, challenge, identity::text, refresh_token, session_seconds",
    )
    .bind(sha256_hex(request.code.as_bytes()))
    .fetch_optional(&s.store.pool)
    .await;
    let grant = match grant {
        Ok(Some((provider, challenge, identity, refresh_token, session_seconds))) => match identity_from_json(&identity) {
            Some(identity) => Grant { provider, challenge, identity, refresh_token, session_seconds },
            None => return internal(()),
        },
        Ok(None) => return error(StatusCode::UNAUTHORIZED, "unknown or expired grant"),
        Err(e) => return internal(e),
    };
    // Expired grants are not returned: the row only matches while unexpired.
    let Some(verifier) = decode_hex(&request.verifier).filter(|v| v.len() == 32) else {
        return error(StatusCode::UNAUTHORIZED, "wrong verifier");
    };
    if !bool::from(sha256_hex(&verifier).as_bytes().ct_eq(grant.challenge.as_bytes())) {
        return error(StatusCode::UNAUTHORIZED, "wrong verifier");
    }
    let (Some((deployment, configured)), Some(org)) = (s.configured(&grant.provider), s.org.clone()) else { return error(StatusCode::UNAUTHORIZED, "unknown or expired grant") };
    let token = random_hex();
    let id = &grant.identity;
    let Ok(role) = admit(deployment, configured, &id.subject, id.email.as_deref(), id.email_verified, &id.groups, id.guest) else {
        return error(StatusCode::FORBIDDEN, "this account cannot sign in here");
    };
    // The account: made at the first sign-in, refreshed at every one. A sign-in the provider
    // admits again clears a block from a refused refresh token; a disabled account stays out.
    let account = sqlx::query_as::<_, (String, String)>(
        "INSERT INTO accounts (account, provider, issuer, subject, email, email_verified, name, role, guest) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (provider, subject) DO UPDATE SET issuer = EXCLUDED.issuer, email = EXCLUDED.email, email_verified = EXCLUDED.email_verified,
           name = EXCLUDED.name, role = EXCLUDED.role, guest = EXCLUDED.guest, last_seen = now(),
           state = CASE WHEN accounts.state = 'blocked' THEN 'active' ELSE accounts.state END
         RETURNING account, state",
    )
    .bind(random_hex())
    .bind(&grant.provider)
    .bind(&configured.issuer)
    .bind(&id.subject)
    .bind(&id.email)
    .bind(id.email_verified)
    .bind(&id.name)
    .bind(role.as_str())
    .bind(id.guest)
    .fetch_one(&s.store.pool)
    .await;
    let account = match account {
        Ok((account, state)) if state == "active" => account,
        Ok(_) => {
            log("sso_refused", "account_disabled");
            return error(StatusCode::FORBIDDEN, "this account is disabled");
        }
        Err(e) => return internal(e),
    };
    let inserted = sqlx::query(
        "INSERT INTO sso_logins (token_hash, org, provider, issuer, subject, email, email_verified, name, groups, guest, sid, refresh_token, expires, account)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11, $12, now() + make_interval(secs => $13), $14)",
    )
    .bind(sha256_hex(token.as_bytes()))
    .bind(&org)
    .bind(&grant.provider)
    .bind(&configured.issuer)
    .bind(&id.subject)
    .bind(&id.email)
    .bind(id.email_verified)
    .bind(&id.name)
    .bind(serde_json::to_string(&id.groups).unwrap_or_else(|_| "[]".into()))
    .bind(id.guest)
    .bind(&id.sid)
    .bind(&grant.refresh_token)
    .bind(grant.session_seconds as f64)
    .bind(&account)
    .execute(&s.store.pool)
    .await;
    if let Err(e) = inserted {
        return internal(e);
    }
    // Server-readable deployments: pending invitations to this verified email become shares.
    if deployment.encryption == crate::config::Encryption::Server
        && let Err(e) = crate::server_projects::accept_invitations(&s.store.pool, &account).await
    {
        return internal(e);
    }
    let login = match s.login(&token).await {
        Ok(Some(login)) => login,
        Ok(None) => return error(StatusCode::FORBIDDEN, "this account cannot sign in here"),
        Err(e) => return internal(e),
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
    // The unverified claims only choose which providers' settings to verify against.
    let Ok(peek) = jose::unverified_claims(token) else { return refuse() };
    let Some(issuer) = peek.get("iss").and_then(Value::as_str) else { return refuse() };
    let (Some(deployment), Some(org)) = (&s.deployment, &s.org) else { return refuse() };
    let audiences: Vec<&str> = match peek.get("aud") {
        Some(Value::String(a)) => vec![a.as_str()],
        Some(Value::Array(list)) => list.iter().filter_map(Value::as_str).collect(),
        _ => vec![],
    };
    // Only configured issuers are ever contacted: an unknown `iss` must not make the service
    // fetch an attacker-chosen URL.
    let providers: Vec<&Configured> = deployment.providers.iter().filter(|p| p.issuer == issuer).collect();
    if providers.is_empty() {
        return refuse();
    }
    let Ok(endpoints) = s.endpoints(issuer).await else { return refuse() };
    let mut matched = false;
    for configured in providers {
        if !audiences.contains(&configured.client_id.as_str()) {
            continue;
        }
        let Ok(verified) = s.verify(&endpoints, token).await else { return refuse() };
        let Ok(logout) = jose::check_logout_token(&verified.claims, &expect(configured, None)) else { return refuse() };
        // Each logout token is used once, on whichever replica it reaches first.
        let fresh = async {
            let mut tx = s.store.pool.begin().await?;
            sqlx::query("DELETE FROM sso_logout_jtis WHERE expires <= now()").execute(&mut *tx).await?;
            let count: i64 = sqlx::query_scalar("SELECT count(*) FROM sso_logout_jtis").fetch_one(&mut *tx).await?;
            if count as usize >= MAX_LOGOUT_JTIS {
                return Ok(false);
            }
            let inserted = sqlx::query("INSERT INTO sso_logout_jtis (key, expires) VALUES ($1, now() + interval '15 minutes') ON CONFLICT DO NOTHING")
                .bind(sha256_hex(format!("{}\n{}", configured.id, logout.jti).as_bytes()))
                .execute(&mut *tx)
                .await?;
            tx.commit().await?;
            Ok::<_, sqlx::Error>(inserted.rows_affected() == 1)
        };
        if !matches!(fresh.await, Ok(true)) {
            return refuse();
        }
        let revoked = s
            .revoke_where(
                "UPDATE sso_logins SET revoked = true WHERE org = $1 AND issuer = $2 AND provider = $5 AND NOT revoked
                   AND ($3::text IS NULL OR subject = $3) AND ($4::text IS NULL OR sid = $4)
                 RETURNING org, issuer, subject",
                &[Some(org), Some(issuer), logout.subject.as_deref(), logout.sid.as_deref(), Some(&configured.id)],
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

/// The sign-in routes and `GET /v1/deployment`; merged into [`crate::service::router`].
pub fn routes(s: Shared) -> Router {
    Router::new()
        .route("/v1/deployment", get(deployment_route))
        .route("/v1/sso/start", post(start))
        .route("/v1/sso/callback", get(callback))
        .route("/v1/sso/redeem", post(redeem))
        .route("/v1/sso/me", get(me))
        .route("/v1/sso/logout", post(logout))
        .route("/v1/sso/backchannel", post(backchannel))
        .with_state(s)
}
