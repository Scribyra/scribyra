//! The bubblewrap runner. Each job is one `bwrap` process tree: new user, mount, PID, network,
//! IPC, UTS and cgroup namespaces; a tmpfs root holding read-only binds of exactly the TeX Live
//! closure, a minimal `/dev`, no `/proc`, and the job's tmpfs scratch at `/work` (sized to
//! `scratch_mib`, the only writable path; the root and `/dev` are remounted read-only). Inputs
//! reach the scratch through `--file` from sealed memfds, so nothing of the job ever touches the
//! host's disk, and the scratch disappears with the mount namespace. The driver script
//! (`driver.sh`) runs the passes and hands back the PDF and log over pipes, which are read
//! with size bounds.

use crate::cache::Packages;
use crate::cgroup::{Cgroups, Confinement, Usage};
use crate::{seccomp, Bibliography, Cancel, Engine, Job, JobError, Limit, Limits, Outcome, Runner, Status};
use std::ffi::{CString, OsString};
use std::fs::File;
use std::io::{self, Read, Seek, SeekFrom, Write};
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd, RawFd};
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::Arc;
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use crate::DRIVER;
const RAW: &str = r#"ulimit -u "$1" -n "$2" -f "$3" -c 0 || exit 99; eval "$4""#;
const STDERR_CAP: usize = 64 << 10;

pub struct Bubblewrap { bwrap: PathBuf, closure: Vec<PathBuf>, bash: PathBuf, coreutils: Option<PathBuf>, id: String, conf: Conf, kind: Kind }

/// What runs in the sandbox: native TeX Live, or the browser's WebAssembly engine under Node.
enum Kind { Native { texlive: PathBuf }, Wasm(crate::wasm::Wasm) }

enum Conf { Unset, Cgroups(Cgroups), Unconfined }

/// What a raw sandboxed command did (the test hook, [`Bubblewrap::run_raw`]).
#[derive(Debug)]
pub struct RawOutcome {
  /// Exit code, or 128 + signal.
  pub code: Option<i32>,
  pub stdout: String,
  pub stderr: String,
  /// `LimitExceeded(Wall | Cpu)` or `Cancelled` when the runner killed it.
  pub killed: Option<Status>,
  /// `Memory` after an OOM kill in the job's cgroup, `Processes` when `pids.max` refused a fork.
  pub limit: Option<Limit>,
  pub cpu_ms: u64,
}

/// The runtime closure of store paths (`nix-store -qR`).
pub fn store_closure(roots: &[&Path]) -> io::Result<Vec<PathBuf>> {
  let out = Command::new("nix-store").arg("-qR").args(roots).stderr(Stdio::inherit()).output()?;
  if !out.status.success() { return Err(io::Error::other(format!("nix-store -qR failed: {}", out.status))); }
  Ok(String::from_utf8_lossy(&out.stdout).lines().filter(|l| !l.is_empty()).map(PathBuf::from).collect())
}

fn store_path_ok(p: &Path) -> bool {
  let s = p.to_string_lossy();
  s.starts_with("/nix/store/") && s.len() > 11 && !s[11..].contains('/') && !s[11..].starts_with('.') && p.symlink_metadata().is_ok()
}

impl Bubblewrap {
  /// Computes the TeX Live closure with `nix-store -qR` (once, at startup).
  pub fn new(bwrap: impl Into<PathBuf>, texlive: impl Into<PathBuf>) -> io::Result<Bubblewrap> {
    let texlive = texlive.into();
    let closure = store_closure(&[&texlive])?;
    Bubblewrap::with_closure(bwrap, texlive, closure)
  }

