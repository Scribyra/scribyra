import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {readFile,writeFile} from 'node:fs/promises';

// Explicit long-running acceptance: a dedicated idle stack and its exact ingress
// PID are required. Never stop a shared collector or shorten production timers.
test('operational alert formulas fire for latency, loss, rate rejection, outage and stale ingestion',{
 skip:process.env.SCRIBYRA_TEST_OPERATIONAL_ALERTS!=='1',timeout:1200000
},async()=>{
 const state=process.env.SCRIBYRA_TEST_STORAGE_STATE,base=Number(process.env.SCRIBYRA_TEST_STORAGE_PORT_BASE);
 const pid=Number(process.env.SCRIBYRA_TEST_INGRESS_PID);
 assert(state&&Number.isInteger(base)&&base>=1024&&Number.isInteger(pid)&&pid>1);
 assert.equal((await readFile(`/proc/${pid}/comm`,'utf8')).trim(),'scribyra-teleme');
 const token=(await readFile(state+'/ingress.token','utf8')).trim();
 const password=(await readFile(state+'/grafana-admin.password','utf8')).trim();
 const authorization='Basic '+Buffer.from('operator:'+password).toString('base64');
 async function api(path,method='GET',body){
  const response=await fetch(`http://127.0.0.1:${base+9}`+path,{method,headers:{Authorization:authorization,'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(10000)});
  assert(response.ok,`Private evaluator HTTP ${response.status}`);return response.status===204?undefined:response.json();
 }
 const templates=await api('/api/v1/provisioning/alert-rules'),folder=templates[0].folderUID,group='Scribyra operational acceptance';
 const path=`/api/v1/provisioning/folder/${folder}/rule-groups/${encodeURIComponent(group)}`;
 const ids=['scribyra-compile-latency','scribyra-export-loss','scribyra-delivery-failures','scribyra-ingress-down','scribyra-stale-ingestion'];
 const rules=ids.map(id=>{
  const rule=structuredClone(templates.find(r=>r.uid===id));assert(rule);
  delete rule.id;delete rule.updated;delete rule.provenance;
  Object.assign(rule,{uid:id+'-acceptance',title:id+' acceptance',ruleGroup:group,labels:{product:'scribyra',activity:'synthetic-validation'}});
  rule.data[0].model.expr=rule.data[0].model.expr.replaceAll('scribyra_source="application"','scribyra_source="synthetic"');return rule;
 });
 const receipts=[],started=Date.now();let paused=false;
 async function evaluated(){return(await api('/api/prometheus/grafana/api/v1/rules')).data.groups.filter(g=>g.name===group).flatMap(g=>g.rules);}
 async function waitFor(id,state,timeout){
  const deadline=Date.now()+timeout;
  while(Date.now()<deadline){const row=(await evaluated()).find(r=>r.name===id+' acceptance');if(row?.state===state&&row.health==='ok'&&Date.parse(row.lastEvaluation)>=started){receipts.push({rule:id,state,evaluatedAt:row.lastEvaluation});console.log(JSON.stringify({rule:id,state}));return;}await new Promise(r=>setTimeout(r,5000));}
  assert.fail(`Operational rule ${id} must become ${state} with its original threshold and pending duration`);
 }
 const origin=Date.now()-45000;
 async function send(count,dropped=0){
  const events=Array.from({length:count},()=>({version:1,runtime:'browser',operation:'compile',outcome:'success',traceId:randomBytes(16).toString('hex'),spanId:randomBytes(8).toString('hex'),elapsedMs:Date.now()-origin,metrics:[{name:'duration_ms',value:45000}]}));
  const response=await fetch(`http://127.0.0.1:${base}/v1/events`,{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify({version:1,batchId:randomBytes(16).toString('hex'),originUnixMs:origin,source:'synthetic',delivery:{runtime:'browser',dropped,sampled:0},events}),signal:AbortSignal.timeout(10000)});await response.body?.cancel();return response.status;
 }
 try{
  await api(path,'PUT',{folderUid:folder,title:group,interval:10,rules});
  assert.equal(await send(1),202);await new Promise(r=>setTimeout(r,2000));assert.equal(await send(8,16),202);
  // Real authenticated bursts hit the delivered ingress token bucket. No fake
  // application counters, clock changes or replacement vector queries are used.
  const statuses=await Promise.all(Array.from({length:48},()=>send(1)));
  assert(statuses.includes(429),'Actual ingress rate rejection must occur');
  process.kill(pid,'SIGSTOP');paused=true;
  await waitFor('scribyra-ingress-down','firing',150000);
  process.kill(pid,'SIGCONT');paused=false;
  await waitFor('scribyra-ingress-down','inactive',60000);
  await waitFor('scribyra-export-loss','firing',90000);
  await waitFor('scribyra-delivery-failures','firing',90000);
  await waitFor('scribyra-compile-latency','firing',360000);
  // Ten real idle minutes plus the original five-minute pending duration.
  await waitFor('scribyra-stale-ingestion','firing',1000000);
  await waitFor('scribyra-delivery-failures','inactive',60000);
  await waitFor('scribyra-export-loss','inactive',60000);
  assert.equal(await send(1),202);
  await waitFor('scribyra-stale-ingestion','inactive',60000);
  await writeFile(state+'/operational-alert-evidence.json',JSON.stringify({version:1,source:'synthetic',verifiedAt:new Date().toISOString(),elapsedMs:Date.now()-started,receipts,limits:'Source-selected clones retain production expressions, thresholds and pending durations. Latency data is an explicit synthetic fixture, not actual slow compiles. Latency recovery requires the 30-minute window to expire and is not waited for. No notifications are sent.'}),{mode:0o600});
 }finally{if(paused)process.kill(pid,'SIGCONT');await api(path,'DELETE');}
});
