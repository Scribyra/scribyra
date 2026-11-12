import './helpers/core.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as Y from 'yjs';
import { zipSync, strToU8 } from 'fflate';
import { addFile, importZip, exportZip, snapshot, validPath, inspectZip, addEntries, addFolder, duplicateNode, relocateNode, deleteNode, restoreDeleted, replaceAsset, migrateProject, projectNodes, treeRows } from '../web/model.js';
test('source and binary assets round-trip without loss', () => {
  const doc = new Y.Doc(); addFile(doc, 'chapters/été.tex', 'Café ∑ 你好'); addFile(doc, 'image.png', new Uint8Array([0,255,1,127]));
  const files = importZip(exportZip(doc)).filter(f => !f.folder); assert.equal(files.length,2); assert.equal(files[0].content,'Café ∑ 你好'); assert.deepEqual(files[1].content,new Uint8Array([0,255,1,127]));
});
test('reject traversal, absolute paths, malformed archives, duplicates', () => {
  for (const path of ['../evil','/root','a/../../x','a\\b','C:/test','a//b','a\0b']) { assert.equal(validPath(path),false); assert.throws(()=>importZip(zipSync({[path]:strToU8('x')}))); }
  assert.throws(()=>importZip(new Uint8Array([1,2,3])));
  const doc = new Y.Doc(); addFile(doc,'main.tex','first'); assert.throws(()=>addFile(doc,'main.tex','second'));
});
test('reject oversized decompressed ZIP before allocating output', () => {
  const bytes = zipSync({'main.tex':strToU8('tiny')});
  const v = new DataView(bytes.buffer); for(let i=0;i<bytes.length-46;i++) if(v.getUint32(i,true)===0x02014b50) { v.setUint32(i+24, 70*1024*1024,true); break; }
  assert.throws(()=>inspectZip(bytes),/64 MiB/);
});

