import test from 'node:test';
import assert from 'node:assert/strict';
import {releaseNumber,releaseLabel,parseRelease,releaseTracker,handOver,SKIP_WAITING} from '../web/update-notice.js';
const own='a'.repeat(40),other='b'.repeat(40);
test('release names are web-<number> and nothing else',()=>{
 assert.equal(releaseNumber('web-81'),81);
 for(const value of ['web-0','web-081','web-','81','web-1.2',' web-5',null,undefined,81,'web-1234567890123'])assert.equal(releaseNumber(value),null,String(value));
 assert.equal(parseRelease({release:'web-3',revision:'nope'}).revision,null);assert.equal(parseRelease('web-3'),null);
});
test('an embedded release announces only strictly newer releases, and dismissal holds until a newer one',()=>{
 const tracker=releaseTracker({release:'web-80',revision:own});
 assert.equal(tracker.observe({release:'web-80',revision:own}),null);
 assert.equal(tracker.observe({release:'web-79',revision:other}),null);
 assert.equal(tracker.observe({release:'web-81',revision:own}),null,'its own revision is never newer');
 assert.equal(tracker.observe({release:'web-81',revision:other}).number,81);
 tracker.dismiss({number:81});assert.equal(tracker.observe({release:'web-81',revision:other}),null);
 assert.equal(tracker.observe({release:'web-82',revision:other}).number,82);
 assert.equal(tracker.observe({nonsense:true}),null);assert.equal(tracker.observe(null),null);
});
test('a build without an embedded release learns it only from its own revision',()=>{
 const tracker=releaseTracker({release:null,revision:own});
 assert.equal(tracker.observe({release:'web-90',revision:other}),null);assert.equal(tracker.current,null);
 assert.equal(tracker.observe({release:'web-90',revision:own}),null);assert.equal(tracker.current,90);
 assert.equal(tracker.observe({release:'web-91',revision:other}).number,91);
 const unknown=releaseTracker({});assert.equal(unknown.observe({release:'web-5',revision:other}),null);assert.equal(unknown.observe({release:'web-6',revision:other}),null);
});
test('a reload hands over to a waiting service worker explicitly, and never waits longer than its limit',async()=>{
 const tick=()=>new Promise(resolve=>setImmediate(resolve));
 const target=()=>{const listeners=new Map();return{listeners,addEventListener(type,f){(listeners.get(type)||listeners.set(type,new Set()).get(type)).add(f);},removeEventListener(type,f){listeners.get(type)?.delete(f);},emit(type){for(const f of[...(listeners.get(type)||[])])f();},count(){let n=0;for(const set of listeners.values())n+=set.size;return n;}};};
 const worker=state=>{const w=Object.assign(target(),{state,messages:[],postMessage(m){this.messages.push(m);},set(next){this.state=next;this.emit('statechange');}});return w;};
 const registration=(fields={})=>Object.assign(target(),{installing:null,waiting:null,active:worker('activated')},fields);
 const container=()=>Object.assign(target(),{controller:null});
 // Nothing waiting: reload straight away, nothing is asked.
 assert.equal(await handOver(registration(),{serviceWorker:container()}),true);
 assert.equal(await handOver(null,{serviceWorker:container()}),true);
 // A waiting worker is asked to take over; done only once it controls the tab and is activated.
 const next=worker('installed'),reg=registration({waiting:next}),sw=container();let result=null;
 const done=handOver(reg,{serviceWorker:sw}).then(value=>{result=value;});
 await tick();assert.deepEqual(next.messages,[{type:SKIP_WAITING}]);assert.equal(result,null);
 reg.waiting=null;reg.active=next;next.set('activating');sw.controller=next;sw.emit('controllerchange');await tick();assert.equal(result,null,'still activating');
 next.set('activated');await done;assert.equal(result,true);assert.equal(next.count()+sw.count()+reg.count(),0,'listeners removed');
 // A worker still installing is followed until it waits, then asked; a pending update check comes first.
 let release;const updating=new Promise(resolve=>{release=resolve;});
 const fresh=worker('installing'),later=registration({installing:fresh}),sw2=container();let second=null;
 const handed=handOver(later,{serviceWorker:sw2,updating}).then(value=>{second=value;});
 await tick();assert.equal(fresh.count(),0,'waits for the update check first');release();await tick();
 assert.deepEqual(fresh.messages,[]);later.installing=null;later.waiting=fresh;fresh.set('installed');await tick();assert.deepEqual(fresh.messages,[{type:SKIP_WAITING}]);
 later.waiting=null;later.active=fresh;fresh.set('activated');sw2.controller=fresh;sw2.emit('controllerchange');await handed;assert.equal(second,true);
 // A worker that never takes over gives way to the limit.
 let fire;const stuck=registration({waiting:worker('installed')});
 const limited=handOver(stuck,{serviceWorker:container(),setTimer:f=>{fire=f;return 1;},clearTimer(){}});await tick();fire();assert.equal(await limited,false);
});
test('staging releases are dev-<number>-<short revision> and never cross channels',()=>{
 assert.deepEqual(releaseLabel('dev-12-1a2b3c4'),{channel:'dev',number:12});assert.deepEqual(releaseLabel('web-12'),{channel:'web',number:12});
 for(const value of ['dev-12','dev-0-1a2b3c4','dev-12-XYZ1234','dev-12-1a2b3c','web-12-1a2b3c4','dev-012-1a2b3c4'])assert.equal(releaseLabel(value),null,value);
 const staging=releaseTracker({release:'dev-40-1a2b3c4',revision:own});assert.equal(staging.channel,'dev');
 assert.equal(staging.observe({release:'web-99',revision:other}),null,'production never announces on staging');
 assert.equal(staging.observe({release:'dev-41-abcdef0',revision:other}).number,41);
 const production=releaseTracker({release:'web-40',revision:own});assert.equal(production.observe({release:'dev-99-abcdef0',revision:other}),null);
 const local=releaseTracker({release:null,revision:own});assert.equal(local.observe({release:'dev-7-aaaaaaa',revision:own}),null);assert.equal(local.channel,'dev');
 assert.equal(local.observe({release:'web-8',revision:other}),null);assert.equal(local.observe({release:'dev-8-bbbbbbb',revision:other}).number,8);
});
