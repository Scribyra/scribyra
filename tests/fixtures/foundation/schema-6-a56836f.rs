//! Shared reservations for comments, reviews and history. No feature decisions live here.
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha1::{Digest, Sha1};
use std::collections::{BTreeMap, BTreeSet};

pub const PROJECT_VERSION: u32 = 6;
pub const DATABASE_VERSION: u32 = 7;
pub const RECORD_VERSION: u32 = 1;
pub const BACKUP_VERSION: u32 = 1;
pub const COMMAND_VERSION: u32 = 2;
pub const MESSAGE_BYTES: usize = 16 * 1024;
pub const MENTIONS: usize = 64;
pub const LABEL_SCALARS: usize = 160;
pub const SUGGESTION_BYTES: usize = 1024 * 1024;
pub const RECORDS: usize = 10_000;
pub const SEMANTIC_BYTES: usize = 16 * 1024 * 1024;
pub const WITNESS_RUNS: usize = 4096;
pub const CHUNK_BYTES: usize = 4 * 1024 * 1024;
pub const PAGE_DEFAULT: usize = 50;
pub const PAGE_MAX: usize = 100;
pub const RECEIPT_BYTES: usize = 64 * 1024;
pub const BACKUP_BYTES: usize = 512 * 1024 * 1024;
pub const BACKUP_ENTRIES: usize = 100_000;
pub const ROOTS: [&str; 9] = [
    "authors",
    "threads",
    "messages",
    "anchors",
    "suggestions",
    "reviews",
    "discussionEvents",
    "changes",
    "versions",
];
pub const LINEAGE_NAMESPACE: &str = "962970bc-0767-4f67-9182-9df1e7357c72";

pub fn versions() -> Value {
    serde_json::json!({"project":PROJECT_VERSION,"database":DATABASE_VERSION,"record":RECORD_VERSION,"backup":BACKUP_VERSION,"command":COMMAND_VERSION,"roots":ROOTS,
        "limits":{"messageBytes":MESSAGE_BYTES,"mentions":MENTIONS,"labelScalars":LABEL_SCALARS,"suggestionBytes":SUGGESTION_BYTES,"records":RECORDS,"semanticBytes":SEMANTIC_BYTES,"witnessRuns":WITNESS_RUNS,"chunkBytes":CHUNK_BYTES,"pageDefault":PAGE_DEFAULT,"pageMax":PAGE_MAX,"receiptBytes":RECEIPT_BYTES,"backupBytes":BACKUP_BYTES,"backupEntries":BACKUP_ENTRIES}})
}

