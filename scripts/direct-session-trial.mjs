// Real session between two machines, driven from a third over SSH. See --help.
// Runs the real production app and the real connection service on this machine;
// each browser reaches them at 127.0.0.1 through an SSH reverse tunnel, so only the
// WebRTC traffic between the browsers crosses the network under test.
import {spawn,execFile} from 'node:child_process';
import {createServer} from 'node:http';
import {randomBytes,createHash} from 'node:crypto';
import {appendFile,mkdir,mkdtemp,readFile,rm,stat,writeFile} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {tmpdir,homedir} from 'node:os';
import {dirname,extname,join,normalize,resolve,sep} from 'node:path';
import {pathToFileURL} from 'node:url';

const HELP=`Usage: nix develop -c node scripts/direct-session-trial.mjs --mode=smoke --a=HOST --b=HOST [options]

Runs real browsers on HOST A and HOST B through the real app and a real connection
service on this machine, using browsers already in each machine's Nix store. Two
people edit, comment and suggest concurrently, then the replicas must converge.
Records Wi-Fi and mesh bytes per phase. Nothing is installed, deployed or left behind.
Reports contain no source, invites, comparison codes, addresses or capabilities.

Modes
  smoke   One Firefox-starts, Chromium-joins session: connect, one edit round, converge.
  mixed   Firefox and Chromium in both start orders and both machine directions, with
          bulk transfer and rejoin. Fails if Firefox offers to Chromium: the chosen fix
          for the measured 6-of-8 Firefox-to-Chromium failures.
  full    Chromium pair and Firefox pair, then everything in mixed.

Options
  --a=HOST --b=HOST      SSH hosts, or SCRIBYRA_TRIAL_HOST_A and SCRIBYRA_TRIAL_HOST_B
  --user=NAME            SSH user, or SCRIBYRA_TRIAL_USER (default: your SSH config)
  --key=PATH             SSH key, or SCRIBYRA_TRIAL_KEY (default: your SSH config)
  --a-ifc=NAME --b-ifc=NAME  Wi-Fi interface (default: the first wl* on that machine)
  --mesh-ifc=NAME        Mesh interface (default wt0)
  --rounds=N             Concurrent edit rounds per session (smoke 1, otherwise 3)
  --reps=N               Repetitions of each pairing (default 1)
  --bulk-kib=N           Text sent over the session to measure bytes (smoke 0, otherwise 2048)
  --firefox-pkg= --gecko-pkg= --chromium-pkg= --chromedriver-pkg=
                         Nix store names (defaults: firefox-159.0.1, geckodriver-0.37.1,
                         chromium-156.0.8078.79, chromedriver-unwrapped-156.0.8078.79)
  --output=PATH          JSONL report (default tmp/direct/trial-<mode>.jsonl)
  --dist=PATH            Production build (default dist; run npm run build first)
  --service-binary=PATH  Connection service (default target/release or target/debug
                         scribyra-sync; build with cargo build -p scribyra-sync)
  --dry-run              Print the SSH commands and plan, connect to nothing
  --local-gecko=PORT --local-chrome=PORT
                         With --a=local --b=local: use WebDriver servers on this machine,
                         without SSH. For checking this script; proves nothing about a network.

Exit status: 0 only if every session converged and every rule held.
A failed connection is recorded, not diagnosed: it is not proof of network isolation.`;

export const APP_PORT=18765,SERVICE_PORT=18787;
const ELEMENT='element-6066-11e4-a52e-4f735466cecf';
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const shellQuote=value=>`'${String(value).replaceAll("'","'\\''")}'`;

