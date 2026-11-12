import {test,expect} from '@playwright/test';
import {readFile,writeFile} from 'node:fs/promises';
import {zipSync,strToU8} from 'fflate';

// Passwords and private seeded papers must never enter Playwright traces/video.
test.use({trace:'off',screenshot:'off',video:'off'});
test('private Grafana views query actual browser evidence and evaluate a compile failure',async({page})=>{
 const state=process.env.SCRIBYRA_TEST_STORAGE_STATE;
 test.skip(!state,'Start the storage stack with --grafana and run test:storage first.');
 const base=Number(process.env.SCRIBYRA_TEST_STORAGE_PORT_BASE||18789);
 const grafana=`http://127.0.0.1:${base+9}`;
 const password=(await readFile(`${state}/grafana-admin.password`,'utf8')).trim();
 const evidence=JSON.parse(await readFile(`${state}/readback-evidence.json`,'utf8'));
 const authorization='Basic '+Buffer.from('operator:'+password).toString('base64');
 async function api(path,options={}){
  const response=await fetch(grafana+path,{...options,headers:{Authorization:authorization,'Content-Type':'application/json',...options.headers}});
  expect(response.status,`Grafana request ${path.split('?')[0]}`).toBeLessThan(400);
  return response.status===204?undefined:response.json();
 }
 expect((await fetch(grafana+'/api/search')).status).toBe(401);
 const datasources=await api('/api/datasources');
 expect(datasources.map(d=>d.uid).sort()).toEqual(['scribyra-loki','scribyra-prom','scribyra-tempo']);
 const settings=await api('/api/admin/settings');
 expect(settings['auth.anonymous'].enabled).toBe('false');
 expect(settings.smtp.enabled).toBe('false');
 const folders=await api('/api/search?type=dash-folder');
 expect(folders.filter(folder=>folder.title==='Scribyra')).toHaveLength(1);
 const dashboards={};
 for(const uid of ['scribyra-operations','scribyra-delivery','scribyra-test-runs']){
  dashboards[uid]=await api('/api/dashboards/uid/'+uid);
  expect(dashboards[uid].meta.provisioned).toBeTruthy();
  expect(dashboards[uid].dashboard.editable).toBe(false);
 }
 const proxy=(uid,path,params)=>api('/api/datasources/proxy/uid/'+uid+path+'?'+new URLSearchParams(params));
 const metric=await proxy('scribyra-prom','/api/v1/query',{query:'scribyra_operation_total{scribyra_operation="compile",scribyra_outcome="success"}',time:String(Date.parse(evidence.verifiedAt)/1000)});
 expect(metric.data.result.some(row=>Number(row.value[1])>0)).toBeTruthy();
 const logs=await proxy('scribyra-loki','/loki/api/v1/query_range',{query:`{service_name="scribyra"} |= "${evidence.traceId}"`,start:evidence.since,limit:'1000'});
 expect(logs.data.result.length).toBeGreaterThan(0);
 const trace=await api('/api/datasources/proxy/uid/scribyra-tempo/api/traces/'+evidence.traceId,{headers:{Accept:'application/json'}});
 expect(JSON.stringify(trace)).toContain('tex_pass');
 // Every provisioned PromQL expression must parse against the real backend;
 // empty data is valid for sparse observations and explicitly described in UI.
 for(const view of Object.values(dashboards))for(const panel of view.dashboard.panels){
  const variables=Object.fromEntries(view.dashboard.templating.list.map(v=>[v.name,v.current.value==='$__all'?v.allValue:v.current.value]));
  const interpolate=text=>text?.replace(/\$\{(\w+):regex\}/g,(_,key)=>variables[key]);
  if(!panel.targets?.length)continue;
  const response=await api('/api/ds/query',{method:'POST',body:JSON.stringify({from:'now-1h',to:'now',queries:panel.targets.map(target=>({...target,expr:interpolate(target.expr),query:interpolate(target.query),datasource:panel.datasource,intervalMs:15000,maxDataPoints:240}))})});
  expect(Object.values(response.results).every(result=>!result.error&&result.status===200)).toBeTruthy();
 }
 const rules=await api('/api/v1/provisioning/alert-rules');
 expect(rules).toHaveLength(7);
 expect(rules.every(rule=>rule.execErrState==='Error'&&!rule.isPaused)).toBeTruthy();
 const failures=rules.find(rule=>rule.uid==='scribyra-failures');
 expect(failures.noDataState).toBe('OK');
 expect(rules.find(rule=>rule.uid==='scribyra-ingress-down').noDataState).toBe('Alerting');
 const initial=await api('/api/prometheus/grafana/api/v1/rules');
 expect(initial.data.groups.flatMap(group=>group.rules).every(rule=>rule.health==='ok')).toBeTruthy();
 expect(initial.data.groups.flatMap(group=>group.rules).find(rule=>rule.name===failures.title).state,'Use a fresh state directory for the failure-transition check.').toBe('inactive');

 await page.goto(grafana+'/login');
 await page.getByLabel(/email or username/i).fill('operator');
 await page.getByLabel(/^password$/i).fill(password);
 await page.getByRole('button',{name:/^log in$/i}).click();
 await expect(page).not.toHaveURL(/\/login/);
 await page.goto(grafana+'/d/scribyra-operations');
 await expect(page.getByText('Recent activity',{exact:true})).toBeVisible();
 await expect(page.getByText('Received operations',{exact:true})).toBeVisible();
 await page.goto(grafana+'/d/scribyra-delivery');
 await expect(page.getByText('Seconds since last accepted batch',{exact:true})).toBeVisible();

 // Use actual application compilation failures, not a fabricated alert series.
 await page.goto('/');
 const chooser=page.waitForEvent('filechooser');
 await page.getByRole('button',{name:'Import ZIP',exact:true}).click();
 await(await chooser).setFiles({name:'PRIVATE_GRAFANA_FAILURE.zip',mimeType:'application/zip',buffer:Buffer.from(zipSync({'PRIVATE_FAILURE.tex':strToU8('\\documentclass{article}\n\\begin{document}\\PrivateUndefinedCommand{PrivateGrafanaFailureContent}\\end{document}')}))});
 await expect(page.locator('.cm-content')).toBeVisible();
 if(await page.getByRole('button',{name:'More tools',exact:true}).isVisible())await page.getByRole('button',{name:'More tools',exact:true}).click();await page.getByRole('button',{name:'Diagnostics',exact:true}).click();
 const dialog=page.getByRole('dialog',{name:'Local diagnostics'});
 await dialog.getByLabel('Collect local diagnostics').check();
 const token=(await readFile(`${state}/ingress.token`,'utf8')).trim();
 const failureStart=String(BigInt(Date.now())*1000000n);
 await dialog.getByLabel('Telemetry endpoint',{exact:true}).fill(`http://127.0.0.1:${base}/v1/events`);
 await dialog.getByLabel('Ingest token',{exact:true}).fill(token);
 await dialog.getByLabel('Activity source',{exact:true}).selectOption(process.env.SCRIBYRA_TELEMETRY_SOURCE||'local_test');await dialog.getByRole('button',{name:'Connect telemetry host',exact:true}).click();
 await dialog.getByRole('button',{name:'Close',exact:true}).click();
 const probe=structuredClone(failures);delete probe.id;delete probe.updated;delete probe.provenance;
 const group='Scribyra browser failure validation',folder=failures.folderUID;
 const groupPath=`/api/v1/provisioning/folder/${folder}/rule-groups/${encodeURIComponent(group)}`;
 const source=process.env.SCRIBYRA_TELEMETRY_SOURCE||'local_test';
 Object.assign(probe,{uid:'scribyra-browser-failure-probe',title:'Scribyra controlled browser failure',ruleGroup:group,for:'0s',labels:{product:'scribyra',activity:'controlled_validation'}});
 probe.data[0].model.expr=probe.data[0].model.expr.replace('scribyra_source="application"',`scribyra_source="${source}"`);
 await api(groupPath,{method:'PUT',body:JSON.stringify({folderUid:folder,title:group,interval:10,rules:[probe]})});
 try{
 for(let i=0;i<3;i++){
  await page.evaluate(()=>window.scribyra.lastCompile=null);
  await page.getByRole('button',{name:'Compile',exact:true}).click();
  await expect.poll(()=>page.evaluate(()=>window.scribyra.lastCompile),{timeout:180000}).toBeTruthy();
  expect((await page.evaluate(()=>window.scribyra.lastCompile)).success).toBe(false);
  await page.waitForTimeout(1100);
 }
 await expect.poll(async()=>{
  const data=await api('/api/prometheus/grafana/api/v1/rules');
  return data.data.groups.flatMap(group=>group.rules).find(rule=>rule.name===probe.title)?.state;
 },{timeout:150000,intervals:[1000,5000,10000]}).toBe('firing');
 const isolated=await api('/api/prometheus/grafana/api/v1/rules');expect(isolated.data.groups.flatMap(g=>g.rules).find(r=>r.name===failures.title).state).toBe('inactive');
 const failedLogs=await proxy('scribyra-loki','/loki/api/v1/query_range',{query:'{service_name="scribyra"} | json | outcome="failure"',start:failureStart,limit:'1000'});
 const failedEvents=failedLogs.data.result.flatMap(row=>row.values.map(([,body])=>JSON.parse(body)));
 const failedCompile=failedEvents.find(event=>event.operation==='compile'&&event.outcome==='failure');
 expect(failedCompile).toBeTruthy();
 const failedTrace=await api('/api/datasources/proxy/uid/scribyra-tempo/api/traces/'+failedCompile.traceId,{headers:{Accept:'application/json'}});
 expect(JSON.stringify(failedTrace)).toContain('tex_pass');
 const stored=JSON.stringify({metric,logs,trace,failedLogs,failedTrace});
 expect(stored).not.toMatch(/PrivateGrafanaFailureContent|PrivateUndefinedCommand|PRIVATE_GRAFANA_FAILURE|PRIVATE_FAILURE/);
 expect(!stored.includes(token)&&!stored.includes(password)).toBeTruthy();
 await writeFile(`${state}/grafana-evidence.json`,JSON.stringify({version:1,source:'actual-browser-compile',browser:test.info().project.name,verifiedAt:new Date().toISOString(),successTraceId:evidence.traceId,failureTraceId:failedCompile.traceId,checks:['authentication','private-dashboards','all-panel-queries','metrics-logs-traces','controlled-failure-alert-firing','application-source-isolated','private-content-exclusion']}),{mode:0o600});
 }finally{await api(groupPath,{method:'DELETE'});}
});
