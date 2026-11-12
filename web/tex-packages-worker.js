import {TEX_ASSETS,TEX_ASSET_BASE,TEX_RUNTIME} from './tex-environment.js';
import init, {TexCatalog,compilation_diagnostics,validate_dependency_manifest} from './pkg/scribyra_app.js';
import {openMetadata} from './tex-metadata.js';
import {workerObservation,workerObserver} from './worker-observation.js';
const initialized=init();initialized.catch(()=>{});let active;
const getAPI=observe=>active||=openMetadata({observe,Catalog:TexCatalog,root:TEX_ASSETS.metadata,base:TEX_ASSET_BASE,runtime:TEX_RUNTIME,binary:TEX_ASSETS.core.find(asset=>asset.path==='busytex.wasm')}).catch(error=>{active=null;throw error;});
self.onmessage=async({data:{id,kind,input,telemetry}})=>{
 let trace,stream;
 const reply=(result,transfer=[])=>{trace?.end('success',undefined,input.bytes?.byteLength);stream?.finish();self.postMessage({id,result,telemetry:trace?.events},transfer);};
 try{
  await initialized;trace=workerObservation(telemetry,kind==='unpack'?'verify':'package_prepare');stream=workerObserver(telemetry,events=>self.postMessage({id,telemetry:events}),trace.startedAt);const observe=stream.begin;let result;
  if(kind==='diagnostics'){result=JSON.parse(compilation_diagnostics(JSON.stringify(input)));reply(result);return;}
  if(kind==='decode-environment'){
   const[header,...buffers]=TexCatalog.decode_portable_environment(input.bytes,JSON.stringify(input.runtime));const data=JSON.parse(header);
   result={lock:data.lock,packages:data.packages,metadata:data.metadata.map((info,i)=>({...info,bytes:buffers[i]})),archives:buffers.slice(data.metadata.length)};
   reply(result,[...result.metadata.map(info=>info.bytes.buffer),...result.archives.map(bytes=>bytes.buffer)]);return;
  }
  const api=await getAPI(observe),catalog=api.catalog;
  if(kind==='dependency-graph'){const bytes=await api.dependencyGraph(observe);validate_dependency_manifest(new TextDecoder('utf-8',{fatal:true}).decode(bytes),TEX_RUNTIME.snapshot);reply(bytes,[bytes.buffer]);return;}
  if(kind==='resolve')result=await api.resolve(input.missing,input.log,observe);
  else if(kind==='environment'){await api.ensure(input.names,observe);result=JSON.parse(catalog.environment(JSON.stringify(input.runtime),JSON.stringify(input.names)));}
  else if(kind==='check-environment'){await api.lockedNames(input.lock,observe);result=JSON.parse(catalog.check_environment(JSON.stringify(input.lock),JSON.stringify(input.runtime)));}
  else if(kind==='metadata'){const names=await api.lockedNames(input.lock,observe);result=await api.metadataStatus(names,observe);}
  else if(kind==='prepare-metadata'){const names=await api.lockedNames(input.lock,observe);await api.metadataAssets(names,observe);result=await api.metadataStatus(names,observe);}
  else if(kind==='encode-environment'){const names=await api.lockedNames(input.lock,observe),metadata=await api.metadataAssets(names,observe);result=catalog.encode_portable_environment(JSON.stringify(input.lock),JSON.stringify(input.runtime),input.archives,metadata.map(info=>[info.path,info.bytes]));}
  else if(kind==='packages'){await api.ensure(input.names,observe);result=JSON.parse(catalog.package_info(JSON.stringify(input.names)));}
  else if(kind==='unpack'){await api.ensure([input.name],observe);result=catalog.unpack(input.name,input.bytes).map(([name,content])=>({name,content,format:-1}));}
  else throw new Error('Unknown package operation.');
  reply(result,kind==='unpack'?result.map(file=>file.content.buffer):kind==='encode-environment'?[result.buffer]:kind==='decode-environment'?result.archives.map(bytes=>bytes.buffer):[]);
 }catch(error){trace?.end('failure',kind==='unpack'?'integrity':'worker');stream?.finish();self.postMessage({id,error:error.message||String(error),telemetry:trace?.events});}
};
