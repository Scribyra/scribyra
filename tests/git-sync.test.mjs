// The GitHub and GitLab plugin's pure parts (docs/git-sync.md): line diffs and three-way
// merges (web/line-diff.js), Git blob ids, path validation for remote trees, exclusions,
// secret detection and the pull/push plans. Browser behaviour is in
// tests/browser/git-sync.spec.js.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {splitLines,diffLines,displayDiff,editHunks,merge3} from '../web/line-diff.js';
import {sha1Hex,gitBlobId} from '../plugins/github-gitlab/src/sha1.js';
import {pathProblem,normalSubfolder,toProjectPath,toRepoPath,ignoreMatcher,secretProblem,validBranch,isLfsPointer,decodeText} from '../plugins/github-gitlab/src/paths.js';
import {remoteFiles,planPull,planPush,recordsAfterPull,recordsAfterPush,recordsAtLink,localState,remoteState} from '../plugins/github-gitlab/src/sync.js';
import {normalRepository,base64} from '../plugins/github-gitlab/src/hosts.js';

const apply=(text,edits)=>{let out=text;for(const edit of [...edits].reverse())out=out.slice(0,edit.start)+edit.after+out.slice(edit.end);return out;};
// A small deterministic generator, so a failing case can be replayed.
function random(seed){let x=seed>>>0||1;return ()=>{x^=x<<13;x>>>=0;x^=x>>>17;x^=x<<5;x>>>=0;return x/0x100000000;};}
const lines=(next,count)=>Array.from({length:Math.floor(next()*count)},()=>'abcde'[Math.floor(next()*5)]+'\n').join('');

test('lines keep their endings, so joining them gives the text back exactly',()=>{
  for(const text of ['','a','a\n','a\nb','a\r\nb\r\n','\n\n','x\ny\n\nz'])assert.equal(splitLines(text).join(''),text);
  assert.deepEqual(splitLines('a\r\nb'),['a\r\n','b']);
});

test('line diffs: minimal hunks, and edits that turn one text into the other',()=>{
  assert.deepEqual(diffLines(['a\n','b\n','c\n'],['a\n','B\n','c\n']),[{aStart:1,aEnd:2,bStart:1,bEnd:2}]);
  assert.deepEqual(diffLines(['a\n'],['a\n','b\n']),[{aStart:1,aEnd:1,bStart:1,bEnd:2}]);
  assert.deepEqual(diffLines([],[]),[]);
  const next=random(7);
  for(let i=0;i<3000;i++){const a=lines(next,14),b=lines(next,14);assert.equal(apply(a,editHunks(a,b)),b,JSON.stringify([a,b]));}
  // Each edit says what it replaces, so the host can check the text did not move.
  for(const edit of editHunks('one\ntwo\nthree\n','one\n2\nthree\nfour\n'))assert.equal('one\ntwo\nthree\n'.slice(edit.start,edit.end),edit.before);
});

test('display diffs show context, added and removed lines with numbers, and bound their size',()=>{
  const before=Array.from({length:30},(_,i)=>`line ${i+1}\n`).join(''),after=before.replace('line 15\n','line fifteen\n');
  const diff=displayDiff(before,after);
  assert.deepEqual(diff.lines.map(line=>line.kind),['gap','context','context','context','removed','added','context','context','context','gap']);
  assert.deepEqual(diff.lines.find(line=>line.kind==='removed'),{kind:'removed',text:'line 15',old:15,new:null});
  assert.deepEqual(diff.lines.find(line=>line.kind==='added'),{kind:'added',text:'line fifteen',old:null,new:15});
  assert.equal(diff.lines[0].text,'11 unchanged lines');assert.equal(diff.added,1);assert.equal(diff.removed,1);
  const big=displayDiff('',Array.from({length:900},(_,i)=>`${i}\n`).join(''),{limit:100});
  assert.equal(big.lines.length,100);assert.ok(big.truncated);assert.equal(big.added,900);
  assert.deepEqual(displayDiff('same\n','same\n').lines,[]);
});

