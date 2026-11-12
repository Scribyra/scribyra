// Records made before a profile had a key, and how a later session shows them (8 November 2026).
import {integrationSession} from './helpers/integration-session.mjs';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import * as Y from 'yjs';
import {SCHEMA_VERSION} from '../web/model.js';
import {cloneProject} from '../web/assets.js';
import {receiveReplica} from '../web/replication.js';
import {newIdentity,signEnvelope} from '../web/direct-identity.js';
import {signRecords,identityAuthorId,keyDerivedId,recordTrust,earlierRecords,claimKey} from '../web/direct-provenance.js';
const ok=reply=>{assert.equal(reply.ok,true,JSON.stringify(reply));return reply.value;};
const noPull=async()=>{throw Error('Unexpected pull');};
const receiver=lineage=>{const doc=new Y.Doc();doc.getMap('meta').set('schemaVersion',SCHEMA_VERSION);doc.getMap('meta').set('lineageId',lineage);return doc;};
const offer=(doc,from,options={})=>receiveReplica({doc,update:Y.encodeStateAsUpdate(from),pull:noPull,...options});
const refused=async(doc,from,options,pattern=/Unverified edit/)=>{const before=Y.encodeStateAsUpdate(doc);await assert.rejects(offer(doc,from,options),pattern);assert.deepEqual(Y.encodeStateAsUpdate(doc),before,'a refused update changed the replica');};
// A project worked on with sessions off: a comment, a reply, a review and two decisions.
async function earlierProject(owner={id:crypto.randomUUID(),kind:'human',displayName:'Earlier author'}){
 const f=await integrationSession({owner}),at=text=>{const start=f.source().indexOf(text);return{fileId:'main',start,end:start+text.length};};
 const thread=ok(await f.call({op:'thread.create',...at('bravo'),body:'Earlier comment'},false)),reply=ok(await f.call({op:'thread.reply',threadId:thread.threadId,body:'Earlier reply'},false));
 const review=ok(await f.call({op:'review.create',title:'Earlier review'},false)),s=ok(await f.call({op:'suggestion.propose',reviewId:review.reviewId,...at('alpha'),before:'alpha',after:'ALPHA'},false));
 ok(await f.call({op:'suggestion.accept',suggestionIds:[s.suggestionId],eventHeads:{[s.suggestionId]:f.heads(s.suggestionId)}},false));
 const decision=[...f.doc.getMap('discussionEvents').values()].find(e=>e.kind==='suggestionAccept').id;
 return{f,owner,thread,reply,review,suggestionId:s.suggestionId,decision,lineage:f.doc.getMap('meta').get('lineageId')};
}

test('local author IDs are random version 4; key-derived IDs are version 8',async()=>{
 const identity=await newIdentity();assert.equal(keyDerivedId(identityAuthorId(identity.publicKey)),true);
 for(let i=0;i<64;i++)assert.equal(keyDerivedId(crypto.randomUUID()),false);
});

test('records and decisions made before a key arrive at a peer as unverified, without blocking the session',async()=>{
 const p=await earlierProject(),peer=receiver(p.lineage);
 try{
  await offer(peer,p.f.doc);
  assert.equal(peer.getMap('messages').get(p.reply.messageId).body,'Earlier reply');
  for(const [root,id]of [['threads',p.thread.threadId],['messages',p.reply.messageId],['suggestions',p.suggestionId],['discussionEvents',p.decision]])assert.equal(recordTrust(peer,root,id,[]),'unverified',root);
  // The sharer sees its own records as its own.
  assert.equal(recordTrust(p.f.doc,'discussionEvents',p.decision,[p.owner.id]),'own');
 }finally{peer.destroy();await p.f.remove();}
});

test('a claim binds earlier records to the new key as claimed, never verified, and earlier decisions stay unapproved',async()=>{
 const p=await earlierProject(),alice=await newIdentity(),aliceId=identityAuthorId(alice.publicKey),shared=cloneProject(p.f.doc),peer=receiver(p.lineage);
 try{
  assert.deepEqual(earlierRecords(shared,aliceId,[p.owner.id]),{records:earlierRecords(shared,aliceId,[p.owner.id]).records,decisions:1,others:earlierRecords(shared,aliceId,[p.owner.id]).others});
  assert(earlierRecords(shared,aliceId,[p.owner.id]).records>=4);
  await signRecords(shared,alice,{legacy:[p.owner.id]});
  assert(shared.getMap('meta').get(claimKey(p.owner.id)),'no claim was written');
  await offer(peer,shared,{bound:()=>[aliceId]});
  for(const [root,id]of [['threads',p.thread.threadId],['messages',p.reply.messageId],['suggestions',p.suggestionId],['discussionEvents',p.decision]])assert.equal(recordTrust(peer,root,id,[]),'claimed',root);
  // Back at the sharer: the claim and proofs leave its own records its own.
  assert.equal(recordTrust(shared,'messages',p.reply.messageId,[aliceId,p.owner.id]),'own');
 }finally{shared.destroy();peer.destroy();await p.f.remove();}
});

