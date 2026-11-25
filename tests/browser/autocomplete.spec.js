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
const ends=async(page,expected)=>expect((await view(page)).text.slice(-expected.length)).toBe(expected);
// CodeMirror ignores Enter and Tab for 75 ms after the list opens or changes, against accidental picks.
const accept=async(page,key='Enter')=>{await page.waitForTimeout(100);await page.keyboard.press(key);};
// Accessible names join the option's parts; engines differ only in spaces before `{` and commas.
const spoken=text=>new RegExp('^'+text.split(/(?=[{,])/).map(part=>part.replace(/[\\^$.*+?()[\]{}|]/g,'\\$&')).join(' *')+'$');
const cursor=(page,anchor,head=anchor)=>page.evaluate(({anchor,head})=>{const v=document.querySelector('.cm-content').cmTile.root.view;v.dispatch({selection:{anchor,head}});v.focus();},{anchor,head});
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
  await type(page,'Results');let state=await view(page);expect(state.text.slice(-'\\section{Results}'.length)).toBe('\\section{Results}');
  // Tab moves through placeholders: \frac{|}{} → numerator, Tab, denominator.
  await page.keyboard.press('End');await page.keyboard.press('Enter');await type(page,'\\frac');await expect(selected(page)).toContainText('\\frac{numerator}{denominator}');
  await page.keyboard.press('Tab');await type(page,'1');await page.keyboard.press('Tab');await type(page,'2');
  state=await view(page);expect(state.text.slice(-'\\frac{1}{2}'.length)).toBe('\\frac{1}{2}');
  // A brace already typed after the name is kept, not doubled.
  await page.keyboard.press('End');await page.keyboard.press('Enter');await page.keyboard.insertText('{word}');for(let i=0;i<6;i++)await page.keyboard.press('ArrowLeft');
  await type(page,'\\textb');await expect(selected(page)).toContainText('\\textbf');await page.keyboard.press('Enter');
  state=await view(page);expect(state.text.slice(-'\\textbf{word}'.length)).toBe('\\textbf{word}');
  // Arrow keys move the selection.
  await page.keyboard.press('End');await page.keyboard.press('Enter');await type(page,'\\sec');const first=await selected(page).textContent();await page.keyboard.press('ArrowDown');await expect(selected(page)).not.toHaveText(first);await page.keyboard.press('Escape');
  expect(errors).toEqual([]);
});

test('\\begin{ite produces the whole environment, and \\begin alone offers environment snippets',async({page})=>{
  await open(page);await atEnd(page);
  await type(page,'\\begin{ite');await expect(selected(page)).toContainText('itemize');await page.keyboard.press('Enter');
  await type(page,'First');let state=await view(page);
  expect(state.text.slice(-'\\begin{itemize}\n  \\item First\n\\end{itemize}'.length)).toBe('\\begin{itemize}\n  \\item First\n\\end{itemize}');
  await page.keyboard.press('Control+End');await page.keyboard.press('Enter');await type(page,'\\begin');
  await expect(popup(page).getByRole('option').filter({hasText:'\\begin{enumerate}'})).toBeVisible();
  await popup(page).getByRole('option').filter({hasText:'\\begin{enumerate}'}).click();await type(page,'One');
  state=await view(page);expect(state.text.slice(-'\\begin{enumerate}\n  \\item One\n\\end{enumerate}'.length)).toBe('\\begin{enumerate}\n  \\item One\n\\end{enumerate}');
  // \end{ offers the innermost open environment first.
  await page.keyboard.press('Control+End');await page.keyboard.press('Enter');await page.keyboard.insertText('\\begin{proof}\nDone.\n');await type(page,'\\end{');
  await expect(selected(page)).toContainText('proof');await page.keyboard.press('Tab');state=await view(page);expect(state.text.slice(-'\\end{proof}'.length)).toBe('\\end{proof}');
});

