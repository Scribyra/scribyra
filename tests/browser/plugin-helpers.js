// Shared steps for plugin specs: open a project, the Plugins manager, install the
// official Zotero plugin through consent, and serve test plugin packages on loopback.
import {expect} from '@playwright/test';
import {zipSync,strToU8} from 'fflate';
import http from 'node:http';

export const ZOTERO_ID='com.scribyra.zotero';
export async function openProject(page,files,name='plugin-paper.zip'){
  await page.goto('/');const chooser=page.waitForEvent('filechooser');await page.getByRole('button',{name:'Import ZIP',exact:true}).click();
  await (await chooser).setFiles({name,mimeType:'application/zip',buffer:Buffer.from(zipSync(Object.fromEntries(Object.entries(files).map(([path,text])=>[path,strToU8(text)]))))});
  await expect(page.locator('.cm-content')).toBeVisible();
}
export const notice=page=>page.getByRole('status',{name:'Workspace notification',exact:true});
export async function openManager(page){
  await page.getByRole('button',{name:'More tools'}).click();await page.getByRole('button',{name:'Plugins',exact:true}).click();
  const manager=page.getByRole('dialog',{name:'Plugins'});await expect(manager).toBeVisible();return manager;
}
/** Installs the official Zotero plugin through Browse and the consent dialog. */
export async function installZotero(page,{close=true}={}){
  const manager=await openManager(page);
  await manager.getByRole('button',{name:'Browse official plugins'}).click();
  await manager.getByRole('button',{name:'Install Zotero'}).click();
  const consent=page.getByRole('dialog',{name:'Install Zotero?'});await expect(consent).toBeVisible();
  await consent.getByRole('button',{name:'Install',exact:true}).click();
  await expect(manager.getByRole('status')).toContainText('Zotero 1.0.0 installed and enabled.');
  if(close){await manager.getByRole('button',{name:'Close',exact:true}).click();await expect(manager).toBeHidden();}
  return manager;
}
/** Every IndexedDB database's contents as text, plus local and session storage. */
export async function browserTraces(page){
  return page.evaluate(async()=>{
    const decode=async value=>value instanceof Uint8Array||value instanceof ArrayBuffer?new TextDecoder('latin1').decode(value):value instanceof Blob?new TextDecoder('latin1').decode(await value.arrayBuffer()):JSON.stringify(value,(k,v)=>v instanceof Uint8Array?new TextDecoder('latin1').decode(v):v);
    const result={databases:{},local:JSON.stringify({...localStorage}),session:JSON.stringify({...sessionStorage})};
    for(const {name} of await indexedDB.databases()){
      const db=await new Promise((resolve,reject)=>{const request=indexedDB.open(name);request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);});
      let text='';
      for(const store of db.objectStoreNames){const values=await new Promise((resolve,reject)=>{const request=db.transaction(store).objectStore(store).getAll();request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);});for(const value of values)text+=await decode(value);}
      db.close();result.databases[name]=text;
    }
    return result;
  });
}
/** All records of one store in a database, as plain values. */
export function storeRecords(page,database,store){
  return page.evaluate(([database,store])=>new Promise((resolve,reject)=>{const request=indexedDB.open(database);request.onsuccess=()=>{const db=request.result;if(!db.objectStoreNames.contains(store)){db.close();resolve([]);return;}const all=db.transaction(store).objectStore(store).getAll();all.onsuccess=()=>{db.close();resolve(JSON.parse(JSON.stringify(all.result,(k,v)=>v instanceof Uint8Array?`<${v.length} bytes>`:v)));};all.onerror=()=>reject(all.error);};request.onerror=()=>reject(request.error);}),[database,store]);
}
/**
 * A loopback server for test plugin packages and their reports. Packages are served with
 * CORS, as a plugin author's static host would; every request is recorded.
 */
export async function pluginServer(){
  const files=new Map(),requests=[],reports=[];let waiters=[];
  const server=http.createServer((request,response)=>{
    let body='';request.on('data',chunk=>{body+=chunk;});
    request.on('end',()=>{
      requests.push({method:request.method,url:request.url,origin:request.headers.origin||null,cookie:request.headers.cookie||null,referer:request.headers.referer||null,body});
      response.setHeader('Access-Control-Allow-Origin','*');response.setHeader('Access-Control-Allow-Headers','*');response.setHeader('Access-Control-Allow-Methods','GET, POST');
      if(request.method==='OPTIONS'){response.writeHead(204);response.end();return;}
      if(request.url==='/report'&&request.method==='POST'){reports.push(JSON.parse(body));for(const resolve of waiters)resolve();waiters=[];response.writeHead(200,{'Content-Type':'application/json'});response.end('{}');return;}
      const file=files.get(request.url.split('?')[0]);
      if(!file){response.writeHead(404);response.end('missing');return;}
      response.writeHead(200,{'Content-Type':'application/json'});response.end(file);
    });
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const origin=`http://127.0.0.1:${server.address().port}`;
  return {
    origin,requests,reports,
    serve(path,text){files.set(path,text);return origin+path;},
    async nextReport(count=reports.length+1){while(reports.length<count)await new Promise(resolve=>{waiters.push(resolve);});return reports[count-1];},
    close:()=>new Promise(resolve=>{server.closeAllConnections?.();server.close(resolve);}),
  };
}
/** A developer package from a manifest and the plugin's code (a function body using `scribyra`). */
export function pluginPackage(manifest,code){
  return JSON.stringify({format:'scribyra-plugin',formatVersion:1,manifest:{manifestVersion:1,api:1,main:'main.js',publisher:'Test author',...manifest},files:{'main.js':code}});
}
export async function sideload(page,url,{consentName,accept=true}={}){
  const manager=page.getByRole('dialog',{name:'Plugins'});
  const developer=manager.getByRole('switch',{name:'Developer mode'});
  if(!await developer.isChecked()){await developer.check();await expect(manager.getByRole('note').filter({hasText:'Developer mode installs unreviewed code.'})).toBeVisible();}
  await manager.getByLabel('Plugin package URL').fill(url);await manager.getByRole('button',{name:'Install from URL'}).click();
  const consent=page.getByRole('dialog',{name:consentName});await expect(consent).toBeVisible();
  await expect(consent.getByRole('alert')).toContainText('Not reviewed by Scribyra.');
  // accept: true installs, false cancels, null leaves the dialog open for the caller.
  if(accept===true)await consent.getByRole('button',{name:/^(Install|Update)$/}).click();else if(accept===false)await consent.getByRole('button',{name:'Cancel'}).click();
  return consent;
}
