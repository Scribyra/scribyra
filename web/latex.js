// Ignore TeX comments, respecting escaped percent signs (and escaped backslashes).
export function withoutComments(text) {
  return text.replace(/(\\[\s\S])|%[^\r\n]*/g, (match, escaped) => escaped || '');
}

// Follow local document/package imports so unused templates in a ZIP cannot
// select the bibliography backend. Macro-generated imports remain TeX's job.
export function documentSources(files, mainFile) {
  const sources = new Map(files.filter(f => /\.(tex|cls|sty)$/i.test(f.path)).map(f => [f.path.toLowerCase(), f]));
  const seen = new Set(), result = [];
  const visit = path => {
    const file = sources.get(path.toLowerCase());
    if (!file || seen.has(file.path)) return;
    seen.add(file.path);
    const text = withoutComments(typeof file.content === 'string' ? file.content : new TextDecoder().decode(file.content));
    result.push(text);
    const dir = file.path.slice(0, file.path.lastIndexOf('/') + 1);
    const mainDir = mainFile.slice(0, mainFile.lastIndexOf('/') + 1);
    const imports = /\\(documentclass|LoadClass|LoadClassWithOptions|usepackage|RequirePackage|RequirePackageWithOptions|input|include|subfile)\*?\s*(?:\[[^\]]*\]\s*)?\{([^}]+)\}/g;
    for (const [, command, names] of text.matchAll(imports)) {
      const suffix = /class|Class/.test(command) ? '.cls' : /package|Package/.test(command) ? '.sty' : '.tex';
      for (let name of names.split(',')) {
        name = name.trim().replace(/^\.\//, '');
        if (!name.endsWith(suffix)) name += suffix;
        const resolved = [mainDir + name, dir + name, name].find(p => sources.has(p.toLowerCase()));
        if (resolved) visit(resolved);
      }
    }
  };
  visit(mainFile);
  return result;
}

export function bibliographyOptions(files, mainFile) {
  const source = documentSources(files, mainFile).join('\n');
  const loads = [...source.matchAll(/\\(?:usepackage|RequirePackage)\s*(?:\[([^\]]*)\]\s*)?\{([^}]+)\}/g)]
    .filter(([, , names]) => names.split(',').some(n => n.trim() === 'biblatex'));
  if (loads.length) {
    const passed = [...source.matchAll(/\\PassOptionsToPackage\s*\{([^}]+)\}\s*\{biblatex\}/g)].map(m => m[1]);
    const options = [...passed, ...loads.map(m => m[1] || '')].join(',');
    const backends = [...options.matchAll(/\bbackend\s*=\s*(biber|bibtex8?)\b/g)];
    // BibLaTeX defaults to Biber, even when loaded by a custom class.
    return { bibtex: true, biber: !backends.length || backends.at(-1)[1] === 'biber' };
  }
  return { bibtex: /\\bibliography\s*\{/.test(source) ? true : null, biber: null };
}
