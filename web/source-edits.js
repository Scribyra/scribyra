import * as Y from 'yjs';
import {retireUndoOnReplacement} from './change-origins.js';
import { validate_source_patch } from './pkg/scribyra_app.js';
import { projectFiles,projectBytes } from './model.js';
export function commandError(error){
  if(error instanceof Error)return error;
  try{const value=JSON.parse(String(error));return Object.assign(new Error(value.message),{code:value.code});}catch{return new Error(String(error));}
}
export function applySourceEdits(doc,edits,{origin=null,undoable=false}={}){
  const wanted=new Set(edits.map(e=>e.fileId)),sources=Object.fromEntries(projectFiles(doc).filter(f=>!f.binary&&wanted.has(f.id)).map(f=>[f.id,doc.getText(`text:${f.id}`).toString()]));
  let plan;try{plan=JSON.parse(validate_source_patch(JSON.stringify(edits),JSON.stringify(sources),projectBytes(doc)));}catch(error){throw commandError(error);}
  plan=plan.filter(e=>e.before!==e.after);
  if(undoable)origin={};
  const types=[...new Set(plan.map(e=>doc.getText(`text:${e.fileId}`)))],undo=undoable?new Y.UndoManager(types,{trackedOrigins:new Set([origin]),captureTimeout:0}):undefined;
  if(undo)retireUndoOnReplacement(doc,undo);
  doc.transact(()=>{for(const edit of plan){const text=doc.getText(`text:${edit.fileId}`);text.delete(edit.start,edit.end-edit.start);text.insert(edit.start,edit.after);}},origin);
  return {count:plan.length,undo};
}
