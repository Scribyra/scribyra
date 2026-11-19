//! OpenID Connect sign-in: the service as a confidential relying party of each provider the
//! deployment configures (authorization code flow with PKCE). It is the only way anyone signs
//! in: the service has no passwords, passkeys, setup codes or sign-in links of its own.
//!
//! Flow: the app sends `POST /v1/sso/start` with a provider ID and a SHA-256 challenge of its
//! own 32-byte verifier and gets the provider's authorization URL. The provider redirects the
//! browser to `GET /v1/sso/callback/<provider>` (one redirect URI per provider, so a response
//! can only be taken for the provider it came from), where the service exchanges the code (client secret and
//! its own PKCE verifier), verifies the ID token ([`jose`]), reads the person's organisations,
//! roles and guest marks from that token's claims ([`crate::claims`]), and redirects back to the
//! app with a one-time grant in the URL fragment. The app redeems the grant with its verifier
//! (`POST /v1/sso/redeem`) for a login token (`Authorization: ScribyraSSO <token>`).
//!
//! The service is a pure relying party (design section 3, decision 9): an **account** is
//! `(issuer, subject)` with the profile (email, `email_verified`, name, picture) the provider gives
//! at each sign-in and refresh (from the userinfo endpoint for what the ID token lacks), and its
//! role in each **organisation** (`organisations`, keyed by provider and organisation claim) is a
//! **membership** recomputed from every token. Nothing in the configuration names people. A
//! login carries the organisations in which its account holds a role at the provider it signed
//! in with; every route acts in one of them ([`Login::active`], the `Scribyra-Org` header).
//!
//! The organisation module links subjects to people ([`Sso::link`]) and closes device sessions
//! when [`Sso::revocations`] fires. A background task rechecks logins that hold a refresh token:
//! when the provider refuses it (`invalid_grant`, for example because the account was disabled)
//! the login is revoked and the account blocked; a refreshed ID token updates the profile and the
//! memberships, and when it leaves no role the account's logins at that provider are revoked.
//!
//! Sign-ins in progress, one-time grants and sessions live in PostgreSQL, so a sign-in started on
//! one replica can finish on another.
//!
//! Never logged: tokens, codes, client secrets, ID tokens, emails or provider error text.
pub mod jose;

