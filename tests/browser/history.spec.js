import {openComments,openReviews} from './review-ui.js';
import {test,expect} from '@playwright/test';
import {build} from 'esbuild';
import {readFile} from 'node:fs/promises';
import AxeBuilder from '@axe-core/playwright';

let harness,wasm;
const fixtureCode=`
import init from './web/pkg/scribyra_app.js';
import * as Y from 'yjs';
import * as storage from './web/storage.js';
import * as model from './web/model.js';
import * as assets from './web/assets.js';
import * as historyStorage from './web/history-storage.js';
import * as backup from './web/history-backup.js';
import {initializeCollaborationSchema} from './web/collaboration-schema.js';
import {blob_hash} from './web/pkg/scribyra_app.js';
import {collaborationCommands} from './web/collaboration-commands.js';
import {mount} from './web/history.js';
import {mount as mountComments} from './web/comments.js';
import {mount as mountReviews} from './web/reviews.js';
import {anchors} from './web/comment-anchors.js';
import {localAgentOwner} from './web/agent-commands.js';
import {openDB} from 'idb';
import {unzipSync,zipSync} from 'fflate';
await init({module_or_path:'/history.wasm'});initializeCollaborationSchema();
export {Y,storage,model,assets,historyStorage,backup,openDB,unzipSync,zipSync,blob_hash,collaborationCommands,mount,anchors};
export const oldImage=new Uint8Array([137,80,78,71,13,10,26,10,1,2,3]),newImage=new Uint8Array([137,80,78,71,13,10,26,10,4,5,6]);
export let f;
export async function setup(projectId,integrated=false){
 const doc=projectId?await storage.loadProject(projectId):new Y.Doc();projectId=projectId||crypto.randomUUID();
 let file,image,deleted,threadId,messageId,common;
 if(!doc.getMap('files').size){
  [file,image,deleted]=model.addEntries(doc,[{path:'main.tex',content:'😀 before\\nsecond line\\n'},{path:'image.png',content:oldImage},{path:'deleted.png',content:oldImage}]);
  const authorId=crypto.randomUUID(),changeId=crypto.randomUUID(),anchorId=crypto.randomUUID();threadId=crypto.randomUUID();messageId=crypto.randomUUID();common={version:1,authorId,changeId,createdAt:10};
  doc.getMap('authors').set(authorId,{...common,id:authorId,kind:'human',displayName:'Fixture author',ownerAuthorId:null});
  const text=doc.getText('text:'+file),start=Y.createRelativePositionFromTypeIndex(text,3,0),end=Y.createRelativePositionFromTypeIndex(text,9,-1);
  doc.getMap('anchors').set(anchorId,{...common,id:anchorId,fileId:file,kind:'range',start:Y.relativePositionToJSON(start),end:Y.relativePositionToJSON(end),witnesses:[{...start.item,length:6}],quote:'before',prefix:'😀 ',suffix:'',pathAtCreation:'main.tex'});
  doc.getMap('threads').set(threadId,{...common,id:threadId,anchorId,reviewId:null,firstMessageId:messageId});
  doc.getMap('messages').set(messageId,{...common,id:messageId,threadId,replyToId:null,body:'Original comment 😀',mentionAuthorIds:[]});
  historyStorage.recordChange(doc,{id:authorId,displayName:'Fixture author'},{id:changeId,kind:'fixture'});
  const reviewId=crypto.randomUUID(),suggestionId=crypto.randomUUID();
  doc.getMap('reviews').set(reviewId,{...common,id:reviewId,title:'Review fixture',baseCheckpointRef:null,acceptanceAuthorityId:authorId,authorityEpoch:1});
  doc.getMap('suggestions').set(suggestionId,{...common,id:suggestionId,reviewId,anchorId,baseDigest:blob_hash(new TextEncoder().encode('before')),before:'before',after:'proposed text',supersedesId:null});
  doc.getMap('meta').set('name','History fixture');doc.getMap('meta').set('mainFile',file);model.deleteNode(doc,deleted);await storage.saveProject(projectId,doc);
 }else{file=model.projectFiles(doc).find(file=>!file.binary).id;image=model.projectFiles(doc).find(file=>file.binary).id;deleted=[...doc.getMap('trash').keys()][0];}
 const commands=collaborationCommands({doc,projectId,storage}),feature=mount({doc,projectId,storage,commands,author:integrated?{...localAgentOwner(localStorage),kind:'human'}:{id:crypto.randomUUID(),displayName:'Restorer'},...(integrated?{anchors}:{}),flushSave:async()=>{const result=await storage.saveProject(projectId,doc);Y.applyUpdate(doc,result.update);}});
 f={doc,projectId,file,image,deleted,threadId,messageId,common,commands,feature};window.historyFixture=f;return{projectId,file,image,deleted,threadId,messageId};
}
export async function execute(command,attachments){const reply=await f.commands.execute({version:2,requestId:crypto.randomUUID(),projectId:f.projectId,expectedRevision:f.commands.revision(),command},attachments);if(!reply.ok)throw Object.assign(new Error(reply.error.message),{code:reply.error.code});return reply.value;}
export async function name(){const result=await execute({op:'history.name',label:'Original version'});f.named=result;return result;}
export async function mutate(){
 const text=f.doc.getText('text:'+f.file);text.delete(3,6);text.insert(3,'after');model.replaceAsset(f.doc,f.image,newImage);model.relocateNode(f.doc,f.file,'renamed.tex');
 const id=crypto.randomUUID();if(f.common)f.doc.getMap('discussionEvents').set(id,{...f.common,id,targetId:f.threadId,parents:[],kind:'threadResolve',payload:{}});
 if(f.common)historyStorage.recordChange(f.doc,{id:f.common.authorId,displayName:'Fixture author'},{kind:'source-edit',fileIds:[f.file]});
 const result=await storage.saveProject(f.projectId,f.doc);Y.applyUpdate(f.doc,result.update);
}
export async function bytes(){const artifact=await execute({op:'backup.export'}),result=new Uint8Array(artifact.size);let offset=0;while(offset<result.length){const part=await execute({op:'artifact.read',artifactId:artifact.artifactId,offset,limit:65536}),bytes=f.feature.readAttachment(part.attachmentRef);result.set(bytes,offset);offset=part.nextOffset;}if(blob_hash(result)!==artifact.sha256)throw Error('Artifact hash mismatch');return Array.from(result);}
export function enableDiscussions(){
 const context={doc:f.doc,projectId:f.projectId,storage,commands:f.commands,anchors,author:{...localAgentOwner(localStorage),kind:'human'},selection:()=>({fileId:f.file,start:3,end:9}),flushSave:()=>storage.saveProject(f.projectId,f.doc)};
 f.comments=mountComments(context);f.reviews=mountReviews(context);return{comments:f.comments.state.enabled,reviews:f.reviews.state.enabled};
}
export function close(){f?.comments?.close();f?.reviews?.close();f?.feature.close();f?.commands.close();f?.doc.destroy();f=null;}
`;
test.beforeAll(async()=>{
 const result=await build({stdin:{contents:fixtureCode,resolveDir:process.cwd(),sourcefile:'history-browser.js'},bundle:true,format:'esm',platform:'browser',write:false,loader:{'.css':'empty'}});harness=result.outputFiles[0].text;wasm=await readFile('web/pkg/scribyra_app_bg.wasm');
});
async function ready(page){
 await page.route('**/history-harness.js',route=>route.fulfill({contentType:'text/javascript',body:harness}));await page.route('**/history.wasm',route=>route.fulfill({contentType:'application/wasm',body:wasm}));
 await page.goto('/');await page.evaluate(async()=>{window.h=await import('/history-harness.js');});
}

