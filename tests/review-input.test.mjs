import {test} from 'node:test';
import assert from 'node:assert/strict';
import {integrationSession} from './helpers/integration-session.mjs';
import {reviewInput,reviewProjection,reviewingSession} from '../web/review-input.js';
const ok=r=>{assert.equal(r.ok,true,JSON.stringify(r));return r.value;};
test('review typing groups input, supersedes once per burst, removes own insertion and preserves accepted source',async()=>{
 const f=await integrationSession();try{
  const source=f.source(),session=reviewingSession(f.context,'main'),count=f.doc.getMap('suggestions').size;
  let at=0;for(const char of '日本語😀 next'){session.input(at,at,char);at+=char.length;assert.equal(f.source(),source);}
  assert.equal(f.doc.getMap('suggestions').size,count);session.flush();assert.equal(f.doc.getMap('suggestions').size,count+1);
  const first=session.patches[0].id;session.input(at,at,'!');session.flush();const next=session.patches[0].id;
  assert.equal(f.doc.getMap('suggestions').get(next).supersedesId,first);assert.equal(f.reviews.status(f.doc.getMap('suggestions').get(first)),'withdrawn');
  session.input(0,at+1,'');session.flush();assert.equal(f.reviews.status(f.doc.getMap('suggestions').get(next)),'withdrawn');assert.equal(session.display().text,source);assert.equal(f.source(),source);
 }finally{await f.remove();}
});
test('projection maps Unicode replacements and protects another author while allowing adjacent source input',()=>{
 const p={key:'a',start:2,end:4,before:'cd',after:'😀Q',authorId:'other'},view=reviewProjection('abcdef',[p]);
 assert.equal(view.text,'ab😀Qef');assert.equal(view.toSource(5),4);assert.equal(view.toDisplay(6),7);
 assert.throws(()=>reviewInput('abcdef',[p],3,4,'x','me'),/other author/);
 const own=reviewInput('abcdef',[p],7,7,'z','me');assert.equal(reviewProjection('abcdef',own).text,'ab😀Qefz');
});
test('review deletion merges backspaces and undo-like insertion withdraws a published deletion',async()=>{
 const f=await integrationSession();try{const s=reviewingSession(f.context,'other');s.input(8,9,'');s.input(7,8,'');assert.equal(s.patches.length,1);s.flush();const id=s.patches[0].id;assert.equal(f.doc.getMap('suggestions').get(id).before,'ed');s.input(7,7,'ed');s.flush();assert.equal(s.display().text,'untouched');assert.equal(f.reviews.status(f.doc.getMap('suggestions').get(id)),'withdrawn');}finally{await f.remove();}
});
test('automatic revision refuses stale item identities and another proposer; explicit fresh proposals remain available',async()=>{
 const f=await integrationSession();try{
  const s=reviewingSession(f.context,'other');s.input(0,1,'U');s.flush();const id=s.patches[0].id,record=f.doc.getMap('suggestions').get(id);
  const foreign=await f.call({op:'suggestion.revise',reviewId:record.reviewId,fileId:'other',start:0,end:1,before:'u',after:'X',supersedesId:id},true);assert.equal(foreign.error.code,'permission_denied');
  f.doc.getText('text:other').delete(0,1);f.doc.getText('text:other').insert(0,'u');
  const stale=await f.call({op:'suggestion.revise',reviewId:record.reviewId,fileId:'other',start:0,end:1,before:'u',after:'X',supersedesId:id},false);assert.equal(stale.ok,false);assert.equal(f.doc.getText('text:other').toString(),'untouched');
  ok(await f.call({op:'suggestion.propose',reviewId:record.reviewId,fileId:'other',start:0,end:1,before:'u',after:'X',supersedesId:id},false));
 }finally{await f.remove();}
});

test('an unpublished draft cannot adopt replaced identities when an adjacent edit expands it',async()=>{
 const f=await integrationSession();try{const s=reviewingSession(f.context,'other');s.input(1,2,'N');f.doc.getText('text:other').delete(1,1);f.doc.getText('text:other').insert(1,'n');assert.throws(()=>s.input(0,1,''),/conflicted/);assert.throws(()=>s.flush(),/conflicted/);assert.equal(f.doc.getText('text:other').toString(),'untouched');assert.equal(f.doc.getMap('suggestions').size,0);}finally{await f.remove();}
});

