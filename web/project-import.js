// What a ZIP import brings (docs/templates.md#importing-from-overleaf): recognises a
// project downloaded from Overleaf ("Download → Source"), finds the main file and
// the compiler it was written for, and explains in plain words what may need a change
// because Scribyra compiles with LuaLaTeX. Pure: no DOM, no network, nothing stored.
import {detectMainFile,isRootDocument} from './open-link.js';

const COMPILERS={pdflatex:'pdfLaTeX',xelatex:'XeLaTeX',lualatex:'LuaLaTeX'};
export const compilerName=id=>COMPILERS[id]||'LaTeX';
const IMAGE=/\.(png|jpe?g|pdf|eps|svg|gif|tiff?|bmp)$/i;
const MAX_SCAN=512*1024;

// Text without comments: a % that is not escaped starts a comment to the end of the line.
// Line numbers are kept, so warnings can point at the line.
function uncommentedLines(source){
 return source.slice(0,MAX_SCAN).split('\n').map(line=>{
  for(let i=0;i<line.length;i++){if(line[i]==='\\'){i++;continue;}if(line[i]==='%')return line.slice(0,i);}
  return line;
 });
}
const packageUses=line=>[...line.matchAll(/\\(?:usepackage|RequirePackage)\s*(?:\[([^\]]*)\])?\s*\{([^}]*)\}/g)].flatMap(([,options='',names])=>names.split(',').map(name=>({name:name.trim(),options:options.split(',').map(option=>option.trim()).filter(Boolean)}))).filter(use=>use.name);

/** `% !TEX program = xelatex` (also `TS-program`, any case) in the first lines of a file. */
export function magicCompiler(source){
 for(const line of source.split('\n').slice(0,20)){
  const match=/^\s*%\s*!\s*tex\s+(?:ts-)?program\s*=\s*([a-z]+)/i.exec(line);
  if(match){const name=match[1].toLowerCase();return name in COMPILERS?name:name==='latex'?'pdflatex':null;}
 }
 return null;
}

