//! Comment payloads, causal projections and scalar-safe anchor validation.
use crate::{
    collaboration_commands::{Error, error},
    collaboration_schema::{self as schema, Anchor, AnchorKind, SemanticState},
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::{BTreeMap, BTreeSet};

/// CodeMirror and Yjs use UTF-16; an offset must not split a Unicode scalar.
pub fn validate_range(source: &str, start: usize, end: usize) -> Result<(), String> {
    let (mut length, mut found_start, mut found_end) = (0, start == 0, end == 0);
    for scalar in source.chars() {
        length += scalar.len_utf16();
        found_start |= length == start;
        found_end |= length == end;
    }
    if start > end || !found_start || !found_end {
        return Err("Select a range on Unicode scalar boundaries in the current source.".into());
    }
    Ok(())
}

#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Filters {
    pub status: Option<String>,
    pub file_id: Option<String>,
    pub review_id: Option<String>,
    pub suggestion_id: Option<String>,
}
#[derive(Debug, Serialize, Deserialize)]
#[serde(tag = "op", deny_unknown_fields)]
pub enum Command {
    #[serde(rename = "thread.list", rename_all = "camelCase")]
    List {
        #[serde(default)]
        filters: Filters,
        cursor: Option<String>,
        limit: Option<usize>,
    },
    #[serde(rename = "thread.get", rename_all = "camelCase")]
    Get {
        id: String,
        cursor: Option<String>,
        limit: Option<usize>,
    },
    #[serde(rename = "thread.create", rename_all = "camelCase")]
    Create {
        file_id: Option<String>,
        start: Option<usize>,
        end: Option<usize>,
        suggestion_id: Option<String>,
        body: String,
        #[serde(default)]
        mentions: Vec<String>,
    },
    #[serde(rename = "thread.reply", rename_all = "camelCase")]
    Reply {
        thread_id: Option<String>,
        suggestion_id: Option<String>,
        reply_to_id: Option<String>,
        body: String,
        #[serde(default)]
        mentions: Vec<String>,
    },
    #[serde(rename = "message.edit", rename_all = "camelCase")]
    Edit {
        message_id: String,
        body: String,
        #[serde(default)]
        mentions: Vec<String>,
        event_heads: Option<Vec<String>>,
    },
    #[serde(rename = "message.redact", rename_all = "camelCase")]
    Redact {
        message_id: String,
        event_heads: Option<Vec<String>>,
    },
    #[serde(rename = "thread.resolve", rename_all = "camelCase")]
    Resolve {
        thread_id: String,
        event_heads: Vec<String>,
    },
    #[serde(rename = "thread.reopen", rename_all = "camelCase")]
    Reopen {
        thread_id: String,
        event_heads: Vec<String>,
    },
    #[serde(rename = "anchor.reattach", rename_all = "camelCase")]
    Reattach {
        anchor_id: String,
        file_id: String,
        start: usize,
        end: usize,
        event_heads: Vec<String>,
    },
}
fn invalid(message: &str) -> Error {
    error("invalid_request", message)
}
fn identities(ids: &[String]) -> bool {
    ids.len() <= schema::RECORDS
        && ids.iter().all(|id| schema::uuid(id))
        && ids.iter().collect::<BTreeSet<_>>().len() == ids.len()
}
pub fn message(body: &str, mentions: &[String]) -> Result<(), Error> {
    if body.trim().is_empty()
        || body.len() > schema::MESSAGE_BYTES
        || mentions.len() > schema::MENTIONS
        || !identities(mentions)
    {
        return Err(invalid(
            "Comments need text, at most 16 KiB UTF-8 and 64 distinct author mentions. Export your draft before reducing it.",
        ));
    }
    Ok(())
}
pub fn dispatch(command: &Value) -> Result<Value, Error> {
    let parsed: Command = serde_json::from_value(command.clone())
        .map_err(|_| invalid("Invalid comment command fields."))?;
    match &parsed {
        Command::List {
            filters,
            limit,
            cursor,
        } => {
            if filters
                .status
                .as_ref()
                .is_some_and(|s| !["open", "resolved", "detached", "all"].contains(&s.as_str()))
                || filters.review_id.as_ref().is_some_and(|s| !schema::uuid(s))
                || filters
                    .suggestion_id
                    .as_ref()
                    .is_some_and(|s| !schema::uuid(s))
            {
                return Err(invalid("Invalid thread filter."));
            }
            page(*limit, cursor)?;
        }
        Command::Get { id, limit, cursor } => {
            id_check(id)?;
            page(*limit, cursor)?;
        }
        Command::Create {
            file_id,
            start,
            end,
            body,
            mentions,
            suggestion_id,
        } => {
            match (file_id, start, end, suggestion_id) {
                (Some(file), Some(start), Some(end), None) => offsets(file, *start, *end)?,
                (None, None, None, Some(id)) => id_check(id)?,
                _ => return Err(invalid("Choose a source range or a suggestion, not both.")),
            }
            message(body, mentions)?;
        }
        Command::Reply {
            thread_id,
            suggestion_id,
            reply_to_id,
            body,
            mentions,
        } => {
            match (thread_id, suggestion_id) {
                (Some(id), None) | (None, Some(id)) => id_check(id)?,
                _ => return Err(invalid("Choose one thread or suggestion target.")),
            }
            if let Some(id) = reply_to_id {
                id_check(id)?;
            }
            message(body, mentions)?;
        }
        Command::Edit {
            message_id,
            body,
            mentions,
            event_heads,
        } => {
            id_check(message_id)?;
            message(body, mentions)?;
            heads(event_heads.as_deref())?;
        }
        Command::Redact {
            message_id,
            event_heads,
        } => {
            id_check(message_id)?;
            heads(event_heads.as_deref())?;
        }
        Command::Resolve {
            thread_id,
            event_heads,
        }
        | Command::Reopen {
            thread_id,
            event_heads,
        } => {
            id_check(thread_id)?;
            heads(Some(event_heads))?;
        }
        Command::Reattach {
            anchor_id,
            file_id,
            start,
            end,
            event_heads,
        } => {
            id_check(anchor_id)?;
            offsets(file_id, *start, *end)?;
            heads(Some(event_heads))?;
        }
    }
    serde_json::to_value(parsed).map_err(|_| invalid("Invalid comment payload."))
}
fn id_check(id: &str) -> Result<(), Error> {
    if schema::uuid(id) {
        Ok(())
    } else {
        Err(invalid("Invalid semantic identity."))
    }
}
fn offsets(file: &str, start: usize, end: usize) -> Result<(), Error> {
    if file.is_empty() || file.len() > 256 || start > end || end > 64 * 1024 * 1024 {
        return Err(invalid("Invalid source range."));
    }
    Ok(())
}
fn page(limit: Option<usize>, cursor: &Option<String>) -> Result<(), Error> {
    if limit.is_some_and(|n| n == 0 || n > schema::PAGE_MAX)
        || cursor.as_ref().is_some_and(|s| s.len() > 2048)
    {
        return Err(invalid(
            "Page limit must be 1–100 and cursors must be bounded.",
        ));
    }
    Ok(())
}
fn heads(ids: Option<&[String]>) -> Result<(), Error> {
    if ids.is_some_and(|ids| !identities(ids)) {
        return Err(invalid("Invalid decision heads."));
    }
    Ok(())
}

