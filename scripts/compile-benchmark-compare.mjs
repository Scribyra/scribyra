// Output equality for the compile-engine benchmark (docs/compile-engines.md): page count and
// extracted text (pdf.js, as the app's viewer reads it) of the same documents compiled by the
// WebAssembly engine on the server, native TeX Live on the server and the browser.
//   node scripts/compile-benchmark-compare.mjs <out-dir>     (reads <out-dir>/<engine>/<doc>.pdf)
import {readFileSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {getDocument} from 'pdfjs-dist/legacy/build/pdf.mjs';

const out=process.argv[2]||'target/compile-benchmark/out';
const engines=['wasm','browser','native'],docs=['sample','article','beamer','tikz','thesis'];
async function read(path){
 const pdf=await getDocument({data:new Uint8Array(readFileSync(path)),verbosity:0}).promise,pages=[];
 for(let i=1;i<=pdf.numPages;i++){const page=await pdf.getPage(i);pages.push((await page.getTextContent()).items.map(item=>item.str).join(' ').replace(/\s+/g,' ').trim());}
 await pdf.destroy();return pages;
}
// Shared words over all words (multisets): 1 when the texts hold the same words.
function overlap(a,b){
 const count=words=>{const m=new Map();for(const w of words)m.set(w,(m.get(w)||0)+1);return m;};
 const wa=a.join(' ').split(' ').filter(Boolean),wb=b.join(' ').split(' ').filter(Boolean),ca=count(wa),cb=count(wb);let shared=0;
 for(const[w,n]of ca)shared+=Math.min(n,cb.get(w)||0);
 return shared/Math.max(wa.length,wb.length,1);
}
const rows=[];
for(const doc of docs){
 const texts={};
 for(const engine of engines){const path=join(out,engine,`${doc}.pdf`);if(existsSync(path))texts[engine]=await read(path);}
 const row={doc,pages:Object.fromEntries(Object.entries(texts).map(([e,t])=>[e,t.length]))};
 for(const[a,b]of [['wasm','browser'],['wasm','native'],['browser','native']]){
  if(!texts[a]||!texts[b])continue;
  const same=texts[a].join('\f')===texts[b].join('\f');
  row[`${a}~${b}`]={identicalText:same,wordOverlap:Math.round(overlap(texts[a],texts[b])*10000)/10000,pagesWithSameText:texts[a].filter((t,i)=>t===texts[b][i]).length};
 }
 rows.push(row);console.log(JSON.stringify(row));
}
