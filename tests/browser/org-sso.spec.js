// Signing in to an end-to-end deployment in the real app with the repository's OIDC test
// provider: the dialog starts from the deployment's address and its "Sign in with …" button;
// the administrator creates the organisation; a colleague signs in, asks to join and is approved;
// a guest account and someone outside the member groups are refused with a plain message; and a
// member who signs out signs in again to keep syncing.
import {test,expect} from '@playwright/test';
import {orgService,people} from '../helpers/idp.mjs';
import {dialogOf,signIn,create,join,providerLogin} from '../helpers/org-browser.mjs';

const users=[
 ...people(['ana','ben','cleo']).map(u=>({...u,groups:['lab']})),
 {sub:'sub-gus',username:'gus',password:'pw-gus',email:'gus@partner.test',email_verified:true,name:'Gus',groups:['lab'],claims:{acct:1}},
 {sub:'sub-olga',username:'olga',password:'pw-olga',email:'olga@acme.test',email_verified:true,name:'Olga',groups:['elsewhere']},
];
async function profile(browser,info){
 const context=await browser.newContext();
 if(info.project.name==='chromium')await context.grantPermissions(['local-network-access']).catch(()=>{});
 const page=await context.newPage();await page.goto('/');return{context,page};
}

test('joining through the organisation’s sign-in: the admin creates it, a colleague asks and is approved, guests and outsiders are refused',async({browser},info)=>{
 const lab=await orgService({users,shortcuts:false,provider:{groups_claim:'groups',member_groups:['lab'],guest:{claim:'acct',equals:'1'}}});
 const contexts=[];
 try{
  // Nothing is contacted before the person enters an address and signs in.
  const ana=await profile(browser,info);contexts.push(ana.context);
  await ana.page.getByRole('button',{name:'Remote backup',exact:true}).click();
  const dialog=dialogOf(ana.page);
  await expect(dialog.getByRole('textbox',{name:'Setup code'})).toHaveCount(0);
  await expect(dialog.getByRole('textbox',{name:'Invitation link'})).toHaveCount(0);
  await dialog.getByRole('textbox',{name:'Deployment address'}).fill(lab.config.public_url);
  await dialog.getByRole('button',{name:'Continue'}).click();
  await expect(dialog).toContainText('Acme Lab');
  await expect(dialog.getByRole('button',{name:'Sign in with Acme account'})).toBeVisible();
  await dialog.getByRole('button',{name:'Close remote backup'}).click();
  await create(ana.page,lab,'ana','Ana');
  await expect(dialog).toContainText('Acme Lab');
  await expect(dialog).toContainText('End-to-end encrypted');

  // Ben signs in and asks to join; Ana approves him (she sees the email he signed in with).
  const ben=await profile(browser,info);contexts.push(ben.context);
  await join(ben.page,lab,'ben',ana.page);
  await expect(dialogOf(ben.page)).toContainText('Acme Lab');
  await expect(dialogOf(ben.page).getByRole('list',{name:'Members'})).toContainText('ben@acme.test');
  expect(await lab.sql("SELECT count(*) FROM sso_links WHERE subject = 'sub-ben'")).toBe('1');

  // A guest account and someone outside the member groups are turned away before anything else.
  const gus=await profile(browser,info);contexts.push(gus.context);
  await gus.page.getByRole('button',{name:'Remote backup',exact:true}).click();
  await dialogOf(gus.page).getByRole('textbox',{name:'Deployment address'}).fill(lab.config.public_url);
  await dialogOf(gus.page).getByRole('button',{name:'Continue'}).click();
  await dialogOf(gus.page).getByRole('button',{name:'Sign in with Acme account'}).click();
  await providerLogin(gus.page,'gus');
  await expect(gus.page.getByText('Guest accounts can’t use this organisation’s Scribyra.')).toBeVisible({timeout:30000});
  const olga=await profile(browser,info);contexts.push(olga.context);
  await olga.page.getByRole('button',{name:'Remote backup',exact:true}).click();
  await dialogOf(olga.page).getByRole('textbox',{name:'Deployment address'}).fill(lab.config.public_url);
  await dialogOf(olga.page).getByRole('button',{name:'Continue'}).click();
  await dialogOf(olga.page).getByRole('button',{name:'Sign in with Acme account'}).click();
  await providerLogin(olga.page,'olga');
  await expect(olga.page.getByText('Your account is not in a group that may use this organisation’s Scribyra.',{exact:false})).toBeVisible({timeout:30000});
  expect(await lab.sql("SELECT count(*) FROM sso_logins WHERE subject IN ('sub-gus','sub-olga')")).toBe('0');

  // Cleo is a member of the groups but nobody approved her: she waits, with no session.
  const cleo=await profile(browser,info);contexts.push(cleo.context);
  await signIn(cleo.page,lab,'cleo');
  await expect(dialogOf(cleo.page)).toContainText('waiting to be let in',{timeout:30000});
  await dialogOf(cleo.page).getByRole('button',{name:'Check again'}).click();
  await expect(dialogOf(cleo.page)).toContainText('waiting to be let in');

  // Ben signs out: his browser stops syncing until he signs in again with the provider.
  const benDialog=dialogOf(ben.page);
  await benDialog.getByRole('button',{name:'Sign out'}).click();
  await expect(benDialog.getByRole('button',{name:'Sign in with Acme account again'})).toBeVisible({timeout:30000});
  await benDialog.getByRole('button',{name:'Sign in with Acme account again'}).click();
  await providerLogin(ben.page,'ben');
  await expect(dialogOf(ben.page).getByRole('button',{name:'Sign out'})).toBeVisible({timeout:30000});
 }finally{for(const c of contexts)await c.close().catch(()=>{});await lab.close();}
});
