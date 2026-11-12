import './helpers/core.mjs';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import * as Y from 'yjs';
import {agentCommands} from '../web/agent-commands.js';
import {collaborationCommands} from '../web/collaboration-commands.js';
import {AgentOrigin,changeOrigins} from '../web/change-origins.js';
import {addEntries} from '../web/model.js';
import {validateCollaboration} from '../web/collaboration-schema.js';
function setup(capabilities){
 const doc=new Y.Doc();addEntries(doc,[{id:'main',path:'main.tex',content:'😀 first\n\nthird\n'+'long\n'.repeat(1000)},{id:'other',path:'other.tex',content:'other'}]);doc.getMap('meta').set('name','Fixture');doc.getMap('meta').set('mainFile','main');
 let active=true,busy=false,resolveBuild,signal,downloads=0;
 const commands=collaborationCommands({doc,projectId:'p',capabilities,isActive:()=>active}),owner={id:crypto.randomUUID(),displayName:'Owner'},managers=new Map([['main',new Y.UndoManager(doc.getText('text:main'),{trackedOrigins:new Set([null,AgentOrigin])})]]),origins=changeOrigins({doc,managers});
 const agent=agentCommands({doc,projectId:'p',commands,owner,isActive:()=>active,compile:s=>{signal=s;busy=true;return new Promise(resolve=>{resolveBuild=result=>{busy=false;resolve({projectId:'p',sourceRevision:commands.revision(),...result});};});},isBusy:()=>busy,getState:()=>({active:'main',pdfPages:1}),getPdf:()=>({bytes:new Uint8Array([37,80,68,70]),build:{sourceRevision:commands.revision()},stale:false}),download:()=>downloads++});
 const api=agent.api;
 return{doc,commands,api,owner,managers,revoke:()=>{active=false;},agent,finish:r=>resolveBuild(r),signal:()=>signal,downloads:()=>downloads,close(){agent.close();commands.close();origins.close();for(const m of managers.values())m.destroy();doc.destroy();}};
}
const patch=(api,edits,extra={})=>api.patchSource({expectedRevision:api.status().revision,edits,...extra});
test('agent dispatcher checks scope, rights, closed payloads, versions and revisions',()=>{
 const s=setup(['read']);try{
  const request={version:2,projectId:'p',requestId:'r',command:{op:'agent.status'}};
  assert.equal(s.api.execute({...request,projectId:'foreign'}).error.code,'permission_denied');
  assert.equal(s.api.execute({...request,version:1}).error.code,'unsupported_version');
  assert.equal(s.api.status({admin:true}).error.code,'invalid_request');
  assert.equal(s.api.readSource({fileId:'main',startLine:1,endLine:201}).error.code,'invalid_request');
  assert.equal(patch(s.api,[{fileId:'main',find:'first',replace:'new'}]).error.code,'permission_denied');
  assert.equal(s.api.exportPdf().error.code,'permission_denied');
  s.revoke();assert.equal(s.api.status().error.code,'project_closed');assert.throws(()=>s.api.describe(),/closed/);
 }finally{s.close();}
});
test('source reads are independent of editor rendering and keep blank lines, UTF-16 offsets and bounded continuation',()=>{
 const s=setup();try{
  const read=s.api.readSource({fileId:'main',startLine:2,endLine:3});assert.equal(read.value.content,'\nthird');assert.equal(read.value.offset,9);
  assert.equal(s.api.readSource({fileId:'main',startLine:900,endLine:902}).value.content,'long\nlong\nlong');
  s.doc.getText('text:other').insert(0,'\u0001'.repeat(20000)+'😀');
  const first=s.api.readSource({fileId:'other'});assert.equal(first.value.truncated,true);assert.ok(Buffer.byteLength(JSON.stringify(first))<65536);
  const second=s.api.readSource({fileId:'other',offset:first.value.nextOffset});assert.equal(second.value.offset,8192);
  assert.equal(s.api.readSource({fileId:'main',offset:1}).error.code,'invalid_request');
  assert.equal(s.api.readSource({fileId:'main',startLine:10000}).error.code,'invalid_request');
 }finally{s.close();}
});
test('patches reject stale/deletion-only revisions and invalid batches without author records or partial source',()=>{
 const s=setup();try{
  const old=s.api.status().revision;s.doc.getText('text:other').delete(0,1);
  assert.equal(s.api.patchSource({expectedRevision:old,edits:[{fileId:'main',find:'first',replace:'new'}]}).error.code,'revision_conflict');
  assert.equal(s.api.patchSource({edits:[{fileId:'main',find:'first',replace:'new'}]}).error.code,'revision_required');
  const before=Y.encodeStateAsUpdate(s.doc);
  for(const edits of [[{fileId:'main',find:'first',replace:'new'},{fileId:'missing',find:'bad',replace:'x'}],[{fileId:'main',find:'long',replace:'new'}],[{fileId:'main',start:1,end:2,before:'',after:'x'}],[{fileId:'main',find:'first',replace:'new'},{fileId:'main',find:'first',replace:'other'}]]){
   assert.equal(patch(s.api,edits).ok,false);assert.deepEqual(Y.encodeStateAsUpdate(s.doc),before);
  }
  assert.equal(s.doc.getMap('authors').size,0);
 }finally{s.close();}
});
test('agent transactions carry persistent authorship, isolate undo from typing, and replay once',()=>{
 const s=setup();try{
  s.doc.getText('text:main').insert(0,'human ');
  let origin,updates=0;s.doc.on('update',(_,o)=>{origin=o;updates++;});
  const options={requestId:'patch-once',expectedRevision:s.api.status().revision,edits:[{fileId:'main',find:'first',replace:'agent'}]},receipt=s.api.patchSource(options);
  assert.equal(receipt.ok,true);assert.equal(updates,1);assert.ok(origin instanceof AgentOrigin);
  assert.equal(s.doc.getMap('authors').get(receipt.value.authorId).kind,'agent');assert.equal(s.doc.getMap('authors').get(receipt.value.authorId).ownerAuthorId,s.owner.id);validateCollaboration(s.doc);
  s.doc.getText('text:main').insert(0,'later ');assert.deepEqual(s.api.patchSource(options),receipt);
  assert.equal(s.api.patchSource({...options,edits:[{fileId:'main',find:'first',replace:'changed'}]}).error.code,'request_id_reused');
  const undo=s.managers.get('main');undo.undo();assert.ok(s.doc.getText('text:main').toString().startsWith('human 😀 agent'));undo.undo();assert.ok(s.doc.getText('text:main').toString().startsWith('human 😀 first'));undo.undo();assert.ok(s.doc.getText('text:main').toString().startsWith('😀 first'));
  s.agent.close();assert.equal(s.api.patchSource(options).error.code,'project_closed');
 }finally{s.close();}
});
test('tree pagination binds revision, describe advertises implementations, and results are copies',()=>{
 const s=setup();try{
  const description=s.api.describe();assert.equal(description.experimental,true);assert.equal(description.recipe,'agent.md');assert.equal(description.operations.length,9);assert.ok(description.operations.every(op=>op.startsWith('agent.')));
  const details=s.api.describe({details:true});details.limits.sourceUnits=1;assert.equal(s.api.describe({details:true}).limits.sourceUnits,8192);
  assert.ok(JSON.stringify(description,null,2).length<1500);assert.equal(description.limits,undefined);
  const first=s.api.readTree({limit:1});assert.equal(first.value.items.length,1);assert.equal(first.value.contentType,'project-data');const cursor=first.value.nextCursor;
  assert.equal(s.api.readTree({cursor}).value.items.length,1);first.value.items[0].path='tampered';assert.equal(s.api.readTree().value.items[0].path,'main.tex');
  s.doc.getText('text:main').insert(0,'edit');assert.equal(s.api.readTree({cursor}).error.code,'revision_conflict');
 }finally{s.close();}
});
test('build start/poll is compact, busy-safe and replayable; diagnostics page bounded details; export downloads',async()=>{
 const s=setup();try{
  const options={requestId:'start'},started=s.api.compile(options);assert.equal(started.value.status,'running');assert.equal(s.api.compile().error.code,'browser_busy');
  assert.deepEqual(s.api.compile(options),started);
  const issues=Array.from({length:100},()=>({severity:'warning',code:'test',summary:'\u0001'.repeat(1000),detail:'\u0001'.repeat(8000),file:'main.tex',line:1}));s.finish({success:true,report:{issues,warningCount:100,truncated:true}});await new Promise(resolve=>setImmediate(resolve));
  const jobId=started.value.jobId;assert.equal(s.api.poll({jobId}).value.status,'succeeded');assert.equal(s.api.poll({jobId}).value.pages,1);
  let offset=0,total=0;do{const r=s.api.diagnostics({jobId,offset,limit:20,detail:true});assert.equal(r.ok,true);assert.ok(Buffer.byteLength(JSON.stringify(r))<65536);total+=r.value.items.length;offset=r.value.nextOffset;}while(offset!==null);assert.equal(total,100);
  const exported=s.api.exportPdf();assert.equal(exported.value.download,true);assert.equal(s.downloads(),1);assert.equal(exported.value.base64,undefined);
  for(let i=0;i<8;i++){s.api.compile();s.finish({success:true});await new Promise(resolve=>setImmediate(resolve));}
  assert.equal(s.api.poll({jobId}).error.code,'not_found');assert.deepEqual(s.api.compile(options),started);
 }finally{s.close();}
});
test('cancellation belongs to a session job; revocation denies results and close aborts outstanding work',async()=>{
 const s=setup();try{
  const jobId=s.api.compile().value.jobId;assert.equal(s.api.cancel({jobId:'foreign'}).error.code,'not_found');assert.equal(s.signal().aborted,false);
  assert.equal(s.api.cancel({jobId}).value.status,'cancelled');assert.equal(s.signal().aborted,true);s.finish({success:true});await new Promise(resolve=>setImmediate(resolve));assert.equal(s.api.poll({jobId}).value.status,'cancelled');
  const next=s.api.compile();s.revoke();assert.equal(s.api.poll({jobId:next.value.jobId}).error.code,'project_closed');s.agent.close();assert.equal(s.signal().aborted,true);s.finish({success:true});await new Promise(resolve=>setImmediate(resolve));
 }finally{s.close();}
});

