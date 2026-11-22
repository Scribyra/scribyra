// The built-in document templates, bundled by Vite from templates/documents/
// (docs/templates.md). Metadata and preview images load with the app; a template's
// files load only when someone creates a project from it. Rules: template-catalog.js.
import {buildCatalog} from './template-catalog.js';
import index from '../templates/documents/index.json';

const ROOT='../templates/documents/';
const metas=import.meta.glob('../templates/documents/*/template.json',{eager:true,import:'default'});
const texts=import.meta.glob('../templates/documents/*/**/*.{tex,bib,cls,sty,bst,cfg,csv,txt,md}',{query:'?raw',import:'default'});
const binaries=import.meta.glob(['../templates/documents/*/**/*.{png,jpg,jpeg,pdf}','!../templates/documents/*/preview.png'],{query:'?url',import:'default'});
const previews=import.meta.glob('../templates/documents/*/preview.png',{eager:true,query:'?url',import:'default'});

const split=key=>{const rest=key.slice(ROOT.length),at=rest.indexOf('/');return [rest.slice(0,at),rest.slice(at+1)];};
const loaders=new Map();
for(const [key,load] of [...Object.entries(texts).map(([key,load])=>[key,{load,text:true}]),...Object.entries(binaries).map(([key,load])=>[key,{load,text:false}])]){
 const [folder,path]=split(key);if(!loaders.has(folder))loaders.set(folder,new Map());loaders.get(folder).set(path,load);
}

let catalog;
try{
 catalog=buildCatalog(index,Object.entries(metas).map(([key,meta])=>{const [folder]=split(key);return {meta,paths:[...(loaders.get(folder)?.keys()||[])]};}));
}catch(error){
 // A broken template must never stop the app from starting; tests catch it before release.
 console.error(error);catalog={categories:[],templates:[]};
}
export const templateCatalog=()=>catalog;
export const templateById=id=>catalog.templates.find(template=>template.id===id)||null;
export const previewUrl=id=>previews[`${ROOT}${id}/preview.png`]||null;

/** The template's files as project entries: [{path, content: string | Uint8Array}]. */
export async function templateEntries(id){
 const template=templateById(id);if(!template)throw new Error('This template is not available.');
 const files=loaders.get(id);
 return Promise.all(template.files.map(async path=>{
  const {load,text}=files.get(path),value=await load();
  if(text)return {path,content:value};
  const response=await fetch(value);if(!response.ok)throw new Error(`The template file ${path} could not be loaded.`);
  return {path,content:new Uint8Array(await response.arrayBuffer())};
 }));
}
