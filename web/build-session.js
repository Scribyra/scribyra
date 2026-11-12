// One live build per workspace. The identity belongs to this host, never to a
// caller-supplied job ID. Source revisions label results; saves are independent.
export function buildSessions(stopCompiler) {
  const epoch=crypto.randomUUID();
  let active, sequence=0;
  return {
    start(projectId, revision) {
      if(active)throw new Error('A build is already running.');
      const controller=new AbortController();
      const session={id:`${epoch}:${++sequence}`,projectId,revision,signal:controller.signal,
        current:()=>active===session,
        check(){if(active!==session||controller.signal.aborted)throw new DOMException('Build cancelled','AbortError');},
        finish(){if(active===session)active=undefined;},
        cancel(){if(active!==session||controller.signal.aborted)return;controller.abort();stopCompiler();},
      };
      active=session;return session;
    },
    cancel(){active?.cancel();},
    close(){if(!active||active.signal.aborted)stopCompiler();else active.cancel();active=undefined;},
  };
}

// Accepted builds and isolated previews hold the same slot through result publication.
export function buildCoordinator(compile,stopCompiler,onBusy=()=>{}){
  const sessions=buildSessions(stopCompiler);
  function start(projectId,revision){
    let session;try{session=sessions.start(projectId,revision);}catch(error){throw Object.assign(error,{code:'browser_busy'});}
    const finish=session.finish;session.finish=()=>{if(session.current()){finish();onBusy(false);}};onBusy(true);return session;
  }
  async function publish(session,inputs,{destination,progress=()=>{},output=()=>{},isActive=()=>true}){
    if(typeof destination!=='function')throw new TypeError('A build result destination is required.');
    const check=()=>{session.check();if(!isActive())throw new DOMException('Project closed','AbortError');};
    // The telemetry parent is an identity-scoped capability, not project data.
    check();const {telemetryParent,...data}=inputs,owned={...structuredClone(data),telemetryParent};
    const live=()=>session.current()&&!session.signal.aborted&&isActive();
    const result=await compile({...owned,jobId:session.id},message=>{if(live())progress(message);},entry=>{if(live())output(entry);});
    check();const value=await destination(result,session);check();return value;
  }
  return{start,publish,cancel:()=>sessions.cancel(),close(){sessions.close();onBusy(false);},
    async run({projectId,revision,inputs,destination,progress,output,signal,isActive=()=>true}){
      signal?.throwIfAborted();if(!isActive())throw new DOMException('Project closed','AbortError');
      const session=start(projectId,revision),cancel=()=>session.cancel();signal?.addEventListener('abort',cancel,{once:true});
      try{return await publish(session,inputs,{destination,progress,output,isActive});}
      finally{signal?.removeEventListener('abort',cancel);session.finish();}
    },
  };
}
