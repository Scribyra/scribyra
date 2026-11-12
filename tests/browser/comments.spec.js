import {openComments} from './review-ui.js';
import {test,expect} from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import {build} from 'esbuild';
import {readFile} from 'node:fs/promises';
import {zipSync,strToU8} from 'fflate';
const source=String.raw`\documentclass{article}\begin{document}alpha selected omega.\end{document}`;
const selected=source.indexOf('selected');
let harness,wasm;
test.beforeAll(async()=>{
 const result=await build({stdin:{resolveDir:process.cwd(),contents:`
 import init from './web/pkg/scribyra_app.js';
 import {initializeCollaborationSchema} from './web/collaboration-schema.js';
 await init({module_or_path:'/comments-harness.wasm'});initializeCollaborationSchema();
 import * as Y from 'yjs';import * as model from './web/model.js';import * as storage from './web/storage.js';
 import {EditorView} from '@codemirror/view';import {anchors} from './web/comment-anchors.js';
 import {registerComments,discussion,mount} from './web/comments.js';import {changeOrigins} from './web/change-origins.js';
 import {collaborationCommands} from './web/collaboration-commands.js';
 export {Y,model,storage,EditorView,anchors,registerComments,discussion,mount,changeOrigins,collaborationCommands};
 export function fixture(doc=new Y.Doc(),person={id:crypto.randomUUID(),kind:'human',displayName:'Browser author'},origins){
  const id=[...doc.getMap('files').keys()][0]||model.addFile(doc,'main.tex','abc😀def selected tail');
  const commands=collaborationCommands({doc,projectId:'fixture'}),service=registerComments({doc,commands,author:person,origins});
  const request=command=>({version:2,requestId:crypto.randomUUID(),projectId:'fixture',expectedRevision:commands.revision(),command});
  const execute=command=>commands.execute(request(command));
  const run=command=>{const reply=execute(command);if(!reply.ok)throw new Error(JSON.stringify(reply.error));return reply.value;};
  return{doc,id,person,commands,service,run,execute,request,create:()=>run({op:'thread.create',fileId:id,start:9,end:17,body:'Browser thread'}),close(){service.close();commands.close();doc.destroy();}};
 }
 export function select(start,end){const view=EditorView.findFromDOM(document.querySelector('.cm-editor'));view.dispatch({selection:{anchor:start,head:end},scrollIntoView:true});view.focus();}
 `},bundle:true,format:'esm',platform:'browser',write:false,loader:{'.css':'empty'}});
 harness=result.outputFiles[0].text;wasm=await readFile('web/pkg/scribyra_app_bg.wasm');
});
async function routes(page){
 await page.route('**/comments-harness.js',route=>route.fulfill({contentType:'text/javascript',body:harness}));
 await page.route('**/comments-harness.wasm',route=>route.fulfill({contentType:'application/wasm',body:wasm}));
}
async function start(page){await routes(page);await page.goto('/');}
async function imported(page){
 await page.goto('/');const chooser=page.waitForEvent('filechooser');await page.getByRole('button',{name:'Import ZIP',exact:true}).click();await(await chooser).setFiles({name:'comments-public.zip',mimeType:'application/zip',buffer:Buffer.from(zipSync({'main.tex':strToU8(source)}))});await expect(page.locator('.cm-content')).toBeVisible();
}
async function select(page,start=selected,end=selected+8){await page.evaluate(({start,end})=>{const view=document.querySelector('.cm-content').cmTile.root.view;view.dispatch({selection:{anchor:start,head:end},scrollIntoView:true});view.focus();},{start,end});}
async function create(page,body='A plain comment'){
 await select(page);await openComments(page);await page.getByRole('button',{name:'Comment on selection',exact:true}).click();await page.getByRole('textbox',{name:'Comment body',exact:true}).fill(body);await page.getByRole('button',{name:'Send comment',exact:true}).click();await expect(page.getByRole('status',{name:'Comment status',exact:true})).toHaveText('Saved locally');
}
const detail=page=>page.getByRole('region',{name:'Selected comment thread',exact:true});
const saved=page=>expect(page.locator('.save-indicator')).toHaveText('Saved locally');
async function audit(page){const result=await new AxeBuilder({page}).include('.comments-panel').withTags(['wcag2a','wcag2aa','wcag21a','wcag21aa']).analyze();expect(result.violations.map(v=>({id:v.id,nodes:v.nodes.map(n=>n.failureSummary)}))).toEqual([]);}