test('conflicts retain exact text and rebase unaffected drafts by witness anchors',async()=>{
 const f=await integrationSession(),retained=[];
 try{
  const s=reviewingSession({...f.context,retainDraft:draft=>retained.push(draft)},'other');
  s.input(1,2,'N');s.input(7,8,'E');
  ok(await f.call({op:'agent.patchSource',edits:[{fileId:'other',start:1,end:2,before:'n',after:'AGENT'}]}));
  const before=s.display().text;s.rebase();assert.equal(retained.length,1);assert.equal(retained[0].text,before);assert.equal(retained[0].patches[0].after,'N');
  assert.equal(s.display().text,'uAGENTtouchEd');s.input(13,13,'!');s.flush();assert.equal(s.load().text,'uAGENTtouchEd!');
  assert.equal(f.doc.getText('text:other').toString(),'uAGENTtouched');
 }finally{await f.remove();}
});

test('editor transaction mismatch refuses draft mutation',async()=>{
 const f=await integrationSession();try{const s=reviewingSession(f.context,'other');assert.throws(()=>s.input(0,0,'YZ','ZYuntouched'),/projection differs/);assert.equal(s.display().text,'untouched');assert.equal(s.dirty,false);assert.equal(f.doc.getMap('suggestions').size,0);}finally{await f.remove();}
});

test('three authors share an insertion gap without losing the order selected by the editor',async()=>{
 let f=await integrationSession();try{
  const review=ok(await f.call({op:'review.create',title:'Three authors'}));
  const command={op:'suggestion.propose',reviewId:review.reviewId,fileId:'other',start:2,end:2,before:'',after:'XX'};
  ok(await f.call(command));
  ok(f.commands.execute({version:2,requestId:crypto.randomUUID(),projectId:f.projectId,expectedRevision:f.commands.revision(),command:{...command,after:'QQ'}},undefined,{actor:{author:{id:crypto.randomUUID(),displayName:'Third author',kind:'human'},sessionId:crypto.randomUUID()}}));
  const s=reviewingSession(f.context,'other'),before=s.display().text;
  s.input(4,4,'YZ');s.input(6,6,'!');const expected=before.slice(0,4)+'YZ!'+before.slice(4);assert.equal(s.display().text,expected);
  s.flush();assert.equal(s.load().text,expected);f=await f.reload();assert.equal(reviewingSession(f.context,'other').display().text,expected);
 }finally{await f.remove();}
});

test('unaffected insertion drafts rebase using their neighboring identities',async()=>{
 const f=await integrationSession(),retained=[];try{
  const s=reviewingSession({...f.context,retainDraft:d=>retained.push(d)},'other');s.input(6,6,'YZ');
  ok(await f.call({op:'agent.patchSource',edits:[{fileId:'other',start:0,end:1,before:'u',after:'UN'}]}));
  s.rebase();assert.equal(s.display().text,'UNntoucYZhed');assert.deepEqual(retained,[]);s.flush();assert.equal(s.load().text,'UNntoucYZhed');
 }finally{await f.remove();}
});

test('flush refuses a projection different from the editor and retains its exact text',async()=>{
 const f=await integrationSession(),retained=[];try{
  const s=reviewingSession({...f.context,retainDraft:d=>retained.push(d)},'other');s.input(0,0,'YZ');s.flush('ZYuntouched');assert.equal(f.doc.getMap('suggestions').size,0);assert.equal(retained[0].text,'ZYuntouched');assert.equal(s.dirty,false);
 }finally{await f.remove();}
});

test('exhausted insertion ranks refuse a transaction before draft state changes',()=>{
 const patches=[{key:'a',start:1,end:1,before:'',after:'X',authorId:'other',insertionOrder:1},{key:'b',start:1,end:1,before:'',after:'Q',authorId:'third',insertionOrder:1+Number.EPSILON}];
 assert.throws(()=>reviewInput('ab',patches,2,2,'YZ','me'),/insertion order is exhausted/);assert.equal(reviewProjection('ab',patches).text,'aXQb');
});

