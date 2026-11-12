import {createRequire} from 'node:module';import {readdirSync,readFileSync,statSync,writeFileSync} from 'node:fs';import {join,relative} from 'node:path';
const {zipSync}=createRequire('<repo>/')('fflate');
for(const name of ['missing-package','article','thesis']){const root='<repo>/fixtures/'+name,files={};const walk=d=>{for(const e of readdirSync(d)){const p=join(d,e);if(statSync(p).isDirectory())walk(p);else files[relative(root,p)]=new Uint8Array(readFileSync(p));}};walk(root);writeFileSync('out/'+name+'.zip',zipSync(files));}
