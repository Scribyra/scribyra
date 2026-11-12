import {test} from 'node:test';
import assert from 'node:assert/strict';
import * as Y from 'yjs';
import * as storage from '../web/storage.js';
import {cloneProject} from '../web/assets.js';
import {restoreCurrent} from '../web/history-storage.js';
import {anchors} from '../web/comment-anchors.js';
import {integrationSession,initialSource} from './helpers/integration-session.mjs';
import {importBackup} from '../web/history-backup.js';
import {projectedRecord} from '../web/review-commands.js';
import {changeOrigins,AgentOrigin} from '../web/change-origins.js';
import {applySourceEdits} from '../web/source-edits.js';
const ok=reply=>{assert.equal(reply.ok,true,JSON.stringify(reply));return reply.value;};
const slot=(source,index)=>{const line=source.split('\n')[2],parts=line.split(' | '),start=source.indexOf(line)+parts.slice(0,index).reduce((sum,part)=>sum+part.length+3,0);return{fileId:'main',start,end:start+parts[index].length,before:parts[index]};};
async function propose(f,index=0,after='A',actor=true){const review=ok(await f.call({op:'review.create',title:'Review'},actor));return ok(await f.call({op:'suggestion.propose',reviewId:review.reviewId,...slot(f.source(),index),after},actor));}
const accept=(f,id)=>f.call({op:'suggestion.accept',suggestionIds:[id],eventHeads:{[id]:f.heads(id)}});
const toggle=(f,id,batch,redo=false)=>f.call({op:redo?'change.redo':'change.undo',changeId:batch.changeId,eventHeads:{[id]:f.heads(id)}});
async function restore(f,checkpointRef,actor=true){const plan=ok(await f.call({op:'history.restorePlan',checkpointRef,mode:'current'},actor));return f.call({op:'history.restore',planId:plan.planId},actor);}

for(const mode of ['current','copy','backup'])test(`${mode} preserves original comment ownership across interior insertions and reload`,async()=>{
 let f=await integrationSession();const originalId=f.projectId;
 try{
  const a=slot(f.source(),0),thread=ok(await f.call({op:'thread.create',fileId:'main',start:a.start,end:a.end,body:'Only alpha'}));
  f.doc.getText('text:main').insert(a.start+2,'UNRELATED');
  const named=ok(await f.call({op:'history.name',label:'Interior insertion'}));
  if(mode==='backup'){
   const artifact=ok(await f.call({op:'backup.export'})),part=ok(await f.call({op:'artifact.read',artifactId:artifact.artifactId})),bytes=f.history.readAttachment(part.attachmentRef);
   assert.equal(part.eof,true);const plan=ok(await f.call({op:'backup.importPlan',attachmentRef:'backup'},true,new Map([['backup',bytes]]))),copy=ok(await f.call({op:'backup.import',planId:plan.planId}));
   const doc=await storage.loadProject(copy.projectId);f.close();f=await integrationSession({doc,projectId:copy.projectId});
  }else{
   f.doc.getText('text:main').insert(f.source().length,'elsewhere');
   const plan=ok(await f.call({op:'history.restorePlan',checkpointRef:named.checkpointRef,mode})),result=ok(await f.call({op:'history.restore',planId:plan.planId}));
   if(mode==='copy'){const doc=await storage.loadProject(result.projectId);f.close();f=await integrationSession({doc,projectId:result.projectId});}
  }
  assert.equal(ok(await f.call({op:'thread.get',id:thread.threadId})).anchor.quote,'alpha');
  const text=f.doc.getText('text:main');text.delete(a.start,2);
  assert.equal(ok(await f.call({op:'thread.get',id:thread.threadId})).thread.anchorStatus,'attached');
  text.delete(a.start+9,3);assert.equal(slot(f.source(),0).before,'UNRELATED');
  assert.equal(ok(await f.call({op:'thread.get',id:thread.threadId})).thread.anchorStatus,'detached');
  f=await f.reload();const detail=ok(await f.call({op:'thread.get',id:thread.threadId}));assert.equal(detail.thread.anchorStatus,'detached');assert.equal(detail.anchor.quote,'alpha');
 }finally{await f.remove();if(f.projectId!==originalId)await storage.deleteProject(originalId);}
});