test.describe('contract and same-profile fixtures',()=>{
 test.use({serviceWorkers:'block'});
test('Unicode anchors exclude prepend and boundary insertions, include interior edits, narrow, and detach on identical replacement',async({page})=>{
 await start(page);const r=await page.evaluate(async()=>{
  const {fixture,anchors}=await import('/comments-harness.js'),f=fixture(),text=f.doc.getText(`text:${f.id}`);
  const anchor=anchors.capture(f.doc,f.id,3,8);let scalarRejected=false;try{anchors.capture(f.doc,f.id,4,5);}catch{scalarRejected=true;}
  text.insert(0,'prepend ');text.insert(11,'L');text.insert(17,'R');const boundaries=anchors.resolve(f.doc,anchor);
  text.insert(14,'inside');const interior=anchors.resolve(f.doc,anchor),interiorText=text.toString().slice(interior.start,interior.end);
  text.delete(12,2);const partial=anchors.resolve(f.doc,anchor),partialText=text.toString().slice(partial.start,partial.end);
  text.delete(partial.start,partial.end-partial.start);text.insert(partial.start,partialText);const identical=anchors.resolve(f.doc,anchor);f.close();return{scalarRejected,boundaries,interiorText,partialText,identical};
 });expect(r.scalarRejected).toBe(true);expect(r.boundaries).toEqual({status:'attached',start:12,end:17});expect(r.interiorText).toBe('😀insidedef');expect(r.partialText).toBe('def');expect(r.identical).toEqual({status:'detached',reason:'selection_deleted'});
});
test('points bind their right character, EOF remains EOF, and empty files support points',async({page})=>{
 await start(page);const r=await page.evaluate(async()=>{
  const {fixture,anchors,model}=await import('/comments-harness.js'),f=fixture(),text=f.doc.getText(`text:${f.id}`),point=anchors.capture(f.doc,f.id,5,5),eof=anchors.capture(f.doc,f.id,text.length,text.length);
  text.insert(5,'X');const moved=anchors.resolve(f.doc,point);text.delete(6,1);const deleted=anchors.resolve(f.doc,point);text.insert(text.length,'tail');const end=anchors.resolve(f.doc,eof),empty=model.addFile(f.doc,'empty.tex',''),boundary=anchors.resolve(f.doc,anchors.capture(f.doc,empty,0,0));f.close();return{moved,deleted,eof:end.start===text.length,boundary};
 });expect(r).toEqual({moved:{status:'attached',start:6,end:6},deleted:{status:'detached',reason:'associated_item_deleted'},eof:true,boundary:{status:'attached',start:0,end:0}});
});
test('file and folder rename/move/delete retain identity, trash restoration reconnects, and duplicates stay isolated',async({page})=>{
 await start(page);const r=await page.evaluate(async()=>{
  const {fixture,anchors,model,discussion}=await import('/comments-harness.js'),f=fixture();f.create();model.relocateNode(f.doc,f.id,'draft/main.tex');const anchor=discussion(f.doc).threads[0].anchor,folder=model.projectNodes(f.doc).find(n=>n.folder).id;
  model.relocateNode(f.doc,folder,'chapters');model.relocateNode(f.doc,folder,'section/chapters');model.relocateNode(f.doc,f.id,'section/chapters/renamed.tex');const path=discussion(f.doc).threads[0].path;
  model.duplicateNode(f.doc,folder,'copy');const count=discussion(f.doc).threads.length;model.deleteNode(f.doc,folder);const detached=anchors.resolve(f.doc,anchor);model.restoreDeleted(f.doc);const restored=anchors.resolve(f.doc,anchor);f.close();return{path,count,detached,restored};
 });expect(r).toMatchObject({path:'section/chapters/renamed.tex',count:1,detached:{status:'detached',reason:'missing_file'},restored:{status:'attached'}});
});
test('source undo/redo publishes binding events that survive IndexedDB and a fresh peer reload',async({page,context})=>{
 await start(page);const before=await page.evaluate(async()=>{
  const {fixture,Y,model,storage,changeOrigins,discussion}=await import('/comments-harness.js'),doc=new Y.Doc(),id=model.addFile(doc,'main.tex','abc😀def selected tail'),manager=new Y.UndoManager(doc.getText(`text:${id}`),{captureTimeout:0}),origins=changeOrigins({doc,managers:new Map([[id,manager]])}),f=fixture(doc,undefined,origins);f.create();
  doc.getText(`text:${id}`).delete(9,8);const deleted=discussion(doc).threads[0].anchorStatus;manager.undo();const undone=discussion(doc).threads[0].anchorStatus;manager.redo();const redone=discussion(doc).threads[0].anchorStatus;manager.undo();await storage.saveProject('undo-fixture',doc);origins.close();manager.destroy();f.close();return{deleted,undone,redone};
 });expect(before).toEqual({deleted:'detached',undone:'attached',redone:'detached'});
 const peer=await context.newPage();try{await start(peer);const r=await peer.evaluate(async()=>{const {storage,discussion}=await import('/comments-harness.js'),doc=await storage.loadProject('undo-fixture');const thread=discussion(doc).threads[0],text=doc.getText(`text:${thread.anchor.fileId}`).toString();doc.destroy();return{status:thread.anchorStatus,quote:text.slice(thread.start,thread.end)};});expect(r).toEqual({status:'attached',quote:'selected'});await peer.reload();expect(await peer.evaluate(async()=>{const {storage,discussion}=await import('/comments-harness.js'),doc=await storage.loadProject('undo-fixture'),status=discussion(doc).threads[0].anchorStatus;doc.destroy();return status;})).toBe('attached');}finally{await peer.close();}
});
for(const probe of ['interior','sequential','redo','limit-undo','limit-redo'])test(`review probe ${probe} preserves bindings and durable source through peer reload`,async({page,context})=>{
 await start(page);const expected=await page.evaluate(async probe=>{
  const {fixture,Y,model,storage,changeOrigins,discussion}=await import('/comments-harness.js'),doc=new Y.Doc(),id=model.addFile(doc,'main.tex',probe==='sequential'?'abcdef':probe==='redo'||probe==='limit-redo'?'':'abc'),text=doc.getText(`text:${id}`),manager=new Y.UndoManager(text,{captureTimeout:0}),origins=changeOrigins({doc,managers:new Map([[id,manager]])}),f=fixture(doc,undefined,origins),snapshots=[];
  const checkpoint=async()=>{const t=discussion(doc).threads[0],key=`${probe}-${snapshots.length}`;snapshots.push({key,source:text.toString(),status:t.anchorStatus,selected:t.anchorStatus==='attached'?text.toString().slice(t.start,t.end):null,narrowed:t.narrowed});await storage.saveProject(key,doc);};
  try{
   if(probe==='redo'||probe==='limit-redo')text.insert(0,'abc');f.run({op:'thread.create',fileId:id,start:0,end:text.length,body:'Review regression'});
   if(probe==='interior'){
    text.insert(1,'X');text.delete(3,1);manager.undo();await checkpoint();doc.transact(()=>{text.delete(2,2);text.delete(0,1);});await checkpoint();manager.undo();await checkpoint();manager.redo();await checkpoint();manager.undo();await checkpoint();
   }else if(probe==='sequential'){
    text.delete(0,3);text.delete(0,3);manager.undo();await checkpoint();manager.undo();await checkpoint();manager.redo();await checkpoint();manager.redo();await checkpoint();manager.undo();manager.undo();await checkpoint();
   }else if(probe==='redo'){
    doc.transact(()=>text.insert(1,'X'),'untracked');manager.undo();await checkpoint();manager.redo();await checkpoint();manager.undo();await checkpoint();manager.redo();await checkpoint();
   }else{
    const direction=probe==='limit-undo'?'undo':'redo';if(direction==='undo')text.delete(0,3);else manager.undo();
    const roots=['authors','threads','anchors','messages','changes','discussionEvents'];let count=roots.reduce((sum,root)=>sum+doc.getMap(root).size,0);
    doc.transact(()=>{while(count++<9999){const id=crypto.randomUUID();doc.getMap('messages').set(id,{version:1,id,authorId:f.person.id,changeId:crypto.randomUUID(),createdAt:1,threadId:crypto.randomUUID(),body:'Limit fixture',mentionAuthorIds:[]});}});
    await checkpoint();if(manager[direction]()!==null)throw new Error('Over-limit undo/redo changed source');await checkpoint();
   }
   return snapshots;
  }finally{origins.close();manager.destroy();f.close();}
 },probe);
 const cases={interior:[['aXbc','aXbc',false],['X',null,false],['aXbc','aXbc',false],['X',null,false],['aXbc','aXbc',false]],sequential:[['def','def',true],['abcdef','abcdef',false],['def','def',true],['',null,false],['abcdef','abcdef',false]],redo:[['X',null,false],['aXbc','aXbc',false],['X',null,false],['aXbc','aXbc',false]],'limit-undo':[['',null,false],['',null,false]],'limit-redo':[['',null,false],['',null,false]]};
 expect(expected.map(s=>[s.source,s.selected,s.narrowed])).toEqual(cases[probe]);
 const peer=await context.newPage();try{
  await start(peer);
  for(let reload=0;reload<2;reload++){
   const actual=await peer.evaluate(async keys=>{const {storage,discussion}=await import('/comments-harness.js'),results=[];for(const key of keys){const doc=await storage.loadProject(key);try{const t=discussion(doc).threads[0],source=doc.getText(`text:${t.anchor.fileId}`).toString();results.push({key,source,status:t.anchorStatus,selected:t.anchorStatus==='attached'?source.slice(t.start,t.end):null,narrowed:t.narrowed});}finally{doc.destroy();}}return results;},expected.map(s=>s.key));expect(actual).toEqual(expected);if(!reload)await peer.reload();
  }
 }finally{await peer.close();}
});
test('actual same-profile tabs retain concurrent replies and visibly expose resolve/reopen conflicts',async({page,context})=>{
 await start(page);await page.evaluate(async()=>{const {fixture,storage}=await import('/comments-harness.js'),f=fixture();f.create();await storage.saveProject('fixture',f.doc);f.close();});
 const peer=await context.newPage();try{
  await start(peer);
  for(const tab of [page,peer])await tab.evaluate(async()=>{const {storage,fixture}=await import('/comments-harness.js');window.commentPeer=fixture(await storage.loadProject('fixture'));});
  await Promise.all([page.evaluate(()=>{const f=window.commentPeer,t=[...f.doc.getMap('threads').keys()][0];f.run({op:'thread.reply',threadId:t,body:'Reply from first tab'});f.run({op:'thread.resolve',threadId:t,eventHeads:[]});}),peer.evaluate(()=>{const f=window.commentPeer,t=[...f.doc.getMap('threads').keys()][0];f.run({op:'thread.reply',threadId:t,body:'Reply from second tab'});f.run({op:'thread.reopen',threadId:t,eventHeads:[]});})]);
  await Promise.all([page.evaluate(async()=>{const {storage}=await import('/comments-harness.js');await storage.saveProject('fixture',window.commentPeer.doc);window.commentPeer.close();delete window.commentPeer;}),peer.evaluate(async()=>{const {storage}=await import('/comments-harness.js');await storage.saveProject('fixture',window.commentPeer.doc);window.commentPeer.close();delete window.commentPeer;})]);
  await page.reload();await page.locator('.card-open').first().click();await openComments(page);await expect(page.getByRole('list',{name:'Comment threads',exact:true})).toContainText('Decision conflict');await page.locator('.comment-thread-link').first().click();await expect(detail(page)).toContainText('Reply from first tab');await expect(detail(page)).toContainText('Reply from second tab');
  await detail(page).getByRole('button',{name:'Resolve thread',exact:true}).click();await page.getByRole('combobox',{name:'Show comment threads',exact:true}).selectOption('resolved');await expect(page.locator('.comment-thread-link')).toHaveCount(1);
 }finally{for(const tab of [page,peer])await tab.evaluate(()=>{window.commentPeer?.close();delete window.commentPeer;}).catch(()=>{});await peer.close();}
});
test('v2 rights, ownership, bounded results, retries and stale cursor rejection use real handlers',async({page})=>{
 await start(page);const r=await page.evaluate(async()=>{
  const {fixture,collaborationCommands,registerComments}=await import('/comments-harness.js'),f=fixture(),created=f.create(),other={id:crypto.randomUUID(),kind:'agent',displayName:'Test agent'},commands=collaborationCommands({doc:f.doc,projectId:'fixture',capabilities:['read','comment']}),service=registerComments({doc:f.doc,commands,author:other});
  const request=command=>({version:2,requestId:crypto.randomUUID(),projectId:'fixture',expectedRevision:commands.revision(),command});
  const denied=commands.execute(request({op:'message.redact',messageId:created.messageId})).error.code,sourceDenied=commands.execute(request({op:'suggestion.accept',suggestionIds:[]})).error.code;
  const req=request({op:'thread.reply',threadId:created.threadId,body:'Agent reply'}),first=commands.execute(req),again=commands.execute(req);
  for(let i=0;i<5;i++)f.run({op:'thread.reply',threadId:created.threadId,body:'b'.repeat(16000)});
  const page=f.run({op:'thread.get',id:created.threadId,limit:100}),size=new TextEncoder().encode(JSON.stringify(page)).length;f.run({op:'thread.reply',threadId:created.threadId,body:'advance revision'});
  const stale=f.execute({op:'thread.get',id:created.threadId,cursor:page.nextCursor}).error.code,ops=commands.describe().map(o=>o.op);commands.close();const closed=commands.execute(req).error.code;service.close();f.close();return{denied,sourceDenied,same:JSON.stringify(first)===JSON.stringify(again),size,stale,closed,ops};
 });expect(r.denied).toBe('permission_denied');expect(r.sourceDenied).toBe('permission_denied');expect(r.same).toBe(true);expect(r.size).toBeLessThanOrEqual(65536);expect(r.stale).toBe('revision_conflict');expect(r.closed).toBe('project_closed');expect(r.ops).toHaveLength(9);
});
});

