// The Zotero Web API v3, read-only, from the Zotero plugin through the host's fetch
// proxy (docs/plugins.md): the plugin may contact only https://api.zotero.org. The only destination is
// https://api.zotero.org: the origin is fixed here and pagination links pointing
// anywhere else are refused, so the key cannot be sent to another host. Requests omit
// cookies and the referrer and are never cached. Nothing here records telemetry.
//
// Requests used (https://www.zotero.org/support/dev/web_api/v3/basics and /syncing):
//   GET /keys/current                                  which account and access the key has
//   GET /users/<id>/groups                             group libraries the account belongs to
//   GET <library>/collections                          collections, paged with limit/start and Link
//   GET <library>[/collections/<key>]/items/top?format=json&include=biblatex|bibtex
//   GET <library>[/collections/<key>]/items/top?format=versions  with If-Modified-Since-Version
//   GET <library>/items?itemKey=A,B,…&format=json&include=…     at most 50 keys per request
export const ZOTERO_ORIGIN='https://api.zotero.org';
export const ZOTERO_KEYS_URL='https://www.zotero.org/settings/keys';
const MAX_PAGES=100,PAGE=100,KEYS_PER_REQUEST=50;

export class ZoteroError extends Error{constructor(code,message,extra={}){super(message);this.name='ZoteroError';this.code=code;Object.assign(this,extra);}}
export const OFFLINE_MESSAGE='Refreshing from Zotero needs a network connection, and this device is offline. The linked file is an ordinary project file: keep editing and compiling, and refresh when you are back online.';

export const validLibraryId=id=>/^[1-9]\d{0,11}$/.test(String(id));
export const validCollectionKey=key=>/^[A-Z0-9]{8}$/.test(key);
export const validApiKey=key=>/^[A-Za-z0-9]{24}$/.test(key);
export function libraryPath(library){
  if(!library||!['user','group'].includes(library.type)||!validLibraryId(library.id))throw new ZoteroError('invalid','Choose a Zotero library.');
  return `/${library.type==='user'?'users':'groups'}/${library.id}`;
}
function itemsPath(library,collection){
  if(collection&&!validCollectionKey(collection))throw new ZoteroError('invalid','That is not a Zotero collection key.');
  return libraryPath(library)+(collection?`/collections/${collection}`:'')+'/items/top';
}
const exportFormat=format=>{if(format!=='biblatex'&&format!=='bibtex')throw new ZoteroError('invalid','Choose BibLaTeX or BibTeX.');return format;};
function nextLink(header){
  for(const part of (header||'').split(',')){const match=part.match(/<([^>]+)>\s*;\s*rel="?next"?/);if(match)return match[1];}
  return null;
}

/**
 * A client bound to one API key. `fetcher` and `online` exist for tests; production
 * uses the browser's fetch and navigator.onLine.
 */
