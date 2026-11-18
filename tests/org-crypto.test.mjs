import './helpers/core.mjs';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {
 parseKit,formatKit,newRecoveryCode,recoverySecrets,newAgreementKey,signEvent,genesisBody,applyEvents,
 newProjectKey,wrapProjectKey,unwrapProjectKey,sealEntry,openEntry,entryHash,chainNext,b64url,hex,randomBytes,deviceProof,recoveryProof,
} from '../web/org-crypto.js';
import {newIdentity} from '../web/direct-identity.js';

const org=hex(randomBytes(32)),service='http://127.0.0.1:8787';
async function owner(){
 const identity=await newIdentity(),agreement=await newAgreementKey();
 const body=genesisBody({org,device:identity.publicKey,agreement:agreement.publicKey,directoryKey:randomBytes(32),name:'Test org',ownerName:'Owner'});
 const raw=await signEvent({org,prev:org,type:'genesis',body},identity);
 let state=applyEvents(null,org,[raw]);
 const code=newRecoveryCode(),recovery=recoverySecrets(code.bytes);
 const proof=recoveryProof({org,prev:state.head,person:body.person,signing:recovery.signingPublic,agreement:recovery.agreementPublic},recovery.signing);
 const set=await signEvent({org,prev:state.head,type:'recovery.set',body:{person:body.person,signing:recovery.signingPublic,agreement:recovery.agreementPublic,proof}},identity);
 state=applyEvents(state,org,[set]);
 return{identity,agreement,person:body.person,state,code,recovery,events:[raw,set]};
}

test('recovery kits parse strictly',()=>{
 assert.throws(()=>parseKit(`scribyra-recovery:1:${b64url(new TextEncoder().encode('http://example.org'))}:${org}:${org}:x`),/https/);
 const code=newRecoveryCode(),genesis=hex(randomBytes(32)),kit=formatKit({service,org,genesis,code:code.text});
 const back=parseKit(kit);assert.equal(back.org,org);assert.equal(back.genesis,genesis);assert.deepEqual(back.code,code.bytes);
 const typo=kit.replace(/(scribyra-recovery:1:[^:]+:[^:]+:[^:]+:)(.)/,(m,a,c)=>a+(c==='A'?'B':'A'));
 assert.throws(()=>parseKit(typo),/mistyped|character|length/);
});

test('genesis is the owner device’s own, without setup code or mode; device.add by recovery needs proof of possession',async()=>{
 const o=await owner();
 assert.equal(o.state.persons[o.person].role,'owner');
 assert.equal('mode' in o.state||'adminRead' in o.state||'enrol' in o.state||'invites' in o.state,false);
 // A genesis carrying the removed setup-code or mode fields is refused by the shared rules.
 const old=JSON.parse(o.events[0]);
 for(const [field,value] of [['enrol','00'.repeat(32)],['mode','managed'],['adminRead',true]]){
  const raw=await signEvent({org,prev:org,type:'genesis',body:{...old.body,[field]:value}},o.identity);
  assert.throws(()=>applyEvents(null,org,[raw]),/invalid membership event body/,field);
 }
 // Invitations are no membership events any more.
 const invite=await signEvent({org,prev:o.state.head,type:'invite.create',body:{invite:'00'.repeat(16)}},o.identity);
 assert.throws(()=>applyEvents(o.state,org,[invite]),/unsupported membership event type/);
 const fresh=await newIdentity(),agreement=await newAgreementKey();
 const proof=await deviceProof({org,prev:o.state.head,person:o.person,device:fresh.publicKey,agreement:agreement.publicKey},fresh);
 const add=await signEvent({org,prev:o.state.head,type:'device.add',body:{person:o.person,device:fresh.publicKey,agreement:agreement.publicKey,proof}},o.recovery.signing);
 const state=applyEvents(o.state,org,[add]);assert.equal(state.devices[fresh.publicKey].person,o.person);
 const stolen=await deviceProof({org,prev:o.state.head,person:o.person,device:fresh.publicKey,agreement:agreement.publicKey},await newIdentity());
 const forged=await signEvent({org,prev:o.state.head,type:'device.add',body:{person:o.person,device:fresh.publicKey,agreement:agreement.publicKey,proof:stolen}},o.recovery.signing);
 assert.throws(()=>applyEvents(o.state,org,[forged]),/possession/);
 // A proof made for another log position cannot be replayed later.
 const stale=await deviceProof({org,prev:org,person:o.person,device:fresh.publicKey,agreement:agreement.publicKey},fresh);
 const replayed=await signEvent({org,prev:o.state.head,type:'device.add',body:{person:o.person,device:fresh.publicKey,agreement:agreement.publicKey,proof:stale}},o.recovery.signing);
 assert.throws(()=>applyEvents(o.state,org,[replayed]),/possession/);
 // A recovery key must be proven by its own signing key, and must be a usable X25519 key.
 const other=recoverySecrets(newRecoveryCode().bytes),unproven=await signEvent({org,prev:o.state.head,type:'recovery.set',body:{person:o.person,signing:other.signingPublic,agreement:other.agreementPublic,proof:recoveryProof({org,prev:o.state.head,person:o.person,signing:other.signingPublic,agreement:other.agreementPublic},o.recovery.signing)}},o.identity);
 assert.throws(()=>applyEvents(o.state,org,[unproven]),/not proven/);
 const lowOrder='0000000000000000000000000000000000000000000000000000000000000000',weak=await signEvent({org,prev:o.state.head,type:'recovery.set',body:{person:o.person,signing:other.signingPublic,agreement:lowOrder,proof:recoveryProof({org,prev:o.state.head,person:o.person,signing:other.signingPublic,agreement:lowOrder},other.signing)}},o.identity);
 assert.throws(()=>applyEvents(o.state,org,[weak]),/invalid recovery keys/);
 // The same browser may come back with a new agreement key (its old one was lost), signed by the kit.
 const again=await newAgreementKey(),rekeyProof=await deviceProof({org,prev:state.head,person:o.person,device:fresh.publicKey,agreement:again.publicKey},fresh);
 const rekey=await signEvent({org,prev:state.head,type:'device.add',body:{person:o.person,device:fresh.publicKey,agreement:again.publicKey,proof:rekeyProof}},o.recovery.signing);
 assert.equal(applyEvents(state,org,[rekey]).devices[fresh.publicKey].agreement,again.publicKey);
});

