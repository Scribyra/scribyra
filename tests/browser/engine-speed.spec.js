// The engine improvements of November 21, 2026 in the browser (docs/compile-engines.md): passes
// as latexmk decides them, packages installed before the first pass and remembered per project
// on this device, and the raised memory ceiling with its clear message.
import {test,expect} from '@playwright/test';
import {zipSync,strToU8} from 'fflate';
test.use({actionTimeout:15000});

async function importSource(page,files,name){
 await page.goto('/');await page.evaluate(()=>navigator.serviceWorker?.ready);
 const chooser=page.waitForEvent('filechooser');await page.getByRole('button',{name:'Import ZIP',exact:true}).click();
 await(await chooser).setFiles({name:`${name}.zip`,mimeType:'application/zip',buffer:Buffer.from(zipSync(Object.fromEntries(Object.entries(files).map(([path,text])=>[`${name}/${path}`,strToU8(text)]))))});
 await expect(page.locator('.cm-content')).toBeVisible({timeout:60000});
 await expect(page.locator('.save-indicator')).toHaveText('Saved locally',{timeout:60000});
}
async function compile(page){
 await page.evaluate(()=>{window.scribyra.lastCompile=null;});
 await page.getByRole('button',{name:'Compile',exact:true}).click();
 await page.waitForFunction(()=>!!window.scribyra.lastCompile,null,{timeout:600000,polling:250});
 const result=await page.evaluate(()=>{const r=window.scribyra.lastCompile;return{success:r.success,passes:r.passes,engineMemoryBytes:r.engineMemoryBytes,diagnostic:r.diagnostic,packages:(r.packages||[]).map(p=>p.name),log:String(r.log)};});
 await expect(page.getByRole('button',{name:'Compile',exact:true})).toHaveAttribute('data-state','idle',{timeout:60000});
 return result;
}

test('the sample paper compiles in two LuaLaTeX passes',async({page})=>{
 test.setTimeout(600000);
 await page.goto('/');await page.getByRole('button',{name:'Start with a sample paper'}).click();
 await expect(page.locator('.cm-content')).toBeVisible();
 const result=await compile(page);
 expect(result.success,result.log.slice(0,3000)).toBe(true);expect(result.passes).toBe(2);
});

test('a package found by a failing pass is installed before the first pass after the project reopens',async({page})=>{
 test.setTimeout(900000);
 // Named through a macro, so the source scan cannot see it: the first compile discovers it.
 await importSource(page,{'main.tex':'\\documentclass{article}\\def\\tablepackage{booktabs}\\usepackage{\\tablepackage}\\begin{document}\\begin{tabular}{ll}\\toprule a&b\\\\\\bottomrule\\end{tabular}\\end{document}\n'},'remembered');
 const first=await compile(page);
 expect(first.success,first.log.slice(0,3000)).toBe(true);expect(first.passes).toBe(3);expect(first.packages).toEqual(['dist--booktabs']);
 // A new compiler (reload) starts from what this project needed last time.
 await page.reload();await page.getByRole('button',{name:/ remembered \d+ files?/}).first().click();
 await expect(page.locator('.cm-content')).toBeVisible();
 const again=await compile(page);
 expect(again.success,again.log.slice(0,3000)).toBe(true);expect(again.passes).toBe(2);expect(again.packages).toEqual(['dist--booktabs']);
 // Installed before the first pass from this device's package cache: no failing pass looked for it.
 expect(again.log).toMatch(/TeX packages installed for this compile:\nbooktabs · bundled component · cache\n/);
 expect(again.log.match(/^\$ luahblatex /gm)).toHaveLength(2);
});

// Lua strings of one MiB each, kept until the end of the run.
const hold=count=>`\\documentclass{article}\n\\directlua{scribyra_big={} scribyra_n=0 for i=1,${count} do scribyra_n=i scribyra_big[i]=string.rep(string.char(65+math.fmod(i,26)),1048576) end}\n\\begin{document}Held \\directlua{tex.print(scribyra_n)} strings of one MiB.\\end{document}\n`;
test('a document that needs about 1 GiB compiles; one that needs more than 2 GiB says so clearly',async({page})=>{
 test.setTimeout(900000);
 await importSource(page,{'main.tex':hold(880)},'one-gib');
 const fits=await compile(page);
 expect(fits.success,fits.log.slice(0,3000)).toBe(true);
 expect(fits.engineMemoryBytes).toBeGreaterThan(1000*1048576);expect(fits.engineMemoryBytes).toBeLessThan(2048*1048576);
 await importSource(page,{'main.tex':hold(2400)},'too-big');
 const failed=await compile(page);
 expect(failed.success).toBe(false);
 expect(failed.diagnostic).toMatch(/^The document needs more memory than the TeX engine can use \(2047 MiB, the most this build of the engine can address\)\./);
 await expect(page.getByText(/needs more memory than the TeX engine can use/).first()).toBeVisible();
});
