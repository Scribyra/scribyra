import {test,expect} from '@playwright/test';
import {gzipSync} from 'node:zlib';
import {readFile} from 'node:fs/promises';
import {createTexLink} from '../../docs/reorientation/tex-link.mjs';

test.use({actionTimeout:15000});
const source=String.raw`\documentclass{article}
% TEX_LINK_PRIVATE_MARKER café 🌍
\begin{document}
Hello from a link. See \ref{missing-label}.
\end{document}`;
const banner=page=>page.getByRole('region',{name:'TeX link',exact:true});
const appLink=(baseURL,text=source)=>createTexLink(text,`${baseURL}/`);
async function opened(page){await expect(page.getByRole('textbox',{name:'LaTeX source',exact:true})).toBeVisible();await expect(banner(page)).toContainText('Nothing has compiled');await expect(page).toHaveURL(/\/$/);}
async function latest(page){return page.evaluate(()=>window.scribyra.agent.status().value.latestJobId);}
async function finished(page,jobId){
 let result;await expect.poll(async()=>{result=await page.evaluate(jobId=>window.scribyra.agent.poll({jobId,waitMs:25000}),jobId);return result.value.status;},{timeout:180000,intervals:[100]}).not.toBe('running');
 return result;
}
async function allow(page){
 const previous=await latest(page);
 await banner(page).getByRole('button',{name:'Allow and compile',exact:true}).click();
 await expect.poll(()=>latest(page)).not.toBe(previous);
 const jobId=await latest(page);expect(jobId).toBeTruthy();return finished(page,jobId);
}
async function records(page){return page.evaluate(async()=>{
 const db=await new Promise((resolve,reject)=>{const request=indexedDB.open('scribyra-v1');request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);});
 try{return await new Promise((resolve,reject)=>{const request=db.transaction('projects').objectStore('projects').getAll();request.onsuccess=()=>resolve(request.result.map(record=>({...record,update:Array.from(record.update)})));request.onerror=()=>reject(request.error);});}finally{db.close();}
});}
async function instrument(page){
 await page.addInitScript(()=>{
  localStorage.setItem('scribyra:diagnostics:v1',JSON.stringify({collect:true,allowExport:true}));
  window.compilerMessages=[];
  const Original=window.Worker;
  window.Worker=class extends Original{
   constructor(url,options){super(url,options);if(String(url).includes('busytex_worker')){
    const send=this.postMessage;this.postMessage=function(data,...args){
     window.compilerMessages.push({compile:!!data.files,shellEscape:data.shell_escape===true,shellHandler:!!data.load_shell_handler_script});return send.call(this,data,...args);
    };
   }}
  };
 });
}
test('link requires consent, compiles in the worker, returns compact results and downloads PDF without retaining the fragment',async({page,baseURL})=>{
 await instrument(page);const requests=[],logs=[],errors=[];
 page.on('request',request=>requests.push(JSON.stringify({url:request.url(),headers:request.headers(),body:request.postData()})));
 page.on('console',message=>logs.push(message.text()));page.on('pageerror',error=>errors.push(error.message));
 const link=appLink(baseURL),fragment=new URL(link).hash;
 await page.goto(link);await opened(page);expect(await latest(page)).toBeNull();expect(await page.evaluate(()=>window.scribyra.lastCompile)).toBeNull();
 await page.evaluate(()=>{const button=document.querySelector('.tex-link-banner button');button.click();button.dispatchEvent(new MouseEvent('click',{bubbles:true}));});
 await expect(banner(page)).toContainText('Nothing has compiled');expect(await latest(page)).toBeNull();expect(await page.evaluate(()=>window.compilerMessages)).toEqual([]);
 const blocked=await page.evaluate(()=>window.scribyra.agent.compile());const denied=await finished(page,blocked.value.jobId);
 expect(denied.value.error.code).toBe('permission_denied');
 await page.keyboard.press('Control+Enter');expect(await page.evaluate(()=>window.compilerMessages)).toEqual([]);
 const result=await allow(page);expect(result.value.status,JSON.stringify(result)).toBe('succeeded');expect(result.value.pages).toBe(1);expect(result.value.warnings).toBeGreaterThan(0);
 expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(650);
 const diagnostics=await page.evaluate(jobId=>window.scribyra.agent.diagnostics({jobId,limit:3}),result.value.jobId);
 expect(diagnostics.value.items.length).toBeGreaterThan(0);expect(diagnostics.value.items.length).toBeLessThanOrEqual(3);expect(diagnostics.value.items.some(issue=>issue.severity==='warning')).toBe(true);
 const pending=page.waitForEvent('download'),receipt=await page.evaluate(()=>window.scribyra.agent.exportPdf()),download=await pending;
 expect(receipt.value.download).toBe(true);expect(receipt.value.mimeType).toBe('application/pdf');expect(receipt.value).not.toHaveProperty('bytes');expect(receipt.value).not.toHaveProperty('base64');
 expect((await readFile(await download.path())).subarray(0,5).toString()).toBe('%PDF-');
 const messages=await page.evaluate(()=>window.compilerMessages);expect(messages.some(message=>message.compile)).toBe(true);expect(messages.every(message=>!message.shellEscape&&!message.shellHandler)).toBe(true);
 if(await page.getByRole('button',{name:'More tools',exact:true}).isVisible())await page.getByRole('button',{name:'More tools',exact:true}).click();await page.getByRole('button',{name:'Diagnostics',exact:true}).click();const dialog=page.getByRole('dialog',{name:'Local diagnostics'});
 const timeline=await dialog.getByLabel('Diagnostic export preview').textContent();expect(JSON.parse(timeline).events.length).toBeGreaterThan(0);expect(timeline).not.toContain('TEX_LINK_PRIVATE_MARKER');expect(timeline).not.toContain(fragment.slice(5));
 await dialog.getByRole('button',{name:'Close',exact:true}).click();await expect(page.locator('.save-indicator')).toHaveText('Saved locally');
 const leaks=await page.evaluate(async fragment=>{
  const encoded=fragment.slice(5),leaks=[];
  function check(value,where){
   if(typeof value==='string'){if(value.includes(fragment)||value.includes(encoded))leaks.push(where);}
   else if(value instanceof ArrayBuffer||ArrayBuffer.isView(value))check(new TextDecoder().decode(value),where);
   else if(value&&typeof value==='object')for(const [key,item]of Object.entries(value)){check(key,where);check(item,where);}
  }
  check(history.state,'history');
  for(const store of [localStorage,sessionStorage])for(let i=0;i<store.length;i++){const key=store.key(i);check(key,'web storage');check(store.getItem(key),'web storage');}
  for(const {name}of await indexedDB.databases()){
   const db=await new Promise((resolve,reject)=>{const request=indexedDB.open(name);request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);});
   for(const name of db.objectStoreNames)await new Promise((resolve,reject)=>{const request=db.transaction(name).objectStore(name).openCursor();request.onsuccess=()=>{const cursor=request.result;if(!cursor){resolve();return;}check(cursor.key,name);check(cursor.value,name);cursor.continue();};request.onerror=()=>reject(request.error);});
   db.close();
  }
  for(const name of await caches.keys())for(const request of await(await caches.open(name)).keys())check(request.url,'cache key');
  return leaks;
 },fragment);
 expect(leaks).toEqual([]);expect([...requests,...logs,...errors].join('\n')).not.toContain(fragment.slice(5));expect(errors).toEqual([]);
});

