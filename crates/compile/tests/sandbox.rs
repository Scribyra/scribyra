//! Real TeX Live and real bubblewrap (from the development shell: `nix develop -c cargo test -p
//! scribyra-compile`). Every adversarial job must fail safely within its limits and leave no
//! process or file behind.

use scribyra_compile::*;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

fn runner() -> Arc<Bubblewrap> {
  static R: OnceLock<Arc<Bubblewrap>> = OnceLock::new();
  R.get_or_init(|| Arc::new(Bubblewrap::from_env().expect("SCRIBYRA_BWRAP/SCRIBYRA_TEXLIVE: run under `nix develop`"))).clone()
}

fn limits() -> Limits {
  Limits { cpu_seconds: 20, wall_seconds: 60, memory_mib: 1536, scratch_mib: 64, output_mib: 16, passes: 5, processes: 32, open_files: 128, files: 100, input_mib: 8, log_kib: 256 }
}

fn marker(tag: &str) -> String {
  format!("scribyra-mark-{tag}-{}-{}", std::process::id(), SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos())
}

fn job(engine: Engine, files: &[(&str, &str)]) -> Job {
  Job { files: files.iter().map(|(p, s)| (p.to_string(), s.as_bytes().to_vec())).collect(), main: files[0].0.into(), engine, bibliography: Bibliography::Bibtex, source_date_epoch: 1_700_000_000 }
}

fn run(j: &Job, l: &Limits) -> Outcome { runner().run(j, l, &Cancel::new()) }

/// Processes on this host whose command line mentions `m` (none may outlive a job).
fn leftovers(m: &str) -> Vec<String> {
  let mut v = vec![];
  for e in std::fs::read_dir("/proc").unwrap().flatten() {
    if !e.file_name().to_string_lossy().bytes().all(|b| b.is_ascii_digit()) || e.file_name().to_string_lossy() == std::process::id().to_string() { continue; }
    if let Ok(c) = std::fs::read(e.path().join("cmdline")) { let c = String::from_utf8_lossy(&c).replace('\0', " "); if c.contains(m) { v.push(c) } }
  }
  v
}

/// Nothing named `m` exists where a job could have left it on the host.
fn assert_no_trace(m: &str) {
  assert!(leftovers(m).is_empty(), "processes left: {:?}", leftovers(m));
  for d in [std::env::temp_dir(), PathBuf::from("/tmp"), PathBuf::from("/dev/shm"), std::env::current_dir().unwrap(), std::env::var_os("HOME").map(PathBuf::from).unwrap()] {
    if let Ok(rd) = std::fs::read_dir(&d) { for e in rd.flatten() { assert!(!e.file_name().to_string_lossy().contains(m), "{} left in {}", e.file_name().to_string_lossy(), d.display()); } }
  }
}

fn assert_pdf(o: &Outcome) {
  assert_eq!(o.status, Status::Success, "log:\n{}", o.log);
  assert!(o.pdf.as_ref().unwrap().starts_with(b"%PDF-"));
  assert!(o.cpu_ms > 0);
}

const HELLO: &str = "\\documentclass{article}\\begin{document}Hello, sandbox.\\end{document}\n";

#[test]
fn pdflatex_compiles_hello_world() {
  let o = run(&job(Engine::Pdflatex, &[("main.tex", HELLO)]), &limits());
  assert_pdf(&o);
  assert!(o.log.contains("Output written on main.pdf (1 page"), "{}", o.log);
  assert_eq!(o.passes, 1);
}

#[test]
fn xelatex_and_lualatex_compile() {
  for (e, out) in [(Engine::Xelatex, "Output written on main.xdv (1 page"), (Engine::Lualatex, "Output written on main.pdf (1 page")] {
    let o = run(&job(e, &[("main.tex", "\\documentclass{article}\\usepackage{fontspec}\\begin{document}Hello, sandbox: äöü.\\end{document}\n")]), &limits());
    assert_pdf(&o);
    assert!(o.log.contains(out), "{e:?}: {}", o.log);
  }
}

