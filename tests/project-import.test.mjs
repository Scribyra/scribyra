// Importing a ZIP (docs/templates.md#importing-from-overleaf): recognising a project
// downloaded from Overleaf, its main file and compiler, and the LuaLaTeX advice.
import './helpers/core.mjs';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {zipSync,strToU8} from 'fflate';
import {analyzeImport,needsSummary,magicCompiler,latexmkSettings,compilerSentence} from '../web/project-import.js';
import {importZip} from '../web/model.js';

const png=new Uint8Array([0x89,0x50,0x4e,0x47]);
const doc=(preamble='',body='Text.')=>`\\documentclass{article}\n${preamble}\n\\begin{document}\n${body}\n\\end{document}\n`;
const entries=files=>Object.entries(files).map(([path,content])=>({path,content}));
const codes=report=>report.warnings.map(entry=>`${entry.severity}:${entry.code}`);

test('a typical Overleaf source download: flat, figures in a folder, a .bib; pdfLaTeX by default',()=>{
 const report=analyzeImport(entries({'main.tex':doc('\\usepackage[utf8]{inputenc}\n\\usepackage[T1]{fontenc}\n\\usepackage{graphicx}','\\includegraphics{figures/plot}\\cite{a}\\bibliographystyle{plain}\\bibliography{refs}'),'refs.bib':'@book{a,title={A}}','figures/plot.png':png,'sections/intro.tex':'\\section{Intro}'}));
 assert.equal(report.overleaf,true);assert.match(report.signals[0],/usual layout/);
 assert.equal(report.main,'main.tex');assert.equal(report.compiler,'pdflatex');assert.match(report.compilerReason,/Overleaf’s default/);
 assert.deepEqual(codes(report),['info:inputenc','info:fontenc']);
 assert.equal(report.warnings[0].line,2);assert.match(report.warnings[0].message,/LuaLaTeX ignores it/);
 assert.deepEqual(report.counts,{files:4,tex:2,bib:1,images:1});
 assert.deepEqual(report.bibliography,{files:['refs.bib'],tool:'bibtex',missing:[]});
 assert.equal(needsSummary(report),true);
 assert.match(compilerSentence(report),/^Written for pdfLaTeX \(from no other setting, so Overleaf’s default\)\. Scribyra compiles with LuaLaTeX; most projects compile unchanged\.$/);
});

test('latexmkrc: Overleaf\u2019s build settings choose the compiler and the main file',()=>{
 const report=analyzeImport(entries({'latexmkrc':'# Overleaf settings\n$pdf_mode = 5;\n@default_files = (\'thesis.tex\');\n','main.tex':doc(),'thesis.tex':doc('\\usepackage{fontspec}')}));
 assert.equal(report.overleaf,true);assert.match(report.signals[0],/latexmkrc/);
 assert.equal(report.main,'thesis.tex','@default_files wins over main.tex');
 assert.equal(report.compiler,'xelatex');assert.equal(report.compilerReason,'latexmkrc (fontspec works the same with LuaLaTeX)');
 assert.deepEqual(latexmkSettings('$pdf_mode = 4;'),{compiler:'lualatex',main:null,custom:false});
 assert.deepEqual(latexmkSettings('$pdflatex = "xelatex %O %S"; # $pdf_mode = 4'),{compiler:'xelatex',main:null,custom:false});
 assert.deepEqual(latexmkSettings('add_cus_dep("glo","gls",0,"makeglo2gls");').custom,true);
 // As the ZIP reader returns it: no extension, so bytes.
 const hidden=analyzeImport(entries({'.latexmkrc':new TextEncoder().encode('$pdf_mode = 1;'),'paper.tex':doc()}));
 assert.equal(hidden.overleaf,true);assert.equal(hidden.compiler,'pdflatex');assert.equal(hidden.main,'paper.tex');
});

test('a % !TEX program line is the clearest hint',()=>{
 assert.equal(magicCompiler('% !TEX program = xelatex\n\\documentclass{article}'),'xelatex');
 assert.equal(magicCompiler('%!TeX TS-program = LuaLaTeX'),'lualatex');
 assert.equal(magicCompiler('% !TEX program = latex'),'pdflatex');
 assert.equal(magicCompiler('\\documentclass{article}'),null);
 const report=analyzeImport(entries({'main.tex':'% !TEX program = lualatex\n'+doc('\\usepackage[utf8]{inputenc}')}));
 assert.equal(report.compiler,'lualatex');assert.match(compilerSentence(report),/which is what Scribyra uses/);
 assert.equal(needsSummary(report),false,'nothing to fix and not from Overleaf');
});

test('a plain pdfLaTeX-era ZIP with only notes imports without interrupting',()=>{
 const report=analyzeImport(entries({'main.tex':doc('\\usepackage[T1]{fontenc}\n\\usepackage[romanian]{babel}')}));
 assert.equal(report.overleaf,false);assert(report.warnings.length>0);assert(report.warnings.every(entry=>entry.severity==='info'));
 assert.equal(needsSummary(report),false,'notes are not worth a dialog when nothing needs changing');
});

