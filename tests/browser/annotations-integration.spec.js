import {openComments,openReviews} from './review-ui.js';
import {test,expect} from '@playwright/test';
import {build} from 'esbuild';
import {readFile} from 'node:fs/promises';

test.use({actionTimeout:15000});
const source='\\documentclass{article}\n\\begin{document}\nalpha bravo charlie\n\\end{document}\n';
async function call(page,command){
 const result=await page.evaluate(async command=>{const api=window.scribyra.agent;return api.execute({version:2,requestId:crypto.randomUUID(),projectId:api.describe().projectId,expectedRevision:api.status().revision,command});},command);
 expect(result.ok,JSON.stringify(result)).toBe(true);return result.value;
}
async function setup(page){
 await page.goto('/');await page.getByRole('button',{name:'Start with a sample paper'}).click();await expect(page.locator('.cm-content')).toBeVisible();
 const fileId=await page.evaluate(source=>{const api=window.scribyra.agent,read=api.readSource({path:'main.tex',startLine:1,endLine:200}),result=api.patchSource({expectedRevision:read.revision,edits:[{path:'main.tex',start:0,end:read.value.content.length,before:read.value.content,after:source}]});if(!result.ok)throw Error(JSON.stringify(result));return api.status().value.mainFile;},source);
 return{fileId,start:source.indexOf('alpha'),end:source.indexOf('alpha')+5};
}
async function discussion(page,selection){
 const thread=await call(page,{op:'thread.create',...selection,body:'Keep alpha',mentions:[]}),review=await call(page,{op:'review.create',title:'Integrated review'}),suggestion=await call(page,{op:'suggestion.propose',reviewId:review.reviewId,...selection,before:'alpha',after:'ALPHA'});
 return{thread,review,suggestion};
}
const heads=(review,id)=>review.items.filter(item=>item.targetId===id).filter(item=>!review.items.some(child=>child.parents?.includes(item.id))).map(item=>item.id);
async function showThread(page,id){
 await openComments(page);
 await page.getByLabel('Show comment threads').selectOption('all');await page.evaluate(id=>window.scribyra.action('comment-open',id),id);
 await expect(page.getByRole('list',{name:'Messages'}).getByText('Keep alpha',{exact:true})).toBeVisible();
}

test('comment and suggestion share text through source undo and acceptance undo',async({page})=>{
 const selection=await setup(page),{thread,review,suggestion}=await discussion(page,selection);
 const editor=page.getByRole('textbox',{name:'LaTeX source',exact:true});await editor.focus();await page.keyboard.press('Control+Home');await page.keyboard.insertText('% outside\n');await page.keyboard.press('Control+z');
 let detail=await call(page,{op:'thread.get',id:thread.threadId});expect(detail.thread.anchorStatus).toBe('attached');
 await page.evaluate(({start,end})=>{const view=document.querySelector('.cm-content').cmTile.root.view;view.dispatch({selection:{anchor:start,head:end}});view.focus();},selection);await page.keyboard.press('Backspace');
 expect((await call(page,{op:'thread.get',id:thread.threadId})).thread.anchorStatus).toBe('detached');expect((await call(page,{op:'review.get',id:review.reviewId})).items.find(i=>i.id===suggestion.suggestionId).status).toBe('conflicted');
 await page.keyboard.press('Control+z');expect((await call(page,{op:'thread.get',id:thread.threadId})).thread.anchorStatus).toBe('attached');expect((await call(page,{op:'review.get',id:review.reviewId})).items.find(i=>i.id===suggestion.suggestionId).status).toBe('pending');
 const batch=await call(page,{op:'suggestion.accept',suggestionIds:[suggestion.suggestionId],eventHeads:{[suggestion.suggestionId]:[]}});
 await showThread(page,thread.threadId);await expect(page.locator('.comment-thread-link')).toContainText('detached');
 const accepted=await call(page,{op:'review.get',id:review.reviewId});expect(accepted.items.find(i=>i.id===suggestion.suggestionId).status).toBe('accepted');
 await call(page,{op:'change.undo',changeId:batch.changeId,eventHeads:{[suggestion.suggestionId]:heads(accepted,suggestion.suggestionId)}});
 detail=await call(page,{op:'thread.get',id:thread.threadId});expect(detail.thread.anchorStatus).toBe('attached');expect(detail.thread.start).toBe(selection.start);expect(detail.thread.end).toBe(selection.end);
 expect((await call(page,{op:'review.get',id:review.reviewId})).items.find(i=>i.id===suggestion.suggestionId).status).toBe('pending');
 await expect(page.locator('.save-indicator')).toHaveText('Saved locally');await page.reload();await page.locator('.card-open').first().click();await expect(editor).toBeVisible();await showThread(page,thread.threadId);await expect(page.locator('.comment-thread-link')).toContainText('attached');
});

