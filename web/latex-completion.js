// LaTeX autocomplete in the interaction model of Overleaf's editor: a list opens as soon as `\`
// is typed and filters as you type; `\begin{` offers environments and inserts the matching
// `\end`; inside `\ref{`, `\cite{`, `\input{`, `\includegraphics{` and `\usepackage{` it offers
// names from the project and the TeX catalog. Enter or Tab accepts, Escape closes,
// Ctrl/Cmd+Space opens it by hand. Command data loads lazily on first use.
import {autocompletion,snippet,acceptCompletion,startCompletion,completionStatus,pickedCompletion} from '@codemirror/autocomplete';
import {keymap} from '@codemirror/view';
import {Prec} from '@codemirror/state';

const USAGE_KEY='scribyra:latex-completion-usage',MAX_OPTIONS=80;
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
export function openEnvironment(text){
  const stack=[];
  for(const match of text.matchAll(/\\(begin|end)\s*\{([^{}\\]+)\}/g)){if(match[1]==='begin')stack.push(match[2]);else{const at=stack.lastIndexOf(match[2]);if(at>=0)stack.length=at;}}
  return stack.at(-1)||'';
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
  const arg=/\\([A-Za-z]+)\*?\s*((?:\[[^[\]]*\]\s*|\([^()]*\)\s*)*)\{([^{}\\]*)$/.exec(before);
  if(!arg)return null;
  const kind=argumentKind(arg[1]);if(!kind)return null;
  let query=arg[3],from=pos-query.length;
  if(LIST_KINDS.has(kind)){const comma=query.lastIndexOf(',');if(comma>=0){from+=comma+1;query=query.slice(comma+1);}const lead=/^\s*/.exec(query)[0].length;from+=lead;query=query.slice(lead);}
  const tail=/^[^{}\s,\\]*/.exec(after)[0],closed=after[tail.length]==='}';
  return {kind,command:arg[1],from,to:pos+tail.length,query,closed,commandFrom:pos-arg[0].length,environment:kind==='end'?openEnvironment(window):''};
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
let catalogPromise=null;
export function buildCatalog({COMMANDS,ENVIRONMENTS,CLASSES,BIBSTYLES},packageNames=[]){
  const commands=COMMANDS.map(([name,template,description,pkg,rank])=>({label:'\\'+name,match:name,name,template,detail:shapeOf(template),description,source:pkg||'LaTeX',rank,usageKey:'\\'+name+template}));
  // Packages the curated data mentions, and a few more that most documents load, rank first.
  const popular=new Set([...COMMANDS.map(c=>c[3]),...ENVIRONMENTS.map(e=>e[4]),'inputenc','fontenc','babel','fontspec','lmodern','microtype','float','caption','enumitem','fancyhdr','setspace','url','mathtools','csquotes','lipsum','pgfplots','xparse','titlesec','tocbibind','parskip','polyglossia','textcomp','soul','todonotes','algorithm2e','algorithmicx','listings','appendix']);
  const environments=ENVIRONMENTS.map(([name,args,body,description,pkg,rank])=>({label:name,name,args,body,description,source:pkg||'LaTeX',rank}));
  return {commands,environments,builtins:new Set(COMMANDS.map(c=>c[0])),
    classes:CLASSES.map(([label,description])=>({label,description,source:'class'})),
    bibstyles:BIBSTYLES.map(([label,description])=>({label,description,source:'BibTeX style'})),
    packages:packageNames.map(label=>({label,source:'TeX Live',rank:popular.has(label)?40:0}))};
}
export function loadCompletionCatalog(){
  return catalogPromise||=Promise.all([import('./latex-completion-data.js'),import('./latex-packages.js')]).then(([data,packages])=>buildCatalog(data,packages.default.packages)).catch(error=>{catalogPromise=null;throw error;});
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
  return {label:item.label,detail:item.detail,type:'command',description:item.description,source:item.source,ranges:ranges.map(r=>r+1),
    apply:insertSnippet('\\'+escapeName(item.name)+template,item.usageKey)};
}
function environmentOption(item,ranges,{from,to,label=item.label}){
  return {label,detail:item.args?shapeOf(item.args):'',type:'environment',description:item.description,source:item.source,ranges,
    apply:(view,completion)=>insertSnippet(environmentTemplate(escapeName(item.name),item.args,item.body),'env:'+item.name)(view,completion,from,to)};
}
function valueOption(label,{detail='',description='',source='',ranges,insert,from,to,closed}){
  return {label,detail,description,source,type:'text',ranges,apply:(view,completion)=>{
    const text=insert+(closed?'':'}');
    view.dispatch({changes:{from,to:closed?to+1:to,insert:text},selection:{anchor:from+text.length},annotations:pickedCompletion.of(completion),userEvent:'input.complete',scrollIntoView:true});
  }};
}
function projectCommandItems(index,catalog){
  return index.commands.filter(c=>!catalog.builtins.has(c.name)).map(c=>{
    const args=c.optional?['[${optional}]',...Array.from({length:Math.max(0,c.args-1)},(_,i)=>`{\${arg${i+1}}}`)]:Array.from({length:c.args},(_,i)=>`{\${arg${i+1}}}`);
    const template=args.join('');
    return {label:'\\'+c.name,match:c.name,name:c.name,template,detail:shapeOf(template),description:`${c.operator?'Math operator':'Command'} defined in ${c.path}:${c.line}`,source:'this project',rank:50,usageKey:'\\'+c.name};
  });
}
function projectEnvironmentItems(index,catalog){
  const known=new Set(catalog.environments.map(e=>e.name));
  return index.environments.filter(e=>!known.has(e.name)).map(e=>({label:e.name,name:e.name,args:Array.from({length:Math.max(0,e.args)},(_,i)=>`{\${arg${i+1}}}`).join(''),body:'',description:`${e.theorem?'Theorem-like environment':'Environment'} defined in ${e.path}:${e.line}`,source:'this project',rank:50}));
}
const relativeTex=path=>path.replace(/\.tex$/i,'');

/** Options for a context, ranked. Pure apart from the usage map; exported for tests. */
export function completionOptions(context,catalog,index,{usage={},currentPath='',nextChar=''}={}){
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
      const items=[...catalog.environments,...projectEnvironmentItems(index,catalog)].map(e=>({...e,rank:e.rank+(e.name===context.environment?2000:0)}));
      const envUsage=Object.fromEntries(Object.entries(usage).filter(([k])=>k.startsWith('env:')).map(([k,v])=>[k.slice(4),v]));
      return rankItems(items,context.query,{usage:envUsage}).map(({item,ranges})=>context.kind==='begin'
        ?environmentOption(item,ranges,{from:context.commandFrom,to:context.closed?context.to+1:context.to})
        :valueOption(item.name,{description:item.description,source:item.source,ranges,insert:item.name,...value}));
    }
    case 'label':return rankItems(index.labels.map(l=>({label:l.key,rank:l.path===currentPath?5:0,l})),context.query).map(({item,ranges})=>valueOption(item.label,{description:`${item.l.path}:${item.l.line}`,source:'label',ranges,insert:item.label,...value}));
    case 'cite':return rankItems(index.citations.map(c=>({label:c.key,c})),context.query).map(({item:{label,c},ranges})=>valueOption(label,{detail:[c.author,c.year].filter(Boolean).join(', '),description:c.title||c.type,source:c.path,ranges,insert:label,...value}));
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
  const source=async context=>{
    const {state}=context;
    if(state.readOnly||context.view?.composing)return null;
    const latex=latexContext(state.doc,context.pos);if(!latex)return null;
    // Typing ordinary words never opens it; `\`, an argument brace or Ctrl+Space do.
    const catalog=await loadCompletionCatalog();
    if(context.aborted)return null;
    const started=performance.now(),project=index();
    const options=completionOptions(latex,catalog,project?.snapshot()||EMPTY_INDEX,{usage:readUsage(),currentPath:currentPath(),nextChar:state.sliceDoc(latex.to,latex.to+1)});
    // Measured per request; read with performance.getEntriesByName('latex-completion').
    try{performance.clearMeasures('latex-completion');performance.measure('latex-completion',{start:started,end:performance.now()});}catch{}
    if(!options.length)return null;
    return {from:latex.from,to:latex.to,options,filter:false,getMatch:option=>option.ranges};
  };
  const render=(className,field)=>({position:className==='cm-completionSource'?85:90,render(option){
    if(!option[field])return null;const span=document.createElement('span');span.className=className;
    const pause=document.createElement('span');pause.className='sr-only';pause.textContent=', ';span.append(pause,option[field]);return span;}});
  return [
    autocompletion({override:[source],activateOnTyping:true,activateOnTypingDelay:20,icons:false,closeOnBlur:true,maxRenderedOptions:MAX_OPTIONS,
      tooltipClass:()=>'latex-completions',optionClass:option=>`latex-completion-${option.type||'text'}`,
      addToOptions:[render('cm-completionSource','source'),render('cm-completionDescription','description')]}),
    Prec.highest(keymap.of([
      {key:'Tab',run:view=>completionStatus(view.state)==='active'&&acceptCompletion(view)},
      {key:'Mod-Space',run:view=>!view.state.readOnly&&startCompletion(view)},
    ])),
  ];
}
/** Load the command data in idle time so the first `\` finds it ready. */
export function prefetchCompletionData(){const start=()=>loadCompletionCatalog().catch(()=>{});if(globalThis.requestIdleCallback)requestIdleCallback(start,{timeout:3000});else setTimeout(start,1500);}
