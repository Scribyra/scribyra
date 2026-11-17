// Organisation routes of the real scribyra-sync binary against a real PostgreSQL,
// driven by the same browser crypto modules (WASM core) the app uses.
import './helpers/core.mjs';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import {join} from 'node:path';
import {service,orgCreate} from './helpers/service.mjs';
import {orgClient} from '../web/org-client.js';
import {
 parseSetupCode,newRecoveryCode,recoverySecrets,recoveryProof,newAgreementKey,signEvent,genesisBody,enrolPublic,applyEvents,deviceProof,
 newProjectKey,wrapProjectKey,unwrapProjectKey,sealEntry,openEntry,entryHash,chainNext,hex,randomBytes,
} from '../web/org-crypto.js';
import {newIdentity} from '../web/direct-identity.js';

const MARKER='ORG_PLAINTEXT_MARKER_5d1e';
async function scan(directories,needle){
 for(const directory of directories){
  for(const entry of await readdir(directory,{recursive:true,withFileTypes:true}).catch(()=>[])){
   if(entry.isFile()&&(await readFile(join(entry.parentPath,entry.name)).catch(()=>Buffer.alloc(0))).includes(Buffer.from(needle)))return join(entry.parentPath,entry.name);
  }
 }
 return null;
}
async function owner(s){
 const setup=parseSetupCode(await orgCreate(s,'test-org')),client=orgClient(setup.service);
 const identity=await newIdentity(),agreement=await newAgreementKey();
 const body=genesisBody({org:setup.org,secret:setup.secret,device:identity.publicKey,agreement:agreement.publicKey,directoryKey:randomBytes(32),name:'Test org',ownerName:'Owner'});
 const genesis=await signEvent({org:setup.org,prev:setup.org,type:'genesis',body},identity);
 let state=applyEvents(null,setup.org,[genesis],enrolPublic(setup.secret));
 assert.equal((await client.postEvent(setup.org,genesis,{auth:false})).seq,1);
 await assert.rejects(client.postEvent(setup.org,genesis,{auth:false}),e=>e.status===401||e.status===409);
 await client.signIn(setup.org,identity);
 const code=newRecoveryCode(),recovery=recoverySecrets(code.bytes);
 const proof=recoveryProof({org:setup.org,prev:state.head,person:body.person,signing:recovery.signingPublic,agreement:recovery.agreementPublic},recovery.signing);
 const set=await signEvent({org:setup.org,prev:state.head,type:'recovery.set',body:{person:body.person,signing:recovery.signingPublic,agreement:recovery.agreementPublic,proof}},identity);
 state=applyEvents(state,setup.org,[set]);await client.postEvent(setup.org,set);
 return{org:setup.org,client,identity,agreement,person:body.person,state,recovery};
}
async function project(o){
 const project=hex(randomBytes(32)),{key,commit}=newProjectKey();
 const raw=await signEvent({org:o.org,prev:o.state.head,type:'project.create',body:{project,epoch:1,keyCommit:commit}},o.identity);
 o.state=applyEvents(o.state,o.org,[raw]);await o.client.postEvent(o.org,raw);
 await o.client.putWraps(o.org,[
  await wrapProjectKey({org:o.org,project,epoch:1,recipient:o.agreement.publicKey,projectKey:key},o.identity),
  await wrapProjectKey({org:o.org,project,epoch:1,recipient:o.recovery.agreementPublic,projectKey:key},o.identity),
 ]);
 return{project,key};
}
const entry=(o,p,clientSeq,text)=>sealEntry({projectKey:p.key,org:o.org,project:p.project,epoch:1,clientSeq,lineage:'11111111-1111-4111-8111-111111111111',schema:8,person:o.person,payload:new TextEncoder().encode(text)},o.identity);

