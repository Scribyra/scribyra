// Server compile in the real app (design section 6, slice 11), across browser profiles, with a
// server-readable deployment that compiles `both` ways and a worker inside the service (real TeX
// Live and bubblewrap from the dev shell): Ana switches a shared project to "Compile on server"
// and compiles it there without loading the in-browser compiler, and sees the PDF with "Compiled
// on server"; Ben, a viewer in another profile, sees the same PDF appear without reloading and
// cannot start a compile; after Ana edits, the badge says "from an older version" until she
// compiles again; a TeX error shows the server's log to both; switching back to the browser
// compiles in the browser again.
import {test,expect} from '@playwright/test';
import {readFile} from 'node:fs/promises';
import {build} from 'esbuild';
import {compileService} from '../helpers/idp.mjs';
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
 const page=await context.newPage(),compiler=[];
 // Every request for the in-browser compiler's files (BusyTeX), to show when it is not loaded.
 page.on('request',request=>{if(new URL(request.url()).pathname.includes('/core/busytex'))compiler.push(request.url());});
 await harness(page);await page.goto('/');
 return{context,page,compiler};
}
const DOCUMENT='\\documentclass{article}\n\\begin{document}\nFirst server version\n\\end{document}\n';
async function personal(page,name){
 await page.evaluate(async({name,text})=>{
  const {Y,model,storage}=await import('/org-harness.js'),doc=new Y.Doc(),id=crypto.randomUUID();
  const main=crypto.randomUUID();model.addEntries(doc,[{id:main,path:'main.tex',content:text}]);model.migrateProject(doc,id);
  doc.getMap('meta').set('name',name);doc.getMap('meta').set('mainFile',main);
  await storage.saveProject(id,doc);doc.destroy();await window.scribyra.action('home');
 },{name,text:DOCUMENT});
}
const dialogOf=page=>page.getByRole('dialog',{name:'Remote backup'});
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
async function openFromDialog(page,name){await openDialog(page);await orgRow(page,name).getByRole('button',{name:'Open'}).click();await expect(page.locator('.cm-content')).toBeVisible({timeout:30000});}
async function home(page){await page.evaluate(()=>window.scribyra.action('home'));await expect(page.locator('.project-grid')).toBeVisible();}
async function shareBox(page,name){
 await openDialog(page);const row=orgRow(page,name);
 if(!(await row.getByRole('group',{name:'Compile'}).isVisible()))await row.getByRole('button',{name:'Share'}).click();
 await expect(row.getByRole('group',{name:'Compile'})).toBeVisible({timeout:30000});
 return row;
}
const source=page=>page.locator('.cm-content');
const compileButton=page=>page.locator('.compile-button');
const badge=page=>page.getByRole('status',{name:'Server PDF'});
const status=page=>page.getByRole('status',{name:'Compilation status'});
const pdfText=page=>page.locator('.page[data-page-number="1"] .textLayer');
const BADGE=/^Compiled on server · \d{1,2} [A-Z][a-z]{2} \d\d:\d\d · /;
// The xelatex/lualatex runs on a loaded host take long; nothing below waits less than this for a compile.
const COMPILE=600000;
async function typeAt(page,keys,text){await source(page).click();for(const key of keys)await page.keyboard.press(key);await page.keyboard.type(text);await expect(page.locator('.save-indicator')).toHaveText('Saved locally');}

