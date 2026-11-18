//! Sandboxed TeX Live runs for server compiles (design section 6, `docs/org-sync-design.md`).
//! A [`Job`] is a validated file tree with a main file, engine and bibliography tool; a
//! [`Runner`] compiles it within [`Limits`] and returns an [`Outcome`] holding only the PDF and
//! the (bounded) log. [`Bubblewrap`] is the runner: one bwrap sandbox per job with an empty
//! network namespace, a read-only bind of exactly the TeX Live closure, a size-limited tmpfs as
//! the only writable path, a seccomp filter and rlimits. Blocking; [`spawn`] runs a job on its
//! own thread as a future that cancels the job when dropped.

mod bwrap;
mod cgroup;
pub mod seccomp;

pub use bwrap::{store_closure, Bubblewrap, RawOutcome};
pub use cgroup::Confinement;

use std::collections::BTreeSet;
use std::future::Future;
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::task::{Context, Poll, Waker};

/// Per-job resource limits. `cpu_seconds` and `memory_mib` bind each process (rlimits) and,
/// in the job's cgroup ([`Confinement`]), the whole job: CPU summed over all its processes,
/// memory including the scratch tmpfs. `processes` likewise. `wall_seconds` binds the whole
/// job, `output_mib` every file the job writes and the PDF read back, `scratch_mib` everything
/// the job writes together (its tmpfs).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Limits {
  pub cpu_seconds: u64,
  pub wall_seconds: u64,
  pub memory_mib: u64,
  pub scratch_mib: u64,
  pub output_mib: u64,
  pub passes: u32,
  pub processes: u64,
  pub open_files: u64,
  /// Input files per job and their total size.
  pub files: usize,
  pub input_mib: u64,
  /// The log kept in the outcome (its tail).
  pub log_kib: u64,
}

