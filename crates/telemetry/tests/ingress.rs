use axum::{
    Router,
    body::{Body, Bytes, to_bytes},
    extract::{Path, State},
    http::{StatusCode, header},
    response::{IntoResponse, Response},
    routing::post,
};
use http_body_util::Full;
use hyper_util::{
    client::legacy::{Client, connect::HttpConnector},
    rt::TokioExecutor,
};
use opentelemetry_proto::tonic::collector::{
    logs::v1::ExportLogsServiceRequest,
    metrics::v1::ExportMetricsServiceRequest,
    trace::v1::{ExportTracePartialSuccess, ExportTraceServiceRequest, ExportTraceServiceResponse},
};
use prost::Message;
use scribyra_telemetry::server::{Config, Ingress, unix_ms};
use std::{
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};
#[derive(Clone, Default)]
struct Sink {
    calls: Arc<Mutex<Vec<(String, Bytes)>>>,
    reject: Arc<AtomicBool>,
}
async fn receive(State(sink): State<Sink>, Path(signal): Path<String>, body: Bytes) -> Response {
    sink.calls.lock().unwrap().push((signal.clone(), body));
    if signal == "traces" && sink.reject.load(Ordering::Relaxed) {
        let response = ExportTraceServiceResponse {
            partial_success: Some(ExportTracePartialSuccess {
                rejected_spans: 1,
                error_message: "PRIVATE_BACKEND_MESSAGE".into(),
            }),
        };
        return (
            [(header::CONTENT_TYPE, "application/x-protobuf")],
            response.encode_to_vec(),
        )
            .into_response();
    }
    (
        StatusCode::OK,
        [(header::CONTENT_TYPE, "application/x-protobuf")],
        Bytes::new(),
    )
        .into_response()
}
struct Running {
    url: String,
    task: tokio::task::JoinHandle<()>,
}
impl Drop for Running {
    fn drop(&mut self) {
        self.task.abort();
    }
}
async fn start(router: Router) -> Running {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let task = tokio::spawn(async move {
        axum::serve(listener, router).await.unwrap();
    });
    Running { url, task }
}
fn client() -> Client<HttpConnector, Full<Bytes>> {
    Client::builder(TokioExecutor::new()).build_http()
}
async fn send(
    url: &str,
    token: bool,
    origin: Option<&str>,
    body: Vec<u8>,
) -> (StatusCode, String, Option<String>) {
    send_path(url, "/v1/events", token, origin, body).await
}
async fn send_path(
    url: &str,
    path: &str,
    token: bool,
    origin: Option<&str>,
    body: Vec<u8>,
) -> (StatusCode, String, Option<String>) {
    let mut request = hyper::Request::builder()
        .method("POST")
        .uri(format!("{url}{path}"))
        .header(header::CONTENT_TYPE, "application/json");
    if token {
        request = request.header(header::AUTHORIZATION, format!("Bearer {}", "a".repeat(64)));
    }
    if let Some(origin) = origin {
        request = request.header(header::ORIGIN, origin);
    }
    let response = client()
        .request(request.body(Full::new(Bytes::from(body))).unwrap())
        .await
        .unwrap();
    let status = response.status();
    let origin = response
        .headers()
        .get(header::ACCESS_CONTROL_ALLOW_ORIGIN)
        .and_then(|v| v.to_str().ok())
        .map(str::to_owned);
    let body = to_bytes(Body::new(response.into_body()), 64 * 1024)
        .await
        .unwrap();
    (status, String::from_utf8(body.to_vec()).unwrap(), origin)
}
fn batch() -> serde_json::Value {
    serde_json::json!({"version":1,"batchId":"f".repeat(32),"originUnixMs":unix_ms()-10,"delivery":{"runtime":"browser","dropped":2,"sampled":3},"events":[{"version":1,"runtime":"browser","operation":"compile","outcome":"success","traceId":"b".repeat(32),"spanId":"c".repeat(16),"parentSpanId":"d".repeat(16),"elapsedMs":10,"metrics":[{"name":"duration_ms","value":10},{"name":"bytes","value":1024}]}]})
}
fn body(value: &serde_json::Value) -> Vec<u8> {
    serde_json::to_vec(value).unwrap()
}
async fn fixture() -> (Sink, Running, Running) {
    let sink = Sink::default();
    let collector = start(
        Router::new()
            .route("/v1/{signal}", post(receive))
            .with_state(sink.clone()),
    )
    .await;
    let ingress = start(
        Ingress::new(
            Config::new(
                &collector.url,
                vec!["https://editor.example".into()],
                &"a".repeat(64),
            )
            .unwrap(),
        )
        .router(),
    )
    .await;
    (sink, collector, ingress)
}
#[tokio::test]
async fn actual_http_auth_origin_schema_and_whole_batch_privacy_are_checked_before_forwarding() {
    let (sink, _collector, ingress) = fixture().await;
    let value = batch();
    assert_eq!(
        send(&ingress.url, false, None, body(&value)).await.0,
        StatusCode::UNAUTHORIZED
    );
    let rejected = send(
        &ingress.url,
        true,
        Some("https://PRIVATE.invalid"),
        body(&value),
    )
    .await;
    assert_eq!(rejected.0, StatusCode::FORBIDDEN);
    assert_eq!(rejected.2, None);
    assert!(!rejected.1.contains("PRIVATE"));
    let mut private = value.clone();
    private["events"]
        .as_array_mut()
        .unwrap()
        .push(serde_json::json!({"source":"PRIVATE_SOURCE Bearer SECRET"}));
    let rejected = send(&ingress.url, true, None, body(&private)).await;
    assert_eq!(rejected.0, StatusCode::BAD_REQUEST);
    assert!(!rejected.1.contains("SECRET"));
    assert!(sink.calls.lock().unwrap().is_empty());
    assert_eq!(
        send(&ingress.url, true, None, vec![b' '; 65537]).await.0,
        StatusCode::PAYLOAD_TOO_LARGE
    );
    let accepted = send(
        &ingress.url,
        true,
        Some("https://editor.example"),
        body(&value),
    )
    .await;
    assert_eq!(accepted.0, StatusCode::ACCEPTED);
    assert_eq!(accepted.2.as_deref(), Some("https://editor.example"));
    let calls = sink.calls.lock().unwrap();
    assert_eq!(calls.len(), 3);
    for (signal, bytes) in calls.iter() {
        match signal.as_str() {
            "logs" => {
                let request = ExportLogsServiceRequest::decode(bytes.clone()).unwrap();
                assert_eq!(
                    request.resource_logs[0].scope_logs[0].log_records[0].trace_id,
                    vec![0xbb; 16]
                );
            }
            "traces" => {
                let request = ExportTraceServiceRequest::decode(bytes.clone()).unwrap();
                assert_eq!(
                    request.resource_spans[0].scope_spans[0].spans[0].parent_span_id,
                    vec![0xdd; 8]
                );
            }
            _ => {
                let request = ExportMetricsServiceRequest::decode(bytes.clone()).unwrap();
                assert!(
                    request.resource_metrics[0].scope_metrics[0]
                        .metrics
                        .iter()
                        .any(|m| m.name == "scribyra_export_dropped")
                );
            }
        }
    }
}
#[tokio::test]
async fn partial_rejection_retries_only_unacknowledged_signals_and_conflicting_ids_fail() {
    let (sink, _collector, ingress) = fixture().await;
    sink.reject.store(true, Ordering::Relaxed);
    let value = batch();
    let rejected = send(&ingress.url, true, None, body(&value)).await;
    assert_eq!(rejected.0, StatusCode::SERVICE_UNAVAILABLE);
    assert!(!rejected.1.contains("PRIVATE_BACKEND_MESSAGE"));
    sink.reject.store(false, Ordering::Relaxed);
    assert_eq!(
        send(&ingress.url, true, None, body(&value)).await.0,
        StatusCode::ACCEPTED
    );
    assert_eq!(
        send(&ingress.url, true, None, body(&value)).await.0,
        StatusCode::ACCEPTED
    );
    let calls = sink.calls.lock().unwrap().clone();
    assert_eq!(calls.iter().filter(|(s, _)| s == "logs").count(), 1);
    assert_eq!(calls.iter().filter(|(s, _)| s == "metrics").count(), 1);
    assert_eq!(calls.iter().filter(|(s, _)| s == "traces").count(), 2);
    let mut changed = value.clone();
    changed["events"][0]["elapsedMs"] = 11.into();
    assert_eq!(
        send(&ingress.url, true, None, body(&changed)).await.0,
        StatusCode::CONFLICT
    );
}
#[tokio::test]
async fn rate_limit_is_explicit_and_does_not_forward_invalid_payloads() {
    let (sink, _collector, ingress) = fixture().await;
    let mut limited = false;
    for _ in 0..20 {
        let response = send(&ingress.url, true, None, b"{}".to_vec()).await;
        if response.0 == StatusCode::TOO_MANY_REQUESTS {
            limited = true;
        }
    }
    assert!(limited);
    assert!(sink.calls.lock().unwrap().is_empty());
}

