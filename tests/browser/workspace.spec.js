import {romanianPackage} from './package-fixtures.js';
import '../helpers/core.mjs';
import { test, expect } from '@playwright/test';
import fs from 'node:fs/promises';
test.beforeEach(async ({page}) => { page.on('pageerror', error => console.error('Browser error:', error.message)); });
async function loadFixture(page, name) {
  await page.goto('/'); await expect(page.getByRole('heading',{name:'Your next great idea starts here.'})).toBeVisible();
  const chooser = page.waitForEvent('filechooser'); await page.getByRole('button',{name:'Import ZIP',exact:true}).click();
  await (await chooser).setFiles(`public/fixtures/${name}.zip`); await expect(page.locator('.cm-content')).toBeVisible();
}
async function compile(page) {
  await page.evaluate(()=>{window.scribyra.lastCompile=null; window.__tick=performance.now(); window.__maxGap=0; window.__timer=setInterval(()=>{const now=performance.now(); window.__maxGap=Math.max(window.__maxGap,now-window.__tick); window.__tick=now;},16);});
  await page.getByRole('button',{name:'Compile',exact:true}).click();
  await expect.poll(()=>page.evaluate(()=>window.scribyra.lastCompile),{timeout:180000}).toBeTruthy();
  return page.evaluate(()=>{clearInterval(window.__timer); return {...window.scribyra.lastCompile, mainThreadMaxTimerGapMs:window.__maxGap, mainThreadHeapBytes:performance.memory?.usedJSHeapSize || null};});
}
test('workspace editing, stable rename, theme, reload and ZIP export', async ({page}) => {
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto('/'); await page.getByRole('button',{name:'Start with a sample paper'}).click();
  await expect(page.locator('.cm-content')).toBeVisible();
  await page.locator('.cm-content').click(); await page.keyboard.press('Control+Home'); await page.keyboard.type('% persistent-marker\n');
  await expect(page.locator('.save-indicator')).toHaveText('Saved locally');
  await page.getByRole('button',{name:'Toggle theme'}).click();
  await page.getByRole('button',{name:'File actions',exact:true}).click(); await page.getByRole('menuitem',{name:'Rename',exact:true}).click();
  await page.getByRole('textbox',{name:'Rename file',exact:true}).fill('paper.tex'); await page.keyboard.press('Enter');
  await expect(page.locator('.editor-tab')).toContainText('paper.tex'); await expect(page.locator('.cm-content')).toContainText('persistent-marker');
  const download = page.waitForEvent('download'); await page.getByRole('button',{name:'Export',exact:true}).click(); await (await download).saveAs('test-results/export.zip');
  await page.reload(); await page.getByRole('button',{name:/A space for your next great idea.*files?/}).click(); await expect(page.locator('.cm-content')).toContainText('persistent-marker');
  await page.screenshot({path:'test-results/editor.png',fullPage:true});
  await page.getByRole('button',{name:'All projects',exact:true}).click(); await expect(page.getByRole('heading',{name:'Your next great idea starts here.'})).toBeVisible(); await page.getByRole('button',{name:'Toggle theme'}).click(); await page.screenshot({path:'test-results/dashboard.png',fullPage:true});
  expect(errors).toEqual([]);
});
test('real compilation matrix and offline restart', async ({page,context,browserName}) => {
  const rows=[];
  for (const [fixture,engine] of [['article','lualatex'],['article','lualatex'],['unicode','lualatex'],['bibtex','lualatex'],['biber','lualatex'],['thesis','lualatex']]) {
    if (rows.length !== 1) await loadFixture(page,fixture);
    await page.getByLabel('Compiler',{exact:true}).selectOption(engine);
    const result=await compile(page); rows.push({fixture,engine,...result});
    await fs.mkdir('test-results',{recursive:true}); await fs.writeFile(`test-results/benchmarks-${browserName}.json`,JSON.stringify(rows,null,2));
    expect(result.success, result.log.slice(-5000)).toBeTruthy();
    await expect(page.locator('#pdf-viewer canvas').first()).toBeVisible();
    if (fixture === 'thesis') { const warm=await compile(page); expect(warm.success,warm.log).toBeTruthy(); rows.push({fixture:'thesis-warm',engine,...warm}); await page.screenshot({path:`test-results/thesis-${browserName}.png`}); }
    if (rows.length !== 1) { await page.getByRole('button',{name:'All projects',exact:true}).click(); await expect(page.getByRole('heading',{name:'Your next great idea starts here.'})).toBeVisible(); }
  }
  await context.setOffline(true); await page.reload();
  await page.getByRole('button',{name:/article.*files?/}).first().click(); const offline=await compile(page); expect(offline.success,offline.log).toBeTruthy();
  rows.push({fixture:'article-offline',...offline}); await fs.writeFile(`test-results/benchmarks-${browserName}.json`,JSON.stringify(rows,null,2));
  await context.setOffline(false);
});
test('missing packages fail clearly; runaway compilation can be cancelled and recovered', async ({page}) => {
  await loadFixture(page,'missing-package'); const failure=await compile(page); expect(failure.success).toBeFalsy(); await expect(page.locator('.diagnostics')).toBeVisible();
  await expect(page.locator('.editor-status')).toContainText('Missing TeX file: scribyra-does-not-exist.sty');
  await page.getByRole('button',{name:'All projects',exact:true}).click(); await loadFixture(page,'runaway');
  await page.getByRole('button',{name:'Compile',exact:true}).click(); await expect(page.getByRole('button',{name:'Cancel compilation',exact:true})).toBeVisible();
  await page.waitForTimeout(2000); await page.getByRole('button',{name:'Cancel compilation',exact:true}).click(); await expect(page.locator('.editor-status')).toContainText('Compilation cancelled');
  await page.getByRole('button',{name:'All projects',exact:true}).click(); await loadFixture(page,'article'); expect((await compile(page)).success).toBeTruthy();
});
test('Romanian custom class uses default Biber, preserves sources, and recompiles offline', async ({page,context}) => {
  await romanianPackage(page);
  await loadFixture(page,'romanian');
  const result = await compile(page);
  expect(result.success, result.log).toBeTruthy();
  expect(result.packages.some(p=>p.name==='babel-romanian'&&!p.cached&&p.saved)).toBeTruthy();
  expect(result.logs.some(entry => entry.cmd.startsWith('biber ') && entry.exit_code === 0)).toBeTruthy();
  const bibliography = result.logs.find(entry => entry.cmd.startsWith('biber '));
  expect(bibliography.aux).not.toMatch(/[\u007f-\u009f]/);
  expect(bibliography.aux).toContain("\\'{e}");
  const final = result.logs.filter(entry => entry.cmd.startsWith('luahblatex ')).at(-1);
  expect(final.log + final.stdout).not.toMatch(/Citation .+ undefined|Empty bibliography/);
  await expect(page.locator('#pdf-viewer canvas').first()).toBeVisible();
  const exported = page.waitForEvent('download');
  await page.getByRole('button',{name:'Export',exact:true}).click();
  const { importZip } = await import('../../web/model.js');
  const sourceFiles = importZip(new Uint8Array(await fs.readFile(await (await exported).path())));
  expect(sourceFiles.map(f => f.path).sort()).toEqual(['Thesis.cls','main.tex','references.bib']);
  expect(sourceFiles.find(f => f.path === 'Thesis.cls').content).not.toContain('backend=');
  await expect.poll(() => page.evaluate(() => Boolean(navigator.serviceWorker.controller))).toBeTruthy();
  await expect.poll(() => page.evaluate(async () => Boolean(await caches.match(document.querySelector('script[type=module]').src)))).toBeTruthy();
  await context.setOffline(true); await page.reload();
  await expect(page.getByRole('heading',{name:'Your next great idea starts here.'})).toBeVisible();
  await page.getByRole('button',{name:/romanian.*files?/}).click();
  const offline = await compile(page); expect(offline.success,offline.log).toBeTruthy();
  expect(offline.packages.some(p=>p.name==='babel-romanian'&&p.cached)).toBeTruthy();
  // A TeX failure must remain visible and must not run Biber on a partial .bcf.
  await page.locator('.cm-content').click(); await page.keyboard.press('Control+Home');
  await page.keyboard.insertText('\\ScribyraUndefinedCommand\n');
  const failure = await compile(page);
  expect(failure.success).toBeFalsy();
  expect(failure.diagnostic).toContain('Undefined control sequence');
  expect(failure.logs.some(entry => entry.cmd.startsWith('biber '))).toBeFalsy();
  await context.setOffline(false);
});
test('Unicode input, keyboard resizing, and storage failure never claim a save', async ({page}) => {
  await page.goto('/'); await page.getByRole('button',{name:'Start with a sample paper'}).click(); await expect(page.locator('.cm-content')).toBeVisible();
  await page.locator('.cm-content').click(); await page.keyboard.press('Control+Home'); await page.keyboard.insertText('% café 你好 ∑\n');
  await expect(page.locator('.cm-content')).toContainText('café 你好 ∑'); await expect(page.locator('.save-indicator')).toHaveText('Saved locally');
  await page.keyboard.press('Control+z'); await expect(page.locator('.cm-content')).not.toContainText('café 你好 ∑'); await page.keyboard.press('Control+y'); await expect(page.locator('.cm-content')).toContainText('café 你好 ∑');
  const divider=page.getByRole('separator');await divider.focus();await page.keyboard.press('ArrowRight');await expect(divider).toHaveAttribute('aria-valuenow','52');
  await page.evaluate(()=>{const original=IDBObjectStore.prototype.put;window.restoreStorage=()=>{IDBObjectStore.prototype.put=original;};IDBObjectStore.prototype.put=function(){throw new DOMException('Simulated full disk','QuotaExceededError');};});
  await page.locator('.cm-content').click();await page.keyboard.press('Control+Home');await page.keyboard.insertText('% not-yet-saved\n');
  await expect(page.locator('.save-indicator')).toHaveText('Not saved · export a backup');await expect(page.getByRole('status',{name:'Workspace notification',exact:true})).toContainText('Local save failed');
  await page.evaluate(()=>window.restoreStorage());await page.keyboard.insertText('% recovered\n');await expect(page.locator('.save-indicator')).toHaveText('Saved locally');
});