test('current restore and complete backup retain pending proposals, resolved threads and local authority',async({page})=>{
 const selection=await setup(page),{thread,review,suggestion}=await discussion(page,selection);
 await call(page,{op:'thread.resolve',threadId:thread.threadId,eventHeads:[]});await call(page,{op:'review.submit',reviewId:review.reviewId,eventHeads:[]});
 const named=await call(page,{op:'history.name',label:'Resolved and pending'});
 await call(page,{op:'suggestion.accept',suggestionIds:[suggestion.suggestionId],eventHeads:{[suggestion.suggestionId]:[]}});
 const plan=await call(page,{op:'history.restorePlan',checkpointRef:named.checkpointRef,mode:'current'});await call(page,{op:'history.restore',planId:plan.planId});
 await showThread(page,thread.threadId);await expect(page.locator('.comment-thread-link')).toContainText('resolved · attached');
 await expect(page.getByRole('button',{name:'Reopen thread',exact:true})).toBeVisible();
 const restored=await call(page,{op:'review.get',id:review.reviewId});expect(restored.items.find(i=>i.id===suggestion.suggestionId).status).toBe('pending');
 await openReviews(page);await expect(page.getByText('submitted',{exact:true})).toBeVisible();await expect(page.getByText('Acceptance authority: this profile',{exact:true})).toBeVisible();
 const artifact=await call(page,{op:'backup.export'});expect(artifact.size).toBeGreaterThan(0);const part=await call(page,{op:'artifact.read',artifactId:artifact.artifactId});expect(part.attachmentRef).toBeTruthy();
 const reviewArtifact=await call(page,{op:'review.export',reviewIds:[review.reviewId]});expect((await call(page,{op:'artifact.read',artifactId:reviewArtifact.artifactId})).attachmentRef).toBeTruthy();
 await page.getByRole('button',{name:'History',exact:true}).click();await expect(page.getByRole('status',{name:'History status',exact:true})).toContainText('stored on this device');
 await page.getByRole('button',{name:'Manage history',exact:true}).click();const download=page.waitForEvent('download');await page.getByRole('button',{name:'Export complete backup',exact:true}).click();const bytes=Array.from(await readFile(await(await download).path()));await expect(page.getByRole('status',{name:'History status',exact:true})).toContainText('exported');await page.getByRole('button',{name:'History',exact:true}).click();
 const imported=await page.evaluate(async bytes=>{const api=window.scribyra.agent,projectId=api.describe().projectId,ref=crypto.randomUUID(),execute=(command,attachments)=>api.execute({version:2,requestId:crypto.randomUUID(),projectId,expectedRevision:api.status().revision,command},attachments),plan=await execute({op:'backup.importPlan',attachmentRef:ref},new Map([[ref,new Uint8Array(bytes)]]));if(!plan.ok)throw Error(JSON.stringify(plan));return execute({op:'backup.import',planId:plan.value.planId});},bytes);expect(imported.ok,JSON.stringify(imported)).toBe(true);
 await page.evaluate(id=>window.scribyra.action('open',id),imported.value.projectId);await showThread(page,thread.threadId);await expect(page.locator('.comment-thread-link')).toContainText('resolved · attached');await openReviews(page);await expect(page.getByText('submitted',{exact:true})).toBeVisible();await expect(page.getByText('Acceptance authority: this profile',{exact:true})).toBeVisible();
 expect((await call(page,{op:'review.get',id:review.reviewId})).items.find(i=>i.id===suggestion.suggestionId).status).toBe('pending');
 await page.getByRole('button',{name:'Accept suggestion',exact:true}).click();await expect(page.getByText(/· accepted$/)).toBeVisible();
});