/** The compiler and main file a latexmkrc selects, if it says. */
export function latexmkSettings(source){
 const text=source.split('\n').map(line=>line.replace(/#.*$/,'')).join('\n');
 let compiler=null;
 const mode=/\$pdf_mode\s*=\s*(\d)/.exec(text);
 if(mode)compiler={1:'pdflatex',4:'lualatex',5:'xelatex'}[mode[1]]||null;
 if(/\$pdflatex\s*=\s*['"]\s*xelatex/.test(text))compiler='xelatex';
 if(/\$pdflatex\s*=\s*['"]\s*lualatex/.test(text))compiler='lualatex';
 if(!compiler&&/-xelatex\b/.test(text))compiler='xelatex';
 if(!compiler&&/-lualatex\b/.test(text))compiler='lualatex';
 const files=/@default_files\s*=\s*\(\s*['"]([^'"]+\.tex)['"]/.exec(text);
 const custom=/\badd_cus_dep\b|\bsystem\s*\(|\$makeindex\s*=|\bsub\s+\w+/.test(text);
 return {compiler,main:files?files[1]:null,custom};
}

/**
 * entries: [{path, content: string | Uint8Array, folder?}] as importZip returns them.
 * Returns {overleaf, signals, main, compiler, compilerReason, warnings, counts, bibliography}.
 * Each warning is {code, severity: 'error'|'warning'|'info', file, line, message, fix}.
 */
export function analyzeImport(entries){
 const files=entries.filter(entry=>!entry.folder);
 const texts=files.filter(entry=>typeof entry.content==='string');
 const byPath=new Map(files.map(entry=>[entry.path,entry]));
 const lower=new Set(files.map(entry=>entry.path.toLowerCase()));
 const signals=[];
 // latexmkrc has no extension, so the ZIP reader keeps it as bytes.
 const rcEntry=files.find(entry=>/^(?:[^/]+\/)?\.?latexmkrc$/.test(entry.path));
 let rc=null;
 if(rcEntry){try{rc={path:rcEntry.path,content:typeof rcEntry.content==='string'?rcEntry.content:new TextDecoder('utf-8',{fatal:true}).decode(rcEntry.content)};}catch{}}
 if(rc)signals.push(`${rc.path} (build settings Overleaf reads)`);
 if(texts.some(entry=>/\.tex$/i.test(entry.path)&&/%.*\boverleaf\b/i.test(entry.content.slice(0,MAX_SCAN))))signals.push('comments that mention Overleaf');
 const latexmk=rc?latexmkSettings(rc.content):{compiler:null,main:null,custom:false};

 // Main file: latexmkrc's @default_files, then the usual rule (docs/open-links.md#main-file).
 let main=latexmk.main&&byPath.has(latexmk.main)&&isRootDocument(byPath.get(latexmk.main).content)?latexmk.main:detectMainFile(texts);
 const roots=texts.filter(entry=>/\.tex$/i.test(entry.path)&&isRootDocument(entry.content)).map(entry=>entry.path);
 // Overleaf's source download is flat: the main file sits at the top of the archive.
 if(main&&!main.includes('/')&&signals.length===0&&roots.length&&files.some(entry=>/\.bib$/i.test(entry.path))&&files.some(entry=>IMAGE.test(entry.path)&&entry.path.includes('/')))signals.push('the usual layout: main file at the top, figures in a folder, a .bib file');

 const warnings=[];
 const warn=(code,severity,file,line,message,fix)=>{if(!warnings.some(entry=>entry.code===code&&entry.file===file))warnings.push({code,severity,file,line,message,fix});};
 // Hints per engine: XeTeX-only, LuaTeX-only, any Unicode engine (fontspec), pdfTeX-style.
 const hints={xelatex:[],lualatex:[],unicode:[],pdflatex:[]};
 const bib={files:files.filter(entry=>/\.bib$/i.test(entry.path)).map(entry=>entry.path),tool:null,missing:[]};
 for(const entry of texts){
  if(!/\.(tex|sty|cls)$/i.test(entry.path))continue;
  const lines=uncommentedLines(entry.content);
  lines.forEach((line,index)=>{
   const at=index+1;
   for(const use of packageUses(line)){
    const {name,options}=use;
    if(name==='inputenc'){
     hints.pdflatex.push(entry.path);
     const encoding=options.find(option=>option!=='utf8'&&option!=='utf8x');
     if(encoding)warn('inputenc-encoding','error',entry.path,at,`The source is declared as ${encoding}. LuaLaTeX reads every file as UTF-8.`,'Save the files as UTF-8 (Overleaf already stores them that way) and delete this \\usepackage line.');
     else if(options.includes('utf8x'))warn('inputenc-utf8x','warning',entry.path,at,'utf8x (the ucs package) is not supported by LuaLaTeX.','Delete this line; LuaLaTeX reads UTF-8 without it.');
     else warn('inputenc','info',entry.path,at,'\\usepackage[utf8]{inputenc} is only needed by pdfLaTeX. LuaLaTeX ignores it.','You can leave it, or delete the line.');
    }
    else if(name==='fontenc'&&options.some(option=>/^T1$/i.test(option))){hints.pdflatex.push(entry.path);warn('fontenc','info',entry.path,at,'fontenc with T1 selects pdfLaTeX-style fonts. With LuaLaTeX it works, but uses older Type 1 fonts.','Delete the line to get OpenType Latin Modern; load fontspec to choose other fonts.');}
    else if(['xltxtra','xunicode','xecjk','xeCJK','xetexko','xepersian','bidi'].includes(name)){hints.xelatex.push(entry.path);warn(`xetex-${name.toLowerCase()}`,'error',entry.path,at,`${name} works only with XeLaTeX.`,name.toLowerCase()==='xecjk'?'Use luatexja-fontspec instead, and \\setmainjfont for the Japanese/Chinese font.':name==='bidi'||name==='xepersian'?'Use babel with the bidi=basic option, or polyglossia, which work with LuaLaTeX.':'Delete it; fontspec provides the same with LuaLaTeX.');}
    else if(['CJK','CJKutf8'].includes(name)){hints.pdflatex.push(entry.path);warn('cjk','warning',entry.path,at,`${name} is a pdfLaTeX package for Chinese, Japanese and Korean text.`,'With LuaLaTeX, use luatexja (Japanese) or fontspec with a CJK font.');}
    else if(['fontspec','unicode-math','polyglossia'].includes(name))hints.unicode.push(entry.path);
    else if(['luacode','luatexbase','luaotfload','luatexja','luatexja-fontspec','lua-visual-debug','luamplib'].includes(name))hints.lualatex.push(entry.path);
    else if(name==='minted')warn('minted','error',entry.path,at,'minted runs an external program (Pygments) through shell escape, which a browser cannot run.','Use the listings package (\\usepackage{listings} and \\begin{lstlisting}) instead.');
    else if(['svg','gnuplottex','epstopdf','pythontex','sagetex','tikz-externalize'].includes(name)){if(name!=='epstopdf')warn(`shell-${name}`,'warning',entry.path,at,`${name} needs shell escape to run other programs, which Scribyra does not do.`,name==='svg'?'Export the SVG images as PDF and include them with \\includegraphics.':'Run that step elsewhere and add its output files to the project.');}
    else if(name==='glossaries'||name==='glossaries-extra'){if(!options.some(option=>/^automake/.test(option)))warn('glossaries','warning',entry.path,at,'Glossaries normally need the makeglossaries program, which Scribyra does not run.','Load glossaries with the automake=immediate option, or use \\printunsrtglossary from glossaries-extra.');}
    else if(name==='biblatex'){const backend=options.find(option=>/^backend\s*=/.test(option));bib.tool=backend&&/bibtex/.test(backend)?'bibtex':'biber';}
   }
   if(/\\(?:bibliography)\s*\{/.test(line)&&!bib.tool)bib.tool='bibtex';
   for(const match of line.matchAll(/\\(?:bibliography|addbibresource)\s*(?:\[[^\]]*\])?\s*\{([^}]*)\}/g))for(const name of match[1].split(',').map(item=>item.trim()).filter(Boolean)){
    const candidates=[name,`${name}.bib`].flatMap(candidate=>[candidate,entry.path.includes('/')?`${entry.path.replace(/[^/]+$/,'')}${candidate}`:candidate]).map(candidate=>candidate.toLowerCase());
    if(!/^https?:/.test(name)&&!candidates.some(candidate=>lower.has(candidate))&&!bib.missing.includes(name))bib.missing.push(name);
   }
   const primitive=/\\(pdfoutput|pdfminorversion|pdfcompresslevel|pdfobjcompresslevel|pdfpagewidth|pdfpageheight|pdfinfo|pdfsuppresswarningpagegroup|pdfadjustspacing|pdfprotrudechars)\b/.exec(line);
   if(primitive&&!/\\ifdefined\\pdf|\\ifx\\pdf/.test(line))warn(`pdf-primitive-${primitive[1]}`,'error',entry.path,at,`\\${primitive[1]} is a pdfTeX command that LuaLaTeX does not have.`,primitive[1]==='pdfoutput'?'Delete the line; LuaLaTeX always writes PDF.':'Add \\usepackage{luatex85} at the very top of the file, or delete the line.');
   const xetex=/\\(XeTeX[A-Za-z]+)/.exec(line);
   if(xetex&&!/^XeTeXrevision|^XeTeXversion/.test(xetex[1])){hints.xelatex.push(entry.path);warn(`xetex-primitive`,'error',entry.path,at,`\\${xetex[1]} is a XeTeX command that LuaLaTeX does not have.`,'Remove it; fontspec and babel cover most of what it was used for.');}
   if(/\\write18\b|\\immediate\\write18/.test(line))warn('write18','warning',entry.path,at,'\\write18 asks to run a program (shell escape), which Scribyra does not do.','Run that program elsewhere and add its output to the project.');
   if(/\\makeglossaries\b/.test(line)&&!warnings.some(entry=>entry.code==='glossaries'))warn('glossaries','warning',entry.path,at,'Glossaries normally need the makeglossaries program, which Scribyra does not run.','Load glossaries with the automake=immediate option, or use \\printunsrtglossary from glossaries-extra.');
  });
 }
 const eps=files.filter(entry=>/\.eps$/i.test(entry.path));
 if(eps.length)warn('eps','warning',eps[0].path,null,`${eps.length===1?'1 EPS image needs':`${eps.length} EPS images need`} converting: pdfLaTeX converts them with a helper program, LuaLaTeX in the browser cannot.`,'Convert them to PDF (for example with epstopdf or an image editor) and add the PDF files; \\includegraphics finds them without the extension.');
 if(bib.missing.length)warn('bib-missing','warning',main,null,`Bibliography ${bib.missing.length===1?'file':'files'} not in the ZIP: ${bib.missing.join(', ')}.`,'Download it from the original project (it may come from a reference manager link) and add it with Upload files.');
 if(latexmk.custom)warn('latexmk-custom','info',rc.path,null,'latexmkrc defines extra build steps. Scribyra runs LuaLaTeX, Biber or BibTeX and makeindex, but not custom latexmk rules.','If the document needs another tool, run it elsewhere and add its output files.');

 // Which compiler the project expects: an explicit choice first, then what the packages imply.
 const magic=main&&byPath.get(main)?magicCompiler(byPath.get(main).content):null;
 let compiler=null,compilerReason='';
 if(magic){compiler=magic;compilerReason=`a % !TEX program line in ${main}`;}
 else if(latexmk.compiler){compiler=latexmk.compiler;compilerReason=`${rc.path}`;}
 else if(hints.xelatex.length){compiler='xelatex';compilerReason='XeTeX-only packages or commands';}
 else if(hints.lualatex.length){compiler='lualatex';compilerReason='LuaTeX packages';}
 else if(hints.unicode.length){compiler='lualatex';compilerReason='fontspec, which LuaLaTeX supports';}
 else if(signals.length){compiler='pdflatex';compilerReason='no other setting, so Overleaf’s default';}
 else if(hints.pdflatex.length){compiler='pdflatex';compilerReason='its packages';}
 if(compiler==='xelatex'&&!hints.xelatex.length&&hints.unicode.length)compilerReason+=' (fontspec works the same with LuaLaTeX)';
 const severity={error:0,warning:1,info:2};
 warnings.sort((a,b)=>severity[a.severity]-severity[b.severity]);
 const counts={files:files.length,tex:files.filter(entry=>/\.tex$/i.test(entry.path)).length,bib:bib.files.length,images:files.filter(entry=>IMAGE.test(entry.path)).length};
 return {overleaf:signals.length>0,signals,main:main||null,roots,compiler,compilerReason,warnings,counts,bibliography:bib};
}

/** Whether the import summary is worth showing: an Overleaf project, or anything to fix. */
export function needsSummary(report){
 // Notes alone (severity info: things LuaLaTeX ignores or handles) never interrupt a plain ZIP.
 return report.overleaf||report.warnings.some(entry=>entry.severity!=='info')||report.roots.length>1;
}

/** What the person needs to know about the compiler, in one sentence. */
export function compilerSentence(report){
 if(!report.compiler)return 'Scribyra compiles with LuaLaTeX.';
 if(report.compiler==='lualatex')return `Written for LuaLaTeX (from ${report.compilerReason}), which is what Scribyra uses.`;
 const name=compilerName(report.compiler);
 const blocking=report.warnings.some(entry=>entry.severity==='error');
 return `Written for ${name} (from ${report.compilerReason}). Scribyra compiles with LuaLaTeX; ${blocking?'the changes below make it compile.':'most projects compile unchanged.'}`;
}

