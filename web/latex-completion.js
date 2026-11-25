// LaTeX autocomplete in the interaction model of Overleaf's editor: a list opens as soon as `\`
// is typed and filters as you type; `\begin{` offers environments and inserts the matching
// `\end`; inside `\ref{`, `\cite{`, `\input{`, `\includegraphics{` and `\usepackage{` it offers
// names from the project and the TeX catalog. Enter or Tab accepts, Escape closes,
// Ctrl/Cmd+Space opens it by hand. Command data loads lazily on first use.
import {autocompletion,snippet,acceptCompletion,startCompletion,completionStatus,pickedCompletion,selectedCompletion,closeCompletion,currentCompletions,moveCompletionSelection} from '@codemirror/autocomplete';
import {keymap,EditorView,ViewPlugin} from '@codemirror/view';
import {Prec,EditorState} from '@codemirror/state';
import {labelTarget,suggestLabel} from './latex-labels.js';
import {environmentTokenAt,matchingEnvironment} from './latex-environment-pair.js';

const USAGE_KEY='scribyra:latex-completion-usage',MAX_OPTIONS=80,PAGE=10;
const VERBATIM='verbatim\\*?|Verbatim\\*?|BVerbatim|LVerbatim|lstlisting|minted|comment|filecontents\\*?|alltt';

// ---- Argument kinds -------------------------------------------------------------------------
const REFS=new Set(['ref','eqref','pageref','autoref','nameref','vref','vpageref','cref','Cref','cpageref','Cpageref','crefrange','Crefrange','labelcref','namecref','nameCref','subref','hyperref']);
const FILES={input:'tex',include:'tex',subfile:'tex',includeonly:'tex',InputIfFileExists:'tex',includegraphics:'image',includesvg:'image',includepdf:'image',bibliography:'bib',addbibresource:'bib',addglobalbib:'bib'};
export function argumentKind(command){
  if(REFS.has(command))return 'label';
  if(/^(?:[a-z]*cite[a-z]*|[A-Z][a-z]*cite[a-z]*|Cite[a-z]*|nocite)$/.test(command))return 'cite';
  if(FILES[command])return FILES[command];
  if(command==='usepackage'||command==='RequirePackage')return 'package';
  if(command==='documentclass'||command==='LoadClass')return 'class';
  if(command==='bibliographystyle')return 'bibstyle';
  if(command==='begin'||command==='end')return command;
  if(command==='label')return 'newlabel';
  return null;
}
const LIST_KINDS=new Set(['label','cite','package','tex','bib']);