test('restore retires acceptance stacks and agent history retains owner authority and real authorship in backups',async()=>{
 let f=await integrationSession();try{
  const s=await propose(f),batch=ok(await accept(f,s.suggestionId));ok(await toggle(f,s.suggestionId,batch));
  const named=ok(await f.call({op:'history.name',label:'Undone'}));
  ok(f.agent.api.patchSource({expectedRevision:f.commands.revision(),edits:[{path:'main.tex',find:'charlie',replace:'CHARLIE'}]}));
  const restored=ok(await restore(f,named.checkpointRef));assert.equal(f.reviews.groups.size,0);
  assert.equal((await toggle(f,s.suggestionId,batch,true)).error.code,'history_unavailable');assert.equal(f.source(),initialSource);
  const review=projectedRecord(f.doc,'reviews',f.doc.getMap('suggestions').get(s.suggestionId).reviewId);assert.equal(review.acceptanceAuthorityId,f.owner.id);
  const exported=ok(await f.call({op:'backup.export'})),part=ok(await f.call({op:'artifact.read',artifactId:exported.artifactId})),bundle=importBackup(f.history.readAttachment(part.attachmentRef)),copy=new Y.Doc();
  try{Y.applyUpdate(copy,bundle.project.update);const changes=[...copy.getMap('changes').values()].filter(c=>c.kind==='version-name'||c.id===restored.changeId);assert.equal(changes.length,2);assert.equal(new Set(changes.map(c=>c.sessionId)).size,1);for(const c of changes){assert.equal(c.actorKind,'agent');assert.notEqual(c.authorId,f.owner.id);assert.equal(copy.getMap('authors').get(c.authorId).ownerAuthorId,f.owner.id);}}finally{copy.destroy();}
  f=await f.reload();assert.equal(f.source(),initialSource);ok(await accept(f,s.suggestionId));assert.equal(f.source(),initialSource.replace('alpha','A'));
 }finally{await f.remove();}
});
for(const reattach of [false,true])test(`redo restores post-acceptance comment identities, effective reattachment=${reattach}`,async()=>{
 let f=await integrationSession();try{
  const s=await propose(f),batch=ok(await accept(f,s.suggestionId));
  const a=slot(f.source(),reattach?1:0),thread=ok(await f.call({op:'thread.create',fileId:'main',start:a.start,end:a.end,body:'Comment'}));
  if(reattach){const a=slot(f.source(),0);ok(await f.call({op:'anchor.reattach',anchorId:thread.anchorId,fileId:'main',start:a.start,end:a.end,eventHeads:[]}));}
  for(let cycle=0;cycle<3;cycle++){
   ok(await toggle(f,s.suggestionId,batch));assert.equal(ok(await f.call({op:'thread.get',id:thread.threadId})).thread.anchorStatus,'detached');
   ok(await toggle(f,s.suggestionId,batch,true));const a=slot(f.source(),0);assert.deepEqual(Object.fromEntries(Object.entries(ok(await f.call({op:'thread.get',id:thread.threadId})).thread).filter(([key])=>['anchorStatus','start','end'].includes(key))),{anchorStatus:'attached',start:a.start,end:a.end});
  }
  f=await f.reload();assert.equal(ok(await f.call({op:'thread.get',id:thread.threadId})).thread.anchorStatus,'attached');
 }finally{await f.remove();}
});
for(const direction of ['undo','redo'])test(`mismatched ${direction} rehearsal fails without publishing or saving source`,async()=>{
 const f=await integrationSession();try{
  const s=await propose(f),batch=ok(await accept(f,s.suggestionId));if(direction==='redo')ok(await toggle(f,s.suggestionId,batch));
  const group=f.reviews.groups.get(batch.changeId),original=group.manager[direction].bind(group.manager);group.manager[direction]=()=>{original();group.doc.getText('text:other').insert(0,'misplaced');};
  const source=f.source(),changes=f.doc.getMap('changes').size;assert.equal((await toggle(f,s.suggestionId,batch,direction==='redo')).error.code,'suggestion_conflict');assert.equal(f.source(),source);assert.equal(f.doc.getText('text:other').toString(),'untouched');assert.equal(f.doc.getMap('changes').size,changes);assert.equal(f.reviews.groups.size,0);
 }finally{await f.remove();}
});
test('replacement retires review, editor and search stacks, including transported restore boundaries',async()=>{
 const f=await integrationSession(),text=f.doc.getText('text:main'),manager=new Y.UndoManager(text),origins=changeOrigins({doc:f.doc,managers:new Map([['main',manager]])});let search;
 try{
  text.insert(text.length,' later');const s=await propose(f),batch=ok(await accept(f,s.suggestionId));ok(await toggle(f,s.suggestionId,batch));
  search=applySourceEdits(f.doc,[{fileId:'main',start:slot(f.source(),1).start,end:slot(f.source(),1).end,before:'bravo',after:'B'}],{undoable:true}).undo;
  assert.ok(search.undoStack.length);assert.ok(manager.undoStack.length);
  f.doc.transact(()=>{text.delete(0,text.length);text.insert(0,initialSource);},{});
  assert.equal(f.reviews.groups.size,0);assert.equal(manager.undoStack.length,0);assert.equal(search.undoStack.length,0);
  text.insert(text.length,' local');const target=cloneProject(f.doc),restored=restoreCurrent(f.doc,target,{author:f.owner,checkpointId:crypto.randomUUID(),anchors});
  try{Y.applyUpdate(f.doc,Y.encodeStateAsUpdate(restored.doc));assert.equal(manager.undoStack.length,0);}finally{target.destroy();restored.doc.destroy();}
 }finally{origins.close();manager.destroy();search?.destroy();await f.remove();}
});

