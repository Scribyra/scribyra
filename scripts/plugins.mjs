// Plugin packages and the official registry (docs/plugins.md#registry).
//
//   node scripts/plugins.mjs build              bundle plugins/<name>/ into plugins/dist/
//   node scripts/plugins.mjs sign --key <pem>   write plugins/dist/registry.json, signed
//   node scripts/plugins.mjs verify             signature, hashes and fresh builds match
//   node scripts/plugins.mjs pack <dir>         bundle a plugin you are writing into <dir>/dist/
//
// A plugin folder has manifest.json, src/main.js (bundled as a classic script with
// esbuild) and optionally assets/ (*.wasm become binary files, others text).
import {build as esbuild} from 'esbuild';
import {readFile,writeFile,readdir,mkdir,stat} from 'node:fs/promises';
import {createPrivateKey,createPublicKey,sign as signBytes} from 'node:crypto';
import {join,resolve,dirname,relative} from 'node:path';
import {fileURLToPath} from 'node:url';
import {readPackage,validateManifest,PACKAGE_FORMAT,PACKAGE_FORMAT_VERSION} from '../web/plugin-manifest.js';
import {canonicalJson,sha256Hex,verifyRegistry,verifyPackage,SIGNATURE_ALGORITHM,TRUSTED_REGISTRY_KEYS} from '../web/plugin-registry.js';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
export const PLUGINS_DIR=join(root,'plugins'),DIST=join(PLUGINS_DIR,'dist');
const exists=path=>stat(path).then(()=>true,()=>false);

/** The package bytes for a plugin folder: deterministic for the same sources. */
export async function buildPackage(dir,{developer=false}={}){
  const manifest=validateManifest(JSON.parse(await readFile(join(dir,'manifest.json'),'utf8')),{developer});
  const result=await esbuild({entryPoints:[join(dir,'src/main.js')],bundle:true,format:'iife',target:'es2022',platform:'browser',write:false,legalComments:'inline',absWorkingDir:root,charset:'utf8',logLevel:'silent'});
  const files={[manifest.main]:result.outputFiles[0].text},binary={};
  if(await exists(join(dir,'assets')))for(const name of (await readdir(join(dir,'assets'))).sort()){
    const bytes=await readFile(join(dir,'assets',name));
    if(name.endsWith('.wasm'))binary[name]=bytes.toString('base64');else files[name]=bytes.toString('utf8');
  }
  const source=JSON.parse(await readFile(join(dir,'manifest.json'),'utf8'));
  const text=JSON.stringify({format:PACKAGE_FORMAT,formatVersion:PACKAGE_FORMAT_VERSION,manifest:source,files,...(Object.keys(binary).length?{binary}:{})},null,1)+'\n';
  const bytes=new TextEncoder().encode(text);readPackage(bytes,{developer});
  return {manifest,bytes,name:`${manifest.id}-${manifest.version}.scribyra-plugin.json`};
}
export async function officialPlugins(){
  const names=[];for(const name of (await readdir(PLUGINS_DIR)).sort())if(name!=='dist'&&await exists(join(PLUGINS_DIR,name,'manifest.json')))names.push(name);
  return names.map(name=>join(PLUGINS_DIR,name));
}
async function buildAll(){
  await mkdir(DIST,{recursive:true});
  for(const dir of await officialPlugins()){const {bytes,name}=await buildPackage(dir);await writeFile(join(DIST,name),bytes);console.log('built',relative(root,join(DIST,name)),bytes.length,'bytes');}
}
/** Registry payload for every package in plugins/dist (older versions stay listed). */
async function registryPayload(keyId){
  const plugins=new Map();
  for(const name of (await readdir(DIST)).sort()){
    if(!name.endsWith('.scribyra-plugin.json'))continue;
    const bytes=new Uint8Array(await readFile(join(DIST,name))),{manifest}=readPackage(bytes);
    if(name!==`${manifest.id}-${manifest.version}.scribyra-plugin.json`)throw new Error(`${name} does not match its manifest.`);
    const entry=plugins.get(manifest.id)||{id:manifest.id,name:manifest.name,publisher:manifest.publisher,description:manifest.description,versions:[]};
    Object.assign(entry,{name:manifest.name,publisher:manifest.publisher,description:manifest.description});
    entry.versions.push({version:manifest.version,api:manifest.api,package:name,sha256:await sha256Hex(bytes),size:bytes.length,permissions:manifest.permissions});
    plugins.set(manifest.id,entry);
  }
  return {registryVersion:1,name:'Scribyra plugins',keyId,plugins:[...plugins.values()]};
}
async function signAll(keyPath){
  const privateKey=createPrivateKey(await readFile(keyPath)),jwk=createPublicKey(privateKey).export({format:'jwk'});
  const keyId=Object.entries(TRUSTED_REGISTRY_KEYS).find(([,key])=>key.x===jwk.x&&key.y===jwk.y)?.[0];
  if(!keyId)throw new Error('This key is not pinned in web/plugin-registry.js (TRUSTED_REGISTRY_KEYS).');
  const signed=await registryPayload(keyId);
  const value=signBytes('sha256',Buffer.from(canonicalJson(signed)),{key:privateKey,dsaEncoding:'ieee-p1363'}).toString('base64');
  await writeFile(join(DIST,'registry.json'),JSON.stringify({signed,signature:{alg:SIGNATURE_ALGORITHM,keyId,value}},null,1)+'\n');
  console.log('signed',relative(root,join(DIST,'registry.json')),'with',keyId);
}
/** Throws unless the committed registry verifies and matches fresh builds of the sources. */
export async function verifyAll(){
  const registry=await verifyRegistry(await readFile(join(DIST,'registry.json'),'utf8'));
  const fresh=new Map();for(const dir of await officialPlugins()){const built=await buildPackage(dir);fresh.set(built.name,built.bytes);}
  const listed=new Set();
  for(const plugin of registry.plugins)for(const entry of plugin.versions){
    listed.add(entry.package);
    const bytes=new Uint8Array(await readFile(join(DIST,entry.package)));
    await verifyPackage(bytes,{id:plugin.id,...entry});
    if(fresh.has(entry.package)&&Buffer.compare(Buffer.from(fresh.get(entry.package)),Buffer.from(bytes))!==0)throw new Error(`${entry.package} differs from a fresh build of its source. Run “node scripts/plugins.mjs build” and sign again.`);
  }
  for(const name of fresh.keys())if(!listed.has(name))throw new Error(`${name} is built from source but not in the signed registry. Sign the registry again.`);
  return registry;
}
async function pack(dir){
  const {bytes,name}=await buildPackage(resolve(dir),{developer:true});
  await mkdir(join(resolve(dir),'dist'),{recursive:true});await writeFile(join(resolve(dir),'dist',name),bytes);
  console.log('packed',join(dir,'dist',name),'sha256',await sha256Hex(bytes));
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const [command,...args]=process.argv.slice(2);
  try{
    if(command==='build')await buildAll();
    else if(command==='sign'){const at=args.indexOf('--key');if(at<0||!args[at+1])throw new Error('sign needs --key <private key PEM>.');await signAll(args[at+1]);}
    else if(command==='verify'){const registry=await verifyAll();console.log('registry verified:',registry.plugins.map(p=>`${p.id} ${p.versions.map(v=>v.version).join(', ')}`).join('; '));}
    else if(command==='pack'){if(!args[0])throw new Error('pack needs a plugin folder.');await pack(args[0]);}
    else throw new Error('Usage: node scripts/plugins.mjs build | sign --key <pem> | verify | pack <dir>');
  }catch(error){console.error(error.message);process.exit(1);}
}
