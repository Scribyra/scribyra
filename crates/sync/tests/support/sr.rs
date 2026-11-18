//! Server-readable deployment helpers: a service whose deployment stores projects the server can
//! read (with its own test provider and master key, on filesystem or Garage blobs), an HTTP
//! client for the `/v1/sr/` routes, and Yjs updates shaped like the app's projects.
#![allow(dead_code)]
use super::{Service, free_port, garage, random_bytes, sso::*, temp_dir};
use serde_json::{Value, json};
use std::{collections::HashMap, path::PathBuf, sync::Arc, time::Duration};
use yrs::{Any, Doc, Map, Text, Transact};

/// Which blob store a test runs against.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Blobs {
    Fs,
    S3,
}
pub const BOTH: [Blobs; 2] = [Blobs::Fs, Blobs::S3];
impl Blobs {
    pub fn config(self) -> Value {
        match self {
            Blobs::Fs => json!({}),
            Blobs::S3 => garage().config(),
        }
    }
}

/// A running server-readable deployment ("Test Lab", provider `test`, alice an administrator).
pub struct Sr {
    pub env: Env,
    pub key_file: PathBuf,
    pub blobs: Blobs,
    dir: PathBuf,
}
impl Sr {
    /// Small snapshot thresholds and no retention window, so compaction is quick to observe.
    pub fn start(blobs: Blobs, users: Value, service_extra: Value, deployment_extra: Value) -> Sr {
        let dir = temp_dir("scribyra-sr-");
        let key_file = dir.join("master.key");
        std::fs::write(&key_file, random_bytes(32)).unwrap();
        let mut service = json!({"service_key_file": key_file, "sr_snapshot_entries": 1000, "sr_retention_seconds": 0, "sr_maintenance_seconds": 1});
        for (k, v) in blobs.config().as_object().unwrap().iter().chain(service_extra.as_object().unwrap()) {
            service[k] = v.clone();
        }
        let mut deployment = json!({"encryption": "server"});
        for (k, v) in deployment_extra.as_object().unwrap() {
            deployment[k] = v.clone();
        }
        let env = Env::start("RS256", users, service, deployment);
        Sr { env, key_file, blobs, dir }
    }
    pub fn url(&self) -> String {
        self.env.service.url.clone()
    }
    pub fn db(&self) -> String {
        self.env.service.database_url().to_owned()
    }
    /// Signs `user` in; returns the session token.
    pub fn login(&self, user: &str) -> String {
        self.env.client().login(user)["token"].as_str().unwrap().to_owned()
    }
    pub fn api(&self, token: &str) -> Api {
        Api { base: self.url(), token: token.to_owned() }
    }
    /// A `scribyra-sync compile-worker` for this deployment (S3 blobs: a filesystem blob directory
    /// belongs to one process), its probes on a free port; `extra` merges into its configuration.
    /// Its `url` is the probe listener.
    pub fn worker(&self, extra: Value) -> Service {
        let mut config = self.env.service.config.clone();
        config["compile_worker_bind"] = json!(format!("127.0.0.1:{}", free_port()));
        for (k, v) in extra.as_object().unwrap() {
            config[k] = v.clone();
        }
        let mut worker = Service::configure(config);
        worker.start_with(&["compile-worker"]).unwrap();
        worker
    }
    /// A second instance of the same deployment (same database, configuration and blobs) on
    /// another port.
    pub fn replica(&self) -> Service {
        let mut config = self.env.service.config.clone();
        config["bind"] = json!(format!("127.0.0.1:{}", free_port()));
        let mut replica = Service::configure(config);
        replica.start().unwrap();
        replica
    }
}
impl Drop for Sr {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

pub struct Reply {
    pub status: u16,
    pub headers: HashMap<String, String>,
    pub body: Vec<u8>,
}
impl Reply {
    pub fn json(&self) -> Value {
        serde_json::from_slice(&self.body).unwrap_or(Value::Null)
    }
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers.get(name).map(String::as_str)
    }
    /// The frames of a log page: (seq, update).
    pub fn frames(&self) -> Vec<(i64, Vec<u8>)> {
        let mut out = Vec::new();
        let mut rest = self.body.as_slice();
        while !rest.is_empty() {
            let seq = u64::from_be_bytes(rest[..8].try_into().unwrap()) as i64;
            let len = u32::from_be_bytes(rest[8..12].try_into().unwrap()) as usize;
            out.push((seq, rest[12..12 + len].to_vec()));
            rest = &rest[12 + len..];
        }
        out
    }
}
pub fn request(method: &str, url: &str, token: Option<&str>, headers: &[(&str, String)], body: Vec<u8>) -> Reply {
    let agent: ureq::Agent = ureq::Agent::config_builder().http_status_as_error(false).max_redirects(0).timeout_global(Some(Duration::from_secs(60))).build().into();
    let mut builder = ureq::http::Request::builder().method(method).uri(url);
    if let Some(t) = token {
        builder = builder.header("Authorization", format!("ScribyraSSO {t}"));
    }
    for (k, v) in headers {
        builder = builder.header(*k, v);
    }
    let mut response = agent.run(builder.body(body).unwrap()).unwrap();
    let headers = response.headers().iter().map(|(k, v)| (k.as_str().to_owned(), v.to_str().unwrap_or("").to_owned())).collect();
    let status = response.status().as_u16();
    let body = response.body_mut().with_config().limit(256 << 20).read_to_vec().unwrap_or_default();
    Reply { status, headers, body }
}

