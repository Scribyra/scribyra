// The real WebAssembly engine under Node (server/compile/runner.mjs through the shared driver),
// offline, with packages only from the bundled components: pass counts, packages installed
// before the first pass and the remembered package set.
// Each compile runs in its own process (scripts/compile-benchmark-node.mjs --one).
import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,cpSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {getDocument} from 'pdfjs-dist/legacy/build/pdf.mjs';

const ROOT=new URL('..',import.meta.url).pathname;
let work,runtime;
before(()=>{
 work=mkdtempSync(join(tmpdir(),'scribyra-wasm-engine-'));runtime=join(work,'runtime');
 execFileSync(process.execPath,[join(ROOT,'scripts/wasm-compile-runtime.mjs'),runtime,'--link'],{cwd:ROOT,stdio:'ignore'});
});
after(()=>rmSync(work,{recursive:true,force:true}));

function project(name,files){const dir=join(work,'projects',name);mkdirSync(dir,{recursive:true});for(const[path,content]of Object.entries(files)){mkdirSync(join(dir,path,'..'),{recursive:true});writeFileSync(join(dir,path),content);}return dir;}
function compile(dir,{packages}={}){
 const cache=mkdtempSync(join(work,'cache-')),pdf=join(dir,'out.pdf');
 const line=execFileSync(process.execPath,[join(ROOT,'scripts/compile-benchmark-node.mjs'),'--one',JSON.stringify({work:dir,cache,mirror:join(work,'mirror'),pdf,packages})],
  {cwd:ROOT,encoding:'utf8',maxBuffer:64<<20,env:{...process.env,SCRIBYRA_WASM_RUNTIME:runtime,SCRIBYRA_TEX_MIRROR:'http://127.0.0.1:9'}}).trim().split('\n').pop();
 rmSync(cache,{recursive:true,force:true});
 return{...JSON.parse(line),log:readFileSync(join(dir,'out.log'),'utf8'),pdf};
}
async function pages(path){
 const task=getDocument({data:new Uint8Array(readFileSync(path)),verbosity:0}),pdf=await task.promise,out=[];
 for(let i=1;i<=pdf.numPages;i++)out.push((await (await pdf.getPage(i)).getTextContent()).items.map(item=>item.str).join(' '));
 await task.destroy();return out;
}

test('a document without references compiles in two LuaLaTeX passes (BusyTeX ran four)',()=>{
 const result=compile(project('plain',{'main.tex':'\\documentclass{article}\\begin{document}\\section{One}Text.\\end{document}\n'}));
 assert.equal(result.status,'Success',result.log.slice(0,3000));assert.equal(result.passes,2);
});

test('a table of contents is filled on the final pass, with no rerun warning to prompt it',async()=>{
 const result=compile(project('toc',{'main.tex':'\\documentclass{article}\\begin{document}\\tableofcontents\\section{Alpha}A.\\section{Beta}B.\\end{document}\n'}));
 assert.equal(result.status,'Success',result.log.slice(0,3000));assert.equal(result.passes,2);
 assert.match((await pages(result.pdf))[0],/Contents\s+1\s+Alpha\s+1\s+2\s+Beta\s+1/);
});

test('Biber: packages the source names are installed before the first pass, then TeX, Biber, TeX, TeX',async()=>{
 const dir=join(work,'projects','biber');cpSync(join(ROOT,'fixtures/biber'),dir,{recursive:true});
 const result=compile(dir);
 assert.equal(result.status,'Success',result.log.slice(0,3000));
 assert.equal(result.passes,3);assert.ok(result.packages.includes('dist--biblatex'),result.packages);
 assert.match(result.log,/Looking up \d+ TeX files? the project names/);
 assert.doesNotMatch(result.log,/Missing packages are being fetched/);
 assert.match((await pages(result.pdf)).join(' '),/Knuth/);
});

test('a package the source names only through a macro is found by a failing pass once, then remembered',()=>{
 const dir=project('macro',{'main.tex':'\\documentclass{article}\\def\\tablepackage{booktabs}\\usepackage{\\tablepackage}\\begin{document}\\begin{tabular}{ll}\\toprule a&b\\\\\\bottomrule\\end{tabular}\\end{document}\n'});
 const first=compile(dir);
 assert.equal(first.status,'Success',first.log.slice(0,3000));assert.equal(first.passes,3);assert.deepEqual(first.packages,['dist--booktabs']);
 assert.match(first.log,/Missing packages are being fetched/);
 const again=compile(dir,{packages:first.packages});
 assert.equal(again.status,'Success');assert.equal(again.passes,2);
 assert.match(again.log,/Installing the 1 TeX package this project used last time/);assert.doesNotMatch(again.log,/Missing packages are being fetched/);
});

