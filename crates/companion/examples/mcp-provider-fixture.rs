//! Public development-only server. It rejects legacy initialization so client
//! acceptance cannot pass by accidentally using the older handshake.
use rmcp::{
    ErrorData, RoleServer, ServerHandler, ServiceExt,
    model::{
        CallToolRequestParams, CallToolResponse, CallToolResult, ContentBlock, Implementation,
        ListToolsResult, PaginatedRequestParams, ProtocolVersion, ServerCapabilities, ServerConfig,
        Tool,
    },
    service::RequestContext,
    transport::async_rw::AsyncRwTransport,
};
use serde_json::json;
use std::{borrow::Cow, io::Write, sync::Arc};
struct Fixture;
impl ServerHandler for Fixture {
    fn supported_protocol_versions(&self) -> Cow<'static, [ProtocolVersion]> {
        Cow::Owned(vec![ProtocolVersion::V_2026_07_28])
    }
    fn get_info(&self) -> ServerConfig {
        ServerConfig::new(ServerCapabilities::builder().enable_tools().build())
            .with_server_info(Implementation::new("Public modern stdio fixture", "1.0.0"))
    }
    async fn list_tools(
        &self,
        _: Option<PaginatedRequestParams>,
        _: RequestContext<RoleServer>,
    ) -> Result<ListToolsResult, ErrorData> {
        Ok(ListToolsResult {
            tools: vec![Tool::new(
                "modern_echo",
                "Echo public reviewed arguments.",
                Arc::new(
                    json!({"type":"object","additionalProperties":true})
                        .as_object()
                        .unwrap()
                        .clone(),
                ),
            )],
            ..Default::default()
        })
    }
    async fn call_tool(
        &self,
        request: CallToolRequestParams,
        context: RequestContext<RoleServer>,
    ) -> Result<CallToolResponse, ErrorData> {
        let version = context.meta.protocol_version().map(|v| v.to_string());
        let value = json!({"arguments":request.arguments,"protocolVersion":version});
        let mut result = CallToolResult::success(vec![ContentBlock::text(value.to_string())]);
        result.structured_content = Some(value);
        Ok(result.into())
    }
}
#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    if let Some(path) = std::env::var_os("SCRIBYRA_FIXTURE_PID_FILE") {
        writeln!(
            std::fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(path)?,
            "{}",
            std::process::id()
        )?;
    }
    Fixture
        .serve(AsyncRwTransport::<RoleServer, _, _>::new(
            tokio::io::stdin(),
            tokio::io::stdout(),
        ))
        .await?
        .waiting()
        .await?;
    Ok(())
}
