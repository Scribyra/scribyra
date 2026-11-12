import {test,expect} from '@playwright/test';
import {createServer} from 'node:http';
import {readFile,readdir} from 'node:fs/promises';
import {join,extname} from 'node:path';
import {zipSync,strToU8} from 'fflate';
import {openComments} from './review-ui.js';
test.use({actionTimeout:15000});
// A disposable loopback host that "deploys" build B over build A: a new release.json, a
// byte-changed service worker and a marked index.html, as a Pages deployment changes them.
async function releaseHost(){
 const root='dist',types={'.js':'application/javascript','.wasm':'application/wasm','.json':'application/json','.html':'text/html','.css':'text/css','.svg':'image/svg+xml','.png':'image/png','.md':'text/markdown'};
 const bundle=(await Promise.all((await readdir(join(root,'assets'))).filter(name=>name.endsWith('.js')).map(name=>readFile(join(root,'assets',name),'utf8')))).join('\n');
 const revision=/\bversion:"[^"]+",revision:"([a-f0-9]{40})",dirty:/.exec(bundle)?.[1]||null;
 const worker=await readFile(join(root,'sw.js'),'utf8'),index=await readFile(join(root,'index.html'),'utf8');
 const overrides=new Map(),requests=[],sockets=new Set();let offline=false;
 function deploy(number,{own=false,changeWorker=true}={}){
  overrides.set('/release.json',JSON.stringify({version:'0.1.0',revision:own?revision:number.toString(16).padStart(40,'0'),pipeline:null,release:`web-${number}`,builtAt:new Date().toISOString(),appUrl:'/'}));
  if(changeWorker){overrides.set('/sw.js',`${worker}\n// deployment web-${number}\n`);overrides.set('/index.html',index.replace('<head>',`<head>\n<meta name="scribyra-test-deployment" content="web-${number}">`));}
 }
 const server=createServer(async(req,res)=>{
  if(offline){req.socket.destroy();return;}
  let path=new URL(req.url,'http://127.0.0.1').pathname;if(path.endsWith('/'))path+='index.html';requests.push({path,credentials:!!req.headers.cookie});
  try{
   const body=overrides.get(path)??await readFile(join(root,path.replace(/^\/+/,'')));
   res.writeHead(200,{'Content-Type':types[extname(path)]||'application/octet-stream','Cache-Control':'no-store','Connection':'close'}).end(body);
  }catch{res.writeHead(404).end();}
 });
 server.on('connection',socket=>{sockets.add(socket);socket.on('close',()=>sockets.delete(socket));});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 return{url:`http://127.0.0.1:${server.address().port}/`,revision,requests,deploy,setOffline(value){offline=value;if(value)for(const socket of sockets)socket.destroy();},async close(){for(const socket of sockets)socket.destroy();await new Promise(resolve=>server.close(resolve));}};
}
const main=String.raw`\documentclass{article}\begin{document}alpha selected omega.\end{document}`;
const notice=page=>page.getByRole('complementary',{name:'Update available',exact:true});
const saved=page=>expect(page.locator('.save-indicator')).toHaveText('Saved locally');
// Focus checks are at most one per 10 s; wait past that before each new focus.
async function focusAfterGap(page){await page.waitForTimeout(10500);await page.evaluate(()=>window.dispatchEvent(new Event('focus')));}
async function stillHidden(page){await page.waitForTimeout(1500);await expect(notice(page)).toHaveCount(0);}
async function imported(page,url){
 await page.goto(url);const chooser=page.waitForEvent('filechooser');await page.getByRole('button',{name:'Import ZIP',exact:true}).click();
 await(await chooser).setFiles({name:'update-notice.zip',mimeType:'application/zip',buffer:Buffer.from(zipSync({'main.tex':strToU8(main)}))});
 await expect(page.locator('.cm-content')).toBeVisible();await page.waitForFunction(()=>navigator.serviceWorker.controller);
}
async function insert(page,text){await page.locator('.cm-content').click();await page.keyboard.press('Control+Home');await page.keyboard.insertText(text+'\n');}
async function second(context,url){const peer=await context.newPage();await peer.goto(url);await peer.locator('.card-open').first().click();await expect(peer.locator('.cm-content')).toBeVisible();return peer;}

