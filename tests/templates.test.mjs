// Document templates (docs/templates.md): the catalog rules, search, links, the generated
// scribyra.com/templates/ page, and every template compiled with the real WebAssembly
// engine, offline (the mirror address is unreachable), so only bundled packages can load.
import './helpers/core.mjs';
import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,mkdtempSync,rmSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {buildCatalog,validateTemplate,searchTemplates,suggestedName,templateLink,takeTemplateFragment,TemplateError} from '../web/template-catalog.js';
import {loadCatalog,templateFolder,compileRuntime,compileTemplate,pooled,compileConcurrency,texErrors,texWarnings,pageCount,staleSiteFiles,PREVIEW,TEMPLATE_DIR} from '../scripts/templates.mjs';
import {STARTER} from '../web/model.js';

const catalog=loadCatalog();
const categories=[{id:'papers',name:'Papers'}];
const meta=(fields={})=>({id:'paper',name:'Paper',category:'papers',order:1,description:'A paper.',keywords:['x'],main:'main.tex',...fields});

test('the shipped catalog: twelve-plus templates in every category, ids match folders, each with a preview',()=>{
 const ids=catalog.templates.map(template=>template.id);
 for(const id of ['sample','minimal','article','report','book','thesis','beamer','poster','cv','cover-letter','homework','lab-report','lecture-notes'])assert(ids.includes(id),id);
 for(const category of catalog.categories)assert(catalog.templates.some(template=>template.category===category.id),`category ${category.id} is empty`);
 assert.equal(catalog.templates[0].id,'sample','the gallery opens on the sample paper, as New project always did');
 for(const template of catalog.templates){
  const png=readFileSync(join(templateFolder(template),'preview.png'));
  assert.equal(png.subarray(1,4).toString(),'PNG',template.id);
  assert.deepEqual([png.readUInt32BE(16),png.readUInt32BE(20)],[PREVIEW.width,PREVIEW.height],`${template.id} preview size`);
  assert(png.length<80*1024,`${template.id} preview is small (${png.length} bytes)`);
 }
});

test('the sample template is the sample paper itself, so the two cannot drift apart',()=>{
 assert.equal(readFileSync(join(TEMPLATE_DIR,'sample/main.tex'),'utf8'),STARTER);
});

test('templates explain themselves and bring the files they use',()=>{
 for(const template of catalog.templates){
  const main=readFileSync(join(templateFolder(template),template.main),'utf8');
  assert.doesNotThrow(()=>new TextDecoder('utf-8',{fatal:true}).decode(readFileSync(join(templateFolder(template),template.main))));
  if(template.id!=='sample')assert(main.split('\n').filter(line=>/^\s*%/.test(line)||/[^\\]%\s+\S/.test(line)).length>=3,`${template.id} has comments saying what to change`);
  const sources=template.files.filter(path=>path.endsWith('.tex')).map(path=>readFileSync(join(templateFolder(template),path),'utf8')).join('\n');
  if(/\\addbibresource|\\bibliography\{/.test(sources))assert(template.files.some(path=>path.endsWith('.bib')),`${template.id} cites, so it ships a .bib`);
  for(const [,file]of sources.matchAll(/\\(?:include|input)\{([^}]+)\}/g))assert(template.files.includes(file.endsWith('.tex')?file:`${file}.tex`),`${template.id}: ${file}`);
  assert.doesNotMatch(sources,/\\usepackage(?:\[[^\]]*\])?\{(?:inputenc|minted)\}/,`${template.id} uses nothing LuaLaTeX ignores or cannot run`);
 }
 const thesis=catalog.templates.find(template=>template.id==='thesis'),source=readFileSync(join(templateFolder(thesis),'main.tex'),'utf8');
 assert.match(source,/backend=biber/);assert.match(source,/\\frontmatter|\\pagenumbering\{roman\}/);
 assert(thesis.files.filter(path=>path.startsWith('chapters/')).length>=3);assert(thesis.files.some(path=>path.startsWith('frontmatter/')));
});