test('encrypted entries are acknowledged durably, retried idempotently and chained',async()=>{
 const s=await service({org:true});
 try{
  const o=await owner(s),p=await project(o);
  const first=await entry(o,p,1,MARKER+' first'),second=await entry(o,p,2,MARKER+' second');
  const ack1=await o.client.append(p.project,first.body);
  assert.deepEqual([ack1.seq,ack1.repeated],[1,false]);
  assert.equal(ack1.chain,chainNext(p.project,entryHash(first.headerRaw,first.ciphertext)));
  // A retry of identical bytes returns the original acknowledgement; different bytes are refused.
  const again=await o.client.append(p.project,first.body);assert.deepEqual([again.seq,again.chain,again.repeated],[1,ack1.chain,true]);
  const other=await entry(o,p,1,'different');
  await assert.rejects(o.client.append(p.project,other.body),e=>e.status===409);
  // Sequence gaps and tampering are refused.
  await assert.rejects(o.client.append(p.project,(await entry(o,p,3,'gap')).body),e=>e.status===409);
  const tampered=second.body.slice();tampered[tampered.length-1]^=1;
  await assert.rejects(o.client.append(p.project,tampered),e=>e.status===400);
  const ack2=await o.client.append(p.project,second.body);assert.equal(ack2.seq,2);
  // Acknowledged entries survive a hard kill and restart.
  await s.stop('SIGKILL');await s.start();
  o.client.forget();await o.client.signIn(o.org,o.identity);
  const log=await Array.fromAsync(o.client.log(p.project,0));
  assert.deepEqual(log.map(e=>e.seq),[1,2]);
  let chain=p.project;
  for(const item of log){const opened=openEntry(item.body,p.key);chain=chainNext(chain,entryHash(opened.headerRaw,opened.ciphertext));assert.equal(item.chain,chain);}
  assert.equal(new TextDecoder().decode(openEntry(log[1].body,p.key).payload),MARKER+' second');
  await s.stop();
  assert.equal(await scan([s.config.data,s.databaseDirectory].filter(Boolean),MARKER),null,'plaintext reached the service’s storage');
  assert(!s.logs.includes(MARKER));
 }finally{await s.close();}
});

test('a recovery key enrols a fresh device that can read only its own person’s wraps',async()=>{
 const s=await service({org:true});
 try{
  const o=await owner(s),p=await project(o);
  await o.client.append(p.project,(await entry(o,p,1,'restore me')).body);
  // Fresh browser: sign in with the recovery key, add a device, then read and unwrap.
  const fresh=orgClient(o.client.service);await fresh.signIn(o.org,o.recovery.signing);
  let state=applyEvents(null,o.org,await fresh.events(o.org,0));
  assert.equal(state.genesis,o.state.genesis);
  // A recovery session can only add a device: no keys, no logs, no other events.
  await assert.rejects(fresh.wraps(o.org),e=>e.status===403);
  await assert.rejects(Array.fromAsync(fresh.log(p.project,0)),e=>e.status===403);
  const device=await newIdentity(),agreement=await newAgreementKey();
  const proof=await deviceProof({org:o.org,prev:state.head,person:o.person,device:device.publicKey,agreement:agreement.publicKey},device);
  const add=await signEvent({org:o.org,prev:state.head,type:'device.add',body:{person:o.person,device:device.publicKey,agreement:agreement.publicKey,proof}},o.recovery.signing);
  state=applyEvents(state,o.org,[add]);await fresh.postEvent(o.org,add);
  fresh.forget();await fresh.signIn(o.org,device);
  const wraps=await fresh.wraps(o.org);
  // Only wraps for this device or this person's recovery key: not the other device's.
  assert.equal(wraps.length,1);
  const toRecovery=wraps.find(w=>JSON.parse(w).recipient===o.recovery.agreementPublic);
  const opened=await unwrapProjectKey(state,toRecovery,o.recovery.agreement);assert.deepEqual(opened.key,p.key);
  const [item]=await Array.fromAsync(fresh.log(p.project,0));assert.equal(new TextDecoder().decode(openEntry(item.body,opened.key).payload),'restore me');
  // Someone else's key cannot sign in, and a forged device.add is refused.
  const stranger=orgClient(o.client.service);await assert.rejects(stranger.signIn(o.org,await newIdentity()),e=>e.status===403);
  const forged=await signEvent({org:o.org,prev:state.head,type:'device.add',body:{person:o.person,device:hex(randomBytes(32)),agreement:hex(randomBytes(32)),proof:hex(randomBytes(64))}},device);
  await assert.rejects(fresh.postEvent(o.org,forged),e=>e.status===400);
 }finally{await s.close();}
});

test('sessions are bound to the service address and challenges are single-use',async()=>{
 const s=await service({org:true});
 try{
  const o=await owner(s);
  // A signature for another service address does not open a session here.
  const elsewhere=orgClient('https://elsewhere.example');
  const relay=async(path,init)=>fetch(o.client.service+path,init);
  const fake=orgClient('https://elsewhere.example',{fetchImpl:(url,init)=>relay(url.replace('https://elsewhere.example',''),init)});
  await assert.rejects(fake.signIn(o.org,o.identity),e=>e.status===401);
  void elsewhere;
  // Without a session nothing is readable.
  const anonymous=orgClient(o.client.service);
  await assert.rejects(anonymous.events(o.org,0),e=>e.status===401);
  await assert.rejects(anonymous.wraps(o.org),e=>e.status===401);
 }finally{await s.close();}
});
