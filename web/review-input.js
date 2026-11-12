import {insertionOrder as order,compareInsertions} from './review-order.js';
import {anchors} from './comment-anchors.js';
import {activeRecords,baseDigest,resolveSuggestion,projection} from './review-commands.js';

const fail=message=>{throw new Error(message);};
const ordered=patches=>[...patches].sort((a,b)=>a.start-b.start||a.end-b.end||compareInsertions(a,b));
export function reviewProjection(source,patches){
  let text='',cursor=0;
  const ranges=[];
  for(const patch of ordered(patches)){
    if(patch.start<cursor)fail('Overlapping suggestions need a decision before inline editing.');
    text+=source.slice(cursor,patch.start);
    const from=text.length; text+=patch.after;
    ranges.push({...patch,from,to:text.length});cursor=patch.end;
  }
  text+=source.slice(cursor);
  const toSource=(position,side=1)=>{
    let shift=0;const boundary=[];
    for(const r of ranges){
      if(position<r.from)break;
      if(position===r.from)boundary.push(r.start);
      if(position===r.to)boundary.push(r.end);
      if(position>r.from&&position<r.to)return side<0?r.start:r.end;
      if(position>=r.to)shift+=r.after.length-(r.end-r.start);
    }
    return boundary.length?(side<0?Math.min(...boundary):Math.max(...boundary)):position-shift;
  };
  const toDisplay=(position,side=1)=>{
    let shift=0;const boundary=[];
    for(const r of ranges){
      if(position<r.start)break;
      if(position===r.start)boundary.push(r.from);
      if(position===r.end)boundary.push(r.to);
      if(position>r.start&&position<r.end)return side<0?r.from:r.to;
      if(position>=r.end)shift+=r.after.length-(r.end-r.start);
    }
    return boundary.length?(side<0?Math.min(...boundary):Math.max(...boundary)):position+shift;
  };
  return{text,ranges,toSource,toDisplay};
}

// CodeMirror supplies scalar-safe changes, including paste and undo.
export function reviewInput(source,patches,from,to,insert,authorId,affinity=1,mergeAdjacent=true){
  const view=reviewProjection(source,patches);
  const touching=view.ranges.filter(r=>from===to?from>r.from&&from<r.to||r.authorId===authorId&&from>=r.from&&from<=r.to:from<r.to&&to>r.from||mergeAdjacent&&r.authorId===authorId&&from<=r.to&&to>=r.from||r.from===r.to&&from<r.from&&to>r.to);
  if(touching.some(r=>r.authorId!==authorId))fail("Accept or reject the other author's suggestion before editing its pending text.");
  if(touching.length>1)fail('Decide these separate suggestions before replacing across them.');
  const own=touching[0],start=own&&from>=own.from?own.start:view.toSource(from,from===to?affinity:1),end=own&&to<=own.to?own.end:view.toSource(to,from===to?affinity:-1);
  const left=own?Math.min(from,own.from):from,right=own?Math.max(to,own.to):to;
  const patch={...own,key:own?.key||crypto.randomUUID(),authorId,start,end,before:source.slice(start,end),after:view.text.slice(left,from)+insert+view.text.slice(to,right),dirty:true};
  if(own&&start===end)patch.insertionOrder=order(own);
  if(!own&&start===end){
    const peers=view.ranges.filter(r=>r.start===start&&r.end===end),left=peers.filter(r=>r.to<=from).at(-1),right=peers.find(r=>r.from>=from);
    patch.insertionOrder=left&&right?order(left)/2+order(right)/2:left?order(left)+1:right?order(right)-1:0;
    if(!Number.isFinite(patch.insertionOrder)||left&&patch.insertionOrder<=order(left)||right&&patch.insertionOrder>=order(right))fail('Draft projection differs from the editor transaction: insertion order is exhausted. Your text must be retained before continuing.');
  }
  const next=ordered([...patches.filter(p=>p.key!==own?.key),patch]);
  if(reviewProjection(source,next).text!==view.text.slice(0,from)+insert+view.text.slice(to))fail('Draft projection differs from the editor transaction. Your text must be retained before continuing.');
  return next;
}

