import {test,expect} from '@playwright/test';
const app=process.env.SCRIBYRA_TEST_PAGES_URL?new URL('app/',process.env.SCRIBYRA_TEST_PAGES_URL).href:'/';
const budgets={describe:1500,status:650,tree:600,source:2400,patch:450,compile:650,poll:650,diagnostics:4000,cancel:650,export:1000};
async function recipe(page,testInfo){
 const response=await page.request.get(new URL('agent.md',page.url()).href);expect(response.ok()).toBe(true);
 const text=await response.text();expect(Buffer.byteLength(text)).toBeLessThan(2000);
 const snippets=[...text.matchAll(/```js\n([\s\S]*?)\n```/g)].map(match=>match[1]);expect(snippets).toHaveLength(10);
 const names=['describe','status','tree','source','patch','compile','poll','diagnostics','cancel','export'];
 return Object.fromEntries(names.map((name,i)=>[name,async options=>{
  const result=await new Function('page','options',`const example = (${snippets[i]}); return typeof example === 'function' ? example(options) : example;`)(page,options);
  const json=JSON.stringify(result,null,2),bytes=Buffer.byteLength(json);expect(bytes,`${name} result bytes`).toBeLessThanOrEqual(budgets[name]);
  await testInfo.attach(name,{body:JSON.stringify({bytes,characters:json.length,estimatedTokens:json.length/4}),contentType:'application/json'});
  if(name!=='describe'){expect(result.ok,JSON.stringify(result.error)).toBe(true);expect(result.value.contentType).toBe('project-data');}
  return result;
 }]));
}
for(const fixture of ['article','thesis'])test(`${fixture}: served agent examples survive successful and failed compiles within result budgets`,async({page},testInfo)=>{
 await page.goto(app);const chooser=page.waitForEvent('filechooser');await page.getByRole('button',{name:'Import ZIP',exact:true}).click();await(await chooser).setFiles(`public/fixtures/${fixture}.zip`);
 await expect(page.getByRole('textbox',{name:'LaTeX source',exact:true})).toBeVisible();const api=await recipe(page,testInfo);
 const description=await api.describe();expect(description.experimental).toBe(true);expect(description.recipe).toBe('agent.md');expect(description.build.revision).toMatch(/^[a-f0-9]{40}$/);expect(description.operations.filter(op=>op.startsWith('agent.'))).toHaveLength(9);expect(description.sourceScope).toContain('no UI activation');
 expect(await page.title()).toBe(`${fixture} — Scribyra`);expect(await page.evaluate(()=>window.scribyra.v1)).toBeUndefined();
 const status=await api.status(),tree=await api.tree({path:'main.tex'});expect(status.value.name).toBe(fixture);const main=tree.value.items.find(f=>f.id===status.value.mainFile);
 async function compile(success){
  const start=await api.compile(),jobId=start.value.jobId;expect(start.value.status).toBe('running');
  const pending=await api.diagnostics({jobId});expect(pending.value.status).toBe('running');expect(pending.value.message).toContain('still running');
  let result;await expect.poll(async()=>{result=await api.poll({jobId,waitMs:25000});return result.value.status;},{timeout:180000,intervals:[250,1000]}).not.toBe('running');
  expect(result.value.status).toBe(success?'succeeded':'failed');expect(result.value.success).toBe(success);expect(result.value.pages).toBe(success?(fixture==='thesis'?100:1):0);
  await expect(page.getByRole('status',{name:'Compilation status',exact:true})).toContainText(success?'Compiled':'Failed');
  return {jobId,result,issues:await api.diagnostics({jobId,limit:10})};
 }
 const built=await compile(true);expect(built.result.value.warnings).toBe(0);expect(built.issues.value.items).toEqual([]);
 const download=page.waitForEvent('download'),exported=await api.export();expect(exported.value.download).toBe(true);expect((await download).suggestedFilename()).toBe(`${fixture}.pdf`);
 let file=main;
 if(fixture==='thesis'){
  const listing=await page.evaluate(()=>window.scribyra.agent.readTree({limit:100}));expect(listing.value.items).toHaveLength(100);expect(Buffer.byteLength(JSON.stringify(listing,null,2))).toBeLessThan(18000);
  const found=await api.tree({path:'chapters/page-050.tex'});file=found.value.items[0];
  expect(Object.keys(file).sort()).toEqual(['id','kind','path','size']);expect(file.kind).toBe('text');expect(file.size).toBeGreaterThan(0);
  await expect(page.getByRole('tab',{name:file.path,exact:true})).toHaveCount(0);
 }
 const read=await api.source({path:file.path,startLine:1,endLine:11});expect(read.value.content).toContain(fixture==='thesis'?'Research is a conversation':'The Gaussian integral');
 expect(read.value.path).toBe(file.path);expect(read.value.activationRequired).toBe(false);
 await page.context().setOffline(true);
 const lines=read.value.content.split('\n'),text=lines[5],offset=read.value.offset+lines.slice(0,5).join('\n').length+1;
 await api.patch({expectedRevision:read.revision,requestId:'introduce-error',edits:[{path:file.path,start:offset,end:offset+text.length,before:text,after:'\\undefinedcmd '+text}]});
 if(fixture==='thesis'){expect((await api.status()).value.activeFile.id).toBe(main.id);await expect(page.getByRole('tab',{name:file.path,exact:true})).toHaveCount(0);}
 const failed=await compile(false);expect(failed.result.value.warnings).toBe(0);expect(failed.issues.value.items.some(i=>i.file===file.path&&i.line===6)).toBe(true);
 await page.getByRole('list',{name:'Compilation issues'}).getByRole('link',{name:`${file.path}:6`,exact:true}).click();const source=page.getByRole('textbox',{name:'LaTeX source',exact:true});await expect(source).toBeFocused();await expect(source.locator('[data-line="6"]')).toContainText('\\undefinedcmd');
 await page.keyboard.press('Control+z');await compile(true);
 await page.context().setOffline(false);
 const start=await api.compile();await api.cancel({jobId:start.value.jobId});await expect.poll(async()=>(await api.poll({jobId:start.value.jobId})).value.status).toBe('cancelled');
 await expect(page.getByRole('button',{name:'Compile',exact:true})).toBeEnabled();
 await page.evaluate(()=>window.retainedAgent=window.scribyra.agent);await page.getByRole('button',{name:'All projects',exact:true}).click();expect((await page.evaluate(()=>window.retainedAgent.status())).error.code).toBe('project_closed');
});
test('head discovery has no accessible body cost; recipe navigation stays Markdown offline',async({page,context},testInfo)=>{
 await page.goto(app);await expect(page.getByRole('button',{name:'Import ZIP',exact:true})).toBeVisible();const link=page.locator('head link[rel="alternate"][type="text/markdown"]');await expect(link).toHaveAttribute('href',new URL('agent.md',page.url()).pathname);
 const recipeUrl=new URL('agent.md',page.url()).href;
 expect(await link.ariaSnapshot({mode:'ai'})).toBe('');
 const withLink=await page.locator('body').ariaSnapshot({mode:'ai'}),markup=await link.evaluate(node=>node.outerHTML);
 await link.evaluate(node=>node.remove());expect(await page.locator('body').ariaSnapshot({mode:'ai'})).toBe(withLink);
 await testInfo.attach('discovery',{body:JSON.stringify({headBytes:Buffer.byteLength(markup),snapshotDeltaBytes:0}),contentType:'application/json'});
 const response=await page.request.get(new URL('agent.md',page.url()).href),text=await response.text();expect(response.headers()['content-type']).toContain('text/markdown');
 await page.waitForFunction(()=>navigator.serviceWorker.controller);
 await context.setOffline(true);
 try{
  const response=await page.goto(recipeUrl);expect(response.headers()['content-type']).toContain('text/markdown');expect(await page.locator('body').textContent()).toBe(text);
  await page.evaluate(async url=>{for(const name of await caches.keys())await(await caches.open(name)).delete(url);},recipeUrl);
  // Firefox can still satisfy a navigation from its HTTP cache while offline.
  const uncached=await page.goto(`${recipeUrl}?uncached=1`).catch(()=>null);
  expect(page.context().browser().isConnected()).toBe(true);
  if(uncached){expect(uncached.headers()['content-type']).toContain('text/markdown');expect(await page.locator('body').textContent()).toBe(text);}
 }finally{await context.setOffline(false);}
});

