import './helpers/core.mjs';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import * as Y from 'yjs';
import {addFile,SCHEMA_VERSION} from '../web/model.js';
import {cloneProject,assetBytes} from '../web/assets.js';
import {replication,receiveReplica,chunkFrames,frameReceiver,checkHello,hex} from '../web/replication.js';
import {newIdentity,signEnvelope,verifyEnvelope,verifyCommit,comparisonCode,digest} from '../web/direct-identity.js';
const pause=()=>new Promise(resolve=>setTimeout(resolve,5));
async function settle(check){for(let i=0;i<200;i++){if(check())return;await pause();}assert(check(),'replicas did not converge');}
function mesh(docs){
 const queues=[],engines=[],errors=[];
 for(let a=0;a<docs.length;a++)for(let b=a+1;b<docs.length;b++){
  const q1=[],q2=[];queues.push(q1,q2);
  const x=replication({doc:docs[a],send:v=>q1.push(v),pollMs:60000,onError:e=>errors.push(e)}),y=replication({doc:docs[b],send:v=>q2.push(v),pollMs:60000,onError:e=>errors.push(e)});
  q1.target=y;q2.target=x;engines.push(x,y);x.start();y.start();
 }
 return{queues,errors,async pump(){for(let turn=0;turn<20;turn++){for(const q of queues)for(const v of q.splice(0))await q.target.receive(v);await pause();}},sync(){engines.forEach(e=>e.sync());},close(){engines.forEach(e=>e.close());}};
}
test('two-way vectors repair a lost update, dependent structs and deletion-only state',async()=>{
 const a=new Y.Doc(),id=addFile(a,'main.tex','seed'),b=cloneProject(a),m=mesh([a,b]);
 try{
  await m.pump();const vector=Y.encodeStateVector(a);a.getText('text:'+id).insert(0,'lost');const after=Y.encodeStateVector(a);a.getText('text:'+id).insert(0,'later');
  Y.applyUpdate(b,Y.encodeStateAsUpdate(a,after));assert.notEqual(b.getText('text:'+id).toString(),a.getText('text:'+id).toString());
  m.queues.forEach(q=>q.splice(0));m.sync();await m.pump();assert.equal(b.getText('text:'+id).toString(),'laterlostseed');
  a.getText('text:'+id).delete(0,4);b.getText('text:'+id).insert(0,'peer');m.sync();await m.pump();assert.equal(a.getText('text:'+id).toString(),b.getText('text:'+id).toString());assert.notDeepEqual(vector,Y.encodeStateVector(a));assert.deepEqual(m.errors,[]);
 }finally{m.close();a.destroy();b.destroy();}
});
test('64 seeded five-replica schedules converge after drops and reordering',async()=>{
 for(let seed=1;seed<=64;seed++){
  let random=seed;const next=()=>{random=(Math.imul(random,1664525)+1013904223)>>>0;return random;};
  const root=new Y.Doc(),id=addFile(root,'main.tex','seed'),docs=[root,...Array.from({length:4},()=>cloneProject(root))],m=mesh(docs);
  try{await m.pump();for(let step=0;step<40;step++){const d=docs[next()%5],text=d.getText('text:'+id);if(next()%3&&text.length)text.delete(next()%text.length,1);else text.insert(next()%(text.length+1),String.fromCharCode(97+next()%26));if(step%7===0){m.sync();for(const q of m.queues)if(next()%2)q.splice(0);await m.pump();}}
   m.sync();await m.pump();const values=docs.map(d=>d.getText('text:'+id).toString());assert(values.every(v=>v===values[0]),`seed ${seed}`);assert.deepEqual(m.errors,[]);
  }finally{m.close();docs.forEach(d=>d.destroy());}
 }
});
test('blob pulls verify bytes before publishing any source or metadata',async()=>{
 const a=new Y.Doc(),id=addFile(a,'main.tex','seed'),b=cloneProject(a);const asset=addFile(a,'image.bin',new Uint8Array([1,2,3]));a.getText('text:'+id).insert(0,'peer');const before=Y.encodeStateAsUpdate(b);
 await assert.rejects(receiveReplica({doc:b,update:Y.encodeStateAsUpdate(a),pull:async()=>new Uint8Array([9,9,9])}),/integrity/);assert.deepEqual(Y.encodeStateAsUpdate(b),before);
 const m=mesh([a,b]);try{await m.pump();await settle(()=>b.getMap('files').has(asset));assert.deepEqual(assetBytes(b,asset),new Uint8Array([1,2,3]));assert.deepEqual(m.errors,[]);}finally{m.close();a.destroy();b.destroy();}
});
test('framing respects small negotiated sizes and rejects reordered and oversized messages',()=>{
 const bytes=new Uint8Array(50000).map((_,i)=>i%251),received=[],errors=[];
 const receiver=frameReceiver({onMessage:v=>received.push(v),onError:e=>errors.push(e)}),frames=[...chunkFrames(bytes,1024)];assert(frames.every(f=>f.length<=1024));frames.forEach(f=>receiver.receive(f.buffer));assert.deepEqual(received,[bytes]);receiver.receive(frames[1].buffer);assert.equal(errors.length,1);receiver.close();assert.throws(()=>[...chunkFrames(bytes,12)]);
});
test('newer schema and narrower rights fail plainly',()=>{
 assert.throws(()=>checkHello({version:1,schema:SCHEMA_VERSION+1,lineage:'x',rights:'full-editor'},'x'),/newer Scribyra/);
 assert.throws(()=>checkHello({version:1,schema:SCHEMA_VERSION,lineage:'x',rights:'comment'},'x'),/rights/);
});
test('signed envelope tampering and changed commitments fail; a middleman gives different codes',async()=>{
 const a=await newIdentity(),b=await newIdentity(),mallory=await newIdentity();const body={domain:'scribyra-direct',sequence:1,payload:'fingerprint'},signed=await signEnvelope(a,body);
 assert.deepEqual(await verifyEnvelope(signed),body);await assert.rejects(verifyEnvelope({...signed,data:signed.data.replace('fingerprint','replacement')}),/Tampered/);
 const reveal=key=>({key,nonce:hex(crypto.getRandomValues(new Uint8Array(32))),fingerprint:hex(crypto.getRandomValues(new Uint8Array(32)))}),av=reveal(a.publicKey),bv=reveal(b.publicKey),mv=reveal(mallory.publicKey),commit=await digest(['scribyra-direct-commit',1,av]);
 await verifyCommit(commit,av);await assert.rejects(verifyCommit(commit,mv),/commitment/);
 assert.equal(await comparisonCode('room',av,bv),await comparisonCode('room',bv,av));assert.notEqual(await comparisonCode('room',av,mv),await comparisonCode('room',mv,bv));assert.notEqual(await comparisonCode(['room','lineage',a.publicKey],av,bv),await comparisonCode(['room','lineage',mallory.publicKey],av,bv));
});

