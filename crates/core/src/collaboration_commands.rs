//! Internal v2 envelope. Feature implementations own payload validation and dispatch.
use crate::collaboration_schema::{COMMAND_VERSION, RECEIPT_BYTES, Right, Rights};
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Request {
    pub version: u32,
    pub request_id: String,
    pub project_id: String,
    pub expected_revision: Option<String>,
    pub command: Value,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Context {
    pub project_id: String,
    pub revision: String,
    pub capabilities: Rights,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Receipt {
    pub version: u32,
    pub request_id: String,
    pub project_id: String,
    pub revision: String,
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub value: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<Error>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Error {
    pub code: String,
    pub message: String,
}
pub fn error(code: &str, message: &str) -> Error {
    Error {
        code: code.into(),
        message: message.into(),
    }
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Policy {
    pub namespace: &'static str,
    pub mutation: bool,
    pub capabilities: Vec<Right>,
}
pub fn policy(op: &str) -> Result<Policy, Error> {
    use Right::*;
    let (namespace, mutation, capabilities) = match op {
        "agent.status" | "agent.tree" | "agent.readSource" | "agent.poll" | "agent.diagnostics" => {
            ("agent", false, vec![Read])
        }
        "agent.patchSource" => ("agent", true, vec![Edit]),
        "agent.compile" | "agent.cancel" => ("agent", true, vec![Read]),
        "agent.exportPdf" => ("agent", true, vec![Read, Export]),
        "thread.list" | "thread.get" => ("comments", false, vec![Read]),
        "thread.create" | "thread.reply" | "message.edit" | "message.redact" | "thread.resolve"
        | "thread.reopen" | "anchor.reattach" => ("comments", true, vec![Comment]),
        "review.list" | "review.get" => ("reviews", false, vec![Read]),
        "review.create"
        | "review.submit"
        | "review.close"
        | "suggestion.propose"
        | "suggestion.revise"
        | "suggestion.reject"
        | "suggestion.withdraw" => ("reviews", true, vec![Review]),
        "suggestion.accept" => ("reviews", true, vec![Edit, Review]),
        "change.undo" | "change.redo" => ("changes", true, vec![]), // Original operation rights are rechecked by its handler.
        "review.preview" => ("reviews", false, vec![Read, Review]),
        "review.export" => ("reviews", false, vec![Read, Export]),
        "review.importPlan" | "review.import" => ("reviews", true, vec![Review]),
        "history.list" | "history.diff" => ("history", false, vec![Read]),
        "history.name"
        | "history.unpin"
        | "history.compactPlan"
        | "history.compact"
        | "history.restorePlan"
        | "history.restore" => ("history", true, vec![History]),
        "backup.export" | "artifact.read" => ("history", false, vec![Read, Export]),
        "backup.importPlan" | "backup.import" => ("history", true, vec![History]),
        _ => {
            return Err(error(
                "unsupported_command",
                "Unsupported collaboration command.",
            ));
        }
    };
    Ok(Policy {
        namespace,
        mutation,
        capabilities,
    })
}
pub fn validate(request: &str, context: &str) -> Result<(Request, Policy), Error> {
    if request.len() > 2 * 1024 * 1024 {
        return Err(error("invalid_request", "Command is too large."));
    }
    let request: Request = serde_json::from_str(request)
        .map_err(|_| error("invalid_request", "Invalid v2 envelope."))?;
    let context: Context = serde_json::from_str(context)
        .map_err(|_| error("invalid_request", "Invalid trusted context."))?;
    if request.version != COMMAND_VERSION {
        return Err(error("unsupported_version", "Unsupported command version."));
    }
    if request.request_id.is_empty()
        || request.request_id.len() > 256
        || request.project_id.len() > 256
    {
        return Err(error("invalid_request", "Invalid request identity."));
    }
    if request.project_id != context.project_id {
        return Err(error("permission_denied", "Project access denied."));
    }
    let policy = policy(
        request.command["op"]
            .as_str()
            .ok_or_else(|| error("invalid_request", "Missing operation."))?,
    )?;
    if policy.namespace == "agent" {
        crate::agent::validate(&request.command)?;
    }
    if policy
        .capabilities
        .iter()
        .any(|right| !context.capabilities.contains(right))
    {
        return Err(error(
            "permission_denied",
            "Required collaboration capability is not granted.",
        ));
    }
    if policy.mutation && request.expected_revision.is_none() {
        return Err(error(
            "revision_required",
            "Every mutation requires a revision.",
        ));
    }
    if request
        .expected_revision
        .as_ref()
        .is_some_and(|r| r != &context.revision)
    {
        return Err(error(
            "revision_conflict",
            "Project changed; read a fresh revision.",
        ));
    }
    Ok((request, policy))
}
pub fn dispatch(request: &Request) -> Result<Value, Error> {
    match policy(request.command["op"].as_str().unwrap_or(""))?.namespace {
        "comments" => crate::comments::dispatch(&request.command),
        "reviews" => crate::reviews::dispatch(&request.command),
        "history" => crate::history::dispatch(&request.command),
        _ => Err(error(
            "unsupported_command",
            "This feature is not implemented.",
        )),
    }
}
pub fn validate_value(value: &Value) -> Result<(), Error> {
    if value["valueVersion"] != 1
        || serde_json::to_vec(value).map_or(true, |v| v.len() > RECEIPT_BYTES)
    {
        return Err(error("invalid_request", "Invalid or oversized v2 value."));
    }
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rights_and_stub_dispatch() {
        let request = r#"{"version":2,"requestId":"r","projectId":"p","expectedRevision":"r0","command":{"op":"suggestion.accept"}}"#;
        assert_eq!(
            validate(
                request,
                r#"{"projectId":"p","revision":"r0","capabilities":["review"]}"#
            )
            .unwrap_err()
            .code,
            "permission_denied"
        );
        let (request, _) = validate(
            request,
            r#"{"projectId":"p","revision":"r0","capabilities":["review","edit"]}"#,
        )
        .unwrap();
        assert_eq!(dispatch(&request).unwrap_err().code, "unsupported_command");
    }
}