test('served suggestion reply route is discoverable, attributed and leaves source unchanged',async({page})=>{
 await page.goto(app);await page.getByRole('button',{name:'Start with a sample paper'}).click();await expect(page.locator('.cm-content')).toBeVisible();
 const recipe=await (await page.request.get(new URL('agent.md',page.url()).href)).text();expect(Buffer.byteLength(recipe)).toBeLessThan(2000);expect(recipe).toContain('thread.reply {suggestionId,body}');
 const result=await page.evaluate(async()=>{
  const api=window.scribyra.agent,description=api.describe(),before=api.readSource({path:'main.tex',startLine:1,endLine:200}).value;
  const call=async command=>{const r=await api.execute({version:2,requestId:crypto.randomUUID(),projectId:description.projectId,expectedRevision:api.status().revision,command});if(!r.ok)throw Error(JSON.stringify(r));return r.value;};
  const review=await call({op:'review.create',title:'Agent discussion'}),s=await call({op:'suggestion.propose',reviewId:review.reviewId,fileId:before.fileId,start:0,end:0,before:'',after:'% Proposal\n'});
  const reply=await call({op:'thread.reply',suggestionId:s.suggestionId,body:'Please keep the notation consistent.'}),thread=await call({op:'thread.get',id:reply.threadId});
  return{operations:description.operations,before:before.content,after:api.readSource({path:'main.tex',startLine:1,endLine:200}).value.content,suggestionId:s.suggestionId,thread};
 });
 expect(result.operations).toEqual(expect.arrayContaining(['thread.create','thread.reply']));expect(result.after).toBe(result.before);expect(result.thread.thread.suggestionId).toBe(result.suggestionId);expect(result.thread.items.find(i=>i.variants)?.authorName).toContain('(agent)');
});
