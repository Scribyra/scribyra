// The documents of the compile-engine benchmark (docs/compile-engines.md), as project
// directories with a main.tex each:
//   sample   the app's sample paper (web/model.js STARTER)
//   article  a medium article: 12 sections, equations, tables, a figure, 80 references (Biber)
//   beamer   a 24-frame Beamer deck with blocks, columns, overlays and a TikZ diagram
//   tikz     a TikZ-heavy document: 40 pictures (plots, trees, graphs, shading, decorations)
//   thesis   the 305-page thesis of docs/large-projects.md (scripts/large-projects.mjs)
// Everything is generated deterministically; nothing is copyrighted text.
//   node scripts/compile-benchmark-docs.mjs [outDir]   (default target/compile-benchmark/docs)
import {mkdirSync,writeFileSync,readFileSync,rmSync,existsSync} from 'node:fs';
import {join,resolve,dirname} from 'node:path';
import {execFileSync} from 'node:child_process';
import {unzipSync} from 'fflate';

const out=resolve(process.argv[2]||'target/compile-benchmark/docs');
rmSync(out,{recursive:true,force:true});
const put=(doc,path,content)=>{const file=join(out,doc,path);mkdirSync(dirname(file),{recursive:true});writeFileSync(file,content);};
function rng(seed){return()=>{seed|=0;seed=seed+0x6D2B79F5|0;let t=Math.imul(seed^seed>>>15,1|seed);t=t+Math.imul(t^t>>>7,61|t)^t;return((t^t>>>14)>>>0)/4294967296;};}
const r=rng(20261119),pick=list=>list[Math.floor(r()*list.length)];
const words='model sample boundary estimate signal surface network gradient dataset protocol sensor interval manifold operator kernel spectrum measurement variance threshold layer domain solution approximation experiment framework parameter sequence structure observation response'.split(' ');
const adj='robust linear stochastic adaptive empirical discrete nonlinear sparse stable coherent reproducible bounded periodic latent smooth consistent efficient'.split(' ');
const verbs='improves reduces constrains describes predicts approximates reveals supports determines limits extends captures separates preserves measures'.split(' ');
const sentence=()=>{const s=`The ${pick(adj)} ${pick(words)} ${pick(verbs)} the ${pick(adj)} ${pick(words)} of the ${pick(words)}`;return s[0].toUpperCase()+s.slice(1)+'.';};
const paragraph=n=>Array.from({length:n},sentence).join(' ');

// 1. The sample paper, exactly as a new sample project holds it.
const model=readFileSync('web/model.js','utf8'),starter=model.slice(model.indexOf('export const STARTER = String.raw`')+'export const STARTER = String.raw`'.length);
put('sample','main.tex',starter.slice(0,starter.indexOf('`;')));

// 2. A medium article with Biber.
{
 const keys=Array.from({length:80},(_,i)=>`ref${i+1}`);
 let tex=String.raw`\documentclass[11pt,a4paper]{article}
\usepackage[T1]{fontenc}
\usepackage{amsmath,amssymb}
\usepackage{graphicx}
\usepackage{booktabs}
\usepackage[margin=2.5cm]{geometry}
\usepackage[backend=biber,style=authoryear]{biblatex}
\addbibresource{references.bib}
\usepackage{hyperref}
\title{On the ${pick(adj)} ${pick(words)} of ${pick(words)}s}
\author{A. Author \and B. Author}
\date{19 November 2026}
\begin{document}
\maketitle
\begin{abstract}
${paragraph(6)}
\end{abstract}
\tableofcontents
`;
 for(let s=1;s<=12;s++){
  tex+=`\\section{${pick(adj)[0].toUpperCase()}${pick(words)} ${s}}\\label{sec:${s}}\n`;
  for(let p=0;p<4;p++)tex+=`${paragraph(7)} See \\textcite{${pick(keys)}} and \\parencite{${pick(keys)},${pick(keys)}}; compare Section~\\ref{sec:${1+Math.floor(r()*12)}}.\n\n`;
  tex+=`\\begin{equation}\\label{eq:${s}}\n  f_{${s}}(x)=\\sum_{k=1}^{n}\\frac{a_k x^{k}}{k!}+\\int_0^{x}\\exp\\left(-\\frac{t^2}{2\\sigma^2}\\right)\\,\\mathrm{d}t\n\\end{equation}\nEquation~\\eqref{eq:${s}} ${pick(verbs)} the ${pick(words)}.\n\n`;
  if(s%3===0)tex+=`\\begin{table}[ht]\\centering\\caption{${sentence()}}\\label{tab:${s}}\n\\begin{tabular}{lrrr}\\toprule ${pick(words)} & mean & sd & n\\\\\\midrule\n${Array.from({length:6},()=>`${pick(words)} & ${(r()*100).toFixed(2)} & ${(r()*10).toFixed(2)} & ${Math.floor(r()*500)}\\\\`).join('\n')}\n\\bottomrule\\end{tabular}\\end{table}\n\n`;
  if(s===5)tex+=`\\begin{figure}[ht]\\centering\\includegraphics[width=0.5\\textwidth]{figure.png}\\caption{${sentence()}}\\end{figure}\n\n`;
 }
 tex+='\\printbibliography\n\\end{document}\n';
 put('article','main.tex',tex);
 put('article','figure.png',readFileSync('fixtures/article/figure.png'));
 put('article','references.bib',keys.map((k,i)=>`@article{${k},\n  author = {${pick(['Ada','Ben','Cleo','Dan','Eva','Fred'])} ${pick(['Smith','Jones','Brown','Taylor','Wilson','Clark'])} and ${pick(['Gus','Hana','Ivo'])} ${pick(['Moore','White','Hall'])}},\n  title = {${sentence().slice(0,-1)}},\n  journal = {Journal of ${pick(adj)} ${pick(words)}s},\n  year = {${1980+i%45}},\n  volume = {${1+i%30}},\n  pages = {${10+i}--${20+i}}\n}\n`).join('\n'));
}

