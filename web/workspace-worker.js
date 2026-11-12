import init,{workspace_search,source_outline,source_map_query} from './pkg/scribyra_app.js';
import {workerObservation} from './worker-observation.js';
const initialized=init();
self.onmessage=async({data})=>{
  let trace;
  try{const wasm=await initialized;trace=workerObservation(data.telemetry,data.kind==='source-map'?'source_map':data.kind==='search'?'workspace_search':'source_outline');const result=JSON.parse(data.kind==='source-map'?source_map_query(data.input.bytes,JSON.stringify(data.input.manifest),JSON.stringify(data.input.query)):(data.kind==='search'?workspace_search:source_outline)(JSON.stringify(data.input)));trace.end('success',undefined,undefined,wasm?.memory?.buffer.byteLength);self.postMessage({id:data.id,result,telemetry:trace.events});}
  catch(error){trace?.end('failure','invalid');self.postMessage({id:data.id,error:error.message||String(error),telemetry:trace?.events});}
};
