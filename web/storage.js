import {concurrentBinaryVersions,binaryRecoverySources} from './binary-recovery.js';
import {observe,observed,finishError} from './observability.js';
import {schemaReady,DATABASE_VERSION,LIMITS,lineageForProject} from './collaboration-schema.js';
import {validate_collaboration_migration} from './pkg/scribyra_app.js';
import {blob_hash} from './pkg/scribyra_app.js';
import {publishStorageChange} from './storage-events.js';
import { openDB } from 'idb';
import * as Y from 'yjs';
import { migrateProject, projectFiles, projectNodes, validateProjectState, SCHEMA_VERSION } from './model.js';
import { blobRefs, knownBlob, copyBlobs, cloneProject, installBlob, verifyBlob } from './assets.js';
import {pointDue,POINT_GAP_MS,BASE_MIN_BYTES,MAINTAIN_SAVES,MAINTAIN_INTERVAL_MS,SEGMENT_BYTES,ladder,redundantChanges,verifyCoalesced,sharedInSession} from './history-compaction.js';
export {pointDue} from './history-compaction.js';

// Stored history (docs/history.md, "Stored history size"): the journal keeps one minimal update
// per save, automatic versions are journal rows marked `point`, and maintenance merges the
// rows between the versions it keeps. Full copies are written only as sparse replay bases.
const HISTORY_FORMAT = 2;
const HISTORY_STORES = ['projects', 'journal', 'checkpoints'];
const BLOB_STORES = ['blobs', 'projectBlobs'];
const OBJECT_STORES=['historyObjects','projectHistoryObjects','historyCatalog'];
const db = schemaReady.then(()=>openDB('scribyra-v1', DATABASE_VERSION, { upgrade(db,oldVersion,newVersion,transaction) {
  // The open promise reports upgrade failure; consume the wrapper's duplicate rejection.
  void transaction.done.catch(()=>{});
  if(!db.objectStoreNames.contains('migrationBackupsV2'))db.createObjectStore('migrationBackupsV2',{keyPath:['projectId','fromVersion']}).createIndex('projectId','projectId');
  if(!db.objectStoreNames.contains('historyObjects'))db.createObjectStore('historyObjects',{keyPath:'hash'});
  if(!db.objectStoreNames.contains('projectHistoryObjects')){
    const refs=db.createObjectStore('projectHistoryObjects',{keyPath:['projectId','hash','pin']});refs.createIndex('projectId','projectId');refs.createIndex('hash','hash');
  }
  if(!db.objectStoreNames.contains('historyCatalog'))db.createObjectStore('historyCatalog',{keyPath:['projectId','checkpointId']}).createIndex('projectId','projectId');
  if (!db.objectStoreNames.contains('projects')) db.createObjectStore('projects', { keyPath: 'id' });
  if (!db.objectStoreNames.contains('migrationBackups')) db.createObjectStore('migrationBackups', { keyPath: 'id' });
  for (const store of ['journal', 'checkpoints']) if (!db.objectStoreNames.contains(store)) {
    db.createObjectStore(store, { keyPath: ['projectId', 'sequence'] }).createIndex('projectId', 'projectId');
  }
  if (!db.objectStoreNames.contains('deletedProjects')) db.createObjectStore('deletedProjects', { keyPath: 'id' });
  if (!db.objectStoreNames.contains('blobs')) db.createObjectStore('blobs', { keyPath: 'hash' });
  if (!db.objectStoreNames.contains('projectBlobs')) {
    const refs=db.createObjectStore('projectBlobs',{keyPath:['projectId','hash']});refs.createIndex('projectId','projectId');refs.createIndex('hash','hash');
  }
  if(!db.objectStoreNames.contains('heads')) {
    db.createObjectStore('heads',{keyPath:'id'});
    // IndexedDB requests keep this upgrade transaction alive. No external await.
    void (async()=>{
      for(let cursor=await transaction.objectStore('projects').openCursor();cursor;cursor=await cursor.continue())await transaction.objectStore('heads').put(headRecord(cursor.value));
      for(let cursor=await transaction.objectStore('deletedProjects').openCursor();cursor;cursor=await cursor.continue())await transaction.objectStore('heads').put({id:cursor.value.id,deleted:true,deletedAt:cursor.value.deletedAt});
    })().catch(()=>{try{transaction.abort();}catch{}});
  }
}, blocked() { globalThis.window?.dispatchEvent(new CustomEvent('scribyra:storage-blocked')); }, blocking() { db.then(connection => connection.close()); } })).catch(error=>{throw new Error(`Local storage could not be opened (${error.name}). Free storage or close older Scribyra tabs, then reload. Export open projects before clearing site data.`,{cause:error});});
// Wait for Rust schema constants; callers still receive the original open error.
void db.catch(()=>{});

const sameBytes = (a,b) => a.length === b.length && a.every((byte,i) => byte === b[i]);
function makeRecord(id, doc, sequence, updatedAt = Date.now(), update = Y.encodeStateAsUpdate(doc), history) {
  const meta = doc.getMap('meta');
  return { id, schemaVersion: meta.get('schemaVersion'), name: meta.get('name') || 'Untitled project', updatedAt, files: projectFiles(doc).length, sequence, update, ...(history?{history}:{}) };
}
/** History bookkeeping kept on the project record. Records without it predate format 2 and are compacted when next opened. */
const freshHistory=(at=Date.now())=>({version:HISTORY_FORMAT,pointAt:at,maintainedSequence:0,maintainedAt:at});
/** Apply one update to `doc` and return exactly what it added: new structs and newly deleted items.
 * A full `encodeStateAsUpdate(doc, vector)` repeats the whole delete set on every save. */
function applyCapturing(doc,update){
  const added=[],capture=delta=>added.push(delta);doc.on('update',capture);
  try{Y.applyUpdate(doc,update);}finally{doc.off('update',capture);}
  return added.length===1?added[0]:added.length?Y.mergeUpdates(added):null;
}
const rowFrom=row=>row.from??row.sequence;
async function abort(tx, error) { try { tx.abort(); } catch {} await tx.done.catch(() => {}); throw error; }
function applyStored(update) { const doc = new Y.Doc(); try { Y.applyUpdate(doc, update); return doc; } catch (error) { doc.destroy(); throw error; } }

