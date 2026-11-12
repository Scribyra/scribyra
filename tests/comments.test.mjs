import './helpers/core.mjs';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import * as Y from 'yjs';
import {addFile} from '../web/model.js';
import {validateCollaboration,LIMITS,lineageForProject} from '../web/collaboration-schema.js';
import {anchors} from '../web/comment-anchors.js';
import {sourceAffecting,AgentOrigin,ReviewOrigin,AnnotationOrigin,changeOrigins,registerRemoteOrigin} from '../web/change-origins.js';
import {collaborationCommands} from '../web/collaboration-commands.js';
const record=()=>({version:1,id:crypto.randomUUID(),authorId:crypto.randomUUID(),changeId:crypto.randomUUID(),createdAt:1,threadId:crypto.randomUUID(),body:'A comment 😀',mentionAuthorIds:[]});
test('reserved records are closed and bounded; missing roots equal empty roots',()=>{
 const doc=new Y.Doc();addFile(doc,'main.tex','accepted');validateCollaboration(doc);const message=record();doc.getMap('messages').set(message.id,message);validateCollaboration(doc);
 for(const bad of [{...message,secret:'forbidden'},{...message,body:'é'.repeat(LIMITS.messageBytes)},{...message,mentionAuthorIds:Array(65).fill(crypto.randomUUID())},{...message,version:2}]){doc.getMap('messages').set(message.id,bad);assert.throws(()=>validateCollaboration(doc));}
 const nested=new Y.Map(Object.entries(message));doc.getMap('messages').set(message.id,nested);assert.throws(()=>validateCollaboration(doc),/immutable JSON/);
 assert.throws(()=>anchors.capture(doc,'file',0,1),e=>e.code==='anchor_detached');doc.destroy();
});
test('annotations invalidate command revisions but preserve accepted-source invalidation',()=>{
 const doc=new Y.Doc();const id=addFile(doc,'main.tex','accepted'),host=collaborationCommands({doc,projectId:'p'}),before=host.revision(),updates=[];
 doc.on('update',(_u,_o,_d,transaction)=>updates.push(sourceAffecting(doc,transaction)));
 const message=record();doc.transact(()=>doc.getMap('messages').set(message.id,message),new AnnotationOrigin());assert.deepEqual(updates,[false]);assert.notEqual(host.revision(),before);
 doc.getText(`text:${id}`).delete(0,1);assert.deepEqual(updates,[false,true]);host.close();doc.destroy();
});
test('agent commands have isolated undo groups and remote changes stay outside undo',()=>{
 const doc=new Y.Doc(),id=addFile(doc,'main.tex','base'),text=doc.getText(`text:${id}`),manager=new Y.UndoManager(text,{trackedOrigins:new Set([null,AgentOrigin])});
 const origins=changeOrigins({doc,managers:new Map([[id,manager]])});text.insert(0,'human ');doc.transact(()=>text.insert(text.length,' agent'),new AgentOrigin({authorId:crypto.randomUUID()}));text.insert(text.length,' later');
 manager.undo();assert.equal(text.toString(),'human base agent');manager.undo();assert.equal(text.toString(),'human base');manager.undo();assert.equal(text.toString(),'base');origins.close();manager.destroy();doc.destroy();
});
test('migration lineage is deterministic and scoped by the original project key',()=>{assert.equal(lineageForProject('p'),lineageForProject('p'));assert.notEqual(lineageForProject('p'),lineageForProject('q'));assert.match(lineageForProject('p'),/^[a-f0-9-]{14}5/);});
test('peer updates and dedicated review batches cannot enter per-file source undo',()=>{
 const doc=new Y.Doc(),id=addFile(doc,'main.tex','base'),text=doc.getText(`text:${id}`),manager=new Y.UndoManager(text,{trackedOrigins:new Set([null,AgentOrigin])}),peer=new Y.Doc();Y.applyUpdate(peer,Y.encodeStateAsUpdate(doc));
 peer.getText(`text:${id}`).insert(0,'peer ');const remote=Symbol('remote'),unregister=registerRemoteOrigin(remote);Y.applyUpdate(doc,Y.encodeStateAsUpdate(peer),remote);manager.undo();assert.equal(text.toString(),'peer base');doc.transact(()=>text.insert(text.length,' accepted'),new ReviewOrigin());manager.undo();assert.equal(text.toString(),'peer base accepted');unregister();manager.destroy();peer.destroy();doc.destroy();
});
test('semantic count and UTF-8 aggregate bounds reject incoming state without truncation',()=>{
 const doc=new Y.Doc();addFile(doc,'main.tex','source');const records=doc.getMap('messages');
 for(let i=0;i<=LIMITS.records;i++){const message=record();records.set(message.id,message);}assert.throws(()=>validateCollaboration(doc),/record limit/);doc.destroy();
 const oversized=new Y.Doc();addFile(oversized,'main.tex','source');const message=record();oversized.getMap('messages').set(message.id,{...message,body:'x'.repeat(LIMITS.semanticBytes)});assert.throws(()=>validateCollaboration(oversized),/16 MiB/);oversized.destroy();
});