pub fn authorize(
    command: &Value,
    state: &SemanticState,
    author_id: &str,
    rights: &schema::Rights,
) -> Result<(), Error> {
    use schema::Right;
    let command: Command =
        serde_json::from_value(command.clone()).map_err(|_| invalid("Invalid comment command."))?;
    let read = matches!(command, Command::List { .. } | Command::Get { .. });
    if !rights.contains(if read { &Right::Read } else { &Right::Comment }) {
        return Err(error(
            "permission_denied",
            "Required comment capability is not granted.",
        ));
    }
    if let Command::Resolve { ref thread_id, .. } | Command::Reopen { ref thread_id, .. } = command
    {
        if state
            .get("threads")
            .and_then(|threads| threads.get(thread_id))
            .is_some_and(|thread| thread["suggestionId"].is_string())
        {
            return Err(error(
                "permission_denied",
                "Suggestion discussion follows the suggestion decision.",
            ));
        }
    }
    if let Command::Reattach { ref anchor_id, .. } = command {
        if entries(state, "suggestions").any(|(_, suggestion)| suggestion["anchorId"] == *anchor_id)
        {
            return Err(error(
                "permission_denied",
                "Suggestion anchors cannot be reattached. Make a fresh superseding proposal.",
            ));
        }
    }
    if let Command::Edit { message_id, .. } | Command::Redact { message_id, .. } = command {
        let message = state
            .get("messages")
            .and_then(|messages| messages.get(&message_id))
            .ok_or_else(|| error("not_found", "Message no longer exists."))?;
        if message["authorId"] != author_id && !rights.contains(&Right::Review) {
            return Err(error(
                "permission_denied",
                "Editing or redacting another author’s message also requires review rights.",
            ));
        }
    }
    Ok(())
}

