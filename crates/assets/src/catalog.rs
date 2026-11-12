//! Retained runtime pins remain reproducible even when the historical HTTP source is unavailable.
use super::*;
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Pin {
    version: u8,
    input: String,
    sha256: String,
    raw_sha256: String,
    snapshot: String,
    source: String,
    source_sha256: String,
    runtime_packages: usize,
}
fn verify(bytes: &[u8], pin: &Pin) -> Result<String, String> {
    if pin.version != 1
        || pin.input != "web/tex-catalog.json.gz"
        || bytes.len() > 8 * 1024 * 1024
        || hash(bytes) != pin.sha256
    {
        return Err("Frozen runtime catalog differs from its source pin".into());
    }
    let mut raw = Vec::new();
    flate2::read::GzDecoder::new(bytes)
        .take(32 * 1024 * 1024 + 1)
        .read_to_end(&mut raw)
        .map_err(|e| e.to_string())?;
    if raw.len() > 32 * 1024 * 1024 || hash(&raw) != pin.raw_sha256 {
        return Err("Frozen runtime catalog raw checksum differs from its pin".into());
    }
    let text = String::from_utf8(raw).map_err(|_| "Frozen runtime catalog is not UTF-8")?;
    let value: serde_json::Value = serde_json::from_str(&text).map_err(|e| e.to_string())?;
    let catalog = scribyra_core::packages::Catalog::new(&text)?;
    if catalog.snapshot != pin.snapshot
        || catalog.packages.len() != pin.runtime_packages
        || value["source"] != pin.source
        || value["sourceSha256"] != pin.source_sha256
    {
        return Err("Frozen runtime catalog provenance differs from its pin".into());
    }
    Ok(text)
}
pub(super) fn load(project: &Path) -> Result<String, String> {
    let pin: Pin = serde_json::from_slice(
        &fs::read(project.join("scripts/tex-runtime-catalog.json")).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;
    if pin.input != "web/tex-catalog.json.gz" {
        return Err("Unsupported catalog input path".into());
    }
    let path = project.join(&pin.input);
    if fs::metadata(&path).map_err(|e| e.to_string())?.len() > 8 * 1024 * 1024 {
        return Err("Catalog input exceeds its bound".into());
    }
    verify(&fs::read(path).map_err(|e| e.to_string())?, &pin)
}
pub(super) fn check() -> Result<(), String> {
    let json = load(Path::new("."))?;
    super::dependencies::Dependencies::load(Path::new("."), &json)?;
    println!(
        "Verified frozen runtime catalog and all 4,218 dependency-source identities offline. No archive pin or project was changed."
    );
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn retained_catalog_pins_every_archive_and_rejects_changes_before_generation() {
        let pin: Pin =
            serde_json::from_str(include_str!("../../../scripts/tex-runtime-catalog.json"))
                .unwrap();
        let bytes = include_bytes!("../../../web/tex-catalog.json.gz");
        let text = verify(bytes, &pin).unwrap();
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&text).unwrap()["packages"]
                .as_object()
                .unwrap()
                .len(),
            4218
        );
        let mut bad = bytes.to_vec();
        let i = bad.len() / 2;
        bad[i] ^= 1;
        assert!(verify(&bad, &pin).is_err());
    }
}
