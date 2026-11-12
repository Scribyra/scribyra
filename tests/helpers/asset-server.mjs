import {createServer} from 'node:http';
import {createServer as createHttpsServer} from 'node:https';
import {createSecureServer as createHttp2Server} from 'node:http2';
import {Transform} from 'node:stream';
import {createReadStream} from 'node:fs';
import {readdir,stat} from 'node:fs/promises';
import {resolve,join,extname} from 'node:path';
// A disposable loopback static server with a single controlled interrupted
// response. It serves an explicit build-output file map, never project/workspace paths.
export async function assetServer({keepAlive=false,extraFiles={},responses={},protocol='http',tls,rangeChunkSize=65536,rangeBytesPerSecond=0,rootDirectory='dist'}={}){
 if(!['http','https','h2'].includes(protocol)||!Number.isSafeInteger(rangeChunkSize)||rangeChunkSize<1024||rangeChunkSize>1024*1024||!Number.isSafeInteger(rangeBytesPerSecond)||rangeBytesPerSecond<0||rangeBytesPerSecond>32*1024*1024||protocol!=='http'&&(!tls?.key||!tls?.cert))throw new Error('Invalid local asset-server protocol, certificate, rate or range chunk size.');
 const files=new Map(),root=resolve(rootDirectory),records=[],sockets=new Set(),socketIds=new WeakMap(),blocked=[];let fault,nextSocket=0,offline=false;
 async function scan(path,prefix=''){for(const entry of await readdir(path,{withFileTypes:true})){if(entry.isDirectory())await scan(join(path,entry.name),prefix+'/'+entry.name);else if(entry.isFile())files.set(prefix+'/'+entry.name,{path:join(path,entry.name),size:(await stat(join(path,entry.name))).size});}}
 await scan(root);
 for(const[path,file]of Object.entries(extraFiles))files.set(path,{path:resolve(file),size:(await stat(file)).size});
 for(const[path,body]of Object.entries(responses)){const bytes=Buffer.from(body);files.set(path,{path,size:bytes.length,bytes});}
 const types={'.js':'application/javascript','.mjs':'application/javascript','.wasm':'application/wasm','.json':'application/json','.html':'text/html','.css':'text/css','.svg':'image/svg+xml','.png':'image/png'};
 const factory=protocol==='http'?createServer:protocol==='https'?createHttpsServer:createHttp2Server;
 const server=factory(protocol==='http'?{}:{...tls,allowHTTP1:true},(req,res)=>{
  if(offline){blocked.push(new URL(req.url,'http://127.0.0.1').pathname);req.socket.destroy();return;}
  const path=new URL(req.url,'http://127.0.0.1').pathname,file=files.get(path.endsWith('/')?path+'index.html':path);if(!file||req.method!=='GET'){res.writeHead(404).end();return;}
  const record={path,range:req.headers.range||null,status:200,closed:false,started:Date.now(),bodyBytes:0,socket:socketIds.get(req.socket),httpVersion:req.httpVersion};records.push(record);
  const write=res.write,endResponse=res.end;
  res.write=function(chunk,...args){record.bodyBytes+=Buffer.byteLength(chunk);return write.call(this,chunk,...args);};
  res.end=function(chunk,...args){if(chunk&&typeof chunk!=='function')record.bodyBytes+=Buffer.byteLength(chunk);return endResponse.call(this,chunk,...args);};
  res.on('finish',()=>{record.finished=Date.now();});res.on('close',()=>{record.ended=Date.now();});
  // Isolate range/checkpoint tests from WebKit's pooled-connection recovery
  // after the deliberately reset response. Production hosting may keep alive.
  res.setHeader('Content-Type',types[extname(file.path)]||'application/octet-stream');res.setHeader('Accept-Ranges','bytes');res.setHeader('Cache-Control','no-store');if(!keepAlive&&!res.stream)res.setHeader('Connection','close');
  if(fault&&!fault.used&&fault.matches(path)){
   fault.used=true;const active=fault;active.record=record;res.setHeader('Content-Length',String(file.size));res.writeHead(200);const stream=createReadStream(file.path,{start:0,end:active.after-1});stream.pipe(res,{end:false});
   res.on('close',()=>{stream.destroy();record.closed=!res.writableEnded;});stream.on('end',()=>{if(active.mode==='break'){const session=res.stream?.session,port=req.socket.remotePort;setTimeout(()=>{if(session){for(const socket of sockets)if(socket.encrypted&&socket.remotePort===port)socket.destroy();session.destroy();}else res.destroy();},300);}else active.release=()=>{if(active.released||res.destroyed)return;active.released=true;const rest=createReadStream(file.path,{start:active.after});rest.on('error',()=>res.destroy());rest.pipe(res);res.on('close',()=>rest.destroy());};});stream.on('error',()=>res.destroy());return;
  }
  let start=0,end=file.size-1;
  if(req.headers.range){const match=req.headers.range.match(/^bytes=(\d+)-(\d*)$/);if(!match||Number(match[1])>=file.size){record.status=416;res.writeHead(416,{'Content-Range':`bytes */${file.size}`}).end();return;}start=Number(match[1]);end=match[2]?Math.min(Number(match[2]),end):end;record.status=206;res.setHeader('Content-Range',`bytes ${start}-${end}/${file.size}`);}
  res.setHeader('Content-Length',String(end-start+1));res.writeHead(record.status);if(file.bytes){res.end(file.bytes.subarray(start,end+1));return;}const stream=createReadStream(file.path,{start,end,highWaterMark:req.headers.range?rangeChunkSize:65536});stream.on('error',()=>res.destroy());
  let paced;if(req.headers.range&&rangeBytesPerSecond){let timer;paced=new Transform({transform(chunk,encoding,done){timer=setTimeout(()=>{timer=null;done(null,chunk);},Math.ceil(chunk.length*1000/rangeBytesPerSecond));},destroy(error,done){clearTimeout(timer);done(error);}});paced.on('error',()=>res.destroy());stream.pipe(paced).pipe(res);}else stream.pipe(res);res.on('close',()=>{stream.destroy();paced?.destroy();});
 });
 server.on('connection',socket=>{socketIds.set(socket,++nextSocket);sockets.add(socket);socket.on('close',()=>sockets.delete(socket));});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 server.on('secureConnection',socket=>{socketIds.set(socket,++nextSocket);sockets.add(socket);socket.on('close',()=>sockets.delete(socket));});
 return{url:`${protocol==='http'?'http':'https'}://127.0.0.1:${server.address().port}`,records,blocked,setOffline(value){offline=value;if(value)for(const socket of sockets)socket.destroy();},interrupt(mode,after=2*1024*1024){fault={mode,after,matches:path=>/\/texlive-lualatex\.[a-f0-9]{64}\.data$/.test(path)};return fault;},async close(){for(const socket of sockets)socket.destroy();await new Promise(resolve=>server.close(resolve));}};
}