pub fn validate_anchor(anchor: &Anchor) -> Result<(), String> {
    if anchor.file_id.is_empty() || anchor.file_id.len() > 256 {
        return Err("Invalid anchor file identity.".into());
    }
    for position in [&anchor.start, &anchor.end] {
        if position.r#type.is_some()
            || position.tname.as_deref() != Some(&format!("text:{}", anchor.file_id))
            || position.item.as_ref().is_some_and(|id| {
                id.client > 9_007_199_254_740_991 || id.clock > 9_007_199_254_740_991
            })
        {
            return Err("Anchor positions must belong to their exact source root.".into());
        }
    }
    let range = matches!(anchor.kind, AnchorKind::Range);
    if anchor.start.assoc != 0
        || anchor.end.assoc != if range { -1 } else { 0 }
        || (range && anchor.witnesses.is_empty())
        || (!range
            && (!anchor.witnesses.is_empty()
                || serde_json::to_value(&anchor.start).unwrap()
                    != serde_json::to_value(&anchor.end).unwrap()))
        || anchor.witnesses.iter().any(|w| {
            w.length == 0
                || w.client > 9_007_199_254_740_991
                || w.clock
                    .checked_add(w.length)
                    .is_none_or(|n| n > 9_007_199_254_740_991)
        })
    {
        return Err("Invalid anchor associations or selected item intervals.".into());
    }
    Ok(())
}
const KINDS: [&str; 6] = [
    "messageEdit",
    "messageRedact",
    "threadResolve",
    "threadReopen",
    "anchorReattach",
    "authorRename",
];
fn owned(event: &Value) -> bool {
    event["payload"]["evidence"] != true && KINDS.contains(&event["kind"].as_str().unwrap_or(""))
}
fn entries<'a>(
    state: &'a SemanticState,
    root: &str,
) -> impl Iterator<Item = (&'a String, &'a Value)> {
    state.get(root).into_iter().flatten()
}
pub fn validate_thread_targets(state: &SemanticState) -> Result<(), String> {
    for (_, thread) in entries(state, "threads") {
        if let Some(id) = thread["suggestionId"].as_str() {
            if let Some(suggestion) = state.get("suggestions").and_then(|items| items.get(id)) {
                if thread["anchorId"] != suggestion["anchorId"]
                    || thread["reviewId"] != suggestion["reviewId"]
                {
                    return Err(
                        "Suggestion discussion must retain its proposal's anchor and review."
                            .into(),
                    );
                }
            } else if schema::ROOTS.iter().any(|root| {
                *root != "suggestions"
                    && state.get(*root).is_some_and(|items| items.contains_key(id))
            }) {
                return Err("Suggestion discussion targets the wrong record type.".into());
            }
        }
    }

    Ok(())
}
pub fn validate(state: &SemanticState) -> Result<(), String> {
    validate_thread_targets(state)?;
    for (_, anchor) in entries(state, "anchors") {
        validate_anchor(
            &serde_json::from_value(anchor.clone()).map_err(|e| format!("Invalid anchor: {e}"))?,
        )?;
    }
    for (_, event) in entries(state, "discussionEvents").filter(|(_, e)| owned(e)) {
        let target = event["targetId"].as_str().unwrap_or("");
        let expected_root = match event["kind"].as_str().unwrap_or("") {
            "messageEdit" | "messageRedact" => "messages",
            "threadResolve" | "threadReopen" => "threads",
            "anchorReattach" => "anchors",
            "authorRename" => "authors",
            _ => unreachable!(),
        };
        if schema::ROOTS.iter().any(|root| {
            *root != expected_root
                && state
                    .get(*root)
                    .is_some_and(|records| records.contains_key(target))
        }) {
            return Err("Comment event targets the wrong record type.".into());
        }
        let payload = &event["payload"];
        let allowed: &[&str] = match event["kind"].as_str().unwrap_or("") {
            "messageEdit" => &["body", "mentionAuthorIds"],
            "anchorReattach" => &["anchor", "baseDigest"],
            "authorRename" => &["displayName"],
            _ => &[],
        };
        if !payload.is_object()
            || payload
                .as_object()
                .unwrap()
                .keys()
                .any(|k| !allowed.contains(&k.as_str()))
        {
            return Err("Invalid comment event payload.".into());
        }
        match event["kind"].as_str().unwrap_or("") {
            "messageEdit" => {
                let mentions: Vec<String> =
                    serde_json::from_value(payload["mentionAuthorIds"].clone())
                        .map_err(|_| "Invalid message mentions.")?;
                message(
                    payload["body"].as_str().ok_or("Missing message body.")?,
                    &mentions,
                )
                .map_err(|e| e.message)?;
            }
            "anchorReattach" => {
                if let Some(digest) = payload.get("baseDigest") {
                    if digest
                        .as_str()
                        .is_none_or(|s| s.len() != 64 || !s.bytes().all(|b| b.is_ascii_hexdigit()))
                    {
                        return Err("Invalid rebound suggestion digest.".into());
                    }
                }
                schema::validate_record("anchors", &payload["anchor"])?;
                let anchor: Anchor = serde_json::from_value(payload["anchor"].clone())
                    .map_err(|_| "Invalid replacement anchor.")?;
                validate_anchor(&anchor)?;
                if anchor.id != event["targetId"].as_str().unwrap_or("") {
                    return Err("Replacement anchor identity mismatch.".into());
                }
            }
            "authorRename" => {
                if payload["displayName"]
                    .as_str()
                    .is_none_or(|s| s.chars().count() > schema::LABEL_SCALARS)
                {
                    return Err("Invalid author display name.".into());
                }
            }
            _ => {}
        }
    }
    let events: BTreeMap<_, _> = entries(state, "discussionEvents")
        .map(|(id, e)| (id.as_str(), e))
        .collect();
    // Kahn's algorithm bounds validation even for a deliberately reversed chain.
    let mut indegrees = BTreeMap::new();
    let mut children: BTreeMap<&str, Vec<&str>> = BTreeMap::new();
    for (id, event) in &events {
        let parents = event["parents"]
            .as_array()
            .ok_or("Invalid event parents.")?;
        if parents.len() > schema::RECORDS
            || parents
                .iter()
                .filter_map(Value::as_str)
                .collect::<BTreeSet<_>>()
                .len()
                != parents.len()
        {
            return Err("Invalid or duplicate event parents.".into());
        }
        let mut degree = 0;
        for parent in parents {
            let parent_id = parent.as_str().ok_or("Invalid event parent.")?;
            if let Some(parent) = events.get(parent_id) {
                if parent["targetId"] != event["targetId"] {
                    return Err("Event parent belongs to a different target.".into());
                }
                degree += 1;
                children.entry(parent_id).or_default().push(id);
            }
        }
        indegrees.insert(*id, degree);
    }
    let mut ready: Vec<_> = indegrees
        .iter()
        .filter(|(_, degree)| **degree == 0)
        .map(|(id, _)| *id)
        .collect();
    let mut visited = 0;
    while let Some(id) = ready.pop() {
        visited += 1;
        for child in children.get(id).into_iter().flatten() {
            let degree = indegrees.get_mut(child).unwrap();
            *degree -= 1;
            if *degree == 0 {
                ready.push(child);
            }
        }
    }
    if visited != events.len() {
        return Err("Cyclic discussion events.".into());
    }
    Ok(())
}

