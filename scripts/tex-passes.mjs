// LuaLaTeX passes for one compile, as latexmk decides them: run TeX, then Biber/BibTeX and
// makeindex when their inputs changed, and run TeX again only while a file TeX reads (or looked
// for and did not find) changed in the last round: .aux, .toc, .bbl, .out, chapter .aux files…
// When no such file changed, another pass would read exactly what this one read and produce the
// same pages, so the last pass's PDF is the document's fixpoint. Warnings such as "Rerun to get
// cross-references right" are not needed for that decision and are not trusted on their own.
// This function is embedded verbatim in the pinned classic-script BusyTeX pipeline
// (scripts/patch-busytex.mjs), so it may use nothing outside its arguments.
//   ctx.FS           the engine's file system; ctx.projectDir its project root
//   ctx.inputs       absolute paths of the project's own files (never treated as generated,
//                    except auxiliary ones such as a shipped .bbl)
//   ctx.run(cmd, errors) -> {exit_code, log, stdout}; ctx.tex the LuaLaTeX command
//   ctx.fatal, ctx.all       error messages for every pass / for the final result
//   ctx.bibliography: null | {kind:'biber', bcf, bbl, run:async()=>exit_code} | {kind:'bibtex', aux, bbl, cmd}
//   ctx.index: null | {idx, ind, cmd}
//   ctx.consulted() -> {paths:Set of absolute paths TeX opened, truncated, missing:[names it could not find]}
//   ctx.maxPasses, ctx.print
async function scribyraTexPasses(ctx) {
  const {FS, run, print} = ctx;
  const OUTPUT = /\.(log|pdf|xdv|dvi|synctex|synctex\.gz|blg|ilg|fls|fdb_latexmk)$/i;
  const AUX = /\.(aux|toc|lof|lot|loa|lol|out|bbl|bcf|run\.xml|nav|snm|vrb|idx|ind|ilg|glo|gls|glg|ist|thm|brf|cpt|mtc\d*|maf|ptc|stc\d*|xref|loe|lox)$/i;
  // Written for other programs (Biber, makeindex, latexmk's request list), never a reason to
  // run TeX again by themselves: their tools run when they change, and those tools' output counts.
  const TOOL = /\.(bcf|run\.xml|idx|glo|ist)$/i;
  const exists = path => FS.analyzePath(path).exists;
  const text = path => { try { return FS.readFile(path, { encoding: 'utf8' }); } catch { return null; } };
  // Generated files under the project: everything TeX or a helper may have written.
  function snapshot() {
    const files = new Map();
    (function walk(dir) {
      for (const name of FS.readdir(dir)) {
        if (name === '.' || name === '..') continue;
        const path = dir + '/' + name, stat = FS.stat(path);
        if (FS.isDir(stat.mode)) { walk(path); continue; }
        if (OUTPUT.test(name) || (ctx.inputs.has(path) && !AUX.test(name))) continue;
        files.set(path, stat.size > 16 * 1048576 ? `size:${stat.size}` : text(path));
      }
    })(ctx.projectDir);
    return files;
  }
  const base = path => path.slice(path.lastIndexOf('/') + 1);
  // Which changed files matter for the next TeX pass.
  // A file that did not exist counts when TeX looked for it: the engine's missing-file report, or
  // LaTeX's "No file main.toc." in the log. Bibliography and index output always counts.
  function relevant(before, after, log, produced) {
    const {paths, truncated, missing} = ctx.consulted(), looked = new Set(missing.map(base));
    for (const match of log.matchAll(/No file ([^\s]+?)\.?$/gm)) looked.add(base(match[1]));
    for (const path of produced) looked.add(base(path)), paths.add(path);
    const changed = [];
    for (const [path, content] of after) {
      if (before.get(path) === content || TOOL.test(path)) continue;
      if (truncated || paths.has(path) || (!before.has(path) && looked.has(base(path)))) changed.push(path);
    }
    for (const path of before.keys()) if (!after.has(path) && !TOOL.test(path) && (truncated || paths.has(path))) changed.push(path);
    return changed;
  }
  let exit_code = 0, last_log = '', last_stdout = '', passes = 0, bibliographyInput = null, indexInput = null;
  for (;;) {
    const before = snapshot(), produced = [];
    ({ exit_code, log: last_log, stdout: last_stdout } = run(ctx.tex, ctx.fatal));
    passes++;
    if (exit_code != 0) break;
    const bib = ctx.bibliography;
    if (bib?.kind === 'biber' && exists(bib.bcf)) {
      const input = text(bib.bcf);
      if (input !== bibliographyInput) { bibliographyInput = input; exit_code = await bib.run(); produced.push(bib.bbl); if (exit_code != 0) break; }
    } else if (bib?.kind === 'bibtex') {
      // BibTeX reads the citation, data and style lines of the .aux (and of included .aux files).
      const aux = text(bib.aux) || '', input = (aux.match(/^\\(?:citation|bibdata|bibstyle|@input)\{.*$/gm) || []).join('\n');
      if (input.includes('\\bibdata{') && input !== bibliographyInput) { bibliographyInput = input; ({ exit_code } = run(bib.cmd, ctx.fatal)); produced.push(bib.bbl); if (exit_code != 0) break; }
    }
    if (ctx.index && exists(ctx.index.idx)) {
      const input = text(ctx.index.idx);
      if (input && input.trim() && input !== indexInput) { indexInput = input; ({ exit_code } = run(ctx.index.cmd, ctx.fatal)); produced.push(ctx.index.ind); if (exit_code != 0) break; }
    }
    const changed = relevant(before, snapshot(), last_log || '', produced);
    if (!changed.length) { print(`$ # no file LuaLaTeX reads changed: pass ${passes} is final`); break; }
    if (passes >= ctx.maxPasses) { print(`$ # still changing after ${passes} passes (${changed.map(base).slice(0, 4).join(', ')}); keeping the last pass`); break; }
    print(`$ # rerun: ${changed.map(base).slice(0, 4).join(', ')}${changed.length > 4 ? ', …' : ''} changed`);
  }
  // The checks the final pass alone applies: a successful run must have produced pages.
  if (exit_code == 0 && ctx.all.some(err => (last_stdout + '\n' + last_log).includes(err))) exit_code = 1;
  return { exit_code, last_log, passes };
}

export { scribyraTexPasses };
