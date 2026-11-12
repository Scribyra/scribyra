use scribyra_folders::{Data, Entry, MAX_BYTES, Root, Snapshot};
use std::{fs, process::Command};
use tempfile::tempdir;

#[test]
fn reads_nested_unicode_empty_directories_binary_and_exact_text_bytes() {
    let dir = tempdir().unwrap();
    fs::create_dir_all(dir.path().join("chapters/été/empty")).unwrap();
    let source = "\u{feff}First\r\nΔεύτερο\r\n";
    fs::write(dir.path().join("chapters/été/main.tex"), source).unwrap();
    let image = [0, 255, 128, 1];
    fs::write(dir.path().join("image.png"), image).unwrap();
    let root = Root::open(dir.path()).unwrap();
    let first = root.scan(None).unwrap();
    assert_eq!(first.snapshot.entries.len(), 5);
    assert!(first.snapshot.entries.iter().all(|e| e.id.is_none()));
    assert!(
        first
            .snapshot
            .entries
            .iter()
            .any(|e| e.path == "chapters/été/empty" && matches!(e.data, Data::Folder {}))
    );
    assert!(first.snapshot.entries.iter().any(|e| e.data
        == Data::Text {
            content: source.into()
        }));
    let hash = scribyra_core::blob::hash(&image);
    assert_eq!(first.objects[&hash], image);
    assert!(root.verify(&first.revision(), None).is_ok());
    assert_eq!(
        fs::read(dir.path().join("chapters/été/main.tex")).unwrap(),
        source.as_bytes()
    );
    assert_eq!(fs::read(dir.path().join("image.png")).unwrap(), image);
}

#[test]
fn stale_same_size_file_and_directory_renames_are_detected() {
    let dir = tempdir().unwrap();
    fs::create_dir(dir.path().join("chapter")).unwrap();
    fs::write(dir.path().join("chapter/main.tex"), "before").unwrap();
    let root = Root::open(dir.path()).unwrap();
    let revision = root.scan(None).unwrap().revision();
    fs::write(dir.path().join("chapter/main.tex"), "after!").unwrap();
    assert!(
        root.verify(&revision, None)
            .unwrap_err()
            .to_string()
            .contains("changed after review")
    );
    let revision = root.scan(None).unwrap().revision();
    fs::rename(dir.path().join("chapter"), dir.path().join("renamed")).unwrap();
    assert!(root.verify(&revision, None).is_err());
    assert!(root.verify("forged", None).is_err());
}

#[test]
fn known_binary_type_overrides_filename_without_changing_bytes() {
    let dir = tempdir().unwrap();
    let bytes = [255, 0, 128];
    fs::write(dir.path().join("raw.tex"), bytes).unwrap();
    let root = Root::open(dir.path()).unwrap();
    assert!(
        root.scan(None)
            .unwrap_err()
            .to_string()
            .contains("not UTF-8")
    );
    let known = Snapshot {
        entries: vec![Entry {
            id: Some("raw".into()),
            path: "raw.tex".into(),
            data: Data::Binary {
                sha256: scribyra_core::blob::hash(&bytes),
                size: bytes.len(),
            },
        }],
    };
    let scan = root.scan(Some(&known)).unwrap();
    assert!(matches!(scan.snapshot.entries[0].data, Data::Binary { .. }));
    assert_eq!(fs::read(dir.path().join("raw.tex")).unwrap(), bytes);
}

#[test]
fn git_and_private_sync_control_trees_are_excluded() {
    let dir = tempdir().unwrap();
    for name in [".git", ".ScRiByRa-SyNc", ".scribyra-sync-private"] {
        fs::create_dir(dir.path().join(name)).unwrap();
        fs::write(dir.path().join(name).join("secrets"), [255]).unwrap();
    }
    fs::write(dir.path().join("main.tex"), "source").unwrap();
    let scan = Root::open(dir.path()).unwrap().scan(None).unwrap();
    assert_eq!(scan.snapshot.entries.len(), 1);
    assert_eq!(scan.snapshot.entries[0].path, "main.tex");
}

