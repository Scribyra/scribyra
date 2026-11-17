// Dialogs for bibliography import and Zotero: the import report, the link form, the
// refresh preview and the Zotero panel. They show data and collect choices; network
// requests and project changes happen in zotero.js through the callbacks given here.
import {restoreDialogFocus} from './input.js';
import {ZOTERO_KEYS_URL} from './zotero-api.js';
import {readBibliography} from './bibtex.js';
import {plainBibText,shortAuthors} from './latex-index.js';

function el(tag,props={},...children){
  const node=document.createElement(tag);
  for(const [key,value]of Object.entries(props)){
    if(value===undefined||value===null||value===false)continue;
    if(key==='className')node.className=value;else if(key==='text')node.textContent=value;else if(key.startsWith('on'))node.addEventListener(key.slice(2),value);else if(key in node&&key!=='list')node[key]=value;else node.setAttribute(key,value===true?'':value);
  }
  for(const child of children.flat())if(child!==null&&child!==undefined&&child!==false)node.append(child);
  return node;
}
function shell(className,label){
  const dialog=el('dialog',{className:`modal zotero-dialog ${className}`,'aria-label':label});restoreDialogFocus(dialog);
  // Optional parts are passed as null; never let them become text.
  const append=dialog.append.bind(dialog);dialog.append=(...nodes)=>append(...nodes.filter(node=>node!==null&&node!==undefined&&node!==false));
  return dialog;
}
const button=(text,onclick,primary=false,props={})=>el('button',{type:'button',className:`button ${primary?'primary':'secondary'}`,text,onclick,...props});
function field(text,control,help){const id=`zotero-${Math.random().toString(36).slice(2)}`;control.id=id;const helpNode=help?el('small',{className:'zotero-help',id:id+'-help'},help):null;if(helpNode)control.setAttribute('aria-describedby',helpNode.id);return el('div',{className:'zotero-field'},el('label',{for:id,text}),control,helpNode);}
const summaryOf=raw=>{const entry=readBibliography(raw).entries[0];if(!entry)return '';const get=name=>entry.fields.get(name)?.value||'';const year=(get('year')||get('date')).match(/\d{4}/)?.[0]||'';return [shortAuthors(get('author')||get('editor')),year].filter(Boolean).join(', ')+(get('title')?` · ${plainBibText(get('title')).slice(0,120)}`:'');};

/** Shows the problems found in .bib files before importing. Resolves to true to import anyway. */
export function bibliographyReport(results){
  return new Promise(resolve=>{
    const dialog=shell('bibliography-report','Bibliography check');
    const errors=results.reduce((sum,result)=>sum+result.errors,0),warnings=results.reduce((sum,result)=>sum+result.warnings,0);
    dialog.append(el('h2',{text:'Check this bibliography'}),
      el('p',{text:`${errors?`${errors} ${errors===1?'problem':'problems'} BibTeX or Biber will reject or misread`:''}${errors&&warnings?' and ':''}${warnings?`${warnings} ${warnings===1?'warning':'warnings'}`:''}. Importing keeps the file exactly as it is, with your citation keys; you can fix it afterwards in the editor.`}));
    for(const result of results){
      const list=el('ul',{className:'bibliography-problems'});
      for(const problem of result.problems.slice(0,200))list.append(el('li',{'data-severity':problem.severity},el('span',{className:'zotero-badge',text:problem.severity==='error'?'Error':'Warning'}),el('span',{text:` Line ${problem.line}: ${problem.message}`})));
      if(result.problems.length>200)list.append(el('li',{text:`…and ${result.problems.length-200} more.`}));
      dialog.append(el('section',{className:'bibliography-file','aria-label':result.path},el('h3',{text:`${result.path} · ${result.entries} ${result.entries===1?'entry':'entries'} readable`}),list));
    }
    const finish=value=>{dialog.close();dialog.remove();resolve(value);};
    dialog.append(el('div',{className:'modal-actions'},button('Cancel import',()=>finish(false)),button('Import anyway',()=>finish(true),true)));
    dialog.addEventListener('cancel',event=>{event.preventDefault();finish(false);});
    document.body.append(dialog);dialog.showModal();dialog.querySelector('.button.primary').focus();
  });
}

/**
 * The "Link to Zotero" form. `verify(identity, apiKey)` checks the key and returns the
 * libraries it can read; `collections(library)` lists a library's collections;
 * `link(choice, progress)` creates the file. Resolves to the link result or null.
 */
