//! Identity, organisations and roles from the provider (design section 3, decision 9), through
//! the real binary and the test provider issuing Zitadel-, Keycloak-, Entra- and Google-shaped
//! tokens: each preset's mapping; guests (Zitadel project grants, Entra B2B, guests off);
//! isolation of organisations on every `/v1/sr/` and `/v1/admin/` route and in the audit log;
//! one account in several organisations; claims of one provider never naming another's
//! organisation; roles taken away at a refresh; emails without `email_verified`.
mod support;
use serde_json::{Value, json};
use support::{sr::*, sso::*, *};

/// A Zitadel user of organisation `home` with these grants: `[(role, org)]`.
fn zitadel(name: &str, email: &str, home: &str, grants: &[(&str, &str)], extra: Value) -> Value {
    let mut roles = serde_json::Map::new();
    for (role, org) in grants {
        let entry = roles.entry(role.to_string()).or_insert(json!({}));
        entry[*org] = json!(format!("org{org}.zitadel.test"));
    }
    let mut u = json!({"sub": format!("sub-{name}"), "username": name, "password": format!("pw-{name}"), "email": email, "email_verified": true, "name": name,
                       "zitadel": {"resourceowner": home, "project_id": "42", "roles": roles}});
    for (k, v) in extra.as_object().unwrap() {
        u[k] = v.clone();
    }
    u
}
fn zitadel_users() -> Value {
    json!([
        zitadel("ana", "ana@a.test", "100", &[(ADMIN, "100")], json!({})),
        zitadel("bea", "bea@b.test", "200", &[(ADMIN, "200")], json!({})),
        // Cy works in A and was granted a role by B: a guest there.
        zitadel("cy", "cy@a.test", "100", &[(MEMBER, "100"), (MEMBER, "200")], json!({})),
        // The same email in both organisations: two people as far as Scribyra knows.
        zitadel("dee", "dee@shared.test", "100", &[(MEMBER, "100")], json!({})),
        zitadel("dee-b", "dee@shared.test", "200", &[(MEMBER, "200")], json!({})),
        // A guest of 200 (granted there, at home in 100) who signs in late.
        zitadel("gia", "gia@a.test", "100", &[(MEMBER, "200")], json!({})),
        // A second account of organisation 100 with dee's verified email.
        zitadel("dee2", "dee@shared.test", "100", &[(MEMBER, "100")], json!({})),
        // A provider that does not say whether the email is verified.
        zitadel("ghost", "ghost@a.test", "100", &[(MEMBER, "100")], json!({"email_verified": null})),
        // A role keyed by an organisation that granted nothing mapped, and one with no mapped role.
        zitadel("eve", "eve@a.test", "100", &[(MEMBER, "100"), ("other-app:admin", "200")], json!({})),
        zitadel("nob", "nob@a.test", "100", &[("other-app:admin", "100")], json!({})),
    ])
}
/// One Zitadel project serving organisations 100 and 200 as separate Scribyra organisations.
fn zitadel_provider() -> Value {
    json!({"claims": null, "preset": "zitadel", "zitadel_project_id": "42", "zitadel_project_owner_org": "100", "zitadel_foreign_organisations": "organisations"})
}
fn orgs(login: &Value) -> Vec<(String, String, bool)> {
    login["orgs"].as_array().unwrap().iter().map(|o| (o["id"].as_str().unwrap().to_owned(), o["role"].as_str().unwrap().to_owned(), o["guest"].as_bool().unwrap())).collect()
}
fn token(login: &Value) -> String {
    login["token"].as_str().unwrap().to_owned()
}
fn org_of(sr: &Sr, claim: &str) -> String {
    postgres().psql(&sr.db(), &format!("SELECT org FROM organisations WHERE claim = '{claim}'"))
}
fn account(sr: &Sr, user: &str) -> String {
    postgres().psql(&sr.db(), &format!("SELECT account FROM accounts WHERE subject = 'sub-{user}'"))
}
fn audit_verify(sr: &Sr, org: &str) -> i32 {
    sr.env.service.run(&["audit", "verify", "--org", org]).0
}

#[test]
fn zitadel_organisations_roles_and_guests() {
    let sr = Sr::start(Blobs::Fs, zitadel_users(), json!({}), json!({"guests": "shared", "provider": zitadel_provider()}));
    let c = sr.env.client();
    // The preset asks for the project's roles and audience.
    let query: std::collections::HashMap<String, String> = url::Url::parse(&c.start().url).unwrap().query_pairs().into_owned().collect();
    assert_eq!(query["scope"], "openid email profile offline_access urn:zitadel:iam:org:project:id:42:aud urn:zitadel:iam:org:projects:roles");
    let ana = c.login("ana");
    let a = org_of(&sr, "100");
    assert_eq!(orgs(&ana), [(a.clone(), "admin".into(), false)]);
    assert_eq!(ana["orgs"][0]["name"], "org100.zitadel.test");
    let bea = c.login("bea");
    let b = org_of(&sr, "200");
    assert_eq!(orgs(&bea), [(b.clone(), "admin".into(), false)]);
    // One account, two organisations: a member at home, a guest where a project grant put her.
    let cy = c.login("cy");
    assert_eq!(orgs(&cy), [(a.clone(), "member".into(), false), (b.clone(), "guest".into(), true)]);
    assert_eq!(postgres().psql(&sr.db(), "SELECT count(*) FROM accounts WHERE subject = 'sub-cy'"), "1");
    // A role in an organisation that maps to nothing gives nothing there; no mapped role at all
    // is refused with its own code, and the app gets the design's message at redeem.
    assert_eq!(orgs(&c.login("eve")), [(a.clone(), "member".into(), false)]);
    assert_eq!(c.sign_in("nob").0, Outcome::Error("no_role".into()));
    // Guests off: cy keeps her home organisation; someone who is only a guest is refused.
    let off = Sr::start(Blobs::Fs, zitadel_users(), json!({}), json!({"provider": zitadel_provider()}));
    assert_eq!(off.env.client().login("cy")["orgs"].as_array().unwrap().len(), 1);
    off.env.idp.set("cy", json!({"zitadel": {"resourceowner": "100", "project_id": "42", "roles": {MEMBER: {"200": "b"}}}}));
    assert_eq!(off.env.client().sign_in("cy").0, Outcome::Error("guest".into()));
}

