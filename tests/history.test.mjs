import 'fake-indexeddb/auto';
import './helpers/core.mjs';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {openDB} from 'idb';
import * as Y from 'yjs';
import * as storage from '../web/storage.js';
import {assetBytes,cloneProject} from '../web/assets.js';
import {addFile,migrateProject} from '../web/model.js';
import {blob_hash} from '../web/pkg/scribyra_app.js';
import {lineageForProject} from '../web/collaboration-schema.js';
import {authorChip,fileChanges,groupByDay,parsePatch,restoreLine,sizeChange,summaryOf} from '../web/history-view.js';
const fixture=version=>JSON.parse(readFileSync(new URL(`./fixtures/foundation/schema-${version}.json`,import.meta.url)));
async function install(f,id){
 await storage.listProjects();const db=await openDB('scribyra-v1'),update=new Uint8Array(f.update),tx=db.transaction(['projects','heads','checkpoints','blobs','projectBlobs','migrationBackups'],'readwrite');
 const record={id,schemaVersion:f.version,sequence:0,name:'Fixture',updatedAt:1,files:2,update};await tx.objectStore('projects').put(record);await tx.objectStore('heads').put({...record,update:undefined,deleted:false});await tx.objectStore('checkpoints').put({projectId:id,sequence:0,update});await tx.objectStore('migrationBackups').put({...record,update:new Uint8Array(f.firstBackup)});
 if(f.version>=4){await tx.objectStore('blobs').put({hash:f.asset.hash,bytes:new Uint8Array(f.asset.bytes)});await tx.objectStore('projectBlobs').put({projectId:id,hash:f.asset.hash});}await tx.done;return db;
}
for(let version=1;version<=5;version++)test(`schema ${version} migration preserves exact recovery bytes, first backup, lock, source and history`,async()=>{
 const f=fixture(version),id=f.projectId,db=await install(f,id),before=await db.get('projects',id),doc=await storage.loadProject(id);
 assert.equal(doc.getMap('meta').get('schemaVersion'),8);assert.equal(doc.getMap('meta').get('lineageId'),lineageForProject(id));assert.equal(doc.getText('text:tex').toString(),f.source);assert.equal(doc.getText('text:deleted').toString(),'Deleted but recoverable 😀');assert.deepEqual(doc.getMap('meta').get('texEnvironment')??null,f.lock);assert.deepEqual(assetBytes(doc,'asset'),new Uint8Array(f.asset.bytes));
 assert.deepEqual((await storage.migrationBackupV2(id,version)).update,before.update);assert.deepEqual(await storage.migrationBackup(id),new Uint8Array(f.firstBackup));assert.equal((await db.get('projects',id)).sequence,1);
 const historical=await storage.loadRevision(id,0);assert.deepEqual(Y.encodeStateAsUpdate(historical),before.update);await assert.rejects(storage.saveProject(id,historical),/upgraded/);
 const stable=Y.encodeStateAsUpdate(doc);const reopened=await storage.loadProject(id);assert.deepEqual(Y.encodeStateAsUpdate(reopened),stable);for(const d of [doc,historical,reopened])d.destroy();db.close();
});
for(const store of ['migrationBackupsV2','blobs','journal','checkpoints','projects','heads'])test(`disk full at ${store} rolls back all migration writes and permits retry`,async()=>{
 const f=fixture(3),id=`failure-${store}`,legacy=new Y.Doc();Y.applyUpdate(legacy,new Uint8Array(f.update));const unique=new TextEncoder().encode(store);legacy.getMap('assets').set('asset',unique);f.update=Array.from(Y.encodeStateAsUpdate(legacy));f.asset={hash:blob_hash(unique),bytes:Array.from(unique)};legacy.destroy();
 const db=await install(f,id),before=await db.get('projects',id),put=IDBObjectStore.prototype.put;
 IDBObjectStore.prototype.put=function(...args){if(this.name===store)throw new DOMException('Injected disk full','QuotaExceededError');return put.apply(this,args);};
 try{await assert.rejects(storage.loadProject(id),/disk full/);}finally{IDBObjectStore.prototype.put=put;}
 assert.deepEqual(await db.get('projects',id),before);assert.equal(await db.get('migrationBackupsV2',[id,3]),undefined);assert.deepEqual(await storage.migrationBackup(id),new Uint8Array(f.firstBackup));assert.equal((await db.getAllFromIndex('journal','projectId',id)).length,0);
 const doc=await storage.loadProject(id);assert.deepEqual(assetBytes(doc,'asset'),new Uint8Array(f.asset.bytes));doc.destroy();db.close();
});
test('guarded commits atomically stage immutable objects/pins and reject races and failures',async()=>{
 const doc=new Y.Doc(),file=addFile(doc,'main.tex','base'),id=crypto.randomUUID();await storage.saveProject(id,doc);const staged=cloneProject(doc);staged.getText(`text:${file}`).insert(0,'prepared ');
 const bytes=new Uint8Array([1,2,3]),hash=blob_hash(bytes),objects=[{hash,bytes}],pins=[{hash,pin:'checkpoint:fixture'}];
 const results=await Promise.allSettled([storage.commitPrepared(id,0,Y.encodeStateAsUpdate(staged),objects,pins),storage.commitPrepared(id,0,Y.encodeStateAsUpdate(staged),objects,pins)]);assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal(results.find(r=>r.status==='rejected').reason.code,'revision_conflict');
 const db=await openDB('scribyra-v1');assert.deepEqual((await db.get('historyObjects',hash)).bytes,bytes);assert.equal((await db.getAllFromIndex('projectHistoryObjects','projectId',id)).length,1);
 const missing='f'.repeat(64);await assert.rejects(storage.commitPrepared(id,1,Y.encodeStateAsUpdate(staged),[],[{hash:missing,pin:'missing'}]),/missing/);assert.equal((await db.get('projects',id)).sequence,1);
 await storage.deleteProject(id);assert.equal(await db.get('historyObjects',hash),undefined);db.close();doc.destroy();staged.destroy();
});
test('ordinary saves and merged local publication reject invalid semantic state',async()=>{
 const doc=new Y.Doc();addFile(doc,'main.tex','source');const id=crypto.randomUUID();await storage.saveProject(id,doc);doc.getMap('messages').set('bad',{version:1,id:'bad',body:'broken'});await assert.rejects(storage.saveProject(id,doc),/Invalid collaboration/);const loaded=await storage.loadProject(id);assert.equal(loaded.getMap('messages').size,0);doc.destroy();loaded.destroy();
});
test('pre-journal migrations keep an original checkpoint and a distinct migration sequence',async()=>{
 const f=fixture(1),id='without-journal',db=await install(f,id),record=await db.get('projects',id);delete record.sequence;await db.put('projects',record);await db.delete('checkpoints',[id,0]);const migrated=await storage.loadProject(id),old=await storage.loadRevision(id,0);
 assert.equal((await db.get('projects',id)).sequence,1);assert.deepEqual(Y.encodeStateAsUpdate(old),new Uint8Array(f.update));assert.equal((await db.get('journal',[id,1])).version,1);migrated.destroy();old.destroy();db.close();
});

import {bufferMutation,durableCommand,committedOutcome,closedDurable} from './helpers/foundation-regressions.js';
for(const kind of ['buffer','bytes','dataView','words'])test(`prepared ${kind} bytes are owned before the first await`,async()=>{
 assert.deepEqual(await bufferMutation(kind),{hashMatches:true,bytesMatch:true,pinned:true,source:'source'});
});
for(const op of ['history.name','suggestion.accept'])for(const mode of ['success','writeFailure','revoked','closed','revision','transactionRevoked','transactionRevision'])test(`${op} durable gateway: ${mode}`,async()=>{
 const result=await durableCommand(op,mode);assert.deepEqual(result.before,{settled:false,sequence:0});assert.equal(result.reused,'request_id_reused');
 if(mode==='success'){
  assert.equal(result.reply.ok,true);assert.deepEqual(result.again,result.reply);assert.deepEqual(result.completed,result.reply);assert.equal(result.sequence,1);assert.equal(result.pins,1);assert.equal(result.commits,1);assert.equal(result.prepares,1);assert.equal(result.other,'revision_conflict');assert.equal(result.source,'accepted base');
 }else{
  const code=mode==='writeFailure'?'quota_exceeded':mode.toLowerCase().includes('revision')?'revision_conflict':'project_closed';
  assert.equal(result.reply.error.code,code);assert.equal(result.again.error.code,code);assert.equal(result.sequence,0);assert.equal(result.pins,0);assert.ok(!result.source.includes('accepted'));if(mode==='writeFailure')assert.equal(result.completed.ok,true);else assert.equal(result.completed.error.code,code);
 }
});

for(const throwing of [false,true])test(`committed acceptance survives post-guard typing and handler failure=${throwing}`,async()=>{
 const r=await committedOutcome(throwing);assert.equal(r.reply.ok,true);assert.equal(r.reply.value.localSequence,1);assert.ok(r.reply.value.acceptanceId);
 for(const retry of [r.again,r.atBoundary,r.completed])assert.deepEqual(retry,r.reply);
 assert.equal(r.commits,1);assert.equal(r.sequence,1);assert.equal(r.boundarySource,'base typed');assert.equal(r.handlerSource,'base typed');assert.equal(r.source,'accepted base typed');assert.equal(r.stored,'accepted base');
});
for(const mode of ['waiting','transaction'])test(`closing a never-settling handler releases other hosts: ${mode}`,async()=>{
 const r=await closedDurable(mode);assert.deepEqual(r,{closed:'project_closed',again:'project_closed',live:true,synchronous:true,lateCode:'project_closed',signalAborted:true,startedAfterEnd:true,transactionResult:mode==='transaction'?'AbortError':undefined,sequence:1});
});

