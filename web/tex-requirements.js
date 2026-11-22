// The TeX files a project asks for by name, read from its source before the first pass, so
// packages the engine lacks can be installed up front instead of one failing pass at a time.
// Only literal names count (`\usepackage{siunitx}`, not `\usepackage{\mypkg}`); anything this
// misses is still found by the demand-driven resolution after a failing pass.
const NAME=/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const SOURCE=/\.(tex|ltx|sty|cls|dtx)$/i;
// command -> how its argument names files
const COMMANDS=[
 [/\\documentclass\s*(?:\[[^\]]*\])?\s*\{([^}]*)\}/g,name=>[`${name}.cls`]],
 [/\\LoadClass(?:WithOptions)?\s*(?:\[[^\]]*\])?\s*\{([^}]*)\}/g,name=>[`${name}.cls`]],
 [/\\(?:usepackage|RequirePackage|RequirePackageWithOptions)\s*(?:\[[^\]]*\])?\s*\{([^}]*)\}/g,name=>[`${name}.sty`]],
 [/\\use(color|font|inner|outer|)theme\s*(?:\[[^\]]*\])?\s*\{([^}]*)\}/g,(name,kind)=>[`beamer${kind}theme${name}.sty`]],
 [/\\usetikzlibrary\s*\{([^}]*)\}/g,name=>[`tikzlibrary${name}.code.tex`]],
 [/\\usepgflibrary\s*\{([^}]*)\}/g,name=>[`pgflibrary${name}.code.tex`]],
 [/\\usepgfplotslibrary\s*\{([^}]*)\}/g,name=>[`pgfplotslibrary${name}.code.tex`]],
 [/\\bibliographystyle\s*\{([^}]*)\}/g,name=>[`${name}.bst`]],
];
// Strips comments (an unescaped %) so commented-out packages are not installed.
export function stripComments(text){
 return text.split('\n').map(line=>{for(let i=0;i<line.length;i++){if(line[i]==='\\'){i++;continue;}if(line[i]==='%')return line.slice(0,i);}return line;}).join('\n');
}
// Files named in one source text. Beamer themes are named without their kind prefix.
export function fileRequests(text){
 const source=stripComments(String(text||'')),names=new Set();
 for(const[pattern,files]of COMMANDS){
  for(const match of source.matchAll(pattern)){
   const kind=match.length>2?match[1]:undefined,list=match[match.length-1];
   for(const raw of list.split(',')){const name=raw.trim();if(NAME.test(name))for(const file of files(name,kind))names.add(file);}
  }
 }
 return [...names];
}
// Files a project's sources ask for that the project does not contain itself, sorted.
export function projectRequests(files){
 const own=new Set(files.map(file=>String(file.path).split('/').pop()));
 const names=new Set();
 for(const file of files)if(SOURCE.test(file.path)&&typeof file.content==='string')for(const name of fileRequests(file.content))if(!own.has(name))names.add(name);
 return [...names].sort();
}
