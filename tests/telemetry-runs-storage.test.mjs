import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';

test('actual Rust and deliberately failing test runs are stored and queryable through private Grafana', {skip:!process.env.SCRIBYRA_TEST_STORAGE_STATE,timeout:180000},async()=>{
 const state=process.env.SCRIBYRA_TEST_STORAGE_STATE,base=Number(process.env.SCRIBYRA_TEST_STORAGE_PORT_BASE||18789);
 const cloud=Boolean(process.env.SCRIBYRA_TEST_GRAFANA_URL);
 const grafana=process.env.SCRIBYRA_TEST_GRAFANA_URL||`http://127.0.0.1:${base+9}`;
 const password=cloud?'':(await readFile(state+'/grafana-admin.password','utf8')).trim();
 const management=process.env.SCRIBYRA_TEST_GRAFANA_TOKEN;
 const token=(await readFile(state+'/ingress.token','utf8')).trim();
 const authorization=cloud?'Bearer '+management:'Basic '+Buffer.from('operator:'+password).toString('base64');
 async function api(path,body){
  if(cloud)for(const [a,b] of [['scribyra-prom','grafanacloud-prom'],['scribyra-loki','grafanacloud-logs'],['scribyra-tempo','grafanacloud-traces']])path=path.replace('/uid/'+a,'/uid/'+b);
  const response=await fetch(grafana+path,{method:body?'POST':'GET',headers:{Authorization:authorization,'Content-Type':'application/json',Accept:'application/json'},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(10000)});
  assert(response.ok,`Grafana HTTP ${response.status} ${path.split('?')[0]}`);return response.json();
 }
 async function eventually(read,check){
  const deadline=Date.now()+60000;let value;
  do{try{value=await read();if(check(value))return value;}catch{}await new Promise(r=>setTimeout(r,500));}while(Date.now()<deadline);
  assert.fail('Stored evidence did not satisfy the expected query within 60 seconds');
 }
 const retained=process.env.SCRIBYRA_TEST_RUNS_READBACK_ONLY==='1'?JSON.parse(await readFile(state+'/test-runs-evidence.json','utf8')).runs:null;
 const runs=[];
 for(const [index,[suite,status]] of [['rust',0],['synthetic-fail',1]].entries()){
  let result;
  if(retained){result={runId:retained[index].runId};}else{
  const child=spawnSync('python3',['scripts/telemetry-run.py','--suite',suite,'--endpoint',`http://127.0.0.1:${base}/v1/runs`,'--token-file',state+'/ingress.token'],{encoding:'utf8',timeout:60000,env:{...process.env,GITLAB_CI:'false',GITHUB_ACTIONS:'false'}});
  assert.equal(child.status,status);result=JSON.parse(child.stdout);assert.equal(result.delivery,'accepted');
  }
  const record=JSON.parse(await readFile(`.telemetry/${result.runId}.json`,'utf8'));
  // Sparse counter samples leave the default instant-query lookback window.
  // Retained evidence must be queried at its observation time, not at now.
  const observedAt=retained?(retained[index].observedAt||(record.startedUnixMs+record.durationMs)/1000+30):Date.now()/1000;
  runs.push({...record,observedAt});
  const selector=`scribyra_source="${record.source}",scribyra_suite="${record.suite}",scribyra_outcome="${record.outcome}"`;
  const query='scribyra_run_total{'+selector+'}';
  const metric=await eventually(()=>api('/api/datasources/proxy/uid/scribyra-prom/api/v1/query?'+new URLSearchParams({query,time:String(observedAt)})),r=>r.data?.result.some(v=>Number(v.value[1])>=1));
  const cases=await api('/api/datasources/proxy/uid/scribyra-prom/api/v1/query?'+new URLSearchParams({query:'scribyra_run_cases_total{'+selector+'}',time:String(observedAt)}));
  for(const key of ['passed','failed','skipped','cancelled','todo','flaky'])assert(cases.data.result.some(v=>v.metric.scribyra_case_outcome===key&&Number(v.value[1])>=record.counts[key]));
  const logs=await eventually(()=>api('/api/datasources/proxy/uid/scribyra-loki/loki/api/v1/query_range?'+new URLSearchParams({query:`{service_name="scribyra"} |= "${record.runId}"`,limit:'100'})),r=>r.data?.result.length>0);
  const bodies=logs.data.result.flatMap(v=>v.values.map(([,body])=>JSON.parse(body)));
  assert.deepEqual(bodies.find(v=>v.runId===record.runId),record);
  const trace=await eventually(()=>api('/api/datasources/proxy/uid/scribyra-tempo/api/traces/'+record.runId),r=>JSON.stringify(r).includes('test_run'));
  const stored=JSON.stringify({metric,cases,logs,trace});
  assert(!stored.includes(token)&&(!password||!stored.includes(password))&&(!management||!stored.includes(management)));
  assert(!/PRIVATE_FAILURE_SOURCE_MARKER|SECRET_HEADER_MARKER/.test(stored));
 }
 // Exercise every panel expression through the real datasource plugins. Typed
 // variables use their current fixed values; all is the configured .* regex.
 for(const uid of ['scribyra-operations','scribyra-delivery','scribyra-test-runs']){
  const view=(await api('/api/dashboards/uid/'+uid)).dashboard;
  const values=Object.fromEntries(view.templating.list.map(v=>[v.name,v.current.value==='$__all'?v.allValue:v.current.value]));
  const replace=text=>text.replace(/\$\{(\w+):regex\}/g,(_,key)=>values[key]);
  for(const panel of view.panels){
   if(!panel.targets?.length)continue;
   const queries=panel.targets.map(t=>({...t,expr:t.expr?replace(t.expr):undefined,query:t.query?replace(t.query):undefined,datasource:panel.datasource,intervalMs:15000,maxDataPoints:240}));
   const response=await api('/api/ds/query',{from:'now-1h',to:'now',queries});
   assert(Object.values(response.results).every(r=>!r.error&&r.status===200),`Panel query failed: ${uid} ${panel.id}`);
  }
 }
 assert.equal((await fetch(grafana+'/api/dashboards/uid/scribyra-test-runs')).status,401);
 await writeFile(state+'/test-runs-evidence.json',JSON.stringify({version:1,verifiedAt:new Date().toISOString(),runs:runs.map(v=>({runId:v.runId,source:v.source,suite:v.suite,outcome:v.outcome,counts:v.counts,observedAt:v.observedAt})),checks:['stored-metrics','exact-safe-log','trace','all-dashboard-queries','anonymous-denied','private-content-excluded']}),{mode:0o600});
});
