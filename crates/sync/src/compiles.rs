//! Server compile (design section 6, slice 11): the queue, the compile worker and the routes.
//!
//! A request materialises the project (at the `seq` the caller saw, or its head) and digests its
//! files; a successful compile of the same digest, engine and TeX Live tree is reused. Otherwise
//! a `compiles` row is queued: FIFO, at most `compile_limits.queue` waiting, at most one queued
//! job per project (a newer request replaces it) and one running (a project's next job waits
//! for the running one), `per_member_per_hour` requests per member. Workers (`scribyra-sync
//! compile-worker`, or `compile_worker_in_process` in `serve`) take jobs with `FOR UPDATE SKIP
//! LOCKED`, run `concurrency` at once in the [`scribyra_compile`] sandbox, heartbeat each one,
//! and store the PDF and log sealed with the project's data key. A job whose worker stops
//! heartbeating is requeued once, then failed; SIGTERM requeues what does not finish within
//! `shutdown_grace_seconds`. Only the newest successful PDF and log and the newest failed log
//! keep their blobs. Every change `NOTIFY`s the project, so heads polls wake.
//!
//! Never logged: content, file names, names, emails, tokens.
use crate::{
    blobs::{BlobKey, Bytes},
    config::{Compile, CompileLimits, Config},
    metrics,
    server_projects::{self, Content, Materialised, Projects, Shared, error, internal, item_ad, ok_json, open, seal},
    store::{Error, Store},
};
use axum::{
    Json, Router,
    body::{Body, to_bytes},
    extract::{Path, Query, State},
    http::{HeaderMap, HeaderValue, StatusCode, header},
    response::{IntoResponse, Response},
    routing::{get, put},
};
use scribyra_compile::{Bibliography, Bubblewrap, Engine, Limit, Outcome, Runner, Status};
use scribyra_core::blob;
use serde::Deserialize;
use serde_json::{Value, json};
use sqlx::{PgPool, Row};
use std::{
    path::PathBuf,
    sync::Arc,
    time::{Duration, Instant},
};
use tokio::{sync::watch, task::JoinSet};

/// Wakes idle workers when a job is queued (the payload is empty).
pub const CHANNEL: &str = "scribyra_compile";
/// Serialises the queue bound across replicas (`pg_advisory_xact_lock`).
const QUEUE_LOCK: i64 = 0x5343_5259_434f_4d50;
/// How often an idle worker looks for jobs when no notice arrives.
const POLL: Duration = Duration::from_secs(2);
const NO_MAIN: &str = "choose a main .tex file first";

/// The compile mode members see for a project: the deployment's, or with `both` the project's.
pub fn effective_mode(config: &Config, project_setting: &str) -> &'static str {
    match config.deployment.as_ref().map(|d| d.compile) {
        Some(Compile::Server) => "server",
        Some(Compile::Both) if project_setting == "server" => "server",
        _ => "browser",
    }
}

/// What a project's files compile as: their digest and how to run them.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Source {
    pub content_hash: String,
    pub engine: Engine,
    pub main: String,
    pub bibliography: Bibliography,
}
fn engine_name(e: Engine) -> &'static str {
    e.command()
}
fn engine_from(name: &str) -> Engine {
    match name {
        "xelatex" => Engine::Xelatex,
        "lualatex" => Engine::Lualatex,
        _ => Engine::Pdflatex,
    }
}
/// BibLaTeX (any text loading it) runs Biber unless it asks for `backend=bibtex`; otherwise
/// BibTeX, which the sandbox runs only when the `.aux` names a `\bibdata`.
fn bibliography(m: &Materialised) -> Bibliography {
    let texts = || m.files.iter().filter_map(|f| if let Content::Text(t) = &f.content { Some(t.as_str()) } else { None });
    // `\usepackage[options]{biblatex}` and the like: the command before the braces.
    let loads = texts().any(|t| {
        t.match_indices("{biblatex}").any(|(i, _)| {
            let command = &t[t[..i].rfind('\\').unwrap_or(0)..i];
            ["\\usepackage", "\\RequirePackage"].iter().any(|c| command.starts_with(c))
        })
    });
    let bibtex_backend = texts().any(|t| t.replace([' ', '\t'], "").contains("backend=bibtex"));
    if loads && !bibtex_backend { Bibliography::Biber } else { Bibliography::Bibtex }
}
/// The engine (`meta.engine`, default `pdflatex`), main file (`meta.mainFile`, else a top-level
/// `main.tex`), bibliography tool and a digest of every file's path and content hash.
pub fn source(m: &Materialised) -> Result<Source, &'static str> {
    let engine = engine_from(m.engine.as_deref().unwrap_or("pdflatex"));
    let main = m.main_file.clone().or_else(|| m.files.iter().find(|f| f.path == "main.tex" && matches!(f.content, Content::Text(_))).map(|f| f.path.clone())).ok_or(NO_MAIN)?;
    let bibliography = bibliography(m);
    let mut parts: Vec<String> = m
        .files
        .iter()
        .filter_map(|f| match &f.content {
            Content::Folder => None,
            Content::Text(t) => Some(format!("{}\0text\0{}\n", f.path, blob::hash(t.as_bytes()))),
            Content::Asset { hash, .. } => Some(format!("{}\0asset\0{hash}\n", f.path)),
        })
        .collect();
    parts.sort();
    let bib = match bibliography {
        Bibliography::Biber => "biber",
        Bibliography::Bibtex => "bibtex",
        Bibliography::None => "none",
    };
    let digest = format!("scribyra-compile/1\n{main}\n{bib}\n{}", parts.concat());
    Ok(Source { content_hash: blob::hash(digest.as_bytes()), engine, main, bibliography })
}
/// The sandbox limits from `deployment.compile_limits` (the rest at the runner's defaults).
pub fn limits(c: &CompileLimits) -> scribyra_compile::Limits {
    scribyra_compile::Limits { cpu_seconds: c.cpu_seconds.into(), wall_seconds: c.wall_seconds.into(), memory_mib: c.memory_mib.into(), scratch_mib: c.scratch_mib.into(), output_mib: c.output_mib.into(), passes: c.passes, ..scribyra_compile::Limits::default() }
}

/// What a compile request became.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Requested {
    /// A new job (`replaced`: it took a queued job's place).
    Queued { job: String, replaced: bool },
    /// The same files are already queued or running.
    Existing { job: String, state: String },
    /// A stored PDF of the same files, engine and TeX Live.
    Cached { job: String },
}
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RequestError {
    NotFound,
    NoMain,
    Compacted,
    BeyondHead,
    RateLimited,
    /// The requester, or the project's owner, has `active_per_member`/`active_per_owner` jobs
    /// queued or running already.
    Busy,
    QueueFull,
    Internal,
}
impl From<sqlx::Error> for RequestError {
    fn from(_: sqlx::Error) -> Self {
        Self::Internal
    }
}

