//! `/v1/objects` end to end through the real binary, against real PostgreSQL with filesystem
//! blobs and with Garage (S3) blobs; ownership, `verify` and `migrate-sqlite`.
mod support;
use serde_json::json;
use std::{path::Path, process::Command};
use support::*;

fn s3() -> serde_json::Value {
    garage().config()
}
fn fs() -> serde_json::Value {
    json!({})
}
fn with(mut base: serde_json::Value, extra: serde_json::Value) -> serde_json::Value {
    for (k, v) in extra.as_object().unwrap() {
        base[k] = v.clone();
    }
    base
}
fn usage(s: &Service, scope: &str) -> String {
    postgres().psql(
        s.database_url(),
        &format!("SELECT bytes || ',' || objects FROM usage WHERE scope = '{scope}'"),
    )
}

fn object_semantics(backend: serde_json::Value) {
    let mut s = Service::new(with(
        backend,
        json!({"object_bytes": 256, "namespace_bytes": 512, "total_bytes": 512, "namespace_objects": 3, "total_objects": 3}),
    ));
    assert_eq!(status(&format!("{}/ready", s.url)), 200);
    let a = random_bytes(32);
    assert_eq!(s.get(&a).0, 404);
    assert_eq!(s.put(&a), 201);
    assert_eq!(s.put(&a), 204);
    assert_eq!(s.get(&a), (200, a.clone()));
    // Hash of the opaque bytes, minimum and maximum size.
    assert_eq!(put(&s.object_url(&a), &s.bearer, &random_bytes(32)), 400);
    assert_eq!(s.put(&random_bytes(15)), 400);
    assert_eq!(s.put(&random_bytes(257)), 413);
    assert_eq!(s.put(&random_bytes(256)), 201);
    assert_eq!(s.put(&random_bytes(16)), 201);
    // Quota: three objects; retries of existing objects still succeed and consume nothing.
    let d = random_bytes(16);
    assert_eq!(s.put(&d), 507);
    assert_eq!(s.put(&d), 507);
    assert_eq!(s.put(&a), 204);
    assert_eq!(s.get(&d).0, 404);
    assert_eq!(usage(&s, "global"), "304,3");
    assert_eq!(usage(&s, &format!("namespace:{}", s.namespace)), "304,3");
    // Acknowledged data survives SIGKILL and restart.
    s.kill();
    s.start().unwrap();
    assert_eq!(s.get(&a), (200, a.clone()));
    assert_eq!(s.put(&a), 204);
    let logs = s.logs.lock().unwrap().clone();
    for secret in [s.database_url(), &s.bearer, &s.namespace, &sha256(&a)] {
        assert!(!logs.contains(secret), "logs leak a private value");
    }
    if let Some(endpoint) = s.config["s3_endpoint"].as_str() {
        assert!(!logs.contains(endpoint));
    }
}

#[test]
fn object_routes_with_filesystem_blobs() {
    object_semantics(fs());
}
#[test]
fn object_routes_with_garage_blobs() {
    object_semantics(s3());
}

fn concurrent_quota(backend: serde_json::Value) {
    let s = Service::new(with(
        backend,
        json!({"object_bytes": 64, "namespace_bytes": 320, "total_bytes": 320, "namespace_objects": 5, "total_objects": 5, "uploads": 12, "principal_uploads": 12, "namespace_uploads": 12}),
    ));
    let bodies: Vec<Vec<u8>> = (0..12).map(|_| random_bytes(64)).collect();
    let statuses: Vec<u16> = std::thread::scope(|scope| {
        let handles: Vec<_> = bodies.iter().map(|b| scope.spawn(|| s.put(b))).collect();
        handles.into_iter().map(|h| h.join().unwrap()).collect()
    });
    assert_eq!(
        statuses.iter().filter(|&&x| x == 201).count(),
        5,
        "{statuses:?}"
    );
    assert!(
        statuses.iter().all(|&x| x == 201 || x == 507),
        "{statuses:?}"
    );
    assert_eq!(usage(&s, "global"), "320,5");
    for (body, status) in bodies.iter().zip(&statuses) {
        assert_eq!(s.get(body).0, if *status == 201 { 200 } else { 404 });
    }
}
#[test]
fn concurrent_writes_never_exceed_quota_filesystem() {
    concurrent_quota(fs());
}
#[test]
fn concurrent_writes_never_exceed_quota_garage() {
    concurrent_quota(s3());
}

