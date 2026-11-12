import {createServer} from 'node:http';
import {telemetryServer} from './telemetry-server.mjs';

// Counting proxy around the same Rust ingress → pinned Alloy → OTLP sink used
// by T4e. Only byte/count evidence leaves this helper, never request contents.
export async function localCollector(origin=`http://127.0.0.1:${process.env.SCRIBYRA_TEST_PORT||4173}`){
 const collector=await telemetryServer(origin);
 let proxy,requests=0,bodyBytes=0,accepted=0;
 const close=async()=>{
  if(proxy){proxy.closeAllConnections();await new Promise(resolve=>proxy.close(resolve));proxy=null;}
  await collector.close();
 };
 try{
  proxy=createServer(async(request,response)=>{try{
   const chunks=[];let size=0;
   for await(const chunk of request){size+=chunk.length;if(size>65536){response.writeHead(413).end();return;}chunks.push(chunk);}
   if(request.method==='POST'){requests++;bodyBytes+=size;}
   const result=await fetch(new URL(request.url,collector.url),{method:request.method,headers:request.headers,body:request.method==='POST'?Buffer.concat(chunks):undefined,signal:AbortSignal.timeout(8000)});
   if(result.status===202)accepted++;
   response.writeHead(result.status,Object.fromEntries(result.headers));response.end(Buffer.from(await result.arrayBuffer()));
  }catch{response.writeHead(503).end();}});
  await new Promise((resolve,reject)=>{proxy.once('error',reject);proxy.listen(0,'127.0.0.1',resolve);});
  return{...collector,url:`http://127.0.0.1:${proxy.address().port}/v1/events`,stats:()=>({requests,bodyBytes,accepted}),close};
 }catch(error){await close();throw error;}
}
