import { mkdtemp,mkdir,readFile,writeFile,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
const root=fileURLToPath(new URL('../',import.meta.url));
const work=await mkdtemp(join(tmpdir(),'scribyra-wrapper-verification-'));
const names=['busytex_worker.js','busytex_pipeline.js','busytex_biber.js','busytex.js','biber.js'];
try {
  const directory=join(work,'public/core/busytex');await mkdir(directory,{recursive:true});
  for(const name of names) {
    const original=execFileSync('tar',['-xOzf',join(root,'.cache/busytex-assets.tar.gz'),`busytex/${name}`],{maxBuffer:8*1024*1024});
    await writeFile(join(directory,name),original);
  }
  execFileSync(process.execPath,[join(root,'scripts/patch-busytex.mjs')],{cwd:work});
  const once=await Promise.all(names.map(name=>readFile(join(directory,name))));
  execFileSync(process.execPath,[join(root,'scripts/patch-busytex.mjs')],{cwd:work});
  for(const [i,name]of names.entries()) {
    assert.deepEqual(await readFile(join(directory,name)),once[i],`${name}: repeated patch must be identical`);
    assert.deepEqual(await readFile(join(root,'public/core/busytex',name)),once[i],`${name}: installed wrapper differs from freshly patched pinned source`);
  }
  console.log('Fresh pinned wrappers patch successfully, match installed files, and remain byte-identical on repeat.');
} finally {await rm(work,{recursive:true,force:true});}
