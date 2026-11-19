// The Outline tree and the resizable left sidebar; performance is reported in docs/large-projects.md.
import { test,expect } from '@playwright/test';
import { zipSync,strToU8 } from 'fflate';
import { thesis } from '../../scripts/large-projects.mjs';
test.use({actionTimeout:15000});
test.setTimeout(120000);

const LONG='Survey design with a deliberately long title that cannot fit in the sidebar';
const SOURCES={
  'main.tex':'\\documentclass{report}\n\\title{Outline fixture}\n\\begin{document}\n\\chapter{Getting started}\n\\section{Why outlines matter}\nSome text.\n\\input{chapters/methods}\n\\chapter{Discussion}\n\\section{Closing \\emph{remarks}\\label{sec:closing}}\nMore text.\n\\end{document}\n',
  'chapters/methods.tex':`\\chapter{Methods}\n\\section{Data collection}\n\\subsection{${LONG}}\nA paragraph.\n\\subsection{Sampling}\nSampling text.\n\\section{Analysis}\n\\subsubsection{Deep}\nThe end.\n`,
};
async function importProject(page,name,files){
  await page.goto('/');const chooser=page.waitForEvent('filechooser');await page.getByRole('button',{name:'Import ZIP',exact:true}).click();
  await (await chooser).setFiles({name:`${name}.zip`,mimeType:'application/zip',buffer:Buffer.from(zipSync(Object.fromEntries(Object.entries(files).map(([path,text])=>[path,typeof text==='string'?strToU8(text):text]))))});
  await expect(page.locator('.cm-content')).toBeVisible();
}
const tree=page=>page.getByRole('tree',{name:'Outline',exact:true});
const item=(page,name)=>tree(page).getByRole('treeitem',{name,exact:true});
async function showOutline(page,count){await page.getByRole('button',{name:'Document outline',exact:true}).click();await expect(page.locator('.tool-status')).toHaveText(`${count} headings`);}
async function reopen(page,name){await page.reload();await page.getByRole('button',{name:new RegExp(`${name}.*files`)}).click();await expect(page.locator('.cm-content')).toBeVisible();}
const visibleTitles=page=>tree(page).getByRole('treeitem').evaluateAll(rows=>rows.sort((a,b)=>a.getBoundingClientRect().top-b.getBoundingClientRect().top).map(row=>row.textContent));

test('the outline is a tree across included files that collapses, expands and remembers it',async({page})=>{
  const errors=[];page.on('pageerror',e=>errors.push(e.message));await importProject(page,'outline-tree',SOURCES);await showOutline(page,11);
  await expect(page.getByLabel('Outline scope',{exact:true})).toHaveValue('project');
  expect(await visibleTitles(page)).toEqual(['Outline fixture','Getting started','Why outlines matter','Methods','Data collection',LONG,'Sampling','Analysis','Deep','Discussion','Closing remarks']);
  await expect(item(page,'Methods')).toHaveAttribute('aria-level','1');await expect(item(page,'Deep')).toHaveAttribute('aria-level','3');
  await expect(item(page,'Methods')).toHaveAttribute('aria-posinset','3');await expect(item(page,'Methods')).toHaveAttribute('aria-setsize','4');
  await expect(item(page,'Outline fixture')).not.toHaveAttribute('aria-expanded',/.*/);
  await item(page,'Methods').locator('.outline-chevron').click();
  await expect(item(page,'Methods')).toHaveAttribute('aria-expanded','false');await expect(item(page,'Sampling')).toHaveCount(0);
  await expect(page.getByRole('tab',{name:'main.tex',exact:true})).toHaveAttribute('aria-selected','true'); // the chevron toggles without jumping
  await page.getByRole('button',{name:'Collapse all',exact:true}).click();
  expect(await visibleTitles(page)).toEqual(['Outline fixture','Getting started','Methods','Discussion']);
  await page.getByRole('button',{name:'Expand all',exact:true}).click();await expect(tree(page).getByRole('treeitem')).toHaveCount(11);
  await item(page,'Data collection').locator('.outline-chevron').click();await expect(item(page,LONG)).toHaveCount(0);
  // Typing a new heading updates the tree in place: the closed node stays closed.
  await page.locator('.cm-content').click();await page.keyboard.press('Control+End');await page.keyboard.insertText('\n\\section{Added while typing}\n');
  await expect(page.locator('.tool-status')).toHaveText('12 headings');await expect(item(page,'Added while typing')).toBeVisible();
  await expect(item(page,'Data collection')).toHaveAttribute('aria-expanded','false');await expect(item(page,'Discussion')).toHaveAttribute('aria-expanded','true');
  await page.getByLabel('Outline scope',{exact:true}).selectOption('file');await expect(page.locator('.tool-status')).toHaveText('6 headings');
  await page.getByLabel('Outline scope',{exact:true}).selectOption('project');await expect(page.locator('.tool-status')).toHaveText('12 headings');
  await expect(page.locator('.save-indicator')).toHaveText('Saved locally');
  await reopen(page,'outline-tree');await showOutline(page,12);
  await expect(item(page,'Data collection')).toHaveAttribute('aria-expanded','false');await expect(item(page,'Methods')).toHaveAttribute('aria-expanded','true');await expect(item(page,LONG)).toHaveCount(0);
  expect(await page.evaluate(()=>Object.keys(localStorage).filter(key=>key.startsWith('scribyra:outline:')).length)).toBe(1);
  expect(errors).toEqual([]);
});

