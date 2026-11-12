import {test,expect} from '@playwright/test';
import {Client,StreamableHTTPClientTransport} from '@modelcontextprotocol/client';
import {zipSync,strToU8} from 'fflate';
import {writeFile} from 'node:fs/promises';
import {startCompanion,enableCompanionDev} from '../helpers/companion-server.mjs';
import {telemetryReadback,traceSpans,hex,eventDigest} from '../helpers/telemetry-readback.mjs';

test.use({trace:'off',screenshot:'off',video:'off'});
const source='\\documentclass{article}\n\\begin{document}PrivateOperationalPaper\\end{document}';
const open=async page=>{if(await page.getByRole('button',{name:'More tools',exact:true}).isVisible())await page.getByRole('button',{name:'More tools',exact:true}).click();await page.getByRole('button',{name:'Diagnostics',exact:true}).click();return page.getByRole('dialog',{name:'Local diagnostics'});};
async function replace(page,text){await page.locator('.cm-content').click();await page.keyboard.press('Control+A');await page.keyboard.insertText(text);}
async function compile(page){await page.evaluate(()=>window.scribyra.lastCompile=null);await page.getByRole('button',{name:'Compile',exact:true}).click();await expect.poll(()=>page.evaluate(()=>window.scribyra.lastCompile),{timeout:180000}).toBeTruthy();return page.evaluate(()=>window.scribyra.lastCompile.success);}