/// One person's view of the `/v1/sr/` API.
#[derive(Clone)]
pub struct Api {
    pub base: String,
    pub token: String,
}
impl Api {
    pub fn on(&self, base: &str) -> Api {
        Api { base: base.to_owned(), token: self.token.clone() }
    }
    pub fn call(&self, method: &str, path: &str, body: Option<Value>) -> Reply {
        let headers = if body.is_some() { vec![("Content-Type", "application/json".to_string())] } else { vec![] };
        request(method, &format!("{}{path}", self.base), Some(&self.token), &headers, body.map(|b| b.to_string().into_bytes()).unwrap_or_default())
    }
    /// Creates a project; returns its ID.
    pub fn create(&self, name: &str) -> String {
        let reply = self.call("POST", "/v1/sr/projects", Some(json!({"name": name})));
        assert_eq!(reply.status, 201, "{}", String::from_utf8_lossy(&reply.body));
        reply.json()["project"]["id"].as_str().unwrap().to_owned()
    }
    pub fn append(&self, project: &str, client: &str, seq: i64, update: &[u8]) -> Reply {
        request(
            "POST",
            &format!("{}/v1/sr/projects/{project}/log", self.base),
            Some(&self.token),
            &[("Scribyra-Client", client.to_owned()), ("Scribyra-Client-Seq", seq.to_string()), ("Content-Type", "application/octet-stream".into())],
            update.to_vec(),
        )
    }
    pub fn log(&self, project: &str, after: i64) -> Reply {
        self.call("GET", &format!("/v1/sr/projects/{project}/log?after={after}"), None)
    }
    pub fn details(&self, project: &str) -> Reply {
        self.call("GET", &format!("/v1/sr/projects/{project}"), None)
    }
    pub fn put_object(&self, project: &str, bytes: &[u8]) -> Reply {
        request("PUT", &format!("{}/v1/sr/projects/{project}/objects/{}", self.base, super::sha256(bytes)), Some(&self.token), &[], bytes.to_vec())
    }
    pub fn get_object(&self, project: &str, hash: &str) -> Reply {
        self.call("GET", &format!("/v1/sr/projects/{project}/objects/{hash}"), None)
    }
    pub fn invite(&self, project: &str, email: &str, role: &str) -> Reply {
        self.call("POST", &format!("/v1/sr/projects/{project}/invitations"), Some(json!({"email": email, "role": role})))
    }
    /// `POST …/compile` with an optional `seq`.
    pub fn compile(&self, project: &str, seq: Option<i64>) -> Reply {
        self.call("POST", &format!("/v1/sr/projects/{project}/compile"), Some(seq.map_or(json!({}), |s| json!({"seq": s}))))
    }
    pub fn compile_status(&self, project: &str) -> Reply {
        self.call("GET", &format!("/v1/sr/projects/{project}/compile"), None)
    }
    /// Polls `GET …/compile` until job `job` is done or failed; returns the status.
    pub fn compiled(&self, project: &str, job: &str) -> Value {
        let mut last = Value::Null;
        let deadline = std::time::Instant::now() + Duration::from_secs(90);
        while std::time::Instant::now() < deadline {
            last = self.compile_status(project).json();
            if last["job"]["id"] == job && matches!(last["job"]["state"].as_str(), Some("done" | "failed")) {
                return last;
            }
            std::thread::sleep(Duration::from_millis(200));
        }
        panic!("job {job} did not finish: {last}");
    }
    pub fn heads(&self, since: Option<&str>, wait: u64) -> Reply {
        let since = since.map(|s| format!("&since={s}")).unwrap_or_default();
        self.call("GET", &format!("/v1/sr/heads?wait={wait}{since}"), None)
    }
}