/// A job a worker holds.
#[derive(Debug, Clone)]
pub struct Claimed {
    pub job: String,
    pub project: String,
    pub seq: i64,
    pub engine: Engine,
    pub queued_secs: i64,
    /// This claim's random token (the `worker` column): a job taken back and claimed again,
    /// even by the same process, gets a new one, so the earlier claim can no longer heartbeat,
    /// finish or give it back (review H1).
    pub holder: String,
}
impl Claimed {
    /// The slot this claim's PDF and log are stored under (blob name and associated data): the
    /// job and the claim, so a lost claim's late finish never touches another claim's blobs.
    fn slot(&self) -> String {
        format!("{}-{}", self.job, &self.holder[..16])
    }
}
/// How a job ended, before it is stored.
#[derive(Debug, Clone)]
pub struct Finished {
    pub outcome: String,
    pub error: Option<&'static str>,
    pub content_hash: Option<String>,
    pub cpu_ms: u64,
    pub passes: u32,
    pub pdf: Option<Vec<u8>>,
    pub log: Option<String>,
}
impl Finished {
    fn failed(outcome: &str, error: &'static str, log: Option<String>) -> Finished {
        Finished { outcome: outcome.into(), error: Some(error), content_hash: None, cpu_ms: 0, passes: 0, pdf: None, log }
    }
    fn from_outcome(o: Outcome, content_hash: String) -> Finished {
        let (outcome, error): (String, Option<&'static str>) = match &o.status {
            Status::Success => ("success".into(), None),
            Status::TexError => ("tex_error".into(), Some("TeX stopped with an error; see the log")),
            Status::LimitExceeded(l) => {
                let (name, text) = match l {
                    Limit::Cpu => ("cpu", "the compile used up its CPU time"),
                    Limit::Wall => ("wall", "the compile ran out of time"),
                    Limit::Memory => ("memory", "the compile used too much memory"),
                    Limit::Output => ("output", "the compile wrote too much output"),
                    Limit::Scratch => ("scratch", "the compile filled its scratch space"),
                    Limit::Processes => ("processes", "the compile started too many processes"),
                };
                (format!("limit_{name}"), Some(text))
            }
            Status::Rejected(_) => ("rejected".into(), Some("the project cannot be compiled as it is; see the log")),
            Status::Cancelled => ("cancelled".into(), Some("the compile was cancelled")),
            Status::SandboxFailure => ("sandbox_failure".into(), Some("the compile sandbox failed")),
        };
        Finished { outcome, error, content_hash: Some(content_hash), cpu_ms: o.cpu_ms, passes: o.passes, pdf: o.pdf, log: Some(o.log) }
    }
}
fn ms(column: &str) -> String {
    format!("(extract(epoch FROM {column}) * 1000)::bigint")
}

/// The queue and the stored results of one server-readable deployment with server compile.
pub struct Compiles {
    pub projects: Arc<Projects>,
    pub limits: CompileLimits,
    /// The configured TeX Live store path's name (part of the cache key).
    pub texlive: String,
    heartbeat_timeout: u64,
}
impl Compiles {
    /// `None` unless the deployment's `compile` is `server` or `both`.
    pub fn new(projects: Arc<Projects>) -> Option<Arc<Self>> {
        let config = &projects.store.config;
        let d = config.deployment.as_ref()?;
        if d.compile == Compile::Browser {
            return None;
        }
        let texlive = d.texlive.as_ref()?.file_name()?.to_string_lossy().into_owned();
        let (limits, heartbeat_timeout) = (d.compile_limits.clone(), config.compile_heartbeat_timeout_seconds);
        Some(Arc::new(Self { projects, limits, texlive, heartbeat_timeout }))
    }
    fn pool(&self) -> &PgPool {
        &self.projects.store.pool
    }
    fn mode(&self) -> Compile {
        self.projects.store.config.deployment.as_ref().map(|d| d.compile).unwrap_or_default()
    }

    /// Counts a request against `per_member_per_hour` and `per_project_per_minute` before
    /// anything is materialised (review M2: every request replayed the whole project first, and
    /// cached, existing and failed answers were free). Refused requests are not recorded.
    async fn admit(&self, project: &str, account: &str) -> Result<(), RequestError> {
        let mut tx = self.pool().begin().await?;
        let (member, recent): (i64, i64) = sqlx::query_as(
            "SELECT (SELECT count(*) FROM compile_requests WHERE account = $1 AND at > now() - interval '1 hour'),
                    (SELECT count(*) FROM compile_requests WHERE project = $2 AND at > now() - interval '1 minute')",
        )
        .bind(account)
        .bind(project)
        .fetch_one(&mut *tx)
        .await?;
        if member >= self.limits.per_member_per_hour as i64 || recent >= self.limits.per_project_per_minute as i64 {
            return Err(RequestError::RateLimited);
        }
        let n = sqlx::query("INSERT INTO compile_requests (account, project) SELECT $1, project FROM sr_projects WHERE project = $2 AND deleted IS NULL").bind(account).bind(project).execute(&mut *tx).await?.rows_affected();
        if n == 0 {
            return Err(RequestError::NotFound);
        }
        tx.commit().await?;
        Ok(())
    }

    /// Queues a compile of `project` at `seq` (its head when `None`) for `account`.
    pub async fn request(&self, project: &str, account: &str, seq: Option<i64>) -> Result<Requested, RequestError> {
        self.admit(project, account).await?;
        let m = match self.projects.materialise_at(project, seq, false).await {
            Ok(m) => m,
            Err(e) if e.to_string() == server_projects::COMPACTED => return Err(RequestError::Compacted),
            Err(e) if e.to_string() == server_projects::BEYOND_HEAD => return Err(RequestError::BeyondHead),
            Err(e) if e.to_string() == "unknown project" => return Err(RequestError::NotFound),
            Err(_) => return Err(RequestError::Internal),
        };
        let s = source(&m).map_err(|_| RequestError::NoMain)?;
        let engine = engine_name(s.engine);
        let cached: Option<String> = sqlx::query_scalar("SELECT job FROM compiles WHERE project = $1 AND state = 'done' AND pdf_blob IS NOT NULL AND content_hash = $2 AND engine = $3 AND texlive = $4 ORDER BY finished DESC LIMIT 1")
            .bind(project)
            .bind(&s.content_hash)
            .bind(engine)
            .bind(&self.texlive)
            .fetch_optional(self.pool())
            .await?;
        if let Some(job) = cached {
            return Ok(Requested::Cached { job });
        }
        let mut tx = self.pool().begin().await?;
        // The project row serialises requests for one project (and against workers finishing).
        let owner: Option<String> = sqlx::query_scalar("SELECT owner FROM sr_projects WHERE project = $1 AND deleted IS NULL FOR UPDATE").bind(project).fetch_optional(&mut *tx).await?;
        let Some(owner) = owner else { return Err(RequestError::NotFound) };
        let same: Option<(String, String)> = sqlx::query_as("SELECT job, state FROM compiles WHERE project = $1 AND state IN ('queued', 'running') AND content_hash = $2 AND engine = $3 AND texlive = $4 ORDER BY queued DESC LIMIT 1")
            .bind(project)
            .bind(&s.content_hash)
            .bind(engine)
            .bind(&self.texlive)
            .fetch_optional(&mut *tx)
            .await?;
        if let Some((job, state)) = same {
            return Ok(Requested::Existing { job, state });
        }
        // The queue lock serialises the bounds below (the queue, each member's and each owner's
        // active jobs) across projects and replicas.
        sqlx::query("SELECT pg_advisory_xact_lock($1)").bind(QUEUE_LOCK).execute(&mut *tx).await?;
        let replaced: Option<String> = sqlx::query_scalar("UPDATE compiles SET state = 'replaced', finished = now() WHERE project = $1 AND state = 'queued' RETURNING job").bind(project).fetch_optional(&mut *tx).await?;
        if replaced.is_none() {
            let queued: i64 = sqlx::query_scalar("SELECT count(*) FROM compiles WHERE state = 'queued'").fetch_one(&mut *tx).await?;
            if queued >= self.limits.queue as i64 {
                return Err(RequestError::QueueFull);
            }
        }
        // Review M1: one member (or one owner's projects) could fill the queue.
        let (mine, owners): (i64, i64) = sqlx::query_as(
            "SELECT count(*) FILTER (WHERE c.requested_by = $1), count(*) FILTER (WHERE p.owner = $2)
             FROM compiles c JOIN sr_projects p USING (project) WHERE c.state IN ('queued', 'running') AND (c.requested_by = $1 OR p.owner = $2)",
        )
        .bind(account)
        .bind(&owner)
        .fetch_one(&mut *tx)
        .await?;
        if mine >= self.limits.active_per_member as i64 || owners >= self.limits.active_per_owner as i64 {
            return Err(RequestError::Busy);
        }
        let job = server_projects::random_hex();
        sqlx::query("INSERT INTO compiles (job, project, seq, content_hash, engine, texlive, requested_by) VALUES ($1, $2, $3, $4, $5, $6, $7)")
            .bind(&job)
            .bind(project)
            .bind(m.seq)
            .bind(&s.content_hash)
            .bind(engine)
            .bind(&self.texlive)
            .bind(account)
            .execute(&mut *tx)
            .await?;
        server_projects::notify(&mut tx, project).await?;
        sqlx::query("SELECT pg_notify($1, '')").bind(CHANNEL).execute(&mut *tx).await?;
        tx.commit().await?;
        Ok(Requested::Queued { job, replaced: replaced.is_some() })
    }

