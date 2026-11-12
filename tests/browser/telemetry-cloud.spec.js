import {test,expect} from '@playwright/test';
import {readFile,writeFile} from 'node:fs/promises';
import {zipSync,strToU8} from 'fflate';
const spans=trace=>(trace?.batches||trace?.resourceSpans||[]).flatMap(batch=>(batch.scopeSpans||batch.instrumentationLibrarySpans||[]).flatMap(scope=>scope.spans||[]));
const hex=(value,length)=>typeof value==='string'&&value.length===length&&/^[a-f0-9]+$/.test(value)?value:Buffer.from(value||'','base64').toString('hex');
function correlated(trace,event){
 const records=spans(trace),ids=new Set(records.map(span=>hex(span.spanId,16)));
 return records.some(span=>span.name==='compile'&&hex(span.spanId,16)===event.spanId)&&records.some(span=>span.name==='tex_pass'&&ids.has(hex(span.parentSpanId,16)))&&records.every(span=>hex(span.traceId,32)===event.traceId);
}
test.use({trace:'off',screenshot:'off',video:'off'});
test('real release browser compiles cross Rust ingress and Alloy into managed Grafana',async({page})=>{
 const state=process.env.SCRIBYRA_TEST_CLOUD_STATE,url=process.env.SCRIBYRA_TEST_PAGES_URL;
 test.skip(!state||!url,'Requires explicitly configured private Cloud credentials and a running collector/Pages preview.');
 const base=Number(process.env.SCRIBYRA_TEST_CLOUD_PORT_BASE||18789);
 const grafana=new URL(process.env.SCRIBYRA_TEST_GRAFANA_URL);
 if(grafana.protocol!=='https:'||grafana.username||grafana.password||grafana.search||grafana.hash)throw Error('Use a canonical HTTPS Grafana URL without embedded credentials');
 const management=(await readFile(process.env.SCRIBYRA_TEST_GRAFANA_TOKEN_FILE,'utf8')).trim();
 const ingest=(await readFile(`${state}/ingress.token`,'utf8')).trim();
 const collector=(await readFile(process.env.SCRIBYRA_CLOUD_TOKEN_FILE,'utf8')).trim();
 const since=BigInt(Date.now())*1000000n;
 async function api(path,params){
  const response=await fetch(new URL(path+(params?'?'+new URLSearchParams(params):''),grafana),{headers:{Authorization:'Bearer '+management,Accept:'application/json'},redirect:'error',signal:AbortSignal.timeout(15000)});
  if(response.status===404&&path.includes('/api/traces/'))return null;
  expect(response.status,'Authenticated Grafana query status').toBe(200);
  const bytes=new Uint8Array(await response.arrayBuffer());expect(bytes.length).toBeLessThan(8*1024*1024);
  return JSON.parse(new TextDecoder().decode(bytes));
 }
 const proxy=(uid,path,params)=>api('/api/datasources/proxy/uid/'+uid+path,params);
 await page.goto(new URL('app/',url).href);
 const chooser=page.waitForEvent('filechooser');await page.getByRole('button',{name:'Import ZIP',exact:true}).click();
 await(await chooser).setFiles({name:'PRIVATE_CLOUD_PROJECT.zip',mimeType:'application/zip',buffer:Buffer.from(zipSync({'PRIVATE_CLOUD_FILE.tex':strToU8('\\documentclass{article}\n\\begin{document}NeverCloudPrivatePaperContent\\end{document}')}))});
 await expect(page.locator('.cm-content')).toBeVisible();
 if(await page.getByRole('button',{name:'More tools',exact:true}).isVisible())await page.getByRole('button',{name:'More tools',exact:true}).click();await page.getByRole('button',{name:'Diagnostics',exact:true}).click();
 const dialog=page.getByRole('dialog',{name:'Local diagnostics'});
 await dialog.getByLabel('Collect local diagnostics').check();
 const endpoint=`http://127.0.0.1:${base}/v1/events`;
 await dialog.getByLabel('Telemetry endpoint',{exact:true}).fill(endpoint);
 await dialog.getByLabel('Ingest token',{exact:true}).fill(ingest);
 await dialog.getByLabel('Activity source',{exact:true}).selectOption(process.env.SCRIBYRA_TELEMETRY_SOURCE||'local_test');await dialog.getByRole('button',{name:'Connect telemetry host',exact:true}).click();
 await dialog.getByRole('button',{name:'Close',exact:true}).click();
 async function compile(success){await page.evaluate(()=>window.scribyra.lastCompile=null);await page.getByRole('button',{name:'Compile',exact:true}).click();await expect.poll(()=>page.evaluate(()=>window.scribyra.lastCompile),{timeout:180000}).toBeTruthy();expect((await page.evaluate(()=>window.scribyra.lastCompile)).success).toBe(success);}
 await compile(true);await expect(page.locator('#pdf-viewer canvas').first()).toBeVisible();
 let logs,root,metric,trace,health;
 await expect.poll(async()=>{
  logs=await proxy('grafanacloud-logs','/loki/api/v1/query_range',{query:'{service_name="scribyra"}',start:String(since),limit:'1000'});
  root=logs.data?.result?.flatMap(row=>row.values.map(([,body])=>{try{return JSON.parse(body);}catch{return{};}})).find(e=>e.operation==='compile'&&e.outcome==='success');
  return !!root;
 },{timeout:120000,intervals:[1000,5000]}).toBeTruthy();
 expect(/^[a-f0-9]{32}$/.test(root.traceId),'Validated trace ID').toBeTruthy();
 await expect.poll(async()=>{
  metric=await proxy('grafanacloud-prom','/api/v1/query',{query:'scribyra_operation_total{scribyra_operation="compile",scribyra_outcome="success"}'});
  return metric.data?.result?.some(row=>Number(row.value[1])>0&&row.value[0]>=Number(since)/1e9);
 },{timeout:120000,intervals:[1000,5000]}).toBeTruthy();
 await expect.poll(async()=>{
  trace=await proxy('grafanacloud-traces','/api/traces/'+root.traceId);
  return correlated(trace,root);
 },{timeout:120000,intervals:[1000,5000]}).toBeTruthy();
 await expect.poll(async()=>{
  health=await proxy('grafanacloud-prom','/api/v1/query',{query:'up{job="scribyra-ingress"}'});
  return health.data?.result?.some(row=>row.value[1]==='1'&&row.metric.instance==='scribyra-ingress');
 },{timeout:60000,intervals:[1000,5000]}).toBeTruthy();
 const failureSince=String(BigInt(Date.now())*1000000n);
 await page.locator('.cm-content').click();await page.keyboard.press('Control+A');
 await page.keyboard.insertText('\\documentclass{article}\n\\begin{document}\\NeverCloudPrivateCommand{NeverCloudFailureContent}\\end{document}');
 await expect(page.locator('.save-indicator')).toHaveText('Saved locally');await compile(false);
 let failedLogs,failedRoot,failedTrace;
 await expect.poll(async()=>{
  failedLogs=await proxy('grafanacloud-logs','/loki/api/v1/query_range',{query:'{service_name="scribyra"} | json | outcome="failure"',start:failureSince,limit:'1000'});
  failedRoot=failedLogs.data?.result?.flatMap(row=>row.values.map(([,body])=>{try{return JSON.parse(body);}catch{return{};}})).find(e=>e.operation==='compile'&&e.outcome==='failure');
  return !!failedRoot;
 },{timeout:120000,intervals:[1000,5000]}).toBeTruthy();
 expect(/^[a-f0-9]{32}$/.test(failedRoot.traceId),'Validated failure trace ID').toBeTruthy();
 await expect.poll(async()=>{
  failedTrace=await proxy('grafanacloud-traces','/api/traces/'+failedRoot.traceId);
  return correlated(failedTrace,failedRoot);
 },{timeout:120000,intervals:[1000,5000]}).toBeTruthy();
 const stored=JSON.stringify({logs,metric,trace,health,failedLogs,failedTrace});
 expect(/NeverCloudPrivatePaperContent|NeverCloudPrivateCommand|NeverCloudFailureContent|PRIVATE_CLOUD_PROJECT|PRIVATE_CLOUD_FILE/.test(stored),'Private content excluded').toBe(false);
 for(const secret of [ingest,management,collector,endpoint])expect(stored.includes(secret),'Credential/destination excluded').toBe(false);
 // Browser storage/export controls never receive the management credential.
 const local=await page.evaluate(()=>JSON.stringify({...localStorage}));
 expect(local.includes(ingest)||local.includes(management)||local.includes(collector),'Credentials absent from browser storage').toBe(false);
 await writeFile(`${state}/cloud-evidence.json`,JSON.stringify({version:1,source:'actual-browser-compile',browser:test.info().project.name,verifiedAt:new Date().toISOString(),traceId:root.traceId,failureTraceId:failedRoot.traceId,checks:['rust-ingress','alloy-cloud-auth','grafana-metric-log-worker-trace','actual-failed-compile-trace','private-content-exclusion','fixed-label-ingress-health']}),{mode:0o600});
});
