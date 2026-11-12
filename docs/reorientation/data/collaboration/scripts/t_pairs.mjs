import {Lab,save,sleep,manual} from './lab.mjs';
const engines=['chromium','firefox','webkit'];
const out={};const policies=process.argv[2]?process.argv[2].split(','):['open','nomcast','isolated'];
for(const policy of policies)for(const ea of engines)for(const eb of engines){
 if(policy!=='open'&&ea!==eb&&!(ea==='chromium'&&eb==='firefox'))continue;
 const key=`${policy}:${ea}->${eb}`;const lab=new Lab();const r={};
 try{const ha=await lab.host('a'),hb=await lab.host('b');lab.policy(policy==='open'?'open':policy);
  const a=await lab.agent(ha,ea),b=await lab.agent(hb,eb);
  r.versions=[a.info.version,b.info.version];
  r.setupA=await a.call('setup',{me:'a',fixture:'/thesis.json'});await b.call('setup',{me:'b',seedless:true});
  const t0=Date.now();const m=await manual(a,b,'p',{timeout:policy==='isolated'?50000:40000});r.manualMs=Date.now()-t0;Object.assign(r,m);
  if(m.connected){r.pairA=await a.call('pair',{id:'p'});r.pairB=await b.call('pair',{id:'p'});
   await a.call('live',{id:'p'});await b.call('live',{id:'p'});
   r.syncAtoB=await b.call('initialSync',{id:'p'});const[ha1,hb1]=await Promise.all([a.call('hash'),b.call('hash')]);r.converged=ha1.sum===hb1.sum&&ha1.fileCount===hb1.fileCount;r.counts=[ha1.fileCount,hb1.fileCount];
   r.rtt=await a.call('rtt',{id:'p',n:30});
   const lat0=Date.now();await a.call('edit',{text:'% from A\n'});const lm=await b.call('waitText',{text:'% from A'});r.editToPeerApproxMs=Date.now()-lat0;
  }else{r.eventsA=await a.call('events',{id:'p'});r.eventsB=await b.call('events',{id:'p'});}
 }catch(e){r.error=String(e).slice(0,600);}
 out[key]=r;console.log(key,r.error||JSON.stringify({connected:r.connected,sinceApply:r.openA?.sinceApplyMs,pair:r.pairA?.local?.type+'/'+r.pairA?.remote?.type,remoteAddr:r.pairA?.remote?.address,sync:r.syncAtoB&&[r.syncAtoB.ms,r.syncAtoB.rxBytes,r.syncAtoB.updateBytes],conv:r.converged,rtt:r.rtt?.median,edit:r.editToPeerApproxMs,oa:[r.offer?.size?.sdpBytes,r.offer?.size?.base64url,r.answer?.size?.sdpBytes,r.answer?.size?.base64url],lastA:r.eventsA?.events?.slice(-2),max:r.openA?.maxMessage,dtls:r.pairA?.dtls,tls:r.pairA?.tls}));
 await lab.close();save('pairs-partial',out);
}
save('pairs-'+policies.join('_'),out);process.exit(0);