#[test]
fn organisations_are_isolated_on_every_route_and_in_the_audit_log() {
    let sr = Sr::start(Blobs::Fs, zitadel_users(), json!({}), json!({"guests": "shared", "provider": zitadel_provider()}));
    let c = sr.env.client();
    let (ana, bea, cy) = (sr.api(&token(&c.login("ana"))), sr.api(&token(&c.login("bea"))), sr.api(&token(&c.login("cy"))));
    let (a, b) = (org_of(&sr, "100"), org_of(&sr, "200"));
    let (dee, dee_b) = (sr.api(&token(&c.login("dee"))), sr.api(&token(&c.login("dee-b"))));
    // Someone in two organisations names the one each request acts in.
    let refused = cy.call("GET", "/v1/sr/projects", None);
    assert_eq!((refused.status, refused.json()["code"].as_str()), (400, Some("org_required")));
    let (cy_a, cy_b) = (cy.in_org(&a), cy.in_org(&b));
    assert_eq!(cy_a.call("GET", "/v1/sr/projects", None).json()["org"], json!(a));
    let doc = Project::new();
    let pa = ana.create("A paper");
    assert_eq!(ana.append(&pa, "a", 1, &doc.add_text("f", "main.tex", None, "A secret")).status, 201);
    assert_eq!(ana.put_object(&pa, b"a figure").status, 201);
    let pb = bea.create("B paper");
    let invitation = ana.invite(&pa, "nobody@a.test", "viewer").json()["invitation"]["id"].as_str().unwrap().to_owned();
    let ana_id = account(&sr, "ana");
    // Every server-readable route answers 404 for another organisation's project, whoever asks,
    // in their own organisation or naming the other (which is not theirs).
    let sr_routes: Vec<(&str, String, Option<Value>)> = vec![
        ("GET", format!("/v1/sr/projects/{pa}"), None),
        ("PATCH", format!("/v1/sr/projects/{pa}"), Some(json!({"name": "x"}))),
        ("DELETE", format!("/v1/sr/projects/{pa}"), None),
        ("GET", format!("/v1/sr/projects/{pa}/log?after=0"), None),
        ("GET", format!("/v1/sr/projects/{pa}/snapshot"), None),
        ("GET", format!("/v1/sr/projects/{pa}/objects/{}", sha256(b"a figure")), None),
        ("POST", format!("/v1/sr/projects/{pa}/invitations"), Some(json!({"email": "x@b.test", "role": "viewer"}))),
        ("DELETE", format!("/v1/sr/projects/{pa}/invitations/{invitation}"), None),
        ("PUT", format!("/v1/sr/projects/{pa}/members/{ana_id}"), Some(json!({"role": "viewer"}))),
        ("DELETE", format!("/v1/sr/projects/{pa}/members/{ana_id}"), None),
        ("POST", format!("/v1/sr/projects/{pa}/owner"), Some(json!({"account": ana_id}))),
    ];
    for (who, api) in [("bea", &bea), ("cy in B", &cy_b), ("bea naming A", &bea.in_org(&a))] {
        for (method, path, body) in &sr_routes {
            assert_eq!(api.call(method, path, body.clone()).status, 404, "{who}: {method} {path}");
        }
        assert_eq!(api.append(&pa, "x", 1, &doc.type_text("f", "!")).status, 404, "{who}");
        assert_eq!(api.put_object(&pa, b"other").status, 404, "{who}");
    }
    assert_eq!(bea.in_org(&a).call("GET", "/v1/sr/projects", None).json()["code"], "unknown_org");
    // Lists, heads and the directory are the organisation's.
    let ids = |api: &Api| api.call("GET", "/v1/sr/projects", None).json()["projects"].as_array().unwrap().iter().map(|p| p["id"].as_str().unwrap().to_owned()).collect::<Vec<_>>();
    assert_eq!((ids(&ana), ids(&bea)), (vec![pa.clone()], vec![pb.clone()]));
    assert!(bea.heads(None, 0).json()["projects"].get(&pa).is_none());
    let directory = |api: &Api| api.call("GET", "/v1/sr/directory", None).json()["members"].as_array().unwrap().iter().map(|m| m["email"].as_str().unwrap().to_owned()).collect::<Vec<_>>();
    assert_eq!(directory(&bea), ["bea@b.test", "dee@shared.test"]);
    assert!(directory(&ana).contains(&"cy@a.test".to_owned()) && !directory(&ana).contains(&"bea@b.test".to_owned()));
    assert_eq!(cy_b.call("GET", "/v1/sr/directory", None).status, 403, "guests do not browse the directory");
    // The same email in two organisations: an invitation shares with the project's own only.
    assert_eq!(ana.invite(&pa, "dee@shared.test", "editor").json()["status"], "shared");
    assert_eq!((dee.details(&pa).status, dee_b.details(&pa).status), (200, 404));
    // A guest of B is shared with only inside B, and sees nothing of A from there.
    assert_eq!(bea.invite_guest(&pb, "cy@a.test", "viewer").json()["status"], "shared");
    assert_eq!((ids(&cy_b), ids(&cy_a)), (vec![pb.clone()], vec![]));
    assert_eq!(cy_a.details(&pb).status, 404);
    assert_eq!(cy_b.call("POST", "/v1/sr/projects", Some(json!({"name": "mine"}))).status, 403);
    let pc = cy_a.create("Cy at home");
    assert_eq!(postgres().psql(&sr.db(), &format!("SELECT org FROM sr_projects WHERE project = '{pc}'")), a);
    // A pending invitation in A is not accepted by a sign-in into B with that email.
    assert_eq!(ana.invite(&pa, "bea@b.test", "viewer").json()["status"], "pending");
    let bea = sr.api(&token(&c.login("bea")));
    assert_eq!(bea.details(&pa).status, 404);
    // Projects cannot pass to another organisation's account.
    assert_eq!(ana.call("POST", &format!("/v1/sr/projects/{pa}/owner"), Some(json!({"account": account(&sr, "bea")}))).status, 404);

    // The admin area: an administrator of B reaches nothing of A.
    let admin_routes: Vec<(&str, String, Option<Value>)> = vec![
        ("POST", format!("/v1/admin/members/{ana_id}/disable"), None),
        ("POST", format!("/v1/admin/members/{ana_id}/unblock"), None),
        ("POST", format!("/v1/admin/members/{ana_id}/remove"), Some(json!({}))),
        ("DELETE", format!("/v1/admin/projects/{pa}"), None),
        ("POST", format!("/v1/admin/projects/{pa}/open"), None),
        ("POST", format!("/v1/admin/projects/{pa}/edit"), None),
        ("POST", format!("/v1/admin/projects/{pa}/owner"), Some(json!({"account": account(&sr, "bea")}))),
    ];
    for (method, path, body) in &admin_routes {
        assert_eq!(bea.call(method, path, body.clone()).status, 404, "{method} {path}");
        assert_eq!(bea.in_org(&a).call(method, path, body.clone()).status, 404, "naming A: {method} {path}");
    }
    for path in ["/v1/admin/members", "/v1/admin/projects", "/v1/admin/audit", "/v1/admin/audit/export", "/v1/admin/export", "/v1/admin/settings"] {
        assert_eq!(bea.in_org(&a).call("GET", path, None).status, 404, "{path}");
        assert_eq!(cy_a.call("GET", path, None).status, 403, "a member: {path}");
    }
    let members = bea.call("GET", "/v1/admin/members", None).json();
    let emails: Vec<&str> = members["members"].as_array().unwrap().iter().map(|m| m["email"].as_str().unwrap()).collect();
    assert_eq!(emails, ["bea@b.test", "cy@a.test", "dee@shared.test"]);
    assert_eq!(members["members"][1]["role"], "guest");
    let listed = bea.call("GET", "/v1/admin/projects", None).json();
    assert_eq!(listed["projects"].as_array().unwrap().iter().map(|p| p["id"].as_str().unwrap()).collect::<Vec<_>>(), [pb.as_str()]);
    // Each organisation's audit chain holds its own events only, and verifies on its own.
    let events = |api: &Api| api.call("GET", "/v1/admin/audit?limit=500", None).json()["events"].as_array().unwrap().clone();
    let b_events = events(&bea);
    assert!(b_events.iter().all(|e| e["target"] != json!(pa) && e["actor"] != json!(ana_id)), "{b_events:?}");
    assert!(events(&ana).iter().all(|e| e["target"] != json!(pb)));
    let export = String::from_utf8(ana.call("GET", "/v1/admin/audit/export", None).body).unwrap();
    assert!(export.contains(&pa) && !export.contains(&pb));
    // Cy signed in once: that sign-in is in both chains.
    let cy_id = account(&sr, "cy");
    for (who, list) in [("A", events(&ana)), ("B", b_events)] {
        assert_eq!(list.iter().filter(|e| e["action"] == "session.sign_in" && e["actor"] == json!(cy_id)).count(), 1, "{who}");
    }
    // An administrator of B stops cy in B only.
    assert_eq!(bea.call("POST", &format!("/v1/admin/members/{cy_id}/disable"), None).status, 200);
    let cy = sr.api(&token(&c.login("cy")));
    assert_eq!(cy.call("GET", "/v1/sr/projects", None).json()["org"], json!(a), "only A is left, so no header is needed");
    assert_eq!(cy.in_org(&b).call("GET", "/v1/sr/projects", None).status, 404);
    for org in [&a, &b] {
        assert_eq!(audit_verify(&sr, org), 0);
    }
    // Moving an event into the other chain is detected in both.
    let seq = postgres().psql(&sr.db(), &format!("SELECT max(seq) FROM audit_log WHERE org = '{a}'"));
    postgres().psql(&sr.db(), &format!("BEGIN; ALTER TABLE audit_log DISABLE TRIGGER audit_log_guard; UPDATE audit_log SET org = '{b}', seq = 100000 WHERE org = '{a}' AND seq = {seq}; ALTER TABLE audit_log ENABLE TRIGGER audit_log_guard; COMMIT;"));
    assert_eq!((audit_verify(&sr, &a), audit_verify(&sr, &b)), (1, 1));
}

