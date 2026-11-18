// Organisation steps in the real app for the browser specs: open Remote backup, enter the
// deployment's address, sign in at the test provider's login form, then create the organisation,
// ask to join, approve, share, add a browser or restore.
import {expect} from '@playwright/test';

export const dialogOf=page=>page.getByRole('dialog',{name:'Remote backup'});
export async function saveKit(page){
 const dialog=dialogOf(page),kit=dialog.getByLabel('Recovery kit',{exact:true}).and(page.locator('pre'));
 await expect(kit).toContainText('scribyra-recovery:1:',{timeout:30000});
 const text=await kit.textContent();
 await dialog.getByRole('checkbox',{name:'I have saved my recovery kit somewhere safe'}).check();
 await dialog.getByRole('button',{name:'Done'}).click();
 return text;
}
/** The provider's own login form (a real page and real redirects). */
export async function providerLogin(page,user){
 await expect(page.getByLabel('Username')).toBeVisible({timeout:30000});
 await page.getByLabel('Username').fill(user);await page.getByLabel('Password').fill(`pw-${user}`);
 await page.getByRole('button',{name:'Sign in'}).click();
}
/** Opens Remote backup, enters the deployment's address and signs in as `user`; back in the app
 * with the dialog open. */
export async function signIn(page,s,user,{label='Acme account'}={}){
 const dialog=dialogOf(page);
 if(!(await dialog.isVisible()))await page.getByRole('button',{name:'Remote backup',exact:true}).click();
 await dialog.getByRole('textbox',{name:'Deployment address'}).fill(s.config.public_url);
 await dialog.getByRole('button',{name:'Continue'}).click();
 await dialog.getByRole('button',{name:`Sign in with ${label}`}).click();
 await providerLogin(page,user);
 await expect(dialogOf(page)).toBeVisible({timeout:30000});
 expect(new URL(page.url()).hash).toBe('');
}
/** The deployment's administrator signs in and creates the organisation; resolves to the kit. */
export async function create(page,s,user,ownerName){
 await signIn(page,s,user);
 const dialog=dialogOf(page);
 await dialog.getByRole('textbox',{name:'Your name'}).fill(ownerName);
 await dialog.getByRole('button',{name:'Create organisation'}).click();
 return saveKit(page);
}
/** `user` signs in on `page` and asks to join; `admin` approves them; resolves to their kit. */
export async function join(page,s,user,admin){
 await signIn(page,s,user);
 await expect(dialogOf(page)).toContainText('waiting to be let in',{timeout:30000});
 await approve(admin,`${user}@acme.test`);
 return saveKit(page);
}
/** An administrator's open dialog approves the pending person with this email. */
export async function approve(page,email){
 const dialog=dialogOf(page);
 if(!(await dialog.isVisible()))await page.evaluate(()=>window.scribyra.action('remote-backup'));
 const pending=dialog.getByRole('list',{name:'Members'}).getByRole('listitem').filter({hasText:email}).filter({hasText:'Waiting for approval'});
 await expect(pending).toBeVisible({timeout:30000});
 await pending.getByRole('button',{name:'Approve'}).click();
 await expect(dialog.getByRole('list',{name:'Members'}).getByRole('listitem').filter({hasText:email})).toContainText('Member',{timeout:30000});
}
/** Shares a backed-up project from an editor's open dialog with the member with this email. */
export async function share(page,project,email,role){
 const dialog=dialogOf(page);
 if(!(await dialog.isVisible()))await page.evaluate(()=>window.scribyra.action('remote-backup'));
 const row=dialog.getByRole('listitem').filter({hasText:project}).first();
 await row.getByRole('button',{name:'Share'}).click();
 await row.getByRole('combobox',{name:'Share with'}).selectOption({label:email});
 await row.getByRole('combobox',{name:'Role'}).selectOption(role);
 await row.getByRole('button',{name:'Share project'}).click();
 await expect(dialog.getByRole('status')).toContainText('Shared.');
}
