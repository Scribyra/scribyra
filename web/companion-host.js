// DISCONTINUED (November 8, 2026, the owner's decision): the Rust companion is no
// longer part of Scribyra. This module stays for its tests only and is reachable
// solely behind the test-only localStorage switch `scribyra-companion-dev`.
import {receive_companion_request,blob_hash} from './pkg/scribyra_app.js';
import {projectCommands} from './commands.js';
import {projectFiles} from './model.js';
import {sourceFiles} from './editor-model.js';
import {workspaceTool} from './workspace-tools.js';
import {boundedText} from './build-errors.js';
import {observe,observeRemote,finishError} from './observability.js';
import {sourceChunk} from './project-operations.js';
export {sourceChunk} from './project-operations.js';
export class CompanionOrigin {constructor(sessionId){this.sessionId=sessionId;}}
const failure=(code,message)=>Object.assign(new Error(message),{code});
const parseError=error=>{try{const value=JSON.parse(String(error));return failure(value.code,value.message);}catch{return error;}};
function base64(bytes){const parts=[];for(let offset=0;offset<bytes.length;offset+=24576)parts.push(btoa(String.fromCharCode(...bytes.subarray(offset,offset+24576))));return parts.join('');}
// Constructed only after the user authorizes this exact live project. Requests
// cannot supply or expand the grant; this host closes with the workspace.
export function companionHost({doc,projectId,sessionId,permissions,nextSequence=1,isActive=()=>true,compile,getDiagnostics,getBuildResult,getPdf,beginMutation=()=>{},endMutation=()=>{}}){
 permissions=Object.freeze({...permissions});
 let closed=false,sequence=nextSequence;const pending=new Map(),commands=projectCommands({doc,projectId,capabilities:[...(permissions.read?['read']:[]),...(permissions.write?['write']:[]),...(permissions.export?['export']:[])],isActive:()=>!closed&&isActive(),origin:new CompanionOrigin(sessionId)});
 function close(){if(closed)return;closed=true;commands.close();for(const controller of pending.values())controller.abort();pending.clear();}
 async function execute(op,signal,sourceRevision,parent){
  switch(op.kind){
   case 'inspect':return{...commands.run({op:'project.inspect'},undefined,undefined,parent),projectId,permissions};
   case 'read-file':{const file=commands.run({op:'file.read',id:op.id},undefined,undefined,parent);return file.bytes?{id:file.id,path:file.path,binary:true,blob:file.blob}:{id:file.id,path:file.path,binary:false,...sourceChunk(file.content,op.offset,op.limit)};}
   case 'bibliography':return{files:projectFiles(doc).filter(file=>!file.binary&&/\.bib$/i.test(file.path)).map(file=>({id:file.id,path:file.path,uri:`scribyra://${projectId}/files/${file.id}`,utf16Length:doc.getText(`text:${file.id}`).length}))};
   case 'diagnostics':{const result=getDiagnostics();return{...result,log:boundedText(result.log,1024*1024),truncated:result.log?.length>1024*1024};}
   case 'build-result':return getBuildResult()||{available:false,message:'No build result is available for this browser project.'};
   case 'search':{const tool=workspaceTool(),cancel=()=>tool.cancel();signal.addEventListener('abort',cancel,{once:true});try{const result=await tool.run('search',{files:sourceFiles(doc),query:op.query,replacement:'',caseSensitive:op.caseSensitive,wholeWord:op.wholeWord,regexMode:op.regexMode},parent);return{...result,sourceRevision,stale:commands.revision()!==sourceRevision};}finally{signal.removeEventListener('abort',cancel);tool.cancel();}}
   case 'command':{let transaction;beginMutation();try{transaction=commands.execute(op.request,undefined,parent);}finally{endMutation();}if(!transaction.ok)throw failure(transaction.error.code,transaction.error.message);const command=op.request.command;return{transaction,changes:command.op==='text.patch'?command.edits:command.op==='files.add'?command.entries.map(entry=>({path:entry.path,before:null,after:entry.content??null})):[],currentRevision:commands.revision()};}
   case 'compile':{const result=await compile(signal,parent);signal.throwIfAborted();if(!result||result.projectId!==projectId)throw failure('browser_disconnected','The project runtime closed before the build completed.');return result;}
   case 'export':{let bytes,mimeType,build=null,stale=false;if(op.format==='source'){bytes=commands.run({op:'project.export'},op.expectedRevision).bytes;mimeType='application/zip';}else{const pdf=getPdf();if(!pdf?.bytes?.length)throw failure('not_found','Compile a PDF in this project before exporting it.');bytes=pdf.bytes;build=pdf.build;stale=pdf.stale;mimeType='application/pdf';}if(bytes.length>65*1024*1024)throw failure('too_large','Companion exports are limited to 65 MiB. Use the workspace download for this artifact.');return{format:op.format,mimeType,size:bytes.length,sha256:blob_hash(bytes),sourceRevision:op.format==='source'?sourceRevision:build?.sourceRevision||null,build,stale,base64:base64(bytes)};}
   case 'cancel':pending.get(op.requestId)?.abort();return{cancelled:pending.has(op.requestId)};
   default:throw failure('invalid_request','Unsupported companion operation.');
  }
 }
 return{close,async handle(text){
  let observation;
  try{
  if(closed||!isActive())throw failure('project_closed','The authorized browser project is closed.');
  const sourceRevision=commands.revision(),context={projectId,sessionId,nextSequence:sequence,revision:sourceRevision,permissions};let received;
  try{received=JSON.parse(receive_companion_request(text,JSON.stringify(context)));}catch(error){throw parseError(error);}
  observation=observeRemote('mcp',received.request.telemetry);
  sequence++;const request=received.request,controller=new AbortController();pending.set(request.requestId,controller);
  let value,error,replyRevision=sourceRevision;
  try{if(received.error)throw failure(received.error.code,received.error.message);value=await execute(request.operation,controller.signal,sourceRevision,observation.context);controller.signal.throwIfAborted();if(request.operation.kind==='command')replyRevision=value.transaction.revision;}
  catch(e){finishError(observation,e);error={code:e.name==='AbortError'?'cancelled':e.code||'operation_failed',message:e.message||String(e)};}
  finally{pending.delete(request.requestId);}
  if(closed||!isActive())throw failure('project_closed','The authorized browser project is closed.');
  if(!error)observation.end('success',undefined,[{name:'count',value:1}]);
  return{version:1,requestId:request.requestId,projectId,sessionId,revision:replyRevision,ok:!error,...(error?{error}:{value})};
  }catch(error){finishError(observation||observe('mcp'),error);throw error;}
 }};
}
