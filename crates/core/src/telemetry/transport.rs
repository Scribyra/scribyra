//! Bounded wire contract for optional ingestion. No endpoints or credentials.
use super::{BuildIdentity, Event, Measurement, Outcome, Recorder, Runtime, VERSION, valid_id};
use serde::{Deserialize, Serialize};
pub const MAX_BATCH_BYTES: usize = 64 * 1024;
pub const MAX_BATCH_EVENTS: usize = 64;
#[derive(Clone, Copy, Debug, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum ActivitySource {
    #[default]
    Application,
    LocalTest,
    Ci,
    Synthetic,
}
pub mod runs;
pub mod faro;
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DeliveryCounts {
    pub runtime: Runtime,
    pub dropped: u64,
    pub sampled: u64,
    /// Build-time share of anonymous browser sessions that send at all, so a
    /// dashboard can scale counts. Absent for native and token connections.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_rate: Option<f64>,
}
/// The only session sampling rates a build may choose, as their wire strings.
pub const SESSION_RATES: [(f64, &str); 5] = [
    (1.0, "1"),
    (0.5, "0.5"),
    (0.25, "0.25"),
    (0.1, "0.1"),
    (0.01, "0.01"),
];
pub fn session_rate_label(rate: f64) -> Option<&'static str> {
    SESSION_RATES.iter().find(|(value, _)| *value == rate).map(|(_, label)| *label)
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Batch {
    pub version: u8,
    pub batch_id: String,
    pub origin_unix_ms: u64,
    #[serde(default)]
    pub source: ActivitySource,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub identity: Option<BuildIdentity>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub delivery: Option<DeliveryCounts>,
    pub events: Vec<Event>,
}
impl Batch {
    pub fn parse(input: &[u8], now_unix_ms: u64) -> Result<Self, &'static str> {
        if input.len() > MAX_BATCH_BYTES {
            return Err("Batch exceeds limit");
        }
        let batch: Self = serde_json::from_slice(input).map_err(|_| "Invalid batch")?;
        if batch.version != VERSION
            || !valid_id(&batch.batch_id, 32)
            || batch.events.is_empty()
            || batch.events.len() > MAX_BATCH_EVENTS
            || batch.origin_unix_ms < 1_577_836_800_000
            || batch.origin_unix_ms > now_unix_ms.saturating_add(300_000)
        {
            return Err("Invalid batch");
        }
        if batch
            .delivery
            .as_ref()
            .is_some_and(|d| d.dropped > 9_007_199_254_740_991 || d.sampled > 9_007_199_254_740_991)
        {
            return Err("Invalid delivery counts");
        }
        if batch
            .delivery
            .as_ref()
            .and_then(|d| d.session_rate)
            .is_some_and(|rate| session_rate_label(rate).is_none())
        {
            return Err("Invalid session rate");
        }
        if let Some(identity) = &batch.identity {
            Recorder::default()
                .set_identity(&serde_json::to_string(identity).map_err(|_| "Invalid batch")?)?;
        }
        for event in &batch.events {
            let json = serde_json::to_string(event).map_err(|_| "Invalid batch")?;
            Event::parse(&json)?;
            let end = batch.origin_unix_ms as f64 + event.elapsed_ms;
            if end < now_unix_ms.saturating_sub(86_400_000) as f64
                || end > now_unix_ms.saturating_add(300_000) as f64
                || event.parent_span_id.as_ref() == Some(&event.span_id)
                || (event.outcome == Outcome::Started && !event.metrics.is_empty())
                || event.metrics.iter().any(|m| {
                    m.name == Measurement::DurationMs
                        && (m.value > event.elapsed_ms + 1.0 || m.value > 31_536_000_000.0)
                })
            {
                return Err("Invalid batch timeline");
            }
        }
        Ok(batch)
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    fn value() -> serde_json::Value {
        serde_json::json!({"version":1,"batchId":"a".repeat(32),"originUnixMs":1_793_790_000_000u64,"events":[{"version":1,"runtime":"browser","operation":"compile","outcome":"success","traceId":"b".repeat(32),"spanId":"c".repeat(16),"elapsedMs":10,"metrics":[{"name":"duration_ms","value":10}]}]})
    }
    fn parse(v: &serde_json::Value) -> Result<Batch, &'static str> {
        Batch::parse(&serde_json::to_vec(v).unwrap(), 1_793_790_000_010)
    }
    #[test]
    fn rejects_private_fields_and_invalid_identity_before_ingestion() {
        assert!(parse(&value()).is_ok());
        for field in ["source", "headers", "url", "token", "projectId"] {
            let mut v = value();
            v[field] = "PRIVATE_SOURCE Bearer SECRET".into();
            assert!(parse(&v).is_err());
            let mut v = value();
            v["events"][0][field] = "PRIVATE_SOURCE".into();
            assert!(parse(&v).is_err());
        }
        let mut v = value();
        v["identity"] = serde_json::json!({"version":"PRIVATE_SOURCE","dirty":true});
        assert!(parse(&v).is_err());
    }
    #[test]
    fn session_rate_is_optional_and_closed() {
        let mut v = value();
        v["delivery"] = serde_json::json!({"runtime":"browser","dropped":0,"sampled":0});
        assert_eq!(parse(&v).unwrap().delivery.unwrap().session_rate, None);
        for (rate, label) in SESSION_RATES {
            v["delivery"]["sessionRate"] = rate.into();
            assert_eq!(parse(&v).unwrap().delivery.unwrap().session_rate, Some(rate));
            assert_eq!(session_rate_label(rate), Some(label));
        }
        for bad in [
            serde_json::json!(0),
            serde_json::json!(0.3),
            serde_json::json!(2),
            serde_json::json!(-1),
            serde_json::json!("0.5"),
            serde_json::json!(null),
        ] {
            v["delivery"]["sessionRate"] = bad.clone();
            if bad.is_null() {
                assert!(parse(&v).is_ok());
            } else {
                assert!(parse(&v).is_err(), "{bad}");
            }
        }
    }
    #[test]
    fn count_body_clock_and_duration_bounds_apply_to_the_entire_batch() {
        let mut v = value();
        v["events"] = serde_json::json!(vec![v["events"][0].clone(); 65]);
        assert!(parse(&v).is_err());
        assert!(Batch::parse(&vec![b' '; MAX_BATCH_BYTES + 1], 0).is_err());
        for (field, number) in [("originUnixMs", 0), ("originUnixMs", 1_793_790_400_000u64)] {
            let mut v = value();
            v[field] = number.into();
            assert!(parse(&v).is_err());
        }
        let mut v = value();
        v["events"][0]["metrics"][0]["value"] = 100.into();
        assert!(parse(&v).is_err());
        let mut v = value();
        v["events"][0]["parentSpanId"] = "c".repeat(16).into();
        assert!(parse(&v).is_err());
    }
}
