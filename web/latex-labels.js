// Label keys for `\label{`: what the label marks (a heading, a float, an equation…), derived from the
// heading title or the caption, with the prefix style the project already uses, and unique in the
// project. Pure functions; `latex-completion.js` offers the result as the first option.

/** Environments a label can name, by the kind of thing they hold. Unnumbered (starred) maths is left out. */
const TARGETS = {
  figure: 'figure', 'figure*': 'figure', subfigure: 'figure', wrapfigure: 'figure', sidewaysfigure: 'figure',
  table: 'table', 'table*': 'table', subtable: 'table', wraptable: 'table', longtable: 'table', sidewaystable: 'table',
  equation: 'equation', align: 'equation', gather: 'equation', multline: 'equation', flalign: 'equation', alignat: 'equation', eqnarray: 'equation', subequations: 'equation',
  theorem: 'theorem', lemma: 'lemma', proposition: 'proposition', corollary: 'corollary', definition: 'definition', example: 'example', remark: 'remark',
  listing: 'listing', algorithm: 'algorithm',
};
/** Prefixes people use for each kind, most common first. The first is the default. */
const PREFIXES = {
  part: ['part', 'pt'], chapter: ['chap', 'ch', 'chapter', 'cha'], section: ['sec', 'section', 's'],
  subsection: ['subsec', 'ssec'], subsubsection: ['subsubsec', 'sssec'], paragraph: ['par', 'para'],
  figure: ['fig', 'figure', 'f'], table: ['tab', 'table', 'tbl', 't'], equation: ['eq', 'eqn', 'equation', 'e'],
  theorem: ['thm', 'theorem'], lemma: ['lem', 'lemma'], proposition: ['prop', 'proposition'], corollary: ['cor', 'corollary'],
  definition: ['def', 'defn', 'definition'], example: ['ex', 'example'], remark: ['rem', 'remark'],
  listing: ['lst', 'listing', 'code'], algorithm: ['alg', 'algo', 'algorithm'],
};
// Lower heading levels fall back to the prefix of the level above when the project has none of their own.
const FALLBACK = { subsection: 'section', subsubsection: 'subsection', paragraph: 'subsubsection' };
const STOP = new Set(['a', 'an', 'the', 'of', 'and', 'or', 'for', 'in', 'on', 'to', 'with', 'by', 'at', 'from', 'as', 'its', 'is']);
const MAX_WORDS = 5, MAX_SLUG = 40;

const blank = text => text.replace(/(\\[\s\S])|%[^\r\n]*/g, (match, escaped) => escaped || ' '.repeat(match.length));
/** Index just past the brace group that opens at `open`, or -1 when it does not close. */
function closing(text, open) {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const c = text[i];
    if (c === '\\') { i++; continue; }
    if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return i + 1;
  }
  return -1;
}
function group(text, open) { const end = closing(text, open); return end < 0 ? null : { text: text.slice(open + 1, end - 1), end }; }

/**
 * Words of a title, plain: commands, maths markup and accents removed, `\LaTeX` read as a word.
 * Labels and footnotes inside the title are dropped with their argument.
 */
export function titleWords(title) {
  let text = title.replace(/\\(?:label|footnote|cite[a-z]*|ref|eqref|cref|index|thanks)\*?\s*(?:\[[^\]]*\])?\s*\{[^{}]*\}/g, ' ')
    .replace(/\\(LaTeX|TeX|BibTeX|LaTeXe)\b/g, ' $1 ').replace(/\\[A-Za-z@]+\*?|\\./g, ' ');
  text = text.replace(/ß/g, 'ss').replace(/[æÆ]/g, 'ae').replace(/[œŒ]/g, 'oe').replace(/[øØ]/g, 'o').replace(/[łŁ]/g, 'l')
    .normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  return text.split(/[^a-z0-9]+/).filter(Boolean);
}
/** A slug of at most five words: `Related work on graph networks` → `related-work-graph-networks`. */
export function slugify(title, separator = '-') {
  const words = titleWords(title), kept = words.filter(word => !STOP.has(word));
  let slug = '';
  for (const word of (kept.length ? kept : words).slice(0, MAX_WORDS)) {
    const next = slug ? slug + separator + word : word;
    if (next.length > MAX_SLUG && slug) break;
    slug = next.slice(0, MAX_SLUG);
  }
  return slug;
}

/**
 * The project's label style from its existing keys: prefix counts, the separator after the prefix
 * (`:` in `fig:map`) and between words (`-` in `sec:related-work`).
 */
