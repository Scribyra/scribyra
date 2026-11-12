import {createRequire} from 'node:module';import {readdirSync,readFileSync,writeFileSync,statSync,copyFileSync} from 'node:fs';import {join,relative} from 'node:path';
const R='<repo>';const require=createRequire(R+'/package.json');const esbuild=require('esbuild');
const here=new URL('.',import.meta.url).pathname;
await esbuild.build({entryPoints:[here+'harness-entry.js'],bundle:true,format:'esm',outfile:here+'www/harness.js',nodePaths:[R+'/node_modules'],logLevel:'error',external:[],loader:{'.wasm':'file'},define:{'import.meta.url':'"http://127.0.0.1:5191/x.js"'}});
copyFileSync(R+'/web/pkg/scribyra_app_bg.wasm',here+'www/scribyra_app_bg.wasm');
writeFileSync(here+'www/index.html','<!doctype html><meta charset=utf-8><title>collab harness</title><script type=module src=/harness.js></script>');
const walk=(d,o=[])=>{for(const e of readdirSync(d)){const p=join(d,e);if(statSync(p).isDirectory())walk(p,o);else o.push(p);}return o;};
const files=walk(R+'/fixtures/thesis').map(p=>({path:relative(R+'/fixtures/thesis',p),content:readFileSync(p,'utf8')}));
writeFileSync(here+'www/thesis.json',JSON.stringify(files));console.log('files',files.length,'bytes',files.reduce((s,f)=>s+f.content.length,0));
