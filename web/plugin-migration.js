// Zotero used to be built in, with keys and links in IndexedDB `scribyra-zotero`
// (docs/zotero.md). After the update the same links must keep working, so on start this
// moves that data into the Zotero plugin's own device-local storage, installs the
// official Zotero plugin from the bundled, signed registry with the permissions the
// built-in code had, and deletes the old database. It runs only when that database
// exists, so new browsers fetch and install nothing. See docs/plugins.md#open-decisions.
import {pluginStore} from './plugin-store.js';
import {readPackage,compareVersions,policyDecision} from './plugin-manifest.js';
import {sha256Hex} from './plugin-registry.js';

export const LEGACY_ZOTERO_DATABASE='scribyra-zotero',ZOTERO_PLUGIN_ID='com.scribyra.zotero';

/** Opens the legacy database only if it already exists; never creates it. */
function openExisting(name){
  return new Promise(resolve=>{
    let created=false;const request=indexedDB.open(name);
    request.onupgradeneeded=()=>{created=true;request.transaction.abort();};
    request.onsuccess=()=>{if(created){request.result.close();resolve(null);}else resolve(request.result);};
    request.onerror=()=>resolve(null);request.onblocked=()=>resolve(null);
  });
}
const all=(db,store)=>new Promise((resolve,reject)=>{if(!db.objectStoreNames.contains(store)){resolve([]);return;}const request=db.transaction(store).objectStore(store).getAll();request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);});
const removeDatabase=name=>new Promise(resolve=>{const request=indexedDB.deleteDatabase(name);request.onsuccess=request.onerror=request.onblocked=()=>resolve();});

/**
 * Returns {links, keys} when something was moved, or null. `catalog()` loads the official
 * registry module; it is called only when there is legacy data to move.
 */
export async function migrateLegacyZotero({catalog,policy}){
  if(typeof indexedDB==='undefined')return null;
  if(typeof indexedDB.databases==='function'){try{if(!(await indexedDB.databases()).some(entry=>entry.name===LEGACY_ZOTERO_DATABASE))return null;}catch{}}
  const db=await openExisting(LEGACY_ZOTERO_DATABASE);if(!db)return null;
  let keys,links;
  try{[keys,links]=await Promise.all([all(db,'keys'),all(db,'links')]);}finally{db.close();}
  if(!keys.length&&!links.length){await removeDatabase(LEGACY_ZOTERO_DATABASE);return null;}
  let record=await pluginStore.get(ZOTERO_PLUGIN_ID);
  if(!record){
    const {officialRegistry,officialPackage}=await catalog();
    const registry=await officialRegistry(),plugin=registry.plugins.find(entry=>entry.id===ZOTERO_PLUGIN_ID);
    if(!plugin)throw new Error('The Zotero plugin is not in the official registry.');
    const entry=plugin.versions.filter(version=>version.compatible).sort((a,b)=>compareVersions(b.version,a.version))[0];
    // An organisation that does not allow Zotero keeps the old data untouched.
    if(!entry||policyDecision(policy,{id:plugin.id,version:entry.version,sha256:entry.sha256,source:'official',action:'install'}))return null;
    const {bytes}=await officialPackage(plugin,entry),{manifest}=readPackage(bytes);
    record={id:manifest.id,version:manifest.version,manifest,sha256:await sha256Hex(bytes),source:'official',sourceUrl:null,granted:manifest.permissions,enabled:true,installedAt:Date.now(),updatedAt:Date.now(),previous:null,migrated:true};
    await pluginStore.install(record,bytes);
  }
  // The plugin's layout (plugins/zotero/src/store.js): accounts in storage, keys as
  // secrets, one projectData entry per linked file, and ownership of the linked files.
  const accounts=(await pluginStore.dataGet(ZOTERO_PLUGIN_ID,'','accounts'))||{};
  for(const key of keys){
    accounts[key.userId]={userId:String(key.userId),username:key.username||'',write:!!key.write,savedAt:key.savedAt||Date.now()};
    await pluginStore.secretSet(ZOTERO_PLUGIN_ID,`key-${key.userId}`,key.apiKey);
  }
  await pluginStore.dataSet(ZOTERO_PLUGIN_ID,'','accounts',accounts,1024*1024);
  for(const link of links){
    const {projectId,apiKey,...rest}=link;
    await pluginStore.dataSet(ZOTERO_PLUGIN_ID,projectId,`link:${link.fileId}`,rest,4*1024*1024);
    await pluginStore.own(ZOTERO_PLUGIN_ID,projectId,link.fileId,'created');
  }
  await removeDatabase(LEGACY_ZOTERO_DATABASE);
  return {links:links.length,keys:keys.length};
}
