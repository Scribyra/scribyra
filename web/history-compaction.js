// History size policy (docs/history.md, "Stored history size"). Pure functions only:
// storage.js applies them inside its guarded IndexedDB transactions.
import {ROOTS} from './collaboration-schema.js';

/** Typing bursts: one change record per author, session, kind and file until a pause this long. */
export const BURST_PAUSE_MS=60_000;
/** A burst never spans more than one automatic version, so a version diff always names who typed after it. */
export const BURST_MAX_MS=5*60_000;
/** Automatic versions: at most one per this interval of saving, plus the state before every pause this long. */
export const POINT_INTERVAL_MS=5*60_000;
export const POINT_GAP_MS=2*60_000;
/** A replay base is stored once the updates since the previous one outweigh a copy of the project, and never below this. */
export const BASE_MIN_BYTES=1024*1024;
/** Saves between automatic maintenance runs, and the longest a thinned history waits. */
export const MAINTAIN_SAVES=600;
export const MAINTAIN_INTERVAL_MS=60*60_000;
/** One maintenance step rewrites at most this many journal bytes in a single IndexedDB transaction. */
export const SEGMENT_BYTES=32*1024*1024;

export const pointDue=(lastPointAt,now=Date.now())=>!Number.isFinite(lastPointAt)||now-lastPointAt>=POINT_INTERVAL_MS;

const HOUR=3_600_000,DAY=24*HOUR,WEEK=7*DAY;
function bucket(age,at){
  if(age<=HOUR)return null;
  if(age<=DAY)return'h'+Math.floor(at/HOUR);
  const local=new Date(at);
  if(age<=30*DAY)return'd'+local.getFullYear()+'-'+local.getMonth()+'-'+local.getDate();
  // Weeks start on Monday (1970-01-05 was one).
  return'w'+Math.floor((at-4*DAY)/WEEK);
}
/** The thinning ladder: every automatic version from the last hour, then the latest one per
 * hour for a day, per day for a month and per week after that. `points` are {id,createdAt}. */
export function ladder(points,now=Date.now()){
  const keep=new Set(),latest=new Map();
  for(const point of points){
    const key=bucket(Math.max(0,now-point.createdAt),point.createdAt);
    if(key===null){keep.add(point.id);continue;}
    const best=latest.get(key);
    if(!best||point.createdAt>best.createdAt||point.createdAt===best.createdAt&&point.sequence>best.sequence)latest.set(key,point);
  }
  for(const point of latest.values())keep.add(point.id);
  const newest=[...points].sort((a,b)=>b.createdAt-a.createdAt||b.sequence-a.sequence)[0];if(newest)keep.add(newest.id);
  return keep;
}

const UUID=/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
/** Change IDs any other record refers to. Named versions' `basedOnChangeIds` describe their own
 * immutable checkpoint, which keeps every record it names, so they do not pin live records. */
export function citedChanges(doc){
  const cited=new Set();
  const visit=value=>{if(typeof value==='string'){if(UUID.test(value))cited.add(value);}else if(Array.isArray(value))value.forEach(visit);else if(value&&typeof value==='object')for(const [key,inner]of Object.entries(value))if(key!=='basedOnChangeIds')visit(inner);};
  for(const root of ROOTS)for(const [id,record]of doc.getMap(root)){
    if(root==='changes'){for(const key of ['suggestionId','proposedBy','undoOf','restoreOf'])visit(record?.[key]);continue;}
    visit(record);
  }
  for(const key of doc.getMap('meta').keys())if(key.startsWith('directProof:changes:'))cited.add(key.slice(20));
  return cited;
}
const coalescible=record=>['source-edit','undo-redo'].includes(record?.kind)&&record.actorKind==='human'&&Array.isArray(record.fileIds)&&record.fileIds.length===1&&!record.suggestionId&&!record.proposedBy&&!record.undoOf&&!record.restoreOf&&Number.isSafeInteger(record.createdAt);
/** Direct-session peers refuse removed attributed records, so a project that has carried
 * session proofs or claims keeps every record it has. */
export const sharedInSession=doc=>[...doc.getMap('meta').keys()].some(key=>key.startsWith('directProof:')||key.startsWith('directClaim:'));
/** Per-keystroke records merged into bursts with the same rule as live typing: the first record
 * of a burst stands for it. `boundaries` are times bursts must not span (automatic versions). */
export function redundantChanges(doc,{boundaries=[]}={}){
  if(sharedInSession(doc))return{remove:[],keptFor:new Map()};
  const cited=citedChanges(doc),records=[...doc.getMap('changes').values()].filter(record=>record&&typeof record==='object').sort((a,b)=>a.createdAt-b.createdAt||String(a.id).localeCompare(String(b.id)));
  const cuts=[...new Set(boundaries)].filter(Number.isFinite).sort((a,b)=>a-b);
  const crosses=(from,to)=>{let low=0,high=cuts.length;while(low<high){const mid=(low+high)>>1;if(cuts[mid]<=from)low=mid+1;else high=mid;}return low<cuts.length&&cuts[low]<=to;};
  const open=new Map(),remove=[],keptFor=new Map();
  for(const record of records){
    const session=record.sessionId,burst=open.get(session),key=coalescible(record)?[record.authorId,record.kind,record.fileIds[0]].join('\n'):null;
    if(key&&burst&&burst.key===key&&record.createdAt-burst.lastAt<BURST_PAUSE_MS&&record.createdAt-burst.first.createdAt<BURST_MAX_MS&&!crosses(burst.lastAt,record.createdAt)&&!cited.has(record.id)){
      remove.push(record.id);keptFor.set(record.id,burst.first.id);burst.lastAt=record.createdAt;continue;
    }
    // Live typing ends every burst when any other record appears (web/history.js); so does this.
    open.clear();if(key)open.set(session,{key,first:record,lastAt:record.createdAt});
  }
  return{remove,keptFor};
}
/** What a compaction may change: only redundant change records disappear, each represented by a
 * kept record of the same author, session, kind and file. Everything else is identical. */
export function verifyCoalesced(before,after,keptFor){
  const json=value=>JSON.stringify(value);
  for(const name of new Set([...before.share.keys(),...after.share.keys()])){
    if(name==='changes')continue;
    if(name.startsWith('text:')){if(before.getText(name).toString()!==after.getText(name).toString())throw new Error('Compaction changed the text of '+name+'.');continue;}
    if(json(before.getMap(name).toJSON())!==json(after.getMap(name).toJSON()))throw new Error('Compaction changed '+name+'.');
  }
  const was=before.getMap('changes'),now=after.getMap('changes');
  for(const [id,record]of was){
    if(now.has(id)){if(json(now.get(id))!==json(record))throw new Error('Compaction rewrote a change record.');continue;}
    const kept=now.get(keptFor.get(id));
    if(!kept||kept.authorId!==record.authorId||kept.sessionId!==record.sessionId||kept.kind!==record.kind||json(kept.fileIds)!==json(record.fileIds))throw new Error('Compaction lost the attribution of a change.');
  }
  for(const id of now.keys())if(!was.has(id))throw new Error('Compaction added a change record.');
}
