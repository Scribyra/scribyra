import {test,expect} from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import {mkdir,readFile,mkdtemp,rm,writeFile,rename,access} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {zipSync,strToU8} from 'fflate';
import {openReview,openReviewMenu} from './review-ui.js';
const text='\\documentclass{article}\n\\begin{document}\nFirst paragraph for review.\nSecond paragraph for a comment.\n\\end{document}\n';
async function setup(page,url='/'){
 await page.goto(url);const chooser=page.waitForEvent('filechooser');await page.getByRole('button',{name:'Import ZIP',exact:true}).click();await(await chooser).setFiles({name:'review-ui.zip',mimeType:'application/zip',buffer:Buffer.from(zipSync({'main.tex':strToU8(text),'other.tex':strToU8('Another file.')}))});await expect(page.locator('.cm-content')).toBeVisible();
}
async function accepted(page){return page.evaluate(()=>window.scribyra.agent.readSource({path:'main.tex',startLine:1,endLine:200}).value.content);}
async function select(page,start,end=start){await page.evaluate(({start,end})=>{const view=document.querySelector('.cm-content').cmTile.root.view;view.dispatch({selection:{anchor:start,head:end},scrollIntoView:true});view.focus();},{start,end});}
async function proposals(page){return page.evaluate(async()=>{const api=window.scribyra.agent,call=async command=>{const r=await api.execute({version:2,requestId:crypto.randomUUID(),projectId:api.describe().projectId,command});if(!r.ok)throw Error(JSON.stringify(r));return r.value;},reviews=(await call({op:'review.list'})).items;return(await Promise.all(reviews.map(r=>call({op:'review.get',id:r.id})))).flatMap(r=>r.items.filter(i=>i.kind==='suggestion'));});}
async function flush(page){await page.getByRole('button',{name:'Review',exact:true}).focus();await expect.poll(async()=>(await proposals(page)).filter(s=>s.status==='pending').length).toBeGreaterThan(0);}
async function comment(page){await select(page,text.indexOf('Second'),text.indexOf('Second')+6);await page.locator('.add-comment-floating').click();await page.getByRole('textbox',{name:'Comment body',exact:true}).fill('Please check this paragraph.');await page.getByRole('button',{name:'Send comment',exact:true}).click();await expect(page.getByRole('status',{name:'Comment status',exact:true})).toHaveText('Saved locally');}

test('review mode groups typing, backspace and undo while accepted source and viewing stay protected',async({page})=>{
 await setup(page);await page.getByRole('combobox',{name:'Editor mode'}).selectOption('reviewing');await select(page,0);await page.keyboard.type('% hello');
 expect(await accepted(page)).toBe(text);await expect(page.locator('.tracked-insert')).toContainText('% hello');await flush(page);
 expect((await proposals(page)).filter(s=>s.status==='pending')).toHaveLength(1);
 await select(page,7);await page.keyboard.press('Backspace');await page.keyboard.type('!');await flush(page);
 const all=await proposals(page);expect(all.filter(s=>s.status==='pending')).toHaveLength(1);expect(all.find(s=>s.status==='pending').after).toBe('% hell!');
 await page.locator('.cm-content').focus();await page.keyboard.press('Control+z');expect(await accepted(page)).toBe(text);await page.keyboard.press('Control+y');await expect(page.locator('.tracked-insert')).toContainText('% hell!');
 const beforeSwitch=await page.evaluate(()=>document.querySelector('.cm-content').cmTile.root.view.state.doc.toString());await page.getByRole('treeitem',{name:'other.tex',exact:true}).click();await expect(page.getByRole('treeitem',{name:'other.tex',exact:true})).toBeFocused();await expect(page.locator('.cm-content')).toHaveText('Another file.');await page.getByRole('treeitem',{name:'main.tex',exact:true}).click();await expect(page.getByRole('treeitem',{name:'main.tex',exact:true})).toBeFocused();await expect(page.locator('.tracked-insert')).toContainText('% hell!');await page.locator('.cm-content').focus();await expect(page.locator('.cm-content')).toBeFocused();await page.keyboard.press('Control+z');expect(await page.evaluate(()=>document.querySelector('.cm-content').cmTile.root.view.state.doc.toString())).not.toBe(beforeSwitch);await page.keyboard.press('Control+y');expect(await page.evaluate(()=>document.querySelector('.cm-content').cmTile.root.view.state.doc.toString())).toBe(beforeSwitch);
 await page.getByRole('combobox',{name:'Editor mode'}).selectOption('viewing');await expect(page.locator('.cm-content')).toHaveAttribute('aria-readonly','true');await page.locator('.cm-content').focus();await expect(page.locator('.cm-content')).toBeFocused();await page.keyboard.type('NO');await page.keyboard.press('Control+z');expect(await accepted(page)).toBe(text);
 await page.reload();await page.locator('.card-open').first().click();await expect(page.getByRole('combobox',{name:'Editor mode'})).toHaveValue('viewing');expect(await accepted(page)).toBe(text);
});

