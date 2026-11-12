import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';

test('real Grafana evaluator distinguishes optional no-data, required no-data and query errors', {skip:process.env.SCRIBYRA_TEST_STORAGE_STATE?false:'Requires an explicitly started private Grafana storage stack',timeout:150000},async()=>{
 const state=process.env.SCRIBYRA_TEST_STORAGE_STATE;
 const base=Number(process.env.SCRIBYRA_TEST_STORAGE_PORT_BASE||18789);
 const password=(await readFile(`${state}/grafana-admin.password`,'utf8')).trim();
 const authorization='Basic '+Buffer.from('operator:'+password).toString('base64');
 async function api(path,method='GET',body){
  const response=await fetch(`http://127.0.0.1:${base+9}`+path,{method,headers:{Authorization:authorization,'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(10000)});
  assert.ok(response.ok,`${method} ${path}: HTTP ${response.status}`);
  return response.status===204?undefined:response.json();
 }
 const view=await api('/api/dashboards/uid/scribyra-operations');
 const template=JSON.parse(await readFile(new URL('../ops/telemetry/grafana/provisioning/alerting/scribyra.json',import.meta.url),'utf8')).groups[0].rules.find(rule=>rule.uid==='scribyra-compile-latency');
 const group='Scribyra controlled validation',folder=view.meta.folderUid;
 const groupPath=`/api/v1/provisioning/folder/${folder}/rule-groups/${encodeURIComponent(group)}`;
 const rules=[['nodata-ok','OK'],['nodata-alert','Alerting'],['query-error','OK']].map(([id,nodata])=>{
  const rule=structuredClone(template);
  Object.assign(rule,{uid:'scribyra-probe-'+id,title:'Scribyra controlled '+id,folderUID:folder,ruleGroup:group,for:'0s',noDataState:nodata,annotations:{summary:'Synthetic evaluator validation; not application activity.'},labels:{product:'scribyra',source:'synthetic-validation'}});
  rule.data[0].model.expr=id==='query-error'?'scribyra_operation_total{':'scribyra_operation_total{scribyra_operation="__validation_no_data__"}';
  return rule;
 });
 try{
  await api(groupPath,'PUT',{folderUid:folder,title:group,interval:10,rules});
  const deadline=Date.now()+90000;let verified=false;
  while(Date.now()<deadline){
   const data=await api('/api/prometheus/grafana/api/v1/rules');
   const evaluated=data.data.groups.filter(g=>g.name===group).flatMap(g=>g.rules);
   const get=id=>evaluated.find(rule=>rule.name==='Scribyra controlled '+id);
   if(get('nodata-ok')?.state==='inactive'&&get('nodata-alert')?.state==='firing'&&get('query-error')?.health==='error'){
    verified=true;break;
   }
   await new Promise(resolve=>setTimeout(resolve,1000));
  }
  assert.ok(verified,'Grafana evaluator must distinguish all three controlled outcomes');
  await writeFile(`${state}/grafana-alert-evidence.json`,JSON.stringify({version:1,source:'synthetic-evaluator-validation',verifiedAt:new Date().toISOString(),checks:['optional-no-data-normal','required-no-data-firing','query-error-visible']}),{mode:0o600});
 }finally{
  await api(groupPath,'DELETE');
 }
});
