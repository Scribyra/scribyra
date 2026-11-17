import './helpers/core.mjs';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {gunzipSync} from 'node:zlib';
import * as Y from 'yjs';
import {Text} from '@codemirror/state';
import {snippet} from '@codemirror/autocomplete';
import {addEntries} from '../web/model.js';
import {parseTex,parseBib,shortAuthors,plainBibText,latexIndex,fileKind} from '../web/latex-index.js';
import {latexContext,matchLabel,rankItems,completionOptions,buildCatalog,shapeOf,environmentTemplate,inComment,openEnvironment,argumentKind} from '../web/latex-completion.js';
import * as data from '../web/latex-completion-data.js';
import packages from '../web/latex-packages.js';
import {latexPackageList} from '../scripts/latex-packages.mjs';

const catalog=buildCatalog(data,packages.packages);
const at=(source,{marker='|'}={})=>{const pos=source.indexOf(marker);return {doc:Text.of(source.replace(marker,'').split('\n')),pos};};
const contextOf=source=>{const {doc,pos}=at(source);return latexContext(doc,pos);};
const empty={labels:[],citations:[],commands:[],environments:[],paths:{tex:[],bib:[],image:[]}};

test('labels, user commands, operators and environments are parsed with their lines, ignoring comments',()=>{
  const result=parseTex(String.raw`\section{A}\label{sec:a}
% \label{commented}
\newcommand{\R}{\mathbb{R}}
\newcommand\norm[1]{\lVert #1\rVert}
\renewcommand*{\vect}[2][x]{#1_#2}
\DeclareMathOperator{\Tr}{Tr}
\NewDocumentCommand{\pair}{O{0} m m}{(#2,#3)}
\def\half#1{#1/2}
\newenvironment{note}[1]{\textbf{#1}}{}
\newtheorem{conj}{Conjecture}
\makeatletter\newcommand{\@internal}{}\makeatother
Price 50\% \label{eq:x}`);
  assert.deepEqual(result.labels,[{key:'sec:a',line:1},{key:'eq:x',line:12}]);
  const commands=Object.fromEntries(result.commands.map(c=>[c.name,c]));
  assert.deepEqual(Object.keys(commands).sort(),['R','Tr','half','norm','pair','vect']);
  assert.equal(commands.R.args,0);assert.equal(commands.norm.args,1);assert.equal(commands.vect.args,2);assert.equal(commands.vect.optional,true);
  assert.equal(commands.Tr.operator,true);assert.equal(commands.pair.args,2);assert.equal(commands.pair.optional,true);assert.equal(commands.half.args,1);
  assert.equal(commands.norm.line,4);
  assert.deepEqual(result.environments.map(e=>[e.name,e.args,!!e.theorem]),[['note',1,false],['conj',0,true]]);
});

test('BibTeX entries give key, type, short authors, plain title and year; strings and comments are skipped',()=>{
  const entries=parseBib(String.raw`@string{jgr = "J. Geophys. Res."}
@comment{ignored, author={Nobody}}
@Article{knuth1984,
  author = {Donald E. Knuth},
  title = {Literate {P}rogramming},
  journal = jgr,
  year = 1984,
}
@book(lamport94, author="Leslie Lamport and {M}ichel Goossens", title="{\LaTeX}: A Document Preparation System", year="1994")
@online{web, author={Sch{\"o}n, A. and Ng, B. and Li, C.}, title={Notes}, date={2021-03-04}}
@misc{bad key, title={x}}`);
  assert.deepEqual(entries.map(e=>[e.key,e.type,e.author,e.title,e.year]),[
    ['knuth1984','article','Knuth','Literate Programming','1984'],
    ['lamport94','book','Lamport and Goossens','LaTeX: A Document Preparation System','1994'],
    ['web','online','Schon et al.','Notes','2021'],
  ]);
  assert.equal(shortAuthors('Ada Lovelace'),'Lovelace');assert.equal(plainBibText('{\\\'E}cole~Normale'),'Ecole Normale');
});

test('ranking prefers exact prefixes, then word starts, substrings and subsequences, with frequency breaking ties',()=>{
  assert.deepEqual(matchLabel('section','sec'),{score:1000,ranges:[0,3]});
  assert.equal(matchLabel('Section','sec').score,900);
  assert.deepEqual(matchLabel('subsection','section'),{score:500,ranges:[3,10]});
  assert.equal(matchLabel('autoref','ref').score,500);
  assert.equal(matchLabel('newCommand','command').score,600);
  assert.deepEqual(matchLabel('subsection','sbs').ranges,[0,1,2,4]);
  assert.equal(matchLabel('section','xyz'),null);assert.equal(matchLabel('section','ect').score,500);
  const items=[{label:'subsection',rank:94},{label:'section',rank:98},{label:'secant',rank:1},{label:'sectionmark',rank:0}];
  assert.deepEqual(rankItems(items,'sec').map(r=>r.item.label),['section','secant','sectionmark','subsection']);
  assert.deepEqual(rankItems(items,'sec',{usage:{sectionmark:20}}).map(r=>r.item.label).slice(0,2),['section','sectionmark']);
  assert.equal(rankItems(items,'',{limit:2}).length,2);
});

