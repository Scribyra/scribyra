//! The compile-engine benchmark (docs/compile-engines.md): the same documents through the same
//! sandbox (bubblewrap, seccomp, a cgroup per job with one CPU) with the WebAssembly engine
//! (cold and warm package cache) and with native TeX Live, one job at a time.
//!
//!   nix develop -c cargo run --release -p scribyra-compile --example bench -- \
//!     <docs-dir> <out-dir> [runs] [thesis-runs] [engines] [docs]
//!
//! Needs SCRIBYRA_WASM_RUNTIME (`scripts/wasm-compile-runtime.mjs`), SCRIBYRA_BENCH_TEXLIVE (a
//! TeX Live tree with biber, for example texliveMedium) and SCRIBYRA_BENCH_MIRROR (default the
//! browser's mirror) for packages neither bundled nor cached. Prints one JSON line per run and
//! writes each engine's first PDF to `<out-dir>/<engine>/<doc>.pdf`.

use scribyra_compile::*;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Instant;

fn files(dir: &Path) -> Vec<(String, Vec<u8>)> {
  fn walk(base: &Path, dir: &Path, out: &mut Vec<(String, Vec<u8>)>) {
    let mut entries: Vec<_> = std::fs::read_dir(dir).unwrap().flatten().collect();
    entries.sort_by_key(|e| e.file_name());
    for e in entries {
      let p = e.path();
      if p.is_dir() { walk(base, &p, out) } else { out.push((p.strip_prefix(base).unwrap().to_string_lossy().into_owned(), std::fs::read(&p).unwrap())) }
    }
  }
  let mut out = vec![];
  walk(dir, dir, &mut out);
  out
}

fn job(dir: &Path) -> Job {
  let files = files(dir);
  let main = String::from_utf8_lossy(&files.iter().find(|(p, _)| p == "main.tex").expect("main.tex").1).into_owned();
  let bibliography = if main.contains("{biblatex}") { Bibliography::Biber } else if main.contains("\\bibliography{") { Bibliography::Bibtex } else { Bibliography::None };
  Job { files, main: "main.tex".into(), engine: Engine::Lualatex, bibliography, source_date_epoch: 1_700_000_000, packages: vec![] }
}

fn limits() -> Limits {
  Limits { cpu_seconds: 1800, wall_seconds: 1800, memory_mib: 4096, scratch_mib: 1024, output_mib: 256, passes: 8, processes: 64, open_files: 256, files: 2000, input_mib: 128, log_kib: 2048 }
}

fn wasm(cache: &Path) -> Arc<Bubblewrap> {
  let runtime = PathBuf::from(std::env::var("SCRIBYRA_WASM_RUNTIME").expect("SCRIBYRA_WASM_RUNTIME"));
  let mirror = std::env::var("SCRIBYRA_BENCH_MIRROR").unwrap_or_else(|_| "https://tlnet.yihui.org".into());
  std::fs::create_dir_all(cache).unwrap();
  let packages = Arc::new(PackageCache::open(cache, &runtime, (!mirror.is_empty()).then_some(mirror)).unwrap());
  Arc::new(Bubblewrap::wasm_from_env(runtime, cache, packages).unwrap())
}

fn native() -> Arc<Bubblewrap> {
  let texlive = std::env::var("SCRIBYRA_BENCH_TEXLIVE").expect("SCRIBYRA_BENCH_TEXLIVE");
  let bwrap = std::env::var("SCRIBYRA_BWRAP").expect("SCRIBYRA_BWRAP");
  Arc::new(Bubblewrap::new(bwrap, texlive).unwrap().confine(Confinement::from_env()).unwrap())
}

fn run(r: &Bubblewrap, j: &Job, engine: &str, doc: &str, cache: &str, n: usize, out: &Path) -> Outcome {
  let t = Instant::now();
  let o = r.run(j, &limits(), &Cancel::new());
  let wall = t.elapsed().as_millis();
  let status = format!("{:?}", o.status);
  if let Some(pdf) = &o.pdf {
    let f = out.join(engine).join(format!("{doc}.pdf"));
    std::fs::create_dir_all(f.parent().unwrap()).unwrap();
    if !f.exists() { std::fs::write(&f, pdf).unwrap(); }
  } else {
    let f = out.join(engine).join(format!("{doc}-{cache}-{n}.log"));
    std::fs::create_dir_all(f.parent().unwrap()).unwrap();
    std::fs::write(&f, &o.log).unwrap();
  }
  println!("{}", serde_json::json!({"engine": engine, "doc": doc, "cache": cache, "run": n, "status": status, "wall_ms": wall, "cpu_ms": o.cpu_ms, "peak_mib": o.peak_memory >> 20, "passes": o.passes, "pdf_bytes": o.pdf.as_ref().map_or(0, |p| p.len()), "engine_mib": o.engine_memory >> 20, "known": j.packages.len(), "packages": o.packages.len()}));
  o
}

fn main() {
  let a: Vec<String> = std::env::args().skip(1).collect();
  let (docs, out) = (PathBuf::from(&a[0]), PathBuf::from(&a[1]));
  let runs: usize = a.get(2).map_or(5, |s| s.parse().unwrap());
  let thesis_runs: usize = a.get(3).map_or(3, |s| s.parse().unwrap());
  let engines: Vec<String> = a.get(4).map_or("wasm,native".into(), |s| s.clone()).split(',').map(str::to_owned).collect();
  let names: Vec<String> = a.get(5).map_or("sample,article,beamer,tikz,thesis".into(), |s| s.clone()).split(',').map(str::to_owned).collect();
  let caches = out.join("caches");
  for doc in &names {
    let j = job(&docs.join(doc));
    let n = if doc == "thesis" { thesis_runs } else { runs };
    for engine in &engines {
      if engine == "wasm" {
        // Cold: an empty package cache for every run (bundled archives and the mirror refill it).
        let mut remembered = vec![];
        for i in 0..n {
          let dir = caches.join(format!("cold-{doc}-{i}"));
          let _ = std::fs::remove_dir_all(&dir);
          let o = run(&wasm(&dir), &j, "wasm", doc, "cold", i, &out);
          if o.status == Status::Success { remembered = o.packages; }
          let _ = std::fs::remove_dir_all(&dir);
        }
        // Warm: one cache that a first, untimed run filled.
        let dir = caches.join(format!("warm-{doc}"));
        let _ = std::fs::remove_dir_all(&dir);
        let r = wasm(&dir);
        let _ = r.run(&j, &limits(), &Cancel::new());
        for i in 0..n { run(&r, &j, "wasm", doc, "warm", i, &out); }
        // The project's remembered packages (as the service passes them), with an empty cache
        // (fetched together before the sandbox starts) and with the warm one. A runner that
        // does not report packages (before the service passed them) has none to pass.
        if !remembered.is_empty() {
          let known = Job { packages: remembered, ..j.clone() };
          for i in 0..n {
            let dir = caches.join(format!("cold-project-{doc}-{i}"));
            let _ = std::fs::remove_dir_all(&dir);
            run(&wasm(&dir), &known, "wasm", doc, "cold+project", i, &out);
            let _ = std::fs::remove_dir_all(&dir);
          }
          for i in 0..n { run(&r, &known, "wasm", doc, "warm+project", i, &out); }
        }
      } else {
        let r = native();
        for i in 0..n { run(&r, &j, "native", doc, "installed", i, &out); }
      }
    }
  }
}