test('template.json is checked strictly: ids, fields, files and the main file',()=>{
 assert.equal(validateTemplate(meta(),['main.tex','references.bib','figures/plot.png'],categories).main,'main.tex');
 assert.deepEqual(validateTemplate(meta(),['main.tex'],categories).preview,[1]);
 const bad=[
  [meta({id:'Paper'}),['main.tex'],/lowercase/],[meta({id:'a--'}),['main.tex'],/lowercase/],
  [meta({colour:'red'}),['main.tex'],/unknown field colour/],[meta({category:'slides'}),['main.tex'],/unknown category/],
  [meta({main:'paper.tex'}),['main.tex'],/main must name/],[meta(),['main.tex','run.sh'],/not an allowed/],
  [meta(),['main.tex','.latexmkrc'],/not an allowed/],[meta(),['main.tex','../x.tex'],/not an allowed/],[meta(),['main.tex','template.json'],/not an allowed/],
  [meta(),['main.tex','Main.tex'],/differ only by case/],[meta(),[],/no files/],[meta({name:'x'.repeat(61)}),['main.tex'],/short line/],
  [meta({description:'bidi ‮ text'}),['main.tex'],/short line/],[meta({preview:[1,2,3]}),['main.tex'],/preview/],[meta({order:1.5}),['main.tex'],/order/],
 ];
 for(const [value,paths,message]of bad)assert.throws(()=>validateTemplate(value,paths,categories),error=>error instanceof TemplateError&&message.test(error.message),JSON.stringify(value).slice(0,80));
 assert.throws(()=>buildCatalog({version:1,categories},[{meta:meta(),paths:['main.tex']},{meta:meta(),paths:['main.tex']}]),/Two templates use the id paper/);
 assert.throws(()=>buildCatalog({version:2,categories},[]),/version 1/);
 const sorted=buildCatalog({version:1,categories:[{id:'b',name:'B'},{id:'a',name:'A'}]},[{meta:meta({id:'x',category:'a',order:1}),paths:['main.tex']},{meta:meta({id:'y',category:'b',order:9}),paths:['main.tex']},{meta:meta({id:'z',category:'b',order:2}),paths:['main.tex']}]);
 assert.deepEqual(sorted.templates.map(template=>template.id),['z','y','x'],'category order first, then each template’s order');
});

test('search folds case and accents, needs every word, and combines with a category',()=>{
 const ids=options=>searchTemplates(catalog,options).map(template=>template.id);
 assert.deepEqual(ids({query:'resume'}),['cv']);
 assert.deepEqual(ids({query:'RÉSUMÉ'}),['cv']);
 assert(ids({query:'biber'}).includes('thesis'));
 assert.deepEqual(ids({query:'thesis chapters biber'}),['thesis']);
 assert.deepEqual(ids({query:'poster',category:'slides'}),['poster']);
 assert.deepEqual(ids({query:'poster',category:'career'}),[]);
 assert.deepEqual(ids({category:'career'}),['cv','cover-letter']);
 assert.equal(ids({}).length,catalog.templates.length);
 assert.deepEqual(ids({query:'zzzz'}),[]);
 assert(ids({query:'  slides  '}).includes('beamer'));
});

test('suggested names and #template= links',()=>{
 const byId=id=>catalog.templates.find(template=>template.id===id);
 assert.equal(suggestedName(byId('minimal')),'Untitled project');
 assert.equal(suggestedName(byId('sample')),'A space for your next great idea');
 assert.equal(suggestedName(byId('cv')),'CV');assert.equal(suggestedName(byId('thesis')),'Thesis');
 assert.equal(templateLink('thesis'),'https://app.scribyra.com/#template=thesis');
 assert.equal(templateLink('cv','http://localhost:4173/app/?x=1#old'),'http://localhost:4173/app/?x=1#template=cv');
 assert.throws(()=>templateLink('../x'),/Not a template id/);
 const browser=hash=>{const calls=[];return {location:{hash,pathname:'/app/',search:''},history:{replaceState:(...args)=>calls.push(args)},calls};};
 let b=browser('#template=lab-report');assert.deepEqual(takeTemplateFragment(b),{id:'lab-report'});assert.deepEqual(b.calls,[[null,'','/app/']]);
 b=browser('#template=<script>');assert.deepEqual(takeTemplateFragment(b),{error:'This template link is damaged.'});assert.equal(b.calls.length,1,'a damaged link is still removed');
 b=browser('#open?repo=github.com/a/b');assert.equal(takeTemplateFragment(b),null);assert.equal(b.calls.length,0);
});

test('site/templates/ is generated from the catalog and is current',()=>{
 assert.deepEqual(staleSiteFiles(catalog),[],'run: node scripts/templates.mjs site');
 const page=readFileSync(new URL('../site/templates/index.html',import.meta.url),'utf8');
 for(const template of catalog.templates){assert(page.includes(`href="https://app.scribyra.com/#template=${template.id}"`),template.id);assert(page.includes(`src="previews/${template.id}.png"`));}
});

let work,runtime;
before(()=>{work=mkdtempSync(join(tmpdir(),'scribyra-templates-'));runtime=compileRuntime(join(work,'runtime'));});
after(()=>{if(work)rmSync(work,{recursive:true,force:true});});

test('every template compiles offline with the bundled packages: pages, no errors, no warnings',async()=>{
 const results=await pooled(catalog.templates,compileConcurrency(),async template=>({template,result:await compileTemplate(template,{runtime,work})}));
 for(const {template,result}of results){
  assert.equal(result.status,'Success',`${template.id}: ${result.error||''}\n${texErrors(result.log).join('\n')}\n${result.log.slice(-3000)}`);
  assert(result.pdf&&existsSync(result.pdf),template.id);
  const pages=await pageCount(result.pdf);
  assert(pages>=1,`${template.id} has pages`);
  assert(Math.max(...template.preview)<=pages,`${template.id}: preview pages exist`);
  assert.deepEqual(texErrors(result.log),[],template.id);
  assert.deepEqual(texWarnings(result.log),[],`${template.id} compiles cleanly`);
 }
});