fn sigkill_during_upload(backend: serde_json::Value) {
    let mut s = Service::new(backend);
    let bytes = random_bytes(4096);
    let socket = partial_put(&s, &bytes, 2048);
    std::thread::sleep(std::time::Duration::from_millis(200));
    s.kill();
    drop(socket);
    s.start().unwrap();
    assert_eq!(s.get(&bytes).0, 404);
    assert_eq!(
        postgres().psql(s.database_url(), "SELECT count(*) FROM objects"),
        "0"
    );
    assert_eq!(s.put(&bytes), 201);
    assert_eq!(s.get(&bytes), (200, bytes));
}
#[test]
fn sigkill_during_upload_acknowledges_nothing_filesystem() {
    sigkill_during_upload(fs());
}
#[test]
fn sigkill_during_upload_acknowledges_nothing_garage() {
    sigkill_during_upload(s3());
}

#[test]
fn advisory_lock_refuses_a_second_instance_on_the_same_database() {
    let s = Service::new(fs());
    // A different blob directory: only the database lock can refuse this one.
    let mut other = Service::configure(json!({"database_url": s.database_url()}));
    let error = other.start().unwrap_err();
    assert!(error.contains("exit status: 1"), "{error}");
    // Subcommands need ownership too.
    assert_eq!(other.run(&["verify"]).0, 1);
    drop(s);
    other.start().unwrap();
}

#[test]
fn future_migrations_and_bad_configuration_are_refused() {
    let mut s = Service::new(fs());
    s.stop();
    postgres().psql(
        s.database_url(),
        "INSERT INTO _sqlx_migrations (version, description, success, checksum, execution_time) \
         VALUES (9999, 'future', true, '\\x00', 0)",
    );
    assert!(s.start().is_err());
    postgres().psql(
        s.database_url(),
        "DELETE FROM _sqlx_migrations WHERE version = 9999",
    );
    s.start().unwrap();
    s.stop();
    for bad in [
        json!({"database_connections": 0}),
        json!({"database_url_file": s.dir.join("url")}), // both URL forms at once
        json!({"blob_store": "s3"}),                     // incomplete S3 settings
        json!({"blob_store": "tape"}),
    ] {
        let mut t = Service::configure(with(json!({"database_url": s.database_url()}), bad));
        assert!(t.start().is_err());
    }
}

#[test]
fn database_url_file_and_unix_socket_work() {
    let url = postgres().database();
    let mut s = Service::configure(json!({}));
    let file = s.dir.join("database-url");
    std::fs::write(&file, format!("{}\n", postgres().socket_url(&url))).unwrap();
    let config = with(s.config.clone(), json!({"database_url_file": file}));
    let mut config = config.as_object().unwrap().clone();
    config.remove("database_url");
    s.config = serde_json::Value::Object(config);
    std::fs::write(&s.config_path, s.config.to_string()).unwrap();
    s.start().unwrap();
    let bytes = random_bytes(64);
    assert_eq!(s.put(&bytes), 201);
    assert_eq!(postgres().psql(&url, "SELECT count(*) FROM objects"), "1");
    // Environment overrides reach the new string fields too.
    s.stop();
    let output = s
        .command(&["verify"])
        .env("SCRIBYRA_SERVICE_DATABASE_URL_FILE", s.dir.join("missing"))
        .output()
        .unwrap();
    assert_eq!(output.status.code(), Some(1));
}