export function reviewingSession(context,fileId){
  const {doc,commands,author}=context;let source='',patches=[],reviewId,writing=false,error='';
  const execute=command=>{
    const receipt=commands.execute({version:2,requestId:crypto.randomUUID(),projectId:context.projectId,expectedRevision:commands.revision(),command});
    if(!receipt.ok)fail(receipt.error?.message||'Review command failed.');return receipt.value;
  };
  function load(){
    source=doc.getText(`text:${fileId}`).toString();patches=[];
    for(const s of activeRecords(doc,'suggestions')){
      if(projection(doc,s.id).status!=='pending')continue;
      try{const range=resolveSuggestion(doc,s,anchors);if(range.fileId===fileId)patches.push({...s,...range,key:s.id});}catch{/* Conflicted proposals remain in the panel. */}
    }
    // Ambiguous overlapping proposals stay in the panel, never pick a winner.
    patches=patches.filter(p=>!patches.some(q=>p!==q&&(p.start<q.end&&p.end>q.start)));
    error='';return display();
  }
  const display=()=>reviewProjection(source,patches);
  function input(from,to,insert,expected,affinity=1){return inputChanges([{from,to,insert}],expected,affinity);}
  function inputChanges(changes,expected,affinity=1){
    if(source!==doc.getText(`text:${fileId}`).toString())fail('Accepted source changed. Copy the pending draft before continuing.');
    for(const patch of patches.filter(p=>p.dirty))validate(patch);
    let next=patches;
    // Work backwards in the original projection. Publish only after every edit
    // and the complete editor result have passed validation.
    for(const {from,to,insert} of [...changes].reverse())next=reviewInput(source,next,from,to,insert,author.id,affinity,changes.length===1);
    if(expected!==undefined&&reviewProjection(source,next).text!==expected)fail('Draft projection differs from the editor transaction. Your text must be retained before continuing.');
    for(const patch of next)if(patch.dirty&&(!patch.binding||patch.before!==patch.bindingBefore)){patch.binding=anchors.capture(doc,fileId,patch.start,patch.end);patch.digest=baseDigest(doc,patch.binding,patch.before,patch.start);patch.bindingBefore=patch.before;}
    patches=next;error='';context.persistDraft?.({fileId,source,text:display().text});return display();
  }
  function validate(patch){
    if(patch.id&&projection(doc,patch.id).status!=='pending')fail('Draft conflicted: its previous suggestion was decided.');
    const anchor=patch.binding||doc.getMap('anchors').get(patch.anchorId),resolved=anchors.resolve(doc,anchor);
    if(resolved.status!=='attached')fail('Draft conflicted: its original source no longer survives.');
    const fresh=anchors.capture(doc,fileId,resolved.start,resolved.end);
    if(baseDigest(doc,{...fresh,prefix:anchor.prefix,suffix:anchor.suffix},patch.before,resolved.start)!==(patch.digest||patch.baseDigest)||doc.getText(`text:${fileId}`).toString().slice(resolved.start,resolved.end)!==patch.before||JSON.stringify(fresh.witnesses)!==JSON.stringify(anchor.witnesses))fail('Draft conflicted: accepted source changed.');
    return resolved;
  }
  function rebase(){
    const text=display().text,previousSource=source,dirty=patches.filter(p=>p.dirty),rebased=[],conflicted=[];
    for(const patch of dirty)try{rebased.push({...patch,...validate(patch)});}catch(e){conflicted.push({...patch,reason:e.message});}
    if(conflicted.length){
      if(!context.retainDraft)fail(conflicted[0].reason);
      context.retainDraft({fileId,source,text:display().text,patches:conflicted});
    }
    load();
    patches=ordered([...patches.filter(p=>!rebased.some(q=>q.id===p.id)),...rebased]);
    try{display();}catch(e){
      if(!context.retainDraft)throw e;
      context.retainDraft({fileId,source:previousSource,text,patches:rebased,reason:e.message});load();
    }
    return display();
  }
  function flush(expected){
    if(writing)return;
    if(expected!==undefined&&display().text!==expected){
      const reason='Draft projection differs from the editor transaction.';
      if(!context.retainDraft)fail(reason);
      context.retainDraft({fileId,source,text:expected,patches:patches.filter(p=>p.dirty),reason});load();return;
    }
    rebase();writing=true;
    try{
      if(patches.some(p=>p.dirty&&p.start===p.end&&patches.some(q=>q!==p&&q.start===p.start&&q.end===p.end&&order(q)===order(p))))fail('Draft projection differs from the editor transaction: coincident insertion order is ambiguous.');
      for(const patch of patches.filter(p=>p.dirty)){
        const resolved=validate(patch);
        if(patch.before===patch.after&&!patch.id){patch.dirty=false;continue;}
        if(!patch.reviewId&&!reviewId)reviewId=execute({op:'review.create',title:'Tracked changes'}).reviewId;
        const result=execute({op:patch.id?'suggestion.revise':'suggestion.propose',reviewId:patch.reviewId||reviewId,fileId,start:resolved.start,end:resolved.end,before:patch.before,after:patch.after,...(patch.insertionOrder!=null?{insertionOrder:patch.insertionOrder}:{}),...(patch.id?{supersedesId:patch.id}:{})});
        patch.dirty=false;patch.id=result.status==='withdrawn'?undefined:result.suggestionId;patch.reviewId=patch.reviewId||reviewId;
        if(patch.id){const record=doc.getMap('suggestions').get(patch.id);patch.anchorId=record.anchorId;patch.baseDigest=record.baseDigest;}
      }
      patches=patches.filter(p=>p.before!==p.after);error='';
    }catch(e){error=e.message;if(!context.retainDraft)throw e;context.retainDraft({fileId,source,text:display().text,patches:patches.filter(p=>p.dirty),reason:e.message});load();}finally{writing=false;}
  }
  load();return{display,input,inputChanges,flush,load,rebase,get patches(){return patches;},get source(){return source;},get dirty(){return patches.some(p=>p.dirty);},get writing(){return writing;},get error(){return error;}};
}
