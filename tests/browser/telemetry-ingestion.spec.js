import {test,expect} from '@playwright/test';
import {zipSync,strToU8} from 'fflate';
// Private diagnostic fixtures and ingest credentials must never enter browser traces.
test.use({trace:'off',screenshot:'off',video:'off'});
import {telemetryServer,ingestionAvailable} from '../helpers/telemetry-server.mjs';
const spans=captures=>captures.records.filter(row=>row.signal==='traces').flatMap(row=>row.data.resourceSpans.flatMap(resource=>resource.scopeSpans.flatMap(scope=>scope.spans)));
async function compile(page){await page.evaluate(()=>window.scribyra.lastCompile=null);await page.getByRole('button',{name:'Compile',exact:true}).click();await expect.poll(()=>page.evaluate(()=>window.scribyra.lastCompile),{timeout:180000}).toBeTruthy();return page.evaluate(()=>window.scribyra.lastCompile);}
async function diagnostics(page){if(await page.getByRole('button',{name:'More tools',exact:true}).isVisible())await page.getByRole('button',{name:'More tools',exact:true}).click();await page.getByRole('button',{name:'Diagnostics',exact:true}).click();return page.getByRole('dialog',{name:'Local diagnostics'});}
test('real compile diagnostics cross authenticated ingress and Alloy without source or tokens; offline collection preserves work',async({page,context,baseURL})=>{
 test.skip(!ingestionAvailable(),'Build the telemetry bins/examples and install the pinned Alloy tool.');
 const server=await telemetryServer(new URL(baseURL).origin);let captures;
 try{
  await page.goto('/');const chooser=page.waitForEvent('filechooser');await page.getByRole('button',{name:'Import ZIP',exact:true}).click();await(await chooser).setFiles({name:'PRIVATE_INGESTION_PROJECT.zip',mimeType:'application/zip',buffer:Buffer.from(zipSync({'PRIVATE_FILENAME.tex':strToU8('\\documentclass{article}\n\\begin{document}NeverExportPrivatePaperMarker\\end{document}')}))});await expect(page.locator('.cm-content')).toBeVisible();
  let dialog=await diagnostics(page);await expect(dialog.getByRole('button',{name:'Connect telemetry host',exact:true})).toBeDisabled();await dialog.getByLabel('Collect local diagnostics').check();
  await dialog.getByLabel('Telemetry endpoint',{exact:true}).fill(server.url);await dialog.getByLabel('Ingest token',{exact:true}).fill('invalid-token');await dialog.getByLabel('Activity source',{exact:true}).selectOption(process.env.SCRIBYRA_TELEMETRY_SOURCE||'local_test');await dialog.getByRole('button',{name:'Connect telemetry host',exact:true}).click();await expect(dialog.getByText('Enter the 64-character ingest token from your telemetry host.',{exact:true})).toBeVisible();await page.waitForTimeout(1100);await expect(dialog.getByText('Enter the 64-character ingest token from your telemetry host.',{exact:true})).toBeVisible();
  await dialog.getByLabel('Ingest token',{exact:true}).fill(server.token);await dialog.getByLabel('Remote sampling',{exact:true}).selectOption('1');await dialog.getByLabel('Activity source',{exact:true}).selectOption(process.env.SCRIBYRA_TELEMETRY_SOURCE||'local_test');await dialog.getByRole('button',{name:'Connect telemetry host',exact:true}).click();await expect(dialog.getByLabel('Ingest token',{exact:true})).toHaveValue('');await dialog.getByRole('button',{name:'Close',exact:true}).click();
  const result=await compile(page);expect(result.success,result.log).toBeTruthy();await expect(page.locator('#pdf-viewer canvas').first()).toBeVisible();
  await expect.poll(async()=>{captures=await server.captures();return spans(captures).some(span=>span.name==='compile'&&span.status?.code===1);},{timeout:15000}).toBeTruthy();
  const root=spans(captures).find(span=>span.name==='compile'&&span.status?.code===1);expect(spans(captures).some(span=>span.name==='tex_pass'&&span.traceId===root.traceId)).toBeTruthy();
  expect(captures.records.some(row=>row.signal==='logs')).toBeTruthy();expect(captures.records.some(row=>row.signal==='metrics')).toBeTruthy();
  const encoded=JSON.stringify(captures);expect(encoded).not.toMatch(/NeverExportPrivatePaperMarker|PRIVATE_INGESTION_PROJECT|PRIVATE_FILENAME/);expect(!encoded.includes(server.token)&&!encoded.includes(server.url)).toBeTruthy();
  const metrics=captures.records.filter(row=>row.signal==='metrics').flatMap(row=>row.data.resourceMetrics.flatMap(resource=>resource.scopeMetrics.flatMap(scope=>scope.metrics)));
  expect(metrics.some(metric=>metric.histogram?.aggregationTemporality===2&&metric.histogram.dataPoints.some(point=>Number(point.count)>0))).toBeTruthy();
  expect(await server.metrics()).toMatch(/scribyra_ingress_events_total [1-9]/);
  const persisted=await page.evaluate(()=>JSON.stringify({...localStorage}));expect(!persisted.includes(server.token)&&!persisted.includes(server.url)).toBeTruthy();
  await context.setOffline(true);await page.locator('.cm-content').click();await page.keyboard.press('Control+End');await page.keyboard.insertText('\n% Offline editing remains available');await expect(page.locator('.save-indicator')).toHaveText('Saved locally');const offline=await compile(page);expect(offline.success,offline.log).toBeTruthy();
  dialog=await diagnostics(page);await expect(dialog.getByText(/Destination unavailable/)).toBeVisible({timeout:15000});await dialog.getByLabel('Collect local diagnostics').uncheck();await expect(dialog.getByText(/Remote collection off/)).toBeVisible();await dialog.getByRole('button',{name:'Close',exact:true}).click();await context.setOffline(false);
 }finally{await context.setOffline(false);await server.close();}
});