test('a disconnected anchor unknown during undo remains detached after reunion',async()=>{
 const {anchors}=await import('../web/comment-anchors.js');
 const a=new Y.Doc(),id=addFile(a,'main.tex','selected'),b=cloneProject(a),anchor=anchors.capture(b,id,0,8),text=a.getText('text:'+id),undo=new Y.UndoManager(text);
 text.delete(0,8);undo.undo();const received=cloneProject(a);
 Y.applyUpdate(received,Y.encodeStateAsUpdate(b));assert.equal(received.getText('text:'+id).toString(),'selected');assert.equal(anchors.resolve(received,anchor).status,'detached');
 undo.destroy();a.destroy();b.destroy();received.destroy();
});

test('an advertised asset remains pullable when its owner replaces it before the request',async()=>{
 const {replaceAsset}=await import('../web/model.js');
 const a=new Y.Doc();addFile(a,'main.tex','seed');const asset=addFile(a,'image.bin',new Uint8Array([1,2,3])),b=new Y.Doc();b.getMap('meta').set('schemaVersion',SCHEMA_VERSION);b.getMap('meta').set('lineageId',a.getMap('meta').get('lineageId'));
 const m=mesh([a,b]);try{
  // Deliver handshakes, then the vector that advertises the original asset.
  for(const q of m.queues)await q.target.receive(q.shift());
  await m.queues[1].target.receive(m.queues[1].shift());
  replaceAsset(a,asset,new Uint8Array([4,5,6]));await m.pump();m.sync();await m.pump();
  assert.deepEqual(m.errors,[]);assert.deepEqual(assetBytes(b,asset),new Uint8Array([4,5,6]));
 }finally{m.close();a.destroy();b.destroy();}
});

test('compact invites preserve exactly 113 bytes of scope and key material, never service credentials',async()=>{
 const {encodeInvite,parseInvite}=await import('../web/direct-identity.js');
 const invite={version:1,room:'01'.repeat(32),key:'02'.repeat(32),identity:'03'.repeat(32),lineage:crypto.randomUUID()},encoded=encodeInvite(invite);
 assert.equal(encoded.length,151);assert.equal(Buffer.from(encoded,'base64url').length,113);assert.deepEqual(parseInvite('https://private.example/app/#direct='+encoded),invite);
 assert.throws(()=>encodeInvite({...invite,bearer:'not-an-invite-field'}));assert.throws(()=>parseInvite('https://private.example/#direct='+encoded.slice(1)));assert.throws(()=>encodeInvite({...invite,version:2}));
});


test('a local edit requests both vectors without waiting for the periodic repair timer',async()=>{
 const a=new Y.Doc(),id=addFile(a,'main.tex','seed'),b=cloneProject(a),m=mesh([a,b]);
 try{await m.pump();a.getText('text:'+id).insert(0,'live ');await m.pump();await m.pump();assert.equal(b.getText('text:'+id).toString(),'live seed');assert.deepEqual(m.errors,[]);}
 finally{m.close();a.destroy();b.destroy();}
});

test('quarantine roots, mixed shared types, retained bytes and mutable lineage without publishing',async()=>{
 const {MAX_RETAINED_BYTES,validateProjectState,validatePeerState,projectBytes}=await import('../web/model.js');
 const a=new Y.Doc(),id=addFile(a,'main.tex','unsaved local text'),before=Y.encodeStateAsUpdate(a);
 for(const attack of [d=>d.getText('text:orphan').insert(0,'x'.repeat(65*1024*1024)),d=>d.getMap('unknown').set('x',1),d=>d.getArray('meta').insert(0,['hidden']),d=>d.getText('text:'+id).insertEmbed(0,{hidden:true}),d=>d.getMap('meta').set('lineageId',crypto.randomUUID())]){
  const evil=cloneProject(a);
  try{if(attack.toString().includes("getArray('meta')")){const mixed=new Y.Doc();mixed.getArray('meta').insert(0,['hidden']);Y.applyUpdate(evil,Y.encodeStateAsUpdate(mixed));mixed.destroy();}else attack(evil);
   await assert.rejects(receiveReplica({doc:a,update:Y.encodeStateAsUpdate(evil),pull:async()=>{throw Error('Unexpected pull');}}));assert.deepEqual(Y.encodeStateAsUpdate(a),before);
  }finally{evil.destroy();}
 }
 const orphan=new Y.Doc();orphan.getText('text:orphan').insert(0,'x'.repeat(65*1024*1024));assert.equal(projectBytes(orphan),0);validateProjectState(orphan);assert.throws(()=>validatePeerState(orphan),/64 MiB/);orphan.destroy();
 // A peer is refused the state; the owner's own save rules must not change with direct sessions off.
 const retained=cloneProject(a);retained.getMap('meta').set('padding','x'.repeat(MAX_RETAINED_BYTES));assert.throws(()=>validatePeerState(retained),/retained state/);validateProjectState(retained);retained.destroy();a.destroy();
});

