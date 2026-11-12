//! Compiler-matched TeX Live resolution and bounded, memory-only archive extraction.
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256, Sha512};
use std::{
    collections::{BTreeMap, BTreeSet},
    io::Read,
};
use unicode_normalization::UnicodeNormalization;

pub const MAX_ARCHIVE: usize = 32 * 1024 * 1024;
pub const MAX_EXPANDED: usize = 96 * 1024 * 1024;
#[derive(Deserialize, Serialize, Clone, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Package {
    pub revision: u32,
    pub size: usize,
    pub sha512: String,
    pub files: Vec<String>,
    #[serde(default)]
    pub origin: Source,
    #[serde(default)]
    pub label: Option<String>,
    /// Optional same-origin replica of this exact upstream archive.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub archive: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub dependencies: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dependency_provenance: Option<crate::dependencies::Provenance>,
    /// Additional compiler-tested prerequisites from the static support recipe.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub requires: Vec<String>,
}
#[derive(Deserialize, Serialize, Clone, Copy, Default, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Source {
    #[default]
    Texlive,
    Distribution,
}
#[derive(Deserialize, Serialize)]
pub struct Catalog {
    pub snapshot: String,
    pub packages: BTreeMap<String, Package>,
    #[serde(default, rename = "fontFamilies")]
    pub font_families: BTreeMap<String, Vec<String>>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub languages: BTreeMap<String, Vec<String>>,
    #[serde(skip)]
    index: BTreeMap<String, Vec<(String, String)>>,
    #[serde(skip)]
    decoded_bytes: usize,
}
/// Lua font names ignore spaces and punctuation. The native asset generator and
/// the WASM resolver use the same Unicode normalization for exact known aliases.
pub fn font_key(name: &str) -> String {
    name.nfc()
        .flat_map(char::to_lowercase)
        .filter(|c| c.is_alphanumeric())
        .collect()
}
#[derive(Clone, Deserialize, Serialize)]
pub struct Lookup {
    pub name: String,
    pub format: u32,
}
impl Catalog {
    pub fn new(json: &str) -> Result<Self, String> {
        if json.len() > 20 * 1024 * 1024 {
            return Err("Package catalog is too large".into());
        }
        let mut catalog: Self = serde_json::from_str(json).map_err(|e| e.to_string())?;
        for (name, package) in &catalog.packages {
            if let Some(provenance) = &package.dependency_provenance {
                provenance.validate(package.revision, &package.sha512)?;
            }
            if !name
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || b"-._".contains(&c))
                || name.is_empty()
                || package.sha512.len() != 128
                || !package.sha512.bytes().all(|b| b.is_ascii_hexdigit())
            {
                return Err("Invalid package catalog".into());
            }
            if package
                .archive
                .as_ref()
                .is_some_and(|path| path != &format!("components/{}.tar.xz", package.sha512))
                || package.dependencies.len() > 256
                || package.requires.len() > 64
                || package
                    .dependencies
                    .iter()
                    .chain(&package.requires)
                    .any(|dep| {
                        dep.is_empty()
                            || dep.len() > 128
                            || !dep
                                .bytes()
                                .all(|c| c.is_ascii_alphanumeric() || b"-._".contains(&c))
                    })
            {
                return Err("Invalid package archive or dependency manifest".into());
            }
            for path in &package.files {
                if !safe_path(path) {
                    return Err("Unsafe catalog path".into());
                }
                let basename = path.rsplit('/').next().unwrap();
                catalog
                    .index
                    .entry(basename.into())
                    .or_default()
                    .push((name.clone(), path.clone()));
            }
        }
        catalog.validate_fonts(&catalog.font_families)?;
        catalog.validate_languages(&catalog.languages)?;
        catalog.decoded_bytes = json.len();
        Ok(catalog)
    }
    fn validate_fonts(&self, families: &BTreeMap<String, Vec<String>>) -> Result<(), String> {
        for (family, packages) in families {
            if family.is_empty()
                || family.len() > 512
                || font_key(family) != *family
                || packages.is_empty()
                || packages.len() > 64
                || packages.iter().any(|name| {
                    !self
                        .packages
                        .get(name)
                        .is_some_and(|p| p.origin == Source::Distribution)
                })
            {
                return Err("Invalid distribution font family index".into());
            }
        }
        Ok(())
    }
    /// Validated immutable shards may be added once; conflicts fail atomically.
    pub fn merge(&mut self, json: &str) -> Result<(), String> {
        let part = Self::new(json)?;
        if part.snapshot != self.snapshot
            || !part.font_families.is_empty()
            || !part.languages.is_empty()
        {
            return Err("Metadata shard snapshot or shape differs from this catalog".into());
        }
        let mut added = BTreeSet::new();
        for (name, package) in &part.packages {
            match self.packages.get(name) {
                Some(existing) if existing != package => {
                    return Err("Conflicting immutable package metadata".into());
                }
                None => {
                    added.insert(name.clone());
                }
                _ => {}
            }
        }
        if added.is_empty() {
            return Ok(());
        }
        if self.decoded_bytes.saturating_add(json.len()) > 20 * 1024 * 1024 {
            return Err("Loaded package metadata exceeds 20 MiB".into());
        }
        self.decoded_bytes += json.len();
        for (basename, candidates) in part.index {
            self.index.entry(basename).or_default().extend(
                candidates
                    .into_iter()
                    .filter(|(name, _)| added.contains(name)),
            );
        }
        self.packages.extend(part.packages);
        Ok(())
    }
    pub fn add_fonts(&mut self, json: &str) -> Result<(), String> {
        if json.len() > 256 * 1024 {
            return Err("Font index is too large".into());
        }
        let families: BTreeMap<String, Vec<String>> =
            serde_json::from_str(json).map_err(|e| e.to_string())?;
        self.validate_fonts(&families)?;
        for (name, packages) in &families {
            if self
                .font_families
                .get(name)
                .is_some_and(|old| old != packages)
            {
                return Err("Conflicting immutable font metadata".into());
            }
        }
        self.font_families.extend(families);
        Ok(())
    }
    fn validate_languages(&self, languages: &BTreeMap<String, Vec<String>>) -> Result<(), String> {
        if languages.len() > 1024
            || languages.iter().any(|(name, owners)| {
                name.is_empty()
                    || name.len() > 64
                    || !name
                        .bytes()
                        .all(|b| b.is_ascii_alphanumeric() || b"-_".contains(&b))
                    || owners.is_empty()
                    || owners.len() > 64
                    || owners
                        .iter()
                        .any(|owner| !self.packages.contains_key(owner))
            })
        {
            return Err("Invalid language package index".into());
        }
        Ok(())
    }
    pub fn add_languages(&mut self, json: &str) -> Result<(), String> {
        if json.len() > 256 * 1024 {
            return Err("Language index is too large".into());
        }
        let languages: BTreeMap<String, Vec<String>> =
            serde_json::from_str(json).map_err(|e| e.to_string())?;
        self.validate_languages(&languages)?;
        if languages
            .iter()
            .any(|(name, owners)| self.languages.get(name).is_some_and(|old| old != owners))
        {
            return Err("Conflicting immutable language metadata".into());
        }
        self.languages.extend(languages);
        Ok(())
    }
    pub fn package_info(&self, names: &[String]) -> Result<serde_json::Value, String> {
        if names.len() > 64 {
            return Err("Too many TeX packages requested".into());
        }
        names.iter().map(|name| {
            let p = self.packages.get(name).ok_or("Unknown package in TeX environment")?;
            let mut info=serde_json::json!({"name":name,"revision":p.revision,"size":p.size,"sha512":p.sha512,"origin":p.origin,"label":p.label});
            if let Some(path)=&p.archive{info["archive"]=path.as_str().into();}
            if !p.dependencies.is_empty()||p.dependency_provenance.is_some(){info["dependencies"]=serde_json::json!(p.dependencies);}
            if let Some(provenance)=&p.dependency_provenance{info["dependencyProvenance"]=serde_json::json!(provenance);}
            if !p.requires.is_empty(){info["requires"]=serde_json::json!(p.requires);}
            Ok(info)
        }).collect::<Result<Vec<_>, String>>().map(serde_json::Value::from)
    }
    /// Kpathsea has already searched bundled and project files. Prefer LuaLaTeX's
    /// TDS paths; ambiguous files at equal priority must never be guessed.
    pub fn resolve(&self, requests: &[Lookup]) -> Vec<String> {
        let mut result = BTreeSet::new();
        for request in requests.iter().take(2048) {
            if !crate::valid_path(&request.name) {
                continue;
            }
            let extensions = extensions(request.format);
            for extension in extensions {
                let name = format!("{}{extension}", request.name);
                let basename = name.rsplit('/').next().unwrap();
                let Some(candidates) = self.index.get(basename) else {
                    continue;
                };
                let mut ranked: Vec<_> = candidates
                    .iter()
                    .filter(|(_, path)| {
                        (!name.contains('/') || path.ends_with(&format!("/{name}")))
                            && match request.format {
                                26 => path.starts_with("tex/"),
                                51 => path.ends_with(".lua") || path.ends_with(".luc"),
                                _ => true,
                            }
                    })
                    .map(|(package, path)| {
                        (
                            (
                                if self.packages[package].origin == Source::Distribution {
                                    0
                                } else {
                                    1
                                },
                                priority(path),
                            ),
                            package,
                        )
                    })
                    .collect();
                ranked.sort();
                if let Some((rank, package)) = ranked.first() {
                    if ranked
                        .iter()
                        .filter(|(r, _)| r == rank)
                        .all(|(_, p)| p == package)
                    {
                        result.insert((*package).clone());
                    }
                    break;
                }
            }
        }
        result.into_iter().collect()
    }
    /// Some LuaTeX/LaTeX probes bypass the upstream kpse_find_file wrapper.
    /// Recover only filenames explicitly reported by a failed compile, before
    /// considering general missing lookups (which can include optional probes).
    pub fn resolve_failure(&self, requests: &[Lookup], log: &str) -> Vec<String> {
        let (requests, families) = failure_queries(requests, log);
        let mut result = if families.is_empty() {
            self.resolve(&requests)
        } else {
            families
                .iter()
                .filter_map(|name| self.font_families.get(name))
                .flatten()
                .cloned()
                .collect::<BTreeSet<_>>()
                .into_iter()
                .collect()
        }
        .into_iter()
        .collect::<BTreeSet<_>>();
        for language in crate::diagnostics::missing_languages(log) {
            if let Some(owners) = self.languages.get(&language) {
                result.extend(owners.iter().cloned());
            }
        }
        result.into_iter().collect()
    }
    pub fn unpack(&self, name: &str, bytes: &[u8]) -> Result<Vec<(String, Vec<u8>)>, String> {
        let package = self.packages.get(name).ok_or("Unknown TeX package")?;
        if bytes.len() != package.size || bytes.len() > MAX_ARCHIVE {
            return Err("Package archive size differs from the pinned catalog".into());
        }
        if format!("{:x}", Sha512::digest(bytes)) != package.sha512 {
            return Err("Package checksum differs from the compiler snapshot".into());
        }
        let decoder = lzma_rust2::XzReader::new_mem_limit(bytes, false, 64 * 1024);
        let mut decoded = Vec::new();
        decoder
            .take(MAX_EXPANDED as u64 + 1)
            .read_to_end(&mut decoded)
            .map_err(|e| e.to_string())?;
        if decoded.len() > MAX_EXPANDED {
            return Err("Expanded package exceeds 96 MiB".into());
        }
        extract(package, &decoded)
    }
}
/// Stable bucket selection shared by the native publisher and browser resolver.
pub fn metadata_bucket(value: &str) -> String {
    format!("{:02x}", Sha256::digest(value.as_bytes())[0])
}
fn extensions(format: u32) -> &'static [&'static str] {
    match format {
        26 => &["", ".tex"],
        51 => &["", ".lua", ".luc"],
        3 => &["", ".tfm"],
        33 => &["", ".vf"],
        32 => &["", ".pfb", ".pfa"],
        36 => &["", ".ttf", ".ttc"],
        47 => &["", ".otf"],
        4 => &["", ".afm"],
        6 => &["", ".bib"],
        7 => &["", ".bst"],
        44 => &["", ".enc"],
        11 => &["", ".map"],
        _ => &[""],
    }
}
fn failure_queries(requests: &[Lookup], log: &str) -> (Vec<Lookup>, Vec<String>) {
    if !crate::diagnostics::package_resolution_allowed(log) {
        return (vec![], vec![]);
    }
    let mut required = Vec::new();
    for (pattern, suffix, format) in [
        (
            r"(?:LaTeX Error: File|I can't find file)\s*[`']([^'`\r\n]+)['`]",
            "",
            26,
        ),
        (
            r"Package babel Error: Unknown option [`']([^'`\r\n]+)['`]",
            ".ldf",
            26,
        ),
        (r"module '([^'\r\n]+)' not found", ".lua", 51),
        (r"I couldn't open style file ([^\s]+)", "", 7),
    ] {
        for capture in regex::Regex::new(pattern)
            .unwrap()
            .captures_iter(log)
            .take(32)
        {
            let matched_name = format!("{}{suffix}", &capture[1]);
            let actual_format = if matched_name.ends_with(".bst") {
                7
            } else if matched_name.ends_with(".tfm") {
                3
            } else if matched_name.ends_with(".otf") {
                47
            } else if matched_name.ends_with(".ttf") {
                36
            } else {
                format
            };
            required.push(Lookup {
                name: matched_name,
                format: actual_format,
            });
            if format == 51 && capture[1].contains('.') {
                required.push(Lookup {
                    name: format!("{}.lua", capture[1].replace('.', "/")),
                    format: 51,
                });
            }
        }
    }
    if !required.is_empty() {
        return (required, vec![]);
    }
    // These source errors do not identify a missing package. Optional Kpathsea
    // probes must not mask the error or force metadata downloads while offline.
    if log.contains("! Undefined control sequence.")
        || log.contains("! Improper discretionary list.")
    {
        return (vec![], vec![]);
    }
    let families: BTreeSet<_> = crate::diagnostics::missing_fonts(log)
        .iter()
        .map(|name| font_key(name))
        .collect();
    if !families.is_empty() {
        (vec![], families.into_iter().collect())
    } else {
        (
            requests
                .iter()
                .take(2048)
                .filter(|request| {
                    !log.contains("Metric (TFM) file not found")
                        || [3, 4, 11, 32, 33, 36, 44, 47].contains(&request.format)
                })
                .cloned()
                .collect(),
            vec![],
        )
    }
}
#[derive(Serialize)]
pub struct MetadataQuery {
    pub name: String,
    pub bucket: String,
}
#[derive(Serialize)]
pub struct MetadataPlan {
    pub files: Vec<MetadataQuery>,
    pub fonts: Vec<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub languages: Vec<String>,
}
pub fn metadata_plan(requests: &[Lookup], log: &str) -> Result<MetadataPlan, String> {
    if requests.len() > 2048 || log.len() > 8 * 1024 * 1024 {
        return Err("TeX lookup input exceeds its limit".into());
    }
    let (requests, fonts) = failure_queries(requests, log);
    let mut names = BTreeSet::new();
    for request in requests {
        if !crate::valid_path(&request.name) {
            continue;
        }
        for extension in extensions(request.format) {
            let name = format!("{}{extension}", request.name);
            names.insert(name.rsplit('/').next().unwrap().to_string());
        }
    }
    Ok(MetadataPlan {
        files: names
            .into_iter()
            .map(|name| MetadataQuery {
                bucket: metadata_bucket(&name),
                name,
            })
            .collect(),
        fonts,
        languages: crate::diagnostics::missing_languages(log),
    })
}

