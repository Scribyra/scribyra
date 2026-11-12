import {observe} from './observability.js';

// Observation is a separate MessagePort. Neither registration nor its final ack
// is awaited by asset preparation; an unavailable old SW cannot stall a build.
export function watchRuntime(worker,id,parent){
 const span=observe('telemetry_delivery',parent);if(!span.context)return{finish(){}};
 let channel,timer,done=false,finishing=false;
 function close(outcome='success',error){if(done)return;done=true;clearTimeout(timer);span.end(outcome,error);try{channel?.port1.close();channel?.port2.close();}catch{}}
 try{
  channel=new MessageChannel();channel.port1.onmessage=({data})=>{
   if(done)return;if(Array.isArray(data.telemetry)&&data.telemetry.length<=4)for(const event of data.telemetry)span.accept(event);
   if(data.ready===false)close('failure','unavailable');else if(data.done)close();
  };
  timer=setTimeout(()=>{try{worker.postMessage({type:'scribyra-runtime-unobserve',id});}catch{}close('failure','timeout');},1800000);
  worker.postMessage({type:'scribyra-runtime-observe',id,context:span.context},[channel.port2]);
 }catch{close('failure','worker');}
 return{finish(){if(done||finishing)return;finishing=true;clearTimeout(timer);timer=setTimeout(()=>close('failure','unavailable'),1000);try{worker.postMessage({type:'scribyra-runtime-unobserve',id});}catch{close('failure','worker');}}};
}