export function zoteroLinkDialog({saved,defaultPath,verify,collections,link,blocked=''}){
  return new Promise(resolve=>{
    let closed=false,busy=false,checked=null,abort=null;
    const dialog=shell('zotero-link','Link to Zotero');
    const status=el('p',{className:'zotero-status',role:'status','aria-live':'polite'});
    const identity=el('input',{className:'input',autocomplete:'off',spellcheck:false,value:saved?.userId||'',placeholder:'For example 1234567'});
    const key=el('input',{className:'input',type:'password',autocomplete:'off',spellcheck:false,placeholder:saved?'Saved on this device':'24 letters and digits'});
    const keysLink=el('a',{href:ZOTERO_KEYS_URL,target:'_blank',rel:'noopener noreferrer',text:'zotero.org/settings/keys'});
    const keyHelp=el('span',{},'Create one at ',keysLink,': choose “Create new private key”, tick only “Allow library access”, and leave write and notes access off. For a group library, set group access to “Read Only”. Your user ID is shown on the same page.');
    const check=button(saved?'Continue with saved key':'Check key',()=>void work(async signal=>{
      status.textContent='Checking the key with api.zotero.org…';
      checked=await verify({identity:identity.value.trim(),apiKey:key.value.trim()||null},signal);
      library.replaceChildren(...checked.libraries.map(entry=>el('option',{value:`${entry.type}:${entry.id}`,text:entry.type==='user'?'My Library':`Group: ${entry.name}`})));
      status.textContent=`Key for ${checked.username?`“${checked.username}” `:''}(user ${checked.userId}) can read ${checked.libraries.length===1?'My Library':`${checked.libraries.length} libraries`}.${checked.write?' It can also change your library; Scribyra only reads, so a read-only key is safer.':''}`;
      key.value='';key.placeholder='Saved on this device after linking';
      await loadCollections(signal);
    }),true);
    const library=el('select',{className:'input'}),collection=el('select',{className:'input'},el('option',{value:'',text:'Whole library'}));
    const format=el('select',{className:'input'},el('option',{value:'biblatex',text:'BibLaTeX (for biblatex and Biber)'}),el('option',{value:'bibtex',text:'BibTeX (for natbib and BibTeX styles)'}));
    const path=el('input',{className:'input',value:defaultPath,spellcheck:false,autocomplete:'off'});
    async function loadCollections(signal){
      const chosen=selectedLibrary();if(!chosen)return;
      collection.replaceChildren(el('option',{value:'',text:'Whole library'}));
      const list=await collections(chosen,signal);
      collection.append(...list.map(item=>el('option',{value:item.key,text:item.path})));
      what.disabled=false;refresh();
    }
    const selectedLibrary=()=>checked?.libraries.find(entry=>`${entry.type}:${entry.id}`===library.value)||null;
    library.addEventListener('change',()=>void work(loadCollections));
    const who=el('fieldset',{className:'zotero-step'},el('legend',{text:'1. Your Zotero account'}),
      field('Zotero user ID or username',identity),
      field('Read-only API key',key,keyHelp),
      el('p',{className:'zotero-privacy',text:'The key is kept only in this browser on this device. It is sent only to api.zotero.org, and never put into the project, its history, backups, exports, diagnostics or telemetry. Remove it anytime from More tools → Zotero.'}),
      el('div',{className:'modal-actions'},check));
    const what=el('fieldset',{className:'zotero-step',disabled:true},el('legend',{text:'2. What to link'}),
      field('Library',library),field('Collection',collection),field('Format',format,'Zotero’s own export of each item. Keys and entries are written into the file; you can edit them like any file.'),field('New file in this project',path));
    const linkButton=button('Link and import',()=>void work(async signal=>{
      const chosen=selectedLibrary();if(!chosen)throw new Error('Check the key and choose a library first.');
      const result=await link({userId:checked.userId,username:checked.username,write:checked.write,library:chosen,collection:collection.value?{key:collection.value,name:collection.selectedOptions[0].textContent}:null,format:format.value,path:path.value.trim()},message=>{status.textContent=message;},signal);
      finish(result);
    }),true);
    function refresh(){
      if(closed)return;
      for(const node of [identity,key,check])node.disabled=busy||!!blocked;
      what.disabled=busy||!checked||!!blocked;linkButton.disabled=busy||!checked||!!blocked;cancel.textContent=busy?'Stop':'Cancel';
    }
    async function work(task){
      if(busy)return;busy=true;abort=new AbortController();refresh();
      try{await task(abort.signal);}
      catch(error){if(!closed)status.textContent=error.name==='AbortError'?'Stopped. Nothing was linked.':error.message||String(error);}
      finally{busy=false;abort=null;refresh();}
    }
    const cancel=button('Cancel',()=>{if(busy)abort?.abort();else finish(null);});
    function finish(value){if(closed)return;closed=true;abort?.abort();key.value='';dialog.close();dialog.remove();resolve(value);}
    dialog.addEventListener('cancel',event=>{event.preventDefault();if(busy)abort?.abort();else finish(null);});
    dialog.append(el('h2',{text:'Link to Zotero'}),
      el('p',{text:'Creates a .bib file in this project from your Zotero library or one of its collections. Refresh it from Zotero later; Scribyra shows the differences before changing entries you edited here. Linking and refreshing contact api.zotero.org only when you ask.'}),
      blocked?el('p',{className:'zotero-blocked',role:'note',text:blocked}):null,
      who,what,status,el('div',{className:'modal-actions'},cancel,linkButton));
    document.body.append(dialog);dialog.showModal();refresh();
    (saved?check:identity).focus();
  });
}