test('server compile: the project switch, the PDF in a viewer’s app, older versions, TeX errors and back to the browser',async({browser},info)=>{
 test.setTimeout(3600000);
 const s=await compileService();const contexts=[];
 try{
  const ana=await profile(browser,info);contexts.push(ana.context);
  await personal(ana.page,'Compiled paper');
  await signIn(ana.page,s,'ana');
  const dialog=dialogOf(ana.page);
  await dialog.getByRole('list',{name:'Projects only on this device'}).getByRole('listitem').filter({hasText:'Compiled paper'}).getByRole('button',{name:'Add to Acme Lab'}).click();
  await expect(orgRow(ana.page,'Compiled paper')).toContainText('Synced',{timeout:60000});
  // Ana shares it with Ben as a viewer and switches it to compile on the server.
  let row=await shareBox(ana.page,'Compiled paper');
  await row.getByRole('textbox',{name:'Email'}).fill('ben@acme.test');
  await row.getByRole('combobox',{name:'Role'}).selectOption('viewer');
  await row.getByRole('button',{name:'Invite'}).click();
  await expect(dialog.getByRole('status')).toContainText('Ask them to sign in to Acme Lab’s Scribyra');
  row=await shareBox(ana.page,'Compiled paper');
  await expect(row.getByRole('radio',{name:'Compile in the browser'})).toBeChecked();
  await row.getByRole('radio',{name:'Compile on server'}).check();
  await expect(dialog.getByRole('status')).toContainText('Compiled paper now compiles on Acme Lab’s server.');
  await expect(row.getByRole('radio',{name:'Compile on server'})).toBeChecked();

  // Ben signs in in his own profile and opens the project: he may read the PDF but not compile.
  const ben=await profile(browser,info);contexts.push(ben.context);
  await signIn(ben.page,s,'ben');
  await expect(orgRow(ben.page,'Compiled paper')).toContainText('Viewer');
  const benRow=await shareBox(ben.page,'Compiled paper');
  await expect(benRow.getByRole('radio',{name:'Compile on server'})).toBeChecked();
  await expect(benRow.getByRole('radio',{name:'Compile on server'})).toBeDisabled();
  await expect(benRow).toContainText('This project compiles on the server. Its owner and editors choose.');
  await openFromDialog(ben.page,'Compiled paper');
  await expect(compileButton(ben.page)).toContainText('Compile on server');
  await expect(compileButton(ben.page)).toBeDisabled();
  await expect(ben.page.getByRole('button',{name:/^Compile on server/})).toHaveAttribute('title','Your role on this project lets you read its PDF but not compile it');

  // Ana compiles on the server: the in-browser compiler is never fetched.
  await openFromDialog(ana.page,'Compiled paper');
  await expect(ana.page.getByRole('button',{name:/^Compile on server/})).toBeEnabled();
  await ana.page.getByRole('button',{name:/^Compile on server/}).click();
  await expect(status(ana.page)).toHaveText(/^Compiled on server · 1 page/,{timeout:COMPILE});
  await expect(badge(ana.page)).toHaveText(new RegExp(BADGE.source+'from your latest changes$'));
  await expect(pdfText(ana.page)).toContainText('First server version');
  expect(ana.compiler).toEqual([]);
  // Ben's open project shows the same PDF without a reload.
  await expect(pdfText(ben.page)).toContainText('First server version',{timeout:120000});
  await expect(badge(ben.page)).toHaveText(new RegExp(BADGE.source+'from your latest changes$'));
  expect(ben.compiler).toEqual([]);
  const kept=page=>page.evaluate(()=>new Promise((ok,fail)=>{const r=indexedDB.open('scribyra-org-server');r.onerror=()=>fail(r.error);r.onsuccess=()=>{const q=r.result.transaction('pdfs').objectStore('pdfs').getAll();q.onsuccess=()=>{r.result.close();ok(q.result.map(p=>({job:p.job,bytes:p.bytes.length})));};q.onerror=()=>fail(q.error);};}));
  const anaPdf=await kept(ana.page);expect(anaPdf).toHaveLength(1);expect(anaPdf[0].bytes).toBeGreaterThan(1000);
  await expect.poll(()=>kept(ben.page)).toEqual(anaPdf);

  // Ana edits: the PDF is from an older version until she compiles again; Ben gets the new one.
  await typeAt(ana.page,['ControlOrMeta+Home','ArrowDown','ArrowDown','Home'],'Second ');
  await expect(badge(ana.page)).toHaveText(new RegExp(BADGE.source+'from an older version$'));
  await expect(badge(ana.page)).toHaveAttribute('data-stale','true');
  await ana.page.getByRole('button',{name:/^Compile on server/}).click();
  await expect(badge(ana.page)).toHaveText(new RegExp(BADGE.source+'from your latest changes$'),{timeout:COMPILE});
  await expect(pdfText(ana.page)).toContainText('Second');
  await expect(pdfText(ben.page)).toContainText('Second',{timeout:120000});
  await expect(badge(ben.page)).toHaveText(new RegExp(BADGE.source+'from your latest changes$'));

  // A TeX error: the server's log shows in the compile log UI; Ben sees that it failed.
  await typeAt(ana.page,['ControlOrMeta+Home'],'\\undefinedservermacro\n');
  await ana.page.getByRole('button',{name:/^Compile on server/}).click();
  await expect(status(ana.page)).toHaveText(/^Failed on server · /,{timeout:COMPILE});
  const log=ana.page.getByRole('region',{name:'Raw compilation log'});
  await expect(log).toContainText('Undefined control sequence');
  await expect(log).toContainText('\\undefinedservermacro');
  await expect(status(ben.page)).toHaveText(/^Failed on server · /,{timeout:120000});
  await expect(pdfText(ben.page)).toContainText('Second');
  expect(ana.compiler).toEqual([]);

  // Back to the browser: the button says "Compile" (for Ben too) and the in-browser compiler runs.
  await typeAt(ana.page,['ControlOrMeta+Home','Shift+ArrowDown'],'');
  await ana.page.keyboard.press('Delete');await expect(source(ana.page)).not.toContainText('undefinedservermacro');
  await expect(ana.page.locator('.save-indicator')).toHaveText('Saved locally');
  await home(ana.page);
  row=await shareBox(ana.page,'Compiled paper');
  await row.getByRole('radio',{name:'Compile in the browser'}).check();
  await expect(dialog.getByRole('status')).toContainText('Compiled paper now compiles in the browser.');
  await expect(compileButton(ben.page)).not.toContainText('on server',{timeout:120000});
  await expect(compileButton(ben.page)).toBeEnabled();
  await openFromDialog(ana.page,'Compiled paper');
  await expect(compileButton(ana.page)).toHaveText(/^Compile(Ctrl|⌘)/);
  await compileButton(ana.page).click();
  await expect(status(ana.page)).toHaveText(/^Compiled · [\d.]+ s · 1 page/,{timeout:COMPILE});
  expect(ana.compiler.length).toBeGreaterThan(0);
  await expect(badge(ana.page)).toHaveCount(0);
  await expect(pdfText(ana.page)).toContainText('Second');
 }finally{
  for(const context of contexts)await context.close().catch(()=>{});
  await s.close();
 }
});
