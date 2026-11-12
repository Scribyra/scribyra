import './helpers/core.mjs';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {TelemetryRecorder} from '../web/pkg/scribyra_app.js';
import {telemetry} from '../web/telemetry.js';
import {telemetryExport} from '../web/telemetry-export.js';
const token='a'.repeat(64),endpoint='http://127.0.0.1:8789/v1/events';
function setup(fetcher){let tick=0;const transport=telemetryExport({originUnixMs:Date.now(),clock:()=>tick,random:bytes=>bytes.fill(1),fetcher,jitter:()=>.5}),recorder=new TelemetryRecorder(),api=telemetry({recorder,clock:()=>tick,onRecord:transport.enqueue,onControls:s=>transport.collection(s.collect),onClear:transport.clear});return{api,transport,recorder,advance:ms=>tick+=ms,connect(){api.configure({collect:true});transport.configure({enabled:true,endpoint,token});},close(){transport.close();recorder.free();}};}
test('export is absent by default and only Rust-accepted records enter a credential-free body',async()=>{
 const calls=[],h=setup(async(url,options)=>{calls.push({url,...options});return new Response('{}',{status:202});});
 try{
  h.api.begin('compile').end();await h.transport.flush();assert.equal(calls.length,0);
  h.connect();const span=h.api.begin('compile');h.advance(10);span.end('failure','source');
  const parent=h.api.begin('mcp');const valid={version:1,runtime:'worker',operation:'tex_pass',outcome:'success',traceId:parent.context.traceId,parentSpanId:parent.context.spanId,spanId:'b'.repeat(16),elapsedMs:0,metrics:[]};
  assert.equal(parent.accept({...valid,source:'PRIVATE_SOURCE Bearer SECRET'}),false);
  await h.transport.flush();assert.equal(calls.length,1);const request=calls[0],body=JSON.parse(request.body);assert.equal(body.events.length,3);
  assert.equal(request.headers.Authorization,`Bearer ${token}`);assert.equal(request.credentials,'omit');assert.equal(request.redirect,'error');assert.equal(request.referrerPolicy,'no-referrer');
  assert.doesNotMatch(request.body,/PRIVATE_SOURCE|Bearer|SECRET|127\.0\.0\.1/);assert(!request.body.includes(token));assert.equal(h.transport.status().sent,3);
  assert(!JSON.stringify(h.transport.configuration()).includes(token));assert(!JSON.stringify(h.transport.status()).includes(token));
 }finally{h.close();}
});
test('retry preserves the exact batch ID/body while queue size, age and attempts remain bounded',async()=>{
 const bodies=[];let rejected=true;const h=setup(async(_url,options)=>{bodies.push(options.body);return new Response('',{status:rejected?503:202});});
 try{
  h.connect();for(let i=0;i<200;i++)h.api.begin('cache').end();
  assert(h.transport.status().pending<=128);assert(h.transport.status().bufferedBytes<=32768);assert(h.transport.status().dropped>0);
  await h.transport.flush();rejected=false;await h.transport.flush();assert.equal(bodies[0],bodies[1]);assert.equal(JSON.parse(bodies[0]).delivery.dropped,272);
  assert(h.transport.status().bufferedBytes<70000);assert.equal(h.transport.status().sent,32);
  h.advance(300001);await h.transport.flush();assert.equal(h.transport.status().pending,0);
  h.api.begin('cache').end();rejected=true;for(let i=0;i<3;i++)await h.transport.flush();assert.equal(h.transport.status().pending,0);
 }finally{h.close();}
});
test('slow or rejecting collection never blocks recording; disabling/clearing aborts and discards stale work',async()=>{
 let signal,started=0;const h=setup(async(_url,options)=>{started++;signal=options.signal;return new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>reject(new DOMException('Cancelled','AbortError')),{once:true}));});
 try{
  h.connect();h.api.begin('storage_commit').end();const sending=h.transport.flush();assert.equal(started,1);assert.equal(h.api.begin('command').end(),true);
  h.api.clear();assert(signal.aborted);await sending;assert.equal(h.transport.status().pending,0);assert.equal(h.api.snapshot().events.length,0);
  h.api.begin('compile').end();const another=h.transport.flush();h.api.configure({collect:false});assert(signal.aborted);await another;assert.equal(h.transport.status().enabled,false);
  h.api.configure({collect:true});h.api.begin('compile').end();await h.transport.flush();assert.equal(started,2);
  assert.doesNotThrow(()=>h.transport.configure({enabled:false}));
 }finally{h.close();}
});
test('sampling stays consistent per trace and invalid destinations or credentials never start requests',async()=>{
 const calls=[],h=setup(async(_url,options)=>{calls.push(options);return new Response('',{status:401});});
 try{
  h.api.configure({collect:true});for(const url of ['http://private.invalid/v1/events','https://user:secret@example.com/v1/events','https://example.com/v1/events?token=SECRET','https://example.com/wrong'])assert.throws(()=>h.transport.configure({enabled:true,endpoint:url,token}));
  h.transport.configure({enabled:true,endpoint,token,sampleRate:.1});
  h.api.join('mcp',{traceId:'f'.repeat(32),spanId:'b'.repeat(16)}).end();assert.equal(h.transport.status().sampled,2);assert.equal(h.transport.status().pending,0);
  h.api.join('mcp',{traceId:'01'.repeat(16),spanId:'b'.repeat(16)}).end();await h.transport.flush();assert.equal(calls.length,1);assert.equal(h.transport.status().blocked,true);assert.equal(h.transport.status().error,'permission');
  h.api.begin('cache').end();await h.transport.flush();assert.equal(calls.length,1);
 }finally{h.close();}
});
test('activity source is closed, explicit, and carried in the batch envelope',async()=>{
 const bodies=[],h=setup(async(_url,options)=>{bodies.push(JSON.parse(options.body));return new Response('',{status:202});});
 try{
  h.connect();h.api.begin('command').end();await h.transport.flush();assert.equal(bodies[0].source,'application');
  h.transport.configure({enabled:true,endpoint,token,source:'local_test'});h.api.begin('command').end();await h.transport.flush();assert.equal(bodies[1].source,'local_test');
  assert.throws(()=>h.transport.configure({enabled:true,endpoint,token,source:'PRIVATE_SOURCE'}));
 }finally{h.close();}
});
