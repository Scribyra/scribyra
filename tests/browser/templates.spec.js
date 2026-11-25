// Templates, Overleaf import and the first-run welcome (docs/templates.md), in every engine.
import {test,expect} from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import {zipSync,strToU8} from 'fflate';
import {mkdirSync} from 'node:fs';
import {readFile} from 'node:fs/promises';
import {createServer} from 'node:http';
import {resolve,extname,sep} from 'node:path';

const SHOTS=resolve('docs/screenshots/templates');
const shot=async(page,name,info,options={})=>{if(info.project.name!=='chromium')return;mkdirSync(SHOTS,{recursive:true});await page.screenshot({path:resolve(SHOTS,`${name}.png`),...options});};
async function audit(page,scope){const result=await new AxeBuilder({page}).include(scope).withTags(['wcag2a','wcag2aa','wcag21a','wcag21aa']).analyze();expect(result.violations.map(v=>({id:v.id,nodes:v.nodes.map(n=>n.target)}))).toEqual([]);}
const welcome=page=>page.getByRole('region',{name:'How would you like to begin?'});
const gallery=page=>page.getByRole('dialog',{name:'New project'});
// Choose a card the way a person does: click it (the radio inside follows).
async function pick(dialog,name){const radio=dialog.getByRole('radio',{name,exact:true});await radio.locator('xpath=ancestor::label[contains(@class,"template-card")]').click();await expect(radio).toBeChecked();}
async function compile(page){
 await page.evaluate(()=>window.scribyra.lastCompile=null);await page.getByRole('button',{name:'Compile',exact:true}).click();
 await expect.poll(()=>page.evaluate(()=>window.scribyra.lastCompile),{timeout:300000}).toBeTruthy();
 return page.evaluate(()=>window.scribyra.lastCompile);
}
async function importZip(page,name,files){
 const chooser=page.waitForEvent('filechooser');await page.getByRole('button',{name:'Import ZIP',exact:true}).click();
 await(await chooser).setFiles({name,mimeType:'application/zip',buffer:Buffer.from(zipSync(Object.fromEntries(Object.entries(files).map(([path,content])=>[path,typeof content==='string'?strToU8(content):content]))))});
}
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==','base64');

for(const theme of ['light','dark'])test(`${theme}: the welcome shows on a first visit, is accessible, and a dismissal is remembered`,async({page,context},info)=>{
 await context.addInitScript(theme=>{if(!sessionStorage.getItem('set')){localStorage.setItem('scribyra-theme',theme);sessionStorage.setItem('set','1');}},theme);
 await page.goto('/');await expect(welcome(page)).toBeVisible();
 for(const name of ['Browse templates','Import a ZIP','From a Git link','Coming from Overleaf?','Start with a sample paper'])await expect(welcome(page).getByRole('button',{name,exact:true})).toBeVisible();
 await expect(welcome(page).getByRole('note',{name:'Tips'})).toContainText(/Ctrl \+ Enter|⌘ \+ Enter/);
 await expect(welcome(page).getByRole('link',{name:'agent.md',exact:true})).toHaveAttribute('href','agent.md');
 // One sample button, one New project, one Import ZIP: the welcome replaces the banner, it does not repeat it.
 await expect(page.getByRole('button',{name:'Start with a sample paper'})).toHaveCount(1);
 await expect(page.getByRole('button',{name:'New project',exact:true})).toHaveCount(1);
 // Not a dialog: nothing takes focus, nothing is modal.
 await expect(page.getByRole('dialog')).toHaveCount(0);expect(await page.evaluate(()=>document.activeElement===document.body)).toBe(true);
 await audit(page,'.welcome-card');
 await shot(page,`welcome-${theme}`,info);
 await page.setViewportSize({width:390,height:844});
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
 await shot(page,`welcome-phone-${theme}`,info,{fullPage:true});
 await page.setViewportSize({width:1440,height:1000});
 await welcome(page).getByRole('button',{name:'Dismiss welcome',exact:true}).click();
 await expect(welcome(page)).toHaveCount(0);await expect(page.getByRole('button',{name:'New project',exact:true})).toBeFocused();
 await expect(page.getByRole('button',{name:'Start with a sample paper'})).toBeVisible();
 await expect(page.getByRole('button',{name:'Coming from Overleaf?',exact:true})).toBeVisible();
 await page.reload();await expect(page.getByRole('button',{name:'Start with a sample paper'})).toBeVisible();await expect(welcome(page)).toHaveCount(0);
});

