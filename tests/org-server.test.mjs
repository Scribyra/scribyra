// The Node-level helpers for server-readable deployments that browser specs build on: a service
// with the local test provider and a fresh master key, sign-in without a browser, and the
// `/v1/sr/` client (create, append Yjs updates, read the log, objects, invitations, heads).
import './helpers/integration-session.mjs';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import * as Y from 'yjs';
import {readFile} from 'node:fs/promises';
import {serverService,ssoLogin,signIn} from './helpers/idp.mjs';
import {srClient,APP_ORIGIN,pgDump} from './helpers/service.mjs';
import * as storage from '../web/storage.js';
import {addEntries,migrateProject} from '../web/model.js';
import {orgServer,parseFrames,orgServerConnected} from '../web/org-server.js';
import {openDB} from 'idb';

// Node has no localStorage or Web Locks; the engine uses them as in a browser.
if(!globalThis.localStorage){const items=new Map();globalThis.localStorage={getItem:k=>items.has(k)?items.get(k):null,setItem:(k,v)=>items.set(k,String(v)),removeItem:k=>items.delete(k)};}
if(!globalThis.navigator?.locks){const tails=new Map();Object.defineProperty(globalThis.navigator,'locks',{configurable:true,value:{request(name,a,b){const fn=b||a,next=(tails.get(name)||Promise.resolve()).then(()=>fn());tails.set(name,next.catch(()=>{}));return next;}}});}

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

test('log pages parse into frames and a truncated page is refused',()=>{
  const page=new Uint8Array(12+3+12+1),view=new DataView(page.buffer);
  view.setBigUint64(0,7n);view.setUint32(8,3);page.set([1,2,3],12);view.setBigUint64(15,8n);view.setUint32(23,1);page[27]=9;
  assert.deepEqual(parseFrames(page).map(f=>[f.seq,[...f.update]]),[[7,[1,2,3]],[8,[9]]]);
  assert.throws(()=>parseFrames(page.subarray(0,20)),/truncated/);
  assert.deepEqual(parseFrames(new Uint8Array(0)),[]);
});

const text=new TextEncoder();
const contains=(haystack,needle)=>Buffer.from(haystack).includes(Buffer.from(text.encode(needle)));
function image(marker){const bytes=new Uint8Array(3000);bytes.set([137,80,78,71,13,10,26,10]);bytes.set(text.encode(marker),8);for(let i=8+marker.length;i<bytes.length;i++)bytes[i]=(i*7)&255;return bytes;}
async function personalProject(name,marker){
  const doc=new Y.Doc(),id=crypto.randomUUID();
  addEntries(doc,[{path:'main.tex',content:`\\documentclass{article}\\begin{document}${marker}\\end{document}`},{path:'figure.png',content:image('IMAGE_'+marker)}]);
  migrateProject(doc,id);doc.getMap('meta').set('name',name);await storage.saveProject(id,doc);doc.destroy();return id;
}
async function settled(engine,id,state='synced'){
  for(let i=0;i<400;i++){if(engine.status(id)?.state===state)return;await new Promise(r=>setTimeout(r,25));}
  assert.fail(`sync did not reach ${state}: ${JSON.stringify(engine.status(id))}`);
}
async function filesUnder(dir){
  const {readdir}=await import('node:fs/promises'),{join}=await import('node:path'),out=[];
  try{for(const entry of await readdir(dir,{withFileTypes:true,recursive:true}))if(entry.isFile())out.push(await readFile(join(entry.parentPath??entry.path,entry.name)));}catch{}
  return out;
}
const local=async id=>{const doc=await storage.loadProject(id);try{return{text:[...doc.share.keys()].filter(k=>k.startsWith('text:')).map(k=>doc.getText(k).toString()).join('\n')};}finally{doc.destroy();}};

