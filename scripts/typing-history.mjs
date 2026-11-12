#!/usr/bin/env node
// Realistic typing simulation for stored-history growth (docs/large-projects.md).
// One person writes a thesis character by character at human pace: one Yjs
// transaction per key, typos corrected with Backspace, occasional undo/redo,
// pauses between words, sentences and paragraphs, breaks, nights and file
// switches. The app's own storage and history modules run over fake-indexeddb;
// time is virtual (Date.now advances with the simulated typist), so months of
// writing run in minutes. A save follows every key that is followed by a pause
// longer than the app's 160 ms save debounce, exactly as the editor would save.
//
//   node scripts/typing-history.mjs [--chars 100000] [--every 10000] [--out tmp/typing/run.jsonl] [--seed 7] [--debounce 160]
//
// --debounce N saves only after pauses longer than N ms (keys stay one transaction each). Used
// for the 1.4-million-character run, where saving after every key would take days of machine time.
// Appends one JSON line per milestone and a final summary line. Works against
// earlier versions of web/ too (no history maintenance there), to measure "before".
import 'fake-indexeddb/auto';
import {readFileSync,appendFileSync,mkdirSync} from 'node:fs';
import {dirname} from 'node:path';
import {registerHooks} from 'node:module';
import * as Y from 'yjs';
import {initSync} from '../web/pkg/scribyra_app.js';

const arg=(name,fallback)=>{const i=process.argv.indexOf('--'+name);return i>0?process.argv[i+1]:fallback;};
const CHARS=Number(arg('chars',100000)),EVERY=Number(arg('every',10000)),OUT=arg('out','tmp/typing/run.jsonl'),SEED=Number(arg('seed',7)),LIST=arg('list','end'),DEBOUNCE=Number(arg('debounce',160));
mkdirSync(dirname(OUT),{recursive:true});
const emit=row=>{appendFileSync(OUT,JSON.stringify(row)+'\n');process.stderr.write(JSON.stringify(row)+'\n');};

// Virtual clock: the typist's time, not the machine's. Set before any app module captures it.
let clock=Date.UTC(2026,0,5,8,0,0);const realNow=Date.now;Date.now=()=>clock;
initSync({module:readFileSync(new URL('../web/pkg/scribyra_app_bg.wasm',import.meta.url))});
const {initializeCollaborationSchema}=await import('../web/collaboration-schema.js');initializeCollaborationSchema();
registerHooks({load(url,context,next){return url.endsWith('.css')?{format:'module',source:'',shortCircuit:true}:next(url,context);}});
const storage=await import('../web/storage.js');
const {addEntries,migrateProject,projectFiles}=await import('../web/model.js');
const {anchors}=await import('../web/comment-anchors.js');
const {collaborationCommands}=await import('../web/collaboration-commands.js');
const {changeOrigins}=await import('../web/change-origins.js');
const {mount:mountHistory}=await import('../web/history.js');
const {cloneProject}=await import('../web/assets.js');

function rng(seed){return()=>{seed|=0;seed=seed+0x6D2B79F5|0;let t=Math.imul(seed^seed>>>15,1|seed);t=t+Math.imul(t^t>>>7,61|t)^t;return((t^t>>>14)>>>0)/4294967296;};}
const r=rng(SEED),pick=list=>list[Math.floor(r()*list.length)],between=(lo,hi)=>lo+r()*(hi-lo);
const nouns=['model','sample','boundary','estimate','signal','surface','network','gradient','dataset','protocol','sensor','interval','manifold','operator','kernel','spectrum','measurement','variance','threshold','layer','domain','solution','approximation','experiment','framework','parameter','sequence','structure','observation','response'];
const adjectives=['robust','linear','stochastic','adaptive','empirical','discrete','nonlinear','sparse','stable','coherent','reproducible','bounded','periodic','latent','smooth','consistent','efficient','partial','global','local'];
const verbs=['improves','reduces','constrains','describes','predicts','approximates','reveals','supports','determines','limits','extends','captures','separates','preserves','measures','controls'];
const sentence=()=>{const s=`the ${pick(adjectives)} ${pick(nouns)} ${pick(verbs)} the ${pick(adjectives)} ${pick(nouns)}${r()<0.4?` of the ${pick(nouns)}`:''}`;return s[0].toUpperCase()+s.slice(1)+(r()<0.1?` \\cite{ref${Math.floor(r()*400)}}`:'')+'. ';};
const percentile=(values,p)=>{if(!values.length)return null;const s=[...values].sort((a,b)=>a-b);return s[Math.min(s.length-1,Math.ceil(p/100*s.length)-1)];};
const round=v=>v==null?null:Math.round(v*100)/100;

