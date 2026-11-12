import {Lab,save,sleep} from './lab.mjs';
const FF={firefoxPrefs:{'media.navigator.streams.fake':true,'media.navigator.permission.disabled':true}};
const CG={args:['--use-fake-ui-for-media-stream','--use-fake-device-for-media-stream'],grantCamera:true};
const camOpt=e=>e==='firefox'?FF:e==='chromium'?CG:{};
const out={};
const pub=['--ip-address-space-overrides=127.0.0.1:5191=public'];
async function run(key,{policy='open',ea,eb,gumA=false,gumB=false,typed=false,optA={},optB={},timeout=30000,probe=false}){
 const lab=new Lab();const r={policy,ea,eb,gumA,gumB,typed};
 try{const ha=await lab.host('a'),hb=await lab.host('b');lab.policy(policy);
  const a=await lab.agent(ha,ea,{...optA,...(gumA?camOpt(ea):{}),args:[...(optA.args||[]),...(gumA&&camOpt(ea).args||[])]}),b=await lab.agent(hb,eb,{...optB,...(gumB?camOpt(eb):{}),args:[...(optB.args||[]),...(gumB&&camOpt(eb).args||[])]});
  await a.call('setup',{me:'a',seedless:true});await b.call('setup',{me:'b',seedless:true});
  if(probe){r.fetchProbeToPeer=await a.call('fetchProbe',{url:'http://'+hb.ip+':5191/index.html'});r.fetchProbeLoopback=await a.call('fetchProbe',{url:'http://127.0.0.1:5191/index.html'});}
  if(gumA)r.gumResultA=await a.call('gumGrant');if(gumB)r.gumResultB=await b.call('gumGrant');
  const off=await a.call('offer',{id:'p'});const ans=await b.call('answer',{id:'p',offer:off.desc});await a.call('accept',{id:'p',answer:ans.desc});
  r.offerCands=off.candidates;r.answerCands=ans.candidates;r.offerSize=off.size;r.answerSize=ans.size;
  if(typed){const c=ans.candidates.find(x=>x.proto==='udp');r.typedAdd=await a.call('addRemoteCandidate',{id:'p',cand:`candidate:9 1 udp 2122260223 ${hb.ip} ${c.port} typ host`});}
  const[oa,ob]=await Promise.all([a.call('waitOpen',{id:'p',timeout}),b.call('waitOpen',{id:'p',timeout})]);r.connected=oa.open&&ob.open;r.sinceApply=oa.sinceApplyMs;r.stateA=oa.state;r.iceA=oa.ice;r.stateB=ob.state;r.iceB=ob.ice;r.eventsA=oa.events;
  if(r.connected)r.pair=await a.call('pair',{id:'p'});
 }catch(e){r.error=String(e).slice(0,400);}
 out[key]=r;console.log(key,r.error||JSON.stringify({conn:r.connected,ms:r.sinceApply,st:[r.stateA,r.iceA,r.stateB,r.iceB],of:r.offerCands?.map(c=>c.addr.slice(0,12)+'/'+c.proto),an:r.answerCands?.map(c=>c.addr.slice(0,12)+'/'+c.proto),pair:r.pair&&(r.pair.local?.type+'/'+r.pair.remote?.type),probe:r.fetchProbeToPeer,lo:r.fetchProbeLoopback,last:r.connected?undefined:r.eventsA?.filter(e=>['conn','ice'].includes(e.k)).map(e=>e.t+':'+e.v).join(' ')}));
 await lab.close();save('nat-partial',out);
}
const which=process.argv[2]||'all';const T=(k,o)=>(which==='all'||k.startsWith(which))?run(k,o):null;
await T('nomcast:ch-ch',{policy:'nomcast',ea:'chromium',eb:'chromium'});
await T('nomcast:ff-ff',{policy:'nomcast',ea:'firefox',eb:'firefox'});
await T('nomcast:ch-ff',{policy:'nomcast',ea:'chromium',eb:'firefox'});
await T('nomcast+gumBoth:ch-ch',{policy:'nomcast',ea:'chromium',eb:'chromium',gumA:true,gumB:true});
await T('nomcast+gumA:ch-ch',{policy:'nomcast',ea:'chromium',eb:'chromium',gumA:true});
await T('nomcast+gumB:ch-ch',{policy:'nomcast',ea:'chromium',eb:'chromium',gumB:true});
await T('nomcast+gumBoth:ff-ff',{policy:'nomcast',ea:'firefox',eb:'firefox',gumA:true,gumB:true});
await T('nomcast+gumA:ch-ff',{policy:'nomcast',ea:'chromium',eb:'firefox',gumA:true});
await T('nomcast+typed:ch-ch',{policy:'nomcast',ea:'chromium',eb:'chromium',typed:true});
await T('nomcast+typed:ff-ff',{policy:'nomcast',ea:'firefox',eb:'firefox',typed:true});
await T('nomcast+typed:ch-ff',{policy:'nomcast',ea:'chromium',eb:'firefox',typed:true});
await T('isolated:ch-ch',{policy:'isolated',ea:'chromium',eb:'chromium',timeout:50000});
await T('isolated:ff-ff',{policy:'isolated',ea:'firefox',eb:'firefox',timeout:50000});
await T('isolated+gumBoth:ch-ch',{policy:'isolated',ea:'chromium',eb:'chromium',gumA:true,gumB:true,timeout:50000});
await T('webkit:ch(gum)->wk',{policy:'open',ea:'chromium',eb:'webkit',gumA:true});
await T('webkit:typed wk->wk',{policy:'open',ea:'webkit',eb:'webkit',typed:true});
await T('lna:public-default',{policy:'open',ea:'chromium',eb:'chromium',optA:{args:pub},optB:{args:pub},probe:true});
await T('lna:public-webrtc-feature',{policy:'open',ea:'chromium',eb:'chromium',optA:{args:[...pub,'--enable-features=LocalNetworkAccessChecks,LocalNetworkAccessChecksWebRTC']},optB:{args:[...pub,'--enable-features=LocalNetworkAccessChecks,LocalNetworkAccessChecksWebRTC']},probe:true});
await T('lna:public-webrtc-notloopbackonly',{policy:'open',ea:'chromium',eb:'chromium',optA:{args:[...pub,'--enable-features=LocalNetworkAccessChecks,LocalNetworkAccessChecksWebRTC:LocalNetworkAccessChecksWebRTCLoopbackOnly/false']},optB:{args:[...pub,'--enable-features=LocalNetworkAccessChecks,LocalNetworkAccessChecksWebRTC:LocalNetworkAccessChecksWebRTCLoopbackOnly/false']},probe:true});
save('nat',out);process.exit(0);
