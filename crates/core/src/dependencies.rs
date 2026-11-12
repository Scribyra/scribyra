//! Declared upstream dependencies, separate from observed compiler requirements.
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet, VecDeque};

pub fn valid_name(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b))
}
fn hash(value: &str, length: usize) -> bool {
    value.len() == length
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "kebab-case", deny_unknown_fields)]
pub enum Provenance {
    Catalogue {
        package: String,
        revision: u32,
        sha256: String,
    },
    Archive {
        package: String,
        revision: u32,
        sha512: String,
    },
}
impl Provenance {
    pub fn validate(&self, revision: u32, sha512: &str) -> Result<(), String> {
        let valid = match self {
            Self::Catalogue {
                package,
                revision,
                sha256,
            } => valid_name(package) && *revision > 0 && hash(sha256, 64),
            Self::Archive {
                package,
                revision: declared,
                sha512: checksum,
            } => {
                valid_name(package)
                    && *declared == revision
                    && hash(checksum, 128)
                    && checksum == sha512
            }
        };
        if valid {
            Ok(())
        } else {
            Err("Invalid dependency provenance".into())
        }
    }
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Source {
    pub repository: String,
    pub commit: String,
    pub blob: String,
    pub raw_sha256: String,
    pub matched_runtime_packages: usize,
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Node {
    pub revision: u32,
    pub category: String,
    pub dependencies: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub requires: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub archive_sha512: Option<String>,
    pub has_binaries: bool,
}
#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Manifest {
    pub version: u8,
    pub snapshot: String,
    pub source: Source,
    pub packages: BTreeMap<String, Node>,
    pub overrides: BTreeMap<String, Node>,
}
impl Manifest {
    pub fn parse(json: &str, snapshot: &str) -> Result<Self, String> {
        if json.len() > 2 * 1024 * 1024 {
            return Err("Dependency manifest exceeds 2 MiB".into());
        }
        let value: Self = serde_json::from_str(json).map_err(|e| e.to_string())?;
        if value.version != 1
            || value.snapshot != snapshot
            || value.snapshot.len() > 128
            || value.packages.len() > 16000
            || value.overrides.len() > 128
            || value.source.repository.len() > 512
            || !value.source.repository.starts_with("git://")
                && !value.source.repository.starts_with("https://")
            || !hash(&value.source.commit, 40)
            || !hash(&value.source.blob, 40)
            || !hash(&value.source.raw_sha256, 64)
            || value.source.matched_runtime_packages > value.packages.len()
        {
            return Err("Invalid dependency manifest identity".into());
        }
        let known =
            |name: &String| value.packages.contains_key(name) || value.overrides.contains_key(name);
        for (name, node) in value.packages.iter().chain(&value.overrides) {
            if !valid_name(name)
                || !["Package", "TLCore", "Collection", "ConTeXt", "Scheme"]
                    .contains(&node.category.as_str())
                || node.dependencies.len() > 2048
                || node.requires.len() > 64
                || node.archive_sha512.as_ref().is_some_and(|h| !hash(h, 128))
                || node
                    .dependencies
                    .iter()
                    .chain(&node.requires)
                    .any(|d| !valid_name(d) || !known(d) && !d.ends_with(".ARCH"))
            {
                return Err("Invalid dependency node or undeclared dependency".into());
            }
        }
        Ok(value)
    }
    /// Declared closure only: ARCH placeholders are reported, never expanded into
    /// native executables or silently treated as installable browser packages.
    pub fn closure(&self, roots: &[String]) -> Result<serde_json::Value, String> {
        if roots.len() > 64 || roots.iter().any(|n| !valid_name(n)) {
            return Err("Invalid dependency roots".into());
        }
        let mut queue: VecDeque<_> = roots.iter().cloned().collect();
        let mut nodes = BTreeMap::new();
        let mut architecture = BTreeSet::new();
        while let Some(name) = queue.pop_front() {
            if nodes.contains_key(&name) {
                continue;
            }
            if name.ends_with(".ARCH") {
                architecture.insert(name);
                continue;
            }
            let node = self
                .overrides
                .get(&name)
                .or_else(|| self.packages.get(&name))
                .ok_or("Unknown upstream dependency package")?;
            if nodes.len() >= 4096 {
                return Err("Declared dependency closure exceeds 4096 packages".into());
            }
            queue.extend(node.dependencies.iter().chain(&node.requires).cloned());
            nodes.insert(name, node);
        }
        Ok(
            serde_json::json!({"packages":nodes,"architectureRequirements":architecture,"scope":"declared-dependencies-and-curated-prerequisites"}),
        )
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn declared_closures_bound_cycles_report_native_templates_and_reject_forged_names() {
        let json = serde_json::json!({"version":1,"snapshot":"test","source":{"repository":"git://example.test/texlive","commit":"a".repeat(40),"blob":"b".repeat(40),"rawSha256":"c".repeat(64),"matchedRuntimePackages":1},"packages":{"a":{"revision":1,"category":"Package","dependencies":["b","engine.ARCH"],"hasBinaries":false},"b":{"revision":1,"category":"Package","dependencies":["a"],"hasBinaries":false}},"overrides":{}});
        let graph = Manifest::parse(&json.to_string(), "test").unwrap();
        let result = graph.closure(&["a".into()]).unwrap();
        assert_eq!(result["packages"].as_object().unwrap().len(), 2);
        assert_eq!(
            result["architectureRequirements"],
            serde_json::json!(["engine.ARCH"])
        );
        assert!(graph.closure(&["missing".into()]).is_err());
        let mut bad = json;
        bad["packages"]["a"]["dependencies"] = serde_json::json!(["../escape"]);
        assert!(Manifest::parse(&bad.to_string(), "test").is_err());
        assert!(
            Provenance::Archive {
                package: "a".into(),
                revision: 1,
                sha512: "d".repeat(128)
            }
            .validate(1, &"e".repeat(128))
            .is_err()
        );
    }
}
