// Drives the field-test page itself between two namespaces, including the typed-address fallback with multicast blocked.
import {createRequire} from 'node:module';import {Lab,sleep} from './lab.mjs';import {spawn} from 'node:child_process';
const lab=new Lab();const ha=await lab.host('a'),hb=await lab.host('b');lab.policy('nomcast');
const here=new URL('.',import.meta.url).pathname;
const child=(h,e)=>spawn('nsenter',['-t',String(h.pid),'-n',process.execPath,here+'t_field_agent.mjs',e],{stdio:['pipe','pipe','inherit'],env:{...process.env,TMPDIR:'/proc/'+tmp.pid+'/cwd',HOME:here+'tmp'}});
const tmp=spawn('sleep',['infinity'],{cwd:here+'tmp',stdio:'ignore'});
const rpc=c=>{const pend=[];let buf='';c.stdout.on('data',d=>{buf+=d;let i;while((i=buf.indexOf('\n'))>=0){const l=buf.slice(0,i);buf=buf.slice(i+1);pend.shift()?.(l);}});return(cmd)=>new Promise(r=>{pend.push(r);c.stdin.write(JSON.stringify(cmd)+'\n');});};
const A=rpc(child(ha,'chromium')),B=rpc(child(hb,'firefox'));
await A({op:'ready'});await B({op:'ready'});
const off=JSON.parse(await A({op:'click',id:'mk',read:'off'}));await B({op:'fill',id:'offin',value:off});const ans=JSON.parse(await B({op:'click',id:'rep',read:'ans'}));await A({op:'fill',id:'ansin',value:ans});await A({op:'click',id:'acc'});await sleep(3000);
await A({op:'fill',id:'ip',value:hb.ip});await A({op:'click',id:'typed'});await sleep(3000);await A({op:'click',id:'bulk'});await sleep(8000);
const ra=JSON.parse(JSON.parse(await A({op:'state'})));const rb=JSON.parse(JSON.parse(await B({op:'state'})));
console.log('A',JSON.stringify({ms:ra.connectedMs,path:ra.path,dtls:ra.dtls,rtt:ra.rtt,bulk:ra.bulk,typed:ra.typedFallback,cands:ra.localCandidates}));console.log('B',JSON.stringify({ms:rb.connectedMs,path:rb.path,bulkRx:rb.bulkRx}));
await A({op:'quit'}).catch(()=>{});await B({op:'quit'}).catch(()=>{});tmp.kill();await lab.close();process.exit(0);
