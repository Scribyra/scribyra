//! A small organisation client for integration tests: devices, signed events, sign-in,
//! wraps and log entries, built on the same `scribyra_core::orgsync` code as the browser.
#![allow(dead_code)]
use super::{Service, random_bytes, random_hex};
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

/// One organisation on a running service, with a local replay of its membership log.
pub struct Org {
    pub base: String,
    pub public: String,
    pub id: String,
    pub state: core::OrgState,
    pub owner: Device,
    pub owner_person: String,
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
impl Org {
    /// `scribyra-sync org create`, then a genesis signed by a fresh owner device.
    pub fn create(s: &Service, extra_args: &[&str], genesis_extra: Value) -> Org {
        let mut args = vec!["org", "create", "--label", "test"];
        args.extend_from_slice(extra_args);
        let (code, out) = s.run(&args);
        assert_eq!(code, 0, "{out}");
        let created: Value = serde_json::from_str(out.lines().last().unwrap()).unwrap();
        let setup = created["setup"].as_str().unwrap();
        let parts: Vec<&str> = setup.split(':').collect();
        let public = String::from_utf8(b64url_decode(parts[2])).unwrap();
        let (id, secret) = (parts[3].to_string(), b64url_decode(parts[4]));
        let owner = Device::new();
        let enrol_seed = core::enrol_seed(&secret).unwrap();
        let person = core::person_id(&id, &owner.key).unwrap();
        let mut body = json!({"person":person,"device":owner.key,"agreement":owner.agreement,"enrol":core::hex(&core::ed25519_public(&enrol_seed).unwrap()),"enrolSig":"","mode":"e2ee","adminRead":true});
        for (k, v) in genesis_extra.as_object().unwrap() {
            body[k] = v.clone();
        }
        let parsed: core::GenesisBody = serde_json::from_value(body.clone()).unwrap();
        body["enrolSig"] = json!(core::hex(&core::ed25519_sign(&enrol_seed, &core::enrol_message(&id, &parsed)).unwrap()));
        let genesis = sign_event(&id, &id, "genesis", body, &owner.seed);
        let reply = send("POST", &format!("{}/v1/orgs/{id}/events", s.url), None, "application/json", genesis.as_bytes());
        assert_eq!(reply.status, 201, "{}", String::from_utf8_lossy(&reply.body));
        let mut state = core::OrgState::new(&id).unwrap();
        state.apply(&genesis, None).unwrap();
        Org { base: s.url.clone(), public, id, state, owner, owner_person: person }
    }
    pub fn url(&self, path: &str) -> String {
        format!("{}{path}", self.base)
    }
    /// Challenge-response sign-in; returns (status, body).
    pub fn sign_in_with(&self, seed: &[u8], extra: Value) -> Reply {
        let c = send("POST", &self.url("/v1/auth/challenge"), None, "application/json", json!({"org": self.id}).to_string().as_bytes());
        assert_eq!(c.status, 200, "{}", String::from_utf8_lossy(&c.body));
        let challenge = c.json()["challenge"].as_str().unwrap().to_string();
        let key = core::hex(&core::ed25519_public(seed).unwrap());
        let sig = core::hex(&core::ed25519_sign(seed, format!("scribyra-auth/1\n{}\n{}\n{key}\n{challenge}", self.public, self.id).as_bytes()).unwrap());
        let mut body = json!({"org":self.id,"key":key,"challenge":challenge,"sig":sig});
        for (k, v) in extra.as_object().unwrap() {
            body[k] = v.clone();
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
            self.state.apply(raw, None).unwrap();
        }
        reply
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
