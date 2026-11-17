// A second organisation member for Node engine tests, driven at the protocol level (the engine
// keeps one IndexedDB per process, so other people are simulated with raw keys): joins with an
// invitation link, reads the membership log, opens its wraps and seals log entries, exactly as
// another person's app would, or as a misbehaving one could.
import {orgClient} from '../../web/org-client.js';
import {
 parseInvite,inviteSeed,inviteMessage,deviceProof,signEvent,personId,sealName,applyEvents,unwrapProjectKey,
 sealEntry,openEntry,verifyEntryBody,entryHash,chainNext,randomBytes,
} from '../../web/org-crypto.js';
import {org_ed25519_public,org_ed25519_sign,org_x25519_public} from '../../web/pkg/scribyra_app.js';

export async function rawMember(link,name='Member'){
 const invite=parseInvite(link),org=invite.org,seed=randomBytes(32),secret=randomBytes(32);
 const device=org_ed25519_public(seed),agreement=org_x25519_public(secret),person=personId(org,device);
 const client=orgClient(invite.service,{fetchImpl:fetch});
 const {head}=await client.info(org);
 const proof=await deviceProof({org,prev:head,person,device,agreement},seed),iseed=inviteSeed(invite.secret);
 const inviteSig=org_ed25519_sign(iseed,inviteMessage(org,head,invite.invite,person,device,agreement));
 await client.postEvent(org,await signEvent({org,prev:head,type:'person.join',body:{invite:invite.invite,person,device,agreement,proof,inviteSig,name:sealName(invite.directoryKey,org,person,name)}},seed),{auth:false});
 await client.signIn(org,seed);
 let clientSeq=0;
 const member={
  org,seed,secret,device,agreement,person,client,
  async state(){return applyEvents(null,org,await client.events(org,0));},
  /** This member's key for one epoch of a project, opened from its wrap (null if none yet). */
  async key(project,epoch){
   const state=await member.state();
   for(const raw of await client.wraps(org)){const wrap=JSON.parse(raw);if(wrap.project===project&&wrap.epoch===epoch&&wrap.recipient===agreement)return(await unwrapProjectKey(state,raw,secret)).key;}
   return null;
  },
  /** Every entry of a project's log, verified (signature) but not decrypted. */
  async log(project){const out=[];for await(const item of client.log(project,0))out.push({...item,...verifyEntryBody(item.body)});return out;},
  /** The project's lineage, read from its first entry. */
  async lineage(project,key){const [first]=await member.log(project);return openEntry(first.body,key).meta.lineage;},
  async seal({project,epoch,key,payload,kind='update',lineage,seq}){
   return sealEntry({projectKey:key,org,project,epoch,clientSeq:seq??++clientSeq,lineage,schema:8,person,payload,kind},seed);
  },
  /** Appends the next entry; a refused one does not use up its client sequence. */
  async append(args){
   const seq=args.seq??clientSeq+1,sealed=await member.seal({...args,seq});
   const ack=await client.append(args.project,sealed.body);clientSeq=Math.max(clientSeq,seq);return ack;
  },
  async post(type,body){const state=await member.state();return client.postEvent(org,await signEvent({org,prev:state.head,type,body},seed));},
 };
 return member;
}

/** What a misbehaving service could do: put an entry into a project's log directly in its
 * database, with a correct chain, bypassing every check the service makes. */
export async function inject(s,project,sealed,{device,clientSeq,epoch}){
 const head=(await s.sql(`SELECT head_seq || ',' || head_chain FROM projects WHERE project='${project}'`)).split(',');
 const seq=Number(head[0])+1,hash=entryHash(sealed.headerRaw,sealed.ciphertext),chain=chainNext(head[1],hash);
 const hexBody=Buffer.from(sealed.body).toString('hex');
 await s.sql(`INSERT INTO entries (project, seq, device, client_seq, epoch, entry_hash, chain, size, inline) VALUES ('${project}', ${seq}, '${device}', ${clientSeq}, ${epoch}, '${hash}', '${chain}', ${sealed.body.length}, decode('${hexBody}','hex')); UPDATE projects SET head_seq=${seq}, head_chain='${chain}' WHERE project='${project}'`);
 return seq;
}
