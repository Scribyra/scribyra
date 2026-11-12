import { test, expect } from '@playwright/test';
import * as Y from 'yjs';
import '../helpers/core.mjs';
import { addFile, projectNodes, relocateNode } from '../../web/model.js';

test('a merged folder cycle stays visible and editable, can be repaired, and compiles afterward',async({page})=>{
  const a=new Y.Doc(),b=new Y.Doc();
  const main=addFile(a,'a/main.tex','\\documentclass{article}\n\\begin{document}\nRecovered graph paper.\n\\end{document}');
  addFile(a,'b/notes.tex','All notes retained.');a.getMap('meta').set('mainFile',main);a.getMap('meta').set('name','Cycle recovery');
  const fa=projectNodes(a).find(n=>n.path==='a').id,fb=projectNodes(a).find(n=>n.path==='b').id;Y.applyUpdate(b,Y.encodeStateAsUpdate(a));
  relocateNode(a,fa,'b/a');relocateNode(b,fb,'a/b');Y.applyUpdate(a,Y.encodeStateAsUpdate(b));
  await page.goto('/');await expect(page.getByRole('heading',{name:'Your next great idea starts here.'})).toBeVisible();
  await page.evaluate(async update=>{
    const db=await new Promise(resolve=>{const r=indexedDB.open('scribyra-v1');r.onsuccess=()=>resolve(r.result);});
    await new Promise((resolve,reject)=>{const tx=db.transaction('projects','readwrite');tx.objectStore('projects').put({id:'cycle',name:'Cycle recovery',files:2,schemaVersion:4,updatedAt:Date.now(),update:new Uint8Array(update)});tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error);});db.close();
    await window.scribyra.action('open','cycle');
  },Array.from(Y.encodeStateAsUpdate(a)));
  await expect(page.getByRole('alert')).toContainText('Folder cycle');await expect(page.getByRole('treeitem')).toHaveCount(4);
  await expect(page.locator('.cm-content')).toContainText('Recovered graph paper');
  await page.locator('.cm-content').click();await page.keyboard.press('Control+Home');await page.keyboard.insertText('% editing survives conflict\n');
  await expect(page.locator('.save-indicator')).toHaveText('Saved locally');
  await page.locator(`[data-node="${fa}"]`).locator('..').getByRole('button',{name:'Folder actions'}).click();
  await page.getByRole('menuitem',{name:'Move',exact:true}).click();await page.getByRole('textbox',{name:'Move folder'}).fill('recovered');await page.getByRole('button',{name:'Move',exact:true}).click();
  await expect(page.getByRole('alert')).toHaveCount(0);await expect(page.locator('.editor-tab')).toContainText('recovered/main.tex');
  await expect(page.locator('.cm-content')).toContainText('editing survives conflict');
  await page.getByRole('button',{name:'Compile',exact:true}).click();await expect.poll(()=>page.evaluate(()=>window.scribyra.lastCompile?.success),{timeout:180000}).toBeTruthy();
  await expect(page.locator('#pdf-viewer canvas').first()).toBeVisible();
  await page.reload();await page.getByRole('button',{name:/Cycle recovery.*files/}).click();await expect(page.locator('.cm-content')).toContainText('editing survives conflict');
  a.destroy();b.destroy();
});
