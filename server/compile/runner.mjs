// The server's WebAssembly compile runner: one job per process, inside the compile worker's
// bubblewrap sandbox (no network, read-only runtime and package cache, the job's files in
// /work) and Node's permission model (reads of those three trees only, no writes, no child
// processes, no workers, no addons). It runs the browser's BusyTeX module and worker script
// unchanged (worker-scope.mjs) under the browser's compile driver (web/compile-driver.js), so a
// document compiles here as it does on a member's device.
//
// Descriptors (inherited from the worker): --status receives one JSON line ({"event":"result"}),
// --pdf the PDF, --log the final log (diagnostics naming files and lines, then TeX's log). Packages missing from the cache are
// asked for on --fill (one JSON line per package) and answered on --reply; --packages a,b,… names
// the packages the project's previous successful compile installed (installed before the first pass); the worker fills the
// cache outside the sandbox and checks each archive against the catalog's SHA-512, and the
// catalog checks it again here before anything is unpacked.
import {readFileSync,readdirSync,writeSync,readSync,closeSync,lstatSync} from 'node:fs';
import {join} from 'node:path';
import {ScriptWorker} from './worker-scope.mjs';

export const RUNTIME_BASE='https://runtime.invalid/core/busytex';
const TEXT=/\.(tex|ltx|sty|cls|bib|bst|bbx|cbx|lbx|def|cfg|clo|fd|dtx|ins|txt|md|csv|dat|lua|bbl|ist|idx|ind|glo|gls|tikz|pgf|asy|mp)$/i;

function args(argv){
 const out={};for(let i=0;i<argv.length;i+=2){if(!argv[i].startsWith('--'))throw new Error(`unexpected argument ${argv[i]}`);out[argv[i].slice(2)]=argv[i+1];}
 return out;
}
const fd=value=>{const n=Number(value);if(!Number.isSafeInteger(n)||n<3)throw new Error('invalid descriptor');return n;};
function writeAll(target,bytes){let offset=0;while(offset<bytes.length)offset+=writeSync(target,bytes,offset,bytes.length-offset);}

// The project as the browser hands it to the compiler: text files as strings, others as bytes.
export function readProject(work){
 const files=[],decoder=new TextDecoder('utf-8',{fatal:true});
 (function walk(dir,prefix){
  for(const entry of readdirSync(dir,{withFileTypes:true}).sort((a,b)=>a.name<b.name?-1:1)){
   if(entry.name.startsWith('.'))continue;
   const path=prefix+entry.name,full=join(dir,entry.name);
   if(entry.isDirectory())walk(full,path+'/');
   else if(entry.isFile()&&!lstatSync(full).isSymbolicLink()){
    const bytes=new Uint8Array(readFileSync(full));let content=bytes;
    if(TEXT.test(entry.name))try{content=decoder.decode(bytes);}catch{}
    files.push({path,content});
   }
  }
 })(work,'');
 return files;
}

// Asks the worker to put one package archive into the cache (blocking: nothing else runs).
function fillChannel(request,reply){
 let pending=Buffer.alloc(0);
 function line(){
  for(;;){
   const at=pending.indexOf(10);if(at>=0){const text=pending.subarray(0,at).toString('utf8');pending=pending.subarray(at+1);return text;}
   if(pending.length>65536)throw new Error('Oversized package cache reply.');
   const chunk=Buffer.alloc(4096),n=readSync(reply,chunk,0,chunk.length,null);
   if(!n)throw new Error('The package cache closed its channel.');
   pending=Buffer.concat([pending,chunk.subarray(0,n)]);
  }
 }
 return name=>{writeAll(request,Buffer.from(JSON.stringify({fill:name})+'\n'));const answer=JSON.parse(line());if(!answer.ok)throw new Error(answer.error||'The package cache could not provide this package.');};
}

export function cacheHost({cache,fill,operations}){
 const archive=hash=>{if(!/^[a-f0-9]{128}$/.test(hash))throw new Error('Invalid package checksum.');return join(cache,`${hash}.tar.xz`);};
 const read=hash=>{const path=archive(hash);try{return new Uint8Array(readFileSync(path));}catch{return undefined;}};
 return {
  // One in-process "worker" per texPackages(); replies are delivered asynchronously.
  worker(){
   const port={onmessage:null,onerror:null,closed:false,terminate(){port.closed=true;},postMessage(data){
    operations(data,message=>{if(!port.closed)setImmediate(()=>{if(!port.closed)port.onmessage?.({data:message});});});
   }};
   return port;
  },
  cachedArchive:async hash=>read(hash),
  // The cache belongs to the worker; what this job read from it stays there.
  cacheArchive:async()=>true,
  async downloadArchive(pkg){
   if(!fill)throw new Error('this compile has no package cache channel');
   if(!/^[a-zA-Z0-9._-]{1,128}$/.test(pkg.name))throw new Error('Invalid TeX package name.');
   fill(pkg.name,pkg);
   const bytes=read(pkg.sha512);if(!bytes)throw new Error('the package cache did not provide the archive');
   return bytes;
  },
 };
}