/// Follow only a unique successor. A fork keeps the discussion at its original target.
pub fn project(state: &SemanticState) -> Value {
    let mut result = project_threads(state);
    let events: Vec<_> = entries(state, "discussionEvents")
        .map(|(_, e)| e.clone())
        .collect();
    let suggestions: BTreeMap<_, _> = entries(state, "suggestions")
        .filter_map(|(id, record)| {
            let decision = crate::reviews::project(id, &events);
            let record = decision.get("record").unwrap_or(record);
            (!record.is_null()).then(|| (id.as_str(), (record.clone(), decision.clone())))
        })
        .collect();
    let mut targets = BTreeMap::new();
    let mut incomplete = BTreeSet::new();
    for original in suggestions.keys() {
        let mut target = *original;
        let mut seen = BTreeSet::new();
        while seen.insert(target) {
            let Some((record, decision)) = suggestions.get(target) else {
                break;
            };
            if matches!(decision["status"].as_str(), Some("accepted" | "rejected")) {
                break;
            }
            let successors: Vec<_> = suggestions
                .iter()
                .filter(|(_, (next, _))| {
                    next["supersedesId"] == target && next["reviewId"] == record["reviewId"]
                })
                .collect();
            if successors.len() > 1 || successors.first().is_some_and(|next| seen.contains(next.0))
            {
                incomplete.insert(*original);
                target = *original;
                break;
            }
            if successors.is_empty() {
                break;
            }
            target = successors[0].0;
        }
        targets.insert(*original, target);
    }
    for thread in result["threads"].as_array_mut().unwrap() {
        let Some(original) = thread["suggestionId"].as_str().map(str::to_owned) else {
            continue;
        };
        let target = targets.get(original.as_str()).copied().unwrap_or(&original);
        thread["displaySuggestionId"] = json!(target);
        if incomplete.contains(original.as_str()) {
            thread["pending"] = json!(true);
        }
        if let Some((record, decision)) = suggestions.get(target) {
            thread["displayAnchorId"] = record["anchorId"].clone();
            thread["status"] = json!(if matches!(
                decision["status"].as_str(),
                Some("accepted" | "rejected" | "withdrawn")
            ) {
                "resolved"
            } else {
                "open"
            });
        } else {
            thread["pending"] = json!(true);
        }
    }
    result["suggestionTargets"] = json!(targets);
    result["incompleteSuggestions"] = json!(incomplete);
    result
}

