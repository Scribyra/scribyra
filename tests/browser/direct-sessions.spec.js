import {test,expect,chromium,firefox} from '@playwright/test';
import {service} from '../helpers/service.mjs';
import {mkdir,readFile,readdir,writeFile} from 'node:fs/promises';
import {build} from 'esbuild';
import {zipSync,strToU8} from 'fflate';
import {openComments} from './review-ui.js';

test.use({serviceWorkers:'block'});
const sessionStatus=page=>page.getByRole('status',{name:'Direct session status'});
async function sample(page){await page.goto('/');await page.getByRole('button',{name:'Start with a sample paper'}).click();await expect(page.locator('.cm-content')).toBeVisible();}
// Share is experimental: off, it lives in More tools; on, the top bar shows it too.
async function openShare(page){const top=page.getByRole('button',{name:'Share',exact:true});if(await top.isVisible())return top.click();await page.getByRole('button',{name:'More tools',exact:true}).click();await page.getByRole('button',{name:'Share project',exact:true}).click();}
async function share(page,s,name){
 await openShare(page);await page.getByRole('checkbox',{name:'Experimental direct browser sessions'}).check();
 await page.getByRole('textbox',{name:'Connection service',exact:true}).fill(s.url);await page.getByLabel('Relay capability',{exact:true}).fill(s.bearer);await page.getByRole('textbox',{name:'Your name',exact:true}).fill(name);
}
async function invoke(page,command){return page.evaluate(async command=>{const api=window.scribyra.agent;return api.execute({version:2,requestId:crypto.randomUUID(),projectId:api.describe().projectId,expectedRevision:api.status().revision,command});},command);}
// Signing a record replicates a proof, which moves the revision a caller saw; retry as a caller would.
async function retried(page,command){let result;for(let attempt=0;attempt<20;attempt++){result=await invoke(page,command);if(result.ok||result.error.code!=='revision_conflict')break;await page.waitForTimeout(100);}return result;}
async function source(page){return page.evaluate(()=>window.scribyra.agent.readSource({path:'main.tex',startLine:1,endLine:200}).value);}
async function verify(pages,count){
 for(const page of pages)await expect(page.locator('.direct-peer .direct-code')).toHaveCount(count-1,{timeout:25000});
 for(const page of pages){const buttons=page.getByRole('button',{name:'Codes match',exact:true});while(await buttons.count())await buttons.first().click();}
 for(const page of pages)await expect(page.locator('.direct-peer').filter({hasText:'Connected'})).toHaveCount(count-1,{timeout:20000});
}
async function checkContent(pages){
 const values=await Promise.all(pages.map(source));expect(values.every(value=>JSON.stringify(value)===JSON.stringify(values[0]))).toBe(true);
}
async function exercise(browser,count,mixed=false){
 const s=await service(),contexts=[],pages=[];let extra,measurements;
 try{
  if(mixed){const type=browser.browserType().name()==='firefox'?chromium:firefox,name=type.name();extra=await type.launch({executablePath:process.env[`PLAYWRIGHT_${name.toUpperCase()}_EXECUTABLE_PATH`],...(name==='chromium'?{args:['--no-sandbox']}:{})});}
  for(let i=0;i<count;i++){
   const b=mixed&&i%2?extra:browser,context=await b.newContext({serviceWorkers:'block',viewport:{width:1366,height:768}});contexts.push(context);if(b.browserType().name()==='chromium')await context.grantPermissions(['local-network-access']);
   const page=await context.newPage();pages.push(page);await sample(page);await page.evaluate(()=>{window.directStatuses=[];new MutationObserver(()=>{const status=document.querySelector('[aria-label="Direct session status"]')?.textContent;if(status&&status!==directStatuses.at(-1)){directStatuses.push(status);if(directStatuses.length>16)directStatuses.shift();}}).observe(document.body,{subtree:true,childList:true,characterData:true});});await share(page,s,'Editor '+i);
  }
  await pages[0].getByRole('button',{name:'Start session',exact:true}).click();
  await expect(pages[0].getByRole('textbox',{name:'Invite link',exact:true})).not.toHaveValue('');
  const invite=await pages[0].getByRole('textbox',{name:'Invite link',exact:true}).inputValue();
  for(let i=1;i<count;i++){await pages[i].getByRole('textbox',{name:'Invite link',exact:true}).fill(invite);await pages[i].getByRole('button',{name:'Join invite',exact:true}).click();}
  await verify(pages,count);for(const page of pages)await expect(page.locator('.editor-status')).toContainText('Direct session');
  if(mixed){await expect(pages[0].locator('.direct-peer').filter({hasText:'Editor 1'})).toHaveAttribute('data-offerer','true');await expect(pages[1].locator('.direct-peer').filter({hasText:'Editor 0'})).toHaveAttribute('data-offerer','false');}
  if(count===2){for(const theme of ['light','dark']){await pages[0].evaluate(theme=>document.documentElement.dataset.theme=theme,theme);await pages[0].screenshot({path:`tmp/direct/connected-${browser.browserType().name()}-${theme}.png`});}}
  measurements=await Promise.all(pages.map((page,index)=>page.locator('.direct-peer').evaluateAll((rows,index)=>({profile:index,links:rows.map(row=>({name:row.querySelector('strong').textContent,offerer:row.dataset.offerer==='true',elapsedMs:Number(row.dataset.elapsedMs)}))}),index)));
  const codes=await Promise.all(pages.map(p=>p.locator('.direct-code').allTextContents()));if(count===2)expect(codes[0]).toEqual(codes[1]);
  for(const page of pages)await expect.poll(()=>page.evaluate(()=>window.scribyra.agent.readTree().value.items.filter(f=>f.path==='main.tex').length)).toBe(1);
  const fileId=await pages[0].evaluate(()=>window.scribyra.agent.readTree().value.items.find(f=>f.path==='main.tex').id);
  await Promise.all(pages.map(async(page,i)=>{
   const patch=await invoke(page,{op:'agent.patchSource',edits:[{fileId,start:0,end:0,before:'',after:`% peer ${i}\n`}]});expect(patch.ok,JSON.stringify(patch)).toBe(true);
   let comment;for(let retry=0;retry<10;retry++){comment=await invoke(page,{op:'thread.create',fileId,start:0,end:0,body:`Concurrent comment ${i}`});if(comment.ok)break;}expect(comment.ok,JSON.stringify(comment)).toBe(true);
   const review=await invoke(page,{op:'review.create',title:`Review ${i}`});expect(review.ok,JSON.stringify(review)).toBe(true);
   const proposal=await invoke(page,{op:'suggestion.propose',reviewId:review.value.reviewId,fileId,start:0,end:0,before:'',after:`% proposed ${i}\n`});expect(proposal.ok,JSON.stringify(proposal)).toBe(true);
  }));
  for(const page of pages){await expect.poll(async()=>{const r=await invoke(page,{op:'thread.list'});return r.value?.items.length;}).toBe(count);await expect.poll(async()=>{const r=await invoke(page,{op:'review.list'});return r.value?.items.length;}).toBe(count);}
  await expect.poll(async()=>{const values=await Promise.all(pages.map(source));return new Set(values.map(v=>JSON.stringify(v))).size;}).toBe(1);await checkContent(pages);
  if(count===2){
   const follower=pages[1];
   // A session member cannot put words in another identity's mouth, and is told so before peers refuse it.
   const threads=(await invoke(pages[0],{op:'thread.list'})).value.items;let firstMessage;for(const thread of threads){const message=(await invoke(pages[0],{op:'thread.get',id:thread.id})).value.items[0];if(message.variants[0].body==='Concurrent comment 0')firstMessage=message;}
   const edit=await invoke(follower,{op:'message.edit',messageId:firstMessage.id,body:'Forged words',mentions:[],eventHeads:firstMessage.eventHeads});expect(edit.ok).toBe(false);expect(edit.error.code).toBe('permission_denied');
await follower.getByRole('button',{name:'Close sharing'}).click();
   await follower.getByRole('button',{name:'More tools',exact:true}).click();await follower.getByRole('button',{name:'Project settings',exact:true}).click();await follower.getByLabel('Auto compile',{exact:true}).check();await follower.getByRole('button',{name:'Save settings',exact:true}).click();
   await follower.evaluate(()=>window.scribyra.action('review-mode','viewing'));await expect(follower.locator('.cm-content')).toHaveAttribute('aria-readonly','true');
   const before=JSON.stringify(await source(follower));await follower.locator('.cm-content').click();await follower.keyboard.type('LOCAL VIEWING MUST NOT WRITE');expect(JSON.stringify(await source(follower))).toBe(before);
   expect((await invoke(pages[0],{op:'agent.patchSource',edits:[{fileId,start:0,end:0,before:'',after:'% arriving while viewing\n'}]})).ok).toBe(true);
   await expect.poll(async()=>JSON.stringify(await source(follower))).toContain('arriving while viewing');await expect(follower.locator('#direct-participants .direct-avatar')).toHaveAttribute('title',/Agent · Editor 0/);await follower.waitForTimeout(2200);expect(await follower.evaluate(()=>window.scribyra.lastCompile)).toBeNull();
   await follower.evaluate(()=>window.scribyra.action('review-mode','editing'));await follower.locator('.cm-content').click();await follower.keyboard.press('Control+z');await expect.poll(async()=>JSON.stringify(await source(follower))).not.toContain('% peer 1');expect(JSON.stringify(await source(follower))).toContain('% peer 0');
   await follower.getByRole('button',{name:'More tools',exact:true}).click();await follower.getByRole('button',{name:'Project settings',exact:true}).click();await follower.getByLabel('Auto compile',{exact:true}).uncheck();await follower.getByRole('button',{name:'Save settings',exact:true}).click();await openShare(follower);
   await expect.poll(async()=>new Set((await Promise.all(pages.map(source))).map(value=>JSON.stringify(value))).size).toBe(1);
   const review=await invoke(pages[0],{op:'review.create',title:'Authority request'}),proposal=await invoke(pages[0],{op:'suggestion.propose',reviewId:review.value.reviewId,fileId,start:0,end:0,before:'',after:'% approved by authority\n'});expect(proposal.ok,JSON.stringify(proposal)).toBe(true);
   await expect.poll(async()=>JSON.stringify(await invoke(follower,{op:'review.get',id:review.value.reviewId}))).toContain(proposal.value.suggestionId);
   await follower.evaluate(id=>window.scribyra.action('suggestion.accept',id),proposal.value.suggestionId);await expect(sessionStatus(follower)).toContainText('Waiting for acceptance authority');await expect(pages[0].getByRole('button',{name:'Approve request'})).toBeVisible();await expect(pages[0].locator('.direct-request')).toContainText('% approved by authority');
   await pages[0].getByRole('button',{name:'Approve request'}).click();await expect(sessionStatus(pages[0])).toContainText('Authority decision saved locally.',{timeout:5000});await expect.poll(async()=>JSON.stringify(await source(follower))).toContain('approved by authority');
   // Both directions of an authority's decision must verify at the peer, and leave the session up.
   const undoReview=await retried(pages[0],{op:'review.create',title:'Undo check'}),undoProposal=await retried(pages[0],{op:'suggestion.propose',reviewId:undoReview.value.reviewId,fileId,start:0,end:0,before:'',after:'% accepted then undone\n'});expect(undoProposal.ok,JSON.stringify(undoProposal)).toBe(true);
   const undoId=undoProposal.value.suggestionId,accepted=await retried(pages[0],{op:'suggestion.accept',suggestionIds:[undoId],eventHeads:{[undoId]:[]}});expect(accepted.ok,JSON.stringify(accepted)).toBe(true);
   await expect.poll(async()=>JSON.stringify(await source(follower))).toContain('accepted then undone');
   const decided=(await invoke(pages[0],{op:'review.get',id:undoReview.value.reviewId})).value.items.find(item=>item.id===undoId),undone=await retried(pages[0],{op:'change.undo',changeId:accepted.value.changeId,eventHeads:{[undoId]:decided.eventHeads}});expect(undone.ok,JSON.stringify(undone)).toBe(true);
   await expect.poll(async()=>JSON.stringify(await source(follower))).not.toContain('accepted then undone');
   await expect(pages[0].locator('.direct-peer').filter({hasText:'Connected'})).toHaveCount(1);await expect(follower.locator('.direct-peer').filter({hasText:'Connected'})).toHaveCount(1);
  }
  // Leaving keeps both local replicas. The original invite works through any survivor.
  const last=count===5?pages[0]:pages.at(-1),survivor=count===5?pages[1]:pages[0],survivingInvite=await survivor.getByRole('textbox',{name:'Invite link',exact:true}).inputValue();await last.getByRole('button',{name:'Leave session',exact:true}).click();await expect(last.locator('.editor-status')).toContainText('Local only');await last.getByRole('textbox',{name:'Invite link',exact:true}).fill(survivingInvite);
  expect((await invoke(last,{op:'agent.patchSource',edits:[{fileId,start:0,end:0,before:'',after:'% offline returning peer\n'}]})).ok).toBe(true);
  expect((await invoke(survivor,{op:'agent.patchSource',edits:[{fileId,start:0,end:0,before:'',after:'% online peer\n'}]})).ok).toBe(true);
  await last.getByRole('button',{name:'Rejoin',exact:true}).click();
  for(const page of pages)await expect.poll(()=>page.locator('.direct-peer .direct-code').count()).toBe(count-1);
  await verify(pages,count);
  await expect.poll(async()=>new Set((await Promise.all(pages.map(source))).map(v=>JSON.stringify(v))).size).toBe(1);
  expect(s.logs).not.toContain('Concurrent comment');await mkdir('tmp/direct',{recursive:true});await writeFile(`tmp/direct/links-${mixed?'mixed':browser.browserType().name()}-${count}.json`,JSON.stringify(measurements)+'\n');return measurements;
 }catch(error){console.log('Direct diagnostics',JSON.stringify(await Promise.all(pages.map(page=>page.evaluate(()=>({status:document.querySelector('[aria-label="Direct session status"]')?.textContent,recent:window.directStatuses,peers:[...document.querySelectorAll('.direct-peer')].map(p=>p.textContent)})).catch(()=>null)))));throw error;}finally{await Promise.all(contexts.map(c=>c.close()));await extra?.close();await s.close();}
}
for(const count of [2,5])test(`${count} real contexts converge source, comments and suggestions and rejoin through the service`,async({browser},info)=>{
 test.skip(info.project.name==='webkit','Linux WebKit peer connections between pages stay new, verified without app code; the same page connects.');test.setTimeout(120000);const measurements=await exercise(browser,count);await info.attach('direct-links',{body:JSON.stringify(measurements),contentType:'application/json'});
});
test('mixed Chromium and Firefox prefer Chromium offers and converge in a five-member mesh',async({browser},info)=>{
 test.skip(info.project.name!=='chromium','Mixed pairing runs once with Chromium as the fixture browser.');test.setTimeout(120000);const measurements=await exercise(browser,5,true);for(const row of measurements)for(const link of row.links){const peer=Number(link.name.split(' ').at(-1));if(row.profile%2!==peer%2)expect(link.offerer).toBe(row.profile%2===0);}await info.attach('mixed-direct-links',{body:JSON.stringify(measurements),contentType:'application/json'});
});
test('experimental Share is off by default, discloses trash, and fits light and dark at 1366×768',async({page},info)=>{
 await page.setViewportSize({width:1366,height:768});await sample(page);await expect(page.getByRole('button',{name:'Share',exact:true})).toBeHidden();await page.getByRole('button',{name:'More tools',exact:true}).click();await expect(page.getByRole('button',{name:'Share project',exact:true})).toContainText('Experimental · off');await page.getByRole('button',{name:'Share project',exact:true}).click();await expect(page.getByRole('checkbox',{name:'Experimental direct browser sessions'})).not.toBeChecked();await expect(page.getByRole('button',{name:'Start session',exact:true})).toBeDisabled();await expect(page.getByRole('dialog',{name:'Share project'})).toContainText('deleted files’ full text');await expect(page.getByLabel('Connection service',{exact:true})).toHaveValue('');await expect(page.getByRole('button',{name:'Leave session',exact:true})).toBeHidden();
 await mkdir('tmp/direct',{recursive:true});for(const theme of ['light','dark']){await page.evaluate(theme=>document.documentElement.dataset.theme=theme,theme);await page.screenshot({path:`tmp/direct/share-${info.project.name}-${theme}.png`});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);}
 await page.getByRole('button',{name:'Close sharing'}).click();await expect(page.getByRole('dialog',{name:'Share project'})).toHaveCount(0);
});

