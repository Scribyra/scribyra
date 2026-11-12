use scribyra_core::blob;
use scribyra_folders::transaction::{Owner, Phase, RecoveryStatus, RecoveryVersion, Session};
use scribyra_folders::{Choice, Data, Entry, Resolution, Root, Snapshot};
use std::{
    collections::BTreeMap,
    fs,
    io::{self, Seek, SeekFrom, Write},
    path::Path,
};
use tempfile::tempdir;

fn owner() -> Owner {
    Owner {
        project_id: "public-project".into(),
        scope: "https://editor.example".into(),
    }
}
fn session(path: &Path) -> Session {
    Session::connect(Root::open(path).unwrap(), owner()).unwrap()
}
fn text(id: &str, path: &str, content: &str) -> Entry {
    Entry {
        id: Some(id.into()),
        path: path.into(),
        data: Data::Text {
            content: content.into(),
        },
    }
}
fn dir(id: &str, path: &str) -> Entry {
    Entry {
        id: Some(id.into()),
        path: path.into(),
        data: Data::Folder {},
    }
}
fn binary(id: &str, path: &str, bytes: &[u8]) -> Entry {
    Entry {
        id: Some(id.into()),
        path: path.into(),
        data: Data::Binary {
            sha256: blob::hash(bytes),
            size: bytes.len(),
        },
    }
}
fn snapshot(entries: Vec<Entry>) -> Snapshot {
    Snapshot { entries }
}
fn establish(s: &mut Session) -> Snapshot {
    let review = s.preview(Snapshot::default(), vec![]).unwrap();
    let pending = s.prepare(&review, &BTreeMap::new()).unwrap();
    let receipt = s.apply(&pending.id).unwrap();
    s.confirm(&pending.id, &receipt.result.digest())
        .unwrap()
        .result
}
fn change(content: &str, base: &Snapshot) -> Snapshot {
    let mut result = base.clone();
    let entry = result
        .entries
        .iter_mut()
        .find(|e| e.path == "main.tex")
        .unwrap();
    entry.data = Data::Text {
        content: content.into(),
    };
    result
}

#[test]
fn baseline_advances_only_after_matching_browser_confirmation_and_survives_restart() {
    let folder = tempdir().unwrap();
    fs::write(folder.path().join("main.tex"), "base").unwrap();
    let mut s = session(folder.path());
    let base = establish(&mut s);
    let preview = s.preview(change("local", &base), vec![]).unwrap();
    let pending = s.prepare(&preview, &BTreeMap::new()).unwrap();
    assert_eq!(
        fs::read_to_string(folder.path().join("main.tex")).unwrap(),
        "base"
    );
    assert_eq!(s.state().unwrap().baseline, base);
    assert!(
        s.confirm(
            &pending.id,
            &preview.review.result.clone().unwrap().digest()
        )
        .is_err()
    );
    let receipt = s.apply(&pending.id).unwrap();
    assert!(!receipt.confirmed);
    assert_eq!(s.state().unwrap().baseline, base);
    drop(s);
    let mut s = session(folder.path());
    assert_eq!(
        s.state().unwrap().pending.as_ref().unwrap().phase,
        Phase::DiskApplied
    );
    assert!(s.confirm(&pending.id, &blob::hash(b"forged")).is_err());
    let receipt = s.confirm(&pending.id, &receipt.result.digest()).unwrap();
    assert!(receipt.confirmed);
    assert!(
        s.confirm(&pending.id, &receipt.result.digest())
            .unwrap()
            .confirmed
    );
    drop(s);
    let s = session(folder.path());
    assert_eq!(s.state().unwrap().baseline, receipt.result);
    assert!(s.state().unwrap().pending.is_none());
    assert_eq!(
        s.recovery(&pending.id, RecoveryVersion::Disk)
            .unwrap()
            .snapshot
            .entries[0]
            .data,
        Data::Text {
            content: "base".into()
        }
    );
    assert_eq!(
        s.recovery(&pending.id, RecoveryVersion::Result)
            .unwrap()
            .snapshot,
        receipt.result
    );
}

