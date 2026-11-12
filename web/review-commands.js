import {signDecisionRecords,authorizeDecisions} from './direct-provenance.js';
import {SCHEMA_VERSION} from './collaboration-schema.js';
import {compareInsertions} from './review-order.js';
import * as Y from 'yjs';
import {restoredBinding} from './comment-anchors.js';
import {validate_review_command,review_digest,review_projection} from './pkg/scribyra_app.js';
import {cloneProject,installBlob} from './assets.js';
import {addFile,validateProjectState} from './model.js';
import {applySourceEdits} from './source-edits.js';
import {discussionProjection} from './history-storage.js';
import {ReviewOrigin,AnnotationOrigin,registerRemoteOrigin,watchReplacements} from './change-origins.js';
import {textMemo,mapMemo} from './text-memo.js';

export const fail=(code,message)=>{throw Object.assign(new Error(message),{code});};
export const result=value=>({valueVersion:1,...value});
export const records=(doc,root)=>[...doc.getMap(root).values()];
export const activeRecords=(doc,root)=>records(doc,root).map(record=>projectedRecord(doc,root,record.id)).filter(Boolean);
export const projection=(doc,id)=>JSON.parse(mapMemo(doc,'discussionEvents',id,()=>review_projection(id,JSON.stringify(records(doc,'discussionEvents')))));
const equal=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const sorted=items=>[...items].sort();
export function projectedRecord(doc,root,id){
  let record=doc.getMap(root).get(id);if(!record)return null;
  const p=projection(doc,id);
  if(Object.hasOwn(p,'record'))record=p.record;
  if(!record)return null;
  if(root==='reviews'&&p.authorityEvent){
    const event=p.authorityEvent,change=doc.getMap('changes').get(event.changeId);
    if(event.payload.restored===true&&['restore','restore-copy','backup-import'].includes(change?.kind)&&event.payload.acceptanceAuthorityId===(doc.getMap('authors').get(change.authorId)?.ownerAuthorId||change.authorId))
      record={...record,acceptanceAuthorityId:event.payload.acceptanceAuthorityId,authorityEpoch:event.payload.authorityEpoch};
  }
  return record;
}
const requireRecord=(doc,root,id)=>projectedRecord(doc,root,id)||fail('not_found',`${root} record is unavailable.`);
export function anchorsAvailable(anchors){
  if(!['capture','resolve','rebind'].every(name=>typeof anchors?.[name]==='function'))return false;
  // Probe the existing service contract without touching the open project.
  const probe=new Y.Doc();
  try{
    addFile(probe,'probe.tex','anchor','probe');
    const anchor=anchors.capture(probe,'probe',0,6);
    return anchors.resolve(probe,anchors.rebind(probe,anchor,'probe',0,6)).status==='attached';
  }catch(error){if(error.code==='unsupported_command')return false;throw error;}finally{probe.destroy();}
}
export function binding(doc,suggestion){
  const anchor=requireRecord(doc,'anchors',suggestion.anchorId),p=projection(doc,anchor.id);
  if(['incomplete','conflicted'].includes(p.status))fail('anchor_detached','Anchor binding has unresolved events.');
  const heads=p.decisionHeads||p.heads;
  if(heads.length){const e=doc.getMap('discussionEvents').get(heads[0]);if(e.kind==='anchorReattach')return e.payload.anchor;}
  if(Object.hasOwn(p,'record')){
    const selected=discussionProjection(doc,'anchors',anchor.id);
    if(selected.detached)fail('anchor_detached','Restored anchor is detached.');
    if(selected.anchor)return{...anchor,...selected.anchor};
  }
  return anchor;
}
function witnesses(runs){
  const out=[];
  for(const r of [...runs].sort((a,b)=>a.client-b.client||a.clock-b.clock)){
    const last=out.at(-1);if(last&&last.client===r.client&&last.clock+last.length===r.clock)last.length+=r.length;else out.push({...r});
  }return out;
}
function pointKey(doc,anchor,start){
  const text=doc.getText(`text:${anchor.fileId}`);
  return{left:start?Y.relativePositionToJSON(Y.createRelativePositionFromTypeIndex(text,start-1,0)):null,
    right:Y.relativePositionToJSON(Y.createRelativePositionFromTypeIndex(text,start,0)),prefix:anchor.prefix,suffix:anchor.suffix};
}
export function baseDigest(doc,anchor,before,start){return review_digest(JSON.stringify({before,point:before===''?pointKey(doc,anchor,start):null}));}
function boundDigest(doc,suggestion){
  const p=projection(doc,suggestion.anchorId),heads=p.decisionHeads||p.heads;
  if(heads.length===1){const e=doc.getMap('discussionEvents').get(heads[0]);if(e.kind==='anchorReattach'&&e.payload.baseDigest&&['suggestion.accept','change.undo','change.redo'].includes(doc.getMap('changes').get(e.changeId)?.kind))return e.payload.baseDigest;}
  return suggestion.baseDigest;
}
export function resolveSuggestion(doc,suggestion,anchors,{ignoreDecision=false}={}){
  const p=projection(doc,suggestion.id);
  if(!ignoreDecision&&p.status!=='pending')fail('decision_conflict',`Suggestion is ${p.status}.`);
  const anchor=binding(doc,suggestion),resolved=anchors.resolve(doc,anchor);
  if(resolved.status!=='attached')fail('suggestion_conflict',`Detached proposal: ${resolved.reason||'binding unavailable'}.`);
  const {start,end}=resolved,text=textMemo(doc,anchor.fileId,'string',()=>doc.getText(`text:${anchor.fileId}`).toString());
  const fresh=anchors.capture(doc,anchor.fileId,start,end);
  if(text.slice(start,end)!==suggestion.before || !equal(witnesses(anchor.witnesses),witnesses(fresh.witnesses)) || baseDigest(doc,fresh,suggestion.before,start)!==boundDigest(doc,suggestion))
    fail('suggestion_conflict','The original text or item identities changed. Propose again from a fresh selection.');
  return{fileId:anchor.fileId,start,end,before:suggestion.before,after:suggestion.after};
}
// Resolve every member before combining coincident insertions for the scalar patch validator.
export function suggestionEdits(doc,ids,anchors){
  const rows=ids.map(id=>{const suggestion=requireRecord(doc,'suggestions',id);return{suggestion,edit:resolveSuggestion(doc,suggestion,anchors)};});
  rows.sort((a,b)=>a.edit.fileId.localeCompare(b.edit.fileId)||a.edit.start-b.edit.start||a.edit.end-b.edit.end||compareInsertions(a.suggestion,b.suggestion));
  const edits=rows.map(({edit,suggestion})=>Object.defineProperty(edit,'suggestionId',{value:suggestion.id}));
  for(let i=1;i<edits.length;i++){const a=edits[i-1],b=edits[i];if(a.fileId===b.fileId&&(b.start<a.end||b.start===a.start||b.start===a.end&&(a.start===a.end||b.start===b.end))&&!(a.start===a.end&&b.start===b.end&&a.start===b.start))fail('suggestion_conflict','Suggestions overlap or share an insertion boundary.');}
  const check=cloneProject(doc);try{applyReviewEdits(check,edits);}finally{check.destroy();}return edits;
}
export function applyReviewEdits(doc,edits,options){
  const combined=[];
  for(const edit of [...edits].sort((a,b)=>a.fileId.localeCompare(b.fileId)||a.start-b.start||a.end-b.end)){
    const previous=combined.at(-1);
    if(previous&&previous.fileId===edit.fileId&&previous.start===previous.end&&edit.start===edit.end&&previous.start===edit.start)previous.after+=edit.after;
    else combined.push({...edit});
  }
  return applySourceEdits(doc,combined,options);
}
export function reviewService(context){
  const {doc,commands,anchors,storage}=context,author=context.author,authorityId=context.authorityId||author.ownerAuthorId||author.id;
  const sessionId=context.sessionId||crypto.randomUUID(),localActor={author,sessionId},groups=new Map(),cleanups=[],refreshOrigin={};cleanups.push(registerRemoteOrigin(refreshOrigin));
  let recovery,closed=false,composing=false;
  cleanups.push(watchReplacements(doc,(files,transaction)=>{
    for(const [id,group] of groups)if(files===null||doc.getMap('changes').get(transaction.origin?.attribution?.changeId)?.undoOf!==id&&group.fileIds.some(id=>files.has(id))){group.manager.destroy();group.doc.destroy();groups.delete(id);}
  }));
  const sources=target=>JSON.stringify([...target.share.keys()].filter(name=>name.startsWith('text:')).sort().map(name=>[name,target.getText(name).toString()]));
  function expectedSources(edits){const expected=cloneProject(doc);try{applyReviewEdits(expected,edits);return sources(expected);}finally{expected.destroy();}}
  function verifySources(stage,expected){
    const merged=cloneProject(doc);
    try{Y.applyUpdate(merged,Y.encodeStateAsUpdate(stage));if(sources(merged)!==expected)fail('suggestion_conflict','The undo or redo no longer matches the validated edits. Propose again from the current source.');}
    finally{merged.destroy();}
  }
  const compositionStart=e=>{if(e.target?.closest?.('#code-editor'))composing=true;},compositionEnd=()=>{composing=false;};
  globalThis.document?.addEventListener('compositionstart',compositionStart);globalThis.document?.addEventListener('compositionend',compositionEnd);
  const common=(changeId,id=crypto.randomUUID(),actor=localActor)=>({version:1,id,authorId:actor.author.id,changeId,createdAt:Date.now()});
  function change(target,changeId,kind,fileIds=[],extra={},actor=localActor){
    const {author,sessionId}=actor;
    if(!target.getMap('authors').has(author.id))target.getMap('authors').set(author.id,{...common(changeId,author.id,actor),kind:author.kind||'human',displayName:author.displayName,...(author.ownerAuthorId?{ownerAuthorId:author.ownerAuthorId}:{})});
    target.getMap('changes').set(changeId,{...common(changeId,changeId,actor),actorKind:author.kind||'human',sessionId,kind,fileIds:[...new Set(fileIds)],...extra});
  }
  function event(target,changeId,targetId,kind,payload={},actor=localActor){
    const e={...common(changeId,undefined,actor),targetId,parents:projection(target,targetId).heads,kind,payload};target.getMap('discussionEvents').set(e.id,e);return e;
  }
  function heads(target,id,expected){if(!Array.isArray(expected)||!equal(sorted(projection(target,id).heads),sorted(expected)))fail('decision_conflict','Decision heads changed; read the review again.');}
  function authority(target,suggestion){
    const review=requireRecord(target,'reviews',suggestion.reviewId);
    if(review.acceptanceAuthorityId!==authorityId&&!(context.legacyAuthorIds?.()||[]).includes(review.acceptanceAuthorityId))fail('authority_unavailable','Acceptance authority is absent. Export the proposal to that profile; accepted source is unchanged.');
    if(projection(target,review.id).authorityConflict||records(target,'discussionEvents').some(e=>e.targetId===review.id&&e.kind==='authorityTransfer'&&e.payload.evidence!==true&&e.payload.restored!==true))fail('authority_unavailable','Authority transfer needs an integrated epoch handler.');
    return{acceptanceAuthorityId:review.acceptanceAuthorityId,authorityEpoch:review.authorityEpoch};
  }
  function editRights(scope){if(!['edit','review'].every(r=>scope.capabilities.includes(r)))fail('permission_denied','Undo and redo require edit and review rights.');}
  function annotation(kind,fn,actor=localActor){
    if(doc.getMap('meta').get('schemaVersion')!==SCHEMA_VERSION)fail('unsupported_project_version','Reopen this project to upgrade before making review changes.');
    const changeId=crypto.randomUUID(),stage=cloneProject(doc);
    try{let value;stage.transact(()=>{change(stage,changeId,kind,[],{},actor);value=fn(stage,changeId,actor);},actor.origin?.({changeId})||new AnnotationOrigin({authorId:actor.author.id,sessionId:actor.sessionId,changeId}));validateProjectState(stage);authorizeDecisions(doc,stage,changeId);Y.applyUpdate(doc,Y.encodeStateAsUpdate(stage),actor.origin?.({changeId})||new AnnotationOrigin({authorId:actor.author.id,sessionId:actor.sessionId,changeId}));return result({...value,changeId});}finally{stage.destroy();}
  }
  function bindRecord(target,changeId,fileId,start,end,id=crypto.randomUUID(),actor=localActor) {return{...anchors.capture(target,fileId,start,end),...common(changeId,id,actor)};}
  function page(command){
    const revision=commands.revision(),filter=command.id||'',limit=command.limit||50;
    let offset=0;
    if(command.cursor){let cursor;try{cursor=JSON.parse(command.cursor);}catch{fail('invalid_request','Invalid cursor.');}if(cursor.revision!==revision||cursor.filter!==filter)fail('revision_conflict','Page cursor is stale.');offset=cursor.offset;if(!Number.isSafeInteger(offset)||offset<0)fail('invalid_request','Invalid cursor.');}
    const all=[];
    if(command.op==='review.list')for(const r of activeRecords(doc,'reviews'))all.push({id:r.id,title:r.title,status:projection(doc,r.id).status,acceptanceAuthorityId:r.acceptanceAuthorityId});
    else{
      const suggestions=activeRecords(doc,'suggestions').filter(s=>s.reviewId===command.id),targets=new Set([command.id,...suggestions.map(s=>s.id)]);
      for(const s of suggestions){
        const before=[...s.before],after=[...s.after],chunks=Math.max(1,Math.ceil(before.length/2000),Math.ceil(after.length/2000));
        for(let chunk=0;chunk<chunks;chunk++)all.push({id:s.id,kind:'suggestion',anchorId:s.anchorId,authorId:s.authorId,status:status(s),eventHeads:projection(doc,s.id).heads,chunk,chunks,before:before.slice(chunk*2000,(chunk+1)*2000).join(''),after:after.slice(chunk*2000,(chunk+1)*2000).join('')});
      }
      for(const e of records(doc,'discussionEvents'))if(targets.has(e.targetId))all.push({id:e.id,kind:e.kind,targetId:e.targetId,authorId:e.authorId,parents:e.parents,evidence:e.payload.evidence===true});
    }
    all.sort((a,b)=>a.id.localeCompare(b.id)||(a.chunk||0)-(b.chunk||0));
    const items=[];let bytes=0;
    for(const item of all.slice(offset,offset+limit)){const size=new TextEncoder().encode(JSON.stringify(item)).length;if(bytes+size>48000)break;bytes+=size;items.push(item);}
    return result({items,nextCursor:offset+items.length<all.length?JSON.stringify({revision,filter,offset:offset+items.length}):null,atRevision:revision,...(command.id?{review:requireRecord(doc,'reviews',command.id),eventHeads:projection(doc,command.id).heads}:{})});
  }

  function status(s){const p=projection(doc,s.id);if(p.status!=='pending')return p.status;try{resolveSuggestion(doc,s,anchors);return'pending';}catch{return'conflicted';}}
  function prepare(command){try{return JSON.parse(validate_review_command(JSON.stringify(command)));}catch(error){fail('invalid_request',String(error));}}
  const register=(op,commit,{durable=false,isolated=false,capabilities=[]}={})=>cleanups.push(commands.register(op,{prepare,commit,durable,isolated,capabilities}));
  for(const op of ['review.list','review.get'])register(op,page,{capabilities:['read']});
  register('review.create',(c,scope)=>annotation(c.op,(stage,changeId,actor)=>{const review={...common(changeId,undefined,actor),title:c.title,acceptanceAuthorityId:authorityId,authorityEpoch:1};stage.getMap('reviews').set(review.id,review);return{reviewId:review.id,status:'draft'};},scope.actor),{capabilities:['review']});
  for(const op of ['review.submit','review.close'])register(op,(c,scope)=>annotation(op,(stage,changeId,actor)=>{requireRecord(stage,'reviews',c.reviewId);heads(stage,c.reviewId,c.eventHeads);const e=event(stage,changeId,c.reviewId,op==='review.submit'?'reviewSubmit':'reviewClose',{},actor);return{reviewId:c.reviewId,status:op==='review.submit'?'submitted':'closed',eventId:e.id};},scope.actor),{capabilities:['review']});
  for(const op of ['suggestion.propose','suggestion.revise'])register(op,(c,scope)=>annotation(c.op,(stage,changeId,actor)=>{
    requireRecord(stage,'reviews',c.reviewId);if(projection(stage,c.reviewId).status==='closed')fail('decision_conflict','Review is closed.');
    if(c.supersedesId&&requireRecord(stage,'suggestions',c.supersedesId).reviewId!==c.reviewId)fail('invalid_request','Superseded suggestion belongs to another review.');
    if(c.op==='suggestion.revise'){
      const previous=requireRecord(stage,'suggestions',c.supersedesId);
      if(previous.reviewId!==c.reviewId)fail('invalid_request','Superseded suggestion belongs to another review.');
      if(previous.authorId!==actor.author.id)fail('permission_denied','Only the proposer can revise a suggestion.');
      resolveSuggestion(stage,previous,anchors);
      event(stage,changeId,previous.id,'suggestionWithdraw',{...authority(stage,previous),proposedBy:previous.authorId},actor);
    }
    const anchor=bindRecord(stage,changeId,c.fileId,c.start,c.end,undefined,actor),before=stage.getText(`text:${c.fileId}`).toString().slice(c.start,c.end);
    if(before!==c.before)fail('suggestion_conflict','Selection no longer matches.');
    if(c.before===c.after)return{suggestionId:c.supersedesId,status:'withdrawn'};
    const suggestion={...common(changeId,undefined,actor),reviewId:c.reviewId,anchorId:anchor.id,baseDigest:baseDigest(stage,anchor,before,c.start),before,after:c.after,...(c.insertionOrder!=null?{insertionOrder:c.insertionOrder}:{}),...(c.supersedesId?{supersedesId:c.supersedesId}:{})};
    stage.getMap('anchors').set(anchor.id,anchor);stage.getMap('suggestions').set(suggestion.id,suggestion);
    return{suggestionId:suggestion.id,anchorId:anchor.id,status:'pending'};
  },scope.actor),{capabilities:['review']});

  function affectedBindings(stage,ids,edits){
    const saved=[],suggestions=activeRecords(stage,'suggestions'),ownAnchors=new Set(ids.map(id=>requireRecord(stage,'suggestions',id).anchorId));
    for(const a of activeRecords(stage,'anchors')){
      if(ownAnchors.has(a.id))continue;
      try{const anchor=binding(stage,{anchorId:a.id}),r=anchors.resolve(stage,anchor);
        if(r.status!=='attached')continue;
        const index=edits.findIndex(e=>e.fileId===anchor.fileId&&e.start<e.end&&(r.start===r.end?r.start>=e.start&&r.start<e.end:r.start<e.end&&r.end>e.start));
        if(index<0)continue;
        // An attached range can already have stale suggestion witnesses. Keep that
        // provenance; restoring a different batch must never repair the proposal.
        let valid=true;
        for(const s of suggestions.filter(s=>s.anchorId===a.id))try{resolveSuggestion(stage,s,anchors,{ignoreDecision:true});}catch{valid=false;}
        saved.push({anchor,valid,heads:projection(stage,a.id).heads});
      }catch{/* Ambiguous bindings stay detached; undo does not guess. */}
    }
    return saved;
  }

  function survivingInsertions(stage,ids,edits,undo=false){
    const saved=[];
    for(const s of activeRecords(stage,'suggestions')){
      if(ids.includes(s.id)||s.before!==''||projection(stage,s.id).status!=='pending')continue;
      let r;try{r=resolveSuggestion(stage,s,anchors);}catch{continue;}
      if(edits.some(e=>e.fileId===r.fileId&&e.start<e.end&&(undo?r.start>e.start&&r.start<e.end:r.start>=e.start&&r.start<=e.end)))continue;
      if(!edits.some(e=>e.fileId===r.fileId))continue;
      let start=r.start;
      for(const e of edits)if(e.fileId===r.fileId&&(e.end<r.start||e.end===r.start&&(e.start!==e.end||compareInsertions(requireRecord(stage,'suggestions',e.suggestionId),s)<0)))start+=e.after.length-(e.end-e.start);
      saved.push({suggestion:s,start,fileId:r.fileId});
    }
    return saved;
  }
  function rebindInsertions(stage,saved,changeId,actor){
    for(const {suggestion:s,start,fileId} of saved){
      const anchor={...anchors.rebind(stage,binding(stage,s),fileId,start,start),...common(changeId,s.anchorId,actor)};
      event(stage,changeId,s.anchorId,'anchorReattach',{anchor,baseDigest:baseDigest(stage,anchor,'',start)},actor);
    }
  }

  async function terminal(c,scope){
    const actor=scope.actor||localActor,{author}=actor;
    if(closed)fail('project_closed','Project closed.');
    const signature=JSON.stringify({command:c,authorId:author.id,sessionId:actor.sessionId});
    if(recovery&&recovery.signature!==signature)fail('quota_exceeded','An unsaved decision draft is retained. Retry that decision before another.');
    const locks=context.locks||globalThis.navigator?.locks;
    if(!locks)fail('authority_unavailable','Web Locks are required for review decisions.');
    return locks.request(`scribyra:review:${context.projectId}`,{signal:scope.signal},async()=>{
      scope.guard();
      const editor=globalThis.document?.getElementById('code-editor');
      if(composing)fail('browser_busy','Finish composing before deciding.');
      const inert=editor?.inert;if(editor)editor.inert=true;
      let stage,manager,committed=false,consumed=false;
      try{
        await context.flushSave();scope.guard();
        const stored=await storage.readCommittedProject(context.projectId);scope.guard();
        if(stored.kind!=='updated')fail('project_closed','Committed project is unavailable.');
        for(const blob of stored.blobs||[])installBlob(doc,blob.ref,blob.bytes);
        Y.applyUpdate(doc,stored.update,refreshOrigin);scope.guard();
        if(recovery){
          if(stored.head.sequence!==recovery.sequence&&!recovery.headMoved)fail('revision_conflict','The unsaved decision draft is stale. Export it before reopening.');
          const draft=recovery,check=cloneProject(doc);
          // A head that only moved under the commit is ordinary here: signing awaits crypto, and
          // a save can land meanwhile. The draft is still good if its sources still match. If they
          // do not, nothing was published, so drop it rather than block every later decision.
          try{Y.applyUpdate(check,draft.update);verifySources(check,expectedSources(draft.edits));}
          catch(error){if(draft.headMoved){recovery=undefined;if(draft.group&&!groupsHas(draft.group.doc)){draft.group.manager.destroy();draft.group.doc.destroy();}}throw error;}
          finally{check.destroy();}
          const saved=await scope.commitPrepared(draft.headMoved?stored.head.sequence:draft.sequence,draft.update,[],[],({sequence})=>result({...draft.value,localSequence:sequence}));
          committed=true;recovery=undefined;scope.guard();Y.applyUpdate(doc,saved.update,new ReviewOrigin({authorId:author.id,sessionId:actor.sessionId,changeId:draft.changeId}));
          if(draft.group){draft.group.undone=c.op==='change.undo';groups.set(c.op.startsWith('change.')?c.changeId:draft.changeId,draft.group);}
          context.onChange?.();return result({...draft.value,localSequence:saved.sequence});
        }
        const changeId=crypto.randomUUID();
        stage=cloneProject(doc);
        let value,group,decisionEvent,expected,restoredBindings=[],survivors=[],edits=[],inverse=[],ids=c.suggestionIds||[c.suggestionId];
        if(c.op==='change.undo'||c.op==='change.redo'){
          editRights(scope);group=groups.get(c.changeId);if(!group)fail('history_unavailable','This session no longer has that acceptance undo group.');
          if(group.undone!==(c.op==='change.redo'))fail('decision_conflict','Undo group is already in that state.');
          ids=group.ids;for(const id of ids){heads(stage,id,c.eventHeads[id]);authority(stage,requireRecord(stage,'suggestions',id));}
          if(c.op==='change.undo'){
            for(const item of group.inverse)inverse.push(resolveSuggestion(stage,item,anchors,{ignoreDecision:true}));
            group.redoBindings=affectedBindings(stage,ids,inverse);
          }else{edits=suggestionEdits(stage,ids,anchors);group.bindings=affectedBindings(stage,ids,edits);}
          survivors=survivingInsertions(stage,ids,c.op==='change.undo'?inverse:edits,c.op==='change.undo');
          expected=expectedSources(c.op==='change.undo'?inverse:edits);
          // Refresh the batch manager's own CRDT before undo: unrelated later edits survive.
          stage.destroy();stage=group.doc;Y.applyUpdate(stage,Y.encodeStateAsUpdate(doc));manager=group.manager;
          consumed=true;if(c.op==='change.undo')manager.undo();else manager.redo();
          verifySources(stage,expected);
          stage.transact(()=>{
            rebindInsertions(stage,survivors,changeId,actor);
            change(stage,changeId,c.op,group.fileIds,{undoOf:c.changeId},actor);
            for(const id of ids){const s=requireRecord(stage,'suggestions',id);event(stage,changeId,id,c.op==='change.undo'?'suggestionRevert':'suggestionAccept',{...authority(stage,s),acceptanceId:changeId,proposedBy:s.authorId},actor);}
            if(c.op==='change.undo'){
              const offsets=new Map();for(const e of [...inverse].sort((a,b)=>a.fileId.localeCompare(b.fileId)||a.start-b.start)){
                const index=inverse.indexOf(e),s=requireRecord(stage,'suggestions',ids[index]),start=e.start+(offsets.get(e.fileId)||0);
                const a={...anchors.rebind(stage,binding(stage,s),e.fileId,start,start+s.before.length),...common(changeId,s.anchorId,actor)};
                event(stage,changeId,s.anchorId,'anchorReattach',{anchor:a},actor);
                offsets.set(e.fileId,(offsets.get(e.fileId)||0)+s.before.length-(e.end-e.start));
              }
            }
            for(const saved of (c.op==='change.undo'?group.bindings:group.redoBindings)||[])if(saved.valid&&equal(sorted(saved.heads),sorted(projection(stage,saved.anchor.id).heads))){
              const anchor=restoredBinding(stage,saved.anchor);
              if(anchor){const rebound=event(stage,changeId,saved.anchor.id,'anchorReattach',{anchor},actor);saved.heads=[rebound.id];saved.anchor=anchor;}
            }
          },new ReviewOrigin({authorId:author.id,sessionId:actor.sessionId,changeId}));
          if(c.op==='change.redo')group.inverse=makeInverse(stage,ids,edits,changeId,actor);
          value={changeId,status:c.op==='change.undo'?'reverted':'accepted'};
        }else{
          for(const id of ids){const s=requireRecord(stage,'suggestions',id);authority(stage,s);heads(stage,id,c.op==='suggestion.accept'?c.eventHeads[id]:c.eventHeads);
            if(c.op==='suggestion.withdraw'&&s.authorId!==author.id)fail('permission_denied','Only the proposer can withdraw this suggestion.');
            const p=projection(stage,id);if(['accepted','rejected','withdrawn','incomplete'].includes(p.status))fail('decision_conflict',`Suggestion is ${p.status}.`);
            if(!['pending','submitted'].includes(projection(stage,s.reviewId).status))fail('decision_conflict','Review is closed, incomplete or conflicted.');
          }
          if(c.op==='suggestion.accept'){edits=suggestionEdits(stage,ids,anchors);ids=edits.map(e=>e.suggestionId);}
          expected=expectedSources(edits);
          restoredBindings=affectedBindings(stage,ids,edits);
          survivors=survivingInsertions(stage,ids,edits);
          const origin=new ReviewOrigin({authorId:author.id,sessionId:actor.sessionId,changeId});
          if(edits.length)manager=new Y.UndoManager([...new Set(edits.map(e=>stage.getText(`text:${e.fileId}`)))],{trackedOrigins:new Set([origin]),captureTimeout:0});
          stage.transact(()=>{
            if(edits.length)applyReviewEdits(stage,edits,{origin});
            rebindInsertions(stage,survivors,changeId,actor);
            change(stage,changeId,c.op,edits.map(e=>e.fileId),ids.length===1?{suggestionId:ids[0],proposedBy:requireRecord(stage,'suggestions',ids[0]).authorId}:{},actor);
            for(const id of ids){const s=requireRecord(stage,'suggestions',id);decisionEvent=event(stage,changeId,id,{'suggestion.accept':'suggestionAccept','suggestion.reject':'suggestionReject','suggestion.withdraw':'suggestionWithdraw'}[c.op],{...authority(stage,s),acceptanceId:changeId,proposedBy:s.authorId},actor);}
          },origin);
          if(manager)group={doc:stage,manager,ids,bindings:restoredBindings,fileIds:edits.map(e=>e.fileId),inverse:makeInverse(stage,ids,edits,changeId,actor),undone:false};
          value={changeId,acceptanceId:changeId,...(c.op==='suggestion.accept'?{}:{eventId:decisionEvent.id}),status:c.op.split('.')[1]==='accept'?'accepted':c.op.endsWith('reject')?'rejected':'withdrawn'};
        }
        verifySources(stage,expected);await signDecisionRecords(stage,changeId);scope.guard();validateProjectState(stage);scope.guard();
        const prepared=Y.encodeStateAsUpdate(stage);
        let saved;
        try{saved=await scope.commitPrepared(stored.head.sequence,prepared,[],[],({sequence})=>result({...value,localSequence:sequence}));}
        catch(error){
          // Keep exact prepared bytes and identity exportable; never publish a failed decision.
          recovery={signature,command:structuredClone(c),actor,changeId,update:prepared,value,sequence:stored.head.sequence,group,edits:c.op==='change.undo'?inverse:edits,headMoved:error.code==='revision_conflict'};if(group)stage=undefined;context.onRecovery?.(recovery);throw error;
        }
        committed=true;recovery=undefined;scope.guard();Y.applyUpdate(doc,saved.update,new ReviewOrigin({authorId:author.id,sessionId:actor.sessionId,changeId}));
        if(group){group.undone=c.op==='change.undo';groups.set(c.op.startsWith('change.')?c.changeId:changeId,group);stage=undefined;}
        context.onChange?.();return result({...value,localSequence:saved.sequence});
      }finally{
        if(editor)editor.inert=inert;
        if(stage&&!groupsHas(stage)){manager?.destroy();stage.destroy();}
        // A failed undo already changed its private manager; keep the exact recovery draft,
        // but do not allow that consumed manager to be used as a new decision.
        if(!committed&&consumed){
          const old=groups.get(c.changeId);groups.delete(c.changeId);
          if(old&&old!==recovery?.group){old.manager.destroy();old.doc.destroy();}
        }
      }
    });
  }
  function groupsHas(stage){return[...groups.values()].some(g=>g.doc===stage);}
  function makeInverse(stage,ids,edits,changeId,actor=localActor){
    const shifts=new Map(),mapped=new Map();
    for(const e of [...edits].sort((a,b)=>a.fileId.localeCompare(b.fileId)||a.start-b.start)){
      const start=e.start+(shifts.get(e.fileId)||0),id=ids[edits.indexOf(e)],s=requireRecord(stage,'suggestions',id),anchor=bindRecord(stage,changeId,e.fileId,start,start+e.after.length,undefined,actor);
      // Inverse proposals are session-local; their anchor records survive the committed batch.
      mapped.set(id,{...s,anchorId:anchor.id,before:e.after,after:e.before,baseDigest:baseDigest(stage,anchor,e.after,start),anchor});
      shifts.set(e.fileId,(shifts.get(e.fileId)||0)+e.after.length-(e.end-e.start));
    }
    const inverses=ids.map(id=>mapped.get(id));for(const item of inverses)stage.getMap('anchors').set(item.anchor.id,item.anchor);return inverses;
  }
  for(const op of ['suggestion.accept','suggestion.reject','suggestion.withdraw','change.undo','change.redo'])register(op,terminal,{durable:true,capabilities:op.startsWith('change.')||op==='suggestion.accept'?['edit','review']:['review']});
  return{prepare,register,annotation,common,change,event,groups,status,authorityId,localActor,
    get recovery(){return recovery;},close(){closed=true;globalThis.document?.removeEventListener('compositionstart',compositionStart);globalThis.document?.removeEventListener('compositionend',compositionEnd);if(recovery?.group&&!groupsHas(recovery.group.doc)){recovery.group.manager.destroy();recovery.group.doc.destroy();}cleanups.forEach(fn=>fn());for(const group of groups.values()){group.manager.destroy();group.doc.destroy();}groups.clear();},
  };
}
