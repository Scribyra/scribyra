import { validate_project_command,blob_hash } from './pkg/scribyra_app.js';
import { SCHEMA_VERSION,projectNodes,projectNode,projectFiles,addEntries,planRelocation,applyRelocation,duplicateNode,deleteNode,restoreDeleted,replaceAsset,exportZip } from './model.js';
import { assetBytes,knownBlob,verifyBlob } from './assets.js';
import { applySourceEdits,commandError } from './source-edits.js';
import {observe,finishError} from './observability.js';
const revisions=new WeakMap();
export function projectRevision(doc){
  let current=revisions.get(doc);
  if(!current){current={epoch:crypto.randomUUID(),counter:0};revisions.set(doc,current);doc.on('update',()=>{if(current.counter===Number.MAX_SAFE_INTEGER){current.epoch=crypto.randomUUID();current.counter=0;}current.counter++;});}
  return `${current.epoch}:${current.counter}`;
}
const failure=(code,message)=>Object.assign(new Error(message),{code});
function checkProjectVersion(doc){
  const version=doc.getMap('meta').get('schemaVersion')??1;
  if(!Number.isInteger(version)||version<1||version>SCHEMA_VERSION)throw failure('unsupported_project_version','This project needs a newer version of Scribyra.');
}
const fingerprintOf=request=>blob_hash(new TextEncoder().encode(JSON.stringify(request)));
function requestReplay(){
  const replies=new Map();
  return{get:id=>replies.get(id),clear:()=>replies.clear(),
    match(cached,fingerprint){if(cached.fingerprint!==fingerprint)throw failure('request_id_reused','A request ID cannot be reused for a different command.');return structuredClone(cached.response);},
    remember(id,fingerprint,expectedRevision,response){replies.set(id,{fingerprint,expectedRevision,response:structuredClone(response)});if(replies.size>128)replies.delete(replies.keys().next().value);}};
}

