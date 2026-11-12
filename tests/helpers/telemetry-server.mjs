import {spawn} from 'node:child_process';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {existsSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {randomBytes} from 'node:crypto';
import {createServer} from 'node:net';
const pin=JSON.parse(readFileSync(new URL('../../ops/telemetry/tools.lock.json',import.meta.url),'utf8')).alloy;
export const alloyExecutable=process.env.SCRIBYRA_TEST_ALLOY||resolve(`.cache/telemetry-tools/alloy-${pin.version}`);
export const ingestionAvailable=()=>existsSync(alloyExecutable)&&existsSync(resolve('target/debug/scribyra-telemetry'))&&existsSync(resolve('target/debug/examples/otlp-test-sink'));
async function port(){const server=createServer();await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});const value=server.address().port;await new Promise(resolve=>server.close(resolve));return value;}
function run(executable,args=[],env={}){let log='';const child=spawn(executable,args,{env:{...process.env,...env},stdio:['ignore','pipe','pipe']});child.stderr.on('data',bytes=>{log=(log+bytes.toString().replace(/[a-f0-9]{64}/g,'[redacted]')).slice(-8192);});return{child,get log(){return log;}};}
async function ready(process){return new Promise((resolve,reject)=>{let output='';const timer=setTimeout(()=>reject(Error('Telemetry process did not start: '+process.log)),15000);process.child.once('error',error=>{clearTimeout(timer);reject(error);});process.child.once('exit',code=>{clearTimeout(timer);reject(Error(`Telemetry process exited ${code}: ${process.log}`));});process.child.stdout.on('data',bytes=>{output+=bytes.toString();for(const line of output.split('\n')){try{const row=JSON.parse(line);if(row.event==='ready'){clearTimeout(timer);resolve(row);}}catch{}}});});}
async function stop(process){if(!process||process.child.exitCode!==null||process.child.signalCode!==null)return;const stopped=new Promise(resolve=>process.child.once('exit',resolve));process.child.kill('SIGTERM');let timer;await Promise.race([stopped,new Promise(resolve=>{timer=setTimeout(()=>{process.child.kill('SIGKILL');resolve();},3000);})]).finally(()=>clearTimeout(timer));}
export async function telemetryServer(origin=`http://127.0.0.1:${process.env.SCRIBYRA_TEST_PORT||4173}`){
 if(!existsSync(alloyExecutable))throw new Error('Pinned Alloy test executable is unavailable: '+alloyExecutable);
 const directory=await mkdtemp(join(tmpdir(),'scribyra-ingress-')),token=randomBytes(32).toString('hex'),tokenFile=join(directory,'ingress.token'),children=[];await writeFile(tokenFile,token,{mode:0o600});
 const close=async()=>{for(const child of [...children].reverse())await stop(child);await rm(directory,{recursive:true,force:true});};
 try{
  const sink=run(resolve('target/debug/examples/otlp-test-sink'));children.push(sink);const destination=await ready(sink);
  const otlp=await port(),http=await port();const alloy=run(alloyExecutable,['run','--disable-reporting','--stability.level=experimental',`--server.http.listen-addr=127.0.0.1:${http}`,`--storage.path=${join(directory,'alloy')}`,resolve('ops/telemetry/forward.alloy')],{SCRIBYRA_OTLP_LISTEN:`127.0.0.1:${otlp}`,SCRIBYRA_OTLP_FORWARD:destination.url});children.push(alloy);
  let healthy=false;for(let i=0;i<150;i++){if(alloy.child.exitCode!==null)throw Error('Alloy exited: '+alloy.log);try{healthy=(await fetch(`http://127.0.0.1:${http}/-/ready`)).ok;}catch{}if(healthy)break;await new Promise(resolve=>setTimeout(resolve,50));}if(!healthy)throw Error('Alloy did not become ready');
  const gateway=run(resolve('target/debug/scribyra-telemetry'),[],{SCRIBYRA_INGRESS_TOKEN_FILE:tokenFile,SCRIBYRA_TELEMETRY_BIND:'127.0.0.1:0',SCRIBYRA_ALLOY_URL:`http://127.0.0.1:${otlp}`,SCRIBYRA_ALLOWED_ORIGINS:origin});children.push(gateway);const ingress=await ready(gateway);
  return{url:ingress.url+'/v1/events',token,tokenFile,captures:async()=>(await fetch(destination.url+'/captures')).json(),metrics:async()=>(await fetch(ingress.url+'/metrics')).text(),close};
 }catch(error){await close();throw error;}
}
