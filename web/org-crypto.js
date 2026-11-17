// Organisation sync cryptography in the browser. Signing and verification rules,
// canonical JSON, AEAD and key derivation come from the shared Rust core (WASM), so
// the service checks exactly the bytes signed here. Device private keys stay in
// WebCrypto as non-extractable keys; only short-lived secrets (a recovery code's
// derived keys, ephemeral wrap keys, project keys in use) pass through WASM memory.
import {
 org_canonical,org_seal,org_open,org_hkdf,org_sha256_hex,org_ed25519_public,org_ed25519_sign,org_x25519_public,org_x25519_shared,
 org_enrol_seed,org_enrol_message,org_recovery_secrets,org_encode_recovery_code,org_decode_recovery_code,org_key_commit,org_project_subkey,
 org_person_id,org_event_signing_message,org_device_proof_message,org_recovery_proof_message,org_wrap_signing_message,org_wrap_context,org_check_wrap,
 org_entry_signing_message,org_verify_entry,org_entry_hash,org_chain_next,org_apply_events,
 org_invite_message,org_device_request_message,org_wrap_recipients,
 org_seal_object,org_open_object,org_object_parts,org_object_variants,org_check_blobref,
} from './pkg/scribyra_app.js';

const encoder=new TextEncoder(),decoder=new TextDecoder();
export const randomBytes=n=>crypto.getRandomValues(new Uint8Array(n));
export function hex(bytes){return Array.from(bytes,b=>b.toString(16).padStart(2,'0')).join('');}
export function unhex(text,length){
 if(typeof text!=='string'||!/^([0-9a-f]{2})*$/.test(text)||(length!==undefined&&text.length!==length*2))throw Error('Invalid hexadecimal value.');
 return Uint8Array.from(text.match(/../g)||[],x=>parseInt(x,16));
}
export const b64url=bytes=>btoa(String.fromCharCode(...bytes)).replaceAll('+','-').replaceAll('/','_').replace(/=+$/,'');
export function unb64url(text){
 if(typeof text!=='string'||!/^[A-Za-z0-9_-]*$/.test(text))throw Error('Invalid encoded value.');
 const padded=text.replaceAll('-','+').replaceAll('_','/')+'='.repeat((4-text.length%4)%4);
 return Uint8Array.from(atob(padded),c=>c.charCodeAt(0));
}
const concat=(...parts)=>{const out=new Uint8Array(parts.reduce((n,p)=>n+p.length,0));let at=0;for(const p of parts){out.set(p,at);at+=p.length;}return out;};
const u32=n=>{const b=new Uint8Array(4);new DataView(b.buffer).setUint32(0,n);return b;};
export const canonical=value=>org_canonical(JSON.stringify(value));
export const sha256Hex=bytes=>org_sha256_hex(bytes);

// --- Service addresses, setup codes and recovery kits

