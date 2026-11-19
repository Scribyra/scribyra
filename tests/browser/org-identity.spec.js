// Identity, organisations and roles from the provider in the real app (design section 3, slice
// 12a), with the repository's OIDC test provider issuing Zitadel-shaped tokens: an administrator
// and a member sign in and see their roles read-only (no role editing in the admin area); an
// account with no mapped role is refused with the design's sentence; two organisations share one
// deployment, and Cy, a member of Acme and a guest of the partner (a cross-organisation grant),
// switches between them and sees only each one's projects, cannot add projects as a guest, while
// Acme's administrator sees nothing of the partner in the admin area; the provider then takes
// Cy's partner role away and, within one recheck, her copy stops syncing and the app says her
// access ended. With `notify_on_admin_access` off a member is not told that an administrator
// opened their project, and the audit log still records it.
import {test,expect} from '@playwright/test';
import {readFile} from 'node:fs/promises';
import {build} from 'esbuild';
import {identityService,serverService,zitadelUser,ZITADEL,ROLES} from '../helpers/idp.mjs';
import {providerLogin} from '../helpers/org-browser.mjs';

let bundle;
async function harness(page){
 bundle??=(await build({stdin:{resolveDir:process.cwd(),contents:`import init from './web/pkg/scribyra_app.js';import {initializeCollaborationSchema} from './web/collaboration-schema.js';await init({module_or_path:'/org-harness.wasm'});initializeCollaborationSchema();export * as Y from 'yjs';export * as model from './web/model.js';export * as storage from './web/storage.js';`},bundle:true,write:false,format:'esm',platform:'browser',loader:{'.css':'empty'}})).outputFiles[0].text;
 await page.route('**/org-harness.js',r=>r.fulfill({contentType:'text/javascript',body:bundle}));
 await page.route('**/org-harness.wasm',async r=>r.fulfill({contentType:'application/wasm',body:await readFile('web/pkg/scribyra_app_bg.wasm')}));
}
async function profile(browser,info){
 const context=await browser.newContext({serviceWorkers:'block'});
 if(info.project.name==='chromium')await context.grantPermissions(['local-network-access']).catch(()=>{});
 const page=await context.newPage();await harness(page);await page.goto('/');
 return{context,page};
}
async function personal(page,name){
 await page.evaluate(async name=>{
  const {Y,model,storage}=await import('/org-harness.js'),doc=new Y.Doc(),id=crypto.randomUUID();
  model.addEntries(doc,[{path:'main.tex',content:`\\documentclass{article}\n\\begin{document}\n${name}\n\\end{document}\n`}]);
  model.migrateProject(doc,id);doc.getMap('meta').set('name',name);await storage.saveProject(id,doc);doc.destroy();await window.scribyra.action('home');
 },name);
}
const dialogOf=page=>page.getByRole('dialog',{name:'Remote backup'});
const adminOf=page=>page.getByRole('dialog',{name:'Admin'});
const toast=page=>page.getByRole('status',{name:'Workspace notification'});
async function openDialog(page){const dialog=dialogOf(page);if(!(await dialog.isVisible()))await page.evaluate(()=>window.scribyra.action('remote-backup'));await expect(dialog).toBeVisible();return dialog;}
async function reopen(page){const dialog=dialogOf(page);if(await dialog.isVisible())await dialog.getByRole('button',{name:'Close remote backup'}).click();return openDialog(page);}
/** Enters the address and signs in at the provider's own form; `signedIn` false for a refused sign-in. */
async function signIn(page,s,user,{signedIn=true}={}){
 const dialog=await openDialog(page);
 await dialog.getByRole('textbox',{name:'Deployment address'}).fill(s.config.public_url);
 await dialog.getByRole('button',{name:'Continue'}).click();
 await dialog.getByRole('button',{name:'Sign in with Acme account'}).click();
 await providerLogin(page,user);
 if(signedIn)await expect(dialogOf(page)).toContainText(`Signed in as ${user}@acme.test.`,{timeout:30000});
}
const projects=(page,place)=>dialogOf(page).getByRole('list',{name:`Projects on ${place}`});
const row=(page,place,name)=>projects(page,place).getByRole('listitem').filter({hasText:name});
async function add(page,place,name){
 const dialog=await openDialog(page);
 await dialog.getByRole('list',{name:'Projects only on this device'}).getByRole('listitem').filter({hasText:name}).getByRole('button',{name:`Add to ${place}`}).click();
 await expect(row(page,place,name)).toContainText('Synced',{timeout:30000});
}
async function invite(page,place,name,email,role='editor'){
 await row(page,place,name).getByRole('button',{name:'Share'}).click();
 await row(page,place,name).getByRole('textbox',{name:'Email'}).fill(email);
 await row(page,place,name).getByRole('combobox',{name:'Role'}).selectOption(role);
 await row(page,place,name).getByRole('button',{name:'Invite'}).click();
 await expect(dialogOf(page).getByRole('status')).toContainText(email);
}
async function openAdmin(page){
 const dialog=await reopen(page);
 await dialog.getByRole('button',{name:'Admin',exact:true}).click();
 await expect(adminOf(page)).toBeVisible();
 return adminOf(page);
}
const members=admin=>admin.getByRole('list',{name:'Members'});
const allProjects=admin=>admin.getByRole('list',{name:'All projects'});
async function closeAdmin(page){await adminOf(page).getByRole('button',{name:'Close admin'}).click();}
const ACME=ZITADEL.acme.name,PARTNER=ZITADEL.partner.name;

