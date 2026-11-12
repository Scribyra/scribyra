import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomBytes, createCipheriv } from 'node:crypto';
import { once } from 'node:events';
import WebSocket from 'ws';
import { service,id,hash } from './helpers/service.mjs';

async function relay(s,room=id(),connection=id(),bearer=s.bearer) {
  const socket=new WebSocket(s.url.replace('http:','ws:')+'/v1/connect');
  socket.on('error',()=>{});await once(socket,'open');
  const message=new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>finish(Error('Relay ready deadline')),2000);
    function finish(error){clearTimeout(timer);socket.off('message',ready);socket.off('close',ended);if(error)reject(error);else resolve();}
    function ready(){finish();}function ended(){finish(Error('Relay closed before ready'));}
    socket.once('message',ready);socket.once('close',ended);
  });
  socket.send(JSON.stringify({version:1,bearer,room,connection}));
  try {await message;return socket;}catch(error){socket.terminate();throw error;}
}
const closed=socket=>new Promise(resolve=>socket.once('close',resolve));

test('opaque objects survive SIGKILL, retry and contain no seeded document plaintext',async()=>{
  const s=await service();
  try {
    const marker='PRIVATE_SEEDED_DOCUMENT_7b9c_\\documentclass{article}';
    const cipher=createCipheriv('aes-256-gcm',randomBytes(32),randomBytes(12));
    const bytes=Buffer.concat([cipher.update(marker),cipher.final(),cipher.getAuthTag()]);
    for(let n=0;n<3;n++) {
      const response=await fetch(s.object(bytes),{method:'PUT',headers:s.headers,body:bytes});assert.equal(response.status,n?204:201);
      await s.stop('SIGKILL');await s.start();
      assert.deepEqual(Buffer.from(await (await fetch(s.object(bytes),{headers:s.headers})).arrayBuffer()),bytes);
    }
    assert.equal((await fetch(s.url+'/ready')).status,200);
    await s.stop();
    const files=await readdir(s.config.data,{recursive:true,withFileTypes:true});
    for(const entry of files)if(entry.isFile())assert.equal((await readFile(join(entry.parentPath,entry.name))).includes(Buffer.from(marker)),false);
    assert(!s.logs.includes(marker));assert(!s.logs.includes(s.bearer));assert(!s.logs.includes(s.namespace));assert(!s.logs.includes(hash(bytes)));
    // Startup recovers an unacknowledged crash remnant without touching durable bytes.
    await writeFile(join(s.config.data,'blobs','pending'),'unacknowledged');await s.start();
    assert(!((await readdir(join(s.config.data,'blobs'))).includes('pending')));
    assert.equal((await fetch(s.object(bytes),{headers:s.headers})).status,200);
  } finally {await s.close();}
});

test('authentication, namespace, version, origin, hash and object bounds fail closed',async()=>{
  const s=await service({object_bytes:256});const bytes=randomBytes(32);
  try {
    assert.equal((await fetch(s.object(bytes))).status,401);
    assert.equal((await fetch(s.object(bytes,id()),{headers:s.headers})).status,403);
    assert.equal((await fetch(s.url+'/v2')).status,404);
    assert.equal((await fetch(s.url+'/rooms/legacy-demo')).status,404);
    assert.equal((await fetch(s.object(bytes),{headers:{...s.headers,Origin:'https://forbidden.invalid'}})).status,403);
    assert.equal((await fetch(s.object(bytes),{method:'PUT',headers:s.headers,body:randomBytes(32)})).status,400);
    assert.equal((await fetch(s.object(bytes),{method:'PUT',headers:s.headers,body:randomBytes(257)})).status,413);
    const cors=await fetch(s.object(bytes),{method:'OPTIONS',headers:{Origin:s.config.origins[0],'Access-Control-Request-Method':'PUT','Access-Control-Request-Headers':'authorization,content-type'}});
    assert.equal(cors.headers.get('access-control-allow-origin'),s.config.origins[0]);
    assert.equal((await fetch(s.object(bytes),{method:'PUT',headers:s.headers,body:bytes})).status,201);
  } finally {await s.close();}
});

