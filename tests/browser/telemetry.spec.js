import {test,expect} from '@playwright/test';
import {readFile} from 'node:fs/promises';
import {zipSync,strToU8} from 'fflate';

const open=async page=>{if(await page.getByRole('button',{name:'More tools',exact:true}).isVisible())await page.getByRole('button',{name:'More tools',exact:true}).click();await page.getByRole('button',{name:'Diagnostics',exact:true}).click();return page.getByRole('dialog',{name:'Local diagnostics'});};
const snapshot=async dialog=>JSON.parse(await dialog.getByLabel('Diagnostic export preview').textContent());
async function raise(page){await page.evaluate(()=>{setTimeout(()=>{throw new Error('PRIVATE_SOURCE Bearer SEEDED_SECRET https://private.invalid/paper.tex');},0);});await page.waitForTimeout(100);}

test('local controls, exception privacy and reviewed export work offline',async({page,context})=>{
 await page.goto('/');let dialog=await open(page);
 await expect(dialog.getByLabel('Collect local diagnostics')).not.toBeChecked();
 await expect(dialog.getByRole('button',{name:'Export preview'})).toBeDisabled();
 await raise(page);await dialog.getByRole('button',{name:'Refresh timeline'}).click();
 expect((await snapshot(dialog)).events).toEqual([]);
 await dialog.getByLabel('Collect local diagnostics').check();await dialog.getByLabel('Allow reviewed diagnostic export').check();
 await context.setOffline(true);await raise(page);
 await dialog.getByRole('button',{name:'Refresh timeline'}).click();
 const reviewed=await dialog.getByLabel('Diagnostic export preview').textContent();
 expect(JSON.parse(reviewed).events.some(e=>e.operation==='exception'&&e.outcome==='failure')).toBeTruthy();
 expect(reviewed).not.toMatch(/PRIVATE_SOURCE|SEEDED_SECRET|private.invalid|paper.tex/);
 await raise(page); // An export must match its displayed preview even if events arrive.
 const pending=page.waitForEvent('download');await dialog.getByRole('button',{name:'Export preview'}).click();
 expect(await readFile(await(await pending).path(),'utf8')).toBe(reviewed);
 await dialog.getByLabel('Collect local diagnostics').uncheck();expect((await snapshot(dialog)).events).toEqual([]);
 await dialog.getByRole('button',{name:'Close',exact:true}).click();
 await expect(page.getByRole('button',{name:'Diagnostics',exact:true})).toBeFocused();
 await context.setOffline(false);await page.reload();dialog=await open(page);
 await expect(dialog.getByLabel('Collect local diagnostics')).not.toBeChecked();
 await expect(dialog.getByLabel('Allow reviewed diagnostic export')).toBeChecked();
 expect((await snapshot(dialog)).events).toEqual([]);
});

async function importSource(page,source,extra={}){
 const chooser=page.waitForEvent('filechooser');await page.getByRole('button',{name:'Import ZIP',exact:true}).click();
 await(await chooser).setFiles({name:'private-synthetic.zip',mimeType:'application/zip',buffer:Buffer.from(zipSync({'private-synthetic.tex':strToU8(source),...extra}))});
 await expect(page.locator('.cm-content')).toBeVisible();
}
async function compile(page){await page.evaluate(()=>window.scribyra.lastCompile=null);await page.getByRole('button',{name:'Compile',exact:true}).click();await expect.poll(()=>page.evaluate(()=>window.scribyra.lastCompile),{timeout:180000}).toBeTruthy();return page.evaluate(()=>window.scribyra.lastCompile);}

