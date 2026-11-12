// Regressions for the large-project bottlenecks (docs/large-projects.md): cached comment
// projections and per-text memos must never serve stale state.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import * as Y from 'yjs';
import {integrationSession} from './helpers/integration-session.mjs';
import {discussion} from '../web/comments.js';
import {anchors} from '../web/comment-anchors.js';
import {textMemo} from '../web/text-memo.js';
import {project_comments} from '../web/pkg/scribyra_app.js';
import {ROOTS} from '../web/collaboration-schema.js';
const ok=reply=>{assert.equal(reply.ok,true,JSON.stringify(reply));return reply.value;};
const uncached=doc=>JSON.parse(project_comments(JSON.stringify(Object.fromEntries(ROOTS.map(root=>[root,doc.getMap(root).toJSON()])))));

test('the cached comment projection equals a full projection through edits, comments, replies and decisions',async()=>{
 const f=await integrationSession();
 try{
  const same=()=>{const cached=discussion(f.doc),full=uncached(f.doc);assert.deepEqual(cached.threads.map(t=>[t.id,t.status,t.messages.length]),full.threads.map(t=>[t.id,t.status,full.messages.filter(m=>m.threadId===t.id).length]));assert.deepEqual(cached.authors,full.authors);assert.deepEqual(cached.suggestionTargets,full.suggestionTargets);return cached;};
  same();const text=f.doc.getText('text:main'),at=f.source().indexOf('bravo');
  const thread=ok(await f.call({op:'thread.create',fileId:'main',start:at,end:at+5,body:'First'}));
  assert.equal(same().threads.length,1);
  for(let i=0;i<20;i++)text.insert(0,'x');
  let view=same();assert.equal(view.threads[0].start,at+20,'anchor positions follow text edits');
  ok(await f.call({op:'thread.reply',threadId:thread.threadId,body:'Second'}));assert.equal(same().threads[0].messages.length,2);
  ok(await f.call({op:'thread.resolve',threadId:thread.threadId,eventHeads:discussion(f.doc).threads[0].eventHeads}));assert.equal(same().threads[0].status,'resolved');
  // Edits inside a transaction see their own changes.
  f.doc.transact(()=>{text.delete(0,20);assert.equal(discussion(f.doc).threads[0].start,at);});
  assert.equal(same().threads[0].start,at);
  text.delete(at,5);view=same();assert.equal(view.threads[0].anchorStatus,'detached','a deleted selection detaches at once');
 }finally{f.close();}
});

test('text memos drop a file\'s entries when its text or the tree changes, and are bypassed inside a transaction',()=>{
 const doc=new Y.Doc(),a=doc.getText('text:a'),b=doc.getText('text:b');a.insert(0,'alpha');b.insert(0,'beta');
 let calls=0;const read=id=>textMemo(doc,id,'string',()=>{calls++;return doc.getText('text:'+id).toString();});
 assert.equal(read('a'),'alpha');assert.equal(read('a'),'alpha');assert.equal(calls,1);
 b.insert(0,'x');assert.equal(read('a'),'alpha');assert.equal(calls,1,'another file\'s edit keeps the entry');
 a.insert(5,'!');assert.equal(read('a'),'alpha!');assert.equal(calls,2);
 doc.transact(()=>{a.insert(0,'>');assert.equal(read('a'),'>alpha!');});assert.equal(read('a'),'>alpha!');
 const before=calls;doc.getMap('files').set('n',{id:'n'});read('a');assert.equal(calls,before+1,'a tree change clears every entry');
 assert.equal(textMemo(doc,'missing','string',()=>'computed'),'computed');assert.equal(doc.share.has('text:missing'),false,'no root is created for an unknown file');
 doc.destroy();
});

test('memoized anchor resolution and capture return fresh copies and follow edits',async()=>{
 const f=await integrationSession();
 try{
  const at=f.source().indexOf('charlie'),anchor=anchors.capture(f.doc,'main',at,at+7);
  const first=anchors.resolve(f.doc,anchor);first.start=-1;assert.equal(anchors.resolve(f.doc,anchor).start,at,'callers cannot corrupt the memo');
  const copy=anchors.capture(f.doc,'main',at,at+7);copy.witnesses.length=0;assert.ok(anchors.capture(f.doc,'main',at,at+7).witnesses.length>0);
  f.doc.getText('text:main').insert(0,'12345');assert.equal(anchors.resolve(f.doc,anchor).start,at+5);
  f.doc.getText('text:main').delete(at+5,7);assert.equal(anchors.resolve(f.doc,anchor).status,'detached');
 }finally{f.close();}
});

