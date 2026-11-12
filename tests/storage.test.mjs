import 'fake-indexeddb/auto';
import './helpers/core.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as Y from 'yjs';
import { openDB } from 'idb';
import { addFile, snapshot, replaceAsset, deleteNode } from '../web/model.js';
import { assetBytes, cloneProject } from '../web/assets.js';
import { saveProject, loadProject, loadRevision, deleteProject, listProjects, preserveRecoveryProject, maintainHistory } from '../web/storage.js';

function project() { const doc=new Y.Doc(); addFile(doc,'main.tex','baseline'); doc.getMap('meta').set('name','Storage test'); return doc; }
const copy=cloneProject;
const contents=doc=>snapshot(doc).map(({id,...file})=>file);

test('clones and durable binary recovery descendants retain TeX link provenance',async()=>{
  const id=crypto.randomUUID(),doc=project();doc.getMap('meta').set('texLinkOrigin','link');await saveProject(id,doc);
  const cloned=cloneProject(doc),first=await preserveRecoveryProject(id,cloned),recovered=await loadProject(first.id);
  const second=await preserveRecoveryProject(first.id,recovered),descendant=await loadProject(second.id);
  for(const copy of [cloned,recovered,descendant])assert.equal(copy.getMap('meta').get('texLinkOrigin'),'link');
  for(const copy of [doc,cloned,recovered,descendant])copy.destroy();
});

