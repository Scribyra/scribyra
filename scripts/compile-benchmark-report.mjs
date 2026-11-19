// Medians of the compile-engine benchmark's runs (crates/compile/examples/bench.rs output):
//   node scripts/compile-benchmark-report.mjs target/compile-benchmark/out/*.jsonl
import {readFileSync} from 'node:fs';
const runs=process.argv.slice(2).flatMap(path=>readFileSync(path,'utf8').split('\n').filter(Boolean).map(line=>JSON.parse(line)));
const median=values=>{const v=[...values].sort((a,b)=>a-b),m=v.length>>1;return v.length%2?v[m]:(v[m-1]+v[m])/2;};
const groups=new Map();
for(const run of runs){const key=`${run.doc}\t${run.engine}\t${run.cache}`;if(!groups.has(key))groups.set(key,[]);groups.get(key).push(run);}
for(const[key,list]of groups){
 const [doc,engine,cache]=key.split('\t'),ok=list.filter(run=>run.status==='Success');
 console.log(JSON.stringify({doc,engine,cache,runs:list.length,ok:ok.length,wallS:+(median(ok.map(r=>r.wall_ms))/1000).toFixed(1),cpuS:+(median(ok.map(r=>r.cpu_ms))/1000).toFixed(1),wallMinS:+(Math.min(...ok.map(r=>r.wall_ms))/1000).toFixed(1),wallMaxS:+(Math.max(...ok.map(r=>r.wall_ms))/1000).toFixed(1),peakMiB:Math.max(...ok.map(r=>r.peak_mib)),passes:median(ok.map(r=>r.passes))}));
}
