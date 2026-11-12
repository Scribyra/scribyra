//! Versioned, content-free diagnostics shared by browser and native adapters.
//! Clocks, random IDs, storage, and network I/O belong to the caller.
use serde::{Deserialize, Serialize};
use std::collections::VecDeque;
#[cfg(not(target_arch = "wasm32"))]
pub mod native;
pub mod transport;

pub const VERSION: u8 = 1;
pub const MAX_INPUT_BYTES: usize = 2048;
pub const MAX_EVENTS: usize = 256;
pub const MAX_BUFFER_BYTES: usize = 64 * 1024;

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum Operation {
    Startup,
    Compile,
    WorkerPass,
    WorkerStartup,
    RuntimeTransfer,
    TexPass,
    BibliographyPass,
    IndexPass,
    WorkspaceSearch,
    SourceOutline,
    SourceMap,
    CacheEvict,
    TelemetryDrop,
    TelemetrySnapshotDrop,
    TelemetryDelivery,
    PackagePrepare,
    Download,
    Verify,
    Retry,
    Cache,
    PdfPrepare,
    StorageRead,
    StorageCommit,
    StorageQuota,
    Migration,
    Recovery,
    Command,
    Mcp,
    CompanionHttp,
    CompanionConnection,
    Provider,
    LocalTabs,
    NativeSession,
    Sync,
    SyncConnect,
    SyncIo,
    SyncHttp,
    SyncObservationDrop,
    TestRun,
    Exception,
    Rejection,
}
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum Outcome {
    Started,
    Success,
    Failure,
    Cancelled,
    Observed,
}
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum ErrorCategory {
    Unknown,
    Timeout,
    Network,
    Rejected,
    Quota,
    Invalid,
    Integrity,
    Unavailable,
    Source,
    Permission,
    Worker,
    Conflict,
}
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum Runtime {
    Browser,
    Worker,
    Companion,
    Native,
    SyncService,
    Test,
    Ci,
}
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum Measurement {
    DurationMs,
    Bytes,
    MemoryBytes,
    Count,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Metric {
    pub name: Measurement,
    pub value: f64,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Event {
    pub version: u8,
    pub runtime: Runtime,
    pub operation: Operation,
    pub outcome: Outcome,
    pub trace_id: String,
    pub span_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent_span_id: Option<String>,
    /// Monotonic session-relative time; never a wall clock or document timestamp.
    pub elapsed_ms: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<ErrorCategory>,
    #[serde(default)]
    pub metrics: Vec<Metric>,
}

/// What remote consent may do with one operation. The match is exhaustive on
/// purpose: a new operation stays local until someone classifies it here.
#[derive(Clone, Copy, PartialEq)]
enum RemoteUse {
    /// Never leaves the browser: fires per edit, keystroke, search or prompt, so
    /// its timing or size would describe the user's writing.
    Local,
    /// Its name reveals a failure, so it also needs the failures category.
    FailureSignal,
    /// Coarse lifecycle work: startup, compile passes and download preparation.
    Lifecycle,
}
fn remote_use(operation: Operation) -> RemoteUse {
    use Operation::*;
    match operation {
        StorageCommit | LocalTabs | Command | WorkspaceSearch | SourceOutline | SourceMap | Sync
        | SyncConnect | SyncIo | SyncHttp | SyncObservationDrop | Mcp | CompanionHttp
        | CompanionConnection | Provider | NativeSession | TestRun | TelemetryDrop
        | TelemetrySnapshotDrop | TelemetryDelivery => RemoteUse::Local,
        Exception | Rejection | StorageQuota | Retry | Recovery => RemoteUse::FailureSignal,
        Startup | Compile | WorkerPass | WorkerStartup | RuntimeTransfer | TexPass
        | BibliographyPass | IndexPass | CacheEvict | PackagePrepare | Download | Verify | Cache
        | PdfPrepare | StorageRead | Migration => RemoteUse::Lifecycle,
    }
}
/// Sent times are rounded up, so a duration can never exceed its relative time.
pub const REMOTE_TIME_STEP_MS: f64 = 60_000.0;
fn floor_power(value: f64, base: f64) -> f64 {
    if value < 1.0 {
        return 0.0;
    }
    let mut step = 1.0;
    while step * base <= value {
        step *= base;
    }
    step
}
/// Largest of 1, 2, 5, 10, 20, 50... not above the value.
fn floor_one_two_five(value: f64) -> f64 {
    let decade = floor_power(value, 10.0);
    if decade == 0.0 {
        return 0.0;
    }
    [5.0, 2.0, 1.0]
        .into_iter()
        .map(|factor| factor * decade)
        .find(|bucket| *bucket <= value)
        .unwrap_or(decade)
}
fn coarse_metric(name: Measurement, value: f64) -> f64 {
    match name {
        // Factors of four: a size says "about this scale", never which package or
        // how much was written. 2297 catalog archives fit in about ten buckets.
        Measurement::Bytes => floor_power(value, 4.0),
        Measurement::MemoryBytes => floor_power(value, 2.0),
        Measurement::DurationMs | Measurement::Count => floor_one_two_five(value),
    }
}

/// Remote consent projects validated records, independently of local diagnostics.
/// Operation/runtime, random correlation IDs and rounded time are shared metadata.
/// Every value leaving here is coarse; local diagnostics keep their exact values.
pub fn consent_record(input: &str, performance: bool, errors: bool, usage: bool) -> Option<String> {
    let mut event = Event::parse(input).ok()?;
    if event.outcome == Outcome::Started {
        return None;
    }
    match remote_use(event.operation) {
        RemoteUse::Local => return None,
        RemoteUse::FailureSignal if !errors => return None,
        _ => {}
    }
    let failure = errors && event.outcome == Outcome::Failure;
    event.metrics.retain(|metric| match metric.name {
        Measurement::Count => usage,
        _ => performance,
    });
    if !failure && !usage && event.metrics.is_empty() {
        return None;
    }
    if !failure {
        event.outcome = Outcome::Observed;
        event.error = None;
    }
    for metric in &mut event.metrics {
        metric.value = coarse_metric(metric.name, metric.value);
    }
    event.elapsed_ms = (event.elapsed_ms / REMOTE_TIME_STEP_MS).ceil() * REMOTE_TIME_STEP_MS;
    serde_json::to_string(&event).ok()
}
fn valid_id(value: &str, len: usize) -> bool {
    value.len() == len
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        && value.bytes().any(|b| b != b'0')
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TraceContext {
    pub trace_id: String,
    pub span_id: String,
}
impl TraceContext {
    pub fn valid(&self) -> bool {
        valid_id(&self.trace_id, 32) && valid_id(&self.span_id, 16)
    }
}
pub fn deserialize_context<'de, D: serde::Deserializer<'de>>(
    input: D,
) -> Result<Option<TraceContext>, D::Error> {
    let value = Option::<serde_json::Value>::deserialize(input)?;
    Ok(value
        .and_then(|value| serde_json::from_value::<TraceContext>(value).ok())
        .filter(TraceContext::valid))
}

pub fn error_category(code: &str) -> ErrorCategory {
    match code {
        "permission_denied" | "origin_denied" => ErrorCategory::Permission,
        "timeout" => ErrorCategory::Timeout,
        "invalid_request" | "invalid_reply" | "unsupported_version" | "revision_required" => {
            ErrorCategory::Invalid
        }
        "revision_conflict" | "sequence_conflict" | "request_id_reused" | "replayed_pairing" => {
            ErrorCategory::Conflict
        }
        "browser_disconnected" | "project_closed" | "not_found" => ErrorCategory::Unavailable,
        "browser_busy" | "provider_busy" | "provider_error" | "unsupported_input"
        | "session_limit" => ErrorCategory::Rejected,
        "quota" => ErrorCategory::Quota,
        "integrity" => ErrorCategory::Integrity,
        _ => ErrorCategory::Unknown,
    }
}
impl Event {
    pub fn parse(input: &str) -> Result<Self, &'static str> {
        // Return fixed errors: serde's diagnostics may echo untrusted input.
        if input.len() > MAX_INPUT_BYTES {
            return Err("Telemetry record exceeds limit");
        }
        let event: Self = serde_json::from_str(input).map_err(|_| "Invalid telemetry record")?;
        if event.version != VERSION
            || !valid_id(&event.trace_id, 32)
            || !valid_id(&event.span_id, 16)
            || event
                .parent_span_id
                .as_ref()
                .is_some_and(|id| !valid_id(id, 16))
            || !event.elapsed_ms.is_finite()
            || !(0.0..=31_536_000_000.0).contains(&event.elapsed_ms)
            || event.metrics.len() > 4
            || event.error.is_some() && event.outcome != Outcome::Failure
        {
            return Err("Invalid telemetry record");
        }
        for (i, metric) in event.metrics.iter().enumerate() {
            if !metric.value.is_finite()
                || !(0.0..=9_007_199_254_740_991.0).contains(&metric.value)
                || event.metrics[..i]
                    .iter()
                    .any(|other| other.name == metric.name)
            {
                return Err("Invalid telemetry measurement");
            }
        }
        Ok(event)
    }
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Settings {
    pub collect: bool,
    pub allow_export: bool,
}
#[derive(Default)]
pub struct Recorder {
    identity: Option<BuildIdentity>,
    settings: Settings,
    events: VecDeque<(Event, usize)>,
    bytes: usize,
    dropped: u64,
    rejected: u64,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot<'a> {
    version: u8,
    settings: &'a Settings,
    dropped: u64,
    rejected: u64,
    buffered_bytes: usize,
    events: Vec<&'a Event>,
    #[serde(skip_serializing_if = "Option::is_none")]
    identity: &'a Option<BuildIdentity>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BuildIdentity {
    pub version: String,
    pub revision: Option<String>,
    pub dirty: bool,
    pub compiler_adapter_sha256: Option<String>,
}
impl Recorder {
    pub fn set_identity(&mut self, input: &str) -> Result<(), &'static str> {
        if input.len() > 256 {
            return Err("Invalid build identity");
        }
        let identity: BuildIdentity =
            serde_json::from_str(input).map_err(|_| "Invalid build identity")?;
        let parts: Vec<_> = identity.version.split('.').collect();
        if identity.version.len() > 32
            || parts.len() != 3
            || parts
                .iter()
                .any(|part| part.is_empty() || !part.bytes().all(|b| b.is_ascii_digit()))
            || identity
                .revision
                .as_ref()
                .is_some_and(|id| !valid_id(id, 40) && !valid_id(id, 64))
            || identity
                .compiler_adapter_sha256
                .as_ref()
                .is_some_and(|id| !valid_id(id, 64))
        {
            return Err("Invalid build identity");
        }
        self.identity = Some(identity);
        Ok(())
    }
    pub fn configure(&mut self, settings: Settings) {
        if !settings.collect {
            self.clear();
        }
        self.settings = settings;
    }
    pub fn clear(&mut self) {
        self.events.clear();
        self.bytes = 0;
        self.dropped = 0;
        self.rejected = 0;
    }
    pub fn record(&mut self, input: &str) -> bool {
        if !self.settings.collect {
            return false;
        }
        let Ok(event) = Event::parse(input) else {
            self.rejected = self.rejected.saturating_add(1);
            return false;
        };
        let size = serde_json::to_vec(&event)
            .expect("validated finite event")
            .len();
        while self.events.len() >= MAX_EVENTS || self.bytes + size > MAX_BUFFER_BYTES {
            if let Some((_, size)) = self.events.pop_front() {
                self.bytes -= size;
            }
            self.dropped = self.dropped.saturating_add(1);
        }
        self.bytes += size;
        self.events.push_back((event, size));
        true
    }
    pub fn snapshot(&self) -> String {
        serde_json::to_string(&Snapshot {
            version: VERSION,
            settings: &self.settings,
            dropped: self.dropped,
            rejected: self.rejected,
            buffered_bytes: self.bytes,
            events: self.events.iter().map(|(e, _)| e).collect(),
            identity: &self.identity,
        })
        .expect("validated finite events")
    }
    pub fn export(&self) -> Result<String, &'static str> {
        if !self.settings.allow_export {
            return Err("Diagnostic export is disabled");
        }
        Ok(self.snapshot())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn build_identity_has_only_bounded_public_release_fields() {
        let mut recorder = Recorder::default();
        let identity = serde_json::json!({"version":"0.1.0","revision":"a".repeat(40),"dirty":true,"compilerAdapterSha256":"b".repeat(64)});
        assert!(recorder.set_identity(&identity.to_string()).is_ok());
        for patch in [
            serde_json::json!({"version":"PRIVATE_SOURCE"}),
            serde_json::json!({"revision":"https://SECRET.invalid"}),
            serde_json::json!({"compilerAdapterSha256":"PRIVATE_PATH"}),
            serde_json::json!({"token":"SEEDED_SECRET"}),
        ] {
            let mut invalid = identity.clone();
            for (key, value) in patch.as_object().unwrap() {
                invalid[key] = value.clone();
            }
            assert_eq!(
                recorder.set_identity(&invalid.to_string()).unwrap_err(),
                "Invalid build identity"
            );
        }
        assert!(!recorder.snapshot().contains("SECRET"));
    }
    fn event() -> serde_json::Value {
        serde_json::json!({"version":1,"runtime":"browser","operation":"compile",
            "outcome":"failure","traceId":"123456789abcdef0123456789abcdef0",
            "spanId":"123456789abcdef0","elapsedMs":1,"error":"timeout","metrics":[]})
    }
    #[test]
    fn resource_observations_do_not_imply_a_known_success_or_accept_error_text() {
        let mut value = event();
        value["operation"] = "runtime_transfer".into();
        value["outcome"] = "observed".into();
        value.as_object_mut().unwrap().remove("error");
        let parsed = Event::parse(&value.to_string()).unwrap();
        assert_eq!(parsed.outcome, Outcome::Observed);
        value["error"] = "network".into();
        assert!(Event::parse(&value.to_string()).is_err());
    }
    #[test]
    fn rejects_content_and_returns_only_fixed_errors() {
        for key in [
            "message",
            "source",
            "url",
            "headers",
            "file",
            "projectName",
            "log",
        ] {
            let mut e = event();
            e[key] = "PRIVATE_SOURCE Bearer SEEDED_SECRET".into();
            assert_eq!(
                Event::parse(&e.to_string()).unwrap_err(),
                "Invalid telemetry record"
            );
        }
        for key in [
            "operation",
            "runtime",
            "outcome",
            "error",
            "traceId",
            "spanId",
        ] {
            let mut e = event();
            e[key] = "PRIVATE_SOURCE".into();
            assert!(Event::parse(&e.to_string()).is_err());
        }
        assert!(Event::parse(&"x".repeat(MAX_INPUT_BYTES + 1)).is_err());
    }
    #[test]
    fn validates_correlation_and_measurement_bounds() {
        assert!(Event::parse(&event().to_string()).is_ok());
        for patch in [
            serde_json::json!({"version":2}),
            serde_json::json!({"elapsedMs":-1}),
            serde_json::json!({"spanId":"0000000000000000"}),
            serde_json::json!({"parentSpanId":"path/paper.tex"}),
            serde_json::json!({"outcome":"success"}),
            serde_json::json!({"metrics":[{"name":"bytes","value":-1}]}),
            serde_json::json!({"metrics":[{"name":"count","value":1},{"name":"count","value":2}]}),
        ] {
            let mut e = event();
            for (k, v) in patch.as_object().unwrap() {
                e[k] = v.clone();
            }
            assert!(Event::parse(&e.to_string()).is_err(), "{e}");
        }
    }
    fn projected(operation: &str, metrics: serde_json::Value) -> Option<Event> {
        let mut value = event();
        value["operation"] = operation.into();
        value["outcome"] = "success".into();
        value["elapsedMs"] = 61_234.5.into();
        value["metrics"] = metrics;
        value.as_object_mut().unwrap().remove("error");
        consent_record(&value.to_string(), true, true, true).map(|e| Event::parse(&e).unwrap())
    }
    #[test]
    fn per_edit_and_agent_operations_never_leave_with_any_consent() {
        for operation in [
            "storage_commit",
            "local_tabs",
            "command",
            "workspace_search",
            "source_outline",
            "source_map",
            "sync",
            "sync_connect",
            "sync_io",
            "sync_http",
            "sync_observation_drop",
            "mcp",
            "companion_http",
            "companion_connection",
            "provider",
            "native_session",
            "test_run",
            "telemetry_drop",
            "telemetry_snapshot_drop",
            "telemetry_delivery",
        ] {
            assert!(
                projected(operation, serde_json::json!([{"name":"bytes","value":2466}])).is_none(),
                "{operation}"
            );
        }
    }
    #[test]
    fn failure_signals_need_the_failures_category() {
        let mut value = event();
        value["outcome"] = "success".into();
        value["metrics"] = serde_json::json!([{"name":"count","value":1}]);
        value.as_object_mut().unwrap().remove("error");
        for operation in ["retry", "recovery", "exception", "rejection", "storage_quota"] {
            value["operation"] = operation.into();
            let encoded = value.to_string();
            assert!(consent_record(&encoded, true, false, true).is_none(), "{operation}");
            assert!(consent_record(&encoded, false, true, true).is_some(), "{operation}");
        }
    }
    #[test]
    fn sent_values_are_coarse_and_cannot_separate_close_sizes_or_moments() {
        let event = projected(
            "compile",
            serde_json::json!([
                {"name":"duration_ms","value":1234.5},
                {"name":"bytes","value":8556},
                {"name":"memory_bytes","value":70_000_000},
                {"name":"count","value":37}
            ]),
        )
        .unwrap();
        assert_eq!(event.elapsed_ms, 120_000.0);
        let values: Vec<_> = event.metrics.iter().map(|m| m.value).collect();
        assert_eq!(values, [1000.0, 4096.0, 67_108_864.0, 20.0]);
        for (bytes, bucket) in [
            (0.0, 0.0),
            (1.0, 1.0),
            (3.0, 1.0),
            (2466.0, 1024.0),
            (4095.0, 1024.0),
            (13962.0, 4096.0),
        ] {
            assert_eq!(coarse_metric(Measurement::Bytes, bytes), bucket);
        }
        for (value, bucket) in [(0.4, 0.0), (1.9, 1.0), (4.9, 2.0), (199.0, 100.0), (500.0, 500.0)] {
            assert_eq!(coarse_metric(Measurement::DurationMs, value), bucket);
        }
    }
    #[test]
    fn coarse_records_still_pass_the_batch_timeline_check() {
        let event = projected("compile", serde_json::json!([{"name":"duration_ms","value":61_234.5}]))
            .unwrap();
        assert!(event.metrics[0].value <= event.elapsed_ms);
    }
    #[test]
    fn disabled_export_controls_and_bounded_eviction() {
        let mut r = Recorder::default();
        let e = event().to_string();
        assert!(!r.record(&e));
        assert!(r.export().is_err());
        r.configure(Settings {
            collect: true,
            allow_export: true,
        });
        for _ in 0..300 {
            assert!(r.record(&e));
        }
        assert_eq!(r.events.len(), MAX_EVENTS);
        assert_eq!(r.dropped, 44);
        assert!(r.bytes <= MAX_BUFFER_BYTES);
        assert!(!r.record("SEEDED_SECRET"));
        assert!(!r.export().unwrap().contains("SEEDED_SECRET"));
        assert_eq!(r.rejected, 1);
        r.configure(Settings::default());
        assert!(r.events.is_empty());
        assert_eq!(r.bytes, 0);
        assert!(r.export().is_err());
    }
}
