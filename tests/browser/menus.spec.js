import {test,expect} from '@playwright/test';
const sample=async page=>{await page.goto('/');await page.getByRole('button',{name:'Start with a sample paper'}).click();await expect(page.locator('.cm-content')).toBeVisible();};
const theme=(page,value)=>page.evaluate(v=>{document.documentElement.dataset.theme=v;},value);
const look=node=>node.evaluate(el=>{const s=getComputedStyle(el);return {background:s.backgroundColor,color:s.color,border:s.borderTopColor,radius:s.borderTopLeftRadius,shadow:s.boxShadow,position:s.position};});
const surface=page=>page.evaluate(()=>{const probe=document.createElement('div');probe.style.cssText='background:var(--surface);color:var(--text)';document.body.append(probe);const s=getComputedStyle(probe),r={background:s.backgroundColor,color:s.color};probe.remove();return r;});
const addFolder=async(page,path)=>{await page.getByRole('button',{name:'Add folder',exact:true}).click();await page.getByRole('textbox',{name:'New folder',exact:true}).fill(path);await page.keyboard.press('Enter');await expect(page.getByRole('treeitem',{name:path,exact:true})).toBeVisible();await page.evaluate(()=>window.scribyra.action('select-root'));};
const inViewport=async(page,node)=>{const box=await node.boundingBox(),size=page.viewportSize();expect(box.x).toBeGreaterThanOrEqual(0);expect(box.y).toBeGreaterThanOrEqual(0);expect(box.x+box.width).toBeLessThanOrEqual(size.width);expect(box.y+box.height).toBeLessThanOrEqual(size.height);};

