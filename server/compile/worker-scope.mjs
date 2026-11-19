// Runs the browser's classic BusyTeX worker script (public/core/busytex/busytex_worker.js and
// the scripts it imports) unchanged under Node: each worker gets its own V8 context shaped like
// a DedicatedWorkerGlobalScope (self, importScripts, postMessage, fetch, location), so the
// Emscripten module takes the same "worker" code path as in the browser. Messages cross between
// the two sides asynchronously and are copied into the receiving side's realm, as structured
// cloning does between a page and its worker (the engine's glue checks `instanceof Uint8Array`
// against its own realm); the work itself runs on the calling thread, which is all a one-job
// compile process needs.
import vm from 'node:vm';
import {readFileSync} from 'node:fs';

// A runtime file's name from the part of a URL after the base: decoded, then refused unless every
// segment is a plain name (no empty, `.`, `..` or dot-file segment), so `%2e%2e%2f` cannot climb.
function runtimeName(rest){
 let name;try{name=decodeURIComponent(rest.split(/[?#]/)[0]);}catch{return null;}
 return name&&!name.split('/').some(part=>!part||part==='.'||part==='..'||part.startsWith('.'))?name:null;
}

// Answers requests for `${base}/<file>` from `root/<file>`; anything else is refused, so the
// engine reaches no network and no file outside the runtime. (The context is not a security
// boundary: host objects handed to it lead back to the host realm. The boundary is the Node
// process: its permission model and the sandbox around it.)
export function assetFetch(root,base){
 const prefix=base.replace(/\/$/,'')+'/';
 return async function fetch(input){
  const url=typeof input==='string'?input:input instanceof URL?input.href:input?.url;
  if(typeof url!=='string'||!url.startsWith(prefix))throw new TypeError(`The compile runtime has no network (refused ${String(url).slice(0,200)})`);
  const name=runtimeName(url.slice(prefix.length));
  if(!name)return new Response('',{status:404});
  let bytes;try{bytes=readFileSync(`${root}/${name}`);}catch{return new Response('',{status:404});}
  const type=name.endsWith('.wasm')?'application/wasm':name.endsWith('.js')?'text/javascript':name.endsWith('.json')?'application/json':'application/octet-stream';
  return new Response(bytes,{status:200,headers:{'content-type':type,'content-length':String(bytes.length)}});
 };
}

export class ScriptWorker {
 #listeners=new Map();#scope;#clone;#closed=false;
 onmessage=null;onerror=null;
 constructor(url,{root,base,fetch=assetFetch(root,base),console:log=console}){
  const prefix=base.replace(/\/$/,'')+'/',href=String(url);
  if(!href.startsWith(prefix))throw new TypeError('Worker script outside the compile runtime.');
  const toParent=data=>{if(this.#closed)return;const copy=structuredClone(data);setImmediate(()=>this.#dispatch('message',{data:copy}));};
  const scope={
   console:log,performance,crypto:globalThis.crypto,fetch,Response,Request,Headers,URL,URLSearchParams,Blob,
   TextDecoder,AbortController,AbortSignal,ReadableStream,WritableStream,TransformStream,DOMException,
   setTimeout,clearTimeout,setInterval,clearInterval,queueMicrotask,structuredClone,atob,btoa,
   WorkerGlobalScope:function WorkerGlobalScope(){},
   location:new URL(href),
   postMessage:toParent,onmessage:null,
  };
  scope.self=scope;
  scope.importScripts=(...urls)=>{for(const each of urls){const target=new URL(each,href).href,name=target.startsWith(prefix)&&runtimeName(target.slice(prefix.length));if(!name)throw new TypeError('importScripts outside the compile runtime.');vm.runInContext(readFileSync(`${root}/${name}`,'utf8'),this.#scope,{filename:target});}};
  this.#scope=vm.createContext(scope,{name:'busytex-worker'});
  // Realm-local helpers: a deep copy of message data into this context (plain objects, arrays,
  // typed arrays and ArrayBuffers, which is all the engine's messages hold), and a TextEncoder
  // whose output is this realm's Uint8Array.
  this.#clone=vm.runInContext(`(function clone(value,seen=new Map()){
   if(value===null||typeof value!=='object')return value;
   if(seen.has(value))return seen.get(value);
   const tag=Object.prototype.toString.call(value).slice(8,-1);let out;
   if(tag==='ArrayBuffer'){out=new ArrayBuffer(value.byteLength);new Uint8Array(out).set(new Uint8Array(value));}
   else if(ArrayBuffer.isView(value)&&typeof globalThis[tag]==='function')out=new globalThis[tag](value);
   else if(Array.isArray(value)){out=[];seen.set(value,out);for(const item of value)out.push(clone(item,seen));return out;}
   else{out={};seen.set(value,out);for(const key of Object.keys(value))out[key]=clone(value[key],seen);return out;}
   seen.set(value,out);return out;
  })`,this.#scope);
  scope.__hostEncoder=new TextEncoder();
  vm.runInContext(`(()=>{const host=globalThis.__hostEncoder;delete globalThis.__hostEncoder;globalThis.TextEncoder=class TextEncoder{get encoding(){return 'utf-8';}encode(text=''){const bytes=host.encode(text);return new Uint8Array(bytes.buffer,bytes.byteOffset,bytes.byteLength);}encodeInto(text,target){return host.encodeInto(text,target);}};})()`,this.#scope);
  scope.importScripts(href);
 }
 #dispatch(type,event){
  if(this.#closed)return;
  const handler=type==='message'?this.onmessage:this.onerror;
  try{handler?.call(this,event);for(const listener of [...(this.#listeners.get(type)||[])])listener.call(this,event);}
  catch(error){if(type!=='error')this.#dispatch('error',{error,message:String(error?.message||error),preventDefault(){}});else throw error;}
 }
 postMessage(data){
  if(this.#closed)return;
  const copy=this.#clone(data);
  setImmediate(()=>{
   if(this.#closed)return;
   try{const result=this.#scope.onmessage?.({data:copy});if(result&&typeof result.catch==='function')result.catch(error=>this.#dispatch('error',{error,message:String(error?.message||error),preventDefault(){}}));}
   catch(error){this.#dispatch('error',{error,message:String(error?.message||error),preventDefault(){}});}
  });
 }
 addEventListener(type,listener){if(!this.#listeners.has(type))this.#listeners.set(type,new Set());this.#listeners.get(type).add(listener);}
 removeEventListener(type,listener){this.#listeners.get(type)?.delete(listener);}
 terminate(){this.#closed=true;this.#listeners.clear();this.onmessage=this.onerror=null;}
}
