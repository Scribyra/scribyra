import {test} from 'node:test';
import assert from 'node:assert/strict';
import {gzipSync} from 'node:zlib';
import {randomBytes} from 'node:crypto';
import {createTexLink} from '../docs/reorientation/tex-link.mjs';
import {decodeTexSource,takeTexFragment,TEX_LINK_LIMITS} from '../web/tex-link.js';
test('documented helper round-trips UTF-8, empty and boundary sources without changing the app path',async()=>{
 for(const source of ['','\uFEFF% UTF-8 BOM\n','\\documentclass{article}\n% café 🌍\n\\begin{document}Hi\\end{document}','x'.repeat(TEX_LINK_LIMITS.source)]){
  const link=new URL(createTexLink(source,'https://example.invalid/app/'));
  assert.equal(link.pathname,'/app/');assert.match(link.hash,/^#tex=[A-Za-z0-9_-]+$/);
  assert.equal(await decodeTexSource(link.hash.slice(5)),source);
 }
 assert.throws(()=>createTexLink('x'.repeat(TEX_LINK_LIMITS.source+1),'https://example.invalid/'),/65,536/);
 assert.throws(()=>createTexLink(randomBytes(30000).toString('hex'),'https://example.invalid/'),/16,384/);
});
test('fragment consumption clears history state, rejects oversize before decoding and ignores other routes',()=>{
 const replacements=[],browser={location:{pathname:'/app/',search:'?mode=local',hash:'#tex=abc'},history:{replaceState:(...args)=>replacements.push(args)}};
 assert.deepEqual(takeTexFragment(browser),{encoded:'abc'});assert.deepEqual(replacements,[[null,'','/app/?mode=local']]);
 browser.location.hash='#tex='+'x'.repeat(TEX_LINK_LIMITS.encoded+1);assert.match(takeTexFragment(browser).error,/too big/);
 browser.location.hash='#elsewhere';assert.equal(takeTexFragment(browser),null);assert.equal(replacements.length,2);
});
test('decoder rejects malformed/corrupt gzip, noncanonical base64, invalid UTF-8, NUL and expansion bombs',async()=>{
 const gzip=source=>gzipSync(source).toString('base64url');
 for(const encoded of ['', 'A', 'AB', 'AA=', 'not+url', 'not/url', 'main.tex&filename=../escape', 'AAAA', gzip(Buffer.from([0xff])),gzip('a\0b'),gzip('ok').slice(0,-4)])await assert.rejects(decodeTexSource(encoded),/Invalid TeX link/);
 await assert.rejects(decodeTexSource('A'.repeat(TEX_LINK_LIMITS.encoded+1)),/too big/);
 await assert.rejects(decodeTexSource(gzip('a'.repeat(8*1024*1024))),/too big/);
});
