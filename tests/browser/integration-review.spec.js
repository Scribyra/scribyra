import {openComments,openReviews} from './review-ui.js';
import {test,expect} from '@playwright/test';
import {readFile} from 'node:fs/promises';
import {unzipSync} from 'fflate';
import * as Y from 'yjs';
import {gzipSync} from 'node:zlib';

test.use({actionTimeout:15000});
const source='\\documentclass{article}\n\\begin{document}\nalpha bravo charlie\n\\end{document}\n';
async function request(page,command){return page.evaluate(command=>{const api=window.scribyra.agent;return api.execute({version:2,requestId:crypto.randomUUID(),projectId:api.describe().projectId,expectedRevision:api.status().revision,command});},command);}
async function call(page,command){const receipt=await request(page,command);expect(receipt.ok,JSON.stringify(receipt)).toBe(true);return receipt.value;}
async function setup(page){
 await page.goto('/');await page.getByRole('button',{name:'Start with a sample paper'}).click();await expect(page.locator('.cm-content')).toBeVisible();
 const fileId=await page.evaluate(source=>{const api=window.scribyra.agent,read=api.readSource({path:'main.tex',startLine:1,endLine:200}),patch=api.patchSource({expectedRevision:read.revision,edits:[{path:'main.tex',start:0,end:read.value.content.length,before:read.value.content,after:source}]});if(!patch.ok)throw Error(JSON.stringify(patch));return read.value.fileId;},source);
 return{fileId,start:source.indexOf('alpha'),end:source.indexOf('alpha')+5};
}
async function patch(page,find,replace){const result=await page.evaluate(({find,replace})=>{const api=window.scribyra.agent;return api.patchSource({expectedRevision:api.status().revision,edits:[{path:'main.tex',find,replace}]});},{find,replace});expect(result.ok,JSON.stringify(result)).toBe(true);return result.value;}
async function propose(page,selection,after='A'){
 const review=await call(page,{op:'review.create',title:'Production route review'}),suggestion=await call(page,{op:'suggestion.propose',reviewId:review.reviewId,...selection,before:'alpha',after});return{review,suggestion};
}
async function undoAcceptance(page,review,suggestion,batch){
 const detail=await call(page,{op:'review.get',id:review.reviewId}),item=detail.items.find(i=>i.id===suggestion.suggestionId);
 return call(page,{op:'change.undo',changeId:batch.changeId,eventHeads:{[suggestion.suggestionId]:item.eventHeads}});
}
async function assertBinding(page,thread,selection){const detail=await call(page,{op:'thread.get',id:thread.threadId});expect(detail.thread).toMatchObject({anchorStatus:'attached',narrowed:false,start:selection.start,end:selection.end});}
async function restore(page,checkpointRef){const plan=await call(page,{op:'history.restorePlan',checkpointRef,mode:'current'});await call(page,{op:'history.restore',planId:plan.planId});}
async function poll(page,jobId,status){await expect.poll(()=>page.evaluate(jobId=>window.scribyra.agent.poll({jobId}),jobId),{timeout:180000}).toMatchObject({ok:true,value:{status}});}

test('comment reattachment cannot move a stale suggestion to matching text in another file',async({page})=>{
 const selection=await setup(page),{review,suggestion}=await propose(page,selection);
 await page.getByRole('button',{name:'Add file',exact:true}).click();await page.getByRole('textbox',{name:'New file',exact:true}).fill('other.tex');await page.getByRole('button',{name:'Create file',exact:true}).click();
 const other=await page.evaluate(()=>{const api=window.scribyra.agent,read=api.readSource({path:'other.tex'}),write=api.patchSource({expectedRevision:read.revision,edits:[{path:'other.tex',start:0,end:read.value.content.length,before:read.value.content,after:'alpha'}]});if(!write.ok)throw Error(JSON.stringify(write));return read.value.fileId;});
 await patch(page,'alpha','omega');
 for(const target of [{fileId:other,start:0,end:5},selection]){
  const result=await request(page,{op:'anchor.reattach',anchorId:suggestion.anchorId,...target,eventHeads:[]});expect(result).toMatchObject({ok:false,error:{code:'permission_denied'}});
 }
 expect((await request(page,{op:'suggestion.accept',suggestionIds:[suggestion.suggestionId],eventHeads:{[suggestion.suggestionId]:[]}})).ok).toBe(false);
 expect(await page.evaluate(()=>window.scribyra.agent.readSource({path:'other.tex'}).value.content)).toBe('alpha');
 const fresh=await call(page,{op:'suggestion.propose',reviewId:review.reviewId,...selection,before:'omega',after:'A',supersedesId:suggestion.suggestionId});expect(fresh.status).toBe('pending');
});