    /// Takes a queued job whose project has none running, under a new claim token: round robin
    /// by requester (review M1), so the requester with the fewest running jobs goes first, each
    /// requester's oldest job first, then the oldest of those.
    pub async fn claim(&self) -> Result<Option<Claimed>, Error> {
        let holder = server_projects::random_hex();
        let row = sqlx::query(
            "UPDATE compiles SET state = 'running', worker = $1, started = now(), heartbeat = now(), attempts = attempts + 1
             WHERE job = (SELECT c.job FROM compiles c WHERE c.state = 'queued' AND NOT EXISTS (SELECT 1 FROM compiles r WHERE r.project = c.project AND r.state = 'running')
                          ORDER BY (SELECT count(*) FROM compiles r WHERE r.state = 'running' AND r.requested_by IS NOT DISTINCT FROM c.requested_by),
                                   (SELECT count(*) FROM compiles q WHERE q.state = 'queued' AND q.requested_by IS NOT DISTINCT FROM c.requested_by AND q.queued < c.queued),
                                   c.queued
                          LIMIT 1 FOR UPDATE SKIP LOCKED)
             RETURNING job, project, seq, engine, extract(epoch FROM queued)::bigint",
        )
        .bind(&holder)
        .fetch_optional(self.pool())
        .await;
        let row = match row {
            Ok(row) => row,
            // Another worker started this project's previous job at the same moment.
            Err(sqlx::Error::Database(e)) if e.is_unique_violation() => return Ok(None),
            Err(e) => return Err(e.into()),
        };
        let Some(r) = row else { return Ok(None) };
        let claimed = Claimed { job: r.get(0), project: r.get(1), seq: r.get(2), engine: engine_from(r.get::<&str, _>(3)), queued_secs: r.get(4), holder };
        let mut tx = self.pool().begin().await?;
        server_projects::notify(&mut tx, &claimed.project).await?;
        tx.commit().await?;
        Ok(Some(claimed))
    }
    /// Reports a running job alive; `false` when this claim no longer holds it.
    pub async fn heartbeat(&self, claimed: &Claimed) -> Result<bool, Error> {
        let n = sqlx::query("UPDATE compiles SET heartbeat = now() WHERE job = $1 AND worker = $2 AND state = 'running'").bind(&claimed.job).bind(&claimed.holder).execute(self.pool()).await?.rows_affected();
        Ok(n == 1)
    }
    /// Takes back running jobs whose worker stopped heartbeating: requeued once, then failed.
    pub async fn reap(&self) -> Result<u64, Error> {
        // Request records only count for an hour.
        sqlx::query("DELETE FROM compile_requests WHERE at < now() - interval '1 hour'").execute(self.pool()).await?;
        let expired: Vec<(String, String)> = sqlx::query_as("SELECT job, project FROM compiles WHERE state = 'running' AND heartbeat < now() - make_interval(secs => $1)")
            .bind(self.heartbeat_timeout as f64)
            .fetch_all(self.pool())
            .await?;
        let mut n = 0;
        for (job, project) in expired {
            if let Some(state) = self.take_back(&job, &project, None).await? {
                println!("{}", json!({"event": "compile_lost", "state": state}));
                metrics::global().compile_job(if state == "failed" { "lost" } else { "requeued" }, 0, 0);
                n += 1;
            }
        }
        Ok(n)
    }
    /// A worker gives a job back (SIGTERM): requeued without using up its retry.
    pub async fn requeue(&self, claimed: &Claimed) -> Result<bool, Error> {
        Ok(self.take_back(&claimed.job, &claimed.project, Some(&claimed.holder)).await?.is_some())
    }
    /// Expired (`worker` `None`) or handed back by the claim `worker`: back to the queue, `replaced` when a
    /// newer request is queued already, `failed` after a second lost attempt.
    async fn take_back(&self, job: &str, project: &str, worker: Option<&str>) -> Result<Option<&'static str>, Error> {
        let mut tx = self.pool().begin().await?;
        sqlx::query("SELECT 1 FROM sr_projects WHERE project = $1 FOR UPDATE").bind(project).execute(&mut *tx).await?;
        let attempts: Option<i32> = sqlx::query_scalar(
            "SELECT attempts FROM compiles WHERE job = $1 AND state = 'running' AND (CASE WHEN $2::text IS NULL THEN heartbeat < now() - make_interval(secs => $3) ELSE worker = $2 END) FOR UPDATE",
        )
        .bind(job)
        .bind(worker)
        .bind(self.heartbeat_timeout as f64)
        .fetch_optional(&mut *tx)
        .await?;
        let Some(attempts) = attempts else { return Ok(None) };
        let newer: Option<i32> = sqlx::query_scalar("SELECT 1 FROM compiles WHERE project = $1 AND state = 'queued'").bind(project).fetch_optional(&mut *tx).await?;
        let state = match (worker, attempts >= 2, newer.is_some()) {
            (None, true, _) => "failed",
            (_, _, true) => "replaced",
            _ => "queued",
        };
        sqlx::query(
            "UPDATE compiles SET state = $2, worker = NULL, heartbeat = NULL, attempts = attempts - $3,
                    started = CASE WHEN $2 = 'queued' THEN NULL ELSE started END, finished = CASE WHEN $2 = 'queued' THEN NULL ELSE now() END,
                    outcome = CASE WHEN $2 = 'failed' THEN 'lost' END, error = CASE WHEN $2 = 'failed' THEN 'the compile worker stopped responding twice' END
             WHERE job = $1",
        )
        .bind(job)
        .bind(state)
        .bind(if worker.is_some() { 1 } else { 0 })
        .execute(&mut *tx)
        .await?;
        server_projects::notify(&mut tx, project).await?;
        if state == "queued" {
            sqlx::query("SELECT pg_notify($1, '')").bind(CHANNEL).execute(&mut *tx).await?;
        }
        tx.commit().await?;
        Ok(Some(state))
    }

    /// The claimed job's sandbox input (or how it failed before running). Sizes are checked
    /// from the texts and the assets' recorded sizes before any asset is read, and again as each
    /// one is read (review M3: every asset was read into memory before the size check).
    pub async fn prepare(&self, claimed: &Claimed) -> Result<(scribyra_compile::Job, String), Finished> {
        let m = match self.projects.materialise_at(&claimed.project, Some(claimed.seq), false).await {
            Ok(m) => m,
            Err(e) if e.to_string() == server_projects::COMPACTED => {
                return Err(Finished::failed("rejected", "that version of the project is no longer stored; compile again", Some("The version this compile was asked for has been compacted on the server. Compile again.".into())));
            }
            Err(_) => return Err(Finished::failed("rejected", "the project could not be read", None)),
        };
        let mut s = source(&m).map_err(|e| Finished::failed("rejected", NO_MAIN, Some(e.into())))?;
        s.engine = claimed.engine;
        let l = limits(&self.limits);
        let max = (l.input_mib << 20).min((l.scratch_mib << 20).saturating_sub(1));
        let too_large = |total: u64| Finished::failed("rejected", "the project's files are too large to compile on the server", Some(format!("The project's files total at least {total} bytes; the server compiles at most {max}.")));
        let size = |c: &Content| match c {
            Content::Folder => 0,
            Content::Text(t) => t.len() as u64,
            Content::Asset { size, .. } => *size,
        };
        let declared: u64 = m.files.iter().map(|f| size(&f.content)).sum();
        if declared > max {
            return Err(too_large(declared));
        }
        let (mut files, mut total) = (Vec::new(), 0u64);
        for f in &m.files {
            let bytes = match &f.content {
                Content::Folder => continue,
                Content::Text(t) => t.as_bytes().to_vec(),
                // Projects from before content-addressed assets keep the bytes inline.
                Content::Asset { bytes: Some(b), .. } => b.clone(),
                Content::Asset { hash, .. } => match self.projects.object(&claimed.project, hash).await {
                    Ok(Some(b)) => b,
                    Ok(None) => return Err(Finished::failed("rejected", "a file of the project is missing on the server", Some(format!("{} has not reached the server yet; compile again once it has synced.", f.path)))),
                    Err(_) => return Err(Finished::failed("rejected", "the project could not be read", None)),
                },
            };
            total += bytes.len() as u64;
            if total > max {
                return Err(too_large(total));
            }
            files.push((f.path.clone(), bytes));
        }
        let job = scribyra_compile::Job { files, main: s.main.clone(), engine: s.engine, bibliography: s.bibliography, source_date_epoch: claimed.queued_secs.max(0) as u64 };
        Ok((job, s.content_hash))
    }

    /// Stores a finished job (sealed PDF and log, sizes, CPU time) if this claim still holds it,
    /// drops the blobs of older results, charges the project's quota and wakes the members.
    /// Over quota the job fails with no PDF. Returns the state written, if any. The blobs are
    /// named after the claim, so only blobs this call wrote are ever removed here, and only once
    /// the database refused them (review H1).
    pub async fn finish(&self, claimed: &Claimed, f: Finished) -> Result<Option<&'static str>, Error> {
        let project = &claimed.project;
        let Some(key) = self.projects.project_key(project).await? else { return Ok(None) };
        let mut f = f;
        if f.pdf.as_ref().is_some_and(|p| p.len() + 64 > blob::MAX_BLOB_BYTES) {
            f = Finished { pdf: None, outcome: "limit_output".into(), error: Some("the compile wrote too much output"), ..f };
        }
        let slot = claimed.slot();
        let mut stored = Vec::new();
        let sealed = |kind: &str, plain: &[u8]| (format!("sr/{project}/c/{slot}-{kind}"), seal(&key, &item_ad(project, kind, &slot), plain));
        let items = [f.pdf.as_deref().map(|p| sealed("pdf", p)), f.log.as_deref().map(|l| sealed("log", l.as_bytes()))];
        let mut slots = [None, None];
        for (slot, item) in slots.iter_mut().zip(items) {
            if let Some((name, bytes)) = item {
                let size = bytes.len() as i64;
                if let Err(e) = self.projects.store.blobs.put(&BlobKey::new(name.clone())?, Bytes::from(bytes)).await {
                    self.forget(stored).await;
                    return Err(e.into());
                }
                stored.push(name.clone());
                *slot = Some((name, size));
            }
        }
        let [pdf, log] = slots;
        let state = if f.outcome == "success" && pdf.is_some() { "done" } else { "failed" };
        match self.store_result(claimed, &f, state, pdf.clone(), log.clone()).await {
            Ok(Some(true)) => Ok(Some(state)),
            Ok(Some(false)) => {
                self.forget(stored).await;
                let over = Finished::failed("quota", "the PDF does not fit in the project's storage quota", None);
                Ok(self.store_result(claimed, &over, "failed", None, None).await?.map(|_| "failed"))
            }
            Ok(None) => {
                self.forget(stored).await;
                Ok(None)
            }
            // The commit may have gone through: remove the blobs only if no row names them.
            Err(e) => {
                let named: Result<bool, sqlx::Error> = sqlx::query_scalar("SELECT EXISTS (SELECT 1 FROM compiles WHERE pdf_blob = ANY($1) OR log_blob = ANY($1))").bind(&stored).fetch_one(self.pool()).await;
                if let Ok(false) = named {
                    self.forget(stored).await;
                }
                Err(e)
            }
        }
    }
    async fn forget(&self, names: Vec<String>) {
        for name in names {
            self.projects.forget_blob(Some(name)).await;
        }
    }
    /// `Some(false)`: over quota, nothing written. `None`: the job is no longer this worker's.
    async fn store_result(&self, claimed: &Claimed, f: &Finished, state: &str, pdf: Option<(String, i64)>, log: Option<(String, i64)>) -> Result<Option<bool>, Error> {
        let project = &claimed.project;
        let mut tx = self.pool().begin().await?;
        let row: Option<(String, i64)> = sqlx::query_as("SELECT owner, bytes FROM sr_projects WHERE project = $1 AND deleted IS NULL FOR UPDATE").bind(project).fetch_optional(&mut *tx).await?;
        let Some((owner, project_bytes)) = row else { return Ok(None) };
        let held: Option<i32> = sqlx::query_scalar("SELECT 1 FROM compiles WHERE job = $1 AND state = 'running' AND worker = $2 FOR UPDATE").bind(&claimed.job).bind(&claimed.holder).fetch_optional(&mut *tx).await?;
        if held.is_none() {
            return Ok(None);
        }
        let size = pdf.as_ref().map_or(0, |p| p.1) + log.as_ref().map_or(0, |l| l.1);
        sqlx::query(
            "UPDATE compiles SET state = $2, finished = now(), worker = NULL, heartbeat = NULL, outcome = $3, error = $4, cpu_ms = $5, passes = $6,
                    content_hash = COALESCE($7, content_hash), pdf_blob = $8, pdf_size = $9, pdf_bytes = $10, log_blob = $11, log_size = $12
             WHERE job = $1",
        )
        .bind(&claimed.job)
        .bind(state)
        .bind(&f.outcome)
        .bind(f.error)
        .bind(f.cpu_ms as i64)
        .bind(f.passes as i32)
        .bind(&f.content_hash)
        .bind(pdf.as_ref().map(|p| &p.0))
        .bind(pdf.as_ref().map(|p| p.1))
        .bind(f.pdf.as_ref().filter(|_| pdf.is_some()).map(|p| p.len() as i64))
        .bind(log.as_ref().map(|l| &l.0))
        .bind(log.as_ref().map(|l| l.1))
        .execute(&mut *tx)
        .await?;
        // Keep the newest successful PDF and log and the newest failed log; queue the rest.
        let freed: i64 = sqlx::query_scalar(
            "WITH keep AS ((SELECT job FROM compiles WHERE project = $1 AND state = 'done' AND pdf_blob IS NOT NULL ORDER BY finished DESC LIMIT 1)
                           UNION ALL (SELECT job FROM compiles WHERE project = $1 AND state = 'failed' AND log_blob IS NOT NULL ORDER BY finished DESC LIMIT 1)),
                  old AS (SELECT job, pdf_blob, log_blob, COALESCE(pdf_size, 0) + COALESCE(log_size, 0) AS size FROM compiles
                          WHERE project = $1 AND (pdf_blob IS NOT NULL OR log_blob IS NOT NULL) AND job NOT IN (SELECT job FROM keep)),
                  gone AS (UPDATE compiles c SET pdf_blob = NULL, pdf_size = NULL, log_blob = NULL, log_size = NULL FROM old WHERE c.job = old.job RETURNING old.pdf_blob, old.log_blob, old.size),
                  queued AS (INSERT INTO sr_garbage (blob) SELECT b FROM gone, unnest(ARRAY[gone.pdf_blob, gone.log_blob]) b WHERE b IS NOT NULL ON CONFLICT DO NOTHING)
             SELECT COALESCE(sum(size), 0)::bigint FROM gone",
        )
        .bind(project)
        .fetch_one(&mut *tx)
        .await?;
        let used: i64 = sqlx::query_scalar("SELECT bytes FROM usage WHERE scope = 'sr:deployment' FOR UPDATE").fetch_one(&mut *tx).await?;
        let member: i64 = sqlx::query_scalar("SELECT COALESCE(sum(bytes), 0)::bigint FROM sr_projects WHERE owner = $1 AND deleted IS NULL").bind(&owner).fetch_one(&mut *tx).await?;
        let net = size - freed;
        let q = self.projects.store.config.deployment.as_ref().map(|d| d.quotas.clone()).unwrap_or_default();
        if net > 0 && ((used + net) as u64 > q.deployment_bytes || (project_bytes + net) as u64 > q.project_bytes || (member + net) as u64 > q.member_bytes) {
            let _ = tx.rollback().await;
            return Ok(Some(false));
        }
        sqlx::query("UPDATE sr_projects SET bytes = greatest(bytes + $2, 0) WHERE project = $1").bind(project).bind(net).execute(&mut *tx).await?;
        sqlx::query("UPDATE usage SET bytes = greatest(bytes + $1, 0) WHERE scope = 'sr:deployment'").bind(net).execute(&mut *tx).await?;
        server_projects::notify(&mut tx, project).await?;
        tx.commit().await?;
        if freed > 0 {
            self.projects.kick.notify_one();
        }
        Ok(Some(true))
    }

    /// The latest job (not replaced) and the latest PDF's details.
    pub async fn status(&self, project: &str) -> Result<Value, Error> {
        let pool = self.pool();
        let head: i64 = sqlx::query_scalar("SELECT head_seq FROM sr_projects WHERE project = $1").bind(project).fetch_one(pool).await?;
        let job = sqlx::query(&format!(
            "SELECT c.job, c.state, c.seq, c.engine, c.requested_by, a.name, {}, {}, {}, c.outcome, c.error, c.cpu_ms, c.log_blob IS NOT NULL OR c.error IS NOT NULL
             FROM compiles c LEFT JOIN accounts a ON a.account = c.requested_by WHERE c.project = $1 AND c.state <> 'replaced' ORDER BY c.queued DESC LIMIT 1",
            ms("c.queued"),
            ms("c.started"),
            ms("c.finished")
        ))
        .bind(project)
        .fetch_optional(pool)
        .await?
        .map(|r| {
            json!({"id": r.get::<String, _>(0), "state": r.get::<String, _>(1), "seq": r.get::<i64, _>(2), "engine": r.get::<String, _>(3),
                   "requestedBy": {"account": r.get::<Option<String>, _>(4), "name": r.get::<Option<String>, _>(5)},
                   "queued": r.get::<i64, _>(6), "started": r.get::<Option<i64>, _>(7), "finished": r.get::<Option<i64>, _>(8),
                   "outcome": r.get::<Option<String>, _>(9), "error": r.get::<Option<String>, _>(10), "cpuMs": r.get::<Option<i64>, _>(11), "log": r.get::<bool, _>(12)})
        });
        let pdf = sqlx::query(&format!(
            "SELECT c.job, c.seq, c.engine, c.requested_by, a.name, {}, c.pdf_bytes FROM compiles c LEFT JOIN accounts a ON a.account = c.requested_by
             WHERE c.project = $1 AND c.state = 'done' AND c.pdf_blob IS NOT NULL ORDER BY c.finished DESC LIMIT 1",
            ms("c.finished")
        ))
        .bind(project)
        .fetch_optional(pool)
        .await?
        .map(|r| {
            let seq: i64 = r.get(1);
            json!({"job": r.get::<String, _>(0), "seq": seq, "engine": r.get::<String, _>(2), "requestedBy": {"account": r.get::<Option<String>, _>(3), "name": r.get::<Option<String>, _>(4)},
                   "compiled": r.get::<i64, _>(5), "bytes": r.get::<Option<i64>, _>(6), "fromHead": seq == head})
        });
        Ok(json!({"head": head, "job": job, "pdf": pdf, "texlive": self.texlive}))
    }
    /// The newest successful PDF, or a kept log (of `job`, else of the newest finished job that
    /// has one; a job that failed before writing one gives its error): (job, seq, bytes).
    pub async fn artefact(&self, project: &str, kind: &str, job: Option<&str>) -> Result<Option<(String, i64, Vec<u8>)>, Error> {
        let sql = match kind {
            "pdf" => "SELECT job, seq, pdf_blob, pdf_size, NULL::text FROM compiles WHERE project = $1 AND state = 'done' AND pdf_blob IS NOT NULL AND ($2::text IS NULL OR job = $2) ORDER BY finished DESC LIMIT 1",
            _ => "SELECT job, seq, log_blob, log_size, error FROM compiles WHERE project = $1 AND state IN ('done', 'failed') AND (log_blob IS NOT NULL OR error IS NOT NULL) AND ($2::text IS NULL OR job = $2) ORDER BY finished DESC LIMIT 1",
        };
        let row = sqlx::query(sql).bind(project).bind(job).fetch_optional(self.pool()).await?;
        let Some(r) = row else { return Ok(None) };
        let (id, seq, blob_key, size, error): (String, i64, Option<String>, Option<i64>, Option<String>) = (r.get(0), r.get(1), r.get(2), r.get(3), r.get(4));
        let Some(blob_key) = blob_key else { return Ok(Some((id, seq, error.unwrap_or_default().into_bytes()))) };
        // The slot is in the blob's name: `sr/<project>/c/<slot>-<kind>` (`<job>` for results
        // stored before claims had tokens, `<job>-<claim>` since).
        let slot = blob_key.strip_prefix(&format!("sr/{project}/c/")).and_then(|r| r.strip_suffix(&format!("-{kind}"))).ok_or("a compile result has an unexpected name")?.to_owned();
        let key = self.projects.project_key(project).await?.ok_or("the project key does not open")?;
        let sealed = self.projects.read_body(None, Some(blob_key), size.unwrap_or(0)).await?;
        let plain = open(&key, &item_ad(project, kind, &slot), &sealed).ok_or("a compile result does not open")?;
        Ok(Some((id, seq, plain)))
    }
}

