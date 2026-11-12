import {reviewDrafts} from './review-drafts.js';
import {ySyncAnnotation} from 'y-codemirror.next';
import {EditorState,Transaction,Compartment} from '@codemirror/state';
import {EditorView,ViewPlugin,Decoration,WidgetType,keymap} from '@codemirror/view';
import {history,historyKeymap,historyField} from '@codemirror/commands';
import {sourceAffecting} from './change-origins.js';
import {discussion} from './comments.js';
import {activeRecords,resolveSuggestion,projection} from './review-commands.js';
import {anchors} from './comment-anchors.js';
import {projectFiles,projectNode} from './model.js';
import {reviewingSession} from './review-input.js';
import {recordTrust} from './direct-provenance.js';
import './review-workspace.css';
import {changedLineMarks,commentPill,dismissCommentPill,placeCommentPill,quietCommentPill,revealedSelection} from './review-editor.js';

const MINUTE=60000,HOUR=60*MINUTE,DAY=24*HOUR;
export function relativeTime(value,now=Date.now()){
  const age=now-value;if(age<MINUTE)return'Just now';
  if(age<HOUR)return`${Math.floor(age/MINUTE)} min ago`;
  if(age<DAY)return`${Math.floor(age/HOUR)} h ago`;
  if(age<7*DAY){const days=Math.floor(age/DAY);return days===1?'Yesterday':`${days} days ago`;}
  return new Date(value).toLocaleDateString(undefined,{month:'short',day:'numeric',...(new Date(value).getFullYear()===new Date(now).getFullYear()?{}:{year:'numeric'})});
}
export function initials(name){
  const words=name.replace(/^Agent · /,'').replace(/ \(agent\)$/,'').trim().split(/\s+/).filter(Boolean);
  return words.length?(words.length>1?[words[0],words.at(-1)]:[words[0]]).map(word=>Array.from(word)[0]).join('').toUpperCase():'?';
}
export function authorColour(id){let hash=0;for(const c of id)hash=(hash*31+c.charCodeAt(0))>>>0;return `var(--review-author-${hash%5})`;}
class ChangeWidget extends WidgetType{
  constructor(text,label,id,colour,kind,active){super();Object.assign(this,{text,label,id,colour,kind,active});}
  eq(other){return this.text===other.text&&this.id===other.id&&this.label===other.label&&this.colour===other.colour&&this.active===other.active;}
  toDOM(){const span=document.createElement(this.kind==='delete'?'del':'ins');span.className=this.active?`tracked-${this.kind} review-active`:`tracked-${this.kind}`;span.textContent=this.text;span.dataset.reviewId=this.id;span.style.setProperty('--change-author',this.colour);span.setAttribute('aria-label',this.label);span.title=this.label;return span;}
  ignoreEvent(){return false;}
}
export function reviewWorkspace(context,modules){
  if(typeof document==='undefined')return{actions:{},state:{mode:'editing'},flush(){},beforeLeave(){},refresh(){},report(){},close(){}};
  const {doc,author}=context,key=`scribyra:review-mode:${context.projectId}:${author.id}`;
  // A mode chosen under this profile's earlier author ID carries over to its key-derived one.
  let mode='editing';try{const saved=localStorage.getItem(key)??(context.legacyAuthorIds?.()||[]).map(id=>localStorage.getItem(`scribyra:review-mode:${context.projectId}:${id}`)).filter(Boolean).at(-1);if(['editing','reviewing','viewing'].includes(saved))mode=saved;}catch{}
  const state={mode,open:mode==='reviewing',tab:'file',filter:'open',count:0,cards:[],files:[],active:'',status:'',statusQuiet:true,preview:false};
  let session,fileId,view,timer,frame,closed=false,refreshing=false,composition=false,authorNames=new Map(),lastPreview='',lastError='',animate=false,observedList=null,revealedAt=0;
  const drafts=reviewDrafts({...context,onError:e=>announce(e.message)});
  const reviewHistory=new Compartment(),histories=new Map();let sourceEpoch=0,sessionEpoch=0;
  const historyExtension=saved=>[history(),historyField.init(()=>saved||EditorState.create({extensions:history()}).field(historyField))];
  const publish=()=>{if(!closed){context.onState?.({reviewWorkspace:{...state}});scheduleLayout();}};
  const announce=(message,quiet=false)=>{state.status=message;state.statusQuiet=quiet;publish();};
  const name=id=>{const a=authorNames.get(id)||doc.getMap('authors').get(id);return a?`${a.kind==='agent'&&a.displayName!=='Agent'?'Agent · ':''}${a.displayName}`:author.id===id?author.displayName:'Unknown author';};
  const isAgent=id=>(authorNames.get(id)||doc.getMap('authors').get(id))?.kind==='agent';
  // Only once direct sessions are on: what others' records are worth here. Never shown with
  // sessions off, so the workspace reads exactly as before direct sessions existed.
  const trust=(root,id)=>context.trustLabels?.()?recordTrust(doc,root,id,[author.id,...(context.legacyAuthorIds?.()||[])]):'own';
  const labelled=(text,root,id)=>{const value=trust(root,id);return value==='claimed'?`${text} · claimed, not verified`:value==='unverified'?`${text} · unverified`:text;};
  const stamp=value=>({time:relativeTime(value),timeTitle:new Date(value).toLocaleString(),timeIso:new Date(value).toISOString()});
  const sentAt=m=>doc.getMap('messages').get(m.id)?.createdAt||0;
  // The thread keeps its opening message first; replies read oldest to newest.
  const inTimeOrder=messages=>[...messages.slice(0,1),...messages.slice(1).sort((a,b)=>sentAt(a)-sentAt(b))];
  const messageCard=m=>{const author=name(m.authorId);return{id:m.id,author:labelled(author,'messages',m.id),initials:initials(author),agent:isAgent(m.authorId),colour:authorColour(m.authorId),...stamp(sentAt(m)),conflicted:m.conflicted,pending:m.pending,variants:m.variants.map(v=>({id:v.id,body:v.body,redacted:v.redacted}))};};
  const pending=()=>activeRecords(doc,'suggestions').filter(s=>projection(doc,s.id).status==='pending');
  // Cards with no line sort after the aligned ones instead of pushing them away.
  const placed=c=>c.start>=0?c.start:c.near>=0?c.near:Infinity;
  function refresh(){
    if(closed)return;const current=context.selection?.().fileId,all=discussion(doc),threads=all.threads;authorNames=new Map(all.authors.map(a=>[a.id,a]));
    state.active=all.suggestionTargets[state.active]||state.active;
    const cards=threads.filter(t=>!t.suggestionId).map(t=>({id:t.id,kind:'comment',discussionIds:[t.id],fileId:t.anchor?.fileId||'',path:t.path,start:t.start??-1,end:t.end??-1,author:labelled(name(t.authorId),'threads',t.id),initials:initials(name(t.authorId)),agent:isAgent(t.authorId),...stamp(doc.getMap('threads').get(t.id)?.createdAt||0),quote:t.quote,messages:inTimeOrder(t.messages).map(messageCard),status:t.status,detached:t.anchorStatus==='detached',conflicted:!!t.decisionConflict,messageId:t.firstMessageId,colour:authorColour(t.authorId)}));
    const suggestions=activeRecords(doc,'suggestions'),available=new Set(suggestions.map(s=>s.id));
    const displayTarget=id=>{const target=all.suggestionTargets[id];return available.has(target)&&all.suggestionTargets[target]===target?target:id;};
    for(const s of suggestions){
      if(displayTarget(s.id)!==s.id)continue;
      const decision=projection(doc,s.id),resolved=!all.incompleteSuggestions.includes(s.id)&&['accepted','rejected','withdrawn'].includes(decision.status);
      let range,status=all.incompleteSuggestions.includes(s.id)?'incomplete':decision.status;try{if(status==='pending')range=resolveSuggestion(doc,s,anchors);}catch{status='conflicted';}
      const discussions=threads.filter(t=>displayTarget(t.suggestionId)===s.id),messages=discussions.flatMap(t=>t.messages).sort((a,b)=>sentAt(a)-sentAt(b)||a.id.localeCompare(b.id)).map(messageCard);
      const decisionId=(decision.decisionHeads||decision.heads)[0],decider=doc.getMap('discussionEvents').get(decisionId)?.authorId;
      // A decision nobody's key verifies here is reported as a claim, never as an approval.
      const decisionTrust=resolved?trust('discussionEvents',decisionId):'own',verb={accepted:'accepted',rejected:'rejected',withdrawn:'withdrawn'}[status];
      const outcome=!resolved?'':['own','verified'].includes(decisionTrust)?`${verb[0].toUpperCase()+verb.slice(1)} by ${name(decider)}`:`Marked ${verb} by ${name(decider)} · ${decisionTrust==='claimed'?'claimed':'unverified'} decision, not an approval`;
      const discussionIds=[...discussions.map(t=>t.id),...Object.keys(all.suggestionTargets).filter(id=>all.suggestionTargets[id]===s.id)];
      const anchor=doc.getMap('anchors').get(s.anchorId);
      // A conflicted card cannot act on its old range, but it can still sit beside it.
      let near=-1;if(!range&&anchor)try{const r=anchors.resolve(doc,anchor);if(r.status==='attached')near=r.start;}catch{}
      const id=range?.fileId||anchor?.fileId||'';
      cards.push({id:s.id,kind:'suggestion',discussionIds,messages,outcome,resolved,fileId:id,path:projectNode(doc,id)?.path||anchor?.pathAtCreation||'Missing file',start:range?.start??-1,end:range?.end??-1,author:labelled(name(s.authorId),'suggestions',s.id),initials:initials(name(s.authorId)),agent:isAgent(s.authorId),...stamp(s.createdAt),before:s.before,after:s.after,status,near,colour:authorColour(s.authorId)});
    }
    for(const t of threads.filter(t=>t.suggestionId&&!available.has(displayTarget(t.suggestionId)))){
      cards.push({id:t.id,kind:'comment',discussionIds:[t.id],fileId:t.anchor?.fileId||'',path:t.path,start:t.start??-1,end:t.end??-1,author:name(t.authorId),initials:initials(name(t.authorId)),agent:isAgent(t.authorId),...stamp(doc.getMap('threads').get(t.id)?.createdAt||0),quote:t.quote,messages:inTimeOrder(t.messages).map(messageCard),status:'incomplete',detached:true,messageId:t.firstMessageId,colour:authorColour(t.authorId)});
    }
    state.previewUrl=modules.reviews.state.previewUrl||'';state.previewLabel=modules.reviews.state.previewLabel||'';
    if(state.previewLabel&&state.previewLabel!==lastPreview){lastPreview=state.previewLabel;state.statusQuiet=false;state.status=modules.reviews.state.previewBusy?'Compiling suggestion preview…':state.previewUrl?'Suggestion preview ready':'Suggestion preview failed or cancelled. Open review tools for details.';}
    if(modules.comments.state.error&&modules.comments.state.error!==lastError){lastError=modules.comments.state.error;state.status=lastError;state.statusQuiet=true;}else if(!modules.comments.state.error)lastError='';
    state.count=cards.filter(c=>!c.resolved&&c.status!=='resolved').length;
    const shown=c=>state.filter==='all'||(state.filter==='resolved'?c.resolved||c.status==='resolved':!c.resolved&&c.status!=='resolved');
    state.files=projectFiles(doc).filter(f=>!f.binary).map(f=>({id:f.id,path:f.path,count:cards.filter(c=>c.fileId===f.id&&shown(c)).length}));
    const known=new Set(state.files.map(f=>f.id)),homeless=cards.filter(c=>!known.has(c.fileId)&&shown(c)).length;if(cards.some(c=>!known.has(c.fileId)))state.files.push({id:'',path:'Not in a file',count:homeless});
    for(const c of cards)c.group=known.has(c.fileId)?c.fileId:'';
    const visible=cards.filter(c=>(state.tab==='overview'||c.fileId===current)&&shown(c)).sort((a,b)=>a.fileId.localeCompare(b.fileId)||placed(a)-placed(b)||a.id.localeCompare(b.id));
    state.total=visible.length;state.cards=visible.slice(0,100);
    drafts.render();publish();
  }
  function flush(){
    clearTimeout(timer);if(!session?.dirty)return;
    if(composition||view?.composing)throw new Error('Finish composing before changing review mode or deciding suggestions.');
    try{const changes=session.patches.filter(p=>p.dirty).map(p=>`${name(p.authorId)}: ${p.before?'deleted '+p.before+'. ':''}${p.after?'inserted '+p.after:!p.before?'removed pending insertion':''}`);const pending=drafts.pending();session.flush(view?.state.doc.toString());if(!session.error)void Promise.resolve(context.flushSave?.()).then(()=>drafts.acknowledge(pending)).catch(e=>announce(e.message));externalRefresh();state.status=changes.join(' ').slice(0,240);state.statusQuiet=true;refresh();}catch(e){state.open=true;announce(e.message);throw e;}
  }
  function beforeLeave(){if(composition||view?.composing)throw new Error('Finish composing before leaving this source.');flush();}
  function scheduleFlush(){clearTimeout(timer);timer=setTimeout(()=>{if(composition||view?.composing)return;try{flush();}catch{}},session?.patches.filter(p=>p.dirty).every(p=>p.before===p.after)?0:900);}
  function sourceRange(start,end,strict=false){
    if(state.mode!=='reviewing'||!session)return{start,end};const p=session.display();
    if(strict&&p.ranges.some(r=>start<r.to&&end>r.from&&r.after.length||start===end&&start>r.from&&start<r.to))throw new Error('Select accepted source to attach a comment. Pending text belongs to its suggestion card.');
    return{start:p.toSource(start,-1),end:p.toSource(end,1)};
  }
  const toSource=position=>state.mode==='reviewing'&&session?session.display().toSource(position):position;
  const toDisplay=(position,side=1)=>state.mode==='reviewing'&&session?session.display().toDisplay(position,side):position;
  function decorations(editor){
    const marks=[],display=state.mode==='reviewing'&&session?session.display():null;
    const rows=display?display.ranges:pending().flatMap(s=>{try{const r=resolveSuggestion(doc,s,anchors);return r.fileId===fileId?[{...s,...r,from:r.start,to:r.end,key:s.id}]:[];}catch{return[];}});
    for(const r of rows){
      const id=r.id||r.key,colour=authorColour(r.authorId),authorName=name(r.authorId),attributes={'data-review-id':id,style:`--change-author:${colour}`,title:`${authorName}: inserted ${r.after}`,'aria-label':`${authorName}: inserted ${r.after}`};
      if(display){
        if(r.after&&r.to<=editor.state.doc.length)marks.push(Decoration.mark({tagName:'ins',class:state.active===id?'tracked-insert review-active':'tracked-insert',attributes}).range(r.from,r.to));
        if(r.before)marks.push(Decoration.widget({widget:new ChangeWidget(r.before,`${authorName}: deleted ${r.before}`,id,colour,'delete',state.active===id),side:-1}).range(r.from));
      }else{
        if(r.before&&r.end<=editor.state.doc.length)marks.push(Decoration.mark({tagName:'del',class:state.active===id?'tracked-delete review-active':'tracked-delete',attributes:{...attributes,title:`${authorName}: deleted ${r.before}`,'aria-label':`${authorName}: deleted ${r.before}`}}).range(r.start,r.end));
        if(r.after)marks.push(Decoration.widget({widget:new ChangeWidget(r.after,`${authorName}: inserted ${r.after}`,id,colour,'insert',state.active===id),side:1}).range(r.end));
      }
    }
    marks.push(...changedLineMarks(editor.state.doc,rows,authorColour));
    return Decoration.set(marks,true);
  }
  const floating=commentPill(()=>{void actions['review-comment']();});
  function selectionButton(){placeCommentPill(floating,view,composition);}
  function layout(){
    frame=undefined;if(closed||!view?.dom.isConnected)return;selectionButton();
    const list=document.querySelector('.review-cards');if(!list?.offsetParent)return;
    observeCards(list);list.classList.toggle('animate',animate);animate=false;
    // List coordinates ignore the panel's own scroll, so scrolling it moves the stack as one.
    const scroller=list.closest('.review-panel-scroll'),top=list.getBoundingClientRect().top+scroller.scrollTop,comments=modules.comments.state;
    const lineTop=position=>{const pos=Math.min(position,view.state.doc.length),coords=view.coordsAtPos(pos);return(coords?coords.top:view.documentTop+view.lineBlockAt(pos).top)-top;};
    const items=[...list.children].map(element=>{
      const id=element.dataset.cardId,card=state.cards.find(c=>c.id===id);let desired=0;
      if(id==='composer'){if(comments.mode==='create'&&comments.composeFileId===fileId&&comments.composeStart>=0)desired=lineTop(toDisplay(comments.composeStart,1));}
      else if(card&&placed(card)!==Infinity)desired=lineTop(toDisplay(placed(card),card.kind==='suggestion'?-1:1));
      else desired=Infinity;
      return{element,id,desired,height:element.offsetHeight};
    }).sort((a,b)=>a.desired-b.desired);
    // The focused item keeps its line. Others give way above and below it, but a
    // card whose line is on screen is never pushed out of reach above the panel.
    const gap=8,anchor=Math.max(0,items.findIndex(item=>item.id==='composer')>=0?items.findIndex(item=>item.id==='composer'):items.findIndex(item=>item.id===state.active));
    for(const item of items)item.y=item.desired===Infinity?0:item.desired>=0?Math.max(6,item.desired):item.desired;
    for(let i=anchor-1;i>=0;i--)items[i].y=Math.max(items[i].desired<0?items[i].desired:6,Math.min(items[i].y,items[i+1].y-items[i].height-gap));
    for(let i=1;i<items.length;i++)items[i].y=Math.max(items[i].y,items[i-1].y+items[i-1].height+gap);
    let bottom=0;
    for(const {element,y,height} of items){
      element.style.transform=`translateY(${Math.round(y)}px)`;bottom=Math.max(bottom,y+height);
      if(!element.dataset.placed)requestAnimationFrame(()=>{element.dataset.placed='1';});
    }
    list.style.height=`${Math.ceil(bottom)}px`;
  }
  // Card contents change after state publishes, so size changes drive the next layout.
  const heights=new WeakMap();
  const resized=new ResizeObserver(entries=>{for(const {target,contentRect} of entries){const known=heights.get(target);if(known!==undefined&&known!==contentRect.height)animate=true;heights.set(target,contentRect.height);}scheduleLayout();}),added=new MutationObserver(()=>scheduleLayout());
  function observeCards(list){
    if(list!==observedList){observedList=list;added.disconnect();added.observe(list,{childList:true});}
    for(const element of list.children)if(!heights.has(element)){heights.set(element,undefined);resized.observe(element);}
  }
  function scheduleLayout(){if(!frame)frame=requestAnimationFrame(layout);}
  function configure(id){
    flush();fileId=id;session=state.mode==='reviewing'?reviewingSession({...context,retainDraft:draft=>drafts.retain(draft),persistDraft:draft=>drafts.checkpoint(draft)},id):null;sessionEpoch=sourceEpoch;
    const plugin=ViewPlugin.fromClass(class{
      constructor(editor){this.view=editor;view=editor;this.decorations=decorations(editor);scheduleLayout();}
      update(update){if(update.transactions.some(tr=>tr.annotation(revealedSelection)))quietCommentPill(floating,update.view);else if(update.selectionSet&&!update.startState.selection.eq(update.state.selection))delete floating.dataset.dismissed;this.decorations=decorations(update.view);if(update.docChanged&&session&&!refreshing){announce('Reviewing · pending typing',true);scheduleFlush();}scheduleLayout();}
      destroy(){const saved=this.view.state.field(historyField,false);if(session&&saved)histories.set(id,{history:saved,text:this.view.state.doc.toString(),epoch:sessionEpoch});if(view===this.view)view=null;floating.hidden=true;}
    },{decorations:p=>p.decorations});
    const extensions=[plugin,EditorView.domEventHandlers({
      scroll(){if(Date.now()-revealedAt>600&&!modules.comments.state.composing){const panel=document.querySelector('.review-panel-scroll');if(panel)panel.scrollTop=0;}scheduleLayout();},
      keydown(event,editor){if(event.key==='Escape')dismissCommentPill(floating,editor);},
      focus(){if(!modules.comments.state.draft&&!modules.comments.state.pendingSave){const panel=document.querySelector('.review-panel-scroll');if(panel)panel.scrollTop=0;}scheduleLayout();},
      blur(){setTimeout(()=>{floating.hidden=true;if(!composition)try{flush();}catch{}},0);},
      compositionstart(){composition=true;clearTimeout(timer);},
      compositionend(){composition=false;setTimeout(()=>{try{flush();externalRefresh();}catch{}},30);},
      click(event){const id=event.target.closest?.('[data-review-id]')?.dataset.reviewId;if(id){void actions['review-card'](id);return true;}const thread=event.target.closest?.('[data-thread-id]')?.dataset.threadId;if(thread){void actions['review-card'](thread);return true;}void modules.comments.actions['comment-dismiss']();if(state.active){state.active='';refresh();view?.dispatch({effects:[]});}return false;},
    })];
    if(state.mode==='reviewing'){const saved=histories.get(id);extensions.push(reviewHistory.of(historyExtension(saved?.epoch===sourceEpoch&&saved.text===session.display().text?saved.history:null)),keymap.of(historyKeymap));}
    // History transactions deliberately bypass CodeMirror transaction filters.
    // Validate at dispatch so undo, redo and native history input use the same model.
    const dispatchTransactions=state.mode==='reviewing'?(transactions,editor)=>{
      for(const tr of transactions){
        if(tr.docChanged&&!refreshing){
          const changes=[];tr.changes.iterChanges((from,to,_start,_end,insert)=>changes.push({from,to,insert:insert.toString()}),true);
          try{session.inputChanges(changes,tr.newDoc.toString(),tr.startState.selection.main.assoc||1);}catch(e){if(e.message.includes('projection differs'))drafts.retain({fileId,source:session.source,text:tr.newDoc.toString(),reason:e.message});state.open=true;announce(e.message);editor.update([]);return;}
        }
        editor.update([tr]);
      }
    }:undefined;
    // Read only rather than non-editable: selection, focus and comments still work. beforeinput covers native
    // input; a composition cannot be cancelled, so the filter refuses it and CodeMirror redraws the line.
    if(state.mode==='viewing')extensions.push(EditorState.readOnly.of(true),EditorView.contentAttributes.of({'aria-readonly':'true',inputmode:'none'}),EditorView.domEventHandlers({beforeinput(event){event.preventDefault();return true;}}),EditorState.transactionFilter.of(tr=>tr.docChanged&&!tr.annotation(ySyncAnnotation)?[]:tr));
    queueMicrotask(refresh);return{doc:session?.display().text,extensions,dispatchTransactions};
  }
  function externalRefresh(){
    if(closed||refreshing||session?.writing||composition||view?.composing)return;
    if(session&&view?.dom.isConnected){
      const sourceChanged=sessionEpoch!==sourceEpoch||session.source!==doc.getText(`text:${fileId}`).toString(),before=view.state.doc.toString(),after=(session.dirty?session.rebase():session.load()).text;
      if(sourceChanged||before!==after){refreshing=true;try{view.dispatch({changes:{from:0,to:view.state.doc.length,insert:after},selection:{anchor:Math.min(view.state.selection.main.head,after.length)},effects:reviewHistory.reconfigure(historyExtension()),annotations:Transaction.addToHistory.of(false)});}finally{refreshing=false;sessionEpoch=sourceEpoch;}}
    }else if(view?.dom.isConnected)view.dispatch({effects:[]});
    refresh();
  }
  const update=(_bytes,_origin,_doc,transaction)=>{if(sourceAffecting(doc,transaction))sourceEpoch++;queueMicrotask(externalRefresh);};doc.on('update',update);
  // Expanding takes a frame and the stack slides for a moment, so wait before scrolling.
  function reveal(id){revealedAt=Date.now();setTimeout(()=>{if(!closed){revealedAt=Date.now();document.querySelector(`[data-card-id="${id}"]`)?.scrollIntoView({block:'nearest'});}},220);}
  async function choose(id){
    flush();const effective=session?.patches.find(p=>p.key===id)?.id||id,card=state.cards.find(c=>c.id===effective);if(!card)return;id=effective;state.open=true;state.active=id;animate=true;
    if(modules.comments.state.threadId!==id)void modules.comments.actions['comment-dismiss']();
    context.activate?.(card.fileId,card.start>=0?card.start:undefined,card.end>=0?card.end:undefined);
    if(card.kind==='comment'&&card.start>=0&&view)view.dispatch({selection:{anchor:toDisplay(card.start,1),head:toDisplay(card.end,-1)},annotations:revealedSelection.of(true),scrollIntoView:true});
    // Activating focuses the editor, which must not bring back a pill for an older selection either.
    if(view)quietCommentPill(floating,view);
    refresh();reveal(id);
  }
  const actions={
    'review-status-dismiss'(){state.statusQuiet=true;publish();},
    'review-toggle'(){state.open=!state.open;publish();if(!state.open)document.getElementById('review-toggle')?.focus();},
    'review-mode'(value){if(!['editing','reviewing','viewing'].includes(value))return;flush();if(composition||view?.composing)throw new Error('Finish composing before changing mode.');context.captureSelection?.();state.mode=value;if(value==='reviewing')state.open=true;try{localStorage.setItem(key,value);}catch{announce('Mode could not be saved on this device.');}context.remount?.();refresh();},
    'review-tab'(value){flush();state.tab=value;refresh();const panel=document.querySelector('.review-panel-scroll');if(panel)panel.scrollTop=0;},
    'review-filter'(value){state.filter=value;refresh();},
    'review-file'(id){flush();state.tab='file';context.activate?.(id);refresh();},
    'review-card':choose,
    async 'review-comment'(){flush();state.open=true;publish();await modules.comments.actions['comment-new']();},
    'review-preview-toggle'(){state.preview=!state.preview;publish();},
    async 'review-compile'(){flush();const ids=pending().map(s=>s.id);if(!ids.length)throw new Error('There are no pending suggestions to preview.');state.open=true;publish();return modules.reviews.actions['review.previewSet'](ids);},
    async 'review-accept-visible'(){flush();const ids=state.cards.filter(c=>c.kind==='suggestion'&&!c.resolved).map(c=>c.id);if(!ids.length)return;const revision=context.commands.revision();if(!await context.confirm?.('Accept suggestions',`Accept all ${ids.length} visible suggestions? This changes accepted source as one batch.`))return;if(revision!==context.commands.revision())throw new Error('The review changed. Check the visible suggestions again.');return modules.reviews.actions['review.acceptSet'](ids);},
    async 'review-reject-visible'(){flush();const ids=state.cards.filter(c=>c.kind==='suggestion'&&!c.resolved).map(c=>c.id);if(!ids.length)return;const revision=context.commands.revision();if(!await context.confirm?.('Reject suggestions',`Reject all ${ids.length} visible suggestions?`))return;if(revision!==context.commands.revision())throw new Error('The review changed. Check the visible suggestions again.');for(const id of ids){const r=await modules.reviews.actions['suggestion.reject'](id);if(!r.ok)return r;}return{ok:true,value:{status:'rejected'}};},
  };
  const resize=()=>scheduleLayout();window.addEventListener('resize',resize);
  const cardClick=event=>{const card=event.target.closest?.('.review-card');if(card&&!event.target.closest('button,a,input,select,textarea,.review-menu'))void choose(card.dataset.cardId).catch(e=>announce(e.message));};document.addEventListener('click',cardClick);
  // ⋯ menus are opened by the shared popup system in menu.js.
  const menuClick=()=>{},menuKey=()=>{};
  // A card can sit above the panel while its line is scrolled away. Bring the
  // line back when keyboard focus reaches it, without moving the selection.
  const cardFocus=event=>{if(event.target.id==='comment-body'){const holder=event.target.closest('[data-card-id]');if(holder)reveal(holder.dataset.cardId);}const card=event.target.closest?.('.review-card'),scroller=card?.closest('.review-panel-scroll');if(!scroller||!view?.dom.isConnected||state.tab!=='file')return;const above=scroller.getBoundingClientRect().top-card.getBoundingClientRect().top;if(above>0)view.scrollDOM.scrollTop-=above+8;};document.addEventListener('focusin',cardFocus);
  const clock=setInterval(()=>{if(state.cards.length&&!document.hidden)refresh();},MINUTE);
  const beforeUnload=e=>{if(!context.canUnload?.()&&(session?.dirty||drafts.pending().length)){e.preventDefault();e.returnValue='';}};window.addEventListener('beforeunload',beforeUnload);
  refresh();return{state,actions,configure,flush,beforeLeave,recovery:drafts.recovery,report(receipt){if(receipt?.ok===false){state.open=true;announce(`${receipt.error.code}: ${receipt.error.message}`);}else if(receipt?.ok&&receipt.value?.status)announce(receipt.value.status,true);},toSource,toDisplay,sourceRange,refresh,close(){closed=true;clearTimeout(timer);cancelAnimationFrame(frame);doc.off('update',update);window.removeEventListener('resize',resize);window.removeEventListener('beforeunload',beforeUnload);document.removeEventListener('click',cardClick);document.removeEventListener('click',menuClick);document.removeEventListener('keydown',menuKey,true);document.removeEventListener('focusin',cardFocus);clearInterval(clock);resized.disconnect();added.disconnect();histories.clear();floating.remove();drafts.close();}};
}