test('starting a first project ends the welcome; a browser with projects never sees it',async({page})=>{
 await page.goto('/');await expect(welcome(page)).toBeVisible();
 await page.getByRole('button',{name:'Start with a sample paper'}).click();await expect(page.locator('.cm-content')).toBeVisible();
 expect(await page.evaluate(()=>localStorage.getItem('scribyra:welcome:v1'))).toBe('started');
 await page.goto('/');await expect(page.getByRole('button',{name:/A space for your next great idea.*file/})).toBeVisible();await expect(welcome(page)).toHaveCount(0);
 await page.evaluate(()=>localStorage.removeItem('scribyra:welcome:v1'));await page.reload();
 await expect(page.getByRole('button',{name:/A space for your next great idea.*file/})).toBeVisible();await expect(welcome(page)).toHaveCount(0);
 expect(await page.evaluate(()=>localStorage.getItem('scribyra:welcome:v1'))).toBe('started');
});

for(const theme of ['light','dark'])test(`${theme}: the gallery searches, filters by category and is accessible`,async({page,context},info)=>{
 await context.addInitScript(theme=>localStorage.setItem('scribyra-theme',theme),theme);
 await page.goto('/');await page.getByRole('button',{name:'New project',exact:true}).click();
 const dialog=gallery(page);await expect(dialog).toBeVisible();
 const radios=dialog.getByRole('radio');await expect(radios).toHaveCount(13);
 await expect(dialog.getByRole('radio',{name:'Sample paper',exact:true})).toBeChecked();
 await expect(dialog.getByLabel('Project name',{exact:true})).toHaveValue('A space for your next great idea');
 await expect(dialog.locator('.template-preview img').first()).toHaveJSProperty('complete',true);
 expect(await dialog.locator('.template-preview img').evaluateAll(images=>images.filter(image=>image.complete&&image.naturalWidth===480).length)).toBeGreaterThan(0);
 await audit(page,'.template-gallery');
 await shot(page,`gallery-${theme}`,info);
 await dialog.getByRole('searchbox',{name:'Search templates'}).fill('résumé');
 await expect(radios).toHaveCount(1);await expect(dialog.getByRole('radio',{name:'CV / résumé',exact:true})).toBeVisible();
 await dialog.getByRole('searchbox',{name:'Search templates'}).fill('nothing like this');
 await expect(radios).toHaveCount(0);await expect(dialog.getByRole('status')).toHaveText('No templates match “nothing like this”.');
 await dialog.getByRole('searchbox',{name:'Search templates'}).fill('');
 await dialog.getByRole('group',{name:'Categories'}).getByRole('button',{name:'Slides and posters',exact:true}).click();
 await expect(dialog.getByRole('group',{name:'Categories'}).getByRole('button',{name:'Slides and posters',exact:true})).toHaveAttribute('aria-pressed','true');
 await expect(radios).toHaveCount(2);await pick(dialog,'Conference poster');
 await expect(dialog.getByLabel('Project name',{exact:true})).toHaveValue('Conference poster');
 // Keyboard: arrows move between visible templates and the name follows until typed.
 await dialog.getByRole('radio',{name:'Conference poster',exact:true}).focus();await page.keyboard.press('ArrowLeft');
 await expect(dialog.getByRole('radio',{name:'Beamer presentation',exact:true})).toBeChecked();await expect(dialog.getByLabel('Project name',{exact:true})).toHaveValue('Beamer presentation');
 await page.setViewportSize({width:390,height:844});
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
 const box=await dialog.boundingBox();expect(box.width).toBeLessThanOrEqual(390);
 await shot(page,`gallery-phone-${theme}`,info);
 await page.keyboard.press('Escape');await expect(dialog).toHaveCount(0);
 await expect(page.getByRole('button',{name:'New project',exact:true})).toBeFocused();
 await expect(page.locator('.project-card')).toHaveCount(0);
});

