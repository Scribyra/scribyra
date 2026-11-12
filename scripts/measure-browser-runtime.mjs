// Public synthetic input, disposable profiles, loopback HTTP without compression.
// Run after npm run build. Does not open an existing user profile/project.
import {chromium,firefox,webkit} from '@playwright/test';
import {readFile,writeFile,mkdir,readdir} from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import {createHash} from 'node:crypto';
import {cpus,platform,release,totalmem} from 'node:os';
import {dirname} from 'node:path';
import {execFileSync} from 'node:child_process';
import {zipSync,strToU8} from 'fflate';
import {assetServer} from '../tests/helpers/asset-server.mjs';
import {sampleProcessMemory} from './measure-browser/process-memory.mjs';
import {sampleWorkerHeap} from './measure-browser/worker-heap.mjs';
import {texRuntimeIdentity} from './tex-environment.mjs';

const args=Object.fromEntries(process.argv.slice(2).map(arg=>arg.replace(/^--/,'').split('=')));
const browsers=(args.browser||'chromium,firefox,webkit').split(','),modes=(args.mode||'original,baseline,app').split(','),runs=Number(args.runs||3);
if(platform()!=='linux'||!Number.isSafeInteger(runs)||runs<1||runs>10||browsers.some(b=>!['chromium','firefox','webkit'].includes(b))||modes.some(m=>!['original','baseline','app'].includes(m)))throw new Error('Use Linux, --browser=chromium,firefox,webkit --mode=original,baseline,app --runs=1..10.');
const root='public/core/busytex/',manifest=JSON.parse(await readFile(root+'lualatex-manifest.json')),recipe=JSON.parse(await readFile('scripts/lualatex-baseline.json'));
for(const[path,expected]of [['texlive-extra.js',recipe.sourceJsSha256],['texlive-extra.data',recipe.sourceDataSha256]]){const hash=createHash('sha256');for await(const chunk of createReadStream(root+path))hash.update(chunk);if(hash.digest('hex')!==expected)throw new Error('Original collection differs from its pinned input.');}
const probe=await readFile('scripts/measure-browser/probe.js','utf8'),responses={'/__measure/harness.html':await readFile('scripts/measure-browser/harness.html','utf8')};
const workerPaths=(await readdir('dist/assets')).filter(name=>/^(?:tex-packages|workspace)-worker-.*\.js$/.test(name)).map(name=>'/assets/'+name);
for(const path of workerPaths)responses[path]=`globalThis.__scribyraMeasurementKind=${JSON.stringify(path.includes('tex-packages')?'packages':'workspace')};\n`+probe+'\n'+await readFile('dist'+path,'utf8');
const server=await assetServer({keepAlive:true,responses,extraFiles:{'/__measure/runner.js':'node_modules/texlyre-busytex/dist/index.js','/core/busytex/texlive-extra.js':root+'texlive-extra.js','/core/busytex/texlive-extra.data':root+'texlive-extra.data'}});
const source=String.raw`\documentclass{article}\usepackage{amsmath}\begin{document}A reproducible compiler measurement. $E=mc^2$.\end{document}`;
const results=[],output=args.output||'tmp/browser-runtime-measurements.json';
async function workerMemory(worker){try{return await worker.evaluate(async()=>{
 const p=globalThis.__scribyraMemoryProbe,memories=[...new Set(p?.instances.map(ref=>ref.deref()).filter(Boolean)||[])];
 const compiler=globalThis.pipeline?.Module?await globalThis.pipeline.Module:null;
 return{kind:globalThis.__scribyraMeasurementKind||'unknown',compilerLinearBytes:compiler?.HEAPU8?.byteLength,liveLinearBytes:memories.reduce((sum,m)=>sum+m.buffer.byteLength,0),peakIndividualLinearBytes:Math.max(p?.peakIndividualBytes||0,...memories.map(m=>m.buffer.byteLength)),instances:memories.length,growths:p?.growths||[]};
 });}catch(error){return{error:error.message};}}