test('select popups follow the theme and the select stays the real control',async({page})=>{
  await sample(page);const mode=page.getByRole('combobox',{name:'Editor mode',exact:true});
  for(const value of ['light','dark']){
    await theme(page,value);await mode.click();
    const list=page.getByRole('listbox',{name:'Editor mode',exact:true});await expect(list).toBeVisible();
    const expected=await surface(page),seen=await look(list);expect(seen.background).toBe(expected.background);expect(seen.color).toBe(expected.color);
    await expect(mode).toHaveAttribute('aria-expanded','true');
    await expect(list.getByRole('option')).toHaveCount(3);await expect(list.locator('[role=option] svg.ui-icon:not(.ui-item-check)')).toHaveCount(3);
    await expect(list.getByRole('option',{name:/Editing/})).toHaveAttribute('aria-selected','true');
    await page.keyboard.press('Escape');await expect(list).toHaveCount(0);await expect(mode).toBeFocused();await expect(mode).not.toHaveAttribute('aria-expanded','true');
  }
  await mode.click();await page.getByRole('listbox',{name:'Editor mode',exact:true}).getByRole('option',{name:/Reviewing/}).click();await expect(mode).toHaveValue('reviewing');await expect(mode).toBeFocused();await expect(page.locator('.review-mode-hint')).toContainText('suggestions');
  await mode.selectOption('editing');await expect(page.locator('.review-mode-hint')).toContainText('directly');
  await expect(mode.locator('option')).toHaveCount(3);
});
test('select keyboard: arrows, Home, End, typeahead, Enter, Escape and Tab',async({page})=>{
  await sample(page);const mode=page.getByRole('combobox',{name:'Editor mode',exact:true}),list=page.getByRole('listbox',{name:'Editor mode',exact:true}),option=name=>list.getByRole('option',{name});
  await mode.focus();await page.keyboard.press('ArrowDown');await expect(list).toBeVisible();await expect(option(/Editing/)).toBeFocused();await expect(mode).toHaveValue('editing');
  await page.keyboard.press('ArrowDown');await expect(option(/Reviewing/)).toBeFocused();await page.keyboard.press('End');await expect(option(/Viewing/)).toBeFocused();await page.keyboard.press('ArrowDown');await expect(option(/Editing/)).toBeFocused();await page.keyboard.press('ArrowUp');await expect(option(/Viewing/)).toBeFocused();await page.keyboard.press('Home');await expect(option(/Editing/)).toBeFocused();
  await page.keyboard.type('re');await expect(option(/Reviewing/)).toBeFocused();await page.keyboard.press('Escape');await expect(list).toHaveCount(0);await expect(mode).toHaveValue('editing');await expect(mode).toBeFocused();
  await page.waitForTimeout(700);
  await page.keyboard.press('v');await expect(option(/Viewing/)).toBeFocused();await expect(mode).toHaveValue('editing');await page.keyboard.press('Enter');await expect(list).toHaveCount(0);await expect(mode).toHaveValue('viewing');await expect(mode).toBeFocused();
  // Tab keeps the highlighted choice and moves on, as a native select does.
  await page.keyboard.press(' ');await expect(list).toBeVisible();await page.keyboard.press('Home');await page.keyboard.press('Tab');await expect(list).toHaveCount(0);await expect(mode).toHaveValue('editing');await expect(mode).not.toBeFocused();
  // Modified keys stay with the browser and shortcuts.
  await mode.focus();await page.keyboard.press('Control+a');await expect(list).toHaveCount(0);
});
test('outside press closes a popup, and no panel or viewport edge clips one',async({page})=>{
  await sample(page);await page.setViewportSize({width:1000,height:420});
  await page.getByRole('button',{name:'Review',exact:true}).click();const filter=page.getByRole('combobox',{name:'Review status filter',exact:true});await filter.click();const list=page.getByRole('listbox',{name:'Review status filter',exact:true});await expect(list).toBeVisible();await inViewport(page,list);
  await page.locator('.preview-pane').click({position:{x:30,y:200}});await expect(list).toHaveCount(0);
  const actions=page.getByRole('button',{name:'Review actions',exact:true});await actions.click();const panel=page.locator('.review-header .review-menu-items');await expect(panel).toBeVisible();await inViewport(page,panel);
  const hit=await panel.evaluate(el=>{const box=el.getBoundingClientRect();return el.contains(document.elementFromPoint(box.left+box.width/2,box.bottom-6));});expect(hit).toBe(true);
  await page.locator('.preview-pane').click({position:{x:30,y:200}});await expect(panel).toBeHidden();
  // A long list near the bottom scrolls inside its popup and stays on screen.
  await page.setViewportSize({width:1000,height:300});await page.getByRole('button',{name:'More tools',exact:true}).click();await page.getByRole('button',{name:'Project settings',exact:true}).click();
  const font=page.getByRole('combobox',{name:'Font size',exact:true});await font.scrollIntoViewIfNeeded();await font.click();const sizes=page.getByRole('listbox',{name:'Font size',exact:true});await expect(sizes).toBeVisible();await inViewport(page,sizes);
  await page.keyboard.press('End');await expect(sizes.getByRole('option',{name:'24 px'})).toBeInViewport();
});
test('selects inside modal dialogs work, and Escape closes the popup before the dialog',async({page})=>{
  await sample(page);await page.getByRole('button',{name:'More tools',exact:true}).click();await page.getByRole('button',{name:'Project settings',exact:true}).click();const dialog=page.getByRole('dialog',{name:'Project settings',exact:true}),font=dialog.getByRole('combobox',{name:'Font size',exact:true});
  await font.click();const list=dialog.getByRole('listbox',{name:'Font size',exact:true});await expect(list).toBeVisible();await list.getByRole('option',{name:'18 px'}).click();await expect(font).toHaveValue('18');await expect(dialog).toBeVisible();
  await font.click();await expect(list).toBeVisible();await page.keyboard.press('Escape');await expect(list).toHaveCount(0);await expect(dialog).toBeVisible();await expect(font).toBeFocused();
  await dialog.getByRole('button',{name:'Save settings',exact:true}).click();await expect(dialog).toHaveCount(0);await expect(page.locator('#code-editor')).toHaveAttribute('style',/18px/);
});
test('file actions open as a menu from right click, the row button and the keyboard',async({page})=>{
  await sample(page);await addFolder(page,'chapters');await page.waitForTimeout(100);
  const main=page.getByRole('treeitem',{name:'main.tex',exact:true}),menu=page.getByRole('menu',{name:'File actions',exact:true}),rows=['Rename','Move','Duplicate','Delete'];
  await main.click({button:'right',position:{x:30,y:12}});await expect(menu).toBeVisible();for(const label of rows)await expect(menu.getByRole('menuitem',{name:label,exact:true})).toBeVisible();
  const from=await main.boundingBox(),at=await menu.boundingBox();expect(Math.abs(at.x-(from.x+30))).toBeLessThan(4);await inViewport(page,menu);
  await expect(page.locator('dialog:modal')).toHaveCount(0);const size=await menu.boundingBox();expect(size.width).toBeLessThan(300);expect(size.height).toBeLessThan(300);
  await page.keyboard.press('Escape');await expect(menu).toHaveCount(0);await expect(main).toBeFocused();
  // The row button anchors the same menu.
  const button=main.locator('..').getByRole('button',{name:'File actions',exact:true});await main.hover();await button.click();await expect(menu).toBeVisible();await expect(button).toHaveAttribute('aria-expanded','true');
  const anchor=await button.boundingBox(),placed=await menu.boundingBox();expect(placed.y).toBeGreaterThanOrEqual(anchor.y+anchor.height-1);await page.keyboard.press('Escape');await expect(button).toHaveAttribute('aria-expanded','false');
  // Keyboard: the ContextMenu key and Shift+F10, then roving focus and typeahead.
  await main.focus();await page.keyboard.press('ContextMenu');await expect(menu).toBeVisible();await expect(menu.getByRole('menuitem',{name:'Rename',exact:true})).toBeFocused();await page.keyboard.press('Escape');await expect(main).toBeFocused();
  await page.keyboard.press('Shift+F10');await expect(menu).toBeVisible();await page.keyboard.press('ArrowDown');await expect(menu.getByRole('menuitem',{name:'Move',exact:true})).toBeFocused();await page.keyboard.press('End');await expect(menu.getByRole('menuitem',{name:'Delete',exact:true})).toBeFocused();await page.keyboard.press('Home');await expect(menu.getByRole('menuitem',{name:'Rename',exact:true})).toBeFocused();await page.keyboard.type('du');await expect(menu.getByRole('menuitem',{name:'Duplicate',exact:true})).toBeFocused();
  await page.keyboard.press('Enter');const copy=page.getByRole('dialog',{name:'Duplicate file',exact:true});await expect(copy).toBeVisible();await expect(page.locator('dialog:modal')).toHaveCount(0);await page.keyboard.press('Enter');await expect(page.getByRole('treeitem',{name:'main copy.tex',exact:true})).toBeVisible();
  // Folders and the empty tree add creation.
  const folder=page.getByRole('menu',{name:'Folder actions',exact:true});await page.getByRole('treeitem',{name:'chapters',exact:true}).click({button:'right'});for(const label of ['New file','New folder','Upload files',...rows])await expect(folder.getByRole('menuitem',{name:label,exact:true})).toBeVisible();
  await folder.getByRole('menuitem',{name:'New file',exact:true}).click();const name=page.getByRole('textbox',{name:'New file',exact:true});await expect(name).toHaveValue('chapters/chapter.tex');await name.fill('chapters/one.tex');await page.getByRole('button',{name:'Create file',exact:true}).click();await expect(page.getByRole('treeitem',{name:'chapters/one.tex',exact:true})).toBeVisible();
  const empty=page.getByRole('menu',{name:'Project files',exact:true}),list=page.locator('.file-list'),box=await list.boundingBox();await list.click({button:'right',position:{x:30,y:box.height-6}});await expect(empty).toBeVisible();for(const label of ['New file','New folder','Upload files','Import folder'])await expect(empty.getByRole('menuitem',{name:label,exact:true})).toBeVisible();
  const chooser=page.waitForEvent('filechooser');await empty.getByRole('menuitem',{name:'Upload files',exact:true}).click();await(await chooser).setFiles({name:'uploaded.tex',mimeType:'text/plain',buffer:Buffer.from('x')});await expect(page.getByRole('treeitem',{name:'uploaded.tex',exact:true})).toBeVisible();
});
test('rename edits inline: Enter commits, Escape cancels, focus moving away commits',async({page})=>{
  await sample(page);await addFolder(page,'chapters');const main=page.getByRole('treeitem',{name:'main.tex',exact:true});
  await main.focus();await page.keyboard.press('F2');const input=page.getByRole('textbox',{name:'Rename file',exact:true});await expect(input).toBeFocused();await expect(input).toHaveValue('main.tex');await expect(page.locator('dialog:modal')).toHaveCount(0);
  const row=await main.locator('..').boundingBox(),box=await input.boundingBox();expect(box.y).toBeGreaterThanOrEqual(row.y);expect(box.y+box.height).toBeLessThanOrEqual(row.y+row.height);
  expect(await input.evaluate(el=>el.value.slice(el.selectionStart,el.selectionEnd))).toBe('main');
  await page.keyboard.press('Escape');await expect(input).toHaveCount(0);await expect(main).toBeFocused();
  await page.keyboard.press('F2');await input.fill('paper.tex');await page.keyboard.press('Enter');const paper=page.getByRole('treeitem',{name:'paper.tex',exact:true});await expect(paper).toBeFocused();
  await paper.click({button:'right'});await page.getByRole('menuitem',{name:'Rename',exact:true}).click();await input.fill('final.tex');await page.locator('.preview-pane').click({position:{x:30,y:200}});await expect(page.getByRole('treeitem',{name:'final.tex',exact:true})).toBeVisible();
  // A bare name stays in its folder; a path with a slash is a full project path.
  const final=page.getByRole('treeitem',{name:'final.tex',exact:true});await final.focus();await page.keyboard.press('F2');await input.fill('chapters/final.tex');await page.keyboard.press('Enter');const nested=page.getByRole('treeitem',{name:'chapters/final.tex',exact:true});await expect(nested).toBeFocused();
  await page.keyboard.press('F2');await input.fill('renamed.tex');await page.keyboard.press('Enter');await expect(page.getByRole('treeitem',{name:'chapters/renamed.tex',exact:true})).toBeVisible();
});
test('move uses a small popover whose long folder list stays usable, and delete confirms small',async({page})=>{
  await sample(page);for(let i=0;i<14;i++)await addFolder(page,`part-${String(i).padStart(2,'0')}`);
  const main=page.getByRole('treeitem',{name:'main.tex',exact:true});await main.focus();await page.keyboard.press('ContextMenu');await page.getByRole('menuitem',{name:'Move',exact:true}).click();
  const dialog=page.getByRole('dialog',{name:'Move file',exact:true}),input=dialog.getByRole('textbox',{name:'Move file',exact:true}),folders=dialog.getByRole('listbox',{name:'Destination folders',exact:true});await expect(input).toBeFocused();await expect(page.locator('dialog:modal')).toHaveCount(0);
  const box=await dialog.boundingBox();expect(box.width).toBeLessThanOrEqual(340);expect(box.height).toBeLessThan(420);await inViewport(page,dialog);await expect(folders.getByRole('option')).toHaveCount(15);
  expect(await folders.evaluate(el=>el.scrollHeight>el.clientHeight)).toBe(true);
  await input.fill('part-1');await expect(folders.getByRole('option',{name:'part-13',exact:true})).toBeVisible();await expect(folders.getByRole('option',{name:'part-02',exact:true})).toBeHidden();
  await page.keyboard.press('ArrowDown');await expect(folders.getByRole('option',{name:'part-10',exact:true})).toBeFocused();await page.keyboard.press('ArrowDown');await page.keyboard.press('Enter');await expect(input).toBeFocused();await expect(input).toHaveValue('part-11/main.tex');
  await page.getByRole('button',{name:'Move',exact:true}).click();await expect(page.getByRole('treeitem',{name:'part-11/main.tex',exact:true})).toBeVisible();await expect(dialog).toHaveCount(0);
  // Outside press dismisses without changing anything.
  const moved=page.getByRole('treeitem',{name:'part-11/main.tex',exact:true});await moved.click({button:'right'});await page.getByRole('menuitem',{name:'Move',exact:true}).click();await expect(dialog).toBeVisible();await page.locator('.preview-pane').click({position:{x:30,y:200}});await expect(dialog).toHaveCount(0);await expect(moved).toBeVisible();
  const folder=page.getByRole('treeitem',{name:'part-00',exact:true});await folder.click({button:'right'});await page.getByRole('menuitem',{name:'Delete',exact:true}).click();const confirm=page.getByRole('dialog',{name:'Delete folder',exact:true});await expect(confirm).toContainText('everything inside it');await expect(page.locator('dialog:modal')).toHaveCount(0);const small=await confirm.boundingBox();expect(small.width).toBeLessThanOrEqual(340);
  await confirm.getByRole('button',{name:'Delete folder',exact:true}).click();await expect(folder).toHaveCount(0);await page.getByRole('button',{name:'Restore last deletion',exact:true}).click();await expect(folder).toBeVisible();
});
test('Viewing shows mutating actions disabled with a reason, and activating one does nothing',async({page})=>{
  await sample(page);await page.getByRole('combobox',{name:'Editor mode',exact:true}).selectOption('viewing');const main=page.getByRole('treeitem',{name:'main.tex',exact:true});
  await main.click({button:'right'});const menu=page.getByRole('menu',{name:'File actions',exact:true});await expect(menu).toContainText('Switch to Editing');
  const rename=menu.getByRole('menuitem',{name:'Rename',exact:true});await expect(rename).toHaveAttribute('aria-disabled','true');await expect(rename).toHaveAttribute('title',/Switch to Editing/);
  await page.keyboard.press('Enter');await expect(menu).toBeVisible();await expect(page.getByRole('textbox',{name:'Rename file',exact:true})).toHaveCount(0);await rename.click({force:true});await expect(menu).toBeVisible();await page.keyboard.press('Escape');
  await main.focus();await page.keyboard.press('F2');await expect(page.getByRole('status',{name:'Workspace notification',exact:true})).toContainText('Switch to Editing');await expect(page.getByRole('textbox',{name:'Rename file',exact:true})).toHaveCount(0);
  await page.getByRole('combobox',{name:'Editor mode',exact:true}).selectOption('reviewing');await main.click({button:'right'});await expect(menu.getByRole('menuitem',{name:'Delete',exact:true})).toHaveAttribute('aria-disabled','true');await expect(menu).toContainText('Switch to Editing');await page.keyboard.press('Escape');
  await page.getByRole('combobox',{name:'Editor mode',exact:true}).selectOption('editing');await main.click({button:'right'});await expect(menu.getByRole('menuitem',{name:'Delete',exact:true})).not.toHaveAttribute('aria-disabled','true');
});
test('touch: a long press opens the menu without opening the row, and a short press does not',async({page})=>{
  await sample(page);const folder='notes';await addFolder(page,folder);const row=page.getByRole('treeitem',{name:folder,exact:true}),menu=page.getByRole('menu',{name:'Folder actions',exact:true});
  const press=(type,x=20,y=10)=>row.evaluate((el,{type,x,y})=>{const box=el.getBoundingClientRect();el.dispatchEvent(new PointerEvent(type,{bubbles:true,pointerType:'touch',clientX:box.left+x,clientY:box.top+y}));},{type,x,y});
  await press('pointerdown');await page.waitForTimeout(120);await press('pointerup');await page.waitForTimeout(600);await expect(menu).toHaveCount(0);
  await press('pointerdown');await page.waitForTimeout(40);await press('pointermove',60,10);await page.waitForTimeout(600);await expect(menu).toHaveCount(0);await press('pointerup');
  await press('pointerdown');await expect(menu).toBeVisible();await press('pointerup');
  const expanded=await row.getAttribute('aria-expanded');await row.evaluate(el=>el.click());await expect(row).toHaveAttribute('aria-expanded',expanded);await expect(menu).toBeVisible();await page.keyboard.press('Escape');
});
test('every popup shares one look and keyboard behaviour',async({page})=>{
  await sample(page);const shared=async node=>{const {background,radius,shadow,position,border}=await look(node);return {background,radius,shadow,position,border};};
  const main=page.getByRole('treeitem',{name:'main.tex',exact:true});await main.click({button:'right'});const reference=await shared(page.getByRole('menu',{name:'File actions',exact:true}));expect(reference.position).toBe('fixed');await page.keyboard.press('Escape');
  await page.getByRole('combobox',{name:'Main document',exact:true}).click();expect(await shared(page.getByRole('listbox',{name:'Main document',exact:true}))).toEqual(reference);await page.keyboard.press('Escape');
  const caret=page.getByRole('button',{name:'Compile options',exact:true});await caret.click();const options=page.getByRole('group',{name:'Compile options',exact:true});expect(await shared(options)).toEqual(reference);await expect(page.getByRole('checkbox',{name:'Auto',exact:true})).toBeFocused();await page.keyboard.press('ArrowDown');await expect(page.getByRole('checkbox',{name:'Preview with suggestions',exact:true})).toBeFocused();await page.keyboard.press('Home');await page.keyboard.press(' ');await expect(page.getByRole('checkbox',{name:'Auto',exact:true})).toBeChecked();await expect(options).toBeVisible();await page.keyboard.press(' ');await expect(page.getByRole('checkbox',{name:'Auto',exact:true})).not.toBeChecked();await page.keyboard.press('Escape');await expect(options).toBeHidden();await expect(caret).toBeFocused();
  await page.getByRole('button',{name:'Review',exact:true}).click();const actions=page.getByRole('button',{name:'Review actions',exact:true});await actions.click();const panel=page.locator('.review-header .review-menu-items');expect(await shared(panel)).toEqual(reference);await expect(actions).toHaveAttribute('aria-expanded','true');await page.keyboard.press('End');await expect(panel.getByRole('button',{name:'Review tools',exact:true})).toBeFocused();await page.keyboard.press('Escape');await expect(panel).toBeHidden();await expect(actions).toBeFocused();await expect(actions).toHaveAttribute('aria-expanded','false');
  await page.getByRole('button',{name:'Review',exact:true}).click();
  await page.locator('[aria-controls="project-history"]').click();const manage=page.getByRole('button',{name:'Manage history',exact:true});await manage.click();const history=page.getByRole('group',{name:'Manage history',exact:true});await expect(history).toBeVisible();expect(await shared(history)).toEqual(reference);await expect(history.getByRole('button',{name:'Export complete backup',exact:true})).toBeFocused();await page.keyboard.press('ArrowDown');await expect(history.getByRole('button',{name:'Import complete backup',exact:true})).toBeFocused();await page.keyboard.press('Escape');await expect(history).toHaveCount(0);await expect(manage).toBeFocused();await expect(page.locator('#project-history')).toBeVisible();
  await page.getByRole('button',{name:'Manage history',exact:true}).click();await expect(history).toBeVisible();await page.locator('.history-column-head h2').click();await expect(history).toHaveCount(0);await page.keyboard.press('Escape');
  await page.getByRole('button',{name:'All projects',exact:true}).click();const project=page.getByRole('button',{name:'Project actions',exact:true}).first();await project.click();const menu=page.getByRole('menu',{name:'Project actions',exact:true});expect(await shared(menu)).toEqual(reference);await page.keyboard.press('End');await page.keyboard.press('Enter');const confirm=page.getByRole('dialog',{name:'Delete project',exact:true});await expect(confirm).toContainText('cannot be undone');await page.keyboard.press('Escape');await expect(confirm).toHaveCount(0);await expect(project).toBeFocused();
});
test('tapping a select opens the themed listbox, not the system picker',async({browser,baseURL})=>{
  const context=await browser.newContext({hasTouch:true,baseURL,viewport:{width:1024,height:700}});const page=await context.newPage();
  try{await sample(page);const mode=page.getByRole('combobox',{name:'Editor mode',exact:true});await mode.tap();const list=page.getByRole('listbox',{name:'Editor mode',exact:true});await expect(list).toBeVisible();await list.getByRole('option',{name:/Viewing/}).tap();await expect(mode).toHaveValue('viewing');await expect(list).toHaveCount(0);}finally{await context.close();}
});