// Engine memory: the engine's WebAssembly heap stops at the ceiling the runner sets (default
// 2 GiB - 64 KiB, the most this BusyTeX build can address; scripts/wasm-memory.mjs); a
// document that needs more makes the Emscripten runtime report one of these on the engine's
// stderr channel ("<program> stderr: …"), or throw them. TeX's own terminal output, which a
// document controls (\typeout), never counts.
const OOM=/Cannot enlarge memory|Failed to grow the heap|Aborted\(OOM\)|Cannot allocate Wasm memory/;
const engineOom=raw=>/^\/bin\/\S+ stderr: /.test(raw)&&OOM.test(raw);

export const ENGINE_MEMORY_MIB=32767*65536/1048576; // 2 GiB - 64 KiB
// `packages`: names the project's previous successful compile installed (the service keeps them
// with the project), installed before the first pass. `memoryMib`: the engine's heap ceiling.
export async function compile({runtime,cache,work,main,fill,onEvent=()=>{},onOutput=()=>{},budgetMs=600_000,packages:known=[],memoryMib=ENGINE_MEMORY_MIB}){
 const info=JSON.parse(readFileSync(join(runtime,'runtime.json'),'utf8'));
 globalThis.__TEX_RUNTIME__=info.runtime;globalThis.__TEX_ASSETS__=info.assets;
 const root=join(runtime,'public/core/busytex'),quiet={log(){},info(){},debug(){},warn(){},error(){}};
 // The browser's worker script, in its own worker-shaped context; nothing else reaches it.
 globalThis.Worker=class extends ScriptWorker{constructor(url){super(url,{root,base:RUNTIME_BASE,console:quiet});}};
 const pkg=await import(join(runtime,'web/pkg/scribyra_app.js'));
 pkg.initSync({module:readFileSync(join(runtime,'web/pkg/scribyra_app_bg.wasm'))});
 const [{LuaRunner,runPasses,executionBudget},{texPackages},{compileOutput},{packageOperations}]=await Promise.all([
  import(join(runtime,'web/compile-driver.js')),import(join(runtime,'web/tex-packages.js')),import(join(runtime,'web/compile-log.js')),import(join(runtime,'web/tex-packages-ops.js'))]);
 const pinned=new Map([info.assets.metadata,...info.metadata].map(asset=>[asset.sha256,asset]));
 const storage={
  cachedMetadata:async hash=>{const asset=pinned.get(hash);if(!asset)return undefined;try{return new Uint8Array(readFileSync(join(root,asset.path)));}catch{return undefined;}},
  cacheMetadata:async()=>true,
  fetchBytes:async asset=>{throw new Error(`${asset.label||'TeX metadata'} is not in the compile runtime`);},
 };
 const operations=packageOperations({ready:Promise.resolve(),assets:info.assets,base:RUNTIME_BASE,runtime:info.runtime,storage});
 const host=cacheHost({cache,fill,operations});
 const files=readProject(work);
 if(!files.some(file=>file.path===main))throw new Error(`main file ${main} is not in the project`);
 const abort=new AbortController(),signal=abort.signal;let phase='Preparing compiler',passes=0,memory=false;
 const progress=message=>{phase=message;onEvent({event:'progress',message});};
 const output=compileOutput(entry=>{if(entry.kind==='step'&&/^LuaLaTeX pass \d+/.test(entry.text))passes++;onOutput(entry);});
 const step=(message,label=message.replace(/…$/,''))=>{progress(message);output.step(label);};
 const budget=executionBudget(budgetMs,()=>phase,error=>abort.abort(error));
 const runner=new LuaRunner({busytexBasePath:RUNTIME_BASE,engineMode:'combined',preloadDataPackages:[`${RUNTIME_BASE}/${info.assets.loader.path}`],initRetries:0});
 runner.budget=budgetMs;runner.telemetrySignal=signal;runner.memoryBytes=Math.round(memoryMib*1048576);
 const installed=new Map(),record=receipts=>{for(const receipt of receipts)installed.set(receipt.name,receipt);return receipts;};
 let packages;const getPackages=()=>packages||=texPackages(signal,step,[],undefined,note=>output.note(note),host);
 const started=performance.now();
 try{
  step('Preparing LuaLaTeX and bundled packages…');
  await runner.initialize(true);
  const original=output.print.bind(output);output.print=raw=>{if(engineOom(String(raw)))memory=true;return original(raw);};
  const result=await runPasses({files,mainFile:main,runner,packages:getPackages,record,installed:()=>[...installed.keys()],output,progress,execute:fn=>budget.run(fn),signal,telemetryParent:undefined,where:'Compiling on server',known:Array.isArray(known)?known:[],memoryMessage:bytes=>memoryMessage(Math.floor(bytes/1048576))});
  return {...result,passes,memory,durationMs:performance.now()-started};
 }catch(error){
  error.passes=passes;error.memory=memory||OOM.test(String(error?.message).split('\nStack:')[0]);throw error;
 }finally{budget.clear();packages?.close();runner.terminate();}
}

