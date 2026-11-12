import {localAuthor} from './local-author.js';
import './reviews.css';
import {reviewService,activeRecords,projection,anchorsAvailable} from './review-commands.js';
import {LIMITS} from './collaboration-schema.js';
import {reviewPreview} from './review-preview.js';
import {reviewExchange} from './review-exchange.js';
export function mount(context){
  if(!anchorsAvailable(context.anchors)){
    const state={enabled:false,status:'Reviews are not available in this build.'};
    context.onState?.(state);return{state,actions:{},editorExtensions:[],close(){}};
  }
  const state={enabled:true,status:'Reviews are stored locally. Select source to propose a change.',reviews:[],suggestions:[],undoId:'',redoId:''};let importPlan,preview,service,exchange;
  const update=()=>{
    if(!service)return;
    state.recovery=!!service.recovery;
    state.reviews=activeRecords(context.doc,'reviews').slice(0,100).map(r=>({...r,authority:r.acceptanceAuthorityId===service.authorityId?'Acceptance authority: this profile':'Acceptance authority: another profile',status:projection(context.doc,r.id).status==='pending'?'draft':projection(context.doc,r.id).status}));
    state.suggestions=activeRecords(context.doc,'suggestions').slice(0,100).map(s=>({...s,title:context.doc.getMap('reviews').get(s.reviewId)?.title||'Pending review',status:service.status(s),author:(context.doc.getMap('authors').get(s.authorId)?.kind==='agent'?'Agent · ':'')+(context.doc.getMap('authors').get(s.authorId)?.displayName||'Unknown (legacy)')}));
    const groups=[...service.groups];state.undoId=groups.filter(([,g])=>!g.undone).at(-1)?.[0]||'';state.redoId=groups.filter(([,g])=>g.undone).at(-1)?.[0]||'';context.onState?.({...state});
  };
  const shared={...context,author:context.author||localAuthor(),onChange:update,onRecovery:()=>{state.status='Decision not saved. Source is unchanged. Retry the same decision; a recovery draft is retained in this session.';update();},onPreview:p=>{state.previewUrl=p.url;state.previewBusy=p.status==='running';state.previewLabel=`Preview ${p.previewId} · accepted revision ${p.acceptedRevision} · suggestions ${p.suggestionIds?.join(', ')} · ${p.status}`;state.status=p.issues?.map(i=>i.summary||i.message||'Compilation issue').join('\n')||state.previewLabel;update();}};
  service=reviewService(shared);preview=reviewPreview(shared,service);exchange=reviewExchange(shared,service);
  const unregisterTransfer=context.registerTransfer?.('reviews',(operation,value)=>{if(operation==='read')return exchange.read(value.artifactId,value.offset,value.limit);if(operation==='size')return exchange.size(value.artifactId);throw new Error('Unsupported review transfer.');});
  async function execute(command,attachments,actor){
    const receipt=await context.commands.execute({version:2,requestId:crypto.randomUUID(),projectId:context.projectId,expectedRevision:context.commands.revision(),command},attachments,actor?{actor}:undefined);
    if(!receipt.ok&&receipt.error.code==='authority_unavailable'&&['suggestion.accept','suggestion.reject'].includes(command.op)&&context.requestDecision)return context.requestDecision(command);
    state.status=receipt.ok?`${command.op}: ${receipt.value.status||'complete'}`:`${receipt.error.code}: ${receipt.error.message}`;update();return receipt;
  }
  const heads=id=>projection(context.doc,id).heads;
  const accept=ids=>execute({op:'suggestion.accept',suggestionIds:ids,eventHeads:Object.fromEntries(ids.map(id=>[id,heads(id)]))});
  const download=(bytes,name,type)=>{const url=URL.createObjectURL(new Blob([bytes],{type})),a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);};
  const actions={
    'review.create':title=>execute({op:'review.create',title}),
    'review.propose':encoded=>{const c=JSON.parse(encoded),s=context.selection();return execute({op:'suggestion.propose',...c,...s,before:context.doc.getText(`text:${s.fileId}`).toString().slice(s.start,s.end)});},
    'review.submit':reviewId=>execute({op:'review.submit',reviewId,eventHeads:heads(reviewId)}),
    'review.close':reviewId=>execute({op:'review.close',reviewId,eventHeads:heads(reviewId)}),
    'suggestion.accept':id=>accept([id]),
    'suggestion.reject':suggestionId=>execute({op:'suggestion.reject',suggestionId,eventHeads:heads(suggestionId)}),
    'suggestion.withdraw':suggestionId=>execute({op:'suggestion.withdraw',suggestionId,eventHeads:heads(suggestionId)}),
    'review.acceptSet':ids=>accept(ids),
    'review.previewSet':ids=>execute({op:'review.preview',suggestionIds:ids}),
    'review.acceptAll':async()=>{const ids=state.suggestions.filter(s=>s.status==='pending').map(s=>s.id),revision=context.commands.revision();if(!ids.length||!await context.confirm?.('Accept suggestions',`Accept all ${ids.length} displayed pending suggestions as one batch?`))return;if(revision!==context.commands.revision())throw new Error('The review changed. Check the suggestions again.');return accept(ids);},
    'review.preview':id=>execute({op:'review.preview',suggestionIds:[id]}),
    'review.cancel':()=>preview.cancel(),
    'review.retry':()=>{const draft=service.recovery;return draft&&execute(draft.command,undefined,draft.actor);},
    'review.export':async id=>{const receipt=await execute({op:'review.export',reviewIds:[id]});if(receipt.ok)download(exchange.artifact(receipt.value.artifactId),'review.scribyra-review','application/vnd.scribyra.review+json');},
    'review.importFile':()=>{const input=document.createElement('input');input.type='file';input.accept='.scribyra-review,application/json';input.onchange=async()=>{try{const file=input.files[0];if(!file)return;if(file.size>LIMITS.semanticBytes)throw new Error('Review package exceeds 16 MiB.');const bytes=new Uint8Array(await file.arrayBuffer()),ref=crypto.randomUUID(),r=await execute({op:'review.importPlan',attachmentRef:ref},new Map([[ref,bytes]]));if(r.ok){importPlan=r.value.planId;state.status=`Import plan: ${r.value.proposals} proposals, ${r.value.records} records. Acceptance claims are evidence only. Confirm to import.`;update();}}catch(e){state.status=String(e);update();}};input.click();},
    'review.confirmImport':()=>execute({op:'review.import',planId:importPlan||''}),
  };
  for(const op of ['change.undo','change.redo'])actions[op]=changeId=>execute({op,changeId,eventHeads:Object.fromEntries((service.groups.get(changeId)?.ids||[]).map(id=>[id,heads(id)]))});
  context.doc.on('update',update);update();
  return{state,actions,editorExtensions:[],close(){context.doc.off('update',update);unregisterTransfer?.();preview.close();exchange.close();service.close();}};
}