// All asynchronous work here is IndexedDB requests, keeping the transaction alive.
async function ensureBlobs(tx, id, doc, write) {
  const installed=[];
  for(const ref of blobRefs(doc)) {
    let bytes=knownBlob(doc,ref.hash);
    if(!bytes) {
      const record=await tx.objectStore('blobs').get(ref.hash);
      if(!record)throw new Error('A binary asset is missing from local storage. Reconnect to its source before saving.');
      installBlob(doc,ref,record.bytes);bytes=knownBlob(doc,ref.hash);installed.push({ref,bytes});
    }
    if(bytes.byteLength!==ref.size)throw new Error('Binary asset size does not match its reference.');
    if(write) {
      if(!(await tx.objectStore('blobs').getKey(ref.hash))) {
        verifyBlob(ref,bytes);await tx.objectStore('blobs').put({hash:ref.hash,bytes});
      }
      if(!(await tx.objectStore('projectBlobs').getKey([id,ref.hash]))) await tx.objectStore('projectBlobs').put({projectId:id,hash:ref.hash});
    }
  }
  return installed;
}
function headRecord(record) {
  return {id:record.id,schemaVersion:record.schemaVersion||1,name:record.name||'Untitled project',updatedAt:record.updatedAt,files:record.files||0,sequence:record.sequence??0,deleted:false};
}
export async function listProjects() {
  return (await(await db).getAll('heads')).filter(p=>!p.deleted).map(({deleted,...record})=>record).sort((a,b)=>b.updatedAt-a.updatedAt);
}
async function loadProjectData(id,parent) {
  const tx = (await db).transaction([...HISTORY_STORES, ...BLOB_STORES, 'migrationBackups','migrationBackupsV2','heads'], 'readwrite');
  let doc,migration;
  try {
    const p = await tx.objectStore('projects').get(id);
    if (!p) throw new Error('Project not found on this device.');
    doc = applyStored(p.update);
    const version = doc.getMap('meta').get('schemaVersion') || 1;
    if (version > SCHEMA_VERSION) throw new Error('This project needs a newer version of Scribyra.');
    let record = p;
    if (version < SCHEMA_VERSION) {
      migration=observe('migration',parent);
      const vector = Y.encodeStateVector(doc),invariant=migrationInvariant(doc);
      migrateProject(doc,id);
      try{validate_collaboration_migration(invariant,migrationInvariant(doc));}catch(error){throw new Error(String(error));}
      const backupStore=tx.objectStore('migrationBackupsV2');
      if(!(await backupStore.get([id,version])))await backupStore.put({...p,projectId:id,fromVersion:version,assets:blobRefs(doc)});
      if (!(await tx.objectStore('migrationBackups').get(id))) await tx.objectStore('migrationBackups').put(p);
      const sequence = (p.sequence ?? 0) + 1;
      record = makeRecord(id, doc, sequence, p.updatedAt, undefined, p.history);
      if(p.sequence===undefined)await tx.objectStore('checkpoints').put({checkpointId:crypto.randomUUID(),projectId:id,sequence:0,createdAt:p.updatedAt,update:p.update});
      {
        await tx.objectStore('journal').put({ version: 1, projectId: id, sequence, createdAt: Date.now(), update: Y.encodeStateAsUpdate(doc, vector) });
        await tx.objectStore('checkpoints').put({ checkpointId:crypto.randomUUID(), projectId: id, sequence, createdAt: Date.now(), update: record.update });
      }
    }
    validateProjectState(doc);
    await ensureBlobs(tx,id,doc,true);
    if (p.sequence === undefined && version === SCHEMA_VERSION) {
      record = { ...record, sequence: 0 };
      await tx.objectStore('checkpoints').put({ checkpointId:crypto.randomUUID(), projectId: id, sequence: 0, createdAt: p.updatedAt, update: record.update });
    }
    if (record !== p) {await tx.objectStore('projects').put(record);await tx.objectStore('heads').put(headRecord(record));}
    await tx.done;migration?.end();if(record!==p)publishStorageChange({version:1,kind:'head',projectId:id,sequence:record.sequence});
    if (record.history?.version !== HISTORY_FORMAT) {
      // First open since stored history changed format. A failure here never blocks opening:
      // the project stays in the earlier format and the next open tries again.
      try { const compacted = await compactProjectData(id); if (compacted?.delta) Y.applyUpdate(doc, compacted.delta); }
      catch (error) { globalThis.console?.warn?.('History compaction postponed:', error); }
    }
    return doc;
  } catch (error) {if(migration)finishError(migration,error); doc?.destroy(); return abort(tx, error); }
}

/** Merge stale writers, persist referenced bytes, and journal the result atomically. */
async function saveProjectData(id, doc, prepared, options = {}) {
  const tx = (await db).transaction([...HISTORY_STORES, ...BLOB_STORES, ...OBJECT_STORES, 'migrationBackups','migrationBackupsV2','deletedProjects','heads'], 'readwrite');
  let merged,prior;const recoveries=[];
  const cancel=()=>{try{tx.abort();}catch{}};
  prepared?.signal?.addEventListener('abort',cancel,{once:true});prepared?.transaction?.(tx.done);
  // Prepare the receipt while rollback is possible; confirm it before returning to the handler.
  const finish=async result=>{const committed=prepared?.prepareCommit?.(result);prepared?.guard?.();await tx.done;committed?.();return result;};
  try {
    prepared?.guard?.();
    if (await tx.objectStore('deletedProjects').get(id)) throw new Error('This project was deleted in another tab. Export your open copy to keep it.');
    const previous = await tx.objectStore('projects').get(id);
    if(prepared&&((previous?.sequence??(previous?0:null))!==prepared.expectedSequence))throw Object.assign(new Error('Committed project sequence changed; prepare again.'),{code:'revision_conflict'});
    if ((previous?.schemaVersion || 1) > SCHEMA_VERSION || (previous?.schemaVersion || 1) > (prepared?SCHEMA_VERSION:(doc.getMap('meta').get('schemaVersion') || 1))) throw new Error('This project was upgraded. Reload before editing it again.');
    merged = previous ? applyStored(previous.update) : new Y.Doc();
    const before = Y.encodeStateAsUpdate(merged), vector = Y.encodeStateVector(merged);
    if(previous&&concurrentBinaryVersions(doc,merged))prior=cloneProject(merged);
    const delta = applyCapturing(merged, Y.encodeStateAsUpdate(doc));copyBlobs(doc,merged);
    validateProjectState(merged);
    if(prepared){await writeObjects(tx,id,prepared);if(prepared.history)await applyHistoryPolicy(tx,id,prepared.history);}
    if(prior)for(const source of binaryRecoverySources(doc,prior,merged))recoveries.push(await writeRecoveryProject(tx,id,source));
    const blobs=await ensureBlobs(tx,id,merged,true), update = Y.encodeStateAsUpdate(merged);
    if (previous && sameBytes(before, update)) { await finish({update,sequence:previous.sequence??0});for(const recovery of recoveries)publishRecovery(recovery);return { update, sequence: previous.sequence ?? 0, blobs, recoveries }; }
    const sequence = previous ? (previous.sequence ?? 0) + 1 : 0, now = Date.now();
    // Automatic versions: the caller says whether this save is one (it ends its typing burst
    // first); other writers follow the interval. The state before a long pause is one too.
    let history = previous ? previous.history : freshHistory(now), point = false;
    if (history) {
      point = !!previous && (options.point ?? pointDue(history.pointAt, now));
      if (previous && previous.sequence > 0 && now - previous.updatedAt >= POINT_GAP_MS && !point) {
        const last = await tx.objectStore('journal').get([id, previous.sequence]);
        if (last && !last.point) await tx.objectStore('journal').put({ ...last, point: true, checkpointId: crypto.randomUUID() });
      }
      history = { ...history, ...(point ? { pointAt: now } : {}) };
    }
    // `update` already encodes `merged`; a large history made every extra full encode visible while typing.
    const record = makeRecord(id, merged, sequence, now, update, history);
    if (previous) {
      if (previous.sequence === undefined) await tx.objectStore('checkpoints').put({ checkpointId:crypto.randomUUID(), projectId: id, sequence: 0, createdAt: previous.updatedAt, update: previous.update });
      await tx.objectStore('journal').put({ version: 1, projectId: id, sequence, createdAt: record.updatedAt, update: delta ?? Y.encodeStateAsUpdate(merged, vector), ...(point ? { point: true, checkpointId: crypto.randomUUID() } : {}) });
    }
    // Only a new project's first state is a full copy here; maintenance adds sparse replay bases.
    if (!previous) await tx.objectStore('checkpoints').put({ checkpointId:crypto.randomUUID(), projectId: id, sequence, createdAt: record.updatedAt, update });
    await tx.objectStore('projects').put(record);await tx.objectStore('heads').put(headRecord(record));await finish({update,sequence});publishStorageChange({version:1,kind:'head',projectId:id,sequence});
    const maintenanceDue = maintenanceNeeded(record);
    for(const recovery of recoveries)publishRecovery(recovery);return { update, sequence, blobs, recoveries, point, pointAt: history?.pointAt, maintenanceDue };
  } catch (error) { return abort(tx, error); }
  finally { prepared?.signal?.removeEventListener('abort',cancel);merged?.destroy();prior?.destroy(); }
}