test('the section holding the cursor is highlighted and its ancestors open without closing others',async({page})=>{
  await importProject(page,'outline-cursor',SOURCES);await showOutline(page,11);
  await page.getByRole('button',{name:'Collapse all',exact:true}).click();await item(page,'Discussion').locator('.outline-chevron').click();
  await expect(item(page,'Closing remarks')).toBeVisible();
  // Jump into the included file, then move the cursor to its last heading.
  await item(page,'Discussion').click();await expect(item(page,'Discussion')).toHaveAttribute('aria-current','location');
  await page.getByRole('button',{name:'Files',exact:true}).click();await page.getByRole('treeitem',{name:'chapters/methods.tex',exact:true}).click();
  await page.getByRole('button',{name:'Document outline',exact:true}).click();await expect(item(page,'Methods')).toHaveAttribute('aria-current','location');
  await page.locator('.cm-content').focus();await page.keyboard.press('Control+End');
  await expect(item(page,'Deep')).toHaveAttribute('aria-current','location');await expect(tree(page).locator('[aria-current]')).toHaveCount(1);
  await expect(item(page,'Methods')).toHaveAttribute('aria-expanded','true');await expect(item(page,'Analysis')).toHaveAttribute('aria-expanded','true');
  await expect(item(page,'Data collection')).toHaveAttribute('aria-expanded','false');
  await expect(item(page,'Discussion')).toHaveAttribute('aria-expanded','true');await expect(item(page,'Getting started')).toHaveAttribute('aria-expanded','false');
  await page.keyboard.press('Control+Home');await expect(item(page,'Methods')).toHaveAttribute('aria-current','location');
  await page.keyboard.press('ArrowDown');await page.keyboard.press('ArrowDown');await page.keyboard.press('ArrowDown');
  await expect(item(page,LONG)).toHaveAttribute('aria-current','location');await expect(item(page,'Data collection')).toHaveAttribute('aria-expanded','true');
  await expect(item(page,LONG)).toHaveCSS('background-color',await page.evaluate(()=>{const probe=document.createElement('div');probe.style.color='var(--accent-soft)';document.body.append(probe);const value=getComputedStyle(probe).color;probe.remove();return value;}));
});

