import {test,expect} from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import {zipSync,strToU8} from 'fflate';
import {mkdir} from 'node:fs/promises';
const source='\\documentclass{article}\n\\begin{document}\nalpha alpha ALPHA alphabet\nA second alpha paragraph.\n\\end{document}\n';
test.setTimeout(90000);
test.use({viewport:{width:1366,height:768},actionTimeout:15000});
async function setup(page,text=source){
 await page.goto('/');const chooser=page.waitForEvent('filechooser');await page.getByRole('button',{name:'Import ZIP',exact:true}).click();await(await chooser).setFiles({name:'editor-search.zip',mimeType:'application/zip',buffer:Buffer.from(zipSync({'main.tex':strToU8(text)}))});await expect(page.locator('.cm-content')).toBeVisible();
}
async function open(page,query='alpha'){
 await page.locator('.cm-content').focus();await page.keyboard.press('Control+Home');await page.keyboard.press('Control+f');await expect(page.getByRole('textbox',{name:'Find',exact:true})).toBeFocused();await page.getByRole('textbox',{name:'Find',exact:true}).fill(query);
}
const panel=page=>page.locator('.cm-search');
const button=(page,name)=>panel(page).getByRole('button',{name,exact:true});
const count=page=>panel(page).getByRole('status',{name:'Search results'});
async function accepted(page){return page.evaluate(()=>window.scribyra.agent.readSource({path:'main.tex',startLine:1,endLine:200}).value.content);}
async function select(page,from,to=from){await page.evaluate(({from,to})=>{const view=document.querySelector('.cm-content').cmTile.root.view;view.dispatch({selection:{anchor:from,head:to}});},{from,to});}
async function snapshot(page,name){await mkdir('tmp/editor-search',{recursive:true});await page.screenshot({path:`tmp/editor-search/${name}.png`});}
async function audit(page,searchOnly=false){let builder=new AxeBuilder({page});if(searchOnly)builder=builder.include('.cm-search').include('.cm-searchMatch');const result=await builder.withTags(['wcag2a','wcag2aa','wcag21a','wcag21aa']).analyze();expect(result.violations.map(v=>({id:v.id,nodes:v.nodes.map(n=>({target:n.target,summary:n.failureSummary}))}))).toEqual([]);}
for(const theme of ['light','dark'])test(`${theme} themed results, options, empty and invalid queries pass axe`,async({page,browserName})=>{
 await setup(page);await page.evaluate(theme=>document.documentElement.dataset.theme=theme,theme);await open(page);
 await expect(count(page)).toHaveText('5 matches');await page.keyboard.press('Enter');await expect(count(page)).toHaveText('1 of 5');
 await page.getByRole('textbox',{name:'Replace',exact:true}).fill('beta');await snapshot(page,`${browserName}-${theme}-results`);await audit(page);
 const normal=page.locator('.cm-searchMatch:not(.cm-searchMatch-selected)').first(),current=page.locator('.cm-searchMatch-selected');await expect(current).toHaveCount(1);expect(await current.evaluate(n=>getComputedStyle(n).backgroundColor)).not.toBe(await normal.evaluate(n=>getComputedStyle(n).backgroundColor));
 await button(page,'match case').focus();await page.keyboard.press('Space');await expect(button(page,'match case')).toHaveAttribute('aria-pressed','true');await expect(count(page)).toHaveText('1 of 4');
 await button(page,'by word').click();await expect(button(page,'by word')).toHaveAttribute('aria-pressed','true');await expect(count(page)).toHaveText('1 of 3');await audit(page);
 await page.getByRole('textbox',{name:'Find',exact:true}).fill('missing');await expect(count(page)).toHaveText('No results');await expect(button(page,'next')).toBeDisabled();await snapshot(page,`${browserName}-${theme}-no-results`);await audit(page);
 await button(page,'regexp').click();await page.getByRole('textbox',{name:'Find',exact:true}).fill('[');await expect(count(page)).toHaveText('Invalid expression');await expect(page.getByRole('textbox',{name:'Find',exact:true})).toHaveAttribute('aria-invalid','true');
 await page.getByRole('textbox',{name:'Find',exact:true}).fill('');await expect(count(page)).toHaveText('Find in file');await expect(page.getByRole('textbox',{name:'Find',exact:true})).toHaveAttribute('aria-invalid','false');
});
test('search shortcuts, selection, select all and focus survive panel close and reopen',async({page})=>{
 await setup(page);await open(page);await page.keyboard.press('Enter');await expect(count(page)).toHaveText('1 of 5');await page.keyboard.press('Enter');await expect(count(page)).toHaveText('2 of 5');await page.keyboard.press('Shift+Enter');await expect(count(page)).toHaveText('1 of 5');
 for(const [key,result]of [['F3','2 of 5'],['Shift+F3','1 of 5'],['Control+g','2 of 5'],['Control+Shift+G','1 of 5']]){await page.keyboard.press(key);await expect(count(page)).toHaveText(result);}
 await button(page,'previous').click();await expect(count(page)).toHaveText('5 of 5');await button(page,'next').click();await expect(count(page)).toHaveText('1 of 5');
 await button(page,'all').click();expect(await page.evaluate(()=>{const view=document.querySelector('.cm-content').cmTile.root.view;return view.state.sliceDoc(view.state.selection.main.from,view.state.selection.main.to);})).toBe('alpha');expect(await accepted(page)).toBe(source);
 await page.getByRole('textbox',{name:'Find',exact:true}).focus();await page.keyboard.press('Escape');await expect(panel(page)).toHaveCount(0);await expect(page.locator('.cm-content')).toBeFocused();
 await page.keyboard.press('Control+f');await expect(page.getByRole('textbox',{name:'Find',exact:true})).toBeFocused();await button(page,'close').click();await expect(page.locator('.cm-content')).toBeFocused();
});
test('replace, replace all, regex captures and undo keep CodeMirror semantics',async({page})=>{
 await setup(page);await open(page);await page.keyboard.press('Enter');await page.getByRole('textbox',{name:'Replace',exact:true}).fill('beta');await page.keyboard.press('Enter');await expect.poll(()=>accepted(page)).toBe(source.replace('alpha','beta'));await expect(count(page)).toHaveText('1 of 4');
 await button(page,'replace all').click();await expect.poll(()=>accepted(page)).toBe(source.replace(/alpha/gi,'beta'));await expect(count(page)).toHaveText('No results');
 await page.locator('.cm-content').focus();await page.keyboard.press('Control+z');await expect.poll(async()=>[source,source.replace('alpha','beta')].includes(await accepted(page))).toBe(true);const restored=await accepted(page);
 await open(page,'(alpha)');await button(page,'regexp').click();await page.getByRole('textbox',{name:'Replace',exact:true}).fill('$1!');await button(page,'replace all').click();await expect.poll(()=>accepted(page)).toBe(restored.replace(/alpha/gi,'$&!'));
});
test('Reviewing replace and replace all create suggestions without changing accepted source',async({page,browserName})=>{
 await setup(page);const at=source.indexOf('paragraph');await select(page,at,at+9);await page.locator('.cm-content').focus();await page.locator('.add-comment-floating').click();await page.getByRole('textbox',{name:'Comment body',exact:true}).fill('Check this paragraph.');await page.getByRole('button',{name:'Send comment',exact:true}).click();await expect(page.getByRole('status',{name:'Comment status',exact:true})).toHaveText('Saved locally');await page.getByRole('combobox',{name:'Editor mode'}).selectOption('reviewing');await open(page);await page.keyboard.press('Enter');await page.getByRole('textbox',{name:'Replace',exact:true}).fill('beta');await button(page,'replace').click();expect(await accepted(page)).toBe(source);await expect(page.locator('.tracked-insert')).toContainText('beta');
 await button(page,'replace all').click();await expect.poll(()=>accepted(page)).toBe(source);await expect.poll(()=>page.evaluate(()=>document.querySelector('.cm-content').cmTile.root.view.state.doc.toString())).toBe(source.replace(/alpha/gi,'beta'));
 await page.getByRole('button',{name:'Review',exact:true}).focus();await expect(page.locator('.review-card')).not.toHaveCount(0);await open(page,'beta');await page.keyboard.press('Enter');await expect(page.locator('.comment-highlight')).toBeVisible();await snapshot(page,`${browserName}-reviewing-light`);await audit(page,true);await page.getByRole('button',{name:'Toggle theme',exact:true}).click();await snapshot(page,`${browserName}-reviewing-dark`);await audit(page,true);
 await page.getByRole('combobox',{name:'Editor mode'}).selectOption('editing');await expect.poll(()=>accepted(page)).toBe(source);
});
test('Viewing refuses replacement through buttons, Enter and direct editor transactions',async({page})=>{
 await setup(page);await page.getByRole('combobox',{name:'Editor mode'}).selectOption('viewing');await open(page);await page.keyboard.press('Enter');await page.getByRole('textbox',{name:'Replace',exact:true}).fill('NO');await expect(button(page,'replace')).toBeDisabled();await expect(button(page,'replace all')).toBeDisabled();await page.keyboard.press('Enter');
 // Removing the presentation lock still reaches CodeMirror readOnly and the central transaction filter.
 await button(page,'replace all').evaluate(node=>{node.disabled=false;node.click();});await page.evaluate(()=>{const view=document.querySelector('.cm-content').cmTile.root.view;view.dispatch({changes:{from:0,to:5,insert:'NO'}});});
 expect(await accepted(page)).toBe(source);expect(await page.evaluate(()=>document.querySelector('.cm-content').cmTile.root.view.state.doc.toString())).toBe(source);await expect(count(page)).toHaveText('1 of 5');await audit(page);
});
test('narrow panels wrap every control without overflowing their source pane',async({page,browserName})=>{
 await setup(page);await open(page);await page.getByRole('textbox',{name:'Replace',exact:true}).fill('beta');
 for(const width of [700,480]){
  await page.setViewportSize({width,height:768});await expect.poll(()=>panel(page).evaluate(node=>node.scrollWidth-node.clientWidth)).toBeLessThanOrEqual(1);
  const outside=await panel(page).evaluate(node=>{const p=node.getBoundingClientRect();return [...node.querySelectorAll('input,button')].filter(n=>{const r=n.getBoundingClientRect();return r.left<p.left||r.right>p.right+1;}).map(n=>n.name);});expect(outside).toEqual([]);await snapshot(page,`${browserName}-narrow-${width}`);
 }
});
test('counts follow external query, document and selection changes and work offline',async({page,context})=>{
 await setup(page);await open(page);await select(page,source.indexOf('alpha'),source.indexOf('alpha')+5);await expect(count(page)).toHaveText('1 of 5');
 await page.evaluate(()=>{const api=window.scribyra.agent;const result=api.patchSource({expectedRevision:api.status().revision,edits:[{path:'main.tex',find:'alphabet',replace:'other'}]});if(!result.ok)throw Error(JSON.stringify(result));});await expect(count(page)).toHaveText('1 of 4');
 await page.evaluate(()=>{const view=document.querySelector('.cm-content').cmTile.root.view,from=view.state.doc.toString().indexOf('other');view.dispatch({selection:{anchor:from,head:from+5}});view.focus();});await page.keyboard.press('Control+f');await expect(page.getByRole('textbox',{name:'Find',exact:true})).toHaveValue('other');await expect(count(page)).toHaveText('1 of 1');
 await expect.poll(()=>page.evaluate(()=>Boolean(navigator.serviceWorker.controller))).toBe(true);await context.setOffline(true);await button(page,'close').click();await open(page,'other');await expect(count(page)).toHaveText('1 match');await context.setOffline(false);
});
test('large match counts are explicitly bounded',async({page})=>{
 await setup(page,'alpha '.repeat(10001));await open(page);await expect(count(page)).toHaveText('10,000+ matches');await page.keyboard.press('Enter');await expect(count(page)).toHaveText('1 of 10,000+');
});