/** Reconstruct a durable revision, including its verified binary assets. */
async function loadRevisionData(id, sequence) {
  const tx = (await db).transaction([...HISTORY_STORES,'blobs']);let doc;
  try {
    const current = await tx.objectStore('projects').get(id);
    if (!current) throw new Error('Project not found on this device.');
    const target = sequence ?? current.sequence ?? 0;
    if (!Number.isSafeInteger(target) || target < 0 || target > (current.sequence ?? 0)) throw new Error('Unknown project revision.');
    const checkpoints = await tx.objectStore('checkpoints').index('projectId').getAll(id);
    const checkpoint = checkpoints.filter(c => c.sequence <= target).sort((a,b) => b.sequence-a.sequence)[0];
    const updates = await tx.objectStore('journal').index('projectId').getAll(id);
    if (!checkpoint) throw new Error('No recovery checkpoint is available for this revision.');
    doc = applyStored(checkpoint.update);let expected = checkpoint.sequence+1;
    for (const entry of updates.filter(e => e.sequence > checkpoint.sequence && e.sequence <= target).sort((a,b) => a.sequence-b.sequence)) {
      if (![1,2].includes(entry.version) || rowFrom(entry) !== expected || entry.sequence < expected) throw new Error('The project journal has a gap or unsupported entry.');
      expected = entry.sequence + 1;Y.applyUpdate(doc, entry.update);
    }
    if (expected !== target+1) throw new Error('The project journal is incomplete.');
    await ensureBlobs(tx,id,doc,false);await tx.done;return doc;
  } catch (error) { doc?.destroy();return abort(tx,error); }
}
export async function migrationBackupV2(id,fromVersion){return (await(await db).get('migrationBackupsV2',[id,fromVersion]));}
export async function migrationBackup(id) { return (await (await db).get('migrationBackups', id))?.update; }
async function deleteProjectData(id) {
  const tx = (await db).transaction([...HISTORY_STORES, ...BLOB_STORES, 'migrationBackups','migrationBackupsV2', ...OBJECT_STORES, 'deletedProjects','heads'], 'readwrite');
  try {
    const deletedAt=Date.now();await tx.objectStore('deletedProjects').put({ id, deletedAt });
    await tx.objectStore('heads').put({id,deleted:true,deletedAt});
    await tx.objectStore('projects').delete(id); await tx.objectStore('migrationBackups').delete(id);
    for (const store of ['journal','checkpoints','migrationBackupsV2','historyCatalog']) {
      const keys = await tx.objectStore(store).index('projectId').getAllKeys(id);
      for (const key of keys) await tx.objectStore(store).delete(key);
    }
    for(const ref of await tx.objectStore('projectHistoryObjects').index('projectId').getAll(id)){
      await tx.objectStore('projectHistoryObjects').delete([id,ref.hash,ref.pin]);
      if(!(await tx.objectStore('projectHistoryObjects').index('hash').count(ref.hash)))await tx.objectStore('historyObjects').delete(ref.hash);
    }
    const refs=await tx.objectStore('projectBlobs').index('projectId').getAll(id);
    for(const ref of refs) {
      await tx.objectStore('projectBlobs').delete([id,ref.hash]);
      if(!(await tx.objectStore('projectBlobs').index('hash').count(ref.hash)))await tx.objectStore('blobs').delete(ref.hash);
    }
    await tx.done;publishStorageChange({version:1,kind:'deleted',projectId:id,sequence:0});
  } catch(error) { return abort(tx,error); }
}
export async function storageStatus() {
  const estimate = await navigator.storage?.estimate?.() || {};
  const persistent = await navigator.storage?.persisted?.() || false;
  return { usage: estimate.usage || 0, quota: estimate.quota || 0, persistent };
}

/** Cheap head check; decode/hydrate a changed snapshot in one readonly transaction. */
export async function readCommittedProject(id,afterSequence=-1,known=new Map()) {
  const tx=(await db).transaction(['heads','projects','blobs']);let stored;
  try{
    const head=await tx.objectStore('heads').get(id);
    if(!head||head.deleted){await tx.done;return{kind:head?.deleted?'deleted':'missing',head};}
    if(!Number.isSafeInteger(head.sequence)||head.sequence<0)throw new Error('The local project head is invalid. Export your open copy before reloading.');
    if(head.schemaVersion>SCHEMA_VERSION)throw new Error('This project was upgraded in another tab. Export your open copy or reload with the newer Scribyra version.');
    if(head.sequence===afterSequence){await tx.done;return{kind:'unchanged',head};}
    const record=await tx.objectStore('projects').get(id);
    if(!record||(record.sequence??0)!==head.sequence)throw new Error('The local project snapshot does not match its committed head. Export your open copy before reloading.');
    stored=applyStored(record.update);
    if((stored.getMap('meta').get('schemaVersion')||1)!==head.schemaVersion)throw new Error('The local project schema does not match its committed head.');
    validateProjectState(stored);
    const blobs=[];
    for(const ref of blobRefs(stored)) {
      const cached=known.get(ref.hash);
      if(cached){if(cached.byteLength!==ref.size)throw new Error('Binary asset size does not match its reference.');continue;}
      const blob=await tx.objectStore('blobs').get(ref.hash);
      if(!blob)throw new Error('A committed binary asset is missing. Keep the open project and export a backup.');
      verifyBlob(ref,blob.bytes);blobs.push({ref,bytes:blob.bytes});
    }
    await tx.done;return{kind:'updated',head,update:record.update,blobs};
  }catch(error){return abort(tx,error);}finally{stored?.destroy();}
}

