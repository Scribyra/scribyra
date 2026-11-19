// The confirmation flow for "Open in Scribyra" links (docs/open-links.md).
// Opening a link only shows this dialog: nothing is fetched until the person chooses
// to check the source, and nothing is imported or compiled until they choose Import or
// Import and compile. A link cannot trigger any other action.
import {restoreDialogFocus} from './input.js';
import {parseOpenLink,sourcePage,sourceKey,defaultProjectName,repoAddress,OpenLinkError,OPEN_LINK_MAX_CHARS} from '../site/open-link-format.js';
import {SKIP_REASONS,ImportRefused,projectEntries,detectMainFile,importSourceRecord} from './open-link.js';
import {checkSource,downloadFiles,FetchProblem} from './open-link-fetch.js';

/** Consumes `#open?…` from the address bar so a reload does not ask again. */
export function takeOpenFragment(browser){
 const hash=browser.location.hash;
 if(!/^#open(?:\?|$)/.test(hash))return null;
 browser.history.replaceState(null,'',browser.location.pathname+browser.location.search);
 if(hash.length>OPEN_LINK_MAX_CHARS+1)return {error:`This link is too long. Open links are at most ${OPEN_LINK_MAX_CHARS.toLocaleString('en')} characters.`};
 try{return {link:parseOpenLink(hash)};}catch(error){return {error:error instanceof OpenLinkError?error.message:'This link is damaged.'};}
}

// Device-local index: which projects were imported from which source, for "Open existing copy".
const INDEX='scribyra:open-links:v1';
function readIndex(storage){try{const value=JSON.parse(storage.getItem(INDEX)||'{}');return value&&typeof value==='object'&&!Array.isArray(value)?value:{};}catch{return {};}}
export function rememberImport(storage,key,id,at=Date.now()){
 try{const index=readIndex(storage);index[key]=[{id,at},...(Array.isArray(index[key])?index[key]:[]).filter(entry=>entry?.id!==id)].slice(0,20);storage.setItem(INDEX,JSON.stringify(index));}catch{}
}
export function existingImports(storage,key,projects){
 const known=new Map(projects.map(project=>[project.id,project]));
 const entries=readIndex(storage)[key];
 return (Array.isArray(entries)?entries:[]).filter(entry=>typeof entry?.id==='string'&&known.has(entry.id)).map(entry=>({...known.get(entry.id),importedAt:Number(entry.at)||0}));
}

function el(tag,props={},...children){
 const node=document.createElement(tag);
 for(const [key,value]of Object.entries(props)){
  if(value===undefined||value===null||value===false)continue;
  if(key==='className')node.className=value;else if(key==='text')node.textContent=value;else if(key.startsWith('on'))node.addEventListener(key.slice(2),value);else node.setAttribute(key,value===true?'':value);
 }
 for(const child of children.flat())if(child!==null&&child!==undefined&&child!==false)node.append(child);
 return node;
}
const size=bytes=>bytes<1024?`${bytes} B`:bytes<1024*1024?`${(bytes/1024).toFixed(bytes<10240?1:0)} KB`:`${(bytes/1024/1024).toFixed(1)} MB`;
const plural=(count,one,many=one+'s')=>`${count.toLocaleString('en')} ${count===1?one:many}`;
const hostsFor=link=>link.kind==='github'?'api.github.com and raw.githubusercontent.com (GitHub)':link.kind==='gitlab'?`${link.host} (GitLab)`:link.host;
const kindLabel=link=>link.kind==='github'?'GitHub':link.kind==='gitlab'?(link.host==='gitlab.com'?'GitLab':`GitLab at ${link.host}`):'ZIP file';

/** A grouped list of skipped entries, at most 50 names per reason. */
function report(skipped){
 if(!skipped.length)return null;
 const groups=new Map();for(const item of skipped){if(!groups.has(item.reason))groups.set(item.reason,[]);groups.get(item.reason).push(item);}
 const list=el('ul',{className:'open-link-report'});
 for(const [reason,items]of groups){
  const names=el('ul');for(const item of items.slice(0,50))names.append(el('li',{},el('code',{text:item.path}),item.size?` · ${size(item.size)}`:''));
  if(items.length>50)names.append(el('li',{text:`…and ${items.length-50} more`}));
  list.append(el('li',{'data-reason':reason},el('strong',{text:`${SKIP_REASONS[reason]||'Skipped'} (${items.length})`}),names));
 }
 return el('details',{className:'open-link-skipped',open:skipped.length<=8},el('summary',{text:`${plural(skipped.length,'item')} will not be imported`}),list);
}

/**
 * openLinkEntry({initial, projects, openExisting(id), importProject({name, entries, main, source}) → id,
 *   compile(), notify(message), storage})
 */
export function openLinkEntry({initial,projects,openExisting,importProject,compile,notify,storage=localStorage}){
 let started=false,active=null;
 const show=entry=>{
  if(!entry)return;
  active?.dismiss();
  active=entry.error?errorDialog(entry.error):confirmDialog(entry.link);
 };
 function errorDialog(message){
  const dialog=el('dialog',{className:'modal open-link-dialog','aria-labelledby':'open-link-title'});restoreDialogFocus(dialog);
  const close=()=>{dialog.close();dialog.remove();if(active?.dialog===dialog)active=null;};
  dialog.append(el('h2',{id:'open-link-title',text:'This link cannot be opened'}),el('p',{role:'alert',text:message}),el('p',{text:'Nothing was downloaded or imported.'}),el('div',{className:'modal-actions'},el('button',{type:'button',className:'button primary',text:'Close',onclick:close})));
  dialog.addEventListener('cancel',event=>{event.preventDefault();close();});
  document.body.append(dialog);dialog.showModal();
  return {dialog,dismiss:close};
 }
 function confirmDialog(link){
  const key=sourceKey(link),name=defaultProjectName(link).slice(0,160);
  let phase='review',checked=null,controller=null,problem=null,closed=false;
  const dialog=el('dialog',{className:'modal open-link-dialog','aria-labelledby':'open-link-title','aria-describedby':'open-link-what'});restoreDialogFocus(dialog);
  const close=()=>{if(closed)return;closed=true;controller?.abort();dialog.close();dialog.remove();if(active?.dialog===dialog)active=null;};
  dialog.addEventListener('cancel',event=>{event.preventDefault();close();});
  const heading=el('h2',{id:'open-link-title',text:link.kind==='zip'?'Open a ZIP file in Scribyra':'Open a repository in Scribyra'});
  const where=link.kind==='zip'?link.url:`${repoAddress(link).replace(/^https:\/\//,'')}${link.ref?`@${link.ref}`:''}${link.path?` / ${link.path}`:''}`;
  const facts=el('dl',{className:'open-link-facts'},
   el('dt',{text:'Source'}),el('dd',{},el('span',{className:'open-link-kind',text:kindLabel(link)}),' ',el('a',{href:sourcePage(link),target:'_blank',rel:'noopener noreferrer',className:'open-link-source',text:where})),
   link.kind!=='zip'?[el('dt',{text:'Branch, tag or commit'}),el('dd',{text:link.ref||'Default branch'})]:null,
   el('dt',{text:'Folder'}),el('dd',{text:link.path||(link.kind==='zip'?'Whole archive':'Whole repository')}),
   el('dt',{text:'Main file'}),el('dd',{text:link.main||'Chosen automatically: the .tex file with \\documentclass and \\begin{document}'}),
   el('dt',{text:'New project'}),el('dd',{text:name}));
  const summary=el('div',{className:'open-link-summary'});
  const what=el('p',{id:'open-link-what',className:'open-link-what'});
  const status=el('p',{className:'open-link-status',role:'status','aria-live':'polite'});
  const actions=el('div',{className:'modal-actions'});
  dialog.append(heading,facts,summary,what,status,actions);
  const button=(text,onclick,primary=false)=>el('button',{type:'button',className:`button ${primary?'primary':'secondary'}`,text,onclick:event=>{
   // Synthetic clicks (a hostile page script, a forged event) never import or compile.
   if(!event.isTrusted||closed)return;onclick();
  }});
  const existing=()=>existingImports(storage,key,projects());
  function render(){
   if(closed)return;
   summary.replaceChildren();actions.replaceChildren();status.textContent='';status.removeAttribute('data-problem');
   if(phase==='review'){
    const copies=existing();
    what.textContent=`Checking contacts ${hostsFor(link)} from this browser to read the file list and sizes. Nothing is imported or compiled yet.`;
    if(copies.length){
     const latest=copies[0];
     summary.append(el('p',{className:'open-link-existing',text:`You already imported this ${link.kind==='zip'?'file':'repository'} into “${latest.name}”${latest.importedAt?` on ${new Date(latest.importedAt).toLocaleDateString(undefined,{dateStyle:'medium'})}`:''}.`}));
     actions.append(button('Cancel',close),button('Import again',check),button('Open existing copy',()=>{close();void Promise.resolve(openExisting(latest.id)).catch(error=>notify(error.message));},true));
    }else actions.append(button('Cancel',close),button(link.kind==='zip'?'Check ZIP file':'Check repository',check,true));
   }else if(phase==='checking'||phase==='importing'){
    what.textContent=phase==='checking'?`Contacting ${hostsFor(link)}…`:'Downloading files into this browser…';
    status.textContent=phase==='checking'?'Checking…':status.dataset.progress||'Preparing…';
    actions.append(button('Cancel',close));
   }else if(phase==='ready'){
    const plan=checked.plan;
    summary.append(...[el('p',{className:'open-link-numbers'},
     checked.commit?el('span',{},'Commit ',el('code',{text:checked.commit.slice(0,12)})):null,
     el('span',{text:plural(plan.files.length,'file')}),
     el('span',{text:size(plan.bytes)})),
     checked.rate&&checked.rate.remaining<20?el('p',{className:'open-link-rate',text:`GitHub requests left this hour from your network: ${checked.rate.remaining} of ${checked.rate.limit}.`}):null,
     report(plan.skipped)].filter(Boolean));
    what.textContent=`A copy is made in this browser; nothing is sent back. Files are downloaded from ${link.kind==='github'?'raw.githubusercontent.com':link.host}${link.kind==='github'?'':' (already received)'}. Import and compile also runs LaTeX on the main file, in this browser.`;
    actions.append(button('Cancel',close),button('Import',()=>run(false)),button('Import and compile',()=>run(true),true));
   }else if(phase==='problem'){
    what.textContent='Nothing was imported.';
    status.textContent=problem.message;status.dataset.problem=problem.code||'failed';
    actions.append(button('Close',close),problem.code==='not_found'||problem.code==='refused'?null:button('Try again',check,true));
   }
   actions.querySelector('.button.primary')?.focus();
  }
  function fail(error){
   if(closed||error?.name==='AbortError')return;
   problem=error instanceof FetchProblem?error:error instanceof ImportRefused?{message:error.message,code:'refused'}:{message:'Scribyra could not read this source. Nothing was imported.',code:'failed'};
   if(!(error instanceof FetchProblem||error instanceof ImportRefused))console.error(error);
   phase='problem';render();
  }
  function check(){
   controller?.abort();controller=new AbortController();const signal=controller.signal;
   phase='checking';render();
   checkSource(link,{signal}).then(result=>{if(signal.aborted||closed)return;checked=result;phase='ready';render();},fail);
  }
  async function run(compileAfter){
   controller?.abort();controller=new AbortController();const signal=controller.signal;
   phase='importing';render();
   try{
    const downloaded=await downloadFiles(link,checked,{signal,progress:(done,total)=>{status.dataset.progress=`Downloaded ${done} of ${total} files`;if(phase==='importing')status.textContent=status.dataset.progress;}});
    if(signal.aborted||closed)return;
    const {entries,skipped}=projectEntries(downloaded);
    if(!entries.length)throw new ImportRefused('None of the files could be imported.');
    const found=link.main&&entries.some(entry=>entry.path===link.main&&typeof entry.content==='string');
    const main=found?link.main:detectMainFile(entries);
    const source=importSourceRecord(link,{commit:checked.commit,archiveSha256:checked.archiveSha256||'',main});
    status.textContent='Saving the project in this browser…';
    closed=true;dialog.close();dialog.remove();if(active?.dialog===dialog)active=null;
    const id=await importProject({name,entries,main,source});
    rememberImport(storage,key,id);
    const notes=[`Imported ${plural(entries.length,'file')} from ${link.kind==='zip'?link.host:repoAddress(link).replace(/^https:\/\//,'')}${checked.commit?` at ${checked.commit.slice(0,7)}`:''}.`];
    const later=[...skipped];
    if(later.length)notes.push(`${plural(later.length,'more file')} skipped while importing: ${later.slice(0,5).map(item=>`${item.path} (${SKIP_REASONS[item.reason]})`).join('; ')}${later.length>5?'…':''}.`);
    if(link.main&&!found)notes.push(`The link names ${link.main} as the main file, but it is not in the import${main?`; using ${main}`:''}.`);
    if(!main)notes.push('No main .tex file was found; choose one in Project settings before compiling.');
    notify(notes.join(' '));
    if(compileAfter&&main)await compile();
   }catch(error){
    if(closed&&!dialog.isConnected){if(error?.name!=='AbortError')notify(error.message||'The import failed. Nothing was saved.');return;}
    fail(error);
   }
  }
  document.body.append(dialog);dialog.showModal();render();
  return {dialog,dismiss:close};
 }
 return {
  start(){if(started)return;started=true;show(initial);initial=null;window.addEventListener('hashchange',()=>show(takeOpenFragment(window)));},
 };
}