#[tokio::test]
async fn anonymous_browser_ingestion_requires_opt_in_origin_and_browser_schema() {
    let (sink, collector, disabled) = fixture().await;
    let path = "/v1/browser-events";
    assert_eq!(
        send_path(
            &disabled.url,
            path,
            false,
            Some("https://editor.example"),
            body(&batch())
        )
        .await
        .0,
        StatusCode::NOT_FOUND
    );
    let ingress = start(
        Ingress::new(
            Config::browser(&collector.url, vec!["https://editor.example".into()]).unwrap(),
        )
        .router(),
    )
    .await;
    for origin in [None, Some("null"), Some("https://other.example")] {
        assert_eq!(
            send_path(&ingress.url, path, false, origin, body(&batch()))
                .await
                .0,
            StatusCode::FORBIDDEN
        );
    }
    assert_eq!(
        send_path(
            &ingress.url,
            path,
            true,
            Some("https://editor.example"),
            body(&batch())
        )
        .await
        .0,
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        send(
            &ingress.url,
            false,
            Some("https://editor.example"),
            body(&batch())
        )
        .await
        .0,
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        send_path(
            &ingress.url,
            "/v1/runs",
            false,
            Some("https://editor.example"),
            body(&batch())
        )
        .await
        .0,
        StatusCode::UNAUTHORIZED
    );
    let mut private = batch();
    private["events"][0]["message"] = "PRIVATE_SOURCE".into();
    let mut native = batch();
    native["events"][0]["runtime"] = "native".into();
    let mut synthetic = batch();
    synthetic["source"] = "synthetic".into();
    let mut count = batch();
    count["events"] = serde_json::json!(vec![count["events"][0].clone(); 33]);
    for invalid in [private, native, synthetic, count] {
        assert_eq!(
            send_path(
                &ingress.url,
                path,
                false,
                Some("https://editor.example"),
                body(&invalid)
            )
            .await
            .0,
            StatusCode::BAD_REQUEST
        );
    }
    assert!(sink.calls.lock().unwrap().is_empty());
    let accepted = send_path(
        &ingress.url,
        path,
        false,
        Some("https://editor.example"),
        body(&batch()),
    )
    .await;
    assert_eq!(accepted.0, StatusCode::ACCEPTED);
    assert_eq!(accepted.2.as_deref(), Some("https://editor.example"));
    assert_eq!(sink.calls.lock().unwrap().len(), 3);
}

