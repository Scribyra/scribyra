// "Open in Scribyra" links in all three engines, against fake GitHub, GitLab and file
// hosts (tests/helpers/fake-forges.mjs). The app addresses the real hosts; an init
// script sends those requests on to the fakes on 127.0.0.1, so the browser makes real
// cross-origin requests under CORS. Nothing contacts GitHub, GitLab or any file host.
import {test,expect} from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import * as Y from 'yjs';
import http from 'node:http';
import {mkdirSync} from 'node:fs';
import {readFile} from 'node:fs/promises';
import {resolve,extname,sep} from 'node:path';
import {zipSync,strToU8} from 'fflate';
import {fakeGitHub,fakeGitLab,fakeFiles,snapshot,repository} from '../helpers/fake-forges.mjs';
test.use({actionTimeout:15000});
test.setTimeout(300000);

const shots=process.env.SCRIBYRA_SCREENSHOTS;
const MAIN=await readFile('fixtures/article/main.tex','utf8'),FIGURE=new Uint8Array(await readFile('fixtures/article/figure.png'));
const ROOT=String.raw`\documentclass{article}
\begin{document}
Other root document.
\end{document}
`;
const POINTER='version https://git-lfs.github.com/spec/v1\noid sha256:4d7a214614ab2935c943f9e0ff69d22eadbb8f32b1258daaa5e2ca24d17e2393\nsize 4194304\n';
const MiB=1024*1024;
function paperRepo(){
 const main=snapshot({
  'README.md':'# Paper\n',
  '.gitattributes':'*.pdf filter=lfs diff=lfs merge=lfs -text\n',
  'paper/main.tex':MAIN,'paper/figure.png':FIGURE,'paper/sections/intro.tex':'\\section{Intro}\n',
  'paper/notes.tex':new Uint8Array([0x63,0x61,0x66,0xe9,0x0a]),
  'paper/data/scan.pdf':POINTER,
  'paper/data/huge.bin':{content:'x',size:17*MiB},
  'paper/current.tex':{content:'main.tex',mode:'120000'},
 },{submodules:{'paper/vendor/style':'1111111111111111111111111111111111111111'}});
 const tagged=snapshot({'main.tex':ROOT,'other.tex':ROOT.replace('Other','Tagged'),'figure.png':FIGURE});
 return repository({main,v1:tagged},{defaultBranch:'main'});
}
function thesisRepo(){
 const dev=snapshot({
  'src/thesis.tex':ROOT.replace('Other root','Thesis root'),'src/chapters/one.tex':'\\chapter{One}\n','src/figures/plot.tex':'\\documentclass{standalone}\n\\begin{document}x\\end{document}\n',
  'src/drafts/old.tex':{content:'old',exportIgnore:true},'src/link.tex':{content:'thesis.tex',mode:'120000'},'other/ignored.tex':'outside the folder',
 },{submodules:{'src/vendor/cls':'2222222222222222222222222222222222222222'}});
 return repository({main:snapshot({'README.md':'main branch'}),dev},{defaultBranch:'main'});
}

