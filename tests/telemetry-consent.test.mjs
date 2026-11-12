import './helpers/core.mjs';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {gunzipSync} from 'node:zlib';
import {TelemetryRecorder,telemetry_consent_record} from '../web/pkg/scribyra_app.js';
import {telemetry} from '../web/telemetry.js';
import {telemetryExport} from '../web/telemetry-export.js';
const event={version:1,runtime:'browser',operation:'compile',outcome:'failure',error:'source',traceId:'b'.repeat(32),spanId:'c'.repeat(16),elapsedMs:10,metrics:[{name:'duration_ms',value:10},{name:'bytes',value:1024},{name:'memory_bytes',value:2048},{name:'count',value:2}]};
for(const category of ['performance','errors','usage'])test(`${category} consent admits only its own fields through actual WASM`,()=>{
 const projected=JSON.parse(telemetry_consent_record(JSON.stringify(event),category==='performance',category==='errors',category==='usage'));
 assert.equal(projected.elapsedMs,60000);assert.deepEqual(projected.metrics.map(m=>m.name),category==='performance'?['duration_ms','bytes','memory_bytes']:category==='usage'?['count']:[]);
 assert.equal(projected.outcome,category==='errors'?'failure':'observed');assert.equal(projected.error,category==='errors'?'source':undefined);
 assert.equal(telemetry_consent_record(JSON.stringify({...event,outcome:'started',error:undefined,metrics:[]}),true,true,true),undefined);
 assert.equal(telemetry_consent_record(JSON.stringify({...event,source:'PRIVATE_SOURCE'}),true,true,true),undefined);
});
test('no consent admits nothing; error-only consent drops successes and malformed records',()=>{
 assert.equal(telemetry_consent_record(JSON.stringify(event),false,false,false),undefined);
 assert.equal(telemetry_consent_record(JSON.stringify({...event,outcome:'success',error:undefined}),false,true,false),undefined);
 assert.equal(telemetry_consent_record('PRIVATE_SOURCE',true,true,true),undefined);
});
test('per-edit operations leave no record under any consent',()=>{
 for(const operation of ['storage_commit','local_tabs','command','workspace_search','source_outline','source_map','sync','sync_io','provider','mcp'])assert.equal(telemetry_consent_record(JSON.stringify({...event,operation}),true,true,true),undefined);
});
test('sizes keep at most eleven buckets across the whole package catalog',()=>{
 const sizes=Object.values(JSON.parse(gunzipSync(readFileSync('web/tex-catalog.json.gz'))).packages).map(p=>p.size);
 assert(sizes.length>2000);assert(new Set(sizes).size>1000);
 const sent=new Set(sizes.map(size=>JSON.parse(telemetry_consent_record(JSON.stringify({...event,outcome:'success',error:undefined,elapsedMs:1e7,metrics:[{name:'bytes',value:size}]}),true,false,false)).metrics[0].value));
 assert(sent.size<=11,`${sent.size} buckets`);for(const value of sent)assert(value===0||Math.log(value)/Math.log(4)%1===0,String(value));
});
test('performance and usage cannot reveal error-only operation names',()=>{
 for(const operation of ['exception','rejection','storage_quota','retry','recovery']){
  const encoded=JSON.stringify({...event,operation});
  assert.equal(telemetry_consent_record(encoded,true,false,true),undefined);
  assert.equal(JSON.parse(telemetry_consent_record(encoded,false,true,false)).operation,operation);
 }
});
test('consented recording leaves local collection, reviewed exports and revocation independent',()=>{
 const recorder=new TelemetryRecorder(),sent=[],local=[];
 const api=telemetry({recorder,onRecord:e=>local.push(e),onRemoteRecord:e=>{const projected=telemetry_consent_record(e,true,false,false);if(projected)sent.push(projected);return !!projected;}});
 try{
  api.begin('compile').end();assert.equal(sent.length,0);api.remoteCollection(true);
  api.begin('compile').end();assert.equal(sent.length,1);assert.deepEqual(api.snapshot().events,[]);assert.throws(()=>api.export());assert.equal(local.length,0);
  const stale=api.begin('compile');api.remoteCollection(false);stale.end();api.begin('compile').end();assert.equal(sent.length,1);
  api.configure({collect:true,allowExport:true});api.begin('compile').end();assert.equal(local.length,2);assert.equal(JSON.parse(api.export()).events.length,2);
 }finally{recorder.free();}
});
test('anonymous exporter has no authorization header and revocation aborts and discards queued batches',async()=>{
 let signal,request;const transport=telemetryExport({anonymous:true,originUnixMs:Date.now(),fetcher:async(_url,options)=>{request=options;signal=options.signal;return new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>reject(Error('cancelled'))));}});
 try{
  transport.collection(true);transport.configure({enabled:true,endpoint:'http://127.0.0.1:6101/v1/browser-events'});transport.enqueue(JSON.stringify(event));const pending=transport.flush();
  assert.equal(request.headers.Authorization,undefined);transport.enqueue(JSON.stringify(event));transport.configure({enabled:false});assert(signal.aborted);assert.equal(transport.status().pending,0);await pending;
 }finally{transport.close();}
});

// docs/telemetry.md: direct sessions add no telemetry operation. Their signalling,
// identities, rooms and peers stay out of every record; their project changes are
// ordinary local-only `command` and `storage_commit` work.
test('direct-session modules record nothing themselves',async()=>{
 const {readFile,readdir}=await import('node:fs/promises');
 const files=(await readdir(new URL('../web/',import.meta.url))).filter(name=>/^direct-.*\.js$/.test(name)||name==='service-client.js');
 assert(files.length>=5,files.join());
 for(const name of files){
  const text=await readFile(new URL('../web/'+name,import.meta.url),'utf8');
  assert.doesNotMatch(text,/observability|telemetry|observe\(|observed\(/,name);
 }
});
