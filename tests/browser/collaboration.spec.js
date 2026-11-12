import { test, expect } from '@playwright/test';
import { spawn } from 'node:child_process';
import WebSocket from 'ws';
import {createServer} from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
let server, folder, upstreamAddress, proxy, proxyAddress;
test.beforeAll(async()=>{
  folder=await mkdtemp(join(tmpdir(),'scribyra-browser-sync-'));
  server=spawn('target/debug/examples/plaintext-demo',[],{env:{...process.env,SCRIBYRA_SYNC_DB:join(folder,'sync.sqlite'),SCRIBYRA_SYNC_PORT:'0',SCRIBYRA_CONTAINER:'0'},stdio:['ignore','pipe','pipe']});
  await new Promise((resolve,reject)=>{let output='';const ready=chunk=>{output+=chunk;const address=output.match(/listening on (127\.0\.0\.1:\d+);/);if(address){upstreamAddress=`http://${address[1]}`;server.stdout.off('data',ready);resolve();}};server.stdout.on('data',ready);server.once('error',reject);server.once('exit',()=>reject(new Error('Sync server did not start.')));});
  proxy=createServer(async(request,response)=>{
    response.setHeader('Access-Control-Allow-Origin',`http://127.0.0.1:${process.env.SCRIBYRA_TEST_PORT||'4173'}`);
    response.setHeader('Access-Control-Allow-Methods','GET,HEAD,PUT,OPTIONS');response.setHeader('Access-Control-Allow-Headers','content-type');
    if(request.method==='OPTIONS'){response.writeHead(204).end();return;}
    try{
      const upstream=await fetch(upstreamAddress+request.url,{method:request.method,headers:{origin:'http://127.0.0.1:4173',...(request.headers['content-type']?{'content-type':request.headers['content-type']}:{})},...(!['GET','HEAD'].includes(request.method)?{body:request,duplex:'half'}:{})});
      for(const name of ['content-type','content-length'])if(upstream.headers.has(name))response.setHeader(name,upstream.headers.get(name));
      response.writeHead(upstream.status);response.end(Buffer.from(await upstream.arrayBuffer()));
    }catch{response.writeHead(502).end();}
  });
  await new Promise(resolve=>proxy.listen(0,'127.0.0.1',resolve));proxyAddress=`http://127.0.0.1:${proxy.address().port}`;
});
test.afterAll(async()=>{if(proxy){proxy.closeAllConnections();await new Promise(resolve=>proxy.close(resolve));}if(server?.exitCode===null){const done=new Promise(r=>server.once('exit',r));server.kill();await done;}if(folder)await rm(folder,{recursive:true,force:true});});
async function transport(context,baseURL){
  // The plaintext demo is hidden from production UI behind this explicit switch.
  await context.addInitScript(()=>{try{localStorage.setItem('scribyra-plaintext-demo','1');}catch{}});
  // The demo's fixed origin policy stays intact; this fixture owns its listener.
  await context.routeWebSocket('ws://127.0.0.1:8787/rooms/*',route=>{
    const upstream=new WebSocket(route.url().replace('ws://127.0.0.1:8787',upstreamAddress.replace('http:','ws:')),{origin:'http://127.0.0.1:4173'}),pending=[];
    route.onMessage(message=>{if(upstream.readyState===WebSocket.OPEN)upstream.send(message);else pending.push(message);});
    upstream.on('open',()=>{for(const message of pending)upstream.send(message);pending.length=0;});
    upstream.on('message',(bytes,binary)=>route.send(binary?bytes:bytes.toString()));
    upstream.on('error',()=>route.close({code:1011,reason:'Test sync connection failed'}));
    upstream.on('close',()=>route.close());route.onClose(()=>upstream.close());
  });
  // WebKit may bypass route interception through a service worker. Keep HTTP real.
  await context.addInitScript(address=>{const original=window.fetch.bind(window);window.fetch=(input,options)=>original(typeof input==='string'&&input.startsWith('http://127.0.0.1:8787/')?input.replace('http://127.0.0.1:8787',address):input,options);},proxyAddress);
}
test('the plaintext demo stays out of production UI without its explicit switch',async({page})=>{
  await page.goto('/');await page.getByRole('button',{name:'Start with a sample paper'}).click();await expect(page.locator('.cm-content')).toBeVisible();
  await expect(page.getByRole('button',{name:'Sync demo',exact:true})).toHaveCount(0);await expect(page.locator('.editor-status')).not.toContainText('Local only');
  await page.evaluate(()=>window.scribyra.action('sync'));await expect(page.getByRole('dialog',{name:'Local synchronization demo',exact:true})).toHaveCount(0);
});
test('two browser profiles exchange source edits and cursors',async({browser,baseURL})=>{
  const ca=await browser.newContext(), cb=await browser.newContext();const a=await ca.newPage(),b=await cb.newPage();
  try{
    for(const context of [ca,cb])await transport(context,baseURL);
    for(const page of [a,b]){await page.goto(baseURL);await page.getByRole('button',{name:'Start with a sample paper'}).click();await expect(page.locator('.cm-content')).toBeVisible();}
    await b.getByRole('button',{name:'File actions',exact:true}).click();await b.getByRole('menuitem',{name:'Delete',exact:true}).click();
    const room=`test-${Date.now()}`;
    for(const page of [a,b]){await page.getByRole('button',{name:'Sync demo',exact:true}).click();await page.getByRole('textbox',{name:'Local synchronization demo',exact:true}).fill(room);await page.getByRole('button',{name:'Connect demo',exact:true}).click();await expect(page.locator('.editor-status')).toContainText('Demo synchronized');}
    await expect(b.locator('.cm-content')).toBeVisible();
    await a.locator('.cm-content').click();await a.keyboard.press('Control+Home');await a.keyboard.insertText('% from-first-profile\n');
    await expect(b.locator('.cm-content')).toContainText('from-first-profile');
    await b.locator('.cm-content').click();await b.keyboard.press('Control+Home');await b.keyboard.insertText('% from-second-profile\n');
    await expect(a.locator('.cm-content')).toContainText('from-second-profile');
    await expect(a.locator('.cm-ySelectionCaret')).toHaveCount(1);await expect(b.locator('.cm-ySelectionCaret')).toHaveCount(1);
    await expect(a.getByRole('button',{name:'2 connected',exact:true})).toBeVisible();
  }finally{await ca.close();await cb.close();}
});

