// Live compilation log. The compiler worker already posts every line TeX,
// Biber and BibTeX print; this module turns those lines into readable steps and
// a bounded, batched view. Everything here stays in this tab: nothing is stored
// or handed to telemetry. The final log still replaces it when a compile ends.

// Same bound as the final log handed to diagnostics (boundedText(log, 2 MiB)).
export const LIVE_LOG_LIMIT=2*1024*1024;
export const LIVE_LOG_INTERVAL=150;

const NOISE=[
 /^program exited \(with status: \d+\), but keepRuntimeAlive\(\)/,
 /^New compilation started: /,
 /^TeX packages(?: local| unresolved)?(?: \(in local or preloaded\))?: /,
 /^Data packages used/,
 /^Because of unresolved TeX packages/,
 /^(?:Preparing|Downloading data)\.\.\. \(\d+\/\d+\)$/,
 /^All downloads complete\.$/,
];
const TOOLS=[
 [/^lua(?:hb)?(?:la)?tex\b/,'tex'],[/^bibtex8?\b/,'bibtex'],[/^biber\b/,'biber'],[/^makeindex\b/,'index'],[/^xdvipdfmx\b/,'dvi'],
];
export function lineKind(text){
 if(/^! |^\S.*(?:^|\s)Error: |^\S+ Error:|^ERROR - /.test(text))return 'error';
 if(/Warning: |^(?:Over|Under)full \\[hv]box|^WARN - /.test(text))return 'warning';
 return 'out';
}
// Parses one compile's worker output. `emit` receives {text,kind} entries;
// print() returns a step label when a new tool run starts.
export function compileOutput(send){
 let attempt=0,texPasses=0,inAttempt=0,previous='',expectExit=false,blank=true;
 // Runs of blank terminal lines collapse to one in the live view.
 const emit=entry=>{const empty=entry.kind==='out'&&!entry.text.trim();if(empty&&blank)return;blank=empty;send({...entry,attempt});};
 function command(line){
  const program=line.replace(/^busytex /,'').split(' ')[0],tool=TOOLS.find(([pattern])=>pattern.test(program))?.[1];
  if(!tool)return null;
  let label;
  if(tool==='tex'){
   texPasses++;inAttempt++;
   const reason=inAttempt===1?(attempt?'with downloaded packages':''):previous==='biber'||previous==='bibtex'?'rerun for the bibliography':previous==='index'?'rerun for the index':'rerun for cross-references';
   label=`LuaLaTeX pass ${texPasses}${reason?` · ${reason}`:''}`;
  }else label={bibtex:'BibTeX bibliography',biber:'Biber bibliography',index:'Index (makeindex)',dvi:'PDF conversion'}[tool];
  previous=tool;emit({text:label,kind:'step'});return label;
 }
 return {
  attempt(number){attempt=number;inAttempt=0;previous='';},
  get attemptNumber(){return attempt;},
  step(text){emit({text,kind:'step'});},
  // This attempt stopped only for missing files that are about to be fetched:
  // its fatal and exit-code lines are expected, so they lose error styling.
  recovering(){send({kind:'recovered',attempt});emit({text:'Missing packages are being fetched; LuaLaTeX will run again',kind:'step'});},
  note(text){emit({text,kind:'note'});},
  print(raw){
   let text=String(raw??'');const prefixed=/^\/bin\/busytex (stdout|stderr): /.exec(text);
   if(prefixed){text=text.slice(prefixed[0].length);if(NOISE.some(pattern=>pattern.test(text)))return;emit({text,kind:lineKind(text)});return;}
   text=text.replace(/\n+$/,'');
   if(expectExit){expectExit=false;if(/^-?\d+$/.test(text)){if(text!=='0')emit({text:`Exit code ${text}`,kind:'error'});return;}}
   if(text==='$ echo $?'){expectExit=true;return;}
   if(text.startsWith('$ # ')){emit({text:text.slice(4),kind:'note'});return;}
   if(/^\$ (?:busytex |biber )/.test(text))return command(text.slice(2));
   if(NOISE.some(pattern=>pattern.test(text)))return;
   for(const part of text.split('\n'))emit({text:part,kind:lineKind(part)});
  },
 };
}

