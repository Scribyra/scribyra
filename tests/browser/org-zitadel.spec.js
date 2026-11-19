// Opt-in (`SCRIBYRA_ZITADEL_E2E=1`, run by `scripts/zitadel-e2e.sh`): the organisation deployment
// against a real Zitadel 2.71 from nixpkgs, set up through its own APIs (tests/helpers/zitadel.mjs),
// with real sign-ins at Zitadel's login UI through the app. With the `zitadel` preset's defaults
// (the owner organisation is the deployment's only one): an administrator and a member get their
// roles, someone without a Scribyra role is refused, a Partner user whose role comes through the
// project grant is a guest who sees only what is shared with them and cannot add or share, the
// admin area shows each role read-only, and a role removed in Zitadel ends access at the next
// recheck (a new sign-in is then refused). With `zitadel_foreign_organisations: "organisations"`
// each Zitadel organisation is its own: a Partner user is a member of Partner and a guest of Acme
// (Acme granted her directly), switches between them, and loses Acme when Acme revokes the grant.
import {test,expect} from '@playwright/test';
import {readFile} from 'node:fs/promises';
import {build} from 'esbuild';
import {service} from '../helpers/service.mjs';
import {zitadel,provision,zitadelLogin,freePort,ROLES} from '../helpers/zitadel.mjs';

const enabled=process.env.SCRIBYRA_ZITADEL_E2E==='1';
test.skip(!enabled,'a real Zitadel: set SCRIBYRA_ZITADEL_E2E=1 (scripts/zitadel-e2e.sh)');
test.describe.configure({mode:'serial'});

const LABEL='Acme Zitadel';
let z,setup,ports;
test.beforeAll(async()=>{
 test.setTimeout(900000);
 z=await zitadel();ports=[await freePort(),await freePort()];
 setup=await provision(z,{redirectUris:ports.map(p=>`http://127.0.0.1:${p}/v1/sso/callback/zitadel`),users:{
  ana:{org:'acme',grants:{acme:[ROLES.admin]}},
  ben:{org:'acme',grants:{acme:[ROLES.member]}},
  nob:{org:'acme',grants:{}},
  cy:{org:'partner',grants:{partner:[ROLES.member]}},
  eve:{org:'partner',grants:{partner:[ROLES.member],acme:[ROLES.member]}},
 }});
});

/** The deployment "Acme Lab" signing in with this Zitadel (preset `zitadel`), rechecking logins every second once due. */
async function deployment(port,provider={},extra={}){
 const s=await service({bind:`127.0.0.1:${port}`,public_url:`http://127.0.0.1:${port}`,sso_recheck_tick_seconds:1,
  deployment:{name:'Acme Lab',encryption:'server',guests:'shared',...extra,providers:[{id:'zitadel',label:LABEL,issuer:z.issuer,client_id:setup.clientId,client_secret_file:setup.secretFile,
   preset:'zitadel',zitadel_project_id:setup.project,zitadel_project_owner_org:setup.orgs.acme,roles:{admin:[ROLES.admin],member:[ROLES.member],guest:[ROLES.guest]},recheck_minutes:1,...provider}]}});
 return Object.assign(s,{due:()=>s.sql("UPDATE sso_logins SET checked = now() - interval '1 day' WHERE NOT revoked")});
}

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
/** Enters the address and signs in at Zitadel's own login UI; `signedIn` false for a refused
 * sign-in; `again` from the dialog's "sign in again" (the address is known), where Zitadel's own
 * session signs the person in without its form. */