test('selection comments, line cards, overview, resolved comments and top-bar history',async({page})=>{
 await setup(page);await comment(page);const panel=page.getByRole('complementary',{name:'Review panel'});
 await expect(panel.locator('.review-card')).toContainText('Please check');await expect(page.locator('.file-sidebar')).not.toContainText('Comments');await expect(page.locator('.file-sidebar')).not.toContainText('Reviews');await expect(page.locator('.editor-header').getByRole('button',{name:'History',exact:true})).toBeVisible();
 await panel.locator('.review-card').getByRole('button',{name:'Resolve',exact:true}).click();await panel.getByRole('combobox',{name:'Review status filter'}).selectOption('resolved');await panel.locator('.review-card').getByRole('button',{name:'Reopen',exact:true}).click();await panel.getByRole('combobox',{name:'Review status filter'}).selectOption('open');
 await panel.getByRole('tab',{name:'Overview',exact:true}).click();await panel.getByRole('navigation',{name:'Review files'}).getByRole('button',{name:'other.tex (0)',exact:true}).click();await expect(page.getByRole('tab',{name:'other.tex',exact:true})).toHaveAttribute('aria-selected','true');await expect(panel.locator('.review-card')).toHaveCount(0);
 await page.getByRole('treeitem',{name:'main.tex',exact:true}).click();await panel.locator('.review-card-location').click();await expect(page.locator('.comment-highlight')).toHaveText('Second');
 await select(page,0);await panel.locator('.review-card strong').click();await expect.poll(()=>page.evaluate(()=>{const v=document.querySelector('.cm-content').cmTile.root.view;return v.state.sliceDoc(v.state.selection.main.from,v.state.selection.main.to);})).toBe('Second');
 await page.getByRole('button',{name:'Close review panel'}).click();await page.locator('.comment-highlight').click();await expect(panel).toBeVisible();
});

test('confirmed accept all is one batch and preview toggle preserves ordinary accepted compilation',async({page})=>{
 await setup(page);await page.getByRole('combobox',{name:'Editor mode'}).selectOption('reviewing');await select(page,0);await page.keyboard.type('% suggested\n');await flush(page);await openReview(page);
 await openReviewMenu(page);await page.getByRole('button',{name:'Accept all',exact:true}).click();await page.getByRole('dialog',{name:'Accept suggestions',exact:true}).getByRole('button',{name:'Cancel',exact:true}).click();expect(await accepted(page)).toBe(text);
 await page.getByRole('button',{name:'Compile options',exact:true}).click();await page.getByRole('checkbox',{name:'Preview with suggestions',exact:true}).check();await page.getByRole('button',{name:'Compile',exact:true}).click();
 await expect(page.getByRole('link',{name:'Download suggestion preview PDF'})).toHaveAttribute('href',/^blob:/,{timeout:180000});expect(await accepted(page)).toBe(text);expect(await page.evaluate(()=>window.scribyra.lastCompile)).toBeNull();
 await openReviewMenu(page);await page.getByRole('button',{name:'Accept all',exact:true}).click();await page.getByRole('dialog',{name:'Accept suggestions',exact:true}).getByRole('button',{name:'Continue',exact:true}).click();await expect.poll(()=>accepted(page)).toBe('% suggested\n'+text);
});

for(const size of [{width:1366,height:768},{width:1440,height:900},{width:700,height:768}])test(`review workspace layout ${size.width}x${size.height}`,async({page,browserName})=>{
 await page.setViewportSize(size);await setup(page);await comment(page);await page.getByRole('combobox',{name:'Editor mode'}).selectOption('reviewing');await select(page,text.indexOf('First'));await page.keyboard.type('A tracked insertion ');await flush(page);await openReview(page);
 const cards=page.locator('.review-card');await expect(cards).toHaveCount(2);await expect.poll(()=>page.evaluate(()=>{const view=document.querySelector('.cm-content').cmTile.root.view;return Math.abs(document.querySelector('.review-card').getBoundingClientRect().top-view.coordsAtPos(view.state.doc.line(3).from).top);})).toBeLessThan(5);const boxes=await cards.evaluateAll(nodes=>nodes.map(n=>{const r=n.getBoundingClientRect();return{top:r.top,bottom:r.bottom};}));expect(boxes[1].top).toBeGreaterThanOrEqual(boxes[0].bottom);
 await expect(page.getByRole('button',{name:'Close review panel'})).toBeInViewport();await expect(page.getByRole('button',{name:'Compile',exact:true})).toBeInViewport();
 await mkdir('tmp/review-screenshots',{recursive:true});await page.screenshot({path:`tmp/review-screenshots/${browserName}-${size.width}x${size.height}-light.png`});await page.getByRole('button',{name:'Toggle theme',exact:true}).click();await page.screenshot({path:`tmp/review-screenshots/${browserName}-${size.width}x${size.height}-dark.png`});
 const result=await new AxeBuilder({page}).include('#review-workspace').include('.workspace-toolbar').analyze();expect(result.violations.map(v=>({id:v.id,nodes:v.nodes.map(n=>n.failureSummary)}))).toEqual([]);
});

