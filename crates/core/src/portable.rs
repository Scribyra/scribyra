//! Offline package bundles carrying their pinned metadata proofs.
use crate::{
    environment::{Lock, MAX_BUNDLE_BYTES, MAX_LOCK_BYTES, MAX_PACKAGE_BYTES, Runtime, field},
    packages::{Catalog, MAX_ARCHIVE, metadata_bucket},
};
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};

pub const MAGIC: &[u8] = b"SCRIBYRA-TEX\x02";
pub const MAX_METADATA: usize = 24 * 1024 * 1024;
#[derive(Clone)]
pub struct Asset {
    pub path: String,
    pub bytes: Vec<u8>,
}
#[derive(Deserialize)]
struct Pin {
    path: String,
    size: usize,
    sha256: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Root {
    version: u32,
    snapshot: String,
    source_archive_sha256: String,
    packages: BTreeMap<String, Pin>,
    #[serde(default)]
    dependency_graph: Option<Pin>,
    #[serde(default)]
    compatibility: Option<serde_json::Value>,
}
pub struct Decoded {
    pub lock: Lock,
    pub metadata: Vec<Asset>,
    pub archives: Vec<Vec<u8>>,
    pub packages: serde_json::Value,
}
fn hash_path(path: &str) -> Result<&str, String> {
    let hash = path
        .strip_prefix("metadata/")
        .and_then(|p| p.strip_suffix(".json"))
        .or_else(|| {
            path.strip_prefix("tex-catalog.")
                .and_then(|p| p.strip_suffix(".json"))
        })
        .ok_or("Invalid bundle metadata path")?;
    if hash.len() != 64
        || !hash
            .bytes()
            .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
    {
        return Err("Invalid bundle metadata hash".into());
    }
    Ok(hash)
}
fn runtime(lock: &Lock, expected: &Runtime) -> Result<(), String> {
    lock.validate()?;
    expected.validate()?;
    if &lock.runtime != expected {
        return Err(
            "This package bundle requires a different compiler, adapter or catalog.".into(),
        );
    }
    Ok(())
}
fn verify(lock: &Lock, expected: &Runtime, metadata: &[Asset]) -> Result<Catalog, String> {
    runtime(lock, expected)?;
    if metadata.is_empty() || metadata.len() > 66 {
        return Err("Portable bundles require a root, at most 64 package shards and an optional dependency manifest".into());
    }
    let mut assets = BTreeMap::new();
    let mut total = 0usize;
    for asset in metadata {
        let hash = hash_path(&asset.path)?;
        total = total.saturating_add(asset.bytes.len());
        let limit = if asset.path.starts_with("tex-catalog.") {
            256 * 1024
        } else {
            2 * 1024 * 1024
        };
        if asset.bytes.is_empty() || asset.bytes.len() > limit || total > MAX_METADATA {
            return Err("Bundle metadata exceeds its size limit".into());
        }
        if format!("{:x}", Sha256::digest(&asset.bytes)) != hash {
            return Err("Bundle metadata checksum mismatch".into());
        }
        if assets
            .insert(asset.path.as_str(), asset.bytes.as_slice())
            .is_some()
        {
            return Err("Duplicate bundle metadata asset".into());
        }
    }
    let root_path = format!("tex-catalog.{}.json", expected.catalog_sha256);
    let root: Root = serde_json::from_slice(
        assets
            .get(root_path.as_str())
            .ok_or("Bundle omits its pinned metadata root")?,
    )
    .map_err(|e| format!("Invalid metadata root: {e}"))?;
    if root.version != 1
        || root.snapshot != expected.snapshot
        || root.source_archive_sha256 != expected.distribution_sha256
        || root.packages.len() > 256
    {
        return Err("Bundle metadata root differs from its environment".into());
    }
    if let Some(value) = &root.compatibility {
        crate::compatibility::Manifest::parse(&value.to_string())?.check(expected, None)?;
    }
    let mut required = BTreeSet::from([root_path]);
    if let Some(pin) = &root.dependency_graph {
        if pin.path != format!("metadata/{}.json", pin.sha256)
            || hash_path(&pin.path)? != pin.sha256
        {
            return Err("Invalid dependency manifest pin".into());
        }
        let bytes = assets
            .get(pin.path.as_str())
            .ok_or("Bundle omits its dependency manifest")?;
        if bytes.len() != pin.size {
            return Err("Dependency manifest size differs from its pin".into());
        }
        crate::dependencies::Manifest::parse(
            std::str::from_utf8(bytes).map_err(|_| "Dependency manifest is not UTF-8")?,
            &root.snapshot,
        )?;
        required.insert(pin.path.clone());
    }
    let mut catalog =
        Catalog::new(&serde_json::json!({"snapshot":root.snapshot,"packages":{}}).to_string())?;
    for name in lock.packages.keys() {
        let pin = root
            .packages
            .get(&metadata_bucket(name))
            .ok_or("Bundle package has no metadata shard")?;
        if pin.path != format!("metadata/{}.json", pin.sha256)
            || hash_path(&pin.path)? != pin.sha256
        {
            return Err("Invalid metadata shard pin".into());
        }
        if required.insert(pin.path.clone()) {
            let bytes = assets
                .get(pin.path.as_str())
                .ok_or("Bundle omits required package metadata")?;
            if bytes.len() != pin.size {
                return Err("Bundle metadata size differs from its pinned manifest".into());
            }
            catalog
                .merge(std::str::from_utf8(bytes).map_err(|_| "Package metadata is not UTF-8")?)?;
        }
    }
    if required.len() != assets.len() {
        return Err("Bundle contains undeclared metadata assets".into());
    }
    catalog.check_environment(lock, expected)?;
    Ok(catalog)
}
fn put(output: &mut Vec<u8>, bytes: &[u8]) {
    output.extend_from_slice(&(bytes.len() as u32).to_be_bytes());
    output.extend_from_slice(bytes);
}
pub fn encode(
    lock: &Lock,
    expected: &Runtime,
    archives: &[Vec<u8>],
    metadata: &[Asset],
) -> Result<Vec<u8>, String> {
    let catalog = verify(lock, expected, metadata)?;
    if archives.len() != lock.packages.len() {
        return Err("Package bundle archive count differs from lock".into());
    }
    let manifest = serde_json::to_vec(lock).map_err(|e| e.to_string())?;
    if manifest.len() > MAX_LOCK_BYTES {
        return Err("Package lock exceeds 64 KiB".into());
    }
    let mut output = MAGIC.to_vec();
    put(&mut output, &manifest);
    output.extend_from_slice(&(metadata.len() as u32).to_be_bytes());
    for asset in metadata {
        put(&mut output, asset.path.as_bytes());
        put(&mut output, &asset.bytes);
    }
    let mut total = 0usize;
    for ((name, _), bytes) in lock.packages.iter().zip(archives) {
        total = total.saturating_add(bytes.len());
        if total > MAX_PACKAGE_BYTES {
            return Err("Package bundle exceeds 96 MiB of archives".into());
        }
        catalog.unpack(name, bytes)?;
        put(&mut output, bytes);
    }
    if output.len() > MAX_BUNDLE_BYTES {
        return Err("Package bundle exceeds its total size limit".into());
    }
    Ok(output)
}
pub fn decode(bytes: &[u8], expected: &Runtime) -> Result<Decoded, String> {
    if bytes.len() > MAX_BUNDLE_BYTES || !bytes.starts_with(MAGIC) {
        return Err("This portable bundle format is unsupported. Re-export it with the matching Scribyra build.".into());
    }
    let mut offset = MAGIC.len();
    let manifest = field(bytes, &mut offset, MAX_LOCK_BYTES)?;
    let lock =
        Lock::parse(std::str::from_utf8(manifest).map_err(|_| "Package lock is not UTF-8")?)?;
    runtime(&lock, expected)?;
    let count = bytes
        .get(offset..offset + 4)
        .ok_or("Truncated metadata count")?;
    offset += 4;
    let count = u32::from_be_bytes(count.try_into().unwrap()) as usize;
    if count == 0 || count > 66 {
        return Err("Portable bundle metadata count exceeds its limit".into());
    }
    let mut metadata = Vec::new();
    let mut total = 0usize;
    for _ in 0..count {
        let path = std::str::from_utf8(field(bytes, &mut offset, 128)?)
            .map_err(|_| "Metadata path is not UTF-8")?
            .to_string();
        let part = field(bytes, &mut offset, 2 * 1024 * 1024)?;
        total = total.saturating_add(part.len());
        if total > MAX_METADATA {
            return Err("Bundle metadata exceeds 24 MiB".into());
        }
        metadata.push(Asset {
            path,
            bytes: part.to_vec(),
        });
    }
    let catalog = verify(&lock, expected, &metadata)?;
    let mut archives = Vec::new();
    for name in lock.packages.keys() {
        let part = field(bytes, &mut offset, MAX_ARCHIVE)?;
        catalog.unpack(name, part)?;
        archives.push(part.to_vec());
    }
    if offset != bytes.len() {
        return Err("Package bundle has unexpected trailing data".into());
    }
    let packages = catalog.package_info(&lock.packages.keys().cloned().collect::<Vec<_>>())?;
    Ok(Decoded {
        lock,
        metadata,
        archives,
        packages,
    })
}
pub fn asset_info(asset: &Asset) -> serde_json::Value {
    serde_json::json!({"path":asset.path,"size":asset.bytes.len(),"sha256":format!("{:x}",Sha256::digest(&asset.bytes))})
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Read;
    fn setup() -> (Catalog, Lock, Vec<Asset>, Vec<Vec<u8>>) {
        let mut source = String::new();
        flate2::read::GzDecoder::new(&include_bytes!("../../../web/tex-catalog.json.gz")[..])
            .read_to_string(&mut source)
            .unwrap();
        let catalog = Catalog::new(&source).unwrap();
        let name = "babel-romanian";
        let body=serde_json::to_vec(&serde_json::json!({"snapshot":catalog.snapshot,"packages":{name:catalog.packages[name]}})).unwrap();
        let hash = format!("{:x}", Sha256::digest(&body));
        let pin = serde_json::json!({"path":format!("metadata/{hash}.json"),"size":body.len(),"sha256":hash});
        let root=serde_json::to_vec(&serde_json::json!({"version":1,"snapshot":catalog.snapshot,"sourceArchiveSha256":"a".repeat(64),"packages":{metadata_bucket(name):pin}})).unwrap();
        let root_hash = format!("{:x}", Sha256::digest(&root));
        let runtime = Runtime {
            engine: "lualatex".into(),
            snapshot: catalog.snapshot.clone(),
            distribution_sha256: "a".repeat(64),
            adapter_sha256: "b".repeat(64),
            catalog_sha256: root_hash.clone(),
        };
        let lock = catalog.environment(runtime, &[name.into()]).unwrap();
        (
            catalog,
            lock,
            vec![
                Asset {
                    path: format!("tex-catalog.{root_hash}.json"),
                    bytes: root,
                },
                Asset {
                    path: format!("metadata/{hash}.json"),
                    bytes: body,
                },
            ],
            vec![
                include_bytes!("../../../tests/fixtures/tex-packages/babel-romanian.tar.xz")
                    .to_vec(),
            ],
        )
    }
    #[test]
    fn offline_bundle_verifies_the_entire_metadata_and_archive_chain() {
        let (_, lock, metadata, archives) = setup();
        let bytes = encode(&lock, &lock.runtime, &archives, &metadata).unwrap();
        assert_eq!(
            bytes,
            encode(&lock, &lock.runtime, &archives, &metadata).unwrap()
        );
        let decoded = decode(&bytes, &lock.runtime).unwrap();
        assert_eq!(decoded.lock, lock);
        assert_eq!(decoded.archives, archives);
        assert_eq!(decoded.metadata.len(), 2);
        assert_eq!(decoded.packages[0]["name"], "babel-romanian");
        assert!(decoded.packages[0].get("files").is_none());
        assert_eq!(Lock::from_bundle(&bytes).unwrap(), lock);
        let mut bad = bytes.clone();
        let end = bad.len() - 1;
        bad[end] ^= 1;
        assert!(
            decode(&bad, &lock.runtime)
                .err()
                .unwrap()
                .contains("checksum")
        );
        let mut foreign = lock.runtime.clone();
        foreign.adapter_sha256 = "f".repeat(64);
        assert!(
            decode(&bytes, &foreign)
                .err()
                .unwrap()
                .contains("different compiler")
        );
        let mut extra = bytes.clone();
        extra.push(0);
        assert!(
            decode(&extra, &lock.runtime)
                .err()
                .unwrap()
                .contains("trailing")
        );
        assert!(decode(&bytes[..bytes.len() - 1], &lock.runtime).is_err());
    }
    #[test]
    fn omitted_duplicate_corrupt_and_unpinned_metadata_are_rejected() {
        let (catalog, lock, metadata, archives) = setup();
        for index in 0..2 {
            let mut omitted = metadata.clone();
            omitted.remove(index);
            assert!(encode(&lock, &lock.runtime, &archives, &omitted).is_err());
        }
        let mut duplicate = metadata.clone();
        duplicate.push(metadata[1].clone());
        assert!(
            encode(&lock, &lock.runtime, &archives, &duplicate)
                .unwrap_err()
                .contains("Duplicate")
        );
        let mut corrupt = metadata.clone();
        corrupt[1].bytes[10] ^= 1;
        assert!(
            encode(&lock, &lock.runtime, &archives, &corrupt)
                .unwrap_err()
                .contains("checksum")
        );
        // Rehashing a modified shard cannot bypass the pinned root's references.
        let mut rehashed = metadata.clone();
        rehashed[1].bytes.push(b' ');
        rehashed[1].path = format!("metadata/{:x}.json", Sha256::digest(&rehashed[1].bytes));
        assert!(
            encode(&lock, &lock.runtime, &archives, &rehashed)
                .unwrap_err()
                .contains("omits required")
        );
        // A self-consistent replacement root still differs from the build's pin.
        let mut root = metadata.clone();
        root[0].bytes.push(b' ');
        root[0].path = format!("tex-catalog.{:x}.json", Sha256::digest(&root[0].bytes));
        assert!(
            encode(&lock, &lock.runtime, &archives, &root)
                .unwrap_err()
                .contains("pinned metadata root")
        );
        let mut traversal = metadata.clone();
        traversal[1].path = "metadata/../../source.tex".into();
        assert!(encode(&lock, &lock.runtime, &archives, &traversal).is_err());
        let mut extra = metadata.clone();
        let bytes = b"{}".to_vec();
        extra.push(Asset {
            path: format!("metadata/{:x}.json", Sha256::digest(&bytes)),
            bytes,
        });
        assert!(
            encode(&lock, &lock.runtime, &archives, &extra)
                .unwrap_err()
                .contains("undeclared")
        );
        let mut mismatch = lock.clone();
        mismatch
            .packages
            .get_mut("babel-romanian")
            .unwrap()
            .revision += 1;
        assert!(
            encode(&mismatch, &lock.runtime, &archives, &metadata)
                .unwrap_err()
                .contains("pinned catalog")
        );
        let legacy = catalog
            .encode_environment(&lock, &lock.runtime, &archives)
            .unwrap();
        assert!(
            decode(&legacy, &lock.runtime)
                .err()
                .unwrap()
                .contains("unsupported")
        );
    }
}
