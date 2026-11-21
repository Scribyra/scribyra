// Pass-count regressions for the rerun policy embedded in the BusyTeX pipeline
// (scripts/tex-passes.mjs), against a simulated TeX run on a small in-memory file system, and
// for the source scan that finds a project's packages before the first pass.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {scribyraTexPasses} from '../scripts/tex-passes.mjs';
import {fileRequests,projectRequests,stripComments} from '../web/tex-requirements.js';
import {rememberedPackages,rememberPackages,forgetPackages} from '../web/project-packages.js';

const ROOT='/project';
function memoryFS(files){
 const data=new Map(Object.entries(files).map(([path,content])=>[`${ROOT}/${path}`,content]));
 const dirs=()=>{const set=new Set([ROOT]);for(const path of data.keys()){let d=path.slice(0,path.lastIndexOf('/'));while(d.length>=ROOT.length){set.add(d);d=d.slice(0,d.lastIndexOf('/'));}}return set;};
 const abs=path=>path.startsWith('/')?path:`${ROOT}/${path}`;
 return {data,
  analyzePath:path=>({exists:data.has(abs(path))||dirs().has(abs(path))}),
  readFile(path){const p=abs(path);if(!data.has(p))throw new Error('ENOENT');return data.get(p);},
  readdir(dir){const names=new Set(['.','..']);for(const path of [...data.keys(),...dirs()])if(path.startsWith(dir+'/')&&path!==dir)names.add(path.slice(dir.length+1).split('/')[0]);return [...names];},
  stat(path){const p=abs(path);return data.has(p)?{mode:1,size:data.get(p).length}:{mode:2,size:0};},
  isDir:mode=>mode===2,
 };
}
// A document as a function of what it reads: pass(read) returns the files it writes, the log
// and the files it opened; `read(name)` returns a generated file's content or undefined.
function simulate(fs,doc,{bibliography=null,maxPasses=5}={}){
 const consulted={paths:new Set(),missing:[]},runs=[];
 const run=cmd=>{
  runs.push(cmd[0]);
  if(cmd[0]==='biber'){fs.data.set(`${ROOT}/main.bbl`,doc.biber(fs.data.get(`${ROOT}/main.bcf`)));return{exit_code:0,log:'',stdout:''};}
  const read=name=>{const path=`${ROOT}/${name}`;if(fs.data.has(path)){consulted.paths.add(path);return fs.data.get(path);}consulted.missing.push(name);return undefined;};
  const {writes={},log='',exit=0,stdout=''}=doc.pass(read,runs.filter(r=>r==='tex').length);
  for(const[name,content]of Object.entries(writes))fs.data.set(`${ROOT}/${name}`,content);
  return{exit_code:exit,log,stdout};
 };
 const bib=bibliography==='biber'?{kind:'biber',bcf:'main.bcf',bbl:`${ROOT}/main.bbl`,run:async()=>run(['biber']).exit_code}:null;
 return scribyraTexPasses({FS:fs,projectDir:ROOT,inputs:new Set([`${ROOT}/main.tex`]),run,tex:['tex'],fatal:['Fatal error occurred'],all:['Fatal error occurred','No pages of output.'],bibliography:bib,index:null,
  consulted:()=>({paths:new Set(consulted.paths),truncated:false,missing:[...consulted.missing]}),maxPasses,print:()=>{}}).then(result=>({...result,runs}));
}

test('a document without cross-references needs two passes, not BusyTeX\'s four',async()=>{
 const fs=memoryFS({'main.tex':'x'});
 const result=await simulate(fs,{pass:read=>{read('main.aux');return{writes:{'main.aux':'\\relax\n\\gdef \\@abspage@last{1}\n'},log:read('main.aux')?'':'No file main.aux.'};}});
 assert.equal(result.exit_code,0);assert.equal(result.passes,2);
});

test('a changed table of contents reruns even when LaTeX prints no rerun warning',async()=>{
 const fs=memoryFS({'main.tex':'x'});
 const result=await simulate(fs,{pass:read=>{read('main.aux');const toc=read('main.toc');return{writes:{'main.aux':'\\relax\n','main.toc':'\\contentsline{section}{Intro}{1}\n'},log:toc===undefined?'No file main.toc.':''};}});
 assert.equal(result.passes,2);
});

test('labels that settle after one rerun take two passes; page references that move take three',async()=>{
 const labels=memoryFS({'main.tex':'x'});
 assert.equal((await simulate(labels,{pass:read=>{read('main.aux');return{writes:{'main.aux':'\\newlabel{a}{{1}{1}}\n'},log:'LaTeX Warning: Label(s) may have changed. Rerun to get cross-references right.'};}})).passes,2);
 const moving=memoryFS({'main.tex':'x'});
 // The second pass's references move a label to the next page once; the third reads it back.
 const result=await simulate(moving,{pass:read=>{const aux=read('main.aux');return{writes:{'main.aux':aux===undefined?'\\newlabel{a}{{1}{1}}\n':'\\newlabel{a}{{1}{2}}\n'}};}});
 assert.equal(result.passes,3);
});

