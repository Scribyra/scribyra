import './helpers/core.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readBrowserFiles,readDirectory,readDroppedFiles } from '../web/import-files.js';
const file=(name,content='source')=>new File([content],name);
const handle=(name,children)=>({name,kind:'directory',async *values(){yield* children;}});
const leaf=f=>({name:f.name,kind:'file',getFile:async()=>f});
test('directory enumeration preserves empty folders, Unicode paths and exact binary bytes',async()=>{
  const binary=new Uint8Array([0,255,10]);
  const entries=await readDirectory(handle('paper',[handle('empty',[]),handle('été',[leaf(file('main.tex','Café')),leaf(file('image.png',binary))])]),'imports/');
  assert.deepEqual(entries.map(e=>e.path),['imports/paper','imports/paper/empty','imports/paper/été','imports/paper/été/main.tex','imports/paper/été/image.png']);
  assert.equal(entries[1].folder,true);assert.equal(entries[3].content,'Café');assert.deepEqual(entries[4].content,binary);
});
test('drop enumeration reads every directory batch, including nested empty directories',async()=>{
  const leaves=Array.from({length:101},(_,i)=>({name:`${i}.tex`,isFile:true,file:resolve=>resolve(file(`${i}.tex`))}));
  const batches=[leaves.slice(0,100),leaves.slice(100),[{name:'empty',isDirectory:true,createReader:()=>({readEntries:resolve=>resolve([])})}],[]];let read=0;
  const entry={name:'paper',isDirectory:true,createReader:()=>({readEntries:resolve=>resolve(batches[read++])})};
  const result=await readDroppedFiles({items:[{kind:'file',webkitGetAsEntry:()=>entry,getAsFile:()=>null}]});
  assert.equal(read,4);assert.equal(result.length,103);assert.equal(result.at(-1).path,'paper/empty');
});
test('imports reject traversal, excessive sizes/counts and invalid text before mutation',async()=>{
  await assert.rejects(readBrowserFiles([file('../escape.tex')]),/relative path/);
  let read=false;
  await assert.rejects(readBrowserFiles([{name:'large.png',size:64*1024*1024+1,arrayBuffer(){read=true;}}]),/64 MiB/);assert.equal(read,false);
  await assert.rejects(readBrowserFiles(Array.from({length:513},(_,i)=>file(`${i}.tex`))),/512 files/);
  await assert.rejects(readBrowserFiles([file('broken.tex',new Uint8Array([255]))]),/UTF-8/);
  const broken={name:'broken',kind:'directory',async *values(){throw new Error('Permission lost');}};
  await assert.rejects(readDirectory(broken),/Permission lost/);
});
test('directory input fallback retains relative paths and plain file drops remain supported',async()=>{
  const f=file('main.tex');Object.defineProperty(f,'webkitRelativePath',{value:'paper/chapters/main.tex'});
  assert.equal((await readBrowserFiles([f],'selected/',true))[0].path,'selected/paper/chapters/main.tex');
  assert.equal((await readDroppedFiles({files:[f]}))[0].path,'main.tex');
});

test('virtual file drops use readable File contents without reopening a filesystem path',async()=>{
  const f=file('virtual.tex','virtual source');
  const result=await readDroppedFiles({items:[{kind:'file',getAsFile:()=>f,webkitGetAsEntry:()=>({name:f.name,isFile:true,file:(_resolve,reject)=>reject(new Error('Path does not exist'))})}]});
  assert.equal(result[0].content,'virtual source');
});

test('native sync state is skipped without opening files or enumerating private subtrees',async()=>{
 const privateHandle={name:'.ScRiByRa-SyNc',kind:'directory',async *values(){throw new Error('Private recovery state must not be enumerated');}};
 const result=await readDirectory(handle('paper',[leaf(file('main.tex','source')),privateHandle]));assert.deepEqual(result.map(e=>e.path),['paper','paper/main.tex']);
 const secret=file('session.json');Object.defineProperty(secret,'webkitRelativePath',{value:'paper/.scribyra-sync/session.json'});secret.arrayBuffer=()=>{throw new Error('Private bytes must not be read');};
 assert.deepEqual(await readBrowserFiles([secret],'',true),[]);
 const entry={name:'.scribyra-sync',isDirectory:true,createReader(){throw new Error('Private drop must not be read');}};
 assert.deepEqual(await readDroppedFiles({items:[{kind:'file',getAsFile:()=>null,webkitGetAsEntry:()=>entry}]}),[]);
});
