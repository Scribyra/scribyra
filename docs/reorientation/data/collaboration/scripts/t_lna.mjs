import {Lab,save} from './lab.mjs';
const pub='--ip-address-space-overrides=127.0.0.1:5191=public';const out={};
async function run(key,args,permissions=[]){const lab=new Lab();const r={args,permissions};try{const ha=await lab.host('a'),hb=await lab.host('b');const a=await lab.agent(ha,'chromium',{args,permissions}),b=await lab.agent(hb,'chromium',{args,permissions});await a.call('setup',{me:'a',seedless:true});await b.call('setup',{me:'b',seedless:true});r.fetch=await a.call('fetchProbe',{url:'http://'+hb.ip+':5191/index.html'});const off=await a.call('offer',{id:'p'});const ans=await b.call('answer',{id:'p',offer:off.desc});await a.call('accept',{id:'p',answer:ans.desc});const[oa,ob]=await Promise.all([a.call('waitOpen',{id:'p',timeout:20000}),b.call('waitOpen',{id:'p',timeout:20000})]);r.connected=oa.open&&ob.open;r.state=[oa.state,oa.ice,ob.state,ob.ice];r.ms=oa.sinceApplyMs;}catch(e){r.error=String(e).slice(0,500);}out[key]=r;console.log(key,JSON.stringify({c:r.connected,ms:r.ms,st:r.state,f:r.fetch,e:r.error}));await lab.close();}
await run('public,default',[pub]);
await run('public,feature',[pub,'--enable-features=LocalNetworkAccessChecks,LocalNetworkAccessChecksWebRTC']);
await run('public,feature,loopbackonly=true',[pub,'--enable-features=LocalNetworkAccessChecks,LocalNetworkAccessChecksWebRTC:LocalNetworkAccessChecksWebRTCLoopbackOnly/true']);
await run('public,feature,granted local-network',[pub,'--enable-features=LocalNetworkAccessChecks,LocalNetworkAccessChecksWebRTC'],['local-network']);
await run('public,feature,granted local-network-access',[pub,'--enable-features=LocalNetworkAccessChecks,LocalNetworkAccessChecksWebRTC'],['local-network-access']);
await run('localpage,feature',['--enable-features=LocalNetworkAccessChecks,LocalNetworkAccessChecksWebRTC']);
await run('privatepage,feature',['--ip-address-space-overrides=127.0.0.1:5191=local','--enable-features=LocalNetworkAccessChecks,LocalNetworkAccessChecksWebRTC']);
save('lna',out);process.exit(0);
