import 'fake-indexeddb/auto';
import './helpers/core.mjs';
import {test,afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash,webcrypto} from 'node:crypto';
import vm from 'node:vm';
import * as Y from 'yjs';
import {TelemetryRecorder} from '../web/pkg/scribyra_app.js';
import {telemetry} from '../web/telemetry.js';
import {installObservability,observe,observed} from '../web/observability.js';
import {patchCompilerWorker} from '../scripts/patch-compiler-worker.mjs';
import {addFile} from '../web/model.js';
import {saveProject,loadProject,preserveRecoveryProject} from '../web/storage.js';
import {downloads} from '../web/downloads.js';
import {projectCommands} from '../web/commands.js';

afterEach(()=>installObservability(undefined));
function recording(){const recorder=new TelemetryRecorder(),api=telemetry({recorder});api.configure({collect:true,allowExport:true});installObservability(api);return{api,recorder};}
const original=readFileSync(new URL('fixtures/compiler/busytex_worker.js',import.meta.url),'utf8');

test('the fresh pinned worker patch is idempotent and preserves compile results without diagnostics',async()=>{
 assert.equal(createHash('sha256').update(original).digest('hex'),'80eca56a2eb015bdfbebff26e539dd793407b73b6c1cd351170e6fdb6e17c39a');
 const source=patchCompilerWorker(original);assert.equal(patchCompilerWorker(source),source);
 assert.throws(()=>patchCompilerWorker(original.replace('write_texlive_remote_misses } })','changed } })')),/Unexpected/);
 const result={pdf:new Uint8Array([1]),exit_code:0,log:'PRIVATE_SOURCE'};const messages=[];
 const context=vm.createContext({importScripts(){},postMessage:m=>messages.push(m),performance,crypto:webcrypto,self:{}});
 vm.runInContext(source,context);context.self.pipeline={compile:async(...args)=>{assert.equal(args[1],'PRIVATE_FILE.tex');return result;}};
 await context.onmessage({data:{files:[],main_tex_path:'PRIVATE_FILE.tex'}});assert.equal(messages[0],result);
});

test('actual classic worker success/failure events correlate and exclude input and exception text',async()=>{
 const {api,recorder}=recording();
 try{
  const parent=observe('compile'),messages=[];let fail=false;
  const result={pdf:new Uint8Array([1,2]),exit_code:0,log:'PRIVATE_SOURCE'};
  const context=vm.createContext({importScripts(){},postMessage:m=>messages.push(m),performance,crypto:webcrypto,self:{}});
  context.self.postMessage=context.postMessage;
  vm.runInContext(patchCompilerWorker(original),context);
  context.self.pipeline={Module:Promise.resolve({HEAPU8:new Uint8Array(1024)}),compile:async()=>{if(fail)throw Error('SEEDED_SECRET');return result;}};
  await context.onmessage({data:{files:[{path:'PRIVATE_FILE.tex',contents:'PRIVATE_SOURCE'}],scribyra_telemetry:parent.context}});
  for(const message of messages)for(const event of message.scribyraTelemetry||[])assert.equal(parent.accept(event),true);
  const worker=api.snapshot().events.filter(e=>e.runtime==='worker'&&e.operation==='worker_pass');assert.equal(worker.length,2);
  assert.equal(worker[1].traceId,parent.context.traceId);assert.equal(worker[1].parentSpanId,parent.context.spanId);
  assert.deepEqual(worker[1].metrics.filter(m=>m.name!=='duration_ms'),[{name:'bytes',value:2},{name:'memory_bytes',value:1024}]);
  fail=true;messages.length=0;await context.onmessage({data:{files:[],scribyra_telemetry:parent.context}});
  for(const message of messages)for(const event of message.scribyraTelemetry||[])assert.equal(parent.accept(event),true);
  assert.equal(api.snapshot().events.at(-1).error,'worker');
  assert.doesNotMatch(api.export(),/PRIVATE_SOURCE|PRIVATE_FILE|SEEDED_SECRET/);
 }finally{recorder.free();}
});

test('worker ingestion rejects forged, excessive, private, completed and revoked events',()=>{
 const {api,recorder}=recording();
 try{
  const span=observe('compile'),event={version:1,runtime:'worker',operation:'worker_pass',outcome:'success',elapsedMs:0,
   traceId:span.context.traceId,parentSpanId:span.context.spanId,spanId:'abcdef0123456789',metrics:[]};
  assert.equal(span.accept(event),true);
  for(const patch of [{traceId:'f'.repeat(32)},{parentSpanId:'f'.repeat(16)},{runtime:'browser'},{elapsedMs:1e10},{message:'PRIVATE_SOURCE'}])assert.equal(span.accept({...event,...patch}),false);
  span.end();assert.equal(span.accept(event),false);
  const second=observe('compile');api.clear();assert.equal(second.accept({...event,traceId:second.context.traceId,parentSpanId:second.context.spanId}),false);
  assert.deepEqual(api.snapshot().events,[]);
 }finally{recorder.free();}
});

