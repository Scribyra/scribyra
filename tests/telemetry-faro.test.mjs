import './helpers/core.mjs';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFileSync} from 'node:fs';
import {telemetry_consent_record,telemetry_faro_batch} from '../web/pkg/scribyra_app.js';
import {telemetryExport} from '../web/telemetry-export.js';
import {telemetryDestination} from '../web/telemetry-destination.js';
import {officialTelemetryEndpoint} from '../scripts/official-telemetry.mjs';
import {faroVerdict,faroPreflightAllows,FARO_MISSING_SESSION,FARO_MISSING_SDK,FARO_SESSION_MISMATCH} from './helpers/faro-collector.mjs';
const event={version:1,runtime:'worker',operation:'compile',outcome:'failure',error:'source',traceId:'b'.repeat(32),spanId:'c'.repeat(16),parentSpanId:'d'.repeat(16),elapsedMs:10,metrics:[{name:'duration_ms',value:10},{name:'bytes',value:1024},{name:'memory_bytes',value:2048},{name:'count',value:2}]};
const identity={version:'0.1.0',revision:'e'.repeat(40),dirty:false,compilerAdapterSha256:'f'.repeat(64)};
const appMeta={name:'scribyra',version:'0.1.0',gitHash:identity.revision,release:'clean',bundleId:identity.compilerAdapterSha256};
const sdk={name:'scribyra',version:JSON.parse(readFileSync(new URL('../package.json',import.meta.url),'utf8')).version};
// Strict like production: it rejects what the real collector rejects, and only then
// can a test choose another status to simulate an outage.

