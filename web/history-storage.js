import {baseDigest,resolveSuggestion,projectedRecord,binding} from './review-commands.js';
import * as Y from 'yjs';
import {blob_hash,history_validate_manifest,history_diff,history_restore_plan,history_discussion_projection,history_discussion_heads} from './pkg/scribyra_app.js';
import {blobRefs,installBlob,cloneProject,copyBlobs} from './assets.js';
import {projectNodes,validateProjectState,migrateProject} from './model.js';
import {ROOTS,SCHEMA_VERSION,LIMITS,lineageForProject} from './collaboration-schema.js';
import {RestoreOrigin} from './change-origins.js';
import {BURST_MAX_MS} from './history-compaction.js';

export const fail=(code,message)=>Object.assign(new Error(message),{code});
export const jsonBytes=value=>new TextEncoder().encode(JSON.stringify(value));
export const parseBytes=bytes=>JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));
export function decode(update){const doc=new Y.Doc();try{Y.applyUpdate(doc,update);return doc;}catch(error){doc.destroy();throw fail('history_unavailable','Invalid checkpoint update: '+error.message);}}
export function hydrate(doc,blobs){
  const map=new Map(blobs.map(blob=>[blob.hash,blob.bytes]));
  for(const ref of blobRefs(doc)){const bytes=map.get(ref.hash);if(!bytes)throw fail('history_unavailable','A retained asset is missing.');installBlob(doc,ref,bytes);}
  validateProjectState(doc);return doc;
}
export function checkpoint(doc,{checkpointId=crypto.randomUUID(),createdAt=Date.now(),parents=[],validated=false}={}){
  // `validated`: the caller validated this exact, unchanged doc a moment ago (inventory's hydrate).
  if(!validated)validateProjectState(doc);const update=Y.encodeStateAsUpdate(doc),objects=[],updateChunks=[];
  for(let offset=0;offset<update.length;offset+=LIMITS.chunkBytes){const bytes=update.slice(offset,offset+LIMITS.chunkBytes),hash=blob_hash(bytes);objects.push({hash,bytes});updateChunks.push({hash,size:bytes.length});}
  const manifest={version:1,checkpointId,lineageId:doc.getMap('meta').get('lineageId'),schemaVersion:doc.getMap('meta').get('schemaVersion')||1,createdAt,changeIds:[...doc.getMap('changes').keys()].sort(),updateChunks,assets:blobRefs(doc).sort((a,b)=>a.hash.localeCompare(b.hash)),parents};
  const bytes=jsonBytes(manifest);history_validate_manifest(new TextDecoder().decode(bytes));
  const hash=blob_hash(bytes);objects.push({hash,bytes});return{manifest,hash,objects,update,pins:objects.map(object=>({hash:object.hash,pin:'checkpoint:'+checkpointId}))};
}
export function verifiedCheckpoint(ref,objects,blobs){
  const map=new Map(objects.map(object=>[object.hash,object.bytes])),bytes=map.get(ref);
  if(!bytes||blob_hash(bytes)!==ref)throw fail('history_unavailable','Checkpoint manifest is missing or corrupt.');
  try{history_validate_manifest(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}catch(error){throw fail('history_unavailable',String(error));}
  const manifest=parseBytes(bytes),parts=[];let size=0;
  for(const chunk of manifest.updateChunks){const bytes=map.get(chunk.hash);if(!bytes||bytes.length!==chunk.size||blob_hash(bytes)!==chunk.hash)throw fail('history_unavailable','Checkpoint chunk is missing or corrupt.');parts.push(bytes);size+=bytes.length;if(size>LIMITS.backupBytes)throw fail('history_unavailable','Checkpoint exceeds backup bound.');}
  const update=new Uint8Array(size);let offset=0;for(const bytes of parts){update.set(bytes,offset);offset+=bytes.length;}
  const doc=decode(update);
  try{
    if((doc.getMap('meta').get('schemaVersion')||1)!==manifest.schemaVersion||doc.getMap('meta').get('lineageId')!==manifest.lineageId)throw fail('history_unavailable','Checkpoint identity does not match its manifest.');
    if(JSON.stringify(blobRefs(doc).sort((a,b)=>a.hash.localeCompare(b.hash)))!==JSON.stringify([...manifest.assets].sort((a,b)=>a.hash.localeCompare(b.hash))))throw fail('history_unavailable','Checkpoint asset closure does not match.');
    hydrate(doc,blobs);return{manifest,update,doc};
  }catch(error){doc.destroy();throw error;}
}
/** Open any listed version: stored objects for named and earlier versions, a replay for journal points. */
export function openVersion(data,inv,ref){
  const item=inv.items.find(entry=>entry.checkpointRef===ref);
  if(!item?.journal)return verifiedCheckpoint(ref,inv.objects,data.blobs);
  if(!item.available)throw fail('history_unavailable',item.reason||'Checkpoint is unavailable.');
  const doc=replay(data,item.sequence);
  try{const cp=checkpoint(doc,{checkpointId:item.checkpointId,createdAt:item.createdAt||0,validated:true});return{manifest:cp.manifest,update:cp.update,doc,objects:cp.objects,hash:cp.hash,pins:cp.pins};}
  catch(error){doc.destroy();throw error;}
}
export function unpinned(doc){return new Set([...doc.getMap('discussionEvents').values()].filter(event=>event.kind==='versionUnpin').map(event=>event.targetId));}
/** First sequence a journal row covers. Format-2 maintenance merges consecutive rows into one
 * (`from`..`sequence`); only states at row ends, and full copies, can be rebuilt. */
export const rowFrom=row=>row.from??row.sequence;
const validRow=row=>[1,2].includes(row.version)&&Number.isSafeInteger(row.sequence)&&Number.isSafeInteger(rowFrom(row))&&rowFrom(row)<=row.sequence&&rowFrom(row)>=1&&(row.version===2||rowFrom(row)===row.sequence);
function applyRow(doc,entry,next){
  if(!validRow(entry)||rowFrom(entry)!==next)throw fail('history_unavailable','The project journal has a gap or unsupported entry.');
  Y.applyUpdate(doc,entry.update);return entry.sequence+1;
}
/** A full copy that falls strictly inside a merged row cannot start a replay. */
const insideMerged=(journal,sequence)=>journal.some(row=>rowFrom(row)<=sequence&&sequence<row.sequence);
export function replay(data,sequence){
  const target=sequence??data.project.sequence,base=data.checkpoints.filter(c=>c.sequence<=target&&!insideMerged(data.journal,c.sequence)).sort((a,b)=>b.sequence-a.sequence)[0];
  if(!base)throw fail('history_unavailable','No recovery checkpoint is available.');
  const doc=decode(base.update);let next=base.sequence+1;
  try{
    for(const entry of data.journal.filter(e=>e.sequence>base.sequence&&e.sequence<=target).sort((a,b)=>a.sequence-b.sequence))next=applyRow(doc,entry,next);
    if(next!==target+1)throw fail('history_unavailable','The project journal is incomplete.');
    return hydrate(doc,data.blobs);
  }catch(error){doc.destroy();throw error;}
}
/** Visit every journal row's end state as replay(data with only the checkpoints before it, sequence) builds it,
 * decoding each checkpoint once instead of once per entry. Validation of long histories stays linear. */
export function replayEach(data,visit,{hydrated=true}={}){
  const checkpoints=[...data.checkpoints].sort((a,b)=>a.sequence-b.sequence),rows=[...data.journal].sort((a,b)=>a.sequence-b.sequence);
  const usable=checkpoints.filter(c=>!insideMerged(rows,c.sequence));
  for(let index=0;index<rows.length;){
    const base=usable.filter(c=>c.sequence<rowFrom(rows[index])).at(-1);
    if(!base)throw fail('history_unavailable','No recovery checkpoint is available.');
    // Entries after this checkpoint, up to and including the next usable one, replay from it.
    // The end is never before the current row, so every pass makes progress.
    const end=usable.find(c=>c.sequence>base.sequence&&c.sequence>=rows[index].sequence)?.sequence??Infinity,doc=decode(base.update);let next=base.sequence+1;
    try{
      while(index<rows.length&&rows[index].sequence<=end){
        const entry=rows[index++];next=applyRow(doc,entry,next);
        visit(hydrated?hydrate(doc,data.blobs):doc,entry.sequence,entry);
      }
    }finally{doc.destroy();}
  }
}
/** Automatic versions stored as journal points have no derived objects: their reference names the point. */
export const pointRef=checkpointId=>blob_hash(new TextEncoder().encode(JSON.stringify(['scribyra-journal-point',1,checkpointId])));
/** Names without complete local objects remain visible, but never restorable. */
// Opening History lists two pages and loads a diff, each reading an inventory that decodes
// every automatic checkpoint (docs/large-projects.md). Reuse the last result while the stored
// history is the same, for a short while only: it holds every checkpoint's derived objects.
let lastInventory=null;
const INVENTORY_REUSE_MS=60_000;
// Checkpoint rows are written once under a fresh id (compaction writes new ones), so their
// identity and size stand for their bytes; hashing them all again cost seconds per call.
function inventoryKey(data){
  return blob_hash(new TextEncoder().encode(JSON.stringify([data.project.id,data.project.sequence,blob_hash(data.project.update),
    data.checkpoints.map(c=>[c.checkpointId??null,c.sequence,c.createdAt??0,!!c.replayOnly,!!c.migration,c.catalogSourceId??null,c.update.length]),
    data.historyCatalog.map(r=>[r.checkpointId,r.checkpointRef,r.sequence,r.reason]),data.objects.map(o=>o.hash),data.blobs.map(b=>b.hash),
    data.migrationBackupsV2.map(b=>b.sequence??0),data.journal.map(r=>[r.sequence,rowFrom(r),r.point?r.checkpointId:0,r.update.length])])));
}
export function inventory(data){
  const key=inventoryKey(data);
  if(lastInventory?.key!==key)lastInventory={key,value:inventoryNow(data)};
  clearTimeout(lastInventory.timer);const held=lastInventory;held.timer=setTimeout(()=>{if(lastInventory===held)lastInventory=null;},INVENTORY_REUSE_MS);held.timer.unref?.();
  const {items,objects,catalog}=held.value;
  return{items:items.map(item=>({...item})),objects:[...objects],catalog:catalog.map(row=>({...row}))};
}
function inventoryNow(data){
  const derived=new Map(),entries=new Map(),objects=[...data.objects],catalog=[...data.historyCatalog],current=hydrate(decode(data.project.update),data.blobs);
  try{
    for(const row of data.checkpoints){
      if(row.replayOnly)continue;
      const doc=hydrate(decode(row.update),data.blobs);let migrated=false;
      try{
        if((doc.getMap('meta').get('schemaVersion')||1)<SCHEMA_VERSION){migrated=true;
          // Cataloguing a legacy checkpoint must produce the same immutable bytes on every read.
          const clients=Y.decodeStateVector(Y.encodeStateVector(doc));let client=parseInt(blob_hash(row.update).slice(0,8),16);
          while(clients.has(client))client=(client+1)>>>0;doc.clientID=client;migrateProject(doc,row.catalogSourceId||data.project.id);
        }
        const cp=checkpoint(doc,{checkpointId:row.checkpointId||lineageForProject((row.catalogSourceId||data.project.id)+':'+row.sequence),createdAt:row.createdAt||0,validated:!migrated});
        objects.push(...cp.objects);const prior=catalog.find(c=>c.checkpointId===cp.manifest.checkpointId);
        if(!prior){
          catalog.push({checkpointId:cp.manifest.checkpointId,checkpointRef:cp.hash,sequence:row.sequence,reason:row.sequence===0||row.migration||data.migrationBackupsV2.some(backup=>(backup.sequence??0)+1===row.sequence)?'migration':'automatic'});
          // These objects were just built from this validated doc: verify it here rather than decoding them again.
          try{restorable(doc);derived.set(cp.hash,{createdAt:cp.manifest.createdAt,available:true,contributors:cp.manifest.changeIds.map(id=>doc.getMap('changes').get(id)?.authorId).filter(Boolean)});}
          catch(error){derived.set(cp.hash,{available:false,reason:error.message});}
        }
      }finally{doc.destroy();}
    }
    // Journal points: one linear replay; each point is checked in full when it is opened or restored.
    if(data.journal.some(row=>row.point)){
      const pending=new Map(data.journal.filter(row=>row.point).map(row=>[row.sequence,row]));
      try{
        replayEach(data,(doc,_sequence,entry)=>{
          if(!entry.point)return;pending.delete(entry.sequence);
          entries.set(pointRef(entry.checkpointId),{checkpointId:entry.checkpointId,checkpointRef:pointRef(entry.checkpointId),sequence:entry.sequence,reason:'automatic',journal:true,createdAt:entry.createdAt,available:true,label:'Automatic checkpoint',contributors:[...new Set([...doc.getMap('changes').values()].map(change=>change?.authorId).filter(Boolean))]});
        },{hydrated:false});
      }catch(error){
        for(const row of pending.values())entries.set(pointRef(row.checkpointId),{checkpointId:row.checkpointId,checkpointRef:pointRef(row.checkpointId),sequence:row.sequence,reason:'automatic',journal:true,createdAt:row.createdAt,available:false,label:'Unavailable checkpoint',reason:error.message});
      }
      for(const row of pending.values())if(!entries.has(pointRef(row.checkpointId)))entries.set(pointRef(row.checkpointId),{checkpointId:row.checkpointId,checkpointRef:pointRef(row.checkpointId),sequence:row.sequence,reason:'automatic',journal:true,createdAt:row.createdAt,available:false,label:'Unavailable checkpoint',reason:'The project journal is incomplete.'});
    }
    for(const row of catalog){
      const known=derived.get(row.checkpointRef);
      if(known){entries.set(row.checkpointRef,known.available?{...row,createdAt:known.createdAt,available:true,label:row.reason==='pre-restore'?'Before restore':'Automatic checkpoint',contributors:known.contributors}:{...row,available:false,label:'Unavailable checkpoint',reason:known.reason});continue;}
      let cp;
      try{cp=verifiedCheckpoint(row.checkpointRef,objects,data.blobs);restorable(cp.doc);entries.set(row.checkpointRef,{...row,createdAt:cp.manifest.createdAt,available:true,label:row.reason==='pre-restore'?'Before restore':'Automatic checkpoint',contributors:cp.manifest.changeIds.map(id=>cp.doc.getMap('changes').get(id)?.authorId).filter(Boolean)});}
      catch(error){entries.set(row.checkpointRef,{...row,available:false,label:'Unavailable checkpoint',reason:error.message});}
      finally{cp?.doc.destroy();}
    }
    const removed=unpinned(current);
    for(const version of current.getMap('versions').values()){
      const previous=entries.get(version.checkpointRef);if(removed.has(version.id)&&!objects.some(object=>object.hash===version.checkpointRef))continue;let cp;
      try{cp=verifiedCheckpoint(version.checkpointRef,objects,data.blobs);restorable(cp.doc);entries.set(version.checkpointRef,{...previous,checkpointRef:version.checkpointRef,checkpointId:cp.manifest.checkpointId,createdAt:cp.manifest.createdAt,available:true,label:version.label,versionId:version.id,pinned:previous?.pinned||!removed.has(version.id),contributors:[...new Set(cp.manifest.changeIds.map(id=>cp.doc.getMap('changes').get(id)?.authorId).filter(Boolean))]});}
      catch(error){entries.set(version.checkpointRef,{...previous,checkpointRef:version.checkpointRef,versionId:version.id,label:version.label,pinned:!removed.has(version.id),available:false,reason:error.message});}
      finally{cp?.doc.destroy();}
    }
    return{items:[...entries.values()].sort((a,b)=>(b.createdAt||0)-(a.createdAt||0)||a.checkpointRef.localeCompare(b.checkpointRef)),objects:[...new Map(objects.map(o=>[o.hash,o])).values()],catalog};
  }finally{current.destroy();}
}
export function snapshot(doc){
  const discussion=Object.fromEntries(ROOTS.filter(root=>!['changes','versions'].includes(root)).map(root=>[root,doc.getMap(root).toJSON()]));
  const meta=doc.getMap('meta').toJSON();delete meta.lineageId;
  return{files:projectNodes(doc).map(node=>({id:node.id,path:node.path,text:node.binary||node.folder?null:doc.getText('text:'+node.id).toString(),asset:node.binary?doc.getMap('assets').get(node.id):null,folder:node.folder})),meta,trash:Object.fromEntries(doc.getMap('trash')),discussion,contributors:[...new Set([...doc.getMap('changes').values()].map(change=>change.authorId))],changeAuthors:Object.fromEntries([...doc.getMap('changes')].map(([id,change])=>[id,change.authorId]))};
}
export function diff(before,after,{fromAt}={}){
  const result=JSON.parse(history_diff(JSON.stringify(snapshot(before)),JSON.stringify(snapshot(after))));
  // A typing burst that began up to BURST_MAX_MS before the earlier version may have continued
  // after it without a new record (another tab, or a direct-session peer, whose bursts this tab
  // cannot end). Name those authors when their file changed, rather than lose them.
  if(Number.isFinite(fromAt)){
    const changed=new Set(result.changes.filter(change=>change.kind==='text').map(change=>change.fileId)),contributors=new Set(result.contributors);
    for(const change of before.getMap('changes').values())if(['source-edit','undo-redo'].includes(change?.kind)&&change.createdAt>fromAt-BURST_MAX_MS&&change.createdAt<=fromAt&&change.fileIds?.some(id=>changed.has(id))&&after.getMap('changes').has(change.id))contributors.add(change.authorId);
    result.contributors=[...contributors].sort();
  }
  return result;
}
export {localAuthor as authorProfile} from './local-author.js';
export function recordChange(doc,author,{id=crypto.randomUUID(),kind,fileIds=[],restoreOf,sessionId=crypto.randomUUID()}={}){
  const common={version:1,authorId:author.id,changeId:id,createdAt:Date.now()};
  if(!doc.getMap('authors').has(author.id))doc.getMap('authors').set(author.id,{...common,id:author.id,kind:author.kind||'human',displayName:author.displayName,ownerAuthorId:author.ownerAuthorId||null});
  doc.getMap('changes').set(id,{...common,id,actorKind:author.kind||'human',sessionId,kind,fileIds,suggestionId:null,proposedBy:null,undoOf:null,restoreOf:restoreOf||null});return{id,common};
}
const equal=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
function replaceMap(map,values){for(const key of map.keys())if(!Object.hasOwn(values,key))map.delete(key);for(const [key,value]of Object.entries(values))if(!equal(map.get(key),value))map.set(key,structuredClone(value));}
/** An explicit new edit on the current replica; historical Yjs updates are never applied as a rewind. */
export function restoreIdMap(current,target){
  const mapping=Object.create(null);for(const [id,node]of [...target.getMap('files'),...[...target.getMap('trash')].map(([id,value])=>[id,value.node])]){
    const existing=current.getMap('files').get(id)||current.getMap('trash').get(id)?.node;
    mapping[id]=existing&&(!!existing.binary!==!!node.binary||!!existing.folder!==!!node.folder)?crypto.randomUUID():id;
  }return mapping;
}
/** Restore boundaries select records/events; comments and reviews interpret their own decisions. */
export function discussionProjection(doc,root,id){
  const events=[...doc.getMap('discussionEvents').values()].filter(event=>event.targetId===id);
  try{return JSON.parse(history_discussion_projection(root,id,JSON.stringify(doc.getMap(root).get(id)||null),JSON.stringify(events)));}
  catch(error){throw fail('history_unavailable',String(error));}
}
export function discussionHeads(doc,id){
  const events=[...doc.getMap('discussionEvents').values()].filter(event=>event.targetId===id);
  try{return JSON.parse(history_discussion_heads(id,JSON.stringify(events)));}
  catch(error){throw fail('history_unavailable',String(error));}
}
export function restorable(doc){
  for(const root of ['threads','messages','suggestions','reviews','anchors'])for(const id of doc.getMap(root).keys())discussionProjection(doc,root,id);
}
export function restoreCurrent(current,target,{author,sessionId,checkpointId,anchors,idMap:preparedMap}={}){
  restorable(target);
  const staged=cloneProject(current),idMap=Object.assign(Object.create(null),preparedMap||restoreIdMap(current,target)),changeId=crypto.randomUUID(),restoredAnchors=[];
  try{
    staged.transact(()=>{
      const remapNode=node=>({...node,id:idMap[node.id]||node.id,parentId:idMap[node.parentId]||node.parentId});
      const targetFiles=Object.fromEntries([...target.getMap('files')].map(([id,node])=>[idMap[id],remapNode(node)])),targetTrash=Object.fromEntries([...target.getMap('trash')].map(([id,value])=>[idMap[id],{...value,node:remapNode(value.node)}]));
      const meta=target.getMap('meta').toJSON();meta.lineageId=current.getMap('meta').get('lineageId');meta.mainFile=idMap[meta.mainFile]||meta.mainFile;
      replaceMap(staged.getMap('meta'),meta);replaceMap(staged.getMap('files'),targetFiles);replaceMap(staged.getMap('trash'),targetTrash);replaceMap(staged.getMap('assets'),Object.fromEntries([...target.getMap('assets')].map(([id,ref])=>[idMap[id]||id,ref])));
      const ids=new Set([...current.getMap('files').keys(),...current.getMap('trash').keys(),...Object.values(idMap)]);const sourceIds=Object.assign(Object.create(null),Object.fromEntries(Object.entries(idMap).map(([from,to])=>[to,from])));
      for(const id of ids){const text=staged.getText('text:'+id),desired=sourceIds[id]?target.getText('text:'+sourceIds[id]).toString():'';if(text.toString()!==desired){text.delete(0,text.length);text.insert(0,desired);}}
      // Keep later immutable events as history. Restore projections supersede their observed heads.
      for(const root of ROOTS.filter(root=>!['changes','versions'].includes(root)))for(const [id,value]of target.getMap(root))if(!staged.getMap(root).has(id))staged.getMap(root).set(id,structuredClone(value));
      const change=recordChange(staged,author,{id:changeId,sessionId,kind:'restore',fileIds:[...ids],restoreOf:checkpointId});
      for(const root of ['threads','messages','suggestions','reviews','anchors'])for(const id of staged.getMap(root).keys()){
        const eventId=crypto.randomUUID(),parents=discussionHeads(staged,id),targetState=discussionProjection(target,root,id),projection=targetState.projection;
        let anchor=null;
        if(root==='anchors'&&projection&&anchors&&!targetState.detached){try{
          for(const suggestion of target.getMap('suggestions').values())if(suggestion.anchorId===id){const active=projectedRecord(target,'suggestions',suggestion.id);if(active)resolveSuggestion(target,active,anchors,{ignoreDecision:true});}
          const effective=binding(target,{anchorId:id});anchor=anchors.checkpointBinding(target,staged,effective,idMap[effective.fileId]||effective.fileId);
        }catch{}}
        if(anchor)restoredAnchors.push({id,anchor});
        staged.getMap('discussionEvents').set(eventId,{...change.common,id:eventId,targetId:id,parents,kind:'restoreProjection',payload:{root,checkpointId,projection,eventIds:targetState.eventIds,idMap,anchor,detached:root==='anchors'&&!anchor,superseded:true}});
        if(root==='reviews'&&projection){const authority=crypto.randomUUID();staged.getMap('discussionEvents').set(authority,{...change.common,id:authority,targetId:id,parents:[eventId],kind:'authorityTransfer',payload:{acceptanceAuthorityId:author.ownerAuthorId||author.id,authorityEpoch:1,restored:true}});}
      }
      // Explicit restoration creates fresh item identities. Rebind insertion
      // digests only when the original proposal was valid at the checkpoint.
      for(const event of staged.getMap('discussionEvents').values())if(event.changeId===changeId&&event.kind==='restoreProjection'&&event.payload.root==='suggestions'){
        const suggestion=event.payload.projection;if(!suggestion||suggestion.before!=='')continue;
        const binding=restoredAnchors.find(a=>a.id===suggestion.anchorId)?.anchor;if(!binding)continue;
        const resolved=anchors.resolve(staged,binding);
        if(resolved.status==='attached')staged.getMap('discussionEvents').set(event.id,{...event,payload:{...event.payload,projection:{...suggestion,baseDigest:baseDigest(staged,binding,'',resolved.start)}}});
      }
    },new RestoreOrigin({authorId:author.id,sessionId,changeId}));
    copyBlobs(target,staged);if(staged.getMap('meta').get('schemaVersion')<SCHEMA_VERSION)migrateProject(staged);validateProjectState(staged);return{doc:staged,changeId,idMap,restoredAnchors};
  }catch(error){staged.destroy();throw error;}
}
export function fork(doc,{author,sessionId,checkpointId,name,preserveLineage=false}={}){
  restorable(doc);
  const copy=cloneProject(doc),lineageId=preserveLineage?doc.getMap('meta').get('lineageId'):crypto.randomUUID(),changeId=crypto.randomUUID();
  copy.transact(()=>{
    copy.getMap('meta').set('lineageId',lineageId);if(name)copy.getMap('meta').set('name',name);
    const change=recordChange(copy,author,{id:changeId,sessionId,kind:preserveLineage?'backup-import':'restore-copy',restoreOf:checkpointId});
    for(const [id,review]of copy.getMap('reviews')){
      // Retain immutable review evidence; the local authority is a new event.
      {const eventId=crypto.randomUUID();copy.getMap('discussionEvents').set(eventId,{...change.common,id:eventId,targetId:id,parents:discussionProjection(copy,'reviews',id).heads,kind:'authorityTransfer',payload:{acceptanceAuthorityId:author.ownerAuthorId||author.id,authorityEpoch:1,restored:true}});}
    }
    const id=crypto.randomUUID();copy.getMap('discussionEvents').set(id,{...change.common,id,targetId:changeId,parents:[],kind:'restoreProjection',payload:{fromLineage:doc.getMap('meta').get('lineageId'),checkpointId,mode:'copy'}});
  });if(copy.getMap('meta').get('schemaVersion')<SCHEMA_VERSION)migrateProject(copy);validateProjectState(copy);return{doc:copy,lineageId,changeId};
}
export function bundleForCopy(doc,{projectId=crypto.randomUUID(),objects=[],catalog=[],blobs=[],checkpointId=crypto.randomUUID()}={}){
  const update=Y.encodeStateAsUpdate(doc),createdAt=Date.now();return{project:{id:projectId,schemaVersion:SCHEMA_VERSION,name:doc.getMap('meta').get('name')||'Restored project',files:projectNodes(doc).filter(n=>!n.folder).length,sequence:0,updatedAt:createdAt,update,history:{version:2,pointAt:createdAt,maintainedSequence:0,maintainedAt:createdAt}},checkpoints:[{checkpointId,sequence:0,replayOnly:true,createdAt,update}],journal:[],historyCatalog:catalog,objects,projectHistoryObjects:catalog.flatMap(row=>{const verified=verifiedCheckpoint(row.checkpointRef,objects,blobs);try{return[...verified.manifest.updateChunks.map(r=>r.hash),row.checkpointRef].map(hash=>({hash,pin:'checkpoint:'+row.checkpointId}));}finally{verified.doc.destroy();}}),blobs,migrationBackupsV2:[]};
}

export function validateRestore(before,after,mode,capabilities,idMap){restorable(after);try{return JSON.parse(history_restore_plan(JSON.stringify(snapshot(before)),JSON.stringify(snapshot(after)),mode,JSON.stringify(capabilities),JSON.stringify(idMap)));}catch(error){let detail;try{detail=JSON.parse(String(error));}catch{}throw fail(detail?.code||'invalid_request',detail?.message||String(error));}}
