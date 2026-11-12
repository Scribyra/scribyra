// Opaque signaling adapter. No project state, persistence or default endpoint.
const encoder = new TextEncoder(), decoder = new TextDecoder();
const hex = bytes => [...bytes].map(b=>b.toString(16).padStart(2,'0')).join('');
const unhex = text => {
  if(typeof text!=='string'||!/^([0-9a-f]{2})+$/.test(text))throw Error('Invalid encoding');
  return Uint8Array.from(text.match(/../g),x=>parseInt(x,16));
};
export const randomId = () => hex(crypto.getRandomValues(new Uint8Array(32)));
export function createInvitation() { return {version:1,room:randomId(),key:randomId()}; }
function detail(value) {
  if(!value||typeof value!=='object'||Array.isArray(value))throw Error('Invalid signaling');
  const fields=Object.keys(value).sort().join(',');
  if((value.type==='offer'||value.type==='answer')&&fields==='sdp,type'&&typeof value.sdp==='string'&&value.sdp.length<=16000)return;
  if(value.type==='candidate'&&fields==='candidate,type'&&(value.candidate===null||typeof value.candidate==='object'))return;
  if(value.type==='session'&&fields==='payload,type'&&typeof value.payload==='string'&&value.payload.length<=24000)return;
  throw Error('Invalid signaling');
}
export async function connectService({endpoint,bearer,invitation,onSignal,onError=()=>{},signal}) {
  signal?.throwIfAborted();
  const url=new URL(endpoint);
  if(!['https:','http:'].includes(url.protocol)||url.username||url.password||url.search||url.hash||url.pathname!=='/')throw Error('Invalid service endpoint');
  if(url.protocol==='http:'&&!['127.0.0.1','localhost','[::1]'].includes(url.hostname))throw Error('TLS required');
  if(invitation.version!==1||!/[0-9a-f]{64}/.test(invitation.key)||invitation.key.length!==64||!/[0-9a-f]{64}/.test(invitation.room)||invitation.room.length!==64)throw Error('Invalid invitation');
  const key=await crypto.subtle.importKey('raw',unhex(invitation.key),'AES-GCM',false,['encrypt','decrypt']);
  signal?.throwIfAborted();
  // Retain replay counters for departed sockets too; a five-member room can rejoin.
  const sender=randomId(), room=invitation.room, seen=new Map();
  url.protocol=url.protocol==='https:'?'wss:':'ws:';url.pathname='/v1/connect';
  const socket=new WebSocket(url);socket.binaryType='arraybuffer';
  let queued=0,queuedBytes=0, sequence=0, outgoing=Promise.resolve(),incoming=Promise.resolve(),closed=false,joined=false;
  let resolveReady,rejectReady;
  const ready=new Promise((resolve,reject)=>{resolveReady=resolve;rejectReady=reject;});
  const abort=()=>fail(Error('Direct session cancelled.'));
  signal?.addEventListener('abort',abort,{once:true});
  const timer=setTimeout(()=>fail(Error('Connection service deadline')),5000);
  function fail(error) { if(closed)return;closed=true;signal?.removeEventListener('abort',abort);clearTimeout(timer);socket.close();rejectReady(error);onError(error); }
  const aad=(from,seq)=>encoder.encode(JSON.stringify(['scribyra-signal',1,room,from,seq]));
  socket.onopen=()=>{if(closed||signal?.aborted){abort();return;}socket.send(JSON.stringify({version:1,bearer,room,connection:sender}));};
  socket.onerror=()=>fail(Error('Connection service unavailable'));
  socket.onclose=()=>fail(Error('Connection service closed; start a fresh attempt'));
  socket.onmessage=event=>{
    if(closed)return;
    const size=typeof event.data==='string'?event.data.length*2:event.data?.byteLength;
    if(!Number.isSafeInteger(size)||size>65536){fail(Error('Invalid relay frame'));return;}
    if(++queued>64||queuedBytes+size>1024*1024){fail(Error('Relay receive backpressure'));return;}
    queuedBytes+=size;
    incoming=incoming.then(async()=>{
      if(closed)return;
      if(!joined){const response=JSON.parse(event.data);if(response.version!==1||response.ready!==true)throw Error('Unsupported relay');joined=true;clearTimeout(timer);resolveReady();return;}
      if(!(event.data instanceof ArrayBuffer)||event.data.byteLength>65536)throw Error('Invalid relay frame');
      const frame=JSON.parse(decoder.decode(event.data));
      if(Object.keys(frame).sort().join(',')!=='ciphertext,iv,room,sender,sequence,version'||frame.version!==1||frame.room!==room||typeof frame.sender!=='string'||!/^[0-9a-f]{64}$/.test(frame.sender)||frame.sender===sender||!Number.isSafeInteger(frame.sequence)||frame.sequence<1||frame.sequence<=(seen.get(frame.sender)||0)||(!seen.has(frame.sender)&&seen.size>=32))throw Error('Invalid or replayed signaling');
      const iv=unhex(frame.iv);if(iv.length!==12)throw Error('Invalid nonce');
      const bytes=await crypto.subtle.decrypt({name:'AES-GCM',iv,additionalData:aad(frame.sender,frame.sequence)},key,unhex(frame.ciphertext));
      const value=JSON.parse(decoder.decode(bytes));detail(value);seen.set(frame.sender,frame.sequence);
      if(!closed)await onSignal(value,frame.sender);
    }).catch(fail).finally(()=>{queued--;queuedBytes-=size;});
  };
  await ready;signal?.throwIfAborted();
  return {
    sender,
    send(value) {
      detail(value);
      // Capture before queueing so caller mutation cannot alter the authenticated message.
      const bytes=encoder.encode(JSON.stringify(value));
      const job=outgoing.then(async()=>{
        if(closed||socket.readyState!==WebSocket.OPEN)throw Error('Relay closed');
        if(sequence>=Number.MAX_SAFE_INTEGER||socket.bufferedAmount>65536)throw Error('Relay backpressure');
        const seq=++sequence,iv=crypto.getRandomValues(new Uint8Array(12));
        const ciphertext=await crypto.subtle.encrypt({name:'AES-GCM',iv,additionalData:aad(sender,seq)},key,bytes);
        if(closed||signal?.aborted)throw Error('Relay closed');
        const frame=encoder.encode(JSON.stringify({version:1,room,sender,sequence:seq,iv:hex(iv),ciphertext:hex(new Uint8Array(ciphertext))}));
        if(frame.length>65536)throw Error('Signaling too large');socket.send(frame);
      });
      outgoing=job.catch(fail);return job;
    },
    close(){closed=true;signal?.removeEventListener('abort',abort);clearTimeout(timer);socket.close();},
  };
}
