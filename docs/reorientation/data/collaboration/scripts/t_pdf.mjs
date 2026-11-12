// Same project, same runtime, compiled twice per engine in isolated profiles with no network: are the PDFs byte-identical?
import {createRequire} from 'node:module';import {spawn,execFileSync} from 'node:child_process';import {readFile,writeFile} from 'node:fs/promises';import {createHash} from 'node:crypto';import {readFileSync} from 'node:fs';
const here=new URL('.',import.meta.url).pathname;const require=createRequire('<repo>/package.json');const pw=require('playwright');
execFileSync('ip',['link','set','lo','up']);
const srv=spawn(process.execPath,[here+'dist-server.mjs'],{stdio:['ignore','ignore','pipe']});await new Promise(r=>srv.stderr.once('data',r));
const hold=spawn('sleep',['infinity'],{cwd:here+'tmp',stdio:'ignore'});process.env.TMPDIR='/proc/'+hold.pid+'/cwd';process.env.HOME=here+'tmp';
const WK={};for(const l of readFileSync(here+'webkit-env.sh','utf8').split('\n')){const m=/^export (\w+)=(.*)$/.exec(l);if(m)WK[m[1]]=m[2];}
const out={};const sha=b=>createHash('sha256').update(b).digest('hex').slice(0,16);
const norm=b=>Buffer.from(b).toString('latin1').replace(/\/CreationDate\s*\(D:[^)]*\)/g,'/CreationDate()').replace(/\/ModDate\s*\(D:[^)]*\)/g,'/ModDate()').replace(/\/ID\s*\[\s*<[0-9A-Fa-f]+>\s*<[0-9A-Fa-f]+>\s*\]/g,'/ID[]');
const pdfs={};
for(const engine of ['chromium','firefox','webkit']){const o={headless:true};if(engine==='chromium'){o.executablePath=process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;o.args=['--no-sandbox'];}if(engine==='webkit')Object.assign(process.env,WK);
 const r={};try{const b=await pw[engine].launch(o);const ctx=await b.newContext({acceptDownloads:true});const page=await ctx.newPage();await page.goto('http://127.0.0.1:5191/app/');await page.getByRole('button',{name:'Start with a sample paper'}).click();await page.locator('.cm-content').waitFor({timeout:60000});
  const compile=async()=>{await page.evaluate(()=>window.scribyra.lastCompile=null);const t=Date.now();await page.getByRole('button',{name:/^Compile(?: |$)/}).click();await page.waitForFunction(()=>window.scribyra.lastCompile,null,{timeout:280000});const res=await page.evaluate(()=>{const l=window.scribyra.lastCompile;return{success:l.success,bytes:l.bytes,log:l.success?'':String(l.log).slice(-300)};});res.ms=Date.now()-t;return res;};
  const dl=async()=>{const ev=page.waitForEvent('download',{timeout:30000});await page.getByRole('button',{name:'Download PDF',exact:true}).click();return readFile(await(await ev).path());};
  r.first=await compile();const p1=await dl();await page.waitForTimeout(61000);await page.locator('.cm-content').click();await page.keyboard.press('Control+End');await page.keyboard.insertText(' ');await page.keyboard.press('Backspace');r.second=await compile();const p2=await dl();
  r.sha=[sha(p1),sha(p2)];r.identical=sha(p1)===sha(p2);r.identicalIgnoringDateAndId=norm(p1)===norm(p2);r.size=[p1.length,p2.length];pdfs[engine]=p1;await writeFile(here+`results/sample-${engine}.pdf`,p1);await b.close();}catch(e){r.error=String(e).slice(0,500);}out[engine]=r;console.log(engine,JSON.stringify(r));}
const es=Object.keys(pdfs);for(let i=0;i<es.length;i++)for(let j=i+1;j<es.length;j++){const a=pdfs[es[i]],b=pdfs[es[j]];out[`${es[i]}=${es[j]}`]={identical:sha(a)===sha(b),ignoringDateAndId:norm(a)===norm(b),sizes:[a.length,b.length]};}
console.log(JSON.stringify(Object.fromEntries(Object.entries(out).filter(([k])=>k.includes('=')))));await writeFile(here+'results/pdf.json',JSON.stringify(out,null,1));srv.kill();hold.kill();process.exit(0);
