import {applyReviewEdits,suggestionEdits} from '../web/review-commands.js';
import {cloneProject} from '../web/assets.js';
import {reviewingSession} from '../web/review-input.js';
import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import * as storage from '../web/storage.js';
import {addFile} from '../web/model.js';
import {integrationSession,initialSource} from './helpers/integration-session.mjs';
const ok=reply=>{assert.equal(reply.ok,true,JSON.stringify(reply));return reply.value;};
const slot=(source,index)=>{const line=source.split('\n')[2],parts=line.split(' | '),start=source.indexOf(line)+parts.slice(0,index).reduce((sum,part)=>sum+part.length+3,0);return{fileId:'main',start,end:start+parts[index].length,before:parts[index]};};

// Each seed gets its own persisted project and production dispatcher/agent adapter.
// The oracle edits independent text slots, never the implementation's resolved offsets.
const sequences=512,steps=24,baseSeed=0x5672026,coverage={};
const foreign=await integrationSession();let packageBytes,foreignSuggestion;
try{
 const review=ok(await foreign.call({op:'review.create',title:'Foreign review'},false));
 foreignSuggestion=ok(await foreign.call({op:'suggestion.propose',reviewId:review.reviewId,fileId:'main',start:0,end:0,before:'',after:'% Imported\n'},false)).suggestionId;
 packageBytes=foreign.exchange.encode([review.reviewId]);
}finally{await foreign.remove();}
// Thread selection uses creation ordinals retained across reload/restore, never UUID order.
after(()=>console.log('Seeded production command coverage:',JSON.stringify(coverage)));
async function runSequence(sequence){
 let seed=(baseSeed+sequence)>>>0;const random=n=>{seed^=seed<<13;seed^=seed>>>17;seed^=seed<<5;return(seed>>>0)%n;};
 let f=await integrationSession(),expected=initialSource,targets=new Map();const proposals=[],batches=[],versions=[],trace=[],threadOrder=new Map();
 const attribution=(change,actor,doc=f.doc)=>{
  assert.equal(change.actorKind,actor?'agent':'human',change.kind);assert.equal(change.authorId,actor?f.agentAuthor:f.owner.id,change.kind);assert.equal(change.sessionId,actor?f.agentSession:f.context.sessionId,change.kind);
  assert.equal(doc.getMap('authors').get(change.authorId).kind,change.actorKind);
 };
 const invoke=async(command,actor,attachments)=>{
  const before=f.source(),known=new Set(f.doc.getMap('changes').keys()),reply=await f.call(command,actor,attachments);
  const count=coverage[command.op]??={pass:0,refused:0};count[reply.ok?'pass':'refused']++;
  for(const change of f.doc.getMap('changes').values())if(!known.has(change.id))attribution(change,actor);
  if(reply.ok&&reply.value.projectId&&reply.value.projectId!==f.projectId){
   const installed=await storage.loadProject(reply.value.projectId);try{attribution(installed.getMap('changes').get(reply.value.changeId),actor,installed);assert.equal(installed.getText('text:other').toString(),'untouched');}finally{installed.destroy();await storage.deleteProject(reply.value.projectId);}
  }
  if(!reply.ok)assert.equal(f.source(),before,JSON.stringify(reply));return reply;
 };
 try{
  for(let step=0;step<steps;step++){
   const actor=!!random(2),op=step===0?'propose':step===1?'accept':step===2?'comment':step===3?'undo':step===4?'redo':['comment','propose','accept','reject','undo','redo','restore','reload','name','reattach','reply','edit','redact','resolve','reopen','submit','close','withdraw','unpin','import','patch','copy','backup'][random(23)];trace.push(op+':'+Number(actor));
   if(op==='propose'){
    const index=random(3),selection=slot(expected,index),candidate=['A','B','C','😀','delta',''][random(6)],after=candidate===selection.before?candidate+'x':candidate;const review=ok(await invoke({op:'review.create',title:'Seeded review'},actor));
    const s=ok(await invoke({op:'suggestion.propose',reviewId:review.reviewId,...selection,after},actor));proposals.push({...s,index,before:selection.before,after});
   }else if(op==='comment'){
    const index=random(3),a=slot(expected,index),thread=ok(await invoke({op:'thread.create',fileId:'main',start:a.start,end:a.end,body:'Selected '+a.before},actor));targets.set(thread.threadId,{index,text:a.before});threadOrder.set(thread.threadId,threadOrder.size);
   }else if(op==='reattach'){
    const threads=ok(await invoke({op:'thread.list'},actor)).items.sort((a,b)=>threadOrder.get(a.id)-threadOrder.get(b.id));if(threads.length){const t=threads[random(threads.length)],detail=ok(await invoke({op:'thread.get',id:t.id},actor)),index=random(3),a=slot(expected,index);trace.push('thread='+threadOrder.get(t.id)+':slot='+index);ok(await invoke({op:'anchor.reattach',anchorId:detail.thread.anchorId,fileId:'main',start:a.start,end:a.end,eventHeads:detail.items.filter(item=>item.targetId===detail.thread.anchorId&&item.isHead).map(item=>item.id)},actor));targets.set(t.id,{index,text:a.before});}
   }else if(['reply','edit','redact','resolve','reopen'].includes(op)){
    const threads=ok(await invoke({op:'thread.list'},actor)).items.sort((a,b)=>threadOrder.get(a.id)-threadOrder.get(b.id));
    if(threads.length){
     const t=threads[random(threads.length)],detail=ok(await invoke({op:'thread.get',id:t.id},actor));trace.push('thread='+threadOrder.get(t.id));
     if(op==='reply')await invoke({op:'thread.reply',threadId:t.id,body:'Seeded reply'},actor);
     else if(op==='edit'||op==='redact')await invoke({op:'message.'+op,messageId:detail.thread.firstMessageId,...(op==='edit'?{body:'Seeded edit'}:{})},actor);
     else await invoke({op:'thread.'+op,threadId:t.id,eventHeads:detail.items.filter(item=>item.targetId===t.id&&item.isHead).map(item=>item.id)},actor);
    }
   }else if(op==='submit'||op==='close'||op==='withdraw'){
    if(proposals.length){const s=proposals[random(proposals.length)],reviewId=f.doc.getMap('suggestions').get(s.suggestionId).reviewId;await invoke(op==='withdraw'?{op:'suggestion.withdraw',suggestionId:s.suggestionId,eventHeads:f.heads(s.suggestionId)}:{op:'review.'+op,reviewId,eventHeads:f.heads(reviewId)},actor);}
   }else if(op==='unpin'){
    if(versions.length)await invoke({op:'history.unpin',versionId:versions[random(versions.length)].versionId},actor);
   }else if(op==='import'){
    const plan=ok(await invoke({op:'review.importPlan',attachmentRef:'foreign',mapping:{[foreignSuggestion]:{fileId:'main',start:0,end:0}}},actor,new Map([['foreign',packageBytes]])));
    ok(await invoke({op:'review.import',planId:plan.planId},actor));
   }else if(op==='copy'){
    if(versions.length){const version=versions[random(versions.length)],plan=ok(await invoke({op:'history.restorePlan',checkpointRef:version.checkpointRef,mode:'copy'},actor));ok(await invoke({op:'history.restore',planId:plan.planId},actor));}
   }else if(op==='backup'){
    const artifact=ok(await invoke({op:'backup.export'},actor)),parts=[];let offset=0;
    for(;;){const part=ok(await invoke({op:'artifact.read',artifactId:artifact.artifactId,offset},actor));parts.push(f.history.readAttachment(part.attachmentRef));if(part.eof)break;offset=part.nextOffset;}
    const bytes=new Uint8Array(parts.reduce((n,part)=>n+part.length,0));offset=0;for(const part of parts){bytes.set(part,offset);offset+=part.length;}
    const plan=ok(await invoke({op:'backup.importPlan',attachmentRef:'backup'},actor,new Map([['backup',bytes]])));ok(await invoke({op:'backup.import',planId:plan.planId},actor));
   }else if(op==='patch'){
    ok(await invoke({op:'agent.patchSource',edits:[{fileId:'other',find:'untouched',replace:'untouched'}]},true));
   }else if(op==='accept'||op==='reject'){
    if(proposals.length){const s=proposals[random(proposals.length)],reply=await invoke(op==='accept'?{op:'suggestion.accept',suggestionIds:[s.suggestionId],eventHeads:{[s.suggestionId]:f.heads(s.suggestionId)}}:{op:'suggestion.reject',suggestionId:s.suggestionId,eventHeads:f.heads(s.suggestionId)},actor);
     if(reply.ok&&op==='accept'){const a=slot(expected,s.index);assert.equal(a.before,s.before);expected=expected.slice(0,a.start)+s.after+expected.slice(a.end);batches.push({...s,...reply.value});}
    }
   }else if(op==='undo'||op==='redo'){
    if(batches.length){const batch=batches[random(batches.length)],reply=await invoke({op:'change.'+op,changeId:batch.changeId,eventHeads:{[batch.suggestionId]:f.heads(batch.suggestionId)}},actor);
     if(reply.ok){const a=slot(expected,batch.index);assert.equal(a.before,op==='undo'?batch.after:batch.before);expected=expected.slice(0,a.start)+(op==='undo'?batch.before:batch.after)+expected.slice(a.end);}
    }
   }else if(op==='name'||op==='restore'&&!versions.length){const named=ok(await invoke({op:'history.name',label:'Seed '+seed},actor));versions.push({...named,source:expected,targets:structuredClone(targets)});
   }else if(op==='restore'){
    const version=versions[random(versions.length)],plan=ok(await invoke({op:'history.restorePlan',checkpointRef:version.checkpointRef,mode:'current'},actor));ok(await invoke({op:'history.restore',planId:plan.planId},actor));expected=version.source;targets=structuredClone(version.targets);
   }else if(op==='reload')f=await f.reload();
   assert.equal(f.source(),expected);assert.equal(f.doc.getText('text:other').toString(),'untouched');assert.ok(expected.startsWith('\\documentclass'));
   const list=ok(await f.call({op:'thread.list'}));
   for(const thread of list.items){const detail=ok(await f.call({op:'thread.get',id:thread.id})),t=detail.thread;if(t.anchorStatus==='attached'){const target=targets.get(thread.id);assert.ok(target);assert.equal(detail.anchor.quote,target.text);assert.equal(expected.slice(t.start,t.end),target.text);const a=slot(expected,target.index);assert.equal(t.start,target.text?a.start:a.end);assert.equal(t.end,a.end);}else assert.equal(t.anchorStatus,'detached');}
   await f.context.flushSave();const stored=await storage.loadProject(f.projectId);try{assert.equal(stored.getText('text:main').toString(),expected);}finally{stored.destroy();}
  }
  f=await f.reload();assert.equal(f.source(),expected);
  // A separate identity oracle tracks selected scalars, including gaps inserted
  // inside the selection. Restore must never turn those gaps into owned text.
  const original=Array.from(['alpha','bravo','界😀alpha'][random(3)]),fileId='witness-probe';
  addFile(f.doc,'witness.tex',original.join(''),fileId);
  const actor=!!random(2),thread=ok(await invoke({op:'thread.create',fileId,start:0,end:original.join('').length,body:'Original witnesses'},actor));
  let tokens=original.map(value=>({value,original:true}));
  const edit=(index,count,insert=[])=>{const text=f.doc.getText('text:'+fileId),start=tokens.slice(0,index).reduce((n,t)=>n+t.value.length,0),length=tokens.slice(index,index+count).reduce((n,t)=>n+t.value.length,0);text.delete(start,length);if(insert.length)text.insert(start,insert.map(t=>t.value).join(''));tokens.splice(index,count,...insert);};
  for(let i=0,n=1+random(3);i<n;i++)edit(1+random(tokens.length-1),0,[{value:'UNRELATED'+i,original:false}]);
  if(random(2))edit(0,1);
  const named=ok(await invoke({op:'history.name',label:'Interior witnesses'},actor)),saved=structuredClone(tokens);
  edit(tokens.length,0,[{value:'elsewhere',original:false}]);
  const plan=ok(await invoke({op:'history.restorePlan',checkpointRef:named.checkpointRef,mode:'current'},actor));ok(await invoke({op:'history.restore',planId:plan.planId},actor));tokens=saved;
  const check=async()=>{const detail=ok(await f.call({op:'thread.get',id:thread.threadId}));assert.equal(detail.thread.anchorStatus,tokens.some(t=>t.original)?'attached':'detached','original selection survival');assert.equal(f.doc.getText('text:'+fileId).toString(),tokens.map(t=>t.value).join(''));return detail;};
  await check();
  while(tokens.some(t=>t.original)){const remaining=tokens.flatMap((t,i)=>t.original?[i]:[]);edit(remaining[random(remaining.length)],1);await check();}
  f=await f.reload();const detail=await check();assert.equal(detail.anchor.quote,original.join(''));trace.push('interior-restore-delete:'+Number(actor));
  // Reviewing uses the production input model and proposal commands. Native editor
  // undo/composition is covered by browser tests; this oracle checks each burst.
  const typing=reviewingSession(f.context,'other'),acceptedOther=f.doc.getText('text:other').toString(),known=new Set(f.doc.getMap('suggestions').keys());
  const marker=['日本語😀','review','éclair'][random(3)];let position=0;
  for(const scalar of marker){typing.input(position,position,scalar);position+=scalar.length;assert.equal(f.doc.getText('text:other').toString(),acceptedOther);}
  assert.equal(f.doc.getMap('suggestions').size,known.size,'a typing burst does not append per-key records');typing.flush();
  const first=typing.patches[0].id;
  const reply=ok(await invoke({op:'thread.reply',suggestionId:first,body:'Discussion stays with this exact proposal '+marker},!!random(2)));
  const originalThread=structuredClone(f.doc.getMap('threads').get(reply.threadId));
  assert.equal(originalThread.suggestionId,first);assert.equal(f.doc.getText('text:other').toString(),acceptedOther);
 assert.equal(f.doc.getMap('suggestions').size,known.size+1);assert.equal(f.doc.getMap('suggestions').get(first).after,marker);
  const discussionCheckpoint=ok(await invoke({op:'history.name',label:'Original suggestion discussion'},!!random(2)));
  typing.input(position,position,'!');typing.flush();const second=typing.patches[0].id;
  assert.equal(f.doc.getMap('suggestions').get(second).supersedesId,first);assert.equal(f.reviews.status(f.doc.getMap('suggestions').get(first)),'withdrawn');
  const nextReply=ok(await invoke({op:'thread.reply',suggestionId:second,body:'Reply after revision'},!!random(2)));
  assert.equal(f.doc.getMap('threads').get(nextReply.threadId).suggestionId,second);
  assert.deepEqual(f.doc.getMap('threads').get(reply.threadId),originalThread);
  assert.equal(ok(await f.call({op:'thread.get',id:reply.threadId})).thread.displaySuggestionId,second);
  typing.input(0,position+1,'');typing.flush();assert.equal(f.reviews.status(f.doc.getMap('suggestions').get(second)),'withdrawn');assert.equal(typing.display().text,acceptedOther);
  for(const id of [first,second])assert.equal(f.doc.getMap('suggestions').get(id).authorId,f.owner.id);
  assert.equal(f.source(),expected);await f.context.flushSave();f=await f.reload();assert.equal(f.doc.getText('text:other').toString(),acceptedOther);assert.deepEqual(f.doc.getMap('threads').get(reply.threadId),originalThread);assert.equal(f.doc.getMap('messages').get(reply.messageId).threadId,reply.threadId);assert.equal(ok(await f.call({op:'thread.get',id:reply.threadId})).thread.status,'resolved');trace.push('review-typing:'+marker);
  const restoreActor=!!random(2),restoreDiscussion=ok(await invoke({op:'history.restorePlan',checkpointRef:discussionCheckpoint.checkpointRef,mode:'current'},restoreActor));
  ok(await invoke({op:'history.restore',planId:restoreDiscussion.planId},restoreActor));
  const selected=ok(await f.call({op:'thread.get',id:reply.threadId}));
  assert.equal(selected.thread.suggestionId,first);assert.equal(selected.thread.displaySuggestionId,first);assert.equal(selected.items.filter(item=>item.threadId===reply.threadId).length,1);
  assert.deepEqual(f.doc.getMap('threads').get(reply.threadId),originalThread);
  const receiver=await integrationSession();try{
   const reviewId=f.doc.getMap('suggestions').get(first).reviewId,bytes=f.exchange.encode([reviewId]);
   const plan=ok(await receiver.call({op:'review.importPlan',attachmentRef:'discussion',mapping:{[first]:{fileId:'other',start:0,end:0}}},true,new Map([['discussion',bytes]])));
   ok(await receiver.call({op:'review.import',planId:plan.planId}));
   const threads=ok(await receiver.call({op:'thread.list'})).items;assert.equal(threads.length,1);
   const target=receiver.doc.getMap('suggestions').get(threads[0].suggestionId);
   assert.equal(target.after,marker);assert.equal(threads[0].displaySuggestionId,target.id);assert.equal(threads[0].messageCount,1);
   assert.equal(receiver.doc.getMap('messages').size,1);assert.equal(receiver.doc.getMap('suggestions').size,1);
   assert.equal(receiver.doc.getText('text:other').toString(),acceptedOther);
  }finally{await receiver.remove();}
  trace.push('discussion-restore-exchange');
  const counted=coverage['reviewing.typing']??={pass:0,refused:0};counted.pass++;
  if(process.env.SCRIBYRA_RANDOM_TRACE)console.log('Seeded selection trace:',baseSeed+sequence,trace.join(','));return trace;
 }catch(error){error.message+=`\nseed=${baseSeed+sequence} trace=${trace.join(',')}`;throw error;}finally{await f.remove();}
 }