use crate::{
    claims::Grant as OrgGrant,
    config::{Config, Deployment, Encryption, Guests, Provider as Configured},
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
/// Sign-ins in progress per source (an IPv4 address or an IPv6 /64); a further one replaces that
/// source's oldest.
const MAX_FLOWS_PER_SOURCE: usize = 8;
/// Sign-ins in progress per network (IPv4 /24, IPv6 /48); a further one replaces its oldest.
const MAX_FLOWS_PER_NETWORK: usize = 64;
/// Sources whose start rate one replica remembers (more are let through unrated).
const MAX_RATED_SOURCES: usize = 65536;
const MAX_GRANTS: usize = 4096;
const MAX_LOGOUT_JTIS: usize = 4096;
const DISCOVERY_SECONDS: u64 = 3600;
const JWKS_SECONDS: u64 = 3600;
const HTTP_SECONDS: u64 = 10;
const MAX_DOCUMENT_BYTES: u64 = 256 * 1024;
const MAX_OUTBOUND: usize = 16;
const RECHECK_BATCH: i64 = 200;

/// What an account may do in an organisation (design section 3, "Accounts and roles").
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
    pub fn parse(text: &str) -> Option<Self> {
        match text {
            "admin" => Some(Self::Admin),
            "member" => Some(Self::Member),
            "guest" => Some(Self::Guest),
            _ => None,
        }
    }
}
/// The header that names the organisation a request acts in.
pub const ORG_HEADER: &str = "scribyra-org";
/// An organisation in which a login's account holds a role now.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Membership {
    pub org: String,
    pub name: String,
    pub role: Role,
}
/// A valid (unexpired, unrevoked, still admitted) login.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Login {
    /// The deployment's ID (`GET /v1/deployment` `org`), which is also its first organisation's.
    pub org: String,
    pub account: String,
    /// The configured provider's ID.
    pub provider: String,
    pub issuer: String,
    pub subject: String,
    pub email: Option<String>,
    pub email_verified: bool,
    pub name: Option<String>,
    pub picture: Option<String>,
    /// The organisations of this provider in which the account holds a role and is not disabled
    /// or removed (never empty), oldest first.
    pub orgs: Vec<Membership>,
    pub expires: SystemTime,
}
/// Why a request names no organisation the caller may act in.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OrgChoice {
    /// The account is in several organisations and the request named none (`400 org_required`).
    Required,
    /// The named organisation is not one of the caller's (`404 unknown_org`): another
    /// organisation's existence is never confirmed.
    Unknown,
}
impl Login {
    pub fn membership(&self, org: &str) -> Option<&Membership> {
        self.orgs.iter().find(|m| m.org == org)
    }
    /// The organisation a request acts in: the one its `Scribyra-Org` header names, or the
    /// account's only one when it names none.
    pub fn active(&self, headers: &HeaderMap) -> Result<&Membership, OrgChoice> {
        match headers.get(ORG_HEADER) {
            Some(value) => value.to_str().ok().and_then(|org| self.membership(org.trim())).ok_or(OrgChoice::Unknown),
            None if self.orgs.len() == 1 => Ok(&self.orgs[0]),
            None => Err(OrgChoice::Required),
        }
    }
}
/// The response for an [`OrgChoice`].
pub fn org_choice_error(choice: OrgChoice) -> Response {
    match choice {
        OrgChoice::Required => coded(StatusCode::BAD_REQUEST, "org_required", "name the organisation with the Scribyra-Org header"),
        OrgChoice::Unknown => coded(StatusCode::NOT_FOUND, "unknown_org", "unknown organisation"),
    }
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

/// The one form an email is stored and compared in (review L2): surrounding space trimmed and
/// Unicode lowercase (Rust's, which does not depend on a locale). Accounts, logins and
/// invitations store it; SQL compares stored values with `=` and never calls `lower()`, whose
/// result depends on the database's locale. No Unicode normalisation (NFC) is applied: an
/// address is matched in the form its provider sends.
pub fn normalise_email(text: &str) -> String {
    text.trim().to_lowercase()
}
/// The message for a sign-in refused because the token gives no access, by its code.
fn refusal_message(code: &str, label: &str) -> String {
    match code {
        "no_role" => format!("Your account has no Scribyra role. Ask your administrator to grant one in {label}."),
        "guest" => "Guest accounts can't use this deployment.".into(),
        "no_organisation" => format!("{label} did not say which organisation your account belongs to."),
        "account_disabled" => "An administrator disabled your account here.".into(),
        "account_removed" => "An administrator removed your account here.".into(),
        _ => "This account cannot sign in here.".into(),
    }
}

/// Whether guest memberships count: only in a server-readable deployment that admits guests.
fn guests_admitted(deployment: &Deployment) -> bool {
    deployment.guests == Guests::Shared && deployment.encryption == Encryption::Server
}
/// The account's memberships at this provider that give access now: a role, neither disabled
/// nor removed (guests only while the deployment admits guests), oldest organisation first.
pub async fn memberships(pool: &sqlx::PgPool, deployment: &Deployment, account: &str, provider: &str) -> Result<Vec<Membership>, sqlx::Error> {
    let rows: Vec<(String, String, String)> = sqlx::query_as(
        "SELECT m.org, o.name, m.role FROM memberships m JOIN organisations o ON o.org = m.org
         WHERE m.account = $1 AND o.provider = $2 AND m.state = 'active' AND m.role IS NOT NULL ORDER BY o.created, o.org",
    )
    .bind(account)
    .bind(provider)
    .fetch_all(pool)
    .await?;
    Ok(rows
        .into_iter()
        .filter_map(|(org, name, role)| {
            let role = Role::parse(&role)?;
            (role != Role::Guest || guests_admitted(deployment)).then_some(Membership { org, name, role })
        })
        .collect())
}
/// The organisation `(provider, claim)`, made the first time a token names it (`claim` empty: the
/// provider's one organisation). The first organisation a deployment makes takes the deployment's
/// ID, so a deployment with one organisation keeps the ID its end-to-end clients sign with; in an
/// end-to-end deployment each organisation also has its membership log's `orgs` row.
pub async fn organisation(tx: &mut sqlx::PgConnection, deployment: &Deployment, deployment_org: &str, provider: &Configured, claim: &str, name: Option<&str>) -> Result<String, sqlx::Error> {
    let update = "UPDATE organisations SET name = COALESCE($3, name) WHERE provider = $1 AND claim = $2 RETURNING org";
    if let Some(org) = sqlx::query_scalar::<_, String>(update).bind(&provider.id).bind(claim).bind(name).fetch_optional(&mut *tx).await? {
        return Ok(org);
    }
    sqlx::query("SELECT pg_advisory_xact_lock(hashtext('scribyra-organisations'))").execute(&mut *tx).await?;
    if let Some(org) = sqlx::query_scalar::<_, String>(update).bind(&provider.id).bind(claim).bind(name).fetch_optional(&mut *tx).await? {
        return Ok(org);
    }
    let taken: bool = sqlx::query_scalar("SELECT EXISTS (SELECT 1 FROM organisations WHERE org = $1)").bind(deployment_org).fetch_one(&mut *tx).await?;
    let org = if taken { random_hex() } else { deployment_org.to_owned() };
    let name = match (name, claim) {
        (Some(name), _) => name.to_owned(),
        (None, "") => provider.label.clone(),
        (None, claim) => format!("{} ({claim})", provider.label),
    };
    sqlx::query("INSERT INTO organisations (org, provider, claim, name) VALUES ($1, $2, $3, $4)").bind(&org).bind(&provider.id).bind(claim).bind(&name).execute(&mut *tx).await?;
    if deployment.encryption == Encryption::E2ee {
        sqlx::query("INSERT INTO orgs (org, label) VALUES ($1, $2) ON CONFLICT (org) DO NOTHING").bind(&org).bind(&name).execute(&mut *tx).await?;
    }
    Ok(org)
}
/// What applying a token's organisations to an account did.
#[derive(Debug, Default)]
pub struct Applied {
    /// The organisations where the account now holds a role and is not stopped.
    pub active: Vec<String>,
    /// Organisations where it holds a role but an administrator disabled or removed it.
    pub stopped: Vec<(String, String)>,
    /// Whether any role changed (polls must check their access again).
    pub changed: bool,
}
/// Records the organisations and roles a token of `provider` gives the account (`grants`) in its
/// memberships, each change audited in its organisation's chain (`actor` made the change: the
/// account signing in, or the service at a refresh): a new membership is `account.created`, a
/// changed role `account.role_changed` (`by: provider`), and an organisation of this provider the
/// token no longer names loses its role (`to: null`). Memberships at other providers are not
/// touched: a provider vouches only for its own organisations.
pub async fn apply_grants(tx: &mut sqlx::PgConnection, deployment: &Deployment, deployment_org: &str, provider: &Configured, account: &str, grants: &[OrgGrant], actor: &crate::audit::Actor) -> Result<Applied, sqlx::Error> {
    let mut applied = Applied::default();
    let mut named = Vec::new();
    for grant in grants {
        let org = organisation(&mut *tx, deployment, deployment_org, provider, &grant.claim, grant.name.as_deref()).await?;
        if named.contains(&org) {
            continue;
        }
        named.push(org.clone());
        let role = grant.role.as_str();
        let old: Option<(Option<String>, String)> = sqlx::query_as("SELECT role, state FROM memberships WHERE account = $1 AND org = $2 FOR UPDATE").bind(account).bind(&org).fetch_optional(&mut *tx).await?;
        let state = match old {
            None => {
                sqlx::query("INSERT INTO memberships (account, org, role) VALUES ($1, $2, $3)").bind(account).bind(&org).bind(role).execute(&mut *tx).await?;
                crate::audit::record(&mut *tx, &org, actor, "account.created", Some(("account", account)), json!({"provider": provider.id, "role": role})).await?;
                applied.changed = true;
                "active".to_owned()
            }
            Some((from, state)) => {
                if from.as_deref() != Some(role) {
                    sqlx::query("UPDATE memberships SET role = $3, updated = now() WHERE account = $1 AND org = $2").bind(account).bind(&org).bind(role).execute(&mut *tx).await?;
                    crate::audit::record(&mut *tx, &org, &crate::audit::Actor::system(), "account.role_changed", Some(("account", account)), json!({"from": from, "to": role, "by": "provider"})).await?;
                    applied.changed = true;
                }
                state
            }
        };
        if state == "active" {
            applied.active.push(org);
        } else {
            applied.stopped.push((org, state));
        }
    }
    let gone: Vec<(String, String)> = sqlx::query_as(
        "WITH old AS (SELECT m.org, m.role FROM memberships m JOIN organisations o ON o.org = m.org
                      WHERE m.account = $1 AND o.provider = $2 AND m.role IS NOT NULL AND NOT (m.org = ANY($3)) FOR UPDATE OF m)
         UPDATE memberships m SET role = NULL, updated = now() FROM old WHERE m.account = $1 AND m.org = old.org RETURNING m.org, old.role",
    )
    .bind(account)
    .bind(&provider.id)
    .bind(&named)
    .fetch_all(&mut *tx)
    .await?;
    for (org, from) in gone {
        crate::audit::record(&mut *tx, &org, &crate::audit::Actor::system(), "account.role_changed", Some(("account", account)), json!({"from": from, "to": null, "by": "provider"})).await?;
        applied.changed = true;
    }
    Ok(applied)
}
/// The organisations an account has a membership in at a provider, with a role or one just taken
/// away (for auditing what concerns them).
async fn account_orgs(conn: &mut sqlx::PgConnection, account: &str, provider: Option<&str>) -> Result<Vec<String>, sqlx::Error> {
    sqlx::query_scalar("SELECT m.org FROM memberships m JOIN organisations o ON o.org = m.org WHERE m.account = $1 AND ($2::text IS NULL OR o.provider = $2) ORDER BY m.org")
        .bind(account)
        .bind(provider)
        .fetch_all(conn)
        .await
}

