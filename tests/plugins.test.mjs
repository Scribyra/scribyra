// Plugin manifests, permissions, policy, packages, the signed registry and dialog specs
// (docs/plugins.md). Browser behaviour is in tests/browser/plugins.spec.js.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {generateKeyPairSync,sign} from 'node:crypto';
import {validateManifest,readPackage,normalPermissions,addedPermissions,describePermissions,globMatch,compareVersions,versionInRange,normalPolicy,policyDecision,normalOrigin,PluginError} from '../web/plugin-manifest.js';
import {canonicalJson,verifyRegistry,verifyPackage,sha256Hex,TRUSTED_REGISTRY_KEYS} from '../web/plugin-registry.js';
import {validateDialogSpec} from '../web/plugin-dialog.js';
import {verifyAll} from '../scripts/plugins.mjs';

const ZOTERO=JSON.parse(await readFile(new URL('../plugins/zotero/manifest.json',import.meta.url),'utf8'));
const base={manifestVersion:1,id:'org.example.demo',name:'Demo',version:'1.0.0',publisher:'Example',api:1,main:'main.js'};
const rejects=(value,pattern,options)=>assert.throws(()=>validateManifest(value,options),error=>error instanceof PluginError&&pattern.test(error.message),JSON.stringify(value).slice(0,120));

test('the Zotero manifest validates and normalises to sorted, exact permissions',()=>{
  const manifest=validateManifest(ZOTERO);
  assert.deepEqual(Object.keys(manifest.permissions),['bibliography','network','project.read','project.write','secrets','ui.command','ui.dialog','ui.fileAction']);
  assert.deepEqual(manifest.permissions['project.read'],{files:['*.bib','*.ltx','*.tex']});
  assert.deepEqual(manifest.permissions['project.write'],{create:['*.bib'],pick:false});
  assert.deepEqual(manifest.permissions.network,['https://api.zotero.org']);
  assert.deepEqual(manifest.contributes.fileActions.map(action=>[action.id,action.when.target,action.modes]),[['link','folder',['editing']],['refresh','file',['editing']],['links','file',['editing','reviewing','viewing']]]);
});

test('manifests are strict: unknown fields, permissions and newer versions are refused',()=>{
  rejects({...base,extra:true},/unknown field “extra”/);
  rejects({...base,permissions:{clipboard:true}},/Unknown permission “clipboard”/);
  rejects({...base,permissions:{'ui.panel':true}},/reserved/);
  rejects({...base,manifestVersion:2},/needs a newer version of Scribyra/);
  rejects({...base,api:2},/newer plugin API/);
  rejects({...base,id:'Demo'},/reverse-DNS/);rejects({...base,id:'demo'},/reverse-DNS/);rejects({...base,id:'org.'+'a'.repeat(70)},/reverse-DNS/);
  rejects({...base,version:'1.0'},/semantic version/);
  rejects({...base,main:'../main.js'},/“main”/);
  rejects({...base,homepage:'http://example.org'},/https/);
  rejects({...base,name:'x'.repeat(41)},/“name”/);
  rejects({...base,name:'bad\u0007name'},/“name”/);
  rejects({...base,permissions:{'project.write':{create:['*.bib']}}},/also needs “project.read”/);
  rejects({...base,permissions:{'project.read':{files:['../*.tex']}}},/invalid file pattern/);
  rejects({...base,permissions:{'project.read':{files:['/abs.tex']}}},/invalid file pattern/);
  rejects({...base,permissions:{secrets:'yes'}},/must be true/);
  rejects({...base,contributes:{commands:[{id:'go',label:'Go'}]}},/“ui.command”/);
  rejects({...base,permissions:{'ui.fileAction':true},contributes:{fileActions:[{id:'go',label:'Go',when:{target:'folder'},icon:'skull'}]}},/icon must be one of/);
  rejects({...base,permissions:{'ui.fileAction':true},contributes:{fileActions:[{id:'go',label:'Go',when:{target:'folder'},modes:['admin']}]}},/modes/);
  rejects({...base,permissions:{'ui.command':true},contributes:{commands:[{id:'go',label:'Go'},{id:'go',label:'Again'}]}},/unique id/);
});