// ---- SSH ---------------------------------------------------------------------
export function sshOptions(config){
 return[...(config.key?['-i',config.key,'-o','IdentitiesOnly=yes']:[]),'-o','BatchMode=yes','-o','ConnectTimeout=15'];
}
const destination=(machine,config)=>config.user?`${config.user}@${machine.host}`:machine.host;
// The drivers die with the tunnel: closing stdin ends cat, then only these PIDs are killed.
export function remoteScript(machine,config){
 const packages=[config.firefoxPkg,config.geckoPkg,config.chromiumPkg,config.chromedriverPkg].map(shellQuote);
 return[
  `f() { ls -d /nix/store/*-"$1" 2>/dev/null | grep -v '\\.drv$' | head -1; }`,
  `missing=; for p in ${packages.join(' ')}; do [ -n "$(f "$p")" ] || missing="$missing $p"; done`,
  `if [ -n "$missing" ]; then echo "not in this machine's Nix store:$missing" >&2; exit 3; fi`,
  `PATH="$(f ${packages[0]})/bin:$(f ${packages[1]})/bin:$(f ${packages[2]})/bin:$(f ${packages[3]})/bin:$PATH"; export PATH`,
  `geckodriver --port ${machine.gecko} --log fatal --allow-hosts 127.0.0.1 & g=$!`,
  `chromedriver --port=${machine.chrome} --silent & c=$!`,
  `cat >/dev/null; kill "$g" "$c" 2>/dev/null; wait`,
 ].join('\n');
}
export function tunnelArguments(machine,config,appPort,servicePort){
 return[...sshOptions(config),'-T','-o','ExitOnForwardFailure=yes','-o','ServerAliveInterval=30',
  '-L',`${machine.gecko}:127.0.0.1:${machine.gecko}`,'-L',`${machine.chrome}:127.0.0.1:${machine.chrome}`,
  '-R',`${APP_PORT}:127.0.0.1:${appPort}`,'-R',`${SERVICE_PORT}:127.0.0.1:${servicePort}`,
  destination(machine,config),remoteScript(machine,config)];
}
function remoteOutput(machine,config,command){
 const local=machine.host==='local';
 return new Promise((resolve,reject)=>execFile(local?'sh':'ssh',local?['-c',command]:[...sshOptions(config),destination(machine,config),command],{timeout:30000},(error,stdout)=>error?reject(error):resolve(stdout)));
}
async function wifiInterface(machine,config){
 if(machine.ifc)return machine.ifc;
 const names=(await remoteOutput(machine,config,'ls /sys/class/net')).split(/\s+/);
 return names.find(name=>/^wl/.test(name))||null;
}
async function counters(machine,config){
 const names=[machine.ifc,config.meshIfc],read=await Promise.all(names.map(name=>name?remoteOutput(machine,config,`cat /sys/class/net/${name}/statistics/tx_bytes /sys/class/net/${name}/statistics/rx_bytes 2>/dev/null || echo 0 0`).catch(()=>'0 0'):'0 0'));
 const pair=text=>{const [tx,rx]=text.trim().split(/\s+/).map(Number);return{tx,rx};};
 return{wifi:pair(read[0]),mesh:pair(read[1])};
}
const delta=(before,after)=>({wifiTx:after.wifi.tx-before.wifi.tx,wifiRx:after.wifi.rx-before.wifi.rx,meshTx:after.mesh.tx-before.mesh.tx,meshRx:after.mesh.rx-before.mesh.rx});

// ---- Local app and service ----------------------------------------------------
const TYPES={'.html':'text/html','.js':'text/javascript','.mjs':'text/javascript','.css':'text/css','.wasm':'application/wasm','.json':'application/json','.svg':'image/svg+xml','.md':'text/markdown','.woff2':'font/woff2','.gz':'application/gzip','.data':'application/octet-stream'};
// No service worker: its 300 MiB precache would cross the mesh mid-measurement.
export function serveApp(dist,port){
 const root=resolve(dist),server=createServer(async(request,response)=>{
  try{
   const path=decodeURIComponent(new URL(request.url,'http://x').pathname);
   if(path==='/sw.js'){response.writeHead(404).end();return;}
   const file=normalize(join(root,path==='/'?'index.html':path));
   if(file!==root&&!file.startsWith(root+sep))throw Error();
   if(!(await stat(file)).isFile())throw Error();
   response.writeHead(200,{'content-type':TYPES[extname(file)]||'application/octet-stream','cache-control':'no-store'}).end(await readFile(file));
  }catch{response.writeHead(404).end();}
 });
 return new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',()=>resolve({port:server.address().port,close:()=>new Promise(done=>{server.closeAllConnections();server.close(done);})}));});
}
export async function startService(binary,port){
 // One relay-only capability per person, as in production. Neither is logged or reported.
 const bearers=[randomBytes(32).toString('hex'),randomBytes(32).toString('hex')],namespace=randomBytes(32).toString('hex'),directory=await mkdtemp(join(tmpdir(),'scribyra-trial-'));
 const config={bind:`127.0.0.1:${port}`,data:join(directory,'data'),origins:[`http://127.0.0.1:${APP_PORT}`],principals:bearers.map(bearer=>({token_hash:createHash('sha256').update(bearer).digest('hex'),namespace,storage:false,relay:true}))};
 await writeFile(join(directory,'config.json'),JSON.stringify(config),{mode:0o600});
 const child=spawn(binary,[],{env:{...process.env,SCRIBYRA_SERVICE_CONFIG:join(directory,'config.json')},stdio:['ignore','pipe','ignore']});
 const actual=await new Promise((resolve,reject)=>{
  const timer=setTimeout(()=>reject(Error('Connection service did not start.')),15000);
  child.once('exit',code=>{clearTimeout(timer);reject(Error(`Connection service exited ${code}.`));});
  child.stdout.on('data',bytes=>{for(const line of String(bytes).split('\n')){try{const value=JSON.parse(line);if(value.event==='listening'){clearTimeout(timer);resolve(Number(value.address.split(':').pop()));}}catch{}}});
 });
 return{port:actual,bearers,async close(){if(child.exitCode===null&&child.signalCode===null){const done=new Promise(resolve=>child.once('exit',resolve));child.kill('SIGTERM');await done;}await rm(directory,{recursive:true,force:true});}};
}