test('a rerun warning alone does not cost a pass when nothing LuaLaTeX reads changed',async()=>{
 const fs=memoryFS({'main.tex':'x','main.aux':'\\relax\n'});
 const result=await simulate(fs,{pass:read=>{read('main.aux');return{writes:{'main.aux':'\\relax\n'},log:'LaTeX Warning: There were undefined references.\nPackage rerunfilecheck Warning: File `main.out\' has changed. Rerun to get outlines right'};}});
 assert.equal(result.passes,1);
});

test('generated files LuaLaTeX never reads do not cause reruns',async()=>{
 const fs=memoryFS({'main.tex':'x'});
 let n=0;
 const result=await simulate(fs,{pass:read=>{read('main.aux');return{writes:{'main.aux':'\\relax\n','main.lof':`figures ${++n}`,'main.idx':`entry ${n}`}};}});
 assert.equal(result.passes,2);
});

test('Biber runs once its control file exists and again only when it changes; the bibliography costs one pass',async()=>{
 const fs=memoryFS({'main.tex':'x'});
 const result=await simulate(fs,{
  pass:read=>{const aux=read('main.aux'),bbl=read('main.bbl');return{writes:{'main.bcf':'<cite key="a"/>','main.aux':bbl?'\\abx@aux@cite{a}\n\\newlabel{a}{{[1]}}\n':'\\abx@aux@cite{a}\n'},log:bbl===undefined?'No file main.bbl.':''};},
  biber:bcf=>`\\entry{a}{${bcf.length}}`,
 },{bibliography:'biber'});
 assert.deepEqual(result.runs,['tex','biber','tex','tex']);assert.equal(result.passes,3);
});

test('a document that never settles stops at the pass bound with the last pass\'s output',async()=>{
 const fs=memoryFS({'main.tex':'x'});
 const result=await simulate(fs,{pass:(read,n)=>{read('main.aux');return{writes:{'main.aux':`\\gdef\\counter{${n}}\n`}};}});
 assert.equal(result.passes,5);assert.equal(result.exit_code,0);
});

test('a failing pass stops at once, and the final pass alone must produce pages',async()=>{
 const failing=memoryFS({'main.tex':'x'});
 const failed=await simulate(failing,{pass:()=>({exit:1,log:'! LaTeX Error: File `siunitx.sty\' not found.'})});
 assert.equal(failed.passes,1);assert.equal(failed.exit_code,1);
 const empty=memoryFS({'main.tex':'x'});
 const noPages=await simulate(empty,{pass:read=>{read('main.aux');return{writes:{'main.aux':'\\relax\n'},stdout:'No pages of output.'};}});
 assert.equal(noPages.passes,2);assert.equal(noPages.exit_code,1);
});

test('the source scan names classes, packages, themes, libraries and styles, never comments or macros',()=>{
 const tex=String.raw`\documentclass[11pt]{beamer}
\usetheme{Madrid}\usecolortheme{beaver}
\usepackage[T1]{fontenc}
\usepackage{amsmath, siunitx,
 booktabs}
% \usepackage{ignored}
\usepackage{\mypackage}\RequirePackage[strict]{csquotes}
\usetikzlibrary{arrows.meta,calc}\usepgfplotslibrary{fillbetween}
\bibliographystyle{plainnat} 50\% \usepackage{after-percent-sign}`;
 assert.deepEqual(fileRequests(tex).sort(),['after-percent-sign.sty','amsmath.sty','beamer.cls','beamercolorthemebeaver.sty','beamerthemeMadrid.sty','booktabs.sty','csquotes.sty','fontenc.sty','pgfplotslibraryfillbetween.code.tex','plainnat.bst','siunitx.sty','tikzlibraryarrows.meta.code.tex','tikzlibrarycalc.code.tex']);
 assert.equal(stripComments('a % b\n\\% c % d'),'a \n\\% c ');
 assert.deepEqual(projectRequests([{path:'main.tex',content:'\\documentclass{article}\\usepackage{mystyle,hyperref}'},{path:'styles/mystyle.sty',content:'\\RequirePackage{xcolor}'},{path:'fig.png',content:new Uint8Array(4)}]),['article.cls','hyperref.sty','xcolor.sty']);
});

test('each project remembers the packages its last successful compile installed, per catalog snapshot',()=>{
 const store=new Map(),storage={getItem:key=>store.get(key)??null,setItem:(key,value)=>store.set(key,String(value))};
 assert.deepEqual(rememberedPackages('p1','snap',storage),[]);
 assert.ok(rememberPackages('p1','snap',['siunitx','dist--biblatex','siunitx','bad name','../x'],storage,1));
 assert.deepEqual(rememberedPackages('p1','snap',storage),['dist--biblatex','siunitx']);
 assert.deepEqual(rememberedPackages('p1','other-snapshot',storage),[]);
 assert.deepEqual(rememberedPackages('p2','snap',storage),[]);
 for(let i=0;i<205;i++)rememberPackages(`q${i}`,'snap',['x'],storage,10+i);
 assert.deepEqual(rememberedPackages('p1','snap',storage),[],'the least recently used projects are dropped beyond 200');
 assert.deepEqual(rememberedPackages('q204','snap',storage),['x']);
 forgetPackages('q204',storage);assert.deepEqual(rememberedPackages('q204','snap',storage),[]);
 const broken={getItem:()=>{throw new Error('denied');},setItem:()=>{throw new Error('denied');}};
 assert.deepEqual(rememberedPackages('p1','snap',broken),[]);assert.equal(rememberPackages('p1','snap',['x'],broken),false);
});