test('an open tab learns of a newer release quietly, reloads into it with edits saved, and other tabs keep working',async({page,context})=>{
 const host=await releaseHost();test.skip(!host.revision,'The build carries no Git revision to identify its own release.');
 try{
  host.deploy(100,{own:true});await imported(page,host.url);const peer=await second(context,host.url);
  // This local build embeds no release name; each tab learns its own from a first check.
  await peer.evaluate(()=>window.dispatchEvent(new Event('focus')));
  try{
   // The running release, an unchanged redeploy of it, and an older release never show it.
   await focusAfterGap(page);await stillHidden(page);
   host.deploy(100,{own:true,changeWorker:false});await focusAfterGap(page);await stillHidden(page);
   host.deploy(99);await focusAfterGap(page);await stillHidden(page);
   // Offline, a deployment can't be seen and nothing complains.
   host.deploy(101);await context.setOffline(true);host.setOffline(true);
   try{await focusAfterGap(page);await stillHidden(page);await expect(page.getByRole('status',{name:'Workspace notification',exact:true})).toHaveCount(0);}
   finally{host.setOffline(false);await context.setOffline(false);}
   // Back online, focus finds build B. The notice is polite and leaves focus in the editor.
   await page.locator('.cm-content').click();await focusAfterGap(page);
   const shown=notice(page);await expect(shown).toBeVisible();await expect(shown.getByRole('status').first()).toHaveText('A new version of Scribyra is ready');
   await expect(shown.getByRole('status').first()).toHaveAttribute('aria-live','polite');
   expect(await page.evaluate(()=>document.activeElement?.closest('.cm-editor')!==null)).toBe(true);
   for(const name of ['Reload','Dismiss update notice']){const button=shown.getByRole('button',{name,exact:true});await button.focus();await expect(button).toBeFocused();}
   expect(host.requests.filter(request=>request.path==='/release.json').every(request=>!request.credentials)).toBe(true);
   // Each tab shows its own notice.
   await peer.evaluate(()=>window.dispatchEvent(new Event('focus')));await expect(notice(peer)).toBeVisible();
   // Reload commits the pending edit first; it has not been saved yet when Reload is chosen.
   await insert(page,'% typed just before the update');
   await shown.getByRole('button',{name:'Reload',exact:true}).click();
   await expect(page.locator('meta[name=scribyra-test-deployment]')).toHaveAttribute('content','web-101',{timeout:60000});
   await expect(page.locator('.cm-content')).toContainText('% typed just before the update');await expect(page.locator('.cm-content')).toContainText('alpha selected omega.');
   await saved(page);await focusAfterGap(page);await stillHidden(page);
   // The tab that did not reload still edits, saves and syncs with the reloaded one.
   await expect(peer.locator('.cm-content')).toContainText('% typed just before the update');
   await insert(peer,'% from the older tab');await saved(peer);await expect(page.locator('.cm-content')).toContainText('% from the older tab');
   // Dismissal holds for this release and gives way to a still newer one.
   await notice(peer).getByRole('button',{name:'Dismiss update notice',exact:true}).click();await expect(notice(peer)).toHaveCount(0);
   await focusAfterGap(peer);await stillHidden(peer);
   host.deploy(102);await focusAfterGap(peer);await expect(notice(peer)).toBeVisible();
  }finally{await peer.close();}
 }finally{await host.close();}
});

test('a failed save keeps the tab open, and an unsent comment draft is kept across the update reload',async({page})=>{
 const host=await releaseHost();test.skip(!host.revision,'The build carries no Git revision to identify its own release.');
 try{
  host.deploy(200,{own:true});await imported(page,host.url);await page.evaluate(()=>window.dispatchEvent(new Event('focus')));await page.waitForTimeout(1000);host.deploy(201);await focusAfterGap(page);await expect(notice(page)).toBeVisible();
  // Local storage refuses the write: no reload, and the reason is given.
  await page.evaluate(()=>{window.__put=IDBObjectStore.prototype.put;IDBObjectStore.prototype.put=function(){throw new DOMException('The quota has been exceeded.','QuotaExceededError');};});
  await insert(page,'% must not be lost');
  await notice(page).getByRole('button',{name:'Reload',exact:true}).click();
  await expect(notice(page)).toContainText(/Not reloaded\. Local save failed \(QuotaExceededError\)/);
  await expect(page.locator('meta[name=scribyra-test-deployment]')).toHaveAttribute('content','web-200');await expect(page.locator('.save-indicator')).toHaveText('Not saved · export a backup');await expect(page.locator('.cm-content')).toContainText('% must not be lost');
  await page.evaluate(()=>{IDBObjectStore.prototype.put=window.__put;});
  // An unsent comment draft survives; the notice says so before reloading.
  await page.evaluate(({start,end})=>{const view=document.querySelector('.cm-content').cmTile.root.view;view.dispatch({selection:{anchor:start,head:end}});view.focus();},{start:main.indexOf('selected'),end:main.indexOf('selected')+8});
  await openComments(page);await page.getByRole('button',{name:'Comment on selection',exact:true}).click();
  const text='Unsent comment across the update';await page.getByRole('textbox',{name:'Comment body',exact:true}).fill(text);
  await notice(page).getByRole('button',{name:'Reload',exact:true}).click();
  await expect(notice(page)).toContainText('unsent comment draft is kept on this device');
  await expect(page.locator('meta[name=scribyra-test-deployment]')).toHaveAttribute('content','web-201',{timeout:60000});
  await expect(page.locator('.cm-content')).toContainText('% must not be lost');
  await openComments(page);await expect(page.getByRole('textbox',{name:'Comment body',exact:true})).toHaveValue(text);
 }finally{await host.close();}
});
