// Document templates (docs/templates.md) from Node: the catalog, compiling a template
// with the real WebAssembly engine (offline, bundled packages only), preview images,
// and the scribyra.com/templates/ page.
//   node scripts/templates.mjs previews [--only article,thesis]   compile, write <id>/preview.png
//   node scripts/templates.mjs site                                 write site/templates/
//   node scripts/templates.mjs check                                site/templates/ is current
// `previews` needs `npm run wasm` and the patched compiler assets (`npm run build` does both).
import {readFileSync,readdirSync,statSync,writeFileSync,mkdirSync,mkdtempSync,rmSync,cpSync,existsSync,copyFileSync} from 'node:fs';
import {join,relative,resolve,dirname} from 'node:path';
import {execFileSync,execFile} from 'node:child_process';
import {tmpdir,cpus} from 'node:os';
import {buildCatalog,templateLink} from '../web/template-catalog.js';

export const ROOT=resolve(new URL('..',import.meta.url).pathname);
export const TEMPLATE_DIR=join(ROOT,'templates/documents');
const SITE_DIR=join(ROOT,'site/templates');
export const PREVIEW={width:480,height:360};

function walk(dir,base=dir){
 return readdirSync(dir,{withFileTypes:true}).flatMap(entry=>{const path=join(dir,entry.name);return entry.isDirectory()?walk(path,base):entry.isFile()?[relative(base,path)]:[];});
}
/** The catalog exactly as the app builds it (web/templates.js), from the files on disk. */
export function loadCatalog(dir=TEMPLATE_DIR){
 const index=JSON.parse(readFileSync(join(dir,'index.json'),'utf8'));
 const entries=readdirSync(dir,{withFileTypes:true}).filter(entry=>entry.isDirectory()).map(entry=>({
  meta:JSON.parse(readFileSync(join(dir,entry.name,'template.json'),'utf8')),
  paths:walk(join(dir,entry.name)).filter(path=>path!=='template.json'&&path!=='preview.png'),
  folder:entry.name,
 }));
 for(const entry of entries)if(entry.meta.id!==entry.folder)throw new Error(`templates/documents/${entry.folder}: its id must match the folder name.`);
 return buildCatalog(index,entries);
}
export const templateFolder=template=>join(TEMPLATE_DIR,template.id);

/** Prepares the server's compile runtime once (scripts/wasm-compile-runtime.mjs, hard links). */
export function compileRuntime(out){
 execFileSync(process.execPath,[join(ROOT,'scripts/wasm-compile-runtime.mjs'),out,'--link'],{cwd:ROOT,stdio:'ignore'});
 return out;
}

/** Compiles one template in its own process, offline: only the bundled packages are available. */
export function compileTemplate(template,{runtime,work}){
 const dir=join(work,template.id);rmSync(dir,{recursive:true,force:true});mkdirSync(dir,{recursive:true});
 for(const path of template.files){mkdirSync(dirname(join(dir,path)),{recursive:true});copyFileSync(join(templateFolder(template),path),join(dir,path));}
 const cache=mkdtempSync(join(work,'cache-')),pdf=join(dir,'out.pdf');
 const job={work:dir,cache,mirror:join(work,'mirror-unused'),pdf};
 return new Promise(done=>execFile(process.execPath,['--max-old-space-size=4096',join(ROOT,'scripts/compile-benchmark-node.mjs'),'--one',JSON.stringify(job)],
  {cwd:ROOT,encoding:'utf8',maxBuffer:64<<20,env:{...process.env,SCRIBYRA_WASM_RUNTIME:runtime,SCRIBYRA_TEX_MIRROR:'http://127.0.0.1:9'}},(error,stdout)=>{
   rmSync(cache,{recursive:true,force:true});
   let result;try{result=JSON.parse(stdout.trim().split('\n').pop());}catch{result={status:'Crash',error:String(error?.message||error).slice(0,2000)};}
   const log=existsSync(join(dir,'out.log'))?readFileSync(join(dir,'out.log'),'utf8'):'';
   done({...result,log,pdf:existsSync(pdf)?pdf:null});
  }));
}