// Only a trusted adapter creates hosts/grants. There is no window/message/network listener.
export function projectCommands({doc,projectId,capabilities=['read','write','export'],isActive=()=>true,origin=null,beforeMutation=()=>{}}){
  const grants=Object.freeze([...capabilities]),replies=requestReplay();let closed=false;
  projectRevision(doc);
  function blobBytes(ref,attachments){const bytes=attachments?.get(ref.hash)||knownBlob(doc,ref.hash);if(!bytes)throw failure('blob_unavailable','Attach this binary object before applying the command.');verifyBlob(ref,bytes);return new Uint8Array(bytes);}
  function dispatch(command,attachments){
    switch(command.op){
      case 'project.inspect':return{files:projectNodes(doc),metadata:{name:doc.getMap('meta').get('name'),engine:doc.getMap('meta').get('engine'),mainFile:doc.getMap('meta').get('mainFile'),texEnvironment:doc.getMap('meta').get('texEnvironment')??null}};
      case 'file.read':{const file=projectNode(doc,command.id);if(!file||file.folder)throw failure('not_found','File no longer exists.');return{id:file.id,path:file.path,...(file.binary?{blob:doc.getMap('assets').get(file.id),bytes:assetBytes(doc,file.id)}:{content:doc.getText(`text:${file.id}`).toString()})};}
      case 'project.export':return{bytes:exportZip(doc),mimeType:'application/zip'};
      case 'project.configure':{
        const {name,engine,mainFile}=command;
        if(mainFile){const file=projectNode(doc,mainFile);if(!file||file.folder||file.binary||file.conflict||!file.path.toLowerCase().endsWith('.tex'))throw failure('invalid_request','Select an existing, unconflicted .tex main document.');}
        doc.transact(()=>{for(const [key,value]of Object.entries({name,engine,mainFile}))if(value!==null&&value!==undefined&&doc.getMap('meta').get(key)!==value)doc.getMap('meta').set(key,value);},origin);return{};
      }
      case 'environment.set':if(!doc.getMap('meta').has('lineageId'))doc.getMap('meta').set('lineageId',crypto.randomUUID());doc.getMap('meta').set('texEnvironment',command.environment??null);doc.getMap('meta').set('schemaVersion',SCHEMA_VERSION);return{};
      case 'files.add':return{ids:addEntries(doc,command.entries.map(e=>({id:e.id||undefined,path:e.path,...(e.kind==='folder'?{folder:true}:{content:e.kind==='text'?e.content:blobBytes(e.blob,attachments)})})))};
      case 'node.planRelocation':return planRelocation(doc,command.id,command.path);
      case 'node.relocate':{const plan=planRelocation(doc,command.id,command.path);applyRelocation(doc,plan,command.selectedReferences);return{id:command.id};}
      case 'node.duplicate':return{id:duplicateNode(doc,command.id,command.path)};
      case 'node.delete':if(!projectNode(doc,command.id))throw failure('not_found','File or folder no longer exists.');deleteNode(doc,command.id);return{};
      case 'trash.restore':restoreDeleted(doc);return{};
      case 'asset.replace':replaceAsset(doc,command.id,blobBytes(command.blob,attachments));return{};
      case 'text.patch':return{count:applySourceEdits(doc,command.edits,{origin}).count};
      default:throw failure('unsupported_command','Unsupported project command.');
    }
  }
  function execute(request,attachments,parent){
    const span=observe('command',parent);
    let validated;
    try{
      if(closed||!isActive())throw failure('project_closed','This project command session is closed.');
      checkProjectVersion(doc);
      const cached=replies.get(request?.requestId),context={projectId,revision:cached?.expectedRevision??projectRevision(doc),capabilities:grants};
      try{validated=JSON.parse(validate_project_command(JSON.stringify(request),JSON.stringify(context)));}catch(error){throw commandError(error);}
      beforeMutation(validated.command);
      const fingerprint=fingerprintOf(validated);
      if(cached){const response=replies.match(cached,fingerprint);span.end();return response;}
      let value;doc.transact(()=>{value=dispatch(validated.command,attachments);},origin);
      const response={version:1,requestId:validated.requestId,projectId,revision:projectRevision(doc),ok:true,value:structuredClone(value)};
      if(!['project.inspect','file.read','project.export','node.planRelocation'].includes(validated.command.op)){
        replies.remember(validated.requestId,fingerprint,validated.expectedRevision,response);
      }
      span.end('success',undefined,[{name:'count',value:1}]);return response;
    }catch(error){finishError(span,error);return{version:1,requestId:typeof request?.requestId==='string'&&request.requestId.length<=256?request.requestId:'',projectId,revision:projectRevision(doc),ok:false,error:{code:error.code||'operation_failed',message:error.message||String(error)}};}
  }
  return {
    execute,revision:()=>projectRevision(doc),close(){closed=true;replies.clear();},
    run(command,expectedRevision=projectRevision(doc),attachments,parent){const reply=execute({version:1,requestId:crypto.randomUUID(),projectId,expectedRevision,command},attachments,parent);if(!reply.ok)throw failure(reply.error.code,reply.error.message);return reply.value;},
  };
}
// Binary payloads travel separately from the JSON command and are hash checked by the host.
export function entryCommand(entries){
  const attachments=new Map(),prepared=entries.map(e=>{
    const base={id:e.id||null,path:e.path};if(e.folder)return{...base,kind:'folder'};
    if(typeof e.content==='string')return{...base,kind:'text',content:e.content};
    const bytes=new Uint8Array(e.content),hash=blob_hash(bytes);attachments.set(hash,bytes);return{...base,kind:'asset',blob:{hash,size:bytes.length}};
  });return{command:{op:'files.add',entries:prepared},attachments};
}

// Durable extension work shares one queue per document, including separate trusted hosts.
const durableQueues=new WeakMap();
/** Opt-in extension hosts use the same document revision and bounded replay rules.
 * Validators and handlers come only from trusted application modules. */
