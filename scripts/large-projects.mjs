#!/usr/bin/env node
// Deterministic large projects for the beta performance measurements
// (docs/large-projects.md). Everything is generated: prose from a fixed
// vocabulary, equations, tables, PNG/PDF figures and BibTeX entries. No
// copyrighted text is used.
//
//   node scripts/large-projects.mjs [outDir]     (default tmp/large-projects; Playwright clears test-results)
//
// Writes thesis.zip, long-file.zip and heavy-history.scribyra-backup, plus
// manifest.json with their sizes. The heavy-history backup is produced by the
// app's own storage, comment, review and history modules (web/pkg must be
// built: `npm run wasm` or `npm run build`).
import {mkdirSync,writeFileSync,readFileSync} from 'node:fs';
import {deflateSync,crc32} from 'node:zlib';
import {join,resolve} from 'node:path';
import {zipSync,strToU8} from 'fflate';

const out=resolve(process.argv[2]||'tmp/large-projects');
mkdirSync(out,{recursive:true});

// mulberry32: small, fast and fully deterministic.
function rng(seed){return()=>{seed|=0;seed=seed+0x6D2B79F5|0;let t=Math.imul(seed^seed>>>15,1|seed);t=t+Math.imul(t^t>>>7,61|t)^t;return((t^t>>>14)>>>0)/4294967296;};}
const pick=(r,list)=>list[Math.floor(r()*list.length)];
const int=(r,lo,hi)=>lo+Math.floor(r()*(hi-lo+1));

const nouns=['model','sample','boundary','estimate','signal','surface','network','gradient','dataset','protocol','sensor','interval','manifold','operator','kernel','spectrum','measurement','variance','threshold','layer','domain','solution','approximation','experiment','framework','parameter','sequence','structure','observation','response','controller','matrix','pipeline','prototype','calibration','channel','cluster','residual','trajectory','baseline'];
const adjectives=['robust','linear','stochastic','adaptive','empirical','discrete','nonlinear','sparse','stable','coherent','reproducible','bounded','periodic','latent','smooth','consistent','efficient','partial','global','local','asymptotic','thermal','numerical','structural','temporal'];
const verbs=['improves','reduces','constrains','describes','predicts','approximates','reveals','supports','determines','limits','extends','stabilises','captures','separates','preserves','measures','controls','dominates','follows','exceeds'];
const adverbs=['consistently','markedly','slightly','substantially','only partially','in most cases','under mild assumptions','for small perturbations','across all runs','within the reported tolerance'];
const connectors=['However,','Moreover,','In contrast,','As a consequence,','Similarly,','In practice,','For this reason,','Taken together,','Nevertheless,','In particular,'];
function sentence(r){
  const s=`the ${pick(r,adjectives)} ${pick(r,nouns)} ${pick(r,verbs)} the ${pick(r,adjectives)} ${pick(r,nouns)} ${pick(r,adverbs)}`;
  const tail=r()<0.35?`, while the ${pick(r,nouns)} of the ${pick(r,nouns)} remains ${pick(r,adjectives)}`:'';
  const lead=r()<0.25?pick(r,connectors)+' ':'';
  const body=lead?s:s[0].toUpperCase()+s.slice(1);
  return `${lead}${body}${tail}.`;
}
function paragraph(r,sentences,extra=()=>''){let p=[];for(let i=0;i<sentences;i++){p.push(sentence(r));const e=extra(i);if(e)p.push(e);}return p.join(' ');}

