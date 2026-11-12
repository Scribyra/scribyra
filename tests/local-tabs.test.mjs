import 'fake-indexeddb/auto';
import './helpers/core.mjs';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {openDB} from 'idb';
import * as Y from 'yjs';
import {addFile,replaceAsset,snapshot} from '../web/model.js';
import {assetBytes,cloneProject} from '../web/assets.js';
import {localTabs,LOCAL_DURABLE} from '../web/local-tabs.js';
import {createCommitBus,validCommitHint} from '../web/storage-events.js';
// Upgrade an actual older database before importing the storage adapter.
const legacy=new Y.Doc();addFile(legacy,'main.tex','seed');legacy.getMap('meta').set('name','Older device project');
const old=await openDB('scribyra-v1',5,{upgrade(db){db.createObjectStore('projects',{keyPath:'id'});db.createObjectStore('deletedProjects',{keyPath:'id'});}});
const original=Y.encodeStateAsUpdate(legacy);await old.put('projects',{id:'before-upgrade',sequence:0,schemaVersion:5,name:'Older device project',files:1,updatedAt:123,update:original});await old.put('deletedProjects',{id:'old-deletion',deletedAt:100});old.close();legacy.destroy();
const storage=await import('../web/storage.js');
function project(){const doc=new Y.Doc();const file=addFile(doc,'main.tex','baseline');return{doc,file,id:crypto.randomUUID()};}
function adapter(doc,id,options={}){return localTabs({doc,projectId:id,read:storage.readCommittedProject,host:null,visibility:null,pollMs:60000,watch:()=>()=>{},broadcastAvailable:()=>false,...options});}
test('database upgrade builds lightweight heads without changing project bytes or losing deletion markers',async()=>{
 const db=await openDB('scribyra-v1');assert.equal(db.version,8);assert.deepEqual((await db.get('projects','before-upgrade')).update,original);const head=await db.get('heads','before-upgrade');assert.equal(head.sequence,0);assert.equal(head.update,undefined);assert.equal((await db.get('heads','old-deletion')).deleted,true);assert.equal((await storage.listProjects()).some(p=>p.id==='old-deletion'),false);db.close();
});
test('commit hints are closed, metadata-only and never an authoritative deletion instruction',()=>{
 const channels=[];const factory=()=>{const channel={onmessage:null,close(){},postMessage(value){for(const other of channels)if(other!==channel)other.onmessage?.({data:structuredClone(value)});}};channels.push(channel);return channel;};const a=createCommitBus(factory),b=createCommitBus(factory),seen=[];a.subscribe(()=>{});b.subscribe(event=>seen.push(event));
 const hint={version:1,kind:'head',projectId:'public',sequence:2};assert(validCommitHint(hint));assert(!validCommitHint({...hint,update:new Uint8Array([1])}));assert(!validCommitHint({...hint,sequence:Infinity}));assert(!validCommitHint({...hint,version:2}));a.publish(hint);assert.equal(seen.length,1);assert.equal(seen[0].external,true);channels[1].onmessage({data:{...hint,kind:'inject-source'}});assert.equal(seen.length,1);a.close();b.close();
});
test('live committed heads merge around unsaved text and reject forged delete hints',async()=>{
 const p=project();await storage.saveProject(p.id,p.doc);const live=cloneProject(p.doc);let wake,deleted=false,origins=[];live.on('update',(_bytes,origin)=>origins.push(origin));const connection=adapter(live,p.id,{watch:listener=>{wake=listener;return()=>{};},onMissing:()=>deleted=true});
 try{await connection.refresh();live.getText(`text:${p.file}`).insert(0,'unsaved ');p.doc.getText(`text:${p.file}`).insert(8,' remote');await storage.saveProject(p.id,p.doc);wake({external:true,kind:'deleted',projectId:p.id});await connection.refresh();assert.equal(live.getText(`text:${p.file}`).toString(),'unsaved baseline remote');assert(origins.includes(LOCAL_DURABLE));assert.equal(deleted,false);assert.equal((await storage.readCommittedProject(p.id,connection.sequence)).kind,'unchanged');}
 finally{connection.close();live.destroy();p.doc.destroy();}
});
test('failed commits leave heads unchanged, and unchanged reads do not load snapshot or asset bytes',async()=>{
 const p=project();await storage.saveProject(p.id,p.doc);p.doc.getText(`text:${p.file}`).insert(0,'pending ');const put=IDBObjectStore.prototype.put;
 IDBObjectStore.prototype.put=function(...args){if(this.name==='heads')throw new DOMException('Head disk full','QuotaExceededError');return put.apply(this,args);};try{await assert.rejects(storage.saveProject(p.id,p.doc),/Head disk full/);}finally{IDBObjectStore.prototype.put=put;}
 const head=await storage.readCommittedProject(p.id);assert.equal(head.head.sequence,0);const loaded=await storage.loadProject(p.id);assert.equal(loaded.getText(`text:${p.file}`).toString(),'baseline');loaded.destroy();
 const get=IDBObjectStore.prototype.get;IDBObjectStore.prototype.get=function(...args){if(['projects','blobs'].includes(this.name))throw new Error('Unchanged poll loaded document bytes');return get.apply(this,args);};try{assert.equal((await storage.readCommittedProject(p.id,0)).kind,'unchanged');}finally{IDBObjectStore.prototype.get=get;}
 p.doc.destroy();
});
test('asset verification precedes publication and a repaired blob can be retried atomically',async()=>{
 const p=project(),asset=addFile(p.doc,'figures/data.bin',new Uint8Array([1]));await storage.saveProject(p.id,p.doc);const live=cloneProject(p.doc),errors=[],connection=adapter(live,p.id,{onError:e=>errors.push(e.message)});await connection.refresh();const before=Y.encodeStateAsUpdate(live);
 try{replaceAsset(p.doc,asset,new Uint8Array([2]));p.doc.getText(`text:${p.file}`).insert(0,'peer ');await storage.saveProject(p.id,p.doc);const hash=p.doc.getMap('assets').get(asset).hash,db=await openDB('scribyra-v1');await db.put('blobs',{hash,bytes:new Uint8Array([9])});await connection.refresh();assert.deepEqual(Y.encodeStateAsUpdate(live),before);assert.deepEqual(assetBytes(live,asset),new Uint8Array([1]));assert(errors.some(e=>/integrity/.test(e)));
 await db.put('blobs',{hash,bytes:new Uint8Array([2])});await connection.refresh();assert.deepEqual(assetBytes(live,asset),new Uint8Array([2]));assert.equal(snapshot(live).find(f=>!f.binary).content,'peer baseline');db.close();}
 finally{connection.close();live.destroy();p.doc.destroy();}
});
test('composition defers incoming heads, resume polling recovers dropped hints, and closed adapters reject late reads',async()=>{
 const p=project();await storage.saveProject(p.id,p.doc);const live=cloneProject(p.doc);let composing=true;const connection=adapter(live,p.id,{isComposing:()=>composing,pollMs:10});
 try{p.doc.getText(`text:${p.file}`).insert(0,'peer ');await storage.saveProject(p.id,p.doc);await connection.refresh();assert.equal(live.getText(`text:${p.file}`).toString(),'baseline');composing=false;const deadline=Date.now()+1000;while(!live.getText(`text:${p.file}`).toString().startsWith('peer')){if(Date.now()>deadline)throw new Error('Polling did not reconcile');await new Promise(r=>setTimeout(r,10));}}
 finally{connection.close();live.destroy();}
 const abandoned=cloneProject(p.doc);let resolve;const pending=new Promise(r=>resolve=r),late=adapter(abandoned,p.id,{read:()=>pending});const done=late.refresh();late.close();p.doc.getText(`text:${p.file}`).insert(0,'late ');await storage.saveProject(p.id,p.doc);resolve(await storage.readCommittedProject(p.id));await done;assert(!abandoned.getText(`text:${p.file}`).toString().startsWith('late'));abandoned.destroy();p.doc.destroy();
});
test('concurrent binary writers retain the complete losing side as an independent durable project',async()=>{
 const p=project(),asset=addFile(p.doc,'image.bin',new Uint8Array([1]));await storage.saveProject(p.id,p.doc);const a=cloneProject(p.doc),b=cloneProject(p.doc);replaceAsset(a,asset,new Uint8Array([2]));replaceAsset(b,asset,new Uint8Array([3]));await storage.saveProject(p.id,a);const result=await storage.saveProject(p.id,b);assert.equal(result.recoveries.length,1);
 const current=await storage.loadProject(p.id),recovery=await storage.loadProject(result.recoveries[0].id);assert.deepEqual([assetBytes(current,asset)[0],assetBytes(recovery,asset)[0]].sort(),[2,3]);assert.match(recovery.getMap('meta').get('name'),/binary recovery/);await storage.deleteProject(p.id);const kept=await storage.loadProject(result.recoveries[0].id);assert.deepEqual(assetBytes(kept,asset),assetBytes(recovery,asset));for(const doc of [p.doc,a,b,current,recovery,kept])doc.destroy();
});
test('ordered binary replacements do not create spurious recovery projects',async()=>{
 const p=project(),asset=addFile(p.doc,'image.bin',new Uint8Array([1]));await storage.saveProject(p.id,p.doc);replaceAsset(p.doc,asset,new Uint8Array([2]));assert.deepEqual((await storage.saveProject(p.id,p.doc)).recoveries,[]);const next=await storage.loadProject(p.id);replaceAsset(next,asset,new Uint8Array([3]));assert.deepEqual((await storage.saveProject(p.id,next)).recoveries,[]);next.destroy();p.doc.destroy();
});
test('live binary merges refuse to overwrite a losing version until its recovery project commits',async()=>{
 const p=project(),asset=addFile(p.doc,'image.bin',new Uint8Array([1]));await storage.saveProject(p.id,p.doc);const live=cloneProject(p.doc);replaceAsset(live,asset,new Uint8Array([3]));replaceAsset(p.doc,asset,new Uint8Array([2]));await storage.saveProject(p.id,p.doc);const before=Y.encodeStateAsUpdate(live),recoveries=[],errors=[],put=IDBObjectStore.prototype.put;
 IDBObjectStore.prototype.put=function(value,...args){if(this.name==='heads'&&String(value.id).startsWith('recovery-'))throw new DOMException('Recovery quota','QuotaExceededError');return put.call(this,value,...args);};
 const connection=adapter(live,p.id,{preserve:storage.preserveRecoveryProject,onRecovery:r=>recoveries.push(r),onError:e=>errors.push(e)});
 try{await connection.refresh();assert.deepEqual(Y.encodeStateAsUpdate(live),before);assert.deepEqual(assetBytes(live,asset),new Uint8Array([3]));assert(errors.some(e=>/Recovery quota/.test(e.message)));IDBObjectStore.prototype.put=put;await connection.refresh();assert.equal(recoveries.length,1);const recovered=await storage.loadProject(recoveries[0].id);assert.deepEqual([assetBytes(live,asset)[0],assetBytes(recovered,asset)[0]].sort(),[2,3]);recovered.destroy();}
 finally{IDBObjectStore.prototype.put=put;connection.close();live.destroy();p.doc.destroy();}
});
test('delete-set concurrency preserves a binary replacement when the other side deletes its file',async()=>{
 const p=project(),asset=addFile(p.doc,'image.bin',new Uint8Array([1]));await storage.saveProject(p.id,p.doc);const a=cloneProject(p.doc),b=cloneProject(p.doc);replaceAsset(a,asset,new Uint8Array([9]));b.getMap('files').delete(asset);await storage.saveProject(p.id,b);const result=await storage.saveProject(p.id,a);assert.equal(result.recoveries.length,1);const recovered=await storage.loadProject(result.recoveries[0].id);assert.deepEqual(assetBytes(recovered,asset),new Uint8Array([9]));for(const doc of [p.doc,a,b,recovered])doc.destroy();
});
test('failure to preserve a losing binary side rolls back the entire merge and its head',async()=>{
 const p=project(),asset=addFile(p.doc,'image.bin',new Uint8Array([1]));await storage.saveProject(p.id,p.doc);const a=cloneProject(p.doc),b=cloneProject(p.doc);replaceAsset(a,asset,new Uint8Array([2]));replaceAsset(b,asset,new Uint8Array([3]));await storage.saveProject(p.id,a);const before=await storage.readCommittedProject(p.id),put=IDBObjectStore.prototype.put;IDBObjectStore.prototype.put=function(value,...args){if(this.name==='heads'&&String(value.id).startsWith('recovery-'))throw new DOMException('Recovery quota','QuotaExceededError');return put.call(this,value,...args);};try{await assert.rejects(storage.saveProject(p.id,b),/Recovery quota/);}finally{IDBObjectStore.prototype.put=put;}
 const after=await storage.readCommittedProject(p.id);assert.equal(after.head.sequence,before.head.sequence);assert.deepEqual(after.update,before.update);for(const doc of [p.doc,a,b])doc.destroy();
});