test('native IME reviewing commits and cancels candidates without touching accepted text',async({page,context,playwright,browserName,baseURL})=>{
 let ownContext,ownBrowser,ime,profile,directory;
 try{
  if(browserName==='firefox'){
   const {reserveMarionettePort,firefoxIme}=await import('../helpers/firefox-ime.mjs');await reserveMarionettePort();profile=await mkdtemp(join(tmpdir(),'review-gecko-'));ownContext=await playwright.firefox.launchPersistentContext(profile,{headless:true,args:['--marionette','--remote-allow-system-access']});page=ownContext.pages()[0]||await ownContext.newPage();await setup(page,baseURL);ime=await firefoxIme(profile,new URL(baseURL).origin);
  }else if(browserName==='webkit'){
   const {buildNativeIme}=await import('../../scripts/build-native-ime.mjs'),library=await buildNativeIme();directory=await mkdtemp(join(tmpdir(),'review-wpe-'));ownBrowser=await playwright.webkit.launch({headless:true,env:{...process.env,LD_PRELOAD:library,SCRIBYRA_NATIVE_IME_DIRECTORY:directory}});ownContext=await ownBrowser.newContext();page=await ownContext.newPage();await setup(page,baseURL);
   await expect.poll(async()=>{try{await access(join(directory,'ready'));return true;}catch{return false;}}).toBe(true);
   const send=async(command,text='')=>{await rm(join(directory,'done'),{force:true});await writeFile(join(directory,'next'),command+':'+text);await rename(join(directory,'next'),join(directory,'command'));await expect.poll(async()=>{try{return await readFile(join(directory,'done'),'utf8');}catch{return '';}}).toBe(command);};ime={preedit:text=>send('preedit',text),cancel:()=>send('cancel'),commit:text=>send('commit',text)};
  }else{
   await setup(page);const cdp=await context.newCDPSession(page);ime={preedit:text=>cdp.send('Input.imeSetComposition',{text,selectionStart:text.length,selectionEnd:text.length}),cancel:()=>cdp.send('Input.imeSetComposition',{text:'',selectionStart:0,selectionEnd:0}),commit:async text=>{await cdp.send('Input.insertText',{text});await cdp.send('Input.imeSetComposition',{text:'',selectionStart:0,selectionEnd:0});},close:()=>cdp.detach()};
  }
  await page.getByRole('combobox',{name:'Editor mode'}).selectOption('reviewing');await select(page,0);await page.evaluate(()=>{window.reviewIme=[];for(const type of ['compositionstart','compositionend'])document.addEventListener(type,e=>window.reviewIme.push({type,trusted:e.isTrusted}));});
  await ime.preedit('キャンセル');await expect(page.locator('.cm-content')).toContainText('キャンセル');expect(await accepted(page)).toBe(text);await ime.cancel();await expect.poll(()=>page.evaluate(()=>document.querySelector('.cm-content').cmTile.root.view.state.doc.toString())).toBe(text);
  await select(page,0);await ime.preedit('にほ');await expect(page.locator('.cm-content')).toContainText('にほ');await page.evaluate(async()=>{const other=window.scribyra.agent.readSource({path:'other.tex',startLine:1,endLine:10});await window.scribyra.action('select-node',other.value.fileId);});await expect(page.getByRole('tab',{name:'main.tex',exact:true})).toHaveAttribute('aria-selected','true');await expect(page.locator('.cm-content')).toContainText('にほ');if(ime.controlEnter)await ime.controlEnter();else await page.keyboard.press('Control+Enter');expect(await page.evaluate(()=>window.scribyra.lastCompile)).toBeNull();expect(await proposals(page)).toHaveLength(0);
  const marker='日本語😀e\u0301';await ime.commit(marker);await expect(page.locator('.tracked-insert')).toHaveText(marker);await flush(page);expect(await accepted(page)).toBe(text);expect((await proposals(page)).filter(s=>s.status==='pending').map(s=>s.after)).toEqual([marker]);expect(await page.evaluate(()=>window.reviewIme.some(e=>e.type==='compositionstart'&&e.trusted))).toBe(true);
  await page.locator('.cm-content').focus();await page.keyboard.press('Control+z');await expect(page.locator('.tracked-insert')).toHaveCount(0);await page.getByRole('button',{name:'Review',exact:true}).focus();await expect.poll(async()=>(await proposals(page)).filter(s=>s.status==='pending').length).toBe(0);expect(await accepted(page)).toBe(text);
 }finally{await ime?.close?.();await ownContext?.close();await ownBrowser?.close();if(profile)await rm(profile,{recursive:true,force:true});if(directory)await rm(directory,{recursive:true,force:true});}
});

test('a point comment survives a pending insertion and a later-line card aligns with its source',async({page})=>{
 await setup(page);const errors=[];page.on('pageerror',error=>errors.push(error.message));await select(page,0);await page.keyboard.press('Control+Alt+m');await page.getByRole('textbox',{name:'Comment body',exact:true}).fill('Point at accepted source');await page.getByRole('button',{name:'Send comment',exact:true}).click();await expect(page.getByRole('status',{name:'Comment status',exact:true})).toHaveText('Saved locally');
 await page.getByRole('combobox',{name:'Editor mode'}).selectOption('reviewing');await select(page,0);await page.keyboard.type('% insertion\n');await flush(page);await expect(page.getByRole('img',{name:'Comment at this position',exact:true})).toHaveCount(1);await page.locator('.comment-point').click();await expect(page.locator('.review-card.active')).toContainText('Point at accepted source');expect(errors).toEqual([]);expect(await accepted(page)).toBe(text);
 await page.getByRole('combobox',{name:'Editor mode'}).selectOption('editing');await page.locator('.review-card').filter({hasText:'% insertion'}).getByRole('button',{name:'Reject',exact:true}).click();await page.locator('.review-card').filter({hasText:'Point at accepted source'}).getByRole('button',{name:'Resolve',exact:true}).click();
 const long=Array.from({length:24},(_,i)=>`Paragraph ${i+1}.`).join('\n');await page.evaluate(long=>{const api=window.scribyra.agent,read=api.readSource({path:'main.tex',startLine:1,endLine:200}),r=api.patchSource({expectedRevision:read.revision,edits:[{path:'main.tex',start:0,end:read.value.content.length,before:read.value.content,after:long}]});if(!r.ok)throw Error(JSON.stringify(r));},long);
 await select(page,long.indexOf('Paragraph 12'),long.indexOf('Paragraph 12')+12);await page.locator('.add-comment-floating').click();await page.getByRole('textbox',{name:'Comment body',exact:true}).fill('Aligned card');await page.getByRole('button',{name:'Send comment',exact:true}).click();await expect(page.getByRole('status',{name:'Comment status',exact:true})).toHaveText('Saved locally');await page.locator('.cm-content').focus();
 await expect.poll(()=>page.evaluate(()=>{const view=document.querySelector('.cm-content').cmTile.root.view,card=[...document.querySelectorAll('.review-card')].find(c=>c.textContent.includes('Aligned card'));return Math.abs(card.getBoundingClientRect().top-view.coordsAtPos(view.state.doc.line(12).from).top);})).toBeLessThan(5);
});

