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
import {latexContext,matchLabel,rankItems,completionOptions,buildCatalog,shapeOf,environmentTemplate,inComment,openEnvironment,openEnvironments,argumentKind,optionContext,optionEntries,splitItems} from '../web/latex-completion.js';
import * as data from '../web/latex-completion-data.js';
import * as optionData from '../web/latex-options-data.js';
import {labelTarget,suggestLabel,slugify,labelStyle,prefixFor,uniqueKey,titleWords} from '../web/latex-labels.js';
import {environmentPairing,environmentTokenAt,matchingEnvironment,pairedEnvironmentEdit} from '../web/latex-environment-pair.js';
import {EditorState} from '@codemirror/state';
import {history,undo,redo} from '@codemirror/commands';
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

test('label keys come from the heading title or the caption, with the usual prefixes',()=>{
  assert.equal(slugify('Introduction'),'introduction');
  assert.equal(slugify('Related Work on Graph Neural Networks'),'related-work-graph-neural-networks');
  assert.equal(slugify(String.raw`The $k$-means \emph{algorithm}\footnote{See [3].}`),'k-means-algorithm');
  assert.equal(slugify(String.raw`Résumé of Gödel’s \LaTeX{} straße`),'resume-godel-s-latex-strasse');
  assert.equal(slugify('A very long title that keeps going well past the limit of words'),'very-long-title-that-keeps');
  assert.equal(slugify('Of the'),'of-the');assert.deepEqual(titleWords('\\textbf{Bold} and $x^2$'),['bold','and','x','2']);
  const before=text=>labelTarget(text,'');
  assert.deepEqual(before('\\section{Introduction}\n'),{kind:'section',title:'Introduction',from:'title'});
  assert.deepEqual(before('\\subsection*[Short]{Long \\emph{title}} '),{kind:'subsection',title:'Long \\emph{title}',from:'title'});
  assert.equal(before('\\section{Introduction}\nSome text. '),null,'a label after running text names no heading');
  assert.equal(before('% \\section{Commented}\n'),null);
  assert.deepEqual(labelTarget('\\begin{figure}\n\\includegraphics{map}\n\\caption{Survey map of the site}\n'),{kind:'figure',title:'Survey map of the site',from:'caption'});
  assert.deepEqual(labelTarget('\\begin{table}\n','}\n\\caption[short]{Results by year}\n\\end{table}\n\\caption{Other}'),{kind:'table',title:'Results by year',from:'caption'});
  assert.deepEqual(labelTarget('\\section{Method}\n\\begin{equation}\nE=mc^2\n'),{kind:'equation',title:'Method',from:'section'});
  assert.deepEqual(labelTarget('\\begin{theorem}[Pythagoras]\n'),{kind:'theorem',title:'Pythagoras',from:'name'});
  assert.deepEqual(labelTarget('\\begin{figure}\\begin{subfigure}{.5\\linewidth}\\caption{Left}'),{kind:'figure',title:'Left',from:'caption'});
  assert.equal(labelTarget('\\begin{figure}x\\end{figure}\n\\begin{itemize}\\item '),null);
});

test('label keys follow the project prefix style and are unique',()=>{
  const key=(target,keys=[])=>suggestLabel(target,keys).key;
  assert.equal(key({kind:'section',title:'Introduction',from:'title'}),'sec:introduction');
  assert.equal(key({kind:'chapter',title:'Background',from:'title'}),'chap:background');
  assert.equal(key({kind:'figure',title:'Survey map',from:'caption'}),'fig:survey-map');
  assert.equal(key({kind:'table',title:'Results',from:'caption'}),'tab:results');
  assert.equal(key({kind:'equation',title:'',from:''}),'eq:1');assert.equal(key({kind:'equation',title:'',from:''},['eq:1','eq:2']),'eq:3');
  assert.equal(key({kind:'equation',title:'Method',from:'section'}),'eq:method');
  assert.equal(key({kind:'subsection',title:'Setup',from:'title'}),'sec:setup','subsections share sec: unless the project uses subsec:');
  assert.equal(key({kind:'subsection',title:'Setup',from:'title'},['subsec:a','sec:b']),'subsec:setup');
  assert.equal(key({kind:'section',title:'Introduction',from:'title'},['sec:introduction']),'sec:introduction-2');
  assert.equal(key({kind:'section',title:'Introduction',from:'title'},['sec:introduction','sec:introduction-2']),'sec:introduction-3');
  // An existing style: `figure-` with underscores between words, `ch:` for chapters.
  const style=['figure-survey_map','figure-other_plot','ch:one','ch:two','tbl-results'];
  assert.equal(key({kind:'figure',title:'Field site photo',from:'caption'},style),'figure-field_site_photo');
  assert.equal(key({kind:'chapter',title:'Discussion',from:'title'},['ch:one','ch:two','chap:x']),'ch:discussion');
  assert.equal(key({kind:'table',title:'Costs',from:'caption'},style),'tbl-costs');
  assert.deepEqual(labelStyle(['fig:a-b','sec:c-d']),{prefixes:{fig:1,sec:1},separator:':',word:'-'});
  assert.equal(prefixFor('subsubsection',labelStyle(['ssec:a'])),'ssec');assert.equal(uniqueKey('a',new Set(['a','a_2']),'_'),'a_3');
  assert.match(suggestLabel({kind:'section',title:'Introduction',from:'title'},[]).description,/section, from its title “Introduction”/);
});

