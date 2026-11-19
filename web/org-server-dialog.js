// The organisation dialog for a server-readable deployment (design section 9): who is signed in,
// their role (from the provider, read-only) and what the server can read, the organisation switcher
// when the account has roles in several organisations (design section 3), the active organisation's
// projects (on this device or to open from the server) with their sync state, "Add to <organisation>"
// for personal projects (not for guests), sharing by email invitation with a role, organisations
// whose access ended, and signing out.
import {openDialog} from './menu.js';
import {MODE_TEXT} from './org-server.js';
import {orgAdminDialog,adminNotice} from './org-admin-dialog.js';
import './org-dialog.css';

const element=(tag,text,cls)=>{const node=document.createElement(tag);if(text)node.textContent=text;if(cls)node.className=cls;return node;};
const ROLE_LABEL={owner:'Owner',editor:'Editor',reviewer:'Reviewer',viewer:'Viewer',admin:'Opened as administrator'};
const ROLES=[['editor','Editor'],['reviewer','Reviewer'],['viewer','Viewer']];
const ACCOUNT_ROLE={admin:'Administrator',member:'Member',guest:'Guest'};
const host=service=>{try{return new URL(service).host;}catch{return service;}};

export function orgServerDialog({engine,anchor,listProjects,prefill={},onChanged=()=>{},onOpen=async()=>{}}){
 let dialog,session,busy=false,feedback='',render=()=>{},drawing=null,redraw=false,shared=null;
 const choosing=new Map();
 const close=()=>session?.close('now');
 function button(label,fn,cls='secondary'){
  const b=element('button',label,'button compact '+cls);b.type='button';
  b.onclick=async()=>{if(busy)return;busy=true;feedback='';render();try{await fn();}catch(error){feedback=error?.message||String(error);}finally{busy=false;render();}};
  b.disabled=busy;return b;
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
 function check(label){const row=element('label',null,'org-check'),input=element('input');input.type='checkbox';input.setAttribute('aria-label',label);row.append(input,element('span',label));return{row,input};}
 const actions=(...buttons)=>{const a=element('div',null,'org-actions');a.append(...buttons);return a;};
 const section=(title,...nodes)=>{const s=element('section',null,'org-section');s.append(element('h3',title),...nodes);return s;};
 async function signInWith(provider){location.assign(await engine.ssoBegin({service:engine.info.service,provider}));}

 dialog=element('dialog',null,'ui-popup org-dialog');dialog.setAttribute('aria-label','Remote backup');dialog.tabIndex=-1;
 const heading=element('div',null,'org-heading');heading.append(element('h2','Remote backup','ui-prompt-title'));
 const x=element('button','×','icon-button');x.type='button';x.setAttribute('aria-label','Close remote backup');x.onclick=close;heading.append(x);
 const body=element('div',null,'org-body'),status=element('p',null,'org-status');status.setAttribute('role','status');
 dialog.append(heading,body,status);
 // What someone types or chooses survives redraws (the long poll, sync status): the view, rebuilt
 // on each, reuses the same controls (made once per key) instead of copying values into new ones,
 // and the control being typed in gets its focus and caret back after the move (moving a node
 // drops them; keys typed meanwhile would go nowhere).
 const kept=new Map();let used=new Set(),refocus=null;
 function keep(key,make){
  let made=kept.get(key);if(!made)kept.set(key,made=make());
  else if(!refocus)for(const control of Object.values(made))if(control?.input===document.activeElement)refocus=caret(control.input);
  used.add(key);return made;
 }
 function caret(input){
  let start=null,end=null,direction;try{({selectionStart:start,selectionEnd:end,selectionDirection:direction}=input);}catch{}
  return()=>{if(!input.isConnected||document.activeElement===input)return;input.focus({preventScroll:true});if(start!==null)try{input.setSelectionRange(start,end,direction);}catch{}};
 }

 async function shareBox(project){
  // Owners and editors share, except guests (design section 3).
  const [details,directory]=await Promise.all([engine.details(project.project),engine.directory().catch(()=>[])]),box=element('div',null,'org-share'),manage=['owner','editor'].includes(details.role)&&!engine.info.guest;
  const people=element('ul',null,'org-members');people.setAttribute('aria-label','People with access');
  for(const m of [details.owner,...details.members]){
   const row=element('li',null,'org-member'),who=m.email||m.name||'Someone';
   row.append(element('span',m.account===engine.info.account?`${who} (you)`:who,'org-name'));
   if(m.role==='owner'||!manage)row.append(element('span',ROLE_LABEL[m.role],'org-state'));
   else{
    const role=select(`Role for ${who}`,ROLES,m.role);role.row.querySelector('span').remove();
    role.input.onchange=async()=>{busy=true;render();try{await engine.setMemberRole(project.project,m.account,role.input.value);feedback=`${who} is now ${ROLE_LABEL[role.input.value].toLowerCase()}.`;}catch(e){feedback=e.message;}finally{busy=false;render();}};
    row.append(role.row,button('Remove',async()=>{await engine.removeMember(project.project,m.account);feedback=`${who} no longer has access.`;}));
   }
   people.append(row);
  }
  box.append(people);
  // Deployment `compile: both`: the project switch (owner and editors who are not guests; design section 6).
  if(engine.info.compile==='both'){
   const choose=manage&&engine.info.role!=='guest',group=element('fieldset',null,'org-compile');group.append(element('legend','Compile'));
   for(const [value,text] of [['browser','Compile in the browser'],['server','Compile on server']]){
    const label=element('label',null,'org-choice'),radio=element('input');radio.type='radio';radio.name=`compile-${project.project}`;radio.value=value;radio.checked=details.compile===value;radio.disabled=!choose||busy;
    radio.onchange=async()=>{if(!radio.checked)return;busy=true;render();try{await engine.setCompileMode(project.project,value);feedback=value==='server'?`${project.name} now compiles on ${engine.info.name}’s server.`:`${project.name} now compiles in the browser.`;}catch(e){feedback=e.message;}finally{busy=false;render();}};
    label.append(radio,element('span',text));group.append(label);
   }
   if(!choose)group.append(element('p',`${details.compile==='server'?'This project compiles on the server.':'This project compiles in the browser.'} Its owner and editors choose.`,'org-help'));
   box.append(group);
  }
  for(const a of details.adminActivity||[])box.append(element('p',adminNotice(a),'org-help org-admin-notice'));
  if(details.invitations?.length){
   const pending=element('ul',null,'org-members');pending.setAttribute('aria-label','Pending invitations');
   for(const i of details.invitations){
    const row=element('li',null,'org-member');row.append(element('span',i.email,'org-name'),element('span',`Invited as ${ROLE_LABEL[i.role].toLowerCase()}`,'org-state'));
    if(manage)row.append(button('Withdraw',async()=>{await engine.withdraw(project.project,i.id);feedback=`Invitation to ${i.email} withdrawn.`;}));
    pending.append(row);
   }
   box.append(pending);
  }
  if(manage){
   const {email,role,guest}=keep('invite:'+project.project,()=>({email:field('Email','','email'),role:select('Role',ROLES,'editor'),guest:check('Invite as a guest (someone the provider marks as a guest of this organisation)')}));
   // The organisation's directory (members and administrators; not for guests) fills in whom to invite.
   const listed=new Set([details.owner,...details.members].map(m=>m.email).filter(Boolean));
   const offered=directory.filter(m=>m.email&&!listed.has(m.email)).map(m=>[m.email,m.name?`${m.name} (${m.email})`:m.email]);
   if(offered.length){
    const {pick}=keep(`directory:${project.project}:${offered.map(([v])=>v).join()}`,()=>{const pick=select('From the directory',[['','Choose someone…'],...offered],'');pick.input.onchange=()=>{if(pick.input.value)email.input.value=pick.input.value;};return{pick};});
    box.append(pick.row);
   }
   const invited=async(address,result)=>{email.input.value='';guest.input.checked=false;choosing.delete(project.project);
    feedback=result.status==='pending'?`Invited ${address}. Ask them to sign in to ${engine.info.place}’s Scribyra; the project then appears in their list.`:`Shared with ${address}.`;};
   box.append(email.row,role.row,guest.row,actions(button('Invite',async()=>{
    const address=email.input.value.trim(),asked={role:role.input.value,guest:guest.input.checked};
    try{await invited(address,await engine.invite(project.project,address,asked.role,{guest:asked.guest}));}
    // Several accounts of this organisation have that verified email: the inviter chooses one.
    catch(error){if(error?.code!=='choose_account')throw error;choosing.set(project.project,{address,...asked,candidates:error.candidates});feedback=error.message;}
   },'primary')));
   const choice=choosing.get(project.project);
   if(choice){
    const options=choice.candidates.map(c=>[c.account,[c.name,c.email,c.role&&(ACCOUNT_ROLE[c.role]||c.role),c.provider].filter(Boolean).join(' · ')]);
    const {which}=keep(`account:${project.project}:${options.map(([v])=>v).join()}`,()=>({which:select(`Account to invite as ${choice.address}`,options)}));
    box.append(element('p',`Several accounts have ${choice.address}. Choose the one to invite:`,'org-help'),which.row,actions(
     button('Invite this account',async()=>{await invited(choice.address,await engine.invite(project.project,choice.address,choice.role,{guest:choice.guest,account:which.input.value}));},'primary'),
     button('Cancel',async()=>{choosing.delete(project.project);})));
   }
  }
  return box;
 }

 async function connected(){
  const info=engine.info,parts=[],drawn=used=new Set(),place=info.place;
  parts.push(element('p',`${info.name} · ${host(info.service)}`,'org-service'),element('p',MODE_TEXT(info.name),'org-help org-mode'));
  if(info.offline===false)parts.push(element('p',`${info.name} keeps projects online only: you edit while connected, and projects leave this device when you sign out.`,'org-help'));
  if(!info.signedIn){
   parts.push(element('p',`Sign in again to keep syncing.${info.offline===false?'':' Your projects stay on this device.'}`,'org-help'),
    actions(...(info.providers||[]).map(p=>button(`Sign in with ${p.label} again`,()=>signInWith(p.id),'primary'))),
    actions(button('Forget this deployment',async()=>{await engine.forget();onChanged();close();})));
   return parts;
  }
  const [projects,local]=await Promise.all([engine.projects(),listProjects()]);
  // The list may have changed the role (a refresh at the provider): show what holds now.
  const now=engine.info,role=now.role,provider=(now.providers||[]).find(p=>p.id===now.provider)?.label||now.label||'your sign-in provider';
  parts.push(element('p',`Signed in as ${now.email||now.accountName||'your account'}.`,'org-help'));
  // Organisations come from the provider; with several the person works in one at a time.
  if(now.orgs?.length>1){
   const choose=select('Organisation',now.orgs.map(o=>[o.id,o.guest?`${o.name} (guest)`:o.name]),now.active);
   choose.input.onchange=async()=>{const id=choose.input.value,name=now.orgs.find(o=>o.id===id)?.name;busy=true;render();try{await engine.setActive(id);shared=null;feedback=`Working in ${name}.`;onChanged();}catch(e){feedback=e.message;}finally{busy=false;render();}};
   choose.input.disabled=busy;parts.push(choose.row);
  }
  if(role)parts.push(element('p',`Your role in ${place}: ${ACCOUNT_ROLE[role]||role}, from ${provider}. Roles are granted in ${provider}.`,'org-help org-role'));
  if(role==='guest')parts.push(element('p',`As a guest you see only the projects shared with you in ${place}, and you cannot add projects.`,'org-help'));
  for(const e of now.ended||[])parts.push(element('p',`Your access to ${e.name} ended. ${now.offline===false?'Its projects were removed from this device.':'Its projects stay on this device and no longer sync.'}`,'org-help org-ended'));
  parts.push(actions(button('Sign out',async()=>{await engine.signOut();onChanged();feedback='Signed out.';}),
   // The admin area, for the active organisation's administrators only (the service refuses everyone else).
   ...(role==='admin'?[button('Admin',async()=>{close();orgAdminDialog({engine,anchor,onOpen,onChanged});})]:[])));
  const list=element('ul',null,'org-projects');list.setAttribute('aria-label',`Projects on ${place}`);
  for(const project of projects){
   const row=element('li',null,'org-project'),s=project.localId?engine.status(project.localId):null;
   row.append(element('span',project.name,'org-name'));
   const label=project.gone?'No longer shared with you':project.localId?(s?.label||'Saved on this device'):'Not on this device';
   const state=element('span',project.role&&project.role!=='owner'?`${label} · ${ROLE_LABEL[project.role]}`:label,'org-state');if(s?.message)state.title=s.message;row.append(state);
   row.append(button('Open',async()=>{
    let localId=project.localId;
    if(!localId){const result=await engine.download(project.project);if(!result)throw Error('This project has no changes yet.');localId=result.localId;onChanged();}
    close();await onOpen(localId);
   },project.localId?'secondary':'primary'));
   if(!project.gone&&project.role)row.append(button('Share',async()=>{shared=shared===project.project?null:project.project;}));
   if(s?.message&&!['synced'].includes(s.state))row.append(element('p',s.message,'org-help org-why'));
   if(project.adminOpened&&project.role!=='admin')row.append(element('p',adminNotice({action:'project.admin_open',time:project.adminOpened}),'org-help org-why org-admin-notice'));
   if(shared===project.project&&!project.gone)row.append(await shareBox(project));
   list.append(row);
  }
  if(!projects.length)list.append(element('li','No projects yet. Add one from this device below.','org-help'));
  parts.push(section('Projects',list));
  if(role!=='guest'){
   const linked=new Set(projects.map(p=>p.localId).filter(Boolean)),personal=local.filter(p=>!linked.has(p.id)&&!engine.status(p.id));
   const add=element('ul',null,'org-projects');add.setAttribute('aria-label','Projects only on this device');
   for(const project of personal){
    const row=element('li',null,'org-project');row.append(element('span',project.name,'org-name'),button(`Add to ${place}`,async()=>{
     const result=await engine.add(project.id);onChanged();feedback=`Added a copy of ${result.name} to ${place}.`;
    }));
    add.append(row);
   }
   if(!personal.length)add.append(element('li','No other projects on this device.','org-help'));
   parts.push(section(`Add to ${place}`,element('p',`Adds a copy: its source, files, comments, history and trash go to ${info.name}’s server, which can read them. The project on this device stays as it is.`,'org-help'),add));
  }
  for(const key of kept.keys())if(!drawn.has(key))kept.delete(key);
  return parts;
 }

 render=()=>{
  if(!dialog)return;
  const scroll=dialog.scrollTop;
  if(!engine.connected){body.replaceChildren(element('p',busy?'Signing in…':'Not signed in to a deployment.','org-help'));}
  else if(drawing)redraw=true;
  else drawing=connected().then(parts=>{if(dialog&&engine.connected){
   body.replaceChildren(...parts);dialog.scrollTop=scroll;refocus?.();keepFocus();
  }}).catch(error=>{feedback=error.message;status.textContent=feedback;}).finally(()=>{drawing=null;refocus=null;if(redraw){redraw=false;render();}});
  status.textContent=busy?'Working…':feedback;
  keepFocus();
 };
 function keepFocus(){if(dialog&&(!document.activeElement||document.activeElement===document.body))dialog.focus({preventScroll:true});}
 session=openDialog(dialog,{anchor,onClose(){dialog.remove();dialog=null;}});
 render();
 if(prefill.ssoCode)void (async()=>{
  busy=true;render();
  try{await engine.ssoFinish(prefill.ssoCode);feedback=`Signed in to ${engine.info.place}.`;onChanged();}
  catch(error){feedback=error?.message||String(error);}
  finally{busy=false;render();}
 })();
 return{render:()=>render(),close};
}
