import { workspaceTool } from './workspace-tools.js';
export const sourceMapState=()=>({sourceMapReady:false,sourceMapBusy:false,sourceMapStatus:'Compile to enable source navigation.'});
export function sourceNavigation({state,getDoc,getRevision,emit,notify,activate,showRectangle,clearMarker}){
  const tool=workspaceTool();let context,epoch=0;
  function reset(message){epoch++;tool.cancel();context=null;clearMarker();Object.assign(state,sourceMapState());if(message)state.sourceMapStatus=message;}
  async function query(request){
    if(!context||!state.sourceMapReady){notify(state.sourceMapStatus);return;}
    const saved=context,token=++epoch;state.sourceMapBusy=true;emit();
    try{
      const hits=await tool.run('source-map',{bytes:saved.bytes,manifest:saved.manifest,query:request});
      if(epoch!==token||context!==saved||saved.doc!==getDoc()||saved.revision!==getRevision())return;
      if(!hits.length){notify('No source location is recorded here. Try another line or PDF position.');return;}
      if(request.op==='forward')await showRectangle(hits[0],()=>epoch===token&&context===saved&&saved.doc===getDoc()&&saved.revision===getRevision());else activate(hits[0].fileId,hits[0].line);
    }catch(error){if(epoch===token&&error.name!=='AbortError')notify(`Source navigation: ${error.message}`);}
    finally{if(epoch===token){state.sourceMapBusy=false;emit();}}
  }
  return {
    changed(){if(context||state.sourceMapReady||state.sourceMapBusy)reset('Source changed. Compile again before navigating between source and PDF.');},
    clear(){reset();},
    async install(bytes,manifest,revision){
      reset();const doc=getDoc(),token=++epoch;
      if(revision!==getRevision()){state.sourceMapStatus='Source changed. Compile again before navigating between source and PDF.';emit();return;}
      if(!bytes?.length){state.sourceMapStatus='This compilation did not produce SyncTeX navigation data.';emit();return;}
      const saved={bytes:new Uint8Array(bytes),manifest,revision,doc};state.sourceMapBusy=true;state.sourceMapStatus='Preparing source navigation…';emit();
      try{await tool.run('source-map',{bytes:saved.bytes,manifest,query:{op:'inspect'}});if(token!==epoch||doc!==getDoc()||revision!==getRevision())return;context=saved;state.sourceMapReady=true;state.sourceMapStatus='Alt + Enter: show source in PDF. Ctrl/⌘ + click PDF: show source.';}
      catch(error){if(token===epoch&&error.name!=='AbortError')state.sourceMapStatus=`Source navigation unavailable: ${error.message}`;}
      finally{if(token===epoch){state.sourceMapBusy=false;emit();}}
    },
    forward(id,line){return query({op:'forward',id,line,pageHint:state.pdfPage});},
    inverse(point){return query({op:'inverse',...point});},
  };
}
