use super::*;
use sha2::Sha512;
use std::io::Write;
#[derive(Serialize)]
struct Component {
    revision: u32,
    size: usize,
    sha512: String,
    files: Vec<String>,
    origin: &'static str,
    label: String,
}
fn runtime(path: &str) -> Option<&str> {
    let relative = path.strip_prefix("/texlive/texmf-dist/")?;
    ["tex/", "fonts/", "bibtex/", "makeindex/"]
        .iter()
        .any(|prefix| relative.starts_with(prefix))
        .then_some(relative)
}
pub(super) fn generate(
    root: &Path,
    metadata: &Metadata,
    compressed: &Compressed,
    file: &mut File,
    catalog: &Catalog,
    selected: &BTreeMap<String, Vec<u8>>,
    source_sha: &str,
) -> Result<Asset, String> {
    let mut owners = BTreeMap::new();
    for (name, package) in &catalog.packages {
        for path in &package.files {
            owners.entry(path.as_str()).or_insert(name.as_str());
        }
    }
    let mut groups: BTreeMap<String, Vec<&Entry>> = BTreeMap::new();
    let mut labels = BTreeMap::new();
    for entry in &metadata.files {
        let Some(path) = runtime(&entry.filename) else {
            continue;
        };
        let (name, label) = if let Some(owner) = owners.get(path) {
            (format!("dist--{owner}"), owner.to_string())
        } else {
            let parent = path
                .rsplit_once('/')
                .map(|(parent, _)| parent)
                .unwrap_or(path);
            (
                format!("dist--extra-{}", &hash(parent.as_bytes())[..16]),
                parent.to_string(),
            )
        };
        labels.insert(name.clone(), label);
        groups.entry(name).or_default().push(entry);
    }
    groups.retain(|_, entries| {
        entries
            .iter()
            .any(|entry| !selected.contains_key(&entry.filename))
    });
    fs::create_dir_all(root.join("components")).map_err(|e| e.to_string())?;
    // Large font collections become bounded pieces, each with disjoint paths.
    let mut pieces = BTreeMap::new();
    for (name, entries) in groups {
        let mut chunks: Vec<Vec<&Entry>> = vec![Vec::new()];
        let mut size = 0;
        for entry in entries {
            let bytes = entry.end - entry.start + 1024;
            if size + bytes > 8 * 1024 * 1024 && !chunks.last().unwrap().is_empty() {
                chunks.push(Vec::new());
                size = 0;
            }
            chunks.last_mut().unwrap().push(entry);
            size += bytes;
        }
        let split = chunks.len() > 1;
        let label = labels.remove(&name).unwrap();
        for (i, chunk) in chunks.into_iter().enumerate() {
            let key = if split {
                format!("{name}--part-{:04}", i + 1)
            } else {
                name.clone()
            };
            labels.insert(
                key.clone(),
                if split {
                    format!("{label} (part {})", i + 1)
                } else {
                    label.clone()
                },
            );
            pieces.insert(key, chunk);
        }
    }
    let groups = pieces;
    let count = groups.len();
    let mut packages = BTreeMap::new();
    let mut font_families: BTreeMap<String, BTreeSet<String>> = BTreeMap::new();
    let mut total = 0usize;
    for (i, (name, entries)) in groups.into_iter().enumerate() {
        let mut archive = tar::Builder::new(Vec::new());
        let mut paths = Vec::new();
        let mut expanded = 0usize;
        for entry in entries {
            let content = read_entry(file, entry, compressed)?;
            expanded = expanded.saturating_add(content.len() + 1024);
            if expanded > 96 * 1024 * 1024 {
                return Err(format!(
                    "Distribution component {name} exceeds the supported expanded limit."
                ));
            }
            let path = runtime(&entry.filename).unwrap();
            if [".otf", ".ttf", ".ttc"]
                .iter()
                .any(|ext| path.ends_with(ext))
            {
                for index in 0..ttf_parser::fonts_in_collection(&content)
                    .unwrap_or(1)
                    .min(128)
                {
                    let Ok(face) = ttf_parser::Face::parse(&content, index) else {
                        continue;
                    };
                    for record in face.names() {
                        if [
                            ttf_parser::name_id::FAMILY,
                            ttf_parser::name_id::FULL_NAME,
                            ttf_parser::name_id::POST_SCRIPT_NAME,
                            ttf_parser::name_id::TYPOGRAPHIC_FAMILY,
                        ]
                        .contains(&record.name_id)
                        {
                            if let Some(alias) = record.to_string() {
                                let key = scribyra_core::packages::font_key(&alias);
                                if !key.is_empty() && key.len() <= 512 {
                                    font_families.entry(key).or_default().insert(name.clone());
                                }
                            }
                        }
                    }
                }
            }
            let mut header = tar::Header::new_gnu();
            header.set_size(content.len() as u64);
            header.set_mode(0o644);
            header.set_uid(0);
            header.set_gid(0);
            header.set_mtime(0);
            header.set_cksum();
            archive
                .append_data(
                    &mut header,
                    format!("texmf-dist/{path}"),
                    content.as_slice(),
                )
                .map_err(|e| e.to_string())?;
            paths.push(path.to_string());
        }
        let raw = archive.into_inner().map_err(|e| e.to_string())?;
        let mut encoder =
            lzma_rust2::XzWriter::new(Vec::new(), lzma_rust2::XzOptions::with_preset(1))
                .map_err(|e| e.to_string())?;
        encoder.write_all(&raw).map_err(|e| e.to_string())?;
        let bytes = encoder.finish().map_err(|e| e.to_string())?;
        if bytes.len() > 32 * 1024 * 1024 {
            return Err(format!(
                "Distribution component {name} exceeds the archive download limit."
            ));
        }
        let sha512 = format!("{:x}", Sha512::digest(&bytes));
        write_if_changed(&root.join(format!("components/{sha512}.tar.xz")), &bytes)?;
        total += bytes.len();
        packages.insert(
            name.clone(),
            Component {
                revision: 0,
                size: bytes.len(),
                sha512,
                files: paths,
                origin: "distribution",
                label: labels.remove(&name).unwrap(),
            },
        );
        if (i + 1) % 100 == 0 {
            println!(
                "Prepared {} / {count} static distribution components…",
                i + 1
            );
        }
    }
    let bytes=serde_json::to_vec(&serde_json::json!({"snapshot":"busytex-1.4.1","sourceArchiveSha256":source_sha,"packages":packages,"fontFamilies":font_families})).map_err(|e|e.to_string())?;
    let sha256 = hash(&bytes);
    let path = format!("lualatex-components.{sha256}.json");
    write_if_changed(&root.join(&path), &bytes)?;
    println!(
        "Static distribution components: {count}, {:.2} MiB of archives.",
        total as f64 / 1048576.
    );
    Ok(Asset {
        path,
        size: bytes.len(),
        sha256,
    })
}
