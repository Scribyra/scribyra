import { workspaceTool } from './workspace-tools.js';
import { sourceFiles,searchPlan,applyReplacements } from './editor-model.js';
import { reviewReplacements } from './editor-dialogs.js';
export const editorState=()=>({sidePanel:'files',tabs:[],searchQuery:'',searchReplacement:'',searchCase:false,searchWhole:false,searchRegex:false,searchScope:'project',searchBusy:false,searchStale:false,searchResults:[],searchStatus:'Search across your project’s text files.',searchTruncated:false,undoReplaceLabel:'',outlineItems:[],outlineScope:'file',outlineBusy:false,outlineStatus:''});
export function editorWorkspace({state,getDoc,getRevision,emit,activate,notify,wireTree,mutate=run=>run()}) {
  const searchTool=workspaceTool(),outlineTool=workspaceTool();let plan,searchEpoch=0,outlineEpoch=0,outlineTimer,undo,lastActive;
  const emitPanel=()=>{emit();requestAnimationFrame(wireTree);};
  const stale=()=>{searchEpoch++;searchTool.cancel();plan=null;state.searchBusy=false;state.searchStale=true;state.searchStatus='Source changed. Search again for current results.';};
  const otherFiles=()=>{state.searchStatus=`${plan.matches.length} matches · Other files changed since. Search again to include them.`;};
  // `files` names the text files a change touched, or is null for a tree or asset change.
  // Results stay usable while someone types in a file without matches.
  function changed(files=null){
    if(files===null){if(plan||state.searchBusy||state.searchResults.length)stale();}
    else if(plan){if(plan.matches.some(match=>files.has(match.fileId)))stale();else if(files.size)otherFiles();}
    else if(state.searchResults.length&&!state.searchStale)stale();
    // A search still running finishes; its plan reports files that changed meanwhile.
    if(state.sidePanel==='outline')scheduleOutline();
  }
  function invalidate(){searchEpoch++;searchTool.cancel();plan=null;state.searchBusy=false;state.searchStale=true;state.searchStatus='Run search to update results.';}
  function scheduleOutline(){outlineEpoch++;outlineTool.cancel();clearTimeout(outlineTimer);state.outlineBusy=true;outlineTimer=setTimeout(runOutline,150);}
  async function runOutline(){
    const doc=getDoc();if(!doc)return;const epoch=++outlineEpoch,revision=getRevision();state.outlineBusy=true;state.outlineStatus='Reading headings…';emit();
    try{const files=state.outlineScope==='file'&&!state.active?[]:sourceFiles(doc,state.outlineScope==='file'?state.active:'');const result=await outlineTool.run('outline',files);
      if(epoch!==outlineEpoch||doc!==getDoc()||revision!==getRevision())return;
      state.outlineItems=result.items.map((item,index)=>({...item,index}));state.outlineStatus=result.truncated?'Showing the first 2,000 headings.':result.items.length?`${result.items.length} headings`:'No section headings in this scope.';
    }catch(error){if(epoch===outlineEpoch&&error.name!=='AbortError'){state.outlineItems=[];state.outlineStatus=error.message;}}
    finally{if(epoch===outlineEpoch){state.outlineBusy=false;emit();}}
  }
  async function search(){
    if(state.searchBusy){invalidate();state.searchStatus='Search cancelled.';emit();return;}
    const doc=getDoc();if(!doc)return;const epoch=++searchEpoch,scope=state.searchScope==='file'?state.active:'',files=sourceFiles(doc,scope);
    if(state.searchScope==='file'&&!state.active){state.searchStatus='Open a text file first.';emit();return;}
    plan=null;state.searchResults=[];state.searchBusy=true;state.searchStale=false;state.searchStatus='Searching…';emit();
    try{const result=await searchTool.run('search',{files,query:state.searchQuery,replacement:state.searchReplacement,caseSensitive:state.searchCase,wholeWord:state.searchWhole,regexMode:state.searchRegex});
      if(epoch!==searchEpoch||doc!==getDoc())return;
      plan=searchPlan(doc,files,result,scope);state.searchResults=result.matches.map((match,index)=>({...match,index}));state.searchTruncated=result.truncated;
      state.searchStatus=result.truncated?'Preview limit reached. Narrow the search before replacing.':`${result.matches.length} matches`;
      if(plan.matches.some(match=>plan.changedFiles.has(match.fileId))){plan=null;state.searchStale=true;state.searchStatus='Source changed. Search again for current results.';return;}
      if(plan.changedFiles.size&&!result.truncated)otherFiles();
    }catch(error){if(epoch===searchEpoch&&error.name!=='AbortError')state.searchStatus=error.message;}
    finally{if(epoch===searchEpoch){state.searchBusy=false;emit();}}
  }
  const fields={'search-query':'searchQuery','search-replacement':'searchReplacement','search-scope':'searchScope'};
  const toggles={'search-case':'searchCase','search-whole':'searchWhole','search-regex':'searchRegex'};
  const names=new Set([...Object.keys(fields),...Object.keys(toggles),'workspace-panel','search-run','search-hit','search-replace','search-undo','outline-scope','outline-hit']);
  return {
    handles:name=>names.has(name),changed,
    activeChanged(){if(lastActive!==state.active){lastActive=state.active;if(state.sidePanel==='outline'&&state.outlineScope==='file')scheduleOutline();if(state.searchScope==='file')invalidate();}},
    leave(){searchEpoch++;outlineEpoch++;searchTool.cancel();outlineTool.cancel();clearTimeout(outlineTimer);undo?.destroy();undo=null;plan=null;lastActive=null;Object.assign(state,editorState());},
    async action(name,value){
      if(fields[name]){state[fields[name]]=value;invalidate();emit();return;}
      if(toggles[name]){state[toggles[name]]=!state[toggles[name]];invalidate();emit();return;}
      switch(name){
        case 'workspace-panel':state.sidePanel=value;emitPanel();if(value==='search')requestAnimationFrame(()=>document.getElementById('project-search-query')?.focus());if(value==='outline')scheduleOutline();break;
        case 'search-run':await search();break;
        case 'search-hit':{if(state.searchStale||state.searchBusy)return;const hit=plan?.matches[Number(value)];if(hit)activate(hit.fileId,hit.start,hit.end);break;}
        case 'search-replace':{
          if(!plan||state.searchStale||state.searchBusy||plan.truncated)return;const current=plan,doc=getDoc(),selected=await reviewReplacements(current);if(selected===null||!selected.length)return;
          if(doc!==getDoc())throw new Error('Project changed. Search again before replacing.');
          const result=mutate(()=>applyReplacements(doc,current,selected));undo?.destroy();undo=result.undo;state.undoReplaceLabel=result.count?'Undo replacements':'';notify(`Replaced ${result.count} matches.`);emit();break;
        }
        case 'search-undo':if(undo){mutate(()=>{if(undo.undoStack.length)undo.undo();else undo.redo();});state.undoReplaceLabel=undo.undoStack.length?'Undo replacements':undo.redoStack.length?'Redo replacements':'';emit();}break;
        case 'outline-scope':state.outlineScope=value;scheduleOutline();emit();break;
        case 'outline-hit':{if(state.outlineBusy)return;const item=state.outlineItems[Number(value)];if(item)activate(item.fileId,item.start,item.start);break;}
      }
    },
  };
}