test.describe('history storage and v2 contract',()=>{
 test.use({serviceWorkers:'block'});
 test.afterEach(async({page})=>{await page.evaluate(()=>window.h?.close()).catch(()=>{});});
 for(const mode of ['current','copy','backup'])test(`${mode} retains only original comment witnesses after interior insertion`,async({page})=>{
  await ready(page);await page.evaluate(()=>h.setup(undefined,true));
  const result=await page.evaluate(async mode=>{
   h.enableDiscussions();const fileId=h.model.addFile(h.f.doc,'witness.tex','alpha'),thread=await h.execute({op:'thread.create',fileId,start:0,end:5,body:'Only alpha'});
   h.f.doc.getText('text:'+fileId).insert(2,'UNRELATED');const named=await h.execute({op:'history.name',label:'Interior insertion'});
   if(mode==='backup'){
    const bytes=new Uint8Array(await h.bytes()),plan=await h.execute({op:'backup.importPlan',attachmentRef:'backup'},new Map([['backup',bytes]])),copy=await h.execute({op:'backup.import',planId:plan.planId});
    h.close();await h.setup(copy.projectId,true);h.enableDiscussions();
   }else{
    h.f.doc.getText('text:'+fileId).insert(14,' elsewhere');
    const plan=await h.execute({op:'history.restorePlan',checkpointRef:named.checkpointRef,mode}),restored=await h.execute({op:'history.restore',planId:plan.planId});
    if(mode==='copy'){h.close();await h.setup(restored.projectId,true);h.enableDiscussions();}
   }
   const read=()=>h.execute({op:'thread.get',id:thread.threadId}),before=await read(),text=h.f.doc.getText('text:'+fileId);text.delete(0,2);const partial=await read();text.delete(9,3);const deleted=await read(),source=text.toString(),projectId=h.f.projectId;
   await h.storage.saveProject(projectId,h.f.doc);h.close();await h.setup(projectId,true);h.enableDiscussions();return{before,partial,deleted,source,reloaded:await read()};
  },mode);
  expect(result.source).toBe('UNRELATED');expect(result.before.anchor.quote).toBe('alpha');expect(result.before.thread.anchorStatus).toBe('attached');expect(result.partial.thread.anchorStatus).toBe('attached');
  for(const detail of [result.deleted,result.reloaded]){expect(detail.thread.anchorStatus).toBe('detached');expect(detail.anchor.quote).toBe('alpha');}
 });
 test('source, asset and opaque record recovery in a clean profile offline after project storage erasure',async({page,browser,baseURL})=>{
  await ready(page);const ids=await page.evaluate(()=>h.setup()),named=await page.evaluate(()=>h.name());
  const original=await page.evaluate(async()=>{const data=await h.storage.readHistoryData(h.f.projectId),inv=h.historyStorage.inventory(data),cp=h.historyStorage.verifiedCheckpoint(h.f.named.checkpointRef,inv.objects,data.blobs);try{return{update:Array.from(cp.update),messages:cp.doc.getMap('messages').toJSON(),threads:cp.doc.getMap('threads').toJSON(),reviews:cp.doc.getMap('reviews').toJSON(),suggestions:cp.doc.getMap('suggestions').toJSON(),source:cp.doc.getText('text:'+h.f.file).toString()};}finally{cp.doc.destroy();}});
  await page.evaluate(()=>h.mutate());const bytes=await page.evaluate(()=>h.bytes());
  await page.evaluate(async()=>{const id=h.f.projectId;h.close();await h.storage.deleteProject(id);});
  const clean=await browser.newContext({baseURL,serviceWorkers:'block'});try{
   const fresh=await clean.newPage();await ready(fresh);expect(await fresh.evaluate(()=>h.storage.listProjects())).toEqual([]);await fresh.evaluate(()=>h.setup());await clean.setOffline(true);
   const recovered=await fresh.evaluate(async({bytes,named,ids})=>{const ref=crypto.randomUUID(),plan=await h.execute({op:'backup.importPlan',attachmentRef:ref},new Map([[ref,new Uint8Array(bytes)]])),installed=await h.execute({op:'backup.import',planId:plan.planId}),data=await h.storage.readHistoryData(installed.projectId),inv=h.historyStorage.inventory(data),cp=h.historyStorage.verifiedCheckpoint(named.checkpointRef,inv.objects,data.blobs);try{
    const retained={update:Array.from(cp.update),messages:cp.doc.getMap('messages').toJSON(),threads:cp.doc.getMap('threads').toJSON(),reviews:cp.doc.getMap('reviews').toJSON(),suggestions:cp.doc.getMap('suggestions').toJSON(),source:cp.doc.getText('text:'+ids.file).toString()};
    h.close();await h.setup(installed.projectId);const restore=await h.execute({op:'history.restorePlan',checkpointRef:named.checkpointRef,mode:'copy'}),result=await h.execute({op:'history.restore',planId:restore.planId}),copy=await h.storage.loadProject(result.projectId);try{return{retained,source:copy.getText('text:'+ids.file).toString(),deletedImage:Array.from(h.assets.assetBytes(copy,ids.deleted)),oldImage:Array.from(h.assets.assetBytes(copy,ids.image)),messages:copy.getMap('messages').toJSON(),events:[...copy.getMap('discussionEvents').values()].filter(e=>e.kind==='threadResolve').length,versions:inv.items.filter(item=>item.versionId).length};}finally{copy.destroy();}
   }finally{cp.doc.destroy();}},{bytes,named,ids});
   expect(recovered.retained).toEqual(original);expect(recovered.source).toBe(original.source);expect(recovered.deletedImage).toEqual([137,80,78,71,13,10,26,10,1,2,3]);expect(recovered.oldImage).toEqual(recovered.deletedImage);expect(recovered.messages).toEqual(original.messages);expect(recovered.events).toBe(0);expect(recovered.versions).toBe(1);await fresh.evaluate(()=>h.close());
  }finally{await clean.close();}
 });
 test('deleted credential structs fail complete export and import planning in every retained store',async({page})=>{
  await ready(page);await page.evaluate(()=>h.setup());await page.evaluate(()=>h.name());
  const results=await page.evaluate(async()=>{
   const data=await h.storage.readHistoryData(h.f.projectId),safe=h.backup.exportBackup(data),unsafe=h.assets.cloneProject(h.f.doc),undo=new h.Y.UndoManager(unsafe.getMap('meta'));
   unsafe.getMap('meta').set('providerToken','DELETED_BROWSER_CANARY');unsafe.getMap('meta').delete('providerToken');const update=h.Y.encodeStateAsUpdate(unsafe);undo.destroy();unsafe.destroy();
   const results=[];
   for(const generation of ['head','migrationBackup','migrationBackupsV2','checkpoint','replay-only checkpoint','journal']){
    const copy=structuredClone(data),entries=h.backup.unpack(safe),history=JSON.parse(new TextDecoder().decode(entries.get('history.json'))),updateRef='updates/'+h.blob_hash(update);entries.set(updateRef,update);
    if(generation==='head'){copy.project.update=update;entries.set('project.update',update);}
    else if(generation==='migrationBackup'){copy.migrationBackup={...copy.project,update};history.migrationBackup={updateRef};}
    else if(generation==='migrationBackupsV2'){copy.migrationBackupsV2.push({...copy.project,fromVersion:5,update});history.migrationBackupsV2.push({fromVersion:5,updateRef});}
    else if(generation==='journal'){copy.journal.at(-1).update=update;history.journal.at(-1).updateRef=updateRef;}
    else{copy.checkpoints[0]={...copy.checkpoints[0],update,replayOnly:generation==='replay-only checkpoint'};history.checkpoints[0]={...history.checkpoints[0],updateRef,replayOnly:generation==='replay-only checkpoint'};}
    entries.set('history.json',new TextEncoder().encode(JSON.stringify(history)));const manifest=JSON.parse(new TextDecoder().decode(entries.get('manifest.json')));manifest.entries=[...entries].filter(([path])=>path!=='manifest.json').map(([path,bytes])=>({path,hash:h.blob_hash(bytes),size:bytes.length}));entries.set('manifest.json',new TextEncoder().encode(JSON.stringify(manifest)));
    let exported,planned;try{h.backup.exportBackup(copy);exported='unsafe success';}catch(error){exported=error.message;}
    const ref=crypto.randomUUID();try{await h.execute({op:'backup.importPlan',attachmentRef:ref},new Map([[ref,h.zipSync(Object.fromEntries(entries))]]));planned='unsafe success';}catch(error){planned=error.message;}
    results.push({generation,exported,planned});
   }
   return{canary:new TextDecoder().decode(update).includes('DELETED_BROWSER_CANARY'),results};
  });
  expect(results.canary).toBe(true);expect(results.results).toHaveLength(6);for(const row of results.results){expect(row.exported,row.generation).toContain('private connection state');expect(row.planned,row.generation).toContain('private connection state');}
 });
 test('concurrent restores reject target plans and import plans while clean restoration resolves the head',async({page})=>{
  await ready(page);await page.evaluate(()=>h.setup());await page.evaluate(()=>h.name());
  const result=await page.evaluate(async()=>{
   const clean=h.f.named,entries=h.backup.unpack(h.backup.exportBackup(await h.storage.readHistoryData(h.f.projectId))),author={id:crypto.randomUUID(),displayName:'Replica restorer'},options={author,checkpointId:crypto.randomUUID()},left=h.historyStorage.restoreCurrent(h.f.doc,h.f.doc,options).doc,right=h.historyStorage.restoreCurrent(h.f.doc,h.f.doc,options).doc;
   try{h.Y.applyUpdate(h.f.doc,h.Y.encodeStateAsUpdate(left));h.Y.applyUpdate(h.f.doc,h.Y.encodeStateAsUpdate(right));}finally{left.destroy();right.destroy();}
   const named=await h.execute({op:'history.name',label:'Concurrent restores'}),item=(await h.execute({op:'history.list'})).items.find(item=>item.versionId===named.versionId),errors=[];
   for(const mode of ['copy','current'])try{await h.execute({op:'history.restorePlan',checkpointRef:named.checkpointRef,mode});errors.push('unsafe success');}catch(error){errors.push(error.message);}
   entries.set('project.update',h.Y.encodeStateAsUpdate(h.f.doc));const manifest=JSON.parse(new TextDecoder().decode(entries.get('manifest.json')));manifest.entries=[...entries].filter(([path])=>path!=='manifest.json').map(([path,bytes])=>({path,hash:h.blob_hash(bytes),size:bytes.length}));entries.set('manifest.json',new TextEncoder().encode(JSON.stringify(manifest)));
   const ref=crypto.randomUUID();try{await h.execute({op:'backup.importPlan',attachmentRef:ref},new Map([[ref,h.zipSync(Object.fromEntries(entries))]]));errors.push('unsafe success');}catch(error){errors.push(error.message);}
   const reviewId=[...h.f.doc.getMap('reviews').keys()][0],heads=h.historyStorage.discussionHeads(h.f.doc,reviewId),plan=await h.execute({op:'history.restorePlan',checkpointRef:clean.checkpointRef,mode:'current'});await h.execute({op:'history.restore',planId:plan.planId});
   const state=h.historyStorage.discussionProjection(h.f.doc,'reviews',reviewId),authority=h.f.doc.getMap('discussionEvents').get(state.heads[0]),boundary=h.f.doc.getMap('discussionEvents').get(authority.parents[0]),resolved=await h.execute({op:'history.name',label:'Resolved restores'}),copyPlan=await h.execute({op:'history.restorePlan',checkpointRef:resolved.checkpointRef,mode:'copy'}),copy=await h.execute({op:'history.restore',planId:copyPlan.planId}),loaded=await h.storage.loadProject(copy.projectId);
   try{return{item,errors,heads,parents:boundary.parents,review:h.historyStorage.discussionProjection(loaded,'reviews',reviewId).projection.id,reviewId};}finally{loaded.destroy();}
  });
  expect(result.item.available).toBe(false);expect(result.item.status).not.toBe('Restorable');expect(result.errors).toHaveLength(3);for(const error of result.errors)expect(error).toContain('Concurrent discussion restorations');expect(result.heads).toHaveLength(2);expect(result.parents.sort()).toEqual(result.heads.sort());expect(result.review).toBe(result.reviewId);
 });
 test('discussion integration gate: real anchors, thread resolution and review authority after offline recovery',async({page,browser,baseURL})=>{
  await ready(page);await page.evaluate(()=>h.setup(undefined,true));expect(await page.evaluate(()=>h.enableDiscussions())).toEqual({comments:true,reviews:true});
  const created=await page.evaluate(async()=>{
   const thread=await h.execute({op:'thread.create',fileId:h.f.file,start:3,end:9,body:'Integration comment',mentions:[]}),review=await h.execute({op:'review.create',title:'Integration review'});
   const suggestion=await h.execute({op:'suggestion.propose',reviewId:review.reviewId,fileId:h.f.file,start:3,end:9,before:'before',after:'proposed'});
   await h.execute({op:'review.submit',reviewId:review.reviewId,eventHeads:[]});const named=await h.name();
   await h.execute({op:'thread.resolve',threadId:thread.threadId,eventHeads:[]});await h.mutate();return{thread,review,suggestion,named,bytes:await h.bytes()};
  });
  await page.evaluate(async()=>{const projectId=h.f.projectId;h.close();await h.storage.deleteProject(projectId);});
  const clean=await browser.newContext({baseURL,serviceWorkers:'block'});try{
   const fresh=await clean.newPage();await ready(fresh);expect(await fresh.evaluate(()=>h.storage.listProjects())).toEqual([]);await fresh.evaluate(()=>h.setup(undefined,true));await clean.setOffline(true);
   const restored=await fresh.evaluate(async({thread,review,suggestion,named,bytes})=>{
    const ref=crypto.randomUUID(),plan=await h.execute({op:'backup.importPlan',attachmentRef:ref},new Map([[ref,new Uint8Array(bytes)]])),installed=await h.execute({op:'backup.import',planId:plan.planId});h.close();await h.setup(installed.projectId,true);h.enableDiscussions();
    const resolved=await h.execute({op:'thread.get',id:thread.threadId}),restore=await h.execute({op:'history.restorePlan',checkpointRef:named.checkpointRef,mode:'copy'}),copy=await h.execute({op:'history.restore',planId:restore.planId});h.close();await h.setup(copy.projectId,true);h.enableDiscussions();
    const anchor=h.f.doc.getMap('anchors').get(thread.anchorId);return{projectId:copy.projectId,resolved,thread:await h.execute({op:'thread.get',id:thread.threadId}),review:await h.execute({op:'review.get',id:review.reviewId}),anchor:h.anchors.resolve(h.f.doc,anchor),authority:h.f.doc.getMap('changes').get(copy.changeId).authorId,source:h.f.doc.getText('text:'+h.f.file).toString(),image:Array.from(h.assets.assetBytes(h.f.doc,h.f.image)),deleted:Array.from(h.assets.assetBytes(h.f.doc,h.f.deleted))};
   },created);
   expect(restored.resolved.thread.status).toBe('resolved');expect(restored.thread.thread.status).toBe('open');expect(restored.thread.items[0].variants[0].body).toBe('Integration comment');expect(restored.anchor).toMatchObject({status:'attached',start:3,end:9});expect(restored.review.review.acceptanceAuthorityId).toBe(restored.authority);expect(restored.review.items.find(i=>i.id===created.suggestion.suggestionId).status).toBe('pending');expect(restored.source).toBe('😀 before\nsecond line\n');expect(restored.image).toEqual([137,80,78,71,13,10,26,10,1,2,3]);expect(restored.deleted).toEqual(restored.image);
   await fresh.evaluate(async projectId=>{h.close();await window.scribyra.action('open',projectId);},restored.projectId);
   await openComments(fresh);const comments=fresh.getByRole('region',{name:'Comments',exact:true});await fresh.evaluate(id=>window.scribyra.action('comment-open',id),created.thread.threadId);await expect(comments.getByText('Integration comment',{exact:true})).toBeVisible();await expect(comments.getByRole('button',{name:'Resolve thread',exact:true})).toBeVisible();await expect(comments.locator('.comment-warning')).toHaveCount(0);
   await openReviews(fresh);const reviews=fresh.getByRole('region',{name:'Reviews',exact:true});await expect(reviews.getByRole('heading',{name:'Integration review',exact:true}).first()).toBeVisible();await expect(reviews.getByText('submitted',{exact:true})).toBeVisible();await expect(reviews.getByText('Acceptance authority: this profile',{exact:true})).toHaveCount(2);
   const accepted=await fresh.evaluate(async id=>{const api=window.scribyra.agent;return api.execute({version:2,requestId:crypto.randomUUID(),projectId:api.describe().projectId,expectedRevision:api.status().revision,command:{op:'suggestion.accept',suggestionIds:[id],eventHeads:{[id]:[]}}});},created.suggestion.suggestionId);expect(accepted.ok,JSON.stringify(accepted)).toBe(true);await expect(reviews.getByText(/· accepted$/)).toBeVisible();
  }finally{await clean.close();}
 });
 test('source ZIP exclusions and verified asset/text/rename/discussion diffs',async({page})=>{
  await ready(page);await page.evaluate(()=>h.setup());const result=await page.evaluate(async()=>{const named=await h.name();await h.mutate();const result=await h.execute({op:'history.diff',fromCheckpoint:named.checkpointRef}),zip=h.unzipSync(h.model.exportZip(h.f.doc));return{result,names:Object.keys(zip).sort(),source:new TextDecoder().decode(zip['renamed.tex']),image:Array.from(zip['image.png'])};});
  expect(result.names).toEqual(['image.png','renamed.tex']);expect(result.source).toBe('😀 after\nsecond line\n');expect(result.result.changes.map(c=>c.kind)).toEqual(expect.arrayContaining(['text','asset','rename','discussion']));expect(result.result.contributors.length).toBeGreaterThan(0);expect(result.result.changes.find(c=>c.kind==='text').start).toBe(3);
 });
 test('copy leaves original unchanged; current restore adds attribution and an exact pinned pre-restore snapshot',async({page})=>{
  await ready(page);await page.evaluate(()=>h.setup());const r=await page.evaluate(async()=>{const named=await h.name();await h.mutate();const before=Array.from(h.Y.encodeStateAsUpdate(h.f.doc)),copyPlan=await h.execute({op:'history.restorePlan',checkpointRef:named.checkpointRef,mode:'copy'}),copy=await h.execute({op:'history.restore',planId:copyPlan.planId}),unchanged=Array.from(h.Y.encodeStateAsUpdate(h.f.doc)),currentPlan=await h.execute({op:'history.restorePlan',checkpointRef:named.checkpointRef,mode:'current'}),restored=await h.execute({op:'history.restore',planId:currentPlan.planId}),data=await h.storage.readHistoryData(h.f.projectId),pre=data.historyCatalog.find(row=>row.reason==='pre-restore'),cp=h.historyStorage.verifiedCheckpoint(pre.checkpointRef,data.objects,data.blobs);try{return{before,unchanged,pre:Array.from(cp.update),newChange:h.f.doc.getMap('changes').get(restored.changeId),thread:h.historyStorage.discussionProjection(h.f.doc,'threads',h.f.threadId),anchor:h.historyStorage.discussionProjection(h.f.doc,'anchors',h.f.doc.getMap('threads').get(h.f.threadId).anchorId),copy,restored,source:h.f.doc.getText('text:'+h.f.file).toString(),mapping:await h.execute({op:'artifact.read',artifactId:restored.idMapRef})};}finally{cp.doc.destroy();}});
  expect(r.unchanged).toEqual(r.before);expect(r.pre).toEqual(r.before);expect(r.newChange.kind).toBe('restore');expect(r.newChange.authorId).toBeTruthy();expect(r.copy.projectId).not.toBe(r.restored.projectId);expect(r.source).toBe('😀 before\nsecond line\n');expect(r.mapping.eof).toBe(true);expect(r.thread.eventIds).toEqual([]);expect(r.thread.projection.id).toBeTruthy();expect(r.anchor.detached).toBe(true);expect(r.anchor.anchor).toBe(null);
 });
 for(const race of ['live deletion','committed peer'])test(`restore rejects stale plan after ${race}`,async({page,context})=>{
  await ready(page);const ids=await page.evaluate(()=>h.setup());await page.evaluate(()=>h.name());const plan=await page.evaluate(()=>h.execute({op:'history.restorePlan',checkpointRef:h.f.named.checkpointRef,mode:'current'}));
  if(race==='live deletion')await page.evaluate(()=>h.f.doc.getText('text:'+h.f.file).delete(3,1));else{const peer=await context.newPage();try{await ready(peer);await peer.evaluate(async ids=>{await h.setup(ids.projectId);h.f.doc.getText('text:'+ids.file).delete(3,1);await h.storage.saveProject(ids.projectId,h.f.doc);h.close();},ids);}finally{await peer.close();}}
  const result=await page.evaluate(async plan=>{const before=h.f.doc.getText('text:'+h.f.file).toString();try{await h.execute({op:'history.restore',planId:plan.planId});return{success:true};}catch(error){return{code:error.code,before,after:h.f.doc.getText('text:'+h.f.file).toString(),restores:[...h.f.doc.getMap('changes').values()].filter(c=>c.kind==='restore').length};}},plan);
  expect(result.code).toBe('revision_conflict');expect(result.restores).toBe(0);if(race==='live deletion')expect(result.after).toBe(result.before);
 });
 test('compaction retains every advertised name and shared asset while a stale tab sends deletion-only state',async({page,context})=>{
  await ready(page);const ids=await page.evaluate(()=>h.setup());await page.evaluate(()=>h.name());const stale=await context.newPage();try{
   await ready(stale);await stale.evaluate(ids=>h.setup(ids.projectId),ids);
   const r=await page.evaluate(async()=>{await h.mutate();const sharedBytes=new Uint8Array([9,8,7]);h.model.replaceAsset(h.f.doc,h.f.image,sharedBytes);await h.storage.saveProject(h.f.projectId,h.f.doc);h.model.replaceAsset(h.f.doc,h.f.image,h.newImage);await h.storage.saveProject(h.f.projectId,h.f.doc);for(let i=0;i<51;i++){h.f.doc.getText('text:'+h.f.file).insert(0,'x');await h.storage.saveProject(h.f.projectId,h.f.doc);}const shared=new h.Y.Doc(),[file]=h.model.addEntries(shared,[{path:'shared.png',content:sharedBytes}]),id=crypto.randomUUID();await h.storage.saveProject(id,shared);shared.destroy();const plan=await h.execute({op:'history.compactPlan',keepCheckpointIds:[]}),result=await h.execute({op:'history.compact',planId:plan.planId}),data=await h.storage.readHistoryData(h.f.projectId),items=(await h.execute({op:'history.list'})).items,sharedDoc=await h.storage.loadProject(id);try{return{plan:plan.summary,result,restorable:items.filter(item=>item.versionId).every(item=>item.available),availableIds:items.filter(item=>item.available).map(item=>item.checkpointId),shared:Array.from(h.assets.assetBytes(sharedDoc,file)),journal:data.journal.length,strayRows:data.journal.filter(row=>!result.retainedSequences.includes(row.sequence)).length};}finally{sharedDoc.destroy();}});
   expect(r.result.removedSequences).toEqual(r.plan.removedSequences);expect(r.result.retainedCheckpointIds).toEqual(r.plan.retainedCheckpointIds);expect(r.result.removedSequences.length).toBeGreaterThan(0);expect(r.restorable).toBe(true);for(const removed of r.result.removedCheckpointIds)expect(r.availableIds).not.toContain(removed);expect(r.shared).toEqual([9,8,7]);expect(r.result.releasedAssetHashes.length).toBeGreaterThan(0);
   // History format 2 keeps the journal merged up to kept versions and the head instead of deleting it: no saved step remains between them.
   expect(r.strayRows).toBe(0);expect(r.journal).toBeLessThanOrEqual(r.result.retainedSequences.length);
   const deletion=await stale.evaluate(async()=>{const vector=Array.from(h.Y.encodeStateVector(h.f.doc));h.f.doc.getText('text:'+h.f.file).delete(3,1);const same=JSON.stringify(vector)===JSON.stringify(Array.from(h.Y.encodeStateVector(h.f.doc))),merged=await h.storage.saveProject(h.f.projectId,h.f.doc);h.Y.applyUpdate(h.f.doc,merged.update);return{same,source:h.f.doc.getText('text:'+h.f.file).toString()};});expect(deletion.same).toBe(true);
   const fresh=await page.evaluate(async()=>{const result=await h.storage.saveProject(h.f.projectId,h.f.doc);h.Y.applyUpdate(h.f.doc,result.update);return h.f.doc.getText('text:'+h.f.file).toString();});expect(fresh).toBe(deletion.source);
   await stale.evaluate(()=>h.close());
  }finally{await stale.close();}
 });
 for(const operation of ['name','restore','compact','import'])test(`${operation} quota failure leaves project and history intact`,async({page})=>{
  await ready(page);await page.evaluate(()=>h.setup());const r=await page.evaluate(async operation=>{
   await h.name();await h.mutate();let command;
   if(operation==='name')command={op:'history.name',label:'Failure'};
   if(operation==='restore'){const plan=await h.execute({op:'history.restorePlan',checkpointRef:h.f.named.checkpointRef,mode:'current'});command={op:'history.restore',planId:plan.planId};}
   if(operation==='compact'){const plan=await h.execute({op:'history.compactPlan',keepCheckpointIds:[]});command={op:'history.compact',planId:plan.planId};}
   if(operation==='import'){const ref=crypto.randomUUID(),bytes=new Uint8Array(await h.bytes()),plan=await h.execute({op:'backup.importPlan',attachmentRef:ref},new Map([[ref,bytes]]));command={op:'backup.import',planId:plan.planId};}
   // History format 2: clean-up first merges steps between versions (every listed state unchanged), so for compact the journal may be merged; versions, head, catalogue, objects and assets must be as before.
   const view=async()=>{const {journal,checkpoints,...rest}=await h.storage.readHistoryData(h.f.projectId);return JSON.stringify(operation==='compact'?{rest,versions:(await h.execute({op:'history.list'})).items.map(({checkpointId,label,available,createdAt,versionId})=>({checkpointId,label,available,createdAt,versionId}))}:{rest,journal,checkpoints});};
   const before=await view(),projects=await h.storage.listProjects(),live=Array.from(h.Y.encodeStateAsUpdate(h.f.doc)),put=IDBObjectStore.prototype.put;let code;
   IDBObjectStore.prototype.put=function(...args){if(this.name==='historyCatalog'&&operation!=='compact'||this.name==='historyObjects'&&operation==='name'||this.name==='projects'&&['import','compact'].includes(operation))throw new DOMException('History quota injection','QuotaExceededError');return put.apply(this,args);};
   try{await h.execute(command);}catch(error){code=error.code;}finally{IDBObjectStore.prototype.put=put;}
   return{code,unchanged:await view()===before,projects:JSON.stringify(await h.storage.listProjects())===JSON.stringify(projects),live:JSON.stringify(Array.from(h.Y.encodeStateAsUpdate(h.f.doc)))===JSON.stringify(live)};
  },operation);expect(r).toEqual({code:'quota_exceeded',unchanged:true,projects:true,live:true});
 });
 test('corrupt/missing chunk, journal gap and unsupported schema are rejected',async({page})=>{
  await ready(page);await page.evaluate(()=>h.setup());const r=await page.evaluate(async()=>{
   const named=await h.name();await h.mutate();const data=await h.storage.readHistoryData(h.f.projectId),bad=structuredClone(data);bad.checkpoints=[];const manifest=JSON.parse(new TextDecoder().decode(bad.objects.find(o=>o.hash===named.checkpointRef).bytes));bad.objects.find(o=>o.hash===manifest.updateChunks[0].hash).bytes[0]^=255;
   const unavailable=h.historyStorage.inventory(bad).items.find(item=>item.versionId===named.versionId).available;let corrupt,gap,future,missing;
   try{h.backup.exportBackup(bad);}catch(error){corrupt=error.code;}
   const broken=structuredClone(data);broken.journal.shift();try{h.backup.exportBackup(broken);}catch(error){gap=error.code;}
   const copy=h.assets.cloneProject(h.f.doc);copy.getMap('meta').set('schemaVersion',9);try{h.historyStorage.checkpoint(copy);}catch(error){future=String(error);}finally{copy.destroy();}
   const db=await h.openDB('scribyra-v1');await db.delete('historyObjects',manifest.updateChunks[0].hash);try{await h.execute({op:'history.restorePlan',checkpointRef:named.checkpointRef,mode:'copy'});}catch(error){missing=error.message;}db.close();return{unavailable,corrupt,gap,future,missing};
  });expect(r.unavailable).toBe(false);expect(r.corrupt).toBe('incomplete_backup');expect(r.gap).toBe('history_unavailable');expect(r.future).toContain('newer');expect(r.missing).toContain('missing');
 });
 test('backup excludes device secrets and refuses secret project fields and corrupt archive claims',async({page})=>{
  await ready(page);await page.evaluate(()=>h.setup());const r=await page.evaluate(async()=>{
   localStorage.setItem('provider.credentials','DEVICE_SECRET_CANARY');await h.name();const bytes=new Uint8Array(await h.bytes()),entries=h.backup.unpack(bytes),content=[...entries.values()].map(b=>new TextDecoder().decode(b)).join('');let traversal,hash,secret;
   const tampered=Object.fromEntries(entries);tampered['../credentials']=new Uint8Array([1]);try{h.backup.importBackup(h.zipSync(tampered));}catch(error){traversal=error.code;}delete tampered['../credentials'];tampered['project.update'][0]^=1;try{h.backup.importBackup(h.zipSync(tampered));}catch(error){hash=error.code;}
   h.f.doc.getMap('meta').set('providerToken','PROJECT_SECRET_CANARY');try{await h.bytes();}catch(error){secret=error.code;}
   return{device:content.includes('DEVICE_SECRET_CANARY'),traversal,hash,secret};
  });expect(r).toEqual({device:false,traversal:'incomplete_backup',hash:'incomplete_backup',secret:'incomplete_backup'});
 });
 test('unpin and reviewed compaction release a version without advertising removed objects',async({page})=>{
  await ready(page);await page.evaluate(()=>h.setup());const r=await page.evaluate(async()=>{
   h.f.doc.getText('text:'+h.f.file).insert(0,'temporary ');await h.storage.saveProject(h.f.projectId,h.f.doc);const named=await h.name();await h.mutate();await h.execute({op:'history.unpin',versionId:named.versionId});const before=(await h.execute({op:'history.list'})).items.find(item=>item.versionId===named.versionId),plan=await h.execute({op:'history.compactPlan',keepCheckpointIds:[]}),result=await h.execute({op:'history.compact',planId:plan.planId}),data=await h.storage.readHistoryData(h.f.projectId),items=h.historyStorage.inventory(data).items;h.backup.importBackup(h.backup.exportBackup(data));return{unpinned:!before.pinned,removed:result.removedCheckpointIds.includes(before.checkpointId),advertised:items.some(item=>item.versionId===named.versionId),object:data.objects.some(object=>object.hash===named.checkpointRef)};
  });expect(r).toEqual({unpinned:true,removed:true,advertised:false,object:false});
 });
 test('legacy prototype-like file identities survive a complete restore plan',async({page})=>{
  await ready(page);await page.evaluate(()=>h.setup());const result=await page.evaluate(async()=>{
   for(const id of ['__proto__','constructor'])h.model.addFile(h.f.doc,id+'.tex','original',id);
   const named=await h.name();for(const id of ['__proto__','constructor']){const text=h.f.doc.getText('text:'+id);text.delete(0,text.length);text.insert(0,'changed');}
   const plan=await h.execute({op:'history.restorePlan',checkpointRef:named.checkpointRef,mode:'current'}),restored=await h.execute({op:'history.restore',planId:plan.planId}),read=await h.execute({op:'artifact.read',artifactId:restored.idMapRef}),mapping=JSON.parse(new TextDecoder().decode(h.f.feature.readAttachment(read.attachmentRef)));
   return ['__proto__','constructor'].map(id=>({id,mapped:Object.hasOwn(mapping,id)&&mapping[id]===id,source:h.f.doc.getText('text:'+id).toString()}));
  });expect(result).toEqual([{id:'__proto__',mapped:true,source:'original'},{id:'constructor',mapped:true,source:'original'}]);
 });
 test('large complete restore plans remain reviewable through bounded artifact reads',async({page})=>{
  await ready(page);await page.evaluate(()=>h.setup());const result=await page.evaluate(async()=>{
   const named=await h.name();h.model.addEntries(h.f.doc,Array.from({length:500},(_,n)=>({path:'extra-'+n+'-'+'x'.repeat(100)+'.tex',content:'new source'})));const plan=await h.execute({op:'history.restorePlan',checkpointRef:named.checkpointRef,mode:'current'}),artifact=plan.summary.detailsArtifact,bytes=new Uint8Array(artifact.size);let offset=0,reads=0;while(offset<bytes.length){const read=await h.execute({op:'artifact.read',artifactId:artifact.artifactId,offset,limit:65536});bytes.set(h.f.feature.readAttachment(read.attachmentRef),offset);offset=read.nextOffset;reads++;}
   const summary=JSON.parse(new TextDecoder().decode(bytes));await h.execute({op:'history.restore',planId:plan.planId});return{complete:plan.complete,reads,hash:h.blob_hash(bytes)===artifact.sha256,removed:summary.changes.filter(change=>change.kind==='delete').length,files:h.f.doc.getMap('files').size};
  });expect(result.complete).toBe(true);expect(result.reads).toBeGreaterThan(1);expect(result.hash).toBe(true);expect(result.removed).toBe(500);expect(result.files).toBe(2);
 });
 test('v2 rights, artifact chunks, retries, cursors and closed session',async({page})=>{
  await ready(page);await page.evaluate(()=>h.setup());const r=await page.evaluate(async()=>{
   const named=await h.name(),limited=h.collaborationCommands({doc:h.f.doc,projectId:h.f.projectId,storage:h.storage,capabilities:['read','history']}),feature=h.mount({doc:h.f.doc,projectId:h.f.projectId,storage:h.storage,commands:limited});
   const req=command=>({version:2,requestId:crypto.randomUUID(),projectId:h.f.projectId,expectedRevision:limited.revision(),command});const denied=[];for(const mode of ['copy','current'])denied.push((await limited.execute(req({op:'history.restorePlan',checkpointRef:named.checkpointRef,mode}))).error.code);feature.close();limited.close();
   const request={version:2,requestId:crypto.randomUUID(),projectId:h.f.projectId,expectedRevision:h.f.commands.revision(),command:{op:'history.name',label:'Retry'}},[a,b]=await Promise.all([h.f.commands.execute(request),h.f.commands.execute(request)]),retry=await h.f.commands.execute(request),list=await h.execute({op:'history.list',limit:1});h.f.doc.getText('text:'+h.f.file).delete(3,1);let cursor;try{await h.execute({op:'history.list',cursor:list.nextCursor});}catch(error){cursor=error.code;}
   const artifact=await h.execute({op:'backup.export'});let bound;try{await h.execute({op:'artifact.read',artifactId:artifact.artifactId,limit:65537});}catch(error){bound=error.code;}h.f.commands.close();const closed=(await h.f.commands.execute(request)).error.code;return{denied,equal:JSON.stringify(a)===JSON.stringify(b)&&JSON.stringify(a)===JSON.stringify(retry),cursor,bound,closed};
  });expect(r).toEqual({denied:['permission_denied','permission_denied'],equal:true,cursor:'revision_conflict',bound:'invalid_request',closed:'project_closed'});
 });
});