test('network permissions name exact https origins; loopback http only for developer packages',()=>{
  assert.equal(normalOrigin('https://api.zotero.org'),'https://api.zotero.org');
  assert.equal(normalOrigin('https://api.zotero.org/'),'https://api.zotero.org');
  for(const bad of ['http://api.zotero.org','https://api.zotero.org/v3','https://*.zotero.org','https://user@api.zotero.org','https://api.zotero.org?x=1','ftp://x.org','api.zotero.org'])
    assert.throws(()=>normalPermissions({network:[bad]}),PluginError,bad);
  assert.throws(()=>normalPermissions({network:['http://127.0.0.1:9000']}),PluginError);
  assert.deepEqual(normalPermissions({network:['http://127.0.0.1:9000']},{developer:true}).network,['http://127.0.0.1:9000']);
  assert.throws(()=>normalPermissions({network:['http://192.168.0.2']},{developer:true}),PluginError);
  assert.throws(()=>normalPermissions({network:[]}),PluginError);
});

test('file globs stay within folders unless ** is used, and match names in any folder without a slash',()=>{
  assert.ok(globMatch('*.bib','refs.bib'));assert.ok(globMatch('*.bib','chapters/refs.bib'));assert.ok(globMatch('*.BIB','refs.bib'));
  assert.ok(!globMatch('*.bib','refs.bib.tex'));assert.ok(!globMatch('*.bib','refs.tex'));
  assert.ok(globMatch('refs/*.bib','refs/a.bib'));assert.ok(!globMatch('refs/*.bib','refs/x/a.bib'));assert.ok(!globMatch('refs/*.bib','a.bib'));
  assert.ok(globMatch('refs/**/*.bib','refs/x/y/a.bib'));assert.ok(globMatch('**/*.tex','a/b.tex'));
  assert.ok(globMatch('ch?.tex','ch1.tex'));assert.ok(!globMatch('ch?.tex','ch10.tex'));
  assert.ok(!globMatch('a.(b)','a.b'));assert.ok(globMatch('a.(b)','a.(b)'));
});

test('updates: only new or widened permissions need consent again',()=>{
  const granted=normalPermissions({'project.read':{files:['*.bib']},'project.write':{create:['*.bib']},network:['https://a.example'],secrets:true});
  assert.deepEqual(addedPermissions(granted,granted),{});
  const next=normalPermissions({'project.read':{files:['*.bib','*.tex']},'project.write':{create:['*.bib'],pick:true},network:['https://a.example','https://b.example'],secrets:true,bibliography:true});
  assert.deepEqual(addedPermissions(granted,next),{'project.read':{files:['*.tex']},'project.write':{create:[],pick:true},network:['https://b.example'],bibliography:true});
  // Narrower versions ask nothing.
  assert.deepEqual(addedPermissions(next,granted),{});
  assert.deepEqual(addedPermissions({},{secrets:true}),{secrets:true});
});

test('permissions are described in plain words',()=>{
  const lines=describePermissions(validateManifest(ZOTERO).permissions);
  assert.deepEqual(lines.map(line=>line.text),['Suggest citations while you type','Contact https://api.zotero.org','Read files in the open project matching *.bib, *.ltx and *.tex','Create *.bib files and change the files it created','Keep secrets such as API keys on this device','Add items to More tools','Show dialogs','Add actions to the file tree and a bar above its files']);
  assert.match(lines.find(line=>line.key==='network').detail,/can send what it reads/);
});

test('semantic versions order and match ranges',()=>{
  assert.ok(compareVersions('1.0.0','1.0.1')<0);assert.ok(compareVersions('1.10.0','1.9.9')>0);
  assert.ok(compareVersions('1.0.0-beta','1.0.0')<0);assert.ok(compareVersions('1.0.0-alpha','1.0.0-beta')<0);assert.ok(compareVersions('1.0.0-2','1.0.0-10')<0);
  assert.equal(compareVersions('2.0.0','2.0.0'),0);
  assert.ok(versionInRange('1.4.2','^1.0.0'));assert.ok(!versionInRange('2.0.0','^1.0.0'));assert.ok(!versionInRange('0.9.0','^1.0.0'));
  assert.ok(versionInRange('0.2.5','^0.2.0'));assert.ok(!versionInRange('0.3.0','^0.2.0'));
  assert.ok(versionInRange('1.2.9','~1.2.0'));assert.ok(!versionInRange('1.3.0','~1.2.0'));
  assert.ok(versionInRange('1.2.3','1.2.3'));assert.ok(!versionInRange('1.2.4','1.2.3'));assert.ok(versionInRange('9.9.9','*'));
});

