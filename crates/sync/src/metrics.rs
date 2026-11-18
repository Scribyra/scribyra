//! Prometheus metrics (design section 10) on their own listener (`metrics_bind`), for `serve` and
//! `compile-worker`: requests by route template and status, compile requests and outcomes, compile
//! and CPU time, and the queue length the workers scale on ([`crate::deploy::COMPILE_QUEUE_METRIC`]).
//! Labels are fixed vocabularies and route templates only: no project, account, path, file or
//! other content ever becomes a label.
use axum::{Router, http::header, response::IntoResponse, routing::get};
use sqlx::PgPool;
use std::{
    collections::BTreeMap,
    net::SocketAddr,
    sync::{
        Mutex, OnceLock,
        atomic::{AtomicI64, AtomicU64, Ordering},
    },
};

#[derive(Default)]
pub struct Metrics {
    http: Mutex<BTreeMap<(String, u16), u64>>,
    requests: Mutex<BTreeMap<&'static str, u64>>,
    jobs: Mutex<BTreeMap<String, u64>>,
    compile_ms: AtomicU64,
    cpu_ms: AtomicU64,
    running: AtomicI64,
}
pub fn global() -> &'static Metrics {
    static M: OnceLock<Metrics> = OnceLock::new();
    M.get_or_init(Metrics::default)
}
impl Metrics {
    /// One answered request: `route` is the matched route template (or `unmatched`).
    pub fn http(&self, route: &str, status: u16) {
        *self.http.lock().unwrap().entry((route.to_owned(), status)).or_default() += 1;
    }
    /// One compile request and what became of it (`queued`, `replaced`, `existing`, `cached`,
    /// `rate_limited`, `queue_full`, `refused`).
    pub fn compile_request(&self, result: &'static str) {
        *self.requests.lock().unwrap().entry(result).or_default() += 1;
    }
    /// One finished job by outcome (`success`, `tex_error`, `limit_cpu`, …, `lost`, `requeued`).
    pub fn compile_job(&self, outcome: &str, wall_ms: u64, cpu_ms: u64) {
        *self.jobs.lock().unwrap().entry(outcome.to_owned()).or_default() += 1;
        self.compile_ms.fetch_add(wall_ms, Ordering::Relaxed);
        self.cpu_ms.fetch_add(cpu_ms, Ordering::Relaxed);
    }
    pub fn running(&self, delta: i64) {
        self.running.fetch_add(delta, Ordering::Relaxed);
    }
    /// The text exposition format; the queue length is read from the database at each scrape.
    pub async fn render(&self, pool: Option<&PgPool>) -> String {
        let mut out = String::new();
        let line = |out: &mut String, text: String| {
            out.push_str(&text);
            out.push('\n');
        };
        if let Some(pool) = pool {
            let counts: Result<(i64, i64), _> = sqlx::query_as("SELECT count(*) FILTER (WHERE state = 'queued'), count(*) FILTER (WHERE state = 'running') FROM compiles WHERE state IN ('queued', 'running')").fetch_one(pool).await;
            if let Ok((queued, running)) = counts {
                let name = crate::deploy::COMPILE_QUEUE_METRIC;
                line(&mut out, format!("# HELP {name} Server compile jobs queued or running (the compile workers scale on it)."));
                line(&mut out, format!("# TYPE {name} gauge"));
                line(&mut out, format!("{name} {}", queued + running));
                line(&mut out, "# HELP scribyra_compile_jobs Server compile jobs by state.".into());
                line(&mut out, "# TYPE scribyra_compile_jobs gauge".into());
                line(&mut out, format!("scribyra_compile_jobs{{state=\"queued\"}} {queued}"));
                line(&mut out, format!("scribyra_compile_jobs{{state=\"running\"}} {running}"));
            }
        }
        line(&mut out, "# HELP scribyra_http_requests_total Answered HTTP requests by route template and status.".into());
        line(&mut out, "# TYPE scribyra_http_requests_total counter".into());
        for ((route, status), n) in self.http.lock().unwrap().iter() {
            line(&mut out, format!("scribyra_http_requests_total{{route=\"{}\",status=\"{status}\"}} {n}", escape(route)));
        }
        line(&mut out, "# HELP scribyra_compile_requests_total Server compile requests by result.".into());
        line(&mut out, "# TYPE scribyra_compile_requests_total counter".into());
        for (result, n) in self.requests.lock().unwrap().iter() {
            line(&mut out, format!("scribyra_compile_requests_total{{result=\"{result}\"}} {n}"));
        }
        line(&mut out, "# HELP scribyra_compile_jobs_total Compile jobs this process finished, by outcome.".into());
        line(&mut out, "# TYPE scribyra_compile_jobs_total counter".into());
        for (outcome, n) in self.jobs.lock().unwrap().iter() {
            line(&mut out, format!("scribyra_compile_jobs_total{{outcome=\"{}\"}} {n}", escape(outcome)));
        }
        line(&mut out, "# HELP scribyra_compile_seconds_total Wall-clock time of the compile jobs this process ran.".into());
        line(&mut out, "# TYPE scribyra_compile_seconds_total counter".into());
        line(&mut out, format!("scribyra_compile_seconds_total {}", self.compile_ms.load(Ordering::Relaxed) as f64 / 1000.0));
        line(&mut out, "# HELP scribyra_compile_cpu_seconds_total CPU time of the compile jobs this process ran (their cgroups).".into());
        line(&mut out, "# TYPE scribyra_compile_cpu_seconds_total counter".into());
        line(&mut out, format!("scribyra_compile_cpu_seconds_total {}", self.cpu_ms.load(Ordering::Relaxed) as f64 / 1000.0));
        line(&mut out, "# HELP scribyra_compile_running Compile jobs this process is running now.".into());
        line(&mut out, "# TYPE scribyra_compile_running gauge".into());
        line(&mut out, format!("scribyra_compile_running {}", self.running.load(Ordering::Relaxed)));
        out
    }
}
fn escape(text: &str) -> String {
    text.replace('\\', "\\\\").replace('"', "\\\"").replace('\n', "\\n")
}

/// Serves [`crate::deploy::METRICS_PATH`] on `bind` until the process ends; prints the address.
pub async fn serve(bind: SocketAddr, pool: Option<PgPool>) -> std::io::Result<()> {
    let listener = tokio::net::TcpListener::bind(bind).await?;
    println!("{}", serde_json::json!({"event": "metrics_listening", "address": listener.local_addr()?.to_string()}));
    let app = Router::new().route(
        crate::deploy::METRICS_PATH,
        get(move || {
            let pool = pool.clone();
            async move { ([(header::CONTENT_TYPE, "text/plain; version=0.0.4"), (header::CACHE_CONTROL, "no-store")], global().render(pool.as_ref()).await).into_response() }
        }),
    );
    tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });
    Ok(())
}