test('successful worker and PDF preparation remain correlated through offline recompilation',async({page,context})=>{
 await page.goto('/');let dialog=await open(page);await dialog.getByLabel('Collect local diagnostics').check();await dialog.getByRole('button',{name:'Close',exact:true}).click();
 await importSource(page,'\\documentclass{article}\n\\begin{document}PrivateSyntheticSourceMarker\\end{document}');
 let result=await compile(page);expect(result.success,result.log).toBeTruthy();
 await expect(page.getByRole('button',{name:'Show source in PDF',exact:true})).toBeEnabled();
 dialog=await open(page);let events=(await snapshot(dialog)).events;
 const root=events.find(e=>e.operation==='compile'&&e.outcome==='success');
 expect(events.some(e=>e.runtime==='worker'&&e.operation==='worker_pass'&&e.outcome==='success'&&e.traceId===root.traceId)).toBeTruthy();
 expect(events.some(e=>e.runtime==='worker'&&e.operation==='tex_pass'&&e.outcome==='success'&&e.traceId===root.traceId)).toBeTruthy();
 expect(events.some(e=>e.runtime==='worker'&&e.operation==='source_map'&&e.outcome==='success')).toBeTruthy();
 const bridge=events.find(e=>e.operation==='telemetry_delivery'&&e.outcome==='success');expect(bridge).toBeTruthy();
 expect(events.some(e=>e.runtime==='worker'&&e.operation==='download'&&e.parentSpanId===bridge.spanId&&e.traceId===root.traceId)).toBeTruthy();
 expect(events.some(e=>e.operation==='pdf_prepare'&&e.outcome==='success'&&e.parentSpanId===root.spanId&&e.metrics.some(m=>m.name==='bytes'&&m.value>0))).toBeTruthy();
 expect(JSON.stringify(events)).not.toContain('PrivateSyntheticSourceMarker');
 await dialog.getByRole('button',{name:'Clear diagnostics'}).click();await dialog.getByRole('button',{name:'Close',exact:true}).click();
 await context.setOffline(true);result=await compile(page);expect(result.success,result.log).toBeTruthy();
 dialog=await open(page);events=(await snapshot(dialog)).events;
 expect(events.some(e=>e.runtime==='worker'&&e.operation==='worker_pass'&&e.outcome==='success')).toBeTruthy();
 expect(events.some(e=>e.operation==='compile'&&e.outcome==='success')).toBeTruthy();
 await context.setOffline(false);
});

test('real search and outline workers keep query, headings and paths out of diagnostics',async({page})=>{
 await page.goto('/');let dialog=await open(page);await dialog.getByLabel('Collect local diagnostics').check();await dialog.getByRole('button',{name:'Close',exact:true}).click();
 await importSource(page,'\\documentclass{article}\n\\begin{document}\n\\section{PrivateHeadingMarker}\nPrivateQueryMarker\n\\end{document}');
 await page.getByRole('button',{name:'Search project',exact:true}).click();await page.getByLabel('Search text',{exact:true}).fill('PrivateQueryMarker');await page.getByRole('button',{name:'Run search',exact:true}).click();await expect(page.locator('.tool-status')).toHaveText('1 matches');
 await page.getByRole('button',{name:'Document outline',exact:true}).click();await expect(page.locator('.tool-status')).toHaveText('1 headings');
 dialog=await open(page);const data=await snapshot(dialog);
 for(const operation of ['workspace_search','source_outline']){const worker=data.events.find(e=>e.runtime==='worker'&&e.operation===operation&&e.outcome==='success');expect(worker).toBeTruthy();expect(data.events.some(e=>e.runtime==='browser'&&e.spanId===worker.parentSpanId&&e.traceId===worker.traceId)).toBeTruthy();}
 expect(JSON.stringify(data)).not.toMatch(/PrivateQueryMarker|PrivateHeadingMarker|private-synthetic/);
});

for(const backend of ['bibtex','biber'])test(`real ${backend} invocation produces a safe bibliography span`,async({page})=>{
 await page.goto('/');let dialog=await open(page);await dialog.getByLabel('Collect local diagnostics').check();await dialog.getByRole('button',{name:'Close',exact:true}).click();
 const citation=backend==='biber'?'\\usepackage[backend=biber]{biblatex}\n\\addbibresource{refs.bib}':'';
 const bibliography=backend==='biber'?'\\printbibliography':'\\bibliographystyle{plain}\n\\bibliography{refs}';
 await importSource(page,`\\documentclass{article}\n${citation}\n\\begin{document}\nPrivateCitationMarker \\cite{public}.\n${bibliography}\n\\end{document}`,{'refs.bib':strToU8('@book{public,title={Public Book},author={Example, Ada},publisher={Public Press},year={2024}}')});
 if(backend==='biber'){
  await page.getByRole('button',{name:'More tools',exact:true}).click();await page.getByRole('button',{name:'TeX environment',exact:true}).click();const environment=page.getByRole('dialog',{name:'TeX environment',exact:true});
  await environment.getByLabel('Compiler runtime (MiB)',{exact:true}).fill('0');await environment.getByRole('button',{name:'Apply cache limits',exact:true}).click();await expect(environment.getByRole('status')).toContainText('Cache limits saved');await environment.getByRole('button',{name:'Close',exact:true}).click();
 }
 const result=await compile(page);expect(result.success,result.log).toBeTruthy();
 expect(result.logs.some(entry=>entry.cmd?.startsWith(backend))).toBeTruthy();
 dialog=await open(page);const data=await snapshot(dialog),root=data.events.find(e=>e.operation==='compile'&&e.outcome==='success');expect(root).toBeTruthy();
 expect(data.events.some(e=>e.runtime==='worker'&&e.operation==='bibliography_pass'&&e.outcome==='success'&&e.traceId===root.traceId)).toBeTruthy();
 if(backend==='biber'){
  const passes=data.events.filter(event=>event.runtime==='browser'&&event.operation==='worker_pass');
  expect(data.events.some(event=>['runtime_transfer','download'].includes(event.operation)&&event.outcome!=='started'&&event.traceId===root.traceId&&passes.some(parent=>parent.spanId===event.parentSpanId)&&event.metrics.some(metric=>metric.name==='bytes'&&metric.value>1024*1024))).toBeTruthy();
 }
 expect(JSON.stringify(data)).not.toMatch(/PrivateCitationMarker|private-synthetic|refs.bib|Public Book|Example/);
});