#[test]
fn a_role_taken_away_at_a_refresh_cuts_access_at_once() {
    let sr = Sr::start(Blobs::Fs, zitadel_users(), json!({"sso_recheck_tick_seconds": 1}), json!({"guests": "shared", "provider": {"claims": null, "preset": "zitadel", "zitadel_project_id": "42", "zitadel_project_owner_org": "100", "zitadel_foreign_organisations": "organisations", "offline_access": true, "recheck_minutes": 1}}));
    let c = sr.env.client();
    let bea = sr.api(&token(&c.login("bea")));
    let cy_login = c.login("cy");
    let cy = sr.api(&token(&cy_login));
    let (a, b) = (org_of(&sr, "100"), org_of(&sr, "200"));
    let pb = bea.create("B paper");
    assert_eq!(bea.invite_guest(&pb, "cy@a.test", "editor").status, 201);
    let cy_b = cy.in_org(&b);
    assert_eq!(cy_b.log(&pb, 0).status, 200);
    // A heads poll in B waits; the provider withdraws B's grant; the next refresh ends it.
    let version = cy_b.heads(None, 0).json()["version"].as_str().unwrap().to_owned();
    let poll = {
        let cy_b = cy_b.clone();
        std::thread::spawn(move || cy_b.heads(Some(&version), 25).status)
    };
    std::thread::sleep(std::time::Duration::from_millis(500));
    sr.env.idp.set("cy", json!({"zitadel": {"resourceowner": "100", "project_id": "42", "roles": {MEMBER: {"100": "a"}}}}));
    let due = || postgres().psql(&sr.db(), "UPDATE sso_logins SET checked = now() - interval '1 day' WHERE NOT revoked");
    due();
    assert_eq!(poll.join().unwrap(), 404, "the poll ended with the role");
    assert_eq!(cy_b.log(&pb, 0).status, 404);
    assert_eq!(cy.call("GET", "/v1/sr/projects", None).json()["org"], json!(a), "A stays");
    let change = bea.call("GET", "/v1/admin/audit?action=account.role_changed", None).json()["events"][0].clone();
    assert_eq!((change["actor"].as_str(), change["detail"].clone()), (Some("system"), json!({"from": "guest", "to": null, "by": "provider"})));
    // The last role gone: the session is revoked (and audited); the project stays in B.
    sr.env.idp.set("cy", json!({"zitadel": {"resourceowner": "100", "project_id": "42", "roles": {}}}));
    due();
    eventually("cy's revocation", || c.me(&cy.token).status == 401);
    assert_eq!(postgres().psql(&sr.db(), &format!("SELECT count(*) FROM audit_log WHERE org = '{a}' AND action = 'session.revoked' AND detail->>'reason' = 'no_role'")), "1");
    assert_eq!(c.sign_in("cy").0, Outcome::Error("no_role".into()));
}