test('the outline follows the WAI-ARIA tree keyboard pattern',async({page})=>{
  await importProject(page,'outline-keys',SOURCES);await showOutline(page,11);
  await expect(tree(page).locator('[role=treeitem][tabindex="0"]')).toHaveCount(1);
  await page.getByRole('button',{name:'Collapse all',exact:true}).focus();await page.keyboard.press('Tab');
  const focused=()=>page.evaluate(()=>document.activeElement?.getAttribute('role')==='treeitem'?document.activeElement.textContent:null);
  await expect.poll(focused).not.toBeNull();
  await page.keyboard.press('Home');await expect.poll(focused).toBe('Outline fixture');
  await page.keyboard.press('ArrowDown');await expect.poll(focused).toBe('Getting started');
  await page.keyboard.press('ArrowRight');await expect.poll(focused).toBe('Why outlines matter');
  await page.keyboard.press('ArrowLeft');await expect.poll(focused).toBe('Getting started');
  await page.keyboard.press('ArrowLeft');await expect(item(page,'Getting started')).toHaveAttribute('aria-expanded','false');await expect.poll(focused).toBe('Getting started');
  await page.keyboard.press('ArrowRight');await expect(item(page,'Getting started')).toHaveAttribute('aria-expanded','true');await expect.poll(focused).toBe('Getting started');
  await page.keyboard.press('End');await expect.poll(focused).toBe('Closing remarks');
  await page.keyboard.press('ArrowUp');await expect.poll(focused).toBe('Discussion');
  await page.keyboard.press('s');await expect.poll(focused).toBe(LONG);
  await page.keyboard.press('s');await expect.poll(focused).toBe('Sampling');
  await expect(page.locator('[role=treeitem][tabindex="0"]')).toHaveText('Sampling');
  await page.keyboard.press('ArrowLeft');await expect.poll(focused).toBe('Data collection');
  await page.keyboard.press('ArrowLeft');await expect(item(page,'Data collection')).toHaveAttribute('aria-expanded','false');
  await page.keyboard.press('*');await expect(item(page,'Data collection')).toHaveAttribute('aria-expanded','true');await expect(item(page,'Analysis')).toHaveAttribute('aria-expanded','true');
  await page.keyboard.press('ArrowDown');await page.keyboard.press('ArrowDown');await page.keyboard.press('Enter');
  await expect(page.getByRole('tab',{name:'chapters/methods.tex',exact:true})).toHaveAttribute('aria-selected','true');
  await expect(page.locator('.cm-content')).toBeFocused();await expect(page.locator('.cm-activeLine')).toHaveText('\\subsection{Sampling}');
});

test('long titles are one line with an ellipsis and revealed on hover and focus',async({page})=>{
  await page.setViewportSize({width:1366,height:768});
  await importProject(page,'outline-peek',SOURCES);await showOutline(page,11);
  const row=item(page,LONG),title=row.locator('.outline-title');
  await expect(title).toHaveCSS('text-overflow','ellipsis');await expect(title).toHaveCSS('white-space','nowrap');
  expect(await title.evaluate(node=>node.scrollWidth>node.clientWidth)).toBe(true);
  expect((await row.boundingBox()).height).toBeLessThanOrEqual(27);
  await expect(item(page,'Closing remarks')).toBeVisible(); // \emph and \label are gone
  const peek=page.locator('.outline-peek');
  await row.hover();await expect(peek).toHaveClass(/visible/);await expect(peek.locator('span')).toHaveText(LONG);await expect(peek.locator('small')).toHaveText('chapters/methods.tex:3');
  const [peekBox,chevronBox,titleBox,sidebarBox]=await Promise.all([peek.boundingBox(),row.locator('.outline-chevron').boundingBox(),title.boundingBox(),page.locator('.file-sidebar').boundingBox()]);
  expect(peekBox.x).toBeGreaterThanOrEqual(chevronBox.x+chevronBox.width-0.5);
  expect(Math.abs(peekBox.x+4-titleBox.x)).toBeLessThanOrEqual(1.5);
  expect(peekBox.x+peekBox.width).toBeGreaterThan(sidebarBox.x+sidebarBox.width);
  expect(Math.abs(peekBox.y-(await row.boundingBox()).y)).toBeLessThanOrEqual(1);
  // A title that fits needs no reveal; leaving the tree hides it.
  await item(page,'Deep').hover();await expect(peek).not.toHaveClass(/visible/);
  await page.locator('.cm-content').hover();await expect(peek).not.toHaveClass(/visible/);
  await item(page,'Data collection').focus();await page.keyboard.press('ArrowDown');
  await expect(row).toBeFocused();await expect(peek).toHaveClass(/visible/);await expect(peek.locator('span')).toHaveText(LONG);
  await page.keyboard.press('ArrowDown');await expect(peek).not.toHaveClass(/visible/);
});