import {registerHooks} from 'node:module';
registerHooks({load(url,context,next){return url.endsWith('.css')?{format:'module',source:'',shortCircuit:true}:next(url,context);}});
const {mount:mountHistory}=await import('../web/history.js');
const {collaborationCommands}=await import('../web/collaboration-commands.js');
const {addEntries,deleteNode,replaceAsset,relocateNode,exportZip}=await import('../web/model.js');
const {checkpoint,verifiedCheckpoint,inventory,replay:replayState,decode,recordChange,discussionProjection,restoreCurrent}=await import('../web/history-storage.js');
const {exportBackup,importBackup,unpack}=await import('../web/history-backup.js');
const {unzipSync,zipSync}=await import('fflate');
const id=()=>crypto.randomUUID();
const oldImage=new Uint8Array([137,80,78,71,13,10,26,10,1,2,3]),newImage=new Uint8Array([137,80,78,71,13,10,26,10,4,5,6]);
function discussion(doc,file){
 const authorId=id(),changeId=id(),threadId=id(),messageId=id(),anchorId=id(),reviewId=id(),suggestionId=id(),common={version:1,authorId,changeId,createdAt:10};
 doc.getMap('authors').set(authorId,{...common,id:authorId,kind:'human',displayName:'Fixture author',ownerAuthorId:null});
 const text=doc.getText('text:'+file),start=Y.createRelativePositionFromTypeIndex(text,3,0),end=Y.createRelativePositionFromTypeIndex(text,9,-1);
 doc.getMap('anchors').set(anchorId,{...common,id:anchorId,fileId:file,kind:'range',start:Y.relativePositionToJSON(start),end:Y.relativePositionToJSON(end),witnesses:[{...start.item,length:6}],quote:'before',prefix:'😀 ',suffix:'\nsecond line\n',pathAtCreation:'main.tex'});
 doc.getMap('threads').set(threadId,{...common,id:threadId,anchorId,reviewId:null,firstMessageId:messageId});
 doc.getMap('messages').set(messageId,{...common,id:messageId,threadId,replyToId:null,body:'Original comment 😀',mentionAuthorIds:[]});
 doc.getMap('reviews').set(reviewId,{...common,id:reviewId,title:'Opaque review',baseCheckpointRef:null,acceptanceAuthorityId:authorId,authorityEpoch:1});
 doc.getMap('suggestions').set(suggestionId,{...common,id:suggestionId,reviewId,anchorId,baseDigest:blob_hash(new TextEncoder().encode('before')),before:'before',after:'after',supersedesId:null});
 recordChange(doc,{id:authorId,displayName:'Fixture author'},{id:changeId,kind:'fixture',fileIds:[]});
 return{authorId,changeId,threadId,messageId,reviewId,anchorId,suggestionId,common};
}
async function historyFixture({capabilities}={}){
 const doc=new Y.Doc(),projectId=id(),[file,image,deleted]=addEntries(doc,[{path:'main.tex',content:'😀 before\nsecond line\n'},{path:'image.png',content:oldImage},{path:'deleted.png',content:oldImage}]);
 doc.getMap('meta').set('name','History fixture');doc.getMap('meta').set('mainFile',file);const state=discussion(doc,file);deleteNode(doc,deleted);await storage.saveProject(projectId,doc);
 const commands=collaborationCommands({doc,projectId,storage,capabilities}),feature=mountHistory({doc,projectId,storage,commands,author:{id:id(),displayName:'Restorer'},flushSave:async()=>{const result=await storage.saveProject(projectId,doc);Y.applyUpdate(doc,result.update);}});
 const exec=async(command,attachments)=>{const reply=await commands.execute({version:2,requestId:id(),projectId,expectedRevision:commands.revision(),command},attachments);if(!reply.ok)throw Object.assign(new Error(reply.error.message),{code:reply.error.code});return reply.value;};
 return{doc,projectId,file,image,deleted,state,commands,feature,exec,close(){feature.close();commands.close();doc.destroy();}};
}
async function namedFixture(){const f=await historyFixture();f.named=await f.exec({op:'history.name',label:'Original version'});return f;}
async function mutateFixture(f){
 f.doc.getText('text:'+f.file).delete(3,6);f.doc.getText('text:'+f.file).insert(3,'after');replaceAsset(f.doc,f.image,newImage);relocateNode(f.doc,f.file,'renamed.tex');
 const eventId=id();f.doc.getMap('discussionEvents').set(eventId,{...f.state.common,id:eventId,targetId:f.state.threadId,parents:[],kind:'threadResolve',payload:{}});
 recordChange(f.doc,{id:f.state.authorId,displayName:'Fixture author'},{kind:'source-edit',fileIds:[f.file]});
 const result=await storage.saveProject(f.projectId,f.doc);Y.applyUpdate(f.doc,result.update);
}
async function bytesFromArtifact(f,artifact){const pieces=[];for(let offset=0;offset<artifact.size;){const read=await f.exec({op:'artifact.read',artifactId:artifact.artifactId,offset,limit:65536});pieces.push(f.feature.readAttachment(read.attachmentRef));offset=read.nextOffset;assert.equal(read.eof,offset===artifact.size);}const bytes=new Uint8Array(artifact.size);let offset=0;for(const piece of pieces){bytes.set(piece,offset);offset+=piece.length;}assert.equal(blob_hash(bytes),artifact.sha256);return bytes;}

