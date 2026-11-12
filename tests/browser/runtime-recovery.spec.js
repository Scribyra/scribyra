import {test,expect} from '@playwright/test';
import {zipSync,strToU8} from 'fflate';
import {assetServer} from '../helpers/asset-server.mjs';
test('a new tab with copied session storage cannot cancel its opener runtime download',async({page,context})=>{
 const server=await assetServer();let other;
 try{
  const fault=server.interrupt('hold');await page.goto(server.url);const chooser=page.waitForEvent('filechooser');await page.getByRole('button',{name:'Import ZIP',exact:true}).click();await(await chooser).setFiles({name:'tab-recovery.zip',mimeType:'application/zip',buffer:Buffer.from(zipSync({'main.tex':strToU8('\\documentclass{article}\\begin{document}Tab ownership.\\end{document}')}))});await expect(page.locator('.cm-content')).toBeVisible();await page.getByRole('button',{name:'Compile',exact:true}).click();
  await expect.poll(()=>Boolean(fault.record),{timeout:120000}).toBeTruthy();
  const marker=await page.evaluate(()=>sessionStorage.getItem('scribyra-runtime-pending-v1'));expect(JSON.parse(marker)).toHaveLength(1);expect(fault.record?.closed).toBe(false);
  other=await context.newPage();await other.addInitScript(marker=>sessionStorage.setItem('scribyra-runtime-pending-v1',marker),marker);await other.goto(server.url);await expect(other.getByRole('button',{name:'Import ZIP',exact:true})).toBeVisible();
  expect(await other.evaluate(()=>performance.getEntriesByType('navigation')[0].type)).toBe('navigate');expect(await other.evaluate(()=>sessionStorage.getItem('scribyra-runtime-pending-v1'))).toBeNull();expect(await page.evaluate(()=>sessionStorage.getItem('scribyra-runtime-pending-v1'))).toBe(marker);expect(fault.record.closed).toBe(false);
  await page.getByRole('button',{name:'Cancel compilation',exact:true}).click();await expect(page.locator('.editor-status')).toContainText('Compilation cancelled');await expect.poll(()=>fault.record.closed,{timeout:10000}).toBeTruthy();
 }finally{await other?.close();await server.close();}
});