test('creating from a template: its files, main file and a clean compile',async({page})=>{
 await page.goto('/');await page.getByRole('button',{name:'Browse templates',exact:true}).click();
 const dialog=gallery(page);await dialog.getByRole('searchbox',{name:'Search templates'}).fill('thesis');
 await pick(dialog,'Thesis');
 await dialog.getByLabel('Project name',{exact:true}).fill('My thesis');
 await dialog.getByRole('button',{name:'Create project',exact:true}).click();
 await expect(page).toHaveTitle('My thesis — Scribyra');await expect(page.locator('.cm-content')).toContainText('Thesis / dissertation.');
 const tree=page.getByRole('tree',{name:'Project files',exact:true});
 // The tree owns its rows through aria-owns, so the rows are found on the page and checked against the tree's snapshot.
 for(const name of ['main.tex','references.bib','chapters','frontmatter','appendices'])await expect(page.getByRole('treeitem',{name,exact:true})).toBeVisible();
 const outline=await tree.ariaSnapshot();for(const name of ['main.tex','references.bib','chapters','frontmatter','appendices'])expect(outline).toContain(`treeitem "${name}"`);
 const files=await page.evaluate(()=>({main:window.scribyra.agent.status().value.mainFile,items:window.scribyra.agent.readTree({limit:100}).value.items}));
 const paths=files.items.map(entry=>entry.path);
 for(const path of ['chapters/introduction.tex','chapters/method.tex','frontmatter/abstract.tex','appendices/appendix-a.tex','references.bib'])expect(paths).toContain(path);
 expect(files.items.find(entry=>entry.path==='main.tex').id).toBe(files.main);
 // A quick one compiles in every engine: homework (no bibliography run).
 await page.goto('/');await page.getByRole('button',{name:'New project',exact:true}).click();
 await pick(gallery(page),'Homework / problem set');
 await gallery(page).getByRole('button',{name:'Create project',exact:true}).click();
 await expect(page).toHaveTitle('Homework — Scribyra');
 const result=await compile(page);expect(result.success,result.log).toBe(true);
 expect(result.report.issues.filter(issue=>issue.severity==='error')).toEqual([]);expect(result.report.warningCount).toBe(0);
 await expect(page.locator('#pdf-viewer canvas').first()).toBeVisible();
});

test('a #template= link selects the template, explains itself and creates nothing until asked',async({page})=>{
 await page.goto('/#template=cv');const dialog=gallery(page);await expect(dialog).toBeVisible();
 expect(new URL(page.url()).hash).toBe('');
 await expect(dialog.getByRole('radio',{name:'CV / résumé',exact:true})).toBeChecked();await expect(dialog.getByRole('radio',{name:'CV / résumé',exact:true})).toBeFocused();
 await expect(dialog.getByRole('note')).toHaveText('A link suggested the CV / résumé template. Nothing is created until you choose Create project.');
 await expect(dialog.getByLabel('Project name',{exact:true})).toHaveValue('CV');
 await dialog.getByRole('button',{name:'Cancel',exact:true}).click();await expect(dialog).toHaveCount(0);await expect(page.locator('.project-card')).toHaveCount(0);
 await page.goto('/#template=not-a-template');await expect(gallery(page)).toBeVisible();await expect(page.getByRole('status',{name:'Workspace notification'})).toContainText('not in this version');
 await gallery(page).getByRole('button',{name:'Close templates',exact:true}).click();
 await page.goto('/#template=%3Cx%3E');await expect(page.getByRole('status',{name:'Workspace notification'})).toContainText('This template link is damaged.');await expect(gallery(page)).toHaveCount(0);
});

