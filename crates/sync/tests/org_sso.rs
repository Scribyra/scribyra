//! Sign-in inside the end-to-end organisation: every device session needs a live login of the
//! device's own person, join requests link the identity, a second browser asks through its
//! sign-in and is added by an existing device, and the provider disabling someone or a sign-out
//! closes their sessions. Real binary, PostgreSQL and the repository's test provider.
mod support;
use scribyra_core::orgsync as core;
use serde_json::{Value, json};
use support::{orgs::*, sso::*, *};

/// A route called with an organisation session token, with a login token instead, or with nothing.
fn call(method: &str, url: &str, auth: Option<&str>) -> u16 {
    let http = support::orgs::agent();
    let mut response = match method {
        "GET" => {
            let mut r = http.get(url);
            if let Some(a) = auth {
                r = r.header("Authorization", a);
            }
            r.call().unwrap()
        }
        _ => {
            let mut r = if method == "PUT" { http.put(url) } else { http.post(url) }.header("Content-Type", "application/json");
            if let Some(a) = auth {
                r = r.header("Authorization", a);
            }
            r.send(b"[]".as_slice()).unwrap()
        }
    };
    let status = response.status().as_u16();
    let _ = response.body_mut().read_to_vec();
    status
}

#[test]
fn no_route_accepts_a_device_key_without_its_persons_login() {
    let env = Env::start("RS256", people(), json!({"requests_per_second": 100000, "source_requests_per_second": 100000}), json!({}));
    let client = env.client();
    let mut org = Org::create(&env, "alice");
    let owner = org.owner.clone();
    let alice = org.logins[&org.owner_person].clone();
    let token = org.token(&owner.seed);
    let project = org.create_project(&token, &owner);
    // A session request without a login is refused; so is an unknown or expired login.
    assert_eq!(org.sign_in_with(&owner.seed, json!({"sso": null})).status, 422);
    assert_eq!(org.sign_in_with(&owner.seed, json!({"sso": random_hex(32)})).status, 401);
    // Someone else's login (not linked to this person) is refused, and so is a login the device
    // did not sign for: the signature covers the login's hash.
    let bob = client.login("bob")["token"].as_str().unwrap().to_owned();
    let refused = org.sign_in_with(&owner.seed, json!({"sso": bob}));
    assert_eq!((refused.status, refused.json()["error"].as_str()), (403, Some("this single sign-on identity is not linked to this member")));
    let c = send("POST", &org.url("/v1/auth/challenge"), None, "application/json", json!({"org": org.id}).to_string().as_bytes()).json();
    let challenge = c["challenge"].as_str().unwrap();
    let signed_for = core::hex(&core::sha256(bob.as_bytes()));
    let sig = owner.sign(scribyra_sync::org::session_message(&org.public, &org.id, &owner.key, &signed_for, challenge).as_bytes());
    let swapped = send("POST", &org.url("/v1/auth/session"), None, "application/json", json!({"org":org.id,"key":owner.key,"challenge":challenge,"sig":sig,"sso":alice}).to_string().as_bytes());
    assert_eq!(swapped.status, 401);
    // A recovery key needs its person's login too.
    let (r_seed, r_secret) = (random_bytes(32), random_bytes(32));
    let body = org.recovery_body(&org.owner_person.clone(), &r_seed, &r_secret);
    assert_eq!(org.post(Some(&token), "recovery.set", body, &owner.seed).status, 201);
    assert_eq!(org.sign_in_with(&r_seed, json!({"sso": null})).status, 422);
    assert_eq!(org.sign_in_with(&r_seed, json!({"sso": bob})).status, 403);
    assert_eq!(org.sign_in_with(&r_seed, json!({})).status, 200);
    // Every organisation route refuses a request without a device session, also one that
    // carries only a login (a login is not a session) or a device signature.
    let o = org.id.clone();
    let routes = [
        ("GET", format!("/v1/orgs/{o}/events")),
        ("GET", format!("/v1/orgs/{o}/keys")),
        ("PUT", format!("/v1/orgs/{o}/keys")),
        ("POST", format!("/v1/orgs/{o}/keys/report")),
        ("GET", format!("/v1/orgs/{o}/pending")),
        ("GET", format!("/v1/orgs/{o}/people")),
        ("GET", format!("/v1/orgs/{o}/heads")),
        ("GET", format!("/v1/orgs/{o}/device-links")),
        ("GET", format!("/v1/projects/{project}/log")),
        ("POST", format!("/v1/projects/{project}/log")),
        ("GET", format!("/v1/projects/{project}/objects/{}", random_hex(32))),
        ("PUT", format!("/v1/projects/{project}/objects/{}?epoch=1", random_hex(32))),
    ];
    let signature = format!("Scribyra {}", owner.sign(b"anything"));
    for (method, path) in &routes {
        let url = org.url(path);
        for auth in [None, Some(format!("ScribyraSSO {alice}")), Some(signature.clone()), Some(format!("Scribyra {}", random_hex(32)))] {
            let status = call(method, &url, auth.as_deref());
            assert!(status == 401 || status == 422 || status == 400, "{method} {path} with {auth:?} answered {status}");
            assert_ne!(status, 200);
        }
        // With the session the same routes answer (or refuse for their own reasons, never 401).
        assert_ne!(call(method, &url, Some(&format!("Scribyra {token}"))), 401, "{method} {path}");
    }
    // Membership events other than a genesis or a join request need a session too.
    let body = json!({"project":random_hex(32),"epoch":1,"keyCommit":random_hex(32)});
    assert_eq!(org.post_login("project.create", body, &owner.seed, &alice).status, 401);
    // The link-code routes are gone.
    assert_eq!(send("POST", &org.url(&format!("/v1/orgs/{o}/device-links")), Some(&token), "application/json", json!({"link":random_hex(16),"key":random_hex(32)}).to_string().as_bytes()).status, 405);
    assert_eq!(send("POST", &org.url(&format!("/v1/orgs/{o}/device-links/{}", random_hex(16))), None, "application/json", b"{}").status, 404);
    // Signing out ends the login and closes the device sessions behind it.
    assert_eq!(client.logout(&alice).status, 200);
    assert_eq!(send("GET", &org.url(&format!("/v1/orgs/{o}/events")), Some(&token), "", b"").status, 401);
    assert_eq!(org.sign_in_with(&owner.seed, json!({})).status, 401);
}

