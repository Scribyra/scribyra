// DISCONTINUED (November 8, 2026, the owner's decision): the Rust companion is no
// longer part of Scribyra. This module stays for its tests only and is reachable
// solely behind the test-only localStorage switch `scribyra-companion-dev`.
const encoder=new TextEncoder();
const hex=bytes=>[...bytes].map(byte=>byte.toString(16).padStart(2,'0')).join('');
const unhex=text=>Uint8Array.from(text.match(/../g),pair=>parseInt(pair,16));
const flags=p=>[p.read,p.write,p.compile,p.export].map(value=>value?'1':'0').join('');
const validSecret=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
export function companionUrl(value){
 const url=new URL(value);if(url.protocol!=='http:'||!['127.0.0.1','localhost'].includes(url.hostname)||url.username||url.password||url.pathname!=='/'||url.search||url.hash||url.port==='0')throw new Error('Enter the companion’s local HTTP address, such as http://127.0.0.1:43821.');
 url.hostname='127.0.0.1';return url.origin;
}
async function key(code){const digest=await crypto.subtle.digest('SHA-256',encoder.encode(code));return crypto.subtle.importKey('raw',encoder.encode(hex(new Uint8Array(digest))),{name:'HMAC',hash:'SHA-256'},false,['sign','verify']);}
export async function boundedJson(response,max=8192){
 if(!response.body)throw new Error('Companion returned no response.');const reader=response.body.getReader(),chunks=[];let length=0;
 try{for(;;){const{done,value}=await reader.read();if(done)break;if((length+=value.length)>max)throw new Error('Companion pairing response is too large.');chunks.push(value);}}finally{await reader.cancel().catch(()=>{});}
 if(!length)throw new Error(`Companion rejected the request (HTTP ${response.status}). Check its allowed browser origin.`);
 const bytes=new Uint8Array(length);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));
}
export async function connectCompanion({url,code,projectId,permissions,createHost,onStatus=()=>{},signal}){
 const base=companionUrl(url),origin=location.origin,grants=Object.freeze({...permissions});if(!validSecret(code))throw new Error('Enter the 64-character pairing code shown by the companion.');
 if(!grants.read)throw new Error('A companion session needs explicit read access.');
 const mac=await key(code),nonce=hex(crypto.getRandomValues(new Uint8Array(32))),proof=hex(new Uint8Array(await crypto.subtle.sign('HMAC',mac,encoder.encode(`scribyra-browser-pair-v1\n${origin}\n${projectId}\n${nonce}\n${flags(grants)}`))));
 let response;try{response=await fetch(`${base}/pair`,{method:'POST',credentials:'omit',referrerPolicy:'no-referrer',headers:{'Content-Type':'application/json'},body:JSON.stringify({nonce,proof,projectId,permissions:grants}),signal:AbortSignal.any([signal,AbortSignal.timeout(15000)].filter(Boolean))});}catch(error){if(signal?.aborted)throw new DOMException('Pairing cancelled','AbortError');throw new Error('Cannot reach the companion. Check that it is running and allows this editor’s address. If the browser blocks local connections, use the companion’s local workspace.',{cause:error});}
 const paired=await boundedJson(response);if(!response.ok)throw new Error(paired.message||'Companion pairing failed.');
 if(paired.version!==1||paired.projectId!==projectId||typeof paired.sessionId!=='string'||paired.sessionId.length>256||!validSecret(paired.browserToken)||!validSecret(paired.clientToken)||!validSecret(paired.serverProof)||paired.mcpUrl!==`${base}/mcp`||Object.keys(grants).some(field=>paired.permissions?.[field]!==grants[field]))throw new Error('Companion pairing scope or credentials are invalid.');
 const serverMessage=`scribyra-companion-pair-v1\n${origin}\n${projectId}\n${nonce}\n${paired.sessionId}\n${paired.browserToken}\n${paired.clientToken}\n${flags(grants)}\n${paired.mcpUrl}`;
 if(!await crypto.subtle.verify('HMAC',mac,unhex(paired.serverProof),encoder.encode(serverMessage)))throw new Error('The companion could not prove knowledge of the pairing code.');
 let host,closed=false,ready=false;const lifetime=new AbortController();const socket=new WebSocket(`${base.replace(/^http/,'ws')}/browser`);
 async function close(){
  if(closed)return;closed=true;lifetime.abort();host?.close();signal?.removeEventListener('abort',abort);window.removeEventListener('pagehide',abort);socket.close();
  try{await fetch(`${base}/revoke`,{method:'POST',credentials:'omit',referrerPolicy:'no-referrer',headers:{Authorization:`Bearer ${paired.browserToken}`},keepalive:true,signal:AbortSignal.timeout(5000)});}catch{}
  onStatus('Disconnected');
 }
 const abort=()=>{void close();};signal?.addEventListener('abort',abort,{once:true});window.addEventListener('pagehide',abort,{once:true});
 try{await new Promise((resolve,reject)=>{
  const timer=setTimeout(()=>{reject(new Error('Companion browser handshake timed out.'));void close();},10000),fail=error=>{clearTimeout(timer);reject(error);void close();};
  socket.onopen=()=>socket.send(JSON.stringify({version:1,token:paired.browserToken,...(paired.diagnosticsProtocol===1?{diagnosticsProtocol:1}:{})}));
  socket.onerror=()=>{if(!ready)fail(new Error('Cannot connect to the companion. Check its allowed browser origin and local-network permissions, or open its local workspace.'));};
  socket.onclose=()=>{lifetime.abort();host?.close();if(!ready)fail(new Error('Companion connection closed before authentication.'));else{closed=true;signal?.removeEventListener('abort',abort);window.removeEventListener('pagehide',abort);onStatus('Disconnected · pair again');}};
  socket.onmessage=async({data})=>{
   try{
    if(closed)return;if(typeof data!=='string'||data.length>8*1024*1024)throw new Error('Invalid companion frame.');
    if(!ready){const message=JSON.parse(data);if(message.type!=='ready'||message.version!==1||message.sessionId!==paired.sessionId||message.projectId!==projectId||!Number.isSafeInteger(message.nextSequence)||message.nextSequence<1||Object.keys(grants).some(field=>message.permissions?.[field]!==grants[field]))throw new Error('Companion handshake does not match the authorized project.');host=createHost({sessionId:paired.sessionId,permissions:grants,nextSequence:message.nextSequence});ready=true;clearTimeout(timer);onStatus(grants.write?'Connected · editing allowed':'Connected · read only');resolve();return;}
    const control=JSON.parse(data);if(control.type==='revoked'){await close();return;}
    const result=await host.handle(data);if(!closed&&socket.readyState===WebSocket.OPEN)socket.send(JSON.stringify(result));
   }catch(error){if(!ready)fail(error);else{onStatus(`Companion disconnected: ${error.message}`);void close();}}
  };
  if(signal?.aborted)fail(new DOMException('Connection cancelled','AbortError'));
 });}catch(error){await close();throw error;}
 return{url:base,close,signal:lifetime.signal,permissions:grants,diagnostics:paired.diagnosticsProtocol===1,async providerRequest(path,{method='GET',body,signal}={}){
  if(closed||!ready)throw new Error('Pair the companion before connecting local providers.');
  if(!/^\/providers(?:\/[a-zA-Z0-9_-]+(?:\/request|\/requests\/[a-zA-Z0-9_-]+)?)?$/.test(path))throw new Error('Invalid provider endpoint.');
  const response=await fetch(`${base}${path}`,{method,credentials:'omit',referrerPolicy:'no-referrer',headers:{Authorization:`Bearer ${paired.browserToken}`,'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.any([lifetime.signal,signal,AbortSignal.timeout(125000)].filter(Boolean))});
  const value=await boundedJson(response,8*1024*1024);if(!response.ok)throw Object.assign(new Error(value.message||'Local provider request failed.'),{code:value.code});return value;
 },get active(){return ready&&!closed;},settings:()=>({transport:'streamable-http',url:paired.mcpUrl,headers:{Authorization:`Bearer ${paired.clientToken}`},projectId,permissions:grants})};
}