test('an Overleaf ZIP: recognised, summarised with compiler advice, and a line opens from the summary',async({page},info)=>{
 await page.goto('/');
 await importZip(page,'overleaf-paper.zip',{
  'latexmkrc':'$pdf_mode = 1;\n',
  'paper.tex':'\\pdfoutput=1\n\\documentclass{article}\n\\usepackage[utf8]{inputenc}\n\\usepackage{graphicx}\n\\usepackage[backend=biber]{biblatex}\n\\addbibresource{refs.bib}\n\\begin{document}\nHello \\cite{k}.\\includegraphics{figures/dot}\n\\printbibliography\n\\end{document}\n',
  'refs.bib':'@book{k,author={Knuth, Donald},title={The TeXbook},year={1984}}','figures/dot.png':png});
 const summary=page.getByRole('dialog',{name:'Imported from Overleaf'});await expect(summary).toBeVisible();
 await expect(summary).toContainText('Recognised by latexmkrc');
 await expect(summary.locator('.import-facts')).toContainText('paper.tex');
 await expect(summary.locator('.import-facts')).toContainText('Written for pdfLaTeX (from latexmkrc). Scribyra compiles with LuaLaTeX; the changes below make it compile.');
 await expect(summary.locator('.import-facts')).toContainText('4 files: 1 .tex file, 1 image, 1 bibliography file');
 await expect(summary.locator('.import-facts')).toContainText('processed with Biber');
 const list=summary.getByRole('list',{name:'What to check'});
 await expect(list.getByRole('listitem')).toHaveCount(2);
 await expect(list.getByRole('listitem').first()).toContainText('Needs a change');await expect(list.getByRole('listitem').first()).toContainText('\\pdfoutput is a pdfTeX command that LuaLaTeX does not have.');
 await expect(list.getByRole('listitem').nth(1)).toContainText('LuaLaTeX ignores it');
 await audit(page,'.import-summary');
 await shot(page,'overleaf-summary',info);
 await summary.getByRole('button',{name:'Open paper.tex, line 1',exact:true}).click();
 await expect(summary).toHaveCount(0);await expect(page).toHaveTitle('overleaf-paper — Scribyra');
 await expect(page.locator('.cm-activeLine')).toContainText('\\pdfoutput=1');
 const files=await page.evaluate(()=>({main:window.scribyra.agent.status().value.mainFile,items:window.scribyra.agent.readTree().value.items}));
 expect(files.items.find(entry=>entry.path==='paper.tex').id,'latexmkrc names no file, so the root document is the main file').toBe(files.main);
});

test('a clean Overleaf ZIP compiles from the summary; a plain ZIP imports without one',async({page})=>{
 await page.goto('/');
 await importZip(page,'plain.zip',{'main.tex':'\\documentclass{article}\\begin{document}Plain.\\end{document}'});
 await expect(page.locator('.cm-content')).toBeVisible();await expect(page.getByRole('dialog')).toHaveCount(0);
 await page.goto('/');
 await importZip(page,'thesis-download.zip',{'main.tex':'% Uploaded from Overleaf\n\\documentclass{article}\n\\usepackage[utf8]{inputenc}\n\\begin{document}\nFrom elsewhere.\n\\end{document}\n'});
 const summary=page.getByRole('dialog',{name:'Imported from Overleaf'});await expect(summary).toBeVisible();
 await expect(summary.locator('.import-facts')).toContainText('most projects compile unchanged');
 await page.evaluate(()=>window.scribyra.lastCompile=null);
 await summary.getByRole('button',{name:'Compile now',exact:true}).click();await expect(summary).toHaveCount(0);
 await expect.poll(()=>page.evaluate(()=>window.scribyra.lastCompile),{timeout:300000}).toBeTruthy();
 expect(await page.evaluate(()=>window.scribyra.lastCompile.success)).toBe(true);
});

test('the Git link and the Overleaf guide both start from the welcome',async({page},info)=>{
 await page.goto('/');
 const origin=new URL(page.url()).origin,requests=[];page.on('request',request=>{if(!request.url().startsWith(origin))requests.push(request.url());});
 await welcome(page).getByRole('button',{name:'From a Git link',exact:true}).click();
 const ask=page.getByRole('dialog',{name:'Open from a Git link'});await expect(ask).toBeVisible();
 await expect(ask.getByLabel('Repository or ZIP address',{exact:true})).toBeFocused();
 await ask.getByLabel('Repository or ZIP address',{exact:true}).fill('http://example.org/x');await ask.getByRole('button',{name:'Continue',exact:true}).click();
 await expect(ask.getByRole('status')).toHaveText('Use an https:// address.');
 await ask.getByLabel('Repository or ZIP address',{exact:true}).fill('https://github.com/octo/paper/tree/main/tex');await page.keyboard.press('Enter');
 const confirm=page.getByRole('dialog',{name:'Open a repository in Scribyra'});await expect(confirm).toBeVisible();
 await expect(confirm).toContainText('github.com/octo/paper@main / tex');
 await confirm.getByRole('button',{name:'Cancel',exact:true}).click();await expect(confirm).toHaveCount(0);
 expect(requests,'nothing is fetched before the person checks').toEqual([]);
 await welcome(page).getByRole('button',{name:'Coming from Overleaf?',exact:true}).click();
 const guide=page.getByRole('dialog',{name:'Coming from Overleaf?'});await expect(guide).toBeVisible();
 await expect(guide.getByRole('listitem')).toHaveCount(7);await expect(guide).toContainText('Download → Source');
 await expect(guide.getByRole('link',{name:'scribyra.com/coming-from-overleaf',exact:true})).toHaveAttribute('href','https://scribyra.com/coming-from-overleaf.html');
 await audit(page,'.overleaf-guide');await shot(page,'overleaf-guide',info);
 const chooser=page.waitForEvent('filechooser');await guide.getByRole('button',{name:'Import a ZIP',exact:true}).click();
 await(await chooser).setFiles({name:'from-guide.zip',mimeType:'application/zip',buffer:Buffer.from(zipSync({'main.tex':strToU8('\\documentclass{article}\\begin{document}Guide.\\end{document}')}))});
 await expect(page).toHaveTitle('from-guide — Scribyra');
});

