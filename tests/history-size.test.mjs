// Stored history size (docs/history.md, "Stored history size"): typing bursts, automatic
// versions on a thinning ladder, journal merging, and compaction of projects stored before
// history format 2. The version-7 database is installed from a real dump made by the earlier
// code (tests/fixtures/history/make-legacy.mjs) before the storage module first opens it.
import 'fake-indexeddb/auto';
import './helpers/core.mjs';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {registerHooks} from 'node:module';
import {openDB} from 'idb';
import * as Y from 'yjs';
registerHooks({load(url,context,next){return url.endsWith('.css')?{format:'module',source:'',shortCircuit:true}:next(url,context);}});

const legacy=JSON.parse(readFileSync(new URL('./fixtures/history/legacy-v7.json',import.meta.url)),(key,value)=>value&&typeof value.$b64==='string'?new Uint8Array(Buffer.from(value.$b64,'base64')):value);
{
  const db=await openDB('scribyra-v1',legacy.version,{upgrade(db){for(const [name,shape]of Object.entries(legacy.keys)){const store=db.createObjectStore(name,{keyPath:shape.keyPath});for(const index of shape.indexes)store.createIndex(index.name,index.keyPath);}}});
  const tx=db.transaction(Object.keys(legacy.stores),'readwrite');for(const [name,rows]of Object.entries(legacy.stores))for(const row of rows)await tx.objectStore(name).put(row);await tx.done;db.close();
}
// Virtual time for bursts and versions; lib0 captured the real clock, which the undo manager uses.
let clock=Date.UTC(2026,10,1,9,0,0);const realNow=Date.now;Date.now=()=>clock;
const storage=await import('../web/storage.js');
const {addFile,projectFiles}=await import('../web/model.js');
const {cloneProject}=await import('../web/assets.js');
const {anchors}=await import('../web/comment-anchors.js');
const {collaborationCommands}=await import('../web/collaboration-commands.js');
const {registerComments}=await import('../web/comments.js');
const {reviewService}=await import('../web/review-commands.js');
const {changeOrigins,AgentOrigin}=await import('../web/change-origins.js');
const {mount}=await import('../web/history.js');
const {ladder,redundantChanges,BURST_PAUSE_MS,BURST_MAX_MS,POINT_INTERVAL_MS}=await import('../web/history-compaction.js');
const {exportBackup,importBackup,pack,unpack}=await import('../web/history-backup.js');
const {replay,inventory}=await import('../web/history-storage.js');

const HOUR=3_600_000,DAY=24*HOUR;
async function session({id=crypto.randomUUID(),doc,author={id:crypto.randomUUID(),kind:'human',displayName:'Writer'},create=true,mountHistory=true,remote=['saved']}={}){
  if(!doc){doc=new Y.Doc();addFile(doc,'main.tex','\\begin{document}\n\\end{document}\n','main');addFile(doc,'chapter.tex','Chapter.\n','chapter');}
  if(create)await storage.saveProject(id,doc);
  const managers=new Map(projectFiles(doc).filter(file=>!file.binary).map(file=>[file.id,new Y.UndoManager(doc.getText('text:'+file.id),{trackedOrigins:new Set([null,AgentOrigin])})]));
  let pointAt=Date.now(),history;
  const flushSave=async()=>{const point=storage.pointDue(pointAt);if(point){pointAt=Date.now();history?.endBurst();}const frozen=cloneProject(doc);try{const saved=await storage.saveProject(id,frozen,undefined,{point});Y.applyUpdate(doc,saved.update,'saved');return saved;}finally{frozen.destroy();}};
  const context={doc,projectId:id,author,sessionId:crypto.randomUUID(),anchors,storage,managers,flushSave,locks:{request:(_n,_o,run)=>run()}};
  context.origins=changeOrigins({doc,managers,remote});const commands=collaborationCommands(context);context.commands=commands;
  const comments=registerComments(context),reviews=reviewService(context);history=mountHistory?mount(context):null;
  const call=async command=>{const reply=await commands.execute({version:2,requestId:crypto.randomUUID(),projectId:id,expectedRevision:commands.revision(),command});if(!reply.ok)throw Object.assign(new Error(command.op+': '+reply.error.message),{code:reply.error.code});return reply.value;};
  const type=async(file,text,gap=200,save=true)=>{const t=doc.getText('text:'+file);for(const ch of text){doc.transact(()=>t.insert(t.length,ch));clock+=gap;if(save)await flushSave();}};
  return{id,doc,author,managers,context,commands,history,call,type,flushSave,close(){history?.close();comments.close();reviews.close();commands.close();context.origins.close();}};
}
const records=doc=>[...doc.getMap('changes').values()].sort((a,b)=>a.createdAt-b.createdAt);

