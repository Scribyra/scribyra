//! Server compile through the real binary (design section 6, slice 11): real PostgreSQL,
//! filesystem and Garage blobs, real TeX Live and bubblewrap from the dev shell (`nix develop -c
//! cargo test -p scribyra-sync`; the sandbox takes a systemd user scope for its cgroups). A
//! project compiles on the server and members download the PDF; roles, compile modes and the
//! project switch; the PDF cache; malicious projects; the queue bound, per-project replacement and
//! the per-member rate; lost workers and SIGTERM; sealing at rest; heads; metrics.
mod support;
use serde_json::{Value, json};
use std::time::{Duration, Instant};
use support::{sr::*, sso::*, *};

fn texlive() -> String {
    std::env::var("SCRIBYRA_TEXLIVE").expect("SCRIBYRA_TEXLIVE: run under `nix develop`")
}
/// `compile` mode with native TeX Live and small limits; `limits` overrides some of them. The
/// tests below that do not name an engine exercise the native engine, kept behind
/// `compile_engine` for comparison; the WebAssembly engine (the default) has its own at the end.
fn deployment(compile: &str, limits: Value) -> Value {
    let mut l = json!({"cpu_seconds": 10, "wall_seconds": 40, "memory_mib": 1536, "scratch_mib": 64, "output_mib": 16, "passes": 4, "concurrency": 2, "queue": 32, "per_member_per_hour": 120});
    for (k, v) in limits.as_object().unwrap() {
        l[k] = v.clone();
    }
    json!({"compile": compile, "compile_engine": "native", "texlive": texlive(), "compile_limits": l})
}
/// A server-readable deployment with server compile; `in_process` runs a worker inside `serve`.
fn start(blobs: Blobs, compile: &str, in_process: bool, service: Value, limits: Value) -> Sr {
    let mut s = json!({"compile_worker_in_process": in_process, "compile_heartbeat_seconds": 1, "compile_heartbeat_timeout_seconds": 3});
    for (k, v) in service.as_object().unwrap() {
        s[k] = v.clone();
    }
    Sr::start(blobs, people(), s, deployment(compile, limits))
}
/// A project whose main file `main.tex` holds `source` (entries 1 and 2).
fn paper(api: &Api, name: &str, source: &str) -> (String, Project) {
    let p = api.create(name);
    let doc = Project::new();
    assert_eq!(api.append(&p, "a", 1, &doc.add_text("f1", "main.tex", None, source)).status, 201);
    assert_eq!(api.append(&p, "a", 2, &doc.set_main("f1")).status, 201);
    (p, doc)
}
fn hello(text: &str) -> String {
    format!("\\documentclass{{article}}\\begin{{document}}{text}\\end{{document}}\n")
}
/// A project that never finishes: tail recursion forever (after trying `\write18`).
fn endless(marker: &str) -> String {
    format!("\\documentclass{{article}}\\begin{{document}}\\immediate\\write18{{touch /tmp/{marker}}}\\def\\x{{\\x}}\\x\\end{{document}}\n")
}
fn account(sr: &Sr, user: &str) -> String {
    postgres().psql(&sr.db(), &format!("SELECT account FROM accounts WHERE email = '{user}@example.org'"))
}
/// Polls the status until `check` holds for the latest job.
fn until(api: &Api, p: &str, what: &str, check: impl Fn(&Value) -> bool) -> Value {
    let deadline = Instant::now() + Duration::from_secs(90);
    loop {
        let status = api.compile_status(p).json();
        if check(&status["job"]) {
            return status;
        }
        assert!(Instant::now() < deadline, "timed out waiting for {what}: {status}");
        std::thread::sleep(Duration::from_millis(100));
    }
}
fn contains(haystack: &[u8], needle: &[u8]) -> bool {
    haystack.windows(needle.len()).any(|w| w == needle)
}
fn walk(dir: &std::path::Path) -> Vec<std::path::PathBuf> {
    let mut out = Vec::new();
    for entry in std::fs::read_dir(dir).into_iter().flatten().flatten() {
        let path = entry.path();
        if path.is_dir() { out.extend(walk(&path)) } else { out.push(path) }
    }
    out
}
fn read_blob(sr: &Sr, key: &str) -> Vec<u8> {
    let store: Box<dyn scribyra_sync::blobs::BlobStore> = match sr.blobs {
        Blobs::Fs => Box::new(scribyra_sync::blobs::FsBlobStore::open(sr.env.service.dir.join("data")).unwrap()),
        Blobs::S3 => {
            let c = &sr.env.service.config;
            Box::new(
                scribyra_sync::blobs::S3BlobStore::new(scribyra_sync::blobs::S3Settings {
                    endpoint: c["s3_endpoint"].as_str().unwrap().into(),
                    region: "garage".into(),
                    bucket: c["s3_bucket"].as_str().unwrap().into(),
                    access_key_id: c["s3_access_key_id"].as_str().unwrap().into(),
                    secret_access_key: std::fs::read_to_string(c["s3_secret_access_key_file"].as_str().unwrap()).unwrap().trim().into(),
                    path_style: true,
                    ca_pem: None,
                })
                .unwrap(),
            )
        }
    };
    let size: usize = postgres().psql(&sr.db(), &format!("SELECT COALESCE((SELECT pdf_size FROM compiles WHERE pdf_blob = '{key}'), (SELECT log_size FROM compiles WHERE log_blob = '{key}'))")).parse().unwrap();
    let key = scribyra_sync::blobs::BlobKey::new(key.to_owned()).unwrap();
    tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap().block_on(store.get(&key, size)).unwrap()
}
fn pg_dump(url: &str) -> Vec<u8> {
    let out = std::process::Command::new("pg_dump").args(["--no-owner", "--data-only", url]).output().unwrap();
    assert!(out.status.success());
    out.stdout
}
/// Follows `GET /v1/sr/heads` long polls until project `p`'s compile is `job` in `state`; every
/// poll must be woken by a change (none may run to its 20-second wait).
fn heads_until(api: &Api, p: &str, since: &str, job: &str, state: &str) {
    let mut since = since.to_owned();
    loop {
        let t = Instant::now();
        let reply = api.heads(Some(&since), 20).json();
        assert!(t.elapsed() < Duration::from_secs(15), "a heads poll was not woken: {reply}");
        let c = &reply["projects"][p]["compile"];
        if c["job"] == job && c["state"] == state {
            return;
        }
        since = reply["version"].as_str().unwrap().to_owned();
    }
}