test('named manifest verifies exact deleted asset and opaque original discussion; source ZIP excludes history',async()=>{
 const f=await namedFixture();try{
  const inv=inventory(await storage.readHistoryData(f.projectId)),cp=verifiedCheckpoint(f.named.checkpointRef,inv.objects,(await storage.readHistoryData(f.projectId)).blobs);
  assert.equal(cp.doc.getMap('versions').size,0);assert.deepEqual(assetBytes(cp.doc,f.deleted),oldImage);assert.equal(cp.doc.getMap('messages').get(f.state.messageId).body,'Original comment 😀');assert.equal(cp.doc.getMap('discussionEvents').size,0);cp.doc.destroy();
  const zip=unzipSync(exportZip(f.doc));assert.deepEqual(Object.keys(zip).sort(),['image.png','main.tex']);assert.equal(new TextDecoder().decode(zip['main.tex']),'😀 before\nsecond line\n');
 }finally{f.close();}
});
test('stable-ID diffs report Unicode text, rename, asset, discussion and all contributors',async()=>{
 const f=await namedFixture();try{await mutateFixture(f);const result=await f.exec({op:'history.diff',fromCheckpoint:f.named.checkpointRef});assert.ok(result.changes.some(c=>c.kind==='rename'&&c.fileId===f.file));assert.ok(result.changes.some(c=>c.kind==='text'&&c.start===3));assert.ok(result.changes.some(c=>c.kind==='asset'&&c.before.hash===blob_hash(oldImage)&&c.after.hash===blob_hash(newImage)));assert.ok(result.changes.some(c=>c.kind==='discussion'));assert.ok(result.contributors.includes(f.state.authorId));}finally{f.close();}
});
test('complete backup preserves names, journal, migration copies and all historical bytes after deletion',async()=>{
 const f=await namedFixture();try{await mutateFixture(f);const artifact=await f.exec({op:'backup.export'}),bytes=await bytesFromArtifact(f,artifact),data=importBackup(bytes),inv=inventory(data),old=verifiedCheckpoint(f.named.checkpointRef,inv.objects,data.blobs);
  assert.deepEqual(assetBytes(old.doc,f.deleted),oldImage);assert.deepEqual(assetBytes(old.doc,f.image),oldImage);assert.equal(old.doc.getText('text:'+f.file).toString(),'😀 before\nsecond line\n');assert.equal(old.doc.getMap('discussionEvents').size,0);old.doc.destroy();assert.ok(data.journal.length>=2);assert.equal(inv.items.find(v=>v.versionId===f.named.versionId).available,true);
  await storage.deleteProject(f.projectId);const fresh=await historyFixture();try{const attachment=id(),plan=await fresh.exec({op:'backup.importPlan',attachmentRef:attachment},new Map([[attachment,bytes]])),installed=await fresh.exec({op:'backup.import',planId:plan.planId}),loaded=await storage.loadProject(installed.projectId);assert.notEqual(loaded.getMap('meta').get('lineageId'),f.doc.getMap('meta').get('lineageId'));assert.equal(loaded.getMap('versions').has(f.named.versionId),true);loaded.destroy();}finally{fresh.close();}
 }finally{f.close();}
});
test('restore as copy preserves original bytes and restores original identities, assets and discussion',async()=>{
 const f=await namedFixture();try{await mutateFixture(f);const before=Y.encodeStateAsUpdate(f.doc),plan=await f.exec({op:'history.restorePlan',checkpointRef:f.named.checkpointRef,mode:'copy'}),result=await f.exec({op:'history.restore',planId:plan.planId}),copy=await storage.loadProject(result.projectId);
  assert.deepEqual(Y.encodeStateAsUpdate(f.doc),before);assert.equal(inventory(await storage.readHistoryData(result.projectId)).items.length,1);assert.equal(copy.getText('text:'+f.file).toString(),'😀 before\nsecond line\n');assert.deepEqual(assetBytes(copy,f.deleted),oldImage);assert.equal(copy.getMap('messages').get(f.state.messageId).body,'Original comment 😀');assert.notEqual(copy.getMap('meta').get('lineageId'),f.doc.getMap('meta').get('lineageId'));assert.equal((await import('../web/review-commands.js')).projectedRecord(copy,'reviews',f.state.reviewId).acceptanceAuthorityId,copy.getMap('changes').get(result.changeId).authorId);copy.destroy();
 }finally{f.close();}
});
test('current restore is a new attributed edit with a pinned pre-restore checkpoint and complete ID map',async()=>{
 const f=await namedFixture();try{await mutateFixture(f);const before=Y.encodeStateAsUpdate(f.doc),plan=await f.exec({op:'history.restorePlan',checkpointRef:f.named.checkpointRef,mode:'current'}),result=await f.exec({op:'history.restore',planId:plan.planId});
  assert.equal(f.doc.getText('text:'+f.file).toString(),'😀 before\nsecond line\n');assert.deepEqual(assetBytes(f.doc,f.image),oldImage);const change=f.doc.getMap('changes').get(result.changeId);assert.equal(change.kind,'restore');assert.equal(change.restoreOf,inventory(await storage.readHistoryData(f.projectId)).items.find(v=>v.checkpointRef===f.named.checkpointRef).checkpointId);
  const data=await storage.readHistoryData(f.projectId),pre=data.historyCatalog.find(row=>row.reason==='pre-restore'),cp=verifiedCheckpoint(pre.checkpointRef,data.objects,data.blobs);assert.deepEqual(cp.update,before);cp.doc.destroy();
  const mapping=await f.exec({op:'artifact.read',artifactId:result.idMapRef});assert.equal(JSON.parse(new TextDecoder().decode(f.feature.readAttachment(mapping.attachmentRef)))[f.file],f.file);assert.ok([...f.doc.getMap('discussionEvents').values()].some(e=>e.kind==='restoreProjection'&&e.targetId===f.state.threadId));
 }finally{f.close();}
});
for(const mode of ['copy','current'])test(`stale ${mode} restore plans reject deletion-only live edits without changing the project`,async()=>{
 const f=await namedFixture();try{const plan=await f.exec({op:'history.restorePlan',checkpointRef:f.named.checkpointRef,mode}),text=f.doc.getText('text:'+f.file);text.delete(3,1);const before=Y.encodeStateAsUpdate(f.doc);await assert.rejects(f.exec({op:'history.restore',planId:plan.planId}),{code:'revision_conflict'});assert.deepEqual(Y.encodeStateAsUpdate(f.doc),before);}finally{f.close();}
});
test('compaction lists exact removals, retains names and shared blobs, and deletion-only stale replicas converge',async()=>{
 const f=await namedFixture(),stale=cloneProject(f.doc);try{
  await mutateFixture(f);const sharedBytes=new Uint8Array([9,8,7]);replaceAsset(f.doc,f.image,sharedBytes);await storage.saveProject(f.projectId,f.doc);replaceAsset(f.doc,f.image,newImage);await storage.saveProject(f.projectId,f.doc);for(let n=0;n<51;n++){f.doc.getText('text:'+f.file).insert(0,'x');await storage.saveProject(f.projectId,f.doc);}
  const other=new Y.Doc(),[shared]=addEntries(other,[{path:'shared.png',content:sharedBytes}]),otherId=id();await storage.saveProject(otherId,other);
  const plan=await f.exec({op:'history.compactPlan',keepCheckpointIds:[]});assert.ok(plan.summary.removedSequences.length>0);const result=await f.exec({op:'history.compact',planId:plan.planId});assert.deepEqual(result.removedSequences,plan.summary.removedSequences);const data=await storage.readHistoryData(f.projectId),inv=inventory(data);assert.equal(inv.items.find(v=>v.versionId===f.named.versionId).available,true);for(const removed of result.removedCheckpointIds)assert.ok(!inv.items.some(item=>item.available&&item.checkpointId===removed));const cp=verifiedCheckpoint(f.named.checkpointRef,inv.objects,data.blobs);assert.deepEqual(assetBytes(cp.doc,f.deleted),oldImage);cp.doc.destroy();
  await assert.rejects(storage.loadRevision(f.projectId,result.removedSequences[0]),/journal|incomplete|checkpoint/);const sharedDoc=await storage.loadProject(otherId);assert.deepEqual(assetBytes(sharedDoc,shared),sharedBytes);sharedDoc.destroy();assert.ok(result.releasedAssetHashes.includes(blob_hash(sharedBytes)));const db=await openDB('scribyra-v1');assert.equal(await db.get('projectBlobs',[f.projectId,blob_hash(sharedBytes)]),undefined);assert.ok(await db.get('blobs',blob_hash(sharedBytes)));db.close();
  stale.getText('text:'+f.file).delete(3,1);const current=await storage.loadProject(f.projectId),vector=Y.encodeStateVector(current);Y.applyUpdate(stale,Y.encodeStateAsUpdate(current));Y.applyUpdate(current,Y.encodeStateAsUpdate(stale));assert.deepEqual(Y.encodeStateAsUpdate(stale),Y.encodeStateAsUpdate(current));assert.ok(vector.length>0);current.destroy();other.destroy();
  const backup=importBackup(exportBackup(await storage.readHistoryData(f.projectId)));assert.ok(inventory(backup).items.every(item=>item.available));
 }finally{stale.destroy();f.close();}
});
for(const operation of ['name','restore','compact','import'])test(`quota failure during ${operation} rolls back head, objects, catalog and installation`,async()=>{
 const f=await namedFixture();try{
  await mutateFixture(f);let command;if(operation==='name')command={op:'history.name',label:'Failing'};
  if(operation==='restore'){const p=await f.exec({op:'history.restorePlan',checkpointRef:f.named.checkpointRef,mode:'current'});command={op:'history.restore',planId:p.planId};}
  if(operation==='compact'){const p=await f.exec({op:'history.compactPlan',keepCheckpointIds:[]});command={op:'history.compact',planId:p.planId};}
  if(operation==='import'){const bytes=exportBackup(await storage.readHistoryData(f.projectId)),ref=id(),p=await f.exec({op:'backup.importPlan',attachmentRef:ref},new Map([[ref,bytes]]));command={op:'backup.import',planId:p.planId};}
  const before=await storage.readHistoryData(f.projectId),projects=await storage.listProjects(),live=Y.encodeStateAsUpdate(f.doc),put=IDBObjectStore.prototype.put;
  IDBObjectStore.prototype.put=function(...args){if(this.name==='historyCatalog'&&operation!=='compact'||this.name==='historyObjects'&&operation==='name'||this.name==='projects'&&['import','compact'].includes(operation))throw new DOMException('History disk full','QuotaExceededError');return put.apply(this,args);};
  try{await assert.rejects(f.exec(command),{code:'quota_exceeded'});}finally{IDBObjectStore.prototype.put=put;}
  // History format 2: clean-up first merges steps between versions (every listed state unchanged), so for
  // compact the journal rows may be merged; versions, head, catalogue, objects and assets are as before.
  if(operation==='compact'){const after=await storage.readHistoryData(f.projectId),view=data=>({...data,journal:undefined,checkpoints:undefined,versions:inventory(data).items.map(({checkpointRef,...item})=>item.journal?{...item,checkpointRef}:item)});assert.deepEqual(view(after),view(before));for(const item of inventory(before).items.filter(item=>item.journal)){const a=replayState(before,item.sequence),b=replayState(after,item.sequence);try{assert.deepEqual(Y.encodeStateAsUpdate(b),Y.encodeStateAsUpdate(a));}finally{a.destroy();b.destroy();}}}
  else assert.deepEqual(await storage.readHistoryData(f.projectId),before);assert.deepEqual(await storage.listProjects(),projects);assert.deepEqual(Y.encodeStateAsUpdate(f.doc),live);
 }finally{f.close();}
});
test('corrupt/missing chunks and future schema fail closed; unavailable names never claim Restorable',async()=>{
 const f=await namedFixture();try{const data=await storage.readHistoryData(f.projectId),cp=JSON.parse(new TextDecoder().decode(data.objects.find(o=>o.hash===f.named.checkpointRef).bytes)),db=await openDB('scribyra-v1');await db.delete('historyObjects',cp.updateChunks[0].hash);await assert.rejects(f.exec({op:'backup.export'}),/missing/);await assert.rejects(f.exec({op:'history.restorePlan',checkpointRef:f.named.checkpointRef,mode:'copy'}),/missing/);db.close();
  const bad=structuredClone(data);bad.checkpoints=[];bad.objects.find(o=>o.hash===cp.updateChunks[0].hash).bytes[0]^=255;assert.equal(inventory(bad).items.find(item=>item.versionId===f.named.versionId).available,false);await assert.rejects(Promise.resolve().then(()=>exportBackup(bad)),/incomplete|unavailable/);
  const update=cloneProject(f.doc);update.getMap('meta').set('schemaVersion',9);assert.throws(()=>checkpoint(update),/newer/);update.destroy();
 }finally{f.close();}
});
test('backup rejects journal gaps, malformed archives, duplicate paths, bad hashes and hidden metadata',async()=>{
 const f=await namedFixture();try{await mutateFixture(f);const data=await storage.readHistoryData(f.projectId),gap=structuredClone(data);gap.journal.shift();assert.throws(()=>exportBackup(gap),/gap|incomplete/);
  const bytes=exportBackup(data),entries=Object.fromEntries(unpack(bytes));entries['../private']=new Uint8Array([1]);assert.throws(()=>importBackup(zipSync(entries)),{code:'incomplete_backup'});delete entries['../private'];entries['project.update'][0]^=1;assert.throws(()=>importBackup(zipSync(entries)),{code:'incomplete_backup'});
  f.doc.getMap('meta').set('providerToken','must not export');await storage.saveProject(f.projectId,f.doc);assert.throws(()=>exportBackup({...data,project:{...data.project,update:Y.encodeStateAsUpdate(f.doc)}}),/private connection state/);
 }finally{f.close();}
});
test('restore mode rights, artifact bounds, cursor invalidation, retries and close remain enforced',async()=>{
 const f=await namedFixture();try{
  const limited=collaborationCommands({doc:f.doc,projectId:f.projectId,storage,capabilities:['history','read']}),feature=mountHistory({doc:f.doc,projectId:f.projectId,commands:limited,storage,author:{id:id(),displayName:'Limited'}}),request=command=>({version:2,requestId:id(),projectId:f.projectId,expectedRevision:limited.revision(),command});
  for(const mode of ['copy','current'])assert.equal((await limited.execute(request({op:'history.restorePlan',checkpointRef:f.named.checkpointRef,mode}))).error.code,'permission_denied');feature.close();limited.close();
  const req={version:2,requestId:id(),projectId:f.projectId,expectedRevision:f.commands.revision(),command:{op:'history.name',label:'Retry'}};const [a,b]=await Promise.all([f.commands.execute(req),f.commands.execute(req)]);assert.equal(a.ok,true);assert.deepEqual(b,a);assert.deepEqual(await f.commands.execute(req),a);
  const list=await f.exec({op:'history.list',limit:1});f.doc.getText('text:'+f.file).insert(0,'x');await assert.rejects(f.exec({op:'history.list',cursor:list.nextCursor}),{code:'revision_conflict'});
  const art=await f.exec({op:'backup.export'});await assert.rejects(f.exec({op:'artifact.read',artifactId:art.artifactId,limit:65537}),{code:'invalid_request'});f.commands.close();assert.equal((await f.commands.execute(req)).error.code,'project_closed');
 }finally{f.close();}
});