/** Starts the fakes and points the page's fetch at them. */
async function forges(page,{github={},gitlab={},files=null}={}){
 const gh=fakeGitHub(github).add('octo/paper',paperRepo());
 const gl=fakeGitLab({host:'gitlab.com',...gitlab}).add('group/sub/thesis',thesisRepo());
 const own=fakeGitLab({host:'gitlab.example.org'}).add('team/report',repository({main:snapshot({'report.tex':ROOT.replace('Other root','Self-hosted'),'img/figure.png':FIGURE})}));
 const host=fakeFiles();if(files)files(host);
 const githubUrls=await gh.start(),map=[['https://api.github.com',githubUrls.api],['https://raw.githubusercontent.com',githubUrls.raw],['https://gitlab.com',await gl.start()],['https://gitlab.example.org',await own.start()],['https://files.example.org',await host.start()]];
 await page.addInitScript(map=>{
  const original=window.fetch.bind(window);
  window.fetch=(input,options)=>{const url=input instanceof Request?input.url:String(input);for(const [from,to]of map)if(url.startsWith(from+'/'))return original(to+url.slice(from.length),options);return original(input,options);};
 },map);
 // Anything the page sends outside the loopback test servers is a failure.
 const outside=[];page.on('request',request=>{const url=new URL(request.url());if(!['127.0.0.1','localhost'].includes(url.hostname)&&!['data:','blob:'].includes(url.protocol))outside.push(request.url());});
 const all=()=>[...gh.requests(),...gl.requests(),...own.requests(),...host.requests()];
 return {gh,gl,own,host,outside,all,close:()=>Promise.all([gh.close(),gl.close(),own.close(),host.close()])};
}
const dialog=page=>page.getByRole('dialog');
const notice=page=>page.getByRole('status',{name:'Workspace notification',exact:true});
async function openLink(page,fragment){
 await page.goto('/'+fragment);
 await expect(dialog(page)).toBeVisible();
 await expect(page).not.toHaveURL(/#open/);
}
async function check(page,label='Check repository'){
 await dialog(page).getByRole('button',{name:label,exact:true}).click();
 await expect(dialog(page).getByRole('button',{name:'Import',exact:true})).toBeVisible({timeout:60000});
}
async function importAndWait(page,button='Import'){
 // The new project replaces whatever was open: wait for its own agent session.
 await page.evaluate(()=>{window.previousAgent=window.scribyra.agent;});
 await dialog(page).getByRole('button',{name:button,exact:true}).click();
 await expect.poll(()=>page.evaluate(()=>!!window.scribyra.agent&&window.scribyra.agent!==window.previousAgent&&window.scribyra.agent.status().ok),{timeout:60000}).toBe(true);
 await expect(dialog(page)).toHaveCount(0,{timeout:60000});
 await expect(page.getByRole('textbox',{name:'LaTeX source',exact:true})).toBeVisible({timeout:60000});
}
async function project(page){
 return page.evaluate(()=>{const status=window.scribyra.agent.status().value,items=window.scribyra.agent.readTree({limit:100}).value.items;return {name:status.name,main:items.find(item=>item.id===status.mainFile)?.path||'',paths:items.filter(item=>item.kind!=='folder').map(item=>item.path).sort()};});
}
async function storedMeta(page){
 const records=await page.evaluate(async()=>{
  const db=await new Promise((resolve,reject)=>{const request=indexedDB.open('scribyra-v1');request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);});
  try{return await new Promise((resolve,reject)=>{const request=db.transaction('projects').objectStore('projects').getAll();request.onsuccess=()=>resolve(request.result.map(record=>({id:record.id,update:Array.from(record.update)})));request.onerror=()=>reject(request.error);});}finally{db.close();}
 });
 return records.map(record=>{const doc=new Y.Doc();Y.applyUpdate(doc,Uint8Array.from(record.update));const meta=doc.getMap('meta').toJSON();doc.destroy();return {id:record.id,...meta};});
}
async function shoot(page,name,locator){
 if(!shots)return;mkdirSync(shots,{recursive:true});const engine=test.info().project.name;
 for(const theme of ['light','dark']){await page.evaluate(theme=>{document.documentElement.dataset.theme=theme;},theme);await page.waitForTimeout(150);await (locator||page).screenshot({path:`${shots}/${name}-${theme}-${engine}.png`});}
 await page.evaluate(()=>{delete document.documentElement.dataset.theme;});
}

