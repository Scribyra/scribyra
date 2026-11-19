// The plugin sandbox (docs/plugins.md#sandbox): per plugin, a hidden iframe with
// sandbox="allow-scripts" (an opaque origin: no IndexedDB, storage, cookies or access to
// this page) and a deny-all Content Security Policy. Its only script is the bootstrap
// below, which starts a dedicated Worker from a blob: URL. The plugin's code runs only in
// that Worker, with no DOM and no WebRTC, and reaches the app only through the
// MessagePort handed to it. Removing the iframe ends the worker.
export const SANDBOX_CSP="default-src 'none'; script-src 'unsafe-inline' 'wasm-unsafe-eval'; worker-src blob:; connect-src 'none'; img-src 'none'; style-src 'none'; font-src 'none'; media-src 'none'; frame-src 'none'; child-src blob:; form-action 'none'; base-uri 'none'";

// Runs inside the iframe. It accepts exactly one message from the embedding page.
function bootstrap(){
  addEventListener('message',function boot(event){
    if(event.source!==parent||!event.data||event.data.type!=='scribyra-plugin-boot'||event.ports.length!==2)return;
    removeEventListener('message',boot);
    const [pluginPort,control]=event.ports;
    try{
      const url=URL.createObjectURL(new Blob([event.data.source],{type:'text/javascript'}));
      const worker=new Worker(url,{name:'scribyra-plugin'});
      worker.onerror=error=>{control.postMessage({type:'error',message:String(error.message||'The plugin could not start.').slice(0,500)});};
      worker.onmessage=()=>{};
      worker.postMessage({type:'scribyra-init',files:event.data.files,binary:event.data.binary,plugin:event.data.plugin},[pluginPort]);
      control.postMessage({type:'started'});
    }catch(error){control.postMessage({type:'error',message:String(error&&error.message||error).slice(0,500)});}
  });
}

// Runs first in the worker, before any plugin code: removes every way out except the
// port, then builds the `scribyra` object. The CSP already blocks these; this is the
// second layer, checked separately by the browser tests.
export function pluginRuntime(start){
  'use strict';
  const scope=self;
  for(const name of ['fetch','XMLHttpRequest','WebSocket','EventSource','WebTransport','importScripts','indexedDB','caches','Worker','SharedWorker','BroadcastChannel','RTCPeerConnection','webkitRTCPeerConnection','cookieStore','storageFoundation','navigator.storage','WebSocketStream','FontFace','fonts']){
    let target=scope,key=name;if(name.startsWith('navigator.')){target=scope.navigator;key=name.slice(10);}
    for(let object=target;object;object=Object.getPrototypeOf(object)){
      try{if(Object.getOwnPropertyDescriptor(object,key)?.configurable)delete object[key];}catch{}
    }
    try{if(key in target)Object.defineProperty(target,key,{value:undefined,configurable:false,writable:false});}catch{}
  }
  let port=null,next=1;const queue=[],pending=new Map(),handlers=new Map(),listeners=new Map();
  const send=message=>{const full={scribyra:1,...message};if(port)port.postMessage(full);else queue.push(full);};
  const failure=error=>{const value=new Error(error?.message||'The request failed.');value.code=error?.code||'failed';return value;};
  async function onMessage(event){
    const message=event.data;if(!message||message.scribyra!==1)return;
    if(message.type==='response'){const waiting=pending.get(message.id);if(!waiting)return;pending.delete(message.id);if(message.error)waiting.reject(failure(message.error));else waiting.resolve(message.result);return;}
    if(message.type==='event'){for(const listener of listeners.get(message.event)||[])try{await listener(message.data);}catch(error){report(error);}return;}
    if(message.type==='request'){
      const handler=handlers.get(message.method);
      try{if(!handler)throw Object.assign(new Error(`This plugin does not handle “${message.method}”.`),{code:'unsupported'});send({type:'response',id:message.id,result:(await handler(message.params))??null});}
      catch(error){send({type:'response',id:message.id,error:{code:String(error?.code||'failed').slice(0,64),message:String(error?.message||error).slice(0,2000)}});}
    }
  }
  function report(error){send({type:'event',event:'plugin.error',data:{message:String(error?.message||error).slice(0,500)}});}
  scope.addEventListener('error',event=>report(event.error||event.message));
  scope.addEventListener('unhandledrejection',event=>report(event.reason));
  const api={
    files:{},
    plugin:null,
    call(method,params={},{signal}={}){
      return new Promise((resolve,reject)=>{
        const id=next++;
        if(signal?.aborted){reject(Object.assign(new Error('Aborted.'),{name:'AbortError',code:'aborted'}));return;}
        pending.set(id,{resolve,reject});send({type:'request',id,method,params});
        signal?.addEventListener('abort',()=>{if(!pending.has(id))return;pending.delete(id);if(method==='net.fetch'&&params?.requestId)send({type:'request',id:next++,method:'net.abort',params:{requestId:params.requestId}});reject(Object.assign(new Error('Aborted.'),{name:'AbortError',code:'aborted'}));},{once:true});
      });
    },
    on(event,listener){if(!listeners.has(event))listeners.set(event,new Set());listeners.get(event).add(listener);return()=>listeners.get(event).delete(listener);},
    handle(method,handler){handlers.set(method,handler);},
  };
  Object.freeze(api.call);
  scope.addEventListener('message',function init(event){
    if(!event.data||event.data.type!=='scribyra-init'||!event.ports[0])return;
    scope.removeEventListener('message',init);
    port=event.ports[0];port.onmessage=onMessage;
    api.files=Object.freeze({...event.data.files,...event.data.binary});api.plugin=Object.freeze(event.data.plugin);
    for(const message of queue.splice(0))port.postMessage(message);
    try{start(api);}catch(error){report(error);}
  });
}

/** The worker source: runtime first, then the plugin's code wrapped in a function. */
export function workerSource(code){
  return `(${pluginRuntime.toString()})(function(scribyra){${code}\n});\n`;
}

/**
 * Starts a plugin. Returns {port, stop}; `onExit(reason)` is called once if the sandbox
 * reports an error before or while starting.
 */
export function createSandbox({code,files={},binary={},plugin,container=document.body,onExit=()=>{}}){
  const frame=document.createElement('iframe');
  frame.setAttribute('sandbox','allow-scripts');
  frame.setAttribute('aria-hidden','true');frame.tabIndex=-1;frame.title='';
  frame.className='plugin-sandbox';frame.dataset.plugin=plugin.id;
  frame.setAttribute('referrerpolicy','no-referrer');
  frame.setAttribute('allow',"camera 'none'; microphone 'none'; geolocation 'none'; display-capture 'none'; clipboard-read 'none'; clipboard-write 'none'; usb 'none'; serial 'none'; bluetooth 'none'; payment 'none'");
  frame.srcdoc=`<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${SANDBOX_CSP}"><script>(${bootstrap.toString()})();<\/script>`;
  const channel=new MessageChannel(),control=new MessageChannel();
  let stopped=false;
  const stop=()=>{if(stopped)return;stopped=true;channel.port1.close();control.port1.close();frame.remove();};
  control.port1.onmessage=event=>{if(event.data?.type==='error'&&!stopped){onExit(event.data.message);}};
  frame.addEventListener('load',()=>{
    if(stopped)return;
    frame.contentWindow.postMessage({type:'scribyra-plugin-boot',source:workerSource(code),files,binary,plugin},'*',[channel.port2,control.port2]);
  },{once:true});
  container.append(frame);
  return {port:channel.port1,stop,frame};
}
