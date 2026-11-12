import {restoreDialogFocus} from './input.js';
// A concrete review of each source edit; no source mutation happens in this dialog.
export function reviewReferences(plan) {
  return new Promise(resolve=>{
    const dialog=document.createElement('dialog');dialog.className='modal reference-review';restoreDialogFocus(dialog);dialog.setAttribute('aria-label','Review file references');
    const title=document.createElement('h2');title.textContent='Review file references';dialog.append(title);
    const help=document.createElement('p');help.textContent='Choose which literal LaTeX paths to update with this move. Paths are resolved from the main document’s folder. Custom macros and search paths may need manual changes.';dialog.append(help);
    const list=document.createElement('div');list.className='reference-list';dialog.append(list);
    const checks=plan.edits.map((edit,i)=>{
      const label=document.createElement('label');label.className='reference-edit';
      const input=document.createElement('input');input.type='checkbox';input.checked=true;input.setAttribute('aria-label',`${edit.path}:${edit.line}: ${edit.before} → ${edit.after}`);
      const text=document.createElement('span'),location=document.createElement('strong'),before=document.createElement('code'),after=document.createElement('code');
      location.textContent=`${edit.path}:${edit.line}`;before.textContent=`− ${edit.before}`;after.textContent=`+ ${edit.after}`;
      text.append(location,before,after);label.append(input,text);list.append(label);return input;
    });
    for(const warning of plan.warnings){const item=document.createElement('p');item.className='reference-warning';item.textContent=warning;list.append(item);}
    const buttons=document.createElement('div');buttons.className='modal-actions';dialog.append(buttons);
    const finish=result=>{dialog.close();dialog.remove();resolve(result);};
    for(const [label,result,primary] of [['Cancel',null,false],['Move without updates',[],false],['Move and update',true,true]]) {
      if(result===true&&!checks.length)continue;
      const button=document.createElement('button');button.className=`button ${primary?'primary':'secondary'}`;button.textContent=label;
      button.onclick=()=>finish(result===true?checks.flatMap((check,i)=>check.checked?[i]:[]):result);buttons.append(button);
    }
    dialog.addEventListener('cancel',e=>{e.preventDefault();finish(null);});document.body.append(dialog);dialog.showModal();
  });
}
