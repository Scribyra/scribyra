//! Conservative literal TeX references. Offsets use UTF-16, matching Y.Text/CodeMirror.
//! This is a review aid, not a TeX macro interpreter or a replacement for kpathsea.
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct File {
    pub id: String,
    pub path: String,
    pub next_path: String,
    pub content: Option<String>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Request {
    pub files: Vec<File>,
    pub main_file: String,
    pub next_main_file: String,
}
#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Edit {
    pub file_id: String,
    pub path: String,
    pub line: usize,
    pub start: usize,
    pub end: usize,
    pub before: String,
    pub after: String,
}
#[derive(Serialize, Debug, Default)]
pub struct Review {
    pub edits: Vec<Edit>,
    pub warnings: Vec<String>,
}
fn dirname(path: &str) -> &str {
    path.rsplit_once('/').map_or("", |(dir, _)| dir)
}
pub fn relative(from_file: &str, to_file: &str) -> Result<String, String> {
    if !crate::valid_path(from_file) || !crate::valid_path(to_file) {
        return Err("Select valid project files before inserting a relative path.".into());
    }
    let from: Vec<_> = dirname(from_file)
        .split('/')
        .filter(|s| !s.is_empty())
        .collect();
    let to: Vec<_> = to_file.split('/').collect();
    let common = from.iter().zip(&to).take_while(|(a, b)| a == b).count();
    Ok(std::iter::repeat_n("..", from.len() - common)
        .chain(to[common..].iter().copied())
        .collect::<Vec<_>>()
        .join("/"))
}
fn resolve(base: &str, path: &str) -> Option<String> {
    if path.starts_with('/')
        || path.contains(['\\', '%', '#', '$', '{', '}', '~', '^', '"', '\n', '\r'])
    {
        return None;
    }
    let mut parts: Vec<_> = base.split('/').filter(|s| !s.is_empty()).collect();
    for part in path.split('/') {
        match part {
            "" | "." => {}
            ".." => {
                parts.pop()?;
            }
            _ => parts.push(part),
        }
    }
    Some(parts.join("/"))
}
pub(crate) fn space(bytes: &[u8], mut i: usize) -> usize {
    while i < bytes.len() && bytes[i].is_ascii_whitespace() {
        i += 1;
    }
    i
}
pub(crate) fn group(
    bytes: &[u8],
    start: usize,
    open: u8,
    close: u8,
) -> Option<(usize, usize, usize)> {
    if bytes.get(start) != Some(&open) {
        return None;
    }
    let mut depth = 1;
    let mut i = start + 1;
    while i < bytes.len() {
        if bytes[i] == b'\\' {
            i += 2;
            continue;
        }
        if bytes[i] == open {
            depth += 1;
        }
        if bytes[i] == close {
            depth -= 1;
            if depth == 0 {
                return Some((start + 1, i, i + 1));
            }
        }
        i += 1;
    }
    None
}
fn suffixes(command: &str) -> Option<&'static [&'static str]> {
    match command {
        "input" | "include" | "includeonly" | "subfile" => Some(&[".tex"]),
        "includegraphics" => Some(&[".pdf", ".png", ".jpg", ".jpeg", ".eps", ".mps", ".webp"]),
        "bibliography" | "addbibresource" => Some(&[".bib"]),
        "bibliographystyle" => Some(&[".bst"]),
        "lstinputlisting" | "verbatiminput" => Some(&[]),
        "documentclass" | "LoadClass" | "LoadClassWithOptions" => Some(&[".cls"]),
        "usepackage" | "RequirePackage" | "RequirePackageWithOptions" => Some(&[".sty"]),
        _ => None,
    }
}
#[derive(Default)]
struct Position {
    byte: usize,
    utf16: usize,
    line: usize,
}
impl Position {
    fn at(&mut self, text: &str, at: usize) -> (usize, usize) {
        if at < self.byte {
            *self = Self::default();
        }
        for c in text[self.byte..at].chars() {
            self.utf16 += c.len_utf16();
            if c == '\n' {
                self.line += 1;
            }
        }
        self.byte = at;
        (self.utf16, self.line + 1)
    }
}
fn warn(
    review: &mut Review,
    file: &File,
    text: &str,
    at: usize,
    position: &mut Position,
    reason: &str,
) {
    let (_, line) = position.at(text, at);
    review
        .warnings
        .push(format!("{}:{} — {}", file.path, line, reason));
}
pub fn plan(request: Request) -> Review {
    let mut review = Review::default();
    let by_path: HashMap<_, _> = request.files.iter().map(|f| (f.path.as_str(), f)).collect();
    for file in &request.files {
        let Some(text) = &file.content else {
            continue;
        };
        if !["tex", "sty", "cls", "ltx"]
            .iter()
            .any(|ext| file.path.ends_with(&format!(".{ext}")))
        {
            continue;
        }
        let bytes = text.as_bytes();
        let mut position = Position::default();
        let mut i = 0;
        while i < bytes.len() {
            if bytes[i] == b'%' {
                while i < bytes.len() && bytes[i] != b'\n' {
                    i += 1;
                }
                continue;
            }
            if bytes[i] != b'\\' {
                i += 1;
                continue;
            }
            let command_at = i;
            i += 1;
            let begin = i;
            while i < bytes.len() && (bytes[i].is_ascii_alphabetic() || bytes[i] == b'@') {
                i += 1;
            }
            if begin == i {
                i = (i + 1).min(bytes.len());
                continue;
            }
            let command = &text[begin..i];
            if bytes.get(i) == Some(&b'*') {
                i += 1;
            }
            if command == "verb" {
                if let Some(&delimiter) = bytes.get(i) {
                    i += 1;
                    while i < bytes.len() && bytes[i] != delimiter && bytes[i] != b'\n' {
                        i += 1;
                    }
                    i = (i + 1).min(bytes.len());
                }
                continue;
            }
            i = space(bytes, i);
            if command == "begin" {
                if let Some((a, b, next)) = group(bytes, i, b'{', b'}') {
                    if ["verbatim", "verbatim*", "Verbatim", "lstlisting", "minted"]
                        .contains(&&text[a..b])
                    {
                        let end = format!("\\end{{{}}}", &text[a..b]);
                        i = text[next..]
                            .find(&end)
                            .map_or(bytes.len(), |p| next + p + end.len());
                        continue;
                    }
                }
            }
            if [
                "graphicspath",
                "import",
                "subimport",
                "inputfrom",
                "subinputfrom",
                "includefrom",
                "subincludefrom",
                "input@path",
            ]
            .contains(&command)
            {
                warn(
                    &mut review,
                    file,
                    text,
                    command_at,
                    &mut position,
                    "Custom import/search paths need manual review; they are not interpreted.",
                );
            }
            let Some(suffixes) = suffixes(command) else {
                continue;
            };
            while bytes.get(i) == Some(&b'[') {
                let Some((_, _, next)) = group(bytes, i, b'[', b']') else {
                    break;
                };
                i = space(bytes, next);
            }
            let argument = group(bytes, i, b'{', b'}').or_else(|| {
                if command != "input" {
                    return None;
                }
                let start = i;
                while i < bytes.len() && !bytes[i].is_ascii_whitespace() && bytes[i] != b'%' {
                    i += 1;
                }
                (i > start).then_some((start, i, i))
            });
            let Some((a, b, next)) = argument else {
                continue;
            };
            i = next;
            let mut offset = a;
            let parts: Vec<_> = if [
                "bibliography",
                "includeonly",
                "usepackage",
                "RequirePackage",
                "RequirePackageWithOptions",
            ]
            .contains(&command)
            {
                text[a..b].split(',').collect()
            } else {
                vec![&text[a..b]]
            };
            for part in parts {
                let literal = part.trim();
                let start = offset + part.len() - part.trim_start().len();
                offset += part.len() + 1;
                let Some(path) = resolve(dirname(&request.main_file), literal) else {
                    warn(
                        &mut review,
                        file,
                        text,
                        start,
                        &mut position,
                        "Macro-generated, quoted or escaped reference needs manual review.",
                    );
                    continue;
                };
                if literal.is_empty() {
                    continue;
                }
                let (matches, extension): (Vec<&File>, bool) =
                    if let Some(target) = by_path.get(path.as_str()) {
                        (vec![*target], true)
                    } else {
                        (
                            suffixes
                                .iter()
                                .filter_map(|suffix| {
                                    by_path.get(format!("{path}{suffix}").as_str()).copied()
                                })
                                .collect(),
                            false,
                        )
                    };
                if matches.len() > 1 {
                    warn(
                        &mut review,
                        file,
                        text,
                        start,
                        &mut position,
                        "Several files match this extensionless reference; choose its target manually.",
                    );
                    continue;
                }
                let Some(target) = matches.first() else {
                    continue;
                };
                if target.next_path == target.path
                    && dirname(&request.main_file) == dirname(&request.next_main_file)
                {
                    continue;
                }
                let Ok(mut after) = relative(&request.next_main_file, &target.next_path) else {
                    continue;
                };
                if !extension {
                    if let Some(suffix) = suffixes
                        .iter()
                        .find(|suffix| target.path.ends_with(**suffix) && after.ends_with(**suffix))
                    {
                        after.truncate(after.len() - suffix.len());
                    }
                }
                if literal.starts_with("./") && !after.starts_with("../") {
                    after = format!("./{after}");
                }
                if after.contains(['\\', '%', '#', '$', '{', '}', '~', '^', '"']) {
                    warn(
                        &mut review,
                        file,
                        text,
                        start,
                        &mut position,
                        "Destination contains TeX special characters; rename it or escape this reference manually.",
                    );
                    continue;
                }
                if after == literal {
                    continue;
                }
                let (start_utf16, line) = position.at(text, start);
                review.edits.push(Edit {
                    file_id: file.id.clone(),
                    path: file.path.clone(),
                    line,
                    start: start_utf16,
                    end: start_utf16 + literal.encode_utf16().count(),
                    before: literal.into(),
                    after,
                });
            }
        }
    }
    review
}

