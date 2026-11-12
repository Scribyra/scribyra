// Reproduce the static architecture study against a running local preview.
// Uses disposable browser profiles; never reads the user's project database.
import { chromium, firefox, webkit } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';

const url = process.env.SCRIBYRA_STUDY_URL || 'http://127.0.0.1:4173';
const results = [];
for (const [name, browserType] of Object.entries({ chromium, firefox, webkit })) {
  const browser = await browserType.launch(name === 'chromium' ? {
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined,
    args: ['--no-sandbox'],
  } : {});
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(url);
    const capabilities = await page.evaluate(async () => {
      const result = {
        secureContext: isSecureContext,
        wasm: typeof WebAssembly === 'object',
        serviceWorker: 'serviceWorker' in navigator,
        indexedDB: 'indexedDB' in self,
        opfs: typeof navigator.storage?.getDirectory === 'function',
        directoryPicker: typeof self.showDirectoryPicker === 'function',
        fileSystemObserver: typeof self.FileSystemObserver === 'function',
        broadcastChannel: typeof BroadcastChannel === 'function',
        webRTC: typeof RTCPeerConnection === 'function',
        webCrypto: Boolean(crypto.subtle),
        crossOriginIsolated,
        sharedArrayBuffer: typeof SharedArrayBuffer === 'function',
      };
      if (result.opfs) {
        let root;
        const name = `scribyra-study-${crypto.randomUUID()}.txt`;
        try {
          root = await navigator.storage.getDirectory();
          const handle = await root.getFileHandle(name, { create: true });
          const stream = await handle.createWritable();
          await stream.write('Scribyra capability probe'); await stream.close();
          result.opfsRoundTrip = await (await handle.getFile()).text() === 'Scribyra capability probe';
        } catch (e) { result.opfsRoundTrip = `${e.name}: ${e.message}`; }
        finally { if (root) await root.removeEntry(name).catch(() => {}); }
      }
      if (result.broadcastChannel) {
        const name = `scribyra-study-${crypto.randomUUID()}`;
        const sender = new BroadcastChannel(name), receiver = new BroadcastChannel(name);
        result.broadcastRoundTrip = await new Promise(resolve => {
          const timer = setTimeout(() => resolve(false), 3000);
          receiver.onmessage = ({data}) => { clearTimeout(timer); resolve(data === 'probe'); };
          sender.postMessage('probe');
        });
        sender.close(); receiver.close();
      }
      if (result.webCrypto) {
        try {
          const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
          const iv = crypto.getRandomValues(new Uint8Array(12));
          const bytes = new TextEncoder().encode('Scribyra capability probe');
          const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, bytes);
          const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, encrypted);
          result.cryptoRoundTrip = new TextDecoder().decode(plain) === 'Scribyra capability probe';
          new Uint8Array(encrypted)[0] ^= 1;
          try { await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, encrypted); result.cryptoRejectsTamper = false; }
          catch { result.cryptoRejectsTamper = true; }
        } catch (e) { result.cryptoRoundTrip = `${e.name}: ${e.message}`; }
      }
      return result;
    });
    results.push({ browser: name, version: browser.version(), ...capabilities });
    await context.close();
  } finally { await browser.close(); }
}
const report = {
  measuredAt: new Date().toISOString(), origin: url, platform: process.platform,
  scope: 'Disposable headless Linux profiles. API presence except explicit round-trip probes. Not a mobile, permissions, networking, durability, or encryption-system audit.',
  results,
};
await mkdir('docs/measurements', { recursive: true });
await writeFile('docs/measurements/static-capabilities.json', JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