test('concurrent stale writers merge without losing either edit, with consecutive journal entries',async()=>{
  const id=crypto.randomUUID(), initial=project(); await saveProject(id,initial);
  const a=copy(initial), b=copy(initial), file=snapshot(initial)[0].id;
  a.getText(`text:${file}`).insert(0,'Alice '); b.getText(`text:${file}`).insert(8,' Bob');
  const saved=await Promise.all([saveProject(id,a),saveProject(id,b)]);
  assert.deepEqual(saved.map(r=>r.sequence),[1,2]);
  const loaded=await loadProject(id); assert.equal(snapshot(loaded)[0].content,'Alice baseline Bob');
  const replayed=await loadRevision(id,2); assert.deepEqual(contents(replayed),contents(loaded));
  const original=await loadRevision(id,0); assert.equal(snapshot(original)[0].content,'baseline');
  assert.equal((await saveProject(id,loaded)).sequence,2,'no-op saves must not create history');
  for(const doc of [initial,a,b,loaded,replayed,original])doc.destroy();
});
test('journal replay rebuilds image replacements, deletion and late text edits exactly, before and after maintenance',async()=>{
  const id=crypto.randomUUID(), doc=project(), text=doc.getText(`text:${snapshot(doc)[0].id}`);
  const asset=addFile(doc,'figures/image.png',new Uint8Array([1,2,3])); await saveProject(id,doc);
  for(let i=1;i<=52;i++) {
    text.insert(text.length,` ${i}`);
    if(i===20)replaceAsset(doc,asset,new Uint8Array([4,5,6]));
    if(i===51)deleteNode(doc,asset);
    await saveProject(id,doc);
  }
  const beforeReplace=await loadRevision(id,19), afterReplace=await loadRevision(id,20), head=await loadRevision(id);
  assert.deepEqual(snapshot(beforeReplace).find(f=>f.binary).content,new Uint8Array([1,2,3]));
  assert.deepEqual(snapshot(afterReplace).find(f=>f.binary).content,new Uint8Array([4,5,6]));
  assert.deepEqual(contents(head),contents(doc)); assert.equal(head.getMap('trash').size,1);
  // History format 2 stores no full copy every 50 saves; maintenance merges the steps between kept versions.
  let db=await openDB('scribyra-v1'); const checkpoints=await db.getAllFromIndex('checkpoints','projectId',id);db.close();
  assert.deepEqual(checkpoints.map(c=>c.sequence),[0]);
  await maintainHistory(id);
  db=await openDB('scribyra-v1');const journal=await db.getAllFromIndex('journal','projectId',id);db.close();
  assert.deepEqual(journal.map(row=>[row.from??row.sequence,row.sequence]),[[1,52]]);
  const maintained=await loadRevision(id);assert.deepEqual(contents(maintained),contents(doc));assert.equal(maintained.getMap('trash').size,1);
  assert.deepEqual(Y.encodeStateAsUpdate(maintained),Y.encodeStateAsUpdate(head));
  for(const d of [doc,beforeReplace,afterReplace,head,maintained])d.destroy();
});
test('a failed journal write rolls back the project and can be retried',async()=>{
  const id=crypto.randomUUID(),doc=project();await saveProject(id,doc);
  doc.getText(`text:${snapshot(doc)[0].id}`).insert(0,'pending ');
  const original=IDBObjectStore.prototype.put;
  IDBObjectStore.prototype.put=function(...args){if(this.name==='journal')throw new DOMException('Disk full','QuotaExceededError');return original.apply(this,args);};
  try { await assert.rejects(saveProject(id,doc),/Disk full/); } finally { IDBObjectStore.prototype.put=original; }
  const loaded=await loadProject(id); assert.equal(snapshot(loaded)[0].content,'baseline');
  assert.equal((await saveProject(id,doc)).sequence,1);
  const recovered=await loadRevision(id);assert.equal(snapshot(recovered)[0].content,'pending baseline');
  for(const d of [doc,loaded,recovered])d.destroy();
});
test('deletion erases journal/checkpoints and prevents stale tabs from resurrecting projects',async()=>{
  const id=crypto.randomUUID(),doc=project();await saveProject(id,doc);
  doc.getText(`text:${snapshot(doc)[0].id}`).insert(0,'edit ');await saveProject(id,doc);
  await deleteProject(id); await assert.rejects(saveProject(id,doc),/deleted in another tab/);
  await assert.rejects(loadProject(id),/not found/);assert(!(await listProjects()).some(p=>p.id===id));
  const db=await openDB('scribyra-v1');
  for(const store of ['journal','checkpoints'])assert.equal((await db.getAllFromIndex(store,'projectId',id)).length,0);
  db.close();doc.destroy();
});
test('missing journal entries are reported instead of presenting an incomplete revision',async()=>{
  const id=crypto.randomUUID(),doc=project();await saveProject(id,doc);
  doc.getText(`text:${snapshot(doc)[0].id}`).insert(0,'edit ');await saveProject(id,doc);
  const db=await openDB('scribyra-v1');await db.delete('journal',[id,1]);db.close();
  await assert.rejects(loadRevision(id,1),/incomplete/);await assert.rejects(loadRevision(id,100),/Unknown/);doc.destroy();
});
test('schema upgrades are journaled without rewriting earlier durable revisions',async()=>{
  const id=crypto.randomUUID(),legacy=new Y.Doc();legacy.getMap('meta').set('schemaVersion',2);
  legacy.getMap('files').set('old',{id:'old',path:'chapters/paper.tex',binary:false});legacy.getText('text:old').insert(0,'historical');
  await saveProject(id,legacy);const upgraded=await loadProject(id),before=await loadRevision(id,0),after=await loadRevision(id,1);
  assert.equal(before.getMap('meta').get('schemaVersion'),2);assert.equal(after.getMap('meta').get('schemaVersion'),8);
  assert.equal(upgraded.getMap('files').get('old').parentId,'folder:chapters');assert.deepEqual(contents(before),contents(after));
  await assert.rejects(saveProject(id,legacy),/upgraded/);
  for(const doc of [legacy,upgraded,before,after])doc.destroy();
});
test('each earlier schema reaches 8 on open with nothing of direct sessions added, and schema-7 proofs survive',async()=>{
  const {newIdentity}=await import('../web/direct-identity.js'),{signRecords,identityAuthorId,validateProvenance}=await import('../web/direct-provenance.js');
  for(let version=1;version<8;version++){
    const id=crypto.randomUUID(),legacy=new Y.Doc(),lineage=crypto.randomUUID();let proofs={};
    legacy.getMap('meta').set('schemaVersion',version);legacy.getMap('meta').set('name','Older project');
    legacy.getMap('files').set('old',version<6?{id:'old',path:'main.tex',binary:false}:{id:'old',name:'main.tex',parentId:null,binary:false,folder:false});legacy.getText('text:old').insert(0,'older source');
    if(version>=6)legacy.getMap('meta').set('lineageId',lineage);
    if(version===7){
      const identity=await newIdentity(),authorId=identityAuthorId(identity.publicKey),changeId=crypto.randomUUID();
      legacy.getMap('authors').set(authorId,{version:1,id:authorId,authorId,changeId,createdAt:1,kind:'human',displayName:'Signed before schema 8'});
      await signRecords(legacy,identity);proofs=Object.fromEntries([...legacy.getMap('meta')].filter(([key])=>key.startsWith('directProof:')));assert.equal(Object.keys(proofs).length,1);
    }
    const expected=new Set([...legacy.getMap('meta').keys(),'schemaVersion','lineageId']);
    await saveProject(id,legacy);const upgraded=await loadProject(id),meta=upgraded.getMap('meta');
    assert.equal(meta.get('schemaVersion'),8,`from ${version}`);assert.deepEqual(new Set(meta.keys()),expected,`from ${version}`);
    assert.equal(upgraded.getText('text:old').toString(),'older source');assert.equal(meta.get('name'),'Older project');
    assert.deepEqual([...upgraded.share.keys()].filter(name=>!['meta','files','assets','trash','text:old'].includes(name)&&upgraded.getMap(name).size),version===7?['authors']:[],`from ${version}`);
    assert.deepEqual(Object.fromEntries([...meta].filter(([key])=>key.startsWith('directProof:'))),proofs,`from ${version}`);
    if(version===7){const empty=new Y.Doc();empty.getMap('meta').set('lineageId',lineage);await validateProvenance(empty,upgraded);empty.destroy();}
    // Opening again is not a further change: the head stays exactly where it was.
    const db=await openDB('scribyra-v1'),first=await db.get('projects',id),again=await loadProject(id),second=await db.get('projects',id);db.close();
    assert.equal(second.sequence,first.sequence);assert.deepEqual(second.update,first.update);
    for(const doc of [legacy,upgraded,again])doc.destroy();
  }
});
test('binary bytes are stored once across files, revisions and projects, then reclaimed safely',async()=>{
  const first=crypto.randomUUID(),second=crypto.randomUUID(),a=project(),b=project(),bytes=new Uint8Array(128*1024).fill(73);
  const one=addFile(a,'one.png',bytes);addFile(a,'two.png',bytes);addFile(b,'shared.png',bytes);
  await saveProject(first,a);await saveProject(second,b);
  const hash=a.getMap('assets').get(one).hash;assert.equal(hash.length,64);assert(Y.encodeStateAsUpdate(a).byteLength<4096,'metadata must not embed image contents');
  a.getText(`text:${snapshot(a).find(f=>!f.binary).id}`).insert(0,'later ');await saveProject(first,a);
  const db=await openDB('scribyra-v1');
  assert.equal((await db.getAllFromIndex('projectBlobs','hash',hash)).length,2);
  assert.equal((await db.get('blobs',hash)).bytes.length,bytes.length);
  const journal=await db.getAllFromIndex('journal','projectId',first);assert(journal.every(e=>e.update.byteLength<4096));
  await deleteProject(first);assert(await db.get('blobs',hash),'another project still references these bytes');
  const loaded=await loadProject(second);assert.deepEqual(snapshot(loaded).find(f=>f.binary).content,bytes);
  await deleteProject(second);assert.equal(await db.get('blobs',hash),undefined);db.close();for(const d of [a,b,loaded])d.destroy();
});
test('a failed blob write rolls back all metadata; corrupted stored bytes fail integrity checks',async()=>{
  const id=crypto.randomUUID(),doc=project();const asset=addFile(doc,'image.png',new Uint8Array([99,98,97]));
  const original=IDBObjectStore.prototype.put;IDBObjectStore.prototype.put=function(...args){if(this.name==='blobs')throw new DOMException('Blob disk full','QuotaExceededError');return original.apply(this,args);};
  try{await assert.rejects(saveProject(id,doc),/Blob disk full/);}finally{IDBObjectStore.prototype.put=original;}
  assert(!(await listProjects()).some(p=>p.id===id));await saveProject(id,doc);
  const db=await openDB('scribyra-v1'),hash=doc.getMap('assets').get(asset).hash;
  await db.put('blobs',{hash,bytes:new Uint8Array([0,0,0])});
  await assert.rejects(loadProject(id),/integrity/);await assert.rejects(loadRevision(id,0),/integrity/);db.close();doc.destroy();
});
test('legacy inline binary assets migrate without losing old revisions or recovery bytes',async()=>{
  const id=crypto.randomUUID(),legacy=new Y.Doc();legacy.getMap('meta').set('schemaVersion',3);
  legacy.getMap('files').set('image',{id:'image',name:'old.png',parentId:null,folder:false,binary:true});legacy.getMap('assets').set('image',new Uint8Array([7,8,9]));
  await saveProject(id,legacy);const upgraded=await loadProject(id),old=await loadRevision(id,0),current=await loadRevision(id,1);
  assert.equal(upgraded.getMap('meta').get('schemaVersion'),8);assert.equal(upgraded.getMap('assets').get('image').hash.length,64);
  assert.deepEqual(assetBytes(upgraded,'image'),new Uint8Array([7,8,9]));assert.deepEqual(assetBytes(old,'image'),assetBytes(current,'image'));
  const escaped=assetBytes(upgraded,'image');escaped.fill(0);assert.deepEqual(assetBytes(upgraded,'image'),new Uint8Array([7,8,9]));
  for(const doc of [legacy,upgraded,old,current])doc.destroy();
});
test('failed binary migration leaves the original record and recovery history untouched',async()=>{
  const id=crypto.randomUUID(),legacy=new Y.Doc();legacy.getMap('meta').set('schemaVersion',3);
  legacy.getMap('files').set('asset',{id:'asset',name:'legacy.png',parentId:null,binary:true,folder:false});legacy.getMap('assets').set('asset',new Uint8Array([71,72,73]));
  await saveProject(id,legacy);const db=await openDB('scribyra-v1'),before=await db.get('projects',id);
  const original=IDBObjectStore.prototype.put;IDBObjectStore.prototype.put=function(...args){if(this.name==='blobs')throw new DOMException('Migration disk full','QuotaExceededError');return original.apply(this,args);};
  try{await assert.rejects(loadProject(id),/Migration disk full/);}finally{IDBObjectStore.prototype.put=original;}
  assert.deepEqual(await db.get('projects',id),before);assert.equal(await db.get('migrationBackups',id),undefined);assert.equal((await db.getAllFromIndex('journal','projectId',id)).length,0);
  const loaded=await loadProject(id);assert.deepEqual(assetBytes(loaded,'asset'),new Uint8Array([71,72,73]));db.close();legacy.destroy();loaded.destroy();
});
test('stale saves hydrate unseen binary edits while retaining every historical version',async()=>{
  const id=crypto.randomUUID(),initial=project(),file=addFile(initial,'asset.png',new Uint8Array([10]));await saveProject(id,initial);
  const a=cloneProject(initial),b=cloneProject(initial);replaceAsset(a,file,new Uint8Array([20]));await saveProject(id,a);
  b.getText(`text:${snapshot(b).find(f=>!f.binary).id}`).insert(0,'stale edit ');
  const result=await saveProject(id,b);assert.equal(result.blobs.length,1);assert.deepEqual(result.blobs[0].bytes,new Uint8Array([20]));
  const head=await loadProject(id),old=await loadRevision(id,0);assert.deepEqual(assetBytes(head,file),new Uint8Array([20]));assert.deepEqual(assetBytes(old,file),new Uint8Array([10]));
  assert.match(snapshot(head).find(f=>!f.binary).content,/stale edit/);for(const doc of [initial,a,b,head,old])doc.destroy();
});
