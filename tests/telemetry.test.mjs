import './helpers/core.mjs';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {TelemetryRecorder} from '../web/pkg/scribyra_app.js';
import {telemetry} from '../web/telemetry.js';

test('actual WASM recorder enforces privacy, bounds, clearing and export controls',()=>{
 const recorder=new TelemetryRecorder();let seq=0;
 const api=telemetry({recorder,clock:()=>seq++,random:bytes=>{bytes.fill(1);return bytes;}});
 try {
  assert.throws(()=>api.export(),error=>String(error)==='Diagnostic export is disabled');
  api.configure({collect:true,allowExport:true});
  api.begin('compile').end('failure','source',[{name:'bytes',value:1024}]);
  const first=api.snapshot().events[0];
  for(const key of ['message','log','source','url','headers','projectName','file']) {
   assert.equal(recorder.record(JSON.stringify({...first,[key]:'PRIVATE_SOURCE Bearer SEEDED_SECRET'})),false);
  }
  for(let i=0;i<200;i++)api.begin('cache').end();
  const snapshot=api.snapshot();assert.equal(snapshot.events.length,256);
  assert.equal(snapshot.rejected,7);assert.equal(snapshot.dropped,146);
  assert.ok(snapshot.bufferedBytes<=64*1024);
  assert.doesNotMatch(api.export(),/PRIVATE_SOURCE|SEEDED_SECRET/);
  api.configure({collect:false,allowExport:false});assert.equal(api.snapshot().events.length,0);
  assert.throws(()=>api.export());
 } finally {recorder.free();}
});

test('actual WASM byte budget evicts large records before the event-count limit',()=>{
 const recorder=new TelemetryRecorder();recorder.configure(true,true);
 try {
  const input=JSON.stringify({version:1,runtime:'companion',operation:'package_prepare',outcome:'failure',error:'unavailable',
   traceId:'123456789abcdef0123456789abcdef0',spanId:'123456789abcdef0',parentSpanId:'abcdef0123456789',elapsedMs:31536000000,
   metrics:['duration_ms','bytes','memory_bytes','count'].map(name=>({name,value:9007199254740991}))});
  for(let i=0;i<300;i++)assert.equal(recorder.record(input),true);
  const snapshot=JSON.parse(recorder.snapshot());assert.ok(snapshot.events.length<256);
  assert.ok(snapshot.bufferedBytes<=64*1024);assert.equal(snapshot.dropped,300-snapshot.events.length);
 } finally {recorder.free();}
});