// ---------- images ----------
function pngChunk(type,data){const head=Buffer.alloc(8);head.writeUInt32BE(data.length,0);head.write(type,4,'ascii');const crc=Buffer.alloc(4);crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4),data])),0);return Buffer.concat([head,data,crc]);}
/** An RGB "measurement map": smooth field plus sensor noise, so it compresses like a real image. */
function png(seed,width,height,noise){
  const r=rng(seed),fx=1+r()*5,fy=1+r()*5,phase=r()*6.28,raw=Buffer.alloc((width*3+1)*height);let o=0;
  for(let y=0;y<height;y++){raw[o++]=0;for(let x=0;x<width;x++){
    const v=0.5+0.25*Math.sin(fx*x/width*6.28+phase)*Math.cos(fy*y/height*6.28)+0.25*Math.sin((x+y)/(width/3));
    for(let c=0;c<3;c++){const n=(r()-0.5)*noise;raw[o++]=Math.max(0,Math.min(255,Math.round(255*(v*(0.6+0.2*c))+n)));}
  }}
  const ihdr=Buffer.alloc(13);ihdr.writeUInt32BE(width,0);ihdr.writeUInt32BE(height,4);ihdr[8]=8;ihdr[9]=2;
  return new Uint8Array(Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),pngChunk('IHDR',ihdr),pngChunk('IDAT',deflateSync(raw,{level:6})),pngChunk('IEND',Buffer.alloc(0))]));
}
/** A one-page vector line chart. */
function pdfFigure(seed){
  const r=rng(seed);let y=150,path='0.2 0.3 0.7 RG 1.2 w 40 150 m ';
  for(let x=40;x<=400;x+=3){y=Math.max(30,Math.min(270,y+(r()-0.5)*18));path+=`${x} ${y.toFixed(1)} l `;}
  const content=`0 0 0 RG 0.8 w 40 30 m 400 30 l S 40 30 m 40 270 l S ${path}S BT /F1 9 Tf 180 10 Td (generated series ${seed}) Tj ET`;
  const objects=['<< /Type /Catalog /Pages 2 0 R >>','<< /Type /Pages /Kids [3 0 R] /Count 1 >>','<< /Type /Page /Parent 2 0 R /MediaBox [0 0 420 290] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',`<< /Length ${content.length} >>\nstream\n${content}\nendstream`,'<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
  let pdf='%PDF-1.4\n';const offsets=[];
  objects.forEach((body,i)=>{offsets.push(pdf.length);pdf+=`${i+1} 0 obj\n${body}\nendobj\n`;});
  const xref=pdf.length;pdf+=`xref\n0 ${objects.length+1}\n0000000000 65535 f \n`+offsets.map(o=>String(o).padStart(10,'0')+' 00000 n \n').join('')+`trailer\n<< /Size ${objects.length+1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return strToU8(pdf);
}

// ---------- bibliography ----------
const surnames=['Achterberg','Bianchi','Castillo','Dumitrescu','Eriksen','Fujita','Gonzalez','Haddad','Ivanova','Jensen','Kowalski','Laurent','Moreau','Novak','Okafor','Petrescu','Quist','Rahman','Schneider','Tanaka','Ueda','Vasquez','Weber','Xu','Yilmaz','Zhou'];
const given=['A.','B.','C.','D.','E.','F.','G.','H.','I.','J.','K.','L.','M.','N.'];
function bibliography(r,count){
  const keys=[],entries=[];
  for(let i=0;i<count;i++){
    const key=`ref${String(i+1).padStart(3,'0')}`;keys.push(key);
    const authors=Array.from({length:int(r,1,4)},()=>`${pick(r,surnames)}, ${pick(r,given)}`).join(' and ');
    const title=`On the ${pick(r,adjectives)} ${pick(r,nouns)} of ${pick(r,adjectives)} ${pick(r,nouns)}s`;
    const year=int(r,1975,2025),kind=i%3;
    if(kind===0)entries.push(`@article{${key},\n  author = {${authors}},\n  title = {${title}},\n  journal = {Journal of ${pick(r,adjectives)[0].toUpperCase()+pick(r,adjectives).slice(1)} ${pick(r,nouns)[0].toUpperCase()}${pick(r,nouns).slice(1)}s},\n  year = {${year}},\n  volume = {${int(r,1,80)}},\n  number = {${int(r,1,12)}},\n  pages = {${int(r,1,400)}--${int(r,401,800)}},\n  doi = {10.0000/generated.${i+1}}\n}`);
    else if(kind===1)entries.push(`@book{${key},\n  author = {${authors}},\n  title = {${title}},\n  publisher = {Generated Press},\n  address = {Nowhere},\n  year = {${year}},\n  edition = {${int(r,1,4)}}\n}`);
    else entries.push(`@inproceedings{${key},\n  author = {${authors}},\n  title = {${title}},\n  booktitle = {Proceedings of the ${int(r,1,40)}th Workshop on ${pick(r,adjectives)} ${pick(r,nouns)}s},\n  year = {${year}},\n  pages = {${int(r,1,200)}--${int(r,201,300)}}\n}`);
  }
  return {keys,text:entries.join('\n\n')+'\n'};
}

// ---------- thesis ----------
const chapterNames=['introduction','background','related-work','methodology','theory','implementation','experiments','results','discussion','case-study','limitations','conclusion'];
function thesis(){
  const r=rng(2026),files={},bib=bibliography(r,400);files['references.bib']=strToU8(bib.text);
  let citeIndex=0,figure=0,table=0;const nextCite=()=>bib.keys[citeIndex++%bib.keys.length];
  let pngBytes=0,pdfBytes=0;
  for(let c=0;c<12;c++){
    const dir=`chapters/${String(c+1).padStart(2,'0')}-${chapterNames[c]}`,ch=`ch${c+1}`;let tex=`% Chapter ${c+1}: generated text for performance measurement.\n\\chapter{${chapterNames[c].replace('-',' ').replace(/^./,s=>s.toUpperCase())}}\\label{${ch}}\n\n`;
    for(let s=0;s<9;s++){
      tex+=`\\section{${pick(r,adjectives).replace(/^./,x=>x.toUpperCase())} ${pick(r,nouns)}s}\\label{sec:${ch}-${s}}\n\n`;
      for(let p=0;p<12;p++){
        tex+=`% NOTE(${ch}.${s}.${p}): ${paragraph(r,2)}\n`;
        tex+=paragraph(r,int(r,6,9),i=>i===2?`See~\\cite{${nextCite()},${nextCite()}} and Section~\\ref{sec:${ch}-${int(r,0,s)}}.`:'')+'\n\n';
        if(p===3){tex+=`\\begin{equation}\\label{eq:${ch}-${s}}\n  \\mathcal{L}_{${s}}(\\theta) = \\sum_{i=1}^{N} \\left( y_i - f_\\theta(x_i) \\right)^2 + \\lambda_{${c}} \\int_{\\Omega} \\lVert \\nabla f_\\theta \\rVert^2 \\, \\mathrm{d}x\n\\end{equation}\nEquation~\\eqref{eq:${ch}-${s}} ${paragraph(r,2)}\n\n\\begin{align}\n  a_{${s}} &= \\frac{\\partial \\mathcal{L}}{\\partial \\theta_{${s}}} + \\alpha \\sum_{k=0}^{\\infty} \\frac{x^k}{k!} \\\\\n  b_{${s}} &= \\int_0^1 e^{-t^2} \\cos(${s+1}\\pi t) \\, \\mathrm{d}t\n\\end{align}\n\n`;}
        if(p===5&&s<5){
          figure++;const pdfFig=figure%10===0,name=`figures/${ch}/figure-${String(figure).padStart(2,'0')}.${pdfFig?'pdf':'png'}`;
          const bytes=pdfFig?pdfFigure(figure):png(figure,620,420,60);files[name]=bytes;pdfFig?pdfBytes+=bytes.length:pngBytes+=bytes.length;
          tex+=`\\begin{figure}[htbp]\n  \\centering\n  \\includegraphics[width=0.8\\linewidth]{${name}}\n  \\caption{Generated ${pick(r,adjectives)} ${pick(r,nouns)} map number ${figure}.}\\label{fig:${figure}}\n\\end{figure}\nFigure~\\ref{fig:${figure}} ${paragraph(r,2)}\n\n`;
        }
        if(p===7&&s%3===0){
          table++;tex+=`\\begin{table}[htbp]\n  \\centering\n  \\caption{Generated results table ${table}.}\\label{tab:${table}}\n  \\begin{tabular}{lSSS}\n    \\toprule\n    {Configuration} & {Mean (\\si{\\milli\\second})} & {Error (\\si{\\percent})} & {Size (\\si{\\mega\\byte})} \\\\\n    \\midrule\n`;
          for(let row=0;row<8;row++)tex+=`    ${pick(r,adjectives)} ${pick(r,nouns)} & ${(r()*900).toFixed(2)} & ${(r()*10).toFixed(3)} & ${(r()*64).toFixed(1)} \\\\\n`;
          tex+=`    \\bottomrule\n  \\end{tabular}\n\\end{table}\nTable~\\ref{tab:${table}} reports \\num{${int(r,1000,99999)}} runs at \\SI{${(r()*5).toFixed(2)}}{\\giga\\hertz}. ${paragraph(r,2)}\n\n`;
        }
      }
    }
    tex+=c>0?`Compare Chapter~\\ref{ch${c}} and Figure~\\ref{fig:${Math.max(1,figure-3)}}.\n`:'';
    files[`${dir}/chapter.tex`]=strToU8(tex);
  }
  // Cite every entry so the bibliography carries all 400 records.
  files['chapters/appendix.tex']=strToU8(`\\chapter{Further reading}\\label{app:reading}\n${paragraph(r,4)}\n\\nocite{*}\n`);
  const main=`\\documentclass[11pt,a4paper,oneside]{report}
\\usepackage[margin=2.2cm]{geometry}
\\usepackage{amsmath,amssymb}
\\usepackage{graphicx}
\\usepackage{booktabs}
\\usepackage{siunitx}
\\usepackage[backend=biber,style=numeric,sorting=none]{biblatex}
\\addbibresource{references.bib}
\\usepackage{hyperref}
\\title{A Generated Thesis on Reproducible Measurement}
\\author{Generated Author}
\\date{2026}
\\begin{document}
\\maketitle
\\tableofcontents
\\listoffigures
\\listoftables
${chapterNames.map((name,i)=>`\\input{chapters/${String(i+1).padStart(2,'0')}-${name}/chapter}`).join('\n')}
\\appendix
\\input{chapters/appendix}
\\printbibliography[heading=bibintoc]
\\end{document}
`;
  files['main.tex']=strToU8(main);
  return {files,pngBytes,pdfBytes,figures:figure,tables:table,bibEntries:bib.keys.length};
}

// ---------- long single file ----------
function longFile(target=3*1024*1024){
  const r=rng(77);let tex='\\documentclass{article}\n\\usepackage{amsmath}\n\\begin{document}\n',section=0;
  const end='\\end{document}\n';
  while(tex.length<target-end.length-4000){
    section++;tex+=`\n\\section{Generated section ${section}}\\label{sec:${section}}\n`;
    for(let p=0;p<6&&tex.length<target-end.length-4000;p++){tex+=paragraph(r,int(r,4,8))+'\n\n';if(p===3)tex+=`\\begin{equation}\n  E_{${section}} = \\sum_{k=1}^{${section%9+2}} \\frac{x_k^2}{k} \\label{eq:${section}}\n\\end{equation}\n\n`;}
  }
  while(tex.length<target-end.length){const room=target-end.length-tex.length;tex+=room>12?`% padding ${'.'.repeat(Math.min(70,room-11))}\n`:'%'.repeat(room-1)+'\n';}
  tex+=end;
  return {files:{'main.tex':strToU8(tex)},sections:section};
}

/** JSON records with byte fields moved into one binary file: {"$bytes":[offset,length]}. */
function writeDump(base,data){
  const parts=[];let offset=0;
  const json=JSON.stringify(data,(key,value)=>{if(value instanceof Uint8Array){parts.push(value);const ref={$bytes:[offset,value.length]};offset+=value.length;return ref;}return value;});
  writeFileSync(base+'.json',json);writeFileSync(base+'.bin',Buffer.concat(parts));
}
function zip(files){
  // Fixed timestamps keep the archive byte-identical between runs.
  const entries={};for(const [path,bytes] of Object.entries(files))entries[path]=[bytes,{mtime:new Date(2026,0,1),level:/\.(png|pdf)$/.test(path)?0:6}];
  return zipSync(entries);
}

const manifest={generatedBy:'scripts/large-projects.mjs'};
{
  const t=thesis(),bytes=zip(t.files);writeFileSync(join(out,'thesis.zip'),bytes);
  const source=Object.entries(t.files).filter(([p])=>/\.(tex|bib)$/.test(p)).reduce((s,[,b])=>s+b.length,0);
  manifest.thesis={zipBytes:bytes.length,files:Object.keys(t.files).length,sourceBytes:source,texBytes:Object.entries(t.files).filter(([p])=>p.endsWith('.tex')).reduce((s,[,b])=>s+b.length,0),imageBytes:t.pngBytes+t.pdfBytes,pngBytes:t.pngBytes,pdfBytes:t.pdfBytes,figures:t.figures,tables:t.tables,bibEntries:t.bibEntries,chapters:12,expandedBytes:Object.values(t.files).reduce((s,b)=>s+b.length,0)};
}
{
  const l=longFile(),bytes=zip(l.files);writeFileSync(join(out,'long-file.zip'),bytes);
  manifest.longFile={zipBytes:bytes.length,texBytes:l.files['main.tex'].length,lines:new TextDecoder().decode(l.files['main.tex']).split('\n').length,sections:l.sections};
}
if(!process.env.SKIP_HISTORY){
  const {heavyHistory}=await import('./large-projects-history.mjs');
  const h=await heavyHistory(rng(5000),{paragraph,sentence,png},{dump:true});
  if(h.backup)writeFileSync(join(out,'heavy-history.scribyra-backup'),h.backup);
  // The stored records themselves, so a browser can be seeded even when a
  // complete backup of this history cannot be exported.
  writeDump(join(out,'heavy-history.idb'),h.raw);
  manifest.heavyHistory={backupBytes:h.backup?.length??null,...h.summary};
}
writeFileSync(join(out,'manifest.json'),JSON.stringify(manifest,null,2)+'\n');
console.log(JSON.stringify(manifest,null,2));
