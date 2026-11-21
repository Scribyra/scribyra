// The browser side of the compile benchmark (docs/compile-engines.md): each benchmark document
// (scripts/compile-benchmark-docs.mjs) imported as a ZIP, compiled in the app, and its PDF saved
// as <out>/<label>-<browser>/<doc>.pdf for scripts/compile-benchmark-compare.mjs. Runs only when SCRIBYRA_COMPILE_BENCHMARK names the
// output directory, e.g.
//   SCRIBYRA_COMPILE_BENCHMARK=target/compile-benchmark/out npx playwright test compile-benchmark --project chromium
// Scenarios, each SCRIBYRA_COMPILE_BENCHMARK_RUNS times (default 1; the thesis at most 3):
//   cold       the first compile in a fresh browser profile: no package cache, no project memory
//   reopen     the page reloaded and the project opened again: a new compiler, the profile's
//              package cache and whatever the app remembers about the project
//   recompile  a second compile in the same tab: the compiler and its packages are warm
// One JSON line per compile goes to <out>/<label>.jsonl (label: SCRIBYRA_BENCH_LABEL, default
// "browser"), with passes and the engine's WebAssembly memory as the app reports them.
import {test,expect} from '@playwright/test';
import {readFileSync,readdirSync,writeFileSync,mkdirSync,statSync,appendFileSync} from 'node:fs';
import {join,relative,resolve} from 'node:path';
import {zipSync} from 'fflate';

const OUT=process.env.SCRIBYRA_COMPILE_BENCHMARK,DOCS=resolve(process.env.SCRIBYRA_COMPILE_BENCHMARK_DOCS||'target/compile-benchmark/docs');
const NAMES=(process.env.SCRIBYRA_COMPILE_BENCHMARK_ONLY||'sample,article,beamer,tikz,thesis').split(',');
const LABEL=process.env.SCRIBYRA_BENCH_LABEL||'browser',SCENARIOS=(process.env.SCRIBYRA_COMPILE_BENCHMARK_SCENARIOS||'cold,reopen,recompile').split(',');
const RUNS=Number(process.env.SCRIBYRA_COMPILE_BENCHMARK_RUNS||1);
function zip(doc,browserName){
 const files={},walk=dir=>{for(const name of readdirSync(dir)){const path=join(dir,name);if(statSync(path).isDirectory())walk(path);else files[`${doc}/${relative(join(DOCS,doc),path)}`]=new Uint8Array(readFileSync(path));}};
 walk(join(DOCS,doc));mkdirSync(join(OUT,LABEL,browserName),{recursive:true});const path=join(OUT,LABEL,browserName,`${doc}.zip`);writeFileSync(path,zipSync(files));return path;
}
const saved=page=>expect(page.locator('.save-indicator')).toHaveText('Saved locally',{timeout:600000});
async function compile(page){
 await page.evaluate(()=>{window.scribyra.lastCompile=null;});
 const started=Date.now();await page.getByRole('button',{name:'Compile',exact:true}).click();
 await page.waitForFunction(()=>!!window.scribyra.lastCompile,null,{timeout:3500000,polling:250});
 const wallMs=Date.now()-started;
 const result=await page.evaluate(()=>{const r=window.scribyra.lastCompile;return{success:r.success,bytes:r.bytes,passes:r.passes,engineMemoryBytes:r.engineMemoryBytes,packages:(r.packages||[]).map(p=>p.name),log:r.success?'':String(r.log).slice(-3000)};});
 expect(result.success,result.log).toBeTruthy();
 await expect(page.getByRole('button',{name:'Compile',exact:true})).toBeVisible({timeout:600000});
 return{wallMs,passes:result.passes??null,engineMemoryMiB:result.engineMemoryBytes?Math.round(result.engineMemoryBytes/1048576):null,packages:result.packages,bytes:result.bytes};
}
async function importDoc(page,file){
 await page.goto('/');await expect(page.getByRole('heading',{name:'Your next great idea starts here.'})).toBeVisible();
 await page.evaluate(()=>navigator.serviceWorker?.ready);
 const chooser=page.waitForEvent('filechooser');await page.getByRole('button',{name:'Import ZIP',exact:true}).click();
 await (await chooser).setFiles(file);
 await expect(page.locator('.cm-content')).toBeVisible({timeout:120000});await saved(page);
}
async function reopen(page,doc){
 await page.reload();const card=page.getByRole('button',{name:new RegExp(` ${doc} \\d+ files?`)}).first();await expect(card).toBeVisible({timeout:120000});
 await card.click();await expect(page.locator('.cm-content')).toBeVisible({timeout:120000});await saved(page);
}
test.skip(!OUT,'set SCRIBYRA_COMPILE_BENCHMARK to run the compile benchmark');
for(const doc of NAMES)test(`compile benchmark in the browser: ${doc}`,async({browser,browserName},info)=>{
 const options={baseURL:info.project.use.baseURL,viewport:info.project.use.viewport};
 test.setTimeout(6*3600000);mkdirSync(join(OUT,LABEL),{recursive:true});
 const file=zip(doc,browserName),runs=doc==='thesis'?Math.min(RUNS,3):RUNS,record=(cache,run,values)=>{const line={doc,engine:LABEL,browser:browserName,cache,run,...values};appendFileSync(join(OUT,`${LABEL}.jsonl`),JSON.stringify(line)+'\n');console.log(JSON.stringify(line));};
 let last;
 // Each cold run gets its own profile; the last one is kept for the warm scenarios.
 for(let i=0;i<runs;i++){
  if(last)await last.close();
  last=await browser.newContext(options);const page=await last.newPage();await importDoc(page,file);
  if(SCENARIOS.includes('cold'))record('cold',i,await compile(page));else if(i===runs-1)await compile(page);
 }
 const page=last.pages()[0];
 if(SCENARIOS.includes('recompile'))for(let i=0;i<runs;i++)record('recompile',i,await compile(page));
 if(SCENARIOS.includes('reopen'))for(let i=0;i<runs;i++){await reopen(page,doc);record('reopen',i,await compile(page));}
 const download=page.waitForEvent('download');await page.getByRole('button',{name:'Download PDF'}).click();
 mkdirSync(join(OUT,`${LABEL}-${browserName}`),{recursive:true});await (await download).saveAs(join(OUT,`${LABEL}-${browserName}`,`${doc}.pdf`));
 await last.close();
});
