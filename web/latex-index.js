// Project-wide LaTeX names for completion: labels, bibliography keys, user commands and
// environments, and the files a document can include. Parsing is per file and pure; the
// index re-parses only files that changed, after a quiet moment, in idle time.
import {withoutComments} from './latex.js';
import {projectFiles} from './model.js';
import {changedTextFiles} from './change-origins.js';

const IMAGE=/\.(png|jpe?g|pdf|eps|svg|gif|webp)$/i;
export const fileKind=path=>/\.(tex|ltx|sty|cls)$/i.test(path)?'tex':/\.bib$/i.test(path)?'bib':IMAGE.test(path)?'image':'other';

// Comments are blanked rather than removed, so offsets and line numbers stay true.
function blankComments(text){return text.replace(/(\\[\s\S])|%[^\r\n]*/g,(match,escaped)=>escaped||' '.repeat(match.length));}
function lineAt(starts,offset){let low=0,high=starts.length-1;while(low<high){const mid=(low+high+1)>>1;if(starts[mid]<=offset)low=mid;else high=mid-1;}return low+1;}
function lineStarts(text){const starts=[0];for(let i=text.indexOf('\n');i>=0;i=text.indexOf('\n',i+1))starts.push(i+1);return starts;}

/** Labels, user commands and environments defined in one TeX source. */
export function parseTex(text){
  const source=blankComments(text),labels=[],commands=[],environments=[];let starts;
  const line=offset=>lineAt(starts||=lineStarts(source),offset);
  if(source.includes('\\label'))for(const match of source.matchAll(/\\label\s*\{([^{}\\]+)\}/g)){const key=match[1].trim();if(key)labels.push({key,line:line(match.index)});}
  if(/\\(?:re|provide|new|Declare|NewDocument|RenewDocument|ProvideDocument|def\b)/.test(source)){
    for(const match of source.matchAll(/\\(?:(?:re)?newcommand|providecommand|DeclareRobustCommand)\*?\s*\{?\s*\\([A-Za-z@]+)\s*\}?\s*(?:\[\s*(\d)\s*\])?\s*(\[[^\]]*\])?/g))
      commands.push({name:match[1],args:Number(match[2]||0),optional:!!match[3],line:line(match.index)});
    for(const match of source.matchAll(/\\(?:New|Renew|Provide|Declare)DocumentCommand\s*\{?\s*\\([A-Za-z@]+)\s*\}?\s*\{([^{}]*(?:\{[^{}]*\}[^{}]*)*)\}/g)){
      const spec=match[2].replace(/\{[^{}]*\}/g,'');commands.push({name:match[1],args:(spec.match(/[mrRvb]/g)||[]).length,optional:/[oOd]/.test(spec),line:line(match.index)});
    }
    for(const match of source.matchAll(/\\DeclareMathOperator(\*?)\s*\{?\s*\\([A-Za-z@]+)\s*\}?/g))commands.push({name:match[2],args:0,optional:false,operator:true,line:line(match.index)});
    for(const match of source.matchAll(/\\def\s*\\([A-Za-z@]+)((?:#\d)*)\s*\{/g))commands.push({name:match[1],args:(match[2].match(/#/g)||[]).length,optional:false,line:line(match.index)});
    for(const match of source.matchAll(/\\(?:re)?newenvironment\*?\s*\{([^{}\\]+)\}\s*(?:\[\s*(\d)\s*\])?\s*(\[[^\]]*\])?/g))
      environments.push({name:match[1].trim(),args:Number(match[2]||0)-(match[3]?1:0),line:line(match.index)});
    for(const match of source.matchAll(/\\(?:New|Renew|Provide)DocumentEnvironment\s*\{([^{}\\]+)\}\s*\{([^{}]*)\}/g))
      environments.push({name:match[1].trim(),args:(match[2].match(/[mrRvb]/g)||[]).length,line:line(match.index)});
    for(const match of source.matchAll(/\\newtheorem\*?\s*\{([^{}\\]+)\}/g))environments.push({name:match[1].trim(),args:0,theorem:true,line:line(match.index)});
  }
  // A command's last definition wins; `@` names are package internals.
  const unique=list=>[...new Map(list.filter(item=>item.name&&!item.name.includes('@')).map(item=>[item.name,item])).values()];
  return {labels,commands:unique(commands),environments:unique(environments)};
}

function balanced(text,open){
  const close=text[open]==='{'?'}':')';let depth=0;
  for(let i=open;i<text.length;i++){const c=text[i];if(c==='\\'){i++;continue;}if(c==='{'||c==='('&&close===')')depth++;else if(c==='}'||c===')'&&close===')'){if(--depth===0)return i;}}
  return text.length;
}
const ACCENTS=/\\[`'^"~=.]\s*\{?\s*([A-Za-z])\s*\}?|\\(?:[ckvuHrdb])\s*\{\s*([A-Za-z])\s*\}/g;
export function plainBibText(value){
  return value.replace(/\\(La)?TeX\b\s*/g,(_,la)=>la?'LaTeX':'TeX').replace(ACCENTS,(_,a,b)=>a||b).replace(/\\(ss|ae|oe|aa|o|l|AE|OE|AA|O|L)\b\s*/g,'$1').replace(/\\&/g,'&').replace(/\\[A-Za-z]+\s*/g,'').replace(/[{}]/g,'').replace(/~/g,' ').replace(/\s+/g,' ').trim();
}
function fieldValues(body){
  const fields={};let i=0;
  while(i<body.length){
    const match=/[\s,]*([A-Za-z][\w-]*)\s*=\s*/y;match.lastIndex=i;
    const found=match.exec(body);if(!found){const comma=body.indexOf(',',i+1);if(comma<0)break;i=comma+1;continue;}
    let start=match.lastIndex,end,value;
    if(body[start]==='{'){end=balanced(body,start);value=body.slice(start+1,end);end++;}
    else if(body[start]==='"'){end=start+1;while(end<body.length&&body[end]!=='"'){if(body[end]==='{')end=balanced(body,end);end++;}value=body.slice(start+1,end);end++;}
    else{end=body.indexOf(',',start);if(end<0)end=body.length;value=body.slice(start,end).trim();}
    fields[found[1].toLowerCase()]=value;i=end;
  }
  return fields;
}
export function shortAuthors(value){
  const names=plainBibText(value).split(/\s+and\s+/i).map(name=>name.trim()).filter(Boolean);if(!names.length)return '';
  const last=name=>name.includes(',')?name.slice(0,name.indexOf(',')).trim():name.split(' ').at(-1);
  if(names.length===1)return last(names[0]);if(names.length===2)return `${last(names[0])} and ${last(names[1])}`;return `${last(names[0])} et al.`;
}
/** Bibliography entries in one .bib source: key, entry type and a short author/title/year. */
export function parseBib(text){
  const entries=[];
  for(const match of text.matchAll(/@\s*([A-Za-z]+)\s*([{(])/g)){
    const type=match[1].toLowerCase();if(['string','comment','preamble'].includes(type))continue;
    const open=match.index+match[0].length-1,end=balanced(text,open),body=text.slice(open+1,end),comma=body.indexOf(',');
    const key=(comma<0?body:body.slice(0,comma)).trim();if(!key||/[\s{}"#%'(),=\\~]/.test(key))continue;
    const fields=comma<0?{}:fieldValues(body.slice(comma+1)),year=(fields.year||fields.date||'').match(/\d{4}/)?.[0]||'';
    entries.push({key,type,author:shortAuthors(fields.author||fields.editor||''),title:plainBibText(fields.title||'').slice(0,160),year});
  }
  return entries;
}

const idle=globalThis.requestIdleCallback?callback=>requestIdleCallback(callback,{timeout:1500}):callback=>setTimeout(()=>{const start=performance.now();callback({timeRemaining:()=>Math.max(0,8-(performance.now()-start)),didTimeout:false});},30);

/**
 * Keeps per-file parse results for a project doc. Edits mark only their own file; the
 * work runs after `quiet` ms without edits, in idle callbacks, so typing is never blocked.
 */
export function latexIndex(doc,{quiet=250,schedule=idle,now=()=>performance.now()}={}){
  let files=new Map(),structureDirty=true,timer=0,pending=false,closed=false,version=0,cache=null,parseTime=0;
  const dirty=new Set();
  function rebuild(){
    const next=new Map();
    for(const file of projectFiles(doc)){
      const kind=fileKind(file.path),old=files.get(file.id);
      const parsed=!file.binary&&(kind==='tex'||kind==='bib');
      next.set(file.id,{id:file.id,path:file.path,kind,binary:!!file.binary,result:old?.path===file.path&&old.kind===kind?old.result:null});
      if(parsed&&!next.get(file.id).result)dirty.add(file.id);
    }
    for(const id of dirty)if(!next.has(id))dirty.delete(id);
    files=next;structureDirty=false;version++;cache=null;
  }
  function parse(id){
    const file=files.get(id);if(!file||file.binary)return;const started=now();
    const text=doc.getText(`text:${id}`).toString();
    file.result=file.kind==='bib'?{entries:parseBib(text)}:file.kind==='tex'?parseTex(text):null;
    parseTime+=now()-started;version++;cache=null;
  }
  function work(deadline){
    pending=false;if(closed)return;
    if(structureDirty)rebuild();
    for(const id of dirty){dirty.delete(id);parse(id);if(deadline&&deadline.timeRemaining()<1&&dirty.size)break;}
    if(dirty.size||structureDirty)request();
  }
  function request(){if(!pending&&!closed){pending=true;schedule(work);}}
  function later(){clearTimeout(timer);timer=setTimeout(request,quiet);}
  const observer=transaction=>{
    const changed=changedTextFiles(doc,transaction);
    if(changed===null){structureDirty=true;later();return;}
    let any=false;for(const id of changed){const file=files.get(id);if(file&&(file.kind==='tex'||file.kind==='bib')){dirty.add(id);any=true;}}
    if(any)later();
  };
  doc.on('afterTransaction',observer);request();
  function snapshot(){
    if(cache)return cache;
    const labels=[],citations=[],commands=[],environments=[],paths={tex:[],bib:[],image:[]};
    for(const file of files.values()){
      if(paths[file.kind])paths[file.kind].push(file.path);
      const result=file.result;if(!result)continue;
      for(const label of result.labels||[])labels.push({...label,path:file.path});
      for(const entry of result.entries||[])citations.push({...entry,path:file.path});
      for(const command of result.commands||[])commands.push({...command,path:file.path});
      for(const environment of result.environments||[])environments.push({...environment,path:file.path});
    }
    for(const list of Object.values(paths))list.sort();
    return cache={version,labels,citations,commands,environments,paths};
  }
  return {
    snapshot,
    /** Parse everything now (tests and the first request before idle time came). */
    flush(){clearTimeout(timer);work(null);return snapshot();},
    get ready(){return !structureDirty&&!dirty.size;},
    get parseTime(){return parseTime;},
    close(){closed=true;clearTimeout(timer);doc.off('afterTransaction',observer);},
  };
}
