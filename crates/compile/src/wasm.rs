//! The WebAssembly engine: the browser's BusyTeX LuaLaTeX, its worker glue and the browser's
//! compile driver, run by Node (`server/compile/runner.mjs` in the compile runtime) inside the
//! same bubblewrap sandbox, cgroup and seccomp filter as native TeX Live. Layers, outermost
//! first: the job's cgroup (memory, processes, CPU), bwrap's namespaces (no network, an empty
//! root holding only Node's store closure, the runtime at `/runtime` and the package cache at
//! `/cache`, both read-only, and the job's tmpfs `/work`), the seccomp allow list, rlimits,
//! Node's permission model (reads of `/runtime`, `/cache` and `/work` only; no writes, child
//! processes, workers, native addons or WASI), and finally the engine's own virtual file system
//! with Scribyra's write guard (TeX never sees a real file). Packages a document is missing
//! are asked for on a pipe and put into the cache by the worker (see [`crate::cache`]).

use crate::bwrap::{inner_limits, lossy, Bubblewrap, Spec};
use crate::cache::Packages;
use crate::{Cancel, Job, Limit, Limits, Outcome, Status};
use sha2::{Digest, Sha256};
use std::ffi::OsString;
use std::io;
use std::os::fd::RawFd;
use std::path::{Path, PathBuf};
use std::sync::Arc;

/// Sets the in-namespace rlimits, then becomes Node (`exec`): no shell stays in the job.
const WRAP: &str = r#"ulimit -u "$1" -n "$2" -f "$3" -c 0 || exit 99; shift 3; exec "$@""#;

pub(crate) struct Wasm { node: PathBuf, runtime: PathBuf, cache: PathBuf, packages: Arc<dyn Packages>, id: String, engine_mib: u64 }

/// The engine's identity (part of the PDF cache key): a digest of the runtime's `runtime.json`,
/// which pins the engine, its glue, the compile driver and the package catalog.
fn runtime_id(info: &[u8]) -> String { format!("wasm-{}", &format!("{:x}", Sha256::digest(info))[..16]) }

/// [`runtime_id`] of the compile runtime at `runtime`.
pub fn wasm_runtime_id(runtime: &Path) -> io::Result<String> { Ok(runtime_id(&std::fs::read(runtime.join("runtime.json"))?)) }

/// The WebAssembly heap ceiling of the runtime's BusyTeX build (Emscripten's `getHeapMax`).
fn engine_heap_mib(runtime: &Path) -> io::Result<u64> {
  let js = std::fs::read_to_string(runtime.join("public/core/busytex/busytex.js"))?;
  let at = js.find("var getHeapMax = () =>").ok_or_else(|| io::Error::other("busytex.js has no heap limit"))?;
  let rest = &js[at..];
  let digits: String = rest.chars().skip_while(|c| !c.is_ascii_digit()).take_while(|c| c.is_ascii_digit()).collect();
  digits.parse::<u64>().map(|b| b >> 20).map_err(|_| io::Error::other("busytex.js heap limit is not a number"))
}

impl Wasm {
  pub(crate) fn new(node: PathBuf, runtime: PathBuf, cache: PathBuf, packages: Arc<dyn Packages>) -> io::Result<Wasm> {
    let info = std::fs::read(runtime.join("runtime.json")).map_err(|e| io::Error::new(e.kind(), format!("{} is not a compile runtime (runtime.json: {e})", runtime.display())))?;
    for f in ["server/compile/runner.mjs", "web/compile-driver.js", "web/pkg/scribyra_app_bg.wasm", "public/core/busytex/busytex.wasm"] {
      if !runtime.join(f).is_file() { return Err(io::Error::other(format!("the compile runtime has no {f}"))); }
    }
    if !cache.is_dir() { return Err(io::Error::other(format!("no package cache directory at {}", cache.display()))); }
    let id = runtime_id(&info);
    let engine_mib = engine_heap_mib(&runtime)?;
    Ok(Wasm { node, runtime: runtime.canonicalize()?, cache: cache.canonicalize()?, packages, id, engine_mib })
  }
  pub(crate) fn id(&self) -> &str { &self.id }
  pub(crate) fn runtime(&self) -> &Path { &self.runtime }
  pub(crate) fn cache(&self) -> &Path { &self.cache }

  /// Node's own JavaScript heap: a quarter of the job's memory, 192–1024 MiB. The engine's
  /// WebAssembly heap (at most `engine_mib`) and Node itself come on top; all of it counts
  /// against the job's cgroup.
  fn heap_mib(limits: &Limits) -> u64 { (limits.memory_mib / 4).clamp(192, 1024) }

