//! Server-readable projects through the real binary, on filesystem and Garage (S3) blobs:
//! durable, idempotent and gap-free appends; roles (owner, editor, reviewer, viewer, guest,
//! non-member); email invitations; quotas; sealing at rest; crypto-erase; snapshots and the
//! compaction floor; materialisation; heads across two replicas; and that the end-to-end and
//! server-readable routes each exist only in their own mode.
mod support;
use serde_json::{Value, json};
use support::{sr::*, sso::*, *};

fn users() -> Value {
    let mut users = people();
    users.as_array_mut().unwrap().push(json!({"sub": "sub-gus", "username": "gus", "password": "pw-gus", "email": "gus@partner.org", "email_verified": true, "name": "Gus", "roles": [MEMBER], "claims": {"acct": "1"}}));
    users
}
fn start(blobs: Blobs) -> Sr {
    Sr::start(blobs, users(), json!({}), json!({}))
}

#[test]
fn appends_are_durable_idempotent_and_gap_free() {
    for blobs in BOTH {
        // Entries above 64 bytes go to the blob store, so both paths are exercised.
        let sr = Sr::start(blobs, users(), json!({"entry_inline_bytes": 64}), json!({}));
        let ana = sr.api(&sr.login("alice"));
        let p = ana.create("Paper");
        let doc = Project::new();
        let first = doc.add_text("f1", "main.tex", None, "\\documentclass{article}");
        let created = ana.append(&p, "browser-a", 1, &first);
        assert_eq!((created.status, created.json()["seq"].as_i64()), (201, Some(1)), "{blobs:?}");
        // An identical retry gets the original acknowledgement; other bytes at that slot are refused.
        assert_eq!((ana.append(&p, "browser-a", 1, &first).status, ana.append(&p, "browser-a", 1, &first).json()["seq"].as_i64()), (200, Some(1)));
        let other = doc.type_text("f1", " more");
        assert_eq!(ana.append(&p, "browser-a", 1, &other).status, 409);
        // Malformed requests are refused before anything is stored.
        assert_eq!(ana.append(&p, "browser-a", 2, b"not a yjs update at all").status, 400);
        assert_eq!(request("POST", &format!("{}/v1/sr/projects/{p}/log", sr.url()), Some(&ana.token), &[], other.clone()).status, 400);
        assert_eq!(ana.append(&p, "browser a!", 2, &other).status, 400);
        assert_eq!(ana.append(&p, "browser-a", 0, &other).status, 400);
        assert_eq!(request("POST", &format!("{}/v1/sr/projects/{p}/log", sr.url()), None, &[("Scribyra-Client", "x".into()), ("Scribyra-Client-Seq", "2".into())], other.clone()).status, 401);
        assert_eq!(ana.append(&p, "browser-a", 2, &other).status, 201);
        // Concurrent appends from several clients get distinct, gap-free sequence numbers.
        let threads: Vec<_> = (0..8)
            .map(|c| {
                let (api, p) = (ana.clone(), p.clone());
                std::thread::spawn(move || {
                    let doc = Project::new();
                    (1..=5).map(|n| api.append(&p, &format!("client-{c}"), n, &doc.add_text(&format!("c{c}n{n}"), &format!("c{c}n{n}.tex"), None, &"x".repeat(100))).json()["seq"].as_i64().unwrap()).collect::<Vec<_>>()
                })
            })
            .collect();
        let mut seqs: Vec<i64> = threads.into_iter().flat_map(|t| t.join().unwrap()).collect();
        seqs.sort();
        assert_eq!(seqs, (3..=42).collect::<Vec<_>>());
        // Reading returns every entry in order, up to the head.
        let page = ana.log(&p, 0);
        assert_eq!((page.status, page.header("scribyra-log-head")), (200, Some("42")));
        let frames = page.frames();
        assert_eq!(frames.iter().map(|f| f.0).collect::<Vec<_>>(), (1..=42).collect::<Vec<_>>());
        assert_eq!(frames[0].1, first);
        assert_eq!(text_of(&frames.iter().map(|f| f.1.clone()).collect::<Vec<_>>(), "f1"), "\\documentclass{article} more");
        assert_eq!(ana.call("GET", &format!("/v1/sr/projects/{p}/log?after=40&limit=1"), None).frames().iter().map(|f| f.0).collect::<Vec<_>>(), vec![41]);
        assert_eq!(postgres().psql(&sr.db(), &format!("SELECT count(*) FROM sr_entries WHERE project = '{p}'")), "42");
        assert!(postgres().psql(&sr.db(), "SELECT count(*) FROM sr_entries WHERE blob IS NOT NULL").parse::<i64>().unwrap() > 0);
        // The list shows the project with its head.
        let list = ana.call("GET", "/v1/sr/projects", None).json();
        assert_eq!((list["projects"][0]["id"].as_str(), list["projects"][0]["head"].as_i64(), list["projects"][0]["role"].as_str()), (Some(p.as_str()), Some(42), Some("owner")));
    }
}

#[test]
fn creating_with_an_initial_state_and_an_id_is_idempotent() {
    let sr = start(Blobs::Fs);
    let ana = sr.api(&sr.login("alice"));
    let doc = Project::new();
    doc.add_text("f1", "main.tex", None, "hello");
    use yrs::ReadTxn;
    let state = yrs::Transact::transact(&doc.doc).encode_state_as_update_v1(&yrs::StateVector::default());
    let key = random_hex(32);
    let body = json!({"id": key, "name": "Imported", "state": base64::Engine::encode(&base64::engine::general_purpose::STANDARD, &state), "client": "browser-a", "clientSeq": 1});
    let first = ana.call("POST", "/v1/sr/projects", Some(body.clone()));
    assert_eq!((first.status, first.json()["seq"].as_i64(), first.json()["project"]["head"].as_i64()), (201, Some(1), Some(1)));
    // The project's ID is derived from the account and the request's `id`, so the app can
    // compute it before the request and a retry finds the same project.
    let id = first.json()["project"]["id"].as_str().unwrap().to_owned();
    let me = sr.env.client().me(&ana.token).json()["account"].as_str().unwrap().to_owned();
    assert_eq!(id, sha256(format!("scribyra-sr-project/1\n{me}\n{key}").as_bytes()));
    let again = ana.call("POST", "/v1/sr/projects", Some(body.clone()));
    assert_eq!((again.status, again.json()["seq"].as_i64(), again.json()["project"]["id"].as_str()), (200, Some(1), Some(id.as_str())));
    assert_eq!(text_of(&[ana.log(&id, 0).frames()[0].1.clone()], "f1"), "hello");
    // Review L5: another person sending the same `id` used to get 409, learning that the
    // project exists. They now get a project of their own, whatever anyone else did.
    let ben = sr.api(&sr.login("ben"));
    let theirs = ben.call("POST", "/v1/sr/projects", Some(body));
    assert_eq!(theirs.status, 201);
    assert_ne!(theirs.json()["project"]["id"].as_str(), Some(id.as_str()));
    assert_eq!(ben.log(&id, 0).status, 404);
    assert_eq!(ana.details(&id).json()["head"], 1);
    // A state that is not Yjs is refused.
    assert_eq!(ben.call("POST", "/v1/sr/projects", Some(json!({"name": "x", "state": "bm90IGEgWWpzIHVwZGF0ZQ=="}))).status, 400);
    assert_eq!(ben.call("POST", "/v1/sr/projects", Some(json!({"name": " "}))).status, 400);
    assert_eq!(postgres().psql(&sr.db(), "SELECT count(*) FROM sr_projects"), "2");
}