/// RFC 9562 UUIDv5; the namespace bytes are fixed, never a local Yjs client ID.
pub fn lineage(project_id: &str) -> String {
    let namespace = [
        0x96, 0x29, 0x70, 0xbc, 0x07, 0x67, 0x4f, 0x67, 0x91, 0x82, 0x9d, 0xf1, 0xe7, 0x35, 0x7c,
        0x72,
    ];
    let mut digest = Sha1::new();
    digest.update(namespace);
    digest.update(project_id.as_bytes());
    let mut bytes: [u8; 16] = digest.finalize()[..16].try_into().unwrap();
    bytes[6] = (bytes[6] & 15) | 0x50;
    bytes[8] = (bytes[8] & 63) | 0x80;
    let hex = bytes.iter().map(|b| format!("{b:02x}")).collect::<String>();
    format!(
        "{}-{}-{}-{}-{}",
        &hex[..8],
        &hex[8..12],
        &hex[12..16],
        &hex[16..20],
        &hex[20..]
    )
}
pub fn uuid(value: &str) -> bool {
    value.len() == 36
        && value.bytes().enumerate().all(|(i, b)| {
            if [8, 13, 18, 23].contains(&i) {
                b == b'-'
            } else {
                b.is_ascii_hexdigit()
            }
        })
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Right {
    Read,
    Edit,
    Comment,
    Review,
    Export,
    History,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ActorKind {
    Human,
    Agent,
    Legacy,
}
macro_rules! record {
    ($name:ident { $($field:ident : $ty:ty),* $(,)? }) => {
        #[derive(Debug, Clone, Serialize, Deserialize)]
        #[serde(rename_all="camelCase", deny_unknown_fields)]
        pub struct $name { pub version: u32, pub id: String, pub author_id: String, pub change_id: String, pub created_at: u64, $(pub $field: $ty),* }
    };
}
record!(Author { kind: ActorKind, display_name: String, owner_author_id: Option<String> });
record!(Thread { anchor_id: String, review_id: Option<String>, first_message_id: String });
record!(Message { thread_id: String, reply_to_id: Option<String>, body: String, mention_author_ids: Vec<String> });
record!(Suggestion { review_id: String, anchor_id: String, base_digest: String, before: String, after: String, supersedes_id: Option<String> });
record!(Review { title: String, base_checkpoint_ref: Option<String>, acceptance_authority_id: String, authority_epoch: u32 });
record!(Change { actor_kind: ActorKind, session_id: String, kind: String, file_ids: Vec<String>, suggestion_id: Option<String>, proposed_by: Option<String>, undo_of: Option<String>, restore_of: Option<String> });
record!(NamedVersion { label: String, checkpoint_ref: String, based_on_change_ids: Vec<String> });
record!(DiscussionEvent { target_id: String, parents: Vec<String>, kind: EventKind, payload: Value });
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum EventKind {
    MessageEdit,
    MessageRedact,
    AnchorReattach,
    ThreadResolve,
    ThreadReopen,
    ReviewSubmit,
    ReviewClose,
    SuggestionReject,
    SuggestionWithdraw,
    SuggestionAccept,
    SuggestionRevert,
    AuthorRename,
    VersionRename,
    VersionUnpin,
    AuthorityTransfer,
    RestoreProjection,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ItemId {
    pub client: u64,
    pub clock: u64,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RelativePosition {
    pub r#type: Option<ItemId>,
    pub tname: Option<String>,
    pub item: Option<ItemId>,
    pub assoc: i32,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Witness {
    pub client: u64,
    pub clock: u64,
    pub length: u64,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AnchorKind {
    Range,
    Point,
}
record!(Anchor { file_id: String, kind: AnchorKind, start: RelativePosition, end: RelativePosition, witnesses: Vec<Witness>, quote: String, prefix: String, suffix: String, path_at_creation: String });
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ObjectRef {
    pub hash: String,
    pub size: usize,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CheckpointManifest {
    pub version: u32,
    pub checkpoint_id: String,
    pub lineage_id: String,
    pub schema_version: u32,
    pub created_at: u64,
    pub change_ids: Vec<String>,
    pub update_chunks: Vec<ObjectRef>,
    pub assets: Vec<ObjectRef>,
    pub parents: Vec<String>,
}

fn parse<T: serde::de::DeserializeOwned>(value: &Value) -> Result<T, String> {
    serde_json::from_value(value.clone()).map_err(|e| format!("Invalid collaboration record: {e}"))
}
fn label(value: &str) -> Result<(), String> {
    if value.chars().count() > LABEL_SCALARS {
        Err("Collaboration label exceeds 160 scalars.".into())
    } else {
        Ok(())
    }
}
pub fn validate_record(root: &str, value: &Value) -> Result<(), String> {
    if value["version"] != RECORD_VERSION {
        return Err("Unsupported collaboration record version.".into());
    }
    for field in ["id", "authorId", "changeId"] {
        if !value[field].as_str().is_some_and(uuid) {
            return Err(format!("Invalid collaboration {field}."));
        }
    }
    // Semantic references may be pending, but their identities are still UUIDs.
    for field in [
        "ownerAuthorId",
        "anchorId",
        "reviewId",
        "firstMessageId",
        "threadId",
        "replyToId",
        "supersedesId",
        "acceptanceAuthorityId",
        "suggestionId",
        "proposedBy",
        "undoOf",
        "restoreOf",
        "targetId",
    ] {
        if let Some(reference) = value.get(field).filter(|v| !v.is_null()) {
            if !reference.as_str().is_some_and(uuid) {
                return Err(format!("Invalid collaboration reference {field}."));
            }
        }
    }
    for field in ["mentionAuthorIds", "parents", "basedOnChangeIds"] {
        if let Some(references) = value.get(field).and_then(Value::as_array) {
            if references
                .iter()
                .any(|reference| !reference.as_str().is_some_and(uuid))
            {
                return Err(format!("Invalid collaboration references {field}."));
            }
        }
    }
    match root {
        "authors" => {
            let r: Author = parse(value)?;
            label(&r.display_name)?;
        }
        "threads" => {
            let _: Thread = parse(value)?;
        }
        "messages" => {
            let r: Message = parse(value)?;
            if r.body.len() > MESSAGE_BYTES || r.mention_author_ids.len() > MENTIONS {
                return Err("Message limit exceeded.".into());
            }
        }
        "suggestions" => {
            let r: Suggestion = parse(value)?;
            if r.before.len() + r.after.len() > SUGGESTION_BYTES
                || !crate::blob::valid_hash(&r.base_digest)
            {
                return Err("Invalid suggestion digest or size.".into());
            }
        }
        "reviews" => {
            let r: Review = parse(value)?;
            label(&r.title)?;
            if r.authority_epoch != 1 {
                return Err("Unsupported authority epoch.".into());
            }
        }
        "changes" => {
            let _: Change = parse(value)?;
        }
        "versions" => {
            let r: NamedVersion = parse(value)?;
            label(&r.label)?;
        }
        "anchors" => {
            let r: Anchor = parse(value)?;
            if r.quote.chars().count() > 1024
                || r.prefix.chars().count() > 128
                || r.suffix.chars().count() > 128
                || r.witnesses.len() > WITNESS_RUNS
                || r.witnesses.iter().any(|w| w.length == 0)
            {
                return Err("Anchor limit exceeded.".into());
            }
        }
        "discussionEvents" => {
            let r: DiscussionEvent = parse(value)?;
            if !r.payload.is_object() {
                return Err("Event payload must be an object.".into());
            }
        }
        _ => return Err("Unknown collaboration root.".into()),
    }
    Ok(())
}
/// Shape/bounds are shared; feature validators add their own invariants here.
pub fn validate_state(encoded: &str) -> Result<(), String> {
    if encoded.len() > SEMANTIC_BYTES {
        return Err("Collaboration state exceeds 16 MiB. Export before continuing.".into());
    }
    let roots: BTreeMap<String, BTreeMap<String, Value>> =
        serde_json::from_str(encoded).map_err(|e| e.to_string())?;
    if roots.values().map(|r| r.len()).sum::<usize>() > RECORDS {
        return Err("Collaboration record limit exceeded.".into());
    }
    for (root, records) in &roots {
        if !ROOTS.contains(&root.as_str()) {
            return Err("Unknown collaboration root.".into());
        }
        for (id, record) in records {
            if record["id"].as_str() != Some(id) {
                return Err("Collaboration record key mismatch.".into());
            }
            validate_record(root, record)?;
        }
    }
    crate::comments::validate(&roots)?;
    crate::reviews::validate(&roots)?;
    crate::history::validate(&roots)?;
    Ok(())
}
pub type SemanticState = BTreeMap<String, BTreeMap<String, Value>>;
pub type Rights = BTreeSet<Right>;
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn lineage_is_uuid5() {
        assert_eq!(lineage("project"), "e377b62a-92fb-5c13-9bf4-3b02112b556b");
    }
    #[test]
    fn empty_roots_are_valid_and_unknown_fields_fail() {
        assert!(validate_state("{}").is_ok());
        assert!(validate_state(r#"{"privateKeys":{}}"#).is_err());
    }
}

/// The adapter normalizes legacy trees/inline assets before this byte-preservation check.
pub fn validate_migration(before: &str, after: &str) -> Result<(), String> {
    let before: Value = serde_json::from_str(before).map_err(|e| e.to_string())?;
    let after: Value = serde_json::from_str(after).map_err(|e| e.to_string())?;
    if before != after {
        return Err(
            "Migration changed accepted content, tree, trash, assets or environment lock.".into(),
        );
    }
    Ok(())
}
