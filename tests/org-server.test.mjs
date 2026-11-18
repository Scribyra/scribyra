// The Node-level helpers for server-readable deployments that browser specs build on: a service
// with the local test provider and a fresh master key, sign-in without a browser, and the
// `/v1/sr/` client (create, append Yjs updates, read the log, objects, invitations, heads).
import {test} from 'node:test';
import assert from 'node:assert/strict';
import * as Y from 'yjs';
import {readFile} from 'node:fs/promises';
import {serverService,ssoLogin} from './helpers/idp.mjs';
import {srClient} from './helpers/service.mjs';

test('a server-readable deployment starts with the test provider and serves /v1/sr/',async()=>{
  const s=await serverService();
  try{
    assert.equal((await readFile(s.config.service_key_file)).length,32);
    const info=await (await fetch(`${s.url}/v1/deployment`)).json();
    assert.equal(info.encryption,'server');assert.equal(info.name,'Acme Lab');
    const ana=srClient(s.url,(await ssoLogin(s,'ana')).token);
    const created=await ana.create('Paper');
    assert.equal(created.status,201);
    const p=created.body.project.id;
    const doc=new Y.Doc();let update;doc.on('update',u=>{update=u;});
    doc.getText('text:f1').insert(0,'Hello from Node');
    assert.deepEqual((await ana.append(p,'node-client',1,update)).body,{seq:1});
    assert.equal((await ana.append(p,'node-client',1,update)).status,200);
    const log=await ana.log(p,0);
    assert.equal(log.head,1);
    const copy=new Y.Doc();for(const f of log.frames)Y.applyUpdate(copy,f.update);
    assert.equal(copy.getText('text:f1').toString(),'Hello from Node');
    const image=new Uint8Array([137,80,78,71,1,2,3]);
    assert.equal(await ana.putObject(p,image),201);
    const {createHash}=await import('node:crypto');
    assert.deepEqual((await ana.getObject(p,createHash('sha256').update(image).digest('hex'))).bytes,image);
    // Ben is invited before his first sign-in; signing in turns the invitation into a share.
    assert.equal((await ana.invite(p,'ben@acme.test','editor')).body.status,'pending');
    const ben=srClient(s.url,(await ssoLogin(s,'ben')).token);
    const list=await ben.projects();
    assert.deepEqual(list.body.projects.map(x=>[x.id,x.role]),[[p,'editor']]);
    const {version}=(await ben.heads()).body;
    const waiting=ben.heads(version,20);
    doc.getText('text:f1').insert(0,'> ');
    assert.equal((await ana.append(p,'node-client',2,update)).status,201);
    assert.equal((await waiting).body.projects[p].head,2);
  }finally{await s.close();}
});