#[test]
fn roles_decide_who_reads_writes_and_shares() {
    let sr = Sr::start(Blobs::Fs, users(), json!({}), json!({"guests": "shared", "provider": {"claims": {"roles": "$.roles", "guest": {"path": "$.acct", "equals": "1"}}}}));
    let (ana, ben, cat, dan, gus) = (sr.api(&sr.login("alice")), sr.api(&sr.login("ben")), sr.api(&sr.login("cat")), sr.api(&sr.login("dan")), sr.api(&sr.login("gus")));
    let p = ana.create("Shared");
    let doc = Project::new();
    assert_eq!(ana.append(&p, "a", 1, &doc.add_text("f1", "main.tex", None, "x")).status, 201);
    for (email, role) in [("ben@example.org", "editor"), ("cat@example.org", "reviewer"), ("dan@example.org", "viewer"), ("gus@partner.org", "viewer")] {
        // gus is a guest: invited as one.
        let reply = if email == "gus@partner.org" { ana.invite_guest(&p, email, role) } else { ana.invite(&p, email, role) };
        assert_eq!((reply.status, reply.json()["status"].as_str()), (201, Some("shared")), "{email}");
    }
    // Editors write updates and objects; reviewers and viewers read but are refused writes.
    assert_eq!(ben.append(&p, "b", 1, &doc.type_text("f1", "b")).status, 201);
    assert_eq!(ben.put_object(&p, b"figure bytes").status, 201);
    for (who, api) in [("reviewer", &cat), ("viewer", &dan), ("guest viewer", &gus)] {
        assert_eq!(api.log(&p, 0).status, 200, "{who}");
        assert_eq!(api.get_object(&p, &sha256(b"figure bytes")).body, b"figure bytes");
        assert_eq!(api.append(&p, "c", 1, &doc.type_text("f1", "c")).status, 403, "{who}");
        assert_eq!(api.put_object(&p, b"other bytes").status, 403, "{who}");
        assert_eq!(api.invite(&p, "erin@example.org", "viewer").status, 403, "{who}");
        assert_eq!(api.call("PATCH", &format!("/v1/sr/projects/{p}"), Some(json!({"name": "x"}))).status, 403);
        assert_eq!(api.call("DELETE", &format!("/v1/sr/projects/{p}"), None).status, 403);
    }
    assert_eq!(ana.details(&p).json()["members"].as_array().unwrap().len(), 5);
    // Reviewers and viewers see the members but not the pending invitations.
    assert_eq!(ana.invite(&p, "nobody@example.org", "viewer").json()["status"], "pending");
    assert_eq!(ana.details(&p).json()["invitations"].as_array().unwrap().len(), 1);
    assert_eq!(dan.details(&p).json()["invitations"].as_array().unwrap().len(), 0);
    // A member who is not shared on a project cannot tell it exists: 404 everywhere.
    let erin = sr.api(&sr.login("erin"));
    for (method, path) in [("GET", format!("/v1/sr/projects/{p}")), ("GET", format!("/v1/sr/projects/{p}/log?after=0")), ("GET", format!("/v1/sr/projects/{p}/snapshot")), ("GET", format!("/v1/sr/projects/{p}/objects/{}", sha256(b"figure bytes"))), ("DELETE", format!("/v1/sr/projects/{p}"))] {
        let reply = erin.call(method, &path, None);
        assert_eq!((reply.status, reply.json()["error"].as_str()), (404, Some("unknown project")), "{path}");
    }
    assert_eq!(erin.append(&p, "e", 1, &doc.type_text("f1", "e")).status, 404);
    assert_eq!(erin.call("GET", &format!("/v1/sr/projects/{}", random_hex(32)), None).status, 404);
    assert_eq!(erin.call("GET", "/v1/sr/projects", None).json()["projects"], json!([]));
    // Guests see only what is shared with them and cannot create projects.
    assert_eq!(gus.call("POST", "/v1/sr/projects", Some(json!({"name": "mine"}))).status, 403);
    assert_eq!(gus.call("GET", "/v1/sr/projects", None).json()["projects"].as_array().unwrap().len(), 1);
    assert_eq!(gus.call("GET", "/v1/sr/projects", None).json()["role"], "guest");
    // Without a sign-in nothing answers.
    assert_eq!(request("GET", &format!("{}/v1/sr/projects", sr.url()), None, &[], vec![]).status, 401);
    assert_eq!(request("GET", &format!("{}/v1/sr/projects", sr.url()), Some(&random_hex(32)), &[], vec![]).status, 401);
    // Roles change and shares end; a member may leave; the owner may not, but may transfer.
    assert_eq!(ana.call("PUT", &format!("/v1/sr/projects/{p}/members/{}", account(&sr, "dan")), Some(json!({"role": "editor"}))).status, 200);
    assert_eq!(dan.append(&p, "d", 1, &doc.type_text("f1", "d")).status, 201);
    assert_eq!(ben.call("DELETE", &format!("/v1/sr/projects/{p}/members/{}", account(&sr, "dan")), None).status, 204);
    assert_eq!(dan.log(&p, 0).status, 404);
    assert_eq!(cat.call("DELETE", &format!("/v1/sr/projects/{p}/members/{}", account(&sr, "cat")), None).status, 204);
    assert_eq!(cat.log(&p, 0).status, 404);
    assert_eq!(ana.call("DELETE", &format!("/v1/sr/projects/{p}/members/{}", account(&sr, "alice")), None).status, 409);
    assert_eq!(ana.call("POST", &format!("/v1/sr/projects/{p}/owner"), Some(json!({"account": account(&sr, "gus")}))).status, 409);
    let moved = ana.call("POST", &format!("/v1/sr/projects/{p}/owner"), Some(json!({"account": account(&sr, "ben")})));
    assert_eq!((moved.status, moved.json()["role"].as_str(), moved.json()["owner"]["account"].as_str()), (200, Some("editor"), Some(account(&sr, "ben").as_str())));
    assert_eq!(ana.call("DELETE", &format!("/v1/sr/projects/{p}"), None).status, 403);
    assert_eq!(ben.call("PATCH", &format!("/v1/sr/projects/{p}"), Some(json!({"name": "Renamed"}))).json()["name"], "Renamed");
}
fn account(sr: &Sr, user: &str) -> String {
    postgres().psql(&sr.db(), &format!("SELECT account FROM accounts WHERE subject = 'sub-{user}'"))
}

