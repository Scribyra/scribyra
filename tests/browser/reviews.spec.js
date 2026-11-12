import {openReviews,openReview,openComments} from './review-ui.js';
import {test,expect} from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import {build} from 'esbuild';
import {readFile,readdir} from 'node:fs/promises';
import {texRuntimeIdentity,texRuntimeAssets} from '../../scripts/tex-environment.mjs';
test.use({serviceWorkers:'block'});
const source=await readFile('tests/reviews.test.mjs','utf8');
const fixture='let reviewAnchors=productionAnchors;'+source.split('let reviewAnchors=contractAnchors;')[1].split('// END REVIEW CONTRACT FIXTURE')[0];
const imports=`
import * as Y from './node_modules/yjs/dist/yjs.mjs';
import {addFile,migrateProject,exportZip,snapshot,relocateNode} from './web/model.js';
import * as storage from './web/storage.js';
import {cloneProject} from './web/assets.js';
import {collaborationCommands} from './web/collaboration-commands.js';
import {reviewService,projection,resolveSuggestion,anchorsAvailable} from './web/review-commands.js';
import {anchors as productionAnchors} from './web/comment-anchors.js';
import {mount as mountReviews} from './web/reviews.js';
import {LIMITS} from './web/collaboration-schema.js';
import {reviewPreview} from './web/review-preview.js';
import {reviewExchange} from './web/review-exchange.js';
import {buildCoordinator} from './web/build-session.js';
export {Y,storage,cloneProject,projection,productionAnchors,anchorsAvailable,mountReviews,LIMITS};
`;
let harness,wasm,main;
test.beforeAll(async()=>{
 const r=await build({stdin:{contents:imports+fixture+`\nimport init from './web/pkg/scribyra_app.js';import {initializeCollaborationSchema} from './web/collaboration-schema.js';await init('/reviews.wasm');initializeCollaborationSchema();export const available=anchorsAvailable(reviewAnchors);`,resolveDir:process.cwd()},bundle:true,format:'esm',platform:'browser',write:false,loader:{'.css':'empty'}});harness=r.outputFiles[0].text;wasm=await readFile('web/pkg/scribyra_app_bg.wasm');
 const m=await build({entryPoints:['web/main.js'],bundle:true,format:'esm',platform:'browser',write:false,loader:{'.css':'empty'},define:{'import.meta.env.PROD':'false','import.meta.env.BASE_URL':'"/"','import.meta.env.VITE_TELEMETRY_INGEST_URL':'undefined','import.meta.env.VITE_TELEMETRY_DESTINATION_LABEL':'undefined','import.meta.env.VITE_TELEMETRY_ABOUT_URL':'undefined','import.meta.env.VITE_TELEMETRY_SESSION_RATE':'undefined',__TEX_RUNTIME__:JSON.stringify(texRuntimeIdentity()),__TEX_ASSETS__:JSON.stringify(texRuntimeAssets())},plugins:[{name:'review-fixtures',setup(b){
  b.onResolve({filter:/\?url$/},()=>({path:'pdf-worker',namespace:'review-url'}));b.onLoad({filter:/.*/,namespace:'review-url'},()=>({contents:'export default "/review-pdf-worker.js";',loader:'js'}));
  b.onLoad({filter:/\/web\/main\.js$/},async args=>({contents:await readFile(args.path,'utf8')+`
    import {reviewService as agentReviews} from './review-commands.js';
    import {collaborationCommands as agentReviewCommands} from './collaboration-commands.js';
    import {anchors as agentAnchors} from './comment-anchors.js';
    window.reviewApp={cycle(a,b){const suggestion=doc.getMap('suggestions').get(a);doc.getMap('suggestions').set(a,{...suggestion,supersedesId:b});},async agentPropose(){
      const review=[...doc.getMap('reviews').values()][0],scope={doc,projectId,storage,flushSave,anchors:agentAnchors,author:{id:crypto.randomUUID(),kind:'agent',displayName:'Review agent',ownerAuthorId:review.acceptanceAuthorityId}};
      scope.commands=agentReviewCommands(scope);const service=agentReviews(scope);
      try{return await scope.commands.execute({version:2,requestId:crypto.randomUUID(),projectId,expectedRevision:scope.commands.revision(),command:{op:'suggestion.propose',reviewId:review.id,fileId:mountedFile,start:0,end:0,before:'',after:'% Agent proposal'}});}finally{service.close();scope.commands.close();}
    },call(command){return collaboration.commands.execute({version:2,requestId:crypto.randomUUID(),projectId,expectedRevision:collaboration.commands.revision(),command});},source:()=>doc.getText('text:'+mountedFile).toString(),select(start,end){editor.dispatch({selection:{anchor:start,head:end}});},info:()=>({fileId:mountedFile,revision:commands.revision(),accepted:window.scribyra.lastCompile}),flush:()=>flushSave(),leave:()=>leaveProject()};
  `,loader:'js'}));
 }}]});main=m.outputFiles[0].text;
});
async function routes(page,app=false,requireAnchors=true){
 await page.route('**/*',r=>new URL(r.request().url()).hostname==='127.0.0.1'?r.continue():r.abort());
 await page.route('**/reviews.js',r=>r.fulfill({contentType:'text/javascript',body:harness}));
 await page.route('**/reviews.wasm',r=>r.fulfill({contentType:'application/wasm',body:wasm}));
 if(app){const assets=await readdir('dist/assets');for(const worker of ['tex-packages-worker','workspace-worker'])await page.route(`**/assets/${worker}.js`,r=>r.fulfill({contentType:'text/javascript',path:`dist/assets/${assets.find(name=>name.startsWith(worker+'-')&&name.endsWith('.js'))}`}));await page.route('**/assets/index-*.js',r=>r.fulfill({contentType:'text/javascript',body:main}));await page.route('**/scribyra_app_bg.wasm',r=>r.fulfill({contentType:'application/wasm',body:wasm}));await page.route('**/review-pdf-worker.js',r=>r.fulfill({contentType:'text/javascript',path:'node_modules/pdfjs-dist/build/pdf.worker.min.mjs'}));}
 await page.goto('/');
 if(requireAnchors)expect(await page.evaluate(async()=>(await import('/reviews.js')).available),'Production M5 anchors are unavailable.').toBe(true);
}
test('production panel follows production anchor availability',async({page})=>{
 await routes(page,false,false);
 const available=await page.evaluate(async()=>{const m=await import('/reviews.js');return m.anchorsAvailable(m.productionAnchors);});
 await page.getByRole('button',{name:'Start with a sample paper'}).click();await expect(page.locator('.cm-content')).toBeVisible();
 if(available){await openComments(page);await expect(page.getByText('Reviews and proposed changes',{exact:true})).toBeVisible();}
 else{
  await expect(page.getByRole('status',{name:'Review status',exact:true})).toHaveText('Reviews are not available in this build.');
  await expect(page.locator('.reviews-panel')).toHaveCount(0);await expect(page.getByRole('button',{name:'Create review',exact:true})).toHaveCount(0);
  const disabled=await page.evaluate(async()=>{const m=await import('/reviews.js'),f=await m.reviewFixture();f.service.close();f.exchange.close();let state;const panel=m.mountReviews({...f.context,anchors:m.productionAnchors,onState:s=>state=s});try{return{state,actions:Object.keys(panel.actions),commands:f.host.describe()};}finally{panel.close();await f.close();}});
  expect(disabled.state.enabled).toBe(false);expect(disabled.actions).toEqual([]);expect(disabled.commands).toEqual([]);
 }
});
const names=[...fixture.matchAll(/async '([^']+)'\(/g)].map(m=>m[1]);
for(const name of names)test(name,async({page})=>{await routes(page);await page.evaluate(async name=>{const m=await import('/reviews.js');await m.reviewCases[name]();},name);});
for(const other of ['accept','reject'])test(`two actual authority tabs serialize accept/${other}`,async({page,context})=>{
 await routes(page);const seed=await page.evaluate(async()=>{const m=await import('/reviews.js');window.reviewFixture=await m.reviewFixture();const f=window.reviewFixture,s=await f.propose(0,5,'A');await f.context.flushSave();return{projectId:f.projectId,author:f.author,id:s.value.suggestionId};});
 const peer=await context.newPage();try{await routes(peer);await peer.evaluate(async seed=>{const m=await import('/reviews.js');window.reviewFixture=await m.reviewFixture({doc:await m.storage.loadProject(seed.projectId),projectId:seed.projectId,author:seed.author});},seed);
 const replies=await Promise.all([page.evaluate(id=>window.reviewFixture.accept([id]),seed.id),peer.evaluate(async({id,other})=>{const f=window.reviewFixture;return other==='accept'?f.accept([id]):f.call({op:'suggestion.reject',suggestionId:id,eventHeads:[]});},{id:seed.id,other})]);
 expect(replies.filter(r=>r.ok)).toHaveLength(1);expect(replies.filter(r=>!r.ok).map(r=>r.error.code)).toEqual(['revision_conflict']);
 const committed=await page.evaluate(async({projectId,id})=>{const m=await import('/reviews.js'),d=await m.storage.loadProject(projectId);const out={source:d.getText('text:main').toString(),events:[...d.getMap('discussionEvents').values()].filter(e=>e.targetId===id).length};d.destroy();return out;},seed);expect(committed.events).toBe(1);expect(['alpha bravo charlie','A bravo charlie']).toContain(committed.source);
 }finally{await peer.evaluate(()=>window.reviewFixture?.close());await peer.close();await page.evaluate(()=>window.reviewFixture.close());}
});
test('crash after commit recovers one accepted patch on reopen',async({page,context})=>{
 await routes(page);const seed=await page.evaluate(async()=>{const m=await import('/reviews.js'),f=await m.reviewFixture();window.reviewFixture=f;const s=await f.propose(0,5,'A');await f.context.flushSave();const gateway=m.storage.commitPrepared;f.context.storage={...m.storage,async commitPrepared(...args){const r=await gateway(...args);f.host.close();return r;}};const receipt=await f.accept([s.value.suggestionId]);return{projectId:f.projectId,id:s.value.suggestionId,receipt};});
 expect(seed.receipt.ok).toBe(false);await page.close();const reopened=await context.newPage();try{await routes(reopened);const stored=await reopened.evaluate(async seed=>{const m=await import('/reviews.js'),d=await m.storage.loadProject(seed.projectId);return{source:d.getText('text:main').toString(),status:m.projection(d,seed.id).status};},seed);expect(stored).toEqual({source:'A bravo charlie',status:'accepted'});}finally{await reopened.close();}
});
test('separate profiles exchange pending proposals and reimport without duplicate patch',async({page,browser})=>{
 await routes(page);const seed=await page.evaluate(async()=>{const m=await import('/reviews.js'),f=await m.reviewFixture();window.reviewFixture=f;const r=await f.call({op:'review.create',title:'Portable'});return{update:Array.from(m.Y.encodeStateAsUpdate(f.doc)),reviewId:r.value.reviewId};});
 const remote=await browser.newContext({serviceWorkers:'block'}),peer=await remote.newPage();try{await routes(peer);const bytes=await peer.evaluate(async seed=>{const m=await import('/reviews.js'),doc=new m.Y.Doc();m.Y.applyUpdate(doc,new Uint8Array(seed.update));const projectId=crypto.randomUUID();await m.storage.saveProject(projectId,doc);const f=await m.reviewFixture({doc,projectId});window.reviewFixture=f;const s=await f.propose(0,5,'A','main',seed.reviewId),denied=await f.accept([s.value.suggestionId]);if(denied.error.code!=='authority_unavailable')throw new Error('Foreign profile accepted');return Array.from(f.exchange.encode([seed.reviewId]));},seed);
 const final=await page.evaluate(async bytes=>{const f=window.reviewFixture;let id;for(let n=0;n<2;n++){const p=await f.call({op:'review.importPlan',attachmentRef:'portable'},new Map([['portable',new Uint8Array(bytes)]]));if(!p.ok)throw new Error(JSON.stringify(p));const r=await f.call({op:'review.import',planId:p.value.planId});if(!r.ok)throw new Error(JSON.stringify(r));id=[...f.doc.getMap('suggestions').keys()][0];if(!n){const a=await f.accept([id]);if(!a.ok)throw new Error(JSON.stringify(a));}}return{source:f.source(),count:f.doc.getMap('suggestions').size};},bytes);expect(final).toEqual({source:'A bravo charlie',count:1});
 }finally{await remote.close();await page.evaluate(()=>window.reviewFixture.close());}
});
test('accessible panel creates and accepts a proposal, real preview preserves accepted PDF',async({page,context})=>{
 await routes(page,true);await page.getByRole('button',{name:'Start with a sample paper'}).click();await expect(page.locator('.cm-content')).toBeVisible();
 await page.getByRole('button',{name:'Compile',exact:true}).click();await expect.poll(()=>page.evaluate(()=>window.scribyra.lastCompile),{timeout:180000}).toBeTruthy();const first=await page.evaluate(()=>window.scribyra.lastCompile);expect(first.success,first.log).toBe(true);
 const accepted=await page.evaluate(()=>({id:window.scribyra.lastCompile.jobId,source:window.reviewApp.source()}));
 await openReviews(page);await page.getByLabel('Review title',{exact:true}).fill('Accessible review');await page.getByRole('button',{name:'Create review',exact:true}).click();await expect(page.getByRole('heading',{name:'Accessible review',exact:true})).toHaveCount(1);
 await page.getByLabel('Replacement text (empty deletes selection)').fill('% Proposed preview\n');await page.evaluate(()=>window.reviewApp.select(0,0));await page.getByRole('button',{name:'Propose selected source'}).click();await expect(page.getByRole('button',{name:'Accept suggestion',exact:true})).toHaveCount(1);
 await page.getByRole('button',{name:'Preview suggestion',exact:true}).click();await page.getByRole('button',{name:'Cancel review preview',exact:true}).click();await expect(page.getByRole('status',{name:'Review status',exact:true})).toContainText(/cancelled/i);
 await page.getByRole('button',{name:'Preview suggestion',exact:true}).click();await expect(page.getByRole('link',{name:'Download isolated preview PDF'})).toBeVisible({timeout:180000});
 expect(await page.evaluate(()=>window.reviewApp.source())).toBe(accepted.source);expect(await page.evaluate(()=>window.scribyra.lastCompile.jobId)).toBe(accepted.id);
 const violations=(await new AxeBuilder({page}).include('.reviews-panel').analyze()).violations;expect(violations).toEqual([]);
 await page.getByRole('button',{name:'Accept suggestion',exact:true}).focus();await page.keyboard.press('Enter');await expect.poll(()=>page.evaluate(()=>window.reviewApp.source())).toBe('% Proposed preview\n'+accepted.source);
 await page.getByRole('button',{name:'Undo acceptance batch'}).click();await expect.poll(()=>page.evaluate(()=>window.reviewApp.source())).toBe(accepted.source);
 expect((await page.evaluate(()=>window.reviewApp.agentPropose())).ok).toBe(true);await page.evaluate(()=>window.reviewApp.flush());
 const peer=await context.newPage();try{await routes(peer,true);await peer.locator('.card-open').first().click();await openReviews(peer);await expect(peer.locator('.reviews-panel').getByText('Agent · Review agent',{exact:false})).toBeVisible();}finally{await peer.close();}
 await page.evaluate(()=>window.reviewApp.leave());
});