test('project keys wrap to the device and the recovery key, and entries seal, verify and chain',async()=>{
 const o=await owner(),project=hex(randomBytes(32)),{key,commit}=newProjectKey();
 const create=await signEvent({org,prev:o.state.head,type:'project.create',body:{project,epoch:1,keyCommit:commit}},o.identity);
 const state=applyEvents(o.state,org,[create]);
 const toDevice=await wrapProjectKey({org,project,epoch:1,recipient:o.agreement.publicKey,projectKey:key},o.identity);
 const toRecovery=await wrapProjectKey({org,project,epoch:1,recipient:o.recovery.agreementPublic,projectKey:key},o.identity);
 assert.deepEqual((await unwrapProjectKey(state,toDevice,o.agreement)).key,key);
 assert.deepEqual((await unwrapProjectKey(state,toRecovery,o.recovery.agreement)).key,key);
 await assert.rejects(unwrapProjectKey(state,toDevice,o.recovery.agreement),/could not be opened/);
 // A wrap of some other key fails the epoch's key commitment.
 const other=await wrapProjectKey({org,project,epoch:1,recipient:o.agreement.publicKey,projectKey:randomBytes(32)},o.identity);
 await assert.rejects(unwrapProjectKey(state,other,o.agreement),/does not match/);
 const tampered=JSON.parse(toDevice);tampered.epoch=2;
 await assert.rejects(unwrapProjectKey(state,JSON.stringify(tampered)));

 const payload=new TextEncoder().encode('SECRET_MARKER_payload');
 const sealed=await sealEntry({projectKey:key,org,project,epoch:1,clientSeq:1,lineage:'00000000-0000-4000-8000-000000000000',schema:8,person:o.person,payload},o.identity);
 assert.equal(Buffer.from(sealed.body).includes(Buffer.from('SECRET_MARKER')),false);
 const opened=openEntry(sealed.body,key);
 assert.deepEqual([...opened.payload],[...payload]);assert.equal(opened.meta.person,o.person);
 const flipped=sealed.body.slice();flipped[flipped.length-1]^=1;
 assert.throws(()=>openEntry(flipped,key),/signature/);
 assert.throws(()=>openEntry(sealed.body,randomBytes(32)),/decrypted/);
 const h=entryHash(sealed.headerRaw,sealed.ciphertext);assert.match(chainNext(project,h),/^[0-9a-f]{64}$/);
});

test('a service cannot make the app open a script address or approve a swapped device',async()=>{
 const {signInUrl,newDeviceCode,deviceCodeMac,newAgreementKey:agreement}=await import('../web/org-crypto.js');
 // Browser review C1: only https (or http on this computer) sign-in addresses are opened.
 for(const bad of ['javascript:alert(1)','data:text/html,x','http://idp.example.org/authorize','file:///etc/passwd','not a url'])assert.throws(()=>signInUrl(bad));
 assert.equal(signInUrl('https://idp.example.org/authorize?x=1'),'https://idp.example.org/authorize?x=1');
 assert.equal(signInUrl('http://127.0.0.1:9/authorize'),'http://127.0.0.1:9/authorize');
 // Browser review H1: the code typed on the existing device must match the keys the new browser sent.
 const code=newDeviceCode(),device=hex(randomBytes(32)),{publicKey}=await agreement(),other=(await agreement()).publicKey;
 assert.match(code,/^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/);
 const mac=deviceCodeMac(code,device,publicKey);
 assert.equal(deviceCodeMac(code.toLowerCase().replaceAll('-',' '),device,publicKey),mac);
 assert.notEqual(deviceCodeMac(code,device,other),mac);
 assert.notEqual(deviceCodeMac(newDeviceCode(),device,publicKey),mac);
});