test('Reviewing regex replace all preserves intervening foreign suggestions and refuses a mixed batch atomically',async({page})=>{
 const text='alpha X alpha';await setup(page,text);
 const foreign=await page.evaluate(async()=>{const api=window.scribyra.agent,call=async command=>{const r=await api.execute({version:2,requestId:crypto.randomUUID(),projectId:api.describe().projectId,expectedRevision:api.status().revision,command});if(!r.ok)throw Error(JSON.stringify(r));return r.value;},review=await call({op:'review.create',title:'Foreign suggestion'}),fileId=api.readSource({path:'main.tex'}).value.fileId;const suggestion=await call({op:'suggestion.propose',reviewId:review.reviewId,fileId,start:6,end:7,before:'X',after:'Y'});return{...suggestion,reviewId:review.reviewId};});
 await page.getByRole('combobox',{name:'Editor mode'}).selectOption('reviewing');await open(page,'alpha|Y');await button(page,'regexp').click();await page.getByRole('textbox',{name:'Replace',exact:true}).fill('beta');await button(page,'replace all').click();
 const display=()=>page.evaluate(()=>document.querySelector('.cm-content').cmTile.root.view.state.doc.toString());
 await expect.poll(display).toBe('alpha Y alpha');await expect(page.getByRole('status',{name:'Tracked changes',exact:true})).toContainText("other author's suggestion");expect(await accepted(page)).toBe(text);
 await page.getByRole('textbox',{name:'Find',exact:true}).fill('(alpha)');await page.getByRole('textbox',{name:'Replace',exact:true}).fill('$1!');await button(page,'replace all').click();await expect.poll(display).toBe('alpha! Y alpha!');
 await page.getByRole('button',{name:'Review',exact:true}).focus();
 const records=await page.evaluate(async foreign=>{const api=window.scribyra.agent,r=await api.execute({version:2,requestId:crypto.randomUUID(),projectId:api.describe().projectId,command:{op:'review.get',id:foreign.reviewId}});if(!r.ok)throw Error(JSON.stringify(r));return r.value.items;},foreign);
 expect(records.find(r=>r.id===foreign.suggestionId)).toMatchObject({status:'pending',before:'X',after:'Y'});await expect.poll(()=>page.locator('.tracked-insert').evaluateAll(nodes=>new Set(nodes.map(n=>n.dataset.reviewId)).size)).toBe(3);expect(await accepted(page)).toBe(text);
});
