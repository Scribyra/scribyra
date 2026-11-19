//! The provisioned-storage path without a cluster: a real Garage (nixpkgs, the version the
//! operator's image pins) started from the operator's generated `garage.toml`, behind the
//! operator's TLS proxy with a CA from `tls::generate`; the operator's admin-API bootstrap; and
//! the service's S3 client trusting only that CA (`s3_ca_file`).

use scribyra_operator::{garage, resources, tls};
use scribyra_sync::blobs::{BlobKey, BlobStore, S3BlobStore, S3Settings};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

struct Kill(Child);
impl Drop for Kill {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}
fn free_port() -> u16 {
    std::net::TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn garage_behind_the_tls_proxy_bootstraps_and_serves_the_service() {
    if Command::new("garage").arg("--version").output().is_err() {
        assert!(std::env::var_os("SCRIBYRA_ENVTEST_REQUIRED").is_none(), "garage missing; run in `nix develop .#operator`");
        eprintln!("skipping: garage is not on PATH");
        return;
    }
    let dir = tempfile::tempdir().unwrap();
    let d = dir.path();
    std::fs::create_dir(d.join("secrets")).unwrap();
    let token = "a".repeat(64);
    std::fs::write(d.join("secrets/rpc-secret"), "0123456789abcdef".repeat(4)).unwrap();
    std::fs::write(d.join("secrets/admin-token"), &token).unwrap();
    let (rpc, s3, admin, s3_tls, admin_tls) = (free_port(), free_port(), free_port(), free_port(), free_port());
    // The generated configuration, with this test's directories and ports.
    let config = resources::garage_config(&serde_yaml::from_str(include_str!("../../../deploy/operator/samples/quickstart.yaml")).unwrap())
        .replace("/var/lib/garage", d.to_str().unwrap())
        .replace("/etc/garage/secrets", d.join("secrets").to_str().unwrap())
        .replace("127.0.0.1:3901", &format!("127.0.0.1:{rpc}"))
        .replace("127.0.0.1:3900", &format!("127.0.0.1:{s3}"))
        .replace("127.0.0.1:3903", &format!("127.0.0.1:{admin}"));
    std::fs::write(d.join("garage.toml"), config).unwrap();
    let log = std::fs::File::create(d.join("garage.log")).unwrap();
    let _garage = Kill(Command::new("garage").arg("server").env("GARAGE_CONFIG_FILE", d.join("garage.toml")).stdout(Stdio::null()).stderr(log).spawn().unwrap());

    let material = tls::generate(&tls::garage_names("lab", "lab")).unwrap();
    let routes = vec![(format!("127.0.0.1:{s3_tls}"), format!("127.0.0.1:{s3}")), (format!("127.0.0.1:{admin_tls}"), format!("127.0.0.1:{admin}"))];
    let (cert, key) = (material.cert_pem.clone().into_bytes(), material.key_pem.clone().into_bytes());
    tokio::spawn(async move { tls::proxy(routes, &cert, &key).await.unwrap() });

    // Bootstrap through the proxy; Garage needs a moment to start.
    let ca = material.ca_pem.clone().into_bytes();
    let url = format!("https://localhost:{admin_tls}");
    let deadline = Instant::now() + Duration::from_secs(60);
    let creds = loop {
        let (url, token, ca) = (url.clone(), token.clone(), ca.clone());
        match tokio::task::spawn_blocking(move || garage::Admin::new(&url, &token, &ca)?.bootstrap("scribyra", 1 << 30, None)).await.unwrap() {
            Ok(c) => break c,
            Err(e) => {
                assert!(Instant::now() < deadline, "bootstrap: {e}\n{}", std::fs::read_to_string(d.join("garage.log")).unwrap_or_default());
                tokio::time::sleep(Duration::from_millis(500)).await;
            }
        }
    };
    assert!(creds.access_key_id.starts_with("GK"));
    // Repeating it changes nothing and finds the same key (with or without stored credentials).
    let again = {
        let (url, token, ca) = (url.clone(), token.clone(), ca.clone());
        tokio::task::spawn_blocking(move || garage::Admin::new(&url, &token, &ca)?.bootstrap("scribyra", 1 << 30, None)).await.unwrap().unwrap()
    };
    assert_eq!(again.access_key_id, creds.access_key_id);
    assert_eq!(again.secret_access_key, creds.secret_access_key);
    // A wrong token is refused.
    let refused = {
        let (url, ca) = (url.clone(), ca.clone());
        tokio::task::spawn_blocking(move || garage::Admin::new(&url, &"b".repeat(64), &ca)?.bootstrap("scribyra", 1 << 30, None)).await.unwrap()
    };
    assert!(matches!(refused, Err(garage::Error::Status(403, _))), "{:?}", refused.err());

    // The service's S3 client, trusting only the operator's CA.
    let settings = S3Settings {
        endpoint: format!("https://localhost:{s3_tls}"),
        region: "garage".into(),
        bucket: "scribyra".into(),
        access_key_id: creds.access_key_id.clone(),
        secret_access_key: creds.secret_access_key.clone(),
        path_style: true,
        ca_pem: Some(ca.clone()),
    };
    let store = S3BlobStore::new(settings.clone()).unwrap();
    store.probe().await.unwrap();
    let key = BlobKey::new("objects/test/abc").unwrap();
    store.put(&key, scribyra_sync::blobs::Bytes::from_static(b"hello garage")).await.unwrap();
    assert_eq!(store.get(&key, 12).await.unwrap(), b"hello garage");
    // Without the CA (platform trust store) the private certificate is refused.
    let untrusted = S3BlobStore::new(S3Settings { ca_pem: None, ..settings.clone() }).unwrap();
    assert!(untrusted.probe().await.is_err());
    // Another CA is refused too.
    let other = tls::generate(&["localhost".into()]).unwrap();
    let wrong = S3BlobStore::new(S3Settings { ca_pem: Some(other.ca_pem.into_bytes()), ..settings }).unwrap();
    assert!(wrong.probe().await.is_err());
}