test('a version-7 database upgrades; its typed project keeps a recovery copy, merges per-key records into bursts and keeps every named version, comment, suggestion and author',async()=>{
  assert.equal(legacy.version,7,'the fixture is the version-7 database the storage module upgraded when it first opened');
  const original=new Y.Doc();Y.applyUpdate(original,legacy.stores.projects[0].update);
  const id=legacy.projectId,doc=await storage.loadProject(id),upgraded=await openDB('scribyra-v1');
  try{
    assert.equal(upgraded.version,8);
    const record=await upgraded.get('projects',id);assert.equal(record.history.version,2);assert.equal(record.history.compaction,'thinning');
    const heads=await upgraded.getAll('heads'),recovery=heads.find(head=>head.id===record.history.recoveryId);
    assert.match(recovery?.name||'',/before history compaction/);
    const kept=doc.getMap('changes'),was=original.getMap('changes');
    assert.ok(kept.size<was.size/3,`records merged: ${was.size} -> ${kept.size}`);
    const who=map=>new Set([...map.values()].map(change=>[change.authorId,change.sessionId,change.kind,change.fileIds.join()].join('|')));
    assert.deepEqual(who(kept),who(was),'every author, session, kind and file is still attributed');
    for(const root of ['authors','threads','messages','anchors','suggestions','reviews','discussionEvents','versions'])assert.deepEqual(doc.getMap(root).toJSON(),original.getMap(root).toJSON(),root);
    for(const name of original.share.keys())if(name.startsWith('text:'))assert.equal(doc.getText(name).toString(),original.getText(name).toString());
    for(const change of [...was.values()].filter(change=>change.kind!=='source-edit'&&change.kind!=='undo-redo'))assert.ok(kept.has(change.id),'records of other kinds stay');
    const recoveryDoc=await storage.loadProject(recovery.id);assert.equal(recoveryDoc.getMap('changes').size,was.size,'the recovery copy has every original record');recoveryDoc.destroy();
    const result=await storage.maintainHistory(id,{now:Date.now()});assert.ok(!result.skipped,JSON.stringify(result));
    const done=await upgraded.get('projects',id);assert.equal(done.history.compaction,'done');
    assert.equal((await upgraded.get('heads',recovery.id)).deleted,true,'the recovery copy goes once the compacted history is verified');
    const s=await session({id,doc,create:false});
    try{
      const list=await s.call({op:'history.list'});
      for(const label of ['First draft','Submitted'])assert.ok(list.items.some(item=>item.label===label&&item.status==='Restorable'),label);
      for(const item of list.items){const plan=await s.call({op:'history.restorePlan',checkpointRef:item.checkpointRef,mode:'copy'});assert.ok(plan.planId);}
      const bundle=importBackup(exportBackup(await storage.readHistoryData(id)));assert.ok(inventory(bundle).items.every(item=>item.available));
    }finally{s.close();}
  }finally{upgraded.close();original.destroy();}
});