async function signIn(page,s,user,{signedIn=true,again=false}={}){
 const dialog=await openDialog(page);
 if(!again){
  await dialog.getByRole('textbox',{name:'Deployment address'}).fill(s.config.public_url);
  await dialog.getByRole('button',{name:'Continue'}).click();
 }
 await dialog.getByRole('button',{name:new RegExp(`^Sign in with ${LABEL}`)}).first().click();
 if(!again)await zitadelLogin(page,user,expect);
 if(signedIn)await expect(dialogOf(page)).toContainText(`Signed in as ${user}@acme.test.`,{timeout:60000});
}
const projects=(page,place)=>dialogOf(page).getByRole('list',{name:`Projects on ${place}`});
const row=(page,place,name)=>projects(page,place).getByRole('listitem').filter({hasText:name});
async function add(page,place,name){
 const dialog=await openDialog(page);
 await dialog.getByRole('list',{name:'Projects only on this device'}).getByRole('listitem').filter({hasText:name}).getByRole('button',{name:`Add to ${place}`}).click();
 await expect(row(page,place,name)).toContainText('Synced',{timeout:60000});
}
async function invite(page,place,name,email,role='editor',{guest=false}={}){
 await row(page,place,name).getByRole('button',{name:'Share'}).click();
 await row(page,place,name).getByRole('textbox',{name:'Email'}).fill(email);
 await row(page,place,name).getByRole('combobox',{name:'Role'}).selectOption(role);
 if(guest)await row(page,place,name).getByRole('checkbox',{name:/^Invite as a guest/}).check();
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

test('Zitadel preset: roles from real tokens, a project-grant guest, read-only roles, and a role removed in Zitadel ends access',async({browser},info)=>{
 test.setTimeout(600000);
 const s=await deployment(ports[0]);const contexts=[];
 try{
  const ana=await profile(browser,info),ben=await profile(browser,info),cy=await profile(browser,info),nob=await profile(browser,info);contexts.push(ana.context,ben.context,cy.context,nob.context);
  // Acme's administrator and a member: roles from Zitadel's project roles claim; the profile
  // (email) comes from userinfo, which is all the application's default token settings give.
  await personal(ana.page,'Acme plan');await personal(ana.page,'Acme secret');
  await signIn(ana.page,s,'ana');
  await expect(dialogOf(ana.page)).toContainText(`Your role in Acme Lab: Administrator, from ${LABEL}. Roles are granted in ${LABEL}.`);
  await expect(dialogOf(ana.page).getByRole('combobox',{name:'Organisation'})).toHaveCount(0);
  await add(ana.page,'Acme Lab','Acme plan');await add(ana.page,'Acme Lab','Acme secret');
  await personal(ben.page,'Ben paper');
  await signIn(ben.page,s,'ben');
  await expect(dialogOf(ben.page)).toContainText(`Your role in Acme Lab: Member, from ${LABEL}.`);
  await expect(dialogOf(ben.page).getByRole('button',{name:'Admin',exact:true})).toHaveCount(0);
  await add(ben.page,'Acme Lab','Ben paper');
  // No Scribyra role in the project: refused with the design's sentence, nothing connected.
  await signIn(nob.page,s,'nob',{signedIn:false});
  await expect(toast(nob.page)).toContainText(`Your account has no Scribyra role. Ask your administrator to grant one in ${LABEL}.`,{timeout:60000});
  expect(await nob.page.evaluate(()=>localStorage.getItem('scribyra:org-server'))).toBeNull();

  // Cy belongs to Partner, which granted her the member role through the project grant: a guest
  // of Acme, seeing only what is shared with her, never adding or sharing.
  await invite(ana.page,'Acme Lab','Acme plan','cy@acme.test','editor',{guest:true});
  await personal(cy.page,'Cy notes');
  await signIn(cy.page,s,'cy');
  const dialog=dialogOf(cy.page);
  await expect(dialog).toContainText(`Your role in Acme Lab: Guest, from ${LABEL}.`);
  await expect(dialog).toContainText('As a guest you see only the projects shared with you in Acme Lab, and you cannot add projects.');
  await expect(row(cy.page,'Acme Lab','Acme plan')).toContainText('Not on this device · Editor',{timeout:60000});
  await expect(projects(cy.page,'Acme Lab').getByRole('listitem')).toHaveCount(1);
  await expect(dialog.getByRole('list',{name:'Projects only on this device'})).toHaveCount(0);
  await expect(dialog.getByRole('button',{name:/^Add to /})).toHaveCount(0);
  await expect(dialog.getByRole('button',{name:'Admin',exact:true})).toHaveCount(0);
  await row(cy.page,'Acme Lab','Acme plan').getByRole('button',{name:'Share'}).click();
  await expect(row(cy.page,'Acme Lab','Acme plan').getByRole('list',{name:'People with access'})).toContainText('ana@acme.test');
  await expect(row(cy.page,'Acme Lab','Acme plan').getByRole('textbox',{name:'Email'})).toHaveCount(0);
  await row(cy.page,'Acme Lab','Acme plan').getByRole('button',{name:'Open'}).click();
  await expect(cy.page.locator('.cm-content')).toContainText('Acme plan',{timeout:60000});

  // The admin area shows each role and where it comes from, with no way to change it.
  const admin=await openAdmin(ana.page);
  await expect(members(admin).getByRole('listitem').filter({hasText:'ana@acme.test'}).getByLabel('Role of ana@acme.test')).toHaveText(`Administrator · from ${LABEL}`);
  await expect(members(admin).getByRole('listitem').filter({hasText:'ben@acme.test'}).getByLabel('Role of ben@acme.test')).toHaveText(`Member · from ${LABEL}`);
  await expect(members(admin).getByRole('listitem').filter({hasText:'cy@acme.test'}).getByLabel('Role of cy@acme.test')).toHaveText(`Guest · from ${LABEL}`);
  await expect(members(admin)).not.toContainText('nob@acme.test');
  await expect(admin.getByRole('combobox',{name:/^Role for/})).toHaveCount(0);
  await adminOf(ana.page).getByRole('button',{name:'Close admin'}).click();

  // Acme removes Ben's role in Zitadel: at the next recheck (a real refresh at Zitadel) his login
  // ends, his copy stops syncing, and signing in again is refused.
  await setup.revoke('ben','acme');
  await s.due();
  await expect.poll(()=>s.sql("SELECT count(*) FROM sso_logins l JOIN accounts a ON a.account = l.account WHERE a.email = 'ben@acme.test' AND NOT l.revoked"),{timeout:60000}).toBe('0');
  const again=await reopen(ben.page);
  await expect(again).toContainText('Sign in again to keep syncing.',{timeout:60000});
  // Zitadel still has Ben's session, so it answers at once; the service refuses the token.
  await signIn(ben.page,s,'ben',{signedIn:false,again:true});
  await expect(toast(ben.page)).toContainText(`Your account has no Scribyra role. Ask your administrator to grant one in ${LABEL}.`,{timeout:60000});
  // Ana's login went through the same recheck (a refresh at Zitadel) and keeps its role.
  const still=await reopen(ana.page);
  await expect(still).toContainText(`Your role in Acme Lab: Administrator, from ${LABEL}.`);
  await expect(row(ana.page,'Acme Lab','Acme plan')).toContainText('Synced');
 }finally{for(const c of contexts)await c.close().catch(()=>{});await s.close();}
});

test('Zitadel preset with one Scribyra organisation per Zitadel organisation: own and cross-organisation roles, switching, and a revoked grant',async({browser},info)=>{
 test.setTimeout(600000);
 const s=await deployment(ports[1],{zitadel_foreign_organisations:'organisations'},{primary_organisation:{provider:'zitadel',organisation:setup.orgs.acme}});
 const ACME=setup.domains.acme,PARTNER=setup.domains.partner;const contexts=[];
 try{
  const ana=await profile(browser,info),eve=await profile(browser,info);contexts.push(ana.context,eve.context);
  // Ana's role is keyed by her own organisation (the resource owner claim Zitadel sends only
  // when asked for it): an administrator of Acme, not a guest.
  await personal(ana.page,'Acme report');
  await signIn(ana.page,s,'ana');
  await expect(dialogOf(ana.page)).toContainText(`Your role in Acme Lab: Administrator, from ${LABEL}.`);
  await add(ana.page,'Acme Lab','Acme report');
  await invite(ana.page,'Acme Lab','Acme report','eve@acme.test','viewer',{guest:true});
  // Eve: a member of her own Partner (its grant), a guest of Acme (Acme's direct grant).
  await personal(eve.page,'Eve draft');
  await signIn(eve.page,s,'eve');
  const dialog=dialogOf(eve.page),choose=dialog.getByRole('combobox',{name:'Organisation'});
  await expect(choose).toBeVisible();
  expect((await choose.locator('option').allTextContents()).sort()).toEqual([`${ACME} (guest)`,PARTNER].sort());
  await choose.selectOption({label:PARTNER});
  await expect(dialog).toContainText(`Your role in ${PARTNER}: Member, from ${LABEL}.`);
  await add(eve.page,PARTNER,'Eve draft');
  await choose.selectOption({label:`${ACME} (guest)`});
  await expect(dialog).toContainText(`As a guest you see only the projects shared with you in ${ACME}, and you cannot add projects.`);
  await expect(row(eve.page,ACME,'Acme report')).toContainText('Not on this device · Viewer',{timeout:60000});
  await expect(projects(eve.page,ACME)).not.toContainText('Eve draft');
  // Acme revokes its grant in Zitadel: Eve's access to Acme ends at the next recheck; Partner stays.
  await setup.revoke('eve','acme');
  await s.due();
  await expect(toast(eve.page)).toContainText(`Your access to ${ACME} ended.`,{timeout:60000});
  const after=await reopen(eve.page);
  await expect(after.getByRole('combobox',{name:'Organisation'})).toHaveCount(0);
  // One organisation left: the dialog names the deployment again, and Eve's project syncs on.
  await expect(after).toContainText(`Your role in Acme Lab: Member, from ${LABEL}.`);
  await expect(row(eve.page,'Acme Lab','Eve draft')).toContainText('Synced');
  await expect(projects(eve.page,'Acme Lab')).not.toContainText('Acme report');
 }finally{for(const c of contexts)await c.close().catch(()=>{});await s.close();}
});