#[tokio::test]
async fn anonymous_browser_body_and_request_rate_are_bounded() {
    let (sink, collector, _disabled) = fixture().await;
    let ingress = start(
        Ingress::new(
            Config::browser(&collector.url, vec!["https://editor.example".into()]).unwrap(),
        )
        .router(),
    )
    .await;
    assert_eq!(
        send_path(
            &ingress.url,
            "/v1/browser-events",
            false,
            Some("https://editor.example"),
            vec![b' '; 65537]
        )
        .await
        .0,
        StatusCode::PAYLOAD_TOO_LARGE
    );
    let mut limited = false;
    for _ in 0..20 {
        limited |= send_path(
            &ingress.url,
            "/v1/browser-events",
            false,
            Some("https://editor.example"),
            b"{}".to_vec(),
        )
        .await
        .0 == StatusCode::TOO_MANY_REQUESTS;
    }
    assert!(limited);
    assert!(sink.calls.lock().unwrap().is_empty());
}
#[tokio::test]
#[ignore = "requires pinned Alloy; set SCRIBYRA_TEST_ALLOY and run explicitly"]
async fn real_alloy_receives_all_signals_and_converts_delta_metrics_for_storage() {
    let executable = std::env::var_os("SCRIBYRA_TEST_ALLOY").expect("Set SCRIBYRA_TEST_ALLOY");
    let sink = Sink::default();
    let collector = start(
        Router::new()
            .route("/v1/{signal}", post(receive))
            .with_state(sink.clone()),
    )
    .await;
    let reserved = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let address = reserved.local_addr().unwrap();
    drop(reserved);
    let http_reserved = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let http_address = http_reserved.local_addr().unwrap();
    drop(http_reserved);
    let storage = tempfile::tempdir().unwrap();
    let config =
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../ops/telemetry/forward.alloy");
    let mut alloy = tokio::process::Command::new(executable)
        .args([
            "run",
            "--disable-reporting",
            "--stability.level=experimental",
        ])
        .arg(format!("--server.http.listen-addr={http_address}"))
        .arg(format!("--storage.path={}", storage.path().display()))
        .arg(config)
        .env("SCRIBYRA_OTLP_LISTEN", address.to_string())
        .env("SCRIBYRA_OTLP_FORWARD", &collector.url)
        .kill_on_drop(true)
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .unwrap();
    for _ in 0..100 {
        if tokio::net::TcpStream::connect(address).await.is_ok() {
            break;
        }
        assert!(
            alloy.try_wait().unwrap().is_none(),
            "Alloy exited before readiness"
        );
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    let ingress = start(
        Ingress::new(
            Config::new(
                &format!("http://{address}"),
                vec!["https://editor.example".into()],
                &"a".repeat(64),
            )
            .unwrap(),
        )
        .router(),
    )
    .await;
    assert_eq!(
        send(&ingress.url, true, None, body(&batch())).await.0,
        StatusCode::ACCEPTED
    );
    for _ in 0..100 {
        if sink.calls.lock().unwrap().len() >= 3 {
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    let calls = sink.calls.lock().unwrap().clone();
    assert!(calls.iter().any(|(signal, _)| signal == "logs"));
    assert!(calls.iter().any(|(signal, _)| signal == "traces"));
    let metrics = calls
        .iter()
        .find(|(signal, _)| signal == "metrics")
        .expect("Alloy did not forward metrics");
    let request = ExportMetricsServiceRequest::decode(metrics.1.clone()).unwrap();
    for metric in &request.resource_metrics[0].scope_metrics[0].metrics {
        match metric.data.as_ref().unwrap() {
            opentelemetry_proto::tonic::metrics::v1::metric::Data::Sum(sum) => {
                assert_eq!(sum.aggregation_temporality, 2)
            }
            opentelemetry_proto::tonic::metrics::v1::metric::Data::Histogram(histogram) => {
                assert_eq!(histogram.aggregation_temporality, 2)
            }
            _ => panic!("unexpected metric"),
        }
    }
    alloy.kill().await.unwrap();
    alloy.wait().await.unwrap();
}

#[tokio::test]
async fn slow_request_body_times_out_as_retryable_without_forwarding() {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let (sink, _collector, ingress) = fixture().await;
    let mut socket = tokio::net::TcpStream::connect(ingress.url.trim_start_matches("http://"))
        .await
        .unwrap();
    let headers = format!(
        "POST /v1/events HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\nAuthorization: Bearer {}\r\nContent-Length: 100\r\nConnection: close\r\n\r\n",
        "a".repeat(64)
    );
    socket.write_all(headers.as_bytes()).await.unwrap();
    let mut bytes = Vec::new();
    tokio::time::timeout(Duration::from_secs(4), socket.read_to_end(&mut bytes))
        .await
        .unwrap()
        .unwrap();
    assert!(
        String::from_utf8(bytes)
            .unwrap()
            .starts_with("HTTP/1.1 408")
    );
    assert!(sink.calls.lock().unwrap().is_empty());
}

#[tokio::test]
async fn run_evidence_preserves_actual_counts_without_high_cardinality_metric_labels() {
    let (sink, _collector, ingress) = fixture().await;
    let run = serde_json::json!({"version":1,"runId":"e".repeat(32),"source":"local_test","suite":"javascript","identity":{"version":"0.1.0","revision":"b".repeat(40),"dirty":false},"startedUnixMs":unix_ms()-100,"durationMs":100,"outcome":"failure","exitCode":1,"counts":{"total":3,"passed":1,"failed":1,"skipped":1,"cancelled":0,"todo":0,"flaky":0}});
    assert_eq!(
        send_path(&ingress.url, "/v1/runs", false, None, body(&run))
            .await
            .0,
        StatusCode::UNAUTHORIZED
    );
    let mut private = run.clone();
    private["message"] = "PRIVATE_SOURCE SECRET_HEADER".into();
    let rejected = send_path(&ingress.url, "/v1/runs", true, None, body(&private)).await;
    assert_eq!(rejected.0, StatusCode::BAD_REQUEST);
    assert!(!rejected.1.contains("PRIVATE_SOURCE"));
    assert!(sink.calls.lock().unwrap().is_empty());
    assert_eq!(
        send_path(&ingress.url, "/v1/runs", true, None, body(&run))
            .await
            .0,
        StatusCode::ACCEPTED
    );
    {
        let calls = sink.calls.lock().unwrap();
        assert_eq!(calls.len(), 3);
        for (signal, bytes) in calls.iter() {
            match signal.as_str() {
                "logs" => {
                    let logs = ExportLogsServiceRequest::decode(bytes.clone()).unwrap();
                    let log = &logs.resource_logs[0].scope_logs[0].log_records[0];
                    assert_eq!(log.event_name, "scribyra.run");
                    assert_eq!(log.trace_id, vec![0xee; 16]);
                    let text = serde_json::to_string(&log.body).unwrap();
                    use opentelemetry_proto::tonic::common::v1::any_value::Value;
                    if let Some(Value::StringValue(body)) =
                        log.body.as_ref().and_then(|b| b.value.as_ref())
                    {
                        let stored: serde_json::Value = serde_json::from_str(body).unwrap();
                        assert_eq!(stored["counts"], run["counts"]);
                    } else {
                        panic!("Run log must contain typed JSON")
                    }
                    assert!(text.contains("failed"));
                    assert!(!text.contains("PRIVATE_SOURCE"));
                }
                "traces" => {
                    let traces = ExportTraceServiceRequest::decode(bytes.clone()).unwrap();
                    assert_eq!(
                        traces.resource_spans[0].scope_spans[0].spans[0].trace_id,
                        vec![0xee; 16]
                    );
                }
                "metrics" => {
                    use opentelemetry_proto::tonic::metrics::v1::metric::Data;
                    let metrics = ExportMetricsServiceRequest::decode(bytes.clone()).unwrap();
                    let metrics = &metrics.resource_metrics[0].scope_metrics[0].metrics;
                    assert!(metrics.iter().any(|m| m.name == "scribyra_run_cases"));
                    let cases: Vec<_> = metrics
                        .iter()
                        .filter(|m| m.name == "scribyra_run_cases")
                        .collect();
                    assert_eq!(cases.len(), 6);
                    for metric in cases {
                        use opentelemetry_proto::tonic::common::v1::any_value::Value;
                        use opentelemetry_proto::tonic::metrics::v1::number_data_point;
                        if let Data::Sum(sum) = metric.data.as_ref().unwrap() {
                            let point = &sum.data_points[0];
                            let outcome = point
                                .attributes
                                .iter()
                                .find(|a| a.key == "scribyra.case.outcome")
                                .unwrap();
                            if let Some(Value::StringValue(name)) =
                                outcome.value.as_ref().and_then(|v| v.value.as_ref())
                            {
                                let expected = run["counts"][name].as_f64().unwrap();
                                assert_eq!(
                                    point.value,
                                    Some(number_data_point::Value::AsDouble(expected))
                                );
                            } else {
                                panic!("Missing case outcome")
                            }
                        } else {
                            panic!("Case metric must be a sum")
                        }
                    }
                    for metric in metrics {
                        let labels: Vec<_> = match metric.data.as_ref().unwrap() {
                            Data::Sum(sum) => sum
                                .data_points
                                .iter()
                                .flat_map(|p| p.attributes.iter())
                                .collect(),
                            Data::Histogram(hist) => hist
                                .data_points
                                .iter()
                                .flat_map(|p| p.attributes.iter())
                                .collect(),
                            _ => continue,
                        };
                        for label in labels {
                            assert!(
                                !["scribyra.run.id", "scribyra.revision", "scribyra.ci.job_id"]
                                    .contains(&label.key.as_str())
                            );
                        }
                    }
                }
                _ => panic!("Unexpected signal"),
            }
        }
    }
    // A retry has one receipt; changing the actual counts conflicts even though
    // the derived generic test_run event is identical.
    assert_eq!(
        send_path(&ingress.url, "/v1/runs", true, None, body(&run))
            .await
            .0,
        StatusCode::ACCEPTED
    );
    let mut changed = run.clone();
    changed["counts"]["passed"] = 0.into();
    changed["counts"]["failed"] = 2.into();
    assert_eq!(
        send_path(&ingress.url, "/v1/runs", true, None, body(&changed))
            .await
            .0,
        StatusCode::CONFLICT
    );
    assert_eq!(sink.calls.lock().unwrap().len(), 3);
}