test('queued byte limits and local lineage changes close replication before more transmission',async()=>{
 const {MAX_RETAINED_BYTES}=await import('../web/model.js'),doc=new Y.Doc();addFile(doc,'main.tex','local');const errors=[],sent=[];
 const r=replication({doc,send:v=>sent.push(v),onError:e=>errors.push(e.message),isComposing:()=>true});r.start();await r.receive({type:'hello',version:2,schema:SCHEMA_VERSION,lineage:doc.getMap('meta').get('lineageId'),rights:'full-editor'});
 const update=hex(new Uint8Array(Math.floor(MAX_RETAINED_BYTES/2)+1));await r.receive({type:'update',bytes:update});await r.receive({type:'update',bytes:update});assert.match(errors[0],/queue/);r.close();
 const s=replication({doc,send:v=>sent.push(v),onError:e=>errors.push(e.message)});s.start();const count=sent.length;doc.getMap('meta').set('lineageId',crypto.randomUUID());s.sync();assert.equal(sent.length,count);assert.match(errors.at(-1),/lineage changed/);s.close();doc.destroy();
});

test('authority signatures survive forwarding and reject copied IDs, tampering and lineage replay',async()=>{
 const {signRecords,identityAuthorId,validateProvenance}=await import('../web/direct-provenance.js');
 const authority=await newIdentity(),attacker=await newIdentity(),a=new Y.Doc();addFile(a,'main.tex','seed');
 const authorId=identityAuthorId(authority.publicKey),reviewId=crypto.randomUUID(),suggestionId=crypto.randomUUID(),changeId=crypto.randomUUID(),eventId=crypto.randomUUID(),common=id=>({version:1,id,authorId,changeId,createdAt:1});
 a.getMap('authors').set(authorId,{...common(authorId),kind:'human',displayName:'Authority'});
 a.getMap('reviews').set(reviewId,{...common(reviewId),title:'Review',acceptanceAuthorityId:authorId,authorityEpoch:1});
 a.getMap('suggestions').set(suggestionId,{...common(suggestionId),reviewId,anchorId:crypto.randomUUID(),baseDigest:'a'.repeat(64),before:'seed',after:'accepted'});
 await signRecords(a,authority);const pending=cloneProject(a);
 a.getMap('discussionEvents').set(eventId,{...common(eventId),targetId:suggestionId,parents:[],kind:'suggestionAccept',payload:{acceptanceAuthorityId:authorId,authorityEpoch:1,proposedBy:authorId}});
 await assert.rejects(validateProvenance(pending,a),/Unverified edit/);
 await signRecords(a,attacker);await assert.rejects(validateProvenance(pending,a),/Unverified edit/);
 await signRecords(a,authority,{changeId});const forwarded=cloneProject(a);await validateProvenance(pending,forwarded);
 const empty=new Y.Doc();empty.getMap('meta').set('lineageId',a.getMap('meta').get('lineageId'));await validateProvenance(empty,forwarded);
 const event=forwarded.getMap('discussionEvents').get(eventId);forwarded.getMap('discussionEvents').set(eventId,{...event,kind:'suggestionReject'});await assert.rejects(validateProvenance(pending,forwarded),/Unverified edit/);
 Y.applyUpdate(forwarded,Y.encodeStateAsUpdate(a));forwarded.getMap('meta').set('lineageId',crypto.randomUUID());await assert.rejects(validateProvenance(empty,forwarded),/Unverified edit/);
 for(const doc of [a,pending,forwarded,empty])doc.destroy();
});

test('a signer cannot turn another human identity into its delegated agent',async()=>{
 const {identityAuthorId,signRecords,validateProvenance}=await import('../web/direct-provenance.js'),victim=await newIdentity(),attacker=await newIdentity(),doc=new Y.Doc(),empty=new Y.Doc();addFile(doc,'main.tex','seed');
 const id=identityAuthorId(victim.publicKey),owner=identityAuthorId(attacker.publicKey),changeId=crypto.randomUUID(),common={version:1,authorId:id,changeId,createdAt:1};
 doc.getMap('authors').set(id,{...common,id,kind:'agent',displayName:'Forged victim',ownerAuthorId:owner});doc.getMap('changes').set(changeId,{...common,id:changeId,actorKind:'agent',sessionId:crypto.randomUUID(),kind:'agent.patchSource',fileIds:[]});
 await signRecords(doc,attacker);await assert.rejects(validateProvenance(empty,doc),/Unverified edit/);doc.destroy();empty.destroy();
});

test('approval binds its anchor and verification compares a stable local baseline',async()=>{
 const {signRecords,identityAuthorId,validateProvenance}=await import('../web/direct-provenance.js'),identity=await newIdentity(),doc=new Y.Doc();addFile(doc,'main.tex','seed');
 const authorId=identityAuthorId(identity.publicKey),changeId=crypto.randomUUID(),reviewId=crypto.randomUUID(),suggestionId=crypto.randomUUID(),anchorId=crypto.randomUUID(),eventId=crypto.randomUUID(),common=id=>({version:1,id,authorId,changeId,createdAt:1});
 doc.getMap('authors').set(authorId,{...common(authorId),kind:'human',displayName:'Authority'});doc.getMap('reviews').set(reviewId,{...common(reviewId),acceptanceAuthorityId:authorId});doc.getMap('anchors').set(anchorId,{...common(anchorId),fileId:'main'});doc.getMap('suggestions').set(suggestionId,{...common(suggestionId),reviewId,anchorId});
 await signRecords(doc,identity);const before=cloneProject(doc);
 doc.getMap('discussionEvents').set(eventId,{...common(eventId),targetId:suggestionId,kind:'suggestionAccept',payload:{acceptanceAuthorityId:authorId}});await signRecords(doc,identity,{changeId});
 const verify=crypto.subtle.verify;
 try{let changed=false;crypto.subtle.verify=function(...args){if(!changed){changed=true;before.getMap('changes').set('local-concurrent',{id:'local-concurrent'});}return verify.apply(this,args);};await validateProvenance(before,doc);}
 finally{crypto.subtle.verify=verify;before.getMap('changes').delete('local-concurrent');}
 doc.getMap('anchors').set(anchorId,{...doc.getMap('anchors').get(anchorId),fileId:'other'});await signRecords(doc,identity);await assert.rejects(validateProvenance(before,doc),/Unverified edit/);before.destroy();doc.destroy();
});

