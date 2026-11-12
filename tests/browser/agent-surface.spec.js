import {test,expect} from '@playwright/test';
import {readFile} from 'node:fs/promises';
test.use({actionTimeout:15000});
async function fixture(page,name){
 await page.goto(process.env.SCRIBYRA_TEST_PAGES_URL?new URL('app/',process.env.SCRIBYRA_TEST_PAGES_URL).href:'/');const chooser=page.waitForEvent('filechooser');await page.getByRole('button',{name:'Import ZIP',exact:true}).click();
 await(await chooser).setFiles(`public/fixtures/${name}.zip`);await expect(page.getByRole('textbox',{name:'LaTeX source',exact:true})).toBeVisible();
}
async function compile(page,{double=false}={}){
 await page.evaluate(()=>{window.scribyra.lastCompile=null;});const button=page.getByRole('button',{name:'Compile',exact:true});
 if(double){const box=await button.boundingBox();await page.mouse.dblclick(box.x+box.width/2,box.y+box.height/2);}else await button.click();
 await expect(button).toHaveAttribute('data-state','running');await expect(button).toHaveAttribute('aria-busy','true');await expect(button).toBeDisabled();
 await expect(page.getByRole('button',{name:'Cancel compilation',exact:true})).toBeVisible();
 await expect(button).toHaveAttribute('data-state','idle',{timeout:180000});await expect(button).toHaveAttribute('aria-busy','false');
 return page.evaluate(()=>window.scribyra.lastCompile);
}
const status=page=>page.getByRole('status',{name:'Compilation status',exact:true});
async function hiddenLog(page){
 await expect(page.getByRole('region',{name:'Raw compilation log',exact:true})).toHaveCount(0);
 expect(await page.locator('body').ariaSnapshot({mode:'ai'})).not.toContain('TEXMFLOG:');
}
test('thesis lines include blanks in snapshot order; builds expose outcomes and source links without raw logs',async({page})=>{
 await fixture(page,'thesis');await expect(page).toHaveTitle('thesis — Scribyra');
 const result=await compile(page,{double:true});expect(result.success,result.log).toBe(true);
 await expect(status(page)).toContainText(/Compiled · .* · 100 pages · 0 warnings/);await hiddenLog(page);
 await page.getByRole('treeitem',{name:'chapters/page-050.tex',exact:true}).click();
 const source=page.getByRole('textbox',{name:'LaTeX source',exact:true}),lines=(await readFile('fixtures/thesis/chapters/page-050.tex','utf8')).split('\n');
 await expect(source.locator('[data-line="1"]')).toHaveText(lines[0]);
 // Playwright's default mode omits editable descendants; MCP uses AI mode.
 {
  const snapshot=await source.ariaSnapshot({mode:'ai'});let previous=-1;
  for(let i=0;i<lines.length;i++){
   const label=`Line ${i+1}${lines[i]?'':', blank'}`,at=snapshot.indexOf(`"${label}"`);
   expect(at,`${label} in the accessibility snapshot`).toBeGreaterThan(previous);previous=at;
   await expect(source.locator(`[data-line="${i+1}"]`)).toHaveText(lines[i]);
  }
 }
 await source.locator('[data-line="6"]').click();await page.keyboard.press('Home');await page.keyboard.insertText('\\undefinedcmd ');
 const failed=await compile(page);expect(failed.success).toBe(false);await expect(status(page)).toContainText(/Failed · 1 error.* · 0 pages · 0 warnings/);
 const link=page.getByRole('list',{name:'Compilation issues'}).getByRole('link',{name:'chapters/page-050.tex:6',exact:true});await expect(link).toBeVisible();
 await page.getByRole('treeitem',{name:'main.tex',exact:true}).click();await link.click();await expect(page.getByRole('tab',{name:'chapters/page-050.tex',exact:true})).toHaveAttribute('aria-selected','true');
 await expect(source).toBeFocused();expect(await page.evaluate(()=>getSelection().toString())).toContain('undefinedcmd');await hiddenLog(page);
 await page.getByRole('button',{name:'Show compilation log',exact:true}).click();await expect(page.getByRole('region',{name:'Raw compilation log'})).toBeVisible();expect(await page.getByRole('region',{name:'Raw compilation log'}).ariaSnapshot({mode:'ai'})).toContain('TEXMFLOG:');
 await source.focus();await page.keyboard.press('Control+z');expect((await compile(page)).success).toBe(true);await hiddenLog(page);
 await page.getByRole('button',{name:'All projects',exact:true}).click();await expect(page).toHaveTitle('Scribyra — Your ideas, beautifully written');
});
test('final-pass warnings stay hidden until requested and dismissal survives successful compiles',async({page})=>{
 await fixture(page,'article');const result=await compile(page);expect(result.success,result.log).toBe(true);expect(result.report.warningCount).toBe(0);
 await expect(status(page)).toContainText(/Compiled · .* · 1 page · 0 warnings/);await expect(page.locator('.diagnostics')).toHaveCount(0);
 const patch=await page.evaluate(()=>{const api=window.scribyra.agent;return api.patchSource({expectedRevision:api.status().revision,edits:[{path:'main.tex',find:'\\begin{document}',replace:'\\begin{document}\n\\PackageWarningNoLine{scribyra-test}{Persistent warning}'}]});});expect(patch.ok).toBe(true);
 const warned=await compile(page);expect(warned.report.warningCount).toBe(1);await expect(page.locator('.diagnostics')).toHaveCount(0);
 const toggle=status(page).getByRole('button');await toggle.click();await expect(toggle).toHaveAttribute('aria-expanded','true');
 await expect(page.getByRole('list',{name:'Compilation issues'}).getByRole('listitem')).toHaveCount(1);
 await expect(page.getByRole('list',{name:'Compilation issues'})).toContainText('Persistent warning');await expect(page.locator('.diagnostics')).not.toContainText('line unavailable');
 await expect(page.locator('.warning-advice')).toHaveCount(1);await hiddenLog(page);
 const panel=await page.locator('.diagnostics').boundingBox(),panes=await page.locator('.split-panes').boundingBox();expect(panel.height).toBeLessThanOrEqual(page.viewportSize().height/4);expect(panes.height).toBeGreaterThan(page.viewportSize().height/2);
 expect((await compile(page)).report.warningCount).toBe(1);await expect(page.locator('.diagnostics')).toBeVisible();
 await page.getByRole('button',{name:'Show compilation log',exact:true}).click();
 expect(await page.locator('.diagnostic-content').evaluate(node=>node.scrollHeight>node.clientHeight)).toBe(true);
 await page.getByRole('button',{name:'Close compilation issues',exact:true}).click();await expect(toggle).toBeFocused();await expect(page.locator('.diagnostics')).toHaveCount(0);
 expect((await compile(page)).report.warningCount).toBe(1);await expect(page.locator('.diagnostics')).toHaveCount(0);
 await toggle.click();await page.keyboard.press('Escape');await expect(page.locator('.diagnostics')).toHaveCount(0);
 await page.evaluate(()=>{const api=window.scribyra.agent;return api.patchSource({expectedRevision:api.status().revision,edits:[{path:'main.tex',find:'\\begin{document}',replace:'\\begin{document}\n\\undefinedcmd'}]});});
 expect((await compile(page)).success).toBe(false);await expect(page.locator('.diagnostics')).toBeVisible();
 await page.keyboard.press('Escape');await expect(page.locator('.diagnostics')).toHaveCount(0);
 expect((await compile(page)).success).toBe(false);await expect(page.locator('.diagnostics')).toBeVisible();
 await page.getByRole('button',{name:'More tools',exact:true}).click();await page.getByRole('button',{name:'Project settings',exact:true}).click();await page.getByLabel('Project name',{exact:true}).fill('Renamed article');await page.getByRole('button',{name:'Save settings',exact:true}).click();await expect(page).toHaveTitle('Renamed article — Scribyra');
});
test('brand-new project compiles with zero warnings and no panel at 1366 by 768',async({page},testInfo)=>{
 await page.setViewportSize({width:1366,height:768});await page.goto(process.env.SCRIBYRA_TEST_PAGES_URL?new URL('app/',process.env.SCRIBYRA_TEST_PAGES_URL).href:'/');
 await page.getByRole('button',{name:'New project',exact:true}).click();await page.getByRole('button',{name:'Create project',exact:true}).click();
 const result=await compile(page);expect(result.success,result.log).toBe(true);expect(result.report.warningCount).toBe(0);expect(result.report.issues).toEqual([]);
 await expect(status(page)).toContainText(/1 page · 0 warnings/);await expect(page.locator('.diagnostics')).toHaveCount(0);await hiddenLog(page);
 expect(result.log).toContain('Package epstopdf Warning: Shell escape feature is not enabled.');expect(result.log).toContain('Rerun to get outlines right');
 await page.screenshot({path:testInfo.outputPath('new-project-1366x768.png')});
});
test('missing dependency points to its importing source, with pages and warnings on failure',async({page})=>{
 await fixture(page,'missing-package');await page.getByRole('treeitem',{name:'main.tex',exact:true}).focus();await page.keyboard.press('F2');await page.getByRole('textbox',{name:'Rename file',exact:true}).fill('MAIN.TeX');await page.keyboard.press('Enter');await expect(page.getByRole('treeitem',{name:'MAIN.TeX',exact:true})).toBeVisible();
 const result=await compile(page);expect(result.success).toBe(false);
 await expect(status(page)).toContainText(/Failed · 1 error.* · 0 pages · 0 warnings/);
 await expect(page.getByRole('list',{name:'Compilation issues'})).toContainText('scribyra-does-not-exist.sty');await expect(page.getByRole('link',{name:'MAIN.TeX:1',exact:true})).toBeVisible();await hiddenLog(page);
});
test('agent reads unrendered thesis lines, rejects stale revisions, and isolates consecutive edits from human undo',async({page})=>{
 await fixture(page,'thesis');
 const status=await page.evaluate(()=>window.scribyra.agent.status()),fileId=status.value.mainFile;
 const source=page.getByRole('textbox',{name:'LaTeX source',exact:true});await expect(source.locator('[data-line="90"]')).toHaveCount(0);
 const read=await page.evaluate(fileId=>window.scribyra.agent.readSource({fileId,startLine:89,endLine:92}),fileId);
 const lines=(await readFile('fixtures/thesis/main.tex','utf8')).split('\n');expect(read.value.content).toBe(lines.slice(88,92).join('\n'));expect(read.value.contentType).toBe('project-data');
 await source.focus();await page.keyboard.press('Control+Home');await page.keyboard.insertText('% human edit\n');
 const result=await page.evaluate(({fileId,expectedRevision})=>window.scribyra.agent.patchSource({expectedRevision,edits:[{fileId,find:'\\begin{document}',replace:'% stale\n\\begin{document}'}]}),{fileId,expectedRevision:read.revision});expect(result.error.code).toBe('revision_conflict');
 for(const label of ['agent one','agent two']){
  const receipt=await page.evaluate(({fileId,label})=>{const api=window.scribyra.agent;return api.patchSource({expectedRevision:api.status().revision,edits:[{fileId,find:'\\begin{document}',replace:`% ${label}\n\\begin{document}`}]});},{fileId,label});expect(receipt.ok).toBe(true);
 }
 await source.focus();await page.keyboard.press('Control+z');
 let contents=await page.evaluate(fileId=>window.scribyra.agent.readSource({fileId,startLine:1,endLine:20}),fileId);expect(contents.value.content).toContain('% agent one');expect(contents.value.content).not.toContain('% agent two');expect(contents.value.content).toContain('% human edit');
 await page.keyboard.press('Control+z');contents=await page.evaluate(fileId=>window.scribyra.agent.readSource({fileId,startLine:1,endLine:20}),fileId);expect(contents.value.content).not.toContain('% agent one');expect(contents.value.content).toContain('% human edit');
 await page.keyboard.press('Control+z');contents=await page.evaluate(fileId=>window.scribyra.agent.readSource({fileId,startLine:1,endLine:20}),fileId);expect(contents.value.content).not.toContain('% human edit');
 const running=await page.evaluate(()=>{window.retainedAgent=window.scribyra.agent;return window.retainedAgent.compile();});expect(running.value.status).toBe('running');
 await page.getByRole('button',{name:'All projects',exact:true}).click();expect((await page.evaluate(jobId=>window.retainedAgent.poll({jobId}),running.value.jobId)).error.code).toBe('project_closed');
});