test('foreign pending text is protected and accepting it resets reviewing undo',async({page})=>{
 await setup(page);await page.evaluate(async()=>{const api=window.scribyra.agent,read=api.readSource({path:'main.tex',startLine:1,endLine:200}),call=async command=>{const r=await api.execute({version:2,requestId:crypto.randomUUID(),projectId:api.describe().projectId,expectedRevision:api.status().revision,command});if(!r.ok)throw Error(JSON.stringify(r));return r.value;},review=await call({op:'review.create',title:'Agent proposal'});await call({op:'suggestion.propose',reviewId:review.reviewId,fileId:read.value.fileId,start:0,end:0,before:'',after:'% Agent\n'});});
 await page.getByRole('combobox',{name:'Editor mode'}).selectOption('reviewing');await select(page,8+text.length);await page.keyboard.type('% local');await flush(page);await select(page,3,4);await page.keyboard.type('X');await expect(page.getByRole('status',{name:'Tracked changes'})).toContainText('other author');expect(await page.evaluate(()=>document.querySelector('.cm-content').cmTile.root.view.state.doc.toString())).toBe('% Agent\n'+text+'% local');expect(await accepted(page)).toBe(text);
 await openReview(page);await page.locator('.review-card').filter({hasText:'% Agent'}).getByRole('button',{name:'Accept',exact:true}).click();await expect.poll(()=>accepted(page)).toBe('% Agent\n'+text);const projected=await page.evaluate(()=>document.querySelector('.cm-content').cmTile.root.view.state.doc.toString());await page.locator('.cm-content').focus();await page.keyboard.press('Control+z');expect(await accepted(page)).toBe('% Agent\n'+text);expect(await page.evaluate(()=>document.querySelector('.cm-content').cmTile.root.view.state.doc.toString())).toBe(projected);
});

async function patch(page,find,replace){
 return page.evaluate(({find,replace})=>{const api=window.scribyra.agent,r=api.patchSource({expectedRevision:api.status().revision,edits:[{path:'main.tex',find,replace}]});if(!r.ok)throw Error(JSON.stringify(r));return r;},{find,replace});
}
for(const route of ['typing','undo','mode change','file switch','project close'])test(`conflicting agent patch retains review text and permits ${route}`,async({page})=>{
 await setup(page);await page.getByRole('combobox',{name:'Editor mode'}).selectOption('reviewing');
 const at=text.indexOf('First'),draft=text.replace('First','LOCAL');
 // One task: no idle/blur flush can publish the draft before the concurrent patch.
 await page.evaluate(({at})=>{const view=document.querySelector('.cm-content').cmTile.root.view;view.dispatch({changes:{from:at,to:at+5,insert:'LOCAL'},selection:{anchor:at+5}});const api=window.scribyra.agent,r=api.patchSource({expectedRevision:api.status().revision,edits:[{path:'main.tex',find:'First',replace:'AGENT'}]});if(!r.ok)throw Error(JSON.stringify(r));},{at});
 const retained=page.getByRole('region',{name:'Retained review drafts'});await expect(retained.getByRole('textbox')).toHaveValue(draft);expect(await accepted(page)).toBe(text.replace('First','AGENT'));
 if(route==='typing'){await select(page,0);await page.keyboard.type('% next\n');await flush(page);await expect(page.locator('.tracked-insert')).toHaveText('% next');}
 if(route==='undo'){await page.locator('.cm-content').focus();await page.keyboard.press('Control+z');await expect(retained.getByRole('textbox')).toHaveValue(draft);await select(page,0);await page.keyboard.type('Z');await page.keyboard.press('Control+z');await expect(page.locator('.cm-content')).not.toContainText('Z');}
 if(route==='mode change'){await page.getByRole('combobox',{name:'Editor mode'}).selectOption('editing');await expect(page.getByRole('combobox',{name:'Editor mode'})).toHaveValue('editing');}
 if(route==='file switch'){await page.getByRole('treeitem',{name:'other.tex',exact:true}).click();await expect(page.locator('.cm-content')).toHaveText('Another file.');}
 if(route==='project close'){await page.evaluate(()=>window.scribyra.action('home'));await expect(page.locator('.card-open')).toBeVisible();await page.locator('.card-open').first().click();}
 await expect(retained.getByRole('textbox')).toHaveValue(draft);
 await page.reload();await page.locator('.card-open').first().click();await expect(retained.getByRole('textbox')).toHaveValue(draft);
 const download=page.waitForEvent('download');await retained.getByRole('button',{name:'Save draft text'}).click();expect(await readFile(await(await download).path(),'utf8')).toBe(draft);
 await retained.getByRole('button',{name:'Discard draft'}).click();await page.getByRole('dialog',{name:'Discard review draft'}).getByRole('button',{name:'Continue',exact:true}).click();await expect(retained).toBeHidden();
});