export function serviceOrigin(text){
 let url;try{url=new URL(text);}catch{throw Error('The service address is not a valid URL.');}
 const local=['127.0.0.1','localhost','[::1]'].includes(url.hostname);
 if(url.username||url.password||url.search||url.hash||(url.pathname!=='/'&&url.pathname!==''))throw Error('Use the service address only, such as https://sync.example.org.');
 if(url.protocol!=='https:'&&!(url.protocol==='http:'&&local))throw Error('The service must use https (plain http only on this computer).');
 return url.origin;
}
/** `scribyra-setup:1:<base64url service origin>:<org hex>:<base64url 32-byte secret>` from `scribyra-sync org create`. */
export function parseSetupCode(text){
 const parts=String(text||'').trim().split(':');
 if(parts.length!==5||parts[0]!=='scribyra-setup'||parts[1]!=='1')throw Error('This is not a Scribyra setup code. Copy the whole line printed by “scribyra-sync org create”.');
 const service=serviceOrigin(decoder.decode(unb64url(parts[2]))),org=parts[3],secret=unb64url(parts[4]);
 unhex(org,32);if(secret.length!==32)throw Error('The setup code is incomplete.');
 return{service,org,secret};
}
/** The kit holds what a fresh browser needs: where the service is, which org, which genesis, and the code. */
export function formatKit({service,org,genesis,code}){
 return[
  'Scribyra recovery kit',
  'Keep this private and offline. Anyone with it can restore your backed-up projects.',
  '',
  `Service: ${service}`,
  `Organisation: ${org}`,
  `Code: ${code}`,
  '',
  'Paste this line into Remote backup → Restore from a recovery kit:',
  `scribyra-recovery:1:${b64url(encoder.encode(service))}:${org}:${genesis}:${code.replaceAll('-','')}`,
  '',
 ].join('\n');
}
export function parseKit(text){
 const line=String(text||'').split(/\s+/).find(part=>part.startsWith('scribyra-recovery:'));
 if(!line)throw Error('Paste the line that starts with “scribyra-recovery:” from your recovery kit.');
 const parts=line.split(':');
 if(parts.length!==6||parts[1]!=='1')throw Error('This recovery kit is from an unsupported version.');
 const service=serviceOrigin(decoder.decode(unb64url(parts[2])));unhex(parts[3],32);unhex(parts[4],32);
 return{service,org:parts[3],genesis:parts[4],code:org_decode_recovery_code(parts[5])};
}
export function newRecoveryCode(){const code=randomBytes(32);return{bytes:code,text:org_encode_recovery_code(code)};}
export function recoverySecrets(code){
 const both=org_recovery_secrets(code),signing=both.slice(0,32),agreement=both.slice(32);
 return{signing,agreement,signingPublic:org_ed25519_public(signing),agreementPublic:org_x25519_public(agreement)};
}

// --- Device keys

const X25519={name:'X25519'};
/** A device's X25519 agreement key. With `sealWith` (an at-rest storage key) the private key is
 * also returned sealed as PKCS#8, for browsers that cannot keep an X25519 CryptoKey in IndexedDB;
 * the CryptoKey in memory is non-extractable either way. */
export async function newAgreementKey({sealWith=null,context=''}={}){
 if(!globalThis.crypto?.subtle)throw Error('Remote backup needs Web Crypto, which this page does not provide (use https or localhost).');
 let keys;
 try{keys=await crypto.subtle.generateKey(X25519,!!sealWith,['deriveBits']);}catch{throw Error('This browser cannot create an X25519 key. Use a current Chromium, Firefox or Safari.');}
 const publicKey=hex(new Uint8Array(await crypto.subtle.exportKey('raw',keys.publicKey)));
 if(!sealWith)return{privateKey:keys.privateKey,publicKey};
 const pkcs8=new Uint8Array(await crypto.subtle.exportKey('pkcs8',keys.privateKey));
 try{return{privateKey:await crypto.subtle.importKey('pkcs8',pkcs8,X25519,false,['deriveBits']),publicKey,sealed:await sealAtRest(sealWith,pkcs8,context)};}
 finally{pkcs8.fill(0);}
}
/** Reopens an agreement key sealed by newAgreementKey as a non-extractable CryptoKey. */
export async function openAgreementKey(storageKey,{publicKey,sealed},context){
 const pkcs8=await openAtRest(storageKey,sealed,context);
 try{return{privateKey:await crypto.subtle.importKey('pkcs8',pkcs8,X25519,false,['deriveBits']),publicKey,sealed};}
 finally{pkcs8.fill(0);}
}
/** Sign with a WebCrypto Ed25519 identity ({privateKey,publicKey}) or a raw 32-byte seed. */
export async function sign(signer,message){
 if(signer instanceof Uint8Array)return org_ed25519_sign(signer,message);
 return hex(new Uint8Array(await crypto.subtle.sign('Ed25519',signer.privateKey,message)));
}
export const signerPublic=signer=>signer instanceof Uint8Array?org_ed25519_public(signer):signer.publicKey;
/** A non-extractable AES-GCM key that seals project keys at rest in IndexedDB. */
export const newStorageKey=()=>crypto.subtle.generateKey({name:'AES-GCM',length:256},false,['encrypt','decrypt']);
export async function sealAtRest(key,bytes,context){
 const iv=randomBytes(12);
 return{iv,ct:new Uint8Array(await crypto.subtle.encrypt({name:'AES-GCM',iv,additionalData:encoder.encode(context)},key,bytes))};
}
export async function openAtRest(key,sealed,context){
 return new Uint8Array(await crypto.subtle.decrypt({name:'AES-GCM',iv:sealed.iv,additionalData:encoder.encode(context)},key,sealed.ct));
}