test('failed redo retains detached comments until source and binding events commit together',async()=>{
 let f=await integrationSession();try{
  const s=await propose(f),batch=ok(await accept(f,s.suggestionId)),a=slot(f.source(),0),thread=ok(await f.call({op:'thread.create',fileId:'main',start:a.start,end:a.end,body:'After acceptance'}));
  ok(await toggle(f,s.suggestionId,batch));const before=f.source();
  f.context.storage={...storage,commitPrepared(){throw new DOMException('Redo disk full','QuotaExceededError');}};
  assert.equal((await toggle(f,s.suggestionId,batch,true)).error.code,'quota_exceeded');assert.equal(f.source(),before);
  assert.equal(ok(await f.call({op:'thread.get',id:thread.threadId})).thread.anchorStatus,'detached');
  const command={op:'change.redo',changeId:batch.changeId,eventHeads:{[s.suggestionId]:f.heads(s.suggestionId)}};assert.equal((await f.call(command,false)).error.code,'quota_exceeded');assert.equal(f.source(),before);
  f.context.storage=storage;ok(await toggle(f,s.suggestionId,batch,true));f=await f.reload();assert.equal(f.source(),initialSource.replace('alpha','A'));assert.equal(ok(await f.call({op:'thread.get',id:thread.threadId})).thread.anchorStatus,'attached');
 }finally{await f.remove();}
});

for(const mode of ['current','copy','import'])test(`agent ${mode} restore records its author and permits the new owner's acceptance`,async()=>{
 let f=await integrationSession();const projects=new Set([f.projectId]);
 try{
  const s=await propose(f),named=ok(await f.call({op:'history.name',label:'Original owner'})),projectId=f.projectId,doc=await storage.loadProject(projectId);f.close();
  const owner={id:crypto.randomUUID(),kind:'human',displayName:'Restoring owner'};f=await integrationSession({doc,projectId,owner});
  ok(await f.call({op:'history.unpin',versionId:named.versionId}));const unpin=[...f.doc.getMap('changes').values()].find(change=>change.kind==='version-unpin');assert.equal(unpin.authorId,f.agentAuthor);assert.equal(unpin.sessionId,f.agentSession);
  let restored;
  if(mode==='import'){
   const exported=ok(await f.call({op:'backup.export'})),part=ok(await f.call({op:'artifact.read',artifactId:exported.artifactId}));assert.equal(part.eof,true);
   const attachmentRef=crypto.randomUUID(),plan=ok(await f.agent.api.execute({version:2,requestId:crypto.randomUUID(),projectId,expectedRevision:f.commands.revision(),command:{op:'backup.importPlan',attachmentRef}},new Map([[attachmentRef,f.history.readAttachment(part.attachmentRef)]])));
   restored=ok(await f.call({op:'backup.import',planId:plan.planId}));
  }else{const plan=ok(await f.call({op:'history.restorePlan',checkpointRef:named.checkpointRef,mode}));restored=ok(await f.call({op:'history.restore',planId:plan.planId}));}
  projects.add(restored.projectId);const authorId=f.agentAuthor,sessionId=f.agentSession;
  if(restored.projectId!==projectId){const doc=await storage.loadProject(restored.projectId);f.close();f=await integrationSession({doc,projectId:restored.projectId,owner});}
  const change=f.doc.getMap('changes').get(restored.changeId);assert.equal(change.authorId,authorId);assert.equal(change.actorKind,'agent');assert.equal(change.sessionId,sessionId);
  const reviewId=f.doc.getMap('suggestions').get(s.suggestionId).reviewId;assert.notEqual(f.doc.getMap('reviews').get(reviewId).acceptanceAuthorityId,owner.id);assert.equal(projectedRecord(f.doc,'reviews',reviewId).acceptanceAuthorityId,owner.id);
  ok(await accept(f,s.suggestionId));assert.equal(f.source(),initialSource.replace('alpha','A'));
 }finally{f.close();for(const id of projects)await storage.deleteProject(id);}
});
test('destroyed search undo managers receive no later document-destroy callback',()=>{
 const original=Y.UndoManager.prototype.destroy,doc=new Y.Doc();let calls=0,undo;
 Y.UndoManager.prototype.destroy=function(){calls++;return original.call(this);};
 try{
  // Use a normal source batch, then close its manager while the project stays open.
  doc.getMap('files').set('main',{id:'main',name:'main.tex',parentId:null});doc.getText('text:main').insert(0,'alpha');
  undo=applySourceEdits(doc,[{fileId:'main',start:0,end:5,before:'alpha',after:'A'}],{undoable:true}).undo;
  undo.destroy();assert.equal(calls,1);doc.destroy();assert.equal(calls,1);
 }finally{Y.UndoManager.prototype.destroy=original;if(!doc.isDestroyed){undo?.destroy();doc.destroy();}}
});