test('serialized quotas bound concurrent writes and idempotent retries consume no quota',async()=>{
  const s=await service({object_bytes:64,namespace_bytes:128,total_bytes:128,namespace_objects:2,total_objects:2});
  try {
    const a=randomBytes(64),b=randomBytes(64),c=randomBytes(64);
    const statuses=await Promise.all([a,b,c].map(body=>fetch(s.object(body),{method:'PUT',headers:s.headers,body}).then(r=>r.status)));
    assert.deepEqual(statuses.sort(),[201,201,507]);
    for(const bytes of [a,b,c])if((await fetch(s.object(bytes),{headers:s.headers})).status===200)assert.equal((await fetch(s.object(bytes),{method:'PUT',headers:s.headers,body:bytes})).status,204);
    await s.stop();await s.start();assert.equal((await fetch(s.object(randomBytes(16)),{method:'PUT',headers:s.headers,body:randomBytes(16)})).status,400);
  } finally {await s.close();}
});

test('health has bounded capacity independent of ordinary request admission',async()=>{
  const s=await service({requests_per_second:2});
  try { const statuses=await Promise.all(Array.from({length:8},()=>fetch(s.url+'/health').then(r=>r.status)));assert(statuses.includes(429));assert(statuses.filter(x=>x===200).length<=2); }
  finally {await s.close();}
});

test('relay sends exact opaque bytes to peers only, isolates rooms and closes at absolute expiry',async()=>{
  const s=await service({room_seconds:2});const sockets=[];
  try {
    const room=id(),a=await relay(s,room),b=await relay(s,room),c=await relay(s);sockets.push(a,b,c);
    let reflected=0,foreign=0;a.on('message',()=>reflected++);c.on('message',()=>foreign++);
    const receive=once(b,'message'),bytes=randomBytes(256),expired=closed(b);a.send(bytes);
    assert.deepEqual((await receive)[0],bytes);await expired;assert.equal(reflected,0);assert.equal(foreign,0);
  } finally {for(const socket of sockets)socket.terminate();await s.close();}
});

test('relay bounds rooms, members, messages; shutdown closes active peers',async()=>{
  const s=await service({rooms:1,connections:6,messages_per_second:1});const sockets=[];
  try {
    const room=id();for(let n=0;n<5;n++)sockets.push(await relay(s,room));
    for(const deniedRoom of [room,id()]) {
      const socket=new WebSocket(s.url.replace('http:','ws:')+'/v1/connect');await once(socket,'open');const done=closed(socket);
      socket.send(JSON.stringify({version:1,bearer:s.bearer,room:deniedRoom,connection:id()}));await done;
    }
    const done=closed(sockets[0]);sockets[0].send(randomBytes(32));sockets[0].send(randomBytes(32));await done;
    const shutdown=closed(sockets[1]);await s.stop();assert.notEqual(await shutdown,1006);
  } finally {for(const socket of sockets)socket.terminate();await s.close();}
});

test('startup refuses corrupted committed objects, future schema and duplicate ownership',async()=>{
  const s=await service();const bytes=randomBytes(32);
  try {
    assert.equal((await fetch(s.object(bytes),{method:'PUT',headers:s.headers,body:bytes})).status,201);
    // A separate process cannot acquire the same directory lock.
    const {spawn}=await import('node:child_process');
    const duplicate=spawn('target/debug/scribyra-sync',[],{env:{...process.env,SCRIBYRA_SERVICE_CONFIG:join(s.directory,'config.json')},stdio:'ignore'});
    assert.equal((await once(duplicate,'exit'))[0],1);
    await writeFile(join(s.config.data,'blobs',s.namespace+'-'+hash(bytes)),'corrupt');
    assert.equal((await fetch(s.object(bytes),{method:'PUT',headers:s.headers,body:bytes})).status,500);
    await s.stop();
    await assert.rejects(s.start(),/Service exited 1/);
    await writeFile(join(s.config.data,'blobs',s.namespace+'-'+hash(bytes)),bytes);
    const {execFileSync}=await import('node:child_process');
    execFileSync('python3',['-c','import sqlite3,sys; c=sqlite3.connect(sys.argv[1]); c.execute("PRAGMA user_version=2"); c.commit()',join(s.config.data,'metadata.sqlite')]);
    await assert.rejects(s.start(),/Service exited 1/);
  } finally {await s.close();}
});