// --- Membership events

export async function signEvent({org,prev,type,body},signer){
 const event={v:1,org,prev,type,body,signer:signerPublic(signer)};
 event.sig=await sign(signer,org_event_signing_message(JSON.stringify(event)));
 return canonical(event);
}
/**
 * The owner's genesis: their device, the org's encryption mode and admin read access, the
 * directory key's commitment and the org's and owner's names sealed under it; the setup
 * code's key signs all of it.
 */
export function genesisBody({org,secret,device,agreement,adminRead=true,mode='e2ee',serviceKey=null,directoryKey,name,ownerName}){
 const enrol=org_enrol_seed(secret),person=org_person_id(org,device);
 const body={person,device,agreement,enrol:org_ed25519_public(enrol),enrolSig:'',mode,adminRead:!!adminRead,
  name:sealName(directoryKey,org,'org',name),directoryCommit:org_key_commit(directoryKey),ownerName:sealName(directoryKey,org,person,ownerName)};
 if(mode==='managed'){if(!serviceKey)throw Error('This service does not offer organisation-managed encryption.');body.serviceKey=serviceKey;}
 body.enrolSig=org_ed25519_sign(enrol,org_enrol_message(org,JSON.stringify(body)));
 return body;
}

// --- Names: sealed under the directory key (people, the org) or a project's name key.

const MAX_NAME=120;
function sealWith(key,context,text){
 const bytes=encoder.encode(String(text||'').trim().slice(0,MAX_NAME));
 if(!bytes.length||bytes.length>256)throw Error('Enter a name.');
 const nonce=randomBytes(24);return hex(concat(nonce,org_seal(key,nonce,encoder.encode(context),bytes)));
}
function openWith(key,context,sealed){
 try{const bytes=unhex(sealed);return decoder.decode(org_open(key,bytes.subarray(0,24),encoder.encode(context),bytes.subarray(24)));}
 catch{return null;}
}
const nameContext=(org,subject)=>`scribyra-name/1\n${org}\n${subject}`;
export function sealName(directoryKey,org,subject,text){const key=org_project_subkey(directoryKey,'name');try{return sealWith(key,nameContext(org,subject),text);}finally{key.fill(0);}}
export function openName(directoryKey,org,subject,sealed){if(!sealed)return null;const key=org_project_subkey(directoryKey,'name');try{return openWith(key,nameContext(org,subject),sealed);}finally{key.fill(0);}}
const projectNameContext=(org,project)=>`scribyra-project-name/1\n${org}\n${project}`;
export function sealProjectName(projectKey,org,project,text){const key=org_project_subkey(projectKey,'name');try{return sealWith(key,projectNameContext(org,project),text||'Untitled project');}finally{key.fill(0);}}
export function openProjectName(projectKey,org,project,sealed){if(!sealed)return null;const key=org_project_subkey(projectKey,'name');try{return openWith(key,projectNameContext(org,project),sealed);}finally{key.fill(0);}}
/** The X25519 keys entitled to a project's key (or the directory key: project = org ID). */
export const wrapRecipients=(state,project)=>JSON.parse(org_wrap_recipients(JSON.stringify(state),project));

// --- Invitation links and device links (fragments: they never reach the app's host).