for(const agent of [false,true])test(`review import binds both local changes to its trusted actor/session, agent=${agent}`,async()=>{
 const source=await integrationSession({owner:{id:crypto.randomUUID(),kind:'human',displayName:'Foreign contributor'}}),target=await integrationSession();
 try{
  const s=await propose(source,0,'A',false),reviewId=source.doc.getMap('suggestions').get(s.suggestionId).reviewId;
  const {before,...selection}=slot(source.source(),0),thread=ok(await source.call({op:'thread.create',...selection,body:'Contributor comment'},false));
  // Include a real discussion in the package's selected review.
  source.doc.getMap('threads').set(thread.threadId,{...source.doc.getMap('threads').get(thread.threadId),reviewId});
  const bytes=source.exchange.encode([reviewId]),mapping={[s.suggestionId]:slot(target.source(),0),[thread.anchorId]:slot(target.source(),0)};
  for(const selection of Object.values(mapping))delete selection.before;
  const known=new Set(target.doc.getMap('changes').keys()),plan=ok(await target.call({op:'review.importPlan',attachmentRef:'review',mapping},agent,new Map([['review',bytes]])));
  assert.equal((await target.call({op:'review.import',planId:plan.planId},!agent)).error.code,'permission_denied');
  const caller=agent?target.doc.getMap('authors').get(target.agentAuthor):target.owner,otherSession=await target.commands.execute({version:2,requestId:crypto.randomUUID(),projectId:target.projectId,expectedRevision:target.commands.revision(),command:{op:'review.import',planId:plan.planId}},undefined,{actor:{author:caller,sessionId:crypto.randomUUID()}});assert.equal(otherSession.error.code,'permission_denied');
  assert.equal(target.doc.getMap('changes').size,known.size);
  ok(await target.call({op:'review.import',planId:plan.planId},agent));
  const changes=[...target.doc.getMap('changes').values()].filter(c=>!known.has(c.id));assert.equal(changes.length,2);
  for(const c of changes){assert.equal(c.kind,'review.import');assert.equal(c.authorId,agent?target.agentAuthor:target.owner.id);assert.equal(c.sessionId,agent?target.agentSession:target.context.sessionId);assert.equal(c.actorKind,agent?'agent':'human');}
  for(const root of ['reviews','suggestions','threads','messages'])for(const r of target.doc.getMap(root).values())assert.equal(target.doc.getMap('authors').get(r.authorId).displayName,source.owner.displayName);
  assert.equal(target.doc.getMap('reviews').values().next().value.acceptanceAuthorityId,target.owner.id);
  assert.equal(target.source(),initialSource);const named=ok(await target.call({op:'history.name',label:'Imported review'},agent));ok(await target.call({op:'backup.export'},agent));ok(await restore(target,named.checkpointRef,agent));await target.context.flushSave();
  const loaded=await storage.loadProject(target.projectId);try{for(const c of changes)assert.deepEqual(loaded.getMap('changes').get(c.id),c);}finally{loaded.destroy();}
 }finally{await target.remove();await source.remove();}
});

test('history source observer preserves the trusted transaction session',async()=>{
 const f=await integrationSession(),origins=changeOrigins({doc:f.doc,managers:new Map()});let history;
 try{
  f.history.close();const {mount}=await import('../web/history.js');history=mount({...f.context,origins});
  const known=new Set(f.doc.getMap('changes').keys()),sessionId=crypto.randomUUID();
  f.doc.transact(()=>f.doc.getText('text:other').insert(0,'agent '),new AgentOrigin({authorId:f.agentAuthor,ownerAuthorId:f.owner.id,sessionId}));
  const added=[...f.doc.getMap('changes').values()].filter(c=>!known.has(c.id));assert.equal(added.length,1);
  assert.equal(added[0].kind,'source-edit');assert.equal(added[0].authorId,f.agentAuthor);assert.equal(added[0].sessionId,sessionId);assert.equal(added[0].actorKind,'agent');
 }finally{history?.close();origins.close();await f.remove();}
});

import {discussion,registerComments} from '../web/comments.js';
import {collaborationCommands} from '../web/collaboration-commands.js';
import {validateCollaboration} from '../web/collaboration-schema.js';