#[cfg(unix)]
#[test]
fn symlinks_and_special_files_do_not_escape_or_block_the_reader() {
    use std::os::unix::fs::symlink;
    let dir = tempdir().unwrap();
    let outside = tempdir().unwrap();
    fs::write(outside.path().join("secret.tex"), "outside source").unwrap();
    let root = Root::open(dir.path()).unwrap();
    for target in [
        outside.path().join("secret.tex"),
        outside.path().to_path_buf(),
    ] {
        symlink(target, dir.path().join("link")).unwrap();
        assert!(
            root.scan(None)
                .unwrap_err()
                .to_string()
                .contains("Symlinks")
        );
        fs::remove_file(dir.path().join("link")).unwrap();
    }
    rustix::fs::mkfifoat(
        rustix::fs::CWD,
        dir.path().join("pipe"),
        rustix::fs::Mode::RUSR | rustix::fs::Mode::WUSR,
    )
    .unwrap();
    assert!(
        root.scan(None)
            .unwrap_err()
            .to_string()
            .contains("Non-regular")
    );
    assert_eq!(
        fs::read_to_string(outside.path().join("secret.tex")).unwrap(),
        "outside source"
    );
}

#[cfg(unix)]
#[test]
fn open_root_capability_survives_a_root_rename() {
    let parent = tempdir().unwrap();
    fs::create_dir(parent.path().join("original")).unwrap();
    fs::write(parent.path().join("original/main.tex"), "first").unwrap();
    let root = Root::open(parent.path().join("original")).unwrap();
    fs::rename(parent.path().join("original"), parent.path().join("moved")).unwrap();
    fs::create_dir(parent.path().join("original")).unwrap();
    fs::write(parent.path().join("original/main.tex"), "unrelated").unwrap();
    assert_eq!(
        root.scan(None).unwrap().snapshot.entries[0].data,
        Data::Text {
            content: "first".into()
        }
    );
}

#[cfg(unix)]
#[test]
fn inspection_refuses_nonportable_names_and_case_collisions() {
    for names in [
        vec!["CON.tex"],
        vec!["main."],
        vec!["A.tex", "a.tex"],
        vec!["É.tex", "E\u{301}.tex"],
    ] {
        let dir = tempdir().unwrap();
        for name in names {
            fs::write(dir.path().join(name), "text").unwrap();
        }
        assert!(Root::open(dir.path()).unwrap().scan(None).is_err());
    }
}

#[test]
fn size_file_and_enumeration_bounds_fail_before_unbounded_reads() {
    let dir = tempdir().unwrap();
    let large = fs::File::create(dir.path().join("large.bin")).unwrap();
    large.set_len(MAX_BYTES as u64 + 1).unwrap();
    assert!(
        Root::open(dir.path())
            .unwrap()
            .scan(None)
            .unwrap_err()
            .to_string()
            .contains("64 MiB")
    );
    fs::remove_file(dir.path().join("large.bin")).unwrap();
    for i in 0..513 {
        fs::write(dir.path().join(format!("file{i}.tex")), "").unwrap();
    }
    assert!(
        Root::open(dir.path())
            .unwrap()
            .scan(None)
            .unwrap_err()
            .to_string()
            .contains("512 files")
    );
    for i in 513..1025 {
        fs::write(dir.path().join(format!("file{i}.tex")), "").unwrap();
    }
    assert!(
        Root::open(dir.path())
            .unwrap()
            .scan(None)
            .unwrap_err()
            .to_string()
            .contains("1,024 entries")
    );
}

#[test]
fn cli_inspection_exposes_metadata_and_explicit_snapshot_exposes_source() {
    let dir = tempdir().unwrap();
    fs::write(dir.path().join("main.tex"), "PRIVATE_TEST_SOURCE").unwrap();
    let inspect = Command::new(env!("CARGO_BIN_EXE_scribyra-folders"))
        .arg("inspect")
        .arg(dir.path())
        .output()
        .unwrap();
    assert!(inspect.status.success());
    let output = String::from_utf8(inspect.stdout).unwrap();
    assert!(!output.contains("PRIVATE_TEST_SOURCE"));
    let json: serde_json::Value = serde_json::from_str(&output).unwrap();
    let verify = Command::new(env!("CARGO_BIN_EXE_scribyra-folders"))
        .arg("verify")
        .arg(dir.path())
        .arg(json["revision"].as_str().unwrap())
        .output()
        .unwrap();
    assert!(verify.status.success());
    let snapshot = Command::new(env!("CARGO_BIN_EXE_scribyra-folders"))
        .arg("snapshot")
        .arg(dir.path())
        .output()
        .unwrap();
    assert!(snapshot.status.success());
    assert!(
        String::from_utf8(snapshot.stdout)
            .unwrap()
            .contains("PRIVATE_TEST_SOURCE")
    );
    assert_eq!(
        fs::read_to_string(dir.path().join("main.tex")).unwrap(),
        "PRIVATE_TEST_SOURCE"
    );
    assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 1);
}
