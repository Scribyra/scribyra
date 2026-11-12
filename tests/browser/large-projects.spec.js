// Large-project measurements (docs/large-projects.md). Opt-in: generate the
// projects with `node scripts/large-projects.mjs <dir>` and run
//   SCRIBYRA_LARGE_PROJECTS=<dir> npx playwright test tests/browser/large-projects.spec.js --repeat-each=3
// Each run uses a fresh browser profile and appends one JSON line per scenario
// to <dir>/results.jsonl; scripts/large-projects-report.mjs takes the medians.
import {test,expect} from '@playwright/test';
import {appendFile,stat,writeFile} from 'node:fs/promises';
import {randomBytes} from 'node:crypto';
import {zipSync,strToU8} from 'fflate';
import {existsSync} from 'node:fs';
import {join} from 'node:path';

const DIR=process.env.SCRIBYRA_LARGE_PROJECTS;
test.skip(!DIR,'Set SCRIBYRA_LARGE_PROJECTS to the generated project directory.');
test.use({serviceWorkers:'allow',actionTimeout:120000});
test.setTimeout(3600000);

const percentile=(values,p)=>{if(!values.length)return null;const sorted=[...values].sort((a,b)=>a-b);return sorted[Math.min(sorted.length-1,Math.ceil(p/100*sorted.length)-1)];};
const round=value=>value===null||value===undefined?null:Math.round(value*10)/10;
async function record(browserName,scenario,metrics){await appendFile(join(DIR,'results.jsonl'),JSON.stringify({browser:browserName,scenario,at:new Date().toISOString(),...metrics})+'\n');}
const estimate=page=>page.evaluate(async()=>(await navigator.storage.estimate()).usage??null);
const heap=page=>page.evaluate(()=>performance.memory?.usedJSHeapSize??null);
const source=page=>page.locator('.cm-content');
const saved=page=>expect(page.locator('.save-indicator')).toHaveText('Saved locally',{timeout:600000});

/** Time in the page from the next trusted click to a condition, polled every frame. */
async function armClick(page){await page.evaluate(()=>{window.__clickAt=null;document.addEventListener('click',event=>{if(window.__clickAt===null)window.__clickAt=performance.now();},{capture:true,once:true});});}
// A string expression: the app's CSP forbids eval inside the page, not the driver's own evaluation.
async function since(page,predicate){const handle=await page.waitForFunction(`(()=>{const done=(()=>{${predicate}})();return done&&window.__clickAt!==null?Math.max(0.01,performance.now()-window.__clickAt):false;})()`,null,{polling:'raf',timeout:1200000});return handle.jsonValue();}
async function startClock(page){await page.evaluate(()=>{window.__clickAt=performance.now();});}

/** Main-thread responsiveness: longest gap between animation frames while armed. */
async function frames(page,run){
  await page.evaluate(()=>{window.__frames={gaps:[],last:performance.now(),on:true};const tick=now=>{const f=window.__frames;if(!f.on)return;f.gaps.push(now-f.last);f.last=now;requestAnimationFrame(tick);};requestAnimationFrame(tick);});
  const result=await run();
  const gaps=await page.evaluate(()=>{window.__frames.on=false;return window.__frames.gaps;});
  return{result,maxFrameGapMs:round(Math.max(0,...gaps)),p95FrameGapMs:round(percentile(gaps,95)),frames:gaps.length};
}

