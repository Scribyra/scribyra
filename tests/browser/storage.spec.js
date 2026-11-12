import { test, expect } from '@playwright/test';

async function edit(page, text) {
  await page.locator('.cm-content').click(); await page.keyboard.press('Control+Home'); await page.keyboard.insertText(text+'\n');
  await expect(page.locator('.save-indicator')).toHaveText('Saved locally');
}
async function openExisting(page,baseURL) {
  await page.goto(baseURL); await page.getByRole('button',{name:/A space for your next great idea.*file/}).click();await expect(page.locator('.cm-content')).toBeVisible();
}
test('stale tabs merge their saves and journal remains durable after both reload',async({page,context,baseURL})=>{
  await page.goto('/');await page.getByRole('button',{name:'Start with a sample paper'}).click();await expect(page.locator('.cm-content')).toBeVisible();
  const second=await context.newPage();await openExisting(second,baseURL);
  await edit(page,'% first-tab-edit');await edit(second,'% second-tab-edit');
  await expect(second.locator('.cm-content')).toContainText('first-tab-edit');
  await openExisting(page,baseURL);await openExisting(second,baseURL);
  for(const tab of [page,second]) {
    await expect(tab.locator('.cm-content')).toContainText('first-tab-edit');await expect(tab.locator('.cm-content')).toContainText('second-tab-edit');
  }
  const history=await page.evaluate(async()=>{
    const db=await new Promise(resolve=>{const r=indexedDB.open('scribyra-v1');r.onsuccess=()=>resolve(r.result);});
    const read=store=>new Promise(resolve=>{const r=db.transaction(store).objectStore(store).getAll();r.onsuccess=()=>resolve(r.result);});
    const projects=await read('projects'),journal=await read('journal'),checkpoints=await read('checkpoints');db.close();
    return {head:projects[0].sequence,entries:journal.map(e=>e.sequence).sort((a,b)=>a-b),checkpoints:checkpoints.map(e=>e.sequence)};
  });
  expect(history.head).toBeGreaterThanOrEqual(2);expect(history.entries).toEqual(Array.from({length:history.head},(_,i)=>i+1));expect(history.checkpoints).toContain(0);
  await second.close();
});
test('deleting a project in another tab prevents resurrection while allowing source export',async({page,context,baseURL})=>{
  await page.goto('/');await page.getByRole('button',{name:'Start with a sample paper'}).click();await expect(page.locator('.cm-content')).toBeVisible();
  const second=await context.newPage();await second.goto(baseURL);
  await second.getByRole('button',{name:'Project actions',exact:true}).click();await second.getByRole('menuitem',{name:'Delete project',exact:true}).click();await second.getByRole('button',{name:'Delete project',exact:true}).click();
  await expect(second.locator('.project-card')).toHaveCount(0);
  await page.locator('.cm-content').click();await page.keyboard.press('Control+Home');await page.keyboard.insertText('% preserve-this-open-copy\n');
  await expect(page.locator('.save-indicator')).toHaveText('Not saved · export a backup');await expect(page.getByRole('status',{name:'Workspace notification',exact:true})).toContainText('deleted in another tab');
  const download=page.waitForEvent('download');await page.getByRole('button',{name:'Export',exact:true}).click();expect((await download).suggestedFilename()).toMatch(/\.zip$/);
  await second.reload();await expect(second.locator('.project-card')).toHaveCount(0);await second.close();
});
