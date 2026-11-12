// One popup system for every menu, select and small prompt in the app.
// A popup is shown in the top layer, so no panel can clip it, and it stays inside
// an open modal dialog so the dialog's inertness does not reach it. Only one is
// open at a time. Native <select> elements stay the real control (role, name,
// value, form state and change events); only their popup is replaced.
import {composingEvent,focusRestorer} from './input.js';

const ICONS={
  pencil:'M4 20l1-4L16 5l3 3L8 19ZM14 7l3 3',
  track:'M4 7h8M4 12h8M4 17h16M17.5 4v7M14 7.5h7',
  eye:'M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12ZM12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6',
  check:'m5 12 4 4L19 6',
  move:'M3 6h6l2 2h10v11H3ZM8 13.5h7M12.5 11l2.5 2.5-2.5 2.5',
  copy:'M9 9h11v11H9ZM15 9V4H4v11h5',
  trash:'M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13',
  'file-plus':'M6 3h8l4 4v14H6ZM14 3v4h4M12 11v6M9 14h6',
  'folder-plus':'M3 6h6l2 2h10v11H3ZM12 10.5v6M9 13.5h6',
  upload:'M12 16V5M7 10l5-5 5 5M4 20h16',
  folder:'M3 6h6l2 2h10v11H3Z',
  open:'M14 4h6v6M20 4l-9 9M18 14v6H4V6h6',
  download:'M12 4v11M7 10l5 5 5-5M4 20h16',
  restore:'M3 12a9 9 0 1 0 3-6.7L3 8M3 3v5h5',
};
const MARGIN=8,GAP=4,TYPEAHEAD_MS=600;
const supportsPopover=typeof HTMLElement!=='undefined'&&'popover' in HTMLElement.prototype;
let current=null,nextId=0,lastPointer=0;

function create(tag,className,text){const node=document.createElement(tag);if(className)node.className=className;if(text!==undefined)node.textContent=text;return node;}
function icon(name,className='ui-icon'){
  const svg=document.createElementNS('http://www.w3.org/2000/svg','svg');svg.setAttribute('viewBox','0 0 24 24');svg.setAttribute('aria-hidden','true');svg.setAttribute('class',className);
  const path=document.createElementNS('http://www.w3.org/2000/svg','path');path.setAttribute('d',ICONS[name]||'');svg.append(path);return svg;
}
function itemContent(item,{label,hint,iconName}){
  item.dataset.label=label;
  if(iconName)item.append(icon(iconName));
  const text=create('span','ui-item-text');text.append(create('span','ui-item-label',label));
  if(hint)text.append(create('small','ui-item-hint',hint));
  item.append(text);
}
function labelOf(item){return item.dataset.label||item.getAttribute('aria-label')||item.textContent.trim();}
function scopeFor(node){return node?.closest?.('.workspace,.dashboard-main,dialog')||null;}

function place(root,{anchor,point,align,matchWidth}){
  const rect=point?{left:point.x,right:point.x,top:point.y,bottom:point.y,width:0}:anchor?.isConnected?anchor.getBoundingClientRect():null;
  const gap=point?0:GAP,width=document.documentElement.clientWidth,height=innerHeight;
  root.style.maxHeight='';
  if(matchWidth&&rect)root.style.minWidth=`${Math.ceil(rect.width)}px`;
  const box=root.getBoundingClientRect();
  // Without an anchor (a command run from elsewhere) the popup sits top centre.
  if(!rect){root.style.left=`${Math.max(MARGIN,(width-box.width)/2)}px`;root.style.top='72px';return;}
  const below=height-rect.bottom-gap-MARGIN,above=rect.top-gap-MARGIN,up=box.height>below&&above>below,room=Math.max(up?above:below,120);
  if(box.height>room)root.style.maxHeight=`${room}px`;
  const shown=Math.min(box.height,room);
  root.style.top=`${Math.max(MARGIN,up?rect.top-gap-shown:rect.bottom+gap)}px`;
  root.style.left=`${Math.max(MARGIN,Math.min(align==='end'?rect.right-box.width:rect.left,width-box.width-MARGIN))}px`;
}
function intoTopLayer(root){root.hidden=false;if(supportsPopover){root.popover='manual';root.showPopover();}}
function outOfTopLayer(root){if(supportsPopover&&root.popover){if(root.matches(':popover-open'))root.hidePopover();root.removeAttribute('popover');}}