/** Keydown (event timestamp) to the first task after the next animation frame, i.e. after paint. */
async function typing(page,chars=40){
  await page.evaluate(()=>{
    window.__latency=[];
    if(window.__latencyInstalled)return;window.__latencyInstalled=true;
    document.addEventListener('keydown',event=>{
      const now=performance.now(),start=event.timeStamp>0&&event.timeStamp<=now?event.timeStamp:now;
      requestAnimationFrame(()=>{const channel=new MessageChannel();channel.port1.onmessage=()=>window.__latency.push(performance.now()-start);channel.port2.postMessage(0);});
    },true);
  });
  const text='typing latency probe ';
  // Word-sized bursts with pauses, so the debounced local save runs between them.
  for(let i=0;i<chars;i++){await page.keyboard.press(text[i%text.length]===' '?'Space':text[i%text.length]);await page.waitForTimeout(i%7===6?450:110);}
  await page.waitForFunction(count=>window.__latency.length>=count,chars);
  const values=await page.evaluate(()=>window.__latency);
  return{p50:round(percentile(values,50)),p95:round(percentile(values,95)),max:round(Math.max(...values)),n:values.length};
}
async function cursor(page,where){
  await source(page).click();
  if(where==='start')await page.keyboard.press('Control+Home');
  else if(where==='end')await page.keyboard.press('Control+End');
  else await page.evaluate(()=>{const view=document.querySelector('.cm-content').cmTile.root.view,line=view.state.doc.lineAt(Math.floor(view.state.doc.length/2));view.dispatch({selection:{anchor:line.to},scrollIntoView:true});view.focus();});
  await page.waitForTimeout(400);
}
/** One saved keystroke: keydown to "Saved locally" (includes the app's 160 ms debounce). */
async function saveTime(page){
  await saved(page);
  const measured=await frames(page,async()=>{await startClock(page);await page.keyboard.press('x');await page.waitForFunction(()=>document.querySelector('.save-indicator')?.textContent!=='Saved locally');return since(page,'return document.querySelector(".save-indicator")?.textContent==="Saved locally"');});
  return{saveMs:round(measured.result),saveMaxFrameGapMs:measured.maxFrameGapMs};
}
async function importZip(page,file){
  await page.goto('/');await expect(page.getByRole('heading',{name:'Your next great idea starts here.'})).toBeVisible();
  await page.evaluate(()=>navigator.serviceWorker?.ready);
  const before=await estimate(page);
  const chooser=page.waitForEvent('filechooser');await page.getByRole('button',{name:'Import ZIP',exact:true}).click();const picker=await chooser;
  await startClock(page);await picker.setFiles(join(DIR,file));
  const importMs=await since(page,'return !!document.querySelector(".cm-content")');
  await saved(page);const after=await estimate(page);
  return{importMs:round(importMs),storageBefore:before,storageAfter:after,idbBytes:after!==null&&before!==null?after-before:null};
}
async function openFromDashboard(page,name){
  await page.reload();const card=page.getByRole('button',{name:new RegExp(`${name}.*files?`)}).first();await expect(card).toBeVisible();
  await armClick(page);await card.click();
  const openMs=await since(page,'const c=document.querySelector(".cm-content");return !!c&&c.getAttribute("contenteditable")==="true"&&c.textContent.length>0');
  await saved(page);return round(openMs);
}
async function projectSearch(page,query){
  await source(page).click();await page.keyboard.press('Control+Shift+f');const box=page.getByLabel('Search text',{exact:true});await expect(box).toBeFocused();await box.fill(query);
  await armClick(page);await page.getByRole('button',{name:'Run search',exact:true}).click();
  const ms=await since(page,'return /match|limit/.test(document.querySelector(".tool-status")?.textContent||"")&&!/Searching/.test(document.querySelector(".tool-status")?.textContent)');
  const status=await page.locator('.tool-status').textContent();
  await page.getByRole('button',{name:'Files',exact:true}).click();await expect(page.getByRole('treeitem').first()).toBeVisible();
  return{searchMs:round(ms),searchStatus:status};
}
async function compile(page){
  await page.evaluate(()=>{window.scribyra.lastCompile=null;});await armClick(page);
  const measured=await frames(page,async()=>{await page.getByRole('button',{name:'Compile',exact:true}).click();return since(page,'return !!window.scribyra.lastCompile');});
  const result=await page.evaluate(()=>{const r=window.scribyra.lastCompile;return{success:r.success,bytes:r.bytes,log:r.success?'':String(r.log).slice(-3000)};});
  const pages=await page.locator('#pdf-viewer .page').count();
  return{ms:round(measured.result),maxFrameGapMs:measured.maxFrameGapMs,pages,...result};
}
async function pdfResponsiveness(page){
  const viewer=page.locator('#pdf-viewer');await expect(viewer.locator('canvas').first()).toBeVisible();
  // Jump to the middle of the document and wait for that page's canvas.
  await startClock(page);
  await page.evaluate(()=>{const v=document.getElementById('pdf-viewer');v.scrollTop=v.scrollHeight/2;});
  const jumpMs=await since(page,'const v=document.getElementById("pdf-viewer"),box=v.getBoundingClientRect(),shown=[...v.querySelectorAll(".page")].filter(p=>{const r=p.getBoundingClientRect();return Math.min(r.bottom,box.bottom)-Math.max(r.top,box.top)>box.height*0.25;});return shown.length>0&&shown.every(p=>p.dataset.loaded==="true"&&p.querySelector("canvas"))');
  // Scroll continuously for three seconds, as a reader flicking through pages.
  const scrolled=await frames(page,()=>page.evaluate(()=>new Promise(resolve=>{const v=document.getElementById('pdf-viewer'),end=performance.now()+3000;const step=()=>{v.scrollTop+=140;if(performance.now()<end)requestAnimationFrame(step);else resolve(v.scrollTop);};requestAnimationFrame(step);})));
  await startClock(page);
  const settleMs=await since(page,'const v=document.getElementById("pdf-viewer"),box=v.getBoundingClientRect(),shown=[...v.querySelectorAll(".page")].filter(p=>{const r=p.getBoundingClientRect();return Math.min(r.bottom,box.bottom)-Math.max(r.top,box.top)>box.height*0.25;});return shown.length>0&&shown.every(p=>p.dataset.loaded==="true"&&p.querySelector("canvas"))');
  return{pdfJumpMs:round(jumpMs),pdfScrollMaxFrameGapMs:scrolled.maxFrameGapMs,pdfScrollP95FrameGapMs:scrolled.p95FrameGapMs,pdfScrollFrames:scrolled.frames,pdfSettleAfterScrollMs:round(settleMs)};
}
async function openHistory(page){
  await armClick(page);await page.getByRole('button',{name:'History',exact:true}).click();
  const ms=await since(page,'const p=document.querySelector("[aria-label=\'Project history\']");return !!p&&[...p.querySelectorAll("[role=option]")].length>1&&/stored on this device/.test(p.textContent)');
  return round(ms);
}
async function exportBackup(page){
  const panel=page.getByRole('region',{name:'Project history',exact:true}),status=panel.getByRole('status',{name:'History status'});
  await panel.getByRole('button',{name:'Manage history',exact:true}).click();
  const started=Date.now();let download=null;const pending=page.waitForEvent('download',{timeout:1800000}).then(value=>{download=value;}).catch(()=>{});
  await panel.getByRole('button',{name:'Export complete backup',exact:true}).click();
  await expect(status).toContainText(/Complete backup exported|could not be exported/,{timeout:1800000});const ms=Date.now()-started;
  const text=await status.textContent();
  if(!/Complete backup exported/.test(text))return{backupExportMs:ms,backupBytes:null,backupError:text};
  await pending;const path=await download.path();
  return{backupExportMs:ms,backupBytes:(await stat(path)).size,path};
}
async function importBackup(page,path){
  const panel=page.getByRole('region',{name:'Project history',exact:true});
  await panel.getByRole('button',{name:'Manage history',exact:true}).click();
  const chooser=page.waitForEvent('filechooser');await panel.getByRole('button',{name:'Import complete backup',exact:true}).click();const picker=await chooser;
  const started=Date.now();await picker.setFiles(path);
  const dialog=page.getByRole('dialog',{name:'Import this backup?'});await expect(dialog).toBeVisible({timeout:1800000});const planMs=Date.now()-started;
  const confirmed=Date.now();await dialog.getByRole('button',{name:'Import as a new project',exact:true}).click();
  await expect(panel.getByRole('status',{name:'History status'})).toContainText('Backup added as a new project.',{timeout:1800000});
  return{restorePlanMs:planMs,restoreImportMs:Date.now()-confirmed,restoreMs:Date.now()-started};
}
async function closeHistory(page){await page.getByRole('region',{name:'Project history',exact:true}).getByRole('button',{name:'Back to editor',exact:true}).click();await expect(source(page)).toBeVisible();}
async function exportZip(page){
  const started=Date.now(),pending=page.waitForEvent('download',{timeout:1800000});await page.getByRole('button',{name:'Export',exact:true}).click();
  const download=await pending,path=await download.path();return{zipExportMs:Date.now()-started,zipExportBytes:(await stat(path)).size};
}
async function openFile(page,name){await page.getByRole('treeitem',{name,exact:true}).click();await expect(source(page)).toBeVisible();await page.waitForTimeout(300);}
/** Install generator-dumped IndexedDB records (scripts/large-projects.mjs) as the app would have stored them.
 * Node sends bounded batches through page.evaluate: WebKit's service worker answers page
 * fetches itself, so routed URLs never reach this test. */