// Bounded, batched log model with an optional DOM view. Entries carry sequence
// numbers so a view that reappears (the panel was reopened) can rebuild itself.
export function liveCompileLog({limit=LIVE_LOG_LIMIT,interval=LIVE_LOG_INTERVAL,target=()=>globalThis.document?.getElementById('live-compile-log'),schedule=(fn,ms)=>setTimeout(fn,ms),unschedule=id=>clearTimeout(id)}={}){
 let entries=[],head=0,size=0,next=0,base=0,timer=null,active=false;
 const views=new WeakMap();
 function trim(){
  while(size>limit&&head<entries.length){size-=entries[head].text.length+1;head++;}
  if(head>4096&&head*2>entries.length){entries=entries.slice(head);head=0;}
 }
 function retained(){return entries.length-head;}
 function render(){
  timer=null;const element=target();if(!element)return;
  const scroller=element.closest?.('.diagnostic-content')||element,view=views.get(element),first=entries[head]?.seq??next;
  const atBottom=!view||scroller.scrollHeight-scroller.scrollTop-scroller.clientHeight<=32;
  let from=head,plain='';
  if(!view||view.last<first-1){element.textContent='';if(first>base)plain=`… ${first-base} earlier lines are not kept while compiling\n`;}
  else{from=head+Math.max(0,view.last+1-first);
   // Drop whole rendered chunks that fell out of the retained window.
   while(element.firstElementChild&&Number(element.firstElementChild.dataset.last)<first)element.firstElementChild.remove();
  }
  if(from<entries.length||plain){
   const doc=element.ownerDocument,chunk=doc.createElement('span');chunk.className='log-chunk';chunk.dataset.last=String(next-1);
   const flush=()=>{if(plain){chunk.append(doc.createTextNode(plain));plain='';}};
   for(let i=from;i<entries.length;i++){
    const {text,kind,attempt}=entries[i];
    if(kind==='out'){plain+=text+'\n';continue;}
    flush();const span=doc.createElement('span');span.className=`log-${kind}`;span.dataset.attempt=String(attempt);span.textContent=(kind==='step'?'▸ ':'')+text+'\n';chunk.append(span);
   }
   flush();element.append(chunk);
  }
  views.set(element,{last:next-1});
  if(atBottom)scroller.scrollTop=scroller.scrollHeight;
 }
 const api={
  start(){entries=[];head=0;size=0;base=next;active=true;if(timer!==null)unschedule(timer);timer=null;const element=target();if(element){element.textContent='';views.delete(element);}},
  push(entry){
   if(active&&entry?.kind==='recovered'){
    for(let i=head;i<entries.length;i++)if(entries[i].attempt===entry.attempt&&entries[i].kind==='error')entries[i].kind='recovered';
    const element=target();for(const span of element?.querySelectorAll?.(`.log-error[data-attempt="${entry.attempt}"]`)||[])span.className='log-recovered';
    return;
   }
   if(!active||!entry||typeof entry.text!=='string')return;
   const text=entry.text.length>=limit?entry.text.slice(0,limit-1):entry.text;
   entries.push({text,kind:entry.kind||'out',attempt:entry.attempt??0,seq:next++});size+=text.length+1;trim();
   if(timer===null)timer=schedule(render,interval);
  },
  // Show what is retained now, e.g. when the panel opens between batches.
  refresh(){if(!active)return;if(timer!==null)unschedule(timer);render();},
  stop(){active=false;if(timer!==null){unschedule(timer);timer=null;}},
  text(){let out='';for(let i=head;i<entries.length;i++)out+=(entries[i].kind==='step'?'▸ ':'')+entries[i].text+'\n';return out.replace(/\n$/,'');},
  get lines(){return retained();},
  get size(){return size;},
  get active(){return active;},
 };
 return api;
}