#[test]
fn all_apply_boundaries_resume_after_reopening_the_journal() {
    for stop in 0..if cfg!(target_os = "linux") { 12 } else { 10 } {
        let folder = tempdir().unwrap();
        fs::create_dir(folder.path().join("old")).unwrap();
        fs::write(folder.path().join("old/a.tex"), "old text").unwrap();
        fs::write(folder.path().join("main.tex"), "base").unwrap();
        let mut s = session(folder.path());
        let base = establish(&mut s);
        let fid = base
            .entries
            .iter()
            .find(|e| e.path == "old")
            .unwrap()
            .id
            .as_ref()
            .unwrap();
        let aid = base
            .entries
            .iter()
            .find(|e| e.path == "old/a.tex")
            .unwrap()
            .id
            .as_ref()
            .unwrap();
        let mid = base
            .entries
            .iter()
            .find(|e| e.path == "main.tex")
            .unwrap()
            .id
            .as_ref()
            .unwrap();
        let local = snapshot(vec![
            dir(fid, "new"),
            text(aid, "new/a.tex", "changed"),
            text(mid, "main.tex", "new main"),
            dir("empty", "new/empty"),
        ]);
        let preview = s.preview(local, vec![]).unwrap();
        let result = preview.review.result.clone().unwrap();
        let pending = s.prepare(&preview, &BTreeMap::new()).unwrap();
        let mut calls = 0;
        let outcome = s.apply_with(&pending.id, |_| {
            let fail = calls == stop;
            calls += 1;
            if fail {
                Err(io::Error::other("simulated interruption"))
            } else {
                Ok(())
            }
        });
        assert!(outcome.is_err(), "boundary {stop}: only {calls} events");
        drop(s);
        let mut s = session(folder.path());
        let receipt = s.apply(&pending.id).unwrap();
        assert_eq!(receipt.result, result);
        assert_eq!(
            fs::read_to_string(folder.path().join("new/a.tex")).unwrap(),
            "changed"
        );
        assert_eq!(
            fs::read_to_string(folder.path().join("main.tex")).unwrap(),
            "new main"
        );
        assert!(!folder.path().join("old").exists());
        assert!(folder.path().join("new/empty").is_dir());
        s.confirm(&pending.id, &result.digest()).unwrap();
        let old = s.recovery(&pending.id, RecoveryVersion::Disk).unwrap();
        assert!(old.snapshot.entries.iter().any(|e| e.path == "old/a.tex"
            && e.data
                == Data::Text {
                    content: "old text".into()
                }));
    }
}

#[test]
fn an_external_writer_open_before_claim_is_preserved_and_visible_in_recovery() {
    let folder = tempdir().unwrap();
    let path = folder.path().join("main.tex");
    fs::write(&path, "base").unwrap();
    let mut s = session(folder.path());
    let base = establish(&mut s);
    let preview = s.preview(change("local", &base), vec![]).unwrap();
    let pending = s.prepare(&preview, &BTreeMap::new()).unwrap();
    let mut held = fs::OpenOptions::new().write(true).open(&path).unwrap();
    let result = s.apply_with(&pending.id, |event| {
        if event.operation == "file-claimed" {
            held.seek(SeekFrom::Start(0))?;
            held.write_all(b"late")?;
            held.sync_all()?;
        }
        Ok(())
    });
    assert!(result.unwrap_err().to_string().contains("racing edit"));
    assert_eq!(s.retained_object(&blob::hash(b"base"), 4).unwrap(), b"base");
    assert_eq!(
        s.retained_object(&blob::hash(b"local"), 5).unwrap(),
        b"local"
    );
    let recovery = s.recovery(&pending.id, RecoveryVersion::Claimed).unwrap();
    assert_eq!(
        recovery.snapshot.entries[0].data,
        Data::Text {
            content: "late".into()
        }
    );
    drop(s);
    let mut s = session(folder.path());
    assert!(s.apply(&pending.id).is_err());
    s.abandon(&pending.id).unwrap();
    assert_eq!(
        s.recovery(&pending.id, RecoveryVersion::Claimed)
            .unwrap()
            .snapshot,
        recovery.snapshot
    );
}

