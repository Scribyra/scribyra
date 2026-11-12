import { test } from 'node:test';
import assert from 'node:assert/strict';
import './helpers/core.mjs';
import {compilation_diagnostics} from '../web/pkg/scribyra_app.js';
const compilationDiagnostic=log=>JSON.parse(compilation_diagnostics(JSON.stringify({log}))).issues[0].summary;
import { bibliographyOptions, documentSources, withoutComments } from '../web/latex.js';
const file = (path, content) => ({ path, content });

test('BibLaTeX defaults to Biber when loaded inside a local class', () => {
  const files = [file('main.tex', String.raw`\documentclass{thesis}`),
    file('Thesis.cls', String.raw`\LoadClass{article}\RequirePackage[style=numeric]{biblatex}`)];
  assert.deepEqual(bibliographyOptions(files, 'main.tex'), { bibtex: true, biber: true });
});

test('explicit BibLaTeX backends and passed package options are respected', () => {
  for (const backend of ['bibtex', 'bibtex8', 'biber']) {
    for (const source of [String.raw`\usepackage[backend = ${backend}]{biblatex}`,
      String.raw`\PassOptionsToPackage{backend=${backend}}{biblatex}\RequirePackage{biblatex}`]) {
      assert.equal(bibliographyOptions([file('main.tex', source)], 'main.tex').biber, backend === 'biber');
    }
  }
});

test('included bibliographies work; unused templates and comments do not select Biber', () => {
  const files = [file('paper/main.tex', String.raw`\documentclass{article}\input{sections/refs}`),
    file('paper/sections/refs.tex', String.raw`\bibliography{references}\input{sections/refs}`),
    file('unused.tex', String.raw`\usepackage{biblatex}`)];
  assert.equal(documentSources(files, 'paper/main.tex').length, 2);
  assert.deepEqual(bibliographyOptions(files, 'paper/main.tex'), { bibtex: true, biber: null });
  assert.equal(bibliographyOptions([file('main.tex', '% \\usepackage{biblatex}\nText')], 'main.tex').biber, null);
  assert.equal(withoutComments('a\\%b% comment\nc\\\\% comment'), 'a\\%b\nc\\\\');
});

test('diagnostics identify the root TeX error before downstream bibliography errors', () => {
  assert.equal(compilationDiagnostic("! Package babel Error: Unknown option 'romanian'."), 'Missing Babel language support: romanian');
  assert.equal(compilationDiagnostic("! LaTeX Error: File `absent.sty' not found.\nERROR - main.bcf is malformed"), 'Missing TeX file: absent.sty');
  assert.equal(compilationDiagnostic('! Undefined control sequence.\nl.4 \\badcommand'), 'Undefined control sequence.');
  assert.equal(compilationDiagnostic('ERROR - Cannot find refs.bib'), 'Bibliography error: Cannot find refs.bib');
  assert.equal(compilationDiagnostic(''), 'Compilation failed');
});