test('panel creates text-only messages, edits/redacts, replies, mentions and resolves/reopens',async({page})=>{
 await imported(page);const attack='<img src=x onerror="window.commentXss=true"> & <script>bad()</script>';await create(page,attack);await expect(detail(page).locator('.comment-body').first()).toHaveText(attack);expect(await page.evaluate(()=>window.commentXss)).toBeUndefined();await expect(detail(page).locator('img,script')).toHaveCount(0);await expect(page.locator('.comment-highlight')).toHaveText('selected');
 await detail(page).getByRole('button',{name:'Edit message',exact:true}).first().click();await page.getByRole('textbox',{name:'Comment body',exact:true}).fill('Edited comment 😀');await page.getByRole('button',{name:'Send comment',exact:true}).click();await expect(detail(page)).toContainText('Edited comment 😀');
 await detail(page).getByRole('button',{name:'Reply to thread',exact:true}).click();await page.getByRole('textbox',{name:'Comment body',exact:true}).fill('Reply with mention');await page.getByText('Mention authors (local metadata)',{exact:true}).click();await page.getByRole('checkbox',{name:'Local author',exact:true}).check();await page.getByRole('button',{name:'Send comment',exact:true}).click();await expect(detail(page)).toContainText('@Local author');
 await detail(page).getByRole('button',{name:'Redact message',exact:true}).first().click();await expect(detail(page)).toContainText('Message redacted');await detail(page).getByRole('button',{name:'Resolve thread',exact:true}).click();await expect(page.locator('.comment-highlight')).toHaveCount(0);await detail(page).getByRole('button',{name:'Reopen thread',exact:true}).click();await expect(page.locator('.comment-highlight')).toHaveCount(1);await saved(page);
});
test('manual reattach confirms a fresh selection and rejects a stale revision without automatic matching',async({page})=>{
 await imported(page);await create(page);await select(page);await page.keyboard.press('Backspace');await expect(page.getByRole('list',{name:'Comment threads',exact:true})).toContainText('Detached: selection deleted');await page.keyboard.insertText('selected');await expect(page.getByRole('list',{name:'Comment threads',exact:true})).toContainText('Detached: selection deleted');
 await select(page,0,5);await detail(page).getByRole('button',{name:'Reattach to selection',exact:true}).click();await select(page,0,0);await page.keyboard.insertText('%');await page.getByRole('button',{name:'Confirm reattach',exact:true}).click();await expect(page.getByRole('alert')).toContainText('changed');await expect(page.locator('.comment-highlight')).toHaveCount(0);
 await page.getByRole('button',{name:'Cancel reattach',exact:true}).click();await select(page,1,6);await detail(page).getByRole('button',{name:'Reattach to selection',exact:true}).click();await page.getByRole('button',{name:'Confirm reattach',exact:true}).click();await expect(page.locator('.comment-highlight')).toHaveText('\\docu');
});
test('late comment save focus preserves a newer editor selection',async({page})=>{
 await imported(page);await select(page);await openComments(page);await page.getByRole('button',{name:'Comment on selection',exact:true}).click();await page.getByRole('textbox',{name:'Comment body',exact:true}).fill('Keep the editor focused');
 await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(resolve)));
 try{
  await page.evaluate(()=>{
   const request=window.requestAnimationFrame,cancel=window.cancelAnimationFrame,pending=new Map();let next=1000000000;
   window.requestAnimationFrame=callback=>{const id=next++;pending.set(id,callback);return id;};
   window.cancelAnimationFrame=id=>{if(!pending.delete(id))cancel(id);};
   window.releaseCommentFrames=()=>{window.requestAnimationFrame=request;window.cancelAnimationFrame=cancel;delete window.releaseCommentFrames;for(const callback of pending.values())callback(performance.now());};
   document.getElementById('comment-send').click();
  });
  await expect(page.getByRole('status',{name:'Comment status',exact:true})).toHaveText('Saved locally');await select(page);await page.evaluate(()=>window.releaseCommentFrames());
  await expect(page.locator('.cm-content')).toBeFocused();await page.keyboard.press('Backspace');await expect(page.getByRole('list',{name:'Comment threads',exact:true})).toContainText('Detached: selection deleted');
 }finally{await page.evaluate(()=>window.releaseCommentFrames?.());}
});
for(const theme of ['light','dark'])test(`${theme} comment keyboard focus, composition guards and accessibility audit`,async({page})=>{
 await imported(page);if(theme==='dark')await page.getByRole('button',{name:'Toggle theme',exact:true}).click();await openComments(page);await select(page);await page.keyboard.press('Control+Alt+m');const body=page.getByRole('textbox',{name:'Comment body',exact:true});await expect(body).toBeFocused();await body.fill('にほん 😀');
 await body.dispatchEvent('compositionstart',{data:'にほん'});await body.dispatchEvent('keydown',{key:'Enter',code:'Enter',ctrlKey:true,isComposing:true,keyCode:229});await body.dispatchEvent('keydown',{key:'Escape',code:'Escape',isComposing:true,keyCode:229});await expect(page.locator('.comment-thread-link')).toHaveCount(0);await expect(body).toBeVisible();await body.dispatchEvent('compositionend',{data:'にほん'});
 await body.press('Control+Enter');await expect(detail(page)).toContainText('にほん 😀');await expect(body).toBeFocused();await audit(page);await body.focus();await body.press('Escape');await expect(page.getByRole('button',{name:'Review',exact:true})).toBeFocused();await expect(body).toHaveCount(0);
});
const reviewPanel=page=>page.getByRole('complementary',{name:'Review panel',exact:true});
async function auditPanel(page){const result=await new AxeBuilder({page}).include('#review-workspace').withTags(['wcag2a','wcag2aa','wcag21a','wcag21aa']).analyze();expect(result.violations.map(v=>({id:v.id,nodes:v.nodes.map(n=>n.failureSummary)}))).toEqual([]);}
for(const theme of ['light','dark'])test(`${theme} card composer keeps keyboard focus, composition guards and accessibility audit`,async({page})=>{
 await imported(page);if(theme==='dark')await page.getByRole('button',{name:'Toggle theme',exact:true}).click();await select(page);await page.keyboard.press('Control+Alt+m');const body=page.getByRole('textbox',{name:'Comment body',exact:true}),cards=page.locator('.review-card');await expect(body).toBeFocused();await auditPanel(page);await body.fill('にほん 😀');
 await body.dispatchEvent('compositionstart',{data:'にほん'});await body.dispatchEvent('keydown',{key:'Enter',code:'Enter',isComposing:true,keyCode:229});await body.dispatchEvent('keydown',{key:'Escape',code:'Escape',isComposing:true,keyCode:229});await expect(cards).toHaveCount(0);await expect(body).toHaveValue('にほん 😀');await body.dispatchEvent('compositionend',{data:'にほん'});
 await body.press('Enter');await expect(cards).toHaveCount(1);await expect(cards).toContainText('にほん 😀');await expect(body).toHaveCount(0);const location=cards.locator('.review-card-location');await expect(location).toBeFocused();await saved(page);
 await location.press('Enter');await expect(cards).toHaveClass(/active/);await auditPanel(page);await cards.getByRole('button',{name:/^Reply/}).click();await expect(body).toBeFocused();await body.press('Escape');await expect(body).toHaveCount(0);await expect(location).toBeFocused();
 const more=cards.getByRole('button',{name:'Comment actions',exact:true});await more.click();await expect(more).toHaveAttribute('aria-expanded','true');await expect(cards.getByRole('button',{name:'Edit',exact:true})).toBeFocused();await auditPanel(page);await page.keyboard.press('Escape');await expect(more).toHaveAttribute('aria-expanded','false');await expect(more).toBeFocused();await expect(cards.getByRole('button',{name:'Edit',exact:true})).toBeHidden();
});
test('cards show attachment and resolution only when exceptional, and overview counts follow the filter',async({page})=>{
 await imported(page);await select(page);await page.keyboard.press('Control+Alt+m');const body=page.getByRole('textbox',{name:'Comment body',exact:true}),panel=reviewPanel(page),card=page.locator('.review-card');await body.fill('Margin note');await body.press('Enter');await expect(card).toHaveCount(1);await saved(page);
 await expect(panel.locator('select')).toHaveCount(1);await expect(card.locator('.review-badge')).toHaveCount(0);await expect(card).not.toContainText('Open');await expect(card.locator('time')).toHaveAttribute('title',/\d/);
 const more=card.getByRole('button',{name:'Comment actions',exact:true});await more.click();await expect(card.getByRole('button',{name:'Reattach to selection',exact:true})).toHaveCount(0);await page.keyboard.press('Escape');
 await select(page);await page.keyboard.press('Backspace');await expect(card.locator('.review-badge')).toHaveText('Detached');await more.click();await expect(card.getByRole('button',{name:'Reattach to selection',exact:true})).toBeVisible();await page.keyboard.press('Escape');await page.locator('.cm-content').focus();await page.keyboard.press('Control+z');await expect(card.locator('.review-badge')).toHaveCount(0);
 await panel.getByRole('tab',{name:'Overview',exact:true}).click();const files=panel.getByRole('navigation',{name:'Review files'});await expect(files.getByRole('button',{name:'main.tex (1)',exact:true})).toBeVisible();
 await card.getByRole('button',{name:'Resolve',exact:true}).click();await expect(files.getByRole('button',{name:'main.tex (0)',exact:true})).toBeVisible();await expect(card).toHaveCount(0);
 await panel.getByRole('combobox',{name:'Review status filter'}).selectOption('resolved');await expect(files.getByRole('button',{name:'main.tex (1)',exact:true})).toBeVisible();await expect(card.locator('.review-badge')).toHaveText('Resolved');await expect(card.getByRole('button',{name:'Reopen',exact:true})).toBeVisible();
 await panel.getByRole('button',{name:'Review actions',exact:true}).click();await panel.getByRole('button',{name:'Review tools',exact:true}).click();await expect(panel.getByRole('tab')).toHaveCount(0);await expect(panel.getByRole('combobox',{name:'Review status filter'})).toBeHidden();await panel.getByRole('button',{name:'Close review tools',exact:true}).click();await expect(panel.getByRole('tab')).toHaveCount(2);
});
test('failed local saves preserve discussion and draft, export recovery, and retry without duplicate messages',async({page})=>{
 await imported(page);await select(page);await openComments(page);await page.getByRole('button',{name:'Comment on selection',exact:true}).click();const body=page.getByRole('textbox',{name:'Comment body',exact:true});await body.fill('Recover this comment');
 await page.evaluate(()=>{const put=IDBObjectStore.prototype.put;window.restoreCommentsStorage=()=>IDBObjectStore.prototype.put=put;IDBObjectStore.prototype.put=function(...args){if(this.name==='heads')throw new DOMException('Comments disk full','QuotaExceededError');return put.apply(this,args);};});
 await page.getByRole('button',{name:'Send comment',exact:true}).click();await expect(page.locator('.comments-panel [role=alert]')).toContainText('preserved');await expect(body).toHaveValue('Recover this comment');await expect(page.getByRole('button',{name:'Retry local save',exact:true})).toBeFocused();await expect(page.locator('.save-indicator')).toHaveText('Not saved · export a backup');
 const download=page.waitForEvent('download');await page.getByRole('button',{name:'Export discussion and draft',exact:true}).click();const recovery=JSON.parse(await readFile(await(await download).path(),'utf8'));expect(recovery.draft).toBe('Recover this comment');expect(Object.keys(recovery.discussion.messages)).toHaveLength(1);
 await page.evaluate(()=>window.restoreCommentsStorage());await page.getByRole('button',{name:'Retry local save',exact:true}).click();await saved(page);await expect(body).toHaveValue('');await expect(body).toBeFocused();await page.reload();await page.locator('.card-open').first().click();await openComments(page);await page.locator('.comment-thread-link').click();await expect(detail(page).locator('.comment-messages > li')).toHaveCount(1);
});
test('oversized drafts remain editable and exportable without truncation or semantic publication',async({page})=>{
 await imported(page);await select(page);await openComments(page);await page.getByRole('button',{name:'Comment on selection',exact:true}).click();const text='é'.repeat(9000),body=page.getByRole('textbox',{name:'Comment body',exact:true});await body.fill(text);await page.getByRole('button',{name:'Send comment',exact:true}).click();await expect(page.locator('.comments-panel [role=alert]')).toContainText('16 KiB');await expect(body).toHaveValue(text);await expect(page.locator('.comment-thread-link')).toHaveCount(0);
 const download=page.waitForEvent('download');await page.getByRole('button',{name:'Export discussion and draft',exact:true}).click();expect(JSON.parse(await readFile(await(await download).path(),'utf8')).draft).toBe(text);
});
test('offline reload retains comments, bindings and replies with no service dependency',async({page,context})=>{
 await imported(page);await create(page,'Offline thread');await saved(page);await page.evaluate(()=>navigator.serviceWorker.ready);await expect.poll(()=>page.evaluate(()=>Boolean(navigator.serviceWorker.controller))).toBe(true);await context.setOffline(true);try{
  await page.reload();await page.locator('.card-open').first().click();await openComments(page);await page.locator('.comment-thread-link').click();await expect(detail(page)).toContainText('Offline thread');await detail(page).getByRole('button',{name:'Reply to thread',exact:true}).click();await page.getByRole('textbox',{name:'Comment body',exact:true}).fill('Offline reply');await page.getByRole('button',{name:'Send comment',exact:true}).click();await saved(page);await page.reload();await page.locator('.card-open').first().click();await openComments(page);await page.locator('.comment-thread-link').click();await expect(detail(page)).toContainText('Offline reply');await expect(page.locator('.comment-highlight')).toHaveText('selected');
 }finally{await context.setOffline(false);}
});
test('native editor undo/redo restores anchors in a live peer and after its reload',async({page,context,baseURL})=>{
 await imported(page);await create(page,'Undo binding');const peer=await context.newPage();try{
  await peer.goto(baseURL);await peer.locator('.card-open').first().click();await openComments(peer);await expect(peer.locator('.comment-highlight')).toHaveText('selected');
  await select(page);await page.keyboard.press('Backspace');await expect(page.getByRole('list',{name:'Comment threads',exact:true})).toContainText('Detached');await page.keyboard.press('Control+z');await expect(page.locator('.comment-highlight')).toHaveText('selected');await saved(page);await expect(peer.locator('.comment-highlight')).toHaveText('selected');
  await page.bringToFront();await page.locator('.cm-content').focus();await page.keyboard.press('Control+y');await expect(page.locator('.comment-highlight')).toHaveCount(0);await page.locator('.cm-content').focus();await page.keyboard.press('Control+z');await expect(page.locator('.comment-highlight')).toHaveText('selected');await saved(page);await expect(peer.locator('.comment-highlight')).toHaveText('selected');
  await peer.reload();await peer.locator('.card-open').first().click();await openComments(peer);await expect(peer.locator('.comment-highlight')).toHaveText('selected');
 }finally{await peer.close();}
});
test('point comments have an accessible editor marker and detach when their right character is removed',async({page})=>{
 await imported(page);await select(page,selected,selected);await openComments(page);await page.getByRole('button',{name:'Comment on selection',exact:true}).click();await page.getByRole('textbox',{name:'Comment body',exact:true}).fill('A point comment');await page.getByRole('button',{name:'Send comment',exact:true}).click();await expect(page.getByRole('img',{name:'Comment at this position',exact:true})).toHaveCount(1);await expect(page.getByRole('textbox',{name:'Comment body',exact:true})).toBeFocused();await select(page,selected,selected+1);await page.keyboard.press('Backspace');await expect(page.getByRole('list',{name:'Comment threads',exact:true})).toContainText('Detached: associated item deleted');await expect(page.getByRole('img',{name:'Comment at this position',exact:true})).toHaveCount(0);
});
test('native composition commits and cancels comment drafts without sending mid-composition',async({page,context,playwright,browserName,baseURL})=>{
 let ownContext,ownBrowser,ime,profile,directory;const {mkdtemp,rm,writeFile,rename,access}=await import('node:fs/promises'),{join}=await import('node:path'),{tmpdir}=await import('node:os');
 try{
  if(browserName==='firefox'){
   const {reserveMarionettePort,firefoxIme}=await import('../helpers/firefox-ime.mjs');await reserveMarionettePort();profile=await mkdtemp(join(tmpdir(),'comments-gecko-'));ownContext=await playwright.firefox.launchPersistentContext(profile,{headless:true,args:['--marionette','--remote-allow-system-access']});page=ownContext.pages()[0]||await ownContext.newPage();await imported(page);ime=await firefoxIme(profile,new URL(baseURL).origin);
  }else if(browserName==='webkit'){
   const {buildNativeIme}=await import('../../scripts/build-native-ime.mjs'),library=await buildNativeIme();directory=await mkdtemp(join(tmpdir(),'comments-wpe-'));ownBrowser=await playwright.webkit.launch({headless:true,env:{...process.env,LD_PRELOAD:library,SCRIBYRA_NATIVE_IME_DIRECTORY:directory}});ownContext=await ownBrowser.newContext();page=await ownContext.newPage();await imported(page);
   await expect.poll(async()=>{try{await access(join(directory,'ready'));return true;}catch{return false;}}).toBe(true);
   const send=async(command,text='')=>{await rm(join(directory,'done'),{force:true});await writeFile(join(directory,'next'),command+':'+text);await rename(join(directory,'next'),join(directory,'command'));await expect.poll(async()=>{try{return await readFile(join(directory,'done'),'utf8');}catch{return '';}}).toBe(command);};
   ime={preedit:text=>send('preedit',text),cancel:()=>send('cancel'),commit:text=>send('commit',text),controlEnter:()=>page.keyboard.press('Control+Enter')};
  }else{
   await imported(page);const cdp=await context.newCDPSession(page);ime={preedit:text=>cdp.send('Input.imeSetComposition',{text,selectionStart:text.length,selectionEnd:text.length}),cancel:()=>cdp.send('Input.imeSetComposition',{text:'',selectionStart:0,selectionEnd:0}),commit:async text=>{await cdp.send('Input.insertText',{text});await cdp.send('Input.imeSetComposition',{text:'',selectionStart:0,selectionEnd:0});},controlEnter:()=>page.keyboard.press('Control+Enter'),close:()=>cdp.detach()};
  }
  await select(page);await openComments(page);await page.getByRole('button',{name:'Comment on selection',exact:true}).click();const body=page.getByRole('textbox',{name:'Comment body',exact:true});await body.focus();
  await page.evaluate(()=>{window.commentNativeEvents=[];for(const type of ['compositionstart','compositionend'])document.addEventListener(type,event=>window.commentNativeEvents.push({type:event.type,trusted:event.isTrusted}));});
  await ime.preedit('キャンセル');await expect(body).toHaveValue('キャンセル');await ime.cancel();await expect(body).toHaveValue('');
  await body.focus();await ime.preedit('にほ');await expect(body).toHaveValue('にほ');await ime.controlEnter();await expect(page.locator('.comment-thread-link')).toHaveCount(0);await expect(body).toHaveValue('にほ');
  const marker='日本語😀e\u0301';await ime.commit(marker);await expect(body).toHaveValue(marker);await body.press('Control+Enter');await expect(detail(page).locator('.comment-body')).toHaveText(marker);await expect(page.locator('.cm-content')).toHaveText(source);expect(await page.evaluate(()=>window.commentNativeEvents.filter(e=>e.type==='compositionend').length)).toBe(2);const events=await page.evaluate(()=>window.commentNativeEvents);expect(events.filter(e=>e.type==='compositionstart')).toHaveLength(2);expect(events.filter(e=>e.type==='compositionstart').every(e=>e.trusted)).toBe(true);// CDP can emit a synthetic end when Input.insertText completes a composition.
  if(browserName!=='chromium')expect(events.every(e=>e.trusted)).toBe(true);
 }finally{await ime?.close?.();await ownContext?.close();await ownBrowser?.close();if(profile)await rm(profile,{recursive:true,force:true});if(directory)await rm(directory,{recursive:true,force:true});}
});