test('an already open project and its auto-compile preference remain untouched; only accepted links persist',async({page,baseURL})=>{
 await page.goto('/');await page.getByRole('button',{name:'Start with a sample paper',exact:true}).click();await expect(page.locator('.cm-content')).toBeVisible();
 await page.getByRole('button',{name:'Compile options',exact:true}).click();await page.getByRole('checkbox',{name:'Auto',exact:true}).check();await expect(page.locator('.save-indicator')).toHaveText('Saved locally');
 const before=await records(page);expect(before).toHaveLength(1);
 await page.goto(`${baseURL}/#tex=broken`);await expect(banner(page)).toContainText('Invalid');expect(await records(page)).toEqual(before);
 await expect(page).toHaveTitle('A space for your next great idea — Scribyra');
 await page.goto(appLink(baseURL));await opened(page);
 expect(await records(page)).toEqual(before);const firstMain=await page.evaluate(()=>window.scribyra.agent.status().value.mainFile);
 expect(JSON.parse(await page.evaluate(id=>localStorage.getItem(`scribyra:workspace:${id}`),before[0].id)).auto).toBe(true);
 await page.goto(appLink(baseURL));await expect.poll(()=>page.evaluate(()=>window.scribyra.agent.status().value.mainFile)).not.toBe(firstMain);await opened(page);expect(await records(page)).toEqual(before);
 expect(await page.evaluate(()=>window.scribyra.agent.status().value.mainFile)).not.toBe(firstMain);
 const tree=await page.evaluate(()=>window.scribyra.agent.readTree());expect(tree.value.items.map(file=>file.path)).toEqual(['main.tex']);
 expect(await latest(page)).toBeNull();expect(await page.evaluate(()=>window.scribyra.lastCompile)).toBeNull();
 expect((await allow(page)).value.status).toBe('succeeded');
 const accepted=await records(page);expect(accepted).toHaveLength(2);expect(accepted.find(record=>record.id===before[0].id)).toEqual(before[0]);
 await page.reload();await page.getByRole('button',{name:/TeX link scratch.*1 file/}).first().click();await opened(page);
 expect((await records(page)).map(record=>record.id).sort()).toEqual(accepted.map(record=>record.id).sort());
 const blocked=await page.evaluate(()=>window.scribyra.agent.compile());expect((await finished(page,blocked.value.jobId)).value.error.code).toBe('permission_denied');
});