test('Share uses the shared popup: anchored, themed, one at a time, and it keeps what was typed',async({page})=>{
 await page.setViewportSize({width:1366,height:768});await sample(page);
 const toggle=page.getByRole('button',{name:'Share',exact:true}),dialog=page.getByRole('dialog',{name:'Share project'});
 // Turning sessions on through More tools brings the top-bar Share button, which then anchors the popup.
 await openShare(page);await page.getByRole('checkbox',{name:'Experimental direct browser sessions'}).check();await expect(toggle).toBeVisible();await page.getByRole('button',{name:'Close sharing'}).click();await expect(dialog).toHaveCount(0);
 await expect(toggle).toHaveAttribute('aria-expanded','false');await toggle.click();await expect(dialog).toBeVisible();await expect(toggle).toHaveAttribute('aria-expanded','true');
 expect(await dialog.evaluate(node=>node.classList.contains('ui-popup')&&node.matches(':popover-open'))).toBe(true);
 const [frame,control]=await Promise.all([dialog.boundingBox(),toggle.boundingBox()]);expect(frame.y).toBeGreaterThanOrEqual(control.y+control.height);expect(frame.x+frame.width).toBeLessThanOrEqual(control.x+control.width+1);expect(frame.y+frame.height).toBeLessThanOrEqual(768);
 for(const theme of ['light','dark']){
  await page.evaluate(theme=>document.documentElement.dataset.theme=theme,theme);
  const [surface,own,field,token]=await dialog.evaluate(node=>{const style=getComputedStyle(node),probe=document.createElement('div');probe.style.cssText='background:var(--surface);box-shadow:var(--popup-shadow)';document.body.append(probe);const expected=getComputedStyle(probe),value=[expected.backgroundColor,style.backgroundColor,node.querySelector('.ui-input')?.className,style.boxShadow===expected.boxShadow];probe.remove();return value;});
  expect(own).toBe(surface);expect(field).toBe('ui-input');expect(token).toBe(true);
 }
 await page.getByRole('checkbox',{name:'Experimental direct browser sessions'}).check();
 const service=page.getByRole('textbox',{name:'Connection service',exact:true});await service.fill('https://relay.example');await expect(service).toHaveValue('https://relay.example');
 // Keys typed in a field stay in the field; the popup's menu navigation does not take them.
 await service.press('End');await page.keyboard.type('/x y');await expect(service).toHaveValue('https://relay.example/x y');
 await page.keyboard.press('Escape');await expect(dialog).toHaveCount(0);await expect(toggle).toBeFocused();await expect(toggle).toHaveAttribute('aria-expanded','false');
 await toggle.click();await expect(service).toHaveValue('https://relay.example/x y');await toggle.click();await expect(dialog).toHaveCount(0);
 // Outside the popup: the preview pane's lower left, clear of the dialog however the top bar places it.
 await toggle.click();{const pane=await page.locator('.preview-pane').boundingBox();await page.locator('.preview-pane').click({position:{x:30,y:pane.height-40}});}await expect(dialog).toHaveCount(0);
 await toggle.click();await page.getByRole('treeitem',{name:'main.tex',exact:true}).click({button:'right',force:true});await expect(dialog).toHaveCount(0);await expect(page.getByRole('menu',{name:'File actions',exact:true})).toBeVisible();
});
test('with sessions off, opening a project writes nothing to it and sets nothing up for it',async({page})=>{
 const stored=()=>page.evaluate(async()=>{const db=await new Promise((resolve,reject)=>{const open=indexedDB.open('scribyra-v1');open.onsuccess=()=>resolve(open.result);open.onerror=()=>reject(open.error);});const rows=await new Promise((resolve,reject)=>{const get=db.transaction('projects').objectStore('projects').getAll();get.onsuccess=()=>resolve(get.result);get.onerror=()=>reject(get.error);});db.close();return rows.map(row=>({id:row.id,sequence:row.sequence,schemaVersion:row.schemaVersion,update:Array.from(row.update)}));});
 await sample(page);await expect.poll(async()=>(await stored()).length).toBe(1);await page.waitForTimeout(500);
 const before=await stored();expect(before).toHaveLength(1);expect(before[0].schemaVersion).toBe(8);
 await page.addInitScript(countTransports);
 for(let open=0;open<2;open++){await page.goto('/');await page.locator('.card-open').first().click();await expect(page.locator('.cm-content')).toBeVisible();await page.waitForTimeout(500);expect(await stored()).toEqual(before);}
 expect(await page.evaluate(()=>localStorage.getItem('scribyra:direct-enabled'))).toBeNull();expect(await page.evaluate(()=>window.transportCount)).toBe(0);
 expect(Buffer.from(before[0].update).toString('latin1')).not.toContain('directProof');
});
test('file menu, replace all and suggestion replies keep each session member to their mode',async({browser},info)=>{
 test.skip(info.project.name==='webkit','Linux WebKit peer connections between pages stay new, verified without app code; the same page connects.');test.setTimeout(180000);
 const s=await service(),contexts=[],pages=[];
 try{
  for(let i=0;i<2;i++){const context=await browser.newContext({serviceWorkers:'block',viewport:{width:1366,height:768}});contexts.push(context);if(info.project.name==='chromium')await context.grantPermissions(['local-network-access']);const page=await context.newPage();pages.push(page);await sample(page);await share(page,s,`Member ${i}`);}
  const [authority,member]=pages,connected=async()=>{for(const page of pages){await expect(page.locator('.editor-status')).toContainText('Direct session');await expect(page.locator('#direct-participants .direct-avatar')).toHaveAttribute('title',/Connected/);}};
  await authority.getByRole('button',{name:'Start session',exact:true}).click();const link=authority.getByRole('textbox',{name:'Invite link',exact:true});await expect(link).not.toHaveValue('');
  await member.getByRole('textbox',{name:'Invite link',exact:true}).fill(await link.inputValue());await member.getByRole('button',{name:'Join invite',exact:true}).click();await verify(pages,2);
  const tree=member.getByRole('treeitem',{name:'main.tex',exact:true});await expect(tree).toBeVisible();
  const fileId=await authority.evaluate(()=>window.scribyra.agent.readTree().value.items.find(f=>f.path==='main.tex').id);
  const review=await retried(authority,{op:'review.create',title:'Member review'}),proposal=await retried(authority,{op:'suggestion.propose',reviewId:review.value.reviewId,fileId,start:0,end:0,before:'',after:'% proposal to discuss\n'});expect(proposal.ok,JSON.stringify(proposal)).toBe(true);
  const suggestionId=proposal.value.suggestionId;await expect.poll(async()=>JSON.stringify(await invoke(member,{op:'review.get',id:review.value.reviewId}))).toContain(suggestionId);
  await member.getByRole('button',{name:'Close sharing'}).click();
  const blocked=async()=>{await tree.click({button:'right',force:true});const menu=member.getByRole('menu',{name:'File actions',exact:true});await expect(menu).toBeVisible();const rename=menu.getByRole('menuitem',{name:'Rename',exact:true});await expect(rename).toHaveAttribute('aria-disabled','true');await rename.click({force:true});await expect(member.getByRole('textbox',{name:'Rename file',exact:true})).toHaveCount(0);await member.keyboard.press('Escape');await expect(menu).toHaveCount(0);};
  const text=await source(member),search=async term=>{await member.locator('.cm-content').click();await member.keyboard.press('Control+f');const find=member.getByRole('textbox',{name:'Find',exact:true});await expect(find).toBeVisible();await find.fill(term);};
  const replaceAll=member.getByRole('button',{name:'replace all',exact:true});

  // Viewing: nothing in the tree or the source, but the discussion stays open to the member.
  await member.getByRole('combobox',{name:'Editor mode'}).selectOption('viewing');await blocked();
  await search('documentclass');await member.getByRole('textbox',{name:'Replace',exact:true}).fill('forged');await expect(replaceAll).toBeDisabled();await expect(member.locator('.cm-search-readonly')).toBeVisible();await member.keyboard.press('Escape');
  await member.getByRole('button',{name:'Review',exact:true}).click();const card=member.locator(`[data-card-id="${suggestionId}"]`);await card.locator('.review-card-head').first().click();await card.getByRole('button',{name:/^Reply/}).click();
  const body=member.getByRole('textbox',{name:'Comment body',exact:true});await body.fill('Asked while viewing');
  // A peer's arrival must not disturb an open composer.
  expect((await retried(authority,{op:'agent.patchSource',edits:[{fileId,start:0,end:0,before:'',after:'% arrives during a draft\n'}]})).ok).toBe(true);await expect.poll(async()=>JSON.stringify(await source(member))).toContain('arrives during a draft');await expect(body).toHaveValue('Asked while viewing');
  await member.getByRole('button',{name:'Send comment',exact:true}).click();await expect(card).toContainText('Asked while viewing');
  let thread;await expect.poll(async()=>{thread=(await invoke(authority,{op:'thread.list',filters:{suggestionId}})).value?.items[0];return thread?.suggestionId;}).toBe(suggestionId);
  const replies=(await invoke(authority,{op:'thread.get',id:thread.id})).value.items;expect(replies[0].variants[0].body).toBe('Asked while viewing');await connected();

  // A member can reply as a delegated agent too, and the authority's reply verifies back.
  const agentReply=await retried(member,{op:'thread.reply',suggestionId,body:'Delegated reply'});expect(agentReply.ok,JSON.stringify(agentReply)).toBe(true);
  const ownReply=await retried(authority,{op:'thread.reply',suggestionId,body:'Authority reply'});expect(ownReply.ok,JSON.stringify(ownReply)).toBe(true);
  await expect.poll(async()=>JSON.stringify((await invoke(member,{op:'thread.get',id:thread.id})).value)).toContain('Authority reply');await expect.poll(async()=>JSON.stringify((await invoke(authority,{op:'thread.get',id:thread.id})).value)).toContain('Delegated reply');await connected();

  // Comment rights do not reach a decision, another's words, or the discussion's own status.
  const edit=await invoke(member,{op:'message.edit',messageId:ownReply.value.messageId,body:'Forged words',mentions:[]});expect(edit.ok).toBe(false);expect(edit.error.code).toBe('permission_denied');
  const resolve=await invoke(member,{op:'thread.resolve',threadId:thread.id,eventHeads:[]});expect(resolve.ok).toBe(false);expect(resolve.error.code).toBe('permission_denied');
  const oversize=await invoke(member,{op:'thread.reply',suggestionId,body:'x'.repeat(16*1024+1)});expect(oversize.ok).toBe(false);
  await member.evaluate(id=>window.scribyra.action('suggestion.accept',id),suggestionId);await expect.poll(async()=>JSON.stringify(await source(authority))).not.toContain('proposal to discuss');

  // Reviewing: the tree stays closed; replace all proposes, and peers accept what it proposes.
  await member.getByRole('combobox',{name:'Editor mode'}).selectOption('reviewing');await blocked();
  const reviewing=JSON.stringify(await source(authority)),term='documentclass',proposals=()=>invoke(authority,{op:'review.list'}).then(r=>JSON.stringify(r.value?.items.map(item=>[item.id,item.suggestions])));const known=await proposals();
  await search(term);await member.getByRole('textbox',{name:'Replace',exact:true}).fill('documentstyle');await expect(replaceAll).toBeEnabled();await replaceAll.click();await member.keyboard.press('Escape');
  await expect.poll(proposals,{timeout:20000}).not.toBe(known);expect(JSON.stringify(await source(authority))).toBe(reviewing);await connected();

  // Editing: the same routes now change the project, for both members.
  await member.getByRole('combobox',{name:'Editor mode'}).selectOption('editing');
  await search('begin');await member.getByRole('textbox',{name:'Replace',exact:true}).fill('BEGIN');await replaceAll.click();await member.keyboard.press('Escape');
  await expect.poll(async()=>JSON.stringify(await source(authority))).toContain('BEGIN');
  await expect(async()=>{await member.keyboard.press('Escape');await tree.click({button:'right',force:true});await member.getByRole('menuitem',{name:'Duplicate',exact:true}).click({timeout:1000});await member.getByRole('dialog',{name:'Duplicate file',exact:true}).getByRole('button',{name:'Duplicate',exact:true}).click({timeout:1000});await expect(member.getByRole('treeitem',{name:'main copy.tex',exact:true})).toBeVisible({timeout:1000});}).toPass({timeout:30000});
  await expect.poll(()=>authority.evaluate(()=>window.scribyra.agent.readTree().value.items.some(f=>f.path==='main copy.tex'))).toBe(true);
  await connected();expect(text).toBeTruthy();expect(s.logs).not.toContain('Asked while viewing');
 }finally{await Promise.all(contexts.map(c=>c.close()));await s.close();}
});
test('in a direct session a peer typing neither closes a file menu nor voids a rename of the same file',async({browser},info)=>{
 test.skip(info.project.name==='webkit','Linux WebKit peer connections between pages stay new, verified without app code; the same page connects.');test.setTimeout(180000);
 const s=await service(),contexts=[],pages=[];let stopped=false,typing;
 try{
  for(let i=0;i<2;i++){const context=await browser.newContext({serviceWorkers:'block',viewport:{width:1366,height:768}});contexts.push(context);if(info.project.name==='chromium')await context.grantPermissions(['local-network-access']);const page=await context.newPage();pages.push(page);await sample(page);await share(page,s,`Member ${i}`);}
  const [owner,typist]=pages;
  await owner.getByRole('button',{name:'Start session',exact:true}).click();const link=owner.getByRole('textbox',{name:'Invite link',exact:true});await expect(link).not.toHaveValue('');
  await typist.getByRole('textbox',{name:'Invite link',exact:true}).fill(await link.inputValue());await typist.getByRole('button',{name:'Join invite',exact:true}).click();await verify(pages,2);
  for(const page of pages)await page.getByRole('button',{name:'Close sharing'}).click();
  await expect(typist.getByRole('treeitem',{name:'main.tex',exact:true})).toBeVisible();
  const fileId=await owner.evaluate(()=>window.scribyra.agent.readTree().value.items.find(f=>f.path==='main.tex').id);
  const length=()=>owner.evaluate(fileId=>window.scribyra.agent.readSource({fileId,startLine:1,endLine:200}).value.content.length,fileId);
  const arrives=async()=>{const before=await length();await expect.poll(length,{timeout:20000}).toBeGreaterThan(before+5);};
  typing=(async()=>{await typist.locator('.cm-content').click();await typist.keyboard.press('Control+End');while(!stopped){await typist.keyboard.insertText('xyz');await typist.waitForTimeout(150);}})();
  await arrives();
  const row=owner.getByRole('treeitem',{name:'main.tex',exact:true});await row.click({button:'right',force:true});const menu=owner.getByRole('menu',{name:'File actions',exact:true});
  await expect(menu).toBeVisible();await arrives();await expect(menu).toBeVisible();
  await menu.getByRole('menuitem',{name:'Rename',exact:true}).click();const field=owner.getByRole('textbox',{name:'Rename file',exact:true});await expect(field).toBeVisible();
  await arrives();await field.fill('paper.tex');await field.press('Enter');
  for(const page of pages)await expect(page.getByRole('treeitem',{name:'paper.tex',exact:true})).toBeVisible();
  await expect(owner.getByText(/Someone else renamed|changed while this menu|Project changed/)).toHaveCount(0);
  stopped=true;await typing;typing=null;
  await expect.poll(async()=>new Set((await Promise.all(pages.map(page=>page.evaluate(fileId=>window.scribyra.agent.readSource({fileId,startLine:1,endLine:200}).value.content,fileId)))).map(String)).size).toBe(1);
 }finally{stopped=true;await typing?.catch(()=>{});await Promise.all(contexts.map(c=>c.close()));await s.close();}
});
test('one profile owns the connection and other tabs follow committed heads',async({page,context},info)=>{
 const s=await service();let other;
 try{if(info.project.name==='chromium')await context.grantPermissions(['local-network-access']);await sample(page);await share(page,s,'Owner');await page.getByRole('button',{name:'Start session',exact:true}).click();await expect(page.getByRole('textbox',{name:'Invite link',exact:true})).not.toHaveValue('');
  other=await context.newPage();await other.goto('/');await other.locator('.card-open').first().click();await share(other,s,'Follower');await other.getByRole('button',{name:'Start session',exact:true}).click();await expect(sessionStatus(other)).toContainText('another tab');
  const result=await invoke(page,{op:'agent.patchSource',edits:[{path:'main.tex',start:0,end:0,before:'',after:'% owner tab edit\n'}]});expect(result.ok).toBe(true);await expect.poll(async()=>JSON.stringify(await source(other))).toContain('owner tab edit');
 }finally{await other?.close();await s.close();}
});
test('browser identities persist and reject a tampered envelope; middleman comparison codes differ',async({page})=>{
 const bundle=await build({stdin:{resolveDir:process.cwd(),contents:`import init from './web/pkg/scribyra_app.js';import {initializeCollaborationSchema} from './web/collaboration-schema.js';await init({module_or_path:'/direct-harness.wasm'});initializeCollaborationSchema();export * from './web/direct-identity.js';`},bundle:true,write:false,format:'esm',platform:'browser'});
 await page.route('**/direct-harness.js',r=>r.fulfill({contentType:'text/javascript',body:bundle.outputFiles[0].text}));await page.route('**/direct-harness.wasm',async r=>r.fulfill({contentType:'application/wasm',body:await readFile('web/pkg/scribyra_app_bg.wasm')}));await page.goto('/');
 const result=await page.evaluate(async()=>{const api=await import('/direct-harness.js'),a=await api.profileIdentity({create:true}),again=await api.profileIdentity(),b=await api.newIdentity(),m=await api.newIdentity(),signed=await api.signEnvelope(a,{sequence:1,fingerprint:'original'});let rejected=false;try{await api.verifyEnvelope({...signed,data:signed.data.replace('original','tampered')});}catch{rejected=true;}const av={key:a.publicKey,nonce:'a',fingerprint:'a'},bv={key:b.publicKey,nonce:'b',fingerprint:'b'},mv={key:m.publicKey,nonce:'m',fingerprint:'m'};return{same:a.publicKey===again.publicKey,rejected,honest:await api.comparisonCode('room',av,bv)===await api.comparisonCode('room',bv,av),middle:await api.comparisonCode('room',av,mv)!==await api.comparisonCode('room',mv,bv)};});expect(result).toEqual({same:true,rejected:true,honest:true,middle:true});
});