test('GitHub link: confirmation first, then check, report, import, compile and provenance; re-opening offers the copy',async({page})=>{
 const fakes=await forges(page);
 try{
  await openLink(page,'#open?repo=github.com/octo/paper&path=paper');
  const box=dialog(page);
  await expect(box.getByRole('heading',{name:'Open a repository in Scribyra'})).toBeVisible();
  await expect(box).toContainText('github.com/octo/paper / paper');await expect(box).toContainText('Default branch');
  await expect(box.getByRole('link',{name:'github.com/octo/paper / paper'})).toHaveAttribute('href','https://github.com/octo/paper/tree/HEAD/paper');
  await expect(box).toContainText('Checking contacts api.github.com and raw.githubusercontent.com');
  await expect(box.getByRole('button',{name:'Import',exact:true})).toHaveCount(0);
  // Nothing is fetched before the person asks for it.
  await page.waitForTimeout(500);expect(fakes.all()).toEqual([]);
  const axe=await new AxeBuilder({page}).include('dialog').analyze();expect(axe.violations).toEqual([]);
  await shoot(page,'open-link-review',box);
  await check(page);
  const commit=paperRepo().refs.main.commit;
  await expect(box).toContainText(`Commit ${commit.slice(0,12)}`);
  await expect(box).toContainText('4 files');
  await expect(box).toContainText('A copy is made in this browser; nothing is sent back.');
  const skipped=box.locator('.open-link-report');
  for(const [reason,path]of [['Git LFS pointer','data/scan.pdf'],['Larger than 16 MiB','data/huge.bin'],['Symbolic link','current.tex'],['Git submodule','vendor/style']])await expect(skipped.locator('li',{hasText:reason})).toContainText(path);
  expect(fakes.gh.api.log.map(entry=>entry.method+' '+entry.url)).toEqual([`GET /repos/octo/paper/commits/HEAD`,`GET /repos/octo/paper/git/trees/${commit}?recursive=1`]);
  const axeReady=await new AxeBuilder({page}).include('dialog').analyze();expect(axeReady.violations).toEqual([]);
  await shoot(page,'open-link-ready',box);
  // A synthetic click (as a hostile script would send) imports nothing.
  await page.evaluate(()=>[...document.querySelectorAll('dialog button')].find(button=>button.textContent==='Import and compile').click());
  await page.waitForTimeout(300);await expect(box).toBeVisible();expect(fakes.gh.raw.log.filter(entry=>!entry.url.endsWith('/.gitattributes'))).toEqual([]);
  await page.evaluate(()=>window.scribyra.lastCompile=null);
  await importAndWait(page,'Import and compile');
  await expect.poll(()=>page.evaluate(()=>window.scribyra.lastCompile),{timeout:180000}).toBeTruthy();
  expect((await page.evaluate(()=>window.scribyra.lastCompile)).success).toBe(true);
  await expect(page.locator('#pdf-viewer canvas').first()).toBeVisible();
  expect(await project(page)).toEqual({name:'paper · paper',main:'main.tex',paths:['figure.png','main.tex','sections/intro.tex']});
  await expect(notice(page)).toContainText('Imported 3 files from github.com/octo/paper');
  await expect(notice(page)).toContainText('notes.tex (Not valid UTF-8 text, skipped)');
  const meta=(await storedMeta(page)).find(item=>item.name==='paper · paper');
  expect(meta.importSource).toEqual({version:1,kind:'github',host:'github.com',repo:'octo/paper',url:'',ref:'',commit,path:'paper',main:'main.tex',archiveSha256:'',importedAt:meta.importSource.importedAt});
  expect(meta.texLinkOrigin).toBeUndefined();
  // Requests: simple CORS GETs, no cookies, no referrer, no credentials, no preflight.
  for(const entry of fakes.all()){expect(entry.method).toBe('GET');expect(entry.headers.cookie).toBeUndefined();expect(entry.headers.referer).toBeUndefined();expect(entry.headers.authorization).toBeUndefined();}
  expect(fakes.gh.raw.log.map(entry=>entry.url).sort()).toEqual([`/octo/paper/${commit}/.gitattributes`,...['figure.png','main.tex','notes.tex','sections/intro.tex'].map(path=>`/octo/paper/${commit}/paper/${path}`)].sort());
  // Opening the same link again offers the existing copy, without contacting GitHub.
  const before=fakes.all().length;
  await page.getByRole('button',{name:'All projects',exact:true}).click();
  await page.evaluate(()=>{location.hash='#open?repo=https://github.com/Octo/Paper.git&path=paper';});
  await expect(box).toContainText('You already imported this repository into “paper · paper”');
  await shoot(page,'open-link-existing',box);
  await box.getByRole('button',{name:'Open existing copy',exact:true}).click();
  await expect(page.getByRole('textbox',{name:'LaTeX source',exact:true})).toBeVisible();
  expect((await project(page)).name).toBe('paper · paper');expect(fakes.all().length).toBe(before);
  // Import again makes a second, separate copy.
  await openLink(page,'#open?repo=github.com/octo/paper&path=paper');
  await box.getByRole('button',{name:'Import again',exact:true}).click();
  await expect(box.getByRole('button',{name:'Import',exact:true})).toBeVisible({timeout:60000});
  await importAndWait(page);
  expect((await storedMeta(page)).filter(item=>item.importSource?.repo==='octo/paper').length).toBe(2);
  expect(fakes.outside).toEqual([]);
 }finally{await fakes.close();}
});