test('offline reviewer retains proposals while authority is absent',async({page,context})=>{
 await routes(page);await page.evaluate(async()=>{window.reviewModule=await import('/reviews.js');});await context.setOffline(true);
 try{const outcome=await page.evaluate(async()=>{const m=window.reviewModule,f=await m.reviewFixture();try{const r=await f.call({op:'review.create',title:'Offline review'});const peer=await m.reviewFixture({doc:m.cloneProject(f.doc),projectId:f.projectId});try{const s=await peer.propose(0,5,'A','main',r.value.reviewId);const denied=await peer.accept([s.value.suggestionId]);return{code:denied.error.code,source:peer.source(),bytes:peer.exchange.encode([r.value.reviewId]).length};}finally{await peer.close();}}finally{await f.close();}});expect(outcome.code).toBe('authority_unavailable');expect(outcome.source).toBe('alpha bravo charlie');expect(outcome.bytes).toBeGreaterThan(0);}finally{await context.setOffline(false);}
});

test('batch UI accepts only displayed proposals, leaving a hidden pending proposal untouched',async({page})=>{
 await routes(page,true);await page.getByRole('button',{name:'Start with a sample paper'}).click();await expect(page.locator('.cm-content')).toBeVisible();
 const expected=await page.evaluate(async()=>{
  const app=window.reviewApp,source=app.source(),fileId=app.info().fileId,created=await app.call({op:'review.create',title:'Bounded review'});if(!created.ok)throw new Error(JSON.stringify(created));
  const characters=source.split('');let first;
  for(let i=0;i<101;i++){const start=i*2,before=source.slice(start,start+1),after=before==='X'?'Y':'X',r=await app.call({op:'suggestion.propose',reviewId:created.value.reviewId,fileId,start,end:start+1,before,after});if(!r.ok)throw new Error(JSON.stringify(r));if(!i)first=r.value.suggestionId;if(i>0&&i<100)characters[start]=after;}
  const rejected=await app.call({op:'suggestion.reject',suggestionId:first,eventHeads:[]});if(!rejected.ok)throw new Error(JSON.stringify(rejected));return characters.join('');
 });
 await openReviews(page);await expect(page.getByRole('button',{name:'Accept suggestion',exact:true})).toHaveCount(100);
 await page.getByRole('button',{name:'Accept displayed pending suggestions',exact:true}).click();await page.getByRole('dialog',{name:'Accept suggestions',exact:true}).getByRole('button',{name:'Continue',exact:true}).click();await expect.poll(()=>page.evaluate(()=>window.reviewApp.source())).toBe(expected);await page.evaluate(()=>window.reviewApp.leave());
});

