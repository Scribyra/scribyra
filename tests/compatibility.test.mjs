import './helpers/core.mjs';
import 'fake-indexeddb/auto';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {TexCatalog,compilation_diagnostics} from '../web/pkg/scribyra_app.js';
import {openMetadata} from '../web/tex-metadata.js';
const profile=JSON.parse(readFileSync(new URL('../scripts/tex-compiler.json',import.meta.url)));
const runtime={engine:'lualatex',snapshot:'compatibility-fixture',distributionSha256:profile.sourceArchiveSha256,adapterSha256:'a'.repeat(64),catalogSha256:'b'.repeat(64)};
test('WASM compiler profiles reject a changed binary, engine, capabilities and distribution',()=>{
 const validate=(p=profile,r=runtime,b=profile.binary)=>TexCatalog.validate_compatibility(JSON.stringify(p),JSON.stringify(r),JSON.stringify(b));
 assert.doesNotThrow(()=>validate());
 assert.throws(()=>validate(profile,runtime,{...profile.binary,sha256:'c'.repeat(64)}),/different runtime/);
 assert.throws(()=>validate(profile,{...runtime,distributionSha256:'d'.repeat(64)}),/different runtime/);
 for(const change of [{engine:'xelatex'},{formatRebuilding:true},{shellEscape:true},{format:{...profile.format,path:'../../another.fmt'}}])assert.throws(()=>validate({...profile,...change}),/compatibility/);
});
test('a hash-pinned metadata root is rejected before merging packages when its compiler profile differs',async()=>{
 const root={version:1,snapshot:runtime.snapshot,sourceArchiveSha256:runtime.distributionSha256,filenames:{},packages:{},fontFamilies:{},compatibility:profile};
 const bytes=new Uint8Array(Buffer.from(JSON.stringify(root))),sha256=createHash('sha256').update(bytes).digest('hex'),pin={path:`tex-catalog.${sha256}.json`,size:bytes.length,sha256};
 const options={Catalog:TexCatalog,root:pin,base:'/core',runtime:{...runtime,catalogSha256:sha256},binary:profile.binary,fetcher:async()=>new Response(bytes)};
 const api=await openMetadata(options);api.catalog.free();
 await assert.rejects(openMetadata({...options,binary:{...profile.binary,size:1}}),/different runtime/);
});
test('real expl3 version-probe failures suppress package downloads and explain the pinned-format boundary',()=>{
 for(const log of ['! LaTeX Error: Mismatched LaTeX support files detected.','! LaTeX Error: Cannot run piped system commands.\nl.78 \\ExplLoaderFileDate{expl3.sty}}']){
  const report=JSON.parse(compilation_diagnostics(JSON.stringify({log})));assert.equal(report.issues[0].code,'format-mismatch');assert.equal(report.allowPackageResolution,false);
  assert.deepEqual(JSON.parse(TexCatalog.lookup_plan('[{"name":"optional.sty","format":26}]',log)),{files:[],fonts:[]});
 }
 const unrelated=JSON.parse(compilation_diagnostics(JSON.stringify({log:'! LaTeX Error: Cannot run piped system commands.\nl.1 \\input{|some-tool}'})));assert.notEqual(unrelated.issues[0].code,'format-mismatch');
});
