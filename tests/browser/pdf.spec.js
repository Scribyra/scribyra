import { test,expect } from '@playwright/test';
import { zipSync,strToU8 } from 'fflate';
test.use({actionTimeout:15000});
async function compile(page){await page.evaluate(()=>{window.scribyra.lastCompile=null;});await page.getByRole('button',{name:'Compile',exact:true}).click();await expect.poll(()=>page.evaluate(()=>window.scribyra.lastCompile),{timeout:180000}).toBeTruthy();const result=await page.evaluate(()=>window.scribyra.lastCompile);expect(result.success,result.log).toBeTruthy();}
async function open(page){
  const source=String.raw`\documentclass{article}
\usepackage[T1]{fontenc}
\usepackage{hyperref}
\begin{document}
`+Array.from({length:16},(_,i)=>`\\section*{Page ${i+1}}\n\\hypertarget{page${i+1}}{}\n${i===0?'Selectable text, café, office. \\hyperlink{page12}{Jump to page twelve}.':i===1?'needle':i===4?'Needle':i===13?'needlework':'Ordinary reading text.'}\n${i<15?'\\newpage':''}\n`).join('')+'\\end{document}';
  await page.goto('/');const chooser=page.waitForEvent('filechooser');await page.getByRole('button',{name:'Import ZIP',exact:true}).click();await(await chooser).setFiles({name:'pdf-reader.zip',mimeType:'application/zip',buffer:Buffer.from(zipSync({'main.tex':strToU8(source)}))});await expect(page.locator('.cm-content')).toBeVisible();await compile(page);
}
async function pageNumber(page,n){const input=page.getByRole('spinbutton',{name:'PDF page number'});await input.fill(String(n));await input.press('Enter');await expect(input).toHaveValue(String(n));await expect(page.locator(`.page[data-page-number="${n}"] .textLayer`)).toBeVisible();}
test('PDF text selection, links, page navigation, search, zoom and bounded canvases',async({page,browserName})=>{
  const errors=[];page.on('pageerror',e=>errors.push(e.message));await open(page);
  await expect(page.getByRole('group',{name:'PDF page navigation'})).toContainText('of 16');
  const first=page.locator('.page[data-page-number="1"]');await expect(first.locator('.textLayer')).toContainText('Selectable text');
  const box=await first.locator('.textLayer').evaluate(layer=>{const span=[...layer.querySelectorAll('span')].find(s=>s.textContent.startsWith('Selectable'));const range=document.createRange();range.setStart(span.firstChild,0);range.setEnd(span.firstChild,10);const r=range.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2};});
  await page.mouse.dblclick(box.x,box.y);await expect.poll(()=>page.evaluate(()=>window.getSelection()?.toString().trim())).toBe('Selectable');
  await page.locator('#pdf-viewer').focus();await page.keyboard.press('Escape');await expect.poll(()=>page.evaluate(()=>window.getSelection()?.toString())).toBe('');await first.locator('.annotationLayer a').click();await expect(page.getByRole('spinbutton',{name:'PDF page number'})).toHaveValue('12');
  await page.getByRole('button',{name:'Next PDF page',exact:true}).click();await expect(page.getByRole('spinbutton',{name:'PDF page number'})).toHaveValue('13');await page.getByRole('button',{name:'Previous PDF page',exact:true}).click();await expect(page.getByRole('spinbutton',{name:'PDF page number'})).toHaveValue('12');
  await page.getByRole('spinbutton',{name:'PDF page number'}).fill('99');await page.getByRole('spinbutton',{name:'PDF page number'}).press('Enter');await expect(page.getByRole('spinbutton',{name:'PDF page number'})).toHaveValue('16');
  await pageNumber(page,8);const oldZoom=await page.locator('#zoom-label').textContent();await page.getByRole('button',{name:'Zoom in',exact:true}).click();await expect(page.locator('#zoom-label')).not.toHaveText(oldZoom);await expect(page.getByRole('spinbutton',{name:'PDF page number'})).toHaveValue('8');
  await page.getByRole('button',{name:'Fit PDF page',exact:true}).click();await expect(page.getByRole('spinbutton',{name:'PDF page number'})).toHaveValue('8');await page.getByRole('button',{name:'Fit PDF width',exact:true}).click();
  const width=await page.locator('.page[data-page-number="8"]').evaluate(el=>el.getBoundingClientRect().width);await page.getByRole('separator').focus();await page.keyboard.press('ArrowRight');await expect.poll(()=>page.locator('.page[data-page-number="8"]').evaluate(el=>el.getBoundingClientRect().width)).toBeLessThan(width);
  await page.locator('#pdf-viewer').focus();await page.keyboard.press('Control+f');await expect(page.getByRole('textbox',{name:'Find in PDF',exact:true})).toBeFocused();await page.getByRole('textbox',{name:'Find in PDF',exact:true}).fill('needle');await expect(page.locator('.pdf-find-status')).toContainText('of 3 matches');
  await page.getByRole('search',{name:'Search PDF text'}).getByLabel('Whole words',{exact:true}).check();await expect(page.locator('.pdf-find-status')).toContainText('of 2 matches');await expect(page.locator('.textLayer .highlight.selected').first()).toBeVisible();
  const before=await page.getByRole('spinbutton',{name:'PDF page number'}).inputValue();await page.getByRole('button',{name:'Next PDF match',exact:true}).click();await expect(page.getByRole('spinbutton',{name:'PDF page number'})).not.toHaveValue(before);
  await page.getByRole('search',{name:'Search PDF text'}).getByLabel('Match case',{exact:true}).check();await expect(page.locator('.pdf-find-status')).toHaveText('1 of 1 matches');await expect(page.getByRole('spinbutton',{name:'PDF page number'})).toHaveValue('2');
  await page.getByRole('textbox',{name:'Find in PDF',exact:true}).fill('not-present-123');await expect(page.locator('.pdf-find-status')).toHaveText('No matches');await page.getByRole('textbox',{name:'Find in PDF',exact:true}).press('Escape');await expect(page.getByRole('textbox',{name:'Find in PDF',exact:true})).toHaveCount(0);
  const draft=page.getByRole('spinbutton',{name:'PDF page number'});await draft.fill('1');
  await page.evaluate(()=>window.scribyra.action('pdf-next'));await expect(draft).toHaveValue('1');await draft.press('Enter');await expect(draft).toHaveValue('1');
  for(const n of [1,3,5,7,9,11,13,15,16])await pageNumber(page,n);
  await expect.poll(()=>page.locator('#pdf-viewer canvas').count()).toBeLessThanOrEqual(12);
  await page.locator('#pdf-viewer').focus();await page.keyboard.press('Home');await expect(page.getByRole('spinbutton',{name:'PDF page number'})).toHaveValue('1');await page.keyboard.press('End');await expect(page.getByRole('spinbutton',{name:'PDF page number'})).toHaveValue('16');
  const zoom=page.getByRole('button',{name:'Zoom in',exact:true});for(let i=0;i<40&&await zoom.isEnabled();i++)await zoom.click();await expect(zoom).toBeDisabled();
  await expect.poll(()=>page.locator('#pdf-viewer canvas').evaluateAll(canvases=>canvases.every(c=>c.width*c.height<=4194304&&c.width<=4096&&c.height<=4096))).toBeTruthy();
  await page.getByRole('button',{name:'Fit PDF width',exact:true}).click();await page.screenshot({path:`test-results/pdf-reader-${browserName}.png`});expect(errors).toEqual([]);
});
test('PDF survives failed compile, replaces cleanly, and reader search works offline',async({page,context})=>{
  const errors=[];page.on('pageerror',e=>errors.push(e.message));await open(page);await pageNumber(page,5);
  await compile(page);await expect(page.getByRole('spinbutton',{name:'PDF page number'})).toHaveValue('5');
  await page.locator('.cm-content').click();await page.keyboard.press('Control+Home');await page.keyboard.insertText('\\UndefinedScribyraCommand\n');await page.evaluate(()=>{window.scribyra.lastCompile=null;});await page.getByRole('button',{name:'Compile',exact:true}).click();await expect.poll(()=>page.evaluate(()=>window.scribyra.lastCompile),{timeout:180000}).toBeTruthy();expect(await page.evaluate(()=>window.scribyra.lastCompile.success)).toBeFalsy();await expect(page.locator('.page[data-page-number="5"] .textLayer')).toBeVisible();await expect(page.locator('.stale-badge')).toBeVisible();
  await page.locator('.cm-content').click();await page.keyboard.press('Control+z');await expect(page.locator('.cm-content')).not.toContainText('UndefinedScribyraCommand');
  await expect(page.locator('.save-indicator')).toHaveText('Saved locally');await expect.poll(()=>page.evaluate(()=>Boolean(navigator.serviceWorker.controller))).toBeTruthy();await context.setOffline(true);await page.reload();await page.getByRole('button',{name:/pdf-reader.*file/}).click();await compile(page);
  await page.getByRole('button',{name:'Search PDF',exact:true}).click();await page.getByRole('textbox',{name:'Find in PDF',exact:true}).fill('café');await expect(page.locator('.pdf-find-status')).toHaveText('1 of 1 matches');await expect(page.locator('.textLayer .highlight.selected')).toBeVisible();await context.setOffline(false);expect(errors).toEqual([]);
});