test('suggestion discussion keeps immutable targets across revisions, forks, multiple starts and reload',async()=>{
 let f=await integrationSession();try{
  const first=await propose(f),s=f.doc.getMap('suggestions').get(first.suggestionId),before=f.source();
  const reply=ok(await f.call({op:'thread.reply',suggestionId:s.id,body:'First <b>reply</b>'})),original=structuredClone(f.doc.getMap('threads').get(reply.threadId));
  assert.equal(original.suggestionId,s.id);assert.equal(original.anchorId,s.anchorId);assert.equal(original.reviewId,s.reviewId);
  assert.equal(f.doc.getMap('messages').get(reply.messageId).authorId,f.agentAuthor);
  assert.equal(f.doc.getMap('changes').get(reply.changeId).sessionId,f.agentSession);
  const revision=ok(await f.call({op:'suggestion.revise',reviewId:s.reviewId,...slot(before,0),after:'Revised',supersedesId:s.id}));
  const other=ok(await f.call({op:'thread.reply',suggestionId:revision.suggestionId,body:'Another person'},false));
  const concurrent=ok(await f.call({op:'thread.create',suggestionId:s.id,body:'Concurrent first reply'},false));
  assert.deepEqual(f.doc.getMap('threads').get(reply.threadId),original);
  let threads=discussion(f.doc).threads;assert.equal(threads.length,3);assert.ok(threads.every(t=>t.displaySuggestionId===revision.suggestionId));
  assert.equal(f.source(),before);assert.deepEqual(f.doc.getMap('suggestions').get(s.id),s);
  ok(await f.call({op:'message.edit',messageId:reply.messageId,body:'Edited text'}));
  const fork=ok(await f.call({op:'suggestion.propose',reviewId:s.reviewId,...slot(before,1),after:'Fork',supersedesId:s.id}));
  threads=discussion(f.doc).threads;assert.equal(threads.find(t=>t.id===reply.threadId).displaySuggestionId,s.id);assert.equal(threads.find(t=>t.id===concurrent.threadId).displaySuggestionId,s.id);assert.equal(threads.find(t=>t.id===other.threadId).displaySuggestionId,revision.suggestionId);
  assert.ok(!threads.some(t=>t.displaySuggestionId===fork.suggestionId));
  f=await f.reload();assert.deepEqual(f.doc.getMap('threads').get(reply.threadId),original);assert.equal(f.source(),before);assert.equal(discussion(f.doc).threads.find(t=>t.id===reply.threadId).messages[0].variants[0].body,'Edited text');
 }finally{await f.remove();}
});

test('comment-only actors discuss conflicted and decided suggestions without deciding, reattaching or changing source',async()=>{
 const f=await integrationSession();let commands,comments;try{
  const proposal=await propose(f),s=f.doc.getMap('suggestions').get(proposal.suggestionId);
  commands=collaborationCommands({...f.context,capabilities:['read','comment']});comments=registerComments({...f.context,commands,author:{id:crypto.randomUUID(),kind:'human',displayName:'Commenter'}});
  const run=command=>commands.execute({version:2,requestId:crypto.randomUUID(),projectId:f.projectId,expectedRevision:commands.revision(),command});
  f.doc.getText('text:main').insert(slot(f.source(),0).start+1,'CONFLICT');const before=f.source();
  const reply=ok(run({op:'thread.create',suggestionId:s.id,body:'Discuss the conflict'}));
  for(const command of [{op:'thread.resolve',threadId:reply.threadId,eventHeads:[]},{op:'thread.reopen',threadId:reply.threadId,eventHeads:[]},{op:'anchor.reattach',anchorId:s.anchorId,fileId:'other',start:0,end:1,eventHeads:[]},{op:'suggestion.accept',suggestionIds:[s.id],eventHeads:{[s.id]:[]}},{op:'suggestion.reject',suggestionId:s.id,eventHeads:[]}])assert.equal(run(command).error.code,'permission_denied');
  const rejected=ok(await f.call({op:'suggestion.reject',suggestionId:s.id,eventHeads:[]}));assert.equal(rejected.status,'rejected');
  ok(run({op:'thread.reply',suggestionId:s.id,body:'After the decision'}));assert.equal(discussion(f.doc).threads[0].status,'resolved');assert.equal(f.source(),before);
  const count=f.doc.getMap('messages').size;
  for(const command of [{op:'thread.create',suggestionId:s.id,fileId:'main',start:0,end:0,body:'Ambiguous'},{op:'thread.reply',suggestionId:s.id,threadId:reply.threadId,body:'Ambiguous'},{op:'thread.reply',suggestionId:crypto.randomUUID(),body:'Missing'}])assert.equal(run(command).ok,false);
  assert.equal(f.doc.getMap('messages').size,count);validateCollaboration(f.doc);
  f.doc.getMap('meta').set('schemaVersion',7);assert.equal(run({op:'thread.reply',suggestionId:s.id,body:'Old reader boundary'}).error.code,'unsupported_project_version');assert.equal(f.doc.getMap('messages').size,count);f.doc.getMap('meta').set('schemaVersion',8);
 }finally{comments?.close();commands?.close();await f.remove();}
});

