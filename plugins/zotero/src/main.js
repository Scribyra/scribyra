// The Zotero plugin (docs/zotero.md, docs/plugins.md). It runs in Scribyra's plugin
// sandbox and does everything through the capability API: it reads .bib and .tex files
// of the open project, creates and patches only the .bib files it created, keeps API
// keys as device-only secrets, contacts only https://api.zotero.org through the host's
// fetch proxy, and draws its dialogs declaratively. Scribyra enforces each of these.
import {citedKeys,readBibliography} from '../../../web/bibtex.js';
import {plainBibText,shortAuthors} from '../../../web/bib-text.js';
import {zoteroApi,ZoteroError,OFFLINE_MESSAGE,validLibraryId,ZOTERO_KEYS_URL} from './api.js';
import {composeLinkedFile,planRefresh,applyRefresh,remoteEntry} from './sync.js';
import {zoteroStore,textHash} from './store.js';
import {runDialog} from './dialog.js';

/* global scribyra */
const store=zoteroStore(scribyra);
const call=(method,params,options)=>scribyra.call(method,params,options);
const notify=text=>call('ui.notify',{text}).catch(()=>{});
const isBib=path=>/\.bib$/i.test(path);
const sourceLabel=link=>`${link.library.type==='user'?'My Library':`Group “${link.library.name}”`}${link.collection?` › ${link.collection.name}`:''}`;
const BAR={label:'Zotero link',refresh:{id:'refresh',label:'Refresh from Zotero',title:'Fetch changes from Zotero; asks before changing entries you edited',blockedTitle:'Switch to Editing to refresh from Zotero',modes:['editing']}};
function modeBlocked(mode,doing){
  if(mode==='viewing')return `Viewing is read only. Switch to Editing to ${doing}.`;
  // A refresh rewrites many entries at once and an import creates a file; neither is a
  // suggestion another person could review line by line, so both are editor-only.
  if(mode==='reviewing')return `Reviewing records suggestions, and ${doing.startsWith('import')?'importing creates a file':'Zotero changes many entries at once'}. Switch to Editing to ${doing}.`;
  return '';
}

// Requests go through the host's proxy; it answers only for https://api.zotero.org.
let online=true;
async function hostFetch(url,init={}){
  try{
    const result=await call('net.fetch',{url,method:init.method||'GET',headers:Object.entries(init.headers||{}),requestId:Math.random().toString(36).slice(2)},{signal:init.signal});
    online=true;
    const status=result.status,headers=new Headers(result.headers);
    return {status,ok:status>=200&&status<300,headers,json:async()=>JSON.parse(result.body),text:async()=>result.body};
  }catch(error){
    if(error.name==='AbortError'||error.code==='aborted')throw Object.assign(new Error('Aborted.'),{name:'AbortError'});
    if(error.code==='offline')online=false;
    throw new TypeError(error.message);
  }
}
const api=apiKey=>zoteroApi({apiKey,fetcher:hostFetch,online:()=>online});

let links=new Map(),refreshing=null;
async function context(){const value=await call('app.context');online=value.online;if(!value.project)throw new Error('Open a project first.');return value;}
async function files(){return call('project.files');}
async function readText(fileId){return (await call('project.read',{fileId})).text;}
async function pathOf(fileId){return (await files()).find(file=>file.id===fileId)?.path||null;}

/** Bars, menu tags and \cite{ suggestions for linked files. */
async function decorate(){
  const present=new Set((await files().catch(()=>[])).map(file=>file.id));
  for(const record of links.values()){
    if(!present.has(record.fileId))continue;
    const summary=`Linked to Zotero · ${sourceLabel(record)}${record.refreshedAt?` · refreshed ${new Date(record.refreshedAt).toLocaleString(undefined,{dateStyle:'medium',timeStyle:'short'})}`:''}`;
    await call('ui.files.decorate',{fileId:record.fileId,tags:['linked'],bar:{label:BAR.label,text:summary,actions:[BAR.refresh]}}).catch(()=>{});
  }
  const entries=[];
  for(const record of links.values())if(present.has(record.fileId))for(const item of Object.values(record.items||{})){
    const entry=readBibliography(item.entry||'').entries[0];if(!entry)continue;
    const get=name=>entry.fields.get(name)?.value||'';
    entries.push({key:item.key,type:entry.type,author:shortAuthors(get('author')||get('editor')),year:(get('year')||get('date')).match(/\d{4}/)?.[0]||'',title:plainBibText(get('title')).slice(0,160)});
  }
  await call('bibliography.set',{entries}).catch(()=>{});
}
async function load(){
  let list=[];try{list=await store.links();}catch{list=[];}
  links=new Map(list.map(link=>[link.fileId,link]));await decorate();
}
async function save(record){await store.saveLink(record);links.set(record.fileId,record);await decorate();}
async function unlink(fileId){await store.unlink(fileId);links.delete(fileId);await call('ui.files.decorate',{fileId,tags:[],bar:null}).catch(()=>{});await decorate();}

