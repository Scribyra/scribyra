// Bibliography import and Zotero links in all three engines, against the fake Zotero
// Web API (tests/helpers/fake-zotero.mjs). The app's code addresses https://api.zotero.org;
// an init script sends those requests on to the fake on 127.0.0.1, so the browser makes
// real cross-origin requests with CORS preflights. Nothing contacts the real Zotero.
import {test,expect} from '@playwright/test';
import {zipSync,unzipSync,strToU8} from 'fflate';
import {mkdirSync} from 'node:fs';
import {readFile} from 'node:fs/promises';
import AxeBuilder from '@axe-core/playwright';
import {fakeZotero} from '../helpers/fake-zotero.mjs';
test.use({actionTimeout:15000});
test.setTimeout(180000);

const KEY='Zk7Q2mN8pR4sT6vW9xY3aB5c',USER=4242,shots=process.env.SCRIBYRA_SCREENSHOTS;
const MAIN=String.raw`\documentclass{article}
\usepackage[backend=biber]{biblatex}
\addbibresource{zotero.bib}
\begin{document}
Classic results \cite{lovelace_sketch_1843} and \parencite{hopper_compiler_1952}.
\printbibliography
\end{document}
`;
const article=(title,last,first,year,extra={})=>({itemType:'journalArticle',title,creators:[{creatorType:'author',lastName:last,firstName:first}],date:String(year),publicationTitle:'Annals of Computing',...extra});
function seed(options){
  const fake=fakeZotero(options);
  fake.addUser({id:USER,username:'ada'}).addGroup({id:777,name:'Compiler Lab',members:[USER]});
  fake.addKey(KEY,{userId:USER,access:{user:{library:true,notes:false,write:false,files:false},groups:{all:{library:true,write:false}}}});
  fake.collection(`users/${USER}`,{key:'THESIS01',name:'Thesis'}).collection(`users/${USER}`,{key:'CHAPTER2',name:'Chapter 2',parent:'THESIS01'});
  fake.write(`users/${USER}`,[
    {key:'LOVE0001',collections:['THESIS01'],data:article('Sketch of the Analytical Engine','Lovelace','Ada',1843)},
    {key:'HOPP0002',collections:['THESIS01'],data:article('The Education of a Computer','Hopper','Grace',1952)},
    {key:'TURI0003',collections:['THESIS01'],data:article('On Computable Numbers','Turing','Alan',1936)},
    {key:'NOTE0004',collections:['THESIS01'],data:{itemType:'note',note:'reading notes'}},
    {key:'OTHR0005',data:article('Outside the collection','Shannon','Claude',1948)},
  ]);
  return fake;
}
async function start(page,fake){
  const server=await fake.listen(0);
  await page.addInitScript(port=>{
    const original=window.fetch.bind(window);window.__zoteroCalls=[];
    window.fetch=(input,options)=>{const url=input instanceof Request?input.url:String(input);if(url.startsWith('https://api.zotero.org/')){window.__zoteroCalls.push(url);return original(url.replace('https://api.zotero.org',`http://127.0.0.1:${port}`),options);}return original(input,options);};
  },server.port);
  // Every request the page makes, and which carried the key.
  const seen=[];page.on('request',request=>{seen.push({url:request.url(),key:request.headers()['zotero-api-key']||null});});
  return {server,seen};
}
async function open(page,files={'main.tex':MAIN}){
  await page.goto('/');const chooser=page.waitForEvent('filechooser');await page.getByRole('button',{name:'Import ZIP',exact:true}).click();
  await (await chooser).setFiles({name:'zotero-paper.zip',mimeType:'application/zip',buffer:Buffer.from(zipSync(Object.fromEntries(Object.entries(files).map(([path,text])=>[path,strToU8(text)]))))});
  await expect(page.locator('.cm-content')).toBeVisible();
}
const notice=page=>page.getByRole('status',{name:'Workspace notification',exact:true});
const source=(page,path)=>page.evaluate(path=>window.scribyra.agent.readSource({path,startLine:1,endLine:200}).value?.content??null,path);
const keys=text=>[...text.matchAll(/@\w+\{([^,]+),/g)].map(match=>match[1]);
async function rootMenu(page,item){await page.locator('.tree-root').click({button:'right'});await page.getByRole('menuitem',{name:new RegExp(`^${item}`)}).click();}
async function shoot(page,name,locator){
  if(!shots)return;mkdirSync(shots,{recursive:true});const engine=test.info().project.name;
  if(locator)await locator.evaluate(node=>{node.scrollTop=0;});
  for(const theme of ['light','dark']){await page.evaluate(theme=>{document.documentElement.dataset.theme=theme;},theme);await page.waitForTimeout(150);await (locator||page).screenshot({path:`${shots}/${name}-${theme}-${engine}.png`});}
  await page.evaluate(()=>{document.documentElement.dataset.theme='light';});
}
async function link(page,{collection='Thesis',library='My Library',format,screenshot=false}={}){
  await rootMenu(page,'Link to Zotero');
  const dialog=page.getByRole('dialog',{name:'Link to Zotero'});await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('link',{name:'zotero.org/settings/keys'})).toHaveAttribute('href','https://www.zotero.org/settings/keys');
  await expect(dialog).toContainText('tick only “Allow library access”');await expect(dialog).toContainText('sent only to api.zotero.org');
  await expect(dialog.getByRole('button',{name:'Link and import'})).toBeDisabled();
  await dialog.getByLabel('Zotero user ID or username').fill('ada');await dialog.getByLabel('Read-only API key').fill(KEY);
  await dialog.getByRole('button',{name:'Check key'}).click();
  await expect(dialog.getByRole('status')).toContainText('Key for “ada” (user 4242) can read 2 libraries.');
  await expect(dialog.getByLabel('Collection')).toContainText('Thesis › Chapter 2');
  await dialog.getByLabel('Library').selectOption({label:library});
  if(collection)await dialog.getByLabel('Collection').selectOption({label:collection});
  if(format)await dialog.getByLabel('Format').selectOption(format);
  await expect(dialog.getByLabel('Read-only API key')).toHaveValue('');
  if(screenshot){await shoot(page,'zotero-link-dialog',dialog);const axe=await new AxeBuilder({page}).include('.zotero-link').analyze();expect(axe.violations.map(v=>v.id)).toEqual([]);}
  await dialog.getByRole('button',{name:'Link and import'}).click();
  await expect(dialog).toBeHidden();
}
/** Everything the project can leave this device as, and every store except the device-local Zotero one. */
async function projectTraces(page){
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
const downloaded=async download=>new Uint8Array(await readFile(await download.path()));
function containsKey(bytes){const text=new TextDecoder('latin1').decode(bytes);if(text.includes(KEY))return true;try{return Object.values(unzipSync(bytes)).some(entry=>new TextDecoder('latin1').decode(entry).includes(KEY));}catch{return false;}}

test('link a collection: initial fetch, linked file, autocomplete, and the key never leaves this device',async({page,context})=>{
  const fake=seed(),{server,seen}=await start(page,fake),errors=[];page.on('pageerror',error=>errors.push(error.message));
  try{
    await open(page);await link(page,{screenshot:true});
    await expect(notice(page)).toContainText('Linked zotero.bib to Zotero (My Library › Thesis): 3 entries. The key is saved only on this device.');
    const text=await source(page,'zotero.bib');
    expect(keys(text)).toEqual(['hopper_education_1952','lovelace_sketch_1843','turing_computable_1936']);
    expect(text).toMatch(/^% Linked to Zotero: My Library › Thesis\./);expect(text).toContain('journaltitle = {Annals of Computing}');expect(text).not.toContain('Shannon');
    // The linked file is open, with its Zotero bar.
    const bar=page.getByRole('group',{name:'Zotero link'});await expect(bar).toContainText('Linked to Zotero · My Library › Thesis · refreshed');
    await expect(page.getByRole('tab',{selected:true})).toHaveText('zotero.bib');
    await shoot(page,'zotero-linked-file');
    // \cite{ completion offers linked entries with author, year and title.
    await page.getByRole('treeitem',{name:'main.tex',exact:true}).click();await page.locator('.cm-content').click();await page.keyboard.press('Control+End');
    await page.keyboard.type('\\cite{tur',{delay:30});
    const option=page.locator('.cm-tooltip-autocomplete').getByRole('option').filter({hasText:'turing_computable_1936'});
    await expect(option).toContainText('Turing, 1936');await expect(option).toContainText('On Computable Numbers');await expect(option).toContainText('zotero.bib');
    await page.keyboard.press('Escape');
    // Requests went only to api.zotero.org (the fake), through real CORS preflights.
    const zotero=await page.evaluate(()=>window.__zoteroCalls);
    expect(zotero.length).toBeGreaterThan(3);for(const url of zotero)expect(url).toMatch(/^https:\/\/api\.zotero\.org\//);
    // Real cross-origin requests: each carries the page's Origin and the browser checks the CORS
    // response. Chromium and Firefox preflight the custom headers; Playwright's WebKit does not
    // send its preflight to the server (recorded in docs/zotero.md).
    expect(fake.requests.filter(request=>request.method==='GET').every(request=>request.origin===new URL(page.url()).origin)).toBe(true);
    if(test.info().project.name!=='webkit')expect(fake.requests.some(request=>request.method==='OPTIONS'&&request.origin)).toBe(true);
    const fakeOrigin=`http://127.0.0.1:${server.port}/`;
    for(const request of seen){expect(request.url.startsWith(fakeOrigin)||request.url.startsWith('http://127.0.0.1:'+new URL(page.url()).port+'/')||request.url.startsWith('blob:')||request.url.startsWith('data:'),request.url).toBe(true);if(request.key)expect(request.url.startsWith(fakeOrigin),request.url).toBe(true);}
    expect(fake.requests.filter(request=>request.method==='GET').every(request=>request.key===KEY)).toBe(true);
    // The key is in the device-local Zotero store and nowhere else: not in project storage,
    // history, localStorage or sessionStorage; not in the source ZIP, the complete backup or diagnostics.
    await page.evaluate(()=>new Promise(resolve=>setTimeout(resolve,600)));
    const traces=await projectTraces(page);
    expect(traces.databases['scribyra-zotero']).toContain(KEY);
    expect(Object.keys(traces.databases)).toContain('scribyra-v1');
    for(const [name,text] of Object.entries(traces.databases))if(name!=='scribyra-zotero')expect(text.includes(KEY),name).toBe(false);
    expect(traces.databases['scribyra-v1']).toContain('lovelace_sketch_1843');
    expect(traces.local.includes(KEY)).toBe(false);expect(traces.session.includes(KEY)).toBe(false);
    expect(await page.evaluate(key=>new Promise(resolve=>{const request=indexedDB.open('scribyra-zotero');request.onsuccess=()=>{const db=request.result;const all=db.transaction('links').objectStore('links').getAll();all.onsuccess=()=>{db.close();resolve(JSON.stringify(all.result).includes(key));};};}),KEY)).toBe(false);
    let download=page.waitForEvent('download');await page.getByRole('button',{name:'Export',exact:true}).click();
    const zip=await downloaded(await download);expect(new TextDecoder().decode(unzipSync(zip)['zotero.bib'])).toBe(text);expect(containsKey(zip)).toBe(false);
    const panel=page.getByRole('region',{name:'Project history',exact:true});
    await page.getByRole('button',{name:'History',exact:true}).click();await panel.getByRole('button',{name:'Manage history',exact:true}).click();
    download=page.waitForEvent('download');await panel.getByRole('button',{name:'Export complete backup',exact:true}).click();
    const backup=await downloaded(await download);expect(backup.length).toBeGreaterThan(100);expect(containsKey(backup)).toBe(false);
    await page.getByRole('button',{name:'History',exact:true}).click();
    await page.evaluate(()=>window.scribyra.action('diagnostics'));const diagnostics=page.getByRole('dialog',{name:'Local diagnostics'});await expect(diagnostics).toBeVisible();
    expect((await diagnostics.textContent()).includes(KEY)).toBe(false);await page.keyboard.press('Escape');
    expect(errors).toEqual([]);
  }finally{await server.close();}
});

test('refresh with Zotero changes and a conflicting local edit: diff, per-entry choices, stable cited keys, removal warnings',async({page})=>{
  const fake=seed(),{server}=await start(page,fake);
  try{
    await open(page);await link(page);
    // A local edit to Lovelace's title.
    await page.evaluate(()=>{const api=window.scribyra.agent,r=api.patchSource({expectedRevision:api.status().revision,edits:[{path:'zotero.bib',find:'title = {Sketch of the Analytical Engine}',replace:'title = {Sketch of the {Analytical Engine}, with notes}'}]});if(!r.ok)throw Error(JSON.stringify(r));});
    // In Zotero: Lovelace's title changes too (a conflict); Hopper's title changes, so Zotero's
    // generated key changes, but hopper_compiler_1952… is cited; Turing is removed; Knuth is added.
    fake.write(`users/${USER}`,[
      {key:'LOVE0001',data:{title:'Sketch of the Analytical Engine Invented by Charles Babbage'}},
      {key:'HOPP0002',data:{title:'The Compiler and its Education'}},
      {key:'KNUT0006',collections:['THESIS01'],data:article('Literate Programming','Knuth','Donald',1984)},
    ]);
    await page.evaluate(()=>{const api=window.scribyra.agent,r=api.patchSource({expectedRevision:api.status().revision,edits:[{path:'main.tex',find:'\\parencite{hopper_compiler_1952}',replace:'\\parencite{hopper_education_1952} and \\cite{turing_computable_1936}'}]});if(!r.ok)throw Error(JSON.stringify(r));});
    fake.write(`users/${USER}`,[{key:'TURI0003',collections:[]}]);
    await page.getByRole('treeitem',{name:'zotero.bib',exact:true}).click();
    await page.getByRole('group',{name:'Zotero link'}).getByRole('button',{name:'Refresh from Zotero'}).click();
    const dialog=page.getByRole('dialog',{name:'Refresh from Zotero'});await expect(dialog).toBeVisible();
    await expect(dialog).toContainText('You edited this file since the last refresh.');
    await expect(dialog).toContainText('Zotero has 1 added, 2 changed, 1 removed; 1 entry was also edited here.');
    const row=key=>dialog.locator(`.zotero-change[data-key="${key}"]`);
    // Conflict first, defaulting to this file's version, with a field-level diff.
    await expect(dialog.locator('.zotero-change').first()).toHaveAttribute('data-key','lovelace_sketch_1843');
    await expect(row('lovelace_sketch_1843')).toContainText('Edited here too');
    await expect(row('lovelace_sketch_1843').getByRole('radio',{name:'Keep this file’s version'})).toBeChecked();
    await expect(row('lovelace_sketch_1843').getByRole('row',{name:/title/})).toContainText('{Sketch of the {Analytical Engine}, with notes}');
    await expect(row('lovelace_sketch_1843').getByRole('row',{name:/title/})).toContainText('{Sketch of the Analytical Engine Invented by Charles Babbage}');
    // Hopper keeps the cited key although Zotero now generates another.
    await expect(row('hopper_education_1952')).toContainText('Zotero now generates “hopper_compiler_1952”; the key stays “hopper_education_1952” because it is cited in main.tex.');
    await expect(row('hopper_education_1952').getByRole('radio',{name:'Use Zotero’s version'})).toBeChecked();
    await expect(row('knuth_literate_1984')).toContainText('Added in Zotero');
    await expect(row('turing_computable_1936')).toContainText('Cited in main.tex');
    await expect(row('turing_computable_1936').getByRole('radio',{name:'Keep it in this file'})).toBeChecked();
    await shoot(page,'zotero-refresh-diff',dialog);
    const axe=await new AxeBuilder({page}).include('.zotero-refresh').analyze();expect(axe.violations.map(v=>v.id)).toEqual([]);
    await row('lovelace_sketch_1843').getByRole('radio',{name:'Use Zotero’s version'}).check();
    await row('turing_computable_1936').getByRole('radio',{name:'Remove it here too'}).check();
    await dialog.getByRole('button',{name:'Apply choices'}).click();await expect(dialog).toBeHidden();
    await expect(notice(page)).toContainText('Refreshed zotero.bib from Zotero: 1 added, 2 changed, 1 removed. Still cited but no longer in any bibliography: turing_computable_1936.');
    const text=await source(page,'zotero.bib');
    expect(keys(text)).toEqual(['hopper_education_1952','lovelace_sketch_1843','knuth_literate_1984']);
    expect(text).toContain('The Compiler and its Education');expect(text).toContain('Invented by Charles Babbage');expect(text).not.toContain('with notes');
    // Repeatable: nothing changed in Zotero, so the next refresh is a conditional 304.
    await page.getByRole('group',{name:'Zotero link'}).getByRole('button',{name:'Refresh from Zotero'}).click();
    await expect(notice(page)).toContainText(`zotero.bib is up to date with Zotero (library version ${fake.version(`users/${USER}`)}).`);
    expect(await source(page,'zotero.bib')).toBe(text);
    // Cancelling a review changes nothing.
    await page.evaluate(()=>{const api=window.scribyra.agent,r=api.patchSource({expectedRevision:api.status().revision,edits:[{path:'zotero.bib',find:'Literate Programming',replace:'Literate Programming (local)'}]});if(!r.ok)throw Error(JSON.stringify(r));});
    fake.write(`users/${USER}`,[{key:'KNUT0006',data:{title:'Literate Programming, 2nd'}}]);
    const before=await source(page,'zotero.bib');
    await page.getByRole('group',{name:'Zotero link'}).getByRole('button',{name:'Refresh from Zotero'}).click();
    await expect(dialog).toBeVisible();await dialog.getByRole('button',{name:'Cancel'}).click();
    await expect(notice(page)).toContainText('Refresh cancelled. Nothing changed.');expect(await source(page,'zotero.bib')).toBe(before);
    // Keep all of this file: the local edit stays and the same Zotero change is not offered again.
    await page.getByRole('group',{name:'Zotero link'}).getByRole('button',{name:'Refresh from Zotero'}).click();
    await dialog.getByRole('button',{name:'Keep all of this file'}).click();await expect(notice(page)).toContainText('1 kept as in this file');
    expect(await source(page,'zotero.bib')).toBe(before);
    await page.getByRole('group',{name:'Zotero link'}).getByRole('button',{name:'Refresh from Zotero'}).click();
    await expect(notice(page)).toContainText('is up to date with Zotero');
  }finally{await server.close();}
});

test('refresh without local edits applies directly; offline refresh says so; Viewing and Reviewing cannot link or refresh',async({page,context})=>{
  const fake=seed(),{server}=await start(page,fake);
  try{
    await open(page);await link(page,{collection:null,format:'bibtex'});
    let text=await source(page,'zotero.bib');expect(keys(text)).toHaveLength(4);expect(text).toContain('journal = {Annals of Computing}');expect(text).toContain('year = {1843}');
    fake.write(`users/${USER}`,[{key:'OTHR0005',data:{publicationTitle:'Bell System Technical Journal'}}]);
    const bar=page.getByRole('group',{name:'Zotero link'});
    await bar.getByRole('button',{name:'Refresh from Zotero'}).click();
    await expect(notice(page)).toContainText('Refreshed zotero.bib from Zotero: 0 added, 1 changed, 0 removed.');
    await expect(page.getByRole('dialog',{name:'Refresh from Zotero'})).toBeHidden();
    text=await source(page,'zotero.bib');expect(text).toContain('Bell System Technical Journal');
    // Offline: no request is made, the file stays usable.
    const requests=fake.requests.length;await context.setOffline(true);
    await bar.getByRole('button',{name:'Refresh from Zotero'}).click();
    await expect(notice(page)).toContainText('Refreshing from Zotero needs a network connection, and this device is offline. The linked file is an ordinary project file');
    expect(fake.requests.length).toBe(requests);expect(await source(page,'zotero.bib')).toBe(text);
    await context.setOffline(false);
    // Rate limits are explained, not retried in a loop.
    fake.write(`users/${USER}`,[{key:'OTHR0005',data:{volume:'27'}}]);fake.limitOnce(20);
    await bar.getByRole('button',{name:'Refresh from Zotero'}).click();await expect(notice(page)).toContainText('Zotero is limiting requests. Try again in 20 s.');
    for(const [mode,reason] of [['viewing','Viewing is read only. Switch to Editing to refresh from Zotero.'],['reviewing','Reviewing records suggestions, and Zotero changes many entries at once. Switch to Editing to refresh from Zotero.']]){
      await page.getByRole('combobox',{name:'Editor mode'}).selectOption(mode);
      await expect(bar.getByRole('button',{name:'Refresh from Zotero'})).toBeDisabled();
      await page.evaluate(()=>window.scribyra.action('zotero-refresh'));await expect(notice(page)).toHaveText(new RegExp(reason.replace(/[.]/g,'\\.')));
      await page.locator('.tree-root').click({button:'right'});const menu=page.getByRole('menu');
      for(const name of ['Import bibliography…','Link to Zotero…'])await expect(menu.getByRole('menuitem',{name:new RegExp(`^${name}`)})).toBeDisabled();
      await page.keyboard.press('Escape');
      await page.evaluate(()=>window.scribyra.action('zotero-link'));await expect(notice(page)).toContainText(mode==='viewing'?'Viewing is read only. Switch to Editing to link Zotero.':'Switch to Editing to link Zotero.');
      await expect(page.getByRole('dialog',{name:'Link to Zotero'})).toBeHidden();
    }
    expect(await source(page,'zotero.bib')).toBe(text);
    await page.getByRole('combobox',{name:'Editor mode'}).selectOption('editing');
  }finally{await server.close();}
});

test('Zotero panel: unlink, remove the key, and refresh asks for a key again',async({page})=>{
  const fake=seed(),{server}=await start(page,fake);
  try{
    await open(page);await link(page);
    await page.getByRole('button',{name:'More tools'}).click();await page.getByRole('button',{name:'Zotero',exact:true}).click();
    const panel=page.getByRole('dialog',{name:'Zotero'});await expect(panel).toContainText('zotero.bib');await expect(panel).toContainText('My Library › Thesis · BibLaTeX');
    await expect(panel).toContainText('Zotero user 4242 (ada)');expect((await panel.textContent()).includes(KEY)).toBe(false);
    await panel.getByRole('button',{name:'Remove key for Zotero user 4242'}).click();
    await expect(panel.getByRole('status')).toContainText('Key removed from this device.');
    await panel.getByRole('button',{name:'Close'}).click();
    const traces=await projectTraces(page);for(const text of Object.values(traces.databases))expect(text.includes(KEY)).toBe(false);
    // Refresh now needs a key; cancelling sends nothing.
    const requests=fake.requests.length;
    await page.getByRole('group',{name:'Zotero link'}).getByRole('button',{name:'Refresh from Zotero'}).click();
    const ask=page.getByRole('dialog',{name:'Zotero API key'});await expect(ask).toContainText('This device has no API key for Zotero user 4242.');
    await ask.getByRole('button',{name:'Cancel'}).click();expect(fake.requests.length).toBe(requests);
    await page.getByRole('group',{name:'Zotero link'}).getByRole('button',{name:'Refresh from Zotero'}).click();
    await ask.getByLabel('Read-only API key').fill(KEY);await ask.getByRole('button',{name:'Save key and refresh'}).click();
    await expect(notice(page)).toContainText('is up to date with Zotero');
    // Unlink: the file stays as an ordinary file.
    const text=await source(page,'zotero.bib');
    await page.getByRole('button',{name:'More tools'}).click();await page.getByRole('button',{name:'Zotero',exact:true}).click();
    await panel.getByRole('button',{name:'Unlink zotero.bib'}).click();await expect(panel.getByRole('status')).toContainText('zotero.bib is no longer linked.');
    await panel.getByRole('button',{name:'Close'}).click();
    await expect(page.getByRole('group',{name:'Zotero link'})).toBeHidden();expect(await source(page,'zotero.bib')).toBe(text);
  }finally{await server.close();}
});

const BROKEN=`@article{smith2020,
  author = {Smith, Jane},
  title = {Fine Entry},
  year = {2020},
}
@article{broken2021,
  title = {Missing comma}
  year = {2021},
}
@book{Müller:Über-2019, title={Kept key}, year=2019}
@article{smith2020, title={Duplicate}}
`;
test('import bibliography from the tree menu and by drag and drop: problems reported, keys kept, names never clash',async({page})=>{
  await open(page);
  let chooser=page.waitForEvent('filechooser');await rootMenu(page,'Import bibliography');
  await (await chooser).setFiles({name:'refs.bib',mimeType:'text/x-bibtex',buffer:Buffer.from(BROKEN)});
  const report=page.getByRole('dialog',{name:'Bibliography check'});await expect(report).toBeVisible();
  await expect(report).toContainText('2 problems BibTeX or Biber will reject or misread');
  await expect(report).toContainText('Line 8: “broken2021”: A comma is missing before field “year”.');
  await expect(report).toContainText('Line 11: Citation key “smith2020” is used again (first on line 1).');
  await expect(report).toContainText('refs.bib · 4 entries readable');
  if(shots)await shoot(page,'bibliography-report',report);
  await report.getByRole('button',{name:'Cancel import'}).click();
  await expect(page.getByRole('treeitem',{name:'refs.bib',exact:true})).toHaveCount(0);
  chooser=page.waitForEvent('filechooser');await rootMenu(page,'Import bibliography');
  await (await chooser).setFiles({name:'refs.bib',mimeType:'text/x-bibtex',buffer:Buffer.from(BROKEN)});
  await report.getByRole('button',{name:'Import anyway'}).click();
  await expect(notice(page)).toContainText('Imported refs.bib with 4 entries; citation keys are unchanged.');
  expect(await source(page,'refs.bib')).toBe(BROKEN);
  // A clean Zotero or Better BibTeX export imports without questions, beside the first.
  chooser=page.waitForEvent('filechooser');await rootMenu(page,'Import bibliography');
  const clean='﻿@comment{Better BibTeX}\n@article{Lovelace1843,\n\ttitle = {Sketch},\n\tauthor = {Lovelace, Ada},\n\tdate = {1843},\n}\n';
  await (await chooser).setFiles({name:'refs.bib',mimeType:'text/x-bibtex',buffer:Buffer.from(clean)});
  await expect(notice(page)).toContainText('A file with that name existed, so it was imported as refs.bib → refs-2.bib.');
  expect(await source(page,'refs-2.bib')).toBe(clean.slice(1));
  await expect(page.getByRole('dialog',{name:'Bibliography check'})).toBeHidden();
  // Dropping a malformed .bib on the tree shows the same report.
  const data=await page.evaluateHandle(text=>{const transfer=new DataTransfer();transfer.items.add(new File([text],'dropped.bib',{type:'text/plain'}));return transfer;},'@article{x, title={Unclosed}\n');
  await page.locator('.file-sidebar').dispatchEvent('drop',{dataTransfer:data});
  await expect(report).toContainText('Entry “x” is not closed');await report.getByRole('button',{name:'Import anyway'}).click();await data.dispose();
  await expect(page.getByRole('treeitem',{name:'dropped.bib',exact:true})).toBeVisible();
  // And \cite{ completes keys from imported files as written.
  await page.getByRole('treeitem',{name:'main.tex',exact:true}).click();await page.locator('.cm-content').click();await page.keyboard.press('Control+End');
  await page.keyboard.type('\\cite{Mü',{delay:30});await expect(page.locator('.cm-tooltip-autocomplete').getByRole('option').filter({hasText:'Müller:Über-2019'})).toContainText('Kept key');
});

test('without the CORS headers api.zotero.org sends, the browser blocks the response and nothing is linked',async({page})=>{
  const fake=seed({cors:false}),{server}=await start(page,fake);
  try{
    await open(page);await rootMenu(page,'Link to Zotero');
    const dialog=page.getByRole('dialog',{name:'Link to Zotero'});
    await dialog.getByLabel('Zotero user ID or username').fill('4242');await dialog.getByLabel('Read-only API key').fill(KEY);
    await dialog.getByRole('button',{name:'Check key'}).click();
    await expect(dialog.getByRole('status')).toHaveText('Scribyra could not reach api.zotero.org. Check your connection and try again; nothing in the project changed.');
    await expect(dialog.getByRole('button',{name:'Link and import'})).toBeDisabled();
    await dialog.getByRole('button',{name:'Cancel'}).click();
    const traces=await projectTraces(page);expect(traces.databases['scribyra-zotero']||'').not.toContain(KEY);
  }finally{await server.close();}
});
