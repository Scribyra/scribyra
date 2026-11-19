use serde::{Deserialize, Serialize};
use std::{
    net::{IpAddr, SocketAddr},
    path::PathBuf,
};

/// Prefix of configuration errors that are safe to print (they name fields, never values).
pub const INVALID: &str = "invalid configuration: ";
#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Principal {
    pub token_hash: String,
    pub namespace: String,
    pub storage: bool,
    pub relay: bool,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum BlobBackend {
    Filesystem,
    S3,
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(default, deny_unknown_fields)]
pub struct Config {
    pub bind: SocketAddr,
    /// Filesystem blob directory (used when `blob_store` is `filesystem`).
    pub data: PathBuf,
    /// PostgreSQL URL. Secret: never logged. Exactly one of this and `database_url_file`.
    pub database_url: Option<String>,
    pub database_url_file: Option<PathBuf>,
    /// Pool size; one more dedicated connection holds the single-owner advisory lock.
    pub database_connections: u32,
    pub blob_store: BlobBackend,
    pub s3_endpoint: Option<String>,
    pub s3_region: Option<String>,
    pub s3_bucket: Option<String>,
    pub s3_access_key_id: Option<String>,
    pub s3_secret_access_key_file: Option<PathBuf>,
    pub s3_path_style: bool,
    /// PEM file with the only certificate authority trusted for `s3_endpoint` (optional).
    pub s3_ca_file: Option<PathBuf>,
    pub origins: Vec<String>,
    pub principals: Vec<Principal>,
    pub object_bytes: usize,
    pub namespace_bytes: u64,
    pub total_bytes: u64,
    pub namespace_objects: u64,
    pub total_objects: u64,
    pub tcp_connections: usize,
    pub http_concurrency: usize,
    pub requests_per_second: u32,
    pub source_requests_per_second: u32,
    pub rate_sources: usize,
    pub trusted_proxies: Vec<IpAddr>,
    pub uploads: usize,
    pub principal_uploads: usize,
    pub namespace_uploads: usize,
    pub namespace_downloads: usize,
    pub response_bytes: usize,
    pub send_seconds: u64,
    pub connections: usize,
    pub rooms: usize,
    pub room_seconds: u64,
    pub namespace_rooms: usize,
    pub namespace_connections: usize,
    pub room_attempts: usize,
    pub namespace_room_attempts: usize,
    pub frame_bytes: usize,
    pub messages_per_second: u32,
    /// Exact origin clients use to reach this service (for example https://sync.example.org).
    /// Signed into every organisation sign-in; organisations are disabled without it.
    pub public_url: Option<String>,
    /// A file holding the deployment's 32-byte master key. Required for server-readable
    /// deployments (`deployment.encryption = "server"`), which seal projects under it.
    pub service_key_file: Option<std::path::PathBuf>,
    /// Encrypted bytes one organisation may store.
    pub org_bytes: u64,
    /// Log entries up to this size live in the database; larger ones in the blob store.
    pub entry_inline_bytes: usize,
    /// Signed-in organisation sessions held in memory.
    pub sessions: usize,
    /// How often the single sign-on recheck runs (each login is rechecked after its org's
    /// `recheck_seconds`).
    pub sso_recheck_tick_seconds: u64,
    /// Minimum interval between JWKS refetches triggered by an unknown key ID.
    pub sso_jwks_refetch_seconds: u64,
    /// Sign-ins one source (an IPv4 address or an IPv6 /64) may start per minute, per replica.
    pub sso_starts_per_minute: u32,
    /// The organisation this deployment serves: its policy and sign-in providers. Optional only
    /// so a plain object store and relay can run without one; every organisation route needs it.
    pub deployment: Option<Deployment>,
    /// Apply pending migrations at start (default). With `false` the service refuses to start
    /// unless the database schema is exactly the one it was built for; run `scribyra-sync
    /// migrate` (for example as a Kubernetes Job) first.
    pub migrate_on_start: bool,
    /// After SIGTERM: stop accepting, end long polls, and give in-flight requests this long to
    /// finish before exiting 0.
    pub shutdown_grace_seconds: u64,
    /// Server-readable mode: largest log entry (one Yjs update, or a project's initial state).
    pub sr_entry_bytes: usize,
    /// Server-readable mode: largest asset or history object.
    pub sr_object_bytes: usize,
    /// Server-readable mode: write a snapshot after this many entries since the last one...
    pub sr_snapshot_entries: u64,
    /// ...or after this many stored bytes of entries since the last one.
    pub sr_snapshot_bytes: u64,
    /// Server-readable mode: how long a snapshot must be durable before the floor moves to it
    /// (offline copies resume from entries within this window).
    pub sr_retention_seconds: u64,
    /// Server-readable mode: days until a pending invitation expires.
    pub sr_invitation_days: u32,
    /// Server-readable mode: how often background maintenance (erasure, floors, garbage) runs.
    pub sr_maintenance_seconds: u64,
    /// Prometheus metrics (`/metrics`) on their own listener; off when unset. Pods use
    /// [`crate::deploy::METRICS_BIND`].
    pub metrics_bind: Option<SocketAddr>,
    /// `scribyra-sync compile-worker`: where its `/healthz` and `/readyz` answer.
    pub compile_worker_bind: SocketAddr,
    /// Development: `serve` also runs a compile worker in its own process (server compile only).
    pub compile_worker_in_process: bool,
    /// How often a worker reports each running job alive...
    pub compile_heartbeat_seconds: u64,
    /// ...and how long without a report before the job is taken back (requeued once, then failed).
    pub compile_heartbeat_timeout_seconds: u64,
    /// How often the audit log's retention task runs (default daily).
    pub audit_purge_seconds: u64,
    /// Development and tests only: keep audit events this many seconds instead of the deployment's
    /// `audit_retention_days`.
    pub audit_retention_seconds: Option<u64>,
}
impl Default for Config {
    fn default() -> Self {
        Self {
            bind: "127.0.0.1:8787".parse().unwrap(),
            data: "service-data".into(),
            database_url: None,
            database_url_file: None,
            database_connections: 10,
            blob_store: BlobBackend::Filesystem,
            s3_endpoint: None,
            s3_region: None,
            s3_bucket: None,
            s3_access_key_id: None,
            s3_secret_access_key_file: None,
            s3_path_style: false,
            s3_ca_file: None,
            origins: vec![],
            principals: vec![],
            object_bytes: 8 * 1024 * 1024,
            namespace_bytes: 256 * 1024 * 1024,
            total_bytes: 1024 * 1024 * 1024,
            namespace_objects: 10000,
            total_objects: 100000,
            tcp_connections: 128,
            http_concurrency: 16,
            requests_per_second: 100,
            source_requests_per_second: 1000,
            rate_sources: 4096,
            trusted_proxies: vec![],
            uploads: 6,
            principal_uploads: 3,
            namespace_uploads: 3,
            namespace_downloads: 2,
            response_bytes: 32 * 1024 * 1024,
            send_seconds: 15,
            connections: 100,
            rooms: 20,
            room_seconds: 120,
            namespace_rooms: 4,
            namespace_connections: 20,
            room_attempts: 1024,
            namespace_room_attempts: 128,
            frame_bytes: 64 * 1024,
            messages_per_second: 60,
            public_url: None,
            service_key_file: None,
            org_bytes: 1024 * 1024 * 1024,
            entry_inline_bytes: 64 * 1024,
            sessions: 10000,
            sso_recheck_tick_seconds: 60,
            sso_starts_per_minute: 60,
            sso_jwks_refetch_seconds: 60,
            deployment: None,
            migrate_on_start: true,
            shutdown_grace_seconds: 25,
            sr_entry_bytes: 16 * 1024 * 1024,
            sr_object_bytes: 32 * 1024 * 1024,
            sr_snapshot_entries: 2000,
            sr_snapshot_bytes: 32 * 1024 * 1024,
            sr_retention_seconds: 7 * 24 * 3600,
            sr_invitation_days: 30,
            sr_maintenance_seconds: 30,
            metrics_bind: None,
            compile_worker_bind: "127.0.0.1:8788".parse().unwrap(),
            compile_worker_in_process: false,
            compile_heartbeat_seconds: 5,
            compile_heartbeat_timeout_seconds: 30,
            audit_purge_seconds: 24 * 3600,
            audit_retention_seconds: None,
        }
    }
}
/// The `deployment` fields that `SCRIBYRA_SERVICE_DEPLOYMENT_<FIELD>` can set one by one; the
/// listed ones are plain text, the others JSON.
const DEPLOYMENT_FIELDS: [(&str, bool); 12] = [
    ("name", true),
    ("encryption", true),
    ("offline", false),
    ("compile", true),
    ("link_sharing", false),
    ("guests", true),
    ("admins", false),
    ("providers", false),
    ("quotas", false),
    ("audit_retention_days", false),
    ("compile_limits", false),
    ("texlive", true),
];
impl Config {
    /// The deployment's master key, if configured.
    pub fn master_key(&self) -> Result<Option<[u8; 32]>, Box<dyn std::error::Error>> {
        let Some(path) = &self.service_key_file else { return Ok(None) };
        let bytes = std::fs::read(path).map_err(|e| format!("service_key_file: {e}"))?;
        let key: [u8; 32] = bytes.as_slice().try_into().map_err(|_| "service_key_file must hold exactly 32 bytes")?;
        Ok(Some(key))
    }
    pub fn load() -> Result<Self, Box<dyn std::error::Error>> {
        let file = match std::env::var("SCRIBYRA_SERVICE_CONFIG") {
            Ok(path) => Some(std::fs::read(path)?),
            Err(_) => None,
        };
        Self::from_sources(file.as_deref(), |name| std::env::var(name).ok())
    }
    /// The configuration from a file's bytes (if any) and environment variables (`env` looks
    /// one up by name): `SCRIBYRA_SERVICE_<FIELD>` replaces a top-level field (plain text for
    /// string and optional fields, JSON otherwise; `SCRIBYRA_SERVICE_DEPLOYMENT` is JSON), then
    /// `SCRIBYRA_SERVICE_DEPLOYMENT_<FIELD>` replaces one field of the deployment object.
    pub fn from_sources(file: Option<&[u8]>, env: impl Fn(&str) -> Option<String>) -> Result<Self, Box<dyn std::error::Error>> {
        let mut value = serde_json::to_value(Self::default())?;
        if let Some(bytes) = file {
            let file: Self = serde_json::from_slice(bytes)?;
            value = serde_json::to_value(file)?;
        }
        for (name, slot) in value.as_object_mut().unwrap() {
            if let Some(raw) = env(&format!("SCRIBYRA_SERVICE_{}", name.to_uppercase())) {
                // Optional fields default to null and are strings or paths, except the
                // deployment object, which is JSON like every other structured field.
                *slot = if name == "deployment" {
                    serde_json::from_str(&raw)?
                } else if slot.is_string() || slot.is_null() {
                    raw.into()
                } else {
                    serde_json::from_str(&raw)?
                };
            }
        }
        // Nested deployment fields, after SCRIBYRA_SERVICE_DEPLOYMENT (which they refine).
        for (name, text) in DEPLOYMENT_FIELDS {
            if let Some(raw) = env(&format!("SCRIBYRA_SERVICE_DEPLOYMENT_{}", name.to_uppercase())) {
                let slot = value.as_object_mut().unwrap().entry("deployment").or_insert(serde_json::Value::Null);
                if slot.is_null() {
                    *slot = serde_json::json!({});
                }
                let field = if text { raw.into() } else { serde_json::from_str(&raw)? };
                slot.as_object_mut().ok_or("deployment must be an object")?.insert(name.into(), field);
            }
        }
        let config: Self = serde_json::from_value(value)?;
        // Validation messages name the field and never contain values, so they can be printed.
        config.validate().map_err(|e| format!("{INVALID}{e}"))?;
        config.check_files().map_err(|e| format!("{INVALID}{e}"))?;
        Ok(config)
    }
    /// The database URL, read from `database_url_file` when configured (trailing newline removed).
    pub fn database_url(&self) -> Result<String, Box<dyn std::error::Error>> {
        match (&self.database_url, &self.database_url_file) {
            (Some(url), None) => Ok(url.clone()),
            (None, Some(path)) => Ok(read_secret(path)?),
            _ => Err("exactly one of database_url and database_url_file is required".into()),
        }
    }
    /// S3 settings with the secret read from its file; `None` for the filesystem backend.
    pub fn s3_settings(
        &self,
    ) -> Result<Option<crate::blobs::S3Settings>, Box<dyn std::error::Error>> {
        if self.blob_store != BlobBackend::S3 {
            return Ok(None);
        }
        let field = |v: &Option<String>| v.clone().ok_or("incomplete s3 settings");
        Ok(Some(crate::blobs::S3Settings {
            endpoint: field(&self.s3_endpoint)?,
            region: field(&self.s3_region)?,
            bucket: field(&self.s3_bucket)?,
            access_key_id: field(&self.s3_access_key_id)?,
            secret_access_key: read_secret(
                self.s3_secret_access_key_file
                    .as_ref()
                    .ok_or("incomplete s3 settings")?,
            )?,
            path_style: self.s3_path_style,
            ca_pem: match &self.s3_ca_file {
                Some(path) => Some(std::fs::read(path).map_err(|_| "s3_ca_file cannot be read")?),
                None => None,
            },
        }))
    }
    /// Startup checks of the files the configuration names: the master key and each provider's
    /// client secret must be readable now (they are read again where used, so a rotated secret
    /// file takes effect without a restart).
    pub fn check_files(&self) -> Result<(), Box<dyn std::error::Error>> {
        self.master_key().map_err(|_| "service_key_file must be a readable file of exactly 32 bytes")?;
        if let Some(d) = &self.deployment {
            for p in &d.providers {
                p.client_secret().map_err(|_| format!("deployment.providers[{}].client_secret_file cannot be read", p.id))?;
            }
        }
        Ok(())
    }
    pub fn validate(&self) -> Result<(), &'static str> {
        use scribyra_core::blob::valid_hash;
        if self.database_url.is_some() == self.database_url_file.is_some() {
            return Err("exactly one of database_url and database_url_file is required");
        }
        if self.org_bytes == 0
            || self.entry_inline_bytes > 1024 * 1024
            || self.sessions == 0
            || self.sessions > 1_000_000
        {
            return Err("invalid organisation limits");
        }
        if !(1..=3600).contains(&self.shutdown_grace_seconds) {
            return Err("shutdown_grace_seconds must be 1-3600");
        }
        let blob_max = scribyra_core::blob::MAX_BLOB_BYTES - 64;
        if !(1024..=blob_max).contains(&self.sr_entry_bytes) || !(1024..=blob_max).contains(&self.sr_object_bytes) {
            return Err("sr_entry_bytes and sr_object_bytes must be 1 KiB to 64 MiB less 64 bytes");
        }
        if self.sr_snapshot_entries == 0 || self.sr_snapshot_bytes == 0 || self.sr_retention_seconds > 366 * 24 * 3600 || !(1..=365).contains(&self.sr_invitation_days) || !(1..=3600).contains(&self.sr_maintenance_seconds) {
            return Err("invalid server-readable limits (sr_snapshot_entries, sr_snapshot_bytes, sr_retention_seconds, sr_invitation_days, sr_maintenance_seconds)");
        }
        if !(1..=300).contains(&self.compile_heartbeat_seconds) || self.compile_heartbeat_timeout_seconds < 2 * self.compile_heartbeat_seconds || self.compile_heartbeat_timeout_seconds > 3600 {
            return Err("compile_heartbeat_seconds must be 1-300 and compile_heartbeat_timeout_seconds at least twice it, at most 3600");
        }
        if !(1..=7 * 24 * 3600).contains(&self.audit_purge_seconds) || self.audit_retention_seconds.is_some_and(|s| s > 3650 * 24 * 3600) {
            return Err("audit_purge_seconds must be 1 second to 7 days and audit_retention_seconds at most 3650 days");
        }
        if !(1..=3600).contains(&self.sso_recheck_tick_seconds) || self.sso_jwks_refetch_seconds > 3600 || !(1..=100_000).contains(&self.sso_starts_per_minute) {
            return Err("invalid single sign-on limits");
        }
        if let Some(url) = &self.public_url {
            let uri: axum::http::Uri = url.parse().map_err(|_| "invalid public_url")?;
            let loopback = uri.host().is_some_and(|h| h == "127.0.0.1" || h == "localhost" || h == "[::1]");
            if !(uri.scheme_str() == Some("https") || uri.scheme_str() == Some("http") && loopback)
                || uri.authority().is_none_or(|a| a.as_str().contains('@'))
                || uri.path_and_query().is_some_and(|p| p.as_str() != "/")
                || url.ends_with('/')
                || url.bytes().any(|b| b.is_ascii_uppercase())
                || url.ends_with(":443") && uri.scheme_str() == Some("https")
                || url.ends_with(":80") && uri.scheme_str() == Some("http")
            {
                return Err("public_url must be a lowercase https origin (http only on loopback), without a path or default port, exactly as browsers write it");
            }
        }
        if self.database_connections == 0 || self.database_connections > 1000 {
            return Err("invalid database_connections");
        }
        if self.blob_store == BlobBackend::S3
            && (self.s3_endpoint.is_none()
                || self.s3_region.as_ref().is_none_or(|r| r.is_empty())
                || self.s3_bucket.as_ref().is_none_or(|b| b.is_empty())
                || self.s3_access_key_id.as_ref().is_none_or(|k| k.is_empty())
                || self.s3_secret_access_key_file.is_none())
        {
            return Err("incomplete s3 settings");
        }
        if self.object_bytes < 16
            || self.object_bytes > 64 * 1024 * 1024
            || self.namespace_bytes < self.object_bytes as u64
            || self.total_bytes < self.namespace_bytes
            || self.namespace_objects == 0
            || self.total_objects < self.namespace_objects
            || self.tcp_connections == 0
            || self.tcp_connections > 10000
            || self.http_concurrency == 0
            || self.http_concurrency > 1024
            || self.uploads == 0
            || self.uploads > 1024
            || self.principal_uploads == 0
            || self.principal_uploads > 1024
            || self.namespace_uploads == 0
            || self.namespace_uploads > 1024
            || self.namespace_downloads == 0
            || self.namespace_downloads > 1024
            || self.response_bytes < self.object_bytes
            || self.response_bytes > 1024 * 1024 * 1024
            || self.send_seconds == 0
            || self.send_seconds > 120
            || self.namespace_rooms == 0
            || self.namespace_rooms > 10000
            || self.namespace_connections == 0
            || self.namespace_connections > 10000
            || self.room_attempts == 0
            || self.room_attempts > 100000
            || self.namespace_room_attempts == 0
            || self.namespace_room_attempts > 10000
            || self.connections == 0
            || self.connections > 10000
            || self.rooms == 0
            || self.rooms > 10000
            || self.requests_per_second == 0
            || self.source_requests_per_second == 0
            || self.rate_sources == 0
            || self.rate_sources > 100000
            || self.trusted_proxies.len() > 128
            || self.messages_per_second == 0
            || self.room_seconds == 0
            || self.room_seconds > 600
            || self.frame_bytes < 256
            || self.frame_bytes > 64 * 1024
            || self.principals.len() > 10000
        {
            return Err("invalid limits");
        }
        for (i, p) in self.principals.iter().enumerate() {
            if !valid_hash(&p.token_hash)
                || !valid_hash(&p.namespace)
                || self.principals[..i]
                    .iter()
                    .any(|other| other.token_hash == p.token_hash)
            {
                return Err("invalid principal");
            }
        }
        for origin in &self.origins {
            let uri: axum::http::Uri = origin.parse().map_err(|_| "invalid origin")?;
            if !matches!(uri.scheme_str(), Some("http" | "https"))
                || uri.authority().is_none()
                || uri.authority().unwrap().as_str().contains('@')
                || uri.path_and_query().is_some_and(|p| p.as_str() != "/")
                || origin.ends_with('/')
            {
                return Err("invalid origin");
            }
        }
        if let Some(d) = &self.deployment {
            if self.public_url.is_none() {
                return Err("deployment needs public_url");
            }
            d.validate()?;
            if d.encryption == Encryption::Server && self.service_key_file.is_none() {
                return Err("deployment.encryption \"server\" needs service_key_file");
            }
        }
        Ok(())
    }
}

