// A faithful stand-in for the parts of the Zotero Web API v3 Scribyra uses, so tests
// never contact api.zotero.org. Behaviour follows the public documentation
// (https://www.zotero.org/support/dev/web_api/v3/basics and /syncing) and the CORS
// headers api.zotero.org sent to an anonymous preflight on November 17, 2026:
//
//   Zotero-API-Key header, Zotero-API-Version: 3 (other versions are refused here)
//   GET /keys/current → {key, userID, username, access:{user:{library,notes,write,files}, groups:{all|<id>:{library,write}}}}
//   GET /users/<id>/groups, GET <lib>/collections: JSON arrays, paged
//   GET <lib>/items, <lib>/items/top, <lib>/collections/<key>/items[/top]
//       format=json (default) with include=data|biblatex|bibtex…, format=versions, format=keys
//       itemKey=A,B (≤ 50), itemType=-attachment (NOT) and a || b (OR), since=<version>
//       limit (default 25, max 100), start, sort/direction; Link (first/prev/next/last/alternate),
//       Total-Results and Last-Modified-Version headers; If-Modified-Since-Version → 304
//   Trashed items are left out unless includeTrashed=1. 403 for a bad key or a library the
//   key cannot read, 404 for an unknown library or collection, 429 with Retry-After when asked.
import http from 'node:http';

const CORS={
  'Access-Control-Allow-Origin':'*',
  'Access-Control-Allow-Methods':'HEAD, GET, POST, PUT, PATCH, DELETE',
  'Access-Control-Allow-Headers':'Authorization, Content-Type, If-Match, If-None-Match, If-Modified-Since-Version, If-Unmodified-Since-Version, Zotero-API-Key, Zotero-API-Version, Zotero-Schema-Version, Zotero-Write-Token',
  'Access-Control-Expose-Headers':'Backoff, ETag, Last-Modified-Version, Link, Retry-After, Total-Results, Zotero-API-Version',
  'Access-Control-Max-Age':'86400',
};
const STOP=new Set(['a','an','the','of','on','in','and','for','to','with','from','at','by','is','are','la','le','der','die','das','el','un','une']);
const ascii=text=>String(text||'').normalize('NFKD').replace(/[\u0300-\u036f]/g,'').replace(/[^A-Za-z0-9]/g,'').toLowerCase();
/** Zotero's built-in citation key: creator_title_year, as its BibTeX translators make it. */
export function zoteroCitationKey(data){
  if(data.citationKey)return data.citationKey;
  const creator=ascii(data.creators?.[0]?.lastName||data.creators?.[0]?.name||'');
  const word=String(data.title||'').split(/\s+/).map(ascii).find(part=>part&&!STOP.has(part))||'';
  const year=String(data.date||'').match(/\d{4}/)?.[0]||'';
  return [creator,word,year].filter(Boolean).join('_')||'noKey';
}
const TYPES={journalArticle:'article',book:'book',bookSection:'incollection',conferencePaper:'inproceedings',thesis:'thesis',report:'report',webpage:'online',preprint:'online'};
const brace=value=>String(value).replace(/[{}]/g,'').replace(/&/g,'\\&').replace(/%/g,'\\%');
/** Zotero's BibLaTeX or BibTeX export of one item: fields one per line, a trailing comma, keys pinned by citationKey. */
export function exportItem(item,format){
  const data=item.data;if(['note','attachment'].includes(data.itemType))return '';
  const biblatex=format==='biblatex',type=biblatex?TYPES[data.itemType]||'misc':TYPES[data.itemType]==='thesis'?'phdthesis':TYPES[data.itemType]==='online'?'misc':TYPES[data.itemType]||'misc';
  const fields=[];const add=(name,value)=>{if(value!==undefined&&value!==null&&String(value)!=='')fields.push([name,value]);};
  add('title',brace(data.title||''));
  add(biblatex?'journaltitle':'journal',data.publicationTitle&&brace(data.publicationTitle));
  add('volume',data.volume);add('pages',data.pages);add('publisher',data.publisher&&brace(data.publisher));
  add('doi',data.DOI);add('url',data.url);
  const authors=(data.creators||[]).filter(creator=>creator.creatorType==='author').map(creator=>creator.name?`{${brace(creator.name)}}`:`${brace(creator.lastName)}, ${brace(creator.firstName)}`);
  add('author',authors.join(' and '));
  const year=String(data.date||'').match(/\d{4}/)?.[0];if(biblatex)add('date',data.date);else add('year',year);
  return `\n@${type}{${zoteroCitationKey(data)},\n${fields.map(([name,value])=>`\t${name} = {${value}}`).join(',\n')},\n}\n`;
}

