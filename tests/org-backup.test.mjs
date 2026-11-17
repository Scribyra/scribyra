// The remote-backup engine end to end in Node (fake IndexedDB, real WASM core) against
// the real service and PostgreSQL: back up a project with comments, reviews and history,
// erase this "browser", and restore everything from the recovery kit alone.
import './helpers/integration-session.mjs';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import * as Y from 'yjs';
import {deleteDB} from 'idb';
import * as storage from '../web/storage.js';
import {integrationSession} from './helpers/integration-session.mjs';
import {service,orgCreate} from './helpers/service.mjs';
import {orgBackup} from '../web/org-backup.js';
import {parseKit} from '../web/org-crypto.js';

// Node has no localStorage by default; the engine records "connected" there as in a browser.
if(!globalThis.localStorage){const items=new Map();globalThis.localStorage={getItem:k=>items.has(k)?items.get(k):null,setItem:(k,v)=>items.set(k,String(v)),removeItem:k=>items.delete(k)};}
// Node has no Web Locks; the browser serialises key creation and backups with them.
if(!globalThis.navigator?.locks){const tails=new Map();Object.defineProperty(globalThis.navigator,'locks',{configurable:true,value:{request(name,a,b){const fn=b||a,next=(tails.get(name)||Promise.resolve()).then(()=>fn());tails.set(name,next.catch(()=>{}));return next;}}});}
const ROOTS=['meta','files','assets','trash','authors','threads','messages','anchors','suggestions','reviews','discussionEvents','changes','versions'];
function snapshot(doc){
 const sorted=value=>Array.isArray(value)?value.map(sorted):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(k=>[k,sorted(value[k])])):value;
 const out={};for(const root of ROOTS)out[root]=sorted(doc.getMap(root).toJSON());
 for(const name of [...doc.share.keys()].filter(n=>n.startsWith('text:')).sort())out[name]=doc.getText(name).toString();
 return JSON.stringify(out);
}
// "Synced" (acknowledged and followed live) and "Backed up remotely" both mean every change is acknowledged.
async function settled(engine,id,state='backed-up'){
 const accepted=state==='backed-up'?['backed-up','synced']:[state];
 for(let i=0;i<400;i++){if(accepted.includes(engine.status(id)?.state))return;await new Promise(r=>setTimeout(r,25));}
 assert.fail(`backup did not reach ${state}: ${JSON.stringify(engine.status(id))}`);
}