test('a reply draft cannot move from discussion A to B through thread navigation',async({page})=>{
 await imported(page);await create(page,'Discussion A');
 await select(page,source.indexOf('alpha'),source.indexOf('alpha')+5);await page.getByRole('button',{name:'Comment on selection',exact:true}).click();await page.getByRole('textbox',{name:'Comment body',exact:true}).fill('Discussion B');await page.getByRole('button',{name:'Send comment',exact:true}).click();await saved(page);
 await page.locator('.comment-thread-link').filter({hasText:'selected'}).click();await detail(page).getByRole('button',{name:'Reply to thread',exact:true}).click();const body=page.getByRole('textbox',{name:'Comment body',exact:true});await body.fill('Reply belongs to A');
 await page.locator('.comment-thread-link').filter({hasText:'alpha'}).click();await expect(page.locator('.comments-panel [role=alert]')).toContainText('current draft');await expect(body).toHaveValue('Reply belongs to A');await expect(detail(page)).toContainText('Discussion A');
 await page.getByRole('button',{name:'Send comment',exact:true}).click();await saved(page);await expect(detail(page)).toContainText('Reply belongs to A');await page.locator('.comment-thread-link').filter({hasText:'alpha'}).click();await expect(detail(page)).not.toContainText('Reply belongs to A');
 await page.reload();await page.locator('.card-open').first().click();await openComments(page);await page.locator('.comment-thread-link').filter({hasText:'selected'}).click();await expect(detail(page)).toContainText('Reply belongs to A');await page.locator('.comment-thread-link').filter({hasText:'alpha'}).click();await expect(detail(page)).not.toContainText('Reply belongs to A');
});

