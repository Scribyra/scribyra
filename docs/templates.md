# Templates, importing from Overleaf, and the first-run welcome

Code: `templates/documents/` (the templates, as data), `web/template-catalog.js` (pure
rules: validation, ordering, search, links), `web/templates.js` (Vite bundling),
`web/template-gallery.js` (the **New project** dialog), `web/project-import.js` (ZIP
analysis, pure), `web/import-summary.js` (import summary, Overleaf guide, Git link),
`web/onboarding.js` and the welcome section in `crates/app/src/lib.rs`.
Generator: `scripts/templates.mjs`. Tests: `tests/templates.test.mjs`,
`tests/project-import.test.mjs`, `tests/browser/templates.spec.js`.

## Templates

All templates are written by the Scribyra project for this purpose and are part of the
repository under its licence; a project created from one belongs to whoever writes it
(use, change and publish it freely). They use only packages in the bundled LuaLaTeX
components, so they compile offline after the first compile.

| Id | Category | What it shows |
| --- | --- | --- |
| `sample` | Start here | The sample paper (`STARTER` in `web/model.js`; the test keeps them identical) |
| `minimal` | Start here | The smallest document worth starting from |
| `article` | Papers and reports | Abstract, sections, TikZ figure, booktabs table, cleveref, biblatex/Biber |
| `report` | Papers and reports | Title page, executive summary, contents, chapters, fancyhdr, appendix, biblatex |
| `book` | Books and theses | Trim size, front/main/back matter, parts, chapters in `chapters/`, `\includeonly` |
| `thesis` | Books and theses | Title page, declaration, abstract, acknowledgements, contents/figures/tables lists, chapters and appendices in files, biblatex/Biber |
| `beamer` | Slides and posters | 16:9 slides, outline, overlays, columns, blocks, references slide |
| `poster` | Slides and posters | A0 tikzposter, custom colour style, three columns, OpenType fonts |
| `cv` | Career | One-page CV with a small `\cventry` command |
| `cover-letter` | Career | Formal letter that pairs with the CV |
| `homework` | Teaching and coursework | Problems and solutions (a switch hides solutions), headers with page x of y |
| `lab-report` | Teaching and coursework | siunitx, a pgfplots plot read from `data.csv`, error analysis, biblatex |
| `lecture-notes` | Teaching and coursework | Numbered lectures, tcolorbox definitions/theorems/examples, margin notes |

### Adding a template

1. Create `templates/documents/<id>/` with the files and a `template.json`:
   ```json
   {
     "id": "my-template",
     "name": "My template",
     "category": "papers",
     "order": 30,
     "description": "One sentence: what it is and what it shows.",
     "keywords": ["words", "people", "search for"],
     "main": "main.tex",
     "preview": [1]
   }
   ```
   `id` matches the folder (lowercase letters, digits, dashes). `category` is one of
   `index.json`. `preview` lists the pages the preview image shows: one (its top half),
   two side by side, or four in a grid (slides). Allowed files: `.tex .bib .cls .sty
   .bst .cfg .csv .txt .md` and small `.png .jpg .pdf` images, up to four folders deep,
   no dot files. Unknown fields are refused.
2. Comment the source: say what to change, next to where it is changed.
3. `node scripts/templates.mjs previews --only my-template` compiles it with the real
   WebAssembly engine (offline: the mirror address is unreachable, so only bundled
   packages load) and writes `preview.png` (480 × 360, transparent around whole pages).
   It fails on any TeX error and prints final-pass warnings.
4. `node scripts/templates.mjs site` regenerates `site/templates/` (the page and its
   preview copies). `node scripts/templates.mjs check` (and the unit test) fails when it
   is out of date.
5. `npm test` compiles every template and requires success, at least one page, no errors
   and no warnings in the final pass.

The app bundles metadata and previews with the shell (they are precached for offline
use); each template's files are a separate chunk loaded when it is chosen.

### Journal and conference classes

Not shipped yet. Checked on CTAN (November 2026): IEEEtran 1.8b (LPPL 1.3), acmart 2.21
(LPPL 1.3), elsarticle 3.5 (LPPL 1.3) and llncs 2.26 (CC BY 4.0) are all
redistributable and all are in the TeX catalog (`ieeetran`, `acmart`, `elsarticle`,
`llncs`), so a document using them compiles **online**: the class downloads from the
TeX Live mirror on first compile. They are not in the bundled components, so a template
using them would not compile offline and would fail the template test. To add one later:

