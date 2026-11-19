//! The admin area and the audit log (design section 5, slice 10) through the real binary against
//! PostgreSQL, on filesystem and Garage (S3) blobs where storage is involved: every admin route
//! refuses non-administrators; each action is recorded once and in order; the hash chain
//! verifies and `audit verify` finds a changed, a deleted and a truncated row; the triggers
//! refuse changes; retention purges and stays verifiable; concurrent writers on two replicas
//! keep one line; the export holds every project's files; disable, unblock, remove, transfer,
//! open and edit as administrator do what they say; the provider's admin group decides at the
//! next recheck; and in end-to-end mode content routes are refused.
mod support;
use serde_json::{Value, json};
use std::collections::BTreeMap;
use support::{sr::*, sso::*, *};

fn start(blobs: Blobs) -> Sr {
    Sr::start(blobs, people(), json!({}), json!({}))
}
/// Every route of the admin area with a body where it takes one (`P` and `A` stand for a project
/// and an account ID).
const ROUTES: [(&str, &str); 14] = [
    ("GET", "/v1/admin/members"),
    ("PUT", "/v1/admin/members/A/role"),
    ("POST", "/v1/admin/members/A/disable"),
    ("POST", "/v1/admin/members/A/unblock"),
    ("POST", "/v1/admin/members/A/remove"),
    ("GET", "/v1/admin/projects"),
    ("DELETE", "/v1/admin/projects/P"),
    ("POST", "/v1/admin/projects/P/open"),
    ("POST", "/v1/admin/projects/P/edit"),
    ("POST", "/v1/admin/projects/P/owner"),
    ("GET", "/v1/admin/export"),
    ("GET", "/v1/admin/audit"),
    ("GET", "/v1/admin/audit/export"),
    ("GET", "/v1/admin/settings"),
];
fn body_for(method: &str, path: &str, account: &str) -> Option<Value> {
    match (method, path.rsplit('/').next()) {
        ("PUT", Some("role")) => Some(json!({"role": "admin"})),
        ("POST", Some("owner")) => Some(json!({"account": account})),
        ("POST", Some("remove")) => Some(json!({})),
        _ => None,
    }
}
/// The audit log through the admin route, oldest first.
fn events(admin: &Api) -> Vec<Value> {
    let mut all = Vec::new();
    let mut before = None;
    loop {
        let page = admin.call("GET", &format!("/v1/admin/audit?limit=500{}", before.map(|b: i64| format!("&before={b}")).unwrap_or_default()), None);
        assert_eq!(page.status, 200, "{}", String::from_utf8_lossy(&page.body));
        let page = page.json();
        all.extend(page["events"].as_array().unwrap().iter().cloned());
        match page["next"].as_i64() {
            Some(next) => before = Some(next),
            None => break,
        }
    }
    all.reverse();
    all
}
fn actions(events: &[Value]) -> Vec<String> {
    events.iter().map(|e| e["action"].as_str().unwrap().to_owned()).filter(|a| a != "deployment.start").collect()
}
/// `scribyra-sync audit verify [expect]`: (exit code, report).
fn verify(sr: &Sr, expect: Option<&str>) -> (i32, Value) {
    let mut args = vec!["audit", "verify"];
    args.extend(expect);
    let (code, out) = sr.env.service.run(&args);
    (code, serde_json::from_str(out.lines().last().unwrap_or("null")).unwrap_or(Value::Null))
}
fn account_of(api: &Api) -> String {
    api.call("GET", "/v1/sso/me", None).json()["account"].as_str().unwrap().to_owned()
}
fn psql(sr: &Sr, sql: &str) -> String {
    postgres().psql(&sr.db(), sql)
}
/// `psql` that is expected to fail; returns its error output.
fn psql_refused(sr: &Sr, sql: &str) -> String {
    let out = std::process::Command::new("psql").args(["-X", "-q", "-A", "-t", "-v", "ON_ERROR_STOP=1", &sr.db(), "-c", sql]).output().unwrap();
    assert!(!out.status.success(), "{sql} was not refused");
    String::from_utf8_lossy(&out.stderr).into_owned()
}
/// The files of a stored (uncompressed) zip, checked against their CRCs.
fn unzip(bytes: &[u8]) -> BTreeMap<String, Vec<u8>> {
    let u16_at = |i: usize| u16::from_le_bytes(bytes[i..i + 2].try_into().unwrap()) as usize;
    let u32_at = |i: usize| u32::from_le_bytes(bytes[i..i + 4].try_into().unwrap()) as usize;
    let end = (0..=bytes.len() - 22).rev().find(|&i| bytes[i..i + 4] == [0x50, 0x4b, 5, 6]).expect("end of central directory");
    let (count, mut at) = (u16_at(end + 10), u32_at(end + 16));
    let mut files = BTreeMap::new();
    for _ in 0..count {
        assert_eq!(u32_at(at), 0x02014b50);
        let (crc, size, name_len, extra, comment, local) = (u32_at(at + 16) as u32, u32_at(at + 20), u16_at(at + 28), u16_at(at + 30), u16_at(at + 32), u32_at(at + 42));
        let name = String::from_utf8(bytes[at + 46..at + 46 + name_len].to_vec()).unwrap();
        assert_eq!((u32_at(local), u16_at(local + 8)), (0x04034b50, 0), "{name}: a stored local header");
        let data = local + 30 + u16_at(local + 26) + u16_at(local + 28);
        let content = bytes[data..data + size].to_vec();
        assert_eq!(crc32fast::hash(&content), crc, "{name}");
        files.insert(name, content);
        at += 46 + name_len + extra + comment;
    }
    files
}

fn walk(dir: &std::path::Path) -> Vec<std::path::PathBuf> {
    let mut out = Vec::new();
    for entry in std::fs::read_dir(dir).into_iter().flatten().flatten() {
        let path = entry.path();
        if path.is_dir() {
            out.extend(walk(&path));
        } else {
            out.push(path);
        }
    }
    out
}