test('cancelling a running engine closes its span and a new worker records the next build',async({page})=>{
 await page.goto('/');let dialog=await open(page);await dialog.getByLabel('Collect local diagnostics').check();await dialog.getByRole('button',{name:'Close',exact:true}).click();
 await importSource(page,'\\documentclass{article}\n\\begin{document}\\loop\\iftrue\\repeat\\end{document}');
 await page.getByRole('button',{name:'Compile',exact:true}).click();await expect(page.locator('.editor-status')).toContainText('Compiling on your device');
 await page.getByRole('button',{name:'Cancel compilation',exact:true}).click();await expect(page.locator('.editor-status')).toContainText('Compilation cancelled');
 dialog=await open(page);const before=(await snapshot(dialog)).events;
 const cancelled=before.find(e=>e.operation==='compile'&&e.outcome==='cancelled');expect(cancelled).toBeTruthy();
 expect(before.some(e=>e.operation==='worker_pass'&&e.runtime==='browser'&&e.outcome==='cancelled'&&e.traceId===cancelled.traceId)).toBeTruthy();
 await dialog.getByRole('button',{name:'Clear diagnostics'}).click();await dialog.getByRole('button',{name:'Close',exact:true}).click();
 const source=page.getByRole('textbox',{name:'LaTeX source',exact:true}),recovered='\\documentclass{article}\n\\begin{document}Recovered worker\\end{document}';
 await source.click();await expect(source).toBeFocused();await page.keyboard.press('Control+A');await source.pressSequentially(recovered);await expect(source.locator('.cm-line')).toHaveText(recovered.split('\n'));
 const result=await compile(page);expect(result.success,result.log).toBeTruthy();
 dialog=await open(page);const after=(await snapshot(dialog)).events;
 expect(after.some(e=>e.traceId===cancelled.traceId)).toBeFalsy();
 expect(after.some(e=>e.runtime==='worker'&&e.operation==='worker_pass'&&e.outcome==='success')).toBeTruthy();
});

