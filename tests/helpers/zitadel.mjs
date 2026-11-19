// A real Zitadel for the opt-in end-to-end test (`SCRIBYRA_ZITADEL_E2E=1`,
// `scripts/zitadel-e2e.sh`): Zitadel from nixpkgs (`SCRIBYRA_ZITADEL` names its binary) with its
// own PostgreSQL cluster in a temporary directory, initialised non-interactively (`start-from-init`
// with a first instance whose machine user gets a personal access token), then set up through its
// management and admin APIs as an organisation would: a project with Scribyra's roles, a web
// application (code flow with PKCE and a client secret), people in the owner organisation and a
// partner organisation that the project is granted to. Everything stops and is removed when the
// test process exits (a watchdog, as for the tests' PostgreSQL).
import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdir,mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {randomBytes} from 'node:crypto';
import {createServer} from 'node:net';

const run=promisify(execFile);
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
export const freePort=()=>new Promise((ok,fail)=>{const server=createServer();server.once('error',fail);server.listen(0,'127.0.0.1',()=>{const {port}=server.address();server.close(()=>ok(port));});});
// Stops the child by PID and removes the directory once the test process exits (or the child ends).
// SCRIBYRA_ZITADEL_KEEP=1 keeps the directory (Zitadel's and PostgreSQL's logs) for a look afterwards.
const WATCHDOG='owner=$1; dir=$2; log=$3; shift 3; "$@" >"$log" 2>&1 & child=$!; while kill -0 "$owner" 2>/dev/null && kill -0 "$child" 2>/dev/null; do sleep 0.2; done; kill -INT "$child" 2>/dev/null; wait "$child"; [ "$SCRIBYRA_ZITADEL_KEEP" = 1 ] || { sleep 2; rm -rf "$dir"; }';
function watched(dir,log,command,args){spawn('sh',['-c',WATCHDOG,'sh',String(process.pid),dir,log,command,...args],{stdio:'ignore',detached:true}).unref();}

/** Provider role names the deployment maps. */
export const ROLES={admin:'scribyra:admin',member:'scribyra:member',guest:'scribyra:guest'};
/** Every test user's password (Zitadel's default complexity: upper, lower, digit, symbol). */
export const password=name=>`Pw-${name}-2026!`;

/**
 * Starts PostgreSQL and Zitadel and waits until Zitadel answers. Resolves to
 * `{issuer, api(method, path, body, org), close()}`; `api` acts as the first instance's machine
 * user (an instance owner), in organisation `org` when given (`x-zitadel-orgid`).
 */
