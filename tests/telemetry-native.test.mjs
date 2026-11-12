import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {execFileSync,spawn} from 'node:child_process';
import {createServer} from 'node:https';
import {createHash} from 'node:crypto';
const binary=resolve('target/debug/scribyra-folders');
const available=existsSync(binary);
async function fixture(){
 const directory=await mkdtemp(join(tmpdir(),'scribyra-native-tls-'));
 try{
  const key=join(directory,'server.key'),cert=join(directory,'ca.pem'),serverCert=join(directory,'server.pem'),tokenFile=join(directory,'ingest.token'),root=join(directory,'PRIVATE_ROOT');
  const openssl=(...args)=>execFileSync(process.env.SCRIBYRA_TEST_OPENSSL||'openssl',args,{stdio:'ignore'});
  openssl('req','-x509','-newkey','rsa:2048','-noenc','-keyout',join(directory,'ca.key'),'-out',cert,'-days','1','-subj','/CN=Scribyra test CA','-addext','basicConstraints=critical,CA:TRUE');
  openssl('req','-new','-newkey','rsa:2048','-noenc','-keyout',key,'-out',join(directory,'server.csr'),'-subj','/CN=localhost');
  await writeFile(join(directory,'leaf.ext'),'subjectAltName=DNS:localhost,IP:127.0.0.1\nbasicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\n');
  openssl('x509','-req','-in',join(directory,'server.csr'),'-CA',cert,'-CAkey',join(directory,'ca.key'),'-CAcreateserial','-out',serverCert,'-days','1','-extfile',join(directory,'leaf.ext'));
  const token='a'.repeat(64);await writeFile(tokenFile,token,{mode:0o600});
  const {mkdir}=await import('node:fs/promises');await mkdir(root);await writeFile(join(root,'PRIVATE_FILE.tex'),'PRIVATE_NATIVE_DOCUMENT');
  const bodies=[];let invalidAuth=false;
  const server=createServer({key:await readFile(key),cert:await readFile(serverCert)},async(request,response)=>{
   invalidAuth ||= request.headers.authorization!=='Bearer '+token;
   let bytes=0;const chunks=[];for await(const chunk of request){bytes+=chunk.length;if(bytes>65536){response.writeHead(413).end();return;}chunks.push(chunk);}
   bodies.push(Buffer.concat(chunks).toString());response.writeHead(202,{'Content-Type':'application/json'}).end('{"result":"accepted"}');
  });server.on('tlsClientError',()=>{});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  return{directory,root,cert,token,tokenFile,bodies,get invalidAuth(){return invalidAuth;},endpoint:`https://127.0.0.1:${server.address().port}/v1/events`,async close(){await new Promise(resolve=>server.close(resolve));await rm(directory,{recursive:true,force:true});}};
 }catch(error){await rm(directory,{recursive:true,force:true});throw error;}
}
async function inspect(fixture,env){
 const child=spawn(binary,['inspect',fixture.root],{env:{...process.env,SCRIBYRA_DIAGNOSTICS_DIR:'',SCRIBYRA_TELEMETRY_SOURCE:process.env.SCRIBYRA_TELEMETRY_SOURCE||'local_test',SCRIBYRA_TELEMETRY_SAMPLE_PERCENT:'100',...env},stdio:['ignore','pipe','pipe']});let stdout='',stderr='';
 child.stdout.on('data',bytes=>{stdout=(stdout+bytes.toString()).slice(-262144);});child.stderr.on('data',bytes=>{stderr=(stderr+bytes.toString()).slice(-8192);});
 const code=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>{child.kill('SIGKILL');reject(Error('Native diagnostics exceeded process deadline'));},10000);child.once('error',error=>{clearTimeout(timer);reject(error);});child.once('exit',code=>{clearTimeout(timer);resolve(code);});});
 assert.equal(code,0);assert.ok(stdout.includes('PRIVATE_FILE.tex'),'Actual read-only CLI inspection completed');
 return stderr;
}
test('native CLI exports approved batches over verified HTTPS with a private ingest token',{skip:available?false:'Build scribyra-folders first'},async()=>{
 const f=await fixture();try{
  await inspect(f,{SCRIBYRA_DIAGNOSTICS:'1',SCRIBYRA_TELEMETRY_ENDPOINT:f.endpoint,SCRIBYRA_TELEMETRY_TOKEN_FILE:f.tokenFile,SSL_CERT_FILE:f.cert});
  assert.ok(f.bodies.length>0,'HTTPS receiver accepted actual native observations');assert.equal(f.invalidAuth,false);
  const batches=f.bodies.map(body=>JSON.parse(body));assert.ok(batches.every(batch=>batch.source===(process.env.SCRIBYRA_TELEMETRY_SOURCE||'local_test')));assert.ok(batches.some(batch=>batch.events.some(event=>event.runtime==='native'&&event.outcome==='success')));
  const encoded=f.bodies.join('');for(const forbidden of ['PRIVATE_NATIVE_DOCUMENT','PRIVATE_FILE.tex',f.root,f.directory,f.token,f.endpoint])assert.equal(encoded.includes(forbidden),false,'Private data excluded');
  assert.equal((await readFile(join(f.root,'PRIVATE_FILE.tex'),'utf8'))==='PRIVATE_NATIVE_DOCUMENT',true);
 }finally{await f.close();}
});
test('disabled export and untrusted TLS preserve the native CLI result',{skip:available?false:'Build scribyra-folders first'},async()=>{
 const f=await fixture();try{
  await inspect(f,{SCRIBYRA_DIAGNOSTICS:'0',SCRIBYRA_TELEMETRY_ENDPOINT:f.endpoint,SCRIBYRA_TELEMETRY_TOKEN_FILE:join(f.directory,'missing.token')});assert.equal(f.bodies.length,0);
  const error=await inspect(f,{SCRIBYRA_DIAGNOSTICS:'1',SCRIBYRA_TELEMETRY_ENDPOINT:f.endpoint,SCRIBYRA_TELEMETRY_TOKEN_FILE:f.tokenFile});
  assert.equal(f.bodies.length,0,'Untrusted TLS never delivers a telemetry body');assert.ok(error.includes('Diagnostic export is incomplete.'));assert.equal(error.includes(f.token)||error.includes(f.endpoint),false);
 }finally{await f.close();}
});
test('actual native sync HTTP outcomes export without room names or transferred contents',{skip:existsSync(resolve('target/debug/examples/plaintext-demo'))?false:'Build scribyra-sync first'},async()=>{
 const f=await fixture();let child;
 try{
  child=spawn(resolve('target/debug/examples/plaintext-demo'),[],{env:{...process.env,SCRIBYRA_CONTAINER:'0',SCRIBYRA_SYNC_PORT:'0',SCRIBYRA_SYNC_DB:join(f.directory,'sync.sqlite'),SCRIBYRA_DIAGNOSTICS:'1',SCRIBYRA_DIAGNOSTICS_DIR:'',SCRIBYRA_TELEMETRY_SOURCE:process.env.SCRIBYRA_TELEMETRY_SOURCE||'local_test',SCRIBYRA_TELEMETRY_ENDPOINT:f.endpoint,SCRIBYRA_TELEMETRY_TOKEN_FILE:f.tokenFile,SCRIBYRA_TELEMETRY_SAMPLE_PERCENT:'100',SSL_CERT_FILE:f.cert},stdio:['ignore','pipe','ignore']});
  const url=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Sync service readiness deadline')),10000);child.once('exit',()=>{clearTimeout(timer);reject(Error('Sync service exited before readiness'));});child.stdout.on('data',bytes=>{const match=bytes.toString().match(/listening on (127\.0\.0\.1:[0-9]+)/);if(match){clearTimeout(timer);resolve('http://'+match[1]);}});});
  const bytes=Buffer.from('PRIVATE_SYNC_CONTENT'),hash=createHash('sha256').update(bytes).digest('hex'),path=`${url}/rooms/PRIVATE_ROOM/blobs/${hash}`;
  assert.equal((await fetch(path)).status,404);assert.equal((await fetch(path,{method:'PUT',body:bytes})).status,201);assert.equal(Buffer.from(await(await fetch(path)).arrayBuffer()).equals(bytes),true);
  const deadline=Date.now()+5000;
  while(Date.now()<deadline&&!f.bodies.some(body=>JSON.parse(body).events.some(event=>event.runtime==='sync_service'&&event.operation==='sync_http'&&event.outcome==='success')))await new Promise(resolve=>setTimeout(resolve,50));
  assert.ok(f.bodies.some(body=>JSON.parse(body).events.some(event=>event.runtime==='sync_service'&&event.operation==='sync_http'&&event.outcome==='success')));
  const encoded=f.bodies.join('');for(const forbidden of ['PRIVATE_ROOM','PRIVATE_SYNC_CONTENT',hash,f.token,f.endpoint,f.directory])assert.equal(encoded.includes(forbidden),false,'Private sync data excluded');
 }finally{if(child&&child.exitCode===null){const stopped=new Promise(resolve=>child.once('exit',resolve));child.kill('SIGTERM');await stopped;}await f.close();}
});