async function seedDump(page,base){
  const {openSync,readSync,closeSync,readFileSync}=await import('node:fs');
  const data=JSON.parse(readFileSync(base+'.json','utf8')),p=data.project,fd=openSync(base+'.bin','r'),LIMIT=8*1024*1024;
  const size=row=>{let n=0;JSON.stringify(row,(k,v)=>{if(v&&v.$bytes)n+=v.$bytes[1];return v;});return n;};
  const encode=rows=>JSON.stringify(rows,(k,v)=>{if(v&&v.$bytes){const b=Buffer.alloc(v.$bytes[1]);readSync(fd,b,0,b.length,v.$bytes[0]);return{$b64:b.toString('base64')};}return v;});
  async function install(rows,shape){
    for(let i=0;i<rows.length;){
      const batch=[];let bytes=0;while(i<rows.length&&(bytes<LIMIT||!batch.length)){bytes+=size(rows[i]);batch.push(rows[i++]);}
      await page.evaluate(async({payload,shape,projectId})=>{
        const rows=JSON.parse(payload,(k,v)=>v&&typeof v.$b64==='string'?Uint8Array.from(atob(v.$b64),c=>c.charCodeAt(0)):v);
        const db=await new Promise((resolve,reject)=>{const request=indexedDB.open('scribyra-v1');request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);});
        const puts=rows.flatMap(row=>shape==='blobs'?[['blobs',row],['projectBlobs',{projectId,hash:row.hash}]]:shape==='project'?[['projects',row],['heads',{id:row.id,schemaVersion:row.schemaVersion,name:row.name,updatedAt:row.updatedAt,files:row.files,sequence:row.sequence,deleted:false}]]:[[shape,row]]);
        const tx=db.transaction([...new Set(puts.map(([name])=>name))],'readwrite');for(const [name,value] of puts)tx.objectStore(name).put(value);
        await new Promise((resolve,reject)=>{tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error);});db.close();
      },{payload:encode(batch),shape,projectId:p.id});
    }
  }
  try{
    for(const name of ['journal','checkpoints','historyCatalog','projectHistoryObjects','migrationBackupsV2'])await install(data[name],name);
    await install(data.objects,'historyObjects');await install(data.blobs,'blobs');
    if(data.migrationBackup)await install([data.migrationBackup],'migrationBackups');
    await install([p],'project');
  }finally{closeSync(fd);}
  return{journal:data.journal.length,checkpoints:data.checkpoints.length,objects:data.objects.length};
}
/** Stored bytes by IndexedDB store for one project, and whether it is in history format 2. */
const historyStores=(page,name)=>page.evaluate(async name=>{
  const db=await new Promise((ok,fail)=>{const r=indexedDB.open('scribyra-v1');r.onsuccess=()=>ok(r.result);r.onerror=()=>fail(r.error);});
  const all=(store,query)=>new Promise((ok,fail)=>{const rows=[],r=query===undefined?db.transaction(store).objectStore(store).openCursor():db.transaction(store).objectStore(store).index('projectId').openCursor(query);r.onsuccess=()=>{const c=r.result;if(!c)return ok(rows);rows.push(c.value);c.continue();};r.onerror=()=>fail(r.error);});
  const project=(await all('projects')).filter(p=>p.name===name).sort((a,b)=>b.sequence-a.sequence)[0],size=rows=>rows.reduce((n,row)=>n+(row.update?.length??0),0);
  const journal=await all('journal',project.id),checkpoints=await all('checkpoints',project.id),pins=await all('projectHistoryObjects',project.id);let objects=0;
  for(const hash of new Set(pins.map(pin=>pin.hash))){const object=await new Promise(ok=>{const r=db.transaction('historyObjects').objectStore('historyObjects').get(hash);r.onsuccess=()=>ok(r.result);});objects+=object?.bytes.length||0;}
  db.close();return{format:project.history?.version??1,project:project.update.length,journal:size(journal),journalRows:journal.length,points:journal.filter(r=>r.point).length,checkpoints:size(checkpoints),checkpointRows:checkpoints.length,objects,history:size(journal)+size(checkpoints)+objects};
},name);
/** Size of the stored project snapshot (one Yjs update) for the open project. */
const snapshotBytes=(page,name)=>page.evaluate(async name=>{
  const db=await new Promise((resolve,reject)=>{const request=indexedDB.open('scribyra-v1');request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);});
  const all=await new Promise(resolve=>{const request=db.transaction('projects').objectStore('projects').getAll();request.onsuccess=()=>resolve(request.result);});db.close();
  return all.filter(p=>p.name===name).reduce((max,p)=>Math.max(max,p.update.length),0);
},name);
const began=Date.now();
function step(name){console.log(`[large] ${((Date.now()-began)/1000).toFixed(0)}s ${name}`);}
/** Partial results are kept when a later step fails, marked incomplete. */
async function measured(browserName,scenario,m,run){try{await run();await record(browserName,scenario,m);}catch(error){await record(browserName,scenario,{...m,incomplete:String(error.message).slice(0,300)});throw error;}}
function quiet(page){const errors=[];page.on('pageerror',error=>errors.push(error.message));return errors;}

