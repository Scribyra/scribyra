import {Decoration,ViewPlugin} from '@codemirror/view';

// Only decorate rendered lines; CodeMirror keeps navigation and virtualization.
function lines(view){
 const ranges=[];let previous=0;
 for(const {from,to} of view.visibleRanges){
  for(let pos=from;pos<=to;){
   const line=view.state.doc.lineAt(pos);
   if(line.number!==previous){
    ranges.push(Decoration.line({attributes:{'data-line':String(line.number),title:`Line ${line.number}${line.length?'':', blank'}`}}).range(line.from));
    previous=line.number;
   }
   pos=line.to+1;
  }
 }
 return Decoration.set(ranges);
}
export const sourceLines=ViewPlugin.fromClass(class{
 constructor(view){this.decorations=lines(view);}
 update(update){if(update.docChanged||update.viewportChanged)this.decorations=lines(update.view);}
},{decorations:value=>value.decorations});