const seedFrom=(secret,purpose)=>org_hkdf(secret,new Uint8Array(0),encoder.encode(`scribyra/1/${purpose}`),32);
export function inviteSeed(secret){return seedFrom(secret,'invite');}
export function inviteMessage(org,prev,invite,person,device,agreement){return org_invite_message(org,prev,invite,person,device,agreement);}
export function linkSeed(secret){return seedFrom(secret,'device-link');}
export function deviceRequestMessage(org,link,person,device,agreement){return org_device_request_message(org,link,person,device,agreement);}
/** `https://app/#join=…`: everything a joiner needs, including the directory key. */
export function formatInvite(origin,{service,org,genesis,invite,secret,directoryKey}){
 return `${origin}/#join=${b64url(encoder.encode(canonical({v:1,service,org,genesis,invite,secret:hex(secret),directory:hex(directoryKey)})))}`;
}
function fragmentValue(text,name){
 const value=String(text||'').trim(),at=value.indexOf(`#${name}=`);
 const raw=at>=0?value.slice(at+name.length+2):value;
 let parsed;try{parsed=JSON.parse(decoder.decode(unb64url(raw.split(/[&\s]/)[0])));}catch{throw Error('This is not a Scribyra link. Copy the whole link you were sent.');}
 if(!parsed||parsed.v!==1)throw Error('This link is from an unsupported version of Scribyra.');
 return parsed;
}
export function parseInvite(text){
 const p=fragmentValue(text,'join'),service=serviceOrigin(p.service);
 unhex(p.org,32);unhex(p.genesis,32);unhex(p.invite,16);
 return{service,org:p.org,genesis:p.genesis,invite:p.invite,secret:unhex(p.secret,32),directoryKey:unhex(p.directory,32)};
}
export function formatDeviceLink(origin,{service,org,genesis,person,link,secret}){
 return `${origin}/#device=${b64url(encoder.encode(canonical({v:1,service,org,genesis,person,link,secret:hex(secret)})))}`;
}
export function parseDeviceLink(text){
 const p=fragmentValue(text,'device'),service=serviceOrigin(p.service);
 unhex(p.org,32);unhex(p.genesis,32);unhex(p.link,16);
 if(typeof p.person!=='string'||!/^[0-9a-f-]{36}$/.test(p.person))throw Error('This device link is damaged.');
 return{service,org:p.org,genesis:p.genesis,person:p.person,link:p.link,secret:unhex(p.secret,32)};
}
/** The code both devices show while linking: it depends on the link secret and the new keys. */
/** A 12-character code (60 bits) the new browser shows when asking through SSO, and the keyed
 * check over its keys that the existing device verifies after the person types the code. */
const CROCKFORD='0123456789ABCDEFGHJKMNPQRSTVWXYZ';
export function newDeviceCode(){const bytes=randomBytes(12);return Array.from(bytes,b=>CROCKFORD[b&31]).join('').replace(/(.{4})(.{4})(.{4})/,'$1-$2-$3');}
export function deviceCodeMac(code,device,agreement){
 const normal=String(code||'').toUpperCase().replace(/[^0-9A-Z]/g,'').replace(/O/g,'0').replace(/[IL]/g,'1');
 return org_sha256_hex(concat(encoder.encode('scribyra-device-sso/1\n'),encoder.encode(normal),unhex(device,32),unhex(agreement,32)));
}
/** A service-supplied sign-in address may only be https (or http on this computer). */
export function signInUrl(text){
 let url;try{url=new URL(text);}catch{throw Error('The service sent an invalid sign-in address.');}
 const local=['127.0.0.1','localhost','[::1]'].includes(url.hostname);
 if(url.protocol!=='https:'&&!(url.protocol==='http:'&&local))throw Error('The service sent a sign-in address that is not https. Nothing was opened.');
 return url.href;
}
/** `https://app/#org=…`: where to sign in with an organisation's SSO (to ask to join, or to add a browser). */
export function formatOrgLink(origin,{service,org,genesis}){return `${origin}/#org=${b64url(encoder.encode(canonical({v:1,service,org,genesis})))}`;}
export function parseOrgLink(text){const p=fragmentValue(text,'org'),service=serviceOrigin(p.service);unhex(p.org,32);unhex(p.genesis,32);return{service,org:p.org,genesis:p.genesis};}
export function linkCode(secret,device,agreement){
 const digest=org_sha256_hex(concat(encoder.encode('scribyra-device-compare/1'),secret,unhex(device,32),unhex(agreement,32)));
 return(parseInt(digest.slice(0,10),16)%1e8).toString().padStart(8,'0').replace(/(\d{4})(\d{4})/,'$1 $2');
}
export const enrolPublic=secret=>org_ed25519_public(org_enrol_seed(secret));
export const personId=(org,device)=>org_person_id(org,device);
/** Signed by the new device's own key; binds its person, agreement key and log position. */
export async function deviceProof({org,prev,link,person,device,agreement},identity){
 if(link)prev=`link:${link}`;
 return sign(identity,org_device_proof_message(org,prev,person,device,agreement));
}
/** Signed by the recovery signing seed: proves whoever registers it holds the code. */
export function recoveryProof({org,prev,person,signing,agreement},seed){
 return org_ed25519_sign(seed,org_recovery_proof_message(org,prev,person,signing,agreement));
}
/** Replays canonical event strings with the Rust rules; throws on the first invalid one. */
export function applyEvents(state,org,events,expectedEnrol){
 return JSON.parse(org_apply_events(state?JSON.stringify(state):'',org,JSON.stringify(events),expectedEnrol));
}

