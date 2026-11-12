// Presentation helpers for the source editor: the selection pill and changed-line hints.
import {Annotation} from '@codemirror/state';
import {Decoration} from '@codemirror/view';

const mac=typeof navigator!=='undefined'&&/Mac|iP(hone|ad)/.test(navigator.platform||'');
const icon='<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 5h16v11H10l-4 4v-4H4Z"/></svg>';
const edge=8,gap=6;

export function commentPill(activate){
  const button=document.createElement('button');
  button.className='add-comment-floating';button.innerHTML=`${icon}<span>Add comment</span>`;button.hidden=true;
  button.title=`Add comment (${mac?'⌘⌥M':'Ctrl+Alt+M'})`;button.setAttribute('aria-keyshortcuts','Control+Alt+M Meta+Alt+M');
  button.onmousedown=event=>event.preventDefault();button.onclick=activate;document.body.append(button);
  return button;
}
// Escape dismisses the pill for this selection only; the selection itself stays.
export function dismissCommentPill(button,view){
  if(button.hidden)return;
  const {from,to}=view.state.selection.main;button.dataset.dismissed=`${from}:${to}`;button.hidden=true;
}
// Marks selections the app makes itself, such as showing a card's text. The pill follows only a person's own.
export const revealedSelection=Annotation.define();
export function quietCommentPill(button,view){
  const {from,to}=view.state.selection.main;button.dataset.dismissed=`${from}:${to}`;button.hidden=true;
}
// Sits just above the selection, or below it when there is no room, and stays on screen.
export function placeCommentPill(button,view,composing){
  if(!view?.dom.isConnected||view.state.selection.main.empty||composing||!view.hasFocus){button.hidden=true;if(view?.state.selection.main.empty)delete button.dataset.dismissed;return;}
  const {from,to}=view.state.selection.main;
  if(button.dataset.dismissed===`${from}:${to}`){button.hidden=true;return;}
  delete button.dataset.dismissed;
  const start=view.coordsAtPos(from,1),end=view.coordsAtPos(to,-1),frame=view.scrollDOM.getBoundingClientRect();
  const top=Math.max(frame.top,edge),bottom=Math.min(frame.bottom,window.innerHeight-edge);
  if((!start&&!end)||(end&&end.bottom<top)||(start&&start.top>bottom)){button.hidden=true;return;}
  button.hidden=false;
  const width=button.offsetWidth,height=button.offsetHeight;
  let left=Math.max(edge,frame.left+4),right=Math.min(window.innerWidth-edge,frame.right-4);
  if(right-left<width){left=edge;right=window.innerWidth-edge;}
  const oneLine=start&&end&&start.top===end.top;
  let x,y;
  if(start&&start.top-gap-height>=top){y=start.top-gap-height;x=oneLine?(start.left+end.right-width)/2:start.left;}
  else if(end&&end.bottom+gap+height<=bottom){y=end.bottom+gap;x=oneLine?(start.left+end.right-width)/2:end.right-width;}
  else{y=top+gap;x=right-width;}
  button.style.left=`${Math.round(Math.max(left,Math.min(right-width,x)))}px`;
  button.style.top=`${Math.round(y)}px`;
}

// A quiet margin hint on each line holding a pending change.
export function changedLineMarks(doc,rows,colour){
  const seen=new Set(),marks=[];
  for(const row of rows){
    if(row.to>doc.length)continue;
    const last=doc.lineAt(row.to).number;
    for(let n=doc.lineAt(row.from).number;n<=last;n++){
      if(seen.has(n))continue;seen.add(n);
      marks.push(Decoration.line({class:'review-changed-line',attributes:{style:`--change-author:${colour(row.authorId)}`}}).range(doc.line(n).from));
    }
  }
  return marks;
}