#[test]
fn every_admin_route_refuses_everyone_but_administrators() {
    let sr = start(Blobs::Fs);
    let alice = sr.api(&sr.login("alice"));
    let ben = sr.api(&sr.login("ben"));
    let p = ben.create("Ben's");
    let ben_account = account_of(&ben);
    for (method, template) in ROUTES {
        let path = template.replace("/P", &format!("/{p}")).replace("/A/", &format!("/{ben_account}/"));
        let body = body_for(method, &path, &ben_account);
        let reply = ben.call(method, &path, body.clone());
        assert_eq!(reply.status, 403, "a member: {method} {path}");
        let anonymous = request(method, &format!("{}{path}", sr.url()), None, &[("Content-Type", "application/json".into())], body.map(|b| b.to_string().into_bytes()).unwrap_or_default());
        assert_eq!(anonymous.status, 401, "nobody: {method} {path}");
    }
    // Nothing a refused call asked for happened.
    assert_eq!(ben.details(&p).status, 200);
    assert_eq!(psql(&sr, "SELECT count(*) FROM audit_events WHERE action IN ('project.admin_open', 'project.deleted', 'account.disabled', 'export.everything', 'audit.export')"), "0");
    // The administrator reaches every read route.
    for path in ["/v1/admin/members", "/v1/admin/projects", "/v1/admin/audit", "/v1/admin/settings"] {
        assert_eq!(alice.call("GET", path, None).status, 200, "{path}");
    }
    let settings = alice.call("GET", "/v1/admin/settings", None);
    let text = String::from_utf8_lossy(&settings.body);
    assert!(text.contains("\"Test Lab\"") && !text.contains("client_secret") && !text.contains(&std::fs::read_to_string(sr.env.idp.secret_file()).unwrap().trim().to_owned()), "{text}");
}

#[test]
fn each_action_is_recorded_once_in_order_and_the_chain_verifies() {
    for blobs in BOTH {
        let sr = start(blobs);
        let alice = sr.api(&sr.login("alice"));
        let ben = sr.api(&sr.login("ben"));
        let (alice_id, ben_id) = (account_of(&alice), account_of(&ben));
        let p = ben.create("Paper");
        let doc = Project::new();
        assert_eq!(ben.append(&p, "b", 1, &doc.add_text("f1", "main.tex", None, "SECRET_CONTENT")).status, 201);
        // An invitation for someone who has not signed in waits; then cat signs in and takes it.
        assert_eq!(ben.invite(&p, "cat@example.org", "editor").json()["status"], "pending");
        let zed = ben.invite(&p, "zed@example.org", "viewer").json()["invitation"]["id"].as_str().unwrap().to_owned();
        assert_eq!(ben.call("DELETE", &format!("/v1/sr/projects/{p}/invitations/{zed}"), None).status, 204);
        let cat = sr.api(&sr.login("cat"));
        let cat_id = account_of(&cat);
        assert_eq!(ben.call("PUT", &format!("/v1/sr/projects/{p}/members/{cat_id}"), Some(json!({"role": "reviewer"}))).status, 200);
        let dan = sr.api(&sr.login("dan"));
        let dan_id = account_of(&dan);
        assert_eq!(ben.invite(&p, "dan@example.org", "viewer").status, 201);
        assert_eq!(ben.call("DELETE", &format!("/v1/sr/projects/{p}/members/{dan_id}"), None).status, 204);
        assert_eq!(ben.call("PATCH", &format!("/v1/sr/projects/{p}"), Some(json!({"name": "Paper 2"}))).status, 200);
        // The administrator: open, edit, transfer, roles, disable, unblock, remove, delete, export.
        assert_eq!(alice.call("POST", &format!("/v1/admin/projects/{p}/open"), None).status, 200);
        assert_eq!(alice.call("POST", &format!("/v1/admin/projects/{p}/edit"), None).status, 200);
        assert_eq!(alice.call("POST", &format!("/v1/admin/projects/{p}/owner"), Some(json!({"account": cat_id}))).status, 200);
        assert_eq!(alice.call("PUT", &format!("/v1/admin/members/{dan_id}/role"), Some(json!({"role": "admin"}))).status, 200);
        assert_eq!(alice.call("POST", &format!("/v1/admin/members/{dan_id}/disable"), None).status, 200);
        assert_eq!(alice.call("POST", &format!("/v1/admin/members/{dan_id}/unblock"), None).status, 200);
        assert_eq!(dan.call("GET", "/v1/sr/projects", None).status, 401, "disabling ended dan's session");
        let dan = sr.api(&sr.login("dan"));
        let q = dan.create("Dan's");
        assert_eq!(alice.call("POST", &format!("/v1/admin/members/{dan_id}/remove"), Some(json!({"transfer": ben_id}))).status, 200);
        assert_eq!(alice.call("DELETE", &format!("/v1/admin/projects/{q}"), None).status, 204);
        assert_eq!(alice.call("GET", "/v1/admin/export", None).status, 200);
        assert_eq!(alice.call("GET", "/v1/admin/audit/export?format=csv", None).status, 200);
        let (outcome, verifier) = sr.env.client().sign_in("dan");
        let Outcome::Grant { grant, .. } = outcome else { panic!("the provider still admits dan") };
        assert_eq!(sr.env.client().redeem(&grant, &verifier).status, 403, "a removed account cannot sign in");
        // Members see administrator actions on their project.
        let activity: Vec<String> = alice.details(&p).json()["adminActivity"].as_array().unwrap().iter().map(|a| a["action"].as_str().unwrap().to_owned()).collect();
        assert_eq!(activity, ["project.transferred", "project.admin_edit", "project.admin_open"]);
        assert_eq!(cat.call("POST", "/v1/sso/logout", Some(json!({}))).status, 200);

        let log = events(&alice);
        let expected = [
            "account.created", "session.sign_in", // alice
            "account.created", "session.sign_in", // ben
            "project.created",
            "invitation.created", "invitation.created", "invitation.withdrawn",
            "account.created", "session.sign_in", "invitation.accepted", // cat
            "share.changed",
            "account.created", "session.sign_in", // dan
            "share.created", "share.removed", "project.renamed",
            "project.admin_open", "project.admin_edit", "project.transferred",
            "account.role_changed", "account.disabled", "account.unblocked",
            "session.sign_in", "project.created", // dan again
            "project.transferred", "account.removed", "project.deleted",
            "export.everything", "audit.export", "session.refused", "session.sign_out",
        ];
        assert_eq!(actions(&log), expected, "{blobs:?}");
        // Sequence numbers are gap-free and the first event is the deployment's start.
        assert_eq!(log[0]["action"], "deployment.start");
        assert!(log[0]["detail"]["policy"].as_str().is_some_and(|p| p.len() == 64));
        assert!(log.windows(2).all(|w| w[1]["seq"].as_i64().unwrap() == w[0]["seq"].as_i64().unwrap() + 1 && w[1]["prev"] == w[0]["hash"]));
        // Who and what: actors, targets and details.
        let find = |action: &str| log.iter().find(|e| e["action"] == action).unwrap().clone();
        assert_eq!((find("project.admin_open")["actor"].as_str(), find("project.admin_open")["target"].as_str()), (Some(alice_id.as_str()), Some(p.as_str())));
        assert_eq!(find("project.admin_open")["actorEmail"], "alice@example.org");
        assert_eq!(find("account.role_changed")["detail"], json!({"from": "member", "to": "admin", "by": "admin"}));
        assert_eq!(find("account.removed")["detail"]["transferredTo"], ben_id);
        assert_eq!(find("session.sign_in")["ip"], "127.0.0.1");
        let removed_transfer = log.iter().filter(|e| e["action"] == "project.transferred").nth(1).unwrap();
        assert_eq!((removed_transfer["target"].as_str(), removed_transfer["detail"]["to"].as_str()), (Some(q.as_str()), Some(ben_id.as_str())));
        assert_eq!(find("project.deleted")["detail"]["admin"], true);
        assert_eq!((find("session.refused")["target"].as_str(), find("session.refused")["detail"]["reason"].as_str()), (Some(dan_id.as_str()), Some("account_removed")));
        // Never content, tokens or invitees' emails.
        let dump = psql(&sr, "SELECT string_agg(e::text, ' ') FROM audit_events e");
        for secret in ["SECRET_CONTENT", alice.token.as_str(), ben.token.as_str(), "zed@example.org", "cat@example.org"] {
            assert!(!dump.contains(secret), "{secret} is in the audit log");
        }
        // The chain verifies, also against the head an export carries.
        let head = alice.call("GET", "/v1/admin/audit?limit=1", None).json()["head"].clone();
        let (code, report) = verify(&sr, Some(&format!("{}:{}", head["seq"], head["hash"].as_str().unwrap())));
        assert_eq!((code, report["ok"].as_bool()), (0, Some(true)), "{report}");
        let (code, _) = verify(&sr, Some(&format!("{}:{}", head["seq"], "0".repeat(64))));
        assert_eq!(code, 1, "a different head is reported");
    }
}