test('broken diagnostics never change operation values or error identity',async()=>{
 const broken=()=>{throw Error('SECRET');};installObservability({begin:()=>({context:{},end:broken,accept:broken})});
 const value={private:'PRIVATE_SOURCE'},error=Error('Original failure');let calls=0;
 assert.equal(await observed('storage_commit',()=>{calls++;return value;}),value);
 await assert.rejects(observed('storage_commit',()=>{throw error;}),e=>e===error);assert.equal(calls,1);
 installObservability({begin:broken});assert.equal(await observed('compile',()=>value),value);
});

test('actual command permission and revision failures remain typed and content free',()=>{
 const {api,recorder}=recording(),doc=new Y.Doc();let host;
 try{
  const file=addFile(doc,'PRIVATE_FILE.tex','PRIVATE_SOURCE');
  host=projectCommands({doc,projectId:'PRIVATE_PROJECT',capabilities:['read']});
  assert.throws(()=>host.run({op:'node.delete',id:file}),error=>error.code==='permission_denied');host.close();
  host=projectCommands({doc,projectId:'PRIVATE_PROJECT'});const revision=host.revision();doc.getText('text:'+file).insert(0,'SECRET_EDIT');
  assert.throws(()=>host.run({op:'node.delete',id:file},revision),error=>error.code==='revision_conflict');
  assert.ok(api.snapshot().events.some(e=>e.operation==='command'&&e.error==='permission'));
  assert.ok(api.snapshot().events.some(e=>e.operation==='command'&&e.error==='conflict'));
  assert.doesNotMatch(api.export(),/PRIVATE_SOURCE|PRIVATE_FILE|PRIVATE_PROJECT|SECRET_EDIT/);
 }finally{host?.close();doc.destroy();recorder.free();}
});

test('durable saves, quota rollback and recovery emit outcomes without project data',async()=>{
 const {api,recorder}=recording(),doc=new Y.Doc(),id=crypto.randomUUID();
 try{
  const file=addFile(doc,'PRIVATE_FILE.tex','PRIVATE_SOURCE');doc.getMap('meta').set('name','PRIVATE_PROJECT');
  await saveProject(id,doc);const first=api.snapshot().events.find(e=>e.operation==='storage_commit'&&e.outcome==='success');assert.ok(first.metrics.some(m=>m.name==='bytes'&&m.value>0));
  doc.getText('text:'+file).insert(0,'SECRET_EDIT');
  const put=IDBObjectStore.prototype.put;
  IDBObjectStore.prototype.put=function(...args){if(this.name==='journal')throw new DOMException('SEEDED_SECRET','QuotaExceededError');return put.apply(this,args);};
  try{await assert.rejects(saveProject(id,doc),{name:'QuotaExceededError'});}finally{IDBObjectStore.prototype.put=put;}
  assert.ok(api.snapshot().events.some(e=>e.operation==='storage_commit'&&e.error==='quota'));
  const loaded=await loadProject(id);assert.equal(loaded.getText('text:'+file).toString(),'PRIVATE_SOURCE');loaded.destroy();
  await preserveRecoveryProject(id,doc);assert.ok(api.snapshot().events.some(e=>e.operation==='recovery'&&e.outcome==='success'));
  assert.doesNotMatch(api.export(),/PRIVATE_SOURCE|PRIVATE_FILE|PRIVATE_PROJECT|SECRET_EDIT|SEEDED_SECRET/);
 }finally{doc.destroy();recorder.free();}
});

test('verified downloads expose byte counts, real retry and integrity failure without URLs or labels',async()=>{
 const {api,recorder}=recording();
 try{
  const bytes=new Uint8Array(1200000),asset={kind:'runtime',label:'PRIVATE_LABEL',size:bytes.length,algorithm:'SHA-256',hash:createHash('sha256').update(bytes).digest('hex')};
  await assert.rejects(downloads.fetchBytes(asset,{url:'https://SECRET.invalid/token',fetcher:async()=>new Response(new ReadableStream({start(c){c.enqueue(bytes.slice(0,1100000));c.error(Error('SEEDED_SECRET'));}}))}));
  // Persist a partial response so a hidden Content-Range forces a real retry.
  let emitted=false;await assert.rejects(downloads.fetchBytes(asset,{url:'/SECRET',fetcher:async()=>new Response(new ReadableStream({pull(c){if(!emitted){emitted=true;c.enqueue(bytes.slice(0,1100000));}else c.error(Error('PRIVATE_SOURCE'));}}))}));
  let calls=0;const result=await downloads.fetchBytes(asset,{url:'/SECRET',fetcher:async()=>{calls++;return calls===1?new Response(bytes.slice(1100000),{status:206}):new Response(bytes);}});
  assert.deepEqual(result,bytes);assert.equal(calls,2);
  assert.ok(api.snapshot().events.some(e=>e.operation==='retry'&&e.outcome==='success'));
  assert.ok(api.snapshot().events.some(e=>e.operation==='verify'&&e.outcome==='success'));
  const corrupt=bytes.slice();corrupt[0]=1;await assert.rejects(downloads.fetchBytes(asset,{url:'/SECRET',fetcher:async()=>new Response(corrupt)}),/checksum/);
  assert.ok(api.snapshot().events.some(e=>e.operation==='download'&&e.error==='integrity'));
  assert.doesNotMatch(api.export(),/PRIVATE_LABEL|SECRET|PRIVATE_SOURCE/);
 }finally{recorder.free();}
});
