// Re-keying on removal (org-sync slice 7) in the real app, across browser profiles: three people
// edit a shared project; the owner removes one; the next entries use an epoch the removed
// browser holds no key for; that browser's later upload, injected by a misbehaving service, is
// refused by everyone; and a member whose change waited across the rotation re-encrypts it.
import {test,expect} from '@playwright/test';
import {readFile} from 'node:fs/promises';
import {build} from 'esbuild';
import {orgService} from '../helpers/idp.mjs';
import {create,join as admit,share} from '../helpers/org-browser.mjs';

let bundle;
async function harness(page){
 bundle??=(await build({stdin:{resolveDir:process.cwd(),contents:`import init from './web/pkg/scribyra_app.js';import {initializeCollaborationSchema} from './web/collaboration-schema.js';await init({module_or_path:'/org-harness.wasm'});initializeCollaborationSchema();export * as Y from 'yjs';export * as model from './web/model.js';export * as storage from './web/storage.js';export * as crypto from './web/org-crypto.js';`},bundle:true,write:false,format:'esm',platform:'browser',loader:{'.css':'empty'}})).outputFiles[0].text;
 await page.route('**/org-harness.js',r=>r.fulfill({contentType:'text/javascript',body:bundle}));
 await page.route('**/org-harness.wasm',async r=>r.fulfill({contentType:'application/wasm',body:await readFile('web/pkg/scribyra_app_bg.wasm')}));
}
async function profile(browser,info){
 const context=await browser.newContext({serviceWorkers:'block'});
 if(info.project.name==='chromium')await context.grantPermissions(['local-network-access']).catch(()=>{});
 const page=await context.newPage();await harness(page);await page.goto('/');
 return{context,page};
}
const dialogOf=page=>page.getByRole('dialog',{name:'Remote backup'});
async function openProject(page,name){
 const open=dialogOf(page);if(await open.isVisible())await open.getByRole('button',{name:'Close remote backup'}).click();
 await page.locator('.project-card').filter({hasText:name}).locator('.card-open').click();
 await expect(page.locator('.cm-content')).toBeVisible();
}
const source=page=>page.locator('.cm-content');
async function type(page,text){await source(page).click();await page.keyboard.press('ControlOrMeta+Home');await page.keyboard.type(text);await expect(page.locator('.save-indicator')).toHaveText('Saved locally');}
/** Everything in one store of this profile's remote-backup database. */
const orgStore=(page,store)=>page.evaluate(store=>new Promise((resolve,reject)=>{
 const open=indexedDB.open('scribyra-org');open.onerror=()=>reject(open.error);
 open.onsuccess=()=>{const db=open.result,request=db.transaction(store).objectStore(store).getAll();request.onsuccess=()=>{db.close();resolve(JSON.parse(JSON.stringify(request.result,(k,v)=>v instanceof Uint8Array?Array.from(v):v)));};request.onerror=()=>reject(request.error);};
}),store);
/** `user` signs in on a new profile, asks to join, is approved by Ana, and gets the paper as an editor. */
async function join(browser,info,s,ana,user){
 const member=await profile(browser,info);
 await admit(member.page,s,user,ana);
 await share(ana,'Rotating paper',`${user}@acme.test`,'editor');
 const dialog=dialogOf(member.page);
 const offered=dialog.getByRole('listitem').filter({hasText:'Rotating paper'});
 await offered.getByRole('button',{name:'Download'}).click();
 await expect(dialog.getByRole('status')).toContainText('Downloaded Rotating paper.');
 await openProject(member.page,'Rotating paper');
 return member;
}
/** Uploads of new entries from this profile never arrive (as if its connection kept dropping). */
const holdUploads=page=>page.route('**/v1/projects/*/log',route=>route.request().method()==='POST'?route.abort('connectionreset'):route.fallback());

