// Bibliography import and the Zotero link for the open project. Everything that
// changes the project goes through the project command layer (files.add, text.patch),
// so it obeys Viewing and Reviewing, enters history and replicates like any edit.
// Links and keys stay on this device (zotero-store.js); nothing here records telemetry.
import {checkBibliography,citedKeys,readBibliography} from './bibtex.js';
import {zoteroApi,ZoteroError,OFFLINE_MESSAGE,validLibraryId} from './zotero-api.js';
import {zoteroStore,textHash} from './zotero-store.js';
import {composeLinkedFile,planRefresh,applyRefresh,remoteEntry} from './zotero-sync.js';
import {bibliographyReport,zoteroLinkDialog,zoteroKeyDialog,zoteroRefreshDialog,zoteroPanel} from './zotero-dialog.js';
import {projectFiles,projectNode,assertPath} from './model.js';

const isBib=path=>/\.bib$/i.test(path);
export const sourceLabel=link=>`${link.library.type==='user'?'My Library':`Group “${link.library.name}”`}${link.collection?` › ${link.collection.name}`:''}`;
export function modeBlocked(mode,doing){
  if(mode==='viewing')return `Viewing is read only. Switch to Editing to ${doing}.`;
  // A refresh rewrites many entries at once and an import creates a file; neither is a
  // suggestion another person could review line by line, so both are editor-only.
  if(mode==='reviewing')return `Reviewing records suggestions, and ${doing.startsWith('import')?'importing creates a file':'Zotero changes many entries at once'}. Switch to Editing to ${doing}.`;
  return '';
}
/** A free path like zotero.bib, zotero-2.bib, … (case-insensitive, as the tree compares). */
export function freePath(doc,path){
  const taken=new Set(projectFiles(doc).map(file=>file.path.toLowerCase()));
  if(!taken.has(path.toLowerCase()))return path;
  const dot=path.lastIndexOf('.'),stem=dot>path.lastIndexOf('/')?path.slice(0,dot):path,ext=dot>path.lastIndexOf('/')?path.slice(dot):'';
  for(let n=2;n<1000;n++){const next=`${stem}-${n}${ext}`;if(!taken.has(next.toLowerCase()))return next;}
  throw new Error('Choose another file name.');
}
/** Citation keys used by the project's TeX sources, with the files using them, and keys other .bib files define. */
function projectCitations(doc,exceptFile){
  const cited=new Map(),elsewhere=new Set();
  for(const file of projectFiles(doc)){
    if(file.binary||file.conflict)continue;
    if(/\.(tex|ltx)$/i.test(file.path))for(const key of citedKeys(doc.getText(`text:${file.id}`).toString()))cited.set(key,[...(cited.get(key)||[]),file.path]);
    else if(isBib(file.path)&&file.id!==exceptFile)for(const entry of readBibliography(doc.getText(`text:${file.id}`).toString()).entries)elsewhere.add(entry.key);
  }
  return {cited,elsewhere};
}

/**
 * `context()` describes the open project: {doc, projectId, commands, mode, transient}.
 * It returns null when no project is open. `notify` shows a status message.
 */