// ---- project ----
const projectId=crypto.randomUUID(),doc=new Y.Doc(),chapters=12;
const entries=[{path:'main.tex',content:'\\documentclass{report}\n\\begin{document}\n'+Array.from({length:chapters},(_,i)=>`\\input{chapters/chapter-${i+1}}\n`).join('')+'\\end{document}\n'},{path:'references.bib',content:''}];
for(let c=1;c<=chapters;c++)entries.push({path:`chapters/chapter-${c}.tex`,content:`\\chapter{Chapter ${c}}\n`});
doc.getMap('meta').set('name','Typed thesis');addEntries(doc,entries);migrateProject(doc,projectId);
doc.getMap('meta').set('mainFile',projectFiles(doc).find(f=>f.path==='main.tex').id);
await storage.saveProject(projectId,doc);
const files=projectFiles(doc),chapterIds=files.filter(f=>f.path.startsWith('chapters/')).sort((a,b)=>a.path.localeCompare(b.path,undefined,{numeric:true})).map(f=>f.id),bibId=files.find(f=>f.path==='references.bib').id;
const author={id:crypto.randomUUID(),kind:'human',displayName:'Typist'},managers=new Map();
const manager=id=>{let m=managers.get(id);if(!m){m=new Y.UndoManager(doc.getText('text:'+id),{trackedOrigins:new Set([null])});managers.set(id,m);}return m;};
let lastPointAt=Date.now();
const context={doc,projectId,author,sessionId:crypto.randomUUID(),anchors,storage,managers,locks:{request:(_n,_o,run)=>run()}};
let saves=0,saveMs=[],failure=null,maintenanceMs=0,maintenanceRuns=0;
async function flushSave(){
  // Same order as web/main.js flushSave: decide the point, end the burst, freeze, save, apply.
  const point=storage.pointDue?storage.pointDue(lastPointAt,Date.now()):undefined;
  if(point)history.endBurst?.();
  const frozen=cloneProject(doc),started=performance.now();
  try{
    const result=await storage.saveProject(projectId,frozen,undefined,point===undefined?undefined:{point});
    Y.applyUpdate(doc,result.update,'saved');saves++;saveMs.push(performance.now()-started);
    if(result.pointAt)lastPointAt=result.pointAt;
    if(result.maintenanceDue&&storage.maintainHistory){const t=performance.now();await storage.maintainHistory(projectId);maintenanceMs+=performance.now()-t;maintenanceRuns++;}
  }finally{frozen.destroy();}
}
context.flushSave=flushSave;
context.origins=changeOrigins({doc,managers,remote:['saved']});
const commands=collaborationCommands(context);context.commands=commands;
const history=mountHistory(context);
const call=async command=>{const reply=await commands.execute({version:2,requestId:crypto.randomUUID(),projectId,expectedRevision:commands.revision(),command});if(!reply.ok)throw new Error(`${command.op}: ${reply.error.message}`);return reply.value;};
async function stored(){
  const data=await storage.readHistoryData(projectId),sum=rows=>rows.reduce((total,row)=>total+(row.update?.length??row.bytes?.length??0),0);
  const s={project:data.project.update.length,checkpoints:sum(data.checkpoints),checkpointCount:data.checkpoints.length,journal:sum(data.journal),journalCount:data.journal.length,objects:sum(data.objects),objectCount:data.objects.length};
  s.history=s.checkpoints+s.journal+s.objects;s.total=s.history+s.project;return s;
}

