//! Frozen declared dependencies, checked against every original runtime pin.
use super::*;
use scribyra_core::dependencies::{
    Manifest as DependencyManifest, Node, Provenance, Source, valid_name,
};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Pin {
    version: u8,
    repository: String,
    commit: String,
    blob: String,
    snapshot: String,
    input: String,
    sha256: String,
    raw_sha256: String,
    runtime_packages: usize,
}
struct Record {
    node: Node,
    files: BTreeSet<String>,
}
#[derive(Default)]
pub(super) struct Dependencies {
    records: BTreeMap<String, Record>,
    source: Option<Source>,
}
fn parse(text: &str) -> Result<BTreeMap<String, Record>, String> {
    let mut result = BTreeMap::new();
    for block in text.split("\n\n") {
        let (mut name, mut revision, mut category) = (None, None, None);
        let mut runtime = false;
        let mut dependencies = BTreeSet::new();
        let mut files = BTreeSet::new();
        let mut binaries = false;
        for line in block.lines() {
            if line.len() > 16384 {
                return Err("TeX database line exceeds its bound".into());
            }
            if line.starts_with(' ') {
                if runtime {
                    let path = line.trim().strip_prefix("RELOC/").unwrap_or(line.trim());
                    let path = path.strip_prefix("texmf-dist/").unwrap_or(path);
                    if ["tex/", "fonts/", "bibtex/", "makeindex/"]
                        .iter()
                        .any(|p| path.starts_with(p))
                    {
                        files.insert(path.into());
                    }
                }
                continue;
            }
            let (key, value) = line.split_once(' ').unwrap_or((line, ""));
            runtime = key == "runfiles";
            match key {
                "name" => name = Some(value.to_string()),
                "revision" => {
                    revision = Some(
                        value
                            .parse::<u32>()
                            .map_err(|_| "Invalid source revision")?,
                    )
                }
                "category" => category = Some(value.to_string()),
                "depend" => {
                    dependencies.insert(value.to_string());
                }
                "binfiles" => binaries = true,
                _ => {}
            }
        }
        let Some(name) = name else { continue };
        // These are installation settings, not dependency-bearing packages.
        if name.starts_with("00texlive.") {
            continue;
        }
        if !valid_name(&name)
            || dependencies.len() > 2048
            || dependencies.iter().any(|d| !valid_name(d))
        {
            return Err("Invalid upstream dependency names".into());
        }
        let node = Node {
            revision: revision.ok_or("Missing source revision")?,
            category: category.ok_or("Missing source category")?,
            dependencies: dependencies.into_iter().collect(),
            requires: vec![],
            archive_sha512: None,
            has_binaries: binaries,
        };
        if result.insert(name, Record { node, files }).is_some() || result.len() > 16000 {
            return Err("Duplicate or excessive source packages".into());
        }
    }
    Ok(result)
}
impl Dependencies {
    pub fn load(project: &Path, upstream: &str) -> Result<Self, String> {
        let pin: Pin = serde_json::from_slice(
            &fs::read(project.join("scripts/tex-dependencies.json")).map_err(|e| e.to_string())?,
        )
        .map_err(|e| e.to_string())?;
        if pin.version != 1 || pin.input != "vendor/tex/catalog/texlive-master-2026-03-02.tlpdb.xz"
        {
            return Err("Unsupported dependency input".into());
        }
        let path = project.join(pin.input);
        if fs::metadata(&path).map_err(|e| e.to_string())?.len() > 8 * 1024 * 1024 {
            return Err("Dependency input exceeds 8 MiB".into());
        }
        let bytes = fs::read(path).map_err(|e| e.to_string())?;
        if hash(&bytes) != pin.sha256 {
            return Err("Dependency input checksum differs from its pin".into());
        }
        let mut raw = Vec::new();
        lzma_rust2::XzReader::new_mem_limit(bytes.as_slice(), false, 64 * 1024)
            .take(64 * 1024 * 1024 + 1)
            .read_to_end(&mut raw)
            .map_err(|e| e.to_string())?;
        if raw.len() > 64 * 1024 * 1024 || hash(&raw) != pin.raw_sha256 {
            return Err("Dependency database raw checksum differs from its pin".into());
        }
        let records =
            parse(std::str::from_utf8(&raw).map_err(|_| "Source database is not UTF-8")?)?;
        let source: serde_json::Value =
            serde_json::from_str(upstream).map_err(|e| e.to_string())?;
        let packages = source["packages"]
            .as_object()
            .ok_or("Missing pinned runtime packages")?;
        if source["snapshot"].as_str() != Some(pin.snapshot.as_str())
            || packages.len() != pin.runtime_packages
        {
            return Err("Dependency source and runtime snapshot differ".into());
        }
        for (name, package) in packages {
            let record = records
                .get(name)
                .ok_or_else(|| format!("Dependency source omits runtime package {name}"))?;
            let revision = package
                .get("runtimeRevision")
                .unwrap_or(&package["revision"])
                .as_u64()
                .ok_or("Invalid pinned runtime revision")?;
            let files: BTreeSet<String> = package["files"]
                .as_array()
                .ok_or("Missing runtime file list")?
                .iter()
                .map(|p| {
                    p.as_str()
                        .map(str::to_string)
                        .ok_or("Invalid runtime filename")
                })
                .collect::<Result<_, _>>()?;
            if revision != u64::from(record.node.revision) || files != record.files {
                return Err(format!(
                    "Dependency source changes the pinned runtime identity of {name}"
                ));
            }
        }
        let value = Self {
            records,
            source: Some(Source {
                repository: pin.repository,
                commit: pin.commit,
                blob: pin.blob,
                raw_sha256: pin.raw_sha256,
                matched_runtime_packages: packages.len(),
            }),
        };
        value.manifest(&pin.snapshot, &support::Support::default())?;
        Ok(value)
    }
    pub fn enrich(&self, merged: &mut serde_json::Value) -> Result<(), String> {
        let Some(source) = &self.source else {
            return Ok(());
        };
        for (name, package) in merged["packages"]
            .as_object_mut()
            .ok_or("Missing package map")?
        {
            let owner = if package["origin"] == "distribution" {
                name.strip_prefix("dist--").and_then(|n| {
                    if self.records.contains_key(n) {
                        Some(n)
                    } else {
                        n.split_once("--part-").map(|(n, _)| n)
                    }
                })
            } else {
                Some(name.as_str())
            };
            let Some((owner, record)) = owner.and_then(|n| self.records.get(n).map(|r| (n, r)))
            else {
                continue;
            };
            if !package["files"]
                .as_array()
                .ok_or("Missing component file list")?
                .iter()
                .all(|p| p.as_str().is_some_and(|p| record.files.contains(p)))
            {
                return Err("Distribution component changes upstream file ownership".into());
            }
            package["dependencies"] = serde_json::json!(record.node.dependencies);
            package["dependencyProvenance"] = serde_json::json!(Provenance::Catalogue {
                package: owner.into(),
                revision: record.node.revision,
                sha256: source.raw_sha256.clone()
            });
        }
        Ok(())
    }
    fn manifest(
        &self,
        snapshot: &str,
        support: &support::Support,
    ) -> Result<Option<DependencyManifest>, String> {
        let Some(source) = &self.source else {
            return Ok(None);
        };
        let overrides = support
            .packages
            .iter()
            .map(|(name, p)| {
                (
                    name.clone(),
                    Node {
                        revision: p.revision,
                        category: "Package".into(),
                        dependencies: p.dependencies.clone(),
                        requires: p.requires.clone(),
                        archive_sha512: Some(p.sha512.clone()),
                        has_binaries: false,
                    },
                )
            })
            .collect();
        let value = DependencyManifest {
            version: 1,
            snapshot: snapshot.into(),
            source: source.clone(),
            packages: self
                .records
                .iter()
                .map(|(n, r)| (n.clone(), r.node.clone()))
                .collect(),
            overrides,
        };
        let json = serde_json::to_string(&value).map_err(|e| e.to_string())?;
        Ok(Some(DependencyManifest::parse(&json, snapshot)?))
    }
    pub fn publish(
        &self,
        root: &Path,
        snapshot: &str,
        support: &support::Support,
    ) -> Result<Option<Asset>, String> {
        let Some(value) = self.manifest(snapshot, support)? else {
            return Ok(None);
        };
        let bytes = serde_json::to_vec(&value).map_err(|e| e.to_string())?;
        let sha256 = hash(&bytes);
        let path = format!("metadata/{sha256}.json");
        write_if_changed(&root.join(&path), &bytes)?;
        println!(
            "Declared dependencies: {} source nodes, {} overrides; {} runtime identities matched.",
            value.packages.len(),
            value.overrides.len(),
            value.source.matched_runtime_packages
        );
        Ok(Some(Asset {
            path,
            size: bytes.len(),
            sha256,
        }))
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn frozen_dependencies_match_every_runtime_pin_and_reject_a_changed_revision() {
        let project = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
        let mut json = String::new();
        flate2::read::GzDecoder::new(&include_bytes!("../../../web/tex-catalog.json.gz")[..])
            .read_to_string(&mut json)
            .unwrap();
        let source = Dependencies::load(&project, &json).unwrap();
        assert_eq!(
            source.source.as_ref().unwrap().matched_runtime_packages,
            4218
        );
        assert!(
            source.records["fontspec"]
                .node
                .dependencies
                .contains(&"lm".into())
        );
        let manifest = source
            .manifest("test", &support::Support::default())
            .unwrap()
            .unwrap();
        assert!(manifest.packages.len() > 8000);
        let mut bad: serde_json::Value = serde_json::from_str(&json).unwrap();
        bad["packages"]["fontspec"]["revision"] = 1.into();
        assert!(
            Dependencies::load(&project, &bad.to_string())
                .err()
                .unwrap()
                .contains("fontspec")
        );
    }
}