test('stale mode popup cannot undo Viewing through Tab, Enter or a retained click',async({page})=>{
 await sample(page);const mode=page.getByRole('combobox',{name:'Editor mode',exact:true}),list=page.getByRole('listbox',{name:'Editor mode',exact:true});
 for(const key of ['Tab','Enter','click']){
  await mode.selectOption('editing');await mode.click();await expect(list).toBeVisible();
  await page.evaluate(key=>{
   const select=document.querySelector('[aria-label="Editor mode"]'),option=document.querySelector('[role=listbox] [role=option]');
   // Commit in the same task, before mutation observers or the next frame run.
   window.scribyra.action('review-mode','viewing');
   if(key==='click')option.click();else option.dispatchEvent(new KeyboardEvent('keydown',{key,bubbles:true}));
  },key);
  await expect(list).toHaveCount(0);await expect(mode).toHaveValue('viewing');
  const unchanged=await page.evaluate(()=>{const view=document.querySelector('.cm-content').cmTile.root.view,before=view.state.doc.toString();view.dispatch({changes:{from:0,insert:'UNSAFE'}});return view.state.doc.toString()===before;});expect(unchanged).toBe(true);
 }
});
test('select popup closes on property-only value and enabled-state changes',async({page})=>{
 await sample(page);const mode=page.getByRole('combobox',{name:'Editor mode',exact:true}),list=page.getByRole('listbox',{name:'Editor mode',exact:true});
 await mode.click();await mode.evaluate(select=>{select.value='viewing';});await expect(list).toHaveCount(0);
 await mode.click();await expect(list.getByRole('option',{name:/Viewing/})).toHaveAttribute('aria-selected','true');await mode.evaluate(select=>{select.disabled=true;});await expect(list).toHaveCount(0);await expect(mode).toHaveValue('viewing');
});
test('peer rename invalidates every action in an open file menu',async({page,context})=>{
 await sample(page);await expect(page.locator('.save-indicator')).toHaveText('Saved locally');
 const peer=await context.newPage();
 try{
  await peer.goto('/');await peer.locator('.card-open').first().click();await expect(peer.locator('.cm-content')).toBeVisible();
  let path='main.tex';
  for(const choice of ['Rename','Move','Duplicate','Delete']){
   await page.getByRole('treeitem',{name:path,exact:true}).click({button:'right'});const menu=page.getByRole('menu',{name:'File actions',exact:true});await expect(menu).toBeVisible();const retained=await menu.getByRole('menuitem',{name:choice,exact:true}).elementHandle();
   await peer.getByRole('treeitem',{name:path,exact:true}).focus();await peer.keyboard.press('F2');path='important-'+choice.toLowerCase()+'.tex';await peer.getByRole('textbox',{name:'Rename file',exact:true}).fill(path);await peer.keyboard.press('Enter');
   await expect(page.getByRole('treeitem',{name:path,exact:true})).toBeVisible();await expect(menu).toHaveCount(0);await retained.evaluate(item=>item.click());await retained.dispose();
   await expect(page.getByRole('treeitem',{name:path,exact:true})).toBeVisible();await expect(page.locator('.ui-prompt')).toHaveCount(0);await expect(page.locator('.tree-rename')).toHaveCount(0);
  }
 }finally{await peer.close();}
});

