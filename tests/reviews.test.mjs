import './helpers/core.mjs';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import * as Y from 'yjs';
import {addFile} from '../web/model.js';
import {collaborationCommands} from '../web/collaboration-commands.js';
const request=(host,op,overrides={})=>({version:2,requestId:crypto.randomUUID(),projectId:'p',expectedRevision:host.revision(),command:{op},...overrides});
test('v2 stubs advertise nothing, enforce independent rights, scope, revisions and closed hosts',()=>{
 const doc=new Y.Doc();addFile(doc,'main.tex','source');let active=true;
 const host=collaborationCommands({doc,projectId:'p',capabilities:['read','comment'],isActive:()=>active});assert.deepEqual(host.describe(),[]);
 for(const [op,code] of [['thread.create','unsupported_command'],['suggestion.accept','permission_denied'],['history.name','permission_denied'],['backup.export','permission_denied']])assert.equal(host.execute(request(host,op)).error.code,code);
 assert.equal(host.execute(request(host,'thread.create',{expectedRevision:undefined})).error.code,'revision_required');assert.equal(host.execute(request(host,'thread.list',{projectId:'other'})).error.code,'permission_denied');
 active=false;assert.equal(host.execute(request(host,'thread.list')).error.code,'project_closed');host.close();doc.destroy();
});
test('trusted handlers share replay, stale guards and close revocation without publishing an API',()=>{
 const doc=new Y.Doc();addFile(doc,'main.tex','source');const host=collaborationCommands({doc,projectId:'p'});let commits=0;
 host.register('thread.create',{capabilities:['comment'],prepare(command){return command;},commit(){commits++;doc.getMap('meta').set('testRevision',commits);return{valueVersion:1,changeId:'fixture'};}});
 const original=request(host,'thread.create'),first=host.execute(original);assert.equal(first.ok,true);doc.getMap('meta').set('later',true);assert.deepEqual(host.execute(original),first);assert.equal(commits,1);
 assert.equal(host.execute({...original,command:{op:'thread.reply'}}).error.code,'request_id_reused');
 for(let i=0;i<129;i++)assert.equal(host.execute(request(host,'thread.create')).ok,true);
 assert.equal(host.execute(original).error.code,'revision_conflict');const last=request(host,'thread.create');host.close();assert.equal(host.execute(last).error.code,'project_closed');doc.destroy();
});
test('prepared feature publication rechecks revision and revocation',async()=>{
 const doc=new Y.Doc();addFile(doc,'main.tex','source');let active=true;const host=collaborationCommands({doc,projectId:'p',isActive:()=>active});let commits=0;
 host.register('suggestion.accept',{capabilities:['edit','review'],prepare(){active=false;},commit(){commits++;return{valueVersion:1};}});
 assert.equal((await host.execute(request(host,'suggestion.accept'))).error.code,'project_closed');assert.equal(commits,0);host.close();doc.destroy();
});
test('asynchronous preparation cannot enter the synchronous publication boundary',async()=>{
 const doc=new Y.Doc();addFile(doc,'main.tex','source');const host=collaborationCommands({doc,projectId:'p'});let commits=0;
 host.register('suggestion.accept',{capabilities:['edit','review'],prepare:()=>Promise.resolve({}),commit(){commits++;return{valueVersion:1};}});
 assert.equal((await host.execute(request(host,'suggestion.accept'))).error.code,'invalid_request');assert.equal(commits,0);host.close();doc.destroy();
});

import 'fake-indexeddb/auto';
import * as storage from '../web/storage.js';
import {migrateProject,exportZip,snapshot,relocateNode} from '../web/model.js';
import {cloneProject} from '../web/assets.js';
import {reviewService,projection,resolveSuggestion} from '../web/review-commands.js';
import {reviewPreview} from '../web/review-preview.js';
import {reviewExchange} from '../web/review-exchange.js';
import {buildCoordinator} from '../web/build-session.js';

