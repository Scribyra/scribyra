// Whether this browser profile has direct sessions turned on, and which author IDs it has
// used. Reading these opens nothing: with sessions never turned on, D creates no key,
// opens no `scribyra-direct` database and writes nothing to any project.
export const DIRECT_ENABLED='scribyra:direct-enabled';
// Author IDs this profile used before its current key-derived one (oldest first).
export const LEGACY_AUTHORS='scribyra:legacy-authors';
// Set when a signing key exists, so Share can offer to delete it without opening storage.
export const DIRECT_KEY='scribyra:direct-key';
const read=key=>{try{return globalThis.localStorage?.getItem(key)??null;}catch{return null;}};
const write=(key,value)=>{try{if(value===null)globalThis.localStorage?.removeItem(key);else globalThis.localStorage?.setItem(key,value);}catch{}};
const UUID=/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
export const directEnabled=()=>read(DIRECT_ENABLED)==='true';
export const setDirectEnabled=on=>write(DIRECT_ENABLED,String(!!on));
export const directKeyPresent=()=>read(DIRECT_KEY)==='present';
export const setDirectKeyPresent=present=>write(DIRECT_KEY,present?'present':null);
export function legacyAuthorIds(){
 let ids;try{ids=JSON.parse(read(LEGACY_AUTHORS)||'[]');}catch{ids=[];}
 return Array.isArray(ids)?[...new Set(ids.filter(id=>typeof id==='string'&&UUID.test(id)))].slice(-32):[];
}
export function addLegacyAuthorId(id){if(UUID.test(id||'')&&!legacyAuthorIds().includes(id))write(LEGACY_AUTHORS,JSON.stringify([...legacyAuthorIds(),id].slice(-32)));}