test('source ZIP import rejects native sync/recovery records before decompression',()=>{
 for(const path of ['.scribyra-sync/session.json','paper/.ScRiByRa-SyNc/objects/hash','paper/.scribyra-sync-stage/main.tex']){
   const zip=zipSync({'main.tex':strToU8('source'),[path]:strToU8('private recovery')});assert.throws(()=>inspectZip(zip),/private Scribyra sync\/recovery/);
 }
 assert.equal(importZip(zipSync({'main.tex':strToU8('source'),'.config/settings.json':strToU8('{}')})).length,2);
});
test('renames preserve CRDT identity and concurrent changes converge', () => {
  const a=new Y.Doc(), b=new Y.Doc(); const id=addFile(a,'main.tex','hello'); Y.applyUpdate(b,Y.encodeStateAsUpdate(a));
  a.getText(`text:${id}`).insert(5,' world'); b.getText(`text:${id}`).insert(0,'Before ');
  relocateNode(a,id,'renamed.tex');
  const ua=Y.encodeStateAsUpdate(a), ub=Y.encodeStateAsUpdate(b); Y.applyUpdate(a,ub);Y.applyUpdate(b,ua);
  assert.deepEqual(snapshot(a),snapshot(b)); assert.equal(snapshot(a)[0].path,'renamed.tex'); assert.match(snapshot(a)[0].content,/Before hello world/);
});
test('legacy migration preserves text, binary bytes, main ID and deterministic directories', () => {
  const old = new Y.Doc();
  old.getMap('files').set('tex', {id:'tex',path:'chapters/été.tex',binary:false});
  old.getMap('files').set('img', {id:'img',path:'figures/a.png',binary:true});
  old.getText('text:tex').insert(0,'Café 你好'); old.getMap('assets').set('img',new Uint8Array([0,1,255]));
  old.getMap('meta').set('mainFile','tex');
  const copy = new Y.Doc(); Y.applyUpdate(copy,Y.encodeStateAsUpdate(old));
  migrateProject(old); migrateProject(copy);
  assert.deepEqual(projectNodes(old),projectNodes(copy)); assert.deepEqual(snapshot(old),snapshot(copy));
  const before = Y.encodeStateAsUpdate(old); migrateProject(old); assert.deepEqual(Y.encodeStateAsUpdate(old),before);
  assert.equal(old.getMap('meta').get('mainFile'),'tex'); assert.equal(old.getMap('meta').get('schemaVersion'),8);
  assert.equal(projectNodes(old).filter(n => n.folder).length,2);
});
test('folder moves retain live text/undo, deletion restores full subtree and main file', () => {
  const doc = new Y.Doc(), id = addFile(doc,'a/chapter.tex','hello');
  const text = doc.getText(`text:${id}`), undo = new Y.UndoManager(text);
  text.insert(5,' world'); doc.getMap('meta').set('mainFile',id);
  const folder = projectNodes(doc).find(n => n.folder);
  relocateNode(doc,folder.id,'chapters'); assert.equal(snapshot(doc)[0].path,'chapters/chapter.tex');
  undo.undo(); assert.equal(text.toString(),'hello'); undo.redo();
  deleteNode(doc,folder.id); assert.equal(snapshot(doc).length,0); assert.equal(doc.getMap('meta').get('mainFile'),'');
  restoreDeleted(doc); assert.equal(snapshot(doc)[0].id,id); assert.equal(snapshot(doc)[0].content,'hello world');
  assert.equal(doc.getMap('meta').get('mainFile'),id); assert.equal(doc.getMap('trash').size,0);
});
test('atomic batch validation and subtree collisions leave document untouched', () => {
  const doc = new Y.Doc(); addFile(doc,'a/main.tex','first'); addFile(doc,'b/main.tex','second');
  const before = Y.encodeStateAsUpdate(doc);
  assert.throws(()=>addEntries(doc,[{path:'okay.tex',content:'okay'},{path:'b/main.tex',content:'bad'}]),/already exists/);
  assert.throws(()=>relocateNode(doc,projectNodes(doc).find(n=>n.path==='a').id,'b'),/already exists/);
  assert.deepEqual(Y.encodeStateAsUpdate(doc),before);
});
test('empty folders survive ZIP; collapse hides descendants; image replacement retains path and ID', () => {
  const doc = new Y.Doc(), folder = addFolder(doc,'empty'), id = addFile(doc,'images/plot.png',new Uint8Array([1,2]));
  const imageFolder = projectNodes(doc).find(n=>n.path==='images');
  assert.equal(treeRows(doc,new Set([imageFolder.id])).length,2);
  replaceAsset(doc,id,new Uint8Array([3,4,5])); assert.equal(snapshot(doc)[0].path,'images/plot.png'); assert.deepEqual(snapshot(doc)[0].content,new Uint8Array([3,4,5]));
  const entries = importZip(exportZip(doc)); assert(entries.some(e=>e.path==='empty'&&e.folder));
  const copy = new Y.Doc(); addEntries(copy,entries); assert.deepEqual(snapshot(copy).map(({id,parentId,...f})=>f),snapshot(doc).map(({id,parentId,...f})=>f));
  assert(projectNodes(copy).some(n=>n.path==='empty'&&n.folder)); assert(doc.getMap('files').has(folder));
});
test('restore collisions preserve deleted content for later recovery', () => {
  const doc = new Y.Doc(), id = addFile(doc,'paper.tex','original'); deleteNode(doc,id);
  const replacement = addFile(doc,'paper.tex','replacement'); assert.throws(()=>restoreDeleted(doc),/already exists/);
  relocateNode(doc,replacement,'other.tex'); restoreDeleted(doc);
  assert.equal(snapshot(doc).find(n=>n.id===id).content,'original');
});
test('new inferred folders never reuse recoverable folder identities', () => {
  const doc = new Y.Doc(); addFile(doc,'a/paper.tex','original');
  const folder=projectNodes(doc).find(n=>n.path==='a'); deleteNode(doc,folder.id);
  addFile(doc,'a/new.tex','new'); const recreated=projectNodes(doc).find(n=>n.path==='a'); assert.notEqual(recreated.id,folder.id);
  relocateNode(doc,recreated.id,'b'); restoreDeleted(doc);
  assert.equal(snapshot(doc).find(f=>f.path==='a/paper.tex').content,'original');
});
test('folder rename concurrent with child creation follows parent identity', () => {
  const a=new Y.Doc(),b=new Y.Doc();addFile(a,'chapters/first.tex','first');const folder=projectNodes(a).find(n=>n.path==='chapters');Y.applyUpdate(b,Y.encodeStateAsUpdate(a));
  const childRecord=a.getMap('files').get(projectFilesForTest(a)[0].id);
  relocateNode(a,folder.id,'sections');const second=addFile(b,'chapters/second.tex','second');
  const ua=Y.encodeStateAsUpdate(a),ub=Y.encodeStateAsUpdate(b);Y.applyUpdate(a,ub);Y.applyUpdate(b,ua);
  assert.deepEqual(snapshot(a),snapshot(b));assert.equal(snapshot(a).find(n=>n.id===second).path,'sections/second.tex');
  assert.equal(a.getMap('files').get(childRecord.id),childRecord,'parent moves must not rewrite child metadata');
});
const projectFilesForTest=doc=>projectNodes(doc).filter(n=>!n.folder);
test('concurrent move cycles remain visible, editable and repairable', () => {
  const a=new Y.Doc(),b=new Y.Doc();const paper=addFile(a,'a/paper.tex','kept');addFile(a,'b/notes.tex','also kept');
  const fa=projectNodes(a).find(n=>n.path==='a').id,fb=projectNodes(a).find(n=>n.path==='b').id;Y.applyUpdate(b,Y.encodeStateAsUpdate(a));
  relocateNode(a,fa,'b/a');relocateNode(b,fb,'a/b');const ua=Y.encodeStateAsUpdate(a),ub=Y.encodeStateAsUpdate(b);Y.applyUpdate(a,ub);Y.applyUpdate(b,ua);
  assert.equal(treeRows(a).length,4);assert.throws(()=>snapshot(a),/cycle/);assert.equal(a.getText(`text:${paper}`).toString(),'kept');
  relocateNode(a,fa,'recovered');Y.applyUpdate(b,Y.encodeStateAsUpdate(a));assert.deepEqual(snapshot(a),snapshot(b));assert.equal(snapshot(a).find(n=>n.id===paper).path,'recovered/paper.tex');
});
test('concurrent parent deletion keeps newly created children recoverable', () => {
  const a=new Y.Doc(),b=new Y.Doc();addFile(a,'chapters/old.tex','old');const folder=projectNodes(a).find(n=>n.folder);Y.applyUpdate(b,Y.encodeStateAsUpdate(a));
  deleteNode(a,folder.id);const child=addFile(b,'chapters/new.tex','never lose');Y.applyUpdate(a,Y.encodeStateAsUpdate(b));
  assert(projectNodes(a).find(n=>n.id===child).conflict);assert.equal(treeRows(a).length,1);
  relocateNode(a,child,'recovered.tex');assert.equal(snapshot(a)[0].content,'never lose');restoreDeleted(a);assert.equal(snapshot(a).length,2);
});
test('case and canonically equivalent Unicode collisions cannot overwrite content', () => {
  const doc=new Y.Doc();addFile(doc,'Café.tex','original');
  assert.throws(()=>addFile(doc,'cafe\u0301.tex','replacement'),/already exists/);assert.equal(snapshot(doc)[0].content,'original');
});
test('a deleted conflicted graph can be restored and repaired without losing its text', () => {
  const doc=new Y.Doc();const a=addFolder(doc,'a'),b=addFolder(doc,'b');const paper=addFile(doc,'a/p.tex','recoverable');
  doc.getMap('files').set(a,{...doc.getMap('files').get(a),parentId:b});doc.getMap('files').set(b,{...doc.getMap('files').get(b),parentId:a});
  deleteNode(doc,a);assert.equal(projectNodes(doc).length,0);restoreDeleted(doc);assert.equal(treeRows(doc).length,3);
  relocateNode(doc,a,'fixed');assert.equal(snapshot(doc).find(f=>f.id===paper).content,'recoverable');
});
test('rapid deletions restore in reverse order even within one clock tick', () => {
  const doc=new Y.Doc(),a=addFile(doc,'a.tex','a'),b=addFile(doc,'b.tex','b');
  const now=Date.now;Date.now=()=>1000;
  try{deleteNode(doc,a);deleteNode(doc,b);}finally{Date.now=now;}
  restoreDeleted(doc);assert.equal(snapshot(doc)[0].id,b);restoreDeleted(doc);assert.equal(snapshot(doc).length,2);
});