test('pending sockets consume connection slots, bad authentication and oversized frames close',async()=>{
  const s=await service({connections:1,frame_bytes:1024});let a;
  try {
    a=new WebSocket(s.url.replace('http:','ws:')+'/v1/connect');await once(a,'open');
    const denied=new WebSocket(s.url.replace('http:','ws:')+'/v1/connect');denied.on('error',()=>{});
    const status=await new Promise(resolve=>denied.once('unexpected-response',(_request,response)=>{response.resume();resolve(response.statusCode);denied.terminate();}));assert.equal(status,429);
    let done=closed(a);a.send(JSON.stringify({version:1,bearer:id(),room:id(),connection:id()}));await done;
  } finally {a?.terminate();await s.close();}
  const t=await service({frame_bytes:1024});let b;
  try {b=await relay(t);const done=closed(b);b.send(randomBytes(1025));await done;}
  finally {b?.terminate();await t.close();}
});

test('storage and relay rights remain independent and environment overrides apply',async()=>{
  const bearer=id(),namespace=id();
  const s=await service({principals:[{token_hash:hash(bearer),namespace,storage:false,relay:true}]});
  try {
    const bytes=randomBytes(32);
    assert.equal((await fetch(s.object(bytes,namespace),{method:'PUT',headers:{Authorization:`Bearer ${bearer}`},body:bytes})).status,403);
    const ws=await relay(s,id(),id(),bearer);ws.terminate();
    await s.stop();await s.start({SCRIBYRA_SERVICE_REQUESTS_PER_SECOND:'1'});
    const statuses=await Promise.all([1,2,3].map(()=>fetch(s.url+'/health').then(r=>r.status)));assert(statuses.includes(429));
    await s.stop();await assert.rejects(s.start({SCRIBYRA_SERVICE_ROOM_SECONDS:'0'}),/Service exited 1/);
  } finally {await s.close();}
});

test('total TCP limit includes clients that never send HTTP',async()=>{
  const {connect}=await import('node:net');const s=await service({tcp_connections:1});let idle,denied;
  try {
    const url=new URL(s.url);idle=connect(Number(url.port),'127.0.0.1');await once(idle,'connect');
    // The next accepted socket is closed before any HTTP parsing or allocation.
    denied=connect(Number(url.port),'127.0.0.1');denied.on('error',()=>{});await once(denied,'close');
  } finally {idle?.destroy();denied?.destroy();await s.close();}
});

test('global object quota is shared across independent authenticated namespaces',async()=>{
  const a=id(),b=id(),na=id(),nb=id();
  const s=await service({object_bytes:32,namespace_bytes:64,total_bytes:64,namespace_objects:2,total_objects:2,principals:[
    {token_hash:hash(a),namespace:na,storage:true,relay:false},{token_hash:hash(b),namespace:nb,storage:true,relay:false},
  ]});
  try {
    for(const [token,ns,expected] of [[a,na,201],[b,nb,201],[b,nb,507]]) {
      const bytes=randomBytes(32);assert.equal((await fetch(s.object(bytes,ns),{method:'PUT',headers:{Authorization:`Bearer ${token}`},body:bytes})).status,expected);
    }
  } finally {await s.close();}
});

test('timed-out disk work retains its slot until the underlying operation finishes',async()=>{
  const {execFileSync}=await import('node:child_process'),{unlink}=await import('node:fs/promises');
  const s=await service({http_concurrency:1});const bytes=randomBytes(32),path=join(s.config.data,'blobs',s.namespace+'-'+hash(bytes));
  try {
    assert.equal((await fetch(s.object(bytes),{method:'PUT',headers:s.headers,body:bytes})).status,201);
    // A FIFO stalls the actual filesystem read without blocking the async reactor.
    await unlink(path);execFileSync('mkfifo',[path]);
    assert.equal((await fetch(s.object(bytes),{headers:s.headers})).status,408);
    assert.equal((await fetch(s.url+'/health')).status,200);
    assert.equal((await fetch(s.object(bytes),{headers:s.headers})).status,503);
    assert.equal((await fetch(s.url+'/ready')).status,503);
    await writeFile(path,bytes);await unlink(path);await writeFile(path,bytes);
    for(let n=0;n<100;n++) {if((await fetch(s.url+'/ready')).status===200)break;await new Promise(r=>setTimeout(r,20));}
    assert.deepEqual(Buffer.from(await(await fetch(s.object(bytes),{headers:s.headers})).arrayBuffer()),bytes);
  } finally {await s.stop('SIGKILL');await s.close();}
});