export function extensionCommands({doc,projectId,capabilities,isActive=()=>true,validate,dispatch,isDurable=()=>false,isIsolated=()=>false,describe=()=>[]}){
  const grants=Object.freeze([...capabilities]),replies=requestReplay(),inFlight=new Map(),lifetime=new AbortController();let closed=false;
  let queue=durableQueues.get(doc);if(!queue){queue={tail:Promise.resolve(),pending:0};durableQueues.set(doc,queue);}
  const active=()=>{if(closed||!isActive())throw failure('project_closed','This project command session is closed.');};
  const revision=()=>projectRevision(doc);
  const failed=(request,error)=>({version:2,requestId:typeof request?.requestId==='string'&&request.requestId.length<=256?request.requestId:'',projectId,revision:revision(),ok:false,error:{code:typeof error.code==='string'?error.code:error.name==='QuotaExceededError'?'quota_exceeded':'operation_failed',message:error.message||String(error)}});
  // Invocation metadata comes from the trusted adapter, never from request JSON.
  function execute(request,attachments,invocation={}){
    try{
      active();checkProjectVersion(doc);
      const cached=replies.get(request?.requestId),pending=inFlight.get(request?.requestId);
      const validated=validate(request,{projectId,revision:cached?.expectedRevision??pending?.expectedRevision??revision(),capabilities:grants});
      const fingerprint=fingerprintOf({...validated.request,actor:invocation.actor?{authorId:invocation.actor.author.id,sessionId:invocation.actor.sessionId}:null});
      if(cached)return replies.match(cached,fingerprint);
      if(pending){if(pending.fingerprint!==fingerprint)throw failure('request_id_reused','A request ID cannot be reused for a different command.');return pending.promise.then(response=>{active();return structuredClone(response);}).catch(error=>failed(request,error));}
      const guard=()=>{active();checkProjectVersion(doc);invocation.uiGuard?.(validated.request.command,validated.policy);if(validated.request.expectedRevision!==undefined&&validated.request.expectedRevision!==null&&validated.request.expectedRevision!==revision())throw failure('revision_conflict','Project changed; prepare the command again.');};
      const complete=value=>{
        active();
        const response={version:2,requestId:validated.request.requestId,projectId,revision:revision(),ok:true,value:structuredClone(value)};
        if(validated.policy.mutation)replies.remember(validated.request.requestId,fingerprint,validated.request.expectedRevision,response);
        return response;
      };
      const isolated=isIsolated(validated);
      if(isolated&&validated.policy.mutation)throw failure('invalid_request','Only read-only snapshots may run outside the durable queue.');
      if(isDurable(validated)||isolated){
        const id=validated.request.requestId,ownedAttachments=attachments===undefined?undefined:structuredClone(attachments);
        if(!isolated)queue.pending++;
        const promise=(isolated?Promise.resolve():queue.tail).then(async()=>{
          guard();let committed,settled=false;const transactions=[];
          // A committed receipt survives later edits; reconciliation still requires a live host.
          const scopeGuard=()=>{active();if(settled)throw failure('project_closed','This command has finished.');if(!committed&&!isolated)guard();};
          let cancel;const cancelled=new Promise((_,reject)=>{cancel=()=>reject(failure('project_closed','This project command session is closed.'));lifetime.signal.addEventListener('abort',cancel,{once:true});});
          try{
            const value=await Promise.race([Promise.resolve().then(()=>dispatch(validated,ownedAttachments,{
              ...invocation,guard:scopeGuard,signal:lifetime.signal,capabilities:grants,durable:!isolated,isolated,
              ...(!isolated?{commitGuard:()=>{scopeGuard();if(committed)throw failure('invalid_request','A durable command can commit only once.');},
                transaction:done=>transactions.push(done.catch(()=>{})),committed:value=>{committed=complete(value);}}:{}),
            })),cancelled]);
            active();return committed||complete(value);
          }catch(error){active();if(committed)return committed;throw error;}
          finally{settled=true;lifetime.signal.removeEventListener('abort',cancel);await Promise.all(transactions);}
        }).catch(error=>failed(validated.request,error)).finally(()=>{if(!isolated)queue.pending--;inFlight.delete(id);});
        inFlight.set(id,{fingerprint,expectedRevision:validated.request.expectedRevision,promise});if(!isolated)queue.tail=promise.then(()=>{});
        return promise.then(response=>structuredClone(response));
      }
      if(queue.pending&&validated.policy.mutation)throw failure('browser_busy','A durable command is still running.');
      guard();const value=dispatch(validated,attachments,{...invocation,guard,signal:lifetime.signal,capabilities:grants,durable:false});
      if(value?.then)throw failure('invalid_request','Register an asynchronous handler as durable.');
      return complete(value);
    }catch(error){return failed(request,error);}
  }
  return{execute,revision,describe(){active();return structuredClone(describe());},close(){closed=true;lifetime.abort();replies.clear();}};
}