for(let version=1;version<=5;version++)test(`complete backup roundtrips schema-${version} migration and exact earlier recovery copies`,async()=>{
 const f=fixture(version),data=await storage.readHistoryData(f.projectId),bytes=exportBackup(data),imported=importBackup(bytes);
 assert.deepEqual(inventory(data).items.map(item=>item.checkpointRef),inventory(imported).items.map(item=>item.checkpointRef));
 assert.deepEqual(imported.migrationBackup.update,new Uint8Array(f.firstBackup));assert.deepEqual(imported.migrationBackupsV2.find(row=>row.fromVersion===version).update,new Uint8Array(f.update));
 assert.deepEqual(imported.checkpoints.find(row=>row.sequence===0).update,new Uint8Array(f.update));
});
test('explicit recovery preserves absent lineage but refuses to install a duplicate original',async()=>{
 const f=await namedFixture();try{
  const bytes=exportBackup(await storage.readHistoryData(f.projectId)),lineage=f.doc.getMap('meta').get('lineageId'),ref=id(),plan=await f.exec({op:'backup.importPlan',attachmentRef:ref,mode:'recovery'},new Map([[ref,bytes]]));
  await assert.rejects(f.exec({op:'backup.import',planId:plan.planId}),/already exists/);
  await storage.deleteProject(f.projectId);const fresh=await historyFixture();try{const ref=id(),plan=await fresh.exec({op:'backup.importPlan',attachmentRef:ref,mode:'recovery'},new Map([[ref,bytes]])),result=await fresh.exec({op:'backup.import',planId:plan.planId}),recovered=await storage.loadProject(result.projectId);assert.equal(recovered.getMap('meta').get('lineageId'),lineage);assert.ok(result.changeId);assert.equal(recovered.getMap('changes').get(result.changeId).kind,'backup-import');recovered.destroy();}finally{fresh.close();}
 }finally{f.close();}
});
test('bounded ZIP parser rejects duplicate directory entries and false expanded-size claims before install',async()=>{
 const f=await namedFixture();try{
  const bytes=exportBackup(await storage.readHistoryData(f.projectId)),mutate=(change)=>{const copy=bytes.slice(),v=new DataView(copy.buffer);let end=copy.length-22;while(v.getUint32(end,true)!==0x06054b50)end--;const start=v.getUint32(end+16,true);change(v,start,end,copy);return copy;};
  const oversize=mutate((v,start)=>v.setUint32(start+24,512*1024*1024+1,true));assert.throws(()=>importBackup(oversize),{code:'incomplete_backup'});
  const falseSize=mutate((v,start)=>{const offset=v.getUint32(start+42,true);v.setUint32(start+24,1,true);v.setUint32(offset+22,1,true);});assert.throws(()=>importBackup(falseSize),{code:'incomplete_backup'});
  const duplicate=mutate((v,start,end,copy)=>{const second=start+46+v.getUint16(start+28,true)+v.getUint16(start+30,true)+v.getUint16(start+32,true);v.setUint32(second+42,v.getUint32(start+42,true),true);});assert.throws(()=>importBackup(duplicate),{code:'incomplete_backup'});
 }finally{f.close();}
});

test('ZIP64 entry counts support the format-1 upper range without wrapping the directory count',async()=>{
 const {pack}=await import('../web/history-backup.js'),entries=new Map();for(let n=0;n<65536;n++)entries.set('objects/'+n.toString(16).padStart(64,'0'),new Uint8Array());
 const bytes=pack(entries,{level:0}),result=unpack(bytes);assert.equal(result.size,65536);assert.equal(result.get('objects/'+'f'.repeat(0)+'ffff'.padStart(64,'0')).length,0);
});

test('restore plans allocate and disclose type-collision IDs without reusing incompatible text identities',async()=>{
 const f=await namedFixture();try{
  const {prepareBlob}=await import('../web/assets.js'),node=f.doc.getMap('files').get(f.file);f.doc.getMap('files').set(f.file,{...node,binary:true});f.doc.getMap('assets').set(f.file,prepareBlob(f.doc,newImage));f.doc.getMap('meta').set('mainFile','');await storage.saveProject(f.projectId,f.doc);
  const plan=await f.exec({op:'history.restorePlan',checkpointRef:f.named.checkpointRef,mode:'current'});assert.equal(plan.summary.idChanges.length,1);const result=await f.exec({op:'history.restore',planId:plan.planId}),read=await f.exec({op:'artifact.read',artifactId:result.idMapRef}),mapping=JSON.parse(new TextDecoder().decode(f.feature.readAttachment(read.attachmentRef)));
  assert.notEqual(mapping[f.file],f.file);assert.equal(f.doc.getText('text:'+mapping[f.file]).toString(),'😀 before\nsecond line\n');assert.equal(f.doc.getMap('files').has(f.file),false);assert.equal(f.doc.getMap('meta').get('mainFile'),mapping[f.file]);
 }finally{f.close();}
});

test('unpin is an explicit event; reviewed compaction releases the checkpoint without advertising it again',async()=>{
 const f=await historyFixture();try{
  f.doc.getText('text:'+f.file).insert(0,'temporary ');await storage.saveProject(f.projectId,f.doc);const named=await f.exec({op:'history.name',label:'Temporary'});await mutateFixture(f);await f.exec({op:'history.unpin',versionId:named.versionId});const before=(await f.exec({op:'history.list'})).items.find(item=>item.versionId===named.versionId);assert.equal(before.pinned,false);assert.equal(before.available,true);
  const plan=await f.exec({op:'history.compactPlan',keepCheckpointIds:[]}),result=await f.exec({op:'history.compact',planId:plan.planId}),data=await storage.readHistoryData(f.projectId);assert.ok(result.removedCheckpointIds.includes(before.checkpointId));assert.ok(!inventory(data).items.some(item=>item.versionId===named.versionId));assert.ok(!data.objects.some(object=>object.hash===named.checkpointRef));assert.ok(inventory(importBackup(exportBackup(data))).items.every(item=>item.available));
 }finally{f.close();}
});

for(const fileId of ['__proto__','constructor'])test(`legacy file identity ${fileId} survives current restore and its ID mapping`,async()=>{
 const doc=new Y.Doc(),projectId=id();addFile(doc,'main.tex','original',fileId);doc.getMap('meta').set('mainFile',fileId);await storage.saveProject(projectId,doc);
 const commands=collaborationCommands({doc,projectId,storage}),feature=mountHistory({doc,projectId,commands,storage,author:{id:id(),displayName:'Restorer'},flushSave:()=>storage.saveProject(projectId,doc)});
 try{
  const named=await feature.execute({op:'history.name',label:'Legacy'});doc.getText('text:'+fileId).delete(0,8);doc.getText('text:'+fileId).insert(0,'changed');const plan=await feature.execute({op:'history.restorePlan',checkpointRef:named.checkpointRef,mode:'current'}),result=await feature.execute({op:'history.restore',planId:plan.planId}),read=await feature.execute({op:'artifact.read',artifactId:result.idMapRef}),mapping=JSON.parse(new TextDecoder().decode(feature.readAttachment(read.attachmentRef)));
  assert.equal(doc.getText('text:'+fileId).toString(),'original');assert.equal(Object.hasOwn(mapping,fileId),true);assert.equal(mapping[fileId],fileId);
 }finally{feature.close();commands.close();doc.destroy();}
});

