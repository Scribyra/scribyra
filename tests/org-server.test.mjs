// The Node-level helpers for server-readable deployments that browser specs build on: a service
// with the local test provider and a fresh master key, sign-in without a browser, and the
// `/v1/sr/` client (create, append Yjs updates, read the log, objects, invitations, heads).
import './helpers/integration-session.mjs';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import * as Y from 'yjs';
import {readFile} from 'node:fs/promises';
import {serverService,compileService,ssoLogin,signIn} from './helpers/idp.mjs';
import {srClient,APP_ORIGIN,pgDump} from './helpers/service.mjs';
import * as storage from '../web/storage.js';
import {addEntries,migrateProject} from '../web/model.js';
import {orgServer,parseFrames,orgServerConnected,compiledTime,compiledBadge,compileChoice,compiledLatest} from '../web/org-server.js';
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

test('server compile: the badge, the choice of where a project compiles, and when a PDF is the latest',()=>{
  const at=new Date(2026,10,18,14,2).getTime();
  assert.equal(compiledTime(at),'18 Nov 14:02');assert.equal(compiledTime(new Date(2026,0,5,9,7).getTime()),'5 Jan 09:07');
  assert.equal(compiledBadge(at,true),'Compiled on server · 18 Nov 14:02 · from your latest changes');
  assert.equal(compiledBadge(at,false),'Compiled on server · 18 Nov 14:02 · from an older version');
  // A browser deployment (or one that does not say) changes nothing: today's compile.
  for(const deployment of ['browser',undefined,null,'other'])assert.equal(compileChoice({deployment,mode:'server',role:'owner'}),null);
  // `server`: every project, whatever its setting; only owners and editors compile; nobody switches.
  assert.deepEqual(compileChoice({deployment:'server',mode:'browser',role:'owner'}),{mode:'server',canCompile:true,canSwitch:false});
  for(const role of ['reviewer','viewer','admin'])assert.deepEqual(compileChoice({deployment:'server',mode:'server',role}),{mode:'server',canCompile:false,canSwitch:false});
  // `both`: the project's switch, which owners and editors change, guests not.
  assert.deepEqual(compileChoice({deployment:'both',mode:undefined,role:'editor'}),{mode:'browser',canCompile:true,canSwitch:true});
  assert.deepEqual(compileChoice({deployment:'both',mode:'server',role:'editor',accountRole:'guest'}),{mode:'server',canCompile:true,canSwitch:false});
  assert.deepEqual(compileChoice({deployment:'both',mode:'server',role:'viewer'}),{mode:'server',canCompile:false,canSwitch:false});
  // The latest: compiled at or after everything this copy holds from the server, nothing unsent.
  assert.equal(compiledLatest({seq:5,serverSeq:5,unsent:false}),true);
  assert.equal(compiledLatest({seq:6,serverSeq:5,unsent:false}),true);
  assert.equal(compiledLatest({seq:4,serverSeq:5,unsent:false}),false);
  assert.equal(compiledLatest({seq:5,serverSeq:5,unsent:true}),false);
  assert.equal(compiledLatest({seq:undefined,serverSeq:0,unsent:false}),false);
});

