//! An export adapter, not a collector: maintained OTLP protobuf models carry only
//! fields already admitted by the shared Rust contract. Alloy handles collection.
use opentelemetry_proto::tonic::{
    collector::{
        logs::v1::ExportLogsServiceRequest, metrics::v1::ExportMetricsServiceRequest,
        trace::v1::ExportTraceServiceRequest,
    },
    common::v1::{AnyValue, InstrumentationScope, KeyValue, any_value},
    logs::v1::{LogRecord, ResourceLogs, ScopeLogs},
    metrics::v1::{self as m, metric, number_data_point},
    resource::v1::Resource,
    trace::v1::{ResourceSpans, ScopeSpans, Span, Status},
};
use prost::Message;
use scribyra_core::telemetry::{Event, Measurement, Outcome, transport::Batch};
use std::collections::BTreeMap;
fn string(value: impl Into<String>) -> AnyValue {
    AnyValue {
        value: Some(any_value::Value::StringValue(value.into())),
    }
}
fn attr(name: &str, value: impl Into<String>) -> KeyValue {
    KeyValue {
        key: name.into(),
        value: Some(string(value)),
        ..Default::default()
    }
}
fn variant(value: serde_json::Value) -> String {
    value.as_str().unwrap().into()
}
fn attributes(
    e: &Event,
    source: scribyra_core::telemetry::transport::ActivitySource,
) -> Vec<KeyValue> {
    let mut result = vec![
        attr("scribyra.source", variant(serde_json::json!(source))),
        attr("scribyra.runtime", variant(serde_json::json!(e.runtime))),
        attr(
            "scribyra.operation",
            variant(serde_json::json!(e.operation)),
        ),
        attr("scribyra.outcome", variant(serde_json::json!(e.outcome))),
    ];
    result.push(attr(
        "scribyra.error",
        e.error
            .map(|e| variant(serde_json::json!(e)))
            .unwrap_or_else(|| "none".into()),
    ));
    result
}
fn detailed(e: &Event, b: &Batch) -> Vec<KeyValue> {
    let mut result = attributes(e, b.source);
    if let Some(identity) = &b.identity {
        result.push(attr("scribyra.build.version", &identity.version));
        result.push(KeyValue {
            key: "scribyra.build.dirty".into(),
            value: Some(AnyValue {
                value: Some(any_value::Value::BoolValue(identity.dirty)),
            }),
            ..Default::default()
        });
        if let Some(rev) = &identity.revision {
            result.push(attr("scribyra.build.revision", rev));
        }
        if let Some(hash) = &identity.compiler_adapter_sha256 {
            result.push(attr("scribyra.build.compiler_adapter_sha256", hash));
        }
    }
    result
}
fn bytes(hex: &str) -> Vec<u8> {
    hex.as_bytes()
        .chunks_exact(2)
        .map(|pair| u8::from_str_radix(std::str::from_utf8(pair).unwrap(), 16).unwrap())
        .collect()
}
fn resource() -> Resource {
    Resource {
        attributes: vec![attr("service.name", "scribyra")],
        ..Default::default()
    }
}
fn scope() -> InstrumentationScope {
    InstrumentationScope {
        name: "scribyra.safe.v1".into(),
        version: env!("CARGO_PKG_VERSION").into(),
        ..Default::default()
    }
}
fn timestamp(batch: &Batch, e: &Event) -> u64 {
    batch.origin_unix_ms * 1_000_000 + (e.elapsed_ms * 1_000_000.0).round() as u64
}
/// Three standard OTLP requests. Arrival timestamps for metrics are serialized by
/// the ingress, independently of client clocks; trace/log times retain the source.
pub(crate) fn encode(batch: &Batch, metric_start: u64, metric_end: u64) -> [Vec<u8>; 3] {
    let mut logs = Vec::new();
    let mut spans = Vec::new();
    let mut metrics = BTreeMap::<String, m::Metric>::new();
    for e in &batch.events {
        let time = timestamp(batch, e);
        let attrs = detailed(e, batch);
        logs.push(LogRecord {
            time_unix_nano: time,
            observed_time_unix_nano: metric_end,
            severity_number: if e.outcome == Outcome::Failure {
                17
            } else if e.outcome == Outcome::Started {
                5
            } else {
                9
            },
            severity_text: if e.outcome == Outcome::Failure {
                "ERROR"
            } else if e.outcome == Outcome::Started {
                "DEBUG"
            } else {
                "INFO"
            }
            .into(),
            body: Some(string(serde_json::to_string(e).unwrap())),
            attributes: attrs.clone(),
            trace_id: bytes(&e.trace_id),
            span_id: bytes(&e.span_id),
            flags: 1,
            event_name: "scribyra.event".into(),
            ..Default::default()
        });
        if e.outcome == Outcome::Started {
            continue;
        }
        let duration = e
            .metrics
            .iter()
            .find(|m| m.name == Measurement::DurationMs)
            .map(|m| m.value)
            .unwrap_or(0.0);
        spans.push(Span {
            trace_id: bytes(&e.trace_id),
            span_id: bytes(&e.span_id),
            parent_span_id: e.parent_span_id.as_deref().map(bytes).unwrap_or_default(),
            flags: 1,
            name: variant(serde_json::json!(e.operation)),
            kind: 1,
            start_time_unix_nano: time.saturating_sub((duration * 1_000_000.0).round() as u64),
            end_time_unix_nano: time,
            attributes: attrs,
            status: Some(Status {
                code: match e.outcome {
                    Outcome::Failure => 2,
                    Outcome::Success => 1,
                    _ => 0,
                },
                message: String::new(),
            }),
            ..Default::default()
        });
        let labels = attributes(e, batch.source);
        let key = serde_json::json!([e.runtime, e.operation, e.outcome, e.error]).to_string();
        counter(
            &mut metrics,
            "scribyra_operation",
            &key,
            &labels,
            1.0,
            metric_start,
            metric_end,
        );
        for value in &e.metrics {
            match value.name {
                Measurement::Count => counter(
                    &mut metrics,
                    "scribyra_measurement_count",
                    &key,
                    &labels,
                    value.value,
                    metric_start,
                    metric_end,
                ),
                name => {
                    let (metric, unit, bounds): (&str, &str, &[f64]) = match name {
                        Measurement::DurationMs => (
                            "scribyra_operation_duration",
                            "ms",
                            &[
                                1., 5., 10., 25., 50., 100., 250., 500., 1000., 2500., 5000.,
                                10000., 30000., 60000., 180000., 1800000.,
                            ],
                        ),
                        Measurement::Bytes => (
                            "scribyra_observed_bytes",
                            "By",
                            &[
                                1024.,
                                16384.,
                                65536.,
                                1048576.,
                                16777216.,
                                67108864.,
                                268435456.,
                                1073741824.,
                                4294967296.,
                            ],
                        ),
                        _ => (
                            "scribyra_observed_memory",
                            "By",
                            &[
                                1048576.,
                                16777216.,
                                67108864.,
                                134217728.,
                                268435456.,
                                536870912.,
                                1073741824.,
                                4294967296.,
                            ],
                        ),
                    };
                    histogram(
                        &mut metrics,
                        metric,
                        unit,
                        &key,
                        &labels,
                        value.value,
                        bounds,
                        metric_start,
                        metric_end,
                    );
                }
            }
        }
    }
    if let Some(delivery) = &batch.delivery {
        let labels = vec![
            attr("scribyra.source", variant(serde_json::json!(batch.source))),
            attr(
                "scribyra.runtime",
                variant(serde_json::json!(delivery.runtime)),
            ),
            attr("scribyra.operation", "telemetry_delivery"),
            attr("scribyra.outcome", "observed"),
            attr("scribyra.error", "none"),
        ];
        let key = variant(serde_json::json!(delivery.runtime));
        counter(
            &mut metrics,
            "scribyra_export_dropped",
            &key,
            &labels,
            delivery.dropped as f64,
            metric_start,
            metric_end,
        );
        counter(
            &mut metrics,
            "scribyra_export_sampled",
            &key,
            &labels,
            delivery.sampled as f64,
            metric_start,
            metric_end,
        );
    }
    [
        ExportLogsServiceRequest {
            resource_logs: vec![ResourceLogs {
                resource: Some(resource()),
                scope_logs: vec![ScopeLogs {
                    scope: Some(scope()),
                    log_records: logs,
                    ..Default::default()
                }],
                ..Default::default()
            }],
        }
        .encode_to_vec(),
        ExportTraceServiceRequest {
            resource_spans: vec![ResourceSpans {
                resource: Some(resource()),
                scope_spans: vec![ScopeSpans {
                    scope: Some(scope()),
                    spans,
                    ..Default::default()
                }],
                ..Default::default()
            }],
        }
        .encode_to_vec(),
        ExportMetricsServiceRequest {
            resource_metrics: vec![m::ResourceMetrics {
                resource: Some(resource()),
                scope_metrics: vec![m::ScopeMetrics {
                    scope: Some(scope()),
                    metrics: metrics.into_values().collect(),
                    ..Default::default()
                }],
                ..Default::default()
            }],
        }
        .encode_to_vec(),
    ]
}
fn counter(
    metrics: &mut BTreeMap<String, m::Metric>,
    name: &str,
    key: &str,
    labels: &[KeyValue],
    value: f64,
    start: u64,
    end: u64,
) {
    let metric = metrics
        .entry(format!("{name}:{key}"))
        .or_insert_with(|| m::Metric {
            name: name.into(),
            unit: "1".into(),
            data: Some(metric::Data::Sum(m::Sum {
                aggregation_temporality: 1,
                is_monotonic: true,
                data_points: vec![m::NumberDataPoint {
                    attributes: labels.into(),
                    start_time_unix_nano: start,
                    time_unix_nano: end,
                    value: Some(number_data_point::Value::AsDouble(0.0)),
                    ..Default::default()
                }],
            })),
            ..Default::default()
        });
    if let Some(metric::Data::Sum(sum)) = &mut metric.data {
        if let Some(number_data_point::Value::AsDouble(n)) = &mut sum.data_points[0].value {
            *n += value;
        }
    }
}
pub(crate) fn encode_run(
    run: &scribyra_core::telemetry::transport::runs::Run,
    start: u64,
    end: u64,
) -> [Vec<u8>; 3] {
    let batch = run.batch();
    let mut encoded = encode(&batch, start, end);
    let mut attrs = vec![
        attr("scribyra.suite", variant(serde_json::json!(run.suite))),
        attr(
            "scribyra.browser",
            run.browser
                .map(|browser| variant(serde_json::json!(browser)))
                .unwrap_or_else(|| "none".into()),
        ),
        attr("scribyra.run.id", &run.run_id),
    ];
    if let Some(ci) = &run.ci {
        for (key, value) in [
            ("scribyra.ci.project_id", ci.project_id),
            ("scribyra.ci.pipeline_id", ci.pipeline_id),
            ("scribyra.ci.job_id", ci.job_id),
        ] {
            attrs.push(attr(key, value.to_string()));
        }
    }
    let mut logs = ExportLogsServiceRequest::decode(encoded[0].as_slice()).unwrap();
    let log = &mut logs.resource_logs[0].scope_logs[0].log_records[0];
    log.body = Some(string(serde_json::to_string(run).unwrap()));
    log.event_name = "scribyra.run".into();
    log.attributes.extend(attrs.clone());
    encoded[0] = logs.encode_to_vec();
    let mut traces = ExportTraceServiceRequest::decode(encoded[1].as_slice()).unwrap();
    traces.resource_spans[0].scope_spans[0].spans[0]
        .attributes
        .extend(attrs);
    encoded[1] = traces.encode_to_vec();
    let mut labels = attributes(&batch.events[0], run.source);
    labels.extend([
        attr("scribyra.suite", variant(serde_json::json!(run.suite))),
        attr(
            "scribyra.browser",
            run.browser
                .map(|browser| variant(serde_json::json!(browser)))
                .unwrap_or_else(|| "none".into()),
        ),
    ]);
    let mut extra = BTreeMap::new();
    counter(&mut extra, "scribyra_run", "run", &labels, 1.0, start, end);
    histogram(
        &mut extra,
        "scribyra_run_duration",
        "ms",
        "run",
        &labels,
        run.duration_ms,
        &[100., 1000., 10000., 60000., 300000., 1800000., 3600000.],
        start,
        end,
    );
    if let Some(counts) = &run.counts {
        for (name, count) in [
            ("passed", counts.passed),
            ("failed", counts.failed),
            ("skipped", counts.skipped),
            ("cancelled", counts.cancelled),
            ("todo", counts.todo),
            ("flaky", counts.flaky),
        ] {
            let mut labels = labels.clone();
            labels.push(attr("scribyra.case.outcome", name));
            counter(
                &mut extra,
                "scribyra_run_cases",
                name,
                &labels,
                count as f64,
                start,
                end,
            );
        }
    }
    let mut metrics = ExportMetricsServiceRequest::decode(encoded[2].as_slice()).unwrap();
    metrics.resource_metrics[0].scope_metrics[0]
        .metrics
        .extend(extra.into_values());
    encoded[2] = metrics.encode_to_vec();
    encoded
}
fn histogram(
    metrics: &mut BTreeMap<String, m::Metric>,
    name: &str,
    unit: &str,
    key: &str,
    labels: &[KeyValue],
    value: f64,
    bounds: &[f64],
    start: u64,
    end: u64,
) {
    let metric = metrics
        .entry(format!("{name}:{key}"))
        .or_insert_with(|| m::Metric {
            name: name.into(),
            unit: unit.into(),
            data: Some(metric::Data::Histogram(m::Histogram {
                aggregation_temporality: 1,
                data_points: vec![m::HistogramDataPoint {
                    attributes: labels.into(),
                    start_time_unix_nano: start,
                    time_unix_nano: end,
                    count: 0,
                    sum: Some(0.0),
                    bucket_counts: vec![0; bounds.len() + 1],
                    explicit_bounds: bounds.into(),
                    ..Default::default()
                }],
            })),
            ..Default::default()
        });
    if let Some(metric::Data::Histogram(histogram)) = &mut metric.data {
        let point = &mut histogram.data_points[0];
        point.count += 1;
        *point.sum.as_mut().unwrap() += value;
        point.bucket_counts[bounds
            .iter()
            .position(|bound| value <= *bound)
            .unwrap_or(bounds.len())] += 1;
        point.min = Some(point.min.map_or(value, |n| n.min(value)));
        point.max = Some(point.max.map_or(value, |n| n.max(value)));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn batch() -> Batch {
        let now = 1_793_790_000_010;
        let value = serde_json::json!({"version":1,"batchId":"a".repeat(32),"originUnixMs":now-10,"identity":{"version":"0.1.0","revision":"d".repeat(40),"dirty":true},"events":[{"version":1,"runtime":"browser","operation":"compile","outcome":"success","traceId":"b".repeat(32),"spanId":"c".repeat(16),"parentSpanId":"e".repeat(16),"elapsedMs":10,"metrics":[{"name":"duration_ms","value":10},{"name":"bytes","value":1024}]}]});
        Batch::parse(&serde_json::to_vec(&value).unwrap(), now).unwrap()
    }
    #[test]
    fn maintained_protobuf_roundtrip_preserves_ids_times_and_finite_metric_labels() {
        let b = batch();
        let encoded = encode(&b, 100, 200);
        let logs = ExportLogsServiceRequest::decode(encoded[0].as_slice()).unwrap();
        let log = &logs.resource_logs[0].scope_logs[0].log_records[0];
        assert_eq!(log.trace_id, vec![0xbb; 16]);
        assert_eq!(log.span_id, vec![0xcc; 8]);
        let traces = ExportTraceServiceRequest::decode(encoded[1].as_slice()).unwrap();
        let span = &traces.resource_spans[0].scope_spans[0].spans[0];
        assert_eq!(span.parent_span_id, vec![0xee; 8]);
        assert_eq!(
            span.end_time_unix_nano - span.start_time_unix_nano,
            10_000_000
        );
        assert_eq!(span.status.as_ref().unwrap().code, 1);
        let metrics = ExportMetricsServiceRequest::decode(encoded[2].as_slice()).unwrap();
        let resource = &metrics.resource_metrics[0];
        assert_eq!(resource.resource.as_ref().unwrap().attributes.len(), 1);
        for metric in &resource.scope_metrics[0].metrics {
            let attrs = match metric.data.as_ref().unwrap() {
                metric::Data::Sum(sum) => &sum.data_points[0].attributes,
                metric::Data::Histogram(histogram) => {
                    assert_eq!(histogram.data_points[0].count, 1);
                    assert_eq!(
                        histogram.data_points[0].bucket_counts.iter().sum::<u64>(),
                        1
                    );
                    &histogram.data_points[0].attributes
                }
                _ => panic!("unexpected metric type"),
            };
            assert_eq!(attrs.len(), 5);
            assert!(attrs.iter().all(|a| {
                [
                    "scribyra.source",
                    "scribyra.runtime",
                    "scribyra.operation",
                    "scribyra.outcome",
                    "scribyra.error",
                ]
                .contains(&a.key.as_str())
            }));
        }
    }
    #[test]
    fn unknown_status_stays_unset_and_started_events_are_logs_only() {
        let mut b = batch();
        b.events[0].outcome = Outcome::Observed;
        let encoded = encode(&b, 100, 200);
        let trace = ExportTraceServiceRequest::decode(encoded[1].as_slice()).unwrap();
        assert_eq!(
            trace.resource_spans[0].scope_spans[0].spans[0]
                .status
                .as_ref()
                .unwrap()
                .code,
            0
        );
        b.events[0].outcome = Outcome::Started;
        b.events[0].metrics.clear();
        let encoded = encode(&b, 100, 200);
        let trace = ExportTraceServiceRequest::decode(encoded[1].as_slice()).unwrap();
        assert!(trace.resource_spans[0].scope_spans[0].spans.is_empty());
        let metrics = ExportMetricsServiceRequest::decode(encoded[2].as_slice()).unwrap();
        assert!(
            metrics.resource_metrics[0].scope_metrics[0]
                .metrics
                .is_empty()
        );
    }
}
