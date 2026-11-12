use crate::hub::{Error, Hub, Result};
use rmcp::{
    Peer, RoleClient,
    model::{ClientConfig, ProtocolVersion},
    service::{ClientLifecycleMode, ClientServiceExt},
    transport::async_rw::AsyncRwTransport,
};
use scribyra_core::providers::{Operation, Permissions, Request};
use serde::Deserialize;
use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, BTreeSet},
    path::{Path, PathBuf},
    process::Stdio,
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio_util::{sync::CancellationToken, task::TaskTracker};

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Configuration {
    version: u8,
    providers: Vec<Definition>,
}
#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Definition {
    id: String,
    name: String,
    command: String,
    #[serde(default)]
    args: Vec<String>,
    #[serde(default)]
    env: BTreeMap<String, String>,
    cwd: Option<PathBuf>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Connect {
    pub connection_id: String,
    pub provider_id: String,
    pub permissions: Permissions,
}
struct Session {
    scope: String,
    permissions: Permissions,
    stop: CancellationToken,
    peer: Mutex<Option<Peer<RoleClient>>>,
    used: Mutex<BTreeSet<String>>,
    pending: Mutex<BTreeMap<String, CancellationToken>>,
}
#[derive(Clone)]
pub struct Providers {
    tasks: TaskTracker,
    definitions: Arc<Vec<Definition>>,
    sessions: Arc<Mutex<BTreeMap<String, Arc<Session>>>>,
}
fn invalid(message: &str) -> Error {
    Error::new("invalid_request", message)
}
fn denied() -> Error {
    Error::new(
        "permission_denied",
        "This provider connection is closed or belongs to another pairing.",
    )
}
impl Providers {
    pub fn load(path: Option<&str>) -> std::result::Result<Self, Box<dyn std::error::Error>> {
        let definitions = if let Some(path) = path {
            let bytes = std::fs::read(path)?;
            if bytes.len() > 1024 * 1024 {
                return Err("Provider configuration exceeds 1 MiB".into());
            }
            let config: Configuration = serde_json::from_slice(&bytes)?;
            if config.version != 1 || config.providers.len() > 16 {
                return Err(
                    "Unsupported provider configuration version or more than sixteen definitions"
                        .into(),
                );
            }
            let mut ids = BTreeSet::new();
            for p in &config.providers {
                if p.id.is_empty()
                    || p.id.len() > 64
                    || !p
                        .id
                        .bytes()
                        .all(|b| b.is_ascii_alphanumeric() || b"_-".contains(&b))
                    || !ids.insert(p.id.clone())
                    || p.name.is_empty()
                    || p.name.len() > 160
                    || p.name.chars().any(char::is_control)
                    || p.command.is_empty()
                    || p.command.contains('\0')
                    || (!Path::new(&p.command).is_absolute()
                        && Path::new(&p.command).components().count() != 1)
                    || p.args.len() > 128
                    || p.args.iter().any(|arg| arg.contains('\0'))
                    || p.env.len() > 128
                    || p.env.iter().any(|(key, value)| {
                        key.is_empty() || key.contains(['\0', '=']) || value.contains('\0')
                    })
                    || p.cwd.as_ref().is_some_and(|p| !p.is_absolute())
                {
                    return Err("Invalid provider identity, command, arguments, environment or working directory".into());
                }
            }
            config.providers
        } else {
            vec![]
        };
        Ok(Self {
            tasks: TaskTracker::new(),
            definitions: Arc::new(definitions),
            sessions: Default::default(),
        })
    }
    pub fn definitions(&self) -> Value {
        json!({"providers":self.definitions.iter().map(|d|json!({"id":d.id,"name":d.name,"transport":"stdio","command":d.command})).collect::<Vec<_>>()})
    }
    fn session(&self, id: &str, scope: &str) -> Result<Arc<Session>> {
        self.sessions
            .lock()
            .unwrap()
            .get(id)
            .filter(|s| s.scope == scope && !s.stop.is_cancelled())
            .cloned()
            .ok_or_else(denied)
    }
    pub async fn connect(&self, scope: String, input: Connect, hub: &Hub) -> Result<Value> {
        let mut observation =
            crate::telemetry::begin(scribyra_core::telemetry::Operation::Provider);
        let result = self.connect_inner(scope, input, hub).await;
        match &result {
            Ok(_) => observation.success(),
            Err(error) => observation.error(&error.code),
        };
        result
    }
    async fn connect_inner(&self, scope: String, input: Connect, hub: &Hub) -> Result<Value> {
        input
            .permissions
            .validate()
            .map_err(|e| invalid(&e.message))?;
        let definition = self
            .definitions
            .iter()
            .find(|d| d.id == input.provider_id)
            .ok_or_else(|| {
                invalid("Choose a provider configured by the local companion operator.")
            })?;
        hub.scope(&scope)?;
        let session = Arc::new(Session {
            scope: scope.clone(),
            permissions: input.permissions,
            stop: CancellationToken::new(),
            peer: Mutex::new(None),
            used: Default::default(),
            pending: Default::default(),
        });
        let id = uuid::Uuid::parse_str(&input.connection_id)
            .map_err(|_| invalid("Use a fresh UUID for the provider connection."))?
            .to_string();
        {
            let mut all = self.sessions.lock().unwrap();
            if all.contains_key(&id) {
                return Err(invalid("Provider connection ID already exists."));
            }
            if all.len() >= 16 || all.values().filter(|s| s.scope == scope).count() >= 4 {
                return Err(Error::new(
                    "session_limit",
                    "At most four providers per pairing and sixteen per companion may be connected.",
                ));
            }
            all.insert(id.clone(), session.clone());
        }
        let mut command = tokio::process::Command::new(&definition.command);
        command
            .args(&definition.args)
            .env_clear()
            .kill_on_drop(true);
        for key in ["PATH", "SystemRoot", "TEMP", "TMP"] {
            if let Some(value) = std::env::var_os(key) {
                command.env(key, value);
            }
        }
        command.envs(&definition.env);
        if let Some(cwd) = &definition.cwd {
            command.current_dir(cwd);
        }
        let startup = async {
            let mut child = command
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::null())
                .spawn()
                .map_err(|_| {
                    Error::new(
                        "provider_unavailable",
                        "Cannot start the configured provider. Check its command and environment.",
                    )
                })?;
            let read = child
                .stdout
                .take()
                .ok_or_else(|| invalid("Provider stdout is unavailable."))?;
            let write = child
                .stdin
                .take()
                .ok_or_else(|| invalid("Provider stdin is unavailable."))?;
            let stop = session.stop.clone();
            self.tasks.spawn(async move {
                tokio::select! {
                    _=stop.cancelled()=>{if tokio::time::timeout(Duration::from_secs(3),child.wait()).await.is_err(){let _=child.kill().await;}},
                    _=child.wait()=>{},
                }
                stop.cancel();
            });
            let transport = AsyncRwTransport::<RoleClient, _, _>::new(read, write);
            ClientConfig::default()
                .serve_with_lifecycle(transport, ClientLifecycleMode::Auto {
                    preferred_versions:vec![ProtocolVersion::V_2026_07_28],
                    legacy_version:Some(ProtocolVersion::V_2025_11_25),
                })
                .await.map_err(|_| {
                Error::new(
                    "provider_unavailable",
                    "The provider did not complete MCP initialization. Check its configuration.",
                )
            })
        };
        let service = tokio::select! {
            result=tokio::time::timeout(Duration::from_secs(20),startup)=>result.unwrap_or_else(|_|Err(Error::new("timeout","Provider initialization timed out."))),
            _=session.stop.cancelled()=>Err(denied()),
        };
        let service = match service {
            Ok(s) => s,
            Err(error) => {
                self.disconnect(&id, &scope).ok();
                return Err(error);
            }
        };
        let peer = service.peer().clone();
        let info = peer.peer_info();
        *session.peer.lock().unwrap() = Some(peer);
        let control = service.cancellation_token();
        let stop = session.stop.clone();
        self.tasks.spawn(async move {
            let ended = service.waiting();
            tokio::pin!(ended);
            tokio::select! {_=stop.cancelled()=>{control.cancel();let _=ended.await;},_= &mut ended=>{}}
            stop.cancel();
        });
        if hub.scope(&scope).is_err() || session.stop.is_cancelled() {
            self.disconnect(&id, &scope).ok();
            return Err(denied());
        }
        Ok(
            json!({"id":id,"providerId":definition.id,"name":definition.name,"transport":"stdio","permissions":session.permissions,"info":info}),
        )
    }
    pub fn disconnect(&self, id: &str, scope: &str) -> Result<()> {
        let mut sessions = self.sessions.lock().unwrap();
        if !sessions.get(id).is_some_and(|s| s.scope == scope) {
            return Err(denied());
        }
        if let Some(session) = sessions.remove(id) {
            session.stop.cancel();
        }
        Ok(())
    }
    pub fn sweep(&self, hub: &Hub) {
        self.sessions.lock().unwrap().retain(|_, s| {
            if hub.scope(&s.scope).is_err() {
                s.stop.cancel();
            }
            !s.stop.is_cancelled()
        });
    }
    pub async fn shutdown(&self) {
        for (_, s) in std::mem::take(&mut *self.sessions.lock().unwrap()) {
            s.stop.cancel();
        }
        self.tasks.close();
        self.tasks.wait().await;
    }
    pub fn cancel(&self, id: &str, scope: &str, request: &str) -> Result<()> {
        let session = self.session(id, scope)?;
        if let Some(token) = session.pending.lock().unwrap().get(request) {
            token.cancel();
        }
        Ok(())
    }
    pub async fn request(
        &self,
        id: &str,
        scope: &str,
        request: Request,
        hub: &Hub,
    ) -> Result<Value> {
        let mut observation = if let Some(parent) = request.telemetry.as_ref() {
            scribyra_core::telemetry::native::global()
                .begin(scribyra_core::telemetry::Operation::Provider, Some(parent))
        } else {
            crate::telemetry::begin(scribyra_core::telemetry::Operation::Provider)
        };
        let result = self.request_inner(id, scope, request, hub).await;
        match &result {
            Ok(value) if value["isError"].as_bool() == Some(true) => {
                observation.error("provider_error")
            }
            Ok(_) => observation.success(),
            Err(error) => observation.error(&error.code),
        };
        result
    }
    async fn request_inner(
        &self,
        id: &str,
        scope: &str,
        request: Request,
        hub: &Hub,
    ) -> Result<Value> {
        hub.scope(scope)?;
        let session = self.session(id, scope)?;
        request
            .validate(&session.permissions)
            .map_err(|e| Error::new(e.code, &e.message))?;
        let peer =
            session.peer.lock().unwrap().clone().ok_or_else(|| {
                Error::new("provider_busy", "Provider initialization is pending.")
            })?;
        let cancel = CancellationToken::new();
        {
            let mut pending = session.pending.lock().unwrap();
            if pending.len() >= 4 {
                return Err(Error::new(
                    "provider_busy",
                    "At most four provider requests may be active.",
                ));
            }
            let mut used = session.used.lock().unwrap();
            if used.len() >= 4096 {
                return Err(Error::new(
                    "session_limit",
                    "Reconnect this provider after 4,096 requests.",
                ));
            }
            if !used.insert(request.id.clone()) {
                return Err(Error::new(
                    "replayed_request",
                    "This provider request ID was already submitted. Results may be uncertain after a network failure; review before trying a new request.",
                ));
            }
            pending.insert(request.id.clone(), cancel.clone());
        }
        struct Pending {
            session: Arc<Session>,
            id: String,
        }
        impl Drop for Pending {
            fn drop(&mut self) {
                self.session.pending.lock().unwrap().remove(&self.id);
            }
        }
        let _guard = Pending {
            session: session.clone(),
            id: request.id,
        };
        let execute = async {
            macro_rules! run {($method:ident,$params:expr)=>{{
                let params=serde_json::from_value($params).map_err(|_|invalid("Invalid provider parameters."))?;
                let result=peer.$method(params).await.map_err(|_|Error::new("provider_error","The provider rejected the request or disconnected. Its action may already have completed; inspect its state before retrying."))?;
                serde_json::to_value(result).map_err(|_|invalid("Provider returned invalid JSON."))?
            }};}
            macro_rules! complete {
                ($method:ident, $params:expr, $response:ident) => {{
                    let params=serde_json::from_value($params).map_err(|_|invalid("Invalid provider parameters."))?;
                    let result=peer.$method(params).await.map_err(|_|Error::new("provider_error","The provider rejected the request or disconnected. Inspect its state before retrying."))?;
                    match result {
                        rmcp::model::$response::Complete(value)=>serde_json::to_value(value).map_err(|_|invalid("Invalid provider JSON."))?,
                        _=>return Err(Error::new("unsupported_input","This provider requested interactive input or background tasks that this client has not granted.")),
                    }
                }};
            }
            let value = match request.operation {
                Operation::Tools { cursor } => run!(list_tools, json!({"cursor":cursor})),
                Operation::Resources { cursor } => run!(list_resources, json!({"cursor":cursor})),
                Operation::Templates { cursor } => {
                    run!(list_resource_templates, json!({"cursor":cursor}))
                }
                Operation::Prompts { cursor } => run!(list_prompts, json!({"cursor":cursor})),
                Operation::Call { name, arguments } => {
                    complete!(
                        call_tool_once,
                        json!({"name":name,"arguments":arguments}),
                        CallToolResponse
                    )
                }
                Operation::Read { uri } => {
                    complete!(read_resource_once, json!({"uri":uri}), ReadResourceResponse)
                }
                Operation::Prompt { name, arguments } => {
                    complete!(
                        get_prompt_once,
                        json!({"name":name,"arguments":arguments}),
                        GetPromptResponse
                    )
                }
            };
            if serde_json::to_vec(&value)
                .map_err(|_| invalid("Invalid provider result."))?
                .len()
                > scribyra_core::providers::MAX_RESULT
            {
                return Err(Error::new(
                    "too_large",
                    "Provider results are limited to 8 MiB.",
                ));
            }
            Ok(value)
        };
        let value = tokio::select! {
            result=tokio::time::timeout(Duration::from_secs(120),execute)=>result.unwrap_or_else(|_|Err(Error::new("timeout","Provider request timed out. Its action may already have completed."))),
            _=cancel.cancelled()=>Err(Error::new("cancelled","Provider cancellation requested. Completed external actions cannot be undone by cancellation.")),
            _=session.stop.cancelled()=>Err(denied()),
        };
        hub.scope(scope)?;
        if session.stop.is_cancelled() {
            return Err(denied());
        }
        value
    }
}
