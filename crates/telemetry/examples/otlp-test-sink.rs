//! Loopback-only, bounded, in-memory protocol evidence. Not a storage backend.
use axum::{
    Router,
    body::Bytes,
    extract::{DefaultBodyLimit, Path, State},
    http::{StatusCode, header},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use opentelemetry_proto::tonic::collector::{
    logs::v1::ExportLogsServiceRequest, metrics::v1::ExportMetricsServiceRequest,
    trace::v1::ExportTraceServiceRequest,
};
use prost::Message;
use std::{
    collections::VecDeque,
    sync::{Arc, Mutex},
};
#[derive(Default)]
struct Captures {
    records: VecDeque<(String, serde_json::Value, usize)>,
    bytes: usize,
}
type Shared = Arc<Mutex<Captures>>;
async fn receive(State(state): State<Shared>, Path(signal): Path<String>, body: Bytes) -> Response {
    let value = match signal.as_str() {
        "logs" => ExportLogsServiceRequest::decode(body)
            .ok()
            .and_then(|v| serde_json::to_value(v).ok()),
        "traces" => ExportTraceServiceRequest::decode(body)
            .ok()
            .and_then(|v| serde_json::to_value(v).ok()),
        "metrics" => ExportMetricsServiceRequest::decode(body)
            .ok()
            .and_then(|v| serde_json::to_value(v).ok()),
        _ => None,
    };
    let Some(value) = value else {
        return StatusCode::BAD_REQUEST.into_response();
    };
    let size = serde_json::to_vec(&value).unwrap().len();
    let mut state = state.lock().unwrap();
    while !state.records.is_empty()
        && (state.records.len() >= 128 || state.bytes + size > 8 * 1024 * 1024)
    {
        let old = state.records.pop_front().unwrap();
        state.bytes -= old.2;
    }
    state.bytes += size;
    state.records.push_back((signal, value, size));
    (
        StatusCode::OK,
        [(header::CONTENT_TYPE, "application/x-protobuf")],
        Bytes::new(),
    )
        .into_response()
}
async fn captures(State(state): State<Shared>) -> Response {
    let state = state.lock().unwrap();
    axum::Json(serde_json::json!({"bytes":state.bytes,"records":state.records.iter().map(|(signal,value,_)|serde_json::json!({"signal":signal,"data":value})).collect::<Vec<_>>()})).into_response()
}
#[tokio::main]
async fn main() {
    let state = Arc::new(Mutex::new(Captures::default()));
    let app = Router::new()
        .route("/v1/{signal}", post(receive))
        .route("/captures", get(captures))
        .layer(DefaultBodyLimit::max(256 * 1024))
        .with_state(state);
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    println!(
        "{}",
        serde_json::json!({"event":"ready","url":format!("http://{}",listener.local_addr().unwrap())})
    );
    axum::serve(listener, app).await.unwrap();
}
