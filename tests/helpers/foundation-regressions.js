import * as Y from 'yjs';
import {openDB} from 'idb';
import * as storage from '../../web/storage.js';
import {addFile} from '../../web/model.js';
import {cloneProject} from '../../web/assets.js';
import {blob_hash} from '../../web/pkg/scribyra_app.js';
import {collaborationCommands} from '../../web/collaboration-commands.js';
import {buildCoordinator} from '../../web/build-session.js';
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return{promise,resolve};};
export async function bufferMutation(kind){
 const doc=new Y.Doc();addFile(doc,'main.tex','source');const id=crypto.randomUUID(),backing=new Uint8Array([0,1,2,3,4,0]);
 const bytes=kind==='buffer'?backing.buffer:kind==='dataView'?new DataView(backing.buffer,1,4):kind==='words'?new Uint16Array(backing.buffer,2,2):backing.subarray(1,5);
 const original=new Uint8Array(bytes.buffer??bytes,bytes.byteOffset??0,bytes.byteLength).slice(),hash=blob_hash(original),update=Y.encodeStateAsUpdate(doc);
 const pending=storage.commitPrepared(id,null,update.buffer,[{hash,bytes}],[{hash,pin:'test'}]);backing.fill(255);update.fill(255);await pending;
 const db=await openDB('scribyra-v1'),stored=await db.get('historyObjects',hash),pin=await db.get('projectHistoryObjects',[id,hash,'test']),loaded=await storage.loadProject(id);
 const result={hashMatches:blob_hash(stored.bytes)===hash,bytesMatch:stored.bytes.every((v,i)=>v===original[i]),pinned:!!pin,source:loaded.getText(`text:${[...loaded.getMap('files').keys()][0]}`).toString()};
 db.close();doc.destroy();loaded.destroy();return result;
}
export async function durableCommand(op,mode){
 const doc=new Y.Doc(),file=addFile(doc,'main.tex','base'),id=crypto.randomUUID();await storage.saveProject(id,doc);
 const db=await openDB('scribyra-v1'),pause=deferred(),entered=deferred();let active=true,commits=0,prepares=0;
 const host=collaborationCommands({doc,projectId:id,storage,isActive:()=>active});
 host.register(op,{capabilities:op==='history.name'?['history']:['edit','review'],prepare(){prepares++;const staged=cloneProject(doc);staged.getText(`text:${file}`).insert(0,'accepted ');const update=Y.encodeStateAsUpdate(staged);staged.destroy();return update;},async commit(update,scope){
  commits++;entered.resolve();await pause.promise;scope.guard();
  const bytes=new Uint8Array([1,2,3]),hash=blob_hash(bytes),result=await scope.commitPrepared(0,update,[{hash,bytes}],[{hash,pin:'durable'}],result=>({valueVersion:1,localSequence:result.sequence}));
  scope.guard();Y.applyUpdate(doc,result.update);return{valueVersion:1,localSequence:result.sequence};
 }});
 const request={version:2,requestId:crypto.randomUUID(),projectId:id,expectedRevision:host.revision(),command:{op}},first=host.execute(request);let settled=false;void first.then(()=>settled=true);await entered.promise;
 const retry=host.execute(request),reused=await host.execute({...request,command:{op,label:'different'}}),queued=host.execute({...request,requestId:crypto.randomUUID()});
 const before={settled,sequence:(await db.get('projects',id)).sequence};const put=IDBObjectStore.prototype.put;
 if(mode==='writeFailure'||mode==='transactionRevoked'||mode==='transactionRevision')IDBObjectStore.prototype.put=function(...args){
  if(this.name==='heads'){
   if(mode==='writeFailure')throw new DOMException('Durable write failed','QuotaExceededError');
   if(mode==='transactionRevoked')active=false;
   if(mode==='transactionRevision')doc.getText(`text:${file}`).insert(0,'concurrent ');
  }
  return put.apply(this,args);
 };
 if(mode==='revoked')active=false;if(mode==='closed')host.close();if(mode==='revision')doc.getText(`text:${file}`).insert(0,'concurrent ');
 pause.resolve();let reply,again,other;
 try{[reply,again,other]=await Promise.all([first,retry,queued]);}finally{IDBObjectStore.prototype.put=put;}
 const head=await db.get('projects',id),pins=await db.getAllFromIndex('projectHistoryObjects','projectId',id),source=doc.getText(`text:${file}`).toString(),completed=await host.execute(request);
 const result={before,reply,again,completed,other:other.error?.code,reused:reused.error.code,commits,prepares,sequence:head.sequence,pins:pins.length,source};
 host.close();db.close();doc.destroy();return result;
}
export async function isolatedBuilds(){
 const jobs=[],busy=[];let stopped=0;const builds=buildCoordinator((inputs,progress)=>{const done=deferred();jobs.push({inputs,progress,...done});return done.promise;},()=>stopped++,value=>busy.push(value));
 const accepted={pdf:new Uint8Array([1]),report:{issues:['accepted']},synctex:new Uint8Array([2])},before=structuredClone(accepted),previews=[];
 const inputs={files:[{path:'main.tex',content:'preview'},{path:'asset.bin',content:new Uint8Array([3])}],mainFile:'main.tex',engine:'lualatex',environment:{label:'preview'}};
 const options={projectId:'p',revision:'r1',inputs,destination:result=>previews.push(result)};
 const preview=builds.run(options);inputs.files[1].content[0]=99;inputs.environment.label='changed';
 let acceptedBusy;try{await builds.run({...options,destination:result=>Object.assign(accepted,result)});}catch(error){acceptedBusy=error.code;}
 jobs[0].resolve({pdf:new Uint8Array([4]),report:{issues:['preview']},synctex:new Uint8Array([5])});await preview;
 const preserved=JSON.stringify(accepted)===JSON.stringify(before),copied=jobs[0].inputs.files[1].content[0]===3&&jobs[0].inputs.environment.label==='preview';
 const publishing=deferred(),acceptedRun=builds.run({...options,destination:async result=>{await publishing.promise;Object.assign(accepted,result);}});
 jobs[1].resolve({pdf:new Uint8Array([6]),report:{issues:['next']},synctex:new Uint8Array([7])});await Promise.resolve();
 let previewBusy;try{await builds.run(options);}catch(error){previewBusy=error.code;}publishing.resolve();await acceptedRun;
 const abort=new AbortController(),cancelled=builds.run({...options,signal:abort.signal}).catch(error=>error.name);abort.abort();jobs[2].resolve({pdf:new Uint8Array([8])});const cancelledResult=await cancelled;
 const old=builds.run(options).catch(error=>error.name);builds.close();const fresh=builds.run(options);jobs[3].resolve({pdf:new Uint8Array([9])});const closedResult=await old;jobs[4].resolve({pdf:new Uint8Array([10])});await fresh;builds.close();
 return{acceptedBusy,previewBusy,preserved,copied,cancelledResult,closedResult,previews:previews.length,acceptedPdf:[...accepted.pdf],stopped,uniqueJobs:new Set(jobs.map(j=>j.inputs.jobId)).size===jobs.length,busy};
}
export async function committedOutcome(throwAfterCommit=false){
 const doc=new Y.Doc(),file=addFile(doc,'main.tex','base'),id=crypto.randomUUID();await storage.saveProject(id,doc);
 const boundary=deferred(),resume=deferred();let finalGuard=false,boundarySource,handlerSource,commits=0;
 const gateway={commitPrepared:(...args)=>{const options=args[5];return storage.commitPrepared(...args.slice(0,5),{...options,
  guard(){options.guard();if(finalGuard){finalGuard=false;queueMicrotask(()=>doc.getText(`text:${file}`).insert(4,' typed'));}},
  prepareCommit(result){const commit=options.prepareCommit(result);finalGuard=true;return()=>{boundarySource=doc.getText(`text:${file}`).toString();commit();boundary.resolve();};},
 });}};
 const host=collaborationCommands({doc,projectId:id,storage:gateway});
 host.register('suggestion.accept',{capabilities:['edit','review'],prepare(){const staged=cloneProject(doc);staged.getText(`text:${file}`).insert(0,'accepted ');const update=Y.encodeStateAsUpdate(staged);staged.destroy();return{update,acceptanceId:crypto.randomUUID()};},async commit(plan,scope){
  commits++;const result=await scope.commitPrepared(0,plan.update,[],[],result=>({valueVersion:1,acceptanceId:plan.acceptanceId,localSequence:result.sequence}));
  await resume.promise;handlerSource=doc.getText(`text:${file}`).toString();scope.guard();Y.applyUpdate(doc,result.update);
  if(throwAfterCommit)throw new Error('Handler failed after committed reconciliation');
  return{valueVersion:1,localSequence:999};
 }});
 const request={version:2,requestId:crypto.randomUUID(),projectId:id,expectedRevision:host.revision(),command:{op:'suggestion.accept'}},first=host.execute(request),retry=host.execute(request);
 await boundary.promise;const atBoundary=await host.execute(request);resume.resolve();const [reply,again]=await Promise.all([first,retry]),completed=await host.execute(request);
 const db=await openDB('scribyra-v1'),head=await db.get('projects',id),stored=new Y.Doc();Y.applyUpdate(stored,head.update);
 const result={reply,again,atBoundary,completed,commits,boundarySource,handlerSource,source:doc.getText(`text:${file}`).toString(),stored:stored.getText(`text:${file}`).toString(),sequence:head.sequence};
 host.close();db.close();doc.destroy();stored.destroy();return result;
}
export async function closedDurable(mode){
 const doc=new Y.Doc();addFile(doc,'main.tex','base');const id=crypto.randomUUID();await storage.saveProject(id,doc);
 const entered=deferred(),never=new Promise(()=>{});let late,transactionEnded=false,startedAfterEnd=false,signalAborted=false,transactionResult;
 const gateway={commitPrepared:(...args)=>{const options=args[5];return storage.commitPrepared(...args.slice(0,5),{...options,transaction(done){options.transaction(done);void done.then(()=>transactionEnded=true,()=>transactionEnded=true);entered.resolve();}});}};
 const firstHost=collaborationCommands({doc,projectId:id,storage:gateway}),secondHost=collaborationCommands({doc,projectId:id,storage});
 firstHost.register('history.name',{capabilities:['history'],prepare:()=>Y.encodeStateAsUpdate(doc),async commit(update,scope){
  late=()=>scope.commitPrepared(0,update,[],[],()=>({valueVersion:1}));scope.signal.addEventListener('abort',()=>signalAborted=true,{once:true});
  if(mode==='transaction')transactionResult=late().then(()=> 'committed',error=>typeof error.code==='string'?error.code:error.name);else entered.resolve();
  await never;scope.guard();return{valueVersion:1};
 }});
 secondHost.register('history.name',{capabilities:['history'],prepare(){startedAfterEnd=mode!=='transaction'||transactionEnded;const staged=cloneProject(doc);staged.getMap('meta').set('name','Second host');const update=Y.encodeStateAsUpdate(staged);staged.destroy();return update;},async commit(update,scope){const result=await scope.commitPrepared(0,update,[],[],result=>({valueVersion:1,localSequence:result.sequence}));scope.guard();Y.applyUpdate(doc,result.update);return{valueVersion:1};}});
 secondHost.register('thread.create',{capabilities:['comment'],prepare:()=>null,commit:()=>({valueVersion:1})});
 const request=host=>({version:2,requestId:crypto.randomUUID(),projectId:id,expectedRevision:host.revision(),command:{op:'history.name'}}),original=request(firstHost),first=firstHost.execute(original),retry=firstHost.execute(original);
 await entered.promise;const second=secondHost.execute(request(secondHost));firstHost.close();
 let timer;try{
  const [closed,again,live]=await Promise.race([Promise.all([first,retry,second]),new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Closed host stranded the document queue')),3000);})]);
  let lateCode;try{await late();}catch(error){lateCode=error.code;}
  const synchronous=secondHost.execute({...request(secondHost),command:{op:'thread.create'}}),db=await openDB('scribyra-v1'),head=await db.get('projects',id);db.close();
  return{closed:closed.error?.code,again:again.error?.code,live:live.ok,synchronous:synchronous.ok,lateCode,signalAborted,startedAfterEnd,transactionResult:await transactionResult,sequence:head.sequence};
 }finally{clearTimeout(timer);firstHost.close();secondHost.close();doc.destroy();}
}
