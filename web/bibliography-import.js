// Bibliography import stays built in (docs/zotero.md#import-a-bibliography): any
// reference manager exports .bib files, and checking one before importing works offline,
// contacts nobody and needs no permission, so it is core file import, not a plugin.
// Zotero links moved to the Zotero plugin (plugins/zotero, docs/plugins.md).
import {restoreDialogFocus} from './input.js';
import {checkBibliography} from './bibtex.js';

function el(tag,props={},...children){
  const node=document.createElement(tag);
  for(const [key,value]of Object.entries(props)){
    if(value===undefined||value===null||value===false)continue;
    if(key==='className')node.className=value;else if(key==='text')node.textContent=value;else if(key.startsWith('on'))node.addEventListener(key.slice(2),value);else if(key in node&&key!=='list')node[key]=value;else node.setAttribute(key,value===true?'':value);
  }
  for(const child of children.flat())if(child!==null&&child!==undefined&&child!==false)node.append(child);
  return node;
}
function shell(className,label){
  const dialog=el('dialog',{className:`modal bibliography-dialog ${className}`,'aria-label':label});restoreDialogFocus(dialog);
  // Optional parts are passed as null; never let them become text.
  const append=dialog.append.bind(dialog);dialog.append=(...nodes)=>append(...nodes.filter(node=>node!==null&&node!==undefined&&node!==false));
  return dialog;
}
const button=(text,onclick,primary=false,props={})=>el('button',{type:'button',className:`button ${primary?'primary':'secondary'}`,text,onclick,...props});

/** Shows the problems found in .bib files before importing. Resolves to true to import anyway. */
export function bibliographyReport(results){
  return new Promise(resolve=>{
    const dialog=shell('bibliography-report','Bibliography check');
    const errors=results.reduce((sum,result)=>sum+result.errors,0),warnings=results.reduce((sum,result)=>sum+result.warnings,0);
    dialog.append(el('h2',{text:'Check this bibliography'}),
      el('p',{text:`${errors?`${errors} ${errors===1?'problem':'problems'} BibTeX or Biber will reject or misread`:''}${errors&&warnings?' and ':''}${warnings?`${warnings} ${warnings===1?'warning':'warnings'}`:''}. Importing keeps the file exactly as it is, with your citation keys; you can fix it afterwards in the editor.`}));
    for(const result of results){
      const list=el('ul',{className:'bibliography-problems'});
      for(const problem of result.problems.slice(0,200))list.append(el('li',{'data-severity':problem.severity},el('span',{className:'bibliography-badge',text:problem.severity==='error'?'Error':'Warning'}),el('span',{text:` Line ${problem.line}: ${problem.message}`})));
      if(result.problems.length>200)list.append(el('li',{text:`…and ${result.problems.length-200} more.`}));
      dialog.append(el('section',{className:'bibliography-file','aria-label':result.path},el('h3',{text:`${result.path} · ${result.entries} ${result.entries===1?'entry':'entries'} readable`}),list));
    }
    const finish=value=>{dialog.close();dialog.remove();resolve(value);};
    dialog.append(el('div',{className:'modal-actions'},button('Cancel import',()=>finish(false)),button('Import anyway',()=>finish(true),true)));
    dialog.addEventListener('cancel',event=>{event.preventDefault();finish(false);});
    document.body.append(dialog);dialog.showModal();dialog.querySelector('.button.primary').focus();
  });
}


const isBib=path=>/\.bib$/i.test(path);
/** Shows the import report when any .bib file has problems; resolves to whether to go on. */
export async function checkImport(entries){
  const results=[];
  for(const entry of entries){
    if(entry.folder||typeof entry.content!=='string'||!isBib(entry.path))continue;
    if(entry.content.charCodeAt(0)===0xfeff)entry.content=entry.content.slice(1);
    const result=checkBibliography(entry.content);if(result.problems.length)results.push({path:entry.path,...result});
  }
  return results.length?bibliographyReport(results):true;
}