test('file actions reject a same-task change to their file before opening or deleting',async({page})=>{
 await sample(page);
 for(const choice of ['Rename','Move','Duplicate','Delete']){
  await page.getByRole('treeitem',{name:'main.tex',exact:true}).click({button:'right'});
  // Deleting the file in the same task as the click: what the menu offered no longer applies.
  await page.getByRole('menuitem',{name:choice,exact:true}).evaluate(item=>{
   const id=window.scribyra.agent.readTree().value.items.find(entry=>entry.path==='main.tex').id;window.scribyra.action('delete-node',id);item.click();
  });
  await expect(page.getByRole('menu',{name:'File actions',exact:true})).toHaveCount(0);await expect(page.getByRole('status',{name:'Workspace notification',exact:true})).toContainText('project changed');await expect(page.locator('.tree-rename,.ui-prompt')).toHaveCount(0);
  await expect(page.getByRole('treeitem',{name:'main.tex',exact:true})).toHaveCount(0);await page.getByRole('button',{name:'Restore last deletion',exact:true}).click();await expect(page.getByRole('treeitem',{name:'main.tex',exact:true})).toBeVisible();
 }
 // A same-task edit of the file's text leaves the menu's action usable: its name and place are unchanged.
 await page.getByRole('treeitem',{name:'main.tex',exact:true}).click({button:'right'});
 await page.getByRole('menuitem',{name:'Rename',exact:true}).evaluate(item=>{
  const api=window.scribyra.agent,result=api.patchSource({expectedRevision:api.status().revision,edits:[{path:'main.tex',start:0,end:0,before:'',after:'% Changed\n'}]});if(!result.ok)throw Error(JSON.stringify(result));item.click();
 });
 const field=page.getByRole('textbox',{name:'Rename file',exact:true});await expect(field).toHaveValue('main.tex');await field.press('Escape');await expect(page.getByRole('treeitem',{name:'main.tex',exact:true})).toBeVisible();
});