test('five unapproved visits leave zero stored projects, checkpoints or preferences, including edits and abandonment',async({page,baseURL})=>{
 await instrument(page);
 for(let visit=0;visit<5;visit++){
  await page.goto(appLink(baseURL,source.replace('Hello from a link.',`Unapproved visit ${visit}.`)));await opened(page);
  await expect(page.locator('.cm-content')).toContainText(`Unapproved visit ${visit}.`);
  const edited=await page.evaluate(()=>{const agent=window.scribyra.agent;return agent.patchSource({expectedRevision:agent.status().revision,edits:[{path:'main.tex',find:'See',replace:'Still see'}]});});expect(edited.ok).toBe(true);
  await page.getByRole('button',{name:'Compile options',exact:true}).click();await page.getByRole('checkbox',{name:'Auto',exact:true}).check();await page.keyboard.press('Escape');
  await expect(page.locator('.save-indicator')).toHaveText('In memory · accept TeX link to save');
  expect(await page.evaluate(()=>window.compilerMessages)).toEqual([]);expect(await page.evaluate(()=>window.scribyra.lastCompile)).toBeNull();
  if(visit%2===0)await page.evaluate(()=>window.scribyra.action('home'));
  expect(await records(page)).toEqual([]);
 }
 await page.goto('/');
 const stored=await page.evaluate(async()=>{
  const db=await new Promise((resolve,reject)=>{const request=indexedDB.open('scribyra-v1');request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);});
  try{
   const counts={};for(const name of db.objectStoreNames)counts[name]=await new Promise((resolve,reject)=>{const request=db.transaction(name).objectStore(name).count();request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);});
   return{counts,keys:Object.keys(localStorage).filter(key=>/^scribyra:(workspace:|tex-link:|author$)/.test(key))};
  }finally{db.close();}
 });
 expect(Object.values(stored.counts).every(count=>count===0),JSON.stringify(stored)).toBe(true);expect(stored.keys).toEqual([]);
});

test('failed acceptance keeps the scratch in memory and compilation blocked until saving can be retried',async({page,baseURL})=>{
 await page.goto(appLink(baseURL));await opened(page);
 await page.evaluate(()=>{const put=IDBObjectStore.prototype.put;window.restoreLinkStorage=()=>{IDBObjectStore.prototype.put=put;};IDBObjectStore.prototype.put=function(...args){if(this.name==='projects')throw new DOMException('Test disk full','QuotaExceededError');return put.apply(this,args);};});
 await banner(page).getByRole('button',{name:'Allow and compile',exact:true}).click();await expect(banner(page)).toContainText('Could not save');
 expect(await records(page)).toEqual([]);expect(await latest(page)).toBeNull();
 const blocked=await page.evaluate(()=>window.scribyra.agent.compile());expect((await finished(page,blocked.value.jobId)).value.error.code).toBe('permission_denied');
 await page.evaluate(()=>window.restoreLinkStorage());expect((await allow(page)).value.status).toBe('succeeded');expect(await records(page)).toHaveLength(1);
 expect(await page.evaluate(()=>JSON.parse(localStorage.getItem('scribyra:author'))?.id)).toMatch(/^[0-9a-f-]{36}$/);
});