fn project_threads(state: &SemanticState) -> Value {
    if !entries(state, "discussionEvents").any(|(_, e)| e["kind"] == "restoreProjection") {
        return project_active(state);
    }
    let mut effective = state.clone();
    let mut boundaries = BTreeMap::new();
    let mut failures = BTreeSet::new();
    for root in ["threads", "messages", "anchors"] {
        for (id, record) in entries(state, root) {
            let events: Vec<_> = entries(state, "discussionEvents")
                .filter(|(_, e)| e["targetId"] == *id)
                .map(|(_, e)| e.clone())
                .collect();
            if !events.iter().any(|e| e["kind"] == "restoreProjection") {
                continue;
            }
            effective
                .entry("discussionEvents".into())
                .or_default()
                .retain(|_, e| e["targetId"] != *id);
            match crate::history::decision_events(root, id, record.clone(), events, &KINDS) {
                Ok((selected, events)) => {
                    boundaries.insert(id.clone(), selected.heads);
                    if selected.projection.is_null() {
                        effective.get_mut(root).unwrap().remove(id);
                        continue;
                    }
                    let mut record = selected.projection;
                    if root == "anchors" {
                        if selected.detached {
                            failures.insert(id.clone());
                        } else if let Some(binding) = selected.anchor.as_object() {
                            record.as_object_mut().unwrap().extend(binding.clone());
                        }
                    }
                    effective.get_mut(root).unwrap().insert(id.clone(), record);
                    for event in events {
                        effective
                            .get_mut("discussionEvents")
                            .unwrap()
                            .insert(event["id"].as_str().unwrap().into(), event);
                    }
                }
                Err(_) => {
                    failures.insert(id.clone());
                }
            }
        }
    }
    let mut result = project_active(&effective);
    for root in ["threads", "messages", "anchors"] {
        for record in result[root].as_array_mut().unwrap() {
            let id = record["id"].as_str().unwrap().to_owned();
            if let Some(heads) = boundaries.get(&id) {
                record["eventHeads"] = json!(heads);
            }
            if failures.contains(&id) {
                if root == "threads" {
                    record["status"] = json!("open");
                    record["decisionConflict"] = json!(true);
                } else {
                    record["conflicted"] = json!(true);
                }
                record["pending"] = json!(true);
            }
        }
    }
    result
}

