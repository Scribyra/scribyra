import {localAuthor} from './local-author.js';
import * as Y from 'yjs';
import {Decoration,EditorView,ViewPlugin,WidgetType} from '@codemirror/view';
import {prepare_comment_command,project_comments,authorize_comment_command} from './pkg/scribyra_app.js';
import {ROOTS,LIMITS,SCHEMA_VERSION,validateCollaboration} from './collaboration-schema.js';
import {AnnotationOrigin} from './change-origins.js';
import {anchors,restoredBinding,isNarrowed,previewUndo} from './comment-anchors.js';
import {projectNode} from './model.js';
import {projectedRecord} from './review-commands.js';
import {commandError} from './source-edits.js';
import {revealedSelection} from './review-editor.js';
import {commentDrafts} from './comment-drafts.js';
if(typeof window!=='undefined')void import('./comments.css');

const failure=(code,message)=>Object.assign(new Error(message),{code});
const semantic=(doc,keep=()=>true)=>Object.fromEntries(ROOTS.filter(keep).map(root=>[root,doc.getMap(root).toJSON()]));
const parse=command=>{try{return JSON.parse(prepare_comment_command(JSON.stringify(command)));}catch(error){throw commandError(error);}};
const bytes=value=>new TextEncoder().encode(JSON.stringify(value)).length;
const common=(author,changeId,id=crypto.randomUUID())=>({version:1,id,authorId:author.id,changeId,createdAt:Date.now()});
const equalHeads=(a,b)=>JSON.stringify([...a].sort())===JSON.stringify([...b].sort());
export {localAuthor} from './local-author.js';
function orderedMessages(messages,first){
  const remaining=new Map(messages.map(m=>[m.id,m])),result=[],done=new Set();
  while(remaining.size){
    const ready=[...remaining.values()].filter(m=>m.id===first||!m.replyToId||done.has(m.replyToId)||!remaining.has(m.replyToId)).sort((a,b)=>a.id===first?-1:b.id===first?1:a.id.localeCompare(b.id));
    if(!ready.length){result.push(...[...remaining.values()].map(m=>({...m,pending:true})));break;}
    for(const message of ready){result.push(message);remaining.delete(message.id);done.add(message.id);}
  }
  return result;
}
// The comment projection reads the discussion roots and only those change records that
// discussion events cite. Typing adds a change record per edit, so a long history made every
// keystroke re-serialize thousands of records (docs/large-projects.md). Cache the projection
// until one of its inputs changes; inside an open transaction always project afresh.
const projections=new WeakMap();
function projectionInput(doc){
  const cited=new Set();for(const event of doc.getMap('discussionEvents').values())if(typeof event?.changeId==='string')cited.add(event.changeId);
  const changes=doc.getMap('changes'),state=semantic(doc,root=>root!=='changes');
  state.changes=Object.fromEntries([...cited].filter(id=>changes.has(id)).map(id=>[id,changes.get(id)]));
  return{cited,state};
}
function projectComments(doc){
  if(doc._transaction)return project_comments(JSON.stringify(projectionInput(doc).state));
  let cache=projections.get(doc);
  if(!cache){
    cache={value:null,cited:new Set()};projections.set(doc,cache);
    const roots=ROOTS.filter(root=>root!=='changes').map(root=>doc.getMap(root)),changes=doc.getMap('changes');
    doc.on('beforeObserverCalls',transaction=>{
      if(cache.value===null)return;
      if(roots.some(map=>transaction.changed.has(map))||[...(transaction.changed.get(changes)||[])].some(key=>cache.cited.has(key)))cache.value=null;
    });
  }
  if(cache.value===null){const input=projectionInput(doc);cache.cited=input.cited;cache.value=project_comments(JSON.stringify(input.state));}
  return cache.value;
}
export function discussion(doc){
  const projection=JSON.parse(projectComments(doc)),authors=new Map(projection.authors.map(a=>[a.id,a])),bindings=new Map(projection.anchors.map(a=>[a.id,a]));
  const name=id=>{const a=authors.get(id);return a?`${a.displayName}${a.kind==='agent'?' (agent)':''}`:'Unknown (pending author)';};
  const threads=projection.threads.map(thread=>{
    const anchor=bindings.get(thread.displayAnchorId||thread.anchorId),binding=anchor?.binding,resolution=anchor?.conflicted?{status:'detached',reason:'decision_conflict'}:binding?anchors.resolve(doc,binding):{status:'detached',reason:'missing_anchor'};
    const messages=orderedMessages(projection.messages.filter(m=>m.threadId===thread.id),thread.firstMessageId).map(m=>({...m,authorName:name(m.authorId),variants:m.variants.map(v=>({...v,mentions:v.mentionAuthorIds.map(id=>({id,name:name(id)}))}))}));
    return{...thread,anchor:binding,anchorHeads:anchor?.eventHeads||[],anchorStatus:resolution.status,narrowed:resolution.status==='attached'&&isNarrowed(doc,binding),reason:resolution.reason||'',start:resolution.start,end:resolution.end,path:binding?(projectNode(doc,binding.fileId)?.path||binding.pathAtCreation):'Unknown file',quote:binding?.quote||'',incomplete:!binding||!messages.some(m=>m.id===thread.firstMessageId)||messages.some(m=>m.pending||m.replyToId&&!messages.some(parent=>parent.id===m.replyToId)),messages};
  });
  return{authors:projection.authors,threads,suggestionTargets:projection.suggestionTargets,incompleteSuggestions:projection.incompleteSuggestions,anchors:projection.anchors,pendingCount:projection.messages.filter(message=>!threads.some(thread=>thread.id===message.threadId)).length};
}
function summary(thread){
  const {messages,anchor,eventHeads,anchorHeads,...value}=thread;
  return{...value,fileId:anchor?.fileId||'',messageCount:messages.length,eventHeadCount:eventHeads.length,anchorHeadCount:anchorHeads.length};
}
class PointMarker extends WidgetType {
  constructor(id){super();this.id=id;}
  eq(other){return this.id===other.id;}
  ignoreEvent(){return false;}
  toDOM(){const marker=document.createElement('span');marker.className='comment-point';marker.dataset.threadId=this.id;marker.setAttribute('role','img');marker.setAttribute('aria-label','Comment at this position');return marker;}
}

