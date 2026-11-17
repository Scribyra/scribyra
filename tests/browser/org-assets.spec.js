// Encrypted assets and history objects (org-sync slice 6) in the real app, across browser
// profiles: a project with images and a named version taken before its figure was replaced is
// backed up, downloaded by a colleague (a damaged file is refused and fetched again), synced when
// a new image is added, and restored on a fresh profile with the old version intact. A full
// organisation keeps local saving working and says backup is waiting.
import {test,expect} from '@playwright/test';
import {readFile,readdir} from 'node:fs/promises';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {build} from 'esbuild';
import {service,orgCreate} from '../helpers/service.mjs';

let bundle;
async function harness(page){
 bundle??=(await build({stdin:{resolveDir:process.cwd(),contents:`import init from './web/pkg/scribyra_app.js';import {initializeCollaborationSchema} from './web/collaboration-schema.js';await init({module_or_path:'/org-harness.wasm'});initializeCollaborationSchema();export * as Y from 'yjs';export * as model from './web/model.js';export * as storage from './web/storage.js';export * as assets from './web/assets.js';export * as history from './web/history-storage.js';`},bundle:true,write:false,format:'esm',platform:'browser',loader:{'.css':'empty'}})).outputFiles[0].text;
 await page.route('**/org-harness.js',r=>r.fulfill({contentType:'text/javascript',body:bundle}));
 await page.route('**/org-harness.wasm',async r=>r.fulfill({contentType:'application/wasm',body:await readFile('web/pkg/scribyra_app_bg.wasm')}));
}
async function profile(browser,info){
 const context=await browser.newContext({serviceWorkers:'block'});
 if(info.project.name==='chromium')await context.grantPermissions(['local-network-access']).catch(()=>{});
 const page=await context.newPage();await harness(page);await page.goto('/');
 return{context,page};
}
/** The same PNG-looking bytes in the page and in the test: a header, a marker, a pattern. */
const image=(marker,size=4096)=>{const bytes=new Uint8Array(size);bytes.set([137,80,78,71,13,10,26,10]);bytes.set(new TextEncoder().encode(marker),8);for(let i=9+marker.length;i<size;i++)bytes[i]=(i*31)&255;return bytes;};
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const dialogOf=page=>page.getByRole('dialog',{name:'Remote backup'});
async function saveKit(page){
 const dialog=dialogOf(page),kit=dialog.getByLabel('Recovery kit',{exact:true}).and(page.locator('pre'));
 await expect(kit).toContainText('scribyra-recovery:1:');
 const text=await kit.textContent();
 await dialog.getByRole('checkbox',{name:'I have saved my recovery kit somewhere safe'}).check();
 await dialog.getByRole('button',{name:'Done'}).click();
 return text;
}
async function connect(page,setup,owner){
 await page.getByRole('button',{name:'Remote backup',exact:true}).click();
 const dialog=dialogOf(page);
 await dialog.getByRole('textbox',{name:'Setup code'}).fill(setup);
 await dialog.getByRole('textbox',{name:'Organisation name'}).fill('Acme Lab');
 await dialog.getByRole('textbox',{name:'Your name',exact:true}).fill(owner);
 await dialog.getByRole('button',{name:'Connect'}).click();
 return saveKit(page);
}
/** What a profile holds for a project: its current figures and its named versions' figures. */
async function figures(page,name){
 return page.evaluate(async name=>{
  const {storage,assets,history,model}=await import('/org-harness.js'),decode=bytes=>{const end=bytes.indexOf(0,8);return new TextDecoder().decode(bytes.subarray(8,end));};
  const project=(await storage.listProjects()).find(p=>p.name===name);if(!project)return null;
  const doc=await storage.loadProject(project.id),out={current:{},versions:{}};
  try{
   for(const node of model.projectNodes(doc).filter(n=>n.binary))out.current[node.path]=decode(assets.assetBytes(doc,node.id));
   const data=await storage.readHistoryData(project.id),inv=history.inventory(data);
   for(const item of inv.items.filter(i=>i.versionId)){
    if(!item.available){out.versions[item.label]='unavailable';continue;}
    const opened=history.openVersion(data,inv,item.checkpointRef);
    try{out.versions[item.label]=Object.fromEntries(model.projectNodes(opened.doc).filter(n=>n.binary).map(n=>[n.path,decode(assets.assetBytes(opened.doc,n.id))]));}finally{opened.doc.destroy();}
   }
  }finally{doc.destroy();}
  return out;
 },name);
}
async function filesUnder(dir){
 const out=[];
 for(const entry of await readdir(dir,{withFileTypes:true,recursive:true}))if(entry.isFile())out.push(await readFile(join(entry.parentPath??entry.path,entry.name)));
 return out;
}

