//! Review policy and causal decisions. Yjs identity resolution stays in the adapter.
use crate::{
    collaboration_commands::{Error, error},
    collaboration_schema::{LABEL_SCALARS, PAGE_MAX, SUGGESTION_BYTES, SemanticState},
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FileSelection {
    file_id: String,
    start: usize,
    end: usize,
}
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ReviewPackage {
    version: u32,
    lineage_id: String,
    review_ids: Vec<String>,
    state: SemanticState,
}
pub fn validate_package(encoded: &str) -> Result<(), String> {
    use crate::collaboration_schema::{SEMANTIC_BYTES, uuid, validate_state};
    if encoded.len() > SEMANTIC_BYTES {
        return Err("Review package exceeds 16 MiB.".into());
    }
    let package: ReviewPackage = serde_json::from_str(encoded).map_err(|e| e.to_string())?;
    if package.version != 1
        || !uuid(&package.lineage_id)
        || package.review_ids.is_empty()
        || package.review_ids.len() > 100
        || package.review_ids.iter().any(|id| !uuid(id))
    {
        return Err("Invalid review package manifest.".into());
    }
    validate_state(&serde_json::to_string(&package.state).map_err(|e| e.to_string())?)?;
    if package.state.get("versions").is_some_and(|r| !r.is_empty()) {
        return Err("Review packages cannot install history versions.".into());
    }
    let selected: BTreeSet<_> = package.review_ids.iter().collect();
    if selected.len() != package.review_ids.len()
        || selected.iter().any(|id| {
            !package
                .state
                .get("reviews")
                .is_some_and(|r| r.contains_key(*id))
        })
    {
        return Err("Review package selection is missing or duplicated.".into());
    }
    for root in ["reviews", "suggestions", "threads"] {
        for record in package.state.get(root).into_iter().flat_map(|r| r.values()) {
            let id = record[if root == "reviews" { "id" } else { "reviewId" }]
                .as_str()
                .unwrap_or("");
            if !selected.iter().any(|selected| selected.as_str() == id) {
                return Err("Record is outside the selected review closure.".into());
            }
        }
    }
    Ok(())
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(tag = "op", deny_unknown_fields)]
pub enum Command {
    #[serde(rename = "review.create")]
    Create { title: String },
    #[serde(rename = "review.list")]
    List {
        cursor: Option<String>,
        limit: Option<usize>,
    },
    #[serde(rename = "review.get")]
    Get {
        id: String,
        cursor: Option<String>,
        limit: Option<usize>,
    },
    #[serde(rename = "review.submit")]
    Submit {
        #[serde(rename = "reviewId")]
        review_id: String,
        #[serde(rename = "eventHeads")]
        event_heads: Vec<String>,
    },
    #[serde(rename = "review.close")]
    Close {
        #[serde(rename = "reviewId")]
        review_id: String,
        #[serde(rename = "eventHeads")]
        event_heads: Vec<String>,
    },
    #[serde(rename = "suggestion.propose")]
    Propose {
        #[serde(rename = "reviewId")]
        review_id: String,
        #[serde(rename = "fileId")]
        file_id: String,
        start: usize,
        end: usize,
        before: String,
        after: String,
        #[serde(rename = "supersedesId")]
        supersedes_id: Option<String>,
        #[serde(rename = "insertionOrder")]
        insertion_order: Option<f64>,
    },
    #[serde(rename = "suggestion.revise")]
    Revise {
        #[serde(rename = "reviewId")]
        review_id: String,
        #[serde(rename = "fileId")]
        file_id: String,
        start: usize,
        end: usize,
        before: String,
        after: String,
        #[serde(rename = "supersedesId")]
        supersedes_id: Option<String>,
        #[serde(rename = "insertionOrder")]
        insertion_order: Option<f64>,
    },
    #[serde(rename = "suggestion.accept")]
    Accept {
        #[serde(rename = "suggestionIds")]
        suggestion_ids: Vec<String>,
        #[serde(rename = "eventHeads")]
        event_heads: BTreeMap<String, Vec<String>>,
    },
    #[serde(rename = "suggestion.reject")]
    Reject {
        #[serde(rename = "suggestionId")]
        suggestion_id: String,
        #[serde(rename = "eventHeads")]
        event_heads: Vec<String>,
    },
    #[serde(rename = "suggestion.withdraw")]
    Withdraw {
        #[serde(rename = "suggestionId")]
        suggestion_id: String,
        #[serde(rename = "eventHeads")]
        event_heads: Vec<String>,
    },
    #[serde(rename = "change.undo")]
    Undo {
        #[serde(rename = "changeId")]
        change_id: String,
        #[serde(rename = "eventHeads")]
        event_heads: BTreeMap<String, Vec<String>>,
    },
    #[serde(rename = "change.redo")]
    Redo {
        #[serde(rename = "changeId")]
        change_id: String,
        #[serde(rename = "eventHeads")]
        event_heads: BTreeMap<String, Vec<String>>,
    },
    #[serde(rename = "review.preview")]
    Preview {
        #[serde(rename = "suggestionIds")]
        suggestion_ids: Vec<String>,
    },
    #[serde(rename = "review.export")]
    Export {
        #[serde(rename = "reviewIds")]
        review_ids: Vec<String>,
    },
    #[serde(rename = "review.importPlan")]
    ImportPlan {
        #[serde(rename = "attachmentRef")]
        attachment_ref: String,
        mapping: Option<BTreeMap<String, FileSelection>>,
    },
    #[serde(rename = "review.import")]
    Import {
        #[serde(rename = "planId")]
        plan_id: String,
    },
}
pub fn command(value: &Value) -> Result<Value, String> {
    let parsed: Command = serde_json::from_value(value.clone()).map_err(|e| e.to_string())?;
    match &parsed {
        Command::Create { title }
            if title.trim().is_empty() || title.chars().count() > LABEL_SCALARS =>
        {
            return Err("Use a title of 1–160 characters.".into());
        }
        Command::Propose {
            start,
            end,
            before,
            after,
            ..
        } if start > end || before == after || before.len() + after.len() > SUGGESTION_BYTES => {
            return Err("Invalid or oversized suggestion.".into());
        }
        Command::Revise {
            start,
            end,
            before,
            after,
            supersedes_id,
            ..
        } if start > end
            || supersedes_id.is_none()
            || before.len() + after.len() > SUGGESTION_BYTES =>
        {
            return Err("Invalid or oversized suggestion.".into());
        }
        Command::List { limit, .. } | Command::Get { limit, .. }
            if limit.is_some_and(|n| n == 0 || n > PAGE_MAX) =>
        {
            return Err("Page limit must be 1–100.".into());
        }
        Command::Accept { suggestion_ids, .. } | Command::Preview { suggestion_ids }
            if suggestion_ids.is_empty()
                || suggestion_ids.len() > 100
                || suggestion_ids.iter().collect::<BTreeSet<_>>().len() != suggestion_ids.len() =>
        {
            return Err("Select 1–100 distinct suggestions.".into());
        }
        Command::Export { review_ids } if review_ids.is_empty() || review_ids.len() > 100 => {
            return Err("Select 1–100 reviews.".into());
        }
        _ => {}
    }
    serde_json::to_value(parsed).map_err(|e| e.to_string())
}
pub fn digest(value: &str) -> String {
    format!("{:x}", Sha256::digest(value.as_bytes()))
}

/// Missing ancestry, cycles and concurrent heads never project to acceptance.
pub fn project(target: &str, events: &[Value]) -> Value {
    let events: Vec<_> = events
        .iter()
        .filter(|e| e["targetId"] == target && e["payload"]["evidence"] != true)
        .cloned()
        .collect();
    if !events.iter().any(|e| {
        matches!(
            e["kind"].as_str(),
            Some("restoreProjection" | "authorityTransfer")
        )
    }) {
        return project_active(target, &events);
    }
    let restored = events.iter().any(|e| e["kind"] == "restoreProjection");
    let root = events
        .iter()
        .find(|e| e["kind"] == "restoreProjection")
        .and_then(|e| e["payload"]["root"].as_str())
        .unwrap_or("reviews");
    let kinds = [
        "suggestionAccept",
        "suggestionReject",
        "suggestionWithdraw",
        "suggestionRevert",
        "reviewSubmit",
        "reviewClose",
        "anchorReattach",
    ];
    match crate::history::decision_events(root, target, Value::Null, events.clone(), &kinds) {
        Ok((selected, decisions)) => {
            let mut result = project_active(target, &decisions);
            result["decisionHeads"] = result["heads"].clone();
            result["heads"] = json!(selected.heads);
            if restored {
                result["record"] = selected.projection;
            }
            if let Ok((_, authority_events)) = crate::history::decision_events(
                root,
                target,
                Value::Null,
                events.clone(),
                &["authorityTransfer"],
            ) {
                let authority = project_active(target, &authority_events);
                let heads = authority["heads"].as_array().unwrap();
                if heads.len() == 1 {
                    result["authorityEvent"] = authority_events
                        .iter()
                        .find(|e| e["id"] == heads[0])
                        .unwrap()
                        .clone();
                } else if heads.len() > 1 {
                    result["authorityConflict"] = json!(true);
                }
            }
            result
        }
        Err(_) => json!({"status":"incomplete","heads":[]}),
    }
}
fn project_active(target: &str, events: &[Value]) -> Value {
    let records: BTreeMap<&str, &Value> = events
        .iter()
        .filter(|e| e["targetId"] == target && e["payload"]["evidence"] != true)
        .filter_map(|e| Some((e["id"].as_str()?, e)))
        .collect();
    let mut parents = BTreeSet::new();
    let mut incomplete = false;
    for e in records.values() {
        for p in e["parents"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
        {
            parents.insert(p);
            if !records.contains_key(p) {
                incomplete = true;
            }
        }
    }
    let heads: Vec<_> = records
        .keys()
        .filter(|id| !parents.contains(**id))
        .copied()
        .collect();
    let mut remaining: BTreeMap<&str, usize> = records
        .iter()
        .map(|(id, e)| (*id, e["parents"].as_array().map_or(0, Vec::len)))
        .collect();
    let mut children: BTreeMap<&str, Vec<&str>> = BTreeMap::new();
    for (id, e) in &records {
        for p in e["parents"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
        {
            children.entry(p).or_default().push(id);
        }
    }
    let mut ready: Vec<_> = remaining
        .iter()
        .filter(|(_, n)| **n == 0)
        .map(|(id, _)| *id)
        .collect();
    let mut visited = 0;
    while let Some(id) = ready.pop() {
        visited += 1;
        for child in children.get(id).into_iter().flatten() {
            let n = remaining.get_mut(child).unwrap();
            *n -= 1;
            if *n == 0 {
                ready.push(child);
            }
        }
    }
    incomplete |= visited != records.len();
    let status = if incomplete {
        "incomplete"
    } else if heads.len() > 1 {
        "conflicted"
    } else if let Some(id) = heads.first() {
        match records[id]["kind"].as_str().unwrap_or("") {
            "suggestionAccept" => "accepted",
            "suggestionReject" => "rejected",
            "suggestionWithdraw" => "withdrawn",
            "reviewSubmit" => "submitted",
            "reviewClose" => "closed",
            _ => "pending",
        }
    } else {
        "pending"
    };
    json!({"status":status,"heads":heads})
}
fn restored_authority(event: &Value, state: &SemanticState) -> bool {
    event["kind"] == "authorityTransfer"
        && event["payload"]["restored"] == true
        && event["payload"]["evidence"] != true
        && event["payload"]["authorityEpoch"] == 1
        && event["changeId"]
            .as_str()
            .and_then(|id| state.get("changes")?.get(id))
            .is_some_and(|change| {
                matches!(
                    change["kind"].as_str(),
                    Some("restore" | "restore-copy" | "backup-import")
                ) && {
                    let owner = change["authorId"]
                        .as_str()
                        .and_then(|id| state.get("authors")?.get(id))
                        .and_then(|author| author["ownerAuthorId"].as_str());
                    owner
                        .map(Value::from)
                        .unwrap_or_else(|| change["authorId"].clone())
                        == event["payload"]["acceptanceAuthorityId"]
                }
            })
}
/// Portable selection: restore boundaries select records and comment events;
/// decisions and excluded events remain inert provenance, never imported authority.
pub fn exchange_state(state: &SemanticState) -> Result<SemanticState, String> {
    let mut selected = state.clone();
    let events: Vec<_> = state
        .get("discussionEvents")
        .into_iter()
        .flat_map(|records| records.values())
        .cloned()
        .collect();
    let kinds = [
        "messageEdit",
        "messageRedact",
        "threadResolve",
        "threadReopen",
        "authorRename",
        "reviewSubmit",
        "reviewClose",
    ];
    let mut active = BTreeMap::new();
    for root in [
        "reviews",
        "suggestions",
        "threads",
        "messages",
        "anchors",
        "authors",
    ] {
        for (id, record) in state.get(root).into_iter().flatten() {
            let own = events
                .iter()
                .filter(|event| event["targetId"] == *id)
                .cloned()
                .collect();
            let (projection, reduced) =
                crate::history::decision_events(root, id, record.clone(), own, &kinds)?;
            if projection.projection.is_null() {
                selected.get_mut(root).unwrap().remove(id);
            } else {
                selected
                    .get_mut(root)
                    .unwrap()
                    .insert(id.clone(), projection.projection);
                for event in reduced {
                    active.insert(event["id"].as_str().unwrap().to_owned(), event);
                }
            }
        }
    }
    // New stable IDs keep normalized causal edges from mutating an existing event.
    // Propagate changed identities to descendants, but leave repeat exports stable.
    let mut changed: BTreeSet<_> = active
        .iter()
        .filter(|(id, event)| {
            state
                .get("discussionEvents")
                .and_then(|events| events.get(*id))
                != Some(*event)
        })
        .map(|(id, _)| id.clone())
        .collect();
    let mut children: BTreeMap<&str, Vec<&str>> = BTreeMap::new();
    for (id, event) in &active {
        for parent in event["parents"].as_array().unwrap() {
            children
                .entry(parent.as_str().unwrap())
                .or_default()
                .push(id);
        }
    }
    let mut pending: Vec<_> = changed.iter().cloned().collect();
    while let Some(id) = pending.pop() {
        for child in children.get(id.as_str()).into_iter().flatten() {
            if changed.insert((*child).into()) {
                pending.push((*child).into());
            }
        }
    }
    let ids: BTreeMap<_, _> = active
        .keys()
        .map(|id| {
            (
                id.clone(),
                if changed.contains(id) {
                    crate::collaboration_schema::lineage(&format!(
                        "review-exchange:{id}:{}",
                        active[id]
                    ))
                } else {
                    id.clone()
                },
            )
        })
        .collect();
    let output = selected.entry("discussionEvents".into()).or_default();
    output.clear();
    for (id, mut event) in active {
        event["id"] = json!(ids[&id]);
        event["parents"] = json!(
            event["parents"]
                .as_array()
                .unwrap()
                .iter()
                .filter_map(|parent| ids.get(parent.as_str().unwrap()))
                .collect::<Vec<_>>()
        );
        output.insert(ids[&id].clone(), event);
    }
    for event in events {
        if output.get(event["id"].as_str().unwrap()) == Some(&event) {
            continue;
        }
        if event["payload"]["evidence"] == true {
            output.insert(event["id"].as_str().unwrap().into(), event);
            continue;
        }
        let id = crate::collaboration_schema::lineage(&format!("review-evidence:{}", event["id"]));
        let mut evidence = event.clone();
        evidence["id"] = json!(id);
        evidence["parents"] = json!([]);
        evidence["payload"] = json!({"evidence":true,"importedEvent":event});
        output.insert(id, evidence);
    }
    Ok(selected)
}

pub fn validate_supersession(state: &SemanticState) -> Result<(), String> {
    let Some(suggestions) = state.get("suggestions") else {
        return Ok(());
    };
    let mut done = BTreeSet::new();
    for original in suggestions.keys() {
        let mut path = BTreeSet::new();
        let mut current = original.as_str();
        while !done.contains(current) {
            if !path.insert(current) {
                return Err("Cyclic suggestion supersession.".into());
            }
            let Some(record) = suggestions.get(current) else {
                break;
            };
            let Some(parent) = record["supersedesId"].as_str() else {
                break;
            };
            current = parent;
        }
        done.extend(path);
    }
    Ok(())
}
pub fn validate(state: &SemanticState) -> Result<(), String> {
    validate_supersession(state)?;
    for e in state
        .get("discussionEvents")
        .into_iter()
        .flat_map(|r| r.values())
    {
        if matches!(
            e["kind"].as_str(),
            Some(
                "suggestionAccept" | "suggestionReject" | "suggestionWithdraw" | "suggestionRevert"
            )
        ) {
            let p = &e["payload"];
            if p["evidence"] == true {
                continue;
            }
            if !p["acceptanceAuthorityId"]
                .as_str()
                .is_some_and(crate::collaboration_schema::uuid)
                || p["authorityEpoch"] != 1
            {
                return Err("Review decision lacks its authority epoch.".into());
            }
            if let Some(s) = e["targetId"]
                .as_str()
                .and_then(|id| state.get("suggestions")?.get(id))
            {
                if p["proposedBy"] != s["authorId"] {
                    return Err("Review decision proposer mismatch.".into());
                }
                if let Some(r) = s["reviewId"]
                    .as_str()
                    .and_then(|id| state.get("reviews")?.get(id))
                {
                    if p["acceptanceAuthorityId"] != r["acceptanceAuthorityId"]
                        && !state
                            .get("discussionEvents")
                            .into_iter()
                            .flat_map(|events| events.values())
                            .any(|event| {
                                event["targetId"] == r["id"]
                                    && restored_authority(event, state)
                                    && event["payload"]["acceptanceAuthorityId"]
                                        == p["acceptanceAuthorityId"]
                            })
                    {
                        return Err("Review decision authority mismatch.".into());
                    }
                }
            }
        }
    }
    Ok(())
}
// Central dispatch remains reserved: trusted handlers invoke the typed validator.
pub fn dispatch(_command: &Value) -> Result<Value, Error> {
    Err(error(
        "unsupported_command",
        "Use the trusted review handler.",
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn closed_commands_and_bounds() {
        assert!(command(&json!({"op":"review.create","title":"Review","grant":"edit"})).is_err());
        assert!(command(&json!({"op":"suggestion.propose","reviewId":"r","fileId":"f","start":1,"end":0,"before":"a","after":"b"})).is_err());
        assert!(command(&json!({"op":"review.list","limit":101})).is_err());
        assert!(
            command(&json!({"op":"suggestion.accept","suggestionIds":["s","s"],"eventHeads":{}}))
                .is_err()
        );
    }
    #[test]
    fn revision_requires_a_predecessor_and_allows_withdrawal_without_a_noop_record() {
        let mut revision = json!({"op":"suggestion.revise","reviewId":"r","fileId":"f","start":0,"end":1,"before":"a","after":"a"});
        assert!(command(&revision).is_err());
        revision["supersedesId"] = json!("previous");
        assert!(command(&revision).is_ok());
        revision["op"] = json!("suggestion.propose");
        assert!(command(&revision).is_err());
    }
    #[test]
    fn causal_projection_never_uses_time_or_imported_approval() {
        let a =
            json!({"id":"a","targetId":"s","kind":"suggestionAccept","parents":[],"payload":{}});
        let b =
            json!({"id":"b","targetId":"s","kind":"suggestionReject","parents":[],"payload":{}});
        assert_eq!(
            project("s", &[a.clone(), b.clone()])["status"],
            "conflicted"
        );
        let c = json!({"id":"c","targetId":"s","kind":"suggestionReject","parents":["a","b"],"payload":{}});
        assert_eq!(project("s", &[a, b, c])["status"], "rejected");
        assert_eq!(
            project(
                "s",
                &[
                    json!({"id":"a","targetId":"s","parents":["missing"],"kind":"suggestionAccept","payload":{}})
                ]
            )["status"],
            "incomplete"
        );
        assert_eq!(
            project(
                "s",
                &[
                    json!({"id":"a","targetId":"s","parents":["a"],"kind":"suggestionAccept","payload":{}})
                ]
            )["status"],
            "incomplete"
        );
        assert_eq!(
            project(
                "s",
                &[
                    json!({"id":"a","targetId":"s","parents":[],"kind":"suggestionAccept","payload":{"evidence":true}})
                ]
            )["status"],
            "pending"
        );
    }
    #[test]
    fn review_packages_are_closed_and_never_source_updates() {
        let id = "12345678-1234-1234-1234-123456789abc";
        let package = json!({"version":1,"lineageId":id,"reviewIds":[id],"state":{"reviews":{id:{"version":1,"id":id,"authorId":id,"changeId":id,"createdAt":1,"title":"Review","acceptanceAuthorityId":id,"authorityEpoch":1}}}});
        assert!(validate_package(&package.to_string()).is_ok());
        let mut extra = package.clone();
        extra["acceptedUpdate"] = json!([1, 2, 3]);
        assert!(validate_package(&extra.to_string()).is_err());
        let mut extra = package.clone();
        extra["state"]["text:main"] = json!({});
        assert!(validate_package(&extra.to_string()).is_err());
        let mut extra = package.clone();
        extra["lineageId"] = json!("not-a-lineage");
        assert!(validate_package(&extra.to_string()).is_err());
    }
    #[test]
    fn digest_is_sha256() {
        assert_eq!(
            digest("abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }
}