for(let sequence=0;sequence<sequences;sequence++)test(`production sequence seed=${baseSeed+sequence}`,()=>runSequence(sequence));
test('seed 90644525 repeats selections across independently generated UUIDs',async()=>{
 assert.deepEqual(await runSequence(7),await runSequence(7));
});

// The oracle is the editor transaction's text, not a reconstruction from patches.
// Exercise real Reviewing sessions, proposal dispatch and persisted reloads.
for(let seed=0;seed<54;seed++)test(`review boundary transaction seed=${seed}`,async()=>{
 let f=await integrationSession();
 try{
  const source='abcdef',fileId='boundary';addFile(f.doc,'boundary.tex',source,fileId);
  const review=ok(await f.call({op:'review.create',title:'Boundary'}));
  let rng=seed+0xabc123;const random=n=>{rng^=rng<<13;rng^=rng>>>17;rng^=rng<<5;return(rng>>>0)%n;};
  const kind=seed%3,deletion=kind===1,side=Math.floor(seed/3)%3,insert=['YZ','日本語','😀Q'][random(3)];
  ok(await f.call({op:'suggestion.propose',reviewId:review.reviewId,fileId,start:2,end:kind?4:2,before:kind?'cd':'',after:deletion?'':'XX'}));
  // Another author and another boundary in the same projection.
  ok(await f.call({op:'suggestion.propose',reviewId:review.reviewId,fileId,start:5,end:5,before:'',after:'Q'},false));
  const session=reviewingSession(f.context,fileId),initial=session.display().text;
  let at=deletion?2:2+side;
  if(deletion&&side===1){
   assert.throws(()=>session.input(1,3,insert),/other author/);assert.equal(session.display().text,initial);return;
  }
  if(!deletion&&side===1){
   assert.throws(()=>session.input(at,at,insert),/other author/);assert.equal(session.display().text,initial);return;
  }
  const insertionStart=at;let expected=initial;
  for(const value of [insert,...'yz',...Array.from({length:random(5)},()=>String.fromCharCode(65+random(26)))]){
   expected=expected.slice(0,at)+value+expected.slice(at);
   session.input(at,at,value,expected,deletion&&side===0?-1:1);assert.equal(session.display().text,expected,'draft must equal editor transaction');at+=value.length;
  }
  session.flush();assert.equal(session.display().text,expected);assert.equal(session.load().text,expected,'idle reload must preserve ordering');
  f=await f.reload();const restored=reviewingSession(f.context,fileId);assert.equal(restored.display().text,expected,'persisted projection');
  restored.input(insertionStart,at,'');assert.equal(restored.display().text,initial,'undo beside a foreign boundary');restored.flush();assert.equal(restored.load().text,initial);
  assert.equal(f.doc.getText('text:'+fileId).toString(),source);
 }finally{await f.remove();}
});

