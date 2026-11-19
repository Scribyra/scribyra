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

// Cumulative compiler-execution budget per job. A 250-page thesis with Biber
// needs four or five full LuaLaTeX passes, measured at 4–6 minutes in
// WebKit and Firefox (docs/large-projects.md); runaway TeX still ends here and
// can be cancelled at any time.
export const COMPILE_BUDGET_MS=600_000;
// Each pass after the first installs what the previous one was missing.
export const MAX_ATTEMPTS=65;

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
  // The pinned runner assigns its worker before posting initialization. Observe
  // that assignment so the first request already carries its private context.
  get worker(){return this._worker;}
  set worker(worker){
    this._worker=worker;const span=this.initializationSpan;
    if(!worker||!span?.context)return;
    const send=worker.postMessage,sendObserved=(data,...rest)=>send.call(worker,data?.busytex_js?{...data,scribyra_telemetry:span.context}:data,...rest);
    const listener=({data})=>{if(Array.isArray(data.scribyraTelemetry)&&data.scribyraTelemetry.length<=4)for(const event of data.scribyraTelemetry)span.accept(event);};
    worker.postMessage=sendObserved;worker.addEventListener('message',listener);
    this.initializationCleanup=()=>{if(worker.postMessage===sendObserved)worker.postMessage=send;worker.removeEventListener('message',listener);};
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
    const listener = ({data}) => {if(typeof data.print==='string')this.onPrint?.(data.print);if(Array.isArray(data.scribyraTelemetry)&&data.scribyraTelemetry.length<=4)for(const event of data.scribyraTelemetry)span.accept(event); if (data.pdf !== undefined) observed({missing:data.missing||[],recorder:data.recorder||'',recorderTruncated:!!data.recorderTruncated}); };
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
export async function runPasses({files,mainFile,runner,packages,record,installed,downloaded=[],output,progress,execute,signal,current=()=>!signal.aborted,telemetryParent,prepareBiber,where='Compiling on your device'}){
  const { bibtex, biber } = bibliographyOptions(files, mainFile);
  runner.telemetryParent=telemetryParent;
  runner.telemetrySignal=signal;
  if(biber&&prepareBiber)await observed('package_prepare',parent=>{output.step('Preparing Biber');return prepareBiber(parent);},{parent:telemetryParent});
  const prefix=()=>output.attemptNumber?'Compiling with downloaded packages':where;
  const active=runner;
  const onPrint=raw=>{if(!current())return;const label=output.print(raw);if(label)progress(`${prefix()} · ${label}…`);};active.onPrint=onPrint;
  let result;
  try{
    for (let pass = 0; pass < MAX_ATTEMPTS; pass++) {
      if(pass){const retry=observe('retry',telemetryParent);retry.end('success',undefined,[{name:'count',value:1}]);}
      output.attempt(pass);progress(pass ? 'Compiling with downloaded packages…' : `${where}…`);
      result = await execute(()=>active.compile(files, mainFile, bibtex, biber, null, true, 'info', 'luahbtex_bibtex8', null, 'scribyra:catalog', false, []));
      signal.throwIfAborted();
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
  return { ...result, log: packageLog ? `${packageLog.trim()}\n\n${result.log}` : result.log, packages: downloaded, environment, report, diagnostic: result.success ? null : report.issues.find(issue=>issue.severity==='error')?.summary||'Compilation failed' };
}