test('typing bursts: one change record per author, session and file until a pause, a file switch, an undo or another record',async()=>{
  const s=await session();
  try{
    await s.type('chapter','Hello world.');
    assert.equal(records(s.doc).length,1,'one burst while typing continuously');
    clock+=BURST_PAUSE_MS;await s.type('chapter',' Again.');
    assert.equal(records(s.doc).length,2,'a pause of a minute starts a new burst');
    await s.type('main','%');
    assert.equal(records(s.doc).at(-1).fileIds[0],'main','another file starts a new burst');
    await s.type('chapter','x');assert.equal(records(s.doc).length,4,'returning to a file after editing another starts a new burst');
    s.managers.get('chapter').stopCapturing();s.managers.get('chapter').undo();s.managers.get('chapter').redo();s.managers.get('chapter').undo();
    const kinds=records(s.doc).map(record=>record.kind);
    assert.deepEqual(kinds.slice(-1),['undo-redo'],'consecutive undo and redo steps share one record of their own kind');
    await s.type('chapter','y');assert.equal(records(s.doc).at(-1).kind,'source-edit','typing after undo is a new burst');
    const before=records(s.doc).length;
    await s.call({op:'thread.create',fileId:'chapter',start:0,end:5,body:'Note'});await s.flushSave();
    await s.type('chapter','z');
    assert.equal(records(s.doc).length,before+2,'a comment is its own record and ends the burst');
    const agent=new AgentOrigin({authorId:crypto.randomUUID(),displayName:'Agent',sessionId:crypto.randomUUID()});
    for(let i=0;i<3;i++)s.doc.transact(()=>s.doc.getText('text:chapter').insert(0,'A'),agent);
    assert.equal(records(s.doc).filter(record=>record.actorKind==='agent').length,3,'attributed agent edits keep one record per command');
    const count=records(s.doc).length;
    for(let i=0;i<BURST_MAX_MS/1000+5;i++)await s.type('chapter','.',1000,false);
    assert.equal(records(s.doc).length,count+2,'a burst lasts at most five minutes');
    s.history.endBurst();await s.type('chapter','!',100,false);assert.equal(records(s.doc).length,count+3,'an automatic version ends the burst');
    for(const record of records(s.doc))if(record.kind==='source-edit'&&record.actorKind==='human'){assert.equal(record.authorId,s.author.id);assert.equal(record.sessionId,s.context.sessionId);}
    assert.equal([...s.doc.getMap('meta').keys()].some(key=>key.startsWith('direct')),false,'sessions off writes no direct-session data');
  }finally{s.close();}
});

test('undo and redo behave exactly as without coalescing',async()=>{
  const script=async(s)=>{
    const t=s.doc.getText('text:chapter'),undo=s.managers.get('chapter'),seen=[];
    for(const word of ['alpha ','beta ','gamma ']){for(const ch of word){s.doc.transact(()=>t.insert(t.length,ch));clock+=120;}undo.stopCapturing();clock+=900;}
    s.doc.transact(()=>t.delete(2,3));undo.stopCapturing();
    for(const step of ['undo','undo','redo','undo','undo','redo','redo','redo']){undo[step]();seen.push(t.toString());}
    return seen;
  };
  const withHistory=await session(),without=await session({mountHistory:false});
  try{assert.deepEqual(await script(withHistory),await script(without));}finally{withHistory.close();without.close();}
});

test('automatic versions: one per five minutes of saving and one before each long pause; a diff after one names the typist',async()=>{
  const s=await session();
  try{
    await s.type('chapter','First words.',200);
    clock+=POINT_INTERVAL_MS;await s.type('chapter',' More',200);
    clock+=3*60_000;await s.type('chapter',' after a pause',200);
    const db=await openDB('scribyra-v1'),journal=await db.getAllFromIndex('journal','projectId',s.id);db.close();
    const points=journal.filter(row=>row.point);
    assert.equal(points.length,2,'an interval point and the state before the pause');
    // Journal rows carry only what each save added, not the whole delete set again.
    assert.ok(journal.every(row=>row.update.length<2048),'minimal journal rows');
    const list=await s.call({op:'history.list'}),auto=list.items.filter(item=>item.reason==='automatic');
    assert.equal(auto.length,2);assert.ok(auto.every(item=>item.status==='Restorable'));
    const diff=await s.call({op:'history.diff',fromCheckpoint:auto[0].checkpointRef});
    assert.deepEqual(diff.contributors,[s.author.id],'edits after the latest version are attributed');
  }finally{s.close();}
});

test('the thinning ladder keeps the last hour, then one per hour, day and week',()=>{
  const now=Date.UTC(2026,10,11,12),points=[];let sequence=0;
  for(let minutes=0;minutes<60*24*90;minutes+=7)points.push({id:'p'+sequence,sequence:sequence++,createdAt:now-minutes*60_000});
  const kept=ladder(points,now),ages=points.filter(point=>kept.has(point.id)).map(point=>now-point.createdAt);
  assert.equal(ages.filter(age=>age<=HOUR).length,points.filter(point=>now-point.createdAt<=HOUR).length,'every version from the last hour');
  assert.ok(ages.filter(age=>age>HOUR&&age<=DAY).length<=24);
  assert.ok(ages.filter(age=>age>DAY&&age<=30*DAY).length<=31);
  assert.ok(ages.filter(age=>age>30*DAY).length<=10);
  assert.ok(kept.size<9+24+31+10+1);
});