test('three-way merge: one-sided and identical changes merge, overlapping ones conflict with markers',()=>{
  const base='a\nb\nc\nd\ne\n';
  assert.deepEqual(merge3(base,'a\nB\nc\nd\ne\n','a\nb\nc\nD\ne\n'),{clean:true,conflicts:0,text:'a\nB\nc\nD\ne\n'});
  assert.equal(merge3(base,'a\nB\nc\nd\ne\n','a\nB\nc\nd\ne\nf\n').text,'a\nB\nc\nd\ne\nf\n');
  assert.equal(merge3(base,base,'x\n').text,'x\n');
  assert.equal(merge3(base,'','').text,'');
  const conflict=merge3(base,'a\nmine\nc\nd\ne\n','a\ntheirs\nc\nd\ne\n');
  assert.equal(conflict.clean,false);assert.equal(conflict.conflicts,1);
  assert.equal(conflict.text,'a\n<<<<<<< mine\nmine\n||||||| base\nb\n=======\ntheirs\n>>>>>>> theirs\nc\nd\ne\n');
  // Changes to neighbouring lines conflict, as in Git.
  assert.equal(merge3(base,'a\nB\nc\nd\ne\n','a\nb\nC\nd\ne\n').clean,false);
  // A missing final newline is completed inside the markers, so they stay on their own lines.
  assert.equal(merge3('x','y','z').text,'<<<<<<< mine\ny\n||||||| base\nx\n=======\nz\n>>>>>>> theirs\n');
  assert.equal(merge3('a\r\nb\r\nc\r\n','a\r\nb\r\nC\r\n','A\r\nb\r\nc\r\n').text,'A\r\nb\r\nC\r\n');
  const labelled=merge3('x\n','y\n','z\n',{labels:{mine:'mine (here)',base:'last sync',theirs:'GitHub'}}).text;
  assert.match(labelled,/^<<<<<<< mine \(here\)\n/);assert.match(labelled,/>>>>>>> GitHub\n$/);
  // Properties: either side unchanged gives the other; both the same gives it.
  const next=random(42);
  for(let i=0;i<2000;i++){
    const o=lines(next,10),a=lines(next,10),b=lines(next,10);
    assert.equal(merge3(o,o,b).text,b);assert.equal(merge3(o,a,o).text,a);assert.deepEqual(merge3(o,a,a),{clean:true,conflicts:0,text:a});
    const merged=merge3(o,a,b);if(merged.clean)assert.doesNotMatch(merged.text,/<<<<<<<|>>>>>>>/);else assert.match(merged.text,/<<<<<<< mine\n/);
  }
});

test('Git blob ids match Git (SHA-1 of "blob <size>\\0" + content)',()=>{
  assert.equal(sha1Hex(new TextEncoder().encode('abc')),'a9993e364706816aba3e25717850c26c9cd0d89d');
  assert.equal(gitBlobId(new Uint8Array()),'e69de29bb2d1d6434b8b29ae775ad8c2e48c5391');
  assert.equal(gitBlobId(new TextEncoder().encode('hello\n')),'ce013625030ba8dba906f756967f9e9ca394464a');
  const next=random(3);
  for(const length of [55,56,63,64,65,119,120,1000,70000]){
    const bytes=new Uint8Array(length).map(()=>Math.floor(next()*256));
    assert.equal(gitBlobId(bytes),createHash('sha1').update(Buffer.concat([Buffer.from(`blob ${length}\0`),Buffer.from(bytes)])).digest('hex'),String(length));
  }
});

