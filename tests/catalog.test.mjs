import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
test('an HTML challenge cannot replace the frozen catalog during offline upstream regeneration',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'scribyra-catalog-source-')),path=join(directory,'database.xz'),output=join(directory,'catalog.json.gz');
 try{
  await writeFile(path,'<!doctype html><title>Access denied</title>');await writeFile(output,'Existing catalog must survive');
  const before=await readFile('web/tex-catalog.json.gz'),result=spawnSync('python3',['scripts/tex-catalog.py','--database',path,'--archives',directory,'--output',output,'--check'],{encoding:'utf8',timeout:10000});
  assert.equal(result.status,1,result.stdout+result.stderr);assert.match(result.stderr,/differs from its pin/);assert.match(result.stderr,/no catalog was changed/);
  assert.equal(await readFile(output,'utf8'),'Existing catalog must survive');assert.deepEqual(await readFile('web/tex-catalog.json.gz'),before);
 }finally{await rm(directory,{recursive:true,force:true});}
});
