// Throwaway harness. Uses the repo's real project model, blob verification and Yjs.
import * as Y from 'yjs';
import init from '<repo>/web/pkg/scribyra_app.js';
import {addEntries,deleteNode,projectFiles,SCHEMA_VERSION} from '<repo>/web/model.js';
import {blobRefs,knownBlob,installBlob} from '<repo>/web/assets.js';
import {deflateSync} from 'fflate';
const CHUNK=16*1024,LOW=256*1024,HIGH=1024*1024;
const te=new TextEncoder(),td=new TextDecoder();
const now=()=>performance.now();
const b64=u=>{let s='';for(let i=0;i<u.length;i+=0x8000)s+=String.fromCharCode(...u.subarray(i,i+0x8000));return btoa(s).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');};
const QR={L:[17,32,53,78,106,134,154,192,230,271,321,367,425,458,520,586,644,718,792,858,929,1003,1091,1171,1273,1367,1465,1528,1628,1732,1840,1952,2068,2188,2303,2431,2563,2699,2809,2953],M:[14,26,42,62,84,106,122,152,180,213,251,287,331,362,412,450,504,560,624,666,711,779,857,911,997,1059,1125,1190,1264,1370,1452,1538,1628,1722,1809,1911,1989,2099,2213,2331]};
const qr=(n,l)=>{const v=QR[l].findIndex(c=>c>=n)+1;return v||null;};
const hexToBytes=h=>Uint8Array.from(h.split(':').map(x=>parseInt(x,16)));
const state={peers:new Map(),doc:null,undo:null,certs:new Map(),log:[],key:null};
function candidateSummary(sdp){const lines=sdp.split(/\r?\n/).filter(l=>l.startsWith('a=candidate:'));return lines.map(l=>{const p=l.split(' ');return{proto:p[2].toLowerCase(),addr:p[4],port:+p[5],type:p[7],mdns:p[4].endsWith('.local')};});}
// Minimal QWBP-style binary form: role, fingerprint, ufrag, pwd, candidates.
function minimal(sdp,type){const fp=hexToBytes(/a=fingerprint:sha-256 (\S+)/i.exec(sdp)[1]),ufrag=/a=ice-ufrag:(\S+)/.exec(sdp)[1],pwd=/a=ice-pwd:(\S+)/.exec(sdp)[1],cands=candidateSummary(sdp);const hostUdp=cands.filter(c=>c.proto==='udp').slice(0,4);let n=2+32+1+ufrag.length+1+pwd.length+1;for(const c of hostUdp)n+=(c.mdns?16:(c.addr.includes(':')?16:4))+2+1;return{bytes:n,withDerivedIce:2+32+1+hostUdp.reduce((s,c)=>s+(c.mdns?16:(c.addr.includes(':')?16:4))+2+1,0),candidates:hostUdp.length};}
function describe(desc){const s=desc.sdp,raw=te.encode(JSON.stringify({type:desc.type,sdp:s})),d=deflateSync(raw,{level:9}),text=b64(d),min=minimal(s,desc.type);return{sdpBytes:te.encode(s).length,jsonBytes:raw.length,deflateBytes:d.length,base64url:text.length,qrVersionL:qr(text.length,'L'),qrVersionM:qr(text.length,'M'),qrBinaryVersionL:qr(d.length,'L'),minimalBytes:min.bytes,minimalDerivedIceBytes:min.withDerivedIce,minimalB32Chars:Math.ceil(min.withDerivedIce*8/5),qrMinimalVersionL:qr(min.withDerivedIce,'L'),qrMinimalVersionM:qr(min.withDerivedIce,'M')};}
function gather(pc,timeout=20000){return new Promise(res=>{const t0=now();const cands=[];const done=why=>{res({ms:Math.round(now()-t0),why,cands});};const to=setTimeout(()=>done('timeout'),timeout);pc.addEventListener('icecandidate',e=>{if(e.candidate&&e.candidate.candidate)cands.push(e.candidate.candidate);else if(!e.candidate){clearTimeout(to);done('complete');}});});}
function peer(id,cfg={}){
 const events=[];const p={id,events,t0:now(),rx:{bytes:0,frames:0},txBytes:0,blobParts:new Map(),signalRelay:null,cfg};
 const pcConfig={iceServers:cfg.iceServers||[]};if(cfg.certificate)pcConfig.certificates=[cfg.certificate];if(cfg.iceTransportPolicy)pcConfig.iceTransportPolicy=cfg.iceTransportPolicy;
 const pc=new RTCPeerConnection(pcConfig);p.pc=pc;
 const mark=(k,v)=>events.push({t:Math.round(now()-p.t0),k,v});
 pc.addEventListener('connectionstatechange',()=>mark('conn',pc.connectionState));
 pc.addEventListener('iceconnectionstatechange',()=>mark('ice',pc.iceConnectionState));
 pc.addEventListener('icegatheringstatechange',()=>mark('gather',pc.iceGatheringState));
 state.peers.set(id,p);return p;
}
function wireChannel(p,dc){p.dc=dc;dc.binaryType='arraybuffer';dc.bufferedAmountLowThreshold=LOW;p.events.push({t:Math.round(now()-p.t0),k:'dc-wired'});
 p.open=new Promise(res=>{if(dc.readyState==='open')res();else dc.addEventListener('open',()=>{p.openedAt=now();p.events.push({t:Math.round(now()-p.t0),k:'dc-open'});res();});});
 dc.addEventListener('close',()=>p.events.push({t:Math.round(now()-p.t0),k:'dc-close'}));
 dc.addEventListener('error',e=>p.events.push({t:Math.round(now()-p.t0),k:'dc-error',v:String(e.error?.message||e.error||'')}));
 dc.addEventListener('message',e=>onFrame(p,new Uint8Array(e.data)));
}
// ----- optional application-layer encryption -----
async function seal(bytes){if(!state.key)return bytes;const iv=crypto.getRandomValues(new Uint8Array(12));const ct=new Uint8Array(await crypto.subtle.encrypt({name:'AES-GCM',iv},state.key,bytes));const out=new Uint8Array(12+ct.length);out.set(iv);out.set(ct,12);return out;}
async function unseal(bytes){if(!state.key)return bytes;return new Uint8Array(await crypto.subtle.decrypt({name:'AES-GCM',iv:bytes.subarray(0,12)},state.key,bytes.subarray(12)));}
// ----- framing: [type][msgId u32][seq u32][last u8] payload; large messages are chunked -----
let msgCounter=1;
const T={SV:0,UPDATE:1,BLOBREQ:2,BLOB:3,AWARE:4,SIGNAL:5,PING:6,PONG:7,HELLO:8,TAMPER:9};
async function waitBuffer(p){const dc=p.dc;if(dc.bufferedAmount<=HIGH)return;await new Promise(res=>{const on=()=>{dc.removeEventListener('bufferedamountlow',on);res();};dc.addEventListener('bufferedamountlow',on);});}
async function sendMsg(p,type,payload,chunk=p.chunk||CHUNK){await p.open;const id=msgCounter++;const body=await seal(payload);let seq=0;for(let off=0;off<body.length||seq===0;off+=chunk){await waitBuffer(p);const part=body.subarray(off,off+chunk),last=off+chunk>=body.length?1:0,frame=new Uint8Array(10+part.length);const dv=new DataView(frame.buffer);frame[0]=type;dv.setUint32(1,id);dv.setUint32(5,seq++);frame[9]=last;frame.set(part,10);p.dc.send(frame);p.txBytes+=frame.length;}return body.length;}
const assembling=new Map();
async function onFrame(p,f){p.rx.bytes+=f.length;p.rx.frames++;const dv=new DataView(f.buffer,f.byteOffset),type=f[0],id=dv.getUint32(1),last=f[9];const k=p.id+':'+id;let parts=assembling.get(k);if(!parts){parts=[];assembling.set(k,parts);}parts.push(f.slice(10));if(!last)return;assembling.delete(k);const n=parts.reduce((s,x)=>s+x.length,0),body=new Uint8Array(n);let o=0;for(const x of parts){body.set(x,o);o+=x.length;}
 p.chain=(p.chain||Promise.resolve()).then(async()=>{try{const plain=await unseal(body);await handle(p,type,plain);}catch(e){p.events.push({t:Math.round(now()-p.t0),k:'decrypt-or-handle-error',v:String(e.message||e)});state.log.push(String(e.stack||e));}});}
async function handle(p,type,b){
 if(type===T.SV){const diff=Y.encodeStateAsUpdate(state.doc,b);p.syncUpdateBytes=(p.syncUpdateBytes||0)+diff.length;await sendMsg(p,T.UPDATE,diff);}
 else if(type===T.UPDATE){p.lastUpdateBytes=b.length;p.updatesIn=(p.updatesIn||0)+1;Y.applyUpdate(state.previewDoc||(state.previewDoc=new Y.Doc()),b);
   const missing=blobRefs(state.previewDoc).filter(r=>!knownBlob(state.doc,r.hash)&&!p.requested?.has(r.hash));
   p.requested=p.requested||new Set();for(const r of missing){p.requested.add(r.hash);await sendMsg(p,T.BLOBREQ,te.encode(r.hash));}
   const stillMissing=blobRefs(state.previewDoc).filter(r=>!knownBlob(state.doc,r.hash));if(stillMissing.length){p.pending=p.pending||[];p.pending.push(b);return;}
   Y.applyUpdate(state.doc,b,'peer');p.appliedAt=now();for(const o of state.peers.values())if(o!==p&&o.dc?.readyState==='open'&&o.forward)await sendMsg(o,T.UPDATE,b);}
 else if(type===T.BLOBREQ){const hash=td.decode(b),bytes=knownBlob(state.doc,hash);if(!bytes)throw new Error('no blob');const head=te.encode(hash),msg=new Uint8Array(1+head.length+bytes.length);msg[0]=head.length;msg.set(head,1);msg.set(bytes,1+head.length);await sendMsg(p,T.BLOB,msg);p.blobSentAt=now();}
 else if(type===T.BLOB){const n=b[0],hash=td.decode(b.subarray(1,1+n)),bytes=b.slice(1+n),ref=blobRefs(state.previewDoc).find(r=>r.hash===hash);const t=now();installBlob(state.doc,ref,bytes);p.verifyMs=(p.verifyMs||0)+now()-t;p.blobBytes=(p.blobBytes||0)+bytes.length;p.blobDoneAt=now();
   if(!blobRefs(state.previewDoc).some(r=>!knownBlob(state.doc,r.hash))){const pending=p.pending||[];p.pending=[];for(const u of pending)Y.applyUpdate(state.doc,u,'peer');p.appliedAt=now();}}
 else if(type===T.SIGNAL){const m=JSON.parse(td.decode(b));if(m.to===state.me){state.signalBox.push(m);state.signalWake?.();}else{const t=state.peers.get(m.to);if(t)await sendMsg(t,T.SIGNAL,b);}}
 else if(type===T.PING){await sendMsg(p,T.PONG,b);}
 else if(type===T.PONG){p.pongAt=now();p.pongWake?.();}
 else if(type===T.HELLO){p.remoteHello=JSON.parse(td.decode(b));}
}
function waitIf(cond,ms=60000,step=25){return new Promise((res,rej)=>{const t0=now();const iv=setInterval(()=>{if(cond()){clearInterval(iv);res(Math.round(now()-t0));}else if(now()-t0>ms){clearInterval(iv);rej(new Error('timeout'));}},step);});}
// ------ certificate fingerprint and SAS ------
function fingerprintFromSdp(sdp){return /a=fingerprint:sha-256 (\S+)/i.exec(sdp)?.[1];}
async function sas(a,b){const [x,y]=[a,b].sort();const h=new Uint8Array(await crypto.subtle.digest('SHA-256',te.encode(x+'|'+y)));const n=((h[0]<<16)|(h[1]<<8)|h[2])%1000000;return String(n).padStart(6,'0');}
function compactEncode(desc){const sdp=desc.sdp,fp=hexToBytes(/a=fingerprint:sha-256 (\S+)/i.exec(sdp)[1]),u=te.encode(/a=ice-ufrag:(\S+)/.exec(sdp)[1]),w=te.encode(/a=ice-pwd:(\S+)/.exec(sdp)[1]);const cands=candidateSummary(sdp).filter(c=>c.proto==='udp'&&(c.mdns||!c.addr.includes(':'))).slice(0,4);const parts=[Uint8Array.of(desc.type==='offer'?1:2),fp,Uint8Array.of(u.length),u,Uint8Array.of(w.length),w,Uint8Array.of(cands.length)];for(const c of cands){if(c.mdns){const hex=c.addr.replace('.local','').replace(/-/g,'');parts.push(Uint8Array.of(0),Uint8Array.from(hex.match(/../g).map(x=>parseInt(x,16))));}else parts.push(Uint8Array.of(1),Uint8Array.from(c.addr.split('.').map(Number)));parts.push(Uint8Array.of(c.port>>8,c.port&255));}const n=parts.reduce((a,b)=>a+b.length,0),o=new Uint8Array(n);let i=0;for(const x of parts){o.set(x,i);i+=x.length;}return o;}
function compactDecode(b){let i=0;const type=b[i++]===1?'offer':'answer',fp=[...b.subarray(i,i+32)].map(x=>x.toString(16).padStart(2,'0').toUpperCase()).join(':');i+=32;const ul=b[i++],ufrag=td.decode(b.subarray(i,i+ul));i+=ul;const pl=b[i++],pwd=td.decode(b.subarray(i,i+pl));i+=pl;const n=b[i++];const lines=[];for(let k=0;k<n;k++){const kind=b[i++];let addr;if(kind===0){const h=[...b.subarray(i,i+16)].map(x=>x.toString(16).padStart(2,'0')).join('');addr=`${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20)}.local`;i+=16;}else{addr=[...b.subarray(i,i+4)].join('.');i+=4;}const port=(b[i]<<8)|b[i+1];i+=2;lines.push(`a=candidate:${k+1} 1 udp ${2122260223-k} ${addr} ${port} typ host`);}
 const sdp=['v=0','o=- 1 2 IN IP4 127.0.0.1','s=-','t=0 0','a=group:BUNDLE 0','m=application 9 UDP/DTLS/SCTP webrtc-datachannel','c=IN IP4 0.0.0.0',`a=ice-ufrag:${ufrag}`,`a=ice-pwd:${pwd}`,`a=fingerprint:sha-256 ${fp}`,`a=setup:${type==='offer'?'actpass':'active'}`,'a=mid:0','a=sctp-port:5000','a=max-message-size:262144',...lines,'a=end-of-candidates',''].join('\r\n');return{type,sdp};}
const H={
 compactRound({desc}){const c=compactEncode(desc);return{bytes:c.length,b64:b64(c),base45ish:Math.ceil(c.length*16/11),qrL:qr(c.length,'L'),qrM:qr(c.length,'M'),desc:compactDecode(c)};},
 async fetchProbe({url}){const t=now();try{const c=new AbortController();setTimeout(()=>c.abort(),6000);const r=await fetch(url,{signal:c.signal,mode:'no-cors'});return{ok:true,type:r.type,ms:Math.round(now()-t)};}catch(e){return{ok:false,err:String(e.name+': '+e.message).slice(0,120),ms:Math.round(now()-t)};}},
 async setup({me,fixture,blobBytes=0,seedless=false}){
  await init('/scribyra_app_bg.wasm');state.me=me;state.signalBox=[];state.doc=new Y.Doc();
  if(!seedless)state.doc.getMap('meta').set('schemaVersion',SCHEMA_VERSION);
  const t0=now();
  if(fixture&&!seedless){const files=await (await fetch(fixture)).json();const entries=files.map(f=>({path:f.path,content:f.content}));if(blobBytes){const b=new Uint8Array(blobBytes);for(let o=0;o<blobBytes;o+=65536)crypto.getRandomValues(b.subarray(o,Math.min(o+65536,blobBytes)));entries.push({path:'assets/figure.bin',content:b});}
   addEntries(state.doc,entries);state.doc.getMap('meta').set('name','thesis');state.undo=null;}
  const update=Y.encodeStateAsUpdate(state.doc);return{ua:navigator.userAgent,buildMs:Math.round(now()-t0),updateBytes:update.length,files:projectFiles(state.doc).length,schema:SCHEMA_VERSION,refs:blobRefs(state.doc).length};
 },
 caps(){return{RTCPeerConnection:typeof RTCPeerConnection,BarcodeDetector:typeof BarcodeDetector,bluetooth:!!navigator.bluetooth,nfc:'NDEFReader'in window,TCPSocket:typeof TCPSocket,TCPServerSocket:typeof TCPServerSocket,UDPSocket:typeof UDPSocket,WebTransport:typeof WebTransport,subtle:!!crypto.subtle,RTCQuicTransport:typeof RTCQuicTransport,isSecureContext,gum:!!navigator.mediaDevices?.getUserMedia,locks:!!navigator.locks,dcTransfer:typeof RTCDataChannel!=='undefined'&&'transfer'in Object.getOwnPropertyDescriptors(RTCDataChannel.prototype),sctpMax:null};},
 async x25519(){const out={};for(const alg of['X25519','Ed25519','ECDH-P256']){try{const k=alg==='ECDH-P256'?await crypto.subtle.generateKey({name:'ECDH',namedCurve:'P-256'},false,['deriveBits']):await crypto.subtle.generateKey({name:alg},false,alg==='X25519'?['deriveBits']:['sign','verify']);out[alg]=!!k;}catch(e){out[alg]=String(e.name);}}return out;},
 async gumGrant(){try{const s=await navigator.mediaDevices.getUserMedia({video:true});state.gum=s;return{ok:true,tracks:s.getTracks().length};}catch(e){return{ok:false,err:e.name};}},
 async certTest(){const res={};try{const c=await RTCPeerConnection.generateCertificate({name:'ECDSA',namedCurve:'P-256',expires:365*864e5});res.expires=Math.round((c.expires-Date.now())/864e5);res.fp=c.getFingerprints()[0];const db=await new Promise((r,j)=>{const q=indexedDB.open('collab-cert',1);q.onupgradeneeded=()=>q.result.createObjectStore('c');q.onsuccess=()=>r(q.result);q.onerror=()=>j(q.error);});await new Promise((r,j)=>{const t=db.transaction('c','readwrite');t.objectStore('c').put(c,'k');t.oncomplete=r;t.onerror=()=>j(t.error);});const back=await new Promise((r,j)=>{const q=db.transaction('c').objectStore('c').get('k');q.onsuccess=()=>r(q.result);q.onerror=()=>j(q.error);});res.idbRoundTrip=back?.getFingerprints?.()[0]?.value===res.fp.value;const pc=new RTCPeerConnection({certificates:[back]});pc.createDataChannel('x');const o=await pc.createOffer();res.offerUsesPinned=(fingerprintFromSdp(o.sdp)||'').toLowerCase()===res.fp.value.toLowerCase();pc.close();state.pinned=back;}catch(e){res.error=String(e);}return res;},
 async offer({id,iceServers,usePinned,negotiatedChannel}){const p=peer(id,{iceServers,certificate:usePinned?state.pinned:undefined});const dc=p.pc.createDataChannel('scribyra',{ordered:true});wireChannel(p,dc);const g=gather(p.pc);await p.pc.setLocalDescription(await p.pc.createOffer());const gg=await g;const desc=p.pc.localDescription;return{desc:{type:desc.type,sdp:desc.sdp},size:describe(desc),gatherMs:gg.ms,gatherWhy:gg.why,candidates:candidateSummary(desc.sdp),fp:fingerprintFromSdp(desc.sdp)};},
 async answer({id,offer,iceServers,tamperFp,usePinned}){const p=peer(id,{iceServers,certificate:usePinned?state.pinned:undefined});p.pc.addEventListener('datachannel',e=>wireChannel(p,e.channel));if(tamperFp)offer={type:offer.type,sdp:offer.sdp.replace(/(a=fingerprint:sha-256 )(\S\S)/i,(m,a,b)=>a+(b==='AA'?'BB':'AA'))};const g=gather(p.pc);p.applyT=now();await p.pc.setRemoteDescription(offer);await p.pc.setLocalDescription(await p.pc.createAnswer());const gg=await g;const desc=p.pc.localDescription;return{desc:{type:desc.type,sdp:desc.sdp},size:describe(desc),gatherMs:gg.ms,gatherWhy:gg.why,candidates:candidateSummary(desc.sdp),fp:fingerprintFromSdp(desc.sdp)};},
 async accept({id,answer,tamperFp}){const p=state.peers.get(id);if(tamperFp)answer={type:answer.type,sdp:answer.sdp.replace(/(a=fingerprint:sha-256 )(\S\S)/i,(m,a,b)=>a+(b==='AA'?'BB':'AA'))};p.applyT=now();await p.pc.setRemoteDescription(answer);return true;},
 addRemoteCandidate({id,cand}){const p=state.peers.get(id);return p.pc.addIceCandidate({candidate:cand,sdpMid:'0'}).then(()=>true,e=>String(e));},
 async waitOpen({id,timeout=45000}){const p=state.peers.get(id);const t0=now();try{await Promise.race([(async()=>{while(!p.open)await new Promise(r=>setTimeout(r,20));await p.open;})(),new Promise((_,j)=>setTimeout(()=>j(new Error('timeout')),timeout))]);}catch(e){return{open:false,ms:Math.round(now()-t0),state:p.pc.connectionState,ice:p.pc.iceConnectionState,events:p.events};}
  return{open:true,sinceApplyMs:Math.round(now()-(p.applyT??t0)),waitMs:Math.round(now()-t0),state:p.pc.connectionState,ice:p.pc.iceConnectionState,maxMessage:p.pc.sctp?.maxMessageSize??null,events:p.events};},
 async pair({id}){const p=state.peers.get(id);const stats=await p.pc.getStats();const m=new Map();stats.forEach(s=>m.set(s.id,s));let pair=null;stats.forEach(s=>{if(s.type==='candidate-pair'&&(s.nominated||s.selected)&&s.state==='succeeded')pair=s;});const loc=pair&&m.get(pair.localCandidateId),rem=pair&&m.get(pair.remoteCandidateId);let tr=null;stats.forEach(s=>{if(s.type==='transport')tr=s;});return{local:loc&&{type:loc.candidateType,proto:loc.protocol,address:loc.address},remote:rem&&{type:rem.candidateType,proto:rem.protocol,address:rem.address},rttMs:pair?.currentRoundTripTime?Math.round(pair.currentRoundTripTime*1000*10)/10:null,dtls:tr?.dtlsCipher,tls:tr?.tlsVersion,srtp:tr?.srtpCipher};},
 events({id}){const p=state.peers.get(id);return{conn:p.pc.connectionState,ice:p.pc.iceConnectionState,dc:p.dc?.readyState,events:p.events};},
 async sas({a,b}){return sas(a,b);},
 remoteFpSeen({id}){const p=state.peers.get(id);return fingerprintFromSdp(p.pc.remoteDescription?.sdp||'');},
 localFp({id}){const p=state.peers.get(id);return fingerprintFromSdp(p.pc.localDescription?.sdp||'');},
 async setKey({pass}){const base=await crypto.subtle.importKey('raw',te.encode(pass),'HKDF',false,['deriveKey']);state.key=await crypto.subtle.deriveKey({name:'HKDF',hash:'SHA-256',salt:te.encode('scribyra-collab-proto'),info:te.encode('frames')},base,{name:'AES-GCM',length:256},false,['encrypt','decrypt']);return true;},
 clearKey(){state.key=null;},
 async initialSync({id,timeout=240000}){const p=state.peers.get(id);await p.open;const t0=now();p.appliedAt=0;const rx0=p.rx.bytes;const tx0=p.txBytes;await sendMsg(p,T.SV,Y.encodeStateVector(state.doc));await waitIf(()=>p.appliedAt>0,timeout);const m=now()-t0;return{ms:Math.round(m),rxBytes:p.rx.bytes-rx0,txBytes:p.txBytes-tx0,updateBytes:p.lastUpdateBytes,blobBytes:p.blobBytes||0,verifyMs:Math.round(p.verifyMs||0),files:projectFiles(state.doc).length,mbps:Math.round((p.rx.bytes-rx0)*8/m/10)/100};},
 hash(){return crypto.subtle.digest('SHA-256',Y.encodeStateAsUpdate(state.doc)).then(()=>({fileCount:projectFiles(state.doc).length,text:[...projectFiles(state.doc)].filter(f=>!f.binary).map(f=>f.path+':'+state.doc.getText('text:'+f.id).length).sort().join('|').length,sum:textSum(),sv:b64(Y.encodeStateVector(state.doc)).length}));},
 live({id,forward}){const p=state.peers.get(id);p.forward=forward;if(!state.liveWired){state.liveWired=true;state.doc.on('update',(u,o)=>{if(o==='peer')return;for(const q of state.peers.values())if(q.dc?.readyState==='open')sendMsg(q,T.UPDATE,u);});}return true;},
 edit({text,file='main.tex',at=0}){const f=projectFiles(state.doc).find(x=>x.path===file);state.doc.getText('text:'+f.id).insert(at,text);return state.doc.getText('text:'+f.id).length;},
 undoInit({file='main.tex'}){const f=projectFiles(state.doc).find(x=>x.path===file);const t=state.doc.getText('text:'+f.id);state.undo=new Y.UndoManager(t,{trackedOrigins:new Set([null]),captureTimeout:0});return true;},
 undoNow(){state.undo.undo();return state.undo.undoStack.length;},
 undoDepth(){return state.undo.undoStack.length;},
 read({file='main.tex',n=200}){const f=projectFiles(state.doc).find(x=>x.path===file);return state.doc.getText('text:'+f.id).toString().slice(0,n);},
 async waitText({text,file='main.tex',timeout=60000}){const f=()=>projectFiles(state.doc).find(x=>x.path===file);const ms=await waitIf(()=>{const x=f();return x&&state.doc.getText('text:'+x.id).toString().includes(text);},timeout,5);return ms;},
 async rtt({id,n=20}){const p=state.peers.get(id);await p.open;const r=[];for(let i=0;i<n;i++){const t=now();p.pongAt=0;await sendMsg(p,T.PING,new Uint8Array(8));await waitIf(()=>p.pongAt,5000,1);r.push(now()-t);}r.sort((a,b)=>a-b);return{median:Math.round(r[r.length>>1]*10)/10,max:Math.round(r[r.length-1]*10)/10};},
 setChunk({id,chunk}){state.peers.get(id).chunk=chunk;},
 deleteProbe(){const f=projectFiles(state.doc).find(x=>x.path!=='main.tex'&&!x.binary);const secret='TRASHED_SECRET_MARKER';state.doc.getText('text:'+f.id).insert(0,secret);deleteNode(state.doc,f.id);return{deleted:f.path,updateContains:td.decode(Y.encodeStateAsUpdate(state.doc)).includes(secret)};},
 inPlaceDeleteProbe(){const f=projectFiles(state.doc).find(x=>x.path==='main.tex');const t=state.doc.getText('text:'+f.id);const secret='DELETED_TEXT_MARKER';t.insert(0,secret);t.delete(0,secret.length);return{updateContains:td.decode(Y.encodeStateAsUpdate(state.doc)).includes(secret),gc:state.doc.gc};},
 inPlaceDeleteProbeUndoTracked(){const f=projectFiles(state.doc).find(x=>x.path==='main.tex');const t=state.doc.getText('text:'+f.id);const um=new Y.UndoManager(t,{trackedOrigins:new Set([null]),captureTimeout:0});const secret='UNDO_RETAINED_MARKER';t.insert(0,secret);t.delete(0,secret.length);const r={updateContains:td.decode(Y.encodeStateAsUpdate(state.doc)).includes(secret)};return r;},
 async sendMsgForTamper({id,payload}){const p=state.peers.get(id);await sendMsg(p,T.HELLO,te.encode(JSON.stringify(payload)));return true;},
 remoteHello({id}){return state.peers.get(id).remoteHello??null;},
 close({id}){state.peers.get(id)?.pc.close();state.peers.delete(id);return true;},
 // signaling relay over an existing data channel
 async relaySend({via,to,msg}){await sendMsg(state.peers.get(via),T.SIGNAL,te.encode(JSON.stringify({to,from:state.me,msg})));return true;},
 async relayRecv({timeout=30000}){await waitIf(()=>state.signalBox.length>0,timeout,5);return state.signalBox.shift();},
 logs(){return state.log;},
 stat({id}){const p=state.peers.get(id);return{rx:p.rx,tx:p.txBytes,updatesIn:p.updatesIn,appliedAt:p.appliedAt,pending:p.pending?.length,last:p.lastUpdateBytes,prev:state.previewDoc&&blobRefs(state.previewDoc).length,sv:[...Y.decodeStateVector(Y.encodeStateVector(state.doc)).entries()],pendingDoc:!!state.doc.store.pendingStructs};},
};
function textSum(){let h=0;for(const f of [...projectFiles(state.doc)].sort((a,b)=>a.path<b.path?-1:1)){if(f.binary)continue;const s=state.doc.getText('text:'+f.id).toString();for(let i=0;i<s.length;i++)h=(h*31+s.charCodeAt(i))|0;}return h;}
window.H=H;
