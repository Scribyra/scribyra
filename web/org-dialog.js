// "Remote backup" dialog: an end-to-end encrypted organisation on a Scribyra deployment. It starts
// from the deployment's address and its "Sign in with …" buttons; the first administrator then
// creates the organisation, others ask to join and wait for an administrator, and a member's new
// browser asks one of their devices (or uses their recovery kit). Then: keep a recovery kit, back
// up and share projects, manage members and devices.
import {openDialog} from './menu.js';
import {STATUS_TEXT,MODE_TEXT} from './org-backup.js';
import {MODE_TEXT as SERVER_MODE_TEXT,forgetServerSignIn} from './org-server.js';
import './org-dialog.css';

const element=(tag,text,cls)=>{const node=document.createElement(tag);if(text)node.textContent=text;if(cls)node.className=cls;return node;};
const ROLE_LABEL={owner:'Owner',admin:'Admin',member:'Member',editor:'Editor',reviewer:'Reviewer',viewer:'Viewer'};
const POLL_MS=3000;

export function orgDialog({engine,server,anchor,listProjects,prefill={},onRestored=()=>{},onChanged=()=>{}}){
 let dialog,session,busy=false,feedback='',kit='',remaining=0,render=()=>{},poll=0,shown=null,drawing=null,redraw=false,offered=null,about=null,providers=null;
 const close=()=>session?.close('now');
 function button(label,fn,cls='secondary'){
  const b=element('button',label,'button compact '+cls);b.type='button';
  b.onclick=async()=>{if(busy)return;busy=true;feedback='';render();try{await fn();}catch(error){feedback=error?.message||String(error);}finally{busy=false;render();}};
  b.disabled=busy;return b;
 }
 function textArea(label,placeholder,value=''){
  const row=element('label',null,'org-field'),input=element('textarea','','ui-input');
  input.rows=3;input.spellcheck=false;input.autocomplete='off';input.placeholder=placeholder;input.setAttribute('aria-label',label);input.value=value;
  row.append(element('span',label),input);return{row,input};
 }
 function field(label,value='',type='text'){
  const row=element('label',null,'org-field'),input=element('input','','ui-input');
  input.type=type;input.value=value;input.autocomplete='off';input.setAttribute('aria-label',label);
  row.append(element('span',label),input);return{row,input};
 }
 function select(label,options,value){
  const row=element('label',null,'org-field'),input=element('select','','ui-input');input.setAttribute('aria-label',label);
  for(const [v,text] of options){const o=element('option',text);o.value=v;input.append(o);}if(value)input.value=value;
  row.append(element('span',label),input);return{row,input};
 }
 // What someone types or chooses survives redraws (sync status, the long poll, `online`): the
 // connected view, rebuilt on each, reuses the same controls (made once per key) instead of copying
 // values into new ones, and the control being typed in gets its focus and caret back after the
 // move (moving a node drops them; keys typed meanwhile would go nowhere).
 const kept=new Map();let used=new Set(),refocus=null;
 function keep(key,make){
  let made=kept.get(key);if(!made)kept.set(key,made=make());
  else if(!refocus)for(const control of Object.values(made))if(control?.input===document.activeElement)refocus=caret(control.input);
  used.add(key);return made;
 }
 /** Puts the focus and selection back in `input` once it is in the page again. */
 function caret(input){
  let start=null,end=null,direction;try{({selectionStart:start,selectionEnd:end,selectionDirection:direction}=input);}catch{}
  return()=>{if(!input.isConnected||document.activeElement===input)return;input.focus({preventScroll:true});if(start!==null)try{input.setSelectionRange(start,end,direction);}catch{}};
 }
 /** The same, for the field being typed in now (if any) before the body is redrawn at once. */
 function typing(){const active=document.activeElement;return body.contains(active)&&active.matches('input,textarea,select')?caret(active):()=>{};}
 function check(label,checked=false){const row=element('label',null,'org-check'),box=element('input');box.type='checkbox';box.checked=checked;row.append(box,element('span',label));return{row,box};}
 function actions(...buttons){const a=element('div',null,'org-actions');a.append(...buttons);return a;}
 function section(title,...nodes){const s=element('section',null,'org-section');s.append(element('h3',title),...nodes);return s;}
 function download(text){
  const url=URL.createObjectURL(new Blob([text],{type:'text/plain'})),a=element('a');a.href=url;a.download='scribyra-recovery-kit.txt';
  document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);
 }
 async function sso(service,provider,purpose='connect'){forgetServerSignIn();const url=await engine.ssoBegin({service,provider,purpose});location.assign(url);}
 /** One "Sign in with …" button per provider of a deployment. */
 const signInButtons=(service,list,purpose,again='')=>list.map(p=>button(`Sign in with ${p.label}${again}`,()=>sso(service,p.id,purpose),'primary'));

 dialog=element('dialog',null,'ui-popup org-dialog');dialog.setAttribute('aria-label','Remote backup');dialog.tabIndex=-1;
 const heading=element('div',null,'org-heading');heading.append(element('h2','Remote backup','ui-prompt-title'));
 const x=element('button','×','icon-button');x.type='button';x.setAttribute('aria-label','Close remote backup');x.onclick=close;heading.append(x);
 const body=element('div',null,'org-body'),status=element('p',null,'org-status');status.setAttribute('role','status');
 dialog.append(heading,body,status);

 // Not connected: a deployment's address, its sign-in, then create, join, add this browser or restore.
 const address=field('Deployment address',prefill.service||'','url'),creatorName=field('Your name','');
 const recovery=textArea('Recovery kit','scribyra-recovery:1:…');
 const kitText=element('pre',null,'org-kit');kitText.setAttribute('aria-label','Recovery kit');kitText.tabIndex=0;
 const saved=check('I have saved my recovery kit somewhere safe');saved.box.onchange=()=>render();
 const report=result=>{
  const names=result.restored.map(r=>r.name);
  feedback=(names.length?`Restored ${names.length===1?'1 project':names.length+' projects'}: ${names.join(', ')}.`:'No backed-up projects were found.')+(result.failures.length?` ${result.failures.length} could not be restored: ${result.failures.join(' ')}`:'');
 };
 async function joined(result){
  onChanged();
  if(result.admitted){feedback='You joined the organisation.';if(engine.needsKit)kit=await engine.replaceRecoveryKit().catch(()=>'');}
  else feedback='Waiting for an administrator (or your other device) to let this browser in.';
 }
 // Let in after waiting: a new member makes their recovery kit; an added device keeps the person's.
 async function admittedNow(){onChanged();feedback='This browser is now connected.';if(engine.needsKit)kit=await engine.replaceRecoveryKit().catch(()=>'');}
 /** After signing in: what this account can do here (create, ask to join, add this browser). */
 async function signedIn(){
  const login=engine.ssoLogin();if(!login)return;
  if(login.state==='blocked'){feedback='Your organisation’s sign-in is disabled for you.';return;}
  about=await engine.about();
  // Someone without a person here asks to join at once (when the organisation exists).
  if(login.state==='unlinked'&&about.genesis)await joined(await engine.requestJoin());
 }

 function notConnected(){
  if(engine.waiting){
   body.append(element('p','This browser asked to join and is waiting to be let in.','org-help'));
   if(engine.linkCode)body.append(element('p','Type this code on your other device:','org-help'),element('p',engine.linkCode,'org-code'));
   body.append(actions(button('Check again',async()=>{const admitted=await engine.checkAdmission();if(admitted)await admittedNow();}),button('Cancel',async()=>{await engine.forget();onChanged();})));
   return;
  }
  const login=engine.ssoLogin();
  if(login){
   if(!about&&login.state!=='blocked'){void engine.about().then(a=>{about=a;render();}).catch(error=>{feedback=error.message;render();});return;}
   const who=login.subject?.email||login.subject?.name||'your account';
   body.append(element('p',`${login.name||'Organisation'} · ${login.service}`,'org-service'),element('p',`Signed in as ${who}.`,'org-help'));
   if(login.state==='linked'){
    body.append(section('Add this browser',element('p','One of your devices that is already connected adds it: it asks you for the code this browser shows.','org-help'),
     actions(button('Ask one of my devices',async()=>{await engine.requestDevice();onChanged();feedback='On one of your devices, open Remote backup and type the code this browser shows.';},'primary'))));
    body.append(section('Restore with your recovery kit',element('p','Paste your recovery kit to add this browser and restore every backed-up project.','org-help'),recovery.row,
     actions(button('Restore projects',async()=>{
      const result=await engine.restore(recovery.input.value);recovery.input.value='';onChanged();
      report(result);remaining=(await engine.unrestored()).length;onRestored(result);
     },'primary'))));
   }else if(login.state==='unlinked'&&!about?.genesis){
    if(login.role==='admin'){
     creatorName.input.value||=login.subject?.name||'';
     body.append(section('Create the organisation',element('p',`You are an administrator of ${login.name||'this deployment'}. Creating its organisation makes keys in this browser; others then sign in and ask to join, and you approve them.`,'org-help'),creatorName.row,
      actions(button('Create organisation',async()=>{kit=await engine.create({name:login.name,ownerName:creatorName.input.value||'Owner'});onChanged();},'primary'))));
    }else body.append(element('p',`${login.name||'This organisation'} is not set up yet. An administrator signs in first to create it; then sign in again here.`,'org-help'));
   }else if(login.state==='unlinked')body.append(actions(button('Ask to join',async()=>joined(await engine.requestJoin()),'primary')));
   body.append(actions(button('Use another account',async()=>{engine.forgetLogin();about=null;})));
   return;
  }
  body.append(element('p','Back up and share projects with your organisation’s Scribyra deployment. Nothing is sent until you sign in.','org-help'));
  const connect=section('Connect to your organisation',element('p','Enter the address your organisation gave you, then sign in with your organisation’s account. New people ask an administrator to let them in; members add this browser from one of their devices or with their recovery kit.','org-help'),address.row,
   actions(button('Continue',async()=>{offered=await engine.deployment(address.input.value);},'primary')));
  body.append(connect);
  if(offered){
   const readable=offered.encryption==='server',choose=section(offered.name,element('p',readable?SERVER_MODE_TEXT(offered.name):MODE_TEXT[offered.encryption]||'','org-help org-mode'));
   // A server-readable deployment signs in through its own engine (web/org-server.js).
   if(readable)choose.append(actions(...offered.providers.map(p=>button(`Sign in with ${p.label}`,async()=>{location.assign(await server().ssoBegin({service:offered.service,provider:p.id}));},'primary'))));
   else choose.append(actions(...signInButtons(offered.service,offered.providers,'connect')));
   body.append(choose);
  }
 }

 async function connected(){
  const info=engine.info,drawn=used=new Set(),[name,members,orgProjects,local,links,devices,requests]=await Promise.all([
   engine.orgName(),engine.members(),engine.projects(),listProjects(),engine.links(),engine.devices(),engine.deviceRequests().catch(()=>[])]);
  const linked=new Map(links.map(l=>[l.localId,l])),admin=['owner','admin'].includes(info.role),parts=[];
  parts.push(element('p',`${name||info.name||'Organisation'} · ${info.service}`,'org-service'),element('p',MODE_TEXT.e2ee,'org-help org-mode'));
  if(info.ssoNeeded){
   providers??=await engine.deploymentInfo().then(d=>d.providers).catch(()=>info.provider?[{id:info.provider,label:info.providerLabel||'your organisation'}]:[]);
   parts.push(actions(...signInButtons(info.service,providers,'signin',' again')),element('p','Sign in again to keep syncing. Your projects stay on this device.','org-help'));
  }else parts.push(actions(button('Sign out',()=>engine.signOut())));
  // Projects: local ones (back up, share) and ones shared with this person (download).
  const list=element('ul',null,'org-projects');list.setAttribute('aria-label','Projects and their backup state');
  const byProject=new Map(orgProjects.map(p=>[p.project,p]));
  for(const project of local){
   const row=element('li',null,'org-project'),s=engine.status(project.id),link=linked.get(project.id);
   row.append(element('span',project.name,'org-name'));
   const label=element('span',link?(s?.label||STATUS_TEXT['backing-up']):'Only on this device','org-state');if(s?.message)label.title=s.message;row.append(label);
   if(!link)row.append(button('Back up',()=>engine.backUp(project.id).then(onChanged)));
   else{
    if(s&&!['backed-up','synced','backing-up','read-only'].includes(s.state))row.append(button('Retry',()=>engine.push(project.id)));
    const shared=byProject.get(link.project);
    if(shared?.role==='editor')row.append(button('Share',async()=>{shown=shown===link.project?null:link.project;}));
    if(shown===link.project&&shared)row.append(shareForm(shared,members));
   }
   if(s?.message&&!['backed-up','synced'].includes(s.state))row.append(element('p',s.message,'org-help org-why'));
   list.append(row);
  }
  for(const project of orgProjects.filter(p=>!p.localId)){
   const row=element('li',null,'org-project');
   row.append(element('span',project.name,'org-name'),element('span',`Shared with you · ${ROLE_LABEL[project.role]}`,'org-state'));
   if(project.held)row.append(button('Download',async()=>{const result=await engine.download(project.project);onChanged();feedback=result?`Downloaded ${result.name}.`:'This project has no changes yet.';}));
   list.append(row);
  }
  if(!local.length&&!orgProjects.length)list.append(element('li','No projects yet.','org-help'));
  parts.push(section('Projects',list));
  if(remaining){parts.push(element('p',`${remaining===1?'1 project was':remaining+' projects were'} not restored yet.`,'org-help'),actions(button('Restore remaining projects',async()=>{const result=await engine.restoreRemaining();report(result);remaining=(await engine.unrestored()).length;onChanged();onRestored(result);})));}
  // Members.
  const people=element('ul',null,'org-members');people.setAttribute('aria-label','Members');
  for(const m of members){
   const row=element('li',null,'org-member');
   row.append(element('span',m.me?`${m.name} (you)`:m.name,'org-name'),element('span',m.state==='pending'?'Waiting for approval':ROLE_LABEL[m.role],'org-state'));
   if(admin&&!m.me){
    if(m.state==='pending')row.append(button('Approve',()=>engine.approve(m.person,'member'),'primary'),button('Decline',()=>engine.removePerson(m.person)));
    else{
     if(m.role!=='owner'||info.role==='owner')row.append(button(m.role==='member'?'Make admin':'Make member',()=>engine.setRole(m.person,m.role==='member'?'admin':'member')));
     row.append(button('Remove',()=>engine.removePerson(m.person)));
    }
   }
   people.append(row);
  }
  const memberParts=[people,element('p',`New people sign in at ${info.service} and ask to join; ${admin?'approve them here, then share projects with them':'an administrator approves them'}.`,'org-help')];
  if(admin)memberParts.push(element('p','Removing someone tells the service to stop their access at once, and the projects they could read get a new key before anyone writes to them again, so nothing written after the removal is readable with the keys they kept. What they already downloaded stays with them.','org-help'));
  parts.push(section('Members',...memberParts));
  // This person's devices.
  const own=element('ul',null,'org-devices');own.setAttribute('aria-label','Your devices');
  for(const d of devices){const row=element('li',null,'org-device');row.append(element('span',d.me?`This browser (${d.short})`:`Device ${d.short}`,'org-name'));if(!d.me)row.append(button('Remove',()=>engine.removeDevice(d.key)));own.append(row);}
  const deviceParts=[own,element('p','To add another browser, sign in there and choose “Ask one of my devices”; it then appears here.','org-help')];
  for(const r of requests){
   // The service only says who signed in; the code typed here proves which browser it is. A
   // refused code is cleared, as someone retypes it: no redraw brings it back.
   const row=element('div',null,'org-request'),{typed}=keep('code:'+r.link,()=>({typed:field('Code shown on the new browser')}));
   row.append(element('p',`A browser that signed in with your organisation (the service says: ${r.email||'you'}) asks to be added.`,'org-help'),typed.row,actions(button('Add this device',async()=>{
    try{await engine.approveDevice(r,{code:typed.input.value});}catch(error){typed.input.value='';throw error;}
   },'primary')));
   deviceParts.push(row);
  }
  parts.push(section('Your devices',...deviceParts));
  parts.push(actions(button('New recovery kit',async()=>{kit=await engine.replaceRecoveryKit();saved.box.checked=false;}),button('Forget service',async()=>{await engine.forget();remaining=0;onChanged();feedback='This browser no longer backs up. Your local projects and the service’s copies are unchanged.';})));
  for(const key of kept.keys())if(!drawn.has(key))kept.delete(key);
  return parts;
 }
 function shareForm(project,members){
  const others=members.filter(m=>!m.me&&m.state==='active'&&!project.members.some(x=>x.person===m.person));
  const box=element('div',null,'org-share');
  if(!others.length){box.append(element('p','Everyone in the organisation already has access. New people sign in and ask to join first.','org-help'));return box;}
  const {who,role}=keep(`share:${project.project}:${others.map(m=>m.person).join()}`,()=>({who:select('Share with',others.map(m=>[m.person,m.name])),role:select('Role',[['editor','Editor'],['reviewer','Reviewer'],['viewer','Viewer']],'editor')}));
  box.append(who.row,role.row,actions(button('Share project',async()=>{await engine.grant(project.project,who.input.value,role.input.value);shown=null;feedback='Shared.';},'primary')));
  return box;
 }

 render=()=>{
  if(!dialog)return;
  const scroll=dialog.scrollTop,back=kit||!engine.connected?typing():()=>{};
  // The connected view is built asynchronously and replaces the body when it is ready; the others
  // are drawn at once.
  if(kit||!engine.connected)body.replaceChildren();
  if(kit){
   body.append(element('p','Save this recovery kit now. It is the only way to restore your backups if this browser’s data is lost. It stays here until you confirm you saved it; you can make a new one later, which replaces it.','org-help'),kitText);
   kitText.textContent=kit;
   const done=button('Done',async()=>{await engine.confirmKit();kit='';});done.disabled=!saved.box.checked||busy;
   body.append(actions(button('Download kit',()=>download(kit)),button('Copy kit',()=>navigator.clipboard.writeText(kit))),saved.row,done);
  }else if(!engine.connected)notConnected();
  else if(drawing)redraw=true;
  // One query of the service at a time; changes that arrive meanwhile redraw once afterwards.
  else drawing=connected().then(parts=>{if(dialog&&engine.connected&&!kit){body.replaceChildren(...parts);dialog.scrollTop=scroll;refocus?.();keepFocus();}}).catch(error=>{feedback=error.message;status.textContent=feedback;}).finally(()=>{drawing=null;refocus=null;if(redraw){redraw=false;render();}});
  status.textContent=busy?'Working…':feedback;
  back();keepFocus();
 };
 // Redrawing removes the focused control; keep focus in the dialog so the keyboard (Escape,
 // Tab) still works.
 function keepFocus(){if(dialog&&(!document.activeElement||document.activeElement===document.body))dialog.focus({preventScroll:true});}
 session=openDialog(dialog,{anchor,onClose(){clearInterval(poll);dialog.remove();dialog=null;}});
 render();
 // A kit that was not confirmed as saved, or a restore that stopped early, is offered again.
 if(engine.connected)void Promise.all([engine.pendingKit(),engine.unrestored()]).then(([pending,left])=>{kit||=pending;remaining=left.length;render();}).catch(()=>{});
 // A browser waiting to be let in checks again on its own while the dialog is open.
 poll=setInterval(()=>{if(engine.waiting&&!busy)void engine.checkAdmission().then(async admitted=>{if(admitted){await admittedNow();render();}}).catch(()=>{});},POLL_MS);
 // Coming back from the organisation's sign-in page: finish it and carry on with what started it.
 if(prefill.ssoCode)void (async()=>{
  busy=true;render();
  try{
   await engine.ssoFinish(prefill.ssoCode);
   if(engine.connected)feedback='Signed in with your organisation.';
   else await signedIn();
   onChanged();
  }catch(error){feedback=error?.message||String(error);}
  finally{busy=false;render();}
 })();
 return{render:()=>render(),close};
}