#[test]
fn audit_verify_finds_changed_and_deleted_rows_and_the_triggers_refuse_changes() {
    let sr = start(Blobs::Fs);
    let alice = sr.api(&sr.login("alice"));
    for n in 0..5 {
        alice.create(&format!("P{n}"));
    }
    assert_eq!(verify(&sr, None).0, 0);
    // The service's own connection cannot change the log: no update, delete, truncate or insert
    // past the function, and the head moves only with an append.
    for sql in [
        "UPDATE audit_events SET detail = '{}' WHERE seq = 3",
        "DELETE FROM audit_events WHERE seq = 3",
        "TRUNCATE audit_events",
        "INSERT INTO audit_events (seq, time, actor, action, prev, hash) VALUES (999, now(), 'system', 'x.y', repeat('0', 64), repeat('0', 64))",
        "UPDATE audit_head SET seq = 1",
        "DELETE FROM audit_head",
    ] {
        assert!(psql_refused(&sr, sql).contains("append-only") || psql_refused(&sr, sql).contains("only with an append"), "{sql}");
    }
    // A database superuser can disable the triggers; the chain then shows what changed.
    let tamper = |sql: &str| psql(&sr, &format!("BEGIN; ALTER TABLE audit_events DISABLE TRIGGER audit_events_guard; {sql}; ALTER TABLE audit_events ENABLE TRIGGER audit_events_guard; COMMIT;"));
    tamper("UPDATE audit_events SET detail = '{\"forged\": true}' WHERE seq = 4");
    let (code, report) = verify(&sr, None);
    assert_eq!(code, 1);
    assert_eq!(report["problems"][0], json!({"seq": 4, "problem": "the hash does not match the event (changed)"}), "{report}");
    tamper("UPDATE audit_events SET detail = '{}' WHERE seq = 4");
    assert_eq!(verify(&sr, None).0, 0, "restored");
    tamper("DELETE FROM audit_events WHERE seq = 5");
    let report = verify(&sr, None).1;
    assert_eq!(report["problems"].as_array().unwrap().iter().map(|p| p["problem"].as_str().unwrap()).collect::<Vec<_>>(), ["events 5-5 are missing", "prev is not the previous event's hash"]);
    // Deleting the newest events leaves a head that names something gone.
    let sr2 = start(Blobs::Fs);
    let alice2 = sr2.api(&sr2.login("alice"));
    alice2.create("Q");
    let last = psql(&sr2, "SELECT max(seq) FROM audit_events");
    postgres().psql(&sr2.db(), &format!("BEGIN; ALTER TABLE audit_events DISABLE TRIGGER audit_events_guard; DELETE FROM audit_events WHERE seq = {last}; ALTER TABLE audit_events ENABLE TRIGGER audit_events_guard; COMMIT;"));
    let report = verify(&sr2, None).1;
    assert_eq!(report["problems"][0]["problem"], "the head does not name the last event (events after it were deleted)", "{report}");
    // And deleting the oldest leaves a start that nothing anchors.
    postgres().psql(&sr2.db(), "BEGIN; ALTER TABLE audit_events DISABLE TRIGGER audit_events_guard; DELETE FROM audit_events WHERE seq = 1; ALTER TABLE audit_events ENABLE TRIGGER audit_events_guard; COMMIT;");
    let report = verify(&sr2, None).1;
    assert_eq!((report["ok"].as_bool(), report["anchored"].as_bool()), (Some(false), Some(false)), "{report}");
}

