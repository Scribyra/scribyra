// Fingerprint tamper, MITM visibility and the SAS check. Three separate "laptops"; M performs a full signalling MITM.
import {Lab,save,sleep,manual} from './lab.mjs';const out={};
for(const [ea,eb,em] of [['chromium','chromium','chromium'],['firefox','firefox','firefox'],['chromium','firefox','chromium']]){const key=`${ea}-${eb}`;const r={};const lab=new Lab();try{
 const ha=await lab.host('a'),hb=await lab.host('b'),hm=await lab.host('m');const a=await lab.agent(ha,ea),b=await lab.agent(hb,eb),m=await lab.agent(hm,em);
 for(const [x,n] of [[a,'a'],[b,'b'],[m,'m']])await x.call('setup',{me:n,seedless:true});
 // 1. Tampered fingerprint in offer as received by B
 const t1=await manual(a,b,'t1',{tamperOffer:true,timeout:15000});r.tamperedOffer={connected:t1.connected,a:t1.openA.state,b:t1.openB.state};
 const t2=await manual(a,b,'t2',{tamperAnswer:true,timeout:15000});r.tamperedAnswer={connected:t2.connected,a:t2.openA.state,b:t2.openB.state};
 // 2. Honest
 const hon=await manual(a,b,'h',{timeout:15000});r.honest={connected:hon.connected};const fa=await a.call('localFp',{id:'h'}),fb=await b.call('localFp',{id:'h'});const ra=await a.call('remoteFpSeen',{id:'h'}),rb=await b.call('remoteFpSeen',{id:'h'});
 r.honest.sasA=await a.call('sas',{a:fa,b:ra});r.honest.sasB=await b.call('sas',{a:fb,b:rb});r.honest.match=r.honest.sasA===r.honest.sasB;
 // 3. Signalling MITM: M answers A and offers to B
 const offA=await a.call('offer',{id:'mitm'});const ansM=await m.call('answer',{id:'toA',offer:offA.desc});await a.call('accept',{id:'mitm',answer:ansM.desc});const offM=await m.call('offer',{id:'toB'});const ansB=await b.call('answer',{id:'mitm',offer:offM.desc});await m.call('accept',{id:'toB',answer:ansB.desc});
 const[oa,ob]=await Promise.all([a.call('waitOpen',{id:'mitm',timeout:20000}),b.call('waitOpen',{id:'mitm',timeout:20000})]);r.mitm={aOpen:oa.open,bOpen:ob.open,note:'DTLS succeeds on both sides; each peer is talking to M'};
 const fa2=await a.call('localFp',{id:'mitm'}),ra2=await a.call('remoteFpSeen',{id:'mitm'}),fb2=await b.call('localFp',{id:'mitm'}),rb2=await b.call('remoteFpSeen',{id:'mitm'});r.mitm.sasA=await a.call('sas',{a:fa2,b:ra2});r.mitm.sasB=await b.call('sas',{a:fb2,b:rb2});r.mitm.sasMatch=r.mitm.sasA===r.mitm.sasB;
 r.pair=await a.call('pair',{id:'h'});
 // 4. Application-layer key mismatch is detected at decrypt
 await a.call('setKey',{pass:'key-one'});await b.call('setKey',{pass:'key-two'});await a.call('sendMsgForTamper',{id:'h',payload:{hello:1}});await sleep(500);const ev=await b.call('events',{id:'h'});r.appKeyMismatch=ev.events.filter(e=>e.k.includes('decrypt')).slice(-1)[0]||null;r.helloAccepted=await b.call('remoteHello',{id:'h'});
}catch(e){r.error=String(e).slice(0,400);}out[key]=r;console.log(key,JSON.stringify(r).slice(0,900));await lab.close();}
save('security',out);process.exit(0);
