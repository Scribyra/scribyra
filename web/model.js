import * as Y from 'yjs';
import {ROOTS,LIMITS} from './collaboration-schema.js';
import { assetBytes, assetSize, prepareBlob, migrateAssets } from './assets.js';
import { unzipSync, zipSync, strToU8, strFromU8 } from 'fflate';
export const MAX_BYTES = 64 * 1024 * 1024;
export const MAX_FILES = 512;
export const validPath = path => typeof path === 'string' && valid_project_path(path);
import { tree_command, valid_project_path, reference_plan, relative_project_path, private_folder_state_path } from './pkg/scribyra_app.js';
import {SCHEMA_VERSION,lineageForProject,validateCollaboration} from './collaboration-schema.js';
export {SCHEMA_VERSION} from './collaboration-schema.js';
export function assertPath(path) { if (typeof path !== 'string' || !valid_project_path(path)) throw new Error('Use a relative path of at most 240 UTF-8 bytes without .., empty segments, or special characters.'); }
export const isText = p => /\.(tex|bib|sty|cls|txt|md|csv|bst|cfg|def|json|yaml|yml|toml)$/i.test(p);
const rawNodes = doc => [...doc.getMap('files').values()];
function command(doc, operation) {
  const version=doc.getMap('meta').get('schemaVersion')??1;
  if(!Number.isInteger(version)||version<1||version>SCHEMA_VERSION)throw new Error('This project needs a newer version of Scribyra.');
  try { return JSON.parse(tree_command(JSON.stringify({ nodes: rawNodes(doc), reserved: [...doc.getMap('trash').keys()], ...operation }))); }
  catch (e) { throw new Error(String(e)); }
}
function applyNodes(doc, nodes) {
  const map = doc.getMap('files'), keep = new Set(nodes.map(n => n.id));
  for (const id of map.keys()) if (!keep.has(id)) map.delete(id);
  for (const node of nodes) {
    const record = { id: node.id, name: node.name, parentId: node.parentId ?? null, binary: node.binary, folder: node.folder };
    if (JSON.stringify(map.get(node.id)) !== JSON.stringify(record)) map.set(node.id, record);
  }
  if (!doc.getMap('meta').has('lineageId')) doc.getMap('meta').set('lineageId', crypto.randomUUID());
  if (doc.getMap('meta').get('schemaVersion') !== SCHEMA_VERSION) doc.getMap('meta').set('schemaVersion', SCHEMA_VERSION);
}
export function migrateProject(doc, projectId) {
  const version = doc.getMap('meta').get('schemaVersion') || 1;
  if (version > SCHEMA_VERSION) throw new Error('This project needs a newer version of Scribyra.');
  const nodes = command(doc, { op: 'migrate' });
  doc.transact(() => { if(version<6&&!doc.getMap('meta').has('lineageId'))doc.getMap('meta').set('lineageId',lineageForProject(projectId??doc.guid)); migrateAssets(doc); applyNodes(doc, nodes); });
  validateCollaboration(doc);
}
const viewCache = new WeakMap();
export function projectNodes(doc) {
  let cache = viewCache.get(doc);
  if (!cache) { cache = { nodes: null }; doc.getMap('files').observe(() => { cache.nodes = null; }); viewCache.set(doc, cache); }
  return cache.nodes ||= command(doc, { op: 'inspect' });
}
export function projectNode(doc, id) { return projectNodes(doc).find(n => n.id === id); }
export function projectFiles(doc) { return projectNodes(doc).filter(n => !n.folder); }
export const MAX_RETAINED_BYTES=96*1024*1024;
export function validateRetainedState(doc){
  if(doc.share.size>4096)throw new Error('Peer state has too many retained roots.');
  const maps=new Set(['meta','files','trash','assets',...ROOTS]);
  for(const [name,type]of doc.share){
    const text=name.startsWith('text:')&&name.length>5&&name.length<=245;
    if(!text&&!maps.has(name))throw new Error('Peer state has an unknown root.');
    // Yjs decodes root types lazily. Inspect both storage lanes before casting:
    // getMap alone would hide list content sent as an array under a map name.
    if(text){
      if(type._map.size)throw new Error('Peer text has an invalid shared type.');
      for(let item=type._start;item;item=item.right)if(!item.deleted&&item.content.constructor!==Y.ContentString)throw new Error('Peer text must contain plain text only.');
      doc.getText(name);
    }else{
      if(type._start)throw new Error('Peer map has an invalid shared type.');
      for(const value of doc.getMap(name).values())if(value instanceof Y.AbstractType||value instanceof Y.Doc)throw new Error('Peer records must be immutable data.');
    }
  }
  const retained=Y.encodeStateAsUpdate(doc).byteLength+[...doc.getMap('assets').values()].reduce((sum,ref)=>sum+(ref instanceof Uint8Array?0:ref?.size||0),0);
  if(retained>MAX_RETAINED_BYTES)throw new Error('Project retained state exceeds the 96 MiB direct-session limit.');
  // Checked here as well as by the semantic validator, because signatures are verified
  // between the two: a small retained state could otherwise cost 100,000 verifications.
  let records=0,semantic=0;
  for(const root of ROOTS){const map=doc.getMap(root);records+=map.size;if(records>LIMITS.records)throw new Error('Peer state exceeds the collaboration record limit.');for(const value of map.values()){semantic+=JSON.stringify(value)?.length||0;if(semantic>LIMITS.semanticBytes)throw new Error('Peer state exceeds the 16 MiB collaboration limit.');}}
}
// Local saves keep the local rules. A long-lived project may legitimately retain more
// CRDT history than a peer is obliged to accept, and must never fail to save for it.
export function validateProjectState(doc){
  validateCollaboration(doc);
  if(projectBytes(doc)>MAX_BYTES)throw new Error('Project and recoverable deleted files exceed 64 MiB.');
}
// State arriving from, or about to leave for, a direct-session peer.
export function validatePeerState(doc){
  validateRetainedState(doc);
  validateCollaboration(doc);
  projectNodes(doc);
  for(const [id,item]of doc.getMap('trash'))if(!item?.node||item.node.id!==id||typeof item.batch!=='string'||!Number.isFinite(item.deletedAt))throw new Error('Invalid recoverable deleted file.');
  // Every root counts here, including text no file refers to: nothing is ignored.
  let size=0;for(const [name]of doc.share)if(name.startsWith('text:'))size+=strToU8(doc.getText(name).toString()).length;
  for(const id of doc.getMap('assets').keys())size+=assetSize(doc,id);
  if(size>MAX_BYTES)throw new Error('Project and recoverable deleted files exceed 64 MiB.');
}
export function validateProject(doc) { return command(doc, { op: 'normalize' }); }
export function treeRows(doc, collapsed = new Set()) {
  const nodes = projectNodes(doc), byParent = new Map();
  for (const node of nodes) {
    // Invalid graph edges become visible roots until the user repairs them.
    const parent = node.conflict ? '' : node.parentId || '';
    if (!byParent.has(parent)) byParent.set(parent, []);
    byParent.get(parent).push(node);
  }
  const rows = [], seen = new Set();
  function visit(parent, depth) {
    const children = (byParent.get(parent) || []).sort((a,b) => Number(!!b.folder) - Number(!!a.folder) || a.path.localeCompare(b.path));
    children.forEach((node, i) => {
      if (seen.has(node.id)) return; seen.add(node.id);
      rows.push({ ...node, name: node.conflict ? node.path + ' ⚠' : node.name, depth, expanded: !collapsed.has(node.id), position: i+1, siblings: children.length });
      if (node.folder && !collapsed.has(node.id)) visit(node.id, depth + 1);
    });
  }
  visit('', 1);
  return rows;
}
const contentSize = content => typeof content === 'string' ? strToU8(content).length : content.byteLength;
export function projectBytes(doc) {
  const ids = new Set(projectFiles(doc).map(f => f.id));
  for (const item of doc.getMap('trash').values()) if (!item.node.folder) ids.add(item.node.id);
  let size = 0;
  for (const id of ids) size += doc.getMap('assets').has(id) ? assetSize(doc,id) : strToU8(doc.getText(`text:${id}`).toString()).length;
  return size;
}
export function addEntries(doc, entries) {
  const prepared = entries.map(e => ({ ...e, id: e.id || crypto.randomUUID() }));
  if (projectBytes(doc) + prepared.reduce((sum,e) => sum + (e.folder ? 0 : contentSize(e.content)),0) > MAX_BYTES) throw new Error('Project and recoverable deleted files exceed 64 MiB. Export a backup or use a new project.');
  if (prepared.some(e => doc.getMap('trash').has(e.id))) throw new Error('This file ID belongs to a deleted file. Restore it instead.');
  const nodes = command(doc, { op: 'add', entries: prepared.map(e => ({ id: e.id, path: e.path, folder: !!e.folder, binary: !e.folder && typeof e.content !== 'string' })) });
  const references = new Map(prepared.filter(e => !e.folder && typeof e.content !== 'string').map(e => [e.id,prepareBlob(doc,e.content)]));
  // All validation and byte decoding happens before this transaction: no partial uploads.
  doc.transact(() => {
    applyNodes(doc, nodes);
    for (const entry of prepared) if (!entry.folder) {
      if (typeof entry.content === 'string') doc.getText(`text:${entry.id}`).insert(0, entry.content);
      else doc.getMap('assets').set(entry.id, references.get(entry.id));
    }
  });
  return prepared.map(e => e.id);
}
export function addFile(doc, path, content, id = crypto.randomUUID()) { return addEntries(doc, [{ id, path, content }])[0]; }
export function addFolder(doc, path) { return addEntries(doc, [{ path, folder: true }])[0]; }
export function relocateNode(doc, id, path) {
  const nodes = command(doc, { op: 'relocate', id, path });
  doc.transact(() => applyNodes(doc, nodes));
}

