import {test,expect} from '@playwright/test';
import {Client,StreamableHTTPClientTransport} from '@modelcontextprotocol/client';
import {zipSync,strToU8} from 'fflate';
import {startCompanion,enableCompanionDev} from '../helpers/companion-server.mjs';
import {telemetryServer,ingestionAvailable} from '../helpers/telemetry-server.mjs';
test.use({trace:'off',screenshot:'off',video:'off'});
test.beforeEach(({context})=>enableCompanionDev(context));
const allSpans=captures=>captures.records.filter(row=>row.signal==='traces').flatMap(row=>row.data.resourceSpans.flatMap(resource=>resource.scopeSpans.flatMap(scope=>scope.spans)));
const runtime=span=>span.attributes.find(attribute=>attribute.key==='scribyra.runtime')?.value.stringValue;
test('native companion and real browser worker export one correlated trace through Alloy',async({page,baseURL})=>{
 test.skip(!ingestionAvailable(),'Build telemetry bins/examples, companion and pinned Alloy.');
 const app=process.env.SCRIBYRA_TEST_PAGES_URL?new URL('app/',process.env.SCRIBYRA_TEST_PAGES_URL).href:baseURL;
 const origin=new URL(app).origin,ingress=await telemetryServer(origin);let server,remote;
 try{
  server=await startCompanion({origin,telemetry:ingress});
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
  let captures,compile,native,browser;
  await expect.poll(async()=>{
   captures=await ingress.captures();const spans=allSpans(captures);
   compile=spans.find(span=>span.name==='compile'&&span.status?.code===1);
   browser=compile&&spans.find(span=>span.name==='mcp'&&span.spanId===compile.parentSpanId&&span.traceId===compile.traceId);
   native=browser&&spans.find(span=>span.name==='mcp'&&runtime(span)==='companion'&&span.spanId===browser.parentSpanId&&span.traceId===compile.traceId);
   const passes=compile?spans.filter(span=>span.name==='worker_pass'&&span.parentSpanId===compile.spanId&&span.traceId===compile.traceId):[];
   return !!native&&spans.some(span=>span.name==='tex_pass'&&span.traceId===compile.traceId&&passes.some(parent=>parent.spanId===span.parentSpanId));
  },{timeout:20000}).toBeTruthy();
  const stored=JSON.stringify(captures);
  for(const value of ['NeverNativePrivateContent','PRIVATE_NATIVE_PROJECT','PRIVATE_NATIVE_FILE',settings.projectId,server.code,settings.headers.Authorization,ingress.token,ingress.url,ingress.tokenFile])expect(stored.includes(value),'Private data excluded from exported trace').toBe(false);
 }finally{await remote?.close().catch(()=>{});await server?.close();await ingress.close();}
});
