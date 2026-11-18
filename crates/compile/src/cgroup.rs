//! Per-job cgroup v2 confinement. rlimits bind single processes and miss shared memory, so each
//! job also runs in its own cgroup under a delegated subtree: `memory.max` (which counts the
//! scratch tmpfs and any other shmem), `memory.swap.max` 0, `memory.oom.group` (an OOM kills
//! the whole job), `pids.max` and `cpu.max` (one CPU). The runner meters CPU from `cpu.stat`,
//! which also counts orphans, kills the job when it exceeds its CPU budget, and removes the
//! cgroup afterwards (`cgroup.kill` first, so nothing of the job survives).
//!
//! The subtree comes from the deployment: a writable cgroup v2 directory with the `memory`,
//! `pids` and `cpu` controllers (a systemd unit with `Delegate=yes`, or a Kubernetes worker
//! pod's own cgroup seen through its cgroup namespace), or, for development, a transient
//! `systemd-run --user --scope -p Delegate=yes` scope created at startup.

use std::fs::{self, File, OpenOptions};
use std::io::{self, Write};
use std::os::fd::{AsRawFd, OwnedFd, RawFd};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};

/// Where jobs' memory, process and CPU limits come from.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Confinement {
  /// `SCRIBYRA_COMPILE_CGROUP` if set, else a systemd user scope; refuses otherwise.
  Auto,
  /// A delegated, writable cgroup v2 directory (processes already in it are moved to a
  /// `supervisor` leaf so it can enable controllers for the jobs).
  Cgroup(PathBuf),
  /// A transient `systemd-run --user --scope -p Delegate=yes` scope (needs a user manager).
  SystemdUser,
  /// Development only: no job-wide memory, process or CPU limit beyond the per-process rlimits
  /// (shared memory and several processes can exceed `memory_mib`). Must be chosen explicitly.
  UnconfinedMemory,
}

impl Confinement {
  /// `SCRIBYRA_COMPILE_CGROUP=<dir>`, or `SCRIBYRA_COMPILE_UNCONFINED_MEMORY=1` (development
  /// only), or [`Confinement::Auto`].
  pub fn from_env() -> Confinement {
    if let Some(d) = std::env::var_os("SCRIBYRA_COMPILE_CGROUP") { return Confinement::Cgroup(d.into()); }
    if std::env::var("SCRIBYRA_COMPILE_UNCONFINED_MEMORY").as_deref() == Ok("1") { return Confinement::UnconfinedMemory; }
    Confinement::Auto
  }
}

/// A process that keeps a systemd scope alive; it exits when the runner (and so the write end of
/// its stdin) goes away, and the scope is then collected.
struct Holder { child: Child, stdin: Option<OwnedFd> }

impl Drop for Holder {
  fn drop(&mut self) { self.stdin.take(); let _ = self.child.kill(); let _ = self.child.wait(); }
}

pub(crate) struct Cgroups { root: PathBuf, _holder: Option<Holder>, next: AtomicU64 }

const CONTROLLERS: [&str; 3] = ["memory", "pids", "cpu"];

fn put(p: &Path, v: &str) -> io::Result<()> {
  OpenOptions::new().write(true).open(p).and_then(|mut f| f.write_all(v.as_bytes())).map_err(|e| io::Error::new(e.kind(), format!("{}: {e}", p.display())))
}

/// `key value` lines of a cgroup file (`cpu.stat`, `memory.events`, …).
fn stat(p: &Path, key: &str) -> u64 {
  fs::read_to_string(p).ok().and_then(|s| s.lines().find_map(|l| l.strip_prefix(key)?.strip_prefix(' ')?.trim().parse().ok())).unwrap_or(0)
}

impl Cgroups {
  pub(crate) fn delegated(root: PathBuf) -> io::Result<Cgroups> {
    let have = fs::read_to_string(root.join("cgroup.controllers")).map_err(|e| io::Error::new(e.kind(), format!("{} is not a cgroup v2 directory: {e}", root.display())))?;
    if let Some(c) = CONTROLLERS.iter().find(|c| !have.split_whitespace().any(|h| h == **c)) {
      return Err(io::Error::other(format!("the {c} controller is not delegated to {}", root.display())));
    }
    // "No internal processes": move residents into a leaf before enabling controllers below.
    let residents = fs::read_to_string(root.join("cgroup.procs"))?;
    if !residents.trim().is_empty() {
      let leaf = root.join("supervisor");
      if !leaf.exists() { fs::create_dir(&leaf)?; }
      for pid in residents.split_whitespace() { let _ = put(&leaf.join("cgroup.procs"), pid); }
    }
    put(&root.join("cgroup.subtree_control"), "+memory +pids +cpu")?;
    // Jobs left by an earlier runner that died.
    for e in fs::read_dir(&root)?.flatten() {
      if e.file_name().to_string_lossy().starts_with("job-") { let _ = put(&e.path().join("cgroup.kill"), "1"); let _ = fs::remove_dir(e.path()); }
    }
    Ok(Cgroups { root, _holder: None, next: AtomicU64::new(0) })
  }