test('the top bar stays calm and More tools keeps every tool reachable by keyboard',async({page})=>{
 await page.setViewportSize({width:1366,height:768});await page.goto('/');await page.getByRole('button',{name:'Start with a sample paper'}).click();await expect(page.locator('.cm-content')).toBeVisible();
 const header=page.locator('.editor-header'),toggle=page.getByRole('button',{name:'More tools',exact:true}),tools=['Project settings','TeX environment','Diagnostics','MCP providers','Report a problem'];
 expect((await header.getByRole('button').filter({visible:true}).evaluateAll(nodes=>nodes.map(n=>n.getAttribute('aria-label')||n.textContent.trim()))).slice(1)).toEqual(['A space for your next great idea','History','Export','Toggle theme','More tools']);
 for(const name of tools)await expect(page.getByRole('button',{name,exact:true})).toHaveCount(0);
 await toggle.focus();await page.keyboard.press('Enter');await expect(toggle).toHaveAttribute('aria-expanded','true');
 for(const name of tools)await expect(page.getByRole('button',{name,exact:true})).toBeVisible();
 await expect(page.getByRole('button',{name:'Rust companion and MCP',exact:true})).toHaveCount(0);
 await expect(page.getByRole('button',{name:'Project settings',exact:true})).toBeFocused();await page.keyboard.press('ArrowDown');await expect(page.getByRole('button',{name:'TeX environment',exact:true})).toBeFocused();
 await page.keyboard.press('End');await expect(page.getByRole('link',{name:'Source code on GitHub',exact:true})).toBeFocused();await page.keyboard.press('ArrowUp');await expect(page.getByRole('link',{name:'Licences',exact:true})).toBeFocused();await expect(page.getByRole('link',{name:'Privacy',exact:true})).toHaveAttribute('href','https://scribyra.com/privacy.html');
 await page.keyboard.press('Escape');await expect(toggle).toBeFocused();await expect(toggle).toHaveAttribute('aria-expanded','false');
 await toggle.click();await page.getByRole('button',{name:'Project settings',exact:true}).click();const settings=page.getByRole('dialog',{name:'Project settings',exact:true});await expect(settings.getByRole('link',{name:'Privacy',exact:true})).toBeVisible();await expect(settings.getByRole('link',{name:'Licences',exact:true})).toBeVisible();await page.keyboard.press('Escape');await expect(toggle).toBeFocused();
});

