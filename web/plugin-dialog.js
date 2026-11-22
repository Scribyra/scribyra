// Declarative plugin dialogs (docs/plugins.md#ui-contribution-model). A plugin describes
// a dialog as a tree of nodes; Scribyra validates it and renders it with its own classes
// and theme. Plugin text is only ever set as textContent, links must be https:, and the
// dialog always shows which plugin it comes from and a Dismiss button the plugin cannot
// remove. Interactive nodes have ids; elements are kept by id across updates, so typed
// values, choices and focus survive. A field's value from the spec is applied when it
// first appears and whenever the plugin raises its `version`.
import {restoreDialogFocus} from './input.js';
import {failure} from './plugin-errors.js';

const MAX_NODES=2000,ID=/^[a-z][a-z0-9_-]{0,63}$/i;
const TONES=new Set(['note','warning','muted','privacy','blocked','source','summary','empty']);
const BADGE_TONES=new Set(['added','changed','removed','conflict','cited','error','warning','neutral']);
const isObject=value=>!!value&&typeof value==='object'&&!Array.isArray(value);
function str(value,max,name,{optional=false}={}){
  if(value===undefined&&optional)return undefined;
  if(typeof value!=='string'||value.length>max)throw failure('invalid_dialog',`${name} must be text of at most ${max} characters.`);
  return value;
}
const https=href=>{let url;try{url=new URL(href);}catch{}if(!url||url.protocol!=='https:'||href.length>500)throw failure('invalid_dialog','Links in plugin dialogs must be https:// addresses.');return url.href;};
function content(node,name){
  if(node.content===undefined)return [str(node.text??'',4000,name)];
  if(!Array.isArray(node.content)||node.content.length>40)throw failure('invalid_dialog',`${name} content is a short list.`);
  return node.content.map(part=>{
    if(typeof part==='string')return str(part,4000,name);
    if(isObject(part)&&part.link!==undefined)return {link:https(part.link),text:str(part.text,200,'Link text')};
    if(isObject(part)&&part.code!==undefined)return {code:str(part.code,400,'Code')};
    throw failure('invalid_dialog',`${name} content holds text, links and code.`);
  });
}

