// The compile driver shared by the browser (web/compiler.js) and the server's WebAssembly
// compile runner (server/compile/runner.mjs): the same BusyTeX wrapper adaptation, the same
// passes, missing-package resolution, Biber/BibTeX choice, live log and diagnostics. Only the
// surroundings differ: where the worker runs, where packages come from, and how runtime assets
// are prepared, which each side passes in.
import {observe,observed,finishError} from './observability.js';
import { BusyTexRunner } from 'texlyre-busytex';
import { bibliographyOptions } from './latex.js';
import {CompileTimeoutError,boundedText} from './build-errors.js';
import {packageLabel} from './tex-environment.js';
import {projectRequests} from './tex-requirements.js';

// Cumulative compiler-execution budget per job. A 250-page thesis with Biber
// needs four or five full LuaLaTeX passes, measured at 4–6 minutes in
// WebKit and Firefox (docs/large-projects.md); runaway TeX still ends here and
// can be cancelled at any time.
export const COMPILE_BUDGET_MS=600_000;
// Each pass after the first installs what the previous one was missing.
export const MAX_ATTEMPTS=65;

// The engine's WebAssembly memory ceiling (scripts/wasm-memory.mjs). The pinned build declares
// 576 MiB; the pipeline raises the declared maximum at load time, up to 2 GiB - 64 KiB (the glue
// was linked without Emscripten's 4 GB pointer support). Memory grows from 64 MiB only as a
// document needs it, so the ceiling reserves nothing.
export const ENGINE_MEMORY_MAX=32767*65536;
export const ENGINE_MEMORY_SMALL=1024*1048576;
// The default ceiling for a browser. Phones and tablets get 1 GiB: iOS ends a web page's process
// (WebKit's WebContent) at about 1.5 GiB and caps typed arrays and WebAssembly memory together at
// 2 GiB, and a page killed for memory loses the clear message below; small Android and
// low-memory devices are in the same position. Desktops get the full 2 GiB.
export function engineMemoryLimit(nav=globalThis.navigator){
  const agent=String(nav?.userAgent||''),touchMac=/Macintosh/.test(agent)&&Number(nav?.maxTouchPoints)>1;
  const mobile=/iPhone|iPad|iPod|Android|Mobile/i.test(agent)||touchMac,device=Number(nav?.deviceMemory)||0;
  return mobile||(device>0&&device<4)?ENGINE_MEMORY_SMALL:ENGINE_MEMORY_MAX;
}
// The Emscripten runtime reports a heap it cannot grow on the engine's stderr channel
// ("<program> stderr: …"), or throws; TeX's own terminal output (\typeout) never counts.
export const ENGINE_OOM=/Cannot enlarge memory|Failed to grow the heap|Aborted\(OOM\)|Cannot allocate Wasm memory|Out of memory: Cannot allocate Wasm memory/;
export const engineOutOfMemory=raw=>/^\/bin\/\S+ stderr: /.test(String(raw))&&ENGINE_OOM.test(String(raw));
const mib=bytes=>Math.floor(bytes/1048576);
// What the person sees when a document needs more memory than the engine has. `refused`: the
// runtime could not get memory below the ceiling (the browser or the machine ran out first).
export function engineMemoryMessage(limitBytes,{refused=false,where='this browser'}={}){
  const small=limitBytes<ENGINE_MEMORY_MAX;
  return refused
    ?`The document needs more memory than ${where} could give the TeX engine (it may use up to ${mib(limitBytes)} MiB). Close other tabs or applications and compile again, or simplify or split the document.`
    :`The document needs more memory than the TeX engine can use (${mib(limitBytes)} MiB${small?` on this device; ${mib(ENGINE_MEMORY_MAX)} MiB on a desktop computer`:', the most this build of the engine can address'}). Simplify the document or split it into parts.`;
}