for(const mode of ['new','reply','edit','cleared edit','redacting'])test(`${mode} composer navigation sends only to the displayed thread after clearing`,async({page})=>{
 await imported(page);await create(page,'Discussion A');
 await select(page,source.indexOf('alpha'),source.indexOf('alpha')+5);await page.getByRole('button',{name:'Comment on selection',exact:true}).click();const body=page.getByRole('textbox',{name:'Comment body',exact:true});await body.fill('Discussion B');await page.getByRole('button',{name:'Send comment',exact:true}).click();await saved(page);
 const a=page.locator('.comment-thread-link').filter({hasText:'selected'}),b=page.locator('.comment-thread-link').filter({hasText:'alpha'});await a.click();
 if(mode==='new')await page.getByRole('button',{name:'Comment on selection',exact:true}).click();
 else if(mode==='reply')await detail(page).getByRole('button',{name:'Reply to thread',exact:true}).click();
 else await detail(page).getByRole('button',{name:'Edit message',exact:true}).click();
 if(mode==='redacting'){await detail(page).getByRole('button',{name:'Redact message',exact:true}).click();await expect(detail(page)).toContainText('Message redacted');await expect(page.getByRole('status',{name:'Comment status',exact:true})).toHaveText('Saved locally');await expect(page.locator('.save-indicator')).toHaveText('Comment draft · not yet submitted');}
 if(mode!=='cleared edit'){
  await body.fill('Draft for A');await b.click();await expect(page.locator('.comments-panel [role=alert]')).toContainText('current draft');await expect(body).toHaveValue('Draft for A');
  if(mode!=='new')await expect(detail(page)).toContainText(mode==='redacting'?'Message redacted':'Discussion A');
 }
 await page.getByRole('button',{name:'Clear draft',exact:true}).click();await b.click();await expect(detail(page)).toContainText('Discussion B');await expect(page.locator('label[for=comment-body]')).toHaveText('Reply');await body.fill('Reply belongs to B');await page.getByRole('button',{name:'Send comment',exact:true}).click();await saved(page);
 const verify=async()=>{await b.click();await expect(detail(page).locator('.comment-body')).toHaveText(['Discussion B','Reply belongs to B']);await a.click();await expect(detail(page).locator('.comment-body')).toHaveText([mode==='redacting'?'Message redacted':'Discussion A']);};
 await verify();await page.reload();await page.locator('.card-open').first().click();await openComments(page);await verify();
});

