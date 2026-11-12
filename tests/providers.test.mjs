import './helpers/core.mjs';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import WS from 'ws';
import {httpProvider,providerUrl,providerFetch} from '../web/providers.js';
import {startCompanion,pairRequest} from './helpers/companion-server.mjs';
import {startHttpProvider} from './helpers/provider-fixture.mjs';
const all={tools:true,resources:true,prompts:true};
const resources={tools:false,resources:true,prompts:false};
async function fixtureConfig(){const directory=await mkdtemp(join(tmpdir(),'scribyra-provider-')),path=join(directory,'providers.json');await writeFile(path,JSON.stringify({version:1,providers:[{id:'fixture',name:'Independent stdio fixture',command:process.execPath,args:[resolve('tests/helpers/provider-fixture.mjs')],env:{SCRIBYRA_FIXTURE_CONFIG:'explicit value',SCRIBYRA_FIXTURE_PID_FILE:join(directory,'pids')}}]}));return{path,pids:async()=>(await readFile(join(directory,'pids'),'utf8')).trim().split('\n').map(Number),close:()=>rm(directory,{recursive:true,force:true})};}
async function browser(server){
 const response=await pairRequest(server,randomUUID(),{read:true,write:false,compile:false,export:false}),paired=await response.json(),socket=new WS(server.url.replace(/^http/,'ws')+'/browser',{headers:{Origin:server.origin}});
 await new Promise((resolve,reject)=>{socket.once('open',()=>socket.send(JSON.stringify({version:1,token:paired.browserToken})));socket.once('message',()=>resolve());socket.once('error',reject);});
 const headers={Origin:server.origin,Authorization:`Bearer ${paired.browserToken}`,'Content-Type':'application/json'};
 return{paired,socket,headers,async request(path,{method='GET',body,...rest}={}){const response=await fetch(server.url+path,{method,headers,body:body===undefined?undefined:JSON.stringify(body),...rest});return{status:response.status,value:await response.json()};},close(){socket.close();}};
}
const rpc=operation=>({version:1,id:randomUUID(),operation});
test('direct HTTP client negotiates with an independent legacy server, enforces grants and sends only explicit arguments',async()=>{
 const server=await startHttpProvider();let connection;try{
  connection=await httpProvider({url:server.url,token:server.token,permissions:resources});assert.equal((await connection.request({method:'resources/list'})).resources.length,1);await assert.rejects(connection.request({method:'tools/call',name:'echo',arguments:{secret:'must not send'}}),/not granted/);assert.equal(server.events.length,0);await connection.close();
  connection=await httpProvider({url:server.url,token:server.token,permissions:all});assert.equal((await connection.request({method:'tools/list'})).tools.length,4);assert.equal((await connection.request({method:'resources/templates/list'})).resourceTemplates.length,1);assert.equal((await connection.request({method:'prompts/list'})).prompts[0].name,'summarize');const called=await connection.request({method:'tools/call',name:'echo',arguments:{source:'User-reviewed public source 😀'}});assert.deepEqual(called.structuredContent,{source:'User-reviewed public source 😀'});assert.equal(server.events.length,1);assert.equal((await connection.request({method:'prompts/get',name:'summarize',arguments:{source:'public'}})).messages[0].content.text,'Summarize: public');assert(server.requests.some(r=>r.protocol==='2025-11-25'));
  await connection.close();await assert.rejects(connection.request({method:'tools/list'}),/disconnected/);
 }finally{await connection?.close();await server.close();}
});
test('provider HTTP transport bounds results and refuses credential-bearing redirects or endpoint changes',async()=>{
 for(const url of ['http://remote.example/mcp','https://user:secret@example.com/mcp','https://example.com/mcp?token=x','https://example.com/#x'])assert.throws(()=>providerUrl(url));assert.equal(providerUrl('https://example.com/mcp').pathname,'/mcp');
 let options;const fetcher=providerFetch(new URL('https://example.com/mcp'),async(input,init)=>{options=init;return new Response('public');});await fetcher('https://example.com/mcp');assert.equal(options.redirect,'error');assert.equal(options.credentials,'omit');await assert.rejects(fetcher('https://other.example/mcp'),/another endpoint/);
 const streamed=providerFetch(new URL('https://example.com/mcp'),async()=>new Response(new ReadableStream({start(controller){controller.enqueue(new Uint8Array(9*1024*1024));controller.close();}})));await assert.rejects((await streamed('https://example.com/mcp')).text(),/8 MiB/);
 const large=providerFetch(new URL('https://example.com/mcp'),async()=>new Response('x',{headers:{'Content-Length':String(9*1024*1024)}}));await assert.rejects(large('https://example.com/mcp'),/8 MiB/);
});
test('Rust stdio client scopes commands to a paired browser, enforces permissions, replay protection and disconnect',async()=>{
 const config=await fixtureConfig(),server=await startCompanion({providersPath:config.path});let a,b;const pids=[];
 try{
  a=await browser(server);b=await browser(server);assert.equal((await a.request('/providers')).value.providers[0].id,'fixture');
  assert.equal((await fetch(server.url+'/providers',{headers:{...a.headers,Authorization:`Bearer ${a.paired.clientToken}`}})).status,403);
  const connect=await a.request('/providers',{method:'POST',body:{connectionId:randomUUID(),providerId:'fixture',permissions:all}});assert.equal(connect.status,200,JSON.stringify(connect.value));const id=connect.value.id,path=`/providers/${id}/request`;
  const tools=await a.request(path,{method:'POST',body:rpc({method:'tools/list'})});assert.equal(tools.value.tools.length,4);
  assert.equal((await b.request(path,{method:'POST',body:rpc({method:'tools/list'})})).status,403);
  assert.equal((await b.request(`/providers/${id}/requests/foreign`,{method:'DELETE'})).status,403);
  const call=rpc({method:'tools/call',name:'environment',arguments:{}}),environment=await a.request(path,{method:'POST',body:call});const environmentData=environment.value.structuredContent;pids.push(environmentData.pid);assert.equal(environmentData.pairingCodeInherited,false);assert.equal(environmentData.configuredValue,'explicit value');assert.equal((await a.request(path,{method:'POST',body:call})).value.code,'replayed_request');
  assert.equal((await a.request(path,{method:'POST',body:rpc({method:'resources/read',uri:'fixture://public/reference'})})).value.contents[0].mimeType,'text/plain');
  assert.equal((await a.request(path,{method:'POST',body:rpc({method:'prompts/get',name:'summarize',arguments:{source:'explicit public text'}})})).value.messages[0].content.text,'Summarize: explicit public text');
  const readOnly=await a.request('/providers',{method:'POST',body:{connectionId:randomUUID(),providerId:'fixture',permissions:resources}});assert.equal((await a.request(`/providers/${readOnly.value.id}/request`,{method:'POST',body:rpc({method:'tools/call',name:'echo',arguments:{}})})).value.code,'permission_denied');
  const slow=rpc({method:'tools/call',name:'slow',arguments:{}}),pending=a.request(path,{method:'POST',body:slow});await new Promise(resolve=>setTimeout(resolve,150));await a.request(`/providers/${id}/requests/${slow.id}`,{method:'DELETE'});assert.equal((await pending).value.code,'cancelled');assert.equal((await a.request(path,{method:'POST',body:rpc({method:'tools/list'})})).status,200);
  const waiting=a.request(path,{method:'POST',body:rpc({method:'tools/call',name:'slow',arguments:{}})});await new Promise(resolve=>setTimeout(resolve,100));await a.request('/revoke',{method:'POST'});assert.equal((await waiting).value.code,'permission_denied');assert.equal((await a.request(path,{method:'POST',body:rpc({method:'tools/list'})})).status,403);
 }finally{a?.close();b?.close();await server.close();for(const pid of await config.pids()){assert.throws(()=>process.kill(pid,0),{code:'ESRCH'});}await config.close();}
});
test('direct HTTP client uses the current protocol with a real Rust MCP server',async()=>{
 const server=await startCompanion();let paired,connection;const originalFetch=globalThis.fetch,protocols=new Set();
 try{
  paired=await browser(server);paired.socket.on('message',bytes=>{const request=JSON.parse(bytes.toString());if(!request.operation)return;paired.socket.send(JSON.stringify({version:1,requestId:request.requestId,projectId:request.projectId,sessionId:request.sessionId,revision:'public-revision',ok:true,value:{metadata:{name:'Public modern provider'},files:[]}}));});
  globalThis.fetch=(input,options={})=>{const headers=new Headers(options.headers);if(headers.has('mcp-protocol-version'))protocols.add(headers.get('mcp-protocol-version'));return originalFetch(input,options);};
  connection=await httpProvider({url:server.mcpUrl,token:paired.paired.clientToken,permissions:all});assert.equal((await connection.request({method:'tools/list'})).tools[0].name,'inspect_project');const result=await connection.request({method:'tools/call',name:'inspect_project',arguments:{}});assert.equal(result.structuredContent.value.metadata.name,'Public modern provider');assert(protocols.has('2026-07-28'));
 }finally{globalThis.fetch=originalFetch;await connection?.close();paired?.close();await server.close();}
});
test('cancelling stdio initialization closes the pending provider and reaps its process',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'scribyra-provider-hang-')),path=join(directory,'providers.json'),pidFile=join(directory,'pids');await writeFile(path,JSON.stringify({version:1,providers:[{id:'hang',name:'Public unresponsive fixture',command:process.execPath,args:[resolve('tests/helpers/provider-fixture.mjs'),'--hang-init'],env:{SCRIBYRA_FIXTURE_PID_FILE:pidFile}}]}));const server=await startCompanion({providersPath:path});let paired,pid;
 try{
  paired=await browser(server);const connectionId=randomUUID(),pending=paired.request('/providers',{method:'POST',body:{connectionId,providerId:'hang',permissions:resources}});
  const deadline=Date.now()+5000;for(;;){try{pid=Number((await readFile(pidFile,'utf8')).trim());break;}catch{if(Date.now()>deadline)throw new Error('Configured child did not start');await new Promise(r=>setTimeout(r,20));}}
  await paired.request(`/providers/${connectionId}`,{method:'DELETE'});assert.equal((await pending).value.code,'permission_denied');
 }finally{paired?.close();await server.close();if(pid)assert.throws(()=>process.kill(pid,0),{code:'ESRCH'});await rm(directory,{recursive:true,force:true});}
});
test('Rust stdio client negotiates the current revision with a server that rejects legacy initialization',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'scribyra-provider-modern-')),path=join(directory,'providers.json');await writeFile(path,JSON.stringify({version:1,providers:[{id:'modern',name:'Current Rust fixture',command:resolve('target/debug/examples/mcp-provider-fixture')}]}));const server=await startCompanion({providersPath:path});let paired;
 try{paired=await browser(server);const connected=await paired.request('/providers',{method:'POST',body:{connectionId:randomUUID(),providerId:'modern',permissions:all}});assert.equal(connected.status,200,JSON.stringify(connected.value));const result=await paired.request(`/providers/${connected.value.id}/request`,{method:'POST',body:rpc({method:'tools/call',name:'modern_echo',arguments:{source:'Reviewed public modern source'}})});assert.equal(result.status,200,JSON.stringify(result.value));assert.equal(result.value.structuredContent.protocolVersion,'2026-07-28');assert.equal(result.value.structuredContent.arguments.source,'Reviewed public modern source');}
 finally{paired?.close();await server.close();await rm(directory,{recursive:true,force:true});}
});

