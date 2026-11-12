import {test,expect} from '@playwright/test';
// The Rust companion is discontinued. Without its test-only switch the editor
// must not offer it anywhere and must never contact a local address by itself.
const loopback=new Set(['127.0.0.1','localhost','[::1]']);
test('production UI never offers or contacts the discontinued companion',async({page,context,baseURL})=>{
 const app=new URL(baseURL).origin,contacted=[];
 const watch=url=>{try{const target=new URL(url);if(loopback.has(target.hostname)&&target.origin!==app&&target.origin.replace(/^ws/,'http')!==app)contacted.push(url);}catch{}};
 context.on('request',request=>watch(request.url()));page.on('websocket',socket=>watch(socket.url()));
 await page.setViewportSize({width:1366,height:768});await page.goto('/');await page.getByRole('button',{name:'Start with a sample paper',exact:true}).click();await expect(page.locator('.cm-content')).toBeVisible();
 expect(await page.evaluate(()=>localStorage.getItem('scribyra-companion-dev'))).toBeNull();
 const toggle=page.getByRole('button',{name:'More tools',exact:true});await expect(toggle).toHaveAttribute('title','More tools');await expect(toggle).toHaveAttribute('data-active','false');
 await toggle.click();const menu=page.locator('#more-tools-menu');await expect(menu.getByRole('button',{name:'MCP providers',exact:true})).toBeVisible();
 await expect(menu.getByRole('button',{name:'Rust companion and MCP',exact:true})).toHaveCount(0);expect((await menu.innerText()).toLowerCase()).not.toContain('companion');
 await menu.getByRole('button',{name:'MCP providers',exact:true}).click();const providers=page.getByRole('dialog',{name:'MCP providers',exact:true});await expect(providers.getByLabel('MCP endpoint',{exact:true})).toBeVisible();
 await expect(providers.getByLabel('Connection type',{exact:true})).toBeHidden();await expect(providers.locator('option[value=stdio]')).toHaveCount(0);expect((await providers.innerText()).toLowerCase()).not.toContain('companion');
 await providers.getByRole('button',{name:'Close',exact:true}).click();
 for(const[name,title]of [['Project settings','Project settings'],['Diagnostics','Local diagnostics']]){await toggle.click();await page.getByRole('button',{name,exact:true}).click();const dialog=page.getByRole('dialog',{name:title,exact:true});await expect(dialog).toBeVisible();expect((await dialog.innerText()).toLowerCase()).not.toContain('companion');await page.keyboard.press('Escape');await expect(dialog).toHaveCount(0);}
 expect((await page.locator('body').innerText()).toLowerCase()).not.toContain('companion');
 await page.reload();await page.locator('.card-open').first().click();await expect(page.locator('.cm-content')).toBeVisible();
 expect(contacted).toEqual([]);
});