#[test]
fn bibliography_and_cross_references_rerun_until_resolved() {
  let main = "\\documentclass{article}\\begin{document}\\section{One}\\label{s:one}See section~\\ref{s:two} and \\cite{knuth84}.\\input{ch/two}\\bibliographystyle{plain}\\bibliography{refs}\\end{document}\n";
  let two = "\\section{Two}\\label{s:two}Back to section~\\ref{s:one}.\n";
  let bib = "@book{knuth84, author = {Donald E. Knuth}, title = {The {\\TeX}book}, publisher = {Addison-Wesley}, year = {1984}}\n";
  let o = run(&job(Engine::Pdflatex, &[("paper.tex", main), ("ch/two.tex", two), ("refs.bib", bib)]), &limits());
  assert_pdf(&o);
  assert!(o.passes >= 3, "passes {}", o.passes);
  assert!(o.log.contains("--- paper.blg ---") && o.log.contains("Database file #1: refs.bib"), "{}", o.log);
  let tex_log = o.log.split("--- paper.blg ---").next().unwrap();
  assert!(!tex_log.contains("undefined") && !tex_log.contains("Rerun"), "{tex_log}");
  // Without a bibliography tool nothing resolves the citation, and the passes stop anyway.
  let mut j = job(Engine::Pdflatex, &[("paper.tex", main), ("ch/two.tex", two), ("refs.bib", bib)]);
  j.bibliography = Bibliography::None;
  let o = run(&j, &limits());
  assert_pdf(&o);
  assert!(o.log.contains("Citation `knuth84' on page 1 undefined"));
  assert!(o.passes <= limits().passes);
}

#[test]
fn shell_escape_does_nothing_in_any_engine() {
  for e in [Engine::Pdflatex, Engine::Xelatex, Engine::Lualatex] {
    let m = marker("w18");
    let lua = if e == Engine::Lualatex {
      format!("\\directlua{{local function try(n, f) local ok, r = pcall(f) texio.write_nl('TRY ' .. n .. ' ' .. tostring(ok) .. ' ' .. tostring(r)) end
        try('execute', function() return os.execute('touch {m}') end) try('popen', function() return io.popen('touch {m}') end)
        try('spawn', function() return os.spawn and os.spawn('touch {m}') end) try('exec', function() return os.exec and os.exec('touch {m}') end)}}")
    } else { String::new() };
    let doc = format!("\\documentclass{{article}}\\begin{{document}}x\\immediate\\write18{{touch /tmp/{m}; touch {m}}}\\immediate\\write18{{touch {m}}}{lua}\\IfFileExists{{{m}}}{{\\typeout{{MARK-FOUND}}}}{{\\typeout{{MARK-ABSENT}}}}\\end{{document}}\n");
    let o = run(&job(e, &[("main.tex", &doc)]), &limits());
    assert_pdf(&o);
    assert!(o.log.contains("MARK-ABSENT") && !o.log.contains("MARK-FOUND"), "{e:?}: {}", o.log);
    if e == Engine::Lualatex { assert!(!o.log.contains("TRY execute true 0") && !o.log.contains("TRY popen true file"), "{}", o.log); }
    assert!(!Path::new("/tmp").join(&m).exists());
    assert_no_trace(&m);
  }
}