test('fontspec alone means a Unicode engine, and LuaLaTeX is one',()=>{
 const report=analyzeImport(entries({'main.tex':doc('\\usepackage{fontspec}\n\\setmainfont{TeX Gyre Pagella}')}));
 assert.equal(report.compiler,'lualatex');assert.deepEqual(report.warnings,[]);assert.equal(needsSummary(report),false);
});

test('XeLaTeX-only packages and commands are errors with a LuaLaTeX replacement',()=>{
 const report=analyzeImport(entries({'main.tex':doc('\\usepackage{fontspec}\n\\usepackage{xeCJK}\n\\usepackage{xltxtra}\n\\XeTeXlinebreaklocale "zh"')}));
 assert.equal(report.compiler,'xelatex');assert.equal(report.compilerReason,'XeTeX-only packages or commands');
 assert.deepEqual(codes(report),['error:xetex-xecjk','error:xetex-xltxtra','error:xetex-primitive']);
 assert.match(report.warnings[0].fix,/luatexja-fontspec/);
 assert.match(compilerSentence(report),/the changes below make it compile/);
});

test('pdfLaTeX-only settings: other input encodings, utf8x and pdfTeX primitives',()=>{
 const report=analyzeImport(entries({'main.tex':'\\pdfoutput=1\n\\ifdefined\\pdfminorversion\\pdfminorversion=7\\fi\n'+doc('\\usepackage[latin1]{inputenc}\n\\pdfcompresslevel=9'),'other.tex':doc('\\usepackage[utf8x]{inputenc}')}));
 assert.deepEqual(codes(report).sort(),['error:inputenc-encoding','error:pdf-primitive-pdfcompresslevel','error:pdf-primitive-pdfoutput','warning:inputenc-utf8x']);
 const output=report.warnings.find(entry=>entry.code==='pdf-primitive-pdfoutput');
 assert.deepEqual([output.file,output.line],['main.tex',1]);assert.match(output.fix,/always writes PDF/);
 assert.match(report.warnings.find(entry=>entry.code==='inputenc-encoding').fix,/UTF-8/);
});

test('things a browser cannot run: shell escape, EPS conversion, glossaries; missing .bib files',()=>{
 const report=analyzeImport(entries({'main.tex':doc('\\usepackage{minted}\n\\usepackage{svg}\n\\usepackage{glossaries}\n\\makeglossaries\n\\usepackage[backend=biber]{biblatex}\n\\addbibresource{library.bib}','\\immediate\\write18{date}'),'fig/a.eps':'%!PS','fig/b.eps':'%!PS'}));
 assert.deepEqual(codes(report),['error:minted','warning:shell-svg','warning:glossaries','warning:write18','warning:eps','warning:bib-missing']);
 assert.match(report.warnings.find(entry=>entry.code==='eps').message,/^2 EPS images need converting/);
 assert.match(report.warnings.find(entry=>entry.code==='bib-missing').message,/library\.bib/);
 assert.equal(report.bibliography.tool,'biber');
 const automake=analyzeImport(entries({'main.tex':doc('\\usepackage[automake=immediate]{glossaries}')}));
 assert.deepEqual(codes(automake),[]);
});

test('comments are ignored, and an escaped percent is not a comment',()=>{
 const report=analyzeImport(entries({'main.tex':doc('% \\usepackage{minted}\n%\\pdfoutput=1\n\\newcommand{\\pct}{50\\%} \\usepackage{xeCJK} % trailing')}));
 assert.deepEqual(codes(report),['error:xetex-xecjk']);
});

test('the main file: a root document, then the shallowest, then main.tex; folders and bibliography paths resolve',()=>{
 let report=analyzeImport(entries({'main.tex':'\\section{Only a chapter}','paper.tex':doc(),'sub/main.tex':doc()}));
 assert.equal(report.main,'paper.tex');assert.deepEqual(report.roots.sort(),['paper.tex','sub/main.tex']);assert.equal(needsSummary(report),true,'two candidates are worth showing');
 report=analyzeImport(entries({'project/main.tex':doc('','\\bibliography{refs}'),'project/refs.bib':''}));
 assert.equal(report.main,'project/main.tex');assert.deepEqual(report.bibliography.missing,[]);
 report=analyzeImport(entries({'notes.txt':'hello'}));
 assert.equal(report.main,null);assert.equal(report.compiler,null);assert.equal(report.overleaf,false);
});

test('a plain ZIP without hints gets no summary, as before',()=>{
 const report=analyzeImport(entries({'main.tex':doc()}));
 assert.equal(report.overleaf,false);assert.deepEqual(report.warnings,[]);assert.equal(needsSummary(report),false);
});

test('a ZIP with a file that is not UTF-8 names the file and says how to fix it',()=>{
 const bytes=zipSync({'main.tex':strToU8(doc()),'chapter.tex':new Uint8Array([0x43,0x61,0x66,0xe9])});
 assert.throws(()=>importZip(bytes),/^Error: chapter\.tex is not saved as UTF-8 text\..*save the file as UTF-8/);
});