for(const decision of ['individual','batch'])test(`typing before a foreign insertion preserves order through reload and ${decision} acceptance`,async({page})=>{
 await setup(page);await patch(page,text,'abcdef');
 await page.evaluate(async()=>{const api=window.scribyra.agent,call=async command=>{const r=await api.execute({version:2,requestId:crypto.randomUUID(),projectId:api.describe().projectId,expectedRevision:api.status().revision,command});if(!r.ok)throw Error(JSON.stringify(r));return r.value;},review=await call({op:'review.create',title:'Boundary'}),fileId=api.readSource({path:'main.tex'}).value.fileId;await call({op:'suggestion.propose',reviewId:review.reviewId,fileId,start:2,end:2,before:'',after:'X'});});
 await page.getByRole('combobox',{name:'Editor mode'}).selectOption('reviewing');await select(page,2);await page.keyboard.type('YZ');
 const projected=()=>page.evaluate(()=>document.querySelector('.cm-content').cmTile.root.view.state.doc.toString());await expect.poll(projected).toBe('abYZXcdef');await expect.poll(async()=>(await proposals(page)).filter(s=>s.status==='pending').map(s=>s.after).sort()).toEqual(['X','YZ']);expect(await projected()).toBe('abYZXcdef');await expect(page.locator('.save-indicator')).toHaveText('Saved locally');
 await page.reload();await page.locator('.card-open').first().click();await expect(page.locator('.cm-content')).toBeVisible();await expect.poll(projected).toBe('abYZXcdef');expect(await accepted(page)).toBe('abcdef');
 if(decision==='individual'){
  await page.locator('.review-card').filter({hasText:'YZ'}).getByRole('button',{name:'Accept',exact:true}).click();await expect.poll(()=>accepted(page)).toBe('abYZcdef');await expect.poll(projected).toBe('abYZXcdef');
  await page.locator('.review-card').filter({hasText:'X'}).getByRole('button',{name:'Accept',exact:true}).click();
 }else{
  await page.evaluate(async()=>{const api=window.scribyra.agent,call=async command=>{const r=await api.execute({version:2,requestId:crypto.randomUUID(),projectId:api.describe().projectId,expectedRevision:api.status().revision,command});if(!r.ok)throw Error(JSON.stringify(r));return r.value;},reviews=(await call({op:'review.list'})).items,items=(await Promise.all(reviews.map(r=>call({op:'review.get',id:r.id})))).flatMap(r=>r.items.filter(i=>i.kind==='suggestion'&&i.status==='pending'));await call({op:'suggestion.accept',suggestionIds:items.map(i=>i.id).reverse(),eventHeads:Object.fromEntries(items.map(i=>[i.id,i.eventHeads]))});});
 }
 await expect.poll(()=>accepted(page)).toBe('abYZXcdef');
});

test('Viewing denies tree writes, reference rewrites, uploads, settings and search replacement; comments and export work',async({page})=>{
 await setup(page);await patch(page,text,text+'\\input{other}\n');
 await page.evaluate(()=>{void window.scribyra.action('add-folder');});await page.getByRole('textbox',{name:'New folder'}).fill('destination');await page.getByRole('button',{name:'Create folder',exact:true}).click();await page.evaluate(()=>window.scribyra.action('select-root'));
 await page.getByRole('combobox',{name:'Editor mode'}).selectOption('viewing');
 const notice=page.getByRole('status',{name:'Workspace notification',exact:true});
 const unchanged=async()=>{expect(await accepted(page)).toBe(text+'\\input{other}\n');expect(await page.evaluate(()=>window.scribyra.agent.readSource({path:'other.tex'}).ok)).toBe(true);};
 const other=await page.evaluate(()=>window.scribyra.agent.readSource({path:'other.tex'}).value.fileId);
 for(const move of [false,true]){
  // The menu shows these disabled with the reason, and the command layer still refuses them when reached another way.
  await page.getByRole('treeitem',{name:'other.tex',exact:true}).locator('..').locator('.file-menu').click();const menu=page.getByRole('menu',{name:'File actions',exact:true});await expect(menu).toContainText('Switch to Editing');
  for(const label of ['Rename','Move','Duplicate','Delete'])await expect(menu.getByRole('menuitem',{name:label,exact:true})).toHaveAttribute('aria-disabled','true');
  await page.keyboard.press('Escape');await expect(menu).toHaveCount(0);
  await page.evaluate(({id,move})=>{void window.scribyra.action(move?'move-node':'rename-node',id);},{id:other,move});
  await page.getByRole('textbox',{name:move?'Move file':'Rename file',exact:true}).fill(move?'folder/moved.tex':'renamed.tex');if(move)await page.getByRole('button',{name:'Move',exact:true}).click();else await page.keyboard.press('Enter');
  await page.getByRole('dialog',{name:'Review file references'}).getByRole('button',{name:'Move and update',exact:true}).click();await expect(notice).toContainText('Switch to Editing');await unchanged();
 }
 await page.evaluate(id=>window.scribyra.action('delete-node',id),other);await expect(notice).toContainText('Switch to Editing');await unchanged();
 // A native file chooser still reads files; the shared command refuses publication.
 let chooser=page.waitForEvent('filechooser');await page.getByRole('button',{name:'Upload files',exact:true}).click();await(await chooser).setFiles({name:'blocked.tex',mimeType:'text/plain',buffer:Buffer.from('NO')});await expect(notice).toContainText('Switch to Editing');await expect(page.getByRole('treeitem',{name:'blocked.tex',exact:true})).toHaveCount(0);
 await page.evaluate(()=>{window.showDirectoryPicker=async()=>({kind:'directory',name:'blocked-folder',async *values(){yield{kind:'file',name:'blocked.tex',getFile:async()=>new File(['NO'],'blocked.tex')};}});});
 await page.evaluate(()=>window.scribyra.action('import-folder'));await expect(notice).toContainText('Switch to Editing');await expect(page.getByRole('treeitem',{name:'blocked-folder',exact:true})).toHaveCount(0);
 // The drag route bypasses action(), and must receive the same denial.
 await page.evaluate(()=>window.scribyra.action('dismiss'));
 await page.evaluate(id=>{const area=[...document.querySelectorAll('[role=treeitem]')].find(e=>e.getAttribute('aria-label')==='destination'),transfer=new DataTransfer();transfer.setData('application/x-scribyra-node',JSON.stringify({projectId:window.scribyra.agent.describe().projectId,id}));area.dispatchEvent(new DragEvent('drop',{bubbles:true,dataTransfer:transfer}));},other);
 await page.getByRole('dialog',{name:'Review file references'}).getByRole('button',{name:'Move and update',exact:true}).click();await expect(notice).toContainText('Switch to Editing');await unchanged();
 await page.evaluate(()=>{void window.scribyra.action('rename-project');});await page.getByRole('textbox',{name:'Rename project',exact:true}).fill('Blocked name');await page.getByRole('button',{name:'Rename',exact:true}).click();await expect(notice).toContainText('Switch to Editing');
 await page.evaluate(()=>{void window.scribyra.action('editor-settings');});await page.getByRole('dialog',{name:'Project settings'}).getByRole('textbox',{name:'Project name',exact:true}).fill('Blocked settings');await page.getByRole('button',{name:'Save settings',exact:true}).click();await expect(notice).toContainText('Switch to Editing');
 await page.evaluate(()=>window.scribyra.action('main-file',window.scribyra.agent.readSource({path:'other.tex'}).value.fileId));await expect(notice).toContainText('Switch to Editing');
 await page.evaluate(async()=>{await window.scribyra.action('workspace-panel','search');await window.scribyra.action('search-query','First');await window.scribyra.action('search-replacement','NO');await window.scribyra.action('search-run');});
 await page.evaluate(()=>{void window.scribyra.action('search-replace');});await page.getByRole('dialog',{name:'Review replacements'}).getByRole('button',{name:'Apply replacements',exact:true}).click();await expect(notice).toContainText('Switch to Editing');await unchanged();
 await page.evaluate(()=>window.scribyra.action('workspace-panel','files'));await comment(page);await expect(page.locator('.review-card')).toContainText('Please check');
 const download=page.waitForEvent('download');await page.getByRole('button',{name:'Export',exact:true}).click();expect((await download).suggestedFilename()).toMatch(/\.zip$/);
 // Modes apply only to the UI. A trusted agent still edits accepted source.
 await patch(page,'First','Trusted');expect(await accepted(page)).toContain('Trusted');await expect(page.getByRole('combobox',{name:'Editor mode'})).toHaveValue('viewing');
});

