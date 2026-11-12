import {warmRuntime} from './runtime-assets.js';
import {observe,observed,finishError} from './observability.js';
import { BusyTexRunner } from 'texlyre-busytex';
import { bibliographyOptions } from './latex.js';
import {CompileTimeoutError,boundedText} from './build-errors.js';
import { texPackages } from './tex-packages.js';
import {compileOutput} from './compile-log.js';
import {TexEnvironmentError,TEX_ASSETS,TEX_ASSET_BASE,packageLabel} from './tex-environment.js';
const base = TEX_ASSET_BASE;
// The pinned runner intentionally returns a fixed result shape. Observe the
// worker's structured missing-file field without modifying the dependency.
// The pinned wrapper (texlyre-busytex 1.4.1) rejects every compile call after a
// fixed 180 s, whatever the job's own budget. Lift only that timer, which it
// sets synchronously when the call starts; COMPILE_BUDGET_MS still governs.
function liftWrapperDeadline(start){
  const original=globalThis.setTimeout;let lifted=0;
  globalThis.setTimeout=(callback,delay,...rest)=>{if(delay===180000){lifted++;delay=COMPILE_BUDGET_MS+60_000;}return original(callback,delay,...rest);};
  try{return start();}
  finally{globalThis.setTimeout=original;if(lifted!==1)console.warn('Scribyra: the compiler wrapper deadline was not found; long compiles may stop at 180 seconds.');}
}
class LuaRunner extends BusyTexRunner {
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
    try {const result=await liftWrapperDeadline(()=>super.compileWithWorker(...args)),extra=await evidence;span.end(result.success?'success':'failure',result.success?undefined:'source',result.pdf?[{name:'bytes',value:result.pdf.byteLength}]:[]);return { ...result, ...extra }; }
    catch(error){finishError(span,error);throw error;}
    finally {signal?.removeEventListener('abort',abortTrace);if(worker.postMessage===sendObserved)worker.postMessage=send;worker.removeEventListener('message', listener); }
  }
}
// On a fresh install, WebKit can start the compiler before the service worker
// controls the page. Wait briefly so the first wrapper requests are cached too.
async function waitForOfflineControl(signal) {
  if (!import.meta.env.PROD || !('serviceWorker' in navigator) || navigator.serviceWorker.controller) return;
  const worker = navigator.serviceWorker;
  await new Promise(resolve => {
    const done = () => { clearTimeout(timeout); worker.removeEventListener('controllerchange', done); signal.removeEventListener('abort', done); resolve(); };
    const timeout = setTimeout(done, 10_000);
    worker.addEventListener('controllerchange', done, { once: true });
    signal.addEventListener('abort', done, { once: true });
    worker.ready.then(() => { if (worker.controller) done(); }).catch(done);
    if (signal.aborted || worker.controller) done();
  });
  signal.throwIfAborted();
}
let runner, controller,runnerLocked=false;
const runnerPackages=new Map();
let generation = 0;
let rejectActive;
export function cancelCompile(reason=new DOMException('Compilation cancelled','AbortError')) {
  const reject=rejectActive;rejectActive=null;generation++;reject?.(reason);
  controller?.abort(reason); controller = null;
  runner?.terminate(); runner = null;runnerPackages.clear();runnerLocked=false;
}
// onOutput receives the live log ({text,kind}) while the compile runs. It is
// local display data only; the returned log is the authoritative final one.
// Cumulative compiler-execution budget per job. A 250-page thesis with Biber
// needs four or five full LuaLaTeX passes, measured at 4–6 minutes in
// WebKit and Firefox (docs/large-projects.md); runaway TeX still ends here and
// can be cancelled at any time.
export const COMPILE_BUDGET_MS=600_000;
export async function compileProject({ files, mainFile, engine, jobId, environment=null,telemetryParent }, onProgress, onOutput=()=>{}) {
  if (engine !== 'lualatex') throw new Error('Scribyra currently supports LuaLaTeX only.');
  // A locked run starts from the immutable baseline, never a warm superset.
  if(environment!==null||runnerLocked)cancelCompile();
  runnerLocked=environment!==null;
  const token = ++generation, abort = new AbortController(); controller = abort;
  const started = performance.now(), cold = !runner;let phase='Preparing compiler';
  const progress=message=>{phase=message;onProgress(message);};
  const output=compileOutput(entry=>{if(token===generation)onOutput(entry);}),step=(message,label=message.replace(/…$/,''))=>{progress(message);output.step(label);};
  let timeout,remaining=COMPILE_BUDGET_MS;
  // Component preparation has its own idle/cancellation limits. Count only
  // time spent awaiting compiler calls against this job's execution budget.
  async function execute(operation){
    if(remaining<=0)throw new CompileTimeoutError(COMPILE_BUDGET_MS,phase);
    const began=performance.now();timeout=setTimeout(()=>{if(token===generation)cancelCompile(new CompileTimeoutError(COMPILE_BUDGET_MS,phase));},remaining);
    let result;
    try{result=await operation();}
    finally{clearTimeout(timeout);remaining-=Math.max(0,performance.now()-began);}
    if(remaining<=0)throw new CompileTimeoutError(COMPILE_BUDGET_MS,phase);
    return result;
  }
  let packages;
  const getPackages=()=>packages||=texPackages(abort.signal,step,[...runnerPackages.values()],telemetryParent,note=>output.note(note));
  const record=receipts=>{for(const receipt of receipts)runnerPackages.set(receipt.name,receipt);return receipts;};
  const task = (async () => {
    if(environment!==null)environment=await getPackages().check(environment);
    if (!runner) {
      await waitForOfflineControl(abort.signal);
      output.step('Preparing the compiler');await observed('package_prepare',parent=>warmRuntime(abort.signal,progress,'core',parent),{parent:telemetryParent});
      const check = await fetch(`${base}/busytex_worker.js`, { signal: abort.signal });
      if (!check.ok || check.headers.get('content-type')?.includes('text/html')) throw new Error('Compiler assets are not installed. Run npm run assets, then reload.');
      abort.signal.throwIfAborted();
      runner = new LuaRunner({ busytexBasePath: base, engineMode: 'combined', preloadDataPackages: [`${base}/${TEX_ASSETS.loader.path}`], initRetries: 0, onDownloadProgress: p => { if (token === generation) progress(p.percent?`Preparing LuaLaTeX · ${p.percent}%`:'Preparing LuaLaTeX…'); } });
      step('Preparing LuaLaTeX and bundled packages…');
      runner.telemetrySignal=abort.signal;
      await observed('startup',async parent=>{runner.telemetryParent=parent;await runner.initialize(true);},{parent:telemetryParent});
    }
    abort.signal.throwIfAborted();
    const activeRunner = runner, downloaded = environment!==null?record(await getPackages().preload(environment,runner)):[], { bibtex, biber } = bibliographyOptions(files, mainFile);
    activeRunner.telemetryParent=telemetryParent;
    activeRunner.telemetrySignal=abort.signal;
    if(biber)await observed('package_prepare',parent=>{output.step('Preparing Biber');return warmRuntime(abort.signal,progress,'biber',parent);},{parent:telemetryParent});
    const prefix=()=>output.attemptNumber?'Compiling with downloaded packages':'Compiling on your device';
    activeRunner.onPrint=raw=>{if(token!==generation)return;const label=output.print(raw);if(label)progress(`${prefix()} · ${label}…`);};
    let result;
    for (let pass = 0; pass < 65; pass++) {
      if(pass){const retry=observe('retry',telemetryParent);retry.end('success',undefined,[{name:'count',value:1}]);}
      output.attempt(pass);progress(pass ? 'Compiling with downloaded packages…' : 'Compiling on your device…');
      result = await execute(()=>activeRunner.compile(files, mainFile, bibtex, biber, null, true, 'info', 'luahbtex_bibtex8', null, 'scribyra:catalog', false, []));
      abort.signal.throwIfAborted();
      // Optional \IfFileExists probes are not a reason to install anything after success.
      if (result.success) break;
      getPackages();if(result.missing.length)output.step(`Looking up ${result.missing.length} missing ${result.missing.length===1?'file':'files'} in the TeX package catalog`);
      let added;
      try { added = await packages.resolve(result.missing, result.log, activeRunner, plan=>{if(plan.length)output.recovering();}); }
      catch(error) { if (abort.signal.aborted) throw error; error.texLog=result.log;throw error; }
      abort.signal.throwIfAborted();
      if (!added.length) {output.note('No TeX package provides the missing files.');break;}
      downloaded.push(...record(added));
      if (pass === 64) throw new Error('TeX package resolution exceeded 65 compilation attempts. See the missing-file log.');
    }
    const observedEnvironment=await getPackages().environment([...runnerPackages.keys()]);
    const report=await getPackages().diagnose({success:result.success,mainFile,log:boundedText(result.log,2*1024*1024),projectFiles:files.map(file=>file.path),recorder:boundedText(result.recorder,256*1024),recorderTruncated:result.recorderTruncated,stalledPackages:result.success?[]:packages.stalledPackages()});
    const packageLog = downloaded.length ? `\n\nTeX packages installed for this compile:\n${downloaded.map(p => `${packageLabel(p.name,p)} · ${p.cached ? 'cache' : 'download'}${p.saved ? '' : ' · not cached'}`).join('\n')}` : '';
    return { ...result, log: packageLog ? `${packageLog.trim()}\n\n${result.log}` : result.log, packages: downloaded, environment:observedEnvironment, report, diagnostic: result.success ? null : report.issues.find(issue=>issue.severity==='error')?.summary||'Compilation failed', jobId, cold, durationMs: performance.now() - started };
  })();
  const interruption = new Promise((_, reject) => { rejectActive = reject; });
  try { return await Promise.race([task, interruption]); }
  catch (error) { if(error.message==='Compilation timeout')error=new CompileTimeoutError(COMPILE_BUDGET_MS,phase);if (token === generation) { abort.abort(); runner?.terminate(); runner = null;runnerPackages.clear();runnerLocked=false; } throw error; }
  finally { clearTimeout(timeout); packages?.close();if(runner&&runner.onPrint&&token===generation)runner.onPrint=null; if (token === generation) { rejectActive = null; controller = null; } }
}
