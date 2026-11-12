import {observeWith,finishError} from './observability.js';
import {cachedMetadata,cacheMetadata} from './tex-cache.js';
import {downloads} from './downloads.js';
const sha256=async bytes=>[...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(b=>b.toString(16).padStart(2,'0')).join('');
const own=(map,key)=>Object.hasOwn(map,key)?map[key]:undefined;
const object=value=>value&&typeof value==='object'&&!Array.isArray(value);
const packageName=name=>typeof name==='string'&&/^[a-zA-Z0-9._-]{1,128}$/.test(name);
async function eachLimited(values,fn){let index=0,failure;await Promise.all(Array.from({length:Math.min(4,values.length)},async()=>{while(!failure&&index<values.length){try{await fn(values[index++]);}catch(error){failure=error;}}}));if(failure)throw failure;}
function downloadQueue(){let running=0;const waiting=[];return async task=>{if(running>=4)await new Promise(resolve=>waiting.push(resolve));else running++;try{return await task();}finally{const next=waiting.shift();if(next)next();else running--;}};}

// Rust retains package contents/indexes; JS retains small routing/filename maps.
export async function openMetadata({Catalog,root:rootInfo,base,runtime,binary=null,fetcher=globalThis.fetch,observe:initialObserver}){
 const download=downloadQueue();
 async function valid(info,bytes,observer){
  if(!(bytes instanceof Uint8Array))return false;
  const span=observeWith(observer,'verify');try{const ok=bytes instanceof Uint8Array&&bytes.length===info.size&&await sha256(bytes)===info.sha256;span.end(ok?'success':'failure',ok?undefined:'integrity',bytes?[{name:'bytes',value:bytes.byteLength}]:[]);return ok;}catch(error){finishError(span,error);throw error;}
 }
 async function raw(info,maximum,observer){
  if(!object(info)||!Number.isSafeInteger(info.size)||info.size<=0||info.size>maximum||!/^[a-f0-9]{64}$/.test(info.sha256))throw new Error('Invalid pinned TeX metadata descriptor.');
  let bytes=await cachedMetadata(info.sha256);const hit=observeWith(observer,'cache');hit.end('success',undefined,[{name:'count',value:bytes?1:0}]);
  if(!await valid(info,bytes,observer)){
   bytes=await download(async()=>{try{return await downloads.fetchBytes({kind:'metadata',label:'TeX metadata',size:info.size,hash:info.sha256,algorithm:'SHA-256'},{url:`${base}/${info.path}`,credentials:'same-origin',fetcher,observe:observer});}catch(error){throw new Error(`Required TeX metadata could not be fetched. Go online or import a matching package bundle. ${error.message}`,{cause:error});}});
   if(!await valid(info,bytes,observer))throw new Error('TeX metadata checksum differs from the pinned runtime.');
  }
  await cacheMetadata(info,bytes,observer);return bytes;
 }
 const text=bytes=>new TextDecoder('utf-8',{fatal:true}).decode(bytes);
 const read=async(info,maximum,observer)=>text(await raw(info,maximum,observer));
 if(rootInfo?.path!==`tex-catalog.${runtime.catalogSha256}.json`||rootInfo.sha256!==runtime.catalogSha256)throw new Error('TeX metadata root path differs from its runtime.');
 const root=JSON.parse(await read(rootInfo,256*1024,initialObserver));
 if(root.version!==1||root.snapshot!==runtime.snapshot||root.sourceArchiveSha256!==runtime.distributionSha256||!object(root.fontFamilies))throw new Error('TeX metadata manifest is incompatible with this runtime.');
 for(const kind of ['filenames','packages']){
  if(!object(root[kind])||Object.keys(root[kind]).length>256)throw new Error('Invalid TeX metadata shard map.');
  for(const[bucket,asset]of Object.entries(root[kind]))if(!/^[a-f0-9]{2}$/.test(bucket)||!object(asset)||asset.path!==`metadata/${asset.sha256}.json`||!Number.isSafeInteger(asset.size)||asset.size<=0||asset.size>2*1024*1024)throw new Error('Invalid TeX metadata shard.');
 }
 if(root.languages!==undefined&&(!object(root.languages)||Object.keys(root.languages).length>1024))throw new Error('Invalid language metadata.');
 if(root.dependencyGraph&&(root.dependencyGraph.path!==`metadata/${root.dependencyGraph.sha256}.json`||!Number.isSafeInteger(root.dependencyGraph.size)||root.dependencyGraph.size<=0||root.dependencyGraph.size>2*1024*1024||!/^[a-f0-9]{64}$/.test(root.dependencyGraph.sha256)))throw new Error('Invalid dependency manifest descriptor.');
 if(root.compatibility)Catalog.validate_compatibility(JSON.stringify(root.compatibility),JSON.stringify(runtime),JSON.stringify(binary));
 const catalog=new Catalog(JSON.stringify({snapshot:root.snapshot,packages:{}})),loaded=new Map();
 async function part(info,kind,observer){
  if(!info)return kind==='filenames'?{}:null;
  if(!loaded.has(info.path))loaded.set(info.path,(async()=>{
   const text=await read(info,2*1024*1024,observer);
   if(kind==='packages'){catalog.merge(text);return null;}
   const names=JSON.parse(text);if(!object(names))throw new Error('Invalid filename metadata.');
   for(const[key,packages]of Object.entries(names))if(!key||key.includes('/')||!Array.isArray(packages)||packages.length>10000||packages.some(name=>!packageName(name)))throw new Error('Invalid filename metadata entry.');
   return names;
  })().catch(error=>{loaded.delete(info.path);throw error;}));
  return loaded.get(info.path);
 }
 async function ensure(names,observer){
  if(!Array.isArray(names)||names.length>10000||names.some(name=>!packageName(name)))throw new Error('Invalid TeX package names.');
  const buckets=[...new Set(names.map(name=>Catalog.metadata_bucket(name)))];
  await eachLimited(buckets,bucket=>part(root.packages[bucket],'packages',observer));
 }
 async function lockedNames(lock,observer){const names=JSON.parse(Catalog.environment_packages(JSON.stringify(lock),JSON.stringify(runtime)));await ensure(names,observer);return names;}
 return{
  catalog,ensure,lockedNames,
  async dependencyGraph(observer){if(!root.dependencyGraph)throw new Error('This compiler catalog does not include a declared dependency manifest.');return raw(root.dependencyGraph,2*1024*1024,observer);},
  async metadataAssets(names,observer){
   await ensure(names,observer);const paths=[...new Set(names.map(name=>root.packages[Catalog.metadata_bucket(name)]?.path).filter(Boolean))].sort();
   const pins=new Map(Object.values(root.packages).map(info=>[info.path,info]));
   const result=[{...rootInfo,bytes:await raw(rootInfo,256*1024,observer)}];if(root.dependencyGraph)result.push({...root.dependencyGraph,bytes:await raw(root.dependencyGraph,2*1024*1024,observer)});
   for(const path of paths){const info=pins.get(path);result.push({...info,bytes:await raw(info,2*1024*1024,observer)});}return result;
  },
  async metadataStatus(names,observer){
   const pins=[rootInfo,...(root.dependencyGraph?[root.dependencyGraph]:[]),...new Map(names.map(name=>root.packages[Catalog.metadata_bucket(name)]).filter(Boolean).map(info=>[info.path,info])).values()],missing=[];
   for(const info of pins)if(!await valid(info,await cachedMetadata(info.sha256),observer))missing.push(info.path);
   return{ready:missing.length===0,missing};
  },
  async resolve(missing,log,observer){
   const plan=JSON.parse(Catalog.lookup_plan(JSON.stringify(missing),log)),names=new Set(),indexes=new Map();
   await eachLimited([...new Set(plan.files.map(file=>file.bucket))],async bucket=>indexes.set(bucket,await part(root.filenames[bucket],'filenames',observer)));
   for(const file of plan.files)for(const name of own(indexes.get(file.bucket),file.name)||[])names.add(name);
   const languages=Object.create(null);for(const language of plan.languages||[]){const matches=own(root.languages||{},language);if(matches){if(!Array.isArray(matches)||!matches.length||matches.length>64||matches.some(name=>!packageName(name)))throw new Error('Invalid language package metadata.');languages[language]=matches;for(const name of matches)names.add(name);}}
   const families=Object.create(null);for(const family of plan.fonts){const matches=own(root.fontFamilies,family);if(matches){if(!Array.isArray(matches)||matches.length>64||matches.some(name=>!packageName(name)))throw new Error('Invalid font metadata.');families[family]=matches;for(const name of matches)names.add(name);}}
   await ensure([...names],observer);catalog.add_fonts(JSON.stringify(families));if(Object.keys(languages).length)catalog.add_languages(JSON.stringify(languages));
   return JSON.parse(catalog.package_info(catalog.resolve(JSON.stringify(missing),log)));
  },
 };
}
