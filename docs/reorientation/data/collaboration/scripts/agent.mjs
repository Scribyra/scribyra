// One browser in the current network namespace. JSON-lines RPC on stdio; signaling therefore crosses processes only through the orchestrator.
import {createRequire} from 'node:module';import {spawn} from 'node:child_process';import readline from 'node:readline';
const require=createRequire('<repo>/package.json');const pw=require('playwright');
const [engine,flagsJson='{}']=process.argv.slice(2);const opt=JSON.parse(flagsJson);
const here=new URL('.',import.meta.url).pathname;const server=spawn(process.execPath,[here+'server.mjs',here+'www','5191'],{stdio:['ignore','ignore','pipe']});
await new Promise(r=>server.stderr.once('data',r));
const launch={headless:true};
if(engine==='chromium'){launch.executablePath=process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;launch.args=['--no-sandbox',...(opt.args||[])];if(opt.ignoreDefaultArgs)launch.ignoreDefaultArgs=opt.ignoreDefaultArgs;}
if(engine==='firefox'&&opt.firefoxPrefs)launch.firefoxUserPrefs=opt.firefoxPrefs;
const browser=await pw[engine].launch(launch);const perms=[...(opt.grantCamera&&engine==='chromium'?['camera']:[]),...(opt.permissions||[])];const ctx=await browser.newContext(perms.length?{permissions:perms}:{});const page=await ctx.newPage();
page.on('pageerror',e=>process.stderr.write('PAGEERR '+e.message+'\n'));
await page.goto('http://127.0.0.1:5191/');await page.waitForFunction(()=>window.H);
const say=o=>process.stdout.write(JSON.stringify(o)+'\n');say({ready:true,engine,version:browser.version(),pid:process.pid});
const rl=readline.createInterface({input:process.stdin});
const finish=async()=>{try{await browser.close();}catch{}server.kill();process.exit(0);};
rl.on('line',async l=>{const m=JSON.parse(l);if(m.fn==='__quit'){say({id:m.id,result:true});return finish();}try{say({id:m.id,result:await page.evaluate(([f,a])=>window.H[f](a),[m.fn,m.arg])});}catch(e){say({id:m.id,error:String(e.message||e).slice(0,600)});}});
rl.on('close',finish);process.on('SIGTERM',finish);
