import {telemetryDestination} from './web/telemetry-destination.js';
import {parseSessionRate,SESSION_RATES} from './web/telemetry-session.js';
import { defineConfig,loadEnv } from 'vite';
import { readFileSync,readdirSync,rmSync } from 'node:fs';
import {join} from 'node:path';
import { createHash } from 'node:crypto';
import {resolve} from 'node:path';
import {execFileSync} from 'node:child_process';
import {texRuntimeIdentity,texRuntimeAssets,texMetadataShards,runtimeInputs} from './scripts/tex-environment.mjs';
import {workerObservation,workerObserver} from './web/worker-observation.js';
const rootShell=process.env.SCRIBYRA_ROOT_SHELL==='1';
let appBase='/',texBase='/core/busytex',outputDirectory='dist',isBuild=false;
const identity={version:JSON.parse(readFileSync('package.json','utf8')).version,revision:null,dirty:false,compilerAdapterSha256:texRuntimeIdentity().adapterSha256};
try{identity.revision=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8',stdio:['ignore','pipe','ignore']}).trim();identity.dirty=execFileSync('git',['status','--porcelain'],{encoding:'utf8',stdio:['ignore','pipe','ignore']}).length>0;}catch{}
// The deployed release name (web-<pipeline IID>, or dev-<pipeline IID>-<short sha> for
// the staging site), so an open tab can tell a newer deployment from its own. Builds
// outside a pipeline carry none.
const releaseName=process.env.SCRIBYRA_RELEASE||(process.env.CI_PIPELINE_IID?`web-${process.env.CI_PIPELINE_IID}`:null);
if(releaseName!==null&&!/^web-[1-9]\d{0,11}$|^dev-[1-9]\d{0,11}-[a-f0-9]{7,40}$/.test(releaseName))throw new Error('SCRIBYRA_RELEASE must look like web-<number> or dev-<number>-<short sha>.');
// Staging builds never carry a telemetry collector address.
if(releaseName?.startsWith('dev-')&&Object.keys(process.env).some(name=>name.startsWith('VITE_TELEMETRY_')))throw new Error('Staging builds must not configure telemetry.');
export default defineConfig({
  define: {__SCRIBYRA_BUILD__:JSON.stringify(identity),__SCRIBYRA_RELEASE__:JSON.stringify(releaseName),__TEX_RUNTIME__: JSON.stringify(texRuntimeIdentity()),__TEX_ASSETS__:JSON.stringify(texRuntimeAssets())},
  server: { port: 5173, strictPort: true },
  preview: { port: 4173, strictPort: true },
  build: { target: 'es2022', chunkSizeWarningLimit: 1500, copyPublicDir: !rootShell },
  plugins: [{name:'tex-runtime-identity',configureServer(server){
    const inputs=new Set(runtimeInputs.map(path=>resolve(path)));server.watcher.add([...inputs]);
    // Recreate the identity as well as compiler code during development updates.
    server.watcher.on('change',file=>{if(inputs.has(file))void server.restart().catch(error=>server.config.logger.error(error.message));});
  }},{name:'telemetry-destination',config(_config,{mode}){
    const env=loadEnv(mode,process.cwd(),'VITE_'),endpoint=env.VITE_TELEMETRY_INGEST_URL;
    if(endpoint&&releaseName?.startsWith('dev-'))throw new Error('Staging builds must not configure telemetry.');
    if(endpoint)telemetryDestination(endpoint,true);
    // A session rate outside the closed list fails the build instead of shipping.
    if(Number.isNaN(parseSessionRate(env.VITE_TELEMETRY_SESSION_RATE)))throw new Error(`VITE_TELEMETRY_SESSION_RATE must be one of ${SESSION_RATES.join(', ')}.`);
  }},{ name: 'offline-shell',configResolved(config){isBuild=config.command==='build';appBase=config.base;if(!appBase.startsWith('/')||!appBase.endsWith('/')||appBase.includes('//')||new URL(appBase,'https://scribyra.invalid').pathname!==appBase)throw new Error('App base must be a canonical same-origin directory.');texBase=(config.env.VITE_TEX_ASSET_BASE||`${appBase}core/busytex`).replace(/\/$/,'');const url=new URL(texBase,'https://scribyra.invalid');if(!texBase||texBase.includes('//')||url.origin!=='https://scribyra.invalid'||url.pathname!==texBase||url.search||url.hash)throw new Error('VITE_TEX_ASSET_BASE must be a canonical same-origin path.');outputDirectory=config.build.outDir;},generateBundle:{order:'post',handler(_options, bundle) {
    // Vite removes CSS-only JavaScript chunks before this final precache list.
    const assets = Object.keys(bundle).filter(name => name.startsWith('assets/')).map(name => `${appBase}${name}`);
    const hash = createHash('sha256').update(assets.join('\n')).update(readFileSync('public/agent.md')).update(readFileSync('public/core/busytex/busytex_pipeline.js')).update(readFileSync('public/core/busytex/busytex_biber.js')).update(readFileSync('public/core/busytex/busytex.js')).digest('hex').slice(0, 12);
    const shared=workerObservation.toString()+'\n'+workerObserver.toString()+'\n'+readFileSync('web/download-state.js','utf8')+'\nconst downloads=globalThis.createScribyraDownloads('+readFileSync('web/cache-policy.json','utf8')+');\n';
    const source = shared+readFileSync('web/sw-template.js', 'utf8').replace('__BUILD_CACHE__', `scribyra-shell-${hash}`).replace('__PRECACHE__', JSON.stringify([appBase, `${appBase}index.html`, `${appBase}agent.md`, ...(rootShell?[`${appBase}domain-router.js`]:[]), ...assets])).replace('__APP_BASE__',JSON.stringify(appBase)).replace('__TEX_BASE__',JSON.stringify(texBase)).replace('__RUNTIME_ASSETS__',JSON.stringify([...texRuntimeAssets().core,...texRuntimeAssets().biber]));
    this.emitFile({ type: 'asset', fileName: 'sw.js', source });
  }},closeBundle(){
    if(!isBuild||rootShell)return;
    const directory=join(outputDirectory,'core/busytex'),manifest=JSON.parse(readFileSync('public/core/busytex/lualatex-manifest.json')),keep=new Set([manifest.data.path,manifest.loader.path,manifest.files.path,manifest.components.path,manifest.metadata.path]);
    for(const name of readdirSync(directory)){if(/^texlive-(?:basic|recommended|extra)\./.test(name)||(/^(?:texlive-lualatex|lualatex-files|lualatex-components|tex-catalog)\.[a-f0-9]{64}\./.test(name)&&!keep.has(name)))rmSync(join(directory,name));}
    const components=JSON.parse(readFileSync(join('public/core/busytex',manifest.components.path))),archives=new Set(Object.values(components.packages).map(p=>p.sha512+'.tar.xz'));
    const root=JSON.parse(readFileSync(join('public/core/busytex',manifest.metadata.path)));for(const asset of root.support?.assets||[])archives.add(asset.path.split('/').pop());
    for(const name of readdirSync(join(directory,'components'))){if(/^[a-f0-9]{128}(?:\.source)?\.tar\.xz$/.test(name)&&!archives.has(name))rmSync(join(directory,'components',name));}
    const metadata=new Set(texMetadataShards().map(asset=>asset.path.split('/').pop()));for(const name of readdirSync(join(directory,'metadata'))){if(/^[a-f0-9]{64}\.json$/.test(name)&&!metadata.has(name))rmSync(join(directory,'metadata',name));}
  } }],
});
