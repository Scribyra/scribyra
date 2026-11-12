// Network lab inside an unprivileged user+net namespace. Each "laptop" is a separate netns on a Linux bridge.
import {spawn,execFileSync} from 'node:child_process';import readline from 'node:readline';import {writeFileSync,mkdirSync,readFileSync} from 'node:fs';
export const HERE=new URL('.',import.meta.url).pathname;
const sh=(...a)=>execFileSync(a[0],a.slice(1),{stdio:['ignore','pipe','pipe']}).toString();
export const sleep=ms=>new Promise(r=>setTimeout(r,ms));
let idx=0;
const webkitEnv={};for(const l of readFileSync(HERE+'webkit-env.sh','utf8').split('\n')){const m=/^export (\w+)=(.*)$/.exec(l);if(m)webkitEnv[m[1]]=m[2];}
// Chromium's singleton socket path must stay short, so TMPDIR is a /proc symlink to the scratch directory. Holder lives in this user namespace.
const tmpHolder=spawn('sleep',['infinity'],{cwd:HERE+'tmp',stdio:'ignore'});process.on('exit',()=>tmpHolder.kill('SIGKILL'));const TMP='/proc/'+tmpHolder.pid+'/cwd';
export class Lab{
 constructor(){this.hosts=[];this.br='br'+(idx++);sh('ip','link','add',this.br,'type','bridge','mcast_snooping','0');sh('ip','link','set',this.br,'up');try{sh('ip','addr','add','10.77.0.1/24','dev',this.br);}catch{}}
 async host(name,{addr=true,defaultRoute=true}={}){
  const holder=spawn('unshare',['-n','sleep','infinity'],{stdio:'ignore'});await sleep(120);
  // holder is the unshare-exec'd sleep
  const pid=holder.pid,veth=`v${this.br}${this.hosts.length}`;
  sh('ip','link','add',veth,'type','veth','peer','name','eth0','netns',String(pid));sh('ip','link','set',veth,'master',this.br);sh('ip','link','set',veth,'up');
  const ns=(...a)=>sh('nsenter','-t',String(pid),'-n',...a);ns('ip','link','set','lo','up');ns('ip','link','set','eth0','up');
  const ip=`10.77.0.${10+this.hosts.length}`;if(addr)ns('ip','addr','add',ip+'/24','dev','eth0');if(addr&&defaultRoute)ns('ip','route','add','default','via','10.77.0.1');
  const h={name,pid,veth,ip,ns,holder,agents:[]};this.hosts.push(h);return h;}
 policy(p){for(const h of this.hosts){if(p==='open'){sh('bridge','link','set','dev',h.veth,'isolated','off','mcast_flood','on');}
   if(p==='isolated')sh('bridge','link','set','dev',h.veth,'isolated','on');
   if(p==='nomcast')sh('bridge','link','set','dev',h.veth,'mcast_flood','off');}}
 async agent(h,engine,opt={}){const c=spawn('nsenter',['-t',String(h.pid),'-n',process.execPath,HERE+'agent.mjs',engine,JSON.stringify(opt)],{stdio:['pipe','pipe','pipe'],env:{...process.env,...(engine==='webkit'?webkitEnv:{}),TMPDIR:TMP,HOME:HERE+'tmp'}});
  const rl=readline.createInterface({input:c.stdout});let next=1;const wait=new Map();let ready;const r=new Promise((res,rej)=>{ready=res;setTimeout(()=>rej(new Error('agent start timeout '+engine+' '+err.slice(-400))),90000);});let err='';c.stderr.on('data',d=>{err+=d;if(err.length>4000)err=err.slice(-4000);});
  rl.on('line',l=>{let m;try{m=JSON.parse(l);}catch{return;}if(m.ready){ready(m);return;}const w=wait.get(m.id);if(w){wait.delete(m.id);m.error?w.rej(new Error(m.error)):w.res(m.result);}});
  c.on('exit',code=>{for(const w of wait.values())w.rej(new Error('agent exit '+code+' '+err.slice(-300)));wait.clear();});
  const a={engine,host:h,proc:c,info:await r,call:(fn,arg)=>new Promise((res,rej)=>{const id=next++;wait.set(id,{res,rej});c.stdin.write(JSON.stringify({id,fn,arg})+'\n');}),quit:async()=>{try{await Promise.race([a.call('__quit'),sleep(5000)]);}catch{}c.kill();}};h.agents.push(a);return a;}
 async close(){for(const h of this.hosts){for(const a of h.agents)await a.quit();h.holder.kill('SIGKILL');}try{sh('ip','link','del',this.br);}catch{}}
}
export const results={};
export function save(name,o){mkdirSync(HERE+'results',{recursive:true});writeFileSync(HERE+'results/'+name+'.json',JSON.stringify(o,null,1));console.log('saved',name);}
// Manual offer/answer between two agents; returns timings. The blobs travel only as orchestrator strings: a stand-in for paste/QR.
export async function manual(a,b,id,opts={}){const offer=await a.call('offer',{id,iceServers:opts.iceServers,usePinned:opts.pinned});const ans=await b.call('answer',{id,offer:offer.desc,iceServers:opts.iceServers,usePinned:opts.pinned,tamperFp:opts.tamperOffer});await a.call('accept',{id,answer:ans.desc,tamperFp:opts.tamperAnswer});const timeout=opts.timeout??45000;const[oa,ob]=await Promise.all([a.call('waitOpen',{id,timeout}),b.call('waitOpen',{id,timeout})]);return{offer:strip(offer),answer:strip(ans),openA:oa,openB:ob,connected:oa.open&&ob.open};}
const strip=({desc,...r})=>r;