test('jumping to a section in another file opens it at the heading',async({page})=>{
  await importProject(page,'outline-jump',SOURCES);await showOutline(page,11);
  await expect(page.getByRole('tab',{name:'main.tex',exact:true})).toHaveAttribute('aria-selected','true');
  await item(page,'Sampling').click();
  await expect(page.getByRole('tab',{name:'chapters/methods.tex',exact:true})).toHaveAttribute('aria-selected','true');
  await expect(page.locator('.cm-activeLine')).toHaveText('\\subsection{Sampling}');await expect(item(page,'Sampling')).toHaveAttribute('aria-current','location');
  await item(page,'Closing remarks').click();await expect(page.getByRole('tab',{name:'main.tex',exact:true})).toHaveAttribute('aria-selected','true');
  await expect(page.locator('.cm-activeLine')).toHaveText('\\section{Closing \\emph{remarks}\\label{sec:closing}}');
});

test('the sidebar resizes by pointer and keyboard, within limits, for every panel, and remembers it',async({page})=>{
  await page.setViewportSize({width:1366,height:768});
  await importProject(page,'outline-resize',SOURCES);
  const handle=page.getByRole('separator',{name:'Resize sidebar',exact:true}),sidebar=page.locator('.file-sidebar');
  const width=async()=>Math.round((await sidebar.boundingBox()).width);
  await expect(handle).toHaveAttribute('aria-valuenow','224');await expect(handle).toHaveAttribute('aria-valuemin','180');await expect(handle).toHaveAttribute('aria-valuemax','560');
  expect(await width()).toBe(224);
  const box=await handle.boundingBox();await page.mouse.move(box.x+box.width/2,box.y+200);await page.mouse.down();await page.mouse.move(box.x+box.width/2+60,box.y+210,{steps:4});await page.mouse.move(box.x+box.width/2+120,box.y+220,{steps:4});await page.mouse.up();
  await expect(handle).toHaveAttribute('aria-valuenow','344');expect(await width()).toBe(344);
  await page.mouse.move(box.x+box.width/2+120,box.y+200);await page.mouse.down();await page.mouse.move(box.x+900,box.y+200,{steps:5});await page.mouse.up();
  await expect(handle).toHaveAttribute('aria-valuenow','560');expect(await width()).toBe(560);
  await page.mouse.move(box.x+560-224+box.width/2,box.y+200);await page.mouse.down();await page.mouse.move(10,box.y+200,{steps:5});await page.mouse.up();
  await expect(handle).toHaveAttribute('aria-valuenow','180');expect(await width()).toBe(180);
  await handle.focus();await page.keyboard.press('ArrowRight');await expect(handle).toHaveAttribute('aria-valuenow','196');
  await page.keyboard.press('Shift+ArrowRight');await expect(handle).toHaveAttribute('aria-valuenow','260');
  await page.keyboard.press('ArrowLeft');await expect(handle).toHaveAttribute('aria-valuenow','244');await expect(handle).toHaveAttribute('aria-valuetext','244 pixels');
  await page.keyboard.press('End');await expect(handle).toHaveAttribute('aria-valuenow','560');
  await page.keyboard.press('Home');await expect(handle).toHaveAttribute('aria-valuenow','180');
  await page.keyboard.press('ArrowRight');await page.keyboard.press('ArrowRight');await page.keyboard.press('ArrowRight');await page.keyboard.press('ArrowRight');await page.keyboard.press('ArrowRight');
  await expect(handle).toHaveAttribute('aria-valuenow','260');
  // Every panel shares the width, and the editor/preview split still works beside it.
  for(const panel of ['Search project','Document outline','Files']){await page.getByRole('button',{name:panel,exact:true}).click();expect(await width()).toBe(260);}
  const split=page.getByRole('separator',{name:'Resize editor and preview',exact:true});await split.focus();const before=Number(await split.getAttribute('aria-valuenow'));await page.keyboard.press('ArrowRight');await expect(split).toHaveAttribute('aria-valuenow',String(before+2));
  await expect(page.locator('.save-indicator')).toHaveText('Saved locally');
  await reopen(page,'outline-resize');await expect(handle).toHaveAttribute('aria-valuenow','260');expect(await width()).toBe(260);
  await handle.dblclick();await expect(handle).toHaveAttribute('aria-valuenow','224');expect(await width()).toBe(224);
  expect(await page.evaluate(()=>localStorage.getItem('scribyra:sidebar-width'))).toBeNull();
  // A smaller window lowers the ceiling; phones keep their fixed sidebar and no handle.
  await handle.focus();await page.keyboard.press('End');await expect(handle).toHaveAttribute('aria-valuenow','560');
  await page.setViewportSize({width:900,height:700});await expect(handle).toHaveAttribute('aria-valuenow','405');await expect(handle).toHaveAttribute('aria-valuemax','405');
  await page.setViewportSize({width:390,height:760});await expect(handle).toBeHidden();expect(await width()).toBe(170);
  await page.setViewportSize({width:1366,height:768});await expect(handle).toHaveAttribute('aria-valuenow','560');
});

