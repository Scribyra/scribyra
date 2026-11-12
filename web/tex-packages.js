import {downloads} from './downloads.js';
import {observe,observed,finishError} from './observability.js';
import {cachedArchive,cacheArchive,cacheArchives} from './tex-cache.js';
export {cachedArchive,cacheArchive,cacheArchives,cachedPackages,removeCachedArchive,clearPackageCache,CACHE_LIMIT} from './tex-cache.js';
import {TEX_RUNTIME,MAX_BUNDLE_BYTES,TexEnvironmentError,TEX_ASSET_BASE} from './tex-environment.js';
// Only public archive names leave the browser. No project source or credentials.
const repository=(import.meta.env?.VITE_TEX_PACKAGE_REPOSITORY||'https://tlnet.yihui.org').replace(/\/$/,'');
const ARCHIVE_LIMIT=32*1024*1024;
export class TexPackageError extends Error {name='TexPackageError';constructor(message,pkg,options){super(message,options);this.package=pkg;}}
export async function downloadArchive(packageInfo,signal,onProgress=()=>{},parent){
 if(!/^[a-zA-Z0-9._-]+$/.test(packageInfo.name)||packageInfo.size>ARCHIVE_LIMIT)throw new Error(`TeX package ${packageInfo.name} exceeds the supported download limit.`);
 const distribution=packageInfo.origin==='distribution';if(distribution&&!/^[a-f0-9]{128}$/.test(packageInfo.sha512))throw new Error('Invalid distribution component checksum.');
 if(packageInfo.archive&&packageInfo.archive!==`components/${packageInfo.sha512}.tar.xz`)throw new Error('Invalid static support archive path.');
 const url=packageInfo.archive?`${TEX_ASSET_BASE}/${packageInfo.archive}`:distribution?`${TEX_ASSET_BASE}/components/${packageInfo.sha512}.tar.xz`:`${repository}/archive/${packageInfo.name}.tar.xz`;
 return downloads.fetchBytes({kind:'archive',label:packageInfo.label||packageInfo.name,size:packageInfo.size,hash:packageInfo.sha512,algorithm:'SHA-512'},{url,signal,onProgress,telemetryParent:parent,credentials:distribution||packageInfo.archive?'same-origin':'omit'});
}
// progress() receives one message per package step (no byte counters, so a
// polite status is not re-announced many times a second); note() gets details.
export function texPackages(signal,progress=()=>{},existing=[],parent,note=()=>{}){
 const worker=new Worker(new URL('./tex-packages-worker.js',import.meta.url),{type:'module'});
 const pending=new Map(),installed=new Set(existing.map(p=>p.name));let lastCandidates=[];let id=0,count=existing.length,total=existing.reduce((n,p)=>n+p.size,0),closed=false,allowed=null;
 const close=()=>{closed=true;worker.terminate();for(const task of pending.values()){clearTimeout(task.timeout);task.span.end('cancelled');task.reject(new DOMException('Package operation cancelled','AbortError'));}pending.clear();signal.removeEventListener('abort',close);};
 worker.onmessage=({data})=>{const task=pending.get(data.id);if(!task)return;if(Array.isArray(data.telemetry)&&data.telemetry.length<=4)for(const event of data.telemetry)task.span.accept(event);if(!Object.hasOwn(data,'result')&&!Object.hasOwn(data,'error'))return;pending.delete(data.id);clearTimeout(task.timeout);task.span.end(data.error?'failure':'success',data.error?'worker':undefined);data.error?task.reject(new Error(data.error)):task.resolve(data.result);};
 worker.onerror=()=>{for(const task of pending.values()){clearTimeout(task.timeout);task.span.end('failure','worker');task.reject(new Error('TeX package worker failed.'));}pending.clear();};
 signal.addEventListener('abort',close,{once:true});
 function request(kind,input,transfer=[]){
  if(closed||signal.aborted)return Promise.reject(new DOMException('Cancelled','AbortError'));
  return new Promise((resolve,reject)=>{const span=observe(kind==='unpack'?'verify':'package_prepare',parent),key=++id,timeout=setTimeout(()=>{pending.delete(key);span.end('failure','timeout');reject(new Error('TeX package processing timed out.'));close();},30000);pending.set(key,{resolve,reject,timeout,span});try{worker.postMessage({id:key,kind,input,telemetry:span.context},transfer);}catch(error){pending.delete(key);clearTimeout(timeout);finishError(span,error);reject(error);}});
 }
 const check=async lock=>{try{return await request('check-environment',{lock,runtime:TEX_RUNTIME});}catch(error){if(error.name==='AbortError')throw error;throw new TexEnvironmentError(error.message,{cause:error});}};
 async function install(packages,runner,trail=[],plan={names:new Set(),done:0}){
  const added=[];for(const pkg of packages)if(!installed.has(pkg.name))plan.names.add(pkg.name);
  for(const pkg of packages){
   if(allowed&&!allowed.has(pkg.name))throw new TexEnvironmentError(`The locked TeX environment does not include ${pkg.name}. Unlock the environment explicitly, compile again, and review the updated package set.`);
   if(installed.has(pkg.name))continue;
   if(trail.includes(pkg.name)||trail.length>=64)throw new Error('Cyclic or excessive required TeX package chain.');
   if(pkg.requires?.length)added.push(...await install(await request('packages',{names:pkg.requires}),runner,[...trail,pkg.name],plan));
   if(++count>64||(total+=pkg.size)>96*1024*1024)throw new Error('This document exceeds the automatic TeX package download limit (64 packages / 96 MiB).');
   const position=`${++plan.done} of ${Math.max(plan.done,plan.names.size)}`;
   let bytes=await observed('cache',()=>cachedArchive(pkg.sha512),{parent,metrics:bytes=>[{name:'count',value:bytes?1:0}]}),cached=!!bytes,files;
   if(bytes){progress(`Loading TeX package ${pkg.name} from cache (${position})…`);try{files=await request('unpack',{name:pkg.name,bytes});}catch(error){if(signal.aborted)throw error;bytes=undefined;cached=false;}}
   if(!bytes){
    progress(`Fetching TeX package ${pkg.name} (${position}) · ${Math.ceil(pkg.size/1024)} KB…`);
    try{bytes=await downloadArchive(pkg,signal,()=>{},parent);files=await request('unpack',{name:pkg.name,bytes});}
    catch(error){if(signal.aborted)throw error;throw new TexPackageError(`Could not install ${pkg.name} r${pkg.revision}: ${error.message}. ${pkg.origin==='distribution'||pkg.archive?'Reconnect or ask the host to rebuild and deploy the matching static compiler components.':'Connect to the internet or use a CORS-enabled mirror containing the pinned archive revision.'} Cached packages remain usable offline.`,pkg.name,{cause:error});}
   }
   const saved=await observed('cache',scope=>cacheArchive(pkg.sha512,bytes,pkg,operation=>observe(operation,scope)),{parent,outcome:saved=>saved?'success':'failure',metrics:()=>[{name:'bytes',value:bytes.byteLength}]} );signal.throwIfAborted();if(runner)await runner.writeTexliveRemoteFiles(files);
   installed.add(pkg.name);added.push({name:pkg.name,revision:pkg.revision,size:pkg.size,sha512:pkg.sha512,origin:pkg.origin,label:pkg.label,archive:pkg.archive,dependencies:pkg.dependencies,dependencyProvenance:pkg.dependencyProvenance,requires:pkg.requires,cached,saved});
   note(`${cached?'Loaded cached':'Installed'} TeX package ${pkg.name} r${pkg.revision}${saved?'':' (cache full; online only)'}`);
  }
  return added;
 }
 return {
  close,check,
  diagnose:input=>request('diagnostics',input),
  stalledPackages:()=>lastCandidates.filter(pkg=>installed.has(pkg.name)).map(pkg=>pkg.name),
  environment:names=>request('environment',{names,runtime:TEX_RUNTIME}),
  async preload(lock,runner){lock=await check(lock);allowed=new Set(Object.keys(lock.packages).sort());return install(await request('packages',{names:[...allowed]}),runner);},
  async resolve(missing,log,runner,onPlan=()=>{}){lastCandidates=await request('resolve',{missing,log});onPlan(lastCandidates.filter(pkg=>!installed.has(pkg.name)));return install(lastCandidates,runner);},
  async inspectCache(lock){
   lock=await check(lock);const missing=[];
   for(const[name,pkg]of Object.entries(lock.packages)){const bytes=await cachedArchive(pkg.sha512);if(!bytes){missing.push(name);continue;}try{await request('unpack',{name,bytes});}catch(error){if(signal.aborted)throw error;missing.push(name);}}
   const metadata=await request('metadata',{lock});return{ready:missing.length===0&&metadata.ready,missing,metadata};
  },
  metadataStatus:lock=>request('metadata',{lock}),
  prepareMetadata:lock=>request('prepare-metadata',{lock}),
  dependencyGraph:()=>request('dependency-graph',{}),
  async exportBundle(lock){
   lock=await check(lock);const archives=[];
   for(const name of Object.keys(lock.packages).sort()){const pkg=lock.packages[name],bytes=await cachedArchive(pkg.sha512);if(!bytes)throw new Error(`Cache ${name} before exporting its package bundle.`);archives.push(bytes);}
   return request('encode-environment',{lock,runtime:TEX_RUNTIME,archives},archives.map(bytes=>bytes.buffer));
  },
  async importBundle(bytes){
   if(bytes.length>MAX_BUNDLE_BYTES)throw new Error('TeX package bundle exceeds 120 MiB plus manifest overhead.');
   const result=await request('decode-environment',{bytes,runtime:TEX_RUNTIME},[bytes.buffer]);
   const names=Object.keys(result.lock.packages).sort(),info=result.packages;const entries=names.map((name,i)=>({hash:result.lock.packages[name].sha512,bytes:result.archives[i],package:info[i]}));
   signal.throwIfAborted();
   if(!await cacheArchives(entries,result.metadata))throw new Error('Package bundle could not be saved. Existing caches and the project lock are unchanged.');
   signal.throwIfAborted();return result.lock;
  },
 };
}