export function fakeZotero({publicBase='https://api.zotero.org',cors=true}={}){
  const libraries=new Map(),keys=new Map(),users=new Map(),groups=new Map();
  const requests=[];let rateLimit=null,backoff=0,keySeq=0;
  function library(prefix){if(!libraries.has(prefix))libraries.set(prefix,{version:1,items:new Map(),collections:new Map()});return libraries.get(prefix);}
  const api={
    requests,
    addUser({id,username}){users.set(String(id),{id:String(id),username});library(`users/${id}`);return api;},
    addGroup({id,name,members=[]}){groups.set(String(id),{id:String(id),name,members:members.map(String)});library(`groups/${id}`);return api;},
    addKey(key,{userId,access}){keys.set(key,{userId:String(userId),access});return api;},
    /** Adds or updates items in one write; each write raises the library version once. */
    write(prefix,changes){
      const lib=library(prefix);lib.version++;
      for(const change of changes){
        const key=change.key||(`ITEM${String(++keySeq).padStart(4,'0')}`);
        const old=lib.items.get(key);
        lib.items.set(key,{key,version:lib.version,deleted:change.deleted??old?.deleted??false,collections:change.collections??old?.collections??[],data:{...(old?.data||{}),...(change.data||{})}});
      }
      return lib.version;
    },
    trash(prefix,key){return api.write(prefix,[{key,deleted:true}]);},
    collection(prefix,{key,name,parent=false}){const lib=library(prefix);lib.version++;lib.collections.set(key,{key,version:lib.version,data:{key,version:lib.version,name,parentCollection:parent,relations:{}}});return api;},
    item(prefix,key){return library(prefix).items.get(key);},
    version(prefix){return library(prefix).version;},
    limitOnce(seconds){rateLimit=seconds;},
    backoff(seconds){backoff=seconds;},
    handle,
    listen(port){
      return new Promise((resolve,reject)=>{
        const server=http.createServer((request,response)=>{
          const result=handle({method:request.method,url:request.url,headers:request.headers});
          response.writeHead(result.status,result.headers);response.end(result.body);
        });
        server.once('error',reject);server.listen(port,'127.0.0.1',()=>resolve({port:server.address().port,close:()=>new Promise(done=>{server.closeAllConnections?.();server.close(done);})}));
      });
    },
  };
  function reply(status,body,headers={}){
    const text=body===undefined?'':typeof body==='string'?body:JSON.stringify(body);
    return {status,body:text,headers:{...(cors?CORS:{}),'Zotero-API-Version':'3',...(typeof body==='string'?{'Content-Type':'text/plain; charset=utf-8'}:body!==undefined?{'Content-Type':'application/json'}:{}),...(backoff?{Backoff:String(backoff)}:{}),...headers}};
  }
  function access(key,prefix){
    const record=keys.get(key);if(!record)return false;
    const [kind,id]=prefix.split('/');
    if(kind==='users')return id===record.userId&&!!record.access.user?.library;
    const group=record.access.groups||{};return !!(group.all?.library||group[id]?.library)&&!!groups.get(id)?.members.includes(record.userId);
  }
  function header(headers,name){const lower=name.toLowerCase();for(const [key,value]of Object.entries(headers||{}))if(key.toLowerCase()===lower)return Array.isArray(value)?value[0]:value;return undefined;}
  function page(url,all,lib){
    const limit=Math.min(100,Math.max(1,Number(url.searchParams.get('limit')||25))),start=Math.max(0,Number(url.searchParams.get('start')||0));
    const slice=all.slice(start,start+limit),links=[];
    const at=offset=>{const next=new URL(url.pathname+url.search,publicBase);next.searchParams.set('start',String(offset));if(!url.searchParams.has('limit'))next.searchParams.set('limit',String(limit));if(offset===0)next.searchParams.delete('start');return next.href;};
    if(start>0)links.push(`<${at(0)}>; rel="first"`,`<${at(Math.max(0,start-limit))}>; rel="prev"`);
    if(start+limit<all.length)links.push(`<${at(start+limit)}>; rel="next"`,`<${at(Math.floor((all.length-1)/limit)*limit)}>; rel="last"`);
    links.push(`<https://www.zotero.org/${url.pathname.split('/').slice(1,3).join('/')}/items>; rel="alternate"`);
    return {slice,headers:{'Total-Results':String(all.length),Link:links.join(', '),'Last-Modified-Version':String(lib.version)}};
  }
  function handle({method,url:raw,headers}){
    const url=new URL(raw,'http://fake.invalid');
    requests.push({method,path:url.pathname,search:url.search,key:header(headers,'Zotero-API-Key')||null,origin:header(headers,'Origin')||null});
    if(method==='OPTIONS')return reply(200,undefined);
    if(method!=='GET'&&method!=='HEAD')return reply(405,'Method not allowed');
    const version=header(headers,'Zotero-API-Version');if(version!==undefined&&version!=='3')return reply(400,'Invalid API version');
    if(header(headers,'Expect'))return reply(417,'Expect header not supported');
    if(rateLimit){const seconds=rateLimit;rateLimit=null;return reply(429,'Too many requests',{'Retry-After':String(seconds)});}
    const key=header(headers,'Zotero-API-Key')||(header(headers,'Authorization')||'').replace(/^Bearer /,'')||url.searchParams.get('key');
    const parts=url.pathname.split('/').filter(Boolean);
    if(parts[0]==='keys'&&parts[1]==='current'){
      const record=keys.get(key);if(!record)return reply(403,'Invalid key');
      return reply(200,{key,userID:Number(record.userId),username:users.get(record.userId)?.username||'',access:record.access});
    }
    if(!['users','groups'].includes(parts[0])||!/^\d+$/.test(parts[1]||''))return reply(404,'Not found');
    const prefix=`${parts[0]}/${parts[1]}`;
    if(parts[0]==='users'&&parts[2]==='groups'){
      const record=keys.get(key);if(!record||record.userId!==parts[1])return reply(403,'Forbidden');
      const list=[...groups.values()].filter(group=>group.members.includes(parts[1])).map(group=>({id:Number(group.id),version:1,links:{},meta:{numItems:library(`groups/${group.id}`).items.size},data:{id:Number(group.id),version:1,name:group.name,type:'Private',libraryReading:'members'}}));
      const {slice,headers:paging}=page(url,list,{version:list.length});return reply(200,slice,paging);
    }
    if(!libraries.has(prefix))return reply(404,'Not found');
    if(!access(key,prefix))return reply(403,'Forbidden');
    const lib=library(prefix),rest=parts.slice(2);
    const since=Number(url.searchParams.get('since')||0),ifModified=header(headers,'If-Modified-Since-Version');
    if(ifModified!==undefined&&Number(ifModified)>=lib.version)return reply(304,undefined,{'Last-Modified-Version':String(lib.version)});
    if(rest[0]==='collections'&&rest.length===1){
      const list=[...lib.collections.values()].filter(collection=>collection.version>since).map(collection=>({key:collection.key,version:collection.version,library:libraryInfo(prefix),links:{},meta:{numCollections:0,numItems:[...lib.items.values()].filter(item=>item.collections.includes(collection.key)&&!item.deleted).length},data:collection.data}));
      const {slice,headers:paging}=page(url,list,lib);return reply(200,slice,paging);
    }
    let collection=null,top=false;
    if(rest[0]==='collections'&&rest[2]==='items'){collection=rest[1];if(!lib.collections.has(collection))return reply(404,'Collection not found');top=rest[3]==='top';if(rest.length>4||rest[3]&&rest[3]!=='top')return reply(404,'Not found');}
    else if(rest[0]==='items'){top=rest[1]==='top';if(rest.length>2||rest[1]&&rest[1]!=='top')return reply(404,'Not found');}
    else return reply(404,'Not found');
    let items=[...lib.items.values()].filter(item=>(url.searchParams.get('includeTrashed')==='1'||!item.deleted)&&item.version>since&&(!collection||item.collections.includes(collection))&&(!top||!item.data.parentItem));
    const itemKey=url.searchParams.get('itemKey');
    if(itemKey){const wanted=itemKey.split(',');if(wanted.length>50)return reply(400,'Too many item keys');items=items.filter(item=>wanted.includes(item.key));}
    const itemType=url.searchParams.get('itemType');
    if(itemType){const negate=itemType.startsWith('-'),types=itemType.replace(/^-/,'').split('||').map(type=>type.trim());items=items.filter(item=>negate?!types.includes(item.data.itemType):types.includes(item.data.itemType));}
    const sort=url.searchParams.get('sort')||'dateModified',direction=url.searchParams.get('direction')||(sort==='title'?'asc':'desc');
    items.sort((a,b)=>(sort==='dateAdded'?a.key.localeCompare(b.key):a.version-b.version||a.key.localeCompare(b.key))*(direction==='asc'?1:-1));
    const format=url.searchParams.get('format')||'json';
    if(format==='versions')return reply(200,Object.fromEntries(items.map(item=>[item.key,item.version])),{'Last-Modified-Version':String(lib.version),'Total-Results':String(items.length)});
    if(format==='keys')return reply(200,items.map(item=>item.key).join('\n')+'\n',{'Last-Modified-Version':String(lib.version)});
    if(format==='bibtex'||format==='biblatex'){
      if(!url.searchParams.has('limit')&&!itemKey)return reply(400,'limit is required for export formats');
      const {slice,headers:paging}=page(url,items,lib);return reply(200,slice.map(item=>exportItem(item,format)).join(''),{...paging,'Content-Type':'text/plain; charset=utf-8'});
    }
    if(format!=='json')return reply(400,'Invalid format');
    const include=(url.searchParams.get('include')||'data').split(',');
    const {slice,headers:paging}=page(url,items,lib);
    return reply(200,slice.map(item=>{
      const value={key:item.key,version:item.version,library:libraryInfo(prefix),links:{self:{href:`${publicBase}/${prefix}/items/${item.key}`,type:'application/json'},alternate:{href:`https://www.zotero.org/${prefix}/items/${item.key}`,type:'text/html'}},meta:{creatorSummary:item.data.creators?.[0]?.lastName||'',parsedDate:item.data.date||'',numChildren:0}};
      for(const name of include){if(name==='data')value.data={key:item.key,version:item.version,...item.data};else if(name==='bibtex'||name==='biblatex')value[name]=exportItem(item,name);}
      return value;
    }),paging);
  }
  function libraryInfo(prefix){const [kind,id]=prefix.split('/');return {type:kind==='users'?'user':'group',id:Number(id),name:kind==='users'?users.get(id)?.username||'':groups.get(id)?.name||'',links:{}};}
  return api;
}
