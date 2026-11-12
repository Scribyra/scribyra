import {test,expect} from '@playwright/test';
import {build} from 'esbuild';
import {readFile} from 'node:fs/promises';
const fixtures=await Promise.all([1,2,3,4,5].map(async v=>JSON.parse(await readFile(new URL(`../fixtures/foundation/schema-${v}.json`,import.meta.url)))));
// The injected harness is not an app asset and must bypass the production service worker.
test.use({serviceWorkers:'block'});
let harness,wasm;
test.beforeAll(async()=>{
 const result=await build({entryPoints:['tests/helpers/foundation-browser.js'],bundle:true,format:'esm',platform:'browser',write:false});harness=result.outputFiles[0].text;wasm=await readFile('web/pkg/scribyra_app_bg.wasm');
});
async function routes(page){await page.route('**/foundation.js',route=>route.fulfill({contentType:'text/javascript',body:harness}));await page.route('**/foundation.wasm',route=>route.fulfill({contentType:'application/wasm',body:wasm}));}
async function blank(page){await page.route('**/*',route=>route.request().resourceType()==='document'?route.fulfill({contentType:'text/html',body:'<html></html>'}):route.continue());await page.goto('/');}
async function seed(page,f,hold=false){
 await blank(page);await page.evaluate(async({f,hold})=>{
  const db=await new Promise((resolve,reject)=>{const request=indexedDB.open('scribyra-v1',6);request.onupgradeneeded=()=>{
   const db=request.result;for(const name of ['projects','heads','migrationBackups','deletedProjects'])db.createObjectStore(name,{keyPath:'id'});
   for(const name of ['journal','checkpoints'])db.createObjectStore(name,{keyPath:['projectId','sequence']}).createIndex('projectId','projectId');
   db.createObjectStore('blobs',{keyPath:'hash'});const refs=db.createObjectStore('projectBlobs',{keyPath:['projectId','hash']});refs.createIndex('projectId','projectId');refs.createIndex('hash','hash');
  };request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);});
  await new Promise((resolve,reject)=>{const tx=db.transaction(['projects','heads','migrationBackups','checkpoints','blobs','projectBlobs'],'readwrite'),record={id:f.projectId,name:`Schema ${f.version} fixture`,schemaVersion:f.version,sequence:0,updatedAt:1,files:2,update:new Uint8Array(f.update)};
   tx.objectStore('projects').put(record);tx.objectStore('heads').put({...record,update:undefined,deleted:false});tx.objectStore('migrationBackups').put({...record,update:new Uint8Array(f.firstBackup)});tx.objectStore('checkpoints').put({projectId:f.projectId,sequence:0,update:record.update});
   if(f.version>=4){tx.objectStore('blobs').put({hash:f.asset.hash,bytes:new Uint8Array(f.asset.bytes)});tx.objectStore('projectBlobs').put({projectId:f.projectId,hash:f.asset.hash});}tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error);
  });if(hold)window.heldFoundationDB=db;else db.close();
 },{f,hold});await page.unroute('**/*');
}
async function inspect(page,f){return page.evaluate(async f=>{
 const {Y,storage,assets,openDB}=await import('/foundation.js'),doc=await storage.loadProject(f.projectId),db=await openDB('scribyra-v1'),head=await db.get('projects',f.projectId),old=await storage.loadRevision(f.projectId,0);
 let rejected;try{await storage.saveProject(f.projectId,old);}catch(error){rejected=error.message;}
 const result={version:db.version,schema:doc.getMap('meta').get('schemaVersion'),source:doc.getText('text:tex').toString(),deleted:doc.getText('text:deleted').toString(),lock:doc.getMap('meta').get('texEnvironment')??null,assets:Array.from(assets.assetBytes(doc,'asset')),sequence:head.sequence,original:Array.from(Y.encodeStateAsUpdate(old)),backup:Array.from((await storage.migrationBackupV2(f.projectId,f.version)).update),first:Array.from(await storage.migrationBackup(f.projectId)),rejected};db.close();doc.destroy();old.destroy();return result;
 },f);}
