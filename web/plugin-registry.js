// The signed plugin registry and package integrity (docs/plugins.md#registry). Pure
// WebCrypto, so the same checks run in the browser and in Node tests and scripts.
import {readPackage,validPluginId,parseVersion,normalPermissions,PluginError,PLUGIN_API} from './plugin-manifest.js';

/** Public keys the app trusts for the official registry, by key id (JWK, ECDSA P-256).
 * The private half never enters the repository; see docs/plugins.md#open-decisions. */
export const TRUSTED_REGISTRY_KEYS=Object.freeze({
  'scribyra-plugins-dev-2026-11':Object.freeze({kty:'EC',crv:'P-256',x:'5B0Uwkud8zG9f6pTk4EfMozVOPdrNOpPaGEXKEhmgVU',y:'xuJNfdjzvu9Q_d8cseClhs2oyl-3fOqbwB2-INcLBK4'}),
});
export const SIGNATURE_ALGORITHM='ECDSA-P256-SHA256';
const fail=(message,code='invalid_registry')=>{throw new PluginError(code,message);};
const isObject=value=>!!value&&typeof value==='object'&&!Array.isArray(value);

/** Sorted keys, no whitespace: the exact bytes a registry signature covers. */
export function canonicalJson(value){
  if(value===null||typeof value==='boolean'||typeof value==='string')return JSON.stringify(value);
  if(typeof value==='number'){if(!Number.isFinite(value))throw new TypeError('Not representable in canonical JSON.');return JSON.stringify(value);}
  if(Array.isArray(value))return `[${value.map(canonicalJson).join(',')}]`;
  if(isObject(value))return `{${Object.keys(value).sort().filter(key=>value[key]!==undefined).map(key=>`${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  throw new TypeError('Not representable in canonical JSON.');
}
const subtle=()=>globalThis.crypto.subtle;
export async function sha256Hex(bytes){
  const digest=await subtle().digest('SHA-256',bytes);
  return [...new Uint8Array(digest)].map(byte=>byte.toString(16).padStart(2,'0')).join('');
}
function base64(text){
  if(typeof text!=='string'||!/^[A-Za-z0-9+/]+={0,2}$/.test(text))fail('The registry signature is not base64.');
  const raw=atob(text),out=new Uint8Array(raw.length);for(let i=0;i<raw.length;i++)out[i]=raw.charCodeAt(i);return out;
}

function registryEntries(signed){
  if(!isObject(signed)||signed.registryVersion!==1||!Array.isArray(signed.plugins))fail('This registry format is not supported.');
  const ids=new Set();
  return signed.plugins.map(plugin=>{
    if(!isObject(plugin)||!validPluginId(plugin.id)||ids.has(plugin.id)||typeof plugin.name!=='string'||!Array.isArray(plugin.versions)||!plugin.versions.length)fail('A registry entry is not valid.');
    ids.add(plugin.id);
    const versions=plugin.versions.map(entry=>{
      if(!isObject(entry)||!parseVersion(entry.version)||!/^[a-f0-9]{64}$/.test(entry.sha256)||typeof entry.package!=='string'||!/^[A-Za-z0-9._-]{1,128}\.scribyra-plugin\.json$/.test(entry.package)||!Number.isInteger(entry.size)||entry.size<1)fail(`Registry version ${entry?.version} of ${plugin.id} is not valid.`);
      return {version:entry.version,api:entry.api,package:entry.package,sha256:entry.sha256,size:entry.size,permissions:normalPermissions(entry.permissions??{}),compatible:entry.api===PLUGIN_API};
    });
    return {id:plugin.id,name:String(plugin.name).slice(0,40),publisher:String(plugin.publisher||'').slice(0,60),description:String(plugin.description||'').slice(0,300),versions};
  });
}

/** Verifies a registry document against the pinned keys; returns its plugin entries. */
export async function verifyRegistry(document,{keys=TRUSTED_REGISTRY_KEYS}={}){
  let value=document;
  if(typeof document==='string'||document instanceof Uint8Array){try{value=JSON.parse(typeof document==='string'?document:new TextDecoder().decode(document));}catch{fail('The plugin registry is not JSON.');}}
  if(!isObject(value)||!isObject(value.signed)||!isObject(value.signature))fail('The plugin registry is not signed.');
  const {alg,keyId,value:signature}=value.signature;
  if(alg!==SIGNATURE_ALGORITHM)fail('The plugin registry uses an unsupported signature.');
  const jwk=Object.hasOwn(keys,keyId)?keys[keyId]:null;
  if(!jwk||value.signed.keyId!==keyId)fail('The plugin registry is signed with a key Scribyra does not trust.','untrusted_registry');
  let ok=false;
  try{
    const key=await subtle().importKey('jwk',{...jwk,ext:true},{name:'ECDSA',namedCurve:'P-256'},false,['verify']);
    ok=await subtle().verify({name:'ECDSA',hash:'SHA-256'},key,base64(signature),new TextEncoder().encode(canonicalJson(value.signed)));
  }catch(error){if(error instanceof PluginError)throw error;ok=false;}
  if(!ok)fail('The plugin registry signature does not match. It may have been tampered with.','untrusted_registry');
  return {name:String(value.signed.name||'Plugins'),keyId,plugins:registryEntries(value.signed)};
}

/** Checks downloaded package bytes against their registry entry; returns the read package. */
export async function verifyPackage(bytes,{id,version,sha256,permissions}){
  const actual=await sha256Hex(bytes);
  if(actual!==sha256)fail('The plugin package does not match the registry (its SHA-256 differs). Nothing was installed.','integrity');
  const pkg=readPackage(bytes);
  if(pkg.manifest.id!==id||pkg.manifest.version!==version)fail('The plugin package names a different plugin or version than the registry.','integrity');
  if(JSON.stringify(pkg.manifest.permissions)!==JSON.stringify(normalPermissions(permissions)))fail('The plugin package asks for different permissions than the registry lists.','integrity');
  return {...pkg,sha256:actual};
}