test('maintenance merges the steps between kept versions; every kept version, the head, restore and restore as copy still work',async()=>{
  const s=await session();
  try{
    for(let day=0;day<4;day++){for(let burst=0;burst<6;burst++){await s.type('chapter',`Day ${day} burst ${burst}. `,180);clock+=6*60_000;}if(day===1)await s.call({op:'history.name',label:'Named on day one'});clock+=DAY;}
    const before=await storage.readHistoryData(s.id),originalPoints=before.journal.filter(row=>row.point),states=new Map();
    for(const row of originalPoints){const doc=replay(before,row.sequence);states.set(row.checkpointId,Y.encodeStateAsUpdate(doc));doc.destroy();}
    const result=await storage.maintainHistory(s.id);
    assert.ok(result.merged>0&&result.removedVersions>0,JSON.stringify(result));
    const after=await storage.readHistoryData(s.id),points=after.journal.filter(row=>row.point);
    assert.ok(after.journal.length<before.journal.length/4,'rows merged');
    assert.ok(points.length<originalPoints.length,'versions thinned');
    for(const row of points){const doc=replay(after,row.sequence);assert.deepEqual(Y.encodeStateAsUpdate(doc),states.get(row.checkpointId),'a kept version replays to its original bytes');doc.destroy();}
    const head=replay(after,after.project.sequence);assert.deepEqual(Y.encodeStateAsUpdate(head),after.project.update);head.destroy();
    const list=await s.call({op:'history.list'});assert.ok(list.items.some(item=>item.label==='Named on day one'&&item.status==='Restorable'),'named versions stay');
    const oldest=list.items.filter(item=>item.reason==='automatic').at(-1);
    const copy=await s.call({op:'history.restorePlan',checkpointRef:oldest.checkpointRef,mode:'copy'});const restored=await s.call({op:'history.restore',planId:copy.planId});
    const copied=await storage.loadProject(restored.projectId);assert.match(copied.getText('text:chapter').toString(),/Day 0 burst/);copied.destroy();
    const current=await s.call({op:'history.restorePlan',checkpointRef:oldest.checkpointRef,mode:'current'});await s.call({op:'history.restore',planId:current.planId});
    assert.equal(s.doc.getText('text:chapter').toString(),states.has(oldest.checkpointId)?(()=>{const d=new Y.Doc();Y.applyUpdate(d,states.get(oldest.checkpointId));const t=d.getText('text:chapter').toString();d.destroy();return t;})():s.doc.getText('text:chapter').toString());
    // A complete backup of the maintained history is format 2 and imports.
    const bundle=importBackup(exportBackup(await storage.readHistoryData(s.id)));assert.ok(bundle.journal.some(row=>row.version===2));
    assert.ok(inventory(bundle).items.every(item=>item.available));
  }finally{s.close();}
});

test('interrupted maintenance leaves a valid history and the next run finishes; a save racing it is kept',async()=>{
  const s=await session();
  try{
    for(let burst=0;burst<12;burst++){await s.type('chapter',`Burst ${burst}. `,150);clock+=10*60_000;}
    clock+=2*DAY;
    const put=IDBObjectStore.prototype.put;let puts=0;
    IDBObjectStore.prototype.put=function(...args){if(this.name==='journal'&&++puts===2)throw new DOMException('Tab closed','AbortError');return put.apply(this,args);};
    try{await assert.rejects(storage.maintainHistory(s.id).then(result=>{throw new Error('completed: '+JSON.stringify(result)+' puts '+puts);}),/Tab closed/);}finally{IDBObjectStore.prototype.put=put;}
    let data=await storage.readHistoryData(s.id),head=replay(data,data.project.sequence);assert.deepEqual(Y.encodeStateAsUpdate(head),data.project.update);head.destroy();
    for(const row of data.journal.filter(row=>row.point)){const doc=replay(data,row.sequence);doc.destroy();}
    const running=storage.maintainHistory(s.id);await s.type('chapter',' while maintaining',100);await running;
    await storage.maintainHistory(s.id);
    data=await storage.readHistoryData(s.id);head=replay(data,data.project.sequence);assert.deepEqual(Y.encodeStateAsUpdate(head),data.project.update);
    assert.match(head.getText('text:chapter').toString(),/while maintaining$/);head.destroy();
    const [a,b]=await Promise.all([storage.maintainHistory(s.id),storage.maintainHistory(s.id)]);assert.ok(a.skipped||b.skipped,'one maintenance run at a time');
  }finally{s.close();}
});

