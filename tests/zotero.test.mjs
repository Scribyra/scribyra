// Bibliography reading, Zotero refresh merging, key stability and the Web API client
// against the fake Zotero server (tests/helpers/fake-zotero.mjs). No real network.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readBibliography,checkBibliography,citedKeys,entryFingerprint,withCitationKey,fieldChanges,validCitationKey} from '../web/bibtex.js';
import {composeLinkedFile,planRefresh,applyRefresh,remoteEntry} from '../plugins/zotero/src/sync.js';
import {zoteroApi,ZOTERO_ORIGIN,ZoteroError} from '../plugins/zotero/src/api.js';
import {fakeZotero,exportItem,zoteroCitationKey} from './helpers/fake-zotero.mjs';

const BIB=`% My references
@string{jnl = "Journal of Tests"}
@article{knuth1984,
  author = {Donald E. Knuth},
  title = {Literate {Programming}},
  journal = jnl,
  year = 1984,
  month = jan,
}

@Book(lamport1994, author="Leslie Lamport", title = "{LaTeX}: A Document Preparation System", year={1994})
@comment{jabref-meta: databaseType:biblatex;}
% @article{commented, title={Not an entry}}
@online{web:2020-x.y_z,title={With a colon key},url={https://example.org/a%20b},date={2020-05-01}}
`;

test('reads entries with exact ranges, keeping citation keys as written',()=>{
  const {entries,problems,strings}=readBibliography(BIB);
  assert.deepEqual(problems,[]);
  assert.deepEqual(strings,['jnl']);
  assert.deepEqual(entries.map(entry=>[entry.key,entry.type]),[['knuth1984','article'],['lamport1994','book'],['web:2020-x.y_z','online']]);
  for(const entry of entries)assert.equal(BIB.slice(entry.start,entry.end),entry.raw);
  assert.equal(entries[0].fields.get('title').value,'Literate {Programming}');
  assert.equal(entries[0].fields.get('journal').value,'jnl');
  assert.equal(entries[1].fields.get('title').value,'{LaTeX}: A Document Preparation System');
  assert.equal(entries[0].line,3);
});

test('reports malformed entries clearly, with lines, and keeps reading after them',()=>{
  const text=[
    '@article{good1, title={Fine}, year=2001}',              // 1
    '@article{missingcomma, title={A} year={2002}}',          // 2
    '@article{, title={No key}}',                             // 3
    '@article{bad key, title={Space}}',                       // 4
    '@book{unclosed, title={Never closed},',                  // 5
    '  year = 2003',                                          // 6
    '@article{good2, title={After the broken one}, journal=undefinedmacro}', // 7
    '@article{good1, title={Duplicate}}',                     // 8
    '@article{dupfield, title={One}, title={Two}}',           // 9
    '@misc{noequals, title {x}}',                             // 10
    '@article{quote, title="unterminated}',                   // 11
    '',
  ].join('\n');
  const {entries,problems}=readBibliography(text);
  const at=line=>problems.filter(problem=>problem.line===line).map(problem=>`${problem.severity}: ${problem.message}`);
  assert.match(at(2)[0],/^error: “missingcomma”: A comma is missing before field “year”/);
  assert.match(at(3)[0],/^error: An @article entry has no citation key/);
  assert.match(at(4)[0],/^error: Citation key “bad key” contains a character LaTeX cannot cite \(spaces/);
  assert.match(at(5)[0],/^error: Entry “unclosed” is not closed: a “}” is missing/);
  assert.match(at(7)[0],/^warning: “good2”: Field “journal” uses “undefinedmacro”, which no @string defines/);
  assert.match(at(8)[0],/^error: Citation key “good1” is used again \(first on line 1\)/);
  assert.match(at(9)[0],/^warning: “dupfield”: Field “title” appears twice/);
  assert.match(at(10)[0],/^error: “noequals”: Field “title” has no “=” and value/);
  assert(at(11).some(message=>/unmatched quotation mark|is not closed/.test(message)),at(11).join());
  // Readable entries are still found, including the one after the unclosed entry.
  assert(entries.some(entry=>entry.key==='good2'));
  const summary=checkBibliography(text);
  assert(summary.errors>=7&&summary.warnings>=2,JSON.stringify(summary));
});