  /// With a precomputed closure (for example `closureInfo`'s `store-paths` in a worker image).
  /// Every entry must be a top-level `/nix/store` path; nothing else is ever bound.
  pub fn with_closure(bwrap: impl Into<PathBuf>, texlive: impl Into<PathBuf>, closure: Vec<PathBuf>) -> io::Result<Bubblewrap> {
    let (bwrap, texlive) = (bwrap.into(), texlive.into());
    let bad = |m: String| io::Error::new(io::ErrorKind::InvalidInput, m);
    if !bwrap.is_file() { return Err(bad(format!("no bwrap at {}", bwrap.display()))); }
    if !store_path_ok(&texlive) || !texlive.join("bin/pdflatex").exists() { return Err(bad(format!("{} is not a TeX Live store path", texlive.display()))); }
    let mut closure = closure;
    if let Some(p) = closure.iter().find(|p| !store_path_ok(p)) { return Err(bad(format!("closure entry {} is not a store path", p.display()))); }
    closure.push(texlive.clone());
    closure.sort();
    closure.dedup();
    let find = |want: &[&str], prefer: &str| closure.iter().filter(|p| want.iter().all(|b| p.join("bin").join(b).is_file())).min_by_key(|p| !p.to_string_lossy().contains(prefer) as u8 * 2 + p.to_string_lossy().contains("interactive") as u8).cloned();
    let bash = find(&["bash"], "-bash-").ok_or_else(|| bad("the TeX Live closure has no bash".into()))?.join("bin/bash");
    let coreutils = find(&["cat", "stat", "tail", "rm", "dd"], "-coreutils-").ok_or_else(|| bad("the TeX Live closure has no coreutils".into()))?;
    let id = texlive.file_name().unwrap().to_string_lossy().into_owned();
    Ok(Bubblewrap { bwrap, closure, bash, coreutils: Some(coreutils), id, conf: Conf::Unset, kind: Kind::Native { texlive } })
  }

  /// The WebAssembly engine: `node` (a store path's `bin/node`) runs the compile runtime
  /// (`scripts/wasm-compile-runtime.mjs`) bound read-only at `/runtime`, with the package cache
  /// read-only at `/cache`; `closure` must hold node's store closure and a bash (for the
  /// in-namespace rlimits). `packages` fills the cache when a job asks.
  pub fn wasm(bwrap: impl Into<PathBuf>, node: impl Into<PathBuf>, closure: Vec<PathBuf>, runtime: impl Into<PathBuf>, cache: impl Into<PathBuf>, packages: Arc<dyn Packages>) -> io::Result<Bubblewrap> {
    let (bwrap, node, runtime, cache) = (bwrap.into(), node.into(), runtime.into(), cache.into());
    let bad = |m: String| io::Error::new(io::ErrorKind::InvalidInput, m);
    if !bwrap.is_file() { return Err(bad(format!("no bwrap at {}", bwrap.display()))); }
    let store = node.parent().and_then(Path::parent).map(Path::to_path_buf).unwrap_or_default();
    if !store_path_ok(&store) || !node.is_file() { return Err(bad(format!("{} is not a node in the Nix store", node.display()))); }
    let mut closure = closure;
    if let Some(p) = closure.iter().find(|p| !store_path_ok(p)) { return Err(bad(format!("closure entry {} is not a store path", p.display()))); }
    closure.push(store);
    closure.sort();
    closure.dedup();
    let bash = closure.iter().filter(|p| p.join("bin/bash").is_file()).min_by_key(|p| p.to_string_lossy().contains("interactive")).ok_or_else(|| bad("the node closure has no bash".into()))?.join("bin/bash");
    let coreutils = closure.iter().find(|p| ["cat", "stat", "rm"].iter().all(|b| p.join("bin").join(b).is_file())).cloned();
    let w = crate::wasm::Wasm::new(node, runtime, cache, packages)?;
    let id = w.id().to_string();
    Ok(Bubblewrap { bwrap, closure, bash, coreutils, id, conf: Conf::Unset, kind: Kind::Wasm(w) })
  }