#[test]
fn a_recreated_external_path_is_never_overwritten_by_publication_or_resume() {
    let folder = tempdir().unwrap();
    let path = folder.path().join("main.tex");
    fs::write(&path, "base").unwrap();
    let mut s = session(folder.path());
    let base = establish(&mut s);
    let preview = s.preview(change("local", &base), vec![]).unwrap();
    let pending = s.prepare(&preview, &BTreeMap::new()).unwrap();
    assert!(
        s.apply_with(&pending.id, |event| {
            if event.operation == "file-claimed" {
                fs::write(&path, "external save")?;
            }
            Ok(())
        })
        .is_err()
    );
    assert_eq!(fs::read_to_string(&path).unwrap(), "external save");
    drop(s);
    let mut s = session(folder.path());
    assert!(s.apply(&pending.id).is_err());
    assert_eq!(fs::read_to_string(&path).unwrap(), "external save");
}

#[test]
fn editing_a_published_file_does_not_mutate_immutable_recovery_objects() {
    let folder = tempdir().unwrap();
    let path = folder.path().join("main.tex");
    fs::write(&path, "base").unwrap();
    let mut s = session(folder.path());
    let base = establish(&mut s);
    let preview = s.preview(change("local", &base), vec![]).unwrap();
    let pending = s.prepare(&preview, &BTreeMap::new()).unwrap();
    assert!(
        s.apply_with(&pending.id, |event| {
            if event.operation == "file-published" {
                fs::write(&path, "outside")?;
                return Err(io::Error::other("stopped"));
            }
            Ok(())
        })
        .is_err()
    );
    assert_eq!(
        s.retained_object(&blob::hash(b"local"), 5).unwrap(),
        b"local"
    );
    assert_eq!(s.retained_object(&blob::hash(b"base"), 4).unwrap(), b"base");
    drop(s);
    let mut s = session(folder.path());
    assert!(s.apply(&pending.id).is_err());
    assert_eq!(fs::read_to_string(&path).unwrap(), "outside");
}

#[test]
fn binary_review_retains_original_local_and_external_versions() {
    let folder = tempdir().unwrap();
    fs::write(folder.path().join("figure.png"), [1]).unwrap();
    let mut s = session(folder.path());
    let base = establish(&mut s);
    let id = base.entries[0].id.as_ref().unwrap().clone();
    fs::write(folder.path().join("figure.png"), [3]).unwrap();
    let local = snapshot(vec![binary(&id, "figure.png", &[2])]);
    let unresolved = s.preview(local.clone(), vec![]).unwrap();
    assert!(s.prepare(&unresolved, &BTreeMap::new()).is_err());
    let preview = s
        .preview(
            local,
            vec![Resolution {
                id,
                decision: Choice::Both {
                    local_path: "figure.png".into(),
                    disk_path: "figure.external.png".into(),
                },
            }],
        )
        .unwrap();
    assert!(s.prepare(&preview, &BTreeMap::new()).is_err());
    assert_eq!(fs::read(folder.path().join("figure.png")).unwrap(), [3]);
    let attachments = BTreeMap::from([(blob::hash(&[2]), vec![2])]);
    let pending = s.prepare(&preview, &attachments).unwrap();
    let receipt = s.apply(&pending.id).unwrap();
    s.confirm(&pending.id, &receipt.result.digest()).unwrap();
    assert_eq!(fs::read(folder.path().join("figure.png")).unwrap(), [2]);
    assert_eq!(
        fs::read(folder.path().join("figure.external.png")).unwrap(),
        [3]
    );
    for b in [1, 2, 3] {
        assert_eq!(s.retained_object(&blob::hash(&[b]), 1).unwrap(), [b]);
    }
}

#[test]
fn stale_disk_baseline_project_and_forged_reviews_do_not_change_project_files() {
    let folder = tempdir().unwrap();
    let path = folder.path().join("main.tex");
    fs::write(&path, "base").unwrap();
    let mut s = session(folder.path());
    let base = establish(&mut s);
    let preview = s.preview(change("local", &base), vec![]).unwrap();
    fs::write(&path, "external").unwrap();
    assert!(s.prepare(&preview, &BTreeMap::new()).is_err());
    fs::write(&path, "base").unwrap();
    for field in ["project", "baseline", "result", "disk-id"] {
        let mut p = preview.clone();
        match field {
            "project" => p.request.project_id = "other".into(),
            "baseline" => p.request.base.entries.clear(),
            "disk-id" => p.request.disk.entries[0].id = Some("forged".into()),
            _ => {
                p.review.result.as_mut().unwrap().entries[0].data = Data::Text {
                    content: "forged".into(),
                }
            }
        }
        assert!(s.prepare(&p, &BTreeMap::new()).is_err(), "{field}");
    }
    assert_eq!(fs::read_to_string(&path).unwrap(), "base");
    assert!(s.state().unwrap().pending.is_none());
}

