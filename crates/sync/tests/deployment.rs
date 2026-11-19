//! The deployment configuration through the real binary: validation names the field and refuses
//! to start, the encryption mode is recorded at first start and cannot change, `GET
//! /v1/deployment` is public, the end-to-end routes serve only an end-to-end deployment's one
//! organisation, and its genesis is accepted once, from a configured administrator's sign-in.
mod support;
use scribyra_core::orgsync as core;
use serde_json::{Value, json};
use support::{orgs::*, sso::*, *};

/// Starts the binary with `config` and expects it to refuse; returns what it printed.
fn refused(config: Value) -> String {
    let mut service = Service::configure(config);
    let error = service.start().err().unwrap_or_else(|| panic!("the service started with {}", service.config));
    error
}

#[test]
fn invalid_deployments_are_refused_at_start_naming_the_field() {
    let port = free_port();
    let public = format!("http://127.0.0.1:{port}");
    let idp = Idp::start("RS256", &public, default_users());
    let dir = temp_dir("scribyra-deployment-");
    let key = dir.join("master.key");
    std::fs::write(&key, random_bytes(32)).unwrap();
    let base = |deployment: Value| json!({"bind": format!("127.0.0.1:{port}"), "public_url": public, "origins": [APP], "service_key_file": key, "deployment": deployment});
    let with = |extra: Value| deployment(&idp, extra);
    let provider = |field: &str, value: Value| {
        let mut d = with(json!({}));
        d["providers"][0][field] = value;
        d
    };
    let cases = [
        (with(json!({"name": ""})), "deployment.name"),
        ({
            let mut d = with(json!({}));
            d["providers"] = json!([]);
            d
        }, "deployment.providers must list 1-16"),
        (provider("id", json!("Not-Lower")), "deployment.providers[].id"),
        (provider("issuer", json!("http://idp.example.org")), "deployment.providers[].issuer"),
        (provider("email_domains", json!(["Example.org"])), "deployment.providers[].email_domains"),
        (provider("admin_groups", json!(["admins"])), "unknown field"),
        (provider("claims", json!({"roles": "roles"})), "deployment.providers[].claims must be JSON paths"),
        (provider("roles", json!({"guest": ["g"]})), "deployment.providers[].roles must map at least one"),
        (provider("preset", json!("entra")), "deployment.providers[] needs exactly one of preset"),
        (provider("session_hours", json!(0)), "deployment.providers[].session_hours"),
        (provider("recheck_minutes", json!(2000)), "deployment.providers[].recheck_minutes"),
        (provider("unknown", json!(1)), "unknown field"),
        (with(json!({"admins": ["alice@example.org"]})), "unknown field"),
        (with(json!({"guests": "shared"})), "deployment.guests must be"),
        (with(json!({"audit_retention_days": 10})), "deployment.audit_retention_days"),
        (with(json!({"compile": "server", "texlive": "/tex"})), "needs encryption \\\"server\\\""),
        (with(json!({"encryption": "server", "compile": "both"})), "needs texlive"),
        (with(json!({"encryption": "sealed"})), "unknown variant"),
        (with(json!({"quotas": {"deployment_bytes": 10, "project_bytes": 20, "member_bytes": 5}})), "deployment.quotas"),
        (provider("client_secret_file", json!(dir.join("missing"))), "client_secret_file cannot be read"),
    ];
    for (deployment, reason) in cases {
        let error = refused(base(deployment.clone()));
        if reason == "unknown field" || reason == "unknown variant" {
            // Parse errors are never printed (they can quote values), only refused.
            assert!(error.contains("startup_or_runtime_failure") && !error.contains("invalid_configuration"), "{deployment}: {error}");
        } else {
            assert!(error.contains("invalid_configuration") && error.contains(reason), "{deployment}: {error}");
        }
    }
    // Two providers may not share an ID; a server-readable deployment needs the master key.
    let mut twice = with(json!({}));
    let first = twice["providers"][0].clone();
    twice["providers"].as_array_mut().unwrap().push(first);
    assert!(refused(base(twice)).contains("deployment.providers[].id"));
    let mut no_key = base(with(json!({"encryption": "server"})));
    no_key.as_object_mut().unwrap().remove("service_key_file");
    assert!(refused(no_key).contains("needs service_key_file"));
    // A deployment needs public_url.
    let mut no_url = base(with(json!({})));
    no_url.as_object_mut().unwrap().remove("public_url");
    assert!(refused(no_url).contains("deployment needs public_url"));
    // Nothing secret is printed with a refusal.
    let error = refused(base(provider("session_hours", json!(0))));
    assert!(!error.contains(&idp.secret));
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn the_encryption_mode_is_recorded_at_first_start_and_cannot_change() {
    let mut env = Env::start("RS256", default_users(), json!({}), json!({}));
    let org = env.org();
    let db = env.service.database_url().to_owned();
    assert_eq!(postgres().psql(&db, "SELECT encryption || ',' || org FROM deployment"), format!("e2ee,{org}"));
    assert_eq!(postgres().psql(&db, "SELECT label FROM orgs"), "Test Lab");
    // A restart with the same mode keeps the organisation (and a new name renames it).
    env.service.stop();
    let mut deployment = env.service.config["deployment"].clone();
    deployment["name"] = json!("Renamed Lab");
    env.service.reconfigure(json!({"deployment": deployment.clone()}));
    env.service.start().unwrap();
    assert_eq!(env.org(), org);
    assert_eq!(fetch(&format!("{}/v1/deployment", env.service.url), None).json()["name"], "Renamed Lab");
    // The other mode is refused at start, and says so.
    env.service.stop();
    let dir = temp_dir("scribyra-deployment-");
    std::fs::write(dir.join("master.key"), random_bytes(32)).unwrap();
    deployment["encryption"] = json!("server");
    env.service.reconfigure(json!({"deployment": deployment, "service_key_file": dir.join("master.key")}));
    let error = env.service.start().expect_err("the service switched encryption modes");
    assert!(error.contains("deployment_encryption_changed"), "{error}");
    assert_eq!(postgres().psql(&db, "SELECT encryption FROM deployment"), "e2ee");
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn a_server_readable_deployment_offers_no_end_to_end_routes() {
    let dir = temp_dir("scribyra-deployment-");
    std::fs::write(dir.join("master.key"), random_bytes(32)).unwrap();
    let env = Env::start("RS256", default_users(), json!({"service_key_file": dir.join("master.key")}), json!({"encryption": "server", "offline": false}));
    let info = fetch(&format!("{}/v1/deployment", env.service.url), None).json();
    assert_eq!((info["encryption"].as_str(), info["offline"].as_bool()), (Some("server"), Some(false)));
    let org = env.org();
    // Sign-in works in both modes; the end-to-end organisation routes do not exist here.
    let login = env.client().login("alice")["token"].as_str().unwrap().to_owned();
    let owner = Device::new();
    let genesis = sign_event(&org, &org, "genesis", genesis_body(&org, &owner), &owner.seed);
    assert_eq!(post_with_login(&env.service.url, &org, &genesis, &login).status, 404);
    assert_eq!(send("POST", &format!("{}/v1/auth/challenge", env.service.url), None, "application/json", json!({"org": org}).to_string().as_bytes()).status, 404);
    assert_eq!(send("GET", &format!("{}/v1/orgs/{org}/info", env.service.url), None, "", b"").status, 404);
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn without_a_deployment_there_is_no_sign_in_and_no_organisation() {
    let s = Service::new(org_overrides(json!({"origins": [APP]})));
    assert_eq!(send("GET", &format!("{}/v1/deployment", s.url), None, "", b"").status, 404);
    assert_eq!(send("POST", &format!("{}/v1/sso/start", s.url), None, "application/json", json!({"provider":"test","return":APP,"challenge":random_hex(32)}).to_string().as_bytes()).status, 404);
    assert_eq!(send("POST", &format!("{}/v1/auth/challenge", s.url), None, "application/json", json!({"org": random_hex(32)}).to_string().as_bytes()).status, 404);
    assert_eq!(postgres().psql(s.database_url(), "SELECT count(*) FROM deployment"), "0");
    // The removed commands are gone.
    let (code, _) = s.run(&["org", "create", "--label", "x"]);
    assert_eq!(code, 2);
    let (code, _) = s.run(&["org", "sso", "--org", &random_hex(32), "--off"]);
    assert_eq!(code, 2);
}

#[test]
fn the_genesis_is_accepted_once_and_only_from_an_administrators_sign_in() {
    let env = Env::start("RS256", people(), json!({}), json!({}));
    let client = env.client();
    let org = env.org();
    let base = env.service.url.clone();
    let info = || send("GET", &format!("{base}/v1/orgs/{org}/info"), None, "", b"").json();
    assert_eq!(info()["genesis"], false);
    assert!(info().get("serviceKey").is_none());
    let owner = Device::new();
    let genesis = sign_event(&org, &org, "genesis", genesis_body(&org, &owner), &owner.seed);
    // No sign-in, a member's sign-in, or a session-style header: refused.
    assert_eq!(send("POST", &format!("{base}/v1/orgs/{org}/events"), None, "application/json", genesis.as_bytes()).status, 403);
    let ben = client.login("ben");
    assert_eq!(ben["role"], "member");
    let refused = post_with_login(&base, &org, &genesis, ben["token"].as_str().unwrap());
    assert_eq!((refused.status, refused.json()["error"].as_str()), (403, Some("only an administrator of this organisation can create it")));
    assert_eq!(send("POST", &format!("{base}/v1/orgs/{org}/events"), Some(&random_hex(32)), "application/json", genesis.as_bytes()).status, 403);
    // A join request before the genesis has nothing to join.
    let early = Device::new();
    let body = json!({"person":core::person_id(&org, &early.key).unwrap(),"device":early.key,"agreement":early.agreement,"proof":random_hex(64),"name":random_hex(60)});
    let raw = sign_event(&org, &org, "person.request", body, &early.seed);
    assert_eq!(post_with_login(&base, &org, &raw, ben["token"].as_str().unwrap()).status, 409);
    // The administrator's sign-in creates it, and links the administrator to the owner.
    let alice = client.login("alice")["token"].as_str().unwrap().to_owned();
    assert_eq!(post_with_login(&base, &org, &genesis, &alice).status, 201);
    assert_eq!(info()["genesis"], true);
    assert_eq!(client.me(&alice).json()["person"], json!(core::person_id(&org, &owner.key).unwrap()));
    // Once: another administrator's genesis (or the same one again) is refused.
    let other = Device::new();
    let second = sign_event(&org, &org, "genesis", genesis_body(&org, &other), &other.seed);
    assert_eq!(post_with_login(&base, &org, &second, &alice).status, 409);
    assert_eq!(postgres().psql(env.service.database_url(), "SELECT count(*) FROM org_events"), "1");
}
