import{test,expect}from'@playwright/test';
import{readFile}from'node:fs/promises';
test.use({actionTimeout:15000});
async function pdfBytes(page){const event=page.waitForEvent('download');await page.getByRole('button',{name:'Download PDF',exact:true}).click();return readFile(await(await event).path());}
test('cancellation while PDF pages are being replaced restores the previous document and download',async({page})=>{
 await page.goto('/');await page.getByRole('button',{name:'Start with a sample paper'}).click();await expect(page.locator('.cm-content')).toBeVisible();
 await page.getByRole('button',{name:'Compile',exact:true}).click();await expect.poll(()=>page.evaluate(()=>window.scribyra.lastCompile),{timeout:180000}).toBeTruthy();
 expect(await page.evaluate(()=>window.scribyra.lastCompile.success)).toBeTruthy();await expect(page.locator('#pdf-viewer canvas').first()).toBeVisible();const before=await pdfBytes(page);
 await page.evaluate(()=>{
  window.scribyra.lastCompile=null;const observer=new MutationObserver(records=>{
   if(records.some(record=>record.removedNodes.length)){observer.disconnect();window.__replacementCancelled=true;void window.scribyra.action('compile');}
  });observer.observe(document.querySelector('#pdf-viewer .pdfViewer'),{childList:true});
 });
 await page.getByRole('button',{name:'Compile',exact:true}).click();await expect.poll(()=>page.evaluate(()=>window.__replacementCancelled),{timeout:180000}).toBeTruthy();
 await expect(page.locator('.editor-status')).toContainText('Compilation cancelled');await expect(page.locator('#pdf-viewer canvas').first()).toBeVisible();
 expect(await pdfBytes(page)).toEqual(before);expect(await page.evaluate(()=>window.scribyra.lastCompile.errorType)).toBe('AbortError');
});
