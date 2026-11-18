//! Real PostgreSQL and Garage for integration tests, from the Nix dev shell.
//!
//! One PostgreSQL cluster and one Garage node are started lazily per test binary and shared by
//! its tests: call [`postgres()`] / [`garage()`]. Each test takes a fresh database
//! ([`Postgres::database`]) and a fresh bucket ([`Garage::bucket`]). Every server runs under a
//! small watchdog shell that stops it by PID and removes its temporary directory as soon as the
//! test process exits (normally, by panic or by signal).
#![allow(dead_code)]
pub mod orgs;
pub mod sr;
pub mod sso;
use scribyra_sync::blobs::S3Settings;
use std::{
    io::{BufRead, BufReader, Read, Write},
    net::{TcpListener, TcpStream},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{
        OnceLock,
        atomic::{AtomicU64, Ordering},
    },
    time::{Duration, Instant},
};

pub fn random_hex(bytes: usize) -> String {
    let mut buffer = vec![0; bytes];
    std::fs::File::open("/dev/urandom")
        .unwrap()
        .read_exact(&mut buffer)
        .unwrap();
    buffer.iter().map(|b| format!("{b:02x}")).collect()
}
pub fn random_bytes(len: usize) -> Vec<u8> {
    let mut buffer = vec![0; len];
    std::fs::File::open("/dev/urandom")
        .unwrap()
        .read_exact(&mut buffer)
        .unwrap();
    buffer
}
pub fn sha256(bytes: &[u8]) -> String {
    scribyra_core::blob::hash(bytes)
}
fn unique() -> String {
    static N: AtomicU64 = AtomicU64::new(0);
    format!(
        "{}_{}",
        std::process::id(),
        N.fetch_add(1, Ordering::Relaxed)
    )
}
pub fn free_port() -> u16 {
    TcpListener::bind("127.0.0.1:0")
        .unwrap()
        .local_addr()
        .unwrap()
        .port()
}
fn require(binary: &str) {
    let found = std::env::var_os("PATH")
        .map(|paths| std::env::split_paths(&paths).any(|dir| dir.join(binary).is_file()))
        .unwrap_or(false);
    assert!(
        found,
        "`{binary}` is not on PATH: run the tests inside the dev shell \
         (`nix develop -c cargo test -p scribyra-sync`), which provides postgresql_17 and garage"
    );
}
/// A private temporary directory (removed by the watchdog, or by [`TempDir::drop`]).
pub fn temp_dir(prefix: &str) -> PathBuf {
    tempfile::Builder::new()
        .prefix(prefix)
        .tempdir()
        .unwrap()
        .keep()
}
fn run(command: &mut Command) -> String {
    let output = command.stdin(Stdio::null()).output().unwrap();
    assert!(
        output.status.success(),
        "{:?} failed: {}{}",
        command,
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8(output.stdout).unwrap()
}
const WATCHDOG: &str = r#"owner=$1; dir=$2; sig=$3; shift 3
"$@" >"$dir/server.log" 2>&1 &
child=$!
while kill -0 "$owner" 2>/dev/null && kill -0 "$child" 2>/dev/null; do sleep 0.2; done
kill -"$sig" "$child" 2>/dev/null; wait "$child"; rm -rf "$dir""#;
/// Start `program` under a watchdog bound to this test process. The watchdog stops the server
/// with `signal` and deletes `dir` once this process is gone.
fn supervise(dir: &Path, signal: &str, program: &[&str]) -> Child {
    Command::new("sh")
        .arg("-c")
        .arg(WATCHDOG)
        .arg("sh")
        .arg(std::process::id().to_string())
        .arg(dir)
        .arg(signal)
        .args(program)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .unwrap()
}
fn wait_until(what: &str, dir: &Path, mut ready: impl FnMut() -> bool) {
    let deadline = Instant::now() + Duration::from_secs(30);
    while !ready() {
        if Instant::now() > deadline {
            let log = std::fs::read_to_string(dir.join("server.log")).unwrap_or_default();
            panic!("{what} did not become ready: {log}");
        }
        std::thread::sleep(Duration::from_millis(50));
    }
}

pub struct Postgres {
    pub dir: PathBuf,
    pub port: u16,
    _watchdog: Child,
}
static POSTGRES: OnceLock<Postgres> = OnceLock::new();
/// The shared PostgreSQL cluster (trust authentication, user `postgres`), listening on
/// `127.0.0.1:<port>` and on a unix socket in [`Postgres::dir`].
pub fn postgres() -> &'static Postgres {
    POSTGRES.get_or_init(|| {
        for binary in ["initdb", "postgres", "pg_isready", "psql", "createdb"] {
            require(binary);
        }
        let dir = temp_dir("scribyra-pg-");
        let data = dir.join("data");
        run(Command::new("initdb")
            .arg("-D")
            .arg(&data)
            .args(["-U", "postgres", "-A", "trust", "-E", "UTF8", "--locale=C"])
            .args(["--no-sync", "--no-instructions"]));
        let port = free_port();
        let (port_s, data_s, dir_s) = (
            port.to_string(),
            data.to_str().unwrap().to_owned(),
            dir.to_str().unwrap().to_owned(),
        );
        let watchdog = supervise(
            &dir,
            "INT",
            &[
                "postgres",
                "-D",
                &data_s,
                "-p",
                &port_s,
                "-k",
                &dir_s,
                "-c",
                "listen_addresses=127.0.0.1",
                "-c",
                "fsync=off",
                "-c",
                "max_connections=300",
                "-c",
                "full_page_writes=off",
            ],
        );
        let pg = Postgres {
            dir,
            port,
            _watchdog: watchdog,
        };
        wait_until("PostgreSQL", &pg.dir, || {
            Command::new("pg_isready")
                .args(["-q", "-h", "127.0.0.1", "-p", &port_s])
                .status()
                .is_ok_and(|s| s.success())
        });
        pg
    })
}
impl Postgres {
    /// Create a fresh, empty database and return its TCP URL.
    pub fn database(&self) -> String {
        let name = format!("t_{}", unique());
        run(Command::new("createdb")
            .args(["-h", "127.0.0.1", "-U", "postgres", "-p"])
            .arg(self.port.to_string())
            .arg(&name));
        self.url(&name)
    }
    pub fn url(&self, name: &str) -> String {
        format!("postgres://postgres@127.0.0.1:{}/{name}", self.port)
    }
    /// The same database over the cluster's unix socket.
    pub fn socket_url(&self, url: &str) -> String {
        let name = url.rsplit('/').next().unwrap();
        format!(
            "postgres:///{name}?host={}&port={}&user=postgres",
            self.dir.display(),
            self.port
        )
    }
    /// Run SQL with `psql` against a database URL and return its unaligned output.
    pub fn psql(&self, url: &str, sql: &str) -> String {
        run(Command::new("psql").args([
            "-X",
            "-q",
            "-A",
            "-t",
            "-v",
            "ON_ERROR_STOP=1",
            url,
            "-c",
            sql,
        ]))
        .trim()
        .to_owned()
    }
}

