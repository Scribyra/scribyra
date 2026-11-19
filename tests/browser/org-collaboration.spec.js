// Organisations in the real app, across separate browser profiles: the deployment's administrator
// signs in and creates the end-to-end encrypted organisation, a colleague signs in and asks to
// join, is approved and opens a project shared with him as a reviewer; the administrator's second
// browser signs in and is added by her first device after she types the code it shows; edits
// sync live between the two devices and offline edits on both reconcile.
import {test,expect} from '@playwright/test';
import {readFile} from 'node:fs/promises';
import {build} from 'esbuild';
import {orgService} from '../helpers/idp.mjs';
import {signIn,create,join,share} from '../helpers/org-browser.mjs';

let bundle;
async function harness(page){
 bundle??=(await build({stdin:{resolveDir:process.cwd(),contents:`import init from './web/pkg/scribyra_app.js';import {initializeCollaborationSchema} from './web/collaboration-schema.js';await init({module_or_path:'/org-harness.wasm'});initializeCollaborationSchema();export * as Y from 'yjs';export * as model from './web/model.js';export * as storage from './web/storage.js';`},bundle:true,write:false,format:'esm',platform:'browser',loader:{'.css':'empty'}})).outputFiles[0].text;
 await page.route('**/org-harness.js',r=>r.fulfill({contentType:'text/javascript',body:bundle}));
 await page.route('**/org-harness.wasm',async r=>r.fulfill({contentType:'application/wasm',body:await readFile('web/pkg/scribyra_app_bg.wasm')}));
}
async function profile(browser,info){
 // The harness is served by routes, which a service worker's fetches would bypass.
 const context=await browser.newContext({serviceWorkers:'block'});
 if(info.project.name==='chromium')await context.grantPermissions(['local-network-access']).catch(()=>{});
 const page=await context.newPage();await harness(page);await page.goto('/');
 return{context,page};
}
const dialogOf=page=>page.getByRole('dialog',{name:'Remote backup'});
const project=row=>dialogOf(row.page()).getByRole('listitem').filter({hasText:row.name});
async function openProject(page,name){
 const open=dialogOf(page);if(await open.isVisible())await open.getByRole('button',{name:'Close remote backup'}).click();
 await page.locator('.project-card').filter({hasText:name}).locator('.card-open').click();
 await expect(page.locator('.cm-content')).toBeVisible();
}
const source=page=>page.locator('.cm-content');
async function type(page,text){await source(page).click();await page.keyboard.press('ControlOrMeta+Home');await page.keyboard.type(text);await expect(page.locator('.save-indicator')).toHaveText('Saved locally');}

