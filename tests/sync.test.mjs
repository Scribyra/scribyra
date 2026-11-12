import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as Y from 'yjs';
import { createHash } from 'node:crypto';
const wait = ms => new Promise(r=>setTimeout(r,ms));
async function until(predicate) { for(let i=0;i<150;i++){if(predicate())return;await wait(20);}throw new Error('Timed out waiting for convergence'); }
function connect(doc, room) {
  const socket=new WebSocket(`ws://127.0.0.1:8787/rooms/${room}`);socket.binaryType='arraybuffer';
  const send=bytes=>{if(socket.readyState===1){const frame=new Uint8Array(bytes.length+1);frame.set(bytes,1);socket.send(frame);}};
  const changed=(bytes,origin)=>{if(origin!=='server')send(bytes);};doc.on('update',changed);
  socket.addEventListener('message',({data})=>{const frame=new Uint8Array(data);if(frame[0]===0)Y.applyUpdate(doc,frame.slice(1),'server');});
  const opened=new Promise((resolve,reject)=>{socket.addEventListener('open',()=>{send(Y.encodeStateAsUpdate(doc));resolve();});socket.addEventListener('error',reject);});
  return {socket,opened,close(){doc.off('update',changed);socket.close();}};
}
test('JavaScript Yjs ↔ Rust Yrs convergence, offline merge, restart durability, and invalid update isolation',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'scribyra-sync-'));let server;
  async function start(){server=spawn('target/debug/examples/plaintext-demo',[],{env:{...process.env,SCRIBYRA_SYNC_DB:join(dir,'state.sqlite')},stdio:['ignore','pipe','pipe']});await new Promise((resolve,reject)=>{server.stdout.once('data',resolve);server.once('error',reject);server.once('exit',code=>reject(new Error(`Server exited ${code}`)));});}
  async function stop(){if(server.exitCode!==null)return;const done=new Promise(resolve=>server.once('exit',resolve));server.kill();await done;}
  const connections=[];
  try {
    await start();
    const asset=Buffer.from('immutable image bytes'),hash=createHash('sha256').update(asset).digest('hex');
    const assetUrl=`http://127.0.0.1:8787/rooms/interop/blobs/${hash}`;
    const headers={'Origin':'http://127.0.0.1:4173','Content-Type':'application/octet-stream'};
    let response=await fetch(assetUrl,{method:'OPTIONS',headers:{Origin:headers.Origin,'Access-Control-Request-Method':'PUT','Access-Control-Request-Headers':'content-type'}});
    assert.equal(response.headers.get('access-control-allow-origin'),headers.Origin);
    assert.match(response.headers.get('access-control-allow-methods'),/PUT/);
    assert.equal((await fetch(assetUrl,{method:'PUT',headers,body:Buffer.from('wrong')})).status,400);
    assert.equal((await fetch(assetUrl)).status,404);
    assert.equal((await fetch(assetUrl,{method:'PUT',headers:{...headers,Origin:'https://untrusted.invalid'},body:asset})).status,403);
    assert.equal((await fetch(assetUrl,{method:'PUT',headers,body:asset})).status,201);
    assert.equal((await fetch(assetUrl,{method:'PUT',headers,body:asset})).status,204);
    assert.equal((await fetch(assetUrl,{method:'HEAD',headers})).status,200);
    assert.equal((await fetch(assetUrl.replace('/interop/','/other/'))).status,404);
    assert.equal((await fetch(assetUrl.replace(hash,'bad-hash'))).status,400);
    const a=new Y.Doc(),b=new Y.Doc();const ca=connect(a,'interop');connections.push(ca);await ca.opened;
    a.getText('text').insert(0,'Hello 🌍');const cb=connect(b,'interop');connections.push(cb);await cb.opened;
    await until(()=>b.getText('text').toString()==='Hello 🌍');
    a.getText('text').insert(0,'A ');b.getText('text').insert(0,'B ');await until(()=>a.getText('text').toString()===b.getText('text').toString());
    cb.close();await wait(100);b.getText('text').insert(b.getText('text').length,' offline');a.getText('text').insert(0,'online ');
    const cb2=connect(b,'interop');connections.push(cb2);await cb2.opened;await until(()=>a.getText('text').toString()===b.getText('text').toString()&&a.getText('text').toString().includes('offline'));
    const expected=a.getText('text').toString();ca.close();cb2.close();await wait(100);await stop();await start();
    assert.deepEqual(Buffer.from(await (await fetch(assetUrl)).arrayBuffer()),asset);
    const c=new Y.Doc(),cc=connect(c,'interop');connections.push(cc);await cc.opened;await until(()=>c.getText('text').toString()===expected);
    const malformed=new WebSocket('ws://127.0.0.1:8787/rooms/interop');await new Promise(r=>malformed.addEventListener('open',r));malformed.send(new Uint8Array([0,255,255,255]));await new Promise(r=>malformed.addEventListener('close',r));
    const d=new Y.Doc(),cd=connect(d,'interop');connections.push(cd);await cd.opened;await until(()=>d.getText('text').toString()===expected);assert.equal(d.getText('text').toString(),expected);
  }finally{for(const c of connections)c.close();await stop();await rm(dir,{recursive:true,force:true});}
});