test('the dashboard and More tools link to the source on GitHub in a new tab',async({page})=>{
 await page.setViewportSize({width:1366,height:768});await page.goto('/');
 async function check(link){
  await expect(link).toBeVisible();await expect(link).toHaveAttribute('href','https://github.com/Scribyra/scribyra');await expect(link).toHaveAttribute('target','_blank');await expect(link).toHaveAttribute('rel','noopener');
  // The mark is inline SVG: no image, font or third-party request.
  await expect(link.locator('svg[aria-hidden="true"] path')).toHaveCount(1);await expect(link.locator('img')).toHaveCount(0);
 }
 const sidebar=page.locator('.dashboard-sidebar');await check(sidebar.getByRole('link',{name:'Source code on GitHub',exact:true}));
 await expect(sidebar.getByRole('button',{name:'Report a problem',exact:true})).toBeVisible();
 await page.getByRole('button',{name:'Start with a sample paper'}).click();await expect(page.locator('.cm-content')).toBeVisible();
 const toggle=page.getByRole('button',{name:'More tools',exact:true}),menu=page.getByRole('group',{name:'More tools',exact:true});
 await expect(menu.getByRole('link',{name:'Source code on GitHub',exact:true})).toBeHidden();
 await toggle.click();await check(menu.getByRole('link',{name:'Source code on GitHub',exact:true}));
 expect(await menu.getByRole('link').evaluateAll(links=>links.map(link=>link.textContent.trim()))).toEqual(['Privacy','Licences','Source code on GitHub']);
});