test('Viewing refuses existing replacement undo and review acceptance',async({page})=>{
 await setup(page);
 await page.evaluate(async()=>{await window.scribyra.action('workspace-panel','search');await window.scribyra.action('search-query','First');await window.scribyra.action('search-replacement','Changed');await window.scribyra.action('search-run');void window.scribyra.action('search-replace');});
 await page.getByRole('dialog',{name:'Review replacements'}).getByRole('button',{name:'Apply replacements',exact:true}).click();await expect.poll(()=>accepted(page)).toBe(text.replace('First','Changed'));
 await page.evaluate(()=>window.scribyra.action('workspace-panel','files'));await page.getByRole('combobox',{name:'Editor mode'}).selectOption('reviewing');await select(page,0);await page.keyboard.type('PROPOSAL');await flush(page);
 await page.getByRole('combobox',{name:'Editor mode'}).selectOption('viewing');await page.evaluate(()=>window.scribyra.action('search-undo'));await expect(page.getByRole('status',{name:'Workspace notification',exact:true})).toContainText('Switch to Editing');expect(await accepted(page)).toBe(text.replace('First','Changed'));
 const card=page.locator('.review-card').filter({hasText:'PROPOSAL'});await expect(card.getByRole('button',{name:'Accept',exact:true})).toBeHidden();await page.getByRole('button',{name:'Dismiss notification',exact:true}).click();await page.evaluate(id=>window.scribyra.action('suggestion.accept',id),await card.getAttribute('data-card-id'));await expect(page.getByRole('status',{name:'Workspace notification',exact:true})).toHaveText(/Viewing is read only. Switch to Reviewing or Editing to decide suggestions./);expect(await accepted(page)).toBe(text.replace('First','Changed'));
});

test('two open tabs retain independent conflicting drafts without overwriting recovery',async({page,context})=>{
 await setup(page);await page.getByRole('combobox',{name:'Editor mode'}).selectOption('reviewing');await expect(page.locator('.save-indicator')).toHaveText('Saved locally');
 const second=await context.newPage();try{
  await second.goto('/');await second.locator('.card-open').first().click();await expect(second.locator('.cm-content')).toBeVisible();
  for(const [tab,path,find] of [[page,'main.tex','First'],[second,'other.tex','Another']]){
   await tab.getByRole('treeitem',{name:path,exact:true}).click();await expect(tab.locator('.cm-content')).toContainText(find);
   await tab.evaluate(({path,find})=>{const view=document.querySelector('.cm-content').cmTile.root.view,at=view.state.doc.toString().indexOf(find);view.dispatch({changes:{from:at,to:at+find.length,insert:'LOCAL'}});const api=window.scribyra.agent,r=api.patchSource({expectedRevision:api.status().revision,edits:[{path,find,replace:'AGENT'}]});if(!r.ok)throw Error(JSON.stringify(r));},{path,find});
   await expect.poll(()=>tab.getByRole('region',{name:'Retained review drafts'}).getByRole('textbox').count()).toBeGreaterThan(0);
  }
  await page.reload();await page.locator('.card-open').first().click();const drafts=page.getByRole('region',{name:'Retained review drafts'});await expect(drafts.getByRole('textbox')).toHaveCount(2);await expect(drafts.getByRole('textbox',{name:'Retained draft for main.tex',exact:true})).toHaveValue(text.replace('First','LOCAL'));await expect(drafts.getByRole('textbox',{name:'Retained draft for other.tex',exact:true})).toHaveValue('LOCAL file.');
 }finally{await second.close();}
});