function publishRecovery(recovery){if(recovery.created)publishStorageChange({version:1,kind:'head',projectId:recovery.id,sequence:0});}
async function writeRecoveryProject(tx,originalId,source,{suffix=' (binary recovery)',prefix:idPrefix='recovery-'}={}) {
  const frozen=cloneProject(source);
  try{
    const bytes=Y.encodeStateAsUpdate(frozen),prefix=new TextEncoder().encode(originalId+'\0'),key=new Uint8Array(prefix.length+bytes.length);key.set(prefix);key.set(bytes,prefix.length);
    let id=idPrefix+blob_hash(key);
    if(await tx.objectStore('deletedProjects').get(id))id=crypto.randomUUID();
    const existing=await tx.objectStore('heads').get(id);
    if(existing&&!existing.deleted)return{id,name:existing.name,created:false};
    frozen.getMap('meta').set('lineageId',crypto.randomUUID());
    validateProjectState(frozen);
    const name=String(frozen.getMap('meta').get('name')||'Untitled project').slice(0,140)+suffix;frozen.getMap('meta').set('name',name);
    await ensureBlobs(tx,id,frozen,true);const record=makeRecord(id,frozen,0,Date.now(),undefined,freshHistory());
    await tx.objectStore('projects').put(record);await tx.objectStore('heads').put(headRecord(record));await tx.objectStore('checkpoints').put({ checkpointId:crypto.randomUUID(),projectId:id,sequence:0,createdAt:record.updatedAt,update:record.update});
    return{id,name,created:true};
  }finally{frozen.destroy();}
}
/** Save a complete losing side before publishing a concurrent binary merge. */
async function preserveRecoveryProjectData(originalId,source) {
  const frozen=cloneProject(source),tx=(await db).transaction([...HISTORY_STORES,...BLOB_STORES,'deletedProjects','heads'],'readwrite');
  try{
    if(await tx.objectStore('deletedProjects').get(originalId))throw new Error('The project was deleted. Keep the open copy and export it or save a recovered copy.');
    const recovery=await writeRecoveryProject(tx,originalId,frozen);await tx.done;publishRecovery(recovery);return recovery;
  }catch(error){return abort(tx,error);}finally{frozen.destroy();}
}

// ---------- Stored history size (docs/history.md) ----------
function maintenanceNeeded(record,now=record.updatedAt){
  const history=record.history;if(history?.version!==HISTORY_FORMAT||history.compaction==='failed')return false;
  if(history.compaction==='thinning')return true;
  const since=(record.sequence??0)-(history.maintainedSequence??0);
  return since>=MAINTAIN_SAVES||since>0&&now-(history.maintainedAt??0)>=MAINTAIN_INTERVAL_MS;
}
const legacyCheckpointId=(projectId,row)=>row.checkpointId||lineageForProject((row.catalogSourceId||projectId)+':'+row.sequence);
const listedMigration=(row,backups)=>row.sequence===0||!!row.migration||backups.some(sequence=>sequence+1===row.sequence);
/** Projects stored before format 2: keep a recovery copy, then merge per-keystroke change
 * records into bursts in one guarded transaction. Maintenance thins the versions afterwards
 * and removes the recovery copy once the compacted history replays to the saved head. */
async function compactProjectData(id){
  const tx=(await db).transaction([...HISTORY_STORES,...BLOB_STORES,'heads','deletedProjects','migrationBackupsV2'],'readwrite');let doc,next;
  try{
    const record=await tx.objectStore('projects').get(id);
    if(!record||record.history?.version===HISTORY_FORMAT||(record.schemaVersion||1)!==SCHEMA_VERSION){await tx.done;return null;}
    doc=applyStored(record.update);validateProjectState(doc);await ensureBlobs(tx,id,doc,false);
    // Bursts never span a stored version, so a diff between versions still names who typed.
    const times=[...doc.getMap('versions').values()].map(version=>version.createdAt);let legacy=0;
    // Only automatic copies count: the starting point and schema-migration copies are kept as they are.
    const backups=(await tx.objectStore('migrationBackupsV2').index('projectId').getAll(id)).map(row=>row.sequence??0);
    for(let cursor=await tx.objectStore('checkpoints').index('projectId').openCursor(id);cursor;cursor=await cursor.continue()){const row=cursor.value;times.push(row.createdAt);if(!row.replayOnly&&!listedMigration(row,backups))legacy++;}
    for(let cursor=await tx.objectStore('journal').index('projectId').openCursor(id);cursor;cursor=await cursor.continue())if(cursor.value.point)times.push(cursor.value.createdAt);
    const {remove,keptFor}=redundantChanges(doc,{boundaries:times});
    const recovery=remove.length||legacy?await writeRecoveryProject(tx,id,doc,{suffix:' (before history compaction)',prefix:'compaction-'}):null;
    let sequence=record.sequence??0,update=record.update,updatedAt=record.updatedAt,delta=null;
    if(remove.length){
      next=cloneProject(doc);const added=[],capture=value=>added.push(value);next.on('update',capture);
      next.transact(()=>{const changes=next.getMap('changes');for(const change of remove)changes.delete(change);});
      next.off('update',capture);delta=added.length===1?added[0]:Y.mergeUpdates(added);
      verifyCoalesced(doc,next,keptFor);validateProjectState(next);
      sequence++;update=Y.encodeStateAsUpdate(next);updatedAt=Date.now();
      await tx.objectStore('journal').put({version:1,projectId:id,sequence,createdAt:updatedAt,update:delta});
    }
    const history={...freshHistory(record.updatedAt),maintainedSequence:-1,compaction:'thinning',mergedChanges:remove.length,...(recovery?{recoveryId:recovery.id}:{})};
    const stored=makeRecord(id,next||doc,sequence,updatedAt,update,history);
    await tx.objectStore('projects').put(stored);await tx.objectStore('heads').put(headRecord(stored));await tx.done;
    if(recovery)publishRecovery(recovery);publishStorageChange({version:1,kind:'head',projectId:id,sequence});
    return{delta,sequence,mergedChanges:remove.length,recovery};
  }catch(error){return abort(tx,error);}
  finally{doc?.destroy();next?.destroy();}
}
async function historyMeta(id){
  const tx=(await db).transaction(['projects','journal','checkpoints','historyCatalog','migrationBackupsV2','deletedProjects']);
  try{
    const project=await tx.objectStore('projects').get(id);
    if(!project||await tx.objectStore('deletedProjects').get(id)){await tx.done;return null;}
    const journal=[],checkpoints=[];
    // Cursors read one row at a time: planning never holds the whole history in memory.
    for(let cursor=await tx.objectStore('journal').index('projectId').openCursor(id);cursor;cursor=await cursor.continue()){const row=cursor.value;journal.push({sequence:row.sequence,from:rowFrom(row),version:row.version,createdAt:row.createdAt,point:!!row.point,kept:!!row.kept,checkpointId:row.checkpointId,bytes:row.update.length});}
    for(let cursor=await tx.objectStore('checkpoints').index('projectId').openCursor(id);cursor;cursor=await cursor.continue()){const row=cursor.value;checkpoints.push({sequence:row.sequence,createdAt:row.createdAt,replayOnly:!!row.replayOnly,migration:!!row.migration,kept:!!row.kept,checkpointId:row.checkpointId,catalogSourceId:row.catalogSourceId,bytes:row.update.length});}
    const catalog=await tx.objectStore('historyCatalog').index('projectId').getAll(id),backups=(await tx.objectStore('migrationBackupsV2').index('projectId').getAll(id)).map(row=>row.sequence??0);
    await tx.done;return{head:{sequence:project.sequence??0,bytes:project.update.length,history:project.history,updatedAt:project.updatedAt},journal:journal.sort((a,b)=>a.sequence-b.sequence),checkpoints:checkpoints.sort((a,b)=>a.sequence-b.sequence),catalog,backups};
  }catch(error){return abort(tx,error);}
}
/** Which automatic versions stay, where journal rows end, and which full copies remain. */
function planHistory(id,meta,now,{keep=[],drop=[]}={}){
  const through=meta.head.sequence,journal=meta.journal.filter(row=>row.sequence<=through),checkpoints=meta.checkpoints.filter(row=>row.sequence<=through);
  const ends=new Set(journal.map(row=>row.sequence)),candidates=new Map();
  const candidate=value=>{const known=candidates.get(value.id);if(!known||value.kind==='journal')candidates.set(value.id,{...known,...value});};
  // Versions kept in "Clean up history" (`kept`) are never thinned.
  for(const row of checkpoints)if(!row.replayOnly&&!listedMigration(row,meta.backups))candidate({id:legacyCheckpointId(id,row),sequence:row.sequence,createdAt:row.createdAt??0,kind:'legacy',kept:row.kept});
  // A catalogue entry for an automatic version is only thinned as the duplicate of a stored
  // automatic copy (earlier backups catalogued every one). Entries without one, such as the
  // versions someone kept in "Clean up history", are never candidates.
  for(const row of meta.catalog)if(row.reason==='automatic'&&candidates.get(row.checkpointId)?.kind==='legacy')candidate({...candidates.get(row.checkpointId),catalog:true});
  for(const row of journal)if(row.point)candidate({id:row.checkpointId,sequence:row.sequence,createdAt:row.createdAt??0,kind:'journal',kept:row.kept});
  // Clean-up passes the versions a person chose: `keep` pins them, `drop` removes them.
  for(const value of candidates.values()){if(keep.includes(value.id))value.kept=true;if(drop.includes(value.id))value.kept=false;}
  const kept=ladder([...candidates.values()].filter(value=>!value.kept&&!drop.includes(value.id)),now),points=new Map(),listedLegacy=new Set(),dropCatalog=[];
  for(const value of candidates.values())if(drop.includes(value.id))kept.delete(value.id);else if(value.kept)kept.add(value.id);
  for(const value of candidates.values()){
    const keep=kept.has(value.id),convertible=ends.has(value.sequence);
    if(keep&&convertible&&!points.has(value.sequence))points.set(value.sequence,{checkpointId:value.id,createdAt:value.createdAt,...(value.kept?{kept:true}:{})});
    else if(keep&&value.kind==='legacy'&&!convertible)listedLegacy.add(value.sequence);
    if(value.catalog&&(!keep||points.get(value.sequence)?.checkpointId===value.id))dropCatalog.push(value.id);
  }
  // Duplicate journal points at one sequence collapse into the first kept identity.
  const boundaries=new Set([through,...points.keys(),...listedLegacy,...meta.catalog.filter(row=>!dropCatalog.includes(row.checkpointId)).map(row=>row.sequence).filter(Number.isSafeInteger),...checkpoints.filter(row=>!row.replayOnly&&listedMigration(row,meta.backups)).map(row=>row.sequence)]);
  // Contiguous journal runs; each starts right after a stored full copy.
  const runs=[];for(const row of journal){const run=runs.at(-1);if(run&&row.from===run.end+1){run.rows.push(row);run.end=row.sequence;}else runs.push({start:row.from,end:row.sequence,rows:[row]});}
  for(const run of runs){
    const cuts=[...boundaries].filter(b=>b>=run.start&&b<run.end).concat(run.end).sort((a,b)=>a-b),intervals=[];let index=0,from=run.start;
    for(const end of cuts){
      const rows=[];while(index<run.rows.length&&run.rows[index].sequence<=end)rows.push(run.rows[index++]);
      if(!rows.length)continue;
      // A boundary inside an already merged row cannot be reached; that row stays whole.
      // Bound one transaction's work.
      let part=[],bytes=0;
      for(const row of rows){if(part.length&&bytes+row.bytes>SEGMENT_BYTES){intervals.push({from,end:part.at(-1).sequence,rows:part});from=part.at(-1).sequence+1;part=[];bytes=0;}part.push(row);bytes+=row.bytes;}
      intervals.push({from,end:part.at(-1).sequence,rows:part});from=part.at(-1).sequence+1;
    }
    run.intervals=intervals;
  }
  return{through,points,listedLegacy,dropCatalog,boundaries,runs,checkpoints};
}
const historyLocks=new Map();
async function exclusive(name,run){
  if(globalThis.navigator?.locks?.request)return navigator.locks.request(name,{ifAvailable:true},lock=>lock?run():{skipped:true});
  if(historyLocks.has(name))return{skipped:true};
  historyLocks.set(name,true);try{return await run();}finally{historyLocks.delete(name);}
}
/** Compares two documents' encoded states; returns `b`'s encoding so the next step can reuse it. */
function sameState(a,b){
  const x=Y.encodeStateAsUpdate(a),y=Y.encodeStateAsUpdate(b);return sameBytes(x,y)?y:null;
}
/** Thin automatic versions on the ladder, merge the journal rows between the versions kept and
 * keep sparse full copies for replay. Each step is one IndexedDB transaction that re-reads and
 * checks its rows, verifies the merged state against the original, then replaces them: a closed
 * tab or a competing tab leaves a valid, partly maintained history that the next run continues. */