/** The last TeX pass of a compile log: what the person sees as the result. */
export function finalPass(log){const at=log.lastIndexOf('This is LuaHBTeX');return at<0?log:log.slice(at);}
export const texErrors=log=>finalPass(log).split('\n').filter(line=>/^! /.test(line));
export const texWarnings=log=>finalPass(log).split('\n').filter(line=>/(?:LaTeX|Package|Class) [\w-]* ?Warning|^Overfull|^Underfull/.test(line)&&!/epstopdf Warning: Shell escape/.test(line));

/** Runs at most `limit` jobs at a time. */
export async function pooled(items,limit,run){
 const results=new Array(items.length);let next=0;
 await Promise.all(Array.from({length:Math.min(limit,items.length)},async()=>{while(next<items.length){const index=next++;results[index]=await run(items[index],index);}}));
 return results;
}
export const compileConcurrency=()=>Math.max(1,Math.min(4,Math.floor(cpus().length/4)));

/**
 * The template's preview pages as one PREVIEW-sized PNG. One portrait page shows its top
 * half, readable; two pages sit side by side; four (slides) form a grid. Pages that do not
 * fill the image are centred on a transparent background, so the gallery's own colour shows.
 */
export async function renderPreview(pdfPath,pages=[1]){
 const {getDocument}=await import('pdfjs-dist/legacy/build/pdf.mjs');
 const {createCanvas}=await import('@napi-rs/canvas');
 const task=getDocument({data:new Uint8Array(readFileSync(pdfPath)),verbosity:0}),pdf=await task.promise;
 try{
  if(pages.some(number=>number>pdf.numPages))throw new Error(`The preview asks for page ${Math.max(...pages)}, but the PDF has ${pdf.numPages}.`);
  const {width,height}=PREVIEW,out=createCanvas(width,height),context=out.getContext('2d');
  const cols=pages.length===1?1:2,rows=Math.ceil(pages.length/cols),gap=pages.length===1?0:14;
  const cellWidth=(width-gap*(cols+1))/cols,cellHeight=(height-gap*(rows+1))/rows;
  for(const [index,number] of pages.entries()){
   const page=await pdf.getPage(number),base=page.getViewport({scale:1});
   const single=pages.length===1,tall=base.width/base.height<cellWidth/cellHeight;
   // A single tall page fills the width and is cut at the bottom; everything else fits whole.
   const scale=single&&tall?cellWidth/base.width:Math.min(cellWidth/base.width,cellHeight/base.height);
   const viewport=page.getViewport({scale:scale*2}),rendered=createCanvas(Math.ceil(viewport.width),Math.ceil(viewport.height));
   await page.render({canvas:rendered,canvasContext:rendered.getContext('2d'),viewport,background:'#ffffff'}).promise;
   const drawWidth=base.width*scale,drawHeight=base.height*scale,col=index%cols,row=Math.floor(index/cols);
   const x=gap+col*(cellWidth+gap)+(cellWidth-drawWidth)/2,y=single&&tall?0:gap+row*(cellHeight+gap)+(cellHeight-drawHeight)/2;
   context.save();
   if(!single){context.shadowColor='rgba(20,24,41,0.28)';context.shadowBlur=8;context.shadowOffsetY=2;}
   context.drawImage(rendered,Math.round(x),Math.round(y),Math.round(drawWidth),Math.round(drawHeight));
   context.restore();
  }
  return {png:out.toBuffer('image/png'),pages:pdf.numPages};
 }finally{await task.destroy();}
}

/** Counts the pages of a PDF. */
export async function pageCount(pdfPath){
 const {getDocument}=await import('pdfjs-dist/legacy/build/pdf.mjs');
 const task=getDocument({data:new Uint8Array(readFileSync(pdfPath)),verbosity:0}),pdf=await task.promise;
 try{return pdf.numPages;}finally{await task.destroy();}
}