test('anchor contract preserves Unicode, boundaries, interior edits and explicit identity',()=>{
 const doc=new Y.Doc(),id=addFile(doc,'main.tex','a😀bcdef'),text=doc.getText(`text:${id}`);
 assert.throws(()=>anchors.capture(doc,id,2,3),e=>e.code==='invalid_request');
 const anchor=anchors.capture(doc,id,1,5);assert.equal(anchor.quote,'😀bc');
 text.insert(1,'L');text.insert(6,'R');assert.deepEqual(anchors.resolve(doc,anchor),{status:'attached',start:2,end:6});
 text.insert(4,'inside');assert.equal(text.toString().slice(...Object.values(anchors.resolve(doc,anchor)).slice(1)),'😀insidebc');
 text.delete(2,2);assert.deepEqual(anchors.resolve(doc,anchor),{status:'attached',start:8,end:10});
 text.delete(8,2);text.insert(8,'bc');assert.equal(anchors.resolve(doc,anchor).reason,'selection_deleted');
 const rebound=anchors.rebind(doc,anchor,id,8,10);assert.equal(anchors.resolve(doc,rebound).status,'attached');assert.equal(anchors.resolve(doc,anchor).status,'detached');doc.destroy();
});
test('point anchors detach with their character; EOF and empty boundaries stay valid',()=>{
 const doc=new Y.Doc(),id=addFile(doc,'main.tex','abc'),text=doc.getText(`text:${id}`),point=anchors.capture(doc,id,1,1),eof=anchors.capture(doc,id,3,3);
 text.insert(1,'X');assert.deepEqual(anchors.resolve(doc,point),{status:'attached',start:2,end:2});text.delete(2,1);assert.equal(anchors.resolve(doc,point).reason,'associated_item_deleted');
 text.insert(text.length,'end');assert.deepEqual(anchors.resolve(doc,eof),{status:'attached',start:text.length,end:text.length});
 const empty=addFile(doc,'empty.tex',''),boundary=anchors.capture(doc,empty,0,0);assert.equal(anchors.resolve(doc,boundary).status,'attached');doc.destroy();
});
test('checkpoint bindings require exact source mapping and preserve point ownership',()=>{
 const checkpoint=new Y.Doc(),restored=new Y.Doc(),id=addFile(checkpoint,'main.tex','abc'),mapped=addFile(restored,'renamed.tex','abc'),point=anchors.capture(checkpoint,id,1,1),range=anchors.capture(checkpoint,id,0,3);
 try{
  const rebound=anchors.checkpointBinding(checkpoint,restored,point,mapped);assert.equal(rebound.fileId,mapped);assert.deepEqual(anchors.resolve(restored,rebound),{status:'attached',start:1,end:1});
  restored.getText('text:'+mapped).delete(1,1);assert.equal(anchors.resolve(restored,rebound).status,'detached');assert.equal(anchors.checkpointBinding(checkpoint,restored,range,mapped),null);
  assert.equal(anchors.checkpointBinding(checkpoint,restored,range,'missing'),null);
  checkpoint.getText('text:'+id).delete(0,3);assert.equal(anchors.checkpointBinding(checkpoint,restored,range,mapped),null);
 }finally{checkpoint.destroy();restored.destroy();}
});