test('accepting a batch, undoing and redoing retains every suggestion reply',async()=>{
 let f=await integrationSession();try{
  const proposals=[await propose(f,0),await propose(f,1,'B')],replies=[];
  for(const s of proposals)replies.push(ok(await f.call({op:'thread.reply',suggestionId:s.suggestionId,body:'Discuss '+s.suggestionId})));
  const ids=proposals.map(s=>s.suggestionId),heads=()=>Object.fromEntries(ids.map(id=>[id,f.heads(id)]));
  const batch=ok(await f.call({op:'suggestion.accept',suggestionIds:ids,eventHeads:heads()}));
  assert.ok(discussion(f.doc).threads.every(t=>t.status==='resolved'));assert.equal(f.source(),initialSource.replace('alpha','A').replace('bravo','B'));
  ok(await f.call({op:'thread.reply',threadId:replies[0].threadId,body:'After acceptance'},false));
  ok(await f.call({op:'change.undo',changeId:batch.changeId,eventHeads:heads()}));assert.equal(f.source(),initialSource);assert.ok(discussion(f.doc).threads.every(t=>t.status==='open'));
  ok(await f.call({op:'change.redo',changeId:batch.changeId,eventHeads:heads()}));
  f=await f.reload();assert.deepEqual(discussion(f.doc).threads.map(t=>t.messages.length).sort(),[1,2]);assert.ok(discussion(f.doc).threads.every(t=>t.status==='resolved'));
  for(let i=0;i<ids.length;i++)assert.equal(f.doc.getMap('threads').get(replies[i].threadId).suggestionId,ids[i]);
 }finally{await f.remove();}
});

for(const mode of ['current','copy','backup'])test(`suggestion discussion survives ${mode}, with edits, redactions, decisions and original targets`,async()=>{
 let f=await integrationSession();const originalId=f.projectId;try{
  const proposal=await propose(f),suggestionId=proposal.suggestionId;
  const first=ok(await f.call({op:'thread.reply',suggestionId,body:'Original'})),second=ok(await f.call({op:'thread.reply',threadId:first.threadId,body:'Remove this'},false));
  ok(await f.call({op:'message.edit',messageId:first.messageId,body:'Edited discussion'}));ok(await f.call({op:'message.redact',messageId:second.messageId}));ok(await accept(f,suggestionId));
  const named=ok(await f.call({op:'history.name',label:'Accepted with discussion'})),source=f.source(),thread=structuredClone(f.doc.getMap('threads').get(first.threadId));
  if(mode==='backup'){
   const artifact=ok(await f.call({op:'backup.export'})),chunks=[];let offset=0;
   for(;;){const part=ok(await f.call({op:'artifact.read',artifactId:artifact.artifactId,offset}));chunks.push(f.history.readAttachment(part.attachmentRef));if(part.eof)break;offset=part.nextOffset;}
   const bytes=new Uint8Array(chunks.reduce((n,b)=>n+b.length,0));offset=0;for(const b of chunks){bytes.set(b,offset);offset+=b.length;}
   const plan=ok(await f.call({op:'backup.importPlan',attachmentRef:'backup'},true,new Map([['backup',bytes]]))),copy=ok(await f.call({op:'backup.import',planId:plan.planId}));
   const doc=await storage.loadProject(copy.projectId);f.close();f=await integrationSession({doc,projectId:copy.projectId});
  }else{
   ok(await f.call({op:'thread.reply',threadId:first.threadId,body:'Later history'}));f.doc.getText('text:main').insert(0,'later ');
   const plan=ok(await f.call({op:'history.restorePlan',checkpointRef:named.checkpointRef,mode})),restored=ok(await f.call({op:'history.restore',planId:plan.planId}));
   if(mode==='copy'){const doc=await storage.loadProject(restored.projectId);f.close();f=await integrationSession({doc,projectId:restored.projectId});}
  }
  f=await f.reload();assert.equal(f.source(),source);assert.deepEqual(f.doc.getMap('threads').get(first.threadId),thread);
  const projected=discussion(f.doc).threads.find(t=>t.id===first.threadId);assert.equal(projected.status,'resolved');assert.equal(projected.suggestionId,suggestionId);assert.equal(projected.messages.length,2);
  assert.equal(projected.messages.find(m=>m.id===first.messageId).variants[0].body,'Edited discussion');assert.equal(projected.messages.find(m=>m.id===second.messageId).variants[0].redacted,true);
  ok(await f.call({op:'thread.reply',suggestionId,body:'After recovery'}));assert.equal(f.source(),source);
 }finally{await f.remove();if(f.projectId!==originalId)await storage.deleteProject(originalId);}
});

