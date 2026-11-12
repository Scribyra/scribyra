import 'fake-indexeddb/auto';
import './helpers/core.mjs';
import {test,afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash,webcrypto} from 'node:crypto';
import vm from 'node:vm';
import {TelemetryRecorder,TexCatalog} from '../web/pkg/scribyra_app.js';
import {telemetry} from '../web/telemetry.js';
import {installObservability} from '../web/observability.js';
import {workerObserver,workerObservation,workerResourceObservation} from '../web/worker-observation.js';
import {workspaceTool} from '../web/workspace-tools.js';
import {openMetadata} from '../web/tex-metadata.js';
import {clearPackageCache} from '../web/tex-cache.js';
import {watchRuntime} from '../web/runtime-observation.js';
import {patchCompilerWorker} from '../scripts/patch-compiler-worker.mjs';

afterEach(()=>installObservability(undefined));
function recording(){const recorder=new TelemetryRecorder(),api=telemetry({recorder});api.configure({collect:true,allowExport:true});installObservability(api);return{api,recorder};}

test('per-request worker streams cap posted records and report dropped observations',()=>{
 const {api,recorder}=recording(),parent=api.begin('package_prepare'),events=[];
 try{
  const stream=workerObserver(parent.context,items=>events.push(...items));
  for(let n=0;n<1000;n++)stream.begin('cache').end('success',undefined,[{name:'count',value:1}]);
  stream.finish();stream.finish();assert(events.length<=130);
  const report=events.find(e=>e.operation==='telemetry_drop'&&e.outcome==='success');assert.equal(report.metrics.find(m=>m.name==='count').value,1872);
  for(const event of events)assert(parent.accept(event));
  const before=events.length;stream.begin('cache').end();assert.equal(events.length,before);
  assert.doesNotThrow(()=>workerObserver(parent.context,()=>{throw Error('PRIVATE_SOURCE');}).begin('cache').end());
 }finally{recorder.free();}
});

test('patched classic worker measures individual TeX, BibTeX, Biber and index calls while preserving arguments/results',async()=>{
 const {api,recorder}=recording(),parent=api.begin('compile'),frames=[];
 try{
  const raw=readFileSync(new URL('fixtures/compiler/busytex_worker.js',import.meta.url),'utf8');
  const context=vm.createContext({performance,crypto:webcrypto,importScripts(){},postMessage:data=>frames.push(data),self:{}});context.self.postMessage=context.postMessage;
  vm.runInContext(patchCompilerWorker(raw),context);
  const module={HEAPU8:new Uint8Array(1024)},calls=[];
  const command=function(...args){assert.equal(this,pipeline);calls.push(args);return{exit_code:args[2][0]==='bibtex8'?1:0,log:'PRIVATE_LOG'};};
  const run=async function(...args){assert.equal(this,bibliography);calls.push(args);return 'PRIVATE_BBL';},bibliography={run};
  const biber=async function(...args){assert.equal(this,pipeline);return(await this.biber.run(...args))==null?1:0;};
  const result={pdf:new Uint8Array([1]),exit_code:0,log:'PRIVATE_LOG'};
  const pipeline={biber:bibliography,_run_cmd:command,_run_biber:biber,Module:Promise.resolve(module),async compile(){for(const name of ['luahbtex','bibtex8','makeindex'])this._run_cmd(module,{},[name,'PRIVATE_FILE.tex']);await this._run_biber({},'PRIVATE_FILE.tex',[]);return result;}};
  context.self.pipeline=pipeline;await context.onmessage({data:{files:[],scribyra_telemetry:parent.context}});
  assert.equal(calls.length,4);assert.equal(calls[0][2][1],'PRIVATE_FILE.tex');assert.equal(pipeline._run_cmd,command);assert.equal(pipeline._run_biber,biber);assert.equal(bibliography.run,run);
  assert.equal(frames.at(-1).pdf,result.pdf);assert.equal(frames.at(-1).log,result.log);
  for(const frame of frames)for(const event of frame.scribyraTelemetry||[])assert(parent.accept(event));
  const events=api.snapshot().events;
  assert(events.some(e=>e.operation==='tex_pass'&&e.outcome==='success'));
  assert(events.some(e=>e.operation==='bibliography_pass'&&e.error==='source'));
  assert(events.some(e=>e.operation==='bibliography_pass'&&e.outcome==='success'));
  assert(events.some(e=>e.operation==='index_pass'&&e.outcome==='success'));
  assert.doesNotMatch(api.export(),/PRIVATE_FILE|PRIVATE_LOG|luahbtex|bibtex8/);
  frames.length=0;pipeline._run_biber=async()=>0;pipeline.compile=async function(){await this._run_biber();return result;};
  await context.onmessage({data:{files:[],scribyra_telemetry:parent.context}});
  assert(!frames.flatMap(frame=>frame.scribyraTelemetry||[]).some(e=>e.operation==='bibliography_pass'),'a skipped backend is not an executed Biber invocation');
 }finally{recorder.free();}
});