test('accessible keyboard history UI names a checkpoint and works after offline reload',async({page,context})=>{
 await page.goto('/');await page.getByRole('button',{name:'Start with a sample paper'}).click();await expect(page.locator('.cm-content')).toBeVisible();await expect(page.locator('.save-indicator')).toHaveText('Saved locally');
 const history=page.getByRole('button',{name:'History',exact:true});await history.focus();await page.keyboard.press('Enter');const panel=page.getByRole('region',{name:'Project history',exact:true});await expect(panel).toBeVisible();await expect(panel.getByRole('button',{name:'Back to editor',exact:true})).toBeFocused();
 await panel.getByRole('button',{name:'Name this version',exact:true}).click();await panel.getByLabel('Version name').fill('Keyboard checkpoint');await page.keyboard.press('Enter');await expect(panel.getByText('Keyboard checkpoint',{exact:true})).toBeVisible();await expect(panel.getByRole('status',{name:'History status'})).toContainText('saved locally');
 const audit=await new AxeBuilder({page}).include('.history-feature').analyze();expect(audit.violations).toEqual([]);expect((await new AxeBuilder({page}).include('.history-view').analyze()).violations).toEqual([]);
 await page.evaluate(()=>navigator.serviceWorker.ready);await expect.poll(()=>page.evaluate(()=>!!navigator.serviceWorker.controller)).toBe(true);await context.setOffline(true);await page.reload();await page.locator('.card-open').first().click();await page.getByRole('button',{name:'History',exact:true}).click();await expect(page.getByRole('region',{name:'Project history',exact:true}).getByText('Keyboard checkpoint',{exact:true})).toBeVisible();
});

