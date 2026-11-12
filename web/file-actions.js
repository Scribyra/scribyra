// File tree actions: the context menu's contents, inline rename and how a menu is summoned.
import {composingEvent,focusRestorer} from './input.js';

/** A bare name stays in the node's folder; a path with a slash is a full project path. */
export function renamedPath(current,typed){
  const value=typed.trim().replace(/^\/+/,'');if(!value)return null;
  const path=value.includes('/')?value:current.slice(0,current.lastIndexOf('/')+1)+value;
  return path===current?null:path;
}
/** Paths that can receive a node: every folder except the node itself and what it contains. */
export function moveDestinations(nodes,node){
  const inside=node.folder?`${node.path}/`:null;
  return [{path:'',label:'Project root'},...nodes.filter(item=>item.folder&&item.path!==node.path&&!(inside&&item.path.startsWith(inside))).map(item=>({path:item.path})).sort((a,b)=>a.path.localeCompare(b.path))];
}
export function moveTarget(node,folder){return `${folder?`${folder}/`:''}${node.path.slice(node.path.lastIndexOf('/')+1)}`;}

export function treeMenuItems(node,{blocked,trashCount}){
  const disabled=!!blocked;
  const creating=[
    {label:'New file',value:'new-file',icon:'file-plus',disabled},
    {label:'New folder',value:'new-folder',icon:'folder-plus',disabled},
  ];
  if(!node)return [...creating,{separator:true},
    {label:'Upload files',value:'upload',icon:'upload',disabled},
    {label:'Import folder',value:'import-folder',icon:'folder',disabled},
    ...(trashCount?[{separator:true},{label:'Restore last deletion',value:'restore',icon:'restore',disabled}]:[])];
  return [...(node.folder?[...creating,{label:'Upload files',value:'upload',icon:'upload',disabled},{separator:true}]:[]),
    {label:'Rename',value:'rename',icon:'pencil',disabled},
    {label:'Move',value:'move',icon:'move',disabled},
    {label:'Duplicate',value:'duplicate',icon:'copy',disabled},
    {separator:true},
    {label:'Delete',value:'delete',icon:'trash',danger:true,disabled}];
}

/** Edits a tree row's name in place. Resolves to the new path, or null when nothing should change. */
export function inlineRename(row,node){
  return new Promise(resolve=>{
    const restore=focusRestorer(),input=document.createElement('input');input.className='tree-rename';input.spellcheck=false;input.autocomplete='off';
    input.setAttribute('aria-label',`Rename ${node.folder?'folder':'file'}`);input.title='A name keeps it in this folder. A path with a slash is measured from the project root.';
    const name=node.path.slice(node.path.lastIndexOf('/')+1);input.value=name;
    const label=row.querySelector('.file-path');row.classList.add('renaming');row.append(input);
    input.style.left=`${label?label.offsetLeft:0}px`;
    let done=false;
    const watcher=new MutationObserver(()=>{if(!input.isConnected)finish(null);});
    function finish(path){if(done)return;done=true;watcher.disconnect();row.classList.remove('renaming');input.remove();resolve(path);}
    input.addEventListener('keydown',event=>{
      event.stopPropagation();if(composingEvent(event))return;
      if(event.key==='Enter'){event.preventDefault();finish(renamedPath(node.path,input.value));restore();}
      if(event.key==='Escape'){event.preventDefault();finish(null);restore();}
    });
    // A window blur keeps the input active; only moving focus inside the page commits.
    input.addEventListener('blur',()=>{if(document.activeElement!==input)finish(renamedPath(node.path,input.value));});
    for(const type of ['click','dblclick','pointerdown','contextmenu'])input.addEventListener(type,event=>event.stopPropagation());
    watcher.observe(document.documentElement,{childList:true,subtree:true});
    input.focus();
    const stem=name.lastIndexOf('.');input.setSelectionRange(0,stem>0&&!node.folder?stem:name.length);
  });
}

const LONG_PRESS_MS=500,LONG_PRESS_SLOP=8;
/** Right click, long press, the ContextMenu key and Shift+F10 on the tree. `open(nodeId, origin)`. */
export function installTreeMenus(open,target=document){
  const inTree=node=>node?.closest?.('.file-list,.tree-root');
  const idOf=node=>node.closest('.file-row')?.querySelector('[data-node]')?.dataset.node||'';
  const fromMenuButton=node=>node.closest?.('.file-menu');
  let press=null,swallow=false;
  target.addEventListener('contextmenu',event=>{
    if(!inTree(event.target)||event.target.closest('input'))return;
    event.preventDefault();
    // Android also reports a long press as contextmenu; the timer below has already opened it.
    if(!swallow)open(idOf(event.target),{point:{x:event.clientX,y:event.clientY}});
  });
  target.addEventListener('keydown',event=>{
    const fromKey=event.key==='ContextMenu'||event.key==='F10'&&event.shiftKey;
    if(!fromKey||composingEvent(event)||!inTree(event.target)||event.target.closest('input'))return;
    event.preventDefault();event.stopPropagation();
    const row=event.target.closest('.file-row');open(idOf(event.target),{anchor:row||event.target});
  },true);
  const cancel=()=>{if(press){clearTimeout(press.timer);press=null;}};
  target.addEventListener('pointerdown',event=>{
    swallow=false;
    if(event.pointerType!=='touch'||!inTree(event.target)||event.target.closest('input')||fromMenuButton(event.target))return;
    const {clientX:x,clientY:y,target:from}=event;
    press={x,y,timer:setTimeout(()=>{press=null;swallow=true;open(idOf(from),{point:{x,y}});},LONG_PRESS_MS)};
  },true);
  target.addEventListener('pointermove',event=>{if(press&&Math.hypot(event.clientX-press.x,event.clientY-press.y)>LONG_PRESS_SLOP)cancel();},true);
  for(const type of ['pointerup','pointercancel'])target.addEventListener(type,cancel,true);
  // The finger lifting after a long press must not also open the row.
  target.addEventListener('click',event=>{if(swallow){swallow=false;if(inTree(event.target)){event.preventDefault();event.stopPropagation();}}},true);
}
