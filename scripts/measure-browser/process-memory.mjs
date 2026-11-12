import {readdir,readFile} from 'node:fs/promises';

// Linux process-tree sampling, including children forked by non-main threads.
// Read only stat/status/smaps_rollup, never command lines or environment data.
export async function processMemory(rootPid){
 const entries=await readdir('/proc'),rows=new Map();
 await Promise.all(entries.filter(name=>/^\d+$/.test(name)).map(async name=>{try{
  const text=await readFile(`/proc/${name}/stat`,'utf8'),fields=text.slice(text.lastIndexOf(')')+2).split(' ');
  rows.set(Number(name),{pid:Number(name),parent:Number(fields[1]),started:fields[19]});
 }catch{}}));
 const selected=new Set([rootPid]);let changed=true;
 while(changed){changed=false;for(const row of rows.values())if(selected.has(row.parent)&&!selected.has(row.pid)){selected.add(row.pid);changed=true;}}
 const processes=(await Promise.all([...selected].map(async pid=>{try{
  const [status,maps]=await Promise.all([readFile(`/proc/${pid}/status`,'utf8'),readFile(`/proc/${pid}/smaps_rollup`,'utf8').catch(()=>null)]);
  const kb=(text,key)=>{const value=text?.match(new RegExp('^'+key+':\\s+(\\d+) kB$','m'));return value?Number(value[1])*1024:null;};
  return{pid,started:rows.get(pid)?.started,rss:kb(status,'VmRSS'),highWaterRss:kb(status,'VmHWM'),pss:kb(maps,'Pss'),name:status.match(/^Name:\s+(.+)$/m)?.[1]};
 }catch{return null;}}))).filter(Boolean);
 return{time:Date.now(),rss:processes.reduce((sum,p)=>sum+(p.rss||0),0),pss:processes.every(p=>p.pss!==null)?processes.reduce((sum,p)=>sum+p.pss,0):null,processes};
}
export function sampleProcessMemory(rootPid,interval=250){
 const samples=[];let stopped=false,failure=null,phase='cold';
 const task=(async()=>{while(!stopped){const currentPhase=phase;try{samples.push({...await processMemory(rootPid),phase:currentPhase});}catch(error){failure=error.message;break;}await new Promise(resolve=>setTimeout(resolve,interval));}})();
 const summary=rows=>({samples:rows.length,peakSampledRss:Math.max(0,...rows.map(s=>s.rss)),peakSampledPss:rows.some(s=>s.pss!==null)?Math.max(...rows.filter(s=>s.pss!==null).map(s=>s.pss)):null});
 return{mark(value){phase=value;},async stop(){stopped=true;await task;return{intervalMs:interval,...summary(samples),byPhase:Object.fromEntries([...new Set(samples.map(s=>s.phase))].map(phase=>[phase,summary(samples.filter(s=>s.phase===phase))])),pssSamples:samples.filter(s=>s.pss!==null).length,processes:[...new Map(samples.flatMap(s=>s.processes).map(p=>[`${p.pid}:${p.started}`,p])).values()],failure,timeline:samples.map(({time,rss,pss,phase})=>({time,rss,pss,phase}))};}};
}
