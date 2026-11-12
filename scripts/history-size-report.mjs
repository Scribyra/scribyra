#!/usr/bin/env node
// Collects the stored-history measurements (docs/large-projects.md, "Stored history size
// after the fix") into one JSON file:
//   node scripts/history-size-report.mjs out.json name=path.jsonl [name=path.jsonl ...]
// Each input is a JSON-lines file from scripts/typing-history.mjs (Node), from
// tests/browser/typing-history.spec.js (typing.jsonl, one browser per line) or from
// tests/browser/large-projects.spec.js (results.jsonl). Browser files are split per engine;
// repeated runs of one scenario and engine become medians.
import {readFileSync,writeFileSync} from 'node:fs';
const [output,...inputs]=process.argv.slice(2);
const median=values=>{const s=values.filter(v=>typeof v==='number').sort((a,b)=>a-b);if(!s.length)return null;const m=s.length>>1;return s.length%2?s[m]:Math.round((s[m-1]+s[m])/2*10)/10;};
function combine(values){
  const present=values.filter(v=>v!==undefined);
  if(present.every(v=>typeof v==='number'||v===null))return median(present);
  if(present.every(v=>v&&typeof v==='object'&&!Array.isArray(v))){const keys=[...new Set(present.flatMap(Object.keys))];return Object.fromEntries(keys.map(key=>[key,combine(present.map(v=>v[key]))]));}
  const distinct=[...new Set(present.map(v=>JSON.stringify(v)))].map(v=>JSON.parse(v));return distinct.length===1?distinct[0]:distinct;
}
const result={generatedBy:'scripts/history-size-report.mjs',runs:{}};
for(const input of inputs){
  const [name,path]=input.split('=');const rows=readFileSync(path,'utf8').trim().split('\n').filter(Boolean).map(line=>JSON.parse(line));
  const groups=new Map();
  for(const row of rows){if(row.incomplete)continue;const key=[row.browser||'node',row.scenario||row.kind,row.kind==='milestone'?row.chars:''].join('/');if(!groups.has(key))groups.set(key,[]);groups.get(key).push(row);}
  const out={};for(const [key,list]of groups){const {at,...rest}=combine(list);out[key]={runs:list.length,...rest};}
  result.runs[name]=out;
}
writeFileSync(output,JSON.stringify(result,null,1)+'\n');console.log('Wrote',output);
