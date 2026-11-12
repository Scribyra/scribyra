import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {gunzipSync} from 'node:zlib';
const sha256=bytes=>createHash('sha256').update(bytes).digest('hex');
// The native generator verifies the source collection and all derived components.
export const runtimeInputs=['web/tex-catalog.json.gz','public/core/busytex/busytex_worker.js','public/core/busytex/busytex_pipeline.js','public/core/busytex/busytex_biber.js','public/core/busytex/busytex.js','public/core/busytex/busytex.wasm','public/core/busytex/biber.js','public/core/busytex/biber.wasm','public/core/busytex/biber.data','public/core/busytex/lualatex-manifest.json','web/compiler.js','web/build-errors.js','crates/core/src/packages.rs','crates/core/src/dependencies.rs','crates/core/src/compatibility.rs','crates/core/src/environment.rs','crates/core/src/diagnostics.rs','web/latex.js','web/tex-metadata.js','web/tex-packages-worker.js','web/tex-packages.js','web/tex-cache.js','web/runtime-assets.js','web/runtime-observation.js','web/observability.js','web/worker-observation.js','web/telemetry.js','web/sw-template.js','web/download-state.js','web/cache-policy.json','node_modules/texlyre-busytex/dist/index.js'];
export function texRuntimeAssets(root='.'){
 const manifest=JSON.parse(readFileSync(join(root,'public/core/busytex/lualatex-manifest.json')));
 const asset=path=>{const bytes=readFileSync(join(root,'public/core/busytex',path));return{path,size:bytes.length,sha256:sha256(bytes)};};
 return{compatibility:manifest.compatibility,core:[...['busytex_worker.js','busytex_pipeline.js','busytex_biber.js','busytex.js','busytex.wasm'].map(asset),manifest.loader,manifest.data],biber:['biber.js','biber.wasm','biber.data'].map(asset),loader:manifest.loader,components:manifest.components,provenance:manifest.files,metadata:manifest.metadata};
}
export function texRuntimeIdentity(root='.'){
 const catalog=readFileSync(join(root,'web/tex-catalog.json.gz')),adapter=createHash('sha256');
 for(const path of runtimeInputs.slice(1))adapter.update(path+'\0').update(readFileSync(join(root,path)));
 const manifest=JSON.parse(readFileSync(join(root,'public/core/busytex/lualatex-manifest.json')));
 return{engine:'lualatex',distributionSha256:manifest.sourceArchiveSha256,adapterSha256:adapter.digest('hex'),catalogSha256:manifest.metadata.sha256,snapshot:manifest.snapshot||JSON.parse(gunzipSync(catalog)).snapshot};
}

export function texMetadataShards(root='.'){
 const info=texRuntimeAssets(root).metadata;
 const manifest=JSON.parse(readFileSync(join(root,'public/core/busytex',info.path)));
 return [...new Map([...Object.values(manifest.filenames),...Object.values(manifest.packages),...(manifest.dependencyGraph?[manifest.dependencyGraph]:[])].map(asset=>[asset.path,asset])).values()];
}