test('vector bursts coalesce while signing and oversized vectors disconnect',async()=>{
 const {identityAuthorId}=await import('../web/direct-provenance.js'),identity=await newIdentity(),doc=new Y.Doc();addFile(doc,'main.tex','local');const authorId=identityAuthorId(identity.publicKey);
 doc.getMap('authors').set(authorId,{version:1,id:authorId,authorId,changeId:crypto.randomUUID(),createdAt:1,kind:'human',displayName:'Owner'});
 const errors=[],sent=[],r=replication({doc,identity,send:value=>sent.push(value),onError:e=>errors.push(e.message)}),sign=crypto.subtle.sign;let release;
 const gate=new Promise(resolve=>release=resolve);crypto.subtle.sign=async function(...args){await gate;return sign.apply(this,args);};
 try{
  await r.receive({type:'hello',version:2,schema:SCHEMA_VERSION,lineage:doc.getMap('meta').get('lineageId'),rights:'full-editor'});
  for(let i=0;i<32;i++)await r.receive({type:'vector',full:true,bytes:'00'});
  assert.deepEqual(errors,[]);assert.equal(sent.filter(v=>v.type==='update').length,0);release();await settle(()=>sent.filter(v=>v.type==='update').length===2);assert.deepEqual(errors,[]);
  await r.receive({type:'vector',full:true,bytes:'00'.repeat(65537)});assert.match(errors[0],/vector exceeds/);
 }finally{release();crypto.subtle.sign=sign;r.close();doc.destroy();}
});


// Fixture: a signed authority review with one pending proposal, in a lineage shared by attacker and victim.
async function signedReview(){
 const {signRecords,identityAuthorId}=await import('../web/direct-provenance.js'),authority=await newIdentity(),attacker=await newIdentity(),doc=new Y.Doc(),fileId=addFile(doc,'main.tex','seed');
 const authorId=identityAuthorId(authority.publicKey),attackerId=identityAuthorId(attacker.publicKey),changeId=crypto.randomUUID(),reviewId=crypto.randomUUID(),suggestionId=crypto.randomUUID(),messageId=crypto.randomUUID(),threadId=crypto.randomUUID(),anchorId=crypto.randomUUID();
 const common=(id,by=authorId,change=changeId)=>({version:1,id,authorId:by,changeId:change,createdAt:1});
 doc.getMap('authors').set(authorId,{...common(authorId),kind:'human',displayName:'Authority'});doc.getMap('authors').set(attackerId,{...common(attackerId,attackerId),kind:'human',displayName:'Mallory'});
 doc.getMap('reviews').set(reviewId,{...common(reviewId),title:'Review',acceptanceAuthorityId:authorId,authorityEpoch:1});
 doc.getMap('suggestions').set(suggestionId,{...common(suggestionId),reviewId,anchorId,baseDigest:'a'.repeat(64),before:'seed',after:'accepted'});
 doc.getMap('messages').set(messageId,{...common(messageId),threadId,body:'Original words',mentionAuthorIds:[]});
 await signRecords(doc,authority);await signRecords(doc,attacker);
 const event=(kind,targetId,payload,by=attackerId,id=crypto.randomUUID(),parents=[])=>({...common(id,by),targetId,parents,kind,payload});
 return{doc,authority,attacker,authorId,attackerId,changeId,reviewId,suggestionId,messageId,fileId,common,event};
}
const refused=async(f,evil,pattern=/Unverified edit/)=>{const before=Y.encodeStateAsUpdate(f.doc);await assert.rejects(receiveReplica({doc:f.doc,update:Y.encodeStateAsUpdate(evil),pull:async()=>{throw Error('Unexpected pull');}}),pattern);assert.deepEqual(Y.encodeStateAsUpdate(f.doc),before,'attack changed the authoritative document');};

test('decisions self-signed by a peer, or planted ahead of their proposal, are refused and leave nothing behind',async()=>{
 const {signRecords}=await import('../web/direct-provenance.js'),{projection}=await import('../web/review-commands.js'),f=await signedReview(),self=f.attackerId,accept=(target,payload)=>f.event('suggestionAccept',target,{acceptanceAuthorityId:self,authorityEpoch:1,proposedBy:f.authorId,...payload});
 for(const forged of [accept(f.suggestionId),accept(crypto.randomUUID()),accept(f.suggestionId,{acceptanceAuthorityId:f.authorId})]){
  const evil=cloneProject(f.doc);evil.getMap('discussionEvents').set(forged.id,forged);await signRecords(evil,f.attacker,{changeId:f.changeId});
  await refused(f,evil);assert.equal(projection(f.doc,f.suggestionId).status,'pending');evil.destroy();
 }
 f.doc.destroy();
});

