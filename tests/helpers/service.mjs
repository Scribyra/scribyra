import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { randomBytes, createHash } from 'node:crypto';
export const id=()=>randomBytes(32).toString('hex');
export const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
export async function service(overrides={},binary=resolve('target/debug/scribyra-sync')) {
  await mkdir(resolve('tmp'),{recursive:true});
  const directory=await mkdtemp(resolve('tmp/service-')),bearer=id(),namespace=id();
  const config={bind:'127.0.0.1:0',data:join(directory,'data'),origins:[`http://127.0.0.1:${process.env.SCRIBYRA_TEST_PORT||4801}`],principals:[{token_hash:hash(bearer),namespace,storage:true,relay:true}],...overrides};
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
  try { await start(); } catch(error) { await stop('SIGKILL');await rm(directory,{recursive:true,force:true});throw error; }
  return {directory,config,bearer,namespace,start,stop,get url(){return url;},get pid(){return child.pid;},get logs(){return logs;},
    async close(){await stop();await rm(directory,{recursive:true,force:true});},
    object(bytes,ns=namespace){return `${url}/v1/objects/${ns}/${hash(bytes)}`;},
    headers:{Authorization:`Bearer ${bearer}`,'Content-Type':'application/octet-stream'},
  };
}