// An independent string oracle checks every partial decision in random order.
for(let seed=0;seed<36;seed++)test(`ordered acceptance sequence seed=${seed}`,async()=>{
 let f=await integrationSession();
 try{
  addFile(f.doc,'ordered.tex','abcdef','ordered');
  let rng=seed+12345;const random=n=>{rng^=rng<<13;rng^=rng>>>17;rng^=rng<<5;return(rng>>>0)%n;};
  const review=ok(await f.call({op:'review.create',title:'Ordered insertions'},false)),items=[];
  for(let i=0;i<2+random(5);i++){
   const after=['X','YZ','😀','日本語'][random(4)]+i;
   const proposed=ok(await f.call({op:'suggestion.propose',reviewId:review.reviewId,fileId:'ordered',start:2,end:2,before:'',after,insertionOrder:i},!!random(2)));
   items.push({id:proposed.suggestionId,after,accepted:false});
  }
  const expected='ab'+items.map(i=>i.after).join('')+'cdef';
  while(items.some(i=>!i.accepted)){
   const remaining=items.filter(i=>!i.accepted),chosen=seed%3===0?remaining.reverse():[remaining[random(remaining.length)]];
   const ids=chosen.map(i=>i.id),preview=cloneProject(f.doc);try{applyReviewEdits(preview,suggestionEdits(preview,remaining.map(i=>i.id).reverse(),f.context.anchors));assert.equal(preview.getText('text:ordered').toString(),expected);}finally{preview.destroy();}
   ok(await f.call({op:'suggestion.accept',suggestionIds:ids,eventHeads:Object.fromEntries(ids.map(id=>[id,f.heads(id)]))},false));chosen.forEach(i=>i.accepted=true);
   assert.equal(f.doc.getText('text:ordered').toString(),'ab'+items.filter(i=>i.accepted).map(i=>i.after).join('')+'cdef');
   assert.equal(reviewingSession(f.context,'ordered').display().text,expected);
   for(const i of items.filter(i=>!i.accepted))assert.equal(f.reviews.status(f.doc.getMap('suggestions').get(i.id)),'pending');
   f=await f.reload();assert.equal(reviewingSession(f.context,'ordered').display().text,expected);
  }
 }finally{await f.remove();}
});

