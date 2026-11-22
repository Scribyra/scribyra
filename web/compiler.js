import {warmRuntime} from './runtime-assets.js';
import {observed} from './observability.js';
import {CompileTimeoutError} from './build-errors.js';
import { texPackages } from './tex-packages.js';
import {compileOutput} from './compile-log.js';
import {TEX_ASSETS,TEX_ASSET_BASE,TEX_RUNTIME} from './tex-environment.js';
import {LuaRunner,COMPILE_BUDGET_MS,executionBudget,runPasses,engineMemoryLimit} from './compile-driver.js';
import {rememberedPackages,rememberPackages} from './project-packages.js';
export {COMPILE_BUDGET_MS};
const base = TEX_ASSET_BASE;
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
export async function compileProject({ files, mainFile, engine, jobId, projectId=null, environment=null,telemetryParent }, onProgress, onOutput=()=>{}) {
  if (engine !== 'lualatex') throw new Error('Scribyra currently supports LuaLaTeX only.');
  // A locked run starts from the immutable baseline, never a warm superset.
  if(environment!==null||runnerLocked)cancelCompile();
  runnerLocked=environment!==null;
  const token = ++generation, abort = new AbortController(); controller = abort;
  const started = performance.now(), cold = !runner;let phase='Preparing compiler';
  const progress=message=>{phase=message;onProgress(message);};
  const output=compileOutput(entry=>{if(token===generation)onOutput(entry);}),step=(message,label=message.replace(/…$/,''))=>{progress(message);output.step(label);};
  // Component preparation has its own idle/cancellation limits. Count only
  // time spent awaiting compiler calls against this job's execution budget.
  const budget=executionBudget(COMPILE_BUDGET_MS,()=>phase,error=>{if(token===generation)cancelCompile(error);}),execute=operation=>budget.run(operation);
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
      runner.telemetrySignal=abort.signal;runner.memoryBytes=engineMemoryLimit();
      await observed('startup',async parent=>{runner.telemetryParent=parent;await runner.initialize(true);},{parent:telemetryParent});
    }
    abort.signal.throwIfAborted();
    const downloaded = environment!==null?record(await getPackages().preload(environment,runner)):[];
    // An unlocked project starts from what it needed last time on this device.
    const snapshot=TEX_RUNTIME?.snapshot,known=environment===null?rememberedPackages(projectId,snapshot).filter(name=>!runnerPackages.has(name)):[];
    const result=await runPasses({files,mainFile,runner,packages:getPackages,record,installed:()=>[...runnerPackages.keys()],downloaded,output,progress,execute,signal:abort.signal,current:()=>token===generation,telemetryParent,prepareBiber:parent=>warmRuntime(abort.signal,progress,'biber',parent),known,prepare:environment===null});
    if(result.success&&environment===null)rememberPackages(projectId,snapshot,[...runnerPackages.keys()]);
    return { ...result, jobId, cold, durationMs: performance.now() - started };
  })();
  const interruption = new Promise((_, reject) => { rejectActive = reject; });
  try { return await Promise.race([task, interruption]); }
  catch (error) { if(error.message==='Compilation timeout')error=new CompileTimeoutError(COMPILE_BUDGET_MS,phase);if (token === generation) { abort.abort(); runner?.terminate(); runner = null;runnerPackages.clear();runnerLocked=false; } throw error; }
  finally { budget.clear(); packages?.close(); if (token === generation) { rejectActive = null; controller = null; } }
}