#[test]
fn a_project_compiles_on_the_server_and_every_member_downloads_the_pdf() {
    for blobs in BOTH {
        // Filesystem blobs: the worker runs inside `serve`; S3: a separate compile-worker process.
        let sr = start(blobs, "server", blobs == Blobs::Fs, json!({}), json!({}));
        let _worker = (blobs == Blobs::S3).then(|| sr.worker(json!({})));
        let (ana, ben, cat, erin) = (sr.api(&sr.login("alice")), sr.api(&sr.login("ben")), sr.api(&sr.login("cat")), sr.api(&sr.login("erin")));
        let (pdf_mark, log_mark) = (format!("PDFMARK{}", random_hex(8)), format!("LOGMARK{}", random_hex(8)));
        // Uncompressed, so the marker is in the PDF's bytes as plain text.
        let source = format!("\\pdfcompresslevel=0 \\pdfobjcompresslevel=0 \\pdfinfo{{/Title ({pdf_mark})}}\\documentclass{{article}}\\begin{{document}}Hello from the server.\\typeout{{{log_mark}}}\\end{{document}}\n");
        let (p, doc) = paper(&ana, "Server paper", &source);
        assert_eq!(ana.invite(&p, "ben@example.org", "viewer").status, 201);
        assert_eq!(ana.invite(&p, "cat@example.org", "editor").status, 201);
        let ben_version = ben.heads(None, 0).json()["version"].as_str().unwrap().to_owned();
        // An editor (here the owner) asks; viewers may not.
        assert_eq!(ben.compile(&p, None).status, 403, "{blobs:?}");
        let queued = ana.compile(&p, Some(2));
        assert_eq!((queued.status, queued.json()["state"].as_str()), (202, Some("queued")), "{}", String::from_utf8_lossy(&queued.body));
        let job = queued.json()["job"].as_str().unwrap().to_owned();
        // Ben's heads polls wake as the job is queued, runs and finishes.
        heads_until(&ben, &p, &ben_version, &job, "done");
        let status = ana.compiled(&p, &job);
        assert_eq!(status["job"]["outcome"], "success", "{status}");
        assert_eq!(status["mode"], "server");
        let pdf = &status["pdf"];
        assert_eq!((pdf["job"].as_str(), pdf["seq"].as_i64(), pdf["engine"].as_str(), pdf["fromHead"].as_bool()), (Some(job.as_str()), Some(2), Some("pdflatex"), Some(true)));
        assert_eq!(pdf["requestedBy"]["account"].as_str(), Some(account(&sr, "alice").as_str()));
        // Every member downloads it: the viewer too.
        let got = ben.call("GET", &format!("/v1/sr/projects/{p}/compile/pdf"), None);
        assert_eq!((got.status, got.header("content-type"), got.header("scribyra-compile-seq")), (200, Some("application/pdf"), Some("2")));
        assert!(got.body.starts_with(b"%PDF-") && contains(&got.body, pdf_mark.as_bytes()));
        assert_eq!(pdf["bytes"].as_i64(), Some(got.body.len() as i64));
        let log = cat.call("GET", &format!("/v1/sr/projects/{p}/compile/log"), None);
        assert_eq!(log.status, 200);
        assert!(contains(&log.body, log_mark.as_bytes()) && contains(&log.body, b"Output written on main.pdf"));
        // Someone the project is not shared with cannot tell it exists.
        for path in ["compile", "compile/pdf", "compile/log"] {
            assert_eq!(erin.call("GET", &format!("/v1/sr/projects/{p}/{path}"), None).status, 404, "{path}");
        }
        assert_eq!(erin.compile(&p, None).status, 404);
        // Sealed at rest: neither marker is in the database or any blob.
        assert!(!contains(&pg_dump(&sr.db()), pdf_mark.as_bytes()) && !contains(&pg_dump(&sr.db()), log_mark.as_bytes()), "{blobs:?}: plaintext in the database");
        let keys = postgres().psql(&sr.db(), "SELECT pdf_blob FROM compiles WHERE pdf_blob IS NOT NULL UNION ALL SELECT log_blob FROM compiles WHERE log_blob IS NOT NULL");
        assert_eq!(keys.lines().count(), 2);
        for key in keys.lines() {
            let bytes = read_blob(&sr, key);
            assert!(bytes.len() > 40 && !contains(&bytes, pdf_mark.as_bytes()) && !contains(&bytes, log_mark.as_bytes()) && !bytes.starts_with(b"%PDF"), "{blobs:?}: plaintext in {key}");
        }
        if blobs == Blobs::Fs {
            for file in walk(&sr.env.service.dir.join("data")) {
                let bytes = std::fs::read(&file).unwrap();
                assert!(!contains(&bytes, pdf_mark.as_bytes()) && !contains(&bytes, log_mark.as_bytes()), "plaintext in {}", file.display());
            }
        }
        // The PDF counts against the project's stored bytes.
        let charged: i64 = postgres().psql(&sr.db(), &format!("SELECT bytes - (SELECT COALESCE(sum(size), 0) FROM sr_entries WHERE project = '{p}') FROM sr_projects WHERE project = '{p}'")).parse().unwrap();
        assert!(charged > got.body.len() as i64, "{charged}");
        // A later edit leaves the PDF from an older version.
        assert_eq!(cat.append(&p, "c", 1, &doc.type_text("f1", "% more\n")).status, 201);
        assert_eq!(ana.compile_status(&p).json()["pdf"]["fromHead"], false);
    }
}

