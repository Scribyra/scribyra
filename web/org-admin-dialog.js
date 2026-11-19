// The admin area of a server-readable deployment (design sections 5 and 9), for its administrators
// only: Members (role, disable or unblock, remove with a new owner for their projects), Projects
// (open as administrator, read-only; transfer; delete), the audit log (filters, export as JSON
// lines or CSV), export everything (a zip), and the deployment's policy. The service checks every
// call and records every action; this dialog only presents them.
import {openDialog} from './menu.js';
import './org-dialog.css';

const element=(tag,text,cls)=>{const node=document.createElement(tag);if(text!=null&&text!=='')node.textContent=text;if(cls)node.className=cls;return node;};
const day=ms=>new Date(ms).toLocaleDateString(undefined,{day:'numeric',month:'long',year:'numeric'});
const when=ms=>ms?new Date(ms).toLocaleString(undefined,{day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'}):'—';
const size=bytes=>bytes<1024?`${bytes} B`:bytes<1048576?`${(bytes/1024).toFixed(1)} KB`:`${(bytes/1048576).toFixed(1)} MB`;
const who=m=>m?.email||m?.name||'Someone';
/** What members see of an administrator's action on their project (from the audit log). */
export function adminNotice({action,time}){
 const date=day(time);
 return action==='project.admin_edit'?`An administrator started editing this project on ${date}.`:action==='project.transferred'?`An administrator transferred this project on ${date}.`:
  action==='project.renamed'?`An administrator renamed this project on ${date}.`:`An administrator opened this project on ${date}.`;
}
const TABS=[['members','Members'],['projects','Projects'],['audit','Audit log'],['export','Export'],['settings','Settings']];
const STATE={active:'Active',disabled:'Disabled',blocked:'Blocked by the sign-in provider',removed:'Removed'};
/** Saves a downloaded blob under its name (an object URL the browser downloads). */
function save({blob,name}){const url=URL.createObjectURL(blob),a=element('a');a.href=url;a.download=name;document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),60000);}

