// One coherent presentation, root-app and legacy /app release. Compiler data
// lives once under /app/core; the root shell reuses it instead of copying it.
import {mkdir,readdir,link,copyFile,writeFile,readFile,rm} from 'node:fs/promises';
import {join,resolve,relative} from 'node:path';
import {createHash} from 'node:crypto';
async function copy(source,destination){
 await mkdir(destination,{recursive:true});
 for(const entry of await readdir(source,{withFileTypes:true})){
  const from=join(source,entry.name),to=join(destination,entry.name);
  if(entry.isDirectory())await copy(from,to);
  else if(entry.isFile()){try{await link(from,to);}catch(error){if(error.code==='EEXIST'){if(!(await readFile(from)).equals(await readFile(to)))throw Error('Release asset collision');}else if(error.code==='EXDEV')await copyFile(from,to);else throw error;}}
  else throw Error('Release inputs must contain regular files/directories.');
 }
}
const output=process.env.SCRIBYRA_PAGES_OUTPUT||'.pages';
const relativeOutput=relative(process.cwd(),resolve(output));
if(relativeOutput!=='.pages'&&relativeOutput!=='.cache/staging/site'&&!/^\.cache\/pages-domain-[a-zA-Z0-9_-]+$/.test(relativeOutput))throw Error('Pages output must be a disposable release directory');
// The staging build (scripts/build-pages.mjs --staging) assembles from its own
// application and root-shell builds and its own domain file.
const appDirectory=process.env.SCRIBYRA_PAGES_APP_DIR||'dist',shellDirectory=process.env.SCRIBYRA_PAGES_SHELL_DIR||'.cache/pages-root-shell';
const domainsFile=process.env.SCRIBYRA_PAGES_DOMAINS||'ops/pages/domains.json';
for(const path of [appDirectory,shellDirectory,domainsFile])if(!/^(?:dist|\.cache\/[a-z-]+(?:\/[a-z-]+)?|ops\/pages\/domains(?:\.staging)?\.json)$/.test(relative(process.cwd(),resolve(path))))throw Error('Unexpected Pages input');
const domains=JSON.parse(await readFile(domainsFile,'utf8'));
function rootUrl(value){let url;try{url=new URL(value);}catch{throw Error('Invalid public domain URL');}if(url.username||url.password||url.search||url.hash||url.pathname!=='/'||(url.protocol!=='https:'&&!(url.protocol==='http:'&&['localhost','127.0.0.1','[::1]'].includes(url.hostname))))throw Error('Public domains require HTTPS root URLs or loopback test URLs');return url;}
const presentation=rootUrl(process.env.SCRIBYRA_PRESENTATION_URL||domains.presentation),application=rootUrl(process.env.SCRIBYRA_APP_URL||domains.application);
if(domains.version!==1||typeof domains.active!=='boolean'||presentation.hostname===application.hostname)throw Error('Distinct presentation/application hosts are required');
const rootIndex=await readFile(join(shellDirectory,'index.html'),'utf8');
const modules=[...rootIndex.matchAll(/<script\b[^>]*type="module"[^>]*src="([^"]+)"[^>]*><\/script>/g)].map(m=>m[1]);
const styles=[...rootIndex.matchAll(/<link\b[^>]*rel="stylesheet"[^>]*href="([^"]+)"[^>]*>/g)].map(m=>m[1]);
const body=rootIndex.match(/<body[^>]*>([\s\S]*?)<\/body>/)?.[1];
if(modules.length!==1||body===undefined||[...modules,...styles].some(path=>!path.startsWith('/assets/')||path.includes('..')))throw Error('Unexpected root application shell');
const title=rootIndex.match(/<title>(.*?)<\/title>/)?.[1]||'Scribyra';
const config={host:application.hostname,presentationHost:presentation.hostname,url:application.href,legacy:domains.legacyApplication,module:modules[0],styles,body,title};
const router=`// Host selects a static shell; GitLab Pages still enforces access control.\nconst app=${JSON.stringify(config)};\nif(location.hostname===app.host){
 document.title=app.title;
 const recipe=document.createElement('link');recipe.rel='alternate';recipe.type='text/markdown';recipe.href='agent.md';document.head.append(recipe);
 for(const node of document.querySelectorAll('link[rel="stylesheet"]'))node.remove();
 document.body.innerHTML=app.body;
 try{
  const load=(tag,attributes)=>new Promise((resolve,reject)=>{const node=document.createElement(tag);Object.assign(node,attributes);node.onload=resolve;node.onerror=()=>reject(Error('App asset unavailable'));document.head.append(node);});
  await Promise.all([...app.styles.map(href=>load('link',{rel:'stylesheet',href,crossOrigin:'anonymous'})),load('script',{type:'module',src:app.module,crossOrigin:'anonymous'})]);
 }catch{
  const message=document.createElement('p');message.textContent='Scribyra could not load. Reconnect and reload.';
  const previous=document.createElement('a');previous.textContent='Open the previous app address';previous.href=app.legacy;
  document.body.replaceChildren(message,previous);
 }finally{delete document.documentElement.dataset.scribyraApp;}
}else{
 if(location.hostname===app.presentationHost)for(const link of document.querySelectorAll('a[href="app/"]'))link.href=app.url;
 await import('./site.js');
}\n`;
let landing=await readFile('site/index.html','utf8');
landing=landing.replace('<script src="site.js" defer></script>','<script type="module" src="domain-router.js"></script>');
landing=landing.replace('<head>','<head>\n  <script>if(location.hostname==='+JSON.stringify(application.hostname)+')document.documentElement.dataset.scribyraApp="1";</script>\n  <style>html[data-scribyra-app] body{visibility:hidden}</style>');
await rm(output,{recursive:true,force:true});
await copy('site',output);await copyFile(join(appDirectory,'agent.md'),join(output,'agent.md'));await copy(appDirectory,join(output,'app'));await copy(join(shellDirectory,'assets'),join(output,'assets'));
// Licence notices are served as plain text, so a browser shows them and doesn't download them.
await mkdir(join(output,'licenses'),{recursive:true});
for(const[from,to]of [['LICENSE','LICENSE.txt'],['COPYRIGHT','COPYRIGHT.txt'],['THIRD_PARTY.md','THIRD_PARTY.txt'],[join(appDirectory,'core/busytex/LICENSE.TL'),'LICENSE.TL.txt'],[join(appDirectory,'core/busytex/LICENSE.CTAN'),'LICENSE.CTAN.txt'],[join(appDirectory,'core/busytex/release-texlive.txt'),'release-texlive.txt'],['vendor/tex/support/NOTICE','tex-support-NOTICE.txt'],['vendor/tex/catalog/NOTICE','tex-catalog-NOTICE.txt']])await copyFile(from,join(output,'licenses',to));
await mkdir(join(output,'field-test'),{recursive:true});await copyFile('docs/reorientation/field-test.html',join(output,'field-test/index.html'));
await rm(join(output,'index.html'));await writeFile(join(output,'index.html'),landing);await writeFile(join(output,'domain-router.js'),router);
let worker=await readFile(join(shellDirectory,'sw.js'),'utf8');
const cacheName='scribyra-shell-'+createHash('sha256').update(worker).update(router).update(landing).digest('hex').slice(0,12);
if(!/const CACHE='scribyra-shell-[a-f0-9]{12}';/.test(worker))throw Error('Unexpected root cache format');
worker=worker.replace(/const CACHE='scribyra-shell-[a-f0-9]{12}';/,`const CACHE='${cacheName}';`);await writeFile(join(output,'sw.js'),worker);
const version=JSON.parse(await readFile('package.json','utf8')).version;
const preferred=domains.active?application.href:(process.env.CI_PAGES_URL?process.env.CI_PAGES_URL.replace(/\/$/,'')+'/app/':domains.legacyApplication);
const release={version,revision:process.env.CI_COMMIT_SHA||null,pipeline:process.env.CI_PIPELINE_URL||null,release:process.env.SCRIBYRA_RELEASE||(process.env.CI_PIPELINE_IID?`web-${process.env.CI_PIPELINE_IID}`:null),builtAt:new Date().toISOString(),appUrl:preferred};
for(const path of [join(output,'app/release.json'),join(output,'release.json')])await writeFile(path,JSON.stringify(release,null,2)+'\n');
if(relativeOutput==='.pages')await writeFile('.pages-release.env','SCRIBYRA_DEPLOYED_APP_URL='+preferred+'\n');
