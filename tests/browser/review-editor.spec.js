import {test,expect} from '@playwright/test';
import {mkdtemp,rm,writeFile,rename,access,readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {zipSync,strToU8} from 'fflate';
const lines=Array.from({length:40},(_,i)=>`Paragraph ${i} with ordinary prose for the review surface.`);
const text=lines.join('\n')+'\n';
async function setup(page,url='/'){await page.goto(url);const chooser=page.waitForEvent('filechooser');await page.getByRole('button',{name:'Import ZIP',exact:true}).click();await(await chooser).setFiles({name:'editor.zip',mimeType:'application/zip',buffer:Buffer.from(zipSync({'main.tex':strToU8(text)}))});await expect(page.locator('.cm-content')).toBeVisible();}
const select=(page,start,end)=>page.evaluate(({start,end})=>{const view=document.querySelector('.cm-content').cmTile.root.view;view.dispatch({selection:{anchor:start,head:end},scrollIntoView:true});view.focus();},{start,end});
const accepted=page=>page.evaluate(()=>window.scribyra.agent.readSource({path:'main.tex',startLine:1,endLine:200}).value.content);
const geometry=page=>page.evaluate(()=>{const view=document.querySelector('.cm-content').cmTile.root.view,{from,to}=view.state.selection.main,a=view.coordsAtPos(from,1),b=view.coordsAtPos(to,-1),r=document.querySelector('.add-comment-floating').getBoundingClientRect();return{pill:{top:r.top,bottom:r.bottom,left:r.left,right:r.right},selection:{top:a.top,bottom:b.bottom},width:innerWidth,height:innerHeight};});

test('selection pill never covers its selection or leaves the viewport, and Escape dismisses it',async({page})=>{
 await page.setViewportSize({width:1366,height:768});await setup(page);const pill=page.locator('.add-comment-floating');await expect(pill).toBeHidden();
 for(const n of [0,6,14]){
  const start=text.indexOf(`Paragraph ${n} `);await select(page,start,start+lines[n].length);await expect(pill).toBeVisible();await expect(pill).toHaveAttribute('title',/Add comment \((Ctrl\+Alt\+M|⌘⌥M)\)/);
  await expect.poll(async()=>{const g=await geometry(page);return(g.pill.bottom<=g.selection.top||g.pill.top>=g.selection.bottom)&&g.pill.left>=0&&g.pill.top>=0&&g.pill.right<=g.width&&g.pill.bottom<=g.height;}).toBe(true);
 }
 await page.keyboard.press('Escape');await expect(pill).toBeHidden();
 await page.waitForTimeout(200);await expect(pill).toBeHidden();
 await select(page,0,9);await expect(pill).toBeVisible();await select(page,0,0);await expect(pill).toBeHidden();
 // Viewing is read only, but selection, focus and commenting all still work.
 await page.getByRole('combobox',{name:'Editor mode'}).selectOption('viewing');await select(page,0,9);await expect(pill).toBeVisible();await expect(page.locator('.cm-content')).toBeFocused();
 await pill.click();await page.getByRole('textbox',{name:'Comment body',exact:true}).fill('A note from Viewing.');await page.getByRole('button',{name:'Send comment',exact:true}).click();
 await expect(page.locator('.review-card').filter({hasText:'A note from Viewing.'})).toBeVisible();await expect(page.locator('.comment-highlight').first()).toBeVisible();expect(await accepted(page)).toBe(text);
});

test('a card or highlight shows its text without opening the pill, and a person\'s own selection still does',async({page})=>{
 await page.setViewportSize({width:1366,height:768});await setup(page);const pill=page.locator('.add-comment-floating'),start=text.indexOf('Paragraph 2 ');
 await select(page,start,start+11);await pill.click();await page.getByRole('textbox',{name:'Comment body',exact:true}).fill('Card note.');await page.getByRole('button',{name:'Send comment',exact:true}).click();
 const card=page.locator('.review-card').filter({hasText:'Card note.'});await expect(card).toBeVisible();await select(page,0,0);await expect(pill).toBeHidden();
 const editorSelection=()=>page.evaluate(()=>{const {from,to}=document.querySelector('.cm-content').cmTile.root.view.state.selection.main;return[from,to];});
 for(const click of [()=>card.locator('.review-message-first').click(),()=>card.locator('.review-card-location').click(),()=>page.locator('.comment-highlight').first().click()]){
  await select(page,0,0);await expect(pill).toBeHidden();await click();await expect(card).toHaveClass(/active/);await expect.poll(editorSelection).toEqual([start,start+11]);await page.waitForTimeout(150);await expect(pill).toBeHidden();
 }
 // The same words chosen again by hand are a person's own selection.
 await select(page,0,0);await select(page,start,start+11);await expect(pill).toBeVisible();
 // An older selection does not come back when a card takes focus.
 await select(page,0,9);await expect(pill).toBeVisible();await card.locator('.review-message-first').click();await page.waitForTimeout(150);await expect(pill).toBeHidden();
});

test('Viewing keeps caret and selection while typing, paste, cut, drop, undo and native input all leave source alone',async({page})=>{
 await setup(page);const source=()=>accepted(page),mode=page.getByRole('combobox',{name:'Editor mode'}),content=page.locator('.cm-content');
 const shown=()=>page.evaluate(()=>{const view=document.querySelector('.cm-content').cmTile.root.view;return{doc:view.state.doc.toString(),line:document.querySelector('.cm-line').textContent};});
 // Gecko creates its own empty clipboard store; populate the event's store too.
 const synthetic=(kind,value)=>page.evaluate(({kind,value})=>{const node=document.querySelector('.cm-content'),view=node.cmTile.root.view,data=new DataTransfer();data.setData('text/plain',value);if(kind==='paste'){const event=new ClipboardEvent('paste',{clipboardData:data,bubbles:true,cancelable:true});event.clipboardData.setData('text/plain',value);if(event.clipboardData.getData('text/plain')!==value)throw new Error('Synthetic clipboard did not retain its text.');node.dispatchEvent(event);}else{const at=view.coordsAtPos(0);node.dispatchEvent(new DragEvent('drop',{dataTransfer:data,clientX:at.left,clientY:at.top+2,bubbles:true,cancelable:true}));}},{kind,value});
 // Controls: the same synthetic events do change source while Editing, so their silence below means something.
 await select(page,0,0);await synthetic('paste','P');await expect.poll(source).toBe('P'+text);
 await select(page,0,0);await synthetic('drop','D');await expect.poll(async()=>(await source()).length).toBe(text.length+2);
 await select(page,0,0);await page.keyboard.type('U');const before=await source();expect(before.length).toBe(text.length+3);
 await mode.selectOption('viewing');await expect(page.locator('.writing-area')).toHaveAttribute('data-review-mode','viewing');await expect(content).toHaveAttribute('aria-readonly','true');
 const unchanged=async()=>{await page.waitForTimeout(80);const now=await shown();expect(now.doc).toBe(before);expect(now.line).toBe(before.split('\n')[0]);expect(await source()).toBe(before);};
 await select(page,0,9);await expect(content).toBeFocused();await page.keyboard.press('Shift+ArrowRight');expect(await page.evaluate(()=>document.querySelector('.cm-content').cmTile.root.view.state.selection.main.head)).toBe(10);
 await page.keyboard.type('NO');await unchanged();
 for(const key of ['Enter','Backspace','Delete','ControlOrMeta+x','ControlOrMeta+z','ControlOrMeta+Shift+z','ControlOrMeta+y']){await select(page,0,9);await page.keyboard.press(key);await unchanged();}
 await select(page,0,9);await synthetic('paste','NO');await unchanged();
 await select(page,0,9);await synthetic('drop','NO');await unchanged();
 for(const command of ['insertText','delete','undo','redo']){await select(page,0,9);await page.evaluate(command=>document.execCommand(command,false,'NO'),command);await unchanged();}
});

test('Viewing refuses native IME commits and cancels without leaving text behind',async({page,context,playwright,browserName,baseURL})=>{
 let ownContext,ownBrowser,ime,profile,directory;
 try{
  if(browserName==='firefox'){
   const {reserveMarionettePort,firefoxIme}=await import('../helpers/firefox-ime.mjs');await reserveMarionettePort();profile=await mkdtemp(join(tmpdir(),'viewing-gecko-'));ownContext=await playwright.firefox.launchPersistentContext(profile,{headless:true,args:['--marionette','--remote-allow-system-access']});page=ownContext.pages()[0]||await ownContext.newPage();await setup(page,baseURL);ime=await firefoxIme(profile,new URL(baseURL).origin);
  }else if(browserName==='webkit'){
   const {buildNativeIme}=await import('../../scripts/build-native-ime.mjs'),library=await buildNativeIme();directory=await mkdtemp(join(tmpdir(),'viewing-wpe-'));ownBrowser=await playwright.webkit.launch({headless:true,env:{...process.env,LD_PRELOAD:library,SCRIBYRA_NATIVE_IME_DIRECTORY:directory}});ownContext=await ownBrowser.newContext();page=await ownContext.newPage();await setup(page,baseURL);
   await expect.poll(async()=>{try{await access(join(directory,'ready'));return true;}catch{return false;}}).toBe(true);
   const send=async(command,value='')=>{await rm(join(directory,'done'),{force:true});await writeFile(join(directory,'next'),command+':'+value);await rename(join(directory,'next'),join(directory,'command'));await expect.poll(async()=>{try{return await readFile(join(directory,'done'),'utf8');}catch{return '';}}).toBe(command);};ime={preedit:value=>send('preedit',value),cancel:()=>send('cancel'),commit:value=>send('commit',value)};
  }else{
   await setup(page);const cdp=await context.newCDPSession(page);ime={preedit:value=>cdp.send('Input.imeSetComposition',{text:value,selectionStart:value.length,selectionEnd:value.length}),cancel:()=>cdp.send('Input.imeSetComposition',{text:'',selectionStart:0,selectionEnd:0}),commit:async value=>{await cdp.send('Input.insertText',{text:value});await cdp.send('Input.imeSetComposition',{text:'',selectionStart:0,selectionEnd:0});},close:()=>cdp.detach()};
  }
  await page.getByRole('combobox',{name:'Editor mode'}).selectOption('viewing');await page.waitForTimeout(200);
  const clean=async()=>{await expect.poll(()=>page.evaluate(()=>{const view=document.querySelector('.cm-content').cmTile.root.view;return[view.state.doc.toString()===window.scribyra.agent.readSource({path:'main.tex',startLine:1,endLine:200}).value.content,view.state.doc.length,document.querySelector('.cm-line').textContent];})).toEqual([true,text.length,lines[0]]);};
  await select(page,0);await ime.preedit('キャンセル');await page.waitForTimeout(150);await ime.cancel();await clean();
  await select(page,0);await ime.preedit('にほ');await page.waitForTimeout(150);await ime.commit('日本語');await clean();
 }finally{await ime?.close?.();await ownContext?.close();await ownBrowser?.close();if(profile)await rm(profile,{recursive:true,force:true});if(directory)await rm(directory,{recursive:true,force:true});}
});

test('mode control shows state, toolbar fits with the panel open, and Cancel appears only while running',async({page})=>{
 await page.setViewportSize({width:1366,height:768});await setup(page);const area=page.locator('.writing-area'),mode=page.getByRole('combobox',{name:'Editor mode'});
 await expect(area).toHaveAttribute('data-review-mode','editing');await expect(page.getByRole('button',{name:'Cancel compilation',exact:true})).toBeHidden();
 await mode.selectOption('reviewing');await expect(area).toHaveAttribute('data-review-mode','reviewing');await expect(page.locator('.review-mode')).toHaveAttribute('data-mode','reviewing');await expect(page.locator('.review-mode-hint')).toHaveText('Your edits are saved as suggestions');await expect(page.getByRole('button',{name:'Review',exact:true})).toHaveAttribute('aria-expanded','true');
 const toolbar=await page.locator('.workspace-toolbar').evaluate(n=>({height:n.getBoundingClientRect().height,overflow:n.scrollWidth-n.clientWidth}));expect(toolbar.height).toBeLessThanOrEqual(46);expect(toolbar.overflow).toBeLessThanOrEqual(0);
 await mode.selectOption('viewing');await expect(page.locator('.review-mode-hint')).toHaveText('Read only');
});

test('compile options open from the split button and close on Escape or outside press',async({page})=>{
 await setup(page);const trigger=page.getByRole('button',{name:'Compile options',exact:true}),auto=page.getByRole('checkbox',{name:'Auto',exact:true});await expect(auto).toBeHidden();
 await trigger.focus();await page.keyboard.press('Enter');await expect(trigger).toHaveAttribute('aria-expanded','true');await auto.check();await expect(auto).toBeChecked();await expect(trigger).toHaveAttribute('data-active','true');await expect(auto).toBeVisible();
 await page.keyboard.press('Escape');await expect(auto).toBeHidden();await expect(trigger).toBeFocused();
 await trigger.click();await expect(auto).toBeVisible();await page.locator('.preview-pane').click({position:{x:40,y:300}});await expect(auto).toBeHidden();
 await trigger.click();await auto.focus();await page.keyboard.press('Tab');await page.keyboard.press('Tab');await expect(auto).toBeHidden();
 await trigger.click();await auto.uncheck();await expect(trigger).toHaveAttribute('data-active','false');
});

test('pending marks keep a thin author underline and natural text, and rarely used tools keep their names',async({page})=>{
 await setup(page);await page.getByRole('combobox',{name:'Editor mode'}).selectOption('reviewing');await select(page,0,0);await page.keyboard.type('Inserted ');
 const mark=page.locator('ins.tracked-insert').first();await expect(mark).toHaveAttribute('aria-label',/inserted Inserted/);
 const style=await mark.evaluate(n=>{const s=getComputedStyle(n);return{line:s.textDecorationLine,thick:s.textDecorationThickness,color:s.color,parent:getComputedStyle(n.closest('.cm-line')).color};});expect(style.line).toBe('underline');expect(parseFloat(style.thick)).toBeLessThanOrEqual(1);expect(style.color).toBe(style.parent);
 await expect(page.locator('.review-changed-line')).toHaveCount(1);
 for(const name of ['History','More tools','Toggle theme','Export'])await expect(page.locator('.editor-header').getByRole('button',{name,exact:true})).toBeVisible();
 await page.getByRole('button',{name:'More tools',exact:true}).click();for(const name of ['MCP providers','TeX environment','Project settings','Diagnostics'])await expect(page.locator('.editor-header').getByRole('button',{name,exact:true})).toBeVisible();await page.keyboard.press('Escape');
});

test('Viewing hides decisions and refuses them, while Reviewing still offers them',async({page})=>{
 await page.setViewportSize({width:1366,height:768});await setup(page);const mode=page.getByRole('combobox',{name:'Editor mode'}),accept=page.getByRole('button',{name:'Accept',exact:true});
 await mode.selectOption('reviewing');await select(page,0,0);await page.keyboard.type('Pending ');await page.getByRole('button',{name:'Review',exact:true}).focus();await expect(accept).toBeVisible();
 const id=await page.locator('.review-card').first().getAttribute('data-card-id');
 await mode.selectOption('viewing');await expect(page.locator('.review-card')).toHaveCount(1);await expect(accept).toBeHidden();await expect(page.getByRole('button',{name:'Reject',exact:true})).toBeHidden();
 await page.evaluate(id=>window.scribyra.action('suggestion.accept',id),id);await page.waitForTimeout(200);expect(await accepted(page)).toBe(text);await expect(page.locator('.review-card')).toHaveCount(1);
 await mode.selectOption('reviewing');await expect(accept).toBeVisible();
});

test('a new project explains the mode and how to comment, and every top tool has a name and tooltip',async({page})=>{
 await page.setViewportSize({width:1366,height:768});await setup(page);const mode=page.getByRole('combobox',{name:'Editor mode'});
 await expect(mode).toHaveValue('editing');await expect(page.locator('.review-mode-hint')).toHaveText('Changes apply directly');await expect(page.locator('.review-mode-tip')).toHaveText('Select text to comment');
 await page.getByRole('button',{name:'Review',exact:true}).click();await expect(page.locator('.review-empty')).toContainText('Select text in the editor to add a comment');
 await mode.selectOption('reviewing');await expect(page.locator('.review-empty')).toContainText('Type in the editor to suggest a change');await expect(page.locator('.review-empty')).not.toContainText('switch to Reviewing');
 await mode.selectOption('viewing');await expect(page.locator('.review-empty')).toContainText('Read only');await mode.selectOption('editing');
 for(const width of [1366,700]){
  await page.setViewportSize({width,height:768});
  const missing=await page.evaluate(()=>[...document.querySelectorAll('.editor-header button,.workspace-toolbar button,.editor-tab button,.preview-toolbar button,.sidebar-heading button')].filter(b=>b.offsetParent!==null).flatMap(b=>{const name=(b.getAttribute('aria-label')||b.textContent||'').trim(),visible=b.innerText.trim()!=='';return!name||(!visible&&!b.title)?[b.outerHTML.slice(0,120)]:[];}));
  expect(missing).toEqual([]);
 }
});

test('narrow layouts neither overflow nor bury the source behind the review panel',async({page})=>{
 await setup(page);const toggle=page.getByRole('button',{name:'Review',exact:true}),panel=page.locator('#review-workspace'),source=page.locator('.source-pane');
 for(const width of [1200,1000,900,820,760,700,600,560,480,420,375,320]){
  await page.setViewportSize({width,height:768});if(await toggle.getAttribute('aria-expanded')==='true')await toggle.click();
  const header=async()=>page.evaluate(()=>{const n=document.querySelector('.editor-header'),last=[...n.children].filter(c=>c.offsetParent!==null).at(-1).getBoundingClientRect();return{overflow:n.scrollWidth-n.clientWidth,right:last.right,page:document.documentElement.scrollWidth-innerWidth};});
  let m=await header();expect(m.overflow,`header ${width}`).toBeLessThanOrEqual(0);expect(m.right,`last tool ${width}`).toBeLessThanOrEqual(width);expect(m.page,`page ${width}`).toBeLessThanOrEqual(0);
  await toggle.click();await expect(panel).toBeVisible();await expect(page.getByRole('button',{name:'Close review panel',exact:true})).toBeInViewport();
  m=await header();expect(m.page,`page with panel ${width}`).toBeLessThanOrEqual(0);
  if(width>560){const a=await source.boundingBox(),b=await panel.boundingBox();const uncovered=Math.min(a.x+a.width,b.x)-a.x;expect(uncovered,`source beside panel ${width}`).toBeGreaterThanOrEqual(width>=700?240:180);}
 }
});

test('five author colours stay soft and readable on active insertions, deletions and cards in both themes',async({page,browserName})=>{
 await page.setViewportSize({width:1366,height:768});await setup(page);
 for(let author=0;author<5;author++){
  await page.evaluate(author=>localStorage.setItem('scribyra:author',JSON.stringify({id:`12345678-1234-1234-1234-123456789ab${author}`,displayName:['Alex Rivera','Bea Martin','Chris Lee','Daria Novak','Emil Jensen'][author]})),author);
  await page.reload();await page.locator('.card-open').first().click();await expect(page.locator('.cm-content')).toBeVisible();
  await page.getByRole('combobox',{name:'Editor mode'}).selectOption('reviewing');
  const offset=await page.evaluate(author=>document.querySelector('.cm-content').cmTile.root.view.state.doc.toString().indexOf(`Paragraph ${author}`),author);
  await select(page,offset,offset+9);await page.keyboard.type('Revised paragraph ');await page.getByRole('button',{name:'Review',exact:true}).focus();
  await expect(page.locator('.review-card')).toHaveCount(author+1);await expect(page.locator('.save-indicator')).toHaveText('Saved locally');
 }
 const {default:AxeBuilder}=await import('@axe-core/playwright'),contrast=[];
 const settled=()=>expect.poll(()=>page.locator('.review-card').evaluateAll(nodes=>{const boxes=nodes.map(node=>node.getBoundingClientRect());return boxes.every((box,i)=>!i||box.top-boxes[i-1].bottom>=7.5);})).toBe(true);
 for(const theme of ['light','dark']){
  if(theme==='dark')await page.getByRole('button',{name:'Toggle theme',exact:true}).click();
  const cards=page.locator('.review-card');
  for(let author=0;author<5;author++){
   await cards.nth(author).locator('.review-card-head').click();
   await expect(page.locator('#code-editor ins.review-active')).toHaveCount(1);
   const tint=await page.locator('#code-editor ins.review-active').evaluate(node=>getComputedStyle(node).backgroundColor);
   expect(tint).toMatch(/(?:0\.18|18%)/);
   if(author===0){await settled();await page.screenshot({path:`tmp/suggestion-threads/screenshots/${browserName}-${theme}-five-authors.png`});}
   const audit=await new AxeBuilder({page}).include('#code-editor').include('#review-workspace').withRules(['color-contrast']).analyze();
   expect(audit.violations.map(v=>v.nodes.map(n=>({target:n.target,summary:n.failureSummary})))).toEqual([]);
   const ratios=audit.passes.filter(rule=>rule.id==='color-contrast').flatMap(rule=>rule.nodes).filter(node=>node.html.startsWith('<del')).flatMap(node=>node.any.map(check=>Number(check.data?.contrastRatio))).filter(Number.isFinite);
   expect(ratios.length).toBeGreaterThan(0);expect(Math.min(...ratios)).toBeGreaterThanOrEqual(4.5);contrast.push({theme,author,minimumDeletionContrast:Math.min(...ratios)});
  }
  const colours=await page.locator('#code-editor del.tracked-delete').evaluateAll(nodes=>nodes.map(node=>getComputedStyle(node).color));expect(new Set(colours).size).toBe(5);
  await cards.first().locator('.review-card-head').click();await settled();
  await page.screenshot({path:`tmp/suggestion-threads/screenshots/${browserName}-${theme}-five-authors.png`});
 }
 await writeFile(`tmp/suggestion-threads/${browserName}-contrast.json`,JSON.stringify(contrast));
 expect(await accepted(page)).toBe(text);
});