test('file picker rejects oversize before reading and keeps byte-level validation',async({page})=>{
 await routes(page,true);await page.getByRole('button',{name:'Start with a sample paper'}).click();await expect(page.locator('.cm-content')).toBeVisible();await openReviews(page);
 await page.evaluate(()=>{window.reviewFileReads=0;File.prototype.arrayBuffer=function(){window.reviewFileReads++;return Promise.resolve(new Uint8Array(16*1024*1024+1).buffer);};});
 const choose=async size=>{const chooser=page.waitForEvent('filechooser');await page.getByRole('button',{name:'Import review package',exact:true}).click();await(await chooser).setFiles({name:'oversize.scribyra-review',mimeType:'application/json',buffer:Buffer.alloc(size)});};
 await choose(16*1024*1024+1);await expect(page.getByRole('status',{name:'Review status',exact:true})).toContainText('exceeds 16 MiB');expect(await page.evaluate(()=>window.reviewFileReads)).toBe(0);
 await choose(1);await expect(page.getByRole('status',{name:'Review status',exact:true})).toContainText('Invalid or oversized review package');expect(await page.evaluate(()=>window.reviewFileReads)).toBe(1);
 await expect(page.getByRole('heading',{name:'Pending review',exact:true})).toHaveCount(0);await page.evaluate(()=>window.reviewApp.leave());
});

