import {test,expect} from '@playwright/test';
import {readFileSync,mkdirSync} from 'node:fs';
import {zipSync,strToU8} from 'fflate';
test.use({actionTimeout:15000});
// Forty \directlua busy steps with a \write16 each and a forward \pageref:
// several seconds per pass, so output and steps can be observed mid-compile.
const slow=readFileSync(new URL('../fixtures/compile-log/slow-passes.tex',import.meta.url),'utf8');
// Final logs recorded from main before live logging, identical in all three engines.
const golden={cold:readFileSync(new URL('../fixtures/compile-log/slow-passes.cold.log',import.meta.url),'utf8'),warm:readFileSync(new URL('../fixtures/compile-log/slow-passes.warm.log',import.meta.url),'utf8')};
const normalize=log=>log.split('\n').map(line=>line.replace(/^[0-9]{9,11} /,'T ').replace(/[0-9]{1,2} [A-Z]{3} [0-9]{4} [0-9]{2}:[0-9]{2}/,'DATE')).join('\n');
const shots=process.env.SCRIBYRA_SCREENSHOTS;
async function importSource(page,files,name='live-log'){
 await page.goto('/');const chooser=page.waitForEvent('filechooser');await page.getByRole('button',{name:'Import ZIP',exact:true}).click();
 await(await chooser).setFiles({name:`${name}.zip`,mimeType:'application/zip',buffer:Buffer.from(zipSync(Object.fromEntries(Object.entries(files).map(([path,text])=>[path,strToU8(text)]))))});
 await expect(page.locator('.cm-content')).toBeVisible();
}
const compileButton=page=>page.getByRole('button',{name:'Compile',exact:true});
const status=page=>page.getByRole('status',{name:'Compilation status',exact:true});
const live=page=>page.locator('#live-compile-log');
async function start(page){await page.evaluate(()=>{window.scribyra.lastCompile=null;});await compileButton(page).click();await expect(compileButton(page)).toHaveAttribute('data-state','running');}
async function finished(page){await expect(compileButton(page)).toHaveAttribute('data-state','idle',{timeout:180000});return page.evaluate(()=>window.scribyra.lastCompile);}
const unfinished=page=>page.evaluate(()=>window.scribyra.lastCompile===null);

test('an open log streams steps, output and warnings while passes run; the final log is unchanged',async({page},info)=>{
 await page.setViewportSize({width:1366,height:768});
 await importSource(page,{'main.tex':slow});
 await page.getByRole('button',{name:'Show compilation log',exact:true}).click();
 await start(page);
 await expect(live(page)).toContainText('▸ LuaLaTeX pass 1');await expect(live(page)).toContainText('Scribyra tick 3');
 await expect(status(page)).toContainText('Compiling on your device · LuaLaTeX pass 1');expect(await unfinished(page)).toBe(true);
 await expect(page.locator('#compilation-issues > .diagnostics-header > span')).toHaveText('Compilation log');
 // The step is the only announced text; the log itself is not a live region.
 expect(await live(page).evaluate(node=>node.closest('[aria-live]'))).toBeNull();
 expect(await status(page).textContent()).not.toContain('Scribyra tick');
 await expect(live(page).locator('.log-warning').filter({hasText:'Rerun to get cross-references right'})).toHaveCount(1);
 await expect(live(page)).toContainText('▸ LuaLaTeX pass 2 · rerun for cross-references');
 await expect(status(page)).toContainText('LuaLaTeX pass 2 · rerun for cross-references');expect(await unfinished(page)).toBe(true);
 if(shots){mkdirSync(shots,{recursive:true});await page.screenshot({path:`${shots}/live-log-light-${info.project.name}.png`});}
 const cold=await finished(page);expect(cold.success,cold.log).toBe(true);
 expect(normalize(cold.log)).toBe(golden.cold);
 await expect(live(page)).toHaveCount(0);
 // A successful compile still hides the raw log, as before.
 await expect(page.getByRole('region',{name:'Raw compilation log',exact:true})).toHaveCount(0);
 await page.getByRole('button',{name:'Show compilation log',exact:true}).click();
 await expect(page.getByRole('region',{name:'Raw compilation log',exact:true}).locator('pre')).toContainText('TEXMFLOG:');
 await page.getByRole('button',{name:'Toggle theme',exact:true}).click();await expect(page.locator(':root')).toHaveAttribute('data-theme','dark');
 await start(page);await expect(live(page)).toContainText('Scribyra tick 5');
 if(shots)await page.screenshot({path:`${shots}/live-log-dark-${info.project.name}.png`});
 const warm=await finished(page);expect(warm.success,warm.log).toBe(true);expect(normalize(warm.log)).toBe(golden.warm);
});

