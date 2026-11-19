// The outline tree (web/outline-model.js) over the Rust outline of each file.
import './helpers/core.mjs';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {source_outline} from '../web/pkg/scribyra_app.js';
import {buildOutline,currentNode,expansion,isExpanded,setExpanded,serializeExpansion,visibleRows,resolveInclude} from '../web/outline-model.js';

const project={
  'main.tex':'\\title{The \\emph{Thesis}}\n\\begin{document}\n\\part{First}\n\\input{chapters/one}\n\\include{chapters/two.tex}\n\\end{document}\n',
  'chapters/one.tex':'\\chapter{One}\\label{ch:one}\n\\section{Alpha}\ntext\n\\subsection{Detail}\n\\section{Beta}\n\\input{chapters/one}\n',
  'chapters/two.tex':'\\chapter{Two}\n\\section{Alpha}\n\\section{Alpha}\n',
  'notes/loose.tex':'Notes first.\n\\section{Loose}\n',
  'notes/empty.tex':'no headings\n',
};
function parse(files){
  const parsed=new Map();
  for(const file of files){
    const result=JSON.parse(source_outline(JSON.stringify([{id:file.id,path:file.path,content:file.content}])));
    parsed.set(file.id,{items:result.items,includes:result.includes,truncated:result.truncated});
  }
  return parsed;
}
const files=(sources=project)=>Object.entries(sources).map(([path,content],i)=>({id:`f${i}`,path,content}));
const titles=nodes=>nodes.map(node=>node.children.length?[node.title,titles(node.children)]:node.title);

test('the project outline follows includes from the main file and keeps other files apart',()=>{
  const list=files(),tree=buildOutline({files:list,parsed:parse(list),scope:'project',mainId:'f0'});
  assert.deepEqual(titles(tree.roots),['The Thesis',['First',[['One',[['Alpha',['Detail']],'Beta']],['Two',['Alpha','Alpha']]]],['notes/loose.tex',['Loose']]]);
  assert.equal(tree.headings,10,'a file group is not a heading');
  const two=tree.roots[1].children[1];
  assert.deepEqual(two.children.map(node=>node.key.split('/').pop()),['section:Alpha','section:Alpha#1']);
  assert.equal(two.fileId,'f2');assert.ok(tree.byKey.get(two.children[1].key)===two.children[1]);
  // A file that includes itself is read once on that path.
  assert.equal(tree.all.filter(node=>node.title==='Beta').length,1);
  const single=buildOutline({files:list,parsed:parse(list),scope:'file',activeId:'f1'});
  assert.deepEqual(titles(single.roots),[['One',[['Alpha',['Detail']],'Beta']]]);
});

test('node keys survive typing that moves headings, and the cursor finds its section',()=>{
  let list=files();const before=buildOutline({files:list,parsed:parse(list),mainId:'f0'});
  list=files({...project,'chapters/one.tex':'Some new opening text.\n'+project['chapters/one.tex']});
  const after=buildOutline({files:list,parsed:parse(list),mainId:'f0'});
  assert.deepEqual(after.all.map(node=>node.key),before.all.map(node=>node.key));
  const detail=after.all.find(node=>node.title==='Detail');
  assert.equal(currentNode(after,'f1',detail.start+3),detail);
  assert.equal(currentNode(after,'f1',0).title,'First','text before a file\'s first heading belongs to the section that includes it');
  assert.equal(currentNode(after,'f3',0).title,'notes/loose.tex');
  assert.equal(currentNode(after,'missing',0),null);
});

test('expansion defaults, explicit choices, collapse all and the stored form',()=>{
  const list=files(),tree=buildOutline({files:list,parsed:parse(list),mainId:'f0'});
  let state=expansion(null);
  assert.equal(visibleRows(state,tree).length,tree.all.length,'a short outline opens fully');
  state=expansion({mode:'collapsed'});
  assert.deepEqual(visibleRows(state,tree).map(node=>node.title),['The Thesis','First','notes/loose.tex']);
  const first=tree.roots[1];setExpanded(state,first,true);
  assert.deepEqual(visibleRows(state,tree).map(node=>node.title),['The Thesis','First','One','Two','notes/loose.tex']);
  const stored=JSON.parse(JSON.stringify(serializeExpansion(state)));
  assert.deepEqual(stored,{mode:'collapsed',open:{[first.key]:1}});
  const restored=expansion(stored);assert.equal(isExpanded(restored,tree,first),true);
  assert.equal(isExpanded(expansion({mode:'nonsense',open:{x:'bad'}}),tree,first),true,'unreadable stored state falls back to the default');
  // A long outline opens only its top level by default.
  const many={'main.tex':'\\chapter{Big}\n'+Array.from({length:80},(_,i)=>`\\section{S${i}}\n\\subsection{T${i}}\n`).join('')};
  const big=files(many),large=buildOutline({files:big,parsed:parse(big),mainId:'f0'});
  assert.equal(visibleRows(expansion(null),large).length,81);
});

test('include targets resolve from the main file, then from the including file',()=>{
  const byPath=new Map([['chapters/a.tex',{id:'a'}],['chapters/parts/b.tex',{id:'b'}],['c.tex',{id:'c'}]]);
  assert.equal(resolveInclude(byPath,'main.tex','main.tex','chapters/a')?.id,'a');
  assert.equal(resolveInclude(byPath,'main.tex','chapters/a.tex','parts/b')?.id,'b');
  assert.equal(resolveInclude(byPath,'main.tex','chapters/parts/b.tex','../../c.tex')?.id,'c');
  assert.equal(resolveInclude(byPath,'main.tex','main.tex','./chapters/../c')?.id,'c');
  assert.equal(resolveInclude(byPath,'main.tex','main.tex','missing'),null);
});