test('\\label{ offers the derived key first, ignoring the label being edited, and filters by what is typed',()=>{
  const index={...empty,labels:[{key:'sec:introduction',path:'main.tex',line:9},{key:'sec:introduction',path:'main.tex',line:2}]};
  assert.equal(contextOf('\\section{Intro}\\label{|').kind,'newlabel');
  const target={kind:'section',title:'Introduction',from:'title'};
  const options=completionOptions({kind:'newlabel',from:7,to:7,query:'',closed:false},catalog,index,{target,currentPath:'main.tex',currentLine:2});
  assert.deepEqual(options.map(o=>[o.label,o.source]),[['sec:introduction-2','new label']]);
  assert.equal(completionOptions({kind:'newlabel',from:7,to:7,query:'sec:',closed:false},catalog,empty,{target})[0].label,'sec:introduction');
  assert.deepEqual(completionOptions({kind:'newlabel',from:7,to:7,query:'fig',closed:false},catalog,empty,{target}),[]);
  assert.deepEqual(completionOptions({kind:'newlabel',from:7,to:7,query:'',closed:false},catalog,empty,{target:null}),[]);
});

const full=buildCatalog(data,packages.packages,optionData);
test('option data: about thirty packages and the common classes, well-formed and without duplicates',()=>{
  const packageNames=Object.keys(optionData.PACKAGE_OPTIONS);assert.ok(packageNames.length>=30,packageNames.length);
  for(const name of ['geometry','babel','hyperref','inputenc','fontenc','xcolor','graphicx','biblatex','natbib','amsmath','siunitx','cleveref','caption','subcaption','listings','minted','enumitem','microtype','csquotes','todonotes'])assert.ok(optionData.PACKAGE_OPTIONS[name]?.length,name);
  for(const name of ['article','report','book','beamer','memoir','scrartcl','scrreprt','scrbook','standalone'])assert.ok(optionData.CLASS_OPTIONS[name]?.length,name);
  for(const name of ['tikz','graphicx','hyperref','listings'])assert.ok(optionData.KEYS[name]?.length,name);
  for(const [group,table] of Object.entries({...Object.fromEntries(Object.entries(optionData.PACKAGE_OPTIONS).map(([k,v])=>['package '+k,v])),...Object.fromEntries(Object.entries(optionData.CLASS_OPTIONS).map(([k,v])=>['class '+k,v])),...Object.fromEntries(Object.entries(optionData.KEYS).map(([k,v])=>['keys '+k,v]))})){
    const names=table.map(e=>e[0]);assert.equal(new Set(names).size,names.length,`${group} has duplicates: ${names.filter((n,i)=>names.indexOf(n)!==i)}`);
    for(const [name,description,values] of table){
      assert.match(name,/^[^\s,{}\[\]](?:[^,{}\[\]]*[^\s,{}\[\]])?$/,`${group}: ${name}`);assert.ok(description&&typeof description==='string',`${group}: ${name} has a description`);
      if(values!==undefined){assert.ok(name.endsWith('='),`${group}: only keys take values (${name})`);assert.ok(Array.isArray(values)&&values.length,`${group}: ${name}`);for(const v of values)assert.ok(typeof v==='string'||Array.isArray(v)&&v.length===2,`${group}: ${name}`);}
    }
  }
  assert.ok(packages.packages.includes('geometry')&&Object.keys(optionData.PACKAGE_OPTIONS).filter(name=>name!=='babel').every(name=>packages.packages.includes(name)),'every package with options is in the TeX Live list (babel ships with the base system)');
  assert.equal(optionEntries(full.options,{type:'class',names:['article']})[0].source,'article class');
});