#[test]
fn one_providers_claims_never_reach_another_providers_organisation() {
    // Provider `test` (Zitadel) serves organisation 100; provider `partner` (Entra, another
    // issuer) signs in someone whose token names tenant "100" and even carries Zitadel's claims.
    let port = free_port();
    let public = format!("http://127.0.0.1:{port}");
    let one = Idp::start("RS256", &public, zitadel_users());
    let evil_user = json!({"sub": "sub-ana", "username": "mallory", "password": "pw-mallory", "email": "ana@a.test", "email_verified": true, "name": "Ana?",
                           "roles": [ADMIN], "entra": {"tid": "100", "acct": 0}, "zitadel": {"resourceowner": "100", "project_id": "42", "roles": {ADMIN: {"100": "a"}}}});
    let two = Idp::start("EdDSA", &public, json!([evil_user]));
    let mut deployment = deployment(&one, json!({"encryption": "server", "provider": zitadel_provider()}));
    deployment["providers"][0].as_object_mut().unwrap().remove("claims");
    let mut second = json!({"id": "partner", "label": "Partner", "issuer": two.issuer, "client_id": CLIENT_ID, "client_secret_file": two.secret_file(), "preset": "entra", "roles": {"admin": [ADMIN], "member": [MEMBER]}});
    second["roles"]["guest"] = json!([GUEST]);
    deployment["providers"].as_array_mut().unwrap().push(second);
    let key = temp_dir("scribyra-key-").join("master.key");
    std::fs::write(&key, random_bytes(32)).unwrap();
    let service = Service::new(json!({"bind": format!("127.0.0.1:{port}"), "public_url": public, "origins": [APP], "service_key_file": key, "deployment": deployment}));
    let c = Client { base: service.url.clone(), provider: "test".into(), idp: &one };
    let ana = c.login("ana");
    let a = ana["orgs"][0]["id"].as_str().unwrap().to_owned();
    let partner = Client { base: service.url.clone(), provider: "partner".into(), idp: &two };
    let mallory = partner.login("mallory");
    // Same subject string, same email, same claim value: another issuer, so another account in
    // another organisation (partner's tenant "100"), and the Zitadel claims are not read.
    let theirs = mallory["orgs"][0]["id"].as_str().unwrap().to_owned();
    assert_ne!(theirs, a);
    assert_eq!(mallory["orgs"].as_array().unwrap().len(), 1);
    assert_ne!(mallory["account"], ana["account"]);
    let db = service.database_url().to_owned();
    assert_eq!(postgres().psql(&db, &format!("SELECT provider || ' ' || claim FROM organisations WHERE org = '{theirs}'")), "partner 100");
    let api = Api { base: service.url.clone(), token: mallory["token"].as_str().unwrap().to_owned(), org: None };
    let p = Api { base: service.url.clone(), token: ana["token"].as_str().unwrap().to_owned(), org: None }.create("A only");
    assert_eq!(api.in_org(&a).call("GET", "/v1/sr/projects", None).status, 404);
    assert_eq!(api.in_org(&a).call("GET", "/v1/admin/members", None).status, 404);
    assert_eq!(api.details(&p).status, 404);
    assert_eq!(api.call("GET", "/v1/admin/projects", None).json()["projects"], json!([]));
}