test('the engine compiles on the server at the version it uploaded, keeps the PDF, shows a TeX error’s log, and an online-only deployment deletes the PDF with the copy',async()=>{
  const s=await compileService();let engine;
  try{
    const id=await personalProject('Compile paper','COMPILEMARKER'),compiles=[];
    engine=orgServer({appOrigin:APP_ORIGIN,fetchImpl:fetch,onCompile:(localId,compile)=>compiles.push([localId,compile.state])});
    await signIn(engine,s,'ana');assert.equal(engine.info.compile,'both');
    const added=await engine.add(id);await settled(engine,added.localId);
    assert.equal(await engine.compileChoice(id),null,'a personal project compiles in the browser');
    assert.deepEqual(await engine.compileChoice(added.localId),{mode:'browser',canCompile:true,canSwitch:true,project:added.project,job:null,state:null});
    await assert.rejects(engine.compileOnServer(added.localId),/compiles in the browser/);
    assert.equal(await engine.setCompileMode(added.project,'server'),'server');
    // Switched back by someone else: a copy that still thinks `server` is refused and follows at once.
    const followed=compiles.length;
    assert.equal((await srClient(s.url,(await ssoLogin(s,'ana')).token).call('PUT',`/v1/sr/projects/${added.project}/settings`,{compile:'browser'})).status,200);
    if((await engine.compileChoice(added.localId)).mode==='server'){
      await assert.rejects(engine.compileOnServer(added.localId),/compiles in the browser now/);
      assert.equal((await engine.compileChoice(added.localId)).mode,'browser');
    }
    assert(compiles.length>followed,'the app was told');
    assert.equal(await engine.setCompileMode(added.project,'server'),'server');
    assert.equal((await engine.compileChoice(added.localId)).mode,'server');
    // An edit saved but not yet sent goes up before the compile, which runs at that version.
    const doc=await storage.loadProject(added.localId),file=[...doc.share.keys()].find(k=>k.startsWith('text:'));
    doc.getText(file).insert(0,'% SAVED_NOT_SENT\n');await storage.saveProject(added.localId,doc);
    const steps=[],done=await engine.compileOnServer(added.localId,{progress:text=>steps.push(text)});
    assert.equal(done.state,'done',done.log);assert.equal(steps[0],'Sending your changes to the server…');assert(steps.includes('Queued on server…'),steps.join());
    const ana=srClient(s.url,(await ssoLogin(s,'ana')).token),status=(await ana.call('GET',`/v1/sr/projects/${added.project}/compile`)).body;
    assert.equal(status.head,2);assert.equal(done.record.seq,2);assert.equal(status.pdf.job,done.record.job);assert.equal(status.pdf.fromHead,true);
    assert.equal(Buffer.from(done.record.bytes.subarray(0,5)).toString(),'%PDF-');
    assert.deepEqual((await engine.serverPdf(added.localId)).bytes,done.record.bytes);
    assert.equal(await engine.pdfLatest(added.localId),true);
    // The same files again: the server's cached PDF, which shows this version too.
    const again=await engine.compileOnServer(added.localId);assert.equal(again.cached,true);assert.equal(again.record.job,done.record.job);
    // A local edit makes the kept PDF one of an older version.
    doc.getText(file).insert(0,'\\undefinedservermacro\n');await storage.saveProject(added.localId,doc);doc.destroy();
    assert.equal(await engine.pdfLatest(added.localId),false);
    const failed=await engine.compileOnServer(added.localId);
    assert.equal(failed.state,'failed');assert.equal(failed.outcome,'tex_error');assert.match(failed.log,/Undefined control sequence/);
    assert.equal((await engine.compileStatus(added.localId)).state,'failed');
    assert.equal((await engine.serverPdf(added.localId)).job,done.record.job,'the last good PDF stays');
    assert.equal((await engine.refreshPdf(added.localId)).job,done.record.job);
    // The heads poll told the engine about the jobs (queued, running, finished).
    for(let i=0;i<400&&!compiles.some(([l,state])=>l===added.localId&&state==='failed');i++)await new Promise(r=>setTimeout(r,25));
    assert(compiles.some(([l,state])=>l===added.localId&&state==='failed'),JSON.stringify(compiles));
  }finally{if(engine)await engine.forget().catch(()=>{});await s.close();}
  // Online-only, compile `server`: every project compiles there, and sign-out deletes the PDF too.
  const o=await compileService({compile:'server',deployment:{offline:false}});
  try{
    const id=await personalProject('Online compile','ONLINECOMPILE');
    engine=orgServer({appOrigin:APP_ORIGIN,fetchImpl:fetch});
    await signIn(engine,o,'ana');
    const added=await engine.add(id);await settled(engine,added.localId);
    assert.deepEqual(await engine.compileChoice(added.localId),{mode:'server',canCompile:true,canSwitch:false,project:added.project,job:null,state:null});
    assert.equal((await engine.compileOnServer(added.localId)).state,'done');
    const db=await openDB('scribyra-org-server');assert.equal((await db.getAll('pdfs')).length,1);db.close();
    await engine.signOut();
    const after=await openDB('scribyra-org-server');assert.equal((await after.getAll('pdfs')).length,0);after.close();
    assert.equal(await engine.serverPdf(added.localId),null);
  }finally{if(engine)await engine.forget().catch(()=>{});await o.close();}
});