// 3. A Beamer deck.
{
 let tex=String.raw`\documentclass{beamer}
\usetheme{Madrid}
\usepackage{tikz}
\title{The ${pick(adj)} ${pick(words)}}
\author{A. Speaker}
\date{19 November 2026}
\begin{document}
\frame{\titlepage}
\begin{frame}{Outline}\tableofcontents\end{frame}
`;
 for(let f=1;f<=22;f++){
  if(f%6===1)tex+=`\\section{Part ${Math.ceil(f/6)}}\n`;
  const kind=f%4;
  tex+=`\\begin{frame}{${pick(adj)} ${pick(words)} ${f}}\n`;
  if(kind===0)tex+=`\\begin{itemize}\n${Array.from({length:4},(_,i)=>`\\item<${i+1}-> ${sentence()}`).join('\n')}\n\\end{itemize}\n`;
  else if(kind===1)tex+=`\\begin{columns}\\column{0.5\\textwidth}${paragraph(2)}\\column{0.5\\textwidth}\\begin{block}{Result}$E=\\sum_i m_i c^2$\\end{block}\\end{columns}\n`;
  else if(kind===2)tex+=`\\begin{center}\\begin{tikzpicture}[node distance=2cm,every node/.style={draw,rounded corners,fill=blue!10}]\\node(a){${pick(words)}};\\node[right of=a](b){${pick(words)}};\\node[below of=a](c){${pick(words)}};\\draw[->,thick](a)--(b);\\draw[->,thick](a)--(c);\\draw[->,dashed](c)--(b);\\end{tikzpicture}\\end{center}\n`;
  else tex+=`\\begin{alertblock}{${pick(words)}}${sentence()}\\end{alertblock}\\begin{exampleblock}{${pick(words)}}${sentence()}\\end{exampleblock}\n`;
  tex+='\\end{frame}\n';
 }
 tex+='\\end{document}\n';
 put('beamer','main.tex',tex);
}

// 4. A TikZ-heavy document.
{
 let tex=String.raw`\documentclass{article}
\usepackage{tikz}
\usetikzlibrary{arrows.meta,decorations.pathmorphing,shadings,trees,calc,patterns}
\begin{document}
`;
 for(let i=1;i<=40;i++){
  tex+=`\\section*{Picture ${i}}\n\\begin{tikzpicture}[scale=0.9]\n`;
  switch(i%5){
   case 0:tex+=`\\draw[->](-0.2,0)--(6.3,0);\\draw[->](0,-1.2)--(0,1.2);\\draw[domain=0:6.28,samples=200,smooth,thick,blue]plot(\\x,{sin(${i}*\\x r)*exp(-0.2*\\x)});\\draw[domain=0:6.28,samples=100,red,dashed]plot(\\x,{cos(\\x r)});\n`;break;
   case 1:tex+=`\\node{root}child foreach \\a in {1,2,3}{node{a\\a}child foreach \\b in {1,2}{node{b\\b}}};\n`;break;
   case 2:tex+=`\\foreach \\n in {0,...,${8+i%7}}{\\node[circle,draw,fill=green!\\n0] (n\\n) at ({360/${9+i%7}*\\n}:2.2) {\\n};}\\foreach \\a/\\b in {0/3,1/5,2/7,3/8,4/6}{\\draw[-{Stealth}](n\\a)--(n\\b);}\n`;break;
   case 3:tex+=`\\shade[ball color=orange](0,0)circle(1);\\fill[pattern=north east lines](2,-1)rectangle(4,1);\\draw[decorate,decoration={snake,amplitude=2mm}](-2,-1.5)--(5,-1.5);\n`;break;
   default:tex+=`\\foreach \\x in {0,0.25,...,5}{\\foreach \\y in {0,0.25,...,2}{\\pgfmathtruncatemacro\\shade{10*\\x+10*\\y}\\fill[blue!\\shade](\\x,\\y)rectangle++(0.24,0.24);}}\n`;
  }
  tex+=`\\end{tikzpicture}\n\n${paragraph(2)}\n\n`;
 }
 tex+='\\end{document}\n';
 put('tikz','main.tex',tex);
}

// 5. The thesis.
{
 const dir=resolve('target/compile-benchmark/large-projects');
 if(!existsSync(join(dir,'thesis.zip')))execFileSync(process.execPath,['scripts/large-projects.mjs',dir],{stdio:['ignore','ignore','inherit']});
 for(const[path,bytes]of Object.entries(unzipSync(readFileSync(join(dir,'thesis.zip')))))if(!path.endsWith('/'))put('thesis',path,bytes);
}
console.log(JSON.stringify({event:'benchmark_docs',out,docs:['sample','article','beamer','tikz','thesis']}));