#[test]
fn reading_outside_the_project_is_refused() {
  for e in [Engine::Pdflatex, Engine::Xelatex, Engine::Lualatex] {
    for target in ["/etc/passwd", "../../x", "/proc/1/environ"] {
      let doc = format!("\\documentclass{{article}}\\begin{{document}}\\input{{{target}}}\\end{{document}}\n");
      let o = run(&job(e, &[("main.tex", &doc)]), &limits());
      assert_eq!(o.status, Status::TexError, "{e:?} {target}: {}", o.log);
      assert!(o.pdf.is_none() && !o.log.contains("root:x:0:0"), "{}", o.log);
    }
  }
  // Even Lua with openin_any=r finds nothing of the host: the sandbox has no /etc.
  let doc = "\\documentclass{article}\\begin{document}x\\directlua{local f = io.open('/etc/passwd') texio.write_nl('PASSWD ' .. tostring(f)) local g = io.open('/home') texio.write_nl('HOME ' .. tostring(g))}\\end{document}\n";
  let o = run(&job(Engine::Lualatex, &[("main.tex", doc)]), &limits());
  assert_pdf(&o);
  assert!(o.log.contains("PASSWD nil") && o.log.contains("HOME nil"), "{}", o.log);
  // And the job's own paths are checked before anything is written.
  for bad in ["/etc/passwd", "../x.tex", "a/../../x.tex", ".latexmkrc", "a\0b"] {
    let o = run(&job(Engine::Pdflatex, &[("main.tex", HELLO), (bad, "x")]), &limits());
    assert!(matches!(o.status, Status::Rejected(JobError::BadPath(_))), "{bad:?}: {:?}", o.status);
  }
  let o = run(&job(Engine::Pdflatex, &[("main.tex", HELLO), ("a", "x"), ("a/b.tex", "x")]), &limits());
  assert_eq!(o.status, Status::Rejected(JobError::FileIsDirectory("a".into())));
}

#[test]
fn writing_outside_scratch_is_refused() {
  let m = marker("out");
  for target in [format!("/tmp/{m}"), format!("../{m}"), format!("../../work/{m}"), format!("/work/.home/{m}")] {
    let doc = format!("\\documentclass{{article}}\\begin{{document}}x\\newwrite\\o\\immediate\\openout\\o={target}\\immediate\\write\\o{{x}}\\immediate\\closeout\\o\\end{{document}}\n");
    let o = run(&job(Engine::Pdflatex, &[("main.tex", &doc)]), &limits());
    assert!(o.status == Status::TexError || o.log.contains("openout_any = p"), "{target}: {:?} {}", o.status, o.log);
  }
  assert_no_trace(&m);
}

#[test]
fn lua_has_no_network() {
  let doc = "\\documentclass{article}\\begin{document}x\\directlua{local ok, socket = pcall(require, 'socket') local res = 'NET-FAIL'
    if ok and type(socket) == 'table' then local c = socket.tcp() if c then c:settimeout(2) if c:connect('1.1.1.1', 80) then res = 'NET-OK' end end end
    texio.write_nl('RESULT ' .. res .. ' loaded=' .. tostring(ok))}\\end{document}\n";
  let o = run(&job(Engine::Lualatex, &[("main.tex", doc)]), &limits());
  assert_pdf(&o);
  assert!(o.log.contains("RESULT NET-FAIL") && !o.log.contains("NET-OK"), "{}", o.log);
}

fn python() -> (PathBuf, Vec<PathBuf>) {
  static P: OnceLock<(PathBuf, Vec<PathBuf>)> = OnceLock::new();
  P.get_or_init(|| {
    let out = std::process::Command::new("sh").args(["-c", "command -v python3"]).output().unwrap();
    let bin = std::fs::canonicalize(String::from_utf8(out.stdout).unwrap().trim()).expect("python3 from the dev shell");
    let root: PathBuf = bin.components().take(4).collect();
    (bin, store_closure(&[&root]).unwrap())
  }).clone()
}

fn raw(script: &str, files: &[(&str, &str)], l: &Limits) -> RawOutcome {
  let (_, closure) = python();
  let files: Vec<(String, Vec<u8>)> = files.iter().map(|(p, s)| (p.to_string(), s.as_bytes().to_vec())).collect();
  runner().run_raw(script, &closure, &files, l, &Cancel::new()).unwrap()
}

fn kv(s: &str) -> HashMap<String, String> { s.lines().filter_map(|l| l.split_once('=')).map(|(k, v)| (k.into(), v.into())).collect() }

const PROBE: &str = r#"
import ctypes, os, socket, resource, sys
libc = ctypes.CDLL(None, use_errno=True)
nr = dict(a.split(':') for a in sys.argv[1].split(','))
def sys_(name, *args):
    r = libc.syscall(ctypes.c_long(int(nr[name])), *[ctypes.c_long(a) for a in args])
    print(f"sys.{name}={'ok' if r >= 0 else os.strerror(ctypes.get_errno())}")