  /// The compile runtime `runtime` and package cache `cache`, with `SCRIBYRA_BWRAP`,
  /// `SCRIBYRA_NODE` and `SCRIBYRA_WASM_CLOSURE` (a file of store paths; without it,
  /// `nix-store -qR` of node and `SCRIBYRA_BASH`), confined as [`Confinement::from_env`] says.
  pub fn wasm_from_env(runtime: impl Into<PathBuf>, cache: impl Into<PathBuf>, packages: Arc<dyn Packages>) -> io::Result<Bubblewrap> {
    let var = |k: &str| std::env::var_os(k).ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, format!("{k} is not set")));
    let (bwrap, node, runtime) = (var("SCRIBYRA_BWRAP")?, PathBuf::from(var("SCRIBYRA_NODE")?), runtime.into());
    let closure = match std::env::var_os("SCRIBYRA_WASM_CLOSURE") {
      Some(f) => std::fs::read_to_string(f)?.lines().filter(|l| !l.is_empty()).map(PathBuf::from).collect(),
      None => {
        let bash = PathBuf::from(var("SCRIBYRA_BASH")?);
        let roots: Vec<PathBuf> = [&node, &bash].iter().filter_map(|p| p.canonicalize().ok()?.parent()?.parent().map(Path::to_path_buf)).collect();
        store_closure(&roots.iter().map(PathBuf::as_path).collect::<Vec<_>>())?
      }
    };
    Bubblewrap::wasm(bwrap, node, closure, runtime, cache, packages)?.confine(Confinement::from_env())
  }

  /// `SCRIBYRA_BWRAP`, `SCRIBYRA_TEXLIVE` and optionally `SCRIBYRA_TEXLIVE_CLOSURE` (a file of
  /// store paths, one per line), as the development shell and worker image set them, confined
  /// as [`Confinement::from_env`] says.
  pub fn from_env() -> io::Result<Bubblewrap> {
    let var = |k: &str| std::env::var_os(k).ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, format!("{k} is not set")));
    let (bwrap, texlive) = (var("SCRIBYRA_BWRAP")?, var("SCRIBYRA_TEXLIVE")?);
    let b = match std::env::var_os("SCRIBYRA_TEXLIVE_CLOSURE") {
      Some(f) => Bubblewrap::with_closure(bwrap, texlive, std::fs::read_to_string(f)?.lines().filter(|l| !l.is_empty()).map(PathBuf::from).collect())?,
      None => Bubblewrap::new(bwrap, texlive)?,
    };
    b.confine(Confinement::from_env())
  }

  /// Sets up job-wide limits. Until this succeeds every job fails with `SandboxFailure`.
  pub fn confine(mut self, c: Confinement) -> io::Result<Bubblewrap> {
    let cat = match &self.coreutils { Some(c) => c.join("bin/cat"), None => PathBuf::from("cat") };
    self.conf = match c {
      Confinement::Cgroup(d) => Conf::Cgroups(Cgroups::delegated(d)?),
      Confinement::SystemdUser => Conf::Cgroups(Cgroups::systemd_user(&cat)?),
      Confinement::UnconfinedMemory => Conf::Unconfined,
      Confinement::Auto => Conf::Cgroups(Cgroups::systemd_user(&cat).map_err(|e| io::Error::other(format!(
        "no cgroup for compile jobs: set SCRIBYRA_COMPILE_CGROUP to a delegated cgroup v2 directory, run with a systemd user manager, or (development only) SCRIBYRA_COMPILE_UNCONFINED_MEMORY=1 ({e})")))?),
    };
    Ok(self)
  }

  /// Whether jobs run in their own cgroup (memory, processes and CPU bounded per job).
  pub fn is_confined(&self) -> bool { matches!(self.conf, Conf::Cgroups(_)) }

  pub fn closure(&self) -> &[PathBuf] { &self.closure }
  pub(crate) fn bash(&self) -> &Path { &self.bash }
  /// Native: whether the TeX Live tree has biber. The WebAssembly engine always has Biber.
  pub fn has_biber(&self) -> bool { match &self.kind { Kind::Native { texlive } => texlive.join("bin/biber").exists(), Kind::Wasm(_) => true } }
  /// Whether this runner is the WebAssembly engine.
  pub fn is_wasm(&self) -> bool { matches!(self.kind, Kind::Wasm(_)) }

  /// Test hook: runs a bash `script` in the same sandbox (closure binds plus `extra_ro`, same
  /// seccomp filter, rlimits and wall clock) with `files` in `/work`. Not used by compiles.
  #[doc(hidden)]
  pub fn run_raw(&self, script: &str, extra_ro: &[PathBuf], files: &[(String, Vec<u8>)], limits: &Limits, cancel: &Cancel) -> io::Result<RawOutcome> {
    if let Some(p) = extra_ro.iter().find(|p| !store_path_ok(p)) { return Err(io::Error::new(io::ErrorKind::InvalidInput, format!("{} is not a store path", p.display()))); }
    for (p, _) in files { crate::check_path(p).map_err(|e| io::Error::new(io::ErrorKind::InvalidInput, e.to_string()))?; }
    let inner = |_: &[RawFd]| -> Vec<OsString> {
      let l = inner_limits(limits);
      [self.bash.as_os_str(), "-c".as_ref(), RAW.as_ref(), "raw".as_ref(), l[0].as_ref(), l[1].as_ref(), l[2].as_ref(), script.as_ref()].iter().map(|s| s.to_os_string()).collect()
    };
    let r = self.sandbox(Spec { files, extra_ro, mounts: &self.mounts(), openin: "p", epoch: 0, pipes: 0, fill: None, address_space: !self.is_wasm(), stdout_cap: 1 << 20 }, limits, cancel, inner)?;
    let limit = r.usage.and_then(|u| if u.oom_kills > 0 { Some(Limit::Memory) } else if u.pids_max_hits > 0 { Some(Limit::Processes) } else { None });
    Ok(RawOutcome { code: r.code, stdout: lossy(&r.stdout.0), stderr: lossy(&r.stderr.0), killed: r.killed, limit, cpu_ms: r.cpu_ms })
  }

  /// Starts bwrap and waits for it under the wall clock. `inner` builds the command run inside
  /// from the descriptor numbers of `pipes` extra capture pipes (handed to the sandbox).
  /// Read-only binds at fixed places: the WebAssembly runtime and the package cache.
  fn mounts(&self) -> Vec<(PathBuf, &'static str)> {
    match &self.kind { Kind::Native { .. } => vec![], Kind::Wasm(w) => vec![(w.runtime().to_path_buf(), "/runtime"), (w.cache().to_path_buf(), "/cache")] }
  }

  pub(crate) fn sandbox(&self, spec: Spec, limits: &Limits, cancel: &Cancel, inner: impl FnOnce(&[RawFd]) -> Vec<OsString>) -> io::Result<Ran> {
    let Spec { files, extra_ro, mounts, openin, epoch, pipes, fill, address_space, stdout_cap } = spec;
    let cg = match &self.conf {
      Conf::Cgroups(c) => Some(c.job(limits)?),
      Conf::Unconfined => None,
      Conf::Unset => return Err(io::Error::other("the runner has no job confinement (Bubblewrap::confine)")),
    };
    let mut pass: Vec<RawFd> = vec![];
    let mut keep: Vec<OwnedFd> = vec![];
    let mut a: Vec<OsString> = vec![];
    let mut arg = |s: &dyn AsRef<std::ffi::OsStr>| a.push(s.as_ref().to_os_string());
    for s in ["--unshare-all", "--unshare-user", "--die-with-parent", "--new-session", "--clearenv", "--cap-drop", "ALL"] { arg(&s); }
    let mut binds: Vec<&PathBuf> = self.closure.iter().chain(extra_ro).collect();
    binds.sort();
    binds.dedup();
    for p in binds { arg(&"--ro-bind"); arg(p); arg(p); }
    for (from, to) in mounts { arg(&"--ro-bind"); arg(from); arg(to); }
    // No /proc at all: nothing in a compile needs it, and it would show the host (kernel,
    // CPUs, memory, mounts) and let job code reach the driver's descriptors.
    for s in ["--dev", "/dev", "--size"] { arg(&s); }
    arg(&(limits.scratch_mib << 20).to_string());
    arg(&"--tmpfs"); arg(&"/work");
    let mut dirs: Vec<String> = [".home", ".texmf-var", ".tmp", ".cache"].iter().map(|s| s.to_string()).collect();
    for (p, _) in files { let mut at = 0; while let Some(i) = p[at..].find('/') { dirs.push(p[..at + i].to_string()); at += i + 1; } }
    dirs.sort();
    dirs.dedup();
    for d in &dirs { arg(&"--dir"); arg(&format!("/work/{d}")); }
    let mut largest = 0u64;
    for (p, bytes) in files {
      let fd = memfd("scribyra-input", bytes)?;
      largest = largest.max(bytes.len() as u64);
      arg(&"--file"); arg(&fd.as_raw_fd().to_string()); arg(&format!("/work/{p}"));
      pass.push(fd.as_raw_fd());
      keep.push(fd);
    }
    for s in ["--remount-ro", "/dev", "--remount-ro", "/", "--chdir", "/work"] { arg(&s); }
    let path = match (&self.kind, &self.coreutils) {
      (Kind::Native { texlive }, Some(c)) => format!("{}/bin:{}/bin", texlive.display(), c.display()),
      (_, Some(c)) => format!("{}/bin", c.display()),
      _ => "/nonexistent".into(),
    };
    let epoch = epoch.to_string();
    for (k, v) in [("PATH", path.as_str()), ("HOME", "/work/.home"), ("TEXMFVAR", "/work/.texmf-var"), ("TEXMFCACHE", "/work/.texmf-var"), ("XDG_CACHE_HOME", "/work/.cache"), ("TMPDIR", "/work/.tmp"),
      ("openin_any", openin), ("openout_any", "p"), ("shell_escape", "f"), ("SOURCE_DATE_EPOCH", epoch.as_str())] {
      arg(&"--setenv"); arg(&k); arg(&v);
    }
    let filter = memfd("scribyra-seccomp", &seccomp::program())?;
    arg(&"--seccomp"); arg(&filter.as_raw_fd().to_string());
    pass.push(filter.as_raw_fd());
    keep.push(filter);
    let (mut readers, mut writers, mut wfds) = (vec![], vec![], vec![]);
    for _ in 0..pipes { let (r, w) = pipe()?; wfds.push(w.as_raw_fd()); pass.push(w.as_raw_fd()); readers.push(r); writers.push(w); }
    // The package channel: the job writes requests, the worker answers on the reply pipe.
    let mut channel = None;
    if let Some(packages) = fill {
      let (req_r, req_w) = pipe()?;
      let (rep_r, rep_w) = pipe()?;
      wfds.push(req_w.as_raw_fd()); wfds.push(rep_r.as_raw_fd());
      pass.push(req_w.as_raw_fd()); pass.push(rep_r.as_raw_fd());
      writers.push(req_w); writers.push(rep_r);
      channel = Some((req_r, rep_w, packages));
    }
    arg(&"--");
    a.extend(inner(&wfds));

    let mib = |m: u64| m << 20;
    let rl = [
      (libc::RLIMIT_CPU, limits.cpu_seconds, limits.cpu_seconds + 1),
      // V8 reserves about 10 GiB of address space per WebAssembly memory (guard regions), so
      // the WebAssembly engine is bounded by its cgroup's memory.max instead (Node's heap flag
      // and the engine's own heap cap bound it too).
      (libc::RLIMIT_AS, if address_space { mib(limits.memory_mib) } else { libc::RLIM_INFINITY }, if address_space { mib(limits.memory_mib) } else { libc::RLIM_INFINITY }),
      (libc::RLIMIT_FSIZE, mib(limits.output_mib).max(largest + 1), mib(limits.output_mib).max(largest + 1)),
      (libc::RLIMIT_NOFILE, limits.open_files.max(pass.len() as u64 + 64), limits.open_files.max(pass.len() as u64 + 64)),
      (libc::RLIMIT_CORE, 0, 0),
    ];
    let mut cmd = Command::new(&self.bwrap);
    cmd.args(&a).env_clear().stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped()).process_group(0);
    let pass_c = pass.clone();
    let procs = cg.as_ref().map(|c| c.procs_fd());
    // SAFETY: only async-signal-safe calls (write, fcntl, setrlimit) between fork and exec.
    unsafe {
      cmd.pre_exec(move || {
        // Into the job's cgroup before bwrap exists, so every process of the job is counted.
        if let Some(fd) = procs && libc::write(fd, b"0".as_ptr().cast(), 1) != 1 { return Err(io::Error::last_os_error()); }
        for &fd in &pass_c { if libc::fcntl(fd, libc::F_SETFD, 0) < 0 { return Err(io::Error::last_os_error()); } }
        for &(r, soft, hard) in &rl { if libc::setrlimit(r, &libc::rlimit { rlim_cur: soft, rlim_max: hard }) < 0 { return Err(io::Error::last_os_error()); } }
        Ok(())
      });
    }
    let mut child = cmd.spawn()?;
    drop(writers);
    drop(keep);
    let out = read_bounded(child.stdout.take().unwrap(), stdout_cap, false);
    let err = read_bounded(child.stderr.take().unwrap(), STDERR_CAP, true);
    let caps: Vec<_> = readers.into_iter().zip(pipe_caps(limits, pipes)).enumerate().map(|(i, (r, cap))| read_bounded(File::from(r), cap, i == 2)).collect();
    if let Some((req, reply, packages)) = channel { std::thread::spawn(move || serve_packages(File::from(req), File::from(reply), packages)); }
    let pid = child.id() as libc::pid_t;
    let deadline = Instant::now() + Duration::from_secs(limits.wall_seconds);
    let (mut status, mut ru): (libc::c_int, libc::rusage) = (0, unsafe { std::mem::zeroed() });
    let mut killed = None;
    let budget = limits.cpu_seconds.saturating_mul(1_000_000);
    let mut tick = 0u32;
    loop {
      let flags = if killed.is_some() { 0 } else { libc::WNOHANG };
      let r = unsafe { libc::wait4(pid, &mut status, flags, &mut ru) };
      if r == pid { break; }
      if r < 0 && io::Error::last_os_error().kind() != io::ErrorKind::Interrupted { return Err(io::Error::last_os_error()); }
      if killed.is_none() {
        tick = tick.wrapping_add(1);
        let why = if cancel.is_cancelled() { Some(Status::Cancelled) } else if Instant::now() >= deadline { Some(Status::LimitExceeded(Limit::Wall)) }
          else if tick.is_multiple_of(10) && cg.as_ref().is_some_and(|c| c.cpu_usec() > budget) { Some(Status::LimitExceeded(Limit::Cpu)) } else { None };
        // cgroup.kill takes every process of the job; without a cgroup, bwrap is the group
        // leader and --die-with-parent and the PID namespace take the rest.
        if let Some(w) = why {
          if let Some(c) = &cg { c.kill(); }
          unsafe { libc::kill(-pid, libc::SIGKILL); libc::kill(pid, libc::SIGKILL); }
          killed = Some(w);
          continue;
        }
        std::thread::sleep(Duration::from_millis(5));
      }
    }
    let code = if libc::WIFEXITED(status) { Some(libc::WEXITSTATUS(status)) } else if libc::WIFSIGNALED(status) { Some(128 + libc::WTERMSIG(status)) } else { None };
    let usage = cg.map(|c| c.finish());
    let ms = |t: libc::timeval| t.tv_sec as u64 * 1000 + t.tv_usec as u64 / 1000;
    let cpu_ms = usage.map_or(ms(ru.ru_utime) + ms(ru.ru_stime), |u| u.cpu_usec / 1000);
    Ok(Ran { code, cpu_ms, usage, killed, stdout: out.join().unwrap(), stderr: err.join().unwrap(), pipes: caps.into_iter().map(|h| h.join().unwrap()).collect() })
  }
}

