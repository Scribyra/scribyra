import {zipSync,Inflate} from 'fflate';
import {decodeUpdate,Item} from 'yjs';
import {blob_hash,history_validate_backup,history_validate_manifest} from './pkg/scribyra_app.js';
import {LIMITS,ROOTS,BACKUP_VERSION,lineageForProject} from './collaboration-schema.js';
import {blobRefs} from './assets.js';
import {validateProjectState} from './model.js';
import {fail,jsonBytes,parseBytes,decode,hydrate,inventory,verifiedCheckpoint,replay,replayEach,restorable,rowFrom} from './history-storage.js';

const allowedRoot=name=>name.startsWith('text:')||['meta','files','assets','trash',...ROOTS].includes(name);
const allowedMeta=new Set(['schemaVersion','lineageId','name','mainFile','engine','texEnvironment']);
// Direct-session proofs and claims exist only in projects that have been in a session.
const allowedMetadata=key=>allowedMeta.has(key)||typeof key==='string'&&(/^directProof:[a-zA-Z]+:[0-9a-f-]{36}$/.test(key)&&ROOTS.includes(key.split(':')[1])||/^directClaim:[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(key));
export function exportable(doc){
  for(const name of doc.share.keys())if(!allowedRoot(name))throw fail('incomplete_backup','Unexpected project root; backup cannot include private connection state.');
  for(const key of doc.getMap('meta').keys())if(!allowedMetadata(key))throw fail('incomplete_backup','Unexpected project metadata; backup cannot include private connection state.');
  validateProjectState(doc);
}
/** Decode original structs: applying an update can collect deleted content or leave it pending. */
function exportableUpdates(updates){
  const structs=updates.flatMap(update=>decodeUpdate(update).structs),clients=new Map(),locations=new Map();
  for(const item of structs)if(item instanceof Item){
    const rows=clients.get(item.id.client)||[];rows.push(item);clients.set(item.id.client,rows);
  }
  for(const rows of clients.values())rows.sort((a,b)=>a.id.clock-b.id.clock);
  const find=id=>{
    const rows=clients.get(id.client)||[];let low=0,high=rows.length;
    while(low<high){const mid=(low+high)>>>1;if(rows[mid].id.clock<=id.clock)low=mid+1;else high=mid;}
    const item=rows[low-1];return item&&id.clock<item.id.clock+item.length?item:null;
  };
  for(const item of structs){
    if(!(item instanceof Item))continue;
    let next=item,location;const path=[],seen=new Set();
    while(next&&!locations.has(next)){
      if(seen.has(next))throw fail('incomplete_backup','Cyclic serialized project content.');
      seen.add(next);path.push(next);
      if(typeof next.parent==='string'){location={root:next.parent,key:next.parentSub};break;}
      // A map replacement inherits its key from its origin; a nested type inherits its root.
      const ref=next.parent||next.origin||next.rightOrigin;next=ref?find(ref):null;
    }
    location=location||locations.get(next);
    if(!location)throw fail('incomplete_backup','Pending serialized project content has an unknown root.');
    for(const entry of path)locations.set(entry,location);
    if(!allowedRoot(location.root)||location.root==='meta'&&!allowedMetadata(location.key))throw fail('incomplete_backup','Unexpected serialized project root or metadata; backup cannot include private connection state.');
  }
}
function checkedDoc(update,blobs){const doc=decode(update);try{hydrate(doc,blobs);exportable(doc);return doc;}catch(error){doc.destroy();throw error;}}
/** Validate the bytes we retain, even when a newer checkpoint hides them during head replay. */
function validateRecovery(data,current,inv){
  const updates=[data.project.update,...data.checkpoints.map(row=>row.update),...data.journal.map(row=>row.update),...data.migrationBackupsV2.map(row=>row.update),...(data.migrationBackup?[data.migrationBackup.update]:[])];
  const covered=new Set();
  const retain=ref=>{
    const cp=verifiedCheckpoint(ref,inv.objects,data.blobs);
    try{updates.push(cp.update);covered.add(ref);for(const chunk of cp.manifest.updateChunks)covered.add(chunk.hash);}finally{cp.doc.destroy();}
  };
  // Journal points are rebuilt from the journal and full copies below, which are all checked.
  for(const row of inv.items)if(!row.journal)retain(row.checkpointRef);
  // Copies can retain checkpoint objects no longer listed in their catalogue.
  for(const object of inv.objects){
    if(covered.has(object.hash))continue;
    try{history_validate_manifest(new TextDecoder('utf-8',{fatal:true}).decode(object.bytes));}catch{continue;}
    retain(object.hash);
  }
  if(inv.objects.some(object=>!covered.has(object.hash)))throw fail('incomplete_backup','Unclassified retained history object; complete backup cannot validate its content.');
  exportableUpdates(updates);
  for(const name of ['checkpoints','journal']){
    const seen=new Set();
    for(const row of data[name]){
      if(!Number.isSafeInteger(row.sequence)||row.sequence<0||row.sequence>data.project.sequence||seen.has(row.sequence)||name==='journal'&&(![1,2].includes(row.version)||!Number.isSafeInteger(rowFrom(row))||rowFrom(row)<1||rowFrom(row)>row.sequence||row.version===1&&rowFrom(row)!==row.sequence||row.point!==undefined&&(row.point!==true||!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(row.checkpointId||''))))throw fail('incomplete_backup','Invalid or duplicate journal sequence.');
      seen.add(row.sequence);
      if(name==='checkpoints'){const doc=checkedDoc(row.update,data.blobs);doc.destroy();}
    }
  }
  for(const row of [...data.migrationBackupsV2,...(data.migrationBackup?[data.migrationBackup]:[])]){const doc=checkedDoc(row.update,data.blobs);doc.destroy();}
  // Merged rows never span a full copy; one that does is not a history this app wrote.
  for(const row of data.journal)if(data.checkpoints.some(copy=>rowFrom(row)<=copy.sequence&&copy.sequence<row.sequence))throw fail('incomplete_backup','A full copy falls inside a merged journal row.');
  replayEach(data,doc=>exportable(doc));
  const head=replay(data,data.project.sequence);
  try{if(blob_hash(YUpdate(head))!==blob_hash(YUpdate(current)))throw fail('incomplete_backup','Journal head differs from current snapshot.');}finally{head.destroy();}
}
// A migration copy of a project record may carry its local history bookkeeping, which does not travel.
function updateEntry(row,put){const {projectId,id,update,history,...metadata}=row;return{...metadata,updateRef:put('updates',update)};}
/** Uncompressed bytes a complete backup would list, counting each distinct object once (manifest and history index excluded). */
export function backupBytes(data,inv){
  // Same paths as exportBackup: identical bytes under different directories count twice there too.
  const sizes=new Map([['project.update',data.project.update.length]]),add=(directory,bytes)=>sizes.set(directory+'/'+blob_hash(bytes),bytes.length);
  for(const object of inv.objects)add('objects',object.bytes);for(const blob of data.blobs)add('assets',blob.bytes);
  for(const row of [...data.checkpoints,...data.journal,...data.migrationBackupsV2,...(data.migrationBackup?[data.migrationBackup]:[])])add('updates',row.update);
  let total=0;for(const size of sizes.values())total+=size;return total;
}
/** Plaintext, including deleted content. No device stores or preferences are read. */
export function exportBackup(data,{maxBytes=LIMITS.backupBytes}={}){
  const current=checkedDoc(data.project.update,data.blobs),entries=new Map();
  const put=(directory,bytes)=>{const hash=blob_hash(bytes),path=directory+'/'+hash;entries.set(path,bytes);return path;};
  try{
    restorable(current);const inv=inventory(data);
    if(inv.items.some(item=>!item.available))throw fail('incomplete_backup','A retained version is unavailable; complete backup would be incomplete.');
    // Refuse an oversized backup before the long validation, with an action the person can take.
    const size=backupBytes(data,inv);
    if(size>maxBytes)throw fail('incomplete_backup',`This project’s history is too large for one complete backup (${Math.ceil(size/1048576)} MiB of ${Math.floor(maxBytes/1048576)} MiB). Clean up history to remove automatic versions, then export again.`);
    for(const item of inv.items){if(item.journal)continue;const cp=verifiedCheckpoint(item.checkpointRef,inv.objects,data.blobs);try{exportable(cp.doc);}finally{cp.doc.destroy();}}
    validateRecovery(data,current,inv);
    entries.set('project.update',data.project.update);
    for(const object of inv.objects){if(blob_hash(object.bytes)!==object.hash)throw fail('incomplete_backup','Corrupt retained history object.');put('objects',object.bytes);}
    for(const blob of data.blobs){if(blob_hash(blob.bytes)!==blob.hash)throw fail('incomplete_backup','Corrupt retained asset.');put('assets',blob.bytes);}
    // History format 2: journal rows may cover a range (`from`) and mark automatic versions (`point`).
    const history={version:2,sequence:data.project.sequence,updatedAt:data.project.updatedAt,compacted:data.project.history?.version===2,
      checkpoints:data.checkpoints.map(row=>updateEntry({...row,checkpointId:row.checkpointId||lineageForProject((row.catalogSourceId||data.project.id)+':'+row.sequence),catalogSourceId:row.catalogSourceId||data.project.id},put)),journal:data.journal.map(row=>updateEntry(row,put)),
      catalog:inv.catalog,pins:[...new Map([...data.projectHistoryObjects,...inv.catalog.flatMap(row=>{
        const cp=verifiedCheckpoint(row.checkpointRef,inv.objects,data.blobs);try{return[row.checkpointRef,...cp.manifest.updateChunks.map(r=>r.hash)].map(hash=>({hash,pin:'checkpoint:'+row.checkpointId}));}finally{cp.doc.destroy();}
      })].map(({hash,pin})=>[hash+pin,{hash,pin}])).values()],
      migrationBackup:data.migrationBackup?updateEntry(data.migrationBackup,put):null,migrationBackupsV2:data.migrationBackupsV2.map(row=>updateEntry(row,put))};
    entries.set('history.json',jsonBytes(history));
    const manifest={format:BACKUP_VERSION,schemaVersion:current.getMap('meta').get('schemaVersion'),lineageId:current.getMap('meta').get('lineageId'),createdAt:Date.now(),entries:[...entries].map(([path,bytes])=>({path,hash:blob_hash(bytes),size:bytes.length}))};
    const encoded=jsonBytes(manifest);history_validate_backup(new TextDecoder().decode(encoded));entries.set('manifest.json',encoded);
    const bytes=pack(entries);if(bytes.length>LIMITS.backupBytes)throw fail('incomplete_backup','Compressed backup exceeds 512 MiB.');return bytes;
  }finally{current.destroy();}
}
/** ZIP64 is needed only for entry counts: the 512 MiB bound keeps sizes/offsets 32-bit. */
export function pack(entries,options={level:6}){
  if(entries.size>LIMITS.backupEntries)throw fail('incomplete_backup','Backup exceeds 100,000 entries.');
  const classic=zipSync(Object.fromEntries(entries),options);if(entries.size<65535)return classic;
  const end=classic.length-22,old=new DataView(classic.buffer),result=new Uint8Array(classic.length+76),v=new DataView(result.buffer);
  result.set(classic.subarray(0,end));result.set(classic.subarray(end),end+76);
  v.setUint32(end,0x06064b50,true);v.setBigUint64(end+4,44n,true);v.setUint16(end+12,45,true);v.setUint16(end+14,45,true);
  v.setBigUint64(end+24,BigInt(entries.size),true);v.setBigUint64(end+32,BigInt(entries.size),true);
  v.setBigUint64(end+40,BigInt(old.getUint32(end+12,true)),true);v.setBigUint64(end+48,BigInt(old.getUint32(end+16,true)),true);
  v.setUint32(end+56,0x07064b50,true);v.setBigUint64(end+64,BigInt(end),true);v.setUint32(end+72,1,true);
  v.setUint16(end+84,65535,true);v.setUint16(end+86,65535,true);return result;
}
const allowedPath=path=>['manifest.json','history.json','project.update'].includes(path)||/^(objects|assets|updates)\/[a-f0-9]{64}$/.test(path);
/** Inspect all central/local headers before any expansion, then bound each streamed output. */
export function unpack(bytes){
  if(!(bytes instanceof Uint8Array)||bytes.length>LIMITS.backupBytes)throw fail('incomplete_backup','Backup exceeds 512 MiB or has invalid bytes.');
  const v=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength),bad=message=>{throw fail('incomplete_backup',message);};let end=-1;
  for(let i=bytes.length-22;i>=Math.max(0,bytes.length-65557);i--)if(v.getUint32(i,true)===0x06054b50&&i+22+v.getUint16(i+20,true)===bytes.length){end=i;break;}
  if(end<0)bad('Invalid backup ZIP.');
  let count=v.getUint16(end+10,true),directoryEnd=end;const start=v.getUint32(end+16,true),size=v.getUint32(end+12,true);
  if(v.getUint16(end+4,true)||v.getUint16(end+6,true)||v.getUint16(end+8,true)!==count)bad('Unsupported backup ZIP layout.');
  if(count===65535){
    if(end<76||v.getUint32(end-20,true)!==0x07064b50||v.getUint32(end-16,true)!==0||v.getUint32(end-4,true)!==1)bad('Invalid ZIP64 locator.');
    const offset=Number(v.getBigUint64(end-12,true));if(!Number.isSafeInteger(offset)||offset<0||offset+56!==end-20||v.getUint32(offset,true)!==0x06064b50||v.getBigUint64(offset+4,true)!==44n||v.getUint32(offset+16,true)||v.getUint32(offset+20,true))bad('Invalid ZIP64 directory.');
    const entries=v.getBigUint64(offset+32,true);if(entries>BigInt(LIMITS.backupEntries)||v.getBigUint64(offset+24,true)!==entries||v.getBigUint64(offset+40,true)!==BigInt(size)||v.getBigUint64(offset+48,true)!==BigInt(start))bad('ZIP64 count/size claims exceed limits.');
    count=Number(entries);directoryEnd=offset;
  }
  if(count>LIMITS.backupEntries||start+size!==directoryEnd)bad('Unsupported backup ZIP layout.');
  const rows=[],names=new Set();let cursor=start,total=0;
  for(let i=0;i<count;i++){
    if(cursor+46>directoryEnd||v.getUint32(cursor,true)!==0x02014b50)bad('Invalid backup directory.');
    const n=v.getUint16(cursor+28,true),x=v.getUint16(cursor+30,true),c=v.getUint16(cursor+32,true),offset=v.getUint32(cursor+42,true),compressed=v.getUint32(cursor+20,true),expanded=v.getUint32(cursor+24,true),method=v.getUint16(cursor+10,true),flags=v.getUint16(cursor+8,true);
    if(cursor+46+n+x+c>directoryEnd)bad('Truncated backup directory.');
    const path=new TextDecoder('utf-8',{fatal:true}).decode(bytes.subarray(cursor+46,cursor+46+n));
    if(!allowedPath(path)||names.has(path))bad('Invalid or duplicate backup path.');names.add(path);
    if(flags&~0x0806||![0,8].includes(method)||(v.getUint32(cursor+38,true)>>>16&0xf000)===0xa000)bad('Encrypted, streaming, symlink or unsupported ZIP entry.');
    total+=expanded;if(total>LIMITS.backupBytes)bad('Expanded backup exceeds 512 MiB.');
    if(offset+30>start||v.getUint32(offset,true)!==0x04034b50)bad('Invalid local ZIP header.');
    const ln=v.getUint16(offset+26,true),lx=v.getUint16(offset+28,true),dataStart=offset+30+ln+lx;
    if(dataStart+compressed>start||v.getUint16(offset+6,true)!==flags||v.getUint16(offset+8,true)!==method||v.getUint32(offset+18,true)!==compressed||v.getUint32(offset+22,true)!==expanded||new TextDecoder('utf-8',{fatal:true}).decode(bytes.subarray(offset+30,offset+30+ln))!==path)bad('ZIP header claims disagree.');
    rows.push({path,offset,dataStart,compressed,expanded,method});cursor+=46+n+x+c;
  }
  if(cursor!==directoryEnd)bad('Invalid backup directory size.');
  let boundary=0;for(const row of [...rows].sort((a,b)=>a.offset-b.offset)){if(row.offset!==boundary)bad('Overlapping or hidden ZIP entries.');boundary=row.dataStart+row.compressed;}if(boundary!==start)bad('Unlisted ZIP bytes.');
  const entries=new Map();let actual=0;
  for(const row of rows){
    const parts=[];let written=0,finished=false;
    const receive=(chunk,final)=>{written+=chunk.length;actual+=chunk.length;if(written>row.expanded||actual>LIMITS.backupBytes)bad('Expanded backup exceeds its declared bound.');parts.push(chunk.slice());if(final)finished=true;};
    const payload=bytes.subarray(row.dataStart,row.dataStart+row.compressed);
    if(row.method===0)receive(payload,true);else{const stream=new Inflate(receive);for(let offset=0;offset<payload.length;offset+=1024)stream.push(payload.subarray(offset,offset+1024),offset+1024>=payload.length);}
    if(written!==row.expanded||!finished)bad('Truncated backup entry.');
    const result=new Uint8Array(written);let offset=0;for(const part of parts){result.set(part,offset);offset+=part.length;}entries.set(row.path,result);
  }
  return entries;
}
function closed(value,keys,label){if(!value||typeof value!=='object'||Object.keys(value).some(key=>!keys.includes(key)))throw fail('incomplete_backup','Invalid '+label+' fields.');}
export function importBackup(bytes){
  try{
    const entries=unpack(bytes),manifestBytes=entries.get('manifest.json');if(!manifestBytes)throw fail('incomplete_backup','Backup manifest is missing.');
    history_validate_backup(new TextDecoder('utf-8',{fatal:true}).decode(manifestBytes));const manifest=parseBytes(manifestBytes);
    if(entries.size!==manifest.entries.length+1)throw fail('incomplete_backup','Unlisted or missing backup entry.');
    for(const entry of manifest.entries){const content=entries.get(entry.path);if(!content||content.length!==entry.size||blob_hash(content)!==entry.hash)throw fail('incomplete_backup','Backup entry is missing or corrupt.');}
    const history=parseBytes(entries.get('history.json'));
    closed(history,['version','sequence','updatedAt','checkpoints','journal','catalog','pins','migrationBackup','migrationBackupsV2',...(history?.version>=2?['compacted']:[])],'history');
    if(history.compacted!==undefined&&typeof history.compacted!=='boolean')throw fail('incomplete_backup','Invalid history fields.');
    if(![1,2].includes(history.version)||history.version>manifest.format||!Number.isSafeInteger(history.sequence)||history.sequence<0||!Number.isSafeInteger(history.updatedAt)||history.updatedAt<0||['checkpoints','journal','catalog','pins','migrationBackupsV2'].some(key=>!Array.isArray(history[key])||history[key].length>LIMITS.backupEntries))throw fail('incomplete_backup','Invalid history version or sequence.');
    const readRow=(row,kind)=>{
      closed(row,['version','sequence','createdAt','checkpointId','updateRef','schemaVersion','name','updatedAt','files','fromVersion','assets','migration','catalogSourceId','replayOnly',...(history.version>=2?['kept']:[]),...(history.version>=2&&kind==='journal'?['from','point']:[])],kind);
      if(row.catalogSourceId!==undefined&&(typeof row.catalogSourceId!=='string'||row.catalogSourceId.length>256))throw fail('incomplete_backup','Invalid checkpoint catalogue identity.');const update=entries.get(row.updateRef);if(!/^updates\/[a-f0-9]{64}$/.test(row.updateRef)||!update)throw fail('incomplete_backup','Missing recovery update.');
      const {updateRef,...metadata}=row;return{...metadata,update};
    };
    const blobs=[...entries].filter(([path])=>path.startsWith('assets/')).map(([path,bytes])=>({hash:path.slice(7),bytes}));
    const objects=[...entries].filter(([path])=>path.startsWith('objects/')).map(([path,bytes])=>({hash:path.slice(8),bytes}));
    for(const blob of [...blobs,...objects])if(blob_hash(blob.bytes)!==blob.hash)throw fail('incomplete_backup','Object path/hash mismatch.');
    const current=checkedDoc(entries.get('project.update'),blobs);
    try{
      restorable(current);
      if(current.getMap('meta').get('lineageId')!==manifest.lineageId||current.getMap('meta').get('schemaVersion')!==manifest.schemaVersion)throw fail('incomplete_backup','Backup identity/schema mismatch.');
      const data={project:{id:crypto.randomUUID(),schemaVersion:manifest.schemaVersion,name:current.getMap('meta').get('name'),files:current.getMap('files').size,sequence:history.sequence,updatedAt:history.updatedAt,update:entries.get('project.update'),
        // Histories not yet compacted (all of format 1) are compacted when the project is first opened.
        ...(history.compacted?{history:{version:2,pointAt:history.updatedAt,maintainedSequence:-1,maintainedAt:0}}:{})},checkpoints:history.checkpoints.map(row=>readRow(row,'checkpoint')),journal:history.journal.map(row=>readRow(row,'journal')),historyCatalog:history.catalog,projectHistoryObjects:history.pins,blobs,objects,migrationBackup:history.migrationBackup?readRow(history.migrationBackup,'migration backup'):null,migrationBackupsV2:history.migrationBackupsV2.map(row=>readRow(row,'migration backup'))};
      const catalogIds=new Set();for(const row of data.historyCatalog){if(catalogIds.has(row.checkpointId))throw fail('incomplete_backup','Duplicate catalogue checkpoint.');catalogIds.add(row.checkpointId);closed(row,['checkpointId','checkpointRef','sequence','reason','projectId'],'catalog');if(!/^[a-f0-9]{64}$/.test(row.checkpointRef))throw fail('incomplete_backup','Invalid catalog reference.');const cp=verifiedCheckpoint(row.checkpointRef,objects,blobs);try{if(cp.manifest.checkpointId!==row.checkpointId)throw fail('incomplete_backup','Catalog identity mismatch.');exportable(cp.doc);}finally{cp.doc.destroy();}}
      const pinIds=new Set();for(const pin of data.projectHistoryObjects){if(pinIds.has(pin.hash+':'+pin.pin))throw fail('incomplete_backup','Duplicate history pin.');pinIds.add(pin.hash+':'+pin.pin);closed(pin,['hash','pin'],'pin');if(!objects.some(object=>object.hash===pin.hash)||typeof pin.pin!=='string'||pin.pin.length>256)throw fail('incomplete_backup','Invalid retained pin.');}
      const inv=inventory(data);validateRecovery(data,current,inv);if(inv.items.some(item=>!item.available))throw fail('incomplete_backup','A retained version is incomplete.');
      return data;
    }finally{current.destroy();}
  }catch(error){throw fail('incomplete_backup',error.message||String(error));}
}
// Keep the CRDT bytes outside JSON manifests and receipt payloads.
import {encodeStateAsUpdate as YUpdate} from 'yjs';
