// Realistic typing in the real app (docs/large-projects.md, "Typing a thesis"). Opt-in:
//   SCRIBYRA_TYPING_HISTORY=<dir> [SCRIBYRA_TYPING_CHARS=100000] [SCRIBYRA_TYPING_EVERY=10000]
//   npx playwright test tests/browser/typing-history.spec.js --project=chromium
// One person types character by character into the editor: every key is its own editor
// transaction, typos are corrected with Backspace, and pauses follow words, sentences,
// paragraphs, breaks and nights. Playwright's clock gives the page virtual time, so the
// app's 160 ms save debounce, typing bursts and automatic versions see human pacing while
// the run takes minutes. Every milestone appends one JSON line to <dir>/typing.jsonl.
import {test,expect} from '@playwright/test';
import {appendFile,stat} from 'node:fs/promises';
import {join} from 'node:path';

const DIR=process.env.SCRIBYRA_TYPING_HISTORY,CHARS=Number(process.env.SCRIBYRA_TYPING_CHARS||100000),EVERY=Number(process.env.SCRIBYRA_TYPING_EVERY||10000);
test.skip(!DIR,'Set SCRIBYRA_TYPING_HISTORY to an output directory.');
test.use({serviceWorkers:'allow',actionTimeout:600000});
test.setTimeout(8*3600*1000);

function rng(seed){return()=>{seed|=0;seed=seed+0x6D2B79F5|0;let t=Math.imul(seed^seed>>>15,1|seed);t=t+Math.imul(t^t>>>7,61|t)^t;return((t^t>>>14)>>>0)/4294967296;};}
const percentile=(values,p)=>{if(!values.length)return null;const s=[...values].sort((a,b)=>a-b);return s[Math.min(s.length-1,Math.ceil(p/100*s.length)-1)];};
const round=v=>v==null?null:Math.round(v*10)/10;
const nouns=['model','sample','boundary','estimate','signal','surface','network','gradient','dataset','protocol','sensor','interval','manifold','operator','kernel','spectrum','measurement','variance','threshold','layer'];
const adjectives=['robust','linear','stochastic','adaptive','empirical','discrete','nonlinear','sparse','stable','coherent','reproducible','bounded','periodic','latent','smooth'];
const verbs=['improves','reduces','constrains','describes','predicts','approximates','reveals','supports','determines','limits','extends','captures'];

/** The typist: a stream of [kind, text, gapAfterMs] events, human-paced, deterministic. */
function* typist(seed=7){
  const r=rng(seed),pick=list=>list[Math.floor(r()*list.length)],between=(lo,hi)=>lo+r()*(hi-lo);
  const sentence=()=>{const s=`the ${pick(adjectives)} ${pick(nouns)} ${pick(verbs)} the ${pick(adjectives)} ${pick(nouns)}${r()<0.4?` of the ${pick(nouns)}`:''}`;return s[0].toUpperCase()+s.slice(1)+'. ';};
  let typed=0,sinceBreak=0,today=0;
  const gapAfter=ch=>{let gap=Math.min(900,Math.max(45,Math.exp(between(Math.log(90),Math.log(320)))));if(ch===' ')gap+=between(0,250);if(ch==='.')gap+=between(600,3500);return Math.round(gap);};
  for(;;){
    const insertEarlier=r()<0.08,count=insertEarlier?1:3+Math.floor(r()*5);
    if(insertEarlier)yield['move',r(),Math.round(between(1500,6000))];
    for(let i=0;i<count;i++)for(const ch of sentence()){
      if(r()<0.025&&/[a-z]/.test(ch)){yield['insert',pick(['q','x','z','j']),Math.round(between(120,450))];yield['delete',null,Math.round(between(80,250))];}
      yield['insert',ch,gapAfter(ch)];typed++;sinceBreak++;today++;
    }
    if(insertEarlier){yield['end',null,Math.round(between(1500,6000))];continue;}
    yield['insert','\n',200];yield['insert','\n',Math.round(between(5000,60000))];
    if(sinceBreak>2500+r()*2500){sinceBreak=0;yield['pause',null,Math.round(between(3,25)*60000)];}
    if(today>9000+r()*6000){today=0;yield['pause',null,Math.round(between(13,16)*3600000+(r()<0.2?86400000:0))];}
  }
}

