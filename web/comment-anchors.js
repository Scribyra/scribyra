import * as Y from 'yjs';
import {projectNode} from './model.js';
import {validate_comment_range} from './pkg/scribyra_app.js';
import {textMemo} from './text-memo.js';

const failure=(code,message)=>Object.assign(new Error(message),{code});
const scalars=(text,limit)=>{let result='',count=0;for(const scalar of text){if(count++===limit)break;result+=scalar;}return result;};
const relative=(text,index,assoc)=>Y.relativePositionToJSON(Y.createRelativePositionFromTypeIndex(text,index,assoc));
function source(doc,fileId){
  const file=projectNode(doc,fileId);
  if(!file||file.folder||file.binary)throw failure('anchor_detached','The source file is missing or is not text.');
  const existing=doc.share.get(`text:${fileId}`);
  if(existing&&existing.constructor!==Y.AbstractType&&!(existing instanceof Y.Text))throw Object.assign(failure('anchor_detached','The source root is not text.'),{reason:'unknown_type'});
  const text=doc.getText(`text:${fileId}`);
  return{file,text};
}
function absolute(doc,position,text,follow=false){
  try{const result=Y.createAbsolutePositionFromRelativePosition(Y.createRelativePositionFromJSON(position),doc,follow);return result?.type===text?result.index:null;}catch{return null;}
}
// All access to Yjs item structs stays in this adapter. Runs contain UTF-16 clocks.
function selected(text,start,end){
  const runs=[];let index=0;
  for(let item=text._start;item;item=item.right){
    if(item.deleted||!item.countable)continue;
    const left=Math.max(start,index),right=Math.min(end,index+item.length);
    if(left<right){
      const run={client:item.id.client,clock:item.id.clock+left-index,length:right-left},last=runs.at(-1);
      if(last&&last.client===run.client&&last.clock+last.length===run.clock)last.length+=run.length;else{runs.push(run);if(runs.length>4096)throw failure('invalid_request','This selection is too fragmented. Select a smaller range.');}
    }
    index+=item.length;if(index>=end)break;
  }
  return runs;
}
function firstAfter(items,clock,end){let low=0,high=items.length;while(low<high){const mid=(low+high)>>>1;if(end(items[mid])<=clock)low=mid+1;else high=mid;}return low;}
function surviving(text,runs,visit=()=>{}){
  const clients=new Map();for(const run of runs){if(!clients.has(run.client))clients.set(run.client,[]);clients.get(run.client).push(run);}
  for(const intervals of clients.values())intervals.sort((a,b)=>a.clock-b.clock);
  let index=0,start=Infinity,end=-1,length=0;
  for(let item=text._start;item;item=item.right){
    if(item.deleted||!item.countable)continue;
    const intervals=clients.get(item.id.client)||[];
    for(let i=firstAfter(intervals,item.id.clock,run=>run.clock+run.length);i<intervals.length&&intervals[i].clock<item.id.clock+item.length;i++){
      const run=intervals[i];
      const left=Math.max(item.id.clock,run.clock),right=Math.min(item.id.clock+item.length,run.clock+run.length);
      if(left<right){const from=index+left-item.id.clock,to=index+right-item.id.clock;start=Math.min(start,from);end=Math.max(end,to);length+=right-left;visit(from,to);}
    }
    index+=item.length;
  }
  return end<0?null:{start,end,length};
}
export function capture(doc,fileId,start,end){
  if(typeof fileId!=='string'||!Number.isSafeInteger(start)||!Number.isSafeInteger(end))return captureNow(doc,fileId,start,end);
  return structuredClone(textMemo(doc,fileId,`capture:${start}:${end}`,()=>captureNow(doc,fileId,start,end)));
}
function captureNow(doc,fileId,start,end){
  const {file,text}=source(doc,fileId),value=textMemo(doc,fileId,'string',()=>text.toString());
  if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start<0||end<0)throw failure('invalid_request','Select a current source range.');
  try{validate_comment_range(value,start,end);}catch(error){throw failure('invalid_request',String(error));}
  const kind=start===end?'point':'range';
  return{fileId,kind,start:relative(text,start,0),end:relative(text,end,kind==='range'?-1:0),witnesses:kind==='range'?selected(text,start,end):[],quote:scalars(value.slice(start,end),1024),prefix:Array.from(value.slice(Math.max(0,start-256),start)).slice(-128).join(''),suffix:scalars(value.slice(end),128),pathAtCreation:file.path};
}
export function resolve(doc,anchor){
  if(typeof anchor?.fileId!=='string')return resolveNow(doc,anchor);
  return {...textMemo(doc,anchor.fileId,'resolve:'+JSON.stringify(anchor),()=>resolveNow(doc,anchor))};
}
function resolveNow(doc,anchor){
  const detached=reason=>({status:'detached',reason});
  let text;try{({text}=source(doc,anchor.fileId));}catch(error){return detached(error.reason||'missing_file');}
  if(!['range','point'].includes(anchor.kind))return detached('unknown_type');
  const start=absolute(doc,anchor.start,text),end=absolute(doc,anchor.end,text);
  if(start===null||end===null)return detached('unresolvable_position');
  if(start>end)return detached('reversed_range');
  if(anchor.kind==='point'){
    if(anchor.start.item&&!surviving(text,[{...anchor.start.item,length:1}]))return detached('associated_item_deleted');
    return{status:'attached',start,end:start};
  }
  const live=surviving(text,anchor.witnesses);
  if(!live)return detached('selection_deleted');
  if(start===end)return detached('collapsed_range');
  const narrowed={start:Math.max(start,live.start),end:Math.min(end,live.end)};
  if(narrowed.start>=narrowed.end)return detached('collapsed_range');
  return{status:'attached',...narrowed};
}
export function isNarrowed(doc,anchor){
  if(anchor.kind!=='range')return false;
  if(typeof anchor.fileId==='string')return textMemo(doc,anchor.fileId,'narrowed:'+JSON.stringify(anchor),()=>narrowedNow(doc,anchor));
  return narrowedNow(doc,anchor);
}
function narrowedNow(doc,anchor){
  try{const live=surviving(source(doc,anchor.fileId).text,anchor.witnesses);return !!live&&live.length<anchor.witnesses.reduce((sum,run)=>sum+run.length,0);}catch{return false;}
}
export function rebind(doc,anchor,fileId,start,end){return{...anchor,...capture(doc,fileId,start,end)};}