/** Asks for a saved-key replacement when refreshing on a device that has no key. */
export function zoteroKeyDialog({link}){
  return new Promise(resolve=>{
    const dialog=shell('zotero-key','Zotero API key');
    const key=el('input',{className:'input',type:'password',autocomplete:'off',spellcheck:false});
    const finish=value=>{key.value='';dialog.close();dialog.remove();resolve(value);};
    dialog.append(el('h2',{text:'Zotero API key needed'}),
      el('p',{},`This device has no API key for Zotero user ${link.userId}. Enter a read-only key from `,el('a',{href:ZOTERO_KEYS_URL,target:'_blank',rel:'noopener noreferrer',text:'zotero.org/settings/keys'}),'. It is kept only on this device and sent only to api.zotero.org.'),
      field('Read-only API key',key),
      el('div',{className:'modal-actions'},button('Cancel',()=>finish(null)),button('Save key and refresh',()=>finish(key.value.trim()||null),true)));
    key.addEventListener('keydown',event=>{if(event.key==='Enter'){event.preventDefault();finish(key.value.trim()||null);}});
    dialog.addEventListener('cancel',event=>{event.preventDefault();finish(null);});
    document.body.append(dialog);dialog.showModal();key.focus();
  });
}

const KIND={added:'Added in Zotero',changed:'Changed in Zotero',removed:'Removed from Zotero'};
function choiceLabels(change){
  if(change.kind==='added')return {zotero:'Add it to this file',local:'Don’t add it'};
  if(change.kind==='removed')return {zotero:'Remove it here too',local:'Keep it in this file'};
  if(change.local==='deleted')return {zotero:'Add Zotero’s version back',local:'Keep it deleted here'};
  return {zotero:'Use Zotero’s version',local:'Keep this file’s version'};
}
function fieldTable(change){
  if(!change.fields.length)return null;
  const body=el('tbody');
  for(const item of change.fields.slice(0,40))body.append(el('tr',{},el('th',{scope:'row',text:item.field}),el('td',{className:'zotero-before',text:item.before??'—'}),el('td',{className:'zotero-after',text:item.after??'—'})));
  return el('table',{className:'zotero-fields'},el('caption',{className:'sr-only',text:`Differences for ${change.key}`}),el('thead',{},el('tr',{},el('th',{scope:'col',text:'Field'}),el('th',{scope:'col',text:change.local==='deleted'?'Last refresh':'This file'}),el('th',{scope:'col',text:'Zotero'}))),body);
}

/**
 * The refresh preview: every entry Zotero added, changed or removed, with a choice for
 * each. Conflicts (changed here and in Zotero) default to this file's version.
 * Resolves to {choices} or null when cancelled (nothing changes).
 */