/// The runner for this deployment's TeX Live (`deployment.texlive`): `bwrap` from
/// `SCRIBYRA_BWRAP` (else `PATH`), the closure from `SCRIBYRA_TEXLIVE_CLOSURE` when it belongs
/// to that tree (else `nix-store -qR`), confined as [`scribyra_compile::Confinement::from_env`].
pub fn runner(config: &Config) -> std::io::Result<Arc<Bubblewrap>> {
    let missing = |m: &str| std::io::Error::new(std::io::ErrorKind::NotFound, m.to_owned());
    let texlive = config.deployment.as_ref().and_then(|d| d.texlive.clone()).ok_or_else(|| missing("deployment.texlive is not set"))?;
    let bwrap = std::env::var_os("SCRIBYRA_BWRAP")
        .map(PathBuf::from)
        .or_else(|| std::env::split_paths(&std::env::var_os("PATH")?).map(|d| d.join("bwrap")).find(|p| p.is_file()))
        .ok_or_else(|| missing("bwrap is not installed (set SCRIBYRA_BWRAP)"))?;
    let same_tree = std::env::var_os("SCRIBYRA_TEXLIVE").is_none_or(|t| PathBuf::from(t) == texlive);
    let runner = match std::env::var_os("SCRIBYRA_TEXLIVE_CLOSURE") {
        Some(file) if same_tree => Bubblewrap::with_closure(bwrap, texlive, std::fs::read_to_string(file)?.lines().filter(|l| !l.is_empty()).map(PathBuf::from).collect())?,
        _ => Bubblewrap::new(bwrap, texlive)?,
    };
    Ok(Arc::new(runner.confine(scribyra_compile::Confinement::from_env())?))
}

