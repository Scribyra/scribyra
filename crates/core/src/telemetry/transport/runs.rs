//! Closed, content-free evidence of an actual test/build process.
use super::{ActivitySource, Batch};
use crate::telemetry::{
    BuildIdentity, ErrorCategory, Event, Measurement, Metric, Operation, Outcome, Runtime, VERSION,
    valid_id,
};
use serde::{Deserialize, Serialize};
pub const MAX_RUN_BYTES: usize = 4096;
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum Suite {
    Rust,
    Javascript,
    Browser,
    Build,
    FaultValidation,
}
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum Browser {
    Chromium,
    Firefox,
    Webkit,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Counts {
    pub total: u32,
    pub passed: u32,
    pub failed: u32,
    pub skipped: u32,
    pub cancelled: u32,
    pub todo: u32,
    pub flaky: u32,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Ci {
    pub project_id: u64,
    pub pipeline_id: u64,
    pub job_id: u64,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Run {
    pub version: u8,
    pub run_id: String,
    pub source: ActivitySource,
    pub suite: Suite,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub browser: Option<Browser>,
    pub identity: BuildIdentity,
    pub started_unix_ms: u64,
    pub duration_ms: f64,
    pub outcome: Outcome,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub exit_code: Option<i16>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub counts: Option<Counts>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ci: Option<Ci>,
}
impl Run {
    pub fn parse(input: &[u8], now: u64) -> Result<Self, &'static str> {
        if input.len() > MAX_RUN_BYTES {
            return Err("Run evidence exceeds limit");
        }
        let run: Self = serde_json::from_slice(input).map_err(|_| "Invalid run evidence")?;
        if run.version != VERSION
            || !valid_id(&run.run_id, 32)
            || run.source == ActivitySource::Application
            || !run.duration_ms.is_finite()
            || !(0.0..=86_400_000.0).contains(&run.duration_ms)
            || run.started_unix_ms < now.saturating_sub(86_400_000)
            || run.started_unix_ms < 1_577_836_800_000
            || run.started_unix_ms as f64 + run.duration_ms > now.saturating_add(300_000) as f64
            || !matches!(
                run.outcome,
                Outcome::Success | Outcome::Failure | Outcome::Cancelled
            )
            || run.exit_code.is_some_and(|code| !(0..=255).contains(&code))
            || run.outcome == Outcome::Success && run.exit_code != Some(0)
            || run.outcome == Outcome::Failure && run.exit_code == Some(0)
            || run.suite != Suite::Browser && run.browser.is_some()
            || run.source == ActivitySource::Ci && run.ci.is_none()
            || run.source != ActivitySource::Ci && run.ci.is_some()
        {
            return Err("Invalid run evidence");
        }
        if let Some(ci) = &run.ci {
            if [ci.project_id, ci.pipeline_id, ci.job_id]
                .iter()
                .any(|id| *id == 0 || *id > 9_007_199_254_740_991)
            {
                return Err("Invalid CI identity");
            }
        }
        if let Some(counts) = &run.counts {
            let sum = counts.passed as u64
                + counts.failed as u64
                + counts.skipped as u64
                + counts.cancelled as u64
                + counts.todo as u64;
            if sum != counts.total as u64
                || counts.total > 1_000_000
                || counts.flaky > counts.passed
                || run.suite == Suite::Build
                || run.outcome == Outcome::Success && (counts.failed > 0 || counts.cancelled > 0)
            {
                return Err("Invalid test counts");
            }
        }
        let batch = run.batch();
        Batch::parse(
            &serde_json::to_vec(&batch).map_err(|_| "Invalid run evidence")?,
            now,
        )?;
        Ok(run)
    }
    pub fn batch(&self) -> Batch {
        let span_id = self.run_id[..16].to_owned();
        // run IDs are UUIDv4-compatible random IDs. Handle a valid all-zero
        // prefix without constructing an invalid span ID.
        let span_id = if valid_id(&span_id, 16) {
            span_id
        } else {
            self.run_id[16..].into()
        };
        Batch {
            version: VERSION,
            batch_id: self.run_id.clone(),
            source: self.source,
            origin_unix_ms: self.started_unix_ms,
            identity: Some(self.identity.clone()),
            delivery: None,
            events: vec![Event {
                version: VERSION,
                runtime: if self.source == ActivitySource::Ci {
                    Runtime::Ci
                } else {
                    Runtime::Test
                },
                operation: Operation::TestRun,
                outcome: self.outcome,
                trace_id: self.run_id.clone(),
                span_id,
                parent_span_id: None,
                elapsed_ms: self.duration_ms,
                error: if self.outcome == Outcome::Failure {
                    Some(ErrorCategory::Rejected)
                } else {
                    None
                },
                metrics: vec![Metric {
                    name: Measurement::DurationMs,
                    value: self.duration_ms,
                }],
            }],
        }
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    fn value() -> serde_json::Value {
        serde_json::json!({"version":1,"runId":"a".repeat(32),"source":"local_test","suite":"javascript","identity":{"version":"0.1.0","revision":"b".repeat(40),"dirty":false},"startedUnixMs":1793790000000u64,"durationMs":100,"outcome":"success","exitCode":0,"counts":{"total":3,"passed":2,"failed":0,"skipped":1,"cancelled":0,"todo":0,"flaky":0}})
    }
    fn parse(v: &serde_json::Value) -> Result<Run, &'static str> {
        Run::parse(&serde_json::to_vec(v).unwrap(), 1793790000100)
    }
    #[test]
    fn private_fields_and_incomplete_ci_context_are_rejected() {
        assert!(parse(&value()).is_ok());
        for key in [
            "name",
            "path",
            "message",
            "headers",
            "stdout",
            "artifactUrl",
        ] {
            let mut v = value();
            v[key] = "PRIVATE_SOURCE SECRET".into();
            assert!(parse(&v).is_err());
        }
        let mut v = value();
        v["source"] = "ci".into();
        assert!(parse(&v).is_err());
        v["ci"] = serde_json::json!({"projectId":1,"pipelineId":2,"jobId":3});
        assert!(parse(&v).is_ok());
        v["source"] = "local_test".into();
        assert!(parse(&v).is_err());
    }
    #[test]
    fn counts_outcomes_and_timing_are_consistent() {
        for change in [
            serde_json::json!({"counts":{"total":2,"passed":2,"failed":0,"skipped":1,"cancelled":0,"todo":0,"flaky":0}}),
            serde_json::json!({"outcome":"success","exitCode":1}),
            serde_json::json!({"durationMs":86400001}),
            serde_json::json!({"source":"application"}),
        ] {
            let mut v = value();
            for (k, x) in change.as_object().unwrap() {
                v[k] = x.clone();
            }
            assert!(parse(&v).is_err());
        }
        let mut v = value();
        v["outcome"] = "failure".into();
        v["exitCode"] = 1.into();
        assert!(parse(&v).is_ok());
    }
}
