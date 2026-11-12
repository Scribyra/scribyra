pub mod collaboration_schema;
pub mod collaboration_commands;
pub mod agent;
pub mod comments;
pub mod reviews;
pub mod history;
pub mod blob;
pub mod commands;
pub mod companion;
pub mod compatibility;
pub mod dependencies;
pub mod diagnostics;
pub mod editor;
pub mod environment;
pub mod references;
pub mod tree;
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum Engine {
    PdfLatex,
    XeLatex,
    LuaLatex,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ProjectFile {
    pub id: String,
    pub path: String,
    pub binary: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Project {
    pub id: String,
    pub name: String,
    pub files: Vec<ProjectFile>,
    pub main_file: String,
    pub engine: Engine,
    pub updated_at: f64,
}

/// Portable project paths only; never accept an archive entry as a host path.
pub fn valid_path(path: &str) -> bool {
    !path.is_empty()
        && path.len() <= 240
        && !path.contains(['\\', ':', '\0'])
        && !path.chars().any(char::is_control)
        && path
            .split('/')
            .all(|p| !p.is_empty() && p != "." && p != "..")
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rejects_traversal_and_absolute_paths() {
        for path in [
            "../x",
            "/x",
            "a/../../x",
            "C:\\x",
            "a//b",
            "a\0",
            "a\nb",
            ".",
            "",
        ] {
            assert!(!valid_path(path), "{path:?}");
        }
        assert!(valid_path("chapters/été.tex"));
    }
}

pub mod synctex;

pub mod cache;
pub mod packages;
pub mod portable;

pub mod exchange;

pub mod providers;

pub mod reconciliation;
pub mod telemetry;
