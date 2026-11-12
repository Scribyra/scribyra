import 'fake-indexeddb/auto';
import './helpers/core.mjs';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {openDB} from 'idb';
import * as Y from 'yjs';
import {addFile} from '../web/model.js';
test('failed head-store upgrade leaves database version and every original byte intact, then retries cleanly',async()=>{
 const doc=new Y.Doc();addFile(doc,'main.tex','Original migration source 😀');const bytes=Y.encodeStateAsUpdate(doc),old=await openDB('scribyra-v1',5,{upgrade(db){db.createObjectStore('projects',{keyPath:'id'});db.createObjectStore('deletedProjects',{keyPath:'id'});}});await old.put('projects',{id:'older',name:'Original project',schemaVersion:5,sequence:0,files:1,updatedAt:1,update:bytes});await old.put('deletedProjects',{id:'deleted-before-upgrade',deletedAt:1});old.close();doc.destroy();
 const put=IDBObjectStore.prototype.put;IDBObjectStore.prototype.put=function(...args){if(this.name==='heads')throw new DOMException('Upgrade disk full','QuotaExceededError');return put.apply(this,args);};
 try{const storage=await import('../web/storage.js');await assert.rejects(storage.listProjects());}finally{IDBObjectStore.prototype.put=put;}
 const unchanged=await openDB('scribyra-v1');assert.equal(unchanged.version,5);assert.equal(unchanged.objectStoreNames.contains('heads'),false);assert.deepEqual((await unchanged.get('projects','older')).update,bytes);assert.equal((await unchanged.get('deletedProjects','deleted-before-upgrade')).deletedAt,1);unchanged.close();
 const retried=await import('../web/storage.js?upgrade-retry');assert.equal((await retried.listProjects())[0].name,'Original project');const upgraded=await openDB('scribyra-v1');assert.equal(upgraded.version,8);assert.equal((await upgraded.get('heads','deleted-before-upgrade')).deleted,true);upgraded.close();
});
