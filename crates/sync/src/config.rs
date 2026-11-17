use serde::{Deserialize, Serialize};
use std::{
    net::{IpAddr, SocketAddr},
    path::PathBuf,
};

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
    /// A file holding 32 random bytes that seal each organisation's service key. Without it the
    /// service offers only end-to-end encrypted organisations (no organisation-managed mode).
    pub service_key_file: Option<std::path::PathBuf>,
    /// Encrypted bytes one organisation may store.
    pub org_bytes: u64,
    /// Log entries up to this size live in the database; larger ones in the blob store.
    pub entry_inline_bytes: usize,
    /// Signed-in organisation sessions held in memory.
    pub sessions: usize,
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
        }
    }
}
impl Config {
    /// The operator's master key that seals organisation service keys, if configured.
    pub fn master_key(&self) -> Result<Option<[u8; 32]>, Box<dyn std::error::Error>> {
        let Some(path) = &self.service_key_file else { return Ok(None) };
        let bytes = std::fs::read(path).map_err(|e| format!("service_key_file: {e}"))?;
        let key: [u8; 32] = bytes.as_slice().try_into().map_err(|_| "service_key_file must hold exactly 32 bytes")?;
        Ok(Some(key))
    }
    pub fn load() -> Result<Self, Box<dyn std::error::Error>> {
        let mut value = serde_json::to_value(Self::default())?;
        if let Ok(path) = std::env::var("SCRIBYRA_SERVICE_CONFIG") {
            let file: Self = serde_json::from_slice(&std::fs::read(path)?)?;
            value = serde_json::to_value(file)?;
        }
        for (name, slot) in value.as_object_mut().unwrap() {
            if let Ok(raw) = std::env::var(format!("SCRIBYRA_SERVICE_{}", name.to_uppercase())) {
                // Optional fields default to null and are all strings or paths.
                *slot = if slot.is_string() || slot.is_null() {
                    raw.into()
                } else {
                    serde_json::from_str(&raw)?
                };
            }
        }
        let config: Self = serde_json::from_value(value)?;
        config.validate()?;
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
        }))
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
        Ok(())
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