// ---- WebDriver, in the page's own realm ---------------------------------------
async function driver(base,method,path,body){
 const response=await fetch(base+path,{method,headers:{'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});
 const value=(await response.json()).value;
 if(value?.error)throw Error(`${value.error}: ${String(value.message).slice(0,240)}`);
 return value;
}
// Firefox's WebDriver sandbox hides page globals and broke binary handling in the earlier
// trial, so everything runs as a script the page itself loads. Results return as attributes.
function inPage(code,args,id){
 return `(async()=>{const name=${JSON.stringify('data-trial-'+id)},write=value=>document.documentElement.setAttribute(name,JSON.stringify(value));try{write({value:await (${code})(...${JSON.stringify(args)})??null});}catch(error){write({error:String(error?.message||error).slice(0,400)});}})();`;
}
async function openBrowser(machine,browser,config){
 const base=`http://127.0.0.1:${browser==='firefox'?machine.gecko:machine.chrome}`;
 const capabilities=browser==='firefox'?{browserName:'firefox','moz:firefoxOptions':{args:['-headless']}}:{browserName:'chrome','goog:chromeOptions':{args:['--headless=new','--no-sandbox','--disable-gpu']}};
 const created=await driver(base,'POST','/session',{capabilities:{alwaysMatch:capabilities}}),session=`/session/${created.sessionId}`;
 let sequence=0;
 const raw=(script,args=[])=>driver(base,'POST',`${session}/execute/sync`,{script,args});
 const page={
  browser,version:created.capabilities?.browserVersion||'unknown',
  async run(code,args=[],timeoutMs=60000){
   const id=++sequence,name='data-trial-'+id;
   await raw(`const script=document.createElement('script');script.textContent=arguments[0];document.head.append(script);script.remove();`,[inPage(code,args,id)]);
   const deadline=Date.now()+timeoutMs;
   for(let wait=25;Date.now()<deadline;wait=Math.min(wait*2,400)){
    const result=await raw(`const value=document.documentElement.getAttribute(arguments[0]);if(value!==null)document.documentElement.removeAttribute(arguments[0]);return value;`,[name]);
    if(result!==null){const parsed=JSON.parse(result);if(parsed.error)throw Error(parsed.error);return parsed.value;}
    await sleep(wait);
   }
   throw Error(`Page script timed out after ${timeoutMs} ms.`);
  },
  async type(selector,text){const element=await driver(base,'POST',`${session}/element`,{using:'css selector',value:selector});await driver(base,'POST',`${session}/element/${element[ELEMENT]}/value`,{text});},
  async close(){await driver(base,'DELETE',session).catch(()=>{});},
 };
 await driver(base,'POST',`${session}/permissions`,{descriptor:{name:'local-network-access'},state:'granted'}).catch(()=>{});
 await driver(base,'POST',`${session}/window/rect`,{width:1366,height:900}).catch(()=>{});
 await driver(base,'POST',`${session}/url`,{url:`http://127.0.0.1:${APP_PORT}/`});
 return page;
}
// The trial's hands: everything below clicks and types into the real interface.
const HELPER=`()=>{
 const wanted=(selector,test)=>[...document.querySelectorAll(selector)].find(test);
 window.trial={
  rtc:[],
  until(check,timeoutMs,label){return new Promise((resolve,reject)=>{const deadline=Date.now()+timeoutMs;const poll=async()=>{let value;try{value=await check();}catch{}if(value){resolve(value);return;}if(Date.now()>deadline){reject(Error(label+' not reached. Status: '+(trial.status()||'none')));return;}setTimeout(poll,100);};poll();});},
  button(name){const found=wanted('button',b=>b.textContent.trim()===name||b.getAttribute('aria-label')===name);if(!found)throw Error('No button: '+name);if(found.disabled)throw Error('Button disabled: '+name+'. Status: '+trial.status());found.click();},
  fill(label,value){const input=wanted('input',i=>i.getAttribute('aria-label')===label);if(!input)throw Error('No field: '+label);input.value=value;input.dispatchEvent(new Event('input',{bubbles:true}));},
  status(){return document.querySelector('[aria-label="Direct session status"]')?.textContent||'';},
  share(){if(!document.querySelector('.direct-share'))return window.scribyra.action('direct-share','');},
  peers(){return[...document.querySelectorAll('.direct-peer')].map(row=>({status:row.querySelector('.direct-help')?.textContent||'',code:row.querySelector('.direct-code')?.textContent||'',offerer:row.dataset.offerer==='true',elapsedMs:Number(row.dataset.elapsedMs)||null}));},
  async execute(command){
   const api=window.scribyra.agent;let last;
   for(let attempt=0;attempt<40;attempt++){
    last=await api.execute({version:2,requestId:crypto.randomUUID(),projectId:api.describe().projectId,expectedRevision:api.status().revision,command});
    if(last.ok)return last.value;
    if(last.error?.code!=='revision_conflict'&&last.error?.code!=='decision_conflict')break;
    await new Promise(resolve=>setTimeout(resolve,50+Math.random()*150));
   }
   throw Error(command.op+': '+(last?.error?.code||'failed'));
  },
  async source(){
   const api=window.scribyra.agent,parts=[];let line=1,total=1;
   do{let offset;do{const page=api.readSource({path:'main.tex',startLine:line,endLine:line+199,...(offset===undefined?{}:{offset})}).value;parts.push(page.content);total=page.totalLines;offset=page.nextOffset??undefined;if(offset===undefined&&line+199<total)parts.push('\\n');}while(offset!==undefined);line+=200;}while(line<=total);
   return parts.join('');
  },
  async snapshot(){
   const source=await trial.source(),bytes=new TextEncoder().encode(source),hash=[...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(b=>b.toString(16).padStart(2,'0')).join('');
   const threads=(await trial.execute({op:'thread.list',limit:100})).items.map(t=>t.id+':'+t.status).sort(),reviews=(await trial.execute({op:'review.list',limit:100})).items,suggestions=[];
   for(const review of reviews)for(const item of (await trial.execute({op:'review.get',id:review.id,limit:100})).items)if(item.kind==='suggestion')suggestions.push(item.id+':'+item.status);
   return{hash,bytes:bytes.length,threads,reviews:reviews.map(r=>r.id).sort(),suggestions:suggestions.sort()};
  },
  async has(markers){const source=await trial.source();return markers.filter(marker=>!source.includes(marker));},
  async transportStats(){
   const links=[];
   for(const pc of trial.rtc){if(pc.connectionState!=='connected')continue;const stats=await pc.getStats();let pair;stats.forEach(row=>{if(row.type==='candidate-pair'&&(row.nominated||row.selected)&&row.state==='succeeded')pair=row;});if(!pair)continue;const local=stats.get(pair.localCandidateId),remote=stats.get(pair.remoteCandidateId);links.push({localType:local?.candidateType||null,remoteType:remote?.candidateType||null,protocol:local?.protocol||null,bytesSent:pair.bytesSent??null,bytesReceived:pair.bytesReceived??null,rttMs:pair.currentRoundTripTime===undefined?null:Math.round(pair.currentRoundTripTime*1000)});}
   return links;
  },
 };
 const Original=window.RTCPeerConnection;
 window.RTCPeerConnection=new Proxy(Original,{construct(target,args,next){const pc=Reflect.construct(target,args,next);trial.rtc.push(pc);return pc;}});
}`;

// ---- One session --------------------------------------------------------------
export async function runSession({config,machines,browsers,service,mode,bulkKiB,rounds,rejoin}){
 const row={at:new Date().toISOString(),mode,a:{host:machines[0].host,browser:browsers[0]},b:{host:machines[1].host,browser:browsers[1]},ok:false,steps:[],bytes:{},rules:{}};
 const pages=[];let lastStep='open';
 const step=async(name,run)=>{lastStep=name;const started=Date.now();const value=await run();row.steps.push({name,ms:Date.now()-started});console.log(`  ${name} ${Date.now()-started} ms`);return value;};
 const both=run=>Promise.all(pages.map((page,index)=>run(page,index)));
 const measure=async(phase,run)=>{
  const before=await Promise.all(machines.map(machine=>counters(machine,config)));
  const value=await run();
  const after=await Promise.all(machines.map(machine=>counters(machine,config)));
  row.bytes[phase]={a:delta(before[0],after[0]),b:delta(before[1],after[1])};return value;
 };
 const converged=label=>step('converge '+label,async()=>{
  const deadline=Date.now()+Math.max(90000,bulkKiB*200);let values;
  while(Date.now()<deadline){values=await both(page=>page.run(`()=>trial.snapshot()`,[],120000));if(JSON.stringify(values[0])===JSON.stringify(values[1]))return values[0];await sleep(1000);}
  throw Error(`Replicas did not converge: ${values.map(v=>v.bytes).join(' vs ')} source bytes.`);
 });
 const verifyCodes=phase=>measure(phase,async()=>{
  await both(page=>page.run(`()=>trial.share()`));
  await step('codes shown',()=>both(page=>page.run(`()=>trial.until(()=>trial.peers().some(p=>p.code&&p.status==='Compare code'),45000,'Comparison code')`,[],50000)));
  const seen=await both(page=>page.run(`()=>trial.peers().map(p=>p.code)`));
  row.rules.codesMatch=seen[0][0]===seen[1][0];if(!row.rules.codesMatch)throw Error('Comparison codes differ: this session is not trustworthy.');
  await both(page=>page.run(`()=>trial.button('Codes match')`));
  await step('connected',()=>both(page=>page.run(`()=>trial.until(()=>trial.peers().some(p=>p.status==='Connected'),30000,'Connected')`,[],35000)));
 });
 const markers=[];
 const editRound=round=>both(async(page,index)=>{
  const who=index?'b':'a',typed=`% typed ${who} ${round}`,patched=`% patched ${who} ${round}`;markers.push(typed,patched);
  await page.run(`()=>{document.querySelector('[aria-label="Close sharing"]')?.click();}`);
  await page.type('.cm-content',typed+'\uE007');
  await page.run(`async(patched,who,round)=>{
   const tree=window.scribyra.agent.readTree().value.items.find(f=>f.path==='main.tex'),fileId=tree.id;
   await trial.execute({op:'agent.patchSource',edits:[{fileId,start:0,end:0,before:'',after:patched+'\\n'}]});
   await trial.execute({op:'thread.create',fileId,start:0,end:0,body:'Trial comment '+who+' '+round});
   const review=await trial.execute({op:'review.create',title:'Trial review '+who+' '+round});
   await trial.execute({op:'suggestion.propose',reviewId:review.reviewId,fileId,start:0,end:0,before:'',after:'% proposed '+who+' '+round+'\\n'});
  }`,[patched,who,round],120000);
 });
 try{
  pages.push(...await step('open browsers',()=>Promise.all(browsers.map((browser,index)=>openBrowser(machines[index],browser,config)))));
  row.a.version=pages[0].version;row.b.version=pages[1].version;
  await both(page=>page.run(HELPER));
  await step('open app',()=>both(page=>page.run(`async()=>{await trial.until(()=>[...document.querySelectorAll('button')].some(b=>b.textContent.trim()==='Start with a sample paper'),60000,'App');trial.button('Start with a sample paper');await trial.until(()=>document.querySelector('.cm-content')&&window.scribyra.agent,60000,'Editor');}`,[],130000)));
  await step('configure Share',()=>both((page,index)=>page.run(`async(endpoint,bearer,name)=>{await trial.share();await trial.until(()=>document.querySelector('.direct-share'),5000,'Share');const box=document.querySelector('[aria-label="Experimental direct browser sessions"]');if(!box.checked)box.click();await trial.until(()=>{const on=document.querySelector('[aria-label="Experimental direct browser sessions"]');return on?.checked&&!on.disabled&&!document.querySelector('[aria-label="Connection service"]')?.disabled;},20000,'Direct sessions on');trial.fill('Connection service',endpoint);trial.fill('Relay capability',bearer);trial.fill('Your name',name);}`,[`http://127.0.0.1:${SERVICE_PORT}`,service.bearers[index],index?'Person B':'Person A'])));
  await step('start session',()=>pages[0].run(`async()=>{trial.button('Start session');await trial.until(()=>document.querySelector('[aria-label="Invite link"]').value,20000,'Invite');}`,[],25000));
  // The invite goes from the page straight back to the other page. It is never kept or logged.
  const invite=await pages[0].run(`()=>document.querySelector('[aria-label="Invite link"]').value`);
  const joined=Date.now();
  await pages[1].run(`(invite)=>{trial.fill('Invite link',invite);trial.button('Join invite');}`,[invite]);
  await verifyCodes('connect');row.connectMs=Date.now()-joined;
  const links=await both(page=>page.run(`()=>trial.peers()`));
  row.links=links.map(([peer])=>({offerer:peer.offerer,elapsedMs:peer.elapsedMs}));
  if(browsers[0]!==browsers[1]){
   const chromium=browsers.indexOf('chromium'),firefox=browsers.indexOf('firefox');
   row.rules.chromiumOffers=row.links[chromium].offerer===true&&row.links[firefox].offerer===false;
   if(!row.rules.chromiumOffers)throw Error('Firefox offered to Chromium: the chosen fix did not apply.');
  }else row.rules.oneOfferer=row.links[0].offerer!==row.links[1].offerer;
  await measure('edits',async()=>{
   for(let round=1;round<=rounds;round++)await step(`concurrent round ${round}`,()=>editRound(round));
   row.converged=await converged('edits');
  });
  const missing=await both(page=>page.run(`(markers)=>trial.has(markers)`,[markers]));
  row.rules.noLostEdits=missing.every(list=>!list.length);if(!row.rules.noLostEdits)throw Error(`Edits lost: ${missing.map(list=>list.length).join(' and ')} markers.`);
  row.rules.commentsAndSuggestions=row.converged.threads.length===rounds*2&&row.converged.suggestions.length===rounds*2;
  if(!row.rules.commentsAndSuggestions)throw Error('Comments or suggestions did not all arrive.');
  await step('authority request',async()=>{
   // Person B asks Person A to accept A's fresh proposal; only A's signed decision may change it.
   const id=await pages[0].run(`async()=>{const fileId=window.scribyra.agent.readTree().value.items.find(f=>f.path==='main.tex').id,review=await trial.execute({op:'review.create',title:'Trial authority request'}),proposal=await trial.execute({op:'suggestion.propose',reviewId:review.reviewId,fileId,start:0,end:0,before:'',after:'% approved by authority\\n'});return proposal.suggestionId;}`);
   await pages[1].run(`async(id)=>{await trial.until(async()=>(await trial.snapshot()).suggestions.some(s=>s.startsWith(id)),30000,'Proposal');await trial.share();await window.scribyra.action('suggestion.accept',id);await trial.until(()=>trial.status().includes('Waiting for acceptance authority'),15000,'Waiting message');}`,[id],60000);
   await pages[0].run(`async()=>{await trial.share();await trial.until(()=>[...document.querySelectorAll('button')].some(b=>b.textContent==='Approve request'),20000,'Request');trial.button('Approve request');await trial.until(()=>trial.status().includes('Authority decision saved locally'),20000,'Decision');}`,[],45000);
   await both(page=>page.run(`(id)=>trial.until(async()=>(await trial.snapshot()).suggestions.includes(id+':accepted'),30000,'Accepted decision')`,[id],60000));
   row.rules.authorityDecision=true;
  });
  if(bulkKiB){
   const expected=bulkKiB*1024;
   await measure('bulk',async()=>{
    await step('bulk text',()=>pages[0].run(`async(kib)=>{const fileId=window.scribyra.agent.readTree().value.items.find(f=>f.path==='main.tex').id,line='% '+'bulk trial padding '.repeat(4)+'\\n',chunk=line.repeat(Math.ceil(65536/line.length));let sent=0;while(sent<kib*1024){await trial.execute({op:'agent.patchSource',edits:[{fileId,start:0,end:0,before:'',after:chunk}]});sent+=chunk.length;}}`,[bulkKiB],300000));
    await converged('bulk');
   });
   const sent=row.bytes.bulk.a;
   row.rules.bulkCrossedWifi=machines[0].ifc?sent.wifiTx>=expected:null;
   row.rules.bulkAvoidedMesh=sent.meshTx<expected/4;
  }
  row.transport=await both(page=>page.run(`()=>trial.transportStats()`));
  row.rules.directHostLink=row.transport.flat().every(link=>link.localType!=='relay'&&link.remoteType!=='relay');
  if(rejoin){
   await step('leave and work offline',async()=>{
    await pages[1].run(`async()=>{await trial.share();trial.button('Leave session');await trial.until(()=>trial.status().includes('Left session'),10000,'Leave');}`);
    await both(async(page,index)=>{const marker=`% offline ${index?'b':'a'}`;markers.push(marker);await page.run(`async(marker)=>{const fileId=window.scribyra.agent.readTree().value.items.find(f=>f.path==='main.tex').id;await trial.execute({op:'agent.patchSource',edits:[{fileId,start:0,end:0,before:'',after:marker+'\\n'}]});}`,[marker]);});
   });
   await step('rejoin',()=>pages[1].run(`async()=>{await trial.share();trial.button('Rejoin');}`));
   await verifyCodes('reconnect');
   row.convergedAfterRejoin=await converged('rejoin');
   const lost=await both(page=>page.run(`(markers)=>trial.has(markers)`,[markers.slice(-2)]));
   row.rules.rejoinKeepsOfflineWork=lost.every(list=>!list.length);if(!row.rules.rejoinKeepsOfflineWork)throw Error('Offline work was lost on rejoin.');
  }
  row.ok=Object.values(row.rules).every(value=>value!==false);
 }catch(error){
  row.failedAt=lastStep;row.error=String(error.message).slice(0,500);
  row.statuses=await Promise.all(pages.map(page=>page.run(`async()=>{await trial.share();return trial.status();}`,[],5000).catch(()=>null)));
 }finally{
  await Promise.all(pages.map(page=>page.close()));
  delete row.converged?.threads;delete row.converged?.reviews;delete row.converged?.suggestions;delete row.convergedAfterRejoin?.threads;delete row.convergedAfterRejoin?.reviews;delete row.convergedAfterRejoin?.suggestions;
 }
 return row;
}
export function plan(mode,reps,machines){
 const [a,b]=machines,flip=[[a,b],[b,a]],sessions=[];
 const mixed=flip.flatMap(pair=>[{machines:pair,browsers:['firefox','chromium']},{machines:pair,browsers:['chromium','firefox']}]);
 for(let rep=0;rep<reps;rep++){
  if(mode==='smoke')sessions.push({machines:[a,b],browsers:['firefox','chromium']});
  if(mode==='full')for(const browser of ['chromium','firefox'])sessions.push(...flip.map(pair=>({machines:pair,browsers:[browser,browser]})));
  if(mode==='full'||mode==='mixed')sessions.push(...mixed);
 }
 return sessions;
}

// ---- Command line -------------------------------------------------------------
export function parseArguments(argv,env=process.env){
 const args=Object.fromEntries(argv.map(value=>{const at=value.indexOf('=');return at<0?[value.replace(/^--/,''),true]:[value.slice(2,at),value.slice(at+1)];}));
 const mode=args.mode||'smoke';
 if(!['smoke','mixed','full'].includes(mode))throw Error('Use --mode=smoke, mixed or full.');
 args.a??=env.SCRIBYRA_TRIAL_HOST_A;args.b??=env.SCRIBYRA_TRIAL_HOST_B;
 if(!args.a||!args.b)throw Error('Name both machines with --a=HOST --b=HOST.');
 const local=args.a==='local'&&args.b==='local',key=args.key||env.SCRIBYRA_TRIAL_KEY;
 if(local&&(!args['local-gecko']||!args['local-chrome']))throw Error('--a=local needs --local-gecko and --local-chrome.');
 const machine=(host,gecko,chrome,ifc)=>({host,gecko:Number(local?args['local-gecko']:gecko),chrome:Number(local?args['local-chrome']:chrome),ifc:ifc||null});
 return{
  mode,local,help:args.help,dryRun:!!args['dry-run'],
  machines:[machine(args.a,9411,9412,args['a-ifc']),machine(args.b,9421,9422,args['b-ifc'])],
  user:args.user||env.SCRIBYRA_TRIAL_USER||null,key:key?key.replace(/^~/,homedir()):null,meshIfc:args['mesh-ifc']||'wt0',
  rounds:Number(args.rounds||(mode==='smoke'?1:3)),reps:Number(args.reps||1),bulkKiB:Number(args['bulk-kib']??(mode==='smoke'?0:2048)),rejoin:mode!=='smoke',
  firefoxPkg:args['firefox-pkg']||'firefox-159.0.1',geckoPkg:args['gecko-pkg']||'geckodriver-0.37.1',chromiumPkg:args['chromium-pkg']||'chromium-156.0.8078.79',chromedriverPkg:args['chromedriver-pkg']||'chromedriver-unwrapped-156.0.8078.79',
  output:args.output||`tmp/direct/trial-${mode}.jsonl`,dist:args.dist||'dist',serviceBinary:args['service-binary']||['target/release/scribyra-sync','target/debug/scribyra-sync'].find(existsSync),
 };
}
async function main(argv){
 if(argv.includes('--help')||!argv.length){console.log(HELP);return 0;}
 const config=parseArguments(argv),sessions=plan(config.mode,config.reps,config.machines);
 if(config.dryRun){
  for(const machine of config.machines)console.log(['ssh',...tunnelArguments(machine,config,'APP','SERVICE').map(shellQuote)].join(' '));
  console.log(`\n${sessions.length} session(s):`);for(const s of sessions)console.log(`  ${s.machines[0].host}/${s.browsers[0]} starts, ${s.machines[1].host}/${s.browsers[1]} joins`);
  return 0;
 }
 if(!existsSync(join(config.dist,'index.html')))throw Error(`No production build in ${config.dist}. Run: nix develop -c npm run build`);
 if(!config.serviceBinary||!existsSync(config.serviceBinary))throw Error('No connection service binary. Run: nix develop -c cargo build -p scribyra-sync');
 await mkdir(dirname(resolve(config.output)),{recursive:true});
 const tunnels=[];let app,service,failures=0,interrupted=false;
 const stop=()=>{interrupted=true;};process.once('SIGINT',stop);process.once('SIGTERM',stop);
 try{
  app=await serveApp(config.dist,config.local?APP_PORT:0);
  service=await startService(resolve(config.serviceBinary),config.local?SERVICE_PORT:0);
  if(!config.local){
   for(const machine of config.machines){
    const child=spawn('ssh',tunnelArguments(machine,config,app.port,service.port),{stdio:['pipe','ignore','pipe']});let errors='';child.stderr.on('data',bytes=>{errors=(errors+bytes).slice(-400);});
    child.once('exit',code=>{if(!child.closing)console.error(`Tunnel to ${machine.host} ended (${code}): ${errors.trim()}`);});tunnels.push(child);
   }
   for(const machine of config.machines)for(const port of [machine.gecko,machine.chrome]){
    let up=false;for(let i=0;i<60&&!up;i++){up=await fetch(`http://127.0.0.1:${port}/status`).then(r=>r.ok).catch(()=>false);if(!up)await sleep(1000);}
    if(!up)throw Error(`WebDriver on ${machine.host} port ${port} did not start.`);
   }
  }
  for(const machine of config.machines)machine.ifc=await wifiInterface(machine,config).catch(()=>null);
  console.log(`Wi-Fi interfaces: ${config.machines.map(m=>`${m.host}=${m.ifc||'none'}`).join(', ')}; mesh ${config.meshIfc}`);
  for(const [index,session] of sessions.entries()){
   if(interrupted)break;
   console.log(`Session ${index+1}/${sessions.length}: ${session.machines[0].host}/${session.browsers[0]} starts, ${session.machines[1].host}/${session.browsers[1]} joins`);
   const row=await runSession({config,service,mode:config.mode,bulkKiB:config.bulkKiB,rounds:config.rounds,rejoin:config.rejoin,...session});
   await appendFile(config.output,JSON.stringify(row)+'\n');if(!row.ok)failures++;
   console.log(`  ${row.ok?'CONVERGED':'FAILED at '+row.failedAt+': '+row.error}`);
   if(row.bytes.bulk)console.log(`  bulk: Wi-Fi ${row.bytes.bulk.a.wifiTx} bytes sent, mesh ${row.bytes.bulk.a.meshTx} bytes sent`);
  }
  console.log(`${sessions.length-failures} of ${sessions.length} sessions converged. Report: ${config.output}`);
  return failures||interrupted?1:0;
 }finally{
  for(const child of tunnels){child.closing=true;child.stdin.end();}
  await sleep(tunnels.length?2500:0);for(const child of tunnels)if(child.exitCode===null&&child.signalCode===null)child.kill('SIGTERM');
  await service?.close();await app?.close();process.off('SIGINT',stop);process.off('SIGTERM',stop);
 }
}
if(import.meta.url===pathToFileURL(process.argv[1]||'').href){
 main(process.argv.slice(2)).then(code=>{process.exitCode=code;},error=>{console.error(error.message);process.exitCode=2;});
}