for(let seed=0;seed<24;seed++)test(`input journal crash and delayed acknowledgement seed=${seed}`,async()=>{
 const {reviewDraftJournal}=await import('../web/review-drafts.js'),store={};
 Object.defineProperties(store,{setItem:{value:(k,v)=>{store[k]=v;}},getItem:{value:k=>store[k]},removeItem:{value:k=>{delete store[k];}}});
 const journal=reviewDraftJournal('draft:',store),f=await integrationSession();
 try{
  const session=reviewingSession({...f.context,persistDraft:draft=>journal.checkpoint(draft)},'other');
  let expected='untouched',old=[];
  for(let step=0;step<12;step++){
   const at=(seed*7+step*3)%(expected.length+1),insert=String.fromCharCode(65+(seed+step)%26);expected=expected.slice(0,at)+insert+expected.slice(at);
   session.input(at,at,insert,expected);journal.acknowledge(old);
   assert.equal(reviewDraftJournal('draft:',store).read()[0].text,expected,'crash recovery contains this input, despite stale acknowledgement');
   old=journal.pending();if(step%3===0){session.flush();await f.context.flushSave();}
  }
  session.flush();await f.context.flushSave();journal.acknowledge(journal.pending());assert.deepEqual(journal.read(),[]);
 }finally{await f.remove();}
});