#[test]
fn compile_modes_and_the_project_switch_are_enforced() {
    // compile "browser": no compile routes, and the project switch is the deployment's.
    let browser = Sr::start(Blobs::Fs, people(), json!({}), json!({}));
    let ana = browser.api(&browser.login("alice"));
    let (p, _) = paper(&ana, "Local", &hello("x"));
    assert_eq!(ana.details(&p).json()["compile"], "browser");
    for (method, path) in [("POST", "compile"), ("GET", "compile"), ("GET", "compile/pdf"), ("GET", "compile/log")] {
        let reply = ana.call(method, &format!("/v1/sr/projects/{p}/{path}"), (method == "POST").then(|| json!({})));
        assert_eq!(reply.status, 404, "{path}");
    }
    assert_eq!(ana.call("PUT", &format!("/v1/sr/projects/{p}/settings"), Some(json!({"compile": "server"}))).status, 409);
    assert!(ana.heads(None, 0).json()["projects"][&p].get("compile").is_none());
    drop(browser);

    // compile "server": every project compiles on the server; there is no switch.
    let server = start(Blobs::Fs, "server", false, json!({}), json!({}));
    let ana = server.api(&server.login("alice"));
    let (p, _) = paper(&ana, "Server", &hello("x"));
    assert_eq!(ana.details(&p).json()["compile"], "server");
    assert_eq!(ana.heads(None, 0).json()["projects"][&p]["compile"]["mode"], "server");
    assert_eq!(ana.compile(&p, None).status, 202);
    assert_eq!(ana.call("PUT", &format!("/v1/sr/projects/{p}/settings"), Some(json!({"compile": "browser"}))).status, 409);
    drop(server);

    // compile "both": projects start in the browser; owners and editors switch them.
    let both = start(Blobs::Fs, "both", false, json!({}), json!({}));
    let (ana, ben, dan) = (both.api(&both.login("alice")), both.api(&both.login("ben")), both.api(&both.login("dan")));
    let (p, _) = paper(&ana, "Either", &hello("x"));
    assert_eq!(ana.invite(&p, "ben@example.org", "editor").status, 201);
    assert_eq!(ana.invite(&p, "dan@example.org", "viewer").status, 201);
    assert_eq!(ana.details(&p).json()["compile"], "browser");
    let refused = ana.compile(&p, None);
    assert_eq!((refused.status, refused.json()["error"].as_str()), (409, Some("this project compiles in the browser")));
    let settings = format!("/v1/sr/projects/{p}/settings");
    assert_eq!(dan.call("PUT", &settings, Some(json!({"compile": "server"}))).status, 403);
    assert_eq!(ben.call("PUT", &settings, Some(json!({"compile": "elsewhere"}))).status, 400);
    let version = dan.heads(None, 0).json()["version"].as_str().unwrap().to_owned();
    assert_eq!(ben.call("PUT", &settings, Some(json!({"compile": "server"}))).status, 200);
    // Members see the change (their heads polls wake with it).
    let woken = dan.heads(Some(&version), 10).json();
    assert_eq!(woken["projects"][&p]["compile"]["mode"], "server");
    assert_eq!(dan.details(&p).json()["compile"], "server");
    assert_eq!(dan.compile(&p, None).status, 403);
    assert_eq!(ben.compile(&p, None).status, 202);
    assert_eq!(ana.compile_status(&p).json()["mode"], "server");
    assert_eq!(ana.call("PUT", &settings, Some(json!({"compile": "browser"}))).status, 200);
    assert_eq!(ana.compile(&p, None).status, 409);
    // Reading what was compiled stays possible.
    assert_eq!(dan.compile_status(&p).status, 200);
    // Each change of the switch is in the audit log once, with who made it (refusals are not).
    let modes: Vec<(String, String)> = postgres()
        .psql(&both.db(), &format!("SELECT a.email || ' ' || (e.detail->>'mode') FROM audit_log e JOIN accounts a ON a.account = e.actor WHERE e.action = 'project.compile_mode' AND e.target_id = '{p}' ORDER BY e.seq"))
        .lines()
        .map(|l| l.split_once(' ').map(|(a, b)| (a.to_owned(), b.to_owned())).unwrap())
        .collect();
    assert_eq!(modes, [("ben@example.org".to_owned(), "server".to_owned()), ("alice@example.org".to_owned(), "browser".to_owned())]);
}

#[test]
fn unchanged_content_reuses_the_stored_pdf() {
    // XeTeX builds its font cache in every job's scratch: give it CPU time on a loaded host.
    let sr = start(Blobs::Fs, "server", true, json!({}), json!({"cpu_seconds": 60, "wall_seconds": 120}));
    let ana = sr.api(&sr.login("alice"));
    let (p, doc) = paper(&ana, "Cached", &hello("Same every time."));
    let first = ana.compile(&p, None).json()["job"].as_str().unwrap().to_owned();
    assert_eq!(ana.compiled(&p, &first)["job"]["state"], "done");
    // The same files, engine and TeX Live: the stored PDF, no new job.
    let again = ana.compile(&p, None);
    assert_eq!((again.status, again.json()["job"].as_str(), again.json()["cached"].as_bool()), (200, Some(first.as_str()), Some(true)));
    // Review L5: the PDF route serves exactly the job a cached answer names, or 404.
    let named = ana.call("GET", &format!("/v1/sr/projects/{p}/compile/pdf?job={first}"), None);
    assert_eq!((named.status, named.header("scribyra-compile-job")), (200, Some(first.as_str())));
    let other = ana.call("GET", &format!("/v1/sr/projects/{p}/compile/pdf?job={}", random_hex(32)), None);
    assert_eq!((other.status, other.json()["error"].as_str()), (404, Some("that compile's PDF is not kept")));
    // An entry that does not change the files (a name change) still hits the cache.
    assert_eq!(ana.append(&p, "a", 3, &doc.set_meta("name", "Renamed")).status, 201);
    assert_eq!(ana.compile(&p, None).json()["cached"], true);
    assert_eq!(postgres().psql(&sr.db(), "SELECT count(*) FROM compiles"), "1");
    // Another engine is another compile.
    assert_eq!(ana.append(&p, "a", 4, &doc.set_meta("engine", "xelatex")).status, 201);
    let xe = ana.compile(&p, None);
    assert_eq!(xe.status, 202);
    let xe = xe.json()["job"].as_str().unwrap().to_owned();
    let status = ana.compiled(&p, &xe);
    assert_eq!((status["job"]["state"].as_str(), status["pdf"]["engine"].as_str()), (Some("done"), Some("xelatex")), "{status}: {}", String::from_utf8_lossy(&ana.call("GET", &format!("/v1/sr/projects/{p}/compile/log"), None).body));
    // Only the newest successful PDF and log are kept; the first job's blobs are removed.
    assert_eq!(postgres().psql(&sr.db(), &format!("SELECT pdf_blob IS NULL AND log_blob IS NULL FROM compiles WHERE job = '{first}'")), "t");
    assert_eq!(ana.call("GET", &format!("/v1/sr/projects/{p}/compile/pdf?job={first}"), None).status, 404);
    assert_eq!(ana.call("GET", &format!("/v1/sr/projects/{p}/compile/pdf?job={xe}"), None).header("scribyra-compile-job"), Some(xe.as_str()));
    eventually("blob removal", || postgres().psql(&sr.db(), "SELECT count(*) FROM sr_garbage") == "0");
    // So going back to pdflatex compiles again.
    assert_eq!(ana.append(&p, "a", 5, &doc.set_meta("engine", "pdflatex")).status, 201);
    assert_eq!(ana.compile(&p, None).status, 202);
    // Changed content too.
    let p2 = ana.compile_status(&p).json()["job"]["id"].as_str().unwrap().to_owned();
    ana.compiled(&p, &p2);
    assert_eq!(ana.append(&p, "a", 6, &doc.type_text("f1", "% changed\n")).status, 201);
    assert_eq!(ana.compile(&p, None).status, 202);
}