#[test]
fn keycloak_entra_google_and_profiles_from_userinfo() {
    let users = json!([
        {"sub": "k1", "username": "kim", "password": "pw-kim", "email": "kim@k.test", "email_verified": true, "name": "Kim",
         "keycloak": {"realm_roles": ["offline_access", MEMBER, "acme:scribyra:member"], "client_roles": {CLIENT_ID: ["lab:scribyra:admin"]}, "organization": {"lab": {}, "acme": {}}}},
        // In two organisations with an unprefixed administrator role: an administrator of neither.
        {"sub": "k3", "username": "kit", "password": "pw-kit", "email": "kit@k.test", "email_verified": true, "keycloak": {"client_roles": {CLIENT_ID: [ADMIN]}, "organization": ["lab", "acme"]}},
        {"sub": "k2", "username": "kai", "password": "pw-kai", "email": "kai@k.test", "email_verified": true, "keycloak": {"client_roles": {"other": [ADMIN]}, "organization": ["lab"]}},
        {"sub": "e1", "username": "ed", "password": "pw-ed", "email": "ed@e.test", "email_verified": true, "roles": [MEMBER], "entra": {"tid": "tenant-1", "acct": 0}},
        {"sub": "e2", "username": "gil", "password": "pw-gil", "email": "gil@guest.test", "email_verified": true, "roles": [MEMBER], "entra": {"tid": "tenant-1", "acct": 1}},
        // A B2B guest whose tenant does not send the optional `acct` claim.
        {"sub": "e3", "username": "gus-b2b", "password": "pw-gus-b2b", "email": "gus@guest.test", "email_verified": true, "roles": [ADMIN], "entra": {"tid": "tenant-1"}, "claims": {"idp": "https://sts.windows.net/tenant-home/"}},
        {"sub": "1001", "username": "gwen", "password": "pw-gwen", "email": "gwen@acme.example", "email_verified": true, "hd": "acme.example"},
        {"sub": "1002", "username": "gus", "password": "pw-gus", "email": "gus@acme.example", "email_verified": true, "hd": "acme.example"},
        {"sub": "1003", "username": "consumer", "password": "pw-consumer", "email": "c@gmail.example", "email_verified": true},
        {"sub": "1004", "username": "otto", "password": "pw-otto", "email": "otto@other.example", "email_verified": true, "hd": "other.example"},
        // Profile only from userinfo; and an email whose verification the provider leaves out.
        {"sub": "u1", "username": "uma", "password": "pw-uma", "email": "uma@k.test", "email_verified": true, "name": "Uma", "picture": "https://k.test/uma.png",
         "userinfo_only": ["email", "email_verified", "name", "picture"], "keycloak": {"realm_roles": [MEMBER], "organization": ["lab"]}},
        {"sub": "u2", "username": "una", "password": "pw-una", "email": "una@k.test", "keycloak": {"realm_roles": [MEMBER], "organization": ["lab"]}},
    ]);
    // Keycloak (organisations) and Entra.
    let keycloak = json!({"claims": null, "preset": "keycloak", "keycloak_organizations": true});
    let entra = json!({"id": "partner", "label": "Partner", "claims": null, "preset": "entra", "keycloak_organizations": null});
    let sr = Sr::start(Blobs::Fs, users.clone(), json!({}), json!({"guests": "shared", "provider": keycloak, "more_providers": [entra]}));
    let c = sr.env.client();
    let query: std::collections::HashMap<String, String> = url::Url::parse(&c.start().url).unwrap().query_pairs().into_owned().collect();
    assert_eq!(query["scope"], "openid email profile organization");
    let kim = c.login("kim");
    let mut kim_orgs: Vec<(&str, &str)> = kim["orgs"].as_array().unwrap().iter().map(|o| (o["name"].as_str().unwrap(), o["role"].as_str().unwrap())).collect();
    kim_orgs.sort();
    assert_eq!(kim_orgs, [("acme", "member"), ("lab", "admin")], "roles named for an organisation count there only");
    assert_eq!(c.sign_in("kit").0, Outcome::Error("no_role".into()), "unprefixed roles are no organisation's when the token names several");
    let lab = kim["orgs"].as_array().unwrap().iter().find(|o| o["name"] == "lab").unwrap()["id"].as_str().unwrap().to_owned();
    assert_eq!(c.sign_in("kai").0, Outcome::Error("no_role".into()), "another client's roles do not count");
    let uma = c.login("uma");
    assert_eq!((uma["email"].as_str(), uma["emailVerified"].as_bool(), uma["name"].as_str(), uma["picture"].as_str()), (Some("uma@k.test"), Some(true), Some("Uma"), Some("https://k.test/uma.png")));
    // email_verified missing everywhere is false: the email is never shown or matched.
    let una = c.login("una");
    assert_eq!((una["email"].clone(), una["emailVerified"].as_bool()), (Value::Null, Some(false)));
    let kim_api = sr.api(&token(&kim)).in_org(&lab);
    let p = kim_api.create("Lab paper");
    assert_eq!(kim_api.invite(&p, "una@k.test", "editor").json()["status"], "pending");
    let una = sr.api(&token(&c.login("una")));
    assert_eq!(una.details(&p).status, 404, "an email without email_verified never takes an invitation");
    let partner = Client { base: sr.url(), provider: "partner".into(), idp: &sr.env.idp };
    let query: std::collections::HashMap<String, String> = url::Url::parse(&partner.start().url).unwrap().query_pairs().into_owned().collect();
    assert_eq!(query["scope"], "openid email profile offline_access");
    let ed = partner.login("ed");
    assert_eq!((ed["orgs"][0]["name"].as_str(), ed["role"].as_str()), (Some("Partner (tenant-1)"), Some("member")));
    let gil = partner.login("gil");
    assert_eq!((gil["orgs"][0]["id"].clone(), gil["role"].as_str()), (ed["orgs"][0]["id"].clone(), Some("guest")), "Entra B2B guests are guests of the tenant");
    assert_eq!(partner.login("gus-b2b")["role"], "guest", "without acct, an idp other than the tenant's marks a guest");
    // Google: the Workspace domain is the organisation, admin_subjects its administrators, and
    // consumer accounts (no hd) are refused.
    let google = json!({"claims": null, "roles": null, "preset": "google", "admin_subjects": ["1001"], "hosted_domains": ["acme.example"]});
    let g = Sr::start(Blobs::Fs, users, json!({}), json!({"provider": google}));
    let c = g.env.client();
    let gwen = c.login("gwen");
    assert_eq!((gwen["orgs"][0]["name"].as_str(), gwen["role"].as_str()), (Some("acme.example"), Some("admin")));
    assert_eq!(c.login("gus")["role"], "member");
    assert_eq!(c.sign_in("consumer").0, Outcome::Error("no_organisation".into()));
    assert_eq!(c.sign_in("otto").0, Outcome::Error("domain".into()), "only the configured Workspace domains");
    // Entra guests are refused when the deployment admits none.
    let off = Sr::start(Blobs::Fs, json!([{"sub": "e2", "username": "gil", "password": "pw-gil", "email": "gil@guest.test", "email_verified": true, "roles": [MEMBER], "entra": {"tid": "t", "acct": 1}}]), json!({}), json!({"provider": {"claims": null, "preset": "entra"}}));
    assert_eq!(off.env.client().sign_in("gil").0, Outcome::Error("guest".into()));
}