async function collector(){
 const calls=[];let status=202;
 const server=createServer(async(req,res)=>{let body='';for await(const chunk of req)body+=chunk;const verdict=faroVerdict(req.headers,body);calls.push({headers:req.headers,body:JSON.parse(body),encoded:body,verdict});if(verdict.status!==202){res.writeHead(verdict.status);res.end(verdict.message);return;}res.writeHead(status,{'Retry-After':'1'});res.end();});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 return{calls,endpoint:`http://127.0.0.1:${server.address().port}/collect`,status:value=>status=value,close:()=>{server.closeAllConnections();return new Promise(resolve=>server.close(resolve));}};
}
test('Faro fake HTTP collector receives the exact consented schema for all eight category combinations',async()=>{
 const c=await collector(),originUnixMs=Date.now();
 try{
  for(const performance of [false,true])for(const errors of [false,true])for(const usage of [false,true]){
   const transport=telemetryExport({anonymous:true,identity,originUnixMs,random:bytes=>bytes.fill(1)});
   try{
    transport.collection(true);transport.configure({enabled:true,endpoint:c.endpoint,usage});
    await transport.flush();const before=c.calls.length;
    const projected=telemetry_consent_record(JSON.stringify(event),performance,errors,usage);
    if(projected)transport.enqueue(projected);
    await transport.flush();
    if(!projected){assert.equal(c.calls.length,before);continue;}
    assert.equal(c.calls.length,before+1);const call=c.calls.at(-1);
    const timestamp=new Date(Math.floor((originUnixMs+60000)/60000)*60000).toISOString(),trace={trace_id:event.traceId,span_id:event.spanId},context={runtime:'worker',source:'application',parent_span_id:event.parentSpanId,dropped:'0',sampled:'0',sampling_rate:'1'};
    const expected={meta:{sdk,app:appMeta,session:{id:call.headers['x-faro-session-id']}}};assert.match(call.headers['x-faro-session-id'],/^[a-f0-9]{16}$/);assert.equal(call.verdict.status,202);
    if(performance)expected.measurements=[{type:'compile',values:{duration_ms:10,bytes:1024,memory_bytes:2048},timestamp,trace,context}];
    if(usage)expected.events=[{name:'compile',timestamp,trace,attributes:{...context,count:'2'}}];
    if(errors)expected.exceptions=[{type:'compile',value:'source',timestamp,trace,context:{...context,outcome:'failure'}}];
    assert.deepEqual(call.body,expected);assert.equal(call.headers.authorization,undefined);assert.equal(call.headers.cookie,undefined);assert.equal(call.headers.referer,undefined);assert.equal(call.headers['idempotency-key'],undefined);assert.deepEqual(Object.keys(call.headers).filter(name=>!['host','connection','content-length','accept','accept-language','accept-encoding','sec-fetch-mode','user-agent','cache-control','pragma'].includes(name)).sort(),['content-type','x-faro-session-id']);assert.equal(transport.status().sent,1);
   }finally{transport.close();}
  }
 }finally{await c.close();}
});
test('Faro projection rejects seeded private fields in the actual WASM and never sends them',async()=>{
 const c=await collector(),originUnixMs=Date.now(),transport=telemetryExport({anonymous:true,originUnixMs,random:bytes=>bytes.fill(1)});
 try{
  transport.collection(true);transport.configure({enabled:true,endpoint:c.endpoint,usage:true});
  const seed='PRIVATE_SOURCE paper.tex /private/path prompt Bearer SECRET';
  for(const field of ['source','projectId','url','headers','stacktrace','token','message']){
   const input=JSON.stringify({...event,[field]:seed});assert.equal(telemetry_consent_record(input,true,true,true),undefined);transport.enqueue(input);
  }
  for(const field of ['operation','runtime','error','traceId'])transport.enqueue(JSON.stringify({...event,[field]:seed}));
  await transport.flush();assert.equal(c.calls.length,0);assert.equal(transport.status().dropped,11);
  const batch={version:1,batchId:'a'.repeat(32),originUnixMs,events:[event]};
  for(const extra of [{url:seed},{identity:{...identity,version:seed}},{events:[{...event,metrics:[{name:seed,value:1}]}]}])assert.equal(telemetry_faro_batch(JSON.stringify({...batch,...extra}),Date.now(),true,'0123456789abcdef'),undefined);
  // The session ID is the only caller-chosen value, so it accepts only its own shape.
  assert.ok(telemetry_faro_batch(JSON.stringify(batch),Date.now(),true,'0123456789abcdef'));
  for(const session of ['',seed,'0'.repeat(16),'0123456789ABCDEF','0123456789abcde','0123456789abcdef0','"},"user":{"id":"x'])assert.equal(telemetry_faro_batch(JSON.stringify(batch),Date.now(),true,session),undefined);
  transport.enqueue(telemetry_consent_record(JSON.stringify(event),true,true,true));await transport.flush();assert.equal(c.calls.length,1);
  // The only session field is meta.session.id; nothing else about a session or user.
  const sent=c.calls[0];assert.deepEqual(sent.body.meta.session,{id:sent.headers['x-faro-session-id']});
  assert.doesNotMatch(sent.encoded.replace(`"session":{"id":"${sent.body.meta.session.id}"}`,''),/PRIVATE_SOURCE|paper\.tex|private\/path|prompt|Bearer|SECRET|stacktrace|session|user|page|url/);assert.deepEqual(Object.keys(sent.body.meta).sort(),['app','sdk','session']);
  assert.doesNotMatch(JSON.stringify(sent.headers),/PRIVATE_SOURCE|paper\.tex|private\/path|prompt|Bearer|SECRET/);
 }finally{transport.close();await c.close();}
});
test('Faro keeps retry bodies stable without custom headers, accepts 2xx, and silently drops rejection',async()=>{
 const c=await collector(),transport=telemetryExport({anonymous:true,originUnixMs:Date.now(),random:bytes=>bytes.fill(1)});
 try{
  transport.collection(true);transport.configure({enabled:true,endpoint:c.endpoint,usage:true});c.status(429);
  transport.enqueue(telemetry_consent_record(JSON.stringify(event),true,true,true));await transport.flush();c.status(204);await new Promise(resolve=>setTimeout(resolve,1001));await transport.flush();
  assert.equal(c.calls[0].encoded,c.calls[1].encoded);assert.equal(c.calls[0].headers['idempotency-key'],undefined);assert.equal(transport.status().sent,1);assert.equal(transport.status().failures,1);
  c.status(403);transport.enqueue(telemetry_consent_record(JSON.stringify(event),false,true,false));await transport.flush();assert.equal(transport.status().blocked,true);assert.equal(transport.status().pending,0);assert.equal(transport.status().dropped,1);
  transport.enqueue(telemetry_consent_record(JSON.stringify(event),false,true,false));await transport.flush();assert.equal(c.calls.length,3);
 }finally{transport.close();await c.close();}
});
test('Faro retains sampling, queue/age/attempt bounds and revocation under offline or slow transport',async()=>{
 let tick=0,signal,attempts=0;
 const transport=telemetryExport({anonymous:true,originUnixMs:Date.now(),clock:()=>tick,random:bytes=>bytes.fill(1),fetcher:async()=>{attempts++;throw TypeError('Offline');}});
 try{
  transport.collection(true);transport.configure({enabled:true,endpoint:'http://127.0.0.1:6101/collect',sampleRate:.1,usage:true});
  transport.enqueue(telemetry_consent_record(JSON.stringify(event),true,true,true));assert.equal(transport.status().sampled,1);
  transport.configure({enabled:true,endpoint:'http://127.0.0.1:6101/collect',usage:true});
  for(let i=0;i<200;i++)transport.enqueue(telemetry_consent_record(JSON.stringify(event),true,true,true));
  assert(transport.status().pending<=128);assert(transport.status().bufferedBytes<=32768);assert(transport.status().dropped>0);
  for(let i=0;i<3;i++)await transport.flush();assert.equal(attempts,3);assert(transport.status().pending<=96);
  tick=300001;await transport.flush();assert.equal(transport.status().pending,0);
 }finally{transport.close();}
 const slow=telemetryExport({anonymous:true,originUnixMs:Date.now(),random:bytes=>bytes.fill(1),fetcher:async(_url,options)=>{signal=options.signal;return new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>reject(Error('aborted'))));}});
 try{
  slow.collection(true);slow.configure({enabled:true,endpoint:'http://127.0.0.1:6101/collect',usage:true});slow.enqueue(telemetry_consent_record(JSON.stringify(event),true,true,true));const sending=slow.flush();slow.configure({enabled:false});assert(signal.aborted);await sending;assert.equal(slow.status().pending,0);
 }finally{slow.close();}
});
test('Faro and existing ingress destinations share strict validation without a source-build fallback',()=>{
 assert.equal(telemetryDestination(officialTelemetryEndpoint,true).faro,true);
 assert.equal(telemetryDestination('https://example.com/collect',true).faro,true);
 assert.equal(telemetryDestination('https://example.com/v1/browser-events',true).faro,false);
 for(const endpoint of ['http://example.com/collect','https://user:SECRET@example.com/collect','https://example.com/collect?token=SECRET','https://example.com/collect#SECRET','https://example.com/wrong'])assert.throws(()=>telemetryDestination(endpoint,true));
 assert.throws(()=>telemetryDestination(officialTelemetryEndpoint,false));
 assert.throws(()=>telemetryDestination('PRIVATE_SOURCE',true),{message:'Enter a telemetry endpoint.'});
});