test('failed close preserves the agent and unsaved source, then successful close revokes retained references',async({page})=>{
 await fixture(page,'article');
 await page.evaluate(()=>{
  window.retainedAgent=window.scribyra.agent;
  window.restoreStorePut=IDBObjectStore.prototype.put;
  IDBObjectStore.prototype.put=function(...args){if(this.name==='heads')throw new DOMException('Test full disk','QuotaExceededError');return window.restoreStorePut.apply(this,args);};
  const agent=window.retainedAgent,read=agent.readSource({path:'main.tex',startLine:1,endLine:1});
  const patched=agent.patchSource({expectedRevision:read.revision,edits:[{path:'main.tex',start:0,end:0,before:'',after:'% unsaved close regression\n'}]});
  if(!patched.ok)throw new Error(JSON.stringify(patched));
 });
 await page.getByRole('button',{name:'All projects',exact:true}).click();
 await expect(page.getByRole('status',{name:'Workspace notification',exact:true})).toContainText('QuotaExceededError');
 const kept=await page.evaluate(()=>({same:window.scribyra.agent===window.retainedAgent,status:window.retainedAgent.status(),source:window.retainedAgent.readSource({path:'main.tex',startLine:1,endLine:1})}));
 expect(kept.same).toBe(true);expect(kept.status.ok).toBe(true);expect(kept.source.value.content).toBe('% unsaved close regression');
 await expect(page.getByRole('textbox',{name:'LaTeX source',exact:true})).toBeVisible();
 await page.evaluate(()=>{IDBObjectStore.prototype.put=window.restoreStorePut;});
 await page.getByRole('button',{name:'All projects',exact:true}).click();
 await expect(page).toHaveTitle('Scribyra — Your ideas, beautifully written');
 expect(await page.evaluate(()=>window.scribyra.agent)).toBeNull();
 expect(await page.evaluate(()=>window.retainedAgent.status().error.code)).toBe('project_closed');
});