/// `deployment.encryption`: fixed when a deployment first starts.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Encryption {
    /// Server-readable: the server seals projects under keys the master key wraps.
    #[default]
    Server,
    /// End to end: clients encrypt; the server stores ciphertext only.
    E2ee,
}
impl Encryption {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Server => "server",
            Self::E2ee => "e2ee",
        }
    }
}
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Compile {
    #[default]
    Browser,
    Server,
    Both,
}
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Guests {
    /// Provider guest accounts are refused at sign-in.
    #[default]
    Off,
    /// Guest accounts may open what is shared with them.
    Shared,
}
/// The organisation's policy (design section 2). One deployment serves one organisation.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Deployment {
    pub name: String,
    #[serde(default)]
    pub encryption: Encryption,
    #[serde(default = "yes")]
    pub offline: bool,
    #[serde(default)]
    pub compile: Compile,
    #[serde(default)]
    pub link_sharing: bool,
    #[serde(default)]
    pub guests: Guests,
    /// Verified emails, or `issuer#subject`, that are administrators whatever groups say.
    #[serde(default)]
    pub admins: Vec<String>,
    pub providers: Vec<Provider>,
    #[serde(default)]
    pub quotas: Quotas,
    #[serde(default = "audit_days")]
    pub audit_retention_days: u32,
    #[serde(default)]
    pub compile_limits: CompileLimits,
    /// A TeX Live tree (server compile).
    #[serde(default)]
    pub texlive: Option<PathBuf>,
}
fn yes() -> bool {
    true
}
fn audit_days() -> u32 {
    400
}
impl Config {
    /// How long audit events are kept: `audit_retention_seconds` when set (tests), else the
    /// deployment's `audit_retention_days`.
    pub fn audit_retention(&self) -> u64 {
        self.audit_retention_seconds.unwrap_or_else(|| self.deployment.as_ref().map_or(400, |d| d.audit_retention_days) as u64 * 24 * 3600)
    }
}
/// How a provider marks guest accounts: a claim and the value that means "guest".
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct GuestRule {
    pub claim: String,
    pub equals: String,
}
/// One OpenID Connect provider. Its redirect URI is `<public_url>/v1/sso/callback/<id>`.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Provider {
    pub id: String,
    pub label: String,
    pub issuer: String,
    pub client_id: String,
    pub client_secret_file: PathBuf,
    #[serde(default)]
    pub email_domains: Vec<String>,
    #[serde(default)]
    pub groups_claim: Option<String>,
    #[serde(default)]
    pub admin_groups: Vec<String>,
    #[serde(default)]
    pub member_groups: Vec<String>,
    #[serde(default)]
    pub guest: Option<GuestRule>,
    #[serde(default)]
    pub offline_access: bool,
    #[serde(default = "session_hours")]
    pub session_hours: u32,
    #[serde(default = "recheck_minutes")]
    pub recheck_minutes: u32,
    /// Extra scopes beyond `openid email profile` (and `offline_access` when set).
    #[serde(default)]
    pub scopes: Vec<String>,
}
fn session_hours() -> u32 {
    12
}
fn recheck_minutes() -> u32 {
    10
}
impl Provider {
    /// The confidential client's secret, read from its file (one line).
    pub fn client_secret(&self) -> Result<String, Box<dyn std::error::Error>> {
        let secret = read_secret(&self.client_secret_file)?;
        if secret.len() > 1024 {
            return Err("invalid secret file".into());
        }
        Ok(secret)
    }
    /// The scopes a sign-in asks for.
    pub fn scope(&self) -> String {
        let mut scope = String::from("openid email profile");
        if self.offline_access {
            scope.push_str(" offline_access");
        }
        for extra in &self.scopes {
            if !scope.split(' ').any(|s| s == extra) {
                scope.push(' ');
                scope.push_str(extra);
            }
        }
        scope
    }
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(default, deny_unknown_fields)]
pub struct Quotas {
    pub deployment_bytes: u64,
    pub project_bytes: u64,
    pub member_bytes: u64,
}
impl Default for Quotas {
    fn default() -> Self {
        Self { deployment_bytes: 100 << 30, project_bytes: 1 << 30, member_bytes: 10 << 30 }
    }
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(default, deny_unknown_fields)]
pub struct CompileLimits {
    pub cpu_seconds: u32,
    pub wall_seconds: u32,
    pub memory_mib: u32,
    pub scratch_mib: u32,
    pub output_mib: u32,
    pub passes: u32,
    pub concurrency: u32,
    pub queue: u32,
    pub per_member_per_hour: u32,
    /// Requests per project and minute, from all its members together.
    pub per_project_per_minute: u32,
    /// Queued and running jobs at once: requested by one member, and on one owner's projects.
    pub active_per_member: u32,
    pub active_per_owner: u32,
    /// Days a finished job's row (requester, times, CPU time, digest) is kept, unless it holds
    /// the newest PDF or log or is its project's latest job.
    pub retention_days: u32,
}
impl Default for CompileLimits {
    fn default() -> Self {
        Self { cpu_seconds: 60, wall_seconds: 120, memory_mib: 2048, scratch_mib: 512, output_mib: 64, passes: 4, concurrency: 2, queue: 32, per_member_per_hour: 120, per_project_per_minute: 30, active_per_member: 2, active_per_owner: 2, retention_days: 90 }
    }
}
fn short_text(text: &str, max: usize) -> bool {
    !text.trim().is_empty() && text.len() <= max && !text.chars().any(char::is_control)
}
fn claim_name(text: &str) -> bool {
    !text.is_empty() && text.len() <= 128 && text.bytes().all(|b| b.is_ascii_alphanumeric() || b"_-.:/".contains(&b))
}
fn domain_name(text: &str) -> bool {
    text.len() <= 253 && text.contains('.') && !text.starts_with(['.', '-']) && !text.ends_with(['.', '-']) && text.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'.' || b == b'-')
}
/// An `admins` entry: a lowercase email, `provider:email`, or `issuer#subject`.
fn admin_entry(text: &str, providers: &[Provider]) -> bool {
    if let Some((issuer, subject)) = text.split_once('#') {
        return crate::sso::secure_url(issuer) && short_text(subject, 255);
    }
    // A plain email must be vouched for by a provider's email_domains; otherwise any provider
    // could make an administrator by claiming it, so it has to name its provider.
    let (text, vouched) = match text.split_once(':') {
        Some((id, email)) => (email, providers.iter().any(|p| p.id == id)),
        None => (text, text.rsplit_once('@').is_some_and(|(_, domain)| providers.iter().any(|p| p.email_domains.iter().any(|d| d == domain)))),
    };
    vouched && text.len() <= 254 && text.split_once('@').is_some_and(|(local, domain)| !local.is_empty() && !domain.contains('@') && domain_name(domain) && !local.chars().any(|c| c.is_whitespace() || c.is_control()) && text == text.to_lowercase())
}
impl Deployment {
    /// Field and cross-field rules; the error names the field.
    pub fn validate(&self) -> Result<(), &'static str> {
        if !short_text(&self.name, 64) {
            return Err("deployment.name must be 1-64 characters");
        }
        if self.providers.is_empty() || self.providers.len() > 16 {
            return Err("deployment.providers must list 1-16 providers");
        }
        for (i, p) in self.providers.iter().enumerate() {
            let id_ok = !p.id.is_empty() && p.id.len() <= 32 && p.id.as_bytes()[0].is_ascii_lowercase() && p.id.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-');
            if !id_ok || self.providers[..i].iter().any(|o| o.id == p.id) {
                return Err("deployment.providers[].id must be a unique short lowercase name (a-z, 0-9, -)");
            }
            if !short_text(&p.label, 64) {
                return Err("deployment.providers[].label must be 1-64 characters");
            }
            if p.issuer.len() > 512 || !crate::sso::secure_url(&p.issuer) || url::Url::parse(&p.issuer).is_ok_and(|u| u.query().is_some()) {
                return Err("deployment.providers[].issuer must be an https URL (http only on loopback) without query or fragment");
            }
            if p.client_id.is_empty() || p.client_id.len() > 255 || !p.client_id.bytes().all(|b| b.is_ascii_graphic()) {
                return Err("deployment.providers[].client_id must be 1-255 printable characters");
            }
            if p.email_domains.len() > 64 || !p.email_domains.iter().all(|d| domain_name(d)) {
                return Err("deployment.providers[].email_domains must be lowercase domain names such as example.org");
            }
            if p.groups_claim.as_deref().is_some_and(|c| !claim_name(c)) {
                return Err("deployment.providers[].groups_claim must be a claim name");
            }
            let groups = p.admin_groups.iter().chain(&p.member_groups);
            if p.admin_groups.len() + p.member_groups.len() > 256 || !groups.clone().all(|g| short_text(g, 256)) {
                return Err("deployment.providers[].admin_groups and member_groups must be group names");
            }
            if (!p.admin_groups.is_empty() || !p.member_groups.is_empty()) && p.groups_claim.is_none() {
                return Err("deployment.providers[].admin_groups and member_groups need groups_claim");
            }
            if p.guest.as_ref().is_some_and(|g| !claim_name(&g.claim) || !short_text(&g.equals, 256)) {
                return Err("deployment.providers[].guest needs a claim name and a value");
            }
            if !(1..=720).contains(&p.session_hours) {
                return Err("deployment.providers[].session_hours must be 1-720");
            }
            if !(1..=1440).contains(&p.recheck_minutes) {
                return Err("deployment.providers[].recheck_minutes must be 1-1440");
            }
            if p.scopes.len() > 16 || !p.scopes.iter().all(|s| !s.is_empty() && s.len() <= 128 && s.bytes().all(|b| b.is_ascii_graphic() && b != b'"' && b != b'\\')) {
                return Err("deployment.providers[].scopes must be at most 16 scope names");
            }
        }
        if self.admins.len() > 256 || !self.admins.iter().all(|a| admin_entry(a, &self.providers)) {
            return Err("deployment.admins must list provider:email (a configured provider), an email in a provider's email_domains, or issuer#subject, all lowercase");
        }
        let q = &self.quotas;
        if q.deployment_bytes == 0 || q.project_bytes == 0 || q.member_bytes == 0 || q.project_bytes > q.deployment_bytes || q.member_bytes > q.deployment_bytes {
            return Err("deployment.quotas must be positive, and project and member quotas at most deployment_bytes");
        }
        if !(30..=3650).contains(&self.audit_retention_days) {
            return Err("deployment.audit_retention_days must be 30-3650");
        }
        let c = &self.compile_limits;
        let bounded = |v: u32, max: u32| (1..=max).contains(&v);
        if !(bounded(c.cpu_seconds, 3600) && bounded(c.wall_seconds, 7200) && bounded(c.memory_mib, 65536) && bounded(c.scratch_mib, 65536) && bounded(c.output_mib, 4096) && bounded(c.passes, 16) && bounded(c.concurrency, 256) && bounded(c.queue, 100_000) && bounded(c.per_member_per_hour, 100_000) && bounded(c.per_project_per_minute, 100_000) && bounded(c.active_per_member, 1000) && bounded(c.active_per_owner, 1000) && bounded(c.retention_days, 3650)) {
            return Err("deployment.compile_limits are out of range");
        }
        if self.compile != Compile::Browser {
            if self.encryption != Encryption::Server {
                return Err("deployment.compile \"server\" or \"both\" needs encryption \"server\"");
            }
            if self.texlive.is_none() {
                return Err("deployment.compile \"server\" or \"both\" needs texlive");
            }
        }
        Ok(())
    }
    pub fn provider(&self, id: &str) -> Option<&Provider> {
        self.providers.iter().find(|p| p.id == id)
    }
}