for(const foreign of [false,true])test(`review exchange retains suggestion discussion, foreign=${foreign}`,async()=>{
 const sender=await integrationSession();let receiver;try{
  const proposal=await propose(sender),suggestion=sender.doc.getMap('suggestions').get(proposal.suggestionId);
  const first=ok(await sender.call({op:'thread.create',suggestionId:suggestion.id,body:'Original'})),second=ok(await sender.call({op:'thread.reply',threadId:first.threadId,body:'Deleted'}));
  ok(await sender.call({op:'message.edit',messageId:first.messageId,body:'Edited portable text'}));ok(await sender.call({op:'message.redact',messageId:second.messageId}));
  receiver=await integrationSession();if(!foreign)receiver.doc.getMap('meta').set('lineageId',sender.doc.getMap('meta').get('lineageId'));
  const bytes=sender.exchange.encode([suggestion.reviewId]),command={op:'review.importPlan',attachmentRef:'review',...(foreign?{mapping:{[suggestion.id]:{fileId:'main',start:slot(initialSource,0).start,end:slot(initialSource,0).end}}}:{})};
  const plan=ok(await receiver.call(command,true,new Map([['review',bytes]])));ok(await receiver.call({op:'review.import',planId:plan.planId}));
  const thread=discussion(receiver.doc).threads[0],target=receiver.doc.getMap('suggestions').get(thread.suggestionId);
  assert.ok(target);assert.equal(thread.anchorId,target.anchorId);assert.equal(thread.reviewId,target.reviewId);assert.equal(thread.messages.length,2);assert.ok(thread.messages.some(m=>m.variants.some(v=>v.body==='Edited portable text')));assert.ok(thread.messages.some(m=>m.variants.some(v=>v.redacted)));
  assert.equal(receiver.source(),initialSource);if(foreign)assert.notEqual(thread.suggestionId,suggestion.id);else assert.equal(thread.suggestionId,suggestion.id);
  receiver=await receiver.reload();assert.equal(discussion(receiver.doc).threads[0].messages.length,2);
 }finally{await sender.remove();await receiver?.remove();}
});

test('a schema 7 project retains its existing comments and suggestions before adding discussion',async()=>{
 const f=await integrationSession(),legacyId=crypto.randomUUID();let old,upgraded,reopened;try{
  const proposal=await propose(f),a=slot(initialSource,1);ok(await f.call({op:'thread.create',fileId:a.fileId,start:a.start,end:a.end,body:'Existing schema 7 comment'}));
  old=cloneProject(f.doc);old.getMap('meta').set('schemaVersion',7);const original=Y.encodeStateAsUpdate(old);await storage.saveProject(legacyId,old);
  upgraded=await storage.loadProject(legacyId);assert.equal(upgraded.getMap('meta').get('schemaVersion'),8);assert.deepEqual((await storage.migrationBackupV2(legacyId,7)).update,original);
  for(const root of ['threads','messages','suggestions','reviews','anchors','authors','discussionEvents','changes'])assert.deepEqual(upgraded.getMap(root).toJSON(),old.getMap(root).toJSON());
  reopened=await integrationSession({doc:upgraded,projectId:legacyId,owner:f.owner});
  ok(await reopened.call({op:'thread.reply',suggestionId:proposal.suggestionId,body:'Discussion after upgrade'}));assert.equal(reopened.source(),initialSource);assert.equal(discussion(upgraded).threads.length,2);
  await reopened.context.flushSave();old.getText('text:main').insert(0,'unsaved old tab ');await assert.rejects(storage.saveProject(legacyId,old),/upgraded/);
 }finally{old?.destroy();if(reopened)await reopened.remove();else{upgraded?.destroy();await storage.deleteProject(legacyId);}await f.remove();}
});

test('restore projections cannot forge a thread target, anchor or review, including legacy nested records',async()=>{
 const f=await integrationSession();try{
  const proposal=await propose(f),s=f.doc.getMap('suggestions').get(proposal.suggestionId),reply=ok(await f.call({op:'thread.reply',suggestionId:s.id,body:'Stay here'}));
  const other=ok(await f.call({op:'suggestion.propose',reviewId:s.reviewId,fileId:'other',start:0,end:0,before:'',after:'Elsewhere'}));
  const thread=f.doc.getMap('threads').get(reply.threadId),named=ok(await f.call({op:'history.name',label:'Thread target'}));
  ok(await restore(f,named.checkpointRef));
  const event=[...f.doc.getMap('discussionEvents').values()].find(e=>e.kind==='restoreProjection'&&e.targetId===thread.id);
  for(const [field,value] of [['suggestionId',other.suggestionId],['anchorId',crypto.randomUUID()],['reviewId',crypto.randomUUID()],['suggestionId',null]])for(const nested of [false,true]){
   const peer=cloneProject(f.doc);try{
    const forged=structuredClone(event);forged.payload.projection[field]=value;
    if(nested){const wrapper=structuredClone(event);delete wrapper.payload.eventIds;wrapper.payload.events=[{...forged,id:crypto.randomUUID(),parents:[]}];peer.getMap('discussionEvents').set(event.id,wrapper);}else peer.getMap('discussionEvents').set(event.id,forged);
    assert.throws(()=>validateCollaboration(peer),/immutable discussion target/);
   }finally{peer.destroy();}
  }
  for(const root of ['messages','suggestions']){
   const peer=cloneProject(f.doc);try{peer.getMap('discussionEvents').set(event.id,{...event,payload:{...event.payload,root}});assert.throws(()=>validateCollaboration(peer),/wrong record type/);}finally{peer.destroy();}
  }
  const malformed=cloneProject(f.doc);try{malformed.getMap('discussionEvents').set(event.id,{...event,payload:{...event.payload,projection:{...thread,unexpected:true}}});assert.throws(()=>validateCollaboration(malformed),/unknown field/);}finally{malformed.destroy();}
  assert.equal(discussion(f.doc).threads[0].suggestionId,s.id);
 }finally{await f.remove();}
});

