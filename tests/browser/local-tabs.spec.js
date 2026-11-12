import {Client,StreamableHTTPClientTransport} from '@modelcontextprotocol/client';
import {randomUUID} from 'node:crypto';
import {test,expect} from '@playwright/test';
import {readFile} from 'node:fs/promises';
import {zipSync,strToU8,strFromU8,unzipSync} from 'fflate';
import {startCompanion,enableCompanionDev} from '../helpers/companion-server.mjs';
import {openComments} from './review-ui.js';
const main=String.raw`\documentclass{article}\begin{document}Shared public document.\end{document}`;
const bytes=new Uint8Array([1,2,3,4]);
async function imported(page){await page.goto('/');const chooser=page.waitForEvent('filechooser');await page.getByRole('button',{name:'Import ZIP',exact:true}).click();await(await chooser).setFiles({name:'local-tabs-public.zip',mimeType:'application/zip',buffer:Buffer.from(zipSync({'main.tex':strToU8(main),'assets/data.bin':bytes}))});await expect(page.locator('.cm-content')).toBeVisible();}
async function second(context,baseURL){const page=await context.newPage();await page.goto(baseURL);await page.locator('.card-open').first().click();await expect(page.locator('.cm-content')).toBeVisible();return page;}
async function insert(page,text){await page.locator('.cm-content').click();await page.keyboard.press('Control+Home');await page.keyboard.insertText(text+'\n');}
const saved=page=>expect(page.locator('.save-indicator')).toHaveText('Saved locally');
async function exportSources(page){const event=page.waitForEvent('download');await page.getByRole('button',{name:'Export',exact:true}).click();return unzipSync(new Uint8Array(await readFile(await(await event).path())));}
async function menu(page,path,label){await page.getByRole('treeitem',{name:path,exact:true}).locator('..').locator('.file-menu').click();await page.getByRole('menuitem',{name:label,exact:true}).click();}
async function compile(page){await page.evaluate(()=>window.scribyra.lastCompile=null);await page.getByRole('button',{name:'Compile',exact:true}).click();await expect.poll(()=>page.evaluate(()=>!!window.scribyra.lastCompile),{timeout:180000}).toBe(true);const result=await page.evaluate(()=>window.scribyra.lastCompile);expect(result.success,result.log).toBe(true);}
test('live tab edits converge without editing/reloading the receiver, and undo excludes peer changes',async({page,context,baseURL})=>{
 await imported(page);const peer=await second(context,baseURL);try{
  await insert(page,'% Alice');await saved(page);await expect(peer.locator('.cm-content')).toContainText('% Alice');await insert(peer,'% Bob');await saved(peer);await expect(page.locator('.cm-content')).toContainText('% Bob');
  await peer.locator('.cm-content').click();await peer.keyboard.press('Control+z');await expect(peer.locator('.cm-content')).not.toContainText('% Bob');await expect(peer.locator('.cm-content')).toContainText('% Alice');await expect(page.locator('.cm-content')).not.toContainText('% Bob');await saved(peer);
  await Promise.all([insert(page,'% concurrent A'),insert(peer,'% concurrent B')]);for(const tab of [page,peer]){await expect(tab.locator('.cm-content')).toContainText('% concurrent A');await expect(tab.locator('.cm-content')).toContainText('% concurrent B');await saved(tab);}
  const read=()=>page.evaluate(async()=>{const db=await new Promise(r=>{const request=indexedDB.open('scribyra-v1');request.onsuccess=()=>r(request.result);});const tx=db.transaction(['heads','journal']);const all=store=>new Promise(r=>{const q=tx.objectStore(store).getAll();q.onsuccess=()=>r(q.result);});const heads=await all('heads'),journal=await all('journal');db.close();return{sequence:heads.find(h=>!h.deleted).sequence,journal:journal.map(e=>e.sequence).sort((a,b)=>a-b)};});
  const before=await read();await Promise.all([page.evaluate(()=>window.dispatchEvent(new Event('focus'))),peer.evaluate(()=>window.dispatchEvent(new Event('focus')))]);await page.waitForTimeout(350);expect(await read()).toEqual(before);expect(before.journal).toEqual(Array.from({length:before.sequence},(_,i)=>i+1));
  await peer.reload();await peer.locator('.card-open').first().click();await expect(peer.locator('.cm-content')).toContainText('% concurrent A');await expect(peer.locator('.cm-content')).toContainText('% concurrent B');
 }finally{await peer.close();}
});
test('tree changes and verified binary replacements arrive together in other tabs',async({page,context,baseURL})=>{
 await imported(page);const peer=await second(context,baseURL);try{
  await menu(page,'assets','Rename');await page.getByRole('textbox',{name:'Rename folder',exact:true}).fill('figures');await page.keyboard.press('Enter');await expect(peer.getByRole('treeitem',{name:'figures/data.bin',exact:true})).toBeVisible();
  await page.getByRole('treeitem',{name:'figures/data.bin',exact:true}).click();await peer.getByRole('treeitem',{name:'figures/data.bin',exact:true}).click();const replacement=new Uint8Array(65536).fill(71),chooser=page.waitForEvent('filechooser');await page.getByRole('button',{name:'Replace file',exact:true}).click();await(await chooser).setFiles({name:'replacement.bin',mimeType:'application/octet-stream',buffer:Buffer.from(replacement)});await saved(page);await expect(peer.locator('.asset-message')).toContainText('64.0 KiB');expect((await exportSources(peer))['figures/data.bin']).toEqual(replacement);await saved(peer);
  await peer.reload();await peer.locator('.card-open').first().click();expect((await exportSources(peer))['figures/data.bin']).toEqual(replacement);
 }finally{await peer.close();}
});
test('peer deletion revokes paired tools and preserves text/assets in an independently saved recovery copy',async({page,context,baseURL})=>{
 await enableCompanionDev(context);const server=await startCompanion();let peer;try{
  await imported(page);await page.getByRole('button',{name:'More tools',exact:true}).click();await page.getByRole('button',{name:'Rust companion and MCP',exact:true}).click();const dialog=page.getByRole('dialog',{name:'Rust companion and MCP',exact:true});await dialog.getByLabel('Companion address',{exact:true}).fill(server.url);await dialog.getByLabel('Pairing code',{exact:true}).fill(server.code);await dialog.getByRole('button',{name:'Pair companion',exact:true}).click();await expect(dialog.getByRole('status')).toContainText('Connected');await dialog.getByRole('button',{name:'Show MCP connection settings',exact:true}).click();const settings=JSON.parse(await dialog.getByLabel('MCP connection settings',{exact:true}).inputValue());await dialog.getByRole('button',{name:'Close',exact:true}).click();await insert(page,'% Preserve open copy');await saved(page);
  peer=await context.newPage();await peer.goto(baseURL);await peer.getByRole('button',{name:'Project actions',exact:true}).click();await peer.getByRole('menuitem',{name:'Delete project',exact:true}).click();await peer.getByRole('button',{name:'Delete project',exact:true}).click();await expect(page.getByRole('button',{name:'Save recovered copy',exact:true})).toBeVisible();await expect(page.getByRole('status',{name:'Workspace notification',exact:true})).toContainText('deleted in another tab');await expect.poll(async()=>(await fetch(settings.url,{method:'POST',headers:{...settings.headers,'Content-Type':'application/json'},body:'{}'})).status).toBe(401);
  const before=await exportSources(page);expect(strFromU8(before['main.tex'])).toContain('% Preserve open copy');expect(before['assets/data.bin']).toEqual(bytes);await page.getByRole('button',{name:'Save recovered copy',exact:true}).click();await expect(page.getByRole('status',{name:'Workspace notification',exact:true})).toContainText('Recovered copy saved');await saved(page);expect(await exportSources(page)).toEqual(before);await expect(peer.locator('.card-open')).toHaveCount(1);await expect(peer.locator('.project-card')).toContainText('(recovered)');await page.reload();await page.locator('.card-open').first().click();expect(await exportSources(page)).toEqual(before);
 }finally{await peer?.close();await server.close();}
});
test('a tab without BroadcastChannel catches up on resume without an application server',async({page,context,baseURL})=>{
 await imported(page);const peer=await context.newPage();await peer.addInitScript(()=>Object.defineProperty(window,'BroadcastChannel',{value:undefined,configurable:true}));try{
  await peer.goto(baseURL);await peer.locator('.card-open').first().click();await expect(peer.locator('.local-tab-status')).toContainText('polling');await insert(page,'% Missed notification');await saved(page);await peer.bringToFront();await peer.evaluate(()=>window.dispatchEvent(new Event('pageshow')));await expect(peer.locator('.cm-content')).toContainText('% Missed notification');
 }finally{await peer.close();}
});
test('incoming durable changes cannot disguise a failed local save',async({page,context,baseURL})=>{
 await imported(page);const peer=await second(context,baseURL);try{
  await peer.evaluate(()=>{const put=IDBObjectStore.prototype.put;window.restoreTabStorage=()=>IDBObjectStore.prototype.put=put;IDBObjectStore.prototype.put=function(...args){if(this.name==='heads')throw new DOMException('Local disk full','QuotaExceededError');return put.apply(this,args);};});await insert(peer,'% Unsaved local');await expect(peer.locator('.save-indicator')).toHaveText('Not saved · export a backup');await insert(page,'% Durable peer');await saved(page);await expect(peer.locator('.cm-content')).toContainText('% Durable peer');await expect(peer.locator('.cm-content')).toContainText('% Unsaved local');await expect(peer.locator('.save-indicator')).toHaveText('Not saved · export a backup');
  await peer.evaluate(()=>window.restoreTabStorage());await insert(peer,'% Recovered storage');await saved(peer);await expect(page.locator('.cm-content')).toContainText('% Unsaved local');await expect(page.locator('.cm-content')).toContainText('% Recovered storage');await saved(page);
 }finally{await peer.close();}
});
test('peer changes invalidate the current PDF and compile offline from the merged source',async({page,context,baseURL})=>{
 await imported(page);const peer=await second(context,baseURL);try{await compile(page);await context.setOffline(true);await insert(peer,'% Offline peer update');await saved(peer);await expect(page.locator('.cm-content')).toContainText('% Offline peer update');await expect(page.locator('.stale-badge')).toHaveText('Out of date');await compile(page);await expect(page.locator('.stale-badge')).toHaveCount(0);expect(strFromU8((await exportSources(page))['main.tex'])).toContain('% Offline peer update');}finally{await context.setOffline(false);await peer.close();}
});
test('competing binary replacements preserve every version in visible recovery projects',async({page,context,baseURL})=>{
 await imported(page);const peer=await second(context,baseURL);let dashboard;try{
  for(const tab of [page,peer])await tab.getByRole('treeitem',{name:'assets/data.bin',exact:true}).click();const first=page.waitForEvent('filechooser'),secondChoice=peer.waitForEvent('filechooser');await Promise.all([page.getByRole('button',{name:'Replace file',exact:true}).click(),peer.getByRole('button',{name:'Replace file',exact:true}).click()]);await Promise.all([(await first).setFiles({name:'first.bin',mimeType:'application/octet-stream',buffer:Buffer.from([21])}),(await secondChoice).setFiles({name:'second.bin',mimeType:'application/octet-stream',buffer:Buffer.from([31])})]);for(const tab of [page,peer])await saved(tab);
  const current=(await exportSources(page))['assets/data.bin'][0];dashboard=await context.newPage();await dashboard.goto(baseURL);await expect(dashboard.locator('.project-card').filter({hasText:'(binary recovery)'}).first()).toBeVisible();const cards=dashboard.locator('.project-card').filter({hasText:'(binary recovery)'}),count=await cards.count(),versions=new Set([current]);for(let i=0;i<count;i++){await cards.nth(i).locator('.card-open').click();versions.add((await exportSources(dashboard))['assets/data.bin'][0]);await dashboard.getByRole('button',{name:'All projects',exact:true}).click();}expect([...versions].sort()).toEqual([21,31]);
 }finally{await dashboard?.close();await peer.close();}
});

