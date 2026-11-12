//! Portable history plans. Storage and CRDT application remain browser adapters.
use crate::{
    collaboration_commands::{Error, error},
    collaboration_schema::{self as schema, CheckpointManifest, ObjectRef, SemanticState},
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::{BTreeMap, BTreeSet};

pub fn validate(state: &SemanticState) -> Result<(), String> {
    let mut pending: Vec<_> = state
        .get("discussionEvents")
        .into_iter()
        .flat_map(|events| events.values())
        .map(|event| (event, 0))
        .collect();
    let mut identities = std::borrow::Cow::Borrowed(state);
    let mut count = 0;
    while let Some((event, depth)) = pending.pop() {
        count += 1;
        if depth > 64 || count > schema::RECORDS {
            return Err("Restore validation exceeds its bound.".into());
        }
        if event["kind"] != "restoreProjection" || event["payload"]["evidence"] == true {
            continue;
        }
        let payload = &event["payload"];
        // Copy provenance targets the change itself, never a discussion record.
        if payload["mode"] == "copy"
            && payload.get("root").is_none()
            && payload.get("projection").is_none()
            && event["targetId"] == event["changeId"]
            && state.get("changes").is_some_and(|records| {
                records.contains_key(event["targetId"].as_str().unwrap_or(""))
            })
        {
            continue;
        }
        let root = payload["root"].as_str().ok_or("Missing restore root.")?;
        if !["threads", "messages", "suggestions", "reviews", "anchors"].contains(&root) {
            return Err("Invalid restore root.".into());
        }
        let target = event["targetId"]
            .as_str()
            .ok_or("Missing restore target.")?;
        if schema::ROOTS.iter().any(|other| {
            *other != root
                && identities
                    .get(*other)
                    .is_some_and(|records| records.contains_key(target))
        }) {
            return Err("Restore projection targets the wrong record type.".into());
        }
        let record = payload
            .get("projection")
            .ok_or("Missing restore projection.")?;
        if !record.is_null() {
            if record["id"] != event["targetId"] {
                return Err("Restore projection identity mismatch.".into());
            }
            let id = target;
            let original = identities.get(root).and_then(|records| records.get(id));
            // Raw records were already validated; repeated checkpoints commonly
            // select the exact same immutable record hundreds of times.
            if original != Some(record) {
                schema::validate_record(root, record)?;
                if root == "anchors" {
                    crate::comments::validate_anchor(
                        &serde_json::from_value(record.clone())
                            .map_err(|_| "Invalid restored anchor.")?,
                    )?;
                }
            }
            if let Some(original) = original {
                let fields: &[&str] = match root {
                    "threads" => &["suggestionId", "anchorId", "reviewId", "firstMessageId"],
                    "messages" => &["threadId", "replyToId"],
                    "suggestions" => &["supersedesId", "anchorId", "reviewId"],
                    _ => &[],
                };
                if fields
                    .iter()
                    .any(|field| original[*field] != record[*field])
                {
                    return Err("Restore projection changes an immutable discussion target.".into());
                }
            } else {
                identities
                    .to_mut()
                    .entry(root.into())
                    .or_default()
                    .insert(id.into(), record.clone());
            }
        }
        if let Some(events) = payload.get("events") {
            for nested in events.as_array().ok_or("Invalid legacy restore events.")? {
                schema::validate_record("discussionEvents", nested)?;
                if nested["targetId"] != event["targetId"] {
                    return Err("Foreign legacy restore event.".into());
                }
                pending.push((nested, depth + 1));
            }
        }
    }
    crate::comments::validate_thread_targets(&identities)?;
    crate::reviews::validate_supersession(&identities)?;
    if let Some(versions) = state.get("versions") {
        for record in versions.values() {
            if !record["checkpointRef"]
                .as_str()
                .is_some_and(crate::blob::valid_hash)
            {
                return Err("Invalid named checkpoint reference.".into());
            }
        }
    }
    Ok(())
}
pub fn manifest(encoded: &str) -> Result<CheckpointManifest, String> {
    if encoded.len() > schema::CHUNK_BYTES {
        return Err("Checkpoint manifest exceeds object bound.".into());
    }
    let m: CheckpointManifest = serde_json::from_str(encoded).map_err(|e| e.to_string())?;
    if m.version != 1
        || m.schema_version == 0
        || m.schema_version > schema::PROJECT_VERSION
        || !schema::uuid(&m.checkpoint_id)
        || !schema::uuid(&m.lineage_id)
        || m.change_ids
            .iter()
            .chain(m.parents.iter())
            .any(|id| !schema::uuid(id))
        || m.update_chunks.is_empty()
        || m.update_chunks.len() > schema::BACKUP_BYTES / schema::CHUNK_BYTES
        || m.assets.len() > 1024
    {
        return Err("Unsupported or invalid checkpoint manifest.".into());
    }
    for r in &m.update_chunks {
        object_ref(r, schema::CHUNK_BYTES)?;
    }
    let mut assets = BTreeSet::new();
    for r in &m.assets {
        object_ref(r, 64 * 1024 * 1024)?;
        if !assets.insert(&r.hash) {
            return Err("Duplicate checkpoint asset.".into());
        }
    }
    Ok(m)
}
fn object_ref(r: &ObjectRef, max: usize) -> Result<(), String> {
    if !crate::blob::valid_hash(&r.hash) || r.size > max {
        return Err("Invalid object hash or size.".into());
    }
    Ok(())
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BackupEntry {
    pub path: String,
    pub hash: String,
    pub size: usize,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BackupManifest {
    pub format: u32,
    pub schema_version: u32,
    pub lineage_id: String,
    pub created_at: u64,
    pub entries: Vec<BackupEntry>,
}
pub fn backup_manifest(encoded: &str) -> Result<BackupManifest, String> {
    if encoded.len() > 32 * 1024 * 1024 {
        return Err("Backup manifest exceeds bound.".into());
    }
    let m: BackupManifest = serde_json::from_str(encoded).map_err(|e| e.to_string())?;
    // Every earlier format stays importable; newer ones are refused.
    if !(1..=schema::BACKUP_VERSION).contains(&m.format)
        || (m.schema_version < 6 || m.schema_version > schema::PROJECT_VERSION)
        || !schema::uuid(&m.lineage_id)
        || m.entries.len() + 1 > schema::BACKUP_ENTRIES
    {
        return Err("Unsupported backup format, schema or entry count.".into());
    }
    let mut paths = BTreeSet::new();
    let mut total = encoded.len();
    for entry in &m.entries {
        let valid = entry.path == "project.update"
            || entry.path == "history.json"
            || entry
                .path
                .strip_prefix("objects/")
                .is_some_and(crate::blob::valid_hash)
            || entry
                .path
                .strip_prefix("assets/")
                .is_some_and(crate::blob::valid_hash)
            || entry
                .path
                .strip_prefix("updates/")
                .is_some_and(crate::blob::valid_hash);
        total = total
            .checked_add(entry.size)
            .ok_or("Backup size overflow.")?;
        if !valid
            || !paths.insert(&entry.path)
            || !crate::blob::valid_hash(&entry.hash)
            || total > schema::BACKUP_BYTES
        {
            return Err("Invalid backup path, duplicate or size.".into());
        }
    }
    if !paths.contains(&"project.update".to_string())
        || !paths.contains(&"history.json".to_string())
    {
        return Err("Incomplete backup.".into());
    }
    Ok(m)
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FileSnapshot {
    pub id: String,
    pub path: String,
    pub text: Option<String>,
    pub asset: Option<ObjectRef>,
    pub folder: bool,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Snapshot {
    pub files: Vec<FileSnapshot>,
    pub meta: Value,
    pub trash: Value,
    pub discussion: Value,
    pub contributors: Vec<String>,
    #[serde(default)]
    pub change_authors: BTreeMap<String, String>,
}
/// Stable file identity drives rename and content comparisons, including UTF-16 spans.
pub fn diff(before: Snapshot, after: Snapshot) -> Value {
    let old: BTreeMap<_, _> = before.files.iter().map(|f| (&f.id, f)).collect();
    let new: BTreeMap<_, _> = after.files.iter().map(|f| (&f.id, f)).collect();
    let ids: BTreeSet<_> = old.keys().chain(new.keys()).copied().collect();
    let mut changes = Vec::new();
    for id in ids {
        let a = old.get(id);
        let b = new.get(id);
        if a.is_none() || b.is_none() {
            changes.push(json!({"kind":if a.is_none(){"add"}else{"delete"},"fileId":id,"fromPath":a.map(|f|&f.path),"toPath":b.map(|f|&f.path)}));
        }
        if let (Some(a), Some(b)) = (a, b) {
            if a.path != b.path {
                changes
                    .push(json!({"kind":"rename","fileId":id,"fromPath":a.path,"toPath":b.path}));
            }
        }
        let at = a.and_then(|f| f.text.as_deref()).unwrap_or("");
        let bt = b.and_then(|f| f.text.as_deref()).unwrap_or("");
        if at != bt {
            let prefix = at
                .chars()
                .zip(bt.chars())
                .take_while(|(a, b)| a == b)
                .map(|(c, _)| c.len_utf8())
                .sum::<usize>();
            let suffix = at[prefix..]
                .chars()
                .rev()
                .zip(bt[prefix..].chars().rev())
                .take_while(|(a, b)| a == b)
                .map(|(c, _)| c.len_utf8())
                .sum::<usize>();
            let start = at[..prefix].encode_utf16().count();
            let end = at[..at.len() - suffix].encode_utf16().count();
            let replacement_end = bt[..bt.len() - suffix].encode_utf16().count();
            let patch = diffy::create_patch(at, bt).to_string();
            let truncated = patch.len() > 24 * 1024;
            changes.push(json!({"kind":"text","fileId":id,"start":start,"end":end,"replacementEnd":replacement_end,"lineDiff":if truncated {"Diff exceeds display bound."}else{&patch},"truncated":truncated}));
        }
        let aa = a.and_then(|f| f.asset.as_ref());
        let ba = b.and_then(|f| f.asset.as_ref());
        if aa.map(|r| (&r.hash, r.size)) != ba.map(|r| (&r.hash, r.size)) {
            changes.push(json!({"kind":"asset","fileId":id,"before":aa,"after":ba}));
        }
    }
    for (kind, a, b) in [
        ("settings", before.meta, after.meta),
        ("trash", before.trash, after.trash),
        ("discussion", before.discussion, after.discussion),
    ] {
        if a != b {
            changes.push(json!({"kind":kind}));
        }
    }
    let contributors: BTreeSet<_> = before
        .change_authors
        .iter()
        .chain(after.change_authors.iter())
        .filter(|(id, _)| {
            before.change_authors.contains_key(*id) != after.change_authors.contains_key(*id)
        })
        .map(|(_, author)| author.clone())
        .collect();
    json!({"changes":changes,"contributors":contributors})
}
pub fn dispatch(command: &Value) -> Result<Value, Error> {
    match command["op"].as_str() {
        Some("validateManifest") => {
            manifest(command["manifest"].as_str().unwrap_or("")).map(|_| json!({"valueVersion":1}))
        }
        Some("validateBackup") => backup_manifest(command["manifest"].as_str().unwrap_or(""))
            .map(|_| json!({"valueVersion":1})),
        Some("diff") => (|| {
            let before =
                serde_json::from_value(command["before"].clone()).map_err(|e| format!("{e}"))?;
            let after =
                serde_json::from_value(command["after"].clone()).map_err(|e| format!("{e}"))?;
            Ok(diff(before, after))
        })(),
        _ => {
            return Err(error(
                "unsupported_command",
                "History operation requires its storage adapter.",
            ));
        }
    }
    .map_err(|e| error("invalid_request", &e))
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn manifest_rejects_future_and_unknown_fields() {
        let id = schema::lineage("test");
        let mut m = json!({"version":1,"checkpointId":id,"lineageId":id,"schemaVersion":6,"createdAt":0,"changeIds":[],"updateChunks":[{"hash":"a".repeat(64),"size":1}],"assets":[],"parents":[]});
        assert!(manifest(&m.to_string()).is_ok());
        m["schemaVersion"] = json!(schema::PROJECT_VERSION + 1);
        assert!(manifest(&m.to_string()).is_err());
        m["schemaVersion"] = json!(6);
        m["token"] = json!("forbidden");
        assert!(manifest(&m.to_string()).is_err());
    }
    #[test]
    fn backup_rejects_traversal_duplicate_and_oversize() {
        let mut m = json!({"format":1,"schemaVersion":6,"lineageId":schema::lineage("test"),"createdAt":0,"entries":[{"path":"project.update","hash":"a".repeat(64),"size":1},{"path":"history.json","hash":"b".repeat(64),"size":1}]});
        assert!(backup_manifest(&m.to_string()).is_ok());
        m["entries"][0]["path"] = json!("../secret");
        assert!(backup_manifest(&m.to_string()).is_err());
        m["entries"][0]["path"] = json!("history.json");
        assert!(backup_manifest(&m.to_string()).is_err());
        m["entries"][0]["path"] = json!("project.update");
        m["entries"][0]["size"] = json!(schema::BACKUP_BYTES);
        assert!(backup_manifest(&m.to_string()).is_err());
    }
    #[test]
    fn backup_formats_up_to_this_version_import_and_newer_ones_are_refused() {
        let mut m = json!({"format":1,"schemaVersion":8,"lineageId":schema::lineage("test"),"createdAt":0,"entries":[{"path":"project.update","hash":"a".repeat(64),"size":1},{"path":"history.json","hash":"b".repeat(64),"size":1}]});
        for format in 1..=schema::BACKUP_VERSION {
            m["format"] = json!(format);
            assert!(backup_manifest(&m.to_string()).is_ok(), "format {format}");
        }
        assert_eq!(schema::BACKUP_VERSION, 2);
        for format in [0, schema::BACKUP_VERSION + 1] {
            m["format"] = json!(format);
            assert!(backup_manifest(&m.to_string()).is_err(), "format {format}");
        }
    }
    #[test]
    fn diff_uses_scalar_safe_utf16_and_stable_identity() {
        let snapshot = |text: &str, path: &str| Snapshot {
            files: vec![FileSnapshot {
                id: "f".into(),
                path: path.into(),
                text: Some(text.into()),
                asset: None,
                folder: false,
            }],
            meta: json!({}),
            trash: json!({}),
            discussion: json!({}),
            contributors: vec![],
            change_authors: BTreeMap::new(),
        };
        let d = diff(snapshot("😀old", "a.tex"), snapshot("😀new", "b.tex"));
        assert_eq!(d["changes"][0]["kind"], "rename");
        assert_eq!(d["changes"][1]["start"], 2);
        assert_eq!(d["changes"][1]["end"], 5);
    }
}

/// Validate the complete identity map and conditional rights before a restore can be staged.
pub fn restore_plan(
    before: &Snapshot,
    after: &Snapshot,
    mode: &str,
    rights: &schema::Rights,
    id_map: &BTreeMap<String, String>,
) -> Result<Value, Error> {
    use schema::Right::*;
    let required = match mode {
        "copy" => vec![Read, Export, History],
        "current" => vec![History, Edit, Comment, Review],
        _ => return Err(error("invalid_request", "Unknown restore mode.")),
    };
    if required.iter().any(|right| !rights.contains(right)) {
        return Err(error(
            "permission_denied",
            "Restore capabilities are not granted.",
        ));
    }
    let keys: BTreeSet<_> = after
        .files
        .iter()
        .map(|file| file.id.as_str())
        .chain(
            after
                .trash
                .as_object()
                .into_iter()
                .flat_map(|trash| trash.keys().map(String::as_str)),
        )
        .collect();
    let destinations: BTreeSet<_> = id_map.values().collect();
    if keys.len() != id_map.len()
        || destinations.len() != id_map.len()
        || keys.iter().any(|key| !id_map.contains_key(*key))
        || id_map.iter().any(|(from, to)| {
            from.is_empty() || from.len() > 256 || to.is_empty() || to.len() > 256
        })
    {
        return Err(error(
            "invalid_request",
            "Incomplete or colliding restore identity map.",
        ));
    }
    let kinds = |snapshot: &Snapshot| -> BTreeMap<String, (bool, bool)> {
        snapshot
            .files
            .iter()
            .map(|file| (file.id.clone(), (file.folder, file.asset.is_some())))
            .chain(snapshot.trash.as_object().into_iter().flat_map(|trash| {
                trash.iter().map(|(id, value)| {
                    (
                        id.clone(),
                        (
                            value["node"]["folder"].as_bool().unwrap_or(false),
                            value["node"]["binary"].as_bool().unwrap_or(false),
                        ),
                    )
                })
            }))
            .collect()
    };
    let before_kinds = kinds(before);
    let after_kinds = kinds(after);
    if after_kinds.len()
        != after.files.len() + after.trash.as_object().map_or(0, |trash| trash.len())
    {
        return Err(error(
            "invalid_request",
            "Duplicate file identity in restore target.",
        ));
    }
    for (id, kind) in &after_kinds {
        let destination = &id_map[id];
        let collision = before_kinds.get(id).is_some_and(|old| old != kind);
        if mode == "copy" && destination != id
            || mode == "current" && collision && (destination == id || !schema::uuid(destination))
            || mode == "current" && !collision && destination != id
        {
            return Err(error(
                "invalid_request",
                "Restore must preserve compatible file identities and remap type collisions.",
            ));
        }
    }
    Ok(
        json!({"mode":mode,"fileCount":after.files.len(),"idChanges":id_map.iter().filter(|(from,to)|from!=to).collect::<BTreeMap<_,_>>()}),
    )
}

#[cfg(test)]
mod restore_tests {
    use super::*;
    #[test]
    fn restore_rights_and_collision_maps_are_checked_together() {
        let snapshot = |binary: bool| Snapshot {
            files: vec![FileSnapshot {
                id: "file".into(),
                path: "main.tex".into(),
                folder: false,
                text: None,
                asset: binary.then(|| ObjectRef {
                    hash: "a".repeat(64),
                    size: 1,
                }),
            }],
            meta: json!({}),
            trash: json!({}),
            discussion: json!({}),
            contributors: vec![],
            change_authors: BTreeMap::new(),
        };
        let before = snapshot(true);
        let after = snapshot(false);
        let all = [
            schema::Right::History,
            schema::Right::Read,
            schema::Right::Export,
            schema::Right::Edit,
            schema::Right::Comment,
            schema::Right::Review,
        ]
        .into_iter()
        .collect();
        let same = BTreeMap::from([("file".to_string(), "file".to_string())]);
        assert!(restore_plan(&before, &after, "copy", &all, &same).is_ok());
        assert!(restore_plan(&before, &after, "current", &all, &same).is_err());
        let remapped = BTreeMap::from([("file".to_string(), schema::lineage("new-file"))]);
        assert!(restore_plan(&before, &after, "current", &all, &remapped).is_ok());
        let narrow = [schema::Right::History, schema::Right::Read]
            .into_iter()
            .collect();
        assert_eq!(
            restore_plan(&before, &after, "copy", &narrow, &same)
                .unwrap_err()
                .code,
            "permission_denied"
        );
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiscussionProjection {
    pub projection: Value,
    pub event_ids: Vec<String>,
    pub heads: Vec<String>,
    pub anchor: Value,
    pub detached: bool,
}

/// Select a restore boundary without interpreting comment/review decisions.
/// Event references remain immutable evidence for the owning feature's reducer.
pub fn discussion_projection(
    root: &str,
    target: &str,
    record: Value,
    events: Vec<Value>,
) -> Result<DiscussionProjection, String> {
    project_discussion(root, target, record, events, 0)
}

/// Reduce only decisions selected by the restore boundary. Collapse causal edges
/// through boundary/authority events, retaining full heads for the next mutation.
pub fn decision_events(
    root: &str,
    target: &str,
    record: Value,
    events: Vec<Value>,
    kinds: &[&str],
) -> Result<(DiscussionProjection, Vec<Value>), String> {
    let selected = discussion_projection(root, target, record, events.clone())?;
    let by_id: BTreeMap<_, _> = events
        .iter()
        .map(|e| (e["id"].as_str().unwrap_or(""), e))
        .collect();
    let active: BTreeSet<_> = selected
        .event_ids
        .iter()
        .filter(|id| {
            by_id
                .get(id.as_str())
                .is_some_and(|e| kinds.contains(&e["kind"].as_str().unwrap_or("")))
        })
        .map(String::as_str)
        .collect();
    let mut reduced = Vec::new();
    for id in &active {
        let mut event = (*by_id[id]).clone();
        let mut pending: Vec<_> = event["parents"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .collect();
        let mut visited = BTreeSet::new();
        let mut parents = BTreeSet::new();
        while let Some(parent) = pending.pop() {
            if parent == *id || !visited.insert(parent) {
                continue;
            }
            if active.contains(parent) {
                parents.insert(parent);
                continue;
            }
            let ancestor = by_id.get(parent).ok_or("Missing decision ancestry.")?;
            if ancestor["kind"] == "restoreProjection" {
                pending.extend(
                    ancestor["payload"]["eventIds"]
                        .as_array()
                        .into_iter()
                        .flatten()
                        .filter_map(Value::as_str),
                );
            } else {
                pending.extend(
                    ancestor["parents"]
                        .as_array()
                        .into_iter()
                        .flatten()
                        .filter_map(Value::as_str),
                );
            }
        }
        event["parents"] = json!(parents);
        reduced.push(event);
    }
    Ok((selected, reduced))
}

/// Causal heads do not require choosing between concurrent restore projections.
pub fn discussion_heads(target: &str, events: Vec<Value>) -> Result<Vec<String>, String> {
    discussion_graph(target, events).map(|(_, heads)| heads)
}

fn discussion_graph(
    target: &str,
    events: Vec<Value>,
) -> Result<(BTreeMap<String, Value>, Vec<String>), String> {
    if events.len() > schema::RECORDS {
        return Err("Discussion projection exceeds its bound.".into());
    }
    let mut by_id = BTreeMap::new();
    for event in events {
        // Imported claims remain evidence, never local decisions or restore heads.
        if event["payload"]["evidence"] == true {
            continue;
        }
        let id = event["id"]
            .as_str()
            .ok_or("Missing discussion event ID.")?
            .to_owned();
        if event["targetId"] != target || by_id.insert(id, event).is_some() {
            return Err("Duplicate or foreign discussion event.".into());
        }
    }
    let mut children: BTreeMap<String, Vec<String>> = BTreeMap::new();
    let mut remaining = BTreeMap::new();
    for (id, event) in &by_id {
        let parents = event["parents"]
            .as_array()
            .ok_or("Missing event parents.")?;
        remaining.insert(id.clone(), parents.len());
        for parent in parents {
            let parent = parent.as_str().ok_or("Invalid event parent.")?;
            if !by_id.contains_key(parent) {
                return Err("Discussion history is pending: an event parent is missing.".into());
            }
            children.entry(parent.into()).or_default().push(id.clone());
        }
    }
    let heads = by_id
        .keys()
        .filter(|id| !children.contains_key(*id))
        .cloned()
        .collect();
    let mut ready: Vec<_> = remaining
        .iter()
        .filter(|(_, count)| **count == 0)
        .map(|(id, _)| id.clone())
        .collect();
    let mut visited = 0;
    while let Some(id) = ready.pop() {
        visited += 1;
        for child in children.get(&id).into_iter().flatten() {
            let count = remaining.get_mut(child).unwrap();
            *count -= 1;
            if *count == 0 {
                ready.push(child.clone());
            }
        }
    }
    if visited != by_id.len() {
        return Err("Discussion history contains a cycle.".into());
    }
    Ok((by_id, heads))
}

fn project_discussion(
    root: &str,
    target: &str,
    record: Value,
    events: Vec<Value>,
    depth: usize,
) -> Result<DiscussionProjection, String> {
    if depth > 64 || events.len() > schema::RECORDS {
        return Err("Discussion projection exceeds its bound.".into());
    }
    let (by_id, heads) = discussion_graph(target, events)?;
    let ancestors = |id: &str| {
        let mut found = BTreeSet::new();
        let mut pending = vec![id.to_owned()];
        while let Some(id) = pending.pop() {
            for parent in by_id[&id]["parents"].as_array().unwrap() {
                let parent = parent.as_str().unwrap().to_owned();
                if found.insert(parent.clone()) {
                    pending.push(parent);
                }
            }
        }
        found
    };
    let restores: BTreeSet<_> = by_id
        .iter()
        .filter(|(_, e)| e["kind"] == "restoreProjection")
        .map(|(id, _)| id.clone())
        .collect();
    let mut latest = restores.clone();
    for id in &restores {
        for parent in ancestors(id) {
            latest.remove(&parent);
        }
    }
    if latest.len() > 1 {
        return Err("Concurrent discussion restorations need resolution.".into());
    }
    let mut result = DiscussionProjection {
        projection: record,
        event_ids: vec![],
        heads,
        anchor: Value::Null,
        detached: false,
    };
    let mut active: BTreeSet<_> = by_id.keys().cloned().collect();
    if let Some(id) = latest.first() {
        let payload = &by_id[id]["payload"];
        if payload["root"] != root || payload.get("projection").is_none() {
            return Err("Invalid discussion restore projection.".into());
        }
        let refs: Vec<String> = if let Some(ids) = payload.get("eventIds") {
            serde_json::from_value(ids.clone()).map_err(|_| "Invalid restore event references.")?
        } else {
            // Read earlier backups, but never embed their nested projections in a new event.
            let legacy = serde_json::from_value(payload["events"].clone())
                .map_err(|_| "Missing restore event references.")?;
            let projected = project_discussion(
                root,
                target,
                payload["projection"].clone(),
                legacy,
                depth + 1,
            )?;
            result.projection = projected.projection;
            projected.event_ids
        };
        if payload.get("eventIds").is_some() {
            result.projection = payload["projection"].clone();
        }
        for parent in ancestors(id) {
            active.remove(&parent);
        }
        active.remove(id);
        for reference in refs {
            let event = by_id
                .get(&reference)
                .ok_or("Discussion history is pending: a restored event is missing.")?;
            if event["kind"] == "restoreProjection" {
                return Err("Restore references must name normalized discussion events.".into());
            }
            // The restore's mapped binding supersedes checkpoint reattach identities.
            // Later reattachments remain active through the ordinary causal path.
            if root == "anchors" && event["kind"] == "anchorReattach" {
                continue;
            }
            active.insert(reference);
        }
        result.anchor = payload["anchor"].clone();
        result.detached = payload["detached"].as_bool().unwrap_or(false);
    }
    result.event_ids = active.into_iter().collect();
    Ok(result)
}

#[cfg(test)]
mod projection_tests {
    use super::*;
    fn event(id: &str, parents: &[&str], kind: &str, payload: Value) -> Value {
        json!({"id":id,"targetId":"thread","parents":parents,"kind":kind,"payload":payload})
    }
    fn restore(id: &str, parents: &[&str], refs: &[&str]) -> Value {
        event(
            id,
            parents,
            "restoreProjection",
            json!({"root":"threads","projection":{"id":"thread"},"eventIds":refs,"anchor":null,"detached":false}),
        )
    }
    fn project(events: Vec<Value>) -> Result<DiscussionProjection, String> {
        discussion_projection("threads", "thread", json!({"id":"thread"}), events)
    }
    #[test]
    fn restores_select_events_without_replaying_superseded_decisions() {
        let events = vec![
            event("resolve", &[], "threadResolve", json!({})),
            restore("old", &["resolve"], &[]),
            event("reopen", &["old"], "threadReopen", json!({})),
            restore("new", &["reopen"], &["resolve"]),
        ];
        let result = project(events).unwrap();
        assert_eq!(result.event_ids, ["resolve"]);
        assert_eq!(result.heads, ["new"]);
    }
    #[test]
    fn imported_evidence_cannot_select_restoration_or_causal_heads() {
        let evidence = event(
            "imported",
            &["foreign-parent"],
            "restoreProjection",
            json!({"evidence":true,"importedLineage":"foreign"}),
        );
        let result = project(vec![evidence.clone()]).unwrap();
        assert_eq!(result.projection, json!({"id":"thread"}));
        assert!(result.event_ids.is_empty());
        assert!(result.heads.is_empty());
        let restored = project(vec![evidence, restore("local", &[], &[])]).unwrap();
        assert_eq!(restored.heads, ["local"]);
    }
    #[test]
    fn concurrent_decisions_survive_but_concurrent_restores_require_resolution() {
        let resolve = event("resolve", &[], "threadResolve", json!({}));
        let reopen = event("reopen", &[], "threadReopen", json!({}));
        let result = project(vec![resolve.clone(), reopen]).unwrap();
        assert_eq!(result.event_ids.len(), 2);
        assert_eq!(result.heads.len(), 2);
        assert!(
            project(vec![
                resolve,
                restore("a", &["resolve"], &[]),
                restore("b", &["resolve"], &[])
            ])
            .unwrap_err()
            .contains("Concurrent")
        );
    }
    #[test]
    fn explicit_restore_can_supersede_competing_boundaries() {
        let mut events = vec![restore("a", &[], &[]), restore("b", &[], &[])];
        assert!(project(events.clone()).unwrap_err().contains("Concurrent"));
        assert_eq!(
            discussion_heads("thread", events.clone()).unwrap(),
            ["a", "b"]
        );
        events.push(restore("resolved", &["a", "b"], &[]));
        assert_eq!(project(events).unwrap().heads, ["resolved"]);
        assert!(
            discussion_heads(
                "thread",
                vec![event("a", &["missing"], "threadResolve", json!({}))]
            )
            .is_err()
        );
        assert!(
            discussion_heads(
                "thread",
                vec![event("a", &["a"], "threadResolve", json!({}))]
            )
            .is_err()
        );
    }
    #[test]
    fn missing_parents_references_cycles_and_nested_references_fail_closed() {
        assert!(
            project(vec![event("a", &["missing"], "threadResolve", json!({}))])
                .unwrap_err()
                .contains("pending")
        );
        assert!(
            project(vec![restore("a", &[], &["missing"])])
                .unwrap_err()
                .contains("pending")
        );
        assert!(
            project(vec![
                event("a", &["b"], "threadResolve", json!({})),
                event("b", &["a"], "threadReopen", json!({}))
            ])
            .unwrap_err()
            .contains("cycle")
        );
        assert!(
            project(vec![restore("a", &[], &[]), restore("b", &["a"], &["a"])])
                .unwrap_err()
                .contains("normalized")
        );
    }
    #[test]
    fn absent_records_and_legacy_embedded_projections_normalize() {
        let resolve = event("resolve", &[], "threadResolve", json!({}));
        let legacy = event(
            "old",
            &["resolve"],
            "restoreProjection",
            json!({"root":"threads","projection":null,"events":[],"detached":true}),
        );
        let nested = event(
            "new",
            &["old"],
            "restoreProjection",
            json!({"root":"threads","projection":{"id":"thread"},"events":[resolve.clone(),legacy.clone()]}),
        );
        let result = project(vec![resolve, legacy, nested]).unwrap();
        assert!(result.projection.is_null());
        assert!(result.event_ids.is_empty());
    }
}
