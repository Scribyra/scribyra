import {delegatedAuthorId} from './direct-provenance.js';
import {directEnabled} from './direct-state.js';
import {agent_limits,validate_source_patch,validate_collaboration_state} from './pkg/scribyra_app.js';
import {projectNodes,projectNode,projectBytes} from './model.js';
import {applySourceEdits,commandError} from './source-edits.js';
import {assetSize} from './assets.js';
import {AgentOrigin} from './change-origins.js';
import {ROOTS} from './collaboration-schema.js';
import {boundedText} from './build-errors.js';
import {sourceChunk,projectBuildResult} from './project-operations.js';
const failure=(code,message)=>Object.assign(new Error(message),{code});
const value=fields=>({valueVersion:1,contentType:'project-data',...fields});
const jsonBytes=value=>new TextEncoder().encode(JSON.stringify(value)).length;
export {localAuthor as localAgentOwner} from './local-author.js';
// Installed by the trusted workspace, on its internal v2 dispatcher. Closing the
// project also revokes retained references, pending jobs and successful retries.
export function agentCommands({doc,projectId,commands,owner,ensureUndo=()=>{},compile,isBusy,getState,getPdf,download,isActive=()=>true,build=null}){
 // With sessions on, the agent's ID derives from its owner and session so peers can check the
 // delegation. Off, it is a random ID drawn exactly as before direct sessions existed.
 const limits=Object.freeze(JSON.parse(agent_limits())),drawn=directEnabled()?null:crypto.randomUUID(),sessionId=crypto.randomUUID(),authorId=drawn||delegatedAuthorId(owner.id,sessionId),jobs=new Map(),unregister=[];
 const actor=Object.freeze({author:Object.freeze({id:authorId,kind:'agent',displayName:'Agent',ownerAuthorId:owner.id}),sessionId,origin:fields=>new AgentOrigin({authorId,ownerAuthorId:owner.id,sessionId,...fields})});
 let closed=false,waitTimer;
 const pendingWaits=new Set();
 // Share one timer, rearming even when the host fires before a deadline.
 const scheduleWaits=()=>{
  clearTimeout(waitTimer);
  if(pendingWaits.size)waitTimer=setTimeout(()=>{const now=performance.now();for(const done of [...pendingWaits])if(done.deadline<=now)done();scheduleWaits();},Math.max(0,Math.min(...[...pendingWaits].map(done=>done.deadline))-performance.now()));
 };
 const active=()=>{if(closed||!isActive())throw failure('project_closed','This agent session is closed.');};
 const revision=()=>commands.revision();
 const fileFor=target=>{
  const matches=target.path?projectNodes(doc).filter(file=>file.path===target.path):[];
  if(matches.length>1)throw failure('invalid_request','This path is ambiguous; use a stable fileId.');
  const file=target.path?matches[0]:projectNode(doc,target.fileId);
  if(!file)throw failure('not_found','No live project file matches this path or fileId.');return file;
 };
 const wake=job=>{for(const done of job.waiters)done();};
 const compact=receipt=>{
  const {revision,ok,value,error}=receipt;
  if(!ok)return{revision,ok,error};
  const {valueVersion,...fields}=value;return{revision,ok,value:fields};
 };
 const jobFor=id=>{const job=jobs.get(id);if(!job)throw failure('not_found','This build is unavailable in this agent session.');return job;};
 const freshness=job=>({sourceRevision:job.revision,stale:job.revision!==revision()});
 const summary=job=>value({...job.labels,jobId:job.id,status:job.status,...freshness(job),success:job.result?.success??null,pages:job.pages??null,warnings:job.result?.report?.warningCount??0,errors:job.result?.report?.issues?.filter(i=>i.severity==='error').length??0,...(job.error?{error:job.error}:{})});
 const startJob=(run,{kind='accepted',sourceRevision=revision(),...labels}={})=>{
  active();if(isBusy())throw failure('browser_busy','A build is already running.');
  const job={id:crypto.randomUUID(),revision:sourceRevision,kind,labels,status:'running',controller:new AbortController(),waiters:new Set()};jobs.set(job.id,job);
  while(jobs.size>limits.retainedBuilds)jobs.delete(jobs.keys().next().value);
  let pending;try{pending=run(job.controller.signal);}catch(error){pending=Promise.reject(error);}
  Promise.resolve(pending).then(result=>{
   active();if(job.controller.signal.aborted){job.status='cancelled';return;}
   job.result=projectBuildResult(result,projectId);
   job.status=job.result?(job.result.errorType==='AbortError'?'cancelled':job.result.success?'succeeded':'failed'):'cancelled';
   job.pages=job.result?.success?(kind==='accepted'&&!getState().stale?getState().pdfPages:null):0;
  }).catch(error=>{job.status=job.controller.signal.aborted||error.name==='AbortError'?'cancelled':'failed';job.error={code:typeof error.code==='string'?error.code:'operation_failed',message:boundedText(error.message,512)};}).finally(()=>wake(job));
  return summary(job);
 };
 const handlers={
  status:{capabilities:['read'],prepare:()=>null,commit:()=>{
   const state=getState(),file=projectNode(doc,state.active);
   return value({name:doc.getMap('meta').get('name'),mainFile:doc.getMap('meta').get('mainFile'),activeFile:file?{id:file.id,path:file.path}:null,busy:isBusy(),latestJobId:[...jobs.keys()].at(-1)||null});
  }},
  tree:{capabilities:['read'],prepare:command=>{
   if(command.cursor&&command.cursor.revision!==revision())throw failure('revision_conflict','The tree changed; restart pagination.');
   const nodes=command.path?[fileFor(command)]:projectNodes(doc),offset=command.cursor?.offset||0,items=[];
   if(offset>nodes.length)throw failure('invalid_request','Tree offset is outside the project.');
   for(const node of nodes.slice(offset,offset+(command.limit??limits.treeDefault))){
    const item={path:node.path,id:node.id,kind:node.folder?'folder':node.binary?'asset':'text',size:node.folder?0:node.binary?assetSize(doc,node.id):new TextEncoder().encode(doc.getText(`text:${node.id}`).toString()).length};
    if(jsonBytes([...items,item])>limits.treeBytes)break;items.push(item);
   }
   return value({items,total:nodes.length,nextCursor:offset+items.length<nodes.length?{revision:revision(),offset:offset+items.length}:null});
  },commit:prepared=>prepared},
  readSource:{capabilities:['read'],prepare:command=>{
   const file=fileFor(command);if(file.folder||file.binary)throw failure('not_found','The target is not a live source file.');
   const text=doc.getText(`text:${file.id}`).toString(),start=command.startLine??1,requestedEnd=command.endLine??start+49;
   let totalLines=1,from=start===1?0:null,to=null;
   for(let at=-1;(at=text.indexOf('\n',at+1))>=0;){if(totalLines===requestedEnd)to=at;totalLines++;if(totalLines===start)from=at+1;}
   if(from===null)throw failure('invalid_request','The starting line is outside the file.');
   to??=text.length;const end=Math.min(requestedEnd,totalLines),offset=command.offset??from;
   if(offset<from||offset>to)throw failure('invalid_request','The read offset is outside the selected lines.');
   const chunk=sourceChunk(text,offset,Math.min(limits.sourceUnits,to-offset));
   return value({fileId:file.id,path:file.path,startLine:start,endLine:end,totalLines,offset,content:chunk.content,nextOffset:chunk.nextOffset<to?chunk.nextOffset:null,truncated:chunk.nextOffset<to,activationRequired:false});
  },commit:prepared=>prepared},
  patchSource:{capabilities:['edit'],prepare:command=>{
   const edits=command.edits.map(edit=>{
    const file=fileFor(edit);if(file.binary||file.folder)throw failure('not_found','The target is not a live source file.');
    const {path,...fields}=edit;
    if(!Object.hasOwn(edit,'find'))return{...fields,fileId:file.id};
    const source=doc.getText(`text:${file.id}`).toString(),start=source.indexOf(edit.find);
    if(start<0||source.indexOf(edit.find,start+1)>=0)throw failure('invalid_request','Find text must occur exactly once in its file.');
    return{fileId:file.id,start,end:start+edit.find.length,before:edit.find,after:edit.replace};
   });
   const sources=Object.fromEntries([...new Set(edits.map(e=>e.fileId))].filter(id=>{const file=projectNode(doc,id);return file&&!file.folder&&!file.binary;}).map(id=>[id,doc.getText(`text:${id}`).toString()]));
   try{validate_source_patch(JSON.stringify(edits),JSON.stringify(sources),projectBytes(doc));}catch(error){throw commandError(error);}
   const changeId=crypto.randomUUID(),createdAt=Date.now(),base={version:1,authorId,changeId,createdAt},records={
    authors:{[owner.id]:{...base,id:owner.id,authorId:owner.id,kind:'human',displayName:owner.displayName,ownerAuthorId:null},[authorId]:{...base,id:authorId,kind:'agent',displayName:'Agent',ownerAuthorId:owner.id}},
    changes:{[changeId]:{...base,id:changeId,actorKind:'agent',sessionId,kind:'agent.patchSource',fileIds:[...new Set(edits.map(e=>e.fileId))],suggestionId:null,proposedBy:null,undoOf:null,restoreOf:null}},
   };
   const state=Object.fromEntries(ROOTS.map(root=>[root,doc.getMap(root).toJSON()]));
   for(const [root,entries]of Object.entries(records))for(const [id,record]of Object.entries(entries))if(root!=='authors'||!doc.getMap(root).has(id))state[root][id]=record;
   validate_collaboration_state(JSON.stringify(state));
   return{edits,records,changeId};
  },commit:({edits,records,changeId})=>{
   for(const id of new Set(edits.map(edit=>edit.fileId)))ensureUndo(id);
   let count;doc.transact(()=>{
    count=applySourceEdits(doc,edits).count;
    for(const [root,entries]of Object.entries(records))for(const [id,record]of Object.entries(entries))if(root!=='authors'||!doc.getMap(root).has(id))doc.getMap(root).set(id,record);
   },new AgentOrigin({authorId,ownerAuthorId:owner.id,sessionId,changeId}));
   return value({count,changeId,authorId,activationRequired:false});
  }},
  compile:{capabilities:['read'],prepare:()=>{if(isBusy())throw failure('browser_busy','A build is already running.');return null;},commit:()=>startJob(compile)},
  poll:{capabilities:['read'],prepare:command=>jobFor(command.jobId),commit:summary},
  diagnostics:{capabilities:['read'],prepare:command=>{
   const job=jobFor(command.jobId);
   if(job.status==='running')return value({jobId:job.id,status:'running',...freshness(job),message:'Build still running; await poll({jobId,waitMs:25000}) before reading diagnostics.'});
   const issues=job.result?.report?.issues||[],offset=command.offset??0,limit=command.limit??limits.diagnosticsDefault;
   const items=[];
   for(const issue of issues.slice(offset,offset+limit)){
    const item={severity:issue.severity,code:boundedText(issue.code,128),summary:boundedText(issue.summary,limits.summaryUnits),file:boundedText(issue.file,240)||null,line:issue.line??null,...(command.detail?{detail:boundedText(issue.detail,limits.detailUnits)}:{})};
    if(jsonBytes([...items,item])>limits.treeBytes)break;items.push(item);
   }
   return value({jobId:job.id,status:job.status,...freshness(job),total:issues.length,items,nextOffset:offset+items.length<issues.length?offset+items.length:null,truncated:!!job.result?.report?.truncated||items.some((item,i)=>item.summary.length<issues[offset+i].summary?.length||(command.detail&&item.detail.length<issues[offset+i].detail?.length))});
  },commit:prepared=>prepared},
  cancel:{capabilities:['read'],prepare:command=>jobFor(command.jobId),commit:job=>{if(job.status==='running'){job.controller.abort();job.status='cancelled';wake(job);}return summary(job);}},
  exportPdf:{capabilities:['read','export'],prepare:()=>{const pdf=getPdf();if(!pdf?.bytes?.length)throw failure('not_found','Compile a PDF before exporting it.');return pdf;},commit:pdf=>{
   const filename=`${String(doc.getMap('meta').get('name')||'project').replace(/[^a-zA-Z0-9_-]/g,'_')}.pdf`;
   download(pdf.bytes,filename,'application/pdf');return value({download:true,filename,mimeType:'application/pdf',size:pdf.bytes.length,build:pdf.build,stale:pdf.stale});
  }},
 };
 for(const [name,handler]of Object.entries(handlers))unregister.push(commands.register(`agent.${name}`,{...handler,limits}));
 const mutations=new Set(['compile','cancel','exportPdf']);
 const api={describe({details=false}={}){active();return structuredClone({experimental:true,version:2,valueVersion:1,projectId,build,recipe:'agent.md',sourceScope:'Any file by path/fileId; no UI activation.',operations:details?commands.describe():commands.describe().map(operation=>operation.op),...(details?{limits}:{})});},execute(request,attachments){
  if(closed||!isActive())return{version:2,requestId:typeof request?.requestId==='string'&&request.requestId.length<=256?request.requestId:'',projectId,revision:revision(),ok:false,error:{code:'project_closed',message:'This agent session is closed.'}};
  const result=commands.execute(request,attachments,{actor,startJob});
  // Validate through the shared host before waiting, then recheck scope and any
  // explicit revision at completion. Waiting is read-only and owns no build slot.
  if(request?.command?.op!=='agent.poll'||!result.ok||!request.command.waitMs||result.value.status!=='running')return result;
  const job=jobFor(request.command.jobId);
  if(pendingWaits.size>=limits.pendingPolls||job.waiters.size>=limits.jobPendingPolls){
   const {value,...receipt}=result;return{...receipt,ok:false,error:{code:'too_many_waiters',message:'Too many pending polls; await an existing poll before retrying.'}};
  }
  const owned=structuredClone(request);
  return new Promise(resolve=>{
   const done=()=>{job.waiters.delete(done);pendingWaits.delete(done);scheduleWaits();resolve(api.execute({...owned,command:{...owned.command,waitMs:0}}));};
   done.deadline=performance.now()+owned.command.waitMs;job.waiters.add(done);pendingWaits.add(done);scheduleWaits();
  });
 }};
 for(const name of Object.keys(handlers))api[name==='tree'?'readTree':name]=(options={})=>{
  const {requestId=crypto.randomUUID(),expectedRevision,...payload}=options;
  const result=api.execute({version:2,requestId,projectId,...(expectedRevision!==undefined?{expectedRevision}:mutations.has(name)?{expectedRevision:revision()}:{}),command:{...payload,op:`agent.${name}`}});
  return result?.then?result.then(compact):compact(result);
 };
 return{api:Object.freeze(api),close(){if(closed)return;closed=true;for(const job of jobs.values()){job.controller.abort();wake(job);}jobs.clear();unregister.forEach(fn=>fn());}};
}
