import {validate_provider_request} from './pkg/scribyra_app.js';
import {observed} from './observability.js';
const MAX_RESULT=8*1024*1024;
export function providerUrl(value){
 const url=new URL(value);if(!['https:','http:'].includes(url.protocol)||url.username||url.password||url.hash||url.search||url.port==='0'||(url.protocol==='http:'&&!['localhost','127.0.0.1','[::1]'].includes(url.hostname)))throw new Error('Use an HTTPS MCP endpoint, or HTTP on localhost. Credentials belong in the token field.');return url;
}
function validate(operation,permissions,id=crypto.randomUUID()){
 try{return JSON.parse(validate_provider_request(JSON.stringify({version:1,id,operation}),JSON.stringify(permissions)));}catch(error){let details;try{details=JSON.parse(String(error));}catch{}throw Object.assign(new Error(details?.message||String(error)),{code:details?.code});}
}
function resultBound(value){if(new TextEncoder().encode(JSON.stringify(value)).length>MAX_RESULT)throw new Error('Provider results are limited to 8 MiB.');return value;}
// Bound both JSON responses and HTTP/SSE streams. Never follow redirects with
// provider credentials, and do not send cookies or the editor referrer.
export function providerFetch(base,fetcher=fetch){
 return async(input,options={})=>{
  const url=new URL(typeof input==='string'?input:input.url||String(input));if(url.origin!==base.origin||url.pathname!==base.pathname||url.search||url.hash)throw new Error('The provider tried to use another endpoint.');
  const response=await fetcher(input,{...options,credentials:'omit',referrerPolicy:'no-referrer',redirect:'error'});
  if(Number(response.headers.get('content-length')||0)>MAX_RESULT){await response.body?.cancel();throw new Error('Provider response exceeds 8 MiB.');}
  if(!response.body)return response;const reader=response.body.getReader();let length=0;
  const stream=new ReadableStream({async pull(controller){try{const{done,value}=await reader.read();if(done){controller.close();return;}if((length+=value.byteLength)>MAX_RESULT){await reader.cancel();throw new Error('Provider response exceeds 8 MiB.');}controller.enqueue(value);}catch(error){controller.error(error);}},cancel:reason=>reader.cancel(reason)});
  return new Response(stream,{status:response.status,statusText:response.statusText,headers:response.headers});
 };
}
export const httpProvider=options=>observed('provider',()=>connectHttp(options));
async function connectHttp({url,token='',permissions,signal,onClose=()=>{}}){
 permissions=Object.freeze({...permissions});validate({method:permissions.tools?'tools/list':permissions.resources?'resources/list':'prompts/list'},permissions);
 const endpoint=providerUrl(url);if(typeof token!=='string'||token.length>8192||/[\r\n]/.test(token))throw new Error('Invalid provider token.');
 const {Client,StreamableHTTPClientTransport}=await import('@modelcontextprotocol/client');
 const client=new Client({name:'Scribyra',version:'0.1.0'},{capabilities:{},versionNegotiation:{mode:'auto',probe:{timeoutMs:15000,maxRetries:0}},inputRequired:{autoFulfill:false},listMaxPages:16,defaultCacheTtlMs:0});
 const transport=new StreamableHTTPClientTransport(endpoint,{requestInit:{headers:token?{Authorization:`Bearer ${token}`}:{},credentials:'omit',redirect:'error',referrerPolicy:'no-referrer'},fetch:providerFetch(endpoint),reconnectionOptions:{maxRetries:0,initialReconnectionDelay:1000,maxReconnectionDelay:1000,reconnectionDelayGrowFactor:1}});
 const lifetime=new AbortController();let closed=false;const pending=new Set();
 async function close(){if(closed)return;closed=true;lifetime.abort();signal?.removeEventListener('abort',abort);globalThis.window?.removeEventListener('pagehide',abort);await client.close().catch(()=>{});onClose();}
 const abort=()=>{void close();};signal?.addEventListener('abort',abort,{once:true});globalThis.window?.addEventListener('pagehide',abort,{once:true});client.onclose=abort;
 try{await client.connect(transport,{signal:AbortSignal.any([lifetime.signal,signal,AbortSignal.timeout(20000)].filter(Boolean)),timeout:20000});if(signal?.aborted||closed)throw new DOMException('Provider connection cancelled','AbortError');}
 catch(error){await close();throw new Error('Could not connect to this HTTP MCP provider. Check its endpoint, token and CORS/local-network permissions.',{cause:error});}
 return{transport:'http',name:endpoint.href,permissions,info:{serverInfo:client.getServerVersion(),capabilities:client.getServerCapabilities()},get active(){return !closed;},close,async request(operation,{signal}={}){
  return observed('provider',async()=>{
  if(closed)throw new Error('Provider is disconnected.');validate(operation,permissions);if(pending.size>=4)throw new Error('At most four provider requests may be active.');
  const controller=new AbortController();pending.add(controller);const options={signal:AbortSignal.any([lifetime.signal,signal,controller.signal].filter(Boolean)),timeout:120000};
  try{let result;const{method,...params}=operation;for(const key of Object.keys(params))if(params[key]===null)delete params[key];switch(method){
   case 'tools/list':result=await client.listTools(params,options);break;
   case 'tools/call':result=await client.callTool(params,options);break;
   case 'resources/list':result=await client.listResources(params,options);break;
   case 'resources/templates/list':result=await client.listResourceTemplates(params,options);break;
   case 'resources/read':result=await client.readResource(params,options);break;
   case 'prompts/list':result=await client.listPrompts(params,options);break;
   case 'prompts/get':result=await client.getPrompt(params,options);break;
  }options.signal.throwIfAborted();return resultBound(result);}catch(error){if(options.signal.aborted)throw new DOMException('Provider request cancelled','AbortError');throw error;}finally{pending.delete(controller);}
  },{outcome:result=>result?.isError===true?'failure':'success',failure:'rejected',metrics:()=>[{name:'count',value:1}]});
 }};
}
// Local stdio providers depend on the discontinued Rust companion; the editor
// offers them only behind the test-only scribyra-companion-dev switch.
export const localProvider=options=>observed('provider',()=>connectLocal(options));
async function connectLocal({companion,providerId,permissions,signal,onClose=()=>{}}){
 permissions=Object.freeze({...permissions});validate({method:permissions.tools?'tools/list':permissions.resources?'resources/list':'prompts/list'},permissions);
 if(!companion?.active)throw new Error('Pair the Rust companion before connecting a local provider.');
 const connectionId=crypto.randomUUID(),cancelConnect=()=>{if(companion.active)void companion.providerRequest(`/providers/${connectionId}`,{method:'DELETE'}).catch(()=>{});};
 signal?.addEventListener('abort',cancelConnect,{once:true});let connected;try{signal?.throwIfAborted();connected=await companion.providerRequest('/providers',{method:'POST',body:{connectionId,providerId,permissions},signal});}catch(error){cancelConnect();throw error;}finally{signal?.removeEventListener('abort',cancelConnect);}
 const lifetime=new AbortController();let closed=false;
 async function close(){if(closed)return;closed=true;lifetime.abort();signal?.removeEventListener('abort',abort);companion.signal.removeEventListener('abort',abort);try{await companion.providerRequest(`/providers/${connected.id}`,{method:'DELETE'});}catch{}onClose();}
 const abort=()=>{void close();};signal?.addEventListener('abort',abort,{once:true});companion.signal.addEventListener('abort',abort,{once:true});
 if(signal?.aborted||companion.signal.aborted){await close();throw new DOMException('Provider connection cancelled','AbortError');}
 return{...connected,permissions,get active(){return !closed&&!companion.signal.aborted;},close,async request(operation,{signal}={}){
  return observed('provider',async parent=>{
  if(closed)throw new Error('Provider is disconnected.');const request=validate(operation,permissions),combined=AbortSignal.any([lifetime.signal,signal].filter(Boolean));
  const cancel=()=>{if(companion.active)void companion.providerRequest(`/providers/${connected.id}/requests/${request.id}`,{method:'DELETE'}).catch(()=>{});};
  combined.addEventListener('abort',cancel,{once:true});try{combined.throwIfAborted();return resultBound(await companion.providerRequest(`/providers/${connected.id}/request`,{method:'POST',body:companion.diagnostics&&parent?{...request,telemetry:{traceId:parent.traceId,spanId:parent.spanId}}:request,signal:combined}));}finally{combined.removeEventListener('abort',cancel);}
  },{outcome:result=>result?.isError===true?'failure':'success',failure:'rejected',metrics:()=>[{name:'count',value:1}]});
 }};
}
