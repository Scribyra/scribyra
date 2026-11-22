// Document templates (docs/templates.md): pure catalog rules shared by the app, the
// preview/site generator (scripts/templates.mjs) and the tests. No DOM, no Vite.
//
// A template is data: a folder under templates/documents/<id>/ with a template.json
// (the fields below) and its files. templates/documents/index.json lists the categories.
// A plugin could later contribute entries of the same shape (docs/plugins.md).

export const TEMPLATE_FRAGMENT='#template=';
export const TEMPLATE_ID=/^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;
const TEXT_LIMIT=400;
// Files a template may carry: sources, data and small images. Anything else is refused,
// so a template can never bring something the editor cannot show.
const ALLOWED_FILE=/^(?:[A-Za-z0-9_-][A-Za-z0-9._-]*\/){0,3}[A-Za-z0-9_-][A-Za-z0-9._-]*\.(?:tex|bib|cls|sty|bst|cfg|csv|txt|md|png|jpg|jpeg|pdf)$/;
const RESERVED=new Set(['template.json','preview.png']);

export class TemplateError extends Error{constructor(message){super(message);this.name='TemplateError';}}
const fail=message=>{throw new TemplateError(message);};
const text=(value,field,id,max=TEXT_LIMIT)=>{
 if(typeof value!=='string'||!value.trim()||value.length>max||/[\u0000-\u001f\u007f‪-‮⁦-⁩]/.test(value))fail(`Template ${id}: ${field} must be a short line of text.`);
 return value.trim();
};

/** Checks one template.json and the paths of its files; returns a clean, frozen entry. */
export function validateTemplate(meta,paths,categories){
 if(!meta||typeof meta!=='object'||Array.isArray(meta))fail('A template needs a template.json object.');
 const id=meta.id;
 if(typeof id!=='string'||!TEMPLATE_ID.test(id))fail(`Template id ${JSON.stringify(id)} must be lowercase letters, digits and dashes.`);
 const known=new Set(['id','name','category','order','description','keywords','main','preview']);
 for(const key of Object.keys(meta))if(!known.has(key))fail(`Template ${id}: unknown field ${key}.`);
 const name=text(meta.name,'name',id,60),description=text(meta.description,'description',id);
 if(!categories.some(category=>category.id===meta.category))fail(`Template ${id}: unknown category ${JSON.stringify(meta.category)}.`);
 if(!Number.isInteger(meta.order)||meta.order<0||meta.order>9999)fail(`Template ${id}: order must be a whole number.`);
 if(!Array.isArray(meta.keywords)||meta.keywords.length>20)fail(`Template ${id}: keywords must be a list.`);
 const keywords=meta.keywords.map(word=>text(word,'keyword',id,40));
 if(!Array.isArray(paths)||!paths.length)fail(`Template ${id} has no files.`);
 const files=[...paths].sort();
 for(const path of files)if(RESERVED.has(path)||!ALLOWED_FILE.test(path)||path.split('/').some(part=>part.startsWith('.')))fail(`Template ${id}: ${path} is not an allowed template file.`);
 if(new Set(files.map(path=>path.toLowerCase())).size!==files.length)fail(`Template ${id}: two files differ only by case.`);
 if(typeof meta.main!=='string'||!/\.tex$/.test(meta.main)||!files.includes(meta.main))fail(`Template ${id}: main must name one of its .tex files.`);
 // Which pages the preview image shows (scripts/templates.mjs): one page, a spread of two, or four slides.
 const preview=meta.preview??[1];
 if(!Array.isArray(preview)||![1,2,4].includes(preview.length)||preview.some(page=>!Number.isInteger(page)||page<1||page>999))fail(`Template ${id}: preview must list 1, 2 or 4 page numbers.`);
 return Object.freeze({id,name,category:meta.category,order:meta.order,description,keywords:Object.freeze(keywords),main:meta.main,files:Object.freeze(files),preview:Object.freeze([...preview])});
}

/** index.json plus every template's metadata and paths → {categories, templates}, in display order. */
export function buildCatalog(index,entries){
 if(index?.version!==1||!Array.isArray(index.categories)||!index.categories.length)fail('templates/documents/index.json must be version 1 with categories.');
 const categories=index.categories.map(category=>{
  if(typeof category?.id!=='string'||!TEMPLATE_ID.test(category.id))fail('Each category needs an id.');
  return Object.freeze({id:category.id,name:text(category.name,'category name',category.id,40)});
 });
 if(new Set(categories.map(category=>category.id)).size!==categories.length)fail('Category ids must be unique.');
 const templates=entries.map(({meta,paths})=>validateTemplate(meta,paths,categories));
 const ids=new Set();for(const template of templates){if(ids.has(template.id))fail(`Two templates use the id ${template.id}.`);ids.add(template.id);}
 const rank=new Map(categories.map((category,index)=>[category.id,index]));
 templates.sort((a,b)=>rank.get(a.category)-rank.get(b.category)||a.order-b.order||a.id.localeCompare(b.id));
 return Object.freeze({categories:Object.freeze(categories),templates:Object.freeze(templates)});
}

// Case- and accent-insensitive: "resume" finds "CV / résumé".
const fold=value=>String(value).normalize('NFD').replace(/\p{M}+/gu,'').toLowerCase();

/** Every word of the query must appear in the name, description, keywords or category name. */
export function searchTemplates(catalog,{query='',category=''}={}){
 const words=fold(query).split(/[^\p{L}\p{N}]+/u).filter(Boolean);
 return catalog.templates.filter(template=>{
  if(category&&template.category!==category)return false;
  if(!words.length)return true;
  // The category name is left out: "Slides and posters" would make every slide deck a poster. The chips filter by category.
  const haystack=fold([template.name,template.description,template.id,...template.keywords].join(' '));
  return words.every(word=>haystack.includes(word));
 });
}

/** The project name a template suggests until the person types their own. */
export function suggestedName(template){
 if(!template||template.id==='minimal')return 'Untitled project';
 if(template.id==='sample')return 'A space for your next great idea';
 return template.name.replace(/ \/.*$/,'');
}

/** https://app.scribyra.com/#template=<id>: opens the gallery with that template chosen. */
export function templateLink(id,app='https://app.scribyra.com/'){
 if(!TEMPLATE_ID.test(id))fail('Not a template id.');
 const base=new URL(app);base.hash='';
 return `${base.href}${TEMPLATE_FRAGMENT}${id}`;
}

/** Reads (and removes from the address bar) a `#template=<id>` link. Returns {id} or {error}. */
export function takeTemplateFragment(browser){
 const hash=browser.location.hash;
 if(!hash.startsWith(TEMPLATE_FRAGMENT))return null;
 browser.history.replaceState(null,'',browser.location.pathname+browser.location.search);
 const id=hash.slice(TEMPLATE_FRAGMENT.length);
 return TEMPLATE_ID.test(id)?{id}:{error:'This template link is damaged.'};
}
