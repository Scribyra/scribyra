// Full mesh of N "laptops". Only the first pair and each joiner's first link use a manual exchange; every other link is signalled over existing data channels.
import {Lab,save,sleep,manual} from './lab.mjs';const out={};
async function mesh(n,engines){const key=`mesh${n}:${engines.join(',')}`;const lab=new Lab();const r={n,engines};try{const hosts=[],ag=[];for(let i=0;i<n;i++){hosts.push(await lab.host('h'+i));const a=await lab.agent(hosts[i],engines[i%engines.length]);ag.push(a);await a.call('setup',{me:'p'+i,fixture:i===0?'/thesis.json':undefined,seedless:i!==0});}
 let manuals=0,relayed=0;const t0=Date.now();
 const link=(i,j)=>`l${i}-${j}`;
 for(let j=1;j<n;j++){ // peer j joins via peer 0 with one manual exchange
  await manual(ag[0],ag[j],`p${j}`,{timeout:20000}).then(m=>{if(!m.connected)throw new Error('manual failed '+j);});manuals++;
  // peer ids: on 0 the link is 'p<j>'; on j the link is also 'p<j>'. Register relay route on j to reach 0 as 'p<j>'.
  await ag[j].call('initialSync',{id:`p${j}`});
  for(let i=1;i<j;i++){const id=`r${i}-${j}`;const off=await ag[i].call('offer',{id});
   await ag[i].call('relaySend',{via:`p${i}`,to:`p${j}`,msg:{id,offer:off.desc}});const got=await ag[j].call('relayRecv',{});
   // peer 0 routes SIGNAL by state.peers key, so map to link names
   const ans=await ag[j].call('answer',{id,offer:got.msg.offer});await ag[j].call('relaySend',{via:`p${j}`,to:`p${i}`,msg:{id,answer:ans.desc}});const gotA=await ag[i].call('relayRecv',{});await ag[i].call('accept',{id,answer:gotA.msg.answer});
   const o=await ag[i].call('waitOpen',{id,timeout:20000});if(!o.open)throw new Error('relay link failed');relayed++;}
 }
 r.formMs=Date.now()-t0;r.manualExchanges=manuals;r.relayedLinks=relayed;r.fullMeshLinks=n*(n-1)/2;
 const allLinks=[];for(let j=1;j<n;j++){allLinks.push([0,`p${j}`],[j,`p${j}`]);for(let i=1;i<j;i++)allLinks.push([i,`r${i}-${j}`],[j,`r${i}-${j}`]);}
 for(const [i,id] of allLinks)await ag[i].call('live',{id,forward:false});
 const lats=[];for(let k=0;k<n;k++){const tag=`%E${k}%`;const t=Date.now();await ag[k].call('edit',{text:tag+'\n'});const w=await Promise.all(ag.map((a,i)=>i===k?0:a.call('waitText',{text:tag,timeout:15000}).then(()=>Date.now()-t)));lats.push(Math.max(...w));}
 r.editFanoutMaxMs=lats;const sums=await Promise.all(ag.map(a=>a.call('hash')));r.converged=new Set(sums.map(s=>s.sum)).size===1;r.counts=sums.map(s=>s.fileCount);
 // Concurrent edits on all peers at the same position
 await Promise.all(ag.map((a,i)=>a.call('edit',{text:`%CONC${i}%\n`})));await sleep(1000);const s2=await Promise.all(ag.map(a=>a.call('hash')));r.concurrentConverged=new Set(s2.map(s=>s.sum)).size===1;
 const head=await ag[n-1].call('read',{n:120});r.concurrentHead=head.slice(0,70);
 // Peer 0 leaves; do the others stay connected without it?
 if(n>=3){await ag[0].quit();await sleep(800);const tag='%AFTERLEAVE%';await ag[1].call('edit',{text:tag});const w=await Promise.all(ag.slice(2).map(a=>a.call('waitText',{text:tag,timeout:10000}).then(x=>x,()=>-1)));r.afterHostLeaves=w;}
}catch(e){r.error=String(e).slice(0,500);}out[key]=r;console.log(key,JSON.stringify(r).slice(0,600));await lab.close();}
await mesh(2,['chromium']);await mesh(3,['chromium','firefox']);await mesh(5,['chromium','firefox']);
save('mesh',out);process.exit(0);