// --- Project keys and wraps

export function newProjectKey(){const key=randomBytes(32);return{key,commit:org_key_commit(key)};}
const wrapKey=(shared,wrap,context)=>org_hkdf(shared,concat(unhex(wrap.enc,32),unhex(wrap.recipient,32)),encoder.encode('scribyra-wrap/1'+context),32);
/** ECIES-style wrap: fresh X25519, HKDF-SHA-256, XChaCha20-Poly1305 over the canonical context. */
export async function wrapProjectKey({org,project,epoch,recipient,projectKey},sender){
 const ephemeral=randomBytes(32);
 try{
  const wrap={v:1,org,project,epoch,recipient,enc:org_x25519_public(ephemeral),sender:signerPublic(sender)};
  const context=org_wrap_context(JSON.stringify(wrap)),nonce=randomBytes(24);
  const key=wrapKey(org_x25519_shared(ephemeral,recipient),wrap,context);
  wrap.nonce=hex(nonce);wrap.ct=hex(org_seal(key,nonce,encoder.encode(context),projectKey));key.fill(0);
  wrap.sig=await sign(sender,org_wrap_signing_message(JSON.stringify(wrap)));
  return canonical(wrap);
 }finally{ephemeral.fill(0);}
}
/**
 * Opens a wrap after checking it against the membership state (sender is a project
 * member device, recipient a member key, signature valid) and the epoch's key commitment.
 * `recipient` is either {privateKey} (a WebCrypto X25519 device key) or a raw secret.
 */
export async function unwrapProjectKey(state,raw,recipient){
 const context=org_check_wrap(JSON.stringify(state),raw),wrap=JSON.parse(raw);
 const directory=wrap.project===state.org;
 let shared;
 if(recipient instanceof Uint8Array)shared=org_x25519_shared(recipient,wrap.enc);
 else{
  const ephemeral=await crypto.subtle.importKey('raw',unhex(wrap.enc,32),X25519,false,[]);
  shared=new Uint8Array(await crypto.subtle.deriveBits({name:'X25519',public:ephemeral},recipient.privateKey,256));
  if(shared.every(b=>b===0))throw Error('Invalid key wrap.');
 }
 const key=wrapKey(shared,wrap,context);
 let projectKey;
 try{projectKey=org_open(key,unhex(wrap.nonce,24),encoder.encode(context),unhex(wrap.ct,48));}
 catch{throw Error('A project key could not be opened: it was altered or not meant for this key.');}
 finally{key.fill(0);shared.fill(0);}
 // The directory key is checked against the genesis commitment; a project key against its epoch's.
 const commit=directory?state.directoryCommit:state.projects[wrap.project]?.keyCommit,epoch=directory?1:state.projects[wrap.project]?.epoch;
 if(!commit||wrap.epoch!==epoch||org_key_commit(projectKey)!==commit){projectKey.fill(0);throw Error('A key does not match the key it was created with.');}
 return{project:wrap.project,epoch:wrap.epoch,key:projectKey};
}

// --- Log entries

