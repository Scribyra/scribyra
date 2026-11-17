// Remote backup to a self-hosted scribyra-sync service (organisation sync, slice 1).
// One person, an end-to-end encrypted organisation, encrypted append-only project logs,
// a recovery kit, and restore into a fresh browser. Nothing here runs, opens a
// database or creates a key until the person connects (off means off).
//
// Every step that the service commits is prepared locally first (connection record,
// outbox entry, pending recovery kit, pending project), so a crash or a lost answer is
// resumed with identical bytes instead of leaving the service and this browser apart.
import * as Y from 'yjs';
import {openDB,deleteDB} from 'idb';
import * as storage from './storage.js';
import {watchStorage} from './storage-events.js';
import {profileIdentity} from './direct-identity.js';
import {setDirectKeyPresent} from './direct-state.js';
import {SCHEMA_VERSION,validateProjectState} from './model.js';
import {blobRefs} from './assets.js';
import {orgClient,ServiceError} from './org-client.js';
import {
 parseSetupCode,parseKit,formatKit,newRecoveryCode,recoverySecrets,recoveryProof,newAgreementKey,newStorageKey,sealAtRest,openAtRest,
 signEvent,genesisBody,enrolPublic,deviceProof,applyEvents,newProjectKey,wrapProjectKey,unwrapProjectKey,
 sealEntry,openEntry,verifyEntryBody,entryHash,chainNext,randomBytes,hex,
} from './org-crypto.js';

export const ORG_CONNECTED='scribyra:org-connected';
export function orgConnected(){try{return globalThis.localStorage?.getItem(ORG_CONNECTED)==='true';}catch{return false;}}
const markConnected=on=>{try{if(on)localStorage.setItem(ORG_CONNECTED,'true');else localStorage.removeItem(ORG_CONNECTED);}catch{}};
const DB='scribyra-org';
const database=()=>openDB(DB,1,{upgrade(db){
 db.createObjectStore('connection');
 db.createObjectStore('links',{keyPath:'localId'});
 db.createObjectStore('outbox',{keyPath:['localId','clientSeq']});
 db.createObjectStore('keys',{keyPath:['project','epoch']});
}});
// One entry may carry at most this much Yjs data; the service's default object limit is 8 MiB.
export const MAX_ENTRY_BYTES=7*1024*1024;
const RETRY=[2000,10000,30000,120000];
const WRAP_BATCH=64;
const keyContext=(org,project,epoch)=>`scribyra-org-key/1\n${org}\n${project}\n${epoch}`;
const kitContext=org=>`scribyra-org-kit/1\n${org}`;

export const STATUS_TEXT={
 'backed-up':'Backed up remotely','backing-up':'Backing up…','waiting':'Waiting to back up','paused':'Backup paused','unsupported':'Not backed up remotely',
};
const fault=message=>Object.assign(Error(message),{fatal:true});

