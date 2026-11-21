// The engine's memory ceiling: the declared maximum of the pinned busytex.wasm is raised at
// load time (scripts/wasm-memory.mjs), the glue's heap ceiling follows it, and each side picks
// a default that its platform can actually provide.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {scribyraHeapBytes,scribyraPatchMemory,scribyraWasmWithMemory} from '../scripts/wasm-memory.mjs';
import {engineMemoryLimit,engineMemoryMessage,engineOutOfMemory,ENGINE_MEMORY_MAX,ENGINE_MEMORY_SMALL} from '../web/compile-driver.js';

const ENGINE=new Uint8Array(readFileSync(new URL('../public/core/busytex/busytex.wasm',import.meta.url)));
// The defined memory's limits, read back from a module's memory section.
function memoryLimits(bytes){
 let at=8;const leb=()=>{let value=0,shift=0,byte;do{byte=bytes[at++];value+=(byte&127)*2**shift;shift+=7;}while(byte&128);return value;};
 while(at<bytes.length){const id=bytes[at++],size=leb(),end=at+size;if(id===5){leb();const flags=leb(),min=leb(),max=flags&1?leb():null;return{min,max};}at=end;}
 return null;
}

test('the pinned engine declares 64 MiB initially and the 576 MiB ceiling the limit replaces',()=>{
 assert.deepEqual(memoryLimits(ENGINE),{min:1024,max:9216});
 const glue=readFileSync(new URL('../public/core/busytex/busytex.js',import.meta.url),'utf8');
 assert.match(glue,/\(Module\['scribyraHeapMax'\] \|\| 603979776\);\n\s+var _emscripten_get_heap_max/);
 const pipeline=readFileSync(new URL('../public/core/busytex/busytex_pipeline.js',import.meta.url),'utf8');
 assert.match(pipeline,/this\.scribyra_heap_max = scribyraHeapBytes\(self\.scribyraMemoryBytes\);/);
 assert.match(pipeline,/scribyraHeapMax: this\.scribyra_heap_max,/);
});

test('the memory section is rewritten without touching anything else, and the module stays valid',async()=>{
 for(const bytes of [ENGINE_MEMORY_MAX,ENGINE_MEMORY_SMALL]){
  const patched=scribyraPatchMemory(ENGINE,bytes/65536);
  assert.deepEqual(memoryLimits(patched),{min:1024,max:bytes/65536});
  assert.ok(WebAssembly.validate(patched));
  // Streaming in small chunks gives the same bytes.
  const chunks=new ReadableStream({start(controller){for(let i=0;i<ENGINE.length;i+=4096)controller.enqueue(ENGINE.slice(i,i+4096));controller.close();}});
  const streamed=new Uint8Array(await (await scribyraWasmWithMemory(new Response(chunks),bytes)).arrayBuffer());
  assert.deepEqual(streamed,patched);
 }
 assert.equal(scribyraPatchMemory(ENGINE.subarray(0,1000),32767),null);
 assert.throws(()=>scribyraPatchMemory(new Uint8Array(16),32767),/Not a WebAssembly module/);
});

test('the ceiling is whole pages between the initial 64 MiB and 2 GiB - 64 KiB',()=>{
 assert.equal(ENGINE_MEMORY_MAX,2**31-65536);
 assert.equal(scribyraHeapBytes(undefined),ENGINE_MEMORY_MAX);
 assert.equal(scribyraHeapBytes(4*2**30),ENGINE_MEMORY_MAX);
 assert.equal(scribyraHeapBytes(1),64*1048576);
 assert.equal(scribyraHeapBytes(1024*1048576+1),1024*1048576);
});

test('browsers get 2 GiB on desktops and 1 GiB on phones, tablets and small devices',()=>{
 const desktop={userAgent:'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36',deviceMemory:8,maxTouchPoints:0};
 assert.equal(engineMemoryLimit(desktop),ENGINE_MEMORY_MAX);
 assert.equal(engineMemoryLimit({userAgent:'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/19.0 Safari/605.1.15',maxTouchPoints:0}),ENGINE_MEMORY_MAX);
 for(const nav of [
  {userAgent:'Mozilla/5.0 (iPhone; CPU iPhone OS 19_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/19.0 Mobile/15E148 Safari/604.1'},
  {userAgent:'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/19.0 Safari/605.1.15',maxTouchPoints:5}, // iPadOS
  {userAgent:'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Mobile Safari/537.36',deviceMemory:8},
  {...desktop,deviceMemory:2},
 ])assert.equal(engineMemoryLimit(nav),ENGINE_MEMORY_SMALL,nav.userAgent);
 assert.equal(engineMemoryLimit(undefined),ENGINE_MEMORY_MAX);
});

test('only the engine runtime\'s own report counts as running out of memory, and the message says what to do',()=>{
 assert.ok(engineOutOfMemory('/bin/busytex stderr: Cannot enlarge memory, requested 2147028992 bytes, but the limit is 2147418112 bytes!'));
 assert.ok(engineOutOfMemory('/bin/busytex stderr: Failed to grow the heap from 1 bytes to 2 bytes, not enough memory!'));
 assert.ok(!engineOutOfMemory('/bin/busytex stdout: Cannot enlarge memory (a \\typeout)'));
 assert.ok(!engineOutOfMemory('Cannot enlarge memory'));
 assert.match(engineMemoryMessage(ENGINE_MEMORY_MAX),/needs more memory than the TeX engine can use \(2047 MiB, the most this build of the engine can address\)\. Simplify the document or split it/);
 assert.match(engineMemoryMessage(ENGINE_MEMORY_SMALL),/\(1024 MiB on this device; 2047 MiB on a desktop computer\)/);
 assert.match(engineMemoryMessage(ENGINE_MEMORY_MAX,{refused:true}),/more memory than this browser could give the TeX engine \(it may use up to 2047 MiB\)\. Close other tabs/);
});
