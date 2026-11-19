// Server-readable organisation projects (design sections 1, 3, 4 and 9): the deployment's server
// is the authority for each project's log of Yjs updates, and this browser keeps a synced local
// copy that reconciles through the log exactly as two tabs do. Nothing here runs, opens a
// database or contacts anyone until the person signs in to such a deployment (off means off).
//
// Every update is written to the IndexedDB outbox with this copy's client ID and the next client
// sequence number before it is sent, so a retry after a lost answer resends identical bytes (the
// service answers `200` with the original sequence number). Catching up reads the log after the
// copy's cursor, validates the merged project like a replica from another tab, saves it through
// the merged-head save path and tells an open editor; the cursor and the server vector (the Yjs
// state the service holds) advance only after that save. Uploads are
// `Y.encodeStateAsUpdate(doc, serverVector)`, at most every two seconds while typing (at once in
// an online-only deployment). Assets and named-version objects are uploaded before the update
// that refers to them and fetched when a merged project needs them.
//
// Server compile (design section 6): where the deployment compiles on the server, a project whose
// compile mode is `server` asks the service to compile the version this browser has uploaded
// (the outbox drained first), follows the job through the heads poll and the status route, and
// keeps the latest PDF per project in IndexedDB, so it shows offline and reaches every member.
import * as Y from 'yjs';
import {openDB,deleteDB} from 'idb';
import * as storage from './storage.js';
import {watchStorage} from './storage-events.js';
import {SCHEMA_VERSION,validateProjectState,validateRetainedState,MAX_RETAINED_BYTES} from './model.js';
import {blobRefs,installBlob,knownBlob,verifyBlob} from './assets.js';
import {validateReplica} from './replication.js';
import {orgClient,ServiceError} from './org-client.js';
import {serviceOrigin,signInUrl,randomBytes,hex,sha256Hex} from './org-crypto.js';
import {mergeVectors,ROLE_MODES} from './org-backup.js';
import {blob_hash,history_validate_manifest} from './pkg/scribyra_app.js';

export const ORG_SERVER='scribyra:org-server';
/** Whether this browser signed in to a server-readable deployment (and did not forget it). */
export function orgServerConnected(){try{return globalThis.localStorage?.getItem(ORG_SERVER)==='true';}catch{return false;}}
const markConnected=on=>{try{if(on)localStorage.setItem(ORG_SERVER,'true');else localStorage.removeItem(ORG_SERVER);}catch{}};
const SSO_FLOW='scribyra:sr-sso-flow';
const memory=new Map();
const readSession=key=>{try{const store=globalThis.sessionStorage;return JSON.parse((store?store.getItem(key):memory.get(key))||'null');}catch{return null;}};
const writeSession=(key,value)=>{try{const store=globalThis.sessionStorage,text=value?JSON.stringify(value):null;if(store){if(text)store.setItem(key,text);else store.removeItem(key);}else if(text)memory.set(key,text);else memory.delete(key);}catch{}};
/** A sign-in to a server-readable deployment was started in this tab and its return is due. */
export function serverSignInPending(){const flow=readSession(SSO_FLOW);return !!flow&&Date.now()-flow.started<15*60*1000;}
/** Drops a server-readable sign-in this tab started (another sign-in, or a refused one, replaces it). */
export function forgetServerSignIn(){writeSession(SSO_FLOW,null);}

const DB='scribyra-org-server';
const database=()=>openDB(DB,2,{upgrade(db,old){
 if(old<1){
  db.createObjectStore('connection');
  db.createObjectStore('links',{keyPath:'localId'});
  db.createObjectStore('outbox',{keyPath:['localId','clientSeq']});
  // Objects this browser uploaded to or fetched from the service, per project.
  db.createObjectStore('objects',{keyPath:['project','hash']});
 }
 // The latest server-compiled PDF per project: {project, job, seq, compiled, requestedBy, bytes}.
 if(old<2)db.createObjectStore('pdfs',{keyPath:'project'});
}});

export const STATUS_TEXT={
 saved:'Saved on this device',syncing:'Syncing…',synced:'Synced',waiting:'Waiting to sync','read-only':'Read only',
 removed:'No longer shared with you',paused:'Sync paused',admin:'Opened as administrator · Read only',ended:'Access ended',
};
export const ADMIN_TEXT='You opened this project as an administrator: it is read-only here, and its members can see that you opened it.';
/** The same when the deployment's `notify_on_admin_access` is off: the open is only audited. */
export const ADMIN_QUIET_TEXT='You opened this project as an administrator: it is read-only here. Its members are not told; the audit log records it.';
export const MODE_TEXT=name=>`Stored on ${name}’s server, which can read it. ${name}’s administrators can open it.`;
export const pausedText=name=>`Reconnecting — editing is paused because ${name} keeps projects online only.`;
/** A local copy of a project in an organisation where the person no longer holds a role. */
export const endedText=name=>`Your access to ${name} ended. This copy stays on this device and no longer syncs.`;
/** Sign-in refusals (`#scribyra-sso-error=<code>`, or the redeem's `403 {code}`): `label` names the provider. */
export function refusalText(code,label='your sign-in provider'){
 return code==='no_role'?`Your account has no Scribyra role. Ask your administrator to grant one in ${label}.`:
  code==='guest'?'Guest accounts can’t use this organisation’s Scribyra.':
  code==='no_organisation'?`${label} did not say which organisation your account belongs to. Ask your administrator.`:
  code==='domain'?`Your ${label} organisation can’t use this deployment.`:
  code==='missing_claim'?`${label} did not send what this deployment needs to know about your account. Ask your administrator.`:
  code==='account_disabled'?'An administrator disabled your account here.':code==='account_removed'?'An administrator removed your account here.':'';
}
/** The provider label of the sign-in this tab started (server-readable or end-to-end), for refusal messages. */
export function pendingSignInLabel(){for(const key of [SSO_FLOW,'scribyra:sso-flow']){const flow=readSession(key);if(typeof flow?.label==='string')return flow.label;}return '';}
// One entry may carry at most this much; the service's default `sr_entry_bytes` is 16 MiB.
export const MAX_ENTRY_BYTES=15*1024*1024;
const RETRY=[2000,10000,30000,120000];
const THROTTLE_MS=2000;
// Online-only: editing needs a request to the service that succeeded this recently.
export const ONLINE_WINDOW_MS=30000;
const QUOTA_TEXT='The organisation’s storage on the server is full. Your changes are saved on this device and sync when space is freed.';
const isHash=value=>typeof value==='string'&&/^[0-9a-f]{64}$/.test(value);
const MONTHS=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
/** "18 Nov 14:02" in the browser's time zone. */
export const compiledTime=ms=>{const d=new Date(ms),two=n=>String(n).padStart(2,'0');return `${d.getDate()} ${MONTHS[d.getMonth()]} ${two(d.getHours())}:${two(d.getMinutes())}`;};
/** The badge on a server-compiled PDF (design section 6, step 5). */
export const compiledBadge=(compiled,latest)=>`Compiled on server · ${compiledTime(compiled)} · ${latest?'from your latest changes':'from an older version'}`;
/**
 * Where an organisation project compiles and what this person may do about it: the deployment's
 * `compile` (`browser`, `server`, `both`), the project's effective mode from the heads or its
 * details, the person's role on it and their deployment role. Null when nothing differs from
 * compiling in the browser (a `browser` deployment, or one that did not say).
 */
export function compileChoice({deployment,mode,role,accountRole}){
 if(deployment!=='server'&&deployment!=='both')return null;
 const effective=deployment==='server'?'server':mode==='server'?'server':'browser',owns=role==='owner'||role==='editor';
 return{mode:effective,canCompile:owns,canSwitch:deployment==='both'&&owns&&accountRole!=='guest'};
}
/** Whether a server PDF compiled at `seq` shows what this copy holds: nothing newer has come from
 * the server (`serverSeq`, the highest entry this copy holds) and nothing local waits to be sent. */
export const compiledLatest=({seq,serverSeq,unsent})=>Number.isSafeInteger(seq)&&seq>=serverSeq&&!unsent;
const COMPILE_ERRORS={409:'This project compiles in the browser now. Compile again.'};
const isId=isHash;
const fault=message=>Object.assign(Error(message),{fatal:true});
const writes=role=>role==='owner'||role==='editor';
/** The ID the service gives a project an account creates with request ID `request` (review L5):
 * SHA-256 of `scribyra-sr-project/1\n<account>\n<request>`, so a retry finds it. */