export function maintainHistory(id,{now=Date.now(),createBases=true,keep=[],drop=[]}={}){
  return observed('storage_commit',()=>exclusive('scribyra-history-maintenance:'+id,async()=>{
    const started=Date.now();let steps=0,merged=0,removedVersions=0;
    for(let attempt=0;attempt<4;attempt++){
      const meta=await historyMeta(id);if(!meta)return{skipped:true};
      if(meta.head.history?.version!==HISTORY_FORMAT||meta.head.history.compaction==='failed')return{skipped:true};
      const plan=planHistory(id,meta,now,{keep,drop});
      let conflict=false;
      for(const run of plan.runs){
        const result=await maintainRun(id,plan,run,meta,{createBases});
        if(result.conflict){conflict=true;break;}
        steps+=result.steps;merged+=result.merged;removedVersions+=result.removedVersions;
      }
      if(conflict)continue;
      if(plan.dropCatalog.length)removedVersions+=await dropCatalogRows(id,plan.dropCatalog);
      await finishMaintenance(id,plan.through,now);
      return{steps,merged,removedVersions,ms:Date.now()-started};
    }
    return{skipped:true,conflict:true};
  }));
}
async function maintainRun(id,plan,run,meta,{createBases=true}={}){
  const byCheckpoint=new Map(plan.checkpoints.map(row=>[row.sequence,row]));
  const listed=row=>!row.replayOnly;
  const desiredPoint=end=>plan.points.get(end)||null;
  // What each interval must become, judged from metadata alone.
  const needs=interval=>{
    const last=interval.rows.at(-1),want=desiredPoint(interval.end);
    if(interval.rows.length>1)return true;
    if(!!last.point!==!!want||want&&(last.checkpointId!==want.checkpointId||!!want.kept!==!!last.kept))return true;
    for(const row of plan.checkpoints)if(row.sequence>interval.from-1&&row.sequence<interval.end&&!protectedCheckpoint(row))return true;
    const at=byCheckpoint.get(interval.end);if(at&&listed(at)&&!protectedCheckpoint(at))return true;
    return false;
  };
  const protectedCheckpoint=row=>row.sequence===run.start-1||(listed(row)&&(listedMigration(row,meta.backups)||plan.listedLegacy.has(row.sequence)));
  const first=run.intervals.findIndex(needs);
  if(first<0)return{steps:0,merged:0,removedVersions:0};
  // Start from the latest full copy at or before the first interval that changes.
  const startAt=run.intervals[first].from-1,bases=plan.checkpoints.filter(row=>row.sequence<=startAt&&row.sequence>=run.start-1&&(plan.boundaries.has(row.sequence)||row.sequence===run.start-1||row.replayOnly)).sort((a,b)=>b.sequence-a.sequence);
  const base=bases[0];if(!base)return{steps:0,merged:0,removedVersions:0};
  let doc=null,steps=0,mergedRows=0,removedVersions=0,bytesSince=0,encoded=null;
  try{
    {const tx=(await db).transaction(['checkpoints','journal']);
      try{
        const row=await tx.objectStore('checkpoints').get([id,base.sequence]);if(!row)throw Object.assign(new Error('changed'),{conflict:true});
        doc=applyStored(row.update);
        if(startAt>base.sequence){let next=base.sequence+1;for(const entry of await tx.objectStore('journal').getAll(IDBKeyRange.bound([id,base.sequence+1],[id,startAt]))){if(rowFrom(entry)!==next)throw Object.assign(new Error('changed'),{conflict:true});next=entry.sequence+1;Y.applyUpdate(doc,entry.update);bytesSince+=entry.update.length;}}
        await tx.done;
      }catch(error){await abort(tx,error).catch(()=>{});return{conflict:true};}
    }
    for(const interval of run.intervals){
      if(interval.end<=startAt)continue;
      const tx=(await db).transaction(['journal','checkpoints'],'readwrite');
      try{
        const journal=tx.objectStore('journal'),checkpoints=tx.objectStore('checkpoints');
        const rows=await journal.getAll(IDBKeyRange.bound([id,interval.from],[id,interval.end]));
        // The plan was made from metadata; refuse if another tab changed these rows since.
        if(rows.length!==interval.rows.length||rows.some((row,i)=>row.sequence!==interval.rows[i].sequence||rowFrom(row)!==interval.rows[i].from||row.update.length!==interval.rows[i].bytes||!!row.point!==interval.rows[i].point))throw Object.assign(new Error('History changed during maintenance.'),{conflict:true});
        const inside=await checkpoints.getAll(IDBKeyRange.bound([id,interval.from],[id,interval.end]));
        const last=rows.at(-1),want=desiredPoint(interval.end);let row=last,changed=false;
        if(rows.length>1){
          // The merged row is what applying the interval's net change to the earlier state adds:
          // the structs as the document stores them (typed runs merged) and only the new
          // deletions. Y.mergeUpdates would keep one struct per keystroke (about five times larger).
          const before=encoded??Y.encodeStateAsUpdate(doc),vector=Y.encodeStateVector(doc);
          for(const entry of rows)Y.applyUpdate(doc,entry.update);
          const check=applyStored(before);let update;
          try{update=applyCapturing(check,Y.encodeStateAsUpdate(doc,vector))??Y.mergeUpdates(rows.map(entry=>entry.update));encoded=sameState(check,doc);if(!encoded)throw Object.assign(new Error('A merged history step does not reproduce its original state.'),{code:'history_verification'});}finally{check.destroy();}
          // Merging must never make stored history larger: use the smaller encoding, or keep the rows.
          const total=rows.reduce((sum,entry)=>sum+entry.update.length,0);
          if(update.length>total){const merged=Y.mergeUpdates(rows.map(entry=>entry.update));if(merged.length<update.length){const verify=applyStored(before);try{Y.applyUpdate(verify,merged);if(!sameState(verify,doc))throw Object.assign(new Error('A merged history step does not reproduce its original state.'),{code:'history_verification'});}finally{verify.destroy();}update=merged;}}
          for(const entry of rows)if(entry.point&&!(entry.sequence===interval.end&&want))removedVersions++;
          if(update.length>total){
            for(const entry of rows.slice(0,-1))if(entry.point){const {point,checkpointId,kept,...rest}=entry;await journal.put(rest);changed=true;}
          }else{
            for(const entry of rows.slice(0,-1))await journal.delete([id,entry.sequence]);
            row={version:2,projectId:id,sequence:interval.end,from:interval.from,createdAt:last.createdAt,update};changed=true;mergedRows+=rows.length-1;
          }
        }else{Y.applyUpdate(doc,last.update);encoded=null;}
        const pointed=want?{...(({kept,...rest})=>rest)(row),point:true,checkpointId:want.checkpointId,...(want.kept?{kept:true}:{})}:(({point,checkpointId,kept,...rest})=>rest)(row);
        if(rows.length===1&&last.point&&!want)removedVersions++;
        if(changed||!!last.point!==!!want||want&&(last.checkpointId!==want.checkpointId||!!want.kept!==!!last.kept)){await journal.put(pointed);changed=true;}
        bytesSince+=pointed.update.length;
        // Full copies: inside the interval they are unreachable as versions now; at its end one
        // stays as a replay base when the updates since the previous base outweigh it.
        for(const copy of inside){
          if(copy.sequence===run.start-1)continue;
          const isListed=!copy.replayOnly,protect=isListed&&(listedMigration(copy,meta.backups)||plan.listedLegacy.has(copy.sequence));
          if(protect){if(copy.sequence===interval.end)bytesSince=0;continue;}
          if(isListed)removedVersions+=plan.points.get(copy.sequence)?.checkpointId===legacyCheckpointId(id,copy)?0:1;
          if(copy.sequence===interval.end&&bytesSince>=Math.max(BASE_MIN_BYTES,copy.update.length)){
            if(isListed)await checkpoints.put({...copy,replayOnly:true});bytesSince=0;continue;
          }
          await checkpoints.delete([id,copy.sequence]);changed=true;
        }
        if(createBases&&bytesSince&&!inside.some(copy=>copy.sequence===interval.end)&&interval.end<plan.through){
          const size=encoded??Y.encodeStateAsUpdate(doc);
          if(bytesSince>=Math.max(BASE_MIN_BYTES,size.length)){await checkpoints.put({checkpointId:crypto.randomUUID(),projectId:id,sequence:interval.end,createdAt:last.createdAt,replayOnly:true,update:size});bytesSince=0;changed=true;}
        }
        await tx.done;if(changed)steps++;
      }catch(error){
        await abort(tx,error).catch(()=>{});if(error.conflict)return{conflict:true,steps,merged:mergedRows,removedVersions};
        if(error.code==='history_verification')await markHistory(id,{compaction:'failed',compactionError:String(error.message).slice(0,200)});
        throw error;
      }
    }
    return{steps,merged:mergedRows,removedVersions};
  }finally{doc?.destroy();}
}
async function dropCatalogRows(id,checkpointIds){
  const tx=(await db).transaction(OBJECT_STORES,'readwrite');let removed=0;
  try{
    for(const checkpointId of checkpointIds){
      if(!(await tx.objectStore('historyCatalog').get([id,checkpointId])))continue;
      await tx.objectStore('historyCatalog').delete([id,checkpointId]);removed++;
      for(const ref of await tx.objectStore('projectHistoryObjects').index('projectId').getAll(id))if(ref.pin==='checkpoint:'+checkpointId){
        await tx.objectStore('projectHistoryObjects').delete([id,ref.hash,ref.pin]);
        if(!(await tx.objectStore('projectHistoryObjects').index('hash').count(ref.hash)))await tx.objectStore('historyObjects').delete(ref.hash);
      }
    }
    await tx.done;return removed;
  }catch(error){return abort(tx,error);}
}
/** The compacted history must replay to the saved head before the recovery copy goes. */
async function finishMaintenance(id,through,now){
  const meta=await historyMeta(id);if(!meta)return;
  let recoveryId=null;
  if(meta.head.history?.compaction==='thinning'){
    const tx=(await db).transaction(['projects','checkpoints','journal']);let doc;
    try{
      const project=await tx.objectStore('projects').get(id),target=project.sequence??0;
      const bases=(await tx.objectStore('checkpoints').index('projectId').getAllKeys(id)).map(key=>key[1]).filter(sequence=>sequence<=target).sort((a,b)=>b-a);
      const base=await tx.objectStore('checkpoints').get([id,bases[0]]);doc=applyStored(base.update);let expected=base.sequence+1;
      for(const entry of await tx.objectStore('journal').getAll(IDBKeyRange.bound([id,base.sequence+1],[id,target]))){if(rowFrom(entry)!==expected)throw Object.assign(new Error('The compacted journal has a gap.'),{code:'history_verification'});expected=entry.sequence+1;Y.applyUpdate(doc,entry.update);}
      if(expected!==target+1||!sameBytes(Y.encodeStateAsUpdate(doc),project.update))throw Object.assign(new Error('The compacted history does not replay to the saved project.'),{code:'history_verification'});
      await tx.done;recoveryId=project.history.recoveryId||null;
    }catch(error){
      await abort(tx,error).catch(()=>{});
      // Keep the recovery copy, stop automatic maintenance and tell the person (web/main.js).
      if(error.code==='history_verification'){await markHistory(id,{compaction:'failed',compactionError:String(error.message).slice(0,200)});}
      throw error;
    }finally{doc?.destroy();}
  }
  const tx=(await db).transaction(['projects'],'readwrite');
  try{
    const project=await tx.objectStore('projects').get(id);if(!project?.history){await tx.done;return;}
    const {recoveryId:_,compaction,...history}=project.history;
    await tx.objectStore('projects').put({...project,history:{...history,...(compaction==='thinning'?{compaction:'done',compactedAt:now}:compaction?{compaction}:{}),maintainedSequence:Math.max(through,history.maintainedSequence??0),maintainedAt:now}});await tx.done;
  }catch(error){return abort(tx,error);}
  // Only an untouched copy goes: one the person opened and changed is theirs to keep.
  if(recoveryId){const head=await(await db).get('heads',recoveryId);if(head&&!head.deleted&&(head.sequence??0)===0)await deleteProjectData(recoveryId).catch(()=>{});}
}
async function markHistory(id,patch){
  const tx=(await db).transaction(['projects'],'readwrite');
  try{const project=await tx.objectStore('projects').get(id);if(project?.history)await tx.objectStore('projects').put({...project,history:{...project.history,...patch}});await tx.done;}
  catch(error){return abort(tx,error);}
}
/** After clean-up merged the journal: release assets no stored state refers to any more,
 * only if the history is still the one that was checked. */
