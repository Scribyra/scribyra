// The Rust recorder owns validation, privacy policy, buffering and export gates.
// This adapter supplies browser clocks and random operation IDs, with no I/O.
export function telemetryError(error) {
 // Never inspect or copy a message, stack, URL, request body, or log.
 try {switch(error?.code){case 'permission_denied':return 'permission';case 'timeout':return 'timeout';case 'provider_error':case 'unsupported_input':case 'provider_busy':case 'browser_busy':case 'session_limit':return 'rejected';case 'stale_revision':case 'revision_conflict':case 'sequence_conflict':case 'request_id_reused':return 'conflict';case 'invalid_request':case 'invalid_reply':case 'unsupported_command':case 'unsupported_version':case 'revision_required':return 'invalid';case 'project_closed':case 'browser_disconnected':case 'not_found':return 'unavailable';}switch(error?.name){case 'CompileTimeoutError':case 'TimeoutError':return 'timeout';case 'QuotaExceededError':return 'quota';case 'NotAllowedError':return 'permission';case 'TexPackageError':return 'unavailable';case 'IntegrityError':return 'integrity';case 'TexEnvironmentError':return 'invalid';case 'TypeError':return 'unknown';default:return 'unknown';}} catch {return 'unknown';}
}
export function telemetry({recorder, clock=()=>performance.now(), random=bytes=>crypto.getRandomValues(bytes), storage, runtime='browser',identity,origin:requestedOrigin,onRecord,onRemoteRecord,onControls,onClear}={}) {
 const safe=work=>{try{return work();}catch{return undefined;}};
 const now=()=>{const value=safe(clock);return Number.isFinite(value)?value:0;};
 const key='scribyra:diagnostics:v1',current=now(),origin=Number.isFinite(requestedOrigin)&&requestedOrigin>=0&&requestedOrigin<=current?requestedOrigin:current;let generation=0;
 let settings={collect:false,allowExport:false},remoteCollecting=false;const contexts=new WeakMap();
 try {const saved=JSON.parse(storage?.getItem(key)||'null');settings={collect:saved?.collect===true,allowExport:saved?.allowExport===true};} catch {}
 const id=length=>Array.from(random(new Uint8Array(length)),b=>b.toString(16).padStart(2,'0')).join('');
 safe(()=>recorder.configure(settings.collect,settings.allowExport));
 safe(()=>onControls?.({...settings}));
 if(identity)safe(()=>recorder.set_identity(JSON.stringify(identity)));
 function configure(next) {
  generation++;
  settings={collect:next.collect===true,allowExport:next.allowExport===true};
  safe(()=>recorder.configure(settings.collect,settings.allowExport));
  safe(()=>storage?.setItem(key,JSON.stringify(settings)));
  safe(()=>onControls?.({...settings}));
 }
 function submit(encoded){const accepted=safe(()=>recorder.record(encoded))===true;if(accepted)safe(()=>onRecord?.(encoded));const remote=remoteCollecting&&safe(()=>onRemoteRecord?.(encoded))===true;return accepted||remote;}
 function record(operation,outcome,context,metrics=[],error,at) {
  if(!settings.collect&&!remoteCollecting)return false;
  return safe(()=>submit(JSON.stringify({version:1,runtime,operation,outcome,
   traceId:context.traceId,spanId:context.spanId,...(context.parentSpanId?{parentSpanId:context.parentSpanId}:{}),
   elapsedMs:Math.max(0,(at??now())-origin),metrics,...(error?{error}:{})})))===true;
 }
 function begin(operation,parent,startedAt) {
  const inactive={context:null,end:()=>false,accept:()=>false};
  if(!settings.collect&&!remoteCollecting)return inactive;
  if(parent){const scope=contexts.get(parent);if(!scope||scope.epoch!==generation||!scope.open)return inactive;}
  const context=safe(()=>({traceId:parent?.traceId||id(16),spanId:id(8),...(parent?{parentSpanId:parent.spanId}:{})}));
  if(!context)return inactive;
  const current=now(),started=Number.isFinite(startedAt)&&startedAt>=origin&&startedAt<=current?startedAt:current,elapsed=Math.max(0,started-origin),epoch=generation,scope={epoch,open:true};contexts.set(context,scope);let ended=false;record(operation,'started',context,[],undefined,started);
  return {context,accept(input) {
   if(ended||epoch!==generation||!settings.collect&&!remoteCollecting)return false;
   return safe(()=>{
    const encoded=JSON.stringify(input);if(encoded.length>2048)return false;
    const event=JSON.parse(encoded);
    if(event.runtime!=='worker'||event.traceId!==context.traceId||event.parentSpanId!==context.spanId||event.spanId===context.spanId
      ||!Number.isFinite(event.elapsedMs)||event.elapsedMs<0||event.elapsedMs>Math.max(0,now()-started)+1000)return false;
    // The worker measures its own duration. Align relative time to request dispatch;
    // parent spans separately include scheduling and message-transfer overhead.
    event.elapsedMs+=elapsed;return submit(JSON.stringify(event));
   })===true;
  },end(outcome='success',error,metrics=[]) {
   if(ended||epoch!==generation)return false;ended=true;scope.open=false;
   return safe(()=>record(operation,outcome,context,[{name:'duration_ms',value:Math.max(0,now()-started)},...metrics],error))===true;
  }};
 }
 function join(operation,remote){
  if(!settings.collect&&!remoteCollecting)return begin(operation);
  return safe(()=>{
   if(!/^[a-f0-9]{32}$/.test(remote?.traceId)||!/[1-9a-f]/.test(remote.traceId)||!/^[a-f0-9]{16}$/.test(remote?.spanId)||!/[1-9a-f]/.test(remote.spanId))return begin(operation);
   const parent={traceId:remote.traceId,spanId:remote.spanId};contexts.set(parent,{epoch:generation,open:true});const span=begin(operation,parent);contexts.delete(parent);return span;
  })||begin(operation);
 }
 return {configure,begin,join,remoteCollection(value){generation++;remoteCollecting=value===true;},settings:()=>({...settings}),clear:()=>{generation++;safe(()=>onClear?.());return safe(()=>recorder.clear());},
  snapshot:()=>safe(()=>JSON.parse(recorder.snapshot())),
  // Explicit user export may report a fixed failure; recording never interrupts work.
  export:()=>recorder.export()};
}