#[test]
fn exclusive_session_scope_and_missing_bindings_are_enforced() {
    let folder = tempdir().unwrap();
    assert!(Session::open(Root::open(folder.path()).unwrap(), owner()).is_err());
    assert!(!folder.path().join(".scribyra-sync").exists());
    let s = session(folder.path());
    assert!(Session::connect(Root::open(folder.path()).unwrap(), owner()).is_err());
    drop(s);
    let wrong = Owner {
        project_id: "different".into(),
        ..owner()
    };
    assert!(Session::connect(Root::open(folder.path()).unwrap(), wrong).is_err());
    let wrong = Owner {
        scope: "https://unrelated.example".into(),
        ..owner()
    };
    assert!(Session::connect(Root::open(folder.path()).unwrap(), wrong).is_err());
    assert!(
        session(folder.path())
            .state()
            .unwrap()
            .baseline
            .entries
            .is_empty()
    );
}

#[test]
fn file_directory_type_replacements_and_deletions_are_recoverable() {
    let folder = tempdir().unwrap();
    fs::write(folder.path().join("old.tex"), "old").unwrap();
    fs::create_dir(folder.path().join("old-folder")).unwrap();
    fs::write(folder.path().join("old-folder/child.tex"), "child").unwrap();
    let mut s = session(folder.path());
    let base = establish(&mut s);
    let local = snapshot(vec![
        dir("newdir", "old.tex"),
        text("newchild", "old.tex/new.tex", "new"),
        text("newfile", "old-folder", "replacement"),
    ]);
    let preview = s.preview(local, vec![]).unwrap();
    assert!(
        preview.review.conflicts.is_empty(),
        "{:?}",
        preview.review.conflicts
    );
    let pending = s.prepare(&preview, &BTreeMap::new()).unwrap();
    let receipt = s.apply(&pending.id).unwrap();
    s.confirm(&pending.id, &receipt.result.digest()).unwrap();
    assert_eq!(
        fs::read_to_string(folder.path().join("old.tex/new.tex")).unwrap(),
        "new"
    );
    assert_eq!(
        fs::read_to_string(folder.path().join("old-folder")).unwrap(),
        "replacement"
    );
    assert_eq!(
        s.recovery(&pending.id, RecoveryVersion::Disk)
            .unwrap()
            .snapshot
            .entries
            .len(),
        base.entries.len()
    );
}

#[test]
fn an_ignored_git_tree_is_not_recursively_deleted_with_its_parent() {
    let folder = tempdir().unwrap();
    fs::create_dir_all(folder.path().join("chapter/.git")).unwrap();
    fs::write(folder.path().join("chapter/.git/config"), "retained git").unwrap();
    fs::write(folder.path().join("chapter/main.tex"), "base").unwrap();
    let mut s = session(folder.path());
    establish(&mut s);
    let preview = s.preview(Snapshot::default(), vec![]).unwrap();
    let pending = s.prepare(&preview, &BTreeMap::new()).unwrap();
    assert!(s.apply(&pending.id).is_err());
    assert_eq!(
        fs::read_to_string(folder.path().join("chapter/.git/config")).unwrap(),
        "retained git"
    );
    assert!(
        s.recovery(&pending.id, RecoveryVersion::Disk)
            .unwrap()
            .snapshot
            .entries
            .iter()
            .any(|e| e.path == "chapter/main.tex")
    );
}