import {registerComments,discussion} from '../web/comments.js';
import {relocateNode,deleteNode,restoreDeleted,duplicateNode} from '../web/model.js';
const author=(kind='human')=>({id:crypto.randomUUID(),kind,displayName:kind==='agent'?'Agent fixture':'Human fixture'});
function commentsFixture({doc=new Y.Doc(),person=author(),capabilities,origins}={}){
 const id=doc.getMap('files').size?[...doc.getMap('files').keys()][0]:addFile(doc,'main.tex','prefix 😀 selected suffix');
 const commands=collaborationCommands({doc,projectId:'comments',capabilities}),service=registerComments({doc,commands,author:person,origins});
 const request=command=>({version:2,requestId:crypto.randomUUID(),projectId:'comments',expectedRevision:commands.revision(),command});
 const execute=command=>commands.execute(request(command));
 const run=command=>{const reply=execute(command);assert.equal(reply.ok,true,JSON.stringify(reply.error));return reply.value;};
 const create=()=>run({op:'thread.create',fileId:id,start:10,end:18,body:'Plain <img src=x onerror=alert(1)>',mentions:[]});
 return{doc,id,person,commands,service,request,execute,run,create,close(){service.close();commands.close();doc.destroy();}};
}
test('v2 threads, replies, revisions, plain text edits, redaction, mentions and profile attribution',()=>{
 const f=commentsFixture();try{
  const before=f.doc.getText(`text:${f.id}`).toString(),created=f.create();assert.equal(f.commands.describe().length,9);
  const request=f.request({op:'thread.reply',threadId:created.threadId,body:'Reply 😀',mentions:[f.person.id]}),reply=f.commands.execute(request);assert.equal(reply.ok,true);assert.deepEqual(f.commands.execute(request),reply);
  let thread=discussion(f.doc).threads[0];assert.equal(thread.messages.length,2);assert.equal(thread.messages[1].variants[0].mentions[0].name,'Human fixture');
  f.run({op:'message.edit',messageId:created.messageId,body:'Edited <b>text</b>',mentions:[]});assert.equal(f.doc.getMap('messages').get(created.messageId).body,'Plain <img src=x onerror=alert(1)>');
  assert.equal(discussion(f.doc).threads[0].messages[0].variants[0].body,'Edited <b>text</b>');
  f.run({op:'message.redact',messageId:created.messageId});assert.equal(discussion(f.doc).threads[0].messages[0].variants[0].redacted,true);
  f.service.rename('Renamed author');assert.equal(discussion(f.doc).threads[0].messages[0].authorName,'Renamed author');
  f.run({op:'thread.resolve',threadId:created.threadId,eventHeads:[]});thread=discussion(f.doc).threads[0];assert.equal(thread.status,'resolved');
  f.run({op:'thread.reopen',threadId:created.threadId,eventHeads:thread.eventHeads});assert.equal(discussion(f.doc).threads[0].status,'open');
  assert.equal(f.doc.getText(`text:${f.id}`).toString(),before);validateCollaboration(f.doc);
 }finally{f.close();}
});
test('comment-only grants cannot edit another author; reviews allow moderation; reads and closed retries stay gated',()=>{
 const f=commentsFixture();try{
  const created=f.create(),other=author('agent'),commands=collaborationCommands({doc:f.doc,projectId:'comments',capabilities:['read','comment']}),service=registerComments({doc:f.doc,commands,author:other});
  const request=command=>({version:2,requestId:crypto.randomUUID(),projectId:'comments',expectedRevision:commands.revision(),command});
  assert.equal(commands.execute(request({op:'message.edit',messageId:created.messageId,body:'Forbidden'})).error.code,'permission_denied');
  const denied=commands.execute(request({op:'suggestion.accept',suggestionIds:[]}));assert.equal(denied.error.code,'permission_denied');
  const req=request({op:'thread.reply',threadId:created.threadId,body:'Agent reply'});assert.equal(commands.execute(req).ok,true);commands.close();assert.equal(commands.execute(req).error.code,'project_closed');service.close();
  f.run({op:'message.redact',messageId:discussion(f.doc).threads[0].messages[1].id});assert.match(discussion(f.doc).threads[0].messages[1].authorName,/agent/);
  const readonly=collaborationCommands({doc:f.doc,projectId:'comments',capabilities:['read']}),readService=registerComments({doc:f.doc,commands:readonly,author:other});assert.equal(readonly.execute({...f.request({op:'thread.create',fileId:f.id,start:0,end:1,body:'no'})}).error.code,'permission_denied');readService.close();readonly.close();
 }finally{f.close();}
});
test('two independent CRDT peers retain concurrent replies and resolve/reopen alternatives',()=>{
 const f=commentsFixture(),created=f.create(),peer=new Y.Doc();Y.applyUpdate(peer,Y.encodeStateAsUpdate(f.doc));const g=commentsFixture({doc:peer});try{
  f.run({op:'thread.reply',threadId:created.threadId,body:'Reply A'});g.run({op:'thread.reply',threadId:created.threadId,body:'Reply B'});
  f.run({op:'thread.resolve',threadId:created.threadId,eventHeads:[]});g.run({op:'thread.reopen',threadId:created.threadId,eventHeads:[]});
  const a=Y.encodeStateAsUpdate(f.doc),b=Y.encodeStateAsUpdate(peer);Y.applyUpdate(f.doc,b);Y.applyUpdate(peer,a);
  const left=discussion(f.doc),right=discussion(peer);assert.deepEqual(left,right);assert.equal(left.threads[0].messages.length,3);assert.equal(left.threads[0].decisionConflict,true);assert.equal(left.threads[0].status,'open');
  assert.equal(f.execute({op:'thread.resolve',threadId:created.threadId,eventHeads:[]}).error.code,'decision_conflict');
  f.run({op:'thread.resolve',threadId:created.threadId,eventHeads:left.threads[0].eventHeads});assert.equal(discussion(f.doc).threads[0].status,'resolved');
 }finally{g.close();f.close();}
});
test('concurrent edits show both bodies and explicit edit covers all heads',()=>{
 const f=commentsFixture(),created=f.create(),peer=new Y.Doc();Y.applyUpdate(peer,Y.encodeStateAsUpdate(f.doc));const g=commentsFixture({doc:peer,person:f.person});try{
  f.run({op:'message.edit',messageId:created.messageId,body:'A'});g.run({op:'message.edit',messageId:created.messageId,body:'B'});Y.applyUpdate(f.doc,Y.encodeStateAsUpdate(peer));
  const m=discussion(f.doc).threads[0].messages[0];assert.equal(m.conflicted,true);assert.deepEqual(m.variants.map(v=>v.body).sort(),['A','B']);
  f.run({op:'message.edit',messageId:m.id,body:'Combined',eventHeads:m.eventHeads});assert.equal(discussion(f.doc).threads[0].messages[0].conflicted,false);
 }finally{g.close();f.close();}
});
test('renames, moves, duplication, trash restore, identical replacement and revision-checked reattachment',()=>{
 const f=commentsFixture();try{
  const created=f.create(),original=discussion(f.doc).threads[0].anchor;relocateNode(f.doc,f.id,'folder/renamed.tex');assert.equal(discussion(f.doc).threads[0].path,'folder/renamed.tex');
  const duplicate=duplicateNode(f.doc,f.id,'copy.tex');assert.equal(discussion(f.doc).threads.length,1);assert.notEqual(duplicate,f.id);
  deleteNode(f.doc,f.id);assert.equal(anchors.resolve(f.doc,original).reason,'missing_file');restoreDeleted(f.doc);assert.equal(anchors.resolve(f.doc,original).status,'attached');
  const text=f.doc.getText(`text:${f.id}`),old=text.toString().slice(10,18);text.delete(10,8);text.insert(10,old);assert.equal(anchors.resolve(f.doc,original).status,'detached');
  const request=f.request({op:'anchor.reattach',anchorId:created.anchorId,fileId:f.id,start:10,end:18,eventHeads:[]});text.insert(0,'X');assert.equal(f.commands.execute(request).error.code,'revision_conflict');
  f.run({op:'anchor.reattach',anchorId:created.anchorId,fileId:f.id,start:11,end:19,eventHeads:[]});assert.equal(discussion(f.doc).threads[0].anchorStatus,'attached');assert.deepEqual(f.doc.getMap('anchors').get(created.anchorId),original);
 }finally{f.close();}
});
test('actual source undo persists restored item bindings for a fresh peer and redo detaches again',()=>{
 const doc=new Y.Doc(),id=addFile(doc,'main.tex','prefix 😀 selected suffix'),manager=new Y.UndoManager(doc.getText(`text:${id}`),{captureTimeout:0}),origins=changeOrigins({doc,managers:new Map([[id,manager]])}),f=commentsFixture({doc,origins});try{
  f.create();doc.getText(`text:${id}`).delete(10,8);assert.equal(discussion(doc).threads[0].anchorStatus,'detached');manager.undo();assert.equal(discussion(doc).threads[0].anchorStatus,'attached');
  const peer=new Y.Doc();Y.applyUpdate(peer,Y.encodeStateAsUpdate(doc));assert.equal(discussion(peer).threads[0].anchorStatus,'attached');peer.destroy();manager.redo();assert.equal(discussion(doc).threads[0].anchorStatus,'detached');manager.undo();assert.equal(discussion(doc).threads[0].anchorStatus,'attached');validateCollaboration(doc);
 }finally{origins.close();manager.destroy();f.close();}
});
test('bounded revision/filter cursors, body-only explicit reads and limits leave semantic state unchanged',()=>{
 const f=commentsFixture();try{
  const first=f.create();for(let i=0;i<4;i++)f.run({op:'thread.reply',threadId:first.threadId,body:'x'.repeat(16000)});
  const page=f.run({op:'thread.get',id:first.threadId,limit:100});assert.ok(page.nextCursor);assert.ok(new TextEncoder().encode(JSON.stringify(page)).length<=65536);assert.ok(page.items.length<5);
  assert.equal(f.run({op:'thread.list'}).items[0].messages,undefined);
  const next=f.run({op:'thread.get',id:first.threadId,cursor:page.nextCursor,limit:100});assert.ok(next.items.length);
  f.run({op:'thread.reply',threadId:first.threadId,body:'new revision'});assert.equal(f.execute({op:'thread.get',id:first.threadId,cursor:page.nextCursor}).error.code,'revision_conflict');
  const before=Y.encodeStateAsUpdate(f.doc);assert.equal(f.execute({op:'thread.reply',threadId:first.threadId,body:'é'.repeat(9000)}).ok,false);assert.deepEqual(Y.encodeStateAsUpdate(f.doc),before);
  assert.equal(f.execute({op:'thread.list',limit:101}).ok,false);assert.equal(f.execute({op:'thread.create',fileId:f.id,start:9,end:10,body:'x',extra:true}).ok,false);
 }finally{f.close();}
});
test('large concurrent message alternatives page independently and cursors bind filters',()=>{
 const f=commentsFixture(),created=f.create(),peers=[];try{
  for(let i=0;i<5;i++){const doc=new Y.Doc();Y.applyUpdate(doc,Y.encodeStateAsUpdate(f.doc));const g=commentsFixture({doc,person:f.person});g.run({op:'message.edit',messageId:created.messageId,body:String(i).repeat(15000)});peers.push(g);}
  for(const g of peers)Y.applyUpdate(f.doc,Y.encodeStateAsUpdate(g.doc));
  const variants=discussion(f.doc).threads[0].messages[0].variants;assert.equal(variants.length,5);
  let cursor,read=[];do{const page=f.run({op:'thread.get',id:created.threadId,limit:2,...(cursor?{cursor}:{})});assert.ok(new TextEncoder().encode(JSON.stringify(page)).length<=65536);read.push(...page.items.flatMap(item=>item.variants||[]));cursor=page.nextCursor;}while(cursor);
  assert.deepEqual(read.map(v=>v.body).sort(),variants.map(v=>v.body).sort());
  f.create();const page=f.run({op:'thread.list',limit:1,filters:{status:'open'}});assert.ok(page.nextCursor);assert.equal(f.execute({op:'thread.list',cursor:page.nextCursor,filters:{status:'all'}}).error.code,'revision_conflict');
 }finally{peers.forEach(g=>g.close());f.close();}
});
test('partial undo expands restored witnesses, and orphan anchors can be reattached repeatedly',()=>{
 const doc=new Y.Doc(),id=addFile(doc,'main.tex','prefix 😀 selected suffix'),text=doc.getText(`text:${id}`),manager=new Y.UndoManager(text,{captureTimeout:0}),origins=changeOrigins({doc,managers:new Map([[id,manager]])}),f=commentsFixture({doc,origins});try{
  const created=f.create();text.delete(10,3);assert.equal(discussion(doc).threads[0].narrowed,true);manager.undo();assert.equal(discussion(doc).threads[0].narrowed,false);assert.equal(discussion(doc).threads[0].end-discussion(doc).threads[0].start,8);
  const anchor=doc.getMap('anchors').get(created.anchorId);doc.getMap('threads').delete(created.threadId);
  let projected=discussion(doc).anchors[0];f.run({op:'anchor.reattach',anchorId:anchor.id,fileId:id,start:0,end:3,eventHeads:projected.eventHeads});projected=discussion(doc).anchors[0];f.run({op:'anchor.reattach',anchorId:anchor.id,fileId:id,start:3,end:6,eventHeads:projected.eventHeads});projected=discussion(doc).anchors[0];assert.equal(projected.conflicted,false);assert.equal(projected.binding.quote,'fix');
 }finally{origins.close();manager.destroy();f.close();}
});
test('invalid anchor shapes, wrong-root positions and cyclic or cross-target comment events fail closed',()=>{
 const f=commentsFixture();try{
  const created=f.create(),original=f.doc.getMap('anchors').get(created.anchorId);
  f.doc.getMap('anchors').set(original.id,{...original,start:{...original.start,tname:'text:foreign'}});assert.throws(()=>validateCollaboration(f.doc),/exact source root/);f.doc.getMap('anchors').set(original.id,original);
  const id=crypto.randomUUID(),event={version:1,id,authorId:f.person.id,changeId:crypto.randomUUID(),createdAt:1,targetId:created.messageId,parents:[id],kind:'messageRedact',payload:{}};
  f.doc.getMap('discussionEvents').set(id,event);assert.throws(()=>validateCollaboration(f.doc),/Cyclic/);f.doc.getMap('discussionEvents').set(id,{...event,parents:[],targetId:created.threadId});assert.throws(()=>validateCollaboration(f.doc),/wrong record type/);
 }finally{f.close();}
});
test('fragmented selections reject more than 4096 witness runs without sampling',()=>{
 const doc=new Y.Doc(),id=addFile(doc,'main.tex',''),text=doc.getText(`text:${id}`);
 for(let i=1;i<=4097;i++){doc.clientID=i;text.insert(text.length,'a');}
 assert.equal(anchors.capture(doc,id,0,4096).witnesses.length,4096);assert.throws(()=>anchors.capture(doc,id,0,4097),e=>e.code==='invalid_request'&&e.message.includes('fragmented'));doc.destroy();
});
test('bounded fallback context keeps complete scalars around long Unicode selections',()=>{
 const doc=new Y.Doc(),prefix='😀x'.repeat(5001)+'😀',quote='界😀'.repeat(2000),suffix='e\u0301'.repeat(5000),id=addFile(doc,'main.tex',prefix+quote+suffix),anchor=anchors.capture(doc,id,prefix.length,prefix.length+quote.length);
 assert.equal(anchor.quote,Array.from(quote).slice(0,1024).join(''));assert.equal(anchor.prefix,Array.from(prefix).slice(-128).join(''));assert.equal(anchor.suffix,Array.from(suffix).slice(0,128).join(''));doc.destroy();
});
test('messages awaiting their thread remain visibly pending and counted in bounded reads',()=>{
 const f=commentsFixture();try{f.create();const pending={...record(),body:'Arrived before its thread'};f.doc.getMap('messages').set(pending.id,pending);validateCollaboration(f.doc);assert.equal(discussion(f.doc).pendingCount,1);assert.equal(f.run({op:'thread.list'}).pendingMessages,1);assert.equal(f.doc.getMap('messages').get(pending.id).body,'Arrived before its thread');}finally{f.close();}
});
test('a missing decision parent cannot produce a successful resolved receipt',()=>{
 const f=commentsFixture();try{
  const created=f.create(),id=crypto.randomUUID();f.doc.getMap('discussionEvents').set(id,{version:1,id,authorId:f.person.id,changeId:crypto.randomUUID(),createdAt:1,targetId:created.threadId,parents:[crypto.randomUUID()],kind:'threadResolve',payload:{}});validateCollaboration(f.doc);
  assert.equal(discussion(f.doc).threads[0].pending,true);assert.equal(f.execute({op:'thread.resolve',threadId:created.threadId,eventHeads:[id]}).error.code,'decision_conflict');assert.equal(discussion(f.doc).threads[0].status,'open');
 }finally{f.close();}
});

