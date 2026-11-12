import { test,expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { zipSync,strToU8,unzipSync } from 'fflate';
async function rename(page,path,next,folder=false){await page.getByRole('treeitem',{name:path,exact:true}).locator('..').locator('.file-menu').click();await page.getByRole('menuitem',{name:'Move',exact:true}).click();await page.getByRole('textbox',{name:`Move ${folder?'folder':'file'}`,exact:true}).fill(next);await page.getByRole('button',{name:'Move',exact:true}).click();}
test('reviewed moves preserve literal references, figure cursor insertion, and a compilable nested main',async({page})=>{
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  const main=String.raw`\documentclass{article}
\usepackage{graphicx}
\includeonly{chapters/chapter}
\begin{document}
% 🌍 \input{chapters/chapter}
\include{chapters/chapter}
\end{document}`;
  const bytes=zipSync({'main.tex':strToU8(main),'chapters/chapter.tex':strToU8('Figure here: '),'images/plot.png':await readFile('fixtures/article/figure.png')});
  await page.goto('/');const chooser=page.waitForEvent('filechooser');await page.getByRole('button',{name:'Import ZIP',exact:true}).click();await(await chooser).setFiles({name:'references.zip',mimeType:'application/zip',buffer:Buffer.from(bytes)});await expect(page.locator('.cm-content')).toBeVisible();
  await rename(page,'chapters','sections',true);const review=page.getByRole('dialog',{name:'Review file references'});
  await expect(review.getByRole('checkbox')).toHaveCount(2);await expect(review).toContainText('sections/chapter');await review.getByRole('button',{name:'Cancel',exact:true}).click();
  await expect(page.getByRole('treeitem',{name:'chapters',exact:true})).toBeVisible();await expect(page.locator('.cm-content')).toContainText('chapters/chapter');
  await rename(page,'chapters','sections',true);await review.getByRole('button',{name:'Move and update',exact:true}).click();
  await page.getByRole('treeitem',{name:'sections/chapter.tex',exact:true}).click();await page.locator('.cm-content').click();await page.keyboard.press('Control+End');
  await page.getByRole('treeitem',{name:'images/plot.png',exact:true}).click();await page.getByRole('button',{name:'Insert figure',exact:true}).click();
  await expect(page.locator('.cm-content')).toContainText('Figure here: \\includegraphics[width=\\linewidth]{images/plot.png}');
  await rename(page,'images/plot.png','figures/final.png');await expect(review).toContainText('sections/chapter.tex');await review.getByRole('button',{name:'Move and update',exact:true}).click();
  await rename(page,'main.tex','paper/main.tex');await expect(review.getByRole('checkbox')).toHaveCount(3);await review.getByRole('button',{name:'Move and update',exact:true}).click();
  await page.getByRole('button',{name:'Compile',exact:true}).click();await expect.poll(()=>page.evaluate(()=>window.scribyra.lastCompile),{timeout:180000}).toBeTruthy();
  const result=await page.evaluate(()=>window.scribyra.lastCompile);expect(result.success,result.log).toBeTruthy();await expect(page.locator('#pdf-viewer canvas').first()).toBeVisible();
  // Parent-relative writes inside the project work; writes beyond its virtual
  // root and writes into bundled TeX sources must still fail.
  await page.getByRole('treeitem',{name:'paper/main.tex',exact:true}).click();
  for(const path of ['../../outside.txt','/texlive/texmf-dist/tex/latex/base/article.cls']) {
    await page.locator('.cm-content').click();await page.keyboard.press('Control+Home');
    await page.keyboard.insertText(`\\newwrite\\probe\n\\immediate\\openout\\probe=${path}\n\\immediate\\write\\probe{invalid}\n\\immediate\\closeout\\probe\n`);
    await page.evaluate(()=>{window.scribyra.lastCompile=null;});await page.getByRole('button',{name:'Compile',exact:true}).click();
    await expect.poll(()=>page.evaluate(()=>window.scribyra.lastCompile),{timeout:180000}).toBeTruthy();
    const denied=await page.evaluate(()=>window.scribyra.lastCompile);expect(denied.success).toBeFalsy();expect(denied.log).toContain("I can't write on file");await expect(page.locator('#pdf-viewer canvas').first()).toBeVisible();
    await page.locator('.cm-content').click();await page.keyboard.press('Control+z');await expect(page.locator('.cm-content')).not.toContainText('\\probe');
  }
  await page.evaluate(()=>{window.scribyra.lastCompile=null;});await page.getByRole('button',{name:'Compile',exact:true}).click();await expect.poll(()=>page.evaluate(()=>window.scribyra.lastCompile),{timeout:180000}).toBeTruthy();
  expect((await page.evaluate(()=>window.scribyra.lastCompile)).success).toBeTruthy();
  await expect(page.locator('.save-indicator')).toHaveText('Saved locally');await page.reload();await page.getByRole('button',{name:/references.*files/}).click();
  const download=page.waitForEvent('download');await page.getByRole('button',{name:'Export',exact:true}).click();const files=unzipSync(new Uint8Array(await readFile(await(await download).path())));
  expect(new TextDecoder().decode(files['paper/main.tex'])).toContain('\\include{../sections/chapter}');expect(new TextDecoder().decode(files['paper/main.tex'])).toContain('% 🌍 \\input{chapters/chapter}');
  expect(new TextDecoder().decode(files['sections/chapter.tex'])).toContain('\\includegraphics[width=\\linewidth]{../figures/final.png}');expect(errors).toEqual([]);
});
