import './history.css';
import {openPanel} from './menu.js';
import * as Y from 'yjs';
import {blob_hash} from './pkg/scribyra_app.js';
import {cloneProject,copyBlobs,knownBlob,blobRefs,assetBytes} from './assets.js';
import {validateProjectState,projectNodes,migrateProject} from './model.js';
import {ROOTS,LIMITS} from './collaboration-schema.js';
import {AnnotationOrigin,RestoreOrigin,changedTextFiles} from './change-origins.js';
import {BURST_PAUSE_MS,BURST_MAX_MS} from './history-compaction.js';
import {publishStorageChange} from './storage-events.js';
import {checkpoint,verifiedCheckpoint,openVersion,inventory,decode,hydrate,diff,recordChange,authorProfile,restoreCurrent,restoreIdMap,validateRestore,fork,bundleForCopy,replay,replayEach,unpinned,fail,jsonBytes} from './history-storage.js';
import {exportBackup,importBackup} from './history-backup.js';
import {authorChip,bytesLabel,dayLabel,fileChanges,groupByDay,parsePatch,restoreLine,sizeChange,summaryOf,timeLabel,wholeFileRows,whenLabel} from './history-view.js';

const fields={
  'history.list':['cursor','limit','filters'],'history.name':['label','capturedRevision'],
  'history.diff':['fromCheckpoint','toCheckpoint','cursor','limit'],
  'history.restorePlan':['checkpointRef','mode'],'history.restore':['planId'],
  'history.unpin':['versionId'],'history.compactPlan':['keepCheckpointIds'],'history.compact':['planId'],
  'backup.export':['checkpointRefs'],'backup.importPlan':['attachmentRef','mode'],'backup.import':['planId'],
  'artifact.read':['artifactId','offset','limit'],
};
const value=patch=>({valueVersion:1,...patch});
const uuid=()=>crypto.randomUUID();
function checked(command){
  if(Object.keys(command).some(key=>key!=='op'&&!fields[command.op]?.includes(key)))throw fail('invalid_request','Unknown history command field.');
  if(command.label!==undefined&&(typeof command.label!=='string'||!command.label.trim()||[...command.label].length>160))throw fail('invalid_request','Use a nonempty name of at most 160 characters.');
  if(command.limit!==undefined&&(!Number.isSafeInteger(command.limit)||command.limit<1||command.limit>(command.op==='artifact.read'?65536:100)))throw fail('invalid_request','Invalid page or artifact limit.');
  if(command.keepCheckpointIds!==undefined&&(!Array.isArray(command.keepCheckpointIds)||command.keepCheckpointIds.length>10000||command.keepCheckpointIds.some(id=>typeof id!=='string')))throw fail('invalid_request','Invalid retention targets.');
  return structuredClone(command);
}
function requireRights(scope,rights){if(rights.some(right=>!scope.capabilities.includes(right)))throw fail('permission_denied','This restore mode needs '+rights.join(', ')+'.');}