// ---- typist ----
let typed=0,keys=0,typos=0,undos=0,switches=0,keyMs=[],fileId=chapterIds[0],chapter=0,position=null,sinceBreak=0,today=0,day=0,words=0;
const text=id=>doc.getText('text:'+id);
async function key(apply,gap){
  const started=performance.now();doc.transact(apply);keyMs.push(performance.now()-started);keys++;
  // The app saves 160 ms after the last change; a shorter gap to the next key postpones it.
  if(gap>DEBOUNCE){clock+=160;await flushSave();clock+=gap-160;}else clock+=gap;
}
const gapAfter=ch=>{
  let gap=Math.min(900,Math.max(45,Math.exp(between(Math.log(90),Math.log(320)))));
  if(ch===' '){gap+=between(0,250);words++;}
  if(ch==='.')gap+=between(600,3500);
  return Math.round(gap);
};
async function type(chunk){
  for(const ch of chunk){
    if(failure||typed>=CHARS)return;
    const t=text(fileId);if(position===null||position>t.length)position=t.length;
    if(r()<0.025&&/[a-z]/.test(ch)){ // a typo, noticed and corrected
      await key(()=>t.insert(position,pick(['q','x','z','j'])),Math.round(between(120,450)));position++;
      await key(()=>t.delete(position-1,1),Math.round(between(80,250)));position--;typos++;
    }
    await key(()=>t.insert(position,ch),gapAfter(ch));position++;typed++;sinceBreak++;today++;
    if(typed%EVERY===0)await milestone();
  }
}
async function milestone(){
  const s=await stored();
  emit({kind:'milestone',chars:typed,keys,saves,typos,undos,switches,day,virtualHours:round((clock-Date.UTC(2026,0,5,8))/3600000),records:doc.getMap('changes').size,docBytes:Y.encodeStateAsUpdate(doc).length,
    ...Object.fromEntries(Object.entries(s).map(([k,v])=>['stored_'+k,v])),bytesPerChar:round(s.total/typed),historyPerChar:round(s.history/typed),
    saveP50:round(percentile(saveMs,50)),saveP95:round(percentile(saveMs,95)),keyP50:round(percentile(keyMs,50)),keyP95:round(percentile(keyMs,95)),maintenanceMs:Math.round(maintenanceMs),maintenanceRuns,wallSeconds:Math.round((performance.now()-wallStart)/1000)});
  saveMs=[];keyMs=[];
}
const wallStart=performance.now();
try{
  while(typed<CHARS&&!failure){
    // A paragraph in the current chapter, sometimes an insertion earlier in it, sometimes a bibliography entry.
    const roll=r();
    if(roll<0.08){position=Math.floor(r()*text(fileId).length);while(position>0&&text(fileId).toString()[position-1]!==' ')position--;await type(sentence());position=null;}
    else if(roll<0.11){const back=fileId;fileId=bibId;position=null;switches++;clock+=Math.round(between(2000,9000));await type(`@article{ref${typed},\n  title = {${sentence().trim()}},\n  year = {20${10+Math.floor(r()*16)}}\n}\n\n`);fileId=back;position=null;switches++;clock+=Math.round(between(2000,6000));}
    else{
      const count=3+Math.floor(r()*5);for(let i=0;i<count&&!failure&&typed<CHARS;i++)await type(sentence());
      await type('\n\n');
      // Occasionally undo the last paragraph's tail and type it again (redo boundaries).
      if(r()<0.04&&!failure){const m=manager(fileId);m.stopCapturing();const before=text(fileId).length;m.undo();keys++;undos++;clock+=Math.round(between(400,1500));m.redo();keys++;clock+=Math.round(between(400,1500));if(text(fileId).length!==before)position=null;await flushSave();}
      clock+=Math.round(between(5000,60000));
    }
    if(sinceBreak>2500+r()*2500){sinceBreak=0;clock+=Math.round(between(3,25)*60000);}
    if(today>9000+r()*6000){today=0;day++;clock+=Math.round(between(13,16)*3600000);if(r()<0.2)clock+=86400000*Math.ceil(r()*2);}
    if(text(fileId).length>110000+r()*20000&&chapter<chapters-1){chapter++;fileId=chapterIds[chapter];position=null;switches++;}
  }
}catch(error){failure=error;}
if(!failure&&typed%EVERY!==0)await milestone();
const summary={kind:'summary',chars:typed,keys,saves,records:doc.getMap('changes').size,failure:failure?String(failure.message).slice(0,300):null,stored:await stored(),wallSeconds:Math.round((performance.now()-wallStart)/1000)};
// History open, complete backup and restoring the oldest automatic version as a copy.
if(LIST!=='none'){
  try{let t=performance.now();const list=await call({op:'history.list',limit:100});summary.historyListMs=Math.round(performance.now()-t);summary.historyItems=list.items.length;
    t=performance.now();const artifact=await call({op:'backup.export'});summary.backupMs=Math.round(performance.now()-t);summary.backupBytes=artifact.size;
    const oldest=[...list.items].reverse().find(item=>item.available&&item.reason!=='migration')||list.items.at(-1);
    t=performance.now();const plan=await call({op:'history.restorePlan',checkpointRef:oldest.checkpointRef,mode:'copy'});await call({op:'history.restore',planId:plan.planId});summary.restoreOldestMs=Math.round(performance.now()-t);summary.restoredFrom=oldest.reason;
  }catch(error){summary.historyError=String(error.message).slice(0,300);}
}
emit(summary);
history.close();commands.close();context.origins.close();doc.destroy();Date.now=realNow;
process.exit(0);