#[cfg(test)]
mod tests {
    use super::*;
    fn file(id: &str, path: &str, next: &str, content: Option<&str>) -> File {
        File {
            id: id.into(),
            path: path.into(),
            next_path: next.into(),
            content: content.map(str::to_string),
        }
    }
    #[test]
    fn preserves_extensions_comments_verbatim_and_utf16_offsets() {
        let text = "🌍 \\input{chapters/été}\n% \\input{chapters/été}\n\\verb|\\input{chapters/été}|\n\\begin{verbatim}\\input{chapters/été}\\end{verbatim}\n\\input chapters/été.tex\n\\includegraphics[width=.5\\textwidth]{plots/figure}\n\\bibliography{refs, other}";
        let result = plan(Request {
            main_file: "main.tex".into(),
            next_main_file: "main.tex".into(),
            files: vec![
                file("main", "main.tex", "main.tex", Some(text)),
                file("chapter", "chapters/été.tex", "sections/été.tex", Some("")),
                file("image", "plots/figure.png", "images/figure.png", None),
                file("refs", "refs.bib", "bib/refs.bib", Some("")),
            ],
        });
        assert_eq!(result.edits.len(), 4);
        assert_eq!(result.edits[0].start, 10);
        assert_eq!(result.edits[0].after, "sections/été");
        assert_eq!(result.edits[1].after, "sections/été.tex");
        assert_eq!(result.edits[2].after, "images/figure");
        assert_eq!(result.edits[3].after, "bib/refs");
    }
    #[test]
    fn moving_main_changes_the_base_and_ambiguous_or_macro_paths_are_not_rewritten() {
        let result = plan(Request {
            main_file: "paper/main.tex".into(),
            next_main_file: "main.tex".into(),
            files: vec![
                file(
                    "main",
                    "paper/main.tex",
                    "main.tex",
                    Some(
                        "\\input{../chapter} \\includegraphics{plot} \\includegraphics{\\folder/pic} \\graphicspath{{fig/}}",
                    ),
                ),
                file("chapter", "chapter.tex", "chapter.tex", Some("")),
                file("png", "paper/plot.png", "images/plot.png", None),
                file("pdf", "paper/plot.pdf", "images/plot.pdf", None),
            ],
        });
        assert_eq!(result.edits.len(), 1);
        assert_eq!(result.edits[0].after, "chapter");
        assert_eq!(result.warnings.len(), 3);
        assert_eq!(
            relative("paper/main.tex", "images/figure.png").unwrap(),
            "../images/figure.png"
        );
    }
}