test('reporting a problem sends nothing and says what a report holds',async({page})=>{
 const requests=[];await page.goto('/');page.on('request',request=>requests.push(request.url()));
 await page.getByRole('button',{name:'Report a problem',exact:true}).click();const dialog=page.getByRole('dialog',{name:'Report a problem',exact:true});
 await expect(dialog).toContainText('voluntary');await expect(dialog).toContainText('contact@scribyra.com');await expect(dialog.getByRole('link',{name:'Write email',exact:true})).toHaveAttribute('href',/^mailto:contact@scribyra\.com\?subject=/);
 await dialog.getByRole('button',{name:'Open Diagnostics',exact:true}).click();await expect(dialog).toHaveCount(0);const diagnostics=page.getByRole('dialog',{name:'Local diagnostics'});await expect(diagnostics).toContainText('scribyra-diagnostics.json');
 await diagnostics.getByLabel('Allow reviewed diagnostic export').check();const pending=page.waitForEvent('download');await diagnostics.getByRole('button',{name:'Export preview',exact:true}).click();await pending;await expect(diagnostics.getByRole('status')).toContainText('Attach it to your email');
 // The app's own service worker may re-register; nothing else may leave.
 expect(requests.filter(url=>new URL(url).pathname!=='/sw.js')).toEqual([]);
});

