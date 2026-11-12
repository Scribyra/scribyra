// Generates the history-format-1 fixtures with the code as it was before stored-history
// format 2 (commit 09502ca): a project typed key by key, so it has one change record per key,
// a full checkpoint every 50 saves and full-delete-set journal rows, plus a comment, a reply,
// a review with a suggestion, an undo and two named versions. Run from a checkout of that
// commit's web/ (with its web/pkg) placed at <dir>/web:
//   node tests/fixtures/history/make-legacy.mjs <dir> tests/fixtures/history
// Writes legacy-v7.json (every IndexedDB row of the project, bytes base64) and
// legacy-v1.scribyra-backup (its complete backup, format 1).
import 'fake-indexeddb/auto';
import {readFileSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {registerHooks} from 'node:module';
import {pathToFileURL} from 'node:url';
import * as Y from 'yjs';
const [dir,out]=process.argv.slice(2).map(p=>resolve(p));
const web=name=>pathToFileURL(join(dir,'web',name)).href;
let clock=Date.UTC(2026,9,1,9,0,0);Date.now=()=>clock;
const {initSync}=await import(web('pkg/scribyra_app.js'));initSync({module:readFileSync(join(dir,'web/pkg/scribyra_app_bg.wasm'))});
(await import(web('collaboration-schema.js'))).initializeCollaborationSchema();
registerHooks({load(url,context,next){return url.endsWith('.css')?{format:'module',source:'',shortCircuit:true}:next(url,context);}});
const storage=await import(web('storage.js')),{addEntries,migrateProject,projectFiles}=await import(web('model.js')),{anchors}=await import(web('comment-anchors.js'));
const {collaborationCommands}=await import(web('collaboration-commands.js')),{reviewService}=await import(web('review-commands.js')),{registerComments}=await import(web('comments.js'));
const {changeOrigins}=await import(web('change-origins.js')),{mount}=await import(web('history.js')),{cloneProject}=await import(web('assets.js'));
const projectId='0f8e2a52-6a51-4c4b-9d0c-3f4a3c2b1a00',doc=new Y.Doc();
doc.getMap('meta').set('name','Legacy typed project');
addEntries(doc,[{path:'main.tex',content:'\\documentclass{article}\n\\begin{document}\n\\input{intro}\n\\end{document}\n'},{path:'intro.tex',content:'Introduction.\n'},{path:'figure.png',content:new Uint8Array([137,80,78,71,1,2,3,4])}]);
migrateProject(doc,projectId);doc.getMap('meta').set('mainFile',projectFiles(doc).find(f=>f.path==='main.tex').id);
await storage.saveProject(projectId,doc);
const author={id:'5b7c9d1e-2f3a-4b5c-8d6e-7f8091a2b3c4',kind:'human',displayName:'Legacy author'},managers=new Map(),intro=projectFiles(doc).find(f=>f.path==='intro.tex').id,main=projectFiles(doc).find(f=>f.path==='main.tex').id;
const undo=new Y.UndoManager(doc.getText('text:'+intro),{trackedOrigins:new Set([null])});managers.set(intro,undo);
const flushSave=async()=>{const frozen=cloneProject(doc);try{const saved=await storage.saveProject(projectId,frozen);Y.applyUpdate(doc,saved.update,'saved');}finally{frozen.destroy();}};
const context={doc,projectId,author,sessionId:'6c8d0e2f-3a4b-4c5d-9e6f-8091a2b3c4d5',anchors,storage,managers,flushSave,locks:{request:(_n,_o,run)=>run()}};
context.origins=changeOrigins({doc,managers,remote:['saved']});const commands=collaborationCommands(context);context.commands=commands;
const reviews=reviewService(context),comments=registerComments(context),history=mount(context);
const call=async command=>{const reply=await commands.execute({version:2,requestId:crypto.randomUUID(),projectId,expectedRevision:commands.revision(),command});if(!reply.ok)throw new Error(command.op+': '+reply.error.message);return reply.value;};
async function type(fileId,words,pace=220){const text=doc.getText('text:'+fileId);for(const ch of words){const at=fileId===main?text.toString().indexOf('\\end{document}'):text.length;doc.transact(()=>text.insert(at,ch));clock+=pace;await flushSave();}}
await type(intro,'We study bounded models. ');clock+=90_000;
await type(intro,'Results follow. ');clock+=600_000;await type(intro,'Further evidence supports this claim. ');
await call({op:'thread.create',fileId:intro,start:0,end:12,body:'Is this the right opening?'});
await type(main,'% draft\n');clock+=30_000;
await call({op:'history.name',label:'First draft'});await flushSave();
undo.stopCapturing();await type(intro,'Typo here');undo.stopCapturing();clock+=2000;undo.undo();await flushSave();
const {reviewId}=await call({op:'review.create',title:'Wording'});
const text=doc.getText('text:'+intro).toString(),at=text.indexOf('bounded');if(at<0)throw new Error(JSON.stringify(text));
await call({op:'suggestion.propose',reviewId,fileId:intro,start:at,end:at+7,before:'bounded',after:'stable'});
clock+=3*86_400_000;await type(intro,'More text after three days. ');
await call({op:'history.name',label:'Submitted'});await flushSave();
const backup=await call({op:'backup.export'}),bytes=[];for(let offset=0;offset<backup.size;){const part=await call({op:'artifact.read',artifactId:backup.artifactId,offset,limit:65536});bytes.push(history.readAttachment(part.attachmentRef));offset=part.nextOffset;}
writeFileSync(join(out,'legacy-v1.scribyra-backup'),Buffer.concat(bytes));
const db=await new Promise((ok,fail)=>{const r=indexedDB.open('scribyra-v1');r.onsuccess=()=>ok(r.result);r.onerror=()=>fail(r.error);});
const stores={};for(const name of db.objectStoreNames){stores[name]=await new Promise(ok=>{const r=db.transaction(name).objectStore(name).getAll();r.onsuccess=()=>ok(r.result);});}
const keys={};for(const name of db.objectStoreNames){const store=db.transaction(name).objectStore(name);keys[name]={keyPath:store.keyPath,indexes:[...store.indexNames].map(index=>({name:index,keyPath:store.index(index).keyPath}))};}
const json=JSON.stringify({generatedBy:'tests/fixtures/history/make-legacy.mjs at 09502ca',version:db.version,projectId,changes:doc.getMap('changes').size,stores,keys},(k,v)=>v instanceof Uint8Array?{$b64:Buffer.from(v).toString('base64')}:v);
writeFileSync(join(out,'legacy-v7.json'),json);
console.log(JSON.stringify({version:db.version,changes:doc.getMap('changes').size,backupBytes:backup.size,rows:Object.fromEntries(Object.entries(stores).map(([k,v])=>[k,v.length])),jsonBytes:json.length}));
history.close();comments.close();reviews.close();commands.close();context.origins.close();process.exit(0);
