import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';

test('a first failed test fires controlled probes while application and CI rules exclude synthetic activity', {skip:!process.env.SCRIBYRA_TEST_STORAGE_STATE,timeout:150000},async()=>{
 const state=process.env.SCRIBYRA_TEST_STORAGE_STATE,base=Number(process.env.SCRIBYRA_TEST_STORAGE_PORT_BASE||18789);
 const cloud=Boolean(process.env.SCRIBYRA_TEST_GRAFANA_URL),grafana=process.env.SCRIBYRA_TEST_GRAFANA_URL||`http://127.0.0.1:${base+9}`;
 const password=cloud?'':(await readFile(state+'/grafana-admin.password','utf8')).trim();
 const authorization=cloud?'Bearer '+process.env.SCRIBYRA_TEST_GRAFANA_TOKEN:'Basic '+Buffer.from('operator:'+password).toString('base64');
 async function api(path,method='GET',body){
  if(cloud)path=path.replace('/uid/scribyra-loki','/uid/grafanacloud-logs');
  const response=await fetch(grafana+path,{method,headers:{Authorization:authorization,'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(10000)});
  assert(response.ok,`Grafana ${method} ${path.split('?')[0]} HTTP ${response.status}`);
  return response.status===204?undefined:response.json();
 }
 const rules=await api('/api/v1/provisioning/alert-rules');
 const app=rules.find(r=>r.uid==='scribyra-failures'),ci=rules.find(r=>r.uid==='scribyra-ci-failures');
 assert(app&&ci);assert.equal(app.data[0].datasourceUid,cloud?'grafanacloud-logs':'scribyra-loki');
 if(cloud){
  const mute=await api('/api/v1/provisioning/mute-timings/scribyra-dashboard-only');
  const expected=JSON.parse(await readFile('ops/telemetry/grafana/dashboard-only-mute.json','utf8'));
  assert.deepEqual(mute.time_intervals,expected.time_intervals);
  for(const rule of [app,ci])assert.deepEqual(rule.notification_settings.mute_time_intervals,[expected.name]);
 }
 const group='Scribyra source validation',folder=app.folderUID;
 const groupPath=`/api/v1/provisioning/folder/${folder}/rule-groups/${encodeURIComponent(group)}`;
 const probes=[app,ci].map((template,index)=>{
  const rule=structuredClone(template);delete rule.id;delete rule.updated;delete rule.provenance;
  Object.assign(rule,{uid:'scribyra-source-probe-'+index,title:'Scribyra source probe '+index,ruleGroup:group,for:'0s',labels:{product:'scribyra',activity:'controlled_validation'}});
  rule.data[0].model.expr=rule.data[0].model.expr.replace(/scribyra_source="(?:application|ci)"/,'scribyra_source="synthetic"');return rule;
 });
 try{
  const started=Date.now();
  const child=spawnSync('python3',['scripts/telemetry-run.py','--suite','synthetic-fail','--endpoint',`http://127.0.0.1:${base}/v1/runs`,'--token-file',state+'/ingress.token'],{encoding:'utf8',timeout:15000,env:{...process.env,GITLAB_CI:'false'}});
  assert.equal(child.status,1);const run=JSON.parse(child.stdout);assert.equal(run.delivery,'accepted');assert.equal(run.source,'synthetic');assert.equal(run.counts.failed,1);
  // Restrict only the controlled probes to this actual run, so older failures
  // in a retained deployment cannot manufacture the first-observation result.
  for(const probe of probes)probe.data[0].model.expr=probe.data[0].model.expr.replace(/\[(10m|1h)\]/,` | scribyra_run_id="${run.runId}"[$1]`);
  await api(groupPath,'PUT',{folderUid:folder,title:group,interval:10,rules:probes});
  const deadline=Date.now()+100000;let verified=false;
  while(Date.now()<deadline){
   const data=await api('/api/prometheus/grafana/api/v1/rules');const all=data.data.groups.flatMap(g=>g.rules);
   const original=[app,ci].map(template=>all.find(r=>r.name===template.title));
   const controlled=probes.map(template=>all.find(r=>r.name===template.title));
   if(original.every(r=>r?.state==='inactive'&&r.health==='ok'&&Date.parse(r.lastEvaluation)>=started)&&controlled.every(r=>r?.state==='firing'&&r.health==='ok'&&Date.parse(r.lastEvaluation)>=started)){verified=true;break;}
   await new Promise(r=>setTimeout(r,1000));
  }
  assert(verified,'A single real failed assertion must fire both source-selected probe formulas, while production application/CI rules stay normal');
  const evaluated=(await api('/api/prometheus/grafana/api/v1/rules')).data.groups.flatMap(g=>g.rules);
  for(const rule of rules.filter(r=>r.ruleGroup==='Scribyra telemetry'&&r.labels?.product==='scribyra'))assert(evaluated.some(r=>r.name===rule.title&&r.health==='ok'),'Every owned production rule must have a healthy query evaluation');
  const result=await api('/api/datasources/proxy/uid/scribyra-loki/loki/api/v1/query?'+new URLSearchParams({query:probes[1].data[0].model.expr}));
  assert(result.data.result.some(row=>Number(row.value[1])===1),'The first failed test must be counted without a second metric sample');
  if(cloud){
   // Mute intervals apply to generated notification routes, not the global
   // active/suppressed status of an alert (which can have multiple routes).
   // Inspect the server-generated route and rule binding, not an unrelated
   // Alertmanager's active-alert list. No notification delivery is exercised.
   const config=await api('/api/alertmanager/grafana/config/api/v1/alerts');
   const hasMutedRoute=route=>Boolean(route?.mute_time_intervals?.includes('scribyra-dashboard-only')&&route.receiver&&route.object_matchers?.some(m=>m[0]==='__grafana_route_settings_hash__'))||Boolean(route?.routes?.some(hasMutedRoute));
   assert(hasMutedRoute(config.alertmanager_config?.route),'Server-generated direct routing must use the owned all-time mute');
   for(const probe of probes){
    const stored=await api('/api/v1/provisioning/alert-rules/'+probe.uid);
    assert.deepEqual(stored.notification_settings.mute_time_intervals,['scribyra-dashboard-only']);
   }
  }
  await writeFile(state+'/alert-source-evidence.json',JSON.stringify({version:1,verifiedAt:new Date().toISOString(),runId:run.runId,source:'synthetic',checks:['actual-failed-assertion','first-observation-counted','application-isolated','ci-isolated','source-selected-query-firing',...(cloud?['dashboard-only-route-configured']:[])]}),{mode:0o600});
 }finally{await api(groupPath,'DELETE');}
});