#[test]
fn confirmations_refuse_later_external_changes_and_abandon_keeps_copies() {
    let folder = tempdir().unwrap();
    let path = folder.path().join("main.tex");
    fs::write(&path, "base").unwrap();
    let mut s = session(folder.path());
    let base = establish(&mut s);
    let preview = s.preview(change("local", &base), vec![]).unwrap();
    let pending = s.prepare(&preview, &BTreeMap::new()).unwrap();
    let receipt = s.apply(&pending.id).unwrap();
    fs::write(&path, "outside").unwrap();
    assert!(s.confirm(&pending.id, &receipt.result.digest()).is_err());
    assert_eq!(s.state().unwrap().baseline, base);
    s.abandon(&pending.id).unwrap();
    assert_eq!(fs::read_to_string(&path).unwrap(), "outside");
    assert_eq!(
        s.recovery(&pending.id, RecoveryVersion::Local)
            .unwrap()
            .snapshot,
        preview.request.local
    );
}

#[cfg(unix)]
#[test]
fn symlink_control_and_new_destination_parents_are_not_followed() {
    use std::os::unix::fs::symlink;
    let folder = tempdir().unwrap();
    let outside = tempdir().unwrap();
    symlink(outside.path(), folder.path().join(".scribyra-sync")).unwrap();
    assert!(Session::connect(Root::open(folder.path()).unwrap(), owner()).is_err());
    assert_eq!(fs::read_dir(outside.path()).unwrap().count(), 0);
    fs::remove_file(folder.path().join(".scribyra-sync")).unwrap();
    let mut s = session(folder.path());
    let local = snapshot(vec![dir("d", "new"), text("a", "new/main.tex", "source")]);
    let preview = s.preview(local, vec![]).unwrap();
    let pending = s.prepare(&preview, &BTreeMap::new()).unwrap();
    symlink(outside.path(), folder.path().join("new")).unwrap();
    assert!(s.apply(&pending.id).is_err());
    assert!(!outside.path().join("main.tex").exists());
}

#[test]
fn type_hints_follow_the_agreed_version_until_a_type_change_is_confirmed() {
    let folder = tempdir().unwrap();
    fs::write(folder.path().join("raw.tex"), [255, 0]).unwrap();
    let mut s = session(folder.path());
    let local = snapshot(vec![binary("raw", "raw.tex", &[255, 0])]);
    let preview = s.preview(local, vec![]).unwrap();
    let p = s.prepare(&preview, &BTreeMap::new()).unwrap();
    let receipt = s.apply(&p.id).unwrap();
    s.confirm(&p.id, &receipt.result.digest()).unwrap();
    let local = snapshot(vec![binary("raw", "renamed.bin", &[255, 0])]);
    let preview = s.preview(local, vec![]).unwrap();
    assert!(preview.review.conflicts.is_empty());
    assert!(matches!(
        preview.request.disk.entries[0].data,
        Data::Binary { .. }
    ));
    let p = s.prepare(&preview, &BTreeMap::new()).unwrap();
    let receipt = s.apply(&p.id).unwrap();
    s.confirm(&p.id, &receipt.result.digest()).unwrap();
    assert_eq!(
        fs::read(folder.path().join("renamed.bin")).unwrap(),
        [255, 0]
    );
}

#[test]
fn uncertain_metadata_acknowledgement_requires_reopening_without_touching_source() {
    let folder = tempdir().unwrap();
    let path = folder.path().join("main.tex");
    fs::write(&path, "base").unwrap();
    let mut s = session(folder.path());
    let base = establish(&mut s);
    let preview = s.preview(change("local", &base), vec![]).unwrap();
    let control = folder.path().join(".scribyra-sync");
    fs::rename(control.join("session.json"), control.join("saved.json")).unwrap();
    fs::create_dir(control.join("session.json")).unwrap();
    assert!(s.prepare(&preview, &BTreeMap::new()).is_err());
    assert!(s.state().is_err());
    assert!(
        s.preview(base.clone(), vec![])
            .unwrap_err()
            .to_string()
            .contains("reopen")
    );
    assert_eq!(fs::read_to_string(&path).unwrap(), "base");
    fs::remove_dir(control.join("session.json")).unwrap();
    fs::rename(control.join("saved.json"), control.join("session.json")).unwrap();
    drop(s);
    let s = session(folder.path());
    assert_eq!(s.state().unwrap().baseline, base);
    assert!(
        s.recoveries()
            .unwrap()
            .iter()
            .any(|s| s.status == RecoveryStatus::Prepared)
    );
}

