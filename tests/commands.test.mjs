import './helpers/core.mjs';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import * as Y from 'yjs';
import {projectCommands,projectRevision,entryCommand} from '../web/commands.js';
import {addEntries,projectNode} from '../web/model.js';
import {blob_hash} from '../web/pkg/scribyra_app.js';
function setup(capabilities){const doc=new Y.Doc();addEntries(doc,[{id:'main',path:'main.tex',content:'🌍 alpha alpha'},{id:'chapter',path:'chapters/été.tex',content:'chapter'}]);doc.getMap('meta').set('mainFile','main');doc.getMap('meta').set('name','Project');doc.getMap('meta').set('engine','pdflatex');return{doc,host:projectCommands({doc,projectId:'project',capabilities})};}
function request(host,command,overrides={}){return{version:1,requestId:crypto.randomUUID(),projectId:'project',expectedRevision:host.revision(),command,...overrides};}
function bytes(doc){return Y.encodeStateAsUpdate(doc);}
test('command grants, protocol and project scope are checked before access or mutation',()=>{
  const {doc,host}=setup(['read']),before=bytes(doc);
  for(const [command,overrides,code]of [
    [{op:'node.delete',id:'main'},{},'permission_denied'],
    [{op:'file.read',id:'main'},{projectId:'other'},'permission_denied'],
    [{op:'project.inspect'},{version:2},'unsupported_version'],
    [{op:'project.inspect',admin:true},{},'invalid_request'],
    [{op:'project.export'},{},'permission_denied'],
  ])assert.equal(host.execute(request(host,command,overrides)).error.code,code);
  assert.deepEqual(bytes(doc),before);const result=host.run({op:'file.read',id:'main'});assert.equal(result.content,'🌍 alpha alpha');host.close();assert.equal(host.execute(request(host,{op:'project.inspect'})).error.code,'project_closed');doc.destroy();
});
test('revisions include deletion-only updates and reject writes after restart or concurrent change',()=>{
  const {doc,host}=setup(),revision=host.revision(),vector=Y.encodeStateVector(doc),old=request(host,{op:'project.configure',name:'New'});
  doc.getText('text:main').delete(3,5);assert.deepEqual(Y.encodeStateVector(doc),vector);assert.notEqual(host.revision(),revision);assert.equal(host.execute(old).error.code,'revision_conflict');assert.equal(doc.getMap('meta').get('name'),'Project');
  const reopened=new Y.Doc();Y.applyUpdate(reopened,bytes(doc));const next=projectCommands({doc:reopened,projectId:'project'});assert.notEqual(next.revision(),host.revision());assert.equal(next.execute(request(host,{op:'node.delete',id:'main'})).error.code,'revision_conflict');
  assert.equal(host.execute(request(host,{op:'node.delete',id:'main'},{expectedRevision:undefined})).error.code,'revision_required');reopened.destroy();doc.destroy();
});
test('successful request retries return the original receipt without duplicating mutations',()=>{
  const {doc,host}=setup();const command=request(host,{op:'node.duplicate',id:'chapter',path:'copy.tex'}),first=host.execute(command);assert.equal(first.ok,true);const after=bytes(doc);
  doc.getText('text:main').insert(0,'later ');const changed=bytes(doc);assert.deepEqual(host.execute(command),first);assert.deepEqual(bytes(doc),changed);
  const reused={...command,command:{op:'node.delete',id:'main'}};assert.equal(host.execute(reused).error.code,'request_id_reused');assert.deepEqual(bytes(doc),changed);assert.notDeepEqual(after,changed);doc.destroy();
});
test('project settings validate the selected file and remain atomic on failure',()=>{
  const {doc,host}=setup();host.run({op:'node.delete',id:'chapter'});const before=bytes(doc);
  assert.throws(()=>host.run({op:'project.configure',name:'Wrong',engine:'lualatex',mainFile:'chapter'}),/existing/);assert.deepEqual(bytes(doc),before);
  assert.throws(()=>host.run({op:'project.configure',name:'',engine:'lualatex'}),/names/);assert.deepEqual(bytes(doc),before);
  assert.throws(()=>host.run({op:'project.configure',engine:'pdflatex'}),/LuaLaTeX only/);assert.deepEqual(bytes(doc),before);
  host.run({op:'project.configure',name:'New',engine:'lualatex',mainFile:'main'});assert.equal(doc.getMap('meta').get('engine'),'lualatex');doc.destroy();
});
test('source patches validate Unicode ranges and every target before one atomic update',()=>{
  const {doc,host}=setup(),before=bytes(doc);const edit={fileId:'main',start:3,end:8,before:'alpha',after:'β'};
  for(const edits of [[edit,{fileId:'missing',start:0,end:0,before:'',after:'oops'}],[edit,edit],[{...edit,start:1,end:2,before:''}],[{...edit,before:'wrong'}]]){assert.equal(host.execute(request(host,{op:'text.patch',edits})).ok,false);assert.deepEqual(bytes(doc),before);}
  let updates=0;doc.on('update',()=>updates++);const result=host.run({op:'text.patch',edits:[edit,{fileId:'chapter',start:0,end:7,before:'chapter',after:'CHAPTER'}]});assert.equal(result.count,2);assert.equal(updates,1);assert.equal(doc.getText('text:main').toString(),'🌍 β alpha');assert.equal(doc.getText('text:chapter').toString(),'CHAPTER');doc.destroy();
});
test('binary attachments are separate, checked before mutation, and returned as isolated copies',()=>{
  const {doc,host}=setup(),added=entryCommand([{id:'image',path:'images/test.png',content:new Uint8Array([1,2,3])}]),before=bytes(doc),command=request(host,added.command);
  assert.equal(host.execute(command).error.code,'blob_unavailable');assert.deepEqual(bytes(doc),before);
  const bad=new Map([[added.command.entries[0].blob.hash,new Uint8Array([3,2,1])]]);assert.equal(host.execute(command,bad).ok,false);assert.deepEqual(bytes(doc),before);
  assert.equal(host.execute(command,added.attachments).ok,true);const result=host.run({op:'file.read',id:'image'});result.bytes[0]=99;result.blob.hash='changed';assert.deepEqual([...host.run({op:'file.read',id:'image'}).bytes],[1,2,3]);
  assert.equal(host.run({op:'file.read',id:'image'}).blob.hash,blob_hash(new Uint8Array([1,2,3])));assert.equal(projectNode(doc,'image').path,'images/test.png');doc.destroy();
});
test('relocation planning and application share a revision and support reviewed reference rewrites',()=>{
  const {doc,host}=setup();doc.getText('text:main').insert(0,'\\input{chapters/été}\n');const revision=projectRevision(doc),plan=host.run({op:'node.planRelocation',id:'chapter',path:'chapters/renamed.tex'},revision);assert.equal(plan.edits.length,1);
  host.run({op:'node.relocate',id:'chapter',path:'chapters/renamed.tex',selectedReferences:[0]},revision);assert.match(doc.getText('text:main').toString(),/chapters\/renamed/);assert.equal(projectNode(doc,'chapter').path,'chapters/renamed.tex');doc.destroy();
});
test('expired replay receipts and inactive adapters cannot reapply old operations',()=>{
  const {doc,host}=setup();const original=request(host,{op:'node.duplicate',id:'chapter',path:'once.tex'});assert.equal(host.execute(original).ok,true);
  for(let i=0;i<129;i++)host.run({op:'project.configure',name:`Change ${i}`});const before=bytes(doc);assert.equal(host.execute(original).error.code,'revision_conflict');assert.deepEqual(bytes(doc),before);
  let active=true;const grants=['read'],reader=projectCommands({doc,projectId:'project',capabilities:grants,isActive:()=>active});grants.push('write');assert.equal(reader.execute(request(reader,{op:'node.delete',id:'main'})).error.code,'permission_denied');active=false;assert.equal(reader.execute(request(reader,{op:'file.read',id:'main'})).error.code,'project_closed');
  const malformed=host.execute(request(host,{op:'project.inspect'},{requestId:'x'.repeat(1000)}));assert.equal(malformed.error.code,'invalid_request');assert.equal(malformed.requestId,'');doc.destroy();
});

