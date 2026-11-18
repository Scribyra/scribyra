//! The operator's Prometheus metrics, served on `/metrics` beside `/healthz` and `/readyz`.

use prometheus_client::encoding::EncodeLabelSet;
use prometheus_client::metrics::{counter::Counter, family::Family, gauge::Gauge, histogram::Histogram};
use prometheus_client::registry::Registry;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

#[derive(Clone, Debug, Hash, PartialEq, Eq, EncodeLabelSet)]
struct Outcome {
    result: String,
}
#[derive(Clone, Debug, Hash, PartialEq, Eq, EncodeLabelSet)]
struct Instance {
    namespace: String,
    name: String,
}

pub struct Metrics {
    registry: Registry,
    reconciles: Family<Outcome, Counter>,
    duration: Histogram,
    leader: Gauge,
    queue: Family<Instance, Gauge>,
    pub ready: AtomicBool,
}
impl Default for Metrics {
    fn default() -> Self {
        let mut registry = Registry::with_prefix("scribyra_operator");
        let reconciles = Family::<Outcome, Counter>::default();
        let duration = Histogram::new(prometheus_client::metrics::histogram::exponential_buckets(0.01, 2.0, 12));
        let leader = Gauge::default();
        let queue = Family::<Instance, Gauge>::default();
        registry.register("reconciliations", "Reconcile passes by result", reconciles.clone());
        registry.register("reconcile_duration_seconds", "Duration of a reconcile pass", duration.clone());
        registry.register("leader", "1 while this replica holds the leader lease", leader.clone());
        registry.register("compile_queue_length", "Compile queue length last read from each deployment", queue.clone());
        Self { registry, reconciles, duration, leader, queue, ready: AtomicBool::new(false) }
    }
}
impl Metrics {
    pub fn reconciled(&self, ok: bool, took: Duration) {
        self.reconciles.get_or_create(&Outcome { result: if ok { "success" } else { "error" }.into() }).inc();
        self.duration.observe(took.as_secs_f64());
    }
    pub fn set_leader(&self, leader: bool) {
        self.leader.set(leader as i64);
        self.ready.store(leader, Ordering::Relaxed);
    }
    pub fn queue(&self, namespace: &str, name: &str, length: i64) {
        self.queue.get_or_create(&Instance { namespace: namespace.into(), name: name.into() }).set(length);
    }
    pub fn encode(&self) -> String {
        let mut out = String::new();
        prometheus_client::encoding::text::encode(&mut out, &self.registry).unwrap();
        out
    }
}

/// `/metrics`, `/healthz` (process alive) and `/readyz` (holds the lease and reconciles).
pub async fn serve(metrics: std::sync::Arc<Metrics>, addr: std::net::SocketAddr) -> std::io::Result<()> {
    use axum::{Router, http::StatusCode, routing::get};
    let m = metrics.clone();
    let app = Router::new()
        .route("/metrics", get(move || { let m = m.clone(); async move { ([("content-type", "application/openmetrics-text; version=1.0.0; charset=utf-8")], m.encode()) } }))
        .route("/healthz", get(|| async { "ok" }))
        .route("/readyz", get(move || { let m = metrics.clone(); async move { if m.ready.load(Ordering::Relaxed) { (StatusCode::OK, "ok") } else { (StatusCode::SERVICE_UNAVAILABLE, "standby") } } }));
    let listener = tokio::net::TcpListener::bind(addr).await?;
    axum::serve(listener, app).await
}
