//! Shared outbound MCP permissions and bounded operations. Provider output is data.
use crate::commands::Error;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
pub const MAX_REQUEST: usize = 1024 * 1024;
pub const MAX_RESULT: usize = 8 * 1024 * 1024;
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Permissions {
    pub tools: bool,
    pub resources: bool,
    pub prompts: bool,
}
impl Permissions {
    pub fn validate(&self) -> Result<(), Error> {
        if self.tools || self.resources || self.prompts {
            Ok(())
        } else {
            Err(Error::invalid("Select at least one provider capability."))
        }
    }
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(tag = "method", deny_unknown_fields)]
pub enum Operation {
    #[serde(rename = "tools/list")]
    Tools { cursor: Option<String> },
    #[serde(rename = "tools/call")]
    Call {
        name: String,
        arguments: Map<String, Value>,
    },
    #[serde(rename = "resources/list")]
    Resources { cursor: Option<String> },
    #[serde(rename = "resources/templates/list")]
    Templates { cursor: Option<String> },
    #[serde(rename = "resources/read")]
    Read { uri: String },
    #[serde(rename = "prompts/list")]
    Prompts { cursor: Option<String> },
    #[serde(rename = "prompts/get")]
    Prompt {
        name: String,
        arguments: Map<String, Value>,
    },
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Request {
    pub version: u8,
    pub id: String,
    pub operation: Operation,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::telemetry::deserialize_context"
    )]
    pub telemetry: Option<crate::telemetry::TraceContext>,
}
fn bounded(value: &str, max: usize) -> bool {
    !value.is_empty() && value.len() <= max && !value.chars().any(char::is_control)
}
impl Request {
    pub fn validate(&self, permissions: &Permissions) -> Result<(), Error> {
        if self.version != 1 || !bounded(&self.id, 128) {
            return Err(Error::invalid("Unsupported provider request or identity."));
        }
        let (allowed, argument) = match &self.operation {
            Operation::Tools { cursor } => (permissions.tools, cursor.as_deref()),
            Operation::Resources { cursor } | Operation::Templates { cursor } => {
                (permissions.resources, cursor.as_deref())
            }
            Operation::Prompts { cursor } => (permissions.prompts, cursor.as_deref()),
            Operation::Call { name, .. } => (permissions.tools, Some(name.as_str())),
            Operation::Read { uri } => (permissions.resources, Some(uri.as_str())),
            Operation::Prompt { name, arguments } => {
                if arguments.values().any(|v| !v.is_string()) {
                    return Err(Error::invalid("MCP prompt arguments must be strings."));
                }
                (permissions.prompts, Some(name.as_str()))
            }
        };
        if !allowed {
            return Err(Error {
                code: "permission_denied",
                message: "This provider capability was not granted.".into(),
            });
        }
        if argument.is_some_and(|value| !bounded(value, 8192)) {
            return Err(Error::invalid(
                "Provider name, URI or cursor is invalid or too long.",
            ));
        }
        let mut payload;
        let bounded = if self.telemetry.is_some() {
            payload = self.clone();
            payload.telemetry = None;
            &payload
        } else {
            self
        };
        if serde_json::to_vec(bounded)
            .map_err(|_| Error::invalid("Invalid provider JSON."))?
            .len()
            > MAX_REQUEST
        {
            return Err(Error::invalid("Provider requests are limited to 1 MiB."));
        }
        Ok(())
    }
}
pub fn parse(input: &str, permissions: &str) -> Result<Request, Error> {
    if input.len() > MAX_REQUEST || permissions.len() > 4096 {
        return Err(Error::invalid("Provider request exceeds its size bound."));
    }
    let request: Request = serde_json::from_str(input)
        .map_err(|_| Error::invalid("Invalid provider request schema."))?;
    let permissions: Permissions = serde_json::from_str(permissions)
        .map_err(|_| Error::invalid("Invalid provider permissions."))?;
    permissions.validate()?;
    request.validate(&permissions)?;
    Ok(request)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn outbound_permissions_do_not_authorize_other_capabilities_or_raw_rpc() {
        let grant = r#"{"tools":true,"resources":false,"prompts":false}"#;
        assert!(parse(r#"{"version":1,"id":"a","operation":{"method":"tools/call","name":"echo","arguments":{"source":"explicitly selected"}}}"#,grant).is_ok());
        assert_eq!(parse(r#"{"version":1,"id":"a","operation":{"method":"resources/read","uri":"file:///private"}}"#,grant).unwrap_err().code,"permission_denied");
        assert!(
            parse(
                r#"{"version":1,"id":"a","operation":{"method":"sampling/createMessage"}}"#,
                grant
            )
            .is_err()
        );
        assert!(
            parse(
                r#"{"version":1,"id":"a","operation":{"method":"tools/list","extra":true}}"#,
                grant
            )
            .is_err()
        );
        assert!(parse(r#"{"version":1,"id":"a","operation":{"method":"prompts/get","name":"x","arguments":{"x":42}}}"#,r#"{"tools":false,"resources":false,"prompts":true}"#).is_err());
    }
}
