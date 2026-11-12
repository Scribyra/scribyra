import './helpers/core.mjs';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {compilation_diagnostics,TexCatalog} from '../web/pkg/scribyra_app.js';
import {buildFailure,CompileTimeoutError,boundedText} from '../web/build-errors.js';
const diagnose=input=>JSON.parse(compilation_diagnostics(JSON.stringify(input)));
test('the shared WASM report distinguishes timeout, unavailable package, environment and source errors',()=>{
 const timeout=buildFailure(new CompileTimeoutError(180000,'Downloading compiler baseline'));assert.equal(timeout.issues[0].code,'compile-timeout');assert.match(timeout.issues[0].detail,/Downloading compiler baseline/);assert.equal(timeout.allowPackageResolution,false);
 assert.equal(buildFailure({name:'TexPackageError',package:'babel-french',message:'Checksum mismatch'}).issues[0].code,'package-transfer');
 assert.equal(buildFailure({name:'TexEnvironmentError',message:'A different compiler is pinned'}).issues[0].code,'environment-mismatch');
 const source=diagnose({log:'! Missing $ inserted.\nl.9 bad_math'});assert.equal(source.issues[0].code,'source-error');assert.equal(source.issues[0].line,9);assert.equal(source.allowPackageResolution,false);
 const text='a'.repeat(5)+'😀';assert.equal(boundedText(text,6),'aaaaa');assert.doesNotThrow(()=>buildFailure(new Error('😀'.repeat(4000))));
});
test('wrapped font failures resolve known aliases; project assets and source errors do not trigger optional package probes',()=>{
 const log='! Package fontspec Error:\n(fontspec) The font "TeX Gyre Pagella" cannot be\n(fontspec) found;';assert.match(diagnose({log}).issues[0].summary,/TeX Gyre Pagella/);assert.deepEqual(JSON.parse(TexCatalog.lookup_plan('[]',log)).fonts,['texgyrepagella']);
 for(const log of ['! LaTeX Error: File `refs.bib\' not found.','! Missing $ inserted.','! Package minted Error: You must invoke LaTeX with -shell-escape'])assert.deepEqual(JSON.parse(TexCatalog.lookup_plan('[{"name":"optional.sty","format":26}]',log)),{files:[],fonts:[]});
 assert.ok(JSON.parse(TexCatalog.lookup_plan('[]',"I couldn't open style file custom.bst")).files.some(f=>f.name==='custom.bst'));
});
test('project packages are reported only from compiler reads and incomplete glyph coverage is visible',()=>{
 const r=diagnose({success:true,projectFiles:['paper/main.tex','paper/local.sty','unused.cls'],recorder:'INPUT /home/web_user/project_dir/paper/local.sty\nINPUT /texlive/tex/unused.cls',log:'Missing character: There is no 字 in font Latin Modern'});
 assert.deepEqual(r.issues.map(i=>i.code),['project-package','missing-glyphs']);assert.equal(r.issues[0].file,'paper/local.sty');assert.equal(r.issues[1].severity,'warning');
});
test('package transfer failures retain bounded TeX evidence and the importing source location',()=>{
 const report=buildFailure({name:'TexPackageError',package:'missing',message:'Checksum mismatch',texLog:"(./main.tex\n! LaTeX Error: File `missing.sty' not found.\nl.4 \\usepackage{missing}"},{mainFile:'paper/main.tex',projectFiles:['paper/main.tex']});
 assert.equal(report.issues[0].code,'package-transfer');assert.equal(report.issues[0].file,'paper/main.tex');assert.equal(report.issues[0].line,4);
 assert.doesNotThrow(()=>buildFailure({name:'TexPackageError',package:'missing',message:'Interrupted',texLog:'😀'.repeat(2*1024*1024)}));
});