test('an organisation admits a reviewer, adds a second device, and syncs edits live and after offline work',async({browser},info)=>{
 const s=await orgService({shortcuts:false});const contexts=[];
 try{
  const ana=await profile(browser,info);contexts.push(ana.context);
  await ana.page.evaluate(async()=>{
   const {Y,model,storage}=await import('/org-harness.js'),doc=new Y.Doc(),id='org-shared';
   model.addFile(doc,'main.tex','\\documentclass{article}\n\\begin{document}\nORG_SHARED_START\n\\end{document}\n');model.migrateProject(doc,id);doc.getMap('meta').set('name','Shared paper');
   await storage.saveProject(id,doc);doc.destroy();await window.scribyra.action('home');
  });
  // Ana, the deployment's administrator, signs in and creates the organisation.
  const dialog=dialogOf(ana.page);
  await create(ana.page,s,'ana','Ana');
  await expect(dialog).toContainText('Acme Lab');
  await expect(dialog).toContainText('End-to-end encrypted');
  const shared=dialog.getByRole('listitem').filter({hasText:'Shared paper'});
  await shared.getByRole('button',{name:'Back up'}).click();
  await expect(shared).toContainText(/Backed up remotely|Synced/);
  // Names and content never reach the service in plaintext.
  expect(await s.sql("SELECT count(*) FROM org_events WHERE position('Acme' in raw) > 0 OR position('Ana' in raw) > 0")).toBe('0');

  // Ben signs in and asks to join; Ana approves him and shares the paper with him as a reviewer.
  const ben=await profile(browser,info);contexts.push(ben.context);
  await join(ben.page,s,'ben',ana.page);
  await share(ana.page,'Shared paper','ben@acme.test','reviewer');
  const benDialog=dialogOf(ben.page);
  const offered=benDialog.getByRole('listitem').filter({hasText:'Shared paper'});
  await expect(offered).toContainText('Shared with you · Reviewer');
  await offered.getByRole('button',{name:'Download'}).click();
  await expect(benDialog.getByRole('status')).toContainText('Downloaded Shared paper.');
  await openProject(ben.page,'Shared paper');
  await expect(source(ben.page)).toContainText('ORG_SHARED_START');
  // A reviewer cannot switch to Editing.
  await expect(ben.page.getByRole('combobox',{name:'Editor mode'})).toHaveValue('reviewing');
  // Playwright's toBeDisabled reports a natively disabled <option> as enabled, so read the property.
  await expect(ben.page.locator('select[aria-label="Editor mode"] option[value="editing"]')).toHaveJSProperty('disabled',true);
  await expect(dialog.getByRole('list',{name:'Members'})).toContainText('ben@acme.test');

  // Ana's second browser signs in as her and asks one of her devices to add it; she types the
  // code it shows on her first device.
  const laptop=await profile(browser,info);contexts.push(laptop.context);
  await signIn(laptop.page,s,'ana');
  const laptopDialog=dialogOf(laptop.page);
  await laptopDialog.getByRole('button',{name:'Ask one of my devices'}).click();
  const code=(await laptopDialog.locator('.org-code').textContent()).trim();
  expect(code).toMatch(/^[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}$/);
  if(!(await dialog.isVisible()))await ana.page.evaluate(()=>window.scribyra.action('remote-backup'));
  const request=dialog.locator('.org-request');
  await expect(request).toBeVisible({timeout:30000});
  // A redraw while the code is being typed (sync status, the long poll and `online` redraw the
  // dialog) keeps the field, its focus and its caret: it used to drop the keys typed next.
  const typing=request.getByRole('textbox',{name:'Code shown on the new browser'});
  const redrawn=async()=>{
   const drawn=await request.locator('p').first().elementHandle();
   await ana.page.evaluate(()=>window.dispatchEvent(new Event('online')));
   await expect.poll(()=>drawn.evaluate(p=>p.isConnected),{timeout:30000}).toBe(false);
  };
  await typing.click();await ana.page.keyboard.type(code.slice(0,7));
  await redrawn();
  await expect(typing).toBeFocused();
  await ana.page.keyboard.type(code.slice(7));
  await expect(typing).toHaveValue(code);
  // A wrong code is refused: the service alone cannot add a device. It is cleared, and no redraw
  // brings it back (it used to replace the right code typed next).
  await typing.fill('0000-0000-0000');
  await request.getByRole('button',{name:'Add this device'}).click();
  await expect(dialog.getByRole('status')).toContainText('does not match');
  await expect(typing).toHaveValue('');
  await redrawn();
  await expect(typing).toHaveValue('');
  await typing.fill(code);
  await request.getByRole('button',{name:'Add this device'}).click();
  const onLaptop=laptopDialog.getByRole('listitem').filter({hasText:'Shared paper'});
  await expect(onLaptop.getByRole('button',{name:'Download'})).toBeVisible({timeout:30000});
  await onLaptop.getByRole('button',{name:'Download'}).click();
  await expect(laptopDialog.getByRole('status')).toContainText('Downloaded Shared paper.');

  // Live: an edit on the laptop appears in Ana's open editor.
  await openProject(ana.page,'Shared paper');
  await openProject(laptop.page,'Shared paper');
  await expect(laptop.page.getByRole('combobox',{name:'Editor mode'})).toHaveValue('editing');
  await type(laptop.page,'% FROM_LAPTOP\n');
  await expect(source(ana.page)).toContainText('% FROM_LAPTOP',{timeout:60000});
  // Offline on both devices, then back: both edits reach both.
  await ana.context.setOffline(true);await laptop.context.setOffline(true);
  await type(ana.page,'% ANA_OFFLINE\n');
  await type(laptop.page,'% LAPTOP_OFFLINE\n');
  await laptop.context.setOffline(false);
  await ana.context.setOffline(false);
  for(const page of [ana.page,laptop.page]){
   await expect(source(page)).toContainText('% ANA_OFFLINE',{timeout:90000});
   await expect(source(page)).toContainText('% LAPTOP_OFFLINE',{timeout:90000});
  }
  // Ben (reviewer) receives the editors' changes too.
  await expect(source(ben.page)).toContainText('% LAPTOP_OFFLINE',{timeout:90000});
  // The service holds ciphertext only.
  expect(await s.sql("SELECT count(*) FROM entries WHERE position(convert_to('ORG_SHARED','UTF8') in inline) > 0 OR position(convert_to('OFFLINE','UTF8') in inline) > 0")).toBe('0');
 }finally{for(const c of contexts)await c.close().catch(()=>{});await s.close();}
});
