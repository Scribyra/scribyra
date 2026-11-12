// Classic both-sides-send page between two real machines on real Wi-Fi, any browser pairing, via W3C WebDriver.
import {execSync} from 'node:child_process';import {appendFileSync} from 'node:fs';
const out=process.argv[2];const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const M={machine-a:{ssh:'nixos',gecko:9411,chrome:9412,ifc:'wifi-if'},machine-b:{ssh:'machine-b',gecko:9421,chrome:9422,ifc:'wifi-if'}};
const wd=async(base,method,path,body)=>{const r=await fetch(base+path,{method,headers:{'content-type':'application/json'},body:body?JSON.stringify(body):undefined});const j=await r.json();if(j.value&&j.value.error)throw Error(j.value.error+': '+String(j.value.message).slice(0,200));return j.value;};
const open=async(machine,browser)=>{const base=`http://127.0.0.1:${M[machine][browser==='firefox'?'gecko':'chrome']}`;
 const caps=browser==='firefox'?{browserName:'firefox','moz:firefoxOptions':{args:['-headless']}}:{browserName:'chrome','goog:chromeOptions':{args:['--headless=new','--no-sandbox','--disable-gpu']}};
 const v=await wd(base,'POST','/session',{capabilities:{alwaysMatch:caps}});const id=v.sessionId;
 const s=`/session/${id}`,x=(script,...args)=>wd(base,'POST',s+'/execute/sync',{script,args});
 await wd(base,'POST',s+'/url',{url:'http://127.0.0.1:18765/classic.html'});
 return {version:v.capabilities.browserVersion,x,click:i=>x('document.getElementById(arguments[0]).click()',i),fill:(i,t)=>x('document.getElementById(arguments[0]).value=arguments[1]',i,t),val:i=>x('return document.getElementById(arguments[0]).value',i),st:()=>x("return JSON.parse(document.getElementById('st').textContent)"),close:()=>wd(base,'DELETE',s).catch(()=>{})};};
const counters=m=>Object.fromEntries(execSync(`ssh -i $HOME/.ssh/field_test_key -o IdentitiesOnly=yes -o BatchMode=yes <user>@${M[m].ssh}.<mesh> "cat /sys/class/net/${M[m].ifc}/statistics/tx_bytes /sys/class/net/wt0/statistics/tx_bytes"`).toString().trim().split('\n').map((v,i)=>[i?'mesh':'wifi',Number(v)]));
const wait=async(f,ms)=>{for(let t=0;t<ms;t+=500){const v=await f();if(v)return v;await sleep(500);}return null;};
const trial=async(mA,bA,mB,bB,delay)=>{const row={at:new Date().toISOString(),A:mA,bA,B:mB,bB,delay,open:false};let A,B;try{
 A=await open(mA,bA);B=await open(mB,bB);row.vA=A.version;row.vB=B.version;
 await A.click('mk');await wait(()=>A.val('off'),20000);await B.fill('offin',await A.val('off'));await B.click('rep');await wait(()=>B.val('ans'),20000);
 await sleep(delay*1000);await A.fill('ansin',await B.val('ans'));await A.click('acc');
 row.open=!!await wait(async()=>(await A.st()).events.some(e=>e[1]==='channel'&&e[2]==='open'),30000);
 if(row.open){const before=counters(mA);await A.click('bulk');const bulk=await wait(async()=>(await A.st()).bulk,90000);const after=counters(mA);row.bulk=bulk;row.txWifi=after.wifi-before.wifi;row.txMesh=after.mesh-before.mesh;}
 const a=await A.st(),b=await B.st();row.ms=a.connectedMs;row.path=a.path;row.dtls=a.dtls;row.candA=a.localCandidates;row.candB=b.localCandidates;row.evA=a.events.map(e=>e[1]+':'+e[2]).join(' ');row.evB=b.events.map(e=>e[1]+':'+e[2]).join(' ');
}catch(e){row.error=String(e.message).slice(0,200);}finally{await A?.close();await B?.close();}
 appendFileSync(out,JSON.stringify(row)+'\n');console.log(JSON.stringify({delay,A:`${mA}/${bA}`,B:`${mB}/${bB}`,open:row.open,mbps:row.bulk?.mbps,wifiMB:row.txWifi&&Math.round(row.txWifi/1e6),meshMB:row.txMesh!==undefined?Math.round(row.txMesh/1e6):undefined,ms:row.ms,err:row.error}));};
const pairs=[['chrome','chrome'],['firefox','firefox'],['firefox','chrome'],['chrome','firefox']];
if(process.env.SMOKE){await trial("machine-a","firefox","machine-b","chrome",0);process.exit(0);}
for(const delay of process.argv[3].split(',').map(Number))for(const [bA,bB] of pairs)for(const [mA,mB] of [['machine-a','machine-b'],['machine-b','machine-a']])await trial(mA,bA,mB,bB,delay);