for(const corruption of ['missing final entry','empty final update'])test(`failed complete export offers source ZIP for ${corruption}`,async({page})=>{
 await page.goto('/');await page.getByRole('button',{name:'Start with a sample paper'}).click();await expect(page.locator('.save-indicator')).toHaveText('Saved locally');
 await page.getByRole('button',{name:'History',exact:true}).click();const panel=page.getByRole('region',{name:'Project history',exact:true});await panel.getByRole('button',{name:'Name this version',exact:true}).click();await panel.getByLabel('Version name').fill('Export probe');await panel.getByRole('button',{name:'Save version name',exact:true}).click();await expect(panel.getByText('Export probe',{exact:true})).toBeVisible();
 const filename=await page.evaluate(async corruption=>{
  const db=await new Promise((resolve,reject)=>{const req=indexedDB.open('scribyra-v1');req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error);});
  let filename;try{await new Promise((resolve,reject)=>{const tx=db.transaction(['projects','journal'],'readwrite');tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error);const req=tx.objectStore('projects').getAll();req.onsuccess=()=>{const project=req.result[0],store=tx.objectStore('journal'),key=[project.id,project.sequence];filename=project.name.replace(/[^a-zA-Z0-9_-]/g,'_')+'.zip';if(corruption==='missing final entry')store.delete(key);else{const row=store.get(key);row.onsuccess=()=>store.put({...row.result,update:new Uint8Array([0,0])});}};});return filename;}finally{db.close();}
 },corruption);
 const downloads=[];page.on('download',download=>downloads.push(download));await panel.getByRole('button',{name:'Manage history',exact:true}).click();await panel.getByRole('button',{name:'Export complete backup',exact:true}).click();
 await expect(panel.getByRole('status',{name:'History status'})).toContainText('Complete backup could not be exported.');await expect(panel.getByRole('status',{name:'History status'})).toContainText(corruption==='missing final entry'?'journal is incomplete':'Journal head differs');expect(downloads).toHaveLength(0);
 const pending=page.waitForEvent('download');await panel.getByRole('button',{name:'Export source ZIP',exact:true}).click();const download=await pending;expect(download.suggestedFilename()).toBe(filename);const {unzipSync}=await import('fflate'),zip=unzipSync(new Uint8Array(await readFile(await download.path())));expect(Object.keys(zip)).toContain('main.tex');expect(Object.keys(zip)).not.toContain('history.json');
});