for(const f of fixtures)test(`schema ${f.version} fixture upgrades with exact recovery copy and accepted bytes`,async({page})=>{
 await seed(page,f);await routes(page);await page.goto('/');await page.locator('.card-open').first().click();await expect(page.locator('.cm-content')).toContainText('Café 😀 原文');
 const result=await inspect(page,f);expect(result).toMatchObject({version:8,schema:8,source:f.source,deleted:'Deleted but recoverable 😀',lock:f.lock,assets:f.asset.bytes,sequence:1,original:f.update,backup:f.update,first:f.firstBackup});expect(result.rejected).toContain('upgraded');
});
for(const f of fixtures)test(`schema ${f.version} disk-full migration leaves all original bytes recoverable`,async({page})=>{
 await seed(page,f);await routes(page);await page.addInitScript(()=>{const put=IDBObjectStore.prototype.put;IDBObjectStore.prototype.put=function(...args){if(this.name==='projects'&&!sessionStorage.getItem('retry-migration'))throw new DOMException('Foundation disk full','QuotaExceededError');return put.apply(this,args);};});await page.goto('/');await page.locator('.card-open').first().click();await expect(page.getByRole('status',{name:'Workspace notification',exact:true})).toContainText('Foundation disk full');
 const unchanged=await page.evaluate(async id=>{const {openDB}=await import('/foundation.js'),db=await openDB('scribyra-v1'),record=await db.get('projects',id),copy=await db.get('migrationBackups',id),journal=await db.getAllFromIndex('journal','projectId',id),copies=await db.getAllFromIndex('migrationBackupsV2','projectId',id);db.close();sessionStorage.setItem('retry-migration','1');return{update:Array.from(record.update),first:Array.from(copy.update),sequence:record.sequence,journal:journal.length,copies:copies.length};},f.projectId);
 expect(unchanged).toEqual({update:f.update,first:f.firstBackup,sequence:0,journal:0,copies:0});await page.reload();await page.locator('.card-open').first().click();await expect(page.locator('.cm-content')).toContainText('Café 😀 原文');expect((await inspect(page,f)).backup).toEqual(f.update);
});
test('older tab blocks DB-7 upgrade without losing bytes, then close permits migration',async({page,context})=>{
 const f=fixtures[4];await seed(page,f,true);const next=await context.newPage();try{await routes(next);await next.goto('/');await expect(next.getByRole('status',{name:'Workspace notification',exact:true})).toContainText('Close other Scribyra tabs');
 const original=await page.evaluate(id=>new Promise(resolve=>{const q=window.heldFoundationDB.transaction('projects').objectStore('projects').get(id);q.onsuccess=()=>resolve(Array.from(q.result.update));}),f.projectId);expect(original).toEqual(f.update);
 await page.evaluate(()=>window.heldFoundationDB.close());await next.locator('.card-open').first().click();await expect(next.locator('.cm-content')).toContainText('Café 😀 原文');expect((await inspect(next,f)).backup).toEqual(f.update);
 }finally{await next.close();}
});
test('internal v2 denies rights, deduplicates retries and closes without exposing stubs',async({page})=>{
 await routes(page);await page.goto('/');const result=await page.evaluate(async()=>{
 const {Y,model,collaborationCommands}=await import('/foundation.js'),doc=new Y.Doc();model.addFile(doc,'main.tex','source');const host=collaborationCommands({doc,projectId:'p',capabilities:['read','comment']});const req=op=>({version:2,requestId:crypto.randomUUID(),projectId:'p',expectedRevision:host.revision(),command:{op}}),ops=host.describe(),denied=host.execute(req('suggestion.accept')),stub=host.execute(req('thread.create'));let commits=0;
 host.register('thread.create',{capabilities:['comment'],prepare:c=>c,commit(){commits++;doc.getMap('meta').set('fixture',commits);return{valueVersion:1};}});const request=req('thread.create'),first=host.execute(request),retry=host.execute(request);host.close();const closed=host.execute(request);doc.destroy();return{ops,denied:denied.error.code,stub:stub.error.code,first,retry,commits,closed:closed.error.code};
 });expect(result.ops).toEqual([]);expect(result.denied).toBe('permission_denied');expect(result.stub).toBe('unsupported_command');expect(result.retry).toEqual(result.first);expect(result.commits).toBe(1);expect(result.closed).toBe('project_closed');
});
test('annotation-only local-tab update preserves the accepted PDF and does not auto-compile',async({page})=>{
 await routes(page);await page.goto('/');await page.getByRole('button',{name:'Start with a sample paper'}).click();await expect(page.locator('.cm-content')).toBeVisible();await page.getByRole('button',{name:'Compile',exact:true}).click();await expect.poll(()=>page.evaluate(()=>window.scribyra.lastCompile?.success),{timeout:180000}).toBe(true);await expect(page.locator('.save-indicator')).toHaveText('Saved locally');await page.getByRole('button',{name:'Compile options',exact:true}).click();await page.getByRole('checkbox',{name:'Auto',exact:true}).check();
 const before=await page.evaluate(()=>window.scribyra.lastCompile.jobId);
 await page.evaluate(async()=>{const {storage}=await import('/foundation.js'),[project]=await storage.listProjects(),doc=await storage.loadProject(project.id),id=crypto.randomUUID();doc.getMap('messages').set(id,{version:1,id,authorId:crypto.randomUUID(),changeId:crypto.randomUUID(),createdAt:1,threadId:crypto.randomUUID(),body:'Annotation only',mentionAuthorIds:[]});await storage.saveProject(project.id,doc);doc.destroy();window.dispatchEvent(new Event('focus'));});
 await page.waitForTimeout(2500);await expect(page.locator('.stale-badge')).toHaveCount(0);expect(await page.evaluate(()=>window.scribyra.lastCompile.jobId)).toBe(before);await expect(page.getByRole('button',{name:'Show source in PDF',exact:true})).toBeEnabled();
});
test('guarded object commits serialize competing prepared updates and rollback disk-full writes',async({page})=>{
 await routes(page);await page.goto('/');await page.getByRole('button',{name:'Start with a sample paper'}).click();await expect(page.locator('.cm-content')).toBeVisible();
 const result=await page.evaluate(async()=>{
 const {Y,storage,openDB}=await import('/foundation.js'),[project]=await storage.listProjects(),doc=await storage.loadProject(project.id),db=await openDB('scribyra-v1'),before=await db.get('projects',project.id);
 doc.getMap('meta').set('name','Prepared title');const update=Y.encodeStateAsUpdate(doc),put=IDBObjectStore.prototype.put;
 IDBObjectStore.prototype.put=function(...args){if(this.name==='journal')throw new DOMException('Gateway disk full','QuotaExceededError');return put.apply(this,args);};let failed;
 try{await storage.commitPrepared(project.id,before.sequence,update);}catch(error){failed=error.name;}finally{IDBObjectStore.prototype.put=put;}
 const unchanged=await db.get('projects',project.id),results=await Promise.allSettled([storage.commitPrepared(project.id,before.sequence,update),storage.commitPrepared(project.id,before.sequence,update)]),head=await db.get('projects',project.id);db.close();doc.destroy();return{failed,unchanged:Array.from(unchanged.update),before:Array.from(before.update),statuses:results.map(r=>r.status),errors:results.filter(r=>r.status==='rejected').map(r=>r.reason.code),sequence:head.sequence,expected:before.sequence+1};
 });expect(result.failed).toBe('QuotaExceededError');expect(result.unchanged).toEqual(result.before);expect(result.statuses.sort()).toEqual(['fulfilled','rejected']);expect(result.errors).toEqual(['revision_conflict']);expect(result.sequence).toBe(result.expected);
});
for(const kind of ['buffer','bytes','dataView','words'])test(`prepared ${kind} mutation cannot change verified persisted bytes`,async({page})=>{
 await routes(page);await page.goto('/');const result=await page.evaluate(async kind=>(await import('/foundation.js')).bufferMutation(kind),kind);
 expect(result).toEqual({hashMatches:true,bytesMatch:true,pinned:true,source:'source'});
});
for(const op of ['history.name','suggestion.accept'])for(const mode of ['success','writeFailure','revoked','closed','revision','transactionRevoked','transactionRevision'])test(`${op} awaits durable gateway: ${mode}`,async({page})=>{
 await routes(page);await page.goto('/');const result=await page.evaluate(async({op,mode})=>(await import('/foundation.js')).durableCommand(op,mode),{op,mode});
 expect(result.before).toEqual({settled:false,sequence:0});expect(result.reused).toBe('request_id_reused');
 if(mode==='success'){
  expect(result.reply.ok).toBe(true);expect(result.again).toEqual(result.reply);expect(result.completed).toEqual(result.reply);expect(result.sequence).toBe(1);expect(result.pins).toBe(1);expect(result.commits).toBe(1);expect(result.prepares).toBe(1);expect(result.other).toBe('revision_conflict');expect(result.source).toBe('accepted base');
 }else{
  const code=mode==='writeFailure'?'quota_exceeded':mode.toLowerCase().includes('revision')?'revision_conflict':'project_closed';
  expect(result.reply.error.code).toBe(code);expect(result.again.error.code).toBe(code);expect(result.sequence).toBe(0);expect(result.pins).toBe(0);expect(result.source).not.toContain('accepted');if(mode==='writeFailure')expect(result.completed.ok).toBe(true);else expect(result.completed.error.code).toBe(code);
 }
});
test('preview and accepted destinations share the cancellable build slot and preserve accepted artifacts',async({page})=>{
 await routes(page);await page.goto('/');const result=await page.evaluate(async()=>(await import('/foundation.js')).isolatedBuilds());
 expect(result).toEqual({acceptedBusy:'browser_busy',previewBusy:'browser_busy',preserved:true,copied:true,cancelledResult:'AbortError',closedResult:'AbortError',previews:2,acceptedPdf:[6],stopped:3,uniqueJobs:true,busy:[true,false,true,false,true,false,true,false,true,false,false]});
});

