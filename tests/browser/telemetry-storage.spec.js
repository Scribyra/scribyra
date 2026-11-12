import {test,expect} from '@playwright/test';
import {readFile,writeFile} from 'node:fs/promises';
import {zipSync,strToU8} from 'fflate';
// Private diagnostic fixtures and ingest credentials must never enter browser traces.
test.use({trace:'off',screenshot:'off',video:'off'});

// Operator-started stack: real retained backends, deliberately separate from the
// bounded protobuf evidence sink. No backend API response enters app telemetry.
test('actual browser compile is queryable in Prometheus, Loki and Tempo',async({page})=>{
 const state=process.env.SCRIBYRA_TEST_STORAGE_STATE;
 test.skip(!state,'Start scripts/telemetry-stack.py and set SCRIBYRA_TEST_STORAGE_STATE.');
 const base=Number(process.env.SCRIBYRA_TEST_STORAGE_PORT_BASE||18789);
 const url=offset=>`http://127.0.0.1:${base+offset}`;
 const token=(await readFile(`${state}/ingress.token`,'utf8')).trim();
 const since=BigInt(Date.now())*1000000n;
 await page.goto('/');
 const chooser=page.waitForEvent('filechooser');
 await page.getByRole('button',{name:'Import ZIP',exact:true}).click();
 await(await chooser).setFiles({name:'PRIVATE_STORAGE_PROJECT.zip',mimeType:'application/zip',buffer:Buffer.from(zipSync({'PRIVATE_STORAGE_FILE.tex':strToU8('\\documentclass{article}\n\\begin{document}PrivateStoredPaperMustNotLeaveBrowser\\end{document}')}))});
 await expect(page.locator('.cm-content')).toBeVisible();
 if(await page.getByRole('button',{name:'More tools',exact:true}).isVisible())await page.getByRole('button',{name:'More tools',exact:true}).click();await page.getByRole('button',{name:'Diagnostics',exact:true}).click();
 const dialog=page.getByRole('dialog',{name:'Local diagnostics'});
 await dialog.getByLabel('Collect local diagnostics').check();
 await dialog.getByLabel('Telemetry endpoint',{exact:true}).fill(url(0)+'/v1/events');
 await dialog.getByLabel('Ingest token',{exact:true}).fill(token);
 await dialog.getByLabel('Activity source',{exact:true}).selectOption(process.env.SCRIBYRA_TELEMETRY_SOURCE||'local_test');await dialog.getByRole('button',{name:'Connect telemetry host',exact:true}).click();
 await dialog.getByRole('button',{name:'Close',exact:true}).click();
 await page.evaluate(()=>window.scribyra.lastCompile=null);
 await page.getByRole('button',{name:'Compile',exact:true}).click();
 await expect.poll(()=>page.evaluate(()=>window.scribyra.lastCompile),{timeout:180000}).toBeTruthy();
 expect((await page.evaluate(()=>window.scribyra.lastCompile)).success).toBeTruthy();
 let logs,root,metric,trace;
 const query=new URLSearchParams({query:'{service_name="scribyra"}',start:String(since),limit:'1000'});
 await expect.poll(async()=>{
  logs=await(await fetch(url(4)+'/loki/api/v1/query_range?'+query)).json();
  const events=logs.data?.result?.flatMap(row=>row.values.map(([,body])=>{try{return JSON.parse(body);}catch{return{};}}))||[];
  root=events.find(e=>e.operation==='compile'&&e.outcome==='success');return !!root;
 },{timeout:30000}).toBeTruthy();
 await expect.poll(async()=>{
  metric=await(await fetch(url(3)+'/api/v1/query?'+new URLSearchParams({query:'scribyra_operation_total{scribyra_operation="compile",scribyra_outcome="success"}'}))).json();
  return metric.data?.result?.some(row=>Number(row.value[1])>0);
 },{timeout:30000}).toBeTruthy();
 await expect.poll(async()=>{
  const response=await fetch(url(6)+'/api/traces/'+root.traceId,{headers:{Accept:'application/json'}});
  if(!response.ok)return false;trace=await response.json();
  return JSON.stringify(trace).includes('tex_pass');
 },{timeout:30000}).toBeTruthy();
 const stored=JSON.stringify({logs,metric,trace});
 expect(stored).not.toMatch(/PrivateStoredPaperMustNotLeaveBrowser|PRIVATE_STORAGE_PROJECT|PRIVATE_STORAGE_FILE/);
 expect(!stored.includes(token)&&!stored.includes(url(0))).toBeTruthy();
 const spans=(trace.batches||trace.resourceSpans||[]).flatMap(batch=>(batch.scopeSpans||batch.instrumentationLibrarySpans||[]).flatMap(scope=>scope.spans||[]));
 expect(spans.some(span=>span.name==='compile')).toBeTruthy();
 expect(spans.some(span=>span.name==='tex_pass')).toBeTruthy();
 const hex=value=>/^[0-9a-f]{32}$/.test(value)?value:Buffer.from(value,'base64').toString('hex');
 expect(spans.filter(span=>['compile','tex_pass'].includes(span.name)).every(span=>hex(span.traceId)===root.traceId)).toBeTruthy();
 await writeFile(`${state}/readback-evidence.json`,JSON.stringify({version:1,source:'actual-browser-compile',browser:test.info().project.name,verifiedAt:new Date().toISOString(),traceId:root.traceId,since:String(since),checks:['prometheus','loki','tempo','private-content-exclusion']}),{mode:0o600});
});
