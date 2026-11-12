export class AgentOrigin { constructor(attribution){this.attribution=Object.freeze({...attribution});} }
export class ReviewOrigin { constructor(attribution){this.attribution=Object.freeze({...attribution});} }
export class RestoreOrigin { constructor(attribution){this.attribution=Object.freeze({...attribution});} }
export class AnnotationOrigin { constructor(attribution){this.attribution=Object.freeze({...attribution});} }
const remoteOrigins=new Map();
export function registerRemoteOrigin(origin){remoteOrigins.set(origin,(remoteOrigins.get(origin)||0)+1);return()=>{const count=remoteOrigins.get(origin)-1;if(count)remoteOrigins.set(origin,count);else remoteOrigins.delete(origin);};}
export const isRemoteOrigin=origin=>remoteOrigins.has(origin);
export function sourceAffecting(doc,transaction){
  if(!transaction)return true;
  for(const [type,keys] of transaction.changed){
    let root=type;while(root.parent)root=root.parent;
    for(const [name,value]of doc.share)if(value===root){
      if(name.startsWith('text:')||['files','assets'].includes(name))return true;
      if(name==='meta'&&[...keys].some(key=>['mainFile','engine','texEnvironment'].includes(key)))return true;
    }
  }
  return false;
}
/** Text files whose contents a transaction changed, or null when the tree or assets changed too. */
export function changedTextFiles(doc,transaction){
  if(!transaction)return null;const files=new Set();
  for(const type of transaction.changed.keys()){
    let root=type;while(root.parent)root=root.parent;
    for(const [name,value]of doc.share)if(value===root){
      if(name.startsWith('text:'))files.add(name.slice(5));
      else if(['files','assets'].includes(name))return null;
    }
  }
  return files;
}
// Restore events survive transport, unlike transaction origins. Whole-source
// replacements and removed targets also retire stacks built for older identities.
export function watchReplacements(doc,invalidate){
  const after=transaction=>{
    const changes=doc.getMap('changes'),keys=transaction.changed.get(changes)||[];
    const restored=[...keys].some(id=>['restore','restore-copy','backup-import'].includes(changes.get(id)?.kind));
    const files=new Set();
    for(const id of transaction.changed.get(doc.getMap('files'))||[]){const file=doc.getMap('files').get(id);if(!file||file.binary||file.folder)files.add(id);}
    for(const [name,type] of doc.share)if(name.startsWith('text:')&&transaction.changed.has(type)){
      const events=transaction.changedParentTypes.get(type)||[];
      for(const event of events){
        const delta=event.delta||[],removed=delta.reduce((n,part)=>n+(part.delete||0),0),inserted=delta.reduce((n,part)=>n+(typeof part.insert==='string'?part.insert.length:0),0);
        const previous=type.length+removed-inserted;
        if(previous>0&&removed===previous)files.add(name.slice(5));
      }
    }
    if(restored||files.size)invalidate(restored?null:files,transaction);
  };
  doc.on('afterTransaction',after);return()=>doc.off('afterTransaction',after);
}
const captures=(manager,transaction)=>transaction.local&&(manager.trackedOrigins.has(transaction.origin)||manager.trackedOrigins.has(transaction.origin?.constructor));
export function retireUndoOnReplacement(doc,manager){
  const close=watchReplacements(doc,(files,transaction)=>{
    if(files===null||transaction.origin!==manager&&!captures(manager,transaction)&&manager.scope.some(type=>[...files].some(id=>doc.share.get('text:'+id)===type)))manager.clear();
  });
  const destroy=manager.destroy;doc.off('destroy',destroy);
  manager.destroy=()=>{close();destroy();};doc.on('destroy',manager.destroy);
  return close;
}
/** Hooks run synchronously inside the source transaction, including undo/redo. */
export function changeOrigins({doc,managers,remote=[]}){
  const undoHooks=new Set(),attributionHooks=new Set(),unregister=remote.map(registerRemoteOrigin);
  const batchManagers=new Set();
  const isUndo=origin=>batchManagers.has(origin)||[...managers.values()].includes(origin);
  const stopReplacements=watchReplacements(doc,(files,transaction)=>{
    for(const [id,manager] of managers)if(files===null||files.has(id)&&transaction.origin!==manager&&!captures(manager,transaction))manager.clear();
    for(const manager of batchManagers)if(files===null||transaction.origin!==manager&&!captures(manager,transaction)&&manager.scope.some(type=>[...files].some(id=>doc.share.get('text:'+id)===type)))manager.clear();
  });
  let isolate=false;
  const before=transaction=>{
    if(transaction.origin instanceof AgentOrigin){isolate=true;for(const manager of managers.values())manager.stopCapturing();}
    if(isUndo(transaction.origin))for(const hook of undoHooks)hook('before',transaction);
  };
  const after=transaction=>{
    if(!transaction.local||isRemoteOrigin(transaction.origin)||!sourceAffecting(doc,transaction))return;
    if(isUndo(transaction.origin))for(const hook of undoHooks)hook('after',transaction);
    for(const hook of attributionHooks)hook(transaction);
  };
  const finish=()=>{if(isolate){isolate=false;for(const manager of managers.values())manager.stopCapturing();}};
  doc.on('afterAllTransactions',finish);doc.on('beforeTransaction',before);doc.on('beforeObserverCalls',after);
  return{registerUndoManager(manager){batchManagers.add(manager);return()=>batchManagers.delete(manager);},registerUndo(hook){undoHooks.add(hook);return()=>undoHooks.delete(hook);},registerAttribution(hook){attributionHooks.add(hook);return()=>attributionHooks.delete(hook);},close(){stopReplacements();doc.off('afterAllTransactions',finish);doc.off('beforeTransaction',before);doc.off('beforeObserverCalls',after);undoHooks.clear();attributionHooks.clear();batchManagers.clear();unregister.forEach(fn=>fn());}};
}