/** Validates and normalises a dialog spec; throws a coded error on anything unexpected. */
export function validateDialogSpec(spec){
  if(!isObject(spec))throw failure('invalid_dialog','A dialog spec is an object.');
  let count=0;const ids=new Set();
  const id=(value,optional=false)=>{if(value===undefined&&optional)return undefined;if(typeof value!=='string'||!ID.test(value)||ids.has(value))throw failure('invalid_dialog',`Dialog ids must be unique words; “${value}” is not.`);ids.add(value);return value;};
  const button=item=>{if(!isObject(item))throw failure('invalid_dialog','A button is an object.');return {id:id(item.id),label:str(item.label,60,'Button label'),primary:!!item.primary,danger:!!item.danger,disabled:!!item.disabled,ariaLabel:str(item.ariaLabel,120,'Button name',{optional:true})};};
  const options=list=>{if(!Array.isArray(list)||list.length>500)throw failure('invalid_dialog','Options are a list of at most 500.');return list.map(option=>({value:str(option?.value,200,'Option value'),label:str(option?.label,200,'Option label')}));};
  function node(value,depth){
    if(++count>MAX_NODES)throw failure('invalid_dialog',`A dialog has at most ${MAX_NODES} parts.`);
    if(depth>8||!isObject(value))throw failure('invalid_dialog','Dialog parts are objects nested at most 8 deep.');
    const children=list=>{if(!Array.isArray(list))throw failure('invalid_dialog','Children are a list.');return list.map(child=>node(child,depth+1));};
    switch(value.type){
      case 'heading':return {type:'heading',text:str(value.text,200,'Heading'),level:value.level===4?4:3};
      case 'text':{const tone=value.tone===undefined?undefined:TONES.has(value.tone)?value.tone:null;if(tone===null)throw failure('invalid_dialog','Unknown text tone.');return {type:'text',content:content(value,'Text'),tone};}
      case 'link':return {type:'link',href:https(value.href),text:str(value.text,200,'Link text')};
      case 'field':{
        const input=['text','password','select','checkbox'].includes(value.input)?value.input:null;if(!input)throw failure('invalid_dialog','A field is text, password, select or checkbox.');
        return {type:'field',id:id(value.id),input,label:str(value.label,120,'Field label'),help:value.help===undefined?undefined:content({content:Array.isArray(value.help)?value.help:[value.help]},'Help'),
          value:input==='checkbox'?!!value.value:str(value.value??'',4000,'Field value'),version:Number.isSafeInteger(value.version)?value.version:0,
          options:input==='select'?options(value.options??[]):undefined,placeholder:str(value.placeholder,120,'Placeholder',{optional:true}),disabled:!!value.disabled,submit:value.submit===undefined?undefined:str(value.submit,64,'Submit')};
      }
      case 'group':return {type:'group',id:id(value.id,true),legend:str(value.legend,200,'Legend'),legendCode:!!value.legendCode,disabled:!!value.disabled,tone:value.tone==='conflict'?'conflict':undefined,key:str(value.key,200,'Key',{optional:true}),kind:str(value.kind,40,'Kind',{optional:true}),children:children(value.children??[])};
      case 'section':return {type:'section',label:str(value.label,200,'Section label'),children:children(value.children??[])};
      case 'badges':{if(!Array.isArray(value.items)||value.items.length>8)throw failure('invalid_dialog','At most eight badges.');return {type:'badges',items:value.items.map(item=>({text:str(item?.text,80,'Badge'),tone:BADGE_TONES.has(item?.tone)?item.tone:'neutral'}))};}
      case 'table':{
        const columns=Array.isArray(value.columns)&&value.columns.length>=2&&value.columns.length<=4?value.columns.map(column=>str(column,80,'Column')):null;if(!columns)throw failure('invalid_dialog','A table has two to four columns.');
        if(!Array.isArray(value.rows)||value.rows.length>200)throw failure('invalid_dialog','A table has at most 200 rows.');
        return {type:'table',caption:str(value.caption,200,'Caption'),columns,rows:value.rows.map(row=>{if(!Array.isArray(row)||row.length!==columns.length)throw failure('invalid_dialog','Each row has one cell per column.');return row.map(cell=>str(cell,4000,'Cell'));}),tones:Array.isArray(value.tones)?value.tones.slice(0,columns.length).map(tone=>['before','after'].includes(tone)?tone:''):[]};
      }
      case 'details':return {type:'details',summary:str(value.summary,120,'Summary'),text:str(value.text,20000,'Details')};
      case 'choice':return {type:'choice',id:id(value.id),label:str(value.label,200,'Choice label'),options:options(value.options),value:str(value.value??'',200,'Choice'),version:Number.isSafeInteger(value.version)?value.version:0};
      case 'status':return {type:'status',id:id(value.id??'status'),text:str(value.text??'',1000,'Status')};
      case 'list':{
        if(!Array.isArray(value.items)||value.items.length>200)throw failure('invalid_dialog','A list has at most 200 items.');
        return {type:'list',label:str(value.label,120,'List label',{optional:true}),empty:str(value.empty??'',200,'Empty text'),items:value.items.map(item=>{
          if(!isObject(item))throw failure('invalid_dialog','List items are objects.');
          if(Array.isArray(item.actions)&&item.actions.length>4)throw failure('invalid_dialog','At most four buttons per item.');
          return {title:str(item.title,300,'Item title'),detail:str(item.detail,500,'Item detail',{optional:true}),actions:(item.actions||[]).map(button)};
        })};
      }
      case 'actions':{if(!Array.isArray(value.buttons)||!value.buttons.length||value.buttons.length>5)throw failure('invalid_dialog','One to five buttons.');return {type:'actions',buttons:value.buttons.map(button)};}
      default:throw failure('invalid_dialog',`Unknown dialog part “${String(value.type).slice(0,40)}”.`);
    }
  }
  if(!Array.isArray(spec.children))throw failure('invalid_dialog','A dialog has children.');
  const result={title:str(spec.title,120,'Dialog title'),wide:!!spec.wide,initialFocus:spec.initialFocus===undefined?undefined:str(spec.initialFocus,64,'Initial focus'),children:spec.children.map(child=>node(child,0))};
  if(!result.children.some(child=>child.type==='actions'))throw failure('invalid_dialog','A dialog needs at least one row of buttons.');
  return result;
}

function el(tag,props={},...children){
  const node=document.createElement(tag);
  for(const [key,value]of Object.entries(props)){
    if(value===undefined||value===null||value===false)continue;
    if(key==='className')node.className=value;else if(key==='text')node.textContent=value;else node.setAttribute(key,value===true?'':value);
  }
  for(const child of children.flat())if(child!==null&&child!==undefined&&child!==false)node.append(child);
  return node;
}
function inline(parts){
  return parts.map(part=>typeof part==='string'?document.createTextNode(part):part.link?el('a',{href:part.link,target:'_blank',rel:'noopener noreferrer',text:part.text}):el('code',{text:part.code}));
}

/**
 * Opens a plugin dialog. `onEvent({type, control, values})` receives clicks, changes and
 * cancel; `onClosed()` runs once when it closes for any reason.
 */