/// A project document shaped like the app's (`files`, `text:<id>`, `assets`, `meta`).
pub struct Project {
    pub doc: Doc,
}
impl Default for Project {
    fn default() -> Self {
        Self::new()
    }
}
impl Project {
    pub fn new() -> Project {
        Project { doc: Doc::new() }
    }
    fn node(id: &str, name: &str, parent: Option<&str>, binary: bool, folder: bool) -> Any {
        let mut record: HashMap<String, Any> = HashMap::new();
        record.insert("id".into(), Any::from(id));
        record.insert("name".into(), Any::from(name));
        record.insert("parentId".into(), parent.map(Any::from).unwrap_or(Any::Null));
        record.insert("binary".into(), Any::Bool(binary));
        record.insert("folder".into(), Any::Bool(folder));
        Any::Map(Arc::new(record))
    }
    /// Adds a text file; returns the update.
    pub fn add_text(&self, id: &str, name: &str, parent: Option<&str>, text: &str) -> Vec<u8> {
        let (files, body) = (self.doc.get_or_insert_map("files"), self.doc.get_or_insert_text(format!("text:{id}")));
        let mut txn = self.doc.transact_mut();
        files.insert(&mut txn, id, Self::node(id, name, parent, false, false));
        body.insert(&mut txn, 0, text);
        txn.encode_update_v1()
    }
    pub fn add_folder(&self, id: &str, name: &str) -> Vec<u8> {
        let files = self.doc.get_or_insert_map("files");
        let mut txn = self.doc.transact_mut();
        files.insert(&mut txn, id, Self::node(id, name, None, false, true));
        txn.encode_update_v1()
    }
    pub fn add_asset(&self, id: &str, name: &str, bytes: &[u8]) -> Vec<u8> {
        let (files, assets) = (self.doc.get_or_insert_map("files"), self.doc.get_or_insert_map("assets"));
        let mut txn = self.doc.transact_mut();
        files.insert(&mut txn, id, Self::node(id, name, None, true, false));
        let mut r: HashMap<String, Any> = HashMap::new();
        r.insert("hash".into(), Any::from(super::sha256(bytes)));
        r.insert("size".into(), Any::Number(bytes.len() as f64));
        assets.insert(&mut txn, id, Any::Map(Arc::new(r)));
        txn.encode_update_v1()
    }
    /// Sets a `meta` field (for example `engine`).
    pub fn set_meta(&self, key: &str, value: &str) -> Vec<u8> {
        let meta = self.doc.get_or_insert_map("meta");
        let mut txn = self.doc.transact_mut();
        meta.insert(&mut txn, key, Any::from(value));
        txn.encode_update_v1()
    }
    pub fn set_main(&self, id: &str) -> Vec<u8> {
        let meta = self.doc.get_or_insert_map("meta");
        let mut txn = self.doc.transact_mut();
        meta.insert(&mut txn, "mainFile", Any::from(id));
        txn.encode_update_v1()
    }
    /// Appends `more` at the end of a text file.
    pub fn type_text(&self, id: &str, more: &str) -> Vec<u8> {
        let body = self.doc.get_or_insert_text(format!("text:{id}"));
        let mut txn = self.doc.transact_mut();
        let len = yrs::GetString::get_string(&body, &txn).len() as u32;
        body.insert(&mut txn, len, more);
        txn.encode_update_v1()
    }
}
/// The text of `text:<id>` after applying `updates` to a fresh document.
pub fn text_of(updates: &[Vec<u8>], id: &str) -> String {
    use yrs::{GetString, Update, updates::decoder::Decode};
    let doc = Doc::new();
    let text = doc.get_or_insert_text(format!("text:{id}"));
    let mut txn = doc.transact_mut();
    for u in updates {
        txn.apply_update(Update::decode_v1(u).unwrap()).unwrap();
    }
    text.get_string(&txn)
}
/// Polls `check` for up to 20 seconds.
pub fn eventually(what: &str, mut check: impl FnMut() -> bool) {
    let deadline = std::time::Instant::now() + Duration::from_secs(20);
    while !check() {
        assert!(std::time::Instant::now() < deadline, "timed out waiting for {what}");
        std::thread::sleep(Duration::from_millis(100));
    }
}