#[test]
fn late_open_handle_changes_prevent_confirmation_and_remain_exportable() {
    let folder = tempdir().unwrap();
    let path = folder.path().join("main.tex");
    fs::write(&path, "base").unwrap();
    let mut s = session(folder.path());
    let base = establish(&mut s);
    let preview = s.preview(change("local", &base), vec![]).unwrap();
    let p = s.prepare(&preview, &BTreeMap::new()).unwrap();
    let mut held = fs::OpenOptions::new().write(true).open(&path).unwrap();
    let receipt = s.apply(&p.id).unwrap();
    held.write_all(b"late").unwrap();
    held.sync_all().unwrap();
    assert!(
        s.confirm(&p.id, &receipt.result.digest())
            .unwrap_err()
            .to_string()
            .contains("late external edit")
    );
    assert_eq!(
        s.recovery(&p.id, RecoveryVersion::Claimed)
            .unwrap()
            .snapshot
            .entries[0]
            .data,
        Data::Text {
            content: "late".into()
        }
    );
    assert_eq!(
        s.recoveries()
            .unwrap()
            .iter()
            .find(|r| r.id == p.id)
            .unwrap()
            .status,
        RecoveryStatus::DiskApplied
    );
}

#[test]
#[ignore = "subprocess fixture invoked by the crash-recovery test"]
fn subprocess_crash_worker() {
    let Some(root) = std::env::var_os("SCRIBYRA_FOLDER_CRASH_ROOT") else {
        return;
    };
    let id = std::env::var("SCRIBYRA_FOLDER_CRASH_ID").unwrap();
    let stop: usize = std::env::var("SCRIBYRA_FOLDER_CRASH_STEP")
        .unwrap()
        .parse()
        .unwrap();
    let mut s = session(Path::new(&root));
    let mut calls = 0;
    s.apply_with(&id, |_| {
        let current = calls;
        calls += 1;
        if current == stop {
            std::process::exit(73);
        }
        Ok(())
    })
    .unwrap();
    panic!("Crash boundary was not reached");
}

#[test]
fn actual_process_exit_releases_lock_and_resumes_every_filesystem_boundary() {
    for stop in 0..if cfg!(target_os = "linux") { 12 } else { 10 } {
        let folder = tempdir().unwrap();
        fs::create_dir(folder.path().join("old")).unwrap();
        fs::write(folder.path().join("old/a.tex"), "old text").unwrap();
        fs::write(folder.path().join("main.tex"), "base").unwrap();
        let mut s = session(folder.path());
        let base = establish(&mut s);
        let fid = base
            .entries
            .iter()
            .find(|e| e.path == "old")
            .unwrap()
            .id
            .as_ref()
            .unwrap();
        let aid = base
            .entries
            .iter()
            .find(|e| e.path == "old/a.tex")
            .unwrap()
            .id
            .as_ref()
            .unwrap();
        let mid = base
            .entries
            .iter()
            .find(|e| e.path == "main.tex")
            .unwrap()
            .id
            .as_ref()
            .unwrap();
        let local = snapshot(vec![
            dir(fid, "new"),
            text(aid, "new/a.tex", "changed"),
            text(mid, "main.tex", "new main"),
            dir("empty", "new/empty"),
        ]);
        let preview = s.preview(local, vec![]).unwrap();
        let p = s.prepare(&preview, &BTreeMap::new()).unwrap();
        drop(s);
        let output = std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "subprocess_crash_worker",
                "--nocapture",
                "--ignored",
            ])
            .env("SCRIBYRA_FOLDER_CRASH_ROOT", folder.path())
            .env("SCRIBYRA_FOLDER_CRASH_ID", &p.id)
            .env("SCRIBYRA_FOLDER_CRASH_STEP", stop.to_string())
            .output()
            .unwrap();
        assert_eq!(
            output.status.code(),
            Some(73),
            "stop {stop}: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        let mut s = session(folder.path());
        let receipt = s.apply(&p.id).unwrap();
        s.confirm(&p.id, &receipt.result.digest()).unwrap();
        assert_eq!(
            fs::read_to_string(folder.path().join("new/a.tex")).unwrap(),
            "changed"
        );
        assert_eq!(
            fs::read_to_string(folder.path().join("main.tex")).unwrap(),
            "new main"
        );
        assert_eq!(s.recoveries().unwrap().len(), 2);
    }
}