export function openPluginDialog({plugin,spec,onEvent,onClosed=()=>{}}){
  const dialog=el('dialog',{className:`modal plugin-dialog${spec.wide?' wide':''}`,'aria-label':spec.title,'data-plugin':plugin.id});
  restoreDialogFocus(dialog);
  const keyed=new Map();let closed=false,current=spec;
  const values=()=>{
    const result={};
    for(const [id,entry]of keyed){
      if(entry.kind==='field')result[id]=entry.input==='checkbox'?entry.control.checked:entry.control.value;
      else if(entry.kind==='choice')result[id]=entry.node.querySelector('input:checked')?.value??'';
    }
    return result;
  };
  const emit=(type,control)=>{if(!closed)onEvent({type,control,values:values()});};
  const origin=el('div',{className:'plugin-dialog-origin'},
    el('span',{className:'plugin-chip',text:`${plugin.name} plugin${plugin.source==='developer'?' · developer, unverified':''}`}),
    el('button',{type:'button',className:'icon-button plugin-dismiss','aria-label':'Dismiss dialog',title:'Dismiss dialog',text:'×'}));
  origin.querySelector('button').addEventListener('click',()=>{emit('close',null);close();});
  const title=el('h2',{});
  const body=el('div',{className:'plugin-dialog-body'});

  function buttonNode(item){
    let entry=keyed.get(item.id);
    if(!entry||entry.kind!=='button'){const node=el('button',{type:'button'});node.addEventListener('click',()=>emit('click',item.id));entry={kind:'button',node};}
    entry.node.className=`button ${item.primary?'primary':'secondary'}${item.danger?' danger':''}`;entry.node.textContent=item.label;entry.node.disabled=item.disabled;
    if(item.ariaLabel)entry.node.setAttribute('aria-label',item.ariaLabel);else entry.node.removeAttribute('aria-label');
    keyed.set(item.id,entry);return entry.node;
  }
  function render(node){
    switch(node.type){
      case 'heading':return el(node.level===4?'h4':'h3',{text:node.text});
      case 'text':return el('p',{className:node.tone?`plugin-text tone-${node.tone}`:'plugin-text',role:node.tone==='blocked'?'note':undefined},inline(node.content));
      case 'link':return el('p',{className:'plugin-text'},el('a',{href:node.href,target:'_blank',rel:'noopener noreferrer',text:node.text}));
      case 'field':{
        let entry=keyed.get(node.id);
        if(!entry||entry.kind!=='field'||entry.input!==node.input){
          const control=node.input==='select'?el('select',{className:'input'}):el('input',{className:'input',type:node.input,autocomplete:'off',spellcheck:'false'});
          if(node.input==='checkbox')control.className='plugin-checkbox';
          const fieldId=`plugin-field-${Math.random().toString(36).slice(2)}`;control.id=fieldId;
          control.addEventListener('change',()=>emit('change',node.id));
          control.addEventListener('keydown',event=>{const submit=keyed.get(node.id)?.submit;if(event.key==='Enter'&&submit&&!event.isComposing){event.preventDefault();const target=keyed.get(submit);if(target?.kind==='button'&&!target.node.disabled)emit('click',submit);}});
          const label=el('label',{for:fieldId});
          const help=el('small',{className:'plugin-help',id:`${fieldId}-help`});
          entry={kind:'field',input:node.input,control,label,help,version:null,node:el('div',{className:`plugin-field${node.input==='checkbox'?' checkbox':''}`})};
        }
        const {control,label,help}=entry;
        label.textContent=node.label;
        if(node.help){help.replaceChildren(...inline(node.help));control.setAttribute('aria-describedby',help.id);}else control.removeAttribute('aria-describedby');
        if(node.input==='select'){
          const before=control.value,signature=JSON.stringify(node.options);
          if(entry.options!==signature){control.replaceChildren(...node.options.map(option=>el('option',{value:option.value,text:option.label})));entry.options=signature;if(node.options.some(option=>option.value===before)&&entry.version===node.version)control.value=before;}
        }
        if(entry.version!==node.version){if(node.input==='checkbox')control.checked=node.value;else control.value=node.value;entry.version=node.version;}
        if(node.placeholder!==undefined)control.placeholder=node.placeholder;else control.removeAttribute('placeholder');
        control.disabled=node.disabled;entry.submit=node.submit;
        entry.node.replaceChildren(...(node.input==='checkbox'?[control,label]:[label,control]),...(node.help?[help]:[]));
        keyed.set(node.id,entry);return entry.node;
      }
      case 'group':{
        const legend=el('legend',{},node.legendCode?el('code',{text:node.legend}):node.legend);
        const group=el('fieldset',{className:`plugin-group${node.tone?` is-${node.tone}`:''}`,'data-key':node.key,'data-kind':node.kind},legend,node.children.map(render));
        group.disabled=node.disabled;return group;
      }
      case 'section':return el('section',{className:'plugin-section','aria-label':node.label},node.children.map(render));
      case 'badges':return el('div',{className:'plugin-badges'},node.items.map(item=>el('span',{className:`plugin-badge tone-${item.tone}`,text:item.text})));
      case 'table':return el('table',{className:'plugin-table'},el('caption',{className:'sr-only',text:node.caption}),el('thead',{},el('tr',{},node.columns.map(column=>el('th',{scope:'col',text:column})))),
        el('tbody',{},node.rows.map(row=>el('tr',{},row.map((cell,i)=>i===0?el('th',{scope:'row',text:cell}):el('td',{className:node.tones[i]?`tone-${node.tones[i]}`:undefined,text:cell}))))));
      case 'details':return el('details',{className:'plugin-details'},el('summary',{text:node.summary}),el('pre',{text:node.text}));
      case 'choice':{
        let entry=keyed.get(node.id);
        if(!entry||entry.kind!=='choice'){entry={kind:'choice',version:null,name:`plugin-choice-${Math.random().toString(36).slice(2)}`,node:el('div',{className:'plugin-choices',role:'radiogroup'})};}
        const checked=entry.node.querySelector('input:checked')?.value,value=entry.version===node.version&&checked!==undefined?checked:node.value;
        entry.node.setAttribute('aria-label',node.label);
        entry.node.replaceChildren(...node.options.map(option=>{const input=el('input',{type:'radio',name:entry.name,value:option.value});input.checked=option.value===value;input.addEventListener('change',()=>emit('change',node.id));return el('label',{className:'plugin-choice'},input,el('span',{text:option.label}));}));
        entry.version=node.version;keyed.set(node.id,entry);return entry.node;
      }
      case 'status':{
        let entry=keyed.get(node.id);
        if(!entry||entry.kind!=='status')entry={kind:'status',node:el('p',{className:'plugin-status',role:'status','aria-live':'polite'})};
        if(entry.node.textContent!==node.text)entry.node.textContent=node.text;
        keyed.set(node.id,entry);return entry.node;
      }
      case 'list':return el('ul',{className:'plugin-list','aria-label':node.label},node.items.length?node.items.map(item=>el('li',{},el('div',{className:'plugin-list-text'},el('strong',{text:item.title}),item.detail?el('small',{text:item.detail}):null),item.actions.length?el('div',{className:'plugin-list-actions'},item.actions.map(buttonNode)):null)):el('li',{className:'plugin-empty',text:node.empty}));
      case 'actions':return el('div',{className:'modal-actions'},node.buttons.map(buttonNode));
    }
    return null;
  }
  function draw(spec){
    const focused=dialog.contains(document.activeElement)?document.activeElement:null;
    const selection=focused&&typeof focused.selectionStart==='number'?[focused.selectionStart,focused.selectionEnd]:null;
    // Elements kept by id are reused; anything no longer in the spec is dropped.
    const used=new Set(),track=keyed.set.bind(keyed);
    keyed.set=(key,value)=>{used.add(key);return track(key,value);};
    try{title.textContent=spec.title;dialog.setAttribute('aria-label',spec.title);dialog.classList.toggle('wide',spec.wide);body.replaceChildren(...spec.children.map(render));}
    finally{delete keyed.set;}
    for(const key of [...keyed.keys()])if(!used.has(key))keyed.delete(key);
    if(focused&&dialog.contains(focused)&&document.activeElement!==focused){focused.focus({preventScroll:true});if(selection)try{focused.setSelectionRange(...selection);}catch{}}
  }
  function close(){
    if(closed)return;closed=true;
    for(const entry of keyed.values())if(entry.kind==='field'&&entry.input==='password')entry.control.value='';
    if(dialog.open)dialog.close();dialog.remove();onClosed();
  }
  dialog.addEventListener('cancel',event=>{event.preventDefault();emit('cancel',null);});
  draw(spec);
  dialog.append(origin,title,body);document.body.append(dialog);dialog.showModal();
  const first=(spec.initialFocus&&keyed.get(spec.initialFocus))||null;
  const target=first?(first.control||first.node.querySelector?.('input')||first.node):dialog.querySelector('.modal-actions .button.primary:not(:disabled)')||body.querySelector('input,select,button:not(:disabled)');
  target?.focus();
  return {
    update(next){if(closed)return;current=next;draw(next);},
    close,
    get spec(){return current;},
  };
}