#[test]
fn invitations_wait_for_a_sign_in_with_that_verified_email() {
    let mut users = users();
    users.as_array_mut().unwrap().push(json!({"sub": "sub-unverified-nina", "username": "fake-nina", "password": "pw-fake-nina", "email": "nina@example.org", "email_verified": false, "name": "Not Nina", "roles": [MEMBER]}));
    let sr = Sr::start(Blobs::Fs, users, json!({}), json!({}));
    let ana = sr.api(&sr.login("alice"));
    let p = ana.create("Invited");
    let pending = ana.invite(&p, "Nina@Example.org", "editor");
    assert_eq!((pending.status, pending.json()["status"].as_str(), pending.json()["invitation"]["email"].as_str()), (201, Some("pending"), Some("nina@example.org")));
    let expires = pending.json()["invitation"]["expires"].as_i64().unwrap();
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis() as i64;
    assert!((expires - now - 30 * 86_400_000).abs() < 120_000, "invitations expire in 30 days");
    // Someone signing in with that email unverified does not get the share.
    let fake = sr.api(&sr.login("fake-nina"));
    assert_eq!(fake.call("GET", "/v1/sr/projects", None).json()["projects"], json!([]));
    assert_eq!(fake.log(&p, 0).status, 404);
    // The real Nina's first sign-in (verified) turns it into a share.
    let nina = sr.api(&sr.login("nina"));
    let list = nina.call("GET", "/v1/sr/projects", None).json();
    assert_eq!((list["projects"][0]["id"].as_str(), list["projects"][0]["role"].as_str()), (Some(p.as_str()), Some("editor")));
    assert_eq!(ana.details(&p).json()["invitations"], json!([]));
    // A withdrawn invitation and an expired one are never accepted.
    let omar = ana.invite(&p, "omar@example.org", "viewer").json()["invitation"]["id"].as_str().unwrap().to_owned();
    assert_eq!(ana.call("DELETE", &format!("/v1/sr/projects/{p}/invitations/{omar}"), None).status, 204);
    assert_eq!(ana.call("DELETE", &format!("/v1/sr/projects/{p}/invitations/{omar}"), None).status, 404);
    ana.invite(&p, "pia@example.org", "viewer");
    postgres().psql(&sr.db(), "UPDATE sr_invitations SET expires = now() - interval '1 second' WHERE email = 'pia@example.org'");
    for user in ["omar", "pia"] {
        assert_eq!(sr.api(&sr.login(user)).call("GET", "/v1/sr/projects", None).json()["projects"], json!([]), "{user}");
    }
    // An account that already exists (verified) is shared at once; inviting again changes the role.
    let quinn = sr.api(&sr.login("quinn"));
    assert_eq!(ana.invite(&p, "quinn@example.org", "viewer").status, 201);
    assert_eq!(quinn.details(&p).json()["role"], "viewer");
    assert_eq!(ana.invite(&p, "quinn@example.org", "reviewer").status, 200);
    assert_eq!(quinn.details(&p).json()["role"], "reviewer");
    // Inviting the owner is refused; bad emails and roles too.
    assert_eq!(ana.invite(&p, "alice@example.org", "editor").status, 409);
    assert_eq!(ana.invite(&p, "not-an-email", "editor").status, 400);
    assert_eq!(ana.invite(&p, "x@example.org", "owner").status, 400);
    // The account is returned at sign-in and by /v1/sso/me.
    let me = sr.env.client().me(&nina.token).json();
    assert_eq!((me["account"].as_str(), me["email"].as_str(), me["role"].as_str()), (Some(account(&sr, "nina").as_str()), Some("nina@example.org"), Some("member")));
    assert_eq!(sr.env.client().me(&fake.token).json()["email"], Value::Null);
}

#[test]
fn quotas_refuse_with_507_and_charge_sealed_bytes() {
    let sr = Sr::start(Blobs::Fs, users(), json!({}), json!({"quotas": {"deployment_bytes": 1_000_000, "project_bytes": 4000, "member_bytes": 5000}}));
    let ana = sr.api(&sr.login("alice"));
    let p = ana.create("Small");
    let doc = Project::new();
    assert_eq!(ana.append(&p, "a", 1, &doc.add_text("f1", "a.tex", None, &"a".repeat(3000))).status, 201);
    assert_eq!(ana.append(&p, "a", 2, &doc.add_text("f2", "b.tex", None, &"b".repeat(3000))).status, 507);
    assert_eq!(ana.put_object(&p, &vec![7u8; 3000]).status, 507);
    // The member quota counts every project the person owns.
    let q = ana.create("Second");
    assert_eq!(ana.append(&q, "a", 1, &Project::new().add_text("f1", "a.tex", None, &"c".repeat(2500))).status, 507);
    let used: i64 = postgres().psql(&sr.db(), "SELECT bytes FROM usage WHERE scope = 'sr:deployment'").parse().unwrap();
    assert!(used > 3000 && used < 3200, "{used}");
    // Nothing of the refused writes was kept.
    assert_eq!(postgres().psql(&sr.db(), "SELECT count(*) FROM sr_entries"), "1");
    assert_eq!(postgres().psql(&sr.db(), "SELECT count(*) FROM sr_objects"), "0");
}

/// Every blob key the database references for server-readable projects.
fn blob_keys(sr: &Sr) -> Vec<String> {
    let text = postgres().psql(&sr.db(), "SELECT blob FROM sr_entries WHERE blob IS NOT NULL UNION ALL SELECT blob FROM sr_snapshots WHERE blob IS NOT NULL UNION ALL SELECT blob FROM sr_objects");
    text.lines().filter(|l| !l.is_empty()).map(str::to_owned).collect()
}
fn blob_store(sr: &Sr) -> Box<dyn scribyra_sync::blobs::BlobStore> {
    match sr.blobs {
        Blobs::Fs => Box::new(scribyra_sync::blobs::FsBlobStore::open(sr.env.service.dir.join("data")).unwrap()),
        Blobs::S3 => {
            let c = &sr.env.service.config;
            Box::new(
                scribyra_sync::blobs::S3BlobStore::new(scribyra_sync::blobs::S3Settings {
                    endpoint: c["s3_endpoint"].as_str().unwrap().into(),
                    region: "garage".into(),
                    bucket: c["s3_bucket"].as_str().unwrap().into(),
                    access_key_id: c["s3_access_key_id"].as_str().unwrap().into(),
                    secret_access_key: std::fs::read_to_string(c["s3_secret_access_key_file"].as_str().unwrap()).unwrap().trim().into(),
                    path_style: true,
                    ca_pem: None,
                })
                .unwrap(),
            )
        }
    }
}
fn read_blob(sr: &Sr, key: &str) -> Option<Vec<u8>> {
    let store = blob_store(sr);
    let key = scribyra_sync::blobs::BlobKey::new(key.to_owned()).unwrap();
    let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
    runtime.block_on(async {
        match store.get(&key, 0).await {
            Err(scribyra_sync::blobs::BlobError::NotFound) => None,
            _ => {
                let size: usize = postgres().psql(&sr.db(), &format!("SELECT COALESCE((SELECT size FROM sr_entries WHERE blob = '{k}'), (SELECT size FROM sr_snapshots WHERE blob = '{k}'), (SELECT sealed_size FROM sr_objects WHERE blob = '{k}'), -1)", k = key.as_str())).parse::<i64>().unwrap() as usize;
                store.get(&key, size).await.ok()
            }
        }
    })
}
fn contains(haystack: &[u8], needle: &[u8]) -> bool {
    haystack.windows(needle.len()).any(|w| w == needle)
}
fn pg_dump(url: &str) -> Vec<u8> {
    let out = std::process::Command::new("pg_dump").args(["--no-owner", "--data-only", url]).output().unwrap();
    assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
    out.stdout
}