async function typingLatency(page,chars=40){
  await page.evaluate(()=>{window.__latency=[];if(window.__latencyInstalled)return;window.__latencyInstalled=true;
    document.addEventListener('keydown',event=>{const now=performance.now(),start=event.timeStamp>0&&event.timeStamp<=now?event.timeStamp:now;requestAnimationFrame(()=>{const channel=new MessageChannel();channel.port1.onmessage=()=>window.__latency.push(performance.now()-start);channel.port2.postMessage(0);});},true);});
  const text='typing latency probe ';
  for(let i=0;i<chars;i++){await page.keyboard.press(text[i%text.length]===' '?'Space':text[i%text.length]);await page.waitForTimeout(i%7===6?450:110);}
  await page.waitForFunction(count=>window.__latency.length>=count,chars,{polling:50});
  const values=await page.evaluate(()=>window.__latency);
  return{p50:round(percentile(values,50)),p95:round(percentile(values,95)),max:round(Math.max(...values)),n:values.length};
}
/** Stored bytes for the project, by store, read from IndexedDB with cursors. */
const storedBytes=page=>page.evaluate(async()=>{
  const db=await new Promise((ok,fail)=>{const r=indexedDB.open('scribyra-v1');r.onsuccess=()=>ok(r.result);r.onerror=()=>fail(r.error);});
  const all=(store,query)=>new Promise((ok,fail)=>{const rows=[],r=(query===undefined?db.transaction(store).objectStore(store).openCursor():db.transaction(store).objectStore(store).index('projectId').openCursor(query));r.onsuccess=()=>{const c=r.result;if(!c)return ok(rows);rows.push(c.value);c.continue();};r.onerror=()=>fail(r.error);});
  const heads=await all('heads'),head=heads.filter(h=>!h.deleted&&!/\((restored|before history compaction)\)/.test(h.name)).sort((a,b)=>(b.sequence??0)-(a.sequence??0))[0];
  const id=head.id,size=rows=>rows.reduce((n,row)=>n+(row.update?.length??row.bytes?.length??0),0);
  const project=(await all('projects')).find(p=>p.id===id),journal=await all('journal',id),checkpoints=await all('checkpoints',id),pins=await all('projectHistoryObjects',id);
  let objects=0;for(const hash of new Set(pins.map(pin=>pin.hash))){const object=await new Promise(ok=>{const r=db.transaction('historyObjects').objectStore('historyObjects').get(hash);r.onsuccess=()=>ok(r.result);});objects+=object?.bytes.length||0;}
  db.close();
  const result={projectId:id,sequence:project.sequence,project:project.update.length,journal:size(journal),journalRows:journal.length,points:journal.filter(row=>row.point).length,checkpoints:size(checkpoints),checkpointRows:checkpoints.length,objects,usage:(await navigator.storage.estimate()).usage??null};
  result.history=result.journal+result.checkpoints+result.objects;return result;
});

