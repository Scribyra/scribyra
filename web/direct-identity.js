import {openDB,deleteDB} from 'idb';
import {hex,unhex} from './replication.js';
import {randomId} from './service-client.js';
const encode=value=>new TextEncoder().encode(JSON.stringify(value));
export const digest=async value=>hex(new Uint8Array(await crypto.subtle.digest('SHA-256',encode(value))));
const CANNOT_START='Direct sessions cannot start in this browser: ';
const REMEDY=' Use a current Chromium, Firefox or Safari over HTTPS or localhost. Your project and local editing are unaffected.';
export class DirectUnsupportedError extends Error{name='DirectUnsupportedError';constructor(problem){super(CANNOT_START+problem+REMEDY);}}
// Linux WebKit (libgcrypt) measured 35 OperationErrors in 3,000 Ed25519 generations,
// with 9,000 sign/verify rounds on the keys it did return all succeeding. A failed
// generation yields no key, so a bounded retry cannot weaken the one it returns.
export async function newIdentity(){
 if(!globalThis.crypto?.subtle)throw new DirectUnsupportedError('Web Crypto is unavailable on this page.');
 let keys;
 for(let attempt=1;!keys;attempt++){
  try{keys=await crypto.subtle.generateKey('Ed25519',false,['sign','verify']);}
  catch(error){if(error?.name!=='OperationError'||attempt>=8)throw new DirectUnsupportedError('it could not create an Ed25519 signing key.');}
 }
 return{privateKey:keys.privateKey,publicKey:hex(new Uint8Array(await crypto.subtle.exportKey('raw',keys.publicKey)))};
}
let support;
// Every primitive the protocol needs, checked before any project, socket or bearer use.
export function directSupport(){
 return support||=(async()=>{
  try{
   if(!globalThis.crypto?.subtle)throw new DirectUnsupportedError('Web Crypto is unavailable on this page.');
   if(!globalThis.navigator?.locks)throw new DirectUnsupportedError('it does not provide Web Locks.');
   if(!globalThis.indexedDB)throw new DirectUnsupportedError('it does not provide IndexedDB for the signing key.');
   if(typeof globalThis.RTCPeerConnection?.generateCertificate!=='function')throw new DirectUnsupportedError('it does not provide WebRTC certificates.');
   const identity=await newIdentity(),data=new TextEncoder().encode('scribyra-direct-support');
   try{
    const signature=await crypto.subtle.sign('Ed25519',identity.privateKey,data),key=await crypto.subtle.importKey('raw',unhex(identity.publicKey),'Ed25519',false,['verify']);
    if(!await crypto.subtle.verify('Ed25519',key,signature,data))throw Error();
   }catch{throw new DirectUnsupportedError('its Ed25519 signatures do not work.');}
   let fingerprint;try{fingerprint=(await RTCPeerConnection.generateCertificate({name:'ECDSA',namedCurve:'P-256'})).getFingerprints().find(f=>f.algorithm==='sha-256');}catch{}
   if(!fingerprint)throw new DirectUnsupportedError('it cannot create a WebRTC certificate with a SHA-256 fingerprint.');
   return{ok:true};
  }catch(error){return{ok:false,reason:error instanceof DirectUnsupportedError?error.message:CANNOT_START+'a required browser feature failed.'+REMEDY};}
 })();
}
export async function requireDirectSupport(){const result=await directSupport();if(!result.ok)throw Error(result.reason);}
async function database(){return openDB('scribyra-direct',1,{upgrade(db){db.createObjectStore('profile');db.createObjectStore('contacts');}});}
// The key is created only when the person turns sessions on (`create`), never as a side
// effect of opening a project, deciding a review or opening Share with sessions off.
export async function profileIdentity({create=false}={}){
 if(!navigator.locks)throw new DirectUnsupportedError('it does not provide Web Locks.');
 return navigator.locks.request('scribyra:direct-identity',async()=>{
  let identity;
  try{const db=await database();try{identity=await db.get('profile','identity');if(!identity&&create){identity=await newIdentity();await db.put('profile',identity,'identity');}}finally{db.close();}}
  catch(error){if(error instanceof DirectUnsupportedError)throw error;throw new DirectUnsupportedError('it could not keep the signing key in browser storage (private windows can block this).');}
  if(!identity)throw Error('Turn on experimental direct sessions first. That creates this browser’s signing key.');
  return identity;
 });
}
// Deleting the key also forgets pinned contacts. Records it signed stay verifiable by others.
export async function deleteProfileIdentity(){
 if(!navigator.locks)throw new DirectUnsupportedError('it does not provide Web Locks.');
 return navigator.locks.request('scribyra:direct-identity',()=>deleteDB('scribyra-direct'));
}
export async function pinContact(key,name){const db=await database();try{await db.put('contacts',{key,name},key);}finally{db.close();}}
export async function pinnedContact(key){const db=await database();try{return await db.get('contacts',key);}finally{db.close();}}
export async function signEnvelope(identity,body){
 const data=JSON.stringify(body),signature=hex(new Uint8Array(await crypto.subtle.sign('Ed25519',identity.privateKey,new TextEncoder().encode(data))));
 return{data,signature,key:identity.publicKey};
}
export async function verifyEnvelope(envelope){
 if(!envelope||typeof envelope.data!=='string'||envelope.data.length>24000||!/^[0-9a-f]{64}$/.test(envelope.key)||!/^[0-9a-f]{128}$/.test(envelope.signature))throw Error('Invalid signed signaling.');
 const key=await crypto.subtle.importKey('raw',unhex(envelope.key),'Ed25519',false,['verify']);
 if(!await crypto.subtle.verify('Ed25519',key,unhex(envelope.signature),new TextEncoder().encode(envelope.data)))throw Error('Tampered direct-session envelope.');
 return JSON.parse(envelope.data);
}
export function fingerprint(sdp){
 const values=[...sdp.matchAll(/^a=fingerprint:sha-256 ([0-9a-f:]+)\r?$/gim)].map(m=>m[1].toLowerCase());
 if(!values.length||new Set(values).size!==1||!/^([0-9a-f]{2}:){31}[0-9a-f]{2}$/.test(values[0]))throw Error('Missing or inconsistent DTLS fingerprint.');
 return values[0];
}
export async function committedIdentity(identity,certificate){
 const value={key:identity.publicKey,nonce:randomId(),fingerprint:certificate.getFingerprints().find(f=>f.algorithm==='sha-256').value.toLowerCase()};
 return{value,commit:await digest(['scribyra-direct-commit',1,value])};
}
// A closed shape keeps the hashed reveal to the committed fields and nothing the sender can pad.
export function validReveal(value,key){
 if(!value||Object.keys(value).sort().join(',')!=='fingerprint,key,nonce'||value.key!==key||typeof value.nonce!=='string'||!/^[0-9a-f]{32,64}$/.test(value.nonce)||typeof value.fingerprint!=='string'||!/^([0-9a-f]{2}:){31}[0-9a-f]{2}$/.test(value.fingerprint))throw Error('Invalid peer identity reveal.');
 return value;
}
export async function verifyCommit(commit,value){if(await digest(['scribyra-direct-commit',1,value])!==commit)throw Error('Peer identity commitment changed.');}
export async function comparisonCode(scope,a,b){return(await digest(['scribyra-direct-compare',1,scope,...[a,b].sort((x,y)=>x.key<y.key?-1:1)])).slice(0,12).match(/.{4}/g).join(' ');}
export async function rendezvous(invite,minute=Math.floor(Date.now()/60000)){
 return{version:1,room:await digest(['scribyra-direct-room',invite.room,minute]),key:await digest(['scribyra-direct-key',invite.key,minute])};
}
function validInvite(value){
 if(!value||Object.keys(value).sort().join(',')!=='identity,key,lineage,room,version'||value.version!==1||!['room','key','identity'].every(k=>/^[0-9a-f]{64}$/.test(value[k]))||typeof value.lineage!=='string'||!/^([0-9a-f]{8})(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value.lineage))throw Error('Unsupported direct-session invite.');
 return value;
}
export function encodeInvite(value){
 validInvite(value);const bytes=new Uint8Array(113);bytes[0]=1;
 bytes.set(unhex(value.room),1);bytes.set(unhex(value.key),33);bytes.set(unhex(value.identity),65);bytes.set(unhex(value.lineage.replaceAll('-','')),97);
 return btoa(String.fromCharCode(...bytes)).replaceAll('+','-').replaceAll('/','_').replace(/=+$/,'');
}
export function parseInvite(text){
 try{
  const fragment=new URL(text,globalThis.location?.href||'http://localhost').hash;
  if(!/^#direct=[A-Za-z0-9_-]{151}$/.test(fragment))throw Error();
  const bytes=Uint8Array.from(atob(fragment.slice(8).replaceAll('-','+').replaceAll('_','/')+'='),c=>c.charCodeAt(0));
  if(bytes.length!==113||bytes[0]!==1)throw Error();const lineage=hex(bytes.slice(97));
  return validInvite({version:1,room:hex(bytes.slice(1,33)),key:hex(bytes.slice(33,65)),identity:hex(bytes.slice(65,97)),lineage:lineage.replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/,'$1-$2-$3-$4-$5')});
 }catch{throw Error('Invalid or unsupported direct-session invite.');}
}