test('a Zotero or Better BibTeX export with BOM-free UTF-8, @comment blocks and odd keys has no problems',()=>{
  const bbt='@comment{Better BibTeX export}\n@article{müller_über_2021,\n\ttitle = {Über {Systeme}},\n\tauthor = {Müller, Jörg},\n\tdate = {2021},\n}\n';
  const result=checkBibliography(bbt);assert.equal(result.errors,0);assert.deepEqual(result.keys,['müller_über_2021']);
  assert(validCitationKey('a:b-c_d.e/f'));assert(!validCitationKey('a b'));assert(!validCitationKey('a,b'));assert(!validCitationKey('a{b'));
});

test('cited keys cover natbib, biblatex multicite and \\nocite, ignoring comments',()=>{
  const keys=citedKeys(String.raw`\cite{a, b}\citep[p.~3]{c}\textcite[see][12]{d}\parencites(pre)(post)[1]{e}[2]{f}\nocite{g}% \cite{h}
\autocite*{i}\Citet{j}\footcite{k}\nocite{*}`);
  assert.deepEqual([...keys].sort(),['a','b','c','d','e','f','g','i','j','k']);
});

test('fingerprints ignore layout and field order; key replacement keeps the rest byte for byte',()=>{
  const a='@article{x,\n  title = {T},\n  year = {2020},\n}',b='@article{x, year={2020},   title={T}}';
  assert.equal(entryFingerprint(a),entryFingerprint(b));
  assert.notEqual(entryFingerprint(a),entryFingerprint(a.replace('{T}','{U}')));
  assert.equal(entryFingerprint(a,{withKey:false}),entryFingerprint(withCitationKey(a,'y'),{withKey:false}));
  assert.equal(withCitationKey(a,'smith2020'),a.replace('{x,','{smith2020,'));
  assert.throws(()=>withCitationKey(a,'bad key'));
  assert.deepEqual(fieldChanges(a,'@article{x, title={U}, year={2020}, doi={10/1}}'),[{field:'title',before:'{T}',after:'{U}'},{field:'doi',before:null,after:'{10/1}'}]);
});

// ---- Merge and key stability ----
const item=(key,zoteroKey,version,fields)=>({itemKey:key,version,zoteroKey,raw:`@article{${zoteroKey},\n\ttitle = {${fields.title}},\n\tauthor = {${fields.author||'Doe, Jane'}},\n\tdate = {${fields.year||2020}},\n}`});
function linked(entries){const {text,items}=composeLinkedFile(entries,'My Library');return {text,items};}
function refresh({items,text,remote,cited=new Map(),choices,edited=true}){
  const present=new Set(remote.map(entry=>entry.itemKey)),fetched=new Map(remote.filter(entry=>!items[entry.itemKey]||entry.version>items[entry.itemKey].version).map(entry=>[entry.itemKey,entry]));
  const plan=planRefresh({items,text,present,fetched,cited,edited});
  const applied=applyRefresh(text,plan,choices,{cited});
  // Edits are valid against the original text and reproduce the result.
  let at=0,result='';for(const edit of [...applied.edits].sort((a,b)=>a.start-b.start)){assert(edit.start>=at,'edits overlap');assert.equal(text.slice(edit.start,edit.end),edit.before);result+=text.slice(at,edit.start)+edit.after;at=edit.end;}result+=text.slice(at);
  assert.equal(result,applied.text);
  return {plan,...applied};
}
const A=item('AAAAAAAA','doe_alpha_2020',2,{title:'Alpha'}),B=item('BBBBBBBB','roe_beta_2021',3,{title:'Beta',author:'Roe, Rick',year:2021}),C=item('CCCCCCCC','poe_gamma_2019',4,{title:'Gamma',author:'Poe, Pat',year:2019});

test('first link writes every entry with Zotero keys, sorted, behind a header',()=>{
  const {text,items}=linked([B,A]);
  assert.match(text,/^% Linked to Zotero: My Library\./);
  assert.deepEqual(readBibliography(text).entries.map(entry=>entry.key),['doe_alpha_2020','roe_beta_2021']);
  assert.deepEqual(items.AAAAAAAA,{key:'doe_alpha_2020',zoteroKey:'doe_alpha_2020',entry:A.raw,version:2});
  // Two items with the same generated key are disambiguated the way Zotero does.
  const twin=item('DDDDDDDD','doe_alpha_2020',5,{title:'Alpha'});
  assert.deepEqual(readBibliography(linked([A,twin]).text).entries.map(entry=>entry.key),['doe_alpha_2020','doe_alpha_2020a']);
});

