//! OIDC single sign-on end to end: the real service binary against real PostgreSQL and the
//! real `test-idp` example provider (see `support/sso.rs` for how it is built), driven without
//! a browser. One in-process test uses the library directly to observe the revocation hook.
mod support;
use serde_json::{Value, json};
use std::time::{Duration, Instant};
use support::sso::*;
use support::*;

struct Env {
    service: Service,
    idp: Idp,
    org: String,
}
impl Env {
    fn new(alg: &str, sso_flags: &[&str], extra: Value) -> Env {
        let mut overrides = json!({"origins": [APP], "sso_jwks_refetch_seconds": 0});
        for (k, v) in extra.as_object().unwrap() {
            overrides[k] = v.clone();
        }
        let service = Service::new(orgs::org_overrides(overrides));
        let idp = Idp::start(alg, service.config["public_url"].as_str().unwrap(), default_users());
        let org = create_org(&service);
        let (code, out) = configure(&service, &org, &idp, sso_flags);
        assert_eq!(code, 0, "{out}");
        Env { service, idp, org }
    }
    fn client(&self) -> Client<'_> {
        Client { base: self.service.url.clone(), org: self.org.clone(), idp: &self.idp }
    }
}

#[test]
fn rs256_sign_in_me_logout_and_replays() {
    let env = Env::new("RS256", &["--groups-claim", "groups"], json!({}));
    let c = env.client();
    let policy = fetch(&c.url(&format!("/v1/orgs/{}/sso", env.org)), None);
    assert_eq!(policy.json(), json!({"enabled": true, "required": false, "issuer": env.idp.issuer}));

    let started = c.start();
    assert!(started.url.starts_with(&format!("{}/authorize?", env.idp.issuer)));
    let query: std::collections::HashMap<String, String> = url::Url::parse(&started.url).unwrap().query_pairs().into_owned().collect();
    assert_eq!(query["scope"], "openid email profile");
    assert_eq!(query["code_challenge_method"], "S256");
    assert_eq!(query["redirect_uri"], format!("{}/v1/sso/callback", env.service.config["public_url"].as_str().unwrap()));
    let callback = c.authorize(&started, "alice", "pw-alice");
    let (status, outcome) = c.callback(&callback);
    assert_eq!(status, 302);
    let Some(Outcome::Grant { grant, org }) = outcome else { panic!("{outcome:?}") };
    assert_eq!(org, env.org);
    // The state is single use.
    let (status, outcome) = c.callback(&callback);
    assert_eq!((status, outcome), (400, None));

    let login = c.redeem(&grant, &started.verifier).json();
    assert_eq!(login["org"], env.org);
    assert_eq!(login["state"], "unlinked");
    assert_eq!(login["person"], Value::Null);
    assert_eq!(login["subject"], json!({"email": "alice@example.org", "name": "Alice Example", "groups": ["staff", "admins"]}));
    let token = login["token"].as_str().unwrap().to_owned();
    assert_eq!(token.len(), 64);
    let expires = login["expires"].as_u64().unwrap();
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_secs();
    assert!((now + 12 * 3600 - 60..=now + 12 * 3600 + 60).contains(&expires), "{expires}");
    // The grant is single use.
    assert_eq!(c.redeem(&grant, &started.verifier).status, 401);
    // Only the token's hash is stored.
    let pg = postgres();
    let hashes = pg.psql(env.service.database_url(), "SELECT token_hash FROM sso_logins");
    assert_eq!(hashes, sha256(token.as_bytes()));
    assert!(!pg.psql(env.service.database_url(), "SELECT count(*) FROM sso_logins WHERE refresh_token IS NOT NULL").starts_with('0'));

    let me = c.me(&token);
    assert_eq!(me.status, 200);
    let mut without_token = login.clone();
    without_token.as_object_mut().unwrap().remove("token");
    assert_eq!(me.json(), without_token);
    assert_eq!(c.me(&"0".repeat(64)).status, 401);
    assert_eq!(fetch(&c.url("/v1/sso/me"), None).status, 401);
    assert_eq!(c.logout(&token).status, 200);
    assert_eq!(c.me(&token).status, 401);
    assert_eq!(c.logout(&token).status, 401);

    // Nothing secret reaches the service's logs: client secret, tokens, codes, emails.
    std::thread::sleep(Duration::from_millis(200));
    let logs = env.service.logs.lock().unwrap().clone();
    assert!(logs.contains("sso_login"), "{logs}");
    let code = url::Url::parse(&callback).unwrap().query_pairs().find(|(k, _)| k == "code").unwrap().1.into_owned();
    for secret in [env.idp.secret.as_str(), &token, &grant, &code, &started.verifier, "alice@example.org", "Alice Example", &query["state"], &query["nonce"]] {
        assert!(!logs.contains(secret), "service log contains a secret value");
    }
    assert!(!logs.contains("eyJ"), "service log contains a JWT");
}