test('provider observations preserve results and isolate credentials, arguments and remote protocol',async()=>{
 const {TelemetryRecorder}=await import('../web/pkg/scribyra_app.js'),{telemetry}=await import('../web/telemetry.js'),{installObservability}=await import('../web/observability.js');
 const recorder=new TelemetryRecorder(),api=telemetry({recorder}),server=await startHttpProvider({token:'PRIVATE_PROVIDER_TOKEN'});let connection;
 api.configure({collect:true,allowExport:true});installObservability(api);
 try{
  connection=await httpProvider({url:server.url,token:server.token,permissions:resources});
  await connection.request({method:'resources/list'});
  await assert.rejects(connection.request({method:'tools/call',name:'echo',arguments:{source:'PRIVATE_PROVIDER_SOURCE'}}),/not granted/);
  const events=api.snapshot().events;assert(events.some(event=>event.operation==='provider'&&event.outcome==='success'));assert(events.some(event=>event.operation==='provider'&&event.outcome==='failure'));
  assert.doesNotMatch(api.export(),/PRIVATE_PROVIDER_TOKEN|PRIVATE_PROVIDER_SOURCE|fixture:\/\/|127\.0\.0\.1/);
  assert(server.requests.every(request=>!JSON.stringify(request.body).includes('telemetry')));
 }finally{await connection?.close();await server.close();installObservability(null);recorder.free();}
});
test('local provider context is negotiated, strict and never sent to legacy companions',async()=>{
 const {TelemetryRecorder}=await import('../web/pkg/scribyra_app.js'),{telemetry}=await import('../web/telemetry.js'),{installObservability}=await import('../web/observability.js'),{localProvider}=await import('../web/providers.js');
 const recorder=new TelemetryRecorder(),api=telemetry({recorder}),bodies=[];api.configure({collect:true});installObservability(api);
 try{
  for(const diagnostics of [false,true]){
   const companion={active:true,diagnostics,signal:new AbortController().signal,async providerRequest(path,{body}={}){if(path==='/providers')return{id:'fixture'};if(path.endsWith('/request')){bodies.push(body);return{tools:[]};}return{};}};
   const connection=await localProvider({companion,providerId:'fixture',permissions:all});assert.deepEqual(await connection.request({method:'tools/list'}),{tools:[]});await connection.close();
  }
  assert.equal(bodies[0].telemetry,undefined);assert.deepEqual(Object.keys(bodies[1].telemetry).sort(),['spanId','traceId']);
  assert(api.snapshot().events.some(event=>event.operation==='provider'&&event.spanId===bodies[1].telemetry.spanId&&event.traceId===bodies[1].telemetry.traceId));
 }finally{installObservability(null);recorder.free();}
});

