//! A small organisation client for integration tests: devices, signed events, sign-in through
//! the test provider, wraps and log entries, built on the same `scribyra_core::orgsync` code as the browser.
#![allow(dead_code)]
use super::{random_bytes, random_hex};
use scribyra_core::orgsync::{self as core, EntryHeader};
use serde_json::{Value, json};
use std::time::Duration;

pub fn agent() -> ureq::Agent {
    ureq::Agent::config_builder().http_status_as_error(false).timeout_global(Some(Duration::from_secs(60))).build().into()
}
pub struct Reply {
    pub status: u16,
    pub body: Vec<u8>,
    pub head: Option<String>,
}
impl Reply {
    pub fn json(&self) -> Value {
        serde_json::from_slice(&self.body).unwrap_or(Value::Null)
    }
}
pub fn send(method: &str, url: &str, token: Option<&str>, content_type: &str, body: &[u8]) -> Reply {
    let agent = agent();
    let mut response = match method {
        "GET" => {
            let mut r = agent.get(url);
            if let Some(t) = token {
                r = r.header("Authorization", &format!("Scribyra {t}"));
            }
            r.call().unwrap()
        }
        _ => {
            let mut r = match method {
                "PUT" => agent.put(url),
                _ => agent.post(url),
            }
            .header("Content-Type", content_type);
            if let Some(t) = token {
                r = r.header("Authorization", &format!("Scribyra {t}"));
            }
            r.send(body).unwrap()
        }
    };
    let head = response.headers().get("scribyra-log-head").and_then(|v| v.to_str().ok()).map(str::to_string);
    Reply { status: response.status().as_u16(), body: response.body_mut().with_config().limit(64 << 20).read_to_vec().unwrap(), head }
}
pub fn b64url_decode(text: &str) -> Vec<u8> {
    const A: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    let (mut acc, mut bits, mut out) = (0u32, 0u32, Vec::new());
    for c in text.bytes() {
        acc = (acc << 6) | A.iter().position(|&x| x == c).unwrap() as u32;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((acc >> bits) as u8);
        }
    }
    out
}

/// A device: an Ed25519 signing seed and an X25519 agreement secret.
#[derive(Clone)]
pub struct Device {
    pub seed: Vec<u8>,
    pub agreement_secret: Vec<u8>,
    pub key: String,
    pub agreement: String,
}
impl Device {
    pub fn new() -> Self {
        let (seed, agreement_secret) = (random_bytes(32), random_bytes(32));
        let key = core::hex(&core::ed25519_public(&seed).unwrap());
        let agreement = core::hex(&core::x25519_public(&agreement_secret).unwrap());
        Self { seed, agreement_secret, key, agreement }
    }
    pub fn sign(&self, message: &[u8]) -> String {
        core::hex(&core::ed25519_sign(&self.seed, message).unwrap())
    }
}
pub fn sign_event(org: &str, prev: &str, kind: &str, body: Value, seed: &[u8]) -> String {
    let mut event = json!({"v":1,"org":org,"prev":prev,"type":kind,"body":body,"signer":core::hex(&core::ed25519_public(seed).unwrap())});
    event["sig"] = json!(core::hex(&core::ed25519_sign(seed, &core::event_signing_message(&event).unwrap()).unwrap()));
    core::canonical(&event).unwrap()
}
pub fn entry(org: &str, project: &str, seed: &[u8], client_seq: u64, epoch: u32, ciphertext: &[u8]) -> Vec<u8> {
    let mut header = EntryHeader { v: 1, org: org.into(), project: project.into(), device: core::hex(&core::ed25519_public(seed).unwrap()), client_seq, kind: "update".into(), epoch, sig: String::new() };
    header.sig = core::hex(&core::ed25519_sign(seed, &core::entry_signing_message(&header, ciphertext).unwrap()).unwrap());
    let raw = core::canonical(&serde_json::to_value(&header).unwrap()).unwrap();
    let mut body = (raw.len() as u32).to_be_bytes().to_vec();
    body.extend_from_slice(raw.as_bytes());
    body.extend_from_slice(ciphertext);
    body
}

