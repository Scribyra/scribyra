// "Remote backup" dialog: connect this browser to a self-hosted service with a setup
// code, keep a recovery kit, choose projects to back up, or restore from a kit.
import {openDialog} from './menu.js';
import {STATUS_TEXT} from './org-backup.js';
import './org-dialog.css';

const element=(tag,text,cls)=>{const node=document.createElement(tag);if(text)node.textContent=text;if(cls)node.className=cls;return node;};
const E2EE='End-to-end encrypted. Only your devices and your current recovery kit can read these backups. The service stores ciphertext; its operator can see sizes, timing and how many projects you back up, not their contents.';

export function orgDialog({engine,anchor,listProjects,onRestored=()=>{},onChanged=()=>{}}){
 let dialog,session,busy=false,feedback='',kit='',remaining=0,render=()=>{};
 const close=()=>session?.close('now');
 function button(label,fn,cls='secondary'){
  const b=element('button',label,'button compact '+cls);b.type='button';
  b.onclick=async()=>{if(busy)return;busy=true;feedback='';render();try{await fn();}catch(error){feedback=error?.message||String(error);}finally{busy=false;render();}};
  return b;
 }
 function textArea(label,placeholder){
  const row=element('label',null,'org-field'),input=element('textarea','','ui-input');
  input.rows=3;input.spellcheck=false;input.autocomplete='off';input.placeholder=placeholder;input.setAttribute('aria-label',label);
  row.append(element('span',label),input);return{row,input};
 }
 function download(text){
  const url=URL.createObjectURL(new Blob([text],{type:'text/plain'})),a=element('a');a.href=url;a.download='scribyra-recovery-kit.txt';
  document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);
 }
 dialog=element('dialog',null,'ui-popup org-dialog');dialog.setAttribute('aria-label','Remote backup');dialog.tabIndex=-1;
 const heading=element('div',null,'org-heading');heading.append(element('h2','Remote backup','ui-prompt-title'));
 const x=element('button','×','icon-button');x.type='button';x.setAttribute('aria-label','Close remote backup');x.onclick=close;heading.append(x);
 const body=element('div',null,'org-body'),status=element('p',null,'org-status');status.setAttribute('role','status');
 dialog.append(heading,body,status);

 // Not connected: setup code or recovery kit.
 const setup=textArea('Setup code','scribyra-setup:1:…'),recovery=textArea('Recovery kit','scribyra-recovery:1:…');
 const connectButton=button('Connect',async()=>{kit=await engine.connect(setup.input.value);setup.input.value='';onChanged();},'primary');
 const restoreButton=button('Restore projects',async()=>{
  const result=await engine.restore(recovery.input.value);recovery.input.value='';onChanged();
  report(result);remaining=(await engine.unrestored()).length;onRestored(result);
 },'primary');

 // Just connected: the recovery kit, shown once.
 const kitText=element('pre',null,'org-kit');kitText.setAttribute('aria-label','Recovery kit');kitText.tabIndex=0;
 const saved=element('label',null,'org-check'),savedBox=element('input');savedBox.type='checkbox';saved.append(savedBox,element('span','I have saved my recovery kit somewhere safe'));
 const done=button('Done',async()=>{await engine.confirmKit();kit='';});savedBox.onchange=()=>render();
 const report=result=>{
  const names=result.restored.map(r=>r.name);
  feedback=(names.length?`Restored ${names.length===1?'1 project':names.length+' projects'}: ${names.join(', ')}.`:'No backed-up projects were found.')+(result.failures.length?` ${result.failures.length} could not be restored: ${result.failures.join(' ')}`:'');
 };

 render=()=>{
  if(!dialog)return;
  body.replaceChildren();
  if(kit){
   body.append(element('p','Save this recovery kit now. It is the only way to restore your backups if this browser’s data is lost. It stays here until you confirm you saved it; you can make a new one later, which replaces it.','org-help'),kitText);
   kitText.textContent=kit;
   const actions=element('div',null,'org-actions');actions.append(button('Download kit',()=>download(kit)),button('Copy kit',()=>navigator.clipboard.writeText(kit)));
   done.disabled=!savedBox.checked||busy;body.append(actions,saved,done);
  }else if(!engine.connected){
   body.append(element('p','Back up projects to a Scribyra service you or your organisation run. Nothing is sent until you choose a project to back up.','org-help'));
   body.append(element('h3','Connect this browser'),element('p','Paste the setup code from “scribyra-sync org create”. This creates keys in this browser.','org-help'),setup.row);
   const a=element('div',null,'org-actions');a.append(connectButton);body.append(a);
   body.append(element('h3','Restore on a new browser'),element('p','Paste your recovery kit to restore every backed-up project into this browser.','org-help'),recovery.row);
   const b=element('div',null,'org-actions');b.append(restoreButton);body.append(b);
   connectButton.disabled=restoreButton.disabled=busy;
  }else{
   const info=engine.info;
   body.append(element('p',`Connected to ${info.service}`,'org-service'),element('p',E2EE,'org-help org-mode'));
   const list=element('ul',null,'org-projects');list.setAttribute('aria-label','Projects and their backup state');
   void (async()=>{
    const [projects,links]=await Promise.all([listProjects(),engine.links()]),linked=new Set(links.map(l=>l.localId));
    for(const project of projects){
     const row=element('li',null,'org-project'),name=element('span',project.name,'org-name'),s=engine.status(project.id);
     const label=element('span',linked.has(project.id)?(s?.label||STATUS_TEXT['backing-up']):'Only on this device','org-state');
     if(s?.message)label.title=s.message;
     row.append(name,label);
     if(!linked.has(project.id))row.append(button('Back up',()=>engine.backUp(project.id).then(onChanged)));
     else if(s&&s.state!=='backed-up'&&s.state!=='backing-up'){row.append(button('Retry',()=>engine.push(project.id)));}
     if(s?.message&&s.state!=='backed-up'){const why=element('p',s.message,'org-help org-why');row.append(why);}
     list.append(row);
    }
    if(!projects.length)list.append(element('li','No local projects yet.','org-help'));
   })().catch(error=>{feedback=error.message;status.textContent=feedback;});
   body.append(list);
   if(remaining){
    body.append(element('p',`${remaining===1?'1 backed-up project was':remaining+' backed-up projects were'} not restored yet.`,'org-help'));
    const again=element('div',null,'org-actions');again.append(button('Restore remaining projects',async()=>{const result=await engine.restoreRemaining();report(result);remaining=(await engine.unrestored()).length;onChanged();onRestored(result);}));body.append(again);
   }
   const actions=element('div',null,'org-actions');
   actions.append(button('New recovery kit',async()=>{kit=await engine.replaceRecoveryKit();savedBox.checked=false;}),button('Forget service',async()=>{await engine.forget();remaining=0;onChanged();feedback='This browser no longer backs up. Your local projects and the service’s copies are unchanged.';}));
   body.append(actions);
  }
  status.textContent=busy?'Working…':feedback;
 };
 session=openDialog(dialog,{anchor,onClose(){dialog.remove();dialog=null;}});
 render();
 // A kit that was not confirmed as saved, or a restore that stopped early, is offered again.
 if(engine.connected)void Promise.all([engine.pendingKit(),engine.unrestored()]).then(([pending,left])=>{kit||=pending;remaining=left.length;render();}).catch(()=>{});
 return{render:()=>render(),close};
}
