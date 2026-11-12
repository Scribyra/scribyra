import {test,expect} from '@playwright/test';
import {zipSync,strToU8} from 'fflate';
test.use({actionTimeout:15000});
async function compile(page){await page.evaluate(()=>window.scribyra.lastCompile=null);await page.getByRole('button',{name:'Compile',exact:true}).click();await expect.poll(()=>page.evaluate(()=>window.scribyra.lastCompile),{timeout:180000}).toBeTruthy();return page.evaluate(()=>window.scribyra.lastCompile);}
async function importPaper(page,source){await page.goto('/');const chooser=page.waitForEvent('filechooser');await page.getByRole('button',{name:'Import ZIP',exact:true}).click();await(await chooser).setFiles({name:'runtime-components.zip',mimeType:'application/zip',buffer:Buffer.from(zipSync({'main.tex':strToU8(source)}))});await expect(page.locator('.cm-content')).toBeVisible();}
test('a baseline-only paper fetches the small metadata root and no package shards',async({page})=>{
 const requests=[];page.on('request',request=>requests.push(request.url()));
 await importPaper(page,String.raw`\documentclass{article}\begin{document}Core-only paper.\end{document}`);
 const result=await compile(page);expect(result.success,result.log).toBeTruthy();expect(result.packages).toEqual([]);
 expect(requests.some(url=>/\/tex-catalog\.[a-f0-9]{64}\.json$/.test(url))).toBeTruthy();
 expect(requests.some(url=>/\/metadata\//.test(url))).toBeFalsy();expect(requests.some(url=>/lualatex-components|tex-catalog\.json.*\.gz/.test(url))).toBeFalsy();
});
test('small baseline, static components and complete offline compiler preparation',async({page,context})=>{
 const requests=[];page.on('request',request=>requests.push(request.url()));
 await importPaper(page,String.raw`\documentclass{article}
\usepackage{xcolor}
\usepackage{caption}
\begin{document}\textcolor{blue}{Optional distribution components.}\end{document}`);
 const online=await compile(page);expect(online.success,online.log).toBeTruthy();expect(online.packages.some(pkg=>pkg.origin==='distribution')).toBeTruthy();expect(online.packages.some(pkg=>pkg.name==='dist--xcolor')).toBeTruthy();
 expect(requests.some(url=>/texlive-(extra|basic|recommended)\.data/.test(url))).toBeFalsy();expect(requests.some(url=>/texlive-lualatex\.[a-f0-9]+\.data/.test(url))).toBeTruthy();
 await expect(page.locator('.save-indicator')).toHaveText('Saved locally');await page.getByRole('button',{name:'More tools',exact:true}).click();await page.getByRole('button',{name:'TeX environment',exact:true}).click();const dialog=page.getByRole('dialog',{name:'TeX environment',exact:true});await dialog.getByRole('button',{name:'Prepare this project for offline use',exact:true}).click();await expect(dialog.getByText('Verified offline for this locked environment.',{exact:true})).toBeVisible({timeout:120000});await dialog.getByRole('button',{name:'Close',exact:true}).click();await expect(page.locator('.save-indicator')).toHaveText('Saved locally');
 await context.setOffline(true);await page.reload();await page.getByRole('button',{name:/runtime-components.*files?/}).click();const offline=await compile(page);expect(offline.success,offline.log).toBeTruthy();expect(offline.packages.every(pkg=>pkg.cached&&pkg.saved)).toBeTruthy();await page.getByRole('button',{name:'More tools',exact:true}).click();await page.getByRole('button',{name:'TeX environment',exact:true}).click();await expect(page.getByText('Verified offline for this locked environment.',{exact:true})).toBeVisible({timeout:60000});await context.setOffline(false);
});
test('missing OpenType families download from indexed font metadata',async({page})=>{
 await importPaper(page,String.raw`\documentclass{article}
\usepackage{fontspec}
\setmainfont{TeX Gyre Pagella}
\begin{document}Downloaded family, with \textbf{bold} and \textit{italic} styles.\end{document}`);
 const result=await compile(page);expect(result.success,result.log).toBeTruthy();expect(result.packages.some(pkg=>pkg.name==='dist--fontspec')).toBeTruthy();expect(result.packages.some(pkg=>pkg.name.startsWith('dist--tex-gyre'))).toBeTruthy();await expect(page.locator('#pdf-viewer canvas').first()).toBeVisible();
});
test('offline inspection detects corrupt native cache entries and clearing preserves the project',async({page})=>{
 await importPaper(page,String.raw`\documentclass{article}\begin{document}Cache integrity check.\end{document}`);
 const result=await compile(page);expect(result.success,result.log).toBeTruthy();await expect(page.locator('.save-indicator')).toHaveText('Saved locally');
 await page.getByRole('button',{name:'More tools',exact:true}).click();await page.getByRole('button',{name:'TeX environment',exact:true}).click();const dialog=page.getByRole('dialog',{name:'TeX environment',exact:true});
 await dialog.getByRole('button',{name:'Prepare this project for offline use',exact:true}).click();await expect(dialog.getByText('Verified offline for this locked environment.',{exact:true})).toBeVisible({timeout:120000});
 await page.evaluate(async()=>{const cache=await caches.open('scribyra-runtime-verified-v1'),keys=await cache.keys();if(!keys.length)throw new Error('No prepared runtime cache');await cache.put(keys[0],new Response('Corrupt cached compiler bytes'));});
 await dialog.getByRole('button',{name:'Check offline availability',exact:true}).click();await expect(dialog.getByText(/Offline preparation needed · 1 compiler assets need preparation/)).toBeVisible();
 await dialog.getByRole('button',{name:'Prepare this project for offline use',exact:true}).click();await expect(dialog.getByText('Verified offline for this locked environment.',{exact:true})).toBeVisible({timeout:120000});
 await dialog.getByRole('button',{name:'Clear compiler cache',exact:true}).click();await expect(dialog.getByRole('status')).toContainText('Compiler caches cleared.');
 await dialog.getByRole('button',{name:'Check offline availability',exact:true}).click();await expect(dialog.getByText(/Offline preparation needed/)).toBeVisible();await dialog.getByRole('button',{name:'Close',exact:true}).click();await expect(page.locator('.cm-content')).toContainText('Cache integrity check');
 const after=await compile(page);expect(after.success,after.log).toBeTruthy();
});
