import 'fake-indexeddb/auto';
import './helpers/core.mjs';
import {test,beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {cacheArchive,cacheArchives,cachedArchive,cachedPackages,cacheMetadata,cachedMetadata,cachedMetadataUsage,clearPackageCache,clearMetadataCache,METADATA_CACHE_LIMIT,cacheSettings,updateCacheSettings} from '../web/tex-cache.js';
import {downloads} from '../web/downloads.js';
beforeEach(async()=>{await clearPackageCache();await updateCacheSettings(downloads.policy.defaults);});
function metadata(bytes){const sha256=createHash('sha256').update(bytes).digest('hex');return{sha256,path:`metadata/${sha256}.json`,size:bytes.length,bytes};}
test('metadata uses a separate namespace/budget and never appears as a package archive',async()=>{
 const bytes=new Uint8Array([1,2,3]),info=metadata(bytes);assert.equal(await cacheMetadata(info,bytes),true);assert.equal(await cacheArchive('archive',bytes),true);
 assert.equal((await cachedPackages()).length,1);assert.deepEqual(await cachedMetadataUsage(),{count:1,bytes:3});assert.deepEqual(await cachedMetadata(info.sha256),bytes);
 await clearMetadataCache();assert.deepEqual(await cachedMetadataUsage(),{count:0,bytes:0});assert.deepEqual(await cachedArchive('archive'),bytes);
});
test('configured limits trim only public bodies and headers, persist and roll back failed updates',async()=>{
 const bytes=new Uint8Array(1024*1024);assert.equal(await cacheArchive('one',bytes),true);assert.equal(await cacheArchive('two',bytes),true);
 await updateCacheSettings({...downloads.policy.defaults,archiveBytes:1024*1024});assert.equal((await cachedPackages()).length,1);assert.equal((await cacheSettings()).archiveBytes,1024*1024);
 const before=await cachedPackages(),prior=await cacheSettings(),put=IDBObjectStore.prototype.put;
 IDBObjectStore.prototype.put=function(...args){if(this.name==='control')throw new DOMException('Full','QuotaExceededError');return put.apply(this,args);};
 try{await assert.rejects(updateCacheSettings({...prior,archiveBytes:0}),/Full/);}finally{IDBObjectStore.prototype.put=put;}
 assert.deepEqual(await cachedPackages(),before);assert.deepEqual(await cacheSettings(),prior);
 await updateCacheSettings({...prior,archiveBytes:0});assert.deepEqual(await cachedPackages(),[]);assert.equal(await cacheArchive('disabled',bytes),false);
 await assert.rejects(updateCacheSettings({...prior,metadataBytes:1}),/whole MiB/);assert.equal((await cacheSettings()).archiveBytes,0);
});
test('inventory uses small header records rather than materializing every body',async()=>{
 assert.equal(await cacheArchive('one',new Uint8Array([1,2,3])),true);const cursor=IDBObjectStore.prototype.openCursor,getAll=IDBObjectStore.prototype.getAll;
 IDBObjectStore.prototype.openCursor=function(...args){if(this.name==='archives')throw new Error('Archive body scan');return cursor.apply(this,args);};IDBObjectStore.prototype.getAll=function(...args){if(this.name==='archives')throw new Error('Archive body scan');return getAll.apply(this,args);};
 try{assert.equal((await cachedPackages()).length,1);assert.deepEqual(await cachedMetadataUsage(),{count:0,bytes:0});assert.equal(await cacheArchive('two',new Uint8Array([2])),true);}finally{IDBObjectStore.prototype.openCursor=cursor;IDBObjectStore.prototype.getAll=getAll;}
});
test('quota failure rolls back both archive and metadata writes and their prior evictions',async()=>{
 const archive=new Uint8Array(32*1024*1024);for(let i=0;i<4;i++){archive.fill(i);assert.equal(await cacheArchive('old-'+i,archive),true);}
 const bytes=new Uint8Array(2*1024*1024),hashes=[];for(let i=0;i<16;i++){bytes.fill(i);const info=metadata(bytes);hashes.push(info.sha256);assert.equal(await cacheMetadata(info,bytes),true);}
 assert.equal((await cachedMetadataUsage()).bytes,METADATA_CACHE_LIMIT);const prior=await cachedPackages(),usage=await cachedMetadataUsage();
 const a=metadata(new Uint8Array([33])),b=metadata(new Uint8Array([44]));let calls=0;const put=IDBObjectStore.prototype.put;
 IDBObjectStore.prototype.put=function(...args){if(this.name==='archives'&&++calls===4)throw new DOMException('Full','QuotaExceededError');return put.apply(this,args);};
 try{assert.equal(await cacheArchives([{hash:'new-a',bytes:a.bytes},{hash:'new-b',bytes:b.bytes}],[a,b]),false);}finally{IDBObjectStore.prototype.put=put;}
 assert.equal(calls,4);assert.deepEqual(await cachedPackages(),prior);assert.deepEqual(await cachedMetadataUsage(),usage);
 assert.equal(await cachedArchive('new-a'),undefined);assert.equal(await cachedMetadata(a.sha256),undefined);
 for(let i=0;i<hashes.length;i++){const restored=await cachedMetadata(hashes[i]);assert.equal(restored.length,bytes.length);assert.equal(restored[0],i);}
});
