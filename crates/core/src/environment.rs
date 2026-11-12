//! Portable, strict TeX environment locks and verified supplemental package bundles.
use crate::packages::{Catalog, MAX_ARCHIVE};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

pub const MAX_PACKAGES: usize = 64;
pub const MAX_PACKAGE_BYTES: usize = 96 * 1024 * 1024;
pub const MAX_LOCK_BYTES: usize = 64 * 1024;
pub const MAX_BUNDLE_BYTES: usize =
    MAX_PACKAGE_BYTES + crate::portable::MAX_METADATA + MAX_LOCK_BYTES + 16 * 1024;
const MAGIC: &[u8] = b"SCRIBYRA-TEX\x01";

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Runtime {
    pub engine: String,
    pub distribution_sha256: String,
    pub adapter_sha256: String,
    pub catalog_sha256: String,
    pub snapshot: String,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Package {
    pub revision: u32,
    pub size: usize,
    pub sha512: String,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Lock {
    pub version: u32,
    pub runtime: Runtime,
    #[serde(deserialize_with = "unique_packages")]
    pub packages: BTreeMap<String, Package>,
}
fn unique_packages<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<BTreeMap<String, Package>, D::Error> {
    struct Packages;
    impl<'de> serde::de::Visitor<'de> for Packages {
        type Value = BTreeMap<String, Package>;
        fn expecting(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
            f.write_str("a bounded map of unique TeX packages")
        }
        fn visit_map<M: serde::de::MapAccess<'de>>(
            self,
            mut map: M,
        ) -> Result<Self::Value, M::Error> {
            let mut packages = BTreeMap::new();
            while let Some((name, package)) = map.next_entry::<String, Package>()? {
                if packages.len() >= MAX_PACKAGES {
                    return Err(serde::de::Error::custom(
                        "TeX environment exceeds 64 packages.",
                    ));
                }
                if packages.insert(name, package).is_some() {
                    return Err(serde::de::Error::custom("Duplicate locked TeX package."));
                }
            }
            Ok(packages)
        }
    }
    deserializer.deserialize_map(Packages)
}
fn hash(value: &str, length: usize) -> bool {
    value.len() == length
        && value
            .bytes()
            .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
}
fn package_name(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || b"-._".contains(&c))
}
impl Runtime {
    pub fn validate(&self) -> Result<(), String> {
        if self.engine != "lualatex"
            || !hash(&self.distribution_sha256, 64)
            || !hash(&self.adapter_sha256, 64)
            || !hash(&self.catalog_sha256, 64)
            || self.snapshot.is_empty()
            || self.snapshot.len() > 128
            || self.snapshot.chars().any(char::is_control)
        {
            return Err("Invalid LuaLaTeX runtime identity.".into());
        }
        Ok(())
    }
}
impl Lock {
    /// Read only the bounded manifest before fetching its immutable metadata.
    /// This does not validate archive bytes or authorize a cache/project write.
    pub fn from_bundle(bytes: &[u8]) -> Result<Self, String> {
        if bytes.len() > MAX_BUNDLE_BYTES
            || !(bytes.starts_with(MAGIC) || bytes.starts_with(crate::portable::MAGIC))
        {
            return Err("Invalid or oversized TeX package bundle.".into());
        }
        let mut offset = MAGIC.len();
        let manifest = field(bytes, &mut offset, MAX_LOCK_BYTES)?;
        Self::parse(std::str::from_utf8(manifest).map_err(|_| "Package bundle lock is not UTF-8.")?)
    }
    pub fn parse(json: &str) -> Result<Self, String> {
        if json.len() > MAX_LOCK_BYTES {
            return Err("TeX environment lock exceeds 64 KiB.".into());
        }
        let lock: Self =
            serde_json::from_str(json).map_err(|e| format!("Invalid TeX environment lock: {e}"))?;
        lock.validate()?;
        Ok(lock)
    }
    pub fn validate(&self) -> Result<(), String> {
        if self.version != 1 {
            return Err("Unsupported TeX environment lock version.".into());
        }
        self.runtime.validate()?;
        if self.packages.len() > MAX_PACKAGES {
            return Err("TeX environment exceeds 64 supplemental packages.".into());
        }
        let mut total = 0usize;
        for (name, package) in &self.packages {
            if !package_name(name)
                || !hash(&package.sha512, 128)
                || package.size == 0
                || package.size > MAX_ARCHIVE
            {
                return Err("Invalid locked TeX package.".into());
            }
            total = total.saturating_add(package.size);
        }
        if total > MAX_PACKAGE_BYTES {
            return Err("TeX environment exceeds 96 MiB of supplemental archives.".into());
        }
        Ok(())
    }
}
impl Catalog {
    pub fn environment(&self, runtime: Runtime, names: &[String]) -> Result<Lock, String> {
        runtime.validate()?;
        if runtime.snapshot != self.snapshot {
            return Err("Runtime and catalog snapshots differ.".into());
        }
        if names.len() > MAX_PACKAGES {
            return Err("TeX environment exceeds 64 supplemental packages.".into());
        }
        let mut packages = BTreeMap::new();
        for name in names {
            let p = self
                .packages
                .get(name)
                .ok_or("Unknown package in TeX environment.")?;
            if packages
                .insert(
                    name.clone(),
                    Package {
                        revision: p.revision,
                        size: p.size,
                        sha512: p.sha512.clone(),
                    },
                )
                .is_some()
            {
                return Err("Duplicate package in TeX environment.".into());
            }
        }
        let lock = Lock {
            version: 1,
            runtime,
            packages,
        };
        lock.validate()?;
        self.check_environment(&lock, &lock.runtime)?;
        Ok(lock)
    }
    pub fn check_environment(&self, lock: &Lock, runtime: &Runtime) -> Result<(), String> {
        lock.validate()?;
        runtime.validate()?;
        if &lock.runtime != runtime || runtime.snapshot != self.snapshot {
            return Err("This project is locked to a different compiler, adapter or catalog. Use the matching Scribyra build, or explicitly unlock the environment before updating it.".into());
        }
        for (name, p) in &lock.packages {
            let Some(expected) = self.packages.get(name) else {
                return Err(format!(
                    "Locked TeX package {name} is absent from this catalog."
                ));
            };
            if p.revision != expected.revision
                || p.sha512 != expected.sha512
                || p.size != expected.size
            {
                return Err(format!(
                    "Locked TeX package {name} differs from the pinned catalog."
                ));
            }
            for dependency in &expected.requires {
                if !lock.packages.contains_key(dependency) {
                    return Err(format!("Locked TeX package {name} requires {dependency}."));
                }
            }
        }
        Ok(())
    }
    /// All archives are checked before a caller can commit any imported data.
    pub fn encode_environment(
        &self,
        lock: &Lock,
        runtime: &Runtime,
        archives: &[Vec<u8>],
    ) -> Result<Vec<u8>, String> {
        self.check_environment(lock, runtime)?;
        if archives.len() != lock.packages.len() {
            return Err("Package bundle does not contain exactly the locked archives.".into());
        }
        let manifest = serde_json::to_vec(lock).map_err(|e| e.to_string())?;
        if manifest.len() > MAX_LOCK_BYTES {
            return Err("TeX environment lock exceeds 64 KiB.".into());
        }
        let mut output = MAGIC.to_vec();
        output.extend_from_slice(&(manifest.len() as u32).to_be_bytes());
        output.extend_from_slice(&manifest);
        for ((name, _), bytes) in lock.packages.iter().zip(archives) {
            self.unpack(name, bytes)?;
            output.extend_from_slice(&(bytes.len() as u32).to_be_bytes());
            output.extend_from_slice(bytes);
        }
        Ok(output)
    }
    pub fn decode_environment(
        &self,
        bytes: &[u8],
        runtime: &Runtime,
    ) -> Result<(Lock, Vec<Vec<u8>>), String> {
        if bytes.len() > MAX_BUNDLE_BYTES || !bytes.starts_with(MAGIC) {
            return Err("Invalid or oversized TeX package bundle.".into());
        }
        let mut offset = MAGIC.len();
        let manifest = field(bytes, &mut offset, MAX_LOCK_BYTES)?;
        let lock = Lock::parse(
            std::str::from_utf8(manifest).map_err(|_| "Package bundle lock is not UTF-8.")?,
        )?;
        self.check_environment(&lock, runtime)?;
        let mut archives = Vec::new();
        for name in lock.packages.keys() {
            let archive = field(bytes, &mut offset, MAX_ARCHIVE)?;
            self.unpack(name, archive)?;
            archives.push(archive.to_vec());
        }
        if offset != bytes.len() {
            return Err("Package bundle has unexpected trailing data.".into());
        }
        Ok((lock, archives))
    }
}
pub(crate) fn field<'a>(
    bytes: &'a [u8],
    offset: &mut usize,
    limit: usize,
) -> Result<&'a [u8], String> {
    let length = bytes
        .get(*offset..offset.saturating_add(4))
        .ok_or("Truncated TeX package bundle.")?;
    let size = u32::from_be_bytes(length.try_into().unwrap()) as usize;
    *offset += 4;
    if size > limit {
        return Err("TeX package bundle field exceeds its size limit.".into());
    }
    let value = bytes
        .get(*offset..offset.saturating_add(size))
        .ok_or("Truncated TeX package bundle.")?;
    *offset += size;
    Ok(value)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Read;
    fn setup() -> (Catalog, Runtime, Vec<u8>) {
        let mut json = String::new();
        flate2::read::GzDecoder::new(&include_bytes!("../../../web/tex-catalog.json.gz")[..])
            .read_to_string(&mut json)
            .unwrap();
        let catalog = Catalog::new(&json).unwrap();
        let runtime = Runtime {
            engine: "lualatex".into(),
            distribution_sha256: "a".repeat(64),
            adapter_sha256: "b".repeat(64),
            catalog_sha256: "c".repeat(64),
            snapshot: catalog.snapshot.clone(),
        };
        (
            catalog,
            runtime,
            include_bytes!("../../../tests/fixtures/tex-packages/babel-romanian.tar.xz").to_vec(),
        )
    }
    #[test]
    fn locks_require_the_complete_explicit_dependency_set() {
        let (mut catalog, runtime, _) = setup();
        catalog.packages.get_mut("babel-romanian").unwrap().requires = vec!["babel-french".into()];
        assert!(
            catalog
                .environment(runtime.clone(), &["babel-romanian".into()])
                .unwrap_err()
                .contains("requires babel-french")
        );
        let mut lock = catalog
            .environment(
                runtime.clone(),
                &["babel-romanian".into(), "babel-french".into()],
            )
            .unwrap();
        lock.packages.remove("babel-french");
        assert!(
            catalog
                .check_environment(&lock, &runtime)
                .unwrap_err()
                .contains("requires babel-french")
        );
    }
    #[test]
    fn locks_are_strict_and_refuse_environment_drift() {
        let (catalog, runtime, _) = setup();
        let lock = catalog
            .environment(runtime.clone(), &["babel-romanian".into()])
            .unwrap();
        let json = serde_json::to_string(&lock).unwrap();
        assert_eq!(Lock::parse(&json).unwrap(), lock);
        assert!(Lock::parse(&json.replace("\"version\":1", "\"version\":2")).is_err());
        assert!(
            Lock::parse(&json.replace("\"version\":1", "\"unexpected\":true,\"version\":1"))
                .is_err()
        );
        let package = serde_json::to_string(&lock.packages["babel-romanian"]).unwrap();
        assert!(Lock::parse(&format!("{{\"version\":1,\"runtime\":{},\"packages\":{{\"babel-romanian\":{package},\"babel-romanian\":{package}}}}}",serde_json::to_string(&runtime).unwrap())).is_err());
        let mut changed = runtime.clone();
        changed.adapter_sha256 = "d".repeat(64);
        assert!(
            catalog
                .check_environment(&lock, &changed)
                .unwrap_err()
                .contains("different compiler")
        );
        let mut changed = lock.clone();
        changed.packages.get_mut("babel-romanian").unwrap().revision += 1;
        assert!(catalog.check_environment(&changed, &runtime).is_err());
        assert!(
            catalog
                .environment(runtime.clone(), &vec!["babel-romanian".into(); 65])
                .is_err()
        );
        assert!(
            catalog
                .environment(runtime, &["babel-romanian".into(), "babel-romanian".into()])
                .is_err()
        );
    }
    #[test]
    fn portable_bundles_verify_every_archive_and_reject_partial_or_extra_data() {
        let (catalog, runtime, archive) = setup();
        let lock = catalog
            .environment(runtime.clone(), &["babel-romanian".into()])
            .unwrap();
        let bytes = catalog
            .encode_environment(&lock, &runtime, &[archive.clone()])
            .unwrap();
        let (decoded, archives) = catalog.decode_environment(&bytes, &runtime).unwrap();
        assert_eq!(decoded, lock);
        assert_eq!(archives, vec![archive]);
        for cut in [0, MAGIC.len(), bytes.len() - 1] {
            assert!(catalog.decode_environment(&bytes[..cut], &runtime).is_err());
        }
        let mut bad = bytes.clone();
        *bad.last_mut().unwrap() ^= 1;
        assert!(
            catalog
                .decode_environment(&bad, &runtime)
                .unwrap_err()
                .contains("checksum")
        );
        let mut bad = bytes;
        bad.push(0);
        assert!(catalog.decode_environment(&bad, &runtime).is_err());
        let empty = catalog.environment(runtime.clone(), &[]).unwrap();
        let bytes = catalog.encode_environment(&empty, &runtime, &[]).unwrap();
        assert!(
            catalog
                .decode_environment(&bytes, &runtime)
                .unwrap()
                .1
                .is_empty()
        );
    }
}
