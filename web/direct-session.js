import * as Y from 'yjs';
import {identityAuthorId,signRecords,validateProvenance} from './direct-provenance.js';
import {cloneProject} from './assets.js';
import {validatePeerState} from './model.js';
import {connectService,createInvitation,randomId} from './service-client.js';
import {replication,chunkFrames,frameReceiver} from './replication.js';
import {legacyAuthorIds} from './direct-state.js';
import {profileIdentity,signEnvelope,verifyEnvelope,committedIdentity,validReveal,verifyCommit,comparisonCode,fingerprint,rendezvous,pinContact,pinnedContact} from './direct-identity.js';

// Tell the sender now, rather than leave every invitee with an "Unverified edit". Earlier
// unsigned records pass, as unverified or claimed; restored versions and authority
// changes have no signed peer protocol and still need a cleaned copy.
async function assertShareable(doc,identity,legacy){
 const probe=cloneProject(doc),empty=new Y.Doc();
 try{validatePeerState(probe);}catch(error){probe.destroy();empty.destroy();throw Error(error.message+' It cannot be shared directly; a cleaned copy may fit. This project stays unchanged.');}
 try{await signRecords(probe,identity,{trusted:doc,legacy});await validateProvenance(empty,probe);}
 catch{throw Error('This project contains a restored version or review authority change that others cannot verify. Use Share a cleaned copy instead; this project stays unchanged.');}
 finally{probe.destroy();empty.destroy();}
}
export async function directSession({doc,endpoint,bearer,invitation,author,onState=()=>{},onRequest=()=>{},signal:externalSignal,...pipeline}){
 const lifetime=new AbortController(),signal=lifetime.signal;
 const abort=()=>lifetime.abort();externalSignal?.addEventListener('abort',abort,{once:true});if(externalSignal?.aborted)abort();
 signal.throwIfAborted();
 const identity=await profileIdentity();signal?.throwIfAborted();
 if(author.id!==identityAuthorId(identity.publicKey))throw Error('This legacy author profile has no signing identity. Direct sharing requires a signed profile; local editing remains available.');
 const legacy=legacyAuthorIds();
 await assertShareable(doc,identity,legacy);signal.throwIfAborted();
 const invite=invitation||{...createInvitation(),lineage:doc.getMap('meta').get('lineageId'),identity:identity.publicKey};
 if(doc.getMap('meta').get('lineageId')!==invite.lineage)throw Error('This invite belongs to a different project. Join it as a separate local project.');
 let resume=()=>{},closed=false,generation=0,wakeTimer,relay,minute,sequence=0,outgoing=Promise.resolve(),signals=Promise.resolve(),signalCount=0,lastSignalAt=0,rotation=false,tick,releaseLock,lockReady;
 let presence={...author},greeting;
 let session=randomId();const peers=new Map(),seen=new Map(),pending=new Map(),retired=new Set(),attempts=new Map();
 const engine=/Firefox\//.test(navigator.userAgent)?'firefox':/Chrome\//.test(navigator.userAgent)?'chromium':'other';
 let message='Connecting… waiting for another browser';
 const active=()=>!closed&&!signal?.aborted&&doc.getMap('meta').get('lineageId')===invite.lineage;
 const check=()=>{if(!active()){close();throw Error('Direct session cancelled or lineage changed.');}};
 function state(){if(!active())return;onState({message,peers:[...peers.values()].map(p=>({id:p.id,name:p.author.displayName,kind:p.author.kind,authorId:p.author.id,code:p.code||'',verified:p.verified||false,status:p.status,offerer:p.offerer,elapsedMs:p.openedAt?Math.round(p.openedAt-p.startedAt):null})),invitation:invite});}
 function problem(error){if(error.message==='Relay closed')return;message=error.message;state();}
 function send(kind,payload,to='*'){
  const job=outgoing.then(async()=>{if(!active()||!relay)return;const delay=50-(performance.now()-lastSignalAt);if(delay>0)await new Promise(resolve=>setTimeout(resolve,delay));if(!active()||!relay)return;lastSignalAt=performance.now();const body={domain:'scribyra-direct',version:1,room:invite.room,epoch:minute,session,sequence:++sequence,to,kind,payload};const envelope=await signEnvelope(identity,body);if(!active()||!relay)return;await relay.send({type:'session',payload:JSON.stringify(envelope)});});
  outgoing=job.catch(problem);return job;
 }
 function hello(){return greeting||=send('hello',{author:presence,engine}).finally(()=>{greeting=null;});}
 function drop(p,status,retire=true){if(p.dropped)return;p.dropped=true;if(retire){retired.add(p.id+p.session);if(retired.size>1024)retired.delete(retired.values().next().value);}p.replica?.close();p.receiver?.close();clearTimeout(p.deadline);p.pc.close();p.status=status;if(peers.get(p.id)===p)peers.delete(p.id);if(!closed&&retire&&!peers.size)message='Disconnected. Your local copy remains on this device. Rejoin to retry.';state();}
 function unreachable(p){if(p.dropped)return;if(p.openedAt){drop(p,'Disconnected · rejoin to retry');return;}drop(p,'Could not reach this browser');message='Browsers could not reach each other. Check that both are online and this network permits direct connections. Rejoin to retry.';state();}
 async function makePeer(key,remoteSession,profile,remoteEngine){
  if(peers.size>=4)throw Error('Direct sessions support at most five browser profiles.');
  const localSession=session,certificate=await RTCPeerConnection.generateCertificate({name:'ECDSA',namedCurve:'P-256'});
  if(!active()||session!==localSession)return;
  const own=await committedIdentity(identity,certificate);if(!active()||session!==localSession)return;const pc=new RTCPeerConnection({iceServers:[],certificates:[certificate]});
  const p={id:key,session:remoteSession,author:profile,engine:remoteEngine,own,pc,status:'Connecting…',startedAt:performance.now(),candidates:[],queue:Promise.resolve(),sendQueue:Promise.resolve(),messageId:0};
  peers.set(key,p);
  p.offerer=engine==='chromium'&&remoteEngine==='firefox'||!(engine==='firefox'&&remoteEngine==='chromium')&&identity.publicKey<key;
  // The 20-second timer belongs to the attempt, not to one link: a minute rotation that
  // restarts an unopened link keeps its deadline, with a short grace for the new room.
  // Restarting it at full length let a blocked path show "Connecting…" for up to 40 s.
  const tag=key+remoteSession,now=performance.now(),first=attempts.get(tag)??now;attempts.delete(tag);attempts.set(tag,first);while(attempts.size>64)attempts.delete(attempts.keys().next().value);
  p.deadline=setTimeout(()=>unreachable(p),Math.max(first+20000-now,first===now?20000:5000));
  pc.onicecandidate=e=>{if(e.candidate)void send('candidate',e.candidate.toJSON(),remoteSession);};
  pc.ondatachannel=e=>channel(p,e.channel);
  pc.onconnectionstatechange=()=>{if(pc.connectionState==='failed'&&!closed)unreachable(p);};
  void hello();void send('commit',{commit:own.commit},remoteSession);state();return p;
 }
 function channel(p,dc){
  if(p.dc){dc.close();return;}p.dc=dc;dc.binaryType='arraybuffer';
  const fail=error=>{drop(p,error.message);problem(error);};
  const sendData=value=>{
   const bytes=new TextEncoder().encode(JSON.stringify(value));
   if((p.queuedBytes||0)+bytes.length>192*1024*1024)return Promise.reject(Error('Direct send queue full.'));
   p.queuedBytes=(p.queuedBytes||0)+bytes.length;
   const task=p.sendQueue.then(async()=>{
    for(const frame of chunkFrames(bytes,pcSize(p),++p.messageId)){
     const deadline=Date.now()+20000;
     while(dc.bufferedAmount>256*1024){if(closed||dc.readyState!=='open'||Date.now()>deadline)throw Error('Direct send stalled.');await new Promise(r=>setTimeout(r,10));}
     if(dc.readyState!=='open')throw Error('Direct channel closed.');dc.send(frame);
    }
   }).finally(()=>p.queuedBytes-=bytes.length);
   p.sendQueue=task.catch(fail);return task;
  };
  p.sendData=sendData;
  // Before both people verify, the only valid message is a short "verified".
  p.receiver=frameReceiver({onError:fail,maxMessage:()=>p.verified&&p.remoteVerified?Infinity:256,onMessage:bytes=>{
   try{const value=JSON.parse(new TextDecoder().decode(bytes));
    if(value.type==='verified'){p.remoteVerified=true;startReplica(p);return;}
    if(!p.verified||!p.remoteVerified)throw Error('Verify the comparison code before sharing.');
    if(value.type==='decision'){if(JSON.stringify(value).length>16000)throw Error('Decision request too large.');onRequest(value,p.author);return;}
    void p.replica.receive(value);
   }catch(error){fail(error);}
  }});
  dc.onmessage=e=>p.receiver.receive(e.data);
  dc.onclose=()=>{if(!closed){if(p.openedAt)drop(p,'Disconnected · rejoin to retry');else unreachable(p);}};
  dc.onopen=()=>{clearTimeout(p.deadline);attempts.delete(p.id+p.session);p.openedAt=performance.now();p.status='Compare code';message='Compare codes before sharing. Peers are not a backup.';state();if(p.verified)void sendData({type:'verified'});};
 }
 function pcSize(p){return p.pc.sctp?.maxMessageSize||16384;}
 function startReplica(p){
  if(!active()||p.dropped||!p.verified||!p.remoteVerified||p.replica)return;
  p.replica=replication({doc,identity,legacy,lineage:invite.lineage,send:p.sendData,...pipeline,bound:()=>[author.id,...legacy,...[...peers.values()].map(peer=>peer.author.id)],onError:error=>{drop(p,error.message);problem(error);}});
  p.replica.start();p.status='Connected';message='Connected directly · peers are not a backup. Check the local save indicator.';state();
 }
 async function handleSignal(value){
  if(value.type!=='session')throw Error('Unsupported direct signaling.');
  const envelope=JSON.parse(value.payload),body=await verifyEnvelope(envelope),key=envelope.key;check();
  if(body.domain!=='scribyra-direct'||body.version!==1||body.room!==invite.room||typeof body.session!=='string'||!Number.isSafeInteger(body.sequence)||body.sequence<1)throw Error('Invalid direct signaling context.');
  if(key===identity.publicKey||body.epoch!==minute)return;
  if(body.to!=='*'&&body.to!==session)return;
  const tag=key+body.session;if(body.sequence<=(seen.get(tag)||0))throw Error('Replayed direct signaling.');
  if(!seen.has(tag)&&seen.size>=32)throw Error('Too many direct attempts. Rejoin with a fresh invite.');seen.set(tag,body.sequence);
  let p=peers.get(key);
  if(body.kind==='hello'){
   if(retired.has(key+body.session))return;
   const profile=body.payload.author;
   if(profile?.id!==identityAuthorId(key)||typeof profile.displayName!=='string'||profile.displayName.length>160||!['human','agent'].includes(profile.kind))throw Error('Invalid peer presence.');
   if(p&&p.session!==body.session){drop(p,'Rejoining');p=null;}
   if(!p){
    if(!pending.has(key))pending.set(key,makePeer(key,body.session,profile,['chromium','firefox'].includes(body.payload.engine)?body.payload.engine:'other'));
    try{p=await pending.get(key);}finally{pending.delete(key);}
   }
   if(p){p.author=profile;state();}
   return;
  }
  if(!p&&pending.has(key))p=await pending.get(key);
  if(!p||p.session!==body.session)return;
  const job=p.queue.then(async()=>{
   if(!active()||p.dropped)return;
   if(body.kind==='commit'){
    if(typeof body.payload?.commit!=='string'||!/^[0-9a-f]{64}$/.test(body.payload.commit))throw Error('Invalid peer commitment.');
    if(p.commit){if(p.commit!==body.payload.commit)throw Error('Peer commitment changed.');return;}p.commit=body.payload.commit;
    void send('reveal',p.own.value,p.session);return;
   }
   if(body.kind==='reveal'){
    if(!p.commit)throw Error('Missing peer commitment.');validReveal(body.payload,key);
    await verifyCommit(p.commit,body.payload);check();if(p.dropped)return;p.remote=body.payload;p.code=await comparisonCode([invite.room,invite.lineage,invite.identity],p.own.value,p.remote);check();if(p.dropped)return;
    const pinned=await pinnedContact(key);check();if(p.dropped)return;if(pinned){p.verified=true;}
    if(p.offerer&&!p.pc.localDescription){channel(p,p.pc.createDataChannel('scribyra-direct-v1'));const offer=await p.pc.createOffer();check();if(p.dropped)return;await p.pc.setLocalDescription(offer);check();if(p.dropped)return;void send('description',{type:'offer',sdp:p.pc.localDescription.sdp},p.session);}
    state();return;
   }
   if(body.kind==='candidate'){
    if(!p.pc.remoteDescription)p.candidates.push(body.payload);else await p.pc.addIceCandidate(body.payload);return;
   }
   if(body.kind==='description'){
    if(body.payload?.type!==(p.offerer?'answer':'offer')||typeof body.payload.sdp!=='string')throw Error('Invalid peer session description.');
    if(!p.remote||fingerprint(body.payload.sdp)!==p.remote.fingerprint)throw Error('Peer DTLS fingerprint changed.');
    await p.pc.setRemoteDescription(body.payload);check();if(p.dropped)return;
    for(const candidate of p.candidates.splice(0)){await p.pc.addIceCandidate(candidate);check();if(p.dropped)return;}
    if(body.payload.type==='offer'){const answer=await p.pc.createAnswer();check();if(p.dropped)return;await p.pc.setLocalDescription(answer);check();if(p.dropped)return;void send('description',{type:'answer',sdp:p.pc.localDescription.sdp},p.session);}
    return;
   }
   throw Error('Unknown direct signal.');
  });
  p.queue=job.catch(error=>{drop(p,error.message);problem(error);});
 }
 async function connect(){
  if(rotation||!active())return;rotation=true;const token=generation;
  try{
   minute=Math.floor(Date.now()/60000);const room=await rendezvous(invite,minute);if(!active()||token!==generation)return;relay?.close();relay=null;
   // Replays carry an old epoch and are dropped first, so counters need not outlive it.
   // A handshake cut by this rotation can never finish: restart it in the new room.
   seen.clear();for(const p of [...peers.values()])if(!p.openedAt)drop(p,'Connecting…',false);
   const connection=await connectService({endpoint,bearer,signal,invitation:room,onSignal:value=>{if(++signalCount>64){relay?.close();problem(Error('Too many pending direct signals. Rejoin to retry.'));return;}signals=signals.then(()=>{if(!closed)return handleSignal(value);}).catch(error=>{relay?.close();problem(error);}).finally(()=>signalCount--);},onError:error=>{if(!closed)problem(error);}});
   if(!active()||token!==generation){connection.close();return;}relay=connection;await hello();
  }catch(error){problem(error);}finally{rotation=false;}
 }
 const activity=(_update,_origin,_doc,transaction)=>{if(!active()){close();onState({message:'Direct session lineage changed. Rejoin the correct project.',peers:[],invitation:invite});return;}if(!transaction.local)return;const changes=doc.getMap('changes'),ids=transaction.changed.get(changes)||[];if(presence.kind!=='agent'&&[...ids].some(id=>changes.get(id)?.actorKind==='agent'&&doc.getMap('authors').get(changes.get(id).authorId)?.ownerAuthorId===author.id)){presence={...author,kind:'agent'};void hello();}else if(transaction.origin===null&&presence.kind!=='human'){presence={...author};void hello();}};
 function close(){if(closed)return;closed=true;generation++;externalSignal?.removeEventListener('abort',abort);lifetime.abort();signal?.removeEventListener('abort',close);doc.off('update',activity);clearInterval(tick);clearInterval(wakeTimer);relay?.close();for(const p of peers.values())drop(p,'Left');peers.clear();window.removeEventListener('online',resume);window.removeEventListener('pageshow',resume);releaseLock?.();}
 const locked=new Promise(resolve=>{lockReady=resolve;});
 void navigator.locks.request('scribyra:direct-session',{ifAvailable:true},async lock=>{
  if(!lock){lockReady(false);return;}lockReady(true);await new Promise(resolve=>releaseLock=resolve);
 });
 if(!await locked)throw Error('A direct session is open in another tab. That tab owns the connection; this tab follows saved changes.');
 signal?.addEventListener('abort',close,{once:true});check();
 doc.on('update',activity);
 try{await connect();check();tick=setInterval(()=>{if(minute!==Math.floor(Date.now()/60000))void connect();else if(relay)void hello();},2000);}catch(error){releaseLock();throw error;}
 resume=()=>{if(!active())return;generation++;for(const p of peers.values())drop(p,'Rejoining');peers.clear();seen.clear();retired.clear();attempts.clear();session=randomId();void connect();};window.addEventListener('online',resume);window.addEventListener('pageshow',resume);
 let lastTick=Date.now();wakeTimer=setInterval(()=>{const now=Date.now();if(now-lastTick>15000)resume();lastTick=now;},3000);
 state();
 return{invitation:invite,identity:identity.publicKey,
  async verify(id,pin=false){const p=peers.get(id);if(!p?.code||p.dc?.readyState!=='open')throw Error('Wait for the peer connection and comparison code.');p.verified=true;if(pin)await pinContact(id,p.author.displayName);check();if(p.dropped)return;await p.sendData({type:'verified'});startReplica(p);state();},
  async requestDecision(authorId,request){const p=[...peers.values()].find(p=>p.author.id===authorId&&p.replica);if(!p)throw Error('Waiting for acceptance authority. Rejoin when that profile is online.');await p.sendData({type:'decision',...request});},
  close,
 };
}