export function zoteroController({context,notify,activate,onLinks=()=>{},fetcher}){
  let links=new Map(),loadedFor=null,refreshing=null;
  const api=apiKey=>zoteroApi({apiKey,...(fetcher?{fetcher}:{})});
  function current(){const value=context();if(!value)throw new Error('Open a project first.');return value;}
  function same(open){const now=context();if(!now||now.doc!==open.doc)throw new Error('The project changed. Nothing was linked or refreshed.');return now;}
  async function load(projectId){
    loadedFor=projectId;let list=[];
    try{list=await zoteroStore.links(projectId);}catch{list=[];}
    if(loadedFor!==projectId)return;
    links=new Map(list.map(link=>[link.fileId,link]));onLinks();
  }
  /** Shows the import report when any .bib file has problems; resolves to whether to go on. */
  async function checkImport(entries){
    const results=[];
    for(const entry of entries){
      if(entry.folder||typeof entry.content!=='string'||!isBib(entry.path))continue;
      if(entry.content.charCodeAt(0)===0xfeff)entry.content=entry.content.slice(1);
      const result=checkBibliography(entry.content);if(result.problems.length)results.push({path:entry.path,...result});
    }
    return results.length?bibliographyReport(results):true;
  }
  function refreshBlocked(){const open=context();return open?modeBlocked(open.mode,'refresh from Zotero')||(open.transient?'Accept and save this project before linking Zotero.':''):'';}
  async function link({directory=''}={}){
    const open=current(),blocked=modeBlocked(open.mode,'link Zotero')||(open.transient?'Accept and save this project before linking Zotero.':'');
    if(blocked){notify(blocked);return;}
    const saved=await zoteroStore.anyKey().catch(()=>null);
    let session=null;
    const result=await zoteroLinkDialog({saved,defaultPath:freePath(open.doc,`${directory}zotero.bib`),
      async verify({identity,apiKey},signal){
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
        session={apiKey:key,client};
        return {...account,libraries};
      },
      collections:(library,signal)=>session.client.collections(library,{signal}),
      async link(choice,progress,signal){
        const open=same(current());
        const again=modeBlocked(open.mode,'link Zotero');if(again)throw new Error(again);
        assertPath(choice.path);if(!isBib(choice.path))throw new Error('The linked file needs a .bib name.');
        const path=freePath(open.doc,choice.path);
        progress('Fetching entries from api.zotero.org…');
        const {items,version}=await session.client.items(choice.library,choice.collection?.key,choice.format,{signal});
        const entries=items.map(item=>remoteEntry(item,choice.format)).filter(Boolean);
        const source=sourceLabel(choice);
        const {text,items:base}=composeLinkedFile(entries,source);
        same(open);
        const id=open.commands.run({op:'files.add',entries:[{kind:'text',path,content:text}]}).ids[0];
        await zoteroStore.saveKey({userId:choice.userId,username:choice.username,apiKey:session.apiKey,write:choice.write});
        const record={projectId:open.projectId,fileId:id,userId:choice.userId,library:{type:choice.library.type,id:choice.library.id,name:choice.library.name},collection:choice.collection,format:choice.format,version,items:base,textHash:await textHash(text),linkedAt:Date.now(),refreshedAt:Date.now()};
        await zoteroStore.saveLink(record);links.set(id,record);onLinks();
        return {id,path,count:entries.length,source};
      }});
    if(!result)return;
    activate(result.id);
    notify(`Linked ${result.path} to Zotero (${result.source}): ${result.count} ${result.count===1?'entry':'entries'}. The key is saved only on this device.`);
  }
  async function refresh(fileId){
    if(refreshing)return refreshing;
    refreshing=(async()=>{
      const open=current(),blocked=refreshBlocked();if(blocked){notify(blocked);return;}
      const node=projectNode(open.doc,fileId),record=links.get(fileId)||await zoteroStore.link(open.projectId,fileId);
      if(!node||node.folder||node.binary||!record){notify('This file is not linked to Zotero on this device.');return;}
      if(globalThis.navigator?.onLine===false){notify(OFFLINE_MESSAGE);return;}
      let saved=await zoteroStore.savedKey(record.userId);
      if(!saved){const apiKey=await zoteroKeyDialog({link:record});if(!apiKey)return;const account=await api(apiKey).currentKey();if(account.userId!==record.userId)throw new Error(`This key belongs to Zotero user ${account.userId}, but the file is linked to user ${record.userId}.`);saved={userId:record.userId,username:account.username,apiKey,write:account.write};await zoteroStore.saveKey(saved);}
      const client=api(saved.apiKey);
      notify(`Checking Zotero for changes to ${node.path}…`);
      const result=await client.versions(record.library,record.collection?.key,record.version);
      const text=open.doc.getText(`text:${fileId}`).toString(),hash=await textHash(text);
      if(result.notModified){await save({...record,refreshedAt:Date.now()});notify(`${node.path} is up to date with Zotero (library version ${record.version}).`);return;}
      const changed=[...result.versions].filter(([key,version])=>!record.items[key]||version>record.items[key].version).map(([key])=>key);
      const fetched=new Map();
      for(const item of await client.itemsByKey(record.library,changed,record.format)){const entry=remoteEntry(item,record.format);if(entry)fetched.set(entry.itemKey,entry);}
      const now=same(open);
      if(now.doc.getText(`text:${fileId}`).toString()!==text)throw new Error(`${node.path} changed while Zotero was being read. Refresh again.`);
      const {cited,elsewhere}=projectCitations(open.doc,fileId);
      const plan=planRefresh({items:record.items,text,present:new Set(result.versions.keys()),fetched,cited,elsewhere,edited:hash!==record.textHash});
      if(!plan.changes.length){await save({...record,version:result.version,items:plan.base,refreshedAt:Date.now()});notify(`${node.path} is up to date with Zotero (library version ${result.version}).${plan.edited?' Your edits in this file are kept.':''}`);return;}
      let choices={};
      if(plan.review){
        const decision=await zoteroRefreshDialog({path:node.path,source:sourceLabel(record),plan});
        if(!decision){notify('Refresh cancelled. Nothing changed.');return;}
        choices=decision.choices;
      }
      const latest=same(open);const blockedNow=modeBlocked(latest.mode,'refresh from Zotero');if(blockedNow)throw new Error(blockedNow);
      if(!projectNode(latest.doc,fileId)||latest.doc.getText(`text:${fileId}`).toString()!==text)throw new Error(`${node.path} changed while you reviewed the refresh. Nothing was applied; refresh again.`);
      const applied=applyRefresh(text,plan,choices,{cited,elsewhere});
      if(applied.edits.length)latest.commands.run({op:'text.patch',edits:applied.edits.map(edit=>({fileId,...edit}))});
      await save({...record,version:result.version,items:applied.items,textHash:await textHash(applied.text),refreshedAt:Date.now()});
      const taken=plan.changes.filter(change=>(choices[change.id]??change.choice)==='zotero'),kept=plan.changes.length-taken.length;
      const count=kind=>taken.filter(change=>change.kind===kind).length;
      notify(`Refreshed ${node.path} from Zotero: ${count('added')} added, ${count('changed')} changed, ${count('removed')} removed${kept?`, ${kept} kept as in this file`:''}.${applied.lost.length?` Still cited but no longer in any bibliography: ${applied.lost.join(', ')}.`:''}`);
    })();
    try{return await refreshing;}finally{refreshing=null;}
  }
  async function save(record){await zoteroStore.saveLink(record);links.set(record.fileId,record);onLinks();}
  async function unlink(fileId){const open=current();await zoteroStore.unlink(open.projectId,fileId);links.delete(fileId);onLinks();}
  async function panel(){
    const open=current(),list=[...links.values()].map(record=>({...record,path:projectNode(open.doc,record.fileId)?.path,source:sourceLabel(record)})).filter(record=>record.path);
    const keys=await zoteroStore.keys().catch(()=>[]);
    await zoteroPanel({links:list,keys:keys.map(({apiKey,...rest})=>rest),blocked:refreshBlocked(),onLink:()=>void link().catch(error=>notify(error.message)),onRefresh:id=>void refresh(id).catch(error=>notify(error.message)),onUnlink:unlink,onRemoveKey:id=>zoteroStore.removeKey(id)});
  }
  return {
    load,checkImport,link,refresh,unlink,panel,
    linked:fileId=>links.get(fileId)||null,
    get refreshing(){return !!refreshing;},
    close(){links=new Map();loadedFor=null;},
    forgetProject:projectId=>zoteroStore.forgetProject(projectId).catch(()=>{}),
  };
}
