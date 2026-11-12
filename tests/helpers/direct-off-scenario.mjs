// One project opened, edited, commented, reviewed, decided, named in history, backed up and
// exported, with direct sessions never turned on, made deterministic so that two source
// trees can be compared byte for byte. It prints a JSON digest of everything stored or
// exported. tests/direct-off.test.mjs runs it against this tree and compares the result
// with the same run on `main` (fixtures/direct-off-main.json, from --tree with a main
// checkout; see scripts/direct-off-baseline.mjs).
//
// Browsers provide Web Locks and IndexedDB, and Node normally lacks the first: the scenario
// supplies both, so code that would create a key in a browser would create one here too.
import {webcrypto,createHash} from 'node:crypto';
let state=0x5eed1234;
const next=()=>{state=state+0x6d2b79f5>>>0;let t=state;t=Math.imul(t^t>>>15,t|1);t^=t+Math.imul(t^t>>>7,t|61);return((t^t>>>14)>>>0);};
webcrypto.getRandomValues=array=>{const bytes=new Uint8Array(array.buffer,array.byteOffset,array.byteLength);for(let i=0;i<bytes.length;i++)bytes[i]=next()&255;return array;};
webcrypto.randomUUID=()=>{const b=webcrypto.getRandomValues(new Uint8Array(16));b[6]=b[6]&15|64;b[8]=b[8]&63|128;const h=[...b].map(x=>x.toString(16).padStart(2,'0')).join('');return`${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20)}`;};
Math.random=()=>next()/2**32;
let clock=1_762_560_000_000;Date.now=()=>clock+=7;
const store=new Map();
globalThis.localStorage={getItem:key=>store.has(key)?store.get(key):null,setItem:(key,value)=>store.set(key,String(value)),removeItem:key=>store.delete(key),key:i=>[...store.keys()][i]??null,get length(){return store.size;},clear:()=>store.clear()};
Object.defineProperty(globalThis.navigator,'locks',{configurable:true,value:{request:async(_name,options,run)=>(run||options)({name:_name})}});
const generated=[];const generateKey=webcrypto.subtle.generateKey.bind(webcrypto.subtle);webcrypto.subtle.generateKey=(algorithm,...rest)=>{generated.push(algorithm?.name||algorithm);return generateKey(algorithm,...rest);};

await import('fake-indexeddb/auto');
const opened=new Set(),open=indexedDB.open.bind(indexedDB);indexedDB.open=(name,...rest)=>{opened.add(name);return open(name,...rest);};
const {integrationSession}=await import('./integration-session.mjs');
const {localAuthor}=await import('../../web/local-author.js');
const {exportZip}=await import('../../web/model.js');

const ok=reply=>{if(!reply.ok)throw Error(JSON.stringify(reply));return reply.value;};
const owner=localAuthor();
const f=await integrationSession({owner});
const at=text=>{const start=f.source().indexOf(text);return{fileId:'main',start,end:start+text.length,before:text};};
f.doc.getText('text:main').insert(f.source().indexOf('alpha'),'edited ');await f.context.flushSave();
const {before:_quote,...range}=at('bravo'),thread=ok(await f.call({op:'thread.create',...range,body:'A comment'},false));
ok(await f.call({op:'thread.reply',threadId:thread.threadId,body:'A reply'},false));
const review=ok(await f.call({op:'review.create',title:'Review'},false));
const accepted=ok(await f.call({op:'suggestion.propose',reviewId:review.reviewId,...at('alpha'),after:'ALPHA'},false));
const rejected=ok(await f.call({op:'suggestion.propose',reviewId:review.reviewId,...at('charlie'),after:'CHARLIE'},false));
ok(await f.call({op:'suggestion.accept',suggestionIds:[accepted.suggestionId],eventHeads:{[accepted.suggestionId]:f.heads(accepted.suggestionId)}},false));
ok(await f.call({op:'suggestion.reject',suggestionId:rejected.suggestionId,eventHeads:f.heads(rejected.suggestionId)},false));
ok(await f.call({op:'history.name',label:'Decided'},false));
const artifact=ok(await f.call({op:'backup.export'},false)),part=ok(await f.call({op:'artifact.read',artifactId:artifact.artifactId},false)),backup=f.history.readAttachment(part.attachmentRef);
const zip=exportZip(f.doc);
await f.context.flushSave();

const plain=value=>value instanceof Uint8Array||ArrayBuffer.isView(value)?{bytes:Buffer.from(value.buffer,value.byteOffset,value.byteLength).toString('hex')}:value instanceof ArrayBuffer?{bytes:Buffer.from(value).toString('hex')}:Array.isArray(value)?value.map(plain):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(key=>[key,plain(value[key])])):value;
const databases={};
for(const {name}of await indexedDB.databases()){
 const db=await new Promise((resolve,reject)=>{const request=open(name);request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);});
 const stores={};
 for(const storeName of[...db.objectStoreNames].sort()){
  stores[storeName]=await new Promise((resolve,reject)=>{const rows=[],request=db.transaction(storeName).objectStore(storeName).openCursor();request.onsuccess=()=>{const cursor=request.result;if(!cursor)return resolve(rows);rows.push([plain(cursor.key),plain(cursor.value)]);cursor.continue();};request.onerror=()=>reject(request.error);});
 }
 db.close();databases[name]=stores;
}
const digest=value=>createHash('sha256').update(typeof value==='string'?value:Buffer.from(value)).digest('hex');
const storage=JSON.stringify(databases),text=[storage,Buffer.from(backup).toString('latin1'),Buffer.from(zip).toString('latin1')].join('\n');
f.close();
process.stdout.write(JSON.stringify({
 authorId:owner.id,
 localStorage:Object.fromEntries([...store].sort()),
 databases:Object.keys(databases).sort(),
 opened:[...opened].sort(),
 generatedKeys:generated.length,
 directFields:/directProof|directClaim|scribyra-direct/.test(text),
 storage:{sha256:digest(storage),bytes:storage.length},
 backup:{sha256:digest(backup),bytes:backup.byteLength},
 zip:{sha256:digest(zip),bytes:zip.byteLength},
},null,1)+'\n');
