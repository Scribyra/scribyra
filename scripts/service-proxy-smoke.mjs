import assert from 'node:assert/strict';
import { spawn,execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { readFile,writeFile,mkdir } from 'node:fs/promises';
import { createServer,connect as tcpConnect } from 'node:net';
import { connect as tlsConnect } from 'node:tls';
import { request,Agent } from 'node:https';
import { join,resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import WebSocket from 'ws';
import { service,id } from '../tests/helpers/service.mjs';

const s=await service({trusted_proxies:['127.0.0.1']},resolve('target/release/scribyra-sync'));let proxy,admission;const sockets=[];
let checks=0,stage='startup';
try {
  const probe=createServer();await new Promise(resolve=>probe.listen(0,'127.0.0.1',resolve));
  const port=probe.address().port;await new Promise(resolve=>probe.close(resolve));
  const internal=createServer();await new Promise(resolve=>internal.listen(0,'127.0.0.1',resolve));
  const tlsPort=internal.address().port;await new Promise(resolve=>internal.close(resolve));
  const prefix=join(s.directory,'proxy');await mkdir(prefix);
  execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-days','1','-subj','/CN=localhost',
    '-addext','subjectAltName=DNS:localhost,IP:127.0.0.1','-keyout',join(prefix,'tls.key'),'-out',join(prefix,'tls.crt')],{stdio:'ignore'});
  const config=(await readFile('deploy/service-nginx.conf','utf8'))
    .replace('127.0.0.1:9443',`127.0.0.1:${tlsPort}`).replaceAll('http://127.0.0.1:8787',s.url);
  await writeFile(join(prefix,'nginx.conf'),config);
  execFileSync('nginx',['-t','-p',prefix+'/','-c','nginx.conf'],{stdio:'pipe'});checks++;
  proxy=spawn('nginx',['-p',prefix+'/','-c','nginx.conf','-g','daemon off;'],{stdio:['ignore','ignore','pipe']});
  const guard=(await readFile('deploy/service-admission.cfg','utf8'))
    .replace('127.0.0.1:8443',`127.0.0.1:${port}`).replace('127.0.0.1:9443',`127.0.0.1:${tlsPort}`);
  await writeFile(join(prefix,'admission.cfg'),guard);
  execFileSync('haproxy',['-c','-f',join(prefix,'admission.cfg')],{stdio:'pipe'});checks++;
  admission=spawn('haproxy',['-db','-f',join(prefix,'admission.cfg')],{stdio:['ignore','ignore','pipe']});
  let errors='';admission.stderr.on('data',bytes=>{errors+=bytes;});proxy.stderr.on('data',bytes=>{errors+=bytes;});
  const ca=await readFile(join(prefix,'tls.crt')),base=`https://127.0.0.1:${port}`;
  function call(path,{method='GET',headers={},body,unfinished=false,source='127.0.0.1',agent=false}={}) {
    return new Promise((resolve,reject)=>{
      const req=request(base+path,{method,headers,ca,localAddress:source,agent,timeout:2000},response=>{
        const chunks=[];response.on('data',bytes=>chunks.push(bytes));
        response.on('end',()=>{resolve({status:response.statusCode,bytes:Buffer.concat(chunks)});if(unfinished)req.destroy();});
      });
      req.on('error',reject);req.on('timeout',()=>req.destroy(Error('HTTPS response deadline')));
      if(unfinished)req.write(body);else req.end(body);
    });
  }
  for(let n=0;;n++) {
    try {assert.equal((await call('/ready')).status,200);break;}
    catch(error){if(n>=50||proxy.exitCode!==null)throw Error(`${error.message}: ${errors}`);await new Promise(r=>setTimeout(r,50));}
  }
  checks++;
  assert.equal((await call('/health',{headers:{'X-Forwarded-For':'forged, chain'}})).status,200);checks++;
  const bytes=randomBytes(32),path=new URL(s.object(bytes)).pathname;
  assert.equal((await call(path,{method:'PUT',headers:s.headers,body:bytes})).status,201);checks++;
  assert.deepEqual((await call(path,{headers:s.headers})).bytes,bytes);checks++;
  assert.equal((await call(path,{method:'PUT',headers:{'Content-Length':16},body:'x',unfinished:true})).status,401);checks++;
  assert.equal((await call(path,{method:'PUT',headers:{...s.headers,'Content-Length':8388609},body:'x',unfinished:true})).status,413);checks++;
  assert.equal((await call('/health',{headers:{Origin:'https://forbidden.invalid'}})).status,403);checks++;
  assert.equal((await call('/health',{headers:{'X-Oversized':'x'.repeat(9000)}})).status,400);checks++;
  stage='relay';
  const room=id();
  for(let n=0;n<2;n++) {
    const socket=new WebSocket(base.replace('https:','wss:')+'/v1/connect',{ca,origin:s.config.origins[0]});
    sockets.push(socket);socket.on('error',()=>{});await once(socket,'open');
    const ready=once(socket,'message');socket.send(JSON.stringify({version:1,bearer:s.bearer,room,connection:id()}));
    assert.equal(JSON.parse((await ready)[0]).ready,true);
  }
  const message=once(sockets[1],'message');sockets[0].send(bytes);assert.deepEqual((await message)[0],bytes);checks++;
  stage='connection ceiling';
  for(let n=0;n<14;n++) {
    const socket=new WebSocket(base.replace('https:','wss:')+'/v1/connect',{ca});
    sockets.push(socket);socket.on('error',()=>{});await once(socket,'open');
  }
  await assert.rejects(call('/health'));checks++;
  assert.equal((await call('/health',{source:'127.0.0.3'})).status,200);checks++;
  for(const socket of sockets.splice(0))socket.terminate();
  await new Promise(r=>setTimeout(r,1200));
  stage='timeouts';
  await Promise.all([false,true].map(async tls=>{
    const socket=tls?tlsConnect({host:'127.0.0.1',port,ca}):tcpConnect(port,'127.0.0.1');
    sockets.push(socket);socket.on('error',()=>{});
    await once(socket,tls?'secureConnect':'connect');
    const started=Date.now(),done=new Promise(resolve=>socket.once('close',resolve));socket.resume();
    if(tls)socket.write('GET /health HTTP/1.1\r\nHost:');
    const timer=setTimeout(()=>socket.destroy(Error('Proxy handshake/header deadline exceeded')),8000);
    try {await done;assert(Date.now()-started>=4000);assert(Date.now()-started<7500);checks++;}
    finally {clearTimeout(timer);}
  }));
  stage='request rate';
  const agent=new Agent({keepAlive:true,maxSockets:1});
  try {
    const rates=await Promise.all(Array.from({length:48},()=>call('/v1',{agent}).then(r=>r.status)));
    assert(rates.includes(429));assert(rates.includes(200));checks++;
    assert.equal((await call('/health',{agent})).status,200);checks++;
  } finally {agent.destroy();}
  stage='partial TLS attack';
  const attack=[];let attempted=0,active=0,peak=0,rejected=0;
  function replenish() {
    while(attempted<10000&&active<256) {
      attempted++;active++;
      const socket=tcpConnect({host:'127.0.0.1',port,localAddress:'127.0.0.2'});
      attack.push(socket);socket.on('error',()=>{});
      socket.once('connect',()=>socket.write(Buffer.from([0x16,0x03,0x01,0x02,0x00,0x01])));
      const started=Date.now();socket.once('close',()=>{active--;if(Date.now()-started<2000)rejected++;});
    }
  }
  const started=Date.now();let availability=0;
  const pump=setInterval(replenish,250);replenish();
  try {
    while(Date.now()-started<8000) {
      await new Promise(r=>setTimeout(r,250));
      peak=Math.max(peak,attack.filter(socket=>!socket.destroyed).length);
      assert.equal((await call('/health',{source:'127.0.0.3'})).status,200);
      const result=await call(path,{headers:s.headers,source:'127.0.0.3'});
      assert.equal(result.status,200);assert.deepEqual(result.bytes,bytes);availability++;
    }
    assert(attempted>=512);assert(rejected>=240);assert(availability>=10);checks++;
    console.log(JSON.stringify({probe:'replenished partial TLS',attempted,rejected,peak,availability}));
  } finally {clearInterval(pump);for(const socket of attack)socket.destroy();}
  // Connection-rate admission also rejects rapid churn with no concurrent handshakes.
  stage='connection churn';
  let churnRejected=0;
  for(let n=0;n<48;n++) {
    const socket=tlsConnect({host:'127.0.0.1',port,ca,localAddress:'127.0.0.4'});
    socket.on('error',()=>{});
    try {await once(socket,'secureConnect');}
    catch {churnRejected++;}
    finally {socket.destroy();}
  }
  assert(churnRejected>0);checks++;
  assert.equal((await call('/health',{source:'127.0.0.3'})).status,200);checks++;
  // Auth reaches the service without waiting for the proxy to buffer an unfinished upload.
  // TLS is verified against the generated CA above; verification is never disabled.
  console.log(JSON.stringify({checks,passed:checks,tls:'verified self-signed',http:true,websocket:true}));
} catch(error) {throw Error(`Proxy stage ${stage}: ${error.message}`,{cause:error});}
finally {
  for(const socket of sockets){if(socket.terminate)socket.terminate();else socket.destroy();}
  if(admission&&admission.exitCode===null){const done=once(admission,'exit');admission.kill('SIGTERM');await done;}
  if(proxy&&proxy.exitCode===null){const done=once(proxy,'exit');proxy.kill('SIGTERM');await done;}
  await s.close();
}
