//! OIDC single sign-on end to end: the real service binary against real PostgreSQL and the
//! real `test-idp` example provider (see `support/sso.rs` for how it is built), driven without
//! a browser. One in-process test uses the library directly to observe the revocation hook.
mod support;
use serde_json::{Value, json};
use std::time::{Duration, Instant};
use support::sso::*;
use support::*;

fn env(alg: &str, provider: Value, service: Value) -> Env {
    let mut overrides = json!({"sso_jwks_refetch_seconds": 0});
    for (k, v) in service.as_object().unwrap() {
        overrides[k] = v.clone();
    }
    Env::start(alg, default_users(), overrides, json!({"provider": provider}))
}

#[test]
fn rs256_sign_in_me_logout_and_replays() {
    let env = env("RS256", json!({"groups_claim": "groups"}), json!({}));
    let c = env.client();
    let org = env.org();
    // What the app learns before sign-in: names and labels, never issuers or client settings.
    let deployment = fetch(&c.url("/v1/deployment"), None);
    assert_eq!(deployment.json(), json!({"name": "Test Lab", "encryption": "e2ee", "offline": true, "compile": "browser", "linkSharing": false, "providers": [{"id": "test", "label": "Test account"}], "org": org}));
    assert!(!deployment.body.contains(&env.idp.issuer) && !deployment.body.contains(CLIENT_ID));

    let started = c.start();
    assert!(started.url.starts_with(&format!("{}/authorize?", env.idp.issuer)));
    let query: std::collections::HashMap<String, String> = url::Url::parse(&started.url).unwrap().query_pairs().into_owned().collect();
    assert_eq!(query["scope"], "openid email profile");
    assert_eq!(query["code_challenge_method"], "S256");
    assert_eq!(query["redirect_uri"], format!("{}/v1/sso/callback/test", env.service.config["public_url"].as_str().unwrap()));
    let callback = c.authorize(&started, "alice", "pw-alice");
    let (status, outcome) = c.callback(&callback);
    assert_eq!(status, 302);
    let Some(Outcome::Grant { grant, org: returned }) = outcome else { panic!("{outcome:?}") };
    assert_eq!(returned, org);
    // The state is single use.
    let (status, outcome) = c.callback(&callback);
    assert_eq!((status, outcome), (400, None));

    let login = c.redeem(&grant, &started.verifier).json();
    assert_eq!(login["org"], json!(org));
    assert_eq!((login["provider"].as_str(), login["role"].as_str()), (Some("test"), Some("admin")));
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
        let env = env(alg, json!({}), json!({}));
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
    let env = env("RS256", json!({"email_domains": ["example.org"]}), json!({}));
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
    let env = env("EdDSA", json!({}), json!({}));
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
    let reply = c.start_with("test", APP, &sha256(hex_text.as_bytes()));
    let url = reply.json()["url"].as_str().unwrap().to_owned();
    let callback = c.authorize(&Started { url, verifier: hex_text.clone() }, "alice", "pw-alice");
    let Some(Outcome::Grant { grant, .. }) = c.callback(&callback).1 else { panic!() };
    assert_eq!(c.redeem(&grant, &hex_text).status, 401);
    // Return origins must be configured; other request errors.
    assert_eq!(c.start_with("test", "https://evil.example", &sha256(&raw)).status, 400);
    assert_eq!(c.start_with("test", &format!("{APP}/"), &sha256(&raw)).status, 400);
    assert_eq!(c.start_with("test", APP, "not-hex").status, 400);
    assert_eq!(c.start_with("other", APP, &sha256(&raw)).status, 404);
    assert_eq!(post_json(&c.url("/v1/sso/start"), None, &json!({"provider": "test", "return": APP, "challenge": sha256(&raw), "extra": 1})).status, 422);
    // The per-organisation request shape and settings route are gone.
    assert_eq!(post_json(&c.url("/v1/sso/start"), None, &json!({"org": env.org(), "return": APP, "challenge": sha256(&raw)})).status, 422);
    // An unknown state is not redirected anywhere.
    let reply = fetch(&c.url(&format!("/v1/sso/callback/test?code=x&state={}", random_hex(32))), None);
    assert_eq!((reply.status, reply.location), (400, None));
    // A provider error goes back to the app as a fixed code; its text is not reflected.
    let started = c.start();
    let state = url::Url::parse(&started.url).unwrap().query_pairs().find(|(k, _)| k == "state").unwrap().1.into_owned();
    let reply = fetch(&c.url(&format!("/v1/sso/callback/test?error=access_denied&error_description=%3Cscript%3E&state={state}")), None);
    assert_eq!(reply.location.as_deref(), Some(format!("{APP}/#scribyra-sso-error=idp_error").as_str()));
    // A wrong password at the provider never reaches a grant.
    let started = c.start();
    let reply = fetch(&format!("{}&login_hint=alice&test_password=nope", started.url), None);
    let back = reply.location.unwrap();
    assert!(back.contains("error=access_denied"));
    assert_eq!(c.callback(&back).1, Some(Outcome::Error("idp_error".into())));
    assert_eq!(fetch(&c.url(&format!("/v1/orgs/{}/sso", env.org())), None).status, 404);
}