test('provider roles: an administrator and a member sign in with their roles read-only, and an account without a mapped role is refused',async({browser},info)=>{
 const s=await identityService({shortcuts:false,users:[zitadelUser('ana','acme',{[ROLES.admin]:['acme']}),zitadelUser('ben','acme',{[ROLES.member]:['acme']}),zitadelUser('nob','acme',{'other-app:admin':['acme']})]});
 const contexts=[];
 try{
  const ana=await profile(browser,info),ben=await profile(browser,info),nob=await profile(browser,info);contexts.push(ana.context,ben.context,nob.context);
  await signIn(ana.page,s,'ana');
  // One organisation: projects go to the deployment; the role comes from the provider.
  await expect(dialogOf(ana.page)).toContainText('Your role in Acme Lab: Administrator, from Acme account. Roles are granted in Acme account.');
  await expect(dialogOf(ana.page).getByRole('combobox',{name:'Organisation'})).toHaveCount(0);
  await signIn(ben.page,s,'ben');
  await expect(dialogOf(ben.page)).toContainText('Your role in Acme Lab: Member, from Acme account.');
  await expect(dialogOf(ben.page).getByRole('button',{name:'Admin',exact:true})).toHaveCount(0);
  await expect(dialogOf(ben.page).getByRole('list',{name:'Projects only on this device'})).toBeVisible();
  // The admin area shows each role and its provider, and offers no way to change it.
  const admin=await openAdmin(ana.page);
  await expect(members(admin).getByRole('listitem').filter({hasText:'ana@acme.test'}).getByLabel('Role of ana@acme.test')).toHaveText('Administrator · from Acme account');
  await expect(members(admin).getByRole('listitem').filter({hasText:'ben@acme.test'}).getByLabel('Role of ben@acme.test')).toHaveText('Member · from Acme account');
  await expect(admin).toContainText('Roles come from Acme account: grant or remove them there.');
  await expect(admin.getByRole('combobox',{name:/^Role for/})).toHaveCount(0);
  // No mapped role: refused at sign-in with the design's sentence, and nothing is connected.
  await signIn(nob.page,s,'nob',{signedIn:false});
  await expect(toast(nob.page)).toContainText('Your account has no Scribyra role. Ask your administrator to grant one in Acme account.',{timeout:30000});
  expect(new URL(nob.page.url()).hash).toBe('');
  expect(await nob.page.evaluate(()=>localStorage.getItem('scribyra:org-server'))).toBeNull();
 }finally{for(const c of contexts)await c.close().catch(()=>{});await s.close();}
});