#[test]
fn es256_and_eddsa_sign_in() {
    for alg in ["ES256", "EdDSA"] {
        let env = Env::new(alg, &[], json!({}));
        let c = env.client();
        let login = c.login("alice");
        assert_eq!(login["subject"]["email"], "alice@example.org");
        // No groups claim configured: groups are not read.
        assert_eq!(login["subject"]["groups"], json!([]));
        assert_eq!(c.me(login["token"].as_str().unwrap()).status, 200);
    }
}

#[test]
fn every_defective_id_token_is_refused() {
    let env = Env::new("RS256", &["--email-domain", "example.org"], json!({}));
    let c = env.client();
    // Each fault must be refused for its own reason (the service logs a fixed reason code).
    let faults = [
        ("bad_signature", "jws_signature"),
        ("wrong_aud", "claim_aud"),
        ("wrong_iss", "claim_iss"),
        ("wrong_nonce", "claim_nonce"),
        ("expired", "claim_exp"),
        ("alg_none", "jws_algorithm"),
        ("alg_hs256", "jws_algorithm"),
        ("unknown_kid", "jws_unknown_key"),
        ("no_kid_multi_key", "jws_ambiguous_key"),
        ("email_unverified", "claim_email"),
    ];
    let count = |reason: &str| env.service.logs.lock().unwrap().matches(&format!("\"reason\":\"{reason}\"")).count();
    for (kind, reason) in faults {
        let before = count(reason);
        assert_eq!(env.idp.control(&format!("fault?kind={kind}")).status, 200);
        let (outcome, _) = c.sign_in("alice");
        let Outcome::Error(code) = &outcome else { panic!("{kind} was accepted") };
        let expected = if kind == "email_unverified" { "email_unverified" } else { "id_token" };
        assert_eq!(code, expected, "{kind}");
        let deadline = Instant::now() + Duration::from_secs(5);
        while count(reason) == before {
            assert!(Instant::now() < deadline, "{kind} was not refused as {reason}");
            std::thread::sleep(Duration::from_millis(20));
        }
    }
    // The faults were one-shot: a clean token is accepted again.
    c.login("alice");
    assert_eq!(postgres().psql(env.service.database_url(), "SELECT count(*) FROM sso_logins"), "1");
}

