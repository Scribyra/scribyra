import 'fake-indexeddb/auto';
import {test,beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {downloads} from '../web/downloads.js';
const bytes=Uint8Array.from({length:2*1024*1024+31},(_,i)=>i%251);
const asset={kind:'runtime',label:'test engine',size:bytes.length,algorithm:'SHA-256',hash:createHash('sha256').update(bytes).digest('hex')};
beforeEach(()=>downloads.transaction(['control','partials','chunks'],'readwrite',async(tx,r)=>{for(const name of ['control','partials','chunks'])await r(tx.objectStore(name).clear());}));
function interrupted(prefix){let first=true;return new Response(new ReadableStream({pull(controller){if(first){first=false;controller.enqueue(prefix);}else controller.error(new Error('Connection lost'));}}));}
async function seed(prefix=bytes.slice(0,1200000)){await assert.rejects(downloads.fetchBytes(asset,{url:'/engine',fetcher:async()=>interrupted(prefix)}),/Connection lost/);return(await downloads.partials())[0];}
function ranged(offset,body=bytes.slice(offset),headers={}){return new Response(body,{status:206,headers:{'Content-Range':`bytes ${offset}-${bytes.length-1}/${bytes.length}`,...headers}});}
test('interrupted chunks survive a new downloader instance and resume at the exact durable byte',async()=>{
 const row=await seed();assert.equal(row.length,1200000);const reloaded=globalThis.createScribyraDownloads(downloads.policy);let requests=0;
 const result=await reloaded.fetchBytes(asset,{url:'/engine',fetcher:async(_url,{headers,credentials,referrerPolicy})=>{requests++;assert.equal(headers.get('Range'),'bytes=1200000-');assert.equal(credentials,'omit');assert.equal(referrerPolicy,'no-referrer');return ranged(1200000);}});
 assert.deepEqual(result,bytes);assert.equal(requests,1);assert.deepEqual(await downloads.partials(),[]);
});
test('ignored, hidden, malformed and encoded range responses restart without stitching unverified bytes',async()=>{
 for(const mode of ['ignored','hidden','wrong-start','wrong-total','encoded','range-416']){
  await downloads.clearPartials();await seed();let calls=0;
  const result=await downloads.fetchBytes(asset,{url:'/engine',fetcher:async(_url,{headers})=>{calls++;if(calls===2){assert.equal(headers.get('Range'),null);return new Response(bytes);}assert.equal(headers.get('Range'),'bytes=1200000-');if(mode==='ignored')return new Response(bytes);if(mode==='hidden')return new Response(bytes.slice(1200000),{status:206});if(mode==='range-416')return new Response('',{status:416});return ranged(1200000,bytes.slice(1200000),mode==='wrong-start'?{'Content-Range':`bytes 1-${bytes.length-1}/${bytes.length}`} :mode==='wrong-total'?{'Content-Range':`bytes 1200000-${bytes.length-1}/${bytes.length+1}`}:{'Content-Encoding':'gzip'});}});
  assert.deepEqual(result,bytes);assert.equal(calls,mode==='ignored'?1:2);
 }
});
test('offline fallback failure preserves the durable prefix for a later attempt',async()=>{
 await seed();await assert.rejects(downloads.fetchBytes(asset,{url:'/engine',fetcher:async()=>{throw new Error('Offline');}}),/Offline/);assert.equal((await downloads.partials())[0].length,1200000);
});
test('a stale but internally hashed prefix cannot bypass the complete digest and retries from zero',async()=>{
 const changed=bytes.slice(0,1200000);changed[0]^=1;await seed(changed);let calls=0;
 const result=await downloads.fetchBytes(asset,{url:'/engine',fetcher:async(_url,{headers})=>{calls++;return headers.has('Range')?ranged(1200000):new Response(bytes);}});
 assert.deepEqual(result,bytes);assert.equal(calls,2);
});
test('corrupt stored chunks restart cleanly; oversized and corrupt complete responses never survive',async()=>{
 const row=await seed();await downloads.transaction(['chunks'],'readwrite',(tx,r)=>r(tx.objectStore('chunks').put({bytes:new Uint8Array([7]),sha256:'0'.repeat(64)},[row.id,0])));
 assert.deepEqual(await downloads.fetchBytes(asset,{url:'/engine',fetcher:async(_url,{headers})=>{assert.equal(headers.get('Range'),null);return new Response(bytes);}}),bytes);
 await assert.rejects(downloads.fetchBytes(asset,{url:'/engine',fetcher:async()=>new Response(new Uint8Array(bytes.length+1))}),/changed|size/);assert.deepEqual(await downloads.partials(),[]);
 await assert.rejects(downloads.fetchBytes(asset,{url:'/engine',fetcher:async()=>new Response(new Uint8Array(bytes.length))}),/checksum/);assert.deepEqual(await downloads.partials(),[]);
});
test('abort retains received data and a disabled partial cache remains functional online',async()=>{
 const abort=new AbortController();await assert.rejects(downloads.fetchBytes(asset,{url:'/engine',signal:abort.signal,onProgress:loaded=>{if(loaded>=1200000)abort.abort();},fetcher:async()=>new Response(new ReadableStream({start(c){c.enqueue(bytes.slice(0,1200000));}}))}),{name:'AbortError'});assert.equal((await downloads.partials())[0].length,1200000);
 await downloads.clearPartials();await downloads.transaction(['control'],'readwrite',(tx,r)=>r(tx.objectStore('control').put({...downloads.policy.defaults,partialBytes:0},'limits')));
 await assert.rejects(downloads.fetchBytes(asset,{url:'/engine',fetcher:async()=>interrupted(bytes.slice(0,1200000))}),/Connection lost/);assert.deepEqual(await downloads.partials(),[]);
 assert.deepEqual(await downloads.fetchBytes(asset,{url:'/engine',fetcher:async()=>new Response(bytes)}),bytes);
});
test('partial quota failure permits verified online downloads without claiming a checkpoint',async()=>{
 const original=IDBObjectStore.prototype.put;IDBObjectStore.prototype.put=function(...args){if(this.name==='chunks')throw new DOMException('Full','QuotaExceededError');return original.apply(this,args);};
 try{assert.deepEqual(await downloads.fetchBytes(asset,{url:'/engine',fetcher:async()=>new Response(bytes)}),bytes);}finally{IDBObjectStore.prototype.put=original;}
 assert.deepEqual(await downloads.partials(),[]);
});
test('archive and metadata retries use their pinned algorithms and never persist a complete bad archive',async()=>{
 for(const[kind,algorithm]of [['archive','SHA-512'],['metadata','SHA-256']]){
  const content=bytes.slice(0,1500000),item={kind,algorithm,label:kind,size:content.length,hash:createHash(algorithm==='SHA-512'?'sha512':'sha256').update(content).digest('hex')};
  await assert.rejects(downloads.fetchBytes(item,{url:'/component',fetcher:async()=>interrupted(content.slice(0,1100000))}),/Connection lost/);
  assert.deepEqual(await downloads.fetchBytes(item,{url:'/component',fetcher:async(_,{headers})=>{assert.equal(headers.get('Range'),'bytes=1100000-');return new Response(content.slice(1100000),{status:206,headers:{'Content-Range':`bytes 1100000-${content.length-1}/${content.length}`}});}}),content);
 }
});
test('expired prefixes are discarded, partial limits trim durably, and another owner cannot erase an active checkpoint',async()=>{
 const row=await seed();await downloads.transaction(['partials'],'readwrite',(tx,r)=>r(tx.objectStore('partials').put({...row,owner:'other tab',until:Date.now()+30000},row.id)));
 const competing=()=>downloads.fetchBytes(asset,{url:'/engine',fetcher:async(_,{headers})=>{assert.equal(headers.get('Range'),null);return new Response(bytes);}});
 // Runtimes with Web Locks can correctly reclaim stale lease metadata when no
 // lock exists. Hold the other tab's actual lock to represent an active owner.
 assert.deepEqual(await(globalThis.navigator?.locks?navigator.locks.request('scribyra-download:'+row.id,competing):competing()),bytes);assert.equal((await downloads.partials())[0].length,1200000);
 await downloads.transaction(['partials'],'readwrite',(tx,r)=>r(tx.objectStore('partials').put({...row,used:Date.now()-8*86400000},row.id)));
 await assert.rejects(downloads.fetchBytes(asset,{url:'/engine',fetcher:async(_,{headers})=>{assert.equal(headers.get('Range'),null);return interrupted(bytes.slice(0,100));}}),/Connection lost/);assert.equal((await downloads.partials())[0].length,100);
 await downloads.transaction(['control'],'readwrite',(tx,r)=>r(tx.objectStore('control').put({...downloads.policy.defaults,partialBytes:0},'limits')));await downloads.trimPartials();assert.deepEqual(await downloads.partials(),[]);
});
test('the public cache upgrade preserves v1 archive and metadata bytes and builds a small index',async()=>{
 await new Promise((resolve,reject)=>{const r=indexedDB.deleteDatabase('scribyra-tex-packages');r.onsuccess=resolve;r.onerror=()=>reject(r.error);});
 const old=await new Promise((resolve,reject)=>{const r=indexedDB.open('scribyra-tex-packages',1);r.onupgradeneeded=()=>r.result.createObjectStore('archives');r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});
 await new Promise((resolve,reject)=>{const tx=old.transaction('archives','readwrite'),store=tx.objectStore('archives');store.put({bytes:new Uint8Array([1,2]),used:42,package:{name:'ieeetran'}},'archive');store.put({kind:'metadata',bytes:new Uint8Array([3]),path:'root.json'},'metadata:root');tx.oncomplete=resolve;tx.onabort=()=>reject(tx.error);});old.close();
 const db=await downloads.db();assert.equal(db.version,2);
 assert.deepEqual(await downloads.transaction(['headers'],'readonly',(tx,r)=>r(tx.objectStore('headers').getAll())),[{id:'archive',kind:'archive',size:2,used:42,package:{name:'ieeetran'},path:null},{id:'metadata:root',kind:'metadata',size:1,used:0,package:null,path:'root.json'}]);
 assert.deepEqual((await downloads.transaction(['archives'],'readonly',(tx,r)=>r(tx.objectStore('archives').get('archive')))).bytes,new Uint8Array([1,2]));
});
test('an old open tab blocks public cache migration with an actionable error; closing it permits retry',async()=>{
 await new Promise((resolve,reject)=>{const r=indexedDB.deleteDatabase('scribyra-tex-packages');r.onsuccess=resolve;r.onerror=()=>reject(r.error);});
 const old=await new Promise((resolve,reject)=>{const r=indexedDB.open('scribyra-tex-packages',1);r.onupgradeneeded=()=>r.result.createObjectStore('archives');r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});
 const fresh=globalThis.createScribyraDownloads(downloads.policy);await assert.rejects(fresh.db(),/Close older Scribyra tabs/);old.close();
 // Queue a new opener behind the aborted migration before retrying the adapter.
 const barrier=await new Promise((resolve,reject)=>{const r=indexedDB.open('scribyra-tex-packages');r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});barrier.close();assert.equal((await fresh.db()).version,2);
});
test('a stalled response times out, aborts the network and preserves a resumable prefix',async()=>{
 let networkSignal;await assert.rejects(downloads.fetchBytes(asset,{url:'/engine',idleTimeoutMs:50,fetcher:async(_,{signal})=>{networkSignal=signal;return new Response(new ReadableStream({start(controller){controller.enqueue(bytes.slice(0,1200000));}}));}}),/No download progress/);
 assert.equal(networkSignal.aborted,true);assert.equal((await downloads.partials())[0].length,1200000);
 assert.deepEqual(await downloads.fetchBytes(asset,{url:'/engine',fetcher:async()=>ranged(1200000)}),bytes);
 await assert.rejects(downloads.fetchBytes(asset,{url:'/engine',idleTimeoutMs:50,fetcher:()=>new Promise(()=>{})}),/No download progress/);assert.deepEqual(await downloads.partials(),[]);
});
