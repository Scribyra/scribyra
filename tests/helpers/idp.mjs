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

/** The provider role names the test deployments map (a generic `$.roles` claims mapping). */
export const ROLES={admin:'scribyra:admin',member:'scribyra:member',guest:'scribyra:guest'};
/** Verified members `<name>@acme.test` with password `pw-<name>` (provider role `scribyra:member`). */
export const people=names=>names.map(n=>({sub:`sub-${n}`,username:n,password:`pw-${n}`,email:`${n}@acme.test`,email_verified:true,name:n[0].toUpperCase()+n.slice(1),roles:[ROLES.member]}));

export async function idp({publicUrl,users,shortcuts=false}){
 await mkdir(resolve('tmp'),{recursive:true});
 const dir=await mkdtemp(resolve('tmp/idp-')),port=await freePort(),issuer=`http://127.0.0.1:${port}`,secret=randomBytes(16).toString('hex');
 const config={bind:`127.0.0.1:${port}`,issuer,alg:'RS256',test_shortcuts:shortcuts,clients:[{client_id:CLIENT_ID,client_secret:secret,redirect_uris:[`${publicUrl}/v1/sso/callback/acme`],backchannel_logout_uri:`${publicUrl}/v1/sso/backchannel`}],users};
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
  /** Changes a user's fields (roles, provider shapes, claims) from the next token on. */
  async set(user,fields){const r=await fetch(`${issuer}/control/set?user=${encodeURIComponent(user)}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(fields)});if(!r.ok)throw Error(`set ${user}: ${r.status}`);},
  async close(){child.kill('SIGTERM');await rm(dir,{recursive:true,force:true});}};
}

/**
 * A service whose end-to-end deployment "Acme Lab" signs in with its own test provider (id
 * `acme`, label "Acme account", one organisation, roles from the token's `roles` claim); the
 * provider gives the users named in `admins` (ana by default) the administrator role. `provider`
 * adds to the provider, `deployment` to the deployment object, the rest to the service
 * configuration. `close()` stops both.
 */
export async function orgService({users=people(['ana','ben','cat','dan','eve','fay']),admins=['ana'],shortcuts=true,deployment={},provider:rules={},...overrides}={}){
 const port=await freePort(),publicUrl=`http://127.0.0.1:${port}`;
 users=users.map(u=>admins.includes(u.username)?{...u,roles:[...new Set([ROLES.admin,...(u.roles||[])])]}:u);
 const provider=await idp({publicUrl,users,shortcuts});
 let s;
 try{
  s=await service({bind:`127.0.0.1:${port}`,public_url:publicUrl,...overrides,
   deployment:{name:'Acme Lab',encryption:'e2ee',providers:[{id:'acme',label:'Acme account',issuer:provider.issuer,client_id:CLIENT_ID,client_secret_file:provider.secretFile,claims:{roles:'$.roles'},roles:{admin:[ROLES.admin],member:[ROLES.member],guest:[ROLES.guest]},...rules}],...deployment}});
 }catch(error){await provider.close();throw error;}
 const close=s.close;
 return Object.assign(s,{provider,async close(){await close();await provider.close();}});
}

/**
 * A service whose server-readable deployment "Acme Lab" stores projects the server can read (a
 * fresh master key is made for it), signing in with its own test provider as in `orgService`.
 * Snapshots come after 50 entries and the floor follows at once, so compaction shows in tests;
 * `deployment` and the other options are as for `orgService` (for example `{offline:false}`).
 */
export function serverService({deployment={},...options}={}){
 return orgService({sr_snapshot_entries:50,sr_retention_seconds:0,sr_maintenance_seconds:1,...options,deployment:{encryption:'server',...deployment}});
}

/** Two Zitadel organisations of one instance (project `42`): Acme, and a partner that grants roles to Acme's people. */
export const ZITADEL={project:'42',acme:{id:'100',name:'acme.zitadel.test'},partner:{id:'200',name:'partner.zitadel.test'}};
/**
 * A user whose ID tokens are Zitadel-shaped: `home` is their organisation (`acme` or `partner`),
 * `grants` maps provider role names to the organisations granting them, for example
 * `{[ROLES.member]:['acme','partner']}` (a grant by another organisation than home makes a guest).
 */
export function zitadelUser(name,home,grants){
 const roles=Object.fromEntries(Object.entries(grants).map(([role,orgs])=>[role,Object.fromEntries(orgs.map(o=>[ZITADEL[o].id,ZITADEL[o].name]))]));
 return{sub:`sub-${name}`,username:name,password:`pw-${name}`,email:`${name}@acme.test`,email_verified:true,name:name[0].toUpperCase()+name.slice(1),zitadel:{resourceowner:ZITADEL[home].id,project_id:ZITADEL.project,roles}};
}
/**
 * A server-readable deployment whose provider "Acme account" is a Zitadel instance (preset
 * `zitadel`, project owned by Acme, each organisation keying a role its own Scribyra organisation:
 * `zitadel_foreign_organisations: "organisations"`): organisations and roles come from the tokens, guests are admitted (`guests:
 * "shared"`), and logins are rechecked every second once due (`recheck_minutes` 1; tests make a
 * login due at once with `due()`). `users` are `zitadelUser`s.
 */
export async function identityService({users,deployment={},provider={},...options}){
 const s=await serverService({users,admins:[],sso_recheck_tick_seconds:1,...options,deployment:{guests:'shared',...deployment},
  provider:{claims:null,preset:'zitadel',zitadel_project_id:ZITADEL.project,zitadel_project_owner_org:ZITADEL.acme.id,zitadel_foreign_organisations:'organisations',offline_access:true,recheck_minutes:1,...provider}});
 return Object.assign(s,{due:()=>s.sql("UPDATE sso_logins SET checked = now() - interval '1 day' WHERE NOT revoked")});
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

/**
 * A server-readable deployment that compiles on the server (design section 6): `compile` (default
 * `both`), TeX Live from the dev shell (`SCRIBYRA_TEXLIVE`; bwrap and the store closure come from
 * `SCRIBYRA_BWRAP` and `SCRIBYRA_TEXLIVE_CLOSURE`, the cgroup from a systemd user scope) and one
 * worker inside `serve`. Limits are generous for a loaded host; `limits` overrides some.
 */
export function compileService({compile='both',limits={},deployment={},...options}={}){
 const texlive=process.env.SCRIBYRA_TEXLIVE;
 if(!texlive)throw Error('SCRIBYRA_TEXLIVE is not set: run under `nix develop`.');
 return serverService({compile_worker_in_process:true,compile_heartbeat_seconds:2,compile_heartbeat_timeout_seconds:60,...options,
  deployment:{compile,texlive,compile_limits:{cpu_seconds:300,wall_seconds:600,memory_mib:2048,scratch_mib:512,output_mib:64,passes:4,concurrency:2,queue:32,per_member_per_hour:120,...limits},...deployment}});
}