// BEGIN REVIEW CONTRACT FIXTURE
// Test-only anchor adapter. M5 owns production struct inspection and rebinding.
export const contractAnchors={
 capture(doc,fileId,start,end){
  const file=doc.getMap('files').get(fileId),text=doc.getText(`text:${fileId}`),source=text.toString();
  if(!file||file.binary||file.folder||!Number.isInteger(start)||!Number.isInteger(end)||start<0||end<start||end>text.length)throw new Error('Invalid selection.');
  for(const at of [start,end])if(at>0&&at<source.length&&/[\uD800-\uDBFF]/.test(source[at-1])&&/[\uDC00-\uDFFF]/.test(source[at]))throw new Error('Surrogate boundary.');
  const witnesses=[];let pos=0;
  for(let item=text._start;item;item=item.right)if(!item.deleted&&item.countable){const lo=Math.max(start,pos),hi=Math.min(end,pos+item.length);if(hi>lo)witnesses.push({client:item.id.client,clock:item.id.clock+lo-pos,length:hi-lo});pos+=item.length;}
  const relative=(offset,assoc)=>Y.relativePositionToJSON(Y.createRelativePositionFromTypeIndex(text,offset,assoc));
  return{fileId,kind:start===end?'point':'range',start:relative(start,0),end:relative(end,start===end?0:-1),witnesses,quote:[...source.slice(start,end)].slice(0,1024).join(''),prefix:[...source.slice(0,start)].slice(-128).join(''),suffix:[...source.slice(end)].slice(0,128).join(''),pathAtCreation:file.name};
 },
 resolve(doc,anchor){
  const text=doc.getText(`text:${anchor.fileId}`),start=Y.createAbsolutePositionFromRelativePosition(Y.createRelativePositionFromJSON(anchor.start),doc),end=Y.createAbsolutePositionFromRelativePosition(Y.createRelativePositionFromJSON(anchor.end),doc);
  const live=id=>{for(let i=text._start;i;i=i.right)if(!i.deleted&&i.id.client===id.client&&id.clock>=i.id.clock&&id.clock<i.id.clock+i.length)return true;return false;};
  if(!doc.getMap('files').has(anchor.fileId)||!start||!end||start.type!==text||end.type!==text||start.index>end.index)return{status:'detached',reason:'missing binding'};
  if(anchor.kind==='range'&&(start.index===end.index||!anchor.witnesses.some(w=>{for(let i=0;i<w.length;i++)if(live({client:w.client,clock:w.clock+i}))return true;return false;})))return{status:'detached',reason:'original items deleted'};
  if(anchor.kind==='point'&&anchor.start.item&&!live(anchor.start.item))return{status:'detached',reason:'point neighbor deleted'};
  return{status:'attached',start:start.index,end:end.index};
 },
 rebind(doc,anchor,fileId,start,end){return{...anchor,...this.capture(doc,fileId,start,end)};},
};
let reviewAnchors=contractAnchors;
const testLocks={tail:Promise.resolve(),request(_name,_options,fn){const p=this.tail.then(fn);this.tail=p.catch(()=>{});return p;}};
export async function reviewFixture({doc,projectId=crypto.randomUUID(),author={id:crypto.randomUUID(),kind:'human',displayName:'Reviewer'},authorityId,capabilities,compile}={}){
 if(!doc){doc=new Y.Doc();addFile(doc,'main.tex','alpha bravo charlie','main');addFile(doc,'other.tex','second file','other');migrateProject(doc,projectId);await storage.saveProject(projectId,doc);}
 const context={doc,projectId,author,authorityId,anchors:reviewAnchors,storage,capabilities,locks:typeof window==='undefined'?testLocks:globalThis.navigator.locks,flushSave:async()=>{const saved=await storage.saveProject(projectId,doc);Y.applyUpdate(doc,saved.update);},compile};
 const host=collaborationCommands(context);context.commands=host;const service=reviewService(context),exchange=reviewExchange(context,service),preview=compile?reviewPreview(context,service):undefined;
 const call=(command,attachments)=>host.execute({version:2,requestId:crypto.randomUUID(),projectId,expectedRevision:host.revision(),command},attachments);
 const heads=id=>projection(doc,id).heads;
 const propose=async(start,end,after,fileId='main',reviewId)=>{if(!reviewId){const r=await call({op:'review.create',title:'Review'});if(!r.ok)throw new Error(JSON.stringify(r));reviewId=r.value.reviewId;}return call({op:'suggestion.propose',reviewId,fileId,start,end,before:doc.getText(`text:${fileId}`).toString().slice(start,end),after});};
 const accept=ids=>call({op:'suggestion.accept',suggestionIds:ids,eventHeads:Object.fromEntries(ids.map(id=>[id,heads(id)]))});
 return{doc,projectId,author,context,host,service,exchange,preview,call,heads,propose,accept,source:()=>doc.getText('text:main').toString(),async close(){preview?.close();exchange.close();service.close();host.close();doc.destroy();}};
}
const check=(condition,message='Review contract assertion failed')=>{if(!condition)throw new Error(message);};
const success=r=>{check(r.ok,JSON.stringify(r));return r.value;};
// Compare archive bytes at the same DOS-header clock, including across a second boundary.
function sourceZipAt(doc,now){const RealDate=globalThis.Date;try{globalThis.Date=class extends RealDate{constructor(...args){super(...(args.length?args:[now]));}static now(){return now;}};return exportZip(doc);}finally{globalThis.Date=RealDate;}}
export const reviewCases={
 async 'insert delete replace stay outside source ZIP and compiler snapshot'(){
  const f=await reviewFixture();try{const now=Date.now(),zip=sourceZipAt(f.doc,now),before=JSON.stringify(snapshot(f.doc));
   const a=success(await f.propose(0,5,'ALPHA')),b=success(await f.propose(6,11,'')),c=success(await f.propose(19,19,'!'));
   check(JSON.stringify(snapshot(f.doc))===before);check(equalBytes(sourceZipAt(f.doc,now),zip));
   const accepted=success(await f.accept([a.suggestionId,b.suggestionId,c.suggestionId]));check(f.source()==='ALPHA  charlie!');check(accepted.localSequence>0);
   const events=[...f.doc.getMap('discussionEvents').values()].filter(e=>e.kind==='suggestionAccept');check(events.length===3&&events.every(e=>e.authorId===f.author.id&&e.payload.proposedBy===f.author.id));
  }finally{await f.close();}
 },
 async 'external edits rebase by item identity and rename preserves targets'(){const f=await reviewFixture();try{const s=success(await f.propose(6,11,'B'));f.doc.getText('text:main').insert(0,'prefix ');relocateNode(f.doc,'main','renamed.tex');success(await f.accept([s.suggestionId]));check(f.source()==='prefix alpha B charlie');}finally{await f.close();}},
 async 'interior edits conflict without partial batch mutation'(){const f=await reviewFixture();try{const a=success(await f.propose(0,5,'A')),b=success(await f.propose(6,11,'B'));f.doc.getText('text:main').insert(8,'X');const before=f.source(),r=await f.accept([a.suggestionId,b.suggestionId]);check(r.error.code==='suggestion_conflict');check(f.source()===before);}finally{await f.close();}},
 async 'identical replacement and point neighbor replacement conflict'(){for(const point of [false,true]){const f=await reviewFixture();try{const s=success(await f.propose(6,point?6:11,'B')),t=f.doc.getText('text:main');f.doc.transact(()=>{t.delete(6,5);t.insert(6,'bravo');});check((await f.accept([s.suggestionId])).error.code==='suggestion_conflict');check(f.source()==='alpha bravo charlie');}finally{await f.close();}}},
 async 'overlapping proposals and shared insertion boundaries reject atomically'(){const f=await reviewFixture();try{const a=success(await f.propose(0,5,'A')),b=success(await f.propose(2,8,'B'));check((await f.accept([a.suggestionId,b.suggestionId])).error.code==='suggestion_conflict');check(f.source()==='alpha bravo charlie');}finally{await f.close();}},
 async 'Unicode surrogate boundaries fail before any records are published'(){const f=await reviewFixture();try{f.doc.getText('text:main').insert(0,'😀');const r=await f.propose(1,2,'x');check(!r.ok);check(f.doc.getMap('suggestions').size===0);}finally{await f.close();}},
 async 'reject and withdraw leave source unchanged'(){const f=await reviewFixture();try{for(const op of ['suggestion.reject','suggestion.withdraw']){const s=success(await f.propose(0,5,'A'));success(await f.call({op,suggestionId:s.suggestionId,eventHeads:[]}));check((await f.accept([s.suggestionId])).error.code==='decision_conflict');}check(f.source()==='alpha bravo charlie');}finally{await f.close();}},
 async 'multi-file batch undo and redo preserve preceding and later human edits'(){const f=await reviewFixture();try{f.doc.getText('text:main').insert(0,'human ');const a=success(await f.propose(6,11,'A')),b=success(await f.propose(0,6,'SECOND','other')),ids=[a.suggestionId,b.suggestionId],accepted=success(await f.accept(ids));f.doc.getText('text:main').insert(f.source().length,' later');
   success(await f.call({op:'change.undo',changeId:accepted.changeId,eventHeads:Object.fromEntries(ids.map(id=>[id,f.heads(id)]))}));check(f.source()==='human alpha bravo charlie later');check(f.doc.getText('text:other').toString()==='second file');
   success(await f.call({op:'change.redo',changeId:accepted.changeId,eventHeads:Object.fromEntries(ids.map(id=>[id,f.heads(id)]))}));check(f.source()==='human A bravo charlie later');
  }finally{await f.close();}},
 async 'write failure retains draft and retries one acceptance identity'(){const f=await reviewFixture();try{const s=success(await f.propose(0,5,'A')),gateway=f.context.storage.commitPrepared;
   // Wrap the trusted gateway for this host only; ordinary saves still run normally.
   f.context.storage={...storage,commitPrepared(){throw new DOMException('Injected disk full','QuotaExceededError');}};
   // The collaboration host owns its original context object, so change its gateway.
   const r=await f.accept([s.suggestionId]);check(r.error.code==='quota_exceeded');check(f.source()==='alpha bravo charlie');const id=f.service.recovery.changeId;f.context.storage={...storage,commitPrepared:gateway};const saved=success(await f.accept([s.suggestionId]));check(saved.changeId===id);check(f.source()==='A bravo charlie');
  }finally{await f.close();}},
 async 'a head that moves under the commit does not strand the decision'(){const f=await reviewFixture();try{const s=success(await f.propose(0,5,'A')),gateway=f.context.storage.commitPrepared;
   // What a proof landing during signing does: the same decision then retries and succeeds.
   let moved=false;f.context.storage={...storage,commitPrepared(...args){if(!moved){moved=true;throw Object.assign(new Error('Committed project sequence changed; prepare again.'),{code:'revision_conflict'});}return gateway(...args);}};
   const r=await f.accept([s.suggestionId]);check(r.error.code==='revision_conflict');check(f.source()==='alpha bravo charlie');const id=f.service.recovery.changeId;
   await f.context.flushSave();f.doc.getMap('meta').set('name','Saved meanwhile');await f.context.flushSave();
   const saved=success(await f.accept([s.suggestionId]));check(saved.changeId===id);check(f.source()==='A bravo charlie');check(!f.service.recovery);check(f.doc.getMap('meta').get('name')==='Saved meanwhile');
  }finally{await f.close();}},
 async 'a stranded decision whose sources then changed is dropped, not left blocking later ones'(){const f=await reviewFixture();try{const s=success(await f.propose(0,5,'A')),gateway=f.context.storage.commitPrepared;let moved=false;
   f.context.storage={...storage,commitPrepared(...args){if(!moved){moved=true;throw Object.assign(new Error('Committed project sequence changed; prepare again.'),{code:'revision_conflict'});}return gateway(...args);}};
   check((await f.accept([s.suggestionId])).error.code==='revision_conflict');f.doc.getText('text:main').insert(0,'x');await f.context.flushSave();
   check(!(await f.accept([s.suggestionId])).ok);check(!f.service.recovery);check(f.source()==='xalpha bravo charlie');
  }finally{await f.close();}},
 async 'comment-only caller cannot propose accept undo or export'(){const f=await reviewFixture({capabilities:['read','comment']});try{for(const c of [{op:'review.create',title:'x'},{op:'suggestion.accept',suggestionIds:['s'],eventHeads:{}},{op:'change.undo',changeId:'x',eventHeads:{}},{op:'review.export',reviewIds:['x']}])check((await f.call(c)).error.code==='permission_denied');}finally{await f.close();}},
 async 'absent authority queues proposals without source acceptance'(){const f=await reviewFixture();let peer;try{const r=success(await f.call({op:'review.create',title:'Remote review'}));await f.context.flushSave();peer=await reviewFixture({doc:cloneProject(f.doc),projectId:f.projectId});const s=success(await peer.propose(0,5,'A','main',r.reviewId));check((await peer.accept([s.suggestionId])).error.code==='authority_unavailable');check(peer.source()===f.source());}finally{await peer?.close();await f.close();}},
 async 'same-lineage package plans deduplicate and cannot execute imported acceptance'(){const f=await reviewFixture();let peer;try{const r=success(await f.call({op:'review.create',title:'Exchange'}));await f.context.flushSave();peer=await reviewFixture({doc:cloneProject(f.doc),projectId:crypto.randomUUID()});await storage.saveProject(peer.projectId,peer.doc);const s=success(await peer.propose(0,5,'A','main',r.reviewId));peer.service.event(peer.doc,crypto.randomUUID(),r.reviewId,'authorityTransfer',{epoch:2});const bytes=peer.exchange.encode([r.reviewId]);let plan=success(await f.call({op:'review.importPlan',attachmentRef:'x'},new Map([['x',bytes]])));success(await f.call({op:'review.import',planId:plan.planId}));success(await f.accept([s.suggestionId]));
   plan=success(await f.call({op:'review.importPlan',attachmentRef:'x'},new Map([['x',bytes]])));success(await f.call({op:'review.import',planId:plan.planId}));check(f.source()==='A bravo charlie');check(f.doc.getMap('suggestions').size===1);
   const accepted=f.exchange.encode([r.reviewId]);plan=success(await peer.call({op:'review.importPlan',attachmentRef:'x'},new Map([['x',accepted]])));success(await peer.call({op:'review.import',planId:plan.planId}));check(peer.source()==='alpha bravo charlie');check(projection(peer.doc,s.suggestionId).status==='pending');
  }finally{await peer?.close();await f.close();}},
 async 'foreign package requires explicit fresh selection and rejects secret fields'(){const f=await reviewFixture(),peer=await reviewFixture();try{const s=success(await f.propose(0,5,'A')),r=f.doc.getMap('suggestions').get(s.suggestionId).reviewId,bytes=f.exchange.encode([r]);check((await peer.call({op:'review.importPlan',attachmentRef:'x'},new Map([['x',bytes]]))).error.code==='anchor_detached');const p=success(await peer.call({op:'review.importPlan',attachmentRef:'x',mapping:{[s.suggestionId]:{fileId:'main',start:0,end:5}}},new Map([['x',bytes]])));success(await peer.call({op:'review.import',planId:p.planId}));const id=[...peer.doc.getMap('suggestions').keys()][0];check(id!==s.suggestionId);success(await peer.accept([id]));const bad=JSON.parse(new TextDecoder().decode(bytes));bad.credentials='forbidden';check(!(await peer.call({op:'review.importPlan',attachmentRef:'x'},new Map([['x',new TextEncoder().encode(JSON.stringify(bad))]]))).ok);}finally{await peer.close();await f.close();}},
 async 'preview uses isolated inputs and cancellation preserves accepted state'(){let finish;const coordinator=buildCoordinator(inputs=>new Promise(resolve=>{finish=()=>resolve({success:true,pdf:new Uint8Array([1,2]),report:{issues:[]}});check(inputs.files.find(f=>f.id==='main').content==='A bravo charlie');}),()=>{finish?.();});const f=await reviewFixture({compile:options=>coordinator.run({...options,projectId:'p',revision:'accepted'})});try{const s=success(await f.propose(0,5,'A')),pending=f.call({op:'review.preview',suggestionIds:[s.suggestionId]});while(!finish)await new Promise(r=>setTimeout(r,0));f.preview.cancel();check(!(await pending).ok);check(f.source()==='alpha bravo charlie');check(!f.preview.state.url);finish=undefined;const next=f.call({op:'review.preview',suggestionIds:[s.suggestionId]});while(!finish)await new Promise(r=>setTimeout(r,0));finish();success(await next);check(f.preview.state.url);check(f.source()==='alpha bravo charlie');finish=undefined;const cancelled=f.call({op:'review.preview',suggestionIds:[s.suggestionId]});while(!finish)await new Promise(r=>setTimeout(r,0));check(!f.preview.state.url);f.preview.cancel();check(!(await cancelled).ok);check(!f.preview.state.url);}finally{coordinator.close();await f.close();}},
 async 'batch origin stays out of per-file human undo'(){const f=await reviewFixture();const manager=new Y.UndoManager(f.doc.getText('text:main'),{trackedOrigins:new Set([null]),captureTimeout:0});try{f.doc.getText('text:main').insert(0,'human ');const s=success(await f.propose(6,11,'A'));success(await f.accept([s.suggestionId]));check(manager.undoStack.length===1);manager.undo();check(f.source()==='A bravo charlie');}finally{manager.destroy();await f.close();}},
 async 'failed undo retries its exact prepared update and reload sees rebound proposal'(){const f=await reviewFixture();try{const s=success(await f.propose(0,5,'A')),accepted=success(await f.accept([s.suggestionId])),command={op:'change.undo',changeId:accepted.changeId,eventHeads:{[s.suggestionId]:f.heads(s.suggestionId)}};f.context.storage={...storage,commitPrepared(){throw new DOMException('Undo disk full','QuotaExceededError');}};check((await f.call(command)).error.code==='quota_exceeded');check(f.source()==='A bravo charlie');const id=f.service.recovery.changeId,update=f.service.recovery.update.slice();let exact=false;f.context.storage={...storage,commitPrepared(projectId,sequence,bytes,...rest){exact=equalBytes(bytes,update);return storage.commitPrepared(projectId,sequence,bytes,...rest);}};check(success(await f.call(command)).changeId===id);check(exact);const loaded=await storage.loadProject(f.projectId);check(loaded.getText('text:main').toString()==='alpha bravo charlie');check(resolveSuggestion(loaded,loaded.getMap('suggestions').get(s.suggestionId),reviewAnchors).before==='alpha');loaded.destroy();}finally{await f.close();}},
 async 'ordinary save wins CAS without publishing stale acceptance'(){const f=await reviewFixture();try{const s=success(await f.propose(0,5,'A'));f.context.storage={...storage,async commitPrepared(projectId,sequence,bytes,...rest){const concurrent=cloneProject(f.doc);concurrent.getText('text:main').insert(0,'concurrent ');await storage.saveProject(projectId,concurrent);concurrent.destroy();return storage.commitPrepared(projectId,sequence,bytes,...rest);}};check((await f.accept([s.suggestionId])).error.code==='revision_conflict');check(f.source()==='alpha bravo charlie');const saved=await storage.loadProject(f.projectId);check(saved.getText('text:main').toString()==='concurrent alpha bravo charlie');check(projection(saved,s.suggestionId).status==='pending');saved.destroy();}finally{await f.close();}},
 async 'batch undo rebinds other affected anchors for peer reload'(){const f=await reviewFixture();try{const id=crypto.randomUUID(),anchor={...reviewAnchors.capture(f.doc,'main',1,4),...f.service.common(crypto.randomUUID(),id)};f.doc.getMap('anchors').set(id,anchor);const s=success(await f.propose(0,5,'A')),a=success(await f.accept([s.suggestionId]));check(reviewAnchors.resolve(f.doc,anchor).status==='detached');success(await f.call({op:'change.undo',changeId:a.changeId,eventHeads:{[s.suggestionId]:f.heads(s.suggestionId)}}));const loaded=await storage.loadProject(f.projectId),e=[...loaded.getMap('discussionEvents').values()].find(e=>e.targetId===id&&e.kind==='anchorReattach');check(e);const resolved=reviewAnchors.resolve(loaded,e.payload.anchor);check(resolved.status==='attached'&&resolved.start===1&&resolved.end===4);loaded.destroy();}finally{await f.close();}},
 async 'undo and redo preserve pre-batch suggestion conflicts through agent commands and peer reload'(){
  for(const agent of [false,true])for(const staleBeforeRedo of [false,true]){
   const owner=crypto.randomUUID(),f=await reviewFixture({author:agent?{id:crypto.randomUUID(),kind:'agent',displayName:'Review agent',ownerAuthorId:owner}:{id:owner,kind:'human',displayName:'Reviewer'}});let peer;
   try{
    const a=success(await f.propose(6,11,'A')),original=f.doc.getMap('anchors').get(a.anchorId),t=f.doc.getText('text:main');
    const invalidate=()=>f.doc.transact(()=>{t.delete(8,1);t.insert(8,'a');});
    if(!staleBeforeRedo)invalidate();
    // B covers A for the reported sequence; the redo variant leaves the edited
    // interior of A outside B, so B itself remains valid for redo.
    const b=success(await f.propose(6,staleBeforeRedo?8:11,'B')),accepted=success(await f.accept([b.suggestionId]));
    const change=op=>f.call({op,changeId:accepted.changeId,eventHeads:{[b.suggestionId]:f.heads(b.suggestionId)}});
    success(await change('change.undo'));
    if(staleBeforeRedo)invalidate();
    const conflicted=async target=>{
     const suggestion=target.doc.getMap('suggestions').get(a.suggestionId);
     check(target.service.status(suggestion)==='conflicted','Undo revived A');
     const before=target.source(),r=await target.accept([a.suggestionId]);check(!r.ok&&r.error.code==='suggestion_conflict',JSON.stringify(r));check(target.source()===before);
    };
    await conflicted(f);success(await change('change.redo'));success(await change('change.undo'));await conflicted(f);
    if(!staleBeforeRedo)check(![...f.doc.getMap('discussionEvents').values()].some(e=>e.targetId===original.id&&e.kind==='anchorReattach'),'Stale witnesses were replaced');
    peer=await reviewFixture({doc:await storage.loadProject(f.projectId),projectId:f.projectId,author:f.author});await conflicted(peer);check(peer.source()==='alpha bravo charlie');
   }finally{await peer?.close();await f.close();}
  }
 },
 async 'bounded review body pages reject stale continuation'(){const f=await reviewFixture();try{const s=success(await f.propose(0,5,'x'.repeat(100000))),id=f.doc.getMap('suggestions').get(s.suggestionId).reviewId;const page=success(await f.call({op:'review.get',id,limit:100}));check(new TextEncoder().encode(JSON.stringify(page)).length<65536);check(page.nextCursor);f.doc.getText('text:main').insert(0,'edited ');check((await f.call({op:'review.get',id,cursor:page.nextCursor})).error.code==='revision_conflict');}finally{await f.close();}},
 async 'agent proposer keeps durable label and acceptance records both authors'(){const owner=crypto.randomUUID(),f=await reviewFixture({author:{id:crypto.randomUUID(),kind:'agent',displayName:'Review agent',ownerAuthorId:owner}});let human;try{const s=success(await f.propose(0,5,'A'));await f.context.flushSave();human=await reviewFixture({doc:cloneProject(f.doc),projectId:f.projectId,author:{id:owner,kind:'human',displayName:'Acceptor'}});success(await human.accept([s.suggestionId]));check(human.doc.getMap('authors').get(f.author.id).kind==='agent');const e=[...human.doc.getMap('discussionEvents').values()].find(e=>e.kind==='suggestionAccept');check(e.payload.proposedBy===f.author.id&&e.authorId===owner);}finally{await human?.close();await f.close();}},
};
function equalBytes(a,b){return a.length===b.length&&a.every((v,i)=>v===b[i]);}
// END REVIEW CONTRACT FIXTURE
for(const [name,run] of Object.entries(reviewCases))test(name,run);