impl Default for Limits {
  fn default() -> Self {
    Limits { cpu_seconds: 60, wall_seconds: 120, memory_mib: 2048, scratch_mib: 512, output_mib: 64, passes: 5, processes: 64, open_files: 256, files: 2000, input_mib: 128, log_kib: 1024 }
  }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Engine { Pdflatex, Xelatex, Lualatex }

impl Engine {
  pub fn command(self) -> &'static str { match self { Engine::Pdflatex => "pdflatex", Engine::Xelatex => "xelatex", Engine::Lualatex => "lualatex" } }
}

/// `Bibtex` runs when the first pass's `.aux` has `\bibdata`; `Biber` when it wrote a `.bcf`
/// (only if the TeX Live tree has biber, see [`Bubblewrap::has_biber`]).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Bibliography { None, Bibtex, Biber }

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Limit { Cpu, Wall, Memory, Output, Scratch, Processes }

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Status {
  Success,
  /// TeX (or BibTeX) failed: the log says why.
  TexError,
  LimitExceeded(Limit),
  /// Refused before anything ran (paths, sizes, main file).
  Rejected(JobError),
  Cancelled,
  /// The sandbox itself did not start or misbehaved; the log carries bwrap's message.
  SandboxFailure,
}

#[derive(Clone, Debug)]
pub struct Outcome {
  pub status: Status,
  pub pdf: Option<Vec<u8>>,
  pub log: String,
  pub cpu_ms: u64,
  pub passes: u32,
}

impl Outcome {
  fn fail(status: Status, log: impl Into<String>) -> Outcome { Outcome { status, pdf: None, log: log.into(), cpu_ms: 0, passes: 0 } }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum JobError { NoFiles, TooManyFiles(usize), TooLarge(u64), BadPath(String), Duplicate(String), FileIsDirectory(String), BadMain(String), MainMissing(String), BiberUnavailable }

impl std::fmt::Display for JobError {
  fn fmt(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
    match self {
      JobError::NoFiles => write!(f, "the project has no files"),
      JobError::TooManyFiles(n) => write!(f, "the project has {n} files, more than allowed"),
      JobError::TooLarge(b) => write!(f, "the project's files total {b} bytes, more than allowed"),
      JobError::BadPath(p) => write!(f, "refused file path {p:?}"),
      JobError::Duplicate(p) => write!(f, "file {p:?} appears twice"),
      JobError::FileIsDirectory(p) => write!(f, "{p:?} is both a file and a folder"),
      JobError::BadMain(p) => write!(f, "main file {p:?} must be a .tex file named with letters, digits, '-', '_', '.' and '/'"),
      JobError::MainMissing(p) => write!(f, "main file {p:?} is not in the project"),
      JobError::BiberUnavailable => write!(f, "biber is not installed in this server's TeX Live"),
    }
  }
}

impl std::error::Error for JobError {}

#[derive(Clone, Debug)]
pub struct Job {
  /// Paths relative to the project root, `/`-separated.
  pub files: Vec<(String, Vec<u8>)>,
  pub main: String,
  pub engine: Engine,
  pub bibliography: Bibliography,
  /// `SOURCE_DATE_EPOCH` for the run (PDF dates, reproducible output).
  pub source_date_epoch: u64,
}

/// A relative path that is safe to create inside the scratch directory: no absolute path,
/// empty, `.` or `..` component, dot file, NUL, control character or backslash.
pub fn check_path(p: &str) -> Result<(), JobError> {
  let bad = || JobError::BadPath(p.chars().take(200).collect());
  if p.is_empty() || p.len() > 1024 || p.starts_with('/') || p.chars().any(|c| c.is_control() || c == '\\') { return Err(bad()); }
  let parts: Vec<&str> = p.split('/').collect();
  if parts.len() > 32 || parts.iter().any(|c| c.is_empty() || c.starts_with('.') || c.len() > 255) { return Err(bad()); }
  Ok(())
}

impl Job {
  /// Checks paths, counts and sizes against `limits` before anything is written.
  pub fn validate(&self, limits: &Limits) -> Result<(), JobError> {
    if self.files.is_empty() { return Err(JobError::NoFiles); }
    if self.files.len() > limits.files { return Err(JobError::TooManyFiles(self.files.len())); }
    let total: u64 = self.files.iter().map(|(_, b)| b.len() as u64).sum();
    if total > limits.input_mib << 20 || total >= limits.scratch_mib << 20 { return Err(JobError::TooLarge(total)); }
    let (mut seen, mut dirs) = (BTreeSet::new(), BTreeSet::new());
    for (p, _) in &self.files {
      check_path(p)?;
      if !seen.insert(p.as_str()) { return Err(JobError::Duplicate(p.clone())); }
      let mut at = 0;
      while let Some(i) = p[at..].find('/') { dirs.insert(&p[..at + i]); at += i + 1; }
    }
    if let Some(p) = seen.intersection(&dirs).next() { return Err(JobError::FileIsDirectory(p.to_string())); }
    let m = &self.main;
    if check_path(m).is_err() || !m.ends_with(".tex") || m.len() <= 4 || m.ends_with("/.tex") || !m.bytes().all(|b| b.is_ascii_alphanumeric() || b"-_./".contains(&b)) {
      return Err(JobError::BadMain(m.clone()));
    }
    if !seen.contains(m.as_str()) { return Err(JobError::MainMissing(m.clone())); }
    Ok(())
  }
}

/// Cooperative cancellation: the runner kills the sandbox when this is set.
#[derive(Clone, Debug, Default)]
pub struct Cancel(Arc<AtomicBool>);

impl Cancel {
  pub fn new() -> Cancel { Cancel::default() }
  pub fn cancel(&self) { self.0.store(true, Ordering::SeqCst) }
  pub fn is_cancelled(&self) -> bool { self.0.load(Ordering::SeqCst) }
}

pub trait Runner: Send + Sync {
  /// Compiles `job` within `limits`; blocks until done, killed at the wall-clock limit or cancelled.
  fn run(&self, job: &Job, limits: &Limits, cancel: &Cancel) -> Outcome;
  /// Identifies the TeX installation (part of the PDF cache key).
  fn texlive_id(&self) -> &str;
}

struct Slot { outcome: Option<Outcome>, waker: Option<Waker> }

/// A job running on its own thread. Dropping it before it resolves cancels the job.
pub struct Running { slot: Arc<Mutex<Slot>>, cancel: Cancel, done: bool }

/// Runs `job` on a new thread; works under any async runtime (tokio included).
pub fn spawn<R: Runner + ?Sized + 'static>(runner: Arc<R>, job: Job, limits: Limits) -> Running {
  let slot = Arc::new(Mutex::new(Slot { outcome: None, waker: None }));
  let cancel = Cancel::new();
  let (s, c) = (slot.clone(), cancel.clone());
  std::thread::spawn(move || {
    let out = runner.run(&job, &limits, &c);
    let mut g = s.lock().unwrap();
    g.outcome = Some(out);
    if let Some(w) = g.waker.take() { w.wake() }
  });
  Running { slot, cancel, done: false }
}

impl Running {
  pub fn cancel(&self) { self.cancel.cancel() }
}

impl Future for Running {
  type Output = Outcome;
  fn poll(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Outcome> {
    let out = { let mut g = self.slot.lock().unwrap(); match g.outcome.take() { Some(o) => Some(o), None => { g.waker = Some(cx.waker().clone()); None } } };
    match out { Some(o) => { self.done = true; Poll::Ready(o) } None => Poll::Pending }
  }
}

impl Drop for Running {
  fn drop(&mut self) { if !self.done { self.cancel.cancel() } }
}

#[cfg(test)]
mod tests {
  use super::*;

