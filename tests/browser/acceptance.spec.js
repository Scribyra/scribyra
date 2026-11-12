import {test,expect} from '@playwright/test';
import {readFile} from 'node:fs/promises';
import {zipSync,strToU8,unzipSync,strFromU8} from 'fflate';
test.use({actionTimeout:15000});
async function sample(page){await page.goto('/');await page.getByRole('button',{name:'Start with a sample paper'}).click();await expect(page.getByRole('textbox',{name:'LaTeX source',exact:true})).toBeVisible();}
async function sourceZip(page){const download=page.waitForEvent('download');await page.getByRole('button',{name:'Export',exact:true}).click();return unzipSync(new Uint8Array(await readFile(await(await download).path())));}
async function compile(page){await page.evaluate(()=>{window.scribyra.lastCompile=null;});await page.getByRole('button',{name:'Compile',exact:true}).click();await expect.poll(()=>page.evaluate(()=>window.scribyra.lastCompile),{timeout:180000}).toBeTruthy();return page.evaluate(()=>window.scribyra.lastCompile);}
test('native Chromium composition commits Unicode once, survives undo and reload',async({page,context,browserName})=>{
 test.skip(browserName!=='chromium','This case uses CDP; Gecko and WPE native input are covered by their dedicated tests.');
 await sample(page);const source=page.getByRole('textbox',{name:'LaTeX source',exact:true});await source.focus();await page.keyboard.press('Control+Home');
 await page.evaluate(()=>{window.__composition=[];for(const type of ['compositionstart','compositionupdate','compositionend']){const record=e=>window.__composition.push({type:e.type,trusted:e.isTrusted,target:e.target.className||e.target.constructor.name});document.addEventListener(type,record);document.querySelector('.cm-content').editContext?.addEventListener(type,record);}});
 const cdp=await context.newCDPSession(page);await cdp.send('Input.imeSetComposition',{text:'にほ',selectionStart:2,selectionEnd:2});
 await expect(source).toContainText('にほ');
 await expect(page.getByRole('button',{name:'Compile',exact:true})).toBeVisible();expect(await page.evaluate(()=>window.scribyra.lastCompile)).toBeNull();
 const marker='日本語🌍e\u0301';await cdp.send('Input.insertText',{text:marker});await cdp.send('Input.imeSetComposition',{text:'',selectionStart:0,selectionEnd:0});await expect(source).toContainText(marker);await page.getByRole('button',{name:'Export',exact:true}).focus();await source.focus();
 const events=await page.evaluate(()=>window.__composition);expect(events.some(e=>e.type==='compositionstart'&&e.trusted)).toBeTruthy();expect(events.some(e=>e.type==='compositionend')).toBeTruthy();
 await page.keyboard.press('Control+Shift+f');await expect(page.getByLabel('Search text',{exact:true})).toBeFocused();await expect(page.locator('.save-indicator')).toHaveText('Saved locally');expect(strFromU8((await sourceZip(page))['main.tex']).startsWith(marker+'\\documentclass')).toBeTruthy();await source.focus();await page.keyboard.press('Control+z');await expect(source).not.toContainText(marker);await page.keyboard.press('Control+y');await expect(source).toContainText(marker);
 await expect(page.locator('.save-indicator')).toHaveText('Saved locally');const files=await sourceZip(page);const text=strFromU8(files['main.tex']);expect(text.startsWith(marker+'\\documentclass')).toBeTruthy();expect(text.split(marker)).toHaveLength(2);expect(text).not.toContain('にほ');
 await page.reload();await page.getByRole('button',{name:/A space for your next great idea.*files?/}).click();await expect(source).toContainText(marker);
});
test('composition keys do not submit dialogs or run workspace shortcuts; tree rename restores keyboard focus',async({page})=>{
 await sample(page);const node=page.getByRole('treeitem',{name:'main.tex',exact:true});await node.focus();await page.keyboard.press('F2');
 const input=page.getByRole('textbox',{name:'Rename file',exact:true});await expect(input).toBeFocused();await input.fill('paper.tex');
 await input.dispatchEvent('compositionstart',{data:'論'});await input.evaluate(el=>el.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',code:'Enter',bubbles:true,isComposing:true,keyCode:229,cancelable:true})));
 await expect(input).toBeVisible();await input.dispatchEvent('compositionend',{data:'論'});await page.keyboard.press('Enter');
 const renamed=page.getByRole('treeitem',{name:'paper.tex',exact:true});await expect(renamed).toBeFocused();await expect(renamed).toHaveAttribute('aria-selected','true');
 await page.keyboard.press('F2');await expect(input).toBeVisible();await page.keyboard.press('Escape');await expect(renamed).toBeFocused();
 await page.keyboard.press('Enter');const source=page.getByRole('textbox',{name:'LaTeX source',exact:true});await source.focus();
 for(const keys of [{key:'Enter',ctrlKey:true},{key:'f',ctrlKey:true,shiftKey:true},{key:'w',altKey:true}])await source.evaluate((el,keys)=>el.dispatchEvent(new KeyboardEvent('keydown',{...keys,isComposing:true,bubbles:true,cancelable:true})),keys);
 await expect(source).toBeVisible();await expect(page.getByRole('button',{name:'Compile',exact:true})).toBeVisible();await expect(page.getByLabel('Search text',{exact:true})).toHaveCount(0);
 // Flagged synthetic events do not establish an engine IME session; a browser
 // may still open CodeMirror's own find panel. Restore editor focus before the
 // independent, real-keyboard shortcut checks.
 await source.focus();await page.keyboard.press('Escape');await source.focus();
 await page.keyboard.press('Control+Shift+f');await expect(page.getByLabel('Search text',{exact:true})).toBeFocused();await page.keyboard.press('Control+Shift+o');await expect(page.getByRole('button',{name:'Document outline',exact:true})).toHaveAttribute('aria-pressed','true');
 await page.getByRole('separator',{name:'Resize editor and preview'}).focus();const before=Number(await page.getByRole('separator').getAttribute('aria-valuenow'));await page.keyboard.press('ArrowRight');await expect(page.getByRole('separator')).toHaveAttribute('aria-valuenow',String(before+2));
 const original=(await sourceZip(page))['paper.tex'];await source.focus();await page.keyboard.press('Control+Enter');await expect(page.getByRole('button',{name:'Cancel compilation',exact:true})).toBeVisible();await page.getByRole('button',{name:'Cancel compilation',exact:true}).click();await expect(page.locator('.editor-status')).toContainText('Compilation cancelled');expect((await sourceZip(page))['paper.tex']).toEqual(original);
});
test('combined Unicode project preserves images/citations, previous PDF and recoverable sources through offline errors',async({page,context})=>{
 const image=new Uint8Array(await readFile('fixtures/article/figure.png'));
 const main=String.raw`\documentclass{article}
\usepackage{graphicx}
\begin{document}
\input{../chapters/été}
\bibliographystyle{plain}\bibliography{../references}
\end{document}`;
 const chapter=String.raw`\section{Integrated workspace}
Café and Unicode paths. See~\cite{knuth1984}.
\includegraphics[width=.25\linewidth]{../images/plot.png}
`;
 const original={'paper/main.tex':strToU8(main),'chapters/été.tex':strToU8(chapter),'references.bib':new Uint8Array(await readFile('fixtures/bibtex/references.bib')),'images/plot.png':image,'empty/':new Uint8Array()};
 await page.goto('/');const chooser=page.waitForEvent('filechooser');await page.getByRole('button',{name:'Import ZIP',exact:true}).click();await(await chooser).setFiles({name:'acceptance.zip',mimeType:'application/zip',buffer:Buffer.from(zipSync(original))});await expect(page.locator('.cm-content')).toBeVisible();
 const good=await compile(page);expect(good.success,good.log).toBeTruthy();expect(good.logs.some(log=>log.cmd.startsWith('bibtex')&&log.exit_code===0)).toBeTruthy();await expect(page.locator('#pdf-viewer canvas').first()).toBeVisible();
 for(const bad of ['\\input{../missing-workspace-file}\n','\\UndefinedAcceptanceCommand\n']){
  await page.getByRole('treeitem',{name:'chapters/été.tex',exact:true}).click();await expect(page.getByRole('treeitem',{name:'chapters/été.tex',exact:true})).toBeFocused();await expect(page.locator('.cm-content')).toContainText('Integrated workspace');await page.locator('.cm-content').focus();await page.keyboard.press('Control+Home');await page.keyboard.insertText(bad);
  await expect(page.locator('.cm-content')).toContainText(bad.trim());const check=await sourceZip(page);expect(strFromU8(check['chapters/été.tex'])).toContain(bad.trim());
  const failed=await compile(page);expect(failed.success).toBeFalsy();await expect(page.locator('#pdf-viewer canvas').first()).toBeVisible();await expect(page.locator('.stale-badge')).toBeVisible();
  await page.locator('.cm-content').focus();await page.keyboard.press('Control+z');await expect(page.locator('.cm-content')).not.toContainText(bad.trim());
 }
 await expect(page.locator('.save-indicator')).toHaveText('Saved locally');const exported=await sourceZip(page);for(const [name,bytes]of Object.entries(original))expect(exported[name],name).toEqual(bytes);
 await expect.poll(()=>page.evaluate(()=>!!navigator.serviceWorker.controller)).toBeTruthy();await context.setOffline(true);await page.reload();await page.getByRole('button',{name:/acceptance.*files/}).click();const offline=await compile(page);expect(offline.success,offline.log).toBeTruthy();await context.setOffline(false);
});