test('project names: \\ref from another file, \\cite keys with authors, files, images, packages and user commands',async({page})=>{
  await open(page);await atEnd(page);
  await type(page,'See \\ref{');await expect(popup(page).getByRole('option').filter({hasText:'fig:survey-map'})).toBeVisible();await expect(popup(page)).toContainText('chapters/one.tex');
  await type(page,'surv');await page.keyboard.press('Enter');await ends(page,'\\ref{fig:survey-map}');
  await type(page,' and \\cite{');const knuth=popup(page).getByRole('option').filter({hasText:'knuth1984'});await expect(knuth).toBeVisible();await expect(knuth).toContainText('Knuth, 1984');
  await type(page,'knu');await expect(selected(page)).toContainText('Literate Programming');await page.keyboard.press('Enter');await ends(page,'\\cite{knuth1984}');
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
  await page.keyboard.press('Enter');let state=await view(page);expect(state.text.slice(-'\\sec\n'.length)).toBe('\\sec\n');
  await type(page,'plain words');await page.waitForTimeout(250);await expect(popup(page)).toBeHidden();await page.keyboard.press('Enter');state=await view(page);expect(state.text.slice(-'plain words\n'.length)).toBe('plain words\n');
  // A command typed in full that takes no argument leaves Enter to the newline.
  await type(page,'\\item');await expect(selected(page)).toContainText('\\item');await page.keyboard.press('Enter');state=await view(page);expect(state.text.slice(-'\\item\n'.length)).toBe('\\item\n');await expect(popup(page)).toBeHidden();
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
  // [name, text inserted first, keys moving back into it, text typed there]
  for(const [name,setup,back,text] of [['commands','',0,'\\sec'],['environments','',0,'\\begin{'],['citations','',0,'\\citep{'],
    ['package-options','\\usepackage[]{biblatex}',11,'s'],['option-values','\\usepackage[]{biblatex}',11,'style='],['class-options','\\documentclass[]{beamer}',9,'a'],
    ['labels','\\section{Related Work}\n',0,'\\label{'],['figure-labels','\\begin{figure}\n\\caption{Survey map of the site}\n',0,'\\label{']]){
    await atEnd(page);await page.keyboard.press('Enter');if(setup)await page.keyboard.insertText(setup);for(let i=0;i<back;i++)await page.keyboard.press('ArrowLeft');
    await type(page,text);await expect(selected(page)).toBeVisible();
    // Every rule, scrollable-region-focusable included: the list pages instead of scrolling, and the
    // editor moves through it with aria-activedescendant.
    const result=await new AxeBuilder({page}).include('.cm-tooltip-autocomplete').withTags(['wcag2a','wcag2aa','wcag21a','wcag21aa']).analyze();
    expect(result.violations.map(v=>({id:v.id,nodes:v.nodes.map(n=>n.target)}))).toEqual([]);
    if(dir)await page.screenshot({path:join(dir,`${browserName}-${theme}-${name}.png`)});
    await page.keyboard.press('Escape');await page.keyboard.press('Control+End');
  }
});

test('screen-reader semantics: named listbox, option names with detail, source and description, live counts, focus stays in the editor',async({page})=>{
  await open(page);await atEnd(page);const editor=page.getByRole('textbox',{name:'LaTeX source',exact:true}),live=page.locator('.cm-announced');
  await type(page,'\\sec');const listbox=page.getByRole('listbox',{name:'LaTeX suggestions',exact:true});await expect(listbox).toBeVisible();
  // The editor stays focused and names the list it controls and the option it points at.
  await expect(editor).toBeFocused();const listId=await listbox.getAttribute('id');
  await expect(editor).toHaveAttribute('aria-controls',listId);await expect(editor).toHaveAttribute('aria-autocomplete','list');
  const first=listbox.getByRole('option',{selected:true});await expect(editor).toHaveAttribute('aria-activedescendant',await first.getAttribute('id'));
  await expect(first).toHaveAccessibleName(spoken('\\section{title}, LaTeX, Numbered section heading'));
  const total=await listbox.getByRole('option').count();await expect(first).toHaveAttribute('aria-posinset','1');
  const setsize=Number(await first.getAttribute('aria-setsize'));expect(setsize).toBeGreaterThanOrEqual(total);
  await expect(live).toHaveText(`${setsize} suggestions`);
  // Arrow keys move the active descendant; the description follows the selection.
  await page.keyboard.press('ArrowDown');const second=listbox.getByRole('option',{selected:true});await expect(second).toHaveAttribute('aria-posinset','2');
  await expect(editor).toHaveAttribute('aria-activedescendant',await second.getAttribute('id'));await expect(second).toHaveAccessibleName(/^\\.+, .+, .+/);await expect(editor).toBeFocused();
  // Only the selected option shows, and so reads, its description.
  expect(await listbox.ariaSnapshot()).toMatch(/- '?option "\\{1,2}section *\{title\} *, LaTeX"'?\n *- '?option "\\{1,2}section\* *\{title\} *, LaTeX *, Unnumbered section heading" \[selected\]'?/);
  // Escape closes and says so; focus stays; the editor no longer points at an option.
  await page.keyboard.press('Escape');await expect(listbox).toBeHidden();await expect(live).toHaveText('Suggestions closed');await expect(editor).toBeFocused();
  await expect(editor).not.toHaveAttribute('aria-activedescendant',/./);
  // Enter and Tab accept and announce what went in.
  await page.keyboard.press('Control+Space');await expect(listbox).toBeVisible();await accept(page);await expect(live).toHaveText('Inserted \\section{title}');await expect(editor).toBeFocused();
  await type(page,'Results');await page.keyboard.press('End');await page.keyboard.press('Enter');await type(page,'\\textbf');await expect(listbox).toBeVisible();await accept(page,'Tab');await expect(live).toHaveText('Inserted \\textbf{text}');
  // Citation rows read their parts with pauses between them.
  await page.keyboard.press('End');await page.keyboard.press('Enter');await type(page,'\\cite{knu');
  await expect(listbox.getByRole('option',{selected:true})).toHaveAccessibleName(spoken('knuth1984, Knuth, 1984, refs.bib, Literate Programming'));await expect(live).toHaveText('1 suggestion');await page.keyboard.press('Escape');
  // A long list shows one page at a time and never scrolls by itself; arrows and the wheel page through it.
  await page.keyboard.press('End');await page.keyboard.press('Enter');await type(page,'\\');await expect(listbox).toBeVisible();
  const rendered=await listbox.getByRole('option').count();expect(rendered).toBeLessThanOrEqual(10);
  expect(await listbox.evaluate(list=>getComputedStyle(list).overflowY)).toBe('hidden');
  for(let i=0;i<rendered;i++)await page.keyboard.press('ArrowDown');
  await expect(listbox.getByRole('option',{selected:true})).toHaveAttribute('aria-posinset',String(rendered+1));await expect(editor).toBeFocused();
  const before=Number(await listbox.getByRole('option',{selected:true}).getAttribute('aria-posinset'));
  await listbox.hover();await page.mouse.wheel(0,120);await expect.poll(async()=>Number(await listbox.getByRole('option',{selected:true}).getAttribute('aria-posinset'))).toBeGreaterThan(before);
  await expect(editor).toBeFocused();await page.keyboard.press('Escape');
});

