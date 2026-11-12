import {signRecords,validateProvenance,validateProofEntry,validateClaimEntry} from './direct-provenance.js';
import * as Y from 'yjs';
import {cloneProject,blobRefs,knownBlob,installBlob,copyBlobs} from './assets.js';
import {SCHEMA_VERSION,validateProjectState,validatePeerState,validateRetainedState,MAX_RETAINED_BYTES} from './model.js';
import {concurrentBinaryVersions,binaryRecoverySources} from './binary-recovery.js';
import {registerRemoteOrigin} from './change-origins.js';

export const PEER_UPDATE=Symbol('direct peer update');
export function hex(bytes){const parts=[];for(let i=0;i<bytes.length;i+=8192)parts.push(Array.from(bytes.subarray(i,i+8192),b=>b.toString(16).padStart(2,'0')).join(''));return parts.join('');}
export function unhex(value){
 if(typeof value!=='string'||value.length%2||!/^[0-9a-f]*$/.test(value))throw Error('Invalid byte encoding.');
 const bytes=new Uint8Array(value.length/2);for(let i=0;i<bytes.length;i++)bytes[i]=parseInt(value.slice(i*2,i*2+2),16);return bytes;
}
export function checkHello(value,lineage){
 if(value?.schema>SCHEMA_VERSION)throw Error('This peer needs a newer Scribyra version. Update before joining.');
 if(typeof value?.schema==='number'&&value.schema<SCHEMA_VERSION)throw Error('The other person has an older Scribyra version. They must update and reopen the project before joining.');
 if(value?.version!==2||value.schema!==SCHEMA_VERSION||value.lineage!==lineage||value.rights!=='full-editor')throw Error('Incompatible direct session, project schema or editor rights.');
}
// Shared with local tabs: validate the complete merged state, never just the delta.
function validatePeerMetadata(doc,baseline){
 const types={schemaVersion:'number',lineageId:'string',name:'string',mainFile:'string',engine:'string',texEnvironment:'object',texLinkOrigin:'string'},meta=doc.getMap('meta');
 for(const [key,value]of meta){
  if(key.startsWith('directProof:')){if(!validateProofEntry(doc,key,value))throw Error('Unverified edit: a peer sent an invalid record proof. Your local copy is unchanged.');}
  else if(key.startsWith('directClaim:')){if(!validateClaimEntry(doc,key,value))throw Error('Unverified edit: a peer sent an invalid claim to earlier records. Your local copy is unchanged.');}
  else if(!Object.hasOwn(types,key)||typeof value!==types[key])throw Error('Invalid peer project metadata.');
 }
 if(meta.has('name')&&meta.get('name').length>1024||meta.has('mainFile')&&meta.get('mainFile').length>256)throw Error('Invalid peer project metadata.');
 if(meta.has('engine')&&!['pdflatex','lualatex','xelatex'].includes(meta.get('engine')))throw Error('Invalid peer project metadata.');
 // The TeX-link mark gates compilation and backups. A project can inherit it at
 // first join, but a peer cannot impose it on a project that already has content.
 const before=baseline.getMap('meta');
 if(meta.get('texLinkOrigin')!==before.get('texLinkOrigin')&&(baseline.getMap('files').size||meta.get('texLinkOrigin')!=='link'))throw Error('Invalid peer project metadata.');
}
export function validateReplica(doc){
 if(doc.getMap('meta').get('schemaVersion')!==SCHEMA_VERSION)throw Error('The committed project needs a different Scribyra version.');
 validateProjectState(doc);
 for(const ref of blobRefs(doc)){const bytes=knownBlob(doc,ref.hash);if(!bytes||bytes.byteLength!==ref.size)throw Error('The merged project has an unavailable binary asset.');}
}
export async function receiveReplica({doc,update,pull,isActive=()=>true,isComposing=()=>false,preserve,onRecovery=()=>{},origin=PEER_UPDATE,lineage=doc.getMap('meta').get('lineageId'),bound=()=>[]}){
 while(isActive()){
  while(isActive()&&isComposing())await new Promise(resolve=>setTimeout(resolve,50));
  if(!isActive())return;
  const before=Y.snapshot(doc),preview=cloneProject(doc),remote=new Y.Doc();
  try{
   if(update.byteLength>MAX_RETAINED_BYTES)throw Error('Peer update exceeds the 96 MiB limit.');
   Y.applyUpdate(preview,update,origin);Y.applyUpdate(remote,update);
   if(preview.store.pendingStructs||preview.store.pendingDs)throw Error('Peer state is incomplete; missing causal history.');
   if(preview.getMap('meta').get('schemaVersion')!==SCHEMA_VERSION)throw Error('This peer needs a different Scribyra version.');
   if(preview.getMap('meta').get('lineageId')!==lineage||doc.getMap('meta').get('lineageId')!==lineage)throw Error('Direct session lineage changed. Rejoin the correct project.');
   validateRetainedState(preview);
   validatePeerMetadata(preview,doc);
   // Authenticate first, so a forged claim reads as an unverified edit rather than
   // whichever semantic rule it happens to break.
   await validateProvenance(doc,preview,{bound:bound()});
   validatePeerState(preview);
   if(!isActive())return;
   for(const ref of blobRefs(preview))if(!knownBlob(preview,ref.hash))installBlob(preview,ref,await pull(ref));
   validateReplica(preview);
   if(concurrentBinaryVersions(doc,remote)){
    for(const ref of blobRefs(remote))installBlob(remote,ref,knownBlob(preview,ref.hash)||await pull(ref));
    for(const source of binaryRecoverySources(doc,remote,preview)){
     if(!preserve)throw Error('Concurrent binary versions need a recovery copy before merging.');
     onRecovery(await preserve(source));
    }
   }
   if(!isActive())return;
   if(isComposing()||!Y.equalSnapshots(before,Y.snapshot(doc)))continue;
   copyBlobs(preview,doc);Y.applyUpdate(doc,update,origin);return;
  }finally{preview.destroy();remote.destroy();}
 }
}