test('images and named versions back up encrypted, reach a colleague (a damaged file is refused and fetched again), sync, and restore on a fresh profile',async({browser},info)=>{
 const s=await service({org:true});const contexts=[];
 try{
  const ana=await profile(browser,info);contexts.push(ana.context);
  await ana.page.evaluate(async()=>{
   const image=(marker,size=4096)=>{const bytes=new Uint8Array(size);bytes.set([137,80,78,71,13,10,26,10]);bytes.set(new TextEncoder().encode(marker),8);for(let i=9+marker.length;i<size;i++)bytes[i]=(i*31)&255;return bytes;},{Y,model,storage,assets,history}=await import('/org-harness.js'),doc=new Y.Doc(),id='org-figures';
   const [,figure]=model.addEntries(doc,[{path:'main.tex',content:'\\documentclass{article}\n\\begin{document}\nFIGURES_TEXT_MARKER\n\\end{document}\n'},{path:'figure.png',content:image('OLD_FIGURE_MARKER')}]);
   model.migrateProject(doc,id);doc.getMap('meta').set('name','Figures paper');
   let saved=await storage.saveProject(id,doc);Y.applyUpdate(doc,saved.update);
   // Name a version the way History does, then replace the figure.
   const data=await storage.readHistoryData(id),staged=assets.cloneProject(doc),cp=history.checkpoint(staged),versionId=crypto.randomUUID();
   const change=history.recordChange(staged,{id:crypto.randomUUID(),displayName:'Ana'},{kind:'version-name'});
   staged.getMap('versions').set(versionId,{...change.common,id:versionId,label:'Before the new figure',checkpointRef:cp.hash,basedOnChangeIds:cp.manifest.changeIds});
   saved=await storage.commitPrepared(id,data.project.sequence,Y.encodeStateAsUpdate(staged),cp.objects,cp.pins,{history:{catalog:[{checkpointId:cp.manifest.checkpointId,checkpointRef:cp.hash,sequence:data.project.sequence,reason:'named'}]}});
   staged.destroy();Y.applyUpdate(doc,saved.update);
   model.replaceAsset(doc,figure,image('NEW_FIGURE_MARKER'));await storage.saveProject(id,doc);doc.destroy();
   await window.scribyra.action('home');
  });
  const expected={current:{'figure.png':'NEW_FIGURE_MARKER'},versions:{'Before the new figure':{'figure.png':'OLD_FIGURE_MARKER'}}};
  expect(await figures(ana.page,'Figures paper')).toEqual(expected);
  const kit=await connect(ana.page,await orgCreate(s,'figures'),'Ana');
  const dialog=dialogOf(ana.page),row=dialog.getByRole('listitem').filter({hasText:'Figures paper'});
  await row.getByRole('button',{name:'Back up'}).click();
  await expect(row).toContainText(/Backed up remotely|Synced/,{timeout:30000});
  expect(Number(await s.sql('SELECT count(*) FROM project_objects'))).toBeGreaterThanOrEqual(4);

  // Ben joins as an editor of the paper. His first download meets a damaged file: refused.
  await dialog.getByRole('combobox',{name:'Share a project with them'}).selectOption({label:'Figures paper'});
  await dialog.getByRole('combobox',{name:'Their role on it'}).selectOption('editor');
  await dialog.getByRole('button',{name:'Create invitation link'}).click();
  const invitation=await dialog.getByRole('textbox',{name:'Invitation link to send'}).inputValue();
  const ben=await profile(browser,info);contexts.push(ben.context);
  let damage=1;
  await ben.page.route('**/v1/projects/*/objects/*',async route=>{
   if(route.request().method()!=='GET'||damage<=0)return route.fallback();
   damage--;const response=await route.fetch(),bytes=Buffer.from(await response.body());bytes[bytes.length-1]^=1;
   await route.fulfill({response,body:bytes});
  });
  await ben.page.goto(invitation);
  const benDialog=dialogOf(ben.page);
  await benDialog.getByRole('textbox',{name:'Your name for this organisation'}).fill('Ben');
  await benDialog.getByRole('button',{name:'Join'}).click();
  await saveKit(ben.page);
  const offered=benDialog.getByRole('listitem').filter({hasText:'Figures paper'});
  await offered.getByRole('button',{name:'Download'}).click();
  await expect(benDialog.getByRole('status')).toContainText('refused');
  expect(await figures(ben.page,'Figures paper')).toBeNull();
  await offered.getByRole('button',{name:'Download'}).click();
  await expect(benDialog.getByRole('status')).toContainText('Downloaded Figures paper.');
  expect(await figures(ben.page,'Figures paper')).toEqual(expected);

  // Ana adds a second image; it reaches Ben's copy through the service.
  await ana.page.evaluate(async()=>{
   const image=(marker,size=4096)=>{const bytes=new Uint8Array(size);bytes.set([137,80,78,71,13,10,26,10]);bytes.set(new TextEncoder().encode(marker),8);for(let i=9+marker.length;i<size;i++)bytes[i]=(i*31)&255;return bytes;},{model,storage}=await import('/org-harness.js'),doc=await storage.loadProject('org-figures');
   model.addEntries(doc,[{path:'second.png',content:image('SECOND_FIGURE_MARKER')}]);const saved=await storage.saveProject('org-figures',doc);doc.destroy();
   // As another tab's save would: tell the app (the harness has its own copy of the storage module).
   const channel=new BroadcastChannel('scribyra-commits-v1');channel.postMessage({version:1,kind:'head',projectId:'org-figures',sequence:saved.sequence});channel.close();
  });
  await expect.poll(async()=>(await figures(ben.page,'Figures paper'))?.current['second.png'],{timeout:60000}).toBe('SECOND_FIGURE_MARKER');

  // Neither content, names nor plaintext hashes are on the service: database or blob files.
  const hashes=['OLD_FIGURE_MARKER','NEW_FIGURE_MARKER','SECOND_FIGURE_MARKER'].map(m=>sha(image(m)));
  for(const table of ['project_objects','objects','entries','org_events'])
   expect(await s.sql(`SELECT count(*) FROM ${table} t WHERE ${hashes.map(h=>`position('${h}' in t::text) > 0`).join(' OR ')}`)).toBe('0');
  for(const bytes of await filesUnder(s.config.data))for(const marker of ['FIGURE_MARKER','FIGURES_TEXT_MARKER','Before the new figure'])expect(bytes.includes(Buffer.from(marker))).toBe(false);

  // A fresh profile restores Ana's projects from her recovery kit alone, old version included.
  const fresh=await profile(browser,info);contexts.push(fresh.context);
  await fresh.page.getByRole('button',{name:'Remote backup',exact:true}).click();
  const freshDialog=dialogOf(fresh.page);
  await freshDialog.getByRole('textbox',{name:'Recovery kit'}).fill(kit);
  await freshDialog.getByRole('button',{name:'Restore projects'}).click();
  await expect(freshDialog.getByRole('status')).toContainText('Restored 1 project: Figures paper.',{timeout:60000});
  expect(await figures(fresh.page,'Figures paper')).toEqual({...expected,current:{...expected.current,'second.png':'SECOND_FIGURE_MARKER'}});
 }finally{for(const c of contexts)await c.close().catch(()=>{});await s.close();}
});

