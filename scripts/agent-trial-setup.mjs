// Run through nix develop -c node scripts/agent-trial-setup.mjs.
// Owns a disposable browser profile and preview until Ctrl+C; no model is run.
import {spawn,execFileSync} from 'node:child_process';
import {parseArgs} from 'node:util';
import {chromium} from '@playwright/test';
import {setTimeout as delay} from 'node:timers/promises';
import {createServer} from 'node:net';
const {values}=parseArgs({options:{port:{type:'string',default:'4474'},'debug-port':{type:'string',default:'4475'},fixture:{type:'string',default:'thesis'},headless:{type:'boolean'},check:{type:'boolean'}}});
const port=Number(values.port),debugPort=Number(values['debug-port']);
if(![port,debugPort].every(value=>Number.isInteger(value)&&value>=1024&&value<=65535)||port===debugPort)throw Error('Choose distinct ports from 1024–65535');
if(!['article','thesis','missing-package'].includes(values.fixture))throw Error('Fixture must be article, thesis or missing-package');
for(const value of [port,debugPort]){
 const probe=createServer();await new Promise((resolve,reject)=>{probe.once('error',reject);probe.listen(value,'127.0.0.1',resolve);});await new Promise(resolve=>probe.close(resolve));
}
execFileSync('npm',['run','fixtures'],{stdio:'inherit'});
execFileSync('npm',['run','build'],{stdio:'inherit'});
const origin=`http://127.0.0.1:${port}`,endpoint=`http://127.0.0.1:${debugPort}`;
let browserContext,stopping=false,cancelled=false;
const preview=spawn(process.execPath,['node_modules/vite/bin/vite.js','preview','--host','127.0.0.1','--port',String(port),'--strictPort'],{stdio:['ignore','pipe','inherit']});
let ready=false;preview.stdout.on('data',data=>{process.stdout.write(data);if(data.toString().includes('Local:'))ready=true;});
const exited=new Promise(resolve=>preview.once('exit',resolve));
async function stop(){
 if(stopping)return;stopping=true;
 try{await browserContext?.close();}finally{if(preview.exitCode===null){preview.kill('SIGTERM');await exited;}}
}
let finish;const interrupted=new Promise(resolve=>{finish=resolve;});
for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>{cancelled=true;finish();});
try{
 for(let attempt=0;;attempt++){
  if(cancelled)throw Error('Interrupted');
  if(preview.exitCode!==null)throw Error('Preview exited before readiness');
  try{if(ready&&(await fetch(origin,{signal:AbortSignal.timeout(1000)})).ok)break;}catch{}
  if(attempt===100)throw Error('Preview did not become ready');await delay(100);
 }
 browserContext=await chromium.launchPersistentContext('',{headless:!!values.headless,executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH||undefined,args:['--no-sandbox',`--remote-debugging-port=${debugPort}`,'--remote-debugging-address=127.0.0.1']});
 if(cancelled)throw Error('Interrupted');
 const page=await browserContext.newPage();page.setDefaultTimeout(30000);await page.goto(origin);
 const chooser=page.waitForEvent('filechooser');await page.getByRole('button',{name:'Import ZIP',exact:true}).click();await(await chooser).setFiles(`public/fixtures/${values.fixture}.zip`);
 await page.getByRole('textbox',{name:'LaTeX source',exact:true}).waitFor();
 const version=await(await fetch(`${endpoint}/json/version`)).json();if(!version.webSocketDebuggerUrl)throw Error('CDP endpoint is unavailable');
 console.log(JSON.stringify({url:page.url(),title:await page.title(),recipe:`${origin}/agent.md`,attach:`--cdp-endpoint=${endpoint}`}));
 if(values.check){
  const attached=await chromium.connectOverCDP(endpoint);
  try{
   const titles=await Promise.all(attached.contexts().flatMap(context=>context.pages()).map(page=>page.title()));
   if(!titles.includes(`${values.fixture} — Scribyra`))throw Error('Attached browser did not expose the imported project');
  }finally{await attached.close();}
 }else await interrupted;
}finally{await stop();}
