use scribyra_folders::Snapshot;
use serde_json::{Value, json};
use std::{
    fs,
    io::Write,
    path::Path,
    process::{Command, Stdio},
};
use tempfile::tempdir;

fn command(root: &Path, op: &str, args: &[&str], input: Option<&Value>) -> std::process::Output {
    let mut child = Command::new(env!("CARGO_BIN_EXE_scribyra-folders"))
        .arg(op)
        .arg(root)
        .arg("public-cli-project")
        .args(args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    if let Some(input) = input {
        child
            .stdin
            .take()
            .unwrap()
            .write_all(serde_json::to_string(input).unwrap().as_bytes())
            .unwrap();
    } else {
        drop(child.stdin.take());
    }
    child.wait_with_output().unwrap()
}
fn call(root: &Path, op: &str, args: &[&str], input: Option<&Value>) -> Value {
    let output = command(root, op, args, input);
    assert!(
        output.status.success(),
        "{op}: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    serde_json::from_slice(&output.stdout).unwrap()
}
fn confirm(root: &Path, receipt: &Value) {
    let result: Snapshot = serde_json::from_value(receipt["result"].clone()).unwrap();
    let id = receipt["id"].as_str().unwrap();
    let result = call(root, "confirm", &[id, &result.digest()], None);
    assert_eq!(result["confirmed"], true);
}
#[test]
fn independent_cli_processes_import_merge_confirm_and_export_retained_versions() {
    let dir = tempdir().unwrap();
    let root = dir.path();
    fs::write(root.join("main.tex"), "One\nTwo\nThree\n").unwrap();
    fs::write(root.join("image.png"), [0, 255]).unwrap();
    assert!(!command(root, "status", &[], None).status.success());
    assert!(!root.join(".scribyra-sync").exists());
    call(root, "connect", &[], None);
    let preview = call(root, "preview", &[], Some(&json!({"local":{"entries":[]}})));
    let pending = call(root, "prepare", &[], Some(&preview));
    let initial = call(root, "apply", &[pending["id"].as_str().unwrap()], None);
    confirm(root, &initial);
    let mut local = initial["result"].clone();
    local["entries"]
        .as_array_mut()
        .unwrap()
        .iter_mut()
        .find(|e| e["path"] == "main.tex")
        .unwrap()["data"]["content"] = json!("First\nTwo\nThree\n");
    fs::write(root.join("main.tex"), "One\nTwo\nLast\n").unwrap();
    let preview = call(root, "preview", &[], Some(&json!({"local":local})));
    assert!(
        preview["review"]["conflicts"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    let pending = call(root, "prepare", &[], Some(&preview));
    let id = pending["id"].as_str().unwrap();
    let receipt = call(root, "apply", &[id], None);
    assert_eq!(receipt["confirmed"], false);
    let status = call(root, "status", &[], None);
    assert_eq!(status["pending"]["phase"], "disk-applied");
    assert_eq!(status["baseline"], initial["result"]);
    confirm(root, &receipt);
    assert_eq!(
        fs::read_to_string(root.join("main.tex")).unwrap(),
        "First\nTwo\nLast\n"
    );
    assert_eq!(fs::read(root.join("image.png")).unwrap(), [0, 255]);
    let retained = call(root, "recoveries", &[], None);
    assert_eq!(retained.as_array().unwrap().len(), 2);
    assert!(
        retained
            .as_array()
            .unwrap()
            .iter()
            .all(|r| r["status"] == "confirmed")
    );
    let disk = call(root, "recovery", &[id, "disk"], None);
    assert!(
        disk["snapshot"]["entries"]
            .as_array()
            .unwrap()
            .iter()
            .any(|e| e["data"]["content"] == "One\nTwo\nLast\n")
    );
    let result = call(root, "recovery", &[id, "result"], None);
    assert_eq!(result["snapshot"], receipt["result"]);
    let hash = scribyra_core::blob::hash(&[0, 255]);
    let output = command(root, "object", &[&hash, "2"], None);
    assert!(output.status.success());
    assert_eq!(output.stdout, [0, 255]);
}

#[test]
fn cli_abandon_keeps_disk_and_recovery_but_does_not_claim_a_saved_baseline() {
    let dir = tempdir().unwrap();
    let root = dir.path();
    call(root, "connect", &[], None);
    let preview = call(
        root,
        "preview",
        &[],
        Some(
            &json!({"local":{"entries":[{"id":"a","path":"main.tex","data":{"kind":"text","content":"new"}}]}}),
        ),
    );
    let pending = call(root, "prepare", &[], Some(&preview));
    let id = pending["id"].as_str().unwrap();
    call(root, "apply", &[id], None);
    call(root, "abandon", &[id], None);
    let status = call(root, "status", &[], None);
    assert!(status["pending"].is_null());
    assert!(status["baseline"]["entries"].as_array().unwrap().is_empty());
    assert_eq!(fs::read_to_string(root.join("main.tex")).unwrap(), "new");
    assert_eq!(
        call(root, "recoveries", &[], None)[0]["status"],
        "abandoned"
    );
    assert_eq!(
        call(root, "recovery", &[id, "result"], None)["snapshot"]["entries"][0]["data"]["content"],
        "new"
    );
    assert!(!command(root, "apply", &[id], None).status.success());
}

#[test]
fn ordinary_git_add_excludes_private_sync_and_recovery_state() {
    let folder = tempdir().unwrap();
    let root = folder.path();
    fs::write(root.join("main.tex"), "public source").unwrap();
    assert!(
        Command::new("git")
            .arg("init")
            .arg(root)
            .output()
            .unwrap()
            .status
            .success()
    );
    call(root, "connect", &[], None);
    let preview = call(root, "preview", &[], Some(&json!({"local":{"entries":[]}})));
    let p = call(root, "prepare", &[], Some(&preview));
    let receipt = call(root, "apply", &[p["id"].as_str().unwrap()], None);
    confirm(root, &receipt);
    assert!(
        Command::new("git")
            .arg("-C")
            .arg(root)
            .args(["add", "."])
            .output()
            .unwrap()
            .status
            .success()
    );
    let tracked = Command::new("git")
        .arg("-C")
        .arg(root)
        .arg("ls-files")
        .output()
        .unwrap();
    assert!(tracked.status.success());
    assert_eq!(String::from_utf8(tracked.stdout).unwrap(), "main.tex\n");
}

#[test]
fn explicit_native_diagnostics_preserve_cli_output_and_exclude_inspected_content() {
    let root = tempdir().unwrap();
    let diagnostics = tempdir().unwrap();
    fs::write(root.path().join("PRIVATE_FILENAME.tex"), "PRIVATE_SOURCE").unwrap();
    let run = |enabled: bool| {
        Command::new(env!("CARGO_BIN_EXE_scribyra-folders"))
            .arg("snapshot")
            .arg(root.path())
            .env("SCRIBYRA_DIAGNOSTICS", if enabled { "1" } else { "0" })
            .env("SCRIBYRA_DIAGNOSTICS_DIR", diagnostics.path())
            .output()
            .unwrap()
    };
    let disabled = run(false);
    assert!(disabled.status.success());
    assert_eq!(fs::read_dir(diagnostics.path()).unwrap().count(), 0);
    let enabled = run(true);
    assert!(enabled.status.success());
    assert_eq!(enabled.stdout, disabled.stdout);
    let child = fs::read_dir(diagnostics.path())
        .unwrap()
        .next()
        .unwrap()
        .unwrap();
    let exported = fs::read_to_string(child.path().join("snapshot.json")).unwrap();
    for secret in [
        "PRIVATE_FILENAME",
        "PRIVATE_SOURCE",
        root.path().to_str().unwrap(),
    ] {
        assert!(!exported.contains(secret));
    }
    let value: Value = serde_json::from_str(&exported).unwrap();
    assert!(value["events"]
        .as_array()
        .unwrap()
        .iter()
        .any(|event| event["runtime"] == "native"
            && event["operation"] == "native_session"
            && event["outcome"] == "success"));
    assert!(!root.path().join(".scribyra-sync").exists());
}