test('workspace requests correlate their worker evidence and reject responses after cancellation/restart',async()=>{
 const {api,recorder}=recording(),original=globalThis.Worker,workers=[];let tool;
 class Worker{constructor(){workers.push(this);}postMessage(data){this.request=data;}terminate(){this.terminated=true;}}
 globalThis.Worker=Worker;
 try{
  tool=workspaceTool();const pending=tool.run('search',{query:'PRIVATE_QUERY',files:[]}),worker=workers[0],trace=workerObservation(worker.request.telemetry,'workspace_search');trace.end('success');
  const result={matches:[],private:'PRIVATE_SOURCE'};worker.onmessage({data:{id:worker.request.id,result,telemetry:trace.events}});assert.equal(await pending,result);
  assert(api.snapshot().events.some(e=>e.runtime==='worker'&&e.operation==='workspace_search'&&e.outcome==='success'));
  const cancelled=tool.run('outline',{source:'PRIVATE_SOURCE'});const rejected=assert.rejects(cancelled,{name:'AbortError'});tool.cancel();await rejected;
  const count=api.snapshot().events.length;workers[1].onmessage({data:{id:workers[1].request.id,result,telemetry:trace.events}});assert.equal(api.snapshot().events.length,count);
  const next=tool.run('source-map',{}),third=workers[2];third.onmessage({data:{id:third.request.id,error:'PRIVATE_ERROR'}});await assert.rejects(next,/PRIVATE_ERROR/);
  assert(api.snapshot().events.some(e=>e.operation==='source_map'&&e.error==='worker'));assert.doesNotMatch(api.export(),/PRIVATE_QUERY|PRIVATE_SOURCE|PRIVATE_ERROR/);
 }finally{tool?.cancel();globalThis.Worker=original;recorder.free();}
});

test('metadata download/verification/cache operations use request-local observations without carrying labels',async()=>{
 await clearPackageCache();const {api,recorder}=recording(),parent=api.begin('package_prepare');let catalog;
 try{
  const stream=workerObserver(parent.context,events=>{for(const event of events)assert(parent.accept(event));}),observe=stream.begin;
  const name='private-package',snapshot='2026-01-01',files=new Map(),sha=bytes=>createHash('sha256').update(bytes).digest('hex');
  function pin(value,root=false){const bytes=Buffer.from(JSON.stringify(value)),sha256=sha(bytes),path=root?`tex-catalog.${sha256}.json`:`metadata/${sha256}.json`;files.set('https://PRIVATE.invalid/'+path,bytes);return{path,size:bytes.length,sha256};}
  const pkg=pin({snapshot,packages:{[name]:{revision:1,size:1,sha512:'a'.repeat(128),files:['tex/latex/PRIVATE_SOURCE.sty']}}});
  const root=pin({version:1,snapshot,sourceArchiveSha256:'a'.repeat(64),fontFamilies:{},filenames:{},packages:{[TexCatalog.metadata_bucket(name)]:pkg}},true);
  let fetched=0;const runtime={engine:'lualatex',snapshot,distributionSha256:'a'.repeat(64),adapterSha256:'b'.repeat(64),catalogSha256:root.sha256};
  const metadata=await openMetadata({Catalog:TexCatalog,root,base:'https://PRIVATE.invalid',runtime,observe,fetcher:async url=>{fetched++;return new Response(files.get(url));}});catalog=metadata.catalog;
  await metadata.ensure([name],observe);await metadata.metadataAssets([name],observe);stream.finish();assert.equal(fetched,2);
  const events=api.snapshot().events;assert(events.some(e=>e.operation==='download'&&e.outcome==='success'));assert(events.some(e=>e.operation==='verify'&&e.outcome==='success'));
  assert(events.some(e=>e.operation==='cache'&&e.outcome==='success'&&e.metrics.some(m=>m.name==='count'&&m.value===1)));
  assert.doesNotMatch(api.export(),/PRIVATE|private-package|https:/);
 }finally{catalog?.free();recorder.free();}
});

