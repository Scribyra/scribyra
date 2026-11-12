import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,copyFile,symlink,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,dirname,resolve} from 'node:path';
import {spawn} from 'node:child_process';
import net from 'node:net';
import {texRuntimeIdentity,runtimeInputs} from '../scripts/tex-environment.mjs';

test('development compiler updates rebuild the runtime identity without touching project data', {timeout:30000},async()=>{
 const root=resolve('.'),directory=await mkdtemp(join(tmpdir(),'scribyra-runtime-identity-'));let child,log='';
 try{
  for(const path of ['vite.config.js','scripts/tex-environment.mjs','web/tex-environment.js','web/telemetry-destination.js','web/telemetry-session.js',...runtimeInputs.filter(path=>path.startsWith('web/')||path.startsWith('crates/'))]){await mkdir(dirname(join(directory,path)),{recursive:true});await copyFile(join(root,path),join(directory,path));}
  await mkdir(join(directory,'public/core'),{recursive:true});await mkdir(join(directory,'public/core/busytex'));for(const path of runtimeInputs.filter(path=>path.startsWith('public/')))await writeFile(join(directory,path),'// Isolated fingerprint fixture: '+path+'\n');await symlink(join(root,'node_modules'),join(directory,'node_modules'),'dir');await writeFile(join(directory,'package.json'),'{"type":"module"}');await writeFile(join(directory,'public/core/busytex/lualatex-manifest.json'),JSON.stringify({sourceArchiveSha256:'a'.repeat(64),data:{path:'fixture.data',size:1,sha256:'b'.repeat(64)},loader:{path:'fixture.js',size:1,sha256:'c'.repeat(64)},metadata:{path:'fixture-catalog.json',size:1,sha256:'f'.repeat(64)},components:{path:'fixture.json',size:1,sha256:'d'.repeat(64)},files:{path:'fixture-files.json',size:1,sha256:'e'.repeat(64)}}));const config=join(directory,'vite.config.js');await writeFile(config,(await readFile(config,'utf8')).replace('defineConfig({',"defineConfig({cacheDir:'.vite',"));
  const lease=net.createServer();await new Promise((resolve,reject)=>{lease.once('error',reject);lease.listen(0,'127.0.0.1',resolve);});const port=lease.address().port;await new Promise(resolve=>lease.close(resolve));
  child=spawn(process.execPath,[join(root,'node_modules/vite/bin/vite.js'),'--host','127.0.0.1','--port',String(port)],{cwd:directory,env:process.env,stdio:['ignore','pipe','pipe']});for(const stream of [child.stdout,child.stderr])stream.on('data',data=>{log=(log+data).slice(-8000);});
  const extract=(source,name)=>source.match(new RegExp('["\\\']?'+name+'["\\\']?\\s*:\\s*["\\\']([a-f0-9]{64})'))?.[1];
  async function identity(changed){
   const deadline=Date.now()+10000;let lastSource='';
   while(Date.now()<deadline){
    if(child.exitCode!==null)throw new Error('Isolated Vite exited: '+log);
    try{const response=await fetch(`http://127.0.0.1:${port}/@vite/env?probe=${Date.now()}`,{signal:AbortSignal.timeout(1000)});const source=await response.text();lastSource=source;const adapter=extract(source,'adapterSha256');if(adapter&&(!changed||adapter!==changed))return{adapter,catalog:extract(source,'catalogSha256')};}catch{}
    await new Promise(resolve=>setTimeout(resolve,100));
   }
   throw new Error('Isolated runtime identity did not refresh: '+log+'\nResponse: '+lastSource.split('//# sourceMappingURL')[0].slice(0,2500));
  }
  const before=await identity(),runtime=texRuntimeIdentity(directory);assert.equal(before.adapter,runtime.adapterSha256);assert.equal(before.catalog,runtime.catalogSha256);
  const path=join(directory,'web/compiler.js');await writeFile(path,await readFile(path,'utf8')+'\n// Isolated adapter update probe.\n');
  const after=await identity(before.adapter);assert.notEqual(after.adapter,before.adapter);assert.equal(after.catalog,before.catalog);
 }finally{
  if(child?.exitCode===null){const stopped=new Promise(resolve=>child.once('exit',resolve));child.kill('SIGTERM');await stopped;}
  await rm(directory,{recursive:true,force:true});
 }
});