test('stale overlapping proposal stays conflicted in a reloaded peer tab after undo',async({page,context})=>{
 await routes(page);const seed=await page.evaluate(async()=>{
  const m=await import('/reviews.js'),f=await m.reviewFixture();window.reviewFixture=f;
  const a=await f.propose(6,11,'A'),text=f.doc.getText('text:main');f.doc.transact(()=>{text.delete(8,1);text.insert(8,'a');});
  if(f.service.status(f.doc.getMap('suggestions').get(a.value.suggestionId))!=='conflicted')throw new Error('A should conflict before B');
  const b=await f.propose(6,11,'B'),accepted=await f.accept([b.value.suggestionId]);if(!accepted.ok)throw new Error(JSON.stringify(accepted));
  const undone=await f.call({op:'change.undo',changeId:accepted.value.changeId,eventHeads:{[b.value.suggestionId]:f.heads(b.value.suggestionId)}});if(!undone.ok)throw new Error(JSON.stringify(undone));
  return{projectId:f.projectId,author:f.author,id:a.value.suggestionId};
 });
 const peer=await context.newPage();try{
  await routes(peer);await peer.reload();
  const outcome=await peer.evaluate(async seed=>{const m=await import('/reviews.js'),f=await m.reviewFixture({doc:await m.storage.loadProject(seed.projectId),projectId:seed.projectId,author:seed.author});try{return{status:f.service.status(f.doc.getMap('suggestions').get(seed.id)),receipt:await f.accept([seed.id]),source:f.source()};}finally{await f.close();}},seed);
  expect(outcome.status).toBe('conflicted');expect(outcome.receipt.ok).toBe(false);expect(outcome.receipt.error.code).toBe('suggestion_conflict');expect(outcome.source).toBe('alpha bravo charlie');
 }finally{await peer.close();await page.evaluate(()=>window.reviewFixture.close());}
});