function focusItem(item){if(!item)return;item.focus({preventScroll:true});item.scrollIntoView?.({block:'nearest'});}
function typeahead(session,key){
  const items=session.items();if(!items.length)return;
  clearTimeout(session.typeTimer);session.typed=(session.typed||'')+key.toLowerCase();session.typeTimer=setTimeout(()=>{session.typed='';},TYPEAHEAD_MS);
  const repeat=[...session.typed].every(c=>c===session.typed[0]),query=repeat?session.typed[0]:session.typed,at=items.indexOf(document.activeElement);
  const order=[...items.slice(at+(repeat?1:0)),...items.slice(0,at+(repeat?1:0))];
  focusItem(order.find(item=>labelOf(item).toLowerCase().startsWith(query)));
}
function navigate(session,event){
  if(composingEvent(event))return false;
  const items=session.items(),at=items.indexOf(document.activeElement),{key}=event;
  if(key==='ArrowDown')focusItem(items[(at+1)%items.length]);
  else if(key==='ArrowUp')focusItem(items[(at<=0?items.length:at)-1]);
  else if(key==='Home')focusItem(items[0]);
  else if(key==='End')focusItem(items.at(-1));
  else if(key==='Enter'||(key===' '&&!session.typed))document.activeElement?.click?.();
  else if(key==='Tab'){session.onTab?.();session.close('now');return false;}
  else if(key.length===1&&!event.ctrlKey&&!event.metaKey&&!event.altKey)typeahead(session,key);
  else return false;
  return true;
}
// Owns everything every popup shares: placement, dismissal and focus return.
function begin(options){
  current?.close('none');
  const {root,anchor,point,scope=null,returnFocus,onClose,keys,hover=true}=options;
  const session={...options,close,isOpen:()=>!closed};
  const restore=()=>{const target=typeof returnFocus==='function'?returnFocus():returnFocus;if(target?.isConnected)target.focus();};
  const onPointerDown=event=>{
    if(root.contains(event.target)||anchor?.contains?.(event.target))return;
    close('lost');
  };
  const onReposition=event=>{
    if(event?.target?.nodeType===1&&root.contains(event.target))return;
    if(options.persistent||!point&&anchor?.isConnected&&isVisible(anchor)){place(root,options);return;}
    close('lost');
  };
  const isVisible=node=>{const box=node.getBoundingClientRect();return box.bottom>0&&box.top<innerHeight&&box.width>0;};
  const onKey=event=>{
    delete root.dataset.modality;
    if(event.key==='Escape'&&!composingEvent(event)){event.preventDefault();event.stopPropagation();close('now');return;}
    if(keys?keys(event,session):navigate(session,event)){event.preventDefault();event.stopPropagation();}
  };
  const onKeyUp=event=>{if(event.key===' ')event.preventDefault();};
  const onHover=event=>{
    const found=event.target.closest?.('label')?.control||event.target.closest?.('button,[role=menuitem],[role=option]');
    if(found&&session.items().includes(found)&&document.activeElement!==found)found.focus({preventScroll:true});
  };
  const onContext=event=>event.preventDefault();
  const watcher=new MutationObserver(()=>{
    if(!root.isConnected||scope&&!scope.isConnected)close('none');
    else if(options.watchOptions&&session.signature!==options.watchOptions())close('now');
  });
  let closed=false,watchFrame;
  function watch(){
    if(closed)return;
    if(session.signature!==options.watchOptions()){close('now');return;}
    watchFrame=requestAnimationFrame(watch);
  }
  function close(focus='now'){
    if(closed)return;closed=true;if(current===session)current=null;
    watcher.disconnect();cancelAnimationFrame(watchFrame);clearTimeout(session.typeTimer);
    document.removeEventListener('pointerdown',onPointerDown,true);
    window.removeEventListener('resize',onReposition);window.removeEventListener('scroll',onReposition,true);
    root.removeEventListener('keydown',onKey);root.removeEventListener('keyup',onKeyUp);root.removeEventListener('pointermove',onHover);root.removeEventListener('contextmenu',onContext);
    anchor?.setAttribute?.('aria-expanded','false');
    outOfTopLayer(root);delete root.dataset.modality;
    onClose?.(focus);
    if(focus==='now')restore();
    else if(focus==='lost')requestAnimationFrame(()=>{const active=document.activeElement;if(!active||active===document.body)restore();});
  }
  session.signature=options.watchOptions?.();
  // Opened by pointer, no row is highlighted until the pointer or a key reaches one.
  if(performance.now()-lastPointer<800)root.dataset.modality='pointer';
  intoTopLayer(root);place(root,options);
  anchor?.setAttribute?.('aria-expanded','true');
  document.addEventListener('pointerdown',onPointerDown,true);
  window.addEventListener('resize',onReposition);window.addEventListener('scroll',onReposition,true);
  root.addEventListener('keydown',onKey);root.addEventListener('keyup',onKeyUp);root.addEventListener('contextmenu',onContext);
  if(hover)root.addEventListener('pointermove',onHover);
  watcher.observe(document.documentElement,{childList:true,subtree:true});
  current=session;if(options.watchOptions)watchFrame=requestAnimationFrame(watch);return session;
}