test('ref, path, main and name variants for GitHub, gitlab.com, self-hosted GitLab and ZIP links',async({page})=>{
 const archive=zipSync({'paper-1.2/':new Uint8Array(),'paper-1.2/tex/paper.tex':strToU8(ROOT.replace('Other root','From a ZIP')),'paper-1.2/tex/extra.tex':strToU8(ROOT),'paper-1.2/README':strToU8('readme')});
 const fakes=await forges(page,{files:host=>host.add('/dl/paper.zip',archive)});
 try{
  await openLink(page,'#open?repo=github.com/octo/paper&ref=v1&main=other.tex&name=Tagged%20copy');
  await expect(dialog(page)).toContainText('v1');await expect(dialog(page)).toContainText('other.tex');
  await check(page);await expect(dialog(page)).toContainText('3 files');await expect(dialog(page).locator('.open-link-skipped')).toHaveCount(0);
  await importAndWait(page);
  expect(await project(page)).toEqual({name:'Tagged copy',main:'other.tex',paths:['figure.png','main.tex','other.tex']});
  expect(fakes.gh.api.log.map(entry=>entry.url)[0]).toBe('/repos/octo/paper/commits/v1');

  await openLink(page,'#open?repo=gitlab.com/group/sub/thesis&ref=dev&path=src');
  await expect(dialog(page)).toContainText('GitLab');await expect(dialog(page).getByRole('link',{name:/gitlab\.com\/group\/sub\/thesis/})).toHaveAttribute('href','https://gitlab.com/group/sub/thesis/-/tree/dev/src');
  await check(page);
  const report=dialog(page).locator('.open-link-report');
  await expect(report.locator('li',{hasText:'export-ignore'})).toContainText('drafts/old.tex');
  await expect(report.locator('li',{hasText:'Symbolic link'})).toContainText('link.tex');
  await expect(report.locator('li',{hasText:'Git submodule'})).toContainText('vendor/cls');
  await importAndWait(page);
  expect(await project(page)).toEqual({name:'thesis · src',main:'thesis.tex',paths:['chapters/one.tex','figures/plot.tex','thesis.tex']});
  const gitlabCalls=fakes.gl.requests().map(entry=>decodeURIComponent(new URL(entry.url,'http://x').pathname));
  expect(gitlabCalls).toEqual(['/api/v4/projects/group/sub/thesis','/api/v4/projects/group/sub/thesis/repository/commits/dev','/api/v4/projects/group/sub/thesis/repository/tree','/api/v4/projects/group/sub/thesis/repository/archive.zip']);

  await openLink(page,'#open?repo=https://gitlab.example.org/team/report');
  await expect(dialog(page)).toContainText('GitLab at gitlab.example.org');
  await check(page);await importAndWait(page);
  expect(await project(page)).toEqual({name:'report',main:'report.tex',paths:['img/figure.png','report.tex']});
  expect(fakes.own.requests().length).toBeGreaterThan(0);

  await openLink(page,'#open?zip=https://files.example.org/dl/paper.zip&path=tex&main=paper.tex');
  await expect(dialog(page).getByRole('heading',{name:'Open a ZIP file in Scribyra'})).toBeVisible();
  await check(page,'Check ZIP file');await expect(dialog(page)).toContainText('2 files');
  await importAndWait(page);
  expect(await project(page)).toEqual({name:'paper',main:'paper.tex',paths:['extra.tex','paper.tex']});
  const zipMeta=(await storedMeta(page)).find(item=>item.importSource?.kind==='zip').importSource;
  expect(zipMeta.url).toBe('https://files.example.org/dl/paper.zip');expect(zipMeta.archiveSha256).toMatch(/^[0-9a-f]{64}$/);
  expect(fakes.outside).toEqual([]);
 }finally{await fakes.close();}
});

