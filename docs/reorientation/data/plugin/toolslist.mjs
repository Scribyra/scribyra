import {mcpClient,PW,DT,CHROMIUM,P,cl100k} from './lib.mjs';
import {writeFileSync} from 'node:fs';
const pwBase=['--headless','--executable-path',CHROMIUM,'--no-sandbox'];
writeFileSync(P+'/measure/out/core.json',JSON.stringify({capabilities:['core']}));
const cases=[
 ['pw default',PW,pwBase],
 ['pw --codegen none --snapshot-mode none',PW,[...pwBase,'--codegen','none','--snapshot-mode','none']],
 ['pw --no-webmcp',PW,[...pwBase,'--no-webmcp']],
 ['pw --caps vision,pdf,devtools',PW,[...pwBase,'--caps','vision,pdf,devtools']],
 ['pw config capabilities=[core]',PW,[...pwBase,'--config',P+'/measure/out/core.json']],
 ['pw --extension',PW,['--extension']],
 ['dt default',DT,['--headless','--isolated','--executablePath',CHROMIUM,'--no-usage-statistics','--no-performance-crux','--chromeArg=--no-sandbox']],
 ['dt --slim',DT,['--slim','--headless','--isolated','--executablePath',CHROMIUM,'--no-usage-statistics','--no-performance-crux','--chromeArg=--no-sandbox']],
 ['dt categories off (emulation,performance,network,memory)',DT,['--no-category-emulation','--no-category-performance','--no-category-network','--no-category-memory','--headless','--isolated','--executablePath',CHROMIUM,'--no-usage-statistics','--no-performance-crux','--chromeArg=--no-sandbox']],
 ['dt navigation+debugging only',DT,['--no-category-emulation','--no-category-performance','--no-category-network','--no-category-memory','--no-category-input','--headless','--isolated','--executablePath',CHROMIUM,'--no-usage-statistics','--no-performance-crux','--chromeArg=--no-sandbox']],
];
const out={};
for(const [name,cli,args] of cases){
  try{const m=await mcpClient(cli,args);const {tools}=await m.client.listTools();const s=JSON.stringify(tools);
    const per=tools.map(t=>[t.name,Buffer.byteLength(JSON.stringify(t))]);
    out[name]={tools:tools.length,bytes:Buffer.byteLength(s),est:Math.round(s.length/4),cl100k:cl100k(s),per};
    if(name==='pw default'){writeFileSync(P+'/measure/out/pw-tools.json',JSON.stringify(tools,null,1));}
    if(name==='dt --slim'){writeFileSync(P+'/measure/out/dt-slim-tools.json',JSON.stringify(tools,null,1));}
    console.log(name,tools.length,'tools',Buffer.byteLength(s),'bytes ~',Math.round(s.length/4));await m.close();
  }catch(e){out[name]={error:String(e.message).slice(0,200)};console.log(name,'ERR',e.message.slice(0,200));}
}
writeFileSync(P+'/measure/out/toolslist.json',JSON.stringify(out,null,1));
console.log(out['pw default']?.per?.map(p=>p.join(':')).join(' '));
console.log(out['dt --slim']?.per?.map(p=>p.join(':')).join(' '));
