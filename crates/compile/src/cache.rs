//! The server's TeX package cache for the WebAssembly engine. Jobs read package archives from
//! it read-only (`/cache` in the sandbox); only the worker writes it, outside the sandbox, when
//! a job asks for a package its document is missing. Entries are content-addressed
//! (`<sha512>.tar.xz`) and every archive is checked against the SHA-512 and size the compile
//! runtime's pinned catalog gives for that package name, both when it is written and whenever a
//! job asks for it again (a damaged or tampered entry is removed and fetched again from its
//! source, or refused). Inside the sandbox the catalog checks each archive a third time before
//! it is unpacked.
//!
//! Sources, as in the browser: the runtime's bundled archives (`components/<sha512>.tar.xz`,
//! the distribution's components and the static support archives) and, for other TeX Live
//! packages, the configured mirror (`<mirror>/archive/<name>.tar.xz`).

use scribyra_core::packages::{metadata_bucket, Catalog, Package, Source, MAX_ARCHIVE};
use sha2::{Digest, Sha256, Sha512};
use std::collections::{BTreeMap, HashMap};
use std::fs;
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant, SystemTime};

/// What a job may ask the worker for: one package archive put into the cache by name.
pub trait Packages: Send + Sync {
  /// Makes `<cache>/<sha512>.tar.xz` hold the verified archive of package `name`; returns the
  /// bytes newly written (0 when it was there already), which count against the job's budget.
  fn fill(&self, name: &str) -> Result<u64, String>;
}

/// How the cache answered, for `/metrics`.
#[derive(Debug, Default)]
pub struct CacheStats { pub hits: AtomicU64, pub bundled: AtomicU64, pub mirror: AtomicU64, pub rejected: AtomicU64, pub failed: AtomicU64, pub fill_ms: AtomicU64 }

/// Fills running at once in one worker, whatever the number of jobs.
const MAX_FILLS: usize = 4;

#[derive(serde::Deserialize)]
struct Pin { path: String, sha256: String, size: u64 }

pub struct PackageCache {
  dir: PathBuf,
  assets: PathBuf,
  mirror: Option<String>,
  shards: BTreeMap<String, Pin>,
  snapshot: String,
  loaded: Mutex<HashMap<String, Catalog>>,
  agent: Option<ureq::Agent>,
  /// One fill per entry at a time (concurrent jobs wanting the same package wait for one fetch).
  entries: Mutex<HashMap<String, Arc<Mutex<()>>>>,
  running: (Mutex<usize>, Condvar),
  /// Entries verified since this worker started, by (size, inode, mtime): not hashed again.
  verified: Mutex<HashMap<String, (u64, u64, i64, i64)>>,
  pub stats: CacheStats,
}

fn sha256_hex(b: &[u8]) -> String { format!("{:x}", Sha256::digest(b)) }
fn sha512_hex(b: &[u8]) -> String { format!("{:x}", Sha512::digest(b)) }
fn bad(m: impl Into<String>) -> io::Error { io::Error::new(io::ErrorKind::InvalidData, m.into()) }
fn valid_name(n: &str) -> bool { !n.is_empty() && n.len() <= 128 && n.bytes().all(|c| c.is_ascii_alphanumeric() || b"._-".contains(&c)) && !n.starts_with('.') }

