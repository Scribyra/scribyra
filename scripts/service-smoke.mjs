// Documentation acceptance: fresh local install, exchange, stopped backup and restore.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, copyFile, cp, writeFile, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { randomBytes, createHash, createCipheriv } from 'node:crypto';
import WebSocket from 'ws';
const id=()=>randomBytes(32).toString('hex'),hash=b=>createHash('sha256').update(b).digest('hex');
await mkdir('tmp',{recursive:true});
const root=await mkdtemp(resolve('tmp/service-install-'));
let child,checks=0;
const check=(actual,expected)=>{assert.deepEqual(actual,expected);checks++;};
async function stop(){if(child&&child.exitCode===null&&child.signalCode===null){const exit=once(child,'exit');child.kill('SIGTERM');await exit;}}
async function start(directory){
  child=spawn(join(directory,'scribyra-sync'),[],{cwd:directory,env:{...process.env,SCRIBYRA_SERVICE_CONFIG:'service.json'},stdio:['ignore','pipe','pipe']});
  return await new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>reject(Error('startup timeout')),10000);
    child.once('error',reject);child.once('exit',code=>{clearTimeout(timer);reject(Error(`startup failed ${code}`));});
    child.stdout.on('data',b=>{for(const line of b.toString().split('\n')){try{const event=JSON.parse(line);if(event.event==='listening'){clearTimeout(timer);resolve('http://'+event.address);}}catch{}}});
  });
}
const sockets=[];
try {
  const install=join(root,'install'),restore=join(root,'restore'),backup=join(root,'backup');
  await mkdir(install,{mode:0o700});await mkdir(join(install,'data'),{mode:0o700});
  await copyFile(resolve('target/release/scribyra-sync'),join(install,'scribyra-sync'));
  const bearer=id(),namespace=id(),config={bind:'127.0.0.1:0',data:'data',origins:[],principals:[{token_hash:hash(bearer),namespace,storage:true,relay:true}]};
  await writeFile(join(install,'service.json'),JSON.stringify(config),{mode:0o600});
  let url=await start(install);
  check((await fetch(url+'/health')).status,200);check((await fetch(url+'/ready')).status,200);
  const cipher=createCipheriv('aes-256-gcm',randomBytes(32),randomBytes(12));
  const bytes=Buffer.concat([cipher.update('SYNTHETIC_DOCUMENT_FOR_INSTALL_DRILL'),cipher.final(),cipher.getAuthTag()]);
  const headers={Authorization:`Bearer ${bearer}`,'Content-Type':'application/octet-stream'},object=`/v1/objects/${namespace}/${hash(bytes)}`;
  check((await fetch(url+object,{method:'PUT',headers,body:bytes})).status,201);
  const room=id();
  for(let i=0;i<2;i++){
    const ws=new WebSocket(url.replace('http:','ws:')+'/v1/connect');sockets.push(ws);await once(ws,'open');
    const ready=once(ws,'message');ws.send(JSON.stringify({version:1,bearer,room,connection:id()}));await ready;
  }
  const received=once(sockets[1],'message');sockets[0].send(bytes);check((await received)[0],bytes);
  for(const socket of sockets)socket.close();await stop();
  await cp(join(install,'data'),backup,{recursive:true});
  // Reinstall the pinned release (the supported schema remains 1).
  await copyFile(resolve('target/release/scribyra-sync'),join(install,'scribyra-sync'));
  url=await start(install);check((await fetch(url+'/ready')).status,200);
  check(Buffer.from(await (await fetch(url+object,{headers})).arrayBuffer()),bytes);await stop();
  await mkdir(restore,{mode:0o700});await cp(backup,join(restore,'data'),{recursive:true});
  await copyFile(join(install,'service.json'),join(restore,'service.json'));await copyFile(join(install,'scribyra-sync'),join(restore,'scribyra-sync'));
  url=await start(restore);check((await fetch(url+'/ready')).status,200);
  check(Buffer.from(await (await fetch(url+object,{headers})).arrayBuffer()),bytes);
  check((await fetch(url+object,{method:'PUT',headers,body:bytes})).status,204);
  console.log(JSON.stringify({environment:'fresh directory',checks,passed:checks,failed:0,upgrade:'same release, schema 1',restore:'separate clean directory'}));
} finally {for(const socket of sockets)socket.terminate();await stop();await rm(root,{recursive:true,force:true});}