// Projection remains usable for an already-open corrupt replica, even though ingress rejects it.
test('cyclic grouping keeps both original discussion cards explicitly incomplete',async({page})=>{
 await routes(page,true);await page.getByRole('button',{name:'Start with a sample paper'}).click();await expect(page.locator('.cm-content')).toBeVisible();
 const ids=await page.evaluate(async()=>{
  const call=async command=>{const r=await window.reviewApp.call(command);if(!r.ok)throw Error(JSON.stringify(r));return r.value;};
  const fileId=window.reviewApp.info().fileId,review=await call({op:'review.create',title:'Incomplete grouping'});
  const a=await call({op:'suggestion.propose',reviewId:review.reviewId,fileId,start:0,end:0,before:'',after:'First'});
  await call({op:'thread.reply',suggestionId:a.suggestionId,body:'First original reply'});
  const b=await call({op:'suggestion.revise',reviewId:review.reviewId,fileId,start:0,end:0,before:'',after:'Second',supersedesId:a.suggestionId});
  await call({op:'thread.reply',suggestionId:b.suggestionId,body:'Second original reply'});
  window.reviewApp.cycle(a.suggestionId,b.suggestionId);return[a.suggestionId,b.suggestionId];
 });
 await openReview(page);await expect(page.locator('.review-card')).toHaveCount(2);
 for(const [i,id] of ids.entries()){
  const card=page.locator(`[data-card-id="${id}"]`);await expect(card).toContainText('Discussion grouping is incomplete');await card.locator('.review-card-head').first().click();await expect(card).toContainText(i?'Second original reply':'First original reply');await expect(card.getByRole('button',{name:'Accept',exact:true})).toBeDisabled();
 }
});