test('annotation changes preserve accepted PDF while preview runs during a comment edit',async({page})=>{
 const selection=await setup(page);
 const job=await page.evaluate(()=>window.scribyra.agent.compile());expect(job.ok).toBe(true);
 await expect.poll(()=>page.evaluate(id=>window.scribyra.agent.poll({jobId:id}),job.value.jobId),{timeout:180000}).toMatchObject({ok:true,value:{status:'succeeded',stale:false}});
 const accepted=await page.evaluate(()=>window.scribyra.lastCompile.jobId),{thread}=await discussion(page,selection);
 await showThread(page,thread.threadId);await page.getByRole('button',{name:'Edit message',exact:true}).click();await page.getByLabel('Comment body').fill('Edited during preview');
 await openReviews(page);await page.getByRole('button',{name:'Preview suggestion',exact:true}).click();
 await expect(page.getByRole('button',{name:'Cancel review preview',exact:true})).toBeEnabled();await page.getByRole('button',{name:'Send comment',exact:true}).click();
 await expect(page.getByRole('list',{name:'Messages'}).getByText('Edited during preview',{exact:true})).toBeVisible();await expect(page.getByRole('link',{name:'Download isolated preview PDF'})).toBeVisible({timeout:180000});
 expect(await page.evaluate(()=>window.scribyra.lastCompile.jobId)).toBe(accepted);
 const pdf=await page.evaluate(()=>window.scribyra.agent.exportPdf());expect(pdf.ok).toBe(true);expect(pdf.value.stale).toBe(false);
 expect(await page.evaluate(()=>window.scribyra.agent.readSource({path:'main.tex',startLine:1,endLine:200}).value.content)).toBe(source);
});

let deniedHarness,wasm;
test.beforeAll(async()=>{
 const contents=`import init from './web/pkg/scribyra_app.js';import * as Y from 'yjs';import {initializeCollaborationSchema} from './web/collaboration-schema.js';import {addFile} from './web/model.js';import {mountCollaboration} from './web/collaboration.js';import {agentCommands} from './web/agent-commands.js';import * as storage from './web/storage.js';
 await init('/integration.wasm');initializeCollaborationSchema();
 export async function denied(){const doc=new Y.Doc(),projectId=crypto.randomUUID(),fileId=addFile(doc,'main.tex','alpha'),author={id:crypto.randomUUID(),kind:'human',displayName:'Restricted'};await storage.saveProject(projectId,doc);const collaboration=mountCollaboration({doc,projectId,author,storage,managers:new Map(),capabilities:[]}),agent=agentCommands({doc,projectId,commands:collaboration.commands,owner:author,getState:()=>({active:fileId}),isBusy:()=>false}),original=window.scribyra.agent;window.scribyra.agent=agent.api;
 try{const api=window.scribyra.agent,operations=api.describe({details:true}).operations,results=[];for(const op of ['thread.list','review.list','suggestion.propose','history.list','backup.export'])results.push(await api.execute({version:2,requestId:crypto.randomUUID(),projectId,expectedRevision:collaboration.commands.revision(),command:{op}}));return{operations,results};}finally{window.scribyra.agent=original;agent.close();collaboration.close();doc.destroy();}}`;
 deniedHarness=(await build({stdin:{contents,resolveDir:process.cwd()},bundle:true,format:'esm',platform:'browser',write:false,loader:{'.css':'empty'}})).outputFiles[0].text;wasm=await readFile('web/pkg/scribyra_app_bg.wasm');
});
test.describe('restricted agent host',()=>{
 test.use({serviceWorkers:'block'});
 test('agent discovers all five namespaces and enforces trusted denied rights through the real route',async({page})=>{
 await setup(page);const description=await page.evaluate(()=>window.scribyra.agent.describe());
 for(const namespace of ['thread','review','suggestion','history','backup'])expect(description.operations.some(op=>op.startsWith(namespace+'.'))).toBe(true);
 await page.route('**/integration.js',r=>r.fulfill({contentType:'text/javascript',body:deniedHarness}));await page.route('**/integration.wasm',r=>r.fulfill({contentType:'application/wasm',body:wasm}));
 const result=await page.evaluate(async()=>(await import('/integration.js')).denied());expect(result.results.map(r=>r.error.code)).toEqual(Array(5).fill('permission_denied'));
 for(const namespace of ['thread','review','suggestion','history','backup'])expect(result.operations.some(op=>op.op.startsWith(namespace+'.')&&op.capabilities.length)).toBe(true);
});
});
