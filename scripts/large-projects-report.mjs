#!/usr/bin/env node
// Medians of the large-project runs (tests/browser/large-projects.spec.js).
//   node scripts/large-projects-report.mjs <dir>/results.jsonl [docs/measurements/large-projects.json]
import {readFileSync,writeFileSync} from 'node:fs';

const [input,output='docs/measurements/large-projects.json']=process.argv.slice(2);
if(!input)throw new Error('Pass the results.jsonl written by the large-project spec.');
const rows=readFileSync(input,'utf8').trim().split('\n').filter(Boolean).map(line=>JSON.parse(line));
const median=values=>{const sorted=values.filter(v=>typeof v==='number').sort((a,b)=>a-b);if(!sorted.length)return null;const mid=sorted.length>>1;return sorted.length%2?sorted[mid]:Math.round((sorted[mid-1]+sorted[mid])/2*10)/10;};
/** Numbers become medians; strings and booleans keep each run's value when they differ. */
function combine(values){
  const present=values.filter(v=>v!==undefined);
  if(present.every(v=>typeof v==='number'||v===null))return median(present);
  if(present.every(v=>v&&typeof v==='object'&&!Array.isArray(v))){const keys=[...new Set(present.flatMap(Object.keys))];return Object.fromEntries(keys.map(key=>[key,combine(present.map(v=>v[key]))]));}
  const distinct=[...new Set(present.map(v=>JSON.stringify(v)))].map(v=>JSON.parse(v));
  return distinct.length===1?distinct[0]:distinct;
}
const groups=new Map();
// A run that stopped early keeps its partial line for diagnosis but is left out of the medians.
const incomplete=new Map();
for(const row of rows){const key=`${row.scenario}/${row.browser}`;if(row.incomplete){incomplete.set(key,(incomplete.get(key)||0)+1);continue;}if(!groups.has(key))groups.set(key,[]);groups.get(key).push(row);}
const result={generatedBy:'scripts/large-projects-report.mjs',statistic:'median',scenarios:{}};
for(const [key,list] of [...groups].sort()){
  const [scenario,browser]=key.split('/'),{at,browser:_b,scenario:_s,...rest}=combine(list);
  (result.scenarios[scenario]||={})[browser]={runs:list.length,incompleteRuns:incomplete.get(key)||0,...rest};
}
writeFileSync(output,JSON.stringify(result,null,2)+'\n');
console.log(`Wrote ${output}: ${[...groups].map(([key,list])=>`${key}×${list.length}`).join(', ')}`);