test('rate limits, missing or private sources, CORS refusals and invalid links are explained; nothing is imported',async({page})=>{
 const fakes=await forges(page,{github:{used:60,resetIn:1500},gitlab:{throttleAfter:1},files:host=>host.add('/nocors.zip',zipSync({'a.tex':strToU8(ROOT)}),{cors:false})});
 try{
  await openLink(page,'#open?repo=github.com/octo/paper');
  await dialog(page).getByRole('button',{name:'Check repository',exact:true}).click();
  const status=dialog(page).locator('.open-link-status');
  await expect(status).toContainText('GitHub allows 60 requests an hour from your network without signing in');
  await expect(status).toContainText(/Try again after .+ \(in about 2[45] minutes\)/);
  await expect(dialog(page).getByRole('button',{name:'Try again',exact:true})).toBeVisible();
  await shoot(page,'open-link-rate-limit',dialog(page));
  // Once GitHub allows requests again, Try again works without reopening the link.
  fakes.gh.state.used=0;await dialog(page).getByRole('button',{name:'Try again',exact:true}).click();
  await expect(dialog(page).getByRole('button',{name:'Import',exact:true})).toBeVisible();
  await dialog(page).getByRole('button',{name:'Cancel',exact:true}).click();await expect(dialog(page)).toHaveCount(0);

  await openLink(page,'#open?repo=github.com/octo/private-paper');await dialog(page).getByRole('button',{name:'Check repository',exact:true}).click();
  await expect(status).toContainText('It may be private: Scribyra opens public repositories only');
  await expect(dialog(page).getByRole('button',{name:'Try again',exact:true})).toHaveCount(0);await dialog(page).getByRole('button',{name:'Close',exact:true}).click();

  await openLink(page,'#open?repo=github.com/octo/paper&ref=no-such-branch');await dialog(page).getByRole('button',{name:'Check repository',exact:true}).click();
  await expect(status).toContainText('no branch, tag or commit “no-such-branch”');await dialog(page).getByRole('button',{name:'Close',exact:true}).click();

  await openLink(page,'#open?repo=github.com/octo/paper&path=missing');await dialog(page).getByRole('button',{name:'Check repository',exact:true}).click();
  await expect(status).toContainText('The folder “missing” does not exist');await dialog(page).getByRole('button',{name:'Close',exact:true}).click();

  await openLink(page,'#open?repo=gitlab.com/group/sub/thesis');await dialog(page).getByRole('button',{name:'Check repository',exact:true}).click();
  await expect(status).toContainText('gitlab.com is limiting requests from your network');await dialog(page).getByRole('button',{name:'Close',exact:true}).click();

  await openLink(page,'#open?zip=https://files.example.org/nocors.zip');await dialog(page).getByRole('button',{name:'Check ZIP file',exact:true}).click();
  await expect(status).toContainText('Scribyra could not reach files.example.org');await dialog(page).getByRole('button',{name:'Close',exact:true}).click();

  for(const [fragment,message]of [['#open?repo=https://192.168.1.20/a/b','IP address'],['#open?repo=github.com/octo/paper&compile=1','does not know'],['#open?repo=github.com/octo/paper&path=../../etc','not a safe relative path'],['#open?zip=http://files.example.org/a.zip','https://']]){
   await openLink(page,fragment);
   await expect(dialog(page).getByRole('heading',{name:'This link cannot be opened'})).toBeVisible();
   await expect(dialog(page).getByRole('alert')).toContainText(message);
   await dialog(page).getByRole('button',{name:'Close',exact:true}).click();
  }
  expect((await storedMeta(page)).length).toBe(0);
  expect(fakes.outside).toEqual([]);
 }finally{await fakes.close();}
});

