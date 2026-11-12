import './helpers/core.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as Y from 'yjs';
import { workspace_search, source_outline } from '../web/pkg/scribyra_app.js';
import { addEntries } from '../web/model.js';
import { sourceFiles,searchPlan,applyReplacements } from '../web/editor-model.js';
function project(){const doc=new Y.Doc();addEntries(doc,[{id:'a',path:'main.tex',content:'🌍 alpha alpha\n\\section{First}'},{id:'b',path:'chapters/two.tex',content:'alpha beta\n\\subsection{Second}'}]);return doc;}
function plan(doc,query='alpha',replacement='new',options={}){const files=sourceFiles(doc),result=JSON.parse(workspace_search(JSON.stringify({files,query,replacement,...options})));return searchPlan(doc,files,result);}
test('selected Unicode matches replace atomically across files; one undo preserves later edits',()=>{
  const doc=project(),batch=plan(doc);assert.equal(batch.matches.length,3);assert.equal(batch.matches.find(m=>m.fileId==='a').start,3);
  let updates=0;doc.on('update',()=>updates++);const {undo,count}=applyReplacements(doc,batch,[0,1,2]);assert.equal(count,3);assert.equal(updates,1);
  assert.match(doc.getText('text:a').toString(),/🌍 new new/);assert.match(doc.getText('text:b').toString(),/^new beta/);
  const peer=new Y.Doc();Y.applyUpdate(peer,Y.encodeStateAsUpdate(doc));peer.getText('text:b').insert(peer.getText('text:b').length,' remote');Y.applyUpdate(doc,Y.encodeStateAsUpdate(peer),'remote');
  undo.undo();assert.match(doc.getText('text:a').toString(),/alpha alpha/);assert.match(doc.getText('text:b').toString(),/^alpha beta/);assert.match(doc.getText('text:b').toString(),/ remote$/);
  undo.redo();assert.match(doc.getText('text:b').toString(),/^new beta/);assert.match(doc.getText('text:b').toString(),/ remote$/);undo.destroy();peer.destroy();doc.destroy();
});
test('reviews reject stale text, additions, foreign documents and truncated or invalid selections',()=>{
  const doc=project(),batch=plan(doc);doc.getText('text:a').insert(0,'changed');const before=Y.encodeStateAsUpdate(doc);assert.throws(()=>applyReplacements(doc,batch,[0]),/Source changed/);assert.deepEqual(Y.encodeStateAsUpdate(doc),before);
  const fresh=plan(doc);assert.throws(()=>applyReplacements(doc,fresh,[999]),/Invalid replacement/);assert.throws(()=>applyReplacements(project(),fresh,[0]),/Source changed/);
  addEntries(doc,[{path:'extra.tex',content:'alpha'}]);assert.throws(()=>applyReplacements(doc,fresh,[0]),/Source changed/);
  const files=sourceFiles(doc),limited=searchPlan(doc,files,{matches:[],truncated:true});assert.throws(()=>applyReplacements(doc,limited,[]),/Narrow/);doc.destroy();
});
test('typing in a file without matches, here, in another tab or by a direct-session peer, leaves a reviewed replacement usable',()=>{
  const doc=project();addEntries(doc,[{id:'c',path:'notes.tex',content:'gamma'}]);const batch=plan(doc);
  const other=new Y.Doc();Y.applyUpdate(other,Y.encodeStateAsUpdate(doc));other.getText('text:c').insert(0,'remote ');Y.applyUpdate(doc,Y.encodeStateAsUpdate(other),'remote');doc.getText('text:c').insert(0,'local ');
  const {count,undo}=applyReplacements(doc,batch,[0,1,2]);assert.equal(count,3);assert.equal(doc.getText('text:c').toString(),'local remote gamma');undo.destroy();
  const files=sourceFiles(doc),result=JSON.parse(workspace_search(JSON.stringify({files,query:'new',replacement:'old'})));doc.getText('text:c').insert(0,'during ');
  const during=searchPlan(doc,files,result);assert.deepEqual([...during.changedFiles],['c']);assert.equal(applyReplacements(doc,during,[0]).count,1);
  const again=plan(doc,'new','old');doc.getText('text:a').insert(0,'x');assert.throws(()=>applyReplacements(doc,again,[0]),/Source changed/);other.destroy();doc.destroy();
});
test('Rust regex capture replacement, zero-width matches and outline preserve UTF-16 positions',()=>{
  const doc=project(),batch=plan(doc,'(alpha) (beta)','$2/$1',{regexMode:true});applyReplacements(doc,batch,[0]).undo.destroy();assert.match(doc.getText('text:b').toString(),/^beta\/alpha/);
  const empty=plan(doc,'^','% ',{regexMode:true});applyReplacements(doc,empty,empty.matches.map((_,i)=>i)).undo.destroy();assert.match(doc.getText('text:a').toString(),/^% 🌍/);
  const outline=JSON.parse(source_outline(JSON.stringify(sourceFiles(doc))));assert.equal(outline.items.length,0); // every heading is now commented
  assert.throws(()=>plan(doc,'[','',{regexMode:true}),/unclosed/);doc.destroy();
});
test('large captured replacements stop before expanding beyond the preview limit',()=>{
  const files=[{id:'a',path:'large.tex',content:'a'.repeat(100000)}];const result=JSON.parse(workspace_search(JSON.stringify({files,query:'a+',replacement:'$0'.repeat(1000),regexMode:true})));
  assert.equal(result.truncated,true);assert.equal(result.matches.length,0);
});