#[test]
fn the_service_database_user_cannot_change_the_audit_log() {
    // Review M1: the triggers trusted a session setting anyone can set (`set_config` then
    // DELETE succeeded), and the service's user owned the tables (it could disable the
    // triggers). The service here runs as an ordinary user; the operator created
    // `scribyra_audit_owner` and let that user SET ROLE to it for the migration, then revoked it.
    let user = format!("svc_{}", random_hex(6));
    let name = format!("d_{}", random_hex(6));
    let su = postgres().url("postgres");
    postgres().psql(&su, "DO $$ BEGIN CREATE ROLE scribyra_audit_owner NOLOGIN; EXCEPTION WHEN duplicate_object OR unique_violation THEN NULL; END $$");
    postgres().psql(&su, &format!("CREATE ROLE {user} LOGIN"));
    postgres().psql(&su, &format!("GRANT scribyra_audit_owner TO {user} WITH INHERIT FALSE, SET TRUE"));
    postgres().psql(&su, &format!("CREATE DATABASE {name} OWNER {user}"));
    let url = postgres().url(&name).replace("postgres@", &format!("{user}@"));
    let mut sr = Sr::start(Blobs::Fs, people(), json!({"database_url": url}), json!({}));
    assert!(sr.env.service.logs.lock().unwrap().contains("\"state\":\"protected; reachable: this database user is a member of scribyra_audit_owner\""));
    postgres().psql(&su, &format!("REVOKE scribyra_audit_owner FROM {user}"));
    let alice = sr.api(&sr.login("alice"));
    alice.create("P");
    let before = psql(&sr, "SELECT count(*) || ' ' || max(seq) FROM audit_events");
    for sql in [
        "SELECT set_config('scribyra.audit_writer', 'purge', false); DELETE FROM audit_events",
        "SELECT set_config('scribyra.audit_writer', 'append', false); UPDATE audit_head SET seq = 1",
        "DELETE FROM audit_events WHERE seq = 2",
        "UPDATE audit_events SET detail = '{}' WHERE seq = 2",
        "TRUNCATE audit_events",
        "INSERT INTO audit_events SELECT * FROM audit_events WHERE seq = 1",
        "ALTER TABLE audit_events DISABLE TRIGGER audit_events_guard",
        "ALTER TABLE audit_events DISABLE TRIGGER ALL",
        "DROP TRIGGER audit_events_guard ON audit_events",
        "UPDATE audit_settings SET floor_seconds = 0",
        "CREATE OR REPLACE FUNCTION audit_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN OLD; END $$",
        "ALTER TABLE audit_events OWNER TO CURRENT_USER",
        "SET ROLE scribyra_audit_owner",
        "SELECT audit_purge(now())",
    ] {
        let refused = psql_refused(&sr, sql);
        assert!(refused.contains("permission denied") || refused.contains("must be owner") || refused.contains("a purge cannot delete newer ones"), "{sql}: {refused}");
    }
    assert_eq!(psql(&sr, "SELECT count(*) || ' ' || max(seq) FROM audit_events"), before);
    // It still appends (through the owner's functions), reads, exports and verifies.
    alice.create("Q");
    assert_eq!(alice.call("GET", "/v1/admin/audit/export", None).status, 200);
    assert_eq!(verify(&sr, None).0, 0);
    assert_eq!(psql(&sr, "SELECT audit_protect()"), "protected");
    // A restart keeps it so.
    sr.env.service.stop();
    sr.env.service.start().unwrap();
    assert!(sr.env.service.logs.lock().unwrap().contains("\"state\":\"protected\""));
    assert_eq!(sr.env.service.run(&["migrate"]).1.contains("\"auditProtection\":\"protected\""), true);
}

#[test]
fn retention_purges_old_events_records_it_and_stays_verifiable() {
    let mut sr = Sr::start(Blobs::Fs, people(), json!({"audit_retention_seconds": 3, "audit_purge_seconds": 1}), json!({}));
    // The service keeps events at least 30 days; only the audit tables' owner (here the
    // superuser) can lower that floor, which a test does to purge within seconds.
    assert_eq!(psql(&sr, "SELECT retention_seconds FROM audit_settings"), (30 * 86400).to_string());
    psql(&sr, "UPDATE audit_settings SET floor_seconds = 1");
    assert_eq!(psql(&sr, "SELECT audit_set_retention(3)"), "3");
    let alice = sr.api(&sr.login("alice"));
    alice.create("Before");
    let before: i64 = psql(&sr, "SELECT max(seq) FROM audit_events").parse().unwrap();
    // Purges run every second and delete what is older than three: a prefix of the chain each time.
    eventually("the first events' purge", || psql(&sr, "SELECT min(seq) FROM audit_events").parse::<i64>().unwrap() > before);
    let purges: Vec<Value> = events(&alice).into_iter().filter(|e| e["action"] == "audit.purge").collect();
    assert!(!purges.is_empty() && purges.iter().all(|p| p["actor"] == "system" && p["detail"]["count"].as_i64() > Some(0) && p["detail"]["last_hash"].as_str().is_some_and(|h| h.len() == 64)));
    let (code, report) = verify(&sr, None);
    assert_eq!((code, report["anchored"].as_bool()), (0, Some(true)), "{report}");
    // New events keep chaining after purges.
    alice.create("After");
    assert_eq!(verify(&sr, None).0, 0);
    // With the service stopped, deleting the first event by hand (not a purge) is found: no purge
    // anchors what is left.
    sr.env.service.stop();
    let first = psql(&sr, "SELECT min(seq) FROM audit_events");
    postgres().psql(&sr.db(), &format!("BEGIN; ALTER TABLE audit_events DISABLE TRIGGER audit_events_guard; DELETE FROM audit_events WHERE seq = {first}; ALTER TABLE audit_events ENABLE TRIGGER audit_events_guard; COMMIT;"));
    let (code, report) = verify(&sr, None);
    assert_eq!((code, report["anchored"].as_bool()), (1, Some(false)), "{report}");
}

