// The admin area of a server-readable deployment in the real app (design slice 10), across three
// browser profiles with the repository's OIDC test provider: Ben and Cat add projects and share;
// Ana, an administrator through the deployment's `admins`, sees every project in Admin, opens
// Ben's as administrator (read-only, and Ben's list then says an administrator opened it),
// transfers Cat's to Ben, removes Ben (his open project stops syncing and what he owned passes to
// Cat), deletes a project (gone for its members), exports everything (the zip holds the projects'
// files), and filters and exports the audit log. Cat, a member, has no Admin entry and the
// service refuses her the admin routes.
import {test,expect} from '@playwright/test';
import {readFile} from 'node:fs/promises';
import {unzipSync,strFromU8} from 'fflate';
import {build} from 'esbuild';
import {serverService} from '../helpers/idp.mjs';
import {providerLogin} from '../helpers/org-browser.mjs';

let bundle;
async function harness(page){
 bundle??=(await build({stdin:{resolveDir:process.cwd(),contents:`import init from './web/pkg/scribyra_app.js';import {initializeCollaborationSchema} from './web/collaboration-schema.js';await init({module_or_path:'/org-harness.wasm'});initializeCollaborationSchema();export * as Y from 'yjs';export * as model from './web/model.js';export * as storage from './web/storage.js';`},bundle:true,write:false,format:'esm',platform:'browser',loader:{'.css':'empty'}})).outputFiles[0].text;
 await page.route('**/org-harness.js',r=>r.fulfill({contentType:'text/javascript',body:bundle}));
 await page.route('**/org-harness.wasm',async r=>r.fulfill({contentType:'application/wasm',body:await readFile('web/pkg/scribyra_app_bg.wasm')}));
}
async function profile(browser,info){
 const context=await browser.newContext({serviceWorkers:'block',acceptDownloads:true});
 if(info.project.name==='chromium')await context.grantPermissions(['local-network-access']).catch(()=>{});
 const page=await context.newPage();await harness(page);await page.goto('/');
 return{context,page};
}
/** A personal project with a main file, made through the app's own model and storage. */
async function personal(page,name,marker){
 await page.evaluate(async({name,marker})=>{
  const {Y,model,storage}=await import('/org-harness.js'),doc=new Y.Doc(),id=crypto.randomUUID();
  model.addEntries(doc,[{path:'main.tex',content:`\\documentclass{article}\n\\begin{document}\n${marker}\n\\end{document}\n`}]);
  model.migrateProject(doc,id);doc.getMap('meta').set('name',name);await storage.saveProject(id,doc);doc.destroy();await window.scribyra.action('home');
 },{name,marker});
}
const dialogOf=page=>page.getByRole('dialog',{name:'Remote backup'});
const adminOf=page=>page.getByRole('dialog',{name:'Admin'});
/** Opens Remote backup afresh (closing it first if it is open), so it lists the server's state now. */
async function reopen(page){const dialog=dialogOf(page);if(await dialog.isVisible())await dialog.getByRole('button',{name:'Close remote backup'}).click();return openDialog(page);}
async function openDialog(page){const dialog=dialogOf(page);if(!(await dialog.isVisible()))await page.evaluate(()=>window.scribyra.action('remote-backup'));await expect(dialog).toBeVisible();return dialog;}
async function signIn(page,s,user){
 const dialog=await openDialog(page);
 await dialog.getByRole('textbox',{name:'Deployment address'}).fill(s.config.public_url);
 await dialog.getByRole('button',{name:'Continue'}).click();
 await dialog.getByRole('button',{name:'Sign in with Acme account'}).click();
 await providerLogin(page,user);
 await expect(dialogOf(page)).toContainText(`Signed in as ${user}@acme.test.`,{timeout:30000});
}
const orgRow=(page,name)=>dialogOf(page).getByRole('list',{name:'Projects on Acme Lab'}).getByRole('listitem').filter({hasText:name});
async function add(page,name){
 const dialog=await openDialog(page);
 await dialog.getByRole('list',{name:'Projects only on this device'}).getByRole('listitem').filter({hasText:name}).getByRole('button',{name:'Add to Acme Lab'}).click();
 await expect(orgRow(page,name)).toContainText('Synced',{timeout:30000});
}
async function share(page,name,email,role){
 await orgRow(page,name).getByRole('button',{name:'Share'}).click();
 await orgRow(page,name).getByRole('textbox',{name:'Email'}).fill(email);
 await orgRow(page,name).getByRole('combobox',{name:'Role'}).selectOption(role);
 await orgRow(page,name).getByRole('button',{name:'Invite'}).click();
 await expect(dialogOf(page).getByRole('status')).toContainText(email);
}
async function home(page){await page.evaluate(()=>window.scribyra.action('home'));await expect(page.locator('.project-grid')).toBeVisible();}
const remoteStatus=page=>page.getByRole('status',{name:'Remote backup'});
const source=page=>page.locator('.cm-content');
async function openAdmin(page){
 const dialog=await openDialog(page);
 await dialog.getByRole('button',{name:'Admin',exact:true}).click();
 await expect(adminOf(page)).toBeVisible();
 return adminOf(page);
}
const projectRow=(admin,name)=>admin.getByRole('list',{name:'All projects'}).getByRole('listitem').filter({hasText:name});
const memberRow=(admin,email)=>admin.getByRole('list',{name:'Members'}).getByRole('listitem').filter({hasText:email});
async function download(page,click){const [file]=await Promise.all([page.waitForEvent('download'),click()]);return{name:file.suggestedFilename(),bytes:await readFile(await file.path())};}

