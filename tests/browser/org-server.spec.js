// Server-readable organisation projects in the real app (design slice 9), across browser
// profiles, with the repository's OIDC test provider: Ana signs in, adds a personal project with an
// image and invites ben@acme.test as an editor by email; Ben signs in, opens it from the server
// (the image comes along) and edits; Ana sees his edit live; both edit offline and converge after
// reconnecting; as a viewer Ben cannot edit; and what they typed is in neither the service's
// database nor its blob directory. An online-only deployment pauses editing offline and leaves no
// copy on the device after signing out.
import {test,expect} from '@playwright/test';
import {readFile,readdir} from 'node:fs/promises';
import {join} from 'node:path';
import {build} from 'esbuild';
import {serverService} from '../helpers/idp.mjs';
import {pgDump} from '../helpers/service.mjs';
import {providerLogin} from '../helpers/org-browser.mjs';

let bundle;
async function harness(page){
 bundle??=(await build({stdin:{resolveDir:process.cwd(),contents:`import init from './web/pkg/scribyra_app.js';import {initializeCollaborationSchema} from './web/collaboration-schema.js';await init({module_or_path:'/org-harness.wasm'});initializeCollaborationSchema();export * as Y from 'yjs';export * as model from './web/model.js';export * as storage from './web/storage.js';export * as assets from './web/assets.js';`},bundle:true,write:false,format:'esm',platform:'browser',loader:{'.css':'empty'}})).outputFiles[0].text;
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
// A 1×1 PNG, so the app can show it; the marker sits in a text chunk the decoder ignores.
const PNG='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
/** A personal project with a main file and an image, made through the app's own model and storage. */
async function personal(page,name,marker){
 await page.evaluate(async({name,marker,png})=>{
  const {Y,model,storage}=await import('/org-harness.js'),doc=new Y.Doc(),id=crypto.randomUUID();
  // A tEXt chunk (length, type, data, CRC-32 of type and data) just before IEND.
  const image=Uint8Array.from(atob(png),c=>c.charCodeAt(0)),body=new TextEncoder().encode(`tEXtComment\0${marker}_IMAGE`);
  let crc=~0;for(const b of body){crc^=b;for(let k=0;k<8;k++)crc=crc>>>1^(crc&1?0xedb88320:0);}crc=~crc>>>0;
  const chunk=new Uint8Array(body.length+8),view=new DataView(chunk.buffer);view.setUint32(0,body.length-4);chunk.set(body,4);view.setUint32(body.length+4,crc);
  const bytes=new Uint8Array(image.length+chunk.length);bytes.set(image.subarray(0,image.length-12));bytes.set(chunk,image.length-12);bytes.set(image.subarray(image.length-12),image.length-12+chunk.length);
  model.addEntries(doc,[{path:'main.tex',content:`\\documentclass{article}\n\\begin{document}\n${marker}_START\n\\end{document}\n`},{path:'figure.png',content:bytes}]);
  model.migrateProject(doc,id);doc.getMap('meta').set('name',name);await storage.saveProject(id,doc);doc.destroy();await window.scribyra.action('home');
 },{name,marker,png:PNG});
}
const dialogOf=page=>page.getByRole('dialog',{name:'Remote backup'});
async function openDialog(page){const dialog=dialogOf(page);if(!(await dialog.isVisible()))await page.evaluate(()=>window.scribyra.action('remote-backup'));await expect(dialog).toBeVisible();return dialog;}
/** Enters the deployment's address, signs in at the provider's own form; back with the dialog open. */
async function signIn(page,s,user){
 const dialog=await openDialog(page);
 await dialog.getByRole('textbox',{name:'Deployment address'}).fill(s.config.public_url);
 await dialog.getByRole('button',{name:'Continue'}).click();
 await expect(dialog).toContainText('Stored on Acme Lab’s server, which can read it. Acme Lab’s administrators can open it.');
 await dialog.getByRole('button',{name:'Sign in with Acme account'}).click();
 await providerLogin(page,user);
 await expect(dialogOf(page)).toContainText(`Signed in as ${user}@acme.test.`,{timeout:30000});
 expect(new URL(page.url()).hash).toBe('');
}
const orgRow=(page,name)=>dialogOf(page).getByRole('list',{name:'Projects on Acme Lab'}).getByRole('listitem').filter({hasText:name});
async function openFromDialog(page,name){await openDialog(page);await orgRow(page,name).getByRole('button',{name:'Open'}).click();await expect(page.locator('.cm-content')).toBeVisible({timeout:30000});}
async function home(page){await page.evaluate(()=>window.scribyra.action('home'));await expect(page.locator('.project-grid')).toBeVisible();}
const source=page=>page.locator('.cm-content');
async function type(page,text){await source(page).click();await page.keyboard.press('ControlOrMeta+Home');await page.keyboard.type(text);await expect(page.locator('.save-indicator')).toHaveText('Saved locally');}
const remoteStatus=page=>page.getByRole('status',{name:'Remote backup'});
async function filesUnder(dir){
 const out=[];
 try{for(const entry of await readdir(dir,{withFileTypes:true,recursive:true}))if(entry.isFile())out.push(await readFile(join(entry.parentPath??entry.path,entry.name)));}catch{}
 return out;
}
/** Every record of this profile's IndexedDB databases, as text and bytes, contains `marker`? */
const deviceHolds=(page,marker)=>page.evaluate(async marker=>{
 const needle=new TextEncoder().encode(marker),found=bytes=>{outer:for(let i=0;i+needle.length<=bytes.length;i++){for(let j=0;j<needle.length;j++)if(bytes[i+j]!==needle[j])continue outer;return true;}return false;};
 const walk=value=>value==null?false:typeof value==='string'?value.includes(marker):value instanceof Uint8Array?found(value):value instanceof ArrayBuffer?found(new Uint8Array(value)):ArrayBuffer.isView(value)?found(new Uint8Array(value.buffer,value.byteOffset,value.byteLength)):typeof value==='object'?Object.values(value).some(walk):false;
 const open=name=>new Promise((ok,fail)=>{const r=indexedDB.open(name);r.onsuccess=()=>ok(r.result);r.onerror=()=>fail(r.error);});
 for(const name of ['scribyra-v1','scribyra-org-server']){
  const db=await open(name);
  try{for(const store of db.objectStoreNames){const all=await new Promise((ok,fail)=>{const r=db.transaction(store).objectStore(store).getAll();r.onsuccess=()=>ok(r.result);r.onerror=()=>fail(r.error);});if(all.some(walk))return `${name}/${store}`;}}
  finally{db.close();}
 }
 return '';
},marker);

test('a server-readable project: added, shared by email, opened and edited by a colleague, live and offline, and unreadable at rest',async({browser},info)=>{
 const s=await serverService({shortcuts:false});const contexts=[];
 try{
  const ana=await profile(browser,info);contexts.push(ana.context);
  await personal(ana.page,'Server paper','SR_PAPER');
  // Ana signs in and adds a copy of her personal project to the deployment.
  await signIn(ana.page,s,'ana');
  const dialog=dialogOf(ana.page);
  await expect(dialog.getByRole('list',{name:'Projects on Acme Lab'})).toContainText('No projects yet.');
  await dialog.getByRole('list',{name:'Projects only on this device'}).getByRole('listitem').filter({hasText:'Server paper'}).getByRole('button',{name:'Add to Acme Lab'}).click();
  await expect(dialog.getByRole('status')).toContainText('Added a copy of Server paper to Acme Lab.');
  await expect(orgRow(ana.page,'Server paper')).toContainText('Synced',{timeout:30000});
  // She invites Ben by email before he ever signed in: the invitation waits for him.
  await orgRow(ana.page,'Server paper').getByRole('button',{name:'Share'}).click();
  await orgRow(ana.page,'Server paper').getByRole('textbox',{name:'Email'}).fill('ben@acme.test');
  await orgRow(ana.page,'Server paper').getByRole('combobox',{name:'Role'}).selectOption('editor');
  await orgRow(ana.page,'Server paper').getByRole('button',{name:'Invite'}).click();
  await expect(dialog.getByRole('status')).toContainText('Ask them to sign in to Acme Lab’s Scribyra');
  await expect(orgRow(ana.page,'Server paper').getByRole('list',{name:'Pending invitations'})).toContainText('ben@acme.test');

  // Ben signs in in his own profile: the project is in his list; Open downloads it, image included.
  const ben=await profile(browser,info);contexts.push(ben.context);
  await signIn(ben.page,s,'ben');
  await expect(orgRow(ben.page,'Server paper')).toContainText('Not on this device · Editor');
  await openFromDialog(ben.page,'Server paper');
  await expect(source(ben.page)).toContainText('SR_PAPER_START');
  await ben.page.locator('.file-row').filter({hasText:'figure.png'}).locator('.file-open').click();
  await expect(ben.page.locator('.asset-preview')).toBeVisible();
  await expect.poll(()=>ben.page.locator('.asset-preview').evaluate(img=>img.complete&&img.naturalWidth)).toBe(1);
  await ben.page.locator('.file-row').filter({hasText:'main.tex'}).locator('.file-open').click();
  await expect(ben.page.getByRole('combobox',{name:'Editor mode'})).toHaveValue('editing');
  // Ana's list now names Ben as an editor (the invitation became a share at his sign-in).
  await orgRow(ana.page,'Server paper').getByRole('button',{name:'Share'}).click();
  await orgRow(ana.page,'Server paper').getByRole('button',{name:'Share'}).click();
  await expect(orgRow(ana.page,'Server paper').getByRole('list',{name:'People with access'})).toContainText('ben@acme.test',{timeout:30000});

  // Live: Ben's edit appears in Ana's open editor without a reload.
  await openFromDialog(ana.page,'Server paper');
  await type(ben.page,'% FROM_BEN_LIVE\n');
  await expect(source(ana.page)).toContainText('% FROM_BEN_LIVE',{timeout:60000});
  await expect(remoteStatus(ana.page)).toHaveText('Synced',{timeout:30000});
  // Offline on both sides, then back: both edits reach both, with identical text.
  await ana.context.setOffline(true);await ben.context.setOffline(true);
  await type(ana.page,'% ANA_OFFLINE\n');
  await type(ben.page,'% BEN_OFFLINE\n');
  await ben.context.setOffline(false);await ana.context.setOffline(false);
  for(const page of [ana.page,ben.page]){
   await expect(source(page)).toContainText('% ANA_OFFLINE',{timeout:90000});
   await expect(source(page)).toContainText('% BEN_OFFLINE',{timeout:90000});
  }
  await expect.poll(async()=>(await source(ana.page).textContent())===(await source(ben.page).textContent()),{timeout:30000}).toBe(true);

  // As a viewer Ben can read but not edit.
  await home(ana.page);await openDialog(ana.page);
  await orgRow(ana.page,'Server paper').getByRole('button',{name:'Share'}).click();
  await orgRow(ana.page,'Server paper').getByRole('combobox',{name:'Role for ben@acme.test'}).selectOption('viewer');
  await expect(dialog.getByRole('status')).toContainText('ben@acme.test is now viewer.');
  await home(ben.page);await openDialog(ben.page);
  await expect(orgRow(ben.page,'Server paper')).toContainText('Viewer',{timeout:30000});
  await openFromDialog(ben.page,'Server paper');
  await expect(ben.page.getByRole('combobox',{name:'Editor mode'})).toHaveValue('viewing');
  await expect(ben.page.locator('select[aria-label="Editor mode"] option[value="editing"]')).toHaveJSProperty('disabled',true);
  const before=await source(ben.page).textContent();
  await source(ben.page).click();await ben.page.keyboard.type('VIEWER_TYPED');
  await expect(source(ben.page)).not.toContainText('VIEWER_TYPED');expect(await source(ben.page).textContent()).toBe(before);

  // Sealed at rest: nothing either of them typed, nor the image's marker, in the database or blob files.
  const dump=(await pgDump(s.database)).toString();expect(dump).toContain('sr_entries');
  const blobs=await filesUnder(s.config.data);expect(blobs.length).toBeGreaterThan(0);
  for(const marker of ['SR_PAPER_START','SR_PAPER_IMAGE','FROM_BEN_LIVE','ANA_OFFLINE','BEN_OFFLINE']){
   expect(dump.includes(marker)||dump.includes(Buffer.from(marker).toString('hex')),marker).toBe(false);
   for(const bytes of blobs)expect(bytes.includes(Buffer.from(marker)),marker).toBe(false);
  }
 }finally{for(const c of contexts)await c.close().catch(()=>{});await s.close();}
});

test('an online-only deployment pauses editing offline and leaves no copy on the device after sign-out',async({browser},info)=>{
 const s=await serverService({shortcuts:false,deployment:{offline:false}});const contexts=[];
 try{
  const ana=await profile(browser,info);contexts.push(ana.context);
  await personal(ana.page,'Online paper','SR_ONLINE');
  await signIn(ana.page,s,'ana');
  const dialog=dialogOf(ana.page);
  await expect(dialog).toContainText('Acme Lab keeps projects online only');
  await dialog.getByRole('list',{name:'Projects only on this device'}).getByRole('listitem').filter({hasText:'Online paper'}).getByRole('button',{name:'Add to Acme Lab'}).click();
  await expect(orgRow(ana.page,'Online paper')).toContainText('Synced',{timeout:30000});
  await openFromDialog(ana.page,'Online paper');
  await type(ana.page,'% SR_ONLINE_TYPED\n');
  await expect(remoteStatus(ana.page)).toHaveText('Synced',{timeout:30000});
  // Offline: editing pauses with the design's sentence, and typing changes nothing.
  await ana.context.setOffline(true);
  await expect(remoteStatus(ana.page)).toHaveText('Reconnecting — editing is paused because Acme Lab keeps projects online only.',{timeout:40000});
  await expect(source(ana.page)).toHaveAttribute('aria-readonly','true');
  const before=await source(ana.page).textContent();
  await source(ana.page).click();await ana.page.keyboard.type('TYPED_WHILE_PAUSED');
  expect(await source(ana.page).textContent()).toBe(before);
  // Back online: editing resumes.
  await ana.context.setOffline(false);
  await expect(remoteStatus(ana.page)).toHaveText('Synced',{timeout:60000});
  await expect(source(ana.page)).not.toHaveAttribute('aria-readonly','true');
  const copies=await ana.page.evaluate(async()=>{const r=indexedDB.open('scribyra-org-server');const db=await new Promise(ok=>{r.onsuccess=()=>ok(r.result);});const links=await new Promise(ok=>{const q=db.transaction('links').objectStore('links').getAll();q.onsuccess=()=>ok(q.result);});db.close();return links.map(l=>l.localId);});
  expect(copies.length).toBe(1);
  expect(await deviceHolds(ana.page,'SR_ONLINE_TYPED')).not.toBe('');
  // Sign out: the session is revoked and the organisation copy leaves this device; the personal original stays.
  await openDialog(ana.page);
  await dialog.getByRole('button',{name:'Sign out'}).click();
  await expect(dialog.getByRole('button',{name:'Sign in with Acme account again'})).toBeVisible({timeout:30000});
  await expect(ana.page.locator('.project-grid')).toBeVisible();
  expect(await s.sql("SELECT count(*) FROM sso_logins WHERE revoked")).toBe('1');
  await dialog.getByRole('button',{name:'Close remote backup'}).click();
  await expect(ana.page.locator('.project-card').filter({hasText:'Online paper'})).toHaveCount(1);
  expect(await ana.page.evaluate(async id=>(await (await import('/org-harness.js')).storage.listProjects()).some(p=>p.id===id),copies[0])).toBe(false);
  expect(await deviceHolds(ana.page,'SR_ONLINE_TYPED')).toBe('');
 }finally{for(const c of contexts)await c.close().catch(()=>{});await s.close();}
});