test('a peer cannot use a claim to take over someone else\'s earlier records',async()=>{
 const p=await earlierProject(),alice=await newIdentity(),mallory=await newIdentity(),aliceId=identityAuthorId(alice.publicKey),malloryId=identityAuthorId(mallory.publicKey);
 const claimed=cloneProject(p.f.doc);await signRecords(claimed,alice,{legacy:[p.owner.id]});
 const forged=async(doc,legacy,author=malloryId,identity=mallory)=>doc.getMap('meta').set(claimKey(legacy),await signEnvelope(identity,{domain:'scribyra-author-claim',version:1,lineage:p.lineage,legacy,author}));
 const docs=[claimed];
 try{
  // Records already shared without a claim cannot be claimed later, by anyone.
  const seen=receiver(p.lineage),late=cloneProject(p.f.doc);docs.push(seen,late);await offer(seen,p.f.doc);
  await signRecords(late,mallory,{legacy:[p.owner.id]});assert(late.getMap('meta').get(claimKey(p.owner.id)));await refused(seen,late,{},/already shared without that claim/);
  // Nor can a claim be rewritten, or claimed records be sent unsigned or newly unsigned.
  const peer=receiver(p.lineage);docs.push(peer);await offer(peer,claimed);
  const rewritten=cloneProject(claimed);docs.push(rewritten);await forged(rewritten,p.owner.id);await refused(peer,rewritten,{},/changed who claims/);
  const stripped=cloneProject(claimed);docs.push(stripped);stripped.getMap('meta').delete(`directProof:messages:${p.reply.messageId}`);await refused(peer,stripped);
  const planted=cloneProject(claimed),id=crypto.randomUUID();docs.push(planted);planted.getMap('messages').set(id,{...planted.getMap('messages').get(p.reply.messageId),id,body:'Words put in the earlier author\'s mouth'});await refused(peer,planted);
  // A key-derived ID cannot be claimed, and unsigned records under one are forgeries.
  const fresh=receiver(p.lineage),victim=cloneProject(p.f.doc);docs.push(fresh,victim);await forged(victim,aliceId);await refused(fresh,victim);
  const impostor=cloneProject(p.f.doc),message=crypto.randomUUID();docs.push(impostor);impostor.getMap('messages').set(message,{...impostor.getMap('messages').get(p.reply.messageId),id:message,authorId:aliceId});await refused(fresh,impostor);
  // The sharer's own earlier ID is bound here: nobody may send unsigned records under it.
  const own=receiver(p.lineage);docs.push(own);await refused(own,p.f.doc,{bound:()=>[aliceId,p.owner.id]});
 }finally{docs.forEach(doc=>doc.destroy());await p.f.remove();}
});

test('a decision made with sessions off by a profile that has a key is claimed, not approved, and cannot be stripped',async()=>{
 const alice=await newIdentity(),aliceId=identityAuthorId(alice.publicKey),p=await earlierProject({id:aliceId,kind:'human',displayName:'Alice'}),shared=cloneProject(p.f.doc),peer=receiver(p.lineage);
 try{
  // Sessions were off: nothing was signed.
  assert.equal([...p.f.doc.getMap('meta').keys()].some(key=>key.startsWith('direct')),false);
  await signRecords(shared,alice);await offer(peer,shared,{bound:()=>[aliceId]});
  assert.equal(recordTrust(peer,'messages',p.reply.messageId,[]),'verified');
  assert.equal(recordTrust(peer,'discussionEvents',p.decision,[]),'claimed');assert.match(shared.getMap('meta').get(`directProof:discussionEvents:${p.decision}`).data,/"claimed":true/);
  const unsigned=cloneProject(shared),fresh=receiver(p.lineage);unsigned.getMap('meta').delete(`directProof:discussionEvents:${p.decision}`);
  try{await refused(fresh,unsigned);}finally{unsigned.destroy();fresh.destroy();}
 }finally{shared.destroy();peer.destroy();await p.f.remove();}
});
