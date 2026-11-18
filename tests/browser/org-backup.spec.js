// Remote backup in the real app: the deployment's administrator signs in and creates the
// organisation, keeps the recovery kit, backs up a project with a comment, then restores it into
// a fresh browser profile with the kit after signing in there (a kit alone opens nothing).
import {test,expect} from '@playwright/test';
import {readFile} from 'node:fs/promises';
import {build} from 'esbuild';
import {orgService} from '../helpers/idp.mjs';
import {signIn} from '../helpers/org-browser.mjs';
// The harness is served by routes, which a service worker's fetches would bypass.
test.use({serviceWorkers:'block'});

async function harness(page){
 const bundle=await build({stdin:{resolveDir:process.cwd(),contents:`import init from './web/pkg/scribyra_app.js';import {initializeCollaborationSchema} from './web/collaboration-schema.js';await init({module_or_path:'/org-harness.wasm'});initializeCollaborationSchema();export * as Y from 'yjs';export * as model from './web/model.js';export * as storage from './web/storage.js';export {registerComments} from './web/comments.js';export {collaborationCommands} from './web/collaboration-commands.js';`},bundle:true,write:false,format:'esm',platform:'browser',loader:{'.css':'empty'}});
 await page.route('**/org-harness.js',r=>r.fulfill({contentType:'text/javascript',body:bundle.outputFiles[0].text}));
 await page.route('**/org-harness.wasm',async r=>r.fulfill({contentType:'application/wasm',body:await readFile('web/pkg/scribyra_app_bg.wasm')}));
}
const snapshot=()=>(async()=>{
 const {storage,model}=await import('/org-harness.js'),[project]=await storage.listProjects(),doc=await storage.loadProject(project.id);
 const messages=[...doc.getMap('messages').values()].map(m=>m.body).sort();
 const result={name:doc.getMap('meta').get('name'),lineage:doc.getMap('meta').get('lineageId'),files:model.snapshot(doc).map(f=>[f.path,f.content]),threads:doc.getMap('threads').size,messages};
 doc.destroy();return result;
})();