export const keyCommit=key=>org_key_commit(key);
const META_DOMAIN='scribyra-entry';
/** Builds `u32 header length ‖ canonical header ‖ nonce ‖ ciphertext`. */
export async function sealEntry({projectKey,org,project,epoch,clientSeq,lineage,schema,person,payload,kind='update'},identity){
 const header={v:1,org,project,device:signerPublic(identity),clientSeq,kind,epoch};
 const unsigned=canonical(header),meta=encoder.encode(canonical({domain:META_DOMAIN,version:1,lineage,schema,person}));
 const updateKey=org_project_subkey(projectKey,'update'),nonce=randomBytes(24);
 const ciphertext=concat(nonce,org_seal(updateKey,nonce,encoder.encode(unsigned),concat(u32(meta.length),meta,payload)));updateKey.fill(0);
 header.sig=await sign(identity,org_entry_signing_message(unsigned,ciphertext));
 const raw=encoder.encode(canonical(header));
 return{body:concat(u32(raw.length),raw,ciphertext),header:{...header},headerRaw:decoder.decode(raw),ciphertext};
}
/** Checks an entry's shape and signature (Rust) without decrypting it. */
export function verifyEntryBody(body){
 const raw=org_verify_entry(body),length=new DataView(body.buffer,body.byteOffset,4).getUint32(0);
 return{header:JSON.parse(raw),headerRaw:raw,ciphertext:body.subarray(4+length)};
}
/** Verifies the signature (Rust), then decrypts. Returns the header, metadata and Yjs payload. */
export function openEntry(body,projectKey){
 const {header,headerRaw:raw,ciphertext}=verifyEntryBody(body);
 const {sig,...unsigned}=header,updateKey=org_project_subkey(projectKey,'update');
 let plain;
 try{plain=org_open(updateKey,ciphertext.subarray(0,24),encoder.encode(canonical(unsigned)),ciphertext.subarray(24));}
 catch{throw Error('A backed-up change could not be decrypted: it was altered or uses another key.');}
 finally{updateKey.fill(0);}
 const metaLength=new DataView(plain.buffer,plain.byteOffset,4).getUint32(0);
 if(metaLength>1024||plain.length<4+metaLength)throw Error('A backed-up change is malformed.');
 const meta=JSON.parse(decoder.decode(plain.subarray(4,4+metaLength)));
 if(!meta||meta.domain!==META_DOMAIN||meta.version!==1||canonical(meta)!==decoder.decode(plain.subarray(4,4+metaLength)))throw Error('A backed-up change is malformed.');
 if(!Number.isSafeInteger(meta.schema)||meta.schema<1||typeof meta.lineage!=='string'||typeof meta.person!=='string'||Object.keys(meta).length!==5)throw Error('A backed-up change is malformed.');
 return{header,headerRaw:raw,ciphertext,meta,payload:plain.subarray(4+metaLength)};
}
export const entryHash=(headerRaw,ciphertext)=>org_entry_hash(headerRaw,ciphertext);
export const chainNext=(previous,hash)=>org_chain_next(previous,hash);

// --- Encrypted objects (assets and history objects)

/** Number of parts an object of `size` plaintext bytes is sealed in. */
export const objectParts=size=>org_object_parts(size);
/** Alternative IDs an object may be stored under when an ID already holds other bytes. */
export const objectVariants=()=>org_object_variants();
const PART=4*1024*1024;
/** Seals a plaintext object in parts under the epoch's blob key; returns [{id,body,plain}] in order.
 * The bytes must be what `hash` says (checked here and, for one-part objects, in the core). */
export function sealObject({projectKey,org,project,epoch,kind,hash,bytes,variant=0}){
 if(sha256Hex(bytes)!==hash)throw Error('A file on this device does not match its reference. It was not uploaded.');
 const parts=org_object_parts(bytes.length),out=[];
 for(let part=0;part<parts;part++){
  const plain=bytes.subarray(part*PART,Math.min(bytes.length,(part+1)*PART)),sealed=org_seal_object(projectKey,org,project,epoch,kind,hash,part,parts,variant,plain);
  out.push({id:decoder.decode(sealed.subarray(0,64)),body:sealed.subarray(64),plain});
 }
 return out;
}
/** Opens one fetched part; throws if it was altered or belongs elsewhere. */
export function openObjectPart({projectKey,org,project,epoch,kind,hash,part,parts,variant=0,body}){
 try{return org_open_object(projectKey,org,project,epoch,kind,hash,part,parts,variant,body);}
 catch{throw Error('A file from the service could not be decrypted: it was altered or uses another key.');}
}
/** A blobref payload: canonical JSON listing objects uploaded before the entry that uses them. */
export const blobrefPayload=objects=>encoder.encode(canonical({v:1,objects}));
/** Checks a received blobref payload's shape. Its entries are hints where to look, never IDs. */
export const checkBlobref=payload=>JSON.parse(org_check_blobref(payload));
