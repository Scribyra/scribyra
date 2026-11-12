// Each driver owns one browser and HTTP server in its laptop namespace.
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import readline from 'node:readline';
const [repo, engine] = process.argv.slice(2);
const pw = createRequire(repo + '/package.json')('playwright');
const server = createServer((req, res) => {
  const file = req.url === '/final' ? repo + '/docs/reorientation/field-test.html' : new URL(['click-start', 'retry-a', 'trickle-a'].includes(req.url.slice(1)) ? './field-test-before-wall-clock.html' : './field-test-before-delay.html', import.meta.url);
  let html = readFileSync(file, 'utf8');
  if (req.url === '/retry-a') html = html.replace("log(a, 'answer-applied'); } catch", "log(a, 'answer-applied'); const retry = setInterval(() => { if (a.failed || a.channel?.readyState === 'open') return clearInterval(retry); a.peer.setRemoteDescription(a.peer.remoteDescription).catch(e => log(a, 'retry-error', e.message)); }, 3000); } catch");
  if (req.url === '/trickle-a') html = html.replace('setRemoteDescription(reply.description)', "setRemoteDescription({...reply.description, sdp:reply.description.sdp.replace(/^a=end-of-candidates\\r?\\n/gm, '').replace('a=mid:', 'a=ice-options:trickle\\r\\na=mid:')})");
  if (req.url === '/withhold' || req.url === '/coordinated' || req.url === '/trickle') html = html.replace("JSON.parse(atob($('offin').value.trim()))", "({...JSON.parse(atob($('offin').value.trim())), sdp:JSON.parse(atob($('offin').value.trim())).sdp.replace(/^a=(candidate:.*|end-of-candidates)\\r?\\n/gm,'')})");
  if (req.url === '/trickle') html = html.replace(".sdp.replace(/^a=", ".sdp.replace('a=mid:', 'a=ice-options:trickle\\r\\na=mid:').replace(/^a=");
  if (req.url === '/deferred') {
    html = html.replace('</section>\n<section><h2>Fallback', '<button id=start>Start connection on B</button></section>\n<section><h2>Fallback');
    html = html.replace("await pc.setLocalDescription(await pc.createAnswer());await gather();$('ans').value=btoa(JSON.stringify(pc.localDescription));R.localCandidates=cands(pc.localDescription.sdp);", "window.pendingAnswer=await pc.createAnswer();$('ans').value=btoa(JSON.stringify(pendingAnswer));R.localCandidates=cands(pendingAnswer.sdp);");
    html = html.replace("let answerPort;", "$('start').onclick=async()=>{await pc.setLocalDescription(pendingAnswer);};let answerPort;");
  }
  res.writeHead(200, { 'content-type': 'text/html', 'cache-control': 'no-store' });
  res.end(html);
});
await new Promise(r => server.listen(5191, '127.0.0.1', r));
const options = { headless: true };
if (engine === 'chromium') Object.assign(options, { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH, args: ['--no-sandbox', '--use-fake-device-for-media-stream'] });
if (engine === 'firefox') options.firefoxUserPrefs = { 'media.navigator.streams.fake': true, 'media.navigator.permission.disabled': true };
const browser = await pw[engine].launch(options);
let rawBrowser, rawBrowserPromise;
const pages = new Map();
const say = x => process.stdout.write(JSON.stringify(x) + '\n');
let finishing = false;
async function finish() { if (finishing) return; finishing = true; await browser.close(); await rawBrowser?.close(); server.close(); process.exit(0); }
readline.createInterface({ input: process.stdin }).on('line', async line => {
  const { id, op, key, ...arg } = JSON.parse(line);
  try {
    let result;
    if (op === 'new') {
      if (arg.raw && engine === 'firefox' && !rawBrowser) rawBrowser = await (rawBrowserPromise ||= pw.firefox.launch({ ...options, firefoxUserPrefs: { ...options.firefoxUserPrefs, 'media.peerconnection.ice.obfuscate_host_addresses': false } }));
      const activeBrowser = arg.raw && engine === 'firefox' ? rawBrowser : browser;
      const ctx = await activeBrowser.newContext(arg.raw && engine === 'chromium' ? { permissions: ['camera'] } : {});
      if (arg.skewSeconds) await ctx.addInitScript(skew => {
        const RealDate = Date;
        window.Date = class extends RealDate {
          constructor(...args) { super(...(args.length ? args : [RealDate.now()+skew*1000])); }
          static now() { return RealDate.now()+skew*1000; }
        };
      }, arg.skewSeconds);
      const page = await ctx.newPage();
      const errors = []; page.on('pageerror', e => errors.push(e.message));
      await page.goto('http://127.0.0.1:5191/' + arg.variant);
      pages.set(key, { page, ctx, errors });
      if (arg.raw) { await page.click('#cam'); await page.waitForFunction(() => document.getElementById('camout').textContent.includes('granted')); }
      result = true;
    } else if (op === 'quit') { say({ id, result: true }); return finish(); }
    else {
      const { page, ctx, errors } = pages.get(key);
      if (op === 'click') { await page.click('#' + arg.button); if (arg.waitFor) await page.waitForFunction(arg.waitFor); if (arg.read) { await page.waitForFunction(i => document.getElementById(i).value.length > 0, arg.read); result = await page.inputValue('#' + arg.read); } }
      if (op === 'fill') await page.fill('#' + arg.field, arg.value);
      if (op === 'eval') result = await page.evaluate(arg.code.startsWith('async ()') ? '(' + arg.code + ')()' : arg.code);
      if (op === 'state') result = await page.evaluate(() => ({ result: R, ice: pc?.iceConnectionState, connection: pc?.connectionState, channel: dc?.readyState, status: document.getElementById('status')?.textContent }));
      if (op === 'state') result.errors = errors;
      if (op === 'close') { await ctx.close(); pages.delete(key); }
    }
    say({ id, result });
  } catch (e) { say({ id, error: e.message }); }
}).on('close', finish);
process.on('SIGTERM', finish);
say({ ready: true, version: browser.version() });