for(const throwing of [false,true])test(`committed acceptance survives post-guard typing and handler failure=${throwing}`,async({page})=>{
 await routes(page);await page.goto('/');const r=await page.evaluate(async throwing=>(await import('/foundation.js')).committedOutcome(throwing),throwing);
 expect(r.reply.ok).toBe(true);expect(r.reply.value.localSequence).toBe(1);expect(r.reply.value.acceptanceId).toBeTruthy();
 for(const retry of [r.again,r.atBoundary,r.completed])expect(retry).toEqual(r.reply);
 expect(r).toMatchObject({commits:1,sequence:1,boundarySource:'base typed',handlerSource:'base typed',source:'accepted base typed',stored:'accepted base'});
});
for(const mode of ['waiting','transaction'])test(`closing a never-settling handler releases other hosts: ${mode}`,async({page})=>{
 await routes(page);await page.goto('/');const r=await page.evaluate(async mode=>(await import('/foundation.js')).closedDurable(mode),mode);
 expect(r).toEqual({closed:'project_closed',again:'project_closed',live:true,synchronous:true,lateCode:'project_closed',signalAborted:true,startedAfterEnd:true,transactionResult:mode==='transaction'?'AbortError':undefined,sequence:1});
});
for(const kind of ['preview','accepted'])test(`typing during a long ${kind} build schedules accepted compilation on release`,async({page})=>{
 const {foundationMain}=await import('../helpers/foundation-main.mjs'),main=await foundationMain();
 await page.route('**/assets/index-*.js',route=>route.fulfill({contentType:'text/javascript',body:main}));
 await page.route('**/scribyra_app_bg.wasm',route=>route.fulfill({contentType:'application/wasm',body:wasm}));
 await page.goto('/');await page.getByRole('button',{name:'Start with a sample paper'}).click();await expect(page.locator('.cm-content')).toBeVisible();
 await page.getByRole('button',{name:'Compile options',exact:true}).click();await page.getByRole('checkbox',{name:'Auto',exact:true}).check();await page.evaluate(kind=>window.foundationMain.start(kind),kind);
 await expect.poll(()=>page.evaluate(()=>window.foundationJobs.length)).toBe(1);
 await page.locator('.cm-content').click();await page.keyboard.press('Control+End');await page.keyboard.insertText('\n% typed while busy');
 await page.waitForTimeout(2000);expect(await page.evaluate(()=>window.foundationJobs.length)).toBe(1);
 expect(await page.evaluate(()=>window.foundationMain.state())).toEqual({busy:true,pending:true});
 await page.evaluate(()=>window.foundationJobs[0].resolve({success:false,report:{issues:[],warningCount:0}}));
 await expect.poll(()=>page.evaluate(()=>window.foundationJobs.length)).toBe(2);
 expect(await page.evaluate(()=>window.foundationJobs[1].inputs.files.some(f=>typeof f.content==='string'&&f.content.includes('% typed while busy')))).toBe(true);
 await page.evaluate(()=>window.foundationJobs[1].resolve({success:false,report:{issues:[],warningCount:0}}));
 expect(await page.evaluate(async()=>(await window.foundationPending).ok)).toBe(true);
 await expect.poll(()=>page.evaluate(()=>window.foundationMain.state())).toEqual({busy:false,pending:false});
 await page.waitForTimeout(2000);expect(await page.evaluate(()=>window.foundationJobs.length)).toBe(2);await page.evaluate(()=>window.foundationMain.leave());
});
