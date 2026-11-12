// Heavy-history project for scripts/large-projects.mjs: a medium project after
// 5,000 saved edits, 200 comments and suggestions and 20 named versions, built
// with the app's own storage/comment/review/history modules over fake-indexeddb
// and exported as a complete backup. Content is deterministic; record IDs and
// timestamps are not.
import 'fake-indexeddb/auto';
import {readFileSync} from 'node:fs';
import {registerHooks} from 'node:module';
import * as Y from 'yjs';
import {initSync,blob_hash} from '../web/pkg/scribyra_app.js';
initSync({module:readFileSync(new URL('../web/pkg/scribyra_app_bg.wasm',import.meta.url))});
const {initializeCollaborationSchema}=await import('../web/collaboration-schema.js');initializeCollaborationSchema();
registerHooks({load(url,context,next){return url.endsWith('.css')?{format:'module',source:'',shortCircuit:true}:next(url,context);}});
const storage=await import('../web/storage.js');
const {addEntries,migrateProject,projectFiles}=await import('../web/model.js');
const {anchors}=await import('../web/comment-anchors.js');
const {collaborationCommands}=await import('../web/collaboration-commands.js');
const {reviewService}=await import('../web/review-commands.js');
const {registerComments}=await import('../web/comments.js');
const {changeOrigins}=await import('../web/change-origins.js');
const {mount:mountHistory}=await import('../web/history.js');