test('cleaned sharing creates fresh live files and leaves original trash and discussions intact',async({page,context},info)=>{
 const s=await service();
 try{
  if(info.project.name==='chromium')await context.grantPermissions(['local-network-access']);
  const bundle=await build({stdin:{resolveDir:process.cwd(),contents:`import init from './web/pkg/scribyra_app.js';import {initializeCollaborationSchema} from './web/collaboration-schema.js';await init({module_or_path:'/clean-harness.wasm'});initializeCollaborationSchema();export * as Y from 'yjs';export * as model from './web/model.js';export * as storage from './web/storage.js';export {registerComments} from './web/comments.js';export {collaborationCommands} from './web/collaboration-commands.js';`},bundle:true,write:false,format:'esm',platform:'browser',loader:{'.css':'empty'}});
  await page.route('**/clean-harness.js',r=>r.fulfill({contentType:'text/javascript',body:bundle.outputFiles[0].text}));await page.route('**/clean-harness.wasm',async r=>r.fulfill({contentType:'application/wasm',body:await readFile('web/pkg/scribyra_app_bg.wasm')}));await page.goto('/');
  const original=await page.evaluate(async()=>{
   const {Y,model,storage,registerComments,collaborationCommands}=await import('/clean-harness.js'),doc=new Y.Doc(),id=model.addFile(doc,'main.tex','Live source'),trash=model.addFile(doc,'deleted.tex','PRIVATE_TRASH');model.deleteNode(doc,trash);model.addFolder(doc,'empty');model.addFile(doc,'data.bin',new Uint8Array([1,2,3]));
   const commands=collaborationCommands({doc,projectId:'clean-original'}),comments=registerComments({doc,commands,author:{id:crypto.randomUUID(),kind:'human',displayName:'Original author'}}),receipt=commands.execute({version:2,requestId:crypto.randomUUID(),projectId:'clean-original',expectedRevision:commands.revision(),command:{op:'thread.create',fileId:id,start:0,end:4,body:'PRIVATE_DISCUSSION'}});if(!receipt.ok)throw Error(receipt.error.message);await storage.saveProject('clean-original',doc);comments.close();commands.close();doc.destroy();await window.scribyra.action('open','clean-original');return id;
  });
  await share(page,s,'Clean sender');
  // Its comment is unsigned (written by someone before any key): Share says so before sharing.
  await expect(page.locator('.direct-earlier')).toContainText('2 records by other people are unsigned and will show as unverified.');await expect(page.getByRole('textbox',{name:'Invite link',exact:true})).toHaveValue('');
  await page.getByRole('button',{name:'Share a cleaned copy'}).click();await expect(page.getByRole('textbox',{name:'Invite link',exact:true})).not.toHaveValue('');
  const result=await page.evaluate(async()=>{const {Y,model,storage}=await import('/clean-harness.js'),id=window.scribyra.agent.describe().projectId,old=await storage.loadProject('clean-original'),copy=await storage.loadProject(id);const raw=new TextDecoder('latin1').decode(Y.encodeStateAsUpdate(copy)),result={rawLeak:/PRIVATE_TRASH|PRIVATE_DISCUSSION|Original author/.test(raw),id,oldTrash:old.getMap('trash').size,oldThreads:old.getMap('threads').size,trash:copy.getMap('trash').size,threads:copy.getMap('threads').size,files:model.snapshot(copy).map(f=>({id:f.id,path:f.path,content:typeof f.content==='string'?f.content:Array.from(f.content)})),empty:model.projectNodes(copy).some(f=>f.path==='empty'&&f.folder),newLineage:old.getMap('meta').get('lineageId')!==copy.getMap('meta').get('lineageId')};old.destroy();copy.destroy();return result;});
  expect(result.rawLeak).toBe(false);expect(result).toMatchObject({oldTrash:1,oldThreads:1,trash:0,threads:0,empty:true,newLineage:true});expect(result.id).not.toBe('clean-original');expect(result.files.find(f=>f.path==='main.tex')).toMatchObject({content:'Live source'});expect(result.files.find(f=>f.path==='main.tex').id).not.toBe(original);expect(result.files.find(f=>f.path==='data.bin').content).toEqual([1,2,3]);expect(JSON.stringify(result.files)).not.toMatch(/PRIVATE_TRASH|PRIVATE_DISCUSSION/);
 }finally{await s.close();}
});

