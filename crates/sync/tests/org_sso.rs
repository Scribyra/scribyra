//! Single sign-on inside organisations: SSO-bound invitations and join requests, account
//! linking, orgs that require SSO for device sessions, blocking when the identity provider
//! disables someone, and linking a new browser through SSO. Real binary, PostgreSQL and the
//! repository's test identity provider.
mod support;
use scribyra_core::orgsync as core;
use serde_json::json;
use support::{orgs::*, sso::*, *};

fn sso_header(token: &str) -> String {
    format!("ScribyraSSO {token}")
}
/// Posts an event authenticated by an SSO login instead of a device session.
fn post_with_sso(org: &mut Org, kind: &str, body: serde_json::Value, seed: &[u8], sso: &str) -> u16 {
    let raw = sign_event(&org.id, &org.state.head.clone(), kind, body, seed);
    let mut response = orgs::agent().post(&org.url(&format!("/v1/orgs/{}/events", org.id))).header("Content-Type", "application/json").header("Authorization", &sso_header(sso)).send(raw.as_bytes()).unwrap();
    let status = response.status().as_u16();
    let _ = response.body_mut().read_to_string();
    if status == 201 {
        org.state.apply(&raw, None).unwrap();
    }
    status
}

#[test]
fn sso_joins_linking_required_sessions_blocking_and_device_requests() {
    let s = Service::new(org_overrides(json!({"origins": [APP], "sso_recheck_tick_seconds": 1, "requests_per_second": 100000, "source_requests_per_second": 100000})));
    let mut org = Org::create(&s, &[], json!({}));
    let idp = Idp::start("RS256", &org.public, default_users());
    let (code, out) = configure(&s, &org.id, &idp, &["--offline-access"]);
    assert_eq!(code, 0, "{out}");
    let sso = Client { base: s.url.clone(), org: org.id.clone(), idp: &idp };
    let owner = org.owner.clone();
    let token = org.token(&owner.seed);
    let token_of = |login: &serde_json::Value| login["token"].as_str().unwrap().to_string();

    // An invitation bound to SSO and to Alice's verified email.
    let email_hash = core::hex(&core::sha256(b"alice@example.org"));
    let (reply, invite, seed) = org.invite(&token, &owner, json!({"sso": true, "emailHash": email_hash}));
    assert_eq!(reply.status, 201);
    let alice = Device::new();
    assert_eq!(org.join(&alice, &invite, &seed).status, 403, "no SSO login");
    let bob_login = sso.login("bob");
    let body = org.join_body(&alice, &invite, &seed);
    assert_eq!(post_with_sso(&mut org, "person.join", body, &alice.seed, &token_of(&bob_login)), 403, "another email");
    let alice_login = sso.login("alice");
    let body = org.join_body(&alice, &invite, &seed);
    assert_eq!(post_with_sso(&mut org, "person.join", body, &alice.seed, &token_of(&alice_login)), 201);
    let me = sso.me(&token_of(&alice_login)).json();
    assert_eq!((me["state"].as_str(), me["person"].as_str()), (Some("linked"), Some(org.person(&alice).as_str())));

    // Bob asks to join through SSO alone: pending, no session, until an admin approves.
    let bob = Device::new();
    let bob_person = org.person(&bob);
    let request = |org: &Org, d: &Device| {
        let person = org.person(d);
        let proof = d.sign(&core::device_proof_message(&org.id, &org.state.head, &person, &d.key, &d.agreement));
        json!({"person":person,"device":d.key,"agreement":d.agreement,"proof":proof,"name":random_hex(60)})
    };
    let body = request(&org, &bob);
    assert_eq!(org.post(None, "person.request", body, &bob.seed).status, 403);
    let body = request(&org, &bob);
    assert_eq!(post_with_sso(&mut org, "person.request", body, &bob.seed, &token_of(&bob_login)), 201);
    assert_eq!(org.sign_in_with(&bob.seed, json!({})).status, 403);
    // The same identity cannot ask twice under another device.
    let again = Device::new();
    let body = request(&org, &again);
    assert_eq!(post_with_sso(&mut org, "person.request", body, &again.seed, &token_of(&bob_login)), 409);
    assert_eq!(org.post(Some(&token), "person.approve", json!({"person":bob_person,"role":"member"}), &owner.seed).status, 201);
    assert_eq!(org.sign_in_with(&bob.seed, json!({})).status, 200);

    // Now the org requires SSO: device keys alone no longer open a session.
    let (code, out) = configure(&s, &org.id, &idp, &["--offline-access", "--required"]);
    assert_eq!(code, 0, "{out}");
    let refused = org.sign_in_with(&owner.seed, json!({}));
    assert_eq!((refused.status, refused.json()["error"].as_str()), (401, Some("single sign-on is required")));
    // The owner joined before SSO: the first sign-in with both links them (trust on first use).
    let dave_login = sso.login("dave");
    assert_eq!(org.sign_in_with(&owner.seed, json!({"sso": token_of(&dave_login)})).status, 200);
    // An SSO identity belongs to one person only.
    assert_eq!(org.sign_in_with(&alice.seed, json!({"sso": token_of(&dave_login)})).status, 403);
    let alice_session = org.sign_in_with(&alice.seed, json!({"sso": token_of(&alice_login)}));
    assert_eq!(alice_session.status, 200);
    let alice_token = alice_session.json()["token"].as_str().unwrap().to_string();

    // A second browser of Alice's asks through SSO; her first device compares and approves.
    let laptop = Device::new();
    let link = random_hex(16);
    let alice_person = org.person(&alice);
    let proof = laptop.sign(&core::device_proof_message(&org.id, &core::link_binding(&link), &alice_person, &laptop.key, &laptop.agreement));
    let url = org.url(&format!("/v1/orgs/{}/device-links/sso", org.id));
    let laptop_login = sso.login("alice");
    let mut response = orgs::agent().post(&url).header("Content-Type", "application/json").header("Authorization", &sso_header(&token_of(&laptop_login))).send(json!({"link":link,"device":laptop.key,"agreement":laptop.agreement,"proof":proof}).to_string().as_bytes()).unwrap();
    assert_eq!(response.status().as_u16(), 202, "{}", response.body_mut().read_to_string().unwrap());
    let listed = send("GET", &org.url(&format!("/v1/orgs/{}/device-links", org.id)), Some(&alice_token), "", b"").json();
    let waiting = &listed["links"][0]["request"];
    assert_eq!((waiting["via"].as_str(), waiting["device"].as_str()), (Some("sso"), Some(laptop.key.as_str())));
    let body = json!({"person":alice_person,"device":laptop.key,"agreement":laptop.agreement,"proof":waiting["proof"],"link":link});
    assert_eq!(org.post(Some(&alice_token), "device.add", body, &alice.seed).status, 201);
    assert_eq!(org.sign_in_with(&laptop.seed, json!({"sso": token_of(&laptop_login)})).status, 200);

    // The identity provider disables Alice: her sessions close and sign-in is refused.
    postgres().psql(s.database_url(), "UPDATE org_sso SET recheck_seconds = 1");
    assert_eq!(idp.control("disable?user=alice").status, 200);
    let events = org.url(&format!("/v1/orgs/{}/events", org.id));
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(30);
    while send("GET", &events, Some(&alice_token), "", b"").status != 401 {
        assert!(std::time::Instant::now() < deadline, "Alice's session survived the IdP disabling her");
        std::thread::sleep(std::time::Duration::from_millis(250));
    }
    let blocked = org.sign_in_with(&alice.seed, json!({"sso": token_of(&alice_login)}));
    assert!(blocked.status == 401 || blocked.status == 403, "{}", blocked.status);
    // Others are unaffected.
    assert_eq!(org.sign_in_with(&bob.seed, json!({"sso": token_of(&bob_login)})).status, 200);
    // A login for this org is useless in another org on the same service.
    let other = Org::create(&s, &[], json!({}));
    assert_eq!(other.sign_in_with(&other.owner.seed, json!({"sso": token_of(&bob_login)})).status, 403);
}