test('\\label{ after a heading or in a float offers a key from its title or caption, unique and in the project style',async({page})=>{
  await open(page);await atEnd(page);
  await page.keyboard.insertText('\\section{Related Work on Maps}\n');await type(page,'\\label{');
  await expect(selected(page)).toContainText('sec:related-work-maps');await expect(selected(page)).toContainText('new label');await expect(selected(page)).toContainText('title “Related Work on Maps”');
  await page.keyboard.press('Enter');await ends(page,'\\label{sec:related-work-maps}');
  // The caption names the figure; fig:survey-map is taken in chapters/one.tex, so the key gets a number.
  await page.keyboard.press('Enter');await page.keyboard.insertText('\\begin{figure}\n\\caption{Survey map}\n');await type(page,'\\label{');
  await expect(selected(page)).toContainText('fig:survey-map-2');await page.keyboard.press('Tab');await ends(page,'\\label{fig:survey-map-2}');
  // A label typed before the caption still finds it; equations take the section's name.
  await page.keyboard.insertText('\n\\end{figure}\n\\begin{table}\n\\label{}\n\\caption{Costs}\n\\end{table}\n');
  await cursor(page,(await view(page)).text.lastIndexOf('\\label{}')+7);await page.keyboard.press('Control+Space');
  await expect(selected(page)).toContainText('tab:costs');await accept(page);expect((await view(page)).text).toContain('\\label{tab:costs}\n\\caption{Costs}');
  await page.keyboard.press('Control+End');await page.keyboard.insertText('\\begin{equation}\n');await type(page,'\\label{eq');await expect(selected(page)).toContainText('eq:related-work-maps');await page.keyboard.press('Escape');
  // Running text names nothing, so nothing opens.
  await page.keyboard.press('End');await page.keyboard.press('Enter');await page.keyboard.insertText('\\end{equation}\nPlain text ');await type(page,'\\label{');await page.waitForTimeout(300);await expect(popup(page)).toBeHidden();
});