test('command context opens after a backslash, but not after an escaped one, in comments or in verbatim text',()=>{
  assert.deepEqual(contextOf('Text \\sec|'),{kind:'command',from:5,to:9,query:'sec'});
  assert.deepEqual(contextOf('\\|'),{kind:'command',from:0,to:1,query:''});
  assert.deepEqual(contextOf('\\se|ction{x}'),{kind:'command',from:0,to:8,query:'se'});
  assert.equal(contextOf('a \\\\sec|'),null);
  assert.equal(contextOf('a \\\\\\sec|').query,'sec');
  assert.equal(contextOf('% note \\sec|'),null);
  assert.equal(contextOf('50\\% off \\sec|').query,'sec');
  assert.equal(contextOf('\\begin{verbatim}\n\\sec|'),null);
  assert.equal(contextOf('\\begin{verbatim}\n\\end{verbatim}\n\\sec|').query,'sec');
  assert.equal(contextOf('\\verb|\\sec'.replace('|','!')+'|'),null);
  assert.equal(contextOf('plain words|'),null);
  assert.ok(inComment('x % y'));assert.ok(!inComment('x \\% y'));assert.ok(inComment('x \\\\% y'));
});

test('argument contexts: references, citation lists, files, packages and environments',()=>{
  assert.deepEqual(contextOf('see \\ref{fig:|}'),{kind:'label',command:'ref',from:9,to:13,query:'fig:',closed:true,commandFrom:4,environment:''});
  const cite=contextOf('\\citep[p.~3][]{knuth, lam|');assert.equal(cite.kind,'cite');assert.equal(cite.query,'lam');assert.equal(cite.closed,false);
  assert.equal(contextOf('\\parencite{|').kind,'cite');assert.equal(contextOf('\\Textcite{|').kind,'cite');assert.equal(contextOf('\\nocite{|').kind,'cite');
  assert.equal(contextOf('\\includegraphics[width=0.5\\linewidth]{fig|').kind,'image');
  assert.equal(contextOf('\\input{chap|').kind,'tex');assert.equal(contextOf('\\usepackage[utf8]{inpu|').kind,'package');
  assert.equal(contextOf('\\cref{a,b|').query,'b');
  const begin=contextOf('  \\begin{ite|');assert.equal(begin.kind,'begin');assert.equal(begin.commandFrom,2);
  assert.equal(contextOf('\\begin{itemize}\n\\item a\n\\end{|').environment,'itemize');
  assert.equal(contextOf('\\section{|'),null);assert.equal(argumentKind('textbf'),null);
  assert.equal(openEnvironment('\\begin{a}\\begin{b}\\end{b}'),'a');
});

test('options: \\sec offers section first with its argument shape, description and source; typed braces are never doubled',()=>{
  const options=completionOptions({kind:'command',from:0,to:4,query:'sec'},catalog,empty);
  assert.equal(options[0].label,'\\section');assert.equal(options[0].detail,'{title}');assert.equal(options[0].source,'LaTeX');assert.match(options[0].description,/section/i);
  assert.ok(options.slice(0,4).some(o=>o.label==='\\section*'));
  assert.ok(completionOptions({kind:'command',from:0,to:4,query:'subs'},catalog,empty).some(o=>o.label==='\\subsection'));
  const frac=completionOptions({kind:'command',from:0,to:5,query:'frac'},catalog,empty)[0];assert.equal(frac.label,'\\frac');assert.equal(frac.detail,'{numerator}{denominator}');
  assert.equal(completionOptions({kind:'command',from:0,to:5,query:'eqr'},catalog,empty)[0].source,'amsmath');
  const begin=completionOptions({kind:'command',from:0,to:6,query:'begin'},catalog,empty);
  assert.equal(begin[0].label,'\\begin');assert.ok(begin.some(o=>o.label==='\\begin{itemize}'));
  assert.equal(shapeOf('[${options}]{${package}}'),'[options]{package}');assert.equal(shapeOf('\\\\{'),'\\{');
  assert.equal(environmentTemplate('itemize','','\t\\item ${}'),'\\begin{itemize}\n\t\\item ${}\n\\end{itemize}');
});

