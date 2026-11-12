import {test,expect} from '@playwright/test';
import {spawn} from 'node:child_process';
import WebSocket from 'ws';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
let server,folder,upstreamAddress;
test.beforeAll(async()=>{
  folder=await mkdtemp(join(tmpdir(),'scribyra-command-sync-'));
  server=spawn('target/debug/examples/plaintext-demo',[],{env:{...process.env,SCRIBYRA_SYNC_DB:join(folder,'sync.sqlite'),SCRIBYRA_SYNC_PORT:'0',SCRIBYRA_CONTAINER:'0'},stdio:['ignore','pipe','pipe']});
  await new Promise((resolve,reject)=>{let output='';const ready=chunk=>{output+=chunk;const address=output.match(/listening on (127\.0\.0\.1:\d+);/);if(address){upstreamAddress=`ws://${address[1]}`;server.stdout.off('data',ready);resolve();}};server.stdout.on('data',ready);server.once('error',reject);server.once('exit',()=>reject(new Error('Sync server did not start.')));});
});
test.afterAll(async()=>{if(server?.exitCode===null){const done=new Promise(resolve=>server.once('exit',resolve));server.kill();await done;}if(folder)await rm(folder,{recursive:true,force:true});});
async function peers(browser,baseURL){
  const ca=await browser.newContext(),cb=await browser.newContext();
  // The plaintext demo is hidden from production UI behind this explicit switch.
  for(const context of [ca,cb])await context.addInitScript(()=>{try{localStorage.setItem('scribyra-plaintext-demo','1');}catch{}});
  // Only the test transport adapts the frozen demo's fixed address/origin. Each
  // fixture owns an ephemeral loopback listener, including during parallel work.
  for(const context of [ca,cb])await context.routeWebSocket('ws://127.0.0.1:8787/rooms/*',route=>{
    const upstream=new WebSocket(route.url().replace('ws://127.0.0.1:8787',upstreamAddress),{origin:'http://127.0.0.1:4173'}),pending=[];
    route.onMessage(message=>{if(upstream.readyState===WebSocket.OPEN)upstream.send(message);else pending.push(message);});
    upstream.on('open',()=>{for(const message of pending)upstream.send(message);pending.length=0;});
    upstream.on('message',(bytes,binary)=>route.send(binary?bytes:bytes.toString()));
    upstream.on('error',()=>route.close({code:1011,reason:'Test sync connection failed'}));
    upstream.on('close',()=>route.close());route.onClose(()=>upstream.close());
  });
  const a=await ca.newPage(),b=await cb.newPage();
  for(const page of [a,b]){await page.goto(baseURL);await page.getByRole('button',{name:'Start with a sample paper'}).click();await expect(page.locator('.cm-content')).toBeVisible();}
  await b.getByRole('button',{name:'File actions',exact:true}).click();await b.getByRole('menuitem',{name:'Delete',exact:true}).click();
  const room=`commands-${Date.now()}`;
  for(const page of [a,b]){await page.getByRole('button',{name:'Sync demo',exact:true}).click();await page.getByRole('textbox',{name:'Local synchronization demo',exact:true}).fill(room);await page.getByRole('button',{name:'Connect demo',exact:true}).click();await expect(page.locator('.editor-status')).toContainText('Demo synchronized');}
  await expect(b.getByRole('treeitem',{name:'main.tex',exact:true})).toBeVisible();return{ca,cb,a,b};
}
test('remote deletion invalidates open settings instead of saving a deleted main file',async({browser,baseURL})=>{
  const {ca,cb,a,b}=await peers(browser,baseURL);
  try{
    const oldEngine=await a.getByLabel('Compiler',{exact:true}).inputValue();
    await a.getByRole('button',{name:'More tools',exact:true}).click();await a.getByRole('button',{name:'Project settings',exact:true}).click();await a.getByLabel('Project name',{exact:true}).fill('Pending stale settings');await a.getByLabel('TeX engine',{exact:true}).selectOption('lualatex');await a.getByLabel('Main file',{exact:true}).selectOption({label:'main.tex'});
    await b.getByRole('button',{name:'File actions',exact:true}).click();await b.getByRole('menuitem',{name:'Delete',exact:true}).click();await expect(a.getByRole('treeitem',{name:'main.tex',exact:true})).toHaveCount(0);
    await a.getByRole('button',{name:'Save settings',exact:true}).click();await expect(a.getByRole('status',{name:'Workspace notification',exact:true})).toContainText('Project changed');await expect(a.getByLabel('Compiler',{exact:true})).toHaveValue(oldEngine);await expect(a.getByRole('button',{name:'Pending stale settings',exact:true})).toHaveCount(0);
    await a.getByRole('button',{name:'More tools',exact:true}).click();await a.getByRole('button',{name:'Project settings',exact:true}).click();await expect(a.getByLabel('Main file',{exact:true}).locator('option')).toHaveCount(1);await expect(a.getByLabel('Main file',{exact:true})).toHaveValue('');await a.getByRole('button',{name:'Cancel',exact:true}).click();
  }finally{await ca.close();await cb.close();}
});
test('folder deletion review preserves files added by another peer while the dialog is open',async({browser,baseURL})=>{
  const {ca,cb,a,b}=await peers(browser,baseURL);
  try{
    await a.getByRole('button',{name:'Add folder',exact:true}).click();await a.getByRole('textbox',{name:'New folder',exact:true}).fill('shared');await a.getByRole('button',{name:'Create folder',exact:true}).click();await expect(b.getByRole('treeitem',{name:'shared',exact:true})).toBeVisible();
    await a.getByRole('button',{name:'Folder actions',exact:true}).click();await a.getByRole('menuitem',{name:'Delete',exact:true}).click();await expect(a.getByRole('dialog')).toContainText('everything inside it');
    await b.getByRole('treeitem',{name:'shared',exact:true}).click();await b.getByRole('button',{name:'Add file',exact:true}).click();await b.getByRole('textbox',{name:'New file',exact:true}).fill('shared/new.tex');await b.getByRole('button',{name:'Create file',exact:true}).click();await expect(a.getByRole('treeitem',{name:'shared/new.tex',exact:true})).toBeVisible();
    await a.getByRole('button',{name:'Delete folder',exact:true}).click();await expect(a.getByRole('status',{name:'Workspace notification',exact:true})).toContainText('Project changed');for(const page of [a,b])await expect(page.getByRole('treeitem',{name:'shared/new.tex',exact:true})).toBeVisible();
  }finally{await ca.close();await cb.close();}
});
