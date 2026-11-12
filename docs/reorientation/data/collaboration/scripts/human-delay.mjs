import { spawn, execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import readline from 'node:readline';
import { createHash } from 'node:crypto';
const repo = process.env.REPO || '<repo>';
const scratch = process.env.SCRATCH || '<scratch>';
const here = new URL('.', import.meta.url).pathname;
const [variant = 'original', policy = 'open', delaysArg = '0,5,15,30,60,180', rawArg = 'both'] = process.argv.slice(2);
const delays = delaysArg.split(',').map(Number);
const skews = (process.env.SKEWS || '0').split(',').map(Number);
const deferred = ['final', 'click-start', 'retry-a', 'trickle-a'].includes(variant);
if (variant === 'deferred' && policy !== 'open') throw new Error('Use final for the typed-address experiment.');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const sh = (...args) => execFileSync(args[0], args.slice(1));
const children = [], drivers = [], hosts = [];
const result = { pageSha256:variant === 'final' ? createHash('sha256').update(readFileSync(repo+'/docs/reorientation/field-test.html')).digest('hex') : undefined, skews, startGapMs:1000, startOffsetMs: Number(process.env.START_OFFSET || 0), rawMethod: 'Fake camera grant; Firefox additionally disables host obfuscation because fake capture alone leaves mDNS candidates', variant, policy, started: new Date().toISOString(), delays, rows: [] };
mkdirSync(scratch + '/browser', { recursive: true });
const holder = spawn('sleep', ['infinity'], { cwd: scratch + '/browser' }); children.push(holder);
process.on('SIGTERM', async () => {
  for (const d of drivers) if (d.child.exitCode === null) d.child.kill('SIGTERM');
  await Promise.race([Promise.all(drivers.map(d => d.exited)), sleep(5000)]);
  for (const c of children) c.kill('SIGTERM');
  process.exit(143);
});
const save = () => writeFileSync(scratch + `/${variant}-${policy}-${delaysArg}-${rawArg}${process.env.PAIRS ? '-' + process.env.PAIRS : ''}${process.env.START_OFFSET ? '-offset' + process.env.START_OFFSET : ''}.json`, JSON.stringify(result, null, 2));
async function host(index) {
  const child = spawn('unshare', ['-n', 'sleep', 'infinity']); children.push(child); await sleep(100);
  const pid = String(child.pid), veth = 'v' + index;
  sh('ip', 'link', 'add', veth, 'type', 'veth', 'peer', 'name', 'eth0', 'netns', pid);
  sh('ip', 'link', 'set', veth, 'master', 'br0'); sh('ip', 'link', 'set', veth, 'up');
  const ns = (...args) => sh('nsenter', '-t', pid, '-n', ...args);
  ns('ip', 'link', 'set', 'lo', 'up'); ns('ip', 'link', 'set', 'eth0', 'up');
  const ip = '10.77.0.' + (10 + index); ns('ip', 'addr', 'add', ip + '/24', 'dev', 'eth0'); ns('ip', 'route', 'add', 'default', 'via', '10.77.0.1');
  sh('bridge', 'link', 'set', 'dev', veth, 'isolated', policy === 'isolated' ? 'on' : 'off', 'mcast_flood', policy === 'nomcast' ? 'off' : 'on');
  return { pid, ip };
}
async function driver(host, engine) {
  const child = spawn('nsenter', ['-t', host.pid, '-n', process.execPath, here + 'human-delay-agent.mjs', repo, engine], { stdio: ['pipe', 'pipe', 'inherit'], env: { ...process.env, TMPDIR: '/proc/' + holder.pid + '/cwd' } }); children.push(child);
  const exited = new Promise(resolve => child.once('exit', resolve));
  let sequence = 0, ready; const pending = new Map();
  const started = new Promise(r => ready = r);
  readline.createInterface({ input: child.stdout }).on('line', line => {
    const m = JSON.parse(line); if (m.ready) return ready(m);
    const p = pending.get(m.id); if (p) { pending.delete(m.id); clearTimeout(p.timer); m.error ? p.reject(new Error(m.error)) : p.resolve(m.result); }
  });
  child.on('exit', code => { for (const p of pending.values()) { clearTimeout(p.timer); p.reject(new Error('driver exit ' + code)); } pending.clear(); });
  const call = arg => new Promise((resolve, reject) => { const id = ++sequence; const timer = setTimeout(() => { pending.delete(id); reject(new Error('RPC timeout ' + JSON.stringify(arg))); }, 90000); pending.set(id, { resolve, reject, timer }); child.stdin.write(JSON.stringify({ id, ...arg }) + '\n'); });
  const info = await Promise.race([started, exited.then(code => { throw new Error('Driver exited before ready: ' + code); })]); const d = { call, info, engine, exited, child }; drivers.push(d); return d;
}
async function trial(A, B, raw, delay, skewSeconds) {
  const key = `${A.engine}-${B.engine}-${raw}-${delay}-skew${skewSeconds}`;
  const row = { key, rawA: raw, delaySeconds: delay, skewSeconds, aVersion: A.info.version, bVersion: B.info.version, timeline: [] };
  const mark = event => row.timeline.push({ event, at: new Date().toISOString() });
  const a = arg => A.call({ key, ...arg }), b = arg => B.call({ key, ...arg });
  try {
    await Promise.all([a({ op: 'new', variant, raw }), b({ op: 'new', variant, raw: false, skewSeconds })]);
    mark('create-invite'); const offer = await a({ op: 'click', button: 'mk', read: 'off' });
    await b({ op: 'fill', field: 'offin', value: offer }); mark('create-reply');
    const answer = await b({ op: 'click', button: 'rep', read: 'ans' }); mark('reply-ready');
    await sleep(delay * 1000); mark('delay-ended'); row.beforeConnect = await b({ op: 'state' });
    if (variant === 'restart') await b({ op: 'eval', code: 'pc.restartIce()' });
    if (variant === 'fresh-remote') await b({op:'eval',code:'pc.setRemoteDescription(pc.remoteDescription)'});
    if (['fresh', 'fresh-remote'].includes(variant)) { row.freshAnswer = await b({ op: 'eval', code: 'async () => {await pc.setLocalDescription(await pc.createAnswer()); return pc.localDescription.toJSON();}' }); }
    await a({ op: 'fill', field: 'ansin', value: ['fresh', 'fresh-remote'].includes(variant) ? Buffer.from(JSON.stringify(row.freshAnswer)).toString('base64') : answer });
    if (policy === 'nomcast' && deferred) { await b({ op: 'fill', field: 'ip', value: hosts[0].ip }); await b({ op: 'click', button: 'typed', waitFor:'R.typedFallback === true' }); }
    mark('connect');
    const offset = Number(process.env.START_OFFSET || 0);
    if (variant === 'final') {
      // B arms first and waits; A later conveys a time, without another Arm click.
      await b({op:'click',button:'start'});
      await a({op:'click',button:'acc'});
      const start = await a({op:'eval',code:"$('startout').value"});
      await b({op:'fill',field:'startin',value:start});
    } else {
      if (deferred && offset < 0) { await b({op:'click',button:'start'}); await sleep(-offset); }
      await a({ op: 'click', button: 'acc' });
      if (deferred && offset >= 0) { await sleep(offset); await b({op:'click',button:'start'}); }
    }
    if (variant === 'deferred') await b({op:'click',button:'start'});
    if (variant === 'coordinated') await b({ op: 'eval', code: `async () => {const d=JSON.parse(atob(${JSON.stringify(offer)})); for(const l of d.sdp.split(/\\r?\\n/).filter(l=>l.startsWith('a=candidate:'))) await pc.addIceCandidate({candidate:l.slice(2),sdpMid:'0'});}` });
    if (policy === 'nomcast' && !deferred && variant !== 'deferred') { await a({ op: 'fill', field: 'ip', value: hosts[1].ip }); await a({ op: 'click', button: 'typed' }); }
    const deadline = Date.now() + (variant === 'final' ? 70000 : 25000);
    do { await sleep(300); [row.a, row.b] = await Promise.all([a({ op: 'state' }), b({ op: 'state' })]); if ((row.a.channel === 'open' && row.b.channel === 'open') || (row.a.result.failedAt && row.b.result.failedAt)) break; } while (Date.now() < deadline);
    if (row.a.result.appliedAt && row.b.result.appliedAt) row.realStartGapMs = Date.parse(row.b.result.appliedAt)-row.skewSeconds*1000-Date.parse(row.a.result.appliedAt);
    row.connected = row.a.channel === 'open' && row.b.channel === 'open'; mark('connection-observed');
    if (row.connected) {
      await a({ op: 'click', button: 'bulk' }); const end = Date.now() + 30000;
      do { await sleep(300); row.a = await a({ op: 'state' }); if (row.a.result.bulk?.bytes === 20 * 1048576) break; } while (Date.now() < end);
      row.b = await b({ op: 'state' }); row.bulkPassed = row.a.result.bulk?.bytes === 20 * 1048576 && row.b.result.bulkRx?.bytes === 20 * 1048576;
    }
  } catch (e) { row.error = e.message; }
  finally { await Promise.allSettled([a({ op: 'close' }), b({ op: 'close' })]); result.rows.push(row); save(); console.log(key, row.connected, row.bulkPassed, row.error || ''); }
}
try {
  sh('ip', 'link', 'add', 'br0', 'type', 'bridge', 'mcast_snooping', '0'); sh('ip', 'link', 'set', 'br0', 'up'); sh('ip', 'addr', 'add', '10.77.0.1/24', 'dev', 'br0');
  hosts.push(await host(0), await host(1));
  // A separate server per namespace; one browser per side per pairing.
  for (const pair of (process.env.PAIRS || 'firefox-firefox,chromium-chromium,firefox-chromium,chromium-firefox').split(',').map(p => p.split('-'))) {
    const A = await driver(hosts[0], pair[0]), B = await driver(hosts[1], pair[1]);
    const tasks = (rawArg === 'both' ? [false, true] : [rawArg === 'true']).flatMap(raw => delays.flatMap(delay => skews.map(skew => () => trial(A, B, raw, delay, skew))));
    // Bound contexts even when a skew sweep adds conditions.
    await Promise.all(Array.from({length:Math.min(tasks.length, Number(process.env.CONCURRENCY || 6))}, async () => {
      while (tasks.length) await tasks.shift()();
    }));
    await Promise.all([A.call({ op: 'quit' }), B.call({ op: 'quit' })]); await Promise.all([A.exited, B.exited]);
  }
} finally { save(); for (const d of drivers) { if (d.child.exitCode === null) { d.child.stdin.end(); await d.exited; } } for (const c of children) c.kill('SIGTERM'); }

if (['final','click-start'].includes(variant) && result.rows.some(r => r.error || (r.connected && !r.bulkPassed) || (!r.connected && r.skewSeconds === 0))) process.exitCode = 1;
