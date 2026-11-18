//! Blob storage behind one trait: a local POSIX directory or an S3-compatible bucket.
//!
//! Keys are validated `/`-separated ASCII paths such as `objects/<namespace>/<sha256>`.
//! A successful `put` is the durability point: the filesystem backend fsyncs the file and
//! its directory, and an S3 backend acknowledges only after the service accepted the PUT.
use async_trait::async_trait;
pub use bytes::Bytes;
use std::{
    fmt,
    fs::{self, File},
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
    time::Duration,
};

/// Prefix of in-progress filesystem writes; valid keys never contain a segment starting with `.`.
pub const TEMP_PREFIX: &str = ".tmp-";
const MAX_KEY_BYTES: usize = 512;
const MAX_SEGMENTS: usize = 8;
const MAX_SEGMENT_BYTES: usize = 128;

#[derive(Debug)]
pub enum BlobError {
    /// The key is not a valid blob key.
    InvalidKey,
    /// No blob is stored under the key.
    NotFound,
    /// The stored blob is longer or shorter than the expected length.
    Length,
    /// Storage failed (I/O, network, remote status). The detail is never logged.
    Io(String),
}
impl fmt::Display for BlobError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidKey => f.write_str("invalid blob key"),
            Self::NotFound => f.write_str("blob not found"),
            Self::Length => f.write_str("blob length mismatch"),
            Self::Io(_) => f.write_str("blob storage failure"),
        }
    }
}
impl std::error::Error for BlobError {}
impl From<std::io::Error> for BlobError {
    fn from(error: std::io::Error) -> Self {
        if error.kind() == std::io::ErrorKind::NotFound {
            Self::NotFound
        } else {
            Self::Io(error.kind().to_string())
        }
    }
}

/// A validated blob key: 1–8 non-empty segments of `[A-Za-z0-9_.-]`, none starting with `.`,
/// at most 128 bytes per segment and 512 bytes in total.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub struct BlobKey(String);
impl BlobKey {
    pub fn new(key: impl Into<String>) -> Result<Self, BlobError> {
        let key = key.into();
        let segments: Vec<&str> = key.split('/').collect();
        let valid = !key.is_empty()
            && key.len() <= MAX_KEY_BYTES
            && segments.len() <= MAX_SEGMENTS
            && segments.iter().all(|s| {
                !s.is_empty()
                    && s.len() <= MAX_SEGMENT_BYTES
                    && !s.starts_with('.')
                    && s.bytes()
                        .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-' | b'.'))
            });
        if valid {
            Ok(Self(key))
        } else {
            Err(BlobError::InvalidKey)
        }
    }
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

#[async_trait]
pub trait BlobStore: Send + Sync {
    /// Store `bytes` under `key`. Success means the bytes are durable. Writing identical bytes
    /// to an existing key succeeds and changes nothing observable.
    async fn put(&self, key: &BlobKey, bytes: Bytes) -> Result<(), BlobError>;
    /// Return exactly the stored bytes. `expected_len` bounds the allocation: the caller has
    /// already reserved that many bytes from its memory budget. A stored blob of any other
    /// length fails with [`BlobError::Length`] without reading more than `expected_len + 1` bytes.
    async fn get(&self, key: &BlobKey, expected_len: usize) -> Result<Vec<u8>, BlobError>;
    /// Remove a blob. Removing a missing blob succeeds.
    async fn delete(&self, key: &BlobKey) -> Result<(), BlobError>;
    /// Readiness: prove the store is reachable and (for the filesystem) writable.
    async fn probe(&self) -> Result<(), BlobError>;
}

fn unique_suffix() -> String {
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    format!(
        "{}-{}-{nanos}",
        std::process::id(),
        COUNTER.fetch_add(1, Ordering::Relaxed)
    )
}

async fn blocking<T: Send + 'static>(
    work: impl FnOnce() -> Result<T, BlobError> + Send + 'static,
) -> Result<T, BlobError> {
    tokio::task::spawn_blocking(work)
        .await
        .map_err(|_| BlobError::Io("task".into()))?
}

