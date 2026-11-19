//! Shared project search and source outline for browser workers and native tools.
use regex::{Regex, RegexBuilder};
use serde::{Deserialize, Serialize};
const MAX_RESULTS: usize = 2000;
const MAX_PREVIEW_BYTES: usize = 1024 * 1024;
#[derive(Deserialize)]
pub struct SourceFile {
    pub id: String,
    pub path: String,
    pub content: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchRequest {
    pub files: Vec<SourceFile>,
    pub query: String,
    #[serde(default)]
    pub replacement: String,
    #[serde(default)]
    pub case_sensitive: bool,
    #[serde(default)]
    pub whole_word: bool,
    #[serde(default)]
    pub regex_mode: bool,
}
#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SearchMatch {
    pub file_id: String,
    pub path: String,
    pub start: usize,
    pub end: usize,
    pub line: usize,
    pub column: usize,
    pub text: String,
    pub replacement: String,
    pub preview: String,
}
#[derive(Serialize, Default, Debug)]
pub struct SearchResult {
    pub matches: Vec<SearchMatch>,
    pub truncated: bool,
}
#[derive(Default)]
struct Position {
    byte: usize,
    utf16: usize,
    line: usize,
    column: usize,
}
impl Position {
    fn at(&mut self, text: &str, at: usize) -> (usize, usize, usize) {
        for c in text[self.byte..at].chars() {
            self.utf16 += c.len_utf16();
            if c == '\n' {
                self.line += 1;
                self.column = 0;
            } else {
                self.column += c.len_utf16();
            }
        }
        self.byte = at;
        (self.utf16, self.line + 1, self.column + 1)
    }
}
fn valid_sources(files: &[SourceFile]) -> Result<(), String> {
    if files.len() > 512 || files.iter().map(|f| f.content.len()).sum::<usize>() > 64 * 1024 * 1024
    {
        return Err("Search exceeds the project size limit.".into());
    }
    Ok(())
}
pub fn search(request: SearchRequest) -> Result<SearchResult, String> {
    valid_sources(&request.files)?;
    if request.query.is_empty() {
        return Ok(SearchResult::default());
    }
    if request.query.len() > 4096 || request.replacement.len() > 65536 {
        return Err("Search query or replacement is too long.".into());
    }
    let pattern = if request.regex_mode {
        request.query.clone()
    } else {
        regex::escape(&request.query)
    };
    let regex = RegexBuilder::new(&pattern)
        .case_insensitive(!request.case_sensitive)
        .multi_line(true)
        .size_limit(2 * 1024 * 1024)
        .dfa_size_limit(2 * 1024 * 1024)
        .build()
        .map_err(|error| error.to_string())?;
    let word = Regex::new(r"^\w$").unwrap();
    let word_char = |c: Option<char>| c.is_some_and(|c| word.is_match(c.encode_utf8(&mut [0; 4])));
    let mut result = SearchResult::default();
    let mut payload = 0;
    for file in request.files {
        let mut position = Position::default();
        for capture in regex.captures_iter(&file.content) {
            let found = capture.get(0).unwrap();
            if request.whole_word
                && (word_char(file.content[..found.start()].chars().next_back())
                    || word_char(file.content[found.end()..].chars().next()))
            {
                continue;
            }
            // Bound capture expansion before allocating: repeated $0 can multiply a large match.
            let expansion_bound = request.replacement.len().saturating_add(
                request
                    .replacement
                    .bytes()
                    .filter(|b| *b == b'$')
                    .count()
                    .saturating_mul(found.len()),
            );
            if found.len() > MAX_PREVIEW_BYTES
                || (request.regex_mode && expansion_bound > MAX_PREVIEW_BYTES)
            {
                result.truncated = true;
                return Ok(result);
            }
            let replacement = if request.regex_mode {
                let mut expanded = String::new();
                capture.expand(&request.replacement, &mut expanded);
                expanded
            } else {
                request.replacement.clone()
            };
            payload += found.len() + replacement.len();
            if result.matches.len() >= MAX_RESULTS || payload > MAX_PREVIEW_BYTES {
                result.truncated = true;
                return Ok(result);
            }
            let (start, line, column) = position.at(&file.content, found.start());
            let mut preview_start = found.start().saturating_sub(60);
            while !file.content.is_char_boundary(preview_start) {
                preview_start += 1;
            }
            let preview = file.content[preview_start..]
                .chars()
                .take(200)
                .map(|c| if c == '\n' { '↵' } else { c })
                .collect();
            result.matches.push(SearchMatch {
                file_id: file.id.clone(),
                path: file.path.clone(),
                start,
                end: start + found.as_str().encode_utf16().count(),
                line,
                column,
                text: found.as_str().into(),
                replacement,
                preview,
            });
        }
    }
    Ok(result)
}
#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Heading {
    pub file_id: String,
    pub path: String,
    pub start: usize,
    pub line: usize,
    pub level: usize,
    pub title: String,
}
/// An `\input`, `\include` or `\subfile` with a literal argument. The browser splices the named
/// file's headings in at this point, so the outline follows document order across files.
#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Include {
    pub file_id: String,
    pub start: usize,
    pub target: String,
}
#[derive(Serialize, Default, Debug)]
pub struct Outline {
    pub items: Vec<Heading>,
    pub includes: Vec<Include>,
    pub truncated: bool,
}
pub fn outline(files: Vec<SourceFile>) -> Result<Outline, String> {
    valid_sources(&files)?;
    let mut result = Outline::default();
    for file in files {
        if !file.path.ends_with(".tex") && !file.path.ends_with(".ltx") {
            continue;
        }
        let text = &file.content;
        let bytes = text.as_bytes();
        let mut i = 0;
        let mut position = Position::default();
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
            while i < bytes.len() && bytes[i].is_ascii_alphabetic() {
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
            i = crate::references::space(bytes, i);
            if command == "begin" {
                if let Some((a, b, next)) = crate::references::group(bytes, i, b'{', b'}') {
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
            if matches!(command, "input" | "include" | "subfile") {
                if let Some((a, b, next)) = crate::references::group(bytes, i, b'{', b'}') {
                    let target = text[a..b].trim();
                    if !target.is_empty() && result.includes.len() < MAX_RESULTS {
                        let (start, _, _) = position.at(text, command_at);
                        result.includes.push(Include {
                            file_id: file.id.clone(),
                            start,
                            target: target.into(),
                        });
                    }
                    i = next;
                }
                continue;
            }
            let level = match command {
                "title" | "part" => 0,
                "chapter" => 1,
                "section" | "frametitle" => 2,
                "subsection" => 3,
                "subsubsection" => 4,
                "paragraph" => 5,
                "subparagraph" => 6,
                _ => continue,
            };
            if bytes.get(i) == Some(&b'[') {
                if let Some((_, _, next)) = crate::references::group(bytes, i, b'[', b']') {
                    i = crate::references::space(bytes, next);
                }
            }
            let Some((a, b, next)) = crate::references::group(bytes, i, b'{', b'}') else {
                continue;
            };
            i = next;
            if result.items.len() >= MAX_RESULTS {
                result.truncated = true;
                return Ok(result);
            }
            let (start, line, _) = position.at(text, command_at);
            let title = plain_title(&text[a..b]);
            result.items.push(Heading {
                file_id: file.id.clone(),
                path: file.path.clone(),
                start,
                line,
                level,
                title: if title.is_empty() {
                    format!("Untitled {command}")
                } else {
                    title
                },
            });
        }
    }
    Ok(result)
}
/// Reads a heading the way a person sees it in the PDF: formatting commands, braces and math
/// delimiters go, labels and footnotes disappear, and a few symbols become their characters.
pub fn plain_title(raw: &str) -> String {
    let chars: Vec<char> = raw.chars().collect();
    let mut out = String::new();
    plain_into(&chars, &mut out, 0);
    let mut title = String::new();
    for word in out.split_whitespace() {
        if !title.is_empty() {
            title.push(' ');
        }
        title.push_str(word);
        if title.chars().count() >= 200 {
            break;
        }
    }
    title.chars().take(200).collect()
}
fn group_end(chars: &[char], open: usize) -> usize {
    let (left, right) = if chars[open] == '[' {
        ('[', ']')
    } else {
        ('{', '}')
    };
    let mut depth = 0;
    let mut i = open;
    while i < chars.len() {
        match chars[i] {
            '\\' => i += 1,
            c if c == left => depth += 1,
            c if c == right => {
                depth -= 1;
                if depth == 0 {
                    return i;
                }
            }
            _ => {}
        }
        i += 1;
    }
    chars.len()
}
/// The next argument after `i`: its contents and the index after it.
fn argument(chars: &[char], mut i: usize) -> Option<(usize, usize, usize)> {
    while chars.get(i).is_some_and(|c| c.is_whitespace()) {
        i += 1;
    }
    while chars.get(i) == Some(&'[') {
        i = group_end(chars, i) + 1;
    }
    (chars.get(i) == Some(&'{')).then(|| {
        let end = group_end(chars, i);
        (i + 1, end.min(chars.len()), (end + 1).min(chars.len()))
    })
}
fn symbol(name: &str) -> Option<&'static str> {
    const GREEK: [(&str, &str); 34] = [
        ("alpha", "α"),
        ("beta", "β"),
        ("gamma", "γ"),
        ("delta", "δ"),
        ("epsilon", "ε"),
        ("varepsilon", "ε"),
        ("zeta", "ζ"),
        ("eta", "η"),
        ("theta", "θ"),
        ("iota", "ι"),
        ("kappa", "κ"),
        ("lambda", "λ"),
        ("mu", "μ"),
        ("nu", "ν"),
        ("xi", "ξ"),
        ("pi", "π"),
        ("rho", "ρ"),
        ("sigma", "σ"),
        ("tau", "τ"),
        ("phi", "φ"),
        ("varphi", "φ"),
        ("chi", "χ"),
        ("psi", "ψ"),
        ("omega", "ω"),
        ("Gamma", "Γ"),
        ("Delta", "Δ"),
        ("Theta", "Θ"),
        ("Lambda", "Λ"),
        ("Xi", "Ξ"),
        ("Pi", "Π"),
        ("Sigma", "Σ"),
        ("Phi", "Φ"),
        ("Psi", "Ψ"),
        ("Omega", "Ω"),
    ];
    Some(match name {
        "LaTeX" => "LaTeX",
        "TeX" => "TeX",
        "LaTeXe" => "LaTeX2ε",
        "ldots" | "dots" | "textellipsis" => "…",
        "textendash" => "–",
        "textemdash" => "—",
        "S" => "§",
        "times" => "×",
        "infty" => "∞",
        "to" | "rightarrow" => "→",
        "leq" | "le" => "≤",
        "geq" | "ge" => "≥",
        "neq" | "ne" => "≠",
        "pm" => "±",
        "cdot" => "·",
        "quad" | "qquad" | "space" | "enspace" | "thinspace" | "newline" | "linebreak" => " ",
        _ => return GREEK.iter().find(|(n, _)| *n == name).map(|(_, s)| *s),
    })
}
fn plain_into(chars: &[char], out: &mut String, depth: usize) {
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        match c {
            '\\' => {
                i += 1;
                let begin = i;
                while i < chars.len() && chars[i].is_ascii_alphabetic() {
                    i += 1;
                }
                if begin == i {
                    if let Some(&s) = chars.get(i) {
                        i += 1;
                        match s {
                            '\\' | ',' | ';' | ':' | '!' | ' ' | '>' => out.push(' '),
                            '-' | '/' | '@' => {}
                            other => out.push(other),
                        }
                    }
                    continue;
                }
                let name: String = chars[begin..i].iter().collect();
                if chars.get(i) == Some(&'*') {
                    i += 1;
                }
                match name.as_str() {
                    "label" | "index" | "footnote" | "footnotetext" | "thanks" | "glossary"
                    | "hspace" | "vspace" | "phantom" | "hphantom" | "vphantom" | "markboth"
                    | "markright" | "addcontentsline" | "nocite" => {
                        while let Some((_, _, next)) = argument(chars, i) {
                            i = next;
                            if !matches!(name.as_str(), "markboth" | "addcontentsline") {
                                break;
                            }
                        }
                    }
                    "texorpdfstring" => {
                        // The second argument is the plain-text form meant for bookmarks.
                        if let Some((_, _, next)) = argument(chars, i) {
                            i = next;
                            if let Some((a, b, next)) = argument(chars, i) {
                                if depth < 8 {
                                    plain_into(&chars[a..b], out, depth + 1);
                                }
                                i = next;
                            }
                        }
                    }
                    _ => match symbol(&name) {
                        Some(text) => out.push_str(text),
                        None => {
                            while chars.get(i).is_some_and(|c| *c == ' ') {
                                i += 1;
                            }
                        }
                    },
                }
            }
            '{' | '}' | '$' => i += 1,
            '~' => {
                out.push(' ');
                i += 1;
            }
            '-' if chars.get(i + 1) == Some(&'-') => {
                if chars.get(i + 2) == Some(&'-') {
                    out.push('—');
                    i += 3;
                } else {
                    out.push('–');
                    i += 2;
                }
            }
            '`' if chars.get(i + 1) == Some(&'`') => {
                out.push('“');
                i += 2;
            }
            '\'' if chars.get(i + 1) == Some(&'\'') => {
                out.push('”');
                i += 2;
            }
            _ => {
                out.push(c);
                i += 1;
            }
        }
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    fn file(text: &str) -> SourceFile {
        SourceFile {
            id: "a".into(),
            path: "main.tex".into(),
            content: text.into(),
        }
    }
    fn request(text: &str, query: &str) -> SearchRequest {
        SearchRequest {
            files: vec![file(text)],
            query: query.into(),
            replacement: "next".into(),
            case_sensitive: false,
            whole_word: false,
            regex_mode: false,
        }
    }
    #[test]
    fn unicode_positions_case_and_word_boundaries() {
        let mut input = request("🌍 Café cafés CAFÉ\ncafé", "café");
        input.whole_word = true;
        let result = search(input).unwrap();
        assert_eq!(result.matches.len(), 3);
        assert_eq!(result.matches[0].start, 3);
        assert_eq!(result.matches[0].end, 7);
        assert_eq!(result.matches[0].column, 4);
        assert_eq!(result.matches[2].line, 2);
        let mut input = request("xword word words", "word");
        input.whole_word = true;
        assert_eq!(search(input).unwrap().matches.len(), 1);
    }
    #[test]
    fn regex_captures_empty_matches_and_limits() {
        let mut input = request("ref:one\nref:two", r"ref:(\w+)");
        input.regex_mode = true;
        input.replacement = "cite:$1".into();
        let result = search(input).unwrap();
        assert_eq!(result.matches[1].replacement, "cite:two");
        let mut invalid = request("x", "[");
        invalid.regex_mode = true;
        assert!(search(invalid).is_err());
        let mut zero = request("a\nb", "^");
        zero.regex_mode = true;
        assert_eq!(search(zero).unwrap().matches.len(), 2);
        let many = search(request(&"x".repeat(2100), "x")).unwrap();
        assert!(many.truncated);
        assert_eq!(many.matches.len(), 2000);
        let literal = search(request("literal $1", "$1")).unwrap();
        assert_eq!(literal.matches[0].text, "$1");
    }
    #[test]
    fn outline_skips_comments_verbatim_and_supports_nested_titles() {
        let result=outline(vec![file("🌍 \\section[short]{Long \\emph{title}}\n% \\section{hidden}\n\\verb|\\section{hidden}|\n\\begin{minted}{tex}\\section{hidden}\\end{minted}\n\\subsection*{Next}")]).unwrap();
        assert_eq!(result.items.len(), 2);
        assert_eq!(result.items[0].start, 3);
        assert_eq!(result.items[0].title, "Long title");
        assert_eq!(result.items[1].level, 3);
        assert_eq!(result.items[1].line, 5);
    }
    #[test]
    fn outline_titles_read_as_plain_text_and_includes_keep_their_place() {
        for (raw, plain) in [
            (
                r"The \emph{very} \textbf{bold}  claim",
                "The very bold claim",
            ),
            (r"Results\label{sec:results}", "Results"),
            (
                r"A note\footnote{With {nested} braces.} here",
                "A note here",
            ),
            (
                r"$\alpha$-stable laws and \LaTeX{} -- an overview",
                "α-stable laws and LaTeX – an overview",
            ),
            (r"Costs \& benefits, 50\% off", "Costs & benefits, 50% off"),
            (
                r"\texorpdfstring{$E=mc^2$}{E = mc2} in practice",
                "E = mc2 in practice",
            ),
            (r"``Quoted''~text\\ broken", "“Quoted” text broken"),
            (r"\textsc{Unknown \mymacro args}", "Unknown args"),
        ] {
            assert_eq!(plain_title(raw), plain, "{raw}");
        }
        let result = outline(vec![file(
            "\\chapter{One}\n\\input{chapters/a}\n% \\include{hidden}\n\\include{b}\\section{Two}",
        )])
        .unwrap();
        assert_eq!(result.items.len(), 2);
        let targets: Vec<_> = result
            .includes
            .iter()
            .map(|i| (i.target.as_str(), i.start))
            .collect();
        assert_eq!(targets, [("chapters/a", 14), ("b", 52)]);
        assert!(result.items[1].start > result.includes[1].start);
    }
}
