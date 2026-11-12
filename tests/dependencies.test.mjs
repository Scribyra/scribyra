import 'fake-indexeddb/auto';
import './helpers/core.mjs';
import {test,beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {gunzipSync} from 'node:zlib';
import {createHash} from 'node:crypto';
import {TexCatalog,validate_dependency_manifest,dependency_closure} from '../web/pkg/scribyra_app.js';
import {openMetadata} from '../web/tex-metadata.js';
import {clearPackageCache} from '../web/tex-cache.js';
beforeEach(()=>clearPackageCache());
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const source=JSON.parse(gunzipSync(readFileSync(new URL('../web/tex-catalog.json.gz',import.meta.url))));
const archive=new Uint8Array(readFileSync(new URL('./fixtures/tex-packages/babel-romanian.tar.xz',import.meta.url)));
const node=(dependencies=[],requires=[])=>({revision:1,category:'Package',dependencies,requires,hasBinaries:false});
function graph(){return {version:1,snapshot:source.snapshot,source:{repository:'git://example.test/texlive',commit:'a'.repeat(40),blob:'b'.repeat(40),rawSha256:'c'.repeat(64),matchedRuntimePackages:1},packages:{'babel-romanian':node(),language:node(['babel-romanian','engine.ARCH']),prerequisite:node(['language'])},overrides:{language:{...node(['babel-romanian'],['prerequisite']),archiveSha512:'d'.repeat(128)}}};}
test('WASM dependency closures use curated overrides and prerequisites without installing native templates',()=>{
 const data=graph();validate_dependency_manifest(JSON.stringify(data),source.snapshot);
 const result=JSON.parse(dependency_closure(JSON.stringify(data),source.snapshot,'["language"]'));
 assert.deepEqual(Object.keys(result.packages),['babel-romanian','language','prerequisite']);
 assert.deepEqual(result.architectureRequirements,[]);assert.equal(result.packages.language.archiveSha512,'d'.repeat(128));
 delete data.overrides.language;
 assert.deepEqual(JSON.parse(dependency_closure(JSON.stringify(data),source.snapshot,'["language"]')).architectureRequirements,['engine.ARCH']);
 assert.throws(()=>dependency_closure(JSON.stringify(data),source.snapshot,'["missing"]'),/Unknown/);
 assert.throws(()=>validate_dependency_manifest(JSON.stringify(data),'different-snapshot'),/identity/);
 data.packages.language.dependencies=['../outside'];assert.throws(()=>validate_dependency_manifest(JSON.stringify(data),source.snapshot),/dependency/);
});
test('package receipts distinguish an explicitly empty upstream declaration from missing metadata',()=>{
 const pkg=structuredClone(source.packages['babel-romanian']);
 const receipt=packageValue=>{const catalog=new TexCatalog(JSON.stringify({snapshot:source.snapshot,packages:{'babel-romanian':packageValue}}));try{return JSON.parse(catalog.package_info('["babel-romanian"]'))[0];}finally{catalog.free();}};
 assert.equal(receipt(pkg).dependencyProvenance,undefined);
 pkg.dependencies=[];pkg.dependencyProvenance={kind:'catalogue',package:'babel-romanian',revision:pkg.revision,sha256:'c'.repeat(64)};
 assert.deepEqual(receipt(pkg).dependencies,[]);assert.deepEqual(receipt(pkg).dependencyProvenance,pkg.dependencyProvenance);
 pkg.dependencyProvenance={kind:'archive',package:'babel-romanian',revision:pkg.revision,sha512:'d'.repeat(128)};
 assert.throws(()=>receipt(pkg),/provenance/);
});
function fixture(data=graph()){
 const files=new Map(),requested=[];
 const emit=(value,root=false)=>{const bytes=new Uint8Array(Buffer.from(JSON.stringify(value))),sha256=sha(bytes),path=root?`tex-catalog.${sha256}.json`:`metadata/${sha256}.json`;files.set(`/core/${path}`,bytes);return{path,size:bytes.length,sha256};};
 const dependencyGraph=emit(data),part=emit({snapshot:source.snapshot,packages:{'babel-romanian':source.packages['babel-romanian']}});
 const root=emit({version:1,snapshot:source.snapshot,sourceArchiveSha256:'a'.repeat(64),fontFamilies:{},filenames:{},packages:{[TexCatalog.metadata_bucket('babel-romanian')]:part},dependencyGraph},true);
 const runtime={engine:'lualatex',snapshot:source.snapshot,distributionSha256:'a'.repeat(64),adapterSha256:'b'.repeat(64),catalogSha256:root.sha256};
 return{root,runtime,dependencyGraph,requested,open:()=>openMetadata({Catalog:TexCatalog,root,base:'/core',runtime,fetcher:async url=>{requested.push(url);const bytes=files.get(url);return new Response(bytes||'',{status:bytes?200:404});}})};
}
test('dependency manifest is lazy, verified, required for offline readiness and carried by portable bundles',async()=>{
 const f=fixture(),api=await f.open();try{
  assert.equal(f.requested.length,1);await api.ensure(['babel-romanian']);assert.equal(f.requested.length,2);
  assert.deepEqual(await api.metadataStatus(['babel-romanian']),{ready:false,missing:[f.dependencyGraph.path]});
  const bytes=await api.dependencyGraph();assert.equal(sha(bytes),f.dependencyGraph.sha256);validate_dependency_manifest(new TextDecoder().decode(bytes),source.snapshot);
  assert.equal((await api.metadataStatus(['babel-romanian'])).ready,true);
  const metadata=await api.metadataAssets(['babel-romanian']),lock=api.catalog.environment(JSON.stringify(f.runtime),'["babel-romanian"]');
  assert.equal(metadata.length,3);
  const bundle=api.catalog.encode_portable_environment(lock,JSON.stringify(f.runtime),[archive],metadata.map(info=>[info.path,info.bytes]));
  const[header,...buffers]=TexCatalog.decode_portable_environment(bundle,JSON.stringify(f.runtime)),decoded=JSON.parse(header);
  assert.equal(decoded.metadata.length,3);assert.equal(sha(buffers[decoded.metadata.findIndex(info=>info.path===f.dependencyGraph.path)]),f.dependencyGraph.sha256);
  assert.throws(()=>api.catalog.encode_portable_environment(lock,JSON.stringify(f.runtime),[archive],metadata.filter(info=>info.path!==f.dependencyGraph.path).map(info=>[info.path,info.bytes])),/omits its dependency/);
 }finally{api.catalog.free();}
});
test('portable validation rejects a hash-pinned dependency graph from another snapshot',async()=>{
 const f=fixture({...graph(),snapshot:'wrong-snapshot'}),api=await f.open();try{
  await api.ensure(['babel-romanian']);const metadata=await api.metadataAssets(['babel-romanian']),lock=api.catalog.environment(JSON.stringify(f.runtime),'["babel-romanian"]');
  assert.throws(()=>api.catalog.encode_portable_environment(lock,JSON.stringify(f.runtime),[archive],metadata.map(info=>[info.path,info.bytes])),/identity/);
 }finally{api.catalog.free();}
});