export async function releaseHistoryBlobs(id,expectedSequence,hashes){
  const tx=(await db).transaction(['projects','projectBlobs','blobs'],'readwrite');const released=[];
  try{
    const project=await tx.objectStore('projects').get(id);
    if(!project||(project.sequence??0)!==expectedSequence){await tx.done;return released;}
    for(const hash of hashes){
      if(!(await tx.objectStore('projectBlobs').get([id,hash])))continue;
      await tx.objectStore('projectBlobs').delete([id,hash]);released.push(hash);
      if(!(await tx.objectStore('projectBlobs').index('hash').count(hash)))await tx.objectStore('blobs').delete(hash);
    }
    await tx.done;return released;
  }catch(error){return abort(tx,error);}
}
export async function historyMaintenanceDue(id,now=Date.now()){
  const record=await(await db).get('projects',id);return!!record&&maintenanceNeeded(record,now);
}
export const compactProject=id=>observed('storage_commit',()=>compactProjectData(id));
export const loadProject=id=>observed('storage_read',parent=>loadProjectData(id,parent));
export const loadRevision=(id,sequence)=>observed('storage_read',()=>loadRevisionData(id,sequence));
export const deleteProject=id=>observed('storage_commit',()=>deleteProjectData(id));
export const preserveRecoveryProject=(id,source,parent)=>observed('recovery',()=>preserveRecoveryProjectData(id,source),{parent});
export const saveProject=(id,doc,context,options)=>observed('storage_commit',async(parent)=>{
 const result=await saveProjectData(id,doc,undefined,options);
 if(result.recoveries?.length)observe('recovery',parent).end('success',undefined,[{name:'count',value:result.recoveries.length}]);
 return result;
},{parent:context,metrics:result=>[{name:'bytes',value:result.update.byteLength}]});

