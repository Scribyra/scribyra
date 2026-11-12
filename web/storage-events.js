// Broadcasts are wake-up hints. Document bytes and deletion decisions are always
// read from the committed IndexedDB transaction, never accepted from this channel.
const validId=value=>typeof value==='string'&&value.length>0&&value.length<=256&&!/[\u0000-\u001f\u007f]/.test(value);
export function validCommitHint(value){
 return value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).sort().join(',')==='kind,projectId,sequence,version'&&value.version===1&&['head','deleted'].includes(value.kind)&&validId(value.projectId)&&Number.isSafeInteger(value.sequence)&&value.sequence>=0;
}
export function createCommitBus(makeChannel){
 const listeners=new Set();let channel=null,attempted=false,closed=false;
 const deliver=event=>{for(const listener of [...listeners])try{listener(event);}catch(error){queueMicrotask(()=>console.error('Local storage observer failed:',error));}};
 function start(){if(attempted||closed)return;attempted=true;try{channel=makeChannel();channel.onmessage=event=>{if(validCommitHint(event.data))deliver({...event.data,external:true});};channel.onmessageerror=()=>deliver({kind:'rescan',external:true});}catch{channel=null;}}
 return{
  get available(){return !!channel;},
  subscribe(listener){start();listeners.add(listener);return()=>listeners.delete(listener);},
  publish(hint){if(closed||!validCommitHint(hint))return;deliver({...hint,external:false});try{channel?.postMessage(hint);}catch{channel?.close();channel=null;}},
  close(){if(closed)return;closed=true;listeners.clear();channel?.close();channel=null;},
 };
}
const bus=createCommitBus(()=>{if(typeof window==='undefined'||!window.BroadcastChannel)throw new Error('BroadcastChannel unavailable');return new window.BroadcastChannel('scribyra-commits-v1');});
export const watchStorage=listener=>bus.subscribe(listener);
export const publishStorageChange=hint=>bus.publish(hint);
export const localBroadcastAvailable=()=>bus.available;