function paginate(items,command,revision,key,extra={}){
  const limit=command.limit??50,signature=JSON.stringify({key,filters:command.filters||null}),cursor=command.cursor;let offset=0;
  if(cursor){let parsed;try{parsed=JSON.parse(cursor);}catch{throw failure('invalid_request','Invalid page cursor.');}
    if(parsed.revision!==revision||parsed.signature!==signature)throw failure('revision_conflict','This page changed; start a fresh read.');
    if(!Number.isSafeInteger(parsed.offset)||parsed.offset<0||parsed.offset>items.length)throw failure('invalid_request','Invalid page offset.');offset=parsed.offset;
  }
  const value={valueVersion:1,...extra,items:[],nextCursor:null,atRevision:revision};
  for(let i=offset;i<items.length&&value.items.length<limit;i++){
    const candidate={...value,items:[...value.items,items[i]],nextCursor:JSON.stringify({revision,signature,offset:i+1})};
    if(bytes(candidate)>LIMITS.receiptBytes){if(!value.items.length)throw failure('invalid_request','This record exceeds the read limit. Export discussion state for recovery.');break;}
    value.items.push(items[i]);
  }
  const next=offset+value.items.length;if(next<items.length)value.nextCursor=JSON.stringify({revision,signature,offset:next});return value;
}

