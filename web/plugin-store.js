// Installed plugins and their device-local data (docs/plugins.md). Two IndexedDB
// databases, both apart from projects (scribyra-v1):
//
//   scribyra-plugins
//     plugins:  id → {id, version, manifest, sha256, source, sourceUrl, granted, enabled,
//               installedAt, updatedAt, previous, addedOrigins}; addedOrigins are the
//               https origins the person allowed later through "network.ask"
//     packages: "<id>@<version>" → {id, version, bytes}
//     data:     [pluginId, scope, key] → {pluginId, scope, key, value, size}; scope '' is the
//               plugin's own storage, otherwise a project id (projectData)
//     owned:    [pluginId, projectId, fileId] → files a plugin created or the person picked
//   scribyra-plugin-secrets
//     secrets:  [pluginId, name] → {pluginId, name, value, origin}; a secret with an origin is
//               bound to it: the host adds it to requests to that origin only, and never
//               hands it back to the plugin
//
// Plugins never see these records: the host reads and writes them for a plugin, keyed by
// the plugin id from its own instance record. Nothing here is part of a project, so it
// never reaches history, backups, exports, direct sessions, diagnostics or telemetry.
import {openDB} from 'idb';

export const PLUGINS_DATABASE='scribyra-plugins',SECRETS_DATABASE='scribyra-plugin-secrets';
let plugins,secrets;
function db(){
  plugins||=openDB(PLUGINS_DATABASE,1,{upgrade(store){
    store.createObjectStore('plugins',{keyPath:'id'});
    store.createObjectStore('packages');
    const data=store.createObjectStore('data',{keyPath:['pluginId','scope','key']});data.createIndex('plugin','pluginId');data.createIndex('scope','scope');
    const owned=store.createObjectStore('owned',{keyPath:['pluginId','projectId','fileId']});owned.createIndex('plugin','pluginId');owned.createIndex('project','projectId');
  }}).catch(error=>{plugins=null;throw error;});
  return plugins;
}
function secretDb(){
  secrets||=openDB(SECRETS_DATABASE,1,{upgrade(store){store.createObjectStore('secrets',{keyPath:['pluginId','name']}).createIndex('plugin','pluginId');}}).catch(error=>{secrets=null;throw error;});
  return secrets;
}
const sizeOf=value=>new TextEncoder().encode(JSON.stringify(value)).length;
async function deleteByIndex(database,store,index,value){
  const tx=database.transaction(store,'readwrite');
  for(const key of await tx.store.index(index).getAllKeys(value))tx.store.delete(key);
  await tx.done;
}

export const pluginStore={
  async list(){return (await db()).getAll('plugins');},
  async get(id){return (await (await db()).get('plugins',id))||null;},
  async put(record){await (await db()).put('plugins',record);},
  async packageBytes(id,version){return (await (await db()).get('packages',`${id}@${version}`))?.bytes||null;},
  async savePackage(id,version,bytes){await (await db()).put('packages',{id,version,bytes},`${id}@${version}`);},
  async deletePackage(id,version){await (await db()).delete('packages',`${id}@${version}`);},
  /** Installs or replaces a plugin record together with its package, atomically. */
  async install(record,bytes){
    const tx=(await db()).transaction(['plugins','packages'],'readwrite');
    tx.objectStore('packages').put({id:record.id,version:record.version,bytes},`${record.id}@${record.version}`);
    tx.objectStore('plugins').put(record);await tx.done;
  },
  /** Everything a plugin owns on this device, including its secrets. */
  async uninstall(id){
    const database=await db(),tx=database.transaction(['plugins','packages','data','owned'],'readwrite');
    tx.objectStore('plugins').delete(id);
    for(const key of await tx.objectStore('packages').getAllKeys())if(String(key).startsWith(`${id}@`))tx.objectStore('packages').delete(key);
    for(const key of await tx.objectStore('data').index('plugin').getAllKeys(id))tx.objectStore('data').delete(key);
    for(const key of await tx.objectStore('owned').index('plugin').getAllKeys(id))tx.objectStore('owned').delete(key);
    await tx.done;
    await deleteByIndex(await secretDb(),'secrets','plugin',id);
  },
  // Key-value data: scope '' for the plugin's own storage, a project id for projectData.
  async dataGet(pluginId,scope,key){return (await (await db()).get('data',[pluginId,scope,key]))?.value;},
  async dataKeys(pluginId,scope){return (await (await db()).getAllFromIndex('data','plugin',pluginId)).filter(item=>item.scope===scope).map(item=>item.key).sort();},
  async dataSize(pluginId,scope){return (await (await db()).getAllFromIndex('data','plugin',pluginId)).filter(item=>item.scope===scope).reduce((sum,item)=>sum+item.size,0);},
  async dataSet(pluginId,scope,key,value,limit){
    const database=await db(),tx=database.transaction('data','readwrite'),size=sizeOf(value);
    const items=(await tx.store.index('plugin').getAll(pluginId)).filter(item=>item.scope===scope&&item.key!==key);
    if(items.reduce((sum,item)=>sum+item.size,0)+size>limit){tx.abort();await tx.done.catch(()=>{});return false;}
    tx.store.put({pluginId,scope,key,value,size});await tx.done;return true;
  },
  async dataDelete(pluginId,scope,key){await (await db()).delete('data',[pluginId,scope,key]);},
  async owned(pluginId,projectId){return (await (await db()).getAllFromIndex('owned','plugin',pluginId)).filter(item=>item.projectId===projectId);},
  async own(pluginId,projectId,fileId,how){await (await db()).put('owned',{pluginId,projectId,fileId,how,at:Date.now()});},
  async disown(pluginId,projectId,fileId){await (await db()).delete('owned',[pluginId,projectId,fileId]);},
  /** A deleted project takes every plugin's data and ownership for it along. */
  async forgetProject(projectId){
    const database=await db();
    await deleteByIndex(database,'data','scope',projectId);
    await deleteByIndex(database,'owned','project',projectId);
  },
  async secretGet(pluginId,name){return (await (await secretDb()).get('secrets',[pluginId,name]))?.value??null;},
  async secretRecord(pluginId,name){return (await (await secretDb()).get('secrets',[pluginId,name]))||null;},
  async secretNames(pluginId){return (await (await secretDb()).getAllFromIndex('secrets','plugin',pluginId)).map(item=>item.name).sort();},
  async secretSet(pluginId,name,value,origin=null){await (await secretDb()).put('secrets',{pluginId,name,value,...(origin?{origin}:{})});},
  async secretDelete(pluginId,name){await (await secretDb()).delete('secrets',[pluginId,name]);},
};

const DEVELOPER_KEY='scribyra-plugin-developer';
export function developerMode(){try{return localStorage.getItem(DEVELOPER_KEY)==='1';}catch{return false;}}
export function setDeveloperMode(on){try{if(on)localStorage.setItem(DEVELOPER_KEY,'1');else localStorage.removeItem(DEVELOPER_KEY);}catch{}}
