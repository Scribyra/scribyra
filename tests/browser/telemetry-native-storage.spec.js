import {test,expect} from '@playwright/test';
import {Client,StreamableHTTPClientTransport} from '@modelcontextprotocol/client';
import {zipSync,strToU8} from 'fflate';
import {startCompanion,enableCompanionDev} from '../helpers/companion-server.mjs';
import {telemetryReadback,traceSpans,hex,eventDigest} from '../helpers/telemetry-readback.mjs';
import {writeFile} from 'node:fs/promises';
test.use({trace:'off',screenshot:'off',video:'off'});
test.beforeEach(({context})=>enableCompanionDev(context));
const runtime=span=>span.attributes.find(attribute=>attribute.key==='scribyra.runtime')?.value.stringValue;
test('native MCP browser and worker chain is retained and queryable through private Grafana',async({page,baseURL})=>{
 test.skip(!process.env.SCRIBYRA_TEST_STORAGE_STATE,'Start the private storage stack with Grafana and select its state.');
 const rb=await telemetryReadback(),since=String(BigInt(Date.now())*1000000n);
 const app=process.env.SCRIBYRA_TEST_PAGES_URL?new URL('app/',process.env.SCRIBYRA_TEST_PAGES_URL).href:baseURL;
 const origin=new URL(app).origin,ingress={url:rb.endpoint,token:rb.token,tokenFile:rb.tokenFile};let server,remote;
 try{
  server=await startCompanion({origin,telemetry:ingress,environment:rb.nativeEnvironment()});
  await page.goto(app);const chooser=page.waitForEvent('filechooser');await page.getByRole('button',{name:'Import ZIP',exact:true}).click();
  await(await chooser).setFiles({name:'PRIVATE_NATIVE_PROJECT.zip',mimeType:'application/zip',buffer:Buffer.from(zipSync({'PRIVATE_NATIVE_FILE.tex':strToU8('\\documentclass{article}\n\\begin{document}NeverNativePrivateContent\\end{document}')}))});
  await expect(page.locator('.cm-content')).toBeVisible();
  if(await page.getByRole('button',{name:'More tools',exact:true}).isVisible())await page.getByRole('button',{name:'More tools',exact:true}).click();await page.getByRole('button',{name:'Diagnostics',exact:true}).click();let dialog=page.getByRole('dialog',{name:'Local diagnostics'});
  await dialog.getByLabel('Collect local diagnostics').check();await dialog.getByLabel('Telemetry endpoint',{exact:true}).fill(ingress.url);await dialog.getByLabel('Ingest token',{exact:true}).fill(ingress.token);await dialog.getByLabel('Activity source',{exact:true}).selectOption(process.env.SCRIBYRA_TELEMETRY_SOURCE||'local_test');await dialog.getByRole('button',{name:'Connect telemetry host',exact:true}).click();await dialog.getByRole('button',{name:'Close',exact:true}).click();
  await page.getByRole('button',{name:'More tools',exact:true}).click();await page.getByRole('button',{name:'Rust companion and MCP',exact:true}).click();dialog=page.getByRole('dialog',{name:'Rust companion and MCP',exact:true});
  await dialog.getByLabel('Companion address',{exact:true}).fill(server.url);await dialog.getByLabel('Pairing code',{exact:true}).fill(server.code);await dialog.getByRole('checkbox',{name:'Let tools start compilation',exact:true}).check();await dialog.getByRole('button',{name:'Pair companion',exact:true}).click();await expect(dialog.getByRole('status')).toContainText('Connected');
  await dialog.getByRole('button',{name:'Show MCP connection settings',exact:true}).click();const settings=JSON.parse(await dialog.getByLabel('MCP connection settings',{exact:true}).inputValue());await dialog.getByRole('button',{name:'Close',exact:true}).click();
  remote=new Client({name:'Native telemetry verification',version:'1.0.0'},{versionNegotiation:{mode:{pin:'2026-07-28'}}});await remote.connect(new StreamableHTTPClientTransport(new URL(settings.url),{requestInit:{headers:settings.headers}}));
  const inspect=await remote.callTool({name:'inspect_project',arguments:{}});expect(inspect.isError).toBeFalsy();const revision=inspect.structuredContent.revision;
  const compiled=await remote.callTool({name:'compile_project',arguments:{projectId:settings.projectId,expectedRevision:revision}},{timeout:180000});expect(compiled.isError).toBeFalsy();expect(compiled.structuredContent.value.success).toBeTruthy();await expect(page.locator('#pdf-viewer canvas').first()).toBeVisible();
  if(await page.getByRole('button',{name:'More tools',exact:true}).isVisible())await page.getByRole('button',{name:'More tools',exact:true}).click();await page.getByRole('button',{name:'Diagnostics',exact:true}).click();dialog=page.getByRole('dialog',{name:'Local diagnostics'});
  const local=JSON.parse(await dialog.getByLabel('Diagnostic export preview').textContent());
  const compile=local.events.findLast(event=>event.runtime==='browser'&&event.operation==='compile'&&event.outcome==='success');expect(compile,'Actual browser diagnostics must identify the MCP-triggered compile').toBeTruthy();
  await dialog.getByRole('button',{name:'Close',exact:true}).click();
  const logs=await rb.poll(()=>rb.logs(`{service_name="scribyra"} |= "${compile.traceId}"`,since),data=>rb.events(data).some(event=>event.spanId===compile.spanId&&eventDigest(event)===eventDigest(compile)),'Exact browser support record must be stored');
  let native,browser;
  const trace=await rb.poll(()=>rb.trace(compile.traceId),trace=>{
   const spans=traceSpans(trace);
   const root=spans.find(span=>span.name==='compile'&&hex(span.spanId)===compile.spanId);
   browser=root&&spans.find(span=>span.name==='mcp'&&runtime(span)==='browser'&&hex(span.spanId)===hex(root.parentSpanId)&&hex(span.traceId)===compile.traceId);
   native=browser&&spans.find(span=>span.name==='mcp'&&runtime(span)==='companion'&&hex(span.spanId)===hex(browser.parentSpanId)&&hex(span.traceId)===compile.traceId);
   const passes=root?spans.filter(span=>span.name==='worker_pass'&&hex(span.parentSpanId)===compile.spanId&&hex(span.traceId)===compile.traceId):[];
   return !!native&&spans.some(span=>span.name==='tex_pass'&&hex(span.traceId)===compile.traceId&&passes.some(parent=>hex(parent.spanId)===hex(span.parentSpanId)));
  },'Actual native MCP → browser → compiler worker chain must be retained');
  expect(traceSpans(trace).every(span=>(span.attributes||[]).some(a=>a.key==='scribyra.source'&&a.value.stringValue===rb.source)),'Correlated spans must carry explicit automated source; rebuild native prerequisites').toBeTruthy();
  const nativeLogs=await rb.poll(()=>rb.logs(`{service_name="scribyra"} |= "${compile.traceId}"`,since),data=>rb.events(data).some(event=>event.runtime==='companion'&&event.operation==='mcp'&&event.spanId===hex(native.spanId)),'Native MCP event must share the stored compile trace');
  const metric=await rb.poll(()=>rb.metric(`scribyra_operation_total{scribyra_source="${rb.source}",scribyra_runtime="companion",scribyra_operation="mcp",scribyra_outcome="success"}`),data=>data.data.result.some(p=>Number(p.value[1])>0),'Actual native MCP metric must be queryable');
  await rb.poll(()=>rb.freshMetric(`scribyra_operation_total{scribyra_source="${rb.source}",scribyra_runtime="companion",scribyra_operation="mcp",scribyra_outcome="success"}`,since),Boolean,'Native MCP metric must have a fresh sample from this scenario');
  rb.privateData({local,trace,logs,nativeLogs,metric},['NeverNativePrivateContent','PRIVATE_NATIVE_PROJECT','PRIVATE_NATIVE_FILE',settings.projectId,server.code,settings.headers.Authorization,settings.headers.Authorization.replace(/^Bearer /,''),server.url,rb.endpoint,rb.tokenFile]);
  await writeFile(rb.state+'/native-browser-evidence-'+test.info().project.name+'.json',JSON.stringify({version:1,source:rb.source,browser:test.info().project.name,verifiedAt:new Date().toISOString(),observedAt:Date.now()/1000,since,traceId:compile.traceId,compileSpanId:compile.spanId,eventDigest:eventDigest(compile),browserMcpSpanId:hex(browser.spanId),nativeMcpSpanId:hex(native.spanId),checks:['actual-native-mcp','exact-parent-span-chain','retained-metrics-logs-traces','private-data-excluded']}),{mode:0o600});
 }finally{await remote?.close().catch(()=>{});await server?.close();}
});
