#!/usr/bin/env node
// Compacts a heavy-history IndexedDB dump (scripts/large-projects.mjs writes
// heavy-history.idb.json/.bin) with this tree's storage code over fake-indexeddb:
// first open (recovery copy, burst merge), then maintenance, then a complete backup.
// Prints stored sizes and times for each step (docs/large-projects.md).
//   [LATER_DAYS=7] node --max-old-space-size=8192 scripts/compact-dump.mjs tmp/large-projects/heavy-history.idb
// LATER_DAYS runs maintenance as if the project were opened that many days later.
import 'fake-indexeddb/auto';
import {readFileSync,openSync,readSync,closeSync} from 'node:fs';
import {registerHooks} from 'node:module';
import {initSync} from '../web/pkg/scribyra_app.js';
initSync({module:readFileSync(new URL('../web/pkg/scribyra_app_bg.wasm',import.meta.url))});
(await import('../web/collaboration-schema.js')).initializeCollaborationSchema();
registerHooks({load(url,context,next){return url.endsWith('.css')?{format:'module',source:'',shortCircuit:true}:next(url,context);}});
const base=process.argv[2],data=JSON.parse(readFileSync(base+'.json','utf8')),fd=openSync(base+'.bin','r');
const bytes=value=>{const b=Buffer.alloc(value.$bytes[1]);let n=0;while(n<b.length){const r=readSync(fd,b,n,b.length-n,value.$bytes[0]+n);if(!r)throw new Error("short read");n+=r;}return new Uint8Array(b);};
const revive=row=>JSON.parse(JSON.stringify(row),(k,v)=>v&&v.$bytes?bytes(v):v);
const storage=await import('../web/storage.js');await storage.listProjects();
const {openDB}=await import('idb'),db=await openDB('scribyra-v1'),p=data.project;
async function install(name,rows){for(const row of rows){const tx=db.transaction(name,'readwrite');await tx.store.put(revive(row));await tx.done;}}
for(const name of ['journal','checkpoints','historyCatalog','projectHistoryObjects','migrationBackupsV2'])await install(name,data[name]||[]);
await install('historyObjects',data.objects);for(const blob of data.blobs){await install('blobs',[blob]);await install('projectBlobs',[{projectId:p.id,hash:blob.hash}]);}
if(data.migrationBackup)await install('migrationBackups',[data.migrationBackup]);
await install('projects',[p]);await install('heads',[{id:p.id,schemaVersion:p.schemaVersion,name:p.name,updatedAt:p.updatedAt,files:p.files,sequence:p.sequence,deleted:false}]);
closeSync(fd);
const sizes=async()=>{const d=await storage.readHistoryData(p.id),sum=rows=>rows.reduce((n,r)=>n+(r.update?.length??r.bytes?.length??0),0);return{project:d.project.update.length,journal:sum(d.journal),journalRows:d.journal.length,points:d.journal.filter(r=>r.point).length,checkpoints:sum(d.checkpoints),checkpointRows:d.checkpoints.length,objects:sum(d.objects),objectRows:d.objects.length,history:sum(d.journal)+sum(d.checkpoints)+sum(d.objects)};};
process.stderr.write("installed\n");const report={before:await sizes()};process.stderr.write("sized\n");let t=performance.now();
const doc=await storage.loadProject(p.id);report.firstOpenMs=Math.round(performance.now()-t);report.changesAfterOpen=doc.getMap('changes').size;
process.stderr.write("opened "+JSON.stringify(report)+"\n");report.afterOpen=await sizes();t=performance.now();report.maintenance=await storage.maintainHistory(p.id,{now:Date.now()+Number(process.env.LATER_DAYS||0)*86400000});report.maintenanceMs=Math.round(performance.now()-t);
process.stderr.write("maintained "+JSON.stringify(report.maintenance)+"\n");report.after=await sizes();report.projects=(await storage.listProjects()).map(x=>x.name);
const {exportBackup,importBackup}=await import('../web/history-backup.js'),{inventory}=await import('../web/history-storage.js');
t=performance.now();const backup=exportBackup(await storage.readHistoryData(p.id));report.backupMs=Math.round(performance.now()-t);report.backupBytes=backup.length;
t=performance.now();const bundle=importBackup(backup);report.importValidateMs=Math.round(performance.now()-t);report.versions=inventory(bundle).items.length;report.named=inventory(bundle).items.filter(i=>i.versionId).length;
// Clean up history, keeping the oldest automatic version: stored bytes must not grow, and the
// chosen version and every named one must stay restorable.
{
  const Y=await import('yjs'),{anchors}=await import('../web/comment-anchors.js'),{collaborationCommands}=await import('../web/collaboration-commands.js'),{changeOrigins}=await import('../web/change-origins.js'),{mount}=await import('../web/history.js');
  const stored=d=>[...d.journal,...d.checkpoints].reduce((n,r)=>n+r.update.length,0)+d.objects.reduce((n,o)=>n+o.bytes.length,0)+d.blobs.reduce((n,b)=>n+b.bytes.length,0);
  const context={doc,projectId:p.id,author:{id:crypto.randomUUID(),kind:'human',displayName:'Cleaner'},sessionId:crypto.randomUUID(),anchors,storage,managers:new Map(),flushSave:async()=>{},locks:{request:(_n,_o,run)=>run()}};
  context.origins=changeOrigins({doc,managers:context.managers});const commands=collaborationCommands(context);context.commands=commands;const history=mount(context);
  const call=async command=>{const reply=await commands.execute({version:2,requestId:crypto.randomUUID(),projectId:p.id,expectedRevision:commands.revision(),command});if(!reply.ok)throw new Error(command.op+': '+reply.error.message);return reply.value;};
  const beforeBytes=stored(await storage.readHistoryData(p.id)),list=(await call({op:'history.list',limit:100})).items,chosen=list.filter(i=>i.reason==='automatic').at(-1);
  t=performance.now();const plan=await call({op:'history.compactPlan',keepCheckpointIds:chosen?[chosen.checkpointId]:[]});await call({op:'history.compact',planId:plan.planId});
  const after=await storage.readHistoryData(p.id),items=inventory(after).items;
  report.cleanUp={ms:Math.round(performance.now()-t),beforeBytes,afterBytes:stored(after),versionsBefore:list.length,versionsAfter:items.length,named:items.filter(i=>i.versionId).length};
  for(const item of items.filter(i=>i.versionId||i.checkpointId===chosen?.checkpointId)){const copy=await call({op:'history.restorePlan',checkpointRef:item.checkpointRef,mode:'copy'});if(!copy.planId)throw new Error('not restorable');}
  report.cleanUp.chosenAndNamedRestorable=true;history.close();commands.close();context.origins.close();
  if(report.cleanUp.afterBytes>beforeBytes){console.log(JSON.stringify(report,null,1));throw new Error('Clean up history increased stored bytes.');}
}
console.log(JSON.stringify(report,null,1));process.exit(0);