test('Viewing checks every UI project mutation at commit while trusted hosts remain independent',async()=>{
 const {uiCommandGuard}=await import('../web/ui-mutations.js'),{doc,host:trusted}=setup();let mode='editing';
 const ui=projectCommands({doc,projectId:'project',beforeMutation:uiCommandGuard(()=>mode)}),before=bytes(doc);
 const delayed=request(ui,{op:'project.configure',name:'Delayed'});mode='viewing';
 assert.equal(ui.execute(delayed).error.code,'viewing_mode');
 const commands=[{op:'node.relocate',id:'chapter',path:'moved.tex',selectedReferences:[]},{op:'node.delete',id:'main'},
  {op:'node.duplicate',id:'main',path:'copy.tex'},{op:'files.add',entries:[{kind:'text',path:'upload.tex',content:'NO'}]},
  {op:'files.add',entries:[{kind:'folder',path:'folder'}]},{op:'trash.restore'},{op:'environment.set',environment:null},
  {op:'asset.replace',id:'asset',blob:{hash:blob_hash(new Uint8Array([1])),size:1}},{op:'project.configure',mainFile:'chapter'},{op:'text.patch',edits:[{fileId:'main',start:3,end:8,before:'alpha',after:'NO'}]}];
 for(const command of commands){const receipt=ui.execute(request(ui,command));assert.equal(receipt.error?.code,'viewing_mode',JSON.stringify(receipt));assert.deepEqual(bytes(doc),before);}
 for(const command of [{op:'project.inspect'},{op:'file.read',id:'main'},{op:'project.export'},{op:'node.planRelocation',id:'chapter',path:'moved.tex'}])assert.equal(ui.execute(request(ui,command)).ok,true);
 trusted.run({op:'text.patch',edits:[{fileId:'main',start:3,end:8,before:'alpha',after:'trusted'}]});assert.match(doc.getText('text:main').toString(),/trusted/);
 ui.close();trusted.close();doc.destroy();
});
