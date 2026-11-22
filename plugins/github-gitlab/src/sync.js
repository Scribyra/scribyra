// What a pull or push would do (docs/git-sync.md#sync-model). Pure: no network or host
// calls, so Node tests cover every case.
//
// The link keeps, per project path, a record of the last sync:
//   remote  the blob id in the branch's tree at the last synced commit (null: absent there)
//   base    the blob id the local file is based on: what was last pulled or pushed for it
//           (null: the file has no common version with the remote)
//   mode    its Git mode (100644, 100755)
//   hash    the host's fingerprint of the local file when it equalled `base` (null when it
//           did not, so it counts as changed here)
//   local   whether the file was in the project at the last sync
// A path's base differs from its remote when a remote change was not taken yet (skipped,
// or still a suggestion in Reviewing); such a path must be pulled before it is pushed.
import {pathProblem,toProjectPath} from './paths.js';

export const MAX_FILE_BYTES=16*1024*1024;
export const SKIP_REASONS=Object.freeze({
  unsafe:'Unsafe or invalid name, refused',
  private:'Git or Scribyra private state, never synced',
  symlink:'Symbolic link, not synced',
  submodule:'Git submodule, not synced',
  lfs:'Git LFS pointer, not synced',
  large:'Larger than 16 MiB, not synced',
  case:'Differs only in letter case from another file here',
  encoding:'Not valid UTF-8 text, not synced',
  excluded:'Excluded by .scribyraignore or this link’s settings',
});

/** The remote tree's files under the subfolder, by project path: {sha, mode, size, skip}. */
export function remoteFiles(entries,subfolder){
  const files=new Map();
  for(const entry of entries){
    if(entry.type==='tree')continue;
    const path=toProjectPath(subfolder,entry.path);if(path===null)continue;
    const problem=pathProblem(path);
    const skip=problem||(entry.type==='commit'||entry.mode==='160000'?'submodule':entry.mode==='120000'?'symlink':entry.type!=='blob'?'unsafe':Number.isSafeInteger(entry.size)&&entry.size>MAX_FILE_BYTES?'large':'');
    files.set(path,{sha:entry.sha,mode:entry.mode,size:entry.size??null,...(skip?{skip}:{})});
  }
  return files;
}

export function localState(record,file){
  const base=record?.base??null;
  if(file){if(!base)return 'added';if(record.local&&record.hash&&record.hash===file.hash)return 'unchanged';return 'modified';}
  return record?.local?'deleted':'absent';
}
export function remoteState(record,remote){
  const base=record?.base??null,now=remote?.sha??null;
  if(now===base)return 'unchanged';if(!base)return 'added';if(!now)return 'removed';return 'changed';
}
const lower=path=>path.normalize('NFC').toLowerCase();

/**
 * The pull plan. `records` {path → record}; `remote` from remoteFiles; `local` the
 * project's files {path → {id, hash, binary}}; `excluded(path)`. Returns
 *   items:   [{path, remote, record, file, remoteState, localState, kind}] where kind is
 *            'take' (apply theirs; nothing local to lose), 'check' (both sides changed:
 *            the same content is fine, otherwise a conflict) or 'conflict'
 *   skipped: [{path, reason}] remote changes that are never applied
 */
export function planPull({records,remote,local,excluded=()=>false}){
  const items=[],skipped=[],paths=new Set([...Object.keys(records),...remote.keys(),...local.keys()]);
  const localPaths=new Map([...local.keys()].map(path=>[lower(path),path]));
  for(const path of [...paths].sort()){
    const record=records[path],entry=remote.get(path)??null,file=local.get(path)??null;
    const rs=remoteState(record,entry);if(rs==='unchanged')continue;
    if(excluded(path)){skipped.push({path,reason:'excluded'});continue;}
    if(entry?.skip){skipped.push({path,reason:entry.skip});continue;}
    if(entry&&!file){const other=localPaths.get(lower(path));if(other&&other!==path){skipped.push({path,reason:'case'});continue;}}
    const ls=localState(record,file);
    let kind;
    if(rs==='removed')kind=ls==='unchanged'?'take':ls==='absent'||ls==='deleted'?'record':'conflict';
    else kind=ls==='unchanged'||ls==='absent'?'take':ls==='deleted'?'conflict':'check';
    items.push({path,remote:entry,record:record||null,file,remoteState:rs,localState:ls,kind});
  }
  return {items,skipped};
}