test('runtime relay is optional and its registration never delays work when a worker rejects it',()=>{
 const {api,recorder}=recording();
 try{const error=Error('PRIVATE_WORKER');const relay=watchRuntime({postMessage(){throw error;}},crypto.randomUUID());assert.doesNotThrow(()=>relay.finish());assert(api.snapshot().events.some(e=>e.operation==='telemetry_delivery'&&e.error==='worker'));assert.doesNotMatch(api.export(),/PRIVATE_WORKER/);}
 finally{recorder.free();}
});
test('an unsupported runtime relay times out independently while the caller continues',async()=>{
 const {api,recorder}=recording();let relay;
 try{relay=watchRuntime({postMessage(){}},crypto.randomUUID());assert.equal(relay.finish(),undefined);await new Promise(resolve=>setTimeout(resolve,1100));assert(api.snapshot().events.some(e=>e.operation==='telemetry_delivery'&&e.error==='unavailable'));}
 finally{relay?.finish();recorder.free();}
});


test('resource timing drains once, shares the request cap and never reads private resource fields',()=>{
 const {api,recorder}=recording(),parent=api.begin('worker_startup'),original=globalThis.PerformanceObserver,instances=[],origin=performance.now()-10,frames=[];
 class Observer{static supportedEntryTypes=['resource'];constructor(callback){this.callback=callback;this.queue=[];instances.push(this);}observe(options){assert.deepEqual(options,{type:'resource',buffered:false});}takeRecords(){return this.queue.splice(0);}disconnect(){this.disconnected=true;}}
 globalThis.PerformanceObserver=Observer;
 try{
  const stream=workerObserver(parent.context,events=>{frames.push(...events);for(const event of events)assert(parent.accept(event));},origin);
  const resource=workerResourceObservation(stream,origin,true),instance=instances[0];
  const entry={entryType:'resource',startTime:origin+1,responseEnd:origin+4,encodedBodySize:123,responseStatus:200,get name(){throw Error('PRIVATE_URL Bearer SECRET');},get serverTiming(){throw Error('SECRET_HEADER');}};
  instance.callback({getEntries:()=>[entry]});instance.queue.push({entryType:'resource',startTime:origin+1,responseEnd:origin+4,encodedBodySize:123,responseStatus:0}); // no private getters should be read by the adapter
  instance.queue.push({entryType:'resource',startTime:origin+1,responseEnd:origin+4,encodedBodySize:0,responseStatus:503});
  resource.finish();resource.finish();stream.finish();
  assert(frames.some(event=>event.operation==='runtime_transfer'&&event.outcome==='failure'&&event.error==='network'));
  assert(instance.disconnected);assert.equal(frames.filter(event=>event.operation==='runtime_transfer'&&event.outcome==='success').length,1);
  const neutral=frames.find(event=>event.operation==='runtime_transfer'&&event.outcome==='observed');assert(neutral);assert.deepEqual(neutral.metrics,[{name:'duration_ms',value:3},{name:'bytes',value:123}]);
  assert.equal(neutral.elapsedMs,4);assert.doesNotMatch(api.export(),/PRIVATE_URL|SECRET_HEADER|Bearer|serverTiming/);
  const count=frames.length;instance.callback({getEntries:()=>[entry]});assert.equal(frames.length,count);
  const capped=workerObserver(parent.context,events=>frames.push(...events),origin),many=workerResourceObservation(capped,origin,true);
  instances[1].callback({getEntries:()=>Array(1000).fill(entry)});many.finish();capped.finish();
  assert.equal(frames.length-count,130);assert.equal(frames.at(-1).operation,'telemetry_drop');assert.equal(frames.at(-1).metrics.find(metric=>metric.name==='count').value,1872);
 }finally{globalThis.PerformanceObserver=original;recorder.free();}
});

test('resource observation is absent when disabled and unsupported or broken APIs cannot change work',()=>{
 const {api,recorder}=recording(),parent=api.begin('compile'),original=globalThis.PerformanceObserver;
 const stream=workerObserver(parent.context,events=>{for(const event of events)assert(parent.accept(event));});let constructed=0;
 globalThis.PerformanceObserver=class{static supportedEntryTypes=['resource'];constructor(){constructed++;throw Error('PRIVATE_API_FAILURE');}};
 try{
  workerResourceObservation(stream,performance.now(),false).finish();assert.equal(constructed,0);
  assert.doesNotThrow(()=>workerResourceObservation(stream,performance.now(),true).finish());assert.equal(constructed,1);stream.finish();
  assert(api.snapshot().events.some(event=>event.operation==='telemetry_delivery'&&event.error==='unavailable'));
  assert.doesNotMatch(api.export(),/PRIVATE_API_FAILURE/);
 }finally{globalThis.PerformanceObserver=original;recorder.free();}
});