test('the page timer explains a blocked direct path without diagnosing network isolation',async({browser},info)=>{
 test.skip(info.project.name!=='chromium','One Chromium negative-path run; WebKit cases do not create peer connections.');test.setTimeout(130000);
 const s=await service(),contexts=[],pages=[];
 try{
  for(let i=0;i<2;i++){const context=await browser.newContext({serviceWorkers:'block'});contexts.push(context);await context.grantPermissions(['local-network-access']);await context.addInitScript(()=>{const Original=RTCPeerConnection;window.RTCPeerConnection=class extends Original{constructor(options){super({...options,iceTransportPolicy:'relay'});}};});const page=await context.newPage();pages.push(page);await sample(page);await share(page,s,'Blocked '+i);}
  await pages[0].getByRole('button',{name:'Start session',exact:true}).click();await expect(pages[0].getByRole('textbox',{name:'Invite link',exact:true})).not.toHaveValue('');const invite=await pages[0].getByRole('textbox',{name:'Invite link',exact:true}).inputValue();await pages[1].getByRole('textbox',{name:'Invite link',exact:true}).fill(invite);
  // Join at :48–:50 so the minute rotation lands inside the 20-second window. It used to
  // restart the unopened link with a fresh timer, leaving "Connecting…" past this wait: the
  // failure in long runs, which reached this test at arbitrary wall-clock seconds.
  await pages[0].waitForFunction(()=>Date.now()%60000>48000&&Date.now()%60000<50000,undefined,{timeout:70000,polling:100});await pages[1].getByRole('button',{name:'Join invite',exact:true}).click();
 
  for(const page of pages){await expect(sessionStatus(page)).toContainText('Browsers could not reach each other.',{timeout:25000});await expect(sessionStatus(page)).toContainText('this network permits direct connections');}
 }finally{await Promise.all(contexts.map(c=>c.close()));await s.close();}
});