test('native Chromium composition defers peer updates until committed Unicode input is ready',async({page,context,baseURL,browserName})=>{
 test.skip(browserName!=='chromium','Native peer-input composition here uses Chromium CDP; generic deferral is checked independently.');
 await enableCompanionDev(context);const server=await startCompanion();let peer,remote;
 try{
  await imported(page);peer=await second(context,baseURL);await peer.getByRole('button',{name:'More tools',exact:true}).click();await peer.getByRole('button',{name:'Rust companion and MCP',exact:true}).click();const dialog=peer.getByRole('dialog',{name:'Rust companion and MCP',exact:true});await dialog.getByLabel('Companion address',{exact:true}).fill(server.url);await dialog.getByLabel('Pairing code',{exact:true}).fill(server.code);await dialog.getByRole('checkbox',{name:'Edit and create files',exact:true}).check();await dialog.getByRole('button',{name:'Pair companion',exact:true}).click();await expect(dialog.getByRole('status')).toContainText('Connected');await dialog.getByRole('button',{name:'Show MCP connection settings',exact:true}).click();const settings=JSON.parse(await dialog.getByLabel('MCP connection settings',{exact:true}).inputValue());await dialog.getByRole('button',{name:'Close',exact:true}).click();
  remote=new Client({name:'Public local composition peer',version:'1.0.0'},{versionNegotiation:{mode:{pin:'2026-07-28'}}});await remote.connect(new StreamableHTTPClientTransport(new URL(settings.url),{requestInit:{headers:settings.headers}}));
  await page.bringToFront();await page.locator('.cm-content').focus();await page.keyboard.press('Control+Home');const cdp=await context.newCDPSession(page);await cdp.send('Input.imeSetComposition',{text:'にほ',selectionStart:2,selectionEnd:2});await expect(page.locator('.cm-content')).toContainText('にほ');expect(await page.evaluate(()=>window.scribyra.composing())).toBe(true);
  let accepted=false;for(let attempt=0;attempt<3&&!accepted;attempt++){const inspected=(await remote.callTool({name:'inspect_project',arguments:{}})).structuredContent,file=inspected.value.files.find(file=>file.path==='main.tex');const result=await remote.callTool({name:'patch_text',arguments:{projectId:settings.projectId,requestId:randomUUID(),expectedRevision:inspected.revision,edits:[{fileId:file.id,start:0,end:0,before:'',after:'% Committed peer input\n'}]}});if(!result.isError)accepted=true;}expect(accepted).toBe(true);await saved(peer);await page.waitForTimeout(250);expect(await page.evaluate(()=>window.scribyra.composing())).toBe(true);await expect(page.locator('.cm-content')).not.toContainText('% Committed peer input');
  const marker='日本語😀';await cdp.send('Input.insertText',{text:marker});await cdp.send('Input.imeSetComposition',{text:'',selectionStart:0,selectionEnd:0});for(const tab of [page,peer]){await expect(tab.locator('.cm-content')).toContainText(marker);await expect(tab.locator('.cm-content')).toContainText('% Committed peer input');await saved(tab);}const text=strFromU8((await exportSources(page))['main.tex']);expect(text.split(marker)).toHaveLength(2);expect(text).not.toContain('にほ');
 }finally{await remote?.close().catch(()=>{});await peer?.close();await server.close();}
});