/** Citation keys used by the project's TeX sources, with the files using them, and keys other .bib files define. */
async function projectCitations(exceptFile){
  const cited=new Map(),elsewhere=new Set();
  for(const file of await files()){
    if(/\.(tex|ltx)$/i.test(file.path))for(const key of citedKeys(await readText(file.id)))cited.set(key,[...(cited.get(key)||[]),file.path]);
    else if(isBib(file.path)&&file.id!==exceptFile)for(const entry of readBibliography(await readText(file.id)).entries)elsewhere.add(entry.key);
  }
  return {cited,elsewhere};
}

// ---- Link to Zotero -------------------------------------------------------------
async function link({directory=''}={}){
  const open=await context(),blocked=modeBlocked(open.mode,'link Zotero')||(open.project.transient?'Accept and save this project before linking Zotero.':'');
  if(blocked){await notify(blocked);return;}
  const saved=await store.anyKey().catch(()=>null);
  const defaultPath=await call('project.freePath',{path:`${directory}zotero.bib`});
  let session=null,checked=null,busy=false,abort=null,status='',keyVersion=0,collectionList=[],values={identity:saved?.userId||'',key:'',library:'',collection:'',format:'biblatex',path:defaultPath};
  const libraryOptions=()=>checked?checked.libraries.map(entry=>({value:`${entry.type}:${entry.id}`,label:entry.type==='user'?'My Library':`Group: ${entry.name}`})):[];
  const selectedLibrary=()=>checked?.libraries.find(entry=>`${entry.type}:${entry.id}`===values.library)||null;
  const spec=()=>({title:'Link to Zotero',initialFocus:saved?'check':'identity',children:[
    {type:'text',text:'Creates a .bib file in this project from your Zotero library or one of its collections. Refresh it from Zotero later; Scribyra shows the differences before changing entries you edited here. Linking and refreshing contact api.zotero.org only when you ask.'},
    {type:'group',legend:'1. Your Zotero account',children:[
      {type:'field',id:'identity',input:'text',label:'Zotero user ID or username',value:values.identity,placeholder:'For example 1234567',disabled:busy},
      {type:'field',id:'key',input:'password',label:'Read-only API key',value:'',version:keyVersion,placeholder:checked?'Saved on this device after linking':saved?'Saved on this device':'24 letters and digits',disabled:busy,
        help:['Create one at ',{link:ZOTERO_KEYS_URL,text:'zotero.org/settings/keys'},': choose “Create new private key”, tick only “Allow library access”, and leave write and notes access off. For a group library, set group access to “Read Only”. Your user ID is shown on the same page.']},
      {type:'text',tone:'privacy',text:'The key is kept only in this browser on this device. It is sent only to api.zotero.org, and never put into the project, its history, backups, exports, diagnostics or telemetry. Remove it anytime from More tools → Zotero.'},
      {type:'actions',buttons:[{id:'check',label:saved?'Continue with saved key':'Check key',primary:true,disabled:busy}]},
    ]},
    {type:'group',legend:'2. What to link',disabled:busy||!checked,children:[
      {type:'field',id:'library',input:'select',label:'Library',options:libraryOptions(),value:values.library,version:checked?1:0},
      {type:'field',id:'collection',input:'select',label:'Collection',options:[{value:'',label:'Whole library'},...collectionList.map(item=>({value:item.key,label:item.path}))],value:''},
      {type:'field',id:'format',input:'select',label:'Format',options:[{value:'biblatex',label:'BibLaTeX (for biblatex and Biber)'},{value:'bibtex',label:'BibTeX (for natbib and BibTeX styles)'}],value:'biblatex',help:'Zotero’s own export of each item. Keys and entries are written into the file; you can edit them like any file.'},
      {type:'field',id:'path',input:'text',label:'New file in this project',value:defaultPath},
    ]},
    {type:'status',id:'status',text:status},
    {type:'actions',buttons:[{id:'cancel',label:busy?'Stop':'Cancel'},{id:'link',label:'Link and import',primary:true,disabled:busy||!checked}]},
  ]});
  const result=await runDialog(scribyra,{spec,onEvent(event,dialog){
    values={...values,...event.values};
    const work=task=>{
      if(busy)return;busy=true;abort=new AbortController();void dialog.update();
      void (async()=>{
        try{await task(abort.signal);}
        catch(error){if(!dialog.closed){status=error.name==='AbortError'?'Stopped. Nothing was linked.':error.message||String(error);}}
        finally{busy=false;abort=null;if(!dialog.closed)await dialog.update();}
      })();
    };
    async function loadCollections(signal){
      const chosen=selectedLibrary();if(!chosen)return;
      collectionList=[];collectionList=await session.client.collections(chosen,{signal});
    }
    if(event.type==='close'){abort?.abort();return;}
    if(event.type==='cancel'||event.type==='click'&&event.control==='cancel'){if(busy)abort?.abort();else dialog.close(null);return;}
    if(event.type==='change'&&event.control==='library'&&checked)work(signal=>loadCollections(signal));
    if(event.type==='click'&&event.control==='check')work(async signal=>{
      status='Checking the key with api.zotero.org…';await dialog.update();
      const identity=values.identity.trim(),apiKey=values.key.trim()||null;
      let key=apiKey;
      if(!key){const record=identity&&saved&&(identity===saved.userId||identity.toLowerCase()===saved.username.toLowerCase())?saved:null;if(!record)throw new Error('Enter the API key for this Zotero account.');key=record.apiKey;}
      if(!identity)throw new Error('Enter your Zotero user ID or username.');
      const client=api(key),account=await client.currentKey({signal});
      if(validLibraryId(identity)?identity!==account.userId:identity.toLowerCase()!==account.username.toLowerCase())throw new Error(`This key belongs to Zotero user ${account.userId}${account.username?` (“${account.username}”)`:''}, not “${identity}”.`);
      const libraries=account.access.library?[{type:'user',id:account.userId,name:'My Library'}]:[];
      const groupAccess=account.access.groups;
      if(Object.values(groupAccess).some(group=>group.library)){
        for(const group of await client.groups(account.userId,{signal}))if(groupAccess.all?.library||groupAccess[group.id]?.library)libraries.push({type:'group',id:group.id,name:group.name});
      }
      if(!libraries.length)throw new ZoteroError('forbidden','This key cannot read any library. Edit it at zotero.org/settings/keys and allow library access.');
      session={apiKey:key,client};checked={...account,libraries};values.library=`${libraries[0].type}:${libraries[0].id}`;
      status=`Key for ${checked.username?`“${checked.username}” `:''}(user ${checked.userId}) can read ${checked.libraries.length===1?'My Library':`${checked.libraries.length} libraries`}.${checked.write?' It can also change your library; Scribyra only reads, so a read-only key is safer.':''}`;
      keyVersion++;values.key='';
      await loadCollections(signal);
    });
    if(event.type==='click'&&event.control==='link')work(async signal=>{
      const chosen=selectedLibrary();if(!chosen)throw new Error('Check the key and choose a library first.');
      const collectionKey=values.collection,collection=collectionKey?{key:collectionKey,name:collectionList.find(item=>item.key===collectionKey)?.path||collectionKey}:null;
      const choice={userId:checked.userId,username:checked.username,write:checked.write,library:chosen,collection,format:values.format,path:values.path.trim()};
      const now=await context(),again=modeBlocked(now.mode,'link Zotero');if(again)throw new Error(again);
      if(!isBib(choice.path))throw new Error('The linked file needs a .bib name.');
      const path=await call('project.freePath',{path:choice.path});
      status='Fetching entries from api.zotero.org…';await dialog.update();
      const {items,version}=await session.client.items(choice.library,choice.collection?.key,choice.format,{signal});
      const entries=items.map(item=>remoteEntry(item,choice.format)).filter(Boolean);
      const source=sourceLabel(choice);
      const {text,items:base}=composeLinkedFile(entries,source);
      const {id}=await call('project.create',{path,content:text});
      await store.saveKey({userId:choice.userId,username:choice.username,apiKey:session.apiKey,write:choice.write});
      const record={fileId:id,userId:choice.userId,library:{type:choice.library.type,id:choice.library.id,name:choice.library.name},collection:choice.collection,format:choice.format,version,items:base,textHash:await textHash(text),linkedAt:Date.now(),refreshedAt:Date.now()};
      await save(record);
      dialog.close({id,path,count:entries.length,source});
    });
  }});
  if(!result)return;
  await call('project.activate',{fileId:result.id}).catch(()=>{});
  await notify(`Linked ${result.path} to Zotero (${result.source}): ${result.count} ${result.count===1?'entry':'entries'}. The key is saved only on this device.`);
}