export async function zitadel(){
 const binary=process.env.SCRIBYRA_ZITADEL||'zitadel';
 await mkdir(resolve('tmp'),{recursive:true});
 const dir=await mkdtemp(resolve('tmp/zitadel-')),pgPort=await freePort(),port=await freePort();
 const cleanup=async()=>{await rm(dir,{recursive:true,force:true}).catch(()=>{});};
 try{
  await run('initdb',['-D',join(dir,'pg'),'-U','postgres','-A','trust','-E','UTF8','--locale=C','--no-sync','--no-instructions']);
 }catch(error){await cleanup();throw Error(`initdb failed (run inside nix develop): ${error.message}`);}
 watched(dir,join(dir,'pg.log'),'postgres',['-D',join(dir,'pg'),'-p',String(pgPort),'-k',dir,'-c','listen_addresses=127.0.0.1','-c','fsync=off']);
 for(let n=0;;n++){try{await run('pg_isready',['-q','-h','127.0.0.1','-p',String(pgPort)]);break;}catch{if(n>600)throw Error('PostgreSQL for Zitadel did not start');await sleep(50);}}
 const pat=join(dir,'admin.pat');
 // Zitadel serves its issuer, login UI and APIs on one port; `localhost` is its instance's domain.
 await writeFile(join(dir,'config.yaml'),`Log:\n  Level: warn\nPort: ${port}\nExternalDomain: localhost\nExternalPort: ${port}\nExternalSecure: false\nTLS:\n  Enabled: false\nDatabase:\n  postgres:\n    Host: 127.0.0.1\n    Port: ${pgPort}\n    Database: zitadel\n    MaxOpenConns: 15\n    MaxIdleConns: 10\n    User:\n      Username: zitadel\n      SSL:\n        Mode: disable\n    Admin:\n      Username: postgres\n      SSL:\n        Mode: disable\n`);
 await writeFile(join(dir,'steps.yaml'),`FirstInstance:\n  PatPath: ${pat}\n  Org:\n    Name: Acme\n    Human:\n      UserName: root\n      Password: ${password('root')}\n      PasswordChangeRequired: false\n    Machine:\n      Machine:\n        Username: setup\n        Name: Setup\n      Pat:\n        ExpirationDate: 2099-01-01T00:00:00Z\n`);
 watched(dir,join(dir,'zitadel.log'),binary,['start-from-init','--masterkey',randomBytes(16).toString('hex'),'--tlsMode','disabled','--config',join(dir,'config.yaml'),'--steps',join(dir,'steps.yaml')]);
 const issuer=`http://localhost:${port}`;
 let token;
 for(const deadline=Date.now()+600000;;){
  // Ready once the machine user's token works on the management API (the HTTP gateway answers
  // before Zitadel's gRPC server behind it does).
  try{token=(await readFile(pat,'utf8')).trim();const r=await fetch(`${issuer}/management/v1/orgs/me`,{headers:{Authorization:`Bearer ${token}`}});if(r.ok&&token)break;}catch{}
  if(Date.now()>deadline){const log=await readFile(join(dir,'zitadel.log'),'utf8').catch(()=>'');throw Error(`Zitadel did not start:\n${log.slice(-3000)}`);}
  await sleep(500);
 }
 async function api(method,path,body,org){
  for(let attempt=0;;attempt++){
   const r=await fetch(issuer+path,{method,headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json',...(org?{'x-zitadel-orgid':org}:{})},body:body===undefined?undefined:JSON.stringify(body)});
   const text=await r.text();
   if(r.ok)return text?JSON.parse(text):{};
   // Zitadel's projections are eventually consistent: what was just made may not be found yet.
   if((r.status===404||r.status===412||r.status===503)&&attempt<40){await sleep(250);continue;}
   throw Error(`Zitadel ${method} ${path}: ${r.status} ${text}`);
  }
 }
 return{issuer,dir,api,async close(){/* the watchdog stops both once the test process exits */}};
}

/**
 * Sets an organisation's Zitadel up for Scribyra, all through its APIs: no MFA set-up prompt at
 * login; in the owner organisation "Acme" the project "Scribyra" (roles asserted at
 * authentication) with the roles `scribyra:admin`, `scribyra:member`, `scribyra:guest`, and a web
 * application with `redirectUris` (code flow, PKCE, client secret basic, refresh tokens, roles in
 * the ID token but the profile only from userinfo, as Zitadel's defaults leave it, development
 * mode for http redirects); the organisation "Partner" with a project grant of member and guest.
 * `users` maps a name to `{org: 'acme'|'partner', grants: {acme?: roles, partner?: roles}}`: user
 * grants made by Acme on its project, or by Partner through its project grant. Resolves to the
 * IDs, the organisations' domains, the client secret's file, and `grant(name, by, roles)` /
 * `revoke(name, by)` to change a user's roles later.
 */
export async function provision(z,{redirectUris,users}){
 const {api}=z;
 const policy=(await api('GET','/admin/v1/policies/login')).policy;
 await api('PUT','/admin/v1/policies/login',{allowUsernamePassword:true,allowRegister:false,allowExternalIdp:false,passwordlessType:'PASSWORDLESS_TYPE_NOT_ALLOWED',passwordCheckLifetime:policy.passwordCheckLifetime,externalLoginCheckLifetime:policy.externalLoginCheckLifetime,mfaInitSkipLifetime:'0s',secondFactorCheckLifetime:policy.secondFactorCheckLifetime,multiFactorCheckLifetime:policy.multiFactorCheckLifetime,allowDomainDiscovery:false});
 const acme=(await api('GET','/management/v1/orgs/me')).org;
 const project=(await api('POST','/management/v1/projects',{name:'Scribyra',projectRoleAssertion:true})).id;
 await api('POST',`/management/v1/projects/${project}/roles/_bulk`,{roles:[{key:ROLES.admin,displayName:'Scribyra administrator'},{key:ROLES.member,displayName:'Scribyra member'},{key:ROLES.guest,displayName:'Scribyra guest'}]});
 const app=await api('POST',`/management/v1/projects/${project}/apps/oidc`,{name:'Scribyra',redirectUris,postLogoutRedirectUris:[],responseTypes:['OIDC_RESPONSE_TYPE_CODE'],grantTypes:['OIDC_GRANT_TYPE_AUTHORIZATION_CODE','OIDC_GRANT_TYPE_REFRESH_TOKEN'],appType:'OIDC_APP_TYPE_WEB',authMethodType:'OIDC_AUTH_METHOD_TYPE_BASIC',devMode:true,idTokenRoleAssertion:true,accessTokenRoleAssertion:false,idTokenUserinfoAssertion:false});
 const secretFile=join(z.dir,'client-secret');await writeFile(secretFile,app.clientSecret+'\n',{mode:0o600});
 const partnerId=(await api('POST','/management/v1/orgs',{name:'Partner'})).id;
 const partner=(await api('GET','/management/v1/orgs/me',undefined,partnerId)).org;
 const projectGrant=(await api('POST',`/management/v1/projects/${project}/grants`,{grantedOrgId:partner.id,roleKeys:[ROLES.member,ROLES.guest]})).grantId;
 const orgs={acme:acme.id,partner:partner.id};
 const ids={};
 for(const [name,{org='acme'}] of Object.entries(users)){
  const display=name[0].toUpperCase()+name.slice(1);
  const id=(await api('POST','/management/v1/users/human/_import',{userName:name,profile:{firstName:display,lastName:'Test',displayName:display},email:{email:`${name}@acme.test`,isEmailVerified:true},password:password(name),passwordChangeRequired:false},orgs[org])).userId;
  ids[name]={id,org,grants:{}};
 }
 // Acme grants on its own project; Partner grants through the project grant.
 async function grant(name,by,roles){
  const u=ids[name],existing=u.grants[by];
  if(existing)await api('PUT',`/management/v1/users/${u.id}/grants/${existing}`,{roleKeys:roles},orgs[by]);
  else u.grants[by]=(await api('POST',`/management/v1/users/${u.id}/grants`,{projectId:project,roleKeys:roles,...(by==='partner'?{projectGrantId:projectGrant}:{})},orgs[by])).userGrantId;
 }
 async function revoke(name,by){const u=ids[name];await api('DELETE',`/management/v1/users/${u.id}/grants/${u.grants[by]}`,undefined,orgs[by]);delete u.grants[by];}
 for(const [name,{grants={}}] of Object.entries(users))for(const [by,roles] of Object.entries(grants))await grant(name,by,roles);
 return{project,orgs,domains:{acme:acme.primaryDomain,partner:partner.primaryDomain},clientId:app.clientId,secretFile,users:ids,grant,revoke};
}

/** Zitadel's own login form (login UI v1): login name, then password. */
export async function zitadelLogin(page,user,expect){
 const name=page.locator('#loginName');
 await expect(name).toBeVisible({timeout:60000});
 await name.fill(user);await page.locator('#submit-button').click();
 const secret=page.locator('#password');
 await expect(secret).toBeVisible({timeout:30000});
 await secret.fill(password(user));await page.locator('#submit-button').click();
}