test('the log follows new output only while the person is at the bottom',async({page})=>{
 await page.setViewportSize({width:1366,height:768});
 await importSource(page,{'main.tex':slow});
 await page.getByRole('button',{name:'Show compilation log',exact:true}).click();
 await start(page);
 const scroller=page.locator('.diagnostic-content'),gap=()=>scroller.evaluate(node=>node.scrollHeight-node.scrollTop-node.clientHeight);
 await expect(live(page)).toContainText('Scribyra tick 2');
 await expect.poll(()=>scroller.evaluate(node=>node.scrollHeight>node.clientHeight)).toBe(true);
 await expect.poll(gap).toBeLessThanOrEqual(2);
 // Reading earlier output: new lines must not pull the view away.
 await scroller.evaluate(node=>{node.scrollTop=0;});
 const before=await live(page).evaluate(node=>node.textContent.length);
 await expect.poll(()=>live(page).evaluate(node=>node.textContent.length)).toBeGreaterThan(before+200);
 expect(await scroller.evaluate(node=>node.scrollTop)).toBe(0);
 // Back at the bottom it follows again.
 await scroller.evaluate(node=>{node.scrollTop=node.scrollHeight;});
 const again=await live(page).evaluate(node=>node.textContent.length);
 await expect.poll(()=>live(page).evaluate(node=>node.textContent.length)).toBeGreaterThan(again+200);
 await expect.poll(gap).toBeLessThanOrEqual(2);expect(await unfinished(page)).toBe(true);
 expect((await finished(page)).success).toBe(true);
});

test('with the log closed the status shows the step; Show log opens it mid-compile; cancel says so in the log',async({page},info)=>{
 await page.setViewportSize({width:1366,height:768});
 await importSource(page,{'main.tex':slow});
 await start(page);
 await expect(status(page)).toContainText('LuaLaTeX pass 1');await expect(page.getByRole('region',{name:'Raw compilation log',exact:true})).toHaveCount(0);
 const show=page.getByRole('button',{name:'Show log',exact:true});await expect(show).toHaveAttribute('aria-expanded','false');
 if(shots)await page.screenshot({path:`${shots}/status-step-light-${info.project.name}.png`});
 await show.click();await expect(page.getByRole('button',{name:'Hide log',exact:true})).toHaveAttribute('aria-expanded','true');
 // Output printed before the panel opened is shown at once, then it keeps filling.
 await expect(live(page)).toContainText('▸ LuaLaTeX pass 1');await expect(live(page)).toContainText('Scribyra tick 4');
 await page.getByRole('button',{name:'Cancel compilation',exact:true}).click();
 await expect(status(page)).toContainText('Compilation cancelled');
 const log=page.getByRole('region',{name:'Raw compilation log',exact:true}).locator('pre');
 await expect(log).toContainText('Scribyra tick 4');await expect(log).toContainText('Compilation cancelled. Your sources and the previous PDF are unchanged.');
 expect((await page.evaluate(()=>window.scribyra.lastCompile)).errorType).toBe('AbortError');
 // The next compile still works after cancelling.
 await start(page);expect((await finished(page)).success).toBe(true);
});