export function zoteroRefreshDialog({path,source,plan}){
  return new Promise(resolve=>{
    const dialog=shell('zotero-refresh','Refresh from Zotero');const choices={};
    const count=kind=>plan.changes.filter(change=>change.kind===kind).length,conflicts=plan.changes.filter(change=>change.conflict).length;
    const parts=[['added',count('added')],['changed',count('changed')],['removed',count('removed')]].filter(([,n])=>n).map(([kind,n])=>`${n} ${kind}`);
    const list=el('div',{className:'zotero-changes'});
    for(const change of plan.changes){
      const labels=choiceLabels(change),name=`zotero-${change.id}`;
      const radios=['local','zotero'].map(value=>{const input=el('input',{type:'radio',name,value,checked:change.choice===value,onchange:()=>{choices[change.id]=value;}});return el('label',{className:'zotero-choice'},input,el('span',{text:labels[value]}));});
      const flags=[el('span',{className:`zotero-badge kind-${change.kind}`,text:KIND[change.kind]})];
      if(change.conflict)flags.push(el('span',{className:'zotero-badge conflict',text:change.local==='deleted'?'Deleted here':'Edited here too'}));
      if(change.cited.length)flags.push(el('span',{className:'zotero-badge cited',text:`Cited in ${change.cited.join(', ')}`}));
      const raw=change.kind==='removed'?change.before:change.after;
      const item=el('fieldset',{className:`zotero-change${change.conflict?' is-conflict':''}`,'data-key':change.key,'data-kind':change.kind},
        el('legend',{},el('code',{text:change.key})),
        el('div',{className:'zotero-flags'},flags),
        el('p',{className:'zotero-summary',text:summaryOf(raw)}),
        change.note?el('p',{className:'zotero-note',text:change.note}):null,
        change.kind==='removed'&&change.cited.length?el('p',{className:'zotero-note warning',text:`Removing it leaves \\cite{${change.key}} without an entry.`}):null,
        change.kind==='changed'?fieldTable(change):null,
        el('details',{},el('summary',{text:'Show entry'}),el('pre',{text:change.kind==='changed'&&change.before?`This file:\n${change.before}\n\nZotero:\n${change.after}`:raw})),
        el('div',{className:'zotero-choices',role:'radiogroup','aria-label':`Choice for ${change.key}`},radios));
      list.append(item);
    }
    const finish=value=>{dialog.close();dialog.remove();resolve(value);};
    dialog.append(el('h2',{text:'Refresh from Zotero'}),
      el('p',{className:'zotero-source',text:`${path} · ${source}`}),
      el('p',{text:`${plan.edited?'You edited this file since the last refresh. ':''}Zotero has ${parts.join(', ')||'no entry changes'}${conflicts?`; ${conflicts} ${conflicts===1?'entry was':'entries were'} also edited here`:''}. Choose for each entry. Nothing changes until you apply, and entries you added by hand are kept.`}),
      list,
      el('div',{className:'modal-actions'},button('Cancel',()=>finish(null)),button('Keep all of this file',()=>finish({choices:Object.fromEntries(plan.changes.map(change=>[change.id,'local']))})),button('Apply choices',()=>finish({choices}),true)));
    dialog.addEventListener('cancel',event=>{event.preventDefault();finish(null);});
    document.body.append(dialog);dialog.showModal();dialog.querySelector('.button.primary').focus();
  });
}

/** More tools → Zotero: this project's linked files and the keys saved on this device. */
export function zoteroPanel({links,keys,blocked,onLink,onRefresh,onUnlink,onRemoveKey}){
  return new Promise(resolve=>{
    const dialog=shell('zotero-panel','Zotero');const status=el('p',{className:'zotero-status',role:'status','aria-live':'polite'});
    const finish=()=>{dialog.close();dialog.remove();resolve();};
    const linked=el('ul',{className:'zotero-links'});
    const draw=()=>{
      linked.replaceChildren(...(links.length?links.map(link=>el('li',{},
        el('div',{},el('strong',{text:link.path}),el('small',{text:`${link.source} · ${link.format==='bibtex'?'BibTeX':'BibLaTeX'} · library version ${link.version}${link.refreshedAt?` · refreshed ${new Date(link.refreshedAt).toLocaleString()}`:''}`})),
        el('div',{className:'zotero-link-actions'},
          button('Refresh',()=>{finish();onRefresh(link.fileId);},false,{disabled:!!blocked,'aria-label':`Refresh ${link.path} from Zotero`}),
          button('Unlink',async()=>{await onUnlink(link.fileId);links=links.filter(item=>item!==link);status.textContent=`${link.path} is no longer linked. The file and its entries stay in the project.`;draw();},false,{'aria-label':`Unlink ${link.path}`})))):[el('li',{className:'zotero-empty',text:'No file in this project is linked to Zotero.'})]));
      saved.replaceChildren(...(keys.length?keys.map(record=>el('li',{},el('span',{text:`Zotero user ${record.userId}${record.username?` (${record.username})`:''}`}),button('Remove key',async()=>{await onRemoveKey(record.userId);keys=keys.filter(item=>item!==record);status.textContent='Key removed from this device. Linked files stay; refreshing asks for a key again.';draw();},false,{'aria-label':`Remove key for Zotero user ${record.userId}`}))):[el('li',{className:'zotero-empty',text:'No Zotero key is saved on this device.'})]));
    };
    const saved=el('ul',{className:'zotero-keys'});
    dialog.append(el('h2',{text:'Zotero'}),
      el('p',{text:'Linked .bib files are ordinary project files that work offline. Refreshing contacts api.zotero.org with the key saved on this device.'}),
      blocked?el('p',{className:'zotero-blocked',role:'note',text:blocked}):null,
      el('h3',{text:'Linked files'}),linked,el('h3',{text:'Keys on this device'}),saved,status,
      el('div',{className:'modal-actions'},button('Close',finish),button('Link to Zotero…',()=>{finish();onLink();},true,{disabled:!!blocked})));
    dialog.addEventListener('cancel',event=>{event.preventDefault();finish();});
    draw();document.body.append(dialog);dialog.showModal();dialog.querySelector('.button.primary:not(:disabled)')?.focus();
  });
}
