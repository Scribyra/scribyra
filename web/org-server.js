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
const database=()=>openDB(DB,1,{upgrade(db){
 db.createObjectStore('connection');
 db.createObjectStore('links',{keyPath:'localId'});
 db.createObjectStore('outbox',{keyPath:['localId','clientSeq']});
 // Objects this browser uploaded to or fetched from the service, per project.
 db.createObjectStore('objects',{keyPath:['project','hash']});
}});

export const STATUS_TEXT={
 saved:'Saved on this device',syncing:'Syncing…',synced:'Synced',waiting:'Waiting to sync','read-only':'Read only',
 removed:'No longer shared with you',paused:'Sync paused',
};
export const MODE_TEXT=name=>`Stored on ${name}’s server, which can read it. ${name}’s administrators can open it.`;
export const pausedText=name=>`Reconnecting — editing is paused because ${name} keeps projects online only.`;
// One entry may carry at most this much; the service's default `sr_entry_bytes` is 16 MiB.
export const MAX_ENTRY_BYTES=15*1024*1024;
const RETRY=[2000,10000,30000,120000];
const THROTTLE_MS=2000;
// Online-only: editing needs a request to the service that succeeded this recently.
export const ONLINE_WINDOW_MS=30000;
const QUOTA_TEXT='The organisation’s storage on the server is full. Your changes are saved on this device and sync when space is freed.';
const isHash=value=>typeof value==='string'&&/^[0-9a-f]{64}$/.test(value);
const isId=isHash;
const fault=message=>Object.assign(Error(message),{fatal:true});
const writes=role=>role==='owner'||role==='editor';

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
/** HTTP client for one deployment's `/v1/sr/` routes, with the person's sign-in token. */
export function srClient(service,{token,fetchImpl=globalThis.fetch.bind(globalThis),timeoutMs=20000,onAnswer=()=>{}}={}){
 async function request(path,{method='GET',body,type,headers={},timeout=timeoutMs,signal,allow=[]}={}){
  const all={...headers,Authorization:'ScribyraSSO '+token()};if(type)all['Content-Type']=type;
  let response;
  try{response=await fetchImpl(service+path,{method,headers:all,body,signal:signal?AbortSignal.any([signal,AbortSignal.timeout(timeout)]):AbortSignal.timeout(timeout),cache:'no-store',credentials:'omit'});}
  catch(error){if(signal?.aborted)throw error;throw new ServiceError(0,error?.name==='TimeoutError'?'The server did not answer in time.':'The server cannot be reached. Your changes stay saved on this device.');}
  onAnswer(response.status);
  if(!response.ok&&!allow.includes(response.status)){
   let detail='';try{const b=await response.json();if(typeof b?.error==='string'&&b.error.length<300)detail=b.error;}catch{}
   throw Object.assign(new ServiceError(response.status,detail?`${messages[response.status]||'The server refused the request.'} (${detail})`:messages[response.status]||`The server answered ${response.status}.`),{detail});
  }
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
  invite:(project,email,role)=>send('POST',p(project)+'/invitations',{email,role}),
  async withdraw(project,id){await request(`${p(project)}/invitations/${id}`,{method:'DELETE'});},
  setRole:(project,account,role)=>send('PUT',`${p(project)}/members/${account}`,{role}),
  async removeMember(project,account){await request(`${p(project)}/members/${account}`,{method:'DELETE'});},
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
 };
}