// Checkpoint restoration copies exact text but may replace its item identities.
// Map surviving selected intervals only; gaps never become selection witnesses.
export function checkpointBinding(checkpoint,restored,anchor,fileId){
  try{
    const resolved=resolve(checkpoint,anchor);if(resolved.status!=='attached')return null;
    const original=source(checkpoint,anchor.fileId).text,text=source(restored,fileId).text;
    if(original.toString()!==text.toString())return null;
    const witnesses=[];
    if(anchor.kind==='range'){
      surviving(original,anchor.witnesses,(from,to)=>{
        const start=Math.max(from,resolved.start),end=Math.min(to,resolved.end);
        if(start<end)witnesses.push(...selected(text,start,end));
      });
      if(!witnesses.length||witnesses.length>4096)return null;
    }
    return{...anchor,fileId,start:relative(text,resolved.start,0),end:relative(text,resolved.end,anchor.kind==='range'?-1:0),witnesses};
  }catch{return null;}
}

// Only an actual undo/redo transaction may follow local redo links. Persisting the
// resulting binding makes restored identities resolve on peers and after reload.
export function restoredBinding(doc,anchor){
  let text;try{({text}=source(doc,anchor.fileId));}catch{return null;}
  const runs=[],pending=anchor.kind==='range'?anchor.witnesses.map(run=>({...run})):anchor.start.item?[{...anchor.start.item,length:1}]:[];let changed=false;
  while(pending.length){
    const {client,clock,length}=pending.pop(),structs=doc.store.clients.get(client)||[];
    for(let i=firstAfter(structs,clock,item=>item.id.clock+item.length);i<structs.length&&structs[i].id.clock<clock+length;i++){
      const item=structs[i],left=Math.max(clock,item.id.clock),right=Math.min(clock+length,item.id.clock+item.length);
      if(left>=right)continue;
      if(item.redone){changed=true;pending.push({client:item.redone.client,clock:item.redone.clock+left-item.id.clock,length:right-left});}
      else runs.push({client,clock:left,length:right-left});
    }
  }
  if(!changed)return null;
  const live=surviving(text,runs);if(!live)return null;
  if(anchor.kind==='point')return rebind(doc,anchor,anchor.fileId,live.start,live.start);
  runs.sort((a,b)=>a.client-b.client||a.clock-b.clock);
  const witnesses=[];for(const run of runs){const last=witnesses.at(-1);if(last&&last.client===run.client&&last.clock+last.length===run.clock)last.length+=run.length;else witnesses.push(run);}
  return{...anchor,start:relative(text,live.start,0),end:relative(text,live.end,-1),witnesses};
}
export const anchors=Object.freeze({capture,resolve,rebind,checkpointBinding});

// Wire updates omit local redo links and can merge their struct boundaries. Rebuild
// those boundaries on an isolated document before rehearsing the exact undo stack.
export function previewUndo(doc,manager,prepare){
  const staged=new Y.Doc({gc:false});let undo;
  try{
    Y.applyUpdate(staged,Y.encodeStateAsUpdate(doc));
    for(const [name,type] of doc.share){if(type instanceof Y.Text)staged.getText(name);else if(type instanceof Y.Map)staged.getMap(name);}
    staged.clientID=doc.clientID;
    staged.transact(transaction=>{
      for(const structs of doc.store.clients.values())for(const item of structs){
        if(!item.redone)continue;
        const copy=Y.getItemCleanStart(transaction,item.id);
        const end=item.id.clock+item.length;
        if(end<Y.getState(staged.store,item.id.client))Y.getItemCleanStart(transaction,Y.createID(item.id.client,end));
        copy.redone=Y.createID(item.redone.client,item.redone.clock);
      }
    });
    const scope=manager.scope.map(type=>type===doc?staged:type._item?Y.getItem(staged.store,type._item.id).content.type:staged.share.get([...doc.share].find(([,value])=>value===type)[0]));
    undo=new Y.UndoManager(scope,{doc:staged,captureTimeout:0,deleteFilter:manager.deleteFilter,ignoreRemoteMapChanges:manager.ignoreRemoteMapChanges});
    const stack=items=>items.map(item=>({...item,insertions:structuredClone(item.insertions),deletions:structuredClone(item.deletions),meta:new Map(item.meta)}));
    undo.undoStack=stack(manager.undoStack);undo.redoStack=stack(manager.redoStack);
    undo[manager.redoing?'redo':'undo']();
    return prepare(staged);
  }finally{undo?.destroy();staged.destroy();}
}
