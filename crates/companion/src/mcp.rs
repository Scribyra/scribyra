use crate::hub::{Error, Hub, Result};
use base64::{Engine, engine::general_purpose::STANDARD};
use rmcp::{ErrorData as McpError, RoleServer, ServerHandler, model::*, service::RequestContext};
use scribyra_core::{
    commands::{self, Command, Edit, Entry},
    companion::Operation,
};
use serde::Deserialize;
use serde_json::{Map, Value, json};
use std::sync::Arc;
#[derive(Clone)]
pub struct Mcp {
    pub hub: Hub,
}
fn rpc(error: Error) -> McpError {
    McpError::invalid_params(error.message, Some(json!({"code":error.code})))
}
fn invalid(message: &str) -> Error {
    Error::new("invalid_request", message)
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Create {
    request_id: String,
    expected_revision: String,
    path: String,
    content: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Patch {
    request_id: String,
    expected_revision: String,
    edits: Vec<Edit>,
}
fn parse<T: serde::de::DeserializeOwned>(value: Value) -> Result<T> {
    serde_json::from_value(value)
        .map_err(|_| invalid("Tool arguments do not match the declared schema."))
}
fn required() -> Vec<String> {
    vec!["projectId".into()]
}
fn definition(
    name: &str,
    description: &str,
    properties: Value,
    fields: &[&str],
    read_only: bool,
) -> Tool {
    let mut properties = properties.as_object().unwrap().clone();
    properties.insert(
        "projectId".into(),
        json!({"type":"string","description":"The project ID returned by inspect_project."}),
    );
    let mut required = required();
    required.extend(fields.iter().map(|s| s.to_string()));
    let mut tool=Tool::new(name.to_string(),description.to_string(),Arc::new(json!({"type":"object","properties":properties,"required":required,"additionalProperties":false}).as_object().unwrap().clone()));
    tool.annotations = Some(
        serde_json::from_value(
            json!({"readOnlyHint":read_only,"destructiveHint":!read_only,"openWorldHint":false}),
        )
        .unwrap(),
    );
    tool
}
impl Mcp {
    fn grant(&self, ctx: &RequestContext<RoleServer>) -> Result<String> {
        let token = ctx
            .extensions
            .get::<axum::http::request::Parts>()
            .and_then(|p| p.headers.get("authorization"))
            .and_then(|h| h.to_str().ok())
            .and_then(|s| s.strip_prefix("Bearer "))
            .ok_or_else(|| Error::new("permission_denied", "MCP credential is missing."))?;
        self.hub.client(token)
    }
    async fn operation(
        &self,
        id: &str,
        name: &str,
        mut args: Map<String, Value>,
        ctx: &RequestContext<RoleServer>,
    ) -> Result<Value> {
        let (project, _) = self.hub.scope(id)?;
        if name == "inspect_project" {
            if !args.is_empty() {
                return Err(invalid("inspect_project takes no arguments."));
            }
            return self
                .hub
                .request(id, Operation::Inspect {}, ctx.ct.clone())
                .await;
        }
        if args.remove("projectId").as_ref().and_then(Value::as_str) != Some(project.as_str()) {
            return Err(Error::new(
                "permission_denied",
                "This tool is scoped to a different project.",
            ));
        }
        if name == "read_artifact" {
            let artifact = args
                .remove("id")
                .and_then(|v| v.as_str().map(str::to_string))
                .ok_or_else(|| invalid("An artifact ID is required."))?;
            let offset = args
                .remove("offset")
                .unwrap_or(json!(0))
                .as_u64()
                .ok_or_else(|| invalid("Artifact offset must be a nonnegative integer."))?;
            let limit = args
                .remove("limit")
                .unwrap_or(json!(65536))
                .as_u64()
                .filter(|n| *n > 0 && *n <= 65536)
                .ok_or_else(|| invalid("Artifact chunks are limited to 65,536 bytes."))?;
            if !args.is_empty() {
                return Err(invalid("Unexpected artifact arguments."));
            }
            let artifact = self.hub.artifact(id, &artifact)?;
            if offset > artifact.bytes.len() as u64 {
                return Err(invalid("Artifact offset is outside the export."));
            }
            let end = (offset + limit).min(artifact.bytes.len() as u64) as usize;
            let mut result = artifact.metadata;
            result["offset"] = offset.into();
            result["nextOffset"] = end.into();
            result["eof"] = (end == artifact.bytes.len()).into();
            result["data"] = STANDARD
                .encode(&artifact.bytes[offset as usize..end])
                .into();
            return Ok(result);
        }
        let operation = match name {
            "create_file" => {
                let a: Create = parse(args.into())?;
                Operation::Command {
                    request: commands::Request {
                        version: 1,
                        request_id: a.request_id,
                        project_id: project,
                        expected_revision: Some(a.expected_revision),
                        command: Command::Add {
                            entries: vec![Entry::Text {
                                id: None,
                                path: a.path,
                                content: a.content,
                            }],
                        },
                    },
                }
            }
            "patch_text" => {
                let a: Patch = parse(args.into())?;
                Operation::Command {
                    request: commands::Request {
                        version: 1,
                        request_id: a.request_id,
                        project_id: project,
                        expected_revision: Some(a.expected_revision),
                        command: Command::Patch { edits: a.edits },
                    },
                }
            }
            "read_file" | "search_project" | "compile_project" | "export_project" => {
                let kind = match name {
                    "read_file" => "read-file",
                    "search_project" => "search",
                    "compile_project" => "compile",
                    _ => "export",
                };
                if name == "read_file" {
                    args.entry("offset").or_insert(json!(0));
                    args.entry("limit").or_insert(json!(65536));
                }
                if name == "search_project" {
                    for field in ["caseSensitive", "wholeWord", "regexMode"] {
                        args.entry(field).or_insert(json!(false));
                    }
                }
                args.insert("kind".into(), kind.into());
                parse(args.into())?
            }
            _ => return Err(invalid("Unknown Scribyra tool.")),
        };
        let export = matches!(operation, Operation::Export { .. });
        let result = self.hub.request(id, operation, ctx.ct.clone()).await?;
        if export {
            self.hub.store_artifact(id, result)
        } else {
            Ok(result)
        }
    }
}
impl ServerHandler for Mcp {
    fn get_info(&self) -> ServerConfig {
        ServerConfig::new(ServerCapabilities::builder().enable_resources().enable_tools().build())
            .with_server_info(Implementation::from_build_env())
            .with_instructions("Access only the browser project explicitly paired with this credential. Inspect its current revision before editing or compiling. Writes need a stable requestId and expectedRevision; retry the same ID only for the same transaction. Source offsets are UTF-16. Compilation requires the connected browser runtime. Export links require this credential and expire on revocation, disconnect or after 15 minutes.".to_string())
    }
    async fn list_tools(
        &self,
        _: Option<PaginatedRequestParams>,
        ctx: RequestContext<RoleServer>,
    ) -> std::result::Result<ListToolsResult, McpError> {
        let id = self.grant(&ctx).map_err(rpc)?;
        let (_, permissions) = self.hub.scope(&id).map_err(rpc)?;
        let string = json!({"type":"string"});
        let mut tools = vec![
            Tool::new(
                "inspect_project",
                "Inspect the authorized project, file identities and current revision.",
                Arc::new(
                    json!({"type":"object","properties":{},"additionalProperties":false})
                        .as_object()
                        .unwrap()
                        .clone(),
                ),
            ),
            definition(
                "read_file",
                "Read source in bounded UTF-16 chunks; binary files return metadata.",
                json!({"id":string,"offset":{"type":"integer","minimum":0},"limit":{"type":"integer","minimum":1,"maximum":1048576}}),
                &["id"],
                true,
            ),
            definition(
                "search_project",
                "Search live project source using Scribyra's Rust search engine.",
                json!({"query":string,"caseSensitive":{"type":"boolean"},"wholeWord":{"type":"boolean"},"regexMode":{"type":"boolean"}}),
                &["query"],
                true,
            ),
        ];
        if permissions.write {
            tools.push(definition("create_file","Create a text file atomically in the active browser project.",json!({"requestId":string,"expectedRevision":string,"path":string,"content":string}),&["requestId","expectedRevision","path","content"],false));
            tools.push(definition("patch_text","Apply an atomic, revision-checked source patch. Each before string must match exactly.",json!({"requestId":string,"expectedRevision":string,"edits":{"type":"array","minItems":1,"maxItems":2000,"items":{"type":"object","properties":{"fileId":string,"start":{"type":"integer","minimum":0},"end":{"type":"integer","minimum":0},"before":string,"after":string},"required":["fileId","start","end","before","after"],"additionalProperties":false}}}),&["requestId","expectedRevision","edits"],false));
        }
        if permissions.compile {
            tools.push(definition("compile_project","Compile the inspected project revision using the connected browser's LuaLaTeX runtime. Cancellation affects only this request's build.",json!({"expectedRevision":string}),&["expectedRevision"],false));
        }
        if permissions.export {
            tools.push(definition("export_project","Freeze a source ZIP or the available PDF and return a scoped, short-lived download link. Use the same Authorization header to download it.",json!({"expectedRevision":string,"format":{"type":"string","enum":["source","pdf"]}}),&["expectedRevision","format"],true));
            tools.push(definition(
                "read_artifact",
                "Read a bounded base64 byte chunk of an export created by this pairing. Repeat with nextOffset until eof, then verify its SHA-256.",
                json!({"id":string,"offset":{"type":"integer","minimum":0},"limit":{"type":"integer","minimum":1,"maximum":65536}}),
                &["id"],
                true,
            ));
        }
        Ok(ListToolsResult {
            tools,
            ..Default::default()
        })
    }
    async fn call_tool(
        &self,
        request: CallToolRequestParams,
        ctx: RequestContext<RoleServer>,
    ) -> std::result::Result<CallToolResponse, McpError> {
        let mut observation = crate::telemetry::begin(scribyra_core::telemetry::Operation::Mcp);
        let id = self.grant(&ctx).map_err(|error| {
            observation.error(&error.code);
            rpc(error)
        })?;
        match crate::telemetry::scope(
            observation.context(),
            self.operation(
                &id,
                &request.name,
                request.arguments.unwrap_or_default(),
                &ctx,
            ),
        )
        .await
        {
            Ok(value) => {
                observation.success();
                let text = value.to_string();
                let mut result = CallToolResult::success(vec![ContentBlock::text(text)]);
                result.structured_content = Some(value);
                Ok(result.into())
            }
            Err(error) => {
                observation.error(&error.code);
                Ok(CallToolResult::error(vec![ContentBlock::text(
                    serde_json::to_string(&error).unwrap(),
                )])
                .into())
            }
        }
    }
    async fn list_resources(
        &self,
        _: Option<PaginatedRequestParams>,
        ctx: RequestContext<RoleServer>,
    ) -> std::result::Result<ListResourcesResult, McpError> {
        let id = self.grant(&ctx).map_err(rpc)?;
        let (project, _) = self.hub.scope(&id).map_err(rpc)?;
        Ok(ListResourcesResult {
            resources: [
                ("tree", "Project tree and current revision"),
                ("bibliography", "Bibliography source files"),
                ("diagnostics", "Current browser diagnostics"),
                ("build", "Last browser build result"),
            ]
            .into_iter()
            .map(|(path, name)| Resource::new(format!("scribyra://{project}/{path}"), name))
            .collect(),
            ..Default::default()
        })
    }
    async fn list_resource_templates(
        &self,
        _: Option<PaginatedRequestParams>,
        ctx: RequestContext<RoleServer>,
    ) -> std::result::Result<ListResourceTemplatesResult, McpError> {
        let id = self.grant(&ctx).map_err(rpc)?;
        let (project, _) = self.hub.scope(&id).map_err(rpc)?;
        Ok(serde_json::from_value(json!({"resourceTemplates":[{"uriTemplate":format!("scribyra://{project}/files/{{fileId}}"),"name":"Project source file","mimeType":"text/plain"}]})).unwrap())
    }
    async fn read_resource(
        &self,
        request: ReadResourceRequestParams,
        ctx: RequestContext<RoleServer>,
    ) -> std::result::Result<ReadResourceResponse, McpError> {
        let id = self.grant(&ctx).map_err(rpc)?;
        let (project, _) = self.hub.scope(&id).map_err(rpc)?;
        let path = request
            .uri
            .strip_prefix(&format!("scribyra://{project}/"))
            .ok_or_else(|| {
                rpc(Error::new(
                    "permission_denied",
                    "Resource belongs to another project.",
                ))
            })?;
        let value = if let Some(artifact) = path.strip_prefix("artifacts/") {
            self.hub.artifact(&id, artifact).map_err(rpc)?.metadata
        } else {
            let operation = match path {
                "tree" => Operation::Inspect {},
                "bibliography" => Operation::Bibliography {},
                "diagnostics" => Operation::Diagnostics {},
                "build" => Operation::BuildResult {},
                _ => {
                    if let Some(file) = path.strip_prefix("files/") {
                        Operation::ReadFile {
                            id: file.into(),
                            offset: 0,
                            limit: 1024 * 1024,
                        }
                    } else {
                        return Err(McpError::resource_not_found(
                            "Unknown project resource",
                            None,
                        ));
                    }
                }
            };
            self.hub
                .request(&id, operation, ctx.ct.clone())
                .await
                .map_err(rpc)?
        };
        Ok(
            ReadResourceResult::new(vec![ResourceContents::text(value.to_string(), request.uri)])
                .into(),
        )
    }
}
