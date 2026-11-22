// The BusyTeX engine's WebAssembly memory limit, raised without rebuilding the engine.
//
// The pinned busytex.wasm (BusyTeX 1.4.1, Emscripten, ALLOW_MEMORY_GROWTH) defines its own
// memory: 1024 pages (64 MiB) initially, at most 9216 pages (576 MiB), the build's
// MAXIMUM_MEMORY. The Emscripten glue (busytex.js) repeats that maximum as getHeapMax(), the
// ceiling its heap growth (emscripten_resize_heap) and C's emscripten_get_heap_max() use.
// The compiled code itself does not depend on the maximum, so both can be raised at load time:
// scribyraWasmWithMemory rewrites the maximum in the memory section while the module streams
// in (the file on disk, and every checksum that pins it, stay as they are), and the glue reads
// Module.scribyraHeapMax. The glue was linked without Emscripten's 4 GB support (pointers above
// 2 GiB would turn negative in JavaScript), so the ceiling is 2 GiB minus one page, which is
// also Emscripten's own default maximum for growable memories.
// These functions are embedded verbatim in the pinned classic-script pipeline
// (scripts/patch-busytex.mjs), so they use nothing outside their arguments.

// Bytes the engine may use: whole pages, at least the initial 64 MiB, at most 2 GiB - 64 KiB.
function scribyraHeapBytes(requested) {
  const PAGE = 65536, MIN = 1024 * PAGE, MAX = 32767 * PAGE;
  const value = Number(requested);
  if (!Number.isFinite(value) || value <= 0) return MAX;
  return Math.min(MAX, Math.max(MIN, Math.floor(value / PAGE) * PAGE));
}

// A copy of `head` (the start of a .wasm binary) with the defined memory's maximum set to
// `pages`; null while `head` does not yet reach the end of the memory section; `head` itself
// when the module defines no memory with a maximum (nothing to change).
function scribyraPatchMemory(head, pages) {
  if (head.length < 8) return null;
  if (head[0] !== 0 || head[1] !== 0x61 || head[2] !== 0x73 || head[3] !== 0x6d) throw new Error('Not a WebAssembly module.');
  const leb = at => { let value = 0, shift = 0, byte; do { if (at >= head.length) return null; byte = head[at++]; value += (byte & 127) * 2 ** shift; shift += 7; } while (byte & 128 && shift < 35); return [value, at]; };
  const encode = value => { const out = []; do { let byte = value & 127; value = Math.floor(value / 128); if (value) byte |= 128; out.push(byte); } while (value); return out; };
  let at = 8;
  for (;;) {
    if (at >= head.length) return null;
    const id = head[at], sized = leb(at + 1);
    if (!sized) return null;
    const [size, body] = sized;
    if (id === 5) {
      if (body + size > head.length) return null;
      let p = body, count, flags, min, max;
      [count, p] = leb(p);
      if (count !== 1) return head;
      [flags, p] = leb(p); if (flags !== 1) return head;
      [min, p] = leb(p); [max, p] = leb(p);
      if (p !== body + size) return head;
      const section = [1, 1, ...encode(min), ...encode(Math.max(min, pages))];
      const patched = new Uint8Array(at + 1 + encode(section.length).length + section.length + head.length - (body + size));
      patched.set(head.subarray(0, at + 1));
      let out = at + 1;
      for (const byte of [...encode(section.length), ...section]) patched[out++] = byte;
      patched.set(head.subarray(body + size), out);
      return patched;
    }
    // Sections are ordered: past the memory section's place means no defined memory.
    if (id !== 0 && id > 5) return head;
    at = body + size;
  }
}

// A Response for WebAssembly.compileStreaming whose memory maximum is `bytes`: the body is
// buffered only until the memory section has passed, then streamed on unchanged.
async function scribyraWasmWithMemory(response, bytes) {
  const pages = Math.floor(bytes / 65536), reader = response.body.getReader();
  let head = new Uint8Array(0), patched = null;
  while (!(patched = scribyraPatchMemory(head, pages))) {
    const { value, done } = await reader.read();
    if (done) throw new Error('The compiler module ended before its memory section.');
    const next = new Uint8Array(head.length + value.length); next.set(head); next.set(value, head.length); head = next;
  }
  const body = new ReadableStream({
    start(controller) { controller.enqueue(patched); },
    async pull(controller) { const { value, done } = await reader.read(); if (done) controller.close(); else controller.enqueue(value); },
    cancel(reason) { return reader.cancel(reason); },
  });
  return new Response(body, { status: 200, headers: { 'content-type': 'application/wasm' } });
}

export { scribyraHeapBytes, scribyraPatchMemory, scribyraWasmWithMemory };
