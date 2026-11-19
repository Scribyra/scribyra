// The organisation dialog for a server-readable deployment (design section 9): who is signed in
// and what the server can read, the deployment's projects (on this device or to open from the
// server) with their sync state, "Add to <deployment>" for personal projects, sharing by email
// invitation with a role, and signing out.
import {openDialog} from './menu.js';
import {MODE_TEXT} from './org-server.js';
import {orgAdminDialog,adminNotice} from './org-admin-dialog.js';
import './org-dialog.css';

const element=(tag,text,cls)=>{const node=document.createElement(tag);if(text)node.textContent=text;if(cls)node.className=cls;return node;};
const ROLE_LABEL={owner:'Owner',editor:'Editor',reviewer:'Reviewer',viewer:'Viewer',admin:'Opened as administrator'};
const ROLES=[['editor','Editor'],['reviewer','Reviewer'],['viewer','Viewer']];
const host=service=>{try{return new URL(service).host;}catch{return service;}};

export function orgServerDialog({engine,anchor,listProjects,prefill={},onChanged=()=>{},onOpen=async()=>{}}){
 let dialog,session,busy=false,feedback='',render=()=>{},drawing=null,redraw=false,shared=null;
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
 const actions=(...buttons)=>{const a=element('div',null,'org-actions');a.append(...buttons);return a;};
 const section=(title,...nodes)=>{const s=element('section',null,'org-section');s.append(element('h3',title),...nodes);return s;};
 async function signInWith(provider){location.assign(await engine.ssoBegin({service:engine.info.service,provider}));}

 dialog=element('dialog',null,'ui-popup org-dialog');dialog.setAttribute('aria-label','Remote backup');dialog.tabIndex=-1;
 const heading=element('div',null,'org-heading');heading.append(element('h2','Remote backup','ui-prompt-title'));
 const x=element('button','×','icon-button');x.type='button';x.setAttribute('aria-label','Close remote backup');x.onclick=close;heading.append(x);
 const body=element('div',null,'org-body'),status=element('p',null,'org-status');status.setAttribute('role','status');
 dialog.append(heading,body,status);
 // What is typed in the invitation form survives redraws (the long poll redraws the dialog).
 const typed={email:'',role:'editor'};

 async function shareBox(project){
  const details=await engine.details(project.project),box=element('div',null,'org-share'),manage=['owner','editor'].includes(details.role);
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
   const email=field('Email',typed.email,'email'),role=select('Role',ROLES,typed.role);
   email.input.oninput=()=>{typed.email=email.input.value;};role.input.onchange=()=>{typed.role=role.input.value;};
   box.append(email.row,role.row,actions(button('Invite',async()=>{
    const address=typed.email.trim(),result=await engine.invite(project.project,address,typed.role);
    typed.email='';
    feedback=result.status==='pending'?`Invited ${address}. Ask them to sign in to ${engine.info.name}’s Scribyra; the project then appears in their list.`:`Shared with ${address}.`;
   },'primary')));
  }
  return box;
 }

 async function connected(){
  const info=engine.info,parts=[];
  parts.push(element('p',`${info.name} · ${host(info.service)}`,'org-service'),element('p',MODE_TEXT(info.name),'org-help org-mode'));
  if(info.offline===false)parts.push(element('p',`${info.name} keeps projects online only: you edit while connected, and projects leave this device when you sign out.`,'org-help'));
  if(!info.signedIn){
   parts.push(element('p',`Sign in again to keep syncing.${info.offline===false?'':' Your projects stay on this device.'}`,'org-help'),
    actions(...(info.providers||[]).map(p=>button(`Sign in with ${p.label} again`,()=>signInWith(p.id),'primary'))),
    actions(button('Forget this deployment',async()=>{await engine.forget();onChanged();close();})));
   return parts;
  }
  const [projects,local]=await Promise.all([engine.projects(),listProjects()]);
  parts.push(element('p',`Signed in as ${info.email||info.accountName||'your account'}.`,'org-help'),actions(button('Sign out',async()=>{await engine.signOut();onChanged();feedback='Signed out.';}),
   // The admin area, for the deployment's administrators only (the service refuses everyone else).
   ...(engine.info.role==='admin'?[button('Admin',async()=>{close();orgAdminDialog({engine,anchor,onOpen,onChanged});})]:[])));
  const list=element('ul',null,'org-projects');list.setAttribute('aria-label',`Projects on ${info.name}`);
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
  if(info.role!=='guest'){
   const linked=new Set(projects.map(p=>p.localId).filter(Boolean)),personal=local.filter(p=>!linked.has(p.id)&&!engine.status(p.id));
   const add=element('ul',null,'org-projects');add.setAttribute('aria-label','Projects only on this device');
   for(const project of personal){
    const row=element('li',null,'org-project');row.append(element('span',project.name,'org-name'),button(`Add to ${info.name}`,async()=>{
     const result=await engine.add(project.id);onChanged();feedback=`Added a copy of ${result.name} to ${info.name}.`;
    }));
    add.append(row);
   }
   if(!personal.length)add.append(element('li','No other projects on this device.','org-help'));
   parts.push(section(`Add to ${info.name}`,element('p',`Adds a copy: its source, files, comments, history and trash go to ${info.name}’s server, which can read them. The project on this device stays as it is.`,'org-help'),add));
  }
  return parts;
 }

 render=()=>{
  if(!dialog)return;
  const scroll=dialog.scrollTop;
  if(!engine.connected){body.replaceChildren(element('p',busy?'Signing in…':'Not signed in to a deployment.','org-help'));}
  else if(drawing)redraw=true;
  else drawing=connected().then(parts=>{if(dialog&&engine.connected){
   const active=document.activeElement?.getAttribute('aria-label')==='Email';
   body.replaceChildren(...parts);dialog.scrollTop=scroll;if(active)body.querySelector('input[aria-label="Email"]')?.focus();keepFocus();
  }}).catch(error=>{feedback=error.message;status.textContent=feedback;}).finally(()=>{drawing=null;if(redraw){redraw=false;render();}});
  status.textContent=busy?'Working…':feedback;
  keepFocus();
 };
 function keepFocus(){if(dialog&&(!document.activeElement||document.activeElement===document.body))dialog.focus({preventScroll:true});}
 session=openDialog(dialog,{anchor,onClose(){dialog.remove();dialog=null;}});
 render();
 if(prefill.ssoCode)void (async()=>{
  busy=true;render();
  try{await engine.ssoFinish(prefill.ssoCode);feedback=`Signed in to ${engine.info.name}.`;onChanged();}
  catch(error){feedback=error?.message||String(error);}
  finally{busy=false;render();}
 })();
 return{render:()=>render(),close};
}
