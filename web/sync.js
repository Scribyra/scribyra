import * as Y from 'yjs';
import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate } from 'y-protocols/awareness';
import { blobRefs, knownBlob, installBlob, cloneProject, copyBlobs } from './assets.js';
import {observe,observed,finishError} from './observability.js';
// Frames: 0 = durable Yjs v1 update, 1 = ephemeral awareness, 2 = durable acknowledgement.
// Referenced binary objects use checksum-verified room-scoped HTTP storage before metadata.
export function connectDemo(doc, room, onStatus) {
  const awareness = new Awareness(doc), base=`http://127.0.0.1:8787/rooms/${room}`;
  const colors = ['#7760ca', '#c46760', '#3b938c', '#6d86c3'];
  const color = colors[Math.floor(Math.random() * colors.length)];
  awareness.setLocalStateField('user', { name: `Writer ${doc.clientID.toString(36).slice(-3)}`, color, colorLight: `${color}30` });
  let socket, timer, stopped=false, pending=0, queued=0, outgoing=Promise.resolve(), incoming=Promise.resolve(), connection=0;
  let uploads=new Set(), controller=new AbortController();
  let acknowledgements=[],skippedAcknowledgements=0,handshake;
  function clearObservations(){for(const receipt of acknowledgements)receipt?.span.end('cancelled');acknowledgements=[];skippedAcknowledgements=0;handshake?.end('cancelled');}
  function send(type,payload,ws=socket) {
    if(ws?.readyState!==WebSocket.OPEN)return false;
    const frame=new Uint8Array(payload.length+1);frame[0]=type;frame.set(payload,1);ws.send(frame);return true;
  }
  function status(label) { onStatus(label,Math.max(0,awareness.getStates().size-1)); }
  function settled() { status(pending||queued?'Syncing demo…':socket?.readyState===WebSocket.OPEN?'Demo synchronized':'Demo disconnected'); }
  function failed(error, ws) { if(!stopped && ws===socket) { status(`Demo sync failed: ${error.message}`);ws.close(); } }
  async function uploadAssets(snapshot,ws,signal,parent) {
    for(const ref of blobRefs(snapshot)) if(!uploads.has(ref.hash)) {
      const bytes=knownBlob(snapshot,ref.hash);if(!bytes)throw new Error('An asset is unavailable locally.');
      const existing=await observed('sync_io',()=>fetch(`${base}/blobs/${ref.hash}`,{method:'HEAD',signal}),{parent,outcome:response=>response.ok||response.status===404?'success':'failure',failure:'network'});
      if(existing.ok){if(ws!==socket||stopped)throw new Error('Connection changed.');uploads.add(ref.hash);continue;}
      if(existing.status!==404)throw new Error(`Asset lookup failed (${existing.status}).`);
      const response=await observed('sync_io',()=>fetch(`${base}/blobs/${ref.hash}`,{method:'PUT',headers:{'Content-Type':'application/octet-stream'},body:bytes,signal}),{parent,outcome:response=>response.ok?'success':'failure',failure:'network',metrics:()=>[{name:'bytes',value:bytes.byteLength}]});
      if(!response.ok)throw new Error(`Asset upload failed (${response.status}).`);
      if(ws!==socket||stopped)throw new Error('Connection changed.');uploads.add(ref.hash);
    }
  }
  function queueUpdate(bytes) {
    if(socket?.readyState!==WebSocket.OPEN)return;
    const ws=socket, snapshot=cloneProject(doc), signal=controller.signal, epoch=connection,observation=observe('sync');let awaitingAck=false;queued++;settled();
    outgoing=outgoing.then(async()=>{
      if(stopped||epoch!==connection)return;
      await uploadAssets(snapshot,ws,signal,observation.context);
      if(stopped||epoch!==connection)return;
      if(send(0,bytes,ws)){pending++;awaitingAck=true;if(acknowledgements.length>=32){const old=acknowledgements.shift();skippedAcknowledgements++;if(old)observe('sync_observation_drop',observation.context).end('success',undefined,[{name:'count',value:1}]);}acknowledgements.push(observation.context?{span:observation,bytes:bytes.byteLength}:null);}
    }).catch(error=>{if(stopped||epoch!==connection)observation.end('cancelled');else finishError(observation,error);failed(error,ws);}).finally(()=>{if(!awaitingAck)observation.end('cancelled');snapshot.destroy();if(epoch===connection){queued--;settled();}});
  }
  const update=(bytes,origin)=>{if(origin!=='remote')queueUpdate(bytes);};
  const aware=({added,updated,removed},origin)=>{if(origin!=='remote')send(1,encodeAwarenessUpdate(awareness,[...added,...updated,...removed]));settled();};
  doc.on('update',update);awareness.on('update',aware);
  function start() {
    if(stopped)return;clearObservations();connection++;pending=0;queued=0;uploads=new Set();outgoing=Promise.resolve();incoming=Promise.resolve();controller=new AbortController();handshake=observe('sync_connect');
    const epoch=connection, signal=controller.signal,connectionObservation=handshake;status('Connecting demo…');
    const ws=new WebSocket(`ws://127.0.0.1:8787/rooms/${room}`);socket=ws;ws.binaryType='arraybuffer';
    ws.onopen=()=>{if(stopped||epoch!==connection)return;connectionObservation.end();queueUpdate(Y.encodeStateAsUpdate(doc));send(1,encodeAwarenessUpdate(awareness,[doc.clientID]),ws);settled();};
    ws.onmessage=({data})=>{
      if(stopped||epoch!==connection)return;
      const frame=new Uint8Array(data);
      if(frame[0]===0) {
        const observation=observe('sync');queued++;settled();
        incoming=incoming.then(async()=>{
          if(stopped||epoch!==connection)return;
          const preview=cloneProject(doc);
          try {
            Y.applyUpdate(preview,frame.slice(1),'remote');
            for(const ref of blobRefs(preview)) if(!knownBlob(preview,ref.hash)) {
              const response=await observed('sync_io',()=>fetch(`${base}/blobs/${ref.hash}`,{signal}),{parent:observation.context,outcome:response=>response.ok?'success':'failure',failure:'network'});
              if(!response.ok)throw new Error(`Asset download failed (${response.status}).`);
              const length=Number(response.headers.get('Content-Length'));if(length&&length!==ref.size)throw new Error('Asset size mismatch.');
              const reader=response.body.getReader(),parts=[];let size=0;
              while(true){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>ref.size){await reader.cancel();throw new Error('Asset exceeds its declared size.');}parts.push(value);}
              const bytes=new Uint8Array(size);let offset=0;for(const part of parts){bytes.set(part,offset);offset+=part.length;}
              const verification=observe('verify',observation.context);try{installBlob(preview,ref,bytes);verification.end('success',undefined,[{name:'bytes',value:bytes.byteLength}]);}catch(error){verification.end('failure','integrity');throw error;}if(epoch===connection)uploads.add(ref.hash);
            }
            if(stopped||epoch!==connection)return;
            copyBlobs(preview,doc);Y.applyUpdate(doc,frame.slice(1),'remote');settled();
            observation.end('success',undefined,[{name:'bytes',value:frame.byteLength},{name:'count',value:1}]);
          } finally {preview.destroy();}
        }).catch(error=>{if(stopped||epoch!==connection)observation.end('cancelled');else finishError(observation,error);failed(error,ws);}).finally(()=>{observation.end('cancelled');if(epoch===connection){queued--;settled();}});
      } else if(frame[0]===1) { try{applyAwarenessUpdate(awareness,frame.slice(1),'remote');}catch(error){failed(error,ws);} }
      else if(frame[0]===2) {pending=Math.max(0,pending-1);if(skippedAcknowledgements)skippedAcknowledgements--;else{const receipt=acknowledgements.shift();receipt?.span.end('success',undefined,[{name:'bytes',value:receipt.bytes},{name:'count',value:1}]);}settled();}
      else failed(new Error('Invalid synchronization message.'),ws);
    };
    ws.onerror=()=>{if(stopped||epoch!==connection)return;if(!connectionObservation.end('failure','network'))observe('sync_connect').end('failure','network');status('Demo unavailable · start the plaintext-demo example');};
    ws.onclose=()=>{if(epoch!==connection)return;clearObservations();controller.abort();if(!stopped){status('Demo disconnected · reconnecting');timer=setTimeout(start,1500);}};
  }
  start();
  return {awareness,close(){stopped=true;clearObservations();connection++;clearTimeout(timer);controller.abort();awareness.setLocalState(null);doc.off('update',update);awareness.off('update',aware);awareness.destroy();socket?.close();}};
}