function migrationInvariant(doc){
  const meta=doc.getMap('meta').toJSON();delete meta.schemaVersion;delete meta.lineageId;
  const texts={};for(const name of doc.share.keys())if(name.startsWith('text:'))texts[name]=doc.getText(name).toString();
  const assets=Object.fromEntries([...doc.getMap('assets')].map(([id,ref])=>[id,ref instanceof Uint8Array?{hash:blob_hash(ref),size:ref.length}:ref]));
  return JSON.stringify({meta,texts,assets,tree:projectNodes(doc).sort((a,b)=>a.id.localeCompare(b.id)),trash:doc.getMap('trash').toJSON()});
}
async function writeObjects(tx,id,{objects,pins}){
  for(const object of objects){
    const existing=await tx.objectStore('historyObjects').get(object.hash);
    if(existing&&!sameBytes(existing.bytes,object.bytes))throw new Error('Immutable history object mismatch.');
    if(!existing)await tx.objectStore('historyObjects').put(object);
  }
  for(const pin of pins){
    if(!(await tx.objectStore('historyObjects').getKey(pin.hash)))throw new Error('Pinned history object is missing.');
    await tx.objectStore('projectHistoryObjects').put({projectId:id,...pin});
  }
}
/** All hashing/copying is complete before opening the guarded IndexedDB transaction.
 * Pins are {hash,pin}; pin is a caller-owned stable retention-root identifier. */
function copyPreparedBytes(value){
  if(value instanceof ArrayBuffer)return new Uint8Array(value).slice();
  if(ArrayBuffer.isView(value)&&value.buffer instanceof ArrayBuffer)return new Uint8Array(value.buffer,value.byteOffset,value.byteLength).slice();
  throw new TypeError('Prepared bytes must be an ArrayBuffer or an ArrayBuffer view.');
}
export async function commitPrepared(projectId,expectedSequence,update,objects=[],pins=[],{guard,signal,transaction,prepareCommit,history}={}){
  guard?.();
  if(expectedSequence!==null&&(!Number.isSafeInteger(expectedSequence)||expectedSequence<0))throw new Error('Invalid expected committed sequence.');
  const prepared={expectedSequence,guard,signal,transaction,prepareCommit,history:history?structuredClone(history):undefined,objects:objects.map(object=>{
    const bytes=copyPreparedBytes(object.bytes);if(bytes.length>LIMITS.chunkBytes||blob_hash(bytes)!==object.hash)throw new Error('History object integrity or size check failed.');
    return{hash:object.hash,bytes};
  }),pins:pins.map(pin=>{if(typeof pin.pin!=='string'||!pin.pin.length||pin.pin.length>256||!/^[a-f0-9]{64}$/.test(pin.hash))throw new Error('Invalid history pin.');return{hash:pin.hash,pin:pin.pin};})};
  const doc=applyStored(copyPreparedBytes(update));
  try{const result=await saveProjectData(projectId,doc,prepared);return{update:result.update,sequence:result.sequence};}finally{doc.destroy();}
}