#[test]
fn malicious_projects_fail_with_a_log_and_the_worker_stays_healthy() {
    let sr = start(Blobs::S3, "server", false, json!({}), json!({"cpu_seconds": 3, "wall_seconds": 30}));
    let metrics_port = free_port();
    let worker = sr.worker(json!({"metrics_bind": format!("127.0.0.1:{metrics_port}")}));
    let ana = sr.api(&sr.login("alice"));
    let marker = format!("scribyra-pwned-{}", random_hex(8));
    let (bad, _) = paper(&ana, "Endless", &endless(&marker));
    let job = ana.compile(&bad, None).json()["job"].as_str().unwrap().to_owned();
    let status = ana.compiled(&bad, &job);
    assert_eq!((status["job"]["state"].as_str(), status["job"]["outcome"].as_str()), (Some("failed"), Some("limit_cpu")), "{status}");
    assert!(status["job"]["error"].as_str().unwrap().contains("CPU"));
    assert_eq!(status["pdf"], Value::Null);
    let log = ana.call("GET", &format!("/v1/sr/projects/{bad}/compile/log?job={job}"), None);
    assert_eq!(log.status, 200);
    let text = String::from_utf8_lossy(&log.body);
    assert!(text.contains("[stopped: CPU budget of 3 s]"), "{text}");
    assert!(!std::path::Path::new(&format!("/tmp/{marker}")).exists(), "\\write18 ran");
    // The worker is still live and ready, and the next project compiles.
    for path in ["/healthz", "/readyz"] {
        assert_eq!(status_of(&format!("{}{path}", worker.url)), 200, "{path}");
    }
    let (good, _) = paper(&ana, "Fine", &hello("Still fine."));
    let job = ana.compile(&good, None).json()["job"].as_str().unwrap().to_owned();
    assert_eq!(ana.compiled(&good, &job)["job"]["state"], "done");
    // The failed log of the other project is kept.
    assert_eq!(ana.call("GET", &format!("/v1/sr/projects/{bad}/compile/log"), None).status, 200);
    // The worker's metrics count both outcomes and name no project.
    let metrics = support::sso::fetch(&format!("http://127.0.0.1:{metrics_port}/metrics"), None);
    let text = metrics.body;
    assert!(text.contains("scribyra_compile_jobs_total{outcome=\"limit_cpu\"} 1") && text.contains("scribyra_compile_jobs_total{outcome=\"success\"} 1"), "{text}");
    assert!(!text.contains(&bad) && !text.contains(&good));
}
fn status_of(url: &str) -> u16 {
    support::status(url)
}

#[test]
fn the_queue_is_bounded_a_newer_request_replaces_a_queued_one_and_members_are_rate_limited() {
    // No worker: jobs stay queued.
    let sr = start(Blobs::Fs, "server", false, json!({}), json!({"queue": 2, "per_member_per_hour": 7}));
    let ana = sr.api(&sr.login("alice"));
    let ((p1, d1), (p2, _), (p3, _)) = (paper(&ana, "One", &hello("1")), paper(&ana, "Two", &hello("2")), paper(&ana, "Three", &hello("3")));
    let a = ana.compile(&p1, None).json()["job"].as_str().unwrap().to_owned();
    // The same files again: the queued job.
    let same = ana.compile(&p1, None);
    assert_eq!((same.status, same.json()["job"].as_str(), same.json()["state"].as_str()), (200, Some(a.as_str()), Some("queued")));
    // Newer files replace the queued job.
    let mut n = 3;
    let mut edit = |api: &Api| {
        assert_eq!(api.append(&p1, "a", n, &d1.type_text("f1", "%\n")).status, 201);
        n += 1;
    };
    edit(&ana);
    let b = ana.compile(&p1, None);
    assert_eq!((b.status, b.json()["replaced"].as_bool()), (202, Some(true)));
    assert_eq!(postgres().psql(&sr.db(), &format!("SELECT state FROM compiles WHERE job = '{a}'")), "replaced");
    assert_eq!(postgres().psql(&sr.db(), &format!("SELECT count(*) FROM compiles WHERE project = '{p1}' AND state = 'queued'")), "1");
    assert_eq!(ana.compile(&p2, None).status, 202);
    // Two queued: a third project waits.
    let full = ana.compile(&p3, None);
    assert_eq!((full.status, full.header("retry-after")), (503, Some("60")));
    // Replacing does not grow the queue, so it is still allowed.
    edit(&ana);
    assert_eq!(ana.compile(&p1, None).status, 202);
    // Seven requests this hour (every answer counts: a, the same again, b, two, three, the
    // latest one, and this one); the eighth is refused.
    edit(&ana);
    assert_eq!(ana.compile(&p1, None).status, 202);
    edit(&ana);
    let limited = ana.compile(&p1, None);
    assert_eq!((limited.status, limited.header("retry-after")), (429, Some("60")), "{}", String::from_utf8_lossy(&limited.body));
    // Others are not limited by Ana's requests.
    let ben = sr.api(&sr.login("ben"));
    assert_eq!(ana.invite(&p1, "ben@example.org", "editor").status, 201);
    assert_eq!(ben.compile(&p1, None).status, 202);
    assert_eq!(postgres().psql(&sr.db(), "SELECT count(*) FROM compiles WHERE state = 'queued'"), "2");
    // A version past the head or before the floor is refused.
    assert_eq!(ben.compile(&p1, Some(99)).status, 400);
}

#[test]
fn a_job_whose_worker_stops_heartbeating_is_requeued_once_then_failed() {
    let sr = start(Blobs::S3, "server", false, json!({}), json!({"cpu_seconds": 120, "wall_seconds": 300}));
    let ana = sr.api(&sr.login("alice"));
    let (p, _) = paper(&ana, "Lost", &endless(&format!("scribyra-lost-{}", random_hex(8))));
    let job = ana.compile(&p, None).json()["job"].as_str().unwrap().to_owned();
    for attempt in 1..=2 {
        let mut worker = sr.worker(json!({}));
        until(&ana, &p, "running", |j| j["state"] == "running");
        assert_eq!(postgres().psql(&sr.db(), &format!("SELECT attempts FROM compiles WHERE job = '{job}'")), attempt.to_string());
        // The worker dies without a word (and its sandbox with it).
        worker.kill();
        let status = until(&ana, &p, "the job taken back", |j| j["state"] != "running");
        if attempt == 1 {
            assert_eq!((status["job"]["id"].as_str(), status["job"]["state"].as_str()), (Some(job.as_str()), Some("queued")));
        } else {
            assert_eq!((status["job"]["state"].as_str(), status["job"]["outcome"].as_str()), (Some("failed"), Some("lost")));
            assert_eq!(status["job"]["error"], "the compile worker stopped responding twice");
            let log = ana.call("GET", &format!("/v1/sr/projects/{p}/compile/log"), None);
            assert_eq!((log.status, log.body.as_slice()), (200, b"the compile worker stopped responding twice".as_slice()));
        }
    }
}

