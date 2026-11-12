// Dedicated workers make expensive expressions cancellable and keep typing usable.
import {observe,finishError} from './observability.js';
export function workspaceTool() {
  let worker,sequence=0,pending,timer;
  function cancel(){clearTimeout(timer);worker?.terminate();worker=null;if(pending){pending.span.end('cancelled');pending.reject(new DOMException('Cancelled','AbortError'));pending=null;}}
  return {
    cancel,
    run(kind,input,parent){
      cancel();const id=++sequence,span=observe(kind==='source-map'?'source_map':kind==='search'?'workspace_search':'source_outline',parent);
      try{worker=new Worker(new URL('./workspace-worker.js',import.meta.url),{type:'module'});}catch(error){finishError(span,error);throw error;}
      return new Promise((resolve,reject)=>{
        pending={resolve,reject,span};
        const fail=error=>{if(id!==sequence)return;const current=pending;pending=null;cancel();finishError(span,error);current?.reject(error);};
        worker.onerror=event=>{span.end('failure','worker');fail(new Error(event.message||'Workspace analysis could not start.'));};
        worker.onmessage=({data})=>{if(id!==sequence||data.id!==id||!pending)return;const current=pending;if(Array.isArray(data.telemetry)&&data.telemetry.length<=4)for(const event of data.telemetry)span.accept(event);pending=null;span.end(data.error?'failure':'success',data.error?'worker':undefined);cancel();if(data.error)current.reject(new Error(data.error));else current.resolve(data.result);};
        timer=setTimeout(()=>{span.end('failure','timeout');fail(new Error(kind==='source-map'?'Source navigation took too long for this document.':'Analysis took too long. Narrow the search or use a simpler expression.'));},5000);
        try{worker.postMessage({id,kind,input,telemetry:span.context});}catch(error){fail(error);}
      });
    },
  };
}