export const srProjectId=(account,request)=>sha256Hex(new TextEncoder().encode(`scribyra-sr-project/1\n${account}\n${request}`));

/**
 * Parses a log page: repeated `u64 seq ‖ u32 length ‖ update` (big-endian). Throws on a
 * truncated frame.
 */
export function parseFrames(bytes){
 const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength),frames=[];
 for(let at=0;at<bytes.length;){
  if(at+12>bytes.length)throw new ServiceError(0,'The server sent a truncated log.');
  const seq=Number(view.getBigUint64(at)),length=view.getUint32(at+8);
  if(at+12+length>bytes.length)throw new ServiceError(0,'The server sent a truncated log.');
  frames.push({seq,update:bytes.slice(at+12,at+12+length)});at+=12+length;
 }
 return frames;
}
const messages={
 400:'The server refused a malformed request.',401:'Your sign-in ended. Sign in again to keep syncing.',403:'The server refused this change for your role.',
 404:'This project is not shared with you (or no longer exists).',409:'The server already holds a different change at this position.',
 410:'The server compacted this project’s older changes.',413:'This change is larger than the server allows.',429:'The server is busy. Retrying shortly.',
 503:'The server is unavailable. Retrying shortly.',507:QUOTA_TEXT,
};
/**
 * HTTP client for one deployment's `/v1/sr/` and `/v1/admin/` routes, with the person's sign-in
 * token, acting in organisation `org` (the `Scribyra-Org` header; without it the service takes the
 * account's only organisation). A refusal carries the service's `code` (`unknown_org`, …).
 */
export function srClient(service,{token,org=null,fetchImpl=globalThis.fetch.bind(globalThis),timeoutMs=20000,onAnswer=()=>{}}={}){
 if(org!==null&&!isId(org))throw Error('Invalid organisation.');
 async function request(path,{method='GET',body,type,headers={},timeout=timeoutMs,signal,allow=[]}={}){
  const all={...headers,Authorization:'ScribyraSSO '+token()};if(type)all['Content-Type']=type;if(org)all['Scribyra-Org']=org;
  let response;
  try{response=await fetchImpl(service+path,{method,headers:all,body,signal:signal?AbortSignal.any([signal,AbortSignal.timeout(timeout)]):AbortSignal.timeout(timeout),cache:'no-store',credentials:'omit'});}
  catch(error){if(signal?.aborted)throw error;throw new ServiceError(0,error?.name==='TimeoutError'?'The server did not answer in time.':'The server cannot be reached. Your changes stay saved on this device.');}
  if(!response.ok&&!allow.includes(response.status)){
   let detail='',code='',candidates;try{const b=await response.json();if(typeof b?.error==='string'&&b.error.length<300)detail=b.error;if(typeof b?.code==='string'&&/^[a-z_]{1,40}$/.test(b.code))code=b.code;
    // Several accounts share an invited email: the inviter chooses one (`409 choose_account`).
    if(code==='choose_account'&&Array.isArray(b.candidates))candidates=b.candidates.filter(c=>isId(c?.account)).slice(0,50).map(c=>({account:c.account,name:typeof c.name==='string'?c.name:null,email:typeof c.email==='string'?c.email:null,provider:c.provider,role:c.role}));}catch{}
   if(code==='choose_account')throw Object.assign(new ServiceError(409,'Several accounts have this email. Choose the one to invite.'),{detail,code,candidates:candidates||[]});
   onAnswer(response.status,code);
   if(code==='unknown_org')throw Object.assign(new ServiceError(404,'Your access to this organisation ended.'),{detail,code});
   throw Object.assign(new ServiceError(response.status,detail?`${messages[response.status]||'The server refused the request.'} (${detail})`:messages[response.status]||`The server answered ${response.status}.`),{detail,code});
  }
  onAnswer(response.status,'');
  return response;
 }
 const json=async(path,options)=>(await request(path,options)).json();
 const send=(method,path,value)=>json(path,{method,type:'application/json',body:JSON.stringify(value)});
 const p=project=>{if(!isId(project))throw Error('Invalid project ID.');return `/v1/sr/projects/${project}`;};
 return{
  list:()=>json('/v1/sr/projects'),
  create:(id,name)=>send('POST','/v1/sr/projects',{id,name}),
  details:project=>json(p(project)),
  rename:(project,name)=>send('PATCH',p(project),{name}),
  invite:(project,email,role,{guest=false,account=null}={})=>send('POST',p(project)+'/invitations',{email,role,...guest?{guest:true}:{},...account?{account}:{}}),
  async withdraw(project,id){await request(`${p(project)}/invitations/${id}`,{method:'DELETE'});},
  setRole:(project,account,role)=>send('PUT',`${p(project)}/members/${account}`,{role}),
  async removeMember(project,account){await request(`${p(project)}/members/${account}`,{method:'DELETE'});},
  /** The organisation's members and administrators, to share with (guests are refused). */
  directory:()=>json('/v1/sr/directory'),
  heads:(since,wait,signal)=>json(`/v1/sr/heads?wait=${wait}${since?`&since=${since}`:''}`,{timeout:(wait+15)*1000,signal}),
  /** Appends one update under (client, clientSeq). Resolves to {seq, repeated}. */
  async append(project,client,clientSeq,body){
   const response=await request(p(project)+'/log',{method:'POST',type:'application/octet-stream',body,headers:{'Scribyra-Client':client,'Scribyra-Client-Seq':String(clientSeq)}});
   const result=await response.json();
   if(!Number.isSafeInteger(result?.seq)||result.seq<1)throw new ServiceError(0,'The server sent an invalid acknowledgement.');
   return{seq:result.seq,repeated:response.status===200};
  },
  /** One page of the log after `after`: {frames, head}, or {compacted:{floor, snapshot}} (410). */
  async logPage(project,after){
   const response=await request(`${p(project)}/log?after=${after}&limit=256`,{allow:[410]}),head=Number(response.headers.get('scribyra-log-head'));
   if(response.status===410){const b=await response.json().catch(()=>({}));if(!Number.isSafeInteger(b.snapshot)||b.snapshot<1)throw new ServiceError(0,'The server compacted this project but has no snapshot.');return{compacted:{floor:b.floor,snapshot:b.snapshot},head};}
   if(!Number.isSafeInteger(head)||head<0)throw new ServiceError(0,'The server did not say how long the log is.');
   return{frames:parseFrames(new Uint8Array(await response.arrayBuffer())),head};
  },
  async snapshot(project){
   const response=await request(p(project)+'/snapshot',{timeout:Math.max(timeoutMs,120000)}),seq=Number(response.headers.get('scribyra-snapshot-seq'));
   if(!Number.isSafeInteger(seq)||seq<1)throw new ServiceError(0,'The server sent a snapshot without its position.');
   return{seq,update:new Uint8Array(await response.arrayBuffer())};
  },
  async putObject(project,hash,bytes){await request(`${p(project)}/objects/${hash}`,{method:'PUT',type:'application/octet-stream',body:bytes,timeout:Math.max(timeoutMs,120000)});},
  /** An object's bytes, or null when the server does not hold it. */
  async getObject(project,hash){
   const response=await request(`${p(project)}/objects/${hash}`,{allow:[404],timeout:Math.max(timeoutMs,120000)});
   return response.status===404?null:new Uint8Array(await response.arrayBuffer());
  },
  /** Server compile (design section 6): request at `seq`, status, the PDF and the log. */
  async compile(project,seq){
   try{return await send('POST',p(project)+'/compile',{seq});}
   catch(error){if(error instanceof ServiceError&&COMPILE_ERRORS[error.status])throw Object.assign(new ServiceError(error.status,COMPILE_ERRORS[error.status]),{detail:error.detail});throw error;}
  },
  compileStatus:project=>json(p(project)+'/compile'),
  /** The latest PDF, or `job`'s: {job, seq, bytes}; null when the server keeps none. */
  async compilePdf(project,job){
   if(job!==undefined&&!isId(job))throw Error('Invalid compile job.');
   const response=await request(`${p(project)}/compile/pdf${job?`?job=${job}`:''}`,{allow:[404],timeout:Math.max(timeoutMs,120000)});
   if(response.status===404)return null;
   const seq=Number(response.headers.get('scribyra-compile-seq')),id=response.headers.get('scribyra-compile-job');
   if(!Number.isSafeInteger(seq)||!isId(id))throw new ServiceError(0,'The server sent a PDF without its compile.');
   return{job:id,seq,bytes:new Uint8Array(await response.arrayBuffer())};
  },
  /** A compile's log as text, or '' when none is kept. */
  async compileLog(project,job){
   if(!isId(job))throw Error('Invalid compile job.');
   const response=await request(`${p(project)}/compile/log?job=${job}`,{allow:[404]});
   return response.status===404?'':response.text();
  },
  setCompile:(project,compile)=>send('PUT',p(project)+'/settings',{compile}),
  /** The admin area's routes (administrators only; design section 5). */
  admin:(()=>{
   const id=value=>{if(!isId(value))throw Error('Invalid ID.');return value;};
   const a=path=>'/v1/admin'+path;
   return{
    members:(removed=false)=>json(a('/members'+(removed?'?removed=true':''))),
    disable:account=>send('POST',a(`/members/${id(account)}/disable`),{}),
    unblock:account=>send('POST',a(`/members/${id(account)}/unblock`),{}),
    remove:(account,transfer)=>send('POST',a(`/members/${id(account)}/remove`),transfer?{transfer:id(transfer)}:{}),
    projects:()=>json(a('/projects')),
    open:project=>send('POST',a(`/projects/${id(project)}/open`),{}),
    edit:project=>send('POST',a(`/projects/${id(project)}/edit`),{}),
    transfer:(project,account)=>send('POST',a(`/projects/${id(project)}/owner`),{account:id(account)}),
    async deleteProject(project){await request(a(`/projects/${id(project)}`),{method:'DELETE'});},
    audit:(query={})=>json(a('/audit?'+new URLSearchParams(Object.entries(query).filter(([,v])=>v!==undefined&&v!==null&&v!=='')))),
    settings:()=>json(a('/settings')),
    /** A download (export everything, or the audit log): its bytes, file name and audit head. */
    async download(path,query={}){
     const response=await request(a(path)+'?'+new URLSearchParams(Object.entries(query).filter(([,v])=>v!==undefined&&v!==null&&v!=='')),{timeout:Math.max(timeoutMs,600000)});
     return{blob:await response.blob(),name:/filename="([^"]+)"/.exec(response.headers.get('content-disposition')||'')?.[1]||'scribyra-export',head:response.headers.get('scribyra-audit-head')};
    },
   };
  })(),
 };
}