fn pipe_caps(l: &Limits, n: usize) -> Vec<usize> {
  // status, PDF, log
  [64 << 10, ((l.output_mib << 20) as usize).saturating_add(1), (l.log_kib << 10) as usize].into_iter().take(n).collect()
}

/// (bytes kept, total bytes seen). Keeps the first `cap` bytes (the last ones with `tail`);
/// reads to the end regardless.
pub(crate) type Captured = (Vec<u8>, u64);

pub(crate) struct Ran { pub code: Option<i32>, pub cpu_ms: u64, pub usage: Option<Usage>, pub killed: Option<Status>, pub stdout: Captured, pub stderr: Captured, pub pipes: Vec<Captured> }

/// One sandbox run: inputs, extra read-only binds (store paths at their own place, and
/// `mounts` at fixed places), TeX's `openin_any`, `SOURCE_DATE_EPOCH`, capture pipes handed to
/// the job (status, PDF, log), an optional package channel, whether `RLIMIT_AS` applies, and
/// how much of stdout to keep.
pub(crate) struct Spec<'a> {
  pub files: &'a [(String, Vec<u8>)],
  pub extra_ro: &'a [PathBuf],
  pub mounts: &'a [(PathBuf, &'static str)],
  pub openin: &'a str,
  pub epoch: u64,
  pub pipes: usize,
  pub fill: Option<Arc<dyn Packages>>,
  pub address_space: bool,
  pub stdout_cap: usize,
}