/// Runs `concurrency` jobs at once from the queue.
pub struct Worker {
    compiles: Arc<Compiles>,
    runner: Arc<dyn Runner>,
    heartbeat: Duration,
    /// Without a heartbeat that went through for this long a job counts as lost: the reaper may
    /// take it back once `compile_heartbeat_timeout_seconds` pass, so the worker stops first.
    lost_after: Duration,
}
/// What heartbeats said while a job ran.
enum Beat {
    Held,
    /// Taken back, or no heartbeat went through for `lost_after`.
    Lost,
}
/// One job's heartbeats: every `heartbeat` through every phase (prepare, run, store).
struct Pulse {
    tick: tokio::time::Interval,
    last_ok: Instant,
}
impl Worker {
    pub fn new(compiles: Arc<Compiles>, runner: Arc<dyn Runner>) -> Arc<Worker> {
        let config = &compiles.projects.store.config;
        let heartbeat = Duration::from_secs(config.compile_heartbeat_seconds);
        let lost_after = Duration::from_secs(config.compile_heartbeat_timeout_seconds).saturating_sub(heartbeat).max(heartbeat);
        Arc::new(Worker { compiles, runner, heartbeat, lost_after })
    }
    fn pulse(&self) -> Pulse {
        let mut tick = tokio::time::interval(self.heartbeat);
        tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        tick.reset();
        Pulse { tick, last_ok: Instant::now() }
    }
    /// Waits for the next tick and heartbeats once. Errors count as lost once none went through
    /// for `lost_after` (review H1: they were ignored, so a worker cut off from the database
    /// kept compiling a job the reaper had handed to someone else).
    async fn beat(&self, claimed: &Claimed, pulse: &mut Pulse) -> Beat {
        pulse.tick.tick().await;
        // A database that does not answer counts as an error, not as a wait.
        match tokio::time::timeout(self.heartbeat, self.compiles.heartbeat(claimed)).await.unwrap_or_else(|_| Err("heartbeat timed out".into())) {
            Ok(true) => {
                pulse.last_ok = Instant::now();
                Beat::Held
            }
            Ok(false) => Beat::Lost,
            Err(_) if pulse.last_ok.elapsed() >= self.lost_after => Beat::Lost,
            Err(_) => {
                println!("{}", json!({"event": "compile_heartbeat_failed"}));
                Beat::Held
            }
        }
    }
    /// Drives `work` while heartbeating; `None` (and `work` dropped) once the job is lost.
    async fn alive<T>(&self, claimed: &Claimed, pulse: &mut Pulse, work: impl std::future::Future<Output = T>) -> Option<T> {
        tokio::pin!(work);
        loop {
            tokio::select! {
                out = &mut work => return Some(out),
                beat = self.beat(claimed, pulse) => if let Beat::Lost = beat { return None },
            }
        }
    }
    /// Takes and runs jobs until `shutdown`; then lets running jobs finish for up to `grace`
    /// and gives back (requeues) those that do not.
    pub async fn run(self: Arc<Self>, mut shutdown: watch::Receiver<bool>, grace: Duration) {
        let slots = Arc::new(tokio::sync::Semaphore::new(self.compiles.limits.concurrency as usize));
        let (abort, aborted) = watch::channel(false);
        let mut tasks = JoinSet::new();
        let mut listener = None;
        let mut reaped = Instant::now() - self.heartbeat;
        while !*shutdown.borrow() {
            while tasks.try_join_next().is_some() {}
            let permit = tokio::select! {
                permit = slots.clone().acquire_owned() => permit.expect("never closed"),
                _ = shutdown.changed() => break,
            };
            if reaped.elapsed() >= self.heartbeat {
                reaped = Instant::now();
                if self.compiles.reap().await.is_err() {
                    println!("{}", json!({"event": "compile_reap_failed"}));
                }
            }
            match self.compiles.claim().await {
                Ok(Some(claimed)) => {
                    tasks.spawn(self.clone().execute(claimed, permit, aborted.clone()));
                    continue;
                }
                Ok(None) => {}
                Err(_) => println!("{}", json!({"event": "compile_claim_failed"})),
            }
            drop(permit);
            if listener.is_none() {
                if let Ok(mut l) = sqlx::postgres::PgListener::connect_with(self.compiles.pool()).await
                    && l.listen(CHANNEL).await.is_ok()
                {
                    listener = Some(l);
                }
            }
            let notice = async {
                match listener.as_mut() {
                    Some(l) => l.recv().await.is_ok(),
                    None => std::future::pending().await,
                }
            };
            tokio::select! {
                ok = notice => if !ok { listener = None },
                _ = tokio::time::sleep(POLL) => {}
                _ = shutdown.changed() => break,
            }
        }
        // Draining: running jobs may finish within the grace period; then they are given back.
        if !tasks.is_empty() {
            let all = async { while tasks.join_next().await.is_some() {} };
            tokio::pin!(all);
            if tokio::time::timeout(grace, &mut all).await.is_err() {
                abort.send_replace(true);
                all.await;
            }
        }
    }
    async fn execute(self: Arc<Self>, claimed: Claimed, _slot: tokio::sync::OwnedSemaphorePermit, mut aborted: watch::Receiver<bool>) {
        let started = Instant::now();
        metrics::global().running(1);
        let mut pulse = self.pulse();
        let finished = match self.alive(&claimed, &mut pulse, self.compiles.prepare(&claimed)).await {
            None => None,
            Some(Err(f)) => Some(f),
            Some(Ok((job, hash))) => {
                let mut running = scribyra_compile::spawn(self.runner.clone(), job, limits(&self.compiles.limits));
                loop {
                    tokio::select! {
                        outcome = &mut running => break Some(Finished::from_outcome(outcome, hash)),
                        beat = self.beat(&claimed, &mut pulse) => {
                            if let Beat::Lost = beat {
                                // Taken back after a missed heartbeat (someone else may own it
                                // now), or cut off from the database for too long.
                                running.cancel();
                                let _ = (&mut running).await;
                                break None;
                            }
                        }
                        _ = async { aborted.wait_for(|a| *a).await.is_ok() } => {
                            running.cancel();
                            let _ = (&mut running).await;
                            let requeued = self.compiles.requeue(&claimed).await.unwrap_or(false);
                            println!("{}", json!({"event": "compile_requeued", "requeued": requeued}));
                            metrics::global().compile_job("requeued", started.elapsed().as_millis() as u64, 0);
                            metrics::global().running(-1);
                            return;
                        }
                    }
                }
            }
        };
        metrics::global().running(-1);
        let Some(finished) = finished else {
            println!("{}", json!({"event": "compile_discarded"}));
            return;
        };
        let (outcome, cpu_ms) = (finished.outcome.clone(), finished.cpu_ms);
        // Storing keeps heartbeating (uploads take time) but is never cut short: whether the
        // claim still holds the job is decided under the project's lock when the row is written.
        let state = {
            let store = self.compiles.finish(&claimed, finished);
            tokio::pin!(store);
            loop {
                tokio::select! {
                    state = &mut store => break state,
                    _ = self.beat(&claimed, &mut pulse) => {}
                }
            }
        };
        let wall_ms = started.elapsed().as_millis() as u64;
        metrics::global().compile_job(&outcome, wall_ms, cpu_ms);
        match state {
            Ok(Some(state)) => println!("{}", json!({"event": "compile_finished", "state": state, "outcome": outcome, "cpu_ms": cpu_ms, "wall_ms": wall_ms})),
            Ok(None) => println!("{}", json!({"event": "compile_discarded"})),
            Err(_) => println!("{}", json!({"event": "compile_store_failed"})),
        }
    }
}

