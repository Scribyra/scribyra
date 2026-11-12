use axum::{
    Router,
    body::{Bytes, to_bytes},
    extract::{Request, State},
    http::{HeaderMap, HeaderValue, Method, StatusCode, header},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use http_body_util::{BodyExt, Full, LengthLimitError, Limited};
use hyper_util::{
    client::legacy::{Client, connect::HttpConnector},
    rt::TokioExecutor,
};
use opentelemetry_proto::tonic::collector::{
    logs::v1::ExportLogsServiceResponse, metrics::v1::ExportMetricsServiceResponse,
    trace::v1::ExportTraceServiceResponse,
};
use prost::Message;
use scribyra_core::telemetry::transport::{Batch, MAX_BATCH_BYTES};
use sha2::{Digest, Sha256};
use std::error::Error as _;
use std::{
    collections::{HashMap, VecDeque},
    sync::{
        Arc,
        atomic::{AtomicU64, Ordering},
    },
    time::{Instant, SystemTime, UNIX_EPOCH},
};
use subtle::ConstantTimeEq;
use tokio::sync::{Mutex, Semaphore};
use url::Url;
const LABELS: [&str; 8] = [
    "accepted",
    "auth",
    "origin",
    "oversize",
    "rate",
    "unavailable",
    "conflict",
    "invalid",
];
pub fn unix_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}
#[derive(Clone)]
pub struct Config {
    pub alloy: String,
    pub origins: Vec<String>,
    token_hash: Option<[u8; 32]>,
    browser_ingestion: bool,
}
impl Config {
    pub fn new(alloy: &str, origins: Vec<String>, token: &str) -> Result<Self, &'static str> {
        Self::build(alloy, origins, Some(token), false)
    }
    /// Anonymous browser batches have a separate origin-required route. They
    /// cannot authorize native events or test-run publication.
    pub fn browser(alloy: &str, origins: Vec<String>) -> Result<Self, &'static str> {
        Self::build(alloy, origins, None, true)
    }
    pub fn with_browser_ingestion(mut self) -> Self {
        self.browser_ingestion = true;
        self
    }
    fn build(
        alloy: &str,
        origins: Vec<String>,
        token: Option<&str>,
        browser_ingestion: bool,
    ) -> Result<Self, &'static str> {
        let endpoint = Url::parse(alloy).map_err(|_| "Invalid Alloy endpoint")?;
        if endpoint.scheme() != "http"
            || endpoint.host_str().is_none()
            || !endpoint.username().is_empty()
            || endpoint.password().is_some()
            || endpoint.query().is_some()
            || endpoint.fragment().is_some()
            || endpoint.path() != "/"
        {
            return Err("Alloy must be an internal HTTP root endpoint");
        }
        if token
            .is_some_and(|token| token.len() != 64 || !token.bytes().all(|c| c.is_ascii_hexdigit()))
            || origins.is_empty()
            || origins.len() > 16
        {
            return Err("Invalid ingress configuration");
        }
        for origin in &origins {
            let url = Url::parse(origin).map_err(|_| "Invalid allowed origin")?;
            if url.origin().ascii_serialization() != *origin
                || !(url.scheme() == "https"
                    || url.scheme() == "http"
                        && matches!(url.host_str(), Some("127.0.0.1" | "localhost" | "[::1]")))
            {
                return Err("Invalid allowed origin");
            }
        }
        Ok(Self {
            alloy: alloy.trim_end_matches('/').into(),
            origins,
            token_hash: token.map(|token| Sha256::digest(token.as_bytes()).into()),
            browser_ingestion,
        })
    }
    fn authenticated(&self, headers: &HeaderMap) -> bool {
        let Some(token_hash) = self.token_hash else {
            return false;
        };
        let Some((scheme, token)) = headers
            .get(header::AUTHORIZATION)
            .and_then(|h| h.to_str().ok())
            .and_then(|v| v.split_once(' '))
        else {
            return false;
        };
        scheme.eq_ignore_ascii_case("Bearer")
            && token.len() == 64
            && bool::from(
                token_hash
                    .as_slice()
                    .ct_eq(&Sha256::digest(token.as_bytes())[..]),
            )
    }
}
#[derive(Default)]
pub struct Stats {
    results: [AtomicU64; 8],
    last_success: AtomicU64,
    events: AtomicU64,
}
struct Receipt {
    digest: [u8; 32],
    done: [bool; 3],
    period: (u64, u64),
}
struct Delivery {
    receipts: HashMap<String, Receipt>,
    order: VecDeque<String>,
    clock: u64,
}
struct Rate {
    tokens: f64,
    last: Instant,
}
struct App {
    config: Config,
    client: Client<HttpConnector, Full<Bytes>>,
    delivery: Mutex<Delivery>,
    rate: std::sync::Mutex<Rate>,
    slots: Semaphore,
    stats: Stats,
}
#[derive(Clone)]
pub struct Ingress(Arc<App>);
impl Ingress {
    pub fn new(config: Config) -> Self {
        Self(Arc::new(App {
            config,
            client: Client::builder(TokioExecutor::new()).build_http(),
            delivery: Mutex::new(Delivery {
                receipts: HashMap::new(),
                order: VecDeque::new(),
                clock: unix_ms() * 1_000_000,
            }),
            rate: std::sync::Mutex::new(Rate {
                tokens: 16.0,
                last: Instant::now(),
            }),
            slots: Semaphore::new(8),
            stats: Stats::default(),
        }))
    }
    pub fn router(&self) -> Router {
        Router::new()
            .route("/health", get(|| async { "{\"status\":\"up\"}" }))
            .route("/metrics", get(metrics))
            .route("/v1/events", post(ingest).options(preflight))
            .route("/v1/browser-events", post(ingest).options(preflight))
            .route("/v1/runs", post(ingest).options(preflight))
            .with_state(self.clone())
    }
    fn response(&self, origin: Option<&str>, code: StatusCode, kind: usize) -> Response {
        self.0.stats.results[kind].fetch_add(1, Ordering::Relaxed);
        let mut response = (
            code,
            [(header::CONTENT_TYPE, "application/json")],
            format!("{{\"result\":\"{}\"}}", LABELS[kind]),
        )
            .into_response();
        cors(&mut response, origin);
        if code == StatusCode::SERVICE_UNAVAILABLE || code == StatusCode::TOO_MANY_REQUESTS {
            response
                .headers_mut()
                .insert(header::RETRY_AFTER, HeaderValue::from_static("1"));
        }
        response
    }
}
fn origin<'a>(app: &Ingress, headers: &'a HeaderMap) -> Result<Option<&'a str>, ()> {
    match headers.get(header::ORIGIN) {
        None => Ok(None),
        Some(value) => {
            let value = value.to_str().map_err(|_| ())?;
            if app.0.config.origins.iter().any(|allowed| allowed == value) {
                Ok(Some(value))
            } else {
                Err(())
            }
        }
    }
}
fn cors(response: &mut Response, origin: Option<&str>) {
    if let Some(origin) = origin {
        if let Ok(value) = HeaderValue::from_str(origin) {
            response
                .headers_mut()
                .insert(header::ACCESS_CONTROL_ALLOW_ORIGIN, value);
        }
        response
            .headers_mut()
            .insert(header::VARY, HeaderValue::from_static("Origin"));
    }
}
async fn preflight(State(app): State<Ingress>, headers: HeaderMap) -> Response {
    let Ok(Some(allowed)) = origin(&app, &headers) else {
        return app.response(None, StatusCode::FORBIDDEN, 2);
    };
    let mut response = StatusCode::NO_CONTENT.into_response();
    cors(&mut response, Some(allowed));
    response.headers_mut().insert(
        header::ACCESS_CONTROL_ALLOW_METHODS,
        HeaderValue::from_static("POST, OPTIONS"),
    );
    response.headers_mut().insert(
        header::ACCESS_CONTROL_ALLOW_HEADERS,
        HeaderValue::from_static("authorization, content-type"),
    );
    response
}
async fn ingest(State(app): State<Ingress>, request: Request) -> Response {
    let is_run = request.uri().path() == "/v1/runs";
    let browser = request.uri().path() == "/v1/browser-events";
    if browser && !app.0.config.browser_ingestion {
        return app.response(None, StatusCode::NOT_FOUND, 2);
    }
    let Ok(allowed) = origin(&app, request.headers()) else {
        return app.response(None, StatusCode::FORBIDDEN, 2);
    };
    let allowed = allowed.map(str::to_owned);
    if browser
        && (allowed.is_none()
            || request.headers().contains_key(header::AUTHORIZATION)
            || request.headers().contains_key(header::COOKIE))
    {
        return app.response(allowed.as_deref(), StatusCode::FORBIDDEN, 2);
    }
    if !browser && !app.0.config.authenticated(request.headers()) {
        return app.response(allowed.as_deref(), StatusCode::UNAUTHORIZED, 1);
    }
    if request.uri().query().is_some()
        || request
            .headers()
            .get(header::CONTENT_TYPE)
            .and_then(|h| h.to_str().ok())
            .is_none_or(|s| s.split(';').next() != Some("application/json"))
        || request.headers().contains_key(header::CONTENT_ENCODING)
    {
        return app.response(allowed.as_deref(), StatusCode::BAD_REQUEST, 7);
    }
    let Ok(_slot) = app.0.slots.try_acquire() else {
        return app.response(allowed.as_deref(), StatusCode::TOO_MANY_REQUESTS, 4);
    };
    {
        let mut rate = app.0.rate.lock().unwrap();
        rate.tokens = (rate.tokens + rate.last.elapsed().as_secs_f64() * 4.0).min(16.0);
        rate.last = Instant::now();
        if rate.tokens < 1.0 {
            return app.response(allowed.as_deref(), StatusCode::TOO_MANY_REQUESTS, 4);
        }
        rate.tokens -= 1.0;
    }
    let body = match tokio::time::timeout(
        std::time::Duration::from_secs(2),
        to_bytes(request.into_body(), MAX_BATCH_BYTES),
    )
    .await
    {
        Ok(Ok(bytes)) => bytes,
        Err(_) => return app.response(allowed.as_deref(), StatusCode::REQUEST_TIMEOUT, 5),
        Ok(Err(error)) => {
            if error
                .source()
                .is_some_and(|source| source.is::<LengthLimitError>())
            {
                return app.response(allowed.as_deref(), StatusCode::PAYLOAD_TOO_LARGE, 3);
            }
            return app.response(allowed.as_deref(), StatusCode::BAD_REQUEST, 7);
        }
    };
    let run = if is_run {
        match scribyra_core::telemetry::transport::runs::Run::parse(&body, unix_ms()) {
            Ok(run) => Some(run),
            Err(_) => return app.response(allowed.as_deref(), StatusCode::BAD_REQUEST, 7),
        }
    } else {
        None
    };
    let batch = match run
        .as_ref()
        .map(|run| Ok(run.batch()))
        .unwrap_or_else(|| Batch::parse(&body, unix_ms()))
    {
        Ok(batch) => batch,
        Err(_) => return app.response(allowed.as_deref(), StatusCode::BAD_REQUEST, 7),
    };
    if browser
        && (batch.events.len() > 32
            || batch.source != scribyra_core::telemetry::transport::ActivitySource::Application
            || batch.events.iter().any(|event| {
                !matches!(
                    event.runtime,
                    scribyra_core::telemetry::Runtime::Browser
                        | scribyra_core::telemetry::Runtime::Worker
                )
            })
            || batch
                .delivery
                .as_ref()
                .is_some_and(|counts| counts.runtime != scribyra_core::telemetry::Runtime::Browser))
    {
        return app.response(allowed.as_deref(), StatusCode::BAD_REQUEST, 7);
    }
    let canonical = run
        .as_ref()
        .map(|run| serde_json::to_vec(run).unwrap())
        .unwrap_or_else(|| serde_json::to_vec(&batch).unwrap());
    let digest: [u8; 32] = Sha256::digest(canonical).into();
    let Ok(mut delivery) = app.0.delivery.try_lock() else {
        return app.response(allowed.as_deref(), StatusCode::SERVICE_UNAVAILABLE, 5);
    };
    if let Some(receipt) = delivery.receipts.get(&batch.batch_id) {
        if receipt.digest != digest {
            return app.response(allowed.as_deref(), StatusCode::CONFLICT, 6);
        }
    } else {
        if delivery.order.len() >= 256 {
            let oldest = delivery.order.pop_front().unwrap();
            delivery.receipts.remove(&oldest);
        }
        let end = (unix_ms() * 1_000_000).max(delivery.clock + 1);
        let period = (delivery.clock, end);
        delivery.clock = end;
        delivery.order.push_back(batch.batch_id.clone());
        delivery.receipts.insert(
            batch.batch_id.clone(),
            Receipt {
                digest,
                done: [false; 3],
                period,
            },
        );
    }
    let receipt = delivery.receipts.get_mut(&batch.batch_id).unwrap();
    let repeated = receipt.done.iter().all(|done| *done);
    let payload = match &run {
        Some(run) => crate::otlp::encode_run(run, receipt.period.0, receipt.period.1),
        None => crate::otlp::encode(&batch, receipt.period.0, receipt.period.1),
    };
    for (index, path) in ["logs", "traces", "metrics"].iter().enumerate() {
        if receipt.done[index] {
            continue;
        }
        if forward(
            &app,
            &format!("{}/v1/{path}", app.0.config.alloy),
            payload[index].clone(),
            index,
        )
        .await
        {
            receipt.done[index] = true;
        }
    }
    if receipt.done.iter().all(|done| *done) {
        app.0
            .stats
            .last_success
            .store(unix_ms() / 1000, Ordering::Relaxed);
        if !repeated {
            app.0
                .stats
                .events
                .fetch_add(batch.events.len() as u64, Ordering::Relaxed);
        }
        app.response(allowed.as_deref(), StatusCode::ACCEPTED, 0)
    } else {
        app.response(allowed.as_deref(), StatusCode::SERVICE_UNAVAILABLE, 5)
    }
}
async fn forward(app: &Ingress, url: &str, bytes: Vec<u8>, signal: usize) -> bool {
    tokio::time::timeout(std::time::Duration::from_secs(2), async {
        let Ok(request) = hyper::Request::builder()
            .method(Method::POST)
            .uri(url)
            .header(header::CONTENT_TYPE, "application/x-protobuf")
            .body(Full::new(Bytes::from(bytes)))
        else {
            return false;
        };
        let Ok(response) = app.0.client.request(request).await else {
            return false;
        };
        if response.status() != StatusCode::OK {
            return false;
        }
        let Ok(body) = Limited::new(response.into_body(), 16 * 1024)
            .collect()
            .await
        else {
            return false;
        };
        let body = body.to_bytes();
        match signal {
            0 => ExportLogsServiceResponse::decode(body)
                .map(|r| {
                    r.partial_success
                        .is_none_or(|p| p.rejected_log_records == 0)
                })
                .unwrap_or(false),
            1 => ExportTraceServiceResponse::decode(body)
                .map(|r| r.partial_success.is_none_or(|p| p.rejected_spans == 0))
                .unwrap_or(false),
            _ => ExportMetricsServiceResponse::decode(body)
                .map(|r| {
                    r.partial_success
                        .is_none_or(|p| p.rejected_data_points == 0)
                })
                .unwrap_or(false),
        }
    })
    .await
    .unwrap_or(false)
}
async fn metrics(State(app): State<Ingress>) -> Response {
    let mut text = String::from("# TYPE scribyra_ingress_requests_total counter\n");
    for (label, value) in LABELS.iter().zip(&app.0.stats.results) {
        text.push_str(&format!(
            "scribyra_ingress_requests_total{{result=\"{label}\"}} {}\n",
            value.load(Ordering::Relaxed)
        ));
    }
    text.push_str(&format!("# TYPE scribyra_ingress_events_total counter\nscribyra_ingress_events_total {}\n# TYPE scribyra_ingress_last_success_timestamp_seconds gauge\nscribyra_ingress_last_success_timestamp_seconds {}\n",app.0.stats.events.load(Ordering::Relaxed),app.0.stats.last_success.load(Ordering::Relaxed)));
    ([(header::CONTENT_TYPE, "text/plain; version=0.0.4")], text).into_response()
}