test('remote paths: traversal, absolute, backslash, control, hidden characters and Git or Scribyra state are refused',()=>{
  for(const path of ['../x','a/../../x','/etc/passwd','a//b','./a','C:\\x','a\\b','a:b','a\0b','a\nb','.','..','','x'.repeat(241),'é'.repeat(121),'a\u202eb.tex','zero\u200bwidth.tex'])assert.equal(pathProblem(path),'unsafe',JSON.stringify(path));
  for(const path of ['.git/config','sub/.git/hooks/post-checkout','.GIT','.scribyra-sync/state','x/.scribyra-sync-1/y'])assert.equal(pathProblem(path),'private',path);
  for(const path of ['main.tex','chapters/été.tex','.scribyraignore','.github/workflows/ci.yml','a b/c.tex'])assert.equal(pathProblem(path),'',path);
  assert.equal(normalSubfolder(' /paper/ '),'paper');assert.equal(normalSubfolder(''),'');assert.equal(normalSubfolder('../up'),null);assert.equal(normalSubfolder('.git'),null);
  assert.equal(toProjectPath('paper','paper/main.tex'),'main.tex');assert.equal(toProjectPath('paper','paperx/main.tex'),null);assert.equal(toProjectPath('paper','other.tex'),null);assert.equal(toProjectPath('','a/b'),'a/b');
  assert.equal(toRepoPath('paper','main.tex'),'paper/main.tex');assert.equal(toRepoPath('','main.tex'),'main.tex');
});

test('a remote tree: only files under the subfolder, with symlinks, submodules, large and unsafe entries skipped',()=>{
  const files=remoteFiles([
    {path:'README.md',type:'blob',mode:'100644',sha:'r',size:3},
    {path:'paper',type:'tree',mode:'040000',sha:'t'},
    {path:'paper/main.tex',type:'blob',mode:'100644',sha:'m',size:10},
    {path:'paper/run.sh',type:'blob',mode:'100755',sha:'x',size:10},
    {path:'paper/link.tex',type:'blob',mode:'120000',sha:'l',size:8},
    {path:'paper/vendor',type:'commit',mode:'160000',sha:'s'},
    {path:'paper/huge.bin',type:'blob',mode:'100644',sha:'h',size:17*1024*1024},
    {path:'paper/.git/config',type:'blob',mode:'100644',sha:'g',size:1},
    {path:'paper/../escape.tex',type:'blob',mode:'100644',sha:'e',size:1},
  ],'paper');
  assert.deepEqual([...files.keys()],['main.tex','run.sh','link.tex','vendor','huge.bin','.git/config','../escape.tex']);
  assert.deepEqual([...files.values()].map(file=>file.skip||''),['','','symlink','submodule','large','private','unsafe']);
  assert.equal(files.get('run.sh').mode,'100755');
});

test('.scribyraignore follows .gitignore: anchors, folders, ** and re-inclusion',()=>{
  const ignored=ignoreMatcher(['# build output','*.log','/out/','build/','**/cache/**','!keep.log','secret?.txt','docs/*.pdf','\\#hash.txt','  ']);
  for(const path of ['a.log','x/y/b.log','out/main.pdf','build/a','x/build/b.tex','x/cache/y/z','secret1.txt','docs/a.pdf','#hash.txt'])assert.ok(ignored(path),path);
  for(const path of ['keep.log','x/out/main.pdf','main.tex','docs/x/a.pdf','secret12.txt','build.tex','cache.tex'])assert.ok(!ignored(path),path);
  // A file inside an excluded folder cannot be re-included, as in Git.
  assert.ok(ignoreMatcher(['build/','!build/keep.tex'])('build/keep.tex'));
  assert.ok(!ignoreMatcher([])('anything.tex'));
});