test('the organisation policy: allow-list by id, version and build; developer mode and personal installs',()=>{
  const open=normalPolicy(undefined);
  assert.deepEqual(open,{userInstall:true,developerMode:true,allow:null});
  assert.equal(policyDecision(open,{id:'org.x.y',version:'1.0.0',sha256:'a'.repeat(64),source:'developer',action:'install'}),'');
  const sha='b'.repeat(64);
  const org=normalPolicy(JSON.stringify({userInstall:false,developerMode:false,allow:[{id:'com.scribyra.zotero',versions:'^1.0.0',sha256:[sha]}]}));
  assert.match(policyDecision(org,{id:'org.x.y',version:'1.0.0',sha256:sha,source:'developer',action:'install'}),/developer mode/);
  assert.match(policyDecision(org,{id:'org.x.y',version:'1.0.0',sha256:sha,source:'official',action:'install'}),/installs plugins for you/);
  assert.match(policyDecision(org,{id:'org.x.y',version:'1.0.0',sha256:sha,source:'official',action:'run'}),/not allowed this plugin/);
  assert.match(policyDecision(org,{id:'com.scribyra.zotero',version:'2.0.0',sha256:sha,source:'official',action:'update'}),/only in versions \^1\.0\.0/);
  assert.match(policyDecision(org,{id:'com.scribyra.zotero',version:'1.1.0',sha256:'c'.repeat(64),source:'official',action:'run'}),/this build/);
  assert.equal(policyDecision(org,{id:'com.scribyra.zotero',version:'1.1.0',sha256:sha,source:'official',action:'install'}),'');
  assert.throws(()=>normalPolicy({allow:[{id:'NOPE'}]}),PluginError);
  assert.throws(()=>normalPolicy({allowEverything:true}),PluginError);
});

test('packages: JSON with a manifest and its main file; anything else is refused',()=>{
  const pkg=(fields={})=>JSON.stringify({format:'scribyra-plugin',formatVersion:1,manifest:base,files:{'main.js':'1'},...fields});
  const read=readPackage(pkg({binary:{'x.wasm':Buffer.from([0,97,115,109]).toString('base64')}}));
  assert.equal(read.manifest.id,'org.example.demo');assert.deepEqual([...read.binary['x.wasm']],[0,97,115,109]);
  for(const [bad,pattern] of [['not json',/not JSON/],[JSON.stringify({format:'zip'}),/not a Scribyra plugin/],[pkg({formatVersion:2}),/newer version/],[pkg({files:{'other.js':'1'}}),/main file/],[pkg({files:{'../main.js':'1'}}),/not valid/],[pkg({binary:{'main.js':'AAAA'}}),/not valid/],[pkg({binary:{'x.wasm':'%%%'}}),/not valid/],[pkg({extra:1}),/unknown field/]])
    assert.throws(()=>readPackage(bad),error=>pattern.test(error.message),bad.slice(0,60));
  assert.throws(()=>readPackage(new Uint8Array(4*1024*1024+1)),/larger than 4 MiB/);
});

test('the committed official registry verifies against the pinned key and matches fresh builds',async()=>{
  const registry=await verifyAll();
  assert.equal(registry.keyId,'scribyra-plugins-dev-2026-11');
  assert.deepEqual(registry.plugins.map(plugin=>plugin.id),['com.scribyra.zotero']);
});

