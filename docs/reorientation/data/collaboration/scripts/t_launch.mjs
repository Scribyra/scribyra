import {createRequire} from 'node:module';const require=createRequire('<repo>/package.json');const pw=require('playwright');
const [engine,...args]=process.argv.slice(2);
try{const o={headless:true};if(engine==='chromium'){o.executablePath=process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;o.args=['--no-sandbox',...args];}
const b=await pw[engine].launch(o);const p=await (await b.newContext()).newPage();await p.goto('data:text/html,<p>hi');console.log(engine,'OK',b.version(),await p.evaluate(()=>typeof RTCPeerConnection+' '+navigator.userAgent));await b.close();}catch(e){console.log(engine,'FAIL',String(e).slice(0,1800));}
process.exit(0);