test('refresh without local edits applies added, changed and removed entries, and is repeatable',()=>{
  const start=linked([A,B]);
  const changedA={...A,version:7,raw:A.raw.replace('Alpha','Alpha, revised')};
  const r=refresh({...start,remote:[changedA,C],edited:false});
  assert.equal(r.plan.review,false);
  assert.deepEqual(r.plan.changes.map(change=>[change.kind,change.key,change.choice]),[['changed','doe_alpha_2020','zotero'],['added','poe_gamma_2019','zotero'],['removed','roe_beta_2021','zotero']]);
  const keys=readBibliography(r.text).entries.map(entry=>entry.key);
  assert.deepEqual(keys,['doe_alpha_2020','poe_gamma_2019']);
  assert.match(r.text,/Alpha, revised/);
  assert.match(r.text,/^% Linked to Zotero/);
  // The same Zotero state again: nothing to do.
  const again=planRefresh({items:r.items,text:r.text,present:new Set([A.itemKey,C.itemKey]),fetched:new Map([[A.itemKey,changedA],[C.itemKey,C]]),edited:false});
  assert.deepEqual(again.changes,[]);
});

test('a local edit and a Zotero change to the same entry is a conflict that defaults to keeping the file',()=>{
  const start=linked([A,B]);
  const text=start.text.replace('title = {Alpha}','title = {Alpha (my wording)}');
  const changedA={...A,version:7,raw:A.raw.replace('Alpha','Alpha in Zotero')},changedB={...B,version:8,raw:B.raw.replace('Beta','Beta 2')};
  const kept=refresh({items:start.items,text,remote:[changedA,changedB]});
  assert.equal(kept.plan.review,true);
  const conflict=kept.plan.changes.find(change=>change.key==='doe_alpha_2020');
  assert.equal(conflict.conflict,true);assert.equal(conflict.choice,'local');
  assert.deepEqual(conflict.fields,[{field:'title',before:'{Alpha (my wording)}',after:'{Alpha in Zotero}'}]);
  assert.match(kept.text,/Alpha \(my wording\)/);assert.match(kept.text,/Beta 2/);
  // Kept local: the same Zotero change is not offered again, the local edit stays.
  const next=planRefresh({items:kept.items,text:kept.text,present:new Set([A.itemKey,B.itemKey]),fetched:new Map(),edited:true});
  assert.deepEqual(next.changes,[]);
  // Choosing Zotero replaces only that entry.
  const taken=refresh({items:start.items,text,remote:[changedA,changedB],choices:{[conflict.id]:'zotero'}});
  assert.match(taken.text,/Alpha in Zotero/);assert.doesNotMatch(taken.text,/my wording/);
});

test('entries added by hand and text around entries are never touched',()=>{
  const start=linked([A]);
  const text=start.text+'\n% my note\n@misc{mine, title={Hand made}}\n';
  const r=refresh({items:start.items,text,remote:[{...A,version:9,raw:A.raw.replace('Alpha','Alpha 2')},B]});
  assert.match(r.text,/% my note\n@misc\{mine, title=\{Hand made\}\}/);
  assert.deepEqual(r.plan.untracked,['mine']);
  assert.deepEqual(readBibliography(r.text).entries.map(entry=>entry.key),['doe_alpha_2020','mine','roe_beta_2021']);
});

