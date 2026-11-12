import {test,expect} from '@playwright/test';
import {execFileSync} from 'node:child_process';
import {readFile,readdir,rm,mkdir,writeFile} from 'node:fs/promises';
import {resolve,extname,sep} from 'node:path';
import {createServer} from 'node:http';
import {officialTelemetryEndpoint,officialTelemetryEnv} from '../../scripts/official-telemetry.mjs';
import AxeBuilder from '@axe-core/playwright';
import {faroVerdict,faroPreflightHeaders,FARO_ALLOWED_HEADERS,FARO_MISSING_SDK} from '../helpers/faro-collector.mjs';

test.use({serviceWorkers:'block',viewport:{width:1366,height:768}});
const origin=`http://127.0.0.1:${process.env.SCRIBYRA_TEST_PORT||4173}`,key='scribyra:telemetry-consent:v1';
let endpoint,server,captured=[],preflights=[],collectorStatus=202;
const card=page=>page.getByRole('complementary',{name:'Telemetry consent',exact:true});
// The dashboard sidebar names Diagnostics directly; inside a project it sits under More tools.
const open=async page=>{const tools=page.getByRole('button',{name:'More tools',exact:true});if(await tools.isVisible())await tools.click();await page.getByRole('button',{name:'Diagnostics',exact:true}).click();return page.getByRole('dialog',{name:'Local diagnostics'});};
async function raise(page){await page.evaluate(()=>{setTimeout(()=>{throw Error('PRIVATE_SOURCE paper.tex /private/path prompt token');},0);});await page.waitForTimeout(400);}
// Longer than the first-send delay, or longer than request spacing once something was
// sent. A shorter wait would pass whether or not a record was on its way.
const quiet=(page,sentBefore=false)=>page.waitForTimeout(sentBefore?15500:5500);
async function sample(page){await page.getByRole('button',{name:'Start with a sample paper',exact:true}).click();await expect(page.getByRole('textbox',{name:'LaTeX source',exact:true})).toBeVisible();}
let output,officialOutput,halfOutput;
test.beforeAll(async({},info)=>{
 server=createServer(async(request,response)=>{
  const url=new URL(request.url,'http://localhost');
  if(url.pathname==='/collect/test'){
   // Strict like production: a preflight asking for any header beyond content-type and
   // x-faro-session-id gets no CORS grant, and a POST the real collector would refuse
   // gets its 400 before any simulated outage status applies.
   if(request.method==='OPTIONS'){preflights.push(request.headers);response.writeHead(204,faroPreflightHeaders(request.headers));response.end();return;}
   response.setHeader('Access-Control-Allow-Origin',request.headers.origin||'null');
   let body='';for await(const chunk of request)body+=chunk;
   const verdict=faroVerdict(request.headers,body);
   captured.push({headers:request.headers,url:request.url,encoded:body,at:Date.now(),body:JSON.parse(body),verdict});
   if(verdict.status!==202){response.writeHead(verdict.status);response.end(verdict.message);return;}
   if(collectorStatus==='drop'){request.socket.destroy();return;}
   // 'invalid' stands for a collector that refuses records, as production did before.
   if(collectorStatus==='invalid'){response.writeHead(400);response.end(FARO_MISSING_SDK);return;}
   response.writeHead(collectorStatus);response.end('{}');return;
  }
  const path=url.pathname==='/'?'index.html':decodeURIComponent(url.pathname).slice(1);
  const roots=url.searchParams.has('official')?[officialOutput,resolve('site')]:url.searchParams.has('half')?[halfOutput,resolve('site')]:[output,officialOutput,halfOutput,resolve('dist'),resolve('site')];
  for(const root of roots){
   const file=resolve(root,path);if(!file.startsWith(root+sep))continue;
   try{const body=await readFile(file),types={'.html':'text/html','.js':'text/javascript','.mjs':'text/javascript','.css':'text/css','.wasm':'application/wasm','.json':'application/json','.md':'text/markdown','.svg':'image/svg+xml'};response.writeHead(200,{'Content-Type':types[extname(file)]||'application/octet-stream'});response.end(body);return;}catch{}
  }
  response.writeHead(404);response.end();
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));endpoint=`http://127.0.0.1:${server.address().port}/collect/test`;
 output=resolve(`.cache/telemetry-consent-${info.project.name}`);officialOutput=resolve(`.cache/telemetry-consent-official-${info.project.name}`);halfOutput=resolve(`.cache/telemetry-consent-half-${info.project.name}`);
 // Serve a configured production bundle and its collector over real local HTTP.
 // Synthetic document fulfilment triggers Chromium local-network restrictions.
 execFileSync('npx',['vite','build','--outDir',output,'--emptyOutDir'],{env:{...process.env,SCRIBYRA_ROOT_SHELL:'1',VITE_TELEMETRY_INGEST_URL:endpoint},stdio:'pipe'});
 execFileSync('npx',['vite','build','--outDir',officialOutput,'--emptyOutDir'],{env:{...process.env,SCRIBYRA_ROOT_SHELL:'1',...officialTelemetryEnv},stdio:'pipe'});
 // The same collector, with a build that lets half of all sessions send.
 execFileSync('npx',['vite','build','--outDir',halfOutput,'--emptyOutDir'],{env:{...process.env,SCRIBYRA_ROOT_SHELL:'1',VITE_TELEMETRY_INGEST_URL:endpoint,VITE_TELEMETRY_SESSION_RATE:'0.5'},stdio:'pipe'});
});
test.afterAll(async()=>{server?.closeAllConnections();if(server)await new Promise(resolve=>server.close(resolve));for(const directory of [output,officialOutput,halfOutput])if(directory)await rm(directory,{recursive:true,force:true});});
async function configured(context,{official=false,half=false,status=202,routed=true}={}){
 const requests=[],batches=[];captured=batches;preflights=[];collectorStatus=status;context.on('request',request=>requests.push({url:request.url(),method:request.method()}));
 // Playwright answers preflights itself while routing is on, so the CORS test opts out.
 if(routed)await context.route('https://faro-collector-prod-eu-central-0.grafana.net/**',route=>route.abort());
 return{app:new URL(official?'/?official=1':half?'/?half=1':'/',endpoint).href,requests,batches,telemetry:()=>requests.filter(request=>request.url===endpoint||request.url===officialTelemetryEndpoint)};
}
test('unconfigured source build has no prompt, destination or automatic requests',async({page,context})=>{
 await context.addInitScript(({key,endpoint})=>localStorage.setItem(key,JSON.stringify({endpoint,decided:true,visits:2,choices:{performance:true,errors:true,usage:true}})),{key,endpoint});
 const requests=[];context.on('request',request=>requests.push(request.url()));await page.goto('/');await expect(page.getByRole('button',{name:'Diagnostics',exact:true})).toBeVisible();await expect(card(page)).toHaveCount(0);
 const d=await open(page);await expect(d.getByRole('group',{name:'Telemetry choices',exact:true})).toHaveCount(0);await d.getByLabel('Collect local diagnostics').check();await raise(page);await quiet(page);expect(requests.filter(url=>new URL(url).pathname.startsWith('/v1/')||new URL(url).pathname.startsWith('/collect'))).toEqual([]);
});
test('fresh profile sends nothing while shown, after dismissal and after permanent refusal',async({page,context})=>{
 const network=await configured(context);
 await context.addInitScript(()=>localStorage.setItem('scribyra:diagnostics:v1',JSON.stringify({collect:true,allowExport:true})));
 await page.goto(network.app);await expect(card(page)).toBeVisible();await expect(card(page).getByRole('checkbox')).toHaveCount(3);for(const input of await card(page).getByRole('checkbox').all())await expect(input).not.toBeChecked();
 await expect(card(page)).toContainText(endpoint);expect(await card(page).evaluate(node=>node.contains(document.activeElement))).toBe(false);
 await raise(page);await quiet(page);expect(network.telemetry()).toEqual([]);
 // Draft checks are not consent until Save choices is pressed.
 await card(page).getByRole('checkbox',{name:'Errors and failures',exact:true}).check();await raise(page);await quiet(page);expect(network.telemetry()).toEqual([]);
 await card(page).getByRole('button',{name:'Dismiss telemetry prompt',exact:true}).click();await raise(page);await quiet(page);expect(network.telemetry()).toEqual([]);
 await page.reload();await expect(card(page)).toBeVisible();await expect(card(page).getByRole('checkbox',{name:'Errors and failures',exact:true})).not.toBeChecked();await raise(page);expect(network.telemetry()).toEqual([]);
 await card(page).getByRole('button',{name:'No thanks',exact:true}).click();await raise(page);await page.reload();await expect(card(page)).toHaveCount(0);await raise(page);await quiet(page);expect(network.telemetry()).toEqual([]);
 expect(network.requests.every(request=>new URL(request.url).origin===new URL(endpoint).origin)).toBe(true);
});
test('ignored prompt reappears on only one later visit and then stops',async({page,context})=>{
 const network=await configured(context);await page.goto(network.app);await expect(card(page)).toBeVisible();await page.reload();await expect(card(page)).toBeVisible();await page.reload();await expect(card(page)).toHaveCount(0);await raise(page);await quiet(page);expect(network.telemetry()).toEqual([]);
 const d=await open(page);await expect(d.getByRole('checkbox',{name:'Feature usage',exact:true})).not.toBeChecked();await d.getByRole('button',{name:'Close',exact:true}).click();
});
test('keyboard dismissal discards draft choices without trapping focus',async({page,context})=>{
 const network=await configured(context);await page.goto(network.app);const input=card(page).getByRole('checkbox',{name:'Feature usage',exact:true});await input.focus();await page.keyboard.press('Space');await expect(input).toBeChecked();await page.keyboard.press('Escape');await expect(card(page)).toHaveCount(0);await sample(page);await raise(page);await quiet(page);expect(network.telemetry()).toEqual([]);
});
for(const category of ['Performance and timing','Errors and failures','Feature usage'])test(`${category} independently gates the actual network payload and persists`,async({page,context})=>{
 const network=await configured(context);await page.goto(network.app);await card(page).getByRole('checkbox',{name:category,exact:true}).check();await card(page).getByRole('button',{name:'Save choices',exact:true}).click();
 await sample(page);await raise(page);await expect.poll(()=>network.batches.length).toBeGreaterThan(0);
 const kind=category==='Performance and timing'?'measurements':category==='Errors and failures'?'exceptions':'events';
 const sent=network.batches.flatMap(batch=>batch.body[kind]||[]);expect(sent.length).toBeGreaterThan(0);
 for(const batch of network.batches){
  expect(Object.keys(batch.body).sort()).toEqual(['meta',kind].sort());
  expect(Object.keys(batch.body.meta).sort()).toEqual(['app','sdk','session']);expect(batch.body.meta.sdk).toEqual({name:'scribyra',version:'0.1.0'});expect(batch.body.meta.session).toEqual({id:batch.headers['x-faro-session-id']});expect(batch.verdict.status).toBe(202);expect(batch.body.meta.app.name).toBe('scribyra');
  expect(Object.keys(batch.body.meta.app).sort()).toEqual(['name','version','gitHash','release','bundleId'].sort());
  for(const event of batch.body[kind]){
   expect(Object.keys(event).sort()).toEqual((kind==='measurements'?['type','values','timestamp','trace','context']:kind==='exceptions'?['type','value','timestamp','trace','context']:['name','timestamp','trace','attributes']).sort());
   expect(Object.keys(event.trace).sort()).toEqual(['span_id','trace_id']);expect(event.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
   const context=event.context||event.attributes;expect(context.sampling_rate).toBe('1');expect(Object.keys(context).every(key=>['runtime','source','parent_span_id','dropped','sampled','sampling_rate',...(kind==='exceptions'?['outcome']:kind==='events'?['count']:[])].includes(key))).toBe(true);
   if(kind==='exceptions'){expect(event.value).toBeTruthy();expect(context.outcome).toBe('failure');}
   if(kind!=='exceptions')expect(['exception','rejection','storage_quota']).not.toContain(event.type||event.name);
   if(kind==='measurements')expect(Object.keys(event.values).every(key=>['duration_ms','bytes','memory_bytes'].includes(key))).toBe(true);
  }
  expect(batch.headers.authorization).toBeUndefined();expect(batch.headers.cookie).toBeUndefined();expect(batch.headers.referer).toBeUndefined();expect(JSON.stringify(batch.body)).not.toMatch(/PRIVATE_SOURCE|paper.tex|private\/path|prompt|token/);
 }
 if(kind==='measurements')expect(sent.some(event=>event.values.duration_ms!==undefined)).toBe(true);
 await page.reload();await expect(card(page)).toHaveCount(0);
 if(category==='Performance and timing')await expect.poll(()=>network.batches.some(batch=>batch.body.measurements?.some(event=>event.type==='startup'))).toBe(true);
 const d=await open(page);await expect(d.getByRole('checkbox',{name:category,exact:true})).toBeChecked();await expect(d.getByLabel('Collect local diagnostics')).not.toBeChecked();await expect(d.getByRole('button',{name:'Export preview',exact:true})).toBeDisabled();
 await d.getByRole('checkbox',{name:category,exact:true}).uncheck();await d.getByRole('button',{name:'Close',exact:true}).click();await page.waitForTimeout(400);const before=network.batches.length;await raise(page);await quiet(page,true);expect(network.batches).toHaveLength(before);
 await page.reload();await expect(card(page)).toHaveCount(0);const settings=await open(page);await expect(settings.getByRole('checkbox',{name:category,exact:true})).not.toBeChecked();
});
test('revoking consent drops queued records immediately and propagates to another tab',async({page,context})=>{
 const network=await configured(context);await page.goto(network.app);await card(page).getByRole('checkbox',{name:'Errors and failures',exact:true}).check();await card(page).getByRole('button',{name:'Save choices',exact:true}).click();
 const peer=await context.newPage();try{
  await peer.goto(network.app);const d=await open(peer);await expect(d.getByRole('checkbox',{name:'Errors and failures',exact:true})).toBeChecked();
  const baseline=network.batches.length;
  await peer.evaluate(key=>{const state=JSON.parse(localStorage.getItem(key));state.choices.errors=false;localStorage.setItem(key,JSON.stringify(state));},key);
  await page.waitForTimeout(100);await raise(page);await quiet(page);expect(network.batches).toHaveLength(baseline);
  await d.getByRole('button',{name:'Close',exact:true}).click();
 }finally{await peer.close();}
});
test('turning a category off discards an unsent failure before the batch timer fires',async({page,context})=>{
 const network=await configured(context);await page.goto(network.app);await card(page).getByRole('checkbox',{name:'Errors and failures',exact:true}).check();await card(page).getByRole('button',{name:'Save choices',exact:true}).click();const d=await open(page);
 await d.getByRole('checkbox',{name:'Errors and failures',exact:true}).evaluate(input=>{window.dispatchEvent(new ErrorEvent('error',{message:'PRIVATE_QUEUED_FAILURE'}));input.click();});
 await quiet(page);expect(network.telemetry()).toEqual([]);await expect(d.getByRole('checkbox',{name:'Errors and failures',exact:true})).not.toBeChecked();
});
test('a different destination requires fresh all-off choices',async({page,context})=>{
 const network=await configured(context);await context.addInitScript(key=>localStorage.setItem(key,JSON.stringify({endpoint:'https://previous.invalid/v1/browser-events',decided:true,visits:2,choices:{performance:true,errors:true,usage:true}})),key);
 await page.goto(network.app);await expect(card(page)).toBeVisible();for(const input of await card(page).getByRole('checkbox').all())await expect(input).not.toBeChecked();await raise(page);await quiet(page);expect(network.telemetry()).toEqual([]);
});
test('unavailable preference storage suppresses reminders and leaves explicit tab choices in Diagnostics',async({page,context})=>{
 const network=await configured(context);await context.addInitScript(()=>{const set=Storage.prototype.setItem;Storage.prototype.setItem=function(key,value){if(key==='scribyra:telemetry-consent:v1')throw new DOMException('Storage full','QuotaExceededError');return set.call(this,key,value);};});
 await page.goto(network.app);await expect(page.getByRole('button',{name:'Diagnostics',exact:true})).toBeVisible();await expect(card(page)).toHaveCount(0);await raise(page);await quiet(page);expect(network.telemetry()).toEqual([]);
 const d=await open(page);await expect(d).toContainText('Changes apply to this tab only');await d.getByRole('checkbox',{name:'Errors and failures',exact:true}).check();await raise(page);await expect.poll(()=>network.batches.length).toBeGreaterThan(0);
 await page.reload();await expect(card(page)).toHaveCount(0);const settings=await open(page);await expect(settings.getByRole('checkbox',{name:'Errors and failures',exact:true})).not.toBeChecked();
});
for(const theme of ['light','dark'])test(`${theme} consent is accessible and opening the editor clears the unanswered card`,async({page,context},info)=>{
 const network=await configured(context);await context.addInitScript(theme=>localStorage.setItem('scribyra-theme',theme),theme);await page.goto(network.app);await expect(card(page)).toBeVisible();
 await page.screenshot({path:resolve(`.cache/telemetry-consent-${info.project.name}-${theme}-dashboard-1366x768.png`)});
 const audit=await new AxeBuilder({page}).include('.telemetry-consent').withTags(['wcag2a','wcag2aa','wcag21aa']).analyze();expect(audit.violations).toEqual([]);
 await card(page).getByRole('checkbox',{name:'Errors and failures',exact:true}).check();await sample(page);await expect(card(page)).toHaveCount(0);
 await raise(page);await quiet(page);expect(network.telemetry()).toEqual([]);const settings=await open(page);await expect(settings.getByRole('checkbox',{name:'Errors and failures',exact:true})).not.toBeChecked();await settings.getByRole('button',{name:'Close',exact:true}).click();
 await expect(page.getByRole('button',{name:'Compile',exact:true})).toBeVisible();await page.getByRole('treeitem').first().click();
 const path=resolve(`.cache/telemetry-consent-${info.project.name}-${theme}-1366x768.png`);await page.screenshot({path});
 await page.getByRole('button',{name:'Review',exact:true}).click();const review=page.locator('.review-workspace:not([hidden])');await expect(review).toBeVisible();await expect(card(page)).toHaveCount(0);
 await page.setViewportSize({width:390,height:740});await expect(card(page)).toHaveCount(0);
});

test('official destination is named as a third party and links the collection docs without a request',async({page,context})=>{
 const network=await configured(context,{official:true});await page.goto(network.app);await expect(card(page)).toContainText('Grafana Cloud, a third-party service');
 await expect(card(page).getByRole('link',{name:'What Scribyra collects',exact:true})).toHaveAttribute('href','/telemetry.html');
 await raise(page);await quiet(page);expect(network.telemetry()).toEqual([]);
});
for(const mode of ['rejecting','offline'])test(`Faro ${mode} collector leaves editing and saving usable`,async({page,context})=>{
 const network=await configured(context,{status:mode==='rejecting'?403:202});await page.goto(network.app);await card(page).getByRole('checkbox',{name:'Errors and failures',exact:true}).check();await card(page).getByRole('button',{name:'Save choices',exact:true}).click();
 await sample(page);await raise(page);await expect.poll(()=>network.batches.length).toBeGreaterThan(0);
 if(mode==='offline')await context.setOffline(true);
 try{
  await raise(page);const source=page.getByRole('textbox',{name:'LaTeX source',exact:true});await source.click();await page.keyboard.press('Control+End');await page.keyboard.insertText('\n% PRIVATE_OFFLINE_SOURCE');await expect(page.locator('.save-indicator')).toHaveText('Saved locally');
  const d=await open(page);await expect(d.getByRole('checkbox',{name:'Errors and failures',exact:true})).toBeChecked();await d.getByRole('checkbox',{name:'Errors and failures',exact:true}).uncheck();await d.getByRole('button',{name:'Close',exact:true}).click();
  const before=network.batches.length;await raise(page);await quiet(page,true);expect(network.batches.length).toBe(before);
 }finally{await context.setOffline(false);}
});

// Privacy review regressions. Every check reads what a real browser put on the wire.
const CANARY=/CANARY|canary/;
const LIFECYCLE=['startup','worker_startup','compile','worker_pass','tex_pass','bibliography_pass','index_pass','package_prepare','download','verify','cache','cache_evict','pdf_prepare','runtime_transfer','storage_read','migration'];
const FAILURE_SIGNALS=['exception','rejection','storage_quota','retry','recovery'];
const records=batches=>batches.flatMap(batch=>[...(batch.body.measurements||[]),...(batch.body.events||[]),...(batch.body.exceptions||[])]);
const nameOf=record=>record.type||record.name;
const powerOf=(value,base)=>{if(value===0)return true;let step=1;while(step<value)step*=base;return step===value;};
const oneTwoFive=value=>{if(value===0)return true;let decade=1;while(decade*10<=value)decade*=10;return [1,2,5].includes(value/decade);};
async function save(page,...choices){for(const name of choices)await card(page).getByRole('checkbox',{name,exact:true}).check();await card(page).getByRole('button',{name:'Save choices',exact:true}).click();await expect(card(page)).toHaveCount(0);}
async function compile(page){await page.evaluate(()=>{window.scribyra.lastCompile=null;});await page.getByRole('button',{name:'Compile',exact:true}).click();await expect.poll(()=>page.evaluate(()=>window.scribyra.lastCompile),{timeout:300000}).toBeTruthy();}
function assertPayloadsAreCoarse(batches){
 for(const batch of batches){
  expect(batch.encoded+batch.url+JSON.stringify(batch.headers)).not.toMatch(CANARY);
  for(const record of records([batch])){
   expect([...LIFECYCLE,...FAILURE_SIGNALS]).toContain(nameOf(record));
   expect(record.timestamp).toMatch(/:00\.000Z$/);
   const values=record.values||{};
   if(values.bytes!==undefined)expect(powerOf(values.bytes,4),`bytes ${values.bytes}`).toBe(true);
   if(values.memory_bytes!==undefined)expect(powerOf(values.memory_bytes,2),`memory ${values.memory_bytes}`).toBe(true);
   if(values.duration_ms!==undefined)expect(oneTwoFive(values.duration_ms),`duration ${values.duration_ms}`).toBe(true);
   if(record.attributes?.count!==undefined)expect(oneTwoFive(Number(record.attributes.count)),`count ${record.attributes.count}`).toBe(true);
  }
 }
}
test('a paste-heavy typing session cannot reveal rhythm, document size or any seeded canary',async({page,context},info)=>{
 test.slow();
 const network=await configured(context);
 // Local diagnostics keep exact values, which proves the removed signal really fired.
 await context.addInitScript(()=>localStorage.setItem('scribyra:diagnostics:v1',JSON.stringify({collect:true,allowExport:false})));
 await page.goto(network.app);await save(page,'Performance and timing','Errors and failures','Feature usage');await sample(page);
 await page.getByTitle('Rename project').click();await page.getByRole('textbox',{name:'Rename project',exact:true}).fill('CANARY_PROJECT_NAME');await page.getByRole('button',{name:'Rename',exact:true}).click();
 const source=page.getByRole('textbox',{name:'LaTeX source',exact:true});await source.click();await page.keyboard.press('Control+End');await page.keyboard.insertText('\n% CANARY_SOURCE_TEXT\n% ');
 await expect(page.locator('.save-indicator')).toHaveText('Saved locally');
 const gaps=[170,410,230,650,190,310,520,180,270,730,210,350,600,240,480,290];
 const beforeTyping=network.batches.length;await page.keyboard.type('a');
 for(const gap of gaps){await page.waitForTimeout(gap);await page.keyboard.type('b');}
 await expect(page.locator('.save-indicator')).toHaveText('Saved locally');
 expect(network.batches.length-beforeTyping,'requests while typing').toBeLessThanOrEqual(1);
 for(let i=0;i<3;i++){await page.keyboard.insertText(`\n% CANARY_PASTE ${'lorem ipsum '.repeat(500)}`);await expect(page.locator('.save-indicator')).toHaveText('Saved locally');}
 await page.getByRole('button',{name:'Add file',exact:true}).click();await page.getByRole('textbox',{name:'New file',exact:true}).fill('CANARY_FILE_NAME.tex');await page.getByRole('button',{name:'Create file',exact:true}).click();
 await expect(page.locator('.save-indicator')).toHaveText('Saved locally');
 await page.evaluate(()=>{setTimeout(()=>{throw Error('CANARY_ERROR_TEXT /private/canary/path');},0);});
 await page.getByRole('treeitem').first().click();await compile(page);
 await expect.poll(()=>records(network.batches).some(record=>nameOf(record)==='compile'&&record.values?.duration_ms!==undefined),{timeout:60000}).toBe(true);
 const d=await open(page);await d.getByRole('button',{name:'Refresh timeline',exact:true}).click();const local=JSON.parse(await d.locator('pre').textContent());await d.getByRole('button',{name:'Close',exact:true}).click();
 const commits=local.events.filter(event=>event.operation==='storage_commit'&&event.outcome==='success'),exact=commits.map(event=>event.metrics.find(metric=>metric.name==='bytes')?.value).filter(Number.isFinite);
 expect(commits.length,'saves fired locally').toBeGreaterThan(3);expect(Math.max(...exact),'document grew').toBeGreaterThan(Math.min(...exact)*3);
 await page.waitForTimeout(16000);
 assertPayloadsAreCoarse(network.batches);
 const sent=records(network.batches),names=sent.map(nameOf);
 for(const local of ['storage_commit','local_tabs','command','workspace_search','source_outline','source_map','sync','sync_io','mcp','provider'])expect(names).not.toContain(local);
 expect(names).toContain('exception');
 // Any difference between two sent times is a whole number of minutes, unlike every typed gap.
 const times=[...new Set(sent.map(record=>Date.parse(record.timestamp)))].sort((a,b)=>a-b);
 for(let i=1;i<times.length;i++)expect((times[i]-times[i-1])%60000).toBe(0);
 // The document's size is gone: no sent number repeats an exact local size that isn't itself a bucket.
 const numbers=new Set(sent.flatMap(record=>Object.values(record.values||{})));
 for(const value of exact)if(!powerOf(value,4))expect(numbers.has(value),`exact size ${value}`).toBe(false);
 const sizes=sent.filter(record=>record.values?.bytes!==undefined);expect(sizes.length,'sized records were captured').toBeGreaterThan(0);
 for(const batch of network.batches){expect(Object.keys(batch.headers)).not.toContain('idempotency-key');}
 await mkdir('tmp',{recursive:true});await writeFile(`tmp/telemetry-sample-${info.project.name}.json`,JSON.stringify(network.batches.find(batch=>batch.body.measurements?.some(record=>record.type==='compile'))?.body??{},null,1));
});
for(const[title,choices,expected]of [['performance and usage hide',['Performance and timing','Feature usage'],false],['failures with usage reveals',['Errors and failures','Feature usage'],true]])test(`${title} a real project recovery`,async({page,context})=>{
 const network=await configured(context);await page.goto(network.app);await save(page,...choices);await sample(page);await expect(page.locator('.save-indicator')).toHaveText('Saved locally');
 // Deleting the project in a peer tab is the app's own path to a recovered copy.
 const peer=await context.newPage();try{
  await peer.goto(network.app);await peer.getByRole('button',{name:'Project actions',exact:true}).click();await peer.getByRole('menuitem',{name:'Delete project',exact:true}).click();await peer.getByRole('button',{name:'Delete project',exact:true}).click();
  await page.getByRole('button',{name:'Save recovered copy',exact:true}).click();await expect(page.getByRole('status',{name:'Workspace notification',exact:true})).toContainText('Recovered');
 }finally{await peer.close();}
 const signal=()=>records(network.batches).map(nameOf).includes('recovery');
 if(expected)await expect.poll(signal,{timeout:40000}).toBe(true);
 else{await expect.poll(()=>network.batches.length,{timeout:40000}).toBeGreaterThan(0);await page.waitForTimeout(16000);for(const name of FAILURE_SIGNALS)expect(records(network.batches).map(nameOf)).not.toContain(name);}
 assertPayloadsAreCoarse(network.batches);
});
test('withdrawal under a really full localStorage stops this tab, a peer and a reload',async({page,context})=>{
 test.slow();
 const network=await configured(context);await page.goto(network.app);await save(page,'Errors and failures');
 const peer=await context.newPage();try{
  await peer.goto(network.app);const d=await open(page);
  const room=await page.evaluate(()=>{const piece=size=>'x'.repeat(size);let index=0;for(let size=1<<20;size>=1;size>>=1){for(;;){try{localStorage.setItem(`fill-${index}`,piece(size));index++;}catch{break;}}}let tail=localStorage.getItem('fill-0')??'';try{for(;;){tail+='x';localStorage.setItem('fill-0',tail);}}catch{}let refused=false;try{localStorage.setItem('probe','y');localStorage.removeItem('probe');}catch{refused=true;}return refused;});
  expect(room,'storage is genuinely full').toBe(true);
  await d.getByRole('checkbox',{name:'Errors and failures',exact:true}).uncheck();await expect(d).toContainText('Changes apply to this tab only');
  const before=network.batches.length;await raise(page);await raise(peer);await quiet(page,true);expect(network.batches).toHaveLength(before);
  await peer.reload();await expect(peer.getByRole('button',{name:'Diagnostics',exact:true})).toBeVisible();await raise(peer);
  await page.reload();await expect(page.getByRole('button',{name:'Diagnostics',exact:true})).toBeVisible();await raise(page);await quiet(page,true);expect(network.batches).toHaveLength(before);
  const settings=await open(page);await expect(settings.getByRole('checkbox',{name:'Errors and failures',exact:true})).not.toBeChecked();
  await page.evaluate(()=>{for(const name of Object.keys(localStorage))if(name.startsWith('fill-'))localStorage.removeItem(name);});
 }finally{await peer.close();}
});
test('a value that cannot be removed is tombstoned for the tab, and unreadable consent is no consent',async({page,context})=>{
 const network=await configured(context);await page.goto(network.app);await save(page,'Errors and failures');
 await page.addInitScript(key=>{const{setItem,removeItem,getItem}=Storage.prototype;const blocked=()=>sessionStorage.getItem('test-block');Storage.prototype.setItem=function(name,value){if(name===key&&this===localStorage&&blocked())throw new DOMException('Full','QuotaExceededError');return setItem.call(this,name,value);};Storage.prototype.removeItem=function(name){if(name===key&&this===localStorage&&blocked())throw new DOMException('Denied','SecurityError');return removeItem.call(this,name);};Storage.prototype.getItem=function(name){if(name===key&&this===localStorage&&sessionStorage.getItem('test-unreadable'))throw new DOMException('Denied','SecurityError');return getItem.call(this,name);};},key);
 await page.evaluate(()=>sessionStorage.setItem('test-block','1'));await page.reload();
 const d=await open(page);const box=d.getByRole('checkbox',{name:'Errors and failures',exact:true});await expect(box).toBeChecked();await box.uncheck();await d.getByRole('button',{name:'Close',exact:true}).click();
 expect(await page.evaluate(key=>localStorage.getItem(key),key)).toContain('"errors":true');
 const before=network.batches.length;await raise(page);await quiet(page);expect(network.batches).toHaveLength(before);
 await page.reload();await raise(page);await quiet(page);expect(network.batches).toHaveLength(before);
 const again=await open(page);await expect(again.getByRole('checkbox',{name:'Errors and failures',exact:true})).not.toBeChecked();await again.getByRole('button',{name:'Close',exact:true}).click();
 await page.evaluate(key=>{sessionStorage.removeItem('test-block');sessionStorage.removeItem('scribyra:telemetry-withdrawn:v1');localStorage.setItem(key,JSON.stringify({endpoint:JSON.parse(localStorage.getItem(key)).endpoint,decided:true,visits:2,choices:{performance:false,errors:true,usage:false}}));sessionStorage.setItem('test-unreadable','1');},key);
 await page.reload();await raise(page);await quiet(page);expect(network.batches).toHaveLength(before);
 const unreadable=await open(page);await expect(unreadable.getByRole('checkbox',{name:'Errors and failures',exact:true})).not.toBeChecked();
});
test('clearing storage in the same tab stops queued and later sending without a reload',async({page,context})=>{
 const network=await configured(context);await page.goto(network.app);await save(page,'Errors and failures');
 await raise(page);await page.evaluate(()=>localStorage.clear());await quiet(page);expect(network.batches).toHaveLength(0);
 await raise(page);await quiet(page);expect(network.batches).toHaveLength(0);
 const d=await open(page);await expect(d.getByRole('checkbox',{name:'Errors and failures',exact:true})).not.toBeChecked();
});
test('a second tab leaves the first card and its draft alone until someone decides',async({page,context})=>{
 const network=await configured(context);await page.goto(network.app);const draft=card(page).getByRole('checkbox',{name:'Feature usage',exact:true});await draft.check();
 const peer=await context.newPage();try{
  await peer.goto(network.app);await expect(card(peer)).toBeVisible();await page.waitForTimeout(500);await expect(card(page)).toBeVisible();await expect(draft).toBeChecked();
  await card(peer).getByRole('button',{name:'No thanks',exact:true}).click();await expect(card(page)).toHaveCount(0);
 }finally{await peer.close();}
});
test('dismissing returns focus to where it came from, then to a sensible control',async({page,context})=>{
 const network=await configured(context);await page.goto(network.app);
 const next=page.getByRole('button',{name:'New project',exact:true});await next.focus();await card(page).getByRole('checkbox',{name:'Feature usage',exact:true}).focus();await page.keyboard.press('Escape');await expect(card(page)).toHaveCount(0);await expect(next).toBeFocused();
 await page.evaluate(()=>localStorage.clear());await page.reload();await card(page).getByRole('button',{name:'Dismiss telemetry prompt',exact:true}).click();await expect(page.getByRole('button',{name:'Diagnostics',exact:true})).toBeFocused();
 await page.setViewportSize({width:390,height:740});await page.evaluate(()=>localStorage.clear());await page.reload();await card(page).getByRole('button',{name:'No thanks',exact:true}).click();await expect(card(page)).toHaveCount(0);expect(await page.evaluate(()=>document.activeElement?.tagName)).toBe('BUTTON');
});
for(const[width,height,names]of [[1024,600,['Diagnostics','New project','Import ZIP','Toggle theme']],[390,740,['New project','Import ZIP','Start with a sample paper']]])for(const theme of ['light','dark'])test(`${theme} card stays small and leaves controls reachable at ${width}x${height}`,async({page,context},info)=>{
 const network=await configured(context,{official:true});await context.addInitScript(theme=>localStorage.setItem('scribyra-theme',theme),theme);await page.setViewportSize({width,height});await page.goto(network.app);await expect(card(page)).toBeVisible();
 const box=await card(page).boundingBox();expect(box.height,'small prompt').toBeLessThanOrEqual(Math.min(280,height*.45));
 await page.screenshot({path:resolve(`.cache/telemetry-consent-${info.project.name}-${theme}-${width}x${height}.png`)});
 const audit=await new AxeBuilder({page}).include('.telemetry-consent').withTags(['wcag2a','wcag2aa','wcag21aa']).analyze();expect(audit.violations).toEqual([]);
 // A trial click scrolls as a person would, and fails if anything else takes the pointer.
 for(const name of names)await page.getByRole('button',{name,exact:true}).click({trial:true,timeout:10000});
 // Keyboard users must not land on a control hidden beneath the card either.
 expect(await page.evaluate(()=>getComputedStyle(document.documentElement).scrollPaddingBottom)).toBe(`${Math.ceil(box.height)}px`);
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
});
for(const[width,height]of [[1366,768],[1024,600],[390,740]])test(`the card never covers More tools or Compile, and More tools reaches the choices at ${width}x${height}`,async({page,context})=>{
 const network=await configured(context,{official:true});await page.setViewportSize({width,height});await page.goto(network.app);await expect(card(page)).toBeVisible();
 await sample(page);await expect(card(page)).toHaveCount(0);
 // A trial click fails if anything else, such as a docked card, would take the pointer.
 for(const name of ['More tools','Compile'])await page.getByRole('button',{name,exact:true}).click({trial:true,timeout:10000});
 const d=await open(page);const choices=d.getByRole('group',{name:'Telemetry choices',exact:true});await expect(choices).toBeVisible();
 for(const input of await choices.getByRole('checkbox').all())await expect(input).not.toBeChecked();
 await choices.getByRole('checkbox',{name:'Errors and failures',exact:true}).check();await d.getByRole('button',{name:'Close',exact:true}).click();await expect(d).toHaveCount(0);
 expect(JSON.parse(await page.evaluate(key=>localStorage.getItem(key),key)).choices).toEqual({performance:false,errors:true,usage:false});
 await page.reload();await expect(card(page)).toHaveCount(0);
});
test('a real cross-origin request passes a strict preflight with only Content-Type and the Faro session header',async({page,context})=>{
 const network=await configured(context,{routed:false});const url=new URL(network.app);url.hostname='localhost';
 await page.goto(url.href);await save(page,'Errors and failures');await raise(page);await expect.poll(()=>network.batches.length,{timeout:30000}).toBeGreaterThan(0);
 expect(preflights.length).toBeGreaterThan(0);for(const headers of preflights){expect(headers.origin).toBe(url.origin);expect(headers['access-control-request-headers']).toBe(FARO_ALLOWED_HEADERS);}
 const batch=network.batches[0],headers=batch.headers;expect(batch.verdict).toEqual({status:202,message:'ok'});expect(headers['content-type']).toBe('application/json');expect(headers['x-faro-session-id']).toMatch(/^[a-f0-9]{16}$/);expect(batch.body.meta.session).toEqual({id:headers['x-faro-session-id']});expect(batch.body.meta.sdk).toEqual({name:'scribyra',version:'0.1.0'});
 for(const name of ['idempotency-key','authorization','cookie','referer','x-api-key','traceparent'])expect(headers[name]).toBeUndefined();
});
// Everything this origin can persist, as text, to prove the session ID is in none of it.
async function persisted(page){
 return page.evaluate(async()=>{
  const out=[],bytes=value=>new TextDecoder('latin1').decode(value instanceof ArrayBuffer?value:new Uint8Array(value.buffer,value.byteOffset,value.byteLength));
  const text=value=>JSON.stringify(value,(_key,item)=>item instanceof ArrayBuffer||ArrayBuffer.isView(item)?bytes(item):item);
  for(const store of [localStorage,sessionStorage])for(let i=0;i<store.length;i++)out.push(store.key(i),store.getItem(store.key(i)));
  out.push(document.cookie);
  let databases=0;
  for(const {name} of await indexedDB.databases()){
   databases++;const db=await new Promise((resolve,reject)=>{const request=indexedDB.open(name);request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);});
   for(const store of db.objectStoreNames){const read=method=>new Promise(resolve=>{const request=db.transaction(store).objectStore(store)[method]();request.onsuccess=()=>resolve(request.result);request.onerror=()=>resolve([]);});out.push(store,text(await read('getAllKeys')),text(await read('getAll')));}
   db.close();
  }
  if(globalThis.caches)for(const name of await caches.keys()){out.push(name);for(const request of await (await caches.open(name)).keys())out.push(request.url);}
  return{text:out.join('\n'),local:localStorage.length,session:sessionStorage.length,databases};
 });
}
const sessionOf=batch=>{expect(batch.verdict.status).toBe(202);const id=batch.headers['x-faro-session-id'];expect(id).toMatch(/^[a-f0-9]{16}$/);expect(batch.body.meta.session).toEqual({id});return id;};
test('the Faro session ID is never stored and is new on every reload and in every tab',async({page,context})=>{
 const network=await configured(context);await page.goto(network.app);await save(page,'Errors and failures','Feature usage');
 const next=async target=>{const before=network.batches.length;await raise(target);await expect.poll(()=>network.batches.length,{timeout:30000}).toBeGreaterThan(before);return sessionOf(network.batches.at(-1));};
 const first=await next(page);
 await sample(page);await page.getByRole('textbox',{name:'LaTeX source',exact:true}).click();await page.keyboard.insertText('% CANARY_SESSION_SOURCE');await expect(page.locator('.save-indicator')).toHaveText('Saved locally');
 const stored=await persisted(page);expect(stored.local,'consent and the project are stored, so the scan has something to read').toBeGreaterThan(0);expect(stored.session).toBeGreaterThan(0);expect(stored.databases).toBeGreaterThan(0);expect(stored.text).not.toContain(first);
 await page.reload();const reloaded=await next(page);expect(reloaded).not.toBe(first);
 const other=await context.newPage();await other.goto(network.app);const tab=await next(other);expect(tab).not.toBe(first);expect(tab).not.toBe(reloaded);
 for(const target of [page,other]){const all=(await persisted(target)).text;for(const id of [first,reloaded,tab])expect(all).not.toContain(id);}
 expect(network.batches.every(batch=>batch.verdict.status===202)).toBe(true);
 for(const batch of network.batches)expect(batch.encoded+JSON.stringify(batch.headers)).not.toMatch(/PRIVATE_SOURCE|paper\.tex|private\/path|prompt|token/);
 assertPayloadsAreCoarse(network.batches);await other.close();
});
for(const status of [202,'invalid'])test(`Diagnostics reports ${status===202?'healthy':'failing'} delivery against a ${status} collector`,async({page,context})=>{
 const network=await configured(context,{status});await page.goto(network.app);await save(page,'Errors and failures');
 await raise(page);await expect.poll(()=>network.batches.length,{timeout:30000}).toBeGreaterThan(0);
 const d=await open(page),delivery=d.getByRole('group',{name:'Telemetry choices',exact:true}).getByRole('status');
 if(status===202){await expect(delivery).toHaveText(/^Delivery: [1-9]\d* sent · 0 waiting · 0 failed\.$/);await expect(delivery).not.toContainText('failing');}
 else{await expect(delivery).toContainText('Delivery failing: the destination rejected these records');await expect(delivery).toContainText('0 sent');await expect(delivery).toContainText('1 failed');await expect(delivery).toHaveAttribute('data-state','failing');}
 const audit=await new AxeBuilder({page}).include('.modal').withTags(['wcag2a','wcag2aa','wcag21aa']).analyze();expect(audit.violations).toEqual([]);
});
for(const status of [202,500,429,'drop'])test(`an error loop against a ${status} collector stays within the send limits`,async({page,context})=>{
 const network=await configured(context,{status});await page.goto(network.app);await save(page,'Errors and failures','Feature usage');
 await page.evaluate(()=>{window.errorLoop=setInterval(()=>window.dispatchEvent(new ErrorEvent('error',{message:'CANARY_LOOP'})),50);});
 await page.waitForTimeout(21000);await page.evaluate(()=>clearInterval(window.errorLoop));
 // The unbounded build reached 224 requests a minute on success, 28 on failure.
 expect(network.batches.length).toBeGreaterThan(0);expect(network.batches.length,'requests in 21 seconds').toBeLessThanOrEqual(2);
 const sent=records(network.batches).filter(record=>nameOf(record)==='exception');expect(sent.length,'identical records are sent once a minute').toBeLessThanOrEqual(8);
 assertPayloadsAreCoarse(network.batches);
 await expect(page.getByRole('button',{name:'New project',exact:true})).toBeEnabled();
});
test('a default build carries no collector address or destination label',async({})=>{
 const found=[];const walk=async directory=>{for(const entry of await readdir(directory,{withFileTypes:true})){const path=resolve(directory,entry.name);if(entry.isDirectory()){if(!['core','fixtures'].includes(entry.name))await walk(path);}else if(/\.(js|mjs|html|css|json|md|txt|webmanifest)$/.test(entry.name)&&/grafana|faro-collector|92935ef8d0bc|telemetry\.html/i.test(await readFile(path,'utf8')))found.push(path);}};
 await walk(resolve('dist'));expect(found).toEqual([]);
 // The same scan finds the strings in an official build, so the search can't pass by accident.
 const official=[];const assets=resolve(officialOutput,'assets');for(const name of await readdir(assets))if(name.endsWith('.js')&&(await readFile(resolve(assets,name),'utf8')).includes('faro-collector'))official.push(name);expect(official.length).toBeGreaterThan(0);
});
for(const theme of ['light','dark'])test(`${theme} disclosure page states the fields, the third party and how to leave, and may be indexed`,async({page,context},info)=>{
 await page.emulateMedia({colorScheme:theme});const network=await configured(context,{official:true});
 await page.goto(network.app);const link=card(page).getByRole('link',{name:'What Scribyra collects',exact:true});
 const [opened]=await Promise.all([context.waitForEvent('page'),link.click()]);await opened.waitForLoadState();await opened.emulateMedia({colorScheme:theme});
 expect(new URL(opened.url()).pathname).toBe('/telemetry.html');await expect(opened.getByRole('heading',{level:1})).toHaveText('What Scribyra collects');
 await expect(opened.locator('meta[name="robots"]')).toHaveCount(0);
 const text=await opened.locator('main').innerText();
 for(const field of ['measurements[]','values.duration_ms','values.bytes','values.memory_bytes','exceptions[]','context.outcome','events[]','attributes.count','timestamp','trace.trace_id','trace.span_id','parent_span_id','dropped','sampled','sampling_rate','meta.app','gitHash','bundleId','meta.sdk','meta.session.id','X-Faro-Session-Id',...LIFECYCLE,...FAILURE_SIGNALS])expect(text).toContain(field);
 for(const phrase of ['Grafana Cloud, a third-party service','EU region','Never sent','Document contents','Open Diagnostics','More tools','Self-hosted','unless its operator configures'])expect(text).toContain(phrase);
 const audit=await new AxeBuilder({page:opened}).withTags(['wcag2a','wcag2aa','wcag21aa']).analyze();expect(audit.violations).toEqual([]);
 await opened.screenshot({path:resolve(`.cache/telemetry-page-${info.project.name}-${theme}.png`),fullPage:true});await opened.close();
 const d=await open(page);await expect(d.getByRole('link',{name:'What Scribyra collects',exact:true})).toHaveAttribute('href','/telemetry.html');
});