test('binary assets transfer once, replace across profiles, and persist offline',async({browser,baseURL})=>{
  const ca=await browser.newContext(),cb=await browser.newContext(),a=await ca.newPage(),b=await cb.newPage();
  const uploads=[],errors=[];
  for(const page of [a,b]){page.on('pageerror',e=>errors.push(e.message));page.on('request',r=>{if(r.method()==='PUT'&&r.url().includes('/blobs/'))uploads.push(r.url());});}
  const svg=width=>Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="30"><rect width="${width}" height="30" fill="teal"/></svg>`);
  try{
    for(const context of [ca,cb])await transport(context,baseURL);
    for(const page of [a,b]){await page.goto(baseURL);await page.getByRole('button',{name:'Start with a sample paper'}).click();await expect(page.locator('.cm-content')).toBeVisible();}
    await b.getByRole('button',{name:'File actions',exact:true}).click();await b.getByRole('menuitem',{name:'Delete',exact:true}).click();
    let chooser=a.waitForEvent('filechooser');await a.getByRole('button',{name:'Upload files',exact:true}).click();await(await chooser).setFiles({name:'plot.svg',mimeType:'image/svg+xml',buffer:svg(40)});
    await expect(a.locator('.asset-message')).toContainText('40 × 30');
    const room=`assets-${Date.now()}`;
    for(const page of [a,b]){await page.getByRole('button',{name:'Sync demo',exact:true}).click();await page.getByRole('textbox',{name:'Local synchronization demo',exact:true}).fill(room);await page.getByRole('button',{name:'Connect demo',exact:true}).click();await expect(page.locator('.editor-status')).toContainText('Demo synchronized');}
    await b.getByRole('treeitem',{name:'plot.svg',exact:true}).click();await expect(b.locator('.asset-message')).toContainText('40 × 30');
    expect(uploads).toHaveLength(1);
    chooser=b.waitForEvent('filechooser');await b.getByRole('button',{name:'Replace file',exact:true}).click();await(await chooser).setFiles({name:'updated.svg',mimeType:'image/svg+xml',buffer:svg(80)});
    await expect(a.locator('.asset-message')).toContainText('80 × 30');await expect(b.locator('.editor-status')).toContainText('Demo synchronized');
    expect(uploads).toHaveLength(2);
    await a.getByRole('treeitem',{name:'main.tex',exact:true}).click();await a.locator('.cm-content').click();await a.keyboard.press('Control+Home');await a.keyboard.insertText('% no repeated asset upload\n');
    await b.getByRole('treeitem',{name:'main.tex',exact:true}).click();await expect(b.locator('.cm-content')).toContainText('no repeated asset upload');
    await expect(b.locator('.save-indicator')).toHaveText('Saved locally');expect(uploads).toHaveLength(2);
    await b.waitForFunction(()=>navigator.serviceWorker.controller);await ca.close();await cb.setOffline(true);await b.reload();await b.getByRole('button',{name:/A space for your next great idea.*files/}).click();
    await b.getByRole('treeitem',{name:'plot.svg',exact:true}).click();await expect(b.locator('.asset-message')).toContainText('80 × 30');expect(errors).toEqual([]);
  }finally{await ca.close();await cb.close();}
});