test('acceptance undo restores all witnesses of partially overlapping comments',async({page})=>{
 const selection=await setup(page),ranges=[{...selection,end:selection.end+3},{...selection,start:selection.start-2,end:selection.start+3},{...selection,start:selection.start-2,end:selection.end+3}],threads=[];
 for(const range of ranges)threads.push(await call(page,{op:'thread.create',...range,body:'Partial overlap',mentions:[]}));
 const {review,suggestion}=await propose(page,selection),batch=await call(page,{op:'suggestion.accept',suggestionIds:[suggestion.suggestionId],eventHeads:{[suggestion.suggestionId]:[]}});
 await patch(page,'charlie','CHARLIE');await undoAcceptance(page,review,suggestion,batch);
 for(let i=0;i<ranges.length;i++)await assertBinding(page,threads[i],ranges[i]);
 expect(await page.evaluate(()=>window.scribyra.agent.readSource({path:'main.tex',endLine:200}).value.content)).toBe(source.replace('charlie','CHARLIE'));
 await expect(page.locator('.save-indicator')).toHaveText('Saved locally');await page.reload();await page.locator('.card-open').first().click();await expect(page.locator('.cm-content')).toBeVisible();
 for(let i=0;i<ranges.length;i++)await assertBinding(page,threads[i],ranges[i]);
 await patch(page,'alpha','');expect((await call(page,{op:'thread.get',id:threads[0].threadId})).thread).toMatchObject({anchorStatus:'attached',narrowed:true,start:selection.start,end:selection.start+3});
});

for(const rebound of ['acceptance undo','manual reattachment'])test(`current restore preserves effective anchors after ${rebound}`,async({page})=>{
 const selection=await setup(page),thread=await call(page,{op:'thread.create',...selection,body:'Rebound comment',mentions:[]}),{review,suggestion}=await propose(page,selection);
 const selected=rebound==='manual reattachment'?{...selection,start:selection.end+1,end:selection.end+6}:selection;
 if(rebound==='acceptance undo'){
  const batch=await call(page,{op:'suggestion.accept',suggestionIds:[suggestion.suggestionId],eventHeads:{[suggestion.suggestionId]:[]}});await undoAcceptance(page,review,suggestion,batch);
 }else await call(page,{op:'anchor.reattach',anchorId:thread.anchorId,...selected,eventHeads:[]});
 const named=await call(page,{op:'history.name',label:rebound});await patch(page,'alpha','omega');await restore(page,named.checkpointRef);
 await assertBinding(page,thread,selected);expect((await call(page,{op:'review.get',id:review.reviewId})).items.find(i=>i.id===suggestion.suggestionId).status).toBe('pending');
 // Repeated restoration must not revive the historical reattach identities.
 await patch(page,'alpha','delta');await restore(page,named.checkpointRef);await assertBinding(page,thread,selected);
 await expect(page.locator('.save-indicator')).toHaveText('Saved locally');await page.reload();await page.locator('.card-open').first().click();await expect(page.locator('.cm-content')).toBeVisible();await assertBinding(page,thread,selected);
});