test('a format-1 backup made before the change imports, and its project compacts when first opened',async()=>{
  const bytes=new Uint8Array(readFileSync(new URL('./fixtures/history/legacy-v1.scribyra-backup',import.meta.url)));
  const host=await session();
  try{
    const bundle=importBackup(bytes);assert.equal(bundle.project.history,undefined,'format 1 imports as an earlier-format project');
    const reply=await host.commands.execute({version:2,requestId:crypto.randomUUID(),projectId:host.id,expectedRevision:host.commands.revision(),command:{op:'backup.importPlan',attachmentRef:'b'}},new Map([['b',bytes]]));assert.ok(reply.ok,JSON.stringify(reply.error));
    const done=await host.call({op:'backup.import',planId:reply.value.planId});
    const doc=await storage.loadProject(done.projectId);const db=await openDB('scribyra-v1');
    try{const record=await db.get('projects',done.projectId);assert.equal(record.history.version,2);assert.ok(doc.getMap('versions').size===2);}
    finally{db.close();doc.destroy();}
    await storage.maintainHistory(done.projectId);
    const data=await storage.readHistoryData(done.projectId);assert.ok(inventory(data).items.filter(item=>item.versionId).length===2);
  }finally{host.close();}
});

test('newer backup and history formats, and a newer database, are refused',async()=>{
  const s=await session();
  try{
    await s.type('chapter','Some text.');
    const entries=unpack(exportBackup(await storage.readHistoryData(s.id))),edit=(path,change)=>{const copy=new Map(entries);const value=JSON.parse(new TextDecoder().decode(copy.get(path)));change(value);copy.set(path,new TextEncoder().encode(JSON.stringify(value)));return copy;};
    const manifest=JSON.parse(new TextDecoder().decode(entries.get('manifest.json')));assert.equal(manifest.format,2);
    assert.throws(()=>importBackup(pack(edit('manifest.json',m=>{m.format=3;}))),/Unsupported backup format/);
    const history=edit('history.json',h=>{h.version=3;}),bytes=history.get('history.json'),{blob_hash}=await import('../web/pkg/scribyra_app.js');
    const fixed=new Map(history),m=JSON.parse(new TextDecoder().decode(fixed.get('manifest.json')));m.entries=m.entries.map(entry=>entry.path==='history.json'?{...entry,hash:blob_hash(bytes),size:bytes.length}:entry);fixed.set('manifest.json',new TextEncoder().encode(JSON.stringify(m)));
    assert.throws(()=>importBackup(pack(fixed)),/Invalid history version/);
  }finally{s.close();}
  const {IDBFactory}=await import('fake-indexeddb'),saved=globalThis.indexedDB;globalThis.indexedDB=new IDBFactory();
  try{
    const newer=await openDB('scribyra-v1',9,{upgrade(db){db.createObjectStore('projects',{keyPath:'id'});}});newer.close();
    const fresh=await import('../web/storage.js?newer-database');
    await assert.rejects(fresh.listProjects(),/Local storage could not be opened \(VersionError\)/);
  }finally{globalThis.indexedDB=saved;}
});

test('direct sessions on: a coalesced burst record is signed once and a peer verifies it while typing continues',async()=>{
  const {newIdentity}=await import('../web/direct-identity.js'),{identityAuthorId,signRecords,validateProvenance}=await import('../web/direct-provenance.js');
  const identity=await newIdentity(),author={id:identityAuthorId(identity.publicKey),kind:'human',displayName:'Signed writer'},s=await session({author});
  try{
    await s.type('chapter','Signed burst',200,false);
    assert.equal(records(s.doc).filter(record=>record.kind==='source-edit').length,1);
    await signRecords(s.doc,identity,{legacy:[]});
    const peer=new Y.Doc(),empty=new Y.Doc();Y.applyUpdate(peer,Y.encodeStateAsUpdate(s.doc));
    await validateProvenance(empty,peer);
    const id=records(s.doc)[0].id;assert.ok(s.doc.getMap('meta').get('directProof:changes:'+id),'the burst record carries a proof');
    await s.type('chapter',' continues',200,false);await signRecords(s.doc,identity,{legacy:[]});
    const next=new Y.Doc();Y.applyUpdate(next,Y.encodeStateAsUpdate(peer));Y.applyUpdate(next,Y.encodeStateAsUpdate(s.doc));
    await validateProvenance(peer,next);
    assert.equal(records(next).filter(record=>record.kind==='source-edit').length,1,'continuing a burst adds no record and no proof');
    // A project that has carried session proofs keeps every record when compacted.
    assert.deepEqual(redundantChanges(s.doc).remove,[]);
    for(const d of [peer,empty,next])d.destroy();
  }finally{s.close();}
});

