import {ROOTS} from './collaboration-schema.js';
import {blob_hash} from './pkg/scribyra_app.js';
import {profileIdentity,signEnvelope,verifyEnvelope} from './direct-identity.js';
import {directEnabled,legacyAuthorIds} from './direct-state.js';
const bytes=value=>new TextEncoder().encode(JSON.stringify(value));
const hash=value=>blob_hash(bytes(value));
const canonical=value=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])])):value;
// Key-derived IDs are UUID version 8; local IDs from crypto.randomUUID() are version 4. So an
// ID itself says whether a key stands behind it: unsigned records under a version-8 ID are
// forgeries, while version-4 IDs are earlier, pre-key authors that can only be unverified.
const uuid=value=>{const h=[...hash(value).slice(0,32)];h[12]='8';h[16]='89ab'[parseInt(h[16],16)&3];return h.join('').replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/,'$1-$2-$3-$4-$5');};
export const keyDerivedId=id=>typeof id==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id);
export const identityAuthorId=key=>uuid(['scribyra-author',1,key]);
export const delegatedAuthorId=(owner,session)=>uuid(['scribyra-agent-author',1,owner,session]);
const proofKey=(root,id)=>`directProof:${root}:${id}`;
const PROOF=/^directProof:([a-zA-Z]+):([0-9a-f-]{36})$/;
const CLAIM=/^directClaim:([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})$/;
const UUID=/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
export const claimKey=id=>`directClaim:${id}`;
// A verified proof is `{"digest":…}`. A claimed one adds `"claimed":true`: the key vouches
// that this profile holds the record as its own, made before it signed (an earlier author
// ID, a decision made with sessions off), not that the record is authentic or authorized.
const PROOF_DATA=/^\{"digest":"[0-9a-f]{64}"(?:,"claimed":true)?\}$/;
const claimedProof=proof=>typeof proof?.data==='string'&&proof.data.endsWith(',"claimed":true}');
const envelope=value=>!!value&&typeof value==='object'&&Object.keys(value).sort().join(',')==='data,key,signature'&&typeof value.data==='string'&&typeof value.key==='string'&&/^[0-9a-f]{64}$/.test(value.key)&&typeof value.signature==='string'&&/^[0-9a-f]{128}$/.test(value.signature);
// Proofs are the only peer-writable open-ended metadata: closed shape, known root,
// and an existing record, so one cannot be planted to outvote a later honest proof.
export function validateProofEntry(doc,key,value){
 const match=PROOF.exec(key);
 if(!match||!ROOTS.includes(match[1])||!doc.getMap(match[1]).has(match[2]))return false;
 return envelope(value)&&PROOF_DATA.test(value.data);
}
// `directClaim:<earlier author ID>` binds an author ID this profile used before it had a key
// to its key-derived ID, in one project lineage. Its signature is checked by validateProvenance.
export function validateClaimEntry(doc,key,value){
 const match=CLAIM.exec(key);if(!match||!envelope(value)||value.data.length>400)return false;
 let body;try{body=JSON.parse(value.data);}catch{return false;}
 return !!body&&Object.keys(body).sort().join(',')==='author,domain,legacy,lineage,version'&&body.domain==='scribyra-author-claim'&&body.version===1&&body.legacy===match[1]&&typeof body.author==='string'&&UUID.test(body.author)&&body.author!==body.legacy&&body.lineage===doc.getMap('meta').get('lineageId')&&body.author===identityAuthorId(value.key);
}
function claimsOf(doc){
 const claims=new Map();
 for(const [key,value]of doc.getMap('meta'))if(key.startsWith('directClaim:')&&validateClaimEntry(doc,key,value))claims.set(key.slice(12),JSON.parse(value.data).author);
 return claims;
}
const terminal=event=>['suggestionAccept','suggestionReject','suggestionWithdraw','suggestionRevert','authorityTransfer','restoreProjection'].includes(event.kind);
function commitment(doc,root,record){
 const value={domain:'scribyra-record',version:1,lineage:doc.getMap('meta').get('lineageId'),root,record};
 if(root==='discussionEvents'&&terminal(record)){
  const suggestion=doc.getMap('suggestions').get(record.targetId);
  value.suggestion=suggestion||null;value.review=doc.getMap('reviews').get(suggestion?.reviewId||record.targetId)||null;
  value.anchor=doc.getMap('anchors').get(suggestion?.anchorId)||null;value.change=doc.getMap('changes').get(record.changeId)||null;
 }
 return hash(canonical(value));
}
// Who a record speaks for. A delegated agent (its ID derived from owner and session) speaks
// for its owner; any other agent, such as one from a time sessions were off, only for itself.
const ownerOf=(doc,id)=>{const author=doc.getMap('authors').get(id);if(!author?.ownerAuthorId)return id;return author.kind==='agent'&&id===delegatedAuthorId(author.ownerAuthorId,doc.getMap('changes').get(author.changeId)?.sessionId)?author.ownerAuthorId:id;};
// Descriptive only: whose agent a record names, for this profile's own display.
const describedOwner=(doc,id)=>doc.getMap('authors').get(id)?.ownerAuthorId||id;
function signer(doc,root,record){
 if(root==='reviews')return record.acceptanceAuthorityId;
 if(root==='discussionEvents'&&terminal(record))return record.payload.acceptanceAuthorityId||ownerOf(doc,record.authorId);
 return ownerOf(doc,record.authorId);
}
// Design records that are never rewritten once written; edits are appended as events.
const IMMUTABLE=new Set(['threads','messages','suggestions']);
// A discussion binds what it discusses. Without this a peer could plant a thread on a
// proposal not yet seen here, whose honest arrival would then fail validation for good.
function checkDiscussion(merged,root,record){
 if(root==='threads'&&record.suggestionId){
  const suggestion=merged.getMap('suggestions').get(record.suggestionId);
  if(!suggestion||suggestion.anchorId!==record.anchorId||suggestion.reviewId!==record.reviewId)throw Error();
 }
 // A parent still on its way stays pending, as everywhere else; a present one must agree.
 if(root==='messages'&&record.replyToId){
  const parent=merged.getMap('messages').get(record.replyToId);
  if(parent&&parent.threadId!==record.threadId)throw Error();
 }
}
// Self-signed is not enough for records that speak for someone else's identity,
// and neither history restore nor authority handover has a signed peer protocol.
function checkClaim(merged,record,signerId,changed){
 if(['restoreProjection','authorityTransfer'].includes(record.kind)){if(changed)throw Error();return;}
 if(record.kind==='authorRename'&&ownerOf(merged,record.targetId)!==signerId)throw Error();
 if(record.kind==='messageEdit'&&ownerOf(merged,merged.getMap('messages').get(record.targetId)?.authorId)!==signerId)throw Error();
 // A suggestion's discussion follows its decision; the command layer refuses this too.
 if(changed&&['threadResolve','threadReopen'].includes(record.kind)&&merged.getMap('threads').get(record.targetId)?.suggestionId)throw Error();
 if(terminal(record)){
  // A decision signs the proposal it decides. Without that proposal nothing binds
  // it, and it would poison the proposal's later arrival for everyone.
  const suggestion=merged.getMap('suggestions').get(record.targetId),review=merged.getMap('reviews').get(suggestion?.reviewId);
  if(!suggestion||!review||review.acceptanceAuthorityId!==signerId)throw Error();
 }
}
const authorized=new WeakMap();
export function authorizeDecisions(doc,stage,changeId){
 if(!directEnabled())return;
 let records=authorized.get(doc);if(!records){records=new Map();authorized.set(doc,records);}
 for(const [id,event]of stage.getMap('discussionEvents'))if(event.changeId===changeId&&terminal(event))records.set(id,commitment(stage,'discussionEvents',event));
}
// These proofs authenticate immutable records, not arbitrary source edits or human names.
// Only this key's own current records, and decisions made through the trusted decision
// command, get a verified proof. Everything else this profile holds as its own (earlier
// author IDs, decisions made with sessions off, agents from then) is only claimed.
export async function signRecords(doc,identity,{trusted=doc,changeId,legacy=legacyAuthorIds()}={}){
 const authorId=identityAuthorId(identity.publicKey),proofs=doc.getMap('meta'),claims=claimsOf(doc),keyed=new Set(),held=new Set();
 for(const [key,value]of proofs)if(key.startsWith('directProof:')&&envelope(value))keyed.add(identityAuthorId(value.key));
 for(const root of ROOTS)for(const record of doc.getMap(root).values()){held.add(signer(doc,root,record));held.add(ownerOf(doc,record.authorId));}
 // Claim an earlier ID only where this project holds records under it and no key or other claim binds it.
 for(const id of legacy){
  if(id===authorId||keyDerivedId(id)||!held.has(id)||claims.has(id)||keyed.has(id))continue;
  proofs.set(claimKey(id),await signEnvelope(identity,{domain:'scribyra-author-claim',version:1,lineage:proofs.get('lineageId'),legacy:id,author:authorId}));claims.set(id,authorId);
 }
 const mine=id=>id===authorId||claims.get(id)===authorId;
 for(const root of ROOTS)for(const [id,record]of doc.getMap(root)){
  const principal=signer(doc,root,record),owner=ownerOf(doc,record.authorId);
  // A decision or review speaks for its authority; an author that is an earlier random-ID
  // agent is only described by it, so the authority can still claim the record.
  if(!mine(principal)||!mine(owner)&&(keyDerivedId(owner)||keyed.has(owner)||claims.has(owner)))continue;
  const key=proofKey(root,id),digest=commitment(doc,root,record),existing=proofs.get(key);
  if(existing?.data===JSON.stringify({digest})||existing?.data===JSON.stringify({digest,claimed:true}))continue;
  const decision=root==='discussionEvents'&&terminal(record);
  const approved=!decision||record.changeId===changeId||authorized.get(trusted)?.get(id)===digest;
  // Only the trusted decision command re-signs a decision; nothing downgrades its proof.
  if(decision&&existing&&!approved)continue;
  const verified=principal===authorId&&owner===authorId&&approved;
  proofs.set(key,await signEnvelope(identity,verified?{digest}:{digest,claimed:true}));
 }
}
export async function signDecisionRecords(doc,changeId){
 // Sessions off means off: no key is read or created and nothing is written to the project.
 if(!directEnabled()||!globalThis.navigator?.locks)return;
 // A review decision is a local feature. Without a usable identity it stays
 // unsigned: peers see it as unverified, and it never blocks the local commit.
 let identity;try{identity=await profileIdentity();}catch{return;}
 await signRecords(doc,identity,{changeId});
}
const UNVERIFIED='Unverified edit: peer authorship or review approval could not be authenticated. Your local copy is unchanged.';
// `bound` lists author IDs a key is known to stand behind here (this profile's own IDs and the
// connected peers'): nobody may send unsigned records under them.
export async function validateProvenance(previous,merged,{bound=[]}={}){
 // Verification awaits crypto; compare against the captured baseline, not edits
 // arriving in the authoritative document while verification is in flight.
 const baseline=new Map(['meta',...ROOTS].map(root=>[root,new Map(previous.getMap(root))]));
 previous={getMap:root=>baseline.get(root)};
 const proofs=merged.getMap('meta'),before=previous.getMap('meta'),keyed=new Set(bound),claims=new Map(),fresh=[];
 for(const meta of [before,proofs])for(const [key,value]of meta)if(key.startsWith('directProof:')&&envelope(value))keyed.add(identityAuthorId(value.key));
 for(const key of before.keys())if(key.startsWith('directClaim:')&&!proofs.has(key))throw Error(UNVERIFIED);
 for(const [key,value]of proofs){
  if(!key.startsWith('directClaim:'))continue;
  if(!validateClaimEntry(merged,key,value))throw Error(UNVERIFIED);
  const legacy=key.slice(12),author=JSON.parse(value.data).author;claims.set(legacy,author);keyed.add(author);
  if(before.has(key)){if(JSON.stringify(before.get(key))!==JSON.stringify(value))throw Error('Unverified edit: a peer changed who claims earlier records. Your local copy is unchanged.');}
  else fresh.push([legacy,value]);
 }
 // A claim arrives with, or before, the records it covers; it can never take over records
 // already shared here without it, nor an ID a key stands behind.
 for(const [legacy,value]of fresh){
  if(keyed.has(legacy)||keyDerivedId(legacy))throw Error(UNVERIFIED);
  for(const root of ROOTS)for(const record of previous.getMap(root).values())if(signer(previous,root,record)===legacy||ownerOf(previous,record.authorId)===legacy)throw Error('Unverified edit: a peer claimed earlier records that were already shared without that claim. Your local copy is unchanged.');
  try{await verifyEnvelope(value);}catch{throw Error(UNVERIFIED);}
 }
 for(const root of ROOTS){
  for(const [id,record]of previous.getMap(root))if(!merged.getMap(root).has(id))throw Error('Unverified edit: a peer removed an attributed record.');
  for(const [id,record]of merged.getMap(root)){
   const unchanged=JSON.stringify(canonical(previous.getMap(root).get(id)))===JSON.stringify(canonical(record));
   const proof=proofs.get(proofKey(root,id)),old=before.get(proofKey(root,id));
   if(unchanged&&!(root==='discussionEvents'&&terminal(record))&&JSON.stringify(old)===JSON.stringify(proof))continue;
   if(unchanged&&!proof&&!old)continue;
   try{
    const principal=signer(merged,root,record),owner=ownerOf(merged,record.authorId),earlier=previous.getMap(root).get(id);
    if(root==='discussionEvents')checkClaim(merged,record,principal,!unchanged);
    if(!unchanged){
     if(IMMUTABLE.has(root)&&earlier)throw Error();
     checkDiscussion(merged,root,record);
    }
    // An existing identity or review cannot be reassigned by a different signer.
    if(earlier&&signer(previous,root,earlier)!==principal)throw Error();
    if(!proof){
     // Unsigned records are accepted, and shown as unverified, only under earlier random
     // author IDs that no key or claim here stands behind. A proof cannot be removed.
     if(old||[principal,owner].some(id=>keyDerivedId(id)||keyed.has(id)||claims.has(id)))throw Error();
     continue;
    }
    const claimed=claimedProof(proof),key=identityAuthorId(proof.key),allowed=id=>id===key||claimed&&claims.get(id)===key;
    if(!allowed(principal)||!allowed(owner)&&!(claimed&&!keyDerivedId(owner)&&!keyed.has(owner)&&!claims.has(owner)))throw Error();
    // A claim covers records as they first arrive, never ones already held here without it,
    // and a verified proof is never downgraded.
    if(claimed&&earlier&&(!old||old.key!==proof.key||!claimedProof(old)))throw Error();
    const body=await verifyEnvelope(proof);
    if(body.digest!==commitment(merged,root,record))throw Error();
   }catch{throw Error(UNVERIFIED);}
  }
 }
}
// How a record reads here: this profile's own, verified, claimed by a key, or unverified.
// Proofs were authenticated as they arrived; this reads them without repeating the crypto.
export function recordTrust(doc,root,id,local=[]){
 const record=doc.getMap(root).get(id);if(!record)return'unverified';
 const principal=signer(doc,root,record),owner=ownerOf(doc,record.authorId);
 if(local.includes(principal)&&local.includes(owner)||local.includes(describedOwner(doc,record.authorId)))return'own';
 const proof=doc.getMap('meta').get(proofKey(root,id));
 if(!validateProofEntry(doc,proofKey(root,id),proof))return'unverified';
 const key=identityAuthorId(proof.key);
 if(!claimedProof(proof)&&principal===key&&owner===key)return'verified';
 const claims=claimsOf(doc),allowed=value=>value===key||claims.get(value)===key;
 return allowed(principal)&&(allowed(owner)||!keyDerivedId(owner)&&!claims.has(owner))?'claimed':'unverified';
}
// What the sharer should know before sharing: which of its own records others will only see
// as claimed, which earlier decisions they will see as unverified, and others' unsigned records.
// Counts what people see (comments, replies, proposals, reviews, decisions), not bookkeeping records.
const VISIBLE=['threads','messages','suggestions','reviews','discussionEvents'];
export function earlierRecords(doc,authorId,legacy=[]){
 const mine=new Set([authorId,...legacy]),result={records:0,decisions:0,others:0};
 for(const root of VISIBLE)for(const [id,record]of doc.getMap(root)){
  if(root==='discussionEvents'&&!terminal(record))continue;
  const principal=signer(doc,root,record),owner=ownerOf(doc,record.authorId),proof=doc.getMap('meta').get(proofKey(root,id)),decision=root==='discussionEvents'&&terminal(record);
  if(!mine.has(principal)&&!mine.has(describedOwner(doc,record.authorId))){if(!proof)result.others++;continue;}
  if(decision){if(!proof||claimedProof(proof)||identityAuthorId(proof.key)!==authorId)result.decisions++;}
  else if(principal!==authorId||owner!==authorId||claimedProof(proof))result.records++;
 }
 return result;
}