impl PackageCache {
  /// `dir`: the cache directory (created if missing, writable by the worker only). `runtime`:
  /// the compile runtime (`scripts/wasm-compile-runtime.mjs`), whose pinned catalog decides what
  /// every package's archive must be. `mirror`: a TeX Live archive mirror, or `None` for bundled
  /// packages only.
  pub fn open(dir: impl Into<PathBuf>, runtime: &Path, mirror: Option<String>) -> io::Result<PackageCache> {
    let dir = dir.into();
    fs::create_dir_all(&dir)?;
    let assets = runtime.join("public/core/busytex");
    let manifest: serde_json::Value = serde_json::from_slice(&fs::read(assets.join("lualatex-manifest.json"))?).map_err(|e| bad(e.to_string()))?;
    let root_pin: Pin = serde_json::from_value(manifest["metadata"].clone()).map_err(|e| bad(format!("runtime manifest: {e}")))?;
    let root_bytes = read_pinned(&assets, &root_pin, 256 << 10)?;
    let root: serde_json::Value = serde_json::from_slice(&root_bytes).map_err(|e| bad(e.to_string()))?;
    let shards: BTreeMap<String, Pin> = serde_json::from_value(root["packages"].clone()).map_err(|e| bad(format!("catalog shards: {e}")))?;
    if shards.len() > 256 || shards.iter().any(|(b, p)| b.len() != 2 || p.path != format!("metadata/{}.json", p.sha256) || p.size > 2 << 20) { return Err(bad("invalid catalog shard map")); }
    let snapshot = root["snapshot"].as_str().ok_or_else(|| bad("catalog without snapshot"))?.to_string();
    let mut https_only = true;
    if let Some(m) = &mirror {
      let u = url::Url::parse(m).map_err(|_| bad("the TeX package mirror is not a URL"))?;
      let loopback = u.scheme() == "http" && matches!(u.host_str(), Some("127.0.0.1" | "localhost" | "[::1]"));
      if !(u.scheme() == "https" || loopback) || u.query().is_some() || u.fragment().is_some() || !u.username().is_empty() || u.password().is_some() {
        return Err(bad("the TeX package mirror must be an https URL (http only on loopback) without credentials or query"));
      }
      https_only = !loopback;
    }
    // No redirects: a mirror cannot send the worker to another host or scheme.
    let agent = mirror.as_ref().map(|_| ureq::Agent::config_builder().timeout_global(Some(Duration::from_secs(60))).max_redirects(0).https_only(https_only).http_status_as_error(false).build().into());
    // Temporary files a worker left when it died.
    for e in fs::read_dir(&dir)?.flatten() {
      let old = e.metadata().ok().and_then(|m| m.modified().ok()).and_then(|t| SystemTime::now().duration_since(t).ok()).is_some_and(|age| age > Duration::from_secs(3600));
      if e.file_name().to_string_lossy().starts_with(".tmp-") && old { let _ = fs::remove_file(e.path()); }
    }
    Ok(PackageCache { dir, assets, mirror: mirror.map(|m| m.trim_end_matches('/').to_string()), shards, snapshot, loaded: Mutex::default(), agent, entries: Mutex::default(), running: (Mutex::new(0), Condvar::new()), verified: Mutex::default(), stats: CacheStats::default() })
  }

  pub fn dir(&self) -> &Path { &self.dir }

  /// The pinned catalog entry for `name`.
  pub fn package(&self, name: &str) -> Result<Package, String> {
    if !valid_name(name) { return Err("invalid TeX package name".into()); }
    let bucket = metadata_bucket(name);
    let pin = self.shards.get(&bucket).ok_or_else(|| format!("{name} is not in the TeX package catalog"))?;
    let mut loaded = self.loaded.lock().unwrap();
    if !loaded.contains_key(&bucket) {
      let bytes = read_pinned(&self.assets, pin, 2 << 20).map_err(|e| e.to_string())?;
      let text = String::from_utf8(bytes).map_err(|_| "catalog shard is not UTF-8".to_string())?;
      let catalog = Catalog::new(&text)?;
      if catalog.snapshot != self.snapshot { return Err("catalog shard from another snapshot".into()); }
      loaded.insert(bucket.clone(), catalog);
    }
    loaded[&bucket].packages.get(name).cloned().ok_or_else(|| format!("{name} is not in the TeX package catalog"))
  }

  fn entry(&self, sha512: &str) -> PathBuf { self.dir.join(format!("{sha512}.tar.xz")) }

  fn verify(bytes: &[u8], p: &Package) -> bool { bytes.len() == p.size && sha512_hex(bytes) == p.sha512 }

  fn source(&self, name: &str, p: &Package) -> Result<Vec<u8>, String> {
    if p.size > MAX_ARCHIVE { return Err(format!("{name} exceeds the archive size limit")); }
    if p.origin == Source::Distribution || p.archive.is_some() {
      let path = self.assets.join("components").join(format!("{}.tar.xz", p.sha512));
      let bytes = fs::read(&path).map_err(|_| format!("the bundled archive of {name} is missing from the compile runtime"))?;
      self.stats.bundled.fetch_add(1, Ordering::Relaxed);
      return Ok(bytes);
    }
    let (Some(agent), Some(mirror)) = (&self.agent, &self.mirror) else { return Err(format!("{name} is not bundled and this server has no TeX package mirror")); };
    let url = format!("{mirror}/archive/{name}.tar.xz");
    // The details stay in the worker's log; members see only that the mirror failed.
    let unavailable = |why: String| { println!("{}", serde_json::json!({"event": "compile_package_mirror_failed", "package": name, "reason": why.chars().take(500).collect::<String>()})); format!("could not fetch {name} from the TeX package mirror") };
    let response = agent.get(&url).call().map_err(|e| unavailable(e.to_string()))?;
    if response.status() != 200 { return Err(unavailable(format!("HTTP {}", response.status().as_u16()))); }
    let mut bytes = Vec::with_capacity(p.size);
    response.into_body().into_reader().take(p.size as u64 + 1).read_to_end(&mut bytes).map_err(|e| unavailable(e.to_string()))?;
    self.stats.mirror.fetch_add(1, Ordering::Relaxed);
    Ok(bytes)
  }