test('secrets: token and key content is refused, credential-like names need a decision',()=>{
  const blocked=['ghp_'+'a'.repeat(36),'token = github_pat_11ABCDEFG0123456789_abcdefghijklmnopqrstuvwxyz','glpat-abcdefghij1234567890','-----BEGIN OPENSSH PRIVATE KEY-----\nabc','-----BEGIN RSA PRIVATE KEY-----','AKIAABCDEFGHIJKLMNOP','xoxb-1234567890-abc'];
  for(const text of blocked)assert.equal(secretProblem('notes.tex',text)?.block,true,text);
  for(const path of ['.env','config/.env.local','id_rsa','id_ed25519.pub','server.pem','cert.key','store.p12','.netrc','.npmrc','credentials.json','secrets.yaml'])assert.equal(secretProblem(path,'x')?.block,false,path);
  for(const path of ['.env.example','main.tex','keys.tex','environment.tex','monkey.tex'])assert.equal(secretProblem(path,'\\section{x}'),null,path);
  assert.equal(secretProblem('a.tex','ghp_short'),null);
});

test('branch names follow git check-ref-format',()=>{
  for(const name of ['main','feature/x','scribyra/my-changes','v1.2','release-2026'])assert.ok(validBranch(name),name);
  for(const name of ['','a..b','a b','a~b','a^b','a:b','a?b','a*b','a[b','a\\b','/a','a/','a//b','.hidden','a/.b','a.lock','a.lock/b','@','a@{b','-x','end.','x'.repeat(201)])assert.ok(!validBranch(name),name);
});

test('repository names from text or a pasted address',()=>{
  assert.equal(normalRepository('github','octo/paper'),'octo/paper');
  assert.equal(normalRepository('github','https://github.com/octo/paper.git'),'octo/paper');
  assert.equal(normalRepository('github','https://github.com/octo/paper/tree/main/sub'),'octo/paper');
  assert.equal(normalRepository('github','git@github.com:octo/paper.git'),'octo/paper');
  assert.equal(normalRepository('github','octo/paper/extra'),null);assert.equal(normalRepository('github','../x'),null);
  assert.equal(normalRepository('gitlab','group/sub/project'),'group/sub/project');
  assert.equal(normalRepository('gitlab','https://gitlab.example.org/group/project/-/tree/main'),'group/project');
  assert.equal(normalRepository('gitlab','group/../project'),null);assert.equal(normalRepository('gitlab','single'),null);
  assert.equal(base64(new Uint8Array([0,1,2,250,255])),Buffer.from([0,1,2,250,255]).toString('base64'));
});

test('LFS pointers and UTF-8 text are recognised',()=>{
  assert.ok(isLfsPointer(new TextEncoder().encode('version https://git-lfs.github.com/spec/v1\noid sha256:abc\nsize 10\n')));
  assert.ok(!isLfsPointer(new TextEncoder().encode('\\documentclass{article}')));
  assert.equal(decodeText(new Uint8Array([0x63,0x61,0x66,0xe9])),null);
  assert.equal(decodeText(new TextEncoder().encode('\ufeffBOM kept')),'\ufeffBOM kept');
});

// Records and plans --------------------------------------------------------------------
const record=(sha,hash,extra={})=>({remote:sha,base:sha,mode:'100644',hash,local:true,...extra});
const remote=entries=>new Map(Object.entries(entries).map(([path,sha])=>[path,typeof sha==='string'?{sha,mode:'100644'}:sha]));
const local=entries=>new Map(Object.entries(entries).map(([path,hash])=>[path,{id:`id-${path}`,path,hash}]));

test('local and remote states compare with the last sync per path',()=>{
  assert.equal(localState(record('s1','h1'),{hash:'h1'}),'unchanged');
  assert.equal(localState(record('s1','h1'),{hash:'h2'}),'modified');
  assert.equal(localState(record('s1',null),{hash:'h1'}),'modified');
  assert.equal(localState(null,{hash:'h1'}),'added');
  assert.equal(localState(record('s1','h1'),null),'deleted');
  assert.equal(localState(record('s1',null,{local:false}),null),'absent');
  assert.equal(remoteState(record('s1','h1'),{sha:'s1'}),'unchanged');
  assert.equal(remoteState(record('s1','h1'),{sha:'s2'}),'changed');
  assert.equal(remoteState(record('s1','h1'),null),'removed');
  assert.equal(remoteState(null,{sha:'s1'}),'added');
});