const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function stalledPut(s,headers={}) {
  const {connect}=await import('node:net'),url=new URL(s.object(Buffer.alloc(16)));
  const socket=connect(Number(url.port),'127.0.0.1');socket.on('error',()=>{});
  await once(socket,'connect');
  let status;socket.on('data',bytes=>{status=Number(bytes.toString().match(/^HTTP\/1.1 (\d+)/)?.[1]);});
  socket.write(`PUT ${url.pathname} HTTP/1.1\r\nHost: localhost\r\nContent-Length: 16\r\n${Object.entries(headers).map(([k,v])=>`${k}: ${v}\r\n`).join('')}\r\nx`);
  return {socket,get status(){return status;}};
}
async function responsive(s,bytes,headers=s.headers,namespace=s.namespace) {
  assert.equal((await fetch(s.url+'/health',{signal:AbortSignal.timeout(1000)})).status,200);
  const response=await fetch(s.object(bytes,namespace),{headers,signal:AbortSignal.timeout(1000)});
  assert.equal(response.status,200);assert.deepEqual(Buffer.from(await response.arrayBuffer()),bytes);
}

test('slow unauthenticated PUT probe leaves health and authorized GET responsive',async()=>{
  const s=await service(),bytes=randomBytes(32),pending=[];
  try {
    assert.equal((await fetch(s.object(bytes),{method:'PUT',headers:s.headers,body:bytes})).status,201);
    for(let n=0;n<16;n++)pending.push(await stalledPut(s));
    await delay(100);
    await responsive(s,bytes);
    assert(pending.every(p=>p.status===401),'reject before the missing body arrives');
    // A valid capability for a foreign namespace must also fail before body collection.
    const other=id();for(const p of pending)p.socket.destroy();await s.stop();
    s.config.principals.push({token_hash:hash(other),namespace:id(),storage:true,relay:true});
    await writeFile(join(s.directory,'config.json'),JSON.stringify(s.config));await s.start();
    for(let n=0;n<16;n++)pending.push(await stalledPut(s,{Authorization:`Bearer ${other}`}));
    await delay(100);await responsive(s,bytes);
    assert(pending.slice(16).every(p=>p.status===403));
  } finally {for(const p of pending)p.socket.destroy();await s.close();}
});

test('authenticated upload slots are partitioned by principal and shared namespace',async()=>{
  const a=id(),alias=id(),third=id(),b=id(),na=id(),nb=id(),pending=[];
  const s=await service({http_concurrency:2,principal_uploads:1,namespace_uploads:2,principals:[
    {token_hash:hash(a),namespace:na,storage:true,relay:true},
    {token_hash:hash(alias),namespace:na,storage:true,relay:true},
    {token_hash:hash(third),namespace:na,storage:true,relay:true},
    {token_hash:hash(b),namespace:nb,storage:true,relay:true},
  ]});
  const bytes=randomBytes(32),headers={Authorization:`Bearer ${b}`};
  const attack={...s,object:bytes=>s.object(bytes,na)};
  try {
    assert.equal((await fetch(s.object(bytes,nb),{method:'PUT',headers,body:bytes})).status,201);
    for(const tokens of [[a,a],[alias,alias],[third]]) {
      const group=[];
      for(const token of tokens){const p=await stalledPut(attack,{Authorization:`Bearer ${token}`});pending.push(p);group.push(p);}
      for(let n=0;n<100&&group.every(p=>p.status===undefined);n++)await delay(10);
      assert.deepEqual(group.map(p=>p.status??0).sort((a,b)=>a-b),tokens.length===2?[0,429]:[429]);
    }
    await responsive(s,bytes,headers,nb);
    const more=randomBytes(32);
    assert.equal((await fetch(s.object(more,nb),{method:'PUT',headers,body:more,signal:AbortSignal.timeout(1000)})).status,201);
  } finally {for(const p of pending)p.socket.destroy();await s.close();}
});

async function deniedRelay(s,bearer,room=id()) {
  const socket=new WebSocket(s.url.replace('http:','ws:')+'/v1/connect');
  socket.on('error',()=>{});
  try {
    await once(socket,'open');let ready=false;socket.on('message',()=>{ready=true;});
    const done=closed(socket);socket.send(JSON.stringify({version:1,bearer,room,connection:id()}));
    await done;assert.equal(ready,false);
  } finally {socket.terminate();}
}

