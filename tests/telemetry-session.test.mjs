import './helpers/core.mjs';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {spawnSync} from 'node:child_process';
import {randomBytes} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {telemetry_consent_record,telemetry_faro_batch} from '../web/pkg/scribyra_app.js';
import {telemetryExport} from '../web/telemetry-export.js';
import {SESSION_MAX_AGE_MS,SESSION_RATES,parseSessionRate,sessionSampled} from '../web/telemetry-session.js';
import {officialTelemetryEnv,officialSessionRateEnv} from '../scripts/official-telemetry.mjs';
import {faroVerdict} from './helpers/faro-collector.mjs';

const event={version:1,runtime:'browser',operation:'compile',outcome:'success',traceId:'b'.repeat(32),spanId:'c'.repeat(16),elapsedMs:10,metrics:[{name:'duration_ms',value:10}]};
const record=()=>telemetry_consent_record(JSON.stringify(event),true,true,true);
const hex=n=>n.toString(16).padStart(8,'0');
// Session IDs whose sampling half is chosen; the other half stays random.
const tail=value=>bytes=>{randomBytes(bytes.length).copy(Buffer.from(bytes.buffer,bytes.byteOffset,bytes.length));if(bytes.length===8)new DataView(bytes.buffer,bytes.byteOffset).setUint32(4,value);return bytes;};

async function collector(){
 const calls=[];
 const server=createServer(async(req,res)=>{let body='';for await(const chunk of req)body+=chunk;const verdict=faroVerdict(req.headers,body);calls.push({headers:req.headers,body:JSON.parse(body),verdict});res.writeHead(verdict.status);res.end(verdict.message);});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 return{calls,endpoint:`http://127.0.0.1:${server.address().port}/collect`,close:()=>{server.closeAllConnections();return new Promise(resolve=>server.close(resolve));}};
}
function transport(endpoint,{sessionRate,random,clock}={}){
 const t=telemetryExport({anonymous:true,originUnixMs:Date.now(),clock,random,jitter:()=>.5});
 t.collection(true);t.configure({enabled:true,endpoint,usage:true,...(sessionRate===undefined?{}:{sessionRate})});return t;
}

test('build values parse to the closed rate list, and anything else is refused',()=>{
 assert.deepEqual([...SESSION_RATES],[1,.5,.25,.1,.01]);
 for(const value of [undefined,null,''])assert.equal(parseSessionRate(value),1);
 for(const[text,rate]of [['1',1],['0.5',.5],['0.25',.25],['0.1',.1],['0.01',.01],[' 0.25 ',.25]])assert.equal(parseSessionRate(text),rate);
 for(const text of ['0','0.3','2','-1','1.0','0.50','.5','1e-2','NaN','Infinity','half','0.5;','PRIVATE_SOURCE'])assert(Number.isNaN(parseSessionRate(text)),text);
 assert.deepEqual(officialSessionRateEnv(undefined),{VITE_TELEMETRY_SESSION_RATE:'1'});
 assert.deepEqual(officialSessionRateEnv('0.1'),{VITE_TELEMETRY_SESSION_RATE:'0.1'});
 assert.throws(()=>officialSessionRateEnv('0.3'),/SCRIBYRA_TELEMETRY_SESSION_RATE must be one of 1, 0.5, 0.25, 0.1, 0.01/);
 // The constant official environment carries no rate; only the CI variable supplies one.
 assert.equal(officialTelemetryEnv.VITE_TELEMETRY_SESSION_RATE,undefined);
 assert.equal(SESSION_MAX_AGE_MS,14400000);
});

test('the session decision is a fixed function of the ID, nested across rates and exact in share',()=>{
 const ids=Array.from({length:10000},(_,i)=>`${hex(i*7919)}${hex(Math.floor(i*4294967296/10000))}`);
 for(const rate of SESSION_RATES){
  const picked=ids.filter(id=>sessionSampled(id,rate));
  assert.equal(picked.length,Math.round(rate*10000),`share at ${rate}`);
  // Same ID, same answer, however often it is asked.
  for(const id of ids.slice(0,200))assert.equal(sessionSampled(id,rate),sessionSampled(id,rate));
 }
 // A session sending at a lower rate also sends at every higher one, so changing the
 // build rate keeps a consistent subset rather than an unrelated one.
 for(const id of ids)for(let i=1;i<SESSION_RATES.length;i++)if(sessionSampled(id,SESSION_RATES[i]))assert(sessionSampled(id,SESSION_RATES[i-1]));
 // The first half of the ID does not take part.
 assert.equal(sessionSampled('ffffffff00000000',.01),true);assert.equal(sessionSampled('00000001ffffffff',.5),false);
 for(const[id,rate]of [['',1],['PRIVATE_SOURCE__',1],['0123456789ABCDEF',1],['0123456789abcdef',.3],['0123456789abcdef',0]])assert.equal(sessionSampled(id,rate),false);
});