test('relay replay tracking allows departed sockets to rejoin within one room epoch',async({page,context},info)=>{
 const s=await service();
 try{
  if(info.project.name==='chromium')await context.grantPermissions(['local-network-access']);
  const bundle=await build({entryPoints:['web/service-client.js'],bundle:true,write:false,format:'esm',platform:'browser'});
  await page.route('**/relay-harness.js',r=>r.fulfill({contentType:'text/javascript',body:bundle.outputFiles[0].text}));await page.goto('/');
  const result=await page.evaluate(async({endpoint,bearer})=>{
   const {connectService,createInvitation}=await import('/relay-harness.js'),invitation=createInvitation(),received=[],errors=[];let receiver,sender;
   try{receiver=await connectService({endpoint,bearer,invitation,onSignal:v=>received.push(v.payload),onError:e=>errors.push(e.message)});
    for(let i=0;i<5;i++){
     sender=await connectService({endpoint,bearer,invitation,onSignal:()=>{},onError:e=>errors.push(e.message)});await sender.send({type:'session',payload:String(i)});
     const deadline=Date.now()+2000;while(received.length<i+1&&!errors.length&&Date.now()<deadline)await new Promise(r=>setTimeout(r,10));sender.close();sender=null;
    }return{received,errors};
   }finally{sender?.close();receiver?.close();}
  },{endpoint:s.url,bearer:s.bearer});expect(result).toEqual({received:['0','1','2','3','4'],errors:[]});
 }finally{await s.close();}
});

async function securityHarness(page){
 const bundle=await build({entryPoints:['tests/browser/direct-security-harness.js'],bundle:true,write:false,format:'esm',platform:'browser',loader:{'.css':'empty'}});
 await page.route('**/security-harness.js',r=>r.fulfill({contentType:'text/javascript',body:bundle.outputFiles[0].text}));
 await page.route('**/security-harness.wasm',async r=>r.fulfill({contentType:'application/wasm',body:await readFile('web/pkg/scribyra_app_bg.wasm')}));await page.goto('/');
}

// Use a real framed socket in every engine, including Linux WebKit without WebRTC.
// The production WebRTC mesh above exercises this same receiver and publication seam.
test('real transport quarantines forged approvals, orphan roots, wrong types, lineage and queued bytes',async({page,context},info)=>{
 test.setTimeout(180000);
 const {WebSocketServer}=await import('ws'),server=new WebSocketServer({host:'127.0.0.1',port:0,maxPayload:192*1024*1024});await new Promise(resolve=>server.once('listening',resolve));
 server.on('connection',socket=>socket.on('message',data=>socket.send(data)));
 try{
  if(info.project.name==='chromium')await context.grantPermissions(['local-network-access']);await securityHarness(page);
  const results=await page.evaluate(async port=>{
   const api=await import('/security-harness.js'),{Y,addFile,cloneProject,replication,chunkFrames,frameReceiver,hex,SCHEMA_VERSION,newIdentity,identityAuthorId,signRecords,projection}=api;
   const authority=await newIdentity(),attacker=await newIdentity(),base=new Y.Doc(),id=addFile(base,'main.tex','local unsaved'),authorId=identityAuthorId(authority.publicKey),reviewId=crypto.randomUUID(),suggestionId=crypto.randomUUID(),eventId=crypto.randomUUID(),changeId=crypto.randomUUID(),common=id=>({version:1,id,authorId,changeId,createdAt:1});
   base.getMap('authors').set(authorId,{...common(authorId),kind:'human',displayName:'Authority'});
   base.getMap('reviews').set(reviewId,{...common(reviewId),title:'Review',acceptanceAuthorityId:authorId,authorityEpoch:1});
   base.getMap('suggestions').set(suggestionId,{...common(suggestionId),reviewId,anchorId:crypto.randomUUID(),baseDigest:'a'.repeat(64),before:'local unsaved',after:'forged source'});await signRecords(base,authority);
   const results=[];
   for(const attack of ['approval','forwarded forgery','signed forwarding','orphan','unknown root','wrong type','lineage','queue']){
    const doc=cloneProject(base),evil=cloneProject(base),before=hex(Y.encodeStateAsUpdate(doc));let error='',done;
    const finished=new Promise(resolve=>done=resolve),socket=new WebSocket('ws://127.0.0.1:'+port);socket.binaryType='arraybuffer';await new Promise((resolve,reject)=>{socket.onopen=resolve;socket.onerror=reject;});
    const replica=replication({doc,isComposing:()=>attack==='queue',send:()=>{},onError:e=>{error=e.message;socket.close();done();}}),receiver=frameReceiver({onMessage:bytes=>replica.receive(JSON.parse(new TextDecoder().decode(bytes))),onError:e=>{error=e.message;done();}});socket.onmessage=e=>receiver.receive(e.data);
    let messageId=0;
    async function send(value){const bytes=new TextEncoder().encode(JSON.stringify(value));for(const frame of chunkFrames(bytes,16384,++messageId)){while(socket.bufferedAmount>256*1024)await new Promise(r=>setTimeout(r,1));if(socket.readyState!==1)return;socket.send(frame);}}
    try{
     await send({type:'hello',version:2,schema:SCHEMA_VERSION,lineage:doc.getMap('meta').get('lineageId'),rights:'full-editor'});
     if(attack.includes('forgery')||attack==='approval'||attack==='signed forwarding'){
      evil.getMap('discussionEvents').set(eventId,{...common(eventId),targetId:suggestionId,parents:[],kind:'suggestionAccept',payload:{acceptanceAuthorityId:authorId,authorityEpoch:1,proposedBy:authorId}});evil.getText('text:'+id).insert(0,'FORGED ');
      if(attack==='forwarded forgery')await signRecords(evil,attacker);
      if(attack==='signed forwarding'){await signRecords(evil,authority,{changeId});doc.on('update',()=>{if(projection(doc,suggestionId).status==='accepted')done();});}
     }else if(attack==='orphan')evil.getText('text:orphan').insert(0,'x'.repeat(65*1024*1024));
     else if(attack==='unknown root')evil.getMap('foreign').set('hidden','data');
     else if(attack==='wrong type'){const wrong=new Y.Doc();wrong.getArray('meta').insert(0,['hidden']);Y.applyUpdate(evil,Y.encodeStateAsUpdate(wrong));wrong.destroy();}
     else if(attack==='lineage')evil.getMap('meta').set('lineageId',crypto.randomUUID());
     if(attack==='queue'){
      // Four distinct valid 25 MiB updates remain queued behind composition;
      // duplicates would coalesce, but these exceed the aggregate budget.
      for(let i=0;i<4;i++){const next=cloneProject(base);try{next.getText('text:'+id).insert(0,'q'.repeat(25*1024*1024));await send({type:'update',bytes:hex(Y.encodeStateAsUpdate(next))});}finally{next.destroy();}}
     }else await send({type:'update',bytes:hex(Y.encodeStateAsUpdate(evil))});
     await Promise.race([finished,new Promise((_,reject)=>setTimeout(()=>reject(Error('Attack was not disconnected: '+attack)),15000))]);
     results.push({attack,error,unchanged:before===hex(Y.encodeStateAsUpdate(doc)),status:projection(doc,suggestionId).status});
    }finally{replica.close();receiver.close();socket.close();doc.destroy();evil.destroy();}
   }
   base.destroy();return results;
  },server.address().port);
  for(const result of results){if(result.attack==='signed forwarding'){expect(result.error).toBe('');expect(result.status).toBe('accepted');expect(result.unchanged).toBe(false);continue;}expect(result.error,result.attack).toMatch(/Unverified edit|64 MiB|unknown root|shared type|lineage|queue/);expect(result.unchanged,result.attack).toBe(true);expect(result.status,result.attack).toBe('pending');}
 }finally{for(const client of server.clients)client.terminate();await new Promise(resolve=>server.close(resolve));}
});

for(const exit of ['disable','leave','project close'])for(const entry of ['start','join'])test(`${exit} cancels pending ${entry} before saving can open signaling`,async({page})=>{
 await securityHarness(page);
 await page.evaluate(async entry=>{
  const {Y,addFile,directShare,newIdentity,identityAuthorId,encodeInvite}=await import('/security-harness.js'),doc=new Y.Doc();addFile(doc,'main.tex','unsaved');const identity=await newIdentity();
  let release;window.pendingSave=new Promise(resolve=>release=resolve);window.releaseSave=release;window.socketCount=0;const Original=WebSocket;window.WebSocket=class extends Original{constructor(...args){super(...args);window.socketCount++;}};
  localStorage.setItem('scribyra:direct-enabled','true');
  window.shareHarness=directShare({doc,author:{id:identityAuthorId(identity.publicKey),displayName:'Owner'},flushSave:()=>window.pendingSave,joinProject:async(_invite,_config,attempt)=>{await window.pendingSave;attempt.signal.throwIfAborted();window.socketCount++;}});window.shareHarness.show();
  if(entry==='join'){const invite={version:1,room:'01'.repeat(32),key:'02'.repeat(32),identity:identity.publicKey,lineage:crypto.randomUUID()};const input=document.querySelector('[aria-label="Invite link"]');input.value=location.origin+'/#direct='+encodeInvite(invite);input.dispatchEvent(new Event('input'));}
 },entry);
 await page.getByRole('button',{name:entry==='start'?'Start session':'Join invite',exact:true}).click();
 if(exit==='disable')await page.getByRole('checkbox',{name:'Experimental direct browser sessions'}).uncheck();else if(exit==='leave')await page.getByRole('button',{name:'Leave session',exact:true}).click();else await page.evaluate(()=>window.shareHarness.close());
 await page.evaluate(async()=>{window.releaseSave();await new Promise(r=>setTimeout(r,100));});expect(await page.evaluate(()=>window.socketCount)).toBe(0);await page.evaluate(()=>window.shareHarness.close());
});