test('the admin area: every project, open as administrator, transfer, remove, delete, export and the audit log',async({browser},info)=>{
 const s=await serverService({shortcuts:false});const contexts=[];
 try{
  const ben=await profile(browser,info),cat=await profile(browser,info),ana=await profile(browser,info);contexts.push(ben.context,cat.context,ana.context);
  // Members add projects and share one.
  await personal(ben.page,'Ben thesis','BEN_THESIS_TEXT');await signIn(ben.page,s,'ben');await add(ben.page,'Ben thesis');
  await personal(cat.page,'Cat notes','CAT_NOTES_TEXT');await signIn(cat.page,s,'cat');await add(cat.page,'Cat notes');
  await share(cat.page,'Cat notes','ben@acme.test','viewer');
  // Cat is a member: no Admin entry, and the service refuses her its routes.
  await expect(dialogOf(cat.page).getByRole('button',{name:'Admin',exact:true})).toHaveCount(0);
  // Her own session token, from her browser's connection record.
  const catToken=await cat.page.evaluate(async()=>{const r=indexedDB.open('scribyra-org-server');const db=await new Promise(ok=>{r.onsuccess=()=>ok(r.result);});const c=await new Promise(ok=>{const q=db.transaction('connection').objectStore('connection').get('current');q.onsuccess=()=>ok(q.result);});db.close();return c.token;});
  for(const path of ['/v1/admin/members','/v1/admin/projects','/v1/admin/audit','/v1/admin/export','/v1/admin/settings'])
   expect((await fetch(s.url+path,{headers:{Authorization:'ScribyraSSO '+catToken}})).status,path).toBe(403);

  // Ana, an administrator by the deployment's admins list, sees every project and member.
  await signIn(ana.page,s,'ana');
  let admin=await openAdmin(ana.page);
  await expect(admin.getByRole('tab',{name:'Members'})).toHaveAttribute('aria-selected','true');
  await expect(memberRow(admin,'ben@acme.test')).toContainText('acme · Active');
  await expect(memberRow(admin,'ana@acme.test')).toContainText('(you)');
  await admin.getByRole('tab',{name:'Projects'}).click();
  await expect(projectRow(admin,'Ben thesis')).toContainText('ben@acme.test');
  await expect(projectRow(admin,'Cat notes')).toContainText('cat@acme.test · 2 people');
  await admin.getByRole('tab',{name:'Settings'}).click();
  await expect(admin.getByRole('definition').filter({hasText:'Server-readable'})).toBeVisible();

  // Open as administrator: a read-only copy that says so.
  await admin.getByRole('tab',{name:'Projects'}).click();
  await projectRow(admin,'Ben thesis').getByRole('button',{name:'Open Ben thesis as administrator'}).click();
  await expect(source(ana.page)).toContainText('BEN_THESIS_TEXT',{timeout:30000});
  await expect(remoteStatus(ana.page)).toHaveText('Opened as administrator · Read only',{timeout:30000});
  await expect(ana.page.getByRole('combobox',{name:'Editor mode'})).toHaveValue('viewing');
  // Ben's list says an administrator opened it.
  await home(ben.page);await openDialog(ben.page);
  await expect(orgRow(ben.page,'Ben thesis')).toContainText('An administrator opened this project on',{timeout:30000});

  // Transfer Cat's notes to Ben.
  await home(ana.page);admin=await openAdmin(ana.page);await admin.getByRole('tab',{name:'Projects'}).click();
  await projectRow(admin,'Cat notes').getByRole('button',{name:'Transfer Cat notes'}).click();
  await projectRow(admin,'Cat notes').getByRole('combobox',{name:'New owner of Cat notes'}).selectOption({label:'ben@acme.test'});
  await projectRow(admin,'Cat notes').getByRole('button',{name:'Confirm transferring Cat notes'}).click();
  await expect(admin.getByRole('status')).toContainText('Cat notes now belongs to ben@acme.test');
  await expect(projectRow(admin,'Cat notes')).toContainText('ben@acme.test');

  // Remove Ben while his project is open: it stops syncing, and what he owned passes to Cat.
  await openDialog(ben.page);await orgRow(ben.page,'Ben thesis').getByRole('button',{name:'Open'}).click();
  await expect(source(ben.page)).toBeVisible({timeout:30000});
  await expect(remoteStatus(ben.page)).toHaveText('Synced',{timeout:30000});
  await admin.getByRole('tab',{name:'Members'}).click();
  await memberRow(admin,'ben@acme.test').getByRole('button',{name:'Remove ben@acme.test'}).click();
  await memberRow(admin,'ben@acme.test').getByRole('combobox',{name:'New owner of ben@acme.test’s projects'}).selectOption({label:'cat@acme.test'});
  await memberRow(admin,'ben@acme.test').getByRole('button',{name:'Confirm removing ben@acme.test'}).click();
  await expect(admin.getByRole('status')).toContainText('ben@acme.test was removed; 2 projects moved.');
  await expect(memberRow(admin,'ben@acme.test')).toHaveCount(0);
  await expect(remoteStatus(ben.page)).toHaveText('Saved on this device',{timeout:60000});
  await home(cat.page);await reopen(cat.page);
  await expect(orgRow(cat.page,'Ben thesis')).toContainText('Not on this device',{timeout:30000});
  await expect(orgRow(cat.page,'Cat notes')).not.toContainText('Editor');

  // Delete Cat's notes: gone for its members.
  await admin.getByRole('tab',{name:'Projects'}).click();
  await projectRow(admin,'Cat notes').getByRole('button',{name:'Delete Cat notes'}).click();
  await projectRow(admin,'Cat notes').getByRole('button',{name:'Delete Cat notes permanently'}).click();
  await expect(admin.getByRole('status')).toContainText('Cat notes was deleted.');
  await expect(projectRow(admin,'Cat notes')).toHaveCount(0);
  await expect(orgRow(cat.page,'Cat notes')).toContainText('No longer shared with you',{timeout:30000});

  // Export everything: a zip with the projects' files, the members and the audit log.
  await admin.getByRole('tab',{name:'Export'}).click();
  const zip=await download(ana.page,()=>admin.getByRole('button',{name:'Export everything'}).click());
  expect(zip.name).toBe('scribyra-export.zip');
  const files=unzipSync(new Uint8Array(zip.bytes)),names=Object.keys(files);
  const thesis=names.find(n=>/^projects\/Ben thesis-[0-9a-f]{8}\/main\.tex$/.test(n));
  expect(thesis,names.join(', ')).toBeTruthy();
  expect(strFromU8(files[thesis])).toContain('BEN_THESIS_TEXT');
  expect(names.some(n=>n.includes('Cat notes'))).toBe(false);
  expect(JSON.parse(strFromU8(files['members.json'])).map(m=>m.email)).toEqual(['ben@acme.test','cat@acme.test','ana@acme.test']);
  expect(strFromU8(files['audit.jsonl'])).toContain('"export.everything"');

  // The audit log: filtered by action, and exported as CSV and JSON lines.
  await admin.getByRole('tab',{name:'Audit log'}).click();
  const table=admin.getByRole('table',{name:'Audit log'});
  await expect(table).toContainText('Account removed');
  await admin.getByRole('combobox',{name:'Action'}).selectOption('project.admin_open');
  await admin.getByRole('button',{name:'Apply filters'}).click();
  await expect(table.locator('tbody tr')).toHaveCount(1);
  await expect(table.locator('tbody tr')).toContainText('ana@acme.test');
  await expect(table.locator('tbody tr')).toContainText('Opened as administrator');
  const csv=await download(ana.page,()=>admin.getByRole('button',{name:'Export CSV'}).click());
  const text=csv.bytes.toString();expect(csv.name).toBe('scribyra-audit.csv');
  expect(text.split('\n')[0]).toBe('seq,time,actor,actor_name,actor_email,ip,action,target_type,target,detail,prev,hash');
  expect(text).toContain('"project.admin_open"');expect(text).not.toContain('"project.deleted"');
  await admin.getByRole('combobox',{name:'Action'}).selectOption('');
  await admin.getByRole('button',{name:'Apply filters'}).click();
  const jsonl=await download(ana.page,()=>admin.getByRole('button',{name:'Export JSON lines'}).click());
  const lines=jsonl.bytes.toString().trim().split('\n').map(l=>JSON.parse(l));
  for(const action of ['project.created','share.created','project.admin_open','project.transferred','account.removed','project.deleted','export.everything'])
   expect(lines.some(l=>l.action===action),action).toBe(true);
  expect(lines.at(-1).head.hash).toMatch(/^[0-9a-f]{64}$/);
  expect(await s.sql("SELECT count(*) FROM audit_events WHERE action = 'audit.export'")).toBe('2');
 }finally{for(const c of contexts)await c.close().catch(()=>{});await s.close();}
});
