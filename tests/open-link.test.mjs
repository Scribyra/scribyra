// "Open in Scribyra" links: parsing and validation of the link format, generator input,
// import planning, main-file detection, ZIP safety and the provenance record.
import './helpers/core.mjs';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {zipSync,strToU8,deflateSync} from 'fflate';
import {parseOpenLink,formatOpenLink,parseRepositoryInput,sourcePage,sourceKey,defaultProjectName,OpenLinkError,OPEN_LINK_MAX_CHARS} from '../site/open-link-format.js';
import {planImport,projectEntries,detectMainFile,isRootDocument,readZipDirectory,extractZipEntry,zipEntries,isLfsPointer,lfsMatcher,importSourceRecord,validImportSource,ImportRefused,IMPORT_LIMITS} from '../web/open-link.js';
import {takeOpenFragment,rememberImport,existingImports} from '../web/open-link-dialog.js';

const APP='https://app.scribyra.com/';
test('version 1 links parse into a normalized description and format back to the same link',()=>{
 const cases=[
  ['#open?repo=github.com/octocat/Hello-World',{kind:'github',host:'github.com',repo:'octocat/Hello-World',ref:'',path:'',main:'',name:''}],
  ['#open?repo=https://github.com/octocat/Hello-World.git&ref=feature/x&path=paper/v2&main=src/main.tex&name=My%20paper',{kind:'github',repo:'octocat/Hello-World',ref:'feature/x',path:'paper/v2',main:'src/main.tex',name:'My paper'}],
  ['#open?v=1&repo=gitlab.com/group/sub/project&ref=v1.0',{kind:'gitlab',host:'gitlab.com',repo:'group/sub/project',ref:'v1.0'}],
  ['#open?repo=https://gitlab.example.org:8443/team/paper',{kind:'gitlab',host:'gitlab.example.org:8443',repo:'team/paper'}],
  ['#open?repo=github.com/o/r&ref=0123456789abcdef0123456789abcdef01234567',{ref:'0123456789abcdef0123456789abcdef01234567'}],
  ['#open?zip=https://files.example.org/p.zip%3Fdl%3D1%26x%3D2&main=paper.tex&path=src',{kind:'zip',host:'files.example.org',url:'https://files.example.org/p.zip?dl=1&x=2',main:'paper.tex',path:'src'}],
 ];
 for(const [fragment,expected]of cases){
  const link=parseOpenLink(fragment);
  for(const [key,value]of Object.entries(expected))assert.equal(link[key],value,`${fragment} ${key}`);
  assert.equal(link.version,1);
  const formatted=formatOpenLink(link,APP);
  assert.ok(formatted.startsWith(APP+'#open?'));
  assert.deepEqual(parseOpenLink(new URL(formatted).hash),link,formatted);
 }
 assert.equal(formatOpenLink(parseOpenLink('#open?repo=github.com/o/r&path=a/b&name=A%20%26%20B%20%23%201'),APP),`${APP}#open?repo=github.com/o/r&path=a/b&name=A%20%26%20B%20%23%201`);
 assert.equal(formatOpenLink({kind:'gitlab',host:'git.example.org',repo:'a/b'},'https://scribyra-aca39a.gitlab.io/app/'),'https://scribyra-aca39a.gitlab.io/app/#open?repo=https://git.example.org/a/b');
});
test('invalid, ambiguous or hostile links are refused with a message for people',()=>{
 const bad={
  '#open':/either a repository/,'#open?':/either a repository/,'#opened?repo=github.com/o/r':/not an Open in Scribyra link/,
  '#open?repo=github.com/o/r&zip=https://a.org/x.zip':/either/,'#open?repo=github.com/o/r&repo=github.com/o/s':/twice/,
  '#open?repo=github.com/o/r&compile=1':/does not know/,'#open?repo=github.com/o/r&v=2':/newer version/,
  '#open?repo=http://github.com/o/r':/https/,'#open?repo=javascript:alert(1)':/https/,'#open?repo=github.com/o':/OWNER\/REPO/,
  '#open?repo=github.com/o/r/tree/main':/OWNER\/REPO/,'#open?repo=github.com/o/..':/OWNER\/REPO/,'#open?repo=github.com/o/r%252F..':/escaped/,'#open?repo=github.com/o/r%2F..':/OWNER\/REPO/,
  '#open?repo=https://user:pw@github.com/o/r':/user name|valid host/,'#open?repo=https://127.0.0.1/a/b':/IP address/,'#open?repo=https://[::1]/a/b':/valid host/,
  '#open?repo=https://localhost/a/b':/valid host|local/,'#open?repo=https://git.local/a/b':/local or private/,'#open?repo=https://nas.home.arpa/a/b':/local or private/,
  '#open?repo=gitlab.com/a/-/b':/GROUP/,'#open?repo=gitlab.com/onlyone':/GROUP/,
  '#open?repo=github.com/o/r&ref=a..b':/branch/,'#open?repo=github.com/o/r&ref=-x':/branch/,'#open?repo=github.com/o/r&ref=a%20b':/branch/,'#open?repo=github.com/o/r&ref=x.lock':/branch/,'#open?repo=github.com/o/r&ref=a~1':/branch/,
  '#open?repo=github.com/o/r&path=../x':/safe relative/,'#open?repo=github.com/o/r&path=a//b':/safe relative/,'#open?repo=github.com/o/r&path=a\\b':/safe relative/,'#open?repo=github.com/o/r&path=C:/x':/safe relative/,
  '#open?repo=github.com/o/r&main=paper.pdf':/\.tex/,'#open?repo=github.com/o/r&main=../main.tex':/safe relative/,'#open?repo=github.com/o/r&path=a%E2%80%AEb':/safe relative/,
  '#open?repo=github.com/o/r&name=%E2%80%AEevil':/project name/,['#open?repo=github.com/o/r&name='+'x'.repeat(161)]:/project name/,
  '#open?zip=http://a.org/x.zip':/https/,'#open?zip=https://u:p@a.org/x.zip':/user name/,'#open?zip=https://10.0.0.1/x.zip':/IP address/,'#open?zip=not a url':/valid URL/,'#open?zip=https://a.org/x.zip&ref=main':/ref=/,
 };
 for(const [fragment,pattern]of Object.entries(bad))assert.throws(()=>parseOpenLink(fragment),error=>error instanceof OpenLinkError&&pattern.test(error.message),fragment);
 assert.throws(()=>parseOpenLink('#open?repo=github.com/o/r&name='+'x'.repeat(OPEN_LINK_MAX_CHARS)),/too long/);
});
test('the address bar fragment is consumed once and errors are reported, not thrown',()=>{
 const replaced=[],browser={location:{pathname:'/',search:'',hash:'#open?repo=github.com/o/r'},history:{replaceState:(...args)=>replaced.push(args)}};
 assert.equal(takeOpenFragment(browser).link.repo,'o/r');assert.deepEqual(replaced,[[null,'','/']]);
 browser.location.hash='#open?repo=nope';assert.match(takeOpenFragment(browser).error,/host\/owner\/name/);
 browser.location.hash='#tex=abc';assert.equal(takeOpenFragment(browser),null);assert.equal(replaced.length,2);
 browser.location.hash='#open?'+'a'.repeat(OPEN_LINK_MAX_CHARS+10);assert.match(takeOpenFragment(browser).error,/too long/);
});
test('the generator reads repository pages, clone addresses, archives and existing links',()=>{
 const read=value=>{const {kind,host,repo,url,ref,path,main}=parseRepositoryInput(value);return {kind,host,repo,url,ref,path,main};};
 assert.deepEqual(read('https://github.com/octocat/Hello-World'),{kind:'github',host:'github.com',repo:'octocat/Hello-World',url:'',ref:'',path:'',main:''});
 assert.deepEqual(read('github.com/octocat/Hello-World/tree/dev/docs/paper'),{kind:'github',host:'github.com',repo:'octocat/Hello-World',url:'',ref:'dev',path:'docs/paper',main:''});
 assert.deepEqual(read('https://github.com/o/r/blob/v2/paper/thesis.tex'),{kind:'github',host:'github.com',repo:'o/r',url:'',ref:'v2',path:'paper',main:'thesis.tex'});
 assert.deepEqual(read('https://www.github.com/o/r.git'),{kind:'github',host:'github.com',repo:'o/r',url:'',ref:'',path:'',main:''});
 assert.deepEqual(read('git@gitlab.com:group/sub/proj.git'),{kind:'gitlab',host:'gitlab.com',repo:'group/sub/proj',url:'',ref:'',path:'',main:''});
 assert.deepEqual(read('https://gitlab.example.org/team/paper/-/tree/main/src'),{kind:'gitlab',host:'gitlab.example.org',repo:'team/paper',url:'',ref:'main',path:'src',main:''});
 assert.deepEqual(read('https://files.example.org/paper.zip'),{kind:'zip',host:'files.example.org',repo:'',url:'https://files.example.org/paper.zip',ref:'',path:'',main:''});
 assert.equal(read('https://app.scribyra.com/#open?repo=github.com/a/b&ref=x').ref,'x');
 for(const value of ['','http://github.com/o/r','ftp://x.org/a/b','https://github.com/o','https://192.168.1.2/a/b'])assert.throws(()=>parseRepositoryInput(value),OpenLinkError,value);
});
test('source pages, keys and default names',()=>{
 assert.equal(sourcePage(parseOpenLink('#open?repo=github.com/o/r')),'https://github.com/o/r');
 assert.equal(sourcePage(parseOpenLink('#open?repo=github.com/o/r&ref=feat/x&path=a%20b/c')),'https://github.com/o/r/tree/feat/x/a%20b/c');
 assert.equal(sourcePage(parseOpenLink('#open?repo=gitlab.com/g/p&path=doc')),'https://gitlab.com/g/p/-/tree/HEAD/doc');
 assert.equal(sourceKey(parseOpenLink('#open?repo=github.com/Octo/Repo')),sourceKey(parseOpenLink('#open?repo=https://GitHub.com/octo/repo.git')));
 assert.notEqual(sourceKey(parseOpenLink('#open?repo=github.com/o/r')),sourceKey(parseOpenLink('#open?repo=github.com/o/r&ref=dev')));
 assert.equal(sourceKey(parseOpenLink('#open?repo=github.com/o/r&main=a.tex&name=X')),sourceKey(parseOpenLink('#open?repo=github.com/o/r')));
 assert.equal(defaultProjectName(parseOpenLink('#open?repo=github.com/o/thesis&path=chapters/final')),'thesis · final');
 assert.equal(defaultProjectName(parseOpenLink('#open?zip=https://a.org/dl/My%20Paper.zip')),'My Paper');
 assert.equal(defaultProjectName(parseOpenLink('#open?repo=github.com/o/r&name=Named')),'Named');
});
test('main-file detection prefers shallow root documents, main.tex and non-standalone classes',()=>{
 const doc=(cls='article')=>`\\documentclass[11pt]{${cls}}\n\\begin{document}x\\end{document}`;
 assert.equal(isRootDocument(doc()),true);
 assert.equal(isRootDocument('% \\documentclass{article}\n% \\begin{document}'),false);
 assert.equal(isRootDocument('\\section{Intro} text'),false);
 assert.equal(isRootDocument('50\\% done \\documentclass{article} \\begin{document}'),true);
 const files=entries=>Object.entries(entries).map(([path,content])=>({path,content}));
 assert.equal(detectMainFile(files({'chapters/one.tex':'\\chapter{One}','paper.tex':doc(),'figures/plot.tex':doc('standalone')})),'paper.tex');
 assert.equal(detectMainFile(files({'response.tex':doc(),'main.tex':doc()})),'main.tex');
 assert.equal(detectMainFile(files({'a/main.tex':doc(),'b.tex':doc()})),'b.tex');
 assert.equal(detectMainFile(files({'logo.tex':doc('standalone'),'paper/ms.tex':doc()})),'paper/ms.tex');
 assert.equal(detectMainFile(files({'notes.txt':doc(),'intro.tex':'text'})),'');
 assert.equal(detectMainFile([{path:'bin.tex',content:new Uint8Array([1])}]),'');
});
test('planning skips unsafe names, links, submodules and large files, and refuses impossible imports',()=>{
 const MiB=1024*1024;
 const plan=planImport([
  {path:'main.tex',size:100,kind:'file'},{path:'fig/a.png',size:20*MiB,kind:'file'},{path:'../escape.tex',size:1,kind:'file'},{path:'/abs.tex',size:1,kind:'file'},
  {path:'a\\b.tex',size:1,kind:'file'},{path:'.git/config',size:1,kind:'file'},{path:'sub/.git/HEAD',size:1,kind:'file'},{path:'.scribyra-sync/state.json',size:1,kind:'file'},
  {path:'link.tex',size:0,kind:'symlink'},{path:'vendor/lib',size:0,kind:'submodule'},{path:'data/big.bin',size:1,kind:'lfs'},{path:'x\u0000.tex',size:1,kind:'file'},
 ]);
 assert.deepEqual(plan.files.map(file=>file.path),['main.tex']);assert.equal(plan.bytes,100);
 const reasons=Object.fromEntries(plan.skipped.map(item=>[item.path,item.reason]));
 assert.deepEqual(reasons,{'fig/a.png':'large','../escape.tex':'unsafe','/abs.tex':'unsafe','a\\b.tex':'unsafe','.git/config':'private','sub/.git/HEAD':'private','.scribyra-sync/state.json':'private','link.tex':'symlink','vendor/lib':'submodule','data/big.bin':'lfs','x\u0000.tex':'unsafe'});
 // Over the project bound: the largest binaries go first, sources stay.
 const big=planImport([{path:'main.tex',size:MiB,kind:'file'},...Array.from({length:6},(_,i)=>({path:`img/${i}.png`,size:(11+i)*MiB,kind:'file'}))]);
 assert.ok(big.bytes<=IMPORT_LIMITS.bytes);assert.ok(big.files.some(file=>file.path==='main.tex'));
 assert.deepEqual(big.skipped.map(item=>[item.path,item.reason]),[['img/5.png','total'],['img/4.png','total']]);
 assert.throws(()=>planImport(Array.from({length:6},(_,i)=>({path:`${i}.tex`,size:15*MiB,kind:'file'}))),ImportRefused);
 assert.throws(()=>planImport(Array.from({length:513},(_,i)=>({path:`${i}.tex`,size:1,kind:'file'}))),/at most 512/);
 assert.throws(()=>planImport([{path:'a.tex',size:1,kind:'file'},{path:'A.tex',size:1,kind:'file'}]),/more than once/);
 assert.throws(()=>planImport([{path:'a.tex',size:-1,kind:'file'}]),/invalid file size/);
 assert.throws(()=>planImport([{path:'l',size:0,kind:'symlink'}]),/no files/);
 assert.throws(()=>planImport(Array.from({length:IMPORT_LIMITS.listedEntries+1},(_,i)=>({path:`${i}`,size:0,kind:'submodule'}))),/entries/);
});
test('downloaded bytes become entries; LFS pointers and invalid UTF-8 text are reported, never imported',()=>{
 const pointer=strToU8('version https://git-lfs.github.com/spec/v1\noid sha256:'+'a'.repeat(64)+'\nsize 123456\n');
 assert.equal(isLfsPointer(pointer),true);assert.equal(isLfsPointer(strToU8('version 2')),false);
 const {entries,skipped}=projectEntries([{path:'main.tex',bytes:strToU8('\uFEFFcafé')},{path:'fig.png',bytes:new Uint8Array([137,80,78,71])},{path:'data.pdf',bytes:pointer},{path:'latin1.tex',bytes:new Uint8Array([0x63,0x61,0x66,0xe9])}]);
 assert.deepEqual(entries.map(entry=>[entry.path,typeof entry.content]),[['main.tex','string'],['fig.png','object']]);
 assert.equal(entries[0].content,'café');
 assert.deepEqual(skipped,[{path:'data.pdf',reason:'lfs'},{path:'latin1.tex',reason:'encoding'}]);
 const lfs=lfsMatcher('# comment\n*.pdf filter=lfs diff=lfs merge=lfs -text\nimages/** filter=lfs\nkeep.pdf -filter\n/root.bin filter=lfs\ndocs/*.png filter=lfs\n');
 assert.deepEqual(['a.pdf','x/y.pdf','keep.pdf','images/a/b.jpg','root.bin','x/root.bin','docs/a.png','docs/x/a.png','main.tex'].map(path=>lfs(path)),[true,true,false,true,true,false,true,false,false]);
});
const zip=files=>zipSync(Object.fromEntries(Object.entries(files).map(([path,text])=>[path,typeof text==='string'?strToU8(text):text])));
/** Rewrites names and attributes in a real archive, as a hostile archive would have them. */
function forge(bytes,{rename={},symlink=[],size={}}={}){
 const out=[],view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
 // Rebuild with equal-length names so offsets stay valid.
 const copy=bytes.slice(),v=new DataView(copy.buffer);
 for(let i=0;i+4<=copy.length;i++){
  const sig=view.getUint32(i,true);
  if(sig!==0x02014b50&&sig!==0x04034b50)continue;
  const central=sig===0x02014b50,nameAt=i+(central?46:30),length=view.getUint16(i+(central?28:26),true);
  const name=new TextDecoder().decode(bytes.subarray(nameAt,nameAt+length));
  if(rename[name]!==undefined){const next=strToU8(rename[name]);assert.equal(next.length,length,'forged names keep their length');copy.set(next,nameAt);}
  const effective=rename[name]??name;
  if(central&&symlink.includes(effective)){v.setUint16(i+4,(3<<8)|20,true);v.setUint32(i+38,(0o120777<<16)>>>0,true);}
  if(size[effective]!==undefined){v.setUint32(i+(central?24:22),size[effective],true);}
 }
 out.push(copy);return copy;
}
test('ZIP reading strips one wrapping folder, honours a subfolder and refuses traversal, links and bombs',()=>{
 const archive=zip({'repo-main-abc/main.tex':'\\documentclass{article}\\begin{document}x\\end{document}','repo-main-abc/doc/a.tex':'a','repo-main-abc/doc/img.png':new Uint8Array([1,2,3])});
 const directory=readZipDirectory(archive);
 assert.deepEqual(zipEntries(directory).map(entry=>entry.path).sort(),['doc/a.tex','doc/img.png','main.tex']);
 assert.deepEqual(zipEntries(directory,'doc').map(entry=>entry.path).sort(),['a.tex','img.png']);
 const entry=zipEntries(directory,'doc').find(item=>item.path==='img.png');assert.deepEqual([...extractZipEntry(archive,entry.zip)],[1,2,3]);
 // Hostile names: traversal, absolute, backslash, drive letter, and a symbolic link.
 const hostile=forge(zip({'aa/evil.tex':'x','bbbbbbb.tex':'y','cc\\d.tex':'z','e:.tex':'w','ok.tex':'fine','link.tex':'/etc/passwd'}),{rename:{'aa/evil.tex':'../evil.tex','bbbbbbb.tex':'/abcdef.tex'},symlink:['link.tex']});
 const plan=planImport(zipEntries(readZipDirectory(hostile)));
 assert.deepEqual(plan.files.map(file=>file.path),['ok.tex']);
 assert.deepEqual(Object.fromEntries(plan.skipped.map(item=>[item.path,item.reason])),{'../evil.tex':'unsafe','/abcdef.tex':'unsafe','cc\\d.tex':'unsafe','e:.tex':'unsafe','link.tex':'symlink'});
 // A bomb: an entry that inflates past its declared size is refused while inflating.
 const bomb=forge(zip({'bomb.tex':'0'.repeat(5*1024*1024)}),{size:{'bomb.tex':1000}});
 const bombEntry=zipEntries(readZipDirectory(bomb))[0];assert.equal(bombEntry.size,1000);
 assert.throws(()=>extractZipEntry(bomb,bombEntry.zip),/expands beyond its declared size/);
 // Declared sizes beyond the project bound are skipped before anything is inflated.
 const huge=forge(zip({'a.bin':new Uint8Array(10),'main.tex':'x'}),{size:{'a.bin':0x7fffffff}});
 const hugePlan=planImport(zipEntries(readZipDirectory(huge)));assert.deepEqual(hugePlan.skipped,[{path:'a.bin',reason:'large',size:0x7fffffff}]);
 // Duplicate names, damaged or foreign data, and non-UTF-8 names.
 assert.throws(()=>zipEntries(readZipDirectory(forge(zip({'a.tex':'1','b.tex':'2'}),{rename:{'b.tex':'a.tex'}}))),/same name twice/);
 assert.throws(()=>readZipDirectory(strToU8('not a zip')),/not a ZIP/);
 assert.throws(()=>readZipDirectory(archive.slice(0,archive.length-30)),ImportRefused);
 const latin=zip({'xx.tex':'1'});latin.set([0x63,0xe9],latin.indexOf(0x78,latin.length-60));
 assert.ok(zipEntries(readZipDirectory(latin)).some(item=>item.kind==='unsafe'));
 const deflated=deflateSync(strToU8('hello'));assert.ok(deflated.length>0);
});
test('the provenance record is closed, public and validated',()=>{
 const link=parseOpenLink('#open?repo=github.com/o/r&ref=main&path=p');
 const record=importSourceRecord(link,{commit:'a'.repeat(40),importedAt:1,main:'main.tex'});
 assert.deepEqual(record,{version:1,kind:'github',host:'github.com',repo:'o/r',url:'',ref:'main',commit:'a'.repeat(40),path:'p',main:'main.tex',archiveSha256:'',importedAt:1});
 assert.equal(validImportSource(record),true);
 for(const broken of [{...record,token:'x'},{...record,commit:'zz'},{...record,kind:'svn'},{...record,url:'https://x'},{...record,host:'evil host'},null,[],{...record,version:2}])assert.equal(validImportSource(broken),false);
 const zipRecord=importSourceRecord(parseOpenLink('#open?zip=https://a.org/x.zip'),{archiveSha256:'b'.repeat(64),importedAt:2});
 assert.equal(validImportSource(zipRecord),true);assert.equal(validImportSource({...zipRecord,url:'javascript:alert(1)'}),false);
});
test('the device index finds earlier copies that still exist',()=>{
 const values=new Map(),storage={getItem:key=>values.get(key)??null,setItem:(key,value)=>values.set(key,value)};
 rememberImport(storage,'k','p1',10);rememberImport(storage,'k','p2',20);rememberImport(storage,'k','p1',30);
 assert.deepEqual(existingImports(storage,'k',[{id:'p1',name:'One'},{id:'p3',name:'Other'}]).map(item=>[item.id,item.importedAt]),[['p1',30]]);
 assert.deepEqual(existingImports(storage,'other',[{id:'p1'}]),[]);
 values.set('scribyra:open-links:v1','not json');assert.deepEqual(existingImports(storage,'k',[{id:'p1'}]),[]);
 assert.doesNotThrow(()=>rememberImport({getItem:()=>{throw new Error('blocked');},setItem:()=>{throw new Error('blocked');}},'k','p',1));
});
