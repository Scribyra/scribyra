//! Explicit Faro JSON projection of already consent-filtered records.
//!
//! The collector requires `meta.sdk.version` and a `meta.session.id` equal to the
//! `X-Faro-Session-Id` header. The session ID is supplied by the caller: random,
//! in memory only, new per page load and rotated after at most four hours. No other
//! session or user fields are ever added.
use super::Batch;
use crate::telemetry::{Measurement, Outcome};
use serde_json::{Value, json};

pub fn batch(
    input: &[u8],
    now_unix_ms: u64,
    usage: bool,
    session_id: &str,
    timestamp: impl Fn(f64) -> Option<String>,
) -> Result<String, &'static str> {
    if !valid_session_id(session_id) {
        return Err("Invalid Faro session ID");
    }
    let batch = Batch::parse(input, now_unix_ms)?;
    let mut app = json!({"name":"scribyra"});
    if let Some(build) = &batch.identity {
        app["version"] = json!(build.version);
        app["release"] = json!(if build.dirty {
            "local-changes"
        } else {
            "clean"
        });
        if let Some(revision) = &build.revision {
            app["gitHash"] = json!(revision);
        }
        if let Some(adapter) = &build.compiler_adapter_sha256 {
            app["bundleId"] = json!(adapter);
        }
    }
    let mut body = json!({"meta":{
        "sdk":{"name":"scribyra","version":env!("CARGO_PKG_VERSION")},
        "app":app,
        "session":{"id":session_id},
    }});
    let mut measurements = Vec::new();
    let mut events = Vec::new();
    let mut exceptions = Vec::new();
    for event in &batch.events {
        if !matches!(event.outcome, Outcome::Observed | Outcome::Failure) {
            return Err("Expected consent-filtered record");
        }
        // Exact sub-minute time is never needed remotely, whatever the caller passed.
        let step = crate::telemetry::REMOTE_TIME_STEP_MS;
        let time = timestamp(((batch.origin_unix_ms as f64 + event.elapsed_ms) / step).floor() * step)
            .ok_or("Invalid Faro timestamp")?;
        let trace = json!({"trace_id":event.trace_id,"span_id":event.span_id});
        let mut context = json!({"runtime":event.runtime,"source":batch.source});
        if let Some(parent) = &event.parent_span_id {
            context["parent_span_id"] = json!(parent);
        }
        if let Some(delivery) = &batch.delivery {
            context["dropped"] = json!(delivery.dropped.to_string());
            context["sampled"] = json!(delivery.sampled.to_string());
            if let Some(rate) = delivery.session_rate {
                let label = super::session_rate_label(rate).ok_or("Invalid session rate")?;
                context["sampling_rate"] = json!(label);
            }
        }
        let mut values = serde_json::Map::new();
        for metric in &event.metrics {
            if metric.name != Measurement::Count {
                let name = serde_json::to_value(metric.name).map_err(|_| "Invalid measurement")?;
                values.insert(
                    name.as_str().ok_or("Invalid measurement")?.into(),
                    json!(metric.value),
                );
            }
        }
        if !values.is_empty() {
            measurements.push(json!({"type":event.operation,"values":values,"timestamp":time,"trace":trace,"context":context}));
        }
        if usage {
            let mut attributes = context.clone();
            if let Some(count) = event.metrics.iter().find(|m| m.name == Measurement::Count) {
                attributes["count"] = json!(count.value.to_string());
            }
            events.push(json!({"name":event.operation,"timestamp":time,"trace":trace,"attributes":attributes}));
        }
        if event.outcome == Outcome::Failure {
            let mut context = context;
            context["outcome"] = json!(event.outcome);
            exceptions.push(json!({"type":event.operation,"value":event.error.unwrap_or(crate::telemetry::ErrorCategory::Unknown),"timestamp":time,"trace":trace,"context":context}));
        }
    }
    for (key, items) in [
        ("measurements", measurements),
        ("events", events),
        ("exceptions", exceptions),
    ] {
        if !items.is_empty() {
            body[key] = Value::Array(items);
        }
    }
    let encoded = serde_json::to_string(&body).map_err(|_| "Invalid Faro batch")?;
    if encoded.len() > super::MAX_BATCH_BYTES {
        return Err("Faro batch exceeds limit");
    }
    Ok(encoded)
}

/// Sixteen lowercase hex digits, not all zero: the only session ID shape accepted.
pub fn valid_session_id(id: &str) -> bool {
    id.len() == 16
        && id.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
        && id.bytes().any(|b| b != b'0')
}

#[cfg(test)]
mod tests {
    use super::valid_session_id;

    #[test]
    fn session_ids_are_sixteen_lowercase_hex_digits() {
        assert!(valid_session_id("0123456789abcdef"));
        for id in ["", "0000000000000000", "0123456789ABCDEF", "0123456789abcde", "0123456789abcdef0", "0123456789abcdeg", "PRIVATE_SOURCE__"] {
            assert!(!valid_session_id(id), "{id}");
        }
    }
}
