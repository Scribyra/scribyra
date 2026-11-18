//! Sign-in test helpers: the `test-idp` example provider, a deployment configured with it, and a
//! browserless client for the service's sign-in flow (start, provider authorization, callback,
//! redeem).
//!
//! The provider binary is built once per test binary with
//! `cargo build -p scribyra-sync --example test-idp` (cargo is already running the tests, so
//! this is quick when `cargo test` has built the examples) and run from
//! `target/<profile>/examples/test-idp`.
#![allow(dead_code)]
use super::{Service, free_port, random_bytes, sha256, temp_dir};
use serde_json::{Value, json};
use std::{
    io::{BufRead, BufReader, Read},
    path::PathBuf,
    process::{Child, Command, Stdio},
    sync::{Arc, Mutex, OnceLock},
    time::Duration,
};

/// The app origin the tests return to (only ever used as a string; never contacted).
pub const APP: &str = "https://app.scribyra.test";
pub const CLIENT_ID: &str = "scribyra-service";

pub fn agent() -> ureq::Agent {
    ureq::Agent::config_builder().http_status_as_error(false).max_redirects(0).timeout_global(Some(Duration::from_secs(30))).build().into()
}
pub struct Http {
    pub status: u16,
    pub location: Option<String>,
    pub body: String,
}
impl Http {
    pub fn json(&self) -> Value {
        serde_json::from_str(&self.body).unwrap_or(Value::Null)
    }
}
fn finish(response: Result<ureq::http::Response<ureq::Body>, ureq::Error>) -> Http {
    let mut response = response.unwrap();
    let location = response.headers().get("location").and_then(|v| v.to_str().ok()).map(str::to_owned);
    Http { status: response.status().as_u16(), location, body: response.body_mut().read_to_string().unwrap_or_default() }
}
pub fn fetch(url: &str, token: Option<&str>) -> Http {
    let mut request = agent().get(url);
    if let Some(t) = token {
        request = request.header("Authorization", &format!("ScribyraSSO {t}"));
    }
    finish(request.call())
}
pub fn post_json(url: &str, token: Option<&str>, body: &Value) -> Http {
    let mut request = agent().post(url).header("Content-Type", "application/json");
    if let Some(t) = token {
        request = request.header("Authorization", &format!("ScribyraSSO {t}"));
    }
    finish(request.send(body.to_string().as_bytes()))
}

/// The `test-idp` example binary, built once per test binary.
pub fn idp_binary() -> &'static PathBuf {
    static BINARY: OnceLock<PathBuf> = OnceLock::new();
    BINARY.get_or_init(|| {
        let exe = std::env::current_exe().unwrap();
        let profile_dir = exe.parent().unwrap().parent().unwrap().to_path_buf();
        let cargo = std::env::var("CARGO").unwrap_or_else(|_| "cargo".into());
        let status = Command::new(cargo)
            .args(["build", "--quiet", "-p", "scribyra-sync", "--example", "test-idp"])
            .current_dir(env!("CARGO_MANIFEST_DIR"))
            .stdin(Stdio::null())
            .status()
            .unwrap();
        assert!(status.success(), "building the test-idp example failed");
        let binary = profile_dir.join("examples").join("test-idp");
        assert!(binary.is_file(), "{} is missing", binary.display());
        binary
    })
}

/// Default users: alice (verified, example.org, groups), bob (verified, other.org), carol
/// (unverified, example.org), dave (verified example.org email but Google `hd` other.org).
pub fn default_users() -> Value {
    json!([
        {"sub": "sub-alice", "username": "alice", "password": "pw-alice", "email": "alice@example.org", "email_verified": true, "name": "Alice Example", "groups": ["staff", "admins"]},
        {"sub": "sub-bob", "username": "bob", "password": "pw-bob", "email": "bob@other.org", "email_verified": true, "name": "Bob Other"},
        {"sub": "sub-carol", "username": "carol", "password": "pw-carol", "email": "carol@example.org", "email_verified": false, "name": "Carol"},
        {"sub": "sub-dave", "username": "dave", "password": "pw-dave", "email": "dave@example.org", "email_verified": true, "hd": "other.org"},
    ])
}