test('a key cited in the source stays when Zotero’s generated key changes; an uncited one follows Zotero',()=>{
  const start=linked([A,B]);
  const renamedA={...A,version:9,zoteroKey:'doe_omega_2020',raw:A.raw.replace('doe_alpha_2020','doe_omega_2020').replace('Alpha','Omega')};
  const renamedB={...B,version:9,zoteroKey:'roe_delta_2021',raw:B.raw.replace('roe_beta_2021','roe_delta_2021').replace('Beta','Delta')};
  const cited=new Map([['doe_alpha_2020',['main.tex']]]);
  const r=refresh({...start,remote:[renamedA,renamedB],cited,edited:false});
  const a=r.plan.changes.find(change=>change.itemKey==='AAAAAAAA'),b=r.plan.changes.find(change=>change.itemKey==='BBBBBBBB');
  assert.equal(a.key,'doe_alpha_2020');assert.match(a.note,/stays “doe_alpha_2020” because it is cited in main.tex/);
  assert.equal(b.key,'roe_delta_2021');assert.match(b.note,/nothing cites “roe_beta_2021”/);
  assert.deepEqual(readBibliography(r.text).entries.map(entry=>entry.key),['doe_alpha_2020','roe_delta_2021']);
  assert.match(r.text,/@article\{doe_alpha_2020,\n\ttitle = \{Omega\}/);
  assert.equal(r.items.AAAAAAAA.zoteroKey,'doe_omega_2020');assert.equal(r.items.AAAAAAAA.key,'doe_alpha_2020');
  // Later refreshes keep the stable key without asking again.
  const later=planRefresh({items:r.items,text:r.text,present:new Set(['AAAAAAAA','BBBBBBBB']),fetched:new Map([['AAAAAAAA',{...renamedA,version:10}]]),cited,edited:false});
  assert.deepEqual(later.changes,[]);
});

test('a key the person renamed locally is kept and still tracked by item key',()=>{
  const start=linked([A]);
  const text=start.text.replace('@article{doe_alpha_2020,','@article{Doe2020,');
  const r=refresh({items:start.items,text,remote:[{...A,version:9,raw:A.raw.replace('Alpha','Alpha 3')}]});
  const change=r.plan.changes[0];
  assert.equal(change.key,'Doe2020');assert.equal(change.local,'edited');assert.equal(change.conflict,true);
  const taken=refresh({items:start.items,text,remote:[{...A,version:9,raw:A.raw.replace('Alpha','Alpha 3')}],choices:{[change.id]:'zotero'}});
  assert.match(taken.text,/@article\{Doe2020,\n\ttitle = \{Alpha 3\}/);
  assert.equal(taken.items.AAAAAAAA.key,'Doe2020');
});

test('removing a cited entry is flagged, defaults to keeping it, and reports the lost key when removed',()=>{
  const start=linked([A,B]);
  const cited=new Map([['roe_beta_2021',['chapters/one.tex']]]);
  const r=refresh({...start,remote:[A],cited,edited:false});
  const removal=r.plan.changes[0];
  assert.equal(r.plan.review,true);assert.deepEqual(removal.cited,['chapters/one.tex']);assert.equal(removal.choice,'local');
  assert.match(r.text,/roe_beta_2021/);assert.deepEqual(r.lost,[]);
  const gone=refresh({...start,remote:[A],cited,edited:false,choices:{[removal.id]:'zotero'}});
  assert.doesNotMatch(gone.text,/roe_beta_2021/);assert.deepEqual(gone.lost,['roe_beta_2021']);
  // A key another .bib file still defines is not lost.
  const plan=planRefresh({items:start.items,text:start.text,present:new Set([A.itemKey]),fetched:new Map(),cited,elsewhere:new Set(['roe_beta_2021'])});
  assert.deepEqual(plan.changes[0].cited,[]);
});

test('a Zotero change to an entry deleted here, and a key collision with a hand-made entry',()=>{
  const start=linked([A,B]);
  const entryA=readBibliography(start.text).entries.find(entry=>entry.key==='doe_alpha_2020');
  const text=start.text.slice(0,entryA.start)+start.text.slice(entryA.end)+'@misc{poe_gamma_2019, title={Mine first}}\n';
  const r=refresh({items:start.items,text,remote:[{...A,version:9,raw:A.raw.replace('Alpha','Alpha 4')},B,C]});
  const deleted=r.plan.changes.find(change=>change.itemKey==='AAAAAAAA'),added=r.plan.changes.find(change=>change.itemKey==='CCCCCCCC');
  assert.equal(deleted.local,'deleted');assert.equal(deleted.choice,'local');
  assert.equal(added.key,'poe_gamma_2019a');assert.match(added.note,/already used/);
  assert.doesNotMatch(r.text,/Alpha 4/);assert.match(r.text,/@article\{poe_gamma_2019a,/);
});

test('notes and attachments have no export and are skipped; item keys must look like Zotero keys',()=>{
  assert.equal(remoteEntry({key:'ABCD1234',version:3,biblatex:''},'biblatex'),null);
  assert.equal(remoteEntry({key:'bad',version:3,biblatex:'@misc{x, title={y}}'},'biblatex'),null);
  assert.deepEqual(remoteEntry({key:'ABCD1234',version:3,biblatex:'\n@misc{x,\n\ttitle = {y},\n}\n'},'biblatex'),{itemKey:'ABCD1234',version:3,raw:'@misc{x,\n\ttitle = {y},\n}',zoteroKey:'x'});
});

// ---- Web API client against the fake server over real HTTP ----
const KEY='AbCdEfGhIjKlMnOpQrStUvWx',WRITE_KEY='WrItEkEyWrItEkEyWrItEkEy';
async function server(){
  const fake=fakeZotero();
  fake.addUser({id:4242,username:'ada'}).addGroup({id:777,name:'Lab',members:[4242]}).addGroup({id:888,name:'Other',members:[1]});
  fake.addKey(KEY,{userId:4242,access:{user:{library:true,files:false,notes:false,write:false},groups:{all:{library:true,write:false}}}});
  fake.addKey(WRITE_KEY,{userId:4242,access:{user:{library:true,write:true}}});
  const listening=await fake.listen(0);
  const calls=[];
  const fetcher=(url,options)=>{calls.push({url,options});assert(url.startsWith(ZOTERO_ORIGIN+'/'),url);return fetch(url.replace(ZOTERO_ORIGIN,`http://127.0.0.1:${listening.port}`),options);};
  return {fake,calls,fetcher,close:listening.close};
}

test('the client sends only documented headers to api.zotero.org and reads the key, groups and collections',async()=>{
  const {fake,calls,fetcher,close}=await server();
  try{
    for(let i=0;i<130;i++)fake.collection('users/4242',{key:`COL${String(i).padStart(5,'0')}`,name:`Collection ${i}`,parent:i>0&&i<3?'COL00000':false});
    const client=zoteroApi({apiKey:KEY,fetcher});
    const account=await client.currentKey();
    assert.deepEqual(account,{userId:'4242',username:'ada',access:{library:true,groups:{all:{library:true,write:false}}},write:false});
    assert.equal((await zoteroApi({apiKey:WRITE_KEY,fetcher}).currentKey()).write,true);
    assert.deepEqual(await client.groups('4242'),[{id:'777',name:'Lab'}]);
    const collections=await client.collections({type:'user',id:'4242'});
    assert.equal(collections.length,130);assert(collections.some(collection=>collection.path==='Collection 0 › Collection 1'));
    for(const {options} of calls){
      assert.deepEqual(Object.keys(options.headers).sort(),['Zotero-API-Key','Zotero-API-Version']);
      assert.equal(options.headers['Zotero-API-Version'],'3');assert.equal(options.credentials,'omit');assert.equal(options.referrerPolicy,'no-referrer');assert.equal(options.cache,'no-store');assert.equal(options.redirect,'error');
    }
    // Collections came in two pages, following Link rel="next".
    assert.equal(calls.filter(call=>call.url.includes('/collections')).length,2);
    assert(fake.requests.every(request=>request.key===KEY||request.key===WRITE_KEY));
  }finally{await close();}
});

test('items are paged, versions are conditional, and itemKey requests stay within 50 keys',async()=>{
  const {fake,calls,fetcher,close}=await server();
  try{
    fake.collection('users/4242',{key:'THESIS01',name:'Thesis'});
    const changes=[];for(let i=0;i<130;i++)changes.push({key:`IT${String(i).padStart(6,'0')}`,collections:i<5?['THESIS01']:[],data:{itemType:'journalArticle',title:`Paper ${i}`,creators:[{creatorType:'author',lastName:'Doe',firstName:'J'}],date:'2020'}});
    changes.push({key:'NOTE0001',data:{itemType:'note',note:'x'}},{key:'ATTACH01',data:{itemType:'attachment',title:'PDF'}});
    fake.write('users/4242',changes);
    const client=zoteroApi({apiKey:KEY,fetcher}),library={type:'user',id:'4242'};
    const all=await client.items(library,null,'biblatex');
    assert.equal(all.version,fake.version('users/4242'));
    assert.equal(all.items.length,131,'attachments are filtered by itemType=-attachment; the note has no export');
    assert.equal(all.items.map(entry=>remoteEntry(entry,'biblatex')).filter(Boolean).length,130);
    assert.equal(calls.filter(call=>call.url.includes('/items/top')).length,2);
    assert(calls.some(call=>call.url.includes('start=100')));
    const thesis=await client.items(library,'THESIS01','bibtex');
    assert.equal(thesis.items.length,5);assert.match(thesis.items[0].bibtex,/@article\{doe_paper_2020,/);
    const same=await client.versions(library,null,all.version);
    assert.deepEqual(same,{notModified:true,version:all.version});
    const revised=fake.write('users/4242',[{key:'IT000001',data:{title:'Paper one, revised'}}]);fake.trash('users/4242','IT000002');
    const moved=await client.versions(library,null,all.version);
    assert.equal(moved.versions.size,130);assert(!moved.versions.has('IT000002'));assert.equal(moved.versions.get('IT000001'),revised);assert.equal(moved.version,fake.version('users/4242'));
    const keys=[...moved.versions.keys()].slice(0,120);
    const fetched=await client.itemsByKey(library,keys,'biblatex');
    assert.equal(fetched.length,120);
    assert(calls.filter(call=>call.url.includes('itemKey=')).every(call=>new URL(call.url).searchParams.get('itemKey').split(',').length<=50));
  }finally{await close();}
});

test('errors: rejected key, unreadable library, rate limits, offline and foreign pagination links',async()=>{
  const {fake,fetcher,close}=await server();
  try{
    await assert.rejects(zoteroApi({apiKey:'ZZZZZZZZZZZZZZZZZZZZZZZZ',fetcher}).currentKey(),error=>error.code==='forbidden'&&/refused this API key/.test(error.message));
    const client=zoteroApi({apiKey:KEY,fetcher});
    await assert.rejects(client.items({type:'group',id:'888'},null,'biblatex'),error=>error.code==='forbidden');
    await assert.rejects(client.items({type:'group',id:'999'},null,'biblatex'),error=>error.code==='not_found');
    await assert.rejects(client.items({type:'user',id:'4242'},'NOPE0000','biblatex'),error=>error.code==='not_found');
    fake.limitOnce(30);
    await assert.rejects(client.currentKey(),error=>error.code==='rate_limited'&&/30 s/.test(error.message));
    await assert.rejects(client.currentKey(),error=>error.code==='rate_limited'&&/wait/.test(error.message),'waits before asking again');
    const offline=zoteroApi({apiKey:KEY,fetcher,online:()=>false});
    await assert.rejects(offline.currentKey(),error=>error.code==='offline'&&/needs a network connection/.test(error.message));
    const unreachable=zoteroApi({apiKey:KEY,fetcher:()=>Promise.reject(new TypeError('Failed to fetch'))});
    await assert.rejects(unreachable.currentKey(),error=>error.code==='network'&&/could not reach api.zotero.org/.test(error.message));
    const foreign=zoteroApi({apiKey:KEY,fetcher:async()=>new Response('[]',{status:200,headers:{'Last-Modified-Version':'3',Link:'<https://evil.example/users/4242/items?start=25>; rel="next"'}})});
    await assert.rejects(foreign.collections({type:'user',id:'4242'}),error=>error instanceof ZoteroError&&/another host/.test(error.message));
    assert.throws(()=>zoteroApi({apiKey:'short'}),/24 letters and digits/);
    await assert.rejects(client.items({type:'user',id:'../x'},null,'biblatex'),/Choose a Zotero library/);
    await assert.rejects(client.items({type:'user',id:'4242'},null,'csljson'),/BibLaTeX or BibTeX/);
  }finally{await close();}
});

test('the fake answers CORS preflights like api.zotero.org and generates Zotero-style keys',async()=>{
  const fake=fakeZotero();
  const preflight=fake.handle({method:'OPTIONS',url:'/keys/current',headers:{Origin:'http://127.0.0.1:8301','Access-Control-Request-Headers':'zotero-api-key,zotero-api-version,if-modified-since-version'}});
  assert.equal(preflight.headers['Access-Control-Allow-Origin'],'*');
  for(const name of ['Zotero-API-Key','Zotero-API-Version','If-Modified-Since-Version'])assert.match(preflight.headers['Access-Control-Allow-Headers'],new RegExp(name));
  for(const name of ['Last-Modified-Version','Link','Total-Results','Retry-After','Backoff'])assert.match(preflight.headers['Access-Control-Expose-Headers'],new RegExp(name));
  assert.equal(zoteroCitationKey({title:'The Art of Computer Programming',creators:[{lastName:'Knuth'}],date:'1968'}),'knuth_art_1968');
  assert.equal(zoteroCitationKey({citationKey:'pinned2020',title:'x'}),'pinned2020');
  assert.equal(checkBibliography(exportItem({data:{itemType:'book',title:'A & B',creators:[{creatorType:'author',lastName:'Ng',firstName:'A'}],date:'2001'}},'biblatex')).errors,0);
  assert.equal(fake.handle({method:'GET',url:'/keys/current',headers:{'Zotero-API-Version':'2'}}).status,400);
});
