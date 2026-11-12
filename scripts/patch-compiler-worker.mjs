import {Script} from 'node:vm';
import {workerObservation,workerObserver,workerCompileObservation,workerResourceObservation,workerInitializeObservation} from '../web/worker-observation.js';

export function patchCompilerWorker(source){
 const begin='// BEGIN SCRIBYRA WORKER OBSERVATION',end='// END SCRIBYRA WORKER OBSERVATION';
 if(source.startsWith(begin)){const stop=source.indexOf(end);if(stop<0)throw new Error('Invalid worker observation patch.');source=source.slice(stop+end.length).replace(/^\n/,'');}
 const before='write_texlive_remote_misses } })',after='write_texlive_remote_misses, scribyra_telemetry } })';
 if(source.includes(before))source=source.replace(before,after);else if(!source.includes(after))throw new Error('Unexpected compiler worker request.');
 const call='postMessage(await self.pipeline.compile(files, main_tex_path, bibtex, biber, makeindex, rerun, verbose, driver, data_packages_js, remote_endpoint, shell_escape === true))';
 const observed='postMessage(await workerCompileObservation(self.pipeline, [files, main_tex_path, bibtex, biber, makeindex, rerun, verbose, driver, data_packages_js, remote_endpoint, shell_escape === true], scribyra_telemetry))';
 if(source.includes(call))source=source.replace(call,observed);else if(!source.includes(observed))throw new Error('Unexpected compiler worker call.');
 const initialize="self.pipeline = new BusytexPipeline(busytex_js, busytex_wasm, data_packages_js, preload_data_packages_js, texmf_local, msg => postMessage({ print: msg }), applet_versions => postMessage({ initialized: applet_versions }), preload, BusytexPipeline.ScriptLoaderWorker, biber_js, biber_wasm, biber_data);";
 const previousInitialize='self.pipeline = workerInitializeObservation(scribyra_ready => new BusytexPipeline(busytex_js, busytex_wasm, data_packages_js, preload_data_packages_js, texmf_local, msg => postMessage({ print: msg }), scribyra_ready, preload, BusytexPipeline.ScriptLoaderWorker, biber_js, biber_wasm, biber_data), scribyra_telemetry);';
 if(source.includes(previousInitialize))source=source.replace(previousInitialize,'self.pipeline = workerInitializeObservation((scribyra_ready, scribyra_observe) => new BusytexPipeline(busytex_js, busytex_wasm, data_packages_js, preload_data_packages_js, texmf_local, msg => postMessage({ print: msg }), scribyra_ready, preload, BusytexPipeline.ScriptLoaderWorker, biber_js, biber_wasm, biber_data, scribyra_observe), scribyra_telemetry);');
 const initializeObserved="self.pipeline = workerInitializeObservation((scribyra_ready, scribyra_observe) => new BusytexPipeline(busytex_js, busytex_wasm, data_packages_js, preload_data_packages_js, texmf_local, msg => postMessage({ print: msg }), scribyra_ready, preload, BusytexPipeline.ScriptLoaderWorker, biber_js, biber_wasm, biber_data, scribyra_observe), scribyra_telemetry);";
 if(source.includes(initialize))source=source.replace(initialize,initializeObserved);else if(!source.includes(initializeObserved))throw new Error('Unexpected compiler worker initialization.');
 source=begin+'\n'+workerObservation.toString()+'\n'+workerObserver.toString()+'\n'+workerCompileObservation.toString()+'\n'+workerResourceObservation.toString()+'\n'+workerInitializeObservation.toString()+'\n'+end+'\n'+source;
 new Script(source,{filename:'busytex_worker.js'});return source;
}
