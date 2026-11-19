// The Outline panel: a virtualised WAI-ARIA tree of the document's headings.
// The tree lives outside the Leptos state on purpose: every emit serialises the whole state, and a
// thesis has hundreds of headings. Only the rows in view exist in the DOM, and typing re-reads just
// the file that changed.
import {source_outline} from './pkg/scribyra_app.js';
import {projectFiles} from './model.js';
import {buildOutline,currentNode,expansion,isExpanded,setExpanded,serializeExpansion,visibleRows} from './outline-model.js';

const ROW=26,OVERSCAN=14,MAIN_THREAD_BYTES=256*1024,SVG='http://www.w3.org/2000/svg';
const outlineFile=file=>!file.binary&&/\.(tex|ltx)$/i.test(file.path);
const measure=(name,start)=>{try{performance.measure(name,{start,end:performance.now()});}catch{}};
const chevron=()=>{const svg=document.createElementNS(SVG,'svg');svg.setAttribute('viewBox','0 0 16 16');svg.setAttribute('aria-hidden','true');const path=document.createElementNS(SVG,'path');path.setAttribute('d','m6 4 4 4-4 4');svg.append(path);return svg;};

export function outlineController({state,getDoc,emit,activate,tool,storageKey}){
  const cache=new Map();const dirty=new Set();let timer,running=false,generation=0,tree=null,cursor=null,saveTimer,assembledFor=null;
  let exp=expansion(null);
  const view=outlineView({
    jump:node=>{flush();const fresh=tree?.byKey.get(node.key)||node;if(fresh.kind==='file')activate(fresh.fileId,0);else activate(fresh.fileId,fresh.start);},
    changed:()=>persist(),
  });

  function persist(){clearTimeout(saveTimer);saveTimer=setTimeout(()=>{const key=storageKey();if(!key)return;try{localStorage.setItem(key,JSON.stringify({v:1,scope:state.outlineScope,...serializeExpansion(exp)}));}catch{}},250);}
  function load(){
    let saved=null;const key=storageKey();try{saved=key?JSON.parse(localStorage.getItem(key)):null;}catch{}
    exp=expansion(saved);state.outlineScope=saved?.scope==='file'?'file':'project';view.setExpansion(exp);
  }
  function scopeFiles(files){return state.outlineScope==='file'?files.filter(file=>file.id===state.active):files;}
  function setStatus(text){if(state.outlineStatus!==text){state.outlineStatus=text;emit();}}
  function assemble(files){
    const started=performance.now();
    assembledFor=`${state.outlineScope}:${state.outlineScope==='file'?state.active:state.mainFile}`;
    tree=buildOutline({files,parsed:cache,scope:state.outlineScope,mainId:state.mainFile,activeId:state.active});
    view.setTree(tree);if(cursor)view.setCurrent(currentNode(tree,cursor.fileId,cursor.offset));
    measure('scribyra:outline-assemble',started);
    setStatus(state.outlineScope==='file'&&!state.active?'Open a text file first.':tree.truncated?'Showing the first 2,000 headings of each file.':tree.headings?`${tree.headings} headings`:'No section headings in this scope.');
  }
  function store(result,ids){
    const byFile=new Map(ids.map(id=>[id,{items:[],includes:[],truncated:result.truncated}]));
    for(const item of result.items)byFile.get(item.fileId)?.items.push(item);
    for(const include of result.includes||[])byFile.get(include.fileId)?.includes.push(include);
    for(const [id,outline] of byFile)cache.set(id,outline);
  }
  async function run(){
    timer=null;const doc=getDoc();if(!doc||running||state.sidePanel!=='outline')return;
    const started=performance.now(),files=projectFiles(doc).filter(outlineFile),ids=new Set(files.map(file=>file.id));
    for(const id of cache.keys())if(!ids.has(id))cache.delete(id);
    const need=scopeFiles(files).filter(file=>!cache.has(file.id)||dirty.has(file.id));
    for(const file of need)dirty.delete(file.id);
    const sources=need.map(file=>({id:file.id,path:file.path,content:doc.getText(`text:${file.id}`).toString()}));
    const bytes=sources.reduce((sum,file)=>sum+file.content.length,0);
    // The first read, and any large one, goes to a worker; typing later re-reads one file here.
    const offMain=bytes>MAIN_THREAD_BYTES||(!cache.size&&sources.length>0);
    try{
      if(offMain){
        running=true;const epoch=++generation;state.outlineBusy=true;setStatus('Reading headings…');
        const result=await tool.run('outline',sources);
        if(epoch!==generation||doc!==getDoc())return;store(result,need.map(file=>file.id));
      }else if(sources.length)store(JSON.parse(source_outline(JSON.stringify(sources))),need.map(file=>file.id));
      const assembleStart=performance.now();assemble(files);
      measure('scribyra:outline-update',offMain?assembleStart:started);
    }catch(error){if(error.name!=='AbortError'){for(const file of need)dirty.add(file.id);setStatus(error.message);}}
    finally{if(running){running=false;state.outlineBusy=false;emit();if(dirty.size)schedule();}}
  }
  function schedule(delay=150){clearTimeout(timer);timer=setTimeout(run,delay);}
  // Brings the outline up to date now, on the main thread, before a jump uses its positions.
  function flush(){
    const doc=getDoc();if(!doc||!dirty.size||running)return;clearTimeout(timer);
    const files=projectFiles(doc).filter(outlineFile),need=scopeFiles(files).filter(file=>dirty.has(file.id));if(!need.length)return;
    for(const file of need)dirty.delete(file.id);
    store(JSON.parse(source_outline(JSON.stringify(need.map(file=>({id:file.id,path:file.path,content:doc.getText(`text:${file.id}`).toString()}))))),need.map(file=>file.id));assemble(files);
  }
  return {
    // `files` names the text files a change touched, or is null for a tree change.
    changed(files){if(files)for(const id of files)dirty.add(id);if(state.sidePanel==='outline')schedule();},
    shown(){view.attach();schedule(0);},
    // Called after every project refresh: a new active file or main document re-assembles the tree.
    structure(){if(state.sidePanel==='outline'&&tree&&assembledFor!==`${state.outlineScope}:${state.outlineScope==='file'?state.active:state.mainFile}`)schedule(0);},
    scope(value){state.outlineScope=value==='file'?'file':'project';persist();emit();schedule(0);},
    cursor(fileId,offset){cursor={fileId,offset};if(tree&&state.sidePanel==='outline')view.setCurrent(currentNode(tree,fileId,offset));},
    expandAll(){view.all(true);},collapseAll(){view.all(false);},
    open(){load();},
    leave(){clearTimeout(timer);clearTimeout(saveTimer);generation++;tool.cancel();running=false;cache.clear();dirty.clear();tree=null;cursor=null;assembledFor=null;exp=expansion(null);view.reset();},
  };
}