/** Bytes a complete backup would carry before compression, by store. */
export async function stored(projectId){
  const data=await storage.readHistoryData(projectId),sum=rows=>rows.reduce((total,row)=>total+(row.update?.length??row.bytes?.length??0),0);
  const sizes={project:data.project.update.length,checkpoints:sum(data.checkpoints),checkpointCount:data.checkpoints.length,journal:sum(data.journal),journalCount:data.journal.length,objects:sum(data.objects),objectCount:data.objects.length,assets:sum(data.blobs)};
  sizes.total=sizes.project+sizes.checkpoints+sizes.journal+sizes.objects+sizes.assets;return sizes;
}
export async function heavyHistory(r,{paragraph,sentence,png},{edits=5000,threads=140,suggestions=60,versions=20,dump=false}={}){
  const int=(lo,hi)=>lo+Math.floor(r()*(hi-lo+1));
  const projectId=crypto.randomUUID(),doc=new Y.Doc(),entries=[];
  let main='\\documentclass{report}\n\\usepackage{graphicx}\n\\usepackage{amsmath}\n\\begin{document}\n';
  for(let c=1;c<=6;c++){
    let tex=`\\chapter{Generated chapter ${c}}\n`;
    for(let s=0;s<6;s++){tex+=`\\section{Part ${s+1}}\n`;for(let p=0;p<6;p++)tex+=paragraph(r,int(5,8))+'\n\n';}
    entries.push({path:`chapters/chapter-${c}.tex`,content:tex});main+=`\\input{chapters/chapter-${c}}\n`;
  }
  entries.push({path:'main.tex',content:main+'\\end{document}\n'});
  for(let i=1;i<=3;i++)entries.push({path:`figures/plot-${i}.png`,content:png(9000+i,160,120,60)});
  doc.getMap('meta').set('name','Heavy history');addEntries(doc,entries);migrateProject(doc,projectId);
  doc.getMap('meta').set('mainFile',projectFiles(doc).find(f=>f.path==='main.tex').id);
  await storage.saveProject(projectId,doc);
  const author={id:crypto.randomUUID(),kind:'human',displayName:'Generated author'};
  const flushSave=async()=>{const saved=await storage.saveProject(projectId,doc);Y.applyUpdate(doc,saved.update);};
  const context={doc,projectId,author,sessionId:crypto.randomUUID(),anchors,storage,locks:{request:(_n,_o,run)=>run()},flushSave};
  context.origins=changeOrigins({doc,managers:new Map()});
  const commands=collaborationCommands(context);context.commands=commands;
  const reviews=reviewService(context),comments=registerComments(context),history=mountHistory(context);
  const call=async command=>{const reply=await commands.execute({version:2,requestId:crypto.randomUUID(),projectId,expectedRevision:commands.revision(),command});if(!reply.ok)throw new Error(`${command.op}: ${reply.error.message}`);return reply.value;};
  const texts=projectFiles(doc).filter(f=>f.path.endsWith('.tex')&&f.path!=='main.tex').map(f=>f.id);
  const range=(fileId,length)=>{const text=doc.getText('text:'+fileId).toString(),start=int(0,text.length-length-1);return{start,end:start+length,before:text.slice(start,start+length)};};
  let reviewId,annotationsAt=new Set();
  const total=threads+suggestions;for(let i=0;i<total;i++)annotationsAt.add(Math.floor((i+0.5)*edits/total));
  const growth=[];
  let made={threads:0,replies:0,suggestions:0,versions:0};
  const started=performance.now();
  for(let i=1;i<=edits;i++){
    const fileId=texts[int(0,texts.length-1)],text=doc.getText('text:'+fileId);
    // One edit is a burst of typing or a deletion, followed by the app's debounced save.
    doc.transact(()=>{if(r()<0.7||text.length<2000)text.insert(int(0,text.length),' '+sentence(r));else{const at=int(0,text.length-60);text.delete(at,int(3,40));}});
    await flushSave();
    if(annotationsAt.has(i)){
      const fileId=texts[int(0,texts.length-1)];
      const index=made.threads+made.suggestions;
      if(made.suggestions<suggestions&&(made.threads>=threads||index%10<3)){
        if(made.suggestions%10===0)reviewId=(await call({op:'review.create',title:`Generated review ${made.suggestions/10+1}`})).reviewId;
        const at=range(fileId,int(8,30));await call({op:'suggestion.propose',reviewId,fileId,start:at.start,end:at.end,before:at.before,after:at.before.toUpperCase()});made.suggestions++;
      }else{
        const at=range(fileId,int(8,40)),thread=await call({op:'thread.create',fileId,start:at.start,end:at.end,body:paragraph(r,int(1,3))});made.threads++;
        if(made.threads%4===0){await call({op:'thread.reply',threadId:thread.threadId,body:sentence(r)});made.replies++;}
      }
      await flushSave();
    }
    if(i%Math.floor(edits/versions)===0){await call({op:'history.name',label:`Generated version ${++made.versions}`});await flushSave();}
    if(i%500===0){const sizes=await stored(projectId);growth.push({edits:i,docBytes:Y.encodeStateAsUpdate(doc).length,...sizes});process.stderr.write(`heavy history: ${i}/${edits} edits, ${((performance.now()-started)/1000).toFixed(0)} s, ${JSON.stringify(sizes)}\n`);}
  }
  const exportStarted=performance.now();let backup=null,exportError=null;
  try{
    const artifact=await call({op:'backup.export'});backup=new Uint8Array(artifact.size);
    for(let offset=0;offset<backup.length;){const part=await call({op:'artifact.read',artifactId:artifact.artifactId,offset,limit:65536});backup.set(history.readAttachment(part.attachmentRef),offset);offset=part.nextOffset;}
  }catch(error){
    // Reconstruct what the manifest would list, to explain a refused export.
    const data=await storage.readHistoryData(projectId),unique=new Map();
    for(const bytes of [data.project.update,...data.checkpoints.map(r=>r.update),...data.journal.map(r=>r.update),...data.objects.map(o=>o.bytes),...data.blobs.map(b=>b.bytes)])unique.set(blob_hash(bytes),bytes.length);
    exportError={message:error.message,entries:unique.size,uncompressedBytes:[...unique.values()].reduce((a,b)=>a+b,0)};
  }
  const exportMs=performance.now()-exportStarted,raw=dump?await storage.readHistoryData(projectId):null;
  const sourceBytes=texts.reduce((sum,id)=>sum+new TextEncoder().encode(doc.getText('text:'+id).toString()).length,0);
  const summary={edits,...made,changeRecords:doc.getMap('changes').size,sourceBytes,docUpdateBytes:Y.encodeStateAsUpdate(doc).length,stored:await stored(projectId),growth,nodeBackupExportMs:Math.round(exportMs),exportError,generationMs:Math.round(performance.now()-started)};
  history.close();comments.close();reviews.close();commands.close();context.origins.close();doc.destroy();
  return{backup,summary,raw};
}