function undoFixture(value){
 const doc=new Y.Doc(),id=addFile(doc,'main.tex',value),text=doc.getText(`text:${id}`),manager=new Y.UndoManager(text,{captureTimeout:0}),origins=changeOrigins({doc,managers:new Map([[id,manager]])}),f=commentsFixture({doc,origins});
 return{...f,text,manager,anchor(){return f.run({op:'thread.create',fileId:id,start:0,end:text.length,body:'Selected identities'});},close(){origins.close();manager.destroy();f.close();}};
}
function bindingSnapshot(doc){const thread=discussion(doc).threads[0],text=doc.getText(`text:${thread.anchor.fileId}`).toString();return{source:text,status:thread.anchorStatus,selected:thread.anchorStatus==='attached'?text.slice(thread.start,thread.end):null,narrowed:thread.narrowed};}
function assertBinding(f,source,selected,narrowed=false){
 const expected={source,status:selected===null?'detached':'attached',selected,narrowed};assert.deepEqual(bindingSnapshot(f.doc),expected);
 const peer=new Y.Doc();try{Y.applyUpdate(peer,Y.encodeStateAsUpdate(f.doc));assert.deepEqual(bindingSnapshot(peer),expected);validateCollaboration(peer);}finally{peer.destroy();}
}
test('undo never promotes interior insertions into selected witnesses, including repeated redo and peer reload',()=>{
 const f=undoFixture('abc');try{
  f.anchor();f.text.insert(1,'X');f.text.delete(3,1);f.manager.undo();assertBinding(f,'aXbc','aXbc');
  f.doc.transact(()=>{f.text.delete(2,2);f.text.delete(0,1);});assertBinding(f,'X',null);
  f.manager.undo();assertBinding(f,'aXbc','aXbc');f.manager.redo();assertBinding(f,'X',null);f.manager.undo();assertBinding(f,'aXbc','aXbc');
 }finally{f.close();}
});
test('sequential partial undo retains deleted witness lineage across redo and peer reload',()=>{
 const f=undoFixture('abcdef');try{
  f.anchor();f.text.delete(0,3);f.text.delete(0,3);assertBinding(f,'',null);
  f.manager.undo();assertBinding(f,'def','def',true);f.manager.undo();assertBinding(f,'abcdef','abcdef');
  f.manager.redo();assertBinding(f,'def','def',true);f.manager.redo();assertBinding(f,'',null);
  f.manager.undo();assertBinding(f,'def','def',true);f.manager.undo();assertBinding(f,'abcdef','abcdef');
 }finally{f.close();}
});
test('redo restores selected insertions without adopting unrelated interior text',()=>{
 const f=undoFixture('');try{
  f.text.insert(0,'abc');f.anchor();f.doc.transact(()=>f.text.insert(1,'X'),'untracked');
  f.manager.undo();assertBinding(f,'X',null);f.manager.redo();assertBinding(f,'aXbc','aXbc');
  f.manager.undo();assertBinding(f,'X',null);f.manager.redo();assertBinding(f,'aXbc','aXbc');
 }finally{f.close();}
});
for(const direction of ['undo','redo'])test(`${direction} preflights all anchor records and preserves source, revision and stacks at the record limit`,()=>{
 const f=undoFixture(direction==='undo'?'abc':'');try{
  if(direction==='redo')f.text.insert(0,'abc');f.anchor();if(direction==='undo')f.text.delete(0,3);else f.manager.undo();
  const count=()=>['authors','threads','anchors','messages','changes','discussionEvents'].reduce((sum,root)=>sum+f.doc.getMap(root).size,0);
  f.doc.transact(()=>{while(count()<9999){const message=record();f.doc.getMap('messages').set(message.id,message);}});
  validateCollaboration(f.doc);const before=Y.encodeStateAsUpdate(f.doc),revision=f.commands.revision(),stack=f.manager[`${direction}Stack`],entries=[...stack];
  assert.equal(f.manager[direction](),null);assert.deepEqual(Y.encodeStateAsUpdate(f.doc),before);assert.equal(f.commands.revision(),revision);assert.equal(f.manager[`${direction}Stack`],stack);assert.deepEqual(stack,entries);assertBinding(f,'',null);
  const spare=[...f.doc.getMap('messages').keys()].at(-1);f.doc.getMap('messages').delete(spare);assert.ok(f.manager[direction]());assertBinding(f,'abc','abc');assert.equal(count(),10000);
 }finally{f.close();}
});
for(const direction of ['undo','redo'])test(`${direction} rejects the complete multi-anchor update at the UTF-8 byte limit`,()=>{
 const f=undoFixture(direction==='undo'?'abc':'');try{
  if(direction==='redo')f.text.insert(0,'abc');f.anchor();f.anchor();if(direction==='undo')f.text.delete(0,3);else f.manager.undo();
  const roots=['authors','threads','anchors','messages','changes','discussionEvents'],size=()=>new TextEncoder().encode(JSON.stringify(Object.fromEntries(roots.filter(root=>f.doc.getMap(root).size).map(root=>[root,f.doc.getMap(root).toJSON()])))).length;
  f.doc.transact(()=>{for(let i=0;i<990;i++){const message={...record(),body:'é'.repeat(8192)};f.doc.getMap('messages').set(message.id,message);}});
  while(size()<LIMITS.semanticBytes-17000){const message={...record(),body:'é'.repeat(8192)};f.doc.getMap('messages').set(message.id,message);}
  const last={...record(),body:'x'};f.doc.getMap('messages').set(last.id,last);const padding=LIMITS.semanticBytes-size()-100;assert.ok(padding>0&&padding<16384);f.doc.getMap('messages').set(last.id,{...last,body:'x'.repeat(padding+1)});
  validateCollaboration(f.doc);const before=Y.encodeStateAsUpdate(f.doc),stack=[...f.manager[`${direction}Stack`]];
  assert.equal(f.manager[direction](),null);assert.deepEqual(Y.encodeStateAsUpdate(f.doc),before);assert.deepEqual(f.manager[`${direction}Stack`],stack);assertBinding(f,'',null);
  f.doc.getMap('messages').delete(last.id);assert.ok(f.manager[direction]());assertBinding(f,'abc','abc');validateCollaboration(f.doc);
 }finally{f.close();}
});

