// Browser composition must finish before application shortcuts or form actions.
const composing=new WeakSet();
export const compositionInProgress=target=>!!target&&composing.has(target);
export const composingEvent=event=>event.isComposing||event.keyCode===229||compositionInProgress(event.target);
export function trackComposition(root){
 root.addEventListener('compositionstart',event=>composing.add(event.target),true);
 root.addEventListener('compositionend',event=>composing.delete(event.target),true);
}
// Remembers the focused control, by tree node where there is one, because a move rebuilds its row.
export function focusRestorer(){
 const previous=document.activeElement,node=(previous?.closest?.('[data-node]')||previous?.closest?.('.file-row')?.querySelector('[data-node]'))?.dataset.node;
 return ()=>queueMicrotask(()=>requestAnimationFrame(()=>{
  if(document.querySelector('dialog[open]'))return;
  const active=document.activeElement;
  if(active?.isConnected&&active!==document.body&&active!==previous)return;
  const target=node?[...document.querySelectorAll('[role=treeitem]')].find(item=>item.dataset.node===node):previous;
  if(target?.isConnected)target.focus();
  else if(node)(document.querySelector('[role=treeitem][tabindex="0"]')||document.querySelector('.tree-root'))?.focus();
 }));
}
export function restoreDialogFocus(dialog){dialog.addEventListener('close',focusRestorer(),{once:true});}