test('removing a member rotates the project key; their later uploads are refused even when injected; a waiting change is re-encrypted',async({browser},info)=>{
 const s=await orgService({shortcuts:false});const contexts=[];
 try{
  const ana=await profile(browser,info);contexts.push(ana.context);
  await ana.page.evaluate(async()=>{
   const {Y,model,storage}=await import('/org-harness.js'),doc=new Y.Doc(),id='org-rotating';
   model.addFile(doc,'main.tex','\\documentclass{article}\n\\begin{document}\nROTATING_START\n\\end{document}\n');model.migrateProject(doc,id);doc.getMap('meta').set('name','Rotating paper');
   await storage.saveProject(id,doc);doc.destroy();await window.scribyra.action('home');
  });
  const dialog=dialogOf(ana.page);
  await create(ana.page,s,'ana','Ana');
  const row=dialog.getByRole('listitem').filter({hasText:'Rotating paper'});
  await row.getByRole('button',{name:'Back up'}).click();
  await expect(row).toContainText(/Backed up remotely|Synced/);
  const ben=await join(browser,info,s,ana.page,'ben');contexts.push(ben.context);
  const cat=await join(browser,info,s,ana.page,'cat');contexts.push(cat.context);
  // Three people edit; everyone sees everyone's change.
  await openProject(ana.page,'Rotating paper');
  await type(ben.page,'% FROM_BEN\n');await type(cat.page,'% FROM_CAT\n');await type(ana.page,'% FROM_ANA\n');
  for(const page of [ana.page,ben.page,cat.page])for(const text of ['FROM_ANA','FROM_BEN','FROM_CAT'])await expect(source(page)).toContainText(text,{timeout:60000});
  const project=await s.sql('SELECT project FROM projects');
  expect(await s.sql('SELECT epoch FROM projects')).toBe('1');

  // Ben's and Cat's next changes are sealed (under epoch 1) but their uploads do not arrive.
  await holdUploads(ben.page);await holdUploads(cat.page);
  await type(ben.page,'% BEN_WAITED\n');await type(cat.page,'% CAT_LATE\n');
  for(const page of [ben.page,cat.page])await expect.poll(async()=>(await orgStore(page,'outbox')).length,{timeout:60000}).toBeGreaterThan(0);

  // Ana removes Cat. Her app creates epoch 2 at once, wrapped to Ana's and Ben's keys only.
  await ana.page.evaluate(()=>window.scribyra.action('remote-backup'));
  const members=dialog.getByRole('list',{name:'Members'});
  await members.getByRole('listitem').filter({hasText:'cat@acme.test'}).getByRole('button',{name:'Remove'}).click();
  await expect.poll(()=>s.sql('SELECT epoch FROM projects'),{timeout:60000}).toBe('2');
  const catAgreement=(await orgStore(cat.page,'connection')).find(r=>r?.agreement)?.agreement.publicKey;
  expect(catAgreement).toMatch(/^[0-9a-f]{64}$/);
  expect(await s.sql(`SELECT count(*) FROM wraps WHERE epoch=2 AND recipient='${catAgreement}'`)).toBe('0');
  // The next entry is under epoch 2, which Cat's browser holds no key for.
  await dialog.getByRole('button',{name:'Close remote backup'}).click();
  await type(ana.page,'% ANA_AFTER\n');
  await expect.poll(()=>s.sql('SELECT epoch FROM entries ORDER BY seq DESC LIMIT 1'),{timeout:60000}).toBe('2');
  expect((await orgStore(cat.page,'keys')).filter(k=>k.project===project).map(k=>k.epoch)).toEqual([1]);

  // A misbehaving service injects Cat's late upload into the log, with a valid chain.
  const [late]=await orgStore(cat.page,'outbox'),head=(await s.sql(`SELECT head_seq || ',' || head_chain FROM projects`)).split(',');
  const computed=await ana.page.evaluate(async({body,previous})=>{
   const {crypto}=await import('/org-harness.js'),entry=crypto.verifyEntryBody(Uint8Array.from(body)),hash=crypto.entryHash(entry.headerRaw,entry.ciphertext);
   return{hash,chain:crypto.chainNext(previous,hash),header:entry.header};
  },{body:late.body,previous:head[1]});
  expect(computed.header.epoch).toBe(1);
  const seq=Number(head[0])+1;
  await s.sql(`INSERT INTO entries (project, seq, device, client_seq, epoch, entry_hash, chain, size, inline) VALUES ('${project}', ${seq}, '${computed.header.device}', ${computed.header.clientSeq}, 1, '${computed.hash}', '${computed.chain}', ${late.body.length}, decode('${Buffer.from(late.body).toString('hex')}','hex')); UPDATE projects SET head_seq=${seq}, head_chain='${computed.chain}'`);

  // Ben comes back: his waiting change is refused (409 epoch), re-encrypted under epoch 2 with
  // the same client sequence, and accepted. Everyone keeps syncing; nobody takes Cat's change.
  await ben.page.unroute('**/v1/projects/*/log');
  await ben.context.setOffline(true);await ben.context.setOffline(false);
  for(const page of [ana.page,ben.page])await expect(source(page)).toContainText('BEN_WAITED',{timeout:90000});
  await expect(source(ben.page)).toContainText('ANA_AFTER',{timeout:90000});
  await type(ben.page,'% BEN_LAST\n');
  await expect(source(ana.page)).toContainText('BEN_LAST',{timeout:90000});
  for(const page of [ana.page,ben.page])await expect(source(page)).not.toContainText('CAT_LATE');
  expect(await s.sql(`SELECT count(*) FROM entries WHERE seq > ${seq} AND epoch <> 2`)).toBe('0');
  expect(await s.sql(`SELECT count(*) FROM entries WHERE seq > ${seq}`)).not.toBe('0');
  // The project's status says what was refused.
  await ana.page.evaluate(()=>window.scribyra.action('remote-backup'));
  await expect(dialog.getByRole('listitem').filter({hasText:'Rotating paper'}).locator('.org-state')).toHaveAttribute('title',/change from removed devices/);
 }finally{for(const c of contexts)await c.close().catch(()=>{});await s.close();}
});