test('cyclic supersession is rejected at package ingestion and projection retains original discussions',async()=>{
 const f=await integrationSession(),receiver=await integrationSession();try{
  const proposal=await propose(f),s=f.doc.getMap('suggestions').get(proposal.suggestionId);
  ok(await f.call({op:'thread.reply',suggestionId:s.id,body:'First discussion'}));
  const next=ok(await f.call({op:'suggestion.revise',reviewId:s.reviewId,...slot(f.source(),0),after:'B',supersedesId:s.id}));
  ok(await f.call({op:'thread.reply',suggestionId:next.suggestionId,body:'Second discussion'}));
  const pkg=JSON.parse(new TextDecoder().decode(f.exchange.encode([s.reviewId])));pkg.state.suggestions[s.id].supersedesId=next.suggestionId;
  const response=await receiver.call({op:'review.importPlan',attachmentRef:'cycle',mapping:{}},true,new Map([['cycle',new TextEncoder().encode(JSON.stringify(pkg))]]));
  assert.equal(response.ok,false);assert.match(response.error.message,/Cyclic suggestion supersession/);
  f.doc.getMap('suggestions').set(s.id,{...s,supersedesId:next.suggestionId});
  const projected=discussion(f.doc);assert.equal(projected.threads.length,2);assert.ok(projected.threads.every(t=>t.displaySuggestionId===t.suggestionId&&t.pending));assert.equal(projected.incompleteSuggestions.length,2);
 }finally{f.close();await storage.deleteProject(f.projectId);await receiver.remove();}
});

for(const foreign of [false,true])test(`exchange selects restored discussion and keeps excluded decisions as evidence, foreign=${foreign}`,async()=>{
 const f=await integrationSession();let receiver;try{
  const proposal=await propose(f),s=f.doc.getMap('suggestions').get(proposal.suggestionId),first=ok(await f.call({op:'thread.reply',suggestionId:s.id,body:'Checkpoint reply'}));
  ok(await f.call({op:'message.edit',messageId:first.messageId,body:'Selected edit'}));
  const named=ok(await f.call({op:'history.name',label:'S1 discussion'}));
  const second=ok(await f.call({op:'suggestion.revise',reviewId:s.reviewId,...slot(f.source(),0),after:'B',supersedesId:s.id}));
  ok(await f.call({op:'thread.reply',suggestionId:second.suggestionId,body:'Excluded S2 reply'}));
  ok(await f.call({op:'thread.reply',threadId:first.threadId,body:'Excluded late S1 reply'}));
  ok(await f.call({op:'message.edit',messageId:first.messageId,body:'Excluded edit'}));ok(await accept(f,second.suggestionId));
  ok(await restore(f,named.checkpointRef));
  ok(await f.call({op:'message.edit',messageId:first.messageId,body:'After restore edit'}));
  const bytes=f.exchange.encode([s.reviewId]),pkg=JSON.parse(new TextDecoder().decode(bytes));
  assert.deepEqual(Object.keys(pkg.state.suggestions),[s.id]);assert.equal(Object.keys(pkg.state.messages).length,1);
  receiver=await integrationSession();if(!foreign)receiver.doc.getMap('meta').set('lineageId',f.doc.getMap('meta').get('lineageId'));
  const mapping={[s.id]:{fileId:'main',start:slot(initialSource,0).start,end:slot(initialSource,0).end}};
  const plan=ok(await receiver.call({op:'review.importPlan',attachmentRef:'selected',...(foreign?{mapping}:{})},true,new Map([['selected',bytes]])));ok(await receiver.call({op:'review.import',planId:plan.planId}));
  const threads=discussion(receiver.doc).threads;assert.equal(threads.length,1);assert.equal(threads[0].messages.length,1);assert.equal(threads[0].messages[0].variants[0].body,'After restore edit');assert.equal(threads[0].messages[0].conflicted,false);assert.equal(threads[0].displaySuggestionId,threads[0].suggestionId);
  assert.equal(receiver.doc.getMap('suggestions').get(threads[0].suggestionId).after,s.after);assert.equal(receiver.source(),initialSource);
  assert.ok([...receiver.doc.getMap('discussionEvents').values()].some(e=>e.kind==='suggestionAccept'&&e.payload.evidence));
 }finally{await f.remove();await receiver?.remove();}
});