/// Blobs as files under one directory, `<root>/<key>`.
pub struct FsBlobStore {
    root: PathBuf,
}
impl FsBlobStore {
    /// Create the root if needed and remove leftover temporary files (never committed blobs).
    pub fn open(root: impl Into<PathBuf>) -> Result<Self, BlobError> {
        let root = root.into();
        match fs::create_dir(&root) {
            Ok(()) => sync_dir(parent_of(&root))?,
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
            Err(error) => return Err(error.into()),
        }
        if !fs::metadata(&root)?.is_dir() {
            return Err(BlobError::Io("not a directory".into()));
        }
        remove_temporaries(&root)?;
        Ok(Self { root })
    }
    pub fn root(&self) -> &Path {
        &self.root
    }
    pub fn path(&self, key: &BlobKey) -> PathBuf {
        self.root.join(key.as_str())
    }
}
fn put_file(root: &Path, key: &BlobKey, bytes: &[u8]) -> Result<(), BlobError> {
    let path = root.join(key.as_str());
    let dir = path.parent().ok_or(BlobError::InvalidKey)?.to_path_buf();
    ensure_dir(root, &dir)?;
    let temp = dir.join(format!("{TEMP_PREFIX}{}", unique_suffix()));
    let result = (|| {
        let mut file = File::options().write(true).create_new(true).open(&temp)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        drop(file);
        fs::rename(&temp, &path)?;
        sync_dir(&dir)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temp);
    }
    result
}
fn parent_of(path: &Path) -> &Path {
    path.parent()
        .filter(|p| !p.as_os_str().is_empty())
        .unwrap_or(Path::new("."))
}
fn sync_dir(dir: &Path) -> Result<(), BlobError> {
    File::open(dir)?.sync_all()?;
    Ok(())
}
/// Create every missing directory between `root` and `dir`, fsyncing each new entry's parent.
fn ensure_dir(root: &Path, dir: &Path) -> Result<(), BlobError> {
    if dir == root || dir.is_dir() {
        return Ok(());
    }
    let parent = dir.parent().ok_or(BlobError::InvalidKey)?;
    ensure_dir(root, parent)?;
    match fs::create_dir(dir) {
        Ok(()) => sync_dir(parent),
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => Ok(()),
        Err(error) => Err(error.into()),
    }
}
fn remove_temporaries(dir: &Path) -> Result<(), BlobError> {
    let mut removed = false;
    for entry in fs::read_dir(dir)? {
        let entry = entry?;
        let kind = entry.file_type()?;
        let name = entry.file_name();
        if name.to_str().is_some_and(|n| n.starts_with(TEMP_PREFIX)) && !kind.is_dir() {
            fs::remove_file(entry.path())?;
            removed = true;
        } else if kind.is_dir() {
            remove_temporaries(&entry.path())?;
        }
    }
    if removed {
        sync_dir(dir)?;
    }
    Ok(())
}
fn read_exact_len(mut reader: impl Read, expected_len: usize) -> Result<Vec<u8>, BlobError> {
    let mut bytes = vec![0; expected_len];
    reader.read_exact(&mut bytes).map_err(|error| {
        if error.kind() == std::io::ErrorKind::UnexpectedEof {
            BlobError::Length
        } else {
            error.into()
        }
    })?;
    let mut extra = [0];
    if reader.read(&mut extra)? != 0 {
        return Err(BlobError::Length);
    }
    Ok(bytes)
}
#[async_trait]
impl BlobStore for FsBlobStore {
    async fn put(&self, key: &BlobKey, bytes: Bytes) -> Result<(), BlobError> {
        let (root, key) = (self.root.clone(), key.clone());
        blocking(move || put_file(&root, &key, &bytes)).await
    }
    async fn get(&self, key: &BlobKey, expected_len: usize) -> Result<Vec<u8>, BlobError> {
        let path = self.path(key);
        blocking(move || read_exact_len(File::open(path)?, expected_len)).await
    }
    async fn delete(&self, key: &BlobKey) -> Result<(), BlobError> {
        let path = self.path(key);
        blocking(move || {
            match fs::remove_file(&path) {
                Ok(()) => {}
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
                Err(error) => return Err(error.into()),
            }
            sync_dir(parent_of(&path))
        })
        .await
    }
    async fn probe(&self) -> Result<(), BlobError> {
        let root = self.root.clone();
        blocking(move || {
            let path = root.join(format!("{TEMP_PREFIX}probe-{}", unique_suffix()));
            File::options()
                .write(true)
                .create_new(true)
                .open(&path)?
                .sync_all()?;
            fs::remove_file(&path)?;
            sync_dir(&root)
        })
        .await
    }
}

/// Settings for an S3-compatible bucket. The secret is held only in memory.
#[derive(Clone)]
pub struct S3Settings {
    pub endpoint: String,
    pub region: String,
    pub bucket: String,
    pub access_key_id: String,
    pub secret_access_key: String,
    pub path_style: bool,
    /// PEM certificate authority that alone is trusted for the endpoint, instead of the
    /// platform's (an in-cluster store with a private CA, such as the operator's Garage).
    pub ca_pem: Option<Vec<u8>>,
}
impl fmt::Debug for S3Settings {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("S3Settings { .. }")
    }
}

