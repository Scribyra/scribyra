import {test} from 'node:test';
import assert from 'node:assert/strict';
import {isDeepStrictEqual} from 'node:util';
import {mkdtemp,mkdir,writeFile,readFile,readdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {telemetryReadback,traceSpans,hex,eventDigest,nativeChain} from './helpers/telemetry-readback.mjs';

async function launch(binary,args,env){
 const child=spawn(resolve('target/debug/'+binary),args,{env,stdio:['ignore','pipe','pipe']});let stdout='';
 child.stdout.on('data',bytes=>{stdout=(stdout+bytes).slice(-262144);});child.stderr.resume();
 const code=await new Promise((resolve,reject)=>{const timeout=setTimeout(()=>{child.kill('SIGKILL');reject(Error('Native CLI deadline exceeded'));},10000);child.once('error',()=>{clearTimeout(timeout);reject(Error('Native CLI could not start'));});child.once('exit',code=>{clearTimeout(timeout);resolve(code);});});
 return {code,stdout};
}
async function snapshot(directory){
 const entries=await readdir(directory,{withFileTypes:true});const child=entries.find(e=>e.isDirectory());
 assert(child,'Actual native support snapshot must be written');
 return JSON.parse(await readFile(join(directory,child.name,'snapshot.json'),'utf8'));
}

test('delivered native CLI and sync API retain real success/failure evidence through Alloy and Grafana',{skip:!process.env.SCRIBYRA_TEST_STORAGE_STATE,timeout:240000},async()=>{
 const rb=await telemetryReadback();
 if(process.env.SCRIBYRA_TEST_NATIVE_READBACK_ONLY==='1'){
  const saved=JSON.parse(await readFile(rb.state+'/native-readback-evidence.json','utf8'));
  assert.equal(saved.source,rb.source);assert.equal(saved.observations.length,4);
  async function retained(record,metricQuery,check){
   const start=String(BigInt(Math.floor((record.observedAt-60)*1000))*1000000n),end=String(BigInt(Math.ceil((record.observedAt+60)*1000))*1000000n);
   const logs=await rb.poll(()=>rb.logs(`{service_name="scribyra"} |= "${record.traceId}"`,start,end),r=>rb.events(r).some(e=>e.spanId===(record.spanId||record.compileSpanId)&&eventDigest(e)===record.eventDigest),'Original native event body must remain stored without republishing');
   const trace=await rb.poll(()=>rb.trace(record.traceId),check,'Original native trace must remain stored');
   assert(traceSpans(trace).every(span=>(span.attributes||[]).some(a=>a.key==='scribyra.source'&&a.value.stringValue===rb.source)),'Retained spans must preserve activity source');
   const metric=await rb.metric(metricQuery,record.observedAt);assert(metric.data.result.some(p=>Number(p.value[1])>0));
   assert(await rb.freshMetric(metricQuery,record.since,record.observedAt),'Retained metrics must originate within the original scenario, not an older counter sample');
   rb.privateData({logs,trace,metric},['PRIVATE_NATIVE_ROOT','PRIVATE_RETAINED_NATIVE','PRIVATE_RETAINED_SYNC_CONTENT','PRIVATE_RETAINED_ROOM','NeverNativePrivateContent','PRIVATE_NATIVE_PROJECT','PRIVATE_NATIVE_FILE']);
  }
  for(const record of saved.observations)await retained(record,`scribyra_operation_total{scribyra_source="${rb.source}",scribyra_runtime="${record.runtime}",scribyra_operation="${record.operation}",scribyra_outcome="${record.outcome}"}`,trace=>traceSpans(trace).some(s=>hex(s.spanId)===record.spanId&&hex(s.traceId)===record.traceId));
  for(const browser of ['chromium','firefox','webkit']){
   const record=JSON.parse(await readFile(rb.state+'/native-browser-evidence-'+browser+'.json','utf8'));assert.equal(record.source,rb.source);
   await retained(record,`scribyra_operation_total{scribyra_source="${rb.source}",scribyra_runtime="companion",scribyra_operation="mcp",scribyra_outcome="success"}`,trace=>nativeChain(trace,record));
  }
  await writeFile(rb.state+'/native-retention-evidence.json',JSON.stringify({version:1,verifiedAt:new Date().toISOString(),source:rb.source,checks:['readback-without-republish','original-event-digests','historical-metrics','native-cli-sync','mcp-chain-all-three-browsers']}),{mode:0o600});return;
 }
 const directory=await mkdtemp(join(tmpdir(),'scribyra-native-readback-'));
 const root=join(directory,'PRIVATE_NATIVE_ROOT'),text='PRIVATE_RETAINED_NATIVE_DOCUMENT',name='PRIVATE_RETAINED_NATIVE_FILE.tex';
 await mkdir(root);await writeFile(join(root,name),text,{mode:0o600});
 const forbidden=[root,directory,name,text,createHash('sha256').update(text).digest('hex'),rb.endpoint,rb.tokenFile];let sync;
 const evidence=[];
 async function verify(record,since){
  const logs=await rb.poll(()=>rb.logs(`{service_name="scribyra"} |= "${record.traceId}"`,since),r=>rb.events(r).some(e=>e.spanId===record.spanId&&e.outcome===record.outcome),'Exact native event must be stored');
  assert(rb.events(logs).some(e=>isDeepStrictEqual(e,record)),'Stored event must equal its local support record');
  const trace=await rb.poll(()=>rb.trace(record.traceId),t=>traceSpans(t).some(s=>hex(s.spanId)===record.spanId),'Exact native span must be stored');
  const span=traceSpans(trace).find(s=>hex(s.spanId)===record.spanId);assert.equal(hex(span.traceId),record.traceId);
  assert((span.attributes||[]).some(a=>a.key==='scribyra.source'&&a.value.stringValue===rb.source),'Native executable must preserve explicit automated source; rebuild prerequisites');
  const metric=await rb.poll(()=>rb.metric(`scribyra_operation_total{scribyra_source="${rb.source}",scribyra_runtime="${record.runtime}",scribyra_operation="${record.operation}",scribyra_outcome="${record.outcome}"}`),r=>r.data.result.some(p=>Number(p.value[1])>0),'Actual native metric must be queryable');
  const metricQuery=`scribyra_operation_total{scribyra_source="${rb.source}",scribyra_runtime="${record.runtime}",scribyra_operation="${record.operation}",scribyra_outcome="${record.outcome}"}`;
  await rb.poll(()=>rb.freshMetric(metricQuery,since),Boolean,'Native metric must have a fresh sample from this scenario');
  rb.privateData({logs,trace,metric},forbidden);
  evidence.push({runtime:record.runtime,operation:record.operation,outcome:record.outcome,traceId:record.traceId,spanId:record.spanId,eventDigest:eventDigest(record),since,observedAt:Date.now()/1000});
 }
 try{
  for(const [path,code,outcome]of[[root,0,'success'],[join(root,'PRIVATE_MISSING_ROOT'),1,'failure']]){
   const since=String(BigInt(Date.now())*1000000n),diagnostics=join(directory,'diagnostics-'+outcome);
   const result=await launch('scribyra-folders',['inspect',path],rb.nativeEnvironment(diagnostics));assert.equal(result.code,code);
   if(code===0){assert(result.stdout.includes(name),'Actual read-only inspection must complete');let inspected;try{inspected=JSON.parse(result.stdout);}catch{assert.fail('Read-only inspection must return JSON');}forbidden.push(inspected.revision,...inspected.entries.map(e=>e.digest).filter(Boolean));}
   const local=await snapshot(diagnostics),record=local.events.find(e=>e.operation==='native_session'&&e.outcome===outcome);
   assert(record,'CLI must record its actual outcome');rb.privateData(local,forbidden);await verify(record,since);
  }
  assert.equal((await readFile(join(root,name),'utf8'))===text,true,'Inspection must preserve the source');
  const since=String(BigInt(Date.now())*1000000n);
  const syncDiagnostics=join(directory,'diagnostics-sync');
  sync=spawn(resolve('target/debug/examples/plaintext-demo'),[],{env:{...rb.nativeEnvironment(syncDiagnostics),SCRIBYRA_CONTAINER:'0',SCRIBYRA_SYNC_PORT:'0',SCRIBYRA_SYNC_DB:join(directory,'sync.sqlite')},stdio:['ignore','pipe','ignore']});
  const url=await new Promise((resolve,reject)=>{const timeout=setTimeout(()=>reject(Error('Native sync readiness deadline exceeded')),10000);sync.once('error',()=>{clearTimeout(timeout);reject(Error('Native sync could not start'));});sync.once('exit',()=>{clearTimeout(timeout);reject(Error('Native sync stopped before readiness'));});sync.stdout.on('data',bytes=>{const match=bytes.toString().match(/listening on (127\.0\.0\.1:[0-9]+)/);if(match){clearTimeout(timeout);resolve('http://'+match[1]);}});});
  const body=Buffer.from('PRIVATE_RETAINED_SYNC_CONTENT'),digest=createHash('sha256').update(body).digest('hex'),path=url+'/rooms/PRIVATE_RETAINED_ROOM/blobs/'+digest;
  forbidden.push(body.toString(),digest,path,url,'PRIVATE_RETAINED_ROOM');
  assert.equal((await fetch(path)).status,404);assert.equal((await fetch(path,{method:'PUT',body})).status,201);assert(Buffer.from(await(await fetch(path)).arrayBuffer()).equals(body));
  const local=await rb.poll(()=>snapshot(syncDiagnostics),s=>['failure','success'].every(outcome=>s.events.some(e=>e.runtime==='sync_service'&&e.operation==='sync_http'&&e.outcome===outcome)),'Actual native sync support snapshot must contain both HTTP outcomes');
  rb.privateData(local,forbidden);
  for(const outcome of ['failure','success']){
   const record=local.events.find(e=>e.runtime==='sync_service'&&e.operation==='sync_http'&&e.outcome===outcome);await verify(record,since);
  }
  await writeFile(rb.state+'/native-readback-evidence.json',JSON.stringify({version:1,source:rb.source,verifiedAt:new Date().toISOString(),observations:evidence,checks:['actual-read-only-cli','cli-success-failure','actual-sync-http','sync-success-failure','exact-support-record','stored-metrics-logs-traces','private-data-excluded']}),{mode:0o600});
 }finally{
  if(sync&&sync.exitCode===null){const stopped=new Promise(r=>sync.once('exit',r));sync.kill('SIGTERM');let timer;await Promise.race([stopped,new Promise(r=>{timer=setTimeout(()=>{sync.kill('SIGKILL');r();},5000);})]);clearTimeout(timer);}
  await rm(directory,{recursive:true,force:true});
 }
});
