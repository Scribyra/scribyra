import 'fake-indexeddb/auto';
import './helpers/core.mjs';
import {test,beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash,webcrypto} from 'node:crypto';
import vm from 'node:vm';
import {readBounded} from '../web/runtime-assets.js';
import {workerObservation,workerObserver} from '../web/worker-observation.js';
import {TelemetryRecorder} from '../web/pkg/scribyra_app.js';
import {telemetry} from '../web/telemetry.js';

beforeEach(()=>new Promise((resolve,reject)=>{const request=indexedDB.deleteDatabase('scribyra-tex-packages');request.onsuccess=resolve;request.onerror=()=>reject(request.error);}));
const shared=readFileSync(new URL('../web/download-state.js',import.meta.url),'utf8'),policy=JSON.parse(readFileSync(new URL('../web/cache-policy.json',import.meta.url),'utf8'));
const source=readFileSync(new URL('../web/sw-template.js',import.meta.url),'utf8');
function worker(){
 const bytes=new TextEncoder().encode('verified engine'),asset={path:'busytex.wasm',size:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')};
 const handlers=new Map(),stores=new Map();let requests=0,quota=false;
 const caches={async open(name){if(!stores.has(name))stores.set(name,new Map());const store=stores.get(name);return{
  async match(request){return store.get(request.url||request)?.clone();},
  async put(request,response){if(quota)throw new DOMException('Full','QuotaExceededError');store.set(request.url||request,response.clone());},
  async keys(){return [...store.keys()].map(url=>new Request(url));},
  async delete(request){return store.delete(request.url||request);},
 };},async delete(name){return stores.delete(name);}};
 const context={Request,Response,Headers,Uint8Array,URL,crypto:webcrypto,performance,Date,caches,indexedDB,IDBKeyRange,DOMException,AbortController,setTimeout,clearTimeout,
  fetch:async()=>{requests++;return new Response(bytes);},
  self:{location:new URL('https://scribyra.test/sw.js'),clients:{get:async()=>null,claim:async()=>{}},addEventListener:(name,handler)=>handlers.set(name,handler)},
 };
 vm.runInNewContext(workerObservation.toString()+'\n'+workerObserver.toString()+'\n'+shared+'\nconst downloads=globalThis.createScribyraDownloads('+JSON.stringify(policy)+');\n'+source.replace('__BUILD_CACHE__','shell-test').replace('__PRECACHE__','[]').replace('__APP_BASE__',JSON.stringify('/')).replace('__TEX_BASE__',JSON.stringify('/core/busytex')).replace('__RUNTIME_ASSETS__',JSON.stringify([asset])),context);
 const fetch=async(path='/core/busytex/busytex.wasm',options={})=>{let result;handlers.get('fetch')({request:new Request('https://scribyra.test'+path,{headers:options.id?{'X-Scribyra-Prepare':options.id}:{}}),clientId:options.clientId,respondWith:value=>{result=value;}});return result&&await result;};
 const message=async(type,data={},options={})=>{let result,pending;handlers.get('message')({data:{type,...data},origin:options.origin||'https://scribyra.test',source:options.source,ports:[options.port||{postMessage:value=>{result=value;},close(){}}],waitUntil:value=>{pending=value;}});await pending;return result;};
 const activate=async()=>{let pending;handlers.get('activate')({waitUntil:value=>{pending=value;}});await pending;};
 return{asset,bytes,stores,caches,fetch,message,activate,get requests(){return requests;},set quota(value){quota=value;},set network(fn){context.fetch=fn;}};
}
test('runtime bytes are verified on network and cache reads, with corruption repaired',async()=>{
 const w=worker();assert.deepEqual(new Uint8Array(await(await w.fetch()).arrayBuffer()),w.bytes);assert.equal(w.requests,1);
 assert.equal((await w.message('scribyra-runtime-status')).ready,true);
 await w.fetch();assert.equal(w.requests,1);
 const cache=await w.caches.open('scribyra-runtime-verified-v1');await cache.put(new Request('https://scribyra.test/__scribyra-runtime/'+w.asset.sha256),new Response(new Uint8Array(w.bytes.length)));
 assert.equal((await w.message('scribyra-runtime-status')).ready,false);
 await w.fetch();assert.equal(w.requests,2);assert.equal((await w.message('scribyra-runtime-status')).ready,true);
});
test('service-worker observations bind to a client, stay bounded and exclude resource/capability fields',async()=>{
 const w=worker(),recorder=new TelemetryRecorder(),api=telemetry({recorder});api.configure({collect:true,allowExport:true});
 const span=api.begin('telemetry_delivery'),id=crypto.randomUUID(),frames=[],port={postMessage:data=>frames.push(data),close(){}};
 try{
  await w.message('scribyra-runtime-observe',{id,context:{...span.context,secret:'PRIVATE_SOURCE'}},{source:{id:'owner'},port});
  assert.equal(frames[0].ready,true);
  await w.fetch(undefined,{id,clientId:'other'});assert.equal(frames.length,1);
  await w.message('scribyra-runtime-unobserve',{id},{source:{id:'other'}});
  await w.fetch(undefined,{id,clientId:'owner'});assert(frames.some(frame=>frame.telemetry));
  for(let n=0;n<40;n++)await w.fetch(undefined,{id,clientId:'owner'});
  await w.message('scribyra-runtime-unobserve',{id},{source:{id:'owner'}});
  const events=frames.flatMap(frame=>frame.telemetry||[]);assert(events.length<=130);
  assert(events.some(e=>e.operation==='telemetry_drop'&&e.metrics.some(m=>m.name==='count'&&m.value>0)));
  for(const event of events)assert.equal(span.accept(event),true);span.end();
  assert.doesNotMatch(api.export(),/PRIVATE_SOURCE|busytex.wasm|scribyra.test|owner|other/);assert(!api.export().includes(id));
  assert.equal(frames.at(-1).done,true);
 }finally{recorder.free();}
});
test('service-worker relay rejects foreign registration and reports actual network integrity and quota outcomes',async()=>{
 const w=worker(),parent={traceId:'a'.repeat(32),spanId:'b'.repeat(16)},id=crypto.randomUUID(),frames=[],port={postMessage:data=>frames.push(data),close(){}};
 await w.message('scribyra-runtime-observe',{id,context:parent},{origin:'https://foreign.test',source:{id:'owner'},port});assert.equal(frames[0].ready,false);frames.length=0;
 await w.message('scribyra-runtime-observe',{id,context:parent},{source:{id:'owner'},port});
 w.network=async()=>new Response(new Uint8Array(w.bytes.length));assert.equal((await w.fetch(undefined,{id,clientId:'owner'})).status,502);
 assert(frames.flatMap(frame=>frame.telemetry||[]).some(e=>e.operation==='verify'&&e.error==='integrity'));
 w.network=async()=>new Response(w.bytes);w.quota=true;assert.equal((await w.fetch(undefined,{id,clientId:'owner'})).status,200);
 assert(frames.flatMap(frame=>frame.telemetry||[]).some(e=>e.operation==='cache'&&e.error==='quota'));
 await w.message('scribyra-runtime-unobserve',{id},{source:{id:'owner'}});
});
test('service-worker registrations are capped and closing an owned relay frees its slot',async()=>{
 const w=worker(),context={traceId:'a'.repeat(32),spanId:'b'.repeat(16)},ids=[];
 async function register(id){let ready;await w.message('scribyra-runtime-observe',{id,context},{source:{id:'owner'},port:{postMessage:data=>{if('ready'in data)ready=data.ready;},close(){}}});return ready;}
 for(let n=0;n<32;n++){const id=crypto.randomUUID();ids.push(id);assert.equal(await register(id),true);}
 const next=crypto.randomUUID();assert.equal(await register(next),false);
 await w.message('scribyra-runtime-unobserve',{id:ids[0]},{source:{id:'other'}});assert.equal(await register(next),false);
 await w.message('scribyra-runtime-unobserve',{id:ids.shift()},{source:{id:'owner'}});assert.equal(await register(next),true);ids.push(next);
 for(const id of ids)await w.message('scribyra-runtime-unobserve',{id},{source:{id:'owner'}});
});
test('runtime response bounds and checksums reject changed assets without caching',async()=>{
 for(const bytes of [new Uint8Array(1),new Uint8Array(16),new Uint8Array(15)]){
  const w=worker();w.network=async()=>new Response(bytes);const response=await w.fetch();assert.equal(response.status,502);assert.equal(response.headers.get('X-Scribyra-Runtime-Error'),'1');assert.equal((await w.message('scribyra-runtime-status')).ready,false);
 }
});
test('quota failure permits verified online use and reports offline preparation incomplete',async()=>{
 const w=worker();w.quota=true;assert.equal((await w.fetch()).status,200);assert.equal((await w.message('scribyra-runtime-status')).ready,false);
});
test('legacy compiler cache is reused only after exact verification',async()=>{
 const w=worker(),cache=await w.caches.open('scribyra-tex-v1.4.1');await cache.put(new Request('https://scribyra.test/core/busytex/busytex.wasm'),new Response(w.bytes));
 assert.equal((await w.fetch()).status,200);assert.equal(w.requests,0);assert.equal((await w.message('scribyra-runtime-status')).ready,true);
});
test('component archives bypass the service worker cache and clearing preserves shell/source caches',async()=>{
 const w=worker();assert.equal(await w.fetch('/core/busytex/components/archive.tar.xz'),undefined);assert.equal(w.requests,0);
 assert.equal(await w.fetch('/core/busytex/texlive.data'),undefined);assert.equal(await w.fetch('/core/busytex/unpinned.wasm'),undefined);assert.equal(w.requests,0);
 await w.caches.open('shell-test');await w.caches.open('project-sources');await w.fetch();await w.message('scribyra-runtime-clear');
 assert.deepEqual([...w.stores.keys()].sort(),['project-sources','shell-test']);
});
test('bounded reads stop an oversized stream, preserve short reads and reject missing bodies',async()=>{
 let cancelled=false;const stream=new ReadableStream({start(c){c.enqueue(new Uint8Array(5));},cancel(){cancelled=true;}});
 await assert.rejects(readBounded(new Response(stream),4),/manifest size/);assert.equal(cancelled,true);
 assert.equal((await readBounded(new Response(new Uint8Array(2)),4)).length,2);
 await assert.rejects(readBounded(new Response(null),4),/no body/);
});
async function preload(response,observe){
 const bytes=new Uint8Array([1,2,3]),info={dataFile:'baseline.data',size:3,sha256:createHash('sha256').update(bytes).digest('hex'),files:[{filename:'/texlive/test',start:0,end:3}],compressed:{offsets:[0]}};
 let finish,installed,credentials,url;const done=new Promise(resolve=>{finish=resolve;});
 const context={Uint8Array,URL,crypto:webcrypto,performance,BusytexPipeline:{preRun:[]},fetch:async(path,options)=>{url=String(path);credentials=options.credentials;return response;},self:{location:new URL('https://scribyra.test/core/busytex/busytex_worker.js'),postMessage:finish}};
 vm.runInNewContext(readFileSync(new URL('../scripts/lualatex-preload.js',import.meta.url),'utf8').replace('__SCRIBYRA_BASELINE__',JSON.stringify(info)),context);
 context.BusytexPipeline.preRun[0]({scribyraObserve:observe,addRunDependency(){},removeRunDependency(){finish({ok:true});},setStatus(){},LZ4:{loadPackage(value){installed=value;}}});
 const result=await done;return{result,installed,credentials,url};
}
test('generated preload authenticates to the same origin and verifies bytes before installation',async()=>{
 const {result,installed,credentials,url}=await preload(new Response(new Uint8Array([1,2,3])));
 assert.equal(result.ok,true);assert.equal(credentials,'same-origin');assert.equal(url,'https://scribyra.test/core/busytex/baseline.data');assert.deepEqual(Array.from(installed.compressedData.data),[1,2,3]);
});
test('generated preload reports changed, truncated and oversized data without installing it',async()=>{
 for(const bytes of [[1,2],[1,2,4],[1,2,3,4]]){
  const {result,installed}=await preload(new Response(new Uint8Array(bytes)));assert.match(result.exception,/truncated|checksum|manifest size/);assert.equal(installed,undefined);
 }
});

test('activation clears unbounded legacy compiler caches while preserving verified runtime and application caches',async()=>{
 const w=worker();await w.fetch();await w.caches.open('scribyra-tex-v1.4.1');await w.caches.open('shell-test');await w.caches.open('project-sources');
 const preload=await new Promise((resolve,reject)=>{const r=indexedDB.open('EM_PRELOAD_CACHE',1);r.onupgradeneeded=()=>r.result.createObjectStore('PACKAGES');r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});preload.close();
 await w.activate();assert.deepEqual([...w.stores.keys()].sort(),['project-sources','scribyra-runtime-verified-v1','shell-test']);assert.equal((await w.message('scribyra-runtime-status')).ready,true);
 assert.equal((await indexedDB.databases()).some(db=>db.name==='EM_PRELOAD_CACHE'),false);
});
test('a failed runtime access timestamp cannot bypass eviction after a successful CacheStorage write',async()=>{
 const w=worker(),db=await new Promise((resolve,reject)=>{const r=indexedDB.open('scribyra-tex-packages',2);r.onupgradeneeded=()=>{for(const name of ['archives','headers','control','partials','chunks'])r.result.createObjectStore(name);};r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});
 await new Promise((resolve,reject)=>{const tx=db.transaction('control','readwrite');tx.objectStore('control').put({...policy.defaults,runtimeBytes:policy.mib},'limits');tx.oncomplete=resolve;tx.onabort=()=>reject(tx.error);});db.close();
 const cache=await w.caches.open('scribyra-runtime-verified-v1');await cache.put(new Request('https://scribyra.test/__scribyra-runtime/old'),new Response(new Uint8Array(policy.mib),{headers:{'Content-Length':String(policy.mib)}}));
 const put=IDBObjectStore.prototype.put;IDBObjectStore.prototype.put=function(...args){if(this.name==='control')throw new DOMException('Full','QuotaExceededError');return put.apply(this,args);};
 try{assert.equal((await w.fetch()).status,200);}finally{IDBObjectStore.prototype.put=put;}
 assert.equal(await cache.match(new Request('https://scribyra.test/__scribyra-runtime/old')),undefined);assert.equal((await w.message('scribyra-runtime-status')).ready,true);
});
test('runtime cancellation survives navigation with a same-origin UUID capability and rejects other origins or unknown tokens',async()=>{
 for(const source of [null,{id:'after-navigation'}]){
  const w=worker(),id='f2a7cb9c-1f69-49b6-8e2a-3a937ae93c98';let networkSignal,started;const waiting=new Promise(resolve=>{started=resolve;});
  w.network=async(_,{signal})=>{networkSignal=signal;started();return new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));};
  const pending=w.fetch(undefined,{id,clientId:'before-navigation'});await waiting;
  await w.message('scribyra-runtime-cancel',{id},{origin:'https://other.test',source});assert.equal(networkSignal.aborted,false);
  await w.message('scribyra-runtime-cancel',{id:'unknown'},{source});assert.equal(networkSignal.aborted,false);
  await w.message('scribyra-runtime-cancel',{id},{source});assert.equal(networkSignal.aborted,true);assert.equal((await pending).status,502);
 }
});


test('baseline loader records existing body reads and checksum outcomes without another read or private labels',async()=>{
 const events=[],observe=operation=>({end:(...args)=>events.push({operation,args})});
 const success=await preload(new Response(new Uint8Array([1,2,3])),observe);assert.equal(success.result.ok,true);
 assert(events.some(event=>event.operation==='download'&&event.args[0]==='success'&&event.args[2][0].value===3));assert(events.some(event=>event.operation==='verify'&&event.args[0]==='success'));
 events.length=0;const bad=await preload(new Response(new Uint8Array([1,2,4])),observe);assert.match(bad.result.exception,/checksum/);assert(events.some(event=>event.operation==='verify'&&event.args[1]==='integrity'));assert.equal(bad.installed,undefined);
 const broken=await preload(new Response(new Uint8Array([1,2,3])),()=>{throw Error('PRIVATE_OBSERVER');});assert.equal(broken.result.ok,true);
 assert.doesNotMatch(JSON.stringify(events),/baseline\.data|scribyra\.test|texlive/);
});
