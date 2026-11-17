// "Remote backup" dialog: organisations on a self-hosted Scribyra service. Create one with an
// operator's setup code (name, encryption mode, admin read access), join with an invitation or
// the organisation's single sign-on, link another browser, keep a recovery kit, back up and share
// projects, manage members and devices, or restore from a kit.
import {openDialog} from './menu.js';
import {STATUS_TEXT,MODE_TEXT} from './org-backup.js';
import './org-dialog.css';

const element=(tag,text,cls)=>{const node=document.createElement(tag);if(text)node.textContent=text;if(cls)node.className=cls;return node;};
const ROLE_LABEL={owner:'Owner',admin:'Admin',member:'Member',editor:'Editor',reviewer:'Reviewer',viewer:'Viewer'};
const POLL_MS=3000;

export function orgDialog({engine,anchor,listProjects,prefill={},onRestored=()=>{},onChanged=()=>{}}){
 let dialog,session,busy=false,feedback='',kit='',remaining=0,render=()=>{},poll=0,shown=null,deviceLink='',inviteLink='',drawing=null,redraw=false;
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
 function check(label,checked=false){const row=element('label',null,'org-check'),box=element('input');box.type='checkbox';box.checked=checked;row.append(box,element('span',label));return{row,box};}
 function actions(...buttons){const a=element('div',null,'org-actions');a.append(...buttons);return a;}
 function section(title,...nodes){const s=element('section',null,'org-section');s.append(element('h3',title),...nodes);return s;}
 function download(text){
  const url=URL.createObjectURL(new Blob([text],{type:'text/plain'})),a=element('a');a.href=url;a.download='scribyra-recovery-kit.txt';
  document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);
 }
 function linkBox(label,text){const box=textArea(label,'',text);box.input.readOnly=true;return box.row;}
 async function sso(service,org,purpose,carry){const url=await engine.ssoBegin({service,org,purpose,carry});location.assign(url);}

 dialog=element('dialog',null,'ui-popup org-dialog');dialog.setAttribute('aria-label','Remote backup');dialog.tabIndex=-1;
 const heading=element('div',null,'org-heading');heading.append(element('h2','Remote backup','ui-prompt-title'));
 const x=element('button','×','icon-button');x.type='button';x.setAttribute('aria-label','Close remote backup');x.onclick=close;heading.append(x);
 const body=element('div',null,'org-body'),status=element('p',null,'org-status');status.setAttribute('role','status');
 dialog.append(heading,body,status);

 // Not connected: create, join, sign in, link, restore.
 const setup=textArea('Setup code','scribyra-setup:1:…'),orgName=field('Organisation name','Personal'),ownerName=field('Your name','');
 const modeE2ee=check('End-to-end encrypted',true),modeManaged=check('Organisation-managed',false),adminRead=check('Administrators can read every project',true);
 modeE2ee.box.type=modeManaged.box.type='radio';modeE2ee.box.name=modeManaged.box.name='org-mode';
 const invite=textArea('Invitation link','https://…/#join=…',prefill.invite||''),joinName=field('Your name for this organisation','');
 const orgLink=textArea('Organisation link','https://…/#org=…',prefill.org||''),deviceText=textArea('Device link','https://…/#device=…',prefill.device||'');
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
 // Let in after waiting: a new member makes their recovery kit; a linked device keeps the person's.
 async function admittedNow(){onChanged();feedback='This browser is now connected.';if(engine.needsKit)kit=await engine.replaceRecoveryKit().catch(()=>'');}

 function notConnected(){
  if(engine.waiting){
   body.append(element('p','This browser asked to join and is waiting to be let in.','org-help'));
   if(engine.linkCode)body.append(element('p',engine.linkCode.includes('-')?'Type this code on your other device:':'Check that your other device shows this code:','org-help'),element('p',engine.linkCode,'org-code'));
   body.append(actions(button('Check again',async()=>{const admitted=await engine.checkAdmission();if(admitted)await admittedNow();}),button('Cancel',async()=>{await engine.forget();onChanged();})));
   return;
  }
  body.append(element('p','Back up and share projects with a Scribyra service you or your organisation run. Nothing is sent until you choose to.','org-help'));
  const create=section('Create an organisation',element('p','Paste the setup code from “scribyra-sync org create”. This creates keys in this browser.','org-help'),setup.row,orgName.row,ownerName.row,
   element('p','Encryption','org-label'),modeE2ee.row,element('p',MODE_TEXT.e2ee,'org-help org-mode'),modeManaged.row,element('p',MODE_TEXT.managed,'org-help org-mode'),adminRead.row,
   actions(button('Connect',async()=>{
    kit=await engine.connect(setup.input.value,{name:orgName.input.value||'Personal',ownerName:ownerName.input.value||'Owner',mode:modeManaged.box.checked?'managed':'e2ee',adminRead:adminRead.box.checked});
    setup.input.value='';onChanged();
   },'primary')));
  const join=section('Join with an invitation',invite.row,joinName.row,actions(
   button('Join',async()=>{
    try{await joined(await engine.join(invite.input.value,{name:joinName.input.value||'Member'}));invite.input.value='';}
    catch(error){if(!error.sso)throw error;const about=await engine.describeInvite(invite.input.value);feedback=error.message;await sso(about.service,about.org,'join',{invite:invite.input.value,name:joinName.input.value||'Member'});}
   },'primary'),
   button('Sign in with your organisation',async()=>{const about=await engine.describeInvite(invite.input.value);await sso(about.service,about.org,'join',{invite:invite.input.value,name:joinName.input.value||'Member'});})));
  const signIn=section('Sign in with your organisation (SSO)',element('p','Paste your organisation’s link. New people ask an administrator to let them in; members add this browser.','org-help'),orgLink.row,
   actions(button('Sign in with your organisation',async()=>{const {parseOrgLink}=await import('./org-crypto.js');const link=parseOrgLink(orgLink.input.value);await sso(link.service,link.org,'org',{org:orgLink.input.value});},'primary')));
  const link=section('Add this browser to your account',element('p','On a device that is already connected, choose “Link a device”, then paste the link here.','org-help'),deviceText.row,
   actions(button('Link this browser',async()=>{await engine.acceptDeviceLink(deviceText.input.value);deviceText.input.value='';onChanged();},'primary')));
  const restore=section('Restore on a new browser',element('p','Paste your recovery kit to restore every backed-up project into this browser.','org-help'),recovery.row,
   actions(button('Restore projects',async()=>{
    const result=await engine.restore(recovery.input.value);recovery.input.value='';onChanged();
    report(result);remaining=(await engine.unrestored()).length;onRestored(result);
   },'primary')));
  // An invitation or link that opened the dialog goes first.
  const order=prefill.invite?[join,create,signIn,link,restore]:prefill.device?[link,create,join,signIn,restore]:prefill.org?[signIn,create,join,link,restore]:[create,restore,join,signIn,link];
  body.append(...order);
 }

 async function connected(){
  const info=engine.info,[name,members,orgProjects,local,links,devices,requests,policy]=await Promise.all([
   engine.orgName(),engine.members(),engine.projects(),listProjects(),engine.links(),engine.devices(),engine.deviceRequests().catch(()=>[]),engine.ssoPolicy()]);
  const linked=new Map(links.map(l=>[l.localId,l])),admin=['owner','admin'].includes(info.role),parts=[];
  parts.push(element('p',`${name||'Organisation'} · ${info.service}`,'org-service'),element('p',(info.mode==='managed'?MODE_TEXT.managed:MODE_TEXT.e2ee),'org-help org-mode'));
  if(info.adminRead)parts.push(element('p','This organisation’s administrators can read its projects.','org-help'));
  if(policy?.enabled){
   parts.push(info.ssoNeeded?actions(button('Sign in with your organisation',()=>sso(info.service,info.org,'signin',null),'primary')):actions(button('Sign out of your organisation',()=>engine.signOut())));
   if(info.ssoNeeded)parts.push(element('p','Sign in again to keep syncing. Your projects stay on this device.','org-help'));
  }
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
  const inviteRole=select('Invite as',[['member','Member'],['admin','Admin']],'member'),inviteProject=select('Share a project with them',[['','No project'],...orgProjects.filter(p=>p.role==='editor').map(p=>[p.project,p.name])],''),inviteProjectRole=select('Their role on it',[['editor','Editor'],['reviewer','Reviewer'],['viewer','Viewer']],'editor');
  const inviteApproval=check('Ask me to approve them',false),inviteSso=check('They must sign in with the organisation',!!policy?.required),inviteEmail=field('Their email at the organisation (optional)','','email');
  const inviteParts=[people];
  if(admin)inviteParts.push(element('p','Removing someone tells the service to stop their access at once, and the projects they could read get a new key before anyone writes to them again, so nothing written after the removal is readable with the keys they kept. What they already downloaded stays with them.','org-help'));
  inviteParts.push(inviteRole.row,inviteProject.row,inviteProjectRole.row,inviteApproval.row);
  if(policy?.enabled)inviteParts.push(inviteSso.row,inviteEmail.row);
  inviteParts.push(actions(button('Create invitation link',async()=>{
   inviteLink=await engine.createInvite({role:inviteRole.input.value,approval:inviteApproval.box.checked,sso:inviteSso.box.checked,email:inviteEmail.input.value,project:inviteProject.input.value||null,projectRole:inviteProject.input.value?inviteProjectRole.input.value:null});
   feedback='Send this link to the person you invite. It works once and expires in 7 days.';
  })));
  if(inviteLink)inviteParts.push(linkBox('Invitation link to send',inviteLink),actions(button('Copy link',()=>navigator.clipboard.writeText(inviteLink))));
  if(policy?.enabled&&admin)inviteParts.push(actions(button('Copy the organisation’s sign-in link',async()=>navigator.clipboard.writeText(await engine.orgLink()))));
  parts.push(section('Members',...inviteParts));
  // This person's devices.
  const own=element('ul',null,'org-devices');own.setAttribute('aria-label','Your devices');
  for(const d of devices){const row=element('li',null,'org-device');row.append(element('span',d.me?`This browser (${d.short})`:`Device ${d.short}`,'org-name'));if(!d.me)row.append(button('Remove',()=>engine.removeDevice(d.key)));own.append(row);}
  const deviceParts=[own,actions(button('Link a device',async()=>{deviceLink=await engine.linkDevice();feedback='Open this link on the new browser within 15 minutes.';}))];
  if(deviceLink)deviceParts.push(linkBox('Device link to open on the new browser',deviceLink));
  for(const r of requests){
   const row=element('div',null,'org-request');
   if(r.via==='sso'){
    // The service only says who signed in; the code typed here proves which browser it is.
    const typed=field('Code shown on the new browser','');
    row.append(element('p',`A browser that signed in with your organisation (the service says: ${r.email||'you'}) asks to be added.`,'org-help'),typed.row,actions(button('Add this device',()=>engine.approveDevice(r,{code:typed.input.value}),'primary')));
   }else row.append(element('p','A new browser answered your link. Check it shows this code:','org-help'),element('p',r.code,'org-code'),actions(button('Add this device',()=>engine.approveDevice(r),'primary')));
   deviceParts.push(row);
  }
  parts.push(section('Your devices',...deviceParts));
  parts.push(actions(button('New recovery kit',async()=>{kit=await engine.replaceRecoveryKit();saved.box.checked=false;}),button('Forget service',async()=>{await engine.forget();remaining=0;onChanged();feedback='This browser no longer backs up. Your local projects and the service’s copies are unchanged.';})));
  return parts;
 }
 function shareForm(project,members){
  const others=members.filter(m=>!m.me&&m.state==='active'&&!project.members.some(x=>x.person===m.person));
  const box=element('div',null,'org-share');
  if(!others.length){box.append(element('p','Everyone in the organisation already has access. Invite someone under Members.','org-help'));return box;}
  const who=select('Share with',others.map(m=>[m.person,m.name])),role=select('Role',[['editor','Editor'],['reviewer','Reviewer'],['viewer','Viewer']],'editor');
  box.append(who.row,role.row,actions(button('Share project',async()=>{await engine.grant(project.project,who.input.value,role.input.value);shown=null;feedback='Shared.';},'primary')));
  return box;
 }

 render=()=>{
  if(!dialog)return;
  const scroll=dialog.scrollTop;
  body.replaceChildren();
  if(kit){
   body.append(element('p','Save this recovery kit now. It is the only way to restore your backups if this browser’s data is lost. It stays here until you confirm you saved it; you can make a new one later, which replaces it.','org-help'),kitText);
   kitText.textContent=kit;
   const done=button('Done',async()=>{await engine.confirmKit();kit='';});done.disabled=!saved.box.checked||busy;
   body.append(actions(button('Download kit',()=>download(kit)),button('Copy kit',()=>navigator.clipboard.writeText(kit))),saved.row,done);
  }else if(!engine.connected)notConnected();
  else if(drawing)redraw=true;
  // One query of the service at a time; changes that arrive meanwhile redraw once afterwards.
  else drawing=connected().then(parts=>{if(dialog&&engine.connected&&!kit){body.replaceChildren(...parts);dialog.scrollTop=scroll;keepFocus();}}).catch(error=>{feedback=error.message;status.textContent=feedback;}).finally(()=>{drawing=null;if(redraw){redraw=false;render();}});
  status.textContent=busy?'Working…':feedback;
  keepFocus();
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
   const flow=await engine.ssoFinish(prefill.ssoCode);
   if(flow.purpose==='join')await joined(await engine.join(flow.carry.invite,{name:flow.carry.name}));
   else if(flow.purpose==='org'){
    if(flow.login.state==='linked'){await engine.requestDeviceBySso(flow.carry.org);feedback='On one of your devices, open Remote backup and type the code this browser shows.';}
    else if(flow.login.state==='blocked')feedback='Your organisation’s sign-in is disabled for you.';
    else{await joined(await engine.requestJoin(flow.carry.org));}
   }else feedback='Signed in with your organisation.';
   onChanged();
  }catch(error){feedback=error?.message||String(error);}
  finally{busy=false;render();}
 })();
 return{render:()=>render(),close};
}