test('production agent writes retain their agent author and render agent labels',async({page})=>{
 const selection=await setup(page),patched=await patch(page,'charlie','CHARLIE'),thread=await call(page,{op:'thread.create',...selection,body:'Agent comment',mentions:[]}),{review,suggestion}=await propose(page,selection),detail=await call(page,{op:'thread.get',id:thread.threadId}),reviewDetail=await call(page,{op:'review.get',id:review.reviewId});
 const owner=await page.evaluate(()=>JSON.parse(localStorage.getItem('scribyra:author')).id);
 expect(detail.thread.authorId).toBe(patched.authorId);expect(detail.thread.authorId).not.toBe(owner);expect(detail.items.find(i=>i.id===thread.messageId)).toMatchObject({authorId:patched.authorId,authorName:'Agent (agent)'});
 const named=await call(page,{op:'history.name',label:'Agent named'});await patch(page,'CHARLIE','charlie');await restore(page,named.checkpointRef);
 expect(reviewDetail.review.authorId).toBe(patched.authorId);expect(reviewDetail.review.acceptanceAuthorityId).toBe(owner);expect(reviewDetail.items.find(i=>i.id===suggestion.suggestionId).authorId).toBe(patched.authorId);
 await openReviews(page);await expect(page.getByText('Agent · Agent · pending',{exact:true})).toBeVisible();
 await openComments(page);await page.evaluate(id=>window.scribyra.action('comment-open',id),thread.threadId);await expect(page.getByText('Agent (agent)',{exact:true}).first()).toBeVisible();
 await page.getByRole('button',{name:'History',exact:true}).click();await page.getByRole('button',{name:'Manage history',exact:true}).click();const download=page.waitForEvent('download');await page.getByRole('button',{name:'Export complete backup',exact:true}).click();
 const exported=unzipSync(new Uint8Array(await readFile(await(await download).path()))),doc=new Y.Doc();
 try{
  Y.applyUpdate(doc,exported['project.update']);
  expect(doc.getMap('authors').get(patched.authorId)).toMatchObject({kind:'agent',ownerAuthorId:owner});
  const changes=[...[patched,thread,review,suggestion].map(value=>doc.getMap('changes').get(value.changeId)),...[...doc.getMap('changes').values()].filter(change=>['version-name','restore'].includes(change.kind))];
  expect(changes.filter(change=>change.kind==='version-name'||change.kind==='restore')).toHaveLength(2);
  const authority=[...doc.getMap('discussionEvents').values()].find(event=>event.kind==='authorityTransfer');expect(authority.payload.acceptanceAuthorityId).toBe(owner);
  expect(new Set(changes.map(change=>change.sessionId)).size).toBe(1);
  for(const change of changes)expect(change).toMatchObject({authorId:patched.authorId,actorKind:'agent',sessionId:expect.any(String)});
 }finally{doc.destroy();}

});

test('agent review preview returns a running pollable cancellable session job',async({page})=>{
 const selection=await setup(page),{suggestion}=await propose(page,selection);
 const job=await call(page,{op:'review.preview',suggestionIds:[suggestion.suggestionId]});expect(job).toMatchObject({status:'running',jobId:expect.any(String)});
 expect(await page.evaluate(jobId=>window.scribyra.agent.diagnostics({jobId}),job.jobId)).toMatchObject({ok:true,value:{status:'running'}});
 const cancelled=await page.evaluate(jobId=>window.scribyra.agent.cancel({jobId}),job.jobId);expect(cancelled).toMatchObject({ok:true,value:{status:'cancelled'}});await poll(page,job.jobId,'cancelled');
 await expect(page.getByRole('button',{name:'Compile',exact:true})).toBeEnabled();
 const next=await call(page,{op:'review.preview',suggestionIds:[suggestion.suggestionId]});await poll(page,next.jobId,'succeeded');
 expect(await page.evaluate(jobId=>window.scribyra.agent.diagnostics({jobId}),next.jobId)).toMatchObject({ok:true,value:{status:'succeeded',total:0}});
 expect(await page.evaluate(()=>window.scribyra.agent.readSource({path:'main.tex',endLine:200}).value.content)).toBe(source);
});