async function compileApp(page){await page.evaluate(()=>window.scribyra.lastCompile=null);const start=Date.now();await page.getByRole('button',{name:/^Compile(?: |$)/}).click();await page.waitForFunction(()=>Boolean(window.scribyra.lastCompile),{timeout:200000});return page.evaluate(start=>{const r=window.scribyra.lastCompile;return{success:r.success,pdfBytes:r.bytes,durationMs:Date.now()-start,compilerDurationMs:r.durationMs,issueCodes:r.report?.issues.map(i=>i.code),log:r.success?undefined:r.log};},start);}
async function save(){await mkdir(dirname(output),{recursive:true});await writeFile(output,JSON.stringify({version:1,measuredAt:new Date().toISOString(),revision:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),runtime:texRuntimeIdentity(),host:{platform:platform(),kernel:release(),cpu:cpus()[0].model,logicalCpus:cpus().length,totalMemory:totalmem()},methodology:{scope:'Synthetic article; independent fresh browser processes/profiles per trial. Original/baseline use identical current wrappers and SDK without Scribyra shell/cache; app measures complete current application including verification/storage. Original is the pinned texlive-extra collection, not a historical editor build.',network:'Server response body bytes actually written over uncompressed loopback HTTP, including service-worker precaching. Excludes headers/TLS; warm/offline phases are separate. The server refuses all connections during offline reload/compile in addition to Playwright offline mode. Browser-managed update attempts are recorded as blocked. Not compressed internet transfer or timing.',memory:'Linux process tree sampled every 250 ms from status and smaps_rollup; RSS double-counts shared pages, PSS proportions them. Peaks are observed lower bounds, not exact maxima. Workers may share processes. WASM capacities are observed at instantiate/grow/postMessage and phase boundaries using weak references; these are not committed/resident memory. Chromium worker heap/backing storage is sampled separately via CDP Runtime.getHeapUsage; no equivalent JS heap claim is made for Firefox/WebKit.',limits:'Headless Linux desktop; no mobile claim. Browser/OS caches may retain system-level file pages. Instrumentation and sampler overhead are included; trials run serially.'},results},null,2)+'\n');}
try{
 for(let run=1;run<=runs;run++)for(const name of browsers)for(const mode of modes){
  const type={chromium,firefox,webkit}[name],launch=name==='chromium'?{executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH||undefined,args:['--no-sandbox']}:{},host=await type.launchServer(launch);let browser,sampler,heap;
  server.setOffline(false);const before=server.records.length,row={run,browser:name,mode,startedAt:new Date().toISOString()};results.push(row);console.log('START',JSON.stringify({run,browser:name,mode}));
  try{
   sampler=sampleProcessMemory(host.process().pid);browser=await type.connect(host.wsEndpoint());row.browserVersion=browser.version();if(name==='chromium')heap=await sampleWorkerHeap(browser);const mark=phase=>{sampler.mark(phase);heap?.mark(phase);};const context=await browser.newContext(),page=await context.newPage();page.setDefaultTimeout(200000);await page.addInitScript("globalThis.__scribyraMeasurementKind='page';\n"+probe);
   row.linearMemoryEvents=[];page.on('console',message=>{const text=message.text(),prefix='SCRIBYRA_MEASURE_LINEAR ';if(text.startsWith(prefix))row.linearMemoryEvents.push(JSON.parse(text.slice(prefix.length)));});
   const workers=[];page.on('worker',worker=>{workers.push(worker);worker.evaluate((worker.url().includes('busytex_worker')?"globalThis.__scribyraMeasurementKind='compiler';\n":'')+probe).catch(()=>{});});row.workerSnapshots=[];
   const snapshot=async phase=>{row.workerSnapshots.push({phase,workers:await Promise.all(workers.map(workerMemory))});};
   if(mode==='app'){
    await page.goto(server.url);const chooser=page.waitForEvent('filechooser');await page.getByRole('button',{name:'Import ZIP',exact:true}).click();await(await chooser).setFiles({name:'runtime-measurement.zip',mimeType:'application/zip',buffer:Buffer.from(zipSync({'main.tex':strToU8(source)}))});await page.locator('.cm-content').waitFor();
    row.cold=await compileApp(page);if(!row.cold.success)throw new Error('Cold app compile failed: '+row.cold.log);row.coldBodyBytes=server.records.slice(before).reduce((n,r)=>n+r.bodyBytes,0);await snapshot('cold');
    mark('warm');let at=server.records.length;row.warm=await compileApp(page);row.warmBodyBytes=server.records.slice(at).reduce((n,r)=>n+r.bodyBytes,0);await snapshot('warm');
    mark('preparation');at=server.records.length;await page.getByRole('button',{name:'More tools',exact:true}).click();await page.getByRole('button',{name:'TeX environment',exact:true}).click();const dialog=page.getByRole('dialog',{name:'TeX environment',exact:true});await dialog.getByRole('button',{name:'Prepare this project for offline use',exact:true}).click();await dialog.getByText('Verified offline for this locked environment.',{exact:true}).waitFor();await dialog.getByRole('button',{name:'Close',exact:true}).click();await page.locator('.save-indicator').filter({hasText:'Saved locally'}).waitFor();row.preparationBodyBytes=server.records.slice(at).reduce((n,r)=>n+r.bodyBytes,0);
    mark('offline');at=server.records.length;const blockedBefore=server.blocked.length;server.setOffline(true);await context.setOffline(true);await page.reload();await page.getByRole('button',{name:/runtime-measurement.*files?/}).click();row.offline=await compileApp(page);row.offlineBodyBytes=server.records.slice(at).reduce((n,r)=>n+r.bodyBytes,0);row.offlineBlockedRequests=server.blocked.slice(blockedBefore);row.offlineWorkerUpdateBodyBytes=server.records.slice(at).filter(r=>r.path==='/sw.js').reduce((n,r)=>n+r.bodyBytes,0);row.offlineCompilerBodyBytes=server.records.slice(at).filter(r=>r.path.startsWith('/core/')).reduce((n,r)=>n+r.bodyBytes,0);if(!row.warm.success||!row.offline.success||row.offlineCompilerBodyBytes||row.offlineBodyBytes)throw new Error('Warm/offline app compile failed or fetched compiler data.');
   }else{
    await page.goto(server.url+'/__measure/harness.html?loader='+encodeURIComponent(mode==='original'?'texlive-extra.js':manifest.loader.path));await page.waitForFunction(()=>Boolean(window.runMeasurement));row.cold=await page.evaluate(()=>window.runMeasurement());row.coldBodyBytes=server.records.slice(before).reduce((n,r)=>n+r.bodyBytes,0);if(!row.cold.success)throw new Error('Harness compile failed: '+row.cold.log);
    mark('warm');const at=server.records.length;row.warm=await page.evaluate(()=>window.runMeasurement());row.warmBodyBytes=server.records.slice(at).reduce((n,r)=>n+r.bodyBytes,0);if(!row.warm.success)throw new Error('Warm harness compile failed.');
   }
   await snapshot(mode==='app'?'offline':'warm');row.requests=server.records.slice(before).map(({path,range,status,bodyBytes,started,finished,ended})=>({path,range,status,bodyBytes,durationMs:(finished||ended||Date.now())-started,complete:!!finished}));
  }catch(error){row.error=error.message;}
  finally{if(heap){row.workerHeap=await heap.stop();if(!row.workerHeap.samples)row.error||='Chromium worker heap metrics are unavailable.';}if(sampler){row.processMemory=await sampler.stop();if(!row.processMemory.samples||!row.processMemory.peakSampledRss)row.error||='Browser process memory metrics are unavailable.';}await browser?.close().catch(()=>{});await host.close().catch(()=>{});await save();console.log('END',JSON.stringify({run,browser:name,mode,coldBytes:row.coldBodyBytes,peakRss:row.processMemory?.peakSampledRss,peakPss:row.processMemory?.peakSampledPss,error:row.error}));}
 }
}finally{await server.close();}
if(results.some(row=>row.error))process.exitCode=1;
