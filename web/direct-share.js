import {directSession} from './direct-session.js';
import {parseInvite,encodeInvite,directSupport,requireDirectSupport} from './direct-identity.js';
import {directEnabled,setDirectEnabled,directKeyPresent} from './direct-state.js';
import {openDialog,openPrompt} from './menu.js';
import './direct-share.css';
const requestedIds=command=>command?.suggestionIds||(command?.suggestionId?[command.suggestionId]:[]);
const element=(tag,text,cls)=>{const node=document.createElement(tag);if(text)node.textContent=text;if(cls)node.className=cls;return node;};
export function directShare(context){
 let session,dialog,popup,status={message:'Direct sessions are off',peers:[]},endpoint='',bearer='',inviteText=context.initialInvite||'',name=context.author.displayName,enabled=directEnabled(),closed=false;
 let generation=0,pending=context.initialAttempt;
 context.onEnabled?.(enabled);
 const cancel=()=>{generation++;pending?.abort();pending=null;session?.close();session=null;};
 const attempt=()=>{cancel();pending=new AbortController();return{generation,controller:pending};};
 const current=job=>!closed&&enabled&&job.generation===generation&&!job.controller.signal.aborted;
 let feedback='',refusal='';const requests=new Map();let renderStatus=()=>{};
 // directSupport() makes a throwaway key to test the browser, so it runs only once sessions are on.
 const checkSupport=()=>{if(enabled)void directSupport().then(result=>{refusal=result.ok?'':result.reason;renderStatus();});};
 const fail=error=>{feedback=error.message;renderStatus();};
 function avatars(){context.onActive?.(!!session&&!closed);const host=document.getElementById('direct-participants');if(!host)return;host.replaceChildren();for(const peer of status.peers){const avatar=element('button',peer.name.slice(0,1).toUpperCase(),'direct-avatar');avatar.title=`${peer.kind==='agent'?'Agent · ':''}${peer.name} · ${peer.status}`;avatar.setAttribute('aria-label',avatar.title);avatar.onclick=show;host.append(avatar);}}
 async function start(invitation){
  if(!enabled)throw Error('Enable experimental direct sessions first.');
  const job=attempt();feedback='';renderStatus();await requireDirectSupport();if(!current(job))return;await context.flushSave();if(!current(job))return;
  const connection=await directSession({...context,endpoint,bearer,invitation,signal:job.controller.signal,author:{...context.author,displayName:name},onState:value=>{if(!current(job))return;status=value;renderStatus();avatars();},onRequest:(request,author)=>{
   if(!current(job))return;
   const ids=requestedIds(request.command);
   if(requests.size>=32||typeof request.id!=='string'||request.id.length>64||!['suggestion.accept','suggestion.reject'].includes(request.command?.op)||!Array.isArray(ids)||!ids.length||ids.length>32||!ids.every(id=>context.doc.getMap('suggestions').has(id)))return;
   if(requests.has(request.id))return;requests.set(request.id,{request,author});context.notify?.('A peer requests a review decision. Open Share to review it.');renderStatus();
  }});
  if(!current(job)){connection.close();return;}session=connection;pending=null;
  inviteText=new URL(location.href).origin+location.pathname+'#direct='+encodeInvite(session.invitation);renderStatus();avatars();
 }
 function show(){
  if(closed)return;if(dialog){dialog.focus();return;}
  dialog=element('dialog',null,'ui-popup direct-share');dialog.setAttribute('aria-label','Share project');dialog.tabIndex=-1;
  const heading=element('div',null,'direct-heading');heading.append(element('h2','Share project','ui-prompt-title'),element('span','Experimental','direct-badge'));
  const close=element('button','×','icon-button');close.type='button';close.setAttribute('aria-label','Close sharing');close.onclick=()=>popup?.close('now');heading.append(close);dialog.append(heading);
  const toggle=element('label',null,'direct-enable'),check=element('input');check.type='checkbox';check.checked=enabled;check.setAttribute('aria-label','Experimental direct browser sessions');toggle.append(check,element('span','Experimental direct browser sessions'));dialog.append(toggle);
  const keyNote=element('p','','direct-help'),removeKey=element('button','Delete signing key','button compact secondary');removeKey.type='button';const keyRow=element('div',null,'direct-key');keyRow.append(keyNote,removeKey);dialog.append(keyRow);
  const inviteNote=element('p','This invitation needs experimental direct sessions. Turning them on creates a signing key in this browser; nothing is shared or joined until you choose Join invite.','direct-help');dialog.append(inviteNote);
  const disclosure=element('p','Invite trusted full editors only. Shares source, assets, comments, suggestions, discussions, authors and trash — including deleted files’ full text and CRDT history. Peers can keep copies but are not a backup, and they see your network address. The connection service sees timing, sizes and who is in a room. No comment-only access.','direct-disclosure');const setup=element('div');dialog.append(setup);setup.append(disclosure);
  const form=element('div',null,'direct-fields');
  function field(label,value,type='text'){const row=element('label'),input=element('input','','ui-input');input.type=type;input.value=value;input.setAttribute('aria-label',label);input.autocomplete='off';row.append(element('span',label),input);form.append(row);return input;}
  const endpointInput=field('Connection service',endpoint),bearerInput=field('Relay capability',bearer,'password'),nameInput=field('Your name',name);nameInput.maxLength=160;
  endpointInput.placeholder='https://your-service.example';bearerInput.placeholder='Provided privately by your operator';
  endpointInput.oninput=()=>endpoint=endpointInput.value.trim();bearerInput.oninput=()=>bearer=bearerInput.value.trim();nameInput.oninput=()=>name=nameInput.value.trim();
  setup.append(form,element('p','Each person enters their own relay capability. It stays in this tab and is never included in the invite.','direct-help'));
  const earlier=element('p','','direct-help direct-earlier');earlier.setAttribute('role','note');setup.append(earlier);
  const actions=element('div',null,'direct-actions');
  function button(label,fn,cls='secondary'){const b=element('button',label,'button compact '+cls);b.type='button';b.onclick=()=>{feedback='';return Promise.resolve().then(fn).catch(fail);};return b;}
  const create=button('Start session',()=>start(), 'primary'),clean=button('Share a cleaned copy',async()=>{const job=attempt();await requireDirectSupport();if(!current(job))return;await context.cleanCopy({endpoint,bearer,name},job.controller);});actions.append(create,clean);setup.append(actions);
  const linkLabel=element('label',null,'direct-link'),link=element('input','','ui-input');link.setAttribute('aria-label','Invite link');link.autocomplete='off';link.spellcheck=false;link.value=inviteText;link.oninput=()=>inviteText=link.value;linkLabel.append(element('span','Invite link'),link);dialog.append(linkLabel);
  const linkActions=element('div',null,'direct-actions'),copy=button('Copy invite',async()=>{await navigator.clipboard.writeText(inviteText);feedback='Invite copied. Send it through a trusted private channel.';renderStatus();}),join=button('Join invite',async()=>{
   const invitation=parseInvite(inviteText);
   if(invitation.lineage!==context.doc.getMap('meta').get('lineageId')){const job=attempt();renderStatus();await requireDirectSupport();if(!current(job))return;await context.joinProject(invitation,{endpoint,bearer,name},job.controller);}else await start(invitation);
  });linkActions.append(copy,join);dialog.append(linkActions);
  const live=element('p',null,'direct-status');live.setAttribute('role','status');live.setAttribute('aria-label','Direct session status');dialog.append(live);
  const participants=element('div',null,'direct-peer-list');participants.setAttribute('aria-label','Participants');dialog.append(participants);
  const requestList=element('div',null,'direct-requests');dialog.append(requestList);
  const leave=button('Leave session',()=>{cancel();status={message:'Left session. Your local copy remains on this device.',peers:[]};requests.clear();renderStatus();avatars();});
  const retry=button('Rejoin',()=>start(session?.invitation||parseInvite(inviteText)));const bottom=element('div',null,'direct-actions');bottom.append(retry,leave);dialog.append(bottom);
  renderStatus=()=>{
   if(!dialog)return;setup.hidden=!!session;
   // Offered once sessions are off, which already stops all direct-session activity.
   keyRow.hidden=!directKeyPresent()||enabled||!!session||!!pending;keyNote.textContent='Direct sessions are off: nothing is signed or shared. The signing key is kept for turning them on again.';
   inviteNote.hidden=enabled||!inviteText;
   const counts=enabled&&!session?context.earlier?.():null,notes=[];
   if(counts?.decisions)notes.push(`${counts.decisions===1?'1 review decision':counts.decisions+' review decisions'} in this project ${counts.decisions===1?'was':'were'} made before this browser signed decisions. Others will see ${counts.decisions===1?'it':'them'} as unverified, never as approvals.`);
   if(counts?.records)notes.push(`${counts.records===1?'1 earlier record':counts.records+' earlier records'} of yours (comments, replies, reviews) will show to others as claimed by you, not verified.`);
   if(counts?.others)notes.push(`${counts.others===1?'1 record':counts.others+' records'} by other people ${counts.others===1?'is':'are'} unsigned and will show as unverified.`);
   earlier.textContent=notes.join(' ');earlier.hidden=!notes.length;bottom.hidden=!session&&!inviteText&&!pending;live.textContent=[refusal,feedback,status.message].filter(Boolean).join('\n');link.value=inviteText;link.readOnly=!!session;create.disabled=!enabled||!!session||!!refusal;clean.disabled=!enabled||!!session||!!refusal;join.disabled=!enabled||!!session||!!refusal;copy.disabled=!session;retry.disabled=!enabled||!inviteText||!!refusal;leave.disabled=!session&&!pending;
   form.querySelectorAll('input').forEach(input=>input.disabled=!enabled||!!session);
   participants.replaceChildren();for(const peer of status.peers){const row=element('div',null,'direct-peer'),avatar=element('span',peer.name.slice(0,1).toUpperCase(),'direct-avatar'),info=element('div');info.append(element('strong',(peer.kind==='agent'?'Agent · ':'')+peer.name),element('span',peer.status,'direct-help'));if(peer.code)info.append(element('code',peer.code,'direct-code'));row.dataset.offerer=String(peer.offerer);row.dataset.elapsedMs=String(peer.elapsedMs||'');row.append(avatar,info);
    if(peer.code&&!peer.verified){const verify=button('Codes match',()=>session.verify(peer.id)),pin=button('Match and pin',()=>session.verify(peer.id,true));verify.disabled=pin.disabled=peer.status!=='Compare code';row.append(verify,pin);}participants.append(row);
   }
   requestList.replaceChildren();for(const [id,{request,author}]of requests){const row=element('div',null,'direct-request');const clip=text=>text.length>160?text.slice(0,160)+'…':text;row.append(element('p',`${author.displayName} asks you to ${request.command.op==='suggestion.accept'?'accept':'reject'} ${requestedIds(request.command).length===1?'this suggestion':`these ${requestedIds(request.command).length} suggestions`}.`));for(const suggestionId of requestedIds(request.command).slice(0,5)){const s=context.doc.getMap('suggestions').get(suggestionId);row.append(element('p',`“${clip(s?.before||'')}” → “${clip(s?.after||'')}”`,'direct-help'));}row.append(button('Approve request',async()=>{const receipt=await context.decide(request.command);if(!receipt.ok)throw Error(receipt.error.message);requests.delete(id);feedback='Authority decision saved locally.';renderStatus();}),button('Dismiss request',()=>{requests.delete(id);renderStatus();}));requestList.append(row);}
  };
  // Turning sessions on is the consent that creates this browser's signing key; the
  // workspace may reopen the project under the key-derived author ID and show Share again.
  check.onchange=async()=>{
   if(!check.checked){enabled=false;setDirectEnabled(false);context.onEnabled?.(false);cancel();status={message:'Direct sessions are off',peers:[]};avatars();renderStatus();return;}
   check.disabled=true;refusal='';feedback='';renderStatus();
   try{if(context.enable)await context.enable({invite:inviteText});else setDirectEnabled(true);}
   catch(error){if(closed)return;check.checked=false;check.disabled=false;refusal=error.message;renderStatus();return;}
   if(closed)return;check.disabled=false;enabled=true;context.onEnabled?.(true);renderStatus();checkSupport();
  };
  removeKey.onclick=async()=>{
   const confirmed=await openPrompt({title:'Delete signing key?',message:'This browser forgets its direct-session key and pinned contacts, and sessions turn off. Records it already signed stay verifiable by others. Turning sessions on again makes a new key; your earlier records are then claimed by it, not verified.',label:'Delete key',danger:true,anchor:removeKey});
   if(!confirmed)return;
   try{enabled=false;setDirectEnabled(false);context.onEnabled?.(false);cancel();status={message:'Direct sessions are off',peers:[]};avatars();await context.deleteKey?.();feedback='Signing key deleted. Direct sessions are off.';}catch(error){feedback=error.message;}
   if(!closed)renderStatus();
  };
  dialog.addEventListener('cancel',e=>{e.preventDefault();popup?.close('now');});
  // Closing keeps every field, the session and pending requests: they live in this closure.
  // The top-bar Share button shows only once sessions are on; otherwise Share opens from More tools.
  const visibleToggle=document.getElementById('direct-share-toggle');
  popup=openDialog(dialog,{anchor:visibleToggle&&!visibleToggle.hidden?visibleToggle:document.querySelector('.tools-toggle')||visibleToggle,onClose(){dialog?.close();dialog?.remove();dialog=null;popup=null;renderStatus=()=>{};}});
  renderStatus();check.focus();checkSupport();
 }
 return{show,toggle(){if(popup)popup.close('now');else show();},offerInvite(text){if(session)return;inviteText=text;show();renderStatus();},async start(invitation,config){({endpoint,bearer,name}=config);enabled=true;setDirectEnabled(true);context.onEnabled?.(true);show();await start(invitation);},async requestDecision(command){
  const ids=requestedIds(command),authorities=new Set(ids.map(id=>context.doc.getMap('reviews').get(context.doc.getMap('suggestions').get(id)?.reviewId)?.acceptanceAuthorityId));
  if(authorities.size!==1||!session)throw Error('Waiting for acceptance authority. Start a direct session with that profile.');
  await session.requestDecision([...authorities][0],{id:crypto.randomUUID(),command});feedback='Waiting for acceptance authority. The authority sees this request in Share.';renderStatus();return{ok:true,value:{status:status.message}};
 },close(handoff){closed=true;if(pending===handoff)pending=null;cancel();popup?.close('none');status.peers=[];avatars();}};
}
