import { readFile, writeFile as writeInPlace, rename, rm } from 'node:fs/promises';
// Compiler assets are often hard links into a shared store (other checkouts, the
// deployment cache). Write a new file and rename it into place so a patch never
// changes the bytes another checkout sees through the same inode.
async function writeFile(path,data){
  const temporary=`${path}.scribyra-${process.pid}.tmp`;
  try{await writeInPlace(temporary,data);await rename(temporary,path);}
  catch(error){await rm(temporary,{force:true});throw error;}
}
import { Script } from 'node:vm';
import { scribyraProjectWrites } from './virtual-fs-guard.mjs';
import {scribyraBiberProject} from './biber-project.mjs';
import { scribyraInstallTex } from './tex-runtime.mjs';
import {patchRuntimeDownload} from './runtime-download-observation.mjs';
import {patchCompilerWorker} from './patch-compiler-worker.mjs';
import {scribyraTexPasses} from './tex-passes.mjs';

// Small, reproducible fixes to the pinned 1.4.1 wrapper, not the WASM engine.
// Fail on unexpected upstream changes rather than silently applying half a fix.
export async function patchBusytex() {
  const workerPath='public/core/busytex/busytex_worker.js';await writeFile(workerPath,patchCompilerWorker(await readFile(workerPath,'utf8')));
  const path = 'public/core/busytex/busytex_pipeline.js';
  let source = await readFile(path, 'utf8');
  // Normalize our previous evidence return before reproducing the current one.
  source=source.replace(/return \{ pdf: pdf, synctex: synctex, log: logcat, exit_code: exit_code, logs: logs, missing: Array\.from\(Module\.scribyraMissing\.values\(\)\)[^\n]* \};/, 'return { pdf: pdf, synctex: synctex, log: logcat, exit_code: exit_code, logs: logs };');
  source=source.replace(/(?:Module\.scribyraMissing = new Map\(\);(?: Module\.scribyraInputs = new Set\(\); Module\.scribyraInputsTruncated = false;)?\s*)+(?=const \{ FS, PATH \} = Module;\n\n        const tex_path)/, '');
  const replacements = [
    ["biber_data = null) {", "biber_data = null, scribyra_observe = null) {\n        this.scribyraObserve = scribyra_observe;", 1],
    ["new BusytexBiber(biber_js, biber_wasm, biber_data, this.print, this.script_loader)", "new BusytexBiber(biber_js, biber_wasm, biber_data, this.print, this.script_loader, (...args) => this.scribyraObserve?.(...args))", 1],
    ["thisProgram: this.bin_busytex,", "thisProgram: this.bin_busytex,\n            scribyraObserve: (...args) => this.scribyraObserve?.(...args),", 1],
    ["TEXMFCNF: this.dir_cnf", "TEXMFHOME: '/texmf-downloads', TEXMFCNF: this.dir_cnf", 1],
    ["Module.kpse_remote_register(name, format != null ? format : 26, contents);", "if (format === -1) scribyraInstallTex(Module, name, contents); else Module.kpse_remote_register(name, format != null ? format : 26, contents);", 1],
    ["const { FS, PATH } = Module;\n\n        const tex_path", "Module.scribyraMissing = new Map(); Module.scribyraInputs = new Set(); Module.scribyraInputsTruncated = false;\n        const { FS, PATH } = Module;\n\n        const tex_path", 1],
    ["return { pdf: pdf, synctex: synctex, log: logcat, exit_code: exit_code, logs: logs };", "return { pdf: pdf, synctex: synctex, log: logcat, exit_code: exit_code, logs: logs, missing: Array.from(Module.scribyraMissing.values()) };", 1],
    ["TEXMFCACHE: this.dir_texmfvar", "TEXMFCACHE: '/tmp'", 1],
    ["TEXLIVE_REMOTE_ENDPOINT: ''", "TEXLIVE_REMOTE_ENDPOINT: '',\n            openout_any: 'r' // Scribyra enforces canonical project write boundaries in the virtual FS.", 1],
    ["const { exit_code, stdout, stderr } = Module.callMainWithRedirects([...cmd], verbose != BusytexPipeline.VerboseSilent);",
      "const { exit_code, stdout, stderr } = scribyraProjectWrites(Module, this.project_dir, this.dir_texmfvar, () => Module.callMainWithRedirects([...cmd], verbose != BusytexPipeline.VerboseSilent), cmd[0].startsWith('lua'));", 1],
    ["'--interaction=batchmode'", "'--interaction=nonstopmode'", 2],
    ["const effective_exit_code = stdout.trim() ? (error_messages.some(err => stdout.includes(err)) ? exit_code : 0) : exit_code;",
      "const effective_exit_code = exit_code || (error_messages.some(err => (stdout + '\\n' + log).includes(err)) ? 1 : 0);", 1],
    ["!entry.cmd.startsWith('bibtex') && !entry.cmd.startsWith('makeindex')",
      "!entry.cmd.startsWith('bibtex') && !entry.cmd.startsWith('biber') && !entry.cmd.startsWith('makeindex')", 1],
  ];
  for (const [before, after, expected] of replacements) {
    const count = source.split(before).length - 1;
    const applied=source.split(after).length-1;
    if (count===expected && (!after.includes(before)||!applied)) {
      source=source.replaceAll(before,after);continue;
    }
    if ((!count&&applied>=expected)||(after.includes(before)&&count===applied&&applied>=expected))continue;
    throw new Error('Unexpected BusyTeX wrapper version; cannot apply compilation fixes.');
  }
  // Passes as latexmk decides them (scripts/tex-passes.mjs) instead of BusyTeX's fixed
  // initial + bibliography + up to three reruns on log warnings + an extra final pass.
  source=source.replace("return { exit_code: effective_exit_code, log };","return { exit_code: effective_exit_code, log, stdout };");
  if(!source.includes('// SCRIBYRA PASSES')){
    const start=source.indexOf("        let exit_code = 0;\n        let last_log = '';\n\n        ({ exit_code, log: last_log } = run(initial, this.error_messages_fatal));");
    const stop=source.indexOf("        if (exit_code == 0 && dvi) {",start);
    if(start<0||stop<0||!source.slice(start,stop).includes('this._needs_rerun(last_log)'))throw new Error('Unexpected BusyTeX pass loop; cannot apply the rerun policy.');
    source=source.slice(0,start)+`        // SCRIBYRA PASSES: rerun only while a file LuaLaTeX reads changed (scripts/tex-passes.mjs).
        let exit_code = 0;
        let last_log = '';
        const rerun_enabled = rerun === null ? true : rerun;
        const scribyra_inputs = new Set(files.filter(f => f.contents != null).map(f => PATH.join(this.project_dir, f.path)));
        const scribyra_bibliography = !bibtex ? null : bib_backend == 'biber' && this.biber != null
            ? { kind: 'biber', bcf: tex_path.replace(/\\.tex$/i, '.bcf'), bbl: PATH.join(source_dir, bbl_path), run: () => this._run_biber(FS, tex_path, files, verbose_args_for('biber'), logs) }
            : { kind: 'bibtex', aux: aux_path, bbl: PATH.join(source_dir, bbl_path), cmd: bibtex8_cmd };
        const scribyra_index = (makeindex === null ? true : makeindex) ? { idx: idx_path, ind: PATH.join(source_dir, ind_path), cmd: makeindex_cmd } : null;
        ({ exit_code, last_log } = await scribyraTexPasses({ FS, projectDir: this.project_dir, inputs: scribyra_inputs, run, tex: final_cmd, fatal: this.error_messages_fatal, all: this.error_messages_all, bibliography: scribyra_bibliography, index: scribyra_index,
            consulted: () => ({ paths: new Set(Module.scribyraInputs || []), truncated: !Module.scribyraInputs || !!Module.scribyraInputsTruncated, missing: [...Module.scribyraMissing.values()].map(entry => String(entry.name)) }),
            maxPasses: rerun_enabled ? this.max_tex_passes + 2 : 1, print: this.print }));

`+source.slice(stop);
  }
  // Undo the earlier info-only recorder switch: authoritative input evidence is
  // collected at successful virtual-FS opens, including Lua's own file reads.
  for(const engine of ['luatex','luahbtex'])source=source.replace(`${engine}: ['-kpathsea-debug', '32', '-recorder']`,`${engine}: ['-kpathsea-debug', '32']`);
  const output='missing: Array.from(Module.scribyraMissing.values())';
  if(!source.includes('recorderTruncated:'))source=source.replace(output,output+`, recorder: Array.from(Module.scribyraInputs||[]).map(path=>'INPUT '+path).join('\\n').slice(0, 256*1024), recorderTruncated: !!Module.scribyraInputsTruncated || Array.from(Module.scribyraInputs||[]).reduce((sum,path)=>sum+path.length+7,0)>256*1024`);
  // The engine's WebAssembly memory after the run: it only grows, so this is the run's peak.
  if(!source.includes('memory: Module.HEAPU8.length'))source=source.replace(output,output+', memory: Module.HEAPU8.length');
  source=source.replaceAll(".replace('.tex',",".replace(/\\.tex$/i,");
  const bridge=[
    ["const inputs = [{ path: bcf_path, contents: FS.readFile(bcf_path, { encoding: 'utf8' }) }];", "const relative_dir=FS.cwd().slice(this.project_dir.length).replace(/^\\//,''); const control_path=(relative_dir?relative_dir+'/':'')+bcf_path;\n        const inputs = [{ path: control_path, contents: FS.readFile(bcf_path, { encoding: 'utf8' }) }];"],
    ["f.path.endsWith('.bib')", "/\\.bib$/i.test(f.path)"],
    ["this.biber.run(bcf_path, inputs, verbose_args)","this.biber.run(control_path, inputs, verbose_args)"],
  ];
  for(const[before,after]of bridge){if(source.includes(before))source=source.replace(before,after);else if(!source.includes(after))throw new Error('Unexpected Biber project bridge.');}

  const begin='// BEGIN SCRIBYRA VIRTUAL FS GUARD',end='// END SCRIBYRA VIRTUAL FS GUARD';
  const guard=`${begin}\n${scribyraProjectWrites.toString()}\n${scribyraInstallTex.toString()}\n${scribyraTexPasses.toString()}\n${end}\n`;
  if(source.startsWith(begin)){const stop=source.indexOf(end);if(stop<0)throw new Error('Invalid filesystem guard patch.');source=source.slice(stop+end.length).replace(/^\n/,'');}
  source=guard+source;
  new Script(source,{filename:path});
  await writeFile(path, source);

  const enginePath = 'public/core/busytex/busytex.js';
  let engine = await readFile(enginePath, 'utf8');
  const fetchStart = "fetch:function (name, format) {";
  const hook = fetchStart + "\n              // SCRIBYRA: report missing files for asynchronous, verified package installation.\n              if (Module.scribyraMissing && Module.scribyraMissing.size < 2048) Module.scribyraMissing.set(format + '/' + name, {name:name,format:format});\n              return null;";
  if (!engine.includes(hook)) {
    if (engine.split(fetchStart).length !== 2) throw new Error('Unexpected BusyTeX missing-file hook');
    engine = engine.replace(fetchStart, hook);
  }
  new Script(engine, {filename:enginePath});
  await writeFile(enginePath, engine);

  const biberPath = 'public/core/busytex/busytex_biber.js';
  let biber = await readFile(biberPath, 'utf8');
  // Upstream issue #36: macro accents can be double-encoded by WASM Biber.
  // Emit equivalent TeX accent macros instead of corrupt UTF-8 characters.
  const before = "'--nolog', ...verbose_args, bcf";
  const after = "'--nolog', '--output-safechars', ...verbose_args, bcf";
  if (biber.split(before).length === 2) biber = biber.replace(before, after);
  else if (!biber.includes(after)) throw new Error('Unexpected Biber wrapper version; cannot apply encoding fix.');
  const stagingBefore="FS.chdir(this.work_dir);\n        for (const { path, contents } of files)\n            FS.writeFile(this.work_dir + '/' + basename(path), contents);\n\n        const bcf = basename(bcf_path);";
  const stagingAfter="const staged=scribyraBiberProject(FS,this.work_dir,bcf_path,files);\n        const bcf=staged.controlFile;";
  if(biber.includes(stagingBefore))biber=biber.replace(stagingBefore,stagingAfter);else if(!biber.includes(stagingAfter))throw new Error('Unexpected Biber input staging.');
  biber=biber.replace("const bbl_full = this.work_dir + '/' + bbl;","const bbl_full = staged.outputFile;");
  for(const[original,replacement]of [
    ["constructor(biber_js, biber_wasm, biber_data, print, script_loader) {", "constructor(biber_js, biber_wasm, biber_data, print, script_loader, scribyra_observe = null) {\n        this.scribyraObserve = scribyra_observe;"],
    ["noInitialRun: true,", "noInitialRun: true,\n            scribyraObserve: this.scribyraObserve,"],
  ]){if(biber.includes(replacement))continue;if(!biber.includes(original))throw new Error('Unexpected Biber observer framing.');biber=biber.replace(original,replacement);}
  const biberBegin='// BEGIN SCRIBYRA BIBER PROJECT',biberEnd='// END SCRIBYRA BIBER PROJECT';
  if(biber.startsWith(biberBegin)){const stop=biber.indexOf(biberEnd);if(stop<0)throw new Error('Invalid Biber project helper.');biber=biber.slice(stop+biberEnd.length).replace(/^\n/,'');}
  biber=biberBegin+'\n'+scribyraBiberProject.toString()+'\n'+biberEnd+'\n'+biber;
  new Script(biber,{filename:biberPath});
  await writeFile(biberPath, biber);

  // Runtime assets have a verified, bounded cache in Scribyra. Avoid a second
  // unbounded copy of Biber's 21 MiB data in Emscripten's preload database.
  const dataPath='public/core/busytex/biber.js';let data=await readFile(dataPath,'utf8');
  const marker='/* Scribyra: runtime cache owns Biber data. */';
  if(!data.includes(marker)){
    const start=data.indexOf('        try {\n          var db = await openDatabase();');
    const end=data.indexOf("        Module['setStatus'] && Module['setStatus']('Downloading...');",start);
    if(start<0||end<start)throw new Error('Unexpected Biber preload cache framing.');
    data=data.slice(0,start)+`        ${marker}\n        processPackageData(await fetchRemotePackage(REMOTE_PACKAGE_NAME, REMOTE_PACKAGE_SIZE));\n\n`+data.slice(end);
  }
  data=patchRuntimeDownload(data);
  new Script(data,{filename:dataPath});await writeFile(dataPath,data);
}

await patchBusytex();
