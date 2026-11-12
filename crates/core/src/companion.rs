//! Browser companion authorization. Credentials/grants are supplied by trusted adapters.
//! The Rust companion is discontinued (November 8, 2026); this stays for its tests.
use crate::commands::{self, Capability};
use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;
pub const MAX_REQUEST: usize = 8 * 1024 * 1024;
pub const MAX_SEQUENCE: u64 = 9_007_199_254_740_991;
#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Permissions {
    pub read: bool,
    pub write: bool,
    pub compile: bool,
    pub export: bool,
}
impl Permissions {
    pub fn commands(&self) -> BTreeSet<Capability> {
        [
            (self.read, Capability::Read),
            (self.write, Capability::Write),
            (self.export, Capability::Export),
        ]
        .into_iter()
        .filter_map(|(allowed, cap)| allowed.then_some(cap))
        .collect()
    }
}
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum Operation {
    Inspect {},
    ReadFile {
        id: String,
        offset: u32,
        limit: u32,
    },
    Bibliography {},
    Diagnostics {},
    BuildResult {},
    Search {
        query: String,
        case_sensitive: bool,
        whole_word: bool,
        regex_mode: bool,
    },
    Command {
        request: commands::Request,
    },
    Compile {
        expected_revision: String,
    },
    Export {
        format: ExportFormat,
        expected_revision: String,
    },
    Cancel {
        request_id: String,
    },
}
#[derive(Debug, Clone, Copy, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ExportFormat {
    Source,
    Pdf,
}
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Request {
    pub version: u8,
    pub request_id: String,
    pub project_id: String,
    pub session_id: String,
    pub sequence: u64,
    pub operation: Operation,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::telemetry::deserialize_context"
    )]
    pub telemetry: Option<crate::telemetry::TraceContext>,
}
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Context {
    pub project_id: String,
    pub session_id: String,
    pub next_sequence: u64,
    pub revision: String,
    pub permissions: Permissions,
}
fn valid_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 256 && !id.chars().any(char::is_control)
}
fn validate_envelope(request: &Request, context: &Context) -> Result<(), commands::Error> {
    let error = |code, message: &str| commands::Error {
        code,
        message: message.into(),
    };
    if request.version != 1 {
        return Err(error(
            "unsupported_version",
            "Unsupported companion protocol.",
        ));
    }
    if !valid_id(&request.request_id)
        || !valid_id(&request.project_id)
        || !valid_id(&request.session_id)
        || request.sequence == 0
        || request.sequence > MAX_SEQUENCE
    {
        return Err(commands::Error::invalid(
            "Invalid companion request identity or sequence.",
        ));
    }
    if request.project_id != context.project_id
        || request.session_id != context.session_id
        || !context.permissions.read
    {
        return Err(error(
            "permission_denied",
            "This companion session is not authorized for this project.",
        ));
    }
    if request.sequence != context.next_sequence {
        return Err(error(
            "sequence_conflict",
            "Companion operation is replayed or out of order.",
        ));
    }
    Ok(())
}
pub fn validate(request: &Request, context: &Context) -> Result<(), commands::Error> {
    validate_envelope(request, context)?;
    validate_operation(request, context)
}
fn validate_operation(request: &Request, context: &Context) -> Result<(), commands::Error> {
    let error = |code, message: &str| commands::Error {
        code,
        message: message.into(),
    };
    match &request.operation {
        Operation::Command { request: command } => {
            // The live command host owns revision checks and replay receipts. Preflight
            // validates schema/permissions without rejecting a legitimate receipt retry.
            commands::validate(
                command,
                &commands::Context {
                    project_id: context.project_id.clone(),
                    revision: command
                        .expected_revision
                        .clone()
                        .unwrap_or_else(|| context.revision.clone()),
                    capabilities: context.permissions.commands(),
                },
            )?;
        }
        Operation::Compile { expected_revision }
        | Operation::Export {
            expected_revision, ..
        } => {
            let allowed = match &request.operation {
                Operation::Compile { .. } => context.permissions.compile,
                _ => context.permissions.export,
            };
            if !allowed {
                return Err(error(
                    "permission_denied",
                    "This companion operation was not granted.",
                ));
            }
            if !valid_id(expected_revision) || expected_revision != &context.revision {
                return Err(error(
                    "revision_conflict",
                    "Project changed. Inspect the current revision before retrying.",
                ));
            }
        }
        Operation::ReadFile {
            id,
            offset: _,
            limit,
        } => {
            if !valid_id(id) || *limit == 0 || *limit > 1024 * 1024 {
                return Err(commands::Error::invalid(
                    "Read a live file in chunks of at most 1,048,576 UTF-16 units.",
                ));
            }
        }
        Operation::Search { query, .. } => {
            if query.is_empty() || query.len() > 4096 {
                return Err(commands::Error::invalid(
                    "Search requires a query of at most 4 KiB.",
                ));
            }
        }
        Operation::Cancel { request_id } => {
            if !valid_id(request_id) {
                return Err(commands::Error::invalid("Invalid cancellation target."));
            }
        }
        _ => {}
    }
    Ok(())
}
#[derive(Serialize)]
pub struct Received {
    pub request: Request,
    pub error: Option<commands::Error>,
}
/// Consume an authenticated sequenced frame independently of operation success.
pub fn receive(json: &str, context: &str) -> Result<Received, commands::Error> {
    if json.len() > MAX_REQUEST || context.len() > 8192 {
        return Err(commands::Error::invalid(
            "Companion request exceeds its size bound.",
        ));
    }
    let request: Request =
        serde_json::from_str(json).map_err(|e| commands::Error::invalid(e.to_string()))?;
    let context: Context =
        serde_json::from_str(context).map_err(|e| commands::Error::invalid(e.to_string()))?;
    validate_envelope(&request, &context)?;
    let error = validate_operation(&request, &context).err();
    Ok(Received { request, error })
}
pub fn parse(json: &str, context: &str) -> Result<Request, commands::Error> {
    if json.len() > MAX_REQUEST || context.len() > 8192 {
        return Err(commands::Error::invalid(
            "Companion request exceeds its size bound.",
        ));
    }
    let request =
        serde_json::from_str(json).map_err(|e| commands::Error::invalid(e.to_string()))?;
    let context =
        serde_json::from_str(context).map_err(|e| commands::Error::invalid(e.to_string()))?;
    validate(&request, &context)?;
    Ok(request)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn grants_scope_sequences_revisions_and_closed_messages_are_independent() {
        let mut context = Context {
            project_id: "p".into(),
            session_id: "s".into(),
            next_sequence: 1,
            revision: "now".into(),
            permissions: Permissions {
                read: true,
                write: false,
                compile: false,
                export: false,
            },
        };
        let mut request = Request {
            version: 1,
            request_id: "r".into(),
            project_id: "p".into(),
            session_id: "s".into(),
            sequence: 1,
            operation: Operation::Inspect {},
            telemetry: None,
        };
        validate(&request, &context).unwrap();
        let legacy = serde_json::to_value(&request).unwrap();
        assert!(legacy.get("telemetry").is_none());
        let valid = serde_json::json!({"traceId":"a".repeat(32),"spanId":"b".repeat(16)});
        for metadata in [
            valid.clone(),
            serde_json::json!({"traceId":"PRIVATE_SOURCE"}),
            serde_json::json!({"traceId":"a".repeat(32),"spanId":"b".repeat(16),"token":"SECRET"}),
            serde_json::json!(42),
            serde_json::Value::Null,
        ] {
            let mut packet = legacy.clone();
            packet["telemetry"] = metadata.clone();
            let parsed = parse(
                &packet.to_string(),
                &serde_json::to_string(&context).unwrap(),
            )
            .unwrap();
            assert_eq!(parsed.telemetry.is_some(), metadata == valid);
        }
        request.telemetry = Some(crate::telemetry::TraceContext {
            trace_id: "a".repeat(32),
            span_id: "b".repeat(16),
        });
        request.project_id = "other".into();
        assert_eq!(
            validate(&request, &context).unwrap_err().code,
            "permission_denied"
        );
        request.project_id = "p".into();
        request.sequence = 2;
        assert_eq!(
            validate(&request, &context).unwrap_err().code,
            "sequence_conflict"
        );
        request.sequence = 1;
        request.operation = Operation::Compile {
            expected_revision: "now".into(),
        };
        assert_eq!(
            validate(&request, &context).unwrap_err().code,
            "permission_denied"
        );
        context.permissions.compile = true;
        validate(&request, &context).unwrap();
        context.revision = "later".into();
        assert_eq!(
            validate(&request, &context).unwrap_err().code,
            "revision_conflict"
        );
        let mut json = serde_json::to_value(&request).unwrap();
        json["permissions"] = serde_json::json!({"write":true});
        assert!(parse(&json.to_string(), &serde_json::to_string(&context).unwrap()).is_err());
    }
}
