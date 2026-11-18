// The repository's OIDC test identity provider (crates/sync/examples/test-idp.rs) for Node and
// browser tests: a real login form and real redirects, on a free loopback port. `orgService`
// starts a provider and a service whose deployment signs in with it; `ssoLogin` and `signIn`
// sign in without a browser (through the provider's test shortcut).
import {spawn} from 'node:child_process';
import {mkdtemp,writeFile,rm,mkdir} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {randomBytes,createHash} from 'node:crypto';
import {createServer} from 'node:net';
import {service,APP_ORIGIN} from './service.mjs';
const freePort=()=>new Promise((resolve,reject)=>{const server=createServer();server.once('error',reject);server.listen(0,'127.0.0.1',()=>{const {port}=server.address();server.close(()=>resolve(port));});});
export const CLIENT_ID='scribyra-service';

/** Verified users `<name>@acme.test` with password `pw-<name>`. */
export const people=names=>names.map(n=>({sub:`sub-${n}`,username:n,password:`pw-${n}`,email:`${n}@acme.test`,email_verified:true,name:n[0].toUpperCase()+n.slice(1)}));

export async function idp({publicUrl,users,shortcuts=false}){
 await mkdir(resolve('tmp'),{recursive:true});
 const dir=await mkdtemp(resolve('tmp/idp-')),port=await freePort(),issuer=`http://127.0.0.1:${port}`,secret=randomBytes(16).toString('hex');
 const config={bind:`127.0.0.1:${port}`,issuer,alg:'RS256',test_shortcuts:shortcuts,clients:[{client_id:CLIENT_ID,client_secret:secret,redirect_uris:[`${publicUrl}/v1/sso/callback`],backchannel_logout_uri:`${publicUrl}/v1/sso/backchannel`}],users};
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

/**
 * A service whose end-to-end deployment "Acme Lab" signs in with its own test provider (id
 * `acme`, label "Acme account"); ana@acme.test is its administrator. `provider` adds to the
 * provider, `deployment` to the deployment object, the rest to the service configuration.
 * `close()` stops both.
 */
export async function orgService({users=people(['ana','ben','cat','dan','eve','fay']),admins=['ana@acme.test'],shortcuts=true,deployment={},provider:rules={},...overrides}={}){
 const port=await freePort(),publicUrl=`http://127.0.0.1:${port}`;
 const provider=await idp({publicUrl,users,shortcuts});
 let s;
 try{
  s=await service({bind:`127.0.0.1:${port}`,public_url:publicUrl,...overrides,
   deployment:{name:'Acme Lab',encryption:'e2ee',admins,providers:[{id:'acme',label:'Acme account',issuer:provider.issuer,client_id:CLIENT_ID,client_secret_file:provider.secretFile,...rules}],...deployment}});
 }catch(error){await provider.close();throw error;}
 const close=s.close;
 return Object.assign(s,{provider,async close(){await close();await provider.close();}});
}

/** Follows the provider (test shortcut) and the service's callback; returns the grant. */
async function authorize(url,user){
 const at=await fetch(`${url}&login_hint=${encodeURIComponent(user)}&test_password=pw-${encodeURIComponent(user)}`,{redirect:'manual'}),callback=at.headers.get('location');
 if(at.status!==302||!callback)throw Error(`the provider did not sign ${user} in (${at.status})`);
 const back=await fetch(callback,{redirect:'manual'}),fragment=new URLSearchParams((back.headers.get('location')||'').split('#')[1]||'');
 if(!fragment.get('scribyra-sso'))throw Object.assign(Error(`sign-in refused: ${fragment.get('scribyra-sso-error')||back.status}`),{code:fragment.get('scribyra-sso-error')});
 return fragment.get('scribyra-sso');
}
/** A login for `user` at the protocol level (no engine): {token, org, role, state, person, …}. */
export async function ssoLogin(s,user,provider='acme'){
 const verifier=randomBytes(32),challenge=createHash('sha256').update(verifier).digest('hex');
 const start=await fetch(`${s.url}/v1/sso/start`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({provider,return:APP_ORIGIN,challenge})});
 if(!start.ok)throw Error(`sign-in did not start: ${start.status} ${await start.text()}`);
 const grant=await authorize((await start.json()).url,user);
 const redeem=await fetch(`${s.url}/v1/sso/redeem`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({code:grant,verifier:verifier.toString('hex')})});
 if(!redeem.ok)throw Error(`redeem failed: ${redeem.status}`);
 return redeem.json();
}
/** Signs `user` in through the engine (as the dialog does: begin, provider, return, finish). */
export async function signIn(engine,s,user,provider='acme'){
 const url=await engine.ssoBegin({service:s.config.public_url,provider});
 return engine.ssoFinish(await authorize(url,user));
}
