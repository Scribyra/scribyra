import{test,expect}from'@playwright/test';
test.use({actionTimeout:15000});
test('cancelling during PDF worker initialization prevents a late preview and permits the next build',async({page})=>{
 await page.addInitScript(()=>{
  const Original=window.Worker;window.__holdPdf=true;window.__pdfQueue=[];
  window.Worker=class extends Original{
   constructor(url,options){super(url,options);this.pdf=String(url).includes('pdf.worker');}
   postMessage(...args){if(this.pdf&&window.__holdPdf){window.__pdfBlocked=true;window.__pdfQueue.push(()=>{try{super.postMessage(...args);}catch{}});}else super.postMessage(...args);}
  };
 });
 await page.goto('/');await page.getByRole('button',{name:'Start with a sample paper'}).click();await expect(page.locator('.cm-content')).toBeVisible();
 await page.getByRole('button',{name:'Compile',exact:true}).click();await expect.poll(()=>page.evaluate(()=>window.__pdfBlocked),{timeout:180000}).toBeTruthy();
 await page.getByRole('button',{name:'Cancel compilation',exact:true}).click();await expect(page.locator('.editor-status')).toContainText('Compilation cancelled');
 await page.evaluate(()=>{window.__holdPdf=false;for(const run of window.__pdfQueue)run();window.__pdfQueue=[];});
 await expect(page.locator('#pdf-viewer canvas')).toHaveCount(0);const cancelled=await page.evaluate(()=>window.scribyra.lastCompile);expect(cancelled.success).toBeFalsy();expect(cancelled.sourceRevision).toContain(':');
 await page.evaluate(()=>{window.scribyra.lastCompile=null;});await page.getByRole('button',{name:'Compile',exact:true}).click();
 await expect.poll(()=>page.evaluate(()=>window.scribyra.lastCompile),{timeout:180000}).toBeTruthy();const result=await page.evaluate(()=>window.scribyra.lastCompile);expect(result.success,result.log).toBeTruthy();expect(result.projectId).toBe(cancelled.projectId);expect(result.jobId).not.toBe(cancelled.jobId);expect(result.sourceRevision).toContain(':');await expect(page.locator('#pdf-viewer canvas').first()).toBeVisible();
});