/** An action menu built here. Resolves to the chosen item's value, or null. */
export function openMenu({label,title,note,items,anchor,point,scope,returnFocus,align,onClose,watchOptions}){
  return new Promise(resolve=>{
    const root=create('div','ui-popup ui-menu');root.setAttribute('role','menu');root.setAttribute('aria-label',label);root.tabIndex=-1;
    if(title){const heading=create('div','ui-popup-title',title);heading.setAttribute('role','presentation');heading.title=title;root.append(heading);}
    const noteId=note?`ui-popup-note-${++nextId}`:null;
    for(const entry of items){
      if(entry.separator){const line=create('div','ui-separator');line.setAttribute('role','separator');root.append(line);continue;}
      const item=create('div',`ui-item${entry.danger?' ui-danger':''}`);item.setAttribute('role','menuitem');item.tabIndex=-1;
      itemContent(item,{label:entry.label,hint:entry.hint,iconName:entry.icon});
      if(entry.disabled){item.setAttribute('aria-disabled','true');if(noteId)item.setAttribute('aria-describedby',noteId);item.title=note||'';}
      item.addEventListener('click',()=>{if(entry.disabled)return;value=entry.value;session.close('now');});
      root.append(item);
    }
    if(note){const text=create('p','ui-popup-note',note);text.id=noteId;text.setAttribute('role','none');root.append(text);}
    let value=null;
    document.body.append(root);
    const session=begin({root,anchor,point,scope:scope||scopeFor(anchor),returnFocus:returnFocus||anchor,
      items:()=>[...root.querySelectorAll('[role=menuitem]')],watchOptions,
      onClose(focus){root.remove();onClose?.(focus);queueMicrotask(()=>resolve(value));},
    });
    focusItem(session.items().find(item=>item.getAttribute('aria-disabled')!=='true')||session.items()[0]);
  });
}

/** Opens a native select's themed popup. The select keeps its value and events. */
export function openListbox(select,{key}={}){
  const root=create('div','ui-popup ui-listbox');root.setAttribute('role','listbox');root.tabIndex=-1;
  root.setAttribute('aria-label',select.getAttribute('aria-label')||select.labels?.[0]?.textContent?.trim()||select.name||'Options');
  root.id=`ui-listbox-${++nextId}`;
  const signature=()=>JSON.stringify([select.value,select.selectedIndex,select.matches(':disabled'),[...select.options].map(option=>[option.value,option.textContent,option.disabled,option.hidden,option.selected,option.parentElement.disabled])]);
  const choose=index=>{const valid=session.isOpen()&&session.signature===signature()&&select.isConnected&&!select.matches(':disabled')&&!select.options[index]?.disabled&&!select.options[index]?.hidden;session.close('now');if(!valid||index===select.selectedIndex)return;select.selectedIndex=index;for(const type of ['input','change'])select.dispatchEvent(new Event(type,{bubbles:true}));};
  [...select.options].forEach((option,index)=>{
    if(option.hidden)return;
    const item=create('div','ui-item');item.setAttribute('role','option');item.tabIndex=-1;item.id=`${root.id}-${index}`;item.setAttribute('aria-selected',String(option.selected));
    itemContent(item,{label:option.textContent.trim(),hint:option.dataset.hint,iconName:option.dataset.icon});item.title=option.textContent.trim();
    if(option.selected)item.append(icon('check','ui-icon ui-item-check'));
    if(option.disabled)item.setAttribute('aria-disabled','true');
    else item.addEventListener('click',()=>choose(index));
    root.append(item);
  });
  (select.closest('dialog')||document.body).append(root);
  const session=begin({root,anchor:select,scope:select,matchWidth:true,returnFocus:select,
    items:()=>[...root.querySelectorAll('[role=option]:not([aria-disabled=true])')],
    watchOptions:signature,
    onTab(){const active=document.activeElement;if(active?.parentElement===root&&active.getAttribute('role')==='option')active.click();},
    onClose(){root.remove();select.removeAttribute('aria-expanded');select.removeAttribute('aria-controls');},
  });
  select.setAttribute('aria-controls',root.id);
  focusItem(root.querySelector('[aria-selected=true]')||session.items()[0]);
  if(key)typeahead(session,key);
  return session;
}