test('a complete 500-file restore plan uses chunked detail instead of blocking a retained version on receipt size',async()=>{
 const f=await namedFixture();try{
  addEntries(f.doc,Array.from({length:500},(_,n)=>({path:`extra-${n}-${'x'.repeat(100)}.tex`,content:'new source'})));const plan=await f.exec({op:'history.restorePlan',checkpointRef:f.named.checkpointRef,mode:'current'});assert.equal(plan.complete,true);assert.ok(plan.summary.detailsArtifact);const bytes=await bytesFromArtifact(f,plan.summary.detailsArtifact),summary=JSON.parse(new TextDecoder().decode(bytes));assert.equal(summary.changes.filter(change=>change.kind==='delete').length,500);
  await f.exec({op:'history.restore',planId:plan.planId});assert.equal(f.doc.getMap('files').size,2);assert.equal(f.doc.getText('text:'+f.file).toString(),'😀 before\nsecond line\n');
 }finally{f.close();}
});

for(const corruption of ['missing final entry','empty final update'])test(`complete export rejects ${corruption} before offering an artifact`,async()=>{
 const f=await namedFixture();try{
  await mutateFixture(f);const db=await openDB('scribyra-v1'),head=await db.get('projects',f.projectId),key=[f.projectId,head.sequence];
  if(corruption==='missing final entry')await db.delete('journal',key);else{const row=await db.get('journal',key),empty=new Y.Doc();await db.put('journal',{...row,update:Y.encodeStateAsUpdate(empty)});empty.destroy();}db.close();
  await assert.rejects(f.exec({op:'backup.export'}),/journal is incomplete|Journal head differs/);
  await f.feature.actions['history-export']();assert.equal(f.feature.state.sourceExport,true);assert.match(f.feature.state.status,/Complete backup could not be exported.*source ZIP/);const status=f.feature.state.status;await f.feature.actions['history-refresh']();assert.equal(f.feature.state.status,status);
  assert.deepEqual(Object.keys(unzipSync(exportZip(f.doc))).sort(),['image.png','renamed.tex']);
 }finally{f.close();}
});
for(const generation of ['migrationBackup','migrationBackupsV2','checkpoint','replay-only checkpoint','journal hidden by checkpoint'])test(`export refuses private metadata in retained ${generation}`,async()=>{
 const f=await namedFixture();try{
  await mutateFixture(f);const data=await storage.readHistoryData(f.projectId),unsafe=cloneProject(f.doc);unsafe.getMap('meta').set('providerToken','RETAINED_SECRET_CANARY');const update=Y.encodeStateAsUpdate(unsafe);unsafe.destroy();
  if(generation==='migrationBackup')data.migrationBackup={...data.project,update};
  else if(generation==='migrationBackupsV2')data.migrationBackupsV2.push({...data.project,fromVersion:5,update});
  else if(generation==='journal hidden by checkpoint'){data.journal.at(-1).update=update;data.checkpoints.push({sequence:data.project.sequence,update:data.project.update});}
  else data.checkpoints[0]={...data.checkpoints[0],update,replayOnly:generation==='replay-only checkpoint'};
  assert.throws(()=>exportBackup(data),/private connection state/);
  const current=decode(data.project.update);assert.equal(current.getMap('meta').has('providerToken'),false);current.destroy();
 }finally{f.close();}
});
test('export rejects a credential added and removed in retained journal generations',async()=>{
 const f=await namedFixture();try{
  f.doc.getMap('meta').set('providerToken','JOURNAL_SECRET_CANARY');await storage.saveProject(f.projectId,f.doc);f.doc.getMap('meta').delete('providerToken');await storage.saveProject(f.projectId,f.doc);
  assert.equal(f.doc.getMap('meta').has('providerToken'),false);await assert.rejects(f.exec({op:'backup.export'}),/private connection state/);
 }finally{f.close();}
});

function appendEvent(doc,state,targetId,kind,payload={}){
 if(kind==='suggestionReject'||kind==='suggestionWithdraw')payload={acceptanceAuthorityId:state.common.authorId,authorityEpoch:1,proposedBy:state.common.authorId,...payload};
 const eventId=id(),parents=[...doc.getMap('discussionEvents').values()].filter(e=>e.targetId===targetId).map(e=>e.id);
 doc.getMap('discussionEvents').set(eventId,{...state.common,id:eventId,targetId,parents,kind,payload});return eventId;
}
test('normalized restore projections preserve realistic decisions, absence and authority across repeated restores',async()=>{
 const f=await historyFixture();try{
  const {threadId,messageId,reviewId,suggestionId,anchorId}=f.state;
  const resolved=appendEvent(f.doc,f.state,threadId,'threadResolve'),edited=appendEvent(f.doc,f.state,messageId,'messageEdit',{body:'Reviewed wording',mentionAuthorIds:[]}),submitted=appendEvent(f.doc,f.state,reviewId,'reviewSubmit'),rejected=appendEvent(f.doc,f.state,suggestionId,'suggestionReject');
  const originalAnchor=f.doc.getMap('anchors').get(anchorId),start=Y.createAbsolutePositionFromRelativePosition(originalAnchor.start,f.doc);assert.equal(start.type,f.doc.getText('text:'+f.file));assert.equal(start.index,3);
  const projected=(root,target)=>discussionProjection(f.doc,root,target);
  const initial=await f.exec({op:'history.name',label:'Resolved and reviewed'});let target=initial,firstSize;
  for(let cycle=0;cycle<30;cycle++){
   appendEvent(f.doc,f.state,threadId,'threadReopen');appendEvent(f.doc,f.state,messageId,'messageEdit',{body:'Later edit',mentionAuthorIds:[]});appendEvent(f.doc,f.state,reviewId,'reviewClose');appendEvent(f.doc,f.state,suggestionId,'suggestionWithdraw');
   f.doc.getText('text:'+f.file).insert(0,'changed ');const plan=await f.exec({op:'history.restorePlan',checkpointRef:target.checkpointRef,mode:'current'}),restored=await f.exec({op:'history.restore',planId:plan.planId});
   assert.deepEqual(projected('threads',threadId).eventIds,[resolved]);assert.deepEqual(projected('messages',messageId).eventIds,[edited]);assert.deepEqual(projected('suggestions',suggestionId).eventIds,[rejected]);
   const review=projected('reviews',reviewId);assert.ok(review.eventIds.includes(submitted));const authority=f.doc.getMap('discussionEvents').get(review.heads[0]);assert.equal(authority.kind,'authorityTransfer');assert.equal(authority.payload.acceptanceAuthorityId,f.doc.getMap('changes').get(restored.changeId).authorId);
   assert.equal(projected('anchors',anchorId).detached,true);assert.equal(projected('anchors',anchorId).anchor,null);
   const events=[...f.doc.getMap('discussionEvents').values()];for(const event of events.filter(e=>e.kind==='restoreProjection')){assert.equal('events' in event.payload,false);for(const ref of event.payload.eventIds)assert.notEqual(f.doc.getMap('discussionEvents').get(ref).kind,'restoreProjection');}
   const size=new TextEncoder().encode(JSON.stringify(events)).length;if(cycle===0)firstSize=size;assert.ok(size<=firstSize*(cycle+1)*2,`cycle ${cycle}: ${size} bytes`);
   target=await f.exec({op:'history.name',label:'Cycle '+cycle});
  }
  const compact=await f.exec({op:'history.compactPlan',keepCheckpointIds:[]});await f.exec({op:'history.compact',planId:compact.planId});
  const imported=importBackup(exportBackup(await storage.readHistoryData(f.projectId))),reopened=decode(imported.project.update);assert.deepEqual(discussionProjection(reopened,'threads',threadId).eventIds,[resolved]);reopened.destroy();
  const copyPlan=await f.exec({op:'history.restorePlan',checkpointRef:target.checkpointRef,mode:'copy'}),copied=await f.exec({op:'history.restore',planId:copyPlan.planId}),copy=await storage.loadProject(copied.projectId);try{const state=discussionProjection(copy,'reviews',reviewId),authority=copy.getMap('discussionEvents').get(state.heads[0]);assert.equal(authority.payload.acceptanceAuthorityId,copy.getMap('changes').get(copied.changeId).authorId);}finally{copy.destroy();}
  const late=id();f.doc.getMap('messages').set(late,{...f.state.common,id:late,threadId,replyToId:messageId,body:'Later reply',mentionAuthorIds:[]});const plan=await f.exec({op:'history.restorePlan',checkpointRef:initial.checkpointRef,mode:'current'});await f.exec({op:'history.restore',planId:plan.planId});assert.equal(projected('messages',late).projection,null);assert.equal(f.doc.getMap('messages').get(late).body,'Later reply');
 }finally{f.close();}
});

