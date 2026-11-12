import {Lab,save,manual,sleep} from './lab.mjs';import {writeFileSync} from 'node:fs';const out={};
async function pair(key,ea,eb,hostOpt,prep){const lab=new Lab();const r={};try{const ha=await lab.host('a',hostOpt),hb=await lab.host('b',hostOpt);if(prep)prep(ha,hb);const a=await lab.agent(ha,ea),b=await lab.agent(hb,eb);await a.call('setup',{me:'a',seedless:true});await b.call('setup',{me:'b',seedless:true});const m=await manual(a,b,'p',{timeout:15000});r.connected=m.connected;r.offer=m.offer.candidates;r.answer=m.answer.candidates;r.gather=[m.offer.gatherMs,m.answer.gatherMs,m.offer.gatherWhy];r.state=[m.openA.state,m.openB.state];}catch(e){r.error=String(e).slice(0,300);}out[key]=r;console.log(key,JSON.stringify({c:r.connected,g:r.gather,st:r.state,o:r.offer?.map(c=>c.type+(c.mdns?'/mdns':'/'+c.addr)),e:r.error}));await lab.close();}
const dn=(ha,hb)=>{ha.ns('ip','link','set','eth0','down');hb.ns('ip','link','set','eth0','down');};
const CG={args:['--use-fake-ui-for-media-stream','--use-fake-device-for-media-stream'],grantCamera:true};
async function gumPair(key,prep,hostOpt){const lab=new Lab();const r={};try{const ha=await lab.host('a',hostOpt),hb=await lab.host('b',hostOpt);if(prep)prep(ha,hb);const a=await lab.agent(ha,'chromium',CG),b=await lab.agent(hb,'chromium',CG);await a.call('setup',{me:'a',seedless:true});await b.call('setup',{me:'b',seedless:true});await a.call('gumGrant');await b.call('gumGrant');const m=await manual(a,b,'p',{timeout:12000});r.connected=m.connected;r.offer=m.offer.candidates;r.answer=m.answer.candidates;}catch(e){r.error=String(e).slice(0,300);}out[key]=r;console.log(key,JSON.stringify({c:r.connected,o:r.offer?.map(c=>c.addr.slice(0,14)+'/'+c.proto),e:r.error}));await lab.close();}
await pair('LAN no default route ch-ch','chromium','chromium',{defaultRoute:false});
await gumPair('LAN no default route, camera granted, ch-ch',null,{defaultRoute:false});
// Full-tunnel VPN stand-in: default route points at a second interface, the LAN is only a connected subnet
const vpn=(ha,hb)=>{for(const[h,n]of[[ha,1],[hb,2]]){h.ns('ip','link','add','tun0','type','dummy');h.ns('ip','addr','add',`10.99.${n}.2/24`,'dev','tun0');h.ns('ip','link','set','tun0','up');h.ns('ip','route','replace','default','dev','tun0');}};
await pair('default route via VPN-like tun0 ch-ch','chromium','chromium',{},vpn);
await gumPair('default route via VPN-like tun0, camera granted, ch-ch',vpn,{});
await pair('default route via VPN-like tun0 ff-ff','firefox','firefox',{},vpn);
save('noroute',out);process.exit(0);