test('send rejects an edit target outside the displayed thread',async({page})=>{
 await start(page);const result=await page.evaluate(async()=>{
  const {fixture,mount,discussion}=await import('/comments-harness.js'),f=fixture(),a=f.create(),b=f.create();f.service.close();
  const panel=mount({doc:f.doc,commands:f.commands,projectId:'fixture',author:f.person});
  try{await panel.actions['comment-edit'](a.messageId);panel.state.threadId=b.threadId;await panel.actions['comment-draft']('Wrong thread');await panel.actions['comment-send']();return{error:panel.state.error,bodies:discussion(f.doc).threads.flatMap(t=>t.messages.flatMap(m=>m.variants.map(v=>v.body)))};}finally{panel.close();f.close();}
 });expect(result.error).toContain('not in the displayed thread');expect(result.bodies).toEqual(['Browser thread','Browser thread']);
});

for(const mode of ['editing','reviewing','viewing'])for(const kind of ['comment','reply'])for(const route of ['reload','tab close','All projects'])test(`${mode} ${kind} draft survives ${route} with a leave guard and its original target`,async({page,context})=>{
 await imported(page);await create(page,'Original thread');
 const target=(await page.evaluate(()=>window.scribyra.agent.execute({version:2,requestId:crypto.randomUUID(),projectId:window.scribyra.agent.describe().projectId,command:{op:'thread.list'}}))).value.items[0].id;
 await page.getByRole('combobox',{name:'Editor mode'}).selectOption(mode);
 await openComments(page);await page.locator('.comment-thread-link').first().click();
 if(kind==='comment'){await select(page,0,5);await page.getByRole('button',{name:'Comment on selection',exact:true}).click();}
 else await detail(page).getByRole('button',{name:'Reply to thread',exact:true}).click();
 const text=`Unsent ${mode} ${kind} 😀`,body=page.getByRole('textbox',{name:'Comment body',exact:true});await body.fill(text);
 await expect(page.locator('.save-indicator')).toHaveText('Comment draft · not yet submitted');
 expect(await page.evaluate(()=>{const event=new Event('beforeunload',{cancelable:true});window.dispatchEvent(event);return event.defaultPrevented;})).toBe(true);
 if(route==='All projects'){
  await page.getByRole('button',{name:'All projects',exact:true}).click();const dialog=page.getByRole('dialog',{name:'Leave with a comment draft',exact:true});await expect(dialog).toContainText('not been submitted');await dialog.getByRole('button',{name:'Cancel',exact:true}).click();await expect(body).toHaveValue(text);
  await page.getByRole('button',{name:'All projects',exact:true}).click();await dialog.getByRole('button',{name:'Continue',exact:true}).click();
 }else if(route==='reload'){
  page.on('dialog',dialog=>dialog.accept());await page.reload();
 }else{
  // The cancelable event above checks the guard; forced automation close also models abrupt tab loss.
  await page.close({runBeforeUnload:false});page=await context.newPage();await page.goto('/');
 }
 await page.locator('.card-open').first().click();await openComments(page);await expect(page.getByRole('textbox',{name:'Comment body',exact:true})).toHaveValue(text);
 if(kind==='reply')await expect(detail(page)).toContainText('Original thread');
 await page.getByRole('button',{name:'Send comment',exact:true}).click();await saved(page);
 const threads=await page.evaluate(()=>window.scribyra.agent.execute({version:2,requestId:crypto.randomUUID(),projectId:window.scribyra.agent.describe().projectId,command:{op:'thread.list'}}));
 expect(threads.ok).toBe(true);expect(threads.value.items).toHaveLength(kind==='reply'?1:2);expect(threads.value.items.find(t=>t.id===target).messageCount).toBe(kind==='reply'?2:1);
 expect(await page.evaluate(()=>JSON.parse(localStorage.getItem('scribyra:comment-drafts:v1')).length)).toBe(0);
});