/// `scribyra-sync compile-worker`: probes on `compile_worker_bind`, metrics on `metrics_bind`,
/// jobs until SIGTERM/SIGINT, then the grace period of `shutdown_grace_seconds`.
pub async fn run_worker(store: Store) -> Result<(), Error> {
    let store = Arc::new(store);
    let config = store.config.clone();
    let projects = Projects::new(store.clone())?.ok_or("compile-worker needs deployment.encryption \"server\"")?;
    let Some(compiles) = Compiles::new(projects) else {
        println!("{}", json!({"event": "compile_disabled"}));
        return Err("compile-worker needs deployment.compile \"server\" or \"both\"".into());
    };
    let runner = runner(&config).inspect_err(|e| println!("{}", json!({"event": "compile_runner_unavailable", "reason": e.to_string()})))?;
    if let Some(bind) = config.metrics_bind {
        metrics::serve(bind, Some(store.pool.clone())).await?;
    }
    let (stop, shutdown) = watch::channel(false);
    let probes = tokio::net::TcpListener::bind(config.compile_worker_bind).await?;
    println!("{}", json!({"event": "listening", "address": probes.local_addr()?.to_string(), "role": "compile-worker", "texlive": compiles.texlive}));
    let ready = {
        let (store, shutdown) = (store.clone(), shutdown.clone());
        move || {
            let (store, shutdown) = (store.clone(), shutdown.clone());
            async move { if !*shutdown.borrow() && store.ready().await.is_ok() { StatusCode::OK } else { StatusCode::SERVICE_UNAVAILABLE } }
        }
    };
    let app = Router::new()
        .route(crate::deploy::HEALTHZ_PATH, get(|| async { "{\"live\":true}" }))
        .route("/health", get(|| async { "{\"live\":true}" }))
        .route(crate::deploy::READYZ_PATH, get(ready.clone()))
        .route("/ready", get(ready));
    tokio::spawn(async move {
        let _ = axum::serve(probes, app).await;
    });
    tokio::spawn(async move {
        let mut term = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()).expect("signal handler");
        tokio::select! { _ = term.recv() => {}, _ = tokio::signal::ctrl_c() => {} }
        stop.send_replace(true);
        println!("{}", json!({"event": "shutdown"}));
    });
    Worker::new(compiles, runner).run(shutdown, Duration::from_secs(config.shutdown_grace_seconds)).await;
    println!("{}", json!({"event": "stopped"}));
    Ok(())
}