test('actual stdio provider diagnostics link native child to browser parent without exporting arguments',async()=>{
 const {TelemetryRecorder}=await import('../web/pkg/scribyra_app.js'),{telemetry}=await import('../web/telemetry.js'),{installObservability}=await import('../web/observability.js'),{localProvider}=await import('../web/providers.js'),{readdir}=await import('node:fs/promises');
 const config=await fixtureConfig(),directory=await mkdtemp(join(tmpdir(),'scribyra-provider-diagnostics-')),server=await startCompanion({providersPath:config.path,diagnosticsDirectory:directory}),recorder=new TelemetryRecorder(),api=telemetry({recorder});let paired,connection;
 api.configure({collect:true,allowExport:true});installObservability(api);
 try{
  paired=await browser(server);const companion={active:true,diagnostics:paired.paired.diagnosticsProtocol===1,signal:new AbortController().signal,async providerRequest(path,options){const result=await paired.request(path,options);if(result.status>=400)throw Object.assign(Error(result.value.message),{code:result.value.code});return result.value;}};
  connection=await localProvider({companion,providerId:'fixture',permissions:all});api.clear();
  const result=await connection.request({method:'tools/call',name:'echo',arguments:{source:'PRIVATE_STDIO_SOURCE'}});assert.deepEqual(result.structuredContent,{source:'PRIVATE_STDIO_SOURCE'});
  const parent=api.snapshot().events.find(event=>event.operation==='provider'&&event.outcome==='started');assert(parent);
  let native;for(let i=0;i<100;i++){try{const [child]=await readdir(directory);native=JSON.parse(await readFile(join(directory,child,'snapshot.json'),'utf8'));}catch{}if(native?.events.some(event=>event.parentSpanId===parent.spanId&&event.traceId===parent.traceId&&event.outcome==='success'))break;await new Promise(resolve=>setTimeout(resolve,25));}
  assert(native.events.some(event=>event.operation==='provider'&&event.parentSpanId===parent.spanId&&event.traceId===parent.traceId&&event.outcome==='success'));
  assert.doesNotMatch(JSON.stringify({native,browser:api.snapshot()}),/PRIVATE_STDIO_SOURCE|explicit value|providers\.json/);
 }finally{await connection?.close();paired?.close();installObservability(null);recorder.free();await server.close();await config.close();await rm(directory,{recursive:true,force:true});}
});