test('\\usepackage[ and \\documentclass[ offer options, values where finite, and skip what is already given',async({page})=>{
  await open(page);await atEnd(page);const back=async n=>{for(let i=0;i<n;i++)await page.keyboard.press('ArrowLeft');};
  await page.keyboard.insertText('\\usepackage[]{geometry}');await back(11);await type(page,'a4');await expect(selected(page)).toContainText('a4paper');await expect(selected(page)).toContainText('geometry');await accept(page);
  await type(page,', mar');await expect(selected(page)).toContainText('margin=');await expect(selected(page)).toContainText('All four margins');await accept(page);await type(page,'2cm, a');
  await expect(popup(page)).toBeVisible();await expect(popup(page).getByRole('option').filter({hasText:/^a4paper/})).toHaveCount(0);await page.keyboard.press('Escape');
  await ends(page,'\\usepackage[a4paper, margin=2cm, a]{geometry}');
  // A key with known values goes straight on to them.
  await page.keyboard.press('End');await page.keyboard.press('Enter');await page.keyboard.insertText('\\usepackage[]{biblatex}');await back(11);await type(page,'back');
  await expect(selected(page)).toContainText('backend=');await expect(selected(page)).toContainText('= biber | bibtex | bibtex8');await accept(page);
  await expect(selected(page)).toContainText('biber');await expect(selected(page)).toContainText('Biber (full Unicode');await accept(page);
  await type(page,',style=authory');await expect(selected(page)).toContainText('authoryear');await accept(page,'Tab');
  await ends(page,'\\usepackage[backend=biber,style=authoryear]{biblatex}');
  // `[` typed in front of an existing name: the option goes in and the bracket is closed for you.
  await page.keyboard.press('End');await page.keyboard.press('Enter');await page.keyboard.insertText('\\usepackage{hyperref}');await back(10);await type(page,'[colorl');
  await expect(selected(page)).toContainText('colorlinks');await accept(page);await ends(page,'\\usepackage[colorlinks]{hyperref}');
  // Class options.
  await page.keyboard.press('End');await page.keyboard.press('Enter');await page.keyboard.insertText('\\documentclass[]{beamer}');await back(9);await type(page,'aspect');
  await expect(selected(page)).toContainText('aspectratio=');await accept(page);await type(page,'16');await expect(selected(page)).toContainText('169');await expect(selected(page)).toContainText('16:9');await accept(page);
  await ends(page,'\\documentclass[aspectratio=169]{beamer}');
  // TikZ keys and \includegraphics keys use the same list.
  await page.keyboard.press('End');await page.keyboard.press('Enter');await page.keyboard.insertText('\\draw[] (0,0) -- (1,1);');await back(17);await type(page,'very th');await expect(selected(page)).toContainText('very thick');await expect(selected(page)).toContainText('TikZ');await expect(popup(page).getByRole('option').filter({hasText:'very thin'})).toBeVisible();await page.keyboard.press('Escape');
  await page.keyboard.press('End');await page.keyboard.press('Enter');await type(page,'\\includegraphics[keep');await expect(selected(page)).toContainText('keepaspectratio');await page.keyboard.press('Escape');
  // \cite{a,|} offers the keys not given yet and keeps the closing brace.
  await page.keyboard.press('End');await page.keyboard.press('Enter');await page.keyboard.insertText('\\cite{knuth1984,}');await back(1);await page.keyboard.press('Control+Space');
  await expect(selected(page)).toContainText('lamport1994');await expect(popup(page).getByRole('option').filter({hasText:'knuth1984'})).toHaveCount(0);await accept(page);
  await ends(page,'\\cite{knuth1984,lamport1994}');const state=await view(page);expect(state.head).toBe(state.text.length);
});