/// Answers a job's package requests (`{"fill": name}` lines) until it closes its end. At most
/// 128 requests and short lines: a job cannot make the worker do unbounded work.
fn serve_packages(req: File, mut reply: File, packages: Arc<dyn Packages>) {
  use std::io::BufRead;
  let mut lines = io::BufReader::new(req.take(128 * 1024)).lines();
  for _ in 0..128 {
    let Some(Ok(line)) = lines.next() else { return };
    let answer = match serde_json::from_str::<serde_json::Value>(&line).ok().and_then(|v| v.get("fill")?.as_str().map(str::to_owned)) {
      Some(name) => match packages.fill(&name) { Ok(()) => serde_json::json!({"ok": true}), Err(e) => serde_json::json!({"ok": false, "error": e}) },
      None => serde_json::json!({"ok": false, "error": "invalid package request"}),
    };
    if writeln!(reply, "{answer}").is_err() { return; }
  }
  let _ = writeln!(reply, "{}", serde_json::json!({"ok": false, "error": "too many package requests in one compile"}));
}

fn read_bounded(mut r: impl Read + Send + 'static, cap: usize, tail: bool) -> JoinHandle<Captured> {
  std::thread::spawn(move || {
    let (mut kept, mut seen, mut buf) = (Vec::new(), 0u64, vec![0u8; 64 << 10]);
    loop {
      match r.read(&mut buf) {
        Ok(0) => break,
        Ok(n) if tail => { seen += n as u64; kept.extend_from_slice(&buf[..n]); if kept.len() > 2 * cap.max(1) { kept.drain(..kept.len() - cap); } }
        Ok(n) => { seen += n as u64; let room = cap.saturating_sub(kept.len()); kept.extend_from_slice(&buf[..n.min(room)]); }
        Err(e) if e.kind() == io::ErrorKind::Interrupted => continue,
        Err(_) => break,
      }
    }
    if kept.len() > cap { kept.drain(..kept.len() - cap); }
    (kept, seen)
  })
}

