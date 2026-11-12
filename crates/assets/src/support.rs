//! Reproducible optional upstream support archives; no build/runtime install service.
use super::*;
use scribyra_core::packages::{Catalog as RuntimeCatalog, Package as RuntimePackage};
use sha2::Sha512;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Recipe {
    version: u8,
    snapshot: String,
    repository: String,
    compiler_archive_sha256: String,
    packages: BTreeMap<String, Pin>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Pin {
    revision: u32,
    size: usize,
    sha512: String,
    license: String,
    source_archive: Option<Archive>,
    #[serde(default)]
    requires: Vec<String>,
    #[serde(default)]
    languages: Vec<String>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Archive {
    size: usize,
    sha512: String,
}
#[derive(Default)]
pub(super) struct Support {
    pub packages: BTreeMap<String, RuntimePackage>,
    pub suffix: Option<String>,
    pub provenance: serde_json::Value,
    pub languages: BTreeMap<String, Vec<String>>,
}
impl Support {
    pub fn snapshot(&self, base: &str) -> String {
        self.suffix
            .as_ref()
            .map_or_else(|| base.into(), |suffix| format!("{base}+support-{suffix}"))
    }
}
fn name(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"-._".contains(&b))
}
fn verified(path: &Path, size: usize, checksum: &str) -> Result<Vec<u8>, String> {
    if size > scribyra_core::packages::MAX_ARCHIVE
        || checksum.len() != 128
        || !checksum
            .bytes()
            .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
    {
        return Err("Invalid pinned support archive descriptor".into());
    }
    let bytes = fs::read(path)
        .map_err(|e| format!("Missing vendored support archive {}: {e}", path.display()))?;
    if bytes.len() != size || format!("{:x}", Sha512::digest(&bytes)) != checksum {
        return Err(format!(
            "Support archive checksum/size mismatch: {}",
            path.display()
        ));
    }
    Ok(bytes)
}
fn metadata(package: &str, bytes: &[u8], pin: &Pin) -> Result<RuntimePackage, String> {
    let mut decoded = Vec::new();
    lzma_rust2::XzReader::new_mem_limit(bytes, false, 64 * 1024)
        .take(96 * 1024 * 1024 + 1)
        .read_to_end(&mut decoded)
        .map_err(|e| e.to_string())?;
    if decoded.len() > 96 * 1024 * 1024 {
        return Err("Support archive expansion exceeds 96 MiB".into());
    }
    let mut object = None;
    let target = format!("tlpkg/tlpobj/{package}.tlpobj");
    for (i, entry) in tar::Archive::new(decoded.as_slice())
        .entries()
        .map_err(|e| e.to_string())?
        .enumerate()
    {
        if i > 50_000 {
            return Err("Support archive has too many entries".into());
        }
        let mut entry = entry.map_err(|e| e.to_string())?;
        if entry.path_bytes().as_ref() == target.as_bytes() {
            if object.is_some()
                || !entry.header().entry_type().is_file()
                || entry.size() > 1024 * 1024
            {
                return Err("Invalid support package metadata".into());
            }
            let mut text = String::new();
            entry.read_to_string(&mut text).map_err(|e| e.to_string())?;
            object = Some(text);
        }
    }
    let text = object.ok_or("Support archive has no package metadata")?;
    let field = |key: &str| text.lines().find_map(|line| line.strip_prefix(key));
    if field("name ") != Some(package)
        || field("revision ").and_then(|s| s.parse::<u32>().ok()) != Some(pin.revision)
    {
        return Err("Support archive revision/name differs from its pin".into());
    }
    let mut files = Vec::new();
    let mut runtime = false;
    let mut dependencies = BTreeSet::new();
    for line in text.lines() {
        if line.starts_with("binfiles ") {
            return Err(
                "Curated language support cannot include native binary declarations".into(),
            );
        }
        if let Some(dep) = line.strip_prefix("depend ") {
            if !name(dep) {
                return Err("Invalid support dependency".into());
            }
            dependencies.insert(dep.into());
        }
        if line.starts_with(' ') {
            if runtime {
                let path = line.trim().strip_prefix("RELOC/").unwrap_or(line.trim());
                let path = path.strip_prefix("texmf-dist/").unwrap_or(path);
                if ["tex/", "fonts/", "bibtex/", "makeindex/"]
                    .iter()
                    .any(|prefix| path.starts_with(prefix))
                {
                    files.push(path.into());
                }
            }
        } else {
            runtime = line.starts_with("runfiles ");
        }
    }
    if files.is_empty() {
        return Err("Support archive contains no browser runtime files".into());
    }
    let package = RuntimePackage {
        revision: pin.revision,
        size: pin.size,
        sha512: pin.sha512.clone(),
        files,
        archive: Some(format!("components/{}.tar.xz", pin.sha512)),
        dependencies: dependencies.into_iter().collect(),
        requires: pin.requires.clone(),
        dependency_provenance: Some(scribyra_core::dependencies::Provenance::Archive {
            package: package.into(),
            revision: pin.revision,
            sha512: pin.sha512.clone(),
        }),
        ..Default::default()
    };
    // Use exactly the same SHA-512/XZ/TAR/path/entry verifier as the browser.
    let catalog = RuntimeCatalog::new(
        &serde_json::json!({"snapshot":"support-verification","packages":{"verify":package}})
            .to_string(),
    )?;
    catalog.unpack("verify", bytes)?;
    Ok(catalog.packages["verify"].clone())
}
pub(super) fn publish(root: &Path, compiler_sha: &str) -> Result<Support, String> {
    let recipe_bytes = fs::read("scripts/tex-support.json").map_err(|e| e.to_string())?;
    let recipe: Recipe = serde_json::from_slice(&recipe_bytes).map_err(|e| e.to_string())?;
    if recipe.version != 1
        || recipe.compiler_archive_sha256 != compiler_sha
        || recipe.packages.len() > 128
        || recipe.snapshot.len() != 10
        || !recipe
            .snapshot
            .bytes()
            .all(|b| b.is_ascii_digit() || b == b'-')
        || !recipe.repository.starts_with("https://")
        || recipe.repository.contains(['\n', '\r', '?', '#'])
    {
        return Err("Invalid support recipe or compiler identity".into());
    }
    fs::create_dir_all(root.join("components")).map_err(|e| e.to_string())?;
    let mut packages = BTreeMap::new();
    let mut languages = BTreeMap::new();
    for pin in recipe.packages.values() {
        if pin
            .requires
            .iter()
            .any(|name| !recipe.packages.contains_key(name))
        {
            return Err("Required support package is not pinned in this recipe".into());
        }
    }
    let mut assets = Vec::new();
    let mut licenses = BTreeMap::new();
    for (name, pin) in recipe.packages {
        if !self::name(&name) {
            return Err("Invalid support package name".into());
        }
        let bytes = verified(
            &Path::new("vendor/tex/support").join(format!("{name}.tar.xz")),
            pin.size,
            &pin.sha512,
        )?;
        let package = metadata(&name, &bytes, &pin)?;
        for language in &pin.languages {
            if languages
                .insert(language.clone(), vec![name.clone()])
                .is_some()
            {
                return Err("Ambiguous support language owner".into());
            }
        }
        let path = package.archive.as_ref().unwrap().clone();
        write_if_changed(&root.join(&path), &bytes)?;
        assets.push(Asset {
            path,
            size: bytes.len(),
            sha256: hash(&bytes),
        });
        if let Some(source) = pin.source_archive {
            let bytes = verified(
                &Path::new("vendor/tex/support").join(format!("{name}.source.tar.xz")),
                source.size,
                &source.sha512,
            )?;
            let path = format!("components/{}.source.tar.xz", source.sha512);
            write_if_changed(&root.join(&path), &bytes)?;
            assets.push(Asset {
                path,
                size: bytes.len(),
                sha256: hash(&bytes),
            });
        }
        licenses.insert(name.clone(), pin.license);
        packages.insert(name, package);
    }
    let provenance = serde_json::json!({"snapshot":recipe.snapshot,"engine":"lualatex","compilerArchiveSha256":compiler_sha,"repository":recipe.repository,"recipeSha256":hash(&recipe_bytes),"assets":assets,"licenses":licenses});
    Ok(Support {
        packages,
        suffix: Some(recipe.snapshot),
        provenance,
        languages,
    })
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn vendored_support_pins_include_runtime_metadata_sources_and_reject_tampering() {
        let recipe: Recipe =
            serde_json::from_str(include_str!("../../../scripts/tex-support.json")).unwrap();
        for (name, pin) in recipe.packages {
            let path = Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("../../vendor/tex/support")
                .join(format!("{name}.tar.xz"));
            let mut bytes = verified(&path, pin.size, &pin.sha512).unwrap();
            let package = metadata(&name, &bytes, &pin).unwrap();
            assert!(!package.files.is_empty());
            assert_eq!(
                package.archive,
                Some(format!("components/{}.tar.xz", pin.sha512))
            );
            bytes[0] ^= 1;
            assert!(metadata(&name, &bytes, &pin).is_err());
            if let Some(source) = pin.source_archive {
                verified(
                    &path.with_file_name(format!("{name}.source.tar.xz")),
                    source.size,
                    &source.sha512,
                )
                .unwrap();
            }
        }
    }
}