#[test]
fn only_the_configured_primary_organisation_takes_the_deployments_id() {
    // Review H1: the first organisation to sign in took the deployment's ID, which end-to-end
    // clients sign with (and which migration 0032 kept, with its links). Organisation 200 signing
    // in first took it over.
    let deployment_of = |env: &Env| fetch(&format!("{}/v1/deployment", env.service.url), None).json();
    let id = |env: &Env| postgres().psql(env.service.database_url(), "SELECT org FROM deployment");
    let claim_of = |env: &Env, org: &str| postgres().psql(env.service.database_url(), &format!("SELECT claim FROM organisations WHERE org = '{org}'"));
    // No primary organisation: nobody gets the ID, and the app is told so.
    let mut first = Env::start("RS256", zitadel_users(), json!({}), json!({"provider": zitadel_provider()}));
    let env = &first;
    let c = env.client();
    let (outcome, verifier) = c.sign_in("bea");
    let Outcome::Grant { grant, org: None } = outcome else { panic!("{outcome:?}") };
    let bea = c.redeem(&grant, &verifier).json();
    assert_ne!(bea["orgs"][0]["id"], json!(id(env)), "the first organisation to sign in does not take the deployment's ID");
    assert_eq!((bea["org"].clone(), bea["orgs"][0]["primary"].clone()), (Value::Null, json!(false)));
    assert_eq!(deployment_of(env)["org"], Value::Null);
    assert_eq!(c.me(&token(&bea)).json()["orgs"][0]["primary"], json!(false));
    assert_ne!(c.login("ana")["orgs"][0]["id"], json!(id(env)));
    assert_eq!(postgres().psql(env.service.database_url(), &format!("SELECT count(*) FROM organisations WHERE org = '{}'", id(env))), "0");
    // An organisation that is not the primary one holding the ID (as a sign-in made it before
    // this fix) refuses the start: an operator decides.
    let bea_org = bea["orgs"][0]["id"].as_str().unwrap().to_owned();
    first.service.stop();
    postgres().psql(first.service.database_url(), &format!("UPDATE deployment SET org = '{bea_org}'"));
    let refused = first.service.start().unwrap_err();
    assert!(refused.contains("deployment_org_conflict"), "{refused}");
    // Named in the configuration: made at start with the ID, whoever signs in first.
    let env = Env::start("RS256", zitadel_users(), json!({}), json!({"provider": zitadel_provider(), "primary_organisation": {"provider": "test", "organisation": "100"}}));
    let deployment = id(&env);
    assert_eq!(claim_of(&env, &deployment), "100");
    assert_eq!(deployment_of(&env)["org"], json!(deployment));
    let c = env.client();
    let (outcome, verifier) = c.sign_in("bea");
    let Outcome::Grant { grant, org } = outcome else { panic!("{outcome:?}") };
    assert_eq!(org, Some(deployment.clone()));
    let bea = c.redeem(&grant, &verifier).json();
    assert_ne!(bea["orgs"][0]["id"], json!(deployment));
    assert_eq!((bea["org"].clone(), bea["orgs"][0]["primary"].clone()), (json!(deployment), json!(false)));
    let ana = c.login("ana");
    assert_eq!((ana["orgs"][0]["id"].clone(), ana["orgs"][0]["primary"].clone()), (json!(deployment), json!(true)));
}

