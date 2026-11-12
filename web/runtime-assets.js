import {clearMetadataCache} from './tex-cache.js';
import {downloads} from './downloads.js';
import {observe,finishError} from './observability.js';
import {watchRuntime} from './runtime-observation.js';
import {TEX_ASSETS,TEX_ASSET_BASE} from './tex-environment.js';
const PENDING_RUNTIME='scribyra-runtime-pending-v1';
function pendingRuntime(){try{const raw=sessionStorage.getItem(PENDING_RUNTIME);if(raw?.length>2048)return[];const ids=JSON.parse(raw||'[]');return Array.isArray(ids)?ids.filter(id=>typeof id==='string'&&/^[a-f0-9-]{36}$/.test(id)).slice(-16):[];}catch{return[];}}
function rememberRuntime(id){try{sessionStorage.setItem(PENDING_RUNTIME,JSON.stringify([...new Set([...pendingRuntime(),id])].slice(-16)));}catch{}}
function forgetRuntime(id){try{const ids=pendingRuntime().filter(item=>item!==id);if(ids.length)sessionStorage.setItem(PENDING_RUNTIME,JSON.stringify(ids));else sessionStorage.removeItem(PENDING_RUNTIME);}catch{}}
function recoverRuntime(){
 const ids=pendingRuntime();if(!ids.length)return;
 // A duplicated/new tab can inherit sessionStorage from its opener. Only a
 // reload/history navigation owns the old document's cancellation capabilities.
 const navigation=performance.getEntriesByType('navigation')[0]?.type;
 if(!['reload','back_forward'].includes(navigation)){for(const id of ids)forgetRuntime(id);return;}
 if(!navigator.serviceWorker)return;
 const recover=()=>{const worker=navigator.serviceWorker.controller;if(!worker)return;for(const id of ids){try{worker.postMessage({type:'scribyra-runtime-cancel',id});forgetRuntime(id);}catch{}}navigator.serviceWorker.removeEventListener('controllerchange',recover);};
 navigator.serviceWorker.addEventListener('controllerchange',recover);recover();
}
if(typeof window!=='undefined')recoverRuntime();
export async function readBounded(response,size){
 if(!response.body)throw new Error('Asset response has no body.');const reader=response.body.getReader(),bytes=new Uint8Array(size);let offset=0;
 try{for(;;){const{done,value}=await reader.read();if(done)break;if(offset+value.length>size)throw new Error('Asset exceeds its manifest size.');bytes.set(value,offset);offset+=value.length;}}
 catch(error){await reader.cancel().catch(()=>{});throw error;}return bytes.subarray(0,offset);
}
async function controller(signal){
 signal.throwIfAborted();if(!navigator.serviceWorker)throw new Error('Offline preparation requires HTTPS or localhost and service worker support.');
 if(navigator.serviceWorker.controller)return navigator.serviceWorker.controller;
 await new Promise((resolve,reject)=>{const worker=navigator.serviceWorker,done=()=>{cleanup();resolve();},abort=()=>{cleanup();reject(new DOMException('Cancelled','AbortError'));},timer=setTimeout(()=>{cleanup();reject(new Error('Use the production app build on HTTPS or localhost to prepare offline compilation.'));},30000);function cleanup(){clearTimeout(timer);worker.removeEventListener('controllerchange',done);signal.removeEventListener('abort',abort);}worker.addEventListener('controllerchange',done,{once:true});signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();});
 signal.throwIfAborted();return navigator.serviceWorker.controller;
}
async function request(type,signal,parent){
 const worker=await controller(signal),span=observe('cache',parent);return new Promise((resolve,reject)=>{const channel=new MessageChannel(),timer=setTimeout(()=>{span.end('failure','timeout');finish(new Error('Compiler cache inspection timed out.'));},30000),abort=()=>finish(new DOMException('Cancelled','AbortError'));let done=false;
  function finish(error,value){if(done)return;done=true;clearTimeout(timer);signal.removeEventListener('abort',abort);channel.port1.close();channel.port2.close();if(error)finishError(span,error);else span.end();error?reject(error):resolve(value);}
  channel.port1.onmessage=({data})=>{if(Array.isArray(data.telemetry)&&data.telemetry.length<=4)for(const event of data.telemetry)span.accept(event);if(!Object.hasOwn(data,'ok'))return;data.ok?finish(null,data):finish(new Error(data.error||'Compiler cache is unavailable.'));};signal.addEventListener('abort',abort,{once:true});if(signal.aborted){abort();return;}try{worker.postMessage({type,context:span.context},[channel.port2]);}catch(error){finish(error);}
 });
}
export const runtimeStatus=(signal,parent)=>request('scribyra-runtime-status',signal,parent);
export async function clearRuntime(signal){const result=await request('scribyra-runtime-clear',signal);await clearMetadataCache();result.legacyCleared=await downloads.clearLegacyRuntime();return result;}
async function fetchRuntime(assets,signal,progress,required,parent){
 let completed=false;const worker=await controller(signal),active=new AbortController(),id=crypto.randomUUID(),cancel=()=>{active.abort(signal.reason);try{worker.postMessage({type:'scribyra-runtime-cancel',id});}catch{}};rememberRuntime(id);signal.addEventListener('abort',cancel,{once:true});window.addEventListener('pagehide',cancel,{once:true});
 const observation=watchRuntime(worker,id,parent);
 // Bytes of the whole set in decimal MB: earlier assets count as done. Reading the cache isn't a download.
 const totalBytes=assets.reduce((sum,asset)=>sum+asset.size,0),megabytes=bytes=>(bytes/1e6).toFixed(0);let doneBytes=0;
 const update=event=>{const data=event.data;if(data?.type==='scribyra-runtime-progress'&&data.id===id&&data.network)progress(`Downloading LaTeX once · ${megabytes(doneBytes+data.loaded)} of ${megabytes(totalBytes)} MB…`);};navigator.serviceWorker.addEventListener('message',update);
 try{for(const asset of assets){signal.throwIfAborted();active.signal.throwIfAborted();if(!doneBytes)progress('Preparing compiler…');const response=await fetch(`${TEX_ASSET_BASE}/${asset.path}`,{signal:active.signal,credentials:'same-origin',headers:{'X-Scribyra-Prepare':id}});if(!response.ok)throw new Error(response.headers.has('X-Scribyra-Runtime-Error')?await response.text():`Compiler asset ${asset.path} is unavailable (HTTP ${response.status}).`);const reader=response.body.getReader();try{while(!(await reader.read()).done){signal.throwIfAborted();active.signal.throwIfAborted();}}catch(error){await reader.cancel().catch(()=>{});throw error;}doneBytes+=asset.size;}
  completed=true;if(required){const status=await runtimeStatus(signal,parent);if(!status.ready)throw new Error('Some compiler assets could not be saved. Increase the runtime cache limit or free browser storage before relying on offline compilation.');return status;}
 // Firefox can reject fetch before pagehide runs. Keep unfinished capabilities
 // for the new document instead of relying on an unload callback being delivered.
 }finally{observation.finish();if(signal.aborted)cancel();if(completed)forgetRuntime(id);signal.removeEventListener('abort',cancel);window.removeEventListener('pagehide',cancel);navigator.serviceWorker.removeEventListener('message',update);}
}

export const prepareRuntime=(signal,progress,parent)=>fetchRuntime([...TEX_ASSETS.core,...TEX_ASSETS.biber],signal,progress,true,parent);
export async function warmRuntime(signal,progress,kind='core',parent){
 if(!navigator.serviceWorker?.controller)return;
 const assets=TEX_ASSETS[kind],settings=await downloads.settings().catch(()=>null);
 if(!settings||assets.reduce((sum,asset)=>sum+asset.size,0)>settings.runtimeBytes)return;
 await fetchRuntime(assets,signal,progress,false,parent);
}