#[test]
fn sigterm_gives_running_jobs_back_to_the_queue() {
    let sr = start(Blobs::S3, "server", false, json!({}), json!({"cpu_seconds": 120, "wall_seconds": 300}));
    let ana = sr.api(&sr.login("alice"));
    let (p, _) = paper(&ana, "Interrupted", &endless(&format!("scribyra-term-{}", random_hex(8))));
    let job = ana.compile(&p, None).json()["job"].as_str().unwrap().to_owned();
    let mut worker = sr.worker(json!({"shutdown_grace_seconds": 1}));
    until(&ana, &p, "running", |j| j["state"] == "running");
    let t = Instant::now();
    let exit = worker.terminate();
    assert!(exit.success(), "{exit:?}: {}", worker.logs.lock().unwrap());
    assert!(t.elapsed() < Duration::from_secs(10), "{:?}", t.elapsed());
    let status = ana.compile_status(&p).json();
    assert_eq!((status["job"]["id"].as_str(), status["job"]["state"].as_str()), (Some(job.as_str()), Some("queued")));
    // Handing a job back does not use up its retry.
    assert_eq!(postgres().psql(&sr.db(), &format!("SELECT attempts FROM compiles WHERE job = '{job}'")), "0");
    let logs = worker.logs.lock().unwrap().clone();
    assert!(logs.contains("\"compile_requeued\"") && logs.contains("\"stopped\""), "{logs}");
}

#[test]
fn metrics_expose_the_queue_length_and_requests_without_content() {
    let port = free_port();
    let sr = start(Blobs::Fs, "server", false, json!({"metrics_bind": format!("127.0.0.1:{port}")}), json!({}));
    let ana = sr.api(&sr.login("alice"));
    let ((p1, _), (p2, _)) = (paper(&ana, "One", &hello("1")), paper(&ana, "Two", &hello("2")));
    assert_eq!(ana.compile(&p1, None).status, 202);
    assert_eq!(ana.compile(&p2, None).status, 202);
    let reply = support::sso::fetch(&format!("http://127.0.0.1:{port}/metrics"), None);
    assert_eq!(reply.status, 200);
    let text = reply.body;
    assert!(text.contains(&format!("{} 2\n", scribyra_sync::deploy::COMPILE_QUEUE_METRIC)), "{text}");
    assert!(text.contains("scribyra_http_requests_total{route=\"/v1/sr/projects/{project}/compile\",status=\"202\"} 2"), "{text}");
    assert!(text.contains("scribyra_compile_requests_total{result=\"queued\"} 2"), "{text}");
    for id in [&p1, &p2, &account(&sr, "alice")] {
        assert!(!text.contains(id.as_str()), "{id} in metrics");
    }
    // The API listener does not serve them.
    assert_eq!(status_of(&format!("{}/metrics", sr.url())), 404);
}

/// The library side of `sr`'s deployment (its service stopped first, so no maintenance races the
/// test): a runtime and the queue, for steps HTTP cannot time (claims, reaps, late finishes).
fn library(sr: &mut Sr) -> (tokio::runtime::Runtime, std::sync::Arc<scribyra_sync::compiles::Compiles>) {
    let config: scribyra_sync::config::Config = serde_json::from_value(sr.env.service.config.clone()).unwrap();
    sr.env.service.stop();
    let runtime = tokio::runtime::Runtime::new().unwrap();
    let compiles = runtime.block_on(async {
        let store = std::sync::Arc::new(scribyra_sync::store::Store::open(config).await.unwrap());
        let projects = scribyra_sync::server_projects::Projects::new(store).unwrap().unwrap();
        scribyra_sync::compiles::Compiles::new(projects).unwrap()
    });
    (runtime, compiles)
}
fn finished(pdf: &[u8]) -> scribyra_sync::compiles::Finished {
    scribyra_sync::compiles::Finished { outcome: "success".into(), error: None, content_hash: None, cpu_ms: 1, passes: 1, pdf: Some(pdf.to_vec()), log: Some("log".into()) }
}

#[test]
fn a_lost_claims_late_finish_never_touches_the_result_of_the_claim_that_took_over() {
    // Review H1: blob names were fixed per job, so worker A (lost) overwrote and then deleted the
    // PDF of worker B, which had taken the job over: the status listed a PDF the route could not
    // serve. And one process reclaiming its own lost job could heartbeat and finish both runs.
    for blobs in BOTH {
        let mut sr = start(blobs, "server", false, json!({}), json!({}));
        let ana = sr.api(&sr.login("alice"));
        let (p, _) = paper(&ana, "Taken over", &hello("x"));
        let job = ana.compile(&p, None).json()["job"].as_str().unwrap().to_owned();
        let db = sr.db();
        let (runtime, compiles) = library(&mut sr);
        runtime.block_on(async {
            let a = compiles.claim().await.unwrap().unwrap();
            assert_eq!(a.job, job);
            postgres().psql(&db, "UPDATE compiles SET heartbeat = now() - interval '1 hour'");
            assert_eq!(compiles.reap().await.unwrap(), 1);
            let b = compiles.claim().await.unwrap().unwrap();
            assert_eq!(b.job, job);
            assert!(!compiles.heartbeat(&a).await.unwrap(), "{blobs:?}: the lost claim still heartbeats");
            assert!(compiles.heartbeat(&b).await.unwrap());
            assert_eq!(compiles.finish(&b, finished(b"%PDF-B")).await.unwrap(), Some("done"));
            // A finishes late: discarded, and B's PDF and log are still served.
            assert_eq!(compiles.finish(&a, finished(b"%PDF-A")).await.unwrap(), None);
            assert!(!compiles.requeue(&a).await.unwrap());
            let (served, _, pdf) = compiles.artefact(&p, "pdf", None).await.unwrap().unwrap();
            assert_eq!((served.as_str(), pdf.as_slice()), (job.as_str(), b"%PDF-B".as_slice()), "{blobs:?}");
            assert_eq!(compiles.artefact(&p, "log", None).await.unwrap().unwrap().2, b"log");
        });
        // Only B's two blobs exist: A's were removed once its result was refused.
        let names = postgres().psql(&db, "SELECT pdf_blob || ' ' || log_blob FROM compiles");
        assert!(names.contains(&format!("{job}-")), "{names}");
        if blobs == Blobs::Fs {
            let files: Vec<_> = walk(&sr.env.service.dir.join("data")).into_iter().filter(|f| f.to_string_lossy().contains("/c/")).collect();
            assert_eq!(files.len(), 2, "{blobs:?}: {files:?}");
        }
    }
}

