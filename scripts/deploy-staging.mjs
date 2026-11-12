// Publishes a built site by pushing it, as `public/`, to a repository whose only job
// is to serve it with Pages: one commit on top of the previous deployment, pushed with
// an SSH deploy key that can write to that one repository.
//
//   node scripts/deploy-staging.mjs .cache/staging [--dry-run]
//       the staging site (scripts/staging-pages.mjs) → https://dev.scribyra.com/
//   node scripts/deploy-staging.mjs .cache/production --production [--dry-run]
//       GitHub only: the production site (.pages) → the presentation repository that
//       serves https://scribyra.com/ (app.scribyra.com is the main repository's own
//       Pages site; see docs/github-move.md)
//
// GitLab (until the move): urundead-labs/scribyra-staging, whose pages job publishes
// it, because GitLab Free has no cross-project artifact passing.
// GitHub: SCRIBYRA_PAGES_FORGE=github; the target repository's own workflow deploys
// public/ with actions/deploy-pages, and a push by a deploy key starts it. That
// workflow (ops/staging/github-pages.yml or ops/pages/github-pages.yml) is installed
// once by a maintainer (docs/github-move.md); deployments keep `.github/` as it is,
// so CI never writes workflow files in another repository.
//
// The private key arrives base64-encoded, single line: SCRIBYRA_STAGING_DEPLOY_KEY
// (staging) or SCRIBYRA_SITE_DEPLOY_KEY (--production). SCRIBYRA_STAGING_REPOSITORY /
// SCRIBYRA_SITE_REPOSITORY override the SSH remote.
import {mkdir,readdir,rm,copyFile,writeFile,mkdtemp,readFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {pathToFileURL,fileURLToPath} from 'node:url';

export const STAGING_REPOSITORY='git@gitlab.com:urundead-labs/scribyra-staging.git',STAGING_BRANCH='main',CHECKOUT='.cache/staging-repo';
const ROOT=resolve(fileURLToPath(new URL('..',import.meta.url)));
// Per forge and channel: the CI file the target repository runs, where it goes, the
// pinned SSH host key, and the release label the site must carry.
export const TARGETS={
 gitlab:{staging:{ci:['ops/staging/gitlab-ci.yml','.gitlab-ci.yml'],readme:'ops/staging/README.md',knownHosts:'ops/staging/known_hosts',key:'SCRIBYRA_STAGING_DEPLOY_KEY',release:/^dev-[1-9]\d{0,11}-[a-f0-9]{7,40}$/,url:'https://dev.scribyra.com/'}},
 github:{
  staging:{ci:null,keep:'.github',readme:'ops/staging/README.md',knownHosts:'ops/github/known_hosts',key:'SCRIBYRA_STAGING_DEPLOY_KEY',release:/^dev-[1-9]\d{0,11}-[a-f0-9]{7,40}$/,url:'https://dev.scribyra.com/'},
  production:{ci:null,keep:'.github',readme:'ops/pages/README.site.md',knownHosts:'ops/github/known_hosts',key:'SCRIBYRA_SITE_DEPLOY_KEY',release:/^web-[1-9]\d{0,11}$/,url:'https://scribyra.com/'},
 },
};
export function target(forge='gitlab',channel='staging'){
 const found=TARGETS[forge]?.[channel];if(!found)throw Error(`No ${channel} Pages repository on ${forge}`);return found;
}

export function commitMessage({release,sha,pipeline,source='urundead-labs/scribyra',channel='staging'}){
 return[`${channel==='production'?'Production':'Staging'} ${release}`,'',`Built from ${source}@${sha||'unknown'}${pipeline?` by ${pipeline}`:''}.`].join('\n');
}
export function sshCommand(keyFile,knownHosts){
 return['ssh','-i',keyFile,'-o','IdentitiesOnly=yes','-o','StrictHostKeyChecking=yes','-o',`UserKnownHostsFile=${knownHosts}`,'-o','HostKeyAlgorithms=ssh-ed25519','-o','BatchMode=yes'].join(' ');
}
// The private key arrives base64-encoded; reject anything that is not an OpenSSH key.
export function decodeKey(value,name='SCRIBYRA_STAGING_DEPLOY_KEY'){
 const key=Buffer.from(String(value||'').trim(),'base64').toString('utf8');
 if(!/^-----BEGIN OPENSSH PRIVATE KEY-----\n[\s\S]+\n-----END OPENSSH PRIVATE KEY-----\n?$/.test(key))throw Error(`${name} must be the base64 of an OpenSSH private key`);
 return key.endsWith('\n')?key:key+'\n';
}
async function copyTree(source,destination){
 await mkdir(destination,{recursive:true});
 for(const entry of await readdir(source,{withFileTypes:true})){
  const from=join(source,entry.name),to=join(destination,entry.name);
  if(entry.isDirectory())await copyTree(from,to);
  // Real copies, never hard links: Git rewrites these files, and links would reach the build inputs.
  else if(entry.isFile())await copyFile(from,to);
 }
}
// Replaces the checkout's tree with public/ (the site), README.md and, on GitLab, the
// target's CI file. On GitHub the target's `.github/` stays as the maintainer set it.
export async function stageTree(site,checkout,{ci=TARGETS.gitlab.staging.ci,readme=TARGETS.gitlab.staging.readme,keep=null}={}){
 for(const entry of await readdir(checkout))if(entry!=='.git'&&entry!==keep)await rm(join(checkout,entry),{recursive:true,force:true});
 await copyTree(site,join(checkout,'public'));
 if(ci)await copyFile(join(ROOT,ci[0]),join(checkout,ci[1]));
 await copyFile(join(ROOT,readme),join(checkout,'README.md'));
}

export async function publish({root,checkout=CHECKOUT,remote=STAGING_REPOSITORY,env=process.env,dry=false,log=console.log,forge='gitlab',channel='staging'}){
 const goal=target(forge,channel);
 const release=JSON.parse(await readFile(join(root,'site/release.json'),'utf8')).release;
 if(!goal.release.test(release||''))throw Error(`Only a checked ${channel} build can be published`);
 const secrets=dry?null:await mkdtemp(join(tmpdir(),'scribyra-pages-key-'));
 try{
  const gitEnv={...env,GIT_TERMINAL_PROMPT:'0',GIT_AUTHOR_NAME:'Scribyra CI',GIT_AUTHOR_EMAIL:'noreply@scribyra.com',GIT_COMMITTER_NAME:'Scribyra CI',GIT_COMMITTER_EMAIL:'noreply@scribyra.com'};
  if(secrets){const key=join(secrets,'id');await writeFile(key,decodeKey(env[goal.key],goal.key),{mode:0o600});gitEnv.GIT_SSH_COMMAND=sshCommand(key,join(ROOT,goal.knownHosts));}
  const git=(args,options={})=>execFileSync('git',['-C',checkout,...args],{env:gitEnv,encoding:'utf8',stdio:['ignore','pipe','inherit'],...options});
  await mkdir(checkout,{recursive:true});
  let fresh=false;try{fresh=git(['rev-parse','--show-toplevel']).trim()!==resolve(checkout);}catch{fresh=true;}
  if(fresh)git(['init','-q','-b',STAGING_BRANCH]);
  try{git(['remote','set-url','origin',remote],{stdio:'ignore'});}catch{git(['remote','add','origin',remote]);}
  // Shallow: only the last deployment is needed to push the next one on top of it.
  let fetched=false;
  if(!dry){try{git(['fetch','-q','--depth','1','origin',STAGING_BRANCH]);fetched=true;}catch{log('Pages repository has no deployment yet; creating the first.');}}
  if(fetched)git(['checkout','-q','-f','-B',STAGING_BRANCH,'FETCH_HEAD']);else git(['symbolic-ref','HEAD',`refs/heads/${STAGING_BRANCH}`]);
  await stageTree(join(root,'site'),checkout,goal);
  git(['add','-A']);
  try{git(['diff','--cached','--quiet']);log('Site unchanged; nothing to publish.');return false;}catch{}
  git(['commit','-q','--no-gpg-sign','-m',commitMessage({release,sha:env.CI_COMMIT_SHA,pipeline:env.CI_PIPELINE_URL,source:env.GITHUB_REPOSITORY||undefined,channel})]);
  if(dry){log(`Dry run: committed ${release} in ${checkout}; not pushed.`);return true;}
  git(['push','-q','origin',`HEAD:refs/heads/${STAGING_BRANCH}`],{stdio:['ignore','inherit','inherit']});
  log(`Published ${release} to ${remote}; its Pages job deploys ${goal.url}.`);return true;
 }finally{if(secrets)await rm(secrets,{recursive:true,force:true});}
}

if(import.meta.url===pathToFileURL(process.argv[1]).href){
 const root=process.argv[2],dry=process.argv.includes('--dry-run'),channel=process.argv.includes('--production')?'production':'staging';
 const forge=process.env.SCRIBYRA_PAGES_FORGE||'gitlab',goal=target(forge,channel);
 if(!root)throw Error('Usage: deploy-staging.mjs <prepared folder> [--production] [--dry-run]');
 if(!dry&&!process.env[goal.key])throw Error(`${goal.key} is not set for this job`);
 const remote=channel==='production'?process.env.SCRIBYRA_SITE_REPOSITORY:(process.env.SCRIBYRA_STAGING_REPOSITORY||(forge==='gitlab'?STAGING_REPOSITORY:undefined));
 if(!remote)throw Error(`Set ${channel==='production'?'SCRIBYRA_SITE_REPOSITORY':'SCRIBYRA_STAGING_REPOSITORY'} to the SSH address of the ${channel} Pages repository`);
 await publish({root,remote,dry,forge,channel,checkout:channel==='production'?'.cache/site-repo':CHECKOUT});
}