test('cancellation closes a connecting socket before it can send the bearer',async({page})=>{
 await securityHarness(page);
 const result=await page.evaluate(async()=>{
  const {connectService}=await import('/security-harness.js');let socket,sent=0,closed=0;
  window.WebSocket=class{constructor(){socket=this;}send(){sent++;}close(){closed++;}};
  const controller=new AbortController(),pending=connectService({endpoint:'http://127.0.0.1',bearer:'test-only',invitation:{version:1,room:'01'.repeat(32),key:'02'.repeat(32)},signal:controller.signal,onSignal:()=>{}}).catch(e=>e.message);
  while(!socket)await new Promise(r=>setTimeout(r,1));controller.abort();socket.onopen();const error=await pending;return{sent,closed,error};
 });expect(result).toMatchObject({sent:0,closed:1});expect(result.error).toContain('cancelled');
});

test('relay receive queues enforce aggregate bytes before asynchronous decryption',async({page})=>{
 await securityHarness(page);
 const result=await page.evaluate(async()=>{
  const {connectService}=await import('/security-harness.js');let socket,closed=0;const errors=[];
  window.WebSocket=class{constructor(){socket=this;}send(){}close(){closed++;}};
  const connecting=connectService({endpoint:'http://127.0.0.1',bearer:'test-only',invitation:{version:1,room:'01'.repeat(32),key:'02'.repeat(32)},onSignal:()=>{},onError:e=>errors.push(e.message)});
  while(!socket)await new Promise(r=>setTimeout(r,1));socket.onmessage({data:JSON.stringify({version:1,ready:true})});const connection=await connecting;
  for(let i=0;i<17;i++)socket.onmessage({data:new ArrayBuffer(65536)});
  await new Promise(r=>setTimeout(r,0));const result={closed,errors};connection.close();return result;
 });expect(result).toEqual({closed:1,errors:['Relay receive backpressure']});
});

// Each counts real transport construction, so "off" and "refused" are observed rather than assumed.
const countTransports=()=>{window.transportCount=0;for(const name of ['WebSocket','RTCPeerConnection']){const Original=window[name];if(!Original)continue;window[name]=new Proxy(Original,{construct(target,args){if(!String(args[0]).includes('/vite'))window.transportCount++;return Reflect.construct(target,args);}});}};
test('off means off: no transport, invite left out of URLs, requests, logs and telemetry storage',async({page})=>{
 const logs=[],urls=[];page.on('console',m=>logs.push(m.text()));page.on('request',r=>urls.push(r.url()+' '+(r.headers().referer||'')));await page.addInitScript(countTransports);
 const seed='ab'.repeat(32),bytes=new Uint8Array(113);bytes[0]=1;for(let i=1;i<97;i++)bytes[i]=0xab;for(let i=97;i<113;i++)bytes[i]=0x11;bytes[103]=0x41;bytes[105]=0x81;
 const fragment=Buffer.from(bytes).toString('base64url');await page.goto('/#direct='+fragment);await expect.poll(()=>page.evaluate(()=>location.hash)).toBe('');
 await expect(page.locator('.direct-share')).toBeVisible();await expect(page.getByRole('checkbox',{name:'Experimental direct browser sessions'})).not.toBeChecked();await expect(page.getByRole('button',{name:'Join invite',exact:true})).toBeDisabled();
 await page.getByRole('button',{name:'Close sharing'}).click();await sample(page);expect((await invoke(page,{op:'agent.patchSource',edits:[{path:'main.tex',start:0,end:0,before:'',after:'% off\n'}]})).ok).toBe(true);await page.waitForTimeout(2500);
 await page.evaluate(fragment=>{location.hash='#direct='+fragment;},fragment);await expect.poll(()=>page.evaluate(()=>location.hash)).toBe('');await expect(page.getByRole('textbox',{name:'Invite link',exact:true})).toHaveValue(new RegExp(fragment));await expect(page.getByRole('button',{name:'Join invite',exact:true})).toBeDisabled();
 const stored=await page.evaluate(()=>JSON.stringify(Object.entries(localStorage)));
 expect(await page.evaluate(()=>window.transportCount)).toBe(0);expect(await page.evaluate(()=>history.length>0&&location.hash)).toBe('');
 for(const text of [...logs,...urls.filter(u=>!u.startsWith(page.url().split('#')[0]+'#')),stored]){expect(text).not.toContain(fragment);expect(text).not.toContain(seed);}
 expect(urls.filter(u=>!u.includes('127.0.0.1'))).toEqual([]);
});
test('a browser without Ed25519 opens and edits projects; Share refuses plainly before any connection',async({page})=>{
 await page.addInitScript(countTransports);await page.addInitScript(()=>{const generate=SubtleCrypto.prototype.generateKey;SubtleCrypto.prototype.generateKey=function(algorithm,...rest){if((algorithm?.name||algorithm)==='Ed25519')return Promise.reject(new DOMException('stub','NotSupportedError'));return generate.call(this,algorithm,...rest);};});
 await sample(page);expect((await invoke(page,{op:'agent.patchSource',edits:[{path:'main.tex',start:0,end:0,before:'',after:'% local\n'}]})).ok).toBe(true);
 const review=await invoke(page,{op:'review.create',title:'Local review'});expect(review.ok,JSON.stringify(review)).toBe(true);const fileId=await page.evaluate(()=>window.scribyra.agent.readTree().value.items.find(f=>f.path==='main.tex').id),proposal=await invoke(page,{op:'suggestion.propose',reviewId:review.value.reviewId,fileId,start:0,end:0,before:'',after:'% accepted\n'});expect(proposal.ok,JSON.stringify(proposal)).toBe(true);
 const accepted=await invoke(page,{op:'suggestion.accept',suggestionIds:[proposal.value.suggestionId],eventHeads:{[proposal.value.suggestionId]:[]}});expect(accepted.ok,JSON.stringify(accepted)).toBe(true);
 // Turning sessions on fails before any key or connection, so the switch stays off.
 await openShare(page);await page.getByRole('checkbox',{name:'Experimental direct browser sessions'}).click();
 await expect(sessionStatus(page)).toContainText('Direct sessions cannot start in this browser');await expect(page.getByRole('checkbox',{name:'Experimental direct browser sessions'})).not.toBeChecked();await expect(sessionStatus(page)).toContainText('Ed25519');
 for(const name of ['Start session','Share a cleaned copy','Join invite'])await expect(page.getByRole('button',{name,exact:true})).toBeDisabled();expect(await page.evaluate(()=>window.transportCount)).toBe(0);
});
test('sporadic Ed25519 generation failures, as on Linux WebKit, neither stop a project nor a session start',async({page,context},info)=>{
 const s=await service();
 try{
  if(info.project.name==='chromium')await context.grantPermissions(['local-network-access']);
  await page.addInitScript(()=>{let left=3;const generate=SubtleCrypto.prototype.generateKey;SubtleCrypto.prototype.generateKey=function(algorithm,...rest){if((algorithm?.name||algorithm)==='Ed25519'&&left-->0)return Promise.reject(new DOMException('stub','OperationError'));return generate.call(this,algorithm,...rest);};});
  await sample(page);await share(page,s,'Retry');await page.getByRole('button',{name:'Start session',exact:true}).click();await expect(page.getByRole('textbox',{name:'Invite link',exact:true})).not.toHaveValue('');await expect(page.getByRole('button',{name:'Leave session',exact:true})).toBeEnabled();await page.getByRole('button',{name:'Leave session',exact:true}).click();
 }finally{await s.close();}
});
test('a handshake cut by the minute rotation restarts in the new room instead of failing',async({browser},info)=>{
 test.skip(info.project.name==='webkit','Linux WebKit peer connections between pages stay new, verified without app code; the same page connects.');test.setTimeout(150000);
 const s=await service(),contexts=[],pages=[];
 try{
  for(let i=0;i<2;i++){const context=await browser.newContext({serviceWorkers:'block'});contexts.push(context);if(info.project.name==='chromium')await context.grantPermissions(['local-network-access']);
   // Lose every signal this profile sends until its socket is replaced, as a rotation cutting a handshake does.
   await context.addInitScript(()=>{const send=WebSocket.prototype.send,Original=window.WebSocket;WebSocket.prototype.send=function(data){if(typeof data!=='string'&&window.loseSignals)return;return send.call(this,data);};window.WebSocket=new Proxy(Original,{construct(target,args){window.loseSignals=false;return Reflect.construct(target,args);}});});
   const page=await context.newPage();pages.push(page);await sample(page);await share(page,s,'Rotating '+i);}
  await pages[0].getByRole('button',{name:'Start session',exact:true}).click();await expect(pages[0].getByRole('textbox',{name:'Invite link',exact:true})).not.toHaveValue('');const invite=await pages[0].getByRole('textbox',{name:'Invite link',exact:true}).inputValue();await pages[1].getByRole('textbox',{name:'Invite link',exact:true}).fill(invite);
  await pages[0].waitForFunction(()=>Date.now()%60000>44000&&Date.now()%60000<50000,undefined,{timeout:70000,polling:100});
  await pages[0].evaluate(()=>{window.loseSignals=true;});await pages[1].getByRole('button',{name:'Join invite',exact:true}).click();
  await expect(pages[0].locator('.direct-peer')).toHaveCount(1,{timeout:15000});await expect(pages[0].locator('.direct-peer .direct-code')).toHaveCount(0);
  for(const page of pages)await expect(page.locator('.direct-peer .direct-code')).toHaveCount(1,{timeout:40000});
  await verify(pages,2);for(const page of pages)await expect(sessionStatus(page)).not.toContainText('could not reach');
 }finally{await Promise.all(contexts.map(c=>c.close()));await s.close();}
});

