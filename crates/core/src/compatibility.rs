//! An immutable browser compiler/format release, authenticated by the catalog root.
use crate::environment::Runtime;
use serde::{Deserialize, Serialize};
pub const FORMAT_PATH: &str = "/texlive/texmf-dist/texmf-var/web2c/luahbtex/luahblatex.fmt";
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct File {
    pub path: String,
    pub size: usize,
    pub sha256: String,
}
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Format {
    pub name: String,
    pub path: String,
    pub size: usize,
    pub sha256: String,
}
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Manifest {
    pub version: u8,
    pub source_archive_sha256: String,
    pub engine: String,
    pub implementation: String,
    pub implementation_version: String,
    pub binary: File,
    pub format: Format,
    pub package_policy: String,
    pub format_rebuilding: bool,
    pub shell_escape: bool,
}
fn hash(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
impl Manifest {
    pub fn parse(json: &str) -> Result<Self, String> {
        if json.len() > 8192 {
            return Err("Compiler compatibility metadata exceeds 8 KiB".into());
        }
        let value: Self = serde_json::from_str(json).map_err(|e| e.to_string())?;
        if value.version != 1
            || value.engine != "lualatex"
            || value.implementation != "LuaHBTeX"
            || value.implementation_version.is_empty()
            || value.implementation_version.len() > 32
            || !value
                .implementation_version
                .bytes()
                .all(|b| b.is_ascii_digit() || b == b'.')
            || !hash(&value.source_archive_sha256)
            || value.binary.path != "busytex.wasm"
            || value.binary.size == 0
            || value.binary.size > 128 * 1024 * 1024
            || !hash(&value.binary.sha256)
            || value.format.name != "luahblatex"
            || value.format.path != FORMAT_PATH
            || value.format.size == 0
            || value.format.size > 32 * 1024 * 1024
            || !hash(&value.format.sha256)
            || value.package_policy != "release-pinned"
            || value.format_rebuilding
            || value.shell_escape
        {
            return Err("Unsupported compiler/format compatibility metadata".into());
        }
        Ok(value)
    }
    pub fn check(&self, runtime: &Runtime, binary: Option<&File>) -> Result<(), String> {
        runtime.validate()?;
        if self.engine != runtime.engine
            || self.source_archive_sha256 != runtime.distribution_sha256
            || binary.is_some_and(|expected| expected != &self.binary)
        {
            return Err("Compiler/format metadata requires a different runtime".into());
        }
        Ok(())
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn a_release_pins_the_engine_format_and_policy_without_enabling_unavailable_capabilities() {
        let json = include_str!("../../../scripts/tex-compiler.json");
        let manifest = Manifest::parse(json).unwrap();
        let mut runtime = Runtime {
            engine: "lualatex".into(),
            snapshot: "test".into(),
            distribution_sha256: manifest.source_archive_sha256.clone(),
            adapter_sha256: "a".repeat(64),
            catalog_sha256: "b".repeat(64),
        };
        manifest.check(&runtime, Some(&manifest.binary)).unwrap();
        let mut other = manifest.binary.clone();
        other.sha256 = "c".repeat(64);
        assert!(manifest.check(&runtime, Some(&other)).is_err());
        runtime.distribution_sha256 = "d".repeat(64);
        assert!(manifest.check(&runtime, None).is_err());
        for (field, value) in [
            ("engine", serde_json::json!("xelatex")),
            ("formatRebuilding", serde_json::json!(true)),
            ("shellEscape", serde_json::json!(true)),
        ] {
            let mut bad: serde_json::Value = serde_json::from_str(json).unwrap();
            bad[field] = value;
            assert!(Manifest::parse(&bad.to_string()).is_err());
        }
    }
}