#[test]
fn email_domain_restriction() {
    let env = env("ES256", json!({"email_domains": ["example.org", "lab.example"]}), json!({}));
    let c = env.client();
    assert_eq!(c.sign_in("bob").0, Outcome::Error("email_domain".into()));
    assert_eq!(c.sign_in("carol").0, Outcome::Error("email_unverified".into()));
    assert_eq!(c.sign_in("dave").0, Outcome::Error("email_domain".into()));
    assert_eq!(c.login("alice")["subject"]["email"], "alice@example.org");
}

#[test]
fn key_rotation_needs_a_jwks_refetch_at_most_once_per_interval() {
    let env = env("RS256", json!({}), json!({"sso_jwks_refetch_seconds": 4}));
    let c = env.client();
    c.login("alice");
    assert_eq!(env.idp.control("rotate").json()["kid"], "rsa-2");
    // The cached key set was fetched moments ago: no refetch yet, so the new kid is unknown.
    let fetched = Instant::now();
    assert_eq!(c.sign_in("alice").0, Outcome::Error("id_token".into()));
    std::thread::sleep(Duration::from_secs(4).saturating_sub(fetched.elapsed()) + Duration::from_millis(500));
    c.login("alice");
    // After the old key is dropped the new key keeps working.
    let env2 = self::env("EdDSA", json!({}), json!({}));
    let c2 = env2.client();
    c2.login("alice");
    env2.idp.control("rotate?drop=1");
    c2.login("alice");
}

#[test]
fn backchannel_logout_revokes_logins() {
    let env = env("RS256", json!({}), json!({}));
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
    // Same provider, but configured with a trailing slash: the document's issuer differs.
    let port = free_port();
    let public = format!("http://127.0.0.1:{port}");
    let idp = Idp::start("RS256", &public, default_users());
    let mut deployment = deployment(&idp, json!({}));
    deployment["providers"][0]["issuer"] = json!(format!("{}/", idp.issuer));
    let service = Service::new(json!({"bind": format!("127.0.0.1:{port}"), "public_url": public, "origins": [APP], "deployment": deployment}));
    let c = Client { base: service.url.clone(), provider: "test".into(), idp: &idp };
    assert_eq!(c.start_with("test", APP, &sha256(&random_bytes(32))).status, 502);
    assert!(service.logs.lock().unwrap().contains("discovery_issuer"));
}