test('a tampered registry, an unknown key or a wrong signature is refused',async()=>{
  const text=await readFile(new URL('../plugins/dist/registry.json',import.meta.url),'utf8'),document=JSON.parse(text);
  await verifyRegistry(text);
  const tampered=structuredClone(document);tampered.signed.plugins[0].versions[0].sha256='0'.repeat(64);
  await assert.rejects(verifyRegistry(tampered),/signature does not match/);
  const widened=structuredClone(document);widened.signed.plugins[0].versions[0].permissions.network.push('https://evil.example');
  await assert.rejects(verifyRegistry(widened),/signature does not match/);
  const unknown=structuredClone(document);unknown.signature.keyId='someone-else';unknown.signed.keyId='someone-else';
  await assert.rejects(verifyRegistry(unknown),/key Scribyra does not trust/);
  const unsigned={signed:document.signed};await assert.rejects(verifyRegistry(unsigned),/not signed/);
  // A registry signed by a key the app does not pin is refused even if well-formed.
  const {privateKey,publicKey}=generateKeyPairSync('ec',{namedCurve:'P-256'}),jwk=publicKey.export({format:'jwk'});
  const signed={...document.signed,keyId:'test-key'},value=sign('sha256',Buffer.from(canonicalJson(signed)),{key:privateKey,dsaEncoding:'ieee-p1363'}).toString('base64');
  const foreign={signed,signature:{alg:'ECDSA-P256-SHA256',keyId:'test-key',value}};
  await assert.rejects(verifyRegistry(foreign),/does not trust/);
  assert.equal((await verifyRegistry(foreign,{keys:{'test-key':{kty:'EC',crv:'P-256',x:jwk.x,y:jwk.y}}})).plugins.length,1);
  assert.ok(Object.isFrozen(TRUSTED_REGISTRY_KEYS));
});

test('canonical JSON sorts keys at every depth and drops nothing else',()=>{
  assert.equal(canonicalJson({b:1,a:{d:[3,{z:1,y:2}],c:'x'}}),'{"a":{"c":"x","d":[3,{"y":2,"z":1}]},"b":1}');
  assert.equal(canonicalJson('é '),JSON.stringify('é '));
  assert.throws(()=>canonicalJson({x:NaN}));
});

test('a package must match its registry entry: hash, id, version and permissions',async()=>{
  const document=JSON.parse(await readFile(new URL('../plugins/dist/registry.json',import.meta.url),'utf8'));
  const entry={id:'com.scribyra.zotero',...document.signed.plugins[0].versions[0]};
  const bytes=new Uint8Array(await readFile(new URL(`../plugins/dist/${entry.package}`,import.meta.url)));
  assert.equal((await verifyPackage(bytes,entry)).manifest.id,'com.scribyra.zotero');
  const changed=bytes.slice();changed[100]^=1;
  await assert.rejects(verifyPackage(changed,entry),/SHA-256 differs/);
  await assert.rejects(verifyPackage(bytes,{...entry,id:'com.scribyra.other'}),/different plugin/);
  await assert.rejects(verifyPackage(bytes,{...entry,permissions:{secrets:true}}),/different permissions/);
  assert.equal(await sha256Hex(new TextEncoder().encode('abc')),'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});

test('dialog specs: only known parts, https links, unique ids, bounded sizes, at least one row of buttons',()=>{
  const ok=validateDialogSpec({title:'T',children:[{type:'text',content:['See ',{link:'https://example.org',text:'docs'}]},{type:'field',id:'k',input:'password',label:'Key'},{type:'actions',buttons:[{id:'ok',label:'OK',primary:true}]}]});
  assert.equal(ok.children[1].input,'password');
  const bad=(spec,pattern)=>assert.throws(()=>validateDialogSpec(spec),error=>error.code==='invalid_dialog'&&pattern.test(error.message),JSON.stringify(spec).slice(0,100));
  const actions={type:'actions',buttons:[{id:'ok',label:'OK'}]};
  bad({title:'T',children:[{type:'html',html:'<b>x</b>'},actions]},/Unknown dialog part/);
  bad({title:'T',children:[{type:'link',href:'javascript:alert(1)',text:'x'},actions]},/https/);
  bad({title:'T',children:[{type:'text',content:[{link:'http://example.org',text:'x'}]},actions]},/https/);
  bad({title:'T',children:[{type:'field',id:'a',input:'text',label:'A'},{type:'field',id:'a',input:'text',label:'B'},actions]},/unique/);
  bad({title:'T',children:[{type:'field',id:'a',input:'file',label:'A'},actions]},/text, password, select or checkbox/);
  bad({title:'T',children:[{type:'text',text:'no buttons'}]},/row of buttons/);
  bad({title:'T',children:[...Array.from({length:2001},()=>({type:'text',text:'x'})),actions]},/at most 2000/);
  let deep={type:'section',label:'x',children:[]},root=deep;for(let i=0;i<10;i++){const next={type:'section',label:'x',children:[]};root.children.push(next);root=next;}
  bad({title:'T',children:[deep,actions]},/nested at most 8 deep/);
  bad({title:'x'.repeat(121),children:[actions]},/Dialog title/);
});