// What the worker shows members: diagnostics naming files and lines, then TeX's own log.
export function serverLog(result){
 const issues=(result.report?.issues||[]).filter(issue=>issue.severity==='error').slice(0,20);
 const head=issues.length?`Diagnostics:\n${issues.map(issue=>`${issue.file?`${issue.file}${issue.line?`:${issue.line}`:''}: `:''}${issue.summary}`).join('\n')}\n\n`:'';
 return head+(result.log||'');
}

// `limitMib`: the job's engine ceiling, the build's (ENGINE_MEMORY_MIB) or less when the server's
// compile memory limit leaves less beside Node (crates/compile/src/wasm.rs, engine_memory_mib).
export function memoryMessage(limitMib){
 return limitMib<Math.floor(ENGINE_MEMORY_MIB)
  ?`The document needs more memory than the WebAssembly TeX engine can use on this server (${limitMib} MiB per compile; this build of BusyTeX addresses at most ${Math.floor(ENGINE_MEMORY_MIB)} MiB, wasm32 itself stops at 4 GB). Simplify the document, split it, or ask the administrator to raise the compile memory limit.`
  :`The document needs more memory than the WebAssembly TeX engine can use (${limitMib} MiB; this build of BusyTeX addresses at most 2 GiB, wasm32 itself stops at 4 GB). Simplify the document, split it, or ask the administrator to compile it with the native engine.`;
}

// TeX's log, bounded to its last `bytes` (UTF-8), behind the diagnostics.
export function boundedLog(result,bytes){
 const head=serverLog({...result,log:''}),tail=Buffer.from(result.log||'');
 return head+(tail.length>bytes?`[log truncated to its last ${bytes} bytes of ${tail.length}]\n${tail.subarray(tail.length-bytes).toString('utf8')}`:tail.toString('utf8'));
}

async function main(){
 const a=args(process.argv.slice(2));
 const status=fd(a.status),pdfOut=fd(a.pdf),logOut=fd(a.log);
 const fill=a.fill?fillChannel(fd(a.fill),fd(a.reply)):null;
 const limit=Math.min(ENGINE_MEMORY_MIB,Number(a['engine-memory-mib']||ENGINE_MEMORY_MIB)),logBytes=Number(a['log-bytes']||1<<20);
 const known=String(a.packages||'').split(',').filter(name=>/^[A-Za-z0-9._-]{1,128}$/.test(name)).slice(0,64);
 let done=false;
 const finish=(outcome,log,pdf)=>{
  if(done)return;done=true;
  try{if(pdf)writeAll(pdfOut,pdf);writeAll(logOut,Buffer.from(log));writeAll(status,Buffer.from(JSON.stringify(outcome)+'\n'));}catch{}
  for(const each of [pdfOut,logOut,status])try{closeSync(each);}catch{}
  process.exit(0);
 };
 const failed=error=>{
  const timeout=error?.name==='CompileTimeoutError',message=String(error?.message||error).slice(0,2000);
  const memory=!!error?.memory||OOM.test(message.split('\nStack:')[0]);
  const texLog=error?.texLog?`\n\n${String(error.texLog).slice(-logBytes)}`:'';
  finish({event:'result',status:timeout?'timeout':memory?'memory':error?.name==='TexPackageError'||/TeX package|package cache|checksum/i.test(message)?'package_error':'failure',passes:error?.passes||0,diagnostic:message},`${memory?memoryMessage(limit):message}${texLog}`);
 };
 // The engine reports some failures (an instantiation that runs out of memory, for one) by
 // throwing from a callback; they end the job with a result rather than a crash.
 process.on('uncaughtException',failed);process.on('unhandledRejection',failed);
 try{
  const result=await compile({runtime:a.runtime,cache:a.cache,work:a.work,main:a.main,fill,budgetMs:Number(a['budget-ms']||600_000),packages:known,memoryMib:limit});
  const ok=result.success&&result.pdf?.byteLength>4&&String.fromCharCode(...result.pdf.subarray(0,5))==='%PDF-';
  let log=boundedLog(result,logBytes);
  if(!ok&&result.memory&&!log.includes(memoryMessage(limit)))log=`${memoryMessage(limit)}\n\n${log}`;
  finish({event:'result',status:ok?'success':result.memory?'memory':'tex_error',passes:result.passes,diagnostic:result.diagnostic||null,packages:[...new Set(result.packages.map(p=>p.name))],engineMemoryBytes:result.engineMemoryBytes||0,engineMemoryLimitMib:limit},log,ok?result.pdf:null);
 }catch(error){failed(error);}
}

if(process.argv[1]&&import.meta.url.endsWith(process.argv[1].split('/').pop())&&process.argv.includes('--status'))await main();