sys_('unshare', 0x10000000)          # CLONE_NEWUSER: allowed to unprivileged users without the filter
sys_('ptrace', 0, 0, 0, 0)           # PTRACE_TRACEME
sys_('personality', 0xffffffff)      # a query, normally always succeeds
sys_('keyctl', 0, -3, 0)             # KEYCTL_GET_KEYRING_ID of the session keyring
sys_('io_uring_setup', 1, 0)
sys_('setns', 0, 0)
sys_('mount', 0, 0, 0, 0, 0)
sys_('perf_event_open', 0, 0, -1, -1, 0)
sys_('bpf', 0, 0, 0)
sys_('clone', 0x10000000 | 17, 0, 0, 0, 0)
for fam in ['AF_INET', 'AF_INET6', 'AF_NETLINK', 'AF_PACKET', 'AF_UNIX']:
    try:
        socket.socket(getattr(socket, fam), socket.SOCK_DGRAM if fam != 'AF_PACKET' else socket.SOCK_RAW).close(); print(f"socket.{fam}=ok")
    except OSError as e: print(f"socket.{fam}={e.strerror}")
pid = os.fork()
if pid == 0: os._exit(7)
print(f"fork={os.waitpid(pid, 0)[1] >> 8}")
print("ifaces=" + ' '.join(sorted(l.split(':')[0].strip() for l in open('/proc/net/dev').readlines()[2:])))
for n in ['NPROC', 'NOFILE', 'FSIZE', 'AS', 'CPU', 'CORE']:
    print(f"rlimit.{n}={resource.getrlimit(getattr(resource, 'RLIMIT_' + n))[0]}")
for p in ['/x', '/nix/store/x', '/dev/shm/x', '/dev/x', '/tmp/x', '/proc/x', '/work/.home/../../x', '/work/ok']:
    try:
        open(p.replace('x', sys.argv[2]), 'w').write('x'); print(f"write.{p}=ok")
    except OSError as e: print(f"write.{p}={e.strerror}")
print("pids=" + ' '.join(sorted(d for d in os.listdir('/proc') if d.isdigit())))
print("root=" + ' '.join(sorted(os.listdir('/'))))
"#;

#[test]
fn seccomp_rlimits_network_and_filesystem_inside_the_sandbox() {
  let (py, _) = python();
  let m = marker("probe");
  let nrs: Vec<String> = seccomp::denied().iter().map(|(n, nr)| format!("{n}:{nr}")).chain([format!("clone:{}", libc_clone())]).collect();
  let l = limits();
  let o = raw(&format!("{} probe.py {} {m}; echo tcp; exec 3<>/dev/tcp/1.1.1.1/80 && echo TCP-OK", py.display(), nrs.join(",")), &[("probe.py", PROBE)], &l);
  let r = kv(&o.stdout);
  assert_eq!(o.code, Some(1), "stdout:\n{}\nstderr:\n{}", o.stdout, o.stderr);
  for s in ["unshare", "ptrace", "personality", "keyctl", "io_uring_setup", "setns", "mount", "perf_event_open", "bpf", "clone"] {
    assert_eq!(r.get(&format!("sys.{s}")).map(String::as_str), Some("Operation not permitted"), "{s}: {}", o.stdout);
  }
  for f in ["AF_INET", "AF_INET6", "AF_NETLINK", "AF_PACKET"] { assert_eq!(r[&format!("socket.{f}")], "Operation not permitted", "{f}"); }
  assert_eq!(r["socket.AF_UNIX"], "ok");
  assert_eq!(r["fork"], "7", "plain fork works");
  assert_eq!(r["ifaces"], "lo", "an empty network namespace");
  assert!(o.stdout.contains("tcp") && !o.stdout.contains("TCP-OK"));
  assert_eq!(r["rlimit.NPROC"], l.processes.to_string());
  assert_eq!(r["rlimit.NOFILE"], l.open_files.to_string());
  assert_eq!(r["rlimit.FSIZE"], (l.output_mib << 20).to_string());
  assert_eq!(r["rlimit.AS"], (l.memory_mib << 20).to_string());
  assert_eq!(r["rlimit.CPU"], l.cpu_seconds.to_string());
  assert_eq!(r["rlimit.CORE"], "0");
  for p in ["/x", "/nix/store/x", "/dev/shm/x", "/dev/x", "/tmp/x", "/proc/x", "/work/.home/../../x"] {
    assert_ne!(r[&format!("write.{p}")], "ok", "{p} is writable");
  }
  assert_eq!(r["write./work/ok"], "ok");
  assert!(r["pids"].split(' ').count() <= 4, "a private PID namespace: {}", r["pids"]);
  assert_eq!(r["root"], "dev nix proc work");
  assert_no_trace(&m);
}