#[test]
fn a_purge_cannot_delete_young_events_and_verify_flags_one_that_did() {
    let sr = start(Blobs::Fs);
    let alice = sr.api(&sr.login("alice"));
    alice.create("P1");
    let head = alice.call("GET", "/v1/admin/audit?limit=1", None).json()["head"].clone();
    let exported = format!("{}:{}", head["seq"], head["hash"].as_str().unwrap());
    alice.create("P2");
    // Review H2: `audit_purge(now() + '1s')` deleted every event, and verify with an exported
    // head still said ok. The retention in the database (30 days at least) now bounds a purge.
    for sql in ["SELECT audit_purge(now() + interval '1 second')", "SELECT audit_purge(now() - interval '29 days')", "SELECT audit_purge(NULL)", "SELECT audit_purge_expired() + audit_purge(now() + interval '1 day')"] {
        assert!(psql_refused(&sr, sql).contains("a purge cannot delete newer ones"), "{sql}");
    }
    assert_eq!(psql(&sr, "SELECT audit_set_retention(1)"), (30 * 86400).to_string(), "not below the floor");
    assert_eq!(psql(&sr, "SELECT audit_purge_expired()"), "0");
    assert_eq!(verify(&sr, Some(&exported)).0, 0);
    // Whoever can lower the floor (the tables' owner, a superuser) can still purge young events;
    // verify reports the purge and that the exported event is gone.
    psql(&sr, "UPDATE audit_settings SET floor_seconds = 0");
    psql(&sr, "SELECT audit_set_retention(1)");
    std::thread::sleep(std::time::Duration::from_millis(1100));
    assert!(psql(&sr, "SELECT audit_purge(now() - interval '1 second')").parse::<i64>().unwrap() > 3);
    let (code, report) = verify(&sr, Some(&exported));
    let problems: Vec<&str> = report["problems"].as_array().unwrap().iter().map(|p| p["problem"].as_str().unwrap()).collect();
    assert_eq!((code, report["anchored"].as_bool()), (1, Some(true)), "{report}");
    assert!(problems.contains(&"the purge deleted events newer than the retention allows"), "{report}");
    assert!(problems.contains(&"the given event was purged and is not the anchor the log starts from"), "{report}");
    // A purge event appended by an account (not the service) anchors nothing.
    let sr = start(Blobs::Fs);
    let alice = sr.api(&sr.login("alice"));
    alice.create("Q");
    let (k, hash) = (psql(&sr, "SELECT max(seq) - 1 FROM audit_events"), psql(&sr, "SELECT hash FROM audit_events WHERE seq = (SELECT max(seq) - 1 FROM audit_events)"));
    psql(&sr, &format!("BEGIN; ALTER TABLE audit_events DISABLE TRIGGER audit_events_guard; DELETE FROM audit_events WHERE seq <= {k}; ALTER TABLE audit_events ENABLE TRIGGER audit_events_guard; COMMIT;"));
    psql(&sr, &format!("SELECT audit_append('{}', NULL, 'audit.purge', 'audit', NULL, jsonb_build_object('count', {k}, 'last_seq', {k}, 'last_hash', '{hash}', 'before', 0))", account_of(&alice)));
    let (code, report) = verify(&sr, None);
    assert_eq!((code, report["anchored"].as_bool()), (1, Some(false)), "{report}");
}

#[test]
fn concurrent_writers_on_two_replicas_keep_one_line() {
    let sr = start(Blobs::S3);
    let replica = sr.replica();
    let tokens: Vec<String> = ["alice", "ben", "cat", "dan"].iter().map(|u| sr.login(u)).collect();
    let threads: Vec<_> = tokens
        .iter()
        .enumerate()
        .flat_map(|(i, token)| {
            [sr.url(), replica.url.clone()].into_iter().map(move |base| {
                let api = Api { base, token: token.clone() };
                std::thread::spawn(move || {
                    for n in 0..10 {
                        api.create(&format!("{i}-{n}"));
                    }
                })
            })
        })
        .collect();
    for t in threads {
        t.join().unwrap();
    }
    assert_eq!(psql(&sr, "SELECT count(*) FROM audit_events WHERE action = 'project.created'"), "80");
    assert_eq!(psql(&sr, "SELECT max(seq) - min(seq) + 1 = count(*) FROM audit_events"), "t");
    let (code, report) = verify(&sr, None);
    assert_eq!(code, 0, "{report}");
    assert_eq!(psql(&sr, "SELECT count(*) FROM audit_events WHERE action = 'deployment.start'"), "2", "each replica records its start");
}