test('isolated preview permits comment edits and retains its snapshot without a storage gateway',async()=>{
 const {registerComments}=await import('../web/comments.js');let finish,inputs;
 const coordinator=buildCoordinator(value=>{inputs=value;return new Promise(resolve=>{finish=()=>resolve({success:true,pdf:new Uint8Array([1,2]),report:{issues:[]}});});},()=>finish?.());
 const f=await reviewFixture({compile:options=>coordinator.run({...options,projectId:f.projectId,revision:'preview-base'})}),comments=registerComments({...f.context,commands:f.host});
 try{
  const proposal=success(await f.propose(0,5,'A')),pending=f.call({op:'review.preview',suggestionIds:[proposal.suggestionId]});
  while(!finish)await new Promise(resolve=>setTimeout(resolve,0));
  f.host.register('history.list',{isolated:true,prepare:(_command,scope)=>{assert.equal(scope.commitPrepared,undefined);assert.equal(scope.commitGuard,undefined);return null;},commit:async()=>({valueVersion:1})});success(await f.call({op:'history.list'}));
  const comment=success(await f.call({op:'thread.create',fileId:'main',start:0,end:5,body:'During preview'}));
  success(await f.call({op:'message.edit',messageId:comment.messageId,body:'Edited during preview'}));
  f.doc.getText('text:main').insert(0,'later ');finish();success(await pending);
  assert.equal(inputs.files.find(file=>file.id==='main').content,'A bravo charlie');assert.equal(f.source(),'later alpha bravo charlie');assert.ok(f.preview.state.url);
  f.host.register('history.name',{isolated:true,prepare:()=>null,commit:()=>({valueVersion:1})});
  assert.equal((await f.call({op:'history.name',label:'Invalid isolated write'})).error.code,'invalid_request');
 }finally{comments.close();coordinator.close();await f.close();}
});
