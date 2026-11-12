import {validate_review_package,review_digest,review_exchange_state} from './pkg/scribyra_app.js';
import {ROOTS,LIMITS} from './collaboration-schema.js';
import {cloneProject} from './assets.js';
import {validateProjectState} from './model.js';
import {records,result,fail,baseDigest} from './review-commands.js';
const encoder=new TextEncoder();
const canonical=value=>JSON.stringify(value,(_key,item)=>item&&typeof item==='object'&&!Array.isArray(item)?Object.fromEntries(Object.keys(item).sort().map(key=>[key,item[key]])):item);
const keys=(object,allowed)=>{if(!object||Array.isArray(object)||typeof object!=='object'||Object.keys(object).some(k=>!allowed.includes(k)))fail('invalid_request','Unknown review package field.');};
export function reviewExchange(context,service){
  const artifacts=new Map(),plans=new Map();
  function encode(reviewIds){
    const state={},wanted=new Set(reviewIds),ids=new Set(reviewIds);
    for(const id of reviewIds)if(!context.doc.getMap('reviews').has(id))fail('not_found','Review is unavailable.');
    for(const root of ROOTS)state[root]={};
    for(const root of ['reviews','suggestions','threads'])for(const r of records(context.doc,root))if(root==='reviews'?wanted.has(r.id):wanted.has(r.reviewId)){state[root][r.id]=r;ids.add(r.id);if(r.anchorId)ids.add(r.anchorId);}
    for(const r of records(context.doc,'messages'))if(ids.has(r.threadId)){state.messages[r.id]=r;ids.add(r.id);}
    for(const r of records(context.doc,'anchors'))if(ids.has(r.id))state.anchors[r.id]=r;
    for(const r of records(context.doc,'discussionEvents'))if(ids.has(r.targetId)){state.discussionEvents[r.id]=r;ids.add(r.id);}
    const authors=new Set(),changes=new Set();
    for(const root of ROOTS)for(const r of Object.values(state[root])){authors.add(r.authorId);changes.add(r.changeId);if(r.acceptanceAuthorityId)authors.add(r.acceptanceAuthorityId);}
    for(const r of records(context.doc,'changes'))if(changes.has(r.id))state.changes[r.id]=r;
    for(const r of records(context.doc,'authors'))if(authors.has(r.id))state.authors[r.id]=r;
    const bytes=encoder.encode(JSON.stringify({version:1,lineageId:context.doc.getMap('meta').get('lineageId'),reviewIds,state:JSON.parse(review_exchange_state(JSON.stringify(state)))}));
    if(bytes.length>LIMITS.semanticBytes)fail('invalid_request','Review package exceeds 16 MiB. Export fewer reviews.');return bytes;
  }
  function plan(bytes,mapping,actor=service.localActor){
    if(!(bytes instanceof Uint8Array)||bytes.length>LIMITS.semanticBytes)fail('invalid_request','Invalid or oversized review package.');
    let pkg;try{pkg=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}catch{fail('invalid_request','Review package is not UTF-8 JSON.');}
    keys(pkg,['version','lineageId','reviewIds','state']);
    if(pkg.version!==1||!Array.isArray(pkg.reviewIds)||!pkg.reviewIds.length||pkg.reviewIds.length>100||typeof pkg.lineageId!=='string')fail('invalid_request','Unsupported review package.');
    keys(pkg.state,ROOTS);if(Object.keys(pkg.state.versions||{}).length)fail('invalid_request','A review package cannot install history versions.');
    try{validate_review_package(new TextDecoder().decode(bytes));}catch(error){fail('invalid_request',String(error));}
    const selected=new Set(pkg.reviewIds);
    if(Object.values(pkg.state.reviews||{}).some(r=>!selected.has(r.id))||Object.values(pkg.state.suggestions||{}).some(s=>!selected.has(s.reviewId))||Object.values(pkg.state.threads||{}).some(t=>!selected.has(t.reviewId)))fail('invalid_request','Package contains records outside its review selection.');
    const foreign=pkg.lineageId!==context.doc.getMap('meta').get('lineageId');
    if(foreign&&!mapping)fail('anchor_detached','Foreign lineage requires explicit file selections for every proposal.');
    const idMap=new Map(),mapped=id=>{if(!idMap.has(id))idMap.set(id,crypto.randomUUID());return idMap.get(id);};
    const stage=cloneProject(context.doc),changeId=crypto.randomUUID(),inserted=[];
    try{
      if(foreign){
        if(Object.values(pkg.state.discussionEvents||{}).some(e=>e.kind==='restoreProjection'&&e.payload.evidence!==true))pkg.state=JSON.parse(review_exchange_state(JSON.stringify(pkg.state)));
        // Public authors remain descriptive attribution; local authority is assigned only to new reviews.
        for(const a of Object.values(pkg.state.authors||{}))stage.getMap('authors').set(mapped(a.id),{...a,id:mapped(a.id),authorId:mapped(a.authorId),changeId,...(a.ownerAuthorId?{ownerAuthorId:mapped(a.ownerAuthorId)}:{})});
        for(const r of Object.values(pkg.state.reviews||{}))stage.getMap('reviews').set(mapped(r.id),{...service.common(changeId,mapped(r.id),actor),authorId:mapped(r.authorId),title:r.title,acceptanceAuthorityId:service.authorityId,authorityEpoch:1});
        for(const s of Object.values(pkg.state.suggestions||{})){
          const source=pkg.state.anchors?.[s.anchorId],selection=mapping[s.id];
          keys(selection,['fileId','start','end']);if(!source||!selection)fail('anchor_detached','Each imported suggestion needs an explicit current selection.');
          const anchor={...context.anchors.capture(stage,selection.fileId,selection.start,selection.end),...service.common(changeId,mapped(s.anchorId),actor)};
          if(stage.getText(`text:${selection.fileId}`).toString().slice(selection.start,selection.end)!==s.before)fail('suggestion_conflict','Mapped selection does not match proposed text.');
          stage.getMap('anchors').set(anchor.id,anchor);stage.getMap('suggestions').set(mapped(s.id),{...service.common(changeId,mapped(s.id),actor),authorId:mapped(s.authorId),reviewId:mapped(s.reviewId),anchorId:anchor.id,before:s.before,after:s.after,baseDigest:baseDigest(stage,anchor,s.before,selection.start),...(s.supersedesId?{supersedesId:mapped(s.supersedesId)}:{}),...(s.insertionOrder!=null?{insertionOrder:s.insertionOrder}:{})});inserted.push(mapped(s.id));
        }
        for(const t of Object.values(pkg.state.threads||{})){
          let anchor;
          if(t.suggestionId){
            const suggestion=stage.getMap('suggestions').get(mapped(t.suggestionId));
            if(!suggestion)fail('not_found','Suggestion discussion target is missing from the package.');
            anchor=stage.getMap('anchors').get(suggestion.anchorId);
          }else{
            const selection=mapping[t.anchorId];keys(selection,['fileId','start','end']);
            if(!selection)fail('anchor_detached','Every foreign thread needs an explicit current anchor selection.');
            anchor={...context.anchors.capture(stage,selection.fileId,selection.start,selection.end),...service.common(changeId,mapped(t.anchorId),actor)};
            stage.getMap('anchors').set(anchor.id,anchor);
          }
          stage.getMap('threads').set(mapped(t.id),{...t,id:mapped(t.id),authorId:mapped(t.authorId),changeId,anchorId:anchor.id,firstMessageId:mapped(t.firstMessageId),...(t.reviewId?{reviewId:mapped(t.reviewId)}:{}),...(t.suggestionId?{suggestionId:mapped(t.suggestionId)}:{})});
        }
        for(const m of Object.values(pkg.state.messages||{}))stage.getMap('messages').set(mapped(m.id),{...m,id:mapped(m.id),authorId:mapped(m.authorId),changeId,threadId:mapped(m.threadId),mentionAuthorIds:m.mentionAuthorIds.map(mapped),...(m.replyToId?{replyToId:mapped(m.replyToId)}:{})});
        for(const e of Object.values(pkg.state.discussionEvents||{})){
          const discussion=['messageEdit','messageRedact','threadResolve','threadReopen','authorRename'].includes(e.kind)&&e.payload.evidence!==true;
          const payload=discussion?{...e.payload,...(e.payload.mentionAuthorIds?{mentionAuthorIds:e.payload.mentionAuthorIds.map(mapped)}:{})}:{evidence:true,importedEvent:e,importChangeId:changeId};
          stage.getMap('discussionEvents').set(mapped(e.id),{...e,id:mapped(e.id),authorId:mapped(e.authorId),changeId,targetId:mapped(e.targetId),parents:discussion?e.parents.map(mapped):[],payload});
        }
        service.event(stage,changeId,mapped(pkg.reviewIds[0]),'restoreProjection',{evidence:true,importedLineage:pkg.lineageId,idMap:Object.fromEntries(idMap)},actor);

      }else{
        for(const root of ROOTS)for(const record of Object.values(pkg.state[root]||{})){
          const existing=stage.getMap(root).get(record.id);
          if(existing){if(canonical(existing)!==canonical(record))fail('decision_conflict','An imported ID has different immutable content.');continue;}
          // Terminal claims are retained as evidence with fresh IDs, never decision heads.
          const decision=root==='discussionEvents'&&['suggestionAccept','suggestionReject','suggestionWithdraw','suggestionRevert','authorityTransfer','anchorReattach','restoreProjection'].includes(record.kind);
          if(decision&&records(stage,'discussionEvents').some(e=>e.payload?.evidence&&e.payload?.importedEvent?.id===record.id))continue;
          const imported=decision?{...record,id:mapped(record.id),payload:{evidence:true,importedEvent:record,importChangeId:changeId}}:record;
          stage.getMap(root).set(imported.id,imported);inserted.push(imported.id);
        }
      }
      service.change(stage,changeId,'review.import',[],{},actor);validateProjectState(stage);
      const planId=crypto.randomUUID(),revision=context.commands.revision();
      if(plans.size>=8){const [old,p]=plans.entries().next().value;p.stage.destroy();plans.delete(old);}
      plans.set(planId,{pkg,mapping,revision,stage,changeId,actor});
      return result({planId,foreign,records:inserted.length,proposals:Object.keys(pkg.state.suggestions||{}).length,acceptanceClaims:'evidence only',missingContext:'unresolvable proposals remain conflicted'});
    }catch(error){stage.destroy();throw error;}
  }
  service.register('review.export',c=>{
    const bytes=encode(c.reviewIds),artifactId=crypto.randomUUID();if(artifacts.size>=8)artifacts.delete(artifacts.keys().next().value);artifacts.set(artifactId,bytes);
    return result({artifactId,mimeType:'application/vnd.scribyra.review+json',size:bytes.length,sha256:review_digest(new TextDecoder().decode(bytes))});
  },{capabilities:['read','export']});
  // Bytes use the trusted attachment channel, not arbitrary record fields or source updates.
  const unregister=context.commands.register('review.importPlan',{prepare:(c,scope)=>({command:service.prepare(c),bytes:scope.attachments?.get(c.attachmentRef)}),commit:({command,bytes},scope)=>plan(bytes,command.mapping,scope.actor),capabilities:['review']});
  service.register('review.import',(c,scope)=>{
    const p=plans.get(c.planId);if(!p||p.revision!==context.commands.revision())fail('plan_expired','Import plan expired; inspect the package again.');
    const actor=scope.actor||service.localActor;
    if(p.actor.author.id!==actor.author.id||p.actor.sessionId!==actor.sessionId)fail('permission_denied','Import plan belongs to another actor or session.');
    // The staged document contains only semantic records added to the exact current head.
    const value=service.annotation('review.import',(stage,changeId)=>{
      for(const root of ROOTS)for(const r of records(p.stage,root))if(!stage.getMap(root).has(r.id))stage.getMap(root).set(r.id,r);
      return{projectId:context.projectId,changeId,importedChangeId:p.changeId};
    },actor);plans.delete(c.planId);p.stage.destroy();return value;
  },{capabilities:['review']});
  return{encode,plan,size(artifactId){const bytes=artifacts.get(artifactId);if(!bytes)fail('not_found','Review artifact expired.');return bytes.length;},read(artifactId,offset=0,limit=65536){
    const bytes=artifacts.get(artifactId);if(!bytes)fail('not_found','Review artifact expired.');if(!Number.isSafeInteger(offset)||offset<0||!Number.isSafeInteger(limit)||limit<1||limit>65536)fail('invalid_request','Invalid artifact range.');return bytes.slice(offset,offset+limit);
  },artifact:id=>artifacts.get(id)?.slice(),close(){unregister();artifacts.clear();for(const p of plans.values())p.stage.destroy();plans.clear();}};
}