// The owner's decision, 8 November 2026: off means off. Counts Ed25519 key generation and the
// databases opened, and reads the stored project through a harness of the same modules.
const watchKeys=()=>{window.keyCount=0;window.openedDatabases=[];const generate=SubtleCrypto.prototype.generateKey;SubtleCrypto.prototype.generateKey=function(algorithm,...rest){if((algorithm?.name||algorithm)==='Ed25519')window.keyCount++;return generate.call(this,algorithm,...rest);};const open=IDBFactory.prototype.open;IDBFactory.prototype.open=function(name,...rest){window.openedDatabases.push(name);return open.call(this,name,...rest);};};
async function storedHarness(page){
 const bundle=await build({stdin:{resolveDir:process.cwd(),contents:`import init from './web/pkg/scribyra_app.js';import {initializeCollaborationSchema} from './web/collaboration-schema.js';await init({module_or_path:'/stored-harness.wasm'});initializeCollaborationSchema();export * as storage from './web/storage.js';`},bundle:true,write:false,format:'esm',platform:'browser',loader:{'.css':'empty'}});
 await page.route('**/stored-harness.js',r=>r.fulfill({contentType:'text/javascript',body:bundle.outputFiles[0].text}));await page.route('**/stored-harness.wasm',async r=>r.fulfill({contentType:'application/wasm',body:await readFile('web/pkg/scribyra_app_bg.wasm')}));
}
const directMeta=page=>page.evaluate(async()=>{const {storage}=await import('/stored-harness.js'),doc=await storage.loadProject(window.scribyra.agent.describe().projectId);try{return[...doc.getMap('meta').keys()].filter(key=>key.startsWith('direct')).sort();}finally{doc.destroy();}});
const databases=page=>page.evaluate(async()=>(await indexedDB.databases()).map(entry=>entry.name).sort());
const authorId=page=>page.evaluate(()=>JSON.parse(localStorage.getItem('scribyra:author')).id);
const V4=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,V8=/^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
async function decide(page,fileId,text){
 const review=await retried(page,{op:'review.create',title:'Review '+text});expect(review.ok,JSON.stringify(review)).toBe(true);
 const proposal=await retried(page,{op:'suggestion.propose',reviewId:review.value.reviewId,fileId,start:0,end:0,before:'',after:`% ${text}\n`});expect(proposal.ok,JSON.stringify(proposal)).toBe(true);
 const accepted=await retried(page,{op:'suggestion.accept',suggestionIds:[proposal.value.suggestionId],eventHeads:{[proposal.value.suggestionId]:[]}});expect(accepted.ok,JSON.stringify(accepted)).toBe(true);
}
test('off means off until turned on; on makes the key once and keeps earlier comments yours; off again stops signing; the key can be deleted',async({page})=>{
 await page.addInitScript(watchKeys);await storedHarness(page);await sample(page);
 const original=await authorId(page),fileId=await page.evaluate(()=>window.scribyra.agent.readTree().value.items.find(f=>f.path==='main.tex').id);expect(original).toMatch(V4);
 const comment=await invoke(page,{op:'thread.create',fileId,start:0,end:4,body:'Earlier comment'});expect(comment.ok,JSON.stringify(comment)).toBe(true);
 await decide(page,fileId,'decided before sessions');
 // Opening Share with sessions off does not test the browser by making a key either.
 await openShare(page);await expect(page.getByRole('checkbox',{name:'Experimental direct browser sessions'})).not.toBeChecked();await expect(page.getByRole('button',{name:'Delete signing key',exact:true})).toBeHidden();await page.getByRole('button',{name:'Close sharing'}).click();
 await page.reload();await page.locator('.card-open').first().click();await expect(page.locator('.cm-content')).toBeVisible();
 expect(await page.evaluate(()=>[window.keyCount,window.openedDatabases.includes('scribyra-direct')])).toEqual([0,false]);
 expect(await databases(page)).not.toContain('scribyra-direct');expect(await authorId(page)).toBe(original);expect(await directMeta(page)).toEqual([]);
 expect(await page.evaluate(()=>Object.keys(localStorage).filter(key=>/direct|legacy/.test(key)))).toEqual([]);

 // Turning sessions on is the moment the key is made; the earlier ID stays this profile's own.
 await openShare(page);await page.getByRole('checkbox',{name:'Experimental direct browser sessions'}).check();
 await expect(page.getByRole('checkbox',{name:'Experimental direct browser sessions'})).toBeChecked();await expect.poll(()=>authorId(page)).toMatch(V8);
 expect(await page.evaluate(()=>JSON.parse(localStorage.getItem('scribyra:legacy-authors')))).toEqual([original]);
 expect(await page.evaluate(()=>window.keyCount)).toBeGreaterThan(0);expect(await databases(page)).toContain('scribyra-direct');
 await expect(page.locator('.direct-earlier')).toContainText('1 review decision in this project was made before this browser signed decisions. Others will see it as unverified, never as approvals.');
 await expect(page.locator('.direct-earlier')).toContainText('will show to others as claimed by you, not verified');
 await page.getByRole('button',{name:'Close sharing'}).click();
 await page.locator('#review-toggle').click();const panel=page.getByRole('complementary',{name:'Review panel'});await panel.getByRole('combobox',{name:'Review status filter'}).selectOption('all');
 // Written through the agent API with sessions off: still this person's agent, unlabelled, here.
 const earlier=panel.locator('.review-card').filter({hasText:'Earlier comment'});await expect(earlier).toContainText('Agent');await expect(earlier).not.toContainText(/unverified|claimed/);
 await expect(panel.locator('.review-card').filter({hasText:'decided before sessions'})).toContainText('Accepted by Agent');

 // With sessions on, a decision is signed; the earlier ID is claimed where its records are.
 await decide(page,fileId,'decided with sessions on');
 await expect.poll(async()=>(await directMeta(page)).some(key=>key.startsWith('directProof:discussionEvents:'))).toBe(true);
 expect(await directMeta(page)).toContain(`directClaim:${original}`);

 // Off again: nothing is signed or claimed any more, and the key is kept.
 await openShare(page);await page.getByRole('checkbox',{name:'Experimental direct browser sessions'}).uncheck();await page.getByRole('button',{name:'Close sharing'}).click();
 const signedOn=await directMeta(page),keys=await page.evaluate(()=>window.keyCount);
 await decide(page,fileId,'decided after turning off');await page.waitForTimeout(500);
 expect(await directMeta(page)).toEqual(signedOn);expect(await page.evaluate(()=>window.keyCount)).toBe(keys);expect(await databases(page)).toContain('scribyra-direct');

 // Deleting the key removes its database; the profile takes a fresh local ID, keeping both earlier ones.
 const signed=await authorId(page);
 await openShare(page);await expect(page.locator('.direct-key')).toContainText('The signing key is kept for turning them on again.');await page.getByRole('button',{name:'Delete signing key',exact:true}).click();
 await page.getByRole('dialog',{name:'Delete signing key?'}).getByRole('button',{name:'Delete key',exact:true}).click();
 await expect.poll(()=>databases(page)).not.toContain('scribyra-direct');await expect.poll(()=>authorId(page)).toMatch(V4);
 expect(await authorId(page)).not.toBe(original);expect(await page.evaluate(()=>JSON.parse(localStorage.getItem('scribyra:legacy-authors')))).toEqual([original,signed]);
 expect(await page.evaluate(()=>localStorage.getItem('scribyra:direct-enabled'))).toBe('false');
});

test('a peer sees records and decisions made before sessions as claimed, not verified, and the session stays up',async({browser},info)=>{
 test.skip(info.project.name==='webkit','Linux WebKit peer connections between pages stay new, verified without app code; the same page connects.');test.setTimeout(150000);
 const s=await service(),contexts=[],pages=[];
 try{
  for(let i=0;i<2;i++){const context=await browser.newContext({serviceWorkers:'block',viewport:{width:1366,height:768}});contexts.push(context);if(info.project.name==='chromium')await context.grantPermissions(['local-network-access']);const page=await context.newPage();pages.push(page);await sample(page);}
  const [sharer,peer]=pages,fileId=await sharer.evaluate(()=>window.scribyra.agent.readTree().value.items.find(f=>f.path==='main.tex').id);
  expect((await invoke(sharer,{op:'thread.create',fileId,start:0,end:4,body:'Written before sessions'})).ok).toBe(true);await decide(sharer,fileId,'accepted before sessions');
  await share(sharer,s,'Sharer');await expect(sharer.locator('.direct-earlier')).toContainText('Others will see it as unverified, never as approvals.');
  await share(peer,s,'Peer');
  await sharer.getByRole('button',{name:'Start session',exact:true}).click();await expect(sharer.getByRole('textbox',{name:'Invite link',exact:true})).not.toHaveValue('');
  await peer.getByRole('textbox',{name:'Invite link',exact:true}).fill(await sharer.getByRole('textbox',{name:'Invite link',exact:true}).inputValue());await peer.getByRole('button',{name:'Join invite',exact:true}).click();
  await verify(pages,2);
  await expect.poll(async()=>(await invoke(peer,{op:'thread.list'})).value?.items.length).toBe(1);
  await peer.getByRole('button',{name:'Close sharing'}).click();await peer.locator('#review-toggle').click();const panel=peer.getByRole('complementary',{name:'Review panel'});await panel.getByRole('combobox',{name:'Review status filter'}).selectOption('all');
  // An agent from before sessions speaks only for itself: unverified. The decision is the
  // sharer's earlier authority's, so it is claimed, and never shown as an approval.
  await expect(panel.locator('.review-card').filter({hasText:'Written before sessions'})).toContainText('Agent · unverified');
  const decided=panel.locator('.review-card').filter({hasText:'accepted before sessions'});await expect(decided).toContainText('Marked accepted by Agent · claimed decision, not an approval');await expect(decided).not.toContainText('Accepted by');
  // Something new from the sharer verifies, and neither side was disconnected.
  expect((await invoke(sharer,{op:'thread.create',fileId,start:0,end:4,body:'Written in the session'})).ok).toBe(true);
  const live=panel.locator('.review-card').filter({hasText:'Written in the session'});await expect(live).toContainText('Agent');await expect(live).not.toContainText(/unverified|claimed/);
  await openShare(peer);for(const page of pages)await expect(page.locator('.direct-peer').filter({hasText:'Connected'})).toHaveCount(1);
 }finally{await Promise.all(contexts.map(c=>c.close()));await s.close();}
});

