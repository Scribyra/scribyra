import test from 'node:test';
import assert from 'node:assert/strict';
import {compileOutput,liveCompileLog,lineKind,LIVE_LOG_LIMIT} from '../web/compile-log.js';

const worker=[
 'New compilation started: [main.tex]','TeX packages: []','Data packages used: x',
 '$ busytex luahblatex -synctex=1 --interaction=nonstopmode main.tex -kpathsea-debug 32','/bin/busytex stdout: This is LuaHBTeX, Version 1.24.0','/bin/busytex stdout: ','/bin/busytex stdout: ',
 '/bin/busytex stdout: ! Undefined control sequence.','/bin/busytex stdout: LaTeX Warning: Label(s) may have changed.',
 '/bin/busytex stderr: program exited (with status: 0), but keepRuntimeAlive() is set (counter=0) due to an async operation','$ echo $?','0\n',
 '$ biber --output-format=bbl main.bcf','INFO - This is Biber 2.20','$ echo $?','2\n',
 '$ busytex luahblatex main.tex','$ busytex luahblatex main.tex','$ # bibtex found no citation commands, skipping extra passes',
];
test('worker output becomes readable steps and lines without wrapper noise',()=>{
 const entries=[],labels=[],output=compileOutput(entry=>entries.push(entry));
 output.attempt(0);for(const line of worker){const label=output.print(line);if(label)labels.push(label);}
 assert.deepEqual(labels,['LuaLaTeX pass 1','Biber bibliography','LuaLaTeX pass 2 · rerun for the bibliography','LuaLaTeX pass 3 · rerun for cross-references']);
 assert.deepEqual(entries.map(e=>`${e.kind}:${e.text}`),[
  'step:LuaLaTeX pass 1','out:This is LuaHBTeX, Version 1.24.0','out:','error:! Undefined control sequence.','warning:LaTeX Warning: Label(s) may have changed.',
  'step:Biber bibliography','out:INFO - This is Biber 2.20','error:Exit code 2',
  'step:LuaLaTeX pass 2 · rerun for the bibliography','step:LuaLaTeX pass 3 · rerun for cross-references','note:bibtex found no citation commands, skipping extra passes']);
 output.attempt(1);assert.equal(output.print('$ busytex luahblatex main.tex'),'LuaLaTeX pass 4 · with downloaded packages');assert.equal(output.attemptNumber,1);
});
test('line kinds highlight TeX errors and warnings only',()=>{
 assert.equal(lineKind('! LaTeX Error: File `x.sty\' not found.'),'error');assert.equal(lineKind('Package hyperref Warning: Token not allowed'),'warning');
 assert.equal(lineKind('Overfull \\hbox (1.0pt too wide) in paragraph'),'warning');assert.equal(lineKind('(./main.aux)'),'out');
});
test('the live log batches renders and keeps at most the final-log bound',()=>{
 const timers=[];const log=liveCompileLog({limit:20,target:()=>null,schedule:fn=>{timers.push(fn);return timers.length;},unschedule:()=>{}});
 log.push({text:'ignored before start'});assert.equal(log.lines,0);
 log.start();for(let i=0;i<10;i++)log.push({text:`line ${i}`});
 assert.equal(timers.length,1,'one batch per interval, not one render per line');
 assert.ok(log.size<=20);assert.equal(log.text(),'line 8\nline 9');
 log.push({text:'x'.repeat(50)});assert.equal(log.lines,1);assert.equal(log.text(),'x'.repeat(19));
 log.stop();log.push({text:'after stop'});assert.ok(!log.text().includes('after stop'));
 assert.equal(LIVE_LOG_LIMIT,2*1024*1024);
});
test('a pass that stops only for packages being fetched loses error styling and says LuaLaTeX will run again',()=>{
 const log=liveCompileLog({target:()=>null,schedule:()=>1,unschedule:()=>{}}),output=compileOutput(entry=>log.push(entry));log.start();
 output.attempt(0);output.print('$ busytex luahblatex main.tex');output.print('/bin/busytex stdout: ! ==> Fatal error occurred, no output PDF file produced!');output.print('$ echo $?');output.print('1\n');
 output.recovering();output.attempt(1);output.print('$ busytex luahblatex main.tex');output.print('/bin/busytex stdout: ! Undefined control sequence.');
 assert.match(log.text(),/! ==> Fatal error occurred[\s\S]*Exit code 1\n▸ Missing packages are being fetched; LuaLaTeX will run again\n▸ LuaLaTeX pass 2 · with downloaded packages\n! Undefined control sequence\./);
 const kinds=[];const probe=compileOutput(entry=>kinds.push(entry));probe.recovering();assert.deepEqual(kinds.map(k=>k.kind),['recovered','step']);
});
