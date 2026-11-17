// Single sign-on in the real app with the repository's OIDC test provider: an invitation that
// requires the organisation's sign-in sends the joiner through the provider's login form and
// back; someone without an invitation signs in and asks to join, and an admin approves them.
import {test,expect} from '@playwright/test';
import {service,orgCreate} from '../helpers/service.mjs';
import {idp,configureSso} from '../helpers/idp.mjs';

const users=[
 {sub:'sub-ben',username:'ben',password:'pw-ben',email:'ben@acme.test',email_verified:true,name:'Ben Acme'},
 {sub:'sub-cleo',username:'cleo',password:'pw-cleo',email:'cleo@acme.test',email_verified:true,name:'Cleo Acme'},
];
async function profile(browser,info){
 const context=await browser.newContext();
 if(info.project.name==='chromium')await context.grantPermissions(['local-network-access']).catch(()=>{});
 const page=await context.newPage();await page.goto('/');return{context,page};
}
const dialogOf=page=>page.getByRole('dialog',{name:'Remote backup'});
async function saveKit(page){
 const dialog=dialogOf(page);
 await expect(dialog.getByLabel('Recovery kit',{exact:true}).and(page.locator('pre'))).toContainText('scribyra-recovery:1:');
 await dialog.getByRole('checkbox',{name:'I have saved my recovery kit somewhere safe'}).check();
 await dialog.getByRole('button',{name:'Done'}).click();
}
async function providerLogin(page,user){
 await expect(page.getByLabel('Username')).toBeVisible();
 await page.getByLabel('Username').fill(user);await page.getByLabel('Password').fill(`pw-${user}`);
 await page.getByRole('button',{name:'Sign in'}).click();
}

test('joining through the organisation’s single sign-on, by invitation and by asking an admin',async({browser},info)=>{
 const s=await service({org:true});const contexts=[];let provider;
 try{
  const ana=await profile(browser,info);contexts.push(ana.context);
  await ana.page.getByRole('button',{name:'Remote backup',exact:true}).click();
  const dialog=dialogOf(ana.page);
  await dialog.getByRole('textbox',{name:'Setup code'}).fill(await orgCreate(s,'acme'));
  await dialog.getByRole('textbox',{name:'Organisation name'}).fill('Acme SSO');
  await dialog.getByRole('button',{name:'Connect'}).click();
  await saveKit(ana.page);
  provider=await idp({publicUrl:s.config.public_url,users});
  const org=await s.sql('SELECT org FROM orgs LIMIT 1');
  await configureSso(s,org,provider);
  // Reopen so the dialog sees the org's SSO.
  await dialog.getByRole('button',{name:'Close remote backup'}).click();await ana.page.getByRole('button',{name:'Remote backup',exact:true}).click();
  await expect(dialog.getByRole('checkbox',{name:'They must sign in with the organisation'})).toBeVisible();
  await dialog.getByRole('checkbox',{name:'They must sign in with the organisation'}).check();
  await dialog.getByRole('textbox',{name:'Their email at the organisation (optional)'}).fill('Ben@acme.test');
  await dialog.getByRole('button',{name:'Create invitation link'}).click();
  const invitation=await dialog.getByRole('textbox',{name:'Invitation link to send'}).inputValue();

  // Ben opens the invitation; joining sends him to the provider and back.
  const ben=await profile(browser,info);contexts.push(ben.context);
  await ben.page.goto(invitation);
  await dialogOf(ben.page).getByRole('textbox',{name:'Your name for this organisation'}).fill('Ben');
  await dialogOf(ben.page).getByRole('button',{name:'Join'}).click();
  await providerLogin(ben.page,'ben');
  await saveKit(ben.page);
  await expect(dialogOf(ben.page)).toContainText('Acme SSO');
  expect(new URL(ben.page.url()).hash).toBe('');
  await expect(dialog.getByRole('list',{name:'Members'})).toContainText('Ben',{timeout:30000});
  // The provider's identity is linked to Ben on the service.
  expect(await s.sql("SELECT count(*) FROM sso_links WHERE subject = 'sub-ben'")).toBe('1');

  // Cleo has no invitation: she signs in with the organisation's link and asks to join.
  const cleo=await profile(browser,info);contexts.push(cleo.context);
  const genesis=await s.sql(`SELECT hash FROM org_events WHERE org='${org}' AND seq=1`);
  const encoded=Buffer.from(JSON.stringify({genesis,org,service:s.config.public_url,v:1})).toString('base64url');
  await cleo.page.goto(`/#org=${encoded}`);
  await dialogOf(cleo.page).getByRole('button',{name:'Sign in with your organisation'}).first().click();
  await providerLogin(cleo.page,'cleo');
  await expect(dialogOf(cleo.page)).toContainText('waiting to be let in',{timeout:30000});
  const pending=dialog.getByRole('listitem').filter({hasText:'Waiting for approval'});
  await expect(pending).toBeVisible({timeout:30000});
  await pending.getByRole('button',{name:'Approve'}).click();
  await saveKit(cleo.page);
  await expect(dialogOf(cleo.page)).toContainText('Acme SSO');
 }finally{for(const c of contexts)await c.close().catch(()=>{});await provider?.close();await s.close();}
});
