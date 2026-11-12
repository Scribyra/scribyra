//! Native, reproducible reduction of the pinned Emscripten TeX data collection.
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs::{self, File},
    io::{Read, Seek, SeekFrom},
    path::Path,
};
mod catalog;
mod compiler;
mod components;
mod dependencies;
mod metadata;
mod support;
const CHUNK: usize = 2048;
const MAX_DATA: usize = 768 * 1024 * 1024;
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Recipe {
    version: u32,
    source_archive_sha256: String,
    source_js_sha256: String,
    source_data_sha256: String,
    packages: Vec<String>,
    paths: Vec<String>,
    prefixes: Vec<String>,
    exclude_prefixes: Vec<String>,
}
#[derive(Clone, Deserialize, Serialize)]
struct Entry {
    filename: String,
    start: usize,
    end: usize,
}
#[derive(Deserialize)]
struct Metadata {
    files: Vec<Entry>,
    remote_package_size: usize,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Compressed {
    offsets: Vec<usize>,
    sizes: Vec<usize>,
    successes: Vec<u8>,
    cached_offset: usize,
}
#[derive(Deserialize)]
struct Catalog {
    #[serde(default)]
    snapshot: String,
    packages: BTreeMap<String, Package>,
}
#[derive(Deserialize)]
struct Package {
    files: Vec<String>,
}
#[derive(Deserialize, Serialize)]
struct Asset {
    path: String,
    size: usize,
    sha256: String,
}
#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Manifest {
    version: u32,
    #[serde(default)]
    snapshot: String,
    source_archive_sha256: String,
    source_data_bytes: usize,
    uncompressed_bytes: usize,
    file_count: usize,
    recipe_sha256: String,
    generator_sha256: String,
    catalog_sha256: String,
    components: Asset,
    metadata: Asset,
    data: Asset,
    loader: Asset,
    files: Asset,
    notices: Vec<Asset>,
    compatibility: scribyra_core::compatibility::Manifest,
}
fn hash(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
fn file_hash(path: &Path) -> Result<String, String> {
    let mut file = File::open(path).map_err(|e| e.to_string())?;
    let mut hash = Sha256::new();
    let mut block = [0; 65536];
    loop {
        let size = file.read(&mut block).map_err(|e| e.to_string())?;
        if size == 0 {
            break;
        }
        hash.update(&block[..size]);
    }
    Ok(format!("{:x}", hash.finalize()))
}
fn json_after<'a, T: Deserialize<'a>>(
    source: &'a str,
    marker: &str,
    last: bool,
) -> Result<T, String> {
    let start = if last {
        source.rfind(marker)
    } else {
        source.find(marker)
    }
    .ok_or_else(|| format!("Missing pinned loader marker: {marker}"))?
        + marker.len();
    let mut decoder = serde_json::Deserializer::from_str(&source[start..]);
    T::deserialize(&mut decoder).map_err(|e| e.to_string())
}
fn safe(path: &str) -> bool {
    path.starts_with('/')
        && !path
            .split('/')
            .skip(1)
            .any(|part| part.is_empty() || part == "." || part == "..")
        && !path
            .chars()
            .any(|c| c.is_control() || c == '\\' || c == ':')
}
fn validate(metadata: &Metadata, compressed: &Compressed, data_len: usize) -> Result<(), String> {
    if data_len != metadata.remote_package_size
        || data_len > MAX_DATA
        || metadata.files.len() > 50000
        || compressed.cached_offset.checked_add(CHUNK * 2) != Some(data_len)
    {
        return Err("Invalid pinned data size or cache framing.".into());
    }
    let mut previous = 0;
    let mut names = BTreeSet::new();
    for f in &metadata.files {
        if !safe(&f.filename)
            || !names.insert(&f.filename)
            || f.start != previous
            || f.end < f.start
            || f.end > MAX_DATA
        {
            return Err("Unsafe or inconsistent data-file index.".into());
        }
        previous = f.end;
    }
    let count = previous.div_ceil(CHUNK);
    if compressed.offsets.len() != count
        || compressed.sizes.len() != count
        || compressed.successes.len() != count
    {
        return Err("Invalid LZ4 block table.".into());
    }
    let mut end = 0;
    for i in 0..count {
        let size = compressed.sizes[i];
        if compressed.offsets[i] != end
            || size == 0
            || size > CHUNK + 32
            || compressed.successes[i] > 1
            || (compressed.successes[i] == 0 && size > CHUNK)
        {
            return Err("Invalid LZ4 block boundary.".into());
        }
        end = end.checked_add(size).ok_or("LZ4 size overflow.")?;
    }
    if end != compressed.cached_offset {
        return Err("LZ4 blocks do not cover the data payload.".into());
    }
    Ok(())
}
fn read_entry(file: &mut File, entry: &Entry, compressed: &Compressed) -> Result<Vec<u8>, String> {
    let mut output = Vec::with_capacity(entry.end - entry.start);
    let mut at = entry.start;
    while at < entry.end {
        let index = at / CHUNK;
        let size = compressed.sizes[index];
        file.seek(SeekFrom::Start(compressed.offsets[index] as u64))
            .map_err(|e| e.to_string())?;
        let mut bytes = vec![0; size];
        file.read_exact(&mut bytes).map_err(|e| e.to_string())?;
        let mut decoded = [0; CHUNK];
        let length = if compressed.successes[index] == 1 {
            lz4_flex::block::decompress_into(&bytes, &mut decoded).map_err(|e| e.to_string())?
        } else {
            decoded[..size].copy_from_slice(&bytes);
            size
        };
        let from = at % CHUNK;
        let take = (entry.end - at).min(CHUNK - from);
        if from + take > length {
            return Err("Truncated LZ4 block.".into());
        }
        output.extend_from_slice(&decoded[from..from + take]);
        at += take;
    }
    Ok(output)
}
fn index(paths: &BTreeMap<String, Vec<u8>>, root: &str) -> Vec<u8> {
    let prefix = format!("{root}/");
    let mut directories: BTreeMap<String, BTreeSet<String>> = BTreeMap::new();
    directories
        .entry(".".into())
        .or_default()
        .insert("ls-R".into());
    for path in paths.keys().filter_map(|path| path.strip_prefix(&prefix)) {
        let parts: Vec<_> = path.split('/').collect();
        for i in 0..parts.len() {
            let directory = if i == 0 {
                ".".into()
            } else {
                format!("./{}", parts[..i].join("/"))
            };
            directories
                .entry(directory)
                .or_default()
                .insert(parts[i].into());
        }
    }
    let mut text = String::from(
        "% ls-R -- filename database for kpathsea.\n% Generated reproducibly by Scribyra.\n\n",
    );
    for (directory, files) in directories {
        text.push_str(&format!("{directory}:\n"));
        for file in files {
            text.push_str(&file);
            text.push('\n');
        }
        text.push('\n');
    }
    text.into_bytes()
}
fn write_if_changed(path: &Path, bytes: &[u8]) -> Result<(), String> {
    if fs::read(path).ok().as_deref() != Some(bytes) {
        fs::write(path, bytes).map_err(|e| e.to_string())?;
    }
    Ok(())
}
fn cached(manifest: &Manifest, root: &Path) -> bool {
    for asset in [
        &manifest.data,
        &manifest.loader,
        &manifest.files,
        &manifest.components,
        &manifest.metadata,
    ]
    .into_iter()
    .chain(manifest.notices.iter())
    {
        if asset.path.contains('/')
            || !safe(&format!("/{}", asset.path))
            || file_hash(&root.join(&asset.path)).ok().as_ref() != Some(&asset.sha256)
        {
            return false;
        }
    }
    let Some(json) = fs::read(root.join(&manifest.components.path))
        .ok()
        .and_then(|bytes| serde_json::from_slice::<serde_json::Value>(&bytes).ok())
    else {
        return false;
    };
    let Some(packages) = json["packages"].as_object() else {
        return false;
    };
    for package in packages.values() {
        let Some(hash) = package["sha512"].as_str() else {
            return false;
        };
        if hash.len() != 128 || !hash.bytes().all(|c| c.is_ascii_hexdigit()) {
            return false;
        }
        let path = root.join(format!("components/{hash}.tar.xz"));
        let Ok(bytes) = fs::read(path) else {
            return false;
        };
        if format!("{:x}", sha2::Sha512::digest(&bytes)) != hash {
            return false;
        }
    }
    let Some(metadata) = fs::read(root.join(&manifest.metadata.path))
        .ok()
        .and_then(|bytes| serde_json::from_slice::<serde_json::Value>(&bytes).ok())
    else {
        return false;
    };
    for kind in ["filenames", "packages"] {
        let Some(shards) = metadata[kind].as_object() else {
            return false;
        };
        for part in shards.values() {
            let Ok(asset) = serde_json::from_value::<Asset>(part.clone()) else {
                return false;
            };
            if !asset.path.starts_with("metadata/")
                || !safe(&format!("/{}", asset.path))
                || file_hash(&root.join(asset.path)).ok().as_ref() != Some(&asset.sha256)
            {
                return false;
            }
        }
    }
    if let Some(value) = metadata.get("dependencyGraph").filter(|v| !v.is_null()) {
        let Ok(asset) = serde_json::from_value::<Asset>(value.clone()) else {
            return false;
        };
        if asset.path != format!("metadata/{}.json", asset.sha256)
            || file_hash(&root.join(asset.path)).ok().as_ref() != Some(&asset.sha256)
        {
            return false;
        }
    }
    if let Some(assets) = metadata["support"]["assets"].as_array() {
        for value in assets {
            let Ok(asset) = serde_json::from_value::<Asset>(value.clone()) else {
                return false;
            };
            if !asset.path.starts_with("components/")
                || !safe(&format!("/{}", asset.path))
                || file_hash(&root.join(asset.path)).ok().as_ref() != Some(&asset.sha256)
            {
                return false;
            }
        }
    }
    true
}
fn build() -> Result<(), String> {
    let recipe_bytes = fs::read("scripts/lualatex-baseline.json").map_err(|e| e.to_string())?;
    let recipe: Recipe = serde_json::from_slice(&recipe_bytes).map_err(|e| e.to_string())?;
    if recipe.version != 1 {
        return Err("Unsupported baseline recipe.".into());
    }
    let root = Path::new("public/core/busytex");
    let js_path = root.join("texlive-extra.js");
    let data_path = root.join("texlive-extra.data");
    let source = fs::read_to_string(&js_path).map_err(|e| e.to_string())?;
    if hash(source.as_bytes()) != recipe.source_js_sha256
        || file_hash(&data_path)? != recipe.source_data_sha256
    {
        return Err("Pinned upstream TeX data checksum mismatch. Re-run npm run assets.".into());
    }
    let metadata: Metadata = json_after(&source, "loadPackage(", true)?;
    let compressed: Compressed = json_after(&source, "var compressedData = ", false)?;
    validate(
        &metadata,
        &compressed,
        fs::metadata(&data_path).map_err(|e| e.to_string())?.len() as usize,
    )?;
    let catalog_bytes = fs::read("web/tex-catalog.json.gz").map_err(|e| e.to_string())?;
    let json = catalog::load(Path::new("."))?;
    let compatibility = compiler::load(root, &recipe.source_archive_sha256)?;
    let support = support::publish(root, &recipe.source_archive_sha256)?;
    let dependencies = dependencies::Dependencies::load(Path::new("."), &json)?;
    let mut generator = Sha256::new();
    generator.update(include_bytes!("main.rs"));
    generator.update(include_bytes!("components.rs"));
    generator.update(include_bytes!("catalog.rs"));
    generator.update(include_bytes!("compiler.rs"));
    generator.update(include_bytes!("../../../scripts/tex-runtime-catalog.json"));
    generator.update(include_bytes!("../../../scripts/tex-compiler.json"));
    generator.update(include_bytes!("../../core/src/compatibility.rs"));
    generator.update(include_bytes!("metadata.rs"));
    generator.update(include_bytes!("support.rs"));
    generator.update(include_bytes!("dependencies.rs"));
    generator.update(include_bytes!("../../../scripts/tex-dependencies.json"));
    generator.update(include_bytes!("../../core/src/dependencies.rs"));
    generator.update(include_bytes!("../../../scripts/tex-support.json"));
    generator.update(include_bytes!("../../core/src/packages.rs"));
    generator.update(include_bytes!("../../../Cargo.lock"));
    generator.update(include_bytes!("../../../scripts/lualatex-preload.js"));
    let generator_hash = format!("{:x}", generator.finalize());
    if let Ok(bytes) = fs::read(root.join("lualatex-manifest.json")) {
        if let Ok(existing) = serde_json::from_slice::<Manifest>(&bytes) {
            if existing.compatibility == compatibility
                && existing.recipe_sha256 == hash(&recipe_bytes)
                && existing.catalog_sha256 == hash(&catalog_bytes)
                && existing.generator_sha256 == generator_hash
                && cached(&existing, root)
            {
                println!("Verified cached LuaLaTeX baseline and static components.");
                return Ok(());
            }
        }
    }
    let catalog: Catalog = serde_json::from_str(&json).map_err(|e| e.to_string())?;
    let mut requested: BTreeSet<String> = recipe.paths.iter().cloned().collect();
    for name in &recipe.packages {
        let package = catalog
            .packages
            .get(name)
            .ok_or_else(|| format!("Unknown baseline package {name}"))?;
        requested.extend(
            package
                .files
                .iter()
                .map(|name| format!("/texlive/texmf-dist/{name}")),
        );
    }
    let source_names: BTreeSet<_> = metadata
        .files
        .iter()
        .map(|entry| entry.filename.as_str())
        .collect();
    for path in &recipe.paths {
        if !source_names.contains(path.as_str()) {
            return Err(format!("Missing required baseline path {path}"));
        }
    }
    let mut file = File::open(data_path).map_err(|e| e.to_string())?;
    let mut selected = BTreeMap::new();
    for entry in &metadata.files {
        if (requested.contains(&entry.filename)
            || recipe
                .prefixes
                .iter()
                .any(|prefix| entry.filename.starts_with(prefix)))
            && !recipe
                .exclude_prefixes
                .iter()
                .any(|prefix| entry.filename.starts_with(prefix))
        {
            selected.insert(
                entry.filename.clone(),
                read_entry(&mut file, entry, &compressed)?,
            );
        }
    }
    for root in ["/texlive/texmf-dist/texmf-var", "/texlive/texmf-dist"] {
        selected.insert(format!("{root}/ls-R"), index(&selected, root));
    }
    compiler::check_format(&compatibility, &selected)?;
    let component_index = components::generate(
        root,
        &metadata,
        &compressed,
        &mut file,
        &catalog,
        &selected,
        &recipe.source_archive_sha256,
    )?;
    let catalog_metadata = metadata::generate(
        root,
        &json,
        &hash(&catalog_bytes),
        &component_index,
        &recipe.source_archive_sha256,
        &support,
        &dependencies,
        Some(&compatibility),
    )?;
    let mut notices = Vec::new();
    for name in ["LICENSE.TL", "LICENSE.CTAN", "release-texlive.txt"] {
        let content = selected
            .get(&format!("/texlive/{name}"))
            .ok_or("Missing upstream distribution notice")?;
        write_if_changed(&root.join(name), content)?;
        notices.push(Asset {
            path: name.into(),
            size: content.len(),
            sha256: hash(content),
        });
    }
    let mut plain = Vec::new();
    let mut files = Vec::new();
    let mut provenance = Vec::new();
    for (filename, content) in selected {
        let start = plain.len();
        plain.extend_from_slice(&content);
        files.push(Entry {
            filename: filename.clone(),
            start,
            end: plain.len(),
        });
        provenance.push(
            serde_json::json!({"path":filename,"size":content.len(),"sha256":hash(&content)}),
        );
    }
    let uncompressed = plain.len();
    let mut data = Vec::new();
    let mut offsets = Vec::new();
    let mut sizes = Vec::new();
    let mut successes = Vec::new();
    for chunk in plain.chunks(CHUNK) {
        let compressed = lz4_flex::block::compress(chunk);
        offsets.push(data.len());
        if compressed.len() < chunk.len() {
            sizes.push(compressed.len());
            successes.push(1);
            data.extend(compressed);
        } else {
            sizes.push(chunk.len());
            successes.push(0);
            data.extend_from_slice(chunk);
        }
    }
    let cached_offset = data.len();
    data.resize(cached_offset + CHUNK * 2, 0);
    let data_hash = hash(&data);
    let data_name = format!("texlive-lualatex.{data_hash}.data");
    let info = serde_json::json!({"dataFile":data_name,"size":data.len(),"sha256":data_hash,"files":files,"compressed":{"cachedOffset":cached_offset,"cachedIndexes":[-1,-1],"cachedChunks":[null,null],"offsets":offsets,"sizes":sizes,"successes":successes}});
    let template = include_str!("../../../scripts/lualatex-preload.js");
    let loader = template.replace(
        "__SCRIBYRA_BASELINE__",
        &serde_json::to_string(&info).map_err(|e| e.to_string())?,
    );
    let loader_hash = hash(loader.as_bytes());
    let loader_name = format!("texlive-lualatex.{loader_hash}.js");
    let provenance = serde_json::to_vec(&provenance).map_err(|e| e.to_string())?;
    let provenance_hash = hash(&provenance);
    let provenance_name = format!("lualatex-files.{provenance_hash}.json");
    let manifest = Manifest {
        version: 1,
        snapshot: support.snapshot(&catalog.snapshot),
        source_archive_sha256: recipe.source_archive_sha256,
        source_data_bytes: metadata.remote_package_size,
        uncompressed_bytes: uncompressed,
        file_count: files.len(),
        notices,
        compatibility,
        recipe_sha256: hash(&recipe_bytes),
        generator_sha256: generator_hash,
        catalog_sha256: hash(&catalog_bytes),
        components: component_index,
        metadata: catalog_metadata,
        data: Asset {
            path: data_name,
            size: data.len(),
            sha256: data_hash,
        },
        loader: Asset {
            path: loader_name,
            size: loader.len(),
            sha256: loader_hash,
        },
        files: Asset {
            path: provenance_name,
            size: provenance.len(),
            sha256: provenance_hash,
        },
    };
    write_if_changed(&root.join(&manifest.data.path), &data)?;
    write_if_changed(&root.join(&manifest.loader.path), loader.as_bytes())?;
    write_if_changed(&root.join(&manifest.files.path), &provenance)?;
    write_if_changed(
        &root.join("lualatex-manifest.json"),
        &serde_json::to_vec_pretty(&manifest).unwrap(),
    )?;
    println!(
        "LuaLaTeX baseline: {} files, {:.2} MiB compressed / {:.2} MiB expanded (source {:.2} MiB).",
        files.len(),
        data.len() as f64 / 1048576.,
        uncompressed as f64 / 1048576.,
        metadata.remote_package_size as f64 / 1048576.
    );
    Ok(())
}
fn main() {
    let result = match std::env::args().skip(1).collect::<Vec<_>>().as_slice() {
        [] => build(),
        [command] if command == "catalog-check" => catalog::check(),
        _ => Err("Usage: scribyra-assets [catalog-check]".into()),
    };
    if let Err(error) = result {
        eprintln!("Baseline build failed: {error}");
        std::process::exit(1);
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn metadata_shards_reconstruct_packages_and_all_filename_owners() {
        let temp = Temp::new();
        let package = serde_json::json!({"revision":1,"size":12,"sha512":"0".repeat(128),"files":["tex/latex/test/shared.sty"]});
        let upstream =
            serde_json::json!({"snapshot":"test","packages":{"upstream":package}}).to_string();
        let mut component = package.clone();
        component["origin"] = "distribution".into();
        let bytes=serde_json::to_vec(&serde_json::json!({"packages":{"dist--test":component},"fontFamilies":{"family":["dist--test"]}})).unwrap();
        let components = Asset {
            path: "components.json".into(),
            size: bytes.len(),
            sha256: hash(&bytes),
        };
        fs::write(temp.0.join(&components.path), bytes).unwrap();
        let first = metadata::generate(
            &temp.0,
            &upstream,
            "upstream-hash",
            &components,
            "source",
            &support::Support::default(),
            &dependencies::Dependencies::default(),
            None,
        )
        .unwrap();
        let second = metadata::generate(
            &temp.0,
            &upstream,
            "upstream-hash",
            &components,
            "source",
            &support::Support::default(),
            &dependencies::Dependencies::default(),
            None,
        )
        .unwrap();
        assert_eq!(first.sha256, second.sha256);
        let root: serde_json::Value =
            serde_json::from_slice(&fs::read(temp.0.join(first.path)).unwrap()).unwrap();
        let bucket = scribyra_core::packages::metadata_bucket("shared.sty");
        let part: Asset = serde_json::from_value(root["filenames"][bucket].clone()).unwrap();
        let bytes = fs::read(temp.0.join(part.path)).unwrap();
        assert_eq!(hash(&bytes), part.sha256);
        let names: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(
            names["shared.sty"],
            serde_json::json!(["dist--test", "upstream"])
        );
        let mut catalog =
            scribyra_core::packages::Catalog::new(r#"{"snapshot":"test","packages":{}}"#).unwrap();
        for part in root["packages"].as_object().unwrap().values() {
            let part: Asset = serde_json::from_value(part.clone()).unwrap();
            let text = fs::read_to_string(temp.0.join(part.path)).unwrap();
            assert_eq!(hash(text.as_bytes()), part.sha256);
            catalog.merge(&text).unwrap();
        }
        catalog
            .add_fonts(&root["fontFamilies"].to_string())
            .unwrap();
        assert_eq!(catalog.packages.len(), 2);
        assert_eq!(
            catalog.resolve(&[scribyra_core::packages::Lookup {
                name: "shared.sty".into(),
                format: 26
            }]),
            vec!["dist--test"]
        );
    }
    struct Temp(std::path::PathBuf);
    impl Temp {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!(
                "scribyra-assets-{}-{}",
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_nanos()
            ));
            fs::create_dir(&path).unwrap();
            Self(path)
        }
        fn file(&self, bytes: &[u8]) -> File {
            let path = self.0.join("input.data");
            fs::write(&path, bytes).unwrap();
            File::open(path).unwrap()
        }
    }
    impl Drop for Temp {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }
    #[test]
    fn mixed_lz4_blocks_preserve_files_across_boundaries() {
        let temp = Temp::new();
        let plain: Vec<u8> = (0..5000)
            .map(|i| if i < CHUNK { 42 } else { (i % 251) as u8 })
            .collect();
        let first = lz4_flex::block::compress(&plain[..CHUNK]);
        let mut bytes = first.clone();
        bytes.extend_from_slice(&plain[CHUNK..]);
        let compressed = Compressed {
            offsets: vec![0, first.len(), first.len() + CHUNK],
            sizes: vec![first.len(), CHUNK, 5000 - CHUNK * 2],
            successes: vec![1, 0, 0],
            cached_offset: bytes.len(),
        };
        let mut file = temp.file(&bytes);
        let entry = Entry {
            filename: "/test/file".into(),
            start: 1900,
            end: 4400,
        };
        assert_eq!(
            read_entry(&mut file, &entry, &compressed).unwrap(),
            plain[1900..4400]
        );
        let mut truncated = compressed;
        truncated.sizes[2] = 1;
        assert!(read_entry(&mut file, &entry, &truncated).is_err());
    }
    #[test]
    fn generated_components_are_reproducible_and_pass_the_runtime_verifier() {
        let temp = Temp::new();
        let content = b"first style\nsecond style\n";
        let mut file = temp.file(content);
        let metadata = Metadata {
            files: vec![
                Entry {
                    filename: "/texlive/texmf-dist/tex/latex/test/first.sty".into(),
                    start: 0,
                    end: 12,
                },
                Entry {
                    filename: "/texlive/texmf-dist/tex/latex/test/second.sty".into(),
                    start: 12,
                    end: content.len(),
                },
            ],
            remote_package_size: content.len(),
        };
        let compressed = Compressed {
            offsets: vec![0],
            sizes: vec![content.len()],
            successes: vec![0],
            cached_offset: content.len(),
        };
        let catalog:Catalog=serde_json::from_value(serde_json::json!({"packages":{"test":{"files":["tex/latex/test/first.sty","tex/latex/test/second.sty"]}}})).unwrap();
        let first = components::generate(
            &temp.0,
            &metadata,
            &compressed,
            &mut file,
            &catalog,
            &BTreeMap::new(),
            "source",
        )
        .unwrap();
        let second = components::generate(
            &temp.0,
            &metadata,
            &compressed,
            &mut file,
            &catalog,
            &BTreeMap::new(),
            "source",
        )
        .unwrap();
        assert_eq!(first.sha256, second.sha256);
        let json = fs::read_to_string(temp.0.join(first.path)).unwrap();
        let catalog = scribyra_core::packages::Catalog::new(&json).unwrap();
        let package = &catalog.packages["dist--test"];
        let bytes = fs::read(temp.0.join(format!("components/{}.tar.xz", package.sha512))).unwrap();
        let files = catalog.unpack("dist--test", &bytes).unwrap();
        assert_eq!(files.len(), 2);
        assert_eq!(files[0].1, &content[..12]);
        assert_eq!(files[1].1, &content[12..]);
        // An exact-size mutation is rejected by the same verifier used in WASM.
        let mut bad = bytes;
        bad[20] ^= 1;
        assert!(
            catalog
                .unpack("dist--test", &bad)
                .unwrap_err()
                .contains("checksum")
        );
    }
    #[test]
    fn indexes_exclude_removed_files_and_include_parent_directories() {
        let files = BTreeMap::from([
            ("/root/tex/latex/base/article.cls".into(), vec![]),
            ("/root/fonts/file.otf".into(), vec![]),
        ]);
        let output = String::from_utf8(index(&files, "/root")).unwrap();
        assert!(output.contains("./tex/latex/base:\narticle.cls\n"));
        assert!(output.contains("./tex:\nlatex\n"));
        assert!(!output.contains("removed"));
        assert!(output.contains(".:\nfonts\nls-R\ntex\n"));
    }
    #[test]
    fn invalid_block_tables_and_virtual_paths_are_rejected() {
        let metadata = Metadata {
            files: vec![Entry {
                filename: "/root/file".into(),
                start: 0,
                end: 1,
            }],
            remote_package_size: 4097,
        };
        let mut data = Compressed {
            offsets: vec![0],
            sizes: vec![1],
            successes: vec![0],
            cached_offset: 1,
        };
        assert!(validate(&metadata, &data, 4097).is_ok());
        data.offsets[0] = 1;
        assert!(validate(&metadata, &data, 4097).is_err());
        assert!(!safe("/root/../escape"));
        assert!(!safe("/root/a\nb"));
    }
}