export function orgBackup({onChange=()=>{},fetchImpl,locks=globalThis.navigator?.locks}={}){
 let db,connection,client,closed=false,unwatch,pendingKitText='';
 const statuses=new Map(),timers=new Map(),attempts=new Map(),queues=new Map();
 const setStatus=(localId,state,message='')=>{statuses.set(localId,{state,message,label:STATUS_TEXT[state]});onChange(localId);};
 async function open(){db??=await database();return db;}
 async function load(){
  await open();connection=await db.get('connection','current');
  if(!connection||!connection.ready)throw Error('This browser is not connected to a backup service.');
  client??=orgClient(connection.service,{fetchImpl});return connection;
 }
 async function saveConnection(){await (await open()).put('connection',connection,'current');}
 // Every request signs in again once if the service forgot this browser's session.
 async function authed(task){
  if(!client.token)await client.signIn(connection.org,await deviceIdentity());
  try{return await task();}
  catch(error){if(error instanceof ServiceError&&error.status===401){client.forget();await client.signIn(connection.org,await deviceIdentity());return task();}throw error;}
 }
 async function deviceIdentity(){
  const identity=await profileIdentity();
  if(identity.publicKey!==connection.device)throw Error('This browser’s signing key changed since it connected. Restore with your recovery kit to connect it again.');
  return identity;
 }
 async function refreshMembership(){
  const events=await authed(()=>client.events(connection.org,connection.state.count));
  if(events.length){connection.state=applyEvents(connection.state,connection.org,events);await saveConnection();}
  return connection.state;
 }
 async function projectKey(project,epoch){
  const record=await db.get('keys',[project,epoch]);
  if(!record)throw Error('This browser does not hold the key for a backed-up project.');
  return openAtRest(connection.storageKey,record.sealed,keyContext(connection.org,project,epoch));
 }
 async function storeKey(project,epoch,key){
  await db.put('keys',{project,epoch,sealed:await sealAtRest(connection.storageKey,key,keyContext(connection.org,project,epoch))});
 }
 async function putWraps(wraps){for(let i=0;i<wraps.length;i+=WRAP_BATCH){const part=wraps.slice(i,i+WRAP_BATCH);await authed(()=>client.putWraps(connection.org,part));}}
 /** This person's keys that may receive project keys: this device and the current recovery key. */
 function personRecipients(){
  const person=connection.state.persons[connection.person],recipients=[connection.agreement.publicKey];
  if(person?.recoveryAgreement)recipients.push(person.recoveryAgreement);
  return recipients;
 }
 async function wrapForPerson(project,epoch,key,identity){
  const wraps=[];for(const recipient of personRecipients())wraps.push(await wrapProjectKey({org:connection.org,project,epoch,recipient,projectKey:key},identity));
  await putWraps(wraps);
 }
 /**
  * Every project key this browser holds is also wrapped to the person's current recovery
  * key. Runs after a kit is replaced (here or on another device of the same person) and is
  * retried on every start until it has succeeded, so no backup is left unrestorable.
  */
 async function ensureRecoveryWraps(){
  const recovery=connection.state.persons[connection.person]?.recoveryAgreement;
  if(!recovery||connection.wrappedRecovery===recovery)return;
  const identity=await deviceIdentity(),wraps=[];
  for(const record of await db.getAll('keys')){
   if(!connection.state.projects[record.project])continue;
   const key=await projectKey(record.project,record.epoch);
   try{wraps.push(await wrapProjectKey({org:connection.org,project:record.project,epoch:record.epoch,recipient:recovery,projectKey:key},identity));}finally{key.fill(0);}
  }
  await putWraps(wraps);
  connection.wrappedRecovery=recovery;await saveConnection();
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
  setStatus(localId,'waiting',error.message);schedule(localId,RETRY[Math.min(n,RETRY.length-1)]);
 }

 /**
  * Checks one log entry against the chain and the membership log without decrypting it:
  * signature, organisation, project, epoch, a member device with access, and that each
  * device's client sequence continues without gaps or replays. Returns the next cursor.
  */
 async function verifyItem(cursor,item){
  const {header,headerRaw,ciphertext}=verifyEntryBody(item.body),chain=chainNext(cursor.chain,entryHash(headerRaw,ciphertext));
  if(item.seq!==cursor.seq+1||item.chain!==chain)throw fault('The service’s log does not match what this browser verified. Backup paused.');
  let state=connection.state;
  if(!state.devices[header.device])state=await refreshMembership();
  const device=state.devices[header.device],project=state.projects[cursor.project];
  if(header.org!==connection.org||header.project!==cursor.project||!project||header.epoch!==project.epoch||!device||!project.editors.includes(device.person))
   throw fault('A backed-up change was not written by a member device. Backup paused.');
  if(header.clientSeq!==(cursor.devices[header.device]||0)+1)throw fault('A backed-up change was replayed or is missing. Backup paused.');
  return{...cursor,seq:item.seq,chain,devices:{...cursor.devices,[header.device]:header.clientSeq},header};
 }
 /** Reads the log from `cursor` to the head, verifying every entry; `each` sees each verified entry. */
 async function readVerified(cursor,each=()=>{}){
  for await(const item of await authed(async()=>client.log(cursor.project,cursor.seq))){
   cursor=await verifyItem(cursor,item);await each(item,cursor.header);
   // Large entries take a while to decrypt: let the page (and its connections) breathe.
   await new Promise(resolve=>setTimeout(resolve,0));
  }
  return cursor;
 }
 /**
  * Rebuilds what the service holds for a project from its whole log: the verified cursor,
  * each device's last client sequence, and the Yjs state (so only the difference is sent).
  */
 async function serverState(link){
  const key=await projectKey(link.project,link.epoch),doc=new Y.Doc();
  try{
   const cursor=await readVerified({project:link.project,seq:0,chain:link.project,devices:{}},item=>{
    const opened=openEntry(item.body,key);
    if(opened.meta.lineage!==link.lineage)throw fault('A project’s backed-up changes disagree about its identity. Backup paused.');
    Y.applyUpdate(doc,opened.payload);
   });
   return{seq:cursor.seq,chain:cursor.chain,devices:cursor.devices,vector:Y.encodeStateVector(doc)};
  }finally{key.fill(0);doc.destroy();}
 }
 /**
  * The service lost entries this browser saw acknowledged (it was restored from an older
  * backup). Its log must still be a prefix of what was verified; then everything this
  * browser has is uploaded again as new entries.
  */
 async function recoverRollback(link){
  const server=await serverState(link);
  if(server.seq>=link.seq)throw fault('The service’s log does not match what this browser verified. Backup paused.');
  const tx=db.transaction(['links','outbox'],'readwrite');
  for(const key of await tx.objectStore('outbox').getAllKeys(IDBKeyRange.bound([link.localId,0],[link.localId,Infinity])))await tx.objectStore('outbox').delete(key);
  const current={...await tx.objectStore('links').get(link.localId),seq:server.seq,chain:server.chain,devices:server.devices,vector:server.vector,clientSeq:server.devices[connection.device]||0,pushedSequence:-1};
  await tx.objectStore('links').put(current);await tx.done;
  setStatus(link.localId,'backing-up','The service lost recent changes. Re-uploading from this device.');
  return current;
 }
 // Verifies the acknowledged entry extends the chain this browser already verified,
 // checking every entry other devices appended in between.
 async function acknowledge(link,entry,ack){
  let cursor={project:link.project,seq:link.seq,chain:link.chain,devices:link.devices||{}};
  if(ack.seq<=cursor.seq)throw fault('The service acknowledged a log position this browser already verified. Backup paused.');
  if(ack.seq!==cursor.seq+1){
   for await(const item of await authed(async()=>client.log(link.project,cursor.seq))){
    if(item.seq>=ack.seq)break;
    cursor=await verifyItem(cursor,item);
   }
  }
  const chain=chainNext(cursor.chain,entryHash(entry.headerRaw,entry.ciphertext));
  if(ack.seq!==cursor.seq+1||ack.chain!==chain)throw fault('The service acknowledged a log position this browser cannot verify. Backup paused.');
  return{seq:ack.seq,chain,devices:{...cursor.devices,[connection.device]:entry.clientSeq}};
 }
 async function send(link,entry){
  let ack;
  try{ack=await authed(()=>client.append(link.project,entry.body));}
  catch(error){
   if(error instanceof ServiceError&&error.status===409){
    if(/client sequence/.test(error.message))return{rollback:true};
    throw fault('The service holds a different change at this position. Backup paused for this project.');
   }
   throw error;
  }
  const verified=await acknowledge(link,entry,ack);
  const tx=db.transaction(['links','outbox'],'readwrite');
  const current=await tx.objectStore('links').get(link.localId);
  Object.assign(current,{seq:verified.seq,chain:verified.chain,devices:verified.devices,vector:entry.vector,pushedSequence:entry.sequence,acked:entry.clientSeq});
  await tx.objectStore('links').put(current);await tx.objectStore('outbox').delete([link.localId,entry.clientSeq]);await tx.done;
  return current;
 }
 /** Creates the project on the service once, even across retries and crashes (no orphans). */
 async function ensureCreated(link){
  if(link.created!==false)return link;
  await refreshMembership();
  if(!connection.state.projects[link.project]){
   const key=await projectKey(link.project,1),identity=await deviceIdentity();
   try{
    const raw=await signEvent({org:connection.org,prev:connection.state.head,type:'project.create',body:{project:link.project,epoch:1,keyCommit:link.keyCommit}},identity);
    const state=applyEvents(connection.state,connection.org,[raw]);
    await authed(()=>client.postEvent(connection.org,raw));connection.state=state;await saveConnection();
   }finally{key.fill(0);}
  }else if(connection.state.projects[link.project].creator!==connection.person)throw fault('Another person created a project with this identity. Backup paused.');
  const key=await projectKey(link.project,1);
  try{await wrapForPerson(link.project,1,key,await deviceIdentity());}finally{key.fill(0);}
  const current={...link,created:true};await db.put('links',current);return current;
 }
 async function pushNow(localId){
  await load();let link=await db.get('links',localId);if(!link)return;
  setStatus(localId,'backing-up');
  link=await ensureCreated(link);
  for(const entry of (await db.getAll('outbox')).filter(e=>e.localId===localId).sort((a,b)=>a.clientSeq-b.clientSeq)){
   const sent=await send(link,entry);
   if(sent.rollback){link=await recoverRollback(link);break;}
   link=sent;
  }
  const read=await storage.readCommittedProject(localId);
  if(read.kind==='deleted'||read.kind==='missing'){setStatus(localId,'paused','This project is no longer on this device. Its remote backup is kept.');return;}
  if(read.head.sequence===link.pushedSequence){attempts.delete(localId);setStatus(localId,'backed-up');return;}
  const doc=new Y.Doc();
  try{
   Y.applyUpdate(doc,read.update);
   if(blobRefs(doc).length){setStatus(localId,'unsupported','Projects with images or other binary files cannot be backed up remotely yet.');return;}
   const meta=doc.getMap('meta');
   if(meta.get('lineageId')!==link.lineage){setStatus(localId,'paused','This project’s identity changed. Back it up again as a new project.');return;}
   const payload=Y.encodeStateAsUpdate(doc,link.vector);
   if(payload.byteLength>MAX_ENTRY_BYTES){setStatus(localId,'unsupported','This change is too large to back up in one piece yet.');return;}
   const key=await projectKey(link.project,link.epoch),identity=await deviceIdentity(),clientSeq=link.clientSeq+1;
   let sealed;
   try{sealed=await sealEntry({projectKey:key,org:connection.org,project:link.project,epoch:link.epoch,clientSeq,lineage:link.lineage,schema:meta.get('schemaVersion'),person:connection.person,payload},identity);}
   finally{key.fill(0);}
   const entry={localId,clientSeq,body:sealed.body,headerRaw:sealed.headerRaw,ciphertext:sealed.ciphertext,vector:Y.encodeStateVector(doc),sequence:read.head.sequence};
   // The outbox entry and its sequence number are durable before anything is sent,
   // so a retry after a crash resends identical bytes and never reuses a number.
   const tx=db.transaction(['links','outbox'],'readwrite');
   await tx.objectStore('outbox').put(entry);await tx.objectStore('links').put({...link,clientSeq});await tx.done;
   const sent=await send({...link,clientSeq},entry);
   if(sent.rollback){await recoverRollback(link);throw Error('The service lost recent changes. Re-uploading from this device.');}
  }finally{doc.destroy();}
  attempts.delete(localId);setStatus(localId,'backed-up');
 }
 async function push(localId){
  return queue(localId,async()=>{
   try{await pushNow(localId);}
   catch(error){if(error.fatal)setStatus(localId,'paused',error.message);else retry(localId,error);throw error;}
  });
 }
 /** Rebuilds one project from its log into a new local project. Nothing is saved unless it all verifies. */
 async function restoreProject(project,epoch){
  const key=await projectKey(project,epoch),doc=new Y.Doc();
  let lineage=null;
  try{
   const cursor=await readVerified({project,seq:0,chain:project,devices:{}},(item,header)=>{
    const opened=openEntry(item.body,key);
    if(opened.meta.person!==connection.state.devices[header.device].person)throw Error('A backed-up change names another author than its device. Nothing was restored for this project.');
    if(opened.meta.schema>SCHEMA_VERSION)throw Error('A project was backed up by a newer Scribyra. Update Scribyra to restore it.');
    if(lineage!==null&&opened.meta.lineage!==lineage)throw Error('A project’s backed-up changes disagree about its identity.');
    lineage=opened.meta.lineage;
    Y.applyUpdate(doc,opened.payload);
   });
   if(!cursor.seq)return null;
   if(doc.store.pendingStructs||doc.store.pendingDs)throw Error('A project’s backup is incomplete. Nothing was restored for it.');
   if(doc.getMap('meta').get('lineageId')!==lineage)throw Error('A project’s backup disagrees about its identity.');
   validateProjectState(doc);
   const localId=crypto.randomUUID(),saved=await storage.saveProject(localId,doc);
   await db.put('links',{localId,project,epoch,lineage,created:true,seq:cursor.seq,chain:cursor.chain,devices:cursor.devices,clientSeq:cursor.devices[connection.device]||0,acked:0,vector:Y.encodeStateVector(doc),pushedSequence:saved.sequence});
   setStatus(localId,'backed-up');
   return{localId,name:doc.getMap('meta').get('name')||'Untitled project'};
  }finally{key.fill(0);doc.destroy();}
 }
 /** Projects this browser holds keys for but has not restored yet. */
 async function unrestored(){
  const linked=new Set((await db.getAll('links')).map(l=>l.project));
  return(await db.getAll('keys')).filter(k=>!linked.has(k.project)&&connection.state.projects[k.project]);
 }
 async function restoreRemaining(){
  const restored=[],failures=[];
  for(const record of await unrestored()){
   try{const result=await restoreProject(record.project,record.epoch);if(result)restored.push(result);}
   catch(error){failures.push(error.message);}
  }
  return{restored,failures};
 }
 function watch(){
  unwatch??=watchStorage(hint=>{
   if(closed||!hint||hint.kind==='rescan')return;
   void db?.get('links',hint.projectId).then(link=>{if(link)schedule(hint.projectId);}).catch(()=>{});
  });
 }
 async function adopt(state){connection.state=state;connection.ready=true;await saveConnection();markConnected(true);watch();}
 /**
  * A new recovery kit. The kit is kept (sealed) in this browser before the service learns of
  * it, so a lost answer or a closed dialog never loses a kit that is already active.
  */
 async function newRecovery(identity){
  const code=newRecoveryCode(),secrets=recoverySecrets(code.bytes);
  try{
   const {org,person}=connection,prev=connection.state.head;
   const proof=recoveryProof({org,prev,person,signing:secrets.signingPublic,agreement:secrets.agreementPublic},secrets.signing);
   const raw=await signEvent({org,prev,type:'recovery.set',body:{person,signing:secrets.signingPublic,agreement:secrets.agreementPublic,proof}},identity);
   const state=applyEvents(connection.state,org,[raw]);
   const text=formatKit({service:connection.service,org,genesis:connection.state.genesis,code:code.text});
   connection.pendingKit={signing:secrets.signingPublic,sealed:await sealAtRest(connection.storageKey,new TextEncoder().encode(text),kitContext(org))};
   await saveConnection();
   try{await authed(()=>client.postEvent(org,raw));connection.state=state;}
   catch(error){
    // The event may have been committed although the answer was lost.
    await refreshMembership().catch(()=>{});
    if(connection.state.persons[person]?.recoverySigning!==secrets.signingPublic){delete connection.pendingKit;await saveConnection();throw error;}
   }
   await saveConnection();
   pendingKitText=text;
   // Existing backups become restorable with the new kit; retried on start if this fails.
   await ensureRecoveryWraps().catch(()=>{});
   return text;
  }finally{code.bytes.fill(0);secrets.signing.fill(0);secrets.agreement.fill(0);}
 }
 async function pendingKit(){
  if(pendingKitText)return pendingKitText;
  const pending=connection?.pendingKit;if(!pending)return'';
  if(connection.state.persons[connection.person]?.recoverySigning!==pending.signing){delete connection.pendingKit;await saveConnection();return'';}
  return pendingKitText=new TextDecoder().decode(await openAtRest(connection.storageKey,pending.sealed,kitContext(connection.org)));
 }
 async function withCreatedKeys(){const identity=await profileIdentity({create:true});setDirectKeyPresent(true);return identity;}

 return{
  get connected(){return !!connection?.ready;},
  get info(){return connection?.ready?{service:connection.service,org:connection.org,mode:connection.state.mode,adminRead:connection.state.adminRead}:null;},
  status:localId=>statuses.get(localId),
  /** Starts backing up linked projects if this browser was connected before. */
  async start(){
   if(!orgConnected())return false;
   await load();watch();
   await refreshMembership().then(ensureRecoveryWraps).catch(()=>{});
   for(const link of await db.getAll('links'))schedule(link.localId,500);
   return true;
  },
  async links(){if(!connection&&!orgConnected())return[];await open();return db.getAll('links');},
  /** The recovery kit made last, until the person confirms they saved it. */
  pendingKit,
  async confirmKit(){pendingKitText='';if(connection?.pendingKit){delete connection.pendingKit;await saveConnection();}},
  /** First connection with an operator's setup code: creates this org's genesis and a recovery kit. */
  async connect(setupText,{adminRead=true}={}){
   const setup=parseSetupCode(setupText);
   try{
    if(orgConnected())throw Error('This browser is already connected to a backup service.');
    const identity=await withCreatedKeys();await open();
    // A previous attempt for this organisation left its keys and genesis here: resume it.
    const previous=await db.get('connection','current');
    let raw,state;
    if(previous&&!previous.ready&&previous.org===setup.org&&previous.device===identity.publicKey){connection=previous;raw=previous.genesis;state=previous.state;}
    else{
     const agreement=await newAgreementKey(),storageKey=await newStorageKey();
     const body=genesisBody({org:setup.org,secret:setup.secret,device:identity.publicKey,agreement:agreement.publicKey,adminRead});
     raw=await signEvent({org:setup.org,prev:setup.org,type:'genesis',body},identity);
     state=applyEvents(null,setup.org,[raw],enrolPublic(setup.secret));
     connection={service:setup.service,org:setup.org,person:body.person,device:identity.publicKey,agreement,storageKey,state,genesis:raw,ready:false};
     await saveConnection();
    }
    client=orgClient(setup.service,{fetchImpl});
    try{await client.postEvent(setup.org,raw,{auth:false});}
    catch(error){
     if(!(error instanceof ServiceError&&(error.status===409||error.status===401)))throw error;
     // Already committed by an attempt whose answer was lost? Then the genesis is ours.
     let events=[];
     try{await client.signIn(setup.org,identity);events=await client.events(setup.org,0);}catch{}
     if(events[0]!==raw)throw Error('This setup code was already used. Ask the operator for a new one, or restore with your recovery kit.');
     state=applyEvents(null,setup.org,events,enrolPublic(setup.secret));
    }
    delete connection.genesis;await adopt(state);
    return newRecovery(identity);
   }finally{setup.secret.fill(0);}
  },
  /** Replaces the recovery kit; the previous kit stops working on this service. */
  async replaceRecoveryKit(){await load();await refreshMembership();return newRecovery(await deviceIdentity());},
  /** Starts backing up one local project. */
  async backUp(localId){
   await load();
   if(await db.get('links',localId))return push(localId);
   const read=await storage.readCommittedProject(localId);
   if(read.kind!=='updated')throw Error('Open or save the project on this device first.');
   const doc=new Y.Doc();let lineage;
   try{Y.applyUpdate(doc,read.update);lineage=doc.getMap('meta').get('lineageId');
    if(blobRefs(doc).length)throw Error('Projects with images or other binary files cannot be backed up remotely yet.');}
   finally{doc.destroy();}
   if(typeof lineage!=='string')throw Error('This project has no identity yet. Save it once, then try again.');
   // The project's identity and key are durable here before the service hears of them.
   const project=hex(randomBytes(32)),{key,commit}=newProjectKey();
   try{await storeKey(project,1,key);}finally{key.fill(0);}
   await db.put('links',{localId,project,epoch:1,keyCommit:commit,lineage,created:false,seq:0,chain:project,devices:{},clientSeq:0,acked:0,vector:new Uint8Array([0]),pushedSequence:-1});
   return push(localId);
  },
  /** A fresh browser: enrol it with the recovery kit and restore every backed-up project. */
  async restore(kitText){
   if(orgConnected())throw Error('This browser is already connected to a backup service.');
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
    const previous=await db.get('connection','current');
    if(previous&&!previous.ready&&previous.org===kit.org&&previous.device===identity.publicKey&&state.devices[identity.publicKey]?.agreement===previous.agreement.publicKey)connection={...previous,state};
    else{
     const agreement=await newAgreementKey(),storageKey=await newStorageKey();
     connection={service:kit.service,org:kit.org,person,device:identity.publicKey,agreement,storageKey,state,ready:false};
     await saveConnection();
     const proof=await deviceProof({org:kit.org,prev:state.head,person,device:identity.publicKey,agreement:agreement.publicKey},identity);
     const raw=await signEvent({org:kit.org,prev:state.head,type:'device.add',body:{person,device:identity.publicKey,agreement:agreement.publicKey,proof}},secrets.signing);
     state=applyEvents(state,kit.org,[raw]);await client.postEvent(kit.org,raw);
    }
    client.forget();await client.signIn(kit.org,identity);
    connection.state=state;connection.wrappedRecovery=state.persons[person].recoveryAgreement;
    // Every key the kit can open is kept and re-wrapped for this browser first, so restoring
    // can be resumed later without the kit.
    const failures=[];let opened=0;
    const wraps=[];
    for(const raw of await authed(()=>client.wraps(kit.org))){
     const wrap=JSON.parse(raw);if(wrap.recipient!==secrets.agreementPublic)continue;
     let result;
     try{result=await unwrapProjectKey(state,raw,secrets.agreement);}catch(error){failures.push(error.message);continue;}
     try{await storeKey(result.project,result.epoch,result.key);wraps.push(await wrapProjectKey({org:kit.org,project:result.project,epoch:result.epoch,recipient:connection.agreement.publicKey,projectKey:result.key},identity));opened++;}
     finally{result.key.fill(0);}
    }
    await putWraps(wraps);
    await adopt(state);
    const held=new Set((await db.getAll('keys')).map(k=>k.project));
    const missing=Object.entries(state.projects).filter(([id,p])=>p.editors.includes(person)&&!held.has(id)).length;
    if(missing)failures.push(`${missing===1?'1 backed-up project has':missing+' backed-up projects have'} no key for this recovery kit. Open Scribyra on the device that backed ${missing===1?'it':'them'} up once, then restore remaining projects here.`);
    const result=await restoreRemaining();
    return{restored:result.restored,failures:[...failures,...result.failures],opened};
   }finally{kit.code.fill(0);secrets.signing.fill(0);secrets.agreement.fill(0);}
  },
  /** Projects this browser can restore but has not yet (an interrupted restore). */
  async unrestored(){if(!orgConnected())return[];await load();return unrestored();},
  async restoreRemaining(){await load();await refreshMembership();return restoreRemaining();},
  /** Forgets the service on this browser only. Local projects and the service's copies stay. */
  async forget(){
   closed=true;unwatch?.();for(const t of timers.values())clearTimeout(t);timers.clear();
   db?.close();db=null;connection=null;client=null;pendingKitText='';await deleteDB(DB);markConnected(false);statuses.clear();closed=false;unwatch=null;
  },
  close(){closed=true;unwatch?.();unwatch=null;for(const t of timers.values())clearTimeout(t);timers.clear();db?.close();db=null;},
  push,
 };
}