test('a session that is not sampled sends nothing, ever, and leaks no count into the next one',async()=>{
 const c=await collector();let tick=0,value=0xffffffff;
 const t=transport(c.endpoint,{sessionRate:.5,clock:()=>tick,random:bytes=>tail(value)(bytes)});
 try{
  for(let i=0;i<20;i++){t.enqueue(record());tick+=20000;await t.flush();}
  assert.equal(c.calls.length,0,'no request from an unsampled session');
  let s=t.status();assert.equal(s.unsampled,20);assert.equal(s.pending,0);assert.equal(s.bufferedBytes,0);assert.equal(s.skipped,true);assert.equal(s.requests,0);assert.equal(s.sampled,0);
  // Four hours on, a new session is drawn; this one is sampled and its first batch
  // reports no counts from the earlier session.
  value=0;tick=SESSION_MAX_AGE_MS+1;t.enqueue(record());await t.flush();
  assert.equal(c.calls.length,1);const call=c.calls[0];assert.equal(call.verdict.status,202);
  for(const kind of ['measurements','events'])for(const item of call.body[kind]){const context=item.context||item.attributes;assert.equal(context.sampling_rate,'0.5');assert.equal(context.dropped,'0');assert.equal(context.sampled,'0');}
  s=t.status();assert.equal(s.skipped,false);assert.equal(s.sent,1);
 }finally{t.close();await c.close();}
});

test('sampled sessions send with the rate in the batch and every Faro record',async()=>{
 const c=await collector();
 try{
  for(const rate of SESSION_RATES){
   const raw=[];const t=telemetryExport({anonymous:true,originUnixMs:Date.now(),random:tail(0),fetcher:(url,options)=>{raw.push(options.body);return fetch(url,options);}});
   try{
    t.collection(true);t.configure({enabled:true,endpoint:c.endpoint,usage:true,sessionRate:rate});assert.equal(t.configuration().sessionRate,rate);
    t.enqueue(record());await t.flush();const call=c.calls.at(-1);assert.equal(call.verdict.status,202);
    const label=String(rate);for(const item of [...call.body.measurements,...call.body.events])assert.equal((item.context||item.attributes).sampling_rate,label);
    assert.deepEqual(Object.keys(call.body.meta).sort(),['app','sdk','session']);assert.deepEqual(call.body.meta.session,{id:call.headers['x-faro-session-id']});
   }finally{t.close();}
  }
  assert.equal(c.calls.length,SESSION_RATES.length);
 }finally{await c.close();}
 // The Scribyra batch itself records the rate for self-hosted ingress, and Rust
 // refuses any other value before projecting it.
 const batch=rate=>JSON.stringify({version:1,batchId:'a'.repeat(32),originUnixMs:Date.now(),delivery:{runtime:'browser',dropped:0,sampled:0,sessionRate:rate},events:[JSON.parse(record())]});
 assert.match(telemetry_faro_batch(batch(.25),Date.now(),true,'0123456789abcdef'),/"sampling_rate":"0.25"/);
 for(const rate of [0,.3,2,'0.5'])assert.equal(telemetry_faro_batch(batch(rate),Date.now(),true,'0123456789abcdef'),undefined);
 const ingress=[];const t=telemetryExport({anonymous:true,originUnixMs:Date.now(),fetcher:async(_url,options)=>{ingress.push(JSON.parse(options.body));return new Response(null,{status:202});}});
 try{t.collection(true);t.configure({enabled:true,endpoint:'http://127.0.0.1:6101/v1/browser-events',sessionRate:1});t.enqueue(record());await t.flush();assert.deepEqual(ingress[0].delivery,{runtime:'browser',dropped:0,sampled:0,sessionRate:1});}finally{t.close();}
});

