import 'fake-indexeddb/auto';
import './helpers/core.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { TexCatalog } from '../web/pkg/scribyra_app.js';
import { cachedArchive, cacheArchive, downloadArchive } from '../web/tex-packages.js';
const json = gunzipSync(readFileSync(new URL('../web/tex-catalog.json.gz', import.meta.url))).toString();
const info = { name:'babel-romanian', ...JSON.parse(json).packages['babel-romanian'] };
const bytes = new Uint8Array(readFileSync(new URL('./fixtures/tex-packages/babel-romanian.tar.xz', import.meta.url)));
test('the real WASM decoder verifies upstream archives and cached bytes again', async () => {
  const catalog = new TexCatalog(json);
  try {
    assert.deepEqual(JSON.parse(catalog.resolve(JSON.stringify([{name:'romanian.ldf',format:26}]), '')), ['babel-romanian']);
    const files=catalog.unpack(info.name,bytes);assert.equal(files[0][0],'tex/generic/babel-romanian/romanian.ldf');assert(files[0][1] instanceof Uint8Array);
    assert.equal(await cacheArchive(info.sha512, bytes),true);assert.deepEqual(await cachedArchive(info.sha512),bytes);
    const modified=bytes.slice();modified[300]^=1;await cacheArchive(info.sha512,modified);
    assert.throws(()=>catalog.unpack(info.name,modified),/checksum/);await cacheArchive(info.sha512,bytes);
    assert.equal(await cachedArchive('a-different-snapshot'),undefined);
  } finally { catalog.free(); }
});
test('package HTTP requests disclose only archive names, enforce response bounds, and honor abort', async () => {
  const original=globalThis.fetch, abort=new AbortController(); let cancelled=false;
  try {
    globalThis.fetch=async(url,options)=>{assert.equal(url,'https://tlnet.yihui.org/archive/babel-romanian.tar.xz');assert.equal(options.credentials,'omit');assert.equal(options.referrerPolicy,'no-referrer');assert.equal(options.signal.aborted,false);return new Response(bytes);};
    assert.deepEqual(await downloadArchive(info,abort.signal),bytes);
    globalThis.fetch=async()=>new Response(new ReadableStream({start(c){c.enqueue(new Uint8Array(info.size+1));},cancel(){cancelled=true;}}));
    await assert.rejects(downloadArchive(info,abort.signal),/changed/);assert.equal(cancelled,true);
    globalThis.fetch=async()=>new Response('',{status:404});await assert.rejects(downloadArchive(info,abort.signal),/HTTP 404/);
    await assert.rejects(downloadArchive({...info,name:'../../secret'},abort.signal),/limit/);
    let networkSignal,started;const waiting=new Promise(resolve=>{started=resolve;});globalThis.fetch=async(_url,{signal})=>{networkSignal=signal;started();return new Promise(()=>{});};const pending=downloadArchive(info,abort.signal);await waiting;abort.abort();await assert.rejects(pending,{name:'AbortError'});assert.equal(networkSignal.aborted,true);await assert.rejects(downloadArchive(info,abort.signal),{name:'AbortError'});
  } finally { globalThis.fetch=original; }
});
test('package cache quota failure is reported while retaining previously cached data', async () => {
  const original=IDBObjectStore.prototype.put;
  IDBObjectStore.prototype.put=function(){throw new DOMException('Disk full','QuotaExceededError');};
  try { assert.equal(await cacheArchive('cannot-save',bytes),false); } finally { IDBObjectStore.prototype.put=original; }
  assert.deepEqual(await cachedArchive(info.sha512),bytes);
});
test('distribution components use content-addressed same-origin downloads',async()=>{
 const original=globalThis.fetch,abort=new AbortController();
 try{
  globalThis.fetch=async(url,options)=>{assert.equal(url,`/core/busytex/components/${info.sha512}.tar.xz`);assert.equal(options.credentials,'same-origin');assert.equal(options.referrerPolicy,'no-referrer');return new Response(bytes);};
  assert.deepEqual(await downloadArchive({...info,origin:'distribution'},abort.signal),bytes);
  await assert.rejects(downloadArchive({...info,origin:'distribution',sha512:'../bad'},abort.signal),/checksum/);
 }finally{globalThis.fetch=original;}
});
test('pinned upstream support replicas use exact same-origin paths and reject arbitrary archive URLs',async()=>{
 const original=globalThis.fetch,abort=new AbortController();try{globalThis.fetch=async(url,options)=>{assert.equal(url,`/core/busytex/components/${info.sha512}.tar.xz`);assert.equal(options.credentials,'same-origin');return new Response(bytes);};assert.deepEqual(await downloadArchive({...info,origin:'texlive',archive:`components/${info.sha512}.tar.xz`},abort.signal),bytes);await assert.rejects(downloadArchive({...info,archive:'https://other.test/leak'},abort.signal),/Invalid static/);}finally{globalThis.fetch=original;}
});
