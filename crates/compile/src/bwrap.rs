//! The bubblewrap runner. Each job is one `bwrap` process tree: new user, mount, PID, network,
//! IPC, UTS and cgroup namespaces; a tmpfs root holding read-only binds of exactly the TeX Live
//! closure, a minimal `/dev`, a new `/proc` and the job's tmpfs scratch at `/work` (sized to
//! `scratch_mib`, the only writable path; the root and `/dev` are remounted read-only). Inputs
//! reach the scratch through `--file` from sealed memfds, so nothing of the job ever touches the
//! host's disk, and the scratch disappears with the mount namespace. The driver script
//! (`driver.sh`) runs the passes and hands back the PDF and log over pipes, which are read
//! with size bounds.

use crate::{seccomp, Bibliography, Cancel, Engine, Job, JobError, Limit, Limits, Outcome, Runner, Status};
use std::ffi::{CString, OsString};
use std::fs::File;
use std::io::{self, Read, Seek, SeekFrom, Write};
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd, RawFd};
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

const DRIVER: &str = include_str!("driver.sh");
const RAW: &str = r#"ulimit -u "$1" -n "$2" -f "$3" -c 0 || exit 99; eval "$4""#;
const STDERR_CAP: usize = 64 << 10;

pub struct Bubblewrap { bwrap: PathBuf, texlive: PathBuf, closure: Vec<PathBuf>, bash: PathBuf, coreutils: PathBuf, id: String }