test('a genuine decision cannot be transplanted to another event, proposal or lineage, or relabelled by its forwarder',async()=>{
 const {signRecords}=await import('../web/direct-provenance.js'),f=await signedReview(),genuine=cloneProject(f.doc),other=crypto.randomUUID(),id=crypto.randomUUID();
 genuine.getMap('suggestions').set(other,{...f.common(other),reviewId:f.reviewId,anchorId:crypto.randomUUID(),baseDigest:'b'.repeat(64),before:'seed',after:'second'});
 const decision=f.event('suggestionAccept',f.suggestionId,{acceptanceAuthorityId:f.authorId,authorityEpoch:1,proposedBy:f.authorId},f.authorId,id);genuine.getMap('discussionEvents').set(id,decision);await signRecords(genuine,f.authority,{changeId:f.changeId});
 const proof=genuine.getMap('meta').get(`directProof:discussionEvents:${id}`);assert(proof);
 const fresh=crypto.randomUUID(),attacks=[
  d=>{d.getMap('discussionEvents').set(fresh,{...decision,id:fresh});d.getMap('meta').set(`directProof:discussionEvents:${fresh}`,proof);},
  d=>{d.getMap('discussionEvents').set(id,{...decision,targetId:other});},
  d=>{d.getMap('discussionEvents').set(id,{...decision,kind:'suggestionReject'});},
  d=>{d.getMap('meta').delete(`directProof:discussionEvents:${id}`);},
  d=>{d.getMap('suggestions').set(f.suggestionId,{...d.getMap('suggestions').get(f.suggestionId),after:'swapped'});},
 ];
 for(const attack of attacks){const evil=cloneProject(genuine);attack(evil);await refused(f,evil);evil.destroy();}
 // A signature from another lineage opens nothing here: lineage is inside the digest.
 const foreign=cloneProject(genuine);foreign.getMap('meta').set('lineageId',crypto.randomUUID());await signRecords(foreign,f.authority,{changeId:f.changeId});const replay=cloneProject(f.doc);replay.getMap('discussionEvents').set(id,decision);replay.getMap('meta').set(`directProof:discussionEvents:${id}`,foreign.getMap('meta').get(`directProof:discussionEvents:${id}`));
 assert.notEqual(foreign.getMap('meta').get(`directProof:discussionEvents:${id}`).data,proof.data);await refused(f,replay);replay.destroy();foreign.destroy();
 // After the genuine decision is known, dropping it or its revert from forwarded state fails too.
 await receiveReplica({doc:f.doc,update:Y.encodeStateAsUpdate(genuine),pull:async()=>{throw Error('Unexpected pull');}});
 const dropped=cloneProject(f.doc);dropped.getMap('discussionEvents').delete(id);await refused(f,dropped);dropped.destroy();
 genuine.destroy();f.doc.destroy();
});

test('a peer cannot restore, hand over or speak for records it does not own',async()=>{
 const {signRecords}=await import('../web/direct-provenance.js'),f=await signedReview(),events=[
  f.event('authorRename',f.authorId,{displayName:'Forged name'}),
  f.event('messageEdit',f.messageId,{body:'Forged words',mentionAuthorIds:[]}),
  f.event('restoreProjection',f.messageId,{root:'messages',checkpointId:crypto.randomUUID(),projection:{...f.doc.getMap('messages').get(f.messageId),body:'Forged restore'},eventIds:[],idMap:{},anchor:null,detached:false,superseded:true}),
  f.event('restoreProjection',f.suggestionId,{root:'suggestions',checkpointId:crypto.randomUUID(),projection:null,eventIds:[],idMap:{},anchor:null,detached:false,superseded:true}),
  f.event('authorityTransfer',f.reviewId,{acceptanceAuthorityId:f.attackerId,authorityEpoch:1,restored:true}),
 ];
 for(const forged of events){const evil=cloneProject(f.doc);evil.getMap('discussionEvents').set(forged.id,forged);await signRecords(evil,f.attacker,{changeId:f.changeId});await refused(f,evil);evil.destroy();}
 // Its own rename and edit still pass: the rule is ownership, not a ban.
 const ok=cloneProject(f.doc),own=crypto.randomUUID();ok.getMap('messages').set(own,{...f.common(own,f.attackerId),threadId:crypto.randomUUID(),body:'Mine',mentionAuthorIds:[]});for(const event of [f.event('authorRename',f.attackerId,{displayName:'New name'}),f.event('messageEdit',own,{body:'Mine, edited',mentionAuthorIds:[]})])ok.getMap('discussionEvents').set(event.id,event);await signRecords(ok,f.attacker);
 await receiveReplica({doc:f.doc,update:Y.encodeStateAsUpdate(ok),pull:async()=>{throw Error('Unexpected pull');}});assert.equal(f.doc.getMap('messages').get(own).body,'Mine');ok.destroy();f.doc.destroy();
});

test('poisoned metadata cannot break backups or reassign TeX-link gating',async()=>{
 const {exportable}=await import('../web/history-backup.js').catch(()=>({})),f=await signedReview(),absent=`directProof:reviews:${crypto.randomUUID()}`,record=`directProof:reviews:${f.reviewId}`;
 for(const attack of [
  d=>d.getMap('meta').set(`directProof:unknownroot:${crypto.randomUUID()}`,d.getMap('meta').get(record)),
  d=>d.getMap('meta').set(absent,d.getMap('meta').get(record)),
  d=>d.getMap('meta').set(record,{...d.getMap('meta').get(record),extra:'x'.repeat(1024)}),
  d=>d.getMap('meta').set(record,{data:'x'.repeat(4096),key:'0'.repeat(64),signature:'0'.repeat(128)}),
  d=>d.getMap('meta').set('texLinkOrigin','link'),
  d=>d.getMap('meta').set('engine','attacker-engine'),
  d=>d.getMap('meta').set('name','x'.repeat(4096)),
  d=>d.getMap('meta').set('mainFile',{}),
 ]){const evil=cloneProject(f.doc);attack(evil);await refused(f,evil,/Invalid peer|invalid record proof/);evil.destroy();}
 // First join may inherit the mark from the project it is joining.
 const joining=new Y.Doc();joining.getMap('meta').set('schemaVersion',SCHEMA_VERSION);joining.getMap('meta').set('lineageId',f.doc.getMap('meta').get('lineageId'));const source=cloneProject(f.doc);source.getMap('meta').set('texLinkOrigin','link');
 await receiveReplica({doc:joining,update:Y.encodeStateAsUpdate(source),pull:async()=>{throw Error('Unexpected pull');}});assert.equal(joining.getMap('meta').get('texLinkOrigin'),'link');assert.equal(typeof exportable,'function');
 source.destroy();joining.destroy();f.doc.destroy();
});

