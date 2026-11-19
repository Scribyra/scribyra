// The official plugin registry, bundled with the app as static assets
// (docs/plugins.md#registry). This module is loaded only when the person opens Browse in
// the Plugins manager (or when legacy Zotero data must move into its plugin), so nothing
// is fetched before that. The registry signature and each package's SHA-256 are checked
// before anything is shown or installed.
import {verifyRegistry,verifyPackage} from './plugin-registry.js';
import registryUrl from '../plugins/dist/registry.json?url';
const packages=import.meta.glob('../plugins/dist/*.scribyra-plugin.json',{query:'?url',import:'default',eager:true});

async function bytes(url){
  const response=await fetch(url,{cache:'no-cache',credentials:'same-origin'});
  if(!response.ok)throw new Error('The plugin registry could not be loaded. Check your connection and try again.');
  return new Uint8Array(await response.arrayBuffer());
}
/** The verified official registry: {name, keyId, plugins:[{id, name, publisher, description, versions}]}. */
export async function officialRegistry(){return verifyRegistry(await bytes(registryUrl));}
/** A verified package for one registry version; returns {bytes, pkg}. */
export async function officialPackage(plugin,entry){
  const url=Object.entries(packages).find(([path])=>path.endsWith(`/${entry.package}`))?.[1];
  if(!url)throw new Error(`${plugin.name} ${entry.version} is listed but not published.`);
  const data=await bytes(url);
  const pkg=await verifyPackage(data,{id:plugin.id,...entry});
  return {bytes:data,pkg};
}
