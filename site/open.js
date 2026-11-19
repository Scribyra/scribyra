// The "Open in Scribyra" link generator (open.html). Everything happens on this page:
// nothing typed here is sent anywhere, and no repository is contacted.
import {parseRepositoryInput,formatOpenLink,cleanPath,checkRef,OpenLinkError,DEFAULT_APP_URL} from './open-link-format.js';

const BADGE_HOST='https://scribyra.com/';
const $=id=>document.getElementById(id);
const form=$('open-form'),status=$('open-status'),output=document.querySelector('.open-output');
const fields=['source','ref','path','main','name','style'].map(name=>form.elements[name]);
const escapeHtml=text=>text.replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
let lastSource='';

function describe(){
 const source=form.elements.source.value.trim();
 if(!source)return null;
 const parsed=parseRepositoryInput(source);
 // Values found in a pasted address fill empty fields once; what a person types wins.
 if(source!==lastSource){
  lastSource=source;
  for(const key of ['ref','path','main','name'])if(parsed[key]&&!form.elements[key].value)form.elements[key].value=parsed[key];
 }
 const link={...parsed,ref:'',path:'',main:'',name:''};
 const ref=form.elements.ref.value.trim(),path=form.elements.path.value.trim(),main=form.elements.main.value.trim(),name=form.elements.name.value.trim();
 if(ref){if(link.kind==='zip')throw new OpenLinkError('ZIP files have no branch; leave “Branch, tag or commit” empty.');link.ref=checkRef(ref);}
 link.path=cleanPath(path,'folder');
 link.main=cleanPath(main,'main file');
 link.name=name;
 return link;
}
function render(){
 let link;
 try{link=describe();}
 catch(error){output.hidden=true;status.textContent=error instanceof OpenLinkError?error.message:'That address could not be read.';status.dataset.state='error';return;}
 if(!link){output.hidden=true;status.textContent='';delete status.dataset.state;return;}
 let url;
 try{url=formatOpenLink(link,DEFAULT_APP_URL);}
 catch(error){output.hidden=true;status.textContent=error.message;status.dataset.state='error';return;}
 const badge=form.elements.style.value,image=BADGE_HOST+badge,height=badge.includes('flat')?20:28;
 $('open-link').value=url;
 $('open-markdown').value=`[![Open in Scribyra](${image})](${url})`;
 $('open-html').value=`<a href="${escapeHtml(url)}"><img src="${image}" alt="Open in Scribyra" height="${height}"></a>`;
 $('open-rst').value=`.. image:: ${image}\n   :target: ${url}\n   :alt: Open in Scribyra`;
 $('open-preview-link').href=url;$('open-try').href=url;
 output.hidden=false;
 // Show every snippet whole: grow each box to its content.
 for(const area of output.querySelectorAll('textarea')){area.style.height='auto';area.style.height=`${area.scrollHeight+2}px`;}
 const preview=$('open-preview-badge');preview.src=badge;preview.height=height;
 status.textContent=`Opens ${link.kind==='zip'?link.url:`${link.host}/${link.repo}`}${link.ref?` at ${link.ref}`:''}${link.path?`, folder ${link.path}`:''}.`;status.dataset.state='ok';
}
async function copy(button){
 const area=$(button.dataset.copy),label=button.textContent;
 let copied=false;
 try{await navigator.clipboard.writeText(area.value);copied=true;}
 catch{area.focus();area.select();try{copied=document.execCommand('copy');}catch{}}
 status.textContent=copied?`${label.replace(/^Copy /,'').replace(/^./,c=>c.toUpperCase())} copied.`:'Select the text and copy it with your keyboard.';
 button.textContent=copied?'Copied':label;setTimeout(()=>{button.textContent=label;},1500);
}
for(const field of fields)field.addEventListener('input',render);
form.elements.style.addEventListener('change',render);
form.addEventListener('submit',event=>event.preventDefault());
for(const button of document.querySelectorAll('[data-copy]'))button.addEventListener('click',()=>void copy(button));
render();
addEventListener('resize',render);
