use scribyra_core::reconciliation::*;
fn text(id: &str, path: &str, content: &str) -> Entry {
    Entry {
        id: Some(id.into()),
        path: path.into(),
        data: Data::Text {
            content: content.into(),
        },
    }
}
fn directory(id: &str, path: &str) -> Entry {
    Entry {
        id: Some(id.into()),
        path: path.into(),
        data: Data::Folder {},
    }
}
fn binary(id: &str, path: &str, byte: u8) -> Entry {
    Entry {
        id: Some(id.into()),
        path: path.into(),
        data: Data::Binary {
            sha256: scribyra_core::blob::hash(&[byte]),
            size: 1,
        },
    }
}
fn snapshot(entries: Vec<Entry>) -> Snapshot {
    Snapshot { entries }
}
fn request(base: Snapshot, local: Snapshot, mut disk: Snapshot) -> Request {
    for e in &mut disk.entries {
        e.id = None;
    }
    Request {
        version: 1,
        project_id: "public-project".into(),
        base,
        local,
        disk,
        resolutions: vec![],
    }
}
fn file<'a>(snapshot: &'a Snapshot, path: &str) -> &'a Entry {
    snapshot.entries.iter().find(|e| e.path == path).unwrap()
}
#[test]
fn unchanged_and_one_sided_changes_include_deletions() {
    let base = snapshot(vec![
        text("a", "main.tex", "base\n"),
        text("b", "notes.txt", "notes"),
    ]);
    let local = snapshot(vec![text("a", "main.tex", "local\n")]);
    let disk = snapshot(vec![
        text("a", "main.tex", "base\n"),
        text("b", "notes.txt", "notes"),
        text("c", "new.tex", "new"),
    ]);
    let plan = plan(&request(base, local, disk)).unwrap();
    assert!(plan.conflicts.is_empty());
    let result = plan.result.unwrap();
    assert_eq!(result.entries.len(), 2);
    assert_eq!(
        file(&result, "main.tex").data,
        Data::Text {
            content: "local\n".into()
        }
    );
    assert!(result.entries.iter().all(|e| e.id.is_some()));
}
#[test]
fn independent_text_edits_merge_without_markers() {
    let base = snapshot(vec![text("a", "main.tex", "One\nTwo\nThree\n")]);
    let local = snapshot(vec![text("a", "main.tex", "First\nTwo\nThree\n")]);
    let disk = snapshot(vec![text("a", "main.tex", "One\nTwo\nLast\n")]);
    let p = plan(&request(base, local, disk)).unwrap();
    assert!(p.conflicts.is_empty());
    assert_eq!(
        file(&p.result.unwrap(), "main.tex").data,
        Data::Text {
            content: "First\nTwo\nLast\n".into()
        }
    );
}
#[test]
fn overlapping_text_requires_explicit_resolution_and_closed_roundtrip() {
    let base = snapshot(vec![text("a", "main.tex", "base\n")]);
    let mut r = request(
        base,
        snapshot(vec![text("a", "main.tex", "left\n")]),
        snapshot(vec![text("a", "main.tex", "right\n")]),
    );
    let p = plan(&r).unwrap();
    assert!(p.result.is_none());
    assert_eq!(p.conflicts[0].kind, "text");
    r.resolutions.push(Resolution {
        id: "a".into(),
        decision: Choice::Custom {
            entry: text("a", "main.tex", "Reviewed result\n"),
        },
    });
    let json = serde_json::to_string(&r).unwrap();
    let p = parse_plan(&json).unwrap();
    assert_eq!(
        file(&p.result.unwrap(), "main.tex").data,
        Data::Text {
            content: "Reviewed result\n".into()
        }
    );
}
#[test]
fn local_parent_rename_and_external_file_edit_preserve_child_identity() {
    let base = snapshot(vec![
        directory("f", "chapters"),
        text("a", "chapters/main.tex", "base"),
    ]);
    let local = snapshot(vec![
        directory("f", "sections"),
        text("a", "sections/main.tex", "base"),
    ]);
    let disk = snapshot(vec![
        directory("f", "chapters"),
        text("a", "chapters/main.tex", "external"),
    ]);
    let p = plan(&request(base, local, disk)).unwrap();
    assert!(p.conflicts.is_empty());
    let result = p.result.unwrap();
    assert_eq!(file(&result, "sections/main.tex").id.as_deref(), Some("a"));
    assert_eq!(
        file(&result, "sections/main.tex").data,
        Data::Text {
            content: "external".into()
        }
    );
}
#[test]
fn external_parent_rename_and_local_edit_use_content_evidence() {
    let base = snapshot(vec![
        directory("f", "chapters"),
        text("a", "chapters/main.tex", "base"),
    ]);
    let local = snapshot(vec![
        directory("f", "chapters"),
        text("a", "chapters/main.tex", "edited"),
    ]);
    let disk = snapshot(vec![
        directory("x", "renamed"),
        text("y", "renamed/main.tex", "base"),
    ]);
    let p = plan(&request(base, local, disk)).unwrap();
    let result = p.result.unwrap();
    assert_eq!(file(&result, "renamed/main.tex").id.as_deref(), Some("a"));
    assert!(
        p.identities
            .iter()
            .any(|e| e.id == "f" && e.after == "renamed")
    );
}
#[test]
fn new_child_follows_a_concurrently_renamed_parent() {
    let base = snapshot(vec![directory("f", "old"), text("a", "old/a.tex", "base")]);
    let local = snapshot(vec![directory("f", "new"), text("a", "new/a.tex", "base")]);
    let disk = snapshot(vec![
        directory("f", "old"),
        text("a", "old/a.tex", "base"),
        text("b", "old/added.tex", "external addition"),
    ]);
    let p = plan(&request(base, local, disk)).unwrap();
    assert!(p.conflicts.is_empty());
    assert!(
        p.result
            .unwrap()
            .entries
            .iter()
            .any(|e| e.path == "new/added.tex")
    );
}
#[test]
fn duplicate_contents_anchor_existing_paths_before_inferring_a_rename() {
    let base = snapshot(vec![text("a", "a.tex", "same"), text("b", "b.tex", "same")]);
    let p = plan(&request(
        base.clone(),
        base,
        snapshot(vec![text("z", "b.tex", "same"), text("x", "c.tex", "same")]),
    ))
    .unwrap();
    let result = p.result.unwrap();
    assert_eq!(file(&result, "b.tex").id.as_deref(), Some("b"));
    assert_eq!(file(&result, "c.tex").id.as_deref(), Some("a"));
}
#[test]
fn binary_conflict_keeps_both_under_reviewed_paths() {
    let base = snapshot(vec![binary("a", "image.png", 1)]);
    let mut r = request(
        base,
        snapshot(vec![binary("a", "image.png", 2)]),
        snapshot(vec![binary("a", "image.png", 3)]),
    );
    assert!(plan(&r).unwrap().result.is_none());
    r.resolutions.push(Resolution {
        id: "a".into(),
        decision: Choice::Both {
            local_path: "image.png".into(),
            disk_path: "image.external.png".into(),
        },
    });
    let result = plan(&r).unwrap().result.unwrap();
    assert_eq!(result.entries.len(), 2);
    assert_eq!(file(&result, "image.png").id.as_deref(), Some("a"));
    assert_ne!(file(&result, "image.external.png").id.as_deref(), Some("a"));
    assert_ne!(
        file(&result, "image.png").data,
        file(&result, "image.external.png").data
    );
}
#[test]
fn delete_edit_collision_does_not_choose_deletion_implicitly() {
    let base = snapshot(vec![text("a", "main.tex", "base")]);
    let mut r = request(
        base,
        Snapshot::default(),
        snapshot(vec![text("a", "main.tex", "changed")]),
    );
    assert!(plan(&r).unwrap().result.is_none());
    r.resolutions.push(Resolution {
        id: "a".into(),
        decision: Choice::Disk,
    });
    assert_eq!(plan(&r).unwrap().result.unwrap().entries.len(), 1);
}
#[test]
fn folder_delete_concurrent_child_addition_requires_consistent_tree_review() {
    let base = snapshot(vec![directory("f", "folder")]);
    let p = plan(&request(
        base,
        Snapshot::default(),
        snapshot(vec![
            directory("f", "folder"),
            text("a", "folder/new.tex", "new"),
        ]),
    ))
    .unwrap();
    assert!(p.result.is_none());
    assert!(p.conflicts.iter().any(|c| c.kind == "structure"));
}
#[test]
fn independent_moves_cannot_publish_a_folder_cycle() {
    let base = snapshot(vec![directory("a", "a"), directory("b", "b")]);
    let local = snapshot(vec![directory("b", "b"), directory("a", "b/a")]);
    let disk = snapshot(vec![directory("a", "a"), directory("b", "a/b")]);
    let p = plan(&request(base, local, disk)).unwrap();
    assert!(p.result.is_none());
    assert!(p.conflicts[0].message.contains("cycle"));
}
#[test]
fn unicode_case_collisions_and_missing_parents_are_rejected() {
    for entries in [
        vec![text("a", "É.tex", "a"), text("b", "E\u{301}.tex", "b")],
        vec![text("a", "missing/main.tex", "a")],
        vec![text("a", "../secret", "a")],
        vec![text("a", ".git/config", "a")],
        vec![text("a", ".scribyra-sync-state", "a")],
        vec![text("a", ".ScRiByRa-SyNc-WAL", "a")],
    ] {
        assert!(snapshot(entries).validate(true).is_err());
    }
}
#[test]
fn bounds_and_ambiguous_or_forged_identities_fail_closed() {
    let mut r = request(
        Snapshot::default(),
        snapshot(vec![text("a", "main.tex", "a")]),
        Snapshot::default(),
    );
    r.disk.entries = vec![text("forged", "main.tex", "x")];
    assert!(plan(&r).is_err());
    r.disk = Snapshot::default();
    r.resolutions = vec![Resolution {
        id: "missing".into(),
        decision: Choice::Delete,
    }];
    assert!(plan(&r).is_err());
    let bad = snapshot(vec![Entry {
        id: Some("a".into()),
        path: "image.png".into(),
        data: Data::Binary {
            sha256: "not-a-digest".into(),
            size: 1,
        },
    }]);
    assert!(bad.validate(true).is_err());
}
#[test]
fn giant_concurrent_text_has_a_manual_resolution_path() {
    let base = snapshot(vec![text("a", "main.tex", "a")]);
    let local = snapshot(vec![text(
        "a",
        "main.tex",
        &"b".repeat(MAX_MERGE_BYTES + 1),
    )]);
    let disk = snapshot(vec![text("a", "main.tex", "c")]);
    let p = plan(&request(base, local, disk)).unwrap();
    assert_eq!(p.conflicts[0].kind, "large-text");
    assert!(p.result.is_none());
}
#[test]
fn equivalent_snapshot_order_has_a_stable_digest_and_noop_plan() {
    let a = snapshot(vec![text("a", "a.tex", "a"), text("b", "b.tex", "b")]);
    let mut b = a.clone();
    b.entries.reverse();
    assert_eq!(a.digest(), b.digest());
    let p = plan(&request(a.clone(), b, a)).unwrap();
    assert!(p.conflicts.is_empty());
    assert_eq!(p.result.unwrap().entries.len(), 2);
}

