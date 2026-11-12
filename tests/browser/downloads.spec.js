import {test,expect} from '@playwright/test';
import {zipSync,strToU8,unzipSync} from 'fflate';
import {readFile} from 'node:fs/promises';
import {assetServer} from '../helpers/asset-server.mjs';
test.use({actionTimeout:15000});
const main=String.raw`\documentclass{article}\usepackage{xcolor}\begin{document}\textcolor{blue}{Resumable compiler assets.}\end{document}`;
async function importSource(page,url){await page.goto(url);const event=page.waitForEvent('filechooser');await page.getByRole('button',{name:'Import ZIP',exact:true}).click();await(await event).setFiles({name:'resume-paper.zip',mimeType:'application/zip',buffer:Buffer.from(zipSync({'main.tex':strToU8(main)}))});await expect(page.locator('.cm-content')).toBeVisible();}
async function compile(page){await page.evaluate(()=>window.scribyra.lastCompile=null);await page.getByRole('button',{name:'Compile',exact:true}).click();await expect.poll(()=>page.evaluate(()=>window.scribyra.lastCompile),{timeout:180000}).toBeTruthy();return page.evaluate(()=>window.scribyra.lastCompile);}
async function partials(page){return page.evaluate(()=>new Promise((resolve,reject)=>{const open=indexedDB.open('scribyra-tex-packages');open.onerror=()=>reject(open.error);open.onsuccess=()=>{const db=open.result;if(!db.objectStoreNames.contains('partials')){db.close();resolve([]);return;}const request=db.transaction('partials').objectStore('partials').getAll();request.onsuccess=()=>{db.close();resolve(request.result);};request.onerror=()=>{db.close();reject(request.error);};};}));}
for(const mode of ['break','cancel','reload'])test(`${{break:'interrupted',cancel:'cancelled',reload:'reload-interrupted'}[mode]} runtime download resumes after reload and produces a real PDF`,async({page})=>{
 const server=await assetServer();try{
  const fault=server.interrupt(mode==='break'?'break':'hold');await importSource(page,server.url);
  if(mode==='break'){const failed=await compile(page);expect(failed.success).toBeFalsy();}
  else{await page.getByRole('button',{name:'Compile',exact:true}).click();await expect.poll(async()=>(await partials(page)).find(row=>row.label.startsWith('texlive-lualatex.'))?.length||0,{timeout:120000}).toBeGreaterThanOrEqual(1024*1024);if(mode==='reload')await page.reload();else{await page.getByRole('button',{name:'Cancel compilation',exact:true}).click();await expect(page.locator('.editor-status')).toContainText('Compilation cancelled');}}
  await expect.poll(()=>fault.record?.closed,{timeout:30000}).toBeTruthy();await expect.poll(async()=>(await partials(page)).find(row=>row.label.startsWith('texlive-lualatex.'))?.length||0).toBeGreaterThan(0);
  const saved=(await partials(page)).find(row=>row.label.startsWith('texlive-lualatex.'));expect(saved.length).toBeLessThan(saved.size);
  if(mode!=='reload'){await expect(page.locator('.save-indicator')).toHaveText('Saved locally');await page.reload();}await page.getByRole('button',{name:/resume-paper.*files?/}).click();const resumed=await compile(page);expect(resumed.success,resumed.log).toBeTruthy();
  expect(server.records.some(record=>record.path===fault.record.path&&record.range===`bytes=${saved.length}-`&&record.status===206)).toBeTruthy();expect((await partials(page)).some(row=>row.id===saved.id)).toBeFalsy();await expect(page.locator('#pdf-viewer canvas').first()).toBeVisible();
 }finally{await server.close();}
});
test('device cache limits can disable public caches without deleting sources or claiming offline readiness',async({page})=>{
 await importSource(page,'/');const online=await compile(page);expect(online.success,online.log).toBeTruthy();await expect(page.locator('.save-indicator')).toHaveText('Saved locally');await page.getByRole('button',{name:'More tools',exact:true}).click();await page.getByRole('button',{name:'TeX environment',exact:true}).click();const dialog=page.getByRole('dialog',{name:'TeX environment',exact:true});
 await dialog.getByRole('button',{name:'Prepare this project for offline use',exact:true}).click();await expect(dialog.getByText('Verified offline for this locked environment.',{exact:true})).toBeVisible({timeout:120000});
 for(const label of ['Package archives (MiB)','Metadata (MiB)','Compiler runtime (MiB)','Interrupted downloads (MiB)'])await dialog.getByLabel(label,{exact:true}).fill('0');await dialog.getByRole('button',{name:'Apply cache limits',exact:true}).click();await expect(dialog.getByRole('status')).toContainText('Cache limits saved');await expect(dialog.getByText('All cached archives (0)',{exact:true})).toBeVisible();await expect(dialog.getByText('Verified offline for this locked environment.',{exact:true})).toHaveCount(0);await dialog.getByRole('button',{name:'Close',exact:true}).click();
 const uncached=await compile(page);expect(uncached.success,uncached.log).toBeTruthy();expect(uncached.packages.some(pkg=>!pkg.saved)).toBeTruthy();expect(await page.evaluate(async()=>(await(await caches.open('scribyra-runtime-verified-v1')).keys()).length)).toBe(0);
 const event=page.waitForEvent('download');await page.getByRole('button',{name:'Export',exact:true}).click();expect(unzipSync(new Uint8Array(await readFile(await(await event).path())))['main.tex']).toEqual(strToU8(main));await page.reload();await page.getByRole('button',{name:/resume-paper.*files?/}).click();await page.getByRole('button',{name:'More tools',exact:true}).click();await page.getByRole('button',{name:'TeX environment',exact:true}).click();for(const label of ['Package archives (MiB)','Metadata (MiB)','Compiler runtime (MiB)','Interrupted downloads (MiB)'])await expect(dialog.getByLabel(label,{exact:true})).toHaveValue('0');
});
test('component preparation can exceed the compiler execution deadline and still finish the same build',async({page})=>{
 const server=await assetServer();try{
  const fault=server.interrupt('hold');await importSource(page,server.url);await page.clock.install();await page.evaluate(()=>window.scribyra.lastCompile=null);await page.getByRole('button',{name:'Compile',exact:true}).click();
  await expect.poll(async()=>(await partials(page)).find(row=>row.label.startsWith('texlive-lualatex.'))?.length||0,{timeout:120000}).toBeGreaterThanOrEqual(1024*1024);await expect.poll(()=>typeof fault.release).toBe('function');
  await page.clock.fastForward(181000);expect(await page.evaluate(()=>window.scribyra.lastCompile)).toBeNull();await expect(page.getByRole('button',{name:'Cancel compilation',exact:true})).toBeVisible();fault.release();await page.clock.resume();
  await expect.poll(()=>page.evaluate(()=>window.scribyra.lastCompile),{timeout:180000}).toBeTruthy();const result=await page.evaluate(()=>window.scribyra.lastCompile);expect(result.success,result.log).toBeTruthy();await expect(page.locator('#pdf-viewer canvas').first()).toBeVisible();
  const event=page.waitForEvent('download');await page.getByRole('button',{name:'Export',exact:true}).click();expect(unzipSync(new Uint8Array(await readFile(await(await event).path())))['main.tex']).toEqual(strToU8(main));
 }finally{await server.close();}
});