function replaceBackupUpdate(bytes,generation,update){
 const entries=unpack(bytes),history=JSON.parse(new TextDecoder().decode(entries.get('history.json')));
 const updateRef='updates/'+blob_hash(update);entries.set(updateRef,update);
 if(generation==='head')entries.set('project.update',update);
 else if(generation==='migrationBackup')history.migrationBackup={updateRef};
 else if(generation==='migrationBackupsV2')history.migrationBackupsV2.push({fromVersion:5,updateRef});
 else if(generation==='journal')history.journal.at(-1).updateRef=updateRef;
 else if(generation==='catalog'){
  const old=history.catalog[0],manifest=JSON.parse(new TextDecoder().decode(entries.get('objects/'+old.checkpointRef))),hash=blob_hash(update);
  manifest.updateChunks=[{hash,size:update.length}];entries.set('objects/'+hash,update);
  const content=new TextEncoder().encode(JSON.stringify(manifest));old.checkpointRef=blob_hash(content);entries.set('objects/'+old.checkpointRef,content);
 }else history.checkpoints[0]={...history.checkpoints[0],updateRef,replayOnly:generation==='replay-only checkpoint'};
 entries.set('history.json',new TextEncoder().encode(JSON.stringify(history)));
 const manifest=JSON.parse(new TextDecoder().decode(entries.get('manifest.json')));
 manifest.entries=[...entries].filter(([path])=>path!=='manifest.json').map(([path,bytes])=>({path,hash:blob_hash(bytes),size:bytes.length}));
 entries.set('manifest.json',new TextEncoder().encode(JSON.stringify(manifest)));return zipSync(Object.fromEntries(entries));
}
for(const retention of ['merged updates','undo retention','pending update'])for(const generation of ['head','migrationBackup','migrationBackupsV2','checkpoint','replay-only checkpoint','journal','catalog'])test(`deleted credential bytes reject export and import: ${retention}, ${generation}`,async()=>{
 const f=await namedFixture();try{
  const data=await storage.readHistoryData(f.projectId),safe=exportBackup(data),unsafe=retention==='pending update'?new Y.Doc():cloneProject(f.doc),updates=[];
  if(retention==='pending update')unsafe.getText('text:missing').insert(0,'unavailable predecessor');
  const undo=retention==='undo retention'?new Y.UndoManager(unsafe.getMap('meta')):null;
  unsafe.on('update',update=>updates.push(update));unsafe.getMap('meta').set('providerToken','DELETED_PROVIDER_CANARY');unsafe.getMap('meta').delete('providerToken');
  const update=retention==='undo retention'?Y.encodeStateAsUpdate(unsafe):Y.mergeUpdates([data.project.update,...updates]);
  assert.ok(new TextDecoder().decode(update).includes('DELETED_PROVIDER_CANARY'));const visible=decode(update);assert.equal(visible.getMap('meta').has('providerToken'),false);visible.destroy();undo?.destroy();unsafe.destroy();
  if(generation==='head')data.project.update=update;
  else if(generation==='migrationBackup')data.migrationBackup={...data.project,update};
  else if(generation==='migrationBackupsV2')data.migrationBackupsV2.push({...data.project,fromVersion:5,update});
  else if(generation==='journal')data.journal.at(-1).update=update;
  else if(generation==='catalog'){
   const row=data.historyCatalog[0],manifest=JSON.parse(new TextDecoder().decode(data.objects.find(o=>o.hash===row.checkpointRef).bytes)),hash=blob_hash(update);manifest.updateChunks=[{hash,size:update.length}];const bytes=new TextEncoder().encode(JSON.stringify(manifest));row.checkpointRef=blob_hash(bytes);data.objects.push({hash,bytes:update},{hash:row.checkpointRef,bytes});
  }else data.checkpoints[0]={...data.checkpoints[0],update,replayOnly:generation==='replay-only checkpoint'};
  assert.throws(()=>exportBackup(data),/private connection state/);
  assert.throws(()=>importBackup(replaceBackupUpdate(safe,generation,update)),/private connection state/);
 }finally{f.close();}
});

test('concurrent restored replicas are unavailable targets and a clean explicit restore supersedes both boundaries',async()=>{
 const f=await namedFixture();let left,right;try{
  const author={id:id(),displayName:'Replica restorer'},options={author,checkpointId:id()};
  left=restoreCurrent(f.doc,f.doc,options).doc;right=restoreCurrent(f.doc,f.doc,options).doc;
  Y.applyUpdate(f.doc,Y.encodeStateAsUpdate(left));Y.applyUpdate(f.doc,Y.encodeStateAsUpdate(right));
  const conflicted=await f.exec({op:'history.name',label:'Concurrent restores'}),data=await storage.readHistoryData(f.projectId);
  assert.throws(()=>discussionProjection(f.doc,'reviews',f.state.reviewId),/Concurrent discussion/);
  const item=(await f.exec({op:'history.list'})).items.find(item=>item.versionId===conflicted.versionId);
  assert.equal(item.available,false);assert.notEqual(item.status,'Restorable');assert.match(item.reason,/Concurrent discussion/);
  for(const mode of ['copy','current'])await assert.rejects(f.exec({op:'history.restorePlan',checkpointRef:conflicted.checkpointRef,mode}),/Concurrent discussion/);
  assert.throws(()=>exportBackup(data),/Concurrent discussion/);
  // A replay-only head must be preflighted too, even with no visible version catalogue.
  const clean=await historyFixture();try{
   const safe=exportBackup(await storage.readHistoryData(clean.projectId)),bytes=replaceBackupUpdate(safe,'head',data.project.update),ref=id();
   await assert.rejects(clean.exec({op:'backup.importPlan',attachmentRef:ref},new Map([[ref,bytes]])),/Concurrent discussion/);
  }finally{clean.close();}
  const before=[...f.doc.getMap('discussionEvents').values()].filter(e=>e.targetId===f.state.reviewId&&e.kind==='authorityTransfer').map(e=>e.id).sort();assert.equal(before.length,2);
  const plan=await f.exec({op:'history.restorePlan',checkpointRef:f.named.checkpointRef,mode:'current'});await f.exec({op:'history.restore',planId:plan.planId});
  const state=discussionProjection(f.doc,'reviews',f.state.reviewId),authority=f.doc.getMap('discussionEvents').get(state.heads[0]),boundary=f.doc.getMap('discussionEvents').get(authority.parents[0]);
  assert.deepEqual([...boundary.parents].sort(),before);assert.equal(authority.kind,'authorityTransfer');assert.equal(state.projection.id,f.state.reviewId);
  const resolved=await f.exec({op:'history.name',label:'Resolved restores'});assert.equal((await f.exec({op:'history.list'})).items.find(item=>item.versionId===resolved.versionId).available,true);
  const copyPlan=await f.exec({op:'history.restorePlan',checkpointRef:resolved.checkpointRef,mode:'copy'}),copy=await f.exec({op:'history.restore',planId:copyPlan.planId}),loaded=await storage.loadProject(copy.projectId);assert.doesNotThrow(()=>discussionProjection(loaded,'reviews',f.state.reviewId));loaded.destroy();
 }finally{left?.destroy();right?.destroy();f.close();}
});

for(const kind of ['deleted root','inherited key','unknown pending parent','source text'])test(`serialized backup checks preserve structural key policy: ${kind}`,async()=>{
 const f=await namedFixture();try{
  const data=await storage.readHistoryData(f.projectId),unsafe=cloneProject(f.doc),updates=[];
  if(kind==='unknown pending parent')unsafe.getText('text:unknown').insert(0,'missing prefix');
  unsafe.on('update',update=>updates.push(update));
  if(kind==='deleted root'){const undo=new Y.UndoManager(unsafe.getMap('providerToken'));unsafe.getMap('providerToken').set('token','ROOT_SECRET_CANARY');unsafe.getMap('providerToken').delete('token');updates.push(Y.encodeStateAsUpdate(unsafe));undo.destroy();}
  else if(kind==='inherited key'){unsafe.getMap('meta').set('providerToken','FIRST_CANARY');unsafe.getMap('meta').set('providerToken','SECOND_CANARY');unsafe.getMap('meta').delete('providerToken');}
  else if(kind==='unknown pending parent')unsafe.getText('text:unknown').insert(14,'pending value');
  else{unsafe.getText('text:'+f.file).insert(0,'providerToken is ordinary source text');unsafe.getText('text:'+f.file).delete(0,36);}
  const update=Y.mergeUpdates([data.project.update,...updates]);unsafe.destroy();data.migrationBackup={...data.project,update};
  if(kind==='source text')assert.doesNotThrow(()=>importBackup(exportBackup(data)));
  else assert.throws(()=>exportBackup(data),kind==='unknown pending parent'?/unknown root/:/private connection state/);
 }finally{f.close();}
});

for(const orphan of ['checkpoint','unclassified update'])test(`uncatalogued retained ${orphan} cannot carry deleted credentials`,async()=>{
 const f=await namedFixture();try{
  const data=await storage.readHistoryData(f.projectId),safe=exportBackup(data),unsafe=cloneProject(f.doc),undo=new Y.UndoManager(unsafe.getMap('meta'));
  unsafe.getMap('meta').set('providerToken','ORPHAN_SECRET_CANARY');unsafe.getMap('meta').delete('providerToken');const cp=checkpoint(unsafe);undo.destroy();unsafe.destroy();
  const objects=orphan==='checkpoint'?cp.objects:[{hash:blob_hash(cp.update),bytes:cp.update}],entries=unpack(safe);data.objects.push(...objects);for(const object of objects)entries.set('objects/'+object.hash,object.bytes);
  const manifest=JSON.parse(new TextDecoder().decode(entries.get('manifest.json')));manifest.entries=[...entries].filter(([path])=>path!=='manifest.json').map(([path,bytes])=>({path,hash:blob_hash(bytes),size:bytes.length}));entries.set('manifest.json',new TextEncoder().encode(JSON.stringify(manifest)));
  const reason=orphan==='checkpoint'?/private connection state/:/Unclassified retained/;assert.throws(()=>exportBackup(data),reason);assert.throws(()=>importBackup(zipSync(Object.fromEntries(entries))),reason);
 }finally{f.close();}
});

