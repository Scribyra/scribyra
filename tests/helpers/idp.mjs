// The repository's OIDC test identity provider (crates/sync/examples/test-idp.rs) for browser
// tests: a real login form and real redirects, on a free loopback port.
import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {randomBytes} from 'node:crypto';
import {createServer} from 'node:net';
const run=promisify(execFile);
const freePort=()=>new Promise((resolve,reject)=>{const server=createServer();server.once('error',reject);server.listen(0,'127.0.0.1',()=>{const {port}=server.address();server.close(()=>resolve(port));});});
export const CLIENT_ID='scribyra-service';

export async function idp({publicUrl,users}){
 const dir=await mkdtemp(resolve('tmp/idp-')),port=await freePort(),issuer=`http://127.0.0.1:${port}`,secret=randomBytes(16).toString('hex');
 const config={bind:`127.0.0.1:${port}`,issuer,alg:'RS256',test_shortcuts:false,clients:[{client_id:CLIENT_ID,client_secret:secret,redirect_uris:[`${publicUrl}/v1/sso/callback`]}],users};
 await writeFile(join(dir,'idp.json'),JSON.stringify(config));await writeFile(join(dir,'secret'),secret+'\n');
 const child=spawn(resolve('target/debug/examples/test-idp'),['--config',join(dir,'idp.json')],{stdio:['ignore','pipe','pipe']});
 let logs='';
 await new Promise((ok,fail)=>{
  const timer=setTimeout(()=>fail(Error('test-idp did not start: '+logs)),20000);
  child.stdout.on('data',b=>{logs+=b;if(logs.includes('"listening"')){clearTimeout(timer);ok();}});
  child.stderr.on('data',b=>{logs+=b;});child.once('exit',code=>{clearTimeout(timer);fail(Error(`test-idp exited ${code}: ${logs}`));});
 });
 return{issuer,secretFile:join(dir,'secret'),
  async control(path){const r=await fetch(`${issuer}/control/${path}`);if(!r.ok)throw Error(`control ${path}: ${r.status}`);},
  async close(){child.kill('SIGTERM');await rm(dir,{recursive:true,force:true});}};
}
/** `scribyra-sync org sso` for an org of a test service against a test IdP. */
export async function configureSso(s,org,provider,extra=[]){
 await run(resolve('target/debug/scribyra-sync'),['org','sso','--org',org,'--issuer',provider.issuer,'--client-id',CLIENT_ID,'--client-secret-file',provider.secretFile,...extra],{env:{...process.env,SCRIBYRA_SERVICE_CONFIG:join(s.directory,'config.json')}});
}