/// The endpoints named by a provider's discovery document.
#[derive(Clone)]
struct Endpoints {
    authorization_endpoint: String,
    token_endpoint: String,
    jwks_uri: String,
    /// For profile claims an ID token lacks (optional).
    userinfo_endpoint: Option<String>,
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
/// A one-time grant (a row of `sso_grants`, consumed by the redeem): the checked identity and
/// what its token said about organisations and roles.
struct Grant {
    provider: String,
    challenge: String,
    identity: Identity,
    orgs: Vec<OrgGrant>,
    refresh_token: Option<String>,
    session_seconds: i64,
}
fn identity_json(id: &Identity, orgs: &[OrgGrant]) -> Value {
    let orgs: Vec<Value> = orgs.iter().map(|g| json!({"claim": g.claim, "name": g.name, "role": g.role.as_str(), "guest": g.guest})).collect();
    json!({"subject": id.subject, "email": id.email, "email_verified": id.email_verified, "name": id.name, "picture": id.picture, "sid": id.sid, "orgs": orgs})
}
fn identity_from_json(text: &str) -> Option<(Identity, Vec<OrgGrant>)> {
    let v: Value = serde_json::from_str(text).ok()?;
    let text = |v: &Value, name: &str| v.get(name).and_then(Value::as_str).map(str::to_owned);
    let identity = Identity { subject: text(&v, "subject")?, email: text(&v, "email"), email_verified: v.get("email_verified")?.as_bool()?, name: text(&v, "name"), picture: text(&v, "picture"), sid: text(&v, "sid") };
    let orgs = v.get("orgs")?.as_array()?.iter().map(|g| Some(OrgGrant { claim: text(g, "claim")?, name: text(g, "name"), role: Role::parse(g.get("role")?.as_str()?)?, guest: g.get("guest")?.as_bool()? })).collect::<Option<Vec<_>>>()?;
    Some((identity, orgs))
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
    /// Sign-ins started per source in the current minute (this replica's view).
    starts: Mutex<HashMap<String, (Instant, u32)>>,
    starts_per_minute: u32,
}
type Shared = Arc<Sso>;

/// The source (an IPv4 address or an IPv6 /64, what one host or subscriber holds) and network
/// (IPv4 /24, IPv6 /48) that bound a client's sign-ins in progress.
pub fn source_keys(ip: std::net::IpAddr) -> (String, String) {
    use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};
    match ip.to_canonical() {
        IpAddr::V4(a) => (a.to_string(), format!("{}/24", Ipv4Addr::from(u32::from(a) & 0xffff_ff00))),
        IpAddr::V6(a) => {
            let s = a.segments();
            (format!("{}/64", Ipv6Addr::new(s[0], s[1], s[2], s[3], 0, 0, 0, 0)), format!("{}/48", Ipv6Addr::new(s[0], s[1], s[2], 0, 0, 0, 0, 0)))
        }
    }
}

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
pub(crate) fn random_hex() -> String {
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
/// An error the app tells apart by its stable `code` (documented in docs/service.md).
pub fn coded(status: StatusCode, code: &'static str, message: impl Into<String>) -> Response {
    (status, [(header::CACHE_CONTROL, "no-store")], Json(json!({"error": message.into(), "code": code}))).into_response()
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
    /// A request authenticated with an access token (userinfo).
    Bearer { url: String, token: String },
    /// A token endpoint request authenticated with `client_secret_basic`.
    Token { url: String, client_id: String, client_secret: String, form: Vec<(&'static str, String)> },
}
/// An outbound call failed before an HTTP status arrived (network, TLS, size, timeout).
struct Unreachable;

impl Sso {
    pub fn new(store: Arc<Store>) -> Shared {
        let config: &Config = &store.config;
        let starts_per_minute = config.sso_starts_per_minute;
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
            starts: Mutex::default(),
            starts_per_minute,
        })
    }

    /// Makes the one organisation of each provider whose tokens name none, in the configured
    /// order, so the first such takes the deployment's ID (called at every start).
    pub async fn prepare(&self) -> Result<(), sqlx::Error> {
        let (Some(deployment), Some(org)) = (&self.deployment, &self.org) else { return Ok(()) };
        for provider in deployment.providers.iter().filter(|p| crate::claims::single_organisation(p)) {
            let mut tx = self.store.pool.begin().await?;
            organisation(&mut tx, deployment, org, provider, "", None).await?;
            tx.commit().await?;
        }
        Ok(())
    }
    /// The deployment and the provider with this ID, if both are configured.
    /// Counts a sign-in start from `source`; `false` past `sso_starts_per_minute`.
    fn allow_start(&self, source: &str) -> bool {
        let mut starts = self.starts.lock().unwrap();
        if starts.len() >= MAX_RATED_SOURCES && !starts.contains_key(source) {
            starts.retain(|_, (since, _)| since.elapsed() < Duration::from_secs(60));
            if starts.len() >= MAX_RATED_SOURCES {
                // Many sources at once: the per-source and per-network bounds on stored sign-ins
                // still hold, so let it through rather than refuse everyone.
                return true;
            }
        }
        let (since, count) = starts.entry(source.to_owned()).or_insert((Instant::now(), 0));
        if since.elapsed() >= Duration::from_secs(60) {
            (*since, *count) = (Instant::now(), 0);
        }
        *count += 1;
        *count <= self.starts_per_minute
    }
    fn configured(&self, provider: &str) -> Option<(&Deployment, &Configured)> {
        let deployment = self.deployment.as_ref()?;
        Some((deployment, deployment.provider(provider)?))
    }
    /// The login for a bearer token, if it is valid, unexpired and unrevoked, its provider is
    /// still configured with the same issuer, its account is active, and the account holds a role
    /// in at least one of that provider's organisations (read now, so a role the provider took away
    /// at a refresh, or an administrator's emergency stop, takes effect at once). Guest roles count
    /// only while the deployment admits guests.
    pub async fn login(&self, token: &str) -> Result<Option<Login>, StoreError> {
        if !is_hex64(token) {
            return Ok(None);
        }
        let Some(org) = &self.org else { return Ok(None) };
        let row = sqlx::query(
            "SELECT l.provider, l.issuer, l.subject, a.email, a.email_verified, a.name, a.picture, extract(epoch FROM l.expires)::bigint, l.account
             FROM sso_logins l JOIN accounts a ON a.account = l.account
             WHERE l.token_hash = $1 AND NOT l.revoked AND l.expires > now() AND l.provider IS NOT NULL AND a.state = 'active'",
        )
        .bind(sha256_hex(token.as_bytes()))
        .fetch_optional(&self.store.pool)
        .await?;
        let Some(row) = row else { return Ok(None) };
        let (provider, issuer, account): (String, String, String) = (row.get(0), row.get(1), row.get(8));
        let Some((deployment, _)) = self.configured(&provider).filter(|(_, p)| p.issuer == issuer) else { return Ok(None) };
        let orgs = memberships(&self.store.pool, deployment, &account, &provider).await?;
        if orgs.is_empty() {
            return Ok(None);
        }
        Ok(Some(Login {
            org: org.clone(),
            account,
            provider,
            issuer,
            subject: row.get(2),
            email: row.get(3),
            email_verified: row.get(4),
            name: row.get(5),
            picture: row.get(6),
            orgs,
            expires: UNIX_EPOCH + Duration::from_secs(row.get::<i64, _>(7).max(0) as u64),
        }))
    }
    /// The person this login's subject is linked to in an end-to-end organisation, and whether
    /// that link is blocked.
    pub async fn linked_person(&self, org: &str, login: &Login) -> Result<Option<(String, bool)>, StoreError> {
        let row = sqlx::query("SELECT person, state FROM sso_links WHERE org = $1 AND issuer = $2 AND subject = $3")
            .bind(org)
            .bind(&login.issuer)
            .bind(&login.subject)
            .fetch_optional(&self.store.pool)
            .await?;
        Ok(row.map(|r| (r.get(0), r.get::<String, _>(1) == "blocked")))
    }
    /// Links the subject to a person of an end-to-end organisation: Ok if newly linked or already
    /// linked to the same person (a blocked link stays blocked); Err(Conflict) if the subject or
    /// the person is linked elsewhere in that organisation.
    pub async fn link(&self, org: &str, login: &Login, person: &str) -> Result<(), LinkError> {
        let mut tx = self.store.pool.begin().await?;
        Self::link_in(&mut tx, org, login, person).await?;
        tx.commit().await?;
        Ok(())
    }
    /// [`Sso::link`] inside the caller's transaction, so the link commits (or not) with what
    /// it belongs to, such as the membership event that admits the person.
    pub async fn link_in(tx: &mut sqlx::PgConnection, org: &str, login: &Login, person: &str) -> Result<(), LinkError> {
        if !scribyra_core::orgsync::is_uuid(person) {
            return Err(LinkError::Invalid);
        }
        let existing = sqlx::query("SELECT issuer, subject, person FROM sso_links WHERE org = $1 AND ((issuer = $2 AND subject = $3) OR person = $4) FOR UPDATE")
            .bind(org)
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
                .bind(org)
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
                Outbound::Bearer { url, token } => agent.get(&url).header("Accept", "application/json").header("Authorization", &format!("Bearer {token}")).call(),
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
            userinfo_endpoint: field("userinfo_endpoint"),
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
    /// Revoke logins (`sql` returns each revoked login's issuer, subject, account and provider),
    /// with `block` also block the accounts and their end-to-end links, and fire the hook for each
    /// linked person; each account whose login ended gets one audit event (`audit`) in every
    /// organisation it has a membership in at that provider, in the same transaction.
    async fn revoke_where(&self, sql: &str, binds: &[Option<&str>], block: bool, audit: Revoked<'_>) -> Result<u64, StoreError> {
        let mut query = sqlx::query(sql);
        for bind in binds {
            query = query.bind(*bind);
        }
        let mut tx = self.store.pool.begin().await?;
        let rows = query.fetch_all(&mut *tx).await?;
        let mut fired = Vec::new();
        let mut audited = std::collections::HashSet::new();
        for row in &rows {
            let (issuer, subject, account, provider): (String, String, Option<String>, Option<String>) = (row.get(0), row.get(1), row.get(2), row.get(3));
            let people: Vec<(String, String)> = if block {
                sqlx::query_as("UPDATE sso_links SET state = 'blocked' WHERE issuer = $1 AND subject = $2 RETURNING org, person")
            } else {
                sqlx::query_as("SELECT org, person FROM sso_links WHERE issuer = $1 AND subject = $2")
            }
            .bind(&issuer)
            .bind(&subject)
            .fetch_all(&mut *tx)
            .await?;
            fired.extend(people);
            if block {
                sqlx::query("UPDATE accounts SET state = 'blocked' WHERE issuer = $1 AND subject = $2 AND state = 'active'").bind(&issuer).bind(&subject).execute(&mut *tx).await?;
            }
            let Some(account) = account else { continue };
            // The account's heads polls check their sessions at once (review L6).
            crate::server_projects::notify_account(&mut tx, &account).await?;
            if audited.insert(account.clone()) {
                let actor = match audit.by_self {
                    Some(ip) => crate::audit::Actor::account(&account, ip),
                    None => crate::audit::Actor::system(),
                };
                let orgs = account_orgs(&mut tx, &account, provider.as_deref()).await?;
                crate::audit::record_each(&mut tx, &orgs, &actor, audit.action, Some(("account", &account)), audit.detail.clone()).await?;
            }
        }
        tx.commit().await?;
        fired.sort();
        fired.dedup();
        for event in fired {
            let _ = self.revoked.send(event);
        }
        Ok(rows.len() as u64)
    }

    /// An administrator disabled or removed the account in one organisation (in the caller's
    /// transaction): its sessions at that organisation's provider are revoked (it signs in again
    /// for any other organisation it is in there), its access to this organisation ends until an
    /// administrator re-enables it, and its heads polls check again. Returns the end-to-end (org,
    /// person) pairs of that organisation whose device sessions [`Sso::announce`] closes once the
    /// transaction committed.
    pub async fn stop_in(tx: &mut sqlx::PgConnection, account: &str, org: &str) -> Result<Vec<(String, String)>, sqlx::Error> {
        sqlx::query("UPDATE sso_logins SET revoked = true WHERE account = $1 AND NOT revoked AND provider = (SELECT provider FROM organisations WHERE org = $2)").bind(account).bind(org).execute(&mut *tx).await?;
        let fired: Vec<(String, String)> =
            sqlx::query_as("SELECT l.org, l.person FROM sso_links l JOIN accounts a ON a.issuer = l.issuer AND a.subject = l.subject WHERE a.account = $1 AND l.org = $2").bind(account).bind(org).fetch_all(&mut *tx).await?;
        crate::server_projects::notify_account(&mut *tx, account).await?;
        Ok(fired)
    }
    pub fn announce(&self, fired: Vec<(String, String)>) {
        for event in fired {
            let _ = self.revoked.send(event);
        }
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
    /// login of that subject at that provider and blocks the account and its links; any other 4xx
    /// revokes that login only; network and server errors keep the login and retry on the next
    /// pass. A refreshed ID token updates the account's profile and its memberships (organisations,
    /// roles, guest marks, [`apply_grants`]); a role taken away ends access to that organisation at
    /// once, and an account left without any role at the provider has its logins there revoked
    /// (not blocked: the provider still vouches for it).
    ///
    /// Every replica runs this pass; a due login is claimed before its provider is called (`FOR
    /// UPDATE SKIP LOCKED`, and `checked` moved in the same statement), so only one replica ever
    /// uses a given refresh token (review H3: two using it looked like token theft to providers
    /// with reuse detection, and the `invalid_grant` that followed revoked and blocked the person).
    pub async fn recheck(&self) {
        // Expired or revoked logins are kept a week for operators, then deleted.
        let _ = sqlx::query("DELETE FROM sso_logins WHERE expires < now() - interval '7 days' OR (revoked AND created < now() - interval '7 days')")
            .execute(&self.store.pool)
            .await;
        let (Some(deployment), Some(org)) = (&self.deployment, &self.org) else { return };
        let (mut checked, mut refreshed, mut revoked, mut failed) = (0usize, 0u32, 0u32, 0u32);
        for configured in &deployment.providers {
            let rows = sqlx::query(
                "UPDATE sso_logins l SET checked = now() FROM (
                   SELECT token_hash, checked FROM sso_logins
                   WHERE org = $1 AND provider = $2 AND NOT revoked AND refresh_token IS NOT NULL AND expires > now()
                     AND checked <= now() - make_interval(secs => $3)
                   ORDER BY checked LIMIT $4 FOR UPDATE SKIP LOCKED) due
                 WHERE l.token_hash = due.token_hash
                 RETURNING l.token_hash, l.issuer, l.subject, l.refresh_token, extract(epoch FROM due.checked)::float8, l.account",
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
                let (token_hash, issuer, subject, refresh, account): (String, String, String, String, Option<String>) = (row.get(0), row.get(1), row.get(2), row.get(3), row.get(5));
                let outcome = match account {
                    Some(account) if issuer == configured.issuer => self.recheck_one(deployment, configured, org, &token_hash, &subject, &account, refresh).await,
                    _ => Ok(Recheck::Retry),
                };
                match outcome {
                    Ok(Recheck::Kept) => refreshed += 1,
                    Ok(Recheck::Revoked) => revoked += 1,
                    Ok(Recheck::Retry) | Err(_) => {
                        failed += 1;
                        // Not checked after all: due again on the next pass (on any replica).
                        let _ = sqlx::query("UPDATE sso_logins SET checked = to_timestamp($2) WHERE token_hash = $1").bind(&token_hash).bind(row.get::<f64, _>(4)).execute(&self.store.pool).await;
                    }
                }
            }
        }
        if checked > 0 {
            println!("{}", json!({"event": "sso_recheck", "checked": checked, "refreshed": refreshed, "revoked": revoked, "failed": failed}));
        }
    }
    #[allow(clippy::too_many_arguments)]
    async fn recheck_one(&self, deployment: &Deployment, configured: &Configured, org: &str, token_hash: &str, subject: &str, account: &str, refresh: String) -> Result<Recheck, StoreError> {
        let (Ok(endpoints), Ok(secret)) = (self.endpoints(&configured.issuer).await, configured.client_secret()) else { return Ok(Recheck::Retry) };
        let outcome = self
            .call(Outbound::Token {
                url: endpoints.token_endpoint.clone(),
                client_id: configured.client_id.clone(),
                client_secret: secret,
                form: vec![("grant_type", "refresh_token".into()), ("refresh_token", refresh)],
            })
            .await;
        let same_subject = "UPDATE sso_logins SET revoked = true WHERE issuer = $1 AND subject = $2 AND provider = $3 AND NOT revoked RETURNING issuer, subject, account, provider";
        let binds = [Some(configured.issuer.as_str()), Some(subject), Some(configured.id.as_str())];
        match outcome {
            Ok((200, body)) => {
                let tokens: Value = serde_json::from_slice(&body).unwrap_or(Value::Null);
                let rotated = tokens.get("refresh_token").and_then(Value::as_str).filter(|t| t.len() <= 8192).map(str::to_owned);
                // A refreshed ID token (when the provider sends one) carries current claims.
                let mut checked = None;
                if let Some(id_token) = tokens.get("id_token").and_then(Value::as_str) {
                    let Ok(verified) = self.verify(&endpoints, id_token).await else { return Ok(Recheck::Retry) };
                    let expect = expect(configured, None);
                    match jose::check_refreshed_id_token(&verified.claims, &expect) {
                        Ok(id) if id.subject == subject => checked = Some((id, verified.claims)),
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
                let Some((mut id, claims)) = checked else { return Ok(Recheck::Kept) };
                self.complete_profile(&endpoints, tokens.get("access_token").and_then(Value::as_str), &claims, &mut id).await;
                id.email = id.email.as_deref().map(normalise_email);
                let mapped = crate::claims::map(configured, guest_policy(deployment), &claims, subject);
                let mut tx = self.store.pool.begin().await?;
                sqlx::query("UPDATE accounts SET email = $2, email_verified = $3, name = $4, picture = $5 WHERE account = $1")
                    .bind(account)
                    .bind(&id.email)
                    .bind(id.email_verified)
                    .bind(&id.name)
                    .bind(&id.picture)
                    .execute(&mut *tx)
                    .await?;
                let applied = apply_grants(&mut tx, deployment, org, configured, account, mapped.as_deref().unwrap_or(&[]), &crate::audit::Actor::system()).await?;
                if applied.changed {
                    // Polls of the account check their access again at once.
                    crate::server_projects::notify_account(&mut tx, account).await?;
                }
                tx.commit().await?;
                if applied.changed && deployment.encryption == Encryption::Server {
                    crate::server_projects::accept_invitations(&self.store.pool, account, &configured.id, None).await?;
                }
                let refused = match &mapped {
                    Err(refusal) => Some(refusal.code()),
                    Ok(_) if memberships(&self.store.pool, deployment, account, &configured.id).await?.is_empty() => Some("no_access"),
                    Ok(_) => None,
                };
                if let Some(reason) = refused {
                    log("sso_refused", "recheck_rules");
                    self.revoke_where(same_subject, &binds, false, Revoked::system("session.revoked", json!({"reason": reason, "provider": configured.id}))).await?;
                    return Ok(Recheck::Revoked);
                }
                Ok(Recheck::Kept)
            }
            // 408 and 429 are transient: keep the login and retry on the next pass.
            Ok((status, body)) if (400..500).contains(&status) && status != 408 && status != 429 => {
                let invalid_grant = serde_json::from_slice::<Value>(&body).ok().is_some_and(|v| v.get("error").and_then(Value::as_str) == Some("invalid_grant"));
                if invalid_grant {
                    self.revoke_where(same_subject, &binds, true, Revoked::system("account.blocked", json!({"reason": "provider_refused", "provider": configured.id}))).await?;
                } else {
                    self.revoke_where("UPDATE sso_logins SET revoked = true WHERE token_hash = $1 AND NOT revoked RETURNING issuer, subject, account, provider", &[Some(token_hash)], false, Revoked::system("session.revoked", json!({"reason": "provider_refused_token", "provider": configured.id}))).await?;
                }
                Ok(Recheck::Revoked)
            }
            _ => Ok(Recheck::Retry),
        }
    }
    /// Fills profile claims the ID token lacks (email and `email_verified`, name, picture) from the
    /// provider's userinfo endpoint (OpenID Connect Core 1.0, section 5.3), whose `sub` must be the
    /// token's. Only the profile: organisations and roles are read from the verified ID token alone.
    /// A `email_verified` the userinfo gives counts only for the email it gives with it.
    async fn complete_profile(&self, endpoints: &Endpoints, access_token: Option<&str>, claims: &serde_json::Map<String, Value>, id: &mut Identity) {
        let (lacks_email, lacks_verified) = (!claims.contains_key("email"), !claims.contains_key("email_verified"));
        if !(lacks_email || lacks_verified || id.name.is_none() || id.picture.is_none()) {
            return;
        }
        let (Some(url), Some(token)) = (&endpoints.userinfo_endpoint, access_token.filter(|t| !t.is_empty() && t.len() <= 8192)) else { return };
        let Ok((200, body)) = self.call(Outbound::Bearer { url: url.clone(), token: token.to_owned() }).await else { return };
        let Ok(Value::Object(info)) = serde_json::from_slice::<Value>(&body) else { return };
        if info.get("sub").and_then(Value::as_str) != Some(id.subject.as_str()) {
            log("sso_refused", "userinfo_subject");
            return;
        }
        let text = |k: &str| info.get(k).and_then(Value::as_str).filter(|t| !t.is_empty() && t.len() <= 512).map(str::to_owned);
        let verified = info.get("email_verified") == Some(&Value::Bool(true));
        if lacks_email {
            if let Some(email) = text("email") {
                (id.email, id.email_verified) = (Some(email), verified);
            }
        } else if lacks_verified && text("email").map(|e| normalise_email(&e)) == id.email.as_deref().map(normalise_email) {
            id.email_verified = verified;
        }
        if id.name.is_none() {
            id.name = text("name");
        }
        if id.picture.is_none() {
            id.picture = jose::picture(info.get("picture"));
        }
    }
}
/// The guest policy claims are mapped with: guests count only where the deployment admits them.
fn guest_policy(deployment: &Deployment) -> Guests {
    if guests_admitted(deployment) { Guests::Shared } else { Guests::Off }
}
/// The audit event a revocation records for each account whose login ended: by the account
/// itself (signing out, with its client address) or by the service (`by_self: None`).
struct Revoked<'a> {
    action: &'a str,
    detail: Value,
    by_self: Option<Option<std::net::IpAddr>>,
}
impl<'a> Revoked<'a> {
    fn system(action: &'a str, detail: Value) -> Self {
        Self { action, detail, by_self: None }
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
        now: now_seconds(),
    }
}

/// A login as `/v1/sso/redeem` and `/v1/sso/me` show it (docs/service.md): the account's profile,
/// its organisations with their roles (`orgs`, oldest first) and, for organisation `chosen` (the
/// first one unless `/v1/sso/me` names another with `Scribyra-Org`), `role` and the end-to-end
/// link (`person`, `state`). `org` is the deployment's ID.
fn login_json(login: &Login, chosen: &str, link: Option<(String, bool)>) -> Value {
    let state = match &link {
        None => "unlinked",
        Some((_, false)) => "linked",
        Some((_, true)) => "blocked",
    };
    let orgs: Vec<Value> = login.orgs.iter().map(|m| json!({"id": m.org, "name": m.name, "provider": login.provider, "role": m.role.as_str(), "guest": m.role == Role::Guest})).collect();
    json!({
        "expires": login.expires.duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0),
        "org": login.org,
        "provider": login.provider,
        "role": login.membership(chosen).or(login.orgs.first()).map(|m| m.role.as_str()),
        "orgs": orgs,
        "subject": {"email": login.email, "name": login.name},
        "person": link.map(|(p, _)| p),
        "state": state,
        "account": login.account,
        "email": login.email.as_ref().filter(|_| login.email_verified),
        "emailVerified": login.email_verified,
        "name": login.name,
        "picture": login.picture,
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
    let (source, network) = source.map(|axum::Extension(crate::service::Source(ip))| source_keys(ip)).unwrap_or_default();
    let Some(public_url) = s.public_url.clone() else {
        return error(StatusCode::NOT_FOUND, "sign-in needs public_url on this service");
    };
    if !s.allow_start(&source) {
        log("sso_refused", "start_rate");
        return error(StatusCode::TOO_MANY_REQUESTS, "too many sign-ins started; try again in a minute");
    }
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
        .append_pair("redirect_uri", &callback_uri(&public_url, &request.provider))
        .append_pair("scope", &configured.scope())
        .append_pair("state", &state)
        .append_pair("nonce", &nonce)
        .append_pair("code_challenge", &idp_challenge)
        .append_pair("code_challenge_method", "S256");
    // In PostgreSQL, so the provider's redirect may reach any replica. Nobody is refused for
    // room: a source past its own few sign-ins replaces its oldest, a network past its share
    // replaces its oldest, and a full table (or provider) drops the oldest sign-in of the network
    // that holds the most, so one source or network cannot push others out (reviews M2, M5).
    let stored = async {
        let mut tx = s.store.pool.begin().await?;
        sqlx::query("DELETE FROM sso_flows WHERE expires <= now()").execute(&mut *tx).await?;
        sqlx::query("LOCK TABLE sso_flows IN SHARE ROW EXCLUSIVE MODE").execute(&mut *tx).await?;
        let (all, provider, mine, near): (i64, i64, i64, i64) =
            sqlx::query_as("SELECT count(*), count(*) FILTER (WHERE provider = $1), count(*) FILTER (WHERE source = $2), count(*) FILTER (WHERE network = $3) FROM sso_flows")
                .bind(&request.provider)
                .bind(&source)
                .bind(&network)
                .fetch_one(&mut *tx)
                .await?;
        for (filter, value, over) in [("source = $1", &source, mine - MAX_FLOWS_PER_SOURCE as i64 + 1), ("network = $1", &network, near - MAX_FLOWS_PER_NETWORK as i64 + 1)] {
            if over > 0 {
                let sql = format!("DELETE FROM sso_flows WHERE state_hash IN (SELECT state_hash FROM sso_flows WHERE {filter} ORDER BY expires LIMIT $2)");
                sqlx::query(&sql).bind(value).bind(over).execute(&mut *tx).await?;
            }
        }
        for (filter, value, over) in [("provider = $1", &request.provider, provider - MAX_FLOWS_PER_PROVIDER as i64 + 1), ("$1 = $1", &String::new(), all - MAX_FLOWS as i64 + 1)] {
            for _ in 0..over.max(0) {
                let sql = format!(
                    "DELETE FROM sso_flows WHERE state_hash = (SELECT state_hash FROM sso_flows WHERE {filter} AND network = (
                       SELECT network FROM sso_flows WHERE {filter} GROUP BY network ORDER BY count(*) DESC, min(expires) LIMIT 1) ORDER BY expires LIMIT 1)"
                );
                sqlx::query(&sql).bind(value).execute(&mut *tx).await?;
            }
        }
        sqlx::query("INSERT INTO sso_flows (state_hash, provider, return_to, challenge, nonce, verifier, expires, source, network) VALUES ($1, $2, $3, $4, $5, $6, now() + make_interval(secs => $7), $8, $9)")
            .bind(sha256_hex(state.as_bytes()))
            .bind(&request.provider)
            .bind(&request.return_to)
            .bind(&request.challenge)
            .bind(&nonce)
            .bind(&verifier)
            .bind(FLOW_SECONDS as f64)
            .bind(&source)
            .bind(&network)
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
/// A refused sign-in in progress; the refusal's code rides along so the callback can record it.
#[derive(Clone, Copy)]
struct Refused(&'static str);
fn fail(return_to: &str, code: &'static str) -> Response {
    log("sso_refused", code);
    let mut response = redirect(format!("{return_to}/#scribyra-sso-error={code}"));
    response.extensions_mut().insert(Refused(code));
    response
}
/// The redirect URI registered at a provider: `<public_url>/v1/sso/callback/<provider id>`.
pub fn callback_uri(public_url: &str, provider: &str) -> String {
    format!("{public_url}/v1/sso/callback/{provider}")
}
/// The provider's redirect back. A refusal of a sign-in in progress is recorded in the audit log
/// (`session.refused` with its reason); an unknown or reused `state` is not, since anyone can send
/// one (sign-ins in progress are bounded per source, so their refusals are too).
async fn callback(state: State<Shared>, source: Option<axum::Extension<crate::service::Source>>, provider: axum::extract::Path<String>, query: Query<HashMap<String, String>>) -> Response {
    let (s, id) = (state.0.clone(), provider.0.clone());
    let response = callback_flow(state, provider, query).await;
    if let Some(Refused(code)) = response.extensions().get::<Refused>().copied() {
        let detail = json!({"reason": code, "provider": if s.configured(&id).is_some() { Some(id) } else { None }});
        crate::audit::record_or_log(&s.store.pool, &[], &crate::audit::Actor { account: None, ip: crate::audit::source(&source) }, "session.refused", None, detail).await;
    }
    response
}
async fn callback_flow(State(s): State<Shared>, axum::extract::Path(provider): axum::extract::Path<String>, Query(query): Query<HashMap<String, String>>) -> Response {
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
    // A response arriving at another provider's redirect URI is not this sign-in's (review L4:
    // a mix-up between providers), whatever `iss` it carries or omits.
    if provider != flow.provider {
        return fail(&flow.return_to, "idp_error");
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
                ("redirect_uri", callback_uri(&public_url, &flow.provider)),
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
    let mut identity = match jose::check_id_token(&verified.claims, &expect(configured, Some(&flow.nonce))) {
        Ok(identity) => identity,
        Err(e) => {
            log("sso_refused", claim_reason(e));
            return fail(&flow.return_to, e.code());
        }
    };
    // Organisations and roles from this provider's own verified token; no mapped role, guests
    // (when the deployment admits none) and missing organisation claims stop here.
    let orgs = match crate::claims::map(configured, guest_policy(deployment), &verified.claims, &identity.subject) {
        Ok(orgs) => orgs,
        Err(refusal) => return fail(&flow.return_to, refusal.code()),
    };
    s.complete_profile(&endpoints, tokens.get("access_token").and_then(Value::as_str), &verified.claims, &mut identity).await;
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
            .bind(identity_json(&identity, &orgs).to_string())
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
async fn redeem(State(s): State<Shared>, source: Option<axum::Extension<crate::service::Source>>, Json(request): Json<RedeemRequest>) -> Response {
    let ip = crate::audit::source(&source);
    // Single use: a redeem attempt consumes the grant even when the verifier is wrong.
    let grant = sqlx::query_as::<_, (String, String, String, Option<String>, i64)>(
        "DELETE FROM sso_grants WHERE code_hash = $1 AND expires > now() RETURNING provider, challenge, identity::text, refresh_token, session_seconds",
    )
    .bind(sha256_hex(request.code.as_bytes()))
    .fetch_optional(&s.store.pool)
    .await;
    let mut grant = match grant {
        Ok(Some((provider, challenge, identity, refresh_token, session_seconds))) => match identity_from_json(&identity) {
            Some((identity, orgs)) => Grant { provider, challenge, identity, orgs, refresh_token, session_seconds },
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
    grant.identity.email = grant.identity.email.as_deref().map(normalise_email);
    let id = &grant.identity;
    // The account (issuer, subject): made at the first sign-in, its profile refreshed at every
    // one. A sign-in the provider admits again clears a block from a refused refresh token.
    let mut tx = match s.store.pool.begin().await {
        Ok(tx) => tx,
        Err(e) => return internal(e),
    };
    let account = sqlx::query_as::<_, (String, String)>(
        "INSERT INTO accounts (account, provider, issuer, subject, email, email_verified, name, picture) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (issuer, subject) DO UPDATE SET provider = EXCLUDED.provider, email = EXCLUDED.email, email_verified = EXCLUDED.email_verified,
           name = EXCLUDED.name, picture = EXCLUDED.picture, last_seen = now(), state = CASE WHEN accounts.state = 'blocked' THEN 'active' ELSE accounts.state END
         RETURNING account, state",
    )
    .bind(random_hex())
    .bind(&grant.provider)
    .bind(&configured.issuer)
    .bind(&id.subject)
    .bind(&id.email)
    .bind(id.email_verified)
    .bind(&id.name)
    .bind(&id.picture)
    .fetch_one(&mut *tx)
    .await;
    let (account, state) = match account {
        Ok(row) => row,
        Err(e) => return internal(e),
    };
    let refuse = |code: &'static str| coded(StatusCode::FORBIDDEN, code, refusal_message(code, &configured.label));
    if state != "active" {
        let _ = tx.rollback().await;
        let reason = if state == "removed" { "account_removed" } else { "account_disabled" };
        log("sso_refused", reason);
        crate::audit::record_or_log(&s.store.pool, &[], &crate::audit::Actor::account(&account, ip), "session.refused", Some(("account", &account)), json!({"reason": reason, "provider": grant.provider})).await;
        return refuse(reason);
    }
    let applied = match apply_grants(&mut tx, deployment, &org, configured, &account, &grant.orgs, &crate::audit::Actor::account(&account, ip)).await {
        Ok(applied) => applied,
        Err(e) => return internal(e),
    };
    // Every organisation it holds a role in stopped it (an administrator disabled or removed it).
    if applied.active.is_empty() {
        let reason = if applied.stopped.iter().all(|(_, state)| state == "removed") { "account_removed" } else { "account_disabled" };
        let stopped: Vec<String> = applied.stopped.iter().map(|(org, _)| org.clone()).collect();
        let refused = crate::audit::record_each(&mut tx, &stopped, &crate::audit::Actor::account(&account, ip), "session.refused", Some(("account", &account)), json!({"reason": reason, "provider": grant.provider})).await;
        if let Err(e) = refused {
            return internal(e);
        }
        if let Err(e) = tx.commit().await {
            return internal(e);
        }
        log("sso_refused", reason);
        return refuse(reason);
    }
    let inserted = sqlx::query(
        "INSERT INTO sso_logins (token_hash, org, provider, issuer, subject, email, email_verified, name, picture, sid, refresh_token, expires, account)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, now() + make_interval(secs => $12), $13)",
    )
    .bind(sha256_hex(token.as_bytes()))
    .bind(&org)
    .bind(&grant.provider)
    .bind(&configured.issuer)
    .bind(&id.subject)
    .bind(&id.email)
    .bind(id.email_verified)
    .bind(&id.name)
    .bind(&id.picture)
    .bind(&id.sid)
    .bind(&grant.refresh_token)
    .bind(grant.session_seconds as f64)
    .bind(&account)
    .execute(&mut *tx)
    .await;
    if let Err(e) = inserted {
        return internal(e);
    }
    for active in &applied.active {
        let role: Option<String> = match sqlx::query_scalar("SELECT role FROM memberships WHERE account = $1 AND org = $2").bind(&account).bind(active).fetch_one(&mut *tx).await {
            Ok(role) => role,
            Err(e) => return internal(e),
        };
        if let Err(e) = crate::audit::record(&mut tx, active, &crate::audit::Actor::account(&account, ip), "session.sign_in", Some(("account", &account)), json!({"provider": grant.provider, "role": role})).await {
            return internal(e);
        }
    }
    if applied.changed
        && let Err(e) = crate::server_projects::notify_account(&mut tx, &account).await
    {
        return internal(e);
    }
    if let Err(e) = tx.commit().await {
        return internal(e);
    }
    // Server-readable deployments: pending invitations to this verified email in the account's
    // organisations become shares.
    if deployment.encryption == Encryption::Server
        && let Err(e) = crate::server_projects::accept_invitations(&s.store.pool, &account, &grant.provider, ip).await
    {
        return internal(e);
    }
    let login = match s.login(&token).await {
        Ok(Some(login)) => login,
        Ok(None) => return refuse("no_role"),
        Err(e) => return internal(e),
    };
    let link = match s.linked_person(&login.orgs[0].org, &login).await {
        Ok(link) => link,
        Err(e) => return internal(e),
    };
    let mut body = login_json(&login, &login.orgs[0].org, link);
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
    // `Scribyra-Org` names the organisation whose role and end-to-end link to show (the first by default).
    let chosen = match headers.get(ORG_HEADER) {
        None => login.orgs[0].org.clone(),
        Some(_) => match login.active(&headers) {
            Ok(m) => m.org.clone(),
            Err(choice) => return org_choice_error(choice),
        },
    };
    match s.linked_person(&chosen, &login).await {
        Ok(link) => (StatusCode::OK, [(header::CACHE_CONTROL, "no-store")], Json(login_json(&login, &chosen, link))).into_response(),
        Err(e) => internal(e),
    }
}
async fn logout(State(s): State<Shared>, source: Option<axum::Extension<crate::service::Source>>, headers: HeaderMap) -> Response {
    let Some(token) = bearer(&headers) else { return error(StatusCode::UNAUTHORIZED, "sign in required") };
    let hash = sha256_hex(token.as_bytes());
    let signed_out = Revoked { action: "session.sign_out", detail: json!({}), by_self: Some(crate::audit::source(&source)) };
    match s
        .revoke_where("UPDATE sso_logins SET revoked = true WHERE token_hash = $1 AND NOT revoked AND expires > now() RETURNING issuer, subject, account, provider", &[Some(&hash)], false, signed_out)
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
                 RETURNING issuer, subject, account, provider",
                &[Some(org), Some(issuer), logout.subject.as_deref(), logout.sid.as_deref(), Some(&configured.id)],
                false,
                Revoked::system("session.revoked", json!({"reason": "provider_logout", "provider": configured.id})),
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
        .route("/v1/sso/callback/{provider}", get(callback))
        .route("/v1/sso/redeem", post(redeem))
        .route("/v1/sso/me", get(me))
        .route("/v1/sso/logout", post(logout))
        .route("/v1/sso/backchannel", post(backchannel))
        .with_state(s)
}