pub struct Garage {
    pub dir: PathBuf,
    pub endpoint: String,
    pub key_id: String,
    /// File holding the secret access key, as the service configuration expects.
    pub secret_file: PathBuf,
    secret: String,
    config: PathBuf,
    _watchdog: Child,
}
static GARAGE: OnceLock<Garage> = OnceLock::new();
/// The shared single-node Garage instance with one access key allowed on every test bucket.
pub fn garage() -> &'static Garage {
    GARAGE.get_or_init(|| {
        require("garage");
        let dir = temp_dir("scribyra-garage-");
        let (rpc, s3, admin) = (free_port(), free_port(), free_port());
        let config = dir.join("garage.toml");
        std::fs::write(
            &config,
            format!(
                r#"metadata_dir = "{dir}/meta"
data_dir = "{dir}/data"
db_engine = "sqlite"
metadata_fsync = false
data_fsync = false
replication_factor = 1
rpc_bind_addr = "127.0.0.1:{rpc}"
rpc_public_addr = "127.0.0.1:{rpc}"
rpc_secret = "{secret}"
[s3_api]
s3_region = "garage"
api_bind_addr = "127.0.0.1:{s3}"
root_domain = ".s3.garage.localhost"
[admin]
api_bind_addr = "127.0.0.1:{admin}"
"#,
                dir = dir.display(),
                secret = random_hex(32),
            ),
        )
        .unwrap();
        let config_s = config.to_str().unwrap().to_owned();
        let watchdog = supervise(&dir, "TERM", &["garage", "-c", &config_s, "server"]);
        let garage_cmd = || {
            let mut c = Command::new("garage");
            c.arg("-c").arg(&config);
            c
        };
        wait_until("Garage", &dir, || {
            garage_cmd()
                .arg("status")
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status()
                .is_ok_and(|s| s.success())
        });
        let node = run(garage_cmd().args(["node", "id", "-q"]));
        let node = node.trim().split('@').next().unwrap().to_owned();
        run(garage_cmd().args(["layout", "assign", "-z", "dc1", "-c", "1G", &node]));
        run(garage_cmd().args(["layout", "apply", "--version", "1"]));
        let key_id = format!("GK{}", random_hex(12));
        let secret = random_hex(32);
        run(garage_cmd().args(["key", "import", "--yes", "-n", "tests", &key_id, &secret]));
        let secret_file = dir.join("s3-secret");
        std::fs::write(&secret_file, format!("{secret}\n")).unwrap();
        Garage {
            dir,
            endpoint: format!("http://127.0.0.1:{s3}"),
            key_id,
            secret_file,
            secret,
            config,
            _watchdog: watchdog,
        }
    })
}
impl Garage {
    /// Create a fresh bucket that the test key can read and write; returns its settings.
    pub fn bucket(&self) -> S3Settings {
        let name = format!("t-{}", unique().replace('_', "-"));
        let garage = |args: &[&str]| {
            run(Command::new("garage")
                .arg("-c")
                .arg(&self.config)
                .args(args))
        };
        garage(&["bucket", "create", &name]);
        garage(&[
            "bucket",
            "allow",
            "--read",
            "--write",
            "--owner",
            &name,
            "--key",
            &self.key_id,
        ]);
        S3Settings {
            endpoint: self.endpoint.clone(),
            region: "garage".into(),
            bucket: name,
            access_key_id: self.key_id.clone(),
            secret_access_key: self.secret.clone(),
            path_style: true,
        }
    }
    /// Service configuration fields for a fresh bucket.
    pub fn config(&self) -> serde_json::Value {
        let bucket = self.bucket();
        serde_json::json!({
            "blob_store": "s3",
            "s3_endpoint": bucket.endpoint,
            "s3_region": bucket.region,
            "s3_bucket": bucket.bucket,
            "s3_access_key_id": bucket.access_key_id,
            "s3_secret_access_key_file": self.secret_file,
            "s3_path_style": true,
        })
    }
}

