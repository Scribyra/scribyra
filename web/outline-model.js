// The outline tree: headings from each file's Rust outline, spliced together in document order.
// Pure functions only, so the tree can be built and checked without a browser.

const normalize=path=>{const parts=[];for(const part of path.split('/')){if(!part||part==='.')continue;if(part==='..')parts.pop();else parts.push(part);}return parts.join('/');};
const dirname=path=>path.includes('/')?path.slice(0,path.lastIndexOf('/')+1):'';

/** The project file an `\input{target}` names: relative to the main file, then to the including file. */
export function resolveInclude(byPath,mainPath,fromPath,target){
  const literal=target.trim().replace(/^"|"$/g,'');if(!literal)return null;
  for(const base of [dirname(mainPath),dirname(fromPath)])for(const suffix of ['','.tex']){const file=byPath.get(normalize(base+literal+suffix));if(file)return file;}
  return null;
}

/*
 * Builds the tree for one scope.
 * `files` lists the project's text files ({id,path}); `parsed` maps a file id to its outline
 * ({items,includes}). `scope` is 'project' (follow includes from the main file, then any file the
 * document never includes) or 'file' (the active file alone).
 *
 * Node keys come from the path of titles, not from positions, so typing elsewhere keeps every
 * node's identity and its expanded state. Two siblings with the same title get #1, #2, …
 */
export function buildOutline({files,parsed,scope='project',mainId='',activeId=''}){
  const byPath=new Map(),byId=new Map();for(const file of files){byPath.set(file.path,file);byId.set(file.id,file);}
  const roots=[],all=[],byFile=new Map(),context=new Map();let headings=0,truncated=false;
  const stack=[];const siblings=new Map();
  const keyFor=(parent,label)=>{const base=`${parent?parent.key:''}/${label}`,seen=siblings.get(base)||0;siblings.set(base,seen+1);return seen?`${base}#${seen}`:base;};
  const add=(node,parent)=>{node.parent=parent||null;node.children=[];node.depth=parent?parent.depth+1:0;const list=parent?parent.children:roots;list.push(node);node.pos=list.length;node.index=all.length;all.push(node);return node;};
  const place=(file,item)=>{
    // \title is a leaf at the top; a beamer frame title sits under the section it belongs to.
    const title=item.command==='title',level=item.command==='frametitle'?3:item.level;
    if(title)stack.length=0;else while(stack.length&&stack.at(-1).level>=level&&stack.at(-1).kind!=='file')stack.pop();
    const parent=stack.at(-1),label=`${item.command||item.level}:${item.title}`;
    const node=add({kind:'heading',key:keyFor(parent,label),title:item.title,command:item.command||'',level,fileId:file.id,path:file.path,start:item.start,line:item.line},parent);
    if(!title)stack.push(node);headings++;
    let list=byFile.get(file.id);if(!list)byFile.set(file.id,list=[]);list.push(node);
  };
  const visit=(file,open)=>{
    const outline=parsed.get(file.id);if(!outline)return;truncated||=Boolean(outline.truncated);
    if(!context.has(file.id))context.set(file.id,stack.at(-1)||null);
    const events=[...outline.items.map(item=>({item})),...(scope==='project'?outline.includes||[]:[]).map(include=>({include}))].sort((a,b)=>(a.item||a.include).start-(b.item||b.include).start);
    for(const event of events){
      if(event.item){place(file,event.item);continue;}
      const target=resolveInclude(byPath,byId.get(mainId)?.path||'',file.path,event.include.target);
      if(target&&!open.has(target.id)&&open.size<64){open.add(target.id);visit(target,open);open.delete(target.id);reached.add(target.id);}
    }
  };
  const reached=new Set();
  if(scope==='file'){const file=byId.get(activeId);if(file)visit(file,new Set([file.id]));}
  else{
    const main=byId.get(mainId);
    if(main){reached.add(main.id);visit(main,new Set([main.id]));}
    // Files the main document never includes still belong to the project; each gets its own group.
    for(const file of [...files].sort((a,b)=>a.path.localeCompare(b.path))){
      if(reached.has(file.id)||!parsed.get(file.id)?.items.length)continue;
      stack.length=0;const group=add({kind:'file',key:keyFor(null,`file:${file.path}`),title:file.path,command:'',level:-1,fileId:file.id,path:file.path,start:0,line:1},null);
      stack.push(group);context.set(file.id,group);visit(file,new Set([file.id]));stack.length=0;
    }
  }
  for(const list of byFile.values())list.sort((a,b)=>a.start-b.start);
  return {roots,all,headings,truncated,byFile,context,byKey:new Map(all.map(node=>[node.key,node]))};
}

/** The heading that contains `offset` in a file, or the heading the file's include sits under. */
export function currentNode(tree,fileId,offset){
  const list=tree.byFile.get(fileId);
  if(list?.length){let low=0,high=list.length-1,found=-1;while(low<=high){const mid=(low+high)>>1;if(list[mid].start<=offset){found=mid;low=mid+1;}else high=mid-1;}if(found>=0)return list[found];}
  return tree.context.get(fileId)||null;
}

/*
 * Which nodes are open. `mode` is the default for nodes the person never toggled: 'auto' opens
 * everything in a short outline and only the top level of a long one; 'expanded' and 'collapsed'
 * come from Expand all and Collapse all. `open` records explicit choices by node key.
 */
export function expansion(saved){
  const mode=['auto','expanded','collapsed'].includes(saved?.mode)?saved.mode:'auto';
  const open=new Map(saved&&typeof saved.open==='object'?Object.entries(saved.open).filter(([,v])=>v===0||v===1).slice(-4000):[]);
  return {mode,open};
}
export function isExpanded(state,tree,node){
  if(!node.children.length)return false;
  const choice=state.open.get(node.key);if(choice!==undefined)return choice===1;
  return state.mode==='expanded'||(state.mode==='auto'&&(tree.headings<=60||node.depth===0));
}
export function setExpanded(state,node,value){state.open.delete(node.key);state.open.set(node.key,value?1:0);while(state.open.size>4000)state.open.delete(state.open.keys().next().value);}
export function serializeExpansion(state){return {mode:state.mode,open:Object.fromEntries(state.open)};}

/** The rows a person sees: depth-first through open nodes. */
export function visibleRows(state,tree){
  const rows=[];const walk=nodes=>{for(const node of nodes){rows.push(node);if(isExpanded(state,tree,node))walk(node.children);}};walk(tree.roots);return rows;
}