export function mount(context){
  const {doc,projectId,commands,storage}=context,author=context.author||authorProfile(),sessionId=context.sessionId||uuid(),plans=new Map(),artifacts=new Map(),attachments=new Map(),cursors=new Map(),cleanups=[];
  let closed=false,refreshGeneration=0,refreshTimer,artifactBytes=0;
  const AMBIENT='History is stored on this device.',CURRENT='current';
  const state={enabled:true,open:false,busy:false,sourceExport:false,status:'',statusTone:'info',copiedProject:'',items:[],label:'',planId:'',planKind:'',
    filter:'all',selected:CURRENT,focusRef:CURRENT,groups:[],details:{},version:{},compare:'previous',diffLoading:false,diffMessage:'',files:[],others:[],selectedFile:'',fileDiff:null,
    dialog:'',dialogError:'',plan:{},manageOpen:false,listOpen:false};
  const active=()=>{if(closed||context.isActive?.()===false)throw fail('project_closed','History session is closed.');};
  const emit=()=>{if(!closed)context.onState?.({...state});};
  const addPlan=(plan,revision)=>{const id=uuid();plans.set(id,{...plan,revision,createdAt:Date.now()});while(plans.size>8)plans.delete(plans.keys().next().value);return id;};
  const getPlan=(id,kind)=>{const plan=plans.get(id);if(!plan||plan.kind!==kind||Date.now()-plan.createdAt>15*60*1000)throw fail('plan_expired','Prepare a fresh plan.');if(plan.revision!==commands.revision())throw fail('revision_conflict','Project changed; prepare a fresh plan.');return plan;};
  const artifact=(bytes,mimeType='application/octet-stream')=>{if(artifacts.size>=1024||artifactBytes+bytes.length>LIMITS.backupBytes)throw fail('quota_exceeded','Session artifact budget is full; reopen History before another export.');const artifactId=uuid();artifacts.set(artifactId,bytes.slice());artifactBytes+=bytes.length;return value({artifactId,mimeType,size:bytes.length,sha256:blob_hash(bytes)});};
  const boundedDetails=summary=>jsonBytes(summary).length<=48000?summary:{detailsArtifact:artifact(jsonBytes(summary),'application/json')};
  const planValue=(planId,baseRevision,summary)=>value({planId,baseRevision,summary:boundedDetails(summary),complete:true});
  const read=async scope=>{const data=await storage.readHistoryData(projectId);scope.guard();return data;};
  const resolve=(data,ref)=>openVersion(data,inventory(data),ref);
  const page=(items,command,scope,key)=>{
    const revision=commands.revision(),filter=blob_hash(jsonBytes({key,filters:command.filters||null}));let offset=0;
    if(command.cursor){const cursor=cursors.get(command.cursor);if(!cursor||cursor.revision!==revision||cursor.filter!==filter)throw fail('revision_conflict','History continuation is stale.');offset=cursor.offset;}
    const result=[];let count=0;const limit=command.limit||50;
    while(offset<items.length&&count++<limit){const next=structuredClone(items[offset]);if(next.contributors?.length>32){const contributors=next.contributors;next.contributorCount=contributors.length;next.contributors=contributors.slice(0,32);next.contributorsArtifact=artifact(jsonBytes(contributors),'application/json');}if(jsonBytes([...result,next]).length>48000)break;result.push(next);offset++;}
    if(!result.length&&offset<items.length)throw fail('invalid_request','History item exceeds response bound.');
    let nextCursor=null;if(offset<items.length){nextCursor=uuid();cursors.set(nextCursor,{offset,revision,filter});while(cursors.size>128)cursors.delete(cursors.keys().next().value);}
    scope.guard();return value({items:result,nextCursor,atRevision:revision});
  };
  // History policy shares the F gateway's guards, cancellation and receipt boundary.
  async function commit(scope,data,staged,{objects=[],pins=[],history}={},receipt){
    scope.commitGuard();
    const result=await storage.commitPrepared(projectId,data.project.sequence,Y.encodeStateAsUpdate(staged),objects,pins,{
      history,guard:scope.commitGuard,signal:scope.signal,transaction:scope.transaction,
      prepareCommit:result=>{const reply=structuredClone(receipt(result));if(reply.valueVersion!==1||jsonBytes(reply).length>LIMITS.receiptBytes)throw fail('invalid_request','Oversized history receipt.');return()=>scope.committed(reply);},
    });
    scope.guard();copyBlobs(staged,doc);Y.applyUpdate(doc,result.update,new RestoreOrigin({authorId:(scope.actor?.author||author).id,sessionId:scope.actor?.sessionId||sessionId}));
    if(history?.install)publishStorageChange({version:1,kind:'head',projectId:history.install.project.id,sequence:history.install.project.sequence});
    return receipt(result);
  }
  async function run(command,scope){
    const revision=commands.revision(),actor=scope.actor||{author:context.author||author,sessionId},caller=actor.author;
    if(command.op==='artifact.read'){
      const bytes=artifacts.get(command.artifactId),offset=command.offset??0,limit=command.limit??65536;
      const size=bytes?.length??context.transferState?.('reviews','size',{artifactId:command.artifactId});
      if(size===undefined)throw fail('not_found','Artifact is unavailable in this session.');
      if(!Number.isSafeInteger(offset)||offset<0||offset>size)throw fail('invalid_request','Invalid artifact offset.');
      const end=Math.min(offset+limit,size),attachmentRef=uuid(),part=bytes?bytes.slice(offset,end):context.transferState('reviews','read',{artifactId:command.artifactId,offset,limit});
      attachments.set(attachmentRef,part);while(attachments.size>16)attachments.delete(attachments.keys().next().value);
      return value({offset,nextOffset:end,eof:end===size,attachmentRef});
    }
    if(command.op==='backup.importPlan'){
      const bytes=scope.attachments?.get?.(command.attachmentRef)||scope.attachments?.[command.attachmentRef];
      if(!(bytes instanceof Uint8Array))throw fail('invalid_request','Provide the checked backup attachment.');
      if(command.mode!==undefined&&!['fork','recovery'].includes(command.mode))throw fail('invalid_request','Choose fork or explicit recovery.');
      const bundle=importBackup(bytes);scope.guard();
      const planId=addPlan({kind:'import',bundle,mode:command.mode||'fork'},revision);
      return value({planId,baseRevision:revision,summary:{versions:inventory(bundle).items.length,assets:bundle.blobs.length,mode:command.mode||'fork',includesDeletedContent:true},complete:true});
    }
    await context.flushSave?.();scope.guard();const data=await read(scope);
    if(command.op==='history.list'){
      if(command.filters&&Object.keys(command.filters).some(key=>key!=='named'))throw fail('invalid_request','Unsupported history filter.');
      const inv=inventory(data);let items=inv.items.map(item=>({...item,status:item.available?'Restorable':'Not available on this device',contributors:item.contributors?.length?item.contributors:['Unknown (legacy)']}));
      if(command.filters?.named)items=items.filter(item=>item.versionId);
      return page(items,command,scope,'history.list');
    }
    if(command.op==='history.name'){
      if(!command.label)throw fail('invalid_request','A name is required.');
      if(command.capturedRevision&&command.capturedRevision!==revision)throw fail('revision_conflict','Captured revision is stale.');
      const staged=cloneProject(doc);try{
        const cp=checkpoint(staged),versionId=uuid(),change=recordChange(staged,caller,{kind:'version-name',sessionId:actor.sessionId});
        staged.getMap('versions').set(versionId,{...change.common,id:versionId,label:command.label,checkpointRef:cp.hash,basedOnChangeIds:cp.manifest.changeIds});validateProjectState(staged);
        return await commit(scope,data,staged,{objects:cp.objects,pins:cp.pins,history:{catalog:[{checkpointId:cp.manifest.checkpointId,checkpointRef:cp.hash,sequence:data.project.sequence,reason:'named'}]}},result=>value({versionId,checkpointRef:cp.hash,localSequence:result.sequence}));
      }finally{staged.destroy();}
    }
    if(command.op==='history.unpin'){
      const version=doc.getMap('versions').get(command.versionId);if(!version)throw fail('not_found','Named version not found.');
      const staged=cloneProject(doc);try{
        const change=recordChange(staged,caller,{kind:'version-unpin',sessionId:actor.sessionId}),id=uuid();staged.getMap('discussionEvents').set(id,{...change.common,id,targetId:version.id,parents:[...staged.getMap('discussionEvents').values()].filter(e=>e.targetId===version.id).map(e=>e.id),kind:'versionUnpin',payload:{}});
        return await commit(scope,data,staged,{},()=>value({versionId:version.id}));
      }finally{staged.destroy();}
    }
    if(command.op==='history.diff'){
      const before=resolve(data,command.fromCheckpoint);let after;
      try{after=command.toCheckpoint?resolve(data,command.toCheckpoint):{doc:cloneProject(doc)};const result=diff(before.doc,after.doc,{fromAt:before.manifest?.createdAt});
        for(const change of result.changes.filter(change=>change.kind==='asset'))for(const [side,target]of [['before',before.doc],['after',after.doc]])if(change[side])change[side+'Artifact']=artifact(assetBytes(target,change.fileId));
        const paged=page(result.changes,command,scope,'diff:'+command.fromCheckpoint+':'+(command.toCheckpoint||revision));return value({changes:paged.items,nextCursor:paged.nextCursor,truncated:result.changes.some(c=>c.truncated),contributors:result.contributors.length?result.contributors.slice(0,32):['Unknown (legacy)'],contributorCount:result.contributors.length,contributorsArtifact:result.contributors.length>32?artifact(jsonBytes(result.contributors),'application/json'):null});}
      finally{before.doc.destroy();after?.doc.destroy();}
    }
    if(command.op==='history.restorePlan'){
      if(!['copy','current'].includes(command.mode))throw fail('invalid_request','Choose copy or current restore.');
      requireRights(scope,command.mode==='copy'?['read','export','history']:['history','edit','comment','review']);
      const target=resolve(data,command.checkpointRef);try{
        const summary=diff(doc,target.doc),idMap=command.mode==='current'?restoreIdMap(doc,target.doc):Object.fromEntries([...target.doc.getMap('files').keys(),...target.doc.getMap('trash').keys()].map(id=>[id,id]));validateRestore(doc,target.doc,command.mode,scope.capabilities,idMap);
        const planId=addPlan({kind:'restore',mode:command.mode,checkpointRef:command.checkpointRef,checkpointId:target.manifest.checkpointId,idMap,summary,sequence:data.project.sequence},revision);
        return planValue(planId,revision,{mode:command.mode,idChanges:Object.entries(idMap).filter(([from,to])=>from!==to),changes:summary.changes.map(({lineDiff,...change})=>change),contributors:summary.contributors});
      }finally{target.doc.destroy();}
    }
    if(command.op==='history.restore'){
      const plan=getPlan(command.planId,'restore');if(plan.sequence!==data.project.sequence)throw fail('revision_conflict','Committed project changed; prepare again.');requireRights(scope,plan.mode==='copy'?['read','export','history']:['history','edit','comment','review']);
      const guard=scope.commitGuard;scope={...scope,commitGuard:()=>{scope.uiGuard?.({op:'history.restore',mode:plan.mode},{mutation:true});guard();}};scope.uiGuard?.({op:'history.restore',mode:plan.mode},{mutation:true});
      const target=resolve(data,plan.checkpointRef);let staged;
      try{
        validateRestore(doc,target.doc,plan.mode,scope.capabilities,plan.idMap);
        if(plan.mode==='copy'){
          const copy=fork(target.doc,{author:caller,sessionId:actor.sessionId,checkpointId:target.manifest.checkpointId,name:String(target.doc.getMap('meta').get('name')||'Project').slice(0,140)+' (restored)'});staged=copy.doc;staged.getMap('versions').clear();
          // A journal point has no stored objects: the copy keeps the ones just built from it.
          const inv=inventory(data),mapping=makeMapping(Object.fromEntries(projectNodes(target.doc).map(node=>[node.id,node.id]))),install=bundleForCopy(staged,{objects:[...inv.objects,...(target.objects||[])],catalog:[{checkpointId:target.manifest.checkpointId,checkpointRef:target.hash||plan.checkpointRef,sequence:0,reason:'restored'}],blobs:data.blobs,checkpointId:uuid()});
          return await commit(scope,data,doc,{history:{install}},()=>value({projectId:install.project.id,lineageId:copy.lineageId,changeId:copy.changeId,checkpointRef:plan.checkpointRef,idMapRef:mapping}));
        }
        const pre=checkpoint(doc),restored=restoreCurrent(doc,target.doc,{author:caller,sessionId:actor.sessionId,checkpointId:target.manifest.checkpointId,anchors:context.anchors,idMap:plan.idMap});staged=restored.doc;const mapping=makeMapping(restored.idMap);
        return await commit(scope,data,staged,{objects:pre.objects,pins:pre.pins,history:{catalog:[{checkpointId:pre.manifest.checkpointId,checkpointRef:pre.hash,sequence:data.project.sequence,reason:'pre-restore'}]}},()=>value({projectId,lineageId:doc.getMap('meta').get('lineageId'),changeId:restored.changeId,checkpointRef:plan.checkpointRef,idMapRef:mapping}));
      }finally{target.doc.destroy();staged?.destroy();}
    }
    if(command.op==='history.compactPlan'&&data.project.history?.version===2)return compactPlan2(data,command,revision);
    if(command.op==='history.compact'&&data.project.history?.version===2)return compact2(data,command,scope);
    if(command.op==='history.compactPlan'){
      const inv=inventory(data);if(inv.items.some(item=>!item.available))throw fail('history_unavailable','Compaction needs every retained checkpoint locally.');
      const retained=new Set(command.keepCheckpointIds||[]);
      for(const id of retained)if(!inv.items.some(item=>item.checkpointId===id))throw fail('not_found','Unknown retention target.');
      for(const item of inv.items)if(item.pinned||['migration','pre-restore'].includes(item.reason))retained.add(item.checkpointId);
      // Preserve the full head, including causal tombstones, without reseeding the CRDT.
      const head=checkpoint(doc);retained.add(head.manifest.checkpointId);
      // A retained journal point becomes a stored version here, since the journal itself goes.
      const extra=[],materialized=item=>{if(!item.journal)return item;const cp=openVersion(data,inv,item.checkpointRef);try{extra.push(...cp.objects);return{...item,checkpointRef:cp.hash,journal:false};}finally{cp.doc.destroy();}};
      const rows=[...inv.items.filter(item=>retained.has(item.checkpointId)).map(materialized),{checkpointId:head.manifest.checkpointId,checkpointRef:head.hash,sequence:data.project.sequence,reason:'head'}];
      head.objects.push(...extra);
      const removed=inv.items.filter(item=>!retained.has(item.checkpointId)).map(item=>item.checkpointId);
      const retainedSequences=[...new Set(rows.map(row=>row.sequence).filter(Number.isSafeInteger))].sort((a,b)=>a-b),availableSequences=[...new Set([...data.checkpoints,...data.journal].map(row=>row.sequence))].sort((a,b)=>a-b),removedSequences=availableSequences.filter(seq=>!retainedSequences.includes(seq));
      const retainedAssets=new Set(blobRefs(doc).map(ref=>ref.hash)),retainedObjects=new Set(),allObjects=[...inv.objects,...head.objects];
      for(const row of rows){const cp=verifiedCheckpoint(row.checkpointRef,allObjects,data.blobs);try{retainedObjects.add(row.checkpointRef);cp.manifest.updateChunks.forEach(ref=>retainedObjects.add(ref.hash));cp.manifest.assets.forEach(ref=>retainedAssets.add(ref.hash));}finally{cp.doc.destroy();}}
      for(const sequence of retainedSequences){const snapshot=replay(data,sequence);try{blobRefs(snapshot).forEach(ref=>retainedAssets.add(ref.hash));}finally{snapshot.destroy();}}
      for(const row of [...data.migrationBackupsV2,...(data.migrationBackup?[data.migrationBackup]:[])]){const snapshot=decode(row.update);try{blobRefs(snapshot).forEach(ref=>retainedAssets.add(ref.hash));}finally{snapshot.destroy();}}
      const foreignPins=data.projectHistoryObjects.filter(pin=>!pin.pin.startsWith('checkpoint:'));for(const pin of foreignPins)retainedObjects.add(pin.hash);
      if(foreignPins.length)for(const blob of data.blobs)retainedAssets.add(blob.hash);
      const reachability={retainedAssetHashes:[...retainedAssets].sort(),releasedAssetHashes:data.blobs.map(blob=>blob.hash).filter(hash=>!retainedAssets.has(hash)).sort(),retainedObjectHashes:[...retainedObjects].sort(),releasedObjectHashes:data.objects.map(object=>object.hash).filter(hash=>!retainedObjects.has(hash)).sort()};
      const planId=addPlan({kind:'compact',rows,head,removed,retainedSequences,removedSequences,reachability,sequence:data.project.sequence},revision);
      return planValue(planId,revision,{retainedCheckpointIds:rows.map(row=>row.checkpointId),removedCheckpointIds:removed,retainedSequences,removedSequences,...reachability});
    }
    if(command.op==='history.compact'){
      const plan=getPlan(command.planId,'compact');if(plan.sequence!==data.project.sequence)throw fail('revision_conflict','Committed project changed; prepare again.');const inv=inventory(data),objects=[...inv.objects,...plan.head.objects],pins=[],checkpoints=[],catalog=[],blobHashes=new Set(plan.reachability.retainedAssetHashes);
      const sequences=new Map();
      for(const row of plan.rows){const cp=verifiedCheckpoint(row.checkpointRef,objects,data.blobs);try{
        pins.push(...[row.checkpointRef,...cp.manifest.updateChunks.map(ref=>ref.hash)].map(hash=>({hash,pin:'checkpoint:'+row.checkpointId})));
        catalog.push({checkpointId:row.checkpointId,checkpointRef:row.checkpointRef,sequence:row.sequence,reason:row.reason||'retained'});
        cp.manifest.assets.forEach(ref=>blobHashes.add(ref.hash));
        if(Number.isSafeInteger(row.sequence))sequences.set(row.sequence,row);
      }finally{cp.doc.destroy();}}
      // Replay targets are full snapshots of their actual sequences, not a named snapshot at a neighboring sequence.
      for(const [sequence,row]of sequences){const target=replay(data,sequence);try{checkpoints.push({sequence,replayOnly:true,checkpointId:uuid(),createdAt:Date.now(),update:Y.encodeStateAsUpdate(target)});blobRefs(target).forEach(ref=>blobHashes.add(ref.hash));}finally{target.destroy();}}
      for(const row of [...data.migrationBackupsV2,...(data.migrationBackup?[data.migrationBackup]:[])]){const target=decode(row.update);try{blobRefs(target).forEach(ref=>blobHashes.add(ref.hash));}finally{target.destroy();}}
      const history={catalog,compact:{checkpoints,keepCheckpointIds:plan.rows.map(row=>row.checkpointId),blobHashes:[...blobHashes]}};
      const reply=value(boundedDetails({retainedCheckpointIds:history.compact.keepCheckpointIds,removedCheckpointIds:plan.removed,retainedSequences:plan.retainedSequences,removedSequences:plan.removedSequences,...plan.reachability}));return await commit(scope,data,doc,{objects,pins,history},()=>reply);
    }
    if(command.op==='backup.export'){
      // A complete backup always includes every advertised target. Selection cannot silently omit history.
      if(command.checkpointRefs?.some(ref=>!inventory(data).items.some(item=>item.checkpointRef===ref)))throw fail('history_unavailable','Requested checkpoint is unavailable.');
      const bytes=exportBackup(data);scope.guard();return artifact(bytes,'application/vnd.scribyra.backup+zip');
    }
    if(command.op==='backup.import'){
      const plan=getPlan(command.planId,'import'),bundle=structuredClone(plan.bundle),original=hydrate(decode(bundle.project.update),bundle.blobs);let copy;
      try{
        const target=fork(original,{author:caller,sessionId:actor.sessionId,checkpointId:bundle.checkpoints.at(-1)?.checkpointId||uuid(),preserveLineage:plan.mode==='recovery'});copy=target.doc;
        // Import has its own current snapshot checkpoint; historical journal bytes remain exact.
        {
          bundle.project.schemaVersion=copy.getMap('meta').get('schemaVersion');bundle.project.update=Y.encodeStateAsUpdate(copy);bundle.project.sequence++;bundle.journal.push({version:1,sequence:bundle.project.sequence,createdAt:Date.now(),update:Y.encodeStateAsUpdate(copy,Y.encodeStateVector(original)),point:true,checkpointId:uuid()});
          bundle.checkpoints.push({checkpointId:uuid(),sequence:bundle.project.sequence,createdAt:Date.now(),replayOnly:true,update:bundle.project.update});
        }
        const mapping=makeMapping(Object.fromEntries(projectNodes(copy).map(node=>[node.id,node.id])));bundle.project.id=uuid();bundle.recoveryLineage=plan.mode==='recovery'?target.lineageId:null;
        return await commit(scope,data,doc,{history:{install:bundle}},()=>value({projectId:bundle.project.id,lineageId:target.lineageId,changeId:target.changeId,idMapRef:mapping}));
      }finally{if(copy!==original)copy?.destroy();original.destroy();}
    }
    throw fail('unsupported_command','Unknown history operation.');
  }
  // Clean-up in history format 2 never writes a copy: the versions kept stay journal points
  // (pinned with `kept` so automatic thinning leaves them), versions removed lose their flag or
  // catalogue entry, and maintenance merges what lies between without adding full copies.
  // Stored bytes can only shrink (tests/history-size.test.mjs).
  function compactPlan2(data,command,revision){
    const inv=inventory(data);if(inv.items.some(item=>!item.available))throw fail('history_unavailable','Compaction needs every retained checkpoint locally.');
    const retained=new Set(command.keepCheckpointIds||[]);
    for(const id of retained)if(!inv.items.some(item=>item.checkpointId===id))throw fail('not_found','Unknown retention target.');
    for(const item of inv.items)if(item.pinned||['migration','pre-restore'].includes(item.reason))retained.add(item.checkpointId);
    const rows=inv.items.filter(item=>retained.has(item.checkpointId)),removedItems=inv.items.filter(item=>!retained.has(item.checkpointId));
    const retainedSequences=[...new Set([...rows.map(row=>row.sequence),data.project.sequence].filter(Number.isSafeInteger))].sort((a,b)=>a-b),availableSequences=[...new Set([...data.checkpoints,...data.journal].map(row=>row.sequence))].sort((a,b)=>a-b),removedSequences=availableSequences.filter(seq=>!retainedSequences.includes(seq));
    // Assets stay while any stored state still refers to them; merging releases them at the next clean-up.
    const retainedAssets=new Set(blobRefs(doc).map(ref=>ref.hash)),retainedObjects=new Set();
    for(const row of rows.filter(row=>!row.journal)){const cp=verifiedCheckpoint(row.checkpointRef,inv.objects,data.blobs);try{retainedObjects.add(row.checkpointRef);cp.manifest.updateChunks.forEach(ref=>retainedObjects.add(ref.hash));cp.manifest.assets.forEach(ref=>retainedAssets.add(ref.hash));}finally{cp.doc.destroy();}}
    // What remains after the merge: kept states, the head, full copies and catalogue objects.
    for(const row of data.checkpoints){const state=decode(row.update);try{blobRefs(state).forEach(ref=>retainedAssets.add(ref.hash));}finally{state.destroy();}}
    for(const sequence of retainedSequences){const state=replay(data,sequence);try{blobRefs(state).forEach(ref=>retainedAssets.add(ref.hash));}finally{state.destroy();}}
    for(const row of [...data.migrationBackupsV2,...(data.migrationBackup?[data.migrationBackup]:[])]){const snapshot=decode(row.update);try{blobRefs(snapshot).forEach(ref=>retainedAssets.add(ref.hash));}finally{snapshot.destroy();}}
    const foreignPins=data.projectHistoryObjects.filter(pin=>!pin.pin.startsWith('checkpoint:'));for(const pin of foreignPins)retainedObjects.add(pin.hash);
    const removedCatalog=new Set(removedItems.filter(item=>!item.journal&&data.historyCatalog.some(row=>row.checkpointId===item.checkpointId)).map(item=>item.checkpointId));
    for(const ref of data.projectHistoryObjects)if(ref.pin.startsWith('checkpoint:')&&!removedCatalog.has(ref.pin.slice(11)))retainedObjects.add(ref.hash);
    if(foreignPins.length)for(const blob of data.blobs)retainedAssets.add(blob.hash);
    const reachability={retainedAssetHashes:[...retainedAssets].sort(),releasedAssetHashes:data.blobs.map(blob=>blob.hash).filter(hash=>!retainedAssets.has(hash)).sort(),retainedObjectHashes:[...retainedObjects].sort(),releasedObjectHashes:data.objects.map(object=>object.hash).filter(hash=>!retainedObjects.has(hash)).sort()};
    const legacyId=row=>row.checkpointId||null,thin={keepPoints:rows.filter(row=>row.journal).map(row=>row.checkpointId),dropPoints:removedItems.filter(row=>row.journal).map(row=>row.checkpointId),
      keepCopies:rows.filter(row=>!row.journal&&!data.historyCatalog.some(c=>c.checkpointId===row.checkpointId)).map(row=>row.sequence),dropCopies:removedItems.filter(row=>!row.journal&&!removedCatalog.has(row.checkpointId)).map(row=>row.sequence),
      dropCatalog:[...removedCatalog],blobHashes:data.blobs.map(blob=>blob.hash)};void legacyId;
    const planId=addPlan({kind:'compact',format:2,thin,rows,removed:removedItems.map(item=>item.checkpointId),retainedSequences,removedSequences,reachability,sequence:data.project.sequence},revision);
    return planValue(planId,revision,{retainedCheckpointIds:rows.map(row=>row.checkpointId),removedCheckpointIds:removedItems.map(item=>item.checkpointId),retainedSequences,removedSequences,...reachability});
  }
  async function compact2(data,command,scope){
    const plan=getPlan(command.planId,'compact');if(plan.sequence!==data.project.sequence||plan.format!==2)throw fail('revision_conflict','Committed project changed; prepare again.');
    scope.commitGuard();
    // 1. Merge the steps between versions without removing any version or adding a full copy:
    //    every listed state is unchanged, so a failure after this changes nothing anyone sees.
    const everyVersion=inventory(data).items.map(item=>item.checkpointId);
    const premerge=await storage.maintainHistory(projectId,{createBases:false,keep:everyVersion});
    if(premerge?.skipped)throw fail('revision_conflict','History is being tidied in another tab; try again in a moment.');
    // 2. Release only assets that no state remaining after this clean-up refers to.
    const after=await storage.readHistoryData(projectId);scope.guard();
    if(after.project.sequence!==plan.sequence)throw fail('revision_conflict','Committed project changed; prepare again.');
    const removed=new Set(plan.removed),still=new Set(blobRefs(doc).map(ref=>ref.hash)),inv=inventory(after);
    for(const object of inv.objects)try{const manifest=JSON.parse(new TextDecoder().decode(object.bytes));if(manifest.checkpointId&&!removed.has(manifest.checkpointId))for(const ref of manifest.assets||[])still.add(ref.hash);}catch{}
    for(const row of after.checkpoints){const state=decode(row.update);try{blobRefs(state).forEach(ref=>still.add(ref.hash));}finally{state.destroy();}}
    replayEach(after,state=>blobRefs(state).forEach(ref=>still.add(ref.hash)),{hydrated:false});
    for(const row of [...after.migrationBackupsV2,...(after.migrationBackup?[after.migrationBackup]:[])]){const state=decode(row.update);try{blobRefs(state).forEach(ref=>still.add(ref.hash));}finally{state.destroy();}}
    const released=plan.reachability.releasedAssetHashes.filter(hash=>!still.has(hash)),keepBlobs=after.blobs.map(blob=>blob.hash).filter(hash=>!released.includes(hash));
    const reply=value(boundedDetails({retainedCheckpointIds:plan.rows.map(row=>row.checkpointId),removedCheckpointIds:plan.removed,retainedSequences:plan.retainedSequences,removedSequences:plan.removedSequences,...plan.reachability,
      retainedAssetHashes:[...new Set([...plan.reachability.retainedAssetHashes,...plan.reachability.releasedAssetHashes.filter(hash=>!released.includes(hash))])].sort(),releasedAssetHashes:[...released].sort()}));
    // 3. One guarded commit: removed versions lose their flag or catalogue entry (and objects),
    //    kept ones are pinned against automatic thinning, unreferenced assets go.
    const result=await commit(scope,after,doc,{history:{thin:{...plan.thin,blobHashes:keepBlobs}}},()=>reply);
    // 4. Merge across the removed versions (no new full copies); a busy tab leaves it to the next run.
    try{await storage.maintainHistory(projectId,{createBases:false});}catch(error){if(error?.code==='history_verification')throw error;}
    return result;
  }
  function makeMapping(mapping){return artifact(jsonBytes(mapping),'application/json').artifactId;}
  for(const op of Object.keys(fields))cleanups.push(commands.register(op,{durable:true,capabilities:op==='artifact.read'||op==='backup.export'?['read','export']:op.startsWith('history.')&&['history.list','history.diff'].includes(op)?['read']:['history'],limits:{pageMax:100,artifactBytes:65536,backupBytes:LIMITS.backupBytes},prepare:checked,commit:run}));
  const execute=async(command,bytes)=>{
    active();const reply=await commands.execute({version:2,requestId:uuid(),projectId,expectedRevision:commands.revision(),command},bytes);active();if(!reply.ok)throw fail(reply.error.code,reply.error.message);return reply.value;
  };
  // Naming or unpinning a version doesn't depend on file contents. A durable command still
  // refuses when another tab's or a direct-session peer's edit lands mid-commit, so the view tries again on the newer project.
  const settle=async command=>{for(let attempt=1;;attempt++){try{return await execute(command);}catch(error){if(error.code!=='revision_conflict'||attempt>=5)throw error;active();}}};
  // ----- History view: everything below reads existing commands and presents the result. -----
  let statusAmbient=true,detailGeneration=0,diffGeneration=0,activeDiff=null,cachedData=null,lastRevision=null,opener=null,keyHandler=null;
  const detailCache=new Map(),fileUrls=new Set();
  const setStatus=(text,tone='info')=>{state.status=text;state.statusTone=tone;statusAmbient=false;};
  const ambient=text=>{state.status=text;state.statusTone='info';statusAmbient=true;};
  const historyData=()=>{cachedData??=storage.readHistoryData(projectId).then(data=>({data,inv:inventory(data)}));return cachedData;};
  const nodesOf=target=>new Map(projectNodes(target).map(node=>[node.id,node]));
  const authorName=id=>{const profile=doc.getMap('authors').get(id);return profile?.displayName||'';};
  const chips=ids=>[...new Set(ids)].slice(0,4).map(id=>authorChip(id,id==='Unknown (legacy)'?'':authorName(id)));
  const itemFor=ref=>state.items.find(item=>item.checkpointRef===ref);
  const previousAvailable=ref=>{const index=state.items.findIndex(item=>item.checkpointRef===ref);return state.items.slice(index+1).find(item=>item.available)?.checkpointRef||null;};
  const latestAvailable=()=>state.items.find(item=>item.available)?.checkpointRef||null;
  const pairFor=(ref,compare)=>ref===CURRENT?{from:latestAvailable(),to:null}:compare==='current'?{from:ref,to:null}:{from:previousAvailable(ref),to:ref};
  const discussionRoots=['threads','messages','reviews','suggestions'];
  function otherChanges(result,before,after){
    const others=[],same=root=>JSON.stringify(before.getMap(root).toJSON())===JSON.stringify(after.getMap(root).toJSON());
    if(result.changes.some(change=>change.kind==='discussion')&&discussionRoots.some(root=>!same(root)))others.push('Comments or reviews changed');
    if(result.changes.some(change=>change.kind==='settings')&&before.getMap('meta').size)others.push('Project settings changed');
    return others;
  }
  async function openDoc(ref){
    if(ref===null)return{doc:new Y.Doc()};
    const {data,inv}=await historyData();return openVersion(data,inv,ref);
  }
  function describe(result,before,after){
    const files=fileChanges(result,nodesOf(before),nodesOf(after));
    return{files,others:otherChanges(result,before,after),authors:chips(result.contributors||[])};
  }
  function entryOf(item){
    const {key,label}=dayLabel(item.createdAt);
    return{ref:item.checkpointRef,dayKey:key,dayLabel:label,time:timeLabel(item.createdAt)||'Time unknown',label:item.versionId?item.label:'',tag:item.reason==='pre-restore'?'Before restore':item.reason==='migration'?'Starting point':'',available:!!item.available,status:item.status||''};
  }
  function rebuild(){
    const shown=state.filter==='named'?state.items.filter(item=>item.versionId):state.items,entries=shown.map(entryOf);
    if(state.filter!=='named'){const {key,label}=dayLabel(Date.now());entries.unshift({ref:CURRENT,dayKey:key,dayLabel:label,time:'Now',label:'',tag:'Current version',available:true,status:''});}
    state.groups=groupByDay(entries);
    state.focusRef=entries.some(entry=>entry.ref===state.selected)?state.selected:(entries[0]?.ref||'');
    const item=itemFor(state.selected);
    if(state.selected===CURRENT||!item)state.version={ref:CURRENT,current:true,title:'Current version',meta:'The project as it is now',available:true,status:'',named:false,pinned:false,versionId:''};
    else state.version={ref:item.checkpointRef,current:false,title:item.versionId?item.label:(item.reason==='pre-restore'?'Before restore':item.createdAt?whenLabel(item.createdAt):'Version with an unknown date'),meta:!item.createdAt?'Date unknown':item.versionId||item.reason==='pre-restore'?whenLabel(item.createdAt):'Saved automatically',available:!!item.available,status:item.status||'',named:!!item.versionId,pinned:!!item.pinned,versionId:item.versionId||''};
  }
  function releaseFile(){for(const url of fileUrls)URL.revokeObjectURL(url);fileUrls.clear();}
  function releaseDiff(){releaseFile();activeDiff?.before.destroy();activeDiff?.after.destroy();activeDiff=null;}
  const imageMime=path=>/\.svg$/i.test(path)?'image/svg+xml':/\.jpe?g$/i.test(path)?'image/jpeg':/\.(png|gif|webp)$/i.test(path)?'image/'+path.split('.').at(-1).toLowerCase():'';
  function assetView(file,before,after){
    const mime=imageMime(file.path),view={image:!!mime,beforeUrl:'',afterUrl:'',beforeSize:bytesLabel(file.asset.before?.size),afterSize:bytesLabel(file.asset.after?.size),change:''};
    if(file.asset.before&&file.asset.after)view.change=sizeChange(file.asset.before.size,file.asset.after.size);
    if(mime)for(const [side,target]of [['before',before],['after',after]])if(file.asset[side]){const url=URL.createObjectURL(new Blob([assetBytes(target,file.fileId)],{type:mime}));fileUrls.add(url);view[side+'Url']=url;}
    return view;
  }
  function renderFile(){
    releaseFile();state.fileDiff=null;if(!activeDiff)return;
    const file=activeDiff.files.find(file=>file.fileId===state.selectedFile);if(!file)return;
    const view={fileId:file.fileId,path:file.path,fromPath:file.fromPath,status:file.status,additions:String(file.additions),deletions:String(file.deletions),rows:[],notice:'',message:'',binary:file.binary,canDownloadBefore:file.status!=='added',canDownloadAfter:file.status!=='deleted',asset:null};
    try{
    if(file.asset)view.asset=assetView(file,activeDiff.before,activeDiff.after);
    else if(file.large){
      const whole=file.status==='added'?wholeFileRows(activeDiff.after.getText('text:'+file.fileId).toString(),'add'):file.status==='deleted'?wholeFileRows(activeDiff.before.getText('text:'+file.fileId).toString(),'delete'):null;
      if(whole){view.rows=whole.rows;view.notice=whole.rows.length<whole.total?'This file is too large to show in full. Showing the first '+whole.rows.length+' of '+whole.total+' lines.':'';}
      else view.notice='This change is too large to show here. Download either side to compare the files.';
    }else if(file.lineDiff){
      const parsed=parsePatch(file.lineDiff);view.rows=parsed.rows;if(parsed.truncated)view.notice='This change is too long to show in full. Showing the first '+parsed.rows.length+' lines.';
    }else if(file.status==='renamed')view.message='Renamed. The contents did not change.';
    else if(file.status==='added')view.message='This file is empty.';
    else view.message='No changes to the contents.';
    }catch(error){view.rows=[];view.asset=null;view.message='This file can’t be shown. '+friendly(error);}
    state.fileDiff=view;
  }
  async function loadDiff(){
    const generation=++diffGeneration,ref=state.selected,item=itemFor(ref);
    state.diffMessage='';
    if(ref!==CURRENT&&!item?.available){releaseDiff();state.files=[];state.others=[];state.selectedFile='';state.fileDiff=null;state.diffLoading=false;state.diffMessage='';emit();return;}
    state.diffLoading=true;emit();
    let before,after;
    try{
      const pair=pairFor(ref,state.compare);
      if(!pair.to)await context.flushSave?.();active();
      before=await openDoc(pair.from);after=pair.to?await openDoc(pair.to):{doc:cloneProject(doc)};
      if(generation!==diffGeneration){before.doc.destroy();after.doc.destroy();return;}
      const result=diff(before.doc,after.doc,{fromAt:before.manifest?.createdAt}),view=describe(result,before.doc,after.doc);
      releaseDiff();activeDiff={before:before.doc,after:after.doc,files:view.files};before=after=null;
      state.files=view.files.map(({fileId,path,fromPath,status,binary,additions,deletions,large})=>({fileId,path,fromPath,status,binary,large,additions:String(additions),deletions:String(deletions)}));
      state.others=view.others;
      state.selectedFile=view.files.some(file=>file.fileId===state.selectedFile)?state.selectedFile:(view.files[0]?.fileId||'');
      renderFile();
    }catch(error){
      before?.doc.destroy();after?.doc.destroy();
      if(generation===diffGeneration){releaseDiff();state.files=[];state.others=[];state.fileDiff=null;state.selectedFile='';state.diffMessage=friendly(error);}
    }finally{
      if(generation===diffGeneration){state.diffLoading=false;emit();}
    }
  }
  /** Each list row summarises the change from its predecessor; results are cached by the exact pair. */
  async function loadDetails(){
    const generation=++detailGeneration;
    let open=new Map();const release=keep=>{for(const [ref,target]of open)if(ref!==keep){target.doc.destroy();open.delete(ref);}};
    const fetch=async ref=>{if(!open.has(ref))open.set(ref,await openDoc(ref));return open.get(ref).doc;};
    try{
      let count=0;
      for(const item of state.items){
        if(generation!==detailGeneration||closed||!state.open)return;
        const ref=item.checkpointRef;
        if(!item.available){state.details={...state.details,[ref]:{summary:'',authors:chips((item.contributors||[]).filter(id=>id!=='Unknown (legacy)'))}};continue;}
        const from=previousAvailable(ref),key=from+'|'+ref;
        if(!detailCache.has(key)){
          const after=await fetch(ref);const before=from?await fetch(from):new Y.Doc();
          const view=describe(diff(before,after),before,after);if(!from)before.destroy();
          detailCache.set(key,{summary:summaryOf(view.files,view.others),authors:view.authors});
          release(from);
          if(++count%4===0){emit();await new Promise(resolve=>setTimeout(resolve));}
        }
        state.details={...state.details,[ref]:detailCache.get(key)};
      }
      const from=latestAvailable();
      if(generation!==detailGeneration||closed||!state.open)return;
      const live=cloneProject(doc);
      try{const before=from?await fetch(from):new Y.Doc(),view=describe(diff(before,live),before,live);if(!from)before.destroy();state.details={...state.details,[CURRENT]:{summary:view.files.length||view.others.length?summaryOf(view.files,view.others)+' since the last version':'Up to date',authors:view.authors}};}
      finally{live.destroy();}
      emit();
    }catch{
      // A version that cannot be read keeps its list row; its status comes from history.list.
    }finally{for(const target of open.values())target.doc.destroy();open=new Map();}
  }
  function friendly(error){
    const message=String(error?.message??error);
    if(['plan_expired','revision_conflict'].includes(error?.code))return'The project changed while this was open. Please review it again.';
    if(message==='Compaction needs every retained checkpoint locally.')return'History can’t be cleaned up while some versions are not available on this device.';
    return message.replace(/checkpoints/gi,'versions').replace(/checkpoint/gi,'version');
  }
  async function refresh(){const generation=++refreshGeneration;try{
    await context.flushSave?.();active();
    let result=await execute({op:'history.list',limit:100});const items=[...result.items];
    // Newest come first, so a project edit mid-way only leaves the oldest rows for the next refresh.
    for(let pages=1;result.nextCursor&&pages<10;pages++){try{result=await execute({op:'history.list',limit:100,cursor:result.nextCursor});items.push(...result.items);}catch(error){if(error.code!=='revision_conflict')throw error;break;}}
    if(generation===refreshGeneration){
      cachedData=null;state.items=items;
      if(!state.sourceExport&&statusAmbient)ambient(result.nextCursor?'Showing the most recent '+items.length+' versions.':AMBIENT);
      if(state.selected!==CURRENT&&!itemFor(state.selected)){state.selected=CURRENT;state.compare='previous';lastRevision=null;}
      rebuild();emit();
      if(state.open){
        const revision=commands.revision(),live=state.selected===CURRENT||state.compare==='current';
        if(lastRevision===null||(live&&revision!==lastRevision))void loadDiff();
        lastRevision=revision;void loadDetails();
      }
    }
  }catch(error){if(!closed){cachedData=null;state.items=state.items.map(item=>({...item,available:false,status:'Not available on this device'}));setStatus(friendly(error),'error');rebuild();emit();}}}
  async function ui(task){
    if(state.busy)return;state.busy=true;state.dialogError='';const preparing='One moment…';setStatus(preparing);emit();
    try{await context.flushSave?.();active();await task();if(state.status===preparing)ambient(AMBIENT);}
    catch(error){const text=friendly(error);setStatus(text,'error');if(state.dialog)state.dialogError=text;}
    finally{state.busy=false;emit();}
  }
  const rememberOpener=()=>{opener=typeof document==='undefined'?null:document.activeElement;};
  function focusSoon(find){if(typeof document==='undefined')return;let tries=0;const attempt=()=>{if(closed)return;const target=find();if(target&&!target.disabled&&target.offsetParent!==null){target.focus();if(document.activeElement===target)return;}if(++tries<20)setTimeout(attempt,25);};setTimeout(attempt,25);}
  function closeDialog(){state.dialog='';state.dialogError='';state.planId='';state.plan={};const target=opener;opener=null;focusSoon(()=>target?.isConnected?target:document.querySelector('.history-back'));}
  function detailsOf(result){return result.summary.detailsArtifact?JSON.parse(new TextDecoder().decode(artifacts.get(result.summary.detailsArtifact.artifactId))):result.summary;}
  async function planFiles(summary,ref){
    const target=await openDoc(ref);
    try{
      const before=nodesOf(doc),after=nodesOf(target.doc),folders=new Set(summary.changes.filter(change=>change.fileId&&(before.get(change.fileId)||after.get(change.fileId))?.folder).map(change=>change.fileId)).size;
      return{folders,files:fileChanges(summary,before,after).map(file=>({path:file.path,status:file.status,description:restoreLine(file)}))};
    }finally{target.doc.destroy();}
  }
  const showPlan=plan=>{state.plan=plan;state.dialog='plan';state.manageOpen=false;ambient(AMBIENT);};
  const versionRow=(id,head)=>{if(head)return{id,when:'Current version',name:'Always kept',head:true};const item=state.items.find(item=>item.checkpointId===id);if(!item)return{id,when:'Older version',name:'Not listed here'};return{id,when:whenLabel(item.createdAt),name:item.versionId?item.label:item.reason==='pre-restore'?'Before restore':item.reason==='migration'?'Starting point, always kept':'Automatic'};};
  const preparePlan=(mode,ref)=>ui(async()=>{
    const result=await execute({op:'history.restorePlan',checkpointRef:ref,mode}),summary=detailsOf(result),{files,folders:folderCount}=await planFiles(summary,ref),folderChanges=()=>folderCount,item=itemFor(ref),when=(item?.versionId?'“'+item.label+'” ':'')+'from '+whenLabel(item?.createdAt).replace(/^(Today|Yesterday)/,word=>word.toLowerCase());
    state.planId=result.planId;state.planKind=mode;
    if(mode==='copy'){
      const name=String(doc.getMap('meta').get('name')||'Project').slice(0,140)+' (restored)';
      showPlan({kind:'copy',title:'Restore as a copy?',intro:'This creates a new project called “'+name+'” using the version '+when+'. This project stays exactly as it is.',confirm:'Create the copy',files:[],notes:[],keep:[],remove:[],technical:[]});
    }else{
      const discussionChanged=summary.changes.some(change=>change.kind==='discussion'),changedIds=summary.idChanges.length,notes=[];
      const folders=folderChanges();
      if(folders)notes.push(folders===1?'1 folder also changes.':folders+' folders also change.');
      if(discussionChanged)notes.push('Comments and reviews go back to how they were in this version. Later ones stay on record.');
      if(summary.changes.some(change=>change.kind==='settings'))notes.push('Project settings go back to this version too.');
      if(changedIds)notes.push(changedIds===1?'One file changes type, so it comes back as a new file.':changedIds+' files change type, so they come back as new files.');
      notes.push('If the project changes before you confirm, you’ll be asked to review this again.');
      showPlan({kind:'current',title:'Restore into this project?',intro:'The project will change to match the version '+when+'. What you have now is saved first as a version called “Before restore”, so you can come back to it.',confirm:'Restore into this project',listTitle:files.length?(files.length===1?'1 file will change':files.length+' files will change'):'No files will change',files,notes,keep:[],remove:[],technical:[]});
    }
  });
  const technicalList=(label,values)=>({label:label+' ('+values.length+')',values:values.map(String).join(', ')||'None'});
  const actions={
    'history-toggle':()=>{
      state.open=!state.open;
      if(state.open){state.selected=CURRENT;state.compare='previous';state.filter='all';state.manageOpen=false;state.listOpen=false;state.copiedProject='';if(!state.sourceExport)ambient(AMBIENT);lastRevision=null;rebuild();emit();listenKeys();void refresh();}
      else{unlistenKeys();detailGeneration++;diffGeneration++;releaseDiff();cachedData=null;state.dialog='';state.dialogError='';state.planId='';state.plan={};state.manageOpen=false;state.fileDiff=null;state.files=[];emit();focusSoon(()=>document.querySelector('[aria-controls="project-history"]'));}
    },
    'history-refresh':()=>refresh(),'history-label':label=>{state.label=label;},
    'history-filter':filter=>{
      state.filter=filter==='named'?'named':'all';
      // Keep the diff in step with the list: a selection the filter hides moves to the newest version shown.
      const hidden=state.filter==='named'&&!state.items.some(item=>item.versionId&&item.checkpointRef===state.selected),first=state.items.find(item=>item.versionId);
      if(hidden&&first){state.selected=first.checkpointRef;rebuild();return loadDiff();}
      rebuild();emit();
    },
    'history-select':ref=>{
      if(ref!==CURRENT&&!itemFor(ref))return;
      state.selected=ref;state.listOpen=false;if(ref===CURRENT)state.compare='previous';
      if(statusAmbient===false&&!state.sourceExport&&!state.copiedProject&&state.statusTone!=='error')ambient(AMBIENT);
      rebuild();if(typeof document!=='undefined')document.querySelector('.history-diff-scroll')?.scrollTo(0,0);return loadDiff();
    },
    'history-compare':compare=>{if(state.selected===CURRENT)return;state.compare=compare==='current'?'current':'previous';return loadDiff();},
    'history-file':fileId=>{state.selectedFile=fileId;renderFile();emit();if(typeof document!=='undefined')document.querySelector('.history-diff-scroll')?.scrollTo(0,0);},
    'history-list':()=>{state.listOpen=!state.listOpen;emit();if(state.listOpen)focusSoon(()=>document.querySelector('.history-versions [tabindex="0"]')||document.querySelector('.history-filter button'));else focusSoon(()=>document.querySelector('.history-list-toggle'));},
    'history-manage':()=>{
      state.manageOpen=!state.manageOpen;emit();
      if(!state.manageOpen){focusSoon(()=>document.querySelector('.history-manage-toggle'));return;}
      // Leptos renders the panel after the state event; each panel action closes it through state.
      requestAnimationFrame(()=>{const panel=document.querySelector('.history-manage-panel');if(panel)openPanel(document.querySelector('.history-manage-toggle'),panel,{closeOnClick:false,onClose(){if(state.manageOpen){state.manageOpen=false;emit();}}});});
    },
    'history-name-open':()=>{rememberOpener();state.label='';state.dialogError='';state.dialog='name';state.manageOpen=false;emit();},
    'history-name':()=>ui(async()=>{const label=state.label.trim();await settle({op:'history.name',label});closeDialog();state.selected=CURRENT;state.copiedProject='';await refresh();setStatus('“'+label+'” saved locally.','success');}),
    'history-copy':ref=>{rememberOpener();return preparePlan('copy',ref);},
    'history-current':ref=>{rememberOpener();return preparePlan('current',ref);},
    'history-cancel-plan':()=>{closeDialog();emit();},
    'history-apply':()=>ui(async()=>{
      const kind=state.planKind,op=kind==='compact'?'history.compact':kind==='import'?'backup.import':'history.restore',result=await execute({op,planId:state.planId}),created=result.projectId&&result.projectId!==projectId;
      closeDialog();state.copiedProject=created?result.projectId:'';lastRevision=null;if(kind==='current'){state.selected=CURRENT;state.compare='previous';}await refresh();
      setStatus(kind==='compact'?'History cleaned up.':kind==='import'?'Backup added as a new project.':kind==='copy'?'Copy saved as a new project.':'Restored. What you had before is saved as “Before restore”.','success');
    }),
    'history-unpin':versionId=>ui(async()=>{await settle({op:'history.unpin',versionId});await refresh();setStatus('Clean up history can now remove this version.','success');}),
    'history-compact':()=>{rememberOpener();return ui(async()=>{
      const result=await execute({op:'history.compactPlan',keepCheckpointIds:[]}),summary=detailsOf(result);
      state.planId=result.planId;state.planKind='compact';
      const count=summary.removedCheckpointIds.length,lastKept=summary.retainedCheckpointIds.length-1;
      showPlan({kind:'compact',title:'Clean up history?',intro:count?'This permanently removes '+(count===1?'1 version':count+' versions')+' from this device to free up space. The current project is always kept, and so is any named version unless you chose “Allow clean-up” for it.':'No versions need removing. This only clears the saved steps between versions.',confirm:count?(count===1?'Remove 1 version':'Remove '+count+' versions'):'Clean up',listTitle:'',files:[],notes:[],
        keep:summary.retainedCheckpointIds.map((id,index)=>versionRow(id,index===lastKept)).sort((a,b)=>Number(!!b.head)-Number(!!a.head)),remove:summary.removedCheckpointIds.map(id=>versionRow(id,false)),
        technical:[technicalList('Version IDs kept',summary.retainedCheckpointIds),technicalList('Version IDs removed',summary.removedCheckpointIds),technicalList('Saved steps kept',summary.retainedSequences),technicalList('Saved steps removed',summary.removedSequences),technicalList('Stored files kept',summary.retainedAssetHashes),technicalList('Stored files released',summary.releasedAssetHashes),technicalList('Version data kept',summary.retainedObjectHashes),technicalList('Version data released',summary.releasedObjectHashes)]});
    });},
    'history-export':()=>ui(async()=>{state.manageOpen=false;state.sourceExport=false;try{const result=await execute({op:'backup.export'});download(artifacts.get(result.artifactId),'project.scribyra-backup',result.mimeType);setStatus('Complete backup exported. It includes deleted content and isn’t encrypted.','success');}catch(error){state.sourceExport=true;throw fail(error.code,'Complete backup could not be exported. Export a source ZIP to save the current files; it does not include history or discussions. Details: '+error.message);}}),
    'history-import':()=>{
      rememberOpener();state.manageOpen=false;emit();
      const input=document.createElement('input');input.type='file';input.accept='.scribyra-backup';input.addEventListener('change',()=>void ui(async()=>{const file=input.files?.[0];if(!file)return;if(file.size>LIMITS.backupBytes)throw fail('incomplete_backup','Backup exceeds 512 MiB.');const ref=uuid(),bytes=new Uint8Array(await file.arrayBuffer());active();const result=await execute({op:'backup.importPlan',attachmentRef:ref},new Map([[ref,bytes]]));
        state.planId=result.planId;state.planKind='import';const {versions,assets}=result.summary;
        showPlan({kind:'import',title:'Import this backup?',intro:'This adds a new project with '+(versions===1?'1 version':versions+' versions')+' and '+(assets===1?'1 stored file':assets+' stored files')+'. It includes deleted content, and this project isn’t changed.',confirm:'Import as a new project',files:[],notes:[],keep:[],remove:[],technical:[]});}),{once:true});input.click();
    },
    'history-download':side=>{
      const file=activeDiff?.files.find(file=>file.fileId===state.selectedFile),target=side==='before'?activeDiff?.before:activeDiff?.after;if(!file||!target)return;
      const name=file.path.split('/').at(-1)||'historical-file';
      if(file.asset)download(assetBytes(target,file.fileId),name,'application/octet-stream');else download(new TextEncoder().encode(target.getText('text:'+file.fileId).toString()),name,'text/plain');
    },
  };
  function listenKeys(){
    if(keyHandler||typeof document==='undefined')return;
    keyHandler=event=>{
      if(event.defaultPrevented||!state.open||document.querySelector('dialog[open]'))return;
      if(event.key==='Escape'){event.preventDefault();if(state.listOpen){void actions['history-list']();}else void actions['history-toggle']();return;}
      const option=event.target?.closest?.('.history-versions [role=option]');if(!option||!['ArrowUp','ArrowDown','Home','End'].includes(event.key))return;
      const options=[...option.closest('.history-versions').querySelectorAll('[role=option]')],index=options.indexOf(option),next=options[event.key==='Home'?0:event.key==='End'?options.length-1:index+(event.key==='ArrowUp'?-1:1)];
      event.preventDefault();if(next&&next!==option){next.focus();next.click();}
    };
    document.addEventListener('keydown',keyHandler);
  }
  function unlistenKeys(){if(keyHandler)document.removeEventListener('keydown',keyHandler);keyHandler=null;}
  function download(bytes,name,mime){active();const url=URL.createObjectURL(new Blob([bytes],{type:mime})),a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
  // Typing bursts (docs/history.md, "Stored history size"): consecutive plain edits, or
  // consecutive undo/redo steps, by this author in this session in one file share the change
  // record written by the burst's first transaction. Records are immutable, so a burst's record
  // is complete (and can be signed for direct sessions) the moment it is written. A burst ends
  // after a pause of BURST_PAUSE_MS, after BURST_MAX_MS, at another file, kind or attributed
  // origin, when any other change record appears (comments, reviews, suggestions, named
  // versions, restores, peers' records) and when a save becomes an automatic version.
  let burst=null;
  const endBurst=()=>{burst=null;};
  const changes=doc.getMap('changes'),watchRecords=event=>{if(burst&&[...event.keysChanged].some(key=>key!==burst.id))burst=null;};
  changes.observe(watchRecords);cleanups.push(()=>changes.unobserve(watchRecords));
  if(context.origins)cleanups.push(context.origins.registerAttribution(transaction=>{
    if(transaction.changed.has(changes)){burst=null;return;}
    const attributed=transaction.origin?.attribution,profile=attributed?.authorId?{id:attributed.authorId,displayName:attributed.displayName||'Agent',kind:'agent',ownerAuthorId:attributed.ownerAuthorId||author.id}:author;
    const kind=transaction.origin?.constructor?.name==='UndoManager'?'undo-redo':'source-edit',edited=changedTextFiles(doc,transaction);
    const fileIds=projectNodes(doc).filter(node=>transaction.changed.has(doc.getText('text:'+node.id))).map(node=>node.id),now=Date.now();
    const key=!attributed&&edited&&edited.size===1&&fileIds.length===1?[profile.id,sessionId,kind,fileIds[0]].join('\n'):null;
    if(key&&burst?.key===key&&now-burst.lastAt<BURST_PAUSE_MS&&now-burst.startedAt<BURST_MAX_MS&&now>=burst.lastAt&&changes.has(burst.id)){burst.lastAt=now;return;}
    const change=recordChange(doc,profile,{kind,fileIds,sessionId:attributed?.sessionId||sessionId});
    burst=key?{key,id:change.id,startedAt:now,lastAt:now}:null;
  }));
  const onUpdate=()=>{if(state.open){clearTimeout(refreshTimer);refreshTimer=setTimeout(()=>void refresh(),250);}};doc.on('update',onUpdate);
  if(context.registerTransfer)cleanups.push(context.registerTransfer('history',(operation,input)=>{active();if(operation==='attachment.read'){const bytes=attachments.get(input.attachmentRef);if(!bytes)throw fail('not_found','Attachment expired.');return bytes.slice();}if(operation==='backup.importPlan')return execute({op:'backup.importPlan',attachmentRef:input.attachmentRef,mode:input.mode},input.attachments);throw fail('unsupported_command','Unknown history transfer.');}));
  return{state,actions,editorExtensions:[],execute,endBurst,readAttachment(ref){active();const bytes=attachments.get(ref);if(!bytes)throw fail('not_found','Attachment expired.');return bytes.slice();},close(){closed=true;clearTimeout(refreshTimer);doc.off('update',onUpdate);unlistenKeys();cleanups.forEach(close=>close());plans.clear();artifacts.clear();attachments.clear();cursors.clear();releaseDiff();cachedData=null;}};
}
