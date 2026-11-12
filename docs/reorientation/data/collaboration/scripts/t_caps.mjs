import {Lab,save,sleep} from './lab.mjs';
const out={};
for(const engine of ['chromium','firefox','webkit']){const lab=new Lab();const h=await lab.host('a');try{const a=await lab.agent(h,engine);const r={version:a.info.version,caps:await a.call('caps'),curves:await a.call('x25519'),cert:await a.call('certTest'),setup:await a.call('setup',{me:'a',fixture:'/thesis.json'})};
 // candidate gathering by interface condition
 const gather=async(label,id)=>{const o=await a.call('offer',{id});r[label]={gatherMs:o.gatherMs,why:o.gatherWhy,candidates:o.candidates,size:o.size};await a.call('close',{id});};
 await gather('eth_up_default_route','c1');
 h.ns('ip','route','del','default');await sleep(500);await gather('eth_up_no_default_route','c2');
 h.ns('ip','link','set','eth0','down');await sleep(500);await gather('loopback_only','c3');
 h.ns('ip','link','set','lo','down');await sleep(500);await gather('no_interfaces_up','c4');
 out[engine]=r;console.log(engine,JSON.stringify(Object.fromEntries(Object.entries(r).filter(([k])=>/eth|loop|no_/.test(k)).map(([k,v])=>[k,[v.gatherMs,v.why,v.candidates.map(c=>c.type+'/'+c.proto+(c.mdns?'/mdns':''))]]))));console.log(JSON.stringify(r.caps),JSON.stringify(r.curves),JSON.stringify(r.cert));}catch(e){out[engine]={error:String(e)};console.log(engine,'ERR',String(e).slice(0,500));}await lab.close();}
save('caps',out);process.exit(0);
