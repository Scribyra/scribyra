import { test, expect } from '@playwright/test';
import fs from 'node:fs/promises';
import * as Y from 'yjs';
import { zipSync, strToU8, unzipSync } from 'fflate';
import '../helpers/core.mjs';
import { importZip } from '../../web/model.js';
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');
const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="40" height="30"><rect width="40" height="30" fill="teal"/></svg>');
async function upload(page, entries) {
  const chooser = page.waitForEvent('filechooser'); await page.getByRole('button',{name:'Upload files',exact:true}).click(); await (await chooser).setFiles(entries);
}
async function menu(page, path, choice) {
  const row = page.getByRole('treeitem',{name:path,exact:true}).locator('..');
  await row.locator('.file-menu').click(); await page.getByRole('menuitem',{name:choice,exact:true}).click();
}
async function rename(page, path, to, folder=false, move=false) {
  await menu(page,path,move?'Move':'Rename');
  const name = `${move?'Move':'Rename'} ${folder?'folder':'file'}`;
  await page.getByRole('textbox',{name,exact:true}).fill(to); if(move) await page.getByRole('button',{name:'Move',exact:true}).click(); else await page.keyboard.press('Enter');
}
async function createFolder(page,path) {
  await page.getByRole('button',{name:'Add folder',exact:true}).click(); await page.getByRole('textbox',{name:'New folder'}).fill(path); await page.getByRole('button',{name:'Create folder',exact:true}).click();
}
test('nested tree, keyboard navigation, stable moves, recoverable deletion and empty ZIP folders', async ({page}) => {
  const errors=[]; page.on('pageerror',e=>errors.push(e.message));
  await page.goto('/'); await page.getByRole('button',{name:'Start with a sample paper'}).click();
  await expect(page.locator('.cm-content')).toBeVisible();
  await page.locator('.cm-content').click(); await page.keyboard.press('Control+Home'); await page.keyboard.insertText('% keep-my-history\n');
  await createFolder(page,'chapters'); await createFolder(page,'empty');
  await rename(page,'main.tex','chapters/paper.tex',false,true);
  await expect(page.locator('.editor-tab')).toContainText('chapters/paper.tex');
  await expect(page.getByRole('treeitem',{name:'chapters/paper.tex',exact:true})).toHaveAttribute('aria-level','2');
  await page.locator('.cm-content').click(); await page.keyboard.press('Control+z'); await expect(page.locator('.cm-content')).not.toContainText('keep-my-history');
  await page.keyboard.press('Control+y'); await expect(page.locator('.cm-content')).toContainText('keep-my-history');
  const chapter = page.getByRole('treeitem',{name:'chapters',exact:true}); await chapter.focus();
  await page.keyboard.press('ArrowLeft'); await expect(chapter).toHaveAttribute('aria-expanded','false'); await expect(page.getByRole('treeitem',{name:'chapters/paper.tex',exact:true})).toHaveCount(0);
  await page.keyboard.press('ArrowRight'); await expect(chapter).toHaveAttribute('aria-expanded','true'); await page.keyboard.press('ArrowRight');
  await expect(page.getByRole('treeitem',{name:'chapters/paper.tex',exact:true})).toBeFocused();
  await rename(page,'chapters','sections',true); await expect(page.locator('.editor-tab')).toContainText('sections/paper.tex');
  await menu(page,'sections','Delete'); await page.getByRole('button',{name:'Delete folder',exact:true}).click();
  await expect(page.getByRole('treeitem',{name:'sections/paper.tex',exact:true})).toHaveCount(0);
  await page.getByRole('button',{name:'Restore last deletion',exact:true}).click();
  await expect(page.locator('.cm-content')).toContainText('keep-my-history');
  await expect(page.getByLabel('Main document',{exact:true})).toHaveValue(/.+/);
  await expect(page.locator('.save-indicator')).toHaveText('Saved locally');
  await page.reload(); await page.getByRole('button',{name:/A space for your next great idea.*file/}).click();
  await expect(page.getByRole('treeitem',{name:'empty',exact:true})).toBeVisible();
  await expect(page.locator('.cm-content')).toContainText('keep-my-history');
  const download = page.waitForEvent('download'); await page.getByRole('button',{name:'Export',exact:true}).click();
  const entries=importZip(new Uint8Array(await fs.readFile(await (await download).path())));
  expect(entries.find(e=>e.path==='empty').folder).toBeTruthy(); expect(entries.find(e=>e.path==='sections/paper.tex').content).toContain('keep-my-history');
  await page.screenshot({path:'test-results/folder-tree.png'}); expect(errors).toEqual([]);
});
test('images upload into selected folders, preview, replace atomically, and survive ZIP/reload', async ({page}) => {
  await page.goto('/'); await page.getByRole('button',{name:'Start with a sample paper'}).click();
  await createFolder(page,'figures');
  await upload(page,[{name:'plot.svg',mimeType:'image/svg+xml',buffer:svg},{name:'pixel.png',mimeType:'image/png',buffer:png}]);
  await expect(page.getByRole('img',{name:'figures/plot.svg',exact:true})).toBeVisible(); await expect(page.locator('.asset-message')).toContainText('40 × 30');
  const changed = Buffer.from(svg.toString().replace('width="40"','width="80"'));
  let chooser=page.waitForEvent('filechooser'); await page.getByRole('button',{name:'Replace file',exact:true}).click(); await (await chooser).setFiles({name:'replacement.svg',mimeType:'image/svg+xml',buffer:changed});
  await expect(page.locator('.asset-message')).toContainText('80 × 30');
  chooser=page.waitForEvent('filechooser'); await page.getByRole('button',{name:'Replace file',exact:true}).click(); await (await chooser).setFiles({name:'invalid.svg',mimeType:'image/svg+xml',buffer:Buffer.from('broken')});
  await expect(page.getByRole('status',{name:'Workspace notification',exact:true})).toContainText('Original file kept'); await expect(page.locator('.asset-message')).toContainText('80 × 30');
  await upload(page,[{name:'fresh.tex',mimeType:'text/plain',buffer:Buffer.from('not partially imported')},{name:'pixel.png',mimeType:'image/png',buffer:png}]);
  await expect(page.getByRole('status',{name:'Workspace notification',exact:true})).toContainText('already exists'); await expect(page.getByRole('treeitem',{name:'figures/fresh.tex',exact:true})).toHaveCount(0);
  await expect(page.locator('.save-indicator')).toHaveText('Saved locally');
  await page.reload(); await page.getByRole('button',{name:/A space for your next great idea.*files/}).click();
  await page.getByRole('treeitem',{name:'figures/plot.svg',exact:true}).click(); await expect(page.locator('.asset-message')).toContainText('80 × 30');
  const download=page.waitForEvent('download'); await page.getByRole('button',{name:'Export',exact:true}).click();
  const entries=unzipSync(new Uint8Array(await fs.readFile(await (await download).path())));
  expect(Buffer.from(entries['figures/plot.svg'])).toEqual(changed); expect(Buffer.from(entries['figures/pixel.png'])).toEqual(png);
  await page.screenshot({path:'test-results/image-preview.png'});
});
test('v1 storage upgrades atomically with untouched recovery snapshot', async ({page}) => {
  const doc = new Y.Doc(); doc.getMap('meta').set('name','Legacy paper'); doc.getMap('meta').set('mainFile','stable-main'); doc.getMap('meta').set('engine','pdflatex');
  doc.getMap('files').set('stable-main',{id:'stable-main',path:'chapters/été.tex',binary:false}); doc.getText('text:stable-main').insert(0,'legacy Café 你好');
  const original=Array.from(Y.encodeStateAsUpdate(doc));
  // Seed the old database before the application has an opportunity to open it.
  await page.route('**/*',route => route.request().resourceType()==='document' ? route.fulfill({contentType:'text/html',body:'<html></html>'}) : route.continue());
  await page.goto('/');
  await page.evaluate(async update=>{
    const db=await new Promise((resolve,reject)=>{const r=indexedDB.open('scribyra-v1',1);r.onupgradeneeded=()=>r.result.createObjectStore('projects',{keyPath:'id'});r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});
    await new Promise((resolve,reject)=>{const tx=db.transaction('projects','readwrite');tx.objectStore('projects').put({id:'legacy',name:'Legacy paper',files:1,updatedAt:Date.now(),update:new Uint8Array(update)});tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error);});db.close();
  },original);
  await page.unroute('**/*'); await page.goto('/');
  await expect(page.getByRole('button',{name:/Legacy paper.*file/})).toBeVisible();
  await page.evaluate(()=>{ const put=IDBObjectStore.prototype.put; window.restorePut=()=>{IDBObjectStore.prototype.put=put;}; IDBObjectStore.prototype.put=function(...args){if(this.name==='projects')throw new DOMException('Migration disk full','QuotaExceededError');return put.apply(this,args);}; });
  await page.getByRole('button',{name:/Legacy paper.*file/}).click(); await expect(page.getByRole('status',{name:'Workspace notification',exact:true})).toContainText('Migration disk full');
  const failed=await page.evaluate(async()=>{const db=await new Promise(resolve=>{const r=indexedDB.open('scribyra-v1');r.onsuccess=()=>resolve(r.result);});const read=store=>new Promise(resolve=>{const r=db.transaction(store).objectStore(store).get('legacy');r.onsuccess=()=>resolve(r.result);});const a=await read('projects'),b=await read('migrationBackups');db.close();window.restorePut();return {update:Array.from(a.update),backup:!!b};});
  expect(failed.update).toEqual(original); expect(failed.backup).toBeFalsy();
  await page.getByRole('button',{name:/Legacy paper.*file/}).click();
  await expect(page.locator('.cm-content')).toContainText('legacy Café 你好');
  await expect(page.getByLabel('Compiler',{exact:true})).toHaveValue('lualatex');
  await expect(page.getByRole('status',{name:'Workspace notification',exact:true})).toContainText('previously pdflatex');
  await expect(page.getByRole('treeitem',{name:'chapters',exact:true})).toBeVisible(); await expect(page.getByLabel('Main document',{exact:true})).toHaveValue('stable-main');
  const saved=await page.evaluate(async()=>{const db=await new Promise(resolve=>{const r=indexedDB.open('scribyra-v1');r.onsuccess=()=>resolve(r.result);});const read=store=>new Promise(resolve=>{const r=db.transaction(store).objectStore(store).get('legacy');r.onsuccess=()=>resolve(r.result);});const a=await read('projects'),b=await read('migrationBackups');db.close();return {version:a.schemaVersion,backup:Array.from(b.update)};});
  expect(saved.version).toBe(8); expect(saved.backup).toEqual(original);
  await page.getByRole('button',{name:'All projects',exact:true}).click(); await page.getByRole('button',{name:'Project actions',exact:true}).click();
  const download=page.waitForEvent('download'); await page.getByRole('menuitem',{name:'Export pre-upgrade backup',exact:true}).click();
  const entries=importZip(new Uint8Array(await fs.readFile(await (await download).path()))); expect(entries[0].content).toBe('legacy Café 你好');
});
