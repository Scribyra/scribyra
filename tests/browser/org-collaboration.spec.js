// Organisations in the real app, across separate browser profiles: an owner creates an end-to-end
// encrypted organisation, invites a colleague who joins with the link and opens a shared project
// as a reviewer, then links a second browser of their own; edits sync live between the two
// devices and offline edits on both reconcile.
import {test,expect} from '@playwright/test';
import {readFile} from 'node:fs/promises';
import {build} from 'esbuild';
import {service,orgCreate} from '../helpers/service.mjs';

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
async function saveKit(page){
 const dialog=dialogOf(page);
 await expect(dialog.getByLabel('Recovery kit',{exact:true}).and(page.locator('pre'))).toContainText('scribyra-recovery:1:');
 await dialog.getByRole('checkbox',{name:'I have saved my recovery kit somewhere safe'}).check();
 await dialog.getByRole('button',{name:'Done'}).click();
}
const project=row=>dialogOf(row.page()).getByRole('listitem').filter({hasText:row.name});
async function openProject(page,name){
 const open=dialogOf(page);if(await open.isVisible())await open.getByRole('button',{name:'Close remote backup'}).click();
 await page.locator('.project-card').filter({hasText:name}).locator('.card-open').click();
 await expect(page.locator('.cm-content')).toBeVisible();
}
const source=page=>page.locator('.cm-content');
async function type(page,text){await source(page).click();await page.keyboard.press('ControlOrMeta+Home');await page.keyboard.type(text);await expect(page.locator('.save-indicator')).toHaveText('Saved locally');}

test('an organisation invites a reviewer, links a second device, and syncs edits live and after offline work',async({browser},info)=>{
 const s=await service({org:true});const contexts=[];
 try{
  const ana=await profile(browser,info);contexts.push(ana.context);
  await ana.page.evaluate(async()=>{
   const {Y,model,storage}=await import('/org-harness.js'),doc=new Y.Doc(),id='org-shared';
   model.addFile(doc,'main.tex','\\documentclass{article}\n\\begin{document}\nORG_SHARED_START\n\\end{document}\n');model.migrateProject(doc,id);doc.getMap('meta').set('name','Shared paper');
   await storage.saveProject(id,doc);doc.destroy();await window.scribyra.action('home');
  });
  // Create the organisation: name, the owner's name, end-to-end encryption.
  await ana.page.getByRole('button',{name:'Remote backup',exact:true}).click();
  const dialog=dialogOf(ana.page);
  await dialog.getByRole('textbox',{name:'Setup code'}).fill(await orgCreate(s,'acme'));
  await dialog.getByRole('textbox',{name:'Organisation name'}).fill('Acme Lab');
  await dialog.getByRole('textbox',{name:'Your name',exact:true}).fill('Ana');
  await expect(dialog.getByRole('radio',{name:'End-to-end encrypted'})).toBeChecked();
  await dialog.getByRole('button',{name:'Connect'}).click();
  await saveKit(ana.page);
  await expect(dialog).toContainText('Acme Lab');
  await expect(dialog).toContainText('End-to-end encrypted');
  const shared=dialog.getByRole('listitem').filter({hasText:'Shared paper'});
  await shared.getByRole('button',{name:'Back up'}).click();
  await expect(shared).toContainText(/Backed up remotely|Synced/);
  // Names and content never reach the service in plaintext.
  expect(await s.sql("SELECT count(*) FROM org_events WHERE position('Acme' in raw) > 0 OR position('Ana' in raw) > 0")).toBe('0');

  // Invite Ben as a reviewer of the shared paper.
  await dialog.getByRole('combobox',{name:'Share a project with them'}).selectOption({label:'Shared paper'});
  await dialog.getByRole('combobox',{name:'Their role on it'}).selectOption('reviewer');
  await dialog.getByRole('button',{name:'Create invitation link'}).click();
  const invitation=await dialog.getByRole('textbox',{name:'Invitation link to send'}).inputValue();
  expect(invitation).toContain('/#join=');

  // Ben opens the link in his own browser and joins.
  const ben=await profile(browser,info);contexts.push(ben.context);
  await ben.page.goto(invitation);
  const benDialog=dialogOf(ben.page);
  await benDialog.getByRole('textbox',{name:'Your name for this organisation'}).fill('Ben');
  await benDialog.getByRole('button',{name:'Join'}).click();
  await saveKit(ben.page);
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
  await expect(dialog.getByRole('list',{name:'Members'})).toContainText('Ben');

  // Ana links a second browser of her own.
  await dialog.getByRole('button',{name:'Link a device'}).click();
  const deviceLink=await dialog.getByRole('textbox',{name:'Device link to open on the new browser'}).inputValue();
  const laptop=await profile(browser,info);contexts.push(laptop.context);
  await laptop.page.goto(deviceLink);
  const laptopDialog=dialogOf(laptop.page);
  await laptopDialog.getByRole('button',{name:'Link this browser'}).click();
  const code=(await laptopDialog.locator('.org-code').textContent()).trim();
  expect(code).toMatch(/^\d{4} \d{4}$/);
  await expect(dialog.locator('.org-code')).toHaveText(code,{timeout:30000});
  await dialog.getByRole('button',{name:'Add this device'}).click();
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