test('missing-thread recovery stays plain text, refuses retargeting, and clears only explicitly',async({page})=>{
 await start(page);const result=await page.evaluate(async()=>{
  const {fixture,mount,Y,discussion}=await import('/comments-harness.js'),f=fixture(),a=f.create(),b=f.create();f.service.close();
  let panel=mount({doc:f.doc,commands:f.commands,projectId:'fixture',author:f.person});await panel.actions['comment-reply'](a.threadId);await panel.actions['comment-draft']('Recover orphan 😀');panel.close();f.doc.getMap('threads').delete(a.threadId);
  panel=mount({doc:f.doc,commands:f.commands,projectId:'fixture',author:f.person});const restored={text:panel.state.draft,notice:panel.state.notice,target:panel.state.threadId};await panel.actions['comment-open'](b.threadId);await panel.actions['comment-send']();
  const blocked={text:panel.state.draft,target:panel.state.threadId,count:discussion(f.doc).threads[0].messages.length};await panel.actions['comment-clear']();const remaining=JSON.parse(localStorage.getItem('scribyra:comment-drafts:v1')).length;panel.close();f.close();return{restored,blocked,remaining,a:a.threadId};
 });expect(result.restored).toEqual({text:'Recover orphan 😀',notice:expect.stringContaining('original thread no longer exists'),target:result.a});expect(result.blocked).toEqual({text:'Recover orphan 😀',target:result.a,count:1});expect(result.remaining).toBe(0);
});