test('recovered TeX link descendants retain provenance and require fresh consent',async({page,baseURL})=>{
 await page.goto(appLink(baseURL));await opened(page);
 for(let generation=0;generation<2;generation++){
  await page.evaluate(()=>window.scribyra.action('recover-project'));await opened(page);
  const blocked=await page.evaluate(()=>window.scribyra.agent.compile());expect((await finished(page,blocked.value.jobId)).value.error.code).toBe('permission_denied');
  expect(await records(page)).toEqual([]);
 }
 expect((await allow(page)).value.status).toBe('succeeded');expect(await records(page)).toHaveLength(1);
 await page.evaluate(()=>window.scribyra.action('recover-project'));await opened(page);
 expect(await records(page)).toHaveLength(1);
 const blocked=await page.evaluate(()=>window.scribyra.agent.compile());expect((await finished(page,blocked.value.jobId)).value.error.code).toBe('permission_denied');
});

test('a warmed app opens a new link and compiles fully offline after consent',async({page,context,baseURL})=>{
 await page.goto(appLink(baseURL));await opened(page);expect((await allow(page)).value.status).toBe('succeeded');
 await page.waitForFunction(()=>navigator.serviceWorker.controller);await context.setOffline(true);
 try{
  await page.goto('about:blank');await page.goto(appLink(baseURL,source.replace('Hello from a link.','Offline link.')));await opened(page);
  const result=await allow(page);expect(result.value.status,JSON.stringify(result)).toBe('succeeded');expect(result.value.pages).toBe(1);
 }finally{await context.setOffline(false);}
});

test('malformed base64, oversized links, expansion bombs and filename parameters fail without creating projects',async({page,baseURL})=>{
 const gzip=bytes=>gzipSync(bytes).toString('base64url');
 const cases=[['A','Invalid'],['AB','Invalid'],['AA=','Invalid'],['AAAA','Invalid'],['not+base64','Invalid'],[gzip(Buffer.from([0xff])),'Invalid'],[gzip('a\0b'),'Invalid'],['x'.repeat(16385),'too big'],[gzip('x'.repeat(8*1024*1024)),'too big'],[new URL(appLink(baseURL)).hash.slice(5)+'&filename=../../escape.tex','Invalid']];
 for(const [encoded,message]of cases){
  await page.goto(`${baseURL}/#tex=${encoded}`);await expect(page).toHaveURL(/\/$/);await expect(banner(page)).toContainText(message);
  expect(await records(page)).toEqual([]);expect(await page.evaluate(()=>window.scribyra.lastCompile)).toBeNull();
 }
});

test('untrusted TeX cannot execute a shell or write outside its worker project; a later link still compiles',async({page,baseURL})=>{
 const hostile=String.raw`\documentclass{article}
\begin{document}
\immediate\write18{echo compromised > shell-escape.txt}
\IfFileExists{shell-escape.txt}{\errmessage{Shell escape was enabled}}{}
\directlua{if status.shell_escape ~= 0 then tex.error('Shell escape enabled') end}
\newwrite\probe
\immediate\openout\probe=../../outside.txt
\immediate\write\probe{blocked}
\immediate\closeout\probe
\end{document}`;
 await page.goto(appLink(baseURL,hostile));await opened(page);const failed=await allow(page);expect(failed.value.status).toBe('failed');
 const log=await page.evaluate(()=>window.scribyra.lastCompile.log);expect(log).toContain("I can't write on file");expect(log).not.toContain('Shell escape enabled');expect(log).not.toContain('Shell escape was enabled');
 await page.goto(appLink(baseURL));await opened(page);expect((await allow(page)).value.status).toBe('succeeded');
});
