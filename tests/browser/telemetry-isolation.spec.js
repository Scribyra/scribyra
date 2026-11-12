import {test,expect} from '@playwright/test';
import {createServer} from 'node:http';
import {randomBytes} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {zipSync,strToU8,unzipSync,strFromU8} from 'fflate';
import {localCollector} from '../helpers/telemetry-local.mjs';

test.use({trace:'off',screenshot:'off',video:'off'});
const source='\\documentclass{article}\n\\begin{document}PrivateIsolationPaper\\end{document}';
const open=async page=>{if(await page.getByRole('button',{name:'More tools',exact:true}).isVisible())await page.getByRole('button',{name:'More tools',exact:true}).click();await page.getByRole('button',{name:'Diagnostics',exact:true}).click();return page.getByRole('dialog',{name:'Local diagnostics'});};
async function replace(page,text){const source=page.getByRole('textbox',{name:'LaTeX source',exact:true});await source.click();await expect(source).toBeFocused();await page.keyboard.press('Control+A');await source.pressSequentially(text);await expect(source.locator('.cm-line')).toHaveText(text.split('\n'));}
async function compile(page){await page.evaluate(()=>window.scribyra.lastCompile=null);await page.getByRole('button',{name:'Compile',exact:true}).click();await expect.poll(()=>page.evaluate(()=>window.scribyra.lastCompile?.success),{timeout:180000}).toBe(true);await expect(page.locator('#pdf-viewer canvas').first()).toBeVisible();}
async function exported(page){const pending=page.waitForEvent('download');await page.getByRole('button',{name:'Export',exact:true}).click();return unzipSync(await readFile(await(await pending).path()));}
async function faultServer(origin,mode){
 let posts=0;const sockets=new Set(),token=randomBytes(32).toString('hex');
 const server=createServer((request,response)=>{
  response.setHeader('Access-Control-Allow-Origin',origin);response.setHeader('Access-Control-Allow-Headers','authorization,content-type');response.setHeader('Access-Control-Allow-Methods','POST,OPTIONS');
  if(request.method==='OPTIONS'){response.writeHead(204);response.end();return;}
  posts++;request.resume();if(mode==='rejecting'){response.writeHead(403);response.end();}
  // Slow mode never acknowledges. The real exporter must enforce its deadline.
 });
 server.on('connection',socket=>{sockets.add(socket);socket.on('close',()=>sockets.delete(socket));});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 return{url:`http://127.0.0.1:${server.address().port}/v1/events`,token,posts:()=>posts,close:async()=>{for(const socket of sockets)socket.destroy();await new Promise(resolve=>server.close(resolve));}};
}
for(const mode of ['disabled','stopped','slow','rejecting'])test(`${mode} collection preserves saves, cancellation, recovery and offline cache`,async({page,context,baseURL})=>{
 let collector,closed=false,peer;let attempts=0;
 try{
  collector=mode==='stopped'?await localCollector(new URL(baseURL).origin):await faultServer(new URL(baseURL).origin,mode);
  page.on('request',request=>{if(request.url()===collector.url&&request.method()==='POST')attempts++;});
  await page.goto('/');const chooser=page.waitForEvent('filechooser');await page.getByRole('button',{name:'Import ZIP',exact:true}).click();await(await chooser).setFiles({name:'isolation.zip',mimeType:'application/zip',buffer:Buffer.from(zipSync({'main.tex':strToU8(source),'assets/private.bin':new Uint8Array([12,34,56])}))});await expect(page.locator('.cm-content')).toBeVisible();
  const connect=async()=>{const d=await open(page);await d.getByLabel('Collect local diagnostics').check();await d.getByLabel('Telemetry endpoint',{exact:true}).fill(collector.url);await d.getByLabel('Ingest token',{exact:true}).fill(collector.token);await d.getByLabel('Remote sampling',{exact:true}).selectOption('1');await d.getByLabel('Activity source',{exact:true}).selectOption('local_test');await d.getByRole('button',{name:'Connect telemetry host',exact:true}).click();await d.getByRole('button',{name:'Close',exact:true}).click();};
  if(mode!=='disabled')await connect();
  await replace(page,source+'\n% DurableBeforeFailure');await expect(page.locator('.save-indicator')).toHaveText('Saved locally');
  if(mode==='stopped'){await expect.poll(async()=>/scribyra_ingress_events_total [1-9]/.test(await collector.metrics()),{timeout:15000}).toBe(true);await collector.close();closed=true;}
  await compile(page);
  if(mode!=='disabled'){
   await expect.poll(()=>attempts).toBeGreaterThan(0);const d=await open(page);await expect(d.getByText(mode==='rejecting'?/Destination rejected/:/Destination unavailable/)).toBeVisible({timeout:20000});await d.getByRole('button',{name:'Close',exact:true}).click();
  }
  // Fail a real IndexedDB transaction, then retry through the ordinary save path.
  await page.evaluate(()=>{const put=IDBObjectStore.prototype.put;window.restoreIsolationStorage=()=>IDBObjectStore.prototype.put=put;IDBObjectStore.prototype.put=function(...args){if(this.name==='heads')throw new DOMException('PrivateQuotaFailure','QuotaExceededError');return put.apply(this,args);};});
  await replace(page,source+'\n% UnsavedDuringQuota');await expect(page.locator('.save-indicator')).toHaveText('Not saved · export a backup');
  expect(strFromU8((await exported(page))['main.tex'])).toContain('UnsavedDuringQuota');
  await page.evaluate(()=>window.restoreIsolationStorage());await replace(page,source+'\n% DurableAfterQuota');await expect(page.locator('.save-indicator')).toHaveText('Saved locally');
  await replace(page,'\\documentclass{article}\n\\begin{document}\\loop\\iftrue\\repeat\\end{document}');await page.getByRole('button',{name:'Compile',exact:true}).click();await expect(page.locator('.editor-status')).toContainText('Compiling on your device');await page.getByRole('button',{name:/^Cancel/}).click();await expect(page.locator('.editor-status')).toContainText('Compilation cancelled');
  await replace(page,source+'\n% DurableAfterCancellation');await expect(page.locator('.save-indicator')).toHaveText('Saved locally');await compile(page);
  await page.getByRole('button',{name:'More tools',exact:true}).click();await page.getByRole('button',{name:'TeX environment',exact:true}).click();const environment=page.getByRole('dialog',{name:'TeX environment',exact:true});await environment.getByRole('button',{name:'Prepare this project for offline use',exact:true}).click();await expect(environment.getByText('Verified offline for this locked environment.',{exact:true})).toBeVisible();await environment.getByRole('button',{name:'Close',exact:true}).click();await expect(page.locator('.save-indicator')).toHaveText('Saved locally');
  // Peer deletion exercises the delivered independent recovery-copy path.
  const before=await exported(page);peer=await context.newPage();await peer.goto(baseURL);await peer.getByRole('button',{name:'Project actions',exact:true}).click();await peer.getByRole('menuitem',{name:'Delete project',exact:true}).click();await peer.getByRole('button',{name:'Delete project',exact:true}).click();await expect(page.getByRole('button',{name:'Save recovered copy',exact:true})).toBeVisible();await page.getByRole('button',{name:'Save recovered copy',exact:true}).click();await expect(page.getByRole('status',{name:'Workspace notification',exact:true})).toContainText('Recovered copy saved');await expect(page.locator('.save-indicator')).toHaveText('Saved locally');expect(await exported(page)).toEqual(before);await peer.close();peer=null;
  await page.waitForFunction(()=>navigator.serviceWorker.controller);await context.setOffline(true);await page.reload();await page.locator('.card-open').first().click();expect(await exported(page)).toEqual(before);
  // Remote settings are intentionally tab-scoped: reselect the failed destination
  // so offline compilation also runs with export enabled after the reload.
  if(mode!=='disabled')await connect();
  await replace(page,source+'\n% DurableOffline');await expect(page.locator('.save-indicator')).toHaveText('Saved locally');await compile(page);
  const d=await open(page);await d.getByLabel('Allow reviewed diagnostic export').check();const reviewed=await d.getByLabel('Diagnostic export preview').textContent();expect(reviewed).not.toMatch(/PrivateIsolationPaper|PrivateQuotaFailure|main.tex|private.bin/);expect(!reviewed.includes(collector.token)&&!reviewed.includes(collector.url)).toBe(true);
  const pending=page.waitForEvent('download');await d.getByRole('button',{name:'Export preview',exact:true}).click();expect(await readFile(await(await pending).path(),'utf8')).toBe(reviewed);if(mode==='disabled'){expect(JSON.parse(reviewed).events).toEqual([]);expect(attempts).toBe(0);}await d.getByRole('button',{name:'Close',exact:true}).click();
  await page.reload();await page.locator('.card-open').first().click();expect(strFromU8((await exported(page))['main.tex'])).toContain('DurableOffline');
 }finally{await context.setOffline(false);await peer?.close();if(collector&&!closed)await collector.close();}
});
