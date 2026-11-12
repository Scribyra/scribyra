import {test} from 'node:test';
import assert from 'node:assert/strict';
import {telemetry,telemetryError} from '../web/telemetry.js';

function harness(options={}) {
 const events=[];let tick=0,seed=0;
 const recorder={configure(){},record(input){events.push(JSON.parse(input));return true;},snapshot:()=>JSON.stringify({events}),clear:()=>{events.length=0;},export:()=>JSON.stringify({events})};
 const api=telemetry({recorder,clock:()=>tick,random:bytes=>{bytes.fill(++seed);return bytes;},...options});
 return {api,events,time:value=>{tick=value;}};
}
test('disabled collection does not create IDs or touch the recorder',()=>{
 let generated=false;const {api,events}=harness({random:()=>{generated=true;throw Error('unavailable');}});
 api.begin('compile').end();assert.equal(generated,false);assert.deepEqual(events,[]);
});
test('parent/child operations correlate with distinct spans and finish once',()=>{
 const {api,events,time}=harness();api.configure({collect:true,allowExport:true});
 const parent=api.begin('compile');time(10);const child=api.begin('worker_pass',parent.context);
 time(50);child.end('failure','timeout');parent.end();parent.end('failure','unknown');
 assert.equal(events.length,4);
 assert.equal(events[1].traceId,events[0].traceId);assert.notEqual(events[1].spanId,events[0].spanId);
 assert.equal(events[1].parentSpanId,events[0].spanId);
 assert.deepEqual(events[2].metrics,[{name:'duration_ms',value:40}]);
 assert.equal(events[2].error,'timeout');assert.equal(events[3].outcome,'success');
});
test('blocked preference storage and unavailable diagnostics do not break operations',()=>{
 const failed=()=>{throw Error('SEEDED_SECRET');};
 const {api}=harness({storage:{getItem:failed,setItem:failed},recorder:{configure:failed,record:failed,clear:failed,snapshot:failed}});
 assert.doesNotThrow(()=>api.configure({collect:true}));
 assert.doesNotThrow(()=>api.begin('storage_commit').end('failure','quota'));
 assert.doesNotThrow(()=>api.clear());assert.equal(api.snapshot(),undefined);
});
test('only boolean controls persist and invalid stored settings are ignored',()=>{
 let stored;const {api}=harness({storage:{getItem:()=>'{"collect":"yes","url":"https://secret.invalid"}',setItem:(key,value)=>{stored={key,value};}}});
 assert.deepEqual(api.settings(),{collect:false,allowExport:false});
 api.configure({collect:true,allowExport:false,url:'https://secret.invalid',token:'SEEDED_SECRET'});
 assert.deepEqual(JSON.parse(stored.value),{collect:true,allowExport:false});assert.equal(stored.key,'scribyra:diagnostics:v1');
});
test('switching off collection suppresses completions already in progress',()=>{
 const {api,events}=harness();api.configure({collect:true});const work=api.begin('download');
 api.configure({collect:false});assert.equal(work.end(),false);assert.equal(events.length,1);
});
test('clearing or changing settings invalidates old operation completions',()=>{
 const {api,events}=harness();api.configure({collect:true});const work=api.begin('compile');
 api.clear();assert.equal(work.end(),false);assert.equal(events.length,0);
 assert.equal(api.begin('worker_pass',work.context).context,null);assert.equal(events.length,0);
 const second=api.begin('compile');api.configure({collect:false});api.configure({collect:true});
 assert.equal(second.end(),false);
 assert.equal(api.begin('worker_pass',second.context).context,null);
});
test('error classification excludes seeded private details and hostile getters',()=>{
 assert.equal(telemetryError({name:'QuotaExceededError',message:'PRIVATE_SOURCE',stack:'SEEDED_SECRET'}),'quota');
 assert.equal(telemetryError({name:'__proto__'}),'unknown');
 assert.equal(telemetryError({get name(){throw Error('SEEDED_SECRET');}}),'unknown');
 const {api}=harness({clock:()=>{throw Error('clock unavailable');}});api.configure({collect:true});
 assert.doesNotThrow(()=>api.begin('compile').end());
});
test('startup records actual pre-WASM initialization time on the session timeline',()=>{
 const {api,events,time}=harness({origin:0});api.configure({collect:true});time(50);
 const startup=api.begin('startup',null,0);time(75);startup.end();
 assert.equal(events[0].elapsedMs,0);assert.equal(events[1].elapsedMs,75);
 assert.deepEqual(events[1].metrics,[{name:'duration_ms',value:75}]);
});

test('remote correlation adopts only strict IDs and clearing invalidates adopted contexts',()=>{
 const {api,events}=harness();api.configure({collect:true});
 const remote={traceId:'a'.repeat(32),spanId:'b'.repeat(16)};
 const work=api.join('mcp',remote);work.end();
 assert.equal(events[0].traceId,remote.traceId);assert.equal(events[0].parentSpanId,remote.spanId);
 assert.notEqual(events[0].spanId,remote.spanId);assert.equal(events[1].outcome,'success');
 for(const context of [{...remote,traceId:'0'.repeat(32)},{...remote,spanId:'PRIVATE_TOKEN'},null]){
  const fallback=api.join('mcp',context);assert(fallback.context);fallback.end();assert.equal(events.at(-1).parentSpanId,undefined);
 }
 api.clear();assert.equal(api.begin('provider',work.context).context,null);
 api.configure({collect:false});assert.equal(api.join('mcp',remote).context,null);
});
