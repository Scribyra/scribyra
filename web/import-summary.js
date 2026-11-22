// Dialogs around importing (docs/templates.md#importing-from-overleaf): the summary after
// a ZIP import, the "Coming from Overleaf?" guide, and the prompt for a Git link.
// Overleaf is named only to describe where a file came from; nothing here imitates it.
import {compilerSentence} from './project-import.js';
import {restoreDialogFocus,composingEvent} from './input.js';
import {parseRepositoryInput,formatOpenLink,OpenLinkError} from '../site/open-link-format.js';
import './import-summary.css';

export const GUIDE_URL='https://scribyra.com/coming-from-overleaf.html';
function el(tag,props={},...children){
 const node=document.createElement(tag);
 for(const [key,value] of Object.entries(props)){
  if(value===undefined||value===null||value===false)continue;
  if(key==='className')node.className=value;else if(key==='text')node.textContent=value;else if(key.startsWith('on'))node.addEventListener(key.slice(2),value);else node.setAttribute(key,value===true?'':value);
 }
 for(const child of children.flat())if(child!==null&&child!==undefined&&child!==false)node.append(child);
 return node;
}
function dialogShell(className,title,id){
 const dialog=el('dialog',{className:`modal ${className}`,'aria-labelledby':id});restoreDialogFocus(dialog);
 dialog.append(el('h2',{id,text:title}));
 let done;const closed=new Promise(resolve=>{done=resolve;});
 const close=value=>{if(!dialog.open&&!dialog.isConnected)return;dialog.close();dialog.remove();done(value);};
 dialog.addEventListener('cancel',event=>{event.preventDefault();close(null);});
 return {dialog,close,closed};
}
const plural=(count,one,many=`${one}s`)=>`${count} ${count===1?one:many}`;
const SEVERITY={error:'Needs a change',warning:'Check',info:'Good to know'};

/**
 * The summary after a ZIP import. reveal(path, line) opens a file at a line.
 * Resolves 'compile' when the person chooses Compile now, otherwise null.
 */
export function showImportSummary({name,report,reveal}){
 const {dialog,close,closed}=dialogShell('import-summary',report.overleaf?'Imported from Overleaf':'Project imported','import-summary-title');
 const {counts,bibliography}=report;
 const facts=el('dl',{className:'import-facts'},
  el('dt',{text:'Project'}),el('dd',{text:name}),
  el('dt',{text:'Main file'}),el('dd',{},report.main?el('code',{text:report.main}):'None found: choose one in Project settings',report.roots.length>1?el('span',{className:'import-aside',text:` (${plural(report.roots.length,'candidate')}; change it in Project settings)`}):null),
  el('dt',{text:'Compiler'}),el('dd',{text:compilerSentence(report)}),
  el('dt',{text:'Files'}),el('dd',{text:`${plural(counts.files,'file')}: ${plural(counts.tex,'.tex file')}, ${plural(counts.images,'image')}, ${plural(counts.bib,'bibliography file')}`}),
  bibliography.files.length?[el('dt',{text:'Bibliography'}),el('dd',{},...bibliography.files.slice(0,4).flatMap((path,index)=>[index?', ':'',el('code',{text:path})]),bibliography.files.length>4?` and ${bibliography.files.length-4} more`:'',bibliography.tool?`, processed with ${bibliography.tool==='biber'?'Biber':'BibTeX'}`:'')]:null);
 const signals=report.overleaf?el('p',{className:'import-signals',text:`Recognised by ${report.signals.join(' and ')}.`}):null;
 let list=null;
 if(report.warnings.length){
  list=el('ul',{className:'import-warnings','aria-label':'What to check'});
  for(const entry of report.warnings){
   // The visible text is the whole name (no aria-label), so voice control and screen readers agree.
   const where=entry.file?el('button',{type:'button',className:'import-where',onclick:()=>{close(null);reveal(entry.file,entry.line);}},el('span',{className:'sr-only',text:'Open '}),entry.file,entry.line?`, line ${entry.line}`:''):null;
   list.append(el('li',{'data-severity':entry.severity},el('span',{className:'import-badge',text:SEVERITY[entry.severity]}),el('div',{},el('p',{className:'import-message'},entry.message,' ',where),el('p',{className:'import-fix',text:entry.fix}))));
  }
 }
 dialog.append(...[signals,facts,list?el('h3',{className:'import-subhead',text:report.warnings.some(entry=>entry.severity!=='info')?'Before you compile':'Notes'}):el('p',{className:'import-ok',text:'Nothing in the sources needs changing for LuaLaTeX.'}),list,
  el('p',{className:'import-guide'},'Step by step: ',el('a',{href:GUIDE_URL,target:'_blank',rel:'noopener',text:'moving a project from Overleaf'}),'.'),
  el('div',{className:'modal-actions'},el('button',{type:'button',className:'button secondary',text:'Close',onclick:()=>close(null)}),el('button',{type:'button',className:'button primary',text:'Compile now',onclick:()=>close('compile')}))].filter(Boolean));
 document.body.append(dialog);dialog.showModal();
 return closed;
}