test('patched initialization captures resource timing before readiness and preserves disabled/failed initialization',async()=>{
 const {api,recorder}=recording(),parent=api.begin('worker_startup'),frames=[],observers=[];
 class Observer{static supportedEntryTypes=['resource'];constructor(callback){this.callback=callback;this.queue=[];observers.push(this);}observe(){}takeRecords(){return this.queue.splice(0);}disconnect(){this.closed=true;}}
 const fixture=readFileSync(new URL('fixtures/compiler/busytex_worker.js',import.meta.url),'utf8');let ready,instance;
 class Pipeline{constructor(...args){ready=args[6];instance=this;}}
 const context=vm.createContext({performance,crypto:webcrypto,PerformanceObserver:Observer,BusytexPipeline:Pipeline,importScripts(){},postMessage:data=>frames.push(data),self:{}});context.self.postMessage=context.postMessage;
 try{
  vm.runInContext(patchCompilerWorker(fixture),context);
  const input={busytex_js:'PRIVATE_LOADER.js',busytex_wasm:'PRIVATE_ENGINE.wasm',preload_data_packages_js:[]};
  await context.onmessage({data:{...input,scribyra_telemetry:parent.context}});assert.equal(context.self.pipeline,instance);assert.equal(observers.length,1);
  const start=performance.now();await new Promise(resolve=>setTimeout(resolve,2));
  observers[0].queue.push({entryType:'resource',startTime:start,responseEnd:performance.now(),encodedBodySize:99,responseStatus:200,name:'PRIVATE_ASSET.data'});
  ready({version:'PRIVATE_ENGINE_VERSION'});assert(observers[0].closed);assert.equal(frames.at(-1).initialized.version,'PRIVATE_ENGINE_VERSION');
  for(const frame of frames)for(const event of frame.scribyraTelemetry||[])assert(parent.accept(event));
  assert(api.snapshot().events.some(event=>event.operation==='runtime_transfer'&&event.outcome==='success'));
  assert.doesNotMatch(api.export(),/PRIVATE_LOADER|PRIVATE_ENGINE|PRIVATE_ASSET/);
  frames.length=0;await context.onmessage({data:input});ready({version:1});assert.equal(observers.length,1);assert.equal(frames.length,1);
  context.performance={now(){throw Error('PRIVATE_BROKEN_CLOCK');}};frames.length=0;
  await context.onmessage({data:{...input,scribyra_telemetry:parent.context}});ready({version:2});assert.equal(frames.length,1);assert.equal(frames[0].initialized.version,2);assert.equal(observers.length,1);context.performance=performance;
  context.BusytexPipeline=class{constructor(){throw Error('PRIVATE_ORIGINAL_FAILURE');}};
  frames.length=0;await context.onmessage({data:{...input,scribyra_telemetry:parent.context}});assert.match(frames.at(-1).exception,/PRIVATE_ORIGINAL_FAILURE/);assert(observers.at(-1).closed);
 }finally{recorder.free();}
});


test('Biber existing-buffer observation preserves value/error identity and its pinned patch is idempotent',async()=>{
 const {scribyraRuntimeDownload,patchRuntimeDownload}=await import('../scripts/runtime-download-observation.mjs');
 const events=[],bytes=new Uint8Array([1,2,3]).buffer,error=Error('PRIVATE_DOWNLOAD_FAILURE'),observe=operation=>({end:(...args)=>events.push({operation,args})});
 assert.equal(await scribyraRuntimeDownload(async()=>bytes,observe),bytes);assert.deepEqual(events[0],{operation:'download',args:['success',undefined,[{name:'bytes',value:3}]]});
 await assert.rejects(scribyraRuntimeDownload(async()=>{throw error;},observe),value=>value===error);assert.equal(events.at(-1).args[1],'network');assert.doesNotMatch(JSON.stringify(events),/PRIVATE_DOWNLOAD_FAILURE/);
 assert.equal(await scribyraRuntimeDownload(async()=>bytes,()=>{throw error;}),bytes);
 assert.equal(await scribyraRuntimeDownload(async()=>bytes,()=>({end(){throw error;}})),bytes);
 const source='async function load(){processPackageData(await fetchRemotePackage(REMOTE_PACKAGE_NAME, REMOTE_PACKAGE_SIZE));}',patched=patchRuntimeDownload(source);assert.equal(patchRuntimeDownload(patched),patched);new vm.Script(patched);
 assert.throws(()=>patchRuntimeDownload('unrecognized loader'),/Unexpected runtime download framing/);
});
