// Zotero links and API keys on this device only, in their own IndexedDB database
// ('scribyra-zotero'), apart from projects ('scribyra-v1'). Nothing here is part of a
// project, so keys never reach project storage, history, backups, ZIP exports, direct
// sessions, diagnostics or telemetry. Clearing this site's data removes it.
//
//   keys:  userID → {userId, username, apiKey, write, savedAt}
//   links: "<projectId>/<fileId>" → {projectId, fileId, userId, library, collection,
//          format, version, items, textHash, linkedAt, refreshedAt}
// `items` is the refresh base (see zotero-sync.js): per Zotero item key, the citation
// key and entry Scribyra last wrote. Links name a library, never contain the key.
import {openDB} from 'idb';

export const ZOTERO_DATABASE='scribyra-zotero';
let database;
function db(){
  database||=openDB(ZOTERO_DATABASE,1,{upgrade(store){store.createObjectStore('keys');const links=store.createObjectStore('links');links.createIndex('project','projectId');}}).catch(error=>{database=null;throw error;});
  return database;
}
const linkId=(projectId,fileId)=>`${projectId}/${fileId}`;

export async function textHash(text){
  const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map(byte=>byte.toString(16).padStart(2,'0')).join('');
}
export const zoteroStore={
  async savedKey(userId){return userId?(await (await db()).get('keys',String(userId)))||null:null;},
  /** Saved keys without the key itself, for listing. */
  async keys(){return (await (await db()).getAll('keys')).map(({apiKey,...rest})=>rest);},
  async anyKey(){const all=await (await db()).getAll('keys');return all.sort((a,b)=>b.savedAt-a.savedAt)[0]||null;},
  async saveKey(record){await (await db()).put('keys',{userId:String(record.userId),username:record.username||'',apiKey:record.apiKey,write:!!record.write,savedAt:Date.now()},String(record.userId));},
  async removeKey(userId){await (await db()).delete('keys',String(userId));},
  async link(projectId,fileId){return (await (await db()).get('links',linkId(projectId,fileId)))||null;},
  async links(projectId){return (await db()).getAllFromIndex('links','project',projectId);},
  async saveLink(record){
    if('apiKey' in record)throw new Error('A Zotero link never holds the API key.');
    await (await db()).put('links',record,linkId(record.projectId,record.fileId));
  },
  async unlink(projectId,fileId){await (await db()).delete('links',linkId(projectId,fileId));},
  /** When a project is deleted from this device, its links go with it. */
  async forgetProject(projectId){const store=await db(),keys=await store.getAllKeysFromIndex('links','project',projectId);const tx=store.transaction('links','readwrite');for(const key of keys)tx.store.delete(key);await tx.done;},
};