test('reveals are closed and committed, codes are order-independent, and a grinder cannot pad them',async()=>{
 const {validReveal}=await import('../web/direct-identity.js'),key='a'.repeat(64),good={key,nonce:'b'.repeat(64),fingerprint:Array(32).fill('cd').join(':')},commit=await digest(['scribyra-direct-commit',1,good]);
 assert.equal(validReveal(good,key),good);await verifyCommit(commit,good);
 for(const bad of [{...good,extra:'grind'},{...good,key:'c'.repeat(64)},{...good,nonce:''},{...good,nonce:1},{...good,fingerprint:'00'},null])assert.throws(()=>validReveal(bad,key),/Invalid peer/);
 // Changing either revealed value after committing, as a grinder must, cannot open the commitment.
 await assert.rejects(verifyCommit(commit,{...good,nonce:'c'.repeat(64)}),/commitment/);await assert.rejects(verifyCommit(commit,{...good,fingerprint:Array(32).fill('ef').join(':')}),/commitment/);
 const other={key:'d'.repeat(64),nonce:'e'.repeat(64),fingerprint:good.fingerprint},code=await comparisonCode(['room','lineage',key],good,other);assert.equal(code,await comparisonCode(['room','lineage',key],other,good));assert.match(code,/^[0-9a-f]{4} [0-9a-f]{4} [0-9a-f]{4}$/);
});

test('an unverified peer cannot make the receiver allocate a large message',()=>{
 const errors=[],received=[],header=new DataView(new ArrayBuffer(16));header.setUint32(0,1);header.setUint32(4,192*1024*1024);header.setUint32(8,0);
 const receiver=frameReceiver({onMessage:v=>received.push(v),onError:e=>errors.push(e),maxMessage:()=>256});receiver.receive(header.buffer);assert.equal(errors.length,1);assert.deepEqual(received,[]);
 for(const frame of chunkFrames(new TextEncoder().encode('{"type":"verified"}'),16384,2))receiver.receive(frame.buffer);assert.equal(received.length,1);receiver.close();
 const full=frameReceiver({onMessage:()=>{},onError:e=>errors.push(e)});header.setUint32(4,192*1024*1024+4096);const before=errors.length;full.receive(header.buffer);assert.equal(errors.length,before);full.close();
});

test('an older schema is told to update, not reported as an unknown error',()=>{
 assert.throws(()=>checkHello({version:2,schema:SCHEMA_VERSION-1,lineage:'x',rights:'full-editor'},'x'),/older Scribyra version/);
 assert.throws(()=>checkHello({version:2,schema:SCHEMA_VERSION+1,lineage:'x',rights:'full-editor'},'x'),/newer Scribyra/);checkHello({version:2,schema:SCHEMA_VERSION,lineage:'x',rights:'full-editor'},'x');
});

test('Ed25519 generation retries only the failure it can survive, then refuses plainly',async()=>{
 const {newIdentity:create,DirectUnsupportedError,directSupport}=await import('../web/direct-identity.js'),generate=crypto.subtle.generateKey;let calls=0;
 const failing=name=>function(...args){calls++;if(calls<=2||name==='NotSupportedError')return Promise.reject(Object.assign(Error('stub'),{name:name||'OperationError'}));return generate.apply(this,args);};
 try{
  crypto.subtle.generateKey=failing();const identity=await create();assert.equal(calls,3);assert.match(identity.publicKey,/^[0-9a-f]{64}$/);
  calls=0;crypto.subtle.generateKey=failing('NotSupportedError');await assert.rejects(create(),e=>e instanceof DirectUnsupportedError&&/Ed25519/.test(e.message)&&/unaffected/.test(e.message));assert.equal(calls,1);
  calls=0;crypto.subtle.generateKey=function(){calls++;return Promise.reject(Object.assign(Error('stub'),{name:'OperationError'}));};await assert.rejects(create(),DirectUnsupportedError);assert.equal(calls,8);
 }finally{crypto.subtle.generateKey=generate;}
 assert.equal(typeof directSupport,'function');
});