fn libc_clone() -> i64 { if cfg!(target_arch = "x86_64") { 56 } else { 220 } }

#[test]
fn another_jobs_scratch_is_invisible() {
  let secret = marker("secret");
  let doc = format!("\\documentclass{{article}}\\begin{{document}}\\newwrite\\o\\immediate\\openout\\o={secret}.txt\\immediate\\write\\o{{{secret}}}\\immediate\\closeout\\o\\def\\x{{\\x}}\\x\\end{{document}}\n");
  let busy = scribyra_compile::spawn(runner(), job(Engine::Pdflatex, &[("busy.tex", &doc)]), Limits { wall_seconds: 30, cpu_seconds: 30, ..limits() });
  std::thread::sleep(Duration::from_secs(3));
  let o = raw(&format!("ls -la /work; for p in /proc/[0-9]*; do echo \"$p $(<$p/cmdline)\"; ls $p/root/work $p/cwd 2>&1; done; ls /proc/*/root/work/*{secret}* 2>&1; cat /proc/*/root/work/{secret}.txt 2>&1; echo end"), &[], &limits());
  assert!(o.stdout.contains("end") && o.stdout.contains("/proc/1 "), "{o:?}");
  assert!(!o.stdout.contains(&format!("{secret}.txt:")) && !o.stdout.lines().any(|l| l == secret), "{}", o.stdout);
  assert!(!o.stdout.contains("busy.tex"), "the other job's processes are invisible: {}", o.stdout);
  busy.cancel();
  let out = futures_block_on(busy);
  assert_eq!(out.status, Status::Cancelled);
  assert_no_trace(&secret);
}

fn futures_block_on<F: std::future::Future>(f: F) -> F::Output {
  tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap().block_on(f)
}

const LOOP: &str = "\\documentclass{article}\\begin{document}\\def\\x{\\x}\\x\\end{document}\n";

#[test]
fn infinite_loop_hits_the_cpu_limit() {
  let m = marker("cpu");
  let t = Instant::now();
  let o = run(&job(Engine::Pdflatex, &[(&format!("{m}.tex"), LOOP)]), &Limits { cpu_seconds: 2, ..limits() });
  assert_eq!(o.status, Status::LimitExceeded(Limit::Cpu), "{}", o.log);
  assert!(t.elapsed() < Duration::from_secs(20) && o.cpu_ms >= 1500, "{:?} {}", t.elapsed(), o.cpu_ms);
  assert_no_trace(&m);
}

#[test]
fn infinite_loop_hits_the_wall_clock_and_everything_dies() {
  let m = marker("wall");
  let t = Instant::now();
  let o = run(&job(Engine::Pdflatex, &[(&format!("{m}.tex"), LOOP)]), &Limits { cpu_seconds: 60, wall_seconds: 3, ..limits() });
  assert_eq!(o.status, Status::LimitExceeded(Limit::Wall), "{}", o.log);
  assert!(t.elapsed() < Duration::from_secs(8), "{:?}", t.elapsed());
  assert_no_trace(&m);
}