#[test]
fn verify_detects_missing_and_corrupt_blobs() {
    let mut s = Service::new(fs());
    let (a, b, c) = (random_bytes(40), random_bytes(41), random_bytes(42));
    for x in [&a, &b, &c] {
        assert_eq!(s.put(x), 201);
    }
    s.stop();
    let (code, out) = s.run(&["verify"]);
    assert_eq!(code, 0, "{out}");
    assert!(
        out.contains("\"objects\":3,\"missing\":0,\"corrupt\":0,\"usage_mismatch\":0"),
        "{out}"
    );
    let objects = s.dir.join("data/objects").join(&s.namespace);
    let path = |x: &[u8]| objects.join(sha256(x));
    std::fs::remove_file(path(&a)).unwrap();
    std::fs::write(path(&b), random_bytes(41)).unwrap();
    let (code, out) = s.run(&["verify"]);
    assert_eq!(code, 1);
    assert!(out.contains("\"missing\":1,\"corrupt\":1"), "{out}");
    // Startup does not scan objects, but every read verifies: corrupt bytes are never served.
    s.start().unwrap();
    assert_eq!(s.get(&b).0, 500);
    assert_eq!(s.put(&b), 500);
    assert_eq!(s.get(&c), (200, c.clone()));
    s.stop();
    std::fs::write(path(&a), &a).unwrap();
    std::fs::write(path(&b), &b).unwrap();
    postgres().psql(
        s.database_url(),
        "UPDATE usage SET objects = objects + 1 WHERE scope = 'global'",
    );
    let (code, out) = s.run(&["verify"]);
    assert_eq!(code, 1);
    assert!(out.contains("\"usage_mismatch\":1"), "{out}");
}

#[test]
fn verify_detects_a_missing_s3_object() {
    let mut s = Service::new(s3());
    let a = random_bytes(40);
    assert_eq!(s.put(&a), 201);
    s.stop();
    assert_eq!(s.run(&["verify"]).0, 0);
    let settings = scribyra_sync::blobs::S3Settings {
        endpoint: s.config["s3_endpoint"].as_str().unwrap().into(),
        region: "garage".into(),
        bucket: s.config["s3_bucket"].as_str().unwrap().into(),
        access_key_id: s.config["s3_access_key_id"].as_str().unwrap().into(),
        secret_access_key: std::fs::read_to_string(&garage().secret_file)
            .unwrap()
            .trim()
            .into(),
        path_style: true,
    };
    let store = scribyra_sync::blobs::S3BlobStore::new(settings).unwrap();
    let key = scribyra_sync::blobs::BlobKey::new(format!("objects/{}/{}", s.namespace, sha256(&a)))
        .unwrap();
    tokio::runtime::Runtime::new()
        .unwrap()
        .block_on(scribyra_sync::blobs::BlobStore::delete(&store, &key))
        .unwrap();
    let (code, out) = s.run(&["verify"]);
    assert_eq!(code, 1);
    assert!(out.contains("\"missing\":1"), "{out}");
}

/// A milestone-S data directory as the SQLite service wrote it.
fn s_directory(dir: &Path, objects: &[(String, Vec<u8>)], version: u32) {
    std::fs::create_dir_all(dir.join("blobs")).unwrap();
    let db = rusqlite::Connection::open(dir.join("metadata.sqlite")).unwrap();
    db.execute_batch(&format!(
        "PRAGMA journal_mode=WAL; CREATE TABLE objects(namespace TEXT NOT NULL, hash TEXT NOT NULL, size INTEGER NOT NULL, PRIMARY KEY(namespace,hash)); PRAGMA user_version={version};"
    ))
    .unwrap();
    for (ns, bytes) in objects {
        db.execute(
            "INSERT INTO objects(namespace,hash,size) VALUES(?1,?2,?3)",
            rusqlite::params![ns, sha256(bytes), bytes.len() as i64],
        )
        .unwrap();
        std::fs::write(
            dir.join("blobs").join(format!("{ns}-{}", sha256(bytes))),
            bytes,
        )
        .unwrap();
    }
    std::fs::File::create(dir.join("service.lock")).unwrap();
}

