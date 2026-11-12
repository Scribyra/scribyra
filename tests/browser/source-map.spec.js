import { test,expect } from '@playwright/test';
import { zipSync,strToU8 } from 'fflate';
test.use({actionTimeout:15000});
async function sourcePoint(layer){return layer.evaluate(layer=>{const span=[...layer.querySelectorAll('span')].find(el=>el.textContent.includes('SOURCEBRIDGE')),start=span.textContent.indexOf('SOURCEBRIDGE'),range=document.createRange();range.setStart(span.firstChild,start);range.setEnd(span.firstChild,start+12);const rect=range.getBoundingClientRect();return{x:rect.x+rect.width/2,y:rect.y+rect.height/2};});}
async function compile(page){await page.evaluate(()=>{window.scribyra.lastCompile=null;});await page.getByRole('button',{name:'Compile',exact:true}).click();await expect.poll(()=>page.evaluate(()=>window.scribyra.lastCompile),{timeout:180000}).toBeTruthy();const result=await page.evaluate(()=>window.scribyra.lastCompile);expect(result.success,result.log).toBeTruthy();await expect(page.getByRole('button',{name:'Show source in PDF',exact:true})).toBeEnabled();}
async function forward(page){await page.getByRole('treeitem',{name:'chapters/été.tex',exact:true}).click();await page.locator('.cm-content').click();await page.keyboard.press('Control+Home');await page.keyboard.press('ArrowDown');await page.keyboard.press('Alt+Enter');await expect(page.getByRole('spinbutton',{name:'PDF page number'})).toHaveValue('2');await expect(page.locator('.pdf-source-location')).toBeVisible();}
test('nested Unicode source/PDF navigation works in LuaLaTeX, rejects stale maps and survives offline restart',async({page,context})=>{
  const errors=[];page.on('pageerror',error=>errors.push(error.message));
  const main=String.raw`\documentclass{article}
\usepackage[T1]{fontenc}
\begin{document}
First page.\par
\newpage
\input{../chapters/été}
\end{document}`;
  const chapter=String.raw`\section{Nested source}
\noindent SOURCEBRIDGE is the selected paragraph.\par
\noindent Another source line.\par
`;
  await page.goto('/');const chooser=page.waitForEvent('filechooser');await page.getByRole('button',{name:'Import ZIP',exact:true}).click();await(await chooser).setFiles({name:'source-map.zip',mimeType:'application/zip',buffer:Buffer.from(zipSync({'paper/main.tex':strToU8(main),'chapters/été.tex':strToU8(chapter)}))});await expect(page.locator('.cm-content')).toBeVisible();
  for(const engine of ['lualatex']){
    await page.getByLabel('Compiler',{exact:true}).selectOption(engine);await compile(page);await forward(page);
    const layer=page.locator('.page[data-page-number="2"] .textLayer');await expect(layer).toContainText('SOURCEBRIDGE');
    await page.getByRole('treeitem',{name:'paper/main.tex',exact:true}).click();
    const box=await sourcePoint(layer);
    await page.keyboard.down('Control');await page.mouse.click(box.x,box.y);await page.keyboard.up('Control');
    await expect(page.getByRole('tab',{name:'chapters/été.tex',exact:true})).toHaveAttribute('aria-selected','true');await expect.poll(()=>page.evaluate(()=>window.getSelection()?.toString())).toContain('SOURCEBRIDGE');
    if(engine==='lualatex'){
      for(const method of ['button','keyboard']){
        await page.getByRole('treeitem',{name:'paper/main.tex',exact:true}).click();await page.locator('#pdf-viewer').focus();await layer.locator('span').filter({hasText:'SOURCEBRIDGE'}).first().scrollIntoViewIfNeeded();const selected=await sourcePoint(layer);await page.mouse.dblclick(selected.x,selected.y);await expect.poll(()=>page.evaluate(()=>window.getSelection()?.toString())).toContain('SOURCEBRIDGE');
        if(method==='button')await page.getByRole('button',{name:'Show PDF location in source',exact:true}).click();else await page.keyboard.press('Alt+Enter');
        await expect(page.getByRole('tab',{name:'chapters/été.tex',exact:true})).toHaveAttribute('aria-selected','true');await expect.poll(()=>page.evaluate(()=>window.getSelection()?.toString())).toContain('SOURCEBRIDGE');
      }
    }
    await page.locator('.cm-content').click();await page.keyboard.press('Control+Home');await page.keyboard.insertText('% changed since compilation\n');await expect(page.getByRole('button',{name:'Show source in PDF',exact:true})).toBeDisabled();await expect(page.getByRole('button',{name:'Show PDF location in source',exact:true})).toBeDisabled();await expect(page.locator('.pdf-source-location')).toHaveCount(0);
    await page.keyboard.press('Control+z');await expect(page.getByRole('button',{name:'Show source in PDF',exact:true})).toBeDisabled();
  }
  await expect(page.locator('.save-indicator')).toHaveText('Saved locally');await expect.poll(()=>page.evaluate(()=>Boolean(navigator.serviceWorker.controller))).toBeTruthy();await context.setOffline(true);await page.reload();await page.getByRole('button',{name:/source-map.*files/}).click();await compile(page);await forward(page);await context.setOffline(false);expect(errors).toEqual([]);
});