test('actual package, save, recovery and MCP failures retain exact safe diagnostic records',async({page,context,baseURL})=>{
 await enableCompanionDev(context);
 test.skip(!process.env.SCRIBYRA_TEST_STORAGE_STATE,'Select the private self-hosted Grafana stack.');
 const rb=await telemetryReadback(),since=String(BigInt(Date.now())*1000000n),receipts=[];let server,remote,peer;
 const forbidden=['PrivateOperationalPaper','PrivatePackageFailure','PrivateQuotaFailure','PrivateUndefinedCommand','private-operational.tex'];
 async function verify(operation,outcome){
  const d=await open(page);let local,record;
  await expect.poll(async()=>{await d.getByRole('button',{name:'Refresh timeline',exact:true}).click();local=JSON.parse(await d.getByLabel('Diagnostic export preview').textContent());record=local.events.findLast(e=>e.operation===operation&&e.outcome===outcome);return Boolean(record);},{message:`${operation}/${outcome} must exist in actual local diagnostics`,timeout:10000}).toBe(true);
  await d.getByRole('button',{name:'Close',exact:true}).click();
  const logs=await rb.poll(()=>rb.logs(`{service_name="scribyra"} |= "${record.traceId}"`,since),r=>rb.events(r).some(e=>e.spanId===record.spanId&&eventDigest(e)===eventDigest(record)),'Exact local diagnostic record must be queryable in Loki');
  const trace=await rb.poll(()=>rb.trace(record.traceId),t=>traceSpans(t).some(s=>hex(s.spanId)===record.spanId),'Exact diagnostic span must be queryable in Tempo');
  if(operation==='mcp')expect(traceSpans(trace).some(s=>hex(s.spanId)===record.parentSpanId),'Native parent must be retained with browser MCP outcome').toBe(true);
  const query=`scribyra_operation_total{scribyra_source="local_test",scribyra_runtime="${record.runtime}",scribyra_operation="${operation}",scribyra_outcome="${outcome}"}`;
  await rb.poll(()=>rb.freshMetric(query,since),Boolean,'Failure metric must belong to this scenario');
  if(operation==='recovery')expect(traceSpans(trace).some(s=>s.name==='storage_commit'&&hex(s.parentSpanId)===record.spanId),'Recovered-copy save must be a child of the recovery outcome').toBe(true);
  rb.privateData({local,logs,trace},forbidden);
  receipts.push({operation,outcome,traceId:record.traceId,spanId:record.spanId,eventDigest:eventDigest(record)});
 }
 try{
  // The actual package downloader fails before contacting an external mirror.
  await page.addInitScript(()=>{const original=fetch.bind(window);window.fetch=(input,options)=>String(input).includes('/archive/')?Promise.reject(new Error('PrivatePackageFailure')):original(input,options);});
  await page.goto('/');const chooser=page.waitForEvent('filechooser');await page.getByRole('button',{name:'Import ZIP',exact:true}).click();await(await chooser).setFiles({name:'operational.zip',mimeType:'application/zip',buffer:Buffer.from(zipSync({'private-operational.tex':strToU8(source)}))});await expect(page.locator('.cm-content')).toBeVisible();
  let d=await open(page);await d.getByLabel('Collect local diagnostics').check();await d.getByLabel('Telemetry endpoint',{exact:true}).fill(rb.endpoint);await d.getByLabel('Ingest token',{exact:true}).fill(rb.token);await d.getByLabel('Activity source',{exact:true}).selectOption('local_test');await d.getByLabel('Remote sampling',{exact:true}).selectOption('1');await d.getByRole('button',{name:'Connect telemetry host',exact:true}).click();await d.getByRole('button',{name:'Close',exact:true}).click();
  await replace(page,source.replace('\\begin{document}','\\usepackage[romanian]{babel}\n\\begin{document}'));expect(await compile(page)).toBe(false);await verify('download','failure');await verify('compile','failure');
  await replace(page,source.replace('PrivateOperationalPaper','\\PrivateUndefinedCommand'));expect(await compile(page)).toBe(false);await verify('compile','failure');
  await page.evaluate(()=>{const put=IDBObjectStore.prototype.put;window.restoreOperationalStorage=()=>IDBObjectStore.prototype.put=put;IDBObjectStore.prototype.put=function(...args){if(this.name==='heads')throw new DOMException('PrivateQuotaFailure','QuotaExceededError');return put.apply(this,args);};});
  await replace(page,source+'\n% private edit');await expect(page.locator('.save-indicator')).toHaveText('Not saved · export a backup');await verify('storage_commit','failure');
  await page.evaluate(()=>window.restoreOperationalStorage());await replace(page,source);await expect(page.locator('.save-indicator')).toHaveText('Saved locally');
  peer=await context.newPage();await peer.goto(baseURL);await peer.getByRole('button',{name:'Project actions',exact:true}).click();await peer.getByRole('menuitem',{name:'Delete project',exact:true}).click();await peer.getByRole('button',{name:'Delete project',exact:true}).click();await expect(page.getByRole('button',{name:'Save recovered copy',exact:true})).toBeVisible();
  await page.evaluate(()=>{const put=IDBObjectStore.prototype.put;window.restoreOperationalStorage=()=>IDBObjectStore.prototype.put=put;IDBObjectStore.prototype.put=function(...args){if(this.name==='heads')throw new DOMException('PrivateQuotaFailure','QuotaExceededError');return put.apply(this,args);};});
  await page.getByRole('button',{name:'Save recovered copy',exact:true}).click();await verify('recovery','failure');await page.evaluate(()=>window.restoreOperationalStorage());await page.getByRole('button',{name:'Save recovered copy',exact:true}).click();await expect(page.getByRole('status')).toContainText('Recovered copy saved');await peer.close();peer=null;
  server=await startCompanion({origin:new URL(baseURL).origin,telemetry:{url:rb.endpoint,tokenFile:rb.tokenFile},environment:rb.nativeEnvironment()});
  await page.getByRole('button',{name:'More tools',exact:true}).click();await page.getByRole('button',{name:'Rust companion and MCP',exact:true}).click();d=page.getByRole('dialog',{name:'Rust companion and MCP',exact:true});await d.getByLabel('Companion address',{exact:true}).fill(server.url);await d.getByLabel('Pairing code',{exact:true}).fill(server.code);await d.getByRole('checkbox',{name:'Let tools start compilation',exact:true}).check();await d.getByRole('button',{name:'Pair companion',exact:true}).click();await expect(d.getByRole('status')).toContainText('Connected');await d.getByRole('button',{name:'Show MCP connection settings',exact:true}).click();const settings=JSON.parse(await d.getByLabel('MCP connection settings',{exact:true}).inputValue());await d.getByRole('button',{name:'Close',exact:true}).click();
  forbidden.push(settings.projectId,server.code,settings.headers.Authorization,server.url);
  remote=new Client({name:'Operational telemetry verification',version:'1.0.0'},{versionNegotiation:{mode:{pin:'2026-07-28'}}});await remote.connect(new StreamableHTTPClientTransport(new URL(settings.url),{requestInit:{headers:settings.headers}}));
  await replace(page,'\\documentclass{article}\n\\begin{document}\\loop\\iftrue\\repeat\\end{document}');await expect(page.locator('.save-indicator')).toHaveText('Saved locally');
  const inspected=await remote.callTool({name:'inspect_project',arguments:{}}),abort=new AbortController();
  const active=remote.callTool({name:'compile_project',arguments:{projectId:settings.projectId,expectedRevision:inspected.structuredContent.revision}},{signal:abort.signal,timeout:180000});active.catch(()=>{});await expect(page.locator('.editor-status')).toContainText('Compiling on your device');abort.abort();await expect(active).rejects.toThrow();await expect(page.locator('.editor-status')).toContainText('Compilation cancelled');await verify('mcp','cancelled');
  const rejected=await remote.callTool({name:'compile_project',arguments:{projectId:settings.projectId,expectedRevision:'stale-operational-revision'}});expect(rejected.isError).toBe(true);await verify('mcp','failure');
  await writeFile(rb.state+'/operational-failures-'+test.info().project.name+'.json',JSON.stringify({version:1,browser:test.info().project.name,verifiedAt:new Date().toISOString(),receipts}),{mode:0o600});
 }finally{await remote?.close().catch(()=>{});await server?.close();await peer?.close();}
});