test('a real failing compile produces safe correlated local evidence and preserves editing',async({page})=>{
 await page.goto('/');const dialog=await open(page);await dialog.getByLabel('Collect local diagnostics').check();
 await dialog.getByRole('button',{name:'Close',exact:true}).click();
 const pending=page.waitForEvent('filechooser');await page.getByRole('button',{name:'Import ZIP',exact:true}).click();
 await(await pending).setFiles({name:'PRIVATE_PROJECT.zip',mimeType:'application/zip',buffer:Buffer.from(zipSync({'PRIVATE_FILE.tex':strToU8('\\documentclass{article}\n\\begin{document}\n\\UndefinedPrivateSourceCommand\n\\end{document}')}))});
 await expect(page.locator('.cm-content')).toBeVisible();await page.getByRole('button',{name:'Compile',exact:true}).click();
 await expect.poll(()=>page.evaluate(()=>window.scribyra.lastCompile),{timeout:180000}).toBeTruthy();
 expect(await page.evaluate(()=>window.scribyra.lastCompile.success)).toBeFalsy();
 const diagnostics=await open(page),events=(await snapshot(diagnostics)).events;
 const identity=(await snapshot(diagnostics)).identity;expect(identity.version).toBe('0.1.0');expect(identity.revision).toMatch(/^[a-f0-9]{40}$/);expect(identity.compilerAdapterSha256).toMatch(/^[a-f0-9]{64}$/);
 const start=events.find(e=>e.operation==='compile'&&e.outcome==='started');
 const end=events.find(e=>e.operation==='compile'&&e.outcome==='failure');
 expect(end.traceId).toBe(start.traceId);expect(end.spanId).toBe(start.spanId);
 expect(end.metrics.find(m=>m.name==='duration_ms').value).toBeGreaterThan(0);
 const worker=events.find(e=>e.runtime==='worker'&&e.operation==='worker_pass'&&e.outcome==='failure');
 expect(worker.traceId).toBe(start.traceId);expect(worker.parentSpanId).not.toBe(start.spanId);
 expect(events.some(e=>e.runtime==='browser'&&e.spanId===worker.parentSpanId&&e.traceId===start.traceId)).toBeTruthy();
 expect(worker.metrics.some(m=>m.name==='memory_bytes'&&m.value>0)).toBeTruthy();
 expect(events.some(e=>e.runtime==='worker'&&e.operation==='package_prepare')).toBeTruthy();
 expect(events.some(e=>e.operation==='storage_commit'&&e.outcome==='success')).toBeTruthy();
 expect(JSON.stringify(events)).not.toMatch(/PRIVATE_PROJECT|PRIVATE_FILE|UndefinedPrivateSourceCommand/);
 await diagnostics.getByLabel('Collect local diagnostics').uncheck();await diagnostics.getByRole('button',{name:'Close',exact:true}).click();
 await page.locator('.cm-content').click();await page.keyboard.press('Control+End');await page.keyboard.insertText('\n% Still editable');
 await expect(page.locator('.cm-content')).toContainText('Still editable');
 await expect(page.locator('.save-indicator')).toHaveText('Saved locally');
});


test('implicit engine transfers are measured when runtime cache budget is zero',async({page})=>{
 const requests=[];page.on('request',request=>requests.push(request.url()));
 await page.goto('/');let dialog=await open(page);await dialog.getByLabel('Collect local diagnostics').check();await dialog.getByRole('button',{name:'Close',exact:true}).click();
 await importSource(page,'\\documentclass{article}\n\\begin{document}PrivateImplicitTransferSource\\end{document}');
 await page.getByRole('button',{name:'More tools',exact:true}).click();await page.getByRole('button',{name:'TeX environment',exact:true}).click();const environment=page.getByRole('dialog',{name:'TeX environment',exact:true});
 await environment.getByLabel('Compiler runtime (MiB)',{exact:true}).fill('0');await environment.getByRole('button',{name:'Apply cache limits',exact:true}).click();await expect(environment.getByRole('status')).toContainText('Cache limits saved');await environment.getByRole('button',{name:'Close',exact:true}).click();
 dialog=await open(page);await dialog.getByRole('button',{name:'Clear diagnostics',exact:true}).click();await dialog.getByRole('button',{name:'Close',exact:true}).click();
 const result=await compile(page);expect(result.success,result.log).toBeTruthy();
 dialog=await open(page);const data=await snapshot(dialog),startup=data.events.find(event=>event.runtime==='browser'&&event.operation==='worker_startup'&&event.outcome==='success');expect(startup).toBeTruthy();
 const transfers=data.events.filter(event=>['runtime_transfer','download'].includes(event.operation)&&event.parentSpanId===startup.spanId&&event.outcome!=='started');
 expect(transfers.length).toBeGreaterThanOrEqual(2);expect(transfers.every(event=>event.traceId===startup.traceId)).toBeTruthy();
 expect(transfers.some(event=>event.metrics.some(metric=>metric.name==='bytes'&&metric.value>1024*1024))).toBeTruthy();
 expect(transfers.every(event=>event.metrics.some(metric=>metric.name==='duration_ms'&&metric.value>=0))).toBeTruthy();
 expect(data.events.some(event=>event.runtime==='browser'&&event.operation==='telemetry_delivery'&&event.outcome==='success')).toBeFalsy();
 expect(requests.some(url=>/\.wasm$/.test(url))).toBeTruthy();expect(requests.some(url=>/\.data$/.test(url))).toBeTruthy();
 expect(await page.evaluate(async()=>(await(await caches.open('scribyra-runtime-verified-v1')).keys()).length)).toBe(0);
 expect(JSON.stringify(data)).not.toMatch(/PrivateImplicitTransferSource|private-synthetic|https?:|\.wasm|\.data/);expect(data.rejected).toBe(0);
});