// Another tab keeps typing into main.tex until stopped: real keystrokes, in
// short bursts so its debounced local saves reach this tab while it types.
function typist(other){let stopped=false;const done=(async()=>{await other.locator('.cm-content').click();await other.keyboard.press('Control+End');for(let n=1;!stopped;n++){await other.keyboard.insertText(n%10?'xyz':'\n');await other.waitForTimeout(250);}})();return{async stop(){stopped=true;await done;}};}
async function remoteEditsArrive(page,fileId){const length=()=>page.evaluate(fileId=>window.scribyra.agent.readSource({fileId,startLine:1,endLine:200}).value.content.length,fileId);const before=await length();await expect.poll(length).toBeGreaterThan(before+5);}
const notification=page=>page.getByRole('status',{name:'Workspace notification',exact:true});
async function importedWith(page,files){await page.goto('/');const chooser=page.waitForEvent('filechooser');await page.getByRole('button',{name:'Import ZIP',exact:true}).click();await(await chooser).setFiles({name:'local-tabs-typing.zip',mimeType:'application/zip',buffer:Buffer.from(zipSync(files))});await expect(page.locator('.cm-content')).toBeVisible();}
test('typing in another tab keeps tree menus, rename, dialogs, composers, search and History usable',async({page,context,baseURL})=>{
 await importedWith(page,{'main.tex':strToU8(main),'notes.tex':strToU8('alpha notes\n'),'assets/data.bin':bytes});const other=await second(context,baseURL);let typing;try{
  const fileId=await page.evaluate(()=>window.scribyra.agent.readTree().value.items.find(item=>item.path==='main.tex').id);
  typing=typist(other);await remoteEditsArrive(page,fileId);
  // An open file menu stays open, and renaming a different file applies.
  await page.getByRole('treeitem',{name:'notes.tex',exact:true}).locator('..').locator('.file-menu').click();const fileMenu=page.getByRole('menu',{name:'File actions',exact:true});
  await expect(fileMenu).toBeVisible();await remoteEditsArrive(page,fileId);await expect(fileMenu).toBeVisible();
  await fileMenu.getByRole('menuitem',{name:'Rename',exact:true}).click();const field=page.getByRole('textbox',{name:'Rename file',exact:true});await expect(field).toBeVisible();
  await remoteEditsArrive(page,fileId);await expect(field).toBeVisible();await field.fill('chapter.tex');await field.press('Enter');
  await expect(page.getByRole('treeitem',{name:'chapter.tex',exact:true})).toBeVisible();await expect(other.getByRole('treeitem',{name:'chapter.tex',exact:true})).toBeVisible();
  // The very file being typed in renames too: its name and place did not change meanwhile.
  await menu(page,'main.tex','Rename');await expect(field).toBeVisible();await remoteEditsArrive(page,fileId);await field.fill('paper.tex');await field.press('Enter');
  await expect(page.getByRole('treeitem',{name:'paper.tex',exact:true})).toBeVisible();await expect(other.getByRole('treeitem',{name:'paper.tex',exact:true})).toBeVisible();
  // Move through its prompt.
  await menu(page,'chapter.tex','Move');const move=page.getByRole('dialog',{name:'Move file',exact:true});await expect(move).toBeVisible();await remoteEditsArrive(page,fileId);await expect(move).toBeVisible();
  await move.getByRole('textbox',{name:'Move file',exact:true}).fill('assets/chapter.tex');await move.getByRole('button',{name:'Move',exact:true}).click();await expect(page.getByRole('treeitem',{name:'assets/chapter.tex',exact:true})).toBeVisible();
  // Project settings.
  await page.getByRole('button',{name:'More tools',exact:true}).click();await page.getByRole('button',{name:'Project settings',exact:true}).click();const settings=page.getByRole('dialog',{name:'Project settings',exact:true});
  await expect(settings).toBeVisible();await remoteEditsArrive(page,fileId);await expect(settings).toBeVisible();await settings.getByLabel('Project name',{exact:true}).fill('Renamed while another tab types');await settings.getByRole('button',{name:'Save settings',exact:true}).click();
  await expect(page.locator('.project-title')).toHaveText('Renamed while another tab types');await expect(other.locator('.project-title')).toHaveText('Renamed while another tab types');
  // Project search: matches in a file nobody is typing in stay usable and replace.
  await page.getByRole('button',{name:'Search project',exact:true}).click();await page.getByLabel('Replacement text',{exact:true}).fill('omega');await page.getByLabel('Search text',{exact:true}).fill('alpha');await page.getByRole('button',{name:'Run search',exact:true}).click();
  await expect(page.locator('.tool-status')).toContainText('1 matches');await remoteEditsArrive(page,fileId);await expect(page.locator('.tool-status')).toContainText('1 matches');
  await page.getByRole('button',{name:'Review replacements',exact:true}).click();await remoteEditsArrive(page,fileId);await page.getByRole('button',{name:'Apply replacements',exact:true}).click();await expect(notification(page)).toContainText('Replaced 1 matches.');
  await expect.poll(()=>other.evaluate(()=>window.scribyra.agent.readSource({path:'assets/chapter.tex',startLine:1,endLine:5}).value.content)).toContain('omega notes');
  await page.getByRole('button',{name:'Files',exact:true}).click();await page.getByRole('treeitem',{name:'paper.tex',exact:true}).click();
  // Comment and reply composers keep their text and send.
  await page.evaluate(()=>{const view=document.querySelector('.cm-content').cmTile.root.view;view.dispatch({selection:{anchor:0,head:14}});view.focus();});
  await openComments(page);await page.getByRole('button',{name:'Comment on selection',exact:true}).click();const body=page.getByRole('textbox',{name:'Comment body',exact:true});await body.fill('Written while another tab types');
  await remoteEditsArrive(page,fileId);await expect(body).toHaveValue('Written while another tab types');await page.getByRole('button',{name:'Send comment',exact:true}).click();await expect(page.getByRole('status',{name:'Comment status',exact:true})).toHaveText('Saved locally');
  const thread=page.getByRole('region',{name:'Selected comment thread',exact:true});await thread.getByRole('button',{name:'Reply to thread',exact:true}).click();await body.fill('Reply while another tab types');
  await remoteEditsArrive(page,fileId);await expect(body).toHaveValue('Reply while another tab types');await page.getByRole('button',{name:'Send comment',exact:true}).click();await expect(thread).toContainText('Reply while another tab types');
  // History stays open and names a version.
  await page.getByRole('button',{name:'History',exact:true}).click();const history=page.getByRole('region',{name:'Project history',exact:true});await expect(history).toBeVisible();await remoteEditsArrive(page,fileId);await expect(history).toBeVisible();
  await history.getByRole('button',{name:'Name this version',exact:true}).click();await history.getByLabel('Version name').fill('Named while another tab types');await remoteEditsArrive(page,fileId);await expect(history.getByLabel('Version name')).toHaveValue('Named while another tab types');
  await page.keyboard.press('Enter');await expect(history.getByText('Named while another tab types',{exact:true})).toBeVisible();await history.getByRole('button',{name:'Back to editor',exact:true}).click();
  await typing.stop();typing=null;for(const tab of [page,other])await saved(tab);
  expect(Object.keys(await exportSources(page)).sort()).toEqual(['assets/','assets/chapter.tex','assets/data.bin','paper.tex']);
 }finally{await typing?.stop();await other.close();}
});
test('only another tab renaming, moving or deleting the same file refuses, with a clear message',async({page,context,baseURL})=>{
 await imported(page);const other=await second(context,baseURL);try{
  // A move prompt open here while another tab renames that file.
  await menu(page,'assets/data.bin','Move');const move=page.getByRole('dialog',{name:'Move file',exact:true});await expect(move).toBeVisible();
  await menu(other,'assets/data.bin','Rename');await other.getByRole('textbox',{name:'Rename file',exact:true}).fill('other.bin');await other.keyboard.press('Enter');
  await expect(page.getByRole('treeitem',{name:'assets/other.bin',exact:true})).toBeVisible();await expect(move).toBeVisible();
  await move.getByRole('textbox',{name:'Move file',exact:true}).fill('data.bin');await move.getByRole('button',{name:'Move',exact:true}).click();
  await expect(notification(page)).toContainText('Someone else renamed, moved or deleted “assets/data.bin” while you were moving it. Nothing was changed.');
  await expect(page.getByRole('treeitem',{name:'assets/other.bin',exact:true})).toBeVisible();await expect(page.getByRole('treeitem',{name:'data.bin',exact:true})).toHaveCount(0);
  // An inline rename here while another tab moves the same file: the field closes and says why.
  await menu(page,'main.tex','Rename');const field=page.getByRole('textbox',{name:'Rename file',exact:true});await expect(field).toBeVisible();await field.fill('draft.tex');
  await menu(other,'main.tex','Move');const otherMove=other.getByRole('dialog',{name:'Move file',exact:true});await otherMove.getByRole('textbox',{name:'Move file',exact:true}).fill('assets/main.tex');await otherMove.getByRole('button',{name:'Move',exact:true}).click();
  await expect(page.getByRole('treeitem',{name:'assets/main.tex',exact:true})).toBeVisible();await expect(field).toHaveCount(0);
  await expect(notification(page)).toContainText('Someone else renamed, moved or deleted “main.tex” while you were renaming it. Nothing was changed.');
  await expect(page.getByRole('treeitem',{name:'draft.tex',exact:true})).toHaveCount(0);
  // Another tab deletes a folder whose menu is open here: the menu closes rather than offering stale actions.
  await page.getByRole('treeitem',{name:'assets',exact:true}).locator('..').locator('.file-menu').click();const folderMenu=page.getByRole('menu',{name:'Folder actions',exact:true});await expect(folderMenu).toBeVisible();
  await menu(other,'assets','Delete');await other.getByRole('button',{name:'Delete folder',exact:true}).click();await expect(folderMenu).toHaveCount(0);
  for(const tab of [page,other])await saved(tab);
 }finally{await other.close();}
});
// Each race below would, checked only against the file acted on, apply stale state. They refuse instead.
const raceFiles=()=>({'main.tex':strToU8(main),'notes.tex':strToU8('alpha notes\n'),'chap/intro.tex':strToU8('intro text\n'),'assets/data.bin':bytes});
const treePaths=page=>page.evaluate(()=>window.scribyra.agent.readTree().value.items.map(item=>item.path).sort());
async function typeAt(page,path,offset,text){await page.getByRole('treeitem',{name:path,exact:true}).click();await expect(page.getByRole('tab',{name:path,selected:true})).toBeVisible();await page.evaluate(offset=>{const view=document.querySelector('.cm-content').cmTile.root.view;view.dispatch({selection:{anchor:offset}});view.focus();},offset);await page.keyboard.insertText(text);}
test('another tab deleting the file, its destination folder or what a deleted folder holds refuses instead of misplacing it',async({page,context,baseURL})=>{
 await importedWith(page,raceFiles());const other=await second(context,baseURL);try{
  // A rename racing a delete of the same file.
  await menu(page,'notes.tex','Rename');const field=page.getByRole('textbox',{name:'Rename file',exact:true});await field.fill('renamed.tex');
  await menu(other,'notes.tex','Delete');await expect(page.getByRole('treeitem',{name:'notes.tex',exact:true})).toHaveCount(0);
  await expect(notification(page)).toContainText('Someone else renamed, moved or deleted “notes.tex” while you were renaming it. Nothing was changed.');
  await expect(page.getByRole('treeitem',{name:'renamed.tex',exact:true})).toHaveCount(0);
  await other.getByRole('button',{name:'Restore last deletion',exact:true}).click();await expect(page.getByRole('treeitem',{name:'notes.tex',exact:true})).toBeVisible();
  // A move into a folder another tab deletes meanwhile must not bring the folder back with only this file in it.
  await menu(page,'notes.tex','Move');const move=page.getByRole('dialog',{name:'Move file',exact:true});await move.getByRole('textbox',{name:'Move file',exact:true}).fill('chap/notes.tex');
  await menu(other,'chap','Delete');await other.getByRole('button',{name:'Delete folder',exact:true}).click();await expect(page.getByRole('treeitem',{name:'chap',exact:true})).toHaveCount(0);
  await move.getByRole('button',{name:'Move',exact:true}).click();
  await expect(notification(page)).toContainText('Someone else renamed, moved or deleted the folder “chap” while you were choosing it. Nothing was changed.');
  await expect.poll(()=>treePaths(page)).toEqual(['assets','assets/data.bin','main.tex','notes.tex']);
  await other.getByRole('button',{name:'Restore last deletion',exact:true}).click();await expect.poll(()=>treePaths(page)).toEqual(['assets','assets/data.bin','chap','chap/intro.tex','main.tex','notes.tex']);
  // The same for a folder another tab renames: the file must not land in a new, empty “chap”.
  await menu(page,'notes.tex','Move');await move.getByRole('textbox',{name:'Move file',exact:true}).fill('chap/notes.tex');
  await menu(other,'chap','Rename');await other.getByRole('textbox',{name:'Rename folder',exact:true}).fill('part');await other.keyboard.press('Enter');await expect(page.getByRole('treeitem',{name:'part',exact:true})).toBeVisible();
  await move.getByRole('button',{name:'Move',exact:true}).click();await expect(notification(page)).toContainText('the folder “chap” while you were choosing it. Nothing was changed.');
  await expect.poll(()=>treePaths(page)).toEqual(['assets','assets/data.bin','main.tex','notes.tex','part','part/intro.tex']);
  // Deleting a folder whose contents another tab changed after the deletion was confirmed in view.
  await menu(page,'part','Delete');const confirm=page.getByRole('button',{name:'Delete folder',exact:true});await expect(confirm).toBeVisible();
  await menu(other,'part','New file');await other.getByRole('textbox',{name:'New file',exact:true}).fill('part/added.tex');await other.getByRole('button',{name:'Create file',exact:true}).click();
  await expect(page.getByRole('treeitem',{name:'part/added.tex',exact:true})).toBeVisible();await confirm.click();
  await expect(notification(page)).toContainText('Project changed while you were deleting “part”: someone else changed what is inside it. Nothing was changed');
  await expect.poll(()=>treePaths(other)).toEqual(['assets','assets/data.bin','main.tex','notes.tex','part','part/added.tex','part/intro.tex']);
  // A new file in a folder another tab deletes while its name is typed.
  await menu(page,'assets','New file');const name=page.getByRole('textbox',{name:'New file',exact:true});await name.fill('assets/late.tex');
  await menu(other,'assets','Delete');await other.getByRole('button',{name:'Delete folder',exact:true}).click();await expect(page.getByRole('treeitem',{name:'assets',exact:true})).toHaveCount(0);
  await page.getByRole('button',{name:'Create file',exact:true}).click();await expect(notification(page)).toContainText('the folder “assets” while you were choosing it. Nothing was changed.');
  await expect.poll(()=>treePaths(other)).toEqual(['main.tex','notes.tex','part','part/added.tex','part/intro.tex']);
  for(const tab of [page,other])await saved(tab);
 }finally{await other.close();}
});
test('settings, search replacements, new comments and message edits refuse what another tab changed meanwhile',async({page,context,baseURL})=>{
 await importedWith(page,raceFiles());const other=await second(context,baseURL);try{
  // Two tabs renaming the project: the later save refuses instead of silently replacing the first.
  await page.getByRole('button',{name:'More tools',exact:true}).click();await page.getByRole('button',{name:'Project settings',exact:true}).click();const settings=page.getByRole('dialog',{name:'Project settings',exact:true});
  await settings.getByLabel('Project name',{exact:true}).fill('Name from this tab');
  await other.getByRole('button',{name:'More tools',exact:true}).click();await other.getByRole('button',{name:'Project settings',exact:true}).click();const otherSettings=other.getByRole('dialog',{name:'Project settings',exact:true});
  await otherSettings.getByLabel('Project name',{exact:true}).fill('Name from the other tab');await otherSettings.getByRole('button',{name:'Save settings',exact:true}).click();
  await expect(page.locator('.project-title')).toHaveText('Name from the other tab');await settings.getByRole('button',{name:'Save settings',exact:true}).click();
  await expect(notification(page)).toContainText('Project settings: someone else changed the project name while this was open. Nothing was changed; open it again.');
  for(const tab of [page,other])await expect(tab.locator('.project-title')).toHaveText('Name from the other tab');
  // Settings left showing a main file that another tab then deletes refuse whole: the name must not save without it.
  await page.getByRole('button',{name:'More tools',exact:true}).click();await page.getByRole('button',{name:'Project settings',exact:true}).click();
  const mainId=await page.evaluate(()=>window.scribyra.agent.readTree().value.items.find(item=>item.path==='main.tex').id);await expect(settings.getByLabel('Main file',{exact:true})).toHaveValue(mainId);
  await settings.getByLabel('Project name',{exact:true}).fill('Name without its main file');
  await menu(other,'main.tex','Delete');await expect(page.getByRole('treeitem',{name:'main.tex',exact:true})).toHaveCount(0);
  await settings.getByRole('button',{name:'Save settings',exact:true}).click();
  await expect(notification(page)).toContainText('Project changed while project settings was open: someone else deleted the main file it shows. Nothing was changed; open it again.');
  for(const tab of [page,other])await expect(tab.locator('.project-title')).toHaveText('Name from the other tab');
  await other.getByRole('button',{name:'Restore last deletion',exact:true}).click();await expect(page.getByRole('treeitem',{name:'main.tex',exact:true})).toBeVisible();
  await expect.poll(()=>page.evaluate(()=>window.scribyra.agent.status().value.mainFile)).toBe(mainId);
  // A reviewed replacement whose matched file another tab edits refuses and keeps that edit.
  await page.getByRole('button',{name:'Search project',exact:true}).click();await page.getByLabel('Replacement text',{exact:true}).fill('omega');await page.getByLabel('Search text',{exact:true}).fill('alpha');await page.getByRole('button',{name:'Run search',exact:true}).click();
  await expect(page.locator('.tool-status')).toContainText('1 matches');await page.getByRole('button',{name:'Review replacements',exact:true}).click();
  await expect(page.getByRole('button',{name:'Apply replacements',exact:true})).toBeVisible();
  await typeAt(other,'notes.tex',0,'beta ');await expect.poll(()=>page.evaluate(()=>window.scribyra.agent.readSource({path:'notes.tex',startLine:1,endLine:5}).value.content)).toContain('beta alpha notes');
  await page.getByRole('button',{name:'Apply replacements',exact:true}).click();await expect(notification(page)).toContainText('Source changed since this search. Search again before replacing.');
  await expect(page.locator('.tool-status')).toContainText('Source changed. Search again for current results.');
  for(const tab of [page,other])await expect.poll(()=>tab.evaluate(()=>window.scribyra.agent.readSource({path:'notes.tex',startLine:1,endLine:5}).value.content)).toBe('beta alpha notes\n');
  await page.getByRole('button',{name:'Files',exact:true}).click();await page.getByRole('treeitem',{name:'main.tex',exact:true}).click();
  // A comment on text another tab changes inside the selection refuses and keeps the draft.
  const at=main.indexOf('Shared public');await other.getByRole('treeitem',{name:'main.tex',exact:true}).click();
  await page.evaluate(at=>{const view=document.querySelector('.cm-content').cmTile.root.view;view.dispatch({selection:{anchor:at,head:at+13}});view.focus();},at);
  await openComments(page);await page.getByRole('button',{name:'Comment on selection',exact:true}).click();const body=page.getByRole('textbox',{name:'Comment body',exact:true});await body.fill('About “Shared public”');
  await typeAt(other,'main.tex',at+6,' not');await expect.poll(()=>page.evaluate(()=>window.scribyra.agent.readSource({path:'main.tex',startLine:1,endLine:5}).value.content)).toContain('Shared not public');
  await page.getByRole('button',{name:'Send comment',exact:true}).click();await expect(page.getByRole('alert')).toContainText('The text you selected was changed or removed while you wrote this comment.');
  await expect(body).toHaveValue('About “Shared public”');await expect(page.locator('.comment-highlight')).toHaveCount(0);
  // Typing elsewhere still lets a fresh comment through.
  await page.getByRole('button',{name:'Clear draft',exact:true}).click();await expect(body).toHaveValue('');
  await page.evaluate(()=>{const view=document.querySelector('.cm-content').cmTile.root.view,at=view.state.doc.toString().indexOf('public document');view.dispatch({selection:{anchor:at,head:at+15}});view.focus();});
  await page.getByRole('button',{name:'Comment on selection',exact:true}).click();await body.fill('First wording');
  await typeAt(other,'main.tex',0,'% note\n');await expect.poll(()=>page.evaluate(()=>window.scribyra.agent.readSource({path:'main.tex',startLine:1,endLine:1}).value.content)).toContain('% note');
  await page.getByRole('button',{name:'Send comment',exact:true}).click();const thread=page.getByRole('region',{name:'Selected comment thread',exact:true});await expect(thread).toContainText('First wording');
  // Two tabs editing the same message: the later edit refuses rather than replacing the first.
  await expect(thread.getByRole('button',{name:'Edit message',exact:true})).toBeVisible();await thread.getByRole('button',{name:'Edit message',exact:true}).click();await body.fill('Edit from this tab');
  await openComments(other);await other.locator('.comment-thread-link').first().click();const otherThread=other.getByRole('region',{name:'Selected comment thread',exact:true});
  await otherThread.getByRole('button',{name:'Edit message',exact:true}).click();await other.getByRole('textbox',{name:'Comment body',exact:true}).fill('Edit from the other tab');await other.getByRole('button',{name:'Send comment',exact:true}).click();
  await expect(otherThread).toContainText('Edit from the other tab');await expect(thread).toContainText('Edit from the other tab');
  await page.getByRole('button',{name:'Send comment',exact:true}).click();await expect(page.getByRole('alert')).toContainText('Decision heads changed');
  await expect(body).toHaveValue('Edit from this tab');await expect(thread).not.toContainText('Edit from this tab');
  await page.getByRole('button',{name:'Clear draft',exact:true}).click();
  // Drafts are kept per device, so the other tab offers this tab's unsent edit after its own send; clear it there too.
  await expect(other.getByRole('textbox',{name:'Comment body',exact:true})).toHaveValue('Edit from this tab');await other.getByRole('button',{name:'Clear draft',exact:true}).click();
  for(const tab of [page,other])await saved(tab);
 }finally{await other.close();}
});
test('a newer schema fails closed and exports unsaved source before an explicit reload',async({page})=>{
 await imported(page);await saved(page);
 await page.evaluate(async()=>{
  const db=await new Promise(resolve=>{const request=indexedDB.open('scribyra-v1');request.onsuccess=()=>resolve(request.result);});
  await new Promise((resolve,reject)=>{const tx=db.transaction(['heads','projects'],'readwrite'),request=tx.objectStore('heads').getAll();request.onsuccess=()=>{const head=request.result.find(h=>!h.deleted);head.schemaVersion=9;head.sequence++;tx.objectStore('heads').put(head);const project=tx.objectStore('projects').get(head.id);project.onsuccess=()=>tx.objectStore('projects').put({...project.result,schemaVersion:9,sequence:head.sequence});};tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error);});db.close();
  const view=document.querySelector('.cm-content').cmTile.root.view;view.dispatch({changes:{from:0,insert:'UNSAVED BEFORE UPDATE\n'}});window.dispatchEvent(new Event('focus'));
 });
 await expect(page.locator('.local-tab-status')).toHaveText('Reload to update Scribyra');await expect(page.locator('.save-indicator')).not.toHaveText('Saved locally');
 const pending=page.waitForEvent('download');await page.getByRole('button',{name:'Export before updating',exact:true}).click();const archive=unzipSync(new Uint8Array(await readFile(await(await pending).path()))),sources=unzipSync(archive['sources.zip']);expect(strFromU8(sources['main.tex'])).toContain('UNSAVED BEFORE UPDATE');expect(archive['open-project.yjs'].length).toBeGreaterThan(0);
 const dialog=page.getByRole('dialog',{name:'Reload to update',exact:true});await expect(dialog).toContainText('Check that scribyra-before-update.zip is saved');await dialog.getByRole('button',{name:'Cancel',exact:true}).click();await expect(page.locator('.cm-content')).toContainText('UNSAVED BEFORE UPDATE');
});