const escape=text=>String(text).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');

/** scribyra.com/templates/: every template with its preview and an Open in Scribyra link. */
export function sitePage(catalog){
 const sections=catalog.categories.map(category=>{
  const items=catalog.templates.filter(template=>template.category===category.id);
  if(!items.length)return '';
  return `
    <section class="template-section" aria-labelledby="category-${category.id}">
      <h2 id="category-${category.id}">${escape(category.name)}</h2>
      <ul class="template-list">${items.map(template=>`
        <li class="template-item" id="${template.id}">
          <img src="previews/${template.id}.png" width="${PREVIEW.width}" height="${PREVIEW.height}" loading="lazy" alt="First page of the ${escape(template.name)} template.">
          <div class="template-text">
            <h3>${escape(template.name)}</h3>
            <p>${escape(template.description)}</p>
            <a class="button small primary" href="${escape(templateLink(template.id))}" aria-label="Open ${escape(template.name)} in Scribyra">Open in Scribyra <span aria-hidden="true">↗</span></a>
          </div>
        </li>`).join('')}
      </ul>
    </section>`;
 }).join('');
 return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="description" content="Free LaTeX templates for papers, reports, theses, books, slides, posters, CVs and coursework. Open one in Scribyra and compile it in your browser.">
  <meta name="theme-color" content="#7160d9">
  <meta name="color-scheme" content="light dark">
  <title>LaTeX templates — Scribyra</title>
  <link rel="icon" href="../assets/mark.svg" type="image/svg+xml">
  <link rel="stylesheet" href="../style.css">
</head>
<body class="adaptive">
  <!-- Generated by scripts/templates.mjs from templates/documents/. Edit those, then run: node scripts/templates.mjs site -->
  <a class="skip" href="#main">Skip to content</a>
  <header class="header wrap">
    <a class="brand" href="../" aria-label="Scribyra home"><span class="brand-mark">s</span>scribyra</a>
    <nav aria-label="Main navigation"><a href="../#workspace">Workspace</a><a href="./" aria-current="page">Templates</a><a href="../coming-from-overleaf.html">Coming from Overleaf?</a></nav>
    <a class="button small secondary github-link" href="https://github.com/Scribyra/scribyra" aria-label="Source code on GitHub"><svg class="github-mark" viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 19.5c-4 1.2-4-2-5.6-2.4M15 21v-3.3c0-1 .1-1.5-.5-2.1 2.7-.3 5.5-1.3 5.5-5.9 0-1.2-.4-2.3-1.2-3.1.1-.4.5-1.6-.1-3.2 0 0-1-.3-3.3 1.2a11.4 11.4 0 0 0-6 0C7.1 3.1 6.1 3.4 6.1 3.4c-.6 1.6-.2 2.8-.1 3.2-.8.8-1.2 1.9-1.2 3.1 0 4.6 2.8 5.6 5.5 5.9-.4.4-.6 1-.6 1.7V21"/></svg>GitHub <span aria-hidden="true">↗</span></a>
  </header>
  <main id="main" class="wrap templates-page">
    <div class="page-intro">
      <div class="eyebrow">TEMPLATES</div>
      <h1>Start from a template.<br><em>Make it yours.</em></h1>
      <p class="intro">Written by the Scribyra project and free to use for anything. Each one compiles with the packages built into Scribyra, so it works offline after the first compile. Comments in the source explain what to change.</p>
      <p class="quiet">Choosing <strong>Open in Scribyra</strong> opens the app with that template selected. Nothing is created until you choose <strong>Create project</strong>, and the project stays in your browser. In the app, the same templates are under <strong>New project</strong>.</p>
    </div>${sections}
    <section class="template-note" aria-labelledby="journal-classes">
      <h2 id="journal-classes">Journal and conference classes</h2>
      <p>Publisher classes such as IEEEtran, acmart, elsarticle or llncs are not bundled yet. They are in the TeX catalog, so a document that uses them downloads the class from a TeX Live mirror the first time it compiles. Use the publisher’s own template, upload it as a ZIP, and compile.</p>
    </section>
  </main>
  <footer class="footer wrap"><a class="brand" href="../"><span class="brand-mark">s</span>scribyra</a><span>A little more possibility.</span><div><a href="mailto:contact@scribyra.com">Contact</a><a href="../privacy.html">Privacy</a><a href="../licenses.html">Licences</a><a href="https://github.com/Scribyra/scribyra">Source ↗</a></div><p class="legal"><span>© 2026 URUNDEAD LABS S.R.L.</span> · <span>Reg. Com. J2026034271001</span> · <span>CUI 54762154</span> · <span>VAT RO55538423</span> · <span>Strada Pitar Moș 27, et. 5, ap. 17,</span> <span>010452 București, Romania</span></p></footer>
</body>
</html>
`;
}

function siteFiles(catalog){
 const files=new Map([['index.html',Buffer.from(sitePage(catalog))]]);
 for(const template of catalog.templates){
  const preview=join(templateFolder(template),'preview.png');
  if(!existsSync(preview))throw new Error(`templates/documents/${template.id}/preview.png is missing; run node scripts/templates.mjs previews --only ${template.id}`);
  files.set(`previews/${template.id}.png`,readFileSync(preview));
 }
 return files;
}
/** Paths under site/templates/ that differ from what the catalog generates. */
export function staleSiteFiles(catalog=loadCatalog()){
 const expected=siteFiles(catalog),stale=[];
 for(const [path,bytes]of expected){const file=join(SITE_DIR,path);if(!existsSync(file)||!readFileSync(file).equals(bytes))stale.push(path);}
 if(existsSync(SITE_DIR))for(const path of walk(SITE_DIR))if(!expected.has(path))stale.push(path);
 return stale;
}
function writeSite(catalog){
 rmSync(SITE_DIR,{recursive:true,force:true});
 for(const [path,bytes]of siteFiles(catalog)){mkdirSync(dirname(join(SITE_DIR,path)),{recursive:true});writeFileSync(join(SITE_DIR,path),bytes);}
}

async function previews(only){
 const catalog=loadCatalog(),chosen=catalog.templates.filter(template=>!only||only.includes(template.id));
 const work=mkdtempSync(join(tmpdir(),'scribyra-template-previews-'));
 try{
  const runtime=compileRuntime(join(work,'runtime'));let failed=0;
  await pooled(chosen,compileConcurrency(),async template=>{
   const result=await compileTemplate(template,{runtime,work});
   const errors=texErrors(result.log);
   if(result.status!=='Success'||!result.pdf||errors.length){failed++;console.error(`${template.id}: ${result.status} ${result.error||''}\n${errors.join('\n')}`);return;}
   const {png,pages}=await renderPreview(result.pdf,template.preview);
   writeFileSync(join(templateFolder(template),'preview.png'),png);
   const warnings=texWarnings(result.log);
   console.log(JSON.stringify({template:template.id,pages,passes:result.passes,seconds:Math.round(result.wallMs/1000),warnings:warnings.length,previewBytes:png.length}));
   for(const warning of warnings)console.log(`  ${warning}`);
  });
  if(failed)process.exitCode=1;
 }finally{rmSync(work,{recursive:true,force:true});}
}

if(process.argv[1]===new URL(import.meta.url).pathname){
 const [command,...rest]=process.argv.slice(2),at=rest.indexOf('--only'),only=at>=0?rest[at+1].split(','):null;
 if(command==='previews')await previews(only);
 else if(command==='site'){writeSite(loadCatalog());console.log('Wrote site/templates/.');}
 else if(command==='check'){const stale=staleSiteFiles();if(stale.length){console.error(`site/templates/ is out of date (${stale.join(', ')}). Run: node scripts/templates.mjs site`);process.exitCode=1;}else console.log('site/templates/ is current.');}
 else{console.error('Usage: node scripts/templates.mjs previews [--only id,id] | site | check');process.exitCode=2;}
}
