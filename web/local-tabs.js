import {concurrentBinaryVersions,binaryRecoverySources} from './binary-recovery.js';
import * as Y from 'yjs';
import {cloneProject,blobRefs,knownBlob,installBlob,copyBlobs} from './assets.js';
import {validateReplica} from './replication.js';
import {watchStorage,localBroadcastAvailable} from './storage-events.js';
import {observe,finishError} from './observability.js';
export const LOCAL_DURABLE=Symbol('committed local project update');
/** Apply committed heads to the existing authoritative document. No raw document
 * state or assets travel through BroadcastChannel; wake-up messages are hints. */
export function localTabs({doc,projectId,read,isActive=()=>true,isComposing=()=>false,onStatus=()=>{},preserve,onRecovery=()=>{},onMissing=()=>{},onError=()=>{},watch=watchStorage,broadcastAvailable=localBroadcastAvailable,host=globalThis.window,visibility=globalThis.document,pollMs=5000}){
 let closed=false,missing=false,seen=-1,queued=false,force=false,running=null,retry,errorMessage='';
 const active=()=>!closed&&isActive();
 function status(){if(active()&&!missing)onStatus(broadcastAvailable()?'Local tabs synchronized':'Local tabs · polling');}
 async function pump(){
  while(queued&&active()&&!missing){
   queued=false;
   if(isComposing()){queued=true;clearTimeout(retry);retry=setTimeout(()=>{void refresh();},50);break;}
   const after=force?-1:seen;force=false;
   let observation;
   try{
    const known=new Map(blobRefs(doc).map(ref=>[ref.hash,knownBlob(doc,ref.hash)]).filter(([,bytes])=>bytes));
    const result=await read(projectId,after,known);if(!active())break;
    if(isComposing()){queued=true;force=true;clearTimeout(retry);retry=setTimeout(()=>{void refresh();},50);break;}
    if(result.kind!=='unchanged')observation=observe('local_tabs');
    if(result.kind==='deleted'||result.kind==='missing'){missing=true;onStatus(result.kind==='deleted'?'Deleted in another tab':'Local project missing');onMissing(result.kind);observation?.end('success',undefined,[{name:'count',value:1}]);break;}
    if(result.kind==='updated'){
     const preview=cloneProject(doc),remote=new Y.Doc(),before=Y.snapshot(doc);
     try{
      for(const blob of result.blobs)installBlob(preview,blob.ref,blob.bytes);
      Y.applyUpdate(preview,result.update,LOCAL_DURABLE);
      validateReplica(preview);
      Y.applyUpdate(remote,result.update);
      if(concurrentBinaryVersions(doc,remote)){
       for(const ref of blobRefs(remote)){const bytes=known.get(ref.hash)||result.blobs.find(blob=>blob.ref.hash===ref.hash)?.bytes;if(!bytes)throw new Error('A binary recovery source is unavailable.');installBlob(remote,ref,bytes);}
       for(const source of binaryRecoverySources(doc,remote,preview)){
        if(!preserve)throw new Error('Concurrent binary versions need a recovery copy before merging.');
        const recovery=await preserve(projectId,source,observation?.context);if(!active())break;onRecovery(recovery);
       }
       if(!active())break;
       if(!Y.equalSnapshots(before,Y.snapshot(doc))){queued=true;force=true;continue;}
      }
      copyBlobs(preview,doc);Y.applyUpdate(doc,result.update,LOCAL_DURABLE);
     }finally{preview.destroy();remote.destroy();}
    }
    seen=result.head.sequence;errorMessage='';status();
    observation?.end('success',undefined,result.kind==='updated'?[{name:'bytes',value:result.update.byteLength+result.blobs.reduce((sum,blob)=>sum+blob.bytes.byteLength,0)},{name:'count',value:1}]:[]);
   }catch(error){if(active()){finishError(observation||observe('local_tabs'),error);if(/project was upgraded|different Scribyra version/i.test(error.message)){missing=true;onStatus('Reload to update Scribyra');onMissing('upgraded');}else onStatus('Local tabs need attention');if(error.message!==errorMessage){errorMessage=error.message;onError(error);}}}
   finally{observation?.end('cancelled');}
  }
 }
 function refresh({force:full=false}={}){
  if(!active()||missing)return Promise.resolve();queued=true;force||=full;
  if(!running)running=pump().finally(()=>{running=null;});return running;
 }
 const unsubscribe=watch(event=>{if(event.external&&(event.kind==='rescan'||event.projectId===projectId))void refresh();});
 const resume=()=>{if(!visibility||visibility.visibilityState!=='hidden')void refresh({force:true});};
 const timer=setInterval(()=>{if(!visibility||visibility.visibilityState!=='hidden')void refresh();},pollMs);
 host?.addEventListener('focus',resume);host?.addEventListener('pageshow',resume);visibility?.addEventListener('visibilitychange',resume);visibility?.addEventListener('compositionend',resume);
 void refresh();
 return{refresh,get sequence(){return seen;},close(){if(closed)return;closed=true;queued=false;clearInterval(timer);clearTimeout(retry);unsubscribe();host?.removeEventListener('focus',resume);host?.removeEventListener('pageshow',resume);visibility?.removeEventListener('visibilitychange',resume);visibility?.removeEventListener('compositionend',resume);}};
}