#[test]
fn verifier_return_origin_and_request_checks() {
    let env = Env::new("EdDSA", &[], json!({}));
    let c = env.client();
    // A wrong verifier is refused and burns the grant.
    let (outcome, verifier) = c.sign_in("alice");
    let Outcome::Grant { grant, .. } = outcome else { panic!() };
    let wrong: String = random_hex(32);
    assert_eq!(c.redeem(&grant, &wrong).status, 401);
    assert_eq!(c.redeem(&grant, &verifier).status, 401);
    // The challenge must be a SHA-256 of the 32 verifier bytes, not of their hex text.
    let raw = random_bytes(32);
    let hex_text: String = raw.iter().map(|b| format!("{b:02x}")).collect();
    let reply = c.start_with(&env.org, APP, &sha256(hex_text.as_bytes()));
    let url = reply.json()["url"].as_str().unwrap().to_owned();
    let callback = c.authorize(&Started { url, verifier: hex_text.clone() }, "alice", "pw-alice");
    let Some(Outcome::Grant { grant, .. }) = c.callback(&callback).1 else { panic!() };
    assert_eq!(c.redeem(&grant, &hex_text).status, 401);
    // Return origins must be configured; other request errors.
    assert_eq!(c.start_with(&env.org, "https://evil.example", &sha256(&raw)).status, 400);
    assert_eq!(c.start_with(&env.org, &format!("{APP}/"), &sha256(&raw)).status, 400);
    assert_eq!(c.start_with(&env.org, APP, "not-hex").status, 400);
    assert_eq!(c.start_with(&random_hex(32), APP, &sha256(&raw)).status, 404);
    assert_eq!(post_json(&c.url("/v1/sso/start"), None, &json!({"org": env.org, "return": APP, "challenge": sha256(&raw), "extra": 1})).status, 422);
    // An unknown state is not redirected anywhere.
    let reply = fetch(&c.url(&format!("/v1/sso/callback?code=x&state={}", random_hex(32))), None);
    assert_eq!((reply.status, reply.location), (400, None));
    // A provider error goes back to the app as a fixed code; its text is not reflected.
    let started = c.start();
    let state = url::Url::parse(&started.url).unwrap().query_pairs().find(|(k, _)| k == "state").unwrap().1.into_owned();
    let reply = fetch(&c.url(&format!("/v1/sso/callback?error=access_denied&error_description=%3Cscript%3E&state={state}")), None);
    assert_eq!(reply.location.as_deref(), Some(format!("{APP}/#scribyra-sso-error=idp_error").as_str()));
    // A wrong password at the provider never reaches a grant.
    let started = c.start();
    let reply = fetch(&format!("{}&login_hint=alice&test_password=nope", started.url), None);
    let back = reply.location.unwrap();
    assert!(back.contains("error=access_denied"));
    assert_eq!(c.callback(&back).1, Some(Outcome::Error("idp_error".into())));
    // An unknown or unconfigured organisation.
    assert_eq!(fetch(&c.url(&format!("/v1/orgs/{}/sso", random_hex(32))), None).status, 404);
    assert_eq!(fetch(&c.url("/v1/orgs/nothex/sso"), None).status, 400);
    let other = create_org(&env.service);
    assert_eq!(fetch(&c.url(&format!("/v1/orgs/{other}/sso")), None).json(), json!({"enabled": false, "required": false, "issuer": null}));
    assert_eq!(c.start_with(&other, APP, &sha256(&raw)).status, 404);
}

#[test]
fn email_domain_restriction() {
    let env = Env::new("ES256", &["--email-domain", "Example.org", "--required"], json!({}));
    let c = env.client();
    assert_eq!(fetch(&c.url(&format!("/v1/orgs/{}/sso", env.org)), None).json()["required"], true);
    assert_eq!(c.sign_in("bob").0, Outcome::Error("email_domain".into()));
    assert_eq!(c.sign_in("carol").0, Outcome::Error("email_unverified".into()));
    assert_eq!(c.sign_in("dave").0, Outcome::Error("email_domain".into()));
    assert_eq!(c.login("alice")["subject"]["email"], "alice@example.org");
}

#[test]
fn key_rotation_needs_a_jwks_refetch_at_most_once_per_interval() {
    let env = Env::new("RS256", &[], json!({"sso_jwks_refetch_seconds": 4}));
    let c = env.client();
    c.login("alice");
    assert_eq!(env.idp.control("rotate").json()["kid"], "rsa-2");
    // The cached key set was fetched moments ago: no refetch yet, so the new kid is unknown.
    let fetched = Instant::now();
    assert_eq!(c.sign_in("alice").0, Outcome::Error("id_token".into()));
    std::thread::sleep(Duration::from_secs(4).saturating_sub(fetched.elapsed()) + Duration::from_millis(500));
    c.login("alice");
    // After the old key is dropped the new key keeps working.
    let env2 = Env::new("EdDSA", &[], json!({}));
    let c2 = env2.client();
    c2.login("alice");
    env2.idp.control("rotate?drop=1");
    c2.login("alice");
}