test('when the organisation’s storage is full, backup waits with a plain message and local saving keeps working',async({browser},info)=>{
 const s=await service({org:true,org_bytes:64*1024});const contexts=[];
 try{
  const ana=await profile(browser,info);contexts.push(ana.context);
  await ana.page.evaluate(async()=>{
   const image=(marker,size=4096)=>{const bytes=new Uint8Array(size);bytes.set([137,80,78,71,13,10,26,10]);bytes.set(new TextEncoder().encode(marker),8);for(let i=9+marker.length;i<size;i++)bytes[i]=(i*31)&255;return bytes;},{Y,model,storage}=await import('/org-harness.js'),doc=new Y.Doc(),id='org-full';
   model.addEntries(doc,[{path:'main.tex',content:'\\documentclass{article}\n\\begin{document}\nFULL\n\\end{document}\n'},{path:'big.png',content:image('BIG_FIGURE_MARKER',200*1024)}]);
   model.migrateProject(doc,id);doc.getMap('meta').set('name','Big figure');await storage.saveProject(id,doc);doc.destroy();await window.scribyra.action('home');
  });
  await connect(ana.page,await orgCreate(s,'full'),'Ana');
  const dialog=dialogOf(ana.page),row=dialog.getByRole('listitem').filter({hasText:'Big figure'});
  await row.getByRole('button',{name:'Back up'}).click();
  await expect(row).toContainText('Waiting to back up',{timeout:30000});
  await expect(row).toContainText('storage on the service is full. Your changes are saved on this device');
  // Editing and saving locally carry on.
  await dialog.getByRole('button',{name:'Close remote backup'}).click();
  await ana.page.locator('.project-card').filter({hasText:'Big figure'}).locator('.card-open').click();
  await ana.page.locator('.cm-content').click();await ana.page.keyboard.press('ControlOrMeta+Home');await ana.page.keyboard.type('% STILL_LOCAL\n');
  await expect(ana.page.locator('.save-indicator')).toHaveText('Saved locally');
  expect(await s.sql('SELECT count(*) FROM project_objects')).toBe('0');
 }finally{for(const c of contexts)await c.close().catch(()=>{});await s.close();}
});