test('ordinary real compilation excludes pending proposals and preview compiles them',async({page})=>{
 const selection=await setup(page),{suggestion}=await propose(page,selection,'\\UndefinedPendingProposalCommand');
 const job=await page.evaluate(()=>window.scribyra.agent.compile());expect(job.ok).toBe(true);await poll(page,job.value.jobId,'succeeded');
 const accepted=await page.evaluate(()=>window.scribyra.lastCompile);expect(accepted.success).toBe(true);expect(accepted.bytes).toBeGreaterThan(0);
 const preview=await call(page,{op:'review.preview',suggestionIds:[suggestion.suggestionId]});await poll(page,preview.jobId,'failed');
 const diagnostics=await page.evaluate(jobId=>window.scribyra.agent.diagnostics({jobId}),preview.jobId);expect(diagnostics.value.items.some(i=>i.severity==='error')).toBe(true);
 expect(await page.evaluate(()=>window.scribyra.lastCompile.jobId)).toBe(accepted.jobId);expect(await page.evaluate(()=>window.scribyra.agent.readSource({path:'main.tex',endLine:200}).value.content)).toBe(source);
});

test('complete backup recovers event-rebound comments and pending proposals offline',async({page,browser})=>{
 const selection=await setup(page),thread=await call(page,{op:'thread.create',...selection,body:'Recovered rebound',mentions:[]}),{review,suggestion}=await propose(page,selection),batch=await call(page,{op:'suggestion.accept',suggestionIds:[suggestion.suggestionId],eventHeads:{[suggestion.suggestionId]:[]}});await undoAcceptance(page,review,suggestion,batch);
 const named=await call(page,{op:'history.name',label:'Rebound recovery'});
 await page.getByRole('button',{name:'History',exact:true}).click();await page.getByRole('button',{name:'Manage history',exact:true}).click();const download=page.waitForEvent('download');await page.getByRole('button',{name:'Export complete backup',exact:true}).click();const bytes=Array.from(await readFile(await(await download).path()));
 const context=await browser.newContext({baseURL:new URL(page.url()).origin});try{
  const recovered=await context.newPage();await setup(recovered);await recovered.evaluate(async()=>{await navigator.serviceWorker.ready;if(!navigator.serviceWorker.controller)await new Promise(resolve=>navigator.serviceWorker.addEventListener('controllerchange',resolve,{once:true}));});await context.setOffline(true);
  const imported=await recovered.evaluate(async bytes=>{const api=window.scribyra.agent,ref=crypto.randomUUID(),execute=(command,attachments)=>api.execute({version:2,requestId:crypto.randomUUID(),projectId:api.describe().projectId,expectedRevision:api.status().revision,command},attachments),plan=await execute({op:'backup.importPlan',attachmentRef:ref},new Map([[ref,new Uint8Array(bytes)]]));if(!plan.ok)throw Error(JSON.stringify(plan));return execute({op:'backup.import',planId:plan.value.planId});},bytes);expect(imported.ok,JSON.stringify(imported)).toBe(true);
  await recovered.evaluate(id=>window.scribyra.action('open',id),imported.value.projectId);await patch(recovered,'alpha','omega');await restore(recovered,named.checkpointRef);await assertBinding(recovered,thread,selection);
  expect((await call(recovered,{op:'review.get',id:review.reviewId})).items.find(i=>i.id===suggestion.suggestionId).status).toBe('pending');
 }finally{await context.close();}
});


test('review preview of a TeX link requires the same consent as accepted compilation',async({page})=>{
 await page.goto('/#tex='+gzipSync(source).toString('base64url'));await expect(page.locator('.cm-content')).toBeVisible();
 const fileId=await page.evaluate(()=>window.scribyra.agent.status().value.mainFile),{suggestion}=await propose(page,{fileId,start:source.indexOf('alpha'),end:source.indexOf('alpha')+5});
 const preview=await call(page,{op:'review.preview',suggestionIds:[suggestion.suggestionId]});await poll(page,preview.jobId,'failed');
 expect(await page.evaluate(jobId=>window.scribyra.agent.poll({jobId}),preview.jobId)).toMatchObject({ok:true,value:{error:{code:'permission_denied'}}});
 expect(await page.evaluate(()=>window.scribyra.lastCompile)).toBeNull();expect(await page.evaluate(()=>localStorage.getItem('scribyra:author'))).toBeNull();
});