/// A runner that compiles nothing: it waits to be cancelled (up to a minute), counting runs.
struct Waiting {
    runs: std::sync::Arc<std::sync::atomic::AtomicUsize>,
    cancelled: std::sync::Arc<std::sync::atomic::AtomicUsize>,
}
impl scribyra_compile::Runner for Waiting {
    fn run(&self, _: &scribyra_compile::Job, _: &scribyra_compile::Limits, cancel: &scribyra_compile::Cancel) -> scribyra_compile::Outcome {
        use std::sync::atomic::Ordering::SeqCst;
        self.runs.fetch_add(1, SeqCst);
        let deadline = Instant::now() + Duration::from_secs(60);
        while !cancel.is_cancelled() && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(20));
        }
        if cancel.is_cancelled() {
            self.cancelled.fetch_add(1, SeqCst);
        }
        scribyra_compile::Outcome { status: scribyra_compile::Status::Cancelled, pdf: None, log: String::new(), cpu_ms: 0, passes: 0, peak_memory: 0 }
    }
    fn texlive_id(&self) -> &str {
        "waiting"
    }
}

#[test]
fn a_worker_whose_heartbeats_keep_failing_stops_the_job() {
    // Review H1: heartbeat errors were ignored, so a worker cut off from the database compiled on
    // while the job could be handed to another worker. Here every heartbeat (and the reaper's
    // take-back) fails; the worker must cancel the sandbox once no heartbeat went through for
    // the heartbeat timeout less one interval (2 s here).
    let mut sr = start(Blobs::Fs, "server", false, json!({}), json!({}));
    let ana = sr.api(&sr.login("alice"));
    let (p, _) = paper(&ana, "Cut off", &hello("x"));
    assert_eq!(ana.compile(&p, None).status, 202);
    let db = sr.db();
    let (runtime, compiles) = library(&mut sr);
    postgres().psql(
        &db,
        "CREATE FUNCTION scribyra_test_down() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'unreachable'; END $$;
         CREATE TRIGGER scribyra_test_down BEFORE UPDATE ON compiles FOR EACH ROW WHEN (OLD.state = 'running' AND NEW.state IN ('running', 'queued')) EXECUTE FUNCTION scribyra_test_down();",
    );
    let (runs, cancelled) = (std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0)), std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0)));
    let runner = std::sync::Arc::new(Waiting { runs: runs.clone(), cancelled: cancelled.clone() });
    let (stop, shutdown) = tokio::sync::watch::channel(false);
    let worker = runtime.spawn(scribyra_sync::compiles::Worker::new(compiles, runner).run(shutdown, Duration::from_secs(1)));
    eventually("the job running", || runs.load(std::sync::atomic::Ordering::SeqCst) == 1);
    let t = Instant::now();
    while cancelled.load(std::sync::atomic::Ordering::SeqCst) == 0 {
        assert!(t.elapsed() < Duration::from_secs(10), "the sandbox kept running without heartbeats");
        std::thread::sleep(Duration::from_millis(50));
    }
    assert!(t.elapsed() >= Duration::from_millis(1500), "stopped before the timeout: {:?}", t.elapsed());
    // Nothing was stored for the abandoned run.
    assert_eq!(postgres().psql(&db, "SELECT count(*) FROM compiles WHERE outcome IS NOT NULL"), "0");
    stop.send_replace(true);
    runtime.block_on(worker).unwrap();
}

#[test]
fn one_member_or_owner_cannot_monopolise_the_queue_and_workers_take_requesters_in_turn() {
    // Review M1: one member could fill the whole queue, and workers took it first in first out.
    let mut sr = start(Blobs::Fs, "server", false, json!({}), json!({"active_per_member": 2, "active_per_owner": 2}));
    let (ana, ben) = (sr.api(&sr.login("alice")), sr.api(&sr.login("ben")));
    let ((p1, _), (p2, _), (p3, _)) = (paper(&ana, "One", &hello("1")), paper(&ana, "Two", &hello("2")), paper(&ana, "Three", &hello("3")));
    let (q1, _) = paper(&ben, "Ben's", &hello("b"));
    let j1 = ana.compile(&p1, None).json()["job"].as_str().unwrap().to_owned();
    let j2 = ana.compile(&p2, None).json()["job"].as_str().unwrap().to_owned();
    // Two of Ana's jobs wait: her third request is refused, though the queue has room.
    let busy = ana.compile(&p3, None);
    assert_eq!((busy.status, busy.header("retry-after")), (429, Some("60")), "{}", String::from_utf8_lossy(&busy.body));
    // Ben, editing a project Ana owns, is refused too: her projects have two jobs waiting.
    assert_eq!(ana.invite(&p3, "ben@example.org", "editor").status, 201);
    assert_eq!(ben.compile(&p3, None).status, 429);
    // His own project is his own count.
    let k1 = ben.compile(&q1, None);
    assert_eq!(k1.status, 202);
    let k1 = k1.json()["job"].as_str().unwrap().to_owned();
    // Workers take Ana's oldest, then Ben's (queued after both of hers), then Ana's next.
    let (runtime, compiles) = library(&mut sr);
    let order: Vec<String> = runtime.block_on(async {
        let mut order = Vec::new();
        while let Some(c) = compiles.claim().await.unwrap() {
            order.push(c.job);
        }
        order
    });
    assert_eq!(order, vec![j1, k1, j2]);
}

#[test]
fn requests_are_counted_before_the_project_is_materialised_whatever_they_answer() {
    // Review M2: every request replayed the whole project before any limit, and answers that
    // queued nothing (cached, existing, errors) were never counted.
    let sr = start(Blobs::Fs, "server", false, json!({}), json!({"per_member_per_hour": 2, "per_project_per_minute": 3}));
    let (ana, ben, cat, dan) = (sr.api(&sr.login("alice")), sr.api(&sr.login("ben")), sr.api(&sr.login("cat")), sr.api(&sr.login("dan")));
    let notes = ana.create("No main file");
    assert_eq!(ana.append(&notes, "a", 1, &Project::new().add_text("f1", "notes.tex", None, "x")).status, 201);
    assert_eq!(ana.compile(&notes, None).status, 400);
    assert_eq!(ana.compile(&notes, None).status, 400);
    let limited = ana.compile(&notes, None);
    assert_eq!((limited.status, limited.header("retry-after")), (429, Some("60")));
    // Per project, from all its members together: queued, then the same files twice.
    let (p, _) = paper(&ben, "Busy", &hello("x"));
    for who in ["cat", "dan"] {
        assert_eq!(ben.invite(&p, &format!("{who}@example.org"), "editor").status, 201);
    }
    assert_eq!(ben.compile(&p, None).status, 202);
    assert_eq!(ben.compile(&p, None).status, 200);
    assert_eq!(cat.compile(&p, None).status, 200);
    assert_eq!(dan.compile(&p, None).status, 429);
    // Refused requests are not recorded.
    assert_eq!(postgres().psql(&sr.db(), "SELECT count(*) FROM compile_requests"), "5");
}

