import {test} from 'node:test';
import assert from 'node:assert/strict';
import {scribyraBiberProject} from '../scripts/biber-project.mjs';
function filesystem(){const files=new Map(),dirs=new Set();return{files,dirs,mkdirTree:path=>dirs.add(path),writeFile:(path,bytes)=>files.set(path,bytes),chdir(path){this.cwd=path;}};}
test('Biber stages nested and same-basename sources relative to the control directory, preserving bytes and case',()=>{
 const fs=filesystem(),a=new Uint8Array([0,255,31]);const result=scribyraBiberProject(fs,'/work','paper/main.tex.v2.bcf',[{path:'paper/main.tex.v2.bcf',contents:'control'},{path:'refs/Refs.BIB',contents:a},{path:'paper/Refs.BIB',contents:'other'}]);assert.equal(fs.cwd,'/work/project/paper');assert.equal(result.controlFile,'main.tex.v2.bcf');assert.equal(result.outputFile,'/work/project/paper/main.tex.v2.bbl');assert.deepEqual(fs.files.get('/work/project/refs/Refs.BIB'),a);assert.equal(new TextDecoder().decode(fs.files.get('/work/project/paper/Refs.BIB')),'other');
});
test('invalid or duplicate Biber inputs are rejected before changing the virtual filesystem',()=>{
 for(const path of ['../escape.bib','/outside.bib','a\\b.bib','a/./b.bib','a:b.bib']){const fs=filesystem();assert.throws(()=>scribyraBiberProject(fs,'/work','main.bcf',[{path:'main.bcf',contents:'ok'},{path,contents:'bad'}]),/Unsafe/);assert.equal(fs.files.size,0);assert.equal(fs.dirs.size,0);}
 const fs=filesystem();assert.throws(()=>scribyraBiberProject(fs,'/work','main.bcf',[{path:'main.bcf',contents:'first'},{path:'main.bcf',contents:'second'}]),/duplicate/);assert.equal(fs.files.size,0);
});
