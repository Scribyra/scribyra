const CACHE='__BUILD_CACHE__';
const PRECACHE=__PRECACHE__;
const SHELL=__APP_BASE__;
const ENGINE='scribyra-tex-v1.4.1';
const VERIFIED='scribyra-runtime-verified-v1';
const BASE=__TEX_BASE__;
const RUNTIME=__RUNTIME_ASSETS__;
const operations=new Map();
const observers=new Map();
function closeObserver(id){const entry=observers.get(id);if(!entry)return;observers.delete(id);entry.stream.finish();try{entry.port.postMessage({done:true});entry.port.close();}catch{}}
function observerFor(event,id){const entry=observers.get(id);if(!entry)return;if(entry.until<Date.now()){closeObserver(id);return;}if(entry.clientId!==event.clientId)return;entry.until=Date.now()+1800000;return entry.stream.begin;}
function validContext(value){return typeof value?.traceId==='string'&&/^[a-f0-9]{32}$/.test(value.traceId)&&/[1-9a-f]/.test(value.traceId)&&typeof value?.spanId==='string'&&/^[a-f0-9]{16}$/.test(value.spanId)&&/[1-9a-f]/.test(value.spanId);}
function scope(event,emit){const value=event.data?.context;if(event.origin!==self.location.origin||typeof event.source?.id!=='string'||!validContext(value))return;return workerObserver({traceId:value.traceId,spanId:value.spanId},emit);}
function localSpan(observer,operation){try{return observer?.(operation)||{end(){}};}catch{return{end(){}};}}
function failedSpan(span,error){let name;try{name=error?.name;}catch{}span.end(name==='AbortError'?'cancelled':'failure',name==='AbortError'?undefined:name==='QuotaExceededError'?'quota':name==='IntegrityError'?'integrity':'unknown');}
const assets=new Map(RUNTIME.map(asset=>[`${BASE}/${asset.path}`,asset]));
const key=asset=>new Request(new URL(`/__scribyra-runtime/${asset.sha256}`,self.location.origin));
const digest=async bytes=>[...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(b=>b.toString(16).padStart(2,'0')).join('');
function runtimeBytes(bytes,asset,original){const headers=new Headers(original);headers.delete('Content-Encoding');headers.delete('Vary');headers.set('Content-Length',String(bytes.length));headers.set('Content-Type',asset.path.endsWith('.wasm')?'application/wasm':asset.path.endsWith('.js')?'application/javascript':asset.path.endsWith('.json')?'application/json':'application/octet-stream');return new Response(bytes,{headers});}
// No skipWaiting here: a new worker waits until a tab's Reload asks it to take over
// (see handOver in update-notice.js), or until every tab of the app has closed. The
// very first install has nothing to wait for and claims the open tab on activate.
self.addEventListener('install',event=>{event.waitUntil(caches.open(CACHE).then(cache=>cache.addAll(PRECACHE)));});
self.addEventListener('activate',event=>{event.waitUntil((async()=>{try{await downloads.clearLegacyRuntime();}catch{}await self.clients.claim();})());});
async function verified(response,asset,progress,observer){
 const span=localSpan(observer,'verify');
 try{
 if(!response?.ok)throw new Error(`Compiler asset ${asset.path} is unavailable.`);
 const bytes=new Uint8Array(asset.size),reader=response.body.getReader();let offset=0,last=0;
 try{for(;;){const{done,value}=await reader.read();if(done)break;if(offset+value.length>bytes.length)throw Object.assign(new Error(`Compiler asset ${asset.path} exceeds its manifest size.`),{name:'IntegrityError'});bytes.set(value,offset);offset+=value.length;const now=Date.now();if(progress&&(now-last>100||offset===bytes.length)){last=now;progress(offset);}}}
 catch(error){await reader.cancel().catch(()=>{});throw error;}
 if(offset!==asset.size||await digest(bytes)!==asset.sha256)throw Object.assign(new Error(`Compiler asset ${asset.path} failed checksum verification.`),{name:'IntegrityError'});
 span.end('success',undefined,[{name:'bytes',value:bytes.byteLength}]);return runtimeBytes(bytes,asset,response.headers);
 }catch(error){failedSpan(span,error);throw error;}
}
async function runtimeResponse(event,asset){
 let cache;try{cache=await caches.open(VERIFIED);}catch{}const request=event.request,id=request.headers.get('X-Scribyra-Prepare'),client=id&&event.clientId?await self.clients.get(event.clientId):null;
 const observer=observerFor(event,id);
 const progress=(loaded,network=false)=>client?.postMessage({type:'scribyra-runtime-progress',id,path:asset.path,loaded,total:asset.size,network});
 const lookup=localSpan(observer,'cache');let cached;try{cached=cache&&await cache.match(key(asset));lookup.end('success',undefined,[{name:'count',value:cached?1:0}]);}catch(error){failedSpan(lookup,error);throw error;}
 if(cached){try{const response=await verified(cached,asset,progress,observer);await downloads.touchRuntime(asset).catch(()=>{});return response;}catch{const removed=await cache?.delete(key(asset));if(removed)localSpan(observer,'cache_evict').end('success',undefined,[{name:'count',value:1},{name:'bytes',value:asset.size}]);}}
 // Reuse older compiler caches only after verifying their exact content.
 for(const name of [ENGINE,CACHE]){let prior;try{prior=await(await caches.open(name)).match(request,{ignoreVary:true});}catch{}if(prior){try{const response=await verified(prior,asset,progress,observer);const saved=localSpan(observer,'cache');try{const ok=await downloads.saveRuntime(key(asset),response.clone(),asset,observer);saved.end(ok?'success':'failure',ok?undefined:'unavailable');}catch(error){failedSpan(saved,error);}return response;}catch{}}}
 const abort=new AbortController(),cancel=()=>abort.abort();request.signal?.addEventListener('abort',cancel,{once:true});if(request.signal?.aborted)cancel();if(id)operations.set(id,{abort});
 try{const headers=new Headers(request.headers);headers.delete('X-Scribyra-Prepare');
 const bytes=await downloads.fetchBytes({kind:'runtime',label:asset.path,size:asset.size,hash:asset.sha256,algorithm:'SHA-256'},{url:request.url,headers,signal:abort.signal,credentials:'same-origin',onProgress:loaded=>progress(loaded,true),observe:observer});
 const response=runtimeBytes(bytes,asset),saved=localSpan(observer,'cache');try{const ok=await downloads.saveRuntime(key(asset),response.clone(),asset,observer);saved.end(ok?'success':'failure',ok?undefined:'unavailable',[{name:'bytes',value:bytes.byteLength}]);}catch(error){failedSpan(saved,error);}return response;}
 catch(error){return new Response(error.message||String(error),{status:502,headers:{'Content-Type':'text/plain','X-Scribyra-Runtime-Error':'1'}});}
 finally{request.signal?.removeEventListener('abort',cancel);if(id&&operations.get(id)?.abort===abort)operations.delete(id);}
}
self.addEventListener('message',event=>{
 if(event.data?.type==='scribyra-skip-waiting'){if(event.origin===self.location.origin)self.skipWaiting();return;}
 if(event.data?.type==='scribyra-runtime-observe'){
  const port=event.ports?.[0],id=event.data.id;if(!port)return;
  for(const[key,entry]of observers)if(entry.until<Date.now())closeObserver(key);
  const stream=scope(event,telemetry=>port.postMessage({telemetry}));
  if(!stream||typeof id!=='string'||!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(id)||observers.has(id)||observers.size>=32){port.postMessage({ready:false});port.close();return;}
  observers.set(id,{stream,port,clientId:event.source.id,until:Date.now()+1800000});port.postMessage({ready:true});return;
 }
 if(event.data?.type==='scribyra-runtime-unobserve'){const entry=observers.get(event.data.id);if(entry&&event.origin===self.location.origin&&entry.clientId===event.source?.id)closeObserver(event.data.id);return;}
 // The initiating client supplies an unguessable UUID capability. Navigation
 // can replace its Client id or clear event.source before this message arrives.
 if(event.data?.type==='scribyra-runtime-cancel'){const operation=operations.get(event.data.id);if(operation&&event.origin===self.location.origin)operation.abort.abort();return;}
 const port=event.ports?.[0];if(!port||!['scribyra-runtime-status','scribyra-runtime-clear'].includes(event.data?.type))return;
 const stream=scope(event,telemetry=>port.postMessage({telemetry})),observer=stream?.begin;
 event.waitUntil((async()=>{try{
  if(event.data.type==='scribyra-runtime-clear'){const cleared=localSpan(observer,'cache_evict');try{await caches.delete(VERIFIED);await caches.delete(ENGINE);await downloads.clearPartials('runtime');cleared.end();}catch(error){failedSpan(cleared,error);throw error;}stream?.finish();port.postMessage({ok:true});return;}
  await downloads.pruneRuntime(observer);const cache=await caches.open(VERIFIED),entries=[];
  for(const asset of RUNTIME){let valid=false;const response=await cache.match(key(asset));if(response){try{await verified(response,asset,undefined,observer);valid=true;}catch{await cache.delete(key(asset));}}entries.push({path:asset.path,size:asset.size,valid});}
  stream?.finish();
  port.postMessage({ok:true,ready:entries.every(asset=>asset.valid),entries});
 }catch(error){stream?.finish();port.postMessage({ok:false,error:error.message||String(error)});}})());
});
self.addEventListener('fetch',event=>{
 const request=event.request,url=new URL(request.url);
 if(request.method!=='GET'||url.origin!==self.location.origin||url.pathname.startsWith('/rooms/'))return;
 const asset=assets.get(url.pathname);if(asset){event.respondWith(runtimeResponse(event,asset));return;}
 // Optional package archives use the Rust-verified IndexedDB cache exclusively.
 if(url.pathname.startsWith(`${BASE}/components/`)||url.pathname.startsWith(`${BASE}/metadata/`)||/\/tex-catalog\.[a-f0-9]{64}\.json$/.test(url.pathname))return;
 // Old tabs may still request the original large data bundle or unknown assets.
 // Only manifest-pinned compiler assets belong in the bounded runtime cache.
 if(url.pathname.startsWith(`${BASE}/`))return;
 const cacheable=PRECACHE.includes(url.pathname)||url.pathname.startsWith(`${SHELL}assets/`)||request.mode==='navigate';if(!cacheable)return;
 event.respondWith((async()=>{
  const cache=await caches.open(CACHE),cached=await cache.match(request,{ignoreVary:true});
  if(cached&&(request.mode!=='navigate'||url.pathname===`${SHELL}agent.md`)&&request.cache!=='reload')return cached;
  try{const response=await fetch(request);if(response.ok){try{await cache.put(request,response.clone());}catch{}}return response;}
  catch(error){if(cached)return cached;if(request.mode==='navigate'&&url.pathname!==`${SHELL}agent.md`)return(await cache.match(SHELL))||Response.error();throw error;}
 })());
});