fn not_enabled() -> Response {
    error(StatusCode::NOT_FOUND, "this deployment compiles in the browser")
}
#[derive(Deserialize, Default)]
#[serde(deny_unknown_fields)]
struct CompileRequest {
    #[serde(default)]
    seq: Option<i64>,
}
/// `POST …/compile {seq?}`: owners and editors (`403` otherwise); `202` queued, `200` when the
/// same files are queued, running or compiled already.
async fn start(State(sr): State<Shared>, Path(p): Path<String>, headers: HeaderMap, body: Body) -> Response {
    let (projects, caller) = match sr.caller(&headers).await {
        Ok(c) => c,
        Err(r) => return r,
    };
    let Some(compiles) = sr.compiles.clone() else { return not_enabled() };
    let access = match sr.access(projects, &caller, &p).await {
        Ok(a) => a,
        Err(r) => return r,
    };
    if !access.writes() {
        metrics::global().compile_request("refused");
        return error(StatusCode::FORBIDDEN, "only the owner and editors can compile this project");
    }
    let Ok(bytes) = to_bytes(body, 4096).await else { return error(StatusCode::PAYLOAD_TOO_LARGE, "invalid request") };
    let request = if bytes.iter().all(u8::is_ascii_whitespace) { Ok(CompileRequest::default()) } else { serde_json::from_slice::<CompileRequest>(&bytes) };
    let Ok(request) = request else { return error(StatusCode::BAD_REQUEST, "invalid request") };
    if request.seq.is_some_and(|s| s < 0) {
        return error(StatusCode::BAD_REQUEST, "invalid request");
    }
    if compiles.mode() == Compile::Both {
        let setting: Option<String> = sqlx::query_scalar("SELECT compile FROM sr_projects WHERE project = $1").bind(&p).fetch_optional(&projects.store.pool).await.ok().flatten();
        if setting.as_deref() != Some("server") {
            metrics::global().compile_request("refused");
            return error(StatusCode::CONFLICT, "this project compiles in the browser");
        }
    }
    let answer = |status: StatusCode, job: &str, state: &str, extra: Value| {
        let mut body = json!({"job": job, "state": state});
        for (k, v) in extra.as_object().unwrap() {
            body[k] = v.clone();
        }
        ok_json(status, body)
    };
    match compiles.request(&p, &caller.account, request.seq).await {
        Ok(Requested::Queued { job, replaced }) => {
            metrics::global().compile_request(if replaced { "replaced" } else { "queued" });
            answer(StatusCode::ACCEPTED, &job, "queued", json!({"replaced": replaced}))
        }
        Ok(Requested::Existing { job, state }) => {
            metrics::global().compile_request("existing");
            answer(StatusCode::OK, &job, &state, json!({}))
        }
        Ok(Requested::Cached { job }) => {
            metrics::global().compile_request("cached");
            answer(StatusCode::OK, &job, "done", json!({"cached": true}))
        }
        Err(e) => {
            metrics::global().compile_request(match e {
                RequestError::RateLimited => "rate_limited",
                RequestError::Busy => "busy",
                RequestError::QueueFull => "queue_full",
                _ => "refused",
            });
            let retry = |r: Response| {
                let mut r = r;
                r.headers_mut().insert(header::RETRY_AFTER, HeaderValue::from_static("60"));
                r
            };
            match e {
                RequestError::NotFound => server_projects::not_found(),
                RequestError::NoMain => error(StatusCode::BAD_REQUEST, NO_MAIN),
                RequestError::Compacted => error(StatusCode::GONE, "compacted"),
                RequestError::BeyondHead => error(StatusCode::BAD_REQUEST, "seq is beyond the head"),
                RequestError::RateLimited => retry(error(StatusCode::TOO_MANY_REQUESTS, "compile limit reached; try again later")),
                RequestError::Busy => retry(error(StatusCode::TOO_MANY_REQUESTS, "too many compiles are waiting for you or this project's owner; try again when one finishes")),
                RequestError::QueueFull => retry(error(StatusCode::SERVICE_UNAVAILABLE, "the compile queue is full; try again later")),
                RequestError::Internal => internal(()),
            }
        }
    }
}
/// `GET …/compile`: any member. The latest job and the latest PDF's details.
async fn status(State(sr): State<Shared>, Path(p): Path<String>, headers: HeaderMap) -> Response {
    let (projects, caller) = match sr.caller(&headers).await {
        Ok(c) => c,
        Err(r) => return r,
    };
    let Some(compiles) = sr.compiles.clone() else { return not_enabled() };
    if let Err(r) = sr.access(projects, &caller, &p).await {
        return r;
    }
    let setting: String = match sqlx::query_scalar("SELECT compile FROM sr_projects WHERE project = $1").bind(&p).fetch_one(&projects.store.pool).await {
        Ok(s) => s,
        Err(e) => return internal(e),
    };
    match compiles.status(&p).await {
        Ok(mut body) => {
            body["mode"] = json!(effective_mode(&projects.store.config, &setting));
            ok_json(StatusCode::OK, body)
        }
        Err(e) => internal(e),
    }
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct LogQuery {
    #[serde(default)]
    job: Option<String>,
}
async fn artefact(sr: Shared, p: String, headers: HeaderMap, kind: &'static str, job: Option<String>) -> Response {
    let (projects, caller) = match sr.caller(&headers).await {
        Ok(c) => c,
        Err(r) => return r,
    };
    let Some(compiles) = sr.compiles.clone() else { return not_enabled() };
    if let Err(r) = sr.access(projects, &caller, &p).await {
        return r;
    }
    if job.as_deref().is_some_and(|j| !server_projects::is_id(j)) {
        return error(StatusCode::BAD_REQUEST, "invalid job");
    }
    match compiles.artefact(&p, kind, job.as_deref()).await {
        Ok(Some((job, seq, bytes))) => {
            let mut response = bytes.into_response();
            let h = response.headers_mut();
            h.insert(header::CONTENT_TYPE, HeaderValue::from_static(if kind == "pdf" { "application/pdf" } else { "text/plain; charset=utf-8" }));
            h.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
            h.insert(header::X_CONTENT_TYPE_OPTIONS, HeaderValue::from_static("nosniff"));
            h.insert(header::HeaderName::from_static("scribyra-compile-job"), HeaderValue::from_str(&job).expect("hex"));
            h.insert(header::HeaderName::from_static("scribyra-compile-seq"), HeaderValue::from(seq));
            response
        }
        Ok(None) => error(StatusCode::NOT_FOUND, if kind == "pdf" { "no PDF yet" } else { "no compile log" }),
        Err(e) => internal(e),
    }
}
/// `GET …/compile/pdf`: any member; the latest successful PDF.
async fn pdf(State(sr): State<Shared>, Path(p): Path<String>, headers: HeaderMap) -> Response {
    artefact(sr, p, headers, "pdf", None).await
}
/// `GET …/compile/log?job=`: any member; a kept log.
async fn log(State(sr): State<Shared>, Path(p): Path<String>, Query(q): Query<LogQuery>, headers: HeaderMap) -> Response {
    artefact(sr, p, headers, "log", q.job).await
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Settings {
    compile: String,
}
/// `PUT …/settings {compile}`: owners and editors, when the deployment's `compile` is `both`.
async fn settings(State(sr): State<Shared>, Path(p): Path<String>, headers: HeaderMap, Json(request): Json<Settings>) -> Response {
    let (projects, caller) = match sr.caller(&headers).await {
        Ok(c) => c,
        Err(r) => return r,
    };
    let access = match sr.access(projects, &caller, &p).await {
        Ok(a) => a,
        Err(r) => return r,
    };
    if !access.writes() {
        return error(StatusCode::FORBIDDEN, "only the owner and editors can change this project's settings");
    }
    if !matches!(request.compile.as_str(), "browser" | "server") {
        return error(StatusCode::BAD_REQUEST, "compile must be \"browser\" or \"server\"");
    }
    if projects.store.config.deployment.as_ref().map(|d| d.compile) != Some(Compile::Both) {
        return error(StatusCode::CONFLICT, "this deployment decides where projects compile");
    }
    let done = async {
        let mut tx = projects.store.pool.begin().await?;
        sqlx::query("UPDATE sr_projects SET compile = $2, updated = now() WHERE project = $1 AND deleted IS NULL").bind(&p).bind(&request.compile).execute(&mut *tx).await?;
        server_projects::notify(&mut tx, &p).await?;
        tx.commit().await
    };
    if let Err(e) = done.await {
        return internal(e);
    }
    println!("{}", json!({"event": "project_compile_mode", "mode": request.compile}));
    ok_json(StatusCode::OK, json!({"compile": request.compile}))
}

/// The compile routes, merged into [`server_projects::routes`].
pub(crate) fn routes() -> Router<Shared> {
    Router::new()
        .route("/v1/sr/projects/{project}/compile", get(status).post(start))
        .route("/v1/sr/projects/{project}/compile/pdf", get(pdf))
        .route("/v1/sr/projects/{project}/compile/log", get(log))
        .route("/v1/sr/projects/{project}/settings", put(settings))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::server_projects::File;

    fn m(files: &[(&str, &str)], main: Option<&str>, engine: Option<&str>) -> Materialised {
        let files = files.iter().map(|(p, t)| File { id: p.to_string(), path: p.to_string(), conflict: None, content: Content::Text(t.to_string()) }).collect();
        Materialised { seq: 1, name: "x".into(), main_file: main.map(str::to_owned), engine: engine.map(str::to_owned), files }
    }

    #[test]
    fn the_digest_follows_files_main_and_bibliography_but_not_order() {
        let a = source(&m(&[("main.tex", "a"), ("b.tex", "b")], Some("main.tex"), None)).unwrap();
        let b = source(&m(&[("b.tex", "b"), ("main.tex", "a")], Some("main.tex"), Some("pdflatex"))).unwrap();
        assert_eq!(a, b);
        assert_eq!(a.engine, Engine::Pdflatex);
        assert_ne!(a.content_hash, source(&m(&[("main.tex", "a"), ("b.tex", "c")], Some("main.tex"), None)).unwrap().content_hash);
        assert_ne!(a.content_hash, source(&m(&[("main.tex", "a"), ("b.tex", "b")], Some("b.tex"), None)).unwrap().content_hash);
        assert_eq!(source(&m(&[("main.tex", "a")], None, Some("xelatex"))).unwrap().engine, Engine::Xelatex);
        assert_eq!(source(&m(&[("paper.tex", "a")], None, None)), Err(NO_MAIN));
        let biber = source(&m(&[("main.tex", "\\usepackage[style=alphabetic]{biblatex}")], None, None)).unwrap();
        assert_eq!(biber.bibliography, Bibliography::Biber);
        assert_eq!(source(&m(&[("main.tex", "\\usepackage[backend = bibtex]{biblatex}")], None, None)).unwrap().bibliography, Bibliography::Bibtex);
        assert_eq!(source(&m(&[("main.tex", "\\bibliography{refs}")], None, None)).unwrap().bibliography, Bibliography::Bibtex);
    }
}
