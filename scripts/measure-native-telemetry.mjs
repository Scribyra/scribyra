// Fresh native processes, rotated modes, identical fixed synthetic workloads.
import {spawn,execFileSync} from 'node:child_process';
import {mkdir,mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {platform,release,cpus} from 'node:os';
import {createHash} from 'node:crypto';
import {performance} from 'node:perf_hooks';
import assert from 'node:assert/strict';
import {localCollector} from '../tests/helpers/telemetry-local.mjs';
import {sampleProcessMemory} from './measure-browser/process-memory.mjs';
const runs=Number(process.argv[2]||3),output=process.argv[3]||'.cache/t-local/native-overhead.json';
assert(platform()==='linux'&&Number.isInteger(runs)&&runs>=1&&runs<=10);assert(resolve(output).startsWith(resolve('.cache')+'/'));
await mkdir('.cache/t-local',{recursive:true});const directory=await mkdtemp(resolve('.cache/t-local/native-')),root=join(directory,'fixture');await mkdir(root);
for(let i=0;i<32;i++)await writeFile(join(root,`file-${i}.tex`),'PrivateNativeMeasurement\n'.repeat(1024));
const rows=[],modes=['disabled','local','remote'];let collector;
const median=values=>{const sorted=values.filter(v=>v!==null).sort((a,b)=>a-b);return sorted.length?sorted[Math.floor(sorted.length/2)]:null;};
const executables=Object.fromEntries(await Promise.all(['folders','sync'].map(async name=>[name,createHash('sha256').update(await readFile('target/release/scribyra-'+name)).digest('hex')])));
const report={version:1,profile:'release',executables,collector:{ingressProfile:'debug',alloyVersion:JSON.parse(await readFile('ops/telemetry/tools.lock.json','utf8')).alloy.version,destination:'bounded OTLP decoding sink'},toolchain:{node:process.versions.node,rust:execFileSync('rustc',['--version'],{encoding:'utf8'}).trim()},measuredAt:new Date().toISOString(),host:{platform:platform(),kernel:release(),cpu:cpus()[0].model,logicalCpus:cpus().length},revision:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),dirty:!!execFileSync('git',['status','--porcelain'],{encoding:'utf8'}).trim(),method:{order:'Three fresh process modes per repetition, rotated disabled/local/remote. Serial trials, OS caches shared.',workload:'Read-only folders inspect: 32 synthetic 25 KiB files. Sync startup through listening message; 30 sequential PUT/GET pairs of an identical 64 KiB blob through the real SQLite API, 10 ms pause per pair. No native compiler exists: browser compile overhead remains in T4e.',timing:'CLI wall time includes process startup, inspection and bounded exporter shutdown; sync workload wall time includes HTTP, SQLite, test driver and fixed pauses. Collection configured before startup. No local snapshot disk output.',transfer:'Actual POST body bytes to a loopback counting proxy, then real Rust authenticated ingress and OTLP decoding sink. Full sampling; fresh native_session/sync_http successful span IDs verified against the previous capture. Headers, TLS and downstream protobuf bytes excluded. Pinned Alloy forwards to the sink; no Grafana retained ingestion claim.',memory:'Native process tree RSS/PSS sampled every 250 ms using the browser T4e sampler. Short CLI may have no live sample; report null then. Collector and driver memory excluded.',limits:'Headless Linux, one synthetic fixed workload, configured repetitions, warm shared OS caches on a shared engineering host; no statistical-significance claim. No TLS, remote network, companion MCP latency, native compile or collector-memory attribution. Sampling peaks are lower bounds; HTTP export is best effort.'},rows};
async function stop(child){if(child.exitCode!==null||child.signalCode!==null)return;const done=new Promise(resolve=>child.once('exit',resolve));child.kill('SIGTERM');const timer=setTimeout(()=>child.kill('SIGKILL'),3000);await done;clearTimeout(timer);}
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const startClock=performance.now();
try{
 collector=await localCollector();
 for(let run=1;run<=runs;run++)for(let index=0;index<modes.length;index++){
  const mode=modes[(run+index-1)%modes.length],row={run,mode,phases:{}};rows.push(row);const from=collector.stats(),prior=JSON.stringify(await collector.captures());
  const env={...process.env,SCRIBYRA_DIAGNOSTICS:mode==='disabled'?'0':'1',SCRIBYRA_DIAGNOSTICS_DIR:'',SCRIBYRA_TELEMETRY_SOURCE:'local_test',SCRIBYRA_TELEMETRY_SAMPLE_PERCENT:'100',SCRIBYRA_TELEMETRY_ENDPOINT:mode==='remote'?collector.url:'',SCRIBYRA_TELEMETRY_TOKEN_FILE:mode==='remote'?collector.tokenFile:'',SCRIBYRA_CONTAINER:'0',SCRIBYRA_SYNC_PORT:'0',SCRIBYRA_SYNC_DB:join(directory,`sync-${run}-${mode}.sqlite`)};
  for(const kind of ['cli','sync']){
   const start=performance.now(),child=spawn(resolve('target/release/scribyra-'+(kind==='cli'?'folders':'sync')),kind==='cli'?['inspect',root]:[],{env,stdio:['ignore','pipe','ignore']});let sampler=sampleProcessMemory(child.pid),stdout='';child.stdout.on('data',bytes=>{stdout=(stdout+bytes).slice(-262144);});
   const exited=new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',code=>resolve(code));});const timeout=setTimeout(()=>child.kill('SIGKILL'),30000);
   try{
    if(kind==='cli'){assert.equal(await exited,0);assert.equal(JSON.parse(stdout).entries.length,32);row.phases.cli={wallMs:performance.now()-start};}
    else{
     while(!/listening on (127\.0\.0\.1:[0-9]+)/.test(stdout)){assert(child.exitCode===null);await delay(5);}
     row.phases.startup={wallMs:performance.now()-start};sampler.mark('workload');const url='http://'+stdout.match(/listening on (127\.0\.0\.1:[0-9]+)/)[1],body=Buffer.alloc(65536,42),hash=createHash('sha256').update(body).digest('hex'),path=url+'/rooms/measurement/blobs/'+hash;
     const before=performance.now();for(let i=0;i<30;i++){assert([200,201,204].includes((await fetch(path,{method:'PUT',body})).status));const result=await fetch(path);assert.equal(result.status,200);assert(Buffer.from(await result.arrayBuffer()).equals(body));await delay(10);}
     row.phases.sync={wallMs:performance.now()-before,logicalBodyBytes:30*2*body.length,requests:60};sampler.mark('drain');await delay(1500);await stop(child);
    }
   }finally{clearTimeout(timeout);await stop(child);const memory=await sampler.stop();assert.equal(memory.failure,null);row.phases[kind].memory={intervalMs:memory.intervalMs,samples:memory.samples,liveSamples:memory.timeline.filter(s=>s.rss>0).length,peakSampledRss:memory.peakSampledRss||null,peakSampledPss:memory.peakSampledPss||null,byPhase:memory.byPhase};}
  }
  await delay(1000);const to=collector.stats();row.export={requests:to.requests-from.requests,bodyBytes:to.bodyBytes-from.bodyBytes,accepted:to.accepted-from.accepted};
  if(mode==='remote'){assert(row.export.accepted>0);const encoded=JSON.stringify(await collector.captures());assert(![collector.token,collector.url,root,'PrivateNativeMeasurement'].some(value=>encoded.includes(value)));const events=(await collector.captures()).records.filter(r=>r.signal==='logs').flatMap(r=>(r.data.resourceLogs||[]).flatMap(b=>(b.scopeLogs||[]).flatMap(s=>s.logRecords||[]))).map(r=>JSON.parse(r.body.stringValue));for(const operation of ['sync_http','native_session'])assert(events.some(e=>e.operation===operation&&e.outcome==='success'&&!prior.includes(e.spanId)),'Fresh exact native outcomes must cross Alloy');row.export.verifiedOperations=['native_session','sync_http'];}else assert.equal(row.export.requests,0);
  row.outcome='passed';console.log(JSON.stringify({run,mode,outcome:row.outcome}));await writeFile(output,JSON.stringify(report,null,2)+'\n');
 }
 report.summary=Object.fromEntries(modes.map(mode=>{const selected=rows.filter(r=>r.mode===mode);return[mode,{trials:selected.length,cliMs:median(selected.map(r=>r.phases.cli.wallMs)),startupMs:median(selected.map(r=>r.phases.startup.wallMs)),syncMs:median(selected.map(r=>r.phases.sync.wallMs)),syncPeakPss:median(selected.map(r=>r.phases.sync.memory.peakSampledPss)),exportBodyBytes:median(selected.map(r=>r.export.bodyBytes))}];}));
 const values=row=>({cliMs:row.phases.cli.wallMs,startupMs:row.phases.startup.wallMs,syncMs:row.phases.sync.wallMs,syncPeakPss:row.phases.sync.memory.peakSampledPss});
 for(const mode of ['local','remote'])report.summary[mode].changeVsDisabledPercent=Object.fromEntries(Object.keys(values(rows[0])).map(key=>[key,median(rows.filter(r=>r.mode===mode).map(row=>{const baseline=values(rows.find(r=>r.run===row.run&&r.mode==='disabled'))[key],value=values(row)[key];return baseline&&value!==null?(value-baseline)/baseline*100:null;}))]));
 report.elapsedMs=performance.now()-startClock;await writeFile(output,JSON.stringify(report,null,2)+'\n');
}catch(error){if(rows.length)rows.at(-1).outcome='failed';await writeFile(output,JSON.stringify(report,null,2)+'\n');throw error;}finally{await collector?.close();await rm(directory,{recursive:true,force:true});}
