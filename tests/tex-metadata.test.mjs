import 'fake-indexeddb/auto';
import './helpers/core.mjs';
import {test,beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {gunzipSync} from 'node:zlib';
import {createHash} from 'node:crypto';
import {TexCatalog} from '../web/pkg/scribyra_app.js';
import {openMetadata} from '../web/tex-metadata.js';
import {clearPackageCache,cacheArchives,cacheMetadata} from '../web/tex-cache.js';
beforeEach(()=>clearPackageCache());
const source=JSON.parse(gunzipSync(readFileSync(new URL('../web/tex-catalog.json.gz',import.meta.url))));
const archive=new Uint8Array(readFileSync(new URL('./fixtures/tex-packages/babel-romanian.tar.xz',import.meta.url)));
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
function fixture(){
 const files=new Map(),counts=new Map();let corrupt=false;
 const emit=(value,root=false)=>{const bytes=Buffer.from(JSON.stringify(value)),sha256=sha(bytes),path=root?`tex-catalog.${sha256}.json`:`metadata/${sha256}.json`;files.set('/core/busytex/'+path,bytes);return{path,size:bytes.length,sha256};};
 const filenames={[TexCatalog.metadata_bucket('romanian.ldf')]:emit({'romanian.ldf':['babel-romanian']})};
 const packages={[TexCatalog.metadata_bucket('babel-romanian')]:emit({snapshot:source.snapshot,packages:{'babel-romanian':source.packages['babel-romanian']}})};
 const root=emit({version:1,snapshot:source.snapshot,sourceArchiveSha256:'a'.repeat(64),fontFamilies:{},filenames,packages},true);
 const runtime={engine:'lualatex',snapshot:source.snapshot,distributionSha256:'a'.repeat(64),adapterSha256:'b'.repeat(64),catalogSha256:root.sha256};
 const fetcher=async(url,options)=>{assert.equal(options.credentials,'same-origin');counts.set(url,(counts.get(url)||0)+1);const original=files.get(url);if(!original)return new Response('',{status:404});const bytes=new Uint8Array(original);if(corrupt&&url.includes('/metadata/'))bytes[2]^=1;return new Response(bytes);};
 return{files,counts,runtime,root,packages,filenames,fetcher,set corrupt(value){corrupt=value;},open:()=>openMetadata({Catalog:TexCatalog,root,base:'/core/busytex',runtime,fetcher})};
}
test('startup loads only the root and source errors trigger no optional metadata requests',async()=>{
 const f=fixture(),api=await f.open();try{
  assert.equal(f.counts.size,1);assert.deepEqual(JSON.parse(api.catalog.package_info('[]')),[]);
  assert.deepEqual(await api.resolve([{name:'romanian.ldf',format:26}],'! Undefined control sequence.'),[]);assert.equal(f.counts.size,1);
  assert.deepEqual(await api.resolve([], 'The font \"Constructor\" cannot be found'),[]);
  assert.deepEqual(await api.resolve([{name:'constructor',format:26}], ''),[]);
 }finally{api.catalog.free();}
});
test('concurrent lookups fetch each shard once and use the actual WASM archive validator',async()=>{
 const f=fixture(),api=await f.open();try{
  const results=await Promise.all([api.resolve([],"! LaTeX Error: File `romanian.ldf' not found."),api.resolve([],"! LaTeX Error: File `romanian.ldf' not found.")]);
  assert.deepEqual(results[0].map(p=>p.name),['babel-romanian']);assert.deepEqual(results[0],results[1]);assert(results[0].every(p=>!('files'in p)));
  assert.equal(f.counts.size,3);assert([...f.counts.values()].every(count=>count===1));
  assert.equal(api.catalog.unpack('babel-romanian',archive)[0][0],'tex/generic/babel-romanian/romanian.ldf');
  const lock=JSON.parse(api.catalog.environment(JSON.stringify(f.runtime),'["babel-romanian"]'));
  assert.deepEqual(await api.lockedNames(lock),['babel-romanian']);assert.deepEqual(await api.metadataStatus(['babel-romanian']),{ready:true,missing:[]});
 }finally{api.catalog.free();}
});
test('overlapping metadata requests share a four-download worker budget',async()=>{
 const f=fixture(),body=JSON.parse(f.files.get('/core/busytex/'+f.root.path));body.packages={};body.filenames={};const names=[],buckets=new Set();
 for(let i=0;names.length<16;i++){const name='test-'+i,bucket=TexCatalog.metadata_bucket(name);if(buckets.has(bucket))continue;buckets.add(bucket);names.push(name);const bytes=Buffer.from(JSON.stringify({snapshot:body.snapshot,packages:{[name]:{revision:1,size:1,sha512:'0'.repeat(128),files:[`tex/latex/test/${name}.sty`]}}})),sha256=sha(bytes),path=`metadata/${sha256}.json`;body.packages[bucket]={path,size:bytes.length,sha256};f.files.set('/core/busytex/'+path,bytes);}
 const bytes=Buffer.from(JSON.stringify(body)),sha256=sha(bytes),root={path:`tex-catalog.${sha256}.json`,size:bytes.length,sha256};f.files.set('/core/busytex/'+root.path,bytes);let running=0,maximum=0;
 const api=await openMetadata({Catalog:TexCatalog,root,base:'/core/busytex',runtime:{...f.runtime,catalogSha256:sha256},fetcher:async url=>{if(url.includes('/metadata/')){running++;maximum=Math.max(maximum,running);await new Promise(resolve=>setTimeout(resolve,10));running--;}return new Response(f.files.get(url));}});
 try{await Promise.all([api.ensure(names.slice(0,8)),api.ensure(names.slice(8))]);assert.equal(maximum,4);assert.equal(JSON.parse(api.catalog.package_info(JSON.stringify(names))).length,16);}finally{api.catalog.free();}
});
test('corrupt shards are rejected before merge and a later request retries cleanly',async()=>{
 const f=fixture(),api=await f.open();try{
  f.corrupt=true;await assert.rejects(api.resolve([],"! LaTeX Error: File `romanian.ldf' not found."),/checksum/);
  assert.throws(()=>api.catalog.package_info('["babel-romanian"]'),/Unknown package/);
  f.corrupt=false;assert.equal((await api.resolve([],"! LaTeX Error: File `romanian.ldf' not found."))[0].name,'babel-romanian');
 }finally{api.catalog.free();}
});
test('a corrupted persisted shard prevents offline readiness and recovers online',async()=>{
 const f=fixture(),first=await f.open();let info;
 try{info=(await first.metadataAssets(['babel-romanian']))[1];}finally{first.catalog.free();}
 const bytes=info.bytes.slice();bytes[10]^=1;assert.equal(await cacheMetadata(info,bytes),true);
 const offline=await openMetadata({Catalog:TexCatalog,root:f.root,base:'/core/busytex',runtime:f.runtime,fetcher:async()=>{throw new Error('Offline');}});
 try{assert.equal((await offline.metadataStatus(['babel-romanian'])).ready,false);await assert.rejects(offline.ensure(['babel-romanian']),/Offline/);}finally{offline.catalog.free();}
 const repaired=await f.open();try{await repaired.ensure(['babel-romanian']);assert.equal((await repaired.metadataStatus(['babel-romanian'])).ready,true);assert.equal(repaired.catalog.unpack('babel-romanian',archive).length,1);}finally{repaired.catalog.free();}
});
test('portable bundles restore archives and pinned metadata without any network or ambient catalog',async()=>{
 const f=fixture(),api=await f.open();let bundle,lock;
 try{await api.ensure(['babel-romanian']);lock=JSON.parse(api.catalog.environment(JSON.stringify(f.runtime),'["babel-romanian"]'));const metadata=await api.metadataAssets(['babel-romanian']);bundle=api.catalog.encode_portable_environment(JSON.stringify(lock),JSON.stringify(f.runtime),[archive],metadata.map(info=>[info.path,info.bytes]));}finally{api.catalog.free();}
 await clearPackageCache();
 const[header,...buffers]=TexCatalog.decode_portable_environment(bundle,JSON.stringify(f.runtime));const decoded=JSON.parse(header);
 assert.deepEqual(decoded.lock,lock);assert.deepEqual(buffers.slice(decoded.metadata.length),[archive]);
 const metadata=decoded.metadata.map((info,i)=>({...info,bytes:buffers[i]}));assert.equal(await cacheArchives([{hash:lock.packages['babel-romanian'].sha512,bytes:archive}],metadata),true);
 const offline=await openMetadata({Catalog:TexCatalog,root:f.root,base:'/core/busytex',runtime:f.runtime,fetcher:async()=>{throw new Error('No network permitted');}});
 try{assert.deepEqual(await offline.lockedNames(lock),['babel-romanian']);assert.equal((await offline.metadataStatus(['babel-romanian'])).ready,true);assert.deepEqual(JSON.parse(offline.catalog.check_environment(JSON.stringify(lock),JSON.stringify(f.runtime))),lock);}finally{offline.catalog.free();}
 const bad=bundle.slice();bad[bad.length-1]^=1;assert.throws(()=>TexCatalog.decode_portable_environment(bad,JSON.stringify(f.runtime)),/checksum/);
 const foreign={...f.runtime,adapterSha256:'f'.repeat(64)};assert.throws(()=>TexCatalog.decode_portable_environment(bundle,JSON.stringify(foreign)),/different compiler/);
 assert.throws(()=>TexCatalog.decode_portable_environment(bundle.slice(0,20),JSON.stringify(f.runtime)),/Truncated/);
});
test('root paths, response bounds and metadata versions fail before package installation',async()=>{
 const f=fixture();await assert.rejects(openMetadata({Catalog:TexCatalog,root:{...f.root,path:'../../private'},base:'/core/busytex',runtime:f.runtime,fetcher:f.fetcher}),/root path/);
 await assert.rejects(openMetadata({Catalog:TexCatalog,root:f.root,base:'/core/busytex',runtime:f.runtime,fetcher:async()=>new Response(new Uint8Array(f.root.size+1))}),/manifest size|pinned size/);
 const body=JSON.parse(f.files.get('/core/busytex/'+f.root.path));body.version=99;const bytes=Buffer.from(JSON.stringify(body));
 await assert.rejects(openMetadata({Catalog:TexCatalog,root:{path:`tex-catalog.${sha(bytes)}.json`,size:bytes.length,sha256:sha(bytes)},base:'/core/busytex',runtime:{...f.runtime,catalogSha256:sha(bytes)},fetcher:async()=>new Response(bytes)}),/incompatible/);
});
