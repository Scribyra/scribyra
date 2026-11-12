//! Match the prebuilt format with the pinned engine binary before publishing.
use super::*;
use scribyra_core::compatibility::Manifest as Compatibility;
pub(super) fn load(root: &Path, source_sha: &str) -> Result<Compatibility, String> {
    let json = fs::read_to_string("scripts/tex-compiler.json").map_err(|e| e.to_string())?;
    let pin = Compatibility::parse(&json)?;
    let path = root.join(&pin.binary.path);
    if pin.source_archive_sha256 != source_sha
        || fs::metadata(&path).map_err(|e| e.to_string())?.len() != pin.binary.size as u64
        || file_hash(&path)? != pin.binary.sha256
    {
        return Err("Engine binary differs from its compiler/format release pin. Restore the matching compiler assets.".into());
    }
    Ok(pin)
}
pub(super) fn check_format(
    pin: &Compatibility,
    files: &BTreeMap<String, Vec<u8>>,
) -> Result<(), String> {
    let format = files
        .get(&pin.format.path)
        .ok_or("Baseline omits its pinned LuaLaTeX format")?;
    if format.len() != pin.format.size || hash(format) != pin.format.sha256 {
        return Err("Baseline format differs from its compiler release pin".into());
    }
    Ok(())
}