test('hostile archive entries are refused with a report; a ZIP bomb is refused before import',async({page})=>{
 // Names keep their length so the archive stays well-formed after rewriting.
 const forge=(bytes,rename,links=[])=>{
  const copy=bytes.slice(),view=new DataView(copy.buffer);
  for(let i=0;i+4<=copy.length;i++){
   const sig=view.getUint32(i,true);if(sig!==0x02014b50&&sig!==0x04034b50)continue;
   const central=sig===0x02014b50,at=i+(central?46:30),length=view.getUint16(i+(central?28:26),true),name=new TextDecoder().decode(copy.subarray(at,at+length));
   if(rename[name])copy.set(strToU8(rename[name]),at);
   if(central&&links.includes(rename[name]||name)){view.setUint16(i+4,(3<<8)|20,true);view.setUint32(i+38,(0o120777<<16)>>>0,true);}
  }
  return copy;
 };
 const hostile=forge(zipSync({'main.tex':strToU8(ROOT),'xx/evil.tex':strToU8('x'),'abs_name.tex':strToU8('y'),'gitx/config':strToU8('[core]'),'link.tex':strToU8('/etc/passwd'),'win\\path.tex':strToU8('w'),'ok/figure.png':FIGURE}),{'xx/evil.tex':'../evil.tex','abs_name.tex':'/etc/hosts12','gitx/config':'.git/config'},['link.tex']);
 // A bomb: 4 MiB of zeros that declares 512 bytes, so planning sees a tiny file.
 const bomb=(()=>{const bytes=zipSync({'main.tex':strToU8(ROOT),'bomb.tex':strToU8('0'.repeat(4*MiB))}),view=new DataView(bytes.buffer);for(let i=0;i+4<=bytes.length;i++){const sig=view.getUint32(i,true);if(sig!==0x02014b50&&sig!==0x04034b50)continue;const central=sig===0x02014b50,at=i+(central?46:30),length=view.getUint16(i+(central?28:26),true);if(new TextDecoder().decode(bytes.subarray(at,at+length))==='bomb.tex')view.setUint32(i+(central?24:22),512,true);}return bytes;})();
 const fakes=await forges(page,{files:host=>host.add('/hostile.zip',hostile).add('/bomb.zip',bomb)});
 try{
  await openLink(page,'#open?zip=https://files.example.org/hostile.zip');await check(page,'Check ZIP file');
  const report=dialog(page).locator('.open-link-report');
  const refused=report.locator('li',{hasText:'Unsafe or invalid name, refused'});
  for(const name of ['../evil.tex','/etc/hosts12','win\\path.tex'])await expect(refused).toContainText(name);
  await expect(report.locator('li',{hasText:'Git metadata'})).toContainText('.git/config');
  await expect(report.locator('li',{hasText:'Symbolic link'})).toContainText('link.tex');
  await expect(dialog(page)).toContainText('2 files');
  await shoot(page,'open-link-refused',dialog(page));
  await importAndWait(page);
  expect(await project(page)).toEqual({name:'hostile',main:'main.tex',paths:['main.tex','ok/figure.png']});

  await openLink(page,'#open?zip=https://files.example.org/bomb.zip');
  await dialog(page).getByRole('button',{name:'Check ZIP file',exact:true}).click();
  await expect(dialog(page).locator('.open-link-status')).toContainText('expands beyond its declared size');
  await expect(dialog(page)).toContainText('Nothing was imported.');
  await dialog(page).getByRole('button',{name:'Close',exact:true}).click();
  expect((await storedMeta(page)).length).toBe(1);
  expect(fakes.outside).toEqual([]);
 }finally{await fakes.close();}
});