export function labelStyle(keys) {
  const prefixes = {}, separators = {}, words = {};
  for (const key of keys) {
    const match = /^([A-Za-z]+)([:._-])(.+)$/.exec(key);
    if (!match) continue;
    prefixes[match[1].toLowerCase()] = (prefixes[match[1].toLowerCase()] || 0) + 1;
    separators[match[2]] = (separators[match[2]] || 0) + 1;
    for (const c of match[3].match(/[._-]/g) || []) if (c !== match[2]) words[c] = (words[c] || 0) + 1;
  }
  const most = (counts, fallback) => Object.entries(counts).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0]?.[0] ?? fallback;
  const separator = most(separators, ':');
  return { prefixes, separator, word: most(words, separator === '-' ? '_' : '-') };
}
/** The prefix for a kind: the one this project uses most, else the level above's, else the usual one. */
export function prefixFor(kind, style) {
  const candidates = PREFIXES[kind] || [kind];
  let best = null;
  for (const candidate of candidates) if ((style.prefixes[candidate] || 0) > (best ? style.prefixes[best] : 0)) best = candidate;
  if (best) return best;
  if (FALLBACK[kind]) return prefixFor(FALLBACK[kind], style);
  return candidates[0];
}
export function uniqueKey(base, existing, separator = '-') {
  if (!existing.has(base)) return base;
  for (let n = 2; ; n++) if (!existing.has(base + separator + n)) return base + separator + n;
}

function environmentStack(source) {
  const stack = [];
  for (const match of source.matchAll(/\\(begin|end)\s*\{([^{}\\]+)\}/g)) {
    if (match[1] === 'begin') stack.push({ name: match[2], at: match.index, end: match.index + match[0].length });
    else { const at = stack.map(e => e.name).lastIndexOf(match[2]); if (at >= 0) stack.length = at; }
  }
  return stack;
}
function lastHeading(source) {
  let found = null;
  for (const match of source.matchAll(/\\(part|chapter|section|subsection|subsubsection|paragraph)\*?\s*(?:\[[^\]]*\]\s*)?\{/g)) {
    const title = group(source, match.index + match[0].length - 1);
    if (title) found = { kind: match[1], title: title.text, end: title.end };
  }
  return found;
}
function captionIn(source, last = true) {
  let found = null;
  for (const match of source.matchAll(/\\caption(?:of\s*\{[^{}]*\})?\*?\s*(?:\[[^\]]*\]\s*)?\{/g)) {
    const caption = group(source, match.index + match[0].length - 1);
    if (caption) { found = caption.text; if (!last) break; }
  }
  return found;
}

/**
 * What a `\label` at the end of `before` names. `after` is the text that follows (a caption may come
 * after the label). Returns {kind, title, from} — `from` says where the title came from — or null.
 */
export function labelTarget(before, after = '') {
  const source = blank(before), stack = environmentStack(source);
  const environment = [...stack].reverse().find(e => TARGETS[e.name]);
  const heading = lastHeading(source);
  if (environment) {
    const kind = TARGETS[environment.name], inside = source.slice(environment.end);
    if (kind === 'figure' || kind === 'table' || kind === 'listing' || kind === 'algorithm') {
      const rest = blank(after), end = rest.indexOf(`\\end{${environment.name}}`);
      const title = captionIn(inside) ?? captionIn(end < 0 ? rest.slice(0, 4000) : rest.slice(0, end), false);
      return { kind, title: title ?? '', from: title ? 'caption' : '' };
    }
    const named = /^\s*\[([^\]]*)\]/.exec(inside);
    if (named && named[1].trim()) return { kind, title: named[1], from: 'name' };
    return { kind, title: heading?.title ?? '', from: heading ? 'section' : '' };
  }
  // A heading counts when only spaces and line breaks stand between its title and the label.
  if (heading && !source.slice(heading.end).trim()) return { kind: heading.kind, title: heading.title, from: 'title' };
  return null;
}

const DESCRIBED = { caption: 'caption', title: 'title', name: 'name', section: 'section title' };
/**
 * A unique key for a target: `{kind:'section', title:'Introduction'}` → `sec:introduction`.
 * `keys` are the labels already in the project.
 */
export function suggestLabel(target, keys) {
  const style = labelStyle(keys), existing = new Set(keys), prefix = prefixFor(target.kind, style);
  const slug = slugify(target.title || '', style.word), stem = prefix + style.separator;
  const key = slug ? uniqueKey(stem + slug, existing, style.word) : numbered(stem, existing), what = target.kind;
  const description = slug ? `Label for this ${what}, from its ${DESCRIBED[target.from] || 'title'} “${target.title.trim().replace(/\s+/g, ' ').slice(0, 60)}”` : `Next free label for this ${what}`;
  return { key, description };
}
function numbered(stem, existing) { for (let n = 1; ; n++) if (!existing.has(stem + n)) return stem + n; }
