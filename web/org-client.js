// HTTP client for a Scribyra deployment's sign-in and end-to-end organisation routes.
// It carries only sign-in tokens, signed events, signed key wraps and encrypted log entries.
import {sign,signerPublic,sha256Hex} from './org-crypto.js';

const encoder=new TextEncoder();
export class ServiceError extends Error{
 constructor(status,message){super(message);this.name='ServiceError';this.status=status;}
}
const messages={
 400:'The service refused a malformed request.',401:'The service did not accept this browser’s sign-in.',403:'The service refused access.',
 404:'The service does not know this deployment, organisation or project.',409:'The service already has a different change at this position.',
 413:'This change is larger than the service allows.',429:'The service is busy. Retrying shortly.',503:'The service is unavailable. Retrying shortly.',
 507:'The service’s storage is full. Your changes stay saved on this device.',
};
async function failure(response){
 let detail='';try{const body=await response.json();if(typeof body?.error==='string'&&body.error.length<300)detail=body.error;}catch{}
 return new ServiceError(response.status,detail?`${messages[response.status]||'The service refused the request.'} (${detail})`:messages[response.status]||`The service answered ${response.status}.`);
}
export function orgClient(service,{fetchImpl=globalThis.fetch.bind(globalThis),timeoutMs=20000}={}){
 let token=null;
 async function request(path,{method="GET",body,type,auth=true,sso,timeout=timeoutMs,signal}={}){
  const headers={};if(type)headers['Content-Type']=type;
  if(sso)headers.Authorization='ScribyraSSO '+sso;else if(auth&&token)headers.Authorization='Scribyra '+token;
  let response;
  try{response=await fetchImpl(service+path,{method,headers,body,signal:signal?AbortSignal.any([signal,AbortSignal.timeout(timeout)]):AbortSignal.timeout(timeout),cache:'no-store',credentials:'omit'});}
  catch(error){throw new ServiceError(0,error?.name==='TimeoutError'?'The service did not answer in time.':'The service cannot be reached. Your changes stay saved on this device.');}
  if(!response.ok)throw await failure(response);
  return response;
 }
 const json=async(path,options)=>(await request(path,options)).json();
 return{
  service,
  get token(){return token;},
  forget(){token=null;},
  /** Opens a device session: the device identity (or a recovery seed) signs a challenge together
   * with the hash of `sso`, the login token of the person it belongs to. A key alone never signs in. */
  async signIn(org,signer,{sso}={}){
   if(typeof sso!=='string'||!sso)throw new ServiceError(401,'Sign in with your organisation first. (single sign-on is required)');
   const {challenge}=await json('/v1/auth/challenge',{method:'POST',type:'application/json',body:JSON.stringify({org}),auth:false});
   if(typeof challenge!=='string'||!/^[0-9a-f]{64}$/.test(challenge))throw new ServiceError(0,'The service sent an invalid sign-in challenge.');
   const key=signerPublic(signer),login=sha256Hex(encoder.encode(sso)),sig=await sign(signer,encoder.encode(`scribyra-auth/2\n${service}\n${org}\n${key}\n${login}\n${challenge}`));
   const session=await json('/v1/auth/session',{method:'POST',type:'application/json',body:JSON.stringify({org,key,challenge,sig,sso}),auth:false});
   if(typeof session?.token!=='string'||!/^[0-9a-f]{64}$/.test(session.token))throw new ServiceError(0,'The service sent an invalid session.');
   token=session.token;return session;
  },
  /** One page of membership events after `after`, and the log's length on the service. */
  async eventPage(org,after=0){
   const result=await json(`/v1/orgs/${org}/events?after=${after}`);
   if(!Array.isArray(result?.events)||!result.events.every(e=>typeof e==='string')||!Number.isSafeInteger(result.count)||result.count<after)throw new ServiceError(0,'The service sent an invalid membership log.');
   return result;
  },
  /** Every membership event after `after`, read page by page up to the service's length. */
  async events(org,after=0){
   const events=[];
   for(;;){
    const page=await this.eventPage(org,after+events.length);
    events.push(...page.events);
    if(after+events.length>=page.count)return events;
    if(!page.events.length)throw new ServiceError(0,'The service sent an incomplete membership log.');
   }
  },
  async postEvent(org,raw,{auth=true,sso}={}){return json(`/v1/orgs/${org}/events`,{method:'POST',type:'application/json',body:raw,auth,sso});},
  /** Unauthenticated: whether the org has a genesis, and its log head and length. */
  async info(org){const r=await json(`/v1/orgs/${org}/info`,{auth:false});if(typeof r?.head!=='string'||!Number.isSafeInteger(r.count))throw new ServiceError(0,'The service sent invalid organisation details.');return r;},
  /** Unauthenticated: the deployment's name, encryption mode, providers and organisation. */
  async deployment(){
   const d=await json('/v1/deployment',{auth:false});
   if(typeof d?.name!=='string'||!['server','e2ee'].includes(d.encryption)||!Array.isArray(d.providers)||!d.providers.length||!d.providers.every(p=>typeof p?.id==='string'&&typeof p.label==='string')||typeof d.org!=='string'||!/^[0-9a-f]{64}$/.test(d.org))
    throw new ServiceError(0,'This address does not answer like a Scribyra deployment.');
   return d;
  },
  async ssoStart(provider,returnTo,challenge){return json('/v1/sso/start',{method:'POST',type:'application/json',body:JSON.stringify({provider,return:returnTo,challenge}),auth:false});},
  async ssoRedeem(code,verifier){return json('/v1/sso/redeem',{method:'POST',type:'application/json',body:JSON.stringify({code,verifier}),auth:false});},
  async ssoMe(sso){return json('/v1/sso/me',{sso});},
  async ssoLogout(sso){await request('/v1/sso/logout',{method:'POST',type:'application/json',body:'{}',sso});},
  async reportWrap(org,project,epoch,sender){await request(`/v1/orgs/${org}/keys/report`,{method:'POST',type:'application/json',body:JSON.stringify({project,epoch,sender})});},
  async pending(org){return(await json(`/v1/orgs/${org}/pending`)).pending;},
  /** The email each person signed in with, as the service knows it: {person: {email}}. */
  async people(org){const r=await json(`/v1/orgs/${org}/people`);return r&&typeof r.people==='object'?r.people:{};},
  async heads(org,since,wait,signal){return json(`/v1/orgs/${org}/heads?${since===undefined?'':`since=${since}&`}wait=${wait}`,{timeout:(wait+15)*1000,signal});},
  async links(org){return(await json(`/v1/orgs/${org}/device-links`)).links;},
  async ssoDeviceRequest(org,body,sso){return json(`/v1/orgs/${org}/device-links/sso`,{method:'POST',type:'application/json',body:JSON.stringify(body),sso});},
  async putWraps(org,wraps){await request(`/v1/orgs/${org}/keys`,{method:'PUT',type:'application/json',body:JSON.stringify(wraps)});},
  async wraps(org){
   const result=await json(`/v1/orgs/${org}/keys`);
   if(!Array.isArray(result?.wraps)||!result.wraps.every(w=>typeof w==='string'))throw new ServiceError(0,'The service sent invalid key wraps.');
   return result.wraps;
  },
  /** Uploads one encrypted object part under its keyed ID (idempotent: same bytes, same ID). */
  async putObject(project,id,epoch,body){await request(`/v1/projects/${project}/objects/${id}?epoch=${epoch}`,{method:'PUT',type:'application/octet-stream',body,timeout:Math.max(timeoutMs,120000)});},
  /** Fetches one encrypted object part; null when the service has no object under that ID. */
  async getObject(project,id){
   try{return new Uint8Array(await (await request(`/v1/projects/${project}/objects/${id}`,{timeout:Math.max(timeoutMs,120000)})).arrayBuffer());}
   catch(error){if(error instanceof ServiceError&&error.status===404)return null;throw error;}
  },
  /** Appends one entry. Resolves to {seq, chain, repeated}. */
  async append(project,body){
   const response=await request(`/v1/projects/${project}/log`,{method:'POST',type:'application/octet-stream',body});
   const result=await response.json();
   if(!Number.isSafeInteger(result?.seq)||result.seq<1||typeof result.chain!=='string'||!/^[0-9a-f]{64}$/.test(result.chain))throw new ServiceError(0,'The service sent an invalid acknowledgement.');
   return{seq:result.seq,chain:result.chain,repeated:response.status===200};
  },
  /** Reads one page of entries after `after`: repeated `u64 seq ‖ 32-byte chain ‖ u32 length ‖ body`,
   * and the log head the service had when it answered. */
  async logPage(project,after=0,limit=256){
   const response=await request(`/v1/projects/${project}/log?after=${after}&limit=${limit}`),head=Number(response.headers.get('scribyra-log-head'));
   if(!Number.isSafeInteger(head)||head<0)throw new ServiceError(0,'The service did not say how long the log is.');
   const bytes=new Uint8Array(await response.arrayBuffer());
   const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength),entries=[];
   for(let at=0;at<bytes.length;){
    if(at+44>bytes.length)throw new ServiceError(0,'The service sent a truncated log.');
    const seq=Number(view.getBigUint64(at)),chain=[...bytes.subarray(at+8,at+40)].map(b=>b.toString(16).padStart(2,'0')).join(''),length=view.getUint32(at+40);
    if(at+44+length>bytes.length)throw new ServiceError(0,'The service sent a truncated log.');
    entries.push({seq,chain,body:bytes.slice(at+44,at+44+length)});at+=44+length;
   }
   return{entries,head};
  },
  /** Reads every entry after `after` up to the head, page by page. A page that stops short is
   * never mistaken for the end (entries can be large, so a page may hold only a few). */
  async *log(project,after=0){
   for(let seq=after;;){
    const {entries,head}=await this.logPage(project,seq);
    if(head<after)throw Object.assign(new ServiceError(0,'The service’s log is shorter than this browser verified.'),{rollback:true,head});
    if(!entries.length){if(seq>=head)return;throw new ServiceError(0,'The service sent an incomplete log.');}
    for(const entry of entries){if(entry.seq!==++seq)throw new ServiceError(0,'The service sent a log with a gap.');yield entry;}
    if(seq>=head)return;
   }
  },
 };
}
