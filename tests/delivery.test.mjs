import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm,link} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {latestRelease,parseMergeCommit,renderChangelog,collect} from '../scripts/release-changelog.mjs';
import {pendingCommits,backMergeRequest,run,MISSING_TOKEN_EXIT} from '../scripts/back-merge.mjs';
import {stagingHtml,prepare,check,NOINDEX,BANNER_ATTRIBUTE,ROBOTS} from '../scripts/staging-pages.mjs';
import {publish,decodeKey,sshCommand,commitMessage} from '../scripts/deploy-staging.mjs';
import {isStagingRelease,stagingMarker,STAGING_TITLE_PREFIX} from '../web/staging-marker.js';
import {officialTelemetryEndpoint} from '../scripts/official-telemetry.mjs';

test('the latest release is the highest web-<N>, not the newest string',()=>{
 assert.equal(latestRelease(['web-9','web-12','web-100','dev-5','web-0','notes']),'web-100');
 assert.equal(latestRelease([]),null);
});
test('GitLab merge commits become changelog entries',()=>{
 assert.deepEqual(parseMergeCommit("Merge branch 'feature/outline' into 'dev'",'Add the outline panel\n\nLonger text.\n\nSee merge request urundead-labs/scribyra!42\n'),{branch:'feature/outline',target:'dev',title:'Add the outline panel',mr:42});
 assert.equal(parseMergeCommit('Fix a typo'),null);
 assert.equal(parseMergeCommit("Merge branch 'feature/x' into 'dev'",'').title,'feature/x');
 const text=renderChangelog([{branch:'feature/a',target:'dev',title:'A',mr:1},{branch:'hotfix/b',target:'main',title:'B',mr:2},{branch:'main',target:'dev',title:'x',mr:3},{branch:'chore/c',target:'dev',title:'C',mr:null}],{since:'web-7',tests:'Pipeline #9 passed'});
 assert.match(text,/## Changes since web-7/);assert.match(text,/### Features\n\n- A \(!1\)/);assert.doesNotMatch(text,/- B/,'merges into other branches are not listed');
 assert.match(text,/### Fixes from production\n\n- Production fixes merged back into dev \(!3\)/);assert.match(text,/### Other changes\n\n- C\n/);assert.match(text,/## Test results\n\nPipeline #9 passed/);
});
async function repository(){
 const dir=await mkdtemp(join(tmpdir(),'scribyra-delivery-'));
 const git=(...args)=>execFileSync('git',args,{cwd:dir,encoding:'utf8',env:{...process.env,GIT_AUTHOR_NAME:'T',GIT_AUTHOR_EMAIL:'t@example.invalid',GIT_COMMITTER_NAME:'T',GIT_COMMITTER_EMAIL:'t@example.invalid'}});
 git('init','-q','-b','main');git('commit','-q','--allow-empty','-m','root');git('tag','web-3');git('branch','dev');
 return{dir,git};
}
test('the changelog reads merge requests merged into dev since the last release',async()=>{
 const{dir,git}=await repository();
 try{
  for(const[name,title,mr]of [['feature/one','First feature',11],['feature/two','Second feature',12]]){
   git('checkout','-q','-b',name,'dev');git('commit','-q','--allow-empty','-m','work on '+name);git('checkout','-q','dev');
   git('merge','-q','--no-ff',name,'-m',`Merge branch '${name}' into 'dev'`,'-m',title,'-m',`See merge request urundead-labs/scribyra!${mr}`);
  }
  const previous=process.cwd();process.chdir(dir);
  try{const{since,entries,direct}=collect({to:'dev',main:'main'});assert.equal(since,'web-3');assert.deepEqual(entries.map(entry=>entry.mr),[11,12]);assert.deepEqual(direct,[]);}
  finally{process.chdir(previous);}
 }finally{await rm(dir,{recursive:true,force:true});}
});
test('a back-merge is needed only when main has changes dev lacks',async()=>{
 const{dir,git}=await repository();
 try{
  const g=args=>git(...args);
  git('checkout','-q','dev');git('commit','-q','--allow-empty','-m','feature on dev');
  // A release merge (dev → main) leaves main with nothing dev lacks.
  git('checkout','-q','main');git('merge','-q','--no-ff','dev','-m',"Merge branch 'dev' into 'main'");
  assert.deepEqual(pendingCommits(g,'main','dev'),[]);
  // A hotfix on main must come back.
  git('checkout','-q','-b','hotfix/crash','main');await writeFile(join(dir,'fix.txt'),'fixed\n');git('add','fix.txt');git('commit','-q','-m','Fix the crash');
  git('checkout','-q','main');git('merge','-q','--no-ff','hotfix/crash','-m',"Merge branch 'hotfix/crash' into 'main'");
  const pending=pendingCommits(g,'main','dev');assert.equal(pending.length,1);assert.match(pending[0],/Fix the crash/);
  // Once dev has merged main back, nothing is pending.
  git('checkout','-q','dev');git('merge','-q','--no-ff','main','-m',"Merge branch 'main' into 'dev'");
  assert.deepEqual(pendingCommits(g,'main','dev'),[]);
 }finally{await rm(dir,{recursive:true,force:true});}
});
test('the back-merge request never deletes main and never squashes',()=>{
 const body=backMergeRequest({subject:"Merge branch 'hotfix/crash' into 'main'",commits:['abc123 Fix the crash'],assignees:[7]});
 assert.equal(body.source_branch,'main');assert.equal(body.target_branch,'dev');assert.equal(body.remove_source_branch,false);assert.equal(body.squash,false);
 assert.deepEqual(body.assignee_ids,[7]);assert.match(body.description,/abc123 Fix the crash/);
});
test('the back-merge job opens one merge request, reuses an open one, and falls back without a token',async()=>{
 const git=args=>{if(args[0]==='merge-base'||args[0]==='diff')throw Error('differs');if(args[0]==='log'&&args[1]==='-1')return'Merge hotfix\n';if(args[0]==='log')return'abc Fix\n';return'';};
 const env={CI_COMMIT_SHA:'f'.repeat(40),CI_API_V4_URL:'https://gitlab.example.invalid/api/v4',CI_PROJECT_ID:'5',SCRIBYRA_BACKMERGE_TOKEN:'t'};
 const calls=[],logs=[];
 const fetcher=async(url,options={})=>{calls.push([url,options.method||'GET',options.headers?.['PRIVATE-TOKEN']]);return options.method==='POST'?{ok:true,json:async()=>({web_url:'https://x/mr/1'})}:{ok:true,json:async()=>[]};};
 assert.equal(await run({env,git,fetcher,log:line=>logs.push(line)}),0);
 assert.deepEqual(calls.map(call=>call[1]),['GET','POST']);assert.ok(calls.every(call=>call[2]==='t'));assert.match(logs.at(-1),/Opened back-merge/);
 const reuse=async()=>({ok:true,json:async()=>[{web_url:'https://x/mr/0'}]});
 assert.equal(await run({env,git,fetcher:reuse,log:line=>logs.push(line)}),0);assert.match(logs.at(-1),/already open/);
 assert.equal(await run({env:{...env,SCRIBYRA_BACKMERGE_TOKEN:''},git,fetcher:()=>assert.fail('no API call without a token'),log:line=>logs.push(line)}),MISSING_TOKEN_EXIT);
 assert.match(logs.at(-1),/glab mr create --source-branch main --target-branch dev/);
 const same=args=>args[0]==='merge-base'?'':'';
 assert.equal(await run({env,git:same,fetcher:()=>assert.fail('no API call when dev is current'),log:()=>{}}),0);
});

test('staging pages get noindex, a banner and robots, and no sitemap, without touching linked build inputs',async()=>{
 const root=await mkdtemp(join(tmpdir(),'scribyra-staging-')),site=join(root,'site'),source=join(root,'source.html');
 try{
  await mkdir(join(site,'app'),{recursive:true});await mkdir(join(site,'assets'),{recursive:true});
  // ci-pages assembles with hard links; prepare must replace files, not write through links.
  await writeFile(source,'<!doctype html><html><head><title>S</title></head><body><main>Site</main></body></html>');await link(source,join(site,'index.html'));
  await writeFile(join(site,'privacy.html'),`<html><head>${NOINDEX}</head><body class="x">P</body></html>`);
  await writeFile(join(site,'app/index.html'),'<html><head></head><body><script type="module" src="/app/assets/m.js"></script></body></html>');
  await writeFile(join(site,'assets/main.js'),"const r='dev-5-1a2b3c4d';el.className='staging-marker';");
  for(const path of ['sw.js','domain-router.js','app/sw.js'])await writeFile(join(site,path),'//');
  await writeFile(join(site,'robots.txt'),'User-agent: *\nAllow: /\n');await writeFile(join(site,'sitemap.xml'),'<urlset/>');
  for(const path of ['release.json','app/release.json'])await writeFile(join(site,path),JSON.stringify({release:'dev-5-1a2b3c4d'}));
  assert.equal(await prepare(root),3);
  assert.doesNotMatch(await readFile(source,'utf8'),/noindex/,'the linked source file is unchanged');
  const index=await readFile(join(site,'index.html'),'utf8');assert.ok(index.includes(NOINDEX)&&index.includes(BANNER_ATTRIBUTE));
  const app=await readFile(join(site,'app/index.html'),'utf8');assert.ok(app.includes(NOINDEX)&&!app.includes(BANNER_ATTRIBUTE),'the app shell carries its own badge');
  assert.equal((await readFile(join(site,'privacy.html'),'utf8')).split('noindex').length,2,'noindex is not duplicated');
  assert.equal(await readFile(join(site,'robots.txt'),'utf8'),ROBOTS);await assert.rejects(readFile(join(site,'sitemap.xml')),'the production sitemap is removed');
  assert.deepEqual(await check(root),[]);
  // The check catches a collector address, a missing marker and a production label.
  await writeFile(join(site,'assets/main.js'),`fetch(${JSON.stringify(officialTelemetryEndpoint)})`);
  await writeFile(join(site,'release.json'),JSON.stringify({release:'web-5'}));await writeFile(join(site,'sitemap.xml'),'<urlset/>');
  const problems=await check(root);
  assert.ok(problems.some(p=>/collector/.test(p))&&problems.some(p=>/staging marker/.test(p))&&problems.some(p=>/^release\.json/.test(p))&&problems.some(p=>/sitemap/.test(p)),problems.join('\n'));
 }finally{await rm(root,{recursive:true,force:true});}
});
test('production site pages are indexable, with a sitemap of scribyra.com pages; staging turns that off',async()=>{
 const pages=['index.html','privacy.html','licenses.html','telemetry.html'];
 for(const name of pages){const html=await readFile(join('site',name),'utf8');assert.doesNotMatch(html,/<meta\s+name="robots"/i,name);assert.match(stagingHtml(html),/<meta name="robots" content="noindex, nofollow">/,name);}
 const robots=await readFile('site/robots.txt','utf8');assert.match(robots,/^User-agent: \*\nAllow: \/\n/);assert.doesNotMatch(robots,/^Disallow: \/$/m);assert.match(robots,/^Disallow: \/field-test\/$/m);assert.match(robots,/^Sitemap: https:\/\/scribyra\.com\/sitemap\.xml$/m);assert.notEqual(robots,ROBOTS);
 const sitemap=await readFile('site/sitemap.xml','utf8'),urls=[...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map(m=>m[1]);
 assert.deepEqual(urls,['https://scribyra.com/',...pages.slice(1).map(name=>'https://scribyra.com/'+name)]);
});
test('staging HTML edits are idempotent and handle pages without head or body tags',()=>{
 const once=stagingHtml('<html><head></head><body></body></html>');assert.equal(stagingHtml(once),once);
 const bare=stagingHtml('<!doctype html><html lang="en"><meta charset="utf-8"><title>T</title><p>x</p></html>');
 assert.ok(bare.startsWith('<!doctype html><html lang="en">'+NOINDEX));assert.match(bare,/position:fixed;top:0;left:0;right:0[^>]*>Staging[\s\S]*<\/div><\/html>$/);
});
test('the staging deploy commits the site as public/ on top of the last deployment',async()=>{
 const root=await mkdtemp(join(tmpdir(),'scribyra-staging-')),remote=join(root,'remote.git'),checkout=join(root,'checkout');
 try{
  execFileSync('git',['init','-q','--bare','-b','main',remote]);
  await mkdir(join(root,'site/app'),{recursive:true});
  await writeFile(join(root,'site/index.html'),'one');await writeFile(join(root,'site/release.json'),JSON.stringify({release:'dev-5-1a2b3c4d'}));
  const env={...process.env,SCRIBYRA_STAGING_DEPLOY_KEY:'',CI_COMMIT_SHA:'c'.repeat(40)};
  // Dry runs commit locally without a key; push by hand to emulate the first deployment.
  assert.equal(await publish({root,checkout,remote,env,dry:true,log:()=>{}}),true);
  execFileSync('git',['-C',checkout,'push','-q','origin','HEAD:refs/heads/main']);
  const tree=execFileSync('git',['-C',remote,'ls-tree','-r','--name-only','main'],{encoding:'utf8'}).trim().split('\n');
  assert.deepEqual(tree.sort(),['.gitlab-ci.yml','README.md','public/index.html','public/release.json']);
  assert.match(execFileSync('git',['-C',remote,'log','-1','--format=%B','main'],{encoding:'utf8'}),/^Staging dev-5-1a2b3c4d\n\nBuilt from urundead-labs\/scribyra@c{40}/);
  assert.match(await readFile(join(checkout,'.gitlab-ci.yml'),'utf8'),/publish: public/);
  // An unchanged site makes no new commit.
  assert.equal(await publish({root,checkout,remote,env,dry:true,log:()=>{}}),false);
 }finally{await rm(root,{recursive:true,force:true});}
});
test('the deploy key must be a base64 OpenSSH private key, and SSH pins gitlab.com',async()=>{
 const key='-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n-----END OPENSSH PRIVATE KEY-----\n';
 assert.equal(decodeKey(Buffer.from(key).toString('base64')),key);
 assert.throws(()=>decodeKey('bm90IGEga2V5'));assert.throws(()=>decodeKey(''));
 const ssh=sshCommand('/k','/h');assert.match(ssh,/StrictHostKeyChecking=yes/);assert.match(ssh,/IdentitiesOnly=yes/);
 assert.match(await readFile('ops/staging/known_hosts','utf8'),/^gitlab\.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAfuCHKVTjquxvt6CM6tdG4SLp1Btn\/nOeHHE5UOzRdf\n$/);
 assert.match(commitMessage({release:'dev-1-aaaaaaa',sha:null}),/@unknown/);
});
test('only staging releases show the staging badge',()=>{
 assert.ok(isStagingRelease('dev-3-1a2b3c4'));assert.ok(!isStagingRelease('web-3'));assert.ok(!isStagingRelease(null));
 const appended=[];const element={setAttribute(){},};
 const doc={title:'Scribyra',body:{append:node=>appended.push(node)},documentElement:{dataset:{}},createElement:()=>({...element}),querySelector:()=>null};
 assert.equal(stagingMarker('web-3',{document:doc}),null);assert.equal(appended.length,0);
 const badge=stagingMarker('dev-3-1a2b3c4',{document:doc});assert.equal(badge.textContent,'Staging');assert.equal(appended.length,1);
 assert.equal(doc.title,STAGING_TITLE_PREFIX+'Scribyra');assert.equal(doc.documentElement.dataset.scribyraStaging,'1');
});

test('staging CI script lines never read as YAML mappings',async()=>{
  // GitLab refused the staging pipeline when an unquoted script line held ": ".
  const text=await readFile(new URL('../ops/staging/gitlab-ci.yml',import.meta.url),'utf8');
  const script=text.split(/^  script:\n/m)[1].split(/^  \S/m)[0];
  for(const line of script.split('\n')){const item=line.match(/^\s+- (.*)$/);if(item&&!/^["']/.test(item[1]))assert.doesNotMatch(item[1],/: /,line);}
});