// The pinned runner intentionally returns a fixed result shape. Observe the
// worker's structured missing-file field without modifying the dependency.
// The pinned wrapper (texlyre-busytex 1.4.1) rejects every compile call after a
// fixed 180 s, whatever the job's own budget. Lift only that timer, which it
// sets synchronously when the call starts; COMPILE_BUDGET_MS still governs.
function liftWrapperDeadline(start,budget){
  const original=globalThis.setTimeout;let lifted=0;
  globalThis.setTimeout=(callback,delay,...rest)=>{if(delay===180000){lifted++;delay=budget+60_000;}return original(callback,delay,...rest);};
  try{return start();}
  finally{globalThis.setTimeout=original;if(lifted!==1)console.warn('Scribyra: the compiler wrapper deadline was not found; long compiles may stop at 180 seconds.');}
}
export class LuaRunner extends BusyTexRunner {
  budget=COMPILE_BUDGET_MS;
  // The engine's memory ceiling in bytes, sent with initialization (engineMemoryLimit()).
  memoryBytes=0;
  // The pinned runner assigns its worker before posting initialization. Observe
  // that assignment so the first request already carries its private context.
  get worker(){return this._worker;}
  set worker(worker){
    this._worker=worker;const span=this.initializationSpan,memory=this.memoryBytes;
    if(!worker||(!span?.context&&!memory))return;
    const send=worker.postMessage,sendObserved=(data,...rest)=>send.call(worker,data?.busytex_js?{...data,...span?.context?{scribyra_telemetry:span.context}:{},...memory?{scribyra_memory:memory}:{}}:data,...rest);
    const listener=({data})=>{if(span?.context&&Array.isArray(data.scribyraTelemetry)&&data.scribyraTelemetry.length<=4)for(const event of data.scribyraTelemetry)span.accept(event);};
    worker.postMessage=sendObserved;worker.addEventListener('message',listener);
    this.initializationCleanup=()=>{if(worker.postMessage===sendObserved)worker.postMessage=send;worker.removeEventListener('message',listener);};
  }
  // Which of these TeX file names the engine already has (bundled tree or installed packages).
  presentFiles(names){
    const worker=this.worker;if(!worker||!names.length)return Promise.resolve(names.map(()=>false));
    return new Promise((resolve,reject)=>{
      worker.onmessage=({data})=>{if(Array.isArray(data.scribyra_present))resolve(data.scribyra_present);else if(data.exception)reject(new Error(data.exception));};
      worker.postMessage({scribyra_probe:names});
    });
  }
  async initializeWorker(){
    const span=observe('worker_startup',this.telemetryParent),signal=this.telemetrySignal;
    const aborted=()=>finishError(span,signal.reason||new DOMException('Cancelled','AbortError'));
    this.initializationSpan=span;signal?.addEventListener('abort',aborted,{once:true});if(signal?.aborted)aborted();
    try{const result=await super.initializeWorker();span.end();return result;}
    catch(error){finishError(span,error);throw error;}
    finally{this.initializationCleanup?.();this.initializationCleanup=null;this.initializationSpan=null;signal?.removeEventListener('abort',aborted);}
  }
  async compileWithWorker(...args) {
    let observed;const evidence=new Promise(resolve=>{observed=resolve;});
    const span=observe('worker_pass',this.telemetryParent),worker = this.worker, send=worker.postMessage;
    const signal=this.telemetrySignal,abortTrace=()=>finishError(span,signal.reason||new DOMException('Cancelled','AbortError'));
    signal?.addEventListener('abort',abortTrace,{once:true});if(signal?.aborted)abortTrace();
    const sendObserved=(data,...rest)=>send.call(worker,data?.files&&span.context?{...data,scribyra_telemetry:span.context}:data,...rest);
    const listener = ({data}) => {if(typeof data.print==='string')this.onPrint?.(data.print);if(Array.isArray(data.scribyraTelemetry)&&data.scribyraTelemetry.length<=4)for(const event of data.scribyraTelemetry)span.accept(event); if (data.pdf !== undefined) observed({missing:data.missing||[],recorder:data.recorder||'',recorderTruncated:!!data.recorderTruncated,engineMemoryBytes:Number(data.memory)||0}); };
    worker.postMessage=sendObserved;
    worker.addEventListener('message', listener);
    try {const result=await liftWrapperDeadline(()=>super.compileWithWorker(...args),this.budget),extra=await evidence;span.end(result.success?'success':'failure',result.success?undefined:'source',result.pdf?[{name:'bytes',value:result.pdf.byteLength}]:[]);return { ...result, ...extra }; }
    catch(error){finishError(span,error);throw error;}
    finally {signal?.removeEventListener('abort',abortTrace);if(worker.postMessage===sendObserved)worker.postMessage=send;worker.removeEventListener('message', listener); }
  }
}

// A compiler-execution budget: only time spent awaiting compiler calls counts.
// `onExpired` runs when the budget ends while a call is still running.
export function executionBudget(budget,phase,onExpired){
  let remaining=budget,timeout;
  return {
    async run(operation){
      if(remaining<=0)throw new CompileTimeoutError(budget,phase());
      const began=performance.now();timeout=setTimeout(()=>onExpired(new CompileTimeoutError(budget,phase())),remaining);
      let result;
      try{result=await operation();}
      finally{clearTimeout(timeout);remaining-=Math.max(0,performance.now()-began);}
      if(remaining<=0)throw new CompileTimeoutError(budget,phase());
      return result;
    },
    clear(){clearTimeout(timeout);},
  };
}