  pub(crate) fn run(&self, b: &Bubblewrap, job: &Job, limits: &Limits, cancel: &Cancel) -> Outcome {
    if let Err(e) = job.validate(limits) { return Outcome::fail(Status::Rejected(e.clone()), e.to_string()); }
    let log_bytes = (limits.log_kib << 10).saturating_sub(16 << 10).max(4096);
    let inner = |fds: &[RawFd]| -> Vec<OsString> {
      let l = inner_limits(limits);
      let mut v: Vec<OsString> = [b.bash().as_os_str(), "-c".as_ref(), WRAP.as_ref(), "wasm".as_ref(), l[0].as_ref(), l[1].as_ref(), l[2].as_ref()].iter().map(|s| s.to_os_string()).collect();
      v.push(self.node.clone().into());
      for a in ["--permission", "--allow-fs-read=/runtime/", "--allow-fs-read=/cache/", "--allow-fs-read=/work/", "--disable-proto=delete"] { v.push(a.into()); }
      v.push(format!("--max-old-space-size={}", Self::heap_mib(limits)).into());
      v.push("--v8-pool-size=2".into());
      v.push("/runtime/server/compile/runner.mjs".into());
      for (k, val) in [("--runtime", "/runtime".to_string()), ("--cache", "/cache".into()), ("--work", "/work".into()), ("--main", job.main.clone()),
        ("--status", fds[0].to_string()), ("--pdf", fds[1].to_string()), ("--log", fds[2].to_string()), ("--fill", fds[3].to_string()), ("--reply", fds[4].to_string()),
        ("--budget-ms", (limits.wall_seconds * 1000 + 60_000).to_string()), ("--engine-memory-mib", self.engine_mib.to_string()), ("--log-bytes", log_bytes.to_string())] {
        v.push(k.into()); v.push(val.into());
      }
      v
    };
    let mounts = [(self.runtime.clone(), "/runtime"), (self.cache.clone(), "/cache")];
    let spec = Spec { files: &job.files, extra_ro: &[], mounts: &mounts, openin: "p", epoch: job.source_date_epoch, pipes: 3, fill: Some(self.packages.clone()), address_space: false, stdout_cap: 64 << 10 };
    let ran = match b.sandbox(spec, limits, cancel, inner) {
      Ok(r) => r,
      Err(e) => return Outcome::fail(Status::SandboxFailure, format!("could not start the sandbox: {e}")),
    };
    let report = lossy(&ran.pipes[0].0);
    let result: Option<serde_json::Value> = report.lines().rev().find_map(|l| serde_json::from_str::<serde_json::Value>(l).ok().filter(|v| v["event"] == "result"));
    let kind = result.as_ref().and_then(|r| r["status"].as_str()).unwrap_or("").to_string();
    let passes = result.as_ref().and_then(|r| r["passes"].as_u64()).unwrap_or(0) as u32;
    let (log_raw, log_seen) = &ran.pipes[2];
    let mut log = if *log_seen > log_raw.len() as u64 { format!("[log truncated to its last {} bytes of {log_seen}]\n{}", log_raw.len(), lossy(log_raw)) } else { lossy(log_raw) };
    let (pdf, pdf_seen) = &ran.pipes[1];
    let usage = ran.usage.unwrap_or_default();
    let status = match (&ran.killed, kind.as_str()) {
      (Some(k), _) => {
        let why = match k { Status::Cancelled => "cancelled".into(), Status::LimitExceeded(Limit::Cpu) => format!("CPU budget of {} s", limits.cpu_seconds), _ => format!("wall-clock limit of {} s", limits.wall_seconds) };
        log.push_str(&format!("\n[stopped: {why}]\n"));
        k.clone()
      }
      // RLIMIT_CPU (SIGXCPU, or SIGKILL at the hard limit) can end Node before the cgroup's
      // CPU check does: without a result, a job that used its budget hit the CPU limit.
      _ if result.is_none() && (matches!(ran.code, Some(152) | Some(137)) || ran.cpu_ms >= limits.cpu_seconds * 1000) && usage.oom_kills == 0 => {
        log.push_str(&format!("\n[stopped: CPU budget of {} s]\n", limits.cpu_seconds));
        Status::LimitExceeded(Limit::Cpu)
      }
      // Node itself out of memory (RLIMIT_DATA, or its heap flag): V8 aborts, saying so on the
      // process's stderr, which job code cannot write to (the engine's output goes to the runner).
      _ if result.is_none() && ran.code == Some(134) && lossy(&ran.stderr.0).contains("out of memory") => {
        log.push_str(&format!("\n[stopped: memory limit of {} MiB]\n", limits.memory_mib));
        Status::LimitExceeded(Limit::Memory)
      }
      _ if usage.oom_kills > 0 => { log.push_str(&format!("\n[stopped: memory limit of {} MiB]\n", limits.memory_mib)); Status::LimitExceeded(Limit::Memory) }
      (_, "success") if *pdf_seen > limits.output_mib << 20 => Status::LimitExceeded(Limit::Output),
      (_, "success") if pdf.starts_with(b"%PDF-") => Status::Success,
      (_, "memory") => Status::LimitExceeded(Limit::Memory),
      (_, "timeout") => Status::LimitExceeded(Limit::Wall),
      (_, "tex_error" | "package_error" | "failure") => Status::TexError,
      _ if usage.pids_max_hits > 0 => Status::LimitExceeded(Limit::Processes),
      _ => {
        log.push_str(&format!("\n[sandbox failure: exit {:?}, report {:?}]\n{}", ran.code, report.chars().take(4096).collect::<String>(), lossy(&ran.stderr.0)));
        Status::SandboxFailure
      }
    };
    let pdf = (status == Status::Success).then(|| ran.pipes.into_iter().nth(1).unwrap().0);
    Outcome { status, pdf, log, cpu_ms: ran.cpu_ms, passes: passes.min(64), peak_memory: usage.peak_bytes }
  }
}