#[test]
fn asset_sizes_are_checked_before_any_asset_is_read() {
    // Review M3: the worker read every asset into memory before the input size check. Here the
    // asset's recorded size (200 MiB) is over the limit: the job is refused without reading it.
    // Its blob is removed, so reading it first would fail differently.
    let mut sr = start(Blobs::Fs, "server", false, json!({}), json!({}));
    let ana = sr.api(&sr.login("alice"));
    let (p, doc) = paper(&ana, "Huge figure", &hello("\\includegraphics{figure.png}"));
    let figure = b"small figure bytes".to_vec();
    assert_eq!(ana.put_object(&p, &figure).status, 201);
    let update = {
        use yrs::{Map, Transact};
        let (files, assets) = (doc.doc.get_or_insert_map("files"), doc.doc.get_or_insert_map("assets"));
        let mut txn = doc.doc.transact_mut();
        let node = yrs::Any::from(std::collections::HashMap::from([("id".to_owned(), yrs::Any::from("a1")), ("name".to_owned(), yrs::Any::from("figure.png")), ("parentId".to_owned(), yrs::Any::Null), ("binary".to_owned(), yrs::Any::Bool(true)), ("folder".to_owned(), yrs::Any::Bool(false))]));
        files.insert(&mut txn, "a1", node);
        let record = yrs::Any::from(std::collections::HashMap::from([("hash".to_owned(), yrs::Any::from(sha256(&figure))), ("size".to_owned(), yrs::Any::Number((200u64 << 20) as f64))]));
        assets.insert(&mut txn, "a1", record);
        txn.encode_update_v1()
    };
    assert_eq!(ana.append(&p, "a", 3, &update).status, 201);
    assert_eq!(ana.compile(&p, None).status, 202);
    let db = sr.db();
    let blob = postgres().psql(&db, &format!("SELECT blob FROM sr_objects WHERE project = '{p}'"));
    let data = sr.env.service.dir.join("data");
    let (runtime, compiles) = library(&mut sr);
    std::fs::remove_file(data.join(&blob)).unwrap();
    runtime.block_on(async {
        let claimed = compiles.claim().await.unwrap().unwrap();
        let refused = compiles.prepare(&claimed).await.err().expect("refused");
        assert_eq!((refused.outcome.as_str(), refused.error), ("rejected", Some("the project's files are too large to compile on the server")));
        // The recorded size (plus the main file) is what was refused.
        assert!(refused.log.as_deref().unwrap().contains(&format!("at least {}", (200u64 << 20) / 100)), "{:?}", refused.log);
    });
}

#[test]
fn concurrent_requests_across_projects_never_pass_the_member_rate() {
    // Review L1: the rate was counted and recorded without a lock, so requests on several
    // projects at once could all pass it.
    let sr = start(Blobs::Fs, "server", false, json!({}), json!({"per_member_per_hour": 3, "active_per_member": 100, "active_per_owner": 100, "queue": 100}));
    let ana = sr.api(&sr.login("alice"));
    let projects: Vec<String> = (0..12).map(|i| paper(&ana, &format!("P{i}"), &hello(&i.to_string())).0).collect();
    let barrier = std::sync::Arc::new(std::sync::Barrier::new(projects.len()));
    let statuses: Vec<u16> = std::thread::scope(|s| {
        let handles: Vec<_> = projects
            .iter()
            .map(|p| {
                let (ana, barrier) = (&ana, barrier.clone());
                s.spawn(move || {
                    barrier.wait();
                    ana.compile(p, None).status
                })
            })
            .collect();
        handles.into_iter().map(|h| h.join().unwrap()).collect()
    });
    assert_eq!(statuses.iter().filter(|s| **s != 429).count(), 3, "{statuses:?}");
    assert_eq!(postgres().psql(&sr.db(), "SELECT count(*) FROM compile_requests"), "3");
}

#[test]
fn guests_cannot_change_where_a_project_compiles() {
    // Review L2: a guest editor could switch the compile mode, though guests may not share.
    let mut users = people();
    users.as_array_mut().unwrap().push(json!({"sub": "sub-gus", "username": "gus", "password": "pw-gus", "email": "gus@partner.org", "email_verified": true, "name": "Gus", "roles": [MEMBER], "claims": {"acct": "1"}}));
    let mut d = deployment("both", json!({}));
    d["guests"] = json!("shared");
    d["provider"] = json!({"claims": {"roles": "$.roles", "guest": {"path": "$.acct", "equals": "1"}}});
    let sr = Sr::start(Blobs::Fs, users, json!({"compile_heartbeat_seconds": 1, "compile_heartbeat_timeout_seconds": 3}), d);
    let (ana, gus) = (sr.api(&sr.login("alice")), sr.api(&sr.login("gus")));
    let (p, _) = paper(&ana, "Guest edited", &hello("x"));
    assert_eq!(ana.invite_guest(&p, "gus@partner.org", "editor").status, 201);
    assert_eq!(gus.append(&p, "g", 1, &Project::new().add_text("f2", "more.tex", None, "y")).status, 201);
    let settings = format!("/v1/sr/projects/{p}/settings");
    assert_eq!(gus.call("PUT", &settings, Some(json!({"compile": "server"}))).status, 403);
    assert_eq!(ana.details(&p).json()["compile"], "browser");
    assert_eq!(ana.call("PUT", &settings, Some(json!({"compile": "server"}))).status, 200);
}

#[test]
fn finished_rows_are_removed_after_the_retention_period_except_the_ones_still_in_use() {
    // Review L3: `compiles` rows (requester, times, digest) were kept until the project went.
    let mut sr = start(Blobs::Fs, "server", false, json!({}), json!({"retention_days": 30}));
    let ana = sr.api(&sr.login("alice"));
    let ((p, _), (q, _)) = (paper(&ana, "Old jobs", &hello("p")), paper(&ana, "One old job", &hello("q")));
    let me = account(&sr, "alice");
    let row = |project: &str, state: &str, days: i64, pdf: bool| {
        let job = random_hex(32);
        postgres().psql(
            &sr.db(),
            &format!(
                "INSERT INTO compiles (job, project, seq, content_hash, engine, texlive, requested_by, state, queued, finished, outcome, pdf_blob, pdf_size)
                 VALUES ('{job}', '{project}', 1, '{}', 'pdflatex', 'tl', '{me}', '{state}', now() - interval '{days} days', now() - interval '{days} days', 'x', {}, {})",
                random_hex(32),
                if pdf { format!("'sr/{project}/c/{job}-pdf'") } else { "NULL".into() },
                if pdf { "1" } else { "NULL" },
            ),
        );
        job
    };
    let (gone, replaced, kept_pdf, recent) = (row(&p, "failed", 100, false), row(&p, "replaced", 99, false), row(&p, "done", 98, true), row(&p, "failed", 10, false));
    let latest = row(&q, "failed", 200, false);
    // The first maintenance after a start sweeps.
    sr.env.service.stop();
    sr.env.service.start().unwrap();
    eventually("old rows removed", || postgres().psql(&sr.db(), &format!("SELECT count(*) FROM compiles WHERE job IN ('{gone}', '{replaced}')")) == "0");
    for job in [kept_pdf, recent, latest] {
        assert_eq!(postgres().psql(&sr.db(), &format!("SELECT count(*) FROM compiles WHERE job = '{job}'")), "1");
    }
}