export function replication({doc,lineage=doc.getMap('meta').get('lineageId'),send,onError=()=>{},pollMs=5000,identity,legacy,...pipeline}){
 let closed=false,ready=false,processing=false,waiting=[],queuedBytes=0,preparing=false,nextVector,wake;
 const remote=new Y.Doc();let receivedState=false;
 const offered=new Map();let offeredBytes=0;
 const pending=new Map(),unregister=registerRemoteOrigin(PEER_UPDATE);
 const activeLineage=()=>{if(doc.getMap('meta').get('lineageId')!==lineage){fail(Error('Direct session lineage changed. Rejoin the correct project.'));return false;}return !closed;};
 const emit=value=>{if(activeLineage())Promise.resolve(send(value)).catch(fail);};
 function fail(error){if(!closed){close();onError(error);}}
 function sync(requestVector=false){if(ready&&!closed)emit({type:'vector',requestVector,full:!receivedState,bytes:hex(Y.encodeStateVector(remote))});}
 const changed=()=>{if(!activeLineage())return;clearTimeout(wake);wake=setTimeout(()=>sync(true),80);};
 function pull(ref){
  if(pending.has(ref.hash))return pending.get(ref.hash).promise;
  let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});
  const timer=setTimeout(()=>{pending.delete(ref.hash);reject(Error('Peer asset unavailable. Rejoin to retry.'));},20000);
  pending.set(ref.hash,{promise,resolve,reject,timer});emit({type:'pull',ref});return promise;
 }
 async function receive(value){
  if(!activeLineage())return;
  try{
   if(value?.type==='hello'){
    checkHello(value,lineage);if(ready)throw Error('Repeated replication handshake.');ready=true;sync();return;
   }
   if(!ready)throw Error('Missing replication handshake.');
   if(value.type==='vector'){
    if(typeof value.bytes!=='string'||value.bytes.length>128*1024)throw Error('Peer state vector exceeds 64 KiB.');
    Y.decodeStateVector(unhex(value.bytes));
    nextVector={...value,full:value.full||nextVector?.full,requestVector:value.requestVector||nextVector?.requestVector};
    void prepareVectors();return;
   }
   if(value.type==='pull'){
    const entry=offered.get(value.ref?.hash),ref=entry?.ref.size===value.ref?.size?entry.ref:undefined,bytes=ref&&entry.bytes;
    if(!bytes)throw Error('Requested asset is unavailable in this project.');
    emit({type:'blob',ref,bytes:hex(bytes)});return;
   }
   if(value.type==='blob'){
    const job=pending.get(value.ref?.hash);if(!job)throw Error('Unrequested peer asset.');
    // installBlob in the isolated preview checks both the expected size and hash.
    clearTimeout(job.timer);pending.delete(value.ref.hash);job.resolve(unhex(value.bytes));return;
   }
   if(value.type!=='update')throw Error('Invalid replica message.');
   if(typeof value.bytes!=='string'||value.bytes.length/2+queuedBytes>MAX_RETAINED_BYTES)throw Error('Peer receive queue exceeds the 96 MiB limit.');
   const update=unhex(value.bytes);queuedBytes+=update.byteLength;
   waiting.push(update);
   // Mesh peers can forward the same history while signatures are verified.
   // Coalesce waiting CRDT bytes instead of treating those duplicates as work.
   if(waiting.length>1){const size=waiting.reduce((sum,bytes)=>sum+bytes.byteLength,0),merged=Y.mergeUpdates(waiting);waiting=[merged];queuedBytes+=merged.byteLength-size;}
   void drain();
  }catch(error){fail(error);}
 }
 async function prepareVectors(){
  if(preparing)return;preparing=true;
  try{while(!closed&&nextVector){
    // A review decision holds the editor while it signs and commits against the saved head.
    // Proofs written now would be saved under it, and it would have to be prepared again.
    if(pipeline.isComposing?.()){await new Promise(resolve=>setTimeout(resolve,50));continue;}
    const value=nextVector;nextVector=undefined;
    if(value.requestVector===true)sync();
    // Keep recently advertised immutable bytes alive while the peer pulls them,
    // even if the local asset is replaced before its request arrives.
    for(const ref of blobRefs(doc)){const bytes=knownBlob(doc,ref.hash);if(bytes&&!offered.has(ref.hash)){offered.set(ref.hash,{ref,bytes});offeredBytes+=bytes.length;}}
    while(offeredBytes>128*1024*1024||offered.size>1024){const [hash,entry]=offered.entries().next().value;offeredBytes-=entry.bytes.length;offered.delete(hash);}
    const snapshot=cloneProject(doc);
    try{
     if(identity)await signRecords(snapshot,identity,{trusted:doc,legacy});
     if(!activeLineage())return;validatePeerState(snapshot);
     if(pipeline.isComposing?.()){nextVector={...value,full:value.full||nextVector?.full,requestVector:false,bytes:nextVector?.bytes??value.bytes};continue;}
     if(identity)Y.applyUpdate(doc,Y.encodeStateAsUpdate(snapshot));
     emit({type:'update',bytes:hex(Y.encodeStateAsUpdate(snapshot,value.full?undefined:unhex(value.bytes)))});
    }finally{snapshot.destroy();}
  }}catch(error){fail(error);}finally{preparing=false;}
 }
 async function drain(){
  if(processing)return;processing=true;
  try{while(!closed&&waiting.length){
   const update=waiting.shift();
   try{
    Y.applyUpdate(remote,update);const state=Y.encodeStateAsUpdate(remote);
    if(state.byteLength>MAX_RETAINED_BYTES)throw Error('Peer retained state exceeds the 96 MiB limit.');
    if(remote.store.pendingStructs||remote.store.pendingDs){sync(true);continue;}
    receivedState=true;await receiveReplica({doc,lineage,update:state,pull,...pipeline,isActive:()=>!closed&&(pipeline.isActive?.()??true)});
   }finally{queuedBytes-=update.byteLength;}
  }}catch(error){fail(error);}finally{processing=false;}
 }
 function close(){if(closed)return;closed=true;waiting=[];nextVector=undefined;clearTimeout(wake);clearInterval(timer);doc.off('update',changed);remote.destroy();offered.clear();unregister();for(const job of pending.values()){clearTimeout(job.timer);job.reject(Error('Session closed.'));}pending.clear();}
 const timer=setInterval(sync,pollMs);doc.on('update',changed);
 return{receive,sync,close,start(){emit({type:'hello',version:2,schema:SCHEMA_VERSION,lineage,rights:'full-editor'});},get ready(){return ready;}};
}