test('the thesis outline stays within the typing budget',async({page},testInfo)=>{
  const files=thesis({images:false}).files;
  await importProject(page,'outline-thesis',files);
  const opened=Date.now();await page.getByRole('button',{name:'Document outline',exact:true}).click();
  await expect(page.locator('.tool-status')).toHaveText('122 headings');const firstRead=Date.now()-opened;
  const rendered=()=>tree(page).getByRole('treeitem').count();
  await page.getByRole('button',{name:'Collapse all',exact:true}).click();await expect(item(page,'Results')).toHaveAttribute('aria-expanded','false');
  await page.getByRole('button',{name:'Expand all',exact:true}).click();await expect(item(page,'Introduction')).toHaveAttribute('aria-expanded','true');await expect(item(page,'Results')).toHaveCount(0);
  // Only the rows in view (plus a margin) are in the DOM.
  expect(await rendered()).toBeLessThan(70);
  const scroller=page.locator('#outline-tree');await scroller.evaluate(node=>{node.scrollTop=node.scrollHeight;});
  await expect(item(page,'Further reading')).toBeVisible();
  await scroller.evaluate(node=>{node.scrollTop=0;});await item(page,'Introduction').click();
  await expect(page.getByRole('tab',{name:'chapters/01-introduction/chapter.tex',exact:true})).toHaveAttribute('aria-selected','true');
  await page.evaluate(()=>performance.clearMeasures());
  // Word-sized bursts with pauses, as in docs/large-projects.md, so debounced updates run.
  await page.keyboard.press('End');
  for(let burst=0;burst<6;burst++){await page.keyboard.type(' outline',{delay:40});await page.waitForTimeout(260);}
  // WebKit drops text after a newline in one insertText, so the line break is its own key.
  await page.keyboard.press('Enter');await page.keyboard.insertText('\\section{Typed heading}');
  await expect(page.locator('.tool-status')).toHaveText('123 headings');await expect(item(page,'Typed heading')).toHaveAttribute('aria-current','location');
  for(let i=0;i<6;i++){await page.getByRole('button',{name:i%2?'Expand all':'Collapse all',exact:true}).click();}
  await item(page,'Introduction').locator('.outline-chevron').click();await item(page,'Introduction').locator('.outline-chevron').click();
  const measures=await page.evaluate(()=>Object.fromEntries(['scribyra:outline-update','scribyra:outline-toggle','scribyra:outline-assemble','scribyra:outline-render'].map(name=>[name,performance.getEntriesByName(name).map(entry=>entry.duration)])));
  const stats=list=>{const sorted=[...list].sort((a,b)=>a-b);return {count:list.length,median:+sorted[Math.floor(sorted.length/2)].toFixed(2),max:+sorted.at(-1).toFixed(2)};};
  const update=stats(measures['scribyra:outline-update']),toggle=stats(measures['scribyra:outline-toggle']);
  const report={browser:testInfo.project.name,firstReadMs:firstRead,update,toggle,assemble:stats(measures['scribyra:outline-assemble']),render:stats(measures['scribyra:outline-render'])};
  testInfo.annotations.push({type:'outline-performance',description:JSON.stringify(report)});console.log(JSON.stringify(report));
  expect(update.count).toBeGreaterThanOrEqual(5);
  // One keystroke's outline work, re-reading the edited chapter and repainting, fits well inside a frame budget.
  expect(update.median).toBeLessThan(16);expect(update.max).toBeLessThan(50);
  expect(toggle.count).toBe(8);expect(toggle.max).toBeLessThan(50);
});