/// The WebAssembly engine's compile runtime, assembled once for this test binary.
fn wasm_runtime() -> std::path::PathBuf {
    static R: std::sync::OnceLock<std::path::PathBuf> = std::sync::OnceLock::new();
    R.get_or_init(|| {
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../..").canonicalize().unwrap();
        let out = root.join("target/wasm-compile-runtime-sync");
        let s = std::process::Command::new("node").arg("scripts/wasm-compile-runtime.mjs").arg(&out).arg("--link").current_dir(&root).stdout(std::process::Stdio::null()).status().unwrap();
        assert!(s.success(), "assembling the compile runtime (needs `npm run wasm` and the compiler assets)");
        out
    })
    .clone()
}

#[test]
fn the_webassembly_engine_is_the_default_and_compiles_like_the_browser() {
    let cache = std::env::temp_dir().join(format!("scribyra-tex-cache-{}", random_hex(8)));
    std::fs::create_dir_all(&cache).unwrap();
    // Bundled packages only: no mirror, so nothing leaves this host.
    let service = json!({"compile_runtime": wasm_runtime(), "compile_cache": cache});
    let limits = json!({"cpu_seconds": 50, "wall_seconds": 120, "memory_mib": 2048});
    let mut d = json!({"cpu_seconds": 10, "wall_seconds": 40, "memory_mib": 1536, "scratch_mib": 64, "output_mib": 16, "passes": 4, "concurrency": 2, "queue": 32, "per_member_per_hour": 120});
    for (k, v) in limits.as_object().unwrap() {
        d[k] = v.clone();
    }
    let mut s = json!({"compile_heartbeat_seconds": 1, "compile_heartbeat_timeout_seconds": 3});
    for (k, v) in service.as_object().unwrap() {
        s[k] = v.clone();
    }
    let sr = Sr::start(Blobs::S3, people(), s, json!({"compile": "server", "tex_mirror": "", "compile_limits": d}));
    let metrics_port = free_port();
    let worker = sr.worker(json!({"metrics_bind": format!("127.0.0.1:{metrics_port}")}));
    assert!(worker.logs.lock().unwrap().contains("\"texlive\":\"wasm-"), "{}", worker.logs.lock().unwrap());
    let (ana, ben) = (sr.api(&sr.login("alice")), sr.api(&sr.login("ben")));
    // Biber and a bundled package (biblatex) from the cache, cross-references, two files.
    let main = "\\documentclass{article}\n\\usepackage[backend=biber]{biblatex}\n\\addbibresource{refs.bib}\n\\begin{document}\n\\section{One}\\label{s:one}See~\\ref{s:one} and \\textcite{knuth84}.\n\\printbibliography\n\\end{document}\n";
    let (p, doc) = paper(&ana, "Same everywhere", main);
    assert_eq!(ana.append(&p, "a", 3, &doc.add_text("f2", "refs.bib", None, "@book{knuth84, author = {Donald E. Knuth}, title = {The {\\TeX}book}, publisher = {Addison-Wesley}, year = {1984}}\n")).status, 201);
    assert_eq!(ana.invite(&p, "ben@example.org", "viewer").status, 201);
    let job = ana.compile(&p, None).json()["job"].as_str().unwrap().to_owned();
    let status = ana.compiled(&p, &job);
    let log = String::from_utf8_lossy(&ana.call("GET", &format!("/v1/sr/projects/{p}/compile/log"), None).body).into_owned();
    assert_eq!(status["job"]["outcome"], "success", "{status}\n{log}");
    // The browser's engine is LuaLaTeX whatever the project's meta.engine says.
    assert_eq!(status["pdf"]["engine"], "lualatex");
    assert!(status["texlive"].as_str().unwrap().starts_with("wasm-"), "{status}");
    assert!(log.contains("luahblatex") && log.contains("biber") && log.contains("TeX packages installed for this compile:"), "{log}");
    let got = ben.call("GET", &format!("/v1/sr/projects/{p}/compile/pdf"), None);
    assert!(got.status == 200 && got.body.starts_with(b"%PDF-"));
    assert!(std::fs::read_dir(&cache).unwrap().count() >= 1, "bundled archives went through the cache");
    // An error names its file and line.
    let (bad, bdoc) = paper(&ana, "Broken", "\\documentclass{article}\n\\begin{document}\n\\input{ch/one}\n\\end{document}\n");
    assert_eq!(ana.append(&bad, "a", 3, &bdoc.add_text("f2", "ch/one.tex", None, "Text.\n\\nosuchmacro\n")).status, 201);
    let job = ana.compile(&bad, None).json()["job"].as_str().unwrap().to_owned();
    assert_eq!(ana.compiled(&bad, &job)["job"]["outcome"], "tex_error");
    let log = String::from_utf8_lossy(&ana.call("GET", &format!("/v1/sr/projects/{bad}/compile/log"), None).body).into_owned();
    assert!(log.starts_with("Diagnostics:\nch/one.tex:2: Undefined control sequence."), "{log}");
    // A runaway document ends at the CPU limit and the worker stays ready.
    let (endless_p, _) = paper(&ana, "Endless", &endless(&format!("scribyra-pwned-{}", random_hex(8))));
    let job = ana.compile(&endless_p, None).json()["job"].as_str().unwrap().to_owned();
    assert_eq!(ana.compiled(&endless_p, &job)["job"]["outcome"], "limit_cpu");
    assert_eq!(status_of(&format!("{}/readyz", worker.url)), 200);
    // The worker's metrics count the package cache's work, naming no package or project.
    let text = support::sso::fetch(&format!("http://127.0.0.1:{metrics_port}/metrics"), None).body;
    assert!(text.contains("scribyra_compile_package_requests_total{result=\"bundled\"}") && !text.contains("scribyra_compile_package_requests_total{result=\"bundled\"} 0"), "{text}");
    assert!(text.contains("scribyra_compile_jobs_total{outcome=\"success\"} 1") && !text.contains(&p) && !text.contains("biblatex"), "{text}");
    let _ = std::fs::remove_dir_all(&cache);
}