/** The in-app "Coming from Overleaf?" guide. Resolves 'import' when the person wants to pick the ZIP. */
export function showOverleafGuide(){
 const {dialog,close,closed}=dialogShell('overleaf-guide','Coming from Overleaf?','overleaf-guide-title');
 const steps=el('ol',{className:'guide-steps'},
  el('li',{},el('strong',{text:'Download the source. '}),'In your Overleaf project, choose Download → Source from the Menu (in the newer editor: File → Download as source (.zip)). You get a ZIP of your files.'),
  el('li',{},el('strong',{text:'Import it here. '}),'Choose Import a ZIP below (or Import ZIP on the dashboard) and pick that file. Everything stays in this browser.'),
  el('li',{},el('strong',{text:'Read the summary. '}),'Scribyra finds the main file, your bibliography and images, and tells you which compiler the project was written for.'),
  el('li',{},el('strong',{text:'Compile. '}),'Scribyra uses LuaLaTeX. Most pdfLaTeX projects compile unchanged; the summary lists anything to adjust, with the fix.'));
 const notes=el('ul',{className:'guide-notes'},
  el('li',{text:'\\usepackage[utf8]{inputenc} can stay: LuaLaTeX ignores it. Other encodings (latin1) need the files saved as UTF-8.'}),
  el('li',{text:'Packages that run other programs (minted, svg, gnuplottex) need shell escape, which a browser cannot do. Use listings for code and PDF for figures.'}),
  el('li',{text:'Comments, track changes and history stay in Overleaf; only the sources come across.'}));
 dialog.append(el('p',{text:'Overleaf lets you download any project as a ZIP of its source files. Bringing it here takes four steps.'}),steps,el('h3',{className:'import-subhead',text:'Worth knowing'}),notes,
  el('p',{className:'import-guide'},'The same guide on the web: ',el('a',{href:GUIDE_URL,target:'_blank',rel:'noopener',text:'scribyra.com/coming-from-overleaf'}),'.'),
  el('div',{className:'modal-actions'},el('button',{type:'button',className:'button secondary',text:'Close',onclick:()=>close(null)}),el('button',{type:'button',className:'button primary',text:'Import a ZIP',onclick:()=>close('import')})));
 document.body.append(dialog);dialog.showModal();
 return closed;
}

/** Asks for a repository or ZIP address; resolves the `#open?…` fragment to confirm, or null. */
export function askGitLink(){
 const {dialog,close,closed}=dialogShell('git-link-dialog','Open from a Git link','git-link-title');
 const input=el('input',{id:'git-link-address',type:'url',placeholder:'https://github.com/owner/repository',autocomplete:'off',spellcheck:'false','aria-describedby':'git-link-help git-link-status'});
 const status=el('p',{id:'git-link-status',className:'git-link-status',role:'status','aria-live':'polite'});
 const submit=()=>{
  let parsed;
  try{parsed=parseRepositoryInput(input.value);}catch(error){status.textContent=error instanceof OpenLinkError?error.message:'That address could not be read.';input.setAttribute('aria-invalid','true');input.focus();return;}
  let link;
  try{link=formatOpenLink({...parsed,name:''});}catch(error){status.textContent=error instanceof OpenLinkError?error.message:'That address could not be read.';input.setAttribute('aria-invalid','true');input.focus();return;}
  close(new URL(link).hash);
 };
 input.addEventListener('keydown',event=>{if(event.key==='Enter'&&!composingEvent(event)){event.preventDefault();submit();}});
 input.addEventListener('input',()=>{input.removeAttribute('aria-invalid');status.textContent='';});
 dialog.append(el('p',{id:'git-link-help',text:'Paste the address of a public GitHub or GitLab repository (a folder or file page works too), or of a ZIP file. You will see what it contains before anything is imported.'}),
  el('label',{className:'git-link-label',for:'git-link-address',text:'Repository or ZIP address'}),input,status,
  el('div',{className:'modal-actions'},el('button',{type:'button',className:'button secondary',text:'Cancel',onclick:()=>close(null)}),el('button',{type:'button',className:'button primary',text:'Continue',onclick:submit})));
 document.body.append(dialog);dialog.showModal();input.focus();
 return closed;
}
