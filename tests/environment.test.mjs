import 'fake-indexeddb/auto';
import './helpers/core.mjs';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {gunzipSync} from 'node:zlib';
import * as Y from 'yjs';
import {TexCatalog} from '../web/pkg/scribyra_app.js';
import {cacheArchive,cacheArchives,cachedArchive,cachedPackages,removeCachedArchive,clearPackageCache,downloadArchive,CACHE_LIMIT} from '../web/tex-packages.js';
import {projectCommands} from '../web/commands.js';
import {saveProject,loadProject,deleteProject} from '../web/storage.js';
const json=gunzipSync(readFileSync(new URL('../web/tex-catalog.json.gz',import.meta.url))).toString();
const bytes=new Uint8Array(readFileSync(new URL('./fixtures/tex-packages/babel-romanian.tar.xz',import.meta.url)));
const runtime={engine:'lualatex',distributionSha256:'a'.repeat(64),adapterSha256:'b'.repeat(64),catalogSha256:'c'.repeat(64),snapshot:JSON.parse(json).snapshot},info={name:'babel-romanian',...JSON.parse(json).packages['babel-romanian']};
function setup(){const catalog=new TexCatalog(json),lock=JSON.parse(catalog.environment(JSON.stringify(runtime),JSON.stringify([info.name])));return{catalog,lock};}
test('WASM locks/bundles preserve exact archive bytes and reject incompatible, corrupt and trailing input',()=>{
 const{catalog,lock}=setup();try{
  assert.deepEqual(JSON.parse(catalog.check_environment(JSON.stringify(lock),JSON.stringify(runtime))),lock);
  const bundle=catalog.encode_environment(JSON.stringify(lock),JSON.stringify(runtime),[bytes]);const[manifest,...archives]=catalog.decode_environment(bundle,JSON.stringify(runtime));assert.deepEqual(JSON.parse(manifest),lock);assert.deepEqual(archives,[bytes]);
  const changed=structuredClone(lock);changed.runtime.adapterSha256='f'.repeat(64);assert.throws(()=>catalog.check_environment(JSON.stringify(changed),JSON.stringify(runtime)),/different compiler/);
  changed.runtime=runtime;changed.packages[info.name].sha512='a'.repeat(128);assert.throws(()=>catalog.check_environment(JSON.stringify(changed),JSON.stringify(runtime)),/differs/);
  assert.throws(()=>catalog.encode_environment(JSON.stringify(lock),JSON.stringify(runtime),[]),/count/);assert.throws(()=>catalog.encode_environment(JSON.stringify(lock),JSON.stringify(runtime),[100000000]),/byte arrays/);
  const bad=bundle.slice();bad[bad.length-1]^=1;assert.throws(()=>catalog.decode_environment(bad,JSON.stringify(runtime)),/checksum/);
  const extra=new Uint8Array(bundle.length+1);extra.set(bundle);assert.throws(()=>catalog.decode_environment(extra,JSON.stringify(runtime)),/trailing/);
  assert.throws(()=>catalog.decode_environment(bundle.slice(0,-1),JSON.stringify(runtime)),/Truncated/);
 }finally{catalog.free();}
});
test('environment commands share write grants, revision guards, journals and project inspection',async()=>{
 const{catalog,lock}=setup(),doc=new Y.Doc(),id=crypto.randomUUID();catalog.free();doc.getMap('meta').set('name','Locked project');
 const writer=projectCommands({doc,projectId:id}),reader=projectCommands({doc,projectId:id,capabilities:['read']});
 assert.throws(()=>reader.run({op:'environment.set',environment:lock}),error=>error.code==='permission_denied');
 const stale=writer.revision();doc.getMap('meta').set('name','Changed');assert.throws(()=>writer.run({op:'environment.set',environment:lock},stale),/changed|revision/i);
 assert.throws(()=>writer.run({op:'environment.set'}),error=>error.code==='invalid_request');assert.throws(()=>writer.run({op:'environment.set',environment:false}),error=>error.code==='invalid_request');
 writer.run({op:'environment.set',environment:lock});assert.deepEqual(writer.run({op:'project.inspect'}).metadata.texEnvironment,lock);
 await saveProject(id,doc);const reopened=await loadProject(id);assert.deepEqual(reopened.getMap('meta').get('texEnvironment'),lock);reopened.destroy();
 const invalid=structuredClone(lock);invalid.version=2;assert.throws(()=>writer.run({op:'environment.set',environment:invalid}),/version/);assert.deepEqual(doc.getMap('meta').get('texEnvironment'),lock);
 writer.run({op:'environment.set',environment:null});assert.equal(writer.run({op:'project.inspect'}).metadata.texEnvironment,null);writer.close();reader.close();doc.destroy();await deleteProject(id);
});
test('cache bundle writes roll back every entry and prior eviction on quota failure',async()=>{
 await clearPackageCache();const block=new Uint8Array(32*1024*1024);for(let i=0;i<4;i++){block.fill(i);assert.equal(await cacheArchive('preserved-'+i,block),true);}const before=await cachedPackages();assert.equal(before.reduce((total,item)=>total+item.size,0),CACHE_LIMIT);
 const original=IDBObjectStore.prototype.put;let calls=0;IDBObjectStore.prototype.put=function(...args){if(++calls===2)throw new DOMException('Disk full','QuotaExceededError');return original.apply(this,args);};
 try{assert.equal(await cacheArchives([{hash:'new-a',bytes},{hash:'new-b',bytes}]),false);}finally{IDBObjectStore.prototype.put=original;}
 assert.equal(calls,2);assert.deepEqual(await cachedPackages(),before);assert.equal(await cachedArchive('new-a'),undefined);const preserved=await cachedArchive('preserved-0');assert.equal(preserved.length,block.length);assert.equal(preserved[0],0);
 await removeCachedArchive('preserved-0');assert.equal((await cachedPackages()).length,3);await clearPackageCache();assert.deepEqual(await cachedPackages(),[]);
});
test('download progress counts archive bytes while preserving checksum validation at the decoder',async()=>{
 const original=fetch,progress=[];
 try{globalThis.fetch=async()=>new Response(new ReadableStream({start(controller){controller.enqueue(bytes.slice(0,500));controller.enqueue(bytes.slice(500));controller.close();}}));assert.deepEqual(await downloadArchive(info,new AbortController().signal,(loaded,total)=>progress.push([loaded,total])),bytes);assert.deepEqual(progress,[[500,info.size],[bytes.length,info.size]]);}finally{globalThis.fetch=original;}
});
test('schema-4 upgrade preserves lock/source bytes and refuses stale or future-version writers',async()=>{
 const{catalog,lock}=setup();catalog.free();const doc=new Y.Doc(),id=crypto.randomUUID(),host=projectCommands({doc,projectId:id});host.run({op:'project.configure',name:'Migration',engine:'lualatex'});const [file]=host.run({op:'files.add',entries:[{kind:'text',path:'main.tex',content:'Café 日本語 🌍'}]}).ids;
 doc.getMap('meta').set('texEnvironment',lock);doc.getMap('meta').set('schemaVersion',4);await saveProject(id,doc);
 const upgraded=await loadProject(id);assert.equal(upgraded.getMap('meta').get('schemaVersion'),8);assert.deepEqual(upgraded.getMap('meta').get('texEnvironment'),lock);assert.equal(upgraded.getText(`text:${file}`).toString(),'Café 日本語 🌍');
 const{migrationBackup}=await import('../web/storage.js');const original=new Y.Doc();Y.applyUpdate(original,await migrationBackup(id));assert.equal(original.getMap('meta').get('schemaVersion'),4);assert.deepEqual(original.getMap('meta').get('texEnvironment'),lock);assert.equal(original.getText(`text:${file}`).toString(),'Café 日本語 🌍');
 await assert.rejects(saveProject(id,doc),/upgraded/);const current=projectCommands({doc:upgraded,projectId:id});upgraded.getMap('meta').set('schemaVersion',9);assert.throws(()=>current.run({op:'environment.set',environment:null}),error=>error.code==='unsupported_project_version');assert.deepEqual(upgraded.getMap('meta').get('texEnvironment'),lock);
 host.close();current.close();original.destroy();doc.destroy();upgraded.destroy();await deleteProject(id);
});
