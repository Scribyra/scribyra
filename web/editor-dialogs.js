import {restoreDialogFocus,compositionInProgress} from './input.js';
import {PRIVACY_URL,LICENSES_URL} from './report-dialog.js';
function dialogShell(title,description){
  const dialog=document.createElement('dialog');dialog.className='modal reference-review';restoreDialogFocus(dialog);dialog.setAttribute('aria-label',title);
  const heading=document.createElement('h2');heading.textContent=title;const help=document.createElement('p');help.textContent=description;dialog.append(heading,help);return dialog;
}
export function reviewReplacements(plan){
  return new Promise(resolve=>{
    const dialog=dialogShell('Review replacements','Choose the source changes to apply. You can undo this replacement batch together.');
    const list=document.createElement('div');list.className='reference-list';dialog.append(list);
    const checks=plan.matches.map((match,i)=>{
      const label=document.createElement('label');label.className='reference-edit';const checkbox=document.createElement('input');checkbox.type='checkbox';checkbox.checked=match.text!==match.replacement;checkbox.setAttribute('aria-label',`Replace match ${i+1} in ${match.path}:${match.line}`);
      const text=document.createElement('span'),location=document.createElement('strong'),before=document.createElement('code'),after=document.createElement('code');location.textContent=`${match.path}:${match.line}:${match.column}`;before.textContent=`− ${match.text||'(empty match)'}`;after.textContent=`+ ${match.replacement||'(delete)'}`;text.append(location,before,after);label.append(checkbox,text);list.append(label);return checkbox;
    });
    const finish=result=>{dialog.close();dialog.remove();resolve(result);};const buttons=document.createElement('div');buttons.className='modal-actions';
    for(const [text,apply]of [['Cancel',false],['Apply replacements',true]]){const button=document.createElement('button');button.textContent=text;button.className=`button ${apply?'primary':'secondary'}`;button.onclick=()=>finish(apply?checks.flatMap((input,i)=>input.checked?[i]:[]):null);buttons.append(button);}
    dialog.append(buttons);dialog.addEventListener('cancel',e=>{e.preventDefault();finish(null);});document.body.append(dialog);dialog.showModal();
  });
}
export function editorSettings(values,files){
  return new Promise(resolve=>{
    const dialog=dialogShell('Project settings','Editor appearance and tabs stay on this device. The project name and compiler settings are shared with the project.');const form=document.createElement('form');form.className='settings-form';dialog.append(form);
    function control(label,value,options){const row=document.createElement('label'),caption=document.createElement('span');caption.textContent=label;let input;
      if(options){input=document.createElement('select');for(const [value,text]of options){const option=document.createElement('option');option.value=value;option.textContent=text;input.append(option);}input.value=String(value);}
      else{input=document.createElement('input');input.type=typeof value==='boolean'?'checkbox':'text';if(input.type==='checkbox')input.checked=value;else input.value=value;}
      input.setAttribute('aria-label',label);row.append(caption,input);form.append(row);return input;
    }
    const name=control('Project name',values.name);name.required=true;name.maxLength=160;
    const main=control('Main file',values.mainFile,[['','No main document'],...files.filter(f=>f.path.toLowerCase().endsWith('.tex')&&!f.binary).map(f=>[f.id,f.path])]);
    const engine=control('TeX engine',values.engine,[['lualatex','LuaLaTeX']]);
    const font=control('Font size',values.fontSize,Array.from({length:13},(_,i)=>[i+12,`${i+12} px`]));const tabs=control('Indent width',values.tabSize,[[2,'2 spaces'],[4,'4 spaces'],[8,'8 spaces']]);
    const wrap=control('Wrap long lines',values.wrap),auto=control('Auto compile',values.auto);
    const shortcuts=document.createElement('p');shortcuts.className='settings-help';shortcuts.textContent='Ctrl/⌘ + Shift + F: project search · Ctrl/⌘ + Shift + O: outline · Alt + W: close file · Ctrl/⌘ + Enter: compile';form.append(shortcuts);
    const about=document.createElement('p');about.className='settings-help';for(const[text,href]of [['Privacy',PRIVACY_URL],['Licences',LICENSES_URL]]){const link=document.createElement('a');link.textContent=text;link.href=href;link.target='_blank';link.rel='noopener';if(about.childNodes.length)about.append(' · ');about.append(link);}form.append(about);
    const finish=result=>{dialog.close();dialog.remove();resolve(result);};const buttons=document.createElement('div');buttons.className='modal-actions';
    const cancel=document.createElement('button');cancel.type='button';cancel.textContent='Cancel';cancel.className='button secondary';cancel.onclick=()=>finish(null);
    const save=document.createElement('button');save.type='submit';save.textContent='Save settings';save.className='button primary';buttons.append(cancel,save);form.append(buttons);
    form.onsubmit=e=>{e.preventDefault();if(compositionInProgress(document.activeElement))return;if(!name.value.trim()){name.focus();return;}finish({name:name.value.trim(),mainFile:main.value,engine:engine.value,fontSize:Number(font.value),tabSize:Number(tabs.value),wrap:wrap.checked,auto:auto.checked});};
    dialog.addEventListener('cancel',e=>{e.preventDefault();finish(null);});document.body.append(dialog);dialog.showModal();
  });
}