/** One consistent read for backup/retention. Only this project's reachable stores travel. */
export async function readHistoryData(id){
  const tx=(await db).transaction([...HISTORY_STORES,...BLOB_STORES,...OBJECT_STORES,'migrationBackups','migrationBackupsV2']);
  try{
    const project=await tx.objectStore('projects').get(id);
    if(!project)throw new Error('Project not found on this device.');
    const data={project};
    for(const name of ['journal','checkpoints','historyCatalog','projectHistoryObjects','migrationBackupsV2'])data[name]=await tx.objectStore(name).index('projectId').getAll(id);
    data.migrationBackup=await tx.objectStore('migrationBackups').get(id);
    data.objects=[];for(const hash of new Set(data.projectHistoryObjects.map(ref=>ref.hash))){const object=await tx.objectStore('historyObjects').get(hash);if(!object)throw new Error('Pinned history object is missing.');data.objects.push(object);}
    data.blobs=[];for(const ref of await tx.objectStore('projectBlobs').index('projectId').getAll(id)){const blob=await tx.objectStore('blobs').get(ref.hash);if(!blob)throw new Error('Retained binary asset is missing.');data.blobs.push(blob);}
    await tx.done;return data;
  }catch(error){return abort(tx,error);}
}
async function applyHistoryPolicy(tx,id,policy){
  for(const row of policy.catalog||[])await tx.objectStore('historyCatalog').put({...row,projectId:id});
  if(policy.thin){
    // Clean-up in format 2 (web/history.js compact2): flags and releases only, never a new copy.
    const {keepPoints,dropPoints,keepCopies,dropCopies,dropCatalog,blobHashes}=policy.thin;
    for(let cursor=await tx.objectStore('journal').index('projectId').openCursor(id);cursor;cursor=await cursor.continue()){
      const row=cursor.value;if(!row.point)continue;
      if(dropPoints.includes(row.checkpointId)){const {point,checkpointId,kept,...rest}=row;await cursor.update(rest);}
      else if(keepPoints.includes(row.checkpointId)&&!row.kept)await cursor.update({...row,kept:true});
    }
    for(const sequence of keepCopies){const row=await tx.objectStore('checkpoints').get([id,sequence]);if(row&&!row.replayOnly&&!row.kept)await tx.objectStore('checkpoints').put({...row,kept:true});}
    for(const sequence of dropCopies){const row=await tx.objectStore('checkpoints').get([id,sequence]);if(row&&!row.replayOnly&&sequence!==0)await tx.objectStore('checkpoints').put({...row,replayOnly:true});}
    for(const checkpointId of dropCatalog){
      await tx.objectStore('historyCatalog').delete([id,checkpointId]);
      for(const ref of await tx.objectStore('projectHistoryObjects').index('projectId').getAll(id))if(ref.pin==='checkpoint:'+checkpointId){
        await tx.objectStore('projectHistoryObjects').delete([id,ref.hash,ref.pin]);
        if(!(await tx.objectStore('projectHistoryObjects').index('hash').count(ref.hash)))await tx.objectStore('historyObjects').delete(ref.hash);
      }
    }
    for(const ref of await tx.objectStore('projectBlobs').index('projectId').getAll(id))if(!blobHashes.includes(ref.hash)){
      await tx.objectStore('projectBlobs').delete([id,ref.hash]);
      if(!(await tx.objectStore('projectBlobs').index('hash').count(ref.hash)))await tx.objectStore('blobs').delete(ref.hash);
    }
    const project=await tx.objectStore('projects').get(id);
    if(project?.history)await tx.objectStore('projects').put({...project,history:{...project.history,cleanedAt:Date.now()}});
  }
  if(policy.compact){
    const {checkpoints,keepCheckpointIds,blobHashes}=policy.compact;
    for(const name of ['journal','checkpoints'])for(const key of await tx.objectStore(name).index('projectId').getAllKeys(id))await tx.objectStore(name).delete(key);
    for(const row of checkpoints)await tx.objectStore('checkpoints').put({...row,projectId:id});
    for(const row of await tx.objectStore('historyCatalog').index('projectId').getAll(id))if(!keepCheckpointIds.includes(row.checkpointId))await tx.objectStore('historyCatalog').delete([id,row.checkpointId]);
    const keep=new Set(keepCheckpointIds.map(key=>'checkpoint:'+key));
    for(const ref of await tx.objectStore('projectHistoryObjects').index('projectId').getAll(id))if(ref.pin.startsWith('checkpoint:')&&!keep.has(ref.pin)){
      await tx.objectStore('projectHistoryObjects').delete([id,ref.hash,ref.pin]);
      if(!(await tx.objectStore('projectHistoryObjects').index('hash').count(ref.hash)))await tx.objectStore('historyObjects').delete(ref.hash);
    }
    for(const ref of await tx.objectStore('projectBlobs').index('projectId').getAll(id))if(!blobHashes.includes(ref.hash)){
      await tx.objectStore('projectBlobs').delete([id,ref.hash]);
      if(!(await tx.objectStore('projectBlobs').index('hash').count(ref.hash)))await tx.objectStore('blobs').delete(ref.hash);
    }
    const project=await tx.objectStore('projects').get(id);
    if(project?.history)await tx.objectStore('projects').put({...project,history:{...project.history,cleanedAt:Date.now()}});
  }
  if(policy.install){
    const bundle=policy.install,newId=bundle.project.id;
    if(newId===id||await tx.objectStore('heads').get(newId)||await tx.objectStore('deletedProjects').get(newId))throw new Error('Recovery destination already exists.');
    if(bundle.recoveryLineage)for(const project of await tx.objectStore('projects').getAll()){const existing=applyStored(project.update);try{if(existing.getMap('meta').get('lineageId')===bundle.recoveryLineage)throw new Error('The original lineage already exists; import as a fork instead.');}finally{existing.destroy();}}
    const doc=applyStored(bundle.project.update);
    try{
      validateProjectState(doc);
      for(const blob of bundle.blobs){verifyBlob({hash:blob.hash,size:blob.bytes.length},blob.bytes);const existing=await tx.objectStore('blobs').get(blob.hash);if(existing&&!sameBytes(existing.bytes,blob.bytes))throw new Error('Immutable binary mismatch.');await tx.objectStore('blobs').put(blob);await tx.objectStore('projectBlobs').put({projectId:newId,hash:blob.hash});}
      await ensureBlobs(tx,newId,doc,true);
      await tx.objectStore('projects').put(bundle.project);await tx.objectStore('heads').put(headRecord(bundle.project));
      for(const name of ['journal','checkpoints','historyCatalog','migrationBackupsV2'])for(const row of bundle[name]||[])await tx.objectStore(name).put({...row,projectId:newId});
      if(bundle.migrationBackup)await tx.objectStore('migrationBackups').put({...bundle.migrationBackup,id:newId});
      await writeObjects(tx,newId,{objects:bundle.objects||[],pins:(bundle.projectHistoryObjects||[]).map(({hash,pin})=>({hash,pin}))});
    }finally{doc.destroy();}
  }
}