test.describe('History view',()=>{
 const start=async page=>{await page.goto('/');await page.getByRole('button',{name:'Start with a sample paper'}).click();await expect(page.locator('.cm-content')).toBeVisible();await expect(page.locator('.save-indicator')).toHaveText('Saved locally');};
 const open=async page=>{await page.getByRole('button',{name:'History',exact:true}).click();const panel=page.getByRole('region',{name:'Project history',exact:true});await expect(panel).toBeVisible();await expect(panel.getByRole('status',{name:'History status'})).toContainText('stored on this device');return panel;};
 const name=async(panel,label)=>{await panel.getByRole('button',{name:'Name this version',exact:true}).first().click();await panel.getByLabel('Version name').fill(label);await panel.getByRole('button',{name:'Save version name',exact:true}).click();await expect(panel.getByRole('option',{name:new RegExp(label)})).toBeVisible();};
 test('replaces the editor, then lists, compares and plans without changing the project',async({page})=>{
  await start(page);let panel=await open(page);
  await expect(page.locator('.cm-content')).toBeHidden();await expect(page.locator('.file-sidebar')).toBeHidden();
  await name(panel,'Draft one');
  await panel.getByRole('button',{name:'Back to editor',exact:true}).click();await expect(panel).toBeHidden();await expect(page.locator('.cm-content')).toBeVisible();await expect(page.getByRole('button',{name:'History',exact:true})).toBeFocused();
  await page.locator('.cm-content').click();await page.keyboard.press('Control+Home');await page.keyboard.type('% edited line\n');await expect(page.locator('.save-indicator')).toHaveText('Saved locally');
  panel=await open(page);const current=panel.getByRole('option',{name:/Current version/});await expect(current).toHaveAttribute('aria-selected','true');await expect(current).toContainText('1 file changed since the last version');
  await expect(panel.getByRole('button',{name:'Name this version',exact:true})).toBeVisible();await expect(panel.getByRole('button',{name:'Restore as a copy',exact:true})).toHaveCount(0);
  await expect(panel.locator('.history-lines tr.add')).toContainText('% edited line');await expect(panel.locator('.history-lines tr.add .num').nth(1)).toHaveText('1');await expect(panel.getByRole('button',{name:/Edited: .*main\.tex/})).toHaveAttribute('aria-current','true');
  await current.focus();await page.keyboard.press('ArrowDown');const draft=panel.getByRole('option',{name:/Draft one/});await expect(draft).toBeFocused();await expect(draft).toHaveAttribute('aria-selected','true');await expect(draft).toHaveAttribute('tabindex','0');await expect(current).toHaveAttribute('tabindex','-1');
  await expect(panel.getByRole('heading',{name:'Draft one',exact:true})).toBeVisible();await expect(panel.locator('.history-restorable')).toHaveText('Restorable');
  await panel.getByRole('button',{name:'Since this version',exact:true}).click();await expect(panel.locator('.history-lines ins')).toContainText('% edited line');
  await panel.getByRole('button',{name:'Restore into this project',exact:true}).click();const plan=page.getByRole('dialog',{name:'Restore into this project?'});await expect(plan).toContainText('1 file will change');await expect(plan).toContainText('Text goes back to this version');await expect(plan).toContainText('Before restore');expect((await new AxeBuilder({page}).include('.history-dialog').analyze()).violations).toEqual([]);await plan.getByRole('button',{name:'Cancel',exact:true}).click();await expect(plan).toBeHidden();await expect(panel.getByRole('button',{name:'Restore into this project',exact:true})).toBeFocused();
  await panel.getByRole('button',{name:'Restore as a copy',exact:true}).click();const copy=page.getByRole('dialog',{name:'Restore as a copy?'});await expect(copy).toContainText('This project stays exactly as it is.');await page.keyboard.press('Escape');await expect(copy).toBeHidden();
  await panel.getByRole('button',{name:'Named versions',exact:true}).click();await expect(panel.getByRole('option')).toHaveCount(1);await expect(draft).toHaveAttribute('tabindex','0');await panel.getByRole('button',{name:'All changes',exact:true}).click();
  await panel.getByRole('button',{name:'Manage history',exact:true}).click();await expect(panel.getByRole('button',{name:'Export complete backup',exact:true})).toBeFocused();await expect(panel).toContainText('includes deleted content and isn’t encrypted');
  await panel.getByRole('button',{name:'Clean up history',exact:true}).click();const cleanup=page.getByRole('dialog',{name:'Clean up history?'});await expect(cleanup.getByRole('region',{name:'Versions kept'})).toContainText('Draft one');await expect(cleanup.getByRole('region',{name:'Versions kept'})).toContainText('Current version');await expect(cleanup.getByRole('region',{name:'Versions removed'})).toBeVisible();await cleanup.getByRole('button',{name:'Cancel',exact:true}).click();
  expect(await panel.innerText()).not.toMatch(/checkpoint|lineage|journal/i);
  for(const theme of ['light','dark']){await page.evaluate(theme=>{document.documentElement.dataset.theme=theme;},theme);expect((await new AxeBuilder({page}).include('.history-view').analyze()).violations).toEqual([]);}
  await page.keyboard.press('Escape');await expect(panel).toBeHidden();await expect(page.locator('.cm-content')).toContainText('% edited line');
 });
 test('restores, copies, cleans up, exports and imports from the view',async({page})=>{
  await start(page);let panel=await open(page);await name(panel,'Keep me');await panel.getByRole('button',{name:'Back to editor',exact:true}).click();
  await page.locator('.cm-content').click();await page.keyboard.press('Control+Home');await page.keyboard.type('% later edit\n');await expect(page.locator('.save-indicator')).toHaveText('Saved locally');
  panel=await open(page);const status=panel.getByRole('status',{name:'History status'});await panel.getByRole('option',{name:/Keep me/}).click();
  await panel.getByRole('button',{name:'Restore as a copy',exact:true}).click();await page.getByRole('dialog',{name:'Restore as a copy?'}).getByRole('button',{name:'Create the copy',exact:true}).click();await expect(status).toContainText('Copy saved as a new project.');await expect(panel.getByRole('button',{name:'Open the new project',exact:true})).toBeVisible();
  await panel.getByRole('button',{name:'Restore into this project',exact:true}).click();await page.getByRole('dialog',{name:'Restore into this project?'}).getByRole('button',{name:'Restore into this project',exact:true}).click();await expect(status).toContainText('Restored.');
  await expect(panel.getByRole('option',{name:/Current version/})).toHaveAttribute('aria-selected','true');await expect(panel.getByRole('option',{name:/Before restore/})).toBeVisible();
  await panel.getByRole('button',{name:'Manage history',exact:true}).click();const download=page.waitForEvent('download');await panel.getByRole('button',{name:'Export complete backup',exact:true}).click();const backup=await(await download).path();await expect(status).toContainText('It includes deleted content and isn’t encrypted.');
  await panel.getByRole('button',{name:'Manage history',exact:true}).click();const chooser=page.waitForEvent('filechooser');await panel.getByRole('button',{name:'Import complete backup',exact:true}).click();await(await chooser).setFiles({name:'project.scribyra-backup',mimeType:'application/zip',buffer:await readFile(backup)});const imported=page.getByRole('dialog',{name:'Import this backup?'});await imported.getByRole('button',{name:'Import as a new project',exact:true}).click();await expect(status).toContainText('Backup added as a new project.');
  await panel.getByRole('button',{name:'Manage history',exact:true}).click();await panel.getByRole('button',{name:'Clean up history',exact:true}).click();const cleanup=page.getByRole('dialog',{name:'Clean up history?'});await cleanup.locator('.modal-actions button').last().click();await expect(status).toContainText('History cleaned up.');await expect(panel.getByRole('option',{name:/Keep me/})).toBeVisible();
  await page.keyboard.press('Escape');await expect(panel).toBeHidden();await expect(page.locator('.cm-content')).not.toContainText('% later edit');
 });
 test('Viewing permits restore as a copy and refuses restoring into the open project',async({page})=>{
  await start(page);let panel=await open(page);await name(panel,'Viewing checkpoint');await panel.getByRole('button',{name:'Back to editor',exact:true}).click();
  await page.getByRole('combobox',{name:'Editor mode'}).selectOption('viewing');panel=await open(page);await panel.getByRole('option',{name:/Viewing checkpoint/}).click();
  await panel.getByRole('button',{name:'Restore into this project',exact:true}).click();await expect(panel.getByRole('status',{name:'History status'})).toContainText('Switch to Editing');
  await panel.getByRole('button',{name:'Restore as a copy',exact:true}).click();await page.getByRole('dialog',{name:'Restore as a copy?'}).getByRole('button',{name:'Create the copy',exact:true}).click();await expect(panel.getByRole('status',{name:'History status'})).toContainText('Copy saved as a new project.');
 });
 test('collapses the version list in a narrow window and keeps it reachable',async({page})=>{
  await page.setViewportSize({width:820,height:700});await start(page);const panel=await open(page);await expect(panel.getByRole('option').first()).toBeHidden();
  // Keep the row laid out but hidden through the first focus attempt.
  await panel.evaluate(panel=>{const column=panel.querySelector('.history-column');column.style.visibility='hidden';panel.querySelector('.history-list-toggle').addEventListener('click',()=>setTimeout(()=>column.style.removeProperty('visibility'),150),{once:true});});
  const toggle=panel.getByRole('button',{name:'Versions',exact:true});await toggle.click();const first=panel.getByRole('option').first();await expect(first).toBeFocused({timeout:5000});await page.keyboard.press('Escape');await expect(first).toBeHidden();await expect(toggle).toBeFocused();await expect(panel).toBeVisible();
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
 });
 test('says a damaged version is not available and offers no restore',async({page})=>{
  await start(page);let panel=await open(page);await name(panel,'Damaged');
  await page.evaluate(async()=>{const db=await new Promise((resolve,reject)=>{const req=indexedDB.open('scribyra-v1');req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error);});try{const rows=await new Promise(resolve=>{const req=db.transaction('historyCatalog').objectStore('historyCatalog').getAll();req.onsuccess=()=>resolve(req.result);}),row=rows.find(row=>row.reason==='named');await new Promise(resolve=>{const tx=db.transaction('historyObjects','readwrite'),store=tx.objectStore('historyObjects'),get=store.get(row.checkpointRef);get.onsuccess=()=>{const bytes=new Uint8Array(get.result.bytes);bytes[0]^=255;store.put({...get.result,bytes});};tx.oncomplete=resolve;});}finally{db.close();}});
  await page.reload();await page.locator('.card-open').first().click();await expect(page.locator('.cm-content')).toBeVisible();panel=await open(page);
  const damaged=panel.getByRole('option',{name:/Damaged/});await expect(damaged).toContainText('Not available on this device');await damaged.click();
  await expect(panel.locator('.history-unavailable')).toContainText('Not available on this device.');for(const action of ['Restore as a copy','Restore into this project','Allow clean-up'])await expect(panel.getByRole('button',{name:action,exact:true})).toHaveCount(0);
 });
});