  /// A delegated transient scope from the user's systemd manager, held by `cat` on a pipe.
  pub(crate) fn systemd_user(cat: &Path) -> io::Result<Cgroups> {
    static N: AtomicU64 = AtomicU64::new(0);
    let unit = format!("scribyra-compile-{}-{}", std::process::id(), N.fetch_add(1, Ordering::Relaxed));
    let (r, w) = crate::bwrap::pipe()?;
    let child = Command::new("systemd-run")
      .args(["--user", "--scope", "--quiet", "--collect", "-p", "Delegate=yes", &format!("--unit={unit}"), "--"]).arg(cat)
      .stdin(Stdio::from(r)).stdout(Stdio::null()).stderr(Stdio::piped()).spawn()
      .map_err(|e| io::Error::new(e.kind(), format!("systemd-run: {e}")))?;
    Cgroups::systemd_wait(Holder { stdin: Some(w), child }, unit, Instant::now())
  }

  fn systemd_wait(holder: Holder, unit: String, t: Instant) -> io::Result<Cgroups> {
    let pid = holder.child.id();
    let mut holder = holder;
    loop {
      let cg = fs::read_to_string(format!("/proc/{pid}/cgroup")).unwrap_or_default();
      if let Some(p) = cg.lines().find_map(|l| l.strip_prefix("0::")).filter(|p| p.ends_with(&format!("/{unit}.scope"))) {
        let mut c = Cgroups::delegated(Path::new("/sys/fs/cgroup").join(p.trim_start_matches('/')))?;
        c._holder = Some(holder);
        return Ok(c);
      }
      if let Ok(Some(st)) = holder.child.try_wait() {
        let mut e = String::new();
        if let Some(mut s) = holder.child.stderr.take() { let _ = io::Read::read_to_string(&mut s, &mut e); }
        return Err(io::Error::other(format!("systemd-run --user --scope failed ({st}): {}", e.trim())));
      }
      if t.elapsed() > Duration::from_secs(10) { return Err(io::Error::other("systemd-run --user --scope did not start in 10 s")); }
      std::thread::sleep(Duration::from_millis(10));
    }
  }

  pub(crate) fn job(&self, l: &crate::Limits) -> io::Result<JobCgroup> {
    let dir = self.root.join(format!("job-{}-{}", std::process::id(), self.next.fetch_add(1, Ordering::Relaxed)));
    fs::create_dir(&dir)?;
    let mut j = JobCgroup { dir, procs: None, done: false };
    put(&j.dir.join("memory.max"), &(l.memory_mib << 20).to_string())?;
    match put(&j.dir.join("memory.swap.max"), "0") { Err(e) if e.kind() == io::ErrorKind::NotFound => {} r => r? }
    put(&j.dir.join("memory.oom.group"), "1")?;
    // bwrap's two processes and the driver come on top of the job's own.
    put(&j.dir.join("pids.max"), &(l.processes + 8).to_string())?;
    put(&j.dir.join("cpu.max"), "100000 100000")?;
    j.procs = Some(OpenOptions::new().write(true).open(j.dir.join("cgroup.procs"))?);
    Ok(j)
  }
}

pub(crate) struct JobCgroup { dir: PathBuf, procs: Option<File>, done: bool }

/// What the job used, read from its cgroup after everything in it was killed.
#[derive(Clone, Copy, Debug, Default)]
pub(crate) struct Usage { pub cpu_usec: u64, pub oom_kills: u64, pub pids_max_hits: u64 }

impl JobCgroup {
  /// The `cgroup.procs` descriptor the child writes "0" to between fork and exec.
  pub(crate) fn procs_fd(&self) -> RawFd { self.procs.as_ref().unwrap().as_raw_fd() }
  pub(crate) fn cpu_usec(&self) -> u64 { stat(&self.dir.join("cpu.stat"), "usage_usec") }
  pub(crate) fn kill(&self) { let _ = put(&self.dir.join("cgroup.kill"), "1"); }

  pub(crate) fn finish(mut self) -> Usage {
    self.kill();
    let t = Instant::now();
    while stat(&self.dir.join("cgroup.events"), "populated") != 0 && t.elapsed() < Duration::from_secs(5) { std::thread::sleep(Duration::from_millis(5)); }
    let u = Usage { cpu_usec: self.cpu_usec(), oom_kills: stat(&self.dir.join("memory.events"), "oom_kill"), pids_max_hits: stat(&self.dir.join("pids.events"), "max") };
    self.remove();
    u
  }

  fn remove(&mut self) {
    if self.done { return; }
    self.done = true;
    self.procs.take();
    for _ in 0..200 { if fs::remove_dir(&self.dir).is_ok() || !self.dir.exists() { return; } self.kill(); std::thread::sleep(Duration::from_millis(10)); }
  }
}

impl Drop for JobCgroup {
  fn drop(&mut self) { if !self.done { self.kill(); self.remove(); } }
}
