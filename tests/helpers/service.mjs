import { spawn, execFile } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { randomBytes, createHash } from 'node:crypto';
export const id=()=>randomBytes(32).toString('hex');
export const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const run=promisify(execFile);
/** The app origin the tests' services allow (the Playwright preview server's). */
export const APP_ORIGIN=`http://127.0.0.1:${process.env.SCRIBYRA_TEST_PORT||4801}`;
const freePort=()=>new Promise((resolve,reject)=>{const server=createServer();server.once('error',reject);server.listen(0,'127.0.0.1',()=>{const {port}=server.address();server.close(()=>resolve(port));});});
// A watchdog stops the server by PID and removes its directory once this test process exits.
const WATCHDOG='owner=$1; dir=$2; shift 2; "$@" >"$dir/server.log" 2>&1 & child=$!; while kill -0 "$owner" 2>/dev/null && kill -0 "$child" 2>/dev/null; do sleep 0.2; done; kill -INT "$child" 2>/dev/null; wait "$child"; rm -rf "$dir"';
let cluster;
// One private PostgreSQL cluster per Node test process (trust auth, loopback TCP and a unix socket in its directory).
export function postgres() {
  cluster??=(async()=>{
    await mkdir(resolve('tmp'),{recursive:true});
    const dir=await mkdtemp(resolve('tmp/pg-')),data=join(dir,'data'),port=await freePort();
    try {await run('initdb',['-D',data,'-U','postgres','-A','trust','-E','UTF8','--locale=C','--no-sync','--no-instructions']);}
    catch(error){await rm(dir,{recursive:true,force:true});throw Error(`initdb failed (run inside nix develop, which provides postgresql_17): ${error.message}`);}
    spawn('sh',['-c',WATCHDOG,'sh',String(process.pid),dir,'postgres','-D',data,'-p',String(port),'-k',dir,'-c','listen_addresses=127.0.0.1','-c','fsync=off','-c','max_connections=300'],{stdio:'ignore',detached:true}).unref();
    for(let n=0;;n++){
      try {await run('pg_isready',['-q','-h','127.0.0.1','-p',String(port)]);break;}
      catch(error){if(n>300)throw Error('PostgreSQL did not start');await new Promise(r=>setTimeout(r,50));}
    }
    return {dir,data,port,url:name=>`postgres://postgres@127.0.0.1:${port}/${name}`};
  })();
  return cluster;
}
// A fresh, empty database in the shared cluster; resolves to its URL.
export async function database() {
  const pg=await postgres(),name=`s_${id().slice(0,24)}`;
  await run('createdb',['-h','127.0.0.1','-p',String(pg.port),'-U','postgres',name]);
  return pg.url(name);
}
export async function psql(url,sql) {return (await run('psql',['-X','-q','-A','-t','-v','ON_ERROR_STOP=1',url,'-c',sql])).stdout.trim();}
// Each call gets a fresh database in the shared cluster and a private filesystem blob directory.
// `org:true` binds a fixed free port and sets `public_url` to it, so organisation sign-in works.
export async function service({org=false,...overrides}={},binary=resolve('target/debug/scribyra-sync')) {
  const pg=await postgres();
  if(org){const port=await freePort();overrides={bind:`127.0.0.1:${port}`,public_url:`http://127.0.0.1:${port}`,...overrides};}
  await mkdir(resolve('tmp'),{recursive:true});
  const directory=await mkdtemp(resolve('tmp/service-')),bearer=id(),namespace=id(),database_url=await database();
  const config={bind:'127.0.0.1:0',data:join(directory,'data'),database_url,origins:[APP_ORIGIN],principals:[{token_hash:hash(bearer),namespace,storage:true,relay:true}],...overrides};
  const path=join(directory,'config.json');await writeFile(path,JSON.stringify(config));
  let child,url,logs='';
  async function start(extraEnv={}) {
    child=spawn(binary,[],{env:{...process.env,SCRIBYRA_SERVICE_CONFIG:path,...extraEnv},stdio:['ignore','pipe','pipe']});
    url=await new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>reject(Error('Service startup deadline')),10000);
      child.once('error',error=>{clearTimeout(timer);reject(error);});child.once('exit',code=>{clearTimeout(timer);reject(Error(`Service exited ${code}: ${logs}`));});
      child.stderr.on('data',b=>{logs+=b;});child.stdout.on('data',b=>{logs+=b;for(const line of b.toString().split('\n')){try{const v=JSON.parse(line);if(v.event==='listening'){clearTimeout(timer);resolve('http://'+v.address);}}catch{}}});
    });
  }
  async function stop(signal='SIGTERM') { if(child&&child.exitCode===null&&child.signalCode===null){const done=once(child,'exit');child.kill(signal);await done;} }
  // Run a subcommand (for example `verify`) to completion; resolves to its exit code.
  async function command(...args) {
    const process_=spawn(binary,args,{env:{...process.env,SCRIBYRA_SERVICE_CONFIG:path},stdio:['ignore','pipe','pipe']});
    process_.stdout.on('data',b=>{logs+=b;});process_.stderr.on('data',b=>{logs+=b;});
    return (await once(process_,'exit'))[0];
  }
  try { await start(); } catch(error) { await stop('SIGKILL');await rm(directory,{recursive:true,force:true});throw error; }
  return {directory,config,bearer,namespace,start,stop,command,postgres:pg,databaseDirectory:pg.data,database:config.database_url,get url(){return url;},get pid(){return child.pid;},get logs(){return logs;},
    sql(text){return psql(config.database_url,text);},
    // Filesystem location of an object's blob.
    blob(bytes,ns=namespace){return join(config.data,'objects',ns,hash(bytes));},
    async close(){await stop();await rm(directory,{recursive:true,force:true});},
    object(bytes,ns=namespace){return `${url}/v1/objects/${ns}/${hash(bytes)}`;},
    headers:{Authorization:`Bearer ${bearer}`,'Content-Type':'application/octet-stream'},
  };
}