test('local-tab diagnostics report actual merges and failures without polling noise or source',async()=>{
 const {TelemetryRecorder}=await import('../web/pkg/scribyra_app.js'),{telemetry}=await import('../web/telemetry.js'),{installObservability}=await import('../web/observability.js');
 const recorder=new TelemetryRecorder(),api=telemetry({recorder}),p=project();await storage.saveProject(p.id,p.doc);const live=cloneProject(p.doc);api.configure({collect:true,allowExport:true});installObservability(api);
 const connection=adapter(live,p.id);
 try{
  await connection.refresh();assert(api.snapshot().events.some(event=>event.operation==='local_tabs'&&event.outcome==='success'));
  api.clear();await connection.refresh();assert(!api.snapshot().events.some(event=>event.operation==='local_tabs'));
  p.doc.getText(`text:${p.file}`).insert(0,'PRIVATE_LOCAL_TAB_SOURCE');await storage.saveProject(p.id,p.doc);await connection.refresh();
  assert.equal(live.getText(`text:${p.file}`).toString(),'PRIVATE_LOCAL_TAB_SOURCEbaseline');assert(api.snapshot().events.some(event=>event.operation==='local_tabs'&&event.outcome==='success'&&event.metrics.some(metric=>metric.name==='bytes'&&metric.value>0)));
  assert.doesNotMatch(api.export(),/PRIVATE_LOCAL_TAB_SOURCE|main\.tex/);
 }finally{connection.close();live.destroy();p.doc.destroy();installObservability(null);recorder.free();}
});
