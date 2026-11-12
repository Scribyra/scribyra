import { createRequire } from 'node:module';
const { chromium, firefox } = createRequire((process.env.REPO || '<repo>') + '/package.json')('playwright');
import { mkdirSync } from 'node:fs';
import { spawn } from 'node:child_process';
const scratch = process.env.SCRATCH || '<scratch>';
mkdirSync(scratch + '/browser', {recursive:true});
const holder = spawn('sleep', ['infinity'], {cwd:scratch + '/browser', stdio:'ignore'});
holder.unref();
process.env.TMPDIR = '/proc/' + holder.pid + '/cwd';
process.on('exit', () => holder.kill('SIGTERM'));
for (const engine of [firefox, chromium]) {
 const b=await engine.launch(engine===chromium?{executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,args:['--no-sandbox']}:{ });
 try {const p=await b.newPage(); console.log(engine.name(),await p.evaluate(async()=>{
 const a=new RTCPeerConnection(),b=new RTCPeerConnection();a.createDataChannel('a');b.createDataChannel('b');
 await a.setLocalDescription(await a.createOffer());await b.setLocalDescription(await b.createOffer());
 await new Promise(r=>setTimeout(r,1500)); const before=b.localDescription.sdp;
 await b.setLocalDescription({type:'rollback'}); await b.setRemoteDescription(a.localDescription);const answer=await b.createAnswer();
 const pending=answer.sdp; await b.setLocalDescription(answer);await new Promise(r=>setTimeout(r,1500));const after=b.localDescription.sdp;
 a.close();b.close();return {before,pending,after};}));}finally{await b.close();}
}
holder.kill('SIGTERM');