fn project_active(state: &SemanticState) -> Value {
    let mut targets: BTreeMap<&str, Vec<&Value>> = BTreeMap::new();
    for (_, event) in entries(state, "discussionEvents").filter(|(_, e)| owned(e)) {
        targets
            .entry(event["targetId"].as_str().unwrap_or(""))
            .or_default()
            .push(event);
    }
    let projected: BTreeMap<_, _> = targets
        .into_iter()
        .map(|(id, events)| {
            let parents: BTreeSet<_> = events
                .iter()
                .flat_map(|e| {
                    e["parents"]
                        .as_array()
                        .into_iter()
                        .flatten()
                        .filter_map(Value::as_str)
                })
                .collect();
            let ids: BTreeSet<_> = events.iter().filter_map(|e| e["id"].as_str()).collect();
            let heads: Vec<_> = events
                .iter()
                .filter(|e| !parents.contains(e["id"].as_str().unwrap_or("")))
                .copied()
                .collect();
            let pending = parents.iter().any(|p| !ids.contains(p));
            (id, (heads, pending))
        })
        .collect();
    let projection = |id: &str| projected.get(id).cloned().unwrap_or_default();
    let authors: Vec<_> = entries(state, "authors")
        .map(|(id, author)| {
            let (heads, pending) = projection(id);
            let names: Vec<_> = heads
                .iter()
                .filter_map(|e| e["payload"]["displayName"].as_str())
                .collect();
            let mut author = author.clone();
            if names.len() == 1 && !pending {
                author["displayName"] = json!(names[0]);
            }
            author["profileConflict"] = json!(pending || names.len() > 1);
            author
        })
        .collect();
    let messages: Vec<_> = entries(state, "messages").map(|(id, message)| {
        let (heads, pending) = projection(id);
        let variants: Vec<_> = if heads.is_empty() { vec![json!({"id":id,"body":message["body"],"mentionAuthorIds":message["mentionAuthorIds"],"redacted":false})] } else { heads.iter().map(|e| json!({"id":e["id"],"body":if e["kind"]=="messageRedact" {json!("")} else {e["payload"]["body"].clone()},"mentionAuthorIds":if e["kind"]=="messageRedact" {json!([])} else {e["payload"]["mentionAuthorIds"].clone()},"redacted":e["kind"]=="messageRedact"})).collect() };
        json!({"id":id,"threadId":message["threadId"],"replyToId":message["replyToId"],"authorId":message["authorId"],"variants":variants,"eventHeads":heads.iter().map(|e|e["id"].clone()).collect::<Vec<_>>(),"conflicted":pending||heads.len()>1,"pending":pending})
    }).collect();
    let anchors: Vec<_> = entries(state, "anchors").map(|(id, anchor)| {
        let (heads, pending) = projection(id);
        json!({"id":id,"binding":if heads.len()==1&&!pending {heads[0]["payload"]["anchor"].clone()} else {anchor.clone()},"eventHeads":heads.iter().map(|e|e["id"].clone()).collect::<Vec<_>>(),"conflicted":pending||heads.len()>1})
    }).collect();
    let threads: Vec<_> = entries(state, "threads").map(|(id, thread)| {
        let (heads, pending) = projection(id);
        json!({"id":id,"anchorId":thread["anchorId"],"firstMessageId":thread["firstMessageId"],"reviewId":thread["reviewId"],"suggestionId":thread["suggestionId"],"authorId":thread["authorId"],"status":if heads.len()==1&&!pending&&heads[0]["kind"]=="threadResolve" {"resolved"} else {"open"},"decisionConflict":pending||heads.len()>1,"pending":pending,"eventHeads":heads.iter().map(|e|e["id"].clone()).collect::<Vec<_>>()})
    }).collect();
    json!({"authors":authors,"threads":threads,"messages":messages,"anchors":anchors})
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn offsets_are_scalar_safe() {
        assert!(validate_range("a😀b", 1, 3).is_ok());
        assert!(validate_range("a😀b", 2, 3).is_err());
        assert!(validate_range("a", 2, 2).is_err());
    }
    #[test]
    fn payloads_are_closed_and_bounded() {
        assert!(dispatch(&json!({"op":"thread.create","fileId":"f","start":0,"end":1,"body":"text","mentions":[]})).is_ok());
        assert!(dispatch(&json!({"op":"thread.create","fileId":"f","start":0,"end":1,"body":"text","html":"no"})).is_err());
        assert!(dispatch(&json!({"op":"thread.list","limit":101})).is_err());
        assert!(message(&"é".repeat(schema::MESSAGE_BYTES), &[]).is_err());
    }
    #[test]
    fn causal_decisions_do_not_use_wall_time() {
        let mut state = SemanticState::new();
        state.insert(
            "threads".into(),
            BTreeMap::from([("t".into(), json!({"anchorId":"a"}))]),
        );
        state.insert("discussionEvents".into(),BTreeMap::from([("x".into(),json!({"id":"x","targetId":"t","parents":[],"kind":"threadResolve","createdAt":999,"payload":{}})),("y".into(),json!({"id":"y","targetId":"t","parents":[],"kind":"threadReopen","createdAt":0,"payload":{}}))]));
        assert_eq!(project(&state)["threads"][0]["status"], "open");
        assert_eq!(project(&state)["threads"][0]["decisionConflict"], true);
        state.get_mut("discussionEvents").unwrap().insert("z".into(),json!({"id":"z","targetId":"t","parents":["x","y"],"kind":"threadResolve","payload":{}}));
        assert_eq!(project(&state)["threads"][0]["status"], "resolved");
    }
    #[test]
    fn missing_parents_remain_pending_and_cycles_fail() {
        let mut state = SemanticState::new();
        state.insert("discussionEvents".into(),BTreeMap::from([("a".into(),json!({"id":"a","targetId":"t","parents":["b"],"kind":"threadResolve","payload":{}}))]));
        assert!(validate(&state).is_ok());
        state.get_mut("discussionEvents").unwrap().insert(
            "b".into(),
            json!({"id":"b","targetId":"t","parents":["a"],"kind":"threadReopen","payload":{}}),
        );
        assert!(validate(&state).is_err());
    }
}