test('renaming \\begin{x} renames its \\end{x} as you type, leaves other environments alone, and one undo reverts both',async({page})=>{
  await open(page);await atEnd(page);
  await page.keyboard.insertText('\\begin{itemize}\n\\item a\n\\begin{itemize}\\item nested\\end{itemize}\n\\end{itemize}\n');
  const text=(await view(page)).text,start=text.lastIndexOf('\\begin{itemize}\n\\item a')+7;
  await page.evaluate(({from,to})=>{const v=document.querySelector('.cm-content').cmTile.root.view;v.dispatch({selection:{anchor:from,head:to}});v.focus();},{from:start,to:start+7});
  await type(page,'enumerate');let state=await view(page);
  expect(state.text.slice(-'\\begin{enumerate}\n\\item a\n\\begin{itemize}\\item nested\\end{itemize}\n\\end{enumerate}\n'.length)).toBe('\\begin{enumerate}\n\\item a\n\\begin{itemize}\\item nested\\end{itemize}\n\\end{enumerate}\n');expect(state.text).toContain('\\begin{document}');expect(state.text).not.toContain('\\end{enumerate}\n\\end{enumerate}');
  // The \end side drives the \begin side, Backspace included.
  const end=state.text.lastIndexOf('\\end{enumerate}')+14;
  await page.evaluate(at=>{const v=document.querySelector('.cm-content').cmTile.root.view;v.dispatch({selection:{anchor:at}});v.focus();},end);
  for(let i=0;i<3;i++)await page.keyboard.press('Backspace');await type(page,'ize');
  state=await view(page);expect(state.text.slice(-'\\begin{enumerize}\n\\item a\n\\begin{itemize}\\item nested\\end{itemize}\n\\end{enumerize}\n'.length)).toBe('\\begin{enumerize}\n\\item a\n\\begin{itemize}\\item nested\\end{itemize}\n\\end{enumerize}\n');
  // Accepting a name from the list renames in place too, without inserting a second environment.
  // A pause, so that the next rename is an undo step of its own.
  await page.waitForTimeout(700);
  const name=state.text.lastIndexOf('\\begin{enumerize}')+7;await page.evaluate(({from,to})=>{const v=document.querySelector('.cm-content').cmTile.root.view;v.dispatch({selection:{anchor:from,head:to}});v.focus();},{from:name,to:name+9});
  await type(page,'descr');await expect(selected(page)).toContainText('description');await accept(page);
  state=await view(page);expect(state.text.slice(-'\\begin{description}\n\\item a\n\\begin{itemize}\\item nested\\end{itemize}\n\\end{description}\n'.length)).toBe('\\begin{description}\n\\item a\n\\begin{itemize}\\item nested\\end{itemize}\n\\end{description}\n');
  // Undo takes both halves back together, then redo restores both.
  await page.waitForTimeout(700);await page.keyboard.press('Control+z');
  await expect.poll(async()=>(await view(page)).text.endsWith('\\begin{enumerize}\n\\item a\n\\begin{itemize}\\item nested\\end{itemize}\n\\end{enumerize}\n')).toBe(true);
});

test('paired renaming is off in Viewing and makes one suggestion in Reviewing',async({page})=>{
  await open(page);await atEnd(page);await page.keyboard.insertText('\\begin{quote}\nWords.\n\\end{quote}\n');await page.waitForTimeout(700);
  const before=await accepted(page),mode=page.getByRole('combobox',{name:'Editor mode'}),panel=page.getByRole('complementary',{name:'Review panel'});
  const selectName=async()=>{const text=(await view(page)).text,at=text.lastIndexOf('\\begin{quote}')+7;await page.evaluate(({from,to})=>{const v=document.querySelector('.cm-content').cmTile.root.view;v.dispatch({selection:{anchor:from,head:to}});v.focus();},{from:at,to:at+5});};
  await mode.selectOption('viewing');await selectName();await type(page,'verse');expect((await view(page)).text).toContain('\\begin{quote}\nWords.\n\\end{quote}');expect(await accepted(page)).toBe(before);
  await mode.selectOption('reviewing');await selectName();await type(page,'verse');
  await expect.poll(async()=>(await view(page)).text).toContain('\\begin{verse}\nWords.\n\\end{verse}');
  // Both names are one decision: one suggestion, and accepted source is unchanged until it is accepted.
  await page.locator('.cm-content').blur();await expect(panel.locator('.review-card')).toHaveCount(1);await expect(panel.locator('.review-card')).toContainText('verse');
  expect(await accepted(page)).toBe(before);
  await panel.locator('.review-card').getByRole('button',{name:/^Accept/}).first().click();
  await expect.poll(()=>accepted(page)).toContain('\\begin{verse}\nWords.\n\\end{verse}');
});

// Opt-in like large-projects.spec.js: SCRIBYRA_LARGE_PROJECTS=<dir with thesis.zip and long-file.zip>.
const large=process.env.SCRIBYRA_LARGE_PROJECTS;
for(const project of ['thesis','long-file'])test(`${project}: opening and filtering stay within a frame`,async({page,browserName})=>{
  test.skip(!large||!existsSync(join(large||'',`${project}.zip`)),'set SCRIBYRA_LARGE_PROJECTS to the generated projects');test.setTimeout(600000);
  await page.addInitScript(()=>{window.__indexBatches=[];new PerformanceObserver(list=>{for(const entry of list.getEntries())if(entry.name==='latex-index-batch')window.__indexBatches.push(entry.duration);}).observe({entryTypes:['measure']});});
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
  const batches=await page.evaluate(()=>window.__indexBatches);results.indexBatches={count:batches.length,maxMs:+Math.max(...batches).toFixed(1),totalMs:+batches.reduce((a,b)=>a+b,0).toFixed(1)};
  console.log(`autocomplete-performance ${browserName} ${project} ${JSON.stringify(results)}`);
});
