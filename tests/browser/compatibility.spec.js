import {romanianPackage} from './package-fixtures.js';
import '../helpers/core.mjs';
import {test,expect} from '@playwright/test';
import {zipSync,strToU8,unzipSync} from 'fflate';
import {readFile} from 'node:fs/promises';
import {TexCatalog} from '../../web/pkg/scribyra_app.js';
const article=String.raw`\documentclass{article}\begin{document}A previous verified PDF.\end{document}`;
async function load(page,name,files){await page.goto('/');const chooser=page.waitForEvent('filechooser');await page.getByRole('button',{name:'Import ZIP',exact:true}).click();await(await chooser).setFiles({name:name+'.zip',mimeType:'application/zip',buffer:Buffer.from(zipSync(Object.fromEntries(Object.entries(files).map(([path,body])=>[path,typeof body==='string'?strToU8(body):body]))))});await expect(page.locator('.cm-content')).toBeVisible();}
async function compile(page){await page.evaluate(()=>window.scribyra.lastCompile=null);await page.getByRole('button',{name:'Compile',exact:true}).click();await expect.poll(()=>page.evaluate(()=>window.scribyra.lastCompile),{timeout:180000}).toBeTruthy();return page.evaluate(()=>window.scribyra.lastCompile);}
async function download(page,name){const event=page.waitForEvent('download');await page.getByRole('button',{name,exact:true}).click();return new Uint8Array(await readFile(await(await event).path()));}
test('multilingual class-loaded packages and fonts compile with nested mixed-case main names and remain usable offline',async({page,context})=>{
 await romanianPackage(page);
 const main=String.raw`\documentclass{Local}
\begin{document}\selectlanguage{french}Bonjour.\selectlanguage{ngerman}Guten Tag.\selectlanguage{romanian}Știință și învățământ.\selectlanguage{greek}Ελληνικά.\selectlanguage{russian}Привет.\end{document}`;
 const cls=String.raw`\ProvidesClass{Local}\LoadClass{article}\RequirePackage{fontspec}\setmainfont{Linux Libertine O}\RequirePackage[english,romanian,french,ngerman,greek,russian]{babel}`;
 await load(page,'multilingual-compatibility',{'paper/main.tex.v2.TEX':main,'paper/Local.cls':cls});await expect(page.getByLabel('Main document',{exact:true}).locator('option')).toContainText('paper/main.tex.v2.TEX');const online=await compile(page);expect(online.success,online.log).toBeTruthy();expect(online.report.issues.some(i=>i.code==='project-package'&&i.file==='paper/Local.cls')).toBeTruthy();expect(online.report.issues.some(i=>i.code==='missing-glyphs')).toBeFalsy();for(const name of ['babel-french','babel-german','babel-greek','babel-russian'])expect(online.packages.some(p=>p.name===name&&p.archive)).toBeTruthy();
 await expect(page.locator('.save-indicator')).toHaveText('Saved locally');await page.getByRole('button',{name:'More tools',exact:true}).click();await page.getByRole('button',{name:'TeX environment',exact:true}).click();const dialog=page.getByRole('dialog',{name:'TeX environment',exact:true});await dialog.getByRole('button',{name:'Prepare this project for offline use',exact:true}).click();await expect(dialog.getByText('Verified offline for this locked environment.',{exact:true})).toBeVisible({timeout:120000});await dialog.getByRole('button',{name:'Close',exact:true}).click();await expect(page.locator('.save-indicator')).toHaveText('Saved locally');await context.setOffline(true);await page.reload();await page.getByRole('button',{name:/multilingual-compatibility.*files?/}).click();const offline=await compile(page);expect(offline.success,offline.log).toBeTruthy();expect(offline.packages.every(p=>p.cached&&p.saved)).toBeTruthy();await context.setOffline(false);
});
test('project package and OTF files take precedence without altering source exports',async({page})=>{
 const root='public/core/busytex/',manifest=JSON.parse(await readFile(root+'lualatex-manifest.json')),index=JSON.parse(await readFile(root+manifest.components.path));const[name,pkg]=Object.entries(index.packages).find(([,p])=>p.files.some(f=>f.endsWith('texgyrepagella-regular.otf'))),catalog=new TexCatalog(JSON.stringify({snapshot:'test',packages:{[name]:pkg}}));let font;
 try{font=catalog.unpack(name,new Uint8Array(await readFile(root+'components/'+pkg.sha512+'.tar.xz'))).find(([path])=>path.endsWith('texgyrepagella-regular.otf'))[1];}finally{catalog.free();}
 const files={'main.tex':String.raw`\documentclass{article}\usepackage{fontspec}\setmainfont[Path=fonts/]{LocalFont.otf}\usepackage{xcolor}\begin{document}\localproof\end{document}`,'xcolor.sty':String.raw`\ProvidesPackage{xcolor}[2026/01/01 project copy]\newcommand{\localproof}{Project font and package.}`,'fonts/LocalFont.otf':font};await load(page,'project-overrides',files);const result=await compile(page);expect(result.success,result.log).toBeTruthy();expect(result.report.issues.some(i=>i.code==='project-package'&&i.file==='xcolor.sty')).toBeTruthy();expect(result.packages.some(p=>p.name==='dist--xcolor'||p.name.startsWith('dist--tex-gyre'))).toBeFalsy();await page.locator('.compilation-status-button').click();await expect(page.getByRole('list',{name:'Compilation issues'})).toContainText('Project package loaded: xcolor.sty');
 const exported=unzipSync(await download(page,'Export'));for(const[path,body]of Object.entries(files))expect(exported[path]).toEqual(typeof body==='string'?strToU8(body):body);
});
test('missing fonts, unavailable external tools and project assets have distinct actionable reports',async({page})=>{
 const cases=[['font',String.raw`\documentclass{article}\usepackage{fontspec}\setmainfont{Scribyra Nonexistent Font}\begin{document}Hello.\end{document}`,'missing-font'],['tool',String.raw`\documentclass{article}\usepackage{minted}\begin{document}
\begin{minted}{python}
print('hello')
\end{minted}
\end{document}`,'external-tool'],['asset',String.raw`\documentclass{article}\usepackage{graphicx}\begin{document}\includegraphics{missing-project.png}\end{document}`,'missing-project-file']];
 for(const[name,source,code]of cases){await load(page,'diagnostic-'+name,{'main.tex':source});const result=await compile(page);expect(result.success).toBeFalsy();expect(result.report.issues[0].code,result.log).toBe(code);await expect(page.getByRole('list',{name:'Compilation issues'})).toContainText(result.report.issues[0].action);}
});
test('the compilation deadline is distinct from manual cancellation and preserves the previous PDF and source',async({page})=>{
 await load(page,'deadline-compatibility',{'main.tex':article});const first=await compile(page);expect(first.success,first.log).toBeTruthy();const before=await download(page,'Download PDF');await page.locator('.cm-content').click();await page.keyboard.press('Control+Home');await page.keyboard.insertText('\\loop\\iftrue\\repeat\n');await expect(page.locator('.save-indicator')).toHaveText('Saved locally');await page.clock.install();await page.evaluate(()=>window.scribyra.lastCompile=null);await page.getByRole('button',{name:'Compile',exact:true}).click();await expect(page.locator('.editor-status')).toContainText('Compiling on your device');await page.clock.fastForward(180001);await page.waitForTimeout(500);expect(await page.evaluate(()=>window.scribyra.lastCompile)).toBeNull();await expect(page.locator('.editor-status')).toContainText('Compiling');await page.clock.fastForward(420000);await page.clock.resume();await expect.poll(()=>page.evaluate(()=>window.scribyra.lastCompile)).toBeTruthy();const failed=await page.evaluate(()=>window.scribyra.lastCompile);expect(failed.errorType).toBe('CompileTimeoutError');expect(failed.report.issues[0].code).toBe('compile-timeout');await expect(page.locator('.editor-status')).toContainText('Compilation timed out');expect(await download(page,'Download PDF')).toEqual(before);expect(new TextDecoder().decode(unzipSync(await download(page,'Export'))['main.tex'])).toContain('\\loop\\iftrue\\repeat');await page.locator('.cm-content').click();await page.keyboard.press('Control+z');await expect(page.locator('.cm-content')).not.toContainText('\\loop\\iftrue\\repeat');expect((await compile(page)).success).toBeTruthy();
});
test('Biber preserves nested mixed-case bibliography paths and distinct files with the same basename',async({page})=>{
 const source=String.raw`\documentclass{article}
\usepackage[backend=biber]{biblatex}
\addbibresource{../refs/Refs.BIB}
\addbibresource{data/Refs.BIB}
\begin{document}\cite{alpha,beta}\printbibliography\end{document}`;
 await load(page,'nested-bibliography',{'paper/draft.tex.v2.TEX':source,'refs/Refs.BIB':'@book{alpha,author={Alice Author},title={First distinct bibliography},year={2025}}','paper/data/Refs.BIB':'@book{beta,author={Bob Writer},title={Second distinct bibliography},year={2026}}'});
 const result=await compile(page);expect(result.success,result.log).toBeTruthy();expect(result.log).not.toMatch(/ERROR -|Cannot find .*Refs/);expect(result.log).toMatch(/\$ biber [^\n]+\nEXITCODE: 0/);
 await expect(page.locator('.textLayer')).toContainText('First distinct bibliography');await expect(page.locator('.textLayer')).toContainText('Second distinct bibliography');
});
test('a project font-path error stops repeated package resolution after the known family is installed',async({page})=>{
 const requests=[];page.on('request',request=>{if(request.url().includes('/components/'))requests.push(request.url());});
 await load(page,'unresolved-project-font-path',{'main.tex':String.raw`\documentclass{article}\usepackage{fontspec}\setmainfont[Path=missing-project-fonts/]{TeX Gyre Pagella}\begin{document}A deliberate project font-path error.\end{document}`});
 const result=await compile(page);expect(result.success).toBeFalsy();expect(result.report.issues.some(issue=>issue.code==='resolution-stalled'),result.log).toBeTruthy();expect(result.packages.some(pkg=>pkg.name.startsWith('dist--tex-gyre'))).toBeTruthy();expect(new Set(result.packages.map(pkg=>pkg.name)).size).toBe(result.packages.length);
 for(const pkg of result.packages)if(pkg.origin==='distribution')expect(requests.filter(url=>url.endsWith('/'+pkg.sha512+'.tar.xz')).length).toBe(1);
 await expect(page.getByRole('list',{name:'Compilation issues'})).toContainText('Package resolution made no progress');
});

