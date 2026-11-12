//! Versioned project commands. Grants are supplied by the trusted host, never by requests.
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};

pub const VERSION: u32 = 1;
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Request {
    pub version: u32,
    pub request_id: String,
    pub project_id: String,
    pub expected_revision: Option<String>,
    pub command: Command,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Context {
    pub project_id: String,
    pub revision: String,
    pub capabilities: BTreeSet<Capability>,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Capability {
    Read,
    Write,
    Export,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "op", deny_unknown_fields)]
pub enum Command {
    #[serde(rename = "project.inspect")]
    Inspect {},
    #[serde(rename = "file.read")]
    Read { id: String },
    #[serde(rename = "project.export")]
    Export {},
    #[serde(rename = "project.configure")]
    Configure {
        name: Option<String>,
        engine: Option<crate::Engine>,
        #[serde(rename = "mainFile")]
        main_file: Option<String>,
    },
    #[serde(rename = "environment.set")]
    Environment {
        #[serde(deserialize_with = "required_environment")]
        environment: Option<crate::environment::Lock>,
    },
    #[serde(rename = "files.add")]
    Add { entries: Vec<Entry> },
    #[serde(rename = "node.planRelocation")]
    PlanRelocation { id: String, path: String },
    #[serde(rename = "node.relocate")]
    Relocate {
        id: String,
        path: String,
        #[serde(rename = "selectedReferences")]
        selected_references: Vec<usize>,
    },
    #[serde(rename = "node.duplicate")]
    Duplicate { id: String, path: String },
    #[serde(rename = "node.delete")]
    Delete { id: String },
    #[serde(rename = "trash.restore")]
    Restore {},
    #[serde(rename = "asset.replace")]
    Replace { id: String, blob: Blob },
    #[serde(rename = "text.patch")]
    Patch { edits: Vec<Edit> },
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase", deny_unknown_fields)]
pub enum Entry {
    Folder {
        id: Option<String>,
        path: String,
    },
    Text {
        id: Option<String>,
        path: String,
        content: String,
    },
    Asset {
        id: Option<String>,
        path: String,
        blob: Blob,
    },
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Blob {
    pub hash: String,
    pub size: usize,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Edit {
    pub file_id: String,
    pub start: u32,
    pub end: u32,
    pub before: String,
    pub after: String,
}
#[derive(Debug, Serialize)]
pub struct Error {
    pub code: &'static str,
    pub message: String,
}
impl Error {
    pub fn invalid(message: impl Into<String>) -> Self {
        Self {
            code: "invalid_request",
            message: message.into(),
        }
    }
}
fn required_environment<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<crate::environment::Lock>, D::Error> {
    Option::<crate::environment::Lock>::deserialize(deserializer)
}
fn fail(code: &'static str, message: &str) -> Error {
    Error {
        code,
        message: message.into(),
    }
}
fn id(value: &str) -> bool {
    !value.is_empty() && value.len() <= 256 && !value.chars().any(char::is_control)
}
fn check_id(value: &str) -> Result<(), Error> {
    if id(value) {
        Ok(())
    } else {
        Err(Error::invalid(
            "Invalid project, request or file identifier.",
        ))
    }
}
fn check_path(path: &str) -> Result<(), Error> {
    if crate::valid_path(path) {
        Ok(())
    } else {
        Err(Error::invalid("Invalid project path."))
    }
}
fn check_blob(blob: &Blob) -> Result<(), Error> {
    if crate::blob::valid_hash(&blob.hash) && blob.size <= crate::blob::MAX_BLOB_BYTES {
        Ok(())
    } else {
        Err(Error::invalid("Invalid binary object reference."))
    }
}
impl Command {
    pub fn capability(&self) -> Capability {
        match self {
            Self::Inspect {} | Self::Read { .. } | Self::PlanRelocation { .. } => Capability::Read,
            Self::Export {} => Capability::Export,
            _ => Capability::Write,
        }
    }
    fn validate(&self) -> Result<(), Error> {
        match self {
            Self::Read { id: value } | Self::Delete { id: value } => check_id(value)?,
            Self::PlanRelocation { id: value, path }
            | Self::Relocate {
                id: value, path, ..
            }
            | Self::Duplicate { id: value, path } => {
                check_id(value)?;
                check_path(path)?;
            }
            Self::Configure {
                name,
                main_file,
                engine,
            } => {
                if let Some(name) = name {
                    if name.trim().is_empty()
                        || name.encode_utf16().count() > 160
                        || name.chars().any(char::is_control)
                    {
                        return Err(Error::invalid(
                            "Project names must contain 1–160 characters without control characters.",
                        ));
                    }
                }
                if engine
                    .as_ref()
                    .is_some_and(|e| *e != crate::Engine::LuaLatex)
                {
                    return Err(Error::invalid("Scribyra currently supports LuaLaTeX only."));
                }
                if let Some(value) = main_file {
                    if !value.is_empty() {
                        check_id(value)?;
                    }
                }
            }
            Self::Environment { environment } => {
                if let Some(lock) = environment {
                    lock.validate().map_err(Error::invalid)?;
                }
            }
            Self::Add { entries } => {
                if entries.is_empty() || entries.len() > 1024 {
                    return Err(Error::invalid("Add between 1 and 1,024 entries."));
                }
                let mut bytes = 0usize;
                for entry in entries {
                    let (value, path) = match entry {
                        Entry::Folder { id, path } => (id, path),
                        Entry::Text { id, path, content } => {
                            bytes = bytes.saturating_add(content.len());
                            (id, path)
                        }
                        Entry::Asset { id, path, blob } => {
                            check_blob(blob)?;
                            bytes = bytes.saturating_add(blob.size);
                            (id, path)
                        }
                    };
                    if let Some(value) = value {
                        check_id(value)?;
                    }
                    check_path(path)?;
                }
                if bytes > crate::blob::MAX_BLOB_BYTES {
                    return Err(Error::invalid("Added files exceed 64 MiB."));
                }
            }
            Self::Replace { id: value, blob } => {
                check_id(value)?;
                check_blob(blob)?;
            }
            Self::Patch { edits } => {
                if edits.len() > 2000 {
                    return Err(Error::invalid("Patch exceeds 2,000 edits."));
                }
                let mut bytes = 0usize;
                for edit in edits {
                    check_id(&edit.file_id)?;
                    if edit.end < edit.start {
                        return Err(Error::invalid("Invalid source range."));
                    }
                    bytes = bytes
                        .saturating_add(edit.before.len())
                        .saturating_add(edit.after.len());
                }
                if bytes > 2 * crate::blob::MAX_BLOB_BYTES {
                    return Err(Error::invalid("Source patch exceeds the size limit."));
                }
            }
            _ => {}
        }
        if let Self::Relocate {
            selected_references,
            ..
        } = self
        {
            if selected_references.len() > 2000 {
                return Err(Error::invalid("Too many selected reference edits."));
            }
        }
        Ok(())
    }
}
pub fn validate(request: &Request, context: &Context) -> Result<(), Error> {
    if request.version != VERSION {
        return Err(fail(
            "unsupported_version",
            "Unsupported command protocol version.",
        ));
    }
    check_id(&request.request_id)?;
    check_id(&request.project_id)?;
    if request.project_id != context.project_id
        || !context.capabilities.contains(&request.command.capability())
    {
        return Err(fail(
            "permission_denied",
            "This command is not authorized for this project.",
        ));
    }
    if request.command.capability() == Capability::Write && request.expected_revision.is_none() {
        return Err(fail(
            "revision_required",
            "A write must specify the revision it was prepared against.",
        ));
    }
    if let Some(revision) = &request.expected_revision {
        if revision != &context.revision {
            return Err(fail(
                "revision_conflict",
                "Project changed. Review the operation against the current revision.",
            ));
        }
    }
    request.command.validate()
}
/// Convert UTF-16 editor offsets only at scalar boundaries. Never split a surrogate pair.
fn byte_offsets(text: &str, wanted: &BTreeSet<u32>) -> Option<BTreeMap<u32, usize>> {
    let mut chars = text.char_indices();
    let mut offset = 0;
    let mut byte = 0;
    let mut result = BTreeMap::new();
    for target in wanted {
        while offset < *target {
            let (start, ch) = chars.next()?;
            offset += ch.len_utf16() as u32;
            byte = start + ch.len_utf8();
        }
        if offset != *target {
            return None;
        }
        result.insert(*target, byte);
    }
    Some(result)
}
pub fn validate_patch(
    edits: &[Edit],
    sources: &BTreeMap<String, String>,
    bytes: usize,
) -> Result<Vec<Edit>, Error> {
    Command::Patch {
        edits: edits.to_vec(),
    }
    .validate()?;
    let mut sorted = edits.to_vec();
    sorted.sort_by(|a, b| (&a.file_id, a.start, a.end).cmp(&(&b.file_id, b.start, b.end)));
    let mut requested: BTreeMap<&str, BTreeSet<u32>> = BTreeMap::new();
    for edit in &sorted {
        let offsets = requested.entry(&edit.file_id).or_default();
        offsets.insert(edit.start);
        offsets.insert(edit.end);
    }
    let mut offsets = BTreeMap::new();
    for (id, wanted) in requested {
        let text = sources
            .get(id)
            .ok_or_else(|| Error::invalid("Patch target is not a live text file."))?;
        offsets.insert(
            id,
            byte_offsets(text, &wanted).ok_or_else(|| {
                Error::invalid("Source range splits a character or is outside the file.")
            })?,
        );
    }
    let mut total = bytes as i64;
    for (index, edit) in sorted.iter().enumerate() {
        let text = &sources[&edit.file_id];
        let positions = &offsets[edit.file_id.as_str()];
        let start = positions[&edit.start];
        let end = positions[&edit.end];
        if text.get(start..end) != Some(edit.before.as_str()) {
            return Err(fail(
                "revision_conflict",
                "Source text changed. Review the patch again.",
            ));
        }
        if index > 0 {
            let prev = &sorted[index - 1];
            if prev.file_id == edit.file_id && (edit.start < prev.end || edit.start == prev.start) {
                return Err(Error::invalid("Overlapping source edits are not allowed."));
            }
        }
        total += edit.after.len() as i64 - edit.before.len() as i64;
    }
    if total < 0 || total > crate::blob::MAX_BLOB_BYTES as i64 {
        return Err(Error::invalid("Patch exceeds the 64 MiB project limit."));
    }
    sorted.reverse();
    Ok(sorted)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn authorization_revision_and_closed_schema() {
        let mut req = Request {
            version: 1,
            request_id: "request".into(),
            project_id: "project".into(),
            expected_revision: Some("revision".into()),
            command: Command::Delete { id: "file".into() },
        };
        let mut context = Context {
            project_id: "project".into(),
            revision: "revision".into(),
            capabilities: BTreeSet::from([Capability::Read]),
        };
        assert_eq!(
            validate(&req, &context).unwrap_err().code,
            "permission_denied"
        );
        context.capabilities.insert(Capability::Write);
        assert!(validate(&req, &context).is_ok());
        req.expected_revision = None;
        assert_eq!(
            validate(&req, &context).unwrap_err().code,
            "revision_required"
        );
        req.expected_revision = Some("old".into());
        assert_eq!(
            validate(&req, &context).unwrap_err().code,
            "revision_conflict"
        );
        req.project_id = "other".into();
        assert_eq!(
            validate(&req, &context).unwrap_err().code,
            "permission_denied"
        );
        req.version = 2;
        assert_eq!(
            validate(&req, &context).unwrap_err().code,
            "unsupported_version"
        );
        assert!(
            serde_json::from_str::<Command>(r#"{"op":"project.inspect","admin":true}"#).is_err()
        );
        assert!(
            serde_json::from_str::<Command>(r#"{"op":"node.delete","id":"x","admin":true}"#)
                .is_err()
        );
    }
    #[test]
    fn patches_check_unicode_overlap_contents_and_total_size() {
        let sources = BTreeMap::from([("a".into(), "🌍 alpha".into())]);
        let edit = Edit {
            file_id: "a".into(),
            start: 3,
            end: 8,
            before: "alpha".into(),
            after: "β".into(),
        };
        assert_eq!(
            validate_patch(&[edit.clone()], &sources, 10).unwrap()[0].after,
            "β"
        );
        assert!(validate_patch(&[edit.clone(), edit.clone()], &sources, 10).is_err());
        let split = Edit {
            start: 1,
            end: 2,
            before: "".into(),
            ..edit.clone()
        };
        assert!(validate_patch(&[split], &sources, 10).is_err());
        let stale = Edit {
            before: "other".into(),
            ..edit.clone()
        };
        assert_eq!(
            validate_patch(&[stale], &sources, 10).unwrap_err().code,
            "revision_conflict"
        );
        let big = Edit {
            after: "longer than before".into(),
            ..edit
        };
        assert!(validate_patch(&[big], &sources, crate::blob::MAX_BLOB_BYTES).is_err());
    }
}