fn read_secret(path: &std::path::Path) -> Result<String, Box<dyn std::error::Error>> {
    let text = std::fs::read_to_string(path)?;
    let text = text.trim_end_matches(['\n', '\r']);
    if text.is_empty() || text.contains(['\n', '\r']) {
        return Err("invalid secret file".into());
    }
    Ok(text.to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn config(deployment: serde_json::Value) -> Result<Config, String> {
        let config: Config = serde_json::from_value(json!({"database_url": "postgres://x/y", "public_url": "https://scribyra.acme.org", "service_key_file": "master.key", "deployment": deployment})).map_err(|e| e.to_string())?;
        config.validate().map_err(str::to_string)?;
        Ok(config)
    }
    fn provider() -> serde_json::Value {
        json!({"id": "acme", "label": "Acme account", "issuer": "https://login.acme.org/realms/lab", "client_id": "scribyra", "client_secret_file": "acme-secret"})
    }
    fn deployment(extra: serde_json::Value) -> serde_json::Value {
        let mut d = json!({"name": "Acme Lab", "providers": [provider()]});
        for (k, v) in extra.as_object().unwrap() {
            d[k] = v.clone();
        }
        d
    }

    #[test]
    fn defaults_follow_the_design() {
        let c = config(deployment(json!({}))).unwrap();
        let d = c.deployment.unwrap();
        assert_eq!((d.encryption, d.offline, d.compile, d.link_sharing, d.guests), (Encryption::Server, true, Compile::Browser, false, Guests::Off));
        assert_eq!((d.audit_retention_days, d.quotas.project_bytes, d.compile_limits.passes), (400, 1 << 30, 4));
        let p = &d.providers[0];
        assert_eq!((p.session_hours, p.recheck_minutes, p.offline_access, p.scope()), (12, 10, false, "openid email profile".to_string()));
        assert!(Config::default().deployment.is_none());
    }

    #[test]
    fn field_and_cross_field_rules() {
        let refused = |extra: serde_json::Value| config(deployment(extra)).err().expect("refused");
        assert!(refused(json!({"name": " "})).contains("deployment.name"));
        assert!(refused(json!({"providers": []})).contains("1-16"));
        assert!(refused(json!({"providers": (0..17).map(|i| { let mut p = provider(); p["id"] = json!(format!("p{i}")); p }).collect::<Vec<_>>()})).contains("1-16"));
        assert!(refused(json!({"providers": [provider(), provider()]})).contains("unique"));
        assert!(refused(json!({"audit_retention_days": 29})).contains("audit_retention_days"));
        assert!(refused(json!({"audit_retention_days": 3651})).contains("audit_retention_days"));
        config(deployment(json!({"audit_retention_days": 30}))).unwrap();
        assert!(refused(json!({"admins": ["not an email"]})).contains("deployment.admins"));
        config(deployment(json!({"admins": ["acme:it-admin@acme.org", "https://login.acme.org/realms/lab#f81d4fae"]}))).unwrap();
        // A plain email needs a provider whose email_domains vouch for it (review M1).
        assert!(refused(json!({"admins": ["it-admin@acme.org"]})).contains("deployment.admins"));
        assert!(refused(json!({"admins": ["other:it-admin@acme.org"]})).contains("deployment.admins"));
        let mut vouching = provider();
        vouching["email_domains"] = json!(["acme.org"]);
        config(deployment(json!({"admins": ["it-admin@acme.org"], "providers": [vouching]}))).unwrap();
        assert!(refused(json!({"admins": ["ftp://login.acme.org#x"]})).contains("deployment.admins"));
        // Server compile needs server-readable encryption and a TeX Live tree.
        assert!(refused(json!({"compile": "server"})).contains("needs texlive"));
        assert!(refused(json!({"compile": "both", "encryption": "e2ee", "texlive": "/tex"})).contains("needs encryption"));
        config(deployment(json!({"compile": "both", "texlive": "/tex"}))).unwrap();
        // Server-readable deployments need the master key; end-to-end ones do not.
        let without_key = |d: serde_json::Value| {
            let c: Config = serde_json::from_value(json!({"database_url": "postgres://x/y", "public_url": "https://scribyra.acme.org", "deployment": d})).unwrap();
            c.validate()
        };
        assert_eq!(without_key(deployment(json!({}))).unwrap_err(), "deployment.encryption \"server\" needs service_key_file");
        without_key(deployment(json!({"encryption": "e2ee"}))).unwrap();
        // A deployment needs public_url.
        let c: Config = serde_json::from_value(json!({"database_url": "postgres://x/y", "deployment": deployment(json!({"encryption": "e2ee"}))})).unwrap();
        assert_eq!(c.validate().unwrap_err(), "deployment needs public_url");
        // Quotas and compile limits.
        assert!(refused(json!({"quotas": {"deployment_bytes": 100, "project_bytes": 200, "member_bytes": 50}})).contains("quotas"));
        assert!(refused(json!({"compile_limits": {"passes": 0}})).contains("compile_limits"));
        // Unknown fields and values are refused while parsing.
        assert!(refused(json!({"mode": "managed"})).contains("unknown field"));
        assert!(refused(json!({"encryption": "managed"})).contains("unknown variant"));
        assert!(refused(json!({"guests": "anyone"})).contains("unknown variant"));
    }

    #[test]
    fn provider_rules() {
        let refused = |field: &str, value: serde_json::Value| {
            let mut p = provider();
            p[field] = value;
            config(deployment(json!({"providers": [p]}))).err().expect("refused")
        };
        assert!(refused("id", json!("Acme")).contains(".id"));
        assert!(refused("id", json!("1acme")).contains(".id"));
        assert!(refused("label", json!("")).contains(".label"));
        assert!(refused("issuer", json!("http://login.acme.org")).contains(".issuer"));
        assert!(refused("issuer", json!("https://login.acme.org/?realm=x")).contains(".issuer"));
        assert!(refused("client_id", json!("has space")).contains(".client_id"));
        assert!(refused("email_domains", json!(["Acme.org"])).contains(".email_domains"));
        assert!(refused("email_domains", json!(["acme"])).contains(".email_domains"));
        assert!(refused("groups_claim", json!("bad claim")).contains(".groups_claim"));
        assert!(refused("member_groups", json!(["staff"])).contains("need groups_claim"));
        assert!(refused("guest", json!({"claim": "acct", "equals": ""})).contains(".guest"));
        assert!(refused("session_hours", json!(721)).contains(".session_hours"));
        assert!(refused("recheck_minutes", json!(0)).contains(".recheck_minutes"));
        assert!(refused("scopes", json!(["a b"])).contains(".scopes"));
        assert!(refused("required", json!(true)).contains("unknown field"));
        let mut p = provider();
        p["groups_claim"] = json!("roles");
        p["admin_groups"] = json!(["scribyra-admins"]);
        p["member_groups"] = json!(["scribyra"]);
        p["guest"] = json!({"claim": "acct", "equals": "1"});
        p["email_domains"] = json!(["acme.org", "lab.acme.org"]);
        p["offline_access"] = json!(true);
        p["scopes"] = json!(["groups"]);
        let c = config(deployment(json!({"providers": [p], "guests": "shared"}))).unwrap();
        assert_eq!(c.deployment.unwrap().providers[0].scope(), "openid email profile offline_access groups");
    }

    #[test]
    fn every_field_and_each_deployment_field_can_come_from_the_environment() {
        let dir = std::env::temp_dir().join(format!("scribyra-config-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let (secret, key) = (dir.join("secret"), dir.join("master.key"));
        std::fs::write(&secret, "s3cret\n").unwrap();
        std::fs::write(&key, [7u8; 32]).unwrap();
        let file = json!({"database_url_file": dir.join("db"), "public_url": "https://scribyra.acme.org", "deployment": deployment(json!({"encryption": "e2ee"}))});
        let mut provider = provider();
        provider["client_secret_file"] = json!(secret);
        let env: std::collections::HashMap<String, String> = [
            ("SCRIBYRA_SERVICE_MIGRATE_ON_START", "false".to_string()),
            ("SCRIBYRA_SERVICE_SHUTDOWN_GRACE_SECONDS", "7".to_string()),
            ("SCRIBYRA_SERVICE_SERVICE_KEY_FILE", key.display().to_string()),
            ("SCRIBYRA_SERVICE_SR_RETENTION_SECONDS", "0".to_string()),
            ("SCRIBYRA_SERVICE_DEPLOYMENT_NAME", "Env Lab".to_string()),
            ("SCRIBYRA_SERVICE_DEPLOYMENT_ENCRYPTION", "server".to_string()),
            ("SCRIBYRA_SERVICE_DEPLOYMENT_OFFLINE", "false".to_string()),
            ("SCRIBYRA_SERVICE_DEPLOYMENT_PROVIDERS", json!([provider]).to_string()),
            ("SCRIBYRA_SERVICE_DEPLOYMENT_QUOTAS", json!({"project_bytes": 1000}).to_string()),
        ]
        .into_iter()
        .map(|(k, v)| (k.to_string(), v))
        .collect();
        let c = Config::from_sources(Some(file.to_string().as_bytes()), |name| env.get(name).cloned()).unwrap();
        assert_eq!((c.migrate_on_start, c.shutdown_grace_seconds, c.sr_retention_seconds), (false, 7, 0));
        let d = c.deployment.unwrap();
        assert_eq!((d.name.as_str(), d.encryption, d.offline, d.quotas.project_bytes, d.quotas.deployment_bytes), ("Env Lab", Encryption::Server, false, 1000, 100 << 30));
        // Nested fields alone make a deployment; values still go through validation.
        let only: std::collections::HashMap<&str, String> = [("SCRIBYRA_SERVICE_DATABASE_URL", "postgres://x/y".into()), ("SCRIBYRA_SERVICE_PUBLIC_URL", "https://a.example.org".into()), ("SCRIBYRA_SERVICE_DEPLOYMENT_NAME", "Lab".into()), ("SCRIBYRA_SERVICE_DEPLOYMENT_ENCRYPTION", "e2ee".into()), ("SCRIBYRA_SERVICE_DEPLOYMENT_PROVIDERS", json!([provider]).to_string())].into();
        assert_eq!(Config::from_sources(None, |n| only.get(n).cloned()).unwrap().deployment.unwrap().name, "Lab");
        let bad: std::collections::HashMap<&str, String> = [("SCRIBYRA_SERVICE_DATABASE_URL", "postgres://x/y".into()), ("SCRIBYRA_SERVICE_SHUTDOWN_GRACE_SECONDS", "0".into())].into();
        assert!(Config::from_sources(None, |n| bad.get(n).cloned()).err().unwrap().to_string().contains("shutdown_grace_seconds"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_deployment_can_come_from_the_environment() {
        // SCRIBYRA_SERVICE_DEPLOYMENT is JSON like every structured field (see Config::load).
        let mut value = serde_json::to_value(Config::default()).unwrap();
        value["deployment"] = serde_json::from_str(&deployment(json!({"encryption": "e2ee"})).to_string()).unwrap();
        value["database_url"] = json!("postgres://x/y");
        value["public_url"] = json!("https://scribyra.acme.org");
        let c: Config = serde_json::from_value(value).unwrap();
        c.validate().unwrap();
        assert_eq!(c.deployment.unwrap().encryption, Encryption::E2ee);
    }
}
