// Documentation acceptance: fresh local install against PostgreSQL with filesystem blobs,
// exchange, online backup (pg_dump, then the blob directory), upgrade, restore into a fresh
// database and directory, and a full verify.
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { once } from 'node:events';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, copyFile, cp, writeFile, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { randomBytes, createHash, createCipheriv } from 'node:crypto';
import WebSocket from 'ws';
import { database } from '../tests/helpers/service.mjs';
const run=promisify(execFile);
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
async function verify(directory){
  const process_=spawn(join(directory,'scribyra-sync'),['verify'],{cwd:directory,env:{...process.env,SCRIBYRA_SERVICE_CONFIG:'service.json'},stdio:'ignore'});
  return (await once(process_,'exit'))[0];
}
async function install(directory,url){
  await mkdir(directory,{mode:0o700});await mkdir(join(directory,'data'),{mode:0o700});
  await copyFile(resolve('target/release/scribyra-sync'),join(directory,'scribyra-sync'));
  // The database URL is a secret: kept in its own mode-600 file, never in service.json or logs.
  await writeFile(join(directory,'database-url'),url+'\n',{mode:0o600});
}
const sockets=[];
try {
  const installed=join(root,'install'),restored=join(root,'restore'),backup=join(root,'backup');
  const firstDatabase=await database();
  await install(installed,firstDatabase);
  const bearer=id(),namespace=id(),config={bind:'127.0.0.1:0',data:'data',database_url_file:'database-url',origins:[],principals:[{token_hash:hash(bearer),namespace,storage:true,relay:true}]};
  await writeFile(join(installed,'service.json'),JSON.stringify(config),{mode:0o600});
  let url=await start(installed);
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
  for(const socket of sockets)socket.close();
  // Online backup: database first, then blobs. Objects written after the dump are harmless extras.
  await mkdir(backup,{mode:0o700});
  await run('pg_dump',['--format=custom','--file',join(backup,'database.dump'),firstDatabase]);
  const later=randomBytes(64);
  check((await fetch(`${url}/v1/objects/${namespace}/${hash(later)}`,{method:'PUT',headers,body:later})).status,201);
  await cp(join(installed,'data'),join(backup,'data'),{recursive:true});
  await stop();
  // Upgrade: stop, replace the binary, start; migrations apply automatically (none pending here).
  await copyFile(resolve('target/release/scribyra-sync'),join(installed,'scribyra-sync'));
  url=await start(installed);check((await fetch(url+'/ready')).status,200);
  check(Buffer.from(await (await fetch(url+object,{headers})).arrayBuffer()),bytes);await stop();
  check(await verify(installed),0);
  // Restore into a fresh, empty database and a fresh blob directory.
  const secondDatabase=await database();
  await install(restored,secondDatabase);
  await run('pg_restore',['--no-owner','--exit-on-error','--dbname',secondDatabase,join(backup,'database.dump')]);
  await rm(join(restored,'data'),{recursive:true});await cp(join(backup,'data'),join(restored,'data'),{recursive:true});
  await copyFile(join(installed,'service.json'),join(restored,'service.json'));
  check(await verify(restored),0);
  url=await start(restored);check((await fetch(url+'/ready')).status,200);
  check(Buffer.from(await (await fetch(url+object,{headers})).arrayBuffer()),bytes);
  check((await fetch(url+object,{method:'PUT',headers,body:bytes})).status,204);
  // The extra written after the dump is not in the restored metadata, so it is not served.
  check((await fetch(`${url}/v1/objects/${namespace}/${hash(later)}`,{headers})).status,404);
  console.log(JSON.stringify({environment:'fresh directory and database',checks,passed:checks,failed:0,backup:'pg_dump then blob copy, online',upgrade:'same release, migrations current',restore:'fresh database and directory, verify clean'}));
} finally {for(const socket of sockets)socket.terminate();await stop();await rm(root,{recursive:true,force:true});}
