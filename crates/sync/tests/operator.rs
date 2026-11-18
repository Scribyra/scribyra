//! The contract a Kubernetes operator relies on: `scribyra-sync migrate` as its own command,
//! `migrate_on_start: false` replicas that refuse a schema behind or ahead of them, `/healthz` and
//! `/readyz`, settings from environment variables (nested deployment fields too), and SIGTERM
//! ending long polls and exiting 0 within the grace period.
mod support;
use serde_json::json;
use std::time::{Duration, Instant};
use support::{sr::*, *};

#[test]
fn migrations_run_as_a_separate_command_and_replicas_check_the_schema() {
    let mut s = Service::configure(json!({"migrate_on_start": false}));
    // A fresh database: a replica that may not migrate refuses to start.
    let refused = s.start().expect_err("started on an empty schema");
    assert!(refused.contains("\"schema_mismatch\"") && refused.contains("\"behind\""), "{refused}");
    let (code, out) = s.run(&["migrate"]);
    assert_eq!(code, 0, "{out}");
    let event: serde_json::Value = serde_json::from_str(out.trim()).unwrap();
    assert_eq!(event["event"], "migrated");
    assert!(event["applied"].as_u64().unwrap() >= 8);
    // Again: nothing to apply.
    assert_eq!(serde_json::from_str::<serde_json::Value>(s.run(&["migrate"]).1.trim()).unwrap()["applied"], 0);
    s.start().unwrap();
    for path in ["/health", "/healthz", "/ready", "/readyz"] {
        assert_eq!(status(&format!("{}{path}", s.url)), 200, "{path}");
    }
    // A schema from a newer build: readiness fails at once, and a new replica refuses to start.
    postgres().psql(s.database_url(), "INSERT INTO _sqlx_migrations (version, description, success, checksum, execution_time) VALUES (99990001, 'future', true, '\\x00', 0)");
    assert_eq!(status(&format!("{}/readyz", s.url)), 503);
    assert_eq!(status(&format!("{}/healthz", s.url)), 200);
    s.stop();
    let refused = s.start().expect_err("started on a newer schema");
    assert!(refused.contains("\"ahead\""), "{refused}");
    let (code, _) = s.run(&["migrate"]);
    assert_ne!(code, 0, "migrate must refuse a newer schema");
    // migrate_on_start (the default) refuses it too.
    s.reconfigure(json!({"migrate_on_start": true}));
    assert!(s.start().is_err());
}

#[test]
fn settings_come_from_the_environment_including_deployment_fields() {
    // S3 blobs: a filesystem blob directory belongs to one process.
    let sr = Sr::start(Blobs::S3, support::sso::people(), json!({}), json!({}));
    let mut config = sr.env.service.config.clone();
    // Start a second instance whose name, offline policy and grace period come from variables.
    config["bind"] = json!(format!("127.0.0.1:{}", free_port()));
    let mut s = Service::configure(config);
    let mut child = s
        .command(&[])
        .env("SCRIBYRA_SERVICE_DEPLOYMENT_NAME", "Env Lab")
        .env("SCRIBYRA_SERVICE_DEPLOYMENT_OFFLINE", "false")
        .env("SCRIBYRA_SERVICE_SHUTDOWN_GRACE_SECONDS", "3")
        .stdout(std::process::Stdio::piped())
        .spawn()
        .unwrap();
    let url = format!("http://{}", s.config["bind"].as_str().unwrap());
    let deadline = Instant::now() + Duration::from_secs(20);
    while status(&format!("{url}/healthz")) != 200 {
        assert!(Instant::now() < deadline, "the instance did not start");
        std::thread::sleep(Duration::from_millis(100));
    }
    let info = support::sso::fetch(&format!("{url}/v1/deployment"), None).json();
    assert_eq!((info["name"].as_str(), info["offline"].as_bool()), (Some("Env Lab"), Some(false)));
    let _ = std::process::Command::new("kill").args(["-TERM", &child.id().to_string()]).status();
    assert!(child.wait().unwrap().success());
    s.stop();
}

#[test]
fn sigterm_ends_long_polls_and_exits_zero_within_the_grace_period() {
    let mut sr = Sr::start(Blobs::Fs, support::sso::people(), json!({"shutdown_grace_seconds": 5}), json!({}));
    let ana = sr.api(&sr.login("alice"));
    ana.create("Polled");
    let version = ana.heads(None, 0).json()["version"].as_str().unwrap().to_owned();
    let poll = {
        let api = ana.clone();
        std::thread::spawn(move || {
            let t = Instant::now();
            (api.heads(Some(&version), 25).status, t.elapsed())
        })
    };
    std::thread::sleep(Duration::from_millis(500));
    let t = Instant::now();
    let exit = sr.env.service.terminate();
    let took = t.elapsed();
    assert!(exit.success(), "{exit:?}: {}", sr.env.service.logs.lock().unwrap());
    assert!(took < Duration::from_secs(5), "shutdown took {took:?}");
    let (status, waited) = poll.join().unwrap();
    assert_eq!(status, 200);
    assert!(waited < Duration::from_secs(6), "the poll was not ended: {waited:?}");
    let logs = sr.env.service.logs.lock().unwrap().clone();
    assert!(logs.contains("\"shutdown\"") && logs.contains("\"stopped\""), "{logs}");
}