// ---- Context --------------------------------------------------------------------------------
/** True when `before` (the line up to the cursor) ends inside a `%` comment. */
export function inComment(before){return /(?:^|[^\\])(?:\\\\)*%/.test(before);}
/** True inside an unclosed verbatim-like environment or inline `\verb`. Looks back a bounded window. */
export function inVerbatim(text,before){
  if(/\\(?:verb|lstinline)\*?([^A-Za-z\s*{[])(?:(?!\1).)*$/.test(before))return true;
  if(!text.includes('\\begin{'))return false;
  let open=null;
  for(const match of text.matchAll(new RegExp(`\\\\(begin|end)\\s*\\{(${VERBATIM})\\}`,'g'))){
    if(match[1]==='begin'&&!open)open=match[2];else if(match[1]==='end'&&open===match[2])open=null;
  }
  return !!open;
}
/** Innermost environment still open before the cursor (bounded look-back), for `\end{`. */
export function openEnvironment(text){return openEnvironments(text).at(-1)||'';}
// Optional and key=value arguments: `\usepackage[…]{name}`, `\documentclass[…]{class}`, and the
// settings of a few packages (`\hypersetup{…}`, `\includegraphics[…]`, TikZ `[…]`).
const KEYVAL={
  '[':{usepackage:'package',RequirePackage:'package',documentclass:'class',LoadClass:'class',includegraphics:'graphicx',lstinputlisting:'listings',inputminted:'minted',mintinline:'minted',
    SI:'siunitx',si:'siunitx',num:'siunitx',qty:'siunitx',unit:'siunitx',ang:'siunitx',
    draw:'tikz',fill:'tikz',filldraw:'tikz',path:'tikz',node:'tikz',shade:'tikz',shadedraw:'tikz',clip:'tikz',coordinate:'tikz',tikz:'tikz',matrix:'tikz',edge:'tikz',pic:'tikz',child:'tikz'},
  '{':{hypersetup:'hyperref',geometry:'geometry',newgeometry:'geometry',sisetup:'siunitx',captionsetup:'caption',lstset:'listings',setminted:'minted',setlist:'enumitem',tikzset:'tikz'},
  env:{tikzpicture:'tikz',scope:'tikz',lstlisting:'listings',minted:'minted',itemize:'enumitem',enumerate:'enumitem',description:'enumitem'},
};
const blank=text=>text.replace(/(\\[\s\S])|%[^\r\n]*/g,(match,escaped)=>escaped||' '.repeat(match.length));
const escaped=(text,i)=>{let n=0;while(i-n-1>=0&&text[i-n-1]==='\\')n++;return n%2===1;};
/** Items of a key=value list split at top-level commas: [{text, start}]. */
export function splitItems(text){
  const items=[];let depth=0,start=0;
  for(let i=0;i<text.length;i++){const c=text[i];if(escaped(text,i))continue;if(c==='{'||c==='[')depth++;else if(c==='}'||c===']')depth--;else if(c===','&&depth===0){items.push({text:text.slice(start,i),start});start=i+1;}}
  items.push({text:text.slice(start),start});return items;
}
/**
 * Inside the options of a package, class or key=value command: which option set, the item being
 * typed (a name, or a value after `key=`), and the names already given. Null elsewhere.
 */
export function optionContext(doc,pos){
  const start=Math.max(0,pos-3000),before=blank(doc.sliceString(start,pos));
  let open=-1;
  for(let i=before.length-1,depth=0;i>=0;i--){const c=before[i];if(!'{}[]'.includes(c)||escaped(before,i))continue;if(c==='}'||c===']')depth++;else if(depth)depth--;else{open=i;break;}}
  if(open<0)return null;
  const char=before[open],head=before.slice(Math.max(0,open-300),open);let set=null,match;
  if(char==='['&&(match=/\\begin\s*\{([^{}\\]+)\}\s*$/.exec(head)))set=KEYVAL.env[match[1]]&&{type:'keys',names:[KEYVAL.env[match[1]]]};
  else if(char==='['&&(match=/(?:\\([A-Za-z]+)\*?|(?:^|[^\\A-Za-z])(node|edge|pic|child|coordinate))\s*(?:\([^()]*\)\s*)?$/.exec(head))){
    const command=match[1]||match[2],kind=KEYVAL['['][command];
    if(kind)set=kind==='package'||kind==='class'?{type:kind,names:[]}:{type:'keys',names:[kind]};
  }else if(char==='{'&&(match=/\\([A-Za-z]+)\*?\s*(?:\[[^\]]*\]\s*)?$/.exec(head))&&KEYVAL['{'][match[1]])set={type:'keys',names:[KEYVAL['{'][match[1]]]};
  if(!set)return null;
  const typed=before.slice(open+1),after=blank(doc.sliceString(pos,Math.min(doc.length,pos+3000)));
  const items=splitItems(typed),current=items.at(-1),tailMatch=/^[^,=[\]{}\s]*/.exec(after)[0];
  // Where the group closes, and (for packages and classes) the names after it.
  let close='',rest=after.slice(tailMatch.length),closer=-1;
  for(let i=0,depth=0;i<rest.length;i++){const c=rest[i];if(!'{}[]'.includes(c)||escaped(rest,i))continue;if(c==='{'||c==='[')depth++;else if(depth)depth--;else{closer=c===(char==='['?']':'}')?i:-2;break;}}
  if(set.type!=='keys'){
    const direct=/^\s*\{([^{}]*)\}/.exec(rest);
    if(direct&&(closer<0||rest.indexOf('{')<closer)){close=']';closer=-1;set.names=direct[1].split(',').map(n=>n.trim()).filter(Boolean);}
    else if(closer>=0){const names=/^\s*\{([^{}]*)\}/.exec(rest.slice(closer+1));if(!names)return null;set.names=names[1].split(',').map(n=>n.trim()).filter(Boolean);}
    else return null;
  }
  const others=[...items.slice(0,-1),...(closer>=0?splitItems(rest.slice(0,closer)).slice(1):[])].map(item=>item.text.split('=')[0].trim()).filter(Boolean);
  const itemFrom=start+open+1+current.start,lead=/^\s*/.exec(current.text)[0].length,text=current.text.slice(lead);
  const equals=text.indexOf('=');
  if(equals>=0){const valueLead=/^\s*/.exec(text.slice(equals+1))[0].length;return {kind:'option',set,key:text.slice(0,equals).trim(),from:itemFrom+lead+equals+1+valueLead,to:pos+tailMatch.length,query:text.slice(equals+1+valueLead),present:others,close};}
  return {kind:'option',set,key:null,from:itemFrom+lead,to:pos+tailMatch.length,query:text,present:others,close};
}

/**
 * What is being completed at `pos`: a command name after `\`, or an argument of a known
 * command. Returns null in comments and verbatim text, or when nothing applies.
 */
export function latexContext(doc,pos,{lookBack=30000}={}){
  const line=doc.lineAt(pos),offset=pos-line.from,before=line.text.slice(Math.max(0,offset-400),offset),after=line.text.slice(offset,offset+200);
  if(inComment(before))return null;
  const window=doc.sliceString(Math.max(0,pos-lookBack),pos);
  if(inVerbatim(window,before))return null;
  const command=/\\([A-Za-z]*)$/.exec(before);
  if(command){
    let slashes=0;for(let i=before.length-command[0].length;i>=0&&before[i]==='\\';i--)slashes++;
    if(slashes%2===1){const tail=/^[A-Za-z]*\*?/.exec(after)[0];return {kind:'command',from:pos-command[0].length,to:pos+tail.length,query:command[1]};}
  }
  const option=optionContext(doc,pos);if(option)return option;
  const arg=/\\([A-Za-z]+)\*?\s*((?:\[[^[\]]*\]\s*|\([^()]*\)\s*)*)\{([^{}\\]*)$/.exec(before);
  if(!arg)return null;
  const kind=argumentKind(arg[1]);if(!kind)return null;
  let query=arg[3],from=pos-query.length;
  if(LIST_KINDS.has(kind)){const comma=query.lastIndexOf(',');if(comma>=0){from+=comma+1;query=query.slice(comma+1);}const lead=/^\s*/.exec(query)[0].length;from+=lead;query=query.slice(lead);}
  const tail=/^[^{}\s,\\]*/.exec(after)[0],closed=after[tail.length]==='}';
  return {kind,command:arg[1],from,to:pos+tail.length,query,closed,commandFrom:pos-arg[0].length,environment:kind==='end'?openEnvironment(window):''};
}
/** Environments still open before the cursor, innermost last. */
export function openEnvironments(text){
  const stack=[];
  for(const match of text.matchAll(/\\(begin|end)\s*\{([^{}\\]+)\}/g)){if(match[1]==='begin')stack.push(match[2]);else{const at=stack.lastIndexOf(match[2]);if(at>=0)stack.length=at;}}
  return stack;
}

// ---- Ranking --------------------------------------------------------------------------------
const wordStart=(label,i)=>i===0||!/[A-Za-z0-9]/.test(label[i-1])||(/[A-Z]/.test(label[i])&&/[a-z]/.test(label[i-1]));
/**
 * How well `query` matches `label`: exact-case prefix, any-case prefix, a word inside the
 * label, any substring, then an in-order subsequence that starts at the first letter.
 * Returns {score, ranges} (ranges as [from, to, …] in the label) or null.
 */
export function matchLabel(label,query){
  if(!query)return {score:0,ranges:[]};
  if(label.startsWith(query))return {score:1000,ranges:[0,query.length]};
  const lower=label.toLowerCase(),q=query.toLowerCase();
  if(lower.startsWith(q))return {score:900,ranges:[0,q.length]};
  if(q.length>=2){
    let first=-1;
    for(let i=lower.indexOf(q,1);i>=0;i=lower.indexOf(q,i+1)){if(wordStart(label,i))return {score:600,ranges:[i,i+q.length]};if(first<0)first=i;}
    if(first>=0)return {score:500,ranges:[first,first+q.length]};
  }
  if(lower[0]!==q[0])return null;
  const ranges=[];let at=0,gaps=0;
  for(const c of q){const i=lower.indexOf(c,at);if(i<0)return null;if(i>at)gaps++;if(ranges.length&&ranges.at(-1)===i)ranges[ranges.length-1]=i+1;else ranges.push(i,i+1);at=i+1;}
  return {score:300-gaps*10-(at-q.length),ranges};
}
/** Ranked, limited options: match quality first, then frequency (data rank plus personal use), then length. */
export function rankItems(items,query,{usage={},limit=MAX_OPTIONS}={}){
  const ranked=[];
  for(const item of items){
    const match=matchLabel(item.match??item.label,query);if(!match)continue;
    const used=usage[item.usageKey??item.label]||0;
    ranked.push({item,ranges:match.ranges,score:match.score+(item.rank||0)+Math.min(60,used*12)-(item.match??item.label).length*.25});
  }
  ranked.sort((a,b)=>b.score-a.score||(a.item.label<b.item.label?-1:a.item.label>b.item.label?1:0));
  return ranked.slice(0,limit);
}

// ---- Snippets -------------------------------------------------------------------------------
/** The argument shape a person reads: `{title}` for `{${title}}`. */
export function shapeOf(template){return template.replace(/[#$]\{(?:\d+:)?((?:\\[{}]|[^{}])*)\}/g,'$1').replace(/\\([{}])/g,'$1');}
export function environmentTemplate(name,args,body){return `\\begin{${name}}${args}\n${body||'\t${}'}\n\\end{${name}}`;}
const escapeName=name=>name.replace(/[{}]/g,'\\$&');

// ---- Data -----------------------------------------------------------------------------------
let catalogPromise=null,loadedCatalog=null;
export function buildCatalog({COMMANDS,ENVIRONMENTS,CLASSES,BIBSTYLES},packageNames=[],options={}){
  const commands=COMMANDS.map(([name,template,description,pkg,rank])=>({label:'\\'+name,match:name,name,template,detail:shapeOf(template),description,source:pkg||'LaTeX',rank,usageKey:'\\'+name+template}));
  // Packages the curated data mentions, and a few more that most documents load, rank first.
  const popular=new Set([...COMMANDS.map(c=>c[3]),...ENVIRONMENTS.map(e=>e[4]),'inputenc','fontenc','babel','fontspec','lmodern','microtype','float','caption','enumitem','fancyhdr','setspace','url','mathtools','csquotes','lipsum','pgfplots','xparse','titlesec','tocbibind','parskip','polyglossia','textcomp','soul','todonotes','algorithm2e','algorithmicx','listings','appendix']);
  const environments=ENVIRONMENTS.map(([name,args,body,description,pkg,rank])=>({label:name,name,args,body,description,source:pkg||'LaTeX',rank}));
  return {commands,environments,builtins:new Set(COMMANDS.map(c=>c[0])),
    classes:CLASSES.map(([label,description])=>({label,description,source:'class'})),
    bibstyles:BIBSTYLES.map(([label,description])=>({label,description,source:'BibTeX style'})),
    packages:packageNames.map(label=>({label,source:'TeX Live',rank:popular.has(label)?40:0})),
    options:{PACKAGE_OPTIONS:options.PACKAGE_OPTIONS||{},CLASS_OPTIONS:options.CLASS_OPTIONS||{},KEYS:options.KEYS||{}}};
}
export function loadCompletionCatalog(){
  return catalogPromise||=Promise.all([import('./latex-completion-data.js'),import('./latex-packages.js'),import('./latex-options-data.js')]).then(([data,packages,options])=>buildCatalog(data,packages.default.packages,options)).catch(error=>{catalogPromise=null;throw error;});
}

// ---- Usage ----------------------------------------------------------------------------------
let usageCache=null;
function readUsage(){if(usageCache)return usageCache;try{usageCache=JSON.parse(localStorage.getItem(USAGE_KEY))||{};}catch{usageCache={};}if(typeof usageCache!=='object'||Array.isArray(usageCache))usageCache={};return usageCache;}
function recordUse(key){
  const usage=readUsage();usage[key]=(usage[key]||0)+1;
  const keys=Object.keys(usage);if(keys.length>300)for(const old of keys.sort((a,b)=>usage[a]-usage[b]).slice(0,keys.length-300))delete usage[old];
  try{localStorage.setItem(USAGE_KEY,JSON.stringify(usage));}catch{}
}

// ---- Options --------------------------------------------------------------------------------
function insertSnippet(template,usageKey){
  const apply=snippet(template);
  return (view,completion,from,to)=>{apply(view,completion,from,to);if(usageKey)recordUse(usageKey);};
}
function commandOption(item,ranges,brace){
  // Text already typed after the name (an opening brace or bracket) is kept, never doubled.
  const template=brace&&/^[{[(]/.test(item.template)?'':item.template;
  return {label:item.label,detail:item.detail,type:'command',description:item.description,source:item.source,ranges:ranges.map(r=>r+1),complete:!template,
    apply:insertSnippet('\\'+escapeName(item.name)+template,item.usageKey)};
}
function environmentOption(item,ranges,{from,to,label=item.label}){
  return {label,detail:item.args?shapeOf(item.args):'',type:'environment',description:item.description,source:item.source,ranges,
    apply:(view,completion)=>insertSnippet(environmentTemplate(escapeName(item.name),item.args,item.body),'env:'+item.name)(view,completion,from,to)};
}
function valueOption(label,{detail='',description='',source='',ranges,insert,from,to,closed}){
  return {label,detail,description,source,type:'text',ranges,apply:(view,completion)=>{
    // A closing brace already there is kept (not deleted, not doubled); the cursor goes past it.
    view.dispatch({changes:{from,to,insert:closed?insert:insert+'}'},selection:{anchor:from+insert.length+1},annotations:pickedCompletion.of(completion),userEvent:'input.complete',scrollIntoView:true});
  }};
}
/** An environment name typed in place, keeping the closing brace: the paired `\end` follows by itself. */
function nameOption(label,{description='',source='',ranges,from,to,closed,type='environment'}){
  return {label,description,source,type,ranges,apply:(view,completion)=>{
    view.dispatch({changes:{from,to,insert:closed?label:label+'}'},selection:{anchor:from+label.length+1},annotations:pickedCompletion.of(completion),userEvent:'input.complete',scrollIntoView:true});
  }};
}
const valuesHint=values=>{const names=values.map(v=>Array.isArray(v)?v[0]:v);return '= '+names.slice(0,3).join(' | ')+(names.length>3?' | …':'');};
function optionOption(label,{detail='',description='',source='',ranges,from,to,close='',reopen=false}){
  return {label,detail,description,source,type:'text',ranges,apply:(view,completion)=>{
    view.dispatch({changes:{from,to,insert:label+close},selection:{anchor:from+label.length},annotations:pickedCompletion.of(completion),userEvent:'input.complete',scrollIntoView:true});
    // A key with known values goes straight on to them.
    if(reopen)startCompletion(view);
  }};
}
/** The options of a package, class or key=value command, each with the name it came from. */
export function optionEntries(options,set){
  const table=set.type==='package'?options.PACKAGE_OPTIONS:set.type==='class'?options.CLASS_OPTIONS:options.KEYS,seen=new Set(),entries=[];
  for(const name of set.names)for(const [option,description,values] of table[name]||[]){
    if(seen.has(option))continue;seen.add(option);
    entries.push({name:option,description,values,source:set.type==='class'?`${name} class`:name==='tikz'?'TikZ':name});
  }
  return entries;
}
function projectCommandItems(index,catalog){
  return index.commands.filter(c=>!catalog.builtins.has(c.name)).map(c=>{
    const args=c.optional?['[${optional}]',...Array.from({length:Math.max(0,c.args-1)},(_,i)=>`{\${arg${i+1}}}`)]:Array.from({length:c.args},(_,i)=>`{\${arg${i+1}}}`);
    const template=args.join('');
    return {label:'\\'+c.name,match:c.name,name:c.name,template,detail:shapeOf(template),description:c.plugin?`Command from the ${c.plugin} plugin`:`${c.operator?'Math operator':'Command'} defined in ${c.path}:${c.line}`,source:c.plugin?`${c.plugin} plugin`:'this project',rank:50,usageKey:'\\'+c.name};
  });
}
function projectEnvironmentItems(index,catalog){
  const known=new Set(catalog.environments.map(e=>e.name));
  return index.environments.filter(e=>!known.has(e.name)).map(e=>({label:e.name,name:e.name,args:Array.from({length:Math.max(0,e.args)},(_,i)=>`{\${arg${i+1}}}`).join(''),body:'',description:e.plugin?`Environment from the ${e.plugin} plugin`:`${e.theorem?'Theorem-like environment':'Environment'} defined in ${e.path}:${e.line}`,source:e.plugin?`${e.plugin} plugin`:'this project',rank:50}));
}
const relativeTex=path=>path.replace(/\.tex$/i,'');

/** Options for a context, ranked. Pure apart from the usage map; exported for tests. */
export function completionOptions(context,catalog,index,{usage={},currentPath='',currentLine=0,nextChar='',target=null,pairedEnd=false,present=[]}={}){
  if(context.kind==='command'){
    const items=[...catalog.commands,...projectCommandItems(index,catalog)];
    let ranked=rankItems(items,context.query,{usage}).map(({item,ranges})=>commandOption(item,ranges,nextChar==='{'||nextChar==='['));
    // `\begin` on its own also offers whole environments, as `\begin{itemize}`.
    if(context.query.length>=2&&'begin'.startsWith(context.query)){
      const environments=[...catalog.environments,...projectEnvironmentItems(index,catalog)].map(e=>({...e,match:'begin',rank:e.rank-60}));
      const extra=rankItems(environments,context.query,{usage:Object.fromEntries(Object.entries(usage).filter(([k])=>k.startsWith('env:')).map(([k,v])=>[k.slice(4),v]))}).slice(0,24)
        .map(({item})=>environmentOption(item,[1,1+context.query.length],{from:context.from,to:context.to,label:`\\begin{${item.name}}`}));
      ranked=[...ranked.slice(0,1),...extra,...ranked.slice(1)];
    }
    return ranked;
  }
  const value={from:context.from,to:context.to,closed:context.closed};
  switch(context.kind){
    case 'begin':case 'end':{
      // `\end{` ranks the innermost open environment first, then the ones around it.
      const open=context.environments||(context.environment?[context.environment]:[]);
      const boost=name=>{const at=open.lastIndexOf(name);return at<0?0:at===open.length-1?2000:1000+at;};
      const items=[...catalog.environments,...projectEnvironmentItems(index,catalog)].map(e=>({...e,rank:e.rank+(context.kind==='end'?boost(e.name):0)}));
      const envUsage=Object.fromEntries(Object.entries(usage).filter(([k])=>k.startsWith('env:')).map(([k,v])=>[k.slice(4),v]));
      return rankItems(items,context.query,{usage:envUsage}).map(({item,ranges})=>context.kind==='begin'&&!pairedEnd
        ?environmentOption(item,ranges,{from:context.commandFrom,to:context.closed?context.to+1:context.to})
        :context.closed?nameOption(item.name,{description:item.description,source:item.source,ranges,from:context.from,to:context.to,closed:true})
        :valueOption(item.name,{description:item.description,source:item.source,ranges,insert:item.name,...value}));
    }
    case 'newlabel':{
      if(!target)return [];
      const keys=index.labels.filter(l=>!(l.path===currentPath&&l.line===currentLine)).map(l=>l.key),{key,description}=suggestLabel(target,keys);
      return rankItems([{label:key}],context.query).map(({ranges})=>valueOption(key,{description,source:'new label',ranges,insert:key,...value}));
    }
    case 'option':{
      const entries=optionEntries(catalog.options,context.set),span={from:context.from,to:context.to,close:context.close};
      if(context.key!==null){
        const entry=entries.find(e=>e.name===context.key+'=');if(!entry?.values)return [];
        // The curated order (most used first) decides among equal matches.
        return rankItems(entry.values.map((v,i,all)=>Array.isArray(v)?{label:v[0],description:v[1],rank:all.length-i}:{label:v,rank:all.length-i}),context.query)
          .map(({item,ranges})=>optionOption(item.label,{description:item.description||`Value of ${context.key}`,source:entry.source,ranges,...span}));
      }
      const given=new Set(context.present);
      return rankItems(entries.filter(e=>!given.has(e.name.replace(/=$/,''))).map((e,i,all)=>({...e,label:e.name,rank:(all.length-i)/2})),context.query)
        .map(({item,ranges})=>optionOption(item.name,{detail:item.values?valuesHint(item.values):'',description:item.description,source:item.source,ranges,reopen:!!item.values,...span}));
    }
    case 'label':return rankItems(index.labels.filter(l=>!present.includes(l.key)).map(l=>({label:l.key,rank:l.path===currentPath?5:0,l})),context.query).map(({item,ranges})=>valueOption(item.label,{description:`${item.l.path}:${item.l.line}`,source:'label',ranges,insert:item.label,...value}));
    case 'cite':return rankItems(index.citations.filter(c=>!present.includes(c.key)).map(c=>({label:c.key,c})),context.query).map(({item:{label,c},ranges})=>valueOption(label,{detail:[c.author,c.year].filter(Boolean).join(', '),description:c.title||c.type,source:c.path,ranges,insert:label,...value}));
    case 'tex':return rankItems(index.paths.tex.filter(p=>/\.tex$/i.test(p)&&p!==currentPath).map(p=>({label:relativeTex(p)})),context.query).map(({item,ranges})=>valueOption(item.label,{source:'file',ranges,insert:item.label,...value}));
    case 'image':return rankItems(index.paths.image.map(p=>({label:p})),context.query).map(({item,ranges})=>valueOption(item.label,{source:'image',ranges,insert:item.label,...value}));
    case 'bib':{const keep=context.command!=='bibliography';return rankItems(index.paths.bib.map(p=>({label:keep?p:p.replace(/\.bib$/i,'')})),context.query).map(({item,ranges})=>valueOption(item.label,{source:'bibliography',ranges,insert:item.label,...value}));}
    case 'package':return rankItems(catalog.packages,context.query,{usage:Object.fromEntries(Object.entries(usage).filter(([k])=>k.startsWith('pkg:')).map(([k,v])=>[k.slice(4),v]))}).map(({item,ranges})=>{const option=valueOption(item.label,{source:item.source,ranges,insert:item.label,...value}),apply=option.apply;option.apply=(view,completion)=>{apply(view,completion);recordUse('pkg:'+item.label);};return option;});
    case 'class':return rankItems(catalog.classes,context.query).map(({item,ranges})=>valueOption(item.label,{description:item.description,source:item.source,ranges,insert:item.label,...value}));
    case 'bibstyle':return rankItems(catalog.bibstyles,context.query).map(({item,ranges})=>valueOption(item.label,{description:item.description,source:item.source,ranges,insert:item.label,...value}));
  }
  return [];
}

const EMPTY_INDEX={labels:[],citations:[],commands:[],environments:[],paths:{tex:[],bib:[],image:[]}};
/**
 * The CodeMirror extension. `index()` returns the project index (or null); `currentPath()`
 * names the open file. Read-only editors (Viewing) get no completions at all.
 */
export function latexCompletion({index=()=>null,currentPath=()=>''}={}){
  const build=(context,latex,started)=>{
    const {state}=context,project=index();
    const options=completionOptions(latex,loadedCatalog,project?.snapshot()||EMPTY_INDEX,{usage:readUsage(),currentPath:currentPath(),nextChar:state.sliceDoc(latex.to,latex.to+1),...documentFacts(state,latex,context.pos)});
    // Position in the whole list: only a page of it is rendered at a time.
    options.forEach((option,i)=>{option.position=i+1;option.total=options.length;});
    // Measured per request; read with performance.getEntriesByName('latex-completion').
    try{performance.clearMeasures('latex-completion');performance.measure('latex-completion',{start:started,end:performance.now()});}catch{}
    if(!options.length)return null;
    return {from:latex.from,to:latex.to,options,filter:false,getMatch:option=>option.ranges};
  };
  // Synchronous once the data is loaded, so the list follows each keystroke in the same update.
  const source=context=>{
    const {state}=context;
    if(state.readOnly||context.view?.composing)return null;
    const started=performance.now(),latex=latexContext(state.doc,context.pos);
    // Typing ordinary words never opens it; `\`, an argument brace or Ctrl+Space do.
    if(!latex)return null;
    if(loadedCatalog)return build(context,latex,started);
    return loadCompletionCatalog().then(catalog=>{loadedCatalog=catalog;return context.aborted?null:build(context,latex,performance.now());});
  };
  const pause=()=>{const span=document.createElement('span');span.className='sr-only';span.textContent=', ';return span;};
  const render=(className,field)=>({position:className==='cm-completionSource'?85:90,render(option){
    if(!option[field])return null;const span=document.createElement('span');span.className=className;
    span.append(pause(),option[field]);return span;}});
  // Options are named by their visible text, read with pauses: `\section{title}, LaTeX, Numbered
  // section heading` (the description is shown, and so read, for the selected option). A label and a
  // detail that are separate words (`knuth1984`, `Knuth, 1984`) get a pause between them too.
  const detailPause={position:70,render:option=>option.type==='text'&&option.detail?pause():null};
  // Only a page of the list is rendered at a time, so each option carries its place in the whole list.
  const place={position:100,render(option){
    const mark=document.createElement('span');mark.hidden=true;
    queueMicrotask(()=>{const li=mark.parentElement;if(li&&option.position){li.setAttribute('aria-posinset',String(option.position));li.setAttribute('aria-setsize',String(option.total));}});
    return mark;}};
  return [
    // Before autocompletion's own keymap, which shares the highest precedence.
    Prec.highest(keymap.of([
      {key:'Tab',run:view=>completionStatus(view.state)==='active'&&acceptCompletion(view)},
      // `\item` typed in full needs nothing more: Enter closes the list and starts a new line.
      {key:'Enter',run:view=>{
        if(completionStatus(view.state)!=='active')return false;const option=selectedCompletion(view.state),{head}=view.state.selection.main;
        if(!option?.complete||view.state.sliceDoc(head-option.label.length,head)!==option.label||/[A-Za-z]/.test(view.state.sliceDoc(head,head+1)))return false;
        closeCompletion(view);return false;
      }},
      {key:'Mod-Space',run:view=>!view.state.readOnly&&startCompletion(view)},
    ])),
    // The list shows a page of options and never scrolls by itself: the editor keeps focus and moves
    // through it (aria-activedescendant), so there is no scrollable region that only a mouse could reach.
    autocompletion({override:[source],activateOnTyping:true,activateOnTypingDelay:20,icons:false,closeOnBlur:true,maxRenderedOptions:PAGE,
      tooltipClass:()=>'latex-completions',optionClass:option=>`latex-completion-${option.type||'text'}`,
      addToOptions:[detailPause,render('cm-completionSource','source'),render('cm-completionDescription','description'),place]}),
    EditorState.phrases.of({Completions:'LaTeX suggestions'}),
    completionAnnouncer,
  ];
}
/** Facts only the document can tell: the label target, the paired `\end`, open environments, list keys. */
function documentFacts(state,latex,pos){
  const facts={currentLine:state.doc.lineAt(pos).number};
  if(latex.kind==='newlabel')facts.target=labelTarget(state.sliceDoc(Math.max(0,latex.commandFrom-30000),latex.commandFrom),state.sliceDoc(latex.to,latex.to+4000));
  if(latex.kind==='begin'&&latex.closed){const token=environmentTokenAt(state.doc,latex.from,latex.to);facts.pairedEnd=!!(token&&matchingEnvironment(state.doc,token));}
  if(latex.kind==='end')latex.environments=openEnvironments(state.sliceDoc(Math.max(0,pos-30000),pos));
  if(latex.kind==='cite'||latex.kind==='label'){
    const typed=state.sliceDoc(latex.commandFrom,latex.from),open=typed.lastIndexOf('{'),rest=/^[^{}]*/.exec(state.sliceDoc(latex.to,latex.to+400))[0];
    facts.present=[...typed.slice(open+1).split(','),...rest.split(',').slice(1)].map(k=>k.trim()).filter(Boolean);
  }
  return facts;
}
/**
 * Polite announcements for screen readers, through the editor's own live region: how many
 * suggestions there are (after typing pauses), what was inserted, and that Escape closed the list.
 */
const completionAnnouncer=ViewPlugin.fromClass(class{
  constructor(view){
    this.view=view;this.count=0;this.timer=0;this.escape=false;this.wheel=0;
    this.onKey=event=>{if(event.key==='Escape'&&completionStatus(view.state)==='active')this.escape=true;};
    // Wheel over the list moves the selection, as the list itself does not scroll.
    this.onWheel=event=>{
      if(!event.target.closest?.('.cm-tooltip-autocomplete')||completionStatus(view.state)!=='active')return;
      event.preventDefault();this.wheel+=event.deltaMode?event.deltaY*20:event.deltaY;
      while(Math.abs(this.wheel)>=40){moveCompletionSelection(this.wheel>0)(view);this.wheel-=Math.sign(this.wheel)*40;}
    };
    view.contentDOM.addEventListener('keydown',this.onKey,true);view.dom.addEventListener('wheel',this.onWheel,{passive:false});
  }
  update(update){
    const picked=update.transactions.map(tr=>tr.annotation(pickedCompletion)).find(Boolean);
    const active=completionStatus(update.state)==='active',count=active?currentCompletions(update.state).length:0;
    if(picked){this.count=0;this.escape=false;this.say(`Inserted ${picked.label}${picked.type==='command'&&picked.detail?picked.detail:''}`);return;}
    if(!active&&completionStatus(update.state)!=='pending'){if(this.count&&this.escape)this.say('Suggestions closed');else if(this.count)clearTimeout(this.timer);this.count=0;this.escape=false;return;}
    if(active&&count!==this.count){this.count=count;clearTimeout(this.timer);this.timer=setTimeout(()=>{
      if(completionStatus(this.view.state)!=='active')return;const n=currentCompletions(this.view.state).length;
      this.say(`${n} suggestion${n===1?'':'s'}`);
    },350);}
  }
  say(text){clearTimeout(this.timer);setTimeout(()=>{if(this.view.dom.isConnected)this.view.dispatch({effects:EditorView.announce.of(text)});},0);}
  destroy(){clearTimeout(this.timer);this.view.contentDOM.removeEventListener('keydown',this.onKey,true);this.view.dom.removeEventListener('wheel',this.onWheel);}
});
/** Load the command data in idle time so the first `\` finds it ready. */
export function prefetchCompletionData(){const start=()=>loadCompletionCatalog().catch(()=>{});if(globalThis.requestIdleCallback)requestIdleCallback(start,{timeout:3000});else setTimeout(start,1500);}
