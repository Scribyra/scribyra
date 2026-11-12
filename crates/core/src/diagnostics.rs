//! Local compiler evidence, shared by WASM workers and the future companion.
use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;
#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Request {
    #[serde(default)]
    pub main_file: Option<String>,
    #[serde(default)]
    pub failure: Option<Failure>,
    #[serde(default)]
    pub success: bool,
    #[serde(default)]
    pub log: String,
    #[serde(default)]
    pub project_files: Vec<String>,
    #[serde(default)]
    pub recorder: String,
    #[serde(default)]
    pub recorder_truncated: bool,
    #[serde(default)]
    pub stalled_packages: Vec<String>,
}
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Issue {
    pub code: String,
    pub severity: String,
    pub summary: String,
    pub detail: String,
    pub action: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub file: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub line: Option<u32>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Report {
    pub version: u8,
    pub issues: Vec<Issue>,
    pub allow_package_resolution: bool,
    pub warning_count: usize,
    pub truncated: bool,
}
const MAX_ISSUES: usize = 100;
const MAX_TEXT: usize = 1024;
// Shell escape is deliberately disabled by the browser compiler. Keep the raw log.
const RUNTIME_WARNINGS: &[&str] =
    &["Package epstopdf Warning: Shell escape feature is not enabled."];

fn bounded(text: &str, limit: usize) -> String {
    let mut end = text.len().min(limit);
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    text[..end].into()
}

// TeX nests input filenames in parentheses. Keep ordinary parentheses too, so
// package messages do not accidentally close a source file. No filesystem reads.
fn log_evidence(request: &Request) -> (Option<(Option<String>, Option<u32>)>, Vec<Issue>, usize) {
    let opening = regex::Regex::new(r#"^(?:"([^"]{1,1024}\.[A-Za-z0-9]+)"|([^\s()"]{1,1024}\.(?i:tex|sty|cls|aux|bbl|bib|def|cfg|clo|fd|ldf|out|toc)))(?:\s|\)|$)"#).unwrap();
    let warning =
        regex::Regex::new(r"^(?:LaTeX(?: Font)?|Package [\w.-]+|Class [\w.-]+) Warning:").unwrap();
    let input_line = regex::Regex::new(r"(?:on input line|at lines?)\s+(\d+)").unwrap();
    let error_line = regex::Regex::new(r"^l\.(\d+)\s").unwrap();
    let file_error = regex::Regex::new(r"^(.{1,1024}\.(?i:tex|sty|cls)):(\d+):\s*(.+)").unwrap();
    let normalize = |path: &str| {
        let absolute = path.strip_prefix("/home/web_user/project_dir/");
        let path = absolute.unwrap_or(path);
        let path = path.strip_prefix("./").unwrap_or(path);
        if !path.starts_with('/') {
            let base = if absolute.is_some() {
                ""
            } else {
                request
                    .main_file
                    .as_deref()
                    .and_then(|main| main.rsplit_once('/'))
                    .map_or("", |(dir, _)| dir)
            };
            let mut parts: Vec<_> = base.split('/').filter(|part| !part.is_empty()).collect();
            let mut escaped = false;
            for part in path.split('/') {
                match part {
                    "" | "." => {}
                    ".." => {
                        if parts.pop().is_none() {
                            escaped = true;
                            break;
                        }
                    }
                    _ => parts.push(part),
                }
            }
            let resolved = parts.join("/");
            if !escaped
                && crate::valid_path(&resolved)
                && (request.project_files.is_empty() || request.project_files.contains(&resolved))
            {
                return resolved;
            }
        }
        path.to_string()
    };
    let tex_command =
        regex::Regex::new(r"^\$ (?:\S*/)?(?:luahblatex|lualatex|luahbtex|luatex)(?:\s|$)").unwrap();
    let lines: Vec<_> = request.log.lines().collect();
    let mut stack: Vec<Option<String>> = Vec::new();
    let mut root = None;
    let mut first_error = None;
    let mut warnings = Vec::new();
    let mut seen = BTreeSet::new();
    let mut glyphs = false;
    for (index, line) in lines.iter().enumerate() {
        // A later TeX pass supersedes warnings, including glyph coverage. LOG and
        // STDOUT are duplicate evidence within a pass, not new passes. Auxiliary
        // commands (BibTeX/Biber) do not supersede the last TeX pass.
        if tex_command.is_match(line) {
            warnings.clear();
            seen.clear();
            glyphs = false;
        }
        if matches!(*line, "LOG:" | "STDOUT:") || line.starts_with("$ ") {
            stack.clear();
            root = None;
        }
        let current = || {
            stack
                .iter()
                .rev()
                .find_map(Clone::clone)
                .or_else(|| root.clone())
        };
        if first_error.is_none() {
            if let Some(found) = file_error.captures(line) {
                first_error = Some((Some(normalize(&found[1])), found[2].parse().ok()));
            } else if line.starts_with("! ") && !line.contains("==> Fatal") {
                let number = lines[index + 1..]
                    .iter()
                    .take(30)
                    .find_map(|next| error_line.captures(next).and_then(|c| c[1].parse().ok()));
                first_error = Some((current(), number));
            }
        }
        if request.success && !glyphs && line.starts_with("Missing character: There is no ") {
            let mut entry = issue(
                "missing-glyphs",
                "The selected font is missing characters",
                "TeX produced a PDF but reported characters absent from the selected font.",
                "Choose a font covering the document's scripts or import suitable licensed OTF/TTF files. Review the PDF before sharing it.",
            );
            entry.severity = "warning".into();
            entry.file = current();
            warnings.push(entry);
            glyphs = true;
        }
        if warning.is_match(line) {
            if RUNTIME_WARNINGS
                .iter()
                .any(|ignored| line.trim() == *ignored)
            {
                continue;
            }
            let mut summary = bounded(line, MAX_TEXT);
            for next in lines[index + 1..].iter().take(8) {
                if next.is_empty()
                    || warning.is_match(next)
                    || next.starts_with('!')
                    || summary.len() >= MAX_TEXT
                {
                    break;
                }
                // Wrapped warnings either indent or carry the package prefix.
                if !next.starts_with(char::is_whitespace) && !next.starts_with('(') {
                    break;
                }
                summary.push(' ');
                summary.push_str(&bounded(next, MAX_TEXT - summary.len()));
            }
            let number = input_line
                .captures(&summary)
                .and_then(|c| c[1].parse().ok());
            let file = current();
            if seen.insert((summary.clone(), file.clone(), number)) && warnings.len() < MAX_ISSUES {
                let mut entry = issue(
                    "latex-warning",
                    summary,
                    "LaTeX reported a warning during this compilation run.",
                    "Review the source and recompile.",
                );
                entry.severity = "warning".into();
                entry.file = file;
                entry.line = number;
                warnings.push(entry);
            }
            continue;
        }
        if line.starts_with('!') || error_line.is_match(line) {
            continue;
        }
        let mut rest = *line;
        while let Some(at) = rest.find(['(', ')']) {
            let ch = rest.as_bytes()[at];
            rest = &rest[at + 1..];
            if ch == b')' {
                stack.pop();
                continue;
            }
            if let Some(found) = opening.captures(rest) {
                let name = found.get(1).or_else(|| found.get(2)).unwrap();
                let path = normalize(name.as_str());
                if root.is_none() && path.to_ascii_lowercase().ends_with(".tex") {
                    root = Some(path.clone());
                }
                if stack.len() < 1024 {
                    stack.push(Some(path));
                }
                rest = &rest[name.end()..];
            } else if stack.len() < 1024 {
                stack.push(None);
            }
        }
    }
    (first_error, warnings, seen.len() + usize::from(glyphs))
}
#[derive(Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum Failure {
    Timeout { milliseconds: u32, phase: String },
    PackageTransfer { package: String, message: String },
    Environment { message: String },
    Runtime { message: String },
}
fn issue(code: &str, summary: impl Into<String>, detail: impl Into<String>, action: &str) -> Issue {
    Issue {
        code: code.into(),
        severity: "error".into(),
        summary: summary.into(),
        detail: detail.into(),
        action: action.into(),
        file: None,
        line: None,
    }
}
fn capture(pattern: &str, text: &str) -> Option<String> {
    regex::Regex::new(pattern)
        .unwrap()
        .captures(text)
        .map(|c| c[1].to_string())
}
fn clean(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}
fn folded(log: &str) -> String {
    let prefixes = regex::Regex::new(r"(?m)^\([A-Za-z0-9@._-]{1,64}\)[ \t]*").unwrap();
    clean(&prefixes.replace_all(log, ""))
}
pub fn missing_fonts(log: &str) -> Vec<String> {
    let text = folded(log);
    regex::Regex::new(r#"The font \"([^\"\r\n]{1,512})\"\s+cannot\s+be\s+found"#)
        .unwrap()
        .captures_iter(&text)
        .take(16)
        .map(|c| c[1].to_string())
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect()
}
pub fn missing_languages(log: &str) -> Vec<String> {
    regex::Regex::new(r"Package babel Error: Unknown option [`']([^'`]+)['`]")
        .unwrap()
        .captures_iter(&folded(log))
        .take(16)
        .map(|c| c[1].to_string())
        .filter(|s| {
            s.len() <= 64
                && s.bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b"-_".contains(&b))
        })
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect()
}
fn primary(log: &str) -> Option<Issue> {
    let text = folded(log);
    let blocked_version_check =
        text.contains("Cannot run piped system commands") && text.contains("\\ExplLoaderFileDate");
    if blocked_version_check
        || log.contains("Fatal format file error")
        || text.contains("Mismatched LaTeX support files")
        || text.contains("Incompatible format file")
    {
        return Some(issue(
            "format-mismatch",
            if blocked_version_check {
                "LaTeX format compatibility check failed"
            } else {
                "Compiler format and package versions do not match"
            },
            if blocked_version_check {
                "Expl3 reached its dependency version check, whose external diagnostic command is unavailable in the browser runtime. The prebuilt format and support files must come from a matching compiler release."
            } else {
                "The format is prebuilt for the pinned LuaLaTeX collection; replacing kernel/support files independently can invalidate it."
            },
            "Review local kernel overrides and use a matching compiler release. Rebuild/deploy formats with their compiler outside the browser; downloading another package cannot repair a format mismatch.",
        ));
    }
    let root = log
        .lines()
        .find_map(|line| {
            line.trim()
                .strip_prefix("! ")
                .filter(|line| !line.starts_with(" ==> Fatal"))
        })
        .map(str::to_string)
        .or_else(|| capture(r"(?m)^.{1,1024}\.(?i:tex|sty|cls):\d+:\s*(.+)", log));
    if root.as_ref().is_some_and(|root| root.starts_with("Font "))
        && (text.contains("Metric (TFM) file not found") || text.contains("not loadable"))
    {
        return Some(issue(
            "missing-font-file",
            "Font metrics or font files are missing",
            "TeX could not load a required font file.",
            "Check the font name and project font paths. Matching font packages download automatically; a font requiring a native generator needs prebuilt metrics/assets.",
        ));
    }
    let tool_context = match &root {
        Some(root) => [
            "minted",
            "svg",
            "pythontex",
            "gnuplottex",
            "asymptote",
            "glossaries",
            "epstopdf",
        ]
        .iter()
        .any(|p| root.contains(&format!("Package {p} Error"))),
        None => false,
    };
    if tool_context
        && [
            "shell escape",
            "shell-escape",
            "pygmentize",
            "latexminted",
            "inkscape",
            "makeglossaries",
            "Rscript",
            "gnuplot",
            "asymptote",
        ]
        .iter()
        .any(|s| text.contains(s))
    {
        let tool = if text.contains("Package minted Error") {
            "latexminted/Pygments"
        } else if text.contains("Package svg Error") {
            "Inkscape"
        } else if text.contains("Package glossaries Error") {
            "makeglossaries"
        } else {
            "an external program"
        };
        return Some(issue(
            "external-tool",
            format!("This document needs {tool}"),
            "Browser compilation cannot run operating-system commands or enable shell escape. TeX packages alone do not supply those executables.",
            "Generate the required assets/output locally and import them, use a pure-TeX alternative, or compile with an explicitly configured native backend when available.",
        ));
    }
    if text.contains("requires XeTeX")
        || text.contains("requires either XeTeX") && !text.contains("or LuaTeX")
    {
        return Some(issue(
            "unsupported-engine",
            "This package requires a different TeX engine",
            "Scribyra currently exposes LuaLaTeX only.",
            "Choose a LuaLaTeX-compatible class/package. Downloading more packages will not change the engine.",
        ));
    }
    if let Some(extension) = capture(r"Unknown graphics extension:\s*(\.[A-Za-z0-9]+)", &text) {
        return Some(issue(
            "unsupported-asset",
            format!("Unsupported graphic format: {extension}"),
            "This compiler cannot automatically run an external image converter.",
            "Convert the image to PDF, PNG or JPEG and update the project reference.",
        ));
    }
    if let Some(language) = capture(
        r"Package babel Error: Unknown option [`']([^'`]+)['`]",
        &text,
    ) {
        return Some(issue(
            "missing-language",
            format!("Missing Babel language support: {language}"),
            "The selected language definition is not currently available to the compiler.",
            "Use the exact Babel language name. Required supported language packages download automatically; otherwise add the language files to the project or use a matching static support release.",
        ));
    }
    if let Some(file) = capture(
        r"(?:LaTeX Error: File|Package [A-Za-z0-9_.-]+ Error: File|I can't find file)\s*[`']([^'`\r\n]+)['`]",
        log,
    ) {
        let asset = [
            ".bib", ".png", ".jpg", ".jpeg", ".pdf", ".svg", ".eps", ".csv",
        ]
        .iter()
        .any(|ext| file.to_lowercase().ends_with(ext));
        let result = issue(
            if asset {
                "missing-project-file"
            } else {
                "missing-tex-file"
            },
            format!("Missing TeX file: {file}"),
            "The compiler reported a required file after searching project and installed TeX files.",
            if asset {
                "Add the referenced project asset/bibliography and check its spelling and path relative to the main document. A random package cannot replace project data."
            } else {
                "Check project paths and local package overrides. Supported public dependencies download automatically; for an unavailable package use its matching runtime files or a verified package bundle."
            },
        );
        return Some(result);
    }
    if let Some(font) = missing_fonts(log).first() {
        return Some(issue(
            "missing-font",
            format!("Font not available: {font}"),
            "The browser cannot read arbitrary system-installed fonts. Known distribution families can download; an unknown family needs project font files.",
            "Check the family name, choose an indexed family, or import licensed OTF/TTF files and reference them with fontspec's Path option.",
        ));
    }
    if let Some(style) = capture(r"I couldn't open style file ([^\s]+)", log) {
        return Some(issue(
            "missing-tex-file",
            format!("Missing bibliography style: {style}"),
            "BibTeX could not locate its requested style.",
            "Check the style name or add its .bst file. Matching public styles can be downloaded automatically.",
        ));
    }
    if let Some(module) = capture(r"module '([^'\r\n]+)' not found", log) {
        return Some(issue(
            "missing-lua-module",
            format!("Missing Lua module: {module}"),
            "The Lua module was not found in the project or compiler library.",
            "Add the Lua source under its expected module path or use a matching TeX package. Native shared-library modules cannot be installed into browser Lua.",
        ));
    }
    if let Some(root) = root {
        let mut result = issue(
            "source-error",
            clean(&root),
            "TeX stopped on a document/package error. Optional missing-file probes are not evidence of another required package.",
            "Open the log and fix the first TeX error. Review any local class/package listed below before changing the compiler environment.",
        );
        result.line = capture(r"(?m)^l\.(\d+)\s", log).and_then(|line| line.parse().ok());
        return Some(result);
    }
    if let Some(message) = capture(r"(?m)^ERROR - (.+)", log) {
        return Some(issue(
            "bibliography-error",
            format!("Bibliography error: {message}"),
            "The bibliography processor failed.",
            "Check the bibliography file, backend and citation data. An earlier TeX error must be fixed before rerunning the bibliography processor.",
        ));
    }
    None
}
pub fn package_resolution_allowed(log: &str) -> bool {
    primary(log).is_none_or(|issue| {
        matches!(
            issue.code.as_str(),
            "missing-tex-file"
                | "missing-language"
                | "missing-font"
                | "missing-font-file"
                | "missing-lua-module"
        )
    })
}
pub fn diagnose(request: Request) -> Result<Report, String> {
    if request.log.len() > 8 * 1024 * 1024
        || request
            .main_file
            .as_ref()
            .is_some_and(|p| !crate::valid_path(p))
        || request.recorder.len() > 1024 * 1024
        || request.project_files.len() > 10000
        || request.project_files.iter().any(|p| !crate::valid_path(p))
        || request.stalled_packages.len() > 64
        || request.stalled_packages.iter().any(|p| p.len() > 128)
    {
        return Err("Compiler diagnostic evidence exceeds its bounds".into());
    }
    let (location, warnings, mut warning_count) = log_evidence(&request);
    let mut issues = Vec::new();
    let allow = request.failure.is_none() && package_resolution_allowed(&request.log);
    if let Some(failure) = request.failure {
        let entry = match failure {
            Failure::Timeout {
                milliseconds,
                phase,
            } => {
                if milliseconds > 3600000 || phase.len() > 1024 {
                    return Err("Invalid timeout evidence".into());
                }
                issue(
                    "compile-timeout",
                    format!(
                        "Compilation timed out after {} seconds",
                        milliseconds / 1000
                    ),
                    format!(
                        "Last stage: {phase}. The compiler execution budget was exhausted; project sources and the previous PDF are preserved. Component preparation is timed separately."
                    ),
                    "Check for loops, simplify the document or use a native compiler for a longer job. Cached packages remain available for a retry.",
                )
            }
            Failure::PackageTransfer { package, message } => {
                if package.len() > 128 || message.len() > 8192 {
                    return Err("Invalid package failure evidence".into());
                }
                issue(
                    "package-transfer",
                    format!("Could not load TeX package: {package}"),
                    message,
                    "Retry to resume the pinned download, use a matching verified package bundle, or configure a CORS-enabled mirror containing that exact revision. A changed checksum must never be ignored.",
                )
            }
            Failure::Environment { message } => {
                if message.len() > 8192 {
                    return Err("Invalid environment evidence".into());
                }
                issue(
                    "environment-mismatch",
                    "TeX environment needs attention",
                    message,
                    "Review the locked compiler/catalog identity. Unlock explicitly before compiling with a changed environment, then prepare a new lock.",
                )
            }
            Failure::Runtime { message } => {
                if message.len() > 8192 {
                    return Err("Invalid runtime evidence".into());
                }
                issue(
                    "runtime-unavailable",
                    "Compiler unavailable",
                    message,
                    "Check the compiler assets and connection, or prepare the verified runtime for offline use. Project sources are unchanged.",
                )
            }
        };
        issues.push(entry);
    } else if !request.success {
        issues.push(primary(&request.log).unwrap_or_else(|| {
            issue(
                "compiler-failure",
                "Compilation failed",
                "No recognized root error was found in the compiler output.",
                "Open the full compilation log and check the first failing command.",
            )
        }));
    }
    if let (Some(entry), Some((file, line))) = (issues.first_mut(), location.clone()) {
        entry.file = file;
        entry.line = line;
    }
    if !request.success && !request.stalled_packages.is_empty() {
        issues.push(issue("resolution-stalled","Package resolution made no progress",format!("Already installed: {}. The required file/font remains unresolved; the same archives will not be downloaded repeatedly.",request.stalled_packages.join(", ")),"Review local overrides, filenames, font names and compiler/package compatibility. Import a verified matching package set or fix the source before retrying."));
    }
    if let (Some(entry), Some((file, line))) = (
        issues
            .iter_mut()
            .find(|entry| entry.code == "resolution-stalled"),
        location,
    ) {
        entry.file = file;
        entry.line = line;
    }
    let files: BTreeSet<_> = request.project_files.iter().map(String::as_str).collect();
    let mut seen = BTreeSet::new();
    for line in request.recorder.lines() {
        let Some(path) = line.strip_prefix("INPUT ") else {
            continue;
        };
        let path = path
            .strip_prefix("/home/web_user/project_dir/")
            .or_else(|| path.strip_prefix("./"))
            .unwrap_or(path);
        if !files.contains(path)
            || !(path.ends_with(".sty") || path.ends_with(".cls"))
            || !seen.insert(path.to_string())
        {
            continue;
        }
        if seen.len() > 32 {
            break;
        }
        let mut entry = issue(
            "project-package",
            format!("Project package loaded: {path}"),
            "The compiler used this project's class/package file. Project copies take precedence over distributed and downloaded copies.",
            "Keep this file if intentional. To use the distributed version, rename/remove the project copy and review its references.",
        );
        entry.severity = "info".into();
        entry.file = Some(path.into());
        issues.push(entry);
    }
    if request.recorder_truncated {
        let mut entry = issue(
            "recorder-limit",
            "Some compiler inputs were omitted from the report",
            "The bounded input recorder reached its limit; compilation output is still valid.",
            "Use the full native compiler log when investigating additional input files.",
        );
        entry.severity = "warning".into();
        issues.push(entry);
    }
    let truncated = issues.len() + warning_count > MAX_ISSUES;
    warning_count += issues
        .iter()
        .filter(|entry| entry.severity == "warning")
        .count();
    issues.extend(warnings);
    issues.truncate(MAX_ISSUES);
    for entry in &mut issues {
        entry.summary = bounded(&entry.summary, MAX_TEXT);
        entry.detail = bounded(&entry.detail, 8192);
        entry.action = bounded(&entry.action, MAX_TEXT);
    }
    Ok(Report {
        version: 1,
        issues,
        allow_package_resolution: allow,
        warning_count,
        truncated,
    })
}
#[cfg(test)]
mod tests {
    use super::*;
    fn report(log: &str) -> Report {
        diagnose(Request {
            log: log.into(),
            ..Default::default()
        })
        .unwrap()
    }
    #[test]
    fn fixture_logs_attribute_errors_to_sources_not_missing_dependencies() {
        for (log, file, code) in [
            (
                include_str!("../../../fixtures/diagnostics/missing-package.txt"),
                "main.tex",
                "missing-tex-file",
            ),
            (
                include_str!("../../../fixtures/diagnostics/thesis-error.txt"),
                "chapters/page-050.tex",
                "source-error",
            ),
        ] {
            let r = report(log);
            assert_eq!(r.issues[0].code, code);
            assert_eq!(r.issues[0].file.as_deref(), Some(file));
            assert_eq!(r.issues[0].line, Some(1));
        }
    }
    #[test]
    fn article_resolves_earlier_pass_warnings_without_stdout_duplicates() {
        let log = include_str!("../../../fixtures/diagnostics/article.txt");
        let r = diagnose(Request {
            success: true,
            log: log.into(),
            ..Default::default()
        })
        .unwrap();
        assert_eq!(r.warning_count, 0);
        assert!(r.issues.is_empty());
        assert!(!r.truncated);
        let doubled = diagnose(Request {
            success: true,
            log: format!("{log}\n{log}"),
            ..Default::default()
        })
        .unwrap();
        assert_eq!(doubled.warning_count, 0);
    }
    #[test]
    fn final_tex_pass_retains_actionable_warnings_and_filters_only_runtime_noise() {
        let r = diagnose(Request {
            success: true,
            log: "$ luahblatex main.tex\n(./main.tex\nLaTeX Warning: Resolved reference on input line 2.\n\nMissing character: There is no 字 in font Test\n$ luahblatex main.tex\nLOG:\n(./main.tex\nPackage epstopdf Warning: Shell escape feature is not enabled.\n\nPackage epstopdf Warning: An actionable conversion problem on input line 4.\n\nLaTeX Warning: Persistent reference on input line 8.\n\nSTDOUT:\n(./main.tex\nLaTeX Warning: Persistent reference on input line 8.\n\n$ biber main\n".into(),
            ..Default::default()
        }).unwrap();
        assert_eq!(r.warning_count, 2);
        assert_eq!(r.issues.len(), 2);
        assert_eq!(r.issues[0].line, Some(4));
        assert_eq!(r.issues[1].file.as_deref(), Some("main.tex"));
        assert_eq!(r.issues[1].line, Some(8));
        assert!(
            r.issues
                .iter()
                .all(|i| !i.summary.contains("Resolved reference"))
        );
        let single = diagnose(Request {
            success: true,
            log: "Package epstopdf Warning: Shell escape feature is not enabled.\n\nLaTeX Warning: Still actionable.\n".into(),
            ..Default::default()
        }).unwrap();
        assert_eq!(single.warning_count, 1);
    }
    #[test]
    fn nested_inputs_close_and_relative_paths_use_the_main_directory() {
        let r = diagnose(Request {
            main_file: Some("paper/main.tex".into()),
            project_files: vec!["paper/main.tex".into(), "paper/chapters/été.tex".into()],
            log: "(./main.tex (./chapters/été.tex\n! Undefined control sequence.\nl.7 \\bad\n"
                .into(),
            ..Default::default()
        })
        .unwrap();
        assert_eq!(r.issues[0].file.as_deref(), Some("paper/chapters/été.tex"));
        assert_eq!(r.issues[0].line, Some(7));
        let r = report("(./main.tex (./chapters/one.tex)\n! Missing $ inserted.\nl.12 text\n");
        assert_eq!(r.issues[0].file.as_deref(), Some("main.tex"));
        for path in ["Main.TeX", "main.tex.v2.TEX"] {
            let r = report(&format!(
                "(./{path}\n! Undefined control sequence.\nl.9 \\bad\n"
            ));
            assert_eq!(r.issues[0].file.as_deref(), Some(path));
            assert_eq!(r.issues[0].line, Some(9));
        }
        for path in ["chapters/été.tex", "chapters/été.TeX"] {
            let r = report(&format!("./{path}:9: Undefined control sequence."));
            assert_eq!(r.issues[0].code, "source-error");
            assert_eq!(r.issues[0].file.as_deref(), Some(path));
            assert_eq!(r.issues[0].line, Some(9));
        }
        assert_eq!(
            report("! Missing $ inserted.\nl.2 text").issues[0].file,
            None
        );
    }
    #[test]
    fn warnings_and_long_unicode_messages_have_explicit_output_bounds() {
        let log = (0..150)
            .map(|i| format!("LaTeX Warning: warning {i} {}\n\n", "é".repeat(1000)))
            .collect::<String>();
        let r = diagnose(Request {
            success: true,
            log,
            ..Default::default()
        })
        .unwrap();
        assert_eq!(r.warning_count, 150);
        assert_eq!(r.issues.len(), MAX_ISSUES);
        assert!(r.truncated);
        assert!(r.issues.iter().all(|entry| entry.summary.len() <= MAX_TEXT));
        assert!(
            report(&format!("! {}\nl.1 bad", "é".repeat(10000))).issues[0]
                .summary
                .len()
                <= MAX_TEXT
        );
        assert!(
            diagnose(Request {
                log: "x".repeat(8 * 1024 * 1024 + 1),
                ..Default::default()
            })
            .is_err()
        );
    }
    #[test]
    fn parent_paths_and_quoted_names_preserve_exact_project_identity() {
        for path in [
            "../chapters/été draft.tex",
            "/home/web_user/project_dir/chapters/été draft.tex",
        ] {
            let r = diagnose(Request {
                main_file: Some("paper/main.tex".into()),
                project_files: vec!["paper/main.tex".into(), "chapters/été draft.tex".into()],
                log: format!("(./main.tex (\"{path}\"\n! Undefined control sequence.\nl.6 \\bad\n"),
                ..Default::default()
            })
            .unwrap();
            assert_eq!(r.issues[0].file.as_deref(), Some("chapters/été draft.tex"));
            assert_eq!(r.issues[0].line, Some(6));
        }
        let r = report("(./main.tex\nMissing character: There is no 字 in font Latin Modern\n");
        // The glyph warning is emitted only for a successful PDF, as before.
        assert_eq!(r.warning_count, 0);
        let r = diagnose(Request {
            success: true,
            log: "(./main.tex\nMissing character: There is no 字 in font Latin Modern\n".into(),
            ..Default::default()
        })
        .unwrap();
        assert_eq!(r.issues[0].file.as_deref(), Some("main.tex"));
        assert_eq!(r.warning_count, 1);
    }
    #[test]
    fn root_error_precedes_bibliography_and_optional_probes() {
        let r = report("! Undefined control sequence.\nl.4 \\bad\nERROR - malformed .bcf");
        assert_eq!(r.issues[0].code, "source-error");
        assert_eq!(r.issues[0].line, Some(4));
        assert!(!r.allow_package_resolution);
    }
    #[test]
    fn wrapped_font_errors_and_external_tools_are_actionable() {
        let r = report(
            "! Package fontspec Error:\n(fontspec) The font \"Unknown Font\" cannot be\n(fontspec) found;",
        );
        assert_eq!(r.issues[0].code, "missing-font");
        assert!(r.issues[0].summary.contains("Unknown Font"));
        assert!(r.allow_package_resolution);
        let r =
            report("! Package minted Error: You must invoke LaTeX with the -shell-escape flag.");
        assert_eq!(r.issues[0].code, "external-tool");
        assert!(!r.allow_package_resolution);
        assert_eq!(
            report("! FancyVerb Error: Extraneous input between end and line end").issues[0].code,
            "source-error"
        );
    }
    #[test]
    fn project_data_is_not_replaced_by_arbitrary_tex_packages() {
        let r = report("! LaTeX Error: File `references.bib' not found.");
        assert_eq!(r.issues[0].code, "missing-project-file");
        assert!(!r.allow_package_resolution);
        assert!(report("! LaTeX Error: File `IEEEtran.cls' not found.").allow_package_resolution);
        assert!(!report("Fatal format file error; I'm stymied").allow_package_resolution);
    }
    #[test]
    fn only_recorded_project_packages_are_reported() {
        let r=diagnose(Request{success:true,project_files:vec!["main.tex".into(),"xcolor.sty".into(),"unused.cls".into()],recorder:"INPUT ./main.tex\nINPUT ./xcolor.sty\nINPUT ./xcolor.sty\nINPUT /texlive/unused.cls\nINPUT ../secret.cls".into(),..Default::default()}).unwrap();
        assert_eq!(r.issues.len(), 1);
        assert_eq!(r.issues[0].file.as_deref(), Some("xcolor.sty"));
        assert_eq!(r.issues[0].severity, "info");
    }
}