test('integrated restore projects real comments, proposals and authority, then permits new decisions',async()=>{
 const {mountCollaboration}=await import('../web/collaboration.js');
 const {discussion}=await import('../web/comments.js');
 const {projection,projectedRecord,resolveSuggestion}=await import('../web/review-commands.js');
 const {anchors}=await import('../web/comment-anchors.js');
 const author={id:crypto.randomUUID(),kind:'human',displayName:'Restorer'},doc=new Y.Doc(),projectId=crypto.randomUUID(),file=addFile(doc,'main.tex','alpha bravo');
 await storage.saveProject(projectId,doc);
 const context={doc,projectId,storage,author,managers:new Map(),locks:{request:(_name,_options,fn)=>fn()},flushSave:async()=>{const saved=await storage.saveProject(projectId,doc);Y.applyUpdate(doc,saved.update);}};
 const feature=mountCollaboration(context),call=async command=>{
  const receipt=await feature.commands.execute({version:2,requestId:crypto.randomUUID(),projectId,expectedRevision:feature.commands.revision(),command});assert.equal(receipt.ok,true,JSON.stringify(receipt));return receipt.value;
 };
 try{
  const thread=await call({op:'thread.create',fileId:file,start:0,end:5,body:'Keep this',mentions:[]}),review=await call({op:'review.create',title:'Restored review'}),suggestion=await call({op:'suggestion.propose',reviewId:review.reviewId,fileId:file,start:0,end:5,before:'alpha',after:'ALPHA'});
  await call({op:'thread.resolve',threadId:thread.threadId,eventHeads:[]});await call({op:'review.submit',reviewId:review.reviewId,eventHeads:[]});
  const named=await call({op:'history.name',label:'Resolved and pending'});
  await call({op:'thread.reopen',threadId:thread.threadId,eventHeads:discussion(doc).threads[0].eventHeads});
  await call({op:'suggestion.accept',suggestionIds:[suggestion.suggestionId],eventHeads:{[suggestion.suggestionId]:[]}});
  const later=await call({op:'thread.create',fileId:file,start:6,end:11,body:'Later thread',mentions:[]});
  const plan=await call({op:'history.restorePlan',checkpointRef:named.checkpointRef,mode:'current'});await call({op:'history.restore',planId:plan.planId});
  const restored=discussion(doc).threads.find(t=>t.id===thread.threadId);
  assert.equal(restored.status,'resolved');assert.equal(restored.anchorStatus,'attached');assert.equal(restored.messages[0].variants[0].body,'Keep this');assert.equal(discussion(doc).threads.some(t=>t.id===later.threadId),false);
  assert.equal(projection(doc,review.reviewId).status,'submitted');assert.equal(projectedRecord(doc,'reviews',review.reviewId).acceptanceAuthorityId,author.id);
  assert.equal(resolveSuggestion(doc,projectedRecord(doc,'suggestions',suggestion.suggestionId),anchors).before,'alpha');
  await call({op:'thread.reopen',threadId:thread.threadId,eventHeads:restored.eventHeads});assert.equal(discussion(doc).threads[0].status,'open');
  await call({op:'suggestion.accept',suggestionIds:[suggestion.suggestionId],eventHeads:{[suggestion.suggestionId]:projection(doc,suggestion.suggestionId).heads}});assert.equal(doc.getText('text:'+file).toString(),'ALPHA bravo');
  const insertion=await call({op:'suggestion.propose',reviewId:review.reviewId,fileId:file,start:6,end:6,before:'',after:'new '}),insertVersion=await call({op:'history.name',label:'Insertion identities'});
  doc.getText('text:'+file).insert(0,'later ');const insertPlan=await call({op:'history.restorePlan',checkpointRef:insertVersion.checkpointRef,mode:'current'});await call({op:'history.restore',planId:insertPlan.planId});
  assert.equal(resolveSuggestion(doc,projectedRecord(doc,'suggestions',insertion.suggestionId),anchors).start,6);
  const stale=await call({op:'suggestion.propose',reviewId:review.reviewId,fileId:file,start:6,end:11,before:'bravo',after:'BRAVO'}),text=doc.getText('text:'+file);
  text.delete(8,1);text.insert(8,'a');const staleVersion=await call({op:'history.name',label:'Conflicted identities'});text.insert(0,'later ');
  const stalePlan=await call({op:'history.restorePlan',checkpointRef:staleVersion.checkpointRef,mode:'current'});await call({op:'history.restore',planId:stalePlan.planId});
  assert.throws(()=>resolveSuggestion(doc,projectedRecord(doc,'suggestions',stale.suggestionId),anchors),{code:'anchor_detached'});

 }finally{feature.close();doc.destroy();}
});

test('history view rows mark only the changed words, keep line numbers and report truncation',()=>{
 const small=parsePatch('--- a\n+++ b\n@@ -4,2 +4,3 @@\n keep\n-from the old text here.\n+from the new text\n+here.\n');
 assert.equal(small.additions,2);assert.equal(small.deletions,1);assert.equal(small.truncated,false);
 assert.deepEqual(small.rows.map(row=>[row.kind,row.oldLine||'',row.newLine||'']),[['gap','',''],['context','4','4'],['delete','5',''],['add','','5'],['add','','6']]);
 assert.equal(small.rows[0].label,'3 unchanged lines');
 assert.equal(small.rows[2].segments.filter(segment=>segment.changed).map(segment=>segment.text).join('|').includes('old'),true);
 assert.equal(small.rows[2].segments.some(segment=>!segment.changed&&segment.text.includes('from the')),true);
 assert.equal(small.rows[3].segments.map(segment=>segment.text).join(''),'from the new text');
 const rewritten=parsePatch('@@ -1 +1 @@\n-alpha beta gamma\n+one two three\n');
 assert.deepEqual(rewritten.rows.map(row=>row.segments.length),[1,1]);
 const long=parsePatch('@@ -1,2000 +1,2000 @@\n'+Array.from({length:2000},(_,n)=>' line '+n).join('\n'));
 assert.equal(long.truncated,true);assert.equal(long.rows.length,1500);
});
test('history view keeps one row per file and words a restore plainly',()=>{
 const node=(id,path,extra={})=>[id,{id,path,...extra}];
 const before=new Map([node('a','old.tex'),node('b','pic.png',{binary:true}),node('d','dir',{folder:true})]),after=new Map([node('a','new.tex'),node('b','pic.png',{binary:true}),node('c','added.tex'),node('d','dir',{folder:true})]);
 const files=fileChanges({changes:[{kind:'rename',fileId:'a',fromPath:'old.tex',toPath:'new.tex'},{kind:'text',fileId:'a',lineDiff:'@@ -1 +1 @@\n-x\n+y\n'},{kind:'asset',fileId:'b',before:{size:10},after:{size:6}},{kind:'add',fileId:'c',toPath:'added.tex'},{kind:'rename',fileId:'d',fromPath:'e',toPath:'dir'},{kind:'settings'}]},before,after);
 assert.deepEqual(files.map(file=>[file.path,file.status,file.binary]),[['added.tex','added',false],['new.tex','renamed',false],['pic.png','edited',true]]);
 assert.match(restoreLine(files[1]),/Renamed back from old\.tex, and its text goes back/);
 assert.equal(summaryOf(files),'3 files changed');assert.equal(sizeChange(10,6),'4 B smaller');assert.equal(sizeChange(6,6),'Same size');
 const days=groupByDay([{dayKey:'x',dayLabel:'Today'},{dayKey:'x',dayLabel:'Today'},{dayKey:'y',dayLabel:'Yesterday'}]);assert.deepEqual(days.map(day=>day.entries.length),[2,1]);
 assert.deepEqual(authorChip('id','Ana Maria Popescu').initials,'AP');assert.deepEqual(authorChip('id','').initials,'?');
});

test('schema 6 upgrade preserves lineage, annotations and exact recovery while rejecting an old writer',async()=>{
 const doc=new Y.Doc(),id=crypto.randomUUID();addFile(doc,'main.tex','unsaved-safe 😀','main');doc.getMap('meta').set('schemaVersion',6);
 const author={version:1,id,authorId:id,changeId:id,createdAt:0,kind:'human',displayName:'Schema 6 author'};doc.getMap('authors').set(id,author);
 const lineage=doc.getMap('meta').get('lineageId');await storage.saveProject(id,doc);const old=cloneProject(doc),bytes=Y.encodeStateAsUpdate(doc);
 const upgraded=await storage.loadProject(id);
 try{
  assert.equal(upgraded.getMap('meta').get('schemaVersion'),8);assert.equal(upgraded.getMap('meta').get('lineageId'),lineage);assert.equal(upgraded.getText('text:main').toString(),'unsaved-safe 😀');
  assert.deepEqual(upgraded.getMap('authors').get(id),author);assert.deepEqual((await storage.migrationBackupV2(id,6)).update,bytes);
  old.getText('text:main').insert(0,'OLD UNSAVED ');await assert.rejects(storage.saveProject(id,old),/upgraded.*Reload/);
  const {exportZip}=await import('../web/model.js'),{unzipSync,strFromU8}=await import('fflate');assert.equal(strFromU8(unzipSync(exportZip(old))['main.tex']),'OLD UNSAVED unsaved-safe 😀');
 }finally{doc.destroy();old.destroy();upgraded.destroy();await storage.deleteProject(id);}
});