  fn job(files: &[&str], main: &str) -> Job {
    Job { files: files.iter().map(|p| (p.to_string(), b"x".to_vec())).collect(), main: main.into(), engine: Engine::Pdflatex, bibliography: Bibliography::Bibtex, source_date_epoch: 0 }
  }

  #[test]
  fn paths_are_checked_before_anything_is_written() {
    let l = Limits::default();
    assert_eq!(job(&["main.tex", "ch/a.tex"], "main.tex").validate(&l), Ok(()));
    for bad in ["/etc/passwd", "../x.tex", "a/../../x", "a//b", "a/", "./a", ".latexmkrc", "a/.git/config", "a\0b", "a\\b", "a\nb", ""] {
      assert!(matches!(job(&["main.tex", bad], "main.tex").validate(&l), Err(JobError::BadPath(_))), "{bad:?}");
    }
    assert_eq!(job(&["main.tex", "main.tex"], "main.tex").validate(&l), Err(JobError::Duplicate("main.tex".into())));
    assert_eq!(job(&["main.tex", "a", "a/b.tex"], "main.tex").validate(&l), Err(JobError::FileIsDirectory("a".into())));
    assert!(matches!(job(&["main.tex"], "other.tex").validate(&l), Err(JobError::MainMissing(_))));
    assert!(matches!(job(&["ma in.tex"], "ma in.tex").validate(&l), Err(JobError::BadMain(_))));
    assert!(matches!(job(&["main.sty"], "main.sty").validate(&l), Err(JobError::BadMain(_))));
    assert_eq!(job(&[], "main.tex").validate(&l), Err(JobError::NoFiles));
    let few = Limits { files: 2, ..Limits::default() };
    assert_eq!(job(&["main.tex", "a.tex", "b.tex"], "main.tex").validate(&few), Err(JobError::TooManyFiles(3)));
    let mut big = job(&["main.tex"], "main.tex");
    big.files[0].1 = vec![b'%'; 2 << 20];
    assert_eq!(big.validate(&Limits { input_mib: 1, ..Limits::default() }), Err(JobError::TooLarge(2 << 20)));
  }
}