// ---- Refresh from Zotero --------------------------------------------------------
function keyDialog(record){
  return runDialog(scribyra,{spec:()=>({title:'Zotero API key needed',initialFocus:'key',children:[
    {type:'text',content:[`This device has no API key for Zotero user ${record.userId}. Enter a read-only key from `,{link:ZOTERO_KEYS_URL,text:'zotero.org/settings/keys'},'. It is kept only on this device and sent only to api.zotero.org.']},
    {type:'field',id:'key',input:'password',label:'Read-only API key',submit:'save'},
    {type:'actions',buttons:[{id:'cancel',label:'Cancel'},{id:'save',label:'Save key and refresh',primary:true}]},
  ]}),onEvent(event,dialog){
    if(event.type==='cancel'||event.type==='click'&&event.control==='cancel')dialog.close(null);
    else if(event.type==='click'&&event.control==='save')dialog.close(event.values.key.trim()||null);
  }});
}
const KIND={added:'Added in Zotero',changed:'Changed in Zotero',removed:'Removed from Zotero'};
function choiceLabels(change){
  if(change.kind==='added')return {zotero:'Add it to this file',local:'Don’t add it'};
  if(change.kind==='removed')return {zotero:'Remove it here too',local:'Keep it in this file'};
  if(change.local==='deleted')return {zotero:'Add Zotero’s version back',local:'Keep it deleted here'};
  return {zotero:'Use Zotero’s version',local:'Keep this file’s version'};
}
const summaryOf=raw=>{const entry=readBibliography(raw).entries[0];if(!entry)return '';const get=name=>entry.fields.get(name)?.value||'';const year=(get('year')||get('date')).match(/\d{4}/)?.[0]||'';return [shortAuthors(get('author')||get('editor')),year].filter(Boolean).join(', ')+(get('title')?` · ${plainBibText(get('title')).slice(0,120)}`:'');};
function refreshDialog({path,source,plan}){
  const count=kind=>plan.changes.filter(change=>change.kind===kind).length,conflicts=plan.changes.filter(change=>change.conflict).length;
  const parts=[['added',count('added')],['changed',count('changed')],['removed',count('removed')]].filter(([,n])=>n).map(([kind,n])=>`${n} ${kind}`);
  const changes=plan.changes.map((change,i)=>{
    const labels=choiceLabels(change),raw=change.kind==='removed'?change.before:change.after;
    const badges=[{text:KIND[change.kind],tone:change.kind}];
    if(change.conflict)badges.push({text:change.local==='deleted'?'Deleted here':'Edited here too',tone:'conflict'});
    if(change.cited.length)badges.push({text:`Cited in ${change.cited.join(', ')}`,tone:'cited'});
    return {type:'group',legend:change.key,legendCode:true,key:change.key,kind:change.kind,tone:change.conflict?'conflict':undefined,children:[
      {type:'badges',items:badges},
      {type:'text',tone:'summary',text:summaryOf(raw)},
      ...(change.note?[{type:'text',tone:'note',text:change.note}]:[]),
      ...(change.kind==='removed'&&change.cited.length?[{type:'text',tone:'warning',text:`Removing it leaves \\cite{${change.key}} without an entry.`}]:[]),
      ...(change.kind==='changed'&&change.fields.length?[{type:'table',caption:`Differences for ${change.key}`,columns:['Field',change.local==='deleted'?'Last refresh':'This file','Zotero'],tones:['','before','after'],rows:change.fields.slice(0,40).map(item=>[item.field,item.before??'—',item.after??'—'])}]:[]),
      {type:'details',summary:'Show entry',text:change.kind==='changed'&&change.before?`This file:\n${change.before}\n\nZotero:\n${change.after}`:raw},
      {type:'choice',id:`c${i}`,label:`Choice for ${change.key}`,options:[{value:'local',label:labels.local},{value:'zotero',label:labels.zotero}],value:change.choice},
    ]};
  });
  return runDialog(scribyra,{spec:()=>({title:'Refresh from Zotero',wide:true,children:[
    {type:'text',tone:'source',text:`${path} · ${source}`},
    {type:'text',text:`${plan.edited?'You edited this file since the last refresh. ':''}Zotero has ${parts.join(', ')||'no entry changes'}${conflicts?`; ${conflicts} ${conflicts===1?'entry was':'entries were'} also edited here`:''}. Choose for each entry. Nothing changes until you apply, and entries you added by hand are kept.`},
    {type:'section',label:'Changes',children:changes},
    {type:'actions',buttons:[{id:'cancel',label:'Cancel'},{id:'keep',label:'Keep all of this file'},{id:'apply',label:'Apply choices',primary:true}]},
  ]}),onEvent(event,dialog){
    if(event.type==='cancel'||event.type==='click'&&event.control==='cancel')dialog.close(null);
    else if(event.type==='click'&&event.control==='keep')dialog.close({choices:Object.fromEntries(plan.changes.map(change=>[change.id,'local']))});
    else if(event.type==='click'&&event.control==='apply')dialog.close({choices:Object.fromEntries(plan.changes.map((change,i)=>[change.id,event.values[`c${i}`]||change.choice]))});
  }});
}
async function refresh(fileId){
  if(refreshing)return refreshing;
  refreshing=(async()=>{
    const open=await context(),blocked=modeBlocked(open.mode,'refresh from Zotero')||(open.project.transient?'Accept and save this project before linking Zotero.':'');
    if(blocked){await notify(blocked);return;}
    const path=fileId?await pathOf(fileId):null,record=fileId?links.get(fileId)||await store.link(fileId):null;
    if(!path||!record){await notify('This file is not linked to Zotero on this device.');return;}
    if(!open.online){await notify(OFFLINE_MESSAGE);return;}
    let saved=await store.savedKey(record.userId);
    if(!saved){
      const apiKey=await keyDialog(record);if(!apiKey)return;
      const account=await api(apiKey).currentKey();
      if(account.userId!==record.userId)throw new Error(`This key belongs to Zotero user ${account.userId}, but the file is linked to user ${record.userId}.`);
      saved={userId:record.userId,username:account.username,apiKey,write:account.write};await store.saveKey(saved);
    }
    const client=api(saved.apiKey);
    await notify(`Checking Zotero for changes to ${path}…`);
    const result=await client.versions(record.library,record.collection?.key,record.version);
    const text=await readText(fileId),hash=await textHash(text);
    if(result.notModified){await save({...record,refreshedAt:Date.now()});await notify(`${path} is up to date with Zotero (library version ${record.version}).`);return;}
    const changed=[...result.versions].filter(([key,version])=>!record.items[key]||version>record.items[key].version).map(([key])=>key);
    const fetched=new Map();
    for(const item of await client.itemsByKey(record.library,changed,record.format)){const entry=remoteEntry(item,record.format);if(entry)fetched.set(entry.itemKey,entry);}
    if(await readText(fileId)!==text)throw new Error(`${path} changed while Zotero was being read. Refresh again.`);
    const {cited,elsewhere}=await projectCitations(fileId);
    const plan=planRefresh({items:record.items,text,present:new Set(result.versions.keys()),fetched,cited,elsewhere,edited:hash!==record.textHash});
    if(!plan.changes.length){await save({...record,version:result.version,items:plan.base,refreshedAt:Date.now()});await notify(`${path} is up to date with Zotero (library version ${result.version}).${plan.edited?' Your edits in this file are kept.':''}`);return;}
    let choices={};
    if(plan.review){
      const decision=await refreshDialog({path,source:sourceLabel(record),plan});
      if(!decision){await notify('Refresh cancelled. Nothing changed.');return;}
      choices=decision.choices;
    }
    const latest=await context(),blockedNow=modeBlocked(latest.mode,'refresh from Zotero');if(blockedNow)throw new Error(blockedNow);
    let current;try{current=await readText(fileId);}catch{current=null;}
    if(current!==text)throw new Error(`${path} changed while you reviewed the refresh. Nothing was applied; refresh again.`);
    const applied=applyRefresh(text,plan,choices,{cited,elsewhere});
    if(applied.edits.length)await call('project.patch',{fileId,edits:applied.edits});
    await save({...record,version:result.version,items:applied.items,textHash:await textHash(applied.text),refreshedAt:Date.now()});
    const taken=plan.changes.filter(change=>(choices[change.id]??change.choice)==='zotero'),kept=plan.changes.length-taken.length;
    const count=kind=>taken.filter(change=>change.kind===kind).length;
    await notify(`Refreshed ${path} from Zotero: ${count('added')} added, ${count('changed')} changed, ${count('removed')} removed${kept?`, ${kept} kept as in this file`:''}.${applied.lost.length?` Still cited but no longer in any bibliography: ${applied.lost.join(', ')}.`:''}`);
  })();
  try{return await refreshing;}finally{refreshing=null;}
}