#[test]
fn scopes_and_several_providers() {
    // offline_access and extra scopes are requested when configured; a second provider at
    // another issuer signs in on its own, and its logins name it.
    let port = free_port();
    let public = format!("http://127.0.0.1:{port}");
    let (one, two) = (Idp::start("RS256", &public, default_users()), Idp::start("EdDSA", &public, default_users()));
    let mut deployment = deployment(&one, json!({"provider": {"offline_access": true, "scopes": ["groups", "offline_access"]}}));
    let mut second = deployment["providers"][0].clone();
    second["id"] = json!("partner");
    second["label"] = json!("Partner account");
    second["issuer"] = json!(two.issuer);
    second["client_secret_file"] = json!(two.secret_file());
    second["offline_access"] = json!(false);
    second["scopes"] = json!([]);
    deployment["providers"].as_array_mut().unwrap().push(second);
    let service = Service::new(json!({"bind": format!("127.0.0.1:{port}"), "public_url": public, "origins": [APP], "deployment": deployment}));
    assert_eq!(fetch(&format!("{}/v1/deployment", service.url), None).json()["providers"], json!([{"id": "test", "label": "Test account"}, {"id": "partner", "label": "Partner account"}]));
    let c = Client { base: service.url.clone(), provider: "test".into(), idp: &one };
    let query: std::collections::HashMap<String, String> = url::Url::parse(&c.start().url).unwrap().query_pairs().into_owned().collect();
    assert_eq!(query["scope"], "openid email profile offline_access groups");
    let partner = Client { base: service.url.clone(), provider: "partner".into(), idp: &two };
    let started = partner.start();
    assert!(started.url.starts_with(&two.issuer));
    let query: std::collections::HashMap<String, String> = url::Url::parse(&started.url).unwrap().query_pairs().into_owned().collect();
    assert_eq!(query["scope"], "openid email profile");
    let login = partner.login("alice");
    // `test:alice@example.org` is an administrator at `test` only: the same email at another
    // provider is someone else as far as the admins list knows (review M1).
    assert_eq!((login["provider"].as_str(), login["role"].as_str()), (Some("partner"), Some("member")));
    // The same email at two providers is two accounts: each its own subject at its issuer.
    let first = c.login("alice");
    assert_eq!(postgres().psql(service.database_url(), "SELECT count(DISTINCT issuer) FROM sso_logins WHERE subject = 'sub-alice'"), "2");
    assert_eq!((first["provider"].as_str(), first["role"].as_str()), (Some("test"), Some("admin")));
}

#[test]
fn guests_admin_groups_and_member_groups_decide_who_signs_in_and_as_what() {
    let mut users = default_users();
    users.as_array_mut().unwrap().push(json!({"sub": "sub-gus", "username": "gus", "password": "pw-gus", "email": "gus@partner.example", "email_verified": true, "name": "Gus", "groups": ["staff"], "claims": {"acct": 1}}));
    users.as_array_mut().unwrap().push(json!({"sub": "sub-erin", "username": "erin", "password": "pw-erin", "email": "erin@example.org", "email_verified": true, "name": "Erin", "groups": ["staff"]}));
    let provider = json!({"groups_claim": "groups", "admin_groups": ["admins"], "member_groups": ["staff"], "guest": {"claim": "acct", "equals": "1"}});
    // Guests off (the default): a guest account is refused at sign-in, whatever its groups.
    let env = Env::start("RS256", users.clone(), json!({}), json!({"admins": [], "provider": provider}));
    let c = env.client();
    assert_eq!(c.sign_in("gus").0, Outcome::Error("guest".into()));
    // admin_groups make administrators; member_groups admit members; anyone else is refused.
    assert_eq!(c.login("alice")["role"], "admin");
    assert_eq!(c.login("erin")["role"], "member");
    assert_eq!(c.sign_in("bob").0, Outcome::Error("not_member".into()));
    assert_eq!(c.sign_in("dave").0, Outcome::Error("not_member".into()));
    // The admins list names people whatever their groups: by verified email or issuer#subject.
    let listed = Env::start("RS256", users.clone(), json!({}), json!({"admins": ["test:bob@other.org"], "provider": provider}));
    let c = listed.client();
    assert_eq!(c.login("bob")["role"], "admin");
    // A plain email is matched only through a provider whose email_domains include it (review M1):
    // erin's verified example.org address makes her an administrator at the provider that vouches
    // for example.org, not at one that would accept any email.
    let mut vouching = provider.clone();
    vouching["email_domains"] = json!(["example.org", "other.org"]);
    let domains = Env::start("RS256", users.clone(), json!({}), json!({"admins": ["erin@example.org"], "provider": vouching}));
    assert_eq!(domains.client().login("erin")["role"], "admin");
    assert_eq!(scribyra_sync::sso::admit(&serde_json::from_value(deployment(&domains.idp, json!({"admins": ["erin@example.org"], "provider": vouching}))).unwrap(), &serde_json::from_value(json!({"id": "other", "label": "Other", "issuer": "https://other.example", "client_id": "x", "client_secret_file": "/x"})).unwrap(), "s", Some("erin@example.org"), true, &[], false), Ok(scribyra_sync::sso::Role::Member));
    assert_eq!(c.login("erin")["role"], "member");
    // Guests "shared": a guest signs in as a guest, never as an administrator.
    let shared = Env::start("RS256", users, json!({}), json!({"guests": "shared", "admins": ["test:gus@partner.example"], "provider": provider}));
    let c = shared.client();
    assert_eq!(c.login("gus")["role"], "guest");
    // Nothing about the refusals reaches the logs but their codes.
    let logs = env.service.logs.lock().unwrap().clone();
    assert!(logs.contains("\"reason\":\"guest\"") && logs.contains("\"reason\":\"not_member\""), "{logs}");
    assert!(!logs.contains("gus@partner.example"));
}