#[test]
fn the_export_holds_every_project_the_members_and_the_audit_log() {
    for blobs in BOTH {
        let sr = start(blobs);
        let alice = sr.api(&sr.login("alice"));
        let ben = sr.api(&sr.login("ben"));
        let cat = sr.api(&sr.login("cat"));
        let image: Vec<u8> = (0..70_000u32).map(|i| (i % 251) as u8).collect();
        let p = ben.create("Ben/Paper");
        let doc = Project::new();
        assert_eq!(ben.append(&p, "b", 1, &doc.add_folder("d", "chapters")).status, 201);
        assert_eq!(ben.append(&p, "b", 2, &doc.add_text("t1", "intro.tex", Some("d"), "Hello export ü")).status, 201);
        assert_eq!(ben.put_object(&p, &image).status, 201);
        assert_eq!(ben.append(&p, "b", 3, &doc.add_asset("a1", "figure.bin", &image)).status, 201);
        let q = cat.create("Cat's");
        let other = Project::new();
        assert_eq!(cat.append(&q, "c", 1, &other.add_text("m", "main.tex", None, "\\documentclass{article}")).status, 201);
        let gone = cat.create("Deleted");
        assert_eq!(cat.call("DELETE", &format!("/v1/sr/projects/{gone}"), None).status, 204);
        let reply = alice.call("GET", "/v1/admin/export", None);
        assert_eq!((reply.status, reply.header("content-type")), (200, Some("application/zip")), "{blobs:?}");
        let files = unzip(&reply.body);
        let (pf, qf) = (format!("projects/Ben_Paper-{}", &p[..8]), format!("projects/Cat's-{}", &q[..8]));
        assert_eq!(files[&format!("{pf}/chapters/intro.tex")], "Hello export ü".as_bytes());
        assert_eq!(files[&format!("{pf}/figure.bin")], image);
        assert_eq!(files[&format!("{qf}/main.tex")], b"\\documentclass{article}");
        let manifest: Value = serde_json::from_slice(&files["projects.json"]).unwrap();
        assert_eq!(manifest.as_array().unwrap().len(), 2, "the deleted project is not exported");
        let members: Value = serde_json::from_slice(&files["members.json"]).unwrap();
        let emails: Vec<&str> = members.as_array().unwrap().iter().filter_map(|m| m["email"].as_str()).collect();
        assert_eq!(emails, ["alice@example.org", "ben@example.org", "cat@example.org"]);
        let log = String::from_utf8(files["audit.jsonl"].clone()).unwrap();
        let lines: Vec<Value> = log.lines().map(|l| serde_json::from_str(l).unwrap()).collect();
        let head = lines.last().unwrap()["head"].clone();
        assert_eq!(lines[lines.len() - 2]["action"], "export.everything");
        assert_eq!(head["hash"], lines[lines.len() - 2]["hash"]);
        assert_eq!(verify(&sr, Some(&format!("{}:{}", head["seq"], head["hash"].as_str().unwrap()))).0, 0);
        assert_eq!(files.len(), 6, "{:?}", files.keys().collect::<Vec<_>>());
        // The audit export: JSON lines and CSV, filtered, with the head.
        let jsonl = alice.call("GET", &format!("/v1/admin/audit/export?action=project&target={p}"), None);
        let rows: Vec<Value> = String::from_utf8_lossy(&jsonl.body).lines().map(|l| serde_json::from_str(l).unwrap()).collect();
        assert_eq!(rows.iter().filter_map(|r| r["action"].as_str()).collect::<Vec<_>>(), ["project.created"]);
        assert!(jsonl.header("scribyra-audit-head").is_some_and(|h| h.ends_with(rows.last().unwrap()["head"]["hash"].as_str().unwrap())));
        let csv = alice.call("GET", "/v1/admin/audit/export?format=csv&action=session.sign_in", None);
        let text = String::from_utf8_lossy(&csv.body);
        assert!(text.starts_with("seq,time,actor,actor_name,actor_email,ip,action,"), "{text}");
        assert_eq!(text.lines().filter(|l| l.contains("\"session.sign_in\"")).count(), 3);
        assert!(text.lines().last().unwrap().starts_with("# head "));
    }
}

#[test]
fn the_export_never_writes_a_path_outside_a_project_folder() {
    // Review H1: an editor names files `../../../../../tmp/x.sh` and `..\\..\\evil.bat`; the
    // export wrote them as zip entries an unzip would place outside the export.
    let sr = start(Blobs::Fs);
    let alice = sr.api(&sr.login("alice"));
    let ben = sr.api(&sr.login("ben"));
    let cat = sr.api(&sr.login("cat"));
    let p = ben.create("Paper");
    assert_eq!(ben.invite(&p, "cat@example.org", "editor").status, 201);
    let doc = Project::new();
    assert_eq!(ben.append(&p, "b", 1, &doc.add_text("ok", "main.tex", None, "fine")).status, 201);
    let evil = ["../../../../../tmp/x.sh", "..\\..\\evil.bat", "/etc/cron.d/x", "C:x", "a\u{1b}b"];
    for (i, name) in evil.iter().enumerate() {
        assert_eq!(cat.append(&p, "c", i as i64 + 1, &doc.add_text(&format!("e{i}"), name, None, "#!/bin/sh")).status, 201, "{name}");
    }
    let reply = alice.call("GET", "/v1/admin/export", None);
    assert_eq!(reply.status, 200);
    let files = unzip(&reply.body);
    for name in files.keys() {
        assert!(!name.contains('\\') && !name.starts_with('/') && name.split('/').all(|s| !s.is_empty() && s != "." && s != "..") && !name.chars().any(char::is_control), "{name:?}");
    }
    let folder = format!("projects/Paper-{}", &p[..8]);
    assert_eq!(files.keys().filter(|k| k.starts_with("projects/")).cloned().collect::<Vec<_>>(), [format!("{folder}/main.tex")], "only the valid file");
    let manifest: Value = serde_json::from_slice(&files["projects.json"]).unwrap();
    let missing = manifest[0]["missing"].as_array().unwrap();
    assert_eq!(missing.len(), 5, "{missing:?}");
}