#[test]
fn backchannel_logout_revokes_logins() {
    let env = Env::new("RS256", &[], json!({}));
    let c = env.client();
    let alice = c.login("alice")["token"].as_str().unwrap().to_owned();
    let bob = c.login("bob")["token"].as_str().unwrap().to_owned();
    let reply = env.idp.control("backchannel?user=alice");
    assert_eq!(reply.json()["statuses"], json!([200]));
    assert_eq!(c.me(&alice).status, 401);
    assert_eq!(c.me(&bob).status, 200);
    // A forged logout token (unsigned) is refused.
    let forged = format!("{}.{}.", b64(&json!({"alg":"none"})), b64(&json!({"iss": env.idp.issuer, "aud": CLIENT_ID, "iat": 0, "jti": "j", "sub": "sub-bob", "events": {"http://schemas.openid.net/event/backchannel-logout": {}}})));
    let reply = agent().post(&c.url("/v1/sso/backchannel")).send_form([("logout_token", forged.as_str())]).unwrap();
    assert_eq!(reply.status().as_u16(), 400);
    assert_eq!(c.me(&bob).status, 200);
    // A logout token naming an unconfigured issuer is refused without contacting it.
    let trap = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    trap.set_nonblocking(true).unwrap();
    let iss = format!("http://{}", trap.local_addr().unwrap());
    let probe = format!("{}.{}.{}", b64(&json!({"alg":"RS256","kid":"rsa-1"})), b64(&json!({"iss": iss, "aud": CLIENT_ID, "iat": 0, "jti": "j", "sub": "sub-bob"})), "AAAA");
    let reply = agent().post(&c.url("/v1/sso/backchannel")).send_form([("logout_token", probe.as_str())]).unwrap();
    assert_eq!(reply.status().as_u16(), 400);
    std::thread::sleep(Duration::from_millis(300));
    assert!(trap.accept().is_err_and(|e| e.kind() == std::io::ErrorKind::WouldBlock), "the service contacted an unconfigured issuer");
}
fn b64(value: &Value) -> String {
    use base64::Engine;
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(value.to_string())
}

#[test]
fn discovery_issuer_must_match_exactly() {
    let service = Service::new(orgs::org_overrides(json!({"origins": [APP]})));
    let idp = Idp::start("RS256", service.config["public_url"].as_str().unwrap(), default_users());
    let org = create_org(&service);
    // Same provider, but configured with a trailing slash: the document's issuer differs.
    let secret = idp.secret_file();
    let issuer = format!("{}/", idp.issuer);
    let (code, _) = service.run(&["org", "sso", "--org", &org, "--issuer", &issuer, "--client-id", CLIENT_ID, "--client-secret-file", secret.to_str().unwrap()]);
    assert_eq!(code, 0);
    let c = Client { base: service.url.clone(), org: org.clone(), idp: &idp };
    assert_eq!(c.start_with(&org, APP, &sha256(&random_bytes(32))).status, 502);
    assert!(service.logs.lock().unwrap().contains("discovery_issuer"));
}

#[test]
fn sso_command_validation_and_off() {
    let service = Service::new(orgs::org_overrides(json!({"origins": [APP]})));
    let idp = Idp::start("RS256", service.config["public_url"].as_str().unwrap(), default_users());
    let org = create_org(&service);
    let secret = idp.secret_file();
    let secret = secret.to_str().unwrap();
    let run = |args: &[&str]| service.run(&[&["org", "sso"], args].concat());
    assert_ne!(run(&["--org", &org, "--issuer", "http://idp.example.org", "--client-id", "c", "--client-secret-file", secret]).0, 0);
    assert_ne!(run(&["--org", &org, "--issuer", "https://idp.example.org/?x=1", "--client-id", "c", "--client-secret-file", secret]).0, 0);
    assert_ne!(run(&["--org", &random_hex(32), "--issuer", "https://idp.example.org", "--client-id", "c", "--client-secret-file", secret]).0, 0);
    assert_ne!(run(&["--org", &org, "--issuer", "https://idp.example.org", "--client-id", "c"]).0, 0);
    assert_ne!(run(&["--org", &org, "--issuer", "https://idp.example.org", "--client-id", "c", "--client-secret-file", "/nonexistent"]).0, 0);
    assert_ne!(run(&["--org", &org, "--issuer", "https://idp.example.org", "--client-id", "c", "--client-secret-file", secret, "--session-hours", "0"]).0, 0);
    assert_ne!(run(&["--org", &org, "--off", "--required"]).0, 0);
    let (code, out) = run(&["--org", &org, "--issuer", "https://login.example.org/realms/lab", "--client-id", "c", "--client-secret-file", secret, "--required", "--email-domain", "example.org", "--session-hours", "8", "--recheck-minutes", "5", "--offline-access"]);
    assert_eq!(code, 0);
    assert!(!out.contains(&idp.secret));
    let printed: Value = serde_json::from_str(out.trim()).unwrap();
    assert_eq!(printed["redirect_uri"], format!("{}/v1/sso/callback", service.config["public_url"].as_str().unwrap()));
    let db = service.database_url();
    assert_eq!(postgres().psql(db, "SELECT session_seconds, recheck_seconds, scopes, client_secret = '' FROM org_sso"), "28800|300|openid email profile offline_access|f");
    // offline_access is requested when configured.
    let (code, _) = configure(&service, &org, &idp, &["--offline-access"]);
    assert_eq!(code, 0);
    let c = Client { base: service.url.clone(), org: org.clone(), idp: &idp };
    let query: std::collections::HashMap<String, String> = url::Url::parse(&c.start().url).unwrap().query_pairs().into_owned().collect();
    assert_eq!(query["scope"], "openid email profile offline_access");
    let token = c.login("alice")["token"].as_str().unwrap().to_owned();
    assert_eq!(run(&["--org", &org, "--off"]).0, 0);
    assert_eq!(fetch(&c.url(&format!("/v1/orgs/{org}/sso")), None).json()["enabled"], false);
    // Turning SSO off ends its logins.
    assert_eq!(c.me(&token).status, 401);
}