/// A running `test-idp` (killed and its directory removed on drop).
pub struct Idp {
    pub issuer: String,
    pub secret: String,
    dir: PathBuf,
    child: Child,
    pub logs: Arc<Mutex<String>>,
}
impl Idp {
    pub fn start(alg: &str, public_url: &str, users: Value) -> Idp {
        let port = free_port();
        let dir = temp_dir("scribyra-idp-");
        let issuer = format!("http://127.0.0.1:{port}");
        let secret = format!("client-secret-{}", super::random_hex(16));
        let config = json!({
            "bind": format!("127.0.0.1:{port}"), "issuer": issuer, "alg": alg, "test_shortcuts": true,
            "clients": [{"client_id": CLIENT_ID, "client_secret": secret, "redirect_uris": (["test", "partner"].map(|id| format!("{public_url}/v1/sso/callback/{id}"))),
                         "backchannel_logout_uri": format!("{public_url}/v1/sso/backchannel")}],
            "users": users,
        });
        let path = dir.join("idp.json");
        std::fs::write(&path, config.to_string()).unwrap();
        let mut child = Command::new(idp_binary()).arg("--config").arg(&path).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn().unwrap();
        let logs: Arc<Mutex<String>> = Default::default();
        let (tx, rx) = std::sync::mpsc::channel();
        let stdout = BufReader::new(child.stdout.take().unwrap());
        std::thread::spawn(move || {
            for line in stdout.lines().map_while(Result::ok) {
                if line.contains("\"listening\"") {
                    let _ = tx.send(());
                }
            }
        });
        let mut stderr = child.stderr.take().unwrap();
        let errors = logs.clone();
        std::thread::spawn(move || {
            let mut text = String::new();
            let _ = stderr.read_to_string(&mut text);
            errors.lock().unwrap().push_str(&text);
        });
        rx.recv_timeout(Duration::from_secs(20)).unwrap_or_else(|_| panic!("test-idp did not start: {}", logs.lock().unwrap()));
        Idp { issuer, secret, dir, child, logs }
    }
    pub fn control(&self, path: &str) -> Http {
        fetch(&format!("{}/control/{path}", self.issuer), None)
    }
    /// Write the client secret to a file for a provider's `client_secret_file`.
    pub fn secret_file(&self) -> PathBuf {
        let path = self.dir.join("client-secret");
        std::fs::write(&path, format!("{}\n", self.secret)).unwrap();
        path
    }
}
impl Drop for Idp {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

/// People for organisation tests: the default users plus verified example.org members.
pub fn people() -> Value {
    let mut users = default_users();
    for name in ["ben", "cat", "dan", "erin", "gina", "mallory", "nina", "omar", "pia", "quinn"] {
        users.as_array_mut().unwrap().push(json!({"sub": format!("sub-{name}"), "username": name, "password": format!("pw-{name}"), "email": format!("{name}@example.org"), "email_verified": true, "name": name}));
    }
    users
}
/// The `deployment` object for a service that signs in with `idp` (provider `test`): end to end
/// encrypted, alice@example.org an administrator. `extra` replaces top-level fields; its
/// `provider` object is merged into the provider, and each object of `more_providers` into a
/// copy of it (another provider at the same issuer, such as `partner`).
pub fn deployment(idp: &Idp, extra: Value) -> Value {
    let mut provider = json!({"id": "test", "label": "Test account", "issuer": idp.issuer, "client_id": CLIENT_ID, "client_secret_file": idp.secret_file()});
    let mut deployment = json!({"name": "Test Lab", "encryption": "e2ee", "admins": ["test:alice@example.org"]});
    let mut more = Vec::new();
    for (k, v) in extra.as_object().unwrap() {
        if k == "provider" {
            for (pk, pv) in v.as_object().unwrap() {
                provider[pk] = pv.clone();
            }
        } else if k == "more_providers" {
            more = v.as_array().unwrap().clone();
        } else {
            deployment[k] = v.clone();
        }
    }
    let mut providers = vec![provider.clone()];
    for m in more {
        let mut p = provider.clone();
        for (pk, pv) in m.as_object().unwrap() {
            p[pk] = pv.clone();
        }
        providers.push(p);
    }
    deployment["providers"] = json!(providers);
    deployment
}
/// A running service with a deployment that signs in with its own test provider.
pub struct Env {
    pub service: Service,
    pub idp: Idp,
    pub public: String,
}
impl Env {
    /// `service_extra` merges into the service configuration, `deployment_extra` as in
    /// [`deployment`].
    pub fn start(alg: &str, users: Value, service_extra: Value, deployment_extra: Value) -> Env {
        let port = free_port();
        let public = format!("http://127.0.0.1:{port}");
        let idp = Idp::start(alg, &public, users);
        let mut overrides = json!({"bind": format!("127.0.0.1:{port}"), "public_url": public, "origins": [APP], "deployment": deployment(&idp, deployment_extra)});
        for (k, v) in service_extra.as_object().unwrap() {
            overrides[k] = v.clone();
        }
        let service = Service::new(overrides);
        Env { service, idp, public }
    }
    pub fn client(&self) -> Client<'_> {
        Client { base: self.service.url.clone(), provider: "test".into(), idp: &self.idp }
    }
    /// The deployment's organisation ID.
    pub fn org(&self) -> String {
        fetch(&format!("{}/v1/deployment", self.service.url), None).json()["org"].as_str().unwrap().to_owned()
    }
}
/// A browserless sign-in client against one service and provider.
pub struct Client<'a> {
    pub base: String,
    pub provider: String,
    pub idp: &'a Idp,
}
/// A sign-in in progress: the provider's authorization URL and the app's verifier (hex).
pub struct Started {
    pub url: String,
    pub verifier: String,
}
#[derive(Debug, PartialEq, Eq)]
pub enum Outcome {
    Grant { grant: String, org: String },
    Error(String),
}
impl Client<'_> {
    pub fn url(&self, path: &str) -> String {
        format!("{}{path}", self.base)
    }
    pub fn start_with(&self, provider: &str, return_to: &str, challenge: &str) -> Http {
        post_json(&self.url("/v1/sso/start"), None, &json!({"provider": provider, "return": return_to, "challenge": challenge}))
    }
    pub fn start(&self) -> Started {
        let verifier = random_bytes(32);
        let reply = self.start_with(&self.provider, APP, &sha256(&verifier));
        assert_eq!(reply.status, 200, "{}", reply.body);
        Started { url: reply.json()["url"].as_str().unwrap().to_owned(), verifier: verifier.iter().map(|b| format!("{b:02x}")).collect() }
    }
    /// The provider's redirect back to the service (the callback URL), via the test shortcut.
    pub fn authorize(&self, started: &Started, user: &str, password: &str) -> String {
        let url = format!("{}&login_hint={user}&test_password={password}", started.url);
        let reply = fetch(&url, None);
        assert_eq!(reply.status, 302, "{}", reply.body);
        reply.location.unwrap()
    }
    /// Follow the callback; returns the status and the app redirect, parsed.
    pub fn callback(&self, callback: &str) -> (u16, Option<Outcome>) {
        let reply = fetch(callback, None);
        (reply.status, reply.location.map(|l| parse_return(&l)))
    }
    /// The whole flow for one user up to the grant.
    pub fn sign_in(&self, user: &str) -> (Outcome, String) {
        let started = self.start();
        let callback = self.authorize(&started, user, &format!("pw-{user}"));
        let (status, outcome) = self.callback(&callback);
        assert_eq!(status, 302);
        (outcome.unwrap(), started.verifier)
    }
    pub fn redeem(&self, grant: &str, verifier: &str) -> Http {
        post_json(&self.url("/v1/sso/redeem"), None, &json!({"code": grant, "verifier": verifier}))
    }
    /// Sign in and redeem; returns the redeem response body.
    pub fn login(&self, user: &str) -> Value {
        let (outcome, verifier) = self.sign_in(user);
        let Outcome::Grant { grant, .. } = outcome else { panic!("sign-in refused: {outcome:?}") };
        let reply = self.redeem(&grant, &verifier);
        assert_eq!(reply.status, 200, "{}", reply.body);
        reply.json()
    }
    pub fn me(&self, token: &str) -> Http {
        fetch(&self.url("/v1/sso/me"), Some(token))
    }
    pub fn logout(&self, token: &str) -> Http {
        post_json(&self.url("/v1/sso/logout"), Some(token), &json!({}))
    }
}
/// Parse `{APP}/#scribyra-sso=<grant>&org=<org>` or `{APP}/#scribyra-sso-error=<code>`.
pub fn parse_return(location: &str) -> Outcome {
    let fragment = location.strip_prefix(&format!("{APP}/#")).unwrap_or_else(|| panic!("unexpected redirect {location}"));
    let pairs: std::collections::HashMap<String, String> = url::form_urlencoded::parse(fragment.as_bytes()).into_owned().collect();
    if let Some(code) = pairs.get("scribyra-sso-error") {
        assert_eq!(pairs.len(), 1);
        return Outcome::Error(code.clone());
    }
    Outcome::Grant { grant: pairs["scribyra-sso"].clone(), org: pairs["org"].clone() }
}