#[test]
fn disable_unblock_remove_transfer_open_and_edit_as_administrator() {
    let sr = start(Blobs::Fs);
    let alice = sr.api(&sr.login("alice"));
    let ben = sr.api(&sr.login("ben"));
    let cat = sr.api(&sr.login("cat"));
    let (alice_id, ben_id, cat_id) = (account_of(&alice), account_of(&ben), account_of(&cat));
    let p = ben.create("Ben's paper");
    let doc = Project::new();
    assert_eq!(ben.append(&p, "b", 1, &doc.add_text("f", "main.tex", None, "hello")).status, 201);
    assert_eq!(ben.invite(&p, "cat@example.org", "editor").status, 201);
    let shared = cat.create("Cat shares with Ben");
    assert_eq!(cat.invite(&shared, "ben@example.org", "viewer").status, 201);

    // Open as administrator: nothing without it, read-only with it, members see it.
    assert_eq!(alice.log(&p, 0).status, 404);
    let opened = alice.call("POST", &format!("/v1/admin/projects/{p}/open"), None);
    assert_eq!((opened.status, opened.json()["role"].as_str()), (200, Some("admin")));
    assert_eq!(alice.log(&p, 0).frames().len(), 1);
    assert_eq!(alice.append(&p, "a", 1, &doc.type_text("f", "!")).status, 403);
    assert_eq!(alice.heads(None, 0).json()["projects"][&p]["role"], "admin");
    assert_eq!(alice.call("GET", "/v1/sr/projects", None).json()["projects"][0]["role"], "admin");
    let activity = ben.details(&p).json()["adminActivity"].clone();
    assert_eq!(activity[0]["action"], "project.admin_open");
    assert!(ben.call("GET", "/v1/sr/projects", None).json()["projects"].as_array().unwrap().iter().any(|x| x["id"] == p && x["adminOpened"].is_i64()));
    // The open lasts a limited time.
    psql(&sr, "UPDATE sr_admin_opens SET until = now() - interval '1 second'");
    assert_eq!(alice.log(&p, 0).status, 404);
    // Edit as administrator: an explicit editor share.
    assert_eq!(alice.call("POST", &format!("/v1/admin/projects/{p}/edit"), None).status, 200);
    assert_eq!(alice.append(&p, "a", 1, &doc.type_text("f", "!")).status, 201);
    assert_eq!(ben.details(&p).json()["members"].as_array().unwrap().iter().filter(|m| m["account"] == alice_id && m["role"] == "editor").count(), 1);

    // Roles: an administrator makes a member an administrator at once; the configuration's own
    // administrators and guests are not the admin area's to change, nor is one's own account.
    assert_eq!(cat.call("GET", "/v1/admin/members", None).status, 403);
    assert_eq!(alice.call("PUT", &format!("/v1/admin/members/{cat_id}/role"), Some(json!({"role": "admin"}))).json()["role"], "admin");
    assert_eq!(cat.call("GET", "/v1/admin/members", None).status, 200);
    assert_eq!(cat.call("PUT", &format!("/v1/admin/members/{alice_id}/role"), Some(json!({"role": "member"}))).status, 409);
    assert_eq!(alice.call("PUT", &format!("/v1/admin/members/{alice_id}/role"), Some(json!({"role": "member"}))).status, 409);
    assert_eq!(alice.call("PUT", &format!("/v1/admin/members/{cat_id}/role"), Some(json!({"role": "guest"}))).status, 400);
    assert_eq!(alice.call("PUT", &format!("/v1/admin/members/{cat_id}/role"), Some(json!({"role": "member"}))).json()["role"], "member");
    assert_eq!(cat.call("GET", "/v1/admin/members", None).status, 403);
    // A grant survives signing in again (the provider does not take it away).
    alice.call("PUT", &format!("/v1/admin/members/{cat_id}/role"), Some(json!({"role": "admin"})));
    let cat = sr.api(&sr.login("cat"));
    assert_eq!(cat.call("GET", "/v1/sso/me", None).json()["role"], "admin");
    alice.call("PUT", &format!("/v1/admin/members/{cat_id}/role"), Some(json!({"role": "member"})));

    // Disable: sessions end at once (a waiting heads poll too), sign-in refused until unblocked.
    let version = cat.heads(None, 0).json()["version"].as_str().unwrap().to_owned();
    let poll = {
        let cat = cat.clone();
        std::thread::spawn(move || cat.heads(Some(&version), 20).status)
    };
    std::thread::sleep(std::time::Duration::from_millis(500));
    let disabled = alice.call("POST", &format!("/v1/admin/members/{cat_id}/disable"), None);
    assert_eq!(disabled.json()["state"], "disabled");
    assert_eq!(poll.join().unwrap(), 401);
    assert_eq!(cat.call("GET", "/v1/sr/projects", None).status, 401);
    let (outcome, verifier) = sr.env.client().sign_in("cat");
    let Outcome::Grant { grant, .. } = outcome else { panic!("{outcome:?}") };
    assert_eq!(sr.env.client().redeem(&grant, &verifier).status, 403);
    assert_eq!(alice.call("POST", &format!("/v1/admin/members/{alice_id}/disable"), None).status, 409, "not oneself");
    assert_eq!(alice.call("POST", &format!("/v1/admin/members/{cat_id}/unblock"), None).json()["state"], "active");
    let cat = sr.api(&sr.login("cat"));

    // Transfer: the new owner owns it, the previous owner keeps editing.
    assert_eq!(alice.call("POST", &format!("/v1/admin/projects/{p}/owner"), Some(json!({"account": cat_id}))).status, 200);
    let details = cat.details(&p).json();
    assert_eq!((details["role"].as_str(), details["owner"]["account"].as_str()), (Some("owner"), Some(cat_id.as_str())));
    assert_eq!(ben.details(&p).json()["role"], "editor");
    assert_eq!(alice.call("POST", &format!("/v1/admin/projects/{p}/owner"), Some(json!({"account": random_hex(32)}))).status, 404);

    // Remove ben: his session ends, his shares go, what he owns passes to cat.
    let mine = ben.create("Ben's own");
    assert_eq!(alice.call("POST", &format!("/v1/admin/members/{ben_id}/remove"), Some(json!({"transfer": ben_id}))).status, 400);
    let removed = alice.call("POST", &format!("/v1/admin/members/{ben_id}/remove"), Some(json!({"transfer": cat_id})));
    assert_eq!((removed.status, removed.json()["projects"].as_i64()), (200, Some(1)));
    assert_eq!(ben.call("GET", "/v1/sr/projects", None).status, 401);
    assert_eq!(cat.details(&mine).json()["role"], "owner");
    assert!(cat.details(&shared).json()["members"].as_array().unwrap().iter().all(|m| m["account"] != ben_id), "his shares are gone");
    assert!(cat.details(&p).json()["members"].as_array().unwrap().iter().all(|m| m["account"] != ben_id));
    let (outcome, verifier) = sr.env.client().sign_in("ben");
    let Outcome::Grant { grant, .. } = outcome else { panic!("{outcome:?}") };
    let refused = sr.env.client().redeem(&grant, &verifier);
    assert_eq!((refused.status, refused.json()["error"].as_str()), (403, Some("this account was removed")));
    let listed = alice.call("GET", "/v1/admin/members", None).json();
    assert!(listed["members"].as_array().unwrap().iter().all(|m| m["account"] != ben_id), "removed accounts are listed only on request");
    let all = alice.call("GET", "/v1/admin/members?removed=true", None).json();
    let ben_row = all["members"].as_array().unwrap().iter().find(|m| m["account"] == ben_id).unwrap().clone();
    assert_eq!((ben_row["state"].as_str(), ben_row["email"].as_str()), (Some("removed"), Some("ben@example.org")));
    // The list of all projects names owners, members, sizes; the admin deletes one.
    let projects = alice.call("GET", "/v1/admin/projects", None).json();
    let row = projects["projects"].as_array().unwrap().iter().find(|x| x["id"] == p).unwrap().clone();
    assert_eq!((row["owner"]["email"].as_str(), row["members"].as_array().unwrap().len()), (Some("cat@example.org"), 1));
    assert!(row["size"].as_i64().unwrap() > 0);
    assert_eq!(alice.call("DELETE", &format!("/v1/admin/projects/{p}"), None).status, 204);
    assert_eq!(cat.details(&p).status, 404);
    assert_eq!(alice.call("DELETE", &format!("/v1/admin/projects/{p}"), None).status, 404);
}