/**
 * The push plan: local changes since the last sync. Returns
 *   items:  [{path, op: 'add'|'update'|'delete', file, record}]
 *   behind: paths whose remote change was not pulled yet (pull first)
 *   excluded: paths left out by the exclusion rules
 */
export function planPush({records,local,excluded=()=>false}){
  const items=[],behind=[],skipped=[],paths=new Set([...Object.keys(records),...local.keys()]);
  for(const path of [...paths].sort()){
    const record=records[path],file=local.get(path)??null,ls=localState(record,file);
    if(ls==='unchanged'||ls==='absent')continue;
    if(pathProblem(path)){skipped.push(path);continue;}
    if(excluded(path)){skipped.push(path);continue;}
    if((record?.base??null)!==(record?.remote??null)){behind.push(path);continue;}
    items.push({path,op:ls==='added'?'add':ls==='deleted'?'delete':'update',file,record:record||null});
  }
  return {items,behind,excluded:skipped};
}

/** The number of local changes (for the status item), without reading any content. */
export function countLocalChanges({records,local,excluded=()=>false}){
  return planPush({records,local,excluded}).items.length;
}

/**
 * Records after a pull. `outcomes` {path → {result, hash?, exists}} where result is
 * 'applied' (theirs or a merge is now local; `hash` is the new fingerprint, or the file is
 * gone), 'same' (local already equals theirs), 'mine' (the person kept the local
 * version), 'pending' (not taken now: skipped, or a suggestion). Every other path learns
 * the new remote id only.
 */
export function recordsAfterPull({records,remote,outcomes}){
  const next={},paths=new Set([...Object.keys(records),...remote.keys(),...Object.keys(outcomes)]);
  for(const path of paths){
    const before=records[path]||null,entry=remote.get(path)??null,sha=entry&&!entry.skip?entry.sha:null,outcome=outcomes[path];
    let record;
    if(outcome?.result==='applied')record=outcome.exists?{remote:sha,base:sha,mode:entry?.mode||before?.mode||'100644',hash:outcome.hash,local:true}:null;
    else if(outcome?.result==='same')record=sha||outcome.exists?{remote:sha,base:sha,mode:entry?.mode||before?.mode||'100644',hash:outcome.exists?outcome.hash:null,local:!!outcome.exists}:null;
    else if(outcome?.result==='mine')record={remote:sha,base:sha,mode:entry?.mode||before?.mode||'100644',hash:null,local:true};
    else record=before?{...before,remote:sha}:sha?{remote:sha,base:null,mode:entry.mode,hash:null,local:false}:null;
    // Nothing left to remember about a path that is gone everywhere.
    if(record&&!record.remote&&!record.base&&!record.local)record=null;
    if(record)next[path]=record;
  }
  return next;
}

/** Records after a push of `pushed` [{path, op, sha, mode, hash}]. */
export function recordsAfterPush({records,pushed}){
  const next={...records};
  for(const item of pushed){
    if(item.op==='delete'){delete next[item.path];continue;}
    next[item.path]={remote:item.sha,base:item.sha,mode:item.mode||records[item.path]?.mode||'100644',hash:item.hash,local:true};
  }
  return next;
}

/**
 * Records when a project is linked at commit `commit` (a commit it was imported from).
 * Files whose content is that commit's are in sync; files that differ count as changed
 * here; remote files that are not in the project (skipped at import) stay remote only.
 * `blobIds` {path → Git blob id of the local file}.
 */
export function recordsAtLink({remote,local,blobIds}){
  const records={};
  for(const [path,entry]of remote){
    if(entry.skip)continue;
    const file=local.get(path);
    records[path]={remote:entry.sha,base:entry.sha,mode:entry.mode,hash:file&&blobIds[path]===entry.sha?file.hash:null,local:!!file};
  }
  return records;
}