#[test]
fn joins_link_identities_device_requests_and_blocking() {
    let env = Env::start("RS256", people(), json!({"sso_recheck_tick_seconds": 1, "requests_per_second": 100000, "source_requests_per_second": 100000}), json!({"provider": {"offline_access": true}}));
    let client = env.client();
    let s = &env.service;
    let mut org = Org::create(&env, "alice");
    let owner = org.owner.clone();
    let token = org.token(&owner.seed);

    // Bob asks to join: pending, no session, until an admin approves; then his identity is his.
    let bob = Device::new();
    assert_eq!(org.request(&client, "bob", &bob).status, 201);
    let bob_login = org.logins[&org.person(&bob)].clone();
    assert_eq!(org.sign_in_with(&bob.seed, json!({})).status, 403);
    let me = client.me(&bob_login).json();
    assert_eq!((me["state"].as_str(), me["person"].as_str(), me["role"].as_str()), (Some("linked"), Some(org.person(&bob).as_str()), Some("member")));
    assert_eq!(postgres().psql(s.database_url(), "SELECT count(*) FROM sso_links WHERE subject = 'sub-bob'"), "1");
    assert_eq!(org.post(Some(&token), "person.approve", json!({"person":org.person(&bob),"role":"member"}), &owner.seed).status, 201);
    let bob_session = org.sign_in_with(&bob.seed, json!({}));
    assert_eq!(bob_session.status, 200);
    let bob_token = bob_session.json()["token"].as_str().unwrap().to_string();
    // The member directory shows the email each person signed in with (names in the log are sealed).
    let people = send("GET", &org.url(&format!("/v1/orgs/{}/people", org.id)), Some(&bob_token), "", b"").json();
    assert_eq!(people["people"][org.person(&bob)]["email"], "bob@other.org");
    assert_eq!(people["people"][org.owner_person.clone()]["email"], "alice@example.org");

    // A second browser of Bob's signs in and asks to be added; his first device approves it.
    let laptop = Device::new();
    let link = random_hex(16);
    let bob_person = org.person(&bob);
    let proof = laptop.sign(&core::device_proof_message(&org.id, &core::link_binding(&link), &bob_person, &laptop.key, &laptop.agreement));
    let laptop_login = client.login("bob")["token"].as_str().unwrap().to_owned();
    let url = org.url(&format!("/v1/orgs/{}/device-links/sso", org.id));
    let request = json!({"link":link,"device":laptop.key,"agreement":laptop.agreement,"proof":proof,"mac":random_hex(32)});
    let mut response = orgs::agent().post(&url).header("Content-Type", "application/json").header("Authorization", &format!("ScribyraSSO {laptop_login}")).send(request.to_string().as_bytes()).unwrap();
    assert_eq!(response.status().as_u16(), 202, "{}", response.body_mut().read_to_string().unwrap());
    // Without a login, or with someone else's identity, nobody can ask on Bob's behalf.
    assert_eq!(send("POST", &url, None, "application/json", request.to_string().as_bytes()).status, 401);
    let carol = client.login("carol")["token"].as_str().unwrap().to_owned();
    let mut response = orgs::agent().post(&url).header("Content-Type", "application/json").header("Authorization", &format!("ScribyraSSO {carol}")).send(request.to_string().as_bytes()).unwrap();
    assert_eq!(response.status().as_u16(), 403);
    let _ = response.body_mut().read_to_vec();
    let listed = send("GET", &org.url(&format!("/v1/orgs/{}/device-links", org.id)), Some(&bob_token), "", b"").json();
    let waiting = &listed["links"][0]["request"];
    assert_eq!((waiting["via"].as_str(), waiting["device"].as_str()), (Some("sso"), Some(laptop.key.as_str())));
    // The new browser cannot sign in before it is added.
    assert_eq!(org.sign_in_with(&laptop.seed, json!({"sso": laptop_login})).status, 403);
    let body = json!({"person":bob_person,"device":laptop.key,"agreement":laptop.agreement,"proof":waiting["proof"],"link":link});
    assert_eq!(org.post(Some(&bob_token), "device.add", body.clone(), &bob.seed).status, 201);
    assert_eq!(org.sign_in_with(&laptop.seed, json!({"sso": laptop_login})).status, 200);
    assert_eq!(send("GET", &org.url(&format!("/v1/orgs/{}/device-links", org.id)), Some(&bob_token), "", b"").json()["links"], json!([]));
    // A request is used once.
    assert_eq!(org.post(Some(&bob_token), "device.add", body, &bob.seed).status, 400);
    // Removing the device closes its sessions.
    let laptop_token = org.sign_in_with(&laptop.seed, json!({"sso": laptop_login})).json()["token"].as_str().unwrap().to_string();
    assert_eq!(org.post(Some(&bob_token), "device.remove", json!({"device":laptop.key}), &bob.seed).status, 201);
    assert_eq!(send("GET", &org.url(&format!("/v1/orgs/{}/events", org.id)), Some(&laptop_token), "", b"").status, 401);

    // The provider disables Bob: at the next recheck his sessions close and sign-in is refused.
    assert_eq!(env.idp.control("disable?user=bob").status, 200);
    let events = org.url(&format!("/v1/orgs/{}/events", org.id));
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(30);
    while send("GET", &events, Some(&bob_token), "", b"").status != 401 {
        assert!(std::time::Instant::now() < deadline, "Bob's session survived the provider disabling him");
        // Time passes: every login is due for its recheck.
        postgres().psql(s.database_url(), "UPDATE sso_logins SET checked = now() - interval '1 day' WHERE NOT revoked");
        std::thread::sleep(std::time::Duration::from_millis(250));
    }
    let blocked = org.sign_in_with(&bob.seed, json!({}));
    assert!(blocked.status == 401 || blocked.status == 403, "{}", blocked.status);
    // Signing in again does not help while the link is blocked.
    assert_eq!(client.login("alice")["state"], "linked");
    // Others are unaffected.
    assert_eq!(send("GET", &events, Some(&org.token(&owner.seed)), "", b"").status, 200);
}