#[test]
fn memory_bomb_hits_the_memory_limit() {
  let m = marker("mem");
  let doc = "\\documentclass{article}\\begin{document}\\directlua{local t = {} for i = 1, 100000 do t[i] = string.rep('x', 10000000) .. i end}\\end{document}\n";
  let o = run(&job(Engine::Lualatex, &[(&format!("{m}.tex"), doc)]), &Limits { memory_mib: 1024, ..limits() });
  assert_eq!(o.status, Status::LimitExceeded(Limit::Memory), "{}", o.log);
  let (py, _) = python();
  let r = raw(&format!("{} -c 'x = [bytearray(10 << 20) for _ in range(1000)]' 2>&1 | tail -1", py.display()), &[], &Limits { memory_mib: 512, ..limits() });
  assert!(r.stdout.contains("MemoryError"), "{r:?}");
  assert_no_trace(&m);
}

const LINE: &str = "\\def\\l{xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx}\\def\\ll{\\l\\l\\l\\l\\l\\l\\l\\l\\l\\l}";

#[test]
fn output_bomb_hits_the_file_size_limit() {
  let m = marker("fsize");
  let doc = format!("{LINE}\\newwrite\\o\\immediate\\openout\\o=big.txt\\loop\\immediate\\write\\o{{\\ll}}\\iftrue\\repeat\n");
  let t = Instant::now();
  let o = run(&job(Engine::Pdflatex, &[(&format!("{m}.tex"), &doc)]), &Limits { output_mib: 4, ..limits() });
  assert_eq!(o.status, Status::LimitExceeded(Limit::Output), "{}", o.log);
  assert!(t.elapsed() < Duration::from_secs(20));
  assert_no_trace(&m);
}

#[test]
fn many_files_bomb_hits_the_scratch_limit() {
  let m = marker("scratch");
  let doc = format!("{LINE}\\newcount\\n\\newcount\\k\\newwrite\\o\\loop\\immediate\\openout\\o=f\\the\\n.txt\\k=0 {{\\loop\\immediate\\write\\o{{\\ll}}\\advance\\k 1 \\ifnum\\k<3000 \\repeat}}\\immediate\\closeout\\o\\advance\\n 1 \\ifnum\\n<40 \\repeat\\csname @@end\\endcsname\n");
  let t = Instant::now();
  let o = run(&job(Engine::Pdflatex, &[(&format!("{m}.tex"), &doc)]), &Limits { output_mib: 4, scratch_mib: 16, ..limits() });
  assert_eq!(o.status, Status::LimitExceeded(Limit::Scratch), "{}", o.log);
  assert!(t.elapsed() < Duration::from_secs(40));
  assert_no_trace(&m);
}

#[test]
fn fork_bomb_is_bounded() {
  let m = marker("fork");
  let t = Instant::now();
  let o = raw(&format!("echo {m} >/dev/null; f() {{ f | f & }}; f; sleep 1; ls /proc | wc -l"), &[], &Limits { processes: 16, wall_seconds: 6, ..limits() });
  assert!(t.elapsed() < Duration::from_secs(12), "{:?}", t.elapsed());
  if o.killed.is_none() { assert!(o.stdout.trim().parse::<usize>().unwrap_or(0) < 16 + 40, "{o:?}"); }
  assert!(o.stderr.contains("Resource temporarily unavailable") || o.killed.is_some(), "{o:?}");
  assert_no_trace(&m);
}

#[test]
fn dropping_the_future_cancels_the_job() {
  let m = marker("drop");
  futures_block_on(async {
    let ok = scribyra_compile::spawn(runner(), job(Engine::Pdflatex, &[("main.tex", HELLO)]), limits()).await;
    assert_pdf(&ok);
    let r = tokio::time::timeout(Duration::from_secs(2), scribyra_compile::spawn(runner(), job(Engine::Pdflatex, &[(&format!("{m}.tex"), LOOP)]), limits())).await;
    assert!(r.is_err());
  });
  let t = Instant::now();
  while !leftovers(&m).is_empty() && t.elapsed() < Duration::from_secs(5) { std::thread::sleep(Duration::from_millis(50)); }
  assert_no_trace(&m);
}