test('project names: labels from every file, bibliography keys with authors, files, images and user commands',()=>{
  const index={labels:[{key:'fig:map',line:3,path:'chapters/two.tex'},{key:'sec:intro',line:1,path:'main.tex'}],citations:[{key:'knuth1984',author:'Knuth',year:'1984',title:'Literate Programming',type:'article',path:'refs.bib'}],
    commands:[{name:'R',args:0,optional:false,line:2,path:'macros.tex'},{name:'section',args:1,optional:false,line:3,path:'macros.tex'}],environments:[{name:'note',args:1,line:4,path:'macros.tex'}],
    paths:{tex:['chapters/two.tex','main.tex'],bib:['refs.bib'],image:['figures/map.png']}};
  const label=completionOptions({kind:'label',from:5,to:5,query:'fig',closed:false},catalog,index);assert.deepEqual(label.map(o=>[o.label,o.description]),[['fig:map','chapters/two.tex:3']]);
  const cite=completionOptions({kind:'cite',from:6,to:6,query:'',closed:true},catalog,index)[0];assert.deepEqual([cite.label,cite.detail,cite.description],['knuth1984','Knuth, 1984','Literate Programming']);
  assert.deepEqual(completionOptions({kind:'tex',from:7,to:7,query:'',closed:false},catalog,index,{currentPath:'main.tex'}).map(o=>o.label),['chapters/two']);
  assert.deepEqual(completionOptions({kind:'image',from:7,to:7,query:'map',closed:false},catalog,index).map(o=>o.label),['figures/map.png']);
  assert.deepEqual(completionOptions({kind:'bib',command:'bibliography',from:7,to:7,query:'',closed:false},catalog,index).map(o=>o.label),['refs']);
  const r=completionOptions({kind:'command',from:0,to:2,query:'R'},catalog,index).find(o=>o.label==='\\R');assert.equal(r.source,'this project');assert.match(r.description,/macros.tex:2/);
  assert.equal(completionOptions({kind:'command',from:0,to:8,query:'section'},catalog,index).filter(o=>o.label==='\\section'&&o.source==='this project').length,0);
  assert.ok(completionOptions({kind:'begin',from:7,to:7,query:'no',closed:false,commandFrom:0},catalog,index).some(o=>o.label==='note'&&o.source==='this project'));
  assert.equal(completionOptions({kind:'package',from:0,to:0,query:'amsmat',closed:false},catalog,index)[0].label,'amsmath');
  assert.equal(completionOptions({kind:'end',from:0,to:0,query:'',closed:false,environment:'proof'},catalog,index)[0].label,'proof');
});

test('the project index parses each changed file once, after edits stop, and drops removed files',async()=>{
  const doc=new Y.Doc();
  addEntries(doc,[{id:'m',path:'main.tex',content:'\\label{a}'},{id:'c',path:'ch/one.tex',content:'\\label{b}\\newcommand{\\R}{x}'},{id:'b',path:'refs.bib',content:'@book{k1, title={T}, year=2001}'},{id:'i',path:'fig/x.png',content:new Uint8Array([1,2,3])}]);
  const jobs=[];const index=latexIndex(doc,{quiet:0,schedule:job=>jobs.push(job)});
  const run=async()=>{await new Promise(r=>setTimeout(r,5));while(jobs.length)jobs.shift()({timeRemaining:()=>10});};
  await run();let snap=index.snapshot();
  assert.deepEqual(snap.labels.map(l=>l.key).sort(),['a','b']);assert.equal(snap.citations[0].key,'k1');assert.deepEqual(snap.paths.image,['fig/x.png']);assert.equal(snap.commands[0].name,'R');
  assert.equal(index.ready,true);
  doc.getText('text:m').insert(9,'\\label{c}');assert.equal(index.ready,false);await run();
  snap=index.snapshot();assert.deepEqual(snap.labels.map(l=>l.key).sort(),['a','b','c']);
  assert.equal(index.snapshot(),snap,'snapshots are cached until something changes');
  doc.getMap('files').delete('c');await run();assert.deepEqual(index.snapshot().labels.map(l=>l.key).sort(),['a','c']);
  index.close();doc.getText('text:m').insert(0,'\\label{z}');await run();assert.ok(!index.snapshot().labels.some(l=>l.key==='z'));
  assert.equal(fileKind('a/b.TEX'),'tex');assert.equal(fileKind('x.bib'),'bib');assert.equal(fileKind('p.jpeg'),'image');
});

test('curated data parses as snippets, uses no linked fields by accident, and the package list matches the TeX catalog',()=>{
  for(const [name,template] of data.COMMANDS){assert.doesNotThrow(()=>snippet('\\'+name+template),name);const names=[...template.matchAll(/\$\{([^{}]*)\}/g)].map(m=>m[1]).filter(Boolean);assert.equal(new Set(names).size,names.length,`${name}${template}`);}
  for(const [name,args,body] of data.ENVIRONMENTS){const t=environmentTemplate(name,args,body);assert.doesNotThrow(()=>snippet(t),name);const names=[...t.matchAll(/\$\{([^{}]*)\}/g)].map(m=>m[1]).filter(Boolean);assert.equal(new Set(names).size,names.length,name);}
  assert.equal(new Set(data.ENVIRONMENTS.map(e=>e[0])).size,data.ENVIRONMENTS.length);
  const source=JSON.parse(gunzipSync(readFileSync(new URL('../web/tex-catalog.json.gz',import.meta.url))));
  assert.deepEqual(latexPackageList(source),packages,'run node scripts/latex-packages.mjs');
  for(const name of ['amsmath','graphicx','hyperref','booktabs','natbib','biblatex','geometry','xcolor','tikz','siunitx','cleveref'])assert.ok(packages.packages.includes(name),name);
});