test('pull plan: theirs is taken only where nothing local would be lost; everything else is a conflict or a check',()=>{
  const records={
    'same.tex':record('a1','ha'),'theirs.tex':record('b1','hb'),'both.tex':record('c1','hc'),'gone.tex':record('d1','hd'),
    'gone-edited.tex':record('e1','he'),'deleted-here.tex':record('f1','hf'),'deleted-both.tex':record('g1','hg'),'mine.tex':record('m1','hm'),
  };
  const plan=planPull({records,
    remote:remote({'same.tex':'a1','theirs.tex':'b2','both.tex':'c2','deleted-here.tex':'f2','new.tex':'n1','added-both.tex':'x1','mine.tex':'m1','Case.tex':'k1','ignored.log':'i1'}),
    local:local({'same.tex':'ha','theirs.tex':'hb','both.tex':'hc-edited','gone.tex':'hd','gone-edited.tex':'he-edited','added-both.tex':'hx','mine.tex':'hm-edited','case.tex':'hk'}),
    excluded:path=>path.endsWith('.log')});
  const kinds=Object.fromEntries(plan.items.map(item=>[item.path,`${item.remoteState}/${item.localState}/${item.kind}`]));
  assert.deepEqual(kinds,{
    'added-both.tex':'added/added/check','both.tex':'changed/modified/check','deleted-both.tex':'removed/deleted/record',
    'deleted-here.tex':'changed/deleted/conflict','gone-edited.tex':'removed/modified/conflict','gone.tex':'removed/unchanged/take',
    'new.tex':'added/absent/take','theirs.tex':'changed/unchanged/take',
  });
  assert.deepEqual(plan.skipped,[{path:'Case.tex',reason:'case'},{path:'ignored.log',reason:'excluded'}]);
  // Local-only changes are not part of a pull.
  assert.ok(!kinds['mine.tex']&&!kinds['same.tex']);
  // Skipped remote entries (symlinks, submodules…) never become changes or deletions.
  const skipped=planPull({records:{'link.tex':record('l1','hl')},remote:new Map([['link.tex',{sha:'l2',mode:'120000',skip:'symlink'}]]),local:local({'link.tex':'hl'})});
  assert.deepEqual(skipped,{items:[],skipped:[{path:'link.tex',reason:'symlink'}]});
});

test('push plan: local changes, refusing paths with remote changes not pulled yet',()=>{
  const records={'a.tex':record('a1','ha'),'b.tex':record('b1','hb'),'c.tex':record('c1','hc'),'pending.tex':{...record('p1','hp'),remote:'p2'},'skipped.bin':record('s1',null,{local:false}),'x.log':record('x1','hx')};
  const plan=planPush({records,local:local({'a.tex':'ha','b.tex':'hb-edited','new.tex':'hn','pending.tex':'hp-edited','x.log':'hx-edited'}),excluded:path=>path.endsWith('.log')});
  assert.deepEqual(plan.items.map(item=>[item.path,item.op]),[['b.tex','update'],['c.tex','delete'],['new.tex','add']]);
  assert.deepEqual(plan.behind,['pending.tex']);assert.deepEqual(plan.excluded,['x.log']);
  // A local file at a path the remote has but was never merged must be pulled first.
  assert.deepEqual(planPush({records:{'r.tex':{remote:'r1',base:null,mode:'100644',hash:null,local:false}},local:local({'r.tex':'h'})}).behind,['r.tex']);
});

