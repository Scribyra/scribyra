// The TeX packages each project's last successful compile installed, remembered on this device
// so the next compile in a new tab installs them before its first pass instead of discovering
// them one failing pass at a time. Only package names are kept (no source); a name the catalog
// no longer has is skipped when it is used. Storage failures only cost the shortcut.
const KEY='scribyra.texPackages',LIMIT=200,NAMES=64;
const valid=name=>typeof name==='string'&&/^[A-Za-z0-9._-]{1,128}$/.test(name);
function load(storage){try{const value=JSON.parse(storage?.getItem(KEY)||'null');return value?.version===1&&value.projects&&typeof value.projects==='object'?value:{version:1,projects:{}};}catch{return{version:1,projects:{}};}}
export function rememberedPackages(projectId,snapshot,storage=globalThis.localStorage){
 if(typeof projectId!=='string'||!projectId)return[];
 const entry=load(storage).projects[projectId];
 return entry?.snapshot===snapshot&&Array.isArray(entry.names)?entry.names.filter(valid).slice(0,NAMES):[];
}
export function rememberPackages(projectId,snapshot,names,storage=globalThis.localStorage,now=Date.now()){
 if(typeof projectId!=='string'||!projectId||!storage)return false;
 try{
  const value=load(storage),list=[...new Set(names.filter(valid))].sort().slice(0,NAMES);
  value.projects[projectId]={snapshot,names:list,used:now};
  const ids=Object.keys(value.projects).sort((a,b)=>value.projects[b].used-value.projects[a].used);
  for(const id of ids.slice(LIMIT))delete value.projects[id];
  storage.setItem(KEY,JSON.stringify(value));return true;
 }catch{return false;}
}
export function forgetPackages(projectId,storage=globalThis.localStorage){
 try{const value=load(storage);if(!value.projects[projectId])return;delete value.projects[projectId];storage.setItem(KEY,JSON.stringify(value));}catch{}
}
