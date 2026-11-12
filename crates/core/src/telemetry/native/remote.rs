//! Optional native transport of already accepted closed-schema records.
mod resolver;
use super::super::{
    BuildIdentity, Event, Runtime, VERSION,
    transport::{ActivitySource, Batch, DeliveryCounts},
};
use serde::Serialize;
use std::{
    collections::VecDeque,
    fs::File,
    io::Read,
    path::Path,
    sync::{
        Arc, Condvar, Mutex,
        atomic::{AtomicU64, Ordering},
    },
    time::{Duration, Instant},
};
const MAX_EVENTS: usize = 128;
const MAX_BYTES: usize = 32768;
const MAX_AGE: Duration = Duration::from_secs(300);

// Deliberately not Debug/Serialize: destination and credentials never enter status.
pub struct RemoteConfig {
    endpoint: String,
    token: String,
    sample_percent: u8,
    source: ActivitySource,
}
impl RemoteConfig {
    pub fn from_file(endpoint: &str, path: &Path) -> Result<Self, &'static str> {
        // Reject directories/devices/FIFOs before opening (a FIFO open can block).
        let metadata = std::fs::metadata(path).map_err(|_| "Cannot read ingest token")?;
        if !metadata.is_file() || metadata.len() > 66 {
            return Err("Invalid ingest token file");
        }
        let file = File::open(path).map_err(|_| "Cannot read ingest token")?;
        let metadata = file.metadata().map_err(|_| "Cannot read ingest token")?;
        if !metadata.is_file() || metadata.len() > 66 {
            return Err("Invalid ingest token file");
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            if metadata.permissions().mode() & 0o077 != 0 {
                return Err("Ingest token must be owner-only");
            }
        }
        let mut token = String::new();
        file.take(67)
            .read_to_string(&mut token)
            .map_err(|_| "Invalid ingest token file")?;
        Self::new(endpoint, token.trim())
    }
    fn new(endpoint: &str, token: &str) -> Result<Self, &'static str> {
        if endpoint.len() > 2048 {
            return Err("Invalid telemetry destination");
        }
        let url = url::Url::parse(endpoint).map_err(|_| "Invalid telemetry destination")?;
        if !(url.scheme() == "https"
            || url.scheme() == "http"
                && matches!(url.host_str(), Some("127.0.0.1" | "localhost" | "[::1]")))
            || url.host_str().is_none()
            || !url.username().is_empty()
            || url.password().is_some()
            || url.query().is_some()
            || url.fragment().is_some()
            || url.path() != "/v1/events"
        {
            return Err("Invalid telemetry destination");
        }
        if token.len() != 64 || !token.bytes().all(|c| c.is_ascii_hexdigit()) {
            return Err("Invalid ingest token");
        }
        Ok(Self {
            endpoint: url.to_string(),
            token: token.into(),
            sample_percent: 100,
            source: ActivitySource::Application,
        })
    }
    pub fn sampling(mut self, percent: u8) -> Result<Self, &'static str> {
        if ![1, 10, 100].contains(&percent) {
            return Err("Invalid telemetry sample percentage");
        }
        self.sample_percent = percent;
        Ok(self)
    }
    pub(super) fn from_env() -> Option<Result<Self, &'static str>> {
        let endpoint = std::env::var("SCRIBYRA_TELEMETRY_ENDPOINT").ok();
        let file = std::env::var_os("SCRIBYRA_TELEMETRY_TOKEN_FILE");
        if endpoint.is_none() && file.is_none() {
            return None;
        }
        Some(
            match (endpoint, file) {
                (Some(endpoint), Some(file)) => Self::from_file(&endpoint, Path::new(&file))
                    .and_then(
                        |config| match std::env::var("SCRIBYRA_TELEMETRY_SAMPLE_PERCENT") {
                            Ok(value) => value
                                .parse()
                                .map_err(|_| "Invalid telemetry sample percentage")
                                .and_then(|percent| config.sampling(percent)),
                            Err(_) => Ok(config),
                        },
                    ),
                _ => Err("Both destination and token file are required"),
            }
            .and_then(|mut config| {
                if let Ok(source) = std::env::var("SCRIBYRA_TELEMETRY_SOURCE") {
                    config.source = serde_json::from_value(serde_json::Value::String(source))
                        .map_err(|_| "Invalid telemetry source")?;
                }
                Ok(config)
            }),
        )
    }
}
#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "snake_case")]
pub(super) enum Error {
    Unavailable,
    Permission,
    Invalid,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Status {
    pub enabled: bool,
    pub sent: u64,
    pub dropped: u64,
    pub sampled: u64,
    pub requests: u64,
    pub failures: u64,
    pub pending: usize,
    pub buffered_bytes: usize,
    pub busy: bool,
    pub blocked: bool,
    pub error: Option<Error>,
}
struct Entry {
    encoded: String,
    at: Instant,
}
#[derive(Default)]
struct Pending {
    queue: VecDeque<Entry>,
    bytes: usize,
    inflight: usize,
    inflight_bytes: usize,
    sent: u64,
    requests: u64,
    failures: u64,
    busy: bool,
    blocked: bool,
    error: Option<Error>,
    closed: bool,
}
struct Shared {
    pending: Mutex<Pending>,
    ready: Condvar,
    dropped: AtomicU64,
    sampled: AtomicU64,
}
pub(super) struct Remote {
    shared: Arc<Shared>,
    sample_percent: u8,
}
impl Remote {
    pub(super) fn new(
        config: RemoteConfig,
        runtime: Runtime,
        origin_unix_ms: u64,
        identity: BuildIdentity,
    ) -> Option<Self> {
        let shared = Arc::new(Shared {
            pending: Mutex::new(Pending::default()),
            ready: Condvar::new(),
            dropped: AtomicU64::new(0),
            sampled: AtomicU64::new(0),
        });
        let sample_percent = config.sample_percent;
        let worker = shared.clone();
        std::thread::Builder::new()
            .name("scribyra-telemetry".into())
            .spawn(move || run(worker, config, runtime, origin_unix_ms, identity))
            .ok()?;
        Some(Self {
            shared,
            sample_percent,
        })
    }
    pub(super) fn enqueue(&self, encoded: String, trace_id: &str) {
        let hash = trace_id
            .get(..8)
            .and_then(|value| u32::from_str_radix(value, 16).ok())
            .unwrap_or(0) as u64;
        if hash * 100 >= (u32::MAX as u64 + 1) * self.sample_percent as u64 {
            self.shared.sampled.fetch_add(1, Ordering::Relaxed);
            return;
        }
        let Ok(mut p) = self.shared.pending.try_lock() else {
            self.shared.dropped.fetch_add(1, Ordering::Relaxed);
            return;
        };
        if p.closed || p.blocked || encoded.len() > 2048 {
            self.shared.dropped.fetch_add(1, Ordering::Relaxed);
            return;
        }
        while !p.queue.is_empty()
            && (p.queue.len() >= MAX_EVENTS || p.bytes + encoded.len() > MAX_BYTES)
        {
            p.bytes -= p.queue.pop_front().unwrap().encoded.len();
            self.shared.dropped.fetch_add(1, Ordering::Relaxed);
        }
        p.bytes += encoded.len();
        p.queue.push_back(Entry {
            encoded,
            at: Instant::now(),
        });
        self.shared.ready.notify_all();
    }
    pub(super) fn status(&self) -> Status {
        let p = self
            .shared
            .pending
            .lock()
            .unwrap_or_else(|p| p.into_inner());
        Status {
            enabled: true,
            sent: p.sent,
            dropped: self.shared.dropped.load(Ordering::Relaxed),
            sampled: self.shared.sampled.load(Ordering::Relaxed),
            requests: p.requests,
            failures: p.failures,
            pending: p.queue.len() + p.inflight,
            buffered_bytes: p.bytes + p.inflight_bytes,
            busy: p.busy,
            blocked: p.blocked,
            error: p.error,
        }
    }
    pub(super) fn flush(&self, timeout: Duration) -> bool {
        let Ok(p) = self.shared.pending.lock() else {
            return false;
        };
        self.shared.ready.notify_all();
        self.shared
            .ready
            .wait_timeout_while(p, timeout, |p| !p.queue.is_empty() || p.busy)
            .map(|(p, _)| p.queue.is_empty() && !p.busy && !p.blocked && p.error.is_none())
            .unwrap_or(false)
    }
}
impl Drop for Remote {
    fn drop(&mut self) {
        if let Ok(mut p) = self.shared.pending.lock() {
            p.closed = true;
            self.shared
                .dropped
                .fetch_add(p.queue.len() as u64, Ordering::Relaxed);
            p.queue.clear();
            p.bytes = 0;
            self.shared.ready.notify_all();
        }
    }
}
fn run(
    shared: Arc<Shared>,
    config: RemoteConfig,
    runtime: Runtime,
    origin_unix_ms: u64,
    identity: BuildIdentity,
) {
    let tls = ureq::tls::TlsConfig::builder()
        .root_certs(ureq::tls::RootCerts::PlatformVerifier)
        .build();
    let http_config = ureq::Agent::config_builder()
        .timeout_global(Some(Duration::from_secs(2)))
        .max_redirects(0)
        .http_status_as_error(false)
        .max_idle_connections(1)
        .user_agent("Scribyra-telemetry/1")
        .tls_config(tls)
        .build();
    let agent = ureq::Agent::with_parts(
        http_config,
        ureq::unversioned::transport::DefaultConnector::default(),
        resolver::BoundedResolver::default(),
    );
    let mut authorization =
        ureq::http::HeaderValue::from_str(&format!("Bearer {}", config.token)).unwrap();
    authorization.set_sensitive(true);
    let mut reported_dropped = 0;
    let mut reported_sampled = 0;
    loop {
        let entries = {
            let Ok(mut p) = shared.pending.lock() else {
                return;
            };
            while p.queue.is_empty() && !p.closed {
                p = match shared.ready.wait(p) {
                    Ok(p) => p,
                    Err(_) => return,
                };
            }
            if p.closed {
                return;
            }
            // Coalesce a short burst without holding the producer lock.
            p = match shared
                .ready
                .wait_timeout_while(p, Duration::from_millis(250), |p| {
                    !p.closed && p.queue.len() < 32
                }) {
                Ok((p, _)) => p,
                Err(_) => return,
            };
            if p.closed {
                return;
            }
            while p
                .queue
                .front()
                .is_some_and(|entry| entry.at.elapsed() > MAX_AGE)
            {
                p.bytes -= p.queue.pop_front().unwrap().encoded.len();
                shared.dropped.fetch_add(1, Ordering::Relaxed);
            }
            if p.queue.is_empty() {
                shared.ready.notify_all();
                continue;
            }
            let count = p.queue.len().min(32);
            let entries: Vec<_> = p.queue.drain(..count).collect();
            let size = entries.iter().map(|e| e.encoded.len()).sum::<usize>();
            p.bytes -= size;
            p.busy = true;
            p.inflight = count;
            p.inflight_bytes = size + 1024;
            entries
        };
        let count = entries.len();
        let at = entries[0].at;
        let dropped = shared.dropped.load(Ordering::Relaxed);
        let sampled = shared.sampled.load(Ordering::Relaxed);
        let events: Result<Vec<Event>, _> = entries
            .iter()
            .map(|e| serde_json::from_str(&e.encoded))
            .collect();
        let body = events.ok().and_then(|events| {
            serde_json::to_vec(&Batch {
                version: VERSION,
                batch_id: uuid::Uuid::new_v4().simple().to_string(),
                origin_unix_ms,
                source: config.source,
                identity: Some(identity.clone()),
                delivery: Some(DeliveryCounts {
                    runtime,
                    dropped: dropped
                        .saturating_sub(reported_dropped)
                        .min(9_007_199_254_740_991),
                    sampled: sampled
                        .saturating_sub(reported_sampled)
                        .min(9_007_199_254_740_991),
                    session_rate: None,
                }),
                events,
            })
            .ok()
        });
        drop(entries);
        let mut accepted = false;
        let mut error = Some(Error::Invalid);
        let mut blocked = false;
        if let Some(body) =
            body.filter(|body| body.len() <= super::super::transport::MAX_BATCH_BYTES)
        {
            for attempt in 0..3 {
                {
                    let Ok(mut p) = shared.pending.lock() else {
                        return;
                    };
                    if p.closed || at.elapsed() > MAX_AGE {
                        break;
                    }
                    p.requests = p.requests.saturating_add(1);
                    p.inflight_bytes = body.len();
                }
                // Never retain a response body, URL-bearing exception or headers.
                let status = agent
                    .post(&config.endpoint)
                    .header("Content-Type", "application/json")
                    .header("Authorization", authorization.clone())
                    .send(body.as_slice())
                    .ok()
                    .map(|response| response.status().as_u16());
                if status == Some(202) {
                    accepted = true;
                    error = None;
                    break;
                }
                let Ok(mut p) = shared.pending.lock() else {
                    return;
                };
                p.failures = p.failures.saturating_add(1);
                error = Some(match status {
                    Some(401 | 403) => {
                        blocked = true;
                        Error::Permission
                    }
                    Some(400 | 409 | 413) => {
                        blocked = true;
                        Error::Invalid
                    }
                    _ => Error::Unavailable,
                });
                if blocked || attempt == 2 || p.closed {
                    break;
                }
                let delay = Duration::from_millis(250 * (1 << attempt));
                let Ok((_guard, _)) = shared.ready.wait_timeout_while(p, delay, |p| !p.closed)
                else {
                    return;
                };
            }
        }
        let Ok(mut p) = shared.pending.lock() else {
            return;
        };
        if accepted {
            p.sent = p.sent.saturating_add(count as u64);
            reported_dropped = dropped;
            reported_sampled = sampled;
        } else {
            shared.dropped.fetch_add(count as u64, Ordering::Relaxed);
        }
        p.busy = false;
        p.inflight = 0;
        p.inflight_bytes = 0;
        p.error = error;
        p.blocked = blocked;
        if blocked {
            shared
                .dropped
                .fetch_add(p.queue.len() as u64, Ordering::Relaxed);
            p.queue.clear();
            p.bytes = 0;
        }
        shared.ready.notify_all();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::telemetry::{Operation, native::Native};
    use std::{
        io::{Read, Write},
        net::TcpListener,
        sync::mpsc,
    };
    fn endpoint(
        statuses: Vec<(u16, Duration)>,
    ) -> (String, mpsc::Receiver<Vec<u8>>, std::thread::JoinHandle<()>) {
        endpoint_with_redirect(statuses, None)
    }
    fn endpoint_with_redirect(
        statuses: Vec<(u16, Duration)>,
        location: Option<String>,
    ) -> (String, mpsc::Receiver<Vec<u8>>, std::thread::JoinHandle<()>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}/v1/events", listener.local_addr().unwrap());
        let (tx, rx) = mpsc::channel();
        let worker = std::thread::spawn(move || {
            for (status, pause) in statuses {
                let (mut stream, _) = listener.accept().unwrap();
                stream
                    .set_read_timeout(Some(Duration::from_secs(5)))
                    .unwrap();
                let mut bytes = Vec::new();
                let mut byte = [0];
                while !bytes.ends_with(b"\r\n\r\n") {
                    assert!(bytes.len() < 8192);
                    stream.read_exact(&mut byte).unwrap();
                    bytes.push(byte[0]);
                }
                let headers = String::from_utf8(bytes).unwrap();
                let length = headers
                    .lines()
                    .find_map(|line| {
                        line.split_once(':')
                            .filter(|(name, _)| name.eq_ignore_ascii_case("content-length"))
                            .map(|(_, value)| value.trim().parse::<usize>().unwrap())
                    })
                    .unwrap();
                assert!(length <= 65536);
                let mut body = vec![0; length];
                stream.read_exact(&mut body).unwrap();
                tx.send(body).unwrap();
                std::thread::sleep(pause);
                let redirect = location
                    .as_ref()
                    .map(|url| format!("Location: {url}\r\n"))
                    .unwrap_or_default();
                let _ = write!(
                    stream,
                    "HTTP/1.1 {status} Result\r\n{redirect}Content-Length: 24\r\nConnection: close\r\n\r\nPRIVATE_RESPONSE_MESSAGE"
                );
            }
        });
        (url, rx, worker)
    }
    fn configured(url: &str) -> Native {
        Native::with_remote(
            Runtime::Companion,
            true,
            None,
            RemoteConfig::new(url, &"a".repeat(64)).unwrap(),
        )
    }
    #[test]
    fn redirects_never_receive_the_ingest_credential_and_retry_is_finite() {
        let other = TcpListener::bind("127.0.0.1:0").unwrap();
        other.set_nonblocking(true).unwrap();
        let location = format!("http://{}/redirected", other.local_addr().unwrap());
        let (url, rx, worker) =
            endpoint_with_redirect(vec![(302, Duration::ZERO); 3], Some(location));
        let native = configured(&url);
        native.begin(Operation::Command, None).success();
        assert!(!native.flush(Duration::from_secs(4)));
        assert!(
            matches!(other.accept(),Err(error) if error.kind()==std::io::ErrorKind::WouldBlock)
        );
        let first = rx.recv_timeout(Duration::from_secs(1)).unwrap();
        for _ in 0..2 {
            assert_eq!(first, rx.recv_timeout(Duration::from_secs(1)).unwrap());
        }
        let status: serde_json::Value = serde_json::from_str(&native.snapshot()).unwrap();
        assert_eq!(status["remoteDelivery"]["requests"], 3);
        worker.join().unwrap();
    }
    #[test]
    fn actual_http_retries_freeze_batch_and_only_export_approved_records() {
        let (url, rx, worker) = endpoint(vec![(503, Duration::ZERO), (202, Duration::ZERO)]);
        let directory =
            std::env::temp_dir().join(format!("scribyra-remote-support-{}", uuid::Uuid::new_v4()));
        let native = Native::with_remote(
            Runtime::Companion,
            true,
            Some(directory.clone()),
            RemoteConfig::new(&url, &"a".repeat(64)).unwrap(),
        );
        let mut operation = native.begin(Operation::Provider, None);
        let context = operation.context().unwrap();
        operation.error("PRIVATE_EXCEPTION_SECRET");
        assert!(native.flush(Duration::from_secs(5)));
        let first = rx.recv_timeout(Duration::from_secs(1)).unwrap();
        let retry = rx.recv_timeout(Duration::from_secs(1)).unwrap();
        assert_eq!(first, retry);
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis() as u64;
        let batch = Batch::parse(&first, now).unwrap();
        assert!(
            batch
                .events
                .iter()
                .any(|e| e.trace_id == context.trace_id && e.span_id == context.span_id)
        );
        let encoded = String::from_utf8(first).unwrap();
        for forbidden in [
            "PRIVATE_EXCEPTION_SECRET",
            "PRIVATE_RESPONSE_MESSAGE",
            &url,
            &"a".repeat(64),
        ] {
            assert!(!encoded.contains(forbidden));
        }
        let snapshot = native.snapshot();
        assert!(!snapshot.contains(&url));
        assert!(!snapshot.contains("PRIVATE_RESPONSE_MESSAGE"));
        let status: serde_json::Value = serde_json::from_str(&snapshot).unwrap();
        assert_eq!(status["remoteDelivery"]["requests"], 2);
        assert!(status["remoteDelivery"]["sent"].as_u64().unwrap() > 0);
        let child = std::fs::read_dir(&directory)
            .unwrap()
            .next()
            .unwrap()
            .unwrap()
            .path();
        let support: serde_json::Value =
            serde_json::from_slice(&std::fs::read(child.join("snapshot.json")).unwrap()).unwrap();
        assert!(support["remoteDelivery"]["sent"].as_u64().unwrap() > 0);
        assert_eq!(support["remoteDelivery"]["pending"], 0);
        worker.join().unwrap();
        drop(native);
        std::fs::remove_dir_all(directory).unwrap();
    }
    #[test]
    fn slow_destination_bounds_queue_and_flush_without_blocking_operations() {
        let (url, rx, worker) = endpoint(vec![(401, Duration::from_millis(300))]);
        let native = configured(&url);
        native.begin(Operation::Command, None).success();
        rx.recv_timeout(Duration::from_secs(2)).unwrap();
        let start = Instant::now();
        for _ in 0..500 {
            native.begin(Operation::Command, None).success();
        }
        assert!(start.elapsed() < Duration::from_secs(2));
        let snapshot: serde_json::Value = serde_json::from_str(&native.snapshot()).unwrap();
        let remote = &snapshot["remoteDelivery"];
        assert!(remote["pending"].as_u64().unwrap() <= 160);
        assert!(remote["bufferedBytes"].as_u64().unwrap() <= 70000);
        assert!(remote["dropped"].as_u64().unwrap() > 0);
        assert!(!native.flush(Duration::from_millis(1)));
        worker.join().unwrap();
        assert!(!native.flush(Duration::from_secs(1)));
        let snapshot: serde_json::Value = serde_json::from_str(&native.snapshot()).unwrap();
        assert_eq!(snapshot["remoteDelivery"]["error"], "permission");
        assert_eq!(snapshot["remoteDelivery"]["requests"], 1);
    }
    #[test]
    fn configuration_is_strict_private_and_sampling_keeps_a_whole_trace() {
        for url in [
            "http://example.com/v1/events",
            "https://user:secret@example.com/v1/events",
            "https://example.com/v1/events?token=secret",
            "https://example.com/wrong",
        ] {
            assert!(RemoteConfig::new(url, &"a".repeat(64)).is_err());
        }
        assert!(RemoteConfig::new("https://example.com/v1/events", "secret").is_err());
        let (url, rx, worker) = endpoint(vec![(202, Duration::ZERO)]);
        let native = Native::with_remote(
            Runtime::Native,
            true,
            None,
            RemoteConfig::new(&url, &"a".repeat(64))
                .unwrap()
                .sampling(1)
                .unwrap(),
        );
        let excluded = crate::telemetry::TraceContext {
            trace_id: "f".repeat(32),
            span_id: "e".repeat(16),
        };
        native.begin(Operation::Command, Some(&excluded)).success();
        let included = crate::telemetry::TraceContext {
            trace_id: format!("{}1", "0".repeat(31)),
            span_id: "d".repeat(16),
        };
        native.begin(Operation::Command, Some(&included)).success();
        assert!(native.flush(Duration::from_secs(2)));
        let body = rx.recv_timeout(Duration::from_secs(1)).unwrap();
        let value: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(value["delivery"]["sampled"], 2);
        assert!(
            value["events"]
                .as_array()
                .unwrap()
                .iter()
                .all(|e| e["traceId"] == included.trace_id)
        );
        worker.join().unwrap();
        let root =
            std::env::temp_dir().join(format!("scribyra-native-token-{}", uuid::Uuid::new_v4()));
        std::fs::write(&root, "a".repeat(64)).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&root, std::fs::Permissions::from_mode(0o644)).unwrap();
            assert!(RemoteConfig::from_file(&url, &root).is_err());
            std::fs::set_permissions(&root, std::fs::Permissions::from_mode(0o600)).unwrap();
        }
        assert!(RemoteConfig::from_file(&url, &root).is_ok());
        std::fs::remove_file(root).unwrap();
    }
}
