// Raw in-page JSON, without a model or MCP wrappers. Import/discovery are separate.
import {chromium} from '@playwright/test';
import {readFile,writeFile} from 'node:fs/promises';
const rows=[],identities=[],port=process.env.SCRIBYRA_TEST_PORT||'4504';
const browser=await chromium.launch({executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,args:['--no-sandbox']});
try{
 for(const fixture of ['article','missing-package','thesis']){
  const context=await browser.newContext(),page=await context.newPage();
  try{
   await page.goto(`http://127.0.0.1:${port}`);const chooser=page.waitForEvent('filechooser');await page.getByRole('button',{name:'Import ZIP',exact:true}).click();await(await chooser).setFiles(`public/fixtures/${fixture}.zip`);await page.locator('.cm-content').waitFor();
   const invoke=async(method,options)=>{
    const result=await page.evaluate(({method,options})=>window.scribyra.agent[method](options),{method,options});
    if(!result.ok)throw new Error(JSON.stringify(result));return result;
   };
   const record=(step,results,extra={})=>{const texts=results.map(r=>JSON.stringify(r)),pretty=results.map(r=>JSON.stringify(r,null,2));rows.push({fixture,step,prettyBytes:pretty.reduce((n,t)=>n+Buffer.byteLength(t),0),prettyCharacters:pretty.reduce((n,t)=>n+t.length,0),bytes:texts.reduce((n,t)=>n+Buffer.byteLength(t),0),characters:texts.reduce((n,t)=>n+t.length,0),maxReceiptBytes:Math.max(...texts.map(t=>Buffer.byteLength(t))),maxReceiptCharacters:Math.max(...texts.map(t=>t.length)),calls:results.length,...extra});};
   const status=await invoke('status');record('S1',[status]);
   const description=await page.evaluate(()=>window.scribyra.agent.describe());identities.push({fixture,build:description.build});record('describe',[description]);
   const build=async step=>{
    const started=await invoke('compile'),jobId=started.value.jobId,polls=[];let result;
    do{result=await invoke('poll',{jobId,waitMs:25000});polls.push(result);}while(result.value.status==='running');
    record(step,[started,result],{success:result.value.success,pages:result.value.pages,warnings:result.value.warnings,intermediatePolls:polls.length-1,intermediatePollBytes:polls.slice(0,-1).reduce((n,r)=>n+Buffer.byteLength(JSON.stringify(r)),0)});return result;
   };
   const first=await build('S2');record('S3',[await invoke('poll',{jobId:first.value.jobId})]);
   record('S4',[await invoke('diagnostics',{jobId:first.value.jobId,limit:10})]);
   let target={fileId:status.value.mainFile};
   if(fixture==='thesis'){
    target={path:'chapters/page-050.tex'};record('path-lookup',[await invoke('readTree',target)]);
   }
   const source=await invoke('readSource',{...target,startLine:1,endLine:11});record('S5',[source]);
   const edits=fixture==='missing-package'?[{...target,find:'\\usepackage{scribyra-does-not-exist}',replace:''}]:[{...target,start:0,end:0,before:'',after:fixture==='thesis'?'\\undefinedcmd\n':'% measured edit\n'}];
   record('S6',[await invoke('patchSource',{expectedRevision:source.revision,requestId:'measured-edit',edits})]);const last=await build('S7');
   if(first.value.success!==(fixture!=='missing-package')||last.value.success!==(fixture!=='thesis'))throw new Error(`Unexpected build outcome: ${fixture}`);
  }finally{await context.close();}
 }
}finally{await browser.close();}
const previous=JSON.parse(await readFile('docs/reorientation/data/a1-a2-after.json','utf8'));
const prototype=JSON.parse(await readFile('docs/reorientation/data/r1-option2.json','utf8'));
const totals=['article','missing-package','thesis'].map(fixture=>{
 const scenario=rows.filter(r=>r.fixture===fixture&&/^S[1-7]$/.test(r.step));
 const runs=new Map();for(const row of prototype.filter(r=>r.fixture===fixture&&r.transport==='page.evaluate'&&r.mode==='stepwise'&&/^S[1-7]$/.test(r.step)))runs.set(row.run,(runs.get(row.run)||0)+row.bytes);
 const sizes=[...runs.values()].sort((a,b)=>a-b);
 return{fixture,prettyBytes:scenario.reduce((n,r)=>n+r.prettyBytes,0),bytes:scenario.reduce((n,r)=>n+r.bytes,0),maxReceiptBytes:Math.max(...scenario.map(r=>r.maxReceiptBytes)),calls:scenario.reduce((n,r)=>n+r.calls,0),intermediatePolls:scenario.reduce((n,r)=>n+(r.intermediatePolls||0),0),intermediatePollBytes:scenario.reduce((n,r)=>n+(r.intermediatePollBytes||0),0),previousScopedUiBytes:previous.filter(r=>r.fixture===fixture&&/^S[1-7]$/.test(r.step)).reduce((n,r)=>n+r.bytes,0),previousOption2RawMedianBytes:sizes[Math.floor(sizes.length/2)]};
});
const result={method:'One fresh Chromium profile per fixture; JSON.stringify receipts, UTF-8 bytes; S2/S7 start + terminal poll; bounded 25s waits with intermediate polls and discovery separate; pretty-printed sizes also recorded. No MCP framing, model or token measurement.',browser:browser.version(),recipeBytes:Buffer.byteLength(await readFile('public/agent.md')),identities,rows,totals};
await writeFile('docs/reorientation/data/a5-followup.json',JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(totals,null,2));
