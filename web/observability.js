import {telemetryError} from './telemetry.js';
let recorder;
const inactive=Object.freeze({context:null,end:()=>false,accept:()=>false});
export function installObservability(value){recorder=value;}
export function observeWith(observer,operation,parent){try{const span=observer?.(operation,parent);if(!span?.context)return inactive;return{context:span.context,end:(...args)=>{try{return span.end(...args);}catch{return false;}},accept:event=>{try{return span.accept(event);}catch{return false;}}};}catch{return inactive;}}
export function observe(operation,parent){return observeWith((op,context)=>recorder?.begin(op,context),operation,parent);}
// Call only after validating the transport's authorization and envelope.
export function observeRemote(operation,remote){return remote?observeWith((op,context)=>recorder?.join(op,context),operation,remote):observe(operation);}
export function finishError(span,error){let cancelled=false;try{cancelled=error?.name==='AbortError'||error?.code==='cancelled';}catch{}span.end(cancelled?'cancelled':'failure',cancelled?undefined:telemetryError(error));}
export async function observed(operation,work,{parent,metrics,outcome,failure='unavailable'}={}){
 const span=observe(operation,parent);
 try{const value=await work(span.context,span);let samples=[],result='success';try{samples=metrics?.(value)||[];result=outcome?.(value)||result;}catch{}
  span.end(result,result==='failure'?failure:undefined,samples);return value;
 }catch(error){finishError(span,error);throw error;}
}