#[test]
fn a_zitadel_project_grant_makes_guests_of_the_project_owner() {
    // Review M5: by default (`zitadel_foreign_organisations: "guests"`) the project owner's
    // organisation is the only one; a project grant's users (organisation 200, roles keyed by
    // their own organisation) are its guests, never members or administrators of their own.
    let provider = json!({"claims": null, "preset": "zitadel", "zitadel_project_id": "42", "zitadel_project_owner_org": "100"});
    let sr = Sr::start(Blobs::Fs, zitadel_users(), json!({}), json!({"guests": "shared", "provider": provider}));
    let c = sr.env.client();
    let a = org_of(&sr, "100");
    assert_eq!(fetch(&format!("{}/v1/deployment", sr.url()), None).json()["org"], json!(a), "the owner organisation is the provider's only one, and primary");
    let bea = c.login("bea");
    assert_eq!(orgs(&bea), [(a.clone(), "guest".into(), true)]);
    assert_eq!(orgs(&c.login("ana")), [(a.clone(), "admin".into(), false)]);
    assert_eq!(orgs(&c.login("cy")), [(a.clone(), "member".into(), false)]);
    assert_eq!(postgres().psql(&sr.db(), "SELECT count(*) FROM organisations"), "1");
    let bea = sr.api(&token(&bea));
    assert_eq!(bea.call("GET", "/v1/admin/members", None).status, 403);
    assert_eq!(bea.call("POST", "/v1/sr/projects", Some(json!({"name": "mine"}))).status, 403);
    // Guests off: the grant's users are refused.
    let off = Sr::start(Blobs::Fs, zitadel_users(), json!({}), json!({"provider": {"claims": null, "preset": "zitadel", "zitadel_project_id": "42", "zitadel_project_owner_org": "100"}}));
    assert_eq!(off.env.client().sign_in("bea").0, Outcome::Error("guest".into()));
}

#[test]
fn sign_outs_are_audited_only_where_the_person_holds_a_role() {
    // Review (low): sign-outs and revocations were audited in every organisation the account had
    // ever been in, so an organisation that stopped someone, or that they left, kept seeing
    // their sessions.
    let sr = Sr::start(Blobs::Fs, zitadel_users(), json!({}), json!({"guests": "shared", "provider": zitadel_provider()}));
    let c = sr.env.client();
    let bea = sr.api(&token(&c.login("bea")));
    let cy = token(&c.login("cy"));
    let (a, b) = (org_of(&sr, "100"), org_of(&sr, "200"));
    let cy_id = account(&sr, "cy");
    let sign_outs = |org: &str| postgres().psql(&sr.db(), &format!("SELECT count(*) FROM audit_log WHERE org = '{org}' AND action = 'session.sign_out' AND actor = '{cy_id}'"));
    assert_eq!(c.logout(&cy).status, 200);
    assert_eq!((sign_outs(&a), sign_outs(&b)), ("1".into(), "1".into()));
    // Stopped in B: B does not see the next sign-out.
    assert_eq!(bea.call("POST", &format!("/v1/admin/members/{cy_id}/disable"), None).status, 200);
    assert_eq!(c.logout(&token(&c.login("cy"))).status, 200);
    assert_eq!((sign_outs(&a), sign_outs(&b)), ("2".into(), "1".into()));
    // Left A (the provider took the role away): A does not see the next one either.
    sr.env.idp.set("cy", json!({"zitadel": {"resourceowner": "100", "project_id": "42", "roles": {MEMBER: {"200": "b"}}}}));
    assert_eq!(bea.call("POST", &format!("/v1/admin/members/{cy_id}/unblock"), None).status, 200);
    assert_eq!(c.logout(&token(&c.login("cy"))).status, 200);
    assert_eq!((sign_outs(&a), sign_outs(&b)), ("2".into(), "2".into()));
}

