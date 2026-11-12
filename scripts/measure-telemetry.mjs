// Real application, public synthetic fixture, fresh browser processes/profiles.
// Reuses the assembled Pages release, native ingress and pinned Alloy binary.
import {chromium,firefox,webkit} from '@playwright/test';
import {writeFile,mkdir} from 'node:fs/promises';
import {platform,cpus,release} from 'node:os';
import {dirname,resolve} from 'node:path';
import {performance} from 'node:perf_hooks';
import {zipSync,strToU8} from 'fflate';
import {assetServer} from '../tests/helpers/asset-server.mjs';
import {telemetryServer,ingestionAvailable} from '../tests/helpers/telemetry-server.mjs';
import {sampleProcessMemory} from './measure-browser/process-memory.mjs';
const args=Object.fromEntries(process.argv.slice(2).map(arg=>arg.replace(/^--/,'').split('=')));
const engines=(args.browser||'chromium,firefox,webkit').split(','),runs=Number(args.runs||3),output=args.output||'.cache/telemetry-overhead.json';
if(platform()!=='linux'||!Number.isInteger(runs)||runs<1||runs>10||engines.some(e=>!['chromium','firefox','webkit'].includes(e))||!ingestionAvailable())throw Error('Requires Linux, built telemetry bins, pinned Alloy, --runs=1..10 and supported --browser names.');
if(!resolve(output).startsWith(resolve('.cache')+'/'))throw Error('Measurement output must be disposable .cache data.');
const server=await assetServer({rootDirectory:'.pages',keepAlive:true});let collector;
const rows=[],modes=['disabled','local','remote'],source=String.raw`\documentclass{article}\begin{document}PrivateTelemetryMeasurement. $E=mc^2$.\end{document}`;
const report={version:1,measuredAt:new Date().toISOString(),host:{platform:platform(),kernel:release(),cpu:cpus()[0].model,logicalCpus:cpus().length},method:{fixture:'Fixed synthetic one-page LuaLaTeX article; fresh browser process/profile per trial; trials run serially with mode order rotated each repetition.',startup:'Navigation until Import ZIP is visible. Collection setting exists before startup. Remote export connects through the actual diagnostics UI after startup, so startup compares off versus local instrumentation only.',compile:'UI click until successful compiler result and visible PDF canvas; includes Playwright dispatch/poll and PDF readiness. Cold worker, two warm builds and one offline reload/build per trial. Compiler-reported duration is recorded separately.',transfer:'Actual uncompressed asset HTTP response body bytes written by the loopback server; sampled cumulatively at phase boundaries, including in-flight responses. Excludes headers/TLS/compression. Export body bytes count attempted browser POST payloads separately, not network headers or downstream OTLP volume.',memory:'Linux browser process tree, sampled every 250 ms; reports observed RSS and PSS peaks per phase. RSS double-counts shared pages; PSS apportions them. Peaks are lower bounds; phases shorter than 250 ms can have no sample. Not JS heap, worker-only memory, exact maxima, or native collector memory.',offline:'Both browser context and asset server refuse the network during reload/build. Local collection remains selected; tab-scoped remote credentials are intentionally not restored after reload.',limits:'Headless Linux desktop, loopback network, one synthetic article and three repetitions by default. OS file cache is warm/shared across trials. No mobile, internet latency, memory-allocation attribution, native overhead, or statistical-significance claim. Browser driver and sampler overhead are present in all modes.'},rows};
const bytes=()=>server.records.reduce((sum,row)=>sum+row.bodyBytes,0);
async function save(){await mkdir(dirname(output),{recursive:true});await writeFile(output,JSON.stringify(report,null,2)+'\n');}
async function dialog(page){await page.getByRole('button',{name:'Diagnostics',exact:true}).click();return page.getByRole('dialog',{name:'Local diagnostics'});}
async function inspect(page){const d=await dialog(page),s=JSON.parse(await d.getByLabel('Diagnostic export preview').textContent());await d.getByRole('button',{name:'Close',exact:true}).click();return s;}
try{
 collector=await telemetryServer(server.url);
 for(let run=1;run<=runs;run++)for(const engine of engines)for(let index=0;index<modes.length;index++){
  const mode=modes[(index+run-1)%modes.length],row={run,browser:engine,mode,outcome:'running',phases:{}};rows.push(row);let host,browser,sampler,phase='launch',exportBytes=0,exportRequests=0,accepted=0;
  const trialBefore=bytes();const mark=value=>{phase=value;sampler?.mark(value);if(['startup','cold','warm1','warm2','offlineReload','offline'].includes(value))console.log(JSON.stringify({run,browser:engine,mode,event:'phase',phase:value}));};
  server.setOffline(false);console.log(JSON.stringify({run,browser:engine,mode,event:'start'}));
  try{
   const executablePath=process.env[`PLAYWRIGHT_${engine.toUpperCase()}_EXECUTABLE_PATH`]||undefined;
   host=await({chromium,firefox,webkit}[engine]).launchServer({executablePath,...(engine==='chromium'?{args:['--no-sandbox']}:{})});
   browser=await({chromium,firefox,webkit}[engine]).connect(host.wsEndpoint());row.browserVersion=browser.version();
   sampler=sampleProcessMemory(host.process().pid);mark('startup');
   const context=await browser.newContext(),page=await context.newPage();page.setDefaultTimeout(180000);
   await page.addInitScript(collect=>localStorage.setItem('scribyra:diagnostics:v1',JSON.stringify({collect,allowExport:false})),mode!=='disabled');
   page.on('request',request=>{if(request.url()===collector.url&&request.method()==='POST'){exportRequests++;exportBytes+=request.postDataBuffer()?.byteLength||0;}});
   page.on('response',response=>{if(response.url()===collector.url&&response.status()===202)accepted++;});
   let before=bytes(),started=performance.now();await page.goto(server.url+'/app/');await page.getByRole('button',{name:'Import ZIP',exact:true}).waitFor();
   row.phases.startup={wallMs:performance.now()-started,assetBodyBytes:bytes()-before};mark('setup');
   let initial=await inspect(page);row.buildIdentity=initial.identity;
   if(mode==='disabled'&&initial.events.length||mode!=='disabled'&&!initial.events.some(event=>event.operation==='startup'&&event.outcome==='success'))throw Error('Startup collection mode mismatch');
   const chooser=page.waitForEvent('filechooser');await page.getByRole('button',{name:'Import ZIP',exact:true}).click();await(await chooser).setFiles({name:'telemetry-measurement.zip',mimeType:'application/zip',buffer:Buffer.from(zipSync({'main.tex':strToU8(source)}))});await page.locator('.cm-content').waitFor();
   if(mode==='remote'){
    const d=await dialog(page);await d.getByLabel('Telemetry endpoint',{exact:true}).fill(collector.url);await d.getByLabel('Ingest token',{exact:true}).fill(collector.token);await d.getByLabel('Remote sampling',{exact:true}).selectOption('1');await d.getByLabel('Activity source',{exact:true}).selectOption('local_test');await d.getByRole('button',{name:'Connect telemetry host',exact:true}).click();await d.getByRole('button',{name:'Close',exact:true}).click();
   }
   const compile=async name=>{
    mark(name);const from=bytes(),postFrom=exportBytes,start=performance.now();await page.evaluate(()=>window.scribyra.lastCompile=null);await page.getByRole('button',{name:/^Compile(?: |$)/}).click();await page.waitForFunction(()=>Boolean(window.scribyra.lastCompile));
    const result=await page.evaluate(()=>({success:window.scribyra.lastCompile.success,compilerMs:window.scribyra.lastCompile.durationMs,pdfBytes:window.scribyra.lastCompile.bytes}));if(!result.success)throw Error('Compile failed');await page.locator('#pdf-viewer canvas').first().waitFor();
    row.phases[name]={wallMs:performance.now()-start,compilerMs:result.compilerMs,pdfBytes:result.pdfBytes,assetBodyBytes:bytes()-from,exportAttemptBodyBytes:exportBytes-postFrom};mark('inspection');
   };
   await compile('cold');const cold=await inspect(page),root=cold.events.find(event=>event.operation==='compile'&&event.outcome==='success');
   if(mode!=='disabled'&&!root)throw Error('Missing measured compile event');
   await compile('warm1');await compile('warm2');
   if(mode==='remote'){
    mark('delivery');const deadline=Date.now()+15000;let found=false;
    while(Date.now()<deadline&&!found){const captures=await collector.captures();found=captures.records.filter(record=>record.signal==='traces').some(record=>record.data.resourceSpans.some(resource=>resource.scopeSpans.some(scope=>scope.spans.some(span=>span.traceId===root.traceId&&span.spanId===root.spanId&&span.name==='compile'))));if(!found)await new Promise(resolve=>setTimeout(resolve,100));}
    if(!found||!accepted)throw Error('Actual ingress/Alloy delivery missing');row.remoteCompileReceived=true;
    const persisted=await page.evaluate(()=>JSON.stringify({...localStorage}));if(persisted.includes(collector.token)||persisted.includes(collector.url))throw Error('Remote settings persisted');
   }
   mark('preparation');before=bytes();const d=await page.getByRole('button',{name:'More tools',exact:true}).click();await page.getByRole('button',{name:'TeX environment',exact:true}).click().then(()=>page.getByRole('dialog',{name:'TeX environment',exact:true}));await d.getByRole('button',{name:'Prepare this project for offline use',exact:true}).click();await d.getByText('Verified offline for this locked environment.',{exact:true}).waitFor();await d.getByRole('button',{name:'Close',exact:true}).click();await page.locator('.save-indicator').filter({hasText:'Saved locally'}).waitFor();row.preparationAssetBodyBytes=bytes()-before;
   await page.waitForFunction(()=>navigator.serviceWorker.controller);server.setOffline(true);await context.setOffline(true);before=bytes();mark('offlineReload');started=performance.now();await page.reload();await page.getByRole('button',{name:/telemetry-measurement.*files?/}).click();row.phases.offlineReload={wallMs:performance.now()-started,assetBodyBytes:bytes()-before};await compile('offline');
   const final=await inspect(page);if(mode==='disabled'&&final.events.length||mode!=='disabled'&&!final.events.some(event=>event.operation==='compile'&&event.outcome==='success')||final.rejected||final.events.length>256||final.bufferedBytes>65536)throw Error('Local diagnostics acceptance failed');
   if(row.phases.offlineReload.assetBodyBytes||row.phases.offline.assetBodyBytes)throw Error('Offline network bytes observed');
   row.assetTotalBodyBytes=bytes()-trialBefore;row.localEventsAfterOffline=final.events.length;row.localBufferedBytesAfterOffline=final.bufferedBytes;row.export={attempts:exportRequests,acceptedResponses:accepted,attemptedBodyBytes:exportBytes};
   row.outcome='success';
  }catch(error){row.failureKind=['Error','TimeoutError','TypeError'].includes(error.name)?error.name:'other';row.outcome='failure';row.failedPhase=phase;throw Error(`Telemetry measurement failed in ${engine}/${mode}/${phase}; no raw browser diagnostics saved.`);}
  finally{
   if(sampler){const memory=await sampler.stop();row.memory={intervalMs:memory.intervalMs,samples:memory.samples,pssSamples:memory.pssSamples,peakSampledRss:memory.peakSampledRss,peakSampledPss:memory.peakSampledPss,byPhase:Object.fromEntries(Object.entries(memory.byPhase).map(([name,stats])=>[name,stats.samples?stats:{...stats,peakSampledRss:null,peakSampledPss:null}])),samplerFailed:memory.failure!==null};if(memory.failure||!memory.pssSamples){row.outcome='failure';row.failedPhase='memory';}}
   await browser?.close();await host?.close();server.setOffline(false);await save();
  }
  if(row.outcome!=='success')throw Error('Process memory measurement unavailable');console.log(JSON.stringify({run,browser:engine,mode,event:'complete'}));
 }
 const captures=JSON.stringify(await collector.captures());if(captures.includes('PrivateTelemetryMeasurement')||captures.includes(collector.token)||captures.includes(collector.url))throw Error('Privacy exclusion failed');report.privacyChecked=true;
 const median=values=>{const sorted=[...values].sort((a,b)=>a-b),middle=Math.floor(sorted.length/2);return sorted.length%2?sorted[middle]:(sorted[middle-1]+sorted[middle])/2;};
 const metrics={startupMs:r=>r.phases.startup.wallMs,coldCompileMs:r=>r.phases.cold.wallMs,warmCompileMs:r=>(r.phases.warm1.wallMs+r.phases.warm2.wallMs)/2,offlineCompileMs:r=>r.phases.offline.wallMs,peakPssBytes:r=>r.memory.peakSampledPss,assetBodyBytes:r=>r.assetTotalBodyBytes,exportAttemptBodyBytes:r=>r.export.attemptedBodyBytes};
 report.summary=engines.map(browser=>{const selected=rows.filter(r=>r.browser===browser);return{browser,modes:modes.map(mode=>({mode,trials:runs,medians:Object.fromEntries(Object.entries(metrics).map(([name,value])=>[name,median(selected.filter(r=>r.mode===mode).map(value))]))})),pairedChanges:['local','remote'].map(mode=>({mode,medianPercentVersusDisabled:Object.fromEntries(Object.entries(metrics).filter(([name])=>name!=='exportAttemptBodyBytes').map(([name,value])=>[name,median(selected.filter(r=>r.mode===mode).map(row=>{const baseline=selected.find(r=>r.mode==='disabled'&&r.run===row.run);return 100*(value(row)/value(baseline)-1);}))]))}))};});
 await save();
}finally{await collector?.close();await server.close();}
