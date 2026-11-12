mod config;
mod listener;
mod store;

use axum::{
    Extension, Router,
    body::{Body, Bytes, to_bytes},
    extract::{
        ConnectInfo, Path, State,
        ws::{Message, WebSocket, WebSocketUpgrade},
    },
    http::{HeaderMap, Method, Request, StatusCode, header},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::get,
};
use config::{Config, Principal};
use futures_util::{SinkExt, StreamExt};
use scribyra_core::{
    blob,
    telemetry::{self, Operation},
};
use serde::Deserialize;
use std::{
    collections::{HashMap, HashSet},
    net::IpAddr,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use subtle::ConstantTimeEq;
use tokio::sync::{OwnedSemaphorePermit, Semaphore, broadcast, watch};
use tower_http::cors::CorsLayer;

type Shared = Arc<Service>;
struct Service {
    config: Config,
    store: Arc<Mutex<store::Store>>,
    rooms: Mutex<HashMap<String, Room>>,
    http: Arc<Semaphore>,
    disk: Arc<Semaphore>,
    uploads: Arc<Semaphore>,
    response_bytes: Arc<Semaphore>,
    principals: HashMap<String, Arc<Semaphore>>,
    namespaces: HashMap<String, Namespace>,
    sockets: Arc<Semaphore>,
    sources: Mutex<HashMap<IpAddr, SourceRate>>,
    health: Mutex<HashMap<IpAddr, SourceRate>>,
    shutdown: watch::Sender<bool>,
}
struct Namespace {
    rate: Mutex<Rate>,
    uploads: Arc<Semaphore>,
    downloads: Arc<Semaphore>,
}
struct Download {
    bytes: Vec<u8>,
    _memory: OwnedSemaphorePermit,
    _namespace: OwnedSemaphorePermit,
    _http: Arc<OwnedSemaphorePermit>,
}
impl AsRef<[u8]> for Download {
    fn as_ref(&self) -> &[u8] {
        &self.bytes
    }
}
struct Room {
    namespace: String,
    until: Instant,
    members: HashSet<String>,
    tx: Option<broadcast::Sender<(String, Bytes)>>,
}
struct Rate {
    start: Instant,
    count: u32,
}
impl Rate {
    fn new() -> Self {
        Self {
            start: Instant::now(),
            count: 0,
        }
    }
    fn allow(&mut self, limit: u32) -> bool {
        if self.start.elapsed() >= Duration::from_secs(1) {
            self.start = Instant::now();
            self.count = 0;
        }
        if self.count >= limit {
            return false;
        }
        self.count += 1;
        true
    }
}
struct SourceRate {
    admission: Rate,
    anonymous: Rate,
}
fn source_allow(s: &Service, source: IpAddr, health: bool) -> bool {
    let mut sources = if health { &s.health } else { &s.sources }.lock().unwrap();
    if !sources.contains_key(&source) {
        // Expired entries can be reclaimed; an active attacker cannot evict another source.
        sources.retain(|_, rate| rate.admission.start.elapsed() < Duration::from_secs(1));
        if sources.len() >= s.config.rate_sources {
            return false;
        }
    }
    sources
        .entry(source)
        .or_insert_with(|| SourceRate {
            admission: Rate::new(),
            anonymous: Rate::new(),
        })
        .admission
        .allow(if health {
            s.config.requests_per_second
        } else {
            s.config.source_requests_per_second
        })
}
fn request_source(s: &Service, request: &Request<Body>) -> Result<IpAddr, StatusCode> {
    let peer = request
        .extensions()
        .get::<ConnectInfo<listener::Connection>>()
        .ok_or(StatusCode::INTERNAL_SERVER_ERROR)?
        .0
        .1
        .ip()
        .to_canonical();
    if !s.config.trusted_proxies.contains(&peer) {
        return Ok(peer);
    }
    // Trusted proxies must replace this header with exactly one verified client IP.
    let mut values = request.headers().get_all("x-forwarded-for").iter();
    let source = values
        .next()
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.parse::<IpAddr>().ok())
        .ok_or(StatusCode::BAD_REQUEST)?;
    if values.next().is_some() {
        return Err(StatusCode::BAD_REQUEST);
    }
    Ok(source.to_canonical())
}
fn authenticate(config: &Config, token: &str) -> Option<Principal> {
    if !blob::valid_hash(token) {
        return None;
    }
    let digest = blob::hash(token.as_bytes());
    config
        .principals
        .iter()
        .find(|p| bool::from(p.token_hash.as_bytes().ct_eq(digest.as_bytes())))
        .cloned()
}
fn principal(headers: &HeaderMap, config: &Config) -> Result<Principal, StatusCode> {
    let token = headers
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.strip_prefix("Bearer "))
        .ok_or(StatusCode::UNAUTHORIZED)?;
    authenticate(config, token).ok_or(StatusCode::UNAUTHORIZED)
}
async fn guard(State(s): State<Shared>, mut request: Request<Body>, next: Next) -> Response {
    if *s.shutdown.borrow() {
        return StatusCode::SERVICE_UNAVAILABLE.into_response();
    }
    let source = match request_source(&s, &request) {
        Ok(source) => source,
        Err(status) => return status.into_response(),
    };
    let health = request.uri().path() == "/health";
    if !source_allow(&s, source, health) {
        return StatusCode::TOO_MANY_REQUESTS.into_response();
    }
    if !health {
        let allowed = if let Ok(p) = principal(request.headers(), &s.config) {
            s.namespaces[&p.namespace]
                .rate
                .lock()
                .unwrap()
                .allow(s.config.requests_per_second)
        } else {
            s.sources
                .lock()
                .unwrap()
                .get_mut(&source)
                .is_some_and(|rate| rate.anonymous.allow(s.config.requests_per_second))
        };
        if !allowed {
            return StatusCode::TOO_MANY_REQUESTS.into_response();
        }
    }
    // Uploads have their own authenticated capacity; liveness never waits for a transfer.
    let _permit = if request.method() != Method::PUT && request.uri().path() != "/health" {
        let Ok(permit) = s.http.clone().try_acquire_owned() else {
            return StatusCode::SERVICE_UNAVAILABLE.into_response();
        };
        let permit = Arc::new(permit);
        request.extensions_mut().insert(permit.clone());
        Some(permit)
    } else {
        None
    };
    if let Some(origin) = request.headers().get(header::ORIGIN) {
        if !origin
            .to_str()
            .is_ok_and(|o| s.config.origins.iter().any(|allowed| allowed == o))
        {
            return StatusCode::FORBIDDEN.into_response();
        }
    }
    let mut observation = telemetry::native::global().begin(Operation::SyncHttp, None);
    let response = tokio::time::timeout(Duration::from_secs(15), next.run(request))
        .await
        .unwrap_or_else(|_| StatusCode::REQUEST_TIMEOUT.into_response());
    if response.status().is_success() {
        observation.success();
    } else {
        observation.error("invalid_request");
    }
    // Fixed fields only: no URL, caller-supplied identifier, header or error text.
    println!(
        "{{\"event\":\"http\",\"status\":{}}}",
        response.status().as_u16()
    );
    response
}
async fn ready(State(s): State<Shared>) -> StatusCode {
    let Ok(permit) = s.disk.clone().try_acquire_owned() else {
        return StatusCode::SERVICE_UNAVAILABLE;
    };
    let result = tokio::task::spawn_blocking(move || {
        let _permit = permit;
        s.store.lock().unwrap().ready().is_ok()
    })
    .await;
    if matches!(result, Ok(true)) {
        StatusCode::OK
    } else {
        StatusCode::SERVICE_UNAVAILABLE
    }
}
fn authorize_object(
    s: &Service,
    h: &HeaderMap,
    ns: &str,
    hash: &str,
) -> Result<Principal, StatusCode> {
    let p = principal(h, &s.config)?;
    if !p.storage || p.namespace != ns {
        return Err(StatusCode::FORBIDDEN);
    }
    if !blob::valid_hash(ns) || !blob::valid_hash(hash) {
        return Err(StatusCode::BAD_REQUEST);
    }
    Ok(p)
}
async fn get_object(
    State(s): State<Shared>,
    Path((ns, hash)): Path<(String, String)>,
    ConnectInfo(connection): ConnectInfo<listener::Connection>,
    Extension(http): Extension<Arc<OwnedSemaphorePermit>>,
    headers: HeaderMap,
) -> Result<impl IntoResponse, StatusCode> {
    authorize_object(&s, &headers, &ns, &hash)?;
    let namespace = s.namespaces[&ns]
        .downloads
        .clone()
        .try_acquire_owned()
        .map_err(|_| StatusCode::SERVICE_UNAVAILABLE)?;
    let permit = s
        .disk
        .clone()
        .try_acquire_owned()
        .map_err(|_| StatusCode::SERVICE_UNAVAILABLE)?;
    let send_seconds = s.config.send_seconds;
    let bytes = tokio::task::spawn_blocking(move || {
        let _permit = permit;
        let (bytes, memory) = s
            .store
            .lock()
            .unwrap()
            .get(&ns, &hash, s.response_bytes.clone())?;
        Ok::<_, StatusCode>(Download {
            bytes,
            _memory: memory,
            _namespace: namespace,
            _http: http,
        })
    })
    .await
    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)??;
    // Retain the reservation until socket close, even if Hyper copies the last frame.
    // Bound each frame too, so a transport without vectored writes cannot copy a whole object.
    let bytes = Bytes::from_owner(bytes);
    let length = bytes.len().to_string();
    connection.response(bytes.clone(), send_seconds);
    let chunks = futures_util::stream::unfold(bytes, |mut bytes| async move {
        if bytes.is_empty() {
            None
        } else {
            let chunk = bytes.split_to(bytes.len().min(64 * 1024));
            Some((Ok::<_, std::io::Error>(chunk), bytes))
        }
    });
    Ok((
        [
            (header::CONTENT_TYPE, "application/octet-stream"),
            (header::CACHE_CONTROL, "no-store"),
            (header::X_CONTENT_TYPE_OPTIONS, "nosniff"),
            (header::CONNECTION, "close"),
            (header::CONTENT_LENGTH, length.as_str()),
        ],
        Body::from_stream(chunks),
    )
        .into_response())
}
async fn put_object(
    State(s): State<Shared>,
    Path((ns, hash)): Path<(String, String)>,
    headers: HeaderMap,
    body: Body,
) -> Result<StatusCode, StatusCode> {
    let p = authorize_object(&s, &headers, &ns, &hash)?;
    let principal = s.principals[&p.token_hash]
        .clone()
        .try_acquire_owned()
        .map_err(|_| StatusCode::TOO_MANY_REQUESTS)?;
    let namespace = s.namespaces[&ns]
        .uploads
        .clone()
        .try_acquire_owned()
        .map_err(|_| StatusCode::TOO_MANY_REQUESTS)?;
    let upload = s
        .uploads
        .clone()
        .try_acquire_owned()
        .map_err(|_| StatusCode::SERVICE_UNAVAILABLE)?;
    let bytes = to_bytes(body, s.config.object_bytes)
        .await
        .map_err(|_| StatusCode::PAYLOAD_TOO_LARGE)?;
    let permit = s
        .disk
        .clone()
        .try_acquire_owned()
        .map_err(|_| StatusCode::SERVICE_UNAVAILABLE)?;
    tokio::task::spawn_blocking(move || {
        // Retain capacity even if the HTTP deadline expires while storage is busy.
        let _permits = (permit, principal, namespace, upload);
        s.store.lock().unwrap().put(&ns, &hash, &bytes)
    })
    .await
    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Hello {
    version: u32,
    bearer: String,
    room: String,
    connection: String,
}
async fn upgrade(State(s): State<Shared>, ws: WebSocketUpgrade) -> Response {
    let Ok(permit) = s.sockets.clone().try_acquire_owned() else {
        return StatusCode::TOO_MANY_REQUESTS.into_response();
    };
    ws.max_message_size(s.config.frame_bytes)
        .max_frame_size(s.config.frame_bytes)
        .on_upgrade(move |socket| async move {
            let _permit = permit;
            session(socket, s).await;
        })
        .into_response()
}
async fn session(mut socket: WebSocket, s: Shared) {
    let mut shutdown = s.shutdown.subscribe();
    let hello = tokio::time::timeout(Duration::from_secs(3), socket.next()).await;
    let Ok(Some(Ok(Message::Text(text)))) = hello else {
        return;
    };
    if text.len() > 1024 {
        return;
    }
    let Ok(hello) = serde_json::from_str::<Hello>(&text) else {
        return;
    };
    if hello.version != 1 || !blob::valid_hash(&hello.room) || !blob::valid_hash(&hello.connection)
    {
        return;
    }
    let Some(p) = authenticate(&s.config, &hello.bearer) else {
        return;
    };
    if !p.relay
        || !s.namespaces[&p.namespace]
            .rate
            .lock()
            .unwrap()
            .allow(s.config.requests_per_second)
        || *shutdown.borrow()
    {
        return;
    }
    let key = format!("{}:{}", p.namespace, hello.room);
    let joined = (|| {
        let mut rooms = s.rooms.lock().unwrap();
        rooms.retain(|_, r| r.until > Instant::now());
        let namespace_rooms = rooms.values().filter(|r| r.namespace == p.namespace);
        let active = rooms.values().filter(|r| !r.members.is_empty()).count();
        let occupied = namespace_rooms
            .clone()
            .filter(|r| !r.members.is_empty())
            .count();
        let connections: usize = namespace_rooms.clone().map(|r| r.members.len()).sum();
        let attempts = namespace_rooms.count();
        if connections >= s.config.namespace_connections {
            return None;
        }
        if rooms.get(&key).is_none_or(|r| r.members.is_empty())
            && (active >= s.config.rooms || occupied >= s.config.namespace_rooms)
        {
            return None;
        }
        // Empty records preserve the original deadline but consume no live-room capacity.
        // Never evict an unexpired record to admit a new attacker-selected attempt.
        if !rooms.contains_key(&key)
            && (rooms.len() >= s.config.room_attempts
                || attempts >= s.config.namespace_room_attempts)
        {
            return None;
        }
        let r = rooms.entry(key.clone()).or_insert_with(|| Room {
            namespace: p.namespace.clone(),
            until: Instant::now() + Duration::from_secs(s.config.room_seconds),
            members: HashSet::new(),
            tx: None,
        });
        if r.members.len() >= 5 || !r.members.insert(hello.connection.clone()) {
            return None;
        }
        let tx = r.tx.get_or_insert_with(|| broadcast::channel(16).0);
        Some((tx.clone(), tx.subscribe(), r.until))
    })();
    let Some((tx, mut rx, until)) = joined else {
        return;
    };
    let mut observation = telemetry::native::global().begin(Operation::SyncConnect, None);
    let (mut out, mut input) = socket.split();
    let mut rate = Rate::new();
    let _ = tokio::time::timeout(
        Duration::from_secs(2),
        out.send(Message::Text("{\"version\":1,\"ready\":true}".into())),
    )
    .await;
    loop {
        tokio::select! {
            _ = shutdown.changed() => break,
            _ = tokio::time::sleep_until(until.into()) => break,
            incoming = input.next() => {
                let Some(Ok(Message::Binary(bytes))) = incoming else { break; };
                if bytes.len() < 16 || !rate.allow(s.config.messages_per_second) { break; }
                let _ = tx.send((hello.connection.clone(),bytes));
            }
            outgoing = rx.recv() => {
                let Ok((sender,bytes)) = outgoing else { break; };
                if sender == hello.connection { continue; }
                if !matches!(tokio::time::timeout(Duration::from_secs(2),out.send(Message::Binary(bytes))).await, Ok(Ok(()))) { break; }
            }
        }
    }
    let _ = tokio::time::timeout(Duration::from_secs(1), out.close()).await;
    if let Some(r) = s.rooms.lock().unwrap().get_mut(&key) {
        if r.until == until {
            r.members.remove(&hello.connection);
            if r.members.is_empty() {
                r.tx = None;
            }
        }
    }
    observation.success();
}
async fn run() -> Result<(), Box<dyn std::error::Error>> {
    let config = Config::load()?;
    let store = store::Store::open(config.clone())?;
    telemetry::native::initialize(telemetry::Runtime::SyncService);
    let (shutdown, _) = watch::channel(false);
    let s = Arc::new(Service {
        store: Arc::new(Mutex::new(store)),
        rooms: Mutex::new(HashMap::new()),
        http: Arc::new(Semaphore::new(config.http_concurrency)),
        uploads: Arc::new(Semaphore::new(config.uploads)),
        response_bytes: Arc::new(Semaphore::new(config.response_bytes)),
        principals: config
            .principals
            .iter()
            .map(|p| {
                (
                    p.token_hash.clone(),
                    Arc::new(Semaphore::new(config.principal_uploads)),
                )
            })
            .collect(),
        namespaces: config
            .principals
            .iter()
            .map(|p| {
                (
                    p.namespace.clone(),
                    Namespace {
                        rate: Mutex::new(Rate::new()),
                        uploads: Arc::new(Semaphore::new(config.namespace_uploads)),
                        downloads: Arc::new(Semaphore::new(config.namespace_downloads)),
                    },
                )
            })
            .collect(),
        disk: Arc::new(Semaphore::new(config.http_concurrency)),
        sockets: Arc::new(Semaphore::new(config.connections)),
        sources: Mutex::new(HashMap::new()),
        health: Mutex::new(HashMap::new()),
        shutdown,
        config: config.clone(),
    });
    let origins = config
        .origins
        .iter()
        .map(|s| s.parse().unwrap())
        .collect::<Vec<_>>();
    let app = Router::new()
        .route("/health", get(|| async { "{\"live\":true}" }))
        .route("/ready", get(ready))
        .route(
            "/v1",
            get(|| async {
                axum::Json(
                    serde_json::json!({"version":1,"objects":"immutable","relay":"ephemeral"}),
                )
            }),
        )
        .route(
            "/v1/objects/{namespace}/{hash}",
            get(get_object).put(put_object),
        )
        .route("/v1/connect", get(upgrade))
        .layer(
            CorsLayer::new()
                .allow_origin(origins)
                .allow_methods([Method::GET, Method::HEAD, Method::PUT, Method::OPTIONS])
                .allow_headers([header::CONTENT_TYPE, header::AUTHORIZATION]),
        )
        .layer(middleware::from_fn_with_state(s.clone(), guard))
        .with_state(s.clone());
    let listener = tokio::net::TcpListener::bind(config.bind).await?;
    println!(
        "{{\"event\":\"listening\",\"address\":\"{}\",\"protocol\":1,\"schema\":1}}",
        listener.local_addr()?
    );
    let drain = s.clone();
    let signal = async move {
        let mut term =
            tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()).unwrap();
        tokio::select! { _ = term.recv() => {}, _ = tokio::signal::ctrl_c() => {} }
        s.shutdown.send_replace(true);
        println!("{{\"event\":\"shutdown\"}}");
    };
    let listener = listener::Listener {
        tcp: listener,
        slots: Arc::new(Semaphore::new(config.tcp_connections)),
    };
    axum::serve(
        listener,
        app.into_make_service_with_connect_info::<listener::Connection>(),
    )
    .with_graceful_shutdown(signal)
    .await?;
    // Upgraded sockets are detached from HTTP serving; let their close frames drain.
    let _ = tokio::time::timeout(
        Duration::from_secs(5),
        drain
            .sockets
            .clone()
            .acquire_many_owned(config.connections as u32),
    )
    .await;
    Ok(())
}
#[tokio::main]
async fn main() {
    if run().await.is_err() {
        // Configuration and filesystem errors can contain private paths or values.
        eprintln!("{{\"event\":\"startup_or_runtime_failure\"}}");
        std::process::exit(1);
    }
}