#[test]
fn portable_folders_reject_device_names_and_windows_aliases() {
    for path in [
        "CON.tex",
        "NUL",
        "aux.bib",
        "COM1.png",
        "LPT³.tex",
        "CON .txt",
        "a.",
        "a ",
        "a?b.tex",
        "a|b.tex",
        "a\"b",
        "CONOUT$",
        "CONIN$",
    ] {
        assert!(!allowed_path(path), "{path}");
    }
    for path in [
        "conifer.tex",
        "COM10.tex",
        "lpt0",
        "Résumé/main.tex",
        ".config/tex.json",
    ] {
        assert!(allowed_path(path), "{path}");
    }
}

#[test]
fn reviewed_plan_rejects_changed_inputs_and_forged_results() {
    let base = snapshot(vec![text("a", "main.tex", "base")]);
    let r = request(
        base.clone(),
        snapshot(vec![text("a", "main.tex", "local")]),
        base,
    );
    let review = plan(&r).unwrap();
    assert_eq!(
        verify_review(&review, &r).unwrap(),
        review.result.clone().unwrap()
    );
    for side in ["disk", "local", "base", "project", "decisions"] {
        let mut changed = r.clone();
        match side {
            "disk" => {
                changed.disk.entries[0].data = Data::Text {
                    content: "changed".into(),
                }
            }
            "local" => {
                changed.local.entries[0].data = Data::Text {
                    content: "changed".into(),
                }
            }
            "base" => {
                changed.base.entries[0].data = Data::Text {
                    content: "changed".into(),
                }
            }
            "project" => changed.project_id = "other".into(),
            _ => changed.resolutions.push(Resolution {
                id: "a".into(),
                decision: Choice::Local,
            }),
        }
        assert!(verify_review(&review, &changed).is_err(), "{side}");
    }
    let mut forged = review.clone();
    forged.result.as_mut().unwrap().entries[0].data = Data::Text {
        content: "injected".into(),
    };
    assert!(verify_review(&forged, &r).is_err());
    let mut unresolved = r.clone();
    unresolved.disk.entries[0].data = Data::Text {
        content: "disk".into(),
    };
    let unresolved_review = plan(&unresolved).unwrap();
    assert!(
        verify_review(&unresolved_review, &unresolved)
            .unwrap_err()
            .contains("Resolve every")
    );
}

