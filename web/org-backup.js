// Organisation sync with a self-hosted scribyra-sync service: encrypted backups, organisations
// with invitations, roles and project sharing, single sign-on, linked devices and sync between
// them. Nothing here runs, opens a database or creates a key until the person connects, joins
// or signs in (off means off).
//
// Every step that the service commits is prepared locally first (connection record, outbox
// entry, pending recovery kit, pending project), so a crash or a lost answer is resumed with
// identical bytes instead of leaving the service and this browser apart.
import * as Y from 'yjs';
import {openDB,deleteDB} from 'idb';
import * as storage from './storage.js';
import {watchStorage} from './storage-events.js';
import {profileIdentity} from './direct-identity.js';
import {setDirectKeyPresent} from './direct-state.js';
import {SCHEMA_VERSION,validateProjectState} from './model.js';
import {blobRefs,installBlob,knownBlob,verifyBlob} from './assets.js';
import {validateReplica} from './replication.js';
import {validateRetainedState,MAX_RETAINED_BYTES} from './model.js';
import {orgClient,ServiceError} from './org-client.js';
import {
 parseSetupCode,parseKit,formatKit,newRecoveryCode,recoverySecrets,recoveryProof,newAgreementKey,openAgreementKey,newStorageKey,sealAtRest,openAtRest,
 signEvent,genesisBody,enrolPublic,deviceProof,applyEvents,newProjectKey,wrapProjectKey,unwrapProjectKey,personId,
 sealEntry,openEntry,verifyEntryBody,entryHash,chainNext,randomBytes,hex,unhex,sha256Hex,
 sealName,openName,sealProjectName,openProjectName,wrapRecipients,
 parseInvite,formatInvite,inviteSeed,inviteMessage,formatDeviceLink,parseDeviceLink,linkSeed,deviceRequestMessage,linkCode,
 formatOrgLink,parseOrgLink,newDeviceCode,deviceCodeMac,signInUrl,keyCommit,
 sealObject,openObjectPart,objectParts,blobrefPayload,checkBlobref,
} from './org-crypto.js';
import {org_ed25519_public,org_ed25519_sign,org_ed25519_verify,org_object_id,blob_hash,history_validate_manifest} from './pkg/scribyra_app.js';

export const ORG_CONNECTED='scribyra:org-connected';
export function orgConnected(){try{return globalThis.localStorage?.getItem(ORG_CONNECTED)==='true';}catch{return false;}}
const ORG_JOINING='scribyra:org-joining';
const markConnected=on=>{try{localStorage.removeItem(ORG_JOINING);if(on)localStorage.setItem(ORG_CONNECTED,'true');else localStorage.removeItem(ORG_CONNECTED);}catch{}};
/** A join or device link was started here and waits for approval. */
export function orgJoining(){try{return globalThis.localStorage?.getItem(ORG_JOINING)==='true';}catch{return false;}}
const markJoining=()=>{try{localStorage.setItem(ORG_JOINING,'true');}catch{}};
const DB='scribyra-org';
const database=()=>openDB(DB,2,{upgrade(db,old){
 if(old<1){
  db.createObjectStore('connection');
  db.createObjectStore('links',{keyPath:'localId'});
  db.createObjectStore('outbox',{keyPath:['localId','clientSeq']});
  db.createObjectStore('keys',{keyPath:['project','epoch']});
 }
 // Encrypted objects known to be on the service (uploaded here, or announced by a blobref):
 // which epoch sealed them and the IDs of their parts.
 if(old<2)db.createObjectStore('objects',{keyPath:['project','kind','hash','epoch']});
}});
// One entry may carry at most this much Yjs data; the service's default object limit is 8 MiB.
export const MAX_ENTRY_BYTES=7*1024*1024;
const RETRY=[2000,10000,30000,120000];
const MAX_BLOBREF=512;
const isHash=value=>typeof value==='string'&&/^[0-9a-f]{64}$/.test(value);
const QUOTA_TEXT='The organisation’s storage on the service is full. Your changes are saved on this device and will back up when space is freed.';
const WRAP_BATCH=64;
const INVITE_DAYS=7;
const LINK_MS=15*60*1000;
const keyContext=(org,project,epoch)=>`scribyra-org-key/1\n${org}\n${project}\n${epoch}`;
const kitContext=org=>`scribyra-org-kit/1\n${org}`;
const agreementContext=(org,device)=>`scribyra-org-agreement/1\n${org}\n${device}`;
const SSO_FLOW='scribyra:sso-flow',SSO_LOGIN='scribyra:sso-login';
const readSession=key=>{try{return JSON.parse(globalThis.sessionStorage?.getItem(key)||'null');}catch{return null;}};
const writeSession=(key,value)=>{try{if(value)globalThis.sessionStorage.setItem(key,JSON.stringify(value));else globalThis.sessionStorage.removeItem(key);}catch{}};

export const STATUS_TEXT={
 'backed-up':'Backed up remotely','synced':'Synced','backing-up':'Backing up…','waiting':'Waiting to back up','paused':'Backup paused',
 'unsupported':'Not backed up remotely','read-only':'Synced · read only','removed':'No longer shared with you',
};
export const MODE_TEXT={
 e2ee:'End-to-end encrypted. Only members’ devices (and their recovery kits) can read these projects. The service stores ciphertext; its operator can see who is a member, sizes and timing.',
 managed:'Organisation-managed. The service holds the keys to these projects: its operator and the organisation’s administrators can read them.',
};
export const ROLE_MODES={editor:['editing','reviewing','viewing'],reviewer:['reviewing','viewing'],viewer:['viewing']};
const fault=message=>Object.assign(Error(message),{fatal:true});
const ssoNeeded=error=>error instanceof ServiceError&&error.status===401&&/single sign-on (is required|expired)/.test(error.message);
/** Merges two encoded Yjs state vectors (the larger clock per client), in Yjs's encoding. */
function mergeVectors(a,b){
 const out=Y.decodeStateVector(a);
 for(const [client,clock] of Y.decodeStateVector(b))if((out.get(client)||0)<clock)out.set(client,clock);
 const bytes=[],varUint=n=>{while(n>0x7f){bytes.push(0x80|(n&0x7f));n=Math.floor(n/128);}bytes.push(n);};
 varUint(out.size);for(const [client,clock] of [...out].sort((x,y)=>y[0]-x[0])){varUint(client);varUint(clock);}
 return Uint8Array.from(bytes);
}