/// The deployment's organisation on a running service, with a local replay of its membership
/// log and the sign-in (login token) of each person the tests act as.
pub struct Org {
    pub base: String,
    pub public: String,
    pub id: String,
    pub state: core::OrgState,
    pub owner: Device,
    pub owner_person: String,
    /// Login tokens by person.
    pub logins: std::collections::HashMap<String, String>,
}
/// Overrides that give a service a fixed address and `public_url`, as organisations need.
pub fn org_overrides(extra: Value) -> Value {
    let port = super::free_port();
    let mut overrides = json!({"bind": format!("127.0.0.1:{port}"), "public_url": format!("http://127.0.0.1:{port}")});
    for (k, v) in extra.as_object().unwrap() {
        overrides[k] = v.clone();
    }
    overrides
}
/// A genesis body for a fresh owner device.
pub fn genesis_body(org: &str, owner: &Device) -> Value {
    json!({"person":core::person_id(org, &owner.key).unwrap(),"device":owner.key,"agreement":owner.agreement,"name":random_hex(60),"directoryCommit":random_hex(32),"ownerName":random_hex(60)})
}
/// Posts a membership event authenticated by a login (`ScribyraSSO`) rather than a session.
pub fn post_with_login(base: &str, org: &str, raw: &str, login: &str) -> Reply {
    let mut response = agent().post(&format!("{base}/v1/orgs/{org}/events")).header("Content-Type", "application/json").header("Authorization", &format!("ScribyraSSO {login}")).send(raw.as_bytes()).unwrap();
    Reply { status: response.status().as_u16(), body: response.body_mut().read_to_vec().unwrap(), head: None }
}
impl Org {
    /// The deployment's administrator `admin` signs in and creates the organisation with a
    /// genesis from a fresh owner device.
    pub fn create(env: &super::sso::Env, admin: &str) -> Org {
        let id = env.org();
        let login = env.client().login(admin)["token"].as_str().unwrap().to_owned();
        let owner = Device::new();
        let genesis = sign_event(&id, &id, "genesis", genesis_body(&id, &owner), &owner.seed);
        let reply = post_with_login(&env.service.url, &id, &genesis, &login);
        assert_eq!(reply.status, 201, "{}", String::from_utf8_lossy(&reply.body));
        let mut state = core::OrgState::new(&id).unwrap();
        state.apply(&genesis).unwrap();
        let person = core::person_id(&id, &owner.key).unwrap();
        Org { base: env.service.url.clone(), public: env.public.clone(), id, state, owner, owner_person: person.clone(), logins: [(person, login)].into() }
    }
    pub fn url(&self, path: &str) -> String {
        format!("{}{path}", self.base)
    }
    /// The login of the person a key (device or recovery) acts for.
    pub fn login_for(&self, seed: &[u8]) -> Option<String> {
        let key = core::hex(&core::ed25519_public(seed).unwrap());
        // Also for pending, removed and retired keys, so tests can show what the service refuses.
        let recovery = |k: &str| self.state.persons.iter().find(|(_, p)| p.recovery_signing.as_deref() == Some(k)).map(|(id, _)| id.clone());
        let person = self.state.devices.get(&key).map(|d| d.person.clone()).or_else(|| self.state.former_devices.get(&key).cloned()).or_else(|| recovery(&key))?;
        self.logins.get(&person).cloned()
    }
    /// Challenge-response sign-in with the person's login (unless `extra` names another `sso`,
    /// or `null` to send none); returns (status, body).
    pub fn sign_in_with(&self, seed: &[u8], extra: Value) -> Reply {
        let c = send("POST", &self.url("/v1/auth/challenge"), None, "application/json", json!({"org": self.id}).to_string().as_bytes());
        assert_eq!(c.status, 200, "{}", String::from_utf8_lossy(&c.body));
        let challenge = c.json()["challenge"].as_str().unwrap().to_string();
        let key = core::hex(&core::ed25519_public(seed).unwrap());
        let sso = match extra.get("sso") {
            Some(Value::String(s)) => Some(s.clone()),
            Some(_) => None,
            None => self.login_for(seed),
        };
        let login_hash = core::hex(&core::sha256(sso.clone().unwrap_or_default().as_bytes()));
        let sig = core::hex(&core::ed25519_sign(seed, scribyra_sync::org::session_message(&self.public, &self.id, &key, &login_hash, &challenge).as_bytes()).unwrap());
        let mut body = json!({"org":self.id,"key":key,"challenge":challenge,"sig":sig});
        if let Some(sso) = sso {
            body["sso"] = json!(sso);
        }
        for (k, v) in extra.as_object().unwrap() {
            if k != "sso" {
                body[k] = v.clone();
            }
        }
        send("POST", &self.url("/v1/auth/session"), None, "application/json", body.to_string().as_bytes())
    }
    pub fn token(&self, seed: &[u8]) -> String {
        let reply = self.sign_in_with(seed, json!({}));
        assert_eq!(reply.status, 200, "{}", String::from_utf8_lossy(&reply.body));
        reply.json()["token"].as_str().unwrap().to_string()
    }
    /// Signs an event on the current head and posts it; on success applies it locally.
    pub fn post(&mut self, token: Option<&str>, kind: &str, body: Value, seed: &[u8]) -> Reply {
        let raw = sign_event(&self.id, &self.state.head.clone(), kind, body, seed);
        self.post_raw(token, &raw)
    }
    pub fn post_raw(&mut self, token: Option<&str>, raw: &str) -> Reply {
        let reply = send("POST", &self.url(&format!("/v1/orgs/{}/events", self.id)), token, "application/json", raw.as_bytes());
        if reply.status == 201 {
            self.state.apply(raw).unwrap();
        }
        reply
    }
    /// Signs an event and posts it with a login instead of a session.
    pub fn post_login(&mut self, kind: &str, body: Value, seed: &[u8], login: &str) -> Reply {
        let raw = sign_event(&self.id, &self.state.head.clone(), kind, body, seed);
        let reply = post_with_login(&self.base, &self.id, &raw, login);
        if reply.status == 201 {
            self.state.apply(&raw).unwrap();
        }
        reply
    }
    /// A join request body for a new device, at the current head.
    pub fn request_body(&self, device: &Device) -> Value {
        let person = self.person(device);
        let proof = device.sign(&core::device_proof_message(&self.id, &self.state.head, &person, &device.key, &device.agreement));
        json!({"person":person,"device":device.key,"agreement":device.agreement,"proof":proof,"name":random_hex(60)})
    }
    /// `user` signs in and asks to join with `device` (pending until approved).
    pub fn request(&mut self, client: &super::sso::Client, user: &str, device: &Device) -> Reply {
        let login = client.login(user)["token"].as_str().unwrap().to_owned();
        let body = self.request_body(device);
        let reply = self.post_login("person.request", body, &device.seed, &login);
        if reply.status == 201 {
            self.logins.insert(self.person(device), login);
        }
        reply
    }
    /// `user` asks to join with `device` and the owner approves them as an organisation member.
    pub fn admit(&mut self, client: &super::sso::Client, user: &str, device: &Device) {
        let reply = self.request(client, user, device);
        assert_eq!(reply.status, 201, "{}", String::from_utf8_lossy(&reply.body));
        let (owner, token) = (self.owner.clone(), self.token(&self.owner.seed.clone()));
        let reply = self.post(Some(&token), "person.approve", json!({"person":self.person(device),"role":"member"}), &owner.seed);
        assert_eq!(reply.status, 201, "{}", String::from_utf8_lossy(&reply.body));
    }
    pub fn recovery_body(&self, person: &str, recovery_seed: &[u8], recovery_secret: &[u8]) -> Value {
        let signing = core::hex(&core::ed25519_public(recovery_seed).unwrap());
        let agreement = core::hex(&core::x25519_public(recovery_secret).unwrap());
        let proof = core::hex(&core::ed25519_sign(recovery_seed, &core::recovery_proof_message(&self.id, &self.state.head, person, &signing, &agreement)).unwrap());
        json!({"person":person,"signing":signing,"agreement":agreement,"proof":proof})
    }
    pub fn device_body(&self, person: &str, device: &Device) -> Value {
        let proof = device.sign(&core::device_proof_message(&self.id, &self.state.head, person, &device.key, &device.agreement));
        json!({"person":person,"device":device.key,"agreement":device.agreement,"proof":proof})
    }
    pub fn person(&self, device: &Device) -> String {
        core::person_id(&self.id, &device.key).unwrap()
    }
    /// A wrap whose content is arbitrary (the service cannot open wraps anyway).
    pub fn wrap(&self, project: &str, epoch: u32, recipient: &str, sender: &Device) -> String {
        let mut wrap = json!({"v":1,"org":self.id,"project":project,"epoch":epoch,"recipient":recipient,"enc":core::hex(&core::x25519_public(&random_bytes(32)).unwrap()),"nonce":random_hex(24),"ct":random_hex(48),"sender":sender.key});
        wrap["sig"] = json!(sender.sign(&core::wrap_signing_message(&wrap).unwrap()));
        core::canonical(&wrap).unwrap()
    }
    pub fn put_wraps(&self, token: &str, wraps: &[String]) -> Reply {
        send("PUT", &self.url(&format!("/v1/orgs/{}/keys", self.id)), Some(token), "application/json", serde_json::to_string(wraps).unwrap().as_bytes())
    }
    pub fn wraps(&self, token: &str) -> Vec<String> {
        let reply = send("GET", &self.url(&format!("/v1/orgs/{}/keys", self.id)), Some(token), "", b"");
        assert_eq!(reply.status, 200, "{}", String::from_utf8_lossy(&reply.body));
        serde_json::from_value(reply.json()["wraps"].clone()).unwrap()
    }
    pub fn create_project(&mut self, token: &str, device: &Device) -> String {
        let project = random_hex(32);
        let reply = self.post(Some(token), "project.create", json!({"project":project,"epoch":1,"keyCommit":random_hex(32)}), &device.seed);
        assert_eq!(reply.status, 201, "{}", String::from_utf8_lossy(&reply.body));
        project
    }
    pub fn append(&self, token: &str, project: &str, body: &[u8]) -> Reply {
        send("POST", &self.url(&format!("/v1/projects/{project}/log")), Some(token), "application/octet-stream", body)
    }
    /// Parses a log page into (seq, chain, body) triples.
    pub fn log_page(&self, token: &str, project: &str, after: u64) -> (Reply, Vec<(u64, Vec<u8>, Vec<u8>)>) {
        let reply = send("GET", &self.url(&format!("/v1/projects/{project}/log?after={after}")), Some(token), "", b"");
        let (bytes, mut at, mut out) = (&reply.body, 0, vec![]);
        while reply.status == 200 && at < bytes.len() {
            let seq = u64::from_be_bytes(bytes[at..at + 8].try_into().unwrap());
            let len = u32::from_be_bytes(bytes[at + 40..at + 44].try_into().unwrap()) as usize;
            out.push((seq, bytes[at + 8..at + 40].to_vec(), bytes[at + 44..at + 44 + len].to_vec()));
            at += 44 + len;
        }
        (reply, out)
    }
}