test('text memos follow a text first seen as an untyped root of an applied update',()=>{
 const source=new Y.Doc();source.getText('text:a').insert(0,'alpha');
 const doc=new Y.Doc();Y.applyUpdate(doc,Y.encodeStateAsUpdate(source));
 const read=()=>textMemo(doc,'a','string',()=>doc.getText('text:a').toString());
 assert.equal(read(),'alpha');doc.getText('text:a').insert(0,'>');assert.equal(read(),'>alpha');
 source.destroy();doc.destroy();
});

test('history inventory reuses a result only for the same stored history, and listed versions match full verification',async()=>{
 const storage=await import('../web/storage.js'),{inventory,openVersion}=await import('../web/history-storage.js');
 // Automatic versions are saved at most every five minutes (history format 2): let time pass.
 const realNow=Date.now;let clock=realNow();Date.now=()=>clock;
 const f=await integrationSession();
 try{
  for(let i=0;i<120;i++){f.doc.getText('text:main').insert(0,`line ${i}\n`);clock+=10_000;await f.context.flushSave();}
  ok(await f.call({op:'history.name',label:'Named'}));
  const data=await storage.readHistoryData(f.projectId),first=inventory(data);
  assert.ok(first.items.filter(item=>item.reason==='automatic').length>=2,'several automatic checkpoints');
  for(const item of first.items.filter(item=>item.available)){
   const cp=openVersion(data,first,item.checkpointRef);
   try{assert.equal(item.createdAt,cp.manifest.createdAt);if(!item.versionId)assert.deepEqual(new Set(item.contributors),new Set(cp.manifest.changeIds.map(id=>cp.doc.getMap('changes').get(id)?.authorId).filter(Boolean)));}finally{cp.doc.destroy();}
  }
  first.items[0].label='changed by a caller';
  const again=inventory(await storage.readHistoryData(f.projectId));assert.notEqual(again.items[0].label,'changed by a caller');assert.deepEqual(again.items.map(i=>i.checkpointRef),first.items.map(i=>i.checkpointRef));
  f.doc.getText('text:main').insert(0,'more\n');for(let i=0;i<50;i++){f.doc.getText('text:main').insert(0,'x');clock+=10_000;await f.context.flushSave();}
  const later=inventory(await storage.readHistoryData(f.projectId));assert.ok(later.items.length>first.items.length,'a new checkpoint is not hidden by the reused result');
 }finally{f.close();Date.now=realNow;}
});

test('map memos follow their map, ignore others and are bypassed inside a transaction',async()=>{
 const {mapMemo}=await import('../web/text-memo.js'),doc=new Y.Doc(),events=doc.getMap('discussionEvents');let calls=0;
 const read=()=>mapMemo(doc,'discussionEvents','k',()=>{calls++;return JSON.stringify(events.toJSON());});
 events.set('a',1);assert.equal(read(),'{"a":1}');read();assert.equal(calls,1);
 doc.getMap('changes').set('x',1);read();assert.equal(calls,1);
 events.set('b',2);assert.equal(read(),'{"a":1,"b":2}');
 doc.transact(()=>{events.delete('a');assert.equal(read(),'{"b":2}');});assert.equal(read(),'{"b":2}');
 doc.destroy();
});
test('review projections stay current through decisions after being memoized',async()=>{
 const {projection}=await import('../web/review-commands.js'),f=await integrationSession();
 try{
  const at=f.source().indexOf('bravo'),review=ok(await f.call({op:'review.create',title:'R'})),s=ok(await f.call({op:'suggestion.propose',reviewId:review.reviewId,fileId:'main',start:at,end:at+5,before:'bravo',after:'BRAVO'}));
  assert.equal(projection(f.doc,s.suggestionId).status,'pending');f.doc.getText('text:main').insert(0,'typing ');assert.equal(projection(f.doc,s.suggestionId).status,'pending');
  ok(await f.call({op:'suggestion.reject',suggestionId:s.suggestionId,eventHeads:f.heads(s.suggestionId)},false));
  assert.equal(projection(f.doc,s.suggestionId).status,'rejected');
 }finally{f.close();}
});