test.describe('suggestion discussion recovery',()=>{
 test.use({serviceWorkers:'block'});
 test.afterEach(async({page})=>{await page.evaluate(()=>window.h?.close()).catch(()=>{});});
 for(const mode of ['current','copy','backup'])test(`${mode} keeps accepted suggestion replies through storage and reload`,async({page})=>{
  await ready(page);await page.evaluate(()=>h.setup(undefined,true));
  const result=await page.evaluate(async mode=>{
   h.enableDiscussions();const review=await h.execute({op:'review.create',title:'Discussion recovery'}),s=await h.execute({op:'suggestion.propose',reviewId:review.reviewId,fileId:h.f.file,start:3,end:9,before:'before',after:'accepted'});
   const thread=await h.execute({op:'thread.reply',suggestionId:s.suggestionId,body:'Discuss this replacement'}),reply=await h.execute({op:'thread.reply',threadId:thread.threadId,body:'Keep its history'});
   await h.execute({op:'message.edit',messageId:reply.messageId,body:'Edited reply'});await h.execute({op:'suggestion.accept',suggestionIds:[s.suggestionId],eventHeads:{[s.suggestionId]:[]}});
   const named=await h.execute({op:'history.name',label:'Accepted discussion'}),source=h.f.doc.getText('text:'+h.f.file).toString();
   if(mode==='backup'){
    const bytes=new Uint8Array(await h.bytes()),plan=await h.execute({op:'backup.importPlan',attachmentRef:'backup'},new Map([['backup',bytes]])),copy=await h.execute({op:'backup.import',planId:plan.planId});
    h.close();await h.setup(copy.projectId,true);h.enableDiscussions();
   }else{
    h.f.doc.getText('text:'+h.f.file).insert(0,'later ');await h.execute({op:'thread.reply',threadId:thread.threadId,body:'Later reply'});
    const plan=await h.execute({op:'history.restorePlan',checkpointRef:named.checkpointRef,mode}),restored=await h.execute({op:'history.restore',planId:plan.planId});
    if(mode==='copy'){h.close();await h.setup(restored.projectId,true);h.enableDiscussions();}
   }
   const projectId=h.f.projectId;await h.storage.saveProject(projectId,h.f.doc);h.close();await h.setup(projectId,true);h.enableDiscussions();
   const detail=await h.execute({op:'thread.get',id:thread.threadId}),before=h.f.doc.getText('text:'+h.f.file).toString();await h.execute({op:'thread.reply',suggestionId:s.suggestionId,body:'After recovery'});
   return{source,before,after:h.f.doc.getText('text:'+h.f.file).toString(),suggestionId:s.suggestionId,detail};
  },mode);
  expect(result.before).toBe(result.source);expect(result.after).toBe(result.source);expect(result.detail.thread).toMatchObject({suggestionId:result.suggestionId,status:'resolved',messageCount:2});expect(result.detail.items.flatMap(i=>i.variants||[]).map(v=>v.body)).toEqual(['Discuss this replacement','Edited reply']);
 });
});