test('a project with comments, reviews and history backs up encrypted and restores from the kit alone',async()=>{
 const s=await service({org:true});let engine,restoredEngine;
 try{
  const session=await integrationSession();
  const thread=session.call({op:'thread.create',fileId:'main',start:0,end:14,body:'BACKUP_DISCUSSION'},false);assert(thread.ok,JSON.stringify(thread));
  const review=session.call({op:'review.create',title:'BACKUP_REVIEW'},false);assert(review.ok,JSON.stringify(review));
  const at=session.source().indexOf('bravo');
  const proposal=session.call({op:'suggestion.propose',reviewId:review.value.reviewId,fileId:'main',start:at,end:at+5,before:'bravo',after:'BACKUP_PROPOSAL'},false);assert(proposal.ok,JSON.stringify(proposal));
  await session.context.flushSave();
  const projectId=session.projectId;

  const changes=[];engine=orgBackup({fetchImpl:fetch,onChange:id=>changes.push(id)});
  const kit=await engine.connect(await orgCreate(s,'home'));
  assert.match(kit,/scribyra-recovery:1:/);assert.equal(parseKit(kit).org,engine.info.org);
  assert.equal(engine.info.mode,'e2ee');
  await engine.backUp(projectId);await settled(engine,projectId);
  // A later edit becomes a second encrypted entry.
  session.doc.getText('text:main').insert(0,'% BACKUP_LATER_EDIT\n');await session.context.flushSave();
  await engine.push(projectId);await settled(engine,projectId);
  const links=await engine.links();assert.equal(links.length,1);assert.equal(links[0].seq,2);
  const original=snapshot(session.doc),originalVector=Y.encodeStateVector(session.doc),originalDeletes=Y.encodeStateAsUpdate(session.doc).length;
  session.close();engine.close();

  // Erase this "browser": the project, the backup database and the signing key.
  await storage.deleteProject(projectId);await deleteDB('scribyra-org');await deleteDB('scribyra-direct');localStorage.removeItem('scribyra:org-connected');

  restoredEngine=orgBackup({fetchImpl:fetch});
  const result=await restoredEngine.restore(kit);
  assert.deepEqual(result.failures,[]);assert.equal(result.restored.length,1);
  const restored=await storage.loadProject(result.restored[0].localId);
  assert.equal(snapshot(restored),original);
  // The same CRDT state, not only the same visible content: identical vectors and update size.
  assert.deepEqual(Y.encodeStateVector(restored),originalVector);assert.equal(Y.encodeStateAsUpdate(restored).length,originalDeletes);
  assert(restored.getText('text:main').toString().startsWith('% BACKUP_LATER_EDIT'));
  assert.equal(restored.getMap('threads').size,1);assert.equal(restored.getMap('suggestions').size,1);
  restored.destroy();
  // The restored browser keeps backing up under its own device key.
  assert(['backed-up','synced'].includes(restoredEngine.status(result.restored[0].localId)?.state));
  // An old kit no longer restores once replaced.
  const newer=await restoredEngine.replaceRecoveryKit();assert.notEqual(newer,kit);
  restoredEngine.close();await deleteDB('scribyra-org');await deleteDB('scribyra-direct');localStorage.removeItem('scribyra:org-connected');
  await assert.rejects(orgBackup({fetchImpl:fetch}).restore(kit),/replaced/);
 }finally{engine?.close();restoredEngine?.close();await s.close();}
});

test('a project with binary assets is refused with a plain message, and nothing is uploaded',async()=>{
 const s=await service({org:true});let engine;
 try{
  const doc=new Y.Doc(),{addFile,migrateProject}=await import('../web/model.js'),id=crypto.randomUUID();
  addFile(doc,'main.tex','x');addFile(doc,'figure.png',new Uint8Array([137,80,78,71,1,2,3]));migrateProject(doc,id);await storage.saveProject(id,doc);doc.destroy();
  await deleteDB('scribyra-org');await deleteDB('scribyra-direct');
  engine=orgBackup({fetchImpl:fetch});await engine.connect(await orgCreate(s,'assets'));
  await assert.rejects(engine.backUp(id),/binary files/);
  assert.deepEqual(await engine.links(),[]);
 }finally{engine?.close();await deleteDB('scribyra-org');await deleteDB('scribyra-direct');localStorage.removeItem('scribyra:org-connected');await s.close();}
});

// --- Review findings of slice 1: lost answers, paging, kit replacement, interrupted restore, rollback.

const erase=async()=>{for(const p of await storage.listProjects())await storage.deleteProject(p.id);await deleteDB('scribyra-org');await deleteDB('scribyra-direct');localStorage.removeItem('scribyra:org-connected');};
async function localProject(name,text){
 const {addFile,migrateProject}=await import('../web/model.js'),doc=new Y.Doc(),id=crypto.randomUUID();
 addFile(doc,'main.tex',text);migrateProject(doc,id);doc.getMap('meta').set('name',name);await storage.saveProject(id,doc);
 return{id,doc,async edit(fn){fn(doc);await storage.saveProject(id,doc);}};
}
/** fetch that loses the service's answer (after the service acted) for the first request `match` picks. */
function lossy(){
 const f={drop:null,fail:null,fetch:async(url,init)=>{
  if(f.fail?.(url,init))throw TypeError('network down');
  const response=await fetch(url,init);
  if(f.drop?.(url,init)){f.drop=null;await response.arrayBuffer().catch(()=>{});throw TypeError('connection reset');}
  return response;
 }};
 return f;
}
const isEvent=type=>(url,init)=>init?.method==='POST'&&/\/events$/.test(url)&&JSON.parse(init.body).type===type;
const names=result=>result.restored.map(r=>r.name).sort();