function outlineView({jump,changed}){
  let host=null,spacer=null,observer=null,tree=null,exp=expansion(null),rows=[],index=new Map(),current=null,focusKey=null,revealed=null;
  // Scroll position and height are cached: reading them while typing would force a layout of the whole page.
  let viewTop=0,viewHeight=0,hovering=false;
  const elements=new Map();let peek=null,peekRow=null,peekTimer,hideTimer,typed='',typedTimer,ids=0;

  function attach(){
    const element=document.getElementById('outline-tree');if(element===host)return;
    observer?.disconnect();elements.clear();hidePeek();host=element;spacer=null;if(!host)return;
    spacer=document.createElement('div');spacer.className='outline-spacer';spacer.setAttribute('role','none');host.replaceChildren(spacer);
    viewTop=host.scrollTop;viewHeight=host.clientHeight;
    host.addEventListener('scroll',()=>{viewTop=host.scrollTop;hidePeek();paint();},{passive:true});
    host.addEventListener('click',onClick);host.addEventListener('keydown',onKey);
    host.addEventListener('pointerover',onOver);host.addEventListener('pointerout',onOut);host.addEventListener('pointerenter',()=>{hovering=true;});host.addEventListener('pointerleave',()=>{hovering=false;hidePeek();});
    host.addEventListener('focusin',event=>{const row=event.target.closest?.('.outline-row');if(row){focusKey=row.dataset.key;roving();if(row.matches(':focus-visible'))showPeek(row,true);}});
    host.addEventListener('focusout',event=>{if(!host.contains(event.relatedTarget))hidePeek();});
    observer=new ResizeObserver(entries=>{viewHeight=entries.at(-1).contentRect.height;paint();});observer.observe(host);
    layout();
  }
  // Leptos mounts a new panel each time Outline is chosen; the tree follows whichever is in the page.
  function connected(){if(!host?.isConnected)attach();return Boolean(host?.isConnected);}
  function layout(){
    if(!tree){rows=[];index=new Map();}else{rows=visibleRows(exp,tree);index=new Map(rows.map((node,i)=>[node.key,i]));}
    if(!connected())return;spacer.style.height=`${rows.length*ROW}px`;
    host.setAttribute('aria-busy','false');paint();
  }
  function paint(){
    if(!connected())return;
    const top=viewTop,height=viewHeight||ROW*20,first=Math.max(0,Math.floor(top/ROW)-OVERSCAN),last=Math.min(rows.length,Math.ceil((top+height)/ROW)+OVERSCAN);
    const wanted=rows.slice(first,last);
    // The focused row stays in the DOM while it scrolls away, so focus is never lost.
    if(focusKey&&index.has(focusKey)){const i=index.get(focusKey);if(i<first||i>=last)wanted.push(rows[i]);}
    const keep=new Set(wanted.map(node=>node.key));
    for(const [key,element] of elements)if(!keep.has(key)){if(peekRow===element)hidePeek();element.remove();elements.delete(key);}
    const tabbable=focusKey&&index.has(focusKey)?focusKey:current&&index.has(current.key)?current.key:rows[0]?.key;
    let previous=null;
    for(const node of wanted){
      let element=elements.get(node.key);
      if(!element){element=row(node);elements.set(node.key,element);}
      update(element,node,index.get(node.key),tabbable);
      const next=previous?previous.nextSibling:spacer.firstChild;if(next!==element)spacer.insertBefore(element,next);previous=element;
    }
  }
  function row(node){
    const element=document.createElement('div');element.className='outline-row';element.setAttribute('role','treeitem');element.id=`outline-node-${++ids}`;
    const toggle=document.createElement('span');toggle.className='outline-chevron';toggle.setAttribute('aria-hidden','true');
    const title=document.createElement('span');title.className='outline-title';
    element.append(toggle,title);element.dataset.key=node.key;element.node=null;return element;
  }
  function update(element,node,i,tabbable){
    const open=isExpanded(exp,tree,node),setsize=(node.parent?node.parent.children:tree.roots).length;
    const s=element.cache||(element.cache={});
    const set=(name,value)=>{if(s[name]!==value){s[name]=value;if(value===null)element.removeAttribute(name);else element.setAttribute(name,value);}};
    if(element.node!==node){element.node=node;element.lastChild.textContent=node.title;element.dataset.kind=node.kind;element.dataset.command=node.command;}
    if(s.top!==i){s.top=i;element.style.transform=`translateY(${i*ROW}px)`;}
    if(s.depth!==node.depth){s.depth=node.depth;element.style.setProperty('--depth',node.depth);}
    set('aria-level',String(node.depth+1));set('aria-setsize',String(setsize));set('aria-posinset',String(node.pos));
    set('aria-expanded',node.children.length?String(open):null);set('aria-current',current===node?'location':null);
    set('tabindex',tabbable===node.key?'0':'-1');
    const parent=node.children.length;if(s.parent!==parent){s.parent=parent;element.firstChild.replaceChildren(...(parent?[chevron()]:[]));}
  }
  function roving(){for(const [key,element] of elements)element.setAttribute('tabindex',key===focusKey?'0':'-1'),element.cache&&(element.cache.tabindex=key===focusKey?'0':'-1');}
  function scrollTo(top){host.scrollTop=top;viewTop=host.scrollTop;paint();}
  function nodeOf(target){const element=target.closest?.('.outline-row');return element&&tree?.byKey.get(element.dataset.key);}
  function toggle(node,value=!isExpanded(exp,tree,node)){
    if(!node.children.length)return;const started=performance.now();setExpanded(exp,node,value);
    // Collapsing a node that holds the focus moves focus to that node.
    if(!value&&focusKey&&focusKey!==node.key){let parent=tree.byKey.get(focusKey)?.parent;while(parent&&parent!==node)parent=parent.parent;if(parent===node)focusKey=node.key;}
    layout();changed();measure('scribyra:outline-toggle',started);
  }
  function focusRow(i){
    if(!rows.length)return;i=Math.max(0,Math.min(rows.length-1,i));focusKey=rows[i].key;
    const top=i*ROW;if(top<viewTop)scrollTo(top);else if(top+ROW>viewTop+viewHeight)scrollTo(top+ROW-viewHeight);
    paint();elements.get(focusKey)?.focus({preventScroll:true});
  }
  function onClick(event){
    const node=nodeOf(event.target);if(!node)return;focusKey=node.key;
    if(event.target.closest('.outline-chevron')&&node.children.length){toggle(node);elements.get(node.key)?.focus({preventScroll:true});return;}
    hidePeek();jump(node);
  }
  function onKey(event){
    if(event.isComposing||event.ctrlKey||event.metaKey||event.altKey)return;
    const node=nodeOf(event.target);if(!node)return;const i=index.get(node.key);let handled=true;
    switch(event.key){
      case 'ArrowDown':focusRow(i+1);break;
      case 'ArrowUp':focusRow(i-1);break;
      case 'Home':focusRow(0);break;
      case 'End':focusRow(rows.length-1);break;
      case 'PageDown':focusRow(i+Math.max(1,Math.floor(viewHeight/ROW)-1));break;
      case 'PageUp':focusRow(i-Math.max(1,Math.floor(viewHeight/ROW)-1));break;
      case 'ArrowRight':if(node.children.length){if(!isExpanded(exp,tree,node))toggle(node,true);else focusRow(i+1);}break;
      case 'ArrowLeft':if(node.children.length&&isExpanded(exp,tree,node))toggle(node,false);else if(node.parent)focusRow(index.get(node.parent.key));break;
      case 'Enter':hidePeek();jump(node);break;
      case '*':{const started=performance.now();for(const sibling of node.parent?node.parent.children:tree.roots)if(sibling.children.length)setExpanded(exp,sibling,true);layout();changed();measure('scribyra:outline-toggle',started);break;}
      default:
        if(event.key.length===1&&event.key!==' '){
          // Type-ahead: the next visible heading that starts with what was typed.
          // Repeating one character cycles through the headings that start with it.
          clearTimeout(typedTimer);typed+=event.key.toLowerCase();typedTimer=setTimeout(()=>{typed='';},600);
          const prefix=[...typed].every(c=>c===typed[0])?typed[0]:typed;
          for(let step=prefix.length===1?1:0;step<=rows.length;step++){const j=(i+step)%rows.length;if(rows[j].title.toLowerCase().startsWith(prefix)){focusRow(j);break;}}
        }else handled=false;
    }
    if(handled){event.preventDefault();event.stopPropagation();}
  }
  // Hover and keyboard focus reveal a truncated title as an extension of its own row.
  function onOver(event){
    const element=event.target.closest?.('.outline-row');if(!element||element===peekRow){clearTimeout(hideTimer);return;}
    clearTimeout(peekTimer);clearTimeout(hideTimer);
    if(peekRow)showPeek(element,true);else peekTimer=setTimeout(()=>showPeek(element,false),220);
  }
  function onOut(event){
    const element=event.target.closest?.('.outline-row');if(!element||element.contains(event.relatedTarget))return;
    clearTimeout(peekTimer);clearTimeout(hideTimer);hideTimer=setTimeout(hidePeek,80);
  }
  function showPeek(element,instant){
    const title=element.lastChild,node=element.node;
    if(!node||!element.isConnected||title.scrollWidth<=title.clientWidth+1){hidePeek();return;}
    if(!peek){peek=document.createElement('div');peek.className='outline-peek';peek.setAttribute('aria-hidden','true');peek.append(document.createElement('span'),document.createElement('small'));document.body.append(peek);}
    const box=title.getBoundingClientRect(),rowBox=element.getBoundingClientRect(),style=getComputedStyle(title);
    peek.firstChild.textContent=node.title;peek.lastChild.textContent=node.kind==='file'?'':`${node.path}:${node.line}`;
    peek.dataset.current=String(element.getAttribute('aria-current')==='location');peek.dataset.kind=node.kind;
    peek.style.left=`${Math.round(box.left)-4}px`;peek.style.top=`${Math.round(rowBox.top)}px`;peek.style.minHeight=`${Math.round(rowBox.height)}px`;
    peek.style.fontWeight=style.fontWeight;peek.style.maxWidth=`${Math.max(160,window.innerWidth-box.left-4)}px`;
    peek.classList.toggle('instant',instant);peekRow=element;element.classList.add('peeking');
    if(!peek.classList.contains('visible'))requestAnimationFrame(()=>peek?.classList.add('visible'));
  }
  function hidePeek(){clearTimeout(peekTimer);clearTimeout(hideTimer);peekRow?.classList.remove('peeking');peekRow=null;peek?.classList.remove('visible');}
  return {
    attach,
    setTree(next){
      const started=performance.now();tree=next;
      if(current)current=tree.byKey.get(current.key)||null;
      layout();measure('scribyra:outline-render',started);
    },
    setExpansion(next){exp=next;layout();},
    setCurrent(node){
      if(node===current)return;current=node;
      if(!node||node.key===revealed){paint();return;}
      revealed=node.key;let parent=node.parent,opened=false;
      // Opening the ancestors of the cursor's section never closes anything the person opened.
      while(parent){if(!isExpanded(exp,tree,parent)){setExpanded(exp,parent,true);opened=true;}parent=parent.parent;}
      if(opened){layout();changed();}else paint();
      if(connected()&&!host.contains(document.activeElement)&&!peekRow&&!hovering){
        const top=index.get(node.key)*ROW;if(top<viewTop||top+ROW>viewTop+viewHeight)scrollTo(Math.max(0,top-viewHeight/2));
      }
    },
    all(open){
      const started=performance.now();exp.mode=open?'expanded':'collapsed';exp.open.clear();
      if(focusKey&&!visibleRows(exp,tree||{roots:[]}).some(node=>node.key===focusKey))focusKey=null;
      layout();changed();measure('scribyra:outline-toggle',started);
    },
    reset(){tree=null;current=null;focusKey=null;revealed=null;exp=expansion(null);hidePeek();layout();},
  };
}
