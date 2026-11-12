// Disconnect/sleep/rejoin. Link-down emulates Wi-Fi loss; SIGSTOP of the browser tree emulates a sleeping laptop. Long-offline reconcile follows.
import {Lab,save,sleep,manual} from './lab.mjs';import {execFileSync} from 'node:child_process';const out={};
const fmt=ev=>ev.events.filter(e=>['conn','ice','dc-close','dc-open'].includes(e.k)).map(e=>`${e.t}:${e.k}=${e.v??''}`).join(' ');
const treePids=root=>{const q=[root],o=[];while(q.length){const p=q.pop();o.push(p);try{for(const c of execFileSync('pgrep',['-P',String(p)]).toString().trim().split('\n'))if(c)q.push(+c);}catch{}}return o;};
async function run(key,{engine,down,method='link'}){const lab=new Lab();const r={engine,down,method};try{const ha=await lab.host('a'),hb=await lab.host('b');const a=await lab.agent(ha,engine),b=await lab.agent(hb,engine);await a.call('setup',{me:'a',fixture:'/thesis.json'});await b.call('setup',{me:'b',seedless:true});const m=await manual(a,b,'p');await b.call('initialSync',{id:'p'});await a.call('live',{id:'p'});await b.call('live',{id:'p'});const base=(await a.call('events',{id:'p'})).events.at(-1).t;
 let pids=[];if(method==='link')hb.ns('ip','link','set','eth0','down');else{pids=treePids(b.proc.pid).filter(p=>p!==b.proc.pid);for(const p of pids)try{process.kill(p,'SIGSTOP');}catch{}}
 const t0=Date.now();
 await sleep(down*1000);
 if(method==='link')hb.ns('ip','link','set','eth0','up');else for(const p of pids)try{process.kill(p,'SIGCONT');}catch{}
 if(method==='link')hb.ns('ip','route','replace','default','via','10.77.0.1');
 await sleep(4000);
 const evA=await a.call('events',{id:'p'}),evB=await b.call('events',{id:'p'});r.a={conn:evA.conn,ice:evA.ice,dc:evA.dc,tl:fmt({events:evA.events.filter(e=>e.t>base)})};r.b={conn:evB.conn,ice:evB.ice,dc:evB.dc,tl:fmt({events:evB.events.filter(e=>e.t>base)})};r.baseT=base;
 let recovered=false;if(evA.dc==='open'&&evB.dc==='open'){try{await a.call('edit',{text:'%RECOVERED%\n'});await b.call('waitText',{text:'%RECOVERED%',timeout:8000});recovered=true;}catch{}}r.recoveredWithoutSignal=recovered;
 if(!recovered){ // Both sides keep editing offline, then a new manual exchange reconciles by state vector
  await a.call('edit',{text:'%OFFLINE-A%\n'});await b.call('edit',{text:'%OFFLINE-B%\n'});
  await a.call('close',{id:'p'});await b.call('close',{id:'p'});
  const m2=await manual(a,b,'p2');r.rejoinConnected=m2.connected;const[sa,sb]=await Promise.all([a.call('initialSync',{id:'p2'}),b.call('initialSync',{id:'p2'})]);await a.call('live',{id:'p2'});await b.call('live',{id:'p2'});const[x,y]=await Promise.all([a.call('hash'),b.call('hash')]);r.rejoin={aRx:sa.rxBytes,bRx:sb.rxBytes,ms:[sa.ms,sb.ms],converged:x.sum===y.sum};r.reconHead=(await a.call('read',{n:40}));}
}catch(e){r.error=String(e).slice(0,400);}out[key]=r;console.log(key,JSON.stringify(r).slice(0,800));await lab.close();save('outage-partial',out);}
for(const engine of ['chromium','firefox']){await run(`${engine} wifi-drop 5s`,{engine,down:5});await run(`${engine} wifi-drop 20s`,{engine,down:20});await run(`${engine} wifi-drop 60s`,{engine,down:60});await run(`${engine} SIGSTOP 60s`,{engine,down:60,method:'stop'});}
save('outage',out);process.exit(0);