test('typing a long document character by character at human pace',async({page,browserName})=>{
  const out=join(DIR,'typing.jsonl'),began=Date.now(),record=row=>appendFile(out,JSON.stringify({browser:browserName,at:new Date().toISOString(),...row})+'\n');
  await page.clock.install({time:new Date('2026-01-05T08:00:00Z')});
  await page.goto('/');await page.evaluate(()=>navigator.serviceWorker?.ready);
  await page.getByRole('button',{name:'Start with a sample paper'}).click();await expect(page.locator('.cm-content')).toBeVisible();
  await expect(page.locator('.save-indicator')).toHaveText('Saved locally',{timeout:600000});
  await page.evaluate(()=>{window.__saveStatus='Saved locally';addEventListener('scribyra:state',event=>{try{window.__saveStatus=JSON.parse(event.detail).saveStatus;}catch{}});});
  await page.evaluate(()=>{const view=document.querySelector('.cm-content').cmTile.root.view,text=view.state.doc.toString(),at=text.lastIndexOf('\\end{document}');window.__end=at;window.__pos=at;view.dispatch({selection:{anchor:at}});view.focus();});
  const run=async events=>page.evaluate(events=>{
    const view=document.querySelector('.cm-content').cmTile.root.view;
    for(const [kind,text]of events){
      if(kind==='move'){const doc=view.state.doc.toString();let at=Math.floor(text*Math.max(1,window.__end));while(at>0&&doc[at-1]!==' ')at--;window.__pos=at;}
      else if(kind==='end')window.__pos=window.__end;
      else if(kind==='insert'){view.dispatch({changes:{from:window.__pos,insert:text},selection:{anchor:window.__pos+1}});if(window.__pos<=window.__end)window.__end++;window.__pos++;}
      else if(kind==='delete'&&window.__pos>0){view.dispatch({changes:{from:window.__pos-1,to:window.__pos},selection:{anchor:window.__pos-1}});if(window.__pos<=window.__end)window.__end--;window.__pos--;}
    }
    return window.__saveStatus;
  },events);
  const metrics={chars:0,keys:0,saves:0,saveWaitMs:[]},events=typist();let pending=[],failure=null,typed=0,ahead=0,next=EVERY;
  await record({kind:'start',chars:CHARS});
  while(typed<CHARS&&!failure){
    const [kind,text,gap]=events.next().value;pending.push([kind,text]);if(kind==='insert'||kind==='delete')metrics.keys++;if(kind==='insert'&&text!=='\n')typed++;
    // Keys closer than the debounce do not save; their time passes before the batch is typed.
    if(gap<=160){ahead+=gap;continue;}
    if(ahead){await page.clock.fastForward(ahead);ahead=0;}
    // The batch ends with a pause longer than the debounce: the app saves, as it would for a person.
    const status=await run(pending);pending=[];
    if(status?.startsWith('Not saved')){failure=status;break;}
    if(status==='Saving locally…'){
      const started=performance.now();await page.clock.fastForward(160);
      const saved=await page.evaluate(()=>window.__saveStatus==='Saved locally'||window.__saveStatus?.startsWith('Not saved')?window.__saveStatus:new Promise(ok=>{const on=event=>{const s=JSON.parse(event.detail).saveStatus;if(s==='Saved locally'||s.startsWith('Not saved')){removeEventListener('scribyra:state',on);ok(s);}};addEventListener('scribyra:state',on);}));
      metrics.saveWaitMs.push(performance.now()-started);metrics.saves++;
      if(saved!=='Saved locally'){failure=saved;break;}
      await page.clock.fastForward(gap-160);
    }else await page.clock.fastForward(gap);
    if(typed>=next){
      next+=EVERY;
      const stored=await storedBytes(page),latency=await typingLatency(page);await expect(page.locator('.save-indicator')).toHaveText('Saved locally',{timeout:600000});
      await page.evaluate(()=>{const view=document.querySelector('.cm-content').cmTile.root.view;window.__pos=Math.min(window.__pos,view.state.doc.length);window.__end=view.state.doc.toString().lastIndexOf('\\end{document}');window.__pos=window.__end;});
      await record({kind:'milestone',chars:typed,keys:metrics.keys,saves:metrics.saves,savedWaitP50:round(percentile(metrics.saveWaitMs,50)),savedWaitP95:round(percentile(metrics.saveWaitMs,95)),typing:latency,stored,bytesPerChar:round(stored.history/typed),wallSeconds:Math.round((Date.now()-began)/1000)});
      metrics.saveWaitMs=[];
    }
  }
  if(pending.length){await run(pending);await page.clock.fastForward(200);}
  const final={kind:'summary',chars:typed,keys:metrics.keys,saves:metrics.saves,failure,wallSeconds:Math.round((Date.now()-began)/1000)};
  await expect(page.locator('.save-indicator')).toHaveText(failure?/Not saved/:'Saved locally',{timeout:600000});
  // Let idle maintenance run as it would after the person stops typing.
  await page.clock.fastForward(10_000);await page.waitForTimeout(3000);
  final.stored=await storedBytes(page);
  // History open, complete backup, and restoring the oldest automatic version as a copy.
  const panel=page.getByRole('region',{name:'Project history',exact:true});
  let started=Date.now();await page.getByRole('button',{name:'History',exact:true}).click();
  await expect(panel.locator('[role=option]').nth(1)).toBeVisible({timeout:1800000});await expect(panel).toContainText(/stored on this device/,{timeout:1800000});final.historyOpenMs=Date.now()-started;
  final.historyOptions=await panel.getByRole('option').count();
  const status=panel.getByRole('status',{name:'History status'});
  await panel.getByRole('button',{name:'Manage history',exact:true}).click();started=Date.now();
  const pendingDownload=page.waitForEvent('download',{timeout:1800000}).catch(()=>null);await panel.getByRole('button',{name:'Export complete backup',exact:true}).click();
  await expect(status).toContainText(/Complete backup exported|could not be exported/,{timeout:1800000});final.backupMs=Date.now()-started;
  const download=await pendingDownload;final.backupBytes=download?(await stat(await download.path())).size:null;final.backupError=download?null:await status.textContent();
  const options=panel.getByRole('option'),count=await options.count();
  for(let i=count-1;i>0;i--){const option=options.nth(i);if(/Starting point/.test(await option.textContent()))continue;await option.click();final.restoredOption=(await option.textContent()).replace(/\s+/g,' ').trim();break;}
  started=Date.now();await panel.getByRole('button',{name:'Restore as a copy',exact:true}).click();
  await page.getByRole('dialog',{name:'Restore as a copy?'}).getByRole('button',{name:'Create the copy',exact:true}).click();
  await expect(status).toContainText('Copy saved as a new project.',{timeout:1800000});final.restoreOldestMs=Date.now()-started;
  await record(final);
});