test('lost answers resume: genesis, project creation and a kit replacement are never lost or duplicated',async()=>{
 const s=await service({org:true}),net=lossy();let engine;
 try{
  await erase();
  const a=await localProject('Lost answers','\\documentclass{article}\\begin{document}LOST_ANSWERS\\end{document}');
  engine=orgBackup({fetchImpl:net.fetch});
  const setup=await orgCreate(s,'lost');
  // The service commits genesis but the answer is lost: connecting again resumes, it is not "already used".
  net.drop=isEvent('genesis');
  await assert.rejects(engine.connect(setup),/cannot be reached|reset/);
  const kit=await engine.connect(setup);assert.match(kit,/scribyra-recovery:1:/);
  assert.equal(await s.sql("SELECT count(*) FROM org_events WHERE raw LIKE '%\"genesis\"%'"),'1');
  // project.create is committed but its answer is lost: the retry reuses the same project.
  net.drop=isEvent('project.create');
  await assert.rejects(engine.backUp(a.id));
  await engine.push(a.id);await settled(engine,a.id);
  assert.equal(await s.sql('SELECT count(*) FROM projects'),'1');
  // recovery.set is committed but its answer is lost: the new kit is still there to save.
  net.drop=isEvent('recovery.set');
  const newer=await engine.replaceRecoveryKit().catch(()=>null);
  const pending=newer||await engine.pendingKit();
  assert.match(pending,/scribyra-recovery:1:/);assert.notEqual(pending,kit);
  // It stays until the person confirms they saved it, even across a reload.
  engine.close();engine=orgBackup({fetchImpl:fetch});await engine.start();
  assert.equal(await engine.pendingKit(),pending);
  await engine.confirmKit();assert.equal(await engine.pendingKit(),'');
  // The replaced kit's wraps are gone from the service; the new kit restores.
  const old=parseKit(kit),oldRecipient=JSON.parse(await s.sql("SELECT raw FROM org_events WHERE seq=2")).body.agreement;
  assert.equal(old.org,engine.info.org);
  assert.equal(await s.sql(`SELECT count(*) FROM wraps WHERE recipient='${oldRecipient}'`),'0');
  engine.close();await erase();
  const back=orgBackup({fetchImpl:fetch});
  try{const result=await back.restore(pending);assert.deepEqual(result.failures,[]);assert.deepEqual(names(result),['Lost answers']);}finally{back.close();}
 }finally{engine?.close();await erase();await s.close();}
});

test('restore reads every page of a long log, and an interrupted restore can be finished later',async()=>{
 const s=await service({org:true});let engine,fresh;
 try{
  await erase();
  engine=orgBackup({fetchImpl:fetch});const kit=await engine.connect(await orgCreate(s,'pages'));await engine.confirmKit();
  // Nine entries of about 2 MiB each: the service sends eight to a page (16 MiB pages), far
  // fewer than the 256-entry page size, so a reader that stops at a short page loses the rest.
  const big=await localProject('Big entries','\\documentclass{article}\\begin{document}BIG\\end{document}');
  await engine.backUp(big.id);await settled(engine,big.id);
  const noise=n=>Array.from({length:n},()=>Math.random().toString(36).slice(2)).join(' ');
  for(let i=0;i<9;i++){await big.edit(doc=>doc.getText([...doc.share.keys()].find(k=>k.startsWith('text:'))).insert(0,`%PAGE${i} `+noise(175000)+'\n'));await engine.push(big.id);await settled(engine,big.id);}
  assert.equal(Number(await s.sql('SELECT max(seq) FROM entries')),10);
  const second=await localProject('Second project','\\documentclass{article}\\begin{document}SECOND\\end{document}');
  await engine.backUp(second.id);await settled(engine,second.id);
  const expected=Y.encodeStateVector(big.doc);
  engine.close();await erase();
  // The first restore loses its connection while reading the second project's log.
  const net=lossy(),secondProject=JSON.parse(await s.sql("SELECT raw FROM org_events ORDER BY seq DESC LIMIT 1")).body.project;
  net.fail=url=>url.includes(`/v1/projects/${secondProject}/log`);
  fresh=orgBackup({fetchImpl:net.fetch});
  const first=await fresh.restore(kit);
  assert.deepEqual(names(first),['Big entries'],JSON.stringify(first.failures));assert.equal(first.failures.length,1);
  const restored=await storage.loadProject(first.restored[0].localId);
  assert.deepEqual(Y.encodeStateVector(restored),expected);
  for(let i=0;i<9;i++)assert(restored.getText([...restored.share.keys()].find(k=>k.startsWith('text:'))).toString().includes(`%PAGE${i} `));
  restored.destroy();
  // Later, without the kit: the remaining project is restored from the keys this browser kept.
  net.fail=null;
  assert.equal((await fresh.unrestored()).length,1);
  const rest=await fresh.restoreRemaining();
  assert.deepEqual(names(rest),['Second project']);assert.deepEqual(rest.failures,[]);
  assert.equal((await fresh.unrestored()).length,0);
 }finally{engine?.close();fresh?.close();await erase();await s.close();}
});

