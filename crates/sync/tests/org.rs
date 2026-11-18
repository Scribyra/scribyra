//! Organisation routes end to end through the real binary against real PostgreSQL, with
//! filesystem blobs and with Garage (S3) blobs: genesis by a signed-in administrator, sign-in
//! bound to the login, project log
//! appends (inline and blob-stored), idempotent retries, refusal of forged or reordered
//! entries, and durability across a hard kill.
mod support;
use scribyra_core::orgsync::{self as core, EntryHeader};
use serde_json::{Value, json};
use std::time::Duration;
use support::{sso, *};

fn agent() -> ureq::Agent {
    ureq::Agent::config_builder().http_status_as_error(false).timeout_global(Some(Duration::from_secs(30))).build().into()
}
fn post(url: &str, token: Option<&str>, content_type: &str, body: &[u8]) -> (u16, Vec<u8>) {
    let mut request = agent().post(url).header("Content-Type", content_type);
    if let Some(token) = token {
        request = request.header("Authorization", &format!("Scribyra {token}"));
    }
    let mut response = request.send(body).unwrap();
    (response.status().as_u16(), response.body_mut().read_to_vec().unwrap())
}
fn fetch(url: &str, token: &str) -> (u16, Vec<u8>) {
    let mut response = agent().get(url).header("Authorization", &format!("Scribyra {token}")).call().unwrap();
    (response.status().as_u16(), response.body_mut().read_to_vec().unwrap())
}
fn sign_event(org: &str, prev: &str, kind: &str, body: Value, seed: &[u8]) -> String {
    let mut event = json!({"v":1,"org":org,"prev":prev,"type":kind,"body":body,"signer":core::hex(&core::ed25519_public(seed).unwrap())});
    event["sig"] = json!(core::hex(&core::ed25519_sign(seed, &core::event_signing_message(&event).unwrap()).unwrap()));
    core::canonical(&event).unwrap()
}
fn entry(org: &str, project: &str, seed: &[u8], client_seq: u64, ciphertext: &[u8]) -> Vec<u8> {
    let mut header = EntryHeader { v: 1, org: org.into(), project: project.into(), device: core::hex(&core::ed25519_public(seed).unwrap()), client_seq, kind: "update".into(), epoch: 1, sig: String::new() };
    header.sig = core::hex(&core::ed25519_sign(seed, &core::entry_signing_message(&header, ciphertext).unwrap()).unwrap());
    let raw = core::canonical(&serde_json::to_value(&header).unwrap()).unwrap();
    let mut body = (raw.len() as u32).to_be_bytes().to_vec();
    body.extend_from_slice(raw.as_bytes());
    body.extend_from_slice(ciphertext);
    body
}