export function registerComments(context){
  const {doc,commands}=context,author=context.author||localAuthor(),sessionId=context.sessionId||crypto.randomUUID(),cleanups=[];let closed=false;
  const profile=(target,changeId,caller=author)=>{
    const author=caller;
    if(!target.getMap('authors').has(author.id))target.getMap('authors').set(author.id,{...common(author,changeId,author.id),kind:author.kind,displayName:author.displayName,...(author.ownerAuthorId?{ownerAuthorId:author.ownerAuthorId}:{})});
  };
  function appendEvent(target,changeId,targetId,kind,parents,payload={},caller=author){
    const author=caller;
    const event={...common(author,changeId),targetId,kind,parents,payload};target.getMap('discussionEvents').set(event.id,event);return event.id;
  }
  function change(target,id,kind,fileIds=[],actor={author,sessionId}){
    const {author,sessionId}=actor;
    profile(target,id,author);target.getMap('changes').set(id,{...common(author,id,id),actorKind:author.kind,sessionId,kind,fileIds});
  }
  function prepare(raw,scope){
    const actor=scope.actor||{author,sessionId},caller=actor.author;
    const command=parse(raw);try{authorize_comment_command(JSON.stringify(command),JSON.stringify(semantic(doc)),caller.id,JSON.stringify(scope.capabilities));}catch(error){throw commandError(error);}
    const current=discussion(doc),find=id=>{const thread=current.threads.find(t=>t.id===id);if(!thread)throw failure('not_found','Thread no longer exists.');return thread;};
    if(command.op==='thread.list'){
      const filters=command.filters||{},items=current.threads.filter(t=>(!filters.status||filters.status==='all'||(filters.status==='detached'?t.anchorStatus==='detached':t.status===filters.status))&&(!filters.fileId||t.anchor?.fileId===filters.fileId)&&(!filters.reviewId||t.reviewId===filters.reviewId)&&(!filters.suggestionId||t.suggestionId===filters.suggestionId)).map(summary);
      return{value:paginate(items,command,commands.revision(),'threads',{pendingMessages:current.pendingCount})};
    }
    if(command.op==='thread.get'){
      const thread=find(command.id),items=thread.messages.flatMap(message=>message.variants.map((variant,index)=>({...message,variants:[{id:variant.id,body:variant.body,redacted:variant.redacted,mentionAuthorIds:variant.mentionAuthorIds}],variantIndex:index,variantCount:message.variants.length,eventHeads:message.eventHeads.includes(variant.id)?[variant.id]:[],eventHeadsComplete:message.eventHeads.length===0||message.eventHeads.length===1&&message.eventHeads[0]===variant.id})));
      const targets=new Map([[thread.id,thread.eventHeads],[thread.anchorId,thread.anchorHeads],...thread.messages.map(message=>[message.id,message.eventHeads])]);
      const events=[...doc.getMap('discussionEvents').values()].filter(event=>targets.has(event.targetId)).map(event=>({id:event.id,targetId:event.targetId,kind:event.kind,authorId:event.authorId,changeId:event.changeId,createdAt:event.createdAt,isHead:targets.get(event.targetId).includes(event.id),parentCount:event.parents.length}));
      const anchor=thread.anchor?{fileId:thread.anchor.fileId,kind:thread.anchor.kind,quote:thread.quote,prefix:thread.anchor.prefix,suffix:thread.anchor.suffix,pathAtCreation:thread.anchor.pathAtCreation}:null;
      return{value:paginate([...items,...events],command,commands.revision(),thread.id,{thread:summary(thread),anchor})};
    }
    if(doc.getMap('meta').get('schemaVersion')!==SCHEMA_VERSION)throw failure('unsupported_project_version','Reopen this project to upgrade before changing discussion.');
    const staged=new Y.Doc({gc:false}),changeId=crypto.randomUUID();Y.applyUpdate(staged,Y.encodeStateAsUpdate(doc));
    let value={valueVersion:1,changeId};
    try{
      const heads=(provided,current)=>{if(provided&&!equalHeads(provided,current))throw failure('decision_conflict','Decision heads changed; review all alternatives first.');return current;};
      const mentions=command.mentions||[];for(const id of mentions)if(id!==caller.id&&!doc.getMap('authors').has(id))throw failure('not_found','Mentioned author is not in this project.');
      if(command.op==='thread.create'||command.op==='thread.reply'){
        const suggestion=command.suggestionId?projectedRecord(doc,'suggestions',command.suggestionId):null;
        if(command.suggestionId&&!suggestion)throw failure('not_found','Suggestion no longer exists. Keep or export this reply draft.');
        let thread=command.threadId?find(command.threadId):command.op==='thread.reply'&&suggestion?current.threads.filter(t=>t.suggestionId===suggestion.id).sort((a,b)=>a.id.localeCompare(b.id)).find(t=>!command.replyToId||t.messages.some(m=>m.id===command.replyToId)):null;
        const messageId=crypto.randomUUID();
        if(thread){
          const replyToId=command.replyToId||thread.firstMessageId;
          if(!thread.messages.some(m=>m.id===replyToId))throw failure('not_found','Reply target is not in this thread.');
          staged.getMap('messages').set(messageId,{...common(caller,changeId,messageId),threadId:thread.id,replyToId,body:command.body,mentionAuthorIds:mentions});value={...value,threadId:thread.id,messageId};
        }else{
          if(command.replyToId)throw failure('not_found','Reply target is not in this suggestion discussion.');
          const threadId=crypto.randomUUID(),anchorId=suggestion?.anchorId||crypto.randomUUID();
          if(!suggestion){const binding=anchors.capture(doc,command.fileId,command.start,command.end);staged.getMap('anchors').set(anchorId,{...common(caller,changeId,anchorId),...binding});}
          staged.getMap('threads').set(threadId,{...common(caller,changeId,threadId),anchorId,firstMessageId:messageId,...(suggestion?{suggestionId:suggestion.id,reviewId:suggestion.reviewId}:{})});
          staged.getMap('messages').set(messageId,{...common(caller,changeId,messageId),threadId,body:command.body,mentionAuthorIds:mentions});value={...value,threadId,messageId,anchorId};
        }
      }else if(command.op.startsWith('message.')){
        const original=doc.getMap('messages').get(command.messageId);if(!original)throw failure('not_found','Message no longer exists.');
        // Peers refuse a signed edit of another identity's words, so refuse it here first.
        // A message written under this profile's earlier author ID is claimed, not signed, so peers would refuse its edit too.
        if(command.op==='message.edit'&&context.signedMessages?.()){const owner=id=>doc.getMap('authors').get(id)?.ownerAuthorId||id;if(owner(original.authorId)!==owner(caller.id))throw failure('permission_denied',(context.legacyAuthorIds?.()||[]).includes(owner(original.authorId))?'Messages written before direct sessions were on here cannot be edited during a session.':'Only its author can edit this message.');}
        const message=find(original.threadId).messages.find(m=>m.id===original.id),parents=heads(command.eventHeads,message.eventHeads),kind=command.op==='message.edit'?'messageEdit':'messageRedact';
        value={...value,messageId:original.id,eventId:appendEvent(staged,changeId,original.id,kind,parents,kind==='messageEdit'?{body:command.body,mentionAuthorIds:mentions}:{},caller)};
      }else if(command.op==='anchor.reattach'){
        const original=doc.getMap('anchors').get(command.anchorId);if(!original)throw failure('not_found','Anchor no longer exists.');
        const projected=current.anchors.find(a=>a.id===original.id),parents=heads(command.eventHeads,projected?.eventHeads||[]),binding=anchors.rebind(doc,projected?.binding||original,command.fileId,command.start,command.end);
        value={...value,anchorId:original.id,eventId:appendEvent(staged,changeId,original.id,'anchorReattach',parents,{anchor:binding},caller)};
      }else{
        const thread=find(command.threadId),kind=command.op==='thread.resolve'?'threadResolve':'threadReopen';
        if(kind==='threadResolve'&&thread.pending)throw failure('decision_conflict','Wait for missing decision parents before resolving this thread.');
        const parents=heads(command.eventHeads,thread.eventHeads);
        value={...value,eventId:appendEvent(staged,changeId,thread.id,kind,parents,{},caller),status:kind==='threadResolve'?'resolved':'open'};
      }
      change(staged,changeId,command.op,command.fileId?[command.fileId]:[],actor);validateCollaboration(staged);
      return{update:Y.encodeStateAsUpdate(staged,Y.encodeStateVector(doc)),value,origin:actor.origin?.({changeId})||new AnnotationOrigin({authorId:caller.id,sessionId:actor.sessionId,changeId})};
    }finally{staged.destroy();}
  }
  for(const op of ['thread.list','thread.get','thread.create','thread.reply','message.edit','message.redact','thread.resolve','thread.reopen','anchor.reattach'])cleanups.push(commands.register(op,{capabilities:[op==='thread.list'||op==='thread.get'?'read':'comment'],limits:{items:100,jsonBytes:65536,messageBytes:16384,mentions:64},prepare,commit(plan){if(plan.update)Y.applyUpdate(doc,plan.update,plan.origin);return plan.value;}}));
  // Rehearse source and all binding events before Yjs pops the live undo stack.
  // A rejected operation runs with an empty stack, then restores the same history.
  let undoRecords=[];
  if(context.origins)cleanups.push(context.origins.registerUndo((phase,transaction)=>{
    if(phase==='before'){
      undoRecords=[];
      try{
        undoRecords=previewUndo(doc,transaction.origin,staged=>{
          const current=discussion(staged),changeId=crypto.randomUUID(),records=[];
          for(const anchor of current.anchors){if(anchor.conflicted)continue;const binding=restoredBinding(staged,anchor.binding);if(!binding)continue;const id=appendEvent(staged,changeId,anchor.id,'anchorReattach',anchor.eventHeads,{anchor:binding});records.push(['discussionEvents',id,staged.getMap('discussionEvents').get(id)]);}
          if(records.length){change(staged,changeId,'anchor.undo');records.push(['changes',changeId,staged.getMap('changes').get(changeId)]);if(!doc.getMap('authors').has(author.id))records.push(['authors',author.id,staged.getMap('authors').get(author.id)]);}
          validateCollaboration(staged);return records;
        });
      }catch(error){
        const manager=transaction.origin,key=manager.redoing?'redoStack':'undoStack',stack=manager[key],entries=stack.splice(0);
        const restore=()=>{doc.off('afterAllTransactions',restore);stack.push(...entries);context.onUndoError?.(failure('operation_failed',`Undo/redo was not applied: ${error.message||error}. Export discussion state before retrying.`));};
        doc.on('afterAllTransactions',restore);
      }
    }else{
      for(const [root,id,record] of undoRecords)doc.getMap(root).set(id,record);
      undoRecords=[];
    }
  }));
  return{author,rename(displayName){
    if(closed||context.isActive?.()===false)throw failure('project_closed','This comment session is closed.');
    if(context.capabilities&&!context.capabilities.includes('comment'))throw failure('permission_denied','Changing a public author profile requires comment rights.');
    if(typeof displayName!=='string'||!displayName.trim()||Array.from(displayName).length>160)throw failure('invalid_request','Use a display name of 1–160 characters.');
    const name=displayName.trim(),staged=new Y.Doc();Y.applyUpdate(staged,Y.encodeStateAsUpdate(doc));
    try{const id=crypto.randomUUID();change(staged,id,'author.rename');const events=[...doc.getMap('discussionEvents').values()].filter(e=>e.targetId===author.id),parents=events.filter(e=>!events.some(child=>child.parents.includes(e.id))).map(e=>e.id);appendEvent(staged,id,author.id,'authorRename',parents,{displayName:name});validateCollaboration(staged);Y.applyUpdate(doc,Y.encodeStateAsUpdate(staged,Y.encodeStateVector(doc)),new AnnotationOrigin({authorId:author.id}));author.displayName=name;try{globalThis.localStorage?.setItem('scribyra:author',JSON.stringify(author));}catch{}}finally{staged.destroy();}
  },close(){closed=true;cleanups.forEach(close=>close());}};
}