fn priority(path: &str) -> u8 {
    for (i, prefix) in [
        "tex/lualatex/",
        "tex/latex/",
        "tex/luatex/",
        "tex/generic/",
        "fonts/",
        "bibtex/",
    ]
    .iter()
    .enumerate()
    {
        if path.starts_with(prefix) {
            return i as u8;
        }
    }
    10
}
fn safe_path(path: &str) -> bool {
    crate::valid_path(path)
        && ["tex/", "fonts/", "bibtex/", "makeindex/"]
            .iter()
            .any(|p| path.starts_with(p))
}
fn extract(package: &Package, decoded: &[u8]) -> Result<Vec<(String, Vec<u8>)>, String> {
    let expected: BTreeSet<_> = package.files.iter().map(String::as_str).collect();
    let mut seen = BTreeSet::new();
    let mut output = Vec::new();
    let mut archive = tar::Archive::new(decoded);
    for (count, entry) in archive.entries().map_err(|e| e.to_string())?.enumerate() {
        if count > 50_000 {
            return Err("Too many archive entries".into());
        }
        let mut entry = entry.map_err(|e| e.to_string())?;
        let raw = String::from_utf8(entry.path_bytes().into_owned())
            .map_err(|_| "Non-UTF-8 archive path")?;
        let path = raw
            .strip_prefix("texmf-dist/")
            .or_else(|| raw.strip_prefix("RELOC/"))
            .unwrap_or(&raw);
        let kind = entry.header().entry_type();
        if !crate::valid_path(path.trim_end_matches('/')) || !(kind.is_file() || kind.is_dir()) {
            return Err("Unsafe TeX archive entry".into());
        }
        if kind.is_dir() {
            continue;
        }
        if !expected.contains(path) {
            continue;
        } // tlpkg metadata, executables and non-runtime files are never installed.
        if !safe_path(path) || !seen.insert(path.to_string()) {
            return Err("Unsafe or duplicate runtime path".into());
        }
        let mut content = Vec::new();
        entry.read_to_end(&mut content).map_err(|e| e.to_string())?;
        output.push((path.to_string(), content));
    }
    if seen.len() != expected.len() {
        return Err("Package archive is missing catalogued runtime files".into());
    }
    Ok(output)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn incremental_metadata_preserves_resolution_and_rejects_conflicts_atomically() {
        let mut catalog = Catalog::new(r#"{"snapshot":"test","packages":{}}"#).unwrap();
        let package = serde_json::json!({"revision":1,"size":12,"sha512":"0".repeat(128),"files":["tex/latex/test/shared.sty"],"origin":"distribution"});
        let part = serde_json::json!({"snapshot":"test","packages":{"dist--test":package}});
        catalog.merge(&part.to_string()).unwrap();
        catalog.merge(&part.to_string()).unwrap();
        assert_eq!(catalog.index["shared.sty"].len(), 1);
        let requests = [Lookup {
            name: "shared.sty".into(),
            format: 26,
        }];
        assert_eq!(catalog.resolve(&requests), vec!["dist--test"]);
        let mut conflict = part.clone();
        conflict["packages"]["dist--test"]["revision"] = 2.into();
        conflict["packages"]["new"] = package.clone();
        assert!(catalog.merge(&conflict.to_string()).is_err());
        assert!(!catalog.packages.contains_key("new"));
        let mut other = part.clone();
        other["snapshot"] = "other".into();
        assert!(catalog.merge(&other.to_string()).is_err());
        catalog
            .add_fonts(r#"{"testfamily":["dist--test"]}"#)
            .unwrap();
        assert!(catalog.add_fonts(r#"{"unknown":["absent"]}"#).is_err());
        assert!(!catalog.font_families.contains_key("unknown"));
        let info = catalog.package_info(&["dist--test".into()]).unwrap();
        assert!(info[0].get("files").is_none());
        assert_eq!(info[0]["name"], "dist--test");
        assert_eq!(metadata_bucket("abc"), "ba");
        let plan =
            metadata_plan(&requests, "! LaTeX Error: File `romanian.ldf' not found.").unwrap();
        assert!(plan.files.iter().any(|file| file.name == "romanian.ldf"));
        assert!(!plan.files.iter().any(|file| file.name == "shared.sty"));
        assert!(
            metadata_plan(&requests, "! Undefined control sequence.")
                .unwrap()
                .files
                .is_empty()
        );
        assert!(
            metadata_plan(&requests, "! Improper discretionary list.")
                .unwrap()
                .files
                .is_empty()
        );
        assert_eq!(
            metadata_plan(&requests, r#"The font "TeX Gyre Pagella" cannot be found"#)
                .unwrap()
                .fonts,
            vec!["texgyrepagella"]
        );
    }
    #[test]
    fn distribution_versions_win_and_font_families_use_known_metadata_only() {
        let pkg = |origin: &str| serde_json::json!({"revision":0,"size":10,"sha512":"0".repeat(128),"files":["tex/latex/test/file.sty"],"origin":origin});
        let mut json = serde_json::json!({"snapshot":"test","packages":{"mirror":pkg("texlive"),"dist--test":pkg("distribution")},"fontFamilies":{"texgyrepagella":["dist--test"]}});
        let c = Catalog::new(&json.to_string()).unwrap();
        let requests = [Lookup {
            name: "file.sty".into(),
            format: 26,
        }];
        assert_eq!(c.resolve(&requests), vec!["dist--test"]);
        assert_eq!(
            c.resolve_failure(&requests, "The font \"TeX Gyre Pagella\" cannot be found"),
            vec!["dist--test"]
        );
        assert!(
            c.resolve_failure(&requests, "The font \"Unknown Family\" cannot be found")
                .is_empty()
        );
        json["packages"]["dist--other"] = pkg("distribution");
        assert!(
            Catalog::new(&json.to_string())
                .unwrap()
                .resolve(&requests)
                .is_empty()
        );
        json["fontFamilies"]["unknown"] = serde_json::json!(["absent"]);
        assert!(Catalog::new(&json.to_string()).is_err());
        assert_eq!(font_key("Pá-gella"), font_key("Pa\u{301} gella"));
        assert_eq!(font_key(&font_key("İ Name")), font_key("İ Name"));
    }
    fn catalog() -> Catalog {
        let mut json = String::new();
        flate2::read::GzDecoder::new(&include_bytes!("../../../web/tex-catalog.json.gz")[..])
            .read_to_string(&mut json)
            .unwrap();
        Catalog::new(&json).unwrap()
    }
    #[test]
    fn upstream_catalog_resolves_real_packages_and_ignores_unknowns() {
        let c = catalog();
        assert_eq!(c.snapshot, "texlive-2026-03-02");
        assert_eq!(
            c.resolve_failure(&[], "! LaTeX Error: File `IEEEtran.cls' not found."),
            vec!["ieeetran"]
        );
        assert_eq!(c.packages["ieeetran"].revision, 79618);
        assert_eq!(
            c.resolve(&[
                Lookup {
                    name: "AccanthisADFStdNo3-Bold-lf-ly1".into(),
                    format: 33
                },
                Lookup {
                    name: "academicons".into(),
                    format: 44
                }
            ]),
            vec!["academicons", "accanthis"]
        );
        let requests = [
            Lookup {
                name: "romanian.ldf".into(),
                format: 26,
            },
            Lookup {
                name: "xstring.sty".into(),
                format: 26,
            },
            Lookup {
                name: "../../xstring.sty".into(),
                format: 26,
            },
            Lookup {
                name: "scribyra-no-such-file.sty".into(),
                format: 26,
            },
        ];
        assert_eq!(c.resolve(&requests), vec!["babel-romanian", "xstring"]);
        assert_eq!(
            c.resolve_failure(
                &requests,
                "! LaTeX Error: File `algpseudocode.sty' not found."
            ),
            vec!["algorithmicx"]
        );
        assert_eq!(
            c.resolve_failure(
                &requests,
                "! Package babel Error: Unknown option 'romanian'."
            ),
            vec!["babel-romanian"]
        );
        assert!(
            c.resolve_failure(
                &requests,
                "! LaTeX Error: File `scribyra-absent.sty' not found."
            )
            .is_empty()
        );
    }
    #[test]
    fn upstream_archive_is_verified_before_extracting_runtime_files() {
        let c = catalog();
        let bytes = include_bytes!("../../../tests/fixtures/tex-packages/babel-romanian.tar.xz");
        let files = c.unpack("babel-romanian", bytes).unwrap();
        assert_eq!(files.len(), 1);
        assert_eq!(files[0].0, "tex/generic/babel-romanian/romanian.ldf");
        assert!(String::from_utf8_lossy(&files[0].1).contains("Romanian"));
        let mut bad = bytes.to_vec();
        bad[0] ^= 1;
        assert!(
            c.unpack("babel-romanian", &bad)
                .unwrap_err()
                .contains("checksum")
        );
        assert!(c.unpack("babel-romanian", &bytes[..100]).is_err());
    }
    fn archive(path: &str, kind: tar::EntryType, content: &[u8]) -> Vec<u8> {
        let mut builder = tar::Builder::new(Vec::new());
        let mut header = tar::Header::new_gnu();
        header.set_path(path).unwrap();
        header.set_entry_type(kind);
        header.set_size(content.len() as u64);
        header.set_cksum();
        builder.append(&header, content).unwrap();
        builder.into_inner().unwrap()
    }
    #[test]
    fn support_archive_routes_and_dependencies_cannot_escape_the_pinned_namespace() {
        let sha = "a".repeat(128);
        let mut value = serde_json::json!({"snapshot":"support","packages":{"test":{"revision":1,"size":1,"sha512":sha,"files":["tex/latex/test/test.sty"],"archive":format!("components/{sha}.tar.xz"),"dependencies":["hyphen-french"]}}});
        assert!(Catalog::new(&value.to_string()).is_ok());
        value["packages"]["test"]["archive"] = "https://other.test/file".into();
        assert!(Catalog::new(&value.to_string()).is_err());
        value["packages"]["test"]["archive"] = format!("components/{sha}.tar.xz").into();
        value["packages"]["test"]["dependencies"] = serde_json::json!(["../outside"]);
        assert!(Catalog::new(&value.to_string()).is_err());
    }
    #[test]
    fn extraction_rejects_links_traversal_duplicates_and_missing_files() {
        let package = Package {
            revision: 1,
            size: 0,
            sha512: String::new(),
            files: vec!["tex/latex/test/test.sty".into()],
            ..Default::default()
        };
        for kind in [
            tar::EntryType::Symlink,
            tar::EntryType::Link,
            tar::EntryType::Fifo,
        ] {
            assert!(extract(&package, &archive(&package.files[0], kind, b"")).is_err());
        }
        let mut bad = archive(&package.files[0], tar::EntryType::Regular, b"content");
        bad[..100].fill(0);
        bad[..7].copy_from_slice(b"../evil");
        bad[148..156].fill(b' ');
        let checksum: usize = bad[..512].iter().map(|v| *v as usize).sum();
        bad[148..156].copy_from_slice(format!("{checksum:06o}\0 ").as_bytes());
        assert!(extract(&package, &bad).is_err());
        assert!(
            extract(
                &package,
                &archive("tlpkg/info", tar::EntryType::Regular, b"metadata")
            )
            .is_err()
        );
        let single = archive(&package.files[0], tar::EntryType::Regular, b"content");
        let mut twice = single[..1024].to_vec();
        twice.extend_from_slice(&single);
        assert!(extract(&package, &twice).is_err());
    }
}
