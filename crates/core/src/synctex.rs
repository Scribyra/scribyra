//! Bounded, filesystem-free SyncTeX queries against an exact compilation manifest.
use flate2::read::GzDecoder;
use serde::{Deserialize, Serialize};
use std::{
    collections::{BTreeMap, BTreeSet},
    io::{Cursor, Read},
    path::Path,
};
const MAX_DATA: usize = 16 * 1024 * 1024;
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Source {
    pub id: String,
    pub path: String,
    pub line_count: u32,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Manifest {
    pub files: Vec<Source>,
    pub main_file: String,
    pub root: String,
    pub pages: u32,
}
pub struct Document {
    data: String,
    files: BTreeMap<String, Source>,
    paths: BTreeMap<String, String>,
    inputs: BTreeSet<String>,
    pdf_path: String,
    pages: u32,
}
#[derive(Debug, Serialize)]
pub struct Rectangle {
    pub page: u32,
    pub left: f32,
    pub top: f32,
    pub right: f32,
    pub bottom: f32,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Anchor {
    pub file_id: String,
    pub path: String,
    pub line: u32,
}
fn absolute(value: &str, base: &str) -> Option<String> {
    if value.contains(['\0', '\n', '\r', '\\']) {
        return None;
    }
    let joined = if value.starts_with('/') {
        value.to_owned()
    } else {
        format!("{base}/{value}")
    };
    let mut parts = Vec::new();
    for part in joined.split('/') {
        match part {
            "" | "." => {}
            ".." => {
                parts.pop()?;
            }
            part => parts.push(part),
        }
    }
    Some(format!("/{}", parts.join("/")))
}
impl Document {
    pub fn new(bytes: &[u8], manifest: Manifest) -> Result<Self, String> {
        if bytes.is_empty() || bytes.len() > MAX_DATA {
            return Err("SyncTeX data is empty or exceeds 16 MiB.".into());
        }
        if manifest.files.len() > 512 || manifest.pages == 0 || manifest.pages > 100_000 {
            return Err("Invalid SyncTeX manifest size.".into());
        }
        if !manifest.root.starts_with('/') || manifest.root.len() > 4096 {
            return Err("Invalid compiler root.".into());
        }
        let root = absolute(&manifest.root, "/").ok_or("Invalid compiler root.")?;
        let mut files = BTreeMap::new();
        let mut paths = BTreeMap::new();
        for file in manifest.files {
            if !crate::valid_path(&file.path)
                || file.id.is_empty()
                || file.id.len() > 256
                || file.line_count == 0
            {
                return Err("Invalid source manifest entry.".into());
            }
            let path = absolute(&file.path, &root).ok_or("Invalid source path.")?;
            if paths.insert(path, file.id.clone()).is_some()
                || files.insert(file.id.clone(), file).is_some()
            {
                return Err("Duplicate source manifest entry.".into());
            }
        }
        let main = absolute(&manifest.main_file, &root).ok_or("Invalid main source path.")?;
        if !paths.contains_key(&main) {
            return Err("Main source is not in the compilation manifest.".into());
        }
        let base = main.rsplit_once('/').unwrap().0;
        let mut expanded = Vec::new();
        if bytes.starts_with(&[0x1f, 0x8b]) {
            GzDecoder::new(bytes)
                .take((MAX_DATA + 1) as u64)
                .read_to_end(&mut expanded)
                .map_err(|e| format!("Invalid compressed SyncTeX: {e}"))?;
        } else {
            expanded.extend_from_slice(bytes);
        }
        if expanded.len() > MAX_DATA {
            return Err("Expanded SyncTeX exceeds 16 MiB.".into());
        }
        let text = String::from_utf8(expanded).map_err(|_| "SyncTeX is not valid UTF-8.")?;
        if text.lines().next() != Some("SyncTeX Version:1")
            || !text.lines().any(|l| l == "Content:")
            || !text.lines().any(|l| l == "Postamble:")
        {
            return Err("Incomplete or unsupported SyncTeX data.".into());
        }
        let mut data = String::new();
        let mut inputs = BTreeSet::new();
        let mut tags = BTreeSet::new();
        for (index, line) in text.lines().enumerate() {
            if index >= 250_000 || line.len() > 8192 {
                return Err("SyncTeX record limit exceeded.".into());
            }
            if let Some(input) = line.strip_prefix("Input:") {
                let (tag, name) = input
                    .split_once(':')
                    .ok_or("Invalid SyncTeX input record.")?;
                let number = tag
                    .parse::<u32>()
                    .map_err(|_| "Invalid SyncTeX input tag.")?;
                if number == 0 || !tags.insert(number) {
                    return Err("Duplicate or invalid SyncTeX input tag.".into());
                }
                let Some(path) = absolute(name, base) else {
                    continue;
                };
                if let Some(id) = paths.get(&path) {
                    inputs.insert(id.clone());
                    data.push_str(&format!("Input:{number}:{path}\n"));
                }
                // Package files and generated sidecars are not editor source targets.
            } else {
                data.push_str(line);
                data.push('\n');
            }
        }
        if inputs.is_empty() {
            return Err("SyncTeX contains no project sources.".into());
        }
        Ok(Self {
            data,
            files,
            paths,
            inputs,
            pdf_path: format!("{main}.pdf"),
            pages: manifest.pages,
        })
    }
    pub fn forward(
        &self,
        id: &str,
        line: u32,
        page_hint: Option<u32>,
    ) -> Result<Vec<Rectangle>, String> {
        let file = self
            .files
            .get(id)
            .ok_or("Source file is not in this compilation.")?;
        if line == 0 || line > file.line_count {
            return Err("Source line is outside this compilation.".into());
        }
        if !self.inputs.contains(id) {
            return Err("This file has no SyncTeX input mapping.".into());
        }
        let path = self
            .paths
            .iter()
            .find(|(_, value)| value.as_str() == id)
            .unwrap()
            .0;
        let hits = synctex_parser::forward_candidates_from_reader_with_page_hint(
            Cursor::new(self.data.as_bytes()),
            Path::new(&self.pdf_path),
            Path::new(path),
            None,
            line,
            false,
            page_hint.filter(|page| *page > 0 && *page <= self.pages),
        )
        .map_err(|e| format!("SyncTeX query failed: {e}"))?;
        Ok(hits
            .into_iter()
            .filter_map(|hit| {
                let r = hit.rect;
                (hit.page > 0
                    && hit.page <= self.pages
                    && [r.left, r.top, r.right, r.bottom]
                        .iter()
                        .all(|v| v.is_finite() && v.abs() < 100_000.)
                    && r.right >= r.left
                    && r.bottom >= r.top)
                    .then_some(Rectangle {
                        page: hit.page,
                        left: r.left,
                        top: r.top,
                        right: r.right,
                        bottom: r.bottom,
                    })
            })
            .take(64)
            .collect())
    }
    pub fn inverse(&self, page: u32, x: f32, y: f32, height: f32) -> Result<Vec<Anchor>, String> {
        if page == 0
            || page > self.pages
            || ![x, y, height].iter().all(|v| v.is_finite())
            || x < 0.
            || x > 100_000.
            || height <= 0.
            || height > 100_000.
            || y < 0.
            || y > height
        {
            return Err("Invalid PDF position.".into());
        }
        let hits = synctex_parser::inverse_candidates_from_reader(
            Cursor::new(self.data.as_bytes()),
            synctex_parser::InversePoint {
                page,
                x,
                y_from_top: y,
                page_height_pt: height,
            },
        )
        .map_err(|e| format!("SyncTeX query failed: {e}"))?;
        Ok(hits
            .into_iter()
            .filter_map(|hit| {
                let id = self.paths.get(&hit.file)?;
                let file = self.files.get(id)?;
                (hit.line > 0 && hit.line <= file.line_count).then_some(Anchor {
                    file_id: id.clone(),
                    path: file.path.clone(),
                    line: hit.line,
                })
            })
            .take(64)
            .collect())
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    fn manifest() -> Manifest {
        Manifest {
            files: vec![Source {
                id: "main".into(),
                path: "main.tex".into(),
                line_count: 20,
            }],
            main_file: "main.tex".into(),
            root: "/home/web_user/project_dir".into(),
            pages: 1,
        }
    }
    #[test]
    fn canonical_geometry_across_engines() {
        for (bytes, top, bottom) in [
            (
                include_bytes!("../../../tests/fixtures/synctex/article-pdflatex.synctex")
                    .as_slice(),
                283.84224,
                298.04684,
            ),
            (
                include_bytes!("../../../tests/fixtures/synctex/unicode-xelatex.synctex")
                    .as_slice(),
                149.5721,
                158.58827,
            ),
            (
                include_bytes!("../../../tests/fixtures/synctex/unicode-lualatex.synctex")
                    .as_slice(),
                0.,
                158.58827,
            ),
        ] {
            let doc = Document::new(bytes, manifest()).unwrap();
            let hits = doc.forward("main", 6, None).unwrap();
            let hit = &hits[0];
            assert_eq!(hit.page, 1);
            assert!((hit.left - 133.76836).abs() < 0.01);
            assert!((hit.top - top).abs() < 0.01, "{hit:?}");
            assert!((hit.bottom - bottom).abs() < 0.01);
            let back = doc.inverse(1, 200., bottom - 4., 792.).unwrap();
            assert!(
                back.iter()
                    .any(|hit| hit.file_id == "main" && hit.line == 6),
                "{back:?}"
            );
        }
    }
    #[test]
    fn nested_unicode_inputs_are_resolved_against_compilation_directory() {
        let bytes = include_bytes!("../../../tests/fixtures/synctex/article-pdflatex.synctex");
        let text = String::from_utf8(bytes.to_vec()).unwrap().replace(
            "/home/web_user/project_dir/./main.tex",
            "../chapters/été.tex",
        );
        let mut manifest = manifest();
        manifest.main_file = "paper/main.tex".into();
        manifest.files = vec![
            Source {
                id: "main".into(),
                path: "paper/main.tex".into(),
                line_count: 20,
            },
            Source {
                id: "chapter".into(),
                path: "chapters/été.tex".into(),
                line_count: 20,
            },
            Source {
                id: "alias".into(),
                path: "other/été.tex".into(),
                line_count: 20,
            },
        ];
        let doc = Document::new(text.as_bytes(), manifest).unwrap();
        assert_eq!(doc.forward("chapter", 6, None).unwrap()[0].page, 1);
        assert!(doc.forward("alias", 6, None).is_err());
        assert!(doc.forward("main", 6, None).is_err());
        let back = doc.inverse(1, 200., 294., 792.).unwrap();
        assert_eq!(back[0].file_id, "chapter");
        assert_eq!(back[0].path, "chapters/été.tex");
    }
    #[test]
    fn compressed_metadata_is_checked_and_expansion_is_bounded() {
        use std::io::Write;
        fn gzip(bytes: &[u8]) -> Vec<u8> {
            let mut encoder =
                flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::fast());
            encoder.write_all(bytes).unwrap();
            encoder.finish().unwrap()
        }
        let bytes = include_bytes!("../../../tests/fixtures/synctex/article-pdflatex.synctex");
        let compressed = gzip(bytes);
        assert_eq!(
            Document::new(&compressed, manifest())
                .unwrap()
                .forward("main", 6, None)
                .unwrap()[0]
                .page,
            1
        );
        let mut corrupt = compressed.clone();
        let checksum = corrupt.len() - 8;
        corrupt[checksum] ^= 1;
        assert!(
            Document::new(&corrupt, manifest())
                .err()
                .unwrap()
                .contains("Invalid compressed")
        );
        assert!(Document::new(&compressed[..compressed.len() - 4], manifest()).is_err());
        let bomb = gzip(&vec![b' '; MAX_DATA + 1]);
        assert!(
            Document::new(&bomb, manifest())
                .err()
                .unwrap()
                .contains("Expanded SyncTeX")
        );
    }
    #[test]
    fn rejects_invalid_data_and_never_maps_external_inputs() {
        let bytes = include_bytes!("../../../tests/fixtures/synctex/article-pdflatex.synctex");
        let doc = Document::new(bytes, manifest()).unwrap();
        assert!(doc.forward("absent", 1, None).is_err());
        assert!(doc.forward("main", 0, None).is_err());
        assert!(doc.inverse(2, 1., 1., 792.).is_err());
        assert!(doc.inverse(1, f32::NAN, 1., 792.).is_err());
        assert!(Document::new(b"SyncTeX Version:1", manifest()).is_err());
        assert!(Document::new(&[0x1f, 0x8b, 0], manifest()).is_err());
        let external = String::from_utf8(bytes.to_vec()).unwrap().replace(
            "/home/web_user/project_dir/./main.tex",
            "/elsewhere/main.tex",
        );
        assert!(Document::new(external.as_bytes(), manifest()).is_err());
    }
}