#[test]
fn unverified_emails_are_never_shown_as_identities() {
    // Review H1: a provider may send any `email` with `email_verified: false`; it must not appear
    // as the person's identity to the administrator who approves them, or anywhere else.
    let mut users = people();
    users.as_array_mut().unwrap().push(json!({"sub": "sub-mimic", "username": "mimic", "password": "pw-mimic", "email": "ceo@example.org", "email_verified": false, "name": "Not the CEO"}));
    let env = Env::start("RS256", users, json!({}), json!({}));
    let client = env.client();
    let mut org = Org::create(&env, "alice");
    let owner = org.owner.clone();
    let token = org.token(&owner.seed);
    let mimic = Device::new();
    assert_eq!(org.request(&client, "mimic", &mimic).status, 201);
    let people = send("GET", &org.url(&format!("/v1/orgs/{}/people", org.id)), Some(&token), "", b"").json();
    let entry = &people["people"][org.person(&mimic)];
    assert_eq!((entry["email"].clone(), entry["provider"].as_str(), entry["providerLabel"].as_str()), (Value::Null, Some("test"), Some("Test account")));
    assert_eq!(people["people"][org.owner_person.clone()]["email"], "alice@example.org");
    assert_eq!(postgres().psql(env.service.database_url(), "SELECT count(*) FROM sso_links WHERE email = 'ceo@example.org'"), "0");
    let me = client.me(&org.logins[&org.person(&mimic)]).json();
    assert_eq!(me["email"], Value::Null);
}