/// Blobs in an S3-compatible bucket (AWS S3, Cloudflare R2, MinIO, Garage), signed with
/// `rusty-s3` and sent with `ureq` on the blocking pool.
pub struct S3BlobStore {
    bucket: rusty_s3::Bucket,
    credentials: rusty_s3::Credentials,
    agent: ureq::Agent,
}
const S3_TIMEOUT: Duration = Duration::from_secs(30);
const SIGNATURE_LIFETIME: Duration = Duration::from_secs(60);
impl S3BlobStore {
    /// Plain `http://` endpoints are accepted only for loopback hosts (local tests and a
    /// same-host gateway); everything else must use `https://` with a platform-trusted CA.
    pub fn new(settings: S3Settings) -> Result<Self, BlobError> {
        let invalid = || BlobError::Io("invalid s3 settings".into());
        let endpoint = url::Url::parse(&settings.endpoint).map_err(|_| invalid())?;
        let loopback = match endpoint.host() {
            Some(url::Host::Ipv4(ip)) => ip.is_loopback(),
            Some(url::Host::Ipv6(ip)) => ip.is_loopback(),
            Some(url::Host::Domain(name)) => name == "localhost",
            None => false,
        };
        if !(endpoint.scheme() == "https" || endpoint.scheme() == "http" && loopback)
            || !endpoint.username().is_empty()
            || endpoint.password().is_some()
            || endpoint.query().is_some()
            || settings.region.is_empty()
            || settings.bucket.is_empty()
            || settings.access_key_id.is_empty()
            || settings.secret_access_key.is_empty()
        {
            return Err(invalid());
        }
        let style = if settings.path_style {
            rusty_s3::UrlStyle::Path
        } else {
            rusty_s3::UrlStyle::VirtualHost
        };
        let bucket = rusty_s3::Bucket::new(endpoint, style, settings.bucket, settings.region)
            .map_err(|_| invalid())?;
        let credentials =
            rusty_s3::Credentials::new(settings.access_key_id, settings.secret_access_key);
        let roots = match &settings.ca_pem {
            None => ureq::tls::RootCerts::PlatformVerifier,
            Some(pem) => {
                let certs = ureq::tls::parse_pem(pem)
                    .filter_map(|item| match item {
                        Ok(ureq::tls::PemItem::Certificate(cert)) => Some(cert),
                        _ => None,
                    })
                    .collect::<Vec<_>>();
                if certs.is_empty() {
                    return Err(invalid());
                }
                ureq::tls::RootCerts::Specific(std::sync::Arc::new(certs))
            }
        };
        let tls = ureq::tls::TlsConfig::builder().root_certs(roots).build();
        let config = ureq::Agent::config_builder()
            .timeout_global(Some(S3_TIMEOUT))
            .max_redirects(0)
            .http_status_as_error(false)
            .user_agent("scribyra-sync")
            .tls_config(tls)
            .build();
        Ok(Self {
            bucket,
            credentials,
            agent: config.into(),
        })
    }
    fn status_error(status: u16) -> BlobError {
        if status == 404 {
            BlobError::NotFound
        } else {
            BlobError::Io(format!("status {status}"))
        }
    }
}
fn net(error: ureq::Error) -> BlobError {
    BlobError::Io(match error {
        ureq::Error::Timeout(_) => "timeout".into(),
        _ => "network".into(),
    })
}
#[async_trait]
impl BlobStore for S3BlobStore {
    async fn put(&self, key: &BlobKey, bytes: Bytes) -> Result<(), BlobError> {
        use rusty_s3::S3Action;
        let url = self
            .bucket
            .put_object(Some(&self.credentials), key.as_str())
            .sign(SIGNATURE_LIFETIME);
        let agent = self.agent.clone();
        blocking(move || {
            let response = agent
                .put(url.as_str())
                .header("content-type", "application/octet-stream")
                .send(&bytes[..])
                .map_err(net)?;
            match response.status().as_u16() {
                200 | 201 | 204 => Ok(()),
                status => Err(S3BlobStore::status_error(status)),
            }
        })
        .await
    }
    async fn get(&self, key: &BlobKey, expected_len: usize) -> Result<Vec<u8>, BlobError> {
        use rusty_s3::S3Action;
        let url = self
            .bucket
            .get_object(Some(&self.credentials), key.as_str())
            .sign(SIGNATURE_LIFETIME);
        let agent = self.agent.clone();
        blocking(move || {
            let mut response = agent.get(url.as_str()).call().map_err(net)?;
            let status = response.status().as_u16();
            if status != 200 {
                return Err(S3BlobStore::status_error(status));
            }
            let declared = response
                .headers()
                .get("content-length")
                .and_then(|v| v.to_str().ok())
                .and_then(|v| v.parse::<u64>().ok());
            if declared.is_some_and(|len| len != expected_len as u64) {
                return Err(BlobError::Length);
            }
            let reader = response
                .body_mut()
                .with_config()
                .limit(expected_len as u64 + 1)
                .reader();
            read_exact_len(reader, expected_len)
        })
        .await
    }
    async fn delete(&self, key: &BlobKey) -> Result<(), BlobError> {
        use rusty_s3::S3Action;
        let url = self
            .bucket
            .delete_object(Some(&self.credentials), key.as_str())
            .sign(SIGNATURE_LIFETIME);
        let agent = self.agent.clone();
        blocking(move || {
            let response = agent.delete(url.as_str()).call().map_err(net)?;
            match response.status().as_u16() {
                200 | 204 | 404 => Ok(()),
                status => Err(S3BlobStore::status_error(status)),
            }
        })
        .await
    }
    async fn probe(&self) -> Result<(), BlobError> {
        use rusty_s3::S3Action;
        let url = self
            .bucket
            .head_bucket(Some(&self.credentials))
            .sign(SIGNATURE_LIFETIME);
        let agent = self.agent.clone();
        blocking(move || {
            let response = agent.head(url.as_str()).call().map_err(net)?;
            match response.status().as_u16() {
                200 => Ok(()),
                status => Err(S3BlobStore::status_error(status)),
            }
        })
        .await
    }
}