test('two organisations: switching, isolation, a guest who cannot add, and a role taken away at the provider ends access within one recheck',async({browser},info)=>{
 test.setTimeout(240000);
 const cy=zitadelUser('cy','acme',{[ROLES.member]:['acme','partner']});
 const s=await identityService({shortcuts:false,users:[zitadelUser('ana','acme',{[ROLES.admin]:['acme']}),zitadelUser('bea','partner',{[ROLES.admin]:['partner']}),cy]});
 const contexts=[];
 try{
  const ana=await profile(browser,info),bea=await profile(browser,info),cyp=await profile(browser,info);contexts.push(ana.context,bea.context,cyp.context);
  // Acme first (so it is Cy's first organisation), then the partner, each with its own projects.
  await personal(ana.page,'Acme paper');await signIn(ana.page,s,'ana');await add(ana.page,'Acme Lab','Acme paper');
  await personal(bea.page,'Partner plan');await personal(bea.page,'Partner secret');await signIn(bea.page,s,'bea');
  await add(bea.page,'Acme Lab','Partner plan');await add(bea.page,'Acme Lab','Partner secret');
  await invite(bea.page,'Acme Lab','Partner plan','cy@acme.test');

  // Cy holds roles in both: the switcher, and Acme first.
  await personal(cyp.page,'Cy notes');await signIn(cyp.page,s,'cy');
  const dialog=dialogOf(cyp.page),choose=dialog.getByRole('combobox',{name:'Organisation'});
  await expect(choose).toBeVisible();
  await expect(choose.locator('option')).toHaveText([ACME,`${PARTNER} (guest)`]);
  await expect(dialog).toContainText(`Your role in ${ACME}: Member, from Acme account.`);
  await expect(projects(cyp.page,ACME)).toContainText('No projects yet.');
  await add(cyp.page,ACME,'Cy notes');
  await expect(projects(cyp.page,ACME)).not.toContainText('Acme paper');
  await expect(projects(cyp.page,ACME)).not.toContainText('Partner');
  // In the partner organisation she is a guest: only what is shared with her, and no adding.
  await choose.selectOption({label:`${PARTNER} (guest)`});
  await expect(dialog.getByRole('status')).toContainText(`Working in ${PARTNER}.`);
  await expect(dialog).toContainText(`As a guest you see only the projects shared with you in ${PARTNER}, and you cannot add projects.`);
  await expect(row(cyp.page,PARTNER,'Partner plan')).toContainText('Not on this device · Editor',{timeout:30000});
  await expect(projects(cyp.page,PARTNER).getByRole('listitem')).toHaveCount(1);
  await expect(dialog.getByRole('list',{name:'Projects only on this device'})).toHaveCount(0);
  await expect(dialog.getByRole('button',{name:/^Add to /})).toHaveCount(0);
  await expect(dialog.getByRole('button',{name:'Admin',exact:true})).toHaveCount(0);
  await row(cyp.page,PARTNER,'Partner plan').getByRole('button',{name:'Open'}).click();
  await expect(cyp.page.locator('.cm-content')).toContainText('Partner plan',{timeout:30000});
  await expect(cyp.page.getByRole('combobox',{name:'Editor mode'})).toHaveValue('editing');
  // A guest does not share, even as an editor.
  const again=await openDialog(cyp.page);
  await row(cyp.page,PARTNER,'Partner plan').getByRole('button',{name:'Share'}).click();
  await expect(row(cyp.page,PARTNER,'Partner plan').getByRole('list',{name:'People with access'})).toContainText('bea@acme.test');
  await expect(row(cyp.page,PARTNER,'Partner plan').getByRole('textbox',{name:'Email'})).toHaveCount(0);
  // Back in Acme: her own project, synced under Acme while the partner's copy syncs under the partner.
  await again.getByRole('combobox',{name:'Organisation'}).selectOption({label:ACME});
  await expect(row(cyp.page,ACME,'Cy notes')).toBeVisible();
  await expect(projects(cyp.page,ACME)).not.toContainText('Partner plan');

  // Acme's administrator sees Acme only; the partner's administrator sees Cy as a guest.
  let admin=await openAdmin(ana.page);
  await expect(members(admin)).toContainText('cy@acme.test');
  await expect(members(admin)).not.toContainText('bea@acme.test');
  await admin.getByRole('tab',{name:'Projects'}).click();
  await expect(allProjects(admin)).toContainText('Cy notes');await expect(allProjects(admin)).toContainText('Acme paper');
  await expect(allProjects(admin)).not.toContainText('Partner');
  await closeAdmin(ana.page);
  admin=await openAdmin(bea.page);
  await expect(members(admin).getByRole('listitem').filter({hasText:'cy@acme.test'}).getByLabel('Role of cy@acme.test')).toHaveText('Guest · from Acme account');
  await expect(members(admin)).not.toContainText('ana@acme.test');
  await admin.getByRole('tab',{name:'Projects'}).click();
  await expect(allProjects(admin)).toContainText('Partner secret');await expect(allProjects(admin)).not.toContainText('Cy notes');
  await closeAdmin(bea.page);

  // The partner withdraws its grant at the provider: at the next recheck Cy's access there ends,
  // her copy stays on this device without syncing, and the app says so. Acme is untouched.
  await s.provider.set('cy',{zitadel:{...cy.zitadel,roles:{[ROLES.member]:{[ZITADEL.acme.id]:ACME}}}});
  await s.due();
  await expect(toast(cyp.page)).toContainText(`Your access to ${PARTNER} ended. Its projects stay on this device and no longer sync.`,{timeout:60000});
  await expect(cyp.page.getByRole('status',{name:'Remote backup'})).toContainText('Access ended');
  const after=await reopen(cyp.page);
  await expect(after).toContainText(`Your access to ${PARTNER} ended. Its projects stay on this device and no longer sync.`);
  await expect(after.getByRole('combobox',{name:'Organisation'})).toHaveCount(0);
  await expect(row(cyp.page,'Acme Lab','Cy notes')).toContainText('Synced');
  await cyp.page.evaluate(()=>window.scribyra.action('home'));
  await expect(cyp.page.locator('.project-card').filter({hasText:'Partner plan'})).toContainText('Access ended');
 }finally{for(const c of contexts)await c.close().catch(()=>{});await s.close();}
});