/// What a raw sandboxed command did (the test hook, [`Bubblewrap::run_raw`]).
#[derive(Debug)]
pub struct RawOutcome {
  /// Exit code, or 128 + signal.
  pub code: Option<i32>,
  pub stdout: String,
  pub stderr: String,
  /// `LimitExceeded(Wall)` or `Cancelled` when the runner killed it.
  pub killed: Option<Status>,
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
    let coreutils = find(&["cat", "stat", "tail", "rm"], "-coreutils-").ok_or_else(|| bad("the TeX Live closure has no coreutils".into()))?;
    let id = texlive.file_name().unwrap().to_string_lossy().into_owned();
    Ok(Bubblewrap { bwrap, texlive, closure, bash, coreutils, id })
  }

  /// `SCRIBYRA_BWRAP`, `SCRIBYRA_TEXLIVE` and optionally `SCRIBYRA_TEXLIVE_CLOSURE` (a file of
  /// store paths, one per line), as the development shell and worker image set them.
  pub fn from_env() -> io::Result<Bubblewrap> {
    let var = |k: &str| std::env::var_os(k).ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, format!("{k} is not set")));
    let (bwrap, texlive) = (var("SCRIBYRA_BWRAP")?, var("SCRIBYRA_TEXLIVE")?);
    match std::env::var_os("SCRIBYRA_TEXLIVE_CLOSURE") {
      Some(f) => Bubblewrap::with_closure(bwrap, texlive, std::fs::read_to_string(f)?.lines().filter(|l| !l.is_empty()).map(PathBuf::from).collect()),
      None => Bubblewrap::new(bwrap, texlive),
    }
  }

  pub fn closure(&self) -> &[PathBuf] { &self.closure }
  pub fn has_biber(&self) -> bool { self.texlive.join("bin/biber").exists() }

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
    let r = self.sandbox(files, extra_ro, ("p", 0), 0, limits, cancel, 1 << 20, inner)?;
    Ok(RawOutcome { code: r.code, stdout: lossy(&r.stdout.0), stderr: lossy(&r.stderr.0), killed: r.killed, cpu_ms: r.cpu_ms })
  }

  /// Starts bwrap and waits for it under the wall clock. `inner` builds the command run inside
  /// from the descriptor numbers of `pipes` extra capture pipes (handed to the sandbox).
  #[allow(clippy::too_many_arguments)]
  fn sandbox(&self, files: &[(String, Vec<u8>)], extra_ro: &[PathBuf], (openin, epoch): (&str, u64), pipes: usize, limits: &Limits, cancel: &Cancel, stdout_cap: usize, inner: impl FnOnce(&[RawFd]) -> Vec<OsString>) -> io::Result<Ran> {
    let mut pass: Vec<RawFd> = vec![];
    let mut keep: Vec<OwnedFd> = vec![];
    let mut a: Vec<OsString> = vec![];
    let mut arg = |s: &dyn AsRef<std::ffi::OsStr>| a.push(s.as_ref().to_os_string());
    for s in ["--unshare-all", "--unshare-user", "--die-with-parent", "--new-session", "--clearenv", "--cap-drop", "ALL"] { arg(&s); }
    let mut binds: Vec<&PathBuf> = self.closure.iter().chain(extra_ro).collect();
    binds.sort();
    binds.dedup();
    for p in binds { arg(&"--ro-bind"); arg(p); arg(p); }
    for s in ["--dev", "/dev", "--proc", "/proc", "--size"] { arg(&s); }
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
    let path = format!("{}/bin:{}/bin", self.texlive.display(), self.coreutils.display());
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
    arg(&"--");
    a.extend(inner(&wfds));

    let mib = |m: u64| m << 20;
    let rl = [
      (libc::RLIMIT_CPU, limits.cpu_seconds, limits.cpu_seconds + 1),
      (libc::RLIMIT_AS, mib(limits.memory_mib), mib(limits.memory_mib)),
      (libc::RLIMIT_FSIZE, mib(limits.output_mib).max(largest + 1), mib(limits.output_mib).max(largest + 1)),
      (libc::RLIMIT_NOFILE, limits.open_files.max(pass.len() as u64 + 64), limits.open_files.max(pass.len() as u64 + 64)),
      (libc::RLIMIT_CORE, 0, 0),
    ];
    let mut cmd = Command::new(&self.bwrap);
    cmd.args(&a).env_clear().stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped()).process_group(0);
    let pass_c = pass.clone();
    // SAFETY: only async-signal-safe calls (fcntl, setrlimit) between fork and exec.
    unsafe {
      cmd.pre_exec(move || {
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
    let pid = child.id() as libc::pid_t;
    let deadline = Instant::now() + Duration::from_secs(limits.wall_seconds);
    let (mut status, mut ru): (libc::c_int, libc::rusage) = (0, unsafe { std::mem::zeroed() });
    let mut killed = None;
    loop {
      let flags = if killed.is_some() { 0 } else { libc::WNOHANG };
      let r = unsafe { libc::wait4(pid, &mut status, flags, &mut ru) };
      if r == pid { break; }
      if r < 0 && io::Error::last_os_error().kind() != io::ErrorKind::Interrupted { return Err(io::Error::last_os_error()); }
      if killed.is_none() {
        let why = if cancel.is_cancelled() { Some(Status::Cancelled) } else if Instant::now() >= deadline { Some(Status::LimitExceeded(Limit::Wall)) } else { None };
        // bwrap is the group leader; --die-with-parent and the PID namespace take the rest.
        if let Some(w) = why { unsafe { libc::kill(-pid, libc::SIGKILL); libc::kill(pid, libc::SIGKILL); } killed = Some(w); continue; }
        std::thread::sleep(Duration::from_millis(5));
      }
    }
    let code = if libc::WIFEXITED(status) { Some(libc::WEXITSTATUS(status)) } else if libc::WIFSIGNALED(status) { Some(128 + libc::WTERMSIG(status)) } else { None };
    let cpu_ms = |t: libc::timeval| t.tv_sec as u64 * 1000 + t.tv_usec as u64 / 1000;
    Ok(Ran { code, cpu_ms: cpu_ms(ru.ru_utime) + cpu_ms(ru.ru_stime), killed, stdout: out.join().unwrap(), stderr: err.join().unwrap(), pipes: caps.into_iter().map(|h| h.join().unwrap()).collect() })
  }
}

fn pipe_caps(l: &Limits, n: usize) -> Vec<usize> {
  // status, PDF, log
  [64 << 10, ((l.output_mib << 20) as usize).saturating_add(1), (l.log_kib << 10) as usize].into_iter().take(n).collect()
}

/// (bytes kept, total bytes seen). Keeps the first `cap` bytes (the last ones with `tail`);
/// reads to the end regardless.
type Captured = (Vec<u8>, u64);

struct Ran { code: Option<i32>, cpu_ms: u64, killed: Option<Status>, stdout: Captured, stderr: Captured, pipes: Vec<Captured> }

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

fn lossy(b: &[u8]) -> String { String::from_utf8_lossy(b).into_owned() }

fn memfd(name: &str, bytes: &[u8]) -> io::Result<OwnedFd> {
  let n = CString::new(name).unwrap();
  let fd = unsafe { libc::memfd_create(n.as_ptr(), libc::MFD_CLOEXEC) };
  if fd < 0 { return Err(io::Error::last_os_error()); }
  let mut f = unsafe { File::from_raw_fd(fd) };
  f.write_all(bytes)?;
  f.seek(SeekFrom::Start(0))?;
  Ok(f.into())
}

fn pipe() -> io::Result<(OwnedFd, OwnedFd)> {
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
fn inner_limits(l: &Limits) -> [String; 3] { [l.processes.to_string(), l.open_files.to_string(), (l.output_mib << 10).to_string()] }

impl Runner for Bubblewrap {
  fn texlive_id(&self) -> &str { &self.id }

  fn run(&self, job: &Job, limits: &Limits, cancel: &Cancel) -> Outcome {
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
    let ran = match self.sandbox(&job.files, &[], (openin, job.source_date_epoch), 3, limits, cancel, 64 << 10, inner) {
      Ok(r) => r,
      Err(e) => return Outcome::fail(Status::SandboxFailure, format!("could not start the sandbox: {e}")),
    };
    let report = lossy(&ran.pipes[0].0);
    let passes = report.lines().filter(|l| l.starts_with("pass ")).count() as u32;
    let (log_bytes, log_seen) = &ran.pipes[2];
    let mut log = if *log_seen > log_bytes.len() as u64 { format!("[log truncated to its last {} bytes of {log_seen}]\n{}", log_bytes.len(), lossy(log_bytes)) } else { lossy(log_bytes) };
    let (pdf, pdf_seen) = &ran.pipes[1];
    let last = report.lines().rev().find(|l| *l == "done" || *l == "tex-error" || l.starts_with("limit")).unwrap_or("");
    let status = match (&ran.killed, last) {
      (Some(k), _) => { log.push_str(&format!("\n[stopped: {}]\n", if *k == Status::Cancelled { "cancelled".into() } else { format!("wall-clock limit of {} s", limits.wall_seconds) })); k.clone() }
      (_, "done") if *pdf_seen > limits.output_mib << 20 => Status::LimitExceeded(Limit::Output),
      (_, "done") if pdf.starts_with(b"%PDF-") => Status::Success,
      (_, "tex-error") => Status::TexError,
      (_, "limit cpu") => Status::LimitExceeded(Limit::Cpu),
      (_, "limit memory") => Status::LimitExceeded(Limit::Memory),
      (_, "limit output") => Status::LimitExceeded(Limit::Output),
      (_, "limit scratch") => Status::LimitExceeded(Limit::Scratch),
      _ => {
        log.push_str(&format!("\n[sandbox failure: exit {:?}, report {:?}]\n{}", ran.code, report, lossy(&ran.stderr.0)));
        Status::SandboxFailure
      }
    };
    let pdf = (status == Status::Success).then(|| ran.pipes.into_iter().nth(1).unwrap().0);
    Outcome { status, pdf, log, cpu_ms: ran.cpu_ms + children_cpu_ms(&report), passes }
  }
}

#[cfg(test)]
mod tests {
  #[test]
  fn reads_children_cpu_time_from_times() {
    assert_eq!(super::children_cpu_ms("pass 1\ntimes\n0m0.010s 0m0.002s\n0m1.5s 0m0.250s\ntimes\n0m0.011s 0m0.002s\n1m2.345s 0m0.010s\ndone"), 62_355);
    assert_eq!(super::children_cpu_ms("pass 1"), 0);
  }
}