export function zoteroApi({apiKey,fetcher=(...args)=>globalThis.fetch(...args),online=()=>globalThis.navigator?.onLine!==false,now=()=>Date.now()}){
  if(!validApiKey(apiKey))throw new ZoteroError('invalid','A Zotero API key is 24 letters and digits. Copy it from zotero.org/settings/keys.');
  let waitUntil=0;
  async function request(path,{signal,version}={}){
    const url=new URL(path,ZOTERO_ORIGIN);
    if(url.origin!==ZOTERO_ORIGIN)throw new ZoteroError('invalid','Scribyra only contacts api.zotero.org for Zotero.');
    if(!online())throw new ZoteroError('offline',OFFLINE_MESSAGE);
    if(now()<waitUntil)throw new ZoteroError('rate_limited',`Zotero asked Scribyra to wait. Try again in ${Math.ceil((waitUntil-now())/1000)} s.`);
    const headers={'Zotero-API-Version':'3','Zotero-API-Key':apiKey};
    if(version!==undefined)headers['If-Modified-Since-Version']=String(version);
    let response;
    try{response=await fetcher(url.href,{method:'GET',headers,credentials:'omit',referrerPolicy:'no-referrer',cache:'no-store',redirect:'error',mode:'cors',signal});}
    catch(error){
      if(error?.name==='AbortError')throw error;
      if(!online())throw new ZoteroError('offline',OFFLINE_MESSAGE);
      throw new ZoteroError('network','Scribyra could not reach api.zotero.org. Check your connection and try again; nothing in the project changed.');
    }
    const backoff=Number(response.headers.get('Backoff')),retry=Number(response.headers.get('Retry-After'));
    if(backoff>0)waitUntil=Math.max(waitUntil,now()+Math.min(backoff,3600)*1000);
    if(response.status===304)return {response,notModified:true};
    if(response.ok)return {response};
    if((response.status===429||response.status===503)&&retry>0)waitUntil=Math.max(waitUntil,now()+Math.min(retry,3600)*1000);
    const messages={
      400:'Zotero did not accept the request. Check the library and collection.',
      403:'Zotero refused this API key for that library. Check that the key is correct, still exists and allows reading this library at zotero.org/settings/keys.',
      404:'Zotero has no such library or collection, or this key cannot see it.',
      429:`Zotero is limiting requests. Try again${retry>0?` in ${retry} s`:' in a minute'}.`,
      503:`Zotero is temporarily unavailable. Try again${retry>0?` in ${retry} s`:' later'}.`,
    };
    throw new ZoteroError(response.status===403?'forbidden':response.status===404?'not_found':response.status===429?'rate_limited':response.status>=500?'server':'invalid',messages[response.status]||`Zotero answered with HTTP ${response.status}. Try again later.`,{status:response.status});
  }
  async function json(path,options){const {response}=await request(path,options);try{return {value:await response.json(),response};}catch{throw new ZoteroError('invalid','Zotero sent a response Scribyra could not read.');}}
  /** Every page of a multi-object request; restarts if the library changes between pages. */
  async function pages(path,{signal}={}){
    for(let attempt=0;attempt<3;attempt++){
      const results=[];let next=path,version=null,changed=false;
      for(let page=0;next;page++){
        if(page>=MAX_PAGES)throw new ZoteroError('too_large',`This library has more than ${MAX_PAGES*PAGE} entries. Link a collection instead.`);
        const {value,response}=await json(next,{signal});
        if(!Array.isArray(value))throw new ZoteroError('invalid','Zotero sent a response Scribyra could not read.');
        const current=Number(response.headers.get('Last-Modified-Version'));
        if(version===null)version=current;else if(current!==version){changed=true;break;}
        results.push(...value);
        const link=nextLink(response.headers.get('Link'));
        if(link&&new URL(link,ZOTERO_ORIGIN).origin!==ZOTERO_ORIGIN)throw new ZoteroError('invalid','Zotero pointed to another host; Scribyra stopped.');
        next=link?new URL(link,ZOTERO_ORIGIN).pathname+new URL(link,ZOTERO_ORIGIN).search:null;
      }
      if(!changed)return {results,version:Number.isFinite(version)?version:0};
    }
    throw new ZoteroError('busy','The Zotero library kept changing while Scribyra read it. Try again in a moment.');
  }
  return {
    /** The account and access this key has (GET /keys/current). */
    async currentKey({signal}={}){
      const {value}=await json('/keys/current',{signal});
      if(!value||!validLibraryId(value.userID))throw new ZoteroError('invalid','Zotero did not say which account this key belongs to.');
      const access=value.access||{},user=access.user||{},groups=access.groups||{};
      const write=!!user.write||Object.values(groups).some(group=>group?.write);
      return {userId:String(value.userID),username:String(value.username||''),access:{library:!!user.library,groups:Object.fromEntries(Object.entries(groups).map(([id,group])=>[id,{library:!!group?.library,write:!!group?.write}]))},write};
    },
    async groups(userId,{signal}={}){
      if(!validLibraryId(userId))throw new ZoteroError('invalid','A Zotero user ID is a number.');
      const {results}=await pages(`/users/${userId}/groups?limit=${PAGE}`,{signal});
      return results.filter(group=>validLibraryId(group?.id)).map(group=>({id:String(group.id),name:String(group.data?.name||`Group ${group.id}`)})).sort((a,b)=>a.name.localeCompare(b.name));
    },
    async collections(library,{signal}={}){
      const {results}=await pages(`${libraryPath(library)}/collections?limit=${PAGE}`,{signal});
      const all=results.filter(collection=>validCollectionKey(collection?.key)).map(collection=>({key:collection.key,name:String(collection.data?.name||collection.key),parent:collection.data?.parentCollection||null}));
      const byKey=new Map(all.map(collection=>[collection.key,collection]));
      const path=collection=>{const names=[];for(let at=collection,seen=0;at&&seen<32;at=byKey.get(at.parent),seen++)names.unshift(at.name);return names.join(' › ');};
      return all.map(collection=>({...collection,path:path(collection)})).sort((a,b)=>a.path.localeCompare(b.path));
    },
    /** Every top-level item's export, for the first fetch. */
    async items(library,collection,format,{signal}={}){
      const {results,version}=await pages(`${itemsPath(library,collection)}?format=json&include=${exportFormat(format)}&itemType=-attachment&limit=${PAGE}&sort=dateAdded&direction=asc`,{signal});
      return {items:results,version};
    },
    /** Item versions now, or `notModified` when nothing in the library changed since `since`. */
    async versions(library,collection,since,{signal}={}){
      const {response,notModified}=await request(`${itemsPath(library,collection)}?format=versions&itemType=-attachment`,{signal,version:since});
      const version=Number(response.headers.get('Last-Modified-Version'));
      if(notModified)return {notModified:true,version:since};
      let value;try{value=await response.json();}catch{throw new ZoteroError('invalid','Zotero sent a response Scribyra could not read.');}
      if(!value||typeof value!=='object'||Array.isArray(value))throw new ZoteroError('invalid','Zotero sent a response Scribyra could not read.');
      return {versions:new Map(Object.entries(value).filter(([key,item])=>/^[A-Z0-9]{8}$/.test(key)&&Number.isInteger(item))),version};
    },
    /** Exports of specific items, at most 50 per request. */
    async itemsByKey(library,keys,format,{signal}={}){
      const items=[];
      for(let i=0;i<keys.length;i+=KEYS_PER_REQUEST){
        const batch=keys.slice(i,i+KEYS_PER_REQUEST);if(batch.some(key=>!/^[A-Z0-9]{8}$/.test(key)))throw new ZoteroError('invalid','Unexpected Zotero item key.');
        const {value}=await json(`${libraryPath(library)}/items?format=json&include=${exportFormat(format)}&itemKey=${batch.join(',')}&limit=${KEYS_PER_REQUEST}`,{signal});
        if(!Array.isArray(value))throw new ZoteroError('invalid','Zotero sent a response Scribyra could not read.');
        items.push(...value);
      }
      return items;
    },
  };
}