for(let seed=0;seed<32;seed++)test(`review replace-all transaction seed=${seed}`,async()=>{
 let f=await integrationSession();
 try{
  let rng=seed+0xabc456;const random=n=>{rng^=rng<<13;rng^=rng>>>17;rng^=rng<<5;return(rng>>>0)%n;};
  const match=['alpha','éclair','界😀'][random(3)],replacement=['beta','日本語','😀Q',''][random(4)],count=2+random(5),fileId='replace-all',separator=seed%4?' X ':'',source=Array(count).fill(match).join(separator);
  addFile(f.doc,'replace-all.tex',source,fileId);const review=ok(await f.call({op:'review.create',title:'Other author'})),foreign=[];
  for(let i=0;separator&&i<count-1;i++)foreign.push(ok(await f.call({op:'suggestion.propose',reviewId:review.reviewId,fileId,start:(i+1)*(match.length+3)-2,end:(i+1)*(match.length+3)-1,before:'X',after:'Y'})).suggestionId);
  const session=reviewingSession(f.context,fileId),initial=source.replaceAll('X','Y'),changes=Array.from({length:count},(_,i)=>({from:i*(match.length+separator.length),to:i*(match.length+separator.length)+match.length,insert:replacement})),expected=initial.replaceAll(match,replacement),before=structuredClone(session.patches);
  // A protected edit between valid matches must publish none of the batch.
  const mixed=[...changes,{from:match.length+1,to:match.length+2,insert:'NO'}].sort((a,b)=>a.from-b.from);
  if(separator)assert.throws(()=>session.inputChanges(mixed),/other author/);assert.equal(session.display().text,initial);assert.deepEqual(session.patches,before);assert.equal(session.dirty,false);
  session.inputChanges(changes,expected);assert.equal(session.display().text,expected);session.flush();assert.equal(session.load().text,expected);assert.equal(f.doc.getText('text:'+fileId).toString(),source);
  const own=session.patches.filter(p=>p.authorId===f.owner.id);assert.equal(own.length,count);for(const p of own)assert.equal(p.after,replacement);
  for(const id of foreign)assert.equal(f.reviews.status(f.doc.getMap('suggestions').get(id)),'pending');
  f=await f.reload();assert.equal(reviewingSession(f.context,fileId).display().text,expected);assert.equal(f.doc.getText('text:'+fileId).toString(),source);
 }finally{await f.remove();}
});
