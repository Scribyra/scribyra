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
use std::fs::{self, File};
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::Duration;

/// What a job may ask the worker for: one package archive put into the cache by name.
pub trait Packages: Send + Sync {
  /// Makes `<cache>/<sha512>.tar.xz` hold the verified archive of package `name`.
  fn fill(&self, name: &str) -> Result<(), String>;
}

/// How the cache answered, for `/metrics`.
#[derive(Debug, Default)]
pub struct CacheStats { pub hits: AtomicU64, pub bundled: AtomicU64, pub mirror: AtomicU64, pub rejected: AtomicU64, pub failed: AtomicU64 }

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
    if let Some(m) = &mirror && !(m.starts_with("https://") || m.starts_with("http://127.0.0.1") || m.starts_with("http://localhost") || m.starts_with("http://[::1]")) {
      return Err(bad("the TeX package mirror must be an https URL (http only on loopback)"));
    }
    let agent = mirror.as_ref().map(|_| ureq::Agent::config_builder().timeout_global(Some(Duration::from_secs(60))).max_redirects(3).http_status_as_error(false).build().into());
    Ok(PackageCache { dir, assets, mirror: mirror.map(|m| m.trim_end_matches('/').to_string()), shards, snapshot, loaded: Mutex::default(), agent, stats: CacheStats::default() })
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
    let response = agent.get(&url).call().map_err(|e| format!("could not fetch {name} from the TeX package mirror: {e}"))?;
    if response.status() != 200 { return Err(format!("the TeX package mirror answered HTTP {} for {name}", response.status().as_u16())); }
    let mut bytes = Vec::with_capacity(p.size);
    response.into_body().into_reader().take(p.size as u64 + 1).read_to_end(&mut bytes).map_err(|e| format!("could not fetch {name}: {e}"))?;
    self.stats.mirror.fetch_add(1, Ordering::Relaxed);
    Ok(bytes)
  }

  fn store(&self, p: &Package, bytes: &[u8]) -> io::Result<()> {
    static N: AtomicU64 = AtomicU64::new(0);
    let tmp = self.dir.join(format!(".tmp-{}-{}", std::process::id(), N.fetch_add(1, Ordering::Relaxed)));
    let mut f = File::create(&tmp)?;
    f.write_all(bytes)?;
    f.sync_all()?;
    drop(f);
    fs::rename(&tmp, self.entry(&p.sha512)).inspect_err(|_| { let _ = fs::remove_file(&tmp); })
  }
}

impl Packages for PackageCache {
  fn fill(&self, name: &str) -> Result<(), String> {
    let r = (|| {
      let p = self.package(name)?;
      let path = self.entry(&p.sha512);
      match fs::symlink_metadata(&path) {
        Ok(m) if m.is_file() && m.len() == p.size as u64 && fs::read(&path).is_ok_and(|b| Self::verify(&b, &p)) => { self.stats.hits.fetch_add(1, Ordering::Relaxed); return Ok(()); }
        Ok(_) => {
          // Damaged, truncated or tampered with: never serve it; take it from its source again.
          self.stats.rejected.fetch_add(1, Ordering::Relaxed);
          println!("{}", serde_json::json!({"event": "compile_package_rejected", "package": name}));
          fs::remove_file(&path).or_else(|_| fs::remove_dir_all(&path)).map_err(|e| format!("cannot remove the damaged cache entry of {name}: {e}"))?;
        }
        Err(_) => {}
      }
      let bytes = self.source(name, &p)?;
      if !Self::verify(&bytes, &p) { return Err(format!("the archive of {name} does not match the catalog's SHA-512 checksum")); }
      self.store(&p, &bytes).map_err(|e| format!("cannot write the package cache: {e}"))
    })();
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