pub(crate) fn lossy(b: &[u8]) -> String { String::from_utf8_lossy(b).into_owned() }

fn memfd(name: &str, bytes: &[u8]) -> io::Result<OwnedFd> {
  let n = CString::new(name).unwrap();
  let fd = unsafe { libc::memfd_create(n.as_ptr(), libc::MFD_CLOEXEC | libc::MFD_ALLOW_SEALING) };
  if fd < 0 { return Err(io::Error::last_os_error()); }
  let mut f = unsafe { File::from_raw_fd(fd) };
  f.write_all(bytes)?;
  f.seek(SeekFrom::Start(0))?;
  let seals = libc::F_SEAL_SEAL | libc::F_SEAL_SHRINK | libc::F_SEAL_GROW | libc::F_SEAL_WRITE;
  if unsafe { libc::fcntl(f.as_raw_fd(), libc::F_ADD_SEALS, seals) } < 0 { return Err(io::Error::last_os_error()); }
  Ok(f.into())
}

pub(crate) fn pipe() -> io::Result<(OwnedFd, OwnedFd)> {
  let mut fds = [0; 2];
  if unsafe { libc::pipe2(fds.as_mut_ptr(), libc::O_CLOEXEC) } < 0 { return Err(io::Error::last_os_error()); }
  Ok(unsafe { (OwnedFd::from_raw_fd(fds[0]), OwnedFd::from_raw_fd(fds[1])) })
}