for(const undone of [false,true])test(`restore retires an acceptance ${undone?'redo':'undo'} group without touching source`,async({page})=>{
 const selection=await setup(page),{review,suggestion}=await propose(page,selection),batch=await call(page,{op:'suggestion.accept',suggestionIds:[suggestion.suggestionId],eventHeads:{[suggestion.suggestionId]:[]}});
 if(undone)await undoAcceptance(page,review,suggestion,batch);
 const named=await call(page,{op:'history.name',label:'Retire acceptance'});await patch(page,'charlie','CHARLIE');await restore(page,named.checkpointRef);
 const detail=await call(page,{op:'review.get',id:review.reviewId}),item=detail.items.find(i=>i.id===suggestion.suggestionId);
 expect(await request(page,{op:undone?'change.redo':'change.undo',changeId:batch.changeId,eventHeads:{[suggestion.suggestionId]:item.eventHeads}})).toMatchObject({ok:false,error:{code:'history_unavailable'}});
 const expected=undone?source:source.replace('alpha','A');
 expect(await page.evaluate(()=>window.scribyra.agent.readSource({path:'main.tex',endLine:200}).value.content)).toBe(expected);
 await expect(page.locator('.save-indicator')).toHaveText('Saved locally');await page.reload();await page.locator('.card-open').first().click();await expect(page.locator('.cm-content')).toBeVisible();
 expect(await page.evaluate(()=>window.scribyra.agent.readSource({path:'main.tex',endLine:200}).value.content)).toBe(expected);
});
for(const reattach of [false,true])test(`redo repairs comments created after acceptance, effective reattachment=${reattach}`,async({page})=>{
 const selection=await setup(page),{review,suggestion}=await propose(page,selection),batch=await call(page,{op:'suggestion.accept',suggestionIds:[suggestion.suggestionId],eventHeads:{[suggestion.suggestionId]:[]}});
 const selected={...selection,end:selection.start+1},thread=await call(page,{op:'thread.create',...(reattach?{...selected,start:selected.start+2,end:selected.start+7}:selected),body:'Accepted text comment',mentions:[]});
 if(reattach)await call(page,{op:'anchor.reattach',anchorId:thread.anchorId,...selected,eventHeads:[]});
 await undoAcceptance(page,review,suggestion,batch);expect((await call(page,{op:'thread.get',id:thread.threadId})).thread.anchorStatus).toBe('detached');
 const detail=await call(page,{op:'review.get',id:review.reviewId}),item=detail.items.find(i=>i.id===suggestion.suggestionId);
 await call(page,{op:'change.redo',changeId:batch.changeId,eventHeads:{[suggestion.suggestionId]:item.eventHeads}});await assertBinding(page,thread,selected);
 await expect(page.locator('.save-indicator')).toHaveText('Saved locally');await page.reload();await page.locator('.card-open').first().click();await expect(page.locator('.cm-content')).toBeVisible();await assertBinding(page,thread,selected);
});

async function storedProject(page){
 const bytes=await page.evaluate(async()=>{
  const db=await new Promise((resolve,reject)=>{const r=indexedDB.open('scribyra-v1');r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});
  try{return await new Promise((resolve,reject)=>{const r=db.transaction('projects').objectStore('projects').get(window.scribyra.agent.describe().projectId);r.onsuccess=()=>resolve(Array.from(r.result.update));r.onerror=()=>reject(r.error);});}finally{db.close();}
 });
 const doc=new Y.Doc();Y.applyUpdate(doc,new Uint8Array(bytes));return doc;
}

