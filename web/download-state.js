// Shared by browser modules and the classic service worker. Only public compiler
// data lives here; project databases and credentials never enter this adapter.
globalThis.createScribyraDownloads = function(policy,observer){
 const trace=(operation,parent,local=observer)=>{try{return local?.(operation,parent)||{context:null,end(){}};}catch{return{context:null,end(){}};}};
 const fail=(span,error)=>{let name;try{name=error?.name;}catch{}span.end(name==='AbortError'?'cancelled':'failure',name==='AbortError'?undefined:name==='TimeoutError'?'timeout':name==='QuotaExceededError'?'quota':'network');};
 const CHUNK=256*1024,CHECKPOINT=1024*1024,DB='scribyra-tex-packages';
 const RUNTIME_CACHE='scribyra-runtime-verified-v1';
 let database;
 const request=r=>new Promise((resolve,reject)=>{r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});
 function validSettings(value){return value&&Object.keys(value).length===Object.keys(policy.defaults).length&&Object.keys(policy.defaults).every(key=>key==='version'?value[key]===1:Number.isSafeInteger(value[key])&&value[key]>=0&&value[key]<=policy.maximum[key]&&value[key]%policy.mib===0);}
 function header(id,value){return{id,kind:value.kind==='metadata'?'metadata':'archive',size:value.bytes?.byteLength||0,used:value.used||0,package:value.package||null,path:value.path||null};}
 function db(){return database||=(new Promise((resolve,reject)=>{
  const open=indexedDB.open(DB,2);let failed=false;
  open.onblocked=()=>{failed=true;reject(new Error('Close older Scribyra tabs to upgrade the public compiler cache. Project files are unaffected.'));};
  open.onerror=()=>reject(open.error);
  open.onupgradeneeded=()=>{
   if(failed){open.transaction.abort();return;}
   const result=open.result;if(!result.objectStoreNames.contains('archives'))result.createObjectStore('archives');
   for(const name of ['headers','control','partials','chunks'])if(!result.objectStoreNames.contains(name))result.createObjectStore(name);
   const source=open.transaction.objectStore('archives'),index=open.transaction.objectStore('headers'),cursor=source.openCursor();
   cursor.onsuccess=()=>{const row=cursor.result;if(!row)return;index.put(header(row.key,row.value),row.key);row.continue();};
  };
  open.onsuccess=()=>{if(failed){open.result.close();return;}open.result.onversionchange=()=>{open.result.close();database=null;};resolve(open.result);};
 })).catch(error=>{database=null;throw error;});}
 async function transaction(stores,mode,work){
  const tx=(await db()).transaction(stores,mode),done=new Promise((resolve,reject)=>{tx.oncomplete=resolve;tx.onabort=()=>reject(tx.error||new DOMException('Cache transaction aborted','AbortError'));});done.catch(()=>{});
  try{const result=await work(tx,request);await done;return result;}catch(error){try{tx.abort();}catch{}await done.catch(()=>{});throw error;}
 }
 async function limitsIn(tx){const value=await request(tx.objectStore('control').get('limits'));return validSettings(value)?value:{...policy.defaults};}
 const settings=()=>transaction(['control'],'readonly',limitsIn);
 async function safeSettings(){try{return await settings();}catch{return{version:1,archiveBytes:0,metadataBytes:0,runtimeBytes:0,partialBytes:0};}}
 async function drop(tx,row){await request(tx.objectStore('partials').delete(row.id));await request(tx.objectStore('chunks').delete(IDBKeyRange.bound([row.id,0],[row.id,Number.MAX_SAFE_INTEGER])));}
 async function clearPartials(kind){return transaction(['partials','chunks'],'readwrite',async tx=>{for(const row of await request(tx.objectStore('partials').getAll()))if(!kind||row.kind===kind)await drop(tx,row);});}
 async function partials(){return transaction(['partials'],'readonly',async tx=>(await request(tx.objectStore('partials').getAll())).map(({owner,until,...row})=>row));}
 function assetId(asset){
  const length=asset.algorithm==='SHA-256'?64:asset.algorithm==='SHA-512'?128:0,max=asset.kind==='archive'?32*policy.mib:asset.kind==='metadata'?2*policy.mib:asset.kind==='runtime'?512*policy.mib:0;
  if(!length||!new RegExp(`^[a-f0-9]{${length}}$`).test(asset.hash)||!Number.isSafeInteger(asset.size)||asset.size<=0||asset.size>max)throw new Error('Invalid pinned download size or checksum.');
  return`${asset.algorithm}:${asset.hash}:${asset.size}`;
 }
 const digest=async(algorithm,bytes)=>[...new Uint8Array(await crypto.subtle.digest(algorithm,bytes))].map(b=>b.toString(16).padStart(2,'0')).join('');
 async function reserve(asset,id,owner,force){
  return transaction(['partials','chunks','control'],'readwrite',async tx=>{
   const limit=(await limitsIn(tx)).partialBytes;if(!limit)return null;const store=tx.objectStore('partials');let row=await request(store.get(id));const now=Date.now();
   if(row&&row.owner&&row.until>now&&row.until<=now+30000&&!force)return null;
   const rows=await request(store.getAll()),retained=[];
   for(const old of rows){if(now-old.used>7*86400000){await drop(tx,old);if(old.id===id)row=null;}else if(old.id!==id)retained.push(old);}
   retained.sort((a,b)=>a.used-b.used||a.id.localeCompare(b.id));while(retained.length>=256)await drop(tx,retained.shift());
   if(row&&!(row.size===asset.size&&row.kind===asset.kind&&Number.isSafeInteger(row.length)&&row.length>=0&&row.length<=asset.size&&Number.isSafeInteger(row.count)&&row.count>=0&&row.count<=2048)){await drop(tx,row);row=null;}
   row=row||{id,kind:asset.kind,label:String(asset.label||asset.kind).slice(0,256),size:asset.size,length:0,count:0};
   row={...row,owner,until:now+30000,used:now};await request(store.put(row,id));return row;
  });
 }
 async function forget(id,owner){return transaction(['partials','chunks'],'readwrite',async tx=>{const row=await request(tx.objectStore('partials').get(id));if(row&&(!owner||row.owner===owner))await drop(tx,row);});}
 async function release(id,owner){return transaction(['partials','chunks'],'readwrite',async tx=>{const store=tx.objectStore('partials'),row=await request(store.get(id));if(row?.owner===owner){if(!row.length)await drop(tx,row);else await request(store.put({...row,owner:null,until:0},id));}});}
 async function checkpoint(asset,id,owner,bytes,from,to){
  if(to<=from)return true;const pieces=[];
  for(let at=from;at<to;at+=CHUNK){const content=bytes.slice(at,Math.min(to,at+CHUNK));pieces.push({bytes:content,sha256:await digest('SHA-256',content)});}
  return transaction(['partials','chunks','control'],'readwrite',async tx=>{
   const limit=(await limitsIn(tx)).partialBytes,store=tx.objectStore('partials'),row=await request(store.get(id));
   if(!row||row.owner!==owner||row.length!==from||to>limit||!limit)return false;
   const old=(await request(store.getAll())).filter(item=>item.id!==id).sort((a,b)=>a.used-b.used);let total=old.reduce((sum,item)=>sum+item.length,0)+to;
   for(const item of old){if(total<=limit)break;await drop(tx,item);total-=item.length;}
   for(let i=0;i<pieces.length;i++)await request(tx.objectStore('chunks').put(pieces[i],[id,row.count+i]));
   await request(store.put({...row,length:to,count:row.count+pieces.length,used:Date.now(),until:Date.now()+30000},id));return true;
  });
 }
 async function prefix(row,bytes){
  let at=0;
  for(let i=0;i<row.count;i++){
   const piece=await transaction(['chunks'],'readonly',tx=>request(tx.objectStore('chunks').get([row.id,i])));
   if(!(piece?.bytes instanceof Uint8Array)||!piece.bytes.length||piece.bytes.length>CHUNK||at+piece.bytes.length>row.length||await digest('SHA-256',piece.bytes)!==piece.sha256)throw new Error('Interrupted download data is corrupt.');
   bytes.set(piece.bytes,at);at+=piece.bytes.length;
  }
  if(at!==row.length)throw new Error('Interrupted download is incomplete.');return at;
 }
 async function transfer(asset,options,force){
  const id=assetId(asset),owner=crypto.randomUUID(),signal=options.signal||new AbortController().signal,fetcher=options.fetcher||globalThis.fetch;
  signal.throwIfAborted();let row;try{row=await reserve(asset,id,owner,force);}catch{row=null;}
  let bytes=new Uint8Array(asset.size),offset=0,saved=0,persist=!!row;
  if(row){try{offset=await prefix(row,bytes);saved=offset;}catch{await forget(id,owner).catch(()=>{});row=await reserve(asset,id,owner,force).catch(()=>null);persist=!!row;}}
  if(offset){const cached=trace('cache',options.telemetryParent,options.observe);cached.end('success',undefined,[{name:'bytes',value:offset},{name:'count',value:1}]);}
  const progress=()=>options.onProgress?.(offset,asset.size,{resumedBytes:initial,savedBytes:saved});let initial=offset,fullRetry=false;
  if(offset)progress();
  const network=new AbortController(),abortNetwork=()=>network.abort(signal.reason),idleTimeout=options.idleTimeoutMs??30000;
  signal.addEventListener('abort',abortNetwork,{once:true});if(signal.aborted)abortNetwork();
  // Bound each wait for headers/bytes, independently of the compilation timer.
  function wait(promise){return new Promise((resolve,reject)=>{
   let done=false;const finish=(error,value)=>{if(done)return;done=true;clearTimeout(timer);network.signal.removeEventListener('abort',aborted);error?reject(error):resolve(value);},aborted=()=>finish(network.signal.reason),timer=setTimeout(()=>network.abort(Object.assign(new Error('No download progress for 30 seconds. Retry to resume the download.'),{name:'TimeoutError'})),idleTimeout);
   network.signal.addEventListener('abort',aborted,{once:true});if(network.signal.aborted)aborted();promise.then(value=>finish(null,value),error=>finish(error));
  });}
  try{
   for(let attempt=0;attempt<2;attempt++){
    if(attempt){const retry=trace('retry',options.telemetryParent,options.observe);retry.end('success',undefined,[{name:'count',value:1}]);}
    let reader;
    try{
     if(offset<asset.size){
      const headers=new Headers(options.headers);if(offset&&!fullRetry)headers.set('Range',`bytes=${offset}-`);else headers.delete('Range');
      let response;
      try{response=await wait(fetcher(options.url,{signal:network.signal,credentials:options.credentials||'omit',referrerPolicy:'no-referrer',cache:'no-store',headers}));}
      catch(error){if(offset&&!network.signal.aborted&&attempt===0){fullRetry=true;continue;}throw error;}
      if(offset&&response.status===200){await forget(id,owner).catch(()=>{});row=await reserve(asset,id,owner,force).catch(()=>null);persist=!!row;offset=saved=initial=0;}
      else if(offset){
       const match=response.headers.get('Content-Range')?.match(/^bytes (\d+)-(\d+)\/(\d+)$/),encoding=response.headers.get('Content-Encoding');
       if(response.status!==206||!match||Number(match[1])!==offset||Number(match[2])!==asset.size-1||Number(match[3])!==asset.size||encoding&&encoding!=='identity'){
        await response.body?.cancel().catch(()=>{});if(attempt===0){fullRetry=true;continue;}throw new Error('Server returned an invalid byte range.');
       }
      }
      if(!response.ok||response.status!==200&&response.status!==206)throw new Error(`Download is unavailable (HTTP ${response.status}).`);
      if(!offset&&response.status===206)throw new Error('Unexpected partial response.');
      if(!response.body)throw new Error('Download response has no body.');reader=response.body.getReader();
      for(;;){signal.throwIfAborted();const{done,value}=await wait(reader.read());if(done)break;if(offset+value.length>asset.size){await forget(id,owner).catch(()=>{});persist=false;throw new Error('Download changed or exceeds its pinned size.');}bytes.set(value,offset);offset+=value.length;progress();if(persist&&offset-saved>=CHECKPOINT){persist=await checkpoint(asset,id,owner,bytes,saved,offset).catch(()=>false);if(persist)saved=offset;}}
      if(offset!==asset.size)throw new Error('Download was interrupted before its pinned size.');
     }
     const verification=trace('verify',options.telemetryParent,options.observe);let valid;
     try{valid=await digest(asset.algorithm,bytes)===asset.hash;verification.end(valid?'success':'failure',valid?undefined:'integrity',[{name:'bytes',value:bytes.byteLength}]);}catch(error){fail(verification,error);throw error;}
     if(!valid){await forget(id,owner).catch(()=>{});persist=false;if(initial&&attempt===0){offset=saved=initial=0;row=await reserve(asset,id,owner,force).catch(()=>null);persist=!!row;continue;}throw Object.assign(new Error('Download checksum differs from the pinned compiler snapshot.'),{name:'IntegrityError'});}
     signal.throwIfAborted();await forget(id,owner).catch(()=>{});return bytes;
    }catch(error){reader?.cancel().catch(()=>{});if(persist&&offset>saved)await checkpoint(asset,id,owner,bytes,saved,offset).catch(()=>{});throw error;}
   }
   throw new Error('Download could not be resumed.');
  }finally{signal.removeEventListener('abort',abortNetwork);network.abort();await release(id,owner).catch(()=>{});}
 }
 async function fetchBytes(asset,options){
  const span=trace('download',options.telemetryParent,options.observe);
  try{const id=assetId(asset),scoped={...options,telemetryParent:span.context};
   const bytes=await(globalThis.navigator?.locks?navigator.locks.request('scribyra-download:'+id,{ifAvailable:true},lock=>transfer(asset,scoped,!!lock)):transfer(asset,scoped,false));
   span.end('success',undefined,[{name:'bytes',value:bytes.byteLength}]);return bytes;
  }catch(error){if(error?.name==='IntegrityError')span.end('failure','integrity');else fail(span,error);throw error;}
 }
 async function runtimeInventory(){
  const cache=await caches.open(RUNTIME_CACHE),items=[];
  for(const key of await cache.keys()){const response=await cache.match(key),size=Number(response?.headers.get('Content-Length'));if(!Number.isSafeInteger(size)||size<=0){await cache.delete(key);continue;}let touched;try{touched=await transaction(['control'],'readonly',tx=>request(tx.objectStore('control').get('runtime:'+new URL(key.url).pathname.split('/').pop())));}catch{}items.push({key,size,used:touched?.used||Number(response.headers.get('X-Scribyra-Cached-At'))||0,path:response.headers.get('X-Scribyra-Asset')||'Compiler asset'});}return{cache,items};
 }
 async function pruneRuntime(localObserver){
  const limit=(await safeSettings()).runtimeBytes,{cache,items}=await runtimeInventory();let total=items.reduce((sum,item)=>sum+item.size,0);
  let span,count=0,bytes=0;
  try{for(const item of items.sort((a,b)=>a.used-b.used||a.key.url.localeCompare(b.key.url))){if(total<=limit)break;span||=trace('cache_evict',undefined,localObserver);const removed=await cache.delete(item.key);if(removed){count++;bytes+=item.size;}total-=item.size;}span?.end('success',undefined,[{name:'count',value:count},{name:'bytes',value:bytes}]);}
  catch(error){span?.end('failure',error?.name==='QuotaExceededError'?'quota':'unknown',[{name:'count',value:count},{name:'bytes',value:bytes}]);throw error;}
  return{bytes:total,count:(await cache.keys()).length,limit};
 }
 async function saveRuntime(key,response,asset,localObserver){
  if(asset.size>(await safeSettings()).runtimeBytes)return false;
  const headers=new Headers(response.headers);headers.set('X-Scribyra-Cached-At',String(Date.now()));headers.set('X-Scribyra-Asset',asset.path);
  const cache=await caches.open(RUNTIME_CACHE);await cache.put(key,new Response(response.body,{headers}));await touchRuntime(asset).catch(()=>{});await pruneRuntime(localObserver);return!!await cache.match(key);
 }
 async function touchRuntime(asset){return transaction(['control'],'readwrite',tx=>request(tx.objectStore('control').put({used:Date.now()},'runtime:'+asset.sha256)));}
 async function clearLegacyRuntime(){
  // Older releases used two unbounded compiler caches. Keep source/app stores
  // separate, and report an open old preload connection instead of claiming it
  // was removed. The pinned Biber wrapper no longer writes compiler data here.
  await caches.delete('scribyra-tex-v1.4.1');
  return new Promise(resolve=>{const deletion=indexedDB.deleteDatabase('EM_PRELOAD_CACHE');deletion.onsuccess=()=>resolve(true);deletion.onerror=deletion.onblocked=()=>resolve(false);});
 }
 async function trimPartials(){return transaction(['partials','chunks','control'],'readwrite',async tx=>{const limit=(await limitsIn(tx)).partialBytes,rows=(await request(tx.objectStore('partials').getAll())).sort((a,b)=>a.used-b.used);let total=rows.reduce((sum,row)=>sum+row.length,0);for(const row of rows)if(total>limit||!limit){await drop(tx,row);total-=row.length;}});}
 return{db,request,transaction,limitsIn,settings,validSettings,policy,header,fetchBytes,partials,clearPartials,forgetPartial:id=>forget(id),trimPartials,pruneRuntime,saveRuntime,touchRuntime,runtimeInventory,clearLegacyRuntime,RUNTIME_CACHE};
};
