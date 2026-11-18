//! Server-side fixes from the adversarial review of slice 1, against real PostgreSQL:
//! retired keys lose their wraps, recovery keys need proof, logs and membership are paged
//! with an explicit head, and sign-in state is bounded per organisation and per key.
mod support;
use scribyra_core::orgsync as core;
use serde_json::json;
use support::{orgs::*, sso::*, *};

#[test]
fn retired_recovery_and_device_keys_lose_their_wraps() {
    let env = Env::start("RS256", people(), json!({}), json!({}));
    let s = &env.service;
    let mut org = Org::create(&env, "alice");
    let owner = org.owner.clone();
    let person = org.owner_person.clone();
    let token = org.token(&owner.seed);
    let (r1_seed, r1_secret) = (random_bytes(32), random_bytes(32));
    // A recovery key must be proven by its own signing key.
    let mut unproven = org.recovery_body(&person, &r1_seed, &r1_secret);
    unproven["proof"] = json!(owner.sign(b"not a proof"));
    assert_eq!(org.post(Some(&token), "recovery.set", unproven, &owner.seed).status, 400);
    let body = org.recovery_body(&person, &r1_seed, &r1_secret);
    let first_recovery = body["agreement"].as_str().unwrap().to_string();
    assert_eq!(org.post(Some(&token), "recovery.set", body, &owner.seed).status, 201);
    let project = org.create_project(&token, &owner);
    let wraps = vec![org.wrap(&project, 1, &owner.agreement, &owner), org.wrap(&project, 1, &first_recovery, &owner)];
    assert_eq!(org.put_wraps(&token, &wraps).status, 204);
    let count = |recipient: &str| postgres().psql(s.database_url(), &format!("SELECT count(*) FROM wraps WHERE recipient = '{recipient}'"));
    assert_eq!(count(&first_recovery), "1");
    // Replacing the kit drops every wrap to the old recovery key in the same transaction.
    let (r2_seed, r2_secret) = (random_bytes(32), random_bytes(32));
    let body = org.recovery_body(&person, &r2_seed, &r2_secret);
    assert_eq!(org.post(Some(&token), "recovery.set", body, &owner.seed).status, 201);
    assert_eq!(count(&first_recovery), "0");
    // The old kit can no longer sign in.
    let login = org.logins[&person].clone();
    assert_eq!(org.sign_in_with(&r1_seed, json!({"sso": login})).status, 403);
    // A browser that lost its agreement key re-keys its device; the old key's wraps go too.
    let mut rekeyed = owner.clone();
    rekeyed.agreement_secret = random_bytes(32);
    rekeyed.agreement = core::hex(&core::x25519_public(&rekeyed.agreement_secret).unwrap());
    let body = org.device_body(&person, &rekeyed);
    let recovery_token = org.token(&r2_seed);
    assert_eq!(org.post(Some(&recovery_token), "device.add", body, &r2_seed).status, 201);
    assert_eq!(count(&owner.agreement), "0");
    assert_eq!(org.state.devices[&owner.key].agreement, rekeyed.agreement);
    // Low-order agreement keys are refused at registration.
    let mut weak = Device::new();
    weak.agreement = "00".repeat(32);
    let body = org.device_body(&person, &weak);
    assert_eq!(org.post(Some(&token), "device.add", body, &owner.seed).status, 400);
}

#[test]
fn logs_and_membership_are_read_to_an_explicit_head() {
    let env = Env::start("RS256", people(), json!({"entry_inline_bytes": 1024}), json!({}));
    let mut org = Org::create(&env, "alice");
    let owner = org.owner.clone();
    let token = org.token(&owner.seed);
    // More than one page of membership events.
    let mut last = String::new();
    for _ in 0..1005 {
        last = org.create_project(&token, &owner);
    }
    let page = |after: u64| send("GET", &org.url(&format!("/v1/orgs/{}/events?after={after}", org.id)), Some(&token), "", b"").json();
    let first = page(0);
    assert_eq!(first["count"], 1006);
    assert_eq!(first["events"].as_array().unwrap().len(), 1000);
    let second = page(1000);
    assert_eq!(second["events"].as_array().unwrap().len(), 6);
    assert_eq!(page(1006)["events"].as_array().unwrap().len(), 0);
    // Large entries are cut into pages by bytes long before 256 entries; the head says where the log ends.
    for seq in 1..=5u64 {
        let body = entry(&org.id, &last, &owner.seed, seq, 1, &random_bytes(5 * 1024 * 1024));
        assert_eq!(org.append(&token, &last, &body).status, 201);
    }
    let (reply, items) = org.log_page(&token, &last, 0);
    assert_eq!(reply.head.as_deref(), Some("5"));
    assert!(items.len() < 5 && !items.is_empty(), "a byte-limited page: {}", items.len());
    let mut seen = items.len() as u64;
    while seen < 5 {
        let (reply, items) = org.log_page(&token, &last, seen);
        assert_eq!(reply.head.as_deref(), Some("5"));
        assert!(!items.is_empty());
        assert_eq!(items[0].0, seen + 1);
        seen += items.len() as u64;
    }
    let (reply, items) = org.log_page(&token, &last, 5);
    assert_eq!((reply.status, reply.head.as_deref(), items.len()), (200, Some("5"), 0));
}

#[test]
fn sign_in_state_is_bounded_per_organisation_and_per_key() {
    // Request-rate limits are not under test here.
    let env = Env::start("RS256", people(), json!({"requests_per_second": 100000, "source_requests_per_second": 100000}), json!({}));
    let org = Org::create(&env, "alice");
    // An unknown organisation gets no challenge (and no cached state): a deployment serves one.
    let unknown = send("POST", &org.url("/v1/auth/challenge"), None, "application/json", json!({"org": random_hex(32)}).to_string().as_bytes());
    assert_eq!(unknown.status, 404);
    let junk = send("POST", &org.url("/v1/orgs/not-hex/events"), None, "application/json", b"{}");
    assert_eq!(junk.status, 400);
    // One key holds at most eight sessions; the oldest makes room.
    let tokens: Vec<String> = (0..9).map(|_| org.token(&org.owner.seed)).collect();
    let events = |t: &str| send("GET", &org.url(&format!("/v1/orgs/{}/events", org.id)), Some(t), "", b"").status;
    assert_eq!(events(&tokens[0]), 401);
    let rest: Vec<u16> = tokens[1..].iter().map(|t| events(t)).collect();
    assert_eq!(rest, [200; 8]);
    // Unanswered challenges are bounded per organisation.
    let challenge = |id: &str| send("POST", &org.url("/v1/auth/challenge"), None, "application/json", json!({"org": id}).to_string().as_bytes()).status;
    let statuses: Vec<u16> = (0..70).map(|_| challenge(&org.id)).collect();
    assert!(statuses[..64].iter().all(|&s| s == 200));
    assert_eq!(statuses[64..], [503; 6]);
}