for(const route of ['reload','tab close','crash-like reload'])test(`review input survives ${route} before the idle flush`,async({page,context})=>{
 await setup(page);await page.getByRole('combobox',{name:'Editor mode'}).selectOption('reviewing');
 await expect(page.locator('.save-indicator')).toHaveText('Saved locally');
 // Check recovery and state in the input task, then the DOM on the next frame.
 const snapshot=await page.evaluate(async route=>{
  const started=performance.now(),statuses=[],changed=event=>statuses.push(JSON.parse(event.detail).saveStatus);window.addEventListener('scribyra:state',changed);
  const view=document.querySelector('.cm-content').cmTile.root.view;view.dispatch({changes:{from:0,insert:'UNSAVED0'}});
  const stored=Object.keys(localStorage).filter(k=>k.startsWith('scribyra:review-drafts:')).map(k=>JSON.parse(localStorage.getItem(k)).text);
  if(route==='crash-like reload')window.addEventListener('beforeunload',e=>e.stopImmediatePropagation(),{capture:true});
  window.removeEventListener('scribyra:state',changed);const immediate=statuses.at(-1);await new Promise(requestAnimationFrame);
  return {stored,text:view.state.doc.toString(),immediate,status:document.querySelector('.save-indicator').textContent,elapsed:performance.now()-started};
 },route);
 expect(snapshot.stored).toContain('UNSAVED0'+text);expect(snapshot.immediate).toBe('Review draft · not yet published');expect(snapshot.status).toBe(snapshot.immediate);expect(snapshot.elapsed).toBeLessThan(900);
 if(route==='tab close'){await page.close({runBeforeUnload:false});page=await context.newPage();await page.goto('/');}
 else {page.on('dialog',dialog=>dialog.accept());await page.reload();}
 await page.locator('.card-open').first().click();
 await expect(page.getByRole('region',{name:'Retained review drafts'}).getByRole('textbox')).toHaveValue('UNSAVED0'+text);
 expect(await accepted(page)).toBe(text);
});

async function discussionCommand(page,command){
 return page.evaluate(async command=>{const api=window.scribyra.agent,r=await api.execute({version:2,requestId:crypto.randomUUID(),projectId:api.describe().projectId,expectedRevision:api.status().revision,command});if(!r.ok)throw Error(JSON.stringify(r));return r.value;},command);
}
async function suggestionWithReply(page){
 const fileId=await page.evaluate(()=>window.scribyra.agent.readSource({path:'main.tex'}).value.fileId),review=await discussionCommand(page,{op:'review.create',title:'Suggestion discussion'}),start=text.indexOf('First');
 const suggestion=await discussionCommand(page,{op:'suggestion.propose',reviewId:review.reviewId,fileId,start,end:start+5,before:'First',after:'Opening'});
 await discussionCommand(page,{op:'thread.reply',suggestionId:suggestion.suggestionId,body:'Could we explain this choice?'});
 await openReview(page);return{review,suggestion,fileId,start};
}
for(const mode of ['editing','reviewing','viewing'])test(`suggestion replies, menus and unsent recovery in ${mode}`,async({page})=>{
 await setup(page);const {suggestion}=await suggestionWithReply(page);await page.getByRole('combobox',{name:'Editor mode'}).selectOption(mode);
 const card=page.locator(`[data-card-id="${suggestion.suggestionId}"]`);
 await expect(card).toContainText('1 reply');await card.locator('.review-card-head').first().click();
 await expect(card.getByRole('list',{name:'Replies',exact:true})).toContainText('Could we explain this choice?');await expect(card.locator('.review-reply .review-author')).toContainText('Agent');
 await card.getByRole('button',{name:/^Reply/}).click();const body=page.getByRole('textbox',{name:'Comment body',exact:true});
 await expect(body).toBeFocused();await body.press('Escape');await expect(card.locator('.review-card-location')).toBeFocused();await card.getByRole('button',{name:/^Reply/}).click();
 const draft='Human reply <img src=x onerror="window.replyHTML=true">';await body.fill(draft);expect(await accepted(page)).toBe(text);
 page.on('dialog',dialog=>dialog.accept());await page.reload();await page.locator('.card-open').first().click();await expect(body).toHaveValue(draft);
 await page.getByRole('button',{name:'Send comment',exact:true}).click();await expect(page.getByRole('status',{name:'Comment status',exact:true})).toHaveText('Saved locally');
 // Recovery opens the tools form, whose close button returns to the shared cards.
 const close=page.getByRole('button',{name:'Close review tools',exact:true});if(await close.isVisible())await close.click();
 await card.locator('.review-card-head').first().click();const replies=card.getByRole('list',{name:'Replies',exact:true});await expect(replies.getByRole('listitem')).toHaveCount(2);await expect(replies).toContainText(draft);
 expect(await page.evaluate(()=>window.replyHTML)).toBeUndefined();await expect(card.locator('img')).toHaveCount(0);expect(await accepted(page)).toBe(text);
 const human=replies.getByRole('listitem').filter({hasText:draft});await human.getByRole('button',{name:'Comment actions'}).click();await human.getByRole('button',{name:'Edit',exact:true}).click();await body.fill('Edited human reply');await page.getByRole('button',{name:'Send comment',exact:true}).click();
 await expect(replies).toContainText('Edited human reply');const edited=replies.getByRole('listitem').filter({hasText:'Edited human reply'});await edited.getByRole('button',{name:'Comment actions'}).click();await edited.getByRole('button',{name:'Delete',exact:true}).click();await expect(replies).toContainText('Message deleted');
 expect(await accepted(page)).toBe(text);await page.reload();await page.locator('.card-open').first().click();await openReview(page);await card.locator('.review-card-head').first().click();await expect(card).toContainText('Message deleted');await expect(card).toContainText('Could we explain this choice?');
});