// Regressions found by the independent data-safety review.
test('versions kept in "Clean up history" are never thinned by later maintenance',async()=>{
  const s=await session();
  try{
    for(let i=0;i<4;i++){await s.type('chapter','abc',1000);clock+=6*60_000;await s.type('chapter','x',1000);clock+=30*HOUR;}
    const autos=(await s.call({op:'history.list'})).items.filter(item=>item.reason==='automatic'),keep=[autos[1],autos.at(-1)].map(item=>item.checkpointId);
    const plan=await s.call({op:'history.compactPlan',keepCheckpointIds:keep});await s.call({op:'history.compact',planId:plan.planId});
    await s.type('chapter','y',1000);clock+=3*DAY;await storage.maintainHistory(s.id);
    const items=inventory(await storage.readHistoryData(s.id)).items;
    assert.deepEqual(keep.map(id=>items.some(item=>item.checkpointId===id&&item.available)),[true,true]);
  }finally{s.close();}
});
test('a diff after an automatic version names a peer whose typing burst spanned it',async()=>{
  const alice=await session({author:{id:crypto.randomUUID(),kind:'human',displayName:'Alice'},remote:['saved','peer']}),peer=new Y.Doc();Y.applyUpdate(peer,Y.encodeStateAsUpdate(alice.doc));
  const bob=await session({id:alice.id,doc:peer,create:false,author:{id:crypto.randomUUID(),kind:'human',displayName:'Bob'},remote:['saved','peer']});
  alice.doc.on('update',(update,origin)=>{if(origin!=='peer')Y.applyUpdate(peer,update,'peer');});peer.on('update',(update,origin)=>{if(origin!=='peer')Y.applyUpdate(alice.doc,update,'peer');});
  try{
    clock+=4*60_000+50_000;await bob.type('chapter','b',100,false);
    clock+=10_000;assert.equal((await alice.flushSave()).point,true);
    clock+=30_000;await bob.type('chapter','BBBB',100,false);
    clock+=5*60_000;await alice.type('chapter','a',100,false);assert.equal((await alice.flushSave()).point,true);
    const autos=(await alice.call({op:'history.list'})).items.filter(item=>item.journal).sort((a,b)=>a.sequence-b.sequence);
    const diff=await alice.call({op:'history.diff',fromCheckpoint:autos.at(-2).checkpointRef,toCheckpoint:autos.at(-1).checkpointRef});
    assert.deepEqual(new Set(diff.contributors),new Set([alice.author.id,bob.author.id]));
  }finally{alice.close();bob.close();}
});
test('a full copy inside a merged row never hangs replay, and such a backup is refused',async()=>{
  const s=await session();
  try{
    for(let i=0;i<6;i++){await s.type('chapter','z',100);}
    await storage.maintainHistory(s.id);
    const data=await storage.readHistoryData(s.id),merged=data.journal.find(row=>(row.from??row.sequence)<row.sequence);assert.ok(merged,'a merged row');
    const inside=(merged.from+merged.sequence)>>1,copy=replay(data,data.project.sequence);
    const crafted={...data,checkpoints:[...data.checkpoints,{checkpointId:crypto.randomUUID(),projectId:s.id,sequence:inside,replayOnly:true,createdAt:clock,update:Y.encodeStateAsUpdate(copy)}]};copy.destroy();
    const {replayEach}=await import('../web/history-storage.js');let visits=0;replayEach(crafted,()=>{visits++;});assert.equal(visits,crafted.journal.length);
    const head=replay(crafted,crafted.project.sequence);assert.deepEqual(Y.encodeStateAsUpdate(head),crafted.project.update);head.destroy();
    assert.throws(()=>exportBackup(crafted),/inside a merged journal row/);
  }finally{s.close();}
});
test('a compacted history that does not replay stops maintenance, keeps the recovery copy and says so',async()=>{
  const s=await session();
  try{
    for(let i=0;i<5;i++)await s.type('chapter','w',100);
    const db=await openDB('scribyra-v1'),record=await db.get('projects',s.id),recoveryId=crypto.randomUUID();
    await db.put('projects',{...record,history:{...record.history,compaction:'thinning',recoveryId}});
    await db.put('heads',{id:recoveryId,name:'Recovery',sequence:0,deleted:false,updatedAt:1,files:1,schemaVersion:8});
    await db.delete('journal',[s.id,3]);
    await assert.rejects(storage.maintainHistory(s.id),error=>error.code==='history_verification');
    assert.equal((await db.get('projects',s.id)).history.compaction,'failed');
    assert.equal(await storage.historyMaintenanceDue(s.id),false,'no automatic retries');
    assert.deepEqual(await storage.maintainHistory(s.id),{skipped:true});
    assert.equal((await db.get('heads',recoveryId)).deleted,false,'the recovery copy stays');
    db.close();
  }finally{s.close();}
});
// Clean up history must never grow stored history (history format 2 keeps versions as journal points).
const storedBytes=data=>[...data.journal,...data.checkpoints].reduce((n,row)=>n+row.update.length,0)+data.objects.reduce((n,o)=>n+o.bytes.length,0)+data.blobs.reduce((n,b)=>n+b.bytes.length,0);
async function cleanUpKeeps(s,keepIds){
  const before=await storage.readHistoryData(s.id),beforeBytes=storedBytes(before);
  const plan=await s.call({op:'history.compactPlan',keepCheckpointIds:keepIds});const result=await s.call({op:'history.compact',planId:plan.planId});
  const after=await storage.readHistoryData(s.id),afterBytes=storedBytes(after),items=inventory(after).items;
  assert.ok(afterBytes<=beforeBytes,`clean-up grew stored history: ${beforeBytes} -> ${afterBytes}`);
  for(const id of keepIds){const item=items.find(item=>item.checkpointId===id);assert.ok(item?.available,'a chosen version stays listed');
    const copy=await s.call({op:'history.restorePlan',checkpointRef:item.checkpointRef,mode:'copy'});const done=await s.call({op:'history.restore',planId:copy.planId});const doc=await storage.loadProject(done.projectId);doc.destroy();}
  for(const id of result.removedCheckpointIds)assert.ok(!items.some(item=>item.checkpointId===id),'a removed version is gone');
  assert.ok(inventory(importBackup(exportBackup(after))).items.every(item=>item.available));
  return{beforeBytes,afterBytes,items};
}
test('clean-up on a fresh compacted project never increases stored bytes; chosen versions stay restorable and are never thinned',async()=>{
  const s=await session();
  try{
    for(let day=0;day<3;day++){for(let burst=0;burst<5;burst++){await s.type('chapter',`Day ${day} part ${burst}. `,150);clock+=7*60_000;}if(day===1)await s.call({op:'history.name',label:'Named'});clock+=DAY;}
    await storage.maintainHistory(s.id);
    const autos=(await s.call({op:'history.list'})).items.filter(item=>item.reason==='automatic');assert.ok(autos.length>=3);
    const keep=[autos.at(-1).checkpointId,autos[1].checkpointId],{items}=await cleanUpKeeps(s,keep);
    assert.ok(items.some(item=>item.label==='Named'&&item.available),'named versions stay');
    // Much later, automatic thinning still keeps what the person chose.
    clock+=40*DAY;await s.type('chapter',' later',150);await storage.maintainHistory(s.id);
    const later=inventory(await storage.readHistoryData(s.id)).items;for(const id of keep)assert.ok(later.some(item=>item.checkpointId===id&&item.available));
    // Cleaning up again with nothing chosen never grows it either.
    await cleanUpKeeps(s,[]);
  }finally{s.close();}
});
test('clean-up on the compacted version-7 project never increases stored bytes and keeps chosen versions restorable',async()=>{
  const id=legacy.projectId,doc=await storage.loadProject(id),s=await session({id,doc,create:false});
  try{
    await storage.maintainHistory(id);
    const items=(await s.call({op:'history.list'})).items,auto=items.filter(item=>item.reason==='automatic');
    await cleanUpKeeps(s,auto.slice(0,1).map(item=>item.checkpointId));
  }finally{s.close();}
});
test.after(()=>{Date.now=realNow;});