#[test]
fn all_plan_fields_are_canonical_across_enumeration_order() {
    let base = snapshot(vec![
        directory("f", "chapters"),
        text("a", "chapters/main.tex", "source"),
        text("b", "other.tex", "other"),
    ]);
    let disk = snapshot(vec![
        directory("f", "renamed"),
        text("a", "renamed/main.tex", "source"),
        text("b", "other.tex", "disk"),
        text("c", "new.tex", "new"),
    ]);
    let mut r = request(base.clone(), base, disk);
    r.resolutions = vec![
        Resolution {
            id: "a".into(),
            decision: Choice::Local,
        },
        Resolution {
            id: "b".into(),
            decision: Choice::Disk,
        },
    ];
    let review = plan(&r).unwrap();
    r.base.entries.reverse();
    r.local.entries.reverse();
    r.disk.entries.reverse();
    r.resolutions.reverse();
    assert_eq!(
        serde_json::to_string(&review).unwrap(),
        serde_json::to_string(&plan(&r).unwrap()).unwrap()
    );
    assert!(verify_review(&review, &r).is_ok());
}

#[test]
fn structure_conflicts_can_be_resolved_using_real_entry_ids() {
    let base = snapshot(vec![directory("a", "a"), directory("b", "b")]);
    let mut r = request(
        base,
        snapshot(vec![directory("b", "b"), directory("a", "b/a")]),
        snapshot(vec![directory("a", "a"), directory("b", "a/b")]),
    );
    let review = plan(&r).unwrap();
    assert!(
        review
            .conflicts
            .iter()
            .any(|c| c.id == "a" && c.base.is_some())
    );
    r.resolutions.push(Resolution {
        id: "a".into(),
        decision: Choice::Base,
    });
    assert!(plan(&r).unwrap().result.is_some());
}
