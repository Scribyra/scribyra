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
#[derive(Clone, Deserialize, Serialize)]
#[serde(default, deny_unknown_fields)]
pub struct Config {
    pub bind: SocketAddr,
    pub data: PathBuf,
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
}
impl Default for Config {
    fn default() -> Self {
        Self {
            bind: "127.0.0.1:8787".parse().unwrap(),
            data: "service-data".into(),
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
        }
    }
}
impl Config {
    pub fn load() -> Result<Self, Box<dyn std::error::Error>> {
        let mut value = serde_json::to_value(Self::default())?;
        if let Ok(path) = std::env::var("SCRIBYRA_SERVICE_CONFIG") {
            let file: Self = serde_json::from_slice(&std::fs::read(path)?)?;
            value = serde_json::to_value(file)?;
        }
        for (name, slot) in value.as_object_mut().unwrap() {
            if let Ok(raw) = std::env::var(format!("SCRIBYRA_SERVICE_{}", name.to_uppercase())) {
                *slot = if slot.is_string() {
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
    fn validate(&self) -> Result<(), &'static str> {
        use scribyra_core::blob::valid_hash;
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
