//! Bootstrap of the single-node Garage store through its admin API (v1, Garage 1.x): assign
//! the node a layout role, create the service's access key and the bucket, and allow the key on
//! the bucket. Every step checks first, so a repeated bootstrap changes nothing.

use serde_json::{Value, json};
use std::time::Duration;

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("garage admin API unreachable: {0}")]
    Unreachable(String),
    #[error("garage admin API answered {0} to {1}")]
    Status(u16, &'static str),
    #[error("garage admin API returned an unexpected body for {0}")]
    Body(&'static str),
}

pub struct Credentials {
    pub access_key_id: String,
    pub secret_access_key: String,
}

pub struct Admin {
    agent: ureq::Agent,
    base: String,
    token: String,
}

const KEY_NAME: &str = "scribyra-sync";

impl Admin {
    /// `base` like `https://acme-garage.acme.svc:3944`; only `ca_pem` is trusted for it.
    pub fn new(base: &str, token: &str, ca_pem: &[u8]) -> Result<Self, Error> {
        let certs = ureq::tls::parse_pem(ca_pem)
            .filter_map(|i| match i {
                Ok(ureq::tls::PemItem::Certificate(c)) => Some(c),
                _ => None,
            })
            .collect::<Vec<_>>();
        if certs.is_empty() {
            return Err(Error::Body("CA"));
        }
        let tls = ureq::tls::TlsConfig::builder().root_certs(ureq::tls::RootCerts::Specific(std::sync::Arc::new(certs))).build();
        let agent = ureq::Agent::config_builder().timeout_global(Some(Duration::from_secs(10))).http_status_as_error(false).max_redirects(0).tls_config(tls).build().into();
        Ok(Self { agent, base: base.trim_end_matches('/').into(), token: token.into() })
    }
    fn call(&self, method: &str, path: &str, body: Option<Value>, _what: &'static str) -> Result<(u16, Value), Error> {
        let url = format!("{}{path}", self.base);
        let auth = format!("Bearer {}", self.token);
        let response = match (method, body) {
            ("GET", _) => self.agent.get(&url).header("Authorization", &auth).call(),
            (_, Some(b)) => self.agent.post(&url).header("Authorization", &auth).send_json(b),
            (_, None) => self.agent.post(&url).header("Authorization", &auth).send_empty(),
        };
        let mut response = response.map_err(|e| Error::Unreachable(e.to_string()))?;
        let status = response.status().as_u16();
        let text = response.body_mut().read_to_string().unwrap_or_default();
        let value = serde_json::from_str(&text).unwrap_or(Value::Null);
        Ok((status, value))
    }
    fn ok(&self, method: &str, path: &str, body: Option<Value>, what: &'static str) -> Result<Value, Error> {
        match self.call(method, path, body, what)? {
            (200..=299, v) => Ok(v),
            (s, _) => Err(Error::Status(s, what)),
        }
    }

    /// Run every bootstrap step; returns the service's credentials. `known` are credentials
    /// already stored by the operator (their secret is not readable again from Garage without
    /// asking for it).
    pub fn bootstrap(&self, bucket: &str, capacity_bytes: u64, known: Option<Credentials>) -> Result<Credentials, Error> {
        self.layout(capacity_bytes)?;
        let creds = match known {
            Some(c) => c,
            None => self.key()?,
        };
        let bucket_id = self.bucket(bucket)?;
        self.ok(
            "POST",
            "/v1/bucket/allow",
            Some(json!({"bucketId": bucket_id, "accessKeyId": creds.access_key_id, "permissions": {"read": true, "write": true, "owner": false}})),
            "bucket allow",
        )?;
        Ok(creds)
    }
    fn layout(&self, capacity: u64) -> Result<(), Error> {
        let status = self.ok("GET", "/v1/status", None, "status")?;
        let node = status["node"].as_str().ok_or(Error::Body("status"))?.to_owned();
        let has_role = status["nodes"].as_array().is_some_and(|nodes| nodes.iter().any(|n| n["id"] == node.as_str() && !n["role"].is_null()));
        if has_role {
            return Ok(());
        }
        self.ok("POST", "/v1/layout", Some(json!([{"id": node, "zone": "dc1", "capacity": capacity, "tags": ["scribyra"]}])), "layout")?;
        let layout = self.ok("GET", "/v1/layout", None, "layout")?;
        let version = layout["version"].as_u64().ok_or(Error::Body("layout"))?;
        self.ok("POST", "/v1/layout/apply", Some(json!({"version": version + 1})), "layout apply")?;
        Ok(())
    }
    fn key(&self) -> Result<Credentials, Error> {
        let keys = self.ok("GET", "/v1/key", None, "key list")?;
        let existing = keys.as_array().and_then(|ks| ks.iter().find(|k| k["name"] == KEY_NAME)).and_then(|k| k["id"].as_str()).map(str::to_owned);
        let info = match existing {
            Some(id) => self.ok("GET", &format!("/v1/key?id={id}&showSecretKey=true"), None, "key info")?,
            None => self.ok("POST", "/v1/key", Some(json!({"name": KEY_NAME})), "key create")?,
        };
        Ok(Credentials {
            access_key_id: info["accessKeyId"].as_str().ok_or(Error::Body("key"))?.into(),
            secret_access_key: info["secretAccessKey"].as_str().ok_or(Error::Body("key"))?.into(),
        })
    }
    fn bucket(&self, alias: &str) -> Result<String, Error> {
        let (status, info) = self.call("GET", &format!("/v1/bucket?globalAlias={alias}"), None, "bucket info")?;
        let info = match status {
            200 => info,
            404 => self.ok("POST", "/v1/bucket", Some(json!({"globalAlias": alias})), "bucket create")?,
            s => return Err(Error::Status(s, "bucket info")),
        };
        info["id"].as_str().map(str::to_owned).ok_or(Error::Body("bucket"))
    }
}
