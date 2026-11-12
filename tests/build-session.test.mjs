import 'fake-indexeddb/auto';
import './helpers/core.mjs';
import{test}from'node:test';import assert from'node:assert/strict';
import{buildSessions,buildCoordinator}from'../web/build-session.js';
import {TelemetryRecorder} from '../web/pkg/scribyra_app.js';
import {telemetry} from '../web/telemetry.js';
import{validate_exchange}from'../web/pkg/scribyra_app.js';
test('cancelled/closed build identities cannot publish or cancel a later project build',()=>{
 let stopped=0;const host=buildSessions(()=>stopped++),first=host.start('one','r1');
 assert.throws(()=>host.start('one','r2'),/already/);first.check();host.cancel();assert.equal(stopped,1);assert.throws(()=>first.check(),{name:'AbortError'});host.cancel();assert.equal(stopped,1);
 assert.equal(first.projectId,'one');assert.equal(first.revision,'r1');assert.notEqual(buildSessions(()=>{}).start('one','r1').id,first.id);
 first.finish();const next=host.start('two','r3');first.cancel();assert.equal(stopped,1);next.check();assert.equal(first.current(),false);
 host.close();assert.equal(stopped,2);assert.throws(()=>next.check(),{name:'AbortError'});const third=host.start('three','r4');next.finish();third.check();third.finish();host.close();assert.equal(stopped,3,'closing an idle workspace must terminate its retained compiler');
});
test('WASM transport validation uses trusted grant scope and never treats ciphertext storage as command access',()=>{
 const grant={projectId:'p',deviceId:'d',sessionId:'s',nextSequence:1,command:null,plaintextReplication:false,ciphertextStorage:true};
 const packet={version:1,projectId:'p',deviceId:'d',sessionId:'s',sequence:1,payload:{kind:'ciphertext',object:{hash:'a'.repeat(64),size:32},keyEpoch:1,nonce:'b'.repeat(48)}};
 const check=(p=packet,g=grant)=>JSON.parse(validate_exchange(JSON.stringify(p),JSON.stringify(g)));
 assert.deepEqual(check(),packet);assert.throws(()=>check({...packet,sequence:2}));assert.throws(()=>check({...packet,sessionId:'forged'}));
 assert.throws(()=>check({...packet,payload:{kind:'replica',object:packet.payload.object}}));assert.throws(()=>check({...packet,capabilities:['write']}));
 const command={...packet,payload:{kind:'command',request:{version:1,requestId:'q',projectId:'p',expectedRevision:'r',command:{op:'project.inspect'}}}};
 assert.throws(()=>check(command));const authorized={...grant,command:{projectId:'p',revision:'r',capabilities:['read']}};assert.deepEqual(check(command,authorized),command);
});

import {isolatedBuilds} from './helpers/foundation-regressions.js';
test('isolated previews share cancellation and contention while preserving accepted artifacts',async()=>{
 const result=await isolatedBuilds();assert.deepEqual(result,{acceptedBusy:'browser_busy',previewBusy:'browser_busy',preserved:true,copied:true,cancelledResult:'AbortError',closedResult:'AbortError',previews:2,acceptedPdf:[6],stopped:3,uniqueJobs:true,busy:[true,false,true,false,true,false,true,false,true,false,false]});
});
test('isolated build data preserves the live parent trace capability through compiler dispatch',async()=>{
 const recorder=new TelemetryRecorder(),diagnostics=telemetry({recorder});diagnostics.configure({collect:true,allowExport:true});
 try{
  const parent=diagnostics.begin('compile'),bytes=new Uint8Array([1,2,3]),inputs={files:[{path:'asset',content:bytes}],telemetryParent:parent.context};
  const builds=buildCoordinator(async received=>{
   await Promise.resolve();assert.deepEqual([...received.files[0].content],[1,2,3]);
   diagnostics.begin('worker_pass',received.telemetryParent).end('success');return{success:true};
  },()=>{});
  const pending=builds.run({projectId:'p',revision:'r',inputs,destination:()=>{}});bytes[0]=9;await pending;parent.end('success');
  const child=diagnostics.snapshot().events.find(e=>e.operation==='worker_pass'&&e.outcome==='success');
  assert.ok(child);assert.equal(child.traceId,parent.context.traceId);assert.equal(child.parentSpanId,parent.context.spanId);
 }finally{recorder.free();}
});