test('duplicate subtrees get independent identities while sharing immutable asset contents',()=>{
  const doc=new Y.Doc(),root=addFolder(doc,'paper'),empty=addFolder(doc,'paper/empty'),text=addFile(doc,'paper/main.tex','original'),image=addFile(doc,'paper/image.png',new Uint8Array([11,22,33]));
  doc.getMap('meta').set('mainFile',text);const copy=duplicateNode(doc,root,'backup');assert.notEqual(copy,root);
  const nodes=projectNodes(doc),copiedText=nodes.find(n=>n.path==='backup/main.tex'),copiedImage=nodes.find(n=>n.path==='backup/image.png');
  assert.notEqual(nodes.find(n=>n.path==='backup/empty').id,empty);assert.notEqual(copiedImage.id,image);
  assert.equal(doc.getMap('assets').get(image).hash,doc.getMap('assets').get(copiedImage.id).hash);assert.equal(doc.getMap('meta').get('mainFile'),text);
  doc.getText(`text:${copiedText.id}`).insert(0,'copy ');assert.equal(doc.getText(`text:${text}`).toString(),'original');
  const before=Y.encodeStateAsUpdate(doc);assert.throws(()=>duplicateNode(doc,root,'BACKUP'),/already exists/);assert.deepEqual(Y.encodeStateAsUpdate(doc),before);
  assert.throws(()=>duplicateNode(doc,root,'paper/nested'),/outside/);doc.destroy();
});
