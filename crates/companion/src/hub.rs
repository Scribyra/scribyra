use base64::{Engine, engine::general_purpose::STANDARD};
use hmac::{Hmac, Mac};
use scribyra_core::companion::{Context, Operation, Permissions, Request};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use tokio::sync::{mpsc, oneshot};
use tokio_util::sync::CancellationToken;
pub type Result<T> = std::result::Result<T, Error>;
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Error {
    pub code: String,
    pub message: String,
}
impl Error {
    pub fn new(code: &str, message: &str) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
        }
    }
}
pub fn secret() -> String {
    format!(
        "{}{}",
        uuid::Uuid::new_v4().simple(),
        uuid::Uuid::new_v4().simple()
    )
}
fn key(value: &str) -> String {
    format!("{:x}", Sha256::digest(value.as_bytes()))
}
pub fn permission_flags(p: &Permissions) -> String {
    [p.read, p.write, p.compile, p.export]
        .into_iter()
        .map(|b| if b { '1' } else { '0' })
        .collect()
}
fn proof(secret: &str, message: &str) -> String {
    let mut mac = Hmac::<Sha256>::new_from_slice(secret.as_bytes()).unwrap();
    mac.update(message.as_bytes());
    mac.finalize()
        .into_bytes()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}
pub fn valid_secret(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
#[derive(Clone)]
pub struct Hub(pub Arc<Mutex<Store>>);
pub struct Store {
    pairing: String,
    nonces: BTreeMap<String, Instant>,
    grants: BTreeMap<String, Grant>,
    pub base: String,
}
pub struct Grant {
    pub id: String,
    pub project: String,
    origin: String,
    pub permissions: Permissions,
    browser: String,
    client: String,
    expires: Instant,
    connection: Option<String>,
    sender: Option<mpsc::Sender<String>>,
    sequence: u64,
    diagnostics: bool,
    pending: BTreeMap<String, oneshot::Sender<Result<Value>>>,
    artifacts: BTreeMap<String, Artifact>,
}
#[derive(Clone)]
pub struct Artifact {
    pub bytes: Arc<Vec<u8>>,
    pub metadata: Value,
    created: Instant,
}
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Pair {
    pub nonce: String,
    pub proof: String,
    pub project_id: String,
    pub permissions: Permissions,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Reply {
    version: u8,
    request_id: String,
    project_id: String,
    session_id: String,
    ok: bool,
    revision: String,
    value: Option<Value>,
    error: Option<Error>,
}
impl Hub {
    pub fn new(pairing: &str, base: String) -> Self {
        Self(Arc::new(Mutex::new(Store {
            pairing: key(pairing),
            nonces: BTreeMap::new(),
            grants: BTreeMap::new(),
            base,
        })))
    }
    pub fn pair(&self, input: Pair, origin: &str) -> Result<Value> {
        if !valid_secret(&input.nonce)
            || !valid_secret(&input.proof)
            || input.project_id.is_empty()
            || input.project_id.len() > 256
            || !input
                .project_id
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"_-".contains(&b))
            || !input.permissions.read
        {
            return Err(Error::new(
                "invalid_request",
                "Invalid pairing scope or permissions.",
            ));
        }
        let mut store = self.0.lock().unwrap();
        let flags = permission_flags(&input.permissions);
        let message = format!(
            "scribyra-browser-pair-v1\n{origin}\n{}\n{}\n{flags}",
            input.project_id, input.nonce
        );
        let expected = proof(&store.pairing, &message);
        let decoded = (0..64)
            .step_by(2)
            .map(|i| u8::from_str_radix(&input.proof[i..i + 2], 16).unwrap())
            .collect::<Vec<_>>();
        let mut mac = Hmac::<Sha256>::new_from_slice(store.pairing.as_bytes()).unwrap();
        mac.update(message.as_bytes());
        if mac.verify_slice(&decoded).is_err() {
            return Err(Error::new(
                "permission_denied",
                "Pairing code did not match. Check the companion terminal.",
            ));
        }
        debug_assert_eq!(expected, input.proof);
        store
            .nonces
            .retain(|_, time| time.elapsed() < Duration::from_secs(600));
        if store.nonces.contains_key(&input.nonce) {
            return Err(Error::new(
                "replayed_pairing",
                "Use a new pairing challenge.",
            ));
        }
        if store.nonces.len() >= 256 {
            return Err(Error::new(
                "session_limit",
                "Too many recent pairing attempts.",
            ));
        }
        store.nonces.insert(input.nonce.clone(), Instant::now());
        store.grants.retain(|_, g| g.expires > Instant::now());
        if store.grants.len() >= 16 {
            return Err(Error::new(
                "session_limit",
                "Revoke an existing pairing or restart the companion before pairing another session.",
            ));
        }
        let id = uuid::Uuid::new_v4().to_string();
        let browser = secret();
        let client = secret();
        let server_message = format!(
            "scribyra-companion-pair-v1\n{origin}\n{}\n{}\n{id}\n{browser}\n{client}\n{flags}\n{}/mcp",
            input.project_id, input.nonce, store.base
        );
        let server_proof = proof(&store.pairing, &server_message);
        let result = json!({"diagnosticsProtocol":1,"serverProof":server_proof,"version":1,"sessionId":id,"projectId":input.project_id,"permissions":input.permissions,"browserToken":browser,"clientToken":client,"mcpUrl":format!("{}/mcp",store.base)});
        store.grants.insert(
            id.clone(),
            Grant {
                id,
                project: input.project_id,
                origin: origin.into(),
                permissions: input.permissions,
                browser: key(&browser),
                client: key(&client),
                expires: Instant::now() + Duration::from_secs(30),
                connection: None,
                diagnostics: false,
                sender: None,
                sequence: 0,
                pending: BTreeMap::new(),
                artifacts: BTreeMap::new(),
            },
        );
        Ok(result)
    }
    fn lookup(store: &Store, token: &str, browser: bool) -> Result<String> {
        if !valid_secret(token) {
            return Err(Error::new(
                "permission_denied",
                "Companion credential is invalid or revoked.",
            ));
        }
        let hash = key(token);
        store
            .grants
            .values()
            .find(|g| {
                g.expires > Instant::now()
                    && if browser {
                        g.browser == hash
                    } else {
                        g.client == hash
                    }
            })
            .map(|g| g.id.clone())
            .ok_or_else(|| {
                Error::new(
                    "permission_denied",
                    "Companion credential is invalid or revoked.",
                )
            })
    }
    pub fn browser(&self, token: &str, origin: &str) -> Result<String> {
        let store = self.0.lock().unwrap();
        let id = Self::lookup(&store, token, true)?;
        if !store
            .grants
            .get(&id)
            .is_some_and(|g| g.origin == origin && g.sender.is_some())
        {
            return Err(Error::new(
                "permission_denied",
                "Use the paired browser credential and original editor origin.",
            ));
        }
        Ok(id)
    }
    pub fn client(&self, token: &str) -> Result<String> {
        Self::lookup(&self.0.lock().unwrap(), token, false)
    }
    pub fn scope(&self, id: &str) -> Result<(String, Permissions)> {
        let store = self.0.lock().unwrap();
        let g = store
            .grants
            .get(id)
            .filter(|g| g.expires > Instant::now())
            .ok_or_else(|| Error::new("permission_denied", "Pairing was revoked or expired."))?;
        Ok((g.project.clone(), g.permissions.clone()))
    }
    pub fn attach(
        &self,
        token: &str,
        sender: mpsc::Sender<String>,
        diagnostics: bool,
    ) -> Result<(String, String, Value)> {
        let mut store = self.0.lock().unwrap();
        let id = Self::lookup(&store, token, true)?;
        let g = store.grants.get_mut(&id).unwrap();
        if g.sender.is_some() {
            return Err(Error::new(
                "already_connected",
                "This pairing already has an active browser.",
            ));
        }
        let connection = uuid::Uuid::new_v4().to_string();
        g.connection = Some(connection.clone());
        g.sender = Some(sender);
        g.diagnostics = diagnostics;
        g.expires = Instant::now() + Duration::from_secs(8 * 3600);
        Ok((
            id,
            connection,
            json!({"diagnosticsProtocol":1,"type":"ready","version":1,"projectId":g.project,"sessionId":g.id,"nextSequence":g.sequence+1,"permissions":g.permissions}),
        ))
    }
    pub fn detach(&self, id: &str, connection: &str) {
        let mut store = self.0.lock().unwrap();
        if store.grants.get(id).and_then(|g| g.connection.as_deref()) != Some(connection) {
            return;
        }
        if let Some(mut grant) = store.grants.remove(id) {
            for (_, reply) in std::mem::take(&mut grant.pending) {
                let _=reply.send(Err(Error::new("browser_disconnected","The authorized browser disconnected. Pair the project again before requesting operations.")));
            }
        }
    }
    pub fn sweep(&self) {
        let mut store = self.0.lock().unwrap();
        let expired = store
            .grants
            .iter()
            .filter(|(_, g)| g.expires <= Instant::now())
            .map(|(id, _)| id.clone())
            .collect::<Vec<_>>();
        for id in expired {
            if let Some(mut g) = store.grants.remove(&id) {
                if let Some(tx) = g.sender {
                    let _ = tx.try_send(json!({"type":"revoked"}).to_string());
                }
                for (_, reply) in std::mem::take(&mut g.pending) {
                    let _ = reply.send(Err(Error::new(
                        "session_expired",
                        "Pairing expired. Pair the project again.",
                    )));
                }
            }
        }
    }
    pub fn shutdown(&self) {
        let mut store = self.0.lock().unwrap();
        for (_, mut g) in std::mem::take(&mut store.grants) {
            if let Some(tx) = g.sender {
                let _ = tx.try_send(json!({"type":"revoked"}).to_string());
            }
            for (_, reply) in std::mem::take(&mut g.pending) {
                let _ = reply.send(Err(Error::new(
                    "browser_disconnected",
                    "Companion is shutting down.",
                )));
            }
        }
    }
    pub fn revoke(&self, token: &str) -> Result<()> {
        let mut store = self.0.lock().unwrap();
        let id = Self::lookup(&store, token, true)?;
        if let Some(mut g) = store.grants.remove(&id) {
            if let Some(tx) = &g.sender {
                let _ = tx.try_send(json!({"type":"revoked"}).to_string());
            }
            for (_, reply) in std::mem::take(&mut g.pending) {
                let _ = reply.send(Err(Error::new("permission_denied", "Pairing was revoked.")));
            }
        }
        Ok(())
    }
    fn send(
        g: &mut Grant,
        operation: Operation,
        id: String,
        telemetry: Option<scribyra_core::telemetry::TraceContext>,
    ) -> Result<()> {
        let tx=g.sender.as_ref().ok_or_else(||Error::new("browser_disconnected","Open and pair the project in Scribyra before using this tool. Compilation requires the browser runtime."))?;
        let next = g
            .sequence
            .checked_add(1)
            .filter(|n| *n <= scribyra_core::companion::MAX_SEQUENCE)
            .ok_or_else(|| Error::new("session_exhausted", "Pair this project again."))?;
        let revision = match &operation {
            Operation::Compile { expected_revision }
            | Operation::Export {
                expected_revision, ..
            } => expected_revision.clone(),
            Operation::Command { request } => request.expected_revision.clone().unwrap_or_default(),
            _ => "preflight".into(),
        };
        let mut request = Request {
            version: 1,
            request_id: id,
            project_id: g.project.clone(),
            session_id: g.id.clone(),
            sequence: next,
            operation,
            telemetry: if g.diagnostics { telemetry } else { None },
        };
        scribyra_core::companion::validate(
            &request,
            &Context {
                project_id: g.project.clone(),
                session_id: g.id.clone(),
                next_sequence: next,
                revision,
                permissions: g.permissions.clone(),
            },
        )
        .map_err(|e| Error {
            code: e.code.into(),
            message: e.message,
        })?;
        let mut text = serde_json::to_string(&request).unwrap();
        if text.len() > scribyra_core::companion::MAX_REQUEST && request.telemetry.is_some() {
            request.telemetry = None;
            text = serde_json::to_string(&request).unwrap();
        }
        if text.len() > scribyra_core::companion::MAX_REQUEST {
            return Err(Error::new("too_large", "Companion request exceeds 8 MiB."));
        }
        tx.try_send(text).map_err(|_| {
            Error::new(
                "browser_busy",
                "The browser request queue is full or disconnected.",
            )
        })?;
        g.sequence = next;
        Ok(())
    }
    pub async fn request(
        &self,
        id: &str,
        operation: Operation,
        cancellation: CancellationToken,
    ) -> Result<Value> {
        let mut observation = crate::telemetry::begin(scribyra_core::telemetry::Operation::Mcp);
        let result = self
            .request_inner(id, operation, cancellation, observation.context())
            .await;
        match &result {
            Ok(_) => observation.success(),
            Err(error) => observation.error(&error.code),
        };
        result
    }
    async fn request_inner(
        &self,
        id: &str,
        operation: Operation,
        cancellation: CancellationToken,
        telemetry: Option<scribyra_core::telemetry::TraceContext>,
    ) -> Result<Value> {
        let timeout = if matches!(operation, Operation::Compile { .. }) {
            Duration::from_secs(15 * 60)
        } else {
            Duration::from_secs(60)
        };
        let request_id = uuid::Uuid::new_v4().to_string();
        let (receiver, guard) = {
            let mut store = self.0.lock().unwrap();
            let g = store
                .grants
                .get_mut(id)
                .filter(|g| g.expires > Instant::now())
                .ok_or_else(|| Error::new("permission_denied", "Pairing was revoked."))?;
            if g.pending.len() >= 8 {
                return Err(Error::new(
                    "browser_busy",
                    "At most eight companion operations may be active.",
                ));
            }
            Self::send(g, operation, request_id.clone(), telemetry.clone())?;
            let (tx, rx) = oneshot::channel();
            g.pending.insert(request_id.clone(), tx);
            (
                rx,
                Pending {
                    hub: self.clone(),
                    session: id.into(),
                    id: request_id.clone(),
                    telemetry,
                },
            )
        };
        let result = tokio::select! {
            result=receiver=>result.unwrap_or_else(|_|Err(Error::new("browser_disconnected","The browser request channel closed."))),
            _=cancellation.cancelled()=>Err(Error::new("cancelled","MCP operation cancelled.")),
            _=tokio::time::sleep(timeout)=>Err(Error::new("timeout","Browser operation timed out.")),
        };
        drop(guard);
        if result.is_ok() {
            self.scope(id)?;
        }
        result
    }
    pub fn reply(&self, id: &str, connection: &str, text: &str) -> Result<()> {
        let reply: Reply = serde_json::from_str(text)
            .map_err(|_| Error::new("invalid_reply", "Browser sent an invalid response."))?;
        let mut store = self.0.lock().unwrap();
        let g = store
            .grants
            .get_mut(id)
            .ok_or_else(|| Error::new("permission_denied", "Pairing was revoked."))?;
        if g.connection.as_deref() != Some(connection)
            || reply.version != 1
            || reply.project_id != g.project
            || reply.session_id != g.id
            || reply.revision.len() > 256
        {
            return Err(Error::new(
                "invalid_reply",
                "Browser response scope does not match its pairing.",
            ));
        }
        if let Some(tx) = g.pending.remove(&reply.request_id) {
            let result = if reply.ok {
                Ok(
                    json!({"projectId":g.project,"revision":reply.revision,"value":reply.value.unwrap_or(Value::Null)}),
                )
            } else {
                Err(reply
                    .error
                    .unwrap_or_else(|| Error::new("operation_failed", "Browser operation failed.")))
            };
            let _ = tx.send(result);
        }
        Ok(())
    }
    pub fn artifact(&self, id: &str, artifact: &str) -> Result<Artifact> {
        let store = self.0.lock().unwrap();
        let g = store
            .grants
            .get(id)
            .filter(|g| g.permissions.export && g.expires > Instant::now() && g.sender.is_some())
            .ok_or_else(|| {
                Error::new(
                    "permission_denied",
                    "Export permission was revoked or the browser disconnected.",
                )
            })?;
        g.artifacts
            .get(artifact)
            .filter(|a| a.created.elapsed() < Duration::from_secs(15 * 60))
            .cloned()
            .ok_or_else(|| Error::new("not_found", "Export expired or is no longer available."))
    }
    pub fn store_artifact(&self, id: &str, mut result: Value) -> Result<Value> {
        let artifact = &mut result["value"];
        let encoded = artifact["base64"]
            .as_str()
            .ok_or_else(|| Error::new("invalid_reply", "Browser omitted export bytes."))?;
        let bytes = STANDARD
            .decode(encoded)
            .map_err(|_| Error::new("invalid_reply", "Browser export encoding is invalid."))?;
        let size = artifact["size"].as_u64().unwrap_or(u64::MAX);
        let hash = artifact["sha256"].as_str().unwrap_or("");
        if bytes.len() > 64 * 1024 * 1024 + 1024 * 1024
            || bytes.len() as u64 != size
            || format!("{:x}", Sha256::digest(&bytes)) != hash
        {
            return Err(Error::new(
                "invalid_reply",
                "Browser export differs from its byte/hash limits.",
            ));
        }
        artifact.as_object_mut().unwrap().remove("base64");
        let artifact_id = uuid::Uuid::new_v4().to_string();
        let mut store = self.0.lock().unwrap();
        let base = store.base.clone();
        let g = store
            .grants
            .get_mut(id)
            .filter(|g| g.permissions.export && g.sender.is_some() && g.expires > Instant::now())
            .ok_or_else(|| Error::new("permission_denied", "Export permission was revoked."))?;
        artifact["id"] = artifact_id.clone().into();
        artifact["uri"] = format!("scribyra://{}/artifacts/{artifact_id}", g.project).into();
        artifact["downloadUrl"] = format!("{base}/artifacts/{artifact_id}").into();
        while g.artifacts.len() >= 2
            || g.artifacts.values().map(|a| a.bytes.len()).sum::<usize>() + bytes.len()
                > 128 * 1024 * 1024
        {
            if let Some(key) = g
                .artifacts
                .iter()
                .min_by_key(|(_, a)| a.created)
                .map(|(k, _)| k.clone())
            {
                g.artifacts.remove(&key);
            } else {
                break;
            }
        }
        g.artifacts.insert(
            artifact_id,
            Artifact {
                bytes: Arc::new(bytes),
                metadata: artifact.clone(),
                created: Instant::now(),
            },
        );
        Ok(result)
    }
}
struct Pending {
    hub: Hub,
    session: String,
    id: String,
    telemetry: Option<scribyra_core::telemetry::TraceContext>,
}
impl Drop for Pending {
    fn drop(&mut self) {
        let mut store = self.hub.0.lock().unwrap();
        if let Some(g) = store.grants.get_mut(&self.session) {
            if g.pending.remove(&self.id).is_some() {
                let _ = Hub::send(
                    g,
                    Operation::Cancel {
                        request_id: self.id.clone(),
                    },
                    uuid::Uuid::new_v4().to_string(),
                    self.telemetry.clone(),
                );
            }
        }
    }
}
