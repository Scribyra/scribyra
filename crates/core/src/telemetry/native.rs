//! Native clocks/IDs, local support export and optional bounded remote delivery.
mod remote;
use super::{
    BuildIdentity, ErrorCategory, Event, Measurement, Metric, Operation, Outcome, Recorder,
    Runtime, Settings, TraceContext, VERSION,
};
pub use remote::RemoteConfig;
use std::{
    fs::{self, OpenOptions},
    io::{self, Write},
    path::{Path, PathBuf},
    sync::{Arc, Condvar, Mutex, OnceLock},
    time::{Duration, Instant},
};

#[derive(Clone)]
pub struct Native(Arc<Inner>);
struct Inner {
    enabled: bool,
    runtime: Runtime,
    origin: Instant,
    recorder: Mutex<(Recorder, u64)>,
    writer: Option<Writer>,
    export_requested: bool,
    remote: Option<remote::Remote>,
    remote_requested: bool,
}
struct Writer {
    state: Arc<(Mutex<Pending>, Condvar)>,
}
#[derive(Default)]
struct Pending {
    job: Option<(u64, String)>,
    latest: Option<u64>,
    completed: Option<u64>,
    ok: bool,
    skipped: u64,
    skipped_total: u64,
    failures: u64,
    closed: bool,
}
impl Writer {
    fn new(directory: PathBuf) -> Option<Self> {
        let state = Arc::new((Mutex::new(Pending::default()), Condvar::new()));
        let worker = state.clone();
        std::thread::Builder::new()
            .name("scribyra-diagnostics".into())
            .spawn(move || {
                let mut owned = None;
                let mut last_write: Option<Instant> = None;
                loop {
                    let (generation, json) = {
                        let (lock, ready) = &*worker;
                        let Ok(mut pending) = lock.lock() else {
                            return;
                        };
                        while pending.job.is_none() && !pending.closed {
                            let Ok(next) = ready.wait(pending) else {
                                return;
                            };
                            pending = next;
                        }
                        if pending.job.is_none() {
                            return;
                        }
                        if let Some(last) = last_write {
                            let pause = Duration::from_millis(250).saturating_sub(last.elapsed());
                            if !pause.is_zero() {
                                drop(pending);
                                std::thread::sleep(pause);
                                continue;
                            }
                        }
                        let (generation, json) = pending.job.take().unwrap();
                        (
                            generation,
                            delivery_metadata(json, pending.skipped_total, pending.failures),
                        )
                    };
                    let result = (|| -> io::Result<()> {
                        if owned.is_none() {
                            let mut root = fs::DirBuilder::new();
                            root.recursive(true);
                            #[cfg(unix)]
                            {
                                use std::os::unix::fs::DirBuilderExt;
                                root.mode(0o700);
                            }
                            root.create(&directory)?;
                            let child =
                                directory.join(format!("scribyra-{}", uuid::Uuid::new_v4()));
                            let mut builder = fs::DirBuilder::new();
                            #[cfg(unix)]
                            {
                                use std::os::unix::fs::DirBuilderExt;
                                builder.mode(0o700);
                            }
                            builder.create(&child)?;
                            owned = Some(child);
                        }
                        write_snapshot(owned.as_ref().unwrap(), &json)
                    })();
                    last_write = Some(Instant::now());
                    let (lock, ready) = &*worker;
                    let Ok(mut pending) = lock.lock() else {
                        return;
                    };
                    pending.completed = Some(generation);
                    pending.ok = result.is_ok();
                    if result.is_err() {
                        pending.failures = pending.failures.saturating_add(1);
                    }
                    ready.notify_all();
                }
            })
            .ok()?;
        Some(Self { state })
    }
    fn enqueue(&self, generation: u64, json: String) {
        let (lock, ready) = &*self.state;
        let Ok(mut pending) = lock.lock() else {
            return;
        };
        if pending.latest.is_some_and(|n| generation <= n) {
            return;
        }
        if pending.job.is_some() {
            pending.skipped = pending.skipped.saturating_add(1);
            pending.skipped_total = pending.skipped_total.saturating_add(1);
        }
        pending.latest = Some(generation);
        pending.job = Some((generation, json));
        ready.notify_all();
    }
    fn skipped(&self) -> u64 {
        self.state
            .0
            .lock()
            .map(|mut p| std::mem::take(&mut p.skipped))
            .unwrap_or(0)
    }
    fn wait(&self, generation: u64, timeout: Duration) -> bool {
        let (lock, ready) = &*self.state;
        let Ok(pending) = lock.lock() else {
            return false;
        };
        ready
            .wait_timeout_while(pending, timeout, |p| {
                p.completed.is_none_or(|n| n < generation)
            })
            .map(|(p, _)| p.completed.is_some_and(|n| n >= generation) && p.ok)
            .unwrap_or(false)
    }
}
fn delivery_metadata(json: String, skipped: u64, failures: u64) -> String {
    let Ok(mut value) = serde_json::from_str::<serde_json::Value>(&json) else {
        return json;
    };
    value["nativeDelivery"] =
        serde_json::json!({"skippedSnapshots":skipped,"writeFailures":failures});
    serde_json::to_string(&value).unwrap_or(json)
}
impl Drop for Writer {
    fn drop(&mut self) {
        if let Ok(mut pending) = self.state.0.lock() {
            pending.closed = true;
            self.state.1.notify_all();
        }
    }
}
fn write_snapshot(directory: &Path, json: &str) -> io::Result<()> {
    let temporary = directory.join("pending.json");
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(&temporary)?;
    let result = (|| {
        file.write_all(json.as_bytes())?;
        file.sync_all()?;
        fs::rename(&temporary, directory.join("snapshot.json"))
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}
impl Native {
    pub fn new(runtime: Runtime, collect: bool, directory: Option<PathBuf>) -> Self {
        Self::build(runtime, collect, directory, None)
    }
    pub fn with_remote(
        runtime: Runtime,
        collect: bool,
        directory: Option<PathBuf>,
        config: RemoteConfig,
    ) -> Self {
        Self::build(runtime, collect, directory, Some(Ok(config)))
    }
    fn build(
        runtime: Runtime,
        collect: bool,
        directory: Option<PathBuf>,
        remote: Option<Result<RemoteConfig, &'static str>>,
    ) -> Self {
        let origin = Instant::now();
        let origin_unix_ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis()
            .min(u64::MAX as u128) as u64;
        let remote_requested = collect && remote.is_some();
        let export_requested = collect && directory.is_some();
        let mut recorder = Recorder::default();
        recorder.configure(Settings {
            collect,
            allow_export: export_requested,
        });
        let revision = std::env::var("SCRIBYRA_BUILD_REVISION")
            .ok()
            .filter(|v| super::valid_id(v, 40) || super::valid_id(v, 64));
        let identity = BuildIdentity {
            version: env!("CARGO_PKG_VERSION").into(),
            dirty: revision.is_none()
                || std::env::var("SCRIBYRA_BUILD_DIRTY").as_deref() != Ok("0"),
            revision,
            compiler_adapter_sha256: None,
        };
        let _ = recorder.set_identity(&serde_json::to_string(&identity).unwrap());
        let writer = if collect {
            directory.and_then(Writer::new)
        } else {
            None
        };
        let remote = if collect {
            remote
                .and_then(Result::ok)
                .and_then(|config| remote::Remote::new(config, runtime, origin_unix_ms, identity))
        } else {
            None
        };
        Self(Arc::new(Inner {
            enabled: collect,
            runtime,
            origin,
            recorder: Mutex::new((recorder, 0)),
            writer,
            export_requested,
            remote,
            remote_requested,
        }))
    }
    pub fn from_env(runtime: Runtime) -> Self {
        let collect = matches!(
            std::env::var("SCRIBYRA_DIAGNOSTICS").as_deref(),
            Ok("1" | "true")
        );
        let directory = std::env::var_os("SCRIBYRA_DIAGNOSTICS_DIR")
            .filter(|v| !v.is_empty())
            .map(PathBuf::from);
        let remote = if collect {
            RemoteConfig::from_env()
        } else {
            None
        };
        Self::build(runtime, collect, directory, remote)
    }
    pub fn begin(&self, operation: Operation, parent: Option<&TraceContext>) -> Span {
        if !self.0.enabled || parent.is_some_and(|p| !p.valid()) {
            return Span::inactive();
        }
        let Ok(context) = std::panic::catch_unwind(|| TraceContext {
            trace_id: parent
                .map(|p| p.trace_id.clone())
                .unwrap_or_else(|| uuid::Uuid::new_v4().simple().to_string()),
            span_id: uuid::Uuid::new_v4().simple().to_string()[..16].into(),
        }) else {
            return Span::inactive();
        };
        let span = Span {
            native: Some(self.clone()),
            operation,
            context: Some(context),
            parent: parent.map(|p| p.span_id.clone()),
            started: Some(Instant::now()),
            done: false,
        };
        self.record(span.event(Outcome::Started, None, Vec::new()));
        span
    }
    fn record(&self, event: Option<Event>) {
        let Some(event) = event else {
            return;
        };
        let Ok(mut state) = self.0.recorder.lock() else {
            return;
        };
        if let Some(writer) = &self.0.writer {
            let skipped = writer.skipped();
            if skipped > 0 {
                let mut note = event.clone();
                use sha2::{Digest, Sha256};
                let digest = Sha256::digest(
                    format!("{}:{}:snapshot-drop", event.span_id, state.1).as_bytes(),
                );
                note.parent_span_id = Some(event.span_id.clone());
                note.span_id = digest[..8]
                    .iter()
                    .map(|byte| format!("{byte:02x}"))
                    .collect();
                note.operation = Operation::TelemetrySnapshotDrop;
                note.outcome = Outcome::Success;
                note.error = None;
                note.metrics = vec![Metric {
                    name: Measurement::Count,
                    value: skipped.min(9_007_199_254_740_991) as f64,
                }];
                let _ = state.0.record(&serde_json::to_string(&note).unwrap());
            }
        }
        let encoded = serde_json::to_string(&event).unwrap();
        if !state.0.record(&encoded) {
            return;
        }
        state.1 = state.1.saturating_add(1);
        if let Some(remote) = &self.0.remote {
            remote.enqueue(encoded, &event.trace_id);
        }
        if let Some(writer) = &self.0.writer {
            if let Ok(json) = state.0.export() {
                writer.enqueue(state.1, self.remote_metadata(json));
            }
        }
    }
    pub fn snapshot(&self) -> String {
        self.remote_metadata(
            self.0
                .recorder
                .lock()
                .map(|state| state.0.snapshot())
                .unwrap_or_else(|_| "{}".into()),
        )
    }
    fn remote_metadata(&self, json: String) -> String {
        if !self.0.remote_requested {
            return json;
        }
        let Ok(mut value) = serde_json::from_str::<serde_json::Value>(&json) else {
            return json;
        };
        value["remoteDelivery"] = self
            .0
            .remote
            .as_ref()
            .map(|remote| serde_json::to_value(remote.status()).unwrap())
            .unwrap_or_else(|| serde_json::json!({"enabled":false,"error":"configuration"}));
        serde_json::to_string(&value).unwrap_or(json)
    }
    pub fn flush(&self, timeout: Duration) -> bool {
        let started = Instant::now();
        // Reserve time for the independent local support file even when HTTP is
        // slow. Capture remote counters after this bounded delivery wait.
        let remote_budget = if self.0.export_requested {
            timeout / 2
        } else {
            timeout
        };
        let remote = match &self.0.remote {
            Some(remote) => remote.flush(remote_budget),
            None => !self.0.remote_requested,
        };
        let local = self.flush_local(timeout.saturating_sub(started.elapsed()));
        local && remote
    }
    fn flush_local(&self, timeout: Duration) -> bool {
        if !self.0.export_requested {
            return true;
        }
        let Some(writer) = &self.0.writer else {
            return false;
        };
        let (generation, json) = {
            let Ok(mut state) = self.0.recorder.lock() else {
                return false;
            };
            let Ok(json) = state.0.export() else {
                return false;
            };
            if self.0.remote_requested {
                state.1 = state.1.saturating_add(1);
            }
            (state.1, json)
        };
        writer.enqueue(generation, self.remote_metadata(json));
        writer.wait(generation, timeout)
    }
}
pub struct Span {
    native: Option<Native>,
    operation: Operation,
    context: Option<TraceContext>,
    parent: Option<String>,
    started: Option<Instant>,
    done: bool,
}
impl Span {
    fn inactive() -> Self {
        Self {
            native: None,
            operation: Operation::Startup,
            context: None,
            parent: None,
            started: None,
            done: true,
        }
    }
    pub fn context(&self) -> Option<TraceContext> {
        self.context.clone()
    }
    fn event(
        &self,
        outcome: Outcome,
        error: Option<ErrorCategory>,
        metrics: Vec<Metric>,
    ) -> Option<Event> {
        let native = self.native.as_ref()?;
        let context = self.context.as_ref()?;
        Some(Event {
            version: VERSION,
            runtime: native.0.runtime,
            operation: self.operation,
            outcome,
            trace_id: context.trace_id.clone(),
            span_id: context.span_id.clone(),
            parent_span_id: self.parent.clone(),
            elapsed_ms: native.0.origin.elapsed().as_secs_f64() * 1000.0,
            error,
            metrics,
        })
    }
    pub fn finish(&mut self, outcome: Outcome, error: Option<ErrorCategory>) {
        if self.done {
            return;
        }
        self.done = true;
        let metrics = vec![Metric {
            name: Measurement::DurationMs,
            value: self.started.unwrap().elapsed().as_secs_f64() * 1000.0,
        }];
        if let Some(native) = &self.native {
            native.record(self.event(outcome, error, metrics));
        }
    }
    pub fn success(&mut self) {
        self.finish(Outcome::Success, None);
    }
    pub fn error(&mut self, code: &str) {
        if code == "cancelled" {
            self.finish(Outcome::Cancelled, None);
        } else {
            self.finish(Outcome::Failure, Some(super::error_category(code)));
        }
    }
    pub fn io_error(&mut self, error: &io::Error) {
        self.error(match error.kind() {
            io::ErrorKind::PermissionDenied => "permission_denied",
            io::ErrorKind::NotFound => "not_found",
            io::ErrorKind::InvalidInput | io::ErrorKind::InvalidData => "invalid_request",
            _ => "unknown",
        });
    }
}
impl Drop for Span {
    fn drop(&mut self) {
        self.finish(Outcome::Cancelled, None);
    }
}
static GLOBAL: OnceLock<Native> = OnceLock::new();
pub fn initialize(runtime: Runtime) -> &'static Native {
    GLOBAL.get_or_init(|| Native::from_env(runtime))
}
pub fn global() -> &'static Native {
    initialize(Runtime::Native)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn directory() -> PathBuf {
        std::env::temp_dir().join(format!("PRIVATE_DIAGNOSTICS_{}", uuid::Uuid::new_v4()))
    }
    #[test]
    fn disabled_collection_has_no_context_or_filesystem_work() {
        let root = directory();
        let native = Native::new(Runtime::Native, false, Some(root.clone()));
        let mut span = native.begin(Operation::NativeSession, None);
        assert!(span.context().is_none());
        span.success();
        assert!(native.flush(Duration::from_secs(1)));
        assert!(!root.exists());
        assert!(
            serde_json::from_str::<serde_json::Value>(&native.snapshot()).unwrap()["events"]
                .as_array()
                .unwrap()
                .is_empty()
        );
    }
    #[test]
    fn correlation_typed_errors_and_cancelled_futures_share_the_closed_schema() {
        let native = Native::new(Runtime::Companion, true, None);
        let mut root = native.begin(Operation::Mcp, None);
        let context = root.context().unwrap();
        {
            let mut child = native.begin(Operation::Command, Some(&context));
            child.error("permission_denied");
        }
        {
            let _cancelled = native.begin(Operation::Provider, Some(&context));
        }
        root.success();
        let snapshot: serde_json::Value = serde_json::from_str(&native.snapshot()).unwrap();
        assert!(
            snapshot["events"]
                .as_array()
                .unwrap()
                .iter()
                .any(|e| e["parentSpanId"] == context.span_id && e["error"] == "permission")
        );
        assert!(
            snapshot["events"]
                .as_array()
                .unwrap()
                .iter()
                .any(|e| e["operation"] == "provider" && e["outcome"] == "cancelled")
        );
        for _ in 0..400 {
            native.begin(Operation::Command, None).success();
        }
        let snapshot: serde_json::Value = serde_json::from_str(&native.snapshot()).unwrap();
        assert!(snapshot["events"].as_array().unwrap().len() <= super::super::MAX_EVENTS);
        assert!(
            snapshot["bufferedBytes"].as_u64().unwrap() <= super::super::MAX_BUFFER_BYTES as u64
        );
    }
    #[test]
    fn optional_export_is_atomic_private_and_excludes_its_path() {
        let root = directory();
        let native = Native::new(Runtime::Native, true, Some(root.clone()));
        for _ in 0..100 {
            native.begin(Operation::NativeSession, None).success();
        }
        assert!(native.flush(Duration::from_secs(3)));
        let children = fs::read_dir(&root)
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        assert_eq!(children.len(), 1);
        let path = children[0].path().join("snapshot.json");
        let text = fs::read_to_string(&path).unwrap();
        assert!(!text.contains("PRIVATE_DIAGNOSTICS"));
        let data: serde_json::Value = serde_json::from_str(&text).unwrap();
        assert_eq!(data["version"], 1);
        assert_eq!(
            data["events"].as_array().unwrap().last().unwrap()["outcome"],
            "success"
        );
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(&path).unwrap().permissions().mode() & 0o777,
                0o600
            );
            assert_eq!(
                fs::metadata(children[0].path())
                    .unwrap()
                    .permissions()
                    .mode()
                    & 0o777,
                0o700
            );
        }
        drop(native);
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn unavailable_export_does_not_change_operation_results() {
        let root = directory();
        fs::write(&root, b"PRIVATE_FILE").unwrap();
        let native = Native::new(Runtime::Native, true, Some(root.clone()));
        let mut span = native.begin(Operation::NativeSession, None);
        let result = 42;
        span.success();
        assert_eq!(result, 42);
        assert!(!native.flush(Duration::from_secs(1)));
        assert_eq!(fs::read(&root).unwrap(), b"PRIVATE_FILE");
        drop(native);
        fs::remove_file(root).unwrap();
    }
}
