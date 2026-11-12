import {wrap} from 'idb';
import {downloads} from './downloads.js';
import {observe,observeWith,finishError} from './observability.js';
import {cache_evictions,validate_cache_settings} from './pkg/scribyra_app.js';
export const CACHE_LIMIT=downloads.policy.defaults.archiveBytes;
export const METADATA_CACHE_LIMIT=downloads.policy.defaults.metadataBytes;
const db=async()=>wrap(await downloads.db());
export const cacheSettings=()=>downloads.settings();
export const interruptedDownloads=()=>downloads.partials();
export const clearInterruptedDownloads=()=>downloads.clearPartials();
export const removeInterruptedDownload=id=>downloads.forgetPartial(id);
export async function cachedArchive(hash){try{return(await(await db()).get('archives',hash))?.bytes;}catch{return undefined;}}
export const cachedMetadata=hash=>cachedArchive('metadata:'+hash);
async function inventory(store){return store.getAll();}
export async function cachedPackages(){return(await(await db()).getAll('headers')).filter(item=>item.kind==='archive').map(item=>({hash:item.id,size:item.size,used:item.used,package:item.package}));}
export async function cachedMetadataUsage(){const rows=(await(await db()).getAll('headers')).filter(item=>item.kind==='metadata');return{count:rows.length,bytes:rows.reduce((sum,item)=>sum+item.size,0)};}
export async function removeCachedArchive(hash){const tx=(await db()).transaction(['archives','headers'],'readwrite');await tx.objectStore('archives').delete(hash);await tx.objectStore('headers').delete(hash);await tx.done;}
export async function clearPackageCache(){const tx=(await db()).transaction(['archives','headers'],'readwrite');await tx.objectStore('archives').clear();await tx.objectStore('headers').clear();await tx.done;await downloads.clearPartials('archive');await downloads.clearPartials('metadata');}
export async function clearMetadataCache(){const tx=(await db()).transaction(['archives','headers'],'readwrite');for(const row of await inventory(tx.objectStore('headers')))if(row.kind==='metadata'){await tx.objectStore('archives').delete(row.id);await tx.objectStore('headers').delete(row.id);}await tx.done;await downloads.clearPartials('metadata');}
function plan(settings,existing,incoming){return JSON.parse(cache_evictions(JSON.stringify({settings,existing:existing.map(({id,kind,size,used})=>({id,kind,size,used})),incoming:incoming.map(({id,kind,size,used})=>({id,kind,size,used}))})));}
export async function updateCacheSettings(value){
 const settings=JSON.parse(validate_cache_settings(JSON.stringify(value))),tx=(await db()).transaction(['archives','headers','control'],'readwrite');tx.done.catch(()=>{});
 try{const rows=await inventory(tx.objectStore('headers'));for(const key of plan(settings,rows,[])){await tx.objectStore('archives').delete(key);await tx.objectStore('headers').delete(key);}await tx.objectStore('control').put(settings,'limits');await tx.done;}
 catch(error){try{tx.abort();}catch{}await tx.done.catch(()=>{});throw error;}
 try{await downloads.trimPartials();if(globalThis.caches)await downloads.pruneRuntime();}
 catch(error){throw new Error(`Cache limits were saved, but cleanup could not finish: ${error.message||String(error)}. Retry applying the limits.`,{cause:error});}return settings;
}
// Archive and metadata bodies, indexes and their evictions share one transaction.
// Inventory reads only small headers, never every cached archive body.
export async function cacheArchives(entries,metadata=[],observer=observe){
 let tx;const span=observeWith(observer,'cache');
 try{
  const seen=new Set(),rows=[],now=Date.now();
  for(const item of entries){if(typeof item.hash!=='string'||item.hash.startsWith('metadata:')||seen.has(item.hash)||!(item.bytes instanceof Uint8Array)||item.bytes.length>32*1048576)throw new Error('Invalid cache batch.');seen.add(item.hash);rows.push({id:item.hash,kind:'archive',size:item.bytes.length,used:now,package:item.package?{name:item.package.name,revision:item.package.revision,sha512:item.package.sha512,size:item.package.size,origin:item.package.origin,label:item.package.label,archive:item.package.archive,dependencies:item.package.dependencies,dependencyProvenance:item.package.dependencyProvenance,requires:item.package.requires}:null,path:null,bytes:item.bytes});}
  for(const item of metadata){const id='metadata:'+item.sha256;if(!/^[a-f0-9]{64}$/.test(item.sha256)||seen.has(id)||!(item.bytes instanceof Uint8Array)||item.bytes.length!==item.size||item.bytes.length>2*1048576)throw new Error('Invalid metadata cache batch.');seen.add(id);rows.push({id,kind:'metadata',size:item.bytes.length,used:now,package:null,path:item.path,bytes:item.bytes});}
  tx=(await db()).transaction(['archives','headers','control'],'readwrite');tx.done.catch(()=>{});const saved=await tx.objectStore('control').get('limits'),settings=downloads.validSettings(saved)?saved:downloads.policy.defaults;
  const existing=await inventory(tx.objectStore('headers')),evicted=plan(settings,existing,rows),keys=new Set(evicted),evictedBytes=existing.filter(row=>keys.has(row.id)).reduce((sum,row)=>sum+row.size,0);
  for(const key of evicted){await tx.objectStore('archives').delete(key);await tx.objectStore('headers').delete(key);}
  for(const row of rows){const{id,bytes,...info}=row;await tx.objectStore('archives').put({...info,bytes},id);await tx.objectStore('headers').put({id,...info},id);}
  await tx.done;span.end('success',undefined,[{name:'bytes',value:rows.reduce((sum,row)=>sum+row.size,0)}]);if(evicted.length)observeWith(observer,'cache_evict').end('success',undefined,[{name:'count',value:evicted.length},{name:'bytes',value:evictedBytes}]);return true;
 }catch(error){try{tx?.abort();}catch{}await tx?.done.catch(()=>{});finishError(span,error);return false;}
}
export const cacheArchive=(hash,bytes,packageInfo,observer)=>cacheArchives([{hash,bytes,package:packageInfo}],[],observer);
export const cacheMetadata=(info,bytes,observer)=>cacheArchives([],[{...info,bytes}],observer);
