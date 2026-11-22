// "New project": choose a template (docs/templates.md). A modal dialog with search,
// categories and preview cards. Nothing is created until the person chooses
// Create project; a #template= link only preselects a card.
import {searchTemplates,suggestedName} from './template-catalog.js';
import {restoreDialogFocus,composingEvent} from './input.js';
import './template-gallery.css';

function el(tag,props={},...children){
 const node=document.createElement(tag);
 for(const [key,value] of Object.entries(props)){
  if(value===undefined||value===null||value===false)continue;
  if(key==='className')node.className=value;else if(key==='text')node.textContent=value;else if(key.startsWith('on'))node.addEventListener(key.slice(2),value);else node.setAttribute(key,value===true?'':value);
 }
 for(const child of children.flat())if(child!==null&&child!==undefined&&child!==false)node.append(child);
 return node;
}
const SEARCH_ICON='<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>';
let open=null;

/**
 * openTemplateGallery({catalog, previewUrl(id), selected, note}) → Promise<{id, name} | null>
 * `note` explains why the gallery opened (for example, a template link).
 */
export function openTemplateGallery({catalog,previewUrl,selected,note}){
 open?.close(null);
 return new Promise(resolve=>{
  const templates=catalog.templates;
  let current=templates.find(template=>template.id===selected)||templates[0];
  let category='',query='',nameEdited=false,closed=false;
  const dialog=el('dialog',{className:'modal template-gallery','aria-labelledby':'template-gallery-title','aria-describedby':'template-gallery-intro'});restoreDialogFocus(dialog);
  const finish=result=>{if(closed)return;closed=true;if(open?.dialog===dialog)open=null;dialog.close();dialog.remove();resolve(result);};
  dialog.addEventListener('cancel',event=>{event.preventDefault();finish(null);});

  const search=el('input',{type:'search',placeholder:'Search templates…','aria-label':'Search templates',autocomplete:'off',spellcheck:'false'});
  const searchBox=el('label',{className:'search-box template-search'});searchBox.innerHTML=SEARCH_ICON;searchBox.append(search);
  const chips=el('div',{className:'template-categories',role:'group','aria-label':'Categories'});
  const chip=(id,label)=>el('button',{type:'button',className:'template-chip','aria-pressed':String(category===id),'data-category':id,text:label,onclick:()=>{category=id;render();}});
  const results=el('div',{className:'template-results',role:'radiogroup','aria-label':'Templates'});
  const empty=el('p',{className:'template-empty',role:'status','aria-live':'polite'});
  const name=el('input',{id:'template-project-name',maxlength:'160',autocomplete:'off',value:suggestedName(current)});
  name.addEventListener('input',()=>{nameEdited=true;});
  name.addEventListener('keydown',event=>{if(event.key==='Enter'&&!composingEvent(event)){event.preventDefault();create();}});
  const chosen=el('p',{className:'template-chosen','aria-live':'polite'});
  const create=()=>{const value=name.value.trim();if(!value){name.focus();name.setAttribute('aria-invalid','true');chosen.textContent='Give the project a name.';return;}finish({id:current.id,name:value.slice(0,160)});};

  function card(template){
   const id=`template-card-${template.id}`,checked=template.id===current.id;
   const input=el('input',{type:'radio',name:'template',value:template.id,className:'template-radio','aria-labelledby':`${id}-name`,'aria-describedby':`${id}-description`});
   input.checked=checked;
   input.addEventListener('change',()=>{if(input.checked)select(template);});
   const preview=previewUrl(template.id);
   const image=preview?el('img',{src:preview,alt:'',width:'480',height:'360',loading:'lazy',decoding:'async'}):el('span',{className:'template-preview-fallback','aria-hidden':'true',text:'Aa'});
   const node=el('label',{className:'template-card','data-template':template.id},input,
    el('span',{className:'template-preview'},image),
    el('span',{className:'template-card-text'},el('span',{className:'template-card-name',id:`${id}-name`,text:template.name}),el('span',{className:'template-card-description',id:`${id}-description`,text:template.description})));
   // Double-click (or double-tap) a card to create straight away.
   node.addEventListener('dblclick',()=>{select(template);create();});
   return node;
  }
  function select(template){
   current=template;
   if(!nameEdited)name.value=suggestedName(template);
   name.removeAttribute('aria-invalid');
   const others=template.files.length-1;
   chosen.textContent=`${template.name}: ${template.main}${others?` and ${others} more ${others===1?'file':'files'}`:''}.`;
   for(const node of results.querySelectorAll('.template-card'))node.classList.toggle('selected',node.dataset.template===template.id);
  }
  function render(){
   chips.replaceChildren(chip('','All'),...catalog.categories.filter(entry=>templates.some(template=>template.category===entry.id)).map(entry=>chip(entry.id,entry.name)));
   const found=searchTemplates(catalog,{query,category});
   results.replaceChildren(...found.map(card));
   for(const node of results.querySelectorAll('.template-card'))node.classList.toggle('selected',node.dataset.template===current.id);
   // Arrow keys move within the visible radios; keep one of them reachable with Tab.
   if(found.length&&!found.some(template=>template.id===current.id))results.querySelector('.template-radio').tabIndex=0;
   empty.textContent=found.length?'':query?`No templates match “${query.trim()}”.${category?' Try All categories.':''}`:'No templates in this category.';
   empty.hidden=found.length>0;
  }
  search.addEventListener('input',()=>{query=search.value;render();});
  search.addEventListener('keydown',event=>{if(event.key==='Enter'&&!composingEvent(event)){event.preventDefault();const first=results.querySelector('.template-radio:checked')||results.querySelector('.template-radio');first?.focus();}});

  const close=el('button',{type:'button',className:'icon-button template-close','aria-label':'Close templates',text:'×',onclick:()=>finish(null)});
  dialog.append(...[
   el('header',{className:'template-gallery-head'},
    el('div',{},el('h2',{id:'template-gallery-title',text:'New project'}),el('p',{id:'template-gallery-intro',text:'Choose a starting point. Every template compiles as it is, and comments in the source explain what to change.'})),close),
   note?el('p',{className:'template-note',role:'note',text:note}):null,
   el('div',{className:'template-tools'},searchBox,chips),
   el('div',{className:'template-body'},results,empty),
   el('footer',{className:'template-gallery-foot'},
    el('div',{className:'template-name-field'},el('label',{for:'template-project-name',text:'Project name'}),name,chosen),
    el('div',{className:'modal-actions'},el('button',{type:'button',className:'button secondary',text:'Cancel',onclick:()=>finish(null)}),el('button',{type:'button',className:'button primary template-create',text:'Create project',onclick:create})))].filter(Boolean));
  render();select(current);
  document.body.append(dialog);dialog.showModal();
  open={dialog,close:finish};
  // Focus the chosen card so arrow keys browse at once; scroll it into view for links.
  const checked=results.querySelector('.template-radio:checked');
  if(note&&checked){checked.focus({preventScroll:true});checked.closest('.template-card').scrollIntoView({block:'nearest'});}else search.focus();
 });
}
