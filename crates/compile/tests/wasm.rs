//! The WebAssembly engine end to end: real bubblewrap, the real Node from the development shell
//! and the real compile runtime (the browser's BusyTeX engine and compile driver), assembled by
//! `scripts/wasm-compile-runtime.mjs` (or `SCRIBYRA_WASM_RUNTIME`). Packages not bundled come
//! from a local fixture mirror, never the internet. Run with
//! `nix develop -c cargo test -p scribyra-compile --test wasm`.

use scribyra_compile::*;
use std::io::{BufRead, BufReader, Write};
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

fn root() -> PathBuf { Path::new(env!("CARGO_MANIFEST_DIR")).join("../..").canonicalize().unwrap() }

/// The compile runtime, assembled once per test binary unless the environment names one.
fn runtime() -> PathBuf {
  static R: OnceLock<PathBuf> = OnceLock::new();
  R.get_or_init(|| {
    if let Some(r) = std::env::var_os("SCRIBYRA_WASM_RUNTIME") { return PathBuf::from(r); }
    let out = root().join("target/wasm-compile-runtime-test");
    let s = std::process::Command::new("node").arg("scripts/wasm-compile-runtime.mjs").arg(&out).arg("--link").current_dir(root()).status().expect("node from the dev shell");
    assert!(s.success(), "assembling the compile runtime failed (needs `npm run wasm` and the compiler assets)");
    out
  }).clone()
}

/// A TeX Live mirror on loopback serving the repository's fixture archives; counts requests.
/// Each test that counts gets its own.
struct Mirror { url: String, hits: Arc<AtomicUsize> }

fn mirror() -> Mirror { mirror_serving(&[]) }

/// `swaps`: (asked name, fixture served instead), for a mirror that serves the wrong archive.
fn mirror_serving(swaps: &[(&str, &str)]) -> Mirror {
  let swaps: Vec<(String, String)> = swaps.iter().map(|(a, b)| (a.to_string(), b.to_string())).collect();
  {
    let listener = (18540..18600).find_map(|p| TcpListener::bind(("127.0.0.1", p)).ok()).expect("a free port in 18540-18599");
    let url = format!("http://127.0.0.1:{}", listener.local_addr().unwrap().port());
    let hits = Arc::new(AtomicUsize::new(0));
    let (h, dir) = (hits.clone(), root().join("tests/fixtures/tex-packages"));
    std::thread::spawn(move || for stream in listener.incoming().flatten() {
      let mut line = String::new();
      if BufReader::new(&stream).read_line(&mut line).is_err() { continue; }
      let path = line.split_whitespace().nth(1).unwrap_or("").to_string();
      let name = path.strip_prefix("/archive/").filter(|n| n.ends_with(".tar.xz") && !n.contains('/') && !n.starts_with('.'));
      let name = name.map(|n| swaps.iter().find(|(a, _)| format!("{a}.tar.xz") == n).map_or(n.to_string(), |(_, b)| format!("{b}.tar.xz")));
      let mut s = stream;
      match name.and_then(|n| std::fs::read(dir.join(&n)).ok()) {
        Some(b) => { h.fetch_add(1, Ordering::SeqCst); let _ = write!(s, "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", b.len()); let _ = s.write_all(&b); }
        None => { let _ = write!(s, "HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"); }
      }
    });
    Mirror { url, hits }
  }
}

fn marker(tag: &str) -> String { format!("scribyra-wasm-{tag}-{}-{}", std::process::id(), SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos()) }

fn temp_dir(tag: &str) -> PathBuf {
  let d = root().join("target/wasm-test-caches").join(marker(tag));
  std::fs::create_dir_all(&d).unwrap();
  d
}

fn runner_with(cache: &Path, mirror_url: Option<String>) -> (Arc<Bubblewrap>, Arc<PackageCache>) {
  let packages = Arc::new(PackageCache::open(cache, &runtime(), mirror_url).unwrap());
  let b = Bubblewrap::wasm_from_env(runtime(), cache, packages.clone()).expect("SCRIBYRA_BWRAP/SCRIBYRA_NODE/SCRIBYRA_WASM_CLOSURE: run under `nix develop`");
  (Arc::new(b), packages)
}

/// One shared runner with its own cache and the fixture mirror.
fn runner() -> Arc<Bubblewrap> {
  static R: OnceLock<Arc<Bubblewrap>> = OnceLock::new();
  R.get_or_init(|| runner_with(&temp_dir("shared"), Some(mirror().url)).0).clone()
}

fn limits() -> Limits {
  Limits { cpu_seconds: 60, wall_seconds: 120, memory_mib: 2048, scratch_mib: 64, output_mib: 16, passes: 5, processes: 64, open_files: 256, files: 100, input_mib: 8, log_kib: 512 }
}