#[test]
fn an_admin_listed_by_issuer_and_subject() {
    let port = free_port();
    let public = format!("http://127.0.0.1:{port}");
    let idp = Idp::start("RS256", &public, default_users());
    let deployment = deployment(&idp, json!({"admins": [format!("{}#sub-carol", idp.issuer)]}));
    let service = Service::new(json!({"bind": format!("127.0.0.1:{port}"), "public_url": public, "origins": [APP], "deployment": deployment}));
    let c = Client { base: service.url.clone(), provider: "test".into(), idp: &idp };
    // Carol's email is not verified, so only her subject can name her.
    assert_eq!(c.login("carol")["role"], "admin");
    assert_eq!(c.login("alice")["role"], "member");
}

/// The library in-process: the background recheck keeps a login while the provider accepts its
/// (rotating) refresh token; a refreshed ID token's groups are applied (an account that leaves
/// the member groups loses its logins); a user disabled at the provider is revoked and blocked
/// and the revocation hook fires. Also logout and linking.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn recheck_applies_groups_revokes_disabled_users_and_fires_the_hook() {
    use scribyra_sync::{config::Config, listener, service, sso::LinkError, store::Store};
    use std::sync::Arc;
    let port = free_port();
    let public = format!("http://127.0.0.1:{port}");
    let dir = temp_dir("scribyra-sso-lib-");
    let public2 = public.clone();
    let mut users = default_users();
    users.as_array_mut().unwrap().push(json!({"sub": "sub-erin", "username": "erin", "password": "pw-erin", "email": "erin@example.org", "email_verified": true, "name": "Erin"}));
    let idp = tokio::task::spawn_blocking(move || Idp::start("ES256", &public2, users)).await.unwrap();
    let deployment = deployment(&idp, json!({"provider": {"offline_access": true, "groups_claim": "groups", "member_groups": ["staff"]}}));
    let config = Config {
        bind: format!("127.0.0.1:{port}").parse().unwrap(),
        data: dir.join("data"),
        database_url: Some(tokio::task::spawn_blocking(|| postgres().database()).await.unwrap()),
        origins: vec![APP.into()],
        public_url: Some(public.clone()),
        sso_recheck_tick_seconds: 1,
        sso_jwks_refetch_seconds: 0,
        deployment: Some(serde_json::from_value(deployment).unwrap()),
        ..Config::default()
    };
    config.validate().unwrap();
    config.check_files().unwrap();
    let store = Store::open(config.clone()).await.unwrap();
    let org = store.org.clone().unwrap();
    let s = service::state(store).unwrap();
    let app = service::router(s.clone());
    let tcp = tokio::net::TcpListener::bind(config.bind).await.unwrap();
    tokio::spawn(axum::serve(listener::Listener { tcp, slots: Arc::new(tokio::sync::Semaphore::new(64)) }, app.into_make_service_with_connect_info::<listener::Connection>()).into_future());
    s.sso.spawn_recheck();
    let mut hook = s.sso.revocations();
    let idp = Arc::new(idp);
    let blocking = |f: Box<dyn FnOnce(&Client) -> Value + Send>| {
        let (idp, base) = (idp.clone(), public.clone());
        tokio::task::spawn_blocking(move || f(&Client { base, provider: "test".into(), idp: &idp }))
    };
    let control = |path: &'static str| {
        let idp = idp.clone();
        async move { tokio::task::spawn_blocking(move || idp.control(path).status).await.unwrap() }
    };
    let due = || sqlx::query("UPDATE sso_logins SET checked = now() - interval '1 day' WHERE NOT revoked").execute(&s.store.pool);
    let first = blocking(Box::new(|c| c.login("alice"))).await.unwrap();
    let second = blocking(Box::new(|c| c.login("alice"))).await.unwrap();
    let (token, token2) = (first["token"].as_str().unwrap().to_owned(), second["token"].as_str().unwrap().to_owned());

    let login = s.sso.login(&token).await.unwrap().unwrap();
    assert_eq!((login.org.as_str(), login.provider.as_str(), login.subject.as_str(), login.email.as_deref()), (org.as_str(), "test", "sub-alice", Some("alice@example.org")));
    assert!(login.email_verified);
    assert_eq!(login.role, scribyra_sync::sso::Role::Admin);
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
    assert_eq!(s.sso.linked_person(&login).await.unwrap(), Some((person.clone(), false)));
    let me = blocking(Box::new(move |c| c.me(&token2).json())).await.unwrap();
    assert_eq!((me["state"].as_str(), me["person"].as_str()), (Some("linked"), Some(person.as_str())));

    // Logout of the second login fires the hook for the linked person.
    let token2 = second["token"].as_str().unwrap().to_owned();
    assert_eq!(blocking(Box::new(move |c| json!(c.logout(&token2).status))).await.unwrap(), 200);
    let fired = tokio::time::timeout(Duration::from_secs(5), hook.recv()).await.unwrap().unwrap();
    assert_eq!(fired, (org.clone(), person.clone()));

    // A due recheck refreshes (the provider rotates refresh tokens) and keeps the login.
    let refresh_before: String = sqlx::query_scalar("SELECT refresh_token FROM sso_logins WHERE token_hash = $1").bind(sha256(token.as_bytes())).fetch_one(&s.store.pool).await.unwrap();
    due().await.unwrap();
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
    due().await.unwrap();
    tokio::time::sleep(Duration::from_millis(2500)).await;
    assert!(s.sso.login(&token).await.unwrap().is_some());

    // Erin is outside the member groups: refused at sign-in. Once the provider puts her in them
    // she signs in; when it takes her out again, the next recheck revokes her login.
    assert_eq!(blocking(Box::new(|c| json!(format!("{:?}", c.sign_in("erin").0)))).await.unwrap(), json!("Error(\"not_member\")"));
    assert_eq!(control("groups?user=erin&groups=staff").await, 200);
    let erin = blocking(Box::new(|c| c.login("erin"))).await.unwrap()["token"].as_str().unwrap().to_owned();
    assert_eq!(s.sso.login(&erin).await.unwrap().unwrap().groups, vec!["staff".to_string()]);
    assert_eq!(control("groups?user=erin&groups=").await, 200);
    due().await.unwrap();
    let deadline = Instant::now() + Duration::from_secs(20);
    while s.sso.login(&erin).await.unwrap().is_some() {
        assert!(Instant::now() < deadline, "Erin kept her login after leaving the member groups");
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
    assert!(s.store.config.deployment.is_some());
    assert!(s.sso.login(&token).await.unwrap().is_some(), "an administrator by the admins list stays");

    // Disable alice at the provider: the next recheck revokes, blocks and fires.
    assert_eq!(control("disable?user=alice").await, 200);
    due().await.unwrap();
    let fired = tokio::time::timeout(Duration::from_secs(20), hook.recv()).await.expect("no revocation fired").unwrap();
    assert_eq!(fired, (org.clone(), person.clone()));
    assert_eq!(s.sso.login(&token).await.unwrap(), None);
    assert_eq!(s.sso.linked_person(&login).await.unwrap(), Some((person.clone(), true)));
    let token1 = token.clone();
    assert_eq!(blocking(Box::new(move |c| json!(c.me(&token1).status))).await.unwrap(), 401);
    // Re-enabled at the provider, alice can sign in again but her link stays blocked until an
    // admin unlinks her.
    control("enable?user=alice").await;
    let again = blocking(Box::new(|c| c.login("alice"))).await.unwrap();
    assert_eq!(again["state"], "blocked");
    s.sso.unlink(&org, &person).await.unwrap();
    assert_eq!(s.sso.linked_person(&login).await.unwrap(), None);
    s.sso.link(&login, &other).await.unwrap();
    drop(s);
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn one_client_cannot_fill_the_sign_ins_in_progress() {
    // Review M2: one source starting sign-ins without end used to fill the provider's 256 slots
    // for ten minutes, so everyone else got 503. Now each source holds a few, replacing its own
    // oldest, and nobody is refused for room.
    let env = Env::start("RS256", default_users(), json!({"requests_per_second": 100000, "source_requests_per_second": 100000}), json!({}));
    let start = |ip: &str| {
        let verifier = random_bytes(32);
        let (status, reply) = post_from(ip, &format!("{}/v1/sso/start", env.service.url), &json!({"provider": "test", "return": APP, "challenge": sha256(&verifier)}));
        (status, reply["url"].as_str().map(str::to_owned), verifier)
    };
    for _ in 0..300 {
        assert_eq!(start("127.0.0.66").0, 200);
    }
    let (status, url, verifier) = start("127.0.0.7");
    assert_eq!(status, 200);
    for _ in 0..300 {
        assert_eq!(start("127.0.0.66").0, 200);
    }
    assert_eq!(postgres().psql(env.service.database_url(), "SELECT count(*) FROM sso_flows WHERE source = '127.0.0.66'"), "8");
    // The other person's sign-in is still there and completes.
    let c = env.client();
    let started = Started { url: url.unwrap(), verifier: verifier.iter().map(|b| format!("{b:02x}")).collect() };
    let callback = c.authorize(&started, "alice", "pw-alice");
    let (status, outcome) = c.callback(&callback);
    assert_eq!(status, 302);
    let Some(Outcome::Grant { grant, .. }) = outcome else { panic!("{outcome:?}") };
    assert_eq!(c.redeem(&grant, &started.verifier).status, 200);
}

#[test]
fn each_provider_has_its_own_redirect_uri_and_a_response_counts_only_there() {
    // Review L4: one redirect URI for every provider, with RFC 9207 `iss` checked only when
    // present, let a response be taken for another provider's sign-in. Each provider now has its
    // own callback path, and a response at another one's path is refused.
    let env = Env::start("RS256", default_users(), json!({}), json!({}));
    let c = env.client();
    let started = c.start();
    let query: std::collections::HashMap<String, String> = url::Url::parse(&started.url).unwrap().query_pairs().into_owned().collect();
    assert_eq!(query["redirect_uri"], format!("{}/v1/sso/callback/test", env.public));
    let callback = c.authorize(&started, "alice", "pw-alice");
    assert!(callback.starts_with(&format!("{}/v1/sso/callback/test?", env.public)), "{callback}");
    let (status, outcome) = c.callback(&callback.replace("/v1/sso/callback/test?", "/v1/sso/callback/partner?"));
    assert_eq!((status, outcome), (302, Some(Outcome::Error("idp_error".into()))));
    // The state was used up: the genuine response no longer completes either.
    assert_eq!(c.callback(&callback).0, 400);
    // The path without a provider is gone.
    assert_eq!(fetch(&c.url("/v1/sso/callback?code=x&state=y"), None).status, 404);
}