fn migrate(backend: serde_json::Value) {
    let mut s = Service::configure(backend);
    let other = random_hex(32);
    let objects: Vec<(String, Vec<u8>)> = (0..5)
        .map(|n| {
            (
                if n < 3 {
                    s.namespace.clone()
                } else {
                    other.clone()
                },
                random_bytes(100 + n),
            )
        })
        .collect();
    let old = s.dir.join("old");
    s_directory(&old, &objects, 1);
    let old_s = old.to_str().unwrap();
    // The configured quotas are smaller than the data: the import preserves it anyway.
    s.reconfigure(json!({"total_objects": 2, "namespace_objects": 1}));
    let (code, out) = s.run(&["migrate-sqlite", old_s]);
    assert_eq!(code, 0, "{out}");
    assert!(
        out.contains("\"objects\":5,\"imported\":5,\"existing\":0"),
        "{out}"
    );
    let (code, out) = s.run(&["migrate-sqlite", old_s]);
    assert_eq!(code, 0, "{out}");
    assert!(
        out.contains("\"objects\":5,\"imported\":0,\"existing\":5"),
        "{out}"
    );
    assert_eq!(s.run(&["verify"]).0, 0);
    s.start().unwrap();
    for (ns, bytes) in &objects[..3] {
        assert_eq!(
            get(&s.object_url_in(ns, bytes), &s.bearer),
            (200, bytes.clone())
        );
    }
    assert_eq!(
        usage(&s, "global"),
        format!("{},5", 100 + 101 + 102 + 103 + 104)
    );
    assert_eq!(usage(&s, &format!("namespace:{other}")), "207,2");
    // Over quota after the import: new writes are refused, retries are not.
    assert_eq!(s.put(&random_bytes(16)), 507);
    assert_eq!(s.put(&objects[0].1), 204);
}
#[test]
fn migrate_sqlite_to_filesystem_blobs() {
    migrate(fs());
}
#[test]
fn migrate_sqlite_to_garage_blobs() {
    migrate(s3());
}

#[test]
fn migrate_sqlite_refuses_corrupt_future_or_live_directories() {
    let s = Service::configure(fs());
    let ns = random_hex(32);
    let objects: Vec<(String, Vec<u8>)> =
        (0..3).map(|n| (ns.clone(), random_bytes(50 + n))).collect();
    // A corrupt blob refuses the whole import before anything is written.
    let corrupt = s.dir.join("corrupt");
    s_directory(&corrupt, &objects, 1);
    std::fs::write(
        corrupt
            .join("blobs")
            .join(format!("{ns}-{}", sha256(&objects[2].1))),
        random_bytes(52),
    )
    .unwrap();
    assert_eq!(s.run(&["migrate-sqlite", corrupt.to_str().unwrap()]).0, 1);
    assert_eq!(
        postgres().psql(s.database_url(), "SELECT count(*) FROM objects"),
        "0"
    );
    // A missing blob too.
    std::fs::remove_file(
        corrupt
            .join("blobs")
            .join(format!("{ns}-{}", sha256(&objects[2].1))),
    )
    .unwrap();
    assert_eq!(s.run(&["migrate-sqlite", corrupt.to_str().unwrap()]).0, 1);
    // Future schema.
    let future = s.dir.join("future");
    s_directory(&future, &objects, 2);
    assert_eq!(s.run(&["migrate-sqlite", future.to_str().unwrap()]).0, 1);
    // A directory whose old service still holds its lock.
    let live = s.dir.join("live");
    s_directory(&live, &objects, 1);
    let lock = std::fs::File::options()
        .write(true)
        .open(live.join("service.lock"))
        .unwrap();
    lock.try_lock().unwrap();
    assert_eq!(s.run(&["migrate-sqlite", live.to_str().unwrap()]).0, 1);
    drop(lock);
    // Not a directory of the service at all.
    assert_eq!(
        s.run(&["migrate-sqlite", s.dir.join("absent").to_str().unwrap()])
            .0,
        1
    );
    assert_eq!(
        postgres().psql(s.database_url(), "SELECT count(*) FROM objects"),
        "0"
    );
    assert_eq!(s.run(&["migrate-sqlite", live.to_str().unwrap()]).0, 0);
    assert_eq!(
        postgres().psql(s.database_url(), "SELECT count(*) FROM objects"),
        "3"
    );
}

#[test]
fn unknown_commands_print_usage() {
    let output = Command::new(BINARY).arg("bogus").output().unwrap();
    assert_eq!(output.status.code(), Some(2));
}