test('production agent imports a foreign review with importer session and original contributor attribution',async({page,browser})=>{
 const target=await setup(page),context=await browser.newContext({baseURL:new URL(page.url()).origin});
 try{
  const peer=await context.newPage(),selection=await setup(peer),{review,suggestion}=await propose(peer,selection);
  const discussion=await call(peer,{op:'thread.reply',suggestionId:suggestion.suggestionId,body:'Original proposal discussion'});
  await call(peer,{op:'message.edit',messageId:discussion.messageId,body:'Edited portable discussion'});
  await call(peer,{op:'thread.reply',threadId:discussion.threadId,body:'Second portable reply'});
  await openReviews(peer);const download=peer.waitForEvent('download');await peer.getByRole('button',{name:'Export review package',exact:true}).click();
  const bytes=Array.from(await readFile(await(await download).path()));
  await expect(peer.locator('.save-indicator')).toHaveText('Saved locally');const original=await storedProject(peer);
  let contributor;try{contributor=original.getMap('authors').get(original.getMap('suggestions').get(suggestion.suggestionId).authorId);}finally{original.destroy();}
  const patched=await patch(page,'charlie','CHARLIE');await expect(page.locator('.save-indicator')).toHaveText('Saved locally');
  const before=await storedProject(page),known=new Set(before.getMap('changes').keys()),sessionId=before.getMap('changes').get(patched.changeId).sessionId;before.destroy();
  const plan=await page.evaluate(async({bytes,suggestionId,target})=>{
   const api=window.scribyra.agent,attachmentRef=crypto.randomUUID();return api.execute({version:2,requestId:crypto.randomUUID(),projectId:api.describe().projectId,expectedRevision:api.status().revision,command:{op:'review.importPlan',attachmentRef,mapping:{[suggestionId]:target}}},new Map([[attachmentRef,new Uint8Array(bytes)]]));
  },{bytes,suggestionId:suggestion.suggestionId,target});expect(plan.ok,JSON.stringify(plan)).toBe(true);
  await call(page,{op:'review.import',planId:plan.value.planId});await expect(page.locator('.save-indicator')).toHaveText('Saved locally');
  const imported=await storedProject(page);
  try{
   const changes=[...imported.getMap('changes').values()].filter(c=>!known.has(c.id));expect(changes).toHaveLength(2);
   for(const change of changes)expect(change).toMatchObject({kind:'review.import',authorId:patched.authorId,actorKind:'agent',sessionId});
   for(const root of ['reviews','suggestions'])for(const record of imported.getMap(root).values()){expect(record.authorId).not.toBe(patched.authorId);expect(imported.getMap('authors').get(record.authorId)).toMatchObject({displayName:contributor.displayName,kind:contributor.kind});}
   const owner=await page.evaluate(()=>JSON.parse(localStorage.getItem('scribyra:author')).id);expect([...imported.getMap('reviews').values()][0].acceptanceAuthorityId).toBe(owner);
  }finally{imported.destroy();}
  expect(await page.evaluate(()=>window.scribyra.agent.readSource({path:'main.tex',endLine:200}).value.content)).toBe(source.replace('charlie','CHARLIE'));
  const named=await call(page,{op:'history.name',label:'Imported review'});await call(page,{op:'backup.export'});await restore(page,named.checkpointRef);
  await page.reload();await page.locator('.card-open').first().click();await expect(page.locator('.cm-content')).toBeVisible();
  expect((await call(page,{op:'review.list'})).items).toHaveLength(1);
  const threads=(await call(page,{op:'thread.list'})).items;expect(threads).toHaveLength(1);expect(threads[0].suggestionId).not.toBe(suggestion.suggestionId);
  const details=await call(page,{op:'thread.get',id:threads[0].id});expect(details.items.flatMap(i=>i.variants||[]).map(v=>v.body)).toEqual(['Edited portable discussion','Second portable reply']);
  const importedReview=await call(page,{op:'review.get',id:threads[0].reviewId});expect(importedReview.items.some(i=>i.kind==='suggestion'&&i.id===threads[0].suggestionId&&i.anchorId===threads[0].anchorId)).toBe(true);
 }finally{await context.close();}
});

