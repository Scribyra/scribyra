// Large-project transfer with the repo's blob verification. Uses a synthetic 60 MiB incompressible asset alongside the real thesis fixture (project limit 64 MiB).
import {Lab,save,sleep,manual} from './lab.mjs';const out={};
const NETEM=process.env.NOEM?[]:[['wifi-ish 20Mbit/5ms/0.5%loss',['delay','5ms','1ms','loss','0.5%','rate','20mbit']]];
async function run(key,{ea,eb,blob,encrypt,netem,chunk}){const lab=new Lab();const r={ea,eb,blob,encrypt,netem:netem?.[0]||'none',chunk};try{const ha=await lab.host('a'),hb=await lab.host('b');const a=await lab.agent(ha,ea),b=await lab.agent(hb,eb);r.setup=await a.call('setup',{me:'a',fixture:'/thesis.json',blobBytes:blob});await b.call('setup',{me:'b',seedless:true});
 if(netem){ha.ns('tc','qdisc','add','dev','eth0','root','netem',...netem[1]);hb.ns('tc','qdisc','add','dev','eth0','root','netem',...netem[1]);}
 const m=await manual(a,b,'p',{timeout:20000});r.connected=m.connected;if(chunk){await a.call('setChunk',{id:'p',chunk});await b.call('setChunk',{id:'p',chunk});}
 if(encrypt){await a.call('setKey',{pass:'k'});await b.call('setKey',{pass:'k'});}
 r.sync=await b.call('initialSync',{id:'p',timeout:280000});const[x,y]=await Promise.all([a.call('hash'),b.call('hash')]);r.converged=x.sum===y.sum&&x.fileCount===y.fileCount;r.rtt=await a.call('rtt',{id:'p',n:10});
}catch(e){r.error=String(e).slice(0,400);}out[key]=r;console.log(key,JSON.stringify({s:r.sync,c:r.converged,rtt:r.rtt,e:r.error,u:r.setup?.updateBytes}));await lab.close();save('big-partial',out);}
const M=1024*1024;
await run('thesis ch-ch none',{ea:'chromium',eb:'chromium',blob:0});
await run('thesis ch-ff none',{ea:'chromium',eb:'firefox',blob:0});
await run('thesis ff-ch none',{ea:'firefox',eb:'chromium',blob:0});
await run('thesis ch-ch wifi',{ea:'chromium',eb:'chromium',blob:0,netem:NETEM[0]});
await run('thesis ch-ch wifi e2e',{ea:'chromium',eb:'chromium',blob:0,netem:NETEM[0],encrypt:true});
await run('60MiB ch-ch none',{ea:'chromium',eb:'chromium',blob:60*M});
await run('60MiB ch-ch none e2e',{ea:'chromium',eb:'chromium',blob:60*M,encrypt:true});
await run('60MiB ch-ff none',{ea:'chromium',eb:'firefox',blob:60*M});
await run('60MiB ff-ch none',{ea:'firefox',eb:'chromium',blob:60*M});
await run('60MiB ff-ff none',{ea:'firefox',eb:'firefox',blob:60*M});
await run('60MiB ch-ch 64KiB chunks',{ea:'chromium',eb:'chromium',blob:60*M,chunk:64*1024});
await run('60MiB ch-ch wifi',{ea:'chromium',eb:'chromium',blob:60*M,netem:NETEM[0]});
await run('60MiB ch-ch wifi e2e',{ea:'chromium',eb:'chromium',blob:60*M,netem:NETEM[0],encrypt:true});
save('big',out);process.exit(0);