test.describe('large projects',()=>{
 test('thesis: import, open, typing, search, compile, PDF',async({page,browserName})=>{
  const errors=quiet(page),m={};await measured(browserName,'thesis',m,async()=>{
  Object.assign(m,await importZip(page,'thesis.zip'));
  step('m.openMs=await openFromDashboa');m.openMs=await openFromDashboard(page,'thesis');m.heapAfterOpen=await heap(page);
  await openFile(page,'chapters/05-theory/chapter.tex');await cursor(page,'middle');const snap0=await snapshotBytes(page,'thesis');m.typingIdle=await typing(page);await saved(page);m.snapshotBytesPerTypedChar=round(((await snapshotBytes(page,'thesis'))-snap0)/m.typingIdle.n);
  step('Object.assign(m,await saveTime');Object.assign(m,await saveTime(page));
  step('Object.assign(m,await projectS');Object.assign(m,await projectSearch(page,'gradient'));m.searchRare=await projectSearch(page,'figure-42.png');
  step('const first=await compile(page');const first=await compile(page);m.firstCompile=first;expect(first.success,first.log).toBeTruthy();
  m.heapAfterCompile=await heap(page);
  step('Object.assign(m,await pdfRespo');Object.assign(m,await pdfResponsiveness(page));
  await openFile(page,'chapters/05-theory/chapter.tex');await cursor(page,'end');await page.keyboard.type(' Edited.');await saved(page);
  step('const second=await compile(pag');const second=await compile(page);m.recompile=second;expect(second.success,second.log).toBeTruthy();
  // Typing while a compilation runs.
  await page.evaluate(()=>{window.scribyra.lastCompile=null;});await page.getByRole('button',{name:'Compile',exact:true}).click();
  await expect(page.getByRole('button',{name:'Cancel compilation',exact:true})).toBeVisible();await cursor(page,'end');
  step('m.typingDuringCompile=await ty');m.typingDuringCompile=await typing(page,30);m.typingDuringCompile.compileStillRunning=await page.evaluate(()=>!window.scribyra.lastCompile);
  // A compile whose source changed meanwhile finishes without publishing a result; wait for the button instead.
  await expect(page.getByRole('button',{name:'Compile',exact:true})).toBeVisible({timeout:1800000});
  m.storageFinal=await estimate(page);m.heapFinal=await heap(page);m.pageErrors=errors;
  });
 });
 test('thesis history: History view, complete backup, restore and ZIP export',async({page,browserName})=>{
  const errors=quiet(page),m={};await measured(browserName,'thesis-history',m,async()=>{
  Object.assign(m,await importZip(page,'thesis.zip'));
  await openFile(page,'chapters/05-theory/chapter.tex');await cursor(page,'end');await page.keyboard.type(' Edited once.');await saved(page);
  step('history');m.historyOpenMs=await openHistory(page);
  step('backup');const backup=await exportBackup(page);m.backupExportMs=backup.backupExportMs;m.backupBytes=backup.backupBytes;m.backupError=backup.backupError??null;
  step('restore');const beforeRestore=await estimate(page);Object.assign(m,await importBackup(page,backup.path));m.restoreIdbBytes=(await estimate(page))-beforeRestore;
  await closeHistory(page);step('zip');Object.assign(m,await exportZip(page));
  m.storageFinal=await estimate(page);m.heapFinal=await heap(page);m.pageErrors=errors;
  });
 });
 test('long single file: import, open, typing at start/middle/end, save, search and export',async({page,browserName})=>{
  const errors=quiet(page),m={};await measured(browserName,'long-file',m,async()=>{
  Object.assign(m,await importZip(page,'long-file.zip'));
  step('m.openMs=await openFromDashboa');m.openMs=await openFromDashboard(page,'long-file');m.heapAfterOpen=await heap(page);
  for(const where of ['start','middle','end']){await cursor(page,where);m[`typing_${where}`]=await typing(page);}
  step('Object.assign(m,await saveTime');Object.assign(m,await saveTime(page));
  step('Object.assign(m,await projectS');Object.assign(m,await projectSearch(page,'gradient'));m.searchRare=await projectSearch(page,'Generated section 451}');
  step('Object.assign(m,await exportZi');Object.assign(m,await exportZip(page));
  m.storageFinal=await estimate(page);m.heapFinal=await heap(page);m.pageErrors=errors;
  });
 });
 test('heavy history: restore backup, open, history view, typing, backup and export',async({page,browserName})=>{
  const errors=quiet(page),m={};await measured(browserName,'heavy-history',m,async()=>{
  await page.goto('/');await page.evaluate(()=>navigator.serviceWorker?.ready);await page.getByRole('button',{name:'Start with a sample paper'}).click();await expect(source(page)).toBeVisible();await saved(page);
  const before=await estimate(page);
  if(existsSync(join(DIR,'heavy-history.scribyra-backup'))){await page.getByRole('button',{name:'History',exact:true}).click();Object.assign(m,await importBackup(page,join(DIR,'heavy-history.scribyra-backup')));}
  else{m.seeded=await seedDump(page,join(DIR,'heavy-history.idb'));m.seededNote='No complete backup could be generated; records installed directly.';}
  m.idbBytes=(await estimate(page))-before;
  step('m.openMs=await openFromDashboa');const opened=Date.now();m.openMs=await openFromDashboard(page,'Heavy history');m.heapAfterOpen=await heap(page);
  // History format 2: the first open merges per-key records; idle maintenance then thins the stored versions.
  m.storedAfterOpen=await historyStores(page,'Heavy history');
  if(m.storedAfterOpen.format===2){
    // Poll from the test: an async page predicate would return a (truthy) promise at once.
    const compacted=()=>page.evaluate(async()=>{const db=await new Promise(ok=>{const r=indexedDB.open('scribyra-v1');r.onsuccess=()=>ok(r.result);});const all=await new Promise(ok=>{const r=db.transaction('projects').objectStore('projects').getAll();r.onsuccess=()=>ok(r.result);});db.close();return all.find(p=>p.name==='Heavy history')?.history?.compaction;});
    for(const deadline=Date.now()+1800000;;){const state=await compacted();if(state==='done'||state==='failed'){m.compaction=state;break;}if(Date.now()>deadline)throw new Error('History compaction did not finish.');await page.waitForTimeout(500);}
    m.compactionDoneMs=Date.now()-opened;m.storedAfterCompaction=await historyStores(page,'Heavy history');m.storageAfterCompaction=await estimate(page);
  }
  await openFile(page,'chapters/chapter-3.tex');await cursor(page,'middle');m.typingIdle=await typing(page);
  step('Object.assign(m,await saveTime');Object.assign(m,await saveTime(page));
  step('m.historyOpenMs=await openHist');m.historyOpenMs=await openHistory(page);
  m.historyOptions=await page.getByRole('region',{name:'Project history',exact:true}).getByRole('option').count();
  step('const backup=await exportBacku');const backup=await exportBackup(page);m.backupExportMs=backup.backupExportMs;m.backupBytes=backup.backupBytes;m.backupError=backup.backupError??null;
  // The documented way out of an oversized history: clean up automatic versions, then export again.
  const panel=page.getByRole('region',{name:'Project history',exact:true}),beforeCleanup=await estimate(page);
  await panel.getByRole('button',{name:'Manage history',exact:true}).click();const planned=Date.now();await panel.getByRole('button',{name:'Clean up history',exact:true}).click();
  const cleanup=page.getByRole('dialog',{name:'Clean up history?'});await expect(cleanup).toBeVisible({timeout:1800000});m.cleanupPlanMs=Date.now()-planned;
  const storedBeforeCleanup=await historyStores(page,'Heavy history');
  step('cleanup');const confirmed=Date.now();await cleanup.getByRole('button',{name:/^(Remove \d+ versions?|Clean up)$/}).click();
  await expect(panel.getByRole('status',{name:'History status'})).toContainText('History cleaned up.',{timeout:1800000});m.cleanupMs=Date.now()-confirmed;m.cleanupFreedBytes=beforeCleanup-(await estimate(page));
  // Clean-up never grows stored history (history format 2; earlier formats are compacted on open).
  m.storedAfterCleanup=await historyStores(page,'Heavy history');if(storedBeforeCleanup.format===2)expect(m.storedAfterCleanup.history).toBeLessThanOrEqual(storedBeforeCleanup.history);
  step('backup after cleanup');const after=await exportBackup(page);m.backupAfterCleanupMs=after.backupExportMs;m.backupAfterCleanupBytes=after.backupBytes;m.backupAfterCleanupError=after.backupError??null;
  if(after.path){const restored=await importBackup(page,after.path);m.restoreAfterCleanupMs=restored.restoreMs;}
  await closeHistory(page);Object.assign(m,await exportZip(page));
  m.storageFinal=await estimate(page);m.heapFinal=await heap(page);m.pageErrors=errors;
  });
 });
 test('limits: oversized imports, uploads and saves fail clearly without losing data',async({page,browserName})=>{
  test.skip(!process.env.SCRIBYRA_LARGE_LIMITS,'Set SCRIBYRA_LARGE_LIMITS=1 to run the edge cases (once per engine).');
  const m={},MiB=1024*1024,notice=page.getByRole('status',{name:'Workspace notification',exact:true});
  const write=async(name,files,level=0)=>{const path=join(DIR,name);await writeFile(path,zipSync(files,{level}));return path;};
  const cards=()=>page.locator('.card-open').count();
  const attempt=async path=>{
   await page.goto('/');await expect(page.getByRole('heading',{name:'Your next great idea starts here.'})).toBeVisible();const before=await cards();
   const chooser=page.waitForEvent('filechooser');await page.getByRole('button',{name:'Import ZIP',exact:true}).click();await(await chooser).setFiles(path);
   await expect(notice).not.toBeEmpty({timeout:120000});const text=await notice.textContent();await page.reload();await expect(page.getByRole('heading',{name:'Your next great idea starts here.'})).toBeVisible();
   return{message:text,projectsBefore:before,projectsAfter:await cards()};
  };
  m.zipOver64MiB=await attempt(await write('limit-zip.zip',{'main.tex':strToU8('\\documentclass{article}\\begin{document}x\\end{document}'),'data.bin':randomBytes(65*MiB)}));
  m.expandedOver64MiB=await attempt(await write('limit-expanded.zip',{'main.tex':strToU8('%'.repeat(70*MiB))},9));
  const many={};for(let i=0;i<600;i++)many[`files/f${i}.tex`]=strToU8(`% ${i}\n`);m.over512Files=await attempt(await write('limit-files.zip',many,6));
  // A project just under the bound, then text that crosses it.
  const filler=64*MiB-200*1024,path=await write('limit-near.zip',{'main.tex':strToU8('\\documentclass{article}\n\\begin{document}\nNear the limit.\n\\end{document}\n'),'filler.bin':randomBytes(filler)});
  await page.goto('/');const chooser=page.waitForEvent('filechooser');await page.getByRole('button',{name:'Import ZIP',exact:true}).click();await(await chooser).setFiles(path);await expect(source(page)).toBeVisible();await saved(page);
  // Upload that would exceed the bound.
  const big=join(DIR,'limit-upload.png');await writeFile(big,randomBytes(MiB));
  const files=page.waitForEvent('filechooser');await page.getByRole('button',{name:'Upload files'}).first().click();await(await files).setFiles(big);
  await expect(notice).toContainText(/64 MiB/,{timeout:60000});m.uploadOverLimit={message:await notice.textContent(),tree:await page.getByRole('treeitem').count()};
  // Typing text that crosses the bound.
  await source(page).click();await page.keyboard.press('Control+End');await page.keyboard.insertText('% '+'y'.repeat(300*1024)+'\n');
  await page.waitForTimeout(3000);m.textOverLimit={saveStatus:await page.locator('.save-indicator').textContent(),message:await notice.textContent()};
  await page.keyboard.press('Control+z');await page.waitForTimeout(2000);m.textOverLimit.afterUndo=await page.locator('.save-indicator').textContent();
  await page.reload();await page.getByRole('button',{name:/limit-near.*files?/}).click();await expect(source(page)).toBeVisible();
  m.textOverLimit.afterReloadContainsNearText=(await source(page).textContent()).includes('Near the limit.');
  await record(browserName,'limits',m);
 });
});

