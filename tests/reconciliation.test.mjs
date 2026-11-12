import './helpers/core.mjs';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {plan_folder_reconciliation, verify_folder_review, blob_hash} from '../web/pkg/scribyra_app.js';

const text=(id,path,content)=>({id,path,data:{kind:'text',content}});
const folder=(id,path)=>({id,path,data:{kind:'folder'}});
const binary=(id,path,byte)=>({id,path,data:{kind:'binary',sha256:blob_hash(new Uint8Array([byte])),size:1}});
function request(base,local,disk,resolutions=[]){return{version:1,projectId:'interop-project',base:{entries:base},local:{entries:local},disk:{entries:disk.map(entry=>({...entry,id:null}))},resolutions};}
function native(input){const result=spawnSync(fileURLToPath(new URL('../target/debug/scribyra-folders',import.meta.url)),['plan'],{input:JSON.stringify(input),encoding:'utf8',maxBuffer:8*1024*1024});assert.equal(result.error,undefined);assert.equal(result.status,0,result.stderr);return JSON.parse(result.stdout);}
function wasm(input){return JSON.parse(plan_folder_reconciliation(JSON.stringify(input)));}

test('native and WASM produce identical reviewed text and rename plans',()=>{
 const inputs=[
  request([text('a','main.tex','One\nTwo\nThree\n')],[text('a','main.tex','First\nTwo\nThree\n')],[text('a','main.tex','One\nTwo\nLast\n')]),
  request([folder('f','old'),text('a','old/main.tex','base')],[folder('f','new'),text('a','new/main.tex','local')],[folder('f','old'),text('a','old/main.tex','base'),text('b','old/addition.tex','external')]),
 ];
 for(const input of inputs){const expected=native(input),actual=wasm(input);assert.deepEqual(actual,expected);assert.equal(actual.conflicts.length,0);assert.deepEqual(JSON.parse(verify_folder_review(JSON.stringify(expected),JSON.stringify(input))),actual.result);}
 const moved=wasm(inputs[1]).result.entries.find(e=>e.path==='new/main.tex');assert.equal(moved.id,'a');assert.equal(moved.data.content,'local');
});

test('binary conflicts require a decision and retain both hashes under reviewed paths',()=>{
 const input=request([binary('a','figure.png',1)],[binary('a','figure.png',2)],[binary('a','figure.png',3)]);
 const conflict=wasm(input);assert.equal(conflict.result,null);assert.equal(conflict.conflicts[0].kind,'content');assert.deepEqual(conflict,native(input));
 assert.throws(()=>verify_folder_review(JSON.stringify(conflict),JSON.stringify(input)),/Resolve every/);
 input.resolutions=[{id:'a',decision:{choice:'both',localPath:'figure.png',diskPath:'figure.external.png'}}];
 const review=wasm(input);assert.deepEqual(review,native(input));assert.equal(review.result.entries.length,2);assert.equal(new Set(review.result.entries.map(e=>e.data.sha256)).size,2);
 const changed=structuredClone(input);changed.disk.entries[0].data=binary('a','figure.png',4).data;
 assert.throws(()=>verify_folder_review(JSON.stringify(review),JSON.stringify(changed)),/changed/);
 const forged=structuredClone(review);forged.result.entries[0].data=binary('a','figure.png',5).data;
 assert.throws(()=>verify_folder_review(JSON.stringify(forged),JSON.stringify(input)),/changed/);
});

test('folder protocol rejects extensions and nonportable names before returning a plan',()=>{
 const input=request([],[],[text('a','CON.tex','test')]);assert.throws(()=>wasm(input),/paths/);
 input.disk.entries[0].path='main.tex';input.grant='write';assert.throws(()=>wasm(input),/unknown field/);
 delete input.grant;const review=wasm(input);review.result.entries[0].admin=true;
 assert.throws(()=>verify_folder_review(JSON.stringify(review),JSON.stringify(input)),/unknown field/);
});