fn job(files: &[(&str, &str)]) -> Job {
  Job { files: files.iter().map(|(p, s)| (p.to_string(), s.as_bytes().to_vec())).collect(), main: files[0].0.into(), engine: Engine::Lualatex, bibliography: Bibliography::None, source_date_epoch: 1_700_000_000 }
}

fn leftovers(m: &str) -> Vec<String> {
  let mut v = vec![];
  for e in std::fs::read_dir("/proc").unwrap().flatten() {
    if !e.file_name().to_string_lossy().bytes().all(|b| b.is_ascii_digit()) || e.file_name().to_string_lossy() == std::process::id().to_string() { continue; }
    if let Ok(c) = std::fs::read(e.path().join("cmdline")) { let c = String::from_utf8_lossy(&c).replace('\0', " "); if c.contains(m) { v.push(c) } }
  }
  v
}

fn assert_pdf(o: &Outcome) {
  assert_eq!(o.status, Status::Success, "log:\n{}", &o.log[o.log.len().saturating_sub(6000)..]);
  assert!(o.pdf.as_ref().unwrap().starts_with(b"%PDF-"));
}


#[test]
fn compiles_a_project_with_the_browser_engine() {
  let main = "\\documentclass{article}\n\\usepackage{amsmath}\n\\begin{document}\n\\section{One}\\label{s:one}See~\\ref{s:two}: $e^{i\\pi}+1=0$.\n\\input{ch/two}\n\\end{document}\n";
  let o = runner().run(&job(&[("paper.tex", main), ("ch/two.tex", "\\section{Two}\\label{s:two}Back to~\\ref{s:one}.\n")]), &limits(), &Cancel::new());
  assert_pdf(&o);
  assert!(o.passes >= 2, "cross-references need a rerun: {} passes", o.passes);
  assert!(o.log.contains("luahblatex") && o.log.contains("paper.tex"), "{}", o.log);
}

#[test]
fn errors_are_diagnosed_with_their_file_and_line() {
  let o = runner().run(&job(&[("main.tex", "\\documentclass{article}\n\\begin{document}\nIntro.\n\\input{chapters/bad}\n\\end{document}\n"), ("chapters/bad.tex", "First line.\n\\undefinedmacro\n")]), &limits(), &Cancel::new());
  assert_eq!(o.status, Status::TexError, "{}", o.log);
  assert!(o.pdf.is_none());
  assert!(o.log.starts_with("Diagnostics:\nchapters/bad.tex:2: Undefined control sequence."), "{}", &o.log[..o.log.len().min(2000)]);
}

#[test]
fn a_missing_package_comes_through_the_cache_once() {
  let cache = temp_dir("fetch");
  let mirror = mirror();
  let (b, packages) = runner_with(&cache, Some(mirror.url.clone()));
  let doc = "\\documentclass{article}\n\\usepackage[romanian]{babel}\n\\begin{document}\n\\today\n\\end{document}\n";
  let before = mirror.hits.load(Ordering::SeqCst);
  let o = b.run(&job(&[("main.tex", doc)]), &limits(), &Cancel::new());
  assert_pdf(&o);
  assert!(o.log.contains("TeX packages installed for this compile:\nbabel-romanian"), "{}", &o.log[..o.log.len().min(3000)]);
  let p = packages.package("babel-romanian").unwrap();
  assert!(cache.join(format!("{}.tar.xz", p.sha512)).is_file());
  assert_eq!(mirror.hits.load(Ordering::SeqCst), before + 1);
  // Warm: the second compile reads the cache and asks the mirror for nothing.
  let o = b.run(&job(&[("main.tex", doc)]), &limits(), &Cancel::new());
  assert_pdf(&o);
  assert_eq!(mirror.hits.load(Ordering::SeqCst), before + 1);
  // The job read the entry itself (read-only); the worker was not asked again.
  assert_eq!(packages.stats.mirror.load(Ordering::Relaxed), 1);
}