/// The children's user + system time from the driver's last `times` report ("1m2.345s 0m0.010s").
fn children_cpu_ms(report: &str) -> u64 {
  let lines: Vec<&str> = report.lines().collect();
  let Some(i) = lines.iter().rposition(|l| *l == "times") else { return 0 };
  let ms = |t: &str| -> Option<u64> { let (m, s) = t.strip_suffix('s')?.split_once('m')?; let (s, f) = s.split_once('.').unwrap_or((s, "0")); Some(m.parse::<u64>().ok()? * 60_000 + s.parse::<u64>().ok()? * 1000 + format!("{f:0<3}")[..3].parse::<u64>().ok()?) };
  lines.get(i + 2).map(|l| l.split_whitespace().filter_map(ms).sum()).unwrap_or(0)
}

/// The limits the driver sets itself, inside the job's user namespace: processes, open files,
/// file size in KiB.
pub(crate) fn inner_limits(l: &Limits) -> [String; 3] { [l.processes.to_string(), l.open_files.to_string(), (l.output_mib << 10).to_string()] }

impl Runner for Bubblewrap {
  fn texlive_id(&self) -> &str { &self.id }

  fn run(&self, job: &Job, limits: &Limits, cancel: &Cancel) -> Outcome {
    if let Kind::Wasm(w) = &self.kind { return w.run(self, job, limits, cancel); }
    if let Err(e) = job.validate(limits) { return Outcome::fail(Status::Rejected(e.clone()), e.to_string()); }
    if job.bibliography == Bibliography::Biber && !self.has_biber() { return Outcome::fail(Status::Rejected(JobError::BiberUnavailable), JobError::BiberUnavailable.to_string()); }
    let bib = match job.bibliography { Bibliography::None => "none", Bibliography::Bibtex => "bibtex", Bibliography::Biber => "biber" };
    // LuaTeX's own Lua code (luaotfload) opens files kpathsea found by absolute path, which
    // openin_any=p refuses; it reads with r (no dot files). The sandbox holds nothing but the
    // TeX Live closure and the job's scratch, so absolute reads reach nothing else.
    let openin = if job.engine == Engine::Lualatex { "r" } else { "p" };
    let inner = |fds: &[RawFd]| -> Vec<OsString> {
      let l = inner_limits(limits);
      let mut v: Vec<OsString> = vec![self.bash.clone().into(), "-c".into(), DRIVER.into(), "driver".into()];
      v.extend(fds.iter().map(|f| f.to_string().into()));
      v.extend([job.engine.command(), &job.main, &limits.passes.max(1).to_string(), bib, &l[0], &l[1], &l[2]].map(OsString::from));
      v
    };
    let ran = match self.sandbox(Spec { files: &job.files, extra_ro: &[], mounts: &[], openin, epoch: job.source_date_epoch, pipes: 3, fill: None, address_space: true, stdout_cap: 64 << 10 }, limits, cancel, inner) {
      Ok(r) => r,
      Err(e) => return Outcome::fail(Status::SandboxFailure, format!("could not start the sandbox: {e}")),
    };
    let report = lossy(&ran.pipes[0].0);
    let passes = report.lines().filter(|l| l.starts_with("pass ")).count() as u32;
    let (log_bytes, log_seen) = &ran.pipes[2];
    let mut log = if *log_seen > log_bytes.len() as u64 { format!("[log truncated to its last {} bytes of {log_seen}]\n{}", log_bytes.len(), lossy(log_bytes)) } else { lossy(log_bytes) };
    let (pdf, pdf_seen) = &ran.pipes[1];
    let last = report.lines().rev().find(|l| *l == "done" || *l == "tex-error" || l.starts_with("limit")).unwrap_or("");
    // The report only classifies; the runner's own kills and the cgroup's events come first,
    // and success needs a PDF the runner received itself.
    let usage = ran.usage.unwrap_or_default();
    let status = match (&ran.killed, last) {
      (Some(k), _) => {
        let why = match k { Status::Cancelled => "cancelled".into(), Status::LimitExceeded(Limit::Cpu) => format!("CPU budget of {} s", limits.cpu_seconds), _ => format!("wall-clock limit of {} s", limits.wall_seconds) };
        log.push_str(&format!("\n[stopped: {why}]\n"));
        k.clone()
      }
      _ if usage.oom_kills > 0 => { log.push_str(&format!("\n[stopped: memory limit of {} MiB]\n", limits.memory_mib)); Status::LimitExceeded(Limit::Memory) }
      (_, "done") if *pdf_seen > limits.output_mib << 20 => Status::LimitExceeded(Limit::Output),
      (_, "done") if pdf.starts_with(b"%PDF-") => Status::Success,
      (_, "tex-error") => Status::TexError,
      (_, "limit cpu") => Status::LimitExceeded(Limit::Cpu),
      (_, "limit memory") => Status::LimitExceeded(Limit::Memory),
      (_, "limit output") => Status::LimitExceeded(Limit::Output),
      (_, "limit scratch") => Status::LimitExceeded(Limit::Scratch),
      _ if usage.pids_max_hits > 0 => Status::LimitExceeded(Limit::Processes),
      _ => {
        log.push_str(&format!("\n[sandbox failure: exit {:?}, report {:?}]\n{}", ran.code, report, lossy(&ran.stderr.0)));
        Status::SandboxFailure
      }
    };
    let pdf = (status == Status::Success).then(|| ran.pipes.into_iter().nth(1).unwrap().0);
    // With a cgroup, CPU time comes from cpu.stat (orphans included); the driver's own figure
    // is only a fallback for unconfined development runs.
    let cpu_ms = if ran.usage.is_some() { ran.cpu_ms } else { ran.cpu_ms + children_cpu_ms(&report) };
    Outcome { status, pdf, log, cpu_ms, passes: passes.min(limits.passes.max(1)) }
  }
}

#[cfg(test)]
mod tests {
  #[test]
  fn reads_children_cpu_time_from_times() {
    assert_eq!(super::children_cpu_ms("pass 1\ntimes\n0m0.010s 0m0.002s\n0m1.5s 0m0.250s\ntimes\n0m0.011s 0m0.002s\n1m2.345s 0m0.010s\ndone"), 62_355);
    assert_eq!(super::children_cpu_ms("pass 1"), 0);
  }

  #[test]
  fn inputs_are_sealed_memfds() {
    use std::os::fd::AsRawFd;
    let fd = super::memfd("t", b"hello").unwrap();
    let seals = unsafe { libc::fcntl(fd.as_raw_fd(), libc::F_GET_SEALS) };
    assert_eq!(seals, libc::F_SEAL_SEAL | libc::F_SEAL_SHRINK | libc::F_SEAL_GROW | libc::F_SEAL_WRITE);
    assert!(unsafe { libc::write(fd.as_raw_fd(), b"x".as_ptr().cast(), 1) } < 0);
  }
}