fn org_log(backend: Value) {
    let mut overrides = json!({"entry_inline_bytes": 1024});
    for (k, v) in backend.as_object().unwrap() {
        overrides[k] = v.clone();
    }
    let mut env = sso::Env::start("RS256", sso::people(), overrides, json!({}));
    let public = env.public.clone();
    let org = env.org();
    let client = env.client();
    let device_seed = random_bytes(32);
    let device = core::hex(&core::ed25519_public(&device_seed).unwrap());
    let agreement = core::hex(&core::x25519_public(&random_bytes(32)).unwrap());
    let person = core::person_id(&org, &device).unwrap();
    let body = json!({"person":person,"device":device,"agreement":agreement,"name":random_hex(60),"directoryCommit":random_hex(32),"ownerName":random_hex(60)});
    let genesis = sign_event(&org, &org, "genesis", body, &device_seed);
    let events = format!("{}/v1/orgs/{org}/events", env.service.url);
    // No sign-in, no genesis: there is no setup code any more.
    assert_eq!(post(&events, None, "application/json", genesis.as_bytes()).0, 403);
    let alice = client.login("alice")["token"].as_str().unwrap().to_owned();
    assert_eq!(orgs::post_with_login(&env.service.url, &org, &genesis, &alice).status, 201);
    // Once only.
    assert_ne!(orgs::post_with_login(&env.service.url, &org, &genesis, &alice).status, 201);
    // Sign in: challenge, then a signature bound to this service's public address and the login.
    let base = env.service.url.clone();
    let sign_in = |seed: &[u8], url: &str, sso: &str| -> (u16, Value) {
        let (_, c) = post(&format!("{base}/v1/auth/challenge"), None, "application/json", json!({"org": org}).to_string().as_bytes());
        let challenge = serde_json::from_slice::<Value>(&c).unwrap()["challenge"].as_str().unwrap().to_string();
        let key = core::hex(&core::ed25519_public(seed).unwrap());
        let hash = core::hex(&core::sha256(sso.as_bytes()));
        let sig = core::hex(&core::ed25519_sign(seed, scribyra_sync::org::session_message(url, &org, &key, &hash, &challenge).as_bytes()).unwrap());
        let (status, body) = post(&format!("{base}/v1/auth/session"), None, "application/json", json!({"org":org,"key":key,"challenge":challenge,"sig":sig,"sso":sso}).to_string().as_bytes());
        (status, serde_json::from_slice(&body).unwrap_or(Value::Null))
    };
    assert_eq!(sign_in(&device_seed, "https://elsewhere.example", &alice).0, 401);
    assert_eq!(sign_in(&random_bytes(32), &public, &alice).0, 403);
    let (status, session) = sign_in(&device_seed, &public, &alice);
    assert_eq!(status, 200);
    let token = session["token"].as_str().unwrap().to_string();
    let head = core::event_hash(&serde_json::from_str(&genesis).unwrap()).unwrap();
    let project = random_hex(32);
    let create = sign_event(&org, &head, "project.create", json!({"project":project,"epoch":1,"keyCommit":random_hex(32)}), &device_seed);
    assert_eq!(post(&events, Some(&token), "application/json", create.as_bytes()).0, 201);
    // A stale head is a conflict, not a fork.
    let stale = sign_event(&org, &head, "project.create", json!({"project":random_hex(32),"epoch":1,"keyCommit":random_hex(32)}), &device_seed);
    assert_eq!(post(&events, Some(&token), "application/json", stale.as_bytes()).0, 409);

    let log = format!("{}/v1/projects/{project}/log", env.service.url);
    let small = entry(&org, &project, &device_seed, 1, &random_bytes(100));
    let large = entry(&org, &project, &device_seed, 2, &random_bytes(200_000));
    let (status, ack) = post(&log, Some(&token), "application/octet-stream", &small);
    assert_eq!(status, 201, "{}", String::from_utf8_lossy(&ack));
    assert_eq!(post(&log, Some(&token), "application/octet-stream", &small).0, 200);
    assert_eq!(post(&log, Some(&token), "application/octet-stream", &entry(&org, &project, &device_seed, 1, &random_bytes(100))).0, 409);
    assert_eq!(post(&log, Some(&token), "application/octet-stream", &entry(&org, &project, &device_seed, 3, &random_bytes(100))).0, 409);
    let mut forged = large.clone();
    *forged.last_mut().unwrap() ^= 1;
    assert_eq!(post(&log, Some(&token), "application/octet-stream", &forged).0, 400);
    assert_eq!(post(&log, Some(&token), "application/octet-stream", &entry(&org, &project, &random_bytes(32), 1, &random_bytes(100))).0, 403);
    assert_eq!(post(&log, Some(&token), "application/octet-stream", &large).0, 201);
    // The large entry lives in the blob store, the small one inline.
    assert_eq!(postgres().psql(env.service.database_url(), "SELECT count(*) FILTER (WHERE inline IS NULL) || ',' || count(*) FROM entries"), "1,2");
    env.service.kill();
    env.service.start().unwrap();
    let (_, session) = sign_in(&device_seed, &public, &alice);
    let token = session["token"].as_str().unwrap();
    let (status, bytes) = fetch(&format!("{log}?after=0"), token);
    assert_eq!(status, 200);
    let mut chain = core::chain_start(&project).unwrap();
    let (mut at, mut seen) = (0, vec![]);
    while at < bytes.len() {
        let seq = u64::from_be_bytes(bytes[at..at + 8].try_into().unwrap());
        let len = u32::from_be_bytes(bytes[at + 40..at + 44].try_into().unwrap()) as usize;
        let body = &bytes[at + 44..at + 44 + len];
        let (header, raw, ct) = core::split_entry(body).unwrap();
        core::verify_entry(&header, ct).unwrap();
        chain = core::chain_next(&chain, &core::entry_hash(raw, ct));
        assert_eq!(&bytes[at + 8..at + 40], &chain);
        seen.push((seq, body.to_vec()));
        at += 44 + len;
    }
    assert_eq!(seen, vec![(1, small), (2, large)]);
    // Nothing is readable without a session.
    assert_eq!(fetch(&format!("{log}?after=0"), &random_hex(32)).0, 401);
}

#[test]
fn org_log_with_filesystem_blobs() {
    org_log(json!({}));
}
#[test]
fn org_log_with_garage_blobs() {
    org_log(garage().config());
}