export function orgBackup({onChange=()=>{},onRemote=()=>{},onMembership=()=>{},fetchImpl,locks=globalThis.navigator?.locks,appOrigin=globalThis.location?.origin,sealAgreement}={}){
 let db,connection,client,closed=false,unwatch,pendingKitText='',following=null,live=false,polling=null,onlineHook=null;
 const statuses=new Map(),timers=new Map(),attempts=new Map(),queues=new Map();
 const setStatus=(localId,state,message='')=>{statuses.set(localId,{state,message,label:STATUS_TEXT[state]});onChange(localId);};
 async function open(){db??=await database();return db;}
 // WebKit on Linux stores a record that holds an X25519 CryptoKey but reads it back as null. Where
 // that round trip fails, the agreement key is kept sealed (PKCS#8) under the non-extractable
 // storage key instead, and reopened as a non-extractable CryptoKey when the record is read.
 let agreementSealed=sealAgreement===undefined?null:Promise.resolve(!!sealAgreement);
 function mustSealAgreement(){
  return agreementSealed??=(async()=>{
   const store=await open(),probe=(await crypto.subtle.generateKey({name:'X25519'},false,['deriveBits'])).privateKey;
   try{await store.put('connection',{probe},'x25519-probe');return(await store.get('connection','x25519-probe'))?.probe?.type!=='private';}
   catch{return true;}
   finally{await store.delete('connection','x25519-probe').catch(()=>{});}
  })();
 }
 async function readConnection(){
  const stored=await (await open()).get('connection','current');
  if(stored?.agreement?.sealed)stored.agreement=await openAgreementKey(stored.storageKey,stored.agreement,agreementContext(stored.org,stored.device));
  return stored;
 }
 async function load(){
  const stored=await readConnection();
  // A connect, join or link in progress here owns `connection` until it is ready; a record read
  // meanwhile is older than that flow's own state and must not replace it.
  if(stored?.ready||!connection||connection.ready)connection=stored;
  if(!connection||!connection.ready)throw Error('This browser is not connected to a service.');
  client??=orgClient(connection.service,{fetchImpl});return connection;
 }
 async function saveConnection(){
  const record=connection.agreement?.sealed?{...connection,agreement:{publicKey:connection.agreement.publicKey,sealed:connection.agreement.sealed}}:connection;
  await (await open()).put('connection',record,'current');
 }
 async function signIn(){
  try{return await client.signIn(connection.org,await deviceIdentity(),{sso:connection.ssoToken});}
  catch(error){if(ssoNeeded(error)){connection.ssoToken=null;connection.ssoNeeded=true;await saveConnection();onMembership();}throw error;}
 }
 // Every request signs in again once if the service forgot this browser's session.
 async function authed(task){
  if(!client.token)await signIn();
  try{return await task();}
  catch(error){if(error instanceof ServiceError&&error.status===401){client.forget();await signIn();return task();}throw error;}
 }
 async function deviceIdentity(){
  const identity=await profileIdentity();
  if(identity.publicKey!==connection.device)throw Error('This browser’s signing key changed since it connected. Restore with your recovery kit to connect it again.');
  return identity;
 }
 const me=()=>connection.state.persons[connection.person];
 async function refreshMembership(){
  const before=connection.state.count;
  // The long poll, a push and a dialog can refresh at the same time: events read after one count
  // are applied only to a state still at that count, or read again from where the state now is.
  for(;;){
   const from=connection.state.count,events=await authed(()=>client.events(connection.org,from));
   if(connection.state.count!==from)continue;
   if(events.length){connection.state=applyEvents(connection.state,connection.org,events);await saveConnection();}
   break;
  }
  if(connection.state.count!==before)onMembership();
  return connection.state;
 }
 /** Signs an event at the current head and posts it; on a moved head, refreshes and signs again. */
 async function post(type,makeBody){
  for(let attempt=0;;attempt++){
   // The long poll may refresh the state while this signs: sign and apply against one snapshot.
   const base=connection.state,identity=await deviceIdentity(),prev=base.head,body=await makeBody(prev);
   const raw=await signEvent({org:connection.org,prev,type,body},identity);
   const state=applyEvents(base,connection.org,[raw]);
   try{
    await authed(()=>client.postEvent(connection.org,raw));
    if(state.count>connection.state.count){connection.state=state;await saveConnection();}
    onMembership();return connection.state;
   }
   catch(error){if(attempt<3&&error instanceof ServiceError&&error.status===409){await refreshMembership();continue;}throw error;}
  }
 }

 // --- Keys

 async function projectKey(project,epoch){
  const record=await db.get('keys',[project,epoch]);
  if(!record)throw Error('This browser does not hold the key for that project yet.');
  return openAtRest(connection.storageKey,record.sealed,keyContext(connection.org,project,epoch));
 }
 async function storeKey(project,epoch,key){
  await db.put('keys',{project,epoch,sealed:await sealAtRest(connection.storageKey,key,keyContext(connection.org,project,epoch))});
 }
 const hasKey=async(project,epoch)=>!!(await db.get('keys',[project,epoch]));
 async function putWraps(wraps){for(let i=0;i<wraps.length;i+=WRAP_BATCH){const part=wraps.slice(i,i+WRAP_BATCH);await authed(()=>client.putWraps(connection.org,part));}}
 /**
  * Wraps every key this browser holds to the entitled keys the service says still lack it: a
  * new member, a new device, a replaced recovery kit, the service key of a managed org. The
  * recipients are checked against this browser's own replay of the membership log.
  */
 async function fulfilPending(){
  const pending=await authed(()=>client.pending(connection.org)),identity=await deviceIdentity(),wraps=[];
  for(const {project,epoch,recipients} of pending){
   if(!(await hasKey(project,epoch)))continue;
   const entitled=new Set(wrapRecipients(connection.state,project)),key=await projectKey(project,epoch);
   try{for(const recipient of recipients)if(entitled.has(recipient))wraps.push(await wrapProjectKey({org:connection.org,project,epoch,recipient,projectKey:key},identity));}
   finally{key.fill(0);}
  }
  await putWraps(wraps);
  return wraps.length;
 }
 /** Opens every wrap addressed to this device that it does not hold yet (directory and projects). */
 async function collectKeys(){
  let opened=0;
  for(const raw of await authed(()=>client.wraps(connection.org))){
   const wrap=JSON.parse(raw);
   if(wrap.recipient!==connection.agreement.publicKey||await hasKey(wrap.project,wrap.epoch))continue;
   try{const result=await unwrapProjectKey(connection.state,raw,connection.agreement);try{await storeKey(result.project,result.epoch,result.key);opened++;}finally{result.key.fill(0);}}
   catch{
    // A wrap that does not open to the committed key is reported, so the service lists this
    // device as missing that key again and an honest member's app sends a good one.
    await authed(()=>client.reportWrap(connection.org,wrap.project,wrap.epoch,wrap.sender)).catch(()=>{});
   }
  }
  return opened;
 }
 async function exchangeKeys(){await collectKeys();await fulfilPending();}
 async function nameOf(subject,sealed){
  if(!sealed||!(await hasKey(connection.org,1)))return null;
  const key=await projectKey(connection.org,1);try{return openName(key,connection.org,subject,sealed);}finally{key.fill(0);}
 }

 /** A project's keys by epoch, opened as needed for one operation and wiped afterwards. Keys
  * this browser does not hold yet are collected from its wraps once. */
 function keyRing(project){
  const held=new Map();let collected=false;
  const ring={
   async get(epoch){
    if(held.has(epoch))return held.get(epoch);
    if(!(await hasKey(project,epoch))&&!collected){collected=true;await collectKeys().catch(()=>{});}
    if(!(await hasKey(project,epoch)))return null;
    const key=await projectKey(project,epoch);held.set(epoch,key);return key;
   },
   async need(epoch){
    const key=await ring.get(epoch);
    if(!key)throw Error('This browser does not hold the key for some of this project’s changes yet. It waits for another member’s app to share it.');
    return key;
   },
   wipe(){for(const key of held.values())key.fill(0);held.clear();},
  };
  return ring;
 }

 // --- Encrypted objects: binary assets and the history objects behind named versions

 const objectRange=(project,kind,hash)=>IDBKeyRange.bound([project,kind,hash,0],[project,kind,hash,Infinity]);
 /** Records objects from a checked blobref (or this browser's own uploads) as present on the service. */
 async function noteObjects(refs,project,store){
  for(const ref of refs)await store.put({project,kind:ref.kind,hash:ref.hash,epoch:ref.epoch,size:ref.size,ids:ref.ids});
 }
 /**
  * What this browser should upload before its next entry: the project's current assets and,
  * for every named version, its checkpoint manifest, update chunks and the assets it needs
  * (including files deleted since). Objects already on the service (under any epoch) are skipped.
  */
 async function wantedObjects(project,doc,read){
  const known=async(kind,hash)=>(await db.count('objects',objectRange(project,kind,hash)))>0;
  const wanted=[],assets=new Map(read.blobs.map(blob=>[blob.ref.hash,blob.bytes]));
  for(const ref of blobRefs(doc)){const bytes=assets.get(ref.hash)||knownBlob(doc,ref.hash);if(bytes&&!(await known('asset',ref.hash)))wanted.push({kind:'asset',hash:ref.hash,bytes});}
  const versions=[...doc.getMap('versions').values()].map(version=>version?.checkpointRef).filter(isHash);
  if(!versions.length)return wanted;
  const manifests=await storage.readStoredBytes({objects:versions}),chunks=new Set(),extra=new Set();
  for(const [hash,bytes] of manifests.objects){
   let manifest;try{manifest=JSON.parse(new TextDecoder().decode(bytes));}catch{continue;}
   if(!(await known('history',hash)))wanted.push({kind:'history',hash,bytes});
   for(const chunk of manifest.updateChunks||[])if(isHash(chunk?.hash)&&!(await known('history',chunk.hash)))chunks.add(chunk.hash);
   for(const asset of manifest.assets||[])if(isHash(asset?.hash)&&!assets.has(asset.hash)&&!(await known('asset',asset.hash)))extra.add(asset.hash);
  }
  const stored=await storage.readStoredBytes({objects:[...chunks],blobs:[...extra]});
  for(const [hash,bytes] of stored.objects)wanted.push({kind:'history',hash,bytes});
  for(const [hash,bytes] of stored.blobs)wanted.push({kind:'asset',hash,bytes});
  return wanted;
 }
 /** Seals and uploads objects under `epoch`; returns their blobref records. Identical retries are free. */
 async function uploadObjects(project,epoch,key,wanted){
  const refs=[];
  for(const object of wanted){
   const parts=sealObject({projectKey:key,org:connection.org,project,epoch,kind:object.kind,hash:object.hash,bytes:object.bytes});
   for(const part of parts)await authed(()=>client.putObject(project,part.id,epoch,part.body));
   refs.push({kind:object.kind,hash:object.hash,size:object.bytes.length,epoch,ids:parts.map(part=>part.id)});
  }
  return refs;
 }
 const refused=message=>Object.assign(Error(message),{refused:true});
 /**
  * Fetches, decrypts and checks one object. It is looked up under the epochs blobrefs named for
  * it, then under every epoch this browser holds a key for. Bytes that do not decrypt or do not
  * match their hash are refused (and fetched again on the next attempt), never installed.
  */
 async function fetchObject(project,ring,kind,hash,size=null){
  const announced=(await db.getAll('objects',objectRange(project,kind,hash))).sort((a,b)=>b.epoch-a.epoch);
  const epochs=[...new Set([...announced.map(o=>o.epoch),...Array.from({length:connection.state.projects[project]?.epoch||0},(_,i)=>i+1).reverse()])];
  for(const epoch of epochs){
   const key=await ring.get(epoch);if(!key)continue;
   const record=announced.find(o=>o.epoch===epoch),length=record?.size??size,parts=length===null?1:objectParts(length),pieces=[];
   for(let part=0;part<parts;part++){
    const id=record?.ids?.[part]??org_object_id(key,kind,hash,part,parts),body=await authed(()=>client.getObject(project,id));
    if(!body){if(part===0)break;throw Error('Part of a file is missing on the service. It is fetched again later.');}
    try{pieces.push(openObjectPart({projectKey:key,org:connection.org,project,epoch,kind,hash,part,parts,body}));}
    catch(error){throw refused(error.message+' It was refused and is fetched again later.');}
   }
   if(pieces.length!==parts)continue;
   const bytes=new Uint8Array(pieces.reduce((n,p)=>n+p.length,0));let at=0;for(const piece of pieces){bytes.set(piece,at);at+=piece.length;}
   if(blob_hash(bytes)!==hash||(size!==null&&bytes.length!==size))throw refused('A file from the service does not match what the project refers to. It was refused and is fetched again later.');
   return bytes;
  }
  throw Error('A file this project refers to is not on the service yet. It is fetched again later.');
 }
 /** Installs into `doc` every asset it refers to that this browser does not store yet. */
 async function fetchAssets(project,ring,doc){
  const refs=blobRefs(doc).filter(ref=>!knownBlob(doc,ref.hash));
  if(!refs.length)return 0;
  const present=await storage.readStoredBytes({blobs:refs.map(ref=>ref.hash)});
  let fetched=0;
  for(const ref of refs){
   const local=present.blobs.get(ref.hash);
   if(local){installBlob(doc,ref,local);continue;}
   const bytes=await fetchObject(project,ring,'asset',ref.hash,ref.size);verifyBlob(ref,bytes);installBlob(doc,ref,bytes);fetched++;
  }
  return fetched;
 }
 /**
  * Downloads what named versions need and this browser lacks: the checkpoint manifest, its
  * update chunks and its assets, installed through the history store and pinned to the version,
  * so an old version restores here too. A version whose objects cannot be fetched yet stays
  * listed as unavailable and is tried again on the next sync.
  */
 async function hydrateHistory(localId,project,ring,doc){
  const versions=[...doc.getMap('versions').values()].filter(version=>isHash(version?.checkpointRef));
  if(!versions.length)return 0;
  const stored=await storage.readStoredBytes({objects:versions.map(v=>v.checkpointRef)});let missing=0;
  for(const version of versions){
   if(stored.objects.has(version.checkpointRef))continue;
   try{
    const bytes=await fetchObject(project,ring,'history',version.checkpointRef),text=new TextDecoder('utf-8',{fatal:true}).decode(bytes);
    try{history_validate_manifest(text);}catch{throw refused('A named version’s description from the service is invalid. It was refused.');}
    const manifest=JSON.parse(text),objects=[{hash:version.checkpointRef,bytes}],blobs=[];
    const have=await storage.readStoredBytes({objects:manifest.updateChunks.map(c=>c.hash),blobs:manifest.assets.map(a=>a.hash)});
    for(const chunk of manifest.updateChunks)objects.push({hash:chunk.hash,bytes:have.objects.get(chunk.hash)||await fetchObject(project,ring,'history',chunk.hash,chunk.size)});
    for(const asset of manifest.assets)blobs.push({hash:asset.hash,bytes:have.blobs.get(asset.hash)||await fetchObject(project,ring,'asset',asset.hash,asset.size)});
    const read=await storage.readCommittedProject(localId);
    await storage.installRemoteHistory(localId,{objects,blobs,pins:objects.map(o=>({hash:o.hash,pin:'checkpoint:'+manifest.checkpointId})),
     catalog:[{checkpointId:manifest.checkpointId,checkpointRef:version.checkpointRef,sequence:read.head?.sequence??0,reason:'named'}]});
   }catch{missing++;}
  }
  return missing;
 }

 const withLock=(name,task)=>locks?locks.request(name,task):task();
 // Serialise work per project inside this tab, and across tabs with a Web Lock.
 function queue(localId,task){
  const next=(queues.get(localId)||Promise.resolve()).then(()=>withLock(`scribyra:org-backup:${localId}`,task));
  queues.set(localId,next.catch(()=>{}));return next;
 }
 function schedule(localId,delay=1500){
  if(closed)return;clearTimeout(timers.get(localId));
  timers.set(localId,setTimeout(()=>{timers.delete(localId);void push(localId).catch(()=>{});},delay));
 }
 function retry(localId,error){
  const n=attempts.get(localId)||0;attempts.set(localId,n+1);
  setStatus(localId,'waiting',error instanceof ServiceError&&error.status===507?QUOTA_TEXT:error.message);schedule(localId,RETRY[Math.min(n,RETRY.length-1)]);
 }
 function role(project){
  const state=connection.state;
  return state.persons[connection.person]?.state==='active'?state.projects[project]?.members[connection.person]||null:null;
 }

 // --- Logs

 /**
  * Checks one log entry against the chain and the membership log without decrypting it:
  * signature, organisation, project, epoch, an editor's device, and that each device's client
  * sequence continues without gaps or replays. Returns the next cursor.
  */
 async function verifyItem(cursor,item){
  const {header,headerRaw,ciphertext}=verifyEntryBody(item.body),hash=entryHash(headerRaw,ciphertext),chain=chainNext(cursor.chain,hash);
  if(item.seq!==cursor.seq+1||item.chain!==chain)throw fault('The service’s log does not match what this browser verified. Sync paused.');
  // The device must have written as an editor: current members, and also devices and editors
  // since removed (their earlier entries stay valid). A state that may be behind is refreshed once.
  const editorEver=state=>{const p=state.projects[cursor.project],person=state.devices[header.device]?.person??state.formerDevices?.[header.device];
   return!!p&&header.epoch>=1&&header.epoch<=p.epoch&&!!person&&(p.members[person]==='editor'||(state.formerEditors?.[cursor.project]||[]).includes(person));};
  let state=connection.state;
  if(!editorEver(state))state=await refreshMembership();
  if(header.org!==connection.org||header.project!==cursor.project||!editorEver(state))
   throw fault('A change was not written by an editor’s device. Sync paused.');
  if(header.clientSeq!==(cursor.devices[header.device]||0)+1)throw fault('A change was replayed or is missing. Sync paused.');
  return{...cursor,seq:item.seq,chain,devices:{...cursor.devices,[header.device]:header.clientSeq},header,hash};
 }
 /** Reads the log from `cursor` to the head, verifying every entry; `each` sees each verified entry. */
 async function readVerified(cursor,each=()=>{}){
  for await(const item of await authed(async()=>client.log(cursor.project,cursor.seq))){
   cursor=await verifyItem(cursor,item);await each(item,cursor.header,cursor.hash);
   // Large entries take a while to decrypt: let the page (and its connections) breathe.
   await new Promise(resolve=>setTimeout(resolve,0));
  }
  return cursor;
 }
 function openChecked(item,header,key,lineage){
  const opened=openEntry(item.body,key);
  if(opened.meta.person!==(connection.state.devices[header.device]?.person??connection.state.formerDevices?.[header.device]))throw fault('A change names another author than its device. Sync paused.');
  if(opened.meta.schema>SCHEMA_VERSION)throw fault('This project was updated by a newer Scribyra. Update Scribyra to see the latest changes.');
  if(lineage&&opened.meta.lineage!==lineage)throw fault('A project’s changes disagree about its identity. Sync paused.');
  return opened;
 }
 /**
  * Rebuilds what the service holds for a project from its whole log: the verified cursor,
  * each device's last client sequence, and the Yjs state (so only the difference is sent).
  */
 async function serverState(link){
  const ring=keyRing(link.project),doc=new Y.Doc();
  try{
   const cursor=await readVerified({project:link.project,seq:0,chain:link.project,devices:{}},async(item,header)=>{const opened=openChecked(item,header,await ring.need(header.epoch),link.lineage);if(header.kind==='update')Y.applyUpdate(doc,opened.payload);});
   return{seq:cursor.seq,chain:cursor.chain,devices:cursor.devices,vector:Y.encodeStateVector(doc)};
  }finally{ring.wipe();doc.destroy();}
 }
 /**
  * The service lost entries this browser saw acknowledged (it was restored from an older
  * backup). Everything this browser has is then uploaded again as new entries.
  */
 async function recoverRollback(link){
  const server=await serverState(link);
  if(server.seq>=link.seq)throw fault('The service’s log does not match what this browser verified. Sync paused.');
  const tx=db.transaction(['links','outbox'],'readwrite');
  for(const key of await tx.objectStore('outbox').getAllKeys(IDBKeyRange.bound([link.localId,0],[link.localId,Infinity])))await tx.objectStore('outbox').delete(key);
  const current={...await tx.objectStore('links').get(link.localId),seq:server.seq,chain:server.chain,devices:server.devices,vector:server.vector,clientSeq:server.devices[connection.device]||0,pushedSequence:-1};
  await tx.objectStore('links').put(current);await tx.done;
  setStatus(link.localId,'backing-up','The service lost recent changes. Re-uploading from this device.');
  return current;
 }
 /**
  * Catch-up: reads entries after the link's cursor, verifies them, and merges other devices'
  * changes into the committed local project through the merged-head save path, then tells an
  * open editor. The server vector grows by what was received, so it is never uploaded back.
  * `own` (after an append others raced) is this device's acknowledged entry, checked in place;
  * `pushed` is the local sequence that entry carried.
  */
 async function pull(link,{own,pushed=link.pushedSequence}={}){
  const ring=keyRing(link.project),payloads=[],announced=[];
  let cursor={project:link.project,seq:link.seq,chain:link.chain,devices:link.devices||{}},vector=link.vector,ownSeen=!own,received=0,pushedSequence=pushed;
  try{
   cursor=await readVerified(cursor,async(item,header,hash)=>{
    if(header.device===connection.device){
     if(own&&item.seq===own.seq){if(hash!==own.hash||item.chain!==own.chain)throw fault('The service acknowledged a change this browser did not send. Sync paused.');ownSeen=true;}
     return;
    }
    const opened=openChecked(item,header,await ring.need(header.epoch),link.lineage);
    if(header.kind==='blobref'){announced.push(...await checkedBlobref(ring,opened.payload));return;}
    payloads.push(opened.payload);
    if((received+=opened.payload.byteLength)>MAX_RETAINED_BYTES)throw fault('Changes from other devices exceed the 96 MiB limit. Sync paused.');
    vector=mergeVectors(vector,Y.encodeStateVectorFromUpdate(opened.payload));
   });
   if(!ownSeen)throw fault('The service acknowledged a log position this browser cannot verify. Sync paused.');
   // Objects announced by others are known before their assets are fetched.
   if(announced.length){const tx=db.transaction('objects','readwrite');await noteObjects(announced,link.project,tx.store);await tx.done;}
   if(payloads.length){
    const read=await storage.readCommittedProject(link.localId);
    if(read.kind==='deleted'||read.kind==='missing')throw fault('This project is no longer on this device. Its copy on the service is kept.');
    const doc=new Y.Doc();
    try{
     Y.applyUpdate(doc,read.update);
     if(doc.getMap('meta').get('lineageId')!==link.lineage)throw fault('This project’s identity changed on this device. Sync paused.');
     for(const payload of payloads)Y.applyUpdate(doc,payload);
     if(doc.store.pendingStructs||doc.store.pendingDs)throw fault('A change from another device is incomplete. Sync paused.');
     // Images and other files the merged project refers to come from the service, decrypted and
     // checked, before it is validated and saved (nothing is saved, and the cursor stays, until
     // they all arrive).
     await fetchAssets(link.project,ring,doc);
     validateRetainedState(doc);validateReplica(doc);
     const saved=await storage.saveProject(link.localId,doc);
     // Nothing local was waiting before the merge: the merged state is all on the service.
     if(read.head.sequence===pushed)pushedSequence=saved.sequence;
    }finally{doc.destroy();}
   }
  }finally{ring.wipe();}
  const current={...await db.get('links',link.localId),seq:cursor.seq,chain:cursor.chain,devices:cursor.devices,vector,pushedSequence};
  await db.put('links',current);
  if(payloads.length)onRemote(link.localId);
  return current;
 }
 /** A blobref from another device, checked against the keys this browser holds. */
 async function checkedBlobref(ring,payload){
  let epochs;try{epochs=[...new Set(JSON.parse(new TextDecoder().decode(payload)).objects.map(o=>o.epoch))];}catch{throw fault('A list of files from another device is malformed. Sync paused.');}
  const keys={};for(const epoch of epochs.filter(e=>Number.isSafeInteger(e)&&e>0)){const key=await ring.get(epoch);if(key)keys[epoch]=key;}
  try{return checkBlobref(payload,keys).objects;}catch(error){throw fault(`A list of files from another device is invalid (${error.message||error}). Sync paused.`);}
 }
 /** Downloads the objects named versions need, quietly: a version that cannot be completed yet stays unavailable. */
 async function syncHistory(link){
  const read=await storage.readCommittedProject(link.localId);if(read.kind!=='updated')return 0;
  const ring=keyRing(link.project),doc=new Y.Doc();
  try{Y.applyUpdate(doc,read.update);return await hydrateHistory(link.localId,link.project,ring,doc);}
  finally{ring.wipe();doc.destroy();}
 }
 async function send(link,entry){
  let ack;
  try{ack=await authed(()=>client.append(link.project,entry.body));}
  catch(error){
   if(error instanceof ServiceError&&error.status===409){
    if(/client sequence/.test(error.message))return{rollback:true};
    if(/epoch/.test(error.message))throw fault('This project’s key changed. Sync paused until this version of Scribyra can re-encrypt.');
    throw fault('The service holds a different change at this position. Sync paused for this project.');
   }
   if(error instanceof ServiceError&&error.status===403)throw Object.assign(fault('You can no longer change this project on the service. Your changes stay on this device.'),{forbidden:true});
   throw error;
  }
  if(ack.seq<=link.seq)throw fault('The service acknowledged a log position this browser already verified. Sync paused.');
  const hash=entryHash(entry.headerRaw,entry.ciphertext);
  let current;
  if(ack.seq===link.seq+1){
   const chain=chainNext(link.chain,hash);
   if(ack.chain!==chain)throw fault('The service acknowledged a log position this browser cannot verify. Sync paused.');
   current={...await db.get('links',link.localId),seq:ack.seq,chain,devices:{...link.devices,[connection.device]:entry.clientSeq},pushedSequence:entry.sequence??link.pushedSequence};
  }else{
   // Other devices appended first: verify and merge them, and this entry in its place.
   current=await pull(link,{own:{seq:ack.seq,hash,chain:ack.chain},pushed:entry.sequence??link.pushedSequence});
  }
  const tx=db.transaction(['links','outbox'],'readwrite');
  Object.assign(current,{vector:mergeVectors(current.vector,entry.vector||current.vector),acked:entry.clientSeq,clientSeq:Math.max(current.clientSeq||0,entry.clientSeq)});
  await tx.objectStore('links').put(current);await tx.objectStore('outbox').delete([link.localId,entry.clientSeq]);await tx.done;
  return current;
 }
 /** Creates the project on the service once, even across retries and crashes (no orphans). */
 async function ensureCreated(link){
  if(link.created!==false)return link;
  await refreshMembership();
  if(!connection.state.projects[link.project]){
   const key=await projectKey(link.project,1);
   try{await post('project.create',()=>({project:link.project,epoch:1,keyCommit:link.keyCommit,name:sealProjectName(key,connection.org,link.project,link.name)}));}
   finally{key.fill(0);}
  }else if(connection.state.projects[link.project].creator!==connection.person)throw fault('Another person created a project with this identity. Backup paused.');
  await fulfilPending();
  const current={...link,created:true};await db.put('links',current);return current;
 }
 async function pushNow(localId){
  await load();let link=await db.get('links',localId);if(!link)return;
  if(me()?.state==='removed'){setStatus(localId,'removed','You were removed from the organisation. This project stays on this device.');return;}
  setStatus(localId,'backing-up');
  link=await ensureCreated(link);
  try{link=await pull(link);}
  catch(error){if(!error.rollback)throw error;link=await recoverRollback(link);}
  const myRole=role(link.project);
  if(myRole!=='editor'){attempts.delete(localId);setStatus(localId,myRole?'read-only':'removed',myRole?`Your role on this project is ${myRole}: what you change stays on this device.`:'This project is no longer shared with you. It stays on this device.');return;}
  for(const entry of (await db.getAll('outbox')).filter(e=>e.localId===localId).sort((a,b)=>a.clientSeq-b.clientSeq)){
   const sent=await send(link,entry);
   if(sent.rollback){link=await recoverRollback(link);break;}
   link=sent;
  }
  const read=await storage.readCommittedProject(localId);
  if(read.kind==='deleted'||read.kind==='missing'){setStatus(localId,'paused','This project is no longer on this device. Its copy on the service is kept.');return;}
  if(read.head.sequence!==link.pushedSequence){
   const doc=new Y.Doc(),epoch=connection.state.projects[link.project].epoch,ring=keyRing(link.project);
   try{
    Y.applyUpdate(doc,read.update);
    const meta=doc.getMap('meta');
    if(meta.get('lineageId')!==link.lineage){setStatus(localId,'paused','This project’s identity changed. Back it up again as a new project.');return;}
    const payload=Y.encodeStateAsUpdate(doc,link.vector);
    if(payload.byteLength>MAX_ENTRY_BYTES){setStatus(localId,'unsupported','This change is too large to back up in one piece yet.');return;}
    // New content is sealed only under the project's current epoch.
    const key=await ring.need(epoch),identity=await deviceIdentity();
    // Files first: every object the update refers to is on the service before the blobref that
    // lists it, and the blobref before the update (one device's entries keep their order).
    const refs=await uploadObjects(link.project,epoch,key,await wantedObjects(link.project,doc,read));
    const common={projectKey:key,org:connection.org,project:link.project,epoch,lineage:link.lineage,schema:meta.get('schemaVersion'),person:connection.person};
    let clientSeq=link.clientSeq;const entries=[];
    for(let i=0;i<refs.length;i+=MAX_BLOBREF){
     const sealed=await sealEntry({...common,clientSeq:++clientSeq,kind:'blobref',payload:blobrefPayload(refs.slice(i,i+MAX_BLOBREF))},identity);
     entries.push({localId,clientSeq,kind:'blobref',body:sealed.body,headerRaw:sealed.headerRaw,ciphertext:sealed.ciphertext});
    }
    const sealed=await sealEntry({...common,clientSeq:++clientSeq,payload},identity);
    entries.push({localId,clientSeq,kind:'update',body:sealed.body,headerRaw:sealed.headerRaw,ciphertext:sealed.ciphertext,vector:Y.encodeStateVector(doc),sequence:read.head.sequence});
    // The outbox entries and their sequence numbers are durable before anything is sent,
    // so a retry after a crash resends identical bytes and never reuses a number.
    const tx=db.transaction(['links','outbox','objects'],'readwrite');
    for(const entry of entries)await tx.objectStore('outbox').put(entry);
    await noteObjects(refs,link.project,tx.objectStore('objects'));
    await tx.objectStore('links').put({...link,clientSeq});await tx.done;
    let current={...link,clientSeq};
    for(const entry of entries){
     const sent=await send(current,entry);
     if(sent.rollback){await recoverRollback(link);throw Error('The service lost recent changes. Re-uploading from this device.');}
     current=sent;
    }
   }finally{ring.wipe();doc.destroy();}
  }
  // Named versions from other devices bring their history objects along when they can.
  await syncHistory(link).catch(()=>{});
  attempts.delete(localId);setStatus(localId,live?'synced':'backed-up');
 }
 async function push(localId){
  return queue(localId,async()=>{
   try{await pushNow(localId);}
   catch(error){
    if(ssoNeeded(error)){setStatus(localId,'waiting','Sign in with your organisation again to keep syncing.');return;}
    if(error.fatal)setStatus(localId,error.forbidden?'read-only':'paused',error.message);else retry(localId,error);throw error;
   }
  });
 }
 /** Rebuilds one project from its log into a new local project. Nothing is saved unless it all verifies. */
 async function restoreProject(project){
  const ring=keyRing(project),doc=new Y.Doc(),announced=[];
  let lineage=null;
  try{
   const cursor=await readVerified({project,seq:0,chain:project,devices:{}},async(item,header)=>{
    const opened=openChecked(item,header,await ring.need(header.epoch),lineage);lineage=opened.meta.lineage;
    if(header.kind==='blobref')announced.push(...await checkedBlobref(ring,opened.payload));else Y.applyUpdate(doc,opened.payload);
   });
   if(!cursor.seq)return null;
   if(doc.store.pendingStructs||doc.store.pendingDs)throw Error('A project’s copy on the service is incomplete. Nothing was restored for it.');
   if(doc.getMap('meta').get('lineageId')!==lineage)throw Error('A project’s copy on the service disagrees about its identity.');
   validateProjectState(doc);
   if(announced.length){const tx=db.transaction('objects','readwrite');await noteObjects(announced,project,tx.store);await tx.done;}
   // Every image and file the project refers to, decrypted and checked, before anything is saved.
   await fetchAssets(project,ring,doc);
   const localId=crypto.randomUUID(),saved=await storage.saveProject(localId,doc);
   const link={localId,project,epoch:connection.state.projects[project]?.epoch||1,lineage,created:true,seq:cursor.seq,chain:cursor.chain,devices:cursor.devices,clientSeq:cursor.devices[connection.device]||0,acked:0,vector:Y.encodeStateVector(doc),pushedSequence:saved.sequence};
   await db.put('links',link);
   // Named versions: their checkpoint objects and the files they need (also ones deleted since).
   const missing=await hydrateHistory(localId,project,ring,doc).catch(()=>1);
   setStatus(localId,role(project)==='editor'?'backed-up':'read-only',missing?'Some named versions are not available on this device yet.':'');
   return{localId,name:doc.getMap('meta').get('name')||'Untitled project'};
  }finally{ring.wipe();doc.destroy();}
 }
 /** Projects this browser holds keys for, can open, and has not downloaded yet. */
 async function unrestored(){
  const linked=new Set((await db.getAll('links')).map(l=>l.project));
  const seen=new Set();
  return(await db.getAll('keys')).filter(k=>k.project!==connection.org&&!linked.has(k.project)&&role(k.project)&&!seen.has(k.project)&&seen.add(k.project));
 }
 async function restoreRemaining(){
  const restored=[],failures=[];
  for(const record of await unrestored()){
   try{const result=await restoreProject(record.project);if(result)restored.push(result);}
   catch(error){failures.push(error.message);}
  }
  return{restored,failures};
 }
 function watch(){
  unwatch??=watchStorage(hint=>{
   if(closed||!hint||hint.kind==='rescan')return;
   void db?.get('links',hint.projectId).then(link=>{if(link)schedule(hint.projectId);}).catch(()=>{});
  });
  // Changes made offline go out as soon as the browser is back online.
  if(!onlineHook&&globalThis.addEventListener){onlineHook=()=>{if(closed)return;attempts.clear();void db?.getAll('links').then(links=>{for(const link of links)schedule(link.localId,100);}).catch(()=>{});};globalThis.addEventListener('online',onlineHook);}
 }
 /**
  * Follows the service with a long poll: when the membership log moves, keys are exchanged;
  * when a project's head moves past this browser's cursor, it is synced. The notice is only a
  * hint — a missed one is repaired by the next poll and by every push's catch-up.
  */
 function follow(){
  if(following||closed||!connection?.ready)return;
  following=(async()=>{
   let since,failures=0;
   while(!closed&&connection?.ready){
    try{
     polling=new AbortController();
     const heads=await authed(()=>client.heads(connection.org,since,since===undefined?0:25,polling.signal));
     if(closed)break;
     const moved=since!==undefined&&heads.version!==since;
     failures=0;since=heads.version;live=true;
     if(heads.events>connection.state.count){await refreshMembership();await exchangeKeys().catch(()=>{});}
     // Something moved: keys may have arrived for this device, or others may be waiting for them.
     else if(moved){await exchangeKeys().catch(()=>{});onMembership();}
     for(const link of await db.getAll('links'))if((heads.heads[link.project]??0)>link.seq)schedule(link.localId,50);
    }catch(error){
     if(closed)break;
     live=false;failures++;
     if(ssoNeeded(error)){onMembership();await new Promise(resolve=>setTimeout(resolve,30000));continue;}
     // Back off, but wake at once when the browser comes back online.
     await new Promise(resolve=>{const wake=()=>{clearTimeout(timer);globalThis.removeEventListener?.('online',wake);resolve();};const timer=setTimeout(wake,Math.min(30000,1000*2**Math.min(failures,5)));globalThis.addEventListener?.('online',wake);});
    }
   }
  })().finally(()=>{following=null;live=false;});
 }
 async function adopt(state){connection.state=state;connection.ready=true;await saveConnection();markConnected(true);watch();follow();onMembership();}
 /**
  * A new recovery kit. The kit is kept (sealed) in this browser before the service learns of
  * it, so a lost answer or a closed dialog never loses a kit that is already active.
  */
 async function newRecovery(){
  const code=newRecoveryCode(),secrets=recoverySecrets(code.bytes);
  try{
   const {org,person}=connection;
   const text=formatKit({service:connection.service,org,genesis:connection.state.genesis,code:code.text});
   connection.pendingKit={signing:secrets.signingPublic,sealed:await sealAtRest(connection.storageKey,new TextEncoder().encode(text),kitContext(org))};
   await saveConnection();
   try{await post('recovery.set',prev=>({person,signing:secrets.signingPublic,agreement:secrets.agreementPublic,proof:recoveryProof({org,prev,person,signing:secrets.signingPublic,agreement:secrets.agreementPublic},secrets.signing)}));}
   catch(error){
    // The event may have been committed although the answer was lost.
    await refreshMembership().catch(()=>{});
    if(me()?.recoverySigning!==secrets.signingPublic){delete connection.pendingKit;await saveConnection();throw error;}
   }
   pendingKitText=text;
   // Every key this browser holds becomes restorable with the new kit; retried on start too.
   await fulfilPending().catch(()=>{});
   return text;
  }finally{code.bytes.fill(0);secrets.signing.fill(0);secrets.agreement.fill(0);}
 }
 async function pendingKit(){
  if(pendingKitText)return pendingKitText;
  const pending=connection?.pendingKit;if(!pending)return'';
  if(me()?.recoverySigning!==pending.signing){delete connection.pendingKit;await saveConnection();return'';}
  return pendingKitText=new TextDecoder().decode(await openAtRest(connection.storageKey,pending.sealed,kitContext(connection.org)));
 }
 async function withCreatedKeys(){const identity=await profileIdentity({create:true});setDirectKeyPresent(true);return identity;}
 async function freshConnection(service,org,person,identity,extra={}){
  const storageKey=await newStorageKey(),agreement=await newAgreementKey(await mustSealAgreement()?{sealWith:storageKey,context:agreementContext(org,identity.publicKey)}:{});
  connection={service,org,person,device:identity.publicKey,agreement,storageKey,state:null,ready:false,...extra};
  await saveConnection();if(extra.joined||extra.genesisExpected)markJoining();return connection;
 }
 /**
  * After joining (or being linked): wait until the service lets this device in, read and verify
  * the whole membership log from the genesis the link named, and become connected.
  */
 async function admit(genesis,{sso}={}){
  client.forget();
  const identity=await deviceIdentity();
  try{await client.signIn(connection.org,identity,{sso:sso||connection.ssoToken});}
  catch(error){if(error instanceof ServiceError&&error.status===403){connection.waiting=true;await saveConnection();return false;}throw error;}
  const state=applyEvents(null,connection.org,await client.events(connection.org,0));
  if(state.genesis!==genesis)throw Error('This service’s organisation does not match the link you used.');
  if(state.devices[connection.device]?.person!==connection.person)throw Error('This browser was not added to the organisation.');
  delete connection.waiting;delete connection.linkCode;
  // A directory key that came with an invitation must be the one the genesis committed to.
  connection.state=state;
  if(await hasKey(connection.org,1)){const key=await projectKey(connection.org,1);try{if(keyCommit(key)!==state.directoryCommit)await db.delete('keys',[connection.org,1]);}finally{key.fill(0);}}
  await adopt(state);
  await exchangeKeys().catch(()=>{});
  return true;
 }
 /** The SSO login this tab finished, if it belongs to `org` on `service`. */
 function ssoLogin(service,org){const login=readSession(SSO_LOGIN);return login&&login.service===service&&login.org===org&&login.expires*1000>Date.now()?login:null;}

 const api={
  get connected(){return !!connection?.ready;},
  get info(){
   if(!connection?.ready)return null;
   const state=connection.state,person=me();
   return{service:connection.service,org:connection.org,mode:state.mode,adminRead:state.adminRead,person:connection.person,role:person?.role,state:person?.state,ssoNeeded:!!connection.ssoNeeded};
  },
  /** Joined or linked, and waiting for an admin or another device to let this browser in. */
  get waiting(){return !!(connection&&!connection.ready&&connection.joined);},
  get linkCode(){return connection&&!connection.ready?connection.linkCode||null:null;},
  /** Connected, but this person has no recovery kit yet (a new member). */
  get needsKit(){return !!connection?.ready&&!me()?.recoverySigning;},
  status:localId=>statuses.get(localId),
  /** Starts syncing linked projects if this browser was connected before (or resumes a waiting join). */
  async start(){
   if(orgJoining()&&!orgConnected()){
    const stored=await readConnection();
    if(stored&&!stored.ready&&stored.joined){connection=stored;client=orgClient(stored.service,{fetchImpl});}
    return false;
   }
   if(!orgConnected())return false;
   await load();watch();
   await refreshMembership().then(exchangeKeys).catch(()=>{});
   for(const link of await db.getAll('links'))schedule(link.localId,500);
   follow();
   return true;
  },
  async links(){if(!connection&&!orgConnected())return[];await open();return db.getAll('links');},
  /** The recovery kit made last, until the person confirms they saved it. */
  pendingKit,
  async confirmKit(){pendingKitText='';if(connection?.pendingKit){delete connection.pendingKit;await saveConnection();}},
  /** What an operator's setup code offers: its service, and whether organisation-managed mode is available. */
  async setupInfo(setupText){const setup=parseSetupCode(setupText);try{const info=await orgClient(setup.service,{fetchImpl}).info(setup.org);return{service:setup.service,managed:!!info.serviceKey,used:info.genesis};}finally{setup.secret.fill(0);}},
  /**
   * Creates the organisation an operator's setup code stands for: its name, encryption mode and
   * admin read access, the directory key, and a recovery kit for its owner.
   */
  async connect(setupText,{name='Personal',ownerName='Owner',mode='e2ee',adminRead=true}={}){
   const setup=parseSetupCode(setupText);
   try{
    if(orgConnected())throw Error('This browser is already connected to a service.');
    const identity=await withCreatedKeys();await open();
    client=orgClient(setup.service,{fetchImpl});
    // A previous attempt for this organisation left its keys and genesis here: resume it.
    const previous=await readConnection();
    let raw,state;
    if(previous&&!previous.ready&&previous.org===setup.org&&previous.device===identity.publicKey&&previous.genesis){connection=previous;raw=previous.genesis;state=previous.pendingState;}
    else{
     const info=await client.info(setup.org);
     if(info.genesis)throw Error('This setup code was already used. Ask the operator for a new one, or restore with your recovery kit.');
     const directory=randomBytes(32);
     try{
      await freshConnection(setup.service,setup.org,null,identity);
      const body=genesisBody({org:setup.org,secret:setup.secret,device:identity.publicKey,agreement:connection.agreement.publicKey,adminRead,mode,serviceKey:info.serviceKey,directoryKey:directory,name,ownerName});
      raw=await signEvent({org:setup.org,prev:setup.org,type:'genesis',body},identity);
      state=applyEvents(null,setup.org,[raw],enrolPublic(setup.secret));
      Object.assign(connection,{person:body.person,genesis:raw,pendingState:state});
      await storeKey(setup.org,1,directory);await saveConnection();
     }finally{directory.fill(0);}
    }
    try{await client.postEvent(setup.org,raw,{auth:false});}
    catch(error){
     if(!(error instanceof ServiceError&&(error.status===409||error.status===401)))throw error;
     // Already committed by an attempt whose answer was lost? Then the genesis is ours.
     let events=[];
     try{await client.signIn(setup.org,identity);events=await client.events(setup.org,0);}catch{}
     if(events[0]!==raw)throw Error('This setup code was already used. Ask the operator for a new one, or restore with your recovery kit.');
     state=applyEvents(null,setup.org,events,enrolPublic(setup.secret));
    }
    delete connection.genesis;delete connection.pendingState;await adopt(state);
    await fulfilPending().catch(()=>{});
    return newRecovery();
   }finally{setup.secret.fill(0);}
  },
  /** Replaces the recovery kit; the previous kit stops working on this service. */
  async replaceRecoveryKit(){await load();await refreshMembership();return newRecovery();},
  /** Starts backing up (and syncing) one local project. */
  async backUp(localId){
   await load();
   if(await db.get('links',localId))return push(localId);
   const read=await storage.readCommittedProject(localId);
   if(read.kind!=='updated')throw Error('Open or save the project on this device first.');
   const doc=new Y.Doc();let lineage,name;
   try{Y.applyUpdate(doc,read.update);lineage=doc.getMap('meta').get('lineageId');name=doc.getMap('meta').get('name');
}
   finally{doc.destroy();}
   if(typeof lineage!=='string')throw Error('This project has no identity yet. Save it once, then try again.');
   // The project's identity and key are durable here before the service hears of them.
   const project=hex(randomBytes(32)),{key,commit}=newProjectKey();
   try{await storeKey(project,1,key);}finally{key.fill(0);}
   await db.put('links',{localId,project,epoch:1,keyCommit:commit,name:name||'Untitled project',lineage,created:false,seq:0,chain:project,devices:{},clientSeq:0,acked:0,vector:new Uint8Array([0]),pushedSequence:-1});
   return push(localId);
  },
  /** A fresh browser: enrol it with the recovery kit and restore every backed-up project. */
  async restore(kitText){
   if(orgConnected())throw Error('This browser is already connected to a service.');
   const kit=parseKit(kitText),secrets=recoverySecrets(kit.code);
   try{
    client=orgClient(kit.service,{fetchImpl});
    try{await client.signIn(kit.org,secrets.signing);}
    catch(error){if(error instanceof ServiceError&&(error.status===403||error.status===404))throw Error('This recovery kit is not active on this service: it was replaced by a newer one, or belongs to another organisation.');throw error;}
    let state=applyEvents(null,kit.org,await client.events(kit.org,0));
    if(state.genesis!==kit.genesis)throw Error('This service’s organisation does not match your recovery kit.');
    const person=Object.entries(state.persons).find(([,p])=>p.recoverySigning===secrets.signingPublic)?.[0];
    if(!person)throw Error('This recovery kit was replaced by a newer one. Use the newest kit.');
    const identity=await withCreatedKeys(),known=state.devices[identity.publicKey];
    if(known&&known.person!==person)throw Error('This browser already belongs to someone else in this organisation.');
    await open();
    // Resume an enrolment whose answer was lost, or enrol (or re-key) this browser's device.
    const previous=await readConnection();
    if(previous&&!previous.ready&&previous.org===kit.org&&previous.device===identity.publicKey&&state.devices[identity.publicKey]?.agreement===previous.agreement.publicKey)connection={...previous,state};
    else{
     await freshConnection(kit.service,kit.org,person,identity);
     const proof=await deviceProof({org:kit.org,prev:state.head,person,device:identity.publicKey,agreement:connection.agreement.publicKey},identity);
     const raw=await signEvent({org:kit.org,prev:state.head,type:'device.add',body:{person,device:identity.publicKey,agreement:connection.agreement.publicKey,proof}},secrets.signing);
     state=applyEvents(state,kit.org,[raw]);await client.postEvent(kit.org,raw);
    }
    client.forget();
    connection.state=state;
    // Every key the kit can open is kept first, so restoring can be resumed later without the kit.
    const failures=[];let opened=0;
    for(const raw of await authed(()=>client.wraps(kit.org))){
     const wrap=JSON.parse(raw);if(wrap.recipient!==secrets.agreementPublic)continue;
     let result;
     try{result=await unwrapProjectKey(state,raw,secrets.agreement);}catch(error){failures.push(error.message);continue;}
     try{if(!(await hasKey(result.project,result.epoch)))await storeKey(result.project,result.epoch,result.key);opened++;}
     finally{result.key.fill(0);}
    }
    await adopt(state);
    await fulfilPending().catch(()=>{});
    const held=new Set((await db.getAll('keys')).map(k=>k.project));
    const missing=Object.entries(state.projects).filter(([id,p])=>p.members[person]&&!held.has(id)).length;
    if(missing)failures.push(`${missing===1?'1 project has':missing+' projects have'} no key for this recovery kit. Open Scribyra on a device that has ${missing===1?'it':'them'} once, then restore remaining projects here.`);
    const result=await restoreRemaining();
    return{restored:result.restored,failures:[...failures,...result.failures],opened};
   }finally{kit.code.fill(0);secrets.signing.fill(0);secrets.agreement.fill(0);}
  },
  /** Projects this browser can download but has not yet. */
  async unrestored(){if(!orgConnected())return[];await load();return unrestored();},
  async restoreRemaining(){await load();await refreshMembership();await collectKeys().catch(()=>{});return restoreRemaining();},
  async download(project){await load();await refreshMembership();await collectKeys().catch(()=>{});if(!connection.state.projects[project])throw Error('Unknown project.');return restoreProject(project);},

  // --- Organisation: names, members, projects

  async orgName(){return connection?.ready?nameOf('org',connection.state.name):null;},
  async members(){
   await load();const out=[];
   for(const [person,p] of Object.entries(connection.state.persons)){
    if(p.state==='removed')continue;
    out.push({person,name:await nameOf(person,p.name)||(p.via==='sso'?'Asked to join with single sign-on':'Unnamed member'),role:p.role,state:p.state,via:p.via,me:person===connection.person,
     devices:Object.values(connection.state.devices).filter(d=>d.person===person).length});
   }
   return out.sort((a,b)=>Number(b.me)-Number(a.me)||a.name.localeCompare(b.name));
  },
  /** Organisation projects this person can open, with their (decrypted) names and this browser's copy. */
  async projects(){
   await load();const links=new Map((await db.getAll('links')).map(l=>[l.project,l])),out=[];
   for(const [project,p] of Object.entries(connection.state.projects)){
    const myRole=role(project);if(!myRole)continue;
    // The name was sealed when the project was created, under its first epoch's key.
    let name=null;const held=await hasKey(project,p.epoch);
    if(await hasKey(project,1)){const key=await projectKey(project,1);try{name=openProjectName(key,connection.org,project,p.name);}finally{key.fill(0);}}
    out.push({project,name:name||'Shared project (waiting for its key)',role:myRole,localId:links.get(project)?.localId||null,held,
     members:Object.entries(p.members).map(([person,r])=>({person,role:r}))});
   }
   return out;
  },
  /** The role this person has on a linked local project, or null if it is not an org project. */
  async projectRole(localId){if(!connection?.ready)return null;const link=await db.get('links',localId);return link?role(link.project):null;},
  async allowedModes(localId){const r=await api.projectRole(localId);return r?ROLE_MODES[r]:null;},
  async createInvite({role:orgRole='member',approval=false,sso=false,email='',project=null,projectRole=null,days=INVITE_DAYS}={}){
   await load();await refreshMembership();
   const secret=randomBytes(32),seed=inviteSeed(secret),invite=hex(randomBytes(16)),directory=await projectKey(connection.org,1);
   try{
    const emailHash=email?sha256Hex(new TextEncoder().encode(email.trim().toLowerCase())):undefined;
    const isAdmin=['owner','admin'].includes(me()?.role);
    await post('invite.create',()=>({invite,inviteKey:org_ed25519_public(seed),role:orgRole,expires:Math.floor(Date.now()/1000)+days*86400,
     approval:orgRole==='admin'||!isAdmin||!!approval,sso:!!(sso||emailHash),...(emailHash?{emailHash}:{}),...(project?{project,projectRole}:{})}));
    return formatInvite(appOrigin,{service:connection.service,org:connection.org,genesis:connection.state.genesis,invite,secret,directoryKey:directory});
   }finally{secret.fill(0);seed.fill(0);directory.fill(0);}
  },
  async revokeInvite(invite){await load();await post('invite.revoke',()=>({invite}));},
  async approve(person,orgRole='member'){await load();await post('person.approve',()=>({person,role:orgRole}));await fulfilPending().catch(()=>{});},
  async setRole(person,orgRole){await load();await post('person.role',()=>({person,role:orgRole}));await fulfilPending().catch(()=>{});},
  async removePerson(person){await load();await post('person.remove',()=>({person}));},
  async grant(project,person,projectRole){await load();await post('project.grant',()=>({project,person,role:projectRole}));await fulfilPending();},
  async revoke(project,person){await load();await post('project.revoke',()=>({project,person}));},
  /** The org link (no secret): where people sign in with the organisation's SSO. */
  async orgLink(){await load();return formatOrgLink(appOrigin,{service:connection.service,org:connection.org,genesis:connection.state.genesis});},
  async ssoPolicy(){await load();return client.ssoPolicy(connection.org).catch(()=>({enabled:false}));},

  // --- Joining

  /** What an invitation link says, before anything is created. */
  async describeInvite(text){
   const invite=parseInvite(text),c=orgClient(invite.service,{fetchImpl});
   try{
    const [info,sso]=await Promise.all([c.info(invite.org),c.ssoPolicy(invite.org).catch(()=>({enabled:false}))]);
    return{service:invite.service,org:invite.org,sso,exists:info.genesis,name:openName(invite.directoryKey,invite.org,'org',info.name)};
   }finally{invite.secret.fill(0);invite.directoryKey.fill(0);}
  },
  /** Joins with an invitation link: new device keys, a signed join, then (once admitted) the org. */
  async join(text,{name}={}){
   if(orgConnected())throw Error('This browser is already connected to a service.');
   const invite=parseInvite(text);
   try{
    const identity=await withCreatedKeys();await open();
    client=orgClient(invite.service,{fetchImpl});
    const previous=await readConnection();
    if(previous&&!previous.ready&&previous.org===invite.org&&previous.device===identity.publicKey&&previous.joined)connection=previous;
    else{
     const login=ssoLogin(invite.service,invite.org),person=personId(invite.org,identity.publicKey);
     await freshConnection(invite.service,invite.org,person,identity,{ssoToken:login?.token||null,genesisExpected:invite.genesis});
     await storeKey(invite.org,1,invite.directoryKey);
     for(let attempt=0;;attempt++){
      const {head}=await client.info(invite.org),agreement=connection.agreement.publicKey;
      const proof=await deviceProof({org:invite.org,prev:head,person,device:identity.publicKey,agreement},identity);
      const seed=inviteSeed(invite.secret);
      let inviteSig;try{inviteSig=org_ed25519_sign(seed,inviteMessage(invite.org,head,invite.invite,person,identity.publicKey,agreement));}finally{seed.fill(0);}
      const raw=await signEvent({org:invite.org,prev:head,type:'person.join',body:{invite:invite.invite,person,device:identity.publicKey,agreement,proof,inviteSig,name:sealName(invite.directoryKey,invite.org,person,name)}},identity);
      try{await client.postEvent(invite.org,raw,{auth:false,sso:login?.token});break;}
      catch(error){
       if(error instanceof ServiceError&&error.status===409&&attempt<3&&/head/.test(error.message))continue;
       db?.close();db=null;connection=null;await deleteDB(DB).catch(()=>{});markConnected(false);
       if(error instanceof ServiceError&&error.status===403&&/single sign-on|email/.test(error.message))throw Object.assign(Error(/email/.test(error.message)?'This invitation is for another email address.':'This invitation needs you to sign in with your organisation first.'),{sso:true});
       if(error instanceof ServiceError&&error.status===410)throw Error('This invitation has expired. Ask for a new one.');
       if(error instanceof ServiceError&&(error.status===400||error.status===409))throw Error('This invitation was already used or withdrawn. Ask for a new one.');
       throw error;
      }
     }
     connection.joined=true;await saveConnection();markJoining();
    }
    return{admitted:await admit(invite.genesis,{sso:connection.ssoToken})};
   }finally{invite.secret.fill(0);invite.directoryKey.fill(0);}
  },
  /** Asks to join through the organisation's SSO (no invitation): pending until an admin approves. */
  async requestJoin(orgText){
   if(orgConnected())throw Error('This browser is already connected to a service.');
   const link=parseOrgLink(orgText),login=ssoLogin(link.service,link.org);
   if(!login)throw Object.assign(Error('Sign in with your organisation first.'),{sso:true});
   const identity=await withCreatedKeys();await open();
   client=orgClient(link.service,{fetchImpl});
   const person=personId(link.org,identity.publicKey);
   await freshConnection(link.service,link.org,person,identity,{ssoToken:login.token,genesisExpected:link.genesis});
   // Without the directory key the name can only be sealed for nobody; admins see the
   // person's identity-provider email and name instead.
   const throwaway=randomBytes(32);
   try{
    for(let attempt=0;;attempt++){
     const {head}=await client.info(link.org),agreement=connection.agreement.publicKey;
     const proof=await deviceProof({org:link.org,prev:head,person,device:identity.publicKey,agreement},identity);
     const raw=await signEvent({org:link.org,prev:head,type:'person.request',body:{person,device:identity.publicKey,agreement,proof,name:sealName(throwaway,link.org,person,'pending')}},identity);
     try{await client.postEvent(link.org,raw,{auth:false,sso:login.token});break;}
     catch(error){if(error instanceof ServiceError&&error.status===409&&attempt<3&&/head/.test(error.message))continue;db?.close();db=null;connection=null;await deleteDB(DB).catch(()=>{});markConnected(false);throw error;}
    }
   }finally{throwaway.fill(0);}
   connection.joined=true;await saveConnection();markJoining();
   return{admitted:await admit(link.genesis,{sso:login.token})};
  },
  /** A join or device link waiting for approval: try to get in now. */
  async checkAdmission(){
   await open();connection??=await readConnection();
   if(!connection||connection.ready)return!!connection?.ready;
   client??=orgClient(connection.service,{fetchImpl});
   return admit(connection.genesisExpected,{sso:connection.ssoToken});
  },

  // --- Single sign-on

  /** Starts SSO for an org: remembers the verifier in this tab and returns the IdP URL to open. */
  async ssoBegin({service,org,purpose,carry=null}){
   const verifier=randomBytes(32);
   const {url}=await orgClient(service,{fetchImpl}).ssoStart(org,appOrigin,sha256Hex(verifier));
   const checked=signInUrl(url);
   writeSession(SSO_FLOW,{service,org,purpose,carry,verifier:hex(verifier),started:Date.now()});
   return checked;
  },
  /** Finishes SSO after the redirect back (`#scribyra-sso=…`). Returns the flow it belonged to. */
  async ssoFinish(code){
   const flow=readSession(SSO_FLOW);writeSession(SSO_FLOW,null);
   if(!flow||!(Date.now()-flow.started<15*60*1000))throw Error('This sign-in was not started in this tab, or took too long. Start it again.');
   const login=await orgClient(flow.service,{fetchImpl}).ssoRedeem(code,flow.verifier);
   if(login.org!==flow.org)throw Error('The sign-in came back for another organisation.');
   writeSession(SSO_LOGIN,{service:flow.service,org:flow.org,token:login.token,expires:login.expires,subject:login.subject,person:login.person,state:login.state});
   if(orgConnected()&&!connection)await load().catch(()=>{});
   if(connection?.ready&&connection.org===flow.org){connection.ssoToken=login.token;connection.ssoNeeded=false;await saveConnection();client?.forget();follow();for(const link of await db.getAll('links'))schedule(link.localId,100);onMembership();}
   else if(connection&&!connection.ready&&connection.org===flow.org){connection.ssoToken=login.token;await saveConnection();}
   return{...flow,login};
  },
  ssoLogin,
  async signOut(){await load();if(!connection.ssoToken)return;try{await client.ssoLogout(connection.ssoToken);}finally{connection.ssoToken=null;connection.ssoNeeded=true;await saveConnection();writeSession(SSO_LOGIN,null);client.forget();onMembership();}},

  // --- Devices

  async devices(){
   await load();
   return Object.entries(connection.state.devices).filter(([,d])=>d.person===connection.person).map(([key])=>({key,me:key===connection.device,short:key.slice(0,8)}));
  },
  /** Opens a one-time link for a new device of this person; returns the link to open there. */
  async linkDevice(){
   await load();
   const secret=randomBytes(32),seed=linkSeed(secret),link=hex(randomBytes(16));
   try{
    await authed(()=>client.createLink(connection.org,link,org_ed25519_public(seed)));
    const now=Date.now(),kept=Object.fromEntries(Object.entries(connection.deviceLinks||{}).filter(([,l])=>now-l.created<LINK_MS));
    connection.deviceLinks={...kept,[link]:{sealed:await sealAtRest(connection.storageKey,secret,`scribyra-device-link/1\n${link}`),created:now}};await saveConnection();
    return formatDeviceLink(appOrigin,{service:connection.service,org:connection.org,genesis:connection.state.genesis,person:connection.person,link,secret});
   }finally{seed.fill(0);secret.fill(0);}
  },
  /** New devices (by link or SSO) waiting for this person's approval. Link answers come with the
   * code both screens show; SSO requests need the code the new browser shows typed in here. */
  async deviceRequests(){
   await load();
   const out=[];
   for(const {link,request} of await authed(()=>client.links(connection.org))){
    if(!request)continue;
    if(request.via==='sso'){out.push({link,via:'sso',device:request.device,agreement:request.agreement,proof:request.proof,mac:request.mac,email:request.email||null,code:null});continue;}
    const stored=connection.deviceLinks?.[link];
    if(!stored||Date.now()-stored.created>=LINK_MS)continue;
    const secret=await openAtRest(connection.storageKey,stored.sealed,`scribyra-device-link/1\n${link}`),seed=linkSeed(secret);
    // The link key, known only to both devices, must have signed the new keys.
    let ok=false;
    try{ok=org_ed25519_verify(org_ed25519_public(seed),deviceRequestMessage(connection.org,link,connection.person,request.device,request.agreement),request.sig);
     if(ok)out.push({link,via:'link',device:request.device,agreement:request.agreement,proof:request.proof,code:linkCode(secret,request.device,request.agreement)});}
    finally{seed.fill(0);secret.fill(0);}
   }
   return out;
  },
  /**
   * Adds exactly the device the person was shown (never whatever the service answers now). An
   * SSO request also needs the code its browser shows, checked against the keys it asked with.
   */
  async approveDevice(shown,{code}={}){
   await load();
   const request=(await api.deviceRequests()).find(r=>r.link===shown.link);
   if(!request||request.device!==shown.device||request.agreement!==shown.agreement||request.proof!==shown.proof)throw Error('That device request changed or is gone. Start linking again.');
   if(request.via==='sso'&&deviceCodeMac(code,request.device,request.agreement)!==request.mac)throw Error('That code does not match the new browser. Check the code it shows and type it again.');
   await post('device.add',()=>({person:connection.person,device:request.device,agreement:request.agreement,proof:request.proof,link:request.link}));
   if(connection.deviceLinks?.[request.link]){delete connection.deviceLinks[request.link];await saveConnection();}
   await fulfilPending();
  },
  async removeDevice(device){await load();await post('device.remove',()=>({device}));},
  /** On the new device: answers a device link and shows the code to compare. */
  async acceptDeviceLink(text){
   if(orgConnected())throw Error('This browser is already connected to a service.');
   const link=parseDeviceLink(text);
   try{
    const identity=await withCreatedKeys();await open();
    client=orgClient(link.service,{fetchImpl});
    await freshConnection(link.service,link.org,link.person,identity,{genesisExpected:link.genesis,joined:true});
    const agreement=connection.agreement.publicKey,seed=linkSeed(link.secret);
    let sig;try{sig=org_ed25519_sign(seed,deviceRequestMessage(link.org,link.link,link.person,identity.publicKey,agreement));}finally{seed.fill(0);}
    const proof=await deviceProof({org:link.org,link:link.link,person:link.person,device:identity.publicKey,agreement},identity);
    try{await client.answerLink(link.org,link.link,{device:identity.publicKey,agreement,proof,sig});}
    catch(error){db?.close();db=null;connection=null;await deleteDB(DB).catch(()=>{});markConnected(false);if(error instanceof ServiceError&&(error.status===404||error.status===409))throw Error('This device link was already used or has expired. Make a new one.');throw error;}
    connection.linkCode=linkCode(link.secret,identity.publicKey,agreement);await saveConnection();
    return{code:connection.linkCode};
   }finally{link.secret.fill(0);}
  },
  /** On the new device, signed in with SSO as an existing member: asks to be added. */
  async requestDeviceBySso(orgText){
   if(orgConnected())throw Error('This browser is already connected to a service.');
   const org=parseOrgLink(orgText),login=ssoLogin(org.service,org.org);
   if(!login?.person)throw Error('Sign in with your organisation first.');
   const identity=await withCreatedKeys();await open();
   client=orgClient(org.service,{fetchImpl});
   await freshConnection(org.service,org.org,login.person,identity,{genesisExpected:org.genesis,joined:true,ssoToken:login.token});
   const agreement=connection.agreement.publicKey,link=hex(randomBytes(16));
   const proof=await deviceProof({org:org.org,link,person:login.person,device:identity.publicKey,agreement},identity),code=newDeviceCode();
   await client.ssoDeviceRequest(org.org,{link,device:identity.publicKey,agreement,proof,mac:deviceCodeMac(code,identity.publicKey,agreement)},login.token);
   connection.linkCode=code;await saveConnection();
   return{code};
  },

  /** Forgets the service on this browser only. Local projects and the service's copies stay. */
  async forget(){
   closed=true;polling?.abort();unwatch?.();for(const t of timers.values())clearTimeout(t);timers.clear();
   db?.close();db=null;connection=null;client=null;pendingKitText='';await deleteDB(DB);markConnected(false);statuses.clear();closed=false;unwatch=null;live=false;
  },
  close(){closed=true;polling?.abort();if(onlineHook)globalThis.removeEventListener?.('online',onlineHook);onlineHook=null;unwatch?.();unwatch=null;for(const t of timers.values())clearTimeout(t);timers.clear();db?.close();db=null;},
  push,
  /** Pulls and pushes one linked project now. */
  sync:push,
 };
 return api;
}