export function orgAdminDialog({engine,anchor,onOpen=async()=>{},onChanged=()=>{}}){
 let dialog,session,busy=false,feedback='',tab='members',confirming=null,filters={},events=[],next=null,head=null,render=()=>{};
 const close=()=>session?.close('now');
 const info=engine.info;
 function button(label,fn,cls='secondary',name){
  const b=element('button',label,'button compact '+cls);b.type='button';if(name)b.setAttribute('aria-label',name);
  b.onclick=async()=>{if(busy)return;busy=true;feedback='';render();try{await fn();}catch(error){feedback=error?.message||String(error);}finally{busy=false;render();}};
  b.disabled=busy;return b;
 }
 function select(label,options,value){
  const row=element('label',null,'org-field'),input=element('select','','ui-input');input.setAttribute('aria-label',label);
  for(const [v,text] of options){const o=element('option',text);o.value=v;input.append(o);}if(value!=null)input.value=value;
  row.append(element('span',label),input);return{row,input};
 }
 function field(label,value='',type='text'){
  const row=element('label',null,'org-field'),input=element('input','','ui-input');input.type=type;input.value=value;input.autocomplete='off';input.setAttribute('aria-label',label);
  row.append(element('span',label),input);return{row,input};
 }
 const actions=(...nodes)=>{const a=element('div',null,'org-actions');a.append(...nodes);return a;};

 dialog=element('dialog',null,'ui-popup org-dialog org-admin');dialog.setAttribute('aria-label','Admin');dialog.tabIndex=-1;
 const heading=element('div',null,'org-heading');heading.append(element('h2',`Admin · ${info?.name||''}`,'ui-prompt-title'));
 const x=element('button','×','icon-button');x.type='button';x.setAttribute('aria-label','Close admin');x.onclick=close;heading.append(x);
 const tabs=element('div',null,'org-tabs');tabs.setAttribute('role','tablist');tabs.setAttribute('aria-label','Admin sections');
 const panel=element('div',null,'org-body');panel.setAttribute('role','tabpanel');panel.id='org-admin-panel';
 const status=element('p',null,'org-status');status.setAttribute('role','status');
 for(const [id,label] of TABS){
  const t=element('button',label,'org-tab');t.type='button';t.setAttribute('role','tab');t.id=`org-admin-tab-${id}`;t.setAttribute('aria-controls',panel.id);
  // The audit log is read again whenever its tab is chosen.
  t.onclick=()=>{tab=id;confirming=null;feedback='';if(id==='audit')head=null;render();};tabs.append(t);
 }
 dialog.append(heading,tabs,panel,status);

 async function members(admin){
  const {members:list}=await admin.members();
  const ul=element('ul',null,'org-projects');ul.setAttribute('aria-label','Members');
  const heirs=list.filter(m=>m.state==='active'&&m.role!=='guest');
  for(const m of list){
   const li=element('li',null,'org-project'),name=who(m),me=m.account===info.account;
   li.append(element('span',me?`${name} (you)`:name,'org-name'));
   li.append(element('span',`${m.provider} · ${STATE[m.state]||m.state} · last seen ${when(m.lastSeen)} · ${size(m.storage)} in ${m.projects} project${m.projects===1?'':'s'}`,'org-state'));
   if(m.role==='guest'||me)li.append(element('span',m.role==='guest'?'Guest':'Administrator','org-state'));
   else{
    const role=select(`Role for ${name}`,[['admin','Administrator'],['member','Member']],m.role);role.row.querySelector('span').remove();
    role.input.onchange=async()=>{busy=true;render();try{const r=await admin.setRole(m.account,role.input.value);feedback=`${name} is now ${r.role==='admin'?'an administrator':'a member'}.`;}catch(e){feedback=e.message;}finally{busy=false;render();}};
    li.append(role.row);
   }
   if(!me){
    if(m.state==='active')li.append(button('Disable',async()=>{await admin.disable(m.account);feedback=`${name} is disabled: their sessions ended and they cannot sign in.`;},'secondary',`Disable ${name}`));
    else li.append(button('Unblock',async()=>{await admin.unblock(m.account);feedback=`${name} can sign in again.`;},'secondary',`Unblock ${name}`));
    li.append(button('Remove',async()=>{confirming=confirming==='m:'+m.account?null:'m:'+m.account;},'secondary',`Remove ${name}`));
   }
   if(confirming==='m:'+m.account){
    const box=element('div',null,'org-share');
    const heir=select(`New owner of ${name}’s projects`,heirs.filter(h=>h.account!==m.account).map(h=>[h.account,h.account===info.account?`${who(h)} (you)`:who(h)]),info.account);
    box.append(element('p',`Removing ${name} ends their sessions, removes their access to every project, and gives the projects they own to the person you choose.`,'org-help'),heir.row,
     actions(button(`Remove ${name}`,async()=>{const r=await admin.remove(m.account,heir.input.value);confirming=null;feedback=`${name} was removed; ${r.projects} project${r.projects===1?'':'s'} moved.`;onChanged();},'danger',`Confirm removing ${name}`),
      button('Cancel',async()=>{confirming=null;})));
    li.append(box);
   }
   ul.append(li);
  }
  return [ul];
 }

 async function projects(admin){
  const [{projects:list},{members:people}]=await Promise.all([admin.projects(),admin.members()]);
  const ul=element('ul',null,'org-projects');ul.setAttribute('aria-label','All projects');
  for(const p of list){
   const li=element('li',null,'org-project');
   li.append(element('span',p.name,'org-name'),element('span',`${who(p.owner)} · ${p.members.length+1} ${p.members.length?'people':'person'} · ${size(p.size)} · changed ${when(p.updated)}`,'org-state'));
   li.append(button('Open as administrator',async()=>{const r=await engine.openAsAdmin(p.id);onChanged();close();await onOpen(r.localId);},'secondary',`Open ${p.name} as administrator`));
   li.append(button('Transfer',async()=>{confirming=confirming==='t:'+p.id?null:'t:'+p.id;},'secondary',`Transfer ${p.name}`));
   li.append(button('Delete',async()=>{confirming=confirming==='d:'+p.id?null:'d:'+p.id;},'secondary',`Delete ${p.name}`));
   if(confirming==='t:'+p.id){
    const heir=select(`New owner of ${p.name}`,people.filter(m=>m.state==='active'&&m.role!=='guest'&&m.account!==p.owner.account).map(m=>[m.account,who(m)]));
    li.append(heir.row,actions(button(`Transfer ${p.name}`,async()=>{await admin.transfer(p.id,heir.input.value);confirming=null;feedback=`${p.name} now belongs to ${heir.input.selectedOptions[0]?.textContent}. ${who(p.owner)} keeps editing it.`;},'primary',`Confirm transferring ${p.name}`),button('Cancel',async()=>{confirming=null;})));
   }
   if(confirming==='d:'+p.id){
    li.append(element('p',`Deleting ${p.name} erases it on the server for everyone, including its history. Copies on members’ devices stay there.`,'org-help org-why'),
     actions(button(`Delete ${p.name} permanently`,async()=>{await admin.deleteProject(p.id);confirming=null;feedback=`${p.name} was deleted.`;onChanged();},'danger'),button('Cancel',async()=>{confirming=null;})));
   }
   ul.append(li);
  }
  if(!list.length)ul.append(element('li','No projects yet.','org-help'));
  return [ul];
 }

 const ACTION_TEXT={'session.sign_in':'Signed in','session.sign_out':'Signed out','session.refused':'Sign-in refused','session.revoked':'Session ended by the provider','account.created':'Account created',
  'account.role_changed':'Role changed','account.disabled':'Account disabled','account.unblocked':'Account unblocked','account.blocked':'Blocked by the provider','account.removed':'Account removed',
  'project.created':'Project created','project.admin_open':'Opened as administrator','project.admin_edit':'Editing as administrator','project.deleted':'Project deleted','project.transferred':'Project transferred',
  'project.renamed':'Project renamed','project.compile_mode':'Compile mode changed','share.created':'Shared','share.changed':'Share changed','share.removed':'Share removed','invitation.created':'Invited',
  'invitation.accepted':'Invitation accepted','invitation.withdrawn':'Invitation withdrawn','export.everything':'Exported everything','audit.export':'Exported the audit log','audit.purge':'Old events purged',
  'deployment.start':'Service started'};
 const query=()=>({actor:filters.actor,action:filters.action,target:filters.target,from:filters.from?Date.parse(filters.from):undefined,to:filters.to?Date.parse(filters.to)+86400000:undefined});
 async function loadEvents(admin,more=false){
  const page=await admin.audit({...query(),limit:100,before:more?next:undefined});
  events=more?[...events,...page.events]:page.events;next=page.next;head=page.head;
 }
 async function audit(admin){
  const {members:people}=await admin.members(true);
  if(!head)await loadEvents(admin);
  const names=new Map(people.map(m=>[m.account,who(m)]));
  const form=element('div',null,'org-filters');
  const actor=select('Actor',[['','Anyone'],['system','The service'],...people.map(m=>[m.account,who(m)])],filters.actor||'');
  const action=select('Action',[['','Any action'],['session','Sign-ins'],['account','Accounts'],['project','Projects'],['share','Sharing'],['invitation','Invitations'],['export','Exports'],['audit','Audit log'],...Object.entries(ACTION_TEXT)],filters.action||'');
  const target=field('Target ID',filters.target||''),from=field('From',filters.from||'','date'),to=field('To',filters.to||'','date');
  form.append(actor.row,action.row,target.row,from.row,to.row);
  const apply=button('Apply filters',async()=>{filters={actor:actor.input.value,action:action.input.value,target:target.input.value.trim(),from:from.input.value,to:to.input.value};await loadEvents(admin);},'primary');
  const exports=[['jsonl','Export JSON lines'],['csv','Export CSV']].map(([format,label])=>button(label,async()=>{const file=await admin.download('/audit/export',{...query(),format});save(file);feedback=`Exported the audit log (head ${file.head}).`;}));
  const table=element('table',null,'org-audit');const caption=element('caption','Audit log');table.append(caption);
  const headRow=element('tr');for(const h of ['Time','Actor','Action','Target','Details'])headRow.append(Object.assign(element('th',h),{scope:'col'}));
  const thead=element('thead');thead.append(headRow);const tbody=element('tbody');table.append(thead,tbody);
  for(const e of events){
   const tr=element('tr'),detail=Object.entries(e.detail||{}).map(([k,v])=>`${k}: ${typeof v==='object'?JSON.stringify(v):v}`).join(', ');
   const target=e.targetType==='account'?names.get(e.target)||e.target:e.target?`${e.targetType} ${String(e.target).slice(0,12)}`:e.targetType||'';
   for(const text of [new Date(e.time).toLocaleString(),e.actor==='system'?'The service':e.actorEmail||e.actorName||names.get(e.actor)||e.actor.slice(0,12),ACTION_TEXT[e.action]||e.action,target,detail])tr.append(element('td',text));
   tr.dataset.action=e.action;tbody.append(tr);
  }
  const parts=[form,actions(apply,...exports),element('p',head?`${events.length} event${events.length===1?'':'s'} shown. Chain head: #${head.seq} ${head.hash.slice(0,16)}…`:'','org-help'),table];
  if(next)parts.push(actions(button('Show older events',async()=>{await loadEvents(admin,true);})));
  return parts;
 }

 async function exportAll(admin){
  return [element('p',`A zip with every project’s files as they are on ${info.name}’s server, the member list and the whole audit log. Exporting is recorded in the audit log.`,'org-help'),
   actions(button('Export everything',async()=>{feedback='Exporting…';render();const file=await admin.download('/export');save(file);feedback=`Exported everything (${size(file.blob.size)}).`;},'primary'))];
 }

 async function settings(admin){
  const s=await admin.settings(),dl=element('dl',null,'org-settings');dl.setAttribute('aria-label','Deployment settings');
  const add=(term,value)=>{dl.append(element('dt',term),element('dd',value));};
  add('Name',s.name);add('Encryption',s.encryption==='server'?'Server-readable':'End to end');add('Offline editing',s.offline?'On':'Off (online only)');add('Compile',s.compile);
  add('Share links',s.linkSharing?'On':'Off');add('Guests',s.guests);if(s.admins)add('Administrators (configured)',s.admins.join(', ')||'None');
  add('Audit log kept',`${s.auditRetentionDays} days`);add('Quotas',`${size(s.quotas.deployment_bytes)} in all, ${size(s.quotas.project_bytes)} per project, ${size(s.quotas.member_bytes)} per member`);
  for(const p of s.providers)add(`Sign-in: ${p.label}`,[p.issuer,p.emailDomains.length?`domains ${p.emailDomains.join(', ')}`:'',p.preset?`roles from ${p.preset}`:'roles from claims',`sessions ${p.sessionHours} h`].filter(Boolean).join(' · '));
  add('Policy hash',s.policy);
  return [element('p','Read only: the deployment’s configuration file decides these. Secrets are never shown.','org-help'),dl];
 }

 const SECTIONS={members,projects,audit,export:exportAll,settings};
 let drawing=null,redraw=false;
 render=()=>{
  if(!dialog)return;
  for(const t of tabs.children){const on=t.id===`org-admin-tab-${tab}`;t.setAttribute('aria-selected',String(on));t.tabIndex=on?0:-1;if(on)panel.setAttribute('aria-labelledby',t.id);}
  status.textContent=busy&&!feedback?'Working…':feedback;
  if(drawing){redraw=true;return;}
  const scroll=dialog.scrollTop;
  drawing=engine.admin().then(admin=>SECTIONS[tab](admin)).then(parts=>{if(dialog){panel.replaceChildren(...parts);dialog.scrollTop=scroll;for(const b of panel.querySelectorAll('button,select,input'))b.disabled=busy;}})
   .catch(error=>{feedback=error?.message||String(error);status.textContent=feedback;}).finally(()=>{drawing=null;if(redraw){redraw=false;render();}});
 };
 session=openDialog(dialog,{anchor,onClose(){dialog.remove();dialog=null;}});
 render();dialog.focus({preventScroll:true});
 return{render:()=>render(),close};
}