test('path lookup and reads/patches target unopened files with compact labelled receipts',()=>{
 const s=setup();try{
  addEntries(s.doc,[{id:'folder',path:'chapters',folder:true},{id:'chapter',path:'chapters/page-050.tex',content:'😀 chapter\n\nlast'}]);
  const tree=s.api.readTree({path:'chapters/page-050.tex'});
  assert.deepEqual(tree.value.items,[{path:'chapters/page-050.tex',id:'chapter',kind:'text',size:18}]);
  assert.equal(tree.value.nextCursor,null);assert.ok(JSON.stringify(tree,null,2).length<600);
  assert.deepEqual(Object.keys(tree).sort(),['ok','revision','value']);
  const read=s.api.readSource({path:'chapters/page-050.tex',startLine:1,endLine:3});
  assert.equal(read.value.content,'😀 chapter\n\nlast');assert.equal(read.value.activationRequired,false);
  assert.equal(read.value.atRevision,undefined);assert.equal(read.value.valueVersion,undefined);
  assert.ok(JSON.stringify(read,null,2).length<650);
  const options={expectedRevision:read.revision,requestId:'path-patch',edits:[{path:'chapters/page-050.tex',find:'chapter',replace:'revised'},{path:'other.tex',start:0,end:5,before:'other',after:'changed'}]};
  const receipt=s.api.patchSource(options);assert.equal(receipt.ok,true);assert.ok(JSON.stringify(receipt,null,2).length<450);
  assert.equal(s.api.status().value.activeFile.id,'main');
  assert.equal(s.api.readSource({fileId:'chapter'}).value.content,'😀 revised\n\nlast');
  assert.deepEqual(s.api.patchSource(options),receipt);
  assert.equal(s.api.readSource({path:'missing.tex'}).error.code,'not_found');
  for(const path of ['../main.tex','/main.tex','chapters//page-050.tex','C:\\main.tex']){
   assert.equal(s.api.readSource({path}).error.code,'invalid_request');
   assert.equal(s.api.readTree({path}).error.code,'invalid_request');
   assert.equal(patch(s.api,[{path,find:'revised',replace:'bad'}]).error.code,'invalid_request');
  }
  assert.equal(s.api.readSource({fileId:'chapter',path:'main.tex'}).error.code,'invalid_request');
  assert.equal(s.api.readSource({}).error.code,'invalid_request');
  assert.equal(patch(s.api,[{fileId:'chapter',path:'main.tex',find:'revised',replace:'bad'}]).error.code,'invalid_request');
  assert.equal(s.api.readTree({path:'main.tex',cursor:{revision:read.revision,offset:0}}).error.code,'invalid_request');
  const before=Y.encodeStateAsUpdate(s.doc);
  assert.equal(patch(s.api,[{path:'other.tex',find:'changed',replace:'bad'},{path:'missing.tex',find:'x',replace:'y'}]).ok,false);
  assert.deepEqual(Y.encodeStateAsUpdate(s.doc),before);
  const raw=s.api.execute({version:2,projectId:'p',requestId:'raw',command:{op:'agent.readSource',path:'other.tex'}});
  assert.equal(raw.version,2);assert.equal(raw.value.valueVersion,1);
  const other=s.doc.getMap('files').get('other');s.doc.getMap('files').set('other',{...other,name:'main.tex'});
  assert.equal(s.api.readTree({path:'main.tex'}).error.code,'invalid_request');
  assert.equal(s.api.readSource({path:'main.tex'}).error.code,'invalid_request');
  assert.equal(patch(s.api,[{path:'main.tex',find:'first',replace:'bad'}]).error.code,'invalid_request');
  assert.equal(s.api.readSource({fileId:'main',startLine:1,endLine:1}).ok,true);
 }finally{s.close();}
});
test('bounded polls finish on completion, timeout, cancellation or close and recheck rights/revisions',async()=>{
 const s=setup();try{
  let jobId=s.api.compile().value.jobId;
  const diagnostic=s.api.diagnostics({jobId});assert.equal(diagnostic.value.status,'running');assert.match(diagnostic.value.message,/still running/);assert.equal(diagnostic.value.total,undefined);
  for(const waitMs of [-1,25001,1.5,'10'])assert.equal(s.api.poll({jobId,waitMs}).error.code,'invalid_request');
  assert.equal(s.api.poll({jobId:'unknown',waitMs:25000}).error.code,'not_found');
  assert.equal((await s.api.poll({jobId,waitMs:5})).value.status,'running');
  const expectedRevision=s.api.status().revision,waiting=s.api.poll({jobId,waitMs:25000}),bound=s.api.poll({jobId,waitMs:25000,expectedRevision});
  s.doc.getText('text:other').insert(0,'later');s.finish({success:true});
  const finished=await waiting;assert.equal(finished.value.status,'succeeded');assert.equal(finished.value.stale,true);assert.ok(JSON.stringify(finished,null,2).length<650);
  assert.equal((await bound).error.code,'revision_conflict');
  jobId=s.api.compile().value.jobId;const cancelled=s.api.poll({jobId,waitMs:25000});s.api.cancel({jobId});assert.equal((await cancelled).value.status,'cancelled');s.finish({success:true});await new Promise(resolve=>setImmediate(resolve));
  jobId=s.api.compile().value.jobId;const revoked=s.api.poll({jobId,waitMs:25000});s.revoke();s.finish({success:true});assert.equal((await revoked).error.code,'project_closed');
 }finally{s.close();}
 const s2=setup();try{
  const jobId=s2.api.compile().value.jobId,waiting=s2.api.poll({jobId,waitMs:25000});s2.agent.close();assert.equal((await waiting).error.code,'project_closed');s2.finish({success:true});
 }finally{s2.close();}
 const denied=setup(['edit']);try{assert.equal(denied.api.poll({jobId:'unknown',waitMs:25000}).error.code,'permission_denied');}finally{denied.close();}
});