// Fixes the half of each new 8-byte random draw that decides session sampling, for
// this tab only; the other half (and every other draw) stays random.
const steer=context=>context.addInitScript(()=>{const original=Crypto.prototype.getRandomValues;Crypto.prototype.getRandomValues=function(array){const result=original.call(this,array);const tail=sessionStorage.getItem('test-session-tail');if(tail&&array instanceof Uint8Array&&array.length===8)array.fill(Number(tail),4);return result;};});
test('a session the build did not sample sends nothing; a sampled one carries the rate',async({page,context})=>{
 const network=await configured(context,{half:true});await steer(context);
 await page.goto(network.app);await page.evaluate(()=>sessionStorage.setItem('test-session-tail','255'));await page.reload();
 await save(page,'Performance and timing','Errors and failures','Feature usage');
 await sample(page);await raise(page);await quiet(page);await raise(page);await quiet(page);
 expect(network.telemetry(),'consented but unsampled: no request at all').toEqual([]);
 const d=await open(page),delivery=d.getByRole('group',{name:'Telemetry choices',exact:true}).getByRole('status');
 await expect(delivery).toHaveText(/^Delivery: this build sends from 50% of sessions, and this one was not picked, so nothing is sent\. 0 sent · 0 waiting · 0 failed\.$/);
 await d.getByRole('button',{name:'Close',exact:true}).click();
 // A reload is a new session with a new decision; this one is sampled.
 await page.evaluate(()=>sessionStorage.setItem('test-session-tail','0'));await page.reload();await raise(page);
 await expect.poll(()=>network.batches.length,{timeout:30000}).toBeGreaterThan(0);
 for(const batch of network.batches){expect(sessionOf(batch)).toMatch(/00000000$/);for(const record of records([batch]))expect((record.context||record.attributes).sampling_rate).toBe('0.5');}
 assertPayloadsAreCoarse(network.batches);
});
test('focus and tab switches keep one session; it rotates at four hours, as documented',async({page,context})=>{
 // A fake clock, advanced by hand past the send delay and request spacing. Errors
 // are dispatched directly: one thrown from a fake timer never reaches window.
 const network=await configured(context);await page.clock.install();await page.goto(network.app);await save(page,'Errors and failures');
 const next=async target=>{const before=network.batches.length;await target.evaluate(()=>window.dispatchEvent(new ErrorEvent('error',{message:'PRIVATE_SOURCE paper.tex'})));await target.clock.runFor(20000);await expect.poll(()=>network.batches.length,{timeout:30000}).toBeGreaterThan(before);return sessionOf(network.batches.at(-1));};
 const first=await next(page);
 const other=await context.newPage();await other.goto(network.app);await other.bringToFront();await page.evaluate(()=>{window.dispatchEvent(new Event('blur'));document.dispatchEvent(new Event('visibilitychange'));});
 await page.bringToFront();await page.evaluate(()=>{window.dispatchEvent(new Event('focus'));document.dispatchEvent(new Event('visibilitychange'));});await other.close();
 await page.clock.fastForward('03:50:00');expect(await next(page),'same session after focus changes, short of four hours').toBe(first);
 await page.clock.fastForward('00:11:00');const rotated=await next(page);expect(rotated).not.toBe(first);
 expect(network.batches.every(batch=>batch.verdict.status===202)).toBe(true);
 const stored=(await persisted(page)).text;for(const id of [first,rotated])expect(stored).not.toContain(id);
});