#[test]
fn a_tampered_cache_entry_is_never_used() {
  let cache = temp_dir("tamper");
  let doc = "\\documentclass{article}\n\\usepackage[romanian]{babel}\n\\begin{document}\nX\n\\end{document}\n";
  // Without a mirror the damaged entry cannot be replaced: the job fails, naming the package.
  let (b, packages) = runner_with(&cache, None);
  let p = packages.package("babel-romanian").unwrap();
  let entry = cache.join(format!("{}.tar.xz", p.sha512));
  let mut bytes = std::fs::read(root().join("tests/fixtures/tex-packages/babel-romanian.tar.xz")).unwrap();
  bytes[300] ^= 1;
  std::fs::write(&entry, &bytes).unwrap();
  let o = b.run(&job(&[("main.tex", doc)]), &limits(), &Cancel::new());
  assert_eq!(o.status, Status::TexError, "{}", o.log);
  assert!(o.log.contains("babel-romanian"), "{}", o.log);
  assert!(packages.stats.rejected.load(Ordering::Relaxed) >= 1);
  assert!(!entry.exists(), "the tampered entry is removed");
  // With the mirror, the entry is fetched again, checked, and the compile succeeds.
  std::fs::write(&entry, &bytes).unwrap();
  let (b, packages) = runner_with(&cache, Some(mirror().url));
  assert_pdf(&b.run(&job(&[("main.tex", doc)]), &limits(), &Cancel::new()));
  assert_eq!(std::fs::read(&entry).unwrap().len(), p.size);
  assert!(packages.stats.rejected.load(Ordering::Relaxed) >= 1);
  // A mirror serving another archive under the name is refused, and nothing is cached.
  let cache = temp_dir("wrong");
  let packages = PackageCache::open(&cache, &runtime(), Some(mirror_serving(&[("babel-romanian", "algorithmicx")]).url)).unwrap();
  let e = packages.fill("babel-romanian").unwrap_err();
  assert!(e.contains("does not match the catalog's SHA-512"), "{e}");
  assert_eq!(std::fs::read_dir(&cache).unwrap().count(), 0);
  assert!(packages.fill("no-such-package-anywhere").unwrap_err().contains("not in the TeX package catalog"));
  assert!(packages.fill("../../etc/passwd").is_err());
}

#[test]
fn biber_runs_inside_the_engine() {
  let main = "\\documentclass{article}\n\\usepackage[backend=biber]{biblatex}\n\\addbibresource{refs.bib}\n\\begin{document}\nAs \\textcite{knuth84} shows.\n\\printbibliography\n\\end{document}\n";
  let bib = "@book{knuth84, author = {Donald E. Knuth}, title = {The {\\TeX}book}, publisher = {Addison-Wesley}, year = {1984}}\n";
  let o = runner().run(&job(&[("main.tex", main), ("refs.bib", bib)]), &limits(), &Cancel::new());
  assert_pdf(&o);
  assert!(o.log.contains("biber"), "{}", &o.log[..o.log.len().min(4000)]);
  assert!(o.passes >= 2, "{}", o.passes);
}

const LOOP: &str = "\\documentclass{article}\\begin{document}\\def\\x{\\x}\\x\\end{document}\n";

#[test]
fn cancellation_stops_the_job_and_leaves_nothing() {
  let m = marker("cancel");
  let running = spawn(runner(), job(&[(&format!("{m}.tex"), LOOP)]), limits());
  std::thread::sleep(Duration::from_secs(3));
  let t = Instant::now();
  running.cancel();
  let o = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap().block_on(running);
  assert_eq!(o.status, Status::Cancelled, "{}", o.log);
  assert!(t.elapsed() < Duration::from_secs(5), "{:?}", t.elapsed());
  assert!(leftovers(&m).is_empty(), "{:?}", leftovers(&m));
}

#[test]
fn time_limits_end_runaway_documents() {
  let m = marker("cpu");
  let t = Instant::now();
  let o = runner().run(&job(&[(&format!("{m}.tex"), LOOP)]), &Limits { cpu_seconds: 4, ..limits() }, &Cancel::new());
  assert_eq!(o.status, Status::LimitExceeded(Limit::Cpu), "{}", o.log);
  assert!(t.elapsed() < Duration::from_secs(30), "{:?}", t.elapsed());
  let o = runner().run(&job(&[(&format!("{m}.tex"), LOOP)]), &Limits { wall_seconds: 4, ..limits() }, &Cancel::new());
  assert_eq!(o.status, Status::LimitExceeded(Limit::Wall), "{}", o.log);
  assert!(leftovers(&m).is_empty(), "{:?}", leftovers(&m));
}

const BOMB: &str = "\\documentclass{article}\\begin{document}\\directlua{local t = {} for i = 1, 100000 do t[i] = string.rep('x', 10000000) .. i end}\\end{document}\n";