test('the generator page builds working links, snippets and badges',async({page,baseURL,browserName,context})=>{
 const directory=resolve('site'),types={'.html':'text/html','.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml','.png':'image/png'};
 const server=http.createServer(async(req,res)=>{try{const path=resolve(directory,'.'+decodeURIComponent(new URL(req.url,'http://x').pathname));if(!path.startsWith(directory+sep)){res.writeHead(403).end();return;}const data=await readFile(path);res.writeHead(200,{'Content-Type':types[extname(path)]||'application/octet-stream'});res.end(data);}catch{res.writeHead(404).end();}});
 await new Promise(done=>server.listen(0,'127.0.0.1',done));const site=`http://127.0.0.1:${server.address().port}/`;
 if(browserName==='chromium')await context.grantPermissions(['clipboard-read','clipboard-write'],{origin:site});
 const fakes=await forges(page);
 try{
  const sent=[];page.on('request',request=>{if(!request.url().startsWith(site))sent.push(request.url());});
  await page.goto(site+'open.html');
  await expect(page.getByRole('heading',{name:'A button that opens your paper'})).toBeVisible();
  const source=page.getByLabel('Repository or ZIP address');
  await source.fill('http://github.com/octo/paper');await expect(page.getByRole('status')).toContainText('https');
  await source.fill('https://github.com/octo/paper/tree/v1');
  await expect(page.getByLabel('Branch, tag or commit')).toHaveValue('v1');
  await page.getByLabel('Main file').fill('other.tex');await page.getByLabel('Project name').fill('Paper & notes');
  const link='https://app.scribyra.com/#open?repo=github.com/octo/paper&ref=v1&main=other.tex&name=Paper%20%26%20notes';
  await expect(page.getByLabel('Link',{exact:true})).toHaveValue(link);
  await expect(page.getByLabel('Markdown (README.md)')).toHaveValue(`[![Open in Scribyra](https://scribyra.com/badge.svg)](${link})`);
  await expect(page.getByLabel('HTML',{exact:true})).toHaveValue(`<a href="${link.replaceAll('&','&amp;')}"><img src="https://scribyra.com/badge.svg" alt="Open in Scribyra" height="28"></a>`);
  await expect(page.getByLabel('reStructuredText (README.rst)')).toHaveValue(`.. image:: https://scribyra.com/badge.svg\n   :target: ${link}\n   :alt: Open in Scribyra`);
  await page.getByRole('button',{name:'Copy Markdown',exact:true}).click();
  await expect(page.getByRole('status')).toContainText(/Markdown copied|Select the text/);
  if(browserName==='chromium')expect(await page.evaluate(()=>navigator.clipboard.readText())).toContain(link);
  const badge=page.getByRole('link',{name:'Open in Scribyra'});await expect(badge).toHaveAttribute('href',link);
  for(const [label,file]of [['Dark','badge-dark.svg'],['Flat','badges/flat.svg'],['Flat square','badges/flat-square.svg'],['For the badge','badges/for-the-badge.svg'],['Light','badge.svg']]){
   await page.getByLabel('Badge').selectOption({label});
   await expect(page.getByRole('img',{name:'Open in Scribyra'})).toHaveAttribute('src',file);
   await expect.poll(()=>page.getByRole('img',{name:'Open in Scribyra'}).evaluate(image=>image.complete&&image.naturalWidth)).toBeGreaterThan(100);
  }
  // The shared site header's brand link has a known name mismatch on every site page; this checks the generator itself.
  const axe=await new AxeBuilder({page}).include('main').analyze();expect(axe.violations).toEqual([]);
  if(shots){mkdirSync(shots,{recursive:true});await page.evaluate(()=>document.activeElement?.blur());await page.screenshot({path:`${shots}/open-generator-${browserName}.png`,fullPage:true});await page.setViewportSize({width:390,height:900});await page.screenshot({path:`${shots}/open-generator-narrow-${browserName}.png`,fullPage:true});await page.setViewportSize({width:1440,height:1000});}
  // Badges render on light and dark pages.
  if(shots)for(const [background,name]of [['#ffffff','light'],['#0d1117','dark']]){
   await page.setContent(`<body style="margin:0;padding:16px;background:${background};display:inline-flex;gap:16px;align-items:center;zoom:2">${['badge.svg','badge-dark.svg','badges/flat.svg','badges/flat-square.svg','badges/for-the-badge.svg'].map(file=>`<img src="${site}${file}" alt="Open in Scribyra">`).join('')}</body>`);
   await page.waitForFunction(()=>[...document.images].every(image=>image.complete&&image.naturalWidth>0));
   await page.locator('body').screenshot({path:`${shots}/open-badges-${name}-${browserName}.png`});
  }
  expect(sent).toEqual([]);
  // The generated link works in the app (served here from the test origin).
  await page.goto(link.replace('https://app.scribyra.com/',baseURL+'/'));
  await expect(dialog(page)).toContainText('v1');await check(page);await importAndWait(page);
  expect(await project(page)).toEqual({name:'Paper & notes',main:'other.tex',paths:['figure.png','main.tex','other.tex']});
  expect(fakes.outside).toEqual([]);
 }finally{await fakes.close();await new Promise(done=>server.close(done));}
});
