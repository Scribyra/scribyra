import {test,expect} from '@playwright/test';
import {zipSync,strToU8} from 'fflate';
import {mkdirSync,readFileSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import AxeBuilder from '@axe-core/playwright';
test.use({actionTimeout:15000});
test.setTimeout(120000);

// A 1×1 PNG, enough for an image file in the project tree.
const PNG=Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='),c=>c.charCodeAt(0));
const MAIN=String.raw`\documentclass{article}
\usepackage{amsmath}
\input{macros}
\begin{document}
\section{Introduction}\label{sec:intro}
\input{chapters/one}
`;
const FILES={
  'main.tex':MAIN,
  'macros.tex':String.raw`\newcommand{\R}{\mathbb{R}}`+'\n'+String.raw`\newcommand{\norm}[1]{\lVert #1\rVert}`+'\n',
  'chapters/one.tex':String.raw`\begin{figure}\caption{Map}\label{fig:survey-map}\end{figure}`+'\n',
  'refs.bib':'@article{knuth1984,\n  author={Donald E. Knuth},\n  title={Literate Programming},\n  journal={The Computer Journal},\n  year={1984}\n}\n@book{lamport1994,author={Leslie Lamport},title={A Document Preparation System},year=1994}\n',
};
async function open(page,files=FILES){
  await page.goto('/');const chooser=page.waitForEvent('filechooser');await page.getByRole('button',{name:'Import ZIP',exact:true}).click();
  const entries=Object.fromEntries(Object.entries(files).map(([path,text])=>[path,strToU8(text)]));entries['figures/map.png']=PNG;
  await (await chooser).setFiles({name:'autocomplete.zip',mimeType:'application/zip',buffer:Buffer.from(zipSync(entries))});
  await expect(page.locator('.cm-content')).toBeVisible();
}
const view=page=>page.evaluate(()=>{const v=document.querySelector('.cm-content').cmTile.root.view;return{text:v.state.doc.toString(),head:v.state.selection.main.head};});
async function atEnd(page){await page.locator('.cm-content').click();await page.keyboard.press('Control+End');}
const type=(page,text)=>page.keyboard.type(text,{delay:40});
const popup=page=>page.locator('.cm-tooltip-autocomplete');
const selected=page=>popup(page).locator('li[aria-selected]');
const accepted=page=>page.evaluate(()=>window.scribyra.agent.readSource({path:'main.tex',startLine:1,endLine:200}).value.content);

test('\\sec filters commands, shows shape, description and source, and Enter inserts a snippet with tab stops',async({page})=>{
  const errors=[];page.on('pageerror',e=>errors.push(e.message));await open(page);await atEnd(page);
  await type(page,'\\');await expect(popup(page)).toBeVisible();
  await type(page,'sec');
  await expect(selected(page)).toContainText('\\section{title}');await expect(selected(page)).toContainText('LaTeX');await expect(selected(page)).toContainText('Numbered section heading');
  const listbox=popup(page).getByRole('listbox');await expect(listbox).toBeVisible();
  // The editor points assistive technology at the selected option.
  const id=await selected(page).getAttribute('id');await expect(page.locator('.cm-content')).toHaveAttribute('aria-activedescendant',id);
  await expect(popup(page).getByRole('option').filter({hasText:'\\subsection{title}'})).toBeVisible();
  await page.keyboard.press('Enter');await expect(popup(page)).toBeHidden();
  await type(page,'Results');let state=await view(page);expect(state.text.endsWith('\\section{Results}')).toBe(true);
  // Tab moves through placeholders: \frac{|}{} → numerator, Tab, denominator.
  await page.keyboard.press('End');await page.keyboard.press('Enter');await type(page,'\\frac');await expect(selected(page)).toContainText('\\frac{numerator}{denominator}');
  await page.keyboard.press('Tab');await type(page,'1');await page.keyboard.press('Tab');await type(page,'2');
  state=await view(page);expect(state.text.endsWith('\\frac{1}{2}')).toBe(true);
  // A brace already typed after the name is kept, not doubled.
  await page.keyboard.press('End');await page.keyboard.press('Enter');await page.keyboard.insertText('{word}');for(let i=0;i<6;i++)await page.keyboard.press('ArrowLeft');
  await type(page,'\\textb');await expect(selected(page)).toContainText('\\textbf');await page.keyboard.press('Enter');
  state=await view(page);expect(state.text.endsWith('\\textbf{word}')).toBe(true);
  // Arrow keys move the selection.
  await page.keyboard.press('End');await page.keyboard.press('Enter');await type(page,'\\sec');const first=await selected(page).textContent();await page.keyboard.press('ArrowDown');await expect(selected(page)).not.toHaveText(first);await page.keyboard.press('Escape');
  expect(errors).toEqual([]);
});

test('\\begin{ite produces the whole environment, and \\begin alone offers environment snippets',async({page})=>{
  await open(page);await atEnd(page);
  await type(page,'\\begin{ite');await expect(selected(page)).toContainText('itemize');await page.keyboard.press('Enter');
  await type(page,'First');let state=await view(page);
  expect(state.text.endsWith('\\begin{itemize}\n  \\item First\n\\end{itemize}')).toBe(true);
  await page.keyboard.press('Control+End');await page.keyboard.press('Enter');await type(page,'\\begin');
  await expect(popup(page).getByRole('option').filter({hasText:'\\begin{enumerate}'})).toBeVisible();
  await popup(page).getByRole('option').filter({hasText:'\\begin{enumerate}'}).click();await type(page,'One');
  state=await view(page);expect(state.text.endsWith('\\begin{enumerate}\n  \\item One\n\\end{enumerate}')).toBe(true);
  // \end{ offers the innermost open environment first.
  await page.keyboard.press('Control+End');await page.keyboard.press('Enter');await page.keyboard.insertText('\\begin{proof}\nDone.\n');await type(page,'\\end{');
  await expect(selected(page)).toContainText('proof');await page.keyboard.press('Tab');state=await view(page);expect(state.text.endsWith('\\end{proof}')).toBe(true);
});

test('project names: \\ref from another file, \\cite keys with authors, files, images, packages and user commands',async({page})=>{
  await open(page);await atEnd(page);
  await type(page,'See \\ref{');await expect(popup(page).getByRole('option').filter({hasText:'fig:survey-map'})).toBeVisible();await expect(popup(page)).toContainText('chapters/one.tex');
  await type(page,'surv');await page.keyboard.press('Enter');expect((await view(page)).text.endsWith('\\ref{fig:survey-map}')).toBe(true);
  await type(page,' and \\cite{');const knuth=popup(page).getByRole('option').filter({hasText:'knuth1984'});await expect(knuth).toBeVisible();await expect(knuth).toContainText('Knuth, 1984');
  await type(page,'knu');await expect(selected(page)).toContainText('Literate Programming');await page.keyboard.press('Enter');expect((await view(page)).text.endsWith('\\cite{knuth1984}')).toBe(true);
  await page.keyboard.press('Enter');await type(page,'\\includegraphics{');await expect(selected(page)).toContainText('figures/map.png');await page.keyboard.press('Escape');
  await page.keyboard.press('End');await page.keyboard.press('Enter');await type(page,'\\input{ch');await expect(selected(page)).toContainText('chapters/one');await page.keyboard.press('Escape');
  await page.keyboard.press('End');await page.keyboard.press('Enter');await type(page,'\\usepackage{siun');await expect(selected(page)).toContainText('siunitx');await page.keyboard.press('Escape');
  await page.keyboard.press('End');await page.keyboard.press('Enter');await type(page,'\\nor');await expect(popup(page).getByRole('option').filter({hasText:'\\norm{arg1}'})).toContainText('this project');await page.keyboard.press('Escape');
  // A label typed now is offered after the index catches up, without a reload.
  await page.keyboard.press('End');await page.keyboard.press('Enter');await type(page,'\\label{tab:fresh}');await page.waitForTimeout(600);await page.keyboard.press('Enter');await type(page,'\\eqref{tab');await expect(selected(page)).toContainText('tab:fresh');
});

test('Escape closes, Enter is a newline when the list is closed, Ctrl+Space reopens it, and comments get no list',async({page})=>{
  await open(page);await atEnd(page);
  await type(page,'\\sec');await expect(popup(page)).toBeVisible();await page.keyboard.press('Escape');await expect(popup(page)).toBeHidden();
  await page.keyboard.press('Enter');let state=await view(page);expect(state.text.endsWith('\\sec\n')).toBe(true);
  await type(page,'plain words');await page.waitForTimeout(250);await expect(popup(page)).toBeHidden();await page.keyboard.press('Enter');state=await view(page);expect(state.text.endsWith('plain words\n')).toBe(true);
  await type(page,'\\sub');await page.keyboard.press('Escape');await page.keyboard.press('Control+Space');await expect(selected(page)).toContainText('\\subsection');await page.keyboard.press('Escape');
  await page.keyboard.press('End');await page.keyboard.press('Enter');await type(page,'% a comment \\sec');await page.waitForTimeout(300);await expect(popup(page)).toBeHidden();await page.keyboard.press('Control+Space');await page.waitForTimeout(300);await expect(popup(page)).toBeHidden();
  await page.keyboard.press('Enter');await page.keyboard.insertText('\\begin{verbatim}\n');await type(page,'\\sec');await page.waitForTimeout(300);await expect(popup(page)).toBeHidden();
});

test('Reviewing turns an accepted completion into a suggestion; Viewing inserts nothing',async({page})=>{
  await open(page);const before=await accepted(page);const mode=page.getByRole('combobox',{name:'Editor mode'});
  await mode.selectOption('reviewing');await atEnd(page);await type(page,'\\sec');await expect(selected(page)).toContainText('\\section');await page.keyboard.press('Enter');await type(page,'Review');
  await expect(page.getByRole('complementary',{name:'Review panel'}).getByRole('insertion').filter({hasText:'\\section{Review}'})).toHaveCount(1);await expect(page.locator('ins.tracked-insert').first()).toBeVisible();
  expect(await accepted(page)).toBe(before);
  await mode.selectOption('viewing');await expect(page.locator('.cm-content')).toHaveAttribute('aria-readonly','true');
  await atEnd(page);const shown=(await view(page)).text;await type(page,'\\sec');await page.keyboard.press('Control+Space');await page.waitForTimeout(300);await expect(popup(page)).toBeHidden();await page.keyboard.press('Enter');
  expect((await view(page)).text).toBe(shown);expect(await accepted(page)).toBe(before);
});

test('the Project settings switch turns autocomplete off and on, and is remembered',async({page})=>{
  await open(page);
  const settings=async checked=>{await page.getByRole('button',{name:'More tools',exact:true}).click();await page.getByRole('button',{name:'Project settings',exact:true}).click();const box=page.getByLabel('LaTeX autocomplete',{exact:true});await expect(box).toBeChecked({checked:!checked});await box.setChecked(checked);await page.getByRole('button',{name:'Save settings',exact:true}).click();};
  await settings(false);await atEnd(page);await type(page,'\\sec');await page.keyboard.press('Control+Space');await page.waitForTimeout(300);await expect(popup(page)).toBeHidden();
  await expect(page.locator('.save-indicator')).toHaveText('Saved locally');await page.reload();await page.getByRole('button',{name:/autocomplete.*files/}).click();await expect(page.locator('.cm-content')).toBeVisible();
  await atEnd(page);await page.keyboard.press('Enter');await type(page,'\\sec');await page.waitForTimeout(300);await expect(popup(page)).toBeHidden();
  await settings(true);await atEnd(page);await page.keyboard.press('Enter');await type(page,'\\sec');await expect(popup(page)).toBeVisible();
});

for(const theme of ['light','dark'])test(`${theme} popups pass axe and are captured for review`,async({page,browserName})=>{
  await page.setViewportSize({width:1366,height:768});await open(page);
  if(theme==='dark'){await page.getByRole('button',{name:'Toggle theme',exact:true}).click();await expect(page.locator(':root')).toHaveAttribute('data-theme','dark');}
  const dir=process.env.SCRIBYRA_SCREENSHOTS;if(dir)mkdirSync(dir,{recursive:true});
  for(const [name,text] of [['commands','\\sec'],['environments','\\begin{'],['citations','\\citep{']]){
    await atEnd(page);await page.keyboard.press('Enter');await type(page,text);await expect(selected(page)).toBeVisible();
    // The list scrolls with the arrow and page keys from the editor (aria-activedescendant), so it is
    // deliberately not a tab stop of its own; axe cannot see that and flags the scrollable region.
    const result=await new AxeBuilder({page}).include('.cm-tooltip-autocomplete').disableRules(['scrollable-region-focusable']).withTags(['wcag2a','wcag2aa','wcag21a','wcag21aa']).analyze();
    expect(result.violations.map(v=>({id:v.id,nodes:v.nodes.map(n=>n.target)}))).toEqual([]);
    if(dir)await page.screenshot({path:join(dir,`${browserName}-${theme}-${name}.png`)});
    await page.keyboard.press('Escape');
  }
});

// Opt-in like large-projects.spec.js: SCRIBYRA_LARGE_PROJECTS=<dir with thesis.zip and long-file.zip>.
const large=process.env.SCRIBYRA_LARGE_PROJECTS;
for(const project of ['thesis','long-file'])test(`${project}: opening and filtering stay within a frame`,async({page,browserName})=>{
  test.skip(!large||!existsSync(join(large||'',`${project}.zip`)),'set SCRIBYRA_LARGE_PROJECTS to the generated projects');test.setTimeout(600000);
  await page.goto('/');const chooser=page.waitForEvent('filechooser');await page.getByRole('button',{name:'Import ZIP',exact:true}).click();
  await (await chooser).setFiles({name:`${project}.zip`,mimeType:'application/zip',buffer:readFileSync(join(large,`${project}.zip`))});await expect(page.locator('.cm-content')).toBeVisible({timeout:120000});
  if(project==='thesis'){await page.getByRole('treeitem').filter({hasText:/^chapters$/}).first().click().catch(()=>{});const chapter=page.getByRole('treeitem',{name:/chapter\.tex$|\.tex$/}).nth(3);await chapter.click();}
  await page.locator('.cm-content').click();await page.keyboard.press('Control+End');await page.waitForTimeout(3000);
  // Per keystroke: from keydown to the next frame after the list shows the new filter; plus the option-building time.
  const measure=async keys=>page.evaluate(async keys=>{
    const view=document.querySelector('.cm-content').cmTile.root.view,times=[],builds=[];
    for(const key of keys){
      const start=performance.now();
      view.dispatch(view.state.update({changes:{from:view.state.selection.main.head,insert:key},selection:{anchor:view.state.selection.main.head+1},userEvent:'input.type'}));
      await new Promise(resolve=>{const check=()=>{const tip=document.querySelector('.cm-tooltip-autocomplete');if(tip&&tip.querySelector('li[aria-selected]'))resolve();else requestAnimationFrame(check);};requestAnimationFrame(check);});
      await new Promise(r=>requestAnimationFrame(()=>setTimeout(r)));
      times.push(performance.now()-start);builds.push(performance.getEntriesByName('latex-completion').at(-1)?.duration??NaN);
      await new Promise(r=>setTimeout(r,60));
    }
    return {times,builds};
  },keys);
  const results={};
  for(const [name,text] of [['command','\\sec'],['ref','\\ref{'],['cite','\\cite{'],['package','\\usepackage{a']]){
    await page.keyboard.press('Enter');const {times,builds}=await measure([...text]);await page.keyboard.press('Escape');await page.keyboard.press('End');
    const sorted=[...builds].filter(Number.isFinite).sort((a,b)=>a-b);results[name]={buildMaxMs:+sorted.at(-1).toFixed(2),buildMedianMs:+sorted[sorted.length>>1].toFixed(2),keyToFrameMs:times.map(t=>+t.toFixed(1))};
    expect(sorted.at(-1)).toBeLessThan(16);
  }
  console.log(`autocomplete-performance ${browserName} ${project} ${JSON.stringify(results)}`);
});
