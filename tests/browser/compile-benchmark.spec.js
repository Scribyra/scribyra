// The browser side of the compile-engine benchmark (docs/compile-engines.md): each benchmark
// document (scripts/compile-benchmark-docs.mjs) imported as a ZIP, compiled in the app, and its
// PDF saved for scripts/compile-benchmark-compare.mjs. Runs only when SCRIBYRA_COMPILE_BENCHMARK
// names the output directory, e.g.
//   SCRIBYRA_COMPILE_BENCHMARK=target/compile-benchmark/out npx playwright test compile-benchmark --project chromium
import {test,expect} from '@playwright/test';
import {readFileSync,readdirSync,writeFileSync,mkdirSync,statSync} from 'node:fs';
import {join,relative,resolve} from 'node:path';
import {zipSync} from 'fflate';

const OUT=process.env.SCRIBYRA_COMPILE_BENCHMARK,DOCS=resolve(process.env.SCRIBYRA_COMPILE_BENCHMARK_DOCS||'target/compile-benchmark/docs');
const NAMES=(process.env.SCRIBYRA_COMPILE_BENCHMARK_ONLY||'sample,article,beamer,tikz,thesis').split(',');
function zip(doc){
 const files={},walk=dir=>{for(const name of readdirSync(dir)){const path=join(dir,name);if(statSync(path).isDirectory())walk(path);else files[`${doc}/${relative(join(DOCS,doc),path)}`]=new Uint8Array(readFileSync(path));}};
 walk(join(DOCS,doc));const path=join(OUT,'browser',`${doc}.zip`);writeFileSync(path,zipSync(files));return path;
}
test.skip(!OUT,'set SCRIBYRA_COMPILE_BENCHMARK to run the compile benchmark');
for(const doc of NAMES)test(`compile benchmark in the browser: ${doc}`,async({page,browserName})=>{
 test.setTimeout(3600000);mkdirSync(join(OUT,'browser'),{recursive:true});
 await page.goto('/');await expect(page.getByRole('heading',{name:'Your next great idea starts here.'})).toBeVisible();
 await page.evaluate(()=>navigator.serviceWorker?.ready);
 const chooser=page.waitForEvent('filechooser');await page.getByRole('button',{name:'Import ZIP',exact:true}).click();
 await (await chooser).setFiles(zip(doc));
 await expect(page.locator('.cm-content')).toBeVisible({timeout:120000});
 const runs=[];
 for(let i=0;i<Number(process.env.SCRIBYRA_COMPILE_BENCHMARK_RUNS||1);i++){
  await page.evaluate(()=>{window.scribyra.lastCompile=null;});
  const started=Date.now();await page.getByRole('button',{name:'Compile',exact:true}).click();
  await page.waitForFunction(()=>!!window.scribyra.lastCompile,null,{timeout:3500000,polling:250});
  const result=await page.evaluate(()=>{const r=window.scribyra.lastCompile;return{success:r.success,bytes:r.bytes,log:r.success?'':String(r.log).slice(-3000)};});
  expect(result.success,result.log).toBeTruthy();runs.push({run:i,wallMs:Date.now()-started,bytes:result.bytes});
 }
 const download=page.waitForEvent('download');await page.getByRole('button',{name:'Download PDF'}).click();
 await (await download).saveAs(join(OUT,'browser',`${doc}.pdf`));
 writeFileSync(join(OUT,'browser',`${doc}.json`),JSON.stringify({doc,browser:browserName,runs})+'\n');
});