// scribyra.com: /templates/ and the Overleaf guide, served as static files the way Pages serves site/.
async function serveSite(){
 const root=resolve('site'),types={'.html':'text/html','.css':'text/css','.js':'text/javascript','.png':'image/png','.svg':'image/svg+xml','.xml':'application/xml'};
 const server=createServer(async(request,response)=>{
  let path=resolve(root,'.'+decodeURIComponent(new URL(request.url,'http://localhost').pathname));
  if(path!==root&&!path.startsWith(root+sep)){response.writeHead(403).end();return;}
  if(request.url.endsWith('/'))path=resolve(path,'index.html');
  try{const body=await readFile(path);response.writeHead(200,{'Content-Type':types[extname(path)]||'application/octet-stream'});response.end(body);}catch{response.writeHead(404).end();}
 });
 await new Promise(done=>server.listen(0,'127.0.0.1',done));
 return {url:`http://127.0.0.1:${server.address().port}/`,close:()=>new Promise(done=>server.close(done))};
}
for(const scheme of ['light','dark'])test(`${scheme}: the site's templates page and Overleaf guide`,async({page},info)=>{
 const site=await serveSite();
 try{
  await page.emulateMedia({colorScheme:scheme});
  await page.goto(`${site.url}templates/`);
  await expect(page.getByRole('heading',{level:1})).toContainText('Start from a template.');
  const links=page.getByRole('main').getByRole('link',{name:/^Open .+ in Scribyra$/});await expect(links).toHaveCount(13);
  await expect(page.getByRole('link',{name:'Open Thesis in Scribyra',exact:true})).toHaveAttribute('href','https://app.scribyra.com/#template=thesis');
  const images=page.locator('main img');await expect(images).toHaveCount(13);
  for(const image of await images.all()){await image.scrollIntoViewIfNeeded();await expect(image).toHaveJSProperty('complete',true);expect(await image.evaluate(node=>node.naturalWidth)).toBe(480);}
  await page.evaluate(()=>scrollTo(0,0));
  const background=await page.evaluate(()=>getComputedStyle(document.body).backgroundColor);
  expect(background,'the page follows the colour scheme').toBe(scheme==='dark'?'rgb(23, 25, 32)':'rgb(252, 252, 254)');
  await audit(page,'main');
  await shot(page,`site-templates-${scheme}`,info,{fullPage:true});
  await page.setViewportSize({width:390,height:844});
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await shot(page,`site-templates-${scheme}-phone`,info);
  await page.setViewportSize({width:1440,height:1000});
  await page.getByRole('navigation',{name:'Main navigation'}).getByRole('link',{name:'Coming from Overleaf?',exact:true}).click();
  await expect(page.getByRole('heading',{level:1})).toHaveText('Coming from Overleaf?');
  await expect(page.getByRole('main')).toContainText('not affiliated with Overleaf');
  for(const name of ['Step by step','pdfLaTeX, XeLaTeX and LuaLaTeX'])await expect(page.getByRole('heading',{name,exact:true})).toBeVisible();
  await expect(page.locator('main img'),'a factual guide: no screenshots or logos').toHaveCount(0);
  await audit(page,'main');
  await shot(page,`site-overleaf-guide-${scheme}`,info,{fullPage:true});
 }finally{await site.close();}
});
