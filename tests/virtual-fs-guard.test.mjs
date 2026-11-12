import { test } from 'node:test';
import assert from 'node:assert/strict';
import { posix } from 'node:path';
import { scribyraProjectWrites } from '../scripts/virtual-fs-guard.mjs';
function filesystem(){
  class ErrnoError extends Error{constructor(errno){super(`errno ${errno}`);this.errno=errno;}}
  const links=new Map([['/project/link','/outside'],['/project/dangling','/outside/new.txt']]);
  const dirs=new Set(['/','/project','/project/paper','/project/sections','/tmp','/outside','/texlive','/texlive/var','/texlive/var/luatex-cache','/texmf-downloads']);
  const writes=[];
  const FS={ErrnoError,cwd:()=>'/project/paper',getPath:node=>node.path,isLink:mode=>mode==='link',readlink:path=>links.get(path),lookupPath(path,{follow=true}={}){path=posix.resolve('/project/paper',path);for(const [link,target]of links){if(path.startsWith(link+'/')||follow&&path===link)path=target+path.slice(link.length);}if(!dirs.has(path)&&!(!follow&&links.has(path)))throw new ErrnoError(44);return{path,node:{path,mode:links.has(path)?'link':'dir'}};}};
  for(const method of ['open','mkdir','mknod','rename','unlink','symlink','chmod'])FS[method]=(...args)=>writes.push([method,...args]);
  return{FS,writes};
}
test('virtual writes resolve parent paths within the project and deny package/outside/symlink escapes',()=>{
  const {FS,writes}=filesystem(),open=FS.open;
  scribyraProjectWrites({FS},'/project','/texlive/var',()=>{
    FS.open('../sections/chapter.aux','w');FS.open('/tmp/job.log',577);FS.open('/texlive/format.fmt','r');
    for(const path of ['../../escape.txt','/project-other/test','/texlive/format.fmt','/texmf-downloads/injected.sty','/texlive/var/luatex-cache/font.lua','/project/link/escape.txt','/project/dangling'])assert.throws(()=>FS.open(path,'w'),/errno/);
    assert.throws(()=>FS.rename('../sections/chapter.aux','/outside/new.txt'),/errno/);assert.throws(()=>FS.symlink('/outside','/project/newlink'),/errno/);assert.throws(()=>FS.chmod('/texlive',0o777),/errno/);
  });
  assert.equal(writes.length,3);assert.equal(FS.open,open);
});
test('filesystem hooks are restored even when an engine throws',()=>{
  const {FS}=filesystem(),open=FS.open;
  assert.throws(()=>scribyraProjectWrites({FS},'/project','/texlive/var',()=>{throw new Error('engine failed');}),/engine failed/);assert.equal(FS.open,open);
});