#[test]
fn an_administrator_stops_someone_only_in_their_own_organisation() {
    // Review (low): disabling someone in organisation B revoked their sessions at B's provider,
    // so an administrator of B also ended their work in A.
    let sr = Sr::start(Blobs::Fs, zitadel_users(), json!({}), json!({"guests": "shared", "provider": zitadel_provider()}));
    let c = sr.env.client();
    let (ana, bea, cy) = (sr.api(&token(&c.login("ana"))), sr.api(&token(&c.login("bea"))), sr.api(&token(&c.login("cy"))));
    let (a, b) = (org_of(&sr, "100"), org_of(&sr, "200"));
    let (pa, pb) = (ana.create("A paper"), bea.create("B paper"));
    assert_eq!(ana.invite(&pa, "cy@a.test", "editor").json()["status"], "shared");
    assert_eq!(bea.invite_guest(&pb, "cy@a.test", "viewer").json()["status"], "shared");
    let (cy_a, cy_b) = (cy.in_org(&a), cy.in_org(&b));
    let version = cy_b.heads(None, 0).json()["version"].as_str().unwrap().to_owned();
    let poll = {
        let cy_b = cy_b.clone();
        std::thread::spawn(move || cy_b.heads(Some(&version), 25).status)
    };
    std::thread::sleep(std::time::Duration::from_millis(500));
    let cy_id = account(&sr, "cy");
    assert_eq!(bea.call("POST", &format!("/v1/admin/members/{cy_id}/disable"), None).status, 200);
    // B's poll and requests end; the same session keeps working in A.
    assert_eq!(poll.join().unwrap(), 404);
    assert_eq!(cy_b.log(&pb, 0).status, 404);
    assert_eq!(c.me(&cy.token).status, 200);
    assert_eq!(cy_a.log(&pa, 0).status, 200);
    assert_eq!(cy.call("GET", "/v1/sr/projects", None).json()["org"], json!(a), "only A is left, so no header is needed");
    assert_eq!(postgres().psql(&sr.db(), &format!("SELECT count(*) FROM sso_logins WHERE account = '{cy_id}' AND revoked")), "0");
    // Re-enabled: that session stays without B for good; a new sign-in has it again.
    assert_eq!(bea.call("POST", &format!("/v1/admin/members/{cy_id}/unblock"), None).status, 200);
    assert_eq!(cy_b.log(&pb, 0).status, 404);
    assert_eq!(c.me(&cy.token).json()["orgs"].as_array().unwrap().len(), 1);
    assert_eq!(sr.api(&token(&c.login("cy"))).in_org(&b).log(&pb, 0).status, 200);
}

#[test]
fn invitations_pick_members_unless_a_guest_is_invited_and_ask_when_several_share_an_email() {
    // Review (low): an invitation shared with every account of the organisation holding the
    // email, guests included, whatever the inviter meant.
    let sr = Sr::start(Blobs::Fs, zitadel_users(), json!({}), json!({"guests": "shared", "provider": zitadel_provider()}));
    let c = sr.env.client();
    let (ana, bea, cy) = (sr.api(&token(&c.login("ana"))), sr.api(&token(&c.login("bea"))), sr.api(&token(&c.login("cy"))));
    let b = org_of(&sr, "200");
    // cy is only a guest of B: a plain invitation does not share with her, and stays pending even
    // through her next sign-in; an explicit guest invitation does.
    let pb = bea.create("B paper");
    assert_eq!(bea.invite(&pb, "cy@a.test", "viewer").json()["status"], "pending");
    assert_eq!(cy.in_org(&b).details(&pb).status, 404);
    let cy = sr.api(&token(&c.login("cy")));
    assert_eq!(cy.in_org(&b).details(&pb).status, 404, "a guest's sign-in does not take a member invitation");
    assert_eq!(bea.invite_guest(&pb, "cy@a.test", "viewer").json()["status"], "shared");
    assert_eq!(cy.in_org(&b).details(&pb).status, 200);
    // Pending invitations to someone who has not signed in yet: a guest's first sign-in takes
    // only the one that invited a guest.
    let (member_only, as_guest) = (bea.create("B second"), bea.create("B third"));
    assert_eq!(bea.invite(&member_only, "gia@a.test", "viewer").json()["status"], "pending");
    assert_eq!(bea.invite_guest(&as_guest, "gia@a.test", "viewer").json()["status"], "pending");
    let gia = sr.api(&token(&c.login("gia")));
    assert_eq!((gia.details(&member_only).status, gia.details(&as_guest).status), (404, 200));
    // Two accounts of A with one verified email: the inviter chooses.
    let (dee, dee2) = (sr.api(&token(&c.login("dee"))), sr.api(&token(&c.login("dee2"))));
    let pa = ana.create("A paper");
    let refused = ana.invite(&pa, "dee@shared.test", "editor");
    assert_eq!((refused.status, refused.json()["code"].as_str()), (409, Some("choose_account")));
    let mut candidates: Vec<String> = refused.json()["candidates"].as_array().unwrap().iter().map(|c| c["account"].as_str().unwrap().to_owned()).collect();
    candidates.sort();
    let mut both = vec![account(&sr, "dee"), account(&sr, "dee2")];
    both.sort();
    assert_eq!(candidates, both);
    assert_eq!((dee.details(&pa).status, dee2.details(&pa).status), (404, 404), "nobody is shared with before the choice");
    let chosen = ana.call("POST", &format!("/v1/sr/projects/{pa}/invitations"), Some(json!({"email": "dee@shared.test", "role": "editor", "account": account(&sr, "dee2")})));
    assert_eq!(chosen.json()["status"], "shared");
    assert_eq!((dee.details(&pa).status, dee2.details(&pa).status), (404, 200));
    let unknown = ana.call("POST", &format!("/v1/sr/projects/{pa}/invitations"), Some(json!({"email": "dee@shared.test", "role": "editor", "account": account(&sr, "ana")})));
    assert_eq!(unknown.status, 404);
}