// A full 96 MiB state is hex-encoded inside a small JSON message.
const MAX_MESSAGE=192*1024*1024+4096,HEADER=12;
export function chunkFrames(bytes,maxMessageSize=16384,id=1){
 const size=Math.min(maxMessageSize||16384,16384)-HEADER;
 if(size<1||bytes.byteLength>MAX_MESSAGE)throw Error('Invalid direct message size.');
 return(function*(){for(let offset=0;offset<bytes.length;offset+=size){const part=bytes.subarray(offset,offset+size),frame=new Uint8Array(HEADER+part.length),view=new DataView(frame.buffer);view.setUint32(0,id);view.setUint32(4,bytes.length);view.setUint32(8,offset);frame.set(part,HEADER);yield frame;}})();
}
export function frameReceiver({onMessage,onError=()=>{},timeoutMs=20000,maxMessage=()=>MAX_MESSAGE}){
 let buffer,identity,offset=0,timer,totalTimer;
 function close(){clearTimeout(timer);clearTimeout(totalTimer);buffer=undefined;offset=0;}
 return{close,receive(frame){try{
  if(!(frame instanceof ArrayBuffer)||frame.byteLength<=HEADER||frame.byteLength>16384)throw Error('Invalid direct frame.');
  const view=new DataView(frame),id=view.getUint32(0),total=view.getUint32(4),at=view.getUint32(8),bytes=new Uint8Array(frame,HEADER);
  if(!buffer){if(at!==0||total<1||total>Math.min(MAX_MESSAGE,maxMessage()))throw Error('Invalid direct assembly.');buffer=new Uint8Array(total);identity=id;totalTimer=setTimeout(()=>{close();onError(Error('Direct transfer deadline.'));},120000);}
  if(id!==identity||total!==buffer.length||at!==offset||offset+bytes.length>total)throw Error('Out-of-order direct frame.');
  clearTimeout(timer);timer=setTimeout(()=>{close();onError(Error('Incomplete direct message.'));},timeoutMs);
  buffer.set(bytes,offset);offset+=bytes.length;
  if(offset===total){const message=buffer;close();onMessage(message);}
 }catch(error){close();onError(error);}}};
}
