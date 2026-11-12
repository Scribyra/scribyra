import {spawn} from 'node:child_process';
import {randomBytes,createHash,createHmac} from 'node:crypto';
import {resolve} from 'node:path';
// The companion is discontinued; browser specs reach it only through its test-only switch.
export const enableCompanionDev=context=>context.addInitScript(()=>{try{localStorage.setItem('scribyra-companion-dev','1');}catch{}});
export const flags=p=>[p.read,p.write,p.compile,p.export].map(value=>value?'1':'0').join('');
export function pairProof(code,origin,projectId,nonce,permissions){return createHmac('sha256',createHash('sha256').update(code).digest('hex')).update(`scribyra-browser-pair-v1\n${origin}\n${projectId}\n${nonce}\n${flags(permissions)}`).digest('hex');}
export async function pairRequest(server,projectId,permissions,{origin=server.origin,nonce=randomBytes(32).toString('hex'),proof}={}){
 return fetch(server.url+'/pair',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify({nonce,proof:proof||pairProof(server.code,origin,projectId,nonce,permissions),projectId,permissions})});
}
export async function startCompanion({origin=`http://127.0.0.1:${process.env.SCRIBYRA_TEST_PORT||4173}`,appDirectory,providersPath,diagnosticsDirectory,telemetry,environment=process.env}={}){
 const code=randomBytes(32).toString('hex'),args=['--port','0','--origin',origin,...(appDirectory?['--app',appDirectory]:[]),...(providersPath?['--providers',providersPath]:[])];let log='',stdout='';
 const child=spawn(resolve('target/debug/scribyra-companion'),args,{env:{...environment,SCRIBYRA_PAIRING_CODE:code,...(diagnosticsDirectory?{SCRIBYRA_DIAGNOSTICS:'1',SCRIBYRA_DIAGNOSTICS_DIR:diagnosticsDirectory}:{}),...(telemetry?{SCRIBYRA_DIAGNOSTICS:'1',SCRIBYRA_TELEMETRY_SOURCE:environment.SCRIBYRA_TELEMETRY_SOURCE||'local_test',SCRIBYRA_TELEMETRY_ENDPOINT:telemetry.url,SCRIBYRA_TELEMETRY_TOKEN_FILE:telemetry.tokenFile}:{})},stdio:['ignore','pipe','pipe']});child.stderr.on('data',bytes=>{log=(log+bytes.toString().replace(/[a-f0-9]{64}/g,'[redacted]')).slice(-8192);});
 try{
  const ready=await new Promise((resolve,reject)=>{const timeout=setTimeout(()=>reject(new Error('Companion did not announce readiness: '+log)),15000);child.once('error',error=>{clearTimeout(timeout);reject(error);});child.once('exit',code=>{clearTimeout(timeout);reject(new Error(`Companion exited ${code}: ${log}`));});child.stdout.on('data',bytes=>{stdout+=bytes.toString();for(const line of stdout.split('\n')){try{const value=JSON.parse(line);if(value.event==='ready'){clearTimeout(timeout);resolve(value);}}catch{}}});});
  return{...ready,code,origin,child,async close(){if(child.exitCode===null){const stopped=new Promise(resolve=>child.once('exit',resolve));child.kill('SIGINT');let timer;await Promise.race([stopped,new Promise((resolve,reject)=>{timer=setTimeout(()=>{child.kill('SIGKILL');reject(new Error('Companion did not shut down gracefully'));},5000);})]).finally(()=>clearTimeout(timer));}}};
 }catch(error){if(child.exitCode===null)child.kill('SIGTERM');throw error;}
}
