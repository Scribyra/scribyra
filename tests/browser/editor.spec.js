import { test,expect } from '@playwright/test';
import { zipSync,strToU8 } from 'fflate';
test.use({actionTimeout:15000});
test.setTimeout(90000);
async function open(page){
  await page.goto('/');const chooser=page.waitForEvent('filechooser');await page.getByRole('button',{name:'Import ZIP',exact:true}).click();
  await (await chooser).setFiles({name:'editor-workspace.zip',mimeType:'application/zip',buffer:Buffer.from(zipSync({'main.tex':strToU8('🌍 alpha alpha\n\\section{Introduction}\n\\input{chapters/two}\n'),'chapters/two.tex':strToU8('alpha beta\n\\subsection{Methods}\n'),'notes.txt':strToU8('ALPHA alphabet\n')}))});
  await expect(page.locator('.cm-content')).toBeVisible();
}
async function text(page,value){await page.getByLabel('Search text',{exact:true}).fill(value);await page.getByRole('button',{name:'Run search',exact:true}).click();}
async function files(page){await page.getByRole('button',{name:'Files',exact:true}).click();}
test('tabs preserve selection, undo, keyboard navigation and device preferences',async({page})=>{
  const errors=[];page.on('pageerror',e=>errors.push(e.message));await open(page);
  await page.locator('.cm-content').click();await page.keyboard.press('Control+Home');await page.keyboard.press('ArrowRight');await page.keyboard.insertText('MARK');
  await page.getByRole('treeitem',{name:'chapters/two.tex',exact:true}).click();await expect(page.getByRole('tab')).toHaveCount(2);
  await page.getByRole('tab',{name:'main.tex',exact:true}).click();await page.locator('.cm-content').focus();await page.keyboard.insertText('HERE');await expect(page.locator('.cm-content')).toContainText('🌍MARKHERE alpha');
  await page.keyboard.press('Control+z');await expect(page.locator('.cm-content')).not.toContainText('HERE');
  await page.getByRole('tab',{name:'main.tex',exact:true}).focus();await page.keyboard.press('ArrowRight');await expect(page.getByRole('tab',{name:'chapters/two.tex',exact:true})).toHaveAttribute('aria-selected','true');
  await page.getByRole('button',{name:'More tools',exact:true}).click();await page.getByRole('button',{name:'Project settings',exact:true}).click();await page.getByLabel('Font size',{exact:true}).selectOption('18');await page.getByLabel('Indent width',{exact:true}).selectOption('4');await page.getByLabel('Wrap long lines',{exact:true}).uncheck();await page.getByRole('button',{name:'Save settings',exact:true}).click();
  await expect(page.locator('.cm-editor')).toHaveCSS('font-size','18px');await expect(page.locator('.cm-content')).not.toHaveClass(/cm-lineWrapping/);
  await expect.poll(async()=>{const line=await page.locator('.cm-line').first().boundingBox(),number=await page.locator('.cm-lineNumbers .cm-gutterElement').filter({hasText:/^1$/}).boundingBox();return Math.abs(line.y-number.y);}).toBeLessThan(2);
  await page.getByRole('button',{name:'Close chapters/two.tex',exact:true}).click();await expect(page.getByRole('tab',{name:'main.tex',exact:true})).toHaveAttribute('aria-selected','true');
  await expect(page.locator('.save-indicator')).toHaveText('Saved locally');await page.reload();await page.getByRole('button',{name:/editor-workspace.*files/}).click();await expect(page.getByRole('tab')).toHaveCount(1);await expect(page.locator('.cm-editor')).toHaveCSS('font-size','18px');
  await page.getByRole('button',{name:'Close main.tex',exact:true}).click();await expect(page.locator('.empty-editor')).toBeVisible();await page.reload();await page.getByRole('button',{name:/editor-workspace.*files/}).click();await expect(page.getByRole('tab')).toHaveCount(0);await expect(page.locator('.empty-editor')).toBeVisible();
  await page.getByRole('treeitem',{name:'main.tex',exact:true}).click();await expect(page.locator('.cm-content')).toBeVisible();expect(errors).toEqual([]);
});
test('Rust project search, selective replacements and batch undo, source outline and offline workers',async({page,context})=>{
  const errors=[];page.on('pageerror',e=>errors.push(e.message));await open(page);
  await page.keyboard.press('Control+Shift+f');await expect(page.getByLabel('Search text',{exact:true})).toBeFocused();await text(page,'alpha');await expect(page.locator('.tool-status')).toHaveText('5 matches');
  await page.getByLabel('Whole words',{exact:true}).check();await page.getByLabel('Replacement text',{exact:true}).fill('gamma');await page.getByRole('button',{name:'Run search',exact:true}).click();await expect(page.locator('.tool-status')).toHaveText('4 matches');
  await page.getByRole('button',{name:'Review replacements',exact:true}).click();await page.getByRole('checkbox',{name:/notes.txt/}).uncheck();await page.getByRole('button',{name:'Apply replacements',exact:true}).click();await expect(page.getByRole('status',{name:'Workspace notification',exact:true})).toContainText('Replaced 3 matches.');await expect(page.locator('.cm-content')).toContainText('gamma gamma');
  await page.getByRole('button',{name:'Undo replacements',exact:true}).click();await expect(page.locator('.cm-content')).toContainText('alpha alpha');await page.getByRole('button',{name:'Redo replacements',exact:true}).click();await expect(page.locator('.cm-content')).toContainText('gamma gamma');
  await page.getByLabel('Replacement text',{exact:true}).fill('');await text(page,'gamma');await expect(page.locator('.tool-status')).toHaveText('3 matches');await page.getByRole('button',{name:/chapters\/two.tex:1:1/}).click();await expect(page.getByRole('tab',{name:'chapters/two.tex',exact:true})).toHaveAttribute('aria-selected','true');await expect.poll(()=>page.evaluate(()=>window.getSelection()?.toString())).toBe('gamma');
  await page.keyboard.press('Control+Shift+o');await expect(page.locator('.tool-status')).toHaveText('1 headings');await page.getByLabel('Outline scope',{exact:true}).selectOption('project');await expect(page.locator('.tool-status')).toHaveText('2 headings');await page.getByRole('button',{name:/Introduction main.tex:2/}).click();await expect(page.getByRole('tab',{name:'main.tex',exact:true})).toHaveAttribute('aria-selected','true');
  await expect.poll(()=>page.evaluate(()=>Boolean(navigator.serviceWorker.controller))).toBeTruthy();await expect(page.locator('.save-indicator')).toHaveText('Saved locally');await context.setOffline(true);await page.reload();await page.getByRole('button',{name:/editor-workspace.*files/}).click();await page.getByRole('button',{name:'Search project',exact:true}).click();await text(page,'gamma');await expect(page.locator('.tool-status')).toHaveText('3 matches');await context.setOffline(false);expect(errors).toEqual([]);
});
test('regex errors and stale replacement reviews leave the source intact',async({page})=>{
  await open(page);await page.getByRole('button',{name:'Search project',exact:true}).click();await page.getByLabel('Regular expression',{exact:true}).check();await text(page,'[');await expect(page.locator('.tool-status')).toContainText('unclosed');
  await page.getByLabel('Replacement text',{exact:true}).fill('$2/$1');await text(page,'(alpha) (beta)');await expect(page.locator('.tool-status')).toHaveText('1 matches');await page.getByRole('button',{name:'Review replacements',exact:true}).click();await expect(page.getByRole('dialog')).toContainText('+ beta/alpha');await page.getByRole('button',{name:'Cancel',exact:true}).click();
  await page.getByLabel('Search scope',{exact:true}).selectOption('file');await text(page,'alpha');await expect(page.locator('.tool-status')).toHaveText('2 matches');
  await page.locator('.cm-content').click();await page.keyboard.press('Control+Home');await page.keyboard.insertText('% changed\n');await expect(page.locator('.tool-status')).toContainText('Source changed');await expect(page.getByRole('button',{name:'Review replacements',exact:true})).toBeDisabled();
});