const missing=String.raw`\documentclass{article}
\usepackage[romanian]{babel}
\usepackage{algpseudocode}
\begin{document}
\begin{algorithmic}
\State Downloaded package and dependency.
\end{algorithmic}
\end{document}`;
test('a missing-package compile shows lookup and fetch steps live',async({page},info)=>{
 const romanian=readFileSync(new URL('../fixtures/tex-packages/babel-romanian.tar.xz',import.meta.url)),algorithms=readFileSync(new URL('../fixtures/tex-packages/algorithmicx.tar.xz',import.meta.url));
 // Only the mirror response is local; checksum, unpacking and caching stay real.
 await page.addInitScript(({romanian,algorithms})=>{
  const original=window.fetch.bind(window);window.__held=[];
  window.fetch=async(input,options)=>{
   const url=input instanceof Request?input.url:String(input);
   if(!url.startsWith('https://tlnet.yihui.org/archive/'))return original(input,options);
   const name=new URL(url).pathname.split('/').pop();
   if(!['babel-romanian.tar.xz','algorithmicx.tar.xz'].includes(name))throw new Error('Unexpected package request');
   await new Promise(resolve=>window.__held.push({name,resolve}));
   return new Response(new Uint8Array(name==='babel-romanian.tar.xz'?romanian:algorithms),{headers:{'Content-Type':'application/octet-stream'}});
  };
 },{romanian:[...romanian],algorithms:[...algorithms]});
 await page.setViewportSize({width:1366,height:768});
 await importSource(page,{'main.tex':missing},'missing-live');
 await page.getByRole('button',{name:'Show compilation log',exact:true}).click();
 await start(page);
 await expect.poll(()=>page.evaluate(()=>window.__held.length),{timeout:120000}).toBe(1);
 // TeX halts at the first missing file, so each package is its own lookup round.
 await expect(status(page)).toContainText('Fetching TeX package babel-romanian (1 of 1)');
 await expect(live(page)).toContainText(/▸ Looking up \d+ missing files? in the TeX package catalog/);
 await expect(live(page)).toContainText('▸ Fetching TeX package babel-romanian (1 of 1)');
 // The stopped pass is expected: its fatal and exit lines stay, styled neutrally, with a calm marker.
 await expect(live(page)).toContainText('▸ Missing packages are being fetched; LuaLaTeX will run again');
 await expect(live(page).locator('.log-recovered').filter({hasText:'Fatal error occurred, no output PDF file produced!'})).toHaveCount(1);
 await expect(live(page).locator('.log-recovered').filter({hasText:'Exit code 1'})).toHaveCount(1);
 await expect(live(page).locator('.log-error')).toHaveCount(0);
 await expect(page.locator('#compilation-issues > .diagnostics-header > span')).toHaveText('Compilation log');
 if(shots)await page.screenshot({path:`${shots}/fetch-step-light-${info.project.name}.png`});
 expect(await page.evaluate(()=>window.__held[0].name)).toBe('babel-romanian.tar.xz');
 await page.evaluate(()=>window.__held.shift().resolve());
 await expect(live(page)).toContainText(/Installed TeX package babel-romanian r\d+/);
 await expect(live(page)).toContainText('▸ LuaLaTeX pass 2 · with downloaded packages');
 await expect.poll(()=>page.evaluate(()=>window.__held.length),{timeout:120000}).toBe(1);
 await expect(status(page)).toContainText('Fetching TeX package algorithmicx (1 of 1)');
 await expect(live(page).locator('.log-error')).toHaveCount(0);
 await page.getByRole('button',{name:'Toggle theme',exact:true}).click();await expect(page.locator(':root')).toHaveAttribute('data-theme','dark');
 if(shots)await page.screenshot({path:`${shots}/fetch-step-dark-${info.project.name}.png`});
 await expect(live(page)).toContainText('▸ Fetching TeX package algorithmicx (1 of 1)');
 expect(await unfinished(page)).toBe(true);
 await page.evaluate(()=>window.__held.shift().resolve());
 await expect(live(page)).toContainText('▸ LuaLaTeX pass 3 · with downloaded packages');
 const result=await finished(page);expect(result.success,result.log).toBe(true);
 expect(result.log).toMatch(/^TeX packages installed for this compile:\n/);
 await expect(status(page)).toContainText('2 TeX packages installed');
});

test('Biber and its bibliography rerun appear as steps while the compile runs',async({page})=>{
 const source=slow.replace('\\newcount\\tick','\\usepackage[backend=biber]{biblatex}\n\\addbibresource{refs.bib}\n\\newcount\\tick').replace('Done.','Done \\cite{public}.\n\\printbibliography');
 await importSource(page,{'main.tex':source,'refs.bib':'@book{public,title={Public Book},author={Example, Ada},publisher={Public Press},year={2024}}'},'biber-live');
 await page.getByRole('button',{name:'Show compilation log',exact:true}).click();
 await start(page);
 await expect(live(page)).toContainText('▸ Biber bibliography',{timeout:180000});
 // biblatex is a same-origin component: the first pass stops, a lookup installs it, then Biber runs.
 await expect(live(page)).toContainText(/▸ LuaLaTeX pass \d+ · rerun for the bibliography/);
 await expect(status(page)).toContainText(/LuaLaTeX pass \d+ · rerun for the bibliography/);expect(await unfinished(page)).toBe(true);
 const result=await finished(page);expect(result.success,result.log).toBe(true);expect(result.log).toContain('$ biber');
});

test('live log text and step names stay out of local diagnostics',async({page})=>{
 await page.goto('/');await page.getByRole('button',{name:'Diagnostics',exact:true}).click();let dialog=page.getByRole('dialog',{name:'Local diagnostics'});
 await dialog.getByLabel('Collect local diagnostics').check();await dialog.getByRole('button',{name:'Close',exact:true}).click();
 await importSource(page,{'main.tex':slow});await page.getByRole('button',{name:'Show compilation log',exact:true}).click();
 await start(page);await expect(live(page)).toContainText('▸ LuaLaTeX pass 2 · rerun for cross-references');
 expect((await finished(page)).success).toBe(true);
 await page.getByRole('button',{name:'More tools',exact:true}).click();await page.getByRole('button',{name:'Diagnostics',exact:true}).click();dialog=page.getByRole('dialog',{name:'Local diagnostics'});
 const data=await dialog.getByLabel('Diagnostic export preview').textContent();
 expect(JSON.parse(data).events.some(event=>event.operation==='worker_pass')).toBe(true);
 expect(data).not.toMatch(/Scribyra tick|LuaLaTeX pass|rerun for|LaTeX Warning|Compiling on your device/);
});
