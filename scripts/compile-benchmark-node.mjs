// The Node side of the compile benchmark (docs/compile-engines.md): the server's WebAssembly
// compile runner (server/compile/runner.mjs) without the sandbox, one compile per child process,
// so each run starts from the engine's baseline as a server job does and its peak RSS is its own.
//   node scripts/wasm-compile-runtime.mjs target/wasm-compile-runtime --link
//   node scripts/compile-benchmark-node.mjs <docs> <out> [runs=5] [thesisRuns=3] [--only sample,article]
// Writes <out>/node.jsonl (one line per run) and <out>/node/<doc>.pdf. Scenarios:
//   cold      an empty package cache, filled during the job (bundled archives, else the mirror)
//   warm      a filled cache, no knowledge of the project
//   project   a filled cache and the package names the project's previous successful compile
//             installed, as the service passes them with each job (`packages`)
// Mirror archives are kept in <out>/../mirror after their first download, so repeated cold runs
// measure the job, not the network; the runner verifies every archive against the catalog.
import {spawnSync,execFileSync} from 'node:child_process';
import {mkdirSync,mkdtempSync,rmSync,existsSync,copyFileSync,writeFileSync,appendFileSync,readFileSync,renameSync} from 'node:fs';
import {join,resolve,dirname} from 'node:path';
import {tmpdir} from 'node:os';

const self=new URL(import.meta.url).pathname;
const runtime=resolve(process.env.SCRIBYRA_WASM_RUNTIME||'target/wasm-compile-runtime');
const mirror=(process.env.SCRIBYRA_TEX_MIRROR||'https://tlnet.yihui.org').replace(/\/$/,'');

async function one(){
 const job=JSON.parse(process.argv[3]);
 const {compile}=await import(join(runtime,'server/compile/runner.mjs'));
 const components=join(runtime,'public/core/busytex');
 // A synchronous stand-in for the compile worker's fill channel.
 const fill=(name,pkg)=>{
  const target=join(job.cache,`${pkg.sha512}.tar.xz`);if(existsSync(target))return;
  const bundled=pkg.archive?join(components,pkg.archive):join(components,'components',`${pkg.sha512}.tar.xz`);
  let source=existsSync(bundled)?bundled:join(job.mirror,`${pkg.sha512}.tar.xz`);
  if(!existsSync(source)){
   mkdirSync(job.mirror,{recursive:true});const partial=`${source}.${process.pid}.part`;
   execFileSync('curl',['-sfL','--max-time','120','-o',partial,`${mirror}/archive/${name}.tar.xz`]);renameSync(partial,source);
  }
  copyFileSync(source,target);
 };
 const started=performance.now();let result,error;
 const notes=[];try{result=await compile({runtime,cache:job.cache,work:job.work,main:'main.tex',fill,onOutput:entry=>{if(entry.kind==='note'||entry.kind==='step')notes.push(entry.text);},packages:job.packages||undefined,budgetMs:1_800_000});}
 catch(e){error=e;}
 finally{if(job.pdf)writeFileSync(job.pdf.replace(/\.pdf$/,'.log'),`${notes.join('\n')}\n\n${result?.log??error?.stack??''}`);}
 const wallMs=performance.now()-started,maxRssKiB=process.resourceUsage().maxRSS;
 if(result?.success&&job.pdf)writeFileSync(job.pdf,result.pdf);

 process.stdout.write(JSON.stringify({status:result?.success?'Success':error?'Error':'Failure',passes:result?.passes??error?.passes??0,wallMs,maxRssMiB:Math.round(maxRssKiB/1024),engineMemoryMiB:result?.engineMemoryBytes?Math.round(result.engineMemoryBytes/1048576):null,packages:(result?.packages||[]).map(p=>p.name),error:error?String(error.message||error).slice(0,500):result?.success?undefined:result?.diagnostic})+'\n');
 process.exit(0);
}

function run(job){
 const child=spawnSync(process.execPath,['--max-old-space-size=4096',self,'--one',JSON.stringify(job)],{encoding:'utf8',maxBuffer:64<<20});
 const line=child.stdout.trim().split('\n').pop();
 try{return JSON.parse(line);}catch{return{status:'Crash',error:(child.stderr||'').slice(-2000)};}
}

async function main(){
 const args=process.argv.slice(2),onlyAt=args.indexOf('--only'),only=onlyAt>=0?args.splice(onlyAt,2)[1].split(','):null;
 const [docsDir,outDir,runsArg,thesisArg]=args,docs=resolve(docsDir||'target/compile-benchmark/docs'),out=resolve(outDir||'target/compile-benchmark/out');
 const runs=Number(runsArg||5),thesisRuns=Number(thesisArg||3),stash=resolve(out,'..','mirror'),label=process.env.SCRIBYRA_BENCH_LABEL||'node';
 mkdirSync(join(out,label),{recursive:true});
 const scenarios=(process.env.SCRIBYRA_BENCH_SCENARIOS||'cold,warm,project').split(',');
 for(const doc of only||['sample','article','beamer','tikz','thesis']){
  const n=doc==='thesis'?thesisRuns:runs,work=join(docs,doc),shared=mkdtempSync(join(tmpdir(),'scribyra-bench-cache-'));
  // An untimed run fills the shared cache and records what the project installs.
  const first=run({work,cache:shared,mirror:stash,pdf:join(out,label,`${doc}.pdf`)});
  if(first.status!=='Success')console.error(JSON.stringify({doc,untimed:first}));
  for(const cache of scenarios)for(let i=0;i<n;i++){
   const own=cache==='cold'?mkdtempSync(join(tmpdir(),'scribyra-bench-cache-')):shared;
   const record={doc,engine:label,cache,run:i,...run({work,cache:own,mirror:stash,packages:cache==='project'?first.packages:null})};
   if(cache==='cold')rmSync(own,{recursive:true,force:true});
   appendFileSync(join(out,`${label}.jsonl`),JSON.stringify(record)+'\n');console.log(JSON.stringify(record));
  }
  rmSync(shared,{recursive:true,force:true});
 }
}

if(process.argv[2]==='--one')await one();else await main();