#[test]
fn one_client_cannot_use_up_the_session_challenges() {
    // Review M2: 64 open challenges per organisation for a minute let one source lock every
    // device out. Each source now holds a few, replacing its own oldest.
    let env = Env::start("RS256", people(), json!({"requests_per_second": 100000, "source_requests_per_second": 100000}), json!({}));
    let org = Org::create(&env, "alice");
    let challenge = |ip: &str| {
        let (status, reply) = post_from(ip, &org.url("/v1/auth/challenge"), &json!({"org": org.id}));
        assert_eq!(status, 200);
        reply["challenge"].as_str().unwrap().to_owned()
    };
    for _ in 0..200 {
        challenge("127.0.0.66");
    }
    let mine = challenge("127.0.0.7");
    for _ in 0..200 {
        challenge("127.0.0.66");
    }
    // The other client's challenge is still open: a session attempt reaches the signature check.
    let attempt = json!({"org": org.id, "key": org.owner.key, "challenge": mine, "sig": "00".repeat(64), "sso": random_hex(32)});
    let reply = support::sr::request("POST", &org.url("/v1/auth/session"), None, &[("Content-Type", "application/json".into())], attempt.to_string().into_bytes());
    assert_eq!((reply.status, reply.json()["error"].as_str()), (401, Some("invalid signature")));
}

#[test]
fn identity_links_commit_with_their_membership_events() {
    // Review L1 and L2: a join request's link used to be written before its event committed (a
    // failed event left the identity linked to a person who never joined), and a removal's
    // unlink ran after commit with its failure ignored. Both now share the event's transaction.
    let env = Env::start("RS256", people(), json!({}), json!({}));
    let client = env.client();
    let db = env.service.database_url().to_owned();
    let mut org = Org::create(&env, "alice");
    let owner = org.owner.clone();
    let token = org.token(&owner.seed);
    // The event's insert fails: no link remains, and the same identity can ask again later.
    postgres().psql(&db, "CREATE FUNCTION refuse() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'refused'; END $$; CREATE TRIGGER refuse BEFORE INSERT ON org_events FOR EACH ROW EXECUTE FUNCTION refuse()");
    let first = Device::new();
    assert_eq!(org.request(&client, "ben", &first).status, 500);
    assert_eq!(postgres().psql(&db, "SELECT count(*) FROM sso_links WHERE subject = 'sub-ben'"), "0");
    postgres().psql(&db, "DROP TRIGGER refuse ON org_events");
    let second = Device::new();
    assert_eq!(org.request(&client, "ben", &second).status, 201);
    assert_eq!(postgres().psql(&db, "SELECT count(*) FROM sso_links WHERE subject = 'sub-ben'"), "1");
    assert_eq!(org.post(Some(&token), "person.approve", json!({"person": org.person(&second), "role": "member"}), &owner.seed).status, 201);
    // The unlink fails: the removal does not happen either (it used to commit and keep the link).
    postgres().psql(&db, "CREATE TRIGGER refuse BEFORE DELETE ON sso_links FOR EACH ROW EXECUTE FUNCTION refuse()");
    let events = postgres().psql(&db, "SELECT count(*) FROM org_events");
    assert_eq!(org.post(Some(&token), "person.remove", json!({"person": org.person(&second)}), &owner.seed).status, 500);
    assert_eq!(postgres().psql(&db, "SELECT count(*) FROM org_events"), events);
    postgres().psql(&db, "DROP TRIGGER refuse ON sso_links");
    // The service reloads its state after the failure; the removal then goes through with its unlink.
    let reply = org.post(Some(&token), "person.remove", json!({"person": org.person(&second)}), &owner.seed);
    assert_eq!(reply.status, 201, "{}", String::from_utf8_lossy(&reply.body));
    assert_eq!(postgres().psql(&db, "SELECT count(*) FROM sso_links WHERE subject = 'sub-ben'"), "0");
}
