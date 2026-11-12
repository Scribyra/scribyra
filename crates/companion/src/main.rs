//! DISCONTINUED (November 8, 2026, the owner's decision): the Rust companion is no
//! longer part of Scribyra. The crate stays in the repository so its tests keep
//! running; the editor reaches it only behind the test-only localStorage switch
//! `scribyra-companion-dev`. Do not add features.
use futures_util::SinkExt;
mod hub;
mod mcp;
mod providers;
mod telemetry;
use axum::{
    Json, Router,
    body::Body,
    extract::{
        DefaultBodyLimit, Path, State,
        ws::{Message, WebSocket, WebSocketUpgrade},
    },
    http::{HeaderMap, Method, Request, StatusCode, header},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use hub::{Error, Hub, Pair};
use rmcp::transport::streamable_http_server::{
    StreamableHttpServerConfig, StreamableHttpService, session::local::LocalSessionManager,
};
use serde::Deserialize;
use serde_json::json;
use std::{sync::Arc, time::Duration};
use tokio::sync::mpsc;
use tower_http::{cors::CorsLayer, services::ServeDir};
#[derive(Clone)]
struct App {
    hub: Hub,
    providers: providers::Providers,
    hosts: Vec<String>,
    origins: Vec<String>,
}
fn bearer(headers: &HeaderMap) -> Option<&str> {
    headers
        .get("authorization")?
        .to_str()
        .ok()?
        .strip_prefix("Bearer ")
}
fn denied(error: Error) -> Response {
    (
        match error.code.as_str() {
            "permission_denied" => StatusCode::FORBIDDEN,
            "not_found" => StatusCode::NOT_FOUND,
            "session_limit" | "browser_busy" => StatusCode::TOO_MANY_REQUESTS,
            _ => StatusCode::BAD_REQUEST,
        },
        Json(error),
    )
        .into_response()
}
async fn gate(State(app): State<App>, request: Request<Body>, next: Next) -> Response {
    let path = request.uri().path();
    let tracked = matches!(path, "/pair" | "/revoke" | "/browser" | "/mcp")
        || path.starts_with("/mcp/")
        || path.starts_with("/providers")
        || path.starts_with("/artifacts/");
    if !tracked {
        return gate_inner(State(app), request, next).await;
    }
    let mut observation = telemetry::begin(scribyra_core::telemetry::Operation::CompanionHttp);
    let response =
        telemetry::scope(observation.context(), gate_inner(State(app), request, next)).await;
    let status = response.status().as_u16();
    if status >= 400 {
        observation.error(match status {
            401 | 403 => "permission_denied",
            404 => "not_found",
            408 | 504 => "timeout",
            409 => "revision_conflict",
            429 => "browser_busy",
            400 | 405 | 413 => "invalid_request",
            _ => "unknown",
        });
    } else {
        observation.success();
    }
    response
}
async fn gate_inner(State(app): State<App>, request: Request<Body>, next: Next) -> Response {
    let host = request
        .headers()
        .get("host")
        .and_then(|h| h.to_str().ok())
        .or_else(|| request.uri().authority().map(|a| a.as_str()));
    if !host.is_some_and(|host| app.hosts.iter().any(|h| h == host)) {
        return StatusCode::FORBIDDEN.into_response();
    }
    let origin = request
        .headers()
        .get("origin")
        .and_then(|h| h.to_str().ok());
    if origin.is_some_and(|origin| !app.origins.iter().any(|allowed| origin == allowed)) {
        return StatusCode::FORBIDDEN.into_response();
    }
    let path = request.uri().path();
    if (matches!(path, "/pair" | "/browser" | "/revoke") || path.starts_with("/providers"))
        && origin.is_none()
    {
        return StatusCode::FORBIDDEN.into_response();
    }
    if request.method() != Method::OPTIONS
        && (path.starts_with("/mcp") || path.starts_with("/artifacts/"))
    {
        if bearer(request.headers()).is_none_or(|token| app.hub.client(token).is_err()) {
            return (
                StatusCode::UNAUTHORIZED,
                [("www-authenticate", "Bearer realm=\"Scribyra companion\"")],
            )
                .into_response();
        }
    }
    next.run(request).await
}
fn browser_scope(app: &App, headers: &HeaderMap) -> hub::Result<String> {
    app.hub.browser(
        bearer(headers).unwrap_or(""),
        headers
            .get("origin")
            .and_then(|h| h.to_str().ok())
            .unwrap_or(""),
    )
}
async fn provider_list(State(app): State<App>, headers: HeaderMap) -> Response {
    match browser_scope(&app, &headers) {
        Ok(_) => Json(app.providers.definitions()).into_response(),
        Err(e) => denied(e),
    }
}
async fn provider_connect(
    State(app): State<App>,
    headers: HeaderMap,
    Json(input): Json<providers::Connect>,
) -> Response {
    let scope = match browser_scope(&app, &headers) {
        Ok(id) => id,
        Err(e) => return denied(e),
    };
    match app.providers.connect(scope, input, &app.hub).await {
        Ok(value) => Json(value).into_response(),
        Err(e) => denied(e),
    }
}
async fn provider_request(
    State(app): State<App>,
    Path(id): Path<String>,
    headers: HeaderMap,
    Json(input): Json<scribyra_core::providers::Request>,
) -> Response {
    let scope = match browser_scope(&app, &headers) {
        Ok(id) => id,
        Err(e) => return denied(e),
    };
    match app.providers.request(&id, &scope, input, &app.hub).await {
        Ok(value) => Json(value).into_response(),
        Err(e) => denied(e),
    }
}
async fn provider_disconnect(
    State(app): State<App>,
    Path(id): Path<String>,
    headers: HeaderMap,
) -> Response {
    match browser_scope(&app, &headers).and_then(|scope| app.providers.disconnect(&id, &scope)) {
        Ok(()) => Json(json!({"ok":true})).into_response(),
        Err(e) => denied(e),
    }
}
async fn provider_cancel(
    State(app): State<App>,
    Path((id, request)): Path<(String, String)>,
    headers: HeaderMap,
) -> Response {
    match browser_scope(&app, &headers)
        .and_then(|scope| app.providers.cancel(&id, &scope, &request))
    {
        Ok(()) => Json(json!({"ok":true})).into_response(),
        Err(e) => denied(e),
    }
}
async fn pair(State(app): State<App>, headers: HeaderMap, Json(pair): Json<Pair>) -> Response {
    let origin = headers
        .get("origin")
        .and_then(|h| h.to_str().ok())
        .unwrap_or("");
    match app.hub.pair(pair, origin) {
        Ok(value) => Json(value).into_response(),
        Err(error) => denied(error),
    }
}
async fn revoke(State(app): State<App>, headers: HeaderMap) -> Response {
    match bearer(&headers)
        .ok_or_else(|| Error::new("permission_denied", "Browser credential is missing."))
        .and_then(|token| app.hub.revoke(token))
    {
        Ok(()) => Json(json!({"ok":true})).into_response(),
        Err(error) => denied(error),
    }
}
async fn artifact(State(app): State<App>, Path(id): Path<String>, headers: HeaderMap) -> Response {
    let result = bearer(&headers)
        .ok_or_else(|| Error::new("permission_denied", "Export credential is missing."))
        .and_then(|token| app.hub.client(token))
        .and_then(|grant| app.hub.artifact(&grant, &id));
    match result {
        Ok(artifact) => {
            let mut response = Response::new(Body::from(artifact.bytes.as_ref().clone()));
            response.headers_mut().insert(
                header::CONTENT_TYPE,
                if artifact.metadata["mimeType"] == "application/pdf" {
                    "application/pdf"
                } else {
                    "application/zip"
                }
                .parse()
                .unwrap(),
            );
            response
                .headers_mut()
                .insert(header::CACHE_CONTROL, "no-store".parse().unwrap());
            response
        }
        Err(error) => denied(error),
    }
}
async fn browser(State(app): State<App>, upgrade: WebSocketUpgrade) -> Response {
    upgrade
        .max_message_size(96 * 1024 * 1024)
        .max_frame_size(96 * 1024 * 1024)
        .on_upgrade(move |socket| browser_socket(app.hub, socket))
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Hello {
    version: u8,
    token: String,
    #[serde(default)]
    diagnostics_protocol: Option<u8>,
}
async fn browser_socket(hub: Hub, mut socket: WebSocket) {
    let mut observation =
        telemetry::begin(scribyra_core::telemetry::Operation::CompanionConnection);
    let hello = match tokio::time::timeout(Duration::from_secs(5), socket.recv()).await {
        Ok(Some(Ok(Message::Text(text)))) if text.len() <= 4096 => {
            serde_json::from_str::<Hello>(&text)
                .ok()
                .filter(|h| h.version == 1)
        }
        _ => None,
    };
    let Some(hello) = hello else {
        observation.error("invalid_request");
        let _ = socket.close().await;
        return;
    };
    let (tx, mut rx) = mpsc::channel(16);
    let (id, connection, ready) =
        match hub.attach(&hello.token, tx, hello.diagnostics_protocol == Some(1)) {
            Ok(values) => values,
            Err(_) => {
                observation.error("permission_denied");
                let _ = socket.close().await;
                return;
            }
        };
    if socket
        .send(Message::Text(ready.to_string().into()))
        .await
        .is_err()
    {
        hub.detach(&id, &connection);
        return;
    }
    let mut heartbeat = tokio::time::interval(Duration::from_secs(15));
    let mut last_seen = std::time::Instant::now();
    loop {
        tokio::select! {
            message=rx.recv()=>match message{Some(text)=>{if hub.scope(&id).is_err(){break;}if socket.send(Message::Text(text.into())).await.is_err(){break;}},None=>break},
            message=socket.recv()=>{last_seen=std::time::Instant::now();match message{Some(Ok(Message::Text(text)))=>{if hub.reply(&id,&connection,&text).is_err(){break;}},Some(Ok(Message::Pong(_)))=>{},Some(Ok(Message::Ping(bytes)))=>{if socket.send(Message::Pong(bytes)).await.is_err(){break;}},_=>break}},
            _=heartbeat.tick()=>{if last_seen.elapsed()>Duration::from_secs(45){observation.error("timeout");break;}if hub.scope(&id).is_err(){break;}if socket.send(Message::Ping(Vec::new().into())).await.is_err(){break;}},
        }
    }
    hub.detach(&id, &connection);
    let _ = socket.close().await;
}
#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    scribyra_core::telemetry::native::initialize(scribyra_core::telemetry::Runtime::Companion);
    let mut port = 43821u16;
    let mut origins = Vec::new();
    let mut app_directory = None;
    let mut provider_path = None;
    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--port" => port = args.next().ok_or("--port needs a number")?.parse()?,
            "--origin" => {
                let raw = args.next().ok_or("--origin needs an exact origin")?;
                let url = url::Url::parse(&raw)?;
                if !matches!(url.scheme(), "https" | "http")
                    || !url.username().is_empty()
                    || url.password().is_some()
                    || url.path() != "/"
                    || url.query().is_some()
                    || url.fragment().is_some()
                {
                    return Err("Use an exact HTTP(S) browser origin".into());
                }
                origins.push(url.origin().ascii_serialization());
            }
            "--providers" => {
                provider_path = Some(
                    args.next()
                        .ok_or("--providers needs a JSON configuration file")?,
                )
            }
            "--app" => app_directory = Some(args.next().ok_or("--app needs a dist directory")?),
            "--help" => {
                println!(
                    "scribyra-companion [--port 43821] [--origin https://your-editor.example] [--app dist] [--providers providers.json]\nPairs only explicitly authorized browser projects. Default origins: localhost/127.0.0.1 ports 4173 and 5173. Pairings are memory-only and expire after eight hours. Set SCRIBYRA_PAIRING_CODE to a 64-character lowercase hex secret for controlled provisioning."
                );
                return Ok(());
            }
            _ => return Err(format!("Unknown option {arg}; use --help").into()),
        }
    }
    if origins.is_empty() {
        origins = vec![
            "http://127.0.0.1:4173".into(),
            "http://localhost:4173".into(),
            "http://127.0.0.1:5173".into(),
            "http://localhost:5173".into(),
        ];
    }
    if origins.len() > 16 {
        return Err("At most sixteen browser origins may be configured".into());
    }
    let listener = tokio::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, port)).await?;
    let port = listener.local_addr()?.port();
    let base = format!("http://127.0.0.1:{port}");
    if app_directory.is_some() {
        origins.push(base.clone());
        origins.push(format!("http://localhost:{port}"));
    }
    let code = std::env::var("SCRIBYRA_PAIRING_CODE").unwrap_or_else(|_| hub::secret());
    if !hub::valid_secret(&code) {
        return Err("SCRIBYRA_PAIRING_CODE must be 64 lowercase hex characters".into());
    }
    let hub = Hub::new(&code, base.clone());
    let providers = providers::Providers::load(provider_path.as_deref())?;
    let hosts = vec![format!("127.0.0.1:{port}"), format!("localhost:{port}")];
    let app = App {
        hub: hub.clone(),
        providers: providers.clone(),
        hosts: hosts.clone(),
        origins: origins.clone(),
    };
    let stop = tokio_util::sync::CancellationToken::new();
    let mut config = StreamableHttpServerConfig::default();
    config.cancellation_token = stop.clone();
    config.allowed_hosts = hosts;
    config.allowed_origins = origins.clone();
    config.stateless_protocol_metadata_required = true;
    let sweep_hub = hub.clone();
    let sweep_providers = providers.clone();
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(Duration::from_secs(1));
        loop {
            interval.tick().await;
            sweep_providers.sweep(&sweep_hub);
        }
    });
    let sweep_hub = hub.clone();
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(Duration::from_secs(15));
        loop {
            interval.tick().await;
            sweep_hub.sweep();
        }
    });
    let mcp_hub = hub.clone();
    let service = StreamableHttpService::new(
        move || {
            Ok(mcp::Mcp {
                hub: mcp_hub.clone(),
            })
        },
        Arc::new(LocalSessionManager::default()),
        config,
    );
    let mut router=Router::new().route("/health",get(||async{Json(json!({"name":"Scribyra companion","version":env!("CARGO_PKG_VERSION"),"browserProtocol":1}))}))
        .route("/pair",post(pair)).route("/revoke",post(revoke)).route("/browser",get(browser)).route("/artifacts/{id}",get(artifact)).nest_service("/mcp",service);
    router = router
        .route("/providers", get(provider_list).post(provider_connect))
        .route(
            "/providers/{id}",
            axum::routing::delete(provider_disconnect),
        )
        .route("/providers/{id}/request", post(provider_request))
        .route(
            "/providers/{id}/requests/{request}",
            axum::routing::delete(provider_cancel),
        );
    if let Some(directory) = app_directory {
        router = router.fallback_service(ServeDir::new(directory));
    }
    let cors = CorsLayer::new()
        .allow_origin(
            origins
                .iter()
                .map(|s| s.parse().unwrap())
                .collect::<Vec<axum::http::HeaderValue>>(),
        )
        .allow_methods([Method::GET, Method::POST, Method::DELETE, Method::OPTIONS])
        .expose_headers([
            "mcp-session-id".parse::<axum::http::HeaderName>().unwrap(),
            "mcp-protocol-version".parse().unwrap(),
        ])
        .allow_headers([
            header::CONTENT_TYPE,
            header::AUTHORIZATION,
            "mcp-protocol-version".parse().unwrap(),
            "mcp-session-id".parse().unwrap(),
            "mcp-method".parse().unwrap(),
            "mcp-name".parse().unwrap(),
            "mcp-capabilities".parse().unwrap(),
        ]);
    let router = router
        .layer(DefaultBodyLimit::max(scribyra_core::companion::MAX_REQUEST))
        .layer(cors)
        .layer(middleware::from_fn_with_state(app.clone(), gate))
        .with_state(app);
    eprintln!(
        "Scribyra companion: {base}\nPairing code (enter only in the project you want to authorize): {code}"
    );
    println!(
        "{}",
        json!({"event":"ready","url":base,"mcpUrl":format!("{base}/mcp")})
    );
    let shutdown_hub = hub.clone();
    let final_providers = providers.clone();
    let result = axum::serve(listener, router)
        .with_graceful_shutdown(async move {
            let _ = tokio::signal::ctrl_c().await;
            shutdown_hub.shutdown();
            providers.shutdown().await;
            stop.cancel();
        })
        .await;
    final_providers.shutdown().await;
    let _ = scribyra_core::telemetry::native::global().flush(Duration::from_secs(1));
    result?;
    Ok(())
}
