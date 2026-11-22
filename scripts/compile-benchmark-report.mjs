// Medians of the compile benchmark's runs: crates/compile/examples/bench.rs output (feature/org-sync-v2),
// scripts/compile-benchmark-node.mjs and tests/browser/compile-benchmark.spec.js lines.
//   node scripts/compile-benchmark-report.mjs target/compile-benchmark/out/*.jsonl
import {readFileSync} from 'node:fs';
const runs=process.argv.slice(2).flatMap(path=>readFileSync(path,'utf8').split('\n').filter(Boolean).map(line=>JSON.parse(line)));
const median=values=>{const v=[...values].filter(x=>x!=null).sort((a,b)=>a-b),m=v.length>>1;return!v.length?null:v.length%2?v[m]:(v[m-1]+v[m])/2;};
const wall=run=>run.wall_ms??run.wallMs,ok=run=>run.status===undefined||run.status==='Success';
const groups=new Map();
for(const run of runs){const key=[run.doc,run.engine,run.browser||'',run.cache].join('\t');if(!groups.has(key))groups.set(key,[]);groups.get(key).push(run);}
for(const[key,list]of groups){
 const [doc,engine,browser,cache]=key.split('\t'),good=list.filter(ok),max=values=>{const v=values.filter(x=>x!=null);return v.length?Math.max(...v):null;};
 console.log(JSON.stringify({doc,engine,...browser?{browser}:{},cache,runs:list.length,ok:good.length,wallS:+(median(good.map(wall))/1000).toFixed(1),wallMinS:+(Math.min(...good.map(wall))/1000).toFixed(1),wallMaxS:+(Math.max(...good.map(wall))/1000).toFixed(1),
  ...good.some(r=>r.cpu_ms!=null)?{cpuS:+(median(good.map(r=>r.cpu_ms))/1000).toFixed(1)}:{},
  peakMiB:max(good.map(r=>r.peak_mib??r.maxRssMiB)),engineMiB:max(good.map(r=>r.engineMemoryMiB)),passes:median(good.map(r=>r.passes))}));
}