test('disconnected-room probe frees live capacity and isolates namespace quotas without extending attempts',async()=>{
  const a=id(),alias=id(),b=id(),na=id(),nb=id(),sockets=[];
  const s=await service({namespace_rooms:2,namespace_connections:3,namespace_room_attempts:24,room_seconds:4,principals:[
    {token_hash:hash(a),namespace:na,storage:false,relay:true},
    {token_hash:hash(alias),namespace:na,storage:false,relay:true},
    {token_hash:hash(b),namespace:nb,storage:false,relay:true},
  ]});
  try {
    const original=id(),started=Date.now();
    for(let n=0;n<20;n++) {
      const socket=await relay(s,n? id():original,id(),a),done=closed(socket);socket.close();await done;
    }
    sockets.push(await relay(s,id(),id(),b));
    const r1=id(),r2=id();sockets.push(await relay(s,r1,id(),a),await relay(s,r2,id(),alias));
    await deniedRelay(s,a); // Active room quota, shared by both capabilities.
    sockets.push(await relay(s,r1,id(),alias));
    await deniedRelay(s,a,r2); // Namespace connection quota (not the five-member room cap).
    for(const socket of sockets.splice(1)){const done=closed(socket);socket.close();await done;}
    await delay(Math.max(0,started+2500-Date.now()));
    const rejoined=await relay(s,original,id(),a);sockets.push(rejoined);
    await closed(rejoined);assert(Date.now()-started<5000,'rejoin must retain the original four-second deadline');
    // The attempt table is independently bounded; one tenant cannot consume its global budget.
    await s.stop();await s.start();
    for(let n=0;n<24;n++){const socket=await relay(s,id(),id(),a),done=closed(socket);socket.close();await done;}
    await deniedRelay(s,alias);
    sockets.push(await relay(s,id(),id(),b));
  } finally {for(const socket of sockets)socket.terminate();await s.close();}
});

test('24 paused downloads stay within a 48 MiB RSS growth bound and release capacity at the send deadline',async t=>{
  const {get}=await import('node:http');
  for(const [http_concurrency,response_bytes,maximum] of [[2,32*1024*1024,2],[16,8*1024*1024,1]]) {
    const s=await service({http_concurrency,response_bytes,namespace_downloads:16,send_seconds:3}),requests=[];
    const bytes=randomBytes(8*1024*1024);
    const rss=async()=>Number((await readFile(`/proc/${s.pid}/status`,'utf8')).match(/^VmRSS:\s+(\d+)/m)[1])*1024;
    try {
      assert.equal((await fetch(s.object(bytes),{method:'PUT',headers:s.headers,body:bytes})).status,201);
      const before=await rss();let peak=before;const statuses=[];
      for(let n=0;n<24;n++) {
        const response=await new Promise((resolve,reject)=>{
          const request=get(s.object(bytes),{headers:s.headers,agent:false},resolve);requests.push(request);request.on('error',reject);
        });
        response.on('error',()=>{});response.pause();statuses.push(response.statusCode);
        if(response.statusCode!==200)response.resume();
        peak=Math.max(peak,await rss());
      }
      const successful=statuses.filter(s=>s===200).length;
      assert.equal(successful,maximum);assert(statuses.every(s=>s===200||s===503));
      assert(peak-before<48*1024*1024,`RSS grew ${(peak-before)/1024/1024} MiB`);
      assert.equal((await fetch(s.url+'/health',{signal:AbortSignal.timeout(1000)})).status,200);
      await delay(3300);
      // Leave clients paused: only the server's absolute send deadline can free these slots.
      await responsive(s,bytes);
      t.diagnostic(JSON.stringify({http_concurrency,response_bytes,successful,before,peak,growth:peak-before}));
    } finally {for(const request of requests)request.destroy();await s.close();}
  }
});

async function sourceRequest(s,path,{source='127.0.0.2',headers={},count=1}={}) {
  const {connect}=await import('node:net'),url=new URL(s.url);
  const socket=connect({port:Number(url.port),host:'127.0.0.1',localAddress:source});
  socket.on('error',()=>{});
  try {
    await once(socket,'connect');
    const response=new Promise((resolve,reject)=>{
      let bytes='';const timer=setTimeout(()=>reject(Error('Source request deadline')),2000);
      socket.on('data',chunk=>{
        bytes+=chunk.toString('latin1');
        const statuses=[...bytes.matchAll(/HTTP\/1.1 (\d+)/g)].map(m=>Number(m[1]));
        if(statuses.length>=count){clearTimeout(timer);resolve(statuses);}
      });
      socket.once('error',error=>{clearTimeout(timer);reject(error);});
    });
    socket.write(Array.from({length:count},()=>`GET ${path} HTTP/1.1\r\nHost: localhost\r\n${Object.entries(headers).map(([k,v])=>`${k}: ${v}\r\n`).join('')}\r\n`).join(''));
    return await response;
  } finally {socket.destroy();}
}

