import {test,expect} from '@playwright/test';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';import {join} from 'node:path';
import {unzipSync,strFromU8} from 'fflate';
import {reserveMarionettePort,firefoxIme} from '../helpers/firefox-ime.mjs';
test('native Gecko composition commit/cancel preserves source, undo and durable reload',async({playwright,browserName,baseURL})=>{
 test.skip(browserName!=='firefox','This test uses native Gecko TextInputProcessor.');test.setTimeout(90000);
 await reserveMarionettePort();const profile=await mkdtemp(join(tmpdir(),'scribyra-native-firefox-'));let context,ime;
 try{
  context=await playwright.firefox.launchPersistentContext(profile,{headless:true,args:['--marionette','--remote-allow-system-access']});
  const page=context.pages()[0]||await context.newPage();await page.goto(baseURL);await page.getByRole('button',{name:'Start with a sample paper'}).click();const source=page.getByRole('textbox',{name:'LaTeX source',exact:true});await expect(source).toBeVisible();await source.focus();await page.keyboard.press('Control+Home');
  const original=await source.innerText();await page.evaluate(()=>{window.__nativeIme=[];for(const type of ['compositionstart','compositionupdate','compositionend'])document.addEventListener(type,e=>window.__nativeIme.push({type:e.type,trusted:e.isTrusted}));});
  ime=await firefoxIme(profile,new URL(baseURL).origin);await source.focus();
  await ime.preedit('キャンセル');await expect(source).toContainText('キャンセル');await ime.cancel();await expect.poll(()=>source.innerText()).toBe(original);
  await source.focus();await page.keyboard.press('Control+Home');await ime.preedit('にほ');await expect(source).toContainText('にほ');await ime.controlEnter();await expect(page.getByRole('button',{name:'Compile',exact:true})).toBeVisible();expect(await page.evaluate(()=>window.scribyra.lastCompile)).toBeNull();await expect(source).toContainText('にほ');
  const marker='日本語🌍e\u0301';await ime.commit(marker);await expect(source).toContainText(marker);
  await expect.poll(()=>page.evaluate(()=>window.__nativeIme.filter(e=>e.type==='compositionend'&&e.trusted).length)).toBe(2);
  const events=await page.evaluate(()=>window.__nativeIme);expect(events.every(e=>e.trusted)).toBeTruthy();
  await page.keyboard.press('Control+Shift+f');await expect(page.getByLabel('Search text',{exact:true})).toBeFocused();await source.focus();await expect(page.locator('.save-indicator')).toHaveText('Saved locally');await page.keyboard.press('Control+z');await expect(source).not.toContainText(marker);await page.keyboard.press('Control+y');await expect(source).toContainText(marker);
  await expect(page.locator('.save-indicator')).toHaveText('Saved locally');const event=page.waitForEvent('download');await page.getByRole('button',{name:'Export',exact:true}).click();const files=unzipSync(new Uint8Array(await readFile(await(await event).path())));const text=strFromU8(files['main.tex']);expect(text.startsWith(marker+'\\documentclass')).toBeTruthy();expect(text.split(marker)).toHaveLength(2);expect(text).not.toContain('キャンセル');expect(text).not.toContain('にほ');
  await page.reload();await page.getByRole('button',{name:/A space for your next great idea.*files?/}).click();await expect(source).toContainText(marker);
 }finally{ime?.close();await context?.close();await rm(profile,{recursive:true,force:true});}
});