test('revising an older unranked proposal freezes its order across the new record identity',async()=>{
 let f=await integrationSession();try{
  const review=ok(await f.call({op:'review.create',title:'Existing proposals'},false)),command={op:'suggestion.propose',reviewId:review.reviewId,fileId:'other',start:2,end:2,before:'',after:'XX'};
  ok(await f.call(command,false));ok(await f.call({...command,after:'QQ'}));
  const s=reviewingSession(f.context,'other'),own=s.display().ranges.find(p=>p.authorId===f.owner.id),rank=parseInt(own.id.replaceAll('-','').slice(0,12),16)/0x1000000000000;
  s.input(own.from+1,own.from+1,'YZ');const expected=s.display().text;s.flush();const revised=s.patches.find(p=>p.authorId===f.owner.id);assert.equal(f.doc.getMap('suggestions').get(revised.id).insertionOrder,rank);assert.equal(s.load().text,expected);
  f=await f.reload();assert.equal(reviewingSession(f.context,'other').display().text,expected);
 }finally{await f.remove();}
});

test('adjacent insertion ranks survive production JSON validation and persisted reload exactly',async()=>{
 let f=await integrationSession();try{
  const review=ok(await f.call({op:'review.create',title:'Adjacent ranks'},false)),command={op:'suggestion.propose',reviewId:review.reviewId,fileId:'other',start:2,end:2,before:'',after:'XX'};
  const rank=0.46513919989131836,next=0.4651391998913184;
  const own=ok(await f.call({...command,insertionOrder:rank},false)),foreign=ok(await f.call({...command,after:'QQ',insertionOrder:next}));
  assert.equal(f.doc.getMap('suggestions').get(own.suggestionId).insertionOrder,rank);
  assert.equal(f.doc.getMap('suggestions').get(foreign.suggestionId).insertionOrder,next);
  const s=reviewingSession(f.context,'other');s.input(3,3,'YZ');const expected='unXYZXQQtouched';assert.equal(s.display().text,expected);s.flush();
  assert.equal(s.load().text,expected);f=await f.reload();assert.equal(reviewingSession(f.context,'other').display().text,expected);
 }finally{await f.remove();}
});

test('concurrent equal insertion ranks retain a revision instead of committing an unstable order',async()=>{
 const f=await integrationSession(),retained=[];try{
  const review=ok(await f.call({op:'review.create',title:'Concurrent gap'},false)),command={op:'suggestion.propose',reviewId:review.reviewId,fileId:'other',start:2,end:2,before:'',after:'XX',insertionOrder:0};
  ok(await f.call(command,false));ok(await f.call({...command,after:'QQ'}));
  const s=reviewingSession({...f.context,retainDraft:d=>retained.push(d)},'other'),own=s.display().ranges.find(p=>p.authorId===f.owner.id),count=f.doc.getMap('suggestions').size;
  s.input(own.from+1,own.from+1,'YZ');const expected=s.display().text;s.flush(expected);assert.equal(retained[0].text,expected);assert.match(retained[0].reason,/order is ambiguous/);assert.equal(f.doc.getMap('suggestions').size,count);
 }finally{await f.remove();}
});

test('ordered acceptance undo and redo retain surviving pending insertions',async()=>{
 const f=await integrationSession();try{
  const review=ok(await f.call({op:'review.create',title:'Undo boundary'},false)),ids=[];
  for(let i=0;i<3;i++)ids.push(ok(await f.call({op:'suggestion.propose',reviewId:review.reviewId,fileId:'other',start:2,end:2,before:'',after:String(i),insertionOrder:i},false)).suggestionId);
  const decide=async chosen=>ok(await f.call({op:'suggestion.accept',suggestionIds:chosen,eventHeads:Object.fromEntries(chosen.map(id=>[id,f.heads(id)]))},false));
  const batch=await decide([ids[1]]);assert.equal(reviewingSession(f.context,'other').display().text,'un012touched');
  ok(await f.call({op:'change.undo',changeId:batch.changeId,eventHeads:{[ids[1]]:f.heads(ids[1])}},false));assert.equal(reviewingSession(f.context,'other').display().text,'un012touched');
  ok(await f.call({op:'change.redo',changeId:batch.changeId,eventHeads:{[ids[1]]:f.heads(ids[1])}},false));assert.equal(reviewingSession(f.context,'other').display().text,'un012touched');
  await decide([ids[2],ids[0]]);assert.equal(f.doc.getText('text:other').toString(),'un012touched');
 }finally{await f.remove();}
});
