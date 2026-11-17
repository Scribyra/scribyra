// "The person": attaches to their own already-running browser (CDP 127.0.0.1:9622), opens the
// app, creates two projects and leaves the tab open on one. Run: nix develop -c node <this> <zip>
import {chromium} from '@playwright/test';
const zip=process.argv[2],endpoint=process.env.R4_CDP||'http://127.0.0.1:9622',app=process.env.R4_APP||'https://app.scribyra.com/';
const browser=await chromium.connectOverCDP(endpoint);
try{
 const page=browser.contexts()[0].pages()[0];page.setDefaultTimeout(60000);
 await page.goto(app);
 const noThanks=page.getByRole('button',{name:'No thanks'});
 if(await noThanks.isVisible().catch(()=>false))await noThanks.click();
 await page.getByRole('button',{name:'Start with a sample paper'}).click();
 await page.getByRole('textbox',{name:'LaTeX source',exact:true}).waitFor();
 console.log('sample:',await page.title());
 await page.getByRole('button',{name:/All projects/}).click();
 const chooser=page.waitForEvent('filechooser');
 await page.getByRole('button',{name:'Import ZIP',exact:true}).click();(await chooser).setFiles(zip);
 await page.getByRole('textbox',{name:'LaTeX source',exact:true}).waitFor();
 console.log('imported:',await page.title(),page.url());
}finally{await browser.close();}