export function orgServer({onChange=()=>{},onRemote=()=>{},onAccount=()=>{},beforeErase=async()=>{},fetchImpl,locks=globalThis.navigator?.locks,appOrigin=globalThis.location?.origin,now=()=>Date.now()}={}){
 let db,connection=null,client=null,closed=false,unwatch=null,following=null,polling=null,hooks=null,ticker=0,lastOk=0,reachable=true,live=false,remote=null,version=null,kick=false,wake=null;
 const statuses=new Map(),timers=new Map(),attempts=new Map(),queues=new Map(),stalled=new Set();
 const setStatus=(localId,state,message='')=>{const old=statuses.get(localId);statuses.set(localId,{state,message,label:STATUS_TEXT[state]});if(old?.state!==state||old?.message!==message)onChange(localId);};
 async function open(){db??=await database();return db;}
 const signedIn=()=>!!connection?.token&&connection.expires*1000>now();
 const onlineOnly=()=>connection?.offline===false;
 async function save(){await (await open()).put('connection',connection,'current');}
 async function load(){
  await open();connection??=await db.get('connection','current')||null;
  if(!connection)throw Error('This browser is not signed in to a deployment.');
  client??=srClient(connection.service,{fetchImpl,token:()=>connection.token,onAnswer:answered});
  return connection;
 }
 // Every answer from the service counts as a round trip; a refused session ends the sign-in.
 let wasPaused=null;
 function answered(status){
  if(status===401){if(connection?.token){connection.token=null;void save().then(sessionEnded);}return;}
  lastOk=now();reachable=true;checkPause();
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
 async function uploadObjects(project,wanted){for(const o of wanted){await client.putObject(project,o.hash,o.bytes);await noteObject(project,o.hash);}}
 async function fetchObject(project,hash,size=null){
  const bytes=await client.getObject(project,hash);
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
   const page=await client.logPage(project,seq);
   if(page.compacted){const snapshot=await client.snapshot(project);await each(snapshot.update,snapshot.seq,true);seq=snapshot.seq;continue;}
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
  try{ack=await client.append(link.project,link.client,entry.clientSeq,entry.body);}
  catch(error){
   if(error instanceof ServiceError&&error.status===409)throw fault('The server holds a different change at this position. Sync paused for this project.');
   if(error instanceof ServiceError&&error.status===403)throw Object.assign(fault('Your role on this project does not let you change it. Your changes stay on this device.'),{readOnly:true});
   if(error instanceof ServiceError&&error.status===404)throw Object.assign(fault('This project is no longer shared with you. It stays on this device.'),{removed:true});
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
  setStatus(localId,'syncing');
  if(!link.created){
   await client.create(link.project,link.name.slice(0,200));
   await db.put('links',link={...link,created:true});
  }
  link=await pull(link);
  const role=remote?.[link.project]?.role||link.role;
  if(!writes(role)){attempts.delete(localId);stalled.delete(localId);setStatus(localId,'read-only',`Your role on this project is ${role}: what you change stays on this device.`);await hydrateHistory(localId,link.project).catch(()=>{});return;}
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
  const doc=new Y.Doc(),entry=remote?.[project];
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
   const link={localId,project,name:doc.getMap('meta').get('name')||entry?.name||'Untitled project',role:entry?.role||'viewer',lineage,created:true,seq,vector:Y.encodeStateVector(doc),pushedSequence:saved.sequence,client:newClient(),clientSeq:0,mine:[]};
   await db.put('links',link);
   await hydrateHistory(localId,project).catch(()=>{});
   setStatus(localId,writes(link.role)?'synced':'read-only');
   return{localId,name:link.name};
  }finally{doc.destroy();}
 }
 // A client ID per local copy (`<browser>-<copy>`), so a copy downloaded again never reuses numbers.
 const newClient=()=>`${connection.client}-${hex(randomBytes(8))}`;

 // --- Following the server

 function stopFollowing(){polling?.abort();live=false;}
 /**
  * A long poll on the server's heads: a project whose head passed this copy's cursor is synced;
  * one that disappeared is no longer shared; any change redraws the dialog. A missed notice is
  * repaired by the next poll and by every sync's catch-up.
  */
 function follow(){
  if(following||closed||!signedIn())return;
  following=(async()=>{
   let since,failures=0;
   while(!closed&&signedIn()){
    try{
     polling=new AbortController();
     const heads=await client.heads(since,since===undefined?0:onlineOnly()?20:25,polling.signal);
     if(closed)break;
     failures=0;live=true;kick=false;const moved=heads.version!==since;since=heads.version;remote=heads.projects||{};
     for(const link of await db.getAll('links')){
      const r=remote[link.project];
      if(!r){if(link.created&&statuses.get(link.localId)?.state!=='removed')setStatus(link.localId,'removed','This project is no longer shared with you. It stays on this device.');continue;}
      if(r.role!==link.role||r.name!==link.name){await db.put('links',{...link,role:r.role,name:r.name});onChange(link.localId);}
      if(r.head>link.seq||statuses.get(link.localId)?.state==='removed')schedule(link.localId,50);
     }
     if(moved&&version!==heads.version){version=heads.version;onAccount();}
    }catch(error){
     if(closed||!signedIn())break;
     live=false;
     // Back online: poll again at once. Otherwise back off (the online hook wakes it).
     if(kick){kick=false;continue;}
     failures++;reachable=false;checkPause();
     await new Promise(resolve=>{const timer=setTimeout(()=>{wake=null;resolve();},Math.min(30000,1000*2**Math.min(failures,5)));wake=()=>{clearTimeout(timer);wake=null;resolve();};});
    }
   }
  })().finally(()=>{following=null;live=false;});
 }
 function watch(){
  unwatch??=watchStorage(hint=>{
   if(closed||!hint||hint.kind==='rescan')return;
   void db?.get('links',hint.projectId).then(link=>{if(link)schedule(hint.projectId,onlineOnly()?0:THROTTLE_MS);}).catch(()=>{});
  });
  if(!hooks&&globalThis.addEventListener){
   // Offline: an online-only deployment pauses editing at once. Online: catch up, then upload.
   hooks={offline:()=>{reachable=false;checkPause();polling?.abort();},online:()=>{if(closed)return;attempts.clear();kick=true;polling?.abort();wake?.();void db?.getAll('links').then(links=>{for(const l of links)schedule(l.localId,100);}).catch(()=>{});follow();}};
   globalThis.addEventListener('offline',hooks.offline);globalThis.addEventListener('online',hooks.online);
  }
  if(!ticker&&onlineOnly())ticker=setInterval(checkPause,1000);
 }
 /**
  * Deletes this browser's local copies of the deployment's projects and everything kept for
  * them (online-only: at sign-out, when the session ends and at start without a session).
  */
 async function eraseLocal(){
  const links=await db.getAll('links'),ids=links.map(l=>l.localId);
  await beforeErase(ids);
  for(const id of ids){clearTimeout(timers.get(id)?.timer);timers.delete(id);await storage.deleteProject(id).catch(()=>{});statuses.delete(id);}
  const tx=db.transaction(['links','outbox','objects'],'readwrite');
  for(const store of ['links','outbox','objects'])await tx.objectStore(store).clear();
  await tx.done;stalled.clear();
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
  for(const link of await db.getAll('links'))schedule(link.localId,300);
 }

 const api={
  get connected(){return !!connection;},
  get signedIn(){return signedIn();},
  get info(){
   if(!connection)return null;
   const {service,org,name,offline,providers,provider,label,account,email,accountName,role}=connection;
   return{service,org,name,offline,providers,provider,label,account,email,accountName,role,signedIn:signedIn()};
  },
  status:localId=>statuses.get(localId),
  /** Online-only: the reason editing is paused now, or ''. */
  editingPaused(localId){return connection&&onlineOnly()&&statuses.has(localId)&&paused()?pausedText(connection.name):'';},
  /** Resumes a browser that signed in before. Nothing runs without that. */
  async start(){
   if(!orgServerConnected())return false;
   await load();
   for(const link of await db.getAll('links'))setStatus(link.localId,'saved');
   await begin();
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
   writeSession(SSO_FLOW,{service,org:deployment.org,provider,label:chosen.label,name:deployment.name,offline:deployment.offline!==false,providers:deployment.providers,verifier:hex(verifier),started:now()});
   return checked;
  },
  /** Finishes signing in after the redirect back (`#scribyra-sso=…`) and starts syncing. */
  async ssoFinish(code){
   const flow=readSession(SSO_FLOW);writeSession(SSO_FLOW,null);
   if(!flow||!(now()-flow.started<15*60*1000))throw Error('This sign-in was not started in this tab, or took too long. Start it again.');
   const login=await orgClient(flow.service,{fetchImpl}).ssoRedeem(code,flow.verifier);
   if(login.org!==flow.org||typeof login.token!=='string'||!isId(login.token))throw Error('The sign-in came back for another organisation.');
   await open();
   const previous=connection||await db.get('connection','current');
   if(previous&&(previous.service!==flow.service||previous.account!==login.account)&&(await db.count('links')))
    throw Error(`This browser holds projects of ${previous.email||'another account'} at ${previous.name}. Forget that deployment first.`);
   connection={service:flow.service,org:flow.org,name:flow.name,offline:flow.offline,providers:flow.providers,provider:flow.provider,label:flow.label,
    token:login.token,expires:login.expires,account:login.account,email:login.email||null,accountName:login.name||null,role:login.role,client:previous?.client||hex(randomBytes(8))};
   client=srClient(connection.service,{fetchImpl,token:()=>connection.token,onAnswer:answered});
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
   api.close();db?.close();db=null;connection=null;client=null;remote=null;await deleteDB(DB);markConnected(false);statuses.clear();closed=false;onAccount();
  },
  /** Projects this person can open (owned and shared), with this browser's copy if any. */
  async projects(){
   await load();const links=await db.getAll('links'),byProject=new Map(links.map(l=>[l.project,l]));
   const list=signedIn()?(await client.list()).projects:[];
   // The list is as fresh as the heads poll: roles and names it shows take effect here too.
   if(signedIn()){
    remote={...remote};for(const p of list)remote[p.id]={...remote[p.id],role:p.role,name:p.name,head:remote[p.id]?.head??p.head};
    for(const l of links){const p=list.find(x=>x.id===l.project);if(p&&(p.role!==l.role||p.name!==l.name)){Object.assign(l,{role:p.role,name:p.name});await db.put('links',l);}}
   }
   const out=list.map(p=>({project:p.id,name:p.name,role:p.role,owner:p.owner,head:p.head,localId:byProject.get(p.id)?.localId||null}));
   const seen=new Set(out.map(p=>p.project));
   for(const l of links)if(!seen.has(l.project))out.push({project:l.project,name:l.name,role:l.created?null:'owner',owner:null,localId:l.localId,gone:l.created&&signedIn()});
   return out;
  },
  async links(){if(!orgServerConnected())return[];await load();return db.getAll('links');},
  /** "Add to <deployment>": a copy of a personal project becomes a new project on the server. */
  async add(localId){
   await load();if(!signedIn())throw Error('Sign in first.');
   if(connection.role==='guest')throw Error(`Guest accounts can’t create projects on ${connection.name}.`);
   const read=await storage.readCommittedProject(localId);
   if(read.kind!=='updated')throw Error('Open or save the project on this device first.');
   const doc=new Y.Doc();
   try{
    Y.applyUpdate(doc,read.update);for(const b of read.blobs)installBlob(doc,b.ref,b.bytes);
    const meta=doc.getMap('meta'),name=String(meta.get('name')||'Untitled project').slice(0,200),lineage=crypto.randomUUID();
    meta.set('lineageId',lineage);
    const copy=crypto.randomUUID(),saved=await storage.saveProject(copy,doc);
    // The project's identity is durable here before the server hears of it (a retry finds it).
    const link={localId:copy,project:hex(randomBytes(32)),name,role:'owner',lineage,created:false,seq:0,vector:new Uint8Array([0]),pushedSequence:-1,client:newClient(),clientSeq:0,mine:[]};
    await db.put('links',link);void saved;
    setStatus(copy,'syncing');
    await sync(copy);
    return{localId:copy,project:link.project,name};
   }finally{doc.destroy();}
  },
  async download(project){await load();if(!isId(project))throw Error('Unknown project.');if(!remote)remote=Object.fromEntries((await client.list()).projects.map(p=>[p.id,{role:p.role,name:p.name,head:p.head}]));return download(project);},
  async details(project){await load();return client.details(project);},
  async invite(project,email,role){await load();return client.invite(project,String(email||'').trim(),role);},
  async withdraw(project,id){await load();await client.withdraw(project,id);},
  async setMemberRole(project,account,role){await load();return client.setRole(project,account,role);},
  async removeMember(project,account){await load();await client.removeMember(project,account);},
  async projectRole(localId){if(!connection)return null;await open();const link=await db.get('links',localId);return link?remote?.[link.project]?.role||link.role:null;},
  /** The editor modes a person's role allows (an owner edits). */
  async allowedModes(localId){const r=await api.projectRole(localId);return r?ROLE_MODES[r==='owner'?'editor':r]||['viewing']:null;},
  sync,
  close(){closed=true;stopFollowing();if(hooks){globalThis.removeEventListener?.('offline',hooks.offline);globalThis.removeEventListener?.('online',hooks.online);hooks=null;}clearInterval(ticker);ticker=0;unwatch?.();unwatch=null;for(const t of timers.values())clearTimeout(t.timer);timers.clear();},
 };
 return api;
}