// ---- Schema 8 discussion on suggestions across the peer boundary ----------------
async function discussionFixture(){
 const {signRecords,identityAuthorId}=await import('../web/direct-provenance.js'),{anchors}=await import('../web/comment-anchors.js');
 const authority=await newIdentity(),peer=await newIdentity(),attacker=await newIdentity(),doc=new Y.Doc(),file=addFile(doc,'main.tex','seed text');
 const person=identity=>identityAuthorId(identity.publicKey),authorityId=person(authority),changeId=crypto.randomUUID();
 const common=(id,authorId=authorityId,change=changeId)=>({version:1,id,authorId,changeId:change,createdAt:1});
 const addAuthor=(target,identity,name)=>{const id=person(identity);target.getMap('authors').set(id,{...common(id,id),kind:'human',displayName:name});return id;};
 addAuthor(doc,authority,'Authority');
 doc.getMap('changes').set(changeId,{...common(changeId),actorKind:'human',sessionId:crypto.randomUUID(),kind:'review.propose',fileIds:[file]});
 const reviewId=crypto.randomUUID(),anchorId=crypto.randomUUID(),suggestionId=crypto.randomUUID();
 doc.getMap('reviews').set(reviewId,{...common(reviewId),title:'Review',acceptanceAuthorityId:authorityId,authorityEpoch:1});
 doc.getMap('anchors').set(anchorId,{...common(anchorId),...anchors.capture(doc,file,0,4)});
 doc.getMap('suggestions').set(suggestionId,{...common(suggestionId),reviewId,anchorId,baseDigest:'a'.repeat(64),before:'seed',after:'sown'});
 await signRecords(doc,authority);
 // A signer's own discussion on the proposal, in the exact shape comments.js writes.
 const discuss=(target,identity,fields={},authorId=person(identity))=>{
  const threadId=crypto.randomUUID(),messageId=crypto.randomUUID(),change=crypto.randomUUID();
  if(!target.getMap('authors').has(person(identity)))addAuthor(target,identity,'Member');
  target.getMap('threads').set(threadId,{...common(threadId,authorId,change),anchorId,reviewId,suggestionId,firstMessageId:messageId,...fields.thread});
  target.getMap('messages').set(messageId,{...common(messageId,authorId,change),threadId,body:'A reply',mentionAuthorIds:[],...fields.message});
  return{threadId,messageId,change};
 };
 const receiver=doc,offer=async(evil,identity)=>{await signRecords(evil,identity);return receiveReplica({doc:receiver,update:Y.encodeStateAsUpdate(evil),pull:async()=>{throw Error('Unexpected pull');}});};
 return{doc,file,common,person,authority,peer,attacker,reviewId,anchorId,suggestionId,discuss,offer,addAuthor,anchors};
}
test('signed replies on a suggestion replicate, and a first reply needs no separate anchor',async()=>{
 const f=await discussionFixture(),evil=cloneProject(f.doc),{threadId,messageId}=f.discuss(evil,f.peer);
 await f.offer(evil,f.peer);
 assert.equal(f.doc.getMap('threads').get(threadId).suggestionId,f.suggestionId);assert.equal(f.doc.getMap('messages').get(messageId).body,'A reply');
 // A forwarding member cannot have changed it, and the proofs survive a further hop.
 const third=new Y.Doc();third.getMap('meta').set('lineageId',f.doc.getMap('meta').get('lineageId'));
 const {validateProvenance}=await import('../web/direct-provenance.js');await validateProvenance(third,f.doc);
 third.destroy();evil.destroy();f.doc.destroy();
});
test('a peer cannot forge, retarget, rewrite or oversize a suggestion reply',async()=>{
 const f=await discussionFixture(),victim=f.person(f.peer),bigger='x'.repeat(16*1024+1);
 const attacks={
  'thread and reply in another identity':evil=>f.discuss(evil,f.attacker,{},victim),
  'reply attributed to the authority':evil=>{const own=f.discuss(evil,f.attacker),id=crypto.randomUUID();evil.getMap('messages').set(id,{...f.common(id,f.person(f.authority),own.change),threadId:own.threadId,replyToId:own.messageId,body:'Forged',mentionAuthorIds:[]});},
  'thread on a proposal not present':evil=>f.discuss(evil,f.attacker,{thread:{suggestionId:crypto.randomUUID()}}),
  'thread that disagrees with its proposal anchor':evil=>f.discuss(evil,f.attacker,{thread:{anchorId:crypto.randomUUID()}}),
  'thread that disagrees with its proposal review':evil=>f.discuss(evil,f.attacker,{thread:{reviewId:crypto.randomUUID()}}),
  'thread naming a record of another type':evil=>f.discuss(evil,f.attacker,{thread:{suggestionId:f.reviewId}}),
  'reply to a message in another thread':evil=>{const one=f.discuss(evil,f.attacker),two=f.discuss(evil,f.attacker),id=crypto.randomUUID();evil.getMap('messages').set(id,{...f.common(id,f.person(f.attacker),one.change),threadId:two.threadId,replyToId:one.messageId,body:'Crossed',mentionAuthorIds:[]});},
  'message over 16 KiB':evil=>f.discuss(evil,f.attacker,{message:{body:bigger}}),
  'message over 64 mentions':evil=>f.discuss(evil,f.attacker,{message:{mentionAuthorIds:Array.from({length:65},()=>crypto.randomUUID())}}),
  'unknown thread field':evil=>f.discuss(evil,f.attacker,{thread:{privateNote:'x'}}),
  'suggestion target that is not a UUID':evil=>f.discuss(evil,f.attacker,{thread:{suggestionId:'x'.repeat(4096)}}),
 };
 for(const [name,attack]of Object.entries(attacks)){
  const before=Y.encodeStateAsUpdate(f.doc),evil=cloneProject(f.doc);attack(evil);
  await assert.rejects(f.offer(evil,f.attacker),undefined,name);assert.deepEqual(Y.encodeStateAsUpdate(f.doc),before,name);evil.destroy();
 }
 f.doc.destroy();
});
test('a planted discussion cannot poison a proposal that arrives later',async()=>{
 const f=await discussionFixture(),honest=cloneProject(f.doc),later=crypto.randomUUID(),before=Y.encodeStateAsUpdate(f.doc);
 honest.getMap('suggestions').set(later,{...honest.getMap('suggestions').get(f.suggestionId),id:later});
 const {signRecords}=await import('../web/direct-provenance.js');await signRecords(honest,f.authority);
 const evil=cloneProject(f.doc);f.discuss(evil,f.attacker,{thread:{suggestionId:later,anchorId:crypto.randomUUID()}});
 await assert.rejects(f.offer(evil,f.attacker),/Unverified edit/);assert.deepEqual(Y.encodeStateAsUpdate(f.doc),before);
 await receiveReplica({doc:f.doc,update:Y.encodeStateAsUpdate(honest),pull:async()=>{throw Error('Unexpected pull');}});assert(f.doc.getMap('suggestions').has(later));
 for(const doc of [f.doc,honest,evil])doc.destroy();
});
test('accepted discussion records stay immutable, and cannot be resolved apart from their proposal',async()=>{
 const f=await discussionFixture(),seed=cloneProject(f.doc),{threadId,messageId}=f.discuss(seed,f.attacker);await f.offer(seed,f.attacker);
 const second=cloneProject(f.doc),other=crypto.randomUUID();second.getMap('suggestions').set(other,{...second.getMap('suggestions').get(f.suggestionId),id:other});const {signRecords}=await import('../web/direct-provenance.js');await signRecords(second,f.authority);
 await receiveReplica({doc:f.doc,update:Y.encodeStateAsUpdate(second),pull:async()=>{throw Error('Unexpected pull');}});
 const event=(evil,kind,targetId,payload={})=>{const id=crypto.randomUUID();evil.getMap('discussionEvents').set(id,{...f.common(id,f.person(f.attacker)),targetId,parents:[],kind,payload});};
 const attacks={
  'own message rewritten in place':evil=>evil.getMap('messages').set(messageId,{...evil.getMap('messages').get(messageId),body:'Quietly different'}),
  'own thread retargeted to another proposal':evil=>evil.getMap('threads').set(threadId,{...evil.getMap('threads').get(threadId),suggestionId:other}),
  'suggestion discussion resolved directly':evil=>event(evil,'threadResolve',threadId),
  'suggestion discussion reopened directly':evil=>event(evil,'threadReopen',threadId),
  'another identity’s proposal replaced':evil=>evil.getMap('suggestions').set(f.suggestionId,{...evil.getMap('suggestions').get(f.suggestionId),after:'forged'}),
 };
 for(const [name,attack]of Object.entries(attacks)){
  const before=Y.encodeStateAsUpdate(f.doc),evil=cloneProject(f.doc);attack(evil);
  await assert.rejects(f.offer(evil,f.attacker),/Unverified edit/,name);assert.deepEqual(Y.encodeStateAsUpdate(f.doc),before,name);evil.destroy();
 }
 // Only the message's own author may edit it, on a suggestion thread as anywhere else.
 const mine=cloneProject(f.doc),victim=f.discuss(mine,f.peer);await f.offer(mine,f.peer);const evil=cloneProject(f.doc);event(evil,'messageEdit',victim.messageId,{body:'Forged words',mentionAuthorIds:[]});
 await assert.rejects(f.offer(evil,f.attacker),/Unverified edit/);
 for(const doc of [f.doc,seed,second,mine,evil])doc.destroy();
});
test('semantic budgets refuse a flood of replies before spending a signature check on it',async()=>{
 const f=await discussionFixture(),verify=crypto.subtle.verify;let checks=0;
 crypto.subtle.verify=function(...args){checks++;return verify.apply(this,args);};
 try{
  const anchor={anchorId:f.anchorId,reviewId:f.reviewId,suggestionId:f.suggestionId,firstMessageId:crypto.randomUUID()};
  const records=evil=>{const id=f.person(f.attacker),threadId=crypto.randomUUID();evil.getMap('threads').set(threadId,{...f.common(threadId,id),...anchor});return{id,threadId};};
  const many=cloneProject(f.doc),{id,threadId}=records(many);many.transact(()=>{for(let i=0;i<10001;i++){const key=crypto.randomUUID();many.getMap('messages').set(key,{...f.common(key,id),threadId,body:'x',mentionAuthorIds:[]});}});
  await assert.rejects(receiveReplica({doc:f.doc,update:Y.encodeStateAsUpdate(many),pull:async()=>{}}),/record limit/);
  const heavy=cloneProject(f.doc),big=records(heavy);heavy.transact(()=>{for(let i=0;i<1100;i++){const key=crypto.randomUUID();heavy.getMap('messages').set(key,{...f.common(key,big.id),threadId:big.threadId,body:'x'.repeat(16*1024),mentionAuthorIds:[]});}});
  await assert.rejects(receiveReplica({doc:f.doc,update:Y.encodeStateAsUpdate(heavy),pull:async()=>{}}),/16 MiB/);
  assert.equal(checks,0);many.destroy();heavy.destroy();
 }finally{crypto.subtle.verify=verify;f.doc.destroy();}
});
test('a peer on an older schema is refused, by handshake and by the state it sends',async()=>{
 assert.equal(SCHEMA_VERSION,8);
 assert.throws(()=>checkHello({version:2,schema:7,lineage:'x',rights:'full-editor'},'x'),/older Scribyra version/);
 checkHello({version:2,schema:8,lineage:'x',rights:'full-editor'},'x');
 const f=await discussionFixture(),before=Y.encodeStateAsUpdate(f.doc),evil=cloneProject(f.doc);evil.getMap('meta').set('schemaVersion',7);
 await assert.rejects(receiveReplica({doc:f.doc,update:Y.encodeStateAsUpdate(evil),pull:async()=>{}}),/different Scribyra version/);assert.deepEqual(Y.encodeStateAsUpdate(f.doc),before);
 evil.destroy();f.doc.destroy();
});
test('proofs wait while a review decision holds the editor, and flow when it finishes',async()=>{
 const {identityAuthorId}=await import('../web/direct-provenance.js'),identity=await newIdentity(),doc=new Y.Doc();addFile(doc,'main.tex','local');const authorId=identityAuthorId(identity.publicKey);
 doc.getMap('authors').set(authorId,{version:1,id:authorId,authorId,changeId:crypto.randomUUID(),createdAt:1,kind:'human',displayName:'Owner'});
 let holding=true;const errors=[],sent=[],updates=()=>sent.filter(v=>v.type==='update').length,r=replication({doc,identity,isComposing:()=>holding,send:v=>sent.push(v),onError:e=>errors.push(e.message)});
 try{
  await r.receive({type:'hello',version:2,schema:SCHEMA_VERSION,lineage:doc.getMap('meta').get('lineageId'),rights:'full-editor'});await r.receive({type:'vector',full:true,bytes:'00'});
  await new Promise(resolve=>setTimeout(resolve,120));assert.equal(updates(),0);assert.equal([...doc.getMap('meta').keys()].some(key=>key.startsWith('directProof:')),false);
  holding=false;await settle(()=>updates()===1);assert.equal([...doc.getMap('meta').keys()].some(key=>key.startsWith('directProof:')),true);assert.deepEqual(errors,[]);
 }finally{r.close();doc.destroy();}
});