// ---- More tools → Zotero ----------------------------------------------------------
async function panel(){
  const open=await context(),blocked=modeBlocked(open.mode,'refresh from Zotero')||(open.project.transient?'Accept and save this project before linking Zotero.':'');
  const paths=new Map((await files()).map(file=>[file.id,file.path]));
  let list=[...links.values()].map(record=>({...record,path:paths.get(record.fileId),source:sourceLabel(record)})).filter(record=>record.path);
  let keys=await store.keys().catch(()=>[]),status='';
  const spec=()=>({title:'Zotero',initialFocus:blocked?undefined:'link',children:[
    {type:'text',text:'Linked .bib files are ordinary project files that work offline. Refreshing contacts api.zotero.org with the key saved on this device.'},
    ...(blocked?[{type:'text',tone:'blocked',text:blocked}]:[]),
    {type:'heading',text:'Linked files'},
    {type:'list',label:'Linked files',empty:'No file in this project is linked to Zotero.',items:list.map((link,i)=>({title:link.path,detail:`${link.source} · ${link.format==='bibtex'?'BibTeX':'BibLaTeX'} · library version ${link.version}${link.refreshedAt?` · refreshed ${new Date(link.refreshedAt).toLocaleString()}`:''}`,actions:[{id:`refresh-${i}`,label:'Refresh',ariaLabel:`Refresh ${link.path} from Zotero`,disabled:!!blocked},{id:`unlink-${i}`,label:'Unlink',ariaLabel:`Unlink ${link.path}`}]}))},
    {type:'heading',text:'Keys on this device'},
    {type:'list',label:'Keys on this device',empty:'No Zotero key is saved on this device.',items:keys.map((record,i)=>({title:`Zotero user ${record.userId}${record.username?` (${record.username})`:''}`,actions:[{id:`key-${i}`,label:'Remove key',ariaLabel:`Remove key for Zotero user ${record.userId}`}]}))},
    {type:'status',id:'status',text:status},
    {type:'actions',buttons:[{id:'close',label:'Close'},{id:'link',label:'Link to Zotero…',primary:true,disabled:!!blocked}]},
  ]});
  const next=await runDialog(scribyra,{spec,async onEvent(event,dialog){
    if(event.type==='cancel'||event.type==='click'&&event.control==='close'){dialog.close(null);return;}
    if(event.type!=='click')return;
    const [kind,index]=event.control.split('-');
    if(event.control==='link'){dialog.close({action:'link'});return;}
    if(kind==='refresh'){dialog.close({action:'refresh',fileId:list[+index].fileId});return;}
    if(kind==='unlink'){const link=list[+index];await unlink(link.fileId);list=list.filter(item=>item!==link);status=`${link.path} is no longer linked. The file and its entries stay in the project.`;await dialog.update();}
    if(kind==='key'){const record=keys[+index];await store.removeKey(record.userId);keys=keys.filter(item=>item!==record);status='Key removed from this device. Linked files stay; refreshing asks for a key again.';await dialog.update();}
  }});
  if(next?.action==='link')await link();
  if(next?.action==='refresh')await refresh(next.fileId);
}

// Failures are explained to the person here; plugins never report to telemetry.
const quiet=run=>async(...args)=>{try{return await run(...args);}catch(error){if(error?.name!=='AbortError')await notify(error?.message||String(error));}return null;};
scribyra.on('project.opened',()=>void load());
scribyra.on('project.closed',()=>{links=new Map();});
scribyra.handle('command.run',quiet(async({command})=>{if(command==='open')await panel();}));
scribyra.handle('fileAction.run',quiet(async({action,fileId,directory})=>{
  if(action==='link')await link({directory});
  else if(action==='refresh')await refresh(fileId);
  else if(action==='links')await panel();
}));
scribyra.handle('fileBar.run',quiet(async({action,fileId})=>{if(action==='refresh')await refresh(fileId);}));
