//! Both blob backends pass the same conformance checks.
mod support;
use scribyra_sync::blobs::{
    BlobError, BlobKey, BlobStore, FsBlobStore, S3BlobStore, S3Settings, TEMP_PREFIX,
};
use support::*;

async fn conformance(store: &dyn BlobStore) {
    store.probe().await.unwrap();
    let ns = random_hex(32);
    let bytes = random_bytes(1000);
    let key = BlobKey::new(format!("objects/{ns}/{}", sha256(&bytes))).unwrap();
    assert!(matches!(
        store.get(&key, 1000).await,
        Err(BlobError::NotFound)
    ));
    store.put(&key, bytes.clone().into()).await.unwrap();
    assert_eq!(store.get(&key, 1000).await.unwrap(), bytes);
    // Identical bytes again: success, nothing observable changes.
    store.put(&key, bytes.clone().into()).await.unwrap();
    assert_eq!(store.get(&key, 1000).await.unwrap(), bytes);
    // The expected length bounds the read in both directions.
    assert!(matches!(store.get(&key, 999).await, Err(BlobError::Length)));
    assert!(matches!(
        store.get(&key, 1001).await,
        Err(BlobError::Length)
    ));
    // Empty blobs and nested keys work.
    let empty = BlobKey::new(format!("entries/{ns}/empty")).unwrap();
    store.put(&empty, Vec::new().into()).await.unwrap();
    assert_eq!(store.get(&empty, 0).await.unwrap(), Vec::<u8>::new());
    // Concurrent writers of distinct and identical keys.
    let pairs: Vec<_> = (0..8u8)
        .map(|n| {
            (
                BlobKey::new(format!("objects/{ns}/c{}", n % 4)).unwrap(),
                vec![n % 4; 4096],
            )
        })
        .collect();
    futures_util::future::try_join_all(pairs.iter().map(|(k, b)| store.put(k, b.clone().into())))
        .await
        .unwrap();
    for (k, b) in &pairs {
        assert_eq!(&store.get(k, 4096).await.unwrap(), b);
    }
    store.delete(&key).await.unwrap();
    assert!(matches!(
        store.get(&key, 1000).await,
        Err(BlobError::NotFound)
    ));
    store.delete(&key).await.unwrap();
    store.probe().await.unwrap();
}

#[test]
fn keys_are_validated_strictly() {
    for good in ["objects/a/b", "entries/p-1/0123abcd", "x", "a/b.c/d_e"] {
        BlobKey::new(good).unwrap();
    }
    let long = "a".repeat(129);
    for bad in [
        "",
        "/a",
        "a/",
        "a//b",
        "../a",
        "a/../b",
        "a/./b",
        ".tmp-x",
        "a/.hidden",
        "a b",
        "a\\b",
        "a/b?c",
        "a%2fb",
        "é",
        &long,
        "1/2/3/4/5/6/7/8/9",
    ] {
        assert!(BlobKey::new(bad).is_err(), "{bad:?} must be rejected");
    }
}

#[tokio::test]
async fn filesystem_backend_conforms_and_recovers_only_temporaries() {
    let dir = temp_dir("scribyra-fs-");
    let root = dir.join("blobs");
    let store = FsBlobStore::open(&root).unwrap();
    conformance(&store).await;
    let key = BlobKey::new("objects/n/kept").unwrap();
    store.put(&key, b"committed".to_vec().into()).await.unwrap();
    // No temporary file survives a successful write.
    let names: Vec<_> = std::fs::read_dir(root.join("objects/n"))
        .unwrap()
        .map(|e| e.unwrap().file_name())
        .collect();
    assert!(
        names
            .iter()
            .all(|n| !n.to_str().unwrap().starts_with(TEMP_PREFIX))
    );
    let remnant = root.join("objects/n").join(format!("{TEMP_PREFIX}crash"));
    std::fs::write(&remnant, b"unacknowledged").unwrap();
    drop(store);
    let store = FsBlobStore::open(&root).unwrap();
    assert!(!remnant.exists());
    assert_eq!(store.get(&key, 9).await.unwrap(), b"committed");
    std::fs::remove_dir_all(dir).unwrap();
}

#[tokio::test]
async fn s3_backend_conforms_against_garage() {
    let store = S3BlobStore::new(garage().bucket()).unwrap();
    conformance(&store).await;
}

#[tokio::test]
async fn s3_probe_fails_for_a_missing_bucket_or_wrong_secret() {
    let g = garage();
    let mut missing = g.bucket();
    missing.bucket = "no-such-bucket".into();
    assert!(S3BlobStore::new(missing).unwrap().probe().await.is_err());
    let mut wrong = g.bucket();
    wrong.secret_access_key = random_hex(32);
    assert!(S3BlobStore::new(wrong).unwrap().probe().await.is_err());
}

#[test]
fn s3_settings_refuse_remote_plain_http_and_credentials_in_url() {
    let base = S3Settings {
        endpoint: "https://s3.example.org".into(),
        region: "auto".into(),
        bucket: "b".into(),
        access_key_id: "k".into(),
        secret_access_key: "s".into(),
        path_style: false,
        ca_pem: None,
    };
    assert!(S3BlobStore::new(base.clone()).is_ok());
    for endpoint in [
        "http://s3.example.org",
        "https://user:pw@s3.example.org",
        "ftp://127.0.0.1",
        "not a url",
    ] {
        assert!(
            S3BlobStore::new(S3Settings {
                endpoint: endpoint.into(),
                ..base.clone()
            })
            .is_err(),
            "{endpoint}"
        );
    }
    assert!(
        S3BlobStore::new(S3Settings {
            endpoint: "http://127.0.0.1:3900".into(),
            path_style: true,
            ..base.clone()
        })
        .is_ok()
    );
    assert!(
        S3BlobStore::new(S3Settings {
            secret_access_key: String::new(),
            ..base.clone()
        })
        .is_err()
    );
    assert_eq!(format!("{base:?}"), "S3Settings { .. }");
}