test('draft recovery keeps project bytes unchanged and retains text through quota and size failures',async({page})=>{
 await start(page);const result=await page.evaluate(async()=>{
  const {fixture,mount,Y}=await import('/comments-harness.js'),f=fixture(),created=f.create();f.service.close();const before=Array.from(Y.encodeStateAsUpdate(f.doc));
  let panel=mount({doc:f.doc,commands:f.commands,projectId:'fixture',author:f.person});await panel.actions['comment-reply'](created.threadId);await panel.actions['comment-draft']('Last recovery copy');
  const set=Storage.prototype.setItem;Storage.prototype.setItem=function(key,value){if(key==='scribyra:comment-drafts:v1')throw new Error('Injected quota');return set.call(this,key,value);};
  await panel.actions['comment-draft']('Current memory text');const quota={text:panel.state.draft,error:panel.state.error,pending:panel.hasDraft()};Storage.prototype.setItem=set;
  await panel.actions['comment-draft']('é'.repeat(40000));const oversized={length:panel.state.draft.length,error:panel.state.error};const unchanged=JSON.stringify(before)===JSON.stringify(Array.from(Y.encodeStateAsUpdate(f.doc)));panel.close();
  panel=mount({doc:f.doc,commands:f.commands,projectId:'fixture',author:f.person});const recovered=panel.state.draft;await panel.actions['comment-clear']();panel.close();f.close();return{quota,oversized,unchanged,recovered};
 });expect(result.quota).toEqual({text:'Current memory text',error:expect.stringContaining('Injected quota'),pending:true});expect(result.oversized).toEqual({length:40000,error:expect.stringContaining('64 KiB')});expect(result.unchanged).toBe(true);expect(result.recovered).toBe('Last recovery copy');
});

test('reload after a failed submission recovers its draft and a durable acknowledgement prevents duplicate recovery',async({page})=>{
 await imported(page);await select(page);await openComments(page);await page.getByRole('button',{name:'Comment on selection',exact:true}).click();await page.getByRole('textbox',{name:'Comment body',exact:true}).fill('Retry after reload');
 await page.evaluate(()=>{const put=IDBObjectStore.prototype.put;IDBObjectStore.prototype.put=function(...args){if(this.name==='heads')throw new DOMException('Injected save failure','QuotaExceededError');return put.apply(this,args);};});
 await page.getByRole('button',{name:'Send comment',exact:true}).click();await expect(page.locator('.comments-panel [role=alert]')).toContainText('preserved');page.on('dialog',dialog=>dialog.accept());await page.reload();await page.locator('.card-open').first().click();await openComments(page);await expect(page.getByRole('textbox',{name:'Comment body',exact:true})).toHaveValue('Retry after reload');await expect(page.locator('.comment-thread-link')).toHaveCount(0);
 await page.getByRole('button',{name:'Send comment',exact:true}).click();await saved(page);
 // Model a crash after the project commit, before removal of the local draft marker.
 await page.evaluate(()=>{const api=window.scribyra.agent,projectId=api.describe().projectId,thread=api.execute({version:2,requestId:crypto.randomUUID(),projectId,command:{op:'thread.list'}}).value.items[0];const message=api.execute({version:2,requestId:crypto.randomUUID(),projectId,command:{op:'thread.get',id:thread.id}}).value.items.find(item=>item.body==='Retry after reload'||item.variants?.some(v=>v.body==='Retry after reload'));localStorage.setItem('scribyra:comment-drafts:v1',JSON.stringify([{id:'acknowledged',projectId,draft:'Retry after reload',mode:'create',mentions:[],threadId:'',messageId:'',submittedMessageId:message.id,updatedAt:Date.now()}]));});
 await page.reload();await page.locator('.card-open').first().click();await openComments(page);await expect(page.getByRole('textbox',{name:'Comment body',exact:true})).toHaveValue('');await expect(page.locator('.comment-thread-link')).toHaveCount(1);await saved(page);
});

test('restored selection drafts refuse a new target when their original source is gone',async({page})=>{
 await start(page);const result=await page.evaluate(async()=>{
  const {fixture,mount}=await import('/comments-harness.js'),f=fixture();f.service.close();const selection={fileId:f.id,start:9,end:17};
  let panel=mount({doc:f.doc,commands:f.commands,projectId:'fixture',author:f.person,selection:()=>selection});await panel.actions['comment-new']();await panel.actions['comment-draft']('Original selection draft');panel.close();f.doc.getText(`text:${f.id}`).delete(9,8);
  panel=mount({doc:f.doc,commands:f.commands,projectId:'fixture',author:f.person,selection:()=>({...selection,start:0,end:3})});const notice=panel.state.notice;await panel.actions['comment-new']();await panel.actions['comment-send']();const recovery={text:panel.state.draft,count:f.doc.getMap('threads').size};await panel.actions['comment-clear']();panel.close();f.close();return{notice,recovery};
 });expect(result.notice).toContain('original source selection no longer exists');expect(result.recovery).toEqual({text:'Original selection draft',count:0});
});

test('a failed message-edit save restores the edit rather than mistaking the original message for an acknowledgement',async({page})=>{
 await imported(page);await create(page,'Original message');await page.locator('.comment-thread-link').first().click();await detail(page).getByRole('button',{name:'Edit message',exact:true}).click();await page.getByRole('textbox',{name:'Comment body',exact:true}).fill('Uncommitted edit');
 await page.evaluate(()=>{const put=IDBObjectStore.prototype.put;IDBObjectStore.prototype.put=function(...args){if(this.name==='heads')throw new DOMException('Injected edit save failure','QuotaExceededError');return put.apply(this,args);};});
 await page.getByRole('button',{name:'Send comment',exact:true}).click();await expect(page.locator('.comments-panel [role=alert]')).toContainText('preserved');page.on('dialog',dialog=>dialog.accept());await page.reload();await page.locator('.card-open').first().click();await openComments(page);await expect(page.getByRole('textbox',{name:'Comment body',exact:true})).toHaveValue('Uncommitted edit');await expect(detail(page)).toContainText('Original message');
 await page.getByRole('button',{name:'Send comment',exact:true}).click();await saved(page);await page.reload();await page.locator('.card-open').first().click();await openComments(page);await expect(page.getByRole('textbox',{name:'Comment body',exact:true})).toHaveValue('');await page.locator('.comment-thread-link').first().click();await expect(detail(page)).toContainText('Uncommitted edit');
});