#[test]
fn memory_limits_name_the_engine_ceiling_or_the_job_limit() {
  // The engine's own WebAssembly heap ceiling is below the job's limit: a clear message.
  let o = runner().run(&job(&[("main.tex", BOMB)]), &Limits { memory_mib: 3072, ..limits() }, &Cancel::new());
  assert_eq!(o.status, Status::LimitExceeded(Limit::Memory), "{}", o.log);
  assert!(o.log.contains("needs more memory than the WebAssembly TeX engine can use") && o.log.contains("4 GB"), "{}", &o.log[..o.log.len().min(2000)]);
  // A document cannot pass a TeX error off as the engine's memory limit.
  let spoof = "\\documentclass{article}\\begin{document}\\typeout{/bin/busytex stderr: Cannot enlarge memory, Aborted(OOM)}\\undefinedmacro\\end{document}\n";
  let o = runner().run(&job(&[("main.tex", spoof)]), &limits(), &Cancel::new());
  assert_eq!(o.status, Status::TexError, "{}", o.log);
  assert!(!o.log.contains("needs more memory"), "{}", o.log);
  // A job limit below what the engine reaches: the cgroup ends it.
  let o = runner().run(&job(&[("main.tex", BOMB)]), &Limits { memory_mib: 640, ..limits() }, &Cancel::new());
  assert_eq!(o.status, Status::LimitExceeded(Limit::Memory), "{}", o.log);
}

#[test]
fn tex_cannot_reach_host_files_the_runtime_or_the_network() {
  let doc = "\\documentclass{article}\\begin{document}\n\\IfFileExists{/etc/passwd}{HOST-PASSWD}{no-passwd}\n\\IfFileExists{/runtime/runtime.json}{HOST-RUNTIME}{no-runtime}\n\\directlua{local ok = pcall(function() return io.open('/cache/x', 'w') end) tex.print(socket and 'SOCKET' or 'no-socket')}\n\\end{document}\n";
  let o = runner().run(&job(&[("main.tex", doc)]), &limits(), &Cancel::new());
  assert_pdf(&o);
  assert!(!o.log.contains("HOST-PASSWD") && !o.log.contains("HOST-RUNTIME"), "{}", o.log);
}

/// Node in the job's sandbox, under the same flags the engine gets: no network (an empty
/// network namespace, and nothing listening there), and the permission model refusing reads
/// outside its trees and every write.
#[test]
fn node_in_the_sandbox_has_no_network_and_only_its_reads() {
  let listener = (18600..18640).find_map(|p| TcpListener::bind(("127.0.0.1", p)).ok()).unwrap();
  listener.set_nonblocking(true).unwrap();
  let port = listener.local_addr().unwrap().port();
  let node = std::env::var("SCRIBYRA_NODE").unwrap();
  let probe = format!(r#"
const net=require('node:net'),fs=require('node:fs');
const tryConnect=(host)=>new Promise(r=>{{const s=net.connect({{host,port:{port},timeout:2000}});s.on('connect',()=>{{r('CONNECTED');s.destroy();}});s.on('error',e=>r(e.code));s.on('timeout',()=>{{r('TIMEOUT');s.destroy();}});}});
const read=p=>{{try{{fs.readFileSync(p);return 'READ';}}catch(e){{return e.code;}}}};
const write=p=>{{try{{fs.writeFileSync(p,'x');return 'WROTE';}}catch(e){{return e.code;}}}};
(async()=>{{
 console.log('loopback='+await tryConnect('127.0.0.1'));
 console.log('internet='+await tryConnect('1.1.1.1'));
 console.log('fetch='+await fetch('http://example.com').then(()=>'FETCHED',e=>e.cause?.code||e.message));
 console.log('read.runtime='+read('/runtime/runtime.json'));
 console.log('read.etc='+read('/etc/passwd'));
 console.log('read.store='+read(process.execPath));
 console.log('write.work='+write('/work/x'));
 console.log('child='+(()=>{{try{{require('node:child_process').execSync('true');return 'SPAWNED';}}catch(e){{return e.code;}}}})());
}})();
"#);
  let script = format!("{node} --permission --allow-fs-read=/runtime/ --allow-fs-read=/cache/ --allow-fs-read=/work/ probe.js");
  let o = runner().run_raw(&script, &[], &[("probe.js".into(), probe.into_bytes())], &limits(), &Cancel::new()).unwrap();
  let out = o.stdout.clone();
  // seccomp refuses AF_INET/AF_INET6 sockets outright; the empty network namespace would
  // refuse them anyway.
  assert!(out.contains("loopback=EPERM") && out.contains("internet=EPERM") && out.contains("fetch=EAI_AGAIN"), "{o:?}");
  assert!(!out.contains("FETCHED") && !out.contains("CONNECTED"), "{o:?}");
  assert!(out.contains("read.runtime=READ") && out.contains("read.etc=ERR_ACCESS_DENIED") && out.contains("read.store=ERR_ACCESS_DENIED"), "{o:?}");
  assert!(out.contains("write.work=ERR_ACCESS_DENIED") && out.contains("child=ERR_ACCESS_DENIED"), "{o:?}");
  assert!(listener.accept().is_err(), "nothing reached the host's loopback");
}