test('records after a pull: applied, same, kept mine and pending changes',()=>{
  const records={'t.tex':record('t1','ht'),'m.tex':record('m1','hm'),'p.tex':record('p1','hp'),'d.tex':record('d1','hd'),'u.tex':record('u1','hu'),'k.tex':record('k1','hk')};
  const next=recordsAfterPull({records,remote:remote({'t.tex':'t2','m.tex':'m2','p.tex':'p2','u.tex':'u1','n.tex':'n1','k.tex':'k2','skip.tex':{sha:'z',mode:'120000',skip:'symlink'}}),outcomes:{
    't.tex':{result:'applied',exists:true,hash:'ht2'},'m.tex':{result:'mine'},'p.tex':{result:'pending'},'d.tex':{result:'applied',exists:false},'n.tex':{result:'applied',exists:true,hash:'hn'},'k.tex':{result:'same',exists:true,hash:'hk-edited'},
  }});
  assert.deepEqual(next['t.tex'],record('t2','ht2'));
  assert.deepEqual(next['m.tex'],record('m2',null));// local differs from the new base: pushed next time
  assert.deepEqual(next['p.tex'],{...record('p1','hp'),remote:'p2'});// still to pull
  assert.equal(next['d.tex'],undefined);
  assert.deepEqual(next['u.tex'],record('u1','hu'));
  assert.deepEqual(next['n.tex'],record('n1','hn'));
  assert.deepEqual(next['k.tex'],record('k2','hk-edited'));
  assert.equal(next['skip.tex'],undefined);
  // A combined or edited result differs from theirs (no fingerprint): the next push sends it.
  const merged=recordsAfterPull({records:{'c.tex':record('c1','hc')},remote:remote({'c.tex':'c2'}),outcomes:{'c.tex':{result:'applied',exists:true,hash:null}}});
  assert.deepEqual(planPush({records:merged,local:local({'c.tex':'hc-merged'})}).items.map(item=>[item.path,item.op]),[['c.tex','update']]);
  // Kept mine after a remote deletion: the file is new again relative to the remote.
  assert.equal(localState(recordsAfterPull({records:{'g.tex':record('g1','hg')},remote:remote({}),outcomes:{'g.tex':{result:'mine'}}})['g.tex'],{hash:'hg-edited'}),'added');
  // Kept a local deletion against a remote change: pushing deletes it there.
  assert.equal(localState(recordsAfterPull({records:{'h.tex':record('h1','hh')},remote:remote({'h.tex':'h2'}),outcomes:{'h.tex':{result:'mine'}}})['h.tex'],null),'deleted');
});

test('records after a push and at link time',()=>{
  const next=recordsAfterPush({records:{'a.tex':record('a1','ha'),'b.tex':record('b1','hb'),'c.tex':record('c1','hc')},pushed:[{path:'a.tex',op:'update',sha:'a2',hash:'ha2'},{path:'b.tex',op:'delete'},{path:'n.tex',op:'add',sha:'n1',hash:'hn',mode:'100644'}]});
  assert.deepEqual(next,{'a.tex':record('a2','ha2'),'c.tex':record('c1','hc'),'n.tex':record('n1','hn')});
  const linked=recordsAtLink({remote:remote({'same.tex':'s1','edited.tex':'e1','skipped.pdf':'p1','link.tex':{sha:'l',mode:'120000',skip:'symlink'}}),local:local({'same.tex':'hs','edited.tex':'he','mine.tex':'hm'}),blobIds:{'same.tex':'s1','edited.tex':'e-local'}});
  assert.deepEqual(linked,{'same.tex':record('s1','hs'),'edited.tex':record('e1',null),'skipped.pdf':record('p1',null,{local:false})});
  // A file skipped at import (absent here) is neither deleted by a push nor offered again unless it changes.
  assert.deepEqual(planPush({records:linked,local:local({'same.tex':'hs','edited.tex':'he','mine.tex':'hm'})}).items.map(item=>[item.path,item.op]),[['edited.tex','update'],['mine.tex','add']]);
  assert.deepEqual(planPull({records:linked,remote:remote({'same.tex':'s1','edited.tex':'e1','skipped.pdf':'p1'}),local:local({'same.tex':'hs','edited.tex':'he'})}).items,[]);
});