test('a schema 6 complete backup imports into schema 8 without losing its source or lineage',async()=>{
 const legacy=new Y.Doc(),legacyId=id();addFile(legacy,'old.tex','schema 6 backup 😀','old');legacy.getMap('meta').set('schemaVersion',6);await storage.saveProject(legacyId,legacy);
 const f=await historyFixture();let importedId;
 try{
  const bytes=exportBackup(await storage.readHistoryData(legacyId)),bundle=importBackup(bytes);assert.equal(bundle.project.schemaVersion,6);await storage.deleteProject(legacyId);
  const plan=await f.exec({op:'backup.importPlan',attachmentRef:'old',mode:'recovery'},new Map([['old',bytes]])),result=await f.exec({op:'backup.import',planId:plan.planId});importedId=result.projectId;
  const restored=await storage.loadProject(importedId);try{assert.equal(restored.getMap('meta').get('schemaVersion'),8);assert.equal(restored.getMap('meta').get('lineageId'),legacy.getMap('meta').get('lineageId'));assert.equal(restored.getText('text:old').toString(),'schema 6 backup 😀');}finally{restored.destroy();}
 }finally{legacy.destroy();await storage.deleteProject(legacyId);if(importedId)await storage.deleteProject(importedId);await f.close();}
});

test('schema 7 upgrade preserves lineage, annotations and exact recovery while rejecting an old writer',async()=>{
 const doc=new Y.Doc(),id=crypto.randomUUID();addFile(doc,'main.tex','unsaved-safe 😀','main');doc.getMap('meta').set('schemaVersion',7);
 const author={version:1,id,authorId:id,changeId:id,createdAt:0,kind:'human',displayName:'Schema 7 author'};doc.getMap('authors').set(id,author);
 const lineage=doc.getMap('meta').get('lineageId');await storage.saveProject(id,doc);const old=cloneProject(doc),bytes=Y.encodeStateAsUpdate(doc);
 const upgraded=await storage.loadProject(id);
 try{
  assert.equal(upgraded.getMap('meta').get('schemaVersion'),8);assert.equal(upgraded.getMap('meta').get('lineageId'),lineage);assert.equal(upgraded.getText('text:main').toString(),'unsaved-safe 😀');
  assert.deepEqual(upgraded.getMap('authors').get(id),author);assert.deepEqual((await storage.migrationBackupV2(id,7)).update,bytes);
  old.getText('text:main').insert(0,'OLD UNSAVED ');await assert.rejects(storage.saveProject(id,old),/upgraded.*Reload/);
  const {exportZip}=await import('../web/model.js'),{unzipSync,strFromU8}=await import('fflate');assert.equal(strFromU8(unzipSync(exportZip(old))['main.tex']),'OLD UNSAVED unsaved-safe 😀');
 }finally{doc.destroy();old.destroy();upgraded.destroy();await storage.deleteProject(id);}
});

test('a schema 7 complete backup imports into schema 8 without losing its source or lineage',async()=>{
 const legacy=new Y.Doc(),legacyId=id();addFile(legacy,'old.tex','schema 7 backup 😀','old');legacy.getMap('meta').set('schemaVersion',7);await storage.saveProject(legacyId,legacy);
 const f=await historyFixture();let importedId;
 try{
  const bytes=exportBackup(await storage.readHistoryData(legacyId)),bundle=importBackup(bytes);assert.equal(bundle.project.schemaVersion,7);await storage.deleteProject(legacyId);
  const plan=await f.exec({op:'backup.importPlan',attachmentRef:'old',mode:'recovery'},new Map([['old',bytes]])),result=await f.exec({op:'backup.import',planId:plan.planId});importedId=result.projectId;
  const restored=await storage.loadProject(importedId);try{assert.equal(restored.getMap('meta').get('schemaVersion'),8);assert.equal(restored.getMap('meta').get('lineageId'),legacy.getMap('meta').get('lineageId'));assert.equal(restored.getText('text:old').toString(),'schema 7 backup 😀');}finally{restored.destroy();}
 }finally{legacy.destroy();await storage.deleteProject(legacyId);if(importedId)await storage.deleteProject(importedId);await f.close();}
});

test('Viewing restore guard checks a previously prepared current plan and permits a copy',async()=>{
 const {uiCollaborationGuard}=await import('../web/ui-mutations.js'),f=await namedFixture();let mode='editing',copyId;
 const uiGuard=uiCollaborationGuard(()=>mode),run=command=>f.commands.execute({version:2,requestId:id(),projectId:f.projectId,expectedRevision:f.commands.revision(),command},undefined,{uiGuard});
 try{
  const current=await run({op:'history.restorePlan',checkpointRef:f.named.checkpointRef,mode:'current'});assert.equal(current.ok,true);mode='viewing';
  const denied=await run({op:'history.restore',planId:current.value.planId});assert.equal(denied.error.code,'viewing_mode');assert.match(denied.error.message,/Switch to Editing/);
  const plan=await run({op:'history.restorePlan',checkpointRef:f.named.checkpointRef,mode:'copy'});assert.equal(plan.ok,true);
  const copied=await run({op:'history.restore',planId:plan.value.planId});assert.equal(copied.ok,true,JSON.stringify(copied));copyId=copied.value.projectId;assert.notEqual(copyId,f.projectId);
 }finally{f.close();if(copyId)await storage.deleteProject(copyId);}
});

test('signed record provenance survives the complete backup including serialized metadata history',async()=>{
 const {newIdentity}=await import('../web/direct-identity.js'),{identityAuthorId,signRecords,validateProvenance}=await import('../web/direct-provenance.js'),identity=await newIdentity(),doc=new Y.Doc(),projectId=crypto.randomUUID(),authorId=identityAuthorId(identity.publicKey);
 addFile(doc,'main.tex','signed source');doc.getMap('authors').set(authorId,{version:1,id:authorId,authorId,changeId:crypto.randomUUID(),createdAt:1,kind:'human',displayName:'Signed author'});await signRecords(doc,identity);
 const key='directProof:authors:'+authorId;doc.getMap('meta').set(key,{...doc.getMap('meta').get(key)});
 try{await storage.saveProject(projectId,doc);const restored=importBackup(exportBackup(await storage.readHistoryData(projectId))),copy=new Y.Doc(),empty=new Y.Doc();
  try{Y.applyUpdate(copy,restored.project.update);await validateProvenance(empty,copy);assert.deepEqual(copy.getMap('meta').get(key),doc.getMap('meta').get(key));}finally{copy.destroy();empty.destroy();}
 }finally{doc.destroy();await storage.deleteProject(projectId);}
});
test('replayEach visits every journal sequence in the state per-entry replay builds, decoding each checkpoint once',async()=>{
 const {replay,replayEach}=await import('../web/history-storage.js'),id=crypto.randomUUID(),doc=new Y.Doc();
 addFile(doc,'main.tex','start\n','main');await storage.saveProject(id,doc);
 for(let i=0;i<130;i++){doc.getText('text:main').insert(0,`edit ${i}\n`);if(i%7===0)doc.getText('text:main').delete(3,2);const saved=await storage.saveProject(id,doc);Y.applyUpdate(doc,saved.update);}
 const data=await storage.readHistoryData(id),visited=[];
 // History format 2 writes full copies only as sparse maintenance bases; add three as maintenance would.
 for(const sequence of [40,80,120]){const state=replay(data,sequence);data.checkpoints.push({checkpointId:crypto.randomUUID(),projectId:id,sequence,replayOnly:true,createdAt:Date.now(),update:Y.encodeStateAsUpdate(state)});state.destroy();}
 assert.ok(data.checkpoints.length>=3,'the history spans several checkpoints');
 replayEach(data,(state,sequence)=>visited.push([sequence,Y.encodeStateAsUpdate(state)]));
 assert.deepEqual(visited.map(([sequence])=>sequence),data.journal.map(row=>row.sequence).sort((a,b)=>a-b));
 for(const [sequence,bytes] of visited){const expected=replay({...data,checkpoints:data.checkpoints.filter(cp=>cp.sequence<sequence)},sequence);try{assert.deepEqual(bytes,Y.encodeStateAsUpdate(expected),`sequence ${sequence}`);}finally{expected.destroy();}}
 const gap={...data,journal:data.journal.filter(row=>row.sequence!==60)};
 assert.throws(()=>replayEach(gap,()=>{}),/gap or unsupported entry/);assert.throws(()=>replay({...gap,checkpoints:gap.checkpoints.filter(cp=>cp.sequence<61)},61),/gap or unsupported entry/);
 assert.throws(()=>replayEach({...data,checkpoints:[]},()=>{}),/No recovery checkpoint/);
 doc.destroy();await storage.deleteProject(id);
});
test('complete backup size is counted as the manifest lists it and an oversized history is refused before validation',async()=>{
 const {exportBackup,backupBytes}=await import('../web/history-backup.js'),{inventory}=await import('../web/history-storage.js'),{unzipSync,strFromU8}=await import('fflate');
 const id=crypto.randomUUID(),doc=new Y.Doc();addFile(doc,'main.tex','start\n','main');migrateProject(doc,id);await storage.saveProject(id,doc);
 for(let i=0;i<60;i++){doc.getText('text:main').insert(0,`edit ${i}\n`);const saved=await storage.saveProject(id,doc);Y.applyUpdate(doc,saved.update);}
 const data=await storage.readHistoryData(id),size=backupBytes(data,inventory(data)),manifest=JSON.parse(strFromU8(unzipSync(exportBackup(data))['manifest.json']));
 assert.equal(size,manifest.entries.filter(entry=>entry.path!=='history.json').reduce((sum,entry)=>sum+entry.size,0));
 assert.throws(()=>exportBackup(data,{maxBytes:size-1}),error=>error.code==='incomplete_backup'&&/too large for one complete backup.*Clean up history/.test(error.message));
 doc.destroy();await storage.deleteProject(id);
});
