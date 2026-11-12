import { applySourceEdits } from './source-edits.js';
import { projectFiles } from './model.js';
const searches=new WeakMap();
export function sourceFiles(doc,scope='') {
  return projectFiles(doc).filter(file=>!file.binary&&(!scope||file.id===scope)).map(file=>({id:file.id,path:file.path,content:doc.getText(`text:${file.id}`).toString()}));
}
const structure=files=>JSON.stringify(files.map(file=>[file.id,file.path]));
/*
 * A search plan keeps the text it searched. Typing elsewhere, in any tab or session, leaves it usable:
 * only a change to the files or paths, or to a file with matches, voids it.
 * `changedFiles` lists files already edited since they were searched.
 */
export function searchPlan(doc,files,result,scope='') {
  const current=sourceFiles(doc,scope),contents=new Map(files.map(file=>[file.id,file.content]));
  if(structure(files)!==structure(current))throw new Error('Source changed while searching. Search again for current results.');
  const changedFiles=Object.freeze(new Set(current.filter(file=>contents.get(file.id)!==file.content).map(file=>file.id)));
  const plan=Object.freeze({matches:Object.freeze(result.matches.map(Object.freeze)),truncated:result.truncated,changedFiles});
  searches.set(plan,{doc,structure:structure(files),contents,scope});return plan;
}
export function applyReplacements(doc,plan,selected) {
  const saved=searches.get(plan);
  if(!saved||saved.doc!==doc||saved.structure!==structure(sourceFiles(doc,saved.scope)))throw new Error('Source changed since this search. Search again before replacing.');
  if(plan.truncated)throw new Error('Narrow the search before replacing: not all matches fit in the preview.');
  const indexes=[...new Set(selected)];if(indexes.some(i=>!Number.isInteger(i)||i<0||i>=plan.matches.length))throw new Error('Invalid replacement selection.');
  const edits=indexes.map(i=>plan.matches[i]).filter(e=>e.text!==e.replacement).sort((a,b)=>b.start-a.start);
  // Every file with a match must be as searched, as the panel shows: selected or not.
  for(const id of new Set(plan.matches.map(match=>match.fileId)))if(doc.getText(`text:${id}`).toString()!==saved.contents.get(id))throw new Error('Source changed since this search. Search again before replacing.');
  const result=applySourceEdits(doc,edits.map(e=>({fileId:e.fileId,start:e.start,end:e.end,before:e.text,after:e.replacement})),{undoable:true});
  searches.delete(plan);return result;
}