1. add the package to the bundled component selection (`scripts/tex-runtime-catalog.json`
   via the asset build; see [tex-packages](tex-packages.md)) so it compiles offline;
2. write our own example document in `templates/documents/<id>/` that uses the class (do
   not copy the publisher's sample text; the class itself is not copied either, it comes
   from the TeX distribution);
3. add a row to `THIRD_PARTY.md` naming the class, its version and licence.

Publisher templates that are not in TeX Live (for example Springer Nature's `sn-jnl`)
can be imported as a ZIP by the person who downloaded them.

### Template links

`https://app.scribyra.com/#template=<id>` opens the app with the gallery showing that
template selected, and a note that a link suggested it. Nothing is created until the
person chooses **Create project**; an unknown id opens the gallery with a notice; a
damaged one only shows a notice. Like `#open?` and `#tex=`, the fragment is removed from
the address bar before anything else and never reaches a server. The scribyra.com
templates page uses these links.

### Plugins

A plugin could later contribute templates: entries of the same `template.json` shape plus
their files, validated by `validateTemplate`, shown in the gallery with the plugin's name.
This is only a documented hook (see [plugins](plugins.md#templates-hook)); nothing is
built yet.

## Importing from Overleaf

Overleaf lets anyone download a project as a ZIP of its sources (Menu → Download →
Source; newer editor: File → Download as source). **Import ZIP** reads it as before
(`importZip`) and then `analyzeImport` (pure, tested) reports:

- **Recognised as Overleaf** when the ZIP has a `latexmkrc`/`.latexmkrc`, comments that
  mention Overleaf, or the usual layout (root main file, a `.bib`, images in a folder).
  This only changes wording and the compiler default; nothing is sent anywhere.
- **Main file**: `@default_files` in `latexmkrc`, else the open-link rule (root documents
  with `\documentclass` and `\begin{document}`, non-standalone, shallowest, `main.tex`).
  Several candidates are listed so the person can switch in Project settings.
- **Compiler**: a `% !TEX program` line, then `$pdf_mode`/`$pdflatex` in `latexmkrc`,
  then packages (XeTeX-only → XeLaTeX; LuaTeX packages or fontspec → LuaLaTeX), then
  Overleaf's default, pdfLaTeX.
- **Advice**, each with severity, file, line and a concrete fix: `inputenc` (utf8: info;
  other encodings: error; utf8x: warning), `fontenc` T1 (info), pdfTeX primitives
  (`\pdfoutput` …; error unless guarded by `\ifdefined`), XeLaTeX-only packages and
  `\XeTeX…` commands (error, with the LuaLaTeX replacement), CJK (warning), `minted`
  (error), shell-escape packages, `\write18`, glossaries without `automake`, EPS images
  (warning), bibliography files named but missing (warning), custom latexmk rules (info).
- **Counts**: files, `.tex`, images, bibliography files and the bibliography tool.

The summary dialog appears when the ZIP looks like Overleaf's or there is something to
fix; a plain ZIP imports exactly as before. File names in it open that line. **Compile
now** compiles. Non-UTF-8 text files are refused with the file name and the fix.

Wording: Overleaf is named only to say where a file came from and how to download it.
There are no Overleaf logos, screenshots or look-alike screens, and the site guide says
Scribyra is not affiliated with it.

The guide is in the app (welcome **Coming from Overleaf?**, the empty-dashboard hint, the
summary) and at `https://scribyra.com/coming-from-overleaf.html`.

## First-run welcome

On a first visit with no projects, the dashboard shows a welcome section in place of the
sample banner: **Browse templates**, **Import a ZIP** / **From a Git link** / **Coming
from Overleaf?**, and **Start with a sample paper**, plus tips (compile shortcut,
Reviewing mode, `agent.md` for AI agents). It is part of the page, not a dialog: it does
not take focus, does not cover anything, and the telemetry consent card (docked at the
bottom) stays where it is. **Dismiss welcome** hides it; creating or importing a project
also ends it. Either is remembered in `localStorage` (`scribyra:welcome:v1`); a browser
that already has projects never sees it. Without storage it is not shown. **From a Git
link** parses a pasted repository or ZIP address with the open-link generator's parser
and hands it to the existing Open in Scribyra confirmation.
