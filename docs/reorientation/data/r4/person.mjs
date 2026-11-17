// "The person" acting in their own tab, through the UI only (no agent API).
// nix develop -c node person.mjs <command> [args]. Commands: open <project>, compile, read,
// mode <Editing|Reviewing|Viewing>, history, snapshot, type <file> <text...>, replace <file> <from> <to>.
import {chromium} from '@playwright/test';
const [cmd,...args]=process.argv.slice(2),endpoint=process.env.R4_CDP||'http://127.0.0.1:9622';
const browser=await chromium.connectOverCDP(endpoint);
const pages=browser.contexts().flatMap(c=>c.pages()),page=pages.find(p=>/scribyra/i.test(p.url()))||pages[0];page.setDefaultTimeout(60000);
const source=page.getByRole('textbox',{name:'LaTeX source',exact:true});
const status=()=>page.getByRole('status',{name:'Compilation status'}).innerText();
async function openFile(path){await page.getByRole('treeitem',{name:path,exact:true}).click();await page.getByRole('tab',{name:path.split('/').pop(),selected:true}).waitFor();await page.waitForTimeout(300);}
// The editor's own view, as a person's typing would reach it (a user input transaction).
const editorText=()=>page.evaluate(()=>document.querySelector('.cm-content').cmTile.view.state.doc.toString());
const editorReplace=(from,to)=>page.evaluate(([from,to])=>{const v=document.querySelector('.cm-content').cmTile.view,at=v.state.doc.toString().indexOf(from);if(at<0)throw Error('not found: '+from);v.dispatch({changes:{from:at,to:at+from.length,insert:to},userEvent:'input.type'});return at;},[from,to]);
try{
 switch(cmd){
  case 'open':{
   if(await page.getByRole('button',{name:'All projects',exact:true}).isVisible().catch(()=>false))await page.getByRole('button',{name:'All projects',exact:true}).click();
   await page.locator('article').filter({has:page.getByRole('heading',{name:args[0]})}).getByRole('button').first().click();await source.waitFor();console.log(await page.title());break;}
  case 'compile':{
   const before=await status();await page.getByRole('button',{name:'Compile',exact:true}).click();await page.waitForTimeout(1000);
   for(let i=0;i<500;i++){const s=await status();if(s!==before&&/^(Compiled|Failed|Compilation|Error|Could)/i.test(s.trim())||i>5&&/^(Compiled|Failed|Error)/i.test(s.trim())&&!/ing\b/.test(s)){console.log(s);break;}await page.waitForTimeout(1000);}break;}
  case 'read':{
   const items=await page.getByRole('treeitem').evaluateAll(n=>n.map(e=>e.getAttribute('aria-label')||e.textContent));
   for(const p of items.filter(p=>/\.(tex|bib)$/.test(p))){await openFile(p);console.log(`=== ${p}\n${await editorText()}`);}break;}
  case 'mode':await page.getByRole('combobox',{name:'Editor mode'}).selectOption(args[0]);console.log(args[0]);break;
  case 'history':{await page.getByRole('button',{name:'History',exact:true}).click();await page.waitForTimeout(1500);console.log(await page.locator('body').ariaSnapshot());break;}
  case 'snapshot':console.log(page.url(),await page.title());console.log(await page.locator('body').ariaSnapshot());break;
  case 'type':{await openFile(args[0]);await source.click();await page.keyboard.press('Control+End');await page.keyboard.type('\n'+args.slice(1).join(' '),{delay:40});console.log('typed');break;}
  case 'replace':{await openFile(args[0]);console.log('replaced at',await editorReplace(args[1],args[2]));await page.waitForTimeout(1500);break;}
  // Types a numbered comment line at the end of a file every few seconds, as a person working alongside the agent.
  case 'keep-typing':{const [file,count,every]=[args[0],Number(args[1]||10),Number(args[2]||15000)];
   for(let i=1;i<=count;i++){await openFile(file);await source.click();await page.keyboard.press('Control+End');await page.keyboard.type(`\n% person note ${i}`,{delay:60});console.log(new Date().toISOString(),'typed',i);await page.waitForTimeout(every);}break;}
  // The person's approval: accept each open suggestion in the review panel.
  case 'accept':{const items=page.getByRole('article',{name:'Suggestion'});const n=await items.count();for(let i=0;i<n;i++){console.log('accepting:',await items.first().getByRole('button').first().innerText());await items.first().getByRole('button',{name:'Accept',exact:true}).click();await page.waitForTimeout(1000);}console.log('accepted',n);break;}
  case 'reload':await page.reload();await page.waitForTimeout(3000);console.log(await page.title());break;
  default:throw Error('unknown command '+cmd);
 }
}finally{await browser.close();}