test('option contexts: package and class options, values after key=, setup commands and TikZ',()=>{
  const ctx=source=>{const {doc,pos}=at(source);return optionContext(doc,pos);};
  let c=ctx('\\usepackage[a4paper, mar|]{geometry}');assert.deepEqual({...c,set:{...c.set}},{kind:'option',set:{type:'package',names:['geometry']},key:null,from:21,to:24,query:'mar',present:['a4paper'],close:''});
  c=ctx('\\usepackage[backend=bi|,style=apa]{biblatex}');assert.equal(c.key,'backend');assert.equal(c.query,'bi');assert.deepEqual(c.present,['style']);
  c=ctx('\\usepackage[|{geometry}');assert.deepEqual([c.set.names,c.close],[['geometry'],']']);
  c=ctx('\\documentclass[11pt,|]{article}');assert.deepEqual([c.set.type,c.set.names,c.query],['class',['article'],'']);
  c=ctx('\\usepackage[\n  colorlinks,\n  linkcolor=|\n]{hyperref}');assert.equal(c.key,'linkcolor');assert.deepEqual(c.set.names,['hyperref']);
  c=ctx('\\usepackage[pdftitle={A, B}, |]{hyperref}');assert.deepEqual(c.present,['pdftitle']);
  assert.equal(ctx('\\usepackage[|'),null,'no package name yet');
  assert.deepEqual(ctx('\\hypersetup{colorlinks, url|').set,{type:'keys',names:['hyperref']});
  assert.deepEqual(ctx('\\includegraphics[width=0.5\\linewidth, sc|]{x}').set.names,['graphicx']);
  assert.deepEqual(ctx('\\begin{tikzpicture}[thi|]').set.names,['tikz']);
  assert.deepEqual(ctx('\\draw[->, thi|] (0,0) -- (1,1);').set.names,['tikz']);
  assert.deepEqual(ctx('\\draw (0,0) -- (1,0) node[ab|] {x};').set.names,['tikz']);
  assert.deepEqual(ctx('\\node (a) [dra|] {A};').set.names,['tikz']);
  assert.deepEqual(ctx('\\captionsetup[figure]{labelf|}').set.names,['caption']);
  assert.equal(ctx('\\section[|]{x}'),null);assert.equal(ctx('see [1|]'),null);assert.equal(ctx('\\[ x |'),null);
  assert.equal(contextOf('% \\usepackage[|]{geometry}'),null);
  assert.equal(contextOf('\\usepackage[margin=1in]{geo|}').kind,'package','the package name is still a package argument');
  assert.equal(contextOf('\\hypersetup{urlcolor=\\bl|').kind,'command','a command inside a value completes as a command');
  assert.deepEqual(splitItems('a, b={x,y}, c').map(i=>i.text),['a',' b={x,y}',' c']);
});

test('option suggestions: names not given yet, values where finite, and accepting a key reopens for its values',()=>{
  const labels=context=>completionOptions(context,full,empty).map(o=>o.label);
  const base={kind:'option',set:{type:'package',names:['geometry']},key:null,from:0,to:0,query:'',present:[],close:''};
  assert.ok(labels(base).includes('a4paper'));assert.ok(!labels({...base,present:['a4paper']}).includes('a4paper'));
  assert.ok(!labels({...base,present:['margin']}).includes('margin='));
  const margin=completionOptions({...base,query:'marg'},full,empty)[0];assert.deepEqual([margin.label,margin.source],['margin=','geometry']);
  assert.deepEqual(labels({...base,set:{type:'package',names:['biblatex']},key:'backend'}),['biber','bibtex','bibtex8']);
  const backend=completionOptions({...base,set:{type:'package',names:['biblatex']},query:'back'},full,empty)[0];assert.equal(backend.label,'backend=');assert.match(backend.detail,/= biber \| bibtex \| bibtex8/);
  assert.deepEqual(labels({...base,set:{type:'package',names:['biblatex']},key:'style',query:'authory'}).slice(0,2),['authoryear','authoryear-comp']);
  assert.deepEqual(labels({...base,key:'margin'}),[],'free values offer nothing');
  assert.deepEqual(labels({...base,set:{type:'class',names:['beamer']},key:'aspectratio',query:'16'}),['169','1610']);
  assert.ok(labels({...base,set:{type:'class',names:['report']},query:'open'}).includes('openright'));
  assert.ok(labels({...base,set:{type:'keys',names:['tikz']},query:'thi'}).includes('thick'));
  assert.deepEqual(labels({...base,set:{type:'package',names:['nosuchpackage']}}),[]);
  // Two packages in one \usepackage share the option list.
  assert.ok(labels({...base,set:{type:'package',names:['amsmath','natbib']},query:'sort'}).includes('sort&compress'));
});

test('\\end{ ranks the innermost open environment, then the ones around it; citation lists skip keys already given',()=>{
  assert.deepEqual(openEnvironments('\\begin{document}\\begin{figure}\\begin{center}'),['document','figure','center']);
  const end=completionOptions({kind:'end',from:0,to:0,query:'',closed:false,environment:'center',environments:['document','figure','center']},catalog,empty).map(o=>o.label);
  assert.deepEqual(end.slice(0,3),['center','figure','document']);
  const index={...empty,citations:[{key:'a1',path:'r.bib'},{key:'a2',path:'r.bib'}]};
  assert.deepEqual(completionOptions({kind:'cite',from:0,to:0,query:'a',closed:false},catalog,index,{present:['a1']}).map(o=>o.label),['a2']);
});