function anonymous(fetcher,options={}){let tick=0;const transport=telemetryExport({anonymous:true,originUnixMs:Date.now(),clock:()=>tick,random:bytes=>bytes.fill(1),jitter:()=>.5,fetcher,...options});transport.collection(true);transport.configure({enabled:true,endpoint:'http://127.0.0.1:6101/collect',usage:true});return{transport,advance:ms=>tick+=ms};}
const record=()=>telemetry_consent_record(JSON.stringify(event),true,true,true);
for(const[name,fetcher]of [['500',async()=>new Response('',{status:500})],['429',async()=>new Response('',{status:429})],['dropped socket',async()=>{throw TypeError('Dropped');}]])test(`breaker pauses, doubles and finally stops the session on ${name}`,async()=>{
 let calls=0;const h=anonymous(async(...args)=>{calls++;return fetcher(...args);});
 try{
  h.transport.enqueue(record());for(let i=0;i<3;i++)await h.transport.flush();assert.equal(calls,3);
  // Open: repeated flushes and fresh records make no request until the pause ends.
  h.transport.enqueue(record());for(let i=0;i<5;i++)await h.transport.flush();assert.equal(calls,3);
  h.advance(60001);await h.transport.flush();assert.equal(calls,4);await h.transport.flush();assert.equal(calls,4);
  h.advance(60000);await h.transport.flush();assert.equal(calls,4);
  h.advance(60001);await h.transport.flush();assert.equal(calls,5);
  for(const pause of [240001,480001]){h.advance(pause);h.transport.enqueue(record());await h.transport.flush();}
  assert.equal(calls,7);assert.equal(h.transport.status().halted,true);assert.equal(h.transport.status().pending,0);
  h.advance(86400000);h.transport.enqueue(record());await h.transport.flush();assert.equal(calls,7);
  // A consent change must not be a way around the stop.
  h.transport.configure({enabled:false});h.transport.configure({enabled:true,endpoint:'http://127.0.0.1:6101/collect',usage:true});h.transport.enqueue(record());await h.transport.flush();assert.equal(calls,7);
 }finally{h.transport.close();}
});
test('a success closes the breaker; Retry-After is honoured beyond a single retry',async()=>{
 let status=503,calls=0;const h=anonymous(async()=>{calls++;return new Response(status===204?null:'',{status,headers:status===429?{'Retry-After':'200'}:{}});});
 try{
  h.transport.enqueue(record());await h.transport.flush();await h.transport.flush();status=204;await h.transport.flush();assert.equal(h.transport.status().sent,1);
  status=429;h.transport.enqueue(record());await h.transport.flush();assert.equal(calls,4);h.advance(199000);await h.transport.flush();assert.equal(calls,4);status=204;h.advance(1001);await h.transport.flush();assert.equal(calls,5);
 }finally{h.transport.close();}
});
test('session budget stops 2xx loops, carries across reloads and reports each request',async()=>{
 let calls=0,spent=0;const h=anonymous(async()=>{calls++;return new Response(null,{status:204});},{spent:238,onSpend:value=>spent=value});
 try{
  for(let i=0;i<5;i++){h.transport.enqueue(record());await h.transport.flush();}
  assert.equal(calls,2);assert.equal(spent,240);assert.equal(h.transport.status().halted,true);assert.equal(h.transport.status().error,'budget');assert.equal(h.transport.status().pending,0);
 }finally{h.transport.close();}
 let later=0;const reloaded=anonymous(async()=>{later++;return new Response(null,{status:204});},{spent});
 try{reloaded.transport.enqueue(record());await reloaded.transport.flush();assert.equal(later,0);assert.equal(reloaded.transport.status().halted,true);}finally{reloaded.transport.close();}
});
test('a refused consent check stops delivery before any request',async()=>{
 let calls=0,allowed=true;const h=anonymous(async()=>{calls++;return new Response(null,{status:204});},{allowed:()=>allowed});
 try{h.transport.enqueue(record());allowed=false;await h.transport.flush();assert.equal(calls,0);allowed=()=>{throw Error('Unreadable');};await h.transport.flush();assert.equal(calls,0);allowed=true;await h.transport.flush();assert.equal(calls,1);}finally{h.transport.close();}
});
test('anonymous delivery waits and spaces its requests, so arrival times cannot echo typing',async()=>{
 const waits=[],set=globalThis.setTimeout;globalThis.setTimeout=(work,delay,...rest)=>{waits.push(delay);return set(work,delay,...rest);};
 const h=anonymous(async()=>new Response(null,{status:204}));
 try{
  waits.length=0;h.transport.enqueue(record());assert(waits.at(-1)>=5000);await h.transport.flush();assert(waits.at(-1)>=8000||!waits.length);
  waits.length=0;h.transport.enqueue(record());assert(waits.at(-1)>=15000);
 }finally{h.transport.close();globalThis.setTimeout=set;}
});
test('the fake collector answers the probed production requests exactly as production did',()=>{
 const body=meta=>JSON.stringify({meta:{app:appMeta,...meta},exceptions:[]}),id='0123456789abcdef';
 assert.deepEqual(faroVerdict({'content-type':'application/json'},body({})),{status:400,message:FARO_MISSING_SESSION});
 assert.deepEqual(faroVerdict({'x-faro-session-id':id},body({})),{status:400,message:FARO_MISSING_SDK});
 assert.deepEqual(faroVerdict({'x-faro-session-id':id},body({session:{id}})),{status:400,message:FARO_MISSING_SDK});
 assert.deepEqual(faroVerdict({'x-faro-session-id':id},body({session:{id},sdk:{name:'scribyra'}})),{status:400,message:FARO_MISSING_SDK});
 assert.deepEqual(faroVerdict({'x-faro-session-id':id},body({sdk})),{status:400,message:FARO_SESSION_MISMATCH});
 assert.deepEqual(faroVerdict({'x-faro-session-id':id},body({sdk,session:{id:'f'.repeat(16)}})),{status:400,message:FARO_SESSION_MISMATCH});
 assert.equal(faroVerdict({'x-faro-session-id':id},body({sdk,session:{id}})).status,202);
 const preflight=headers=>faroPreflightAllows({'access-control-request-method':'POST',...headers});
 assert.equal(preflight({}),true);assert.equal(preflight({'access-control-request-headers':'content-type,x-faro-session-id'}),true);
 for(const extra of ['authorization','idempotency-key','x-api-key','content-type,x-faro-session-id,traceparent'])assert.equal(preflight({'access-control-request-headers':extra}),false);
});
test('the session ID is random, per transport, held in memory only, and rotates after four hours',async()=>{
 const c=await collector(),sessions=[];let tick=0;
 const make=(options={})=>{const t=telemetryExport({anonymous:true,identity,originUnixMs:Date.now(),clock:()=>tick,...options});t.collection(true);t.configure({enabled:true,endpoint:c.endpoint,usage:true});return t;};
 const send=async t=>{t.enqueue(telemetry_consent_record(JSON.stringify(event),true,true,true));await t.flush();const call=c.calls.at(-1);assert.equal(call.verdict.status,202,call.verdict.message);assert.equal(call.body.meta.session.id,call.headers['x-faro-session-id']);sessions.push(call.headers['x-faro-session-id']);return sessions.at(-1);};
 const first=make({spent:7});
 try{
  const a=await send(first);assert.match(a,/^[a-f0-9]{16}$/);
  tick+=15000;assert.equal(await send(first),a,'one session within the hour');
  tick=4*3600000-1;assert.equal(await send(first),a,'still one session just under four hours');
  tick=4*3600000;const rotated=await send(first);assert.notEqual(rotated,a,'rotated at four hours');
  first.clear();tick+=15000;const cleared=await send(first);assert.notEqual(cleared,rotated,'clearing starts a new session');
  first.configure({enabled:false});first.configure({enabled:true,endpoint:c.endpoint,usage:true});tick+=15000;assert.notEqual(await send(first),cleared,'a consent change starts a new session');
  // A second tab or a reload is a new transport. Same budget, same clock: still unrelated.
  const second=make({spent:7});try{assert.notEqual(await send(second),sessions.at(-2));}finally{second.close();}
  assert.equal(new Set(sessions).size,sessions.length-2,'only the two in-window repeats share an ID');
  // It never echoes a trace or span ID, the build identity or the request budget.
  for(const id of new Set(sessions)){for(const other of [event.traceId,event.spanId,event.parentSpanId,identity.revision,identity.compilerAdapterSha256])assert(!other.includes(id));assert.notEqual(parseInt(id,16),7);}
 }finally{first.close();await c.close();}
 // Nothing in the transport can reach storage: no storage API is referenced at all.
 const source=readFileSync(new URL('../web/telemetry-export.js',import.meta.url),'utf8');
 assert.doesNotMatch(source,/localStorage|sessionStorage|indexedDB|cookie|caches\.|onSpend\?\.\([^)]*session/);
});
test('a retry after rotation re-projects the body so header and meta.session.id still match',async()=>{
 const c=await collector();let tick=0;const t=telemetryExport({anonymous:true,originUnixMs:Date.now(),clock:()=>tick,jitter:()=>.5});
 try{
  t.collection(true);t.configure({enabled:true,endpoint:c.endpoint,usage:true});
  t.enqueue(telemetry_consent_record(JSON.stringify(event),true,true,true));await t.flush();
  // A batch fails just before four hours are up and is retried just after.
  tick=4*3600000-10000;c.status(503);t.enqueue(telemetry_consent_record(JSON.stringify(event),true,true,true));await t.flush();
  tick=4*3600000+1;c.status(202);await t.flush();
  assert.equal(c.calls.length,3);for(const call of c.calls)assert.equal(call.verdict.status,202);
  const ids=c.calls.map(call=>call.headers['x-faro-session-id']);assert.equal(ids[0],ids[1]);assert.notEqual(ids[1],ids[2]);assert.equal(t.status().sent,2);
  assert.equal(c.calls[1].encoded.replace(ids[1],ids[2]),c.calls[2].encoded,'only the session changed in the retried body');
 }finally{t.close();await c.close();}
});
test('a 400 from the collector is reported as failing delivery, never as sent',async()=>{
 const c=await collector();
 // A transport that lost its session header, as before this fix.
 const t=telemetryExport({anonymous:true,originUnixMs:Date.now(),fetcher:(url,options)=>{const headers={...options.headers};delete headers['X-Faro-Session-Id'];return fetch(url,{...options,headers});}});
 try{
  t.collection(true);t.configure({enabled:true,endpoint:c.endpoint,usage:true});
  t.enqueue(telemetry_consent_record(JSON.stringify(event),true,true,true));await t.flush();
  assert.equal(c.calls[0].verdict.message,FARO_MISSING_SESSION);
  const status=t.status();assert.equal(status.sent,0);assert.equal(status.failures,1);assert.equal(status.error,'invalid');assert.equal(status.blocked,true);assert.equal(status.pending,0);
  t.enqueue(telemetry_consent_record(JSON.stringify(event),true,true,true));await t.flush();assert.equal(c.calls.length,1,'a rejected configuration stops sending');
 }finally{t.close();await c.close();}
});
