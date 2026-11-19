// Assembles the server's WebAssembly compile runtime: the browser's BusyTeX engine, worker
// glue and bundled LuaLaTeX data, the browser modules the compile driver needs (followed from
// their imports), the Rust/WASM core, and the bundled package archives that fill the server's
// package cache. The compile worker binds the result read-only into every job's sandbox.
//   node scripts/wasm-compile-runtime.mjs <out-dir>
// Files are hard-linked where possible (same file system), else copied. Needs `npm run wasm`
// (web/pkg) and the patched compiler assets (`node scripts/patch-busytex.mjs`).
import {mkdirSync,linkSync,copyFileSync,readFileSync,writeFileSync,existsSync,rmSync,readdirSync,statSync} from 'node:fs';
import {dirname,join,relative,resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {texRuntimeAssets,texRuntimeIdentity,texMetadataShards} from './tex-environment.mjs';

const root=resolve(new URL('..',import.meta.url).pathname);
const out=resolve(process.argv[2]||'target/wasm-compile-runtime');
const entries=['server/compile/runner.mjs','server/compile/worker-scope.mjs','web/compile-driver.js','web/tex-packages.js','web/tex-packages-ops.js','web/compile-log.js'];

function place(path){
 const from=join(root,path),to=join(out,path);
 if(!existsSync(from))throw new Error(`missing ${path}`);
 mkdirSync(dirname(to),{recursive:true});
 if(existsSync(to))return;
 try{linkSync(from,to);}catch{copyFileSync(from,to);}
}
function tree(path){for(const entry of readdirSync(join(root,path),{withFileTypes:true})){const child=join(path,entry.name);if(entry.isDirectory())tree(child);else if(entry.isFile())place(child);}}

// Static imports of the shared browser modules, followed to their packages.
const seen=new Set(),packages=new Set();
function follow(path){
 if(seen.has(path))return;seen.add(path);place(path);
 if(!/\.(m?js)$/.test(path))return;
 const source=readFileSync(join(root,path),'utf8');
 for(const [,spec] of source.matchAll(/(?:^|[;\s])(?:import|export)\s*(?:[^'";]*?\sfrom\s*)?['"]([^'"]+)['"]/g)){
  if(spec.startsWith('node:'))continue;
  if(spec.startsWith('.')){follow(relative(root,resolve(dirname(join(root,path)),spec)));continue;}
  const name=spec.startsWith('@')?spec.split('/').slice(0,2).join('/'):spec.split('/')[0];
  if(!packages.has(name)){packages.add(name);tree(join('node_modules',name));const manifest=JSON.parse(readFileSync(join(root,'node_modules',name,'package.json'),'utf8'));for(const dep of Object.keys(manifest.dependencies||{}))if(!packages.has(dep)){packages.add(dep);tree(join('node_modules',dep));}}
 }
}

rmSync(out,{recursive:true,force:true});mkdirSync(out,{recursive:true});
for(const entry of entries)follow(entry);
place('web/pkg/scribyra_app_bg.wasm');
writeFileSync(join(out,'package.json'),'{"type":"module","private":true}\n');
const assets=texRuntimeAssets(root),runtime=texRuntimeIdentity(root),metadata=texMetadataShards(root);
const busytex='public/core/busytex';
for(const asset of [...assets.core,...assets.biber,assets.metadata,...metadata])place(join(busytex,asset.path));
place(join(busytex,'lualatex-manifest.json'));
// The bundled set: distribution components and static support archives, by SHA-512.
tree(join(busytex,'components'));
const info={version:1,runtime,assets,metadata};
writeFileSync(join(out,'runtime.json'),JSON.stringify(info,null,1)+'\n');
const bytes=p=>{let n=0;for(const e of readdirSync(p,{withFileTypes:true}))n+=e.isDirectory()?bytes(join(p,e.name)):statSync(join(p,e.name)).size;return n;};
const id=createHash('sha256').update(JSON.stringify(info)).digest('hex');
console.log(JSON.stringify({event:'wasm_runtime',out,id,bytes:bytes(out),modules:seen.size,packages:[...packages].sort()}));