for(const decision of ['accept','reject','withdraw'])test(`suggestion ${decision} retains discussion under Resolved`,async({page})=>{
 await setup(page);const {review,suggestion}=await suggestionWithReply(page),id=suggestion.suggestionId,card=page.locator(`[data-card-id="${id}"]`);
 const result=await discussionCommand(page,decision==='accept'?{op:'suggestion.accept',suggestionIds:[id],eventHeads:{[id]:[]}}:{op:'suggestion.'+decision,suggestionId:id,eventHeads:[]});
 await expect(card).toHaveCount(0);await expect(page.getByRole('button',{name:'Review',exact:true})).toHaveAttribute('title','Review: 0 open');
 await page.getByRole('combobox',{name:'Review status filter'}).selectOption('resolved');await expect(card).toContainText({accept:'Accepted by Agent',reject:'Rejected by Agent',withdraw:'Withdrawn by Agent'}[decision]);
 await card.locator('.review-card-head').first().click();await expect(card).toContainText('Could we explain this choice?');await expect(card.getByRole('button',{name:'Accept',exact:true})).toBeHidden();
 await card.getByRole('button',{name:/^Reply/}).click();await page.getByRole('textbox',{name:'Comment body',exact:true}).fill('After the decision');await page.getByRole('button',{name:'Send comment',exact:true}).click();await expect(card).toContainText('After the decision');
 await page.getByRole('tab',{name:'Overview',exact:true}).click();await expect(page.getByRole('button',{name:'main.tex (1)',exact:true})).toBeVisible();
 if(decision==='accept'){
  const detail=await discussionCommand(page,{op:'review.get',id:review.reviewId}),heads=detail.items.find(item=>item.id===id).eventHeads;
  await discussionCommand(page,{op:'change.undo',changeId:result.changeId,eventHeads:{[id]:heads}});await expect(card).toHaveCount(0);await page.getByRole('combobox',{name:'Review status filter'}).selectOption('open');await expect(card).toContainText('After the decision');expect(await accepted(page)).toBe(text);
 }
 await page.reload();await page.locator('.card-open').first().click();await openReview(page);await page.getByRole('combobox',{name:'Review status filter'}).selectOption(decision==='accept'?'open':'resolved');await card.locator('.review-card-head').first().click();await expect(card).toContainText('After the decision');
});

test('a reply draft follows continuous suggestion revisions without changing its immutable target',async({page})=>{
 await setup(page);await page.getByRole('combobox',{name:'Editor mode'}).selectOption('reviewing');await select(page,0);await page.keyboard.type('% A');await flush(page);const first=(await proposals(page)).find(s=>s.status==='pending');
 const card=page.locator(`[data-card-id="${first.id}"]`);await card.locator('.review-card-head').first().click();await card.getByRole('button',{name:/^Reply/}).click();await page.getByRole('textbox',{name:'Comment body',exact:true}).fill('Keep this target');
 await select(page,3);await page.keyboard.type(' longer');await flush(page);await expect.poll(async()=>(await proposals(page)).filter(s=>s.status==='pending').map(s=>s.after)).toEqual(['% A longer']);
 const second=(await proposals(page)).find(s=>s.status==='pending');expect(second.id).not.toBe(first.id);
 await expect(page.locator(`[data-card-id="${second.id}"]`).getByRole('textbox',{name:'Comment body',exact:true})).toHaveValue('Keep this target');
 await page.getByRole('button',{name:'Send comment',exact:true}).click();const threads=await discussionCommand(page,{op:'thread.list'});expect(threads.items).toHaveLength(1);expect(threads.items[0]).toMatchObject({suggestionId:first.id,displaySuggestionId:second.id});expect(await accepted(page)).toBe(text);
});

test('switching from suggestion discussion to a source thread mounts one correctly targeted composer',async({page})=>{
 await setup(page);const {suggestion,fileId}=await suggestionWithReply(page),card=page.locator(`[data-card-id="${suggestion.suggestionId}"]`);
 await card.locator('.review-card-head').first().click();await card.getByRole('button',{name:/^Reply/}).click();await page.getByRole('textbox',{name:'Comment body',exact:true}).fill('Suggestion reply');await page.getByRole('button',{name:'Send comment',exact:true}).click();await expect(page.getByRole('status',{name:'Comment status',exact:true})).toHaveText('Saved locally');
 const start=text.indexOf('Second'),thread=await discussionCommand(page,{op:'thread.create',fileId,start,end:start+6,body:'Source discussion'});
 await openReviewMenu(page);await page.getByRole('button',{name:'Review tools',exact:true}).click();await page.locator('.comment-thread-link').filter({hasText:'Second'}).click();await page.getByRole('textbox',{name:'Comment body',exact:true}).fill('Source reply from tools');await page.getByRole('button',{name:'Close review tools',exact:true}).click();
 await expect(page.locator('#comment-body:visible')).toHaveCount(1);await expect(page.locator(`[data-card-id="${thread.threadId}"]`).getByRole('textbox',{name:'Comment body',exact:true})).toHaveValue('Source reply from tools');await expect(card.getByRole('textbox')).toHaveCount(0);
 await page.getByRole('button',{name:'Send comment',exact:true}).click();const detail=await discussionCommand(page,{op:'thread.get',id:thread.threadId});expect(detail.items.some(item=>item.variants?.some(v=>v.body==='Source reply from tools'))).toBe(true);expect(await accepted(page)).toBe(text);
});