test('105 pipelined unauthenticated requests preserve health and another tenant download',async()=>{
  const s=await service(),bytes=randomBytes(32),path=new URL(s.object(bytes)).pathname;
  try {
    assert.equal((await fetch(s.object(bytes),{method:'PUT',headers:s.headers,body:bytes})).status,201);
    const statuses=await sourceRequest(s,path,{count:105,headers:{'X-Forwarded-For':'192.0.2.1'}});
    assert(statuses.includes(401));assert(statuses.includes(429));
    assert.deepEqual(await sourceRequest(s,'/health'),[200]);
    // Same NAT retains authenticated capacity after the anonymous budget is spent.
    assert.deepEqual(await sourceRequest(s,path,{headers:s.headers}),[200]);
    assert.deepEqual(await sourceRequest(s,path,{source:'127.0.0.3',headers:s.headers}),[200]);
    // Spoofed forwarded headers cannot rotate the anonymous source budget.
    assert.deepEqual(await sourceRequest(s,path,{headers:{'X-Forwarded-For':'192.0.2.2'}}),[429]);
  } finally {await s.close();}
});

test('namespace rates are shared by aliases and isolated from other namespaces and health',async()=>{
  const a=id(),alias=id(),b=id(),na=id(),nb=id(),bytes=randomBytes(32);
  const s=await service({requests_per_second:8,principals:[
    {token_hash:hash(a),namespace:na,storage:true,relay:true},
    {token_hash:hash(alias),namespace:na,storage:true,relay:true},
    {token_hash:hash(b),namespace:nb,storage:true,relay:true},
  ]});
  const path=new URL(s.object(bytes,na)).pathname;
  try {
    const statuses=await sourceRequest(s,path,{count:9,headers:{Authorization:`Bearer ${a}`}});
    assert.equal(statuses.filter(x=>x===404).length,8);assert.equal(statuses.at(-1),429);
    assert.deepEqual(await sourceRequest(s,path,{source:'127.0.0.3',headers:{Authorization:`Bearer ${alias}`}}),[429]);
    assert.deepEqual(await sourceRequest(s,new URL(s.object(bytes,nb)).pathname,{headers:{Authorization:`Bearer ${b}`}}),[404]);
    assert.deepEqual(await sourceRequest(s,'/health'),[200]);
  } finally {await s.close();}
});

test('pre-auth source admission and its table are bounded without consuming health capacity',async()=>{
  const s=await service({source_requests_per_second:2,rate_sources:1});
  try {
    assert.deepEqual(await sourceRequest(s,'/v1',{count:3}),[200,200,429]);
    assert.deepEqual(await sourceRequest(s,'/v1',{source:'127.0.0.3'}),[429]);
    assert.deepEqual(await sourceRequest(s,'/health',{source:'127.0.0.3'}),[200]);
    await delay(1050);
    assert.deepEqual(await sourceRequest(s,'/v1',{source:'127.0.0.3'}),[200]);
  } finally {await s.close();}
});

test('only explicit trusted proxies can supply one replacement source address',async()=>{
  const s=await service({requests_per_second:2,trusted_proxies:['127.0.0.2']});
  const path=new URL(s.object(randomBytes(32))).pathname;
  try {
    assert.deepEqual(await sourceRequest(s,path,{count:3,headers:{'X-Forwarded-For':'192.0.2.1'}}),[401,401,429]);
    assert.deepEqual(await sourceRequest(s,path,{headers:{'X-Forwarded-For':'192.0.2.2'}}),[401]);
    for(const forwarded of [undefined,'bad','192.0.2.1, 192.0.2.2']) {
      assert.deepEqual(await sourceRequest(s,path,{headers:forwarded?{'X-Forwarded-For':forwarded}:{}}),[400]);
    }
    // An untrusted peer still cannot use a rotating forwarded header.
    assert.deepEqual(await sourceRequest(s,path,{source:'127.0.0.3',count:3,headers:{'X-Forwarded-For':'192.0.2.3'}}),[401,401,429]);
    assert.deepEqual(await sourceRequest(s,path,{source:'127.0.0.3',headers:{'X-Forwarded-For':'192.0.2.4'}}),[429]);
  } finally {await s.close();}
});
