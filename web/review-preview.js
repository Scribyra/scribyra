import {cloneProject} from './assets.js';
import {snapshot,projectFiles} from './model.js';

import {suggestionEdits,applyReviewEdits,result,fail} from './review-commands.js';
export function reviewPreview(context,service){
  let controller,url='',state={};
  const emit=()=>context.onPreview?.({...state,url});
  service.register('review.preview',async(c,scope)=>{
    if(controller)fail('browser_busy','A review preview is already running.');
    const previewId=crypto.randomUUID(),acceptedRevision=context.commands.revision(),copy=cloneProject(context.doc);
    let inputs;
    try{
      applyReviewEdits(copy,suggestionEdits(copy,c.suggestionIds,context.anchors));
      const meta=copy.getMap('meta'),main=projectFiles(copy).find(f=>f.id===meta.get('mainFile'));
      inputs={files:snapshot(copy),mainFile:main?.path||'main.tex',engine:meta.get('engine')||'lualatex',environment:meta.get('texEnvironment')||null};
    }finally{copy.destroy();}
    const run=async signal=>{
      controller=new AbortController();const abort=()=>controller?.abort();scope.signal?.addEventListener('abort',abort,{once:true});signal?.addEventListener('abort',abort,{once:true});
      if(url)URL.revokeObjectURL(url);url='';
      state={previewId,acceptedRevision,suggestionIds:c.suggestionIds,status:'running'};emit();
      try{
        scope.signal?.throwIfAborted();signal?.throwIfAborted();
        return await context.compile({inputs,signal:controller.signal,destination:(compiled,session)=>{
          session.check();scope.signal?.throwIfAborted();
          if(!scope.startJob)scope.guard();
          if(url)URL.revokeObjectURL(url);url='';
          if(compiled.success&&compiled.pdf)url=URL.createObjectURL(new Blob([compiled.pdf],{type:'application/pdf'}));
          state={...state,jobId:session.id,status:compiled.success?'complete':'failed',issues:compiled.report?.issues||[],warningCount:compiled.report?.warningCount||0};emit();
          return scope.startJob?{...compiled,jobId:session.id,projectId:context.projectId,sourceRevision:acceptedRevision}:result({previewId,jobId:session.id,status:state.status});
        }});
      }catch(error){state={...state,status:error.name==='AbortError'?'cancelled':'failed'};emit();throw error;}
      finally{scope.signal?.removeEventListener('abort',abort);signal?.removeEventListener('abort',abort);controller=undefined;}
    };
    return scope.startJob?scope.startJob(run,{kind:'preview',sourceRevision:acceptedRevision,previewId,acceptedRevision}):run();
  },{isolated:true,capabilities:['read','review']});
  return{cancel(){controller?.abort();},get state(){return{...state,url};},close(){controller?.abort();if(url)URL.revokeObjectURL(url);url='';}};
}
