import {telemetry_faro_batch} from './pkg/scribyra_app.js';
import {telemetryDestination} from './telemetry-destination.js';
import {SESSION_MAX_AGE_MS,SESSION_RATES,sessionSampled} from './telemetry-session.js';
// Optional, current-tab-only transport. Input comes only from the Rust recorder's
// acceptance hook; no document, exception, URL or header objects enter the queue.
export function telemetryExport({identity,originUnixMs,anonymous=false,clock=()=>performance.now(),fetcher=(...args)=>fetch(...args),random=bytes=>crypto.getRandomValues(bytes),jitter=()=>Math.random(),allowed,spent=0,onSpend}={}){
 const MAX_EVENTS=128,MAX_BYTES=32768,MAX_AGE=300000;
 // Consented anonymous delivery only: first send delay, spacing, per-session request
 // budget, and a breaker that doubles its pause and finally stops for the session.
 const FIRST_DELAY=5000,MIN_GAP=15000,MAX_REQUESTS=240,BREAKER_FAILURES=3,BREAKER_BASE=60000,BREAKER_TRIPS=5;
 let requested=spent,lastRequest=-Infinity,failStreak=0,trips=0,openUntil=-Infinity,halted=anonymous&&spent>=MAX_REQUESTS;
 let collecting=false,enabled=false,endpoint='',token='',sampleRate=1,sessionRate=1,source='application',faro=false,usage=false,queue=[],bytes=0,pending,timer,abort,epoch=0,busy=false,closed=false,blocked=false;
 // Session: random, in this closure only (never stored), new per page load, replaced
 // after at most four hours and on any consent or clear. Nothing else feeds it. An
 // anonymous session decides once, from its ID, whether it sends anything at all.
 let session;
 function currentSession(current){
  if(session&&current-session.at<SESSION_MAX_AGE_MS)return session;
  const id=Array.from(random(new Uint8Array(8)),n=>n.toString(16).padStart(2,'0')).join('');
  if(!/^[a-f0-9]{16}$/.test(id)||!/[1-9a-f]/.test(id))throw Error('Unavailable random ID');
  // A new session reports no drop or sampling counts from an earlier one.
  if(session){reportedDropped=counts.dropped;reportedSampled=counts.sampled;}
  session={id,at:current,sampled:!anonymous||sessionSampled(id,sessionRate)};return session;
 }
 const counts={sent:0,dropped:0,sampled:0,unsampled:0,requests:0,failures:0},encoder=new TextEncoder();let error,reportedDropped=0,reportedSampled=0;
 const safe=work=>{try{return work();}catch{return undefined;}},now=()=>{const n=safe(clock);return Number.isFinite(n)?n:0;};
 const build=safe(()=>{
  if(!identity||!/^\d+\.\d+\.\d+$/.test(identity.version)||identity.version.length>32||typeof identity.dirty!=='boolean')return;
  const hash=(v,n)=>v==null||typeof v==='string'&&v.length===n&&/^[a-f0-9]+$/.test(v)&&/[1-9a-f]/.test(v);
  if(!(hash(identity.revision,40)||hash(identity.revision,64))||!hash(identity.compilerAdapterSha256,64))return;
  return{version:identity.version,revision:identity.revision??null,dirty:identity.dirty,compilerAdapterSha256:identity.compilerAdapterSha256??null};
 });
 const cancel=()=>{epoch++;clearTimeout(timer);timer=undefined;abort?.abort();abort=null;counts.dropped+=queue.length+(pending?.events.length||0);queue=[];bytes=0;pending=null;busy=false;};
 function schedule(delay=250){if(!enabled||!collecting||closed||blocked||halted||busy||timer||!pending&&!queue.length)return;if(anonymous){const current=now();delay=Math.max(delay,FIRST_DELAY,lastRequest+MIN_GAP-current,openUntil-current);}timer=setTimeout(()=>{timer=undefined;void flush();},delay);}
 function enqueue(encoded){
  if(!enabled||!collecting||closed)return;
  try{
   const event=JSON.parse(encoded);
   // Records of a session that is not sampled are counted locally and never sent.
   if(anonymous&&!currentSession(now()).sampled){counts.unsampled++;return;}
   if(parseInt(event.traceId.slice(0,8),16)/4294967296>=sampleRate){counts.sampled++;return;}
   const size=encoder.encode(encoded).length;
   if(blocked||halted||size>2048){counts.dropped++;return;}
   while(queue.length&&(queue.length>=MAX_EVENTS||bytes+size>MAX_BYTES)){bytes-=queue.shift().size;counts.dropped++;}
   queue.push({encoded,size,at:now()});bytes+=size;schedule();
  }catch{counts.dropped++;}
 }
 const halt=reason=>{halted=true;error=reason;clearTimeout(timer);timer=undefined;counts.dropped+=queue.length+(pending?.events.length||0);queue=[];bytes=0;pending=null;};
 function failed(){if(!anonymous)return;if(++failStreak<BREAKER_FAILURES)return;trips++;if(trips>=BREAKER_TRIPS){halt('unavailable');return;}openUntil=now()+Math.min(1800000,BREAKER_BASE*2**(trips-1));failStreak=BREAKER_FAILURES-1;}
 async function flush(){
  if(anonymous&&allowed&&safe(allowed)!==true)return;
  if(!enabled||!collecting||closed||blocked||halted||busy)return;
  const current=now();while(queue.length&&current-queue[0].at>MAX_AGE){bytes-=queue.shift().size;counts.dropped++;}
  if(pending&&current-pending.at>MAX_AGE){counts.dropped+=pending.events.length;pending=null;}
  if(!pending&&queue.length){
   const events=queue.splice(0,32);for(const event of events)bytes-=event.size;
   try{const id=Array.from(random(new Uint8Array(16)),n=>n.toString(16).padStart(2,'0')).join('');
    if(!/^[a-f0-9]{32}$/.test(id)||!/[1-9a-f]/.test(id))throw Error('Unavailable random ID');
    pending={id,events,at:current,tries:0,raw:'',totals:{dropped:counts.dropped,sampled:counts.sampled},body:`{"version":1,"batchId":"${id}","originUnixMs":${originUnixMs},"source":"${source}"${build?`,"identity":${JSON.stringify(build)}`:''},"delivery":{"runtime":"browser","dropped":${counts.dropped-reportedDropped},"sampled":${counts.sampled-reportedSampled}${anonymous?`,"sessionRate":${sessionRate}`:''}},"events":[${events.map(e=>e.encoded).join(',')}]}`};
    pending.raw=pending.body;
   }catch{counts.dropped+=events.length;error='unavailable';schedule();return;}
  }
  if(!pending)return;
  let live;try{live=currentSession(current);}catch{counts.dropped+=pending.events.length;pending=null;error='unavailable';schedule();return;}
  // Work that outlived its session never reaches one that was not sampled.
  if(!live.sampled){counts.unsampled+=pending.events.length+queue.length;pending=null;queue=[];bytes=0;return;}
  // A retry keeps its body unless the session rotated, so header and body always match.
  if(faro){
   try{const sid=live.id;if(pending.session!==sid){const body=telemetry_faro_batch(pending.raw,Date.now(),usage,sid);if(!body)throw Error('Invalid Faro batch');pending.body=body;pending.session=sid;}}
   catch{counts.dropped+=pending.events.length;pending=null;error='unavailable';schedule();return;}
  }
  if(anonymous&&current<openUntil){schedule();return;}
  if(anonymous&&requested>=MAX_REQUESTS){halt('budget');return;}
  requested++;lastRequest=current;if(anonymous)safe(()=>onSpend?.(requested));
  clearTimeout(timer);timer=undefined;busy=true;const generation=epoch,batch=pending,controller=new AbortController();abort=controller;let retry=0;
  const timeout=setTimeout(()=>controller.abort(),8000);batch.tries++;counts.requests++;
  try{
   const response=await fetcher(endpoint,{method:'POST',headers:{'Content-Type':'application/json',...(faro?{'X-Faro-Session-Id':batch.session}:{}),...(!anonymous?{Authorization:`Bearer ${token}`}:{})},body:batch.body,credentials:'omit',referrerPolicy:'no-referrer',redirect:'error',cache:'no-store',signal:controller.signal});
   safe(()=>response.body?.cancel()?.catch(()=>{}));if(generation!==epoch)return;
   if(faro?response.status>=200&&response.status<300:response.status===202){counts.sent+=batch.events.length;reportedDropped=Math.max(reportedDropped,batch.totals.dropped);reportedSampled=Math.max(reportedSampled,batch.totals.sampled);pending=null;error=undefined;failStreak=0;trips=0;}
   else{
    counts.failures++;failed();error=response.status===401||response.status===403?'permission':response.status===400||response.status===409||response.status===413?'invalid':'unavailable';
    if(error!=='unavailable'){blocked=true;counts.dropped+=batch.events.length+queue.length;pending=null;queue=[];bytes=0;}
    else {const after=Number(safe(()=>response.headers.get('Retry-After')));retry=Number.isFinite(after)&&after>0?Math.min(30,after)*1000:1000*2**(batch.tries-1);if(anonymous&&Number.isFinite(after)&&after>0)openUntil=Math.max(openUntil,now()+Math.min(1800,after)*1000);}
   }
  }catch{if(generation!==epoch)return;counts.failures++;failed();error='unavailable';retry=1000*2**(batch.tries-1);}
  finally{
   clearTimeout(timeout);if(generation===epoch){busy=false;abort=null;if(pending?.tries>=3){counts.dropped+=pending.events.length;pending=null;}schedule(retry?Math.min(30000,retry*(.75+.5*(safe(jitter)??.5))):250);}
  }
 }
 return{enqueue,flush,collection(value){if(collecting===value)return;collecting=value===true;if(!collecting){cancel();enabled=false;token='';}},clear(){cancel();session=undefined;reportedDropped=counts.dropped;reportedSampled=counts.sampled;},
  configure(options){
   if(options.enabled===false){cancel();session=undefined;enabled=false;token='';blocked=false;error=undefined;return;}
   if(closed||!collecting)throw Error('Enable local collection first.');
   const destination=telemetryDestination(options.endpoint,anonymous),url=destination.url;
   if(!anonymous&&(typeof options.token!=='string'||!/^[a-fA-F0-9]{64}$/.test(options.token)))throw Error('Enter the 64-character ingest token from your telemetry host.');
   if(![1,.1,.01].includes(options.sampleRate??1))throw Error('Choose an available sampling rate.');
   // Session sampling is a build setting for anonymous delivery only.
   if(!SESSION_RATES.includes(options.sessionRate??1)||!anonymous&&(options.sessionRate??1)!==1)throw Error('Choose an available session rate.');
   if(!['application','local_test','ci','synthetic'].includes(options.source??'application'))throw Error('Choose an available activity source.');
   cancel();session=undefined;reportedDropped=counts.dropped;reportedSampled=counts.sampled;source=options.source??'application';faro=destination.faro;usage=options.usage===true;endpoint=url.href;token=options.token;sampleRate=options.sampleRate??1;sessionRate=options.sessionRate??1;enabled=true;blocked=false;error=undefined;
  },configuration:()=>({enabled,endpoint,sampleRate,sessionRate,source}),status:()=>({...counts,pending:queue.length+(pending?.events.length||0),bufferedBytes:bytes+(pending?encoder.encode(pending.body).length:0),enabled,busy,blocked,halted,requested,error,sessionRate,skipped:session?.sampled===false}),close(){cancel();closed=true;enabled=false;token='';}};
}
