import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { zipSync, strToU8 } from 'fflate';
test.use({actionTimeout:15000});
const romanian = readFileSync(new URL('../fixtures/tex-packages/babel-romanian.tar.xz', import.meta.url));
const algorithms = readFileSync(new URL('../fixtures/tex-packages/algorithmicx.tar.xz', import.meta.url));
const main=String.raw`\documentclass{article}
\usepackage[romanian]{babel}
\usepackage{algpseudocode}
\begin{document}
\begin{algorithmic}
\State Downloaded package and dependency.
\end{algorithmic}
\end{document}`;
async function importSource(page, name, source) {
  await page.goto('/');const chooser=page.waitForEvent('filechooser');await page.getByRole('button',{name:'Import ZIP',exact:true}).click();
  await(await chooser).setFiles({name:`${name}.zip`,mimeType:'application/zip',buffer:Buffer.from(zipSync({'nested/main.tex':strToU8(source)}))});
  await expect(page.locator('.cm-content')).toBeVisible();
}
async function compile(page) {
  await page.evaluate(()=>{window.scribyra.lastCompile=null;});await page.getByRole('button',{name:'Compile',exact:true}).click();
  await expect.poll(()=>page.evaluate(()=>window.scribyra.lastCompile),{timeout:180000}).toBeTruthy();return page.evaluate(()=>window.scribyra.lastCompile);
}
test('package corruption, cancellation, dependency install and offline cache recovery', async({page,context})=>{
  // WebKit can bypass Playwright routing for service-worker-controlled requests.
  // Inject faults at fetch itself; TeX, validation, storage and offline app loads stay real.
  await page.addInitScript(({romanian,algorithms})=>{
    const original=window.fetch.bind(window);window.__packageMode='corrupt';window.__packageRequests=0;
    window.fetch=async(input,options)=>{
      const url=input instanceof Request?input.url:String(input);
      if(!url.startsWith('https://tlnet.yihui.org/archive/'))return original(input,options);
      window.__packageRequests++;
      if(!navigator.onLine)throw new Error('Unexpected offline package fetch');
      const name=new URL(url).pathname.split('/').pop();
      if(!['babel-romanian.tar.xz','algorithmicx.tar.xz'].includes(name))throw new Error('Unexpected package request');
      if(window.__packageMode==='hold'){
        window.__packageHeld=true;
        await new Promise((resolve,reject)=>{window.__releasePackage=resolve;options.signal.addEventListener('abort',()=>reject(new DOMException('Cancelled','AbortError')),{once:true});});
      }
      const body=new Uint8Array(name==='babel-romanian.tar.xz'?romanian:algorithms);
      if(window.__packageMode==='corrupt')body[300]^=1;
      return new Response(body,{headers:{'Content-Type':'application/octet-stream'}});
    };
  },{romanian:[...romanian],algorithms:[...algorithms]});
  await importSource(page,'downloaded-packages',main);await expect(page.getByLabel('Compiler',{exact:true})).toHaveValue('lualatex');
  await expect(page.getByLabel('Compiler',{exact:true}).locator('option')).toHaveCount(1);
  const bad=await compile(page);expect(bad.success).toBeFalsy();expect(bad.log).toContain('checksum');await expect(page.locator('#pdf-viewer canvas')).toHaveCount(0);
  await page.evaluate(()=>{window.__packageMode='hold';});await page.getByRole('button',{name:'Compile',exact:true}).click();
  await expect.poll(()=>page.evaluate(()=>window.__packageHeld),{timeout:60000}).toBeTruthy();
  await page.getByRole('button',{name:'Cancel compilation',exact:true}).click();await expect(page.locator('.editor-status')).toContainText('Compilation cancelled');
  await page.evaluate(()=>{window.__packageMode='valid';window.__releasePackage();});
  const good=await compile(page);expect(good.success,good.log).toBeTruthy();expect(good.packages.map(p=>p.name).sort()).toEqual(['algorithmicx','babel-romanian']);
  expect(good.packages.every(p=>p.saved&&!p.cached)).toBeTruthy();await expect(page.locator('#pdf-viewer canvas').first()).toBeVisible();
  await expect(page.locator('.editor-status')).toContainText('2 TeX packages installed');
  await expect(page.locator('.save-indicator')).toHaveText('Saved locally');await expect.poll(()=>page.evaluate(()=>Boolean(navigator.serviceWorker.controller))).toBeTruthy();
  await context.setOffline(true);await page.reload();await page.getByRole('button',{name:/downloaded-packages.*files?/}).click();const offline=await compile(page);
  expect(offline.success,offline.log).toBeTruthy();expect(offline.packages.map(p=>p.name).sort()).toEqual(['algorithmicx','babel-romanian']);expect(offline.packages.every(p=>p.cached)).toBeTruthy();
  expect(await page.evaluate(()=>window.__packageRequests)).toBe(0);await expect(page.locator('.editor-status')).toContainText('2 TeX packages loaded from cache');await context.setOffline(false);
});
test('IEEEtran class downloads from the live mirror and stays installed when a later source error occurs',async({page,context})=>{
  const ieee=String.raw`\documentclass[conference]{IEEEtran}
\begin{document}
\ScribyraTestUndefinedCommand
\title{A package download regression}\author{A Test Author}\maketitle
A minimal IEEE conference paper.
\end{document}`;
  await importSource(page,'ieee-package',ieee);
  const failed=await compile(page);expect(failed.success).toBeFalsy();expect(failed.diagnostic).toContain('Undefined control sequence');expect(failed.packages.some(p=>p.name==='ieeetran'&&p.saved&&!p.cached)).toBeTruthy();
  await expect(page.locator('.editor-status')).toContainText('1 TeX package installed');
  expect(failed.log.indexOf('ieeetran r79618')).toBeLessThan(failed.log.indexOf('TEXMFLOG:'));
  await page.locator('.cm-content').click();await page.keyboard.press('Control+Home');await page.keyboard.press('ArrowDown');await page.keyboard.press('ArrowDown');await page.keyboard.press('Home');await page.keyboard.press('Shift+End');await page.keyboard.press('Backspace');
  await expect(page.locator('.cm-content')).not.toContainText('ScribyraTestUndefinedCommand');
  const result=await compile(page);expect(result.success,result.log).toBeTruthy();await expect(page.locator('#pdf-viewer canvas').first()).toBeVisible();
  await expect(page.locator('.save-indicator')).toHaveText('Saved locally');await expect.poll(()=>page.evaluate(()=>Boolean(navigator.serviceWorker.controller))).toBeTruthy();
  await context.setOffline(true);await page.reload();await page.getByRole('button',{name:/ieee-package.*files?/}).click();const offline=await compile(page);expect(offline.success,offline.log).toBeTruthy();expect(offline.packages.some(p=>p.name==='ieeetran'&&p.cached)).toBeTruthy();await context.setOffline(false);
});