test('minimal tree lists retain UTF-8 and asset byte sizes within the 100-entry budget',()=>{
 const s=setup();try{
  addEntries(s.doc,[{id:'figures',path:'figures',folder:true},{id:'image',path:'figures/image.png',binary:true,content:new Uint8Array([1,2,3])}]);
  const items=s.api.readTree().value.items;
  assert.deepEqual(items.find(item=>item.id==='figures'),{id:'figures',path:'figures',kind:'folder',size:0});
  assert.deepEqual(items.find(item=>item.id==='image'),{id:'image',path:'figures/image.png',kind:'asset',size:3});
  addEntries(s.doc,Array.from({length:100},(_,i)=>({id:crypto.randomUUID(),path:`chapters/page-${String(i).padStart(3,'0')}.tex`,content:'chapter'})));
  const page=s.api.readTree({limit:100});assert.equal(page.value.items.length,100);assert.ok(JSON.stringify(page,null,2).length<18000);
 }finally{s.close();}
});

test('every diagnostics page identifies its build revision and freshness after source lines move',async()=>{
 const s=setup();try{
  const started=s.api.compile(),jobId=started.value.jobId,sourceRevision=started.value.sourceRevision;
  assert.equal(s.api.diagnostics({jobId}).value.sourceRevision,sourceRevision);
  assert.equal(s.api.diagnostics({jobId}).value.stale,false);
  const issues=Array.from({length:3},()=>({severity:'error',code:'test',summary:'Undefined command',file:'main.tex',line:3}));
  s.finish({success:false,report:{issues}});await new Promise(resolve=>setImmediate(resolve));
  assert.equal(s.api.diagnostics({jobId}).value.stale,false);
  s.doc.getText('text:main').insert(0,'new line\n');
  for(let offset=0;offset<3;offset++){
   const page=s.api.diagnostics({jobId,offset,limit:1});
   assert.equal(page.revision,s.api.status().revision);assert.notEqual(page.revision,sourceRevision);
   assert.equal(page.value.sourceRevision,sourceRevision);assert.equal(page.value.stale,true);assert.equal(page.value.items[0].line,3);
  }
  assert.equal(s.api.diagnostics({jobId,offset:3}).value.stale,true);
 }finally{s.close();}
});