#[test]
fn removal_from_the_admin_group_at_the_provider_demotes_at_the_next_recheck() {
    let sr = Sr::start(
        Blobs::Fs,
        people(),
        json!({"sso_recheck_tick_seconds": 1}),
        json!({"provider": {"offline_access": true, "groups_claim": "groups", "admin_groups": ["scribyra-admins"], "recheck_minutes": 1}}),
    );
    assert_eq!(sr.env.idp.control("groups?user=erin&groups=scribyra-admins").status, 200);
    let erin = sr.api(&sr.login("erin"));
    assert_eq!(erin.call("GET", "/v1/admin/members", None).status, 200);
    // The group's administrator cannot be demoted in the admin area: the provider decides.
    let alice = sr.api(&sr.login("alice"));
    let erin_id = account_of(&erin);
    assert_eq!(alice.call("PUT", &format!("/v1/admin/members/{erin_id}/role"), Some(json!({"role": "member"}))).status, 409);
    assert_eq!(sr.env.idp.control("groups?user=erin&groups=").status, 200);
    psql(&sr, "UPDATE sso_logins SET checked = now() - interval '1 day' WHERE NOT revoked");
    eventually("erin's demotion", || erin.call("GET", "/v1/admin/members", None).status == 403);
    assert_eq!(erin.call("GET", "/v1/sso/me", None).json()["role"], "member", "she keeps her session as a member");
    let change = events(&alice).into_iter().find(|e| e["action"] == "account.role_changed").unwrap();
    assert_eq!((change["actor"].as_str(), change["target"].as_str(), change["detail"].clone()), (Some("system"), Some(erin_id.as_str()), json!({"from": "admin", "to": "member", "by": "provider"})));
}

#[test]
fn end_to_end_deployments_refuse_content_routes_and_keep_metadata() {
    let env = Env::start("RS256", people(), json!({}), json!({}));
    let mut org = support::orgs::Org::create(&env, "alice");
    let admin = Api { base: env.service.url.clone(), token: env.client().login("alice")["token"].as_str().unwrap().to_owned() };
    let owner = org.owner.clone();
    let session = org.token(&owner.seed);
    let project = org.create_project(&session, &owner);
    assert_eq!(org.append(&session, &project, &support::orgs::entry(&org.id, &project, &owner.seed, 1, 1, &random_bytes(100))).status, 201);
    // A large entry lives in the blob store.
    assert_eq!(org.append(&session, &project, &support::orgs::entry(&org.id, &project, &owner.seed, 2, 1, &random_bytes(70_000))).status, 201);
    for (method, path) in [("POST", format!("/v1/admin/projects/{project}/open")), ("POST", format!("/v1/admin/projects/{project}/edit")), ("GET", "/v1/admin/export".into())] {
        assert_eq!(admin.call(method, &path, None).status, 409, "{path}");
    }
    let listed = admin.call("GET", "/v1/admin/projects", None).json();
    assert_eq!((listed["encryption"].as_str(), listed["projects"][0]["id"].as_str(), listed["projects"][0]["head"].as_i64()), (Some("e2ee"), Some(project.as_str()), Some(2)));
    let blobs = |dir: &std::path::Path| walk(dir).into_iter().filter(|p| p.to_string_lossy().contains(&project)).count();
    let data = env.service.dir.join("data");
    assert!(blobs(&data) > 0);
    assert!(admin.call("GET", "/v1/admin/members", None).json()["members"].as_array().unwrap().iter().any(|m| m["email"] == "alice@example.org"));
    assert_eq!(admin.call("DELETE", &format!("/v1/admin/projects/{project}"), None).status, 204);
    assert_eq!(org.append(&session, &project, &support::orgs::entry(&org.id, &project, &owner.seed, 3, 1, &random_bytes(100))).status, 404);
    assert_eq!(blobs(&data), 0, "the ciphertext is gone from the blob store");
    assert_eq!(admin.call("GET", "/v1/admin/projects", None).json()["projects"].as_array().unwrap().len(), 0);
    let log = events(&admin);
    assert_eq!(log.iter().filter(|e| e["action"] == "project.deleted" && e["target"] == project).count(), 1);
    let (code, out) = env.service.run(&["audit", "verify"]);
    assert_eq!(code, 0, "{out}");
}