#[test]
fn content_is_sealed_at_rest_and_deleting_a_project_erases_it() {
    for blobs in BOTH {
        let sr = Sr::start(blobs, users(), json!({"entry_inline_bytes": 1024, "sr_snapshot_entries": 3}), json!({}));
        let ana = sr.api(&sr.login("alice"));
        let marker = format!("PLAINTEXT-MARKER-{}", random_hex(8));
        let p = ana.create("Secret");
        let doc = Project::new();
        let updates = [doc.add_text("f1", "main.tex", None, &marker), doc.type_text("f1", &format!("{marker}{}", "y".repeat(4000))), doc.type_text("f1", "z"), doc.type_text("f1", &marker)];
        for (n, u) in updates.iter().enumerate() {
            assert_eq!(ana.append(&p, "a", n as i64 + 1, u).status, 201);
        }
        let object = format!("{marker} in an image").into_bytes();
        assert_eq!(ana.put_object(&p, &object).status, 201);
        assert_eq!(ana.put_object(&p, &object).status, 204);
        assert_eq!(ana.get_object(&p, &sha256(&object)).body, object);
        // A snapshot is written after three entries (and, with no retention window, becomes the floor).
        eventually("a snapshot", || ana.details(&p).json()["snapshot"].as_i64() >= Some(3));
        // The marker is nowhere in the database or the blob store, though the service serves it.
        let dump = pg_dump(&sr.db());
        assert!(!contains(&dump, marker.as_bytes()), "{blobs:?}: plaintext in the database");
        let keys = blob_keys(&sr);
        assert!(keys.len() >= 2, "{keys:?}");
        let sealed: Vec<(String, Vec<u8>)> = keys.iter().map(|k| (k.clone(), read_blob(&sr, k).expect("stored blob"))).collect();
        for (key, bytes) in &sealed {
            assert!(!contains(bytes, marker.as_bytes()), "{blobs:?}: plaintext in blob {key}");
        }
        if blobs == Blobs::Fs {
            for entry in walk(&sr.env.service.dir.join("data")) {
                assert!(!contains(&std::fs::read(&entry).unwrap(), marker.as_bytes()), "plaintext in {}", entry.display());
            }
        }
        // Delete: the wrapped key goes in the same transaction, then the rows and blobs.
        let inline: Vec<Vec<u8>> = postgres().psql(&sr.db(), &format!("SELECT encode(inline_sealed, 'hex') FROM sr_entries WHERE project = '{p}' AND inline_sealed IS NOT NULL")).lines().map(|h| (0..h.len()).step_by(2).map(|i| u8::from_str_radix(&h[i..i + 2], 16).unwrap()).collect()).collect();
        assert_eq!(ana.call("DELETE", &format!("/v1/sr/projects/{p}"), None).status, 204);
        assert_eq!(ana.details(&p).status, 404);
        assert_eq!(postgres().psql(&sr.db(), "SELECT count(*) FROM sr_projects WHERE data_key_wrapped IS NOT NULL"), "0");
        eventually("erasure", || postgres().psql(&sr.db(), "SELECT count(*) FROM sr_projects") == "0");
        for table in ["sr_entries", "sr_snapshots", "sr_objects", "sr_shares"] {
            assert_eq!(postgres().psql(&sr.db(), &format!("SELECT count(*) FROM {table}")), "0", "{table}");
        }
        eventually("blob removal", || postgres().psql(&sr.db(), "SELECT count(*) FROM sr_garbage") == "0");
        for (key, _) in &sealed {
            assert!(read_blob(&sr, key).is_none(), "{blobs:?}: blob {key} survived");
        }
        // Copies taken before (a dump, a bucket backup) cannot be opened: the master key alone
        // opens no data key any more, and no data key is left anywhere.
        let master = std::fs::read(&sr.key_file).unwrap();
        for (_, bytes) in &sealed {
            for kind in ["update", "snapshot", "object"] {
                assert!(scribyra_sync::server_projects::open(&master, &scribyra_sync::server_projects::item_ad(&p, kind, "1"), bytes).is_none());
            }
        }
        for bytes in &inline {
            assert!(!contains(bytes, marker.as_bytes()));
            assert!(scribyra_sync::server_projects::open(&master, &scribyra_sync::server_projects::item_ad(&p, "update", "1"), bytes).is_none());
        }
        assert_eq!(postgres().psql(&sr.db(), "SELECT bytes FROM usage WHERE scope = 'sr:deployment'"), "0");
    }
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
fn snapshots_move_the_floor_and_old_cursors_get_410() {
    for blobs in BOTH {
        let sr = Sr::start(blobs, users(), json!({"sr_snapshot_entries": 5, "entry_inline_bytes": 64}), json!({}));
        let ana = sr.api(&sr.login("alice"));
        let p = ana.create("Long");
        let doc = Project::new();
        let mut updates = vec![doc.add_text("f1", "main.tex", None, "start")];
        updates.extend((0..6).map(|n| doc.type_text("f1", &format!(" {n}"))));
        for (n, u) in updates.iter().enumerate() {
            assert_eq!(ana.append(&p, "a", n as i64 + 1, u).status, 201);
        }
        eventually("the floor", || ana.details(&p).json()["floor"].as_i64() >= Some(5));
        let details = ana.details(&p).json();
        let (floor, snap) = (details["floor"].as_i64().unwrap(), details["snapshot"].as_i64().unwrap());
        assert_eq!(floor, snap);
        // A reader behind the floor is told to start from the snapshot.
        let gone = ana.log(&p, 0);
        assert_eq!((gone.status, gone.json()["error"].as_str(), gone.json()["snapshot"].as_i64()), (410, Some("compacted"), Some(snap)));
        let snapshot = ana.call("GET", &format!("/v1/sr/projects/{p}/snapshot"), None);
        assert_eq!((snapshot.status, snapshot.header("scribyra-snapshot-seq")), (200, Some(snap.to_string().as_str())));
        let mut catch_up = vec![snapshot.body.clone()];
        catch_up.extend(ana.log(&p, snap).frames().into_iter().map(|f| f.1));
        assert_eq!(text_of(&catch_up, "f1"), "start 0 1 2 3 4 5");
        // Bodies below the floor are gone, the rows stay: a late retry still gets its sequence number.
        assert_eq!(postgres().psql(&sr.db(), &format!("SELECT count(*) FROM sr_entries WHERE seq <= {floor} AND (inline_sealed IS NOT NULL OR blob IS NOT NULL)")), "0");
        let retry = ana.append(&p, "a", 1, &updates[0]);
        assert_eq!((retry.status, retry.json()["seq"].as_i64()), (200, Some(1)));
        eventually("garbage removal", || postgres().psql(&sr.db(), "SELECT count(*) FROM sr_garbage") == "0");
        // Usage equals what is stored.
        let stored: i64 = postgres().psql(&sr.db(), "SELECT (SELECT COALESCE(sum(size),0) FROM sr_entries WHERE inline_sealed IS NOT NULL OR blob IS NOT NULL) + (SELECT COALESCE(sum(size),0) FROM sr_snapshots) + (SELECT COALESCE(sum(sealed_size),0) FROM sr_objects)").parse().unwrap();
        assert_eq!(postgres().psql(&sr.db(), "SELECT bytes FROM usage WHERE scope = 'sr:deployment'"), stored.to_string(), "{blobs:?}");
        assert_eq!(postgres().psql(&sr.db(), "SELECT bytes FROM sr_projects"), stored.to_string());
    }
}

#[test]
fn a_project_materialises_to_its_files() {
    let mut sr = start(Blobs::S3);
    let ana = sr.api(&sr.login("alice"));
    let p = ana.create("Thesis");
    let doc = Project::new();
    let figure = random_bytes(3000);
    let updates = [
        doc.add_folder("d1", "chapters"),
        doc.add_text("f1", "main.tex", None, "\\input{chapters/one}"),
        doc.add_text("f2", "one.tex", Some("d1"), "Chapter one"),
        doc.add_asset("a1", "figure.png", &figure),
        doc.set_main("f1"),
    ];
    assert_eq!(ana.put_object(&p, &figure).status, 201);
    for (n, u) in updates.iter().enumerate() {
        assert_eq!(ana.append(&p, "a", n as i64 + 1, u).status, 201);
    }
    let config = sr.env.service.config.clone();
    sr.env.service.stop();
    let runtime = tokio::runtime::Runtime::new().unwrap();
    runtime.block_on(async {
        let config: scribyra_sync::config::Config = serde_json::from_value(config).unwrap();
        let store = std::sync::Arc::new(scribyra_sync::store::Store::open(config).await.unwrap());
        let projects = scribyra_sync::server_projects::Projects::new(store).unwrap().unwrap();
        // Before and after a snapshot the result is the same.
        let before = projects.materialise(&p).await.unwrap();
        assert_eq!(projects.compact(&p).await.unwrap(), Some(5));
        let after = projects.materialise(&p).await.unwrap();
        assert_eq!(before, after);
        use scribyra_sync::server_projects::Content;
        assert_eq!((after.seq, after.name.as_str(), after.main_file.as_deref()), (5, "Thesis", Some("main.tex")));
        let by_path: std::collections::HashMap<&str, &Content> = after.files.iter().map(|f| (f.path.as_str(), &f.content)).collect();
        assert_eq!(by_path["chapters"], &Content::Folder);
        assert_eq!(by_path["chapters/one.tex"], &Content::Text("Chapter one".into()));
        assert_eq!(by_path["main.tex"], &Content::Text("\\input{chapters/one}".into()));
        assert_eq!(by_path["figure.png"], &Content::Asset { hash: sha256(&figure), size: 3000, bytes: Some(figure.clone()) });
    });
}

#[test]
fn heads_wake_on_appends_and_shares_across_replicas_and_sign_in_spans_them() {
    let sr = start(Blobs::S3);
    let replica = sr.replica();
    // A sign-in started on one instance finishes on the other (state and grant in PostgreSQL).
    let client = sr.env.client();
    let started = client.start();
    let callback = client.authorize(&started, "ben", "pw-ben");
    let (status, outcome) = client.callback(&callback.replace(&sr.env.public, &replica.url));
    assert_eq!(status, 302);
    let Some(Outcome::Grant { grant, .. }) = outcome else { panic!("{outcome:?}") };
    let other = Client { base: replica.url.clone(), provider: "test".into(), idp: &sr.env.idp };
    let ben_token = other.redeem(&grant, &started.verifier).json()["token"].as_str().unwrap().to_owned();
    let ana = sr.api(&sr.login("alice"));
    let (ana_b, ben_b) = (ana.on(&replica.url), sr.api(&ben_token).on(&replica.url));
    let p = ana.create("Live");
    // Ana waits on the replica; Ben is not shared yet.
    let version = ana_b.heads(None, 0).json()["version"].as_str().unwrap().to_owned();
    let waiter = {
        let (api, version) = (ana_b.clone(), version.clone());
        std::thread::spawn(move || {
            let t = std::time::Instant::now();
            (api.heads(Some(&version), 20).json(), t.elapsed())
        })
    };
    std::thread::sleep(std::time::Duration::from_millis(500));
    assert_eq!(ana.append(&p, "a", 1, &Project::new().add_text("f1", "a.tex", None, "x")).status, 201);
    let (woken, took) = waiter.join().unwrap();
    assert!(took < std::time::Duration::from_secs(10), "{took:?}");
    assert_eq!(woken["projects"][&p]["head"], 1);
    assert_ne!(woken["version"], version);
    // Ben's poll on the replica wakes when Ana shares with him on the first instance.
    let ben_version = ben_b.heads(None, 0).json()["version"].as_str().unwrap().to_owned();
    let waiter = {
        let api = ben_b.clone();
        std::thread::spawn(move || {
            let t = std::time::Instant::now();
            (api.heads(Some(&ben_version), 20).json(), t.elapsed())
        })
    };
    std::thread::sleep(std::time::Duration::from_millis(500));
    assert_eq!(ana.invite(&p, "ben@example.org", "viewer").status, 201);
    let (woken, took) = waiter.join().unwrap();
    assert!(took < std::time::Duration::from_secs(10), "{took:?}");
    assert_eq!(woken["projects"][&p]["role"], "viewer");
    // An idle poll answers after its wait with the same version.
    let t = std::time::Instant::now();
    let idle = ben_b.heads(Some(woken["version"].as_str().unwrap()), 1).json();
    assert!(t.elapsed() >= std::time::Duration::from_millis(900));
    assert_eq!(idle["version"], woken["version"]);
    // Both instances serve the same data.
    assert_eq!(ben_b.log(&p, 0).frames().len(), 1);
}

#[test]
fn each_mode_serves_only_its_own_routes() {
    // An end-to-end deployment has no server-readable routes.
    let env = Env::start("RS256", people(), json!({}), json!({}));
    let token = env.client().login("alice")["token"].as_str().unwrap().to_owned();
    for (method, path) in [("GET", "/v1/sr/projects".to_string()), ("POST", "/v1/sr/projects".into()), ("GET", "/v1/sr/heads".into()), ("GET", format!("/v1/sr/projects/{}/log", random_hex(32)))] {
        let reply = request(method, &format!("{}{path}", env.service.url), Some(&token), &[("Content-Type", "application/json".into())], b"{\"name\":\"x\"}".to_vec());
        assert_eq!(reply.status, 404, "{path}");
    }
    // A server-readable one has no end-to-end routes.
    let sr = start(Blobs::Fs);
    for path in [format!("/v1/orgs/{}/info", sr.env.org()), format!("/v1/projects/{}/log", random_hex(32))] {
        assert_eq!(request("GET", &format!("{}{path}", sr.url()), None, &[], vec![]).status, 404, "{path}");
    }
    assert_eq!(request("POST", &format!("{}/v1/auth/challenge", sr.url()), None, &[("Content-Type", "application/json".into())], json!({"org": sr.env.org()}).to_string().into_bytes()).status, 404);
}

/// One struct holding one `Any` item of the root map `t`, then an empty delete set.
fn any_item(value: &[u8]) -> Vec<u8> {
    let mut update = vec![1, 1, 1, 0, 8, 1, 1, b't', 1];
    update.extend_from_slice(value);
    update.push(0);
    update
}
fn var(mut n: u64) -> Vec<u8> {
    let mut out = Vec::new();
    while n >= 0x80 {
        out.push((n as u8 & 0x7f) | 0x80);
        n >>= 7;
    }
    out.push(n as u8);
    out
}

#[test]
fn hostile_yjs_updates_are_refused_and_the_service_survives() {
    // Review C1: `yrs` 0.25 pre-allocates from untrusted lengths (an abort), recurses without a
    // limit (a stack overflow) and trusts strings to be UTF-8. Each of these killed the process
    // through POST …/log or POST /v1/sr/projects {state}.
    let sr = start(Blobs::Fs);
    let ana = sr.api(&sr.login("alice"));
    let p = ana.create("Target");
    let mut deep = Vec::new();
    for _ in 0..1_000_000 {
        deep.extend_from_slice(&[117, 1]);
    }
    deep.push(126);
    let mut string = vec![1, 1, 1, 0, 4, 1, 1, b't', 2, 0xff, 0xfe, 0];
    let hostile = [
        ("array of 2^36", any_item(&[[117].as_slice(), &var(1 << 36)].concat())),
        ("array of 2^50", any_item(&[[117].as_slice(), &var(1 << 50)].concat())),
        ("map of 2^40", any_item(&[[118].as_slice(), &var(1 << 40)].concat())),
        ("a million nested arrays", any_item(&deep)),
        ("invalid UTF-8", string.clone()),
        ("trailing bytes", [Project::new().add_text("f1", "a.tex", None, "x"), vec![0]].concat()),
    ];
    for (n, (what, update)) in hostile.iter().enumerate() {
        assert_eq!(ana.append(&p, "evil", n as i64 + 1, update).status, 400, "{what}");
        let state = base64::Engine::encode(&base64::engine::general_purpose::STANDARD, update);
        assert_eq!(ana.call("POST", "/v1/sr/projects", Some(json!({"name": "Evil", "state": state}))).status, 400, "{what}");
    }
    // The same string bytes, valid, are accepted: only the encoding was wrong.
    string.splice(9..11, *b"ok");
    assert_eq!(ana.append(&p, "good", 1, &string).status, 201);
    assert_eq!(ana.append(&p, "good", 2, &Project::new().add_text("f1", "a.tex", None, "x")).status, 201);
    assert_eq!(postgres().psql(&sr.db(), "SELECT count(*) FROM sr_projects"), "1");
}

#[test]
fn invitations_stay_inside_the_projects_organisation() {
    // Review H2's concern (another provider asserting a verified email getting its shares) is now
    // structural: each provider has its own organisation here, an invitation matches only accounts
    // of its project's organisation, and a pending one is accepted only by a sign-in into it.
    let mut users = users();
    for (name, email) in [("imposter", "victim@example.org"), ("early", "early@example.org"), ("victim", "victim@example.org")] {
        users.as_array_mut().unwrap().push(json!({"sub": format!("sub-{name}"), "username": name, "password": format!("pw-{name}"), "email": email, "email_verified": true, "name": name, "roles": [MEMBER]}));
    }
    let sr = Sr::start(Blobs::Fs, users, json!({}), json!({"more_providers": [{"id": "partner", "label": "Partner account"}]}));
    let partner = Client { base: sr.url(), provider: "partner".into(), idp: &sr.env.idp };
    let ana = sr.api(&sr.login("alice"));
    let p = ana.create("Vouched");
    // A pending invitation is not accepted by an account of another organisation with that email ...
    assert_eq!(ana.invite(&p, "victim@example.org", "editor").json()["status"], "pending");
    let imposter = sr.api(partner.login("imposter")["token"].as_str().unwrap());
    assert_eq!(imposter.call("GET", "/v1/sr/projects", None).json()["projects"], json!([]));
    assert_eq!(imposter.log(&p, 0).status, 404);
    // ... but by the sign-in into the project's organisation.
    let victim = sr.api(&sr.login("victim"));
    assert_eq!(victim.details(&p).json()["role"], "editor");
    // An existing account of another organisation is not shared at once either.
    let early = sr.api(partner.login("early")["token"].as_str().unwrap());
    assert_eq!(ana.invite(&p, "early@example.org", "viewer").json()["status"], "pending");
    assert_eq!(early.log(&p, 0).status, 404);
    // The `provider:email` form is gone: it is just an address nobody has, and shares nothing.
    assert_eq!(ana.invite(&p, "partner:early@example.org", "viewer").json()["status"], "pending");
    assert_eq!(early.log(&p, 0).status, 404);
    // Members show the provider they signed in with.
    let details = ana.details(&p).json();
    let providers: Vec<(&str, &str)> = details["members"].as_array().unwrap().iter().map(|m| (m["email"].as_str().unwrap(), m["provider"].as_str().unwrap())).collect();
    assert_eq!(providers, vec![("alice@example.org", "test"), ("victim@example.org", "test")]);
    // The partner's organisation is another one: its member cannot even name this project's.
    // Two providers and no primary organisation: the deployment's ID names neither.
    let test_org = ana.call("GET", "/v1/sr/projects", None).json()["org"].as_str().unwrap().to_owned();
    let partner_org = early.call("GET", "/v1/sr/projects", None).json()["org"].as_str().unwrap().to_owned();
    assert_ne!(test_org, partner_org);
    assert_eq!(request("GET", &format!("{}/v1/sr/projects", sr.url()), Some(&early.token), &[("Scribyra-Org", test_org)], vec![]).status, 404);
}

#[test]
fn an_account_keeps_at_most_four_heads_polls_waiting() {
    // Review M4: polls were unbounded per account and every notice woke every poll on every
    // replica. A fifth poll now ends the account's oldest at once.
    let sr = start(Blobs::Fs);
    let ana = sr.api(&sr.login("alice"));
    ana.create("Polled");
    let version = ana.heads(None, 0).json()["version"].as_str().unwrap().to_owned();
    let poll = |api: &Api| {
        let (api, version) = (api.clone(), version.clone());
        std::thread::spawn(move || {
            let t = std::time::Instant::now();
            (api.heads(Some(&version), 20).json(), t.elapsed())
        })
    };
    let first = poll(&ana);
    std::thread::sleep(std::time::Duration::from_millis(300));
    let others: Vec<_> = (0..3).map(|_| poll(&ana)).collect();
    std::thread::sleep(std::time::Duration::from_millis(300));
    // Another account's polls do not count against Ana's.
    let ben = sr.api(&sr.login("ben"));
    let ben_version = ben.heads(None, 0).json()["version"].as_str().unwrap().to_owned();
    let ben_poll = {
        let ben = ben.clone();
        std::thread::spawn(move || ben.heads(Some(&ben_version), 3).json())
    };
    std::thread::sleep(std::time::Duration::from_millis(300));
    let fifth = poll(&ana);
    let (answer, took) = first.join().unwrap();
    assert!(took < std::time::Duration::from_secs(5), "the oldest poll kept waiting: {took:?}");
    assert_eq!((answer["version"].as_str(), answer["superseded"].as_bool()), (Some(version.as_str()), Some(true)));
    assert_eq!(ben_poll.join().unwrap()["superseded"], Value::Null);
    // The others are still waiting, and an append wakes them with the new head.
    let p = ana.call("GET", "/v1/sr/projects", None).json()["projects"][0]["id"].as_str().unwrap().to_owned();
    assert_eq!(ana.append(&p, "a", 1, &Project::new().add_text("f1", "a.tex", None, "x")).status, 201);
    for waiter in others.into_iter().chain([fifth]) {
        let (answer, took) = waiter.join().unwrap();
        assert!(took < std::time::Duration::from_secs(15), "{took:?}");
        assert_eq!((answer["projects"][&p]["head"].as_i64(), answer["superseded"].as_bool()), (Some(1), None));
    }
}

#[test]
fn a_client_id_belongs_to_the_account_that_uses_it() {
    // Review L1: client IDs were unique per project, so an editor who appended with another
    // member's `Scribyra-Client` at a future sequence number made that member's own append
    // there fail with 409. Slots are now per (project, account, client, client sequence).
    let sr = start(Blobs::Fs);
    let (ana, ben) = (sr.api(&sr.login("alice")), sr.api(&sr.login("ben")));
    let p = ana.create("Squatted");
    assert_eq!(ana.invite(&p, "ben@example.org", "editor").status, 201);
    let doc = Project::new();
    let first = doc.add_text("f1", "main.tex", None, "x");
    assert_eq!(ana.append(&p, "browser-a", 1, &first).status, 201);
    // Ben takes Ana's client ID at her next sequence numbers, with his own bytes and with hers.
    let (squat, next) = (doc.type_text("f1", " squat"), doc.type_text("f1", " mine"));
    assert_eq!(ben.append(&p, "browser-a", 2, &squat).json()["seq"], 2);
    assert_eq!(ben.append(&p, "browser-a", 1, &first).json()["seq"], 3);
    // Ana's own appends at those slots still go through, and her retries get her own entries.
    assert_eq!((ana.append(&p, "browser-a", 2, &next).status, ana.append(&p, "browser-a", 2, &next).json()["seq"].as_i64()), (201, Some(4)));
    assert_eq!(ana.append(&p, "browser-a", 1, &first).json()["seq"], 1);
    assert_eq!(ben.append(&p, "browser-a", 2, &squat).json()["seq"], 2);
    // Within one account a slot still holds one update.
    assert_eq!(ana.append(&p, "browser-a", 2, &squat).status, 409);
}

#[test]
fn emails_are_normalised_once_and_compared_as_stored() {
    // Review L2: invitations lowercased emails in Rust (Unicode) but matched accounts with
    // PostgreSQL's lower() (by the database's locale: ASCII only under C), so a person whose
    // provider sends `Émile@…` was never matched by an invitation to `émile@…`. Emails are now
    // normalised once (trimmed, Unicode lowercase) when stored and compared as stored.
    let mut users = users();
    for (name, email) in [("emile", "Émile@Example.org"), ("odon", "ÖDÖN@example.org")] {
        users.as_array_mut().unwrap().push(json!({"sub": format!("sub-{name}"), "username": name, "password": format!("pw-{name}"), "email": email, "email_verified": true, "name": name, "roles": [MEMBER]}));
    }
    let sr = Sr::start(Blobs::Fs, users, json!({}), json!({}));
    let ana = sr.api(&sr.login("alice"));
    let p = ana.create("Accents");
    // An account that exists is shared at once, whatever case the inviter types.
    let emile = sr.api(&sr.login("emile"));
    assert_eq!(postgres().psql(&sr.db(), "SELECT email FROM accounts WHERE subject = 'sub-emile'"), "émile@example.org");
    assert_eq!(ana.invite(&p, " ÉMILE@example.ORG ", "viewer").json()["status"], "shared");
    assert_eq!(emile.details(&p).json()["role"], "viewer");
    // A pending invitation is accepted at the first sign-in.
    assert_eq!(ana.invite(&p, "ödön@EXAMPLE.org", "editor").json()["invitation"]["email"], "ödön@example.org");
    let odon = sr.api(&sr.login("odon"));
    assert_eq!(odon.details(&p).json()["role"], "editor");
    assert_eq!(sr.env.client().me(&odon.token).json()["email"], "ödön@example.org");
}

#[test]
fn a_cancelled_or_failed_compaction_does_not_leave_the_project_claimed() {
    // Review L3: the in-process "compacting" mark was cleared only when compaction returned, so
    // a panic (or a cancelled future) left the project marked and never compacted again here.
    let mut sr = start(Blobs::Fs);
    let ana = sr.api(&sr.login("alice"));
    let p = ana.create("Claimed");
    assert_eq!(ana.append(&p, "a", 1, &Project::new().add_text("f1", "a.tex", None, "x")).status, 201);
    let config = sr.env.service.config.clone();
    sr.env.service.stop();
    tokio::runtime::Runtime::new().unwrap().block_on(async {
        let config: scribyra_sync::config::Config = serde_json::from_value(config).unwrap();
        let store = std::sync::Arc::new(scribyra_sync::store::Store::open(config).await.unwrap());
        let projects = scribyra_sync::server_projects::Projects::new(store).unwrap().unwrap();
        // Dropped at its first wait, after it marked the project.
        assert!(tokio::time::timeout(std::time::Duration::ZERO, projects.compact(&p)).await.is_err());
        assert_eq!(projects.compact(&p).await.unwrap(), Some(1));
    });
}

#[test]
fn a_floor_that_moves_during_a_read_answers_410_not_500() {
    // Review L4: a log page whose entry bodies were collected (the floor moved and garbage
    // removal ran) between reading the rows and reading the blobs answered 500. The read is
    // paused there by locking `sr_entries` while the floor moves and the blobs go.
    let sr = Sr::start(Blobs::Fs, users(), json!({"entry_inline_bytes": 64}), json!({}));
    let ana = sr.api(&sr.login("alice"));
    let p = ana.create("Racing");
    let doc = Project::new();
    assert_eq!(ana.append(&p, "a", 1, &doc.add_text("f1", "a.tex", None, &"x".repeat(200))).status, 201);
    assert_eq!(ana.append(&p, "a", 2, &doc.type_text("f1", &"y".repeat(200))).status, 201);
    let keys = blob_keys(&sr);
    assert_eq!(keys.len(), 2);
    let runtime = tokio::runtime::Runtime::new().unwrap();
    let mut lock = runtime.block_on(async {
        use sqlx::Connection;
        let mut c = sqlx::PgConnection::connect(&sr.db()).await.unwrap();
        sqlx::query("BEGIN").execute(&mut c).await.unwrap();
        sqlx::query("LOCK TABLE sr_entries IN ACCESS EXCLUSIVE MODE").execute(&mut c).await.unwrap();
        c
    });
    let reader = {
        let ana = ana.clone();
        let p = p.clone();
        std::thread::spawn(move || ana.log(&p, 0))
    };
    std::thread::sleep(std::time::Duration::from_millis(1000));
    postgres().psql(&sr.db(), &format!("UPDATE sr_projects SET floor_seq = 2 WHERE project = '{p}'"));
    let store = blob_store(&sr);
    runtime.block_on(async {
        for key in &keys {
            store.delete(&scribyra_sync::blobs::BlobKey::new(key.clone()).unwrap()).await.unwrap();
        }
        sqlx::query("ROLLBACK").execute(&mut lock).await.unwrap();
    });
    let reply = reader.join().unwrap();
    assert_eq!((reply.status, reply.json()["error"].as_str(), reply.json()["floor"].as_i64()), (410, Some("compacted"), Some(2)));
    // A body that is gone without the floor having moved is still a server error.
    postgres().psql(&sr.db(), &format!("UPDATE sr_projects SET floor_seq = 0 WHERE project = '{p}'"));
    assert_eq!(ana.log(&p, 0).status, 500);
}

#[test]
fn signing_out_ends_the_sessions_heads_polls() {
    // Review L6: a revoked session kept its heads poll (and its view of the projects' heads) for
    // up to 25 seconds. A revocation now notifies the account's polls, which check the session.
    let sr = start(Blobs::Fs);
    let (ana, other) = (sr.api(&sr.login("alice")), sr.api(&sr.login("alice")));
    ana.create("Watched");
    let version = ana.heads(None, 0).json()["version"].as_str().unwrap().to_owned();
    let poll = |api: &Api| {
        let (api, version) = (api.clone(), version.clone());
        std::thread::spawn(move || {
            let t = std::time::Instant::now();
            (api.heads(Some(&version), 20).status, t.elapsed())
        })
    };
    let (mine, theirs) = (poll(&ana), poll(&other));
    std::thread::sleep(std::time::Duration::from_millis(500));
    assert_eq!(sr.env.client().logout(&ana.token).status, 200);
    let (status, took) = mine.join().unwrap();
    assert_eq!(status, 401);
    assert!(took < std::time::Duration::from_secs(5), "{took:?}");
    // The same person's other session keeps waiting.
    let (status, took) = theirs.join().unwrap();
    assert_eq!(status, 200);
    assert!(took >= std::time::Duration::from_secs(19), "{took:?}");
}

#[test]
fn a_member_removed_during_an_append_does_not_get_it_stored() {
    // Review L7: access was checked before the append's transaction, so an editor removed in
    // between still had the append committed. The append now checks again under the project's
    // lock. The append is paused at that lock while the owner removes the editor.
    let sr = start(Blobs::Fs);
    let (ana, ben) = (sr.api(&sr.login("alice")), sr.api(&sr.login("ben")));
    let p = ana.create("Removal");
    assert_eq!(ana.invite(&p, "ben@example.org", "editor").status, 201);
    let doc = Project::new();
    let runtime = tokio::runtime::Runtime::new().unwrap();
    let hold = |p: &str| {
        runtime.block_on(async {
            use sqlx::Connection;
            let mut c = sqlx::PgConnection::connect(&sr.db()).await.unwrap();
            sqlx::query("BEGIN").execute(&mut c).await.unwrap();
            sqlx::query("SELECT 1 FROM sr_projects WHERE project = $1 FOR UPDATE").bind(p).execute(&mut c).await.unwrap();
            c
        })
    };
    for (what, change, expected) in [("removed", None, 404), ("made a viewer", Some("viewer"), 403)] {
        if what == "made a viewer" {
            assert_eq!(ana.invite(&p, "ben@example.org", "editor").status, 201);
        }
        let mut lock = hold(&p);
        let append = {
            let (ben, p, update) = (ben.clone(), p.clone(), doc.add_text(what, "x.tex", None, what));
            std::thread::spawn(move || ben.append(&p, "b", if what == "removed" { 1 } else { 2 }, &update).status)
        };
        std::thread::sleep(std::time::Duration::from_millis(1000));
        let status = match change {
            None => ana.call("DELETE", &format!("/v1/sr/projects/{p}/members/{}", account(&sr, "ben")), None).status,
            Some(role) => ana.call("PUT", &format!("/v1/sr/projects/{p}/members/{}", account(&sr, "ben")), Some(json!({"role": role}))).status,
        };
        assert!(status == 204 || status == 200, "{what}: {status}");
        runtime.block_on(async { sqlx::query("ROLLBACK").execute(&mut lock).await.unwrap() });
        assert_eq!(append.join().unwrap(), expected, "{what}");
    }
    assert_eq!(postgres().psql(&sr.db(), "SELECT count(*) FROM sr_entries"), "0");
}