test('poll storms retain bounded waits with one timer and release capacity on every wake',async t=>{
 const s=setup(),timers=new Set(),set=globalThis.setTimeout,clear=globalThis.clearTimeout;
 t.mock.method(globalThis,'setTimeout',(fn,ms)=>{const timer=set(()=>{timers.delete(timer);fn();},ms);timers.add(timer);return timer;});
 t.mock.method(globalThis,'clearTimeout',timer=>{timers.delete(timer);clear(timer);});
 try{
  let jobId=s.api.compile().value.jobId;
  const limit=s.api.describe({details:true}).limits.jobPendingPolls,waits=[];
  for(let i=0;i<5000;i++){
   const result=s.api.poll({jobId,waitMs:20});
   if(i<limit)waits.push(result);else{assert.equal(result.ok,false);assert.equal(result.error.code,'too_many_waiters');}
   assert.equal(timers.size,1);
  }
  assert.equal(s.api.poll({jobId}).value.status,'running');
  assert.ok((await Promise.all(waits)).every(result=>result.value.status==='running'));assert.equal(timers.size,0);
  const cancelled=s.api.poll({jobId,waitMs:25000});s.api.cancel({jobId});assert.equal((await cancelled).value.status,'cancelled');assert.equal(timers.size,0);
  s.finish({success:true});await new Promise(resolve=>setImmediate(resolve));
  jobId=s.api.compile().value.jobId;const completed=s.api.poll({jobId,waitMs:25000});s.finish({success:true});assert.equal((await completed).value.status,'succeeded');assert.equal(timers.size,0);
  jobId=s.api.compile().value.jobId;const closed=s.api.poll({jobId,waitMs:25000});s.agent.close();assert.equal((await closed).error.code,'project_closed');assert.equal(timers.size,0);s.finish({success:true});
 }finally{s.close();t.mock.restoreAll();}
});

test('shared poll timer rearms when the host fires before the deadline',async t=>{
 const s=setup(),timers=new Map();let now=0;
 t.mock.method(performance,'now',()=>now);
 t.mock.method(globalThis,'setTimeout',fn=>{const id=Symbol();timers.set(id,fn);return id;});
 t.mock.method(globalThis,'clearTimeout',id=>timers.delete(id));
 const fire=()=>{const [id,fn]=timers.entries().next().value;timers.delete(id);fn();};
 try{
  const jobId=s.api.compile().value.jobId,waiting=s.api.poll({jobId,waitMs:5});
  assert.equal(timers.size,1);fire();assert.equal(timers.size,1);
  now=5;fire();assert.equal(timers.size,0);assert.equal((await waiting).value.status,'running');
  s.finish({success:true});
 }finally{s.close();t.mock.restoreAll();}
});