const pairState=(text,extra=[])=>{const pos=text.indexOf('|');return EditorState.create({doc:text.replace('|',''),selection:{anchor:pos},extensions:[environmentPairing(),history({newGroupDelay:0}),...extra]});};
const typeAt=(state,insert,{from=state.selection.main.head,to=from,userEvent='input.type'}={})=>state.update({changes:{from,to,insert},selection:{anchor:from+insert.length},...(userEvent?{userEvent}:{})}).state;
test('renaming \\begin{x} renames its own \\end{x}, nested same-name environments included, and undo reverts both',()=>{
  let state=pairState('\\begin{itemize|}\n\\item a\n\\begin{itemize}\\item b\\end{itemize}\n\\end{itemize}\n\\begin{itemize}\\end{itemize}');
  // Select "itemize" and type "enumerate" one letter at a time, as a person would.
  state=typeAt(state,'e',{from:7,to:14});for(const letter of 'numerate')state=typeAt(state,letter);
  assert.equal(state.doc.toString(),'\\begin{enumerate}\n\\item a\n\\begin{itemize}\\item b\\end{itemize}\n\\end{enumerate}\n\\begin{itemize}\\end{itemize}');
  // Deleting works the same way, and the \end side drives the \begin side.
  const at=state.doc.toString().indexOf('\\end{enumerate}')+5;
  state=state.update({changes:{from:at,to:at+9,insert:'description'},userEvent:'input.type'}).state;
  assert.match(state.doc.toString(),/^\\begin\{description\}[\s\S]*\\end\{description\}\n\\begin\{itemize\}/);
  state=state.update({changes:{from:7,to:8},userEvent:'delete.backward'}).state;assert.match(state.doc.toString(),/^\\begin\{escription\}[\s\S]*\\end\{escription\}/);
  // One undo step per edit: both halves come back together.
  const back=s=>{let next=s;undo({state:s,dispatch:tr=>{next=tr.state;}});return next;};
  state=back(state);assert.match(state.doc.toString(),/^\\begin\{description\}[\s\S]*\\end\{description\}/);
  let redone=state;redo({state,dispatch:tr=>{redone=tr.state;}});assert.match(redone.doc.toString(),/^\\begin\{escription\}[\s\S]*\\end\{escription\}/);
});

test('pairing leaves other environments, comments, read-only editors and non-typing changes alone',()=>{
  const env='\\begin{figure}\n% \\end{figure}\nx\n\\end{figure}';
  let state=typeAt(pairState(env),'s',{from:13});assert.equal(state.doc.toString(),'\\begin{figures}\n% \\end{figure}\nx\n\\end{figures}');
  const tr=pairState(env).update({changes:{from:13,insert:'s'},userEvent:'input.type'});assert.equal(tr.annotation(pairedEnvironmentEdit),true);
  assert.equal(typeAt(pairState('\\begin{a}x\\end{b}'),'a',{from:8}).doc.toString(),'\\begin{aa}x\\end{b}','no partner, no change elsewhere');
  assert.equal(typeAt(pairState(env),'s',{from:13,userEvent:null}).doc.toString(),'\\begin{figures}\n% \\end{figure}\nx\n\\end{figure}','programmatic and remote changes are not paired');
  assert.equal(typeAt(pairState(env),' x',{from:13}).doc.toString(),'\\begin{figure x}\n% \\end{figure}\nx\n\\end{figure}','a name that is no longer an environment name is not copied');
  const readOnly=EditorState.create({doc:env,extensions:[environmentPairing(),EditorState.readOnly.of(true)]});
  assert.equal(readOnly.update({changes:{from:13,insert:'s'},userEvent:'input.type'}).state.doc.toString(),'\\begin{figures}\n% \\end{figure}\nx\n\\end{figure}');
  const refused=EditorState.create({doc:env,extensions:[environmentPairing({allowSpan:()=>false})]});
  assert.equal(refused.update({changes:{from:13,insert:'s'},userEvent:'input.type'}).state.doc.toString(),'\\begin{figures}\n% \\end{figure}\nx\n\\end{figure}');
  const doc=pairState(env).doc,token=environmentTokenAt(doc,8,13);assert.deepEqual(token,{kind:'begin',name:'figure',from:0,nameFrom:7,nameTo:13});
  assert.equal(matchingEnvironment(doc,token).from,doc.toString().lastIndexOf('\\end'));
  assert.equal(environmentTokenAt(doc,3),null);
});
