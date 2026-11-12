import {test,expect} from '@playwright/test';
import {mkdtemp,rm,readFile,writeFile,rename,access} from 'node:fs/promises';
import {tmpdir} from 'node:os';import {join} from 'node:path';
import {unzipSync,strFromU8} from 'fflate';
import {buildNativeIme} from '../../scripts/build-native-ime.mjs';
test('native WPE composition commit/cancel preserves source, undo and durable reload',async({playwright,browserName,baseURL})=>{
 test.skip(browserName!=='webkit','Native WPE input-method adapter.');test.skip(process.platform!=='linux','WPE adapter requires Linux; other platform native coverage is separate.');test.setTimeout(90000);
 const library=await buildNativeIme(),directory=await mkdtemp(join(tmpdir(),'scribyra-native-wpe-'));let browser;
 try{
  browser=await playwright.webkit.launch({headless:true,env:{...process.env,LD_PRELOAD:library,SCRIBYRA_NATIVE_IME_DIRECTORY:directory}});const context=await browser.newContext();const page=await context.newPage();await page.goto(baseURL);await page.getByRole('button',{name:'Start with a sample paper'}).click();const source=page.getByRole('textbox',{name:'LaTeX source',exact:true});await expect(source).toBeVisible();await source.focus();await page.keyboard.press('Control+Home');
  await expect.poll(async()=>{try{await access(join(directory,'ready'));return true;}catch{return false;}}).toBeTruthy();
  const send=async(command,text='')=>{await rm(join(directory,'done'),{force:true});await writeFile(join(directory,'next'),command+':'+text);await rename(join(directory,'next'),join(directory,'command'));await expect.poll(async()=>{try{return await readFile(join(directory,'done'),'utf8');}catch{return '';}}).toBe(command);};
  const original=await source.innerText();await page.evaluate(()=>{window.__nativeIme=[];for(const type of ['compositionstart','compositionupdate','compositionend'])document.addEventListener(type,e=>window.__nativeIme.push({type:e.type,trusted:e.isTrusted}));});
  await send('preedit','キャンセル');await expect(source).toContainText('キャンセル');await send('cancel');await expect.poll(()=>source.innerText()).toBe(original);
  await source.focus();await page.keyboard.press('Control+Home');await send('preedit','にほ');await expect(source).toContainText('にほ');await page.keyboard.press('Control+Enter');await expect(page.getByRole('button',{name:'Compile',exact:true})).toBeVisible();expect(await page.evaluate(()=>window.scribyra.lastCompile)).toBeNull();await expect(source).toContainText('にほ');const marker='日本語🌍e\u0301';await send('commit',marker);await expect(source).toContainText(marker);
  await expect.poll(()=>page.evaluate(()=>window.__nativeIme.filter(e=>e.type==='compositionend'&&e.trusted).length)).toBe(2);expect((await page.evaluate(()=>window.__nativeIme)).every(e=>e.trusted)).toBeTruthy();
  await page.keyboard.press('Control+Shift+f');await expect(page.getByLabel('Search text',{exact:true})).toBeFocused();await source.focus();await expect(page.locator('.save-indicator')).toHaveText('Saved locally');await page.keyboard.press('Control+z');await expect(source).not.toContainText(marker);await page.keyboard.press('Control+y');await expect(source).toContainText(marker);
  await expect(page.locator('.save-indicator')).toHaveText('Saved locally');const event=page.waitForEvent('download');await page.getByRole('button',{name:'Export',exact:true}).click();const files=unzipSync(new Uint8Array(await readFile(await(await event).path())));const text=strFromU8(files['main.tex']);expect(text.startsWith(marker+'\\documentclass')).toBeTruthy();expect(text.split(marker)).toHaveLength(2);expect(text).not.toContain('キャンセル');expect(text).not.toContain('にほ');
  await page.reload();await page.getByRole('button',{name:/A space for your next great idea.*files?/}).click();await expect(source).toContainText(marker);
 }finally{await browser?.close();await rm(directory,{recursive:true,force:true});}
});
