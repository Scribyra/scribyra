// The server's WebAssembly compile runner, without the sandbox: the worker-shaped context the
// browser's BusyTeX worker script runs in, the read-only package cache host, and the project
// reader. (The whole runner in the sandbox: crates/compile/tests/wasm.rs.)
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,mkdirSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ScriptWorker,assetFetch} from '../server/compile/worker-scope.mjs';
import {cacheHost,readProject,boundedLog,serverLog,memoryMessage} from '../server/compile/runner.mjs';

const BASE='https://runtime.invalid/core/busytex';
function runtime(script){
 const root=mkdtempSync(join(tmpdir(),'scribyra-wasm-scope-'));
 writeFileSync(join(root,'worker.js'),script);writeFileSync(join(root,'helper.js'),'self.helperLoaded=true;');writeFileSync(join(root,'data.bin'),new Uint8Array([1,2,3]));
 return root;
}
const next=worker=>new Promise(resolve=>worker.addEventListener('message',({data})=>resolve(data)));

test('the asset fetch serves the runtime only: no network, no traversal, no dot files',async()=>{
 const root=runtime(''),fetch=assetFetch(root,BASE);
 try{
  assert.deepEqual([...new Uint8Array(await (await fetch(`${BASE}/data.bin`)).arrayBuffer())],[1,2,3]);
  for(const url of ['https://example.org/x','file:///etc/passwd','https://runtime.invalid/core/busytexx/data.bin'])await assert.rejects(fetch(url),/no network/);
  for(const url of [`${BASE}/../../etc/passwd`,`${BASE}/%2e%2e/%2e%2e/etc/passwd`,`${BASE}/.hidden`,`${BASE}/missing`,`${BASE}/`])assert.equal((await fetch(url)).status,404,url);
 }finally{rmSync(root,{recursive:true});}
});

test('the worker script runs in its own worker-shaped realm and messages are copied into each realm',async()=>{
 const root=runtime(`importScripts('helper.js');
  onmessage=({data})=>postMessage({helper:self.helperLoaded===true,worker:typeof WorkerGlobalScope==='function',node:typeof process,require:typeof require,
   bytesHere:data.bytes instanceof Uint8Array,encoded:new TextEncoder().encode('ä') instanceof Uint8Array,location:location.pathname,reply:new Uint8Array([9,8])});`);
 const worker=new ScriptWorker(`${BASE}/worker.js`,{root,base:BASE});
 try{
  const reply=next(worker);worker.postMessage({bytes:new Uint8Array([1])});const data=await reply;
  assert.deepEqual({...data,reply:undefined},{helper:true,worker:true,node:'undefined',require:'undefined',bytesHere:true,encoded:true,location:'/core/busytex/worker.js',reply:undefined});
  assert(data.reply instanceof Uint8Array,'the reply is this realm\u2019s Uint8Array');
 }finally{worker.terminate();rmSync(root,{recursive:true});}
 const outside=runtime(`importScripts('https://example.org/evil.js');`);
 try{assert.throws(()=>new ScriptWorker(`${BASE}/worker.js`,{root:outside,base:BASE}),/outside the compile runtime/);}
 finally{rmSync(outside,{recursive:true});}
 assert.throws(()=>new ScriptWorker('https://example.org/worker.js',{root:outside,base:BASE}),/outside the compile runtime/);
});

test('the package cache host reads verified-by-name archives and asks the worker for the rest',async()=>{
 const cache=mkdtempSync(join(tmpdir(),'scribyra-wasm-cache-')),hash='a'.repeat(128),asked=[];
 try{
  const host=cacheHost({cache,fill:name=>{asked.push(name);writeFileSync(join(cache,`${hash}.tar.xz`),new Uint8Array([7]));},operations:()=>{}});
  assert.equal(await host.cachedArchive(hash),undefined);
  await assert.rejects(host.cachedArchive('../../etc/passwd'),/Invalid package checksum/);
  assert.deepEqual([...await host.downloadArchive({name:'babel-romanian',sha512:hash})],[7]);
  assert.deepEqual(asked,['babel-romanian']);
  await assert.rejects(host.downloadArchive({name:'../x',sha512:hash}),/Invalid TeX package name/);
  assert.equal(await host.cacheArchive(),true);
  await assert.rejects(cacheHost({cache,fill:null,operations:()=>{}}).downloadArchive({name:'x',sha512:hash}),/no package cache channel/);
 }finally{rmSync(cache,{recursive:true});}
});

test('the project reader skips the sandbox\u2019s dot directories and keeps binary files as bytes',()=>{
 const work=mkdtempSync(join(tmpdir(),'scribyra-wasm-work-'));
 try{
  mkdirSync(join(work,'.home'));writeFileSync(join(work,'.home','x.tex'),'no');mkdirSync(join(work,'ch'));
  writeFileSync(join(work,'main.tex'),'\\input{ch/a}');writeFileSync(join(work,'ch','a.tex'),'A');writeFileSync(join(work,'fig.png'),new Uint8Array([0x89,0x50]));
  const files=readProject(work);
  assert.deepEqual(files.map(f=>f.path),['ch/a.tex','fig.png','main.tex']);
  assert.equal(files[2].content,'\\input{ch/a}');assert(files[1].content instanceof Uint8Array);
 }finally{rmSync(work,{recursive:true});}
});

test('the server log puts diagnostics naming files first and bounds TeX\u2019s log',()=>{
 const result={log:'x'.repeat(5000)+'END',report:{issues:[{severity:'error',file:'ch/a.tex',line:3,summary:'Undefined control sequence.'},{severity:'warning',summary:'ignored'}]}};
 assert.equal(serverLog({...result,log:''}),'Diagnostics:\nch/a.tex:3: Undefined control sequence.\n\n');
 const log=boundedLog(result,100);
 assert(log.startsWith('Diagnostics:\nch/a.tex:3: Undefined control sequence.\n\n[log truncated to its last 100 bytes of 5003]\n')&&log.endsWith('END'),log);
 assert.match(memoryMessage(576),/576 MiB; this build of BusyTeX addresses at most 2 GiB, wasm32 itself stops at 4 GB/);
});

test('importScripts cannot climb out of the runtime with encoded separators',()=>{
 const root=runtime(`importScripts('..%2f..%2f..%2fetc%2fpasswd');`);
 try{assert.throws(()=>new ScriptWorker(`${BASE}/worker.js`,{root,base:BASE}),/outside the compile runtime/);}
 finally{rmSync(root,{recursive:true});}
});