/** Shows a popup whose content the page already renders, such as Leptos-owned action lists. */
export function openPanel(toggle,panel,{align='end',onClose,closeOnClick=true,returnFocusOnChoice=false}={}){
  const items=()=>[...panel.querySelectorAll('button:not(:disabled),a[href],input:not(:disabled)')];
  // A chosen tool may open a dialog, which restores focus to whatever held it when it
  // opened. Capturing moves focus to the toggle before the tool's own click handler runs.
  const onClick=event=>{if(event.target.closest?.('button,a[href]'))session.close(returnFocusOnChoice?'now':'lost');};
  const session=begin({root:panel,anchor:toggle,align,returnFocus:toggle,items,scope:panel,
    onClose(focus){panel.removeEventListener('click',onClick,{capture:returnFocusOnChoice});if(onClose)onClose(focus);else panel.hidden=true;},
  });
  if(closeOnClick)panel.addEventListener('click',onClick,{capture:returnFocusOnChoice});
  focusItem(items()[0]);
  return session;
}

/**
 * A non-modal dialog the caller built and keeps its own state in, in the shared popup
 * frame: placement, top layer, Escape, outside click and focus return. Its text fields
 * keep ordinary typing, and Tab cycles through what is currently usable.
 */
export function openDialog(root,{anchor,scope,align='end',onClose}={}){
  document.body.append(root);root.show();
  return begin({root,anchor,scope:scope||scopeFor(anchor),align,persistent:true,hover:false,items:()=>[],returnFocus:anchor,onClose,
    keys(event){
      if(event.key!=='Tab')return false;
      const stops=[...root.querySelectorAll('input:not(:disabled),button:not(:disabled)')].filter(stop=>stop.offsetParent!==null),at=stops.indexOf(document.activeElement);
      stops[(at+(event.shiftKey?-1:1)+stops.length)%stops.length]?.focus();return true;
    },
  });
}

/**
 * A small anchored prompt or confirmation. Resolves to the trimmed text (with
 * `value`), true (without it), or null when dismissed. `destinations` adds a
 * filterable list of folders that complete the path.
 */
