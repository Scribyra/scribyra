//! Immutable filename and package shards; no full catalog is needed at startup.
use super::*;
use scribyra_core::packages::{Catalog as RuntimeCatalog, metadata_bucket};

const MAX_SHARD: usize = 2 * 1024 * 1024;
fn emit(root: &Path, value: &impl Serialize) -> Result<Asset, String> {
    let bytes = serde_json::to_vec(value).map_err(|e| e.to_string())?;
    if bytes.len() > MAX_SHARD {
        return Err("Metadata shard exceeds 2 MiB".into());
    }
    let sha256 = hash(&bytes);
    let path = format!("metadata/{sha256}.json");
    write_if_changed(&root.join(&path), &bytes)?;
    Ok(Asset {
        path,
        size: bytes.len(),
        sha256,
    })
}
pub(super) fn generate(
    root: &Path,
    upstream: &str,
    upstream_sha: &str,
    components: &Asset,
    source_sha: &str,
    support: &support::Support,
    dependencies: &dependencies::Dependencies,
    compatibility: Option<&scribyra_core::compatibility::Manifest>,
) -> Result<Asset, String> {
    let mut merged: serde_json::Value =
        serde_json::from_str(upstream).map_err(|e| e.to_string())?;
    merged["snapshot"] = support
        .snapshot(
            merged["snapshot"]
                .as_str()
                .ok_or("Missing upstream snapshot")?,
        )
        .into();
    merged["languages"] = serde_json::to_value(&support.languages).map_err(|e| e.to_string())?;
    let distribution: serde_json::Value =
        serde_json::from_slice(&fs::read(root.join(&components.path)).map_err(|e| e.to_string())?)
            .map_err(|e| e.to_string())?;
    for (name, package) in distribution["packages"]
        .as_object()
        .ok_or("Invalid distribution index")?
    {
        if merged["packages"].get(name).is_some() {
            return Err("Duplicate distribution component name".into());
        }
        merged["packages"][name] = package.clone();
    }
    merged["fontFamilies"] = distribution["fontFamilies"].clone();
    dependencies.enrich(&mut merged)?;
    for (name, package) in &support.packages {
        merged["packages"][name] = serde_json::to_value(package).map_err(|e| e.to_string())?;
    }
    let catalog = RuntimeCatalog::new(&merged.to_string())?;
    fs::create_dir_all(root.join("metadata")).map_err(|e| e.to_string())?;
    let dependency_graph = dependencies.publish(root, &catalog.snapshot, support)?;
    let mut filenames: BTreeMap<String, BTreeMap<String, BTreeSet<&str>>> = BTreeMap::new();
    let mut packages: BTreeMap<String, BTreeMap<&str, &scribyra_core::packages::Package>> =
        BTreeMap::new();
    for (name, package) in &catalog.packages {
        packages
            .entry(metadata_bucket(name))
            .or_default()
            .insert(name, package);
        for path in &package.files {
            let basename = path.rsplit('/').next().unwrap();
            filenames
                .entry(metadata_bucket(basename))
                .or_default()
                .entry(basename.to_string())
                .or_default()
                .insert(name);
        }
    }
    let mut file_assets = BTreeMap::new();
    let mut package_assets = BTreeMap::new();
    let file_count: usize = filenames.values().map(|part| part.len()).sum();
    for (bucket, names) in filenames {
        file_assets.insert(bucket, emit(root, &names)?);
    }
    for (bucket, packages) in packages {
        package_assets.insert(
            bucket,
            emit(
                root,
                &serde_json::json!({"snapshot":catalog.snapshot,"packages":packages}),
            )?,
        );
    }
    let bytes = serde_json::to_vec(&serde_json::json!({
        "version":1,"snapshot":catalog.snapshot,"sourceArchiveSha256":source_sha,
        "upstreamCatalogSha256":upstream_sha,"distributionComponentsSha256":components.sha256,
        "packageCount":catalog.packages.len(),"filenameCount":file_count,
        "filenames":file_assets,"packages":package_assets,"fontFamilies":catalog.font_families,
        "support":support.provenance,
        "languages":catalog.languages,
        "dependencyGraph":dependency_graph,
        "compatibility":compatibility,
    }))
    .map_err(|e| e.to_string())?;
    if bytes.len() > 256 * 1024 {
        return Err("Metadata root exceeds 256 KiB".into());
    }
    let sha256 = hash(&bytes);
    let path = format!("tex-catalog.{sha256}.json");
    write_if_changed(&root.join(&path), &bytes)?;
    println!(
        "Sharded metadata: {} packages, {file_count} basenames, {} shards; root {} bytes.",
        catalog.packages.len(),
        file_assets.len() + package_assets.len(),
        bytes.len()
    );
    Ok(Asset {
        path,
        size: bytes.len(),
        sha256,
    })
}