import {commentDrafts,COMMENT_DRAFT_LIMITS} from '../web/comment-drafts.js';
function draftStore(){const entries=new Map();return{getItem:key=>entries.get(key)||null,setItem:(key,value)=>entries.set(key,value)};}
test('device-local drafts preserve Unicode and targets independently per project and thread',()=>{
 const store=draftStore(),a=commentDrafts('a',store),b=commentDrafts('b',store);
 a.save({id:'reply:a',threadId:'a',draft:'Reply 😀'});a.save({id:'reply:b',threadId:'b',draft:'Other reply'});b.save({id:'reply:a',threadId:'a',draft:'Other project'});
 assert.deepEqual(a.read().map(d=>[d.threadId,d.draft]).sort(),[['a','Reply 😀'],['b','Other reply']]);assert.equal(b.read()[0].draft,'Other project');
 a.remove('reply:a');assert.equal(a.read().length,1);assert.equal(b.read().length,1);
});
test('draft bounds reject oversized writes without truncating or evicting stored text',()=>{
 const store=draftStore(),drafts=commentDrafts('p',store);drafts.save({id:'kept',draft:'Original'});
 assert.throws(()=>drafts.save({id:'kept',draft:'é'.repeat(COMMENT_DRAFT_LIMITS.entryBytes)}),/64 KiB/);assert.equal(drafts.read()[0].draft,'Original');
 for(let i=1;i<COMMENT_DRAFT_LIMITS.entries;i++)drafts.save({id:String(i),draft:'x'});
 assert.throws(()=>drafts.save({id:'extra',draft:'x'}),/128 drafts/);assert.equal(drafts.read().length,128);
 const large=commentDrafts('p',draftStore());for(let i=0;i<16;i++)large.save({id:String(i),draft:'x'.repeat(64000)});
 assert.throws(()=>large.save({id:'extra',draft:'x'.repeat(64000)}),/1 MiB/);assert.equal(large.read().length,16);
});
test('draft storage faults preserve the last recovery copy and report failure',()=>{
 const store=draftStore(),drafts=commentDrafts('p',store);drafts.save({id:'a',draft:'Last stored'});store.setItem=()=>{throw new Error('quota');};
 assert.throws(()=>drafts.save({id:'a',draft:'In memory'}),/quota/);assert.throws(()=>drafts.remove('a'),/quota/);assert.equal(drafts.read()[0].draft,'Last stored');
});
