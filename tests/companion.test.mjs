import './helpers/core.mjs';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,randomBytes} from 'node:crypto';
import * as Y from 'yjs';
import WS from 'ws';
import {request as httpRequest} from 'node:http';
import {Client,StreamableHTTPClientTransport} from '@modelcontextprotocol/client';
import {Client as LegacyClient} from 'mcp-client-legacy/client/index.js';
import {StreamableHTTPClientTransport as LegacyTransport} from 'mcp-client-legacy/client/streamableHttp.js';
import {startCompanion,pairRequest,pairProof} from './helpers/companion-server.mjs';
import {companionHost,sourceChunk} from '../web/companion-host.js';
import {connectCompanion,companionUrl} from '../web/companion-connection.js';
import {projectCommands} from '../web/commands.js';
import {unzipSync,strFromU8} from 'fflate';
const permissions={read:true,write:true,compile:true,export:true};
const readOnly={read:true,write:false,compile:false,export:false};
const value=result=>{assert.equal(result.isError,false,JSON.stringify(result.content));return result.structuredContent||JSON.parse(result.content[0].text);};
const error=result=>{assert.equal(result.isError,true);return JSON.parse(result.content[0].text);};
async function client(settings,modern=true){
 const ClientClass=modern?Client:LegacyClient,Transport=modern?StreamableHTTPClientTransport:LegacyTransport;
 const client=new ClientClass({name:'Scribyra acceptance client',version:'1.0.0'},modern?{versionNegotiation:{mode:{pin:'2026-07-28'}}}:{});
 const protocols=new Set(),transport=new Transport(new URL(settings.url),{requestInit:{headers:settings.headers},fetch:async(input,options)=>{const headers=new Headers(options?.headers||input?.headers);const protocol=headers.get('mcp-protocol-version');if(protocol)protocols.add(protocol);return fetch(input,options);}});await client.connect(transport);client.observedProtocols=protocols;return client;
}
async function scope(server,projectId,doc,permissions,compile=async()=>({success:true,projectId})){
 globalThis.location=new URL(server.origin);globalThis.window=new EventTarget();globalThis.WebSocket=class extends WS{constructor(url){super(url,{headers:{Origin:server.origin}});}};
 const originalFetch=globalThis.fetch;globalThis.fetch=(input,options={})=>{const url=typeof input==='string'?input:input.url||String(input),headers=new Headers(options.headers);if(url.startsWith(server.url)&&/\/(pair|revoke)$/.test(url))headers.set('Origin',server.origin);return originalFetch(input,{...options,headers});};
 const abort=new AbortController(),connection=await connectCompanion({url:server.url,code:server.code,projectId,permissions,signal:abort.signal,createHost:options=>companionHost({...options,doc,projectId,compile,getDiagnostics:()=>({log:'Synthetic log',issues:[]}),getBuildResult:()=>null,getPdf:()=>null})});
 return{connection,abort,settings:connection.settings(),async close(){await connection.close();globalThis.fetch=originalFetch;}};
}
function project(){const doc=new Y.Doc(),projectId=randomUUID(),commands=projectCommands({doc,projectId});commands.run({op:'project.configure',name:'Public MCP acceptance',engine:'lualatex'});const ids=commands.run({op:'files.add',entries:[{kind:'text',path:'main.tex',content:'Hello 😀 MCP'},{kind:'text',path:'refs.bib',content:'@book{demo,title={A public fixture}}'}]}).ids;return{doc,projectId,commands,ids};}
test('pairing proofs bind origin, scope and permissions; forged/replayed proofs cannot create a grant',async()=>{
 const server=await startCompanion();try{
  const projectId=randomUUID(),nonce=randomBytes(32).toString('hex'),proof=pairProof(server.code,server.origin,projectId,nonce,readOnly);
  assert.equal((await pairRequest(server,projectId,permissions,{nonce,proof})).status,403);
  assert.equal((await pairRequest(server,projectId,readOnly,{nonce,proof,origin:'https://untrusted.example'})).status,403);
  const paired=await pairRequest(server,projectId,readOnly,{nonce,proof});assert.equal(paired.status,200);const data=await paired.json();assert.notEqual(data.browserToken,data.clientToken);assert.equal(data.code,undefined);
  assert.equal((await pairRequest(server,projectId,readOnly,{nonce,proof})).status,400);
  assert.equal((await fetch(server.url+'/mcp',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'})).status,401);
  assert.equal((await fetch(server.url+'/mcp',{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${data.clientToken}`,Origin:'https://untrusted.example'},body:'{}'})).status,403);
  const hostStatus=await new Promise((resolve,reject)=>{const request=httpRequest(server.url+'/health',{headers:{Host:'attacker.example'}},response=>{response.resume();resolve(response.statusCode);});request.once('error',reject);request.end();});assert.equal(hostStatus,403);
 }finally{await server.close();}
});
test('official modern and legacy MCP clients operate on the same live command host; stale writes and foreign scope fail',async()=>{
 const server=await startCompanion(),p=project();let paired,modern,legacy;
 try{
  paired=await scope(server,p.projectId,p.doc,permissions);modern=await client(paired.settings);legacy=await client(paired.settings,false);
  for(const remote of [modern,legacy]){const resources=await remote.listResources();assert.equal(resources.resources.length,4);const inspected=value(await remote.callTool({name:'inspect_project',arguments:{}}));assert.equal(inspected.projectId,p.projectId);assert.equal(inspected.value.metadata.name,'Public MCP acceptance');}
  assert(modern.observedProtocols.has('2026-07-28'));assert(legacy.observedProtocols.has('2025-11-25'));
  const inspected=value(await modern.callTool({name:'inspect_project',arguments:{}}));const [file]=inspected.value.files.filter(file=>file.path==='main.tex');
  const read=value(await modern.callTool({name:'read_file',arguments:{projectId:p.projectId,id:file.id}}));assert.equal(read.value.content,'Hello 😀 MCP');
  const uri=`scribyra://${p.projectId}/bibliography`,bib=JSON.parse((await modern.readResource({uri})).contents[0].text);assert.equal(bib.value.files[0].path,'refs.bib');
  const args={projectId:p.projectId,requestId:randomUUID(),expectedRevision:inspected.revision,edits:[{fileId:file.id,start:0,end:5,before:'Hello',after:'Bonjour'}]};
  p.commands.run({op:'text.patch',edits:[{fileId:file.id,start:0,end:0,before:'',after:'External edit. '}]});
  assert.equal(error(await modern.callTool({name:'compile_project',arguments:{projectId:p.projectId,expectedRevision:inspected.revision}})).code,'revision_conflict');
  assert.equal(error(await modern.callTool({name:'patch_text',arguments:args})).code,'revision_conflict');
  const current=value(await modern.callTool({name:'inspect_project',arguments:{}}));args.expectedRevision=current.revision;args.edits[0].start=15;args.edits[0].end=20;
  const patched=value(await modern.callTool({name:'patch_text',arguments:args}));assert.equal(patched.value.transaction.ok,true);assert.equal(p.doc.getText(`text:${file.id}`).toString(),'External edit. Bonjour 😀 MCP');
  const replay=value(await modern.callTool({name:'patch_text',arguments:args}));assert.deepEqual(replay.value.transaction,patched.value.transaction);
  assert.equal(error(await modern.callTool({name:'read_file',arguments:{projectId:'foreign-project',id:file.id}})).code,'permission_denied');
  const created=value(await modern.callTool({name:'create_file',arguments:{projectId:p.projectId,requestId:randomUUID(),expectedRevision:patched.revision,path:'sections/intro.tex',content:'A real browser-model transaction.'}}));assert.equal(created.value.transaction.value.ids.length,1);
  const exported=value(await modern.callTool({name:'export_project',arguments:{projectId:p.projectId,expectedRevision:created.revision,format:'source'}}));const artifact=exported.value;
  const response=await fetch(artifact.downloadUrl,{headers:paired.settings.headers});assert.equal(response.status,200);const exportedBytes=new Uint8Array(await response.arrayBuffer()),zip=unzipSync(exportedBytes);let offset=0;const chunks=[];for(;;){const chunk=value(await modern.callTool({name:'read_artifact',arguments:{projectId:p.projectId,id:artifact.id,offset,limit:64}}));chunks.push(Buffer.from(chunk.data,'base64'));offset=chunk.nextOffset;if(chunk.eof)break;}assert.deepEqual(new Uint8Array(Buffer.concat(chunks)),exportedBytes);assert.equal(strFromU8(zip['main.tex']),'External edit. Bonjour 😀 MCP');assert.equal(strFromU8(zip['sections/intro.tex']),'A real browser-model transaction.');
  assert.equal((await fetch(artifact.downloadUrl)).status,401);
  await paired.close();assert.equal((await fetch(artifact.downloadUrl,{headers:paired.settings.headers})).status,401);
 }finally{await modern?.close().catch(()=>{});await legacy?.close().catch(()=>{});await paired?.close();p.commands.close();p.doc.destroy();await server.close();}
});
test('read-only grants reject direct mutation/compile/export calls even if tools are hidden',async()=>{
 const server=await startCompanion(),p=project();let paired,remote;try{
  paired=await scope(server,p.projectId,p.doc,readOnly);remote=await client(paired.settings);const tools=(await remote.listTools()).tools.map(tool=>tool.name);assert.deepEqual(tools,['inspect_project','read_file','search_project']);
  const inspected=value(await remote.callTool({name:'inspect_project',arguments:{}}));
  for(const[name,args]of [['create_file',{requestId:randomUUID(),expectedRevision:inspected.revision,path:'denied.tex',content:'Denied'}],['compile_project',{expectedRevision:inspected.revision}],['export_project',{expectedRevision:inspected.revision,format:'source'}]]){assert.equal(error(await remote.callTool({name,arguments:{projectId:p.projectId,...args}})).code,'permission_denied');}
  assert.equal(p.commands.run({op:'project.inspect'}).files.length,2);await paired.close();await assert.rejects(remote.listResources());
 }finally{await remote?.close().catch(()=>{});await paired?.close();p.commands.close();p.doc.destroy();await server.close();}
});
test('file chunks preserve UTF-16 boundaries and companion addresses stay on loopback',()=>{
 assert.equal(sourceChunk('A😀B',0,2).content,'A');assert.equal(sourceChunk('A😀B',1,2).content,'😀');assert.throws(()=>sourceChunk('A😀B',2,2),/surrogate/);assert.throws(()=>sourceChunk('😀',0,1),/Increase/);
 assert.equal(companionUrl('http://localhost:43821'),'http://127.0.0.1:43821');for(const url of ['https://evil.example','http://127.0.0.1:43821/path','http://user:secret@127.0.0.1:43821','http://127.0.0.1:43821/?token=secret'])assert.throws(()=>companionUrl(url));
});
test('official client cancellation aborts only its browser operation; disconnect rejects pending and future access',async()=>{
 const server=await startCompanion(),p=project();let paired,remote,started=0,cancelled=0;
 const compile=signal=>new Promise((resolve,reject)=>{started++;signal.addEventListener('abort',()=>{cancelled++;reject(new DOMException('Cancelled','AbortError'));},{once:true});});
 const until=async predicate=>{const deadline=Date.now()+5000;while(!predicate()){if(Date.now()>deadline)throw new Error('Expected companion state was not reached');await new Promise(resolve=>setTimeout(resolve,20));}};
 try{
  paired=await scope(server,p.projectId,p.doc,permissions,compile);remote=await client(paired.settings);
  const inspected=value(await remote.callTool({name:'inspect_project',arguments:{}})),abort=new AbortController();
  const active=remote.callTool({name:'compile_project',arguments:{projectId:p.projectId,expectedRevision:inspected.revision}},{signal:abort.signal,timeout:15000});active.catch(()=>{});await until(()=>started===1);abort.abort();await assert.rejects(active);await until(()=>cancelled===1);
  assert.equal(value(await remote.callTool({name:'inspect_project',arguments:{}})).projectId,p.projectId);
  const waiting=remote.callTool({name:'compile_project',arguments:{projectId:p.projectId,expectedRevision:inspected.revision}},{timeout:15000});await until(()=>started===2);await paired.close();
  const failed=await waiting;assert(['browser_disconnected','permission_denied'].includes(error(failed).code));assert.equal(cancelled,2);
  assert.equal((await fetch(server.url+'/mcp',{method:'POST',headers:{...paired.settings.headers,'Content-Type':'application/json'},body:'{}'})).status,401);
 }finally{await remote?.close().catch(()=>{});await paired?.close();p.commands.close();p.doc.destroy();await server.close();}
});
test('a forged companion proof is rejected before creating a project host',async()=>{
 const server=await startCompanion(),originalFetch=globalThis.fetch;let hosts=0;
 try{
  globalThis.location=new URL(server.origin);globalThis.window=new EventTarget();
  globalThis.fetch=async(input,options)=>{const response=await originalFetch(input,{...options,headers:{...options.headers,Origin:server.origin}});const value=await response.json();return new Response(JSON.stringify({...value,serverProof:'0'.repeat(64)}),{status:response.status,headers:{'Content-Type':'application/json'}});};
  await assert.rejects(connectCompanion({url:server.url,code:server.code,projectId:randomUUID(),permissions:readOnly,createHost:()=>{hosts++;throw new Error('Project data must not be exposed');}}),/prove knowledge/);assert.equal(hosts,0);
 }finally{globalThis.fetch=originalFetch;await server.close();}
});

// Exercise the real authenticated Rust → WebSocket → Rust/WASM host boundary.
test('opted-in native and browser MCP diagnostics correlate without source or credentials',async()=>{
 const {mkdtemp,readdir,readFile,stat,rm}=await import('node:fs/promises'),{tmpdir}=await import('node:os'),{join}=await import('node:path');
 const {TelemetryRecorder}=await import('../web/pkg/scribyra_app.js'),{telemetry}=await import('../web/telemetry.js'),{installObservability}=await import('../web/observability.js');
 const directory=await mkdtemp(join(tmpdir(),'scribyra-diagnostics-')),server=await startCompanion({diagnosticsDirectory:directory}),p=project(),recorder=new TelemetryRecorder(),api=telemetry({recorder});let paired,remote;
 api.configure({collect:true,allowExport:true});installObservability(api);
 try{
  paired=await scope(server,p.projectId,p.doc,permissions);remote=await client(paired.settings);
  api.clear();const inspected=value(await remote.callTool({name:'inspect_project',arguments:{}}));
  value(await remote.callTool({name:'read_file',arguments:{projectId:p.projectId,id:p.ids[0]}}));
  assert.equal(error(await remote.callTool({name:'compile_project',arguments:{projectId:p.projectId,expectedRevision:'stale-private-revision'}})).code,'revision_conflict');
  const browser=api.snapshot();assert(browser.events.some(event=>event.operation==='mcp'&&event.outcome==='success'));
  let native,file;const deadline=Date.now()+5000;
  while(Date.now()<deadline){
   const children=await readdir(directory);if(children.length){file=join(directory,children[0],'snapshot.json');try{native=JSON.parse(await readFile(file,'utf8'));}catch{}}
   if(native&&browser.events.filter(event=>event.operation==='mcp'&&event.outcome==='started').every(event=>native.events.some(parent=>parent.spanId===event.parentSpanId&&parent.traceId===event.traceId)))break;
   await new Promise(resolve=>setTimeout(resolve,50));
  }
  for(const event of browser.events.filter(event=>event.operation==='mcp'&&event.outcome==='started'))assert(native.events.some(parent=>parent.spanId===event.parentSpanId&&parent.traceId===event.traceId),'authenticated native request is the browser parent');
  assert(native.events.some(event=>event.runtime==='companion'&&event.operation==='mcp'&&event.error==='conflict'));
  const json=JSON.stringify({browser,native});for(const privateValue of ['Hello 😀 MCP','Public MCP acceptance','stale-private-revision',p.projectId,server.code,paired.settings.headers.Authorization,directory])assert(!json.includes(privateValue));
  assert.equal(native.version,1);assert(native.bufferedBytes<=65536);assert.equal((await readdir(directory)).length,1);
  if(process.platform!=='win32')assert.equal((await stat(file)).mode&0o777,0o600);
  assert.equal(inspected.projectId,p.projectId);
 }finally{await remote?.close().catch(()=>{});await paired?.close();installObservability(null);recorder.free();p.commands.close();p.doc.destroy();await server.close();await rm(directory,{recursive:true,force:true});}
});