/// The real `scribyra-sync` binary with a private directory and configuration file.
pub struct Service {
    pub dir: PathBuf,
    pub config_path: PathBuf,
    pub config: serde_json::Value,
    pub bearer: String,
    pub namespace: String,
    pub url: String,
    pub logs: std::sync::Arc<std::sync::Mutex<String>>,
    child: Option<Child>,
}
pub const BINARY: &str = env!("CARGO_BIN_EXE_scribyra-sync");
impl Service {
    /// Default principal with storage and relay rights; `overrides` are merged into the config.
    /// The database is fresh; blobs default to `<dir>/data` on the filesystem.
    pub fn new(overrides: serde_json::Value) -> Self {
        let mut service = Self::configure(overrides);
        service.start().unwrap();
        service
    }
    /// Like [`Service::new`] but without starting the process.
    pub fn configure(overrides: serde_json::Value) -> Self {
        let dir = temp_dir("scribyra-service-");
        let (bearer, namespace) = (random_hex(32), random_hex(32));
        let mut config = serde_json::json!({
            "bind": "127.0.0.1:0",
            "data": dir.join("data"),
            "database_url": postgres().database(),
            "principals": [{"token_hash": sha256(bearer.as_bytes()), "namespace": namespace, "storage": true, "relay": true}],
        });
        for (k, v) in overrides.as_object().unwrap() {
            config[k] = v.clone();
        }
        let config_path = dir.join("config.json");
        std::fs::write(&config_path, config.to_string()).unwrap();
        Self {
            dir,
            config_path,
            config,
            bearer,
            namespace,
            url: String::new(),
            logs: Default::default(),
            child: None,
        }
    }
    /// Rewrite the configuration file (takes effect on the next start or command).
    pub fn reconfigure(&mut self, overrides: serde_json::Value) {
        for (k, v) in overrides.as_object().unwrap() {
            self.config[k] = v.clone();
        }
        std::fs::write(&self.config_path, self.config.to_string()).unwrap();
    }
    /// Run a subcommand to completion; returns (exit code, stdout).
    pub fn run(&self, args: &[&str]) -> (i32, String) {
        let output = self.command(args).output().unwrap();
        (
            output.status.code().unwrap_or(-1),
            String::from_utf8_lossy(&output.stdout).into_owned(),
        )
    }
    pub fn command(&self, args: &[&str]) -> Command {
        let mut command = Command::new(BINARY);
        command
            .args(args)
            .env("SCRIBYRA_SERVICE_CONFIG", &self.config_path)
            .stdin(Stdio::null());
        command
    }
    /// Start the service; `Err` carries the exit status and output if it did not start.
    pub fn start(&mut self) -> Result<(), String> {
        let mut child = self
            .command(&[])
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        let stdout = BufReader::new(child.stdout.take().unwrap());
        let (tx, rx) = std::sync::mpsc::channel();
        let logs = self.logs.clone();
        std::thread::spawn(move || {
            for line in stdout.lines().map_while(Result::ok) {
                logs.lock().unwrap().push_str(&(line.clone() + "\n"));
                if let Ok(event) = serde_json::from_str::<serde_json::Value>(&line)
                    && event["event"] == "listening"
                {
                    let _ = tx.send(event["address"].as_str().unwrap().to_owned());
                }
            }
        });
        let mut stderr = child.stderr.take().unwrap();
        let logs = self.logs.clone();
        std::thread::spawn(move || {
            let mut text = String::new();
            let _ = stderr.read_to_string(&mut text);
            logs.lock().unwrap().push_str(&text);
        });
        match rx.recv_timeout(Duration::from_secs(20)) {
            Ok(address) => {
                self.url = format!("http://{address}");
                self.child = Some(child);
                Ok(())
            }
            Err(_) => {
                let _ = child.kill();
                let status = child.wait().unwrap();
                Err(format!("{status}: {}", self.logs.lock().unwrap()))
            }
        }
    }
    pub fn pid(&self) -> u32 {
        self.child.as_ref().unwrap().id()
    }
    /// Stop with SIGTERM and wait.
    pub fn stop(&mut self) {
        if let Some(mut child) = self.child.take() {
            let _ = Command::new("kill")
                .args(["-TERM", &child.id().to_string()])
                .status();
            child.wait().unwrap();
        }
    }
    /// SIGTERM; returns the exit status.
    pub fn terminate(&mut self) -> std::process::ExitStatus {
        let mut child = self.child.take().expect("running");
        let _ = Command::new("kill").args(["-TERM", &child.id().to_string()]).status();
        child.wait().unwrap()
    }
    /// SIGKILL and wait.
    pub fn kill(&mut self) {
        if let Some(mut child) = self.child.take() {
            let _ = child.kill();
            child.wait().unwrap();
        }
    }
    pub fn object_url(&self, bytes: &[u8]) -> String {
        self.object_url_in(&self.namespace, bytes)
    }
    pub fn object_url_in(&self, namespace: &str, bytes: &[u8]) -> String {
        format!("{}/v1/objects/{namespace}/{}", self.url, sha256(bytes))
    }
    pub fn put(&self, bytes: &[u8]) -> u16 {
        put(&self.object_url(bytes), &self.bearer, bytes)
    }
    pub fn get(&self, bytes: &[u8]) -> (u16, Vec<u8>) {
        get(&self.object_url(bytes), &self.bearer)
    }
    pub fn database_url(&self) -> &str {
        self.config["database_url"].as_str().unwrap()
    }
}
impl Drop for Service {
    fn drop(&mut self) {
        self.kill();
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

fn agent() -> ureq::Agent {
    ureq::Agent::config_builder()
        .http_status_as_error(false)
        .timeout_global(Some(Duration::from_secs(30)))
        .build()
        .into()
}
pub fn put(url: &str, bearer: &str, bytes: &[u8]) -> u16 {
    agent()
        .put(url)
        .header("authorization", &format!("Bearer {bearer}"))
        .header("content-type", "application/octet-stream")
        .send(bytes)
        .map(|r| r.status().as_u16())
        .unwrap_or(0)
}
pub fn get(url: &str, bearer: &str) -> (u16, Vec<u8>) {
    let mut response = agent()
        .get(url)
        .header("authorization", &format!("Bearer {bearer}"))
        .call()
        .unwrap();
    let status = response.status().as_u16();
    (
        status,
        response.body_mut().read_to_vec().unwrap_or_default(),
    )
}
pub fn status(url: &str) -> u16 {
    agent()
        .get(url)
        .call()
        .map(|r| r.status().as_u16())
        .unwrap_or(0)
}
/// Send headers and only part of a PUT body over a raw socket; returns the open socket.
pub fn partial_put(service: &Service, bytes: &[u8], sent: usize) -> TcpStream {
    let url = url::Url::parse(&service.object_url(bytes)).unwrap();
    let mut socket = TcpStream::connect(("127.0.0.1", url.port().unwrap())).unwrap();
    write!(
        socket,
        "PUT {} HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer {}\r\nContent-Length: {}\r\n\r\n",
        url.path(),
        service.bearer,
        bytes.len()
    )
    .unwrap();
    socket.write_all(&bytes[..sent]).unwrap();
    socket.flush().unwrap();
    socket
}