test('a real expl3 format-version failure preserves the previous PDF and never installs optional packages',async({page})=>{
 await load(page,'format-version-compatibility',{'main.tex':article});const first=await compile(page);expect(first.success,first.log).toBeTruthy();expect(first.log).toContain('This is LuaHBTeX, Version 1.24.0');const previous=await download(page,'Download PDF');
 const incompatible=String.raw`\ExplSyntaxOn\tl_gset:Nn\c__kernel_expl_date_tl{1900-01-01}\ExplSyntaxOff
\documentclass{article}\usepackage{expl3}\begin{document}A deliberate format-version mismatch.\end{document}`;
 const requests=[];page.on('request',request=>{if(/\/components\/|\/archive\//.test(request.url()))requests.push(request.url());});await page.locator('.cm-content').click();await page.keyboard.press('Control+a');await page.keyboard.insertText(incompatible);await expect(page.locator('.save-indicator')).toHaveText('Saved locally');
 const failed=await compile(page);expect(failed.success).toBeFalsy();expect(failed.report.issues[0].code,failed.log).toBe('format-mismatch');expect(failed.report.allowPackageResolution).toBeFalsy();expect(failed.packages).toEqual([]);expect(requests).toEqual([]);expect(await download(page,'Download PDF')).toEqual(previous);expect(new TextDecoder().decode(unzipSync(await download(page,'Export'))['main.tex'])).toBe(incompatible);
 await page.locator('.cm-content').click();await page.keyboard.press('Control+z');expect((await compile(page)).success).toBeTruthy();
 await page.getByRole('button',{name:'More tools',exact:true}).click();await page.getByRole('button',{name:'TeX environment',exact:true}).click();await page.getByText('Compiler and catalog identity',{exact:true}).click();const identity=page.getByRole('dialog',{name:'TeX environment',exact:true});await expect(identity).toContainText('LuaHBTeX 1.24.0');await expect(identity).toContainText('luahblatex');await expect(identity).toContainText('44f9a49a6443c582739a981340d4d2d9981a412a01ae1b0aeba36c3ada8e7ead');
});
