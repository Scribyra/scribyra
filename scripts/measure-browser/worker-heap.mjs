// Chromium-only CDP isolate metrics. Other browsers have no equivalent public
// Playwright endpoint; do not label process RSS as a dedicated worker's heap.
export async function sampleWorkerHeap(browser,interval=250){
 const root=await browser.newBrowserCDPSession(),sessions=new Map(),pending=new Map(),samples=[];let next=0,stopped=false,phase='cold',failure;
 root.on('Target.receivedMessageFromTarget',({message})=>{const data=JSON.parse(message),task=pending.get(data.id);if(!task)return;pending.delete(data.id);clearTimeout(task.timer);data.error?task.reject(new Error(data.error.message)):task.resolve(data.result);});
 const usage=sessionId=>new Promise((resolve,reject)=>{const id=++next,timer=setTimeout(()=>{pending.delete(id);reject(new Error('Worker heap query timed out.'));},3000);pending.set(id,{resolve,reject,timer});root.send('Target.sendMessageToTarget',{sessionId,message:JSON.stringify({id,method:'Runtime.getHeapUsage'})}).catch(error=>{clearTimeout(timer);pending.delete(id);reject(error);});});
 const task=(async()=>{while(!stopped){try{
  const targets=(await root.send('Target.getTargets')).targetInfos.filter(t=>['worker','service_worker'].includes(t.type));
  for(const target of targets)if(!sessions.has(target.targetId)){try{sessions.set(target.targetId,{...await root.send('Target.attachToTarget',{targetId:target.targetId,flatten:false}),target});}catch{}}
  const currentPhase=phase;await Promise.all(targets.map(async target=>{const entry=sessions.get(target.targetId);if(!entry)return;try{samples.push({phase:currentPhase,type:target.type,target:target.targetId,kind:target.url.includes('busytex_worker')?'compiler':target.url.includes('tex-packages')?'packages':target.type==='service_worker'?'service-worker':'other',...await usage(entry.sessionId)});}catch{}}));
 }catch(error){failure=error.message;break;}await new Promise(resolve=>setTimeout(resolve,interval));}})();
 return{mark(value){phase=value;},async stop(){stopped=true;await task;await root.detach();return{intervalMs:interval,samples:samples.length,scope:'CDP Runtime.getHeapUsage isolate metrics; backing storage includes ArrayBuffer/external-string storage. Not resident memory and not additive to RSS/PSS.',failure,byKind:Object.fromEntries([...new Set(samples.map(s=>s.kind))].map(kind=>{const rows=samples.filter(s=>s.kind===kind);return[kind,{samples:rows.length,peakUsedSize:Math.max(...rows.map(s=>s.usedSize)),peakBackingStorageSize:Math.max(...rows.map(s=>s.backingStorageSize||0))}];})),timeline:samples};}};
}