test('a project backs up end-to-end encrypted and restores into a fresh browser from the recovery kit',async({browser,page},info)=>{
 const s=await orgService({shortcuts:false});
 try{
  if(info.project.name==='chromium')await page.context().grantPermissions(['local-network-access']).catch(()=>{});
  await harness(page);await page.goto('/');
  await page.evaluate(async()=>{
   const {Y,model,storage,registerComments,collaborationCommands}=await import('/org-harness.js'),doc=new Y.Doc(),id='org-original';
   model.addFile(doc,'main.tex','\\documentclass{article}\n\\begin{document}\nORG_BACKUP_SOURCE\n\\end{document}\n');model.migrateProject(doc,id);doc.getMap('meta').set('name','Backed-up paper');
   const commands=collaborationCommands({doc,projectId:id}),comments=registerComments({doc,commands,author:{id:crypto.randomUUID(),kind:'human',displayName:'Author'}});
   const main=model.projectFiles(doc)[0].id,receipt=commands.execute({version:2,requestId:crypto.randomUUID(),projectId:id,expectedRevision:commands.revision(),command:{op:'thread.create',fileId:main,start:0,end:14,body:'ORG_BACKUP_DISCUSSION'}});
   if(!receipt.ok)throw Error(receipt.error.message);await storage.saveProject(id,doc);comments.close();commands.close();doc.destroy();
   await window.scribyra.action('home');
  });
  // Off means off: nothing about remote backup exists until the person connects.
  expect(await page.evaluate(async()=>(await indexedDB.databases()).map(d=>d.name).filter(n=>n==='scribyra-org'||n==='scribyra-direct'))).toEqual([]);
  const dialog=page.getByRole('dialog',{name:'Remote backup'});
  await signIn(page,s,'ana');
  await dialog.getByRole('textbox',{name:'Your name'}).fill('Ana');
  await dialog.getByRole('button',{name:'Create organisation'}).click();
  const kitBlock=dialog.getByLabel('Recovery kit',{exact:true}).and(page.locator('pre'));
  await expect(kitBlock).toContainText('scribyra-recovery:1:');
  const kit=await kitBlock.textContent();
  // Dismissing the dialog does not lose an unconfirmed kit: it is offered again.
  await dialog.getByRole('button',{name:'Close remote backup'}).click();await expect(dialog).toBeHidden();
  await page.getByRole('button',{name:'Remote backup',exact:true}).click();
  await expect(kitBlock).toHaveText(kit);
  await expect(dialog.getByRole('button',{name:'Done'})).toBeDisabled();
  await dialog.getByRole('checkbox',{name:'I have saved my recovery kit somewhere safe'}).check();
  await dialog.getByRole('button',{name:'Done'}).click();
  await expect(dialog).toContainText('End-to-end encrypted');
  const row=dialog.getByRole('listitem').filter({hasText:'Backed-up paper'});
  await row.getByRole('button',{name:'Back up'}).click();
  await expect(row).toContainText(/Backed up remotely|Synced/);
  await expect(page.locator('.project-card').filter({hasText:'Backed-up paper'})).toContainText(/Backed up remotely|Synced/);
  // Edits made in the editor back up too, and the editor says so.
  await dialog.getByRole('button',{name:'Close remote backup'}).click();
  await page.locator('.project-card').filter({hasText:'Backed-up paper'}).locator('.card-open').click();
  await expect(page.getByRole('status',{name:'Remote backup'})).toHaveText(/Backed up remotely|Synced/);
  await page.locator('.cm-content').click();await page.keyboard.press('ControlOrMeta+Home');await page.keyboard.type('% ORG_LATER_EDIT\n');
  await expect(page.locator('.save-indicator')).toHaveText('Saved locally');
  await expect(page.getByRole('status',{name:'Remote backup'})).toHaveText(/Backed up remotely|Synced/,{timeout:20000});
  await expect.poll(async()=>Number(await s.sql("SELECT count(*) FROM entries")),{timeout:20000}).toBeGreaterThanOrEqual(2);
  const original=await page.evaluate(snapshot);
  expect(original.files[0][1]).toContain('% ORG_LATER_EDIT');expect(original.messages).toEqual(['ORG_BACKUP_DISCUSSION']);
  // The service holds ciphertext only.
  expect(await s.sql("SELECT count(*) FROM entries WHERE position(convert_to('ORG_BACKUP','UTF8') in inline) > 0")).toBe('0');

  // A fresh profile restores everything from the kit alone.
  const fresh=await browser.newContext({serviceWorkers:'block'});
  try{
   if(info.project.name==='chromium')await fresh.grantPermissions(['local-network-access']).catch(()=>{});
   const other=await fresh.newPage();await harness(other);await other.goto('/');
   const restoreDialog=other.getByRole('dialog',{name:'Remote backup'});
   // The kit needs its person's sign-in: Ana signs in on the fresh profile first.
   await signIn(other,s,'ana');
   await expect(restoreDialog.getByRole('button',{name:'Ask one of my devices'})).toBeVisible();
   await restoreDialog.getByRole('textbox',{name:'Recovery kit'}).fill(kit);
   await restoreDialog.getByRole('button',{name:'Restore projects'}).click();
   await expect(restoreDialog.getByRole('status')).toContainText('Restored 1 project: Backed-up paper.');
   await expect(other.locator('.project-card').filter({hasText:'Backed-up paper'})).toContainText(/Backed up remotely|Synced/);
   expect(await other.evaluate(snapshot)).toEqual(original);
   // A mistyped kit is caught by its check characters before anything is sent.
   const typo=kit.replace(/(scribyra-recovery:1:[^:]+:[^:]+:[^:]+:)(.)/,(m,a,c)=>a+(c==='A'?'B':'A'));
   await restoreDialog.getByRole('button',{name:'Forget service'}).click();
   await restoreDialog.getByRole('textbox',{name:'Recovery kit'}).fill(typo);
   await restoreDialog.getByRole('button',{name:'Restore projects'}).click();
   await expect(restoreDialog.getByRole('status')).toContainText(/mistyped|character|length/);
  }finally{await fresh.close();}
 }finally{await s.close();}
});