// Runs the passes of one compile on an initialized runner and builds its result.
//  runner: a LuaRunner; packages(): the lazily created package installer (texPackages());
//  record(receipts): remembers installed packages for the runner, installed(): their names;
//  output: compileOutput();
//  execute(fn): runs one compiler call within the budget; current(): whether this compile still
//  owns the live log; where: the live-progress label.
//  known: package names to install before the first pass (the project's previous successful
//  compile); prepare: whether to install known and source-named packages up front (not for a
//  locked environment, whose packages are preloaded); memoryMessage(limitBytes,{refused}): the
//  text shown when the document needs more memory than the engine may use.
export async function runPasses({files,mainFile,runner,packages,record,installed,downloaded=[],output,progress,execute,signal,current=()=>!signal.aborted,telemetryParent,prepareBiber,where='Compiling on your device',known=[],prepare=true,memoryMessage=engineMemoryMessage}){
  const { bibtex, biber } = bibliographyOptions(files, mainFile);
  runner.telemetryParent=telemetryParent;
  runner.telemetrySignal=signal;
  if(biber&&prepareBiber)await observed('package_prepare',parent=>{output.step('Preparing Biber');return prepareBiber(parent);},{parent:telemetryParent});
  const prefix=()=>output.attemptNumber?'Compiling with downloaded packages':where;
  const active=runner;let memory=null;
  const onPrint=raw=>{if(engineOutOfMemory(raw))memory=/Failed to grow the heap|Cannot allocate Wasm memory/.test(String(raw))?'refused':memory||'limit';if(!current())return;const label=output.print(raw);if(label)progress(`${prefix()} · ${label}…`);};active.onPrint=onPrint;
  let result,engineMemoryBytes=0;
  try{
    // Before the first pass: the packages this project needed last time, then those its source
    // names that the engine lacks, with their declared dependencies, in one round.
    if(prepare)await observed('package_prepare',async()=>{
      const installer=packages();
      try{
        if(known.length){output.step(`Installing the ${known.length} TeX ${known.length===1?'package':'packages'} this project used last time`);downloaded.push(...record(await installer.preinstall(known,active)));}
        const wanted=projectRequests(files),present=wanted.length?await active.presentFiles(wanted):[],absent=wanted.filter((_,i)=>!present[i]);
        if(absent.length){output.step(`Looking up ${absent.length} TeX ${absent.length===1?'file':'files'} the project names in the TeX package catalog`);downloaded.push(...record(await installer.resolveFiles(absent,active)));}
      }catch(error){if(signal.aborted)throw error;output.note(`Packages could not be prepared before compiling (${error.message}); LuaLaTeX will find them as it runs.`);}
    },{parent:telemetryParent});
    signal.throwIfAborted();
    for (let pass = 0; pass < MAX_ATTEMPTS; pass++) {
      if(pass){const retry=observe('retry',telemetryParent);retry.end('success',undefined,[{name:'count',value:1}]);}
      output.attempt(pass);progress(pass ? 'Compiling with downloaded packages…' : `${where}…`);
      try{result = await execute(()=>active.compile(files, mainFile, bibtex, biber, null, true, 'info', 'luahbtex_bibtex8', null, 'scribyra:catalog', false, []));}
      catch(error){if(!signal.aborted&&(memory||ENGINE_OOM.test(String(error?.message).split('\nStack:')[0])))throw Object.assign(new Error(memoryMessage(active.memoryBytes||ENGINE_MEMORY_MAX,{refused:memory==='refused'}),{cause:error}),{name:'EngineMemoryError',memory:memory||'limit'});throw error;}
      signal.throwIfAborted();engineMemoryBytes=Math.max(engineMemoryBytes,result.engineMemoryBytes||0);
      // Optional \IfFileExists probes are not a reason to install anything after success.
      if (result.success) break;
      const installer=packages();if(result.missing.length)output.step(`Looking up ${result.missing.length} missing ${result.missing.length===1?'file':'files'} in the TeX package catalog`);
      let added;
      try { added = await installer.resolve(result.missing, result.log, active, plan=>{if(plan.length)output.recovering();}); }
      catch(error) { if (signal.aborted) throw error; error.texLog=result.log;throw error; }
      signal.throwIfAborted();
      if (!added.length) {output.note('No TeX package provides the missing files.');break;}
      downloaded.push(...record(added));
      if (pass === MAX_ATTEMPTS-1) throw new Error(`TeX package resolution exceeded ${MAX_ATTEMPTS} compilation attempts. See the missing-file log.`);
    }
  }finally{if(active.onPrint===onPrint)active.onPrint=null;}
  const installer=packages();
  const environment=await installer.environment(installed());
  const report=await installer.diagnose({success:result.success,mainFile,log:boundedText(result.log,2*1024*1024),projectFiles:files.map(file=>file.path),recorder:boundedText(result.recorder,256*1024),recorderTruncated:result.recorderTruncated,stalledPackages:result.success?[]:installer.stalledPackages()});
  const packageLog = downloaded.length ? `\n\nTeX packages installed for this compile:\n${downloaded.map(p => `${packageLabel(p.name,p)} · ${p.cached ? 'cache' : 'download'}${p.saved ? '' : ' · not cached'}`).join('\n')}` : '';
  const memoryNote=!result.success&&memory?memoryMessage(active.memoryBytes||ENGINE_MEMORY_MAX,{refused:memory==='refused'}):null;
  const log=[memoryNote,packageLog.trim(),result.log].filter(Boolean).join('\n\n');
  return { ...result, passes: output.passes, engineMemoryBytes, memory:!result.success&&memory?memory:null, log, packages: downloaded, environment, report, diagnostic: result.success ? null : memoryNote||report.issues.find(issue=>issue.severity==='error')?.summary||'Compilation failed' };
}
