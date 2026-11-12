// Opens each menu, popup and dialog in light and dark at 1366×768 and writes PNGs to tmp/menus.
// node scripts/menu-screenshots.mjs [baseUrl]   (uses PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH from the flake)
import {chromium,firefox,webkit} from '@playwright/test';
import {mkdir} from 'node:fs/promises';
const base=process.argv[2]||'http://127.0.0.1:5901/',out=process.env.MENU_SHOTS||'tmp/menus';await mkdir(out,{recursive:true});
const engine=process.env.MENU_ENGINE||'chromium',types={chromium,firefox,webkit};const browser=await types[engine].launch({executablePath:process.env[`PLAYWRIGHT_${engine.toUpperCase()}_EXECUTABLE_PATH`]||undefined,args:engine==='chromium'?['--no-sandbox']:[]});
for(const theme of ['light','dark']){
  const context=await browser.newContext({viewport:{width:1366,height:768},colorScheme:theme});const page=await context.newPage();
  const shot=async name=>{await page.waitForTimeout(120);await page.screenshot({path:`${out}/${theme}-${name}.png`});};
  const dismiss=async()=>{await page.keyboard.press('Escape');await page.waitForTimeout(60);};
  await page.goto(base);await page.evaluate(t=>localStorage.setItem('scribyra-theme',t),theme);await page.reload();
  await page.getByRole('button',{name:'Start with a sample paper'}).click();await page.locator('.cm-content').waitFor();
  const folders=['chapters','figures','figures/raw','data','notes','slides','bibliography','scripts'];
  for(const folder of folders){await page.getByRole('button',{name:'Add folder',exact:true}).click();await page.getByRole('textbox',{name:'New folder'}).fill(folder);await page.getByRole('button',{name:'Create folder',exact:true}).click();await page.getByRole('treeitem',{name:folder,exact:true}).waitFor();await page.evaluate(()=>window.scribyra.action('select-root'));}
  await page.getByRole('button',{name:'Add file',exact:true}).click();await page.getByRole('textbox',{name:'New file'}).fill('chapters/intro.tex');await page.getByRole('button',{name:'Create file',exact:true}).click();await page.evaluate(()=>window.scribyra.action('select-root'));
  await page.getByRole('treeitem',{name:'main.tex',exact:true}).click();
  await shot('00-workspace');
  // Selects.
  const select=async(role,name)=>{await page.getByRole('combobox',{name}).click();await shot(role);await dismiss();};
  await select('01-editor-mode','Editor mode');await select('02-compiler','Compiler');await select('03-main-document','Main document');
  // Compile options.
  await page.getByRole('button',{name:'Compile options',exact:true}).click();await shot('04-compile-options');await dismiss();
  // File actions.
  const main=page.getByRole('treeitem',{name:'main.tex',exact:true});const row=main.locator('..');
  await row.hover();await row.getByRole('button',{name:'File actions'}).click();await shot('05-file-menu-button');await dismiss();
  await main.click({button:'right'});await shot('06-file-menu-pointer');
  await page.getByRole('menuitem',{name:'Rename'}).click();await shot('07-rename-inline');await dismiss();
  await main.click({button:'right'});await page.getByRole('menuitem',{name:'Move'}).click();await shot('08-move-popover');await dismiss();
  await main.click({button:'right'});await page.getByRole('menuitem',{name:'Duplicate'}).click();await shot('09-duplicate-popover');await dismiss();
  const folder=page.getByRole('treeitem',{name:'figures',exact:true});
  await folder.click({button:'right'});await shot('10-folder-menu');
  await page.getByRole('menuitem',{name:'Delete'}).click();await shot('11-delete-folder-confirm');await dismiss();
  await page.locator('.file-list').click({button:'right',position:{x:60,y:(await page.locator('.file-list').boundingBox()).height-12}});await shot('12-tree-menu');await dismiss();
  await page.getByRole('button',{name:'Add folder',exact:true}).click();await shot('13-new-folder-popover');await dismiss();
  // Viewing mode: disabled with a reason, and the themed filter in Review.
  await page.getByRole('combobox',{name:'Editor mode'}).selectOption('viewing');await main.click({button:'right'});await shot('14-file-menu-viewing');await dismiss();
  await page.getByRole('combobox',{name:'Editor mode'}).selectOption('editing');
  await page.locator('.cm-content').click();await page.keyboard.press('Control+Home');await page.keyboard.press('Shift+End');await page.keyboard.press('Control+Alt+m');
  const body=page.locator('#comment-body');if(await body.isVisible().catch(()=>false)){await body.fill('A note to show the menus.');await page.keyboard.press('Control+Enter');}
  if(!await page.getByRole('combobox',{name:'Review status filter'}).isVisible().catch(()=>false))await page.getByRole('button',{name:'Review',exact:true}).click();
  await select('15-review-filter','Review status filter');
  await page.getByRole('button',{name:'Review actions',exact:true}).click();await shot('16-review-actions');await dismiss();
  const more=page.getByRole('button',{name:'Comment actions',exact:true}).first();if(await more.isVisible().catch(()=>false)){await more.click();await shot('17-comment-actions');await dismiss();}
  await page.getByRole('button',{name:'Review',exact:true}).click();
  // Side panels.
  await page.getByRole('button',{name:'Search project',exact:true}).click();await select('18-search-scope','Search scope');
  await page.getByRole('button',{name:'Document outline',exact:true}).click();await select('19-outline-scope','Outline scope');
  await page.getByRole('button',{name:'Files',exact:true}).click();
  // History.
  await page.locator('[aria-controls="project-history"]').click();await page.getByRole('button',{name:'Manage history',exact:true}).click();await shot('20-history-manage');await dismiss();await dismiss();
  // Dialogs and the selects inside them.
  const dialog=async(name,opener,inner)=>{if(await page.getByRole('button',{name:'More tools',exact:true}).isVisible())await page.getByRole('button',{name:'More tools',exact:true}).click();await page.getByRole('button',{name:opener,exact:true}).click();await page.getByRole('dialog').first().waitFor();await shot(name);if(inner){await page.getByRole('combobox',{name:inner}).click();await shot(`${name}-select`);await dismiss();}await dismiss();await page.waitForTimeout(100);};
  await dialog('21-settings','Project settings','Font size');
  await dialog('22-environment','TeX environment');
  await dialog('23-diagnostics','Diagnostics');
  await page.locator('.project-title').click();await page.getByRole('dialog').first().waitFor();await shot('24-rename-project');await dismiss();
  // Dashboard.
  await page.getByRole('button',{name:'All projects',exact:true}).click();await page.getByRole('button',{name:'Project actions',exact:true}).first().waitFor();await shot('25-dashboard');
  await page.getByRole('button',{name:'Project actions',exact:true}).first().click();await shot('26-project-menu');
  await page.getByRole('menuitem',{name:'Delete project'}).click();await shot('27-delete-project-confirm');await dismiss();
  await context.close();
}
await browser.close();