for(const agent of [false,true])test(`actual UI Retry commits a quota-failed decision once with its original actor, agent=${agent}`,async({page})=>{
 const selection=await setup(page),{suggestion}=await propose(page,selection);
 await openReviews(page);await page.getByRole('button',{name:'Submit review',exact:true}).click();await expect(page.locator('.save-indicator')).toHaveText('Saved locally');
 const before=await storedProject(page),known=new Set(before.getMap('changes').keys());let agentAuthor,agentSession,humanSession;
 try{const c=[...before.getMap('changes').values()].find(c=>c.actorKind==='agent');agentAuthor=c.authorId;agentSession=c.sessionId;humanSession=[...before.getMap('changes').values()].find(c=>c.kind==='review.submit').sessionId;}finally{before.destroy();}
 await page.evaluate(async()=>{
  const db=await new Promise((resolve,reject)=>{const r=indexedDB.open('scribyra-v1');r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});
  const projectId=window.scribyra.agent.describe().projectId;
  let sequence;try{sequence=await new Promise((resolve,reject)=>{const r=db.transaction('projects').objectStore('projects').get(projectId);r.onsuccess=()=>resolve(r.result.sequence);r.onerror=()=>reject(r.error);});}finally{db.close();}
  const put=IDBObjectStore.prototype.put;window.reviewQuotaFailures=0;window.restoreReviewPut=()=>{IDBObjectStore.prototype.put=put;};
  IDBObjectStore.prototype.put=function(record,...args){if(this.name==='projects'&&record.id===projectId&&record.sequence>sequence){window.reviewQuotaFailures++;throw new DOMException('Review quota injection','QuotaExceededError');}return put.call(this,record,...args);};
 });
 try{
  if(agent)expect(await request(page,{op:'suggestion.accept',suggestionIds:[suggestion.suggestionId],eventHeads:{[suggestion.suggestionId]:[]}})).toMatchObject({ok:false,error:{code:'quota_exceeded'}});
  else await page.getByRole('button',{name:'Accept suggestion',exact:true}).click();
  const retry=page.getByRole('button',{name:'Retry unsaved decision',exact:true});await expect(retry).toBeEnabled();expect(await page.evaluate(()=>window.reviewQuotaFailures)).toBe(1);
  expect(await page.evaluate(()=>window.scribyra.agent.readSource({path:'main.tex',endLine:200}).value.content)).toBe(source);
  const failed=await storedProject(page);try{expect([...failed.getMap('changes').keys()].filter(id=>!known.has(id))).toEqual([]);}finally{failed.destroy();}
  await page.evaluate(()=>window.restoreReviewPut());await retry.click();
  await expect(page.getByRole('status',{name:'Review status',exact:true})).toContainText('suggestion.accept: accepted');await expect(retry).toBeDisabled();
  const committed=await storedProject(page);
  try{
   const changes=[...committed.getMap('changes').values()].filter(c=>!known.has(c.id));expect(changes).toHaveLength(1);
   const owner=await page.evaluate(()=>JSON.parse(localStorage.getItem('scribyra:author')).id);
   expect(changes[0]).toMatchObject({kind:'suggestion.accept',actorKind:agent?'agent':'human',authorId:agent?agentAuthor:owner,sessionId:agent?agentSession:humanSession});
   const decisions=[...committed.getMap('discussionEvents').values()].filter(e=>e.kind==='suggestionAccept');expect(decisions).toHaveLength(1);expect(decisions[0].changeId).toBe(changes[0].id);expect(decisions[0].payload.proposedBy).toBe(agentAuthor);
  }finally{committed.destroy();}
  await page.reload();await page.locator('.card-open').first().click();await expect(page.locator('.cm-content')).toBeVisible();expect(await page.evaluate(()=>window.scribyra.agent.readSource({path:'main.tex',endLine:200}).value.content)).toBe(source.replace('alpha','A'));
 }finally{await page.evaluate(()=>window.restoreReviewPut?.());}
});