test('notify_on_admin_access off: the member is not told, the audit log still records the open',async({browser},info)=>{
 const s=await serverService({shortcuts:false,deployment:{notify_on_admin_access:false}});const contexts=[];
 try{
  const ben=await profile(browser,info),ana=await profile(browser,info);contexts.push(ben.context,ana.context);
  await personal(ben.page,'Ben quiet');await signIn(ben.page,s,'ben');await add(ben.page,'Acme Lab','Ben quiet');
  await signIn(ana.page,s,'ana');
  const admin=await openAdmin(ana.page);
  await expect(admin.getByRole('tab',{name:'Settings'})).toBeVisible();
  await admin.getByRole('tab',{name:'Projects'}).click();
  await allProjects(admin).getByRole('listitem').filter({hasText:'Ben quiet'}).getByRole('button',{name:'Open Ben quiet as administrator'}).click();
  await expect(ana.page.locator('.cm-content')).toContainText('Ben quiet',{timeout:30000});
  await expect(ana.page.getByRole('status',{name:'Remote backup'})).toContainText('Opened as administrator');
  // The audit log records the open.
  const audit=await openAdmin(ana.page);
  await audit.getByRole('tab',{name:'Audit log'}).click();
  await expect(audit.getByRole('table',{name:'Audit log'}).locator('tr[data-action="project.admin_open"]')).toHaveCount(1,{timeout:30000});
  await audit.getByRole('tab',{name:'Settings'}).click();
  await expect(audit.getByRole('definition').filter({hasText:'Audited; members are not told'})).toBeVisible();
  await closeAdmin(ana.page);
  // Ben's list and the project's details say nothing of it.
  const dialog=await reopen(ben.page);
  await expect(row(ben.page,'Acme Lab','Ben quiet')).toContainText('Synced');
  await row(ben.page,'Acme Lab','Ben quiet').getByRole('button',{name:'Share'}).click();
  await expect(row(ben.page,'Acme Lab','Ben quiet').getByRole('list',{name:'People with access'})).toBeVisible();
  await expect(dialog).not.toContainText('An administrator');
 }finally{for(const c of contexts)await c.close().catch(()=>{});await s.close();}
});
