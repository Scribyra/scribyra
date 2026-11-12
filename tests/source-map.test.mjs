import './helpers/core.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { source_map_query } from '../web/pkg/scribyra_app.js';
import { sourceNavigation,sourceMapState } from '../web/source-map.js';
const bytes=readFileSync(new URL('./fixtures/synctex/article-pdflatex.synctex',import.meta.url));
const manifest={files:[{id:'main',path:'main.tex',lineCount:20}],mainFile:'main.tex',root:'/home/web_user/project_dir',pages:1};
const query=(bytes,manifest,query)=>JSON.parse(source_map_query(bytes,JSON.stringify(manifest),JSON.stringify(query)));
test('WASM queries compressed engine metadata and rejects corrupt gzip and uncompiled aliases',()=>{
  const hits=query(gzipSync(bytes),manifest,{op:'forward',id:'main',line:6});assert.equal(hits[0].page,1);assert.ok(Math.abs(hits[0].bottom-298.04684)<.01);
  assert.equal(query(bytes,manifest,{op:'inverse',page:1,x:200,y:294,height:792})[0].fileId,'main');
  const corrupt=Buffer.from(gzipSync(bytes));corrupt[corrupt.length-8]^=1;assert.throws(()=>query(corrupt,manifest,{op:'inspect'}),/Invalid compressed/);
  const aliases={...manifest,files:[...manifest.files,{id:'other',path:'other/main.tex',lineCount:20}]};assert.throws(()=>query(bytes,aliases,{op:'forward',id:'other',line:6}),/no SyncTeX input/);
});
test('source navigation cancels pending queries and invalidates a PDF jump already awaiting layout',async()=>{
  const original=globalThis.Worker,workers=[];
  class Worker {constructor(){workers.push(this);}postMessage(message){this.message=message;}terminate(){this.terminated=true;}reply(result){this.onmessage({data:{id:this.message.id,result}});}}
  globalThis.Worker=Worker;
  try{
    const state=sourceMapState(),doc={},notices=[];let revision=1,resolveLayout,drawn=0,activated=0;
    const controller=sourceNavigation({state,getDoc:()=>doc,getRevision:()=>revision,emit(){},notify:message=>notices.push(message),activate(){activated++;},clearMarker(){},showRectangle:async(hit,isCurrent)=>{await new Promise(resolve=>{resolveLayout=resolve;});if(isCurrent())drawn++;}});
    async function install(){const pending=controller.install(bytes,manifest,revision);workers.at(-1).reply({});await pending;assert.equal(state.sourceMapReady,true);}
    await install();const pending=controller.forward('main',6);workers.at(-1).reply([{page:1}]);await Promise.resolve();revision++;controller.changed();resolveLayout();await pending;assert.equal(drawn,0);assert.equal(state.sourceMapReady,false);assert.equal(state.sourceMapBusy,false);
    await install();const inverse=controller.inverse({page:1,x:200,y:294,height:792}),worker=workers.at(-1);controller.clear();assert.equal(worker.terminated,true);worker.reply([{fileId:'main',line:6}]);await inverse;assert.equal(activated,0);assert.equal(state.sourceMapReady,false);assert.deepEqual(notices,[]);
    const count=workers.length;await controller.install(bytes,manifest,revision-1);assert.equal(workers.length,count);assert.equal(state.sourceMapReady,false);
  }finally{globalThis.Worker=original;}
});