test('browser sync diagnostics finish at durable acknowledgement and native export excludes room/content',async()=>{
 await import('./helpers/core.mjs');const {TelemetryRecorder}=await import('../web/pkg/scribyra_app.js'),{telemetry}=await import('../web/telemetry.js'),{installObservability}=await import('../web/observability.js'),{connectDemo}=await import('../web/sync.js');
 const {readdir,readFile}=await import('node:fs/promises');
 const dir=await mkdtemp(join(tmpdir(),'scribyra-sync-diagnostics-')),recorder=new TelemetryRecorder(),api=telemetry({recorder});api.configure({collect:true,allowExport:true});installObservability(api);
 const server=spawn('target/debug/examples/plaintext-demo',[],{env:{...process.env,SCRIBYRA_SYNC_DB:join(dir,'state.sqlite'),SCRIBYRA_DIAGNOSTICS:'1',SCRIBYRA_DIAGNOSTICS_DIR:join(dir,'diagnostics')},stdio:['ignore','pipe','pipe']});let a,b;const first=new Y.Doc(),second=new Y.Doc();
 try{
  await new Promise((resolve,reject)=>{server.stdout.once('data',resolve);server.once('error',reject);server.once('exit',code=>reject(Error(`Server exited ${code}`)));});
  const statuses=[];a=connectDemo(first,'PRIVATE_ROOM_IDENTIFIER',status=>statuses.push(status));b=connectDemo(second,'PRIVATE_ROOM_IDENTIFIER',()=>{});
  await until(()=>statuses.includes('Demo synchronized'));api.clear();first.getText('text').insert(0,'PRIVATE_DOCUMENT_SOURCE');
  await until(()=>second.getText('text').toString()==='PRIVATE_DOCUMENT_SOURCE'&&api.snapshot().events.some(event=>event.operation==='sync'&&event.outcome==='success'&&event.metrics.some(metric=>metric.name==='bytes')));
  const snapshot=api.snapshot();assert(snapshot.events.some(event=>event.operation==='sync'&&event.outcome==='started'));
  let native;for(let i=0;i<100;i++){try{const [child]=await readdir(join(dir,'diagnostics'));native=JSON.parse(await readFile(join(dir,'diagnostics',child,'snapshot.json'),'utf8'));}catch{}if(native?.events.some(event=>event.operation==='sync'&&event.outcome==='success'))break;await wait(25);}
  assert(native.events.some(event=>event.runtime==='sync_service'&&event.operation==='sync'&&event.outcome==='success'));
  assert.doesNotMatch(JSON.stringify({snapshot,native}),/PRIVATE_ROOM_IDENTIFIER|PRIVATE_DOCUMENT_SOURCE/);
 }finally{a?.close();b?.close();first.destroy();second.destroy();installObservability(null);recorder.free();if(server.exitCode===null){const stopped=new Promise(resolve=>server.once('exit',resolve));server.kill();await stopped;}await rm(dir,{recursive:true,force:true});}
});