/**
 * The engine. The account may hold roles in several organisations of the deployment (design
 * section 3): the person works in one at a time (`active`, the dialog's switcher), every request
 * names its organisation (`Scribyra-Org`), each local copy remembers the organisation it belongs to
 * and syncs under it whichever is active, and the heads are followed in the active organisation
 * and in each one this browser holds copies of. When the provider takes a role away the service
 * answers `404 unknown_org` for that organisation: its copies stay on this device, stop syncing
 * and say so (`onEnded`), until a sign-in names the organisation again.
 */
export function orgServer({onChange=()=>{},onRemote=()=>{},onAccount=()=>{},onCompile=()=>{},onEnded=()=>{},beforeErase=async()=>{},fetchImpl,locks=globalThis.navigator?.locks,appOrigin=globalThis.location?.origin,now=()=>Date.now()}={}){
 let db,connection=null,closed=false,unwatch=null,hooks=null,ticker=0,lastOk=0,reachable=true,remote=null;
 const statuses=new Map(),timers=new Map(),attempts=new Map(),queues=new Map(),stalled=new Set(),compileWaiters=new Map();
 // One client per organisation; the organisation of each local copy (by local ID) and of each
 // project this browser knows (copies and the heads), so that every request names the right one.
 const clients=new Map(),copyOrg=new Map(),projectOrg=new Map(),polls=new Map(),versions=new Map();
 const setStatus=(localId,state,message='')=>{const old=statuses.get(localId);statuses.set(localId,{state,message,label:STATUS_TEXT[state]});if(old?.state!==state||old?.message!==message)onChange(localId);};
 async function open(){db??=await database();return db;}
 const signedIn=()=>!!connection?.token&&connection.expires*1000>now();
 const onlineOnly=()=>connection?.offline===false;
 async function save(){await (await open()).put('connection',connection,'current');}
 /** The organisations the account may act in now ({id, name, provider, role, guest}). */
 const orgs=()=>connection?.orgs||[];
 const holds=org=>orgs().some(o=>o.id===org);
 // The chosen organisation; else the primary one (holding the deployment's ID) when the account is in it; else the oldest.
 const activeOrg=()=>holds(connection?.active)?connection.active:(orgs().find(o=>o.primary)||orgs()[0])?.id||null;
 const orgNamed=org=>orgs().find(o=>o.id===org)?.name||connection?.ended?.[org]?.name||connection?.name||'your organisation';
 const roleIn=org=>orgs().find(o=>o.id===org)?.role||null;
 function clientFor(org){
  const key=org||'';let made=clients.get(key);
  if(!made)clients.set(key,made=srClient(connection.service,{fetchImpl,org:org||null,token:()=>connection.token,onAnswer:(status,code)=>answered(status,code,org)}));
  return made;
 }
 /** The client for a project: its copy's organisation, else the one the heads named, else the active one. */
 const on=project=>clientFor(projectOrg.get(project)||activeOrg());
 const linkOrg=link=>link.org||null;
 function noteLink(link){if(link.org){copyOrg.set(link.localId,link.org);projectOrg.set(link.project,link.org);}return link;}
 async function load(){
  await open();
  if(!connection){
   connection=await db.get('connection','current')||null;
   // Copies made before organisations were named belong to the account's first one.
   if(connection)for(const link of await db.getAll('links')){if(!link.org&&orgs()[0]){link.org=orgs()[0].id;await db.put('links',link);}noteLink(link);}
  }
  if(!connection)throw Error('This browser is not signed in to a deployment.');
  return connection;
 }
 // Every answer but a server error counts as a round trip; a refused session ends the sign-in; an
 // organisation the account no longer holds a role in ends that organisation's sync.
 let wasPaused=null;
 function answered(status,code,org){
  if(status===401){if(connection?.token){connection.token=null;void save().then(sessionEnded);}return;}
  if(code==='unknown_org'&&org)void orgEnded(org).catch(()=>{});
  if(status>=500)return;
  lastOk=now();reachable=true;checkPause();
 }
 /**
  * The provider took the account's role in `org` away (or an administrator stopped it there): the
  * organisation leaves the account's list, its heads are no longer followed, and its copies stay
  * on this device, unsynced, with the reason. A later sign-in that names it again resumes them.
  */
 async function orgEnded(org){
  if(!connection||!holds(org))return;
  const name=orgNamed(org);
  connection.orgs=orgs().filter(o=>o.id!==org);connection.ended={...connection.ended,[org]:{name,at:now()}};
  if(connection.active===org)connection.active=activeOrg();
  connection.role=roleIn(activeOrg());
  await save();
  const poll=polls.get(org);polls.delete(org);poll?.controller?.abort();poll?.wake?.();
  if(remote)remote=Object.fromEntries(Object.entries(remote).filter(([,r])=>r.org!==org));
  for(const [localId,o] of copyOrg)if(o===org){clearTimeout(timers.get(localId)?.timer);timers.delete(localId);attempts.delete(localId);stalled.delete(localId);setStatus(localId,'ended',endedText(name));}
  // Online-only: projects never stay on a device without access (as at sign-out).
  if(onlineOnly())await eraseLocal(org).catch(()=>{});
  checkPause();onEnded({org,name});onAccount();
 }
 /** Takes the account's organisations from a login (`/v1/sso/redeem` or `/v1/sso/me`); those it names again resume. */
 async function takeOrgs(login){
  const list=(Array.isArray(login?.orgs)?login.orgs:[]).filter(o=>isId(o?.id)).map(o=>({id:o.id,name:String(o.name||connection.name),provider:o.provider,role:o.role,guest:!!o.guest,primary:o.primary===true}));
  for(const o of orgs())if(!list.some(l=>l.id===o.id))await orgEnded(o.id);
  const back=list.filter(o=>connection.ended?.[o.id]).map(o=>o.id);
  connection.orgs=list;
  if(back.length){connection.ended={...connection.ended};for(const id of back)delete connection.ended[id];}
  connection.active=activeOrg();connection.role=roleIn(connection.active);
  await save();
  for(const [localId,o] of copyOrg)if(back.includes(o))schedule(localId,100);
 }
 /** Reads the account's organisations again (at start, so roles changed meanwhile apply). */
 async function refreshOrgs(){
  if(!signedIn())return;
  const login=await orgClient(connection.service,{fetchImpl}).ssoMe(connection.token).catch(error=>{if(error instanceof ServiceError&&error.status===401)answered(401);return null;});
  if(login)await takeOrgs(login);
 }
 /** In an online-only deployment, editing pauses unless the service answered recently. */
 function paused(){return onlineOnly()&&(!signedIn()||!reachable||now()-lastOk>ONLINE_WINDOW_MS||stalled.size>0);}
 function checkPause(){const p=paused();if(p!==wasPaused){wasPaused=p;void db?.getAll('links').then(links=>{for(const l of links)onChange(l.localId);}).catch(()=>{});}}
 async function sessionEnded(){
  stopFollowing();onAccount();
  if(onlineOnly())await eraseLocal().catch(()=>{});
  else for(const link of await db.getAll('links'))setStatus(link.localId,'saved',`Sign in with ${connection.label||'your organisation'} again to keep syncing.`);
 }
 const withLock=(name,task)=>locks?locks.request(name,task):task();
 function queue(localId,task){
  const next=(queues.get(localId)||Promise.resolve()).then(()=>withLock(`scribyra:org-server:${localId}`,task));
  queues.set(localId,next.catch(()=>{}));return next;
 }
 /** Throttled: a pending sync is not pushed back by further saves; a shorter delay brings it forward. */
 function schedule(localId,delay=THROTTLE_MS){
  if(closed)return;const pending=timers.get(localId);
  if(pending&&pending.at<=now()+delay)return;
  clearTimeout(pending?.timer);
  timers.set(localId,{at:now()+delay,timer:setTimeout(()=>{timers.delete(localId);void sync(localId).catch(()=>{});},delay)});
 }
 function retry(localId,error){
  const n=attempts.get(localId)||0;attempts.set(localId,n+1);
  setStatus(localId,'waiting',error instanceof ServiceError&&error.status===507?QUOTA_TEXT:error.message);schedule(localId,RETRY[Math.min(n,RETRY.length-1)]);
 }

 // --- Objects (assets and named-version objects), plaintext, content-addressed by SHA-256

 const confirmed=async(project,hash)=>!!(await db.get('objects',[project,hash]));
 async function noteObject(project,hash){await db.put('objects',{project,hash});}
 /** What must be on the server before this update: current assets, and every named version's
  * manifest, update chunks and assets. A current asset this browser lacks stops the upload. */
 async function wantedObjects(project,doc,read){
  const wanted=[],assets=new Map(read.blobs.map(b=>[b.ref.hash,b.bytes]));
  for(const ref of blobRefs(doc)){
   if(await confirmed(project,ref.hash))continue;
   const bytes=assets.get(ref.hash)||knownBlob(doc,ref.hash);
   if(!bytes)throw fault('This project refers to a file that is missing on this device, so its changes are not sent. Open it on the device that has the file.');
   wanted.push({hash:ref.hash,bytes});
  }
  const versions=[...doc.getMap('versions').values()].map(v=>v?.checkpointRef).filter(isHash);
  if(!versions.length)return wanted;
  const manifests=await storage.readStoredBytes({objects:versions}),chunks=new Set(),extra=new Set();
  for(const [hash,bytes] of manifests.objects){
   let manifest;try{manifest=JSON.parse(new TextDecoder().decode(bytes));}catch{continue;}
   if(!(await confirmed(project,hash)))wanted.push({hash,bytes});
   for(const chunk of manifest.updateChunks||[])if(isHash(chunk?.hash)&&!(await confirmed(project,chunk.hash)))chunks.add(chunk.hash);
   for(const asset of manifest.assets||[])if(isHash(asset?.hash)&&!assets.has(asset.hash)&&!(await confirmed(project,asset.hash)))extra.add(asset.hash);
  }
  const stored=await storage.readStoredBytes({objects:[...chunks],blobs:[...extra]});
  for(const [hash,bytes] of [...stored.objects,...stored.blobs])wanted.push({hash,bytes});
  return wanted.filter(o=>blob_hash(o.bytes)===o.hash);
 }
 async function uploadObjects(project,wanted){for(const o of wanted){await on(project).putObject(project,o.hash,o.bytes);await noteObject(project,o.hash);}}
 async function fetchObject(project,hash,size=null){
  const bytes=await on(project).getObject(project,hash);
  if(!bytes)throw Error('A file another member’s change refers to is not on the server yet. Sync waits for it and tries again.');
  if(blob_hash(bytes)!==hash||(size!==null&&bytes.length!==size))throw Error('A file from the server does not match what the project refers to. It was refused.');
  await noteObject(project,hash);return bytes;
 }
 /** Installs into `doc` every asset it refers to that this browser does not store yet. */
 async function fetchAssets(project,doc){
  const refs=blobRefs(doc).filter(ref=>!knownBlob(doc,ref.hash));
  if(!refs.length)return;
  const present=await storage.readStoredBytes({blobs:refs.map(r=>r.hash)});
  for(const ref of refs){const bytes=present.blobs.get(ref.hash)||await fetchObject(project,ref.hash,ref.size);verifyBlob(ref,bytes);installBlob(doc,ref,bytes);}
 }
 /** Named versions from others: their checkpoint objects, installed through the history store. */
 async function hydrateHistory(localId,project){
  const read=await storage.readCommittedProject(localId);if(read.kind!=='updated')return 0;
  const doc=new Y.Doc();let missing=0;
  try{
   Y.applyUpdate(doc,read.update);
   const versions=[...doc.getMap('versions').values()].filter(v=>isHash(v?.checkpointRef));
   if(!versions.length)return 0;
   const stored=await storage.readStoredBytes({objects:versions.map(v=>v.checkpointRef)});
   for(const version of versions){
    if(stored.objects.has(version.checkpointRef))continue;
    try{
     const bytes=await fetchObject(project,version.checkpointRef),text=new TextDecoder('utf-8',{fatal:true}).decode(bytes);
     history_validate_manifest(text);
     const manifest=JSON.parse(text),objects=[{hash:version.checkpointRef,bytes}],blobs=[];
     const have=await storage.readStoredBytes({objects:manifest.updateChunks.map(c=>c.hash),blobs:manifest.assets.map(a=>a.hash)});
     for(const chunk of manifest.updateChunks)objects.push({hash:chunk.hash,bytes:have.objects.get(chunk.hash)||await fetchObject(project,chunk.hash,chunk.size)});
     for(const asset of manifest.assets)blobs.push({hash:asset.hash,bytes:have.blobs.get(asset.hash)||await fetchObject(project,asset.hash,asset.size)});
     const now=await storage.readCommittedProject(localId);
     await storage.installRemoteHistory(localId,{objects,blobs,pins:objects.map(o=>({hash:o.hash,pin:'checkpoint:'+manifest.checkpointId})),
      catalog:[{checkpointId:manifest.checkpointId,checkpointRef:version.checkpointRef,sequence:now.head?.sequence??0,reason:'named'}]});
    }catch{missing++;}
   }
  }finally{doc.destroy();}
  return missing;
 }

 // --- The log

 /**
  * Reads every entry after `after` (from the snapshot when the log below it was compacted).
  * Calls `each(update, seq)` in order and returns the new cursor.
  */
 async function readLog(project,after,each){
  for(let seq=after;;){
   const page=await on(project).logPage(project,seq);
   if(page.compacted){const snapshot=await on(project).snapshot(project);await each(snapshot.update,snapshot.seq,true);seq=snapshot.seq;continue;}
   if(page.head<seq)throw fault('The server’s log is shorter than this browser read. Sync paused.');
   if(!page.frames.length){if(seq>=page.head)return seq;throw new ServiceError(0,'The server sent an incomplete log.');}
   for(const frame of page.frames){if(frame.seq!==++seq)throw new ServiceError(0,'The server sent a log with a gap.');await each(frame.update,frame.seq,false);}
   if(seq>=page.head)return seq;
  }
 }
 /**
  * Catch-up: entries after the cursor (other than this copy's own) are merged into the committed
  * local project through the merged-head save path, after the same validation as a replica from
  * another tab, and an open editor is told. Cursor and server vector move after the save.
  */
 async function pull(link){
  const mine=new Set(link.mine||[]),updates=[];let vector=link.vector,received=0;
  const seq=await readLog(link.project,link.seq,(update,at,snapshot)=>{
   if(!snapshot&&mine.has(at))return;
   if((received+=update.byteLength)>MAX_RETAINED_BYTES)throw fault('Changes from others exceed the 96 MiB limit. Sync paused.');
   updates.push(update);vector=mergeVectors(vector,Y.encodeStateVectorFromUpdate(update));
  });
  let pushedSequence=link.pushedSequence;
  if(updates.length){
   const read=await storage.readCommittedProject(link.localId);
   if(read.kind==='deleted'||read.kind==='missing')throw fault('This project is no longer on this device. Its copy on the server is kept.');
   const doc=new Y.Doc();
   try{
    Y.applyUpdate(doc,read.update);for(const b of read.blobs)installBlob(doc,b.ref,b.bytes);
    if(doc.getMap('meta').get('lineageId')!==link.lineage)throw fault('This project’s identity changed on this device. Sync paused.');
    for(const update of updates)Y.applyUpdate(doc,update);
    if(doc.store.pendingStructs||doc.store.pendingDs)throw fault('A change from the server is incomplete. Sync paused.');
    await fetchAssets(link.project,doc);
    validateRetainedState(doc);validateReplica(doc);
    const saved=await storage.saveProject(link.localId,doc);
    // Nothing local was waiting before the merge: the merged state is all on the server.
    if(read.head.sequence===link.pushedSequence)pushedSequence=saved.sequence;
   }finally{doc.destroy();}
  }
  const current={...await db.get('links',link.localId),seq,vector,pushedSequence,mine:[...mine].filter(s=>s>seq)};
  await db.put('links',current);
  if(updates.length)onRemote(link.localId);
  return current;
 }
 /** Sends one outbox entry; the acknowledgement removes it and grows the server vector in one transaction. */
 async function deliver(link,entry){
  let ack;
  try{ack=await on(link.project).append(link.project,link.client,entry.clientSeq,entry.body);}
  catch(error){
   if(error instanceof ServiceError&&error.status===409)throw fault('The server holds a different change at this position. Sync paused for this project.');
   if(error instanceof ServiceError&&error.status===403)throw Object.assign(fault('Your role on this project does not let you change it. Your changes stay on this device.'),{readOnly:true});
   if(error instanceof ServiceError&&error.status===404&&error.code!=='unknown_org')throw Object.assign(fault('This project is no longer shared with you. It stays on this device.'),{removed:true});
   throw error;
  }
  const tx=db.transaction(['links','outbox'],'readwrite'),stored=await tx.objectStore('links').get(link.localId);
  const current={...stored,vector:mergeVectors(stored.vector,entry.vector),pushedSequence:Math.max(stored.pushedSequence,entry.sequence),mine:ack.seq>stored.seq?[...(stored.mine||[]),ack.seq]:stored.mine||[]};
  await tx.objectStore('links').put(current);await tx.objectStore('outbox').delete([link.localId,entry.clientSeq]);await tx.done;
  return current;
 }
 async function syncNow(localId){
  await load();let link=await db.get('links',localId);if(!link)return;
  if(!signedIn()){setStatus(localId,'saved',`Sign in with ${connection.label||'your organisation'} to keep syncing.`);return;}
  if(link.org&&!holds(link.org)){setStatus(localId,'ended',endedText(orgNamed(link.org)));return;}
  setStatus(localId,'syncing');
  if(!link.created){
   // A copy added before the service derived IDs: its request ID is the one it stored.
   if(!link.request){link={...link,request:link.project,project:srProjectId(connection.account,link.project)};await db.put('links',link);}
   const created=await clientFor(linkOrg(link)).create(link.request,link.name.slice(0,200));
   if(created?.project?.id!==link.project)throw fault('The server gave this project another ID than expected. Sync paused.');
   await db.put('links',link={...link,created:true});
  }
  link=await pull(link);
  const role=remote?.[link.project]?.role||link.role;
  if(!writes(role)){attempts.delete(localId);stalled.delete(localId);setStatus(localId,role==='admin'?'admin':'read-only',role==='admin'?adminText():`Your role on this project is ${role}: what you change stays on this device.`);await hydrateHistory(localId,link.project).catch(()=>{});return;}
  for(const entry of (await db.getAll('outbox',IDBKeyRange.bound([localId,0],[localId,Infinity]))))link=await deliver(link,entry);
  const read=await storage.readCommittedProject(localId);
  if(read.kind==='deleted'||read.kind==='missing'){setStatus(localId,'paused','This project is no longer on this device. Its copy on the server is kept.');return;}
  if(read.head.sequence!==link.pushedSequence){
   const doc=new Y.Doc();
   try{
    Y.applyUpdate(doc,read.update);for(const b of read.blobs)installBlob(doc,b.ref,b.bytes);
    if(doc.getMap('meta').get('lineageId')!==link.lineage){setStatus(localId,'paused','This project’s identity changed on this device. Add it again as a new project.');return;}
    const body=Y.encodeStateAsUpdate(doc,link.vector);
    if(body.byteLength>MAX_ENTRY_BYTES){setStatus(localId,'paused','This change is too large to sync in one piece.');return;}
    // Files first: everything the update refers to is on the server before the update.
    await uploadObjects(link.project,await wantedObjects(link.project,doc,read));
    // The entry and its number are durable before it is sent: a retry resends identical bytes.
    const entry={localId,clientSeq:link.clientSeq+1,body,vector:Y.encodeStateVector(doc),sequence:read.head.sequence};
    const tx=db.transaction(['links','outbox'],'readwrite');
    await tx.objectStore('outbox').put(entry);await tx.objectStore('links').put(link={...link,clientSeq:entry.clientSeq});await tx.done;
    link=await deliver(link,entry);
   }finally{doc.destroy();}
  }
  await hydrateHistory(localId,link.project).catch(()=>{});
  attempts.delete(localId);stalled.delete(localId);checkPause();
  setStatus(localId,'synced');
 }
 function sync(localId){
  return queue(localId,async()=>{
   try{await syncNow(localId);}
   catch(error){
    if(error instanceof ServiceError&&error.status===401)return;
    if(error?.code==='unknown_org'){const org=copyOrg.get(localId);if(org){await orgEnded(org);setStatus(localId,'ended',endedText(orgNamed(org)));}return;}
    if(error.removed){setStatus(localId,'removed',error.message);return;}
    if(error.readOnly){setStatus(localId,'read-only',error.message);return;}
    if(onlineOnly()&&!error.fatal){stalled.add(localId);checkPause();}
    if(error.fatal)setStatus(localId,'paused',error.message);else retry(localId,error);
    throw error;
   }
  });
 }
 /** A new local project from the server's snapshot and log. Nothing is saved unless it all validates. */
 async function download(project){
  const doc=new Y.Doc(),entry=remote?.[project],org=projectOrg.get(project)||activeOrg();
  try{
   const seq=await readLog(project,0,update=>{Y.applyUpdate(doc,update);});
   if(!seq)return null;
   if(doc.store.pendingStructs||doc.store.pendingDs)throw Error('This project’s copy on the server is incomplete. Nothing was downloaded.');
   const lineage=doc.getMap('meta').get('lineageId');
   if(typeof lineage!=='string'||doc.getMap('meta').get('schemaVersion')!==SCHEMA_VERSION)throw Error('This project needs another version of Scribyra.');
   validateProjectState(doc);
   await fetchAssets(project,doc);
   validateRetainedState(doc);validateReplica(doc);
   const localId=crypto.randomUUID(),saved=await storage.saveProject(localId,doc);
   const link={localId,project,org,name:doc.getMap('meta').get('name')||entry?.name||'Untitled project',role:entry?.role||'viewer',compile:entry?.compile?.mode,lineage,created:true,seq,vector:Y.encodeStateVector(doc),pushedSequence:saved.sequence,client:newClient(),clientSeq:0,mine:[]};
   await db.put('links',noteLink(link));
   await hydrateHistory(localId,project).catch(()=>{});
   setStatus(localId,writes(link.role)?'synced':link.role==='admin'?'admin':'read-only',link.role==='admin'?adminText():'');
   return{localId,name:link.name};
  }finally{doc.destroy();}
 }
 const adminText=()=>connection?.notifyAdmin===false?ADMIN_QUIET_TEXT:ADMIN_TEXT;
 // A client ID per local copy (`<browser>-<copy>`), so a copy downloaded again never reuses numbers.
 const newClient=()=>`${connection.client}-${hex(randomBytes(8))}`;

 // --- Following the server

 function stopFollowing(){for(const poll of polls.values()){poll.controller?.abort();poll.wake?.();}polls.clear();}
 /** The organisations whose heads are followed: the active one and each one this browser holds copies of. */
 function followed(){const out=new Set(),active=activeOrg();if(active)out.add(active);for(const org of copyOrg.values())if(holds(org))out.add(org);return out;}
 /** Follows the heads of every organisation in `followed()` (one long poll each) and no other. */
 function follow(){
  if(closed||!signedIn())return;
  const wanted=followed();
  for(const [org,poll] of polls)if(!wanted.has(org)){polls.delete(org);poll.controller?.abort();poll.wake?.();}
  // An account in one organisation may name none (the service takes its only one).
  if(!wanted.size&&!orgs().length)wanted.add(null);
  for(const org of wanted)if(!polls.has(org))followOrg(org);
 }
 /**
  * A long poll on one organisation's heads: a project whose head passed this copy's cursor is
  * synced; one that disappeared is no longer shared; any change redraws the dialog. A missed
  * notice is repaired by the next poll and by every sync's catch-up. `404 unknown_org` ends the
  * organisation's sync (`orgEnded`).
  */
 function followOrg(org){
  const poll={controller:null,wake:null,kick:false},current=()=>!closed&&signedIn()&&polls.get(org)===poll;
  polls.set(org,poll);
  void (async()=>{
   let since,failures=0;
   while(current()){
    try{
     poll.controller=new AbortController();
     const heads=await clientFor(org).heads(since,since===undefined?0:onlineOnly()?20:25,poll.controller.signal);
     if(!current())break;
     failures=0;poll.kick=false;const moved=heads.version!==since,before=remote||{};since=heads.version;
     const mine=Object.entries(heads.projects||{}).map(([id,r])=>[id,{...r,org}]);
     for(const [id] of mine)if(org)projectOrg.set(id,org);
     remote=Object.fromEntries([...Object.entries(remote||{}).filter(([,r])=>r.org!==org),...mine]);
     for(const link of await db.getAll('links')){
      if(org&&linkOrg(link)!==org)continue;
      const r=remote[link.project];
      if(!r){if(link.created&&statuses.get(link.localId)?.state!=='removed')setStatus(link.localId,'removed','This project is no longer shared with you. It stays on this device.');continue;}
      if(r.role!==link.role||r.name!==link.name||(r.compile&&r.compile.mode!==link.compile)){await db.put('links',{...link,role:r.role,name:r.name,compile:r.compile?.mode||link.compile});onChange(link.localId);}
      // A compile was queued, started or finished, or the project's compile mode changed.
      const was=before[link.project]?.compile,now=r.compile;
      if(now&&(now.mode!==was?.mode||now.job!==was?.job||now.state!==was?.state)){for(const wake of compileWaiters.get(link.project)||[])wake();onCompile(link.localId,now);}
      if(r.head>link.seq||statuses.get(link.localId)?.state==='removed')schedule(link.localId,50);
     }
     if(moved&&versions.get(org)!==heads.version){versions.set(org,heads.version);onAccount();}
    }catch(error){
     if(!current())break;
     if(error?.code==='unknown_org'){if(org)await orgEnded(org);break;}
     // Back online: poll again at once. Otherwise back off (the online hook wakes it).
     if(poll.kick){poll.kick=false;continue;}
     failures++;reachable=false;checkPause();
     await new Promise(resolve=>{const timer=setTimeout(()=>{poll.wake=null;resolve();},Math.min(30000,1000*2**Math.min(failures,5)));poll.wake=()=>{clearTimeout(timer);poll.wake=null;resolve();};});
    }
   }
  })().finally(()=>{if(polls.get(org)===poll)polls.delete(org);});
 }
 function watch(){
  unwatch??=watchStorage(hint=>{
   if(closed||!hint||hint.kind==='rescan')return;
   void db?.get('links',hint.projectId).then(link=>{if(link)schedule(hint.projectId,onlineOnly()?0:THROTTLE_MS);}).catch(()=>{});
  });
  if(!hooks&&globalThis.addEventListener){
   // Offline: an online-only deployment pauses editing at once. Online: catch up, then upload.
   hooks={offline:()=>{reachable=false;checkPause();for(const poll of polls.values())poll.controller?.abort();},online:()=>{if(closed)return;attempts.clear();for(const poll of polls.values()){poll.kick=true;poll.controller?.abort();poll.wake?.();}void db?.getAll('links').then(links=>{for(const l of links)schedule(l.localId,100);}).catch(()=>{});follow();}};
   globalThis.addEventListener('offline',hooks.offline);globalThis.addEventListener('online',hooks.online);
  }
  if(!ticker&&onlineOnly())ticker=setInterval(checkPause,1000);
 }
 /**
  * Deletes this browser's local copies of the deployment's projects and everything kept for
  * them (online-only: at sign-out, when the session ends and at start without a session), or
  * only those of organisation `org` (online-only: when access to it ends).
  */
 async function eraseLocal(org=null){
  const links=(await db.getAll('links')).filter(l=>!org||linkOrg(l)===org),ids=links.map(l=>l.localId);
  if(org&&!ids.length)return 0;
  await beforeErase(ids);
  for(const id of ids){clearTimeout(timers.get(id)?.timer);timers.delete(id);await storage.deleteProject(id).catch(()=>{});statuses.delete(id);copyOrg.delete(id);stalled.delete(id);}
  const tx=db.transaction(['links','outbox','objects','pdfs'],'readwrite');
  if(!org)for(const store of ['links','outbox','objects','pdfs'])await tx.objectStore(store).clear();
  else for(const l of links){
   await tx.objectStore('links').delete(l.localId);await tx.objectStore('outbox').delete(IDBKeyRange.bound([l.localId,0],[l.localId,Infinity]));
   await tx.objectStore('objects').delete(IDBKeyRange.bound([l.project,''],[l.project,'\uffff']));await tx.objectStore('pdfs').delete(l.project);
  }
  await tx.done;if(!org)stalled.clear();
  for(const id of ids)onChange(id);
  return ids.length;
 }
 async function begin(){
  if(!signedIn()){
   if(onlineOnly())await eraseLocal();
   else for(const link of await db.getAll('links'))setStatus(link.localId,'saved',`Sign in with ${connection.label||'your organisation'} again to keep syncing.`);
   return;
  }
  watch();follow();
  for(const link of await db.getAll('links')){
   if(link.org&&!holds(link.org)&&orgs().length){setStatus(link.localId,'ended',endedText(orgNamed(link.org)));continue;}
   schedule(link.localId,300);
  }
 }

 const api={
  get connected(){return !!connection;},
  get signedIn(){return signedIn();},
  get info(){
   if(!connection)return null;
   const {service,name,offline,compile,providers,provider,label,account,email,accountName}=connection,active=activeOrg(),list=orgs().map(o=>({...o})),org=active;
   const current=list.find(o=>o.id===active)||null,role=current?.role||connection.role||null;
   // `place` names where projects go: the organisation when the account has several, else the deployment.
   return{service,org,name,offline,compile:compile||'browser',providers,provider,label,account,email,accountName,role,guest:role==='guest',signedIn:signedIn(),
    orgs:list,active,activeName:current?.name||name,place:list.length>1?current?.name||name:name,
    ended:Object.entries(connection.ended||{}).map(([id,e])=>({id,name:e.name,at:e.at}))};
  },
  /** Works in another of the account's organisations: lists, sharing, the directory and the admin area follow it; copies keep syncing under their own. */
  async setActive(org){
   await load();if(!holds(org))throw Error('Your account has no role in that organisation.');
   if(connection.active===org)return api.info;
   connection.active=org;connection.role=roleIn(org);await save();follow();onAccount();
   return api.info;
  },
  /** The active organisation's members and administrators (names and verified emails), to share with; guests get none. */
  async directory(){await load();if(!signedIn()||roleIn(activeOrg())==='guest')return[];return (await clientFor(activeOrg()).directory()).members||[];},
  status:localId=>statuses.get(localId),
  /** Online-only: the reason editing is paused now, or ''. */
  editingPaused(localId){return connection&&onlineOnly()&&statuses.has(localId)&&paused()?pausedText(connection.name):'';},
  /** Resumes a browser that signed in before. Nothing runs without that. */
  async start(){
   if(!orgServerConnected())return false;
   await load();
   for(const link of await db.getAll('links'))setStatus(link.localId,'saved');
   // Roles and organisations may have changed at the provider since the last visit.
   await refreshOrgs().catch(()=>{});
   await begin();
   // The deployment's compile setting can change between visits (the projects' modes come with the heads).
   void orgClient(connection.service,{fetchImpl}).deployment().then(async d=>{if(connection&&d.compile!==connection.compile){connection.compile=d.compile;await save();onAccount();for(const l of await db.getAll('links'))onCompile(l.localId,remote?.[l.project]?.compile||null);}}).catch(()=>{});
   return true;
  },
  /** What a deployment address offers before anyone signs in: name, mode, offline and providers. */
  async deployment(address){
   const service=serviceOrigin(String(address||'').trim());
   return{service,...await orgClient(service,{fetchImpl}).deployment()};
  },
  /** Starts signing in with one of the deployment's providers; resolves to the provider's address. */
  async ssoBegin({service,provider}){
   const c=orgClient(service,{fetchImpl}),deployment=await c.deployment(),chosen=deployment.providers.find(p=>p.id===provider);
   if(deployment.encryption!=='server')throw Error('This deployment is end-to-end encrypted. Connect to it with Remote backup.');
   if(!chosen)throw Error('This deployment does not offer that sign-in.');
   const verifier=randomBytes(32),{url}=await c.ssoStart(provider,appOrigin,sha256Hex(verifier)),checked=signInUrl(url);
   writeSession(SSO_FLOW,{service,provider,label:chosen.label,name:deployment.name,offline:deployment.offline!==false,compile:deployment.compile||'browser',providers:deployment.providers,verifier:hex(verifier),started:now()});
   return checked;
  },
  /** Finishes signing in after the redirect back (`#scribyra-sso=…`) and starts syncing. */
  async ssoFinish(code){
   const flow=readSession(SSO_FLOW);writeSession(SSO_FLOW,null);
   if(!flow||!(now()-flow.started<15*60*1000))throw Error('This sign-in was not started in this tab, or took too long. Start it again.');
   const login=await orgClient(flow.service,{fetchImpl}).ssoRedeem(code,flow.verifier);
   // The login's organisations are its `orgs` (the deployment's `org` is only the primary one's ID, possibly null).
   if(typeof login.token!=='string'||!isId(login.token)||!Array.isArray(login.orgs)||!login.orgs.length)throw Error('The service sent an invalid sign-in.');
   await open();
   const previous=connection||await db.get('connection','current');
   if(previous&&(previous.service!==flow.service||previous.account!==login.account)&&(await db.count('links')))
    throw Error(`This browser holds projects of ${previous.email||'another account'} at ${previous.name}. Forget that deployment first.`);
   for(const link of await db.getAll('links'))noteLink(link);
   const same=previous&&previous.service===flow.service&&previous.account===login.account;
   connection={service:flow.service,name:flow.name,offline:flow.offline,compile:flow.compile||'browser',providers:flow.providers,provider:flow.provider,label:flow.label,
    token:login.token,expires:login.expires,account:login.account,email:login.email||null,accountName:login.name||null,role:login.role,client:previous?.client||hex(randomBytes(8)),
    orgs:same?previous.orgs||[]:[],active:same?previous.active:null,ended:same?previous.ended:undefined,notifyAdmin:same?previous.notifyAdmin:undefined};
   clients.clear();
   await takeOrgs(login);
   await save();markConnected(true);lastOk=now();reachable=true;closed=false;
   await begin();onAccount();
   return api.info;
  },
  /** Signs out: the server revokes the session; online-only deployments leave no local copy. */
  async signOut(){
   await load();const token=connection.token;
   if(token)try{await orgClient(connection.service,{fetchImpl}).ssoLogout(token);}catch(error){if(!(error instanceof ServiceError&&error.status===401))throw error;}
   connection.token=null;await save();stopFollowing();
   if(onlineOnly())await eraseLocal();
   else for(const link of await db.getAll('links'))setStatus(link.localId,'saved','Signed out. This copy stays on this device and syncs when you sign in again.');
   checkPause();onAccount();
  },
  /** Forgets the deployment on this browser. Online-only: local copies go too; otherwise they stay as personal projects. */
  async forget(){
   await load();if(onlineOnly())await eraseLocal();
   if(connection.token)await orgClient(connection.service,{fetchImpl}).ssoLogout(connection.token).catch(()=>{});
   api.close();connection=null;clients.clear();copyOrg.clear();projectOrg.clear();versions.clear();remote=null;await deleteDB(DB);markConnected(false);statuses.clear();closed=false;onAccount();
  },
  /** Projects this person can open (owned and shared) in the active organisation, with this browser's copy if any. */
  async projects(){
   await load();const org=activeOrg(),links=(await db.getAll('links')).filter(l=>!org||!l.org||l.org===org),byProject=new Map(links.map(l=>[l.project,l]));
   const listing=signedIn()?await clientFor(org).list():null,list=listing?.projects||[];
   // The role can change while signed in (the provider's roles at a refresh).
   if(listing?.role&&org&&roleIn(org)!==listing.role){connection.orgs=orgs().map(o=>o.id===org?{...o,role:listing.role,guest:listing.role==='guest'}:o);connection.role=listing.role;await save();}
   // The list is as fresh as the heads poll: roles and names it shows take effect here too.
   if(signedIn()){
    remote={...remote};for(const p of list){remote[p.id]={...remote[p.id],role:p.role,name:p.name,head:remote[p.id]?.head??p.head,org};if(org)projectOrg.set(p.id,org);}
    for(const l of links){const p=list.find(x=>x.id===l.project);if(p&&(p.role!==l.role||p.name!==l.name)){Object.assign(l,{role:p.role,name:p.name});await db.put('links',l);}}
   }
   const out=list.map(p=>({project:p.id,name:p.name,role:p.role,owner:p.owner,head:p.head,adminOpened:p.adminOpened||null,localId:byProject.get(p.id)?.localId||null}));
   const seen=new Set(out.map(p=>p.project));
   for(const l of links)if(!seen.has(l.project))out.push({project:l.project,name:l.name,role:l.created?null:'owner',owner:null,localId:l.localId,gone:l.created&&signedIn()});
   return out;
  },
  async links(){if(!orgServerConnected())return[];await load();return db.getAll('links');},
  /** "Add to <deployment>": a copy of a personal project becomes a new project on the server. */
  async add(localId){
   await load();if(!signedIn())throw Error('Sign in first.');
   const org=activeOrg();
   if(roleIn(org)==='guest'||!org&&connection.role==='guest')throw Error(`Guest accounts can’t create projects on ${api.info.place}.`);
   const read=await storage.readCommittedProject(localId);
   if(read.kind!=='updated')throw Error('Open or save the project on this device first.');
   const doc=new Y.Doc();
   try{
    Y.applyUpdate(doc,read.update);for(const b of read.blobs)installBlob(doc,b.ref,b.bytes);
    const meta=doc.getMap('meta'),name=String(meta.get('name')||'Untitled project').slice(0,200),lineage=crypto.randomUUID();
    meta.set('lineageId',lineage);
    const copy=crypto.randomUUID(),saved=await storage.saveProject(copy,doc);
    // The project's identity is durable here before the server hears of it (a retry finds it).
    const request=hex(randomBytes(32)),link={localId:copy,project:srProjectId(connection.account,request),request,org,name,role:'owner',lineage,created:false,seq:0,vector:new Uint8Array([0]),pushedSequence:-1,client:newClient(),clientSeq:0,mine:[]};
    await db.put('links',noteLink(link));void saved;
    setStatus(copy,'syncing');follow();
    await sync(copy);
    return{localId:copy,project:link.project,name};
   }finally{doc.destroy();}
  },
  async download(project){await load();if(!isId(project))throw Error('Unknown project.');const org=activeOrg();if(!remote||!remote[project])remote={...remote,...Object.fromEntries((await clientFor(org).list()).projects.map(p=>[p.id,{role:p.role,name:p.name,head:p.head,org}]))};if(org&&!projectOrg.has(project))projectOrg.set(project,org);const result=await download(project);follow();return result;},
  async details(project){await load();return on(project).details(project);},
  /** The admin area's client (administrators only; the service refuses everyone else). */
  async admin(){await load();if(!signedIn())throw Error('Sign in first.');return clientFor(activeOrg()).admin;},
  /** "Open as administrator": the audited open, then a read-only copy on this browser (or the one it has). */
  async openAsAdmin(project){
   await load();const org=activeOrg(),admin=clientFor(org).admin,details=await admin.open(project);
   // Whether members are told (`notify_on_admin_access`) decides what this copy says.
   const notify=await admin.settings().then(s=>s.notifyOnAdminAccess!==false,()=>connection.notifyAdmin);
   if(notify!==connection.notifyAdmin){connection.notifyAdmin=notify;await save();}
   remote={...remote,[project]:{...remote?.[project],role:details.role,name:details.name,head:details.head,org}};if(org)projectOrg.set(project,org);
   const link=(await db.getAll('links')).find(l=>l.project===project);
   if(link){if(link.role!==details.role)await db.put('links',{...link,role:details.role});schedule(link.localId,50);return{localId:link.localId,name:link.name};}
   const result=await download(project);if(!result)throw Error('This project has no changes yet.');
   return result;
  },
  /** Invites by email (`guest`: an explicit guest invitation; `account`: the account chosen when several share the email). */
  async invite(project,email,role,{guest=false,account=null}={}){await load();return on(project).invite(project,String(email||'').trim(),role,{guest,account});},
  async withdraw(project,id){await load();await on(project).withdraw(project,id);},
  async setMemberRole(project,account,role){await load();return on(project).setRole(project,account,role);},
  async removeMember(project,account){await load();await on(project).removeMember(project,account);},
  async projectRole(localId){if(!connection)return null;await open();const link=await db.get('links',localId);return link?remote?.[link.project]?.role||link.role:null;},
  /** The editor modes a person's role allows (an owner edits). */
  async allowedModes(localId){const r=await api.projectRole(localId);return r?ROLE_MODES[r==='owner'?'editor':r]||['viewing']:null;},

  // --- Server compile (design section 6)

  /** Where an organisation copy compiles: {mode, canCompile, canSwitch, job, state}, or null for
   * personal projects and deployments that compile in the browser. */
  async compileChoice(localId){
   if(!connection)return null;await open();const link=await db.get('links',localId);if(!link)return null;
   const r=remote?.[link.project],choice=compileChoice({deployment:connection.compile,mode:r?.compile?.mode||link.compile,role:r?.role||link.role,accountRole:roleIn(linkOrg(link))||connection.role});
   return choice&&{...choice,project:link.project,job:r?.compile?.job||null,state:r?.compile?.state||null};
  },
  /** The project switch (deployment `compile: both`; owner and editors, not guests). */
  async setCompileMode(project,mode){
   await load();if(!isId(project))throw Error('Unknown project.');
   const {compile}=await on(project).setCompile(project,mode);
   if(remote?.[project])remote={...remote,[project]:{...remote[project],compile:{...remote[project].compile,mode:compile}}};
   const link=(await db.getAll('links')).find(l=>l.project===project);
   if(link){await db.put('links',{...link,compile});onCompile(link.localId,remote?.[project]?.compile||{mode:compile});}
   return compile;
  },
  /**
   * Compiles this copy on the server at the version it has uploaded: sends what waits in the
   * outbox and what was saved since, asks for a compile at the highest entry this copy holds,
   * follows the job (the heads poll wakes the wait; the status is read at least every 3 s), and
   * keeps the PDF. Resolves to {state:'done', record} or {state:'failed', outcome, error, log, job}.
   */
  async compileOnServer(localId,{signal,progress=()=>{}}={}){
   await load();if(!signedIn())throw Error(`Sign in with ${connection.label||'your organisation'} to compile on the server.`);
   let link=await db.get('links',localId);if(!link)throw Error('This project is not on the server.');
   progress('Sending your changes to the server…');
   for(let round=0;;round++){
    signal?.throwIfAborted();
    await sync(localId);link=await db.get('links',localId);
    const read=await storage.readCommittedProject(localId),unsent=await db.count('outbox',IDBKeyRange.bound([localId,0],[localId,Infinity]));
    if(!unsent&&read.kind==='updated'&&read.head.sequence===link.pushedSequence)break;
    if(round>=4)throw Error('Your latest changes have not reached the server yet. Compile again in a moment.');
   }
   const seq=Math.max(link.seq,...(link.mine||[]));
   progress('Queued on server…');
   let asked;
   try{asked=await on(link.project).compile(link.project,seq);}
   catch(error){
    // The project was switched to the browser meanwhile: this copy follows before the next poll.
    if(error instanceof ServiceError&&error.status===409){const mode={...remote?.[link.project]?.compile,mode:'browser'};if(remote?.[link.project])remote={...remote,[link.project]:{...remote[link.project],compile:mode}};await db.put('links',{...await db.get('links',localId),compile:'browser'});onCompile(localId,mode);}
    throw error;
   }
   let job=asked.job,status=null;
   if(!isId(job))throw new ServiceError(0,'The server sent an invalid compile job.');
   if(asked.state!=='done'){
    const deadline=now()+30*60*1000;
    for(;;){
     signal?.throwIfAborted();
     status=await on(link.project).compileStatus(link.project);const latest=status.job;
     // A newer request (another member's) replaced or followed this one: its result is the one to show.
     if(latest&&latest.id!==job)job=latest.id;
     if(latest?.id===job&&(latest.state==='done'||latest.state==='failed'))break;
     progress(latest?.id===job&&latest.state==='running'?'Compiling on server…':'Queued on server…');
     if(now()>deadline)throw Error('The server compile is taking too long. Its result appears here when it finishes.');
     await new Promise(resolve=>{const timer=setTimeout(done,3000),waiters=compileWaiters.get(link.project)||new Set();function done(){clearTimeout(timer);waiters.delete(done);signal?.removeEventListener('abort',done);resolve();}waiters.add(done);compileWaiters.set(link.project,waiters);signal?.addEventListener('abort',done,{once:true});});
    }
    if(status.job.state==='failed')return{state:'failed',job,outcome:status.job.outcome,error:status.job.error||'The server compile failed.',log:await on(link.project).compileLog(link.project,job).catch(()=>'')};
   }
   status??=await on(link.project).compileStatus(link.project);
   const pdf=await on(link.project).compilePdf(link.project,job);
   if(!pdf)throw Error('The server no longer keeps this compile’s PDF. Compile again.');
   // A cached answer names an earlier compile of the same files, which therefore shows `seq` too.
   const record={project:link.project,job,seq:Math.max(pdf.seq,seq),compiled:status.pdf?.job===job?status.pdf.compiled:status.job?.finished||now(),requestedBy:status.pdf?.job===job?status.pdf.requestedBy?.name||null:null,bytes:pdf.bytes};
   const held=await db.get('pdfs',link.project);
   if(!held||held.job!==job||held.seq<record.seq)await db.put('pdfs',record);
   return{state:'done',record:await db.get('pdfs',link.project),cached:!!asked.cached};
  },
  /** The PDF this browser keeps for a copy (shown offline too), or null. */
  async serverPdf(localId){if(!connection)return null;await open();const link=await db.get('links',localId);return link?await db.get('pdfs',link.project)||null:null;},
  /** Fetches the project's latest server PDF when it is newer than the kept one; resolves to the kept record. */
  async refreshPdf(localId){
   await load();const link=await db.get('links',localId);if(!link)return null;
   const held=await db.get('pdfs',link.project)||null;if(!signedIn())return held;
   const status=await on(link.project).compileStatus(link.project);
   if(!status.pdf||held?.job===status.pdf.job)return held;
   const pdf=await on(link.project).compilePdf(link.project,status.pdf.job);if(!pdf)return held;
   const record={project:link.project,job:pdf.job,seq:pdf.seq,compiled:status.pdf.compiled,requestedBy:status.pdf.requestedBy?.name||null,bytes:pdf.bytes};
   await db.put('pdfs',record);return record;
  },
  /** The latest job's state and, for a failed one, its log: {job, state, outcome, error, log}. */
  async compileStatus(localId){
   await load();const link=await db.get('links',localId);if(!link||!signedIn())return null;
   const job=(await on(link.project).compileStatus(link.project)).job;if(!job)return null;
   return{...job,log:job.state==='failed'?await on(link.project).compileLog(link.project,job.id).catch(()=>''):''};
  },
  /** Whether the kept PDF shows what this copy holds (see `compiledLatest`). */
  async pdfLatest(localId){
   if(!connection)return false;await open();const link=await db.get('links',localId);if(!link)return false;
   const record=await db.get('pdfs',link.project);if(!record)return false;
   const read=await storage.readCommittedProject(localId),unsent=await db.count('outbox',IDBKeyRange.bound([localId,0],[localId,Infinity]));
   return compiledLatest({seq:record.seq,serverSeq:Math.max(link.seq,...(link.mine||[])),unsent:unsent>0||read.kind!=='updated'||read.head.sequence!==link.pushedSequence});
  },
  sync,
  close(){closed=true;stopFollowing();if(hooks){globalThis.removeEventListener?.('offline',hooks.offline);globalThis.removeEventListener?.('online',hooks.online);hooks=null;}clearInterval(ticker);ticker=0;unwatch?.();unwatch=null;for(const t of timers.values())clearTimeout(t.timer);timers.clear();db?.close();db=null;},
 };
 return api;
}