/// The library in-process: the background recheck keeps a login while the provider accepts
/// its (rotating) refresh token, then revokes it, blocks the link and fires the revocation
/// hook once the user is disabled at the provider. Also logout, linking and org isolation.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn recheck_revokes_disabled_users_and_fires_the_hook() {
    use scribyra_sync::{config::Config, listener, service, sso::LinkError, store::Store};
    use std::sync::Arc;
    let port = free_port();
    let public = format!("http://127.0.0.1:{port}");
    let dir = temp_dir("scribyra-sso-lib-");
    let config = Config {
        bind: format!("127.0.0.1:{port}").parse().unwrap(),
        data: dir.join("data"),
        database_url: Some(tokio::task::spawn_blocking(|| postgres().database()).await.unwrap()),
        origins: vec![APP.into()],
        public_url: Some(public.clone()),
        sso_recheck_tick_seconds: 1,
        sso_jwks_refetch_seconds: 0,
        ..Config::default()
    };
    config.validate().unwrap();
    let store = Store::open(config.clone()).await.unwrap();
    let s = service::state(store);
    let app = service::router(s.clone());
    let tcp = tokio::net::TcpListener::bind(config.bind).await.unwrap();
    tokio::spawn(axum::serve(listener::Listener { tcp, slots: Arc::new(tokio::sync::Semaphore::new(64)) }, app.into_make_service_with_connect_info::<listener::Connection>()).into_future());
    s.sso.spawn_recheck();
    let (org, _) = scribyra_sync::org::create_org(&config, "lib").await.unwrap();
    let (org_b, _) = scribyra_sync::org::create_org(&config, "lib-b").await.unwrap();
    let public2 = public.clone();
    let idp = tokio::task::spawn_blocking(move || Idp::start("ES256", &public2, default_users())).await.unwrap();
    let secret = idp.secret_file().to_str().unwrap().to_owned();
    for o in [&org, &org_b] {
        let args: Vec<String> = ["--org", o, "--issuer", &idp.issuer, "--client-id", CLIENT_ID, "--client-secret-file", &secret].iter().map(|s| s.to_string()).collect();
        scribyra_sync::sso::command(&config, &args).await.unwrap();
    }
    let mut hook = s.sso.revocations();
    let idp = Arc::new(idp);
    let blocking = |f: Box<dyn FnOnce(&Client) -> Value + Send>| {
        let (idp, base, org) = (idp.clone(), public.clone(), org.clone());
        tokio::task::spawn_blocking(move || f(&Client { base, org, idp: &idp }))
    };
    let first = blocking(Box::new(|c| c.login("alice"))).await.unwrap();
    let second = blocking(Box::new(|c| c.login("alice"))).await.unwrap();
    let (token, token2) = (first["token"].as_str().unwrap().to_owned(), second["token"].as_str().unwrap().to_owned());

    let login = s.sso.login(&token).await.unwrap().unwrap();
    assert_eq!((login.org.as_str(), login.subject.as_str(), login.email.as_deref()), (org.as_str(), "sub-alice", Some("alice@example.org")));
    assert!(login.email_verified);
    assert_eq!(s.sso.policy(&org).await.unwrap().unwrap().issuer, idp.issuer);
    assert_eq!(s.sso.policy(&random_hex(32)).await.unwrap(), None);
    // The login belongs to org A only; the org module compares `login.org`.
    assert_ne!(login.org, org_b);
    assert_eq!(s.sso.login(&random_hex(32)).await.unwrap(), None);
    assert_eq!(s.sso.login("short").await.unwrap(), None);

    // Linking.
    let uuid = || { let h = random_hex(16); format!("{}-{}-{}-{}-{}", &h[..8], &h[8..12], &h[12..16], &h[16..20], &h[20..]) };
    let (person, other) = (uuid(), uuid());
    assert_eq!(s.sso.linked_person(&login).await.unwrap(), None);
    s.sso.link(&login, &person).await.unwrap();
    s.sso.link(&login, &person).await.unwrap();
    assert_eq!(s.sso.link(&login, &other).await, Err(LinkError::Conflict));
    assert_eq!(s.sso.link(&login, "nothex").await, Err(LinkError::Invalid));
    assert_eq!(s.sso.link(&login, &random_hex(32)).await, Err(LinkError::Invalid));
    let mut stranger = login.clone();
    stranger.subject = "sub-someone-else".into();
    assert_eq!(s.sso.link(&stranger, &person).await, Err(LinkError::Conflict));
    // The same person may be linked in another organisation.
    let mut in_b = login.clone();
    in_b.org = org_b.clone();
    s.sso.link(&in_b, &person).await.unwrap();
    assert_eq!(s.sso.linked_person(&login).await.unwrap(), Some((person.clone(), false)));
    let me = blocking(Box::new(move |c| c.me(&token2).json())).await.unwrap();
    assert_eq!((me["state"].as_str(), me["person"].as_str()), (Some("linked"), Some(person.as_str())));

    // Logout of the second login fires the hook for the linked person.
    let token2 = second["token"].as_str().unwrap().to_owned();
    assert_eq!(blocking(Box::new(move |c| json!(c.logout(&token2).status))).await.unwrap(), 200);
    let fired = tokio::time::timeout(Duration::from_secs(5), hook.recv()).await.unwrap().unwrap();
    assert_eq!(fired, (org.clone(), person.clone()));

    // A due recheck refreshes (the provider rotates refresh tokens) and keeps the login.
    sqlx::query("UPDATE org_sso SET recheck_seconds = 1").execute(&s.store.pool).await.unwrap();
    let refresh_before: String = sqlx::query_scalar("SELECT refresh_token FROM sso_logins WHERE token_hash = $1").bind(sha256(token.as_bytes())).fetch_one(&s.store.pool).await.unwrap();
    let deadline = Instant::now() + Duration::from_secs(20);
    loop {
        let now: String = sqlx::query_scalar("SELECT refresh_token FROM sso_logins WHERE token_hash = $1").bind(sha256(token.as_bytes())).fetch_one(&s.store.pool).await.unwrap();
        if now != refresh_before {
            break;
        }
        assert!(Instant::now() < deadline, "no recheck happened");
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
    // Two more passes on the rotated token still keep the login.
    tokio::time::sleep(Duration::from_millis(2500)).await;
    assert!(s.sso.login(&token).await.unwrap().is_some());

    // Disable alice at the provider: the next recheck revokes, blocks and fires.
    let idp2 = idp.clone();
    tokio::task::spawn_blocking(move || assert_eq!(idp2.control("disable?user=alice").status, 200)).await.unwrap();
    let fired = tokio::time::timeout(Duration::from_secs(20), hook.recv()).await.expect("no revocation fired").unwrap();
    assert_eq!(fired, (org.clone(), person.clone()));
    assert_eq!(s.sso.login(&token).await.unwrap(), None);
    assert_eq!(s.sso.linked_person(&login).await.unwrap(), Some((person.clone(), true)));
    // The other organisation's link is untouched.
    assert_eq!(s.sso.linked_person(&in_b).await.unwrap(), Some((person.clone(), false)));
    let token1 = token.clone();
    assert_eq!(blocking(Box::new(move |c| json!(c.me(&token1).status))).await.unwrap(), 401);
    // Re-enabled at the provider, alice can sign in again but her link stays blocked until an
    // admin unlinks her.
    let idp2 = idp.clone();
    tokio::task::spawn_blocking(move || idp2.control("enable?user=alice")).await.unwrap();
    let again = blocking(Box::new(|c| c.login("alice"))).await.unwrap();
    assert_eq!(again["state"], "blocked");
    s.sso.unlink(&org, &person).await.unwrap();
    assert_eq!(s.sso.linked_person(&login).await.unwrap(), None);
    s.sso.link(&login, &other).await.unwrap();
    drop(s);
    let _ = std::fs::remove_dir_all(&dir);
}
