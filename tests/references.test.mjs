import './helpers/core.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as Y from 'yjs';
import { addEntries, projectNode, projectNodes, planRelocation, applyRelocation, figureSnippet } from '../web/model.js';
function project(){const doc=new Y.Doc();addEntries(doc,[{id:'main',path:'paper/main.tex',content:'% 🌍\n\\input{../chapters/été}\n\\input{../chapters/été.tex}\n\\includegraphics{../figures/plot}'},{id:'chapter',path:'chapters/été.tex',content:'body'},{id:'image',path:'figures/plot.png',content:new Uint8Array([1])}]);doc.getMap('meta').set('mainFile','main');return doc;}
test('review applies selected edits and a subtree move in one transaction without changing identities',()=>{
  const doc=project(),folder=projectNodes(doc).find(n=>n.path==='chapters');
  const plan=planRelocation(doc,folder.id,'sections');assert.equal(plan.edits.length,2);
  assert.equal(plan.edits[0].before,'../chapters/été');assert.equal(plan.edits[0].after,'../sections/été');
  let updates=0;doc.on('update',()=>updates++);applyRelocation(doc,plan,[0]);assert.equal(updates,1);
  assert.equal(projectNode(doc,'chapter').path,'sections/été.tex');assert.equal(doc.getText('text:main').toString(),'% 🌍\n\\input{../sections/été}\n\\input{../chapters/été.tex}\n\\includegraphics{../figures/plot}');
  assert.throws(()=>applyRelocation(doc,plan,[0]),/changed while reviewing/);doc.destroy();
});
test('stale reviews reject text and graph changes without partial mutations',()=>{
  const doc=project(),plan=planRelocation(doc,'chapter','renamed.tex');doc.getText('text:main').insert(0,'another edit\n');
  const before=Y.encodeStateAsUpdate(doc);assert.throws(()=>applyRelocation(doc,plan,[0]),/changed while reviewing/);assert.deepEqual(Y.encodeStateAsUpdate(doc),before);
  const next=planRelocation(doc,'chapter','renamed.tex');addEntries(doc,[{path:'extra.tex',content:'new'}]);assert.throws(()=>applyRelocation(doc,next,[]),/changed while reviewing/);
  const valid=planRelocation(doc,'chapter','renamed.tex');assert.throws(()=>applyRelocation(doc,valid,[999]),/Invalid reference/);assert.equal(projectNode(doc,'chapter').path,'chapters/été.tex');doc.destroy();
});
test('moving main repairs relative paths, and figures use main-directory paths',()=>{
  const doc=project();assert.equal(figureSnippet(doc,'image'),'\\includegraphics[width=\\linewidth]{../figures/plot.png}');
  const plan=planRelocation(doc,'main','main.tex');assert.equal(plan.edits.length,3);applyRelocation(doc,plan,[0,1,2]);
  assert.match(doc.getText('text:main').toString(),/\\input\{chapters\/été\}/);assert.match(doc.getText('text:main').toString(),/\\includegraphics\{figures\/plot\}/);
  assert.equal(figureSnippet(doc,'image'),'\\includegraphics[width=\\linewidth]{figures/plot.png}');doc.destroy();
});
test('macro and ambiguous references remain untouched with explicit review warnings',()=>{
  const doc=project();doc.getText('text:main').insert(0,'\\includegraphics{\\folder/plot} \\graphicspath{{../figures/}}\n');addEntries(doc,[{path:'figures/plot.pdf',content:new Uint8Array([2])}]);
  const plan=planRelocation(doc,'image','renamed.png');assert.equal(plan.edits.length,0);assert.equal(plan.warnings.length,3);applyRelocation(doc,plan,[]);assert.equal(projectNode(doc,'image').path,'renamed.png');doc.destroy();
});

test('comma-separated bibliography, include-only and local style references preserve surrounding syntax',()=>{
  const doc=new Y.Doc();addEntries(doc,[
    {id:'main',path:'main.tex',content:'\\includeonly{ chapters/one , chapters/two }\n\\bibliography{ refs/one ,refs/two.bib}\n\\bibliographystyle{styles/custom}'},
    {id:'one',path:'chapters/one.tex',content:'one'},{id:'two',path:'chapters/two.tex',content:'two'},
    {id:'ref1',path:'refs/one.bib',content:'one'},{id:'ref2',path:'refs/two.bib',content:'two'},
    {id:'style',path:'styles/custom.bst',content:'style'}]);doc.getMap('meta').set('mainFile','main');
  for(const [path,next] of [['chapters','sections'],['refs','bibliography'],['styles','formats']]){
    const folder=projectNodes(doc).find(n=>n.path===path);const plan=planRelocation(doc,folder.id,next);assert(plan.edits.length>0);applyRelocation(doc,plan,plan.edits.map((_,i)=>i));
  }
  assert.equal(doc.getText('text:main').toString(),'\\includeonly{ sections/one , sections/two }\n\\bibliography{ bibliography/one ,bibliography/two.bib}\n\\bibliographystyle{formats/custom}');doc.destroy();
});
test('unsafe destination characters are flagged without proposing broken TeX arguments',()=>{
  const doc=project(),plan=planRelocation(doc,'image','plot%new.png');assert.equal(plan.edits.length,0);assert.match(plan.warnings.join(' '),/special characters/);applyRelocation(doc,plan,[]);assert.throws(()=>figureSnippet(doc,'image'),/special characters/);doc.destroy();
});
