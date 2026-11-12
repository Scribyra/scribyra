// Scoped S1–S7-style reads, without MCP framing or a model. Run against our preview.
import {chromium} from '@playwright/test';
import {mkdir,writeFile} from 'node:fs/promises';
const output=process.argv[2]||'tmp/agent-surface';
await mkdir(output,{recursive:true});
const browser=await chromium.launch({executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,args:['--no-sandbox']});
const rows=[];
try{
 for(const fixture of ['article','missing-package','thesis']){
  const context=await browser.newContext({viewport:{width:1440,height:1000}}),page=await context.newPage();
  try{
   await page.goto('http://127.0.0.1:4173');const chooser=page.waitForEvent('filechooser');await page.getByRole('button',{name:'Import ZIP',exact:true}).click();await(await chooser).setFiles(`public/fixtures/${fixture}.zip`);await page.locator('.cm-content').waitFor();
   const read=async(step,locator)=>{const text=await locator.ariaSnapshot({mode:'ai'});rows.push({fixture,step,bytes:Buffer.byteLength(text)});await writeFile(`${output}/${fixture}-${step}.txt`,text);};
   const compile=async()=>{await page.evaluate(()=>{window.scribyra.lastCompile=null;});await page.getByRole('button',{name:/^Compile(?: |$)/}).click();await page.waitForFunction(()=>window.scribyra.lastCompile,{},{timeout:180000});return page.evaluate(()=>window.scribyra.lastCompile);};
   await read('S1',page.getByRole('tablist',{name:'Open files'}));
   const result=await compile();await read('S2',page.locator('.compile-button'));await read('S3',page.locator('.editor-status'));
   await writeFile(`${output}/${fixture}.log`,result.log);await writeFile(`${output}/${fixture}.json`,JSON.stringify({success:result.success,report:result.report,logs:result.logs},null,2));
   const issues=page.getByRole('list',{name:'Compilation issues'});if(await issues.count())await read('S4',issues);else rows.push({fixture,step:'S4',bytes:0});
   if(fixture==='thesis')await page.getByRole('treeitem',{name:'chapters/page-050.tex',exact:true}).click();
   await read('S5',page.getByRole('textbox',{name:'LaTeX source',exact:true}));
   const source=page.locator('.cm-content');await source.focus();await page.keyboard.press('Control+Home');
   if(fixture==='missing-package'){
    await page.keyboard.press('Control+a');await page.keyboard.insertText('\\documentclass{article}\\begin{document}Test\\end{document}');
   }else await page.keyboard.insertText(fixture==='thesis'?'\\undefinedcmd\n':'% measured edit\n');
   await read('S6',source);const next=await compile();await read('S7',page.locator('.editor-status'));
   await writeFile(`${output}/${fixture}-edited.log`,next.log);
   if(fixture==='thesis')await read('S8',page.getByRole('list',{name:'Compilation issues'}));
  }finally{await context.close();}
 }
}finally{await browser.close();}
await writeFile(`${output}/rows.json`,JSON.stringify(rows,null,2));
console.log(JSON.stringify(rows));