  fn store(&self, p: &Package, bytes: &[u8]) -> io::Result<()> {
    // A random, exclusively created name: workers sharing the volume (each perhaps pid 1)
    // never write into one another's file.
    let mut r = [0u8; 12];
    getrandom(&mut r)?;
    let tmp = self.dir.join(format!(".tmp-{}", r.iter().map(|b| format!("{b:02x}")).collect::<String>()));
    let written = (|| {
      let mut f = fs::OpenOptions::new().write(true).create_new(true).mode(0o644).open(&tmp)?;
      f.write_all(bytes)?;
      f.sync_all()?;
      drop(f);
      fs::rename(&tmp, self.entry(&p.sha512))
    })();
    if written.is_err() { let _ = fs::remove_file(&tmp); }
    written
  }

  /// Whether the entry is the catalog's archive: by its memo when the file is unchanged since it
  /// was verified, else by reading and hashing it.
  fn present(&self, path: &Path, p: &Package) -> Option<bool> {
    let m = fs::symlink_metadata(path).ok()?;
    let key = (m.len(), m.ino(), m.mtime(), m.mtime_nsec());
    if m.is_file() && self.verified.lock().unwrap().get(&p.sha512) == Some(&key) { return Some(true); }
    let ok = m.is_file() && m.len() == p.size as u64 && fs::read(path).is_ok_and(|b| Self::verify(&b, p));
    if ok { self.verified.lock().unwrap().insert(p.sha512.clone(), key); }
    Some(ok)
  }

  fn slot(&self) -> impl Drop + '_ {
    struct Slot<'a>(&'a (Mutex<usize>, Condvar));
    impl Drop for Slot<'_> { fn drop(&mut self) { *self.0.0.lock().unwrap() -= 1; self.0.1.notify_one(); } }
    let (count, wake) = &self.running;
    let mut n = count.lock().unwrap();
    while *n >= MAX_FILLS { n = wake.wait(n).unwrap(); }
    *n += 1;
    Slot(&self.running)
  }
}

fn getrandom(buf: &mut [u8]) -> io::Result<()> {
  let n = unsafe { libc::getrandom(buf.as_mut_ptr().cast(), buf.len(), 0) };
  if n as usize == buf.len() { Ok(()) } else { Err(io::Error::last_os_error()) }
}

impl Packages for PackageCache {
  fn fill(&self, name: &str) -> Result<u64, String> {
    let started = Instant::now();
    let r = (|| {
      let p = self.package(name)?;
      let path = self.entry(&p.sha512);
      let lock = self.entries.lock().unwrap().entry(p.sha512.clone()).or_default().clone();
      let _one = lock.lock().unwrap();
      match self.present(&path, &p) {
        Some(true) => { self.stats.hits.fetch_add(1, Ordering::Relaxed); return Ok(0); }
        Some(false) => {
          self.verified.lock().unwrap().remove(&p.sha512);
          // Damaged, truncated or tampered with: never serve it; take it from its source again.
          self.stats.rejected.fetch_add(1, Ordering::Relaxed);
          println!("{}", serde_json::json!({"event": "compile_package_rejected", "package": name}));
          fs::remove_file(&path).or_else(|_| fs::remove_dir_all(&path)).map_err(|e| format!("cannot remove the damaged cache entry of {name}: {e}"))?;
        }
        None => {}
      }
      let _slot = self.slot();
      let bytes = self.source(name, &p)?;
      if !Self::verify(&bytes, &p) { return Err(format!("the archive of {name} does not match the catalog's SHA-512 checksum")); }
      self.store(&p, &bytes).map_err(|e| format!("cannot write the package cache: {e}"))?;
      Ok(bytes.len() as u64)
    })();
    self.stats.fill_ms.fetch_add(started.elapsed().as_millis() as u64, Ordering::Relaxed);
    if r.is_err() { self.stats.failed.fetch_add(1, Ordering::Relaxed); }
    r
  }
}

fn read_pinned(base: &Path, pin: &Pin, max: u64) -> io::Result<Vec<u8>> {
  if pin.size > max || pin.path.split('/').any(|c| c.is_empty() || c == ".." || c.starts_with('.')) { return Err(bad("invalid pinned file")); }
  let bytes = fs::read(base.join(&pin.path))?;
  if bytes.len() as u64 != pin.size || sha256_hex(&bytes) != pin.sha256 { return Err(bad(format!("{} differs from the runtime's pinned checksum", pin.path))); }
  Ok(bytes)
}