test('work queued in a sampled session is dropped if it outlives it into an unsampled one',async()=>{
 const c=await collector();let tick=0,value=0;
 const t=telemetryExport({anonymous:true,originUnixMs:Date.now(),clock:()=>tick,random:bytes=>tail(value)(bytes),fetcher:async()=>new Response('',{status:503})});
 try{
  t.collection(true);t.configure({enabled:true,endpoint:c.endpoint,usage:true,sessionRate:.25});
  // A batch fails a minute before the session ends and is retried just after it.
  t.enqueue(record());await t.flush();assert.equal(t.status().pending,1);tick=300001;await t.flush();assert.equal(t.status().pending,0);
  tick=SESSION_MAX_AGE_MS-60000;t.enqueue(record());await t.flush();assert.equal(t.status().pending,1);
  value=0xffffffff;tick=SESSION_MAX_AGE_MS;await t.flush();
  const s=t.status();assert.equal(s.pending,0);assert.equal(s.unsampled,1);assert.equal(s.requests,2);assert.equal(c.calls.length,0);
 }finally{t.close();await c.close();}
});

test('session rates are refused outside the list and for token connections',()=>{
 const t=telemetryExport({anonymous:true,originUnixMs:Date.now()});t.collection(true);
 for(const sessionRate of [0,.3,2,'0.5',NaN])assert.throws(()=>t.configure({enabled:true,endpoint:'http://127.0.0.1:6101/collect',sessionRate}),/session rate/);
 const token=telemetryExport({originUnixMs:Date.now()});token.collection(true);
 assert.throws(()=>token.configure({enabled:true,endpoint:'http://127.0.0.1:6101/v1/events',token:'a'.repeat(64),sessionRate:.5}),/session rate/);
 token.configure({enabled:true,endpoint:'http://127.0.0.1:6101/v1/events',token:'a'.repeat(64)});assert.equal(token.configuration().sessionRate,1);
 t.close();token.close();
});

// One opted-in person's realistic working day, as Grafana would count it: distinct
// session IDs on accepted requests. Two sittings with reloads, a short second tab,
// an evening check, focus moving between them throughout. Nothing is persisted, so
// each page load is its own transport.
test('a realistic day yields one session per page load, not one per hour',async()=>{
 const c=await collector(),minute=60000;let tick=0;
 const loads=[[9*60,10*60+15],[10*60+15,12*60+30],[11*60,11*60+40],[13*60+30,17*60+20],[20*60,20*60+55]];
 const tabs=loads.map(()=>null);
 try{
  for(let m=9*60;m<=21*60;m++){
   tick=m*minute;
   for(const[i,[start,end]]of loads.entries()){
    if(m===start)tabs[i]=transport(c.endpoint,{clock:()=>tick});
    // A compile roughly every ten minutes while the tab is open.
    if(tabs[i]&&m<end&&(m-start)%10===0){tabs[i].enqueue(record());await tabs[i].flush();}
    if(m===end&&tabs[i]){tabs[i].close();tabs[i]=null;}
   }
  }
  const ids=new Set(c.calls.filter(call=>call.verdict.status===202).map(call=>call.headers['x-faro-session-id']));
  assert(c.calls.length>40,'the day really sent');
  assert.equal(ids.size,loads.length,'one Grafana session per page load');
 }finally{for(const t of tabs)t?.close();await c.close();}
 // The transport keeps no storage reference, so no rotation setting can persist an ID.
 assert.doesNotMatch(readFileSync(new URL('../web/telemetry-export.js',import.meta.url),'utf8'),/localStorage|sessionStorage|indexedDB|cookie|caches\./);
});

test('a build with a rate outside the list fails before bundling',()=>{
 const result=spawnSync('npx',['vite','build','--outDir','test-results/tmp/invalid-rate','--emptyOutDir'],{env:{...process.env,SCRIBYRA_ROOT_SHELL:'1',VITE_TELEMETRY_SESSION_RATE:'0.3'},encoding:'utf8'});
 assert.notEqual(result.status,0);assert.match(result.stdout+result.stderr,/VITE_TELEMETRY_SESSION_RATE must be one of 1, 0.5, 0.25, 0.1, 0.01/);
});