// Two members in a live session: the owner's project, given as files, and a joiner from a fresh sample.
const raceMain=String.raw`\documentclass{article}\begin{document}Shared public document.\end{document}`;
async function livePair(browser,info,s,files){
 const contexts=[],pages=[];
 for(let i=0;i<2;i++){const context=await browser.newContext({serviceWorkers:'block',viewport:{width:1366,height:768}});contexts.push(context);if(info.project.name==='chromium')await context.grantPermissions(['local-network-access']);pages.push(await context.newPage());}
 const [owner,peer]=pages;
 await owner.goto('/');const chooser=owner.waitForEvent('filechooser');await owner.getByRole('button',{name:'Import ZIP',exact:true}).click();await(await chooser).setFiles({name:'direct-race.zip',mimeType:'application/zip',buffer:Buffer.from(zipSync(files))});await expect(owner.locator('.cm-content')).toBeVisible();
 await sample(peer);await share(owner,s,'Owner');await share(peer,s,'Peer');
 await owner.getByRole('button',{name:'Start session',exact:true}).click();const link=owner.getByRole('textbox',{name:'Invite link',exact:true});await expect(link).not.toHaveValue('');
 await peer.getByRole('textbox',{name:'Invite link',exact:true}).fill(await link.inputValue());await peer.getByRole('button',{name:'Join invite',exact:true}).click();await verify(pages,2);
 for(const page of pages)await page.getByRole('button',{name:'Close sharing'}).click();
 return{contexts,owner,peer};
}
const notification=page=>page.getByRole('status',{name:'Workspace notification',exact:true});
const treePaths=page=>page.evaluate(()=>window.scribyra.agent.readTree().value.items.map(item=>item.path).sort());
async function menu(page,path,label){await page.getByRole('treeitem',{name:path,exact:true}).locator('..').locator('.file-menu').click();await page.getByRole('menuitem',{name:label,exact:true}).click();}
async function typeAt(page,path,offset,text){await page.getByRole('treeitem',{name:path,exact:true}).click();await expect(page.getByRole('tab',{name:path,selected:true})).toBeVisible();await page.evaluate(offset=>{const view=document.querySelector('.cm-content').cmTile.root.view;view.dispatch({selection:{anchor:offset}});view.focus();},offset);await page.keyboard.insertText(text);}

test('a session peer gets the same refusals as another tab: destination folders, folder contents, settings and commented text',async({browser},info)=>{
 test.skip(info.project.name==='webkit','Linux WebKit peer connections between pages stay new, verified without app code; the same page connects.');test.setTimeout(180000);
 const s=await service();let contexts=[];
 try{
  const pair=await livePair(browser,info,s,{'main.tex':strToU8(raceMain),'notes.tex':strToU8('alpha notes\n'),'chap/intro.tex':strToU8('intro text\n'),'part/one.tex':strToU8('one\n')});contexts=pair.contexts;const {owner,peer}=pair;
  const all=['chap','chap/intro.tex','main.tex','notes.tex','part','part/one.tex'];
  for(const page of [owner,peer])await expect.poll(()=>treePaths(page),{timeout:20000}).toEqual(all);
  // A move into a folder the peer deletes meanwhile must not bring the folder back with only this file in it.
  await menu(owner,'notes.tex','Move');const move=owner.getByRole('dialog',{name:'Move file',exact:true});await move.getByRole('textbox',{name:'Move file',exact:true}).fill('chap/notes.tex');
  await menu(peer,'chap','Delete');await peer.getByRole('button',{name:'Delete folder',exact:true}).click();await expect(owner.getByRole('treeitem',{name:'chap',exact:true})).toHaveCount(0,{timeout:20000});
  await move.getByRole('button',{name:'Move',exact:true}).click();
  await expect(notification(owner)).toContainText('Someone else renamed, moved or deleted the folder “chap” while you were choosing it. Nothing was changed.');
  for(const page of [owner,peer])await expect.poll(()=>treePaths(page),{timeout:20000}).toEqual(['main.tex','notes.tex','part','part/one.tex']);
  // Deleting a folder whose contents the peer changed after the deletion was confirmed in view.
  await menu(owner,'part','Delete');const confirm=owner.getByRole('button',{name:'Delete folder',exact:true});await expect(confirm).toBeVisible();
  await menu(peer,'part','New file');await peer.getByRole('textbox',{name:'New file',exact:true}).fill('part/added.tex');await peer.getByRole('button',{name:'Create file',exact:true}).click();
  await expect(owner.getByRole('treeitem',{name:'part/added.tex',exact:true})).toBeVisible({timeout:20000});await confirm.click();
  await expect(notification(owner)).toContainText('Project changed while you were deleting “part”: someone else changed what is inside it. Nothing was changed');
  for(const page of [owner,peer])await expect.poll(()=>treePaths(page),{timeout:20000}).toEqual(['main.tex','notes.tex','part','part/added.tex','part/one.tex']);
  // A comment on text the peer changes inside the selection refuses and keeps the draft.
  await owner.getByRole('treeitem',{name:'main.tex',exact:true}).click();const at=raceMain.indexOf('Shared public');
  await owner.evaluate(at=>{const view=document.querySelector('.cm-content').cmTile.root.view;view.dispatch({selection:{anchor:at,head:at+13}});view.focus();},at);
  await openComments(owner);await owner.getByRole('button',{name:'Comment on selection',exact:true}).click();const body=owner.getByRole('textbox',{name:'Comment body',exact:true});await body.fill('About “Shared public”');
  await typeAt(peer,'main.tex',at+6,' not');await expect.poll(()=>owner.evaluate(()=>window.scribyra.agent.readSource({path:'main.tex',startLine:1,endLine:5}).value.content),{timeout:20000}).toContain('Shared not public');
  await owner.getByRole('button',{name:'Send comment',exact:true}).click();await expect(owner.getByRole('alert')).toContainText('The text you selected was changed or removed while you wrote this comment.');
  await expect(body).toHaveValue('About “Shared public”');await owner.getByRole('button',{name:'Clear draft',exact:true}).click();
  // Settings left showing a main file the peer then deletes refuse whole: the name must not save without it.
  const title=await owner.locator('.project-title').textContent();
  await owner.getByRole('button',{name:'More tools',exact:true}).click();await owner.getByRole('button',{name:'Project settings',exact:true}).click();const settings=owner.getByRole('dialog',{name:'Project settings',exact:true});
  await settings.getByLabel('Project name',{exact:true}).fill('Name without its main file');
  await menu(peer,'main.tex','Delete');await expect(owner.getByRole('treeitem',{name:'main.tex',exact:true})).toHaveCount(0,{timeout:20000});
  await settings.getByRole('button',{name:'Save settings',exact:true}).click();
  await expect(notification(owner)).toContainText('Project changed while project settings was open: someone else deleted the main file it shows. Nothing was changed; open it again.');
  await expect(owner.locator('.project-title')).toHaveText(title);
 }finally{await Promise.all(contexts.map(c=>c.close()));await s.close();}
});

test('in a live session the update notice says Reload leaves it and asks once more',async({browser},info)=>{
 test.skip(info.project.name==='webkit','Linux WebKit peer connections between pages stay new, verified without app code; the same page connects.');test.setTimeout(180000);
 const s=await service();let contexts=[];
 try{
  const pair=await livePair(browser,info,s,{'main.tex':strToU8(raceMain)});contexts=pair.contexts;const {owner,peer}=pair;
  // The build learns its own release from the first release.json naming its revision.
  const bundle=(await Promise.all((await readdir('dist/assets')).filter(name=>name.endsWith('.js')).map(name=>readFile(`dist/assets/${name}`,'utf8')))).join('\n');
  const revision=/\bversion:"[^"]+",revision:"([a-f0-9]{40})",dirty:/.exec(bundle)?.[1];test.skip(!revision,'The build carries no Git revision to identify its own release.');
  let release={release:'web-500',revision};
  await owner.route('**/release.json',route=>route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(release)}));
  await owner.evaluate(()=>window.dispatchEvent(new Event('focus')));await owner.waitForTimeout(1000);
  release={release:'web-501',revision:'f'.repeat(40)};await owner.waitForTimeout(10500);await owner.evaluate(()=>window.dispatchEvent(new Event('focus')));
  const shown=owner.getByRole('complementary',{name:'Update available',exact:true});await expect(shown).toBeVisible();
  await expect(shown.getByRole('button',{name:'Reload',exact:true})).toHaveCount(0);
  await owner.evaluate(()=>window.__beforeReload=true);
  // The first choice explains and changes nothing; staying keeps the session.
  await shown.getByRole('button',{name:'Reload and leave session',exact:true}).click();
  await expect(shown).toContainText('Reloading leaves the direct session. Your copy stays on this device; to rejoin, open the invite again and enter your relay capability.');
  await owner.screenshot({path:`tmp/direct/update-leave-${info.project.name}.png`});
  await shown.getByRole('button',{name:'Stay in session',exact:true}).click();await expect(shown.getByRole('button',{name:'Stay in session',exact:true})).toBeHidden();
  await expect(shown.getByRole('button',{name:'Reload and leave session',exact:true})).toBeVisible();
  expect(await owner.evaluate(()=>window.__beforeReload)).toBe(true);await expect(owner.locator('.editor-status')).toContainText('Direct session');
  // Confirming saves, leaves the session and reloads into the same project.
  await shown.getByRole('button',{name:'Reload and leave session',exact:true}).click();
  const reloaded=owner.waitForEvent('load',{timeout:60000});await shown.getByRole('button',{name:'Leave session and reload',exact:true}).click();await reloaded;
  expect(await owner.evaluate(()=>window.__beforeReload)).toBeUndefined();
  await expect(owner.locator('.cm-content')).toContainText('Shared public document.');await expect(owner.locator('.editor-status')).not.toContainText('Direct session');
  await expect(peer.locator('.cm-content')).toContainText('Shared public document.');
 }finally{await Promise.all(contexts.map(c=>c.close()));await s.close();}
});