export function mount(context){
  const {doc,commands}=context,service=registerComments({...context,onUndoError(error){state.open=true;fail(error);}}),views=new Set();let closed=false,composing=false,selection=null,pendingSave=false,pendingClear=false;
  const drafts=commentDrafts(context.projectId,context.draftStore);let draftId='',submittedMessageId='',submittedEventId='',recovered=false;
  const state={enabled:true,open:false,composing:false,composeFileId:'',composeStart:-1,composeQuote:'',authorName:service.author.displayName,draft:'',mentions:[],mode:'create',threadId:'',suggestionId:'',messageId:'',error:'',notice:'',filter:'open',threads:[],authors:[],page:1,more:false,detail:null};
  const publish=()=>{if(!closed)context.onState?.(structuredClone(state));};
  function persistDraft(){
    if(!state.draft&&!draftId)return;
    if(context.canPersistDrafts?.()===false){state.error='Comment draft is kept in this tab only. Accept local saving or export it before leaving.';return;}
    try{
      if(!state.draft){drafts.remove(draftId);draftId='';return;}
      draftId ||= `${state.mode}:${state.threadId||'new'}:${crypto.randomUUID()}`;
      drafts.save({id:draftId,draft:state.draft,mentions:state.mentions,mode:state.mode,threadId:state.threadId,suggestionId:state.suggestionId,messageId:state.messageId,selection,submittedMessageId,submittedEventId});state.error='';
    }catch(error){state.error=`${error.message} Your current text is kept in this tab; export it before leaving.`;}
  }
  function clearDraft(){
    if(draftId)drafts.remove(draftId);
    draftId='';submittedMessageId='';submittedEventId='';recovered=false;state.draft='';state.mentions=[];
  }
  function restoreDraft(){
    if(context.canPersistDrafts?.()===false||state.draft)return;
    try{
      for(const entry of drafts.read()){
        // A loaded message is already durable. A failed in-memory send is retried as a draft.
        if(entry.mode==='edit'?entry.submittedEventId&&doc.getMap('discussionEvents').has(entry.submittedEventId):entry.submittedMessageId&&doc.getMap('messages').has(entry.submittedMessageId)){drafts.remove(entry.id);continue;}
        draftId=entry.id;selection=entry.selection;recovered=true;
        Object.assign(state,{draft:entry.draft,mentions:entry.mentions,mode:entry.mode,threadId:entry.threadId,suggestionId:entry.suggestionId||'',messageId:entry.messageId,open:true,composing:true,notice:'Comment draft restored on this device.'});
        if(selection)selection.revision=commands.revision();
        if(state.mode==='create'){state.composeFileId=selection?.fileId||'';state.composeQuote=selection?.anchor?.quote||'';}
        break;
      }
    }catch(error){state.open=true;state.error=`${error.message} Existing local drafts were not cleared.`;}
  }
  function recoveryMessage(threads=discussion(doc).threads){
    if(!state.draft)return '';
    if(state.mode==='suggestion')return projectedRecord(doc,'suggestions',state.suggestionId)?'':'The original suggestion no longer exists. Copy or export this draft, or clear it explicitly.';
    if(state.mode!=='create'&&!threads.some(thread=>thread.id===state.threadId))return 'The original thread no longer exists. Copy or export this draft, or clear it explicitly.';
    if(state.mode==='create'&&recovered&&(!selection?.anchor||anchors.resolve(doc,selection.anchor).status!=='attached'))return 'The original source selection no longer exists. Copy or export this draft, or clear it explicitly.';
    return '';
  }
  function refresh(){
    if(closed)return;const all=discussion(doc);state.authors=all.authors;state.pendingCount=all.pendingCount;
    const filtered=all.threads.filter(t=>state.filter==='all'||(state.filter==='detached'?t.anchorStatus==='detached':t.status===state.filter));
    state.threads=filtered.slice(0,state.page*50).map(summary);state.more=filtered.length>state.threads.length;
    const detail=all.threads.find(t=>t.id===state.threadId);state.detail=detail?{...detail,messages:detail.messages.slice(0,state.messageLimit||50),more:detail.messages.length>(state.messageLimit||50)}:null;
    const recovery=recoveryMessage(all.threads);if(recovery){state.open=true;state.notice=recovery;}
    queueMicrotask(()=>{if(!closed)for(const view of views)if(!view.composing&&view.dom.isConnected)view.dispatch({effects:[]});});publish();
  }
  const focus=(id,guard=()=>true)=>requestAnimationFrame(()=>{if(!closed&&guard())document.getElementById(id)?.focus();});
  const fail=error=>{state.error=error.message||String(error);publish();};
  function run(command,revision=commands.revision()){
    const reply=commands.execute({version:2,requestId:crypto.randomUUID(),projectId:context.projectId,expectedRevision:revision,command});
    if(!reply.ok)throw failure(reply.error.code,reply.error.message);return reply.value;
  }
  // An inline composer closes on send or cancel, so focus returns to what it annotated.
  const afterInline=(threadId,guard)=>requestAnimationFrame(()=>{if(closed||!guard())return;const all=discussion(doc),cardId=all.threads.find(t=>t.id===threadId)?.displaySuggestionId||all.suggestionTargets[threadId]||threadId,target=cardId&&document.querySelector(`[data-card-id="${cardId}"] .review-card-location`);if(target)target.focus();else [...views].find(view=>view.dom.isConnected)?.focus();});
  const composerFocus=()=>typeof document!=='undefined'&&[document.body,...['comment-body','comment-send','comment-retry-save'].map(id=>document.getElementById(id))].includes(document.activeElement);
  async function save(clear=pendingClear){
    pendingClear ||= clear;
    try{await context.flushSave?.();if(closed)return;if(pendingClear)clearDraft();pendingSave=false;state.pendingSave=false;state.error='';state.notice='Saved locally';if(pendingClear){state.mode='reply';state.composing=false;}const restoreFocus=pendingClear&&composerFocus();pendingClear=false;restoreDraft();refresh();if(restoreFocus&&state.open)focus('comment-body',composerFocus);else if(restoreFocus)afterInline(state.threadId,composerFocus);}
    catch(error){if(closed)return;pendingSave=true;state.pendingSave=true;state.error=`${error.message} Your draft and in-memory discussion are preserved. Retry local save or export the draft.`;const restoreFocus=composerFocus();publish();if(restoreFocus&&state.open)focus('comment-retry-save',composerFocus);}
  }
  function begin(mode,threadId='',messageId='',suggestionId=''){
    if(pendingSave)throw failure('operation_failed','Retry the unsaved discussion before starting another message.');
    if(state.draft)throw failure('operation_failed','Send or export and clear the current draft first.');
    state.composing=true;state.mode=mode;state.threadId=threadId;state.messageId=messageId;state.suggestionId=suggestionId;state.error='';state.notice='';state.messageLimit=50;
    context.showReview?.();
    if(mode==='create'){context.validateCommentSelection?.();selection={...context.selection?.(),revision:commands.revision()};selection.anchor=anchors.capture(doc,selection.fileId,selection.start,selection.end);state.composeFileId=selection.fileId;state.composeStart=selection.start;state.composeQuote=doc.getText(`text:${selection.fileId}`).toString().slice(selection.start,Math.min(selection.end,selection.start+200));}
    if(mode==='edit'){
      const message=discussion(doc).threads.flatMap(t=>t.messages).find(m=>m.id===messageId);if(!message)throw failure('not_found','Message is missing.');
      state.draft=message.variants.filter(v=>!v.redacted).map(v=>v.body).join('\n\n');state.mentions=[...new Set(message.variants.flatMap(v=>v.mentionAuthorIds))];selection={revision:commands.revision(),eventHeads:message.eventHeads};
    }
    persistDraft();refresh();focus('comment-body');
  }
  const actions={
    'comment-toggle'(){state.open=!state.open;if(!state.open&&state.draft)state.composing=true;publish();if(state.open)focus('comment-new');else focus('review-toggle');},
    'comment-new'(){begin('create');},
    'comment-draft'(value){if(pendingSave)return;state.draft=value;state.notice=recoveryMessage(state.detail?[state.detail]:[]);persistDraft();publish();},
    'comment-mention'(id){state.mentions=state.mentions.includes(id)?state.mentions.filter(v=>v!==id):[...state.mentions,id];persistDraft();publish();},
    'comment-open'(id){if((state.draft||pendingSave)&&state.threadId!==id)throw failure('operation_failed','Send or export and clear the current draft first.');if(!state.draft&&!pendingSave){state.mode='reply';state.messageId='';state.mentions=[];selection=null;state.reattaching=false;state.error='';state.notice='';}state.open=true;state.threadId=id;state.messageLimit=50;refresh();},
    'comment-reply'(id){begin('reply',id);},
    'comment-suggestion-reply'(id){if(!projectedRecord(doc,'suggestions',id))throw failure('not_found','Suggestion no longer exists.');begin('suggestion','','',id);},
    'comment-edit'(id){const original=doc.getMap('messages').get(id);begin('edit',original?.threadId,id);},
    async 'comment-send'(){
      if(composing||pendingSave)return;
      const recovery=recoveryMessage();if(recovery)throw failure('not_found',recovery);
      let command,revision=commands.revision();
      // The selection is held by its anchor, so typing anywhere else, in any tab or by a direct-session peer, moves it along
      // instead of voiding the draft. The selected text itself changing, even partly, refuses:
      // the comment was written about that text and must not silently cover something else.
      if(state.mode==='create'&&selection?.anchor){const resolved=anchors.resolve(doc,selection.anchor);if(resolved.status!=='attached'||isNarrowed(doc,selection.anchor)||anchors.capture(doc,selection.fileId,resolved.start,resolved.end).quote!==selection.anchor.quote)throw failure('revision_conflict','The text you selected was changed or removed while you wrote this comment. Select it again to send your draft.');selection={...selection,start:resolved.start,end:resolved.end,revision};}
      if(state.mode==='create'){command={op:'thread.create',fileId:selection?.fileId,start:selection?.start,end:selection?.end,body:state.draft,mentions:state.mentions};revision=selection?.revision;}
      else if(state.mode==='edit'){
        if(doc.getMap('messages').get(state.messageId)?.threadId!==state.threadId)throw failure('operation_failed','The edit target is not in the displayed thread. Clear the draft and select the message again.');
        // Concurrent edits of this message are caught by its event heads, not by source typing.
        command={op:'message.edit',messageId:state.messageId,body:state.draft,mentions:state.mentions,eventHeads:selection?.eventHeads};}
      else command={op:'thread.reply',...(state.mode==='suggestion'?{suggestionId:state.suggestionId}:{threadId:state.threadId}),body:state.draft,mentions:state.mentions};
      const value=run(command,revision);submittedMessageId=value.messageId;submittedEventId=value.eventId;state.threadId=value.threadId||state.threadId;state.notice='Applied in memory · saving locally';pendingSave=true;state.pendingSave=true;persistDraft();publish();await save(true);
    },
    async 'comment-save'(){await save();},
    'comment-clear'(){if(pendingSave)return;clearDraft();state.error='';state.notice='';restoreDraft();refresh();},
    // Discards the draft by explicit request; the guard keeps a draft that is still being saved.
    'comment-cancel'(){if(pendingSave)return;const threadId=state.mode==='create'?'':state.mode==='suggestion'?state.suggestionId:state.threadId;clearDraft();state.error='';state.composing=false;state.mode='reply';state.messageId='';selection=null;restoreDraft();refresh();afterInline(threadId,composerFocus);},
    // Closes an untouched composer when attention moves elsewhere. A draft stays open.
    'comment-dismiss'(){if(pendingSave||state.draft||!state.composing)return;state.composing=false;state.mode='reply';state.messageId='';selection=null;publish();},
    'comment-export'(){const blob=new Blob([JSON.stringify({version:1,draft:state.draft,mentions:state.mentions,discussion:semantic(doc)},null,2)],{type:'application/json'}),url=URL.createObjectURL(blob),link=document.createElement('a');link.href=url;link.download='scribyra-comments-recovery.json';link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);},
    async 'comment-redact'(id){const message=discussion(doc).threads.flatMap(t=>t.messages).find(m=>m.id===id);run({op:'message.redact',messageId:id,eventHeads:message?.eventHeads});await save();},
    async 'comment-resolve'(id){const thread=discussion(doc).threads.find(t=>t.id===id);run({op:'thread.resolve',threadId:id,eventHeads:thread?.eventHeads});await save();},
    async 'comment-reopen'(id){const thread=discussion(doc).threads.find(t=>t.id===id);run({op:'thread.reopen',threadId:id,eventHeads:thread?.eventHeads});await save();},
    'comment-reattach'(id){if(state.draft||pendingSave)throw failure('operation_failed','Send or export and clear the current draft first.');const thread=discussion(doc).threads.find(t=>t.id===id);selection={...context.selection?.(),revision:commands.revision(),anchorId:thread?.anchorId,eventHeads:thread?.anchorHeads};anchors.capture(doc,selection.fileId,selection.start,selection.end);state.threadId=id;state.reattaching=true;state.notice='Confirm attaching this thread to the current source selection.';publish();focus('comment-confirm-reattach');},
    async 'comment-confirm-reattach'(){run({op:'anchor.reattach',anchorId:selection.anchorId,fileId:selection.fileId,start:selection.start,end:selection.end,eventHeads:selection.eventHeads},selection.revision);state.reattaching=false;await save();},
    'comment-cancel-reattach'(){state.reattaching=false;state.notice='';publish();},
    'comment-jump'(id){const thread=discussion(doc).threads.find(t=>t.id===id);if(thread?.anchorStatus!=='attached')throw failure('anchor_detached','This thread is detached. Select source and reattach explicitly.');context.activate?.(thread.anchor.fileId);requestAnimationFrame(()=>{for(const view of views)if(view.dom.isConnected&&context.selection?.().fileId===thread.anchor.fileId){view.dispatch({selection:{anchor:context.displayPosition?.(thread.start,1)??thread.start,head:context.displayPosition?.(thread.end,-1)??thread.end},annotations:revealedSelection.of(true),scrollIntoView:true});view.focus();}});},
    'comment-filter'(value){state.filter=value;state.page=1;refresh();},
    'comment-more'(){state.page++;refresh();},
    'comment-messages-more'(){state.messageLimit=(state.messageLimit||50)+50;refresh();},
    async 'comment-author'(value){if(composing)return;service.rename(value);state.authorName=service.author.displayName;await save();},
  };
  const safeActions=Object.fromEntries(Object.entries(actions).map(([name,action])=>[name,async value=>{try{await action(value);}catch(error){fail(error);}}]));
  const decorations=view=>{
    let fileId;try{fileId=context.selection?.().fileId;}catch{return Decoration.none;}if(!fileId)return Decoration.none;
    const marks=[];for(const thread of discussion(doc).threads){if(thread.suggestionId||thread.status==='resolved'||thread.anchor?.fileId!==fileId||thread.anchorStatus!=='attached'||thread.end>doc.getText(`text:${fileId}`).length)continue;const start=context.displayPosition?.(thread.start,1)??thread.start,end=context.displayPosition?.(thread.end,-1)??thread.end;if(thread.start===thread.end||start>=end)marks.push(Decoration.widget({widget:new PointMarker(thread.id),side:1}).range(start));else marks.push(Decoration.mark({class:context.activeReviewId?.()===thread.id?'comment-highlight review-active':'comment-highlight',attributes:{title:'Comment on this source','data-thread-id':thread.id}}).range(start,end));}
    return Decoration.set(marks,true);
  };
  const plugin=ViewPlugin.fromClass(class{
    constructor(view){this.view=view;views.add(view);this.decorations=decorations(view);}
    update(){this.decorations=decorations(this.view);}
    destroy(){views.delete(this.view);}
  },{decorations:instance=>instance.decorations});
  const compositionStart=()=>{composing=true;},compositionEnd=()=>{composing=false;};
  if(typeof document!=='undefined'){document.addEventListener('compositionstart',compositionStart,true);document.addEventListener('compositionend',compositionEnd,true);}
  const update=()=>refresh();doc.on('update',update);restoreDraft();refresh();
  return{state,actions:safeActions,hasDraft:()=>!!state.draft||pendingSave,editorExtensions:[plugin,EditorView.domEventHandlers({keydown(event,view){if((event.ctrlKey||event.metaKey)&&event.altKey&&event.key.toLowerCase()==='m'&&!event.getModifierState('AltGraph')&&!event.isComposing&&!view.composing){event.preventDefault();void safeActions['comment-new']();return true;}if(event.key==='Escape'&&state.open&&!event.isComposing&&!view.composing){state.open=false;publish();return true;}return false;}})],close(){closed=true;doc.off('update',update);service.close();views.clear();if(typeof document!=='undefined'){document.removeEventListener('compositionstart',compositionStart,true);document.removeEventListener('compositionend',compositionEnd,true);}}};
}