#[cfg(target_os = "linux")]
#[test]
fn atomic_replacements_remain_complete_and_present_to_a_concurrent_reader() {
    use std::sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    };
    let folder = tempdir().unwrap();
    let path = folder.path().join("main.tex");
    fs::write(&path, "A".repeat(8192)).unwrap();
    let mut s = session(folder.path());
    let mut base = establish(&mut s);
    let stop = Arc::new(AtomicBool::new(false));
    let thread_stop = stop.clone();
    let reader = std::thread::spawn(move || {
        let mut count = 0;
        while !thread_stop.load(Ordering::Acquire) {
            let bytes = fs::read(&path).expect("Atomic replacement must not leave a missing path");
            assert_eq!(bytes.len(), 8192);
            assert!(bytes.iter().all(|b| *b == bytes[0]));
            count += 1;
        }
        count
    });
    let result = (|| -> io::Result<()> {
        for n in 1..20 {
            let content = String::from_utf8(vec![b'A' + n; 8192]).unwrap();
            let p = s.preview(change(&content, &base), vec![])?;
            let tx = s.prepare(&p, &BTreeMap::new())?;
            let receipt = s.apply(&tx.id)?;
            base = s.confirm(&tx.id, &receipt.result.digest())?.result;
        }
        Ok(())
    })();
    stop.store(true, Ordering::Release);
    assert!(reader.join().unwrap() > 0);
    result.unwrap();
}

#[cfg(target_os = "linux")]
#[test]
fn a_late_edit_after_exchange_is_exportable_before_and_after_restart() {
    let folder = tempdir().unwrap();
    let path = folder.path().join("main.tex");
    fs::write(&path, "base").unwrap();
    let mut s = session(folder.path());
    let base = establish(&mut s);
    let preview = s.preview(change("local", &base), vec![]).unwrap();
    let p = s.prepare(&preview, &BTreeMap::new()).unwrap();
    let mut held = fs::OpenOptions::new().write(true).open(&path).unwrap();
    assert!(
        s.apply_with(&p.id, |event| {
            if event.operation == "file-exchanged" {
                held.write_all(b"late")?;
                held.sync_all()?;
                return Err(io::Error::other("interrupted after exchange"));
            }
            Ok(())
        })
        .is_err()
    );
    let recovery = s.recovery(&p.id, RecoveryVersion::Claimed).unwrap();
    assert_eq!(
        recovery.snapshot.entries[0].data,
        Data::Text {
            content: "late".into()
        }
    );
    drop(s);
    let mut s = session(folder.path());
    assert!(s.apply(&p.id).is_err());
    assert_eq!(
        s.recovery(&p.id, RecoveryVersion::Claimed)
            .unwrap()
            .snapshot,
        recovery.snapshot
    );
    assert_eq!(fs::read_to_string(&path).unwrap(), "local");
    assert_eq!(s.retained_object(&blob::hash(b"base"), 4).unwrap(), b"base");
}

#[cfg(target_os = "linux")]
#[test]
fn an_atomic_external_save_between_precheck_and_exchange_is_retained() {
    let folder = tempdir().unwrap();
    let path = folder.path().join("main.tex");
    fs::write(&path, "base").unwrap();
    let mut s = session(folder.path());
    let base = establish(&mut s);
    let preview = s.preview(change("local", &base), vec![]).unwrap();
    let pending = s.prepare(&preview, &BTreeMap::new()).unwrap();
    let result = s.apply_with(&pending.id, |event| {
        if event.operation == "file-before-exchange" {
            let temporary = folder.path().join(".editor-save.tex");
            fs::write(&temporary, "late atomic save")?;
            fs::rename(temporary, &path)?;
        }
        Ok(())
    });
    assert!(result.unwrap_err().to_string().contains("racing edit"));
    assert_eq!(
        s.recovery(&pending.id, RecoveryVersion::Claimed)
            .unwrap()
            .snapshot
            .entries[0]
            .data,
        Data::Text {
            content: "late atomic save".into()
        }
    );
    assert_eq!(fs::read_to_string(&path).unwrap(), "local");
    assert_eq!(
        s.state().unwrap().pending.as_ref().unwrap().phase,
        Phase::Prepared
    );
    assert_eq!(s.state().unwrap().baseline, base);
}