export function openPrompt({title,message,value,label='Continue',danger,anchor,point,scope,destinations,composeValue}){
  return new Promise(resolve=>{
    const restore=focusRestorer();
    const root=create('dialog','ui-popup ui-prompt');root.setAttribute('aria-label',title);root.tabIndex=-1;
    root.append(create('h2','ui-prompt-title',title));
    if(message)root.append(create('p','ui-prompt-message',message));
    let input,result=null;
    if(value!==undefined){input=create('input','ui-input');input.value=value;input.setAttribute('aria-label',title);input.spellcheck=false;input.autocomplete='off';root.append(input);}
    const finish=outcome=>{result=outcome;session.close('now');};
    const submit=()=>finish(input?input.value.trim():true);
    let list;
    if(destinations?.length>1){
      list=create('div','ui-destinations');list.setAttribute('role','listbox');list.setAttribute('aria-label','Destination folders');
      for(const {path,label:text}of destinations){
        const option=create('div','ui-item');option.setAttribute('role','option');option.tabIndex=-1;option.setAttribute('aria-selected','false');option.dataset.path=path;itemContent(option,{label:text||path,iconName:'folder'});option.title=text||path;
        option.addEventListener('click',()=>{input.value=composeValue(path);for(const other of list.children)other.setAttribute('aria-selected',String(other===option));input.focus();});
        list.append(option);
      }
      root.append(list);
      input.addEventListener('input',()=>{const typed=input.value.trim().toLowerCase(),folder=typed.includes('/')?typed.slice(0,typed.lastIndexOf('/')):typed;for(const option of list.children){option.hidden=!!folder&&!option.dataset.path.toLowerCase().includes(folder);}});
      list.addEventListener('keydown',event=>{
        const items=[...list.children].filter(option=>!option.hidden),at=items.indexOf(document.activeElement);
        if(event.key==='ArrowDown')focusItem(items[Math.min(at+1,items.length-1)]);
        else if(event.key==='ArrowUp'){if(at<=0)input.focus();else focusItem(items[at-1]);}
        else if(event.key==='Home')focusItem(items[0]);
        else if(event.key==='End')focusItem(items.at(-1));
        else if(event.key==='Enter'||event.key===' ')document.activeElement.click();
        else return;
        event.preventDefault();event.stopPropagation();
      });
    }
    const actions=create('div','ui-prompt-actions');
    const cancel=create('button','button secondary compact','Cancel');cancel.type='button';cancel.addEventListener('click',()=>finish(null));
    const confirm=create('button',`button primary compact${danger?' ui-danger-button':''}`,label);confirm.type='button';confirm.addEventListener('click',submit);
    actions.append(cancel,confirm);root.append(actions);
    // A real, non-modal dialog: app shortcuts already stand down for an open dialog.
    document.body.append(root);root.show();
    const session=begin({root,anchor,point,scope:scope||scopeFor(anchor),persistent:true,hover:false,items:()=>[],
      keys(event){
        if(event.key==='Enter'&&event.target===input&&!composingEvent(event)){submit();return true;}
        if(event.key==='ArrowDown'&&event.target===input&&list){focusItem([...list.children].find(option=>!option.hidden));return true;}
        if(event.key==='Tab'){
          const stops=[...root.querySelectorAll('input,button')],at=stops.indexOf(document.activeElement);
          const next=stops[(at+(event.shiftKey?-1:1)+stops.length)%stops.length];next.focus();return true;
        }
        return false;
      },
      onClose(focus){root.close();root.remove();if(focus==='now')restore();queueMicrotask(()=>resolve(result));},
    });
    if(input){input.focus();input.select();}else cancel.focus();
  });
}

/** Routes every native select in the document through the themed popup. */
export function installPopups(target=document){
  const single=select=>select&&!select.multiple&&select.size<=1;
  target.addEventListener('pointerdown',()=>{lastPointer=performance.now();},true);
  target.addEventListener('mousedown',event=>{
    if(event.button!==0)return;
    const select=event.target.closest?.('select');if(!single(select))return;
    // Stops the native popup in every engine; the listbox takes focus instead.
    event.preventDefault();if(select.disabled)return;
    if(current?.anchor===select){current.close('now');return;}
    openListbox(select);
  },true);
  target.addEventListener('keydown',event=>{
    const select=event.target;if(select?.tagName!=='SELECT'||!single(select)||select.disabled||composingEvent(event)||event.ctrlKey||event.metaKey)return;
    const {key}=event,printable=key.length===1&&key!==' '&&!event.altKey;
    if(!printable&&!['ArrowDown','ArrowUp','Enter',' ','F4','Home','End'].includes(key))return;
    event.preventDefault();event.stopPropagation();openListbox(select,printable?{key}:{});
  },true);
  target.addEventListener('click',event=>{
    const toggle=event.target.closest?.('.review-menu-toggle,.compile-caret,.tools-toggle');if(!toggle)return;
    const panel=toggle.nextElementSibling;if(!panel)return;
    if(current?.root===panel){current.close('now');return;}
    openPanel(toggle,panel,toggle.matches('.tools-toggle')?{returnFocusOnChoice:true}:{});
  });
}
