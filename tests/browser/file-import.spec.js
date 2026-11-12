import { test,expect } from '@playwright/test';
import { mkdtemp,mkdir,writeFile,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {zipSync,strToU8} from 'fflate';
async function start(page){await page.goto('/');await page.getByRole('button',{name:'Start with a sample paper'}).click();await expect(page.locator('.cm-content')).toBeVisible();}
async function menu(page,path,choice){await page.getByRole('treeitem',{name:path,exact:true}).locator('..').locator('.file-menu').click();await page.getByRole('menuitem',{name:choice,exact:true}).click();}
async function folder(page,path){await page.getByRole('button',{name:'Add folder',exact:true}).click();await page.getByRole('textbox',{name:'New folder'}).fill(path);await page.getByRole('button',{name:'Create folder',exact:true}).click();}
test('duplicate subtree keeps empty folders and independent text; drag moves retain identity',async({page})=>{
  await start(page);await folder(page,'chapters/empty');
  await menu(page,'main.tex','Move');await page.getByRole('textbox',{name:'Move file',exact:true}).fill('chapters/main.tex');await page.getByRole('button',{name:'Move',exact:true}).click();
  const original=await page.getByRole('treeitem',{name:'chapters/main.tex',exact:true}).getAttribute('data-node');
  await menu(page,'chapters','Duplicate');await page.getByRole('textbox',{name:'Duplicate folder',exact:true}).fill('copy');await page.getByRole('button',{name:'Duplicate',exact:true}).click();
  await expect(page.getByRole('treeitem',{name:'copy/empty',exact:true})).toBeVisible();await page.getByRole('treeitem',{name:'copy/main.tex',exact:true}).click();
  expect(await page.getByRole('treeitem',{name:'copy/main.tex',exact:true}).getAttribute('data-node')).not.toBe(original);
  await page.locator('.cm-content').click();await page.keyboard.press('Control+Home');await page.keyboard.insertText('% copy only\n');
  await page.getByRole('treeitem',{name:'chapters/main.tex',exact:true}).click();await expect(page.locator('.cm-content')).not.toContainText('copy only');
  await page.getByRole('treeitem',{name:'chapters/main.tex',exact:true}).dragTo(page.getByRole('button',{name:'Project root',exact:true}));
  await expect(page.getByRole('treeitem',{name:'main.tex',exact:true})).toHaveAttribute('data-node',original);
  await page.getByRole('treeitem',{name:'main.tex',exact:true}).dragTo(page.getByRole('treeitem',{name:'copy',exact:true}));
  await expect(page.getByRole('status',{name:'Workspace notification',exact:true})).toContainText('already exists');await expect(page.getByRole('treeitem',{name:'main.tex',exact:true})).toBeVisible();
  await expect(page.locator('.save-indicator')).toHaveText('Saved locally');await page.reload();await page.getByRole('button',{name:/A space for your next great idea.*files/}).click();
  await page.getByRole('treeitem',{name:'copy/main.tex',exact:true}).click();await expect(page.locator('.cm-content')).toContainText('copy only');
});
test('folder input fallback imports real nested Unicode files atomically',async({page})=>{
  const dir=await mkdtemp(join(tmpdir(),'scribyra-folder-')),root=join(dir,'paper');
  try{
    await mkdir(join(root,'été'),{recursive:true});await writeFile(join(root,'été','notes.tex'),'folder import Café');
    await mkdir(join(root,'.scribyra-sync'));await writeFile(join(root,'.scribyra-sync','session.json'),'PRIVATE_SYNC_STATE');
    await start(page);await page.evaluate(()=>{window.showDirectoryPicker=undefined;});
    const chooser=page.waitForEvent('filechooser');await page.getByRole('button',{name:'Import folder',exact:true}).click();await(await chooser).setFiles(root);
    await page.getByRole('treeitem',{name:'paper/été/notes.tex',exact:true}).click();await expect(page.locator('.cm-content')).toContainText('folder import Café');
    await expect(page.getByRole('status',{name:'Workspace notification',exact:true})).toContainText('empty folders');
    await expect(page.getByRole('treeitem',{name:/scribyra-sync/})).toHaveCount(0);
  }finally{await rm(dir,{recursive:true,force:true});}
});
test('directory handles preserve empty folders and dropped files use the selected target',async({page})=>{
  await start(page);
  await page.evaluate(()=>{window.showDirectoryPicker=async()=>({name:'imported',kind:'directory',async *values(){yield {name:'.scribyra-sync',kind:'directory',async *values(){throw new Error('Private sync state must not be enumerated');}};yield {name:'empty',kind:'directory',async *values(){}};yield {name:'notes.tex',kind:'file',async getFile(){return new File(['directory source'],'notes.tex');}};}});});
  await page.getByRole('button',{name:'Import folder',exact:true}).click();await expect(page.getByRole('treeitem',{name:'imported/empty',exact:true})).toBeVisible();
  const data=await page.evaluateHandle(()=>{const transfer=new DataTransfer();transfer.items.add(new File(['dropped source'],'dropped.tex',{type:'text/plain'}));return transfer;});
  await page.getByRole('treeitem',{name:'imported/empty',exact:true}).dispatchEvent('drop',{dataTransfer:data});await data.dispose();
  await expect(page.getByRole('treeitem',{name:'imported/empty/dropped.tex',exact:true})).toBeVisible();await expect(page.locator('.cm-content')).toContainText('dropped source');
  await expect(page.locator('.save-indicator')).toHaveText('Saved locally');
  await expect(page.getByRole('treeitem',{name:/scribyra-sync/})).toHaveCount(0);
});

test('source ZIPs containing native recovery state fail before creating a project',async({page})=>{
 await page.goto('/');const chooser=page.waitForEvent('filechooser');await page.getByRole('button',{name:'Import ZIP',exact:true}).click();
 await(await chooser).setFiles({name:'project-with-private-recovery.zip',mimeType:'application/zip',buffer:Buffer.from(zipSync({'main.tex':strToU8('public source'),'.scribyra-sync/session.json':strToU8('PRIVATE_RECOVERY_STATE')}))});
 await expect(page.getByRole('status',{name:'Workspace notification',exact:true})).toContainText('private Scribyra sync/recovery state');await expect(page.locator('.project-card')).toHaveCount(0);await expect(page.locator('.cm-content')).toHaveCount(0);
 await page.reload();await expect(page.getByRole('button',{name:'Start with a sample paper'})).toBeVisible();await expect(page.locator('.project-card')).toHaveCount(0);
});