test('after a kit is replaced on one browser, projects backed up by another browser restore with the new kit',async()=>{
 const s=await service({org:true});let engine,other;
 try{
  await erase();
  engine=orgBackup({fetchImpl:fetch});const kit=await engine.connect(await orgCreate(s,'devices'));await engine.confirmKit();
  const a=await localProject('From browser A','A');await engine.backUp(a.id);await settled(engine,a.id);
  engine.close();await erase();
  // Browser B restores, backs up its own project, and replaces the kit.
  other=orgBackup({fetchImpl:fetch});await other.restore(kit);
  const b=await localProject('From browser B','B');await other.backUp(b.id);await settled(other,b.id);
  const newKit=await other.replaceRecoveryKit();await other.confirmKit();
  other.close();await erase();
  const third=orgBackup({fetchImpl:fetch});
  try{
   const result=await third.restore(newKit);
   assert.deepEqual(result.failures,[]);assert.deepEqual(names(result),['From browser A','From browser B']);
  }finally{third.close();}
  await erase();
  await assert.rejects(orgBackup({fetchImpl:fetch}).restore(kit),/replaced|not active/);
 }finally{engine?.close();other?.close();await erase();await s.close();}
});

test('a service restored from an older backup gets the lost changes uploaded again',async()=>{
 const s=await service({org:true});let engine;
 try{
  await erase();
  engine=orgBackup({fetchImpl:fetch});const kit=await engine.connect(await orgCreate(s,'rollback'));await engine.confirmKit();
  const p=await localProject('Rolled back','\\documentclass{article}\\begin{document}ROLLBACK\\end{document}');
  await engine.backUp(p.id);await settled(engine,p.id);
  const textName=[...p.doc.share.keys()].find(k=>k.startsWith('text:'));
  await p.edit(doc=>doc.getText(textName).insert(0,'% LOST_IN_ROLLBACK\n'));await engine.push(p.id);await settled(engine,p.id);
  // The operator restores yesterday's database: the second entry is gone.
  await s.sql("DELETE FROM entries WHERE seq=2; UPDATE projects SET head_seq=1, head_chain=(SELECT chain FROM entries WHERE seq=1)");
  await p.edit(doc=>doc.getText(textName).insert(0,'% AFTER_ROLLBACK\n'));
  await engine.push(p.id).catch(()=>{});await engine.push(p.id);await settled(engine,p.id);
  const expected=p.doc.getText(textName).toString();
  engine.close();await erase();
  const back=orgBackup({fetchImpl:fetch});
  try{
   const result=await back.restore(kit);assert.deepEqual(result.failures,[]);
   const doc=await storage.loadProject(result.restored[0].localId);
   assert.equal(doc.getText([...doc.share.keys()].find(k=>k.startsWith('text:'))).toString(),expected);
   assert(expected.includes('% LOST_IN_ROLLBACK')&&expected.includes('% AFTER_ROLLBACK'));doc.destroy();
  }finally{back.close();}
 }finally{engine?.close();await erase();await s.close();}
});