test('the browser engine adds a personal project, uploads its image first, merges another member’s edit and stores nothing readable',async()=>{
  const s=await serverService();let engine;
  try{
    const id=await personalProject('Engine paper','ENGINE_MARKER');
    const changes=[];engine=orgServer({appOrigin:APP_ORIGIN,fetchImpl:fetch,onChange:x=>changes.push(x)});
    await signIn(engine,s,'ana');
    assert(orgServerConnected());assert.equal(engine.info.name,'Acme Lab');assert.equal(engine.info.email,'ana@acme.test');
    const added=await engine.add(id);
    await settled(engine,added.localId);
    assert.notEqual(added.localId,id);
    // The personal project stays as it was; the copy is the organisation project.
    assert.equal((await storage.listProjects()).filter(p=>p.name==='Engine paper').length,2);
    const ana=srClient(s.url,(await ssoLogin(s,'ana')).token);
    const list=(await ana.projects()).body.projects;assert.deepEqual(list.map(p=>[p.id,p.name,p.role]),[[added.project,'Engine paper','owner']]);
    // The update and the image it refers to are on the server; the image came first.
    const log=await ana.log(added.project,0);assert.equal(log.head,1);
    const copy=new Y.Doc();Y.applyUpdate(copy,log.frames[0].update);
    const ref=[...copy.getMap('assets').values()][0];
    assert.deepEqual((await ana.getObject(added.project,ref.hash)).bytes,image('IMAGE_ENGINE_MARKER'));
    assert(await s.sql(`SELECT min(o.created) <= min(e.received) FROM sr_objects o, sr_entries e WHERE o.project = '${added.project}' AND e.project = o.project`)==='t');
    // Nothing more is sent while nothing changed.
    await engine.sync(added.localId);assert.equal((await ana.log(added.project,0)).head,1);

    // Ben, invited by email, edits through the API; the engine merges his edit into the local copy.
    assert.equal((await engine.invite(added.project,'ben@acme.test','editor')).status,'pending');
    const ben=srClient(s.url,(await ssoLogin(s,'ben')).token);
    const fileText=[...copy.share.keys()].find(k=>k.startsWith('text:'));
    const theirs=new Y.Doc();Y.applyUpdate(theirs,log.frames[0].update);let update;theirs.on('update',u=>{update=u;});
    theirs.getText(fileText).insert(0,'% FROM_BEN\n');
    assert.equal((await ben.append(added.project,'ben-node',1,update)).status,201);
    await engine.sync(added.localId);await settled(engine,added.localId);
    assert.match((await local(added.localId)).text,/% FROM_BEN/);

    // A local edit goes up as one update after Ben's (no echo of his).
    const mine=await storage.loadProject(added.localId);mine.getText(fileText).insert(0,'% FROM_ANA\n');await storage.saveProject(added.localId,mine);mine.destroy();
    await engine.sync(added.localId);await settled(engine,added.localId);
    const after=await ben.log(added.project,0);assert.equal(after.head,3);
    const merged=new Y.Doc();for(const f of after.frames)Y.applyUpdate(merged,f.update);
    assert.match(merged.getText(fileText).toString(),/^% FROM_ANA\n% FROM_BEN\n/);
    // Its own entry is known as its own: the next catch-up skips it instead of merging it again.
    const link=(await engine.links())[0];assert(link.seq===3||link.mine.includes(3),JSON.stringify(link.mine));
    assert.equal(link.pushedSequence,(await storage.readCommittedProject(added.localId)).head.sequence);

    // Ben's role becomes viewer: Ana still owns it; Ben's further writes are refused.
    const benAccount=(await ana.project(added.project)).body.members.find(m=>m.email==='ben@acme.test').account;
    assert.equal((await engine.setMemberRole(added.project,benAccount,'viewer')).members.find(m=>m.account===benAccount).role,'viewer');
    assert.equal((await ben.append(added.project,'ben-node',2,update)).status,403);

    // Sealed at rest: the markers are in no database row and no blob file.
    // (pg_dump writes bytea as hex, so the markers are looked for as text and as hex.)
    const dump=(await pgDump(s.database)).toString();assert.match(dump,/sr_entries/);
    for(const marker of ['ENGINE_MARKER','IMAGE_ENGINE_MARKER','FROM_BEN','FROM_ANA'])assert(!dump.includes(marker)&&!dump.includes(Buffer.from(marker).toString('hex')),marker);
    for(const bytes of await filesUnder(s.config.data))for(const marker of ['ENGINE_MARKER','IMAGE_ENGINE_MARKER','FROM_ANA'])assert(!contains(bytes,marker),marker);
    copy.destroy();theirs.destroy();merged.destroy();
  }finally{if(engine)await engine.forget().catch(()=>{});await s.close();}
});

test('an online-only deployment keeps no local copy after sign-out and pauses editing without the server',async()=>{
  const s=await serverService({deployment:{offline:false}});let engine;
  try{
    const id=await personalProject('Online paper','ONLINE_MARKER');
    let clock=Date.now();engine=orgServer({appOrigin:APP_ORIGIN,fetchImpl:fetch,now:()=>clock});
    await signIn(engine,s,'ana');assert.equal(engine.info.offline,false);
    const added=await engine.add(id);await settled(engine,added.localId);
    assert.equal(engine.editingPaused(added.localId),'');
    // No answer from the server for 30 s: editing pauses with the design's sentence.
    clock+=31000;
    assert.equal(engine.editingPaused(added.localId),'Reconnecting — editing is paused because Acme Lab keeps projects online only.');
    await engine.sync(added.localId);assert.equal(engine.editingPaused(added.localId),'');
    // Sign-out revokes the session and deletes the local copy (the personal original stays).
    await engine.signOut();
    assert.deepEqual((await storage.listProjects()).filter(p=>p.name==='Online paper').map(p=>p.id),[id]);
    assert.equal((await storage.readCommittedProject(added.localId)).kind,'deleted');
    assert.deepEqual(await engine.links(),[]);
    const db=await openDB('scribyra-org-server');assert.equal((await db.getAll('outbox')).length,0);db.close();
    assert.equal(await s.sql("SELECT count(*) FROM sso_logins WHERE revoked"),'1');

    // A session the server stops accepting (revoked elsewhere) also takes the local copies.
    await signIn(engine,s,'ana');
    const again=await engine.add(id);await settled(engine,again.localId);
    await s.sql("UPDATE sso_logins SET revoked = true");
    await engine.sync(again.localId).catch(()=>{});
    for(let i=0;i<200&&(await engine.links()).length;i++)await new Promise(r=>setTimeout(r,25));
    assert.deepEqual(await engine.links(),[]);assert.equal((await storage.readCommittedProject(again.localId)).kind,'deleted');
    assert.equal(engine.info.signedIn,false);

    // Starting without a valid session (it expired while the browser was closed) erases them too.
    await signIn(engine,s,'ana');
    const third=await engine.add(id);await settled(engine,third.localId);
    const stored=await openDB('scribyra-org-server'),{expires}=await stored.get('connection','current');stored.close();
    engine.close();
    engine=orgServer({appOrigin:APP_ORIGIN,fetchImpl:fetch,now:()=>expires*1000+1});
    assert.equal(await engine.start(),true);
    assert.deepEqual(await engine.links(),[]);assert.equal((await storage.readCommittedProject(third.localId)).kind,'deleted');
    assert.deepEqual((await storage.listProjects()).filter(p=>p.name==='Online paper').map(p=>p.id),[id]);
  }finally{if(engine)await engine.forget().catch(()=>{});await s.close();}
});