const movePlans=new WeakMap();
function moveSignature(doc) {
  return JSON.stringify({nodes:rawNodes(doc),main:doc.getMap('meta').get('mainFile'),trash:[...doc.getMap('trash').keys()],texts:projectFiles(doc).filter(f=>!f.binary).map(f=>[f.id,doc.getText(`text:${f.id}`).toString()])});
}
export function planRelocation(doc,id,path) {
  const before=projectNodes(doc),after=command(doc,{op:'relocate',id,path}),next=new Map(after.map(n=>[n.id,n.path]));
  const main=projectNode(doc,doc.getMap('meta').get('mainFile'));
  const skippedConflicts=before.some(n=>n.conflict)||after.some(n=>n.conflict);
  const result=main&&!skippedConflicts?JSON.parse(reference_plan(JSON.stringify({
    mainFile:main.path,nextMainFile:next.get(main.id),
    files:projectFiles(doc).map(f=>({id:f.id,path:f.path,nextPath:next.get(f.id),content:f.binary?null:doc.getText(`text:${f.id}`).toString()})),
  }))):{edits:[],warnings:main?[]:['Select a main document to analyze relative LaTeX references.']};
  const plan=Object.freeze({edits:Object.freeze(result.edits.map(Object.freeze)),warnings:Object.freeze(result.warnings),skippedConflicts});
  movePlans.set(plan,{doc,id,path,signature:moveSignature(doc)});return plan;
}
export function applyRelocation(doc,plan,selected=[]) {
  const saved=movePlans.get(plan);
  if(!saved || saved.doc!==doc || saved.signature!==moveSignature(doc))throw new Error('Project changed while reviewing. Review the move again before applying it.');
  const indexes=[...new Set(selected)];
  if(indexes.some(i=>!Number.isInteger(i)||i<0||i>=plan.edits.length))throw new Error('Invalid reference selection.');
  const nodes=command(doc,{op:'relocate',id:saved.id,path:saved.path});
  const edits=indexes.map(i=>plan.edits[i]).sort((a,b)=>b.start-a.start);
  let bytes=projectBytes(doc);
  for(const edit of edits) {
    if(doc.getText(`text:${edit.fileId}`).toString().slice(edit.start,edit.end)!==edit.before)throw new Error('Reference changed. Review the move again.');
    bytes+=strToU8(edit.after).length-strToU8(edit.before).length;
  }
  if(bytes>MAX_BYTES)throw new Error('Reference updates would exceed the 64 MiB project limit.');
  doc.transact(()=>{
    applyNodes(doc,nodes);
    for(const edit of edits){const text=doc.getText(`text:${edit.fileId}`);text.delete(edit.start,edit.end-edit.start);text.insert(edit.start,edit.after);}
  });
  movePlans.delete(plan);
}
export function figureSnippet(doc,assetId) {
  const main=projectNode(doc,doc.getMap('meta').get('mainFile')),asset=projectNode(doc,assetId);
  if(!main || main.binary || main.folder || main.conflict || !asset || asset.folder || asset.conflict)throw new Error('Select a main document and resolve tree conflicts before inserting a figure.');
  if(!/\.(png|jpe?g|pdf)$/i.test(asset.path))throw new Error('Convert this figure to PNG, JPEG or PDF before inserting it.');
  const path=relative_project_path(main.path,asset.path);
  if(/[\\%#$~^{}"]/.test(path))throw new Error('Rename the figure to remove TeX special characters before inserting its path.');
  return `\\includegraphics[width=\\linewidth]{${path}}`;
}
export function duplicateNode(doc, id, path) {
  validateProject(doc);assertPath(path);
  const source=projectNode(doc,id);if(!source)throw new Error('File or folder no longer exists.');
  if(source.folder && (path===source.path || path.startsWith(source.path+'/')))throw new Error('Choose a destination outside the folder being duplicated.');
  // Ask the shared Rust graph for subtree membership, then atomically validate the
  // fresh nodes through the same add command used by uploads, ZIPs and folders.
  const remaining=new Set(command(doc,{op:'delete',id}).map(node=>node.id));
  const entries=projectNodes(doc).filter(node=>!remaining.has(node.id)).map(node=>({
    path:path+node.path.slice(source.path.length),folder:node.folder,
    ...(!node.folder?{content:node.binary?assetBytes(doc,node.id):doc.getText(`text:${node.id}`).toString()}:{})
  }));
  const ids=addEntries(doc,entries);return ids[entries.findIndex(entry=>entry.path===path)];
}
export function deleteNode(doc, id) {
  const nodes = command(doc, { op: 'delete', id }), keep = new Set(nodes.map(n => n.id));
  const removed = projectNodes(doc).filter(n => !keep.has(n.id)), batch = crypto.randomUUID();
  const deletedAt = Math.max(Date.now(), ...[...doc.getMap('trash').values()].map(e => e.deletedAt + 1));
  doc.transact(() => {
    for (const node of removed) doc.getMap('trash').set(node.id, { node, batch, deletedAt, main: doc.getMap('meta').get('mainFile') === node.id });
    applyNodes(doc, nodes);
    if (!keep.has(doc.getMap('meta').get('mainFile'))) doc.getMap('meta').set('mainFile', '');
  });
}
export function restoreDeleted(doc) {
  const trash = [...doc.getMap('trash').values()].sort((a,b) => b.deletedAt - a.deletedAt);
  if (!trash.length) throw new Error('There are no deleted files to restore.');
  const entries = trash.filter(e => e.batch === trash[0].batch);
  const nodes = command(doc, { op: 'restore', entries: entries.map(e => e.node) });
  doc.transact(() => {
    applyNodes(doc, nodes);
    for (const entry of entries) { doc.getMap('trash').delete(entry.node.id); if (entry.main && !doc.getMap('meta').get('mainFile')) doc.getMap('meta').set('mainFile', entry.node.id); }
  });
}
export function replaceAsset(doc, id, bytes) {
  const file = doc.getMap('files').get(id);
  if (!file || file.folder || !file.binary) throw new Error('This asset no longer exists.');
  if (projectBytes(doc) - assetSize(doc,id) + bytes.byteLength > MAX_BYTES) throw new Error('Project exceeds 64 MiB.');
  doc.getMap('assets').set(id, prepareBlob(doc,bytes));
}
export function snapshot(doc) {
  validateProject(doc);
  return projectFiles(doc).map(f => ({ ...f, content: f.binary ? assetBytes(doc,f.id) : doc.getText(`text:${f.id}`).toString() }));
}
// Inspect the central directory before decompression to reject bombs, symlinks,
// duplicate entries and traversal (unzip libraries may normalize unsafe names).
export function inspectZip(bytes) {
  if (bytes.length > MAX_BYTES) throw new Error('ZIP exceeds the 64 MiB import limit.');
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let end = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) {
    if (v.getUint32(i, true) === 0x06054b50 && i + 22 + v.getUint16(i + 20, true) === bytes.length) { end = i; break; }
  }
  if (end < 0) throw new Error('Invalid ZIP archive.');
  const count = v.getUint16(end + 10, true), start = v.getUint32(end + 16, true), size = v.getUint32(end + 12, true);
  if (count > 1024 || start + size !== end || v.getUint16(end + 4, true) || v.getUint16(end + 6, true)) throw new Error('Unsupported ZIP layout or too many files.');
  let cursor = start, total = 0;
  const names = new Set();
  for (let i = 0; i < count; i++) {
    if (cursor + 46 > end || v.getUint32(cursor, true) !== 0x02014b50) throw new Error('Invalid ZIP directory.');
    const n = v.getUint16(cursor + 28, true), x = v.getUint16(cursor + 30, true), c = v.getUint16(cursor + 32, true);
    if (cursor + 46 + n + x + c > end) throw new Error('Truncated ZIP directory.');
    const path = strFromU8(bytes.slice(cursor + 46, cursor + 46 + n));
    assertPath(path.endsWith('/') ? path.slice(0, -1) : path);
    if(private_folder_state_path(path))throw new Error('This ZIP includes private Scribyra sync/recovery state. Export a source ZIP from Scribyra, exclude .scribyra-sync, or use folder import, which skips this state.');
    if (names.has(path)) throw new Error('ZIP contains duplicate paths.');
    names.add(path);
    if (v.getUint16(cursor + 8, true) & 1) throw new Error('Encrypted ZIP archives are not supported.');
    if ((v.getUint32(cursor + 38, true) >>> 16 & 0xf000) === 0xa000) throw new Error('Symlinks are not supported.');
    total += v.getUint32(cursor + 24, true);
    if (total > MAX_BYTES) throw new Error('Expanded ZIP exceeds 64 MiB.');
    cursor += 46 + n + x + c;
  }
  if (cursor !== end) throw new Error('Invalid ZIP directory size.');
  return total;
}
export function importZip(bytes) {
  const expected = inspectZip(bytes);
  const entries = unzipSync(bytes);
  let actual = 0;
  const result = [];
  for (const [path, content] of Object.entries(entries)) {
    if (path.endsWith('/')) { result.push({ path: path.slice(0,-1), folder: true }); continue; }
    assertPath(path); actual += content.length;
    if (actual > MAX_BYTES) throw new Error('Expanded ZIP exceeds 64 MiB.');
    result.push({ path, content: isText(path) ? new TextDecoder('utf-8', { fatal: true }).decode(content) : content });
  }
  if (actual > expected) throw new Error('ZIP size metadata does not match its contents.');
  if (!result.length) throw new Error('The ZIP contains no files or folders.');
  return result;
}
export function exportZip(doc) {
  const files = Object.fromEntries(snapshot(doc).map(f => [f.path, typeof f.content === 'string' ? strToU8(f.content) : f.content]));
  for (const node of projectNodes(doc)) if (node.folder) files[node.path + '/'] = new Uint8Array();
  return zipSync(files, { level: 6 });
}
export const STARTER = String.raw`\documentclass[11pt,a4paper]{article}
\usepackage[margin=1in]{geometry}
\usepackage{amsmath,amssymb}
\usepackage{graphicx}
\usepackage{hyperref}

\title{A space for your next great idea}
\author{Your name}
\date{\today}

\begin{document}
\maketitle

\begin{abstract}
Every great paper starts with a small idea. This is yours.
Scribyra keeps the tools out of the way, so you can focus
on what you want to say.
\end{abstract}

\section{Introduction}
Welcome to your workspace. Edit this source, then press
\textbf{Compile} to see your document come to life.
Your writing and compilation stay on your own device.

\section{A little mathematics}
Beautiful ideas deserve beautiful notation:
\begin{equation}
  e^{i\pi} + 1 = 0.
\end{equation}
And sometimes, all you need is a fresh perspective:
\[
  \int_{-\infty}^{\infty} e^{-x^2}\,dx = \sqrt{\pi}.
\]

\section{What's next?}
Add a chapter, import your references, or start something
entirely new. Your project is yours to keep.

\end{document}
`;
