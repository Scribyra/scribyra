// Verify retained evidence, including the actual final page hash, without launching browsers.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
const data = JSON.parse(readFileSync(new URL('../results/human-delay.json', import.meta.url)));
const page = readFileSync(new URL('./field-test-before-wall-clock.html', import.meta.url));
assert.equal(createHash('sha256').update(page).digest('hex'), data.finalPageSha256);
const baseline = data.baseline.flatMap(run => run.rows);
assert.equal(baseline.length, 48);
assert.equal(baseline.filter(row => row.connected && row.bulkPassed).length, 42);
const ids = new Set();
let verified = 0;
for (const run of data.acceptance) {
  assert.equal(run.startOffsetMs, 1000);
  assert.equal(run.rows.length, 12);
  assert.deepEqual([...new Set(run.rows.map(row => row.delaySeconds))].sort((a,b) => a-b), [0,5,15,30,60,180]);
  for (const row of run.rows) {
    assert.ok(row.connected && row.bulkPassed && !row.error, row.key);
    assert.equal(row.a.result.bulk.bytes, 20*1048576);
    assert.equal(row.b.result.bulkRx.bytes, 20*1048576);
    assert.equal(row.beforeConnect.ice, 'new');
    assert.equal(row.beforeConnect.connection, 'new');
    assert.equal(row.b.result.camera, false);
    assert.equal(row.a.result.stun, false);
    assert.equal(row.b.result.stun, false);
    assert.deepEqual(row.a.errors, []);
    assert.deepEqual(row.b.errors, []);
    assert.equal(row.a.result.attemptId, row.b.result.attemptId);
    assert.ok(!ids.has(row.a.result.attemptId)); ids.add(row.a.result.attemptId);
    assert.ok(row.b.result.readyToStartMs >= row.delaySeconds*1000);
    assert.ok(Date.parse(row.b.result.connectClickedAt)-Date.parse(row.a.result.connectClickedAt) >= 1000);
    assert.equal(row.a.result.localCandidates.some(c => c.startsWith('udp host 10.77.0.10 ')), row.rawA);
    if (run.policy === 'nomcast') {
      assert.equal(row.b.result.typedFallback, true);
      const typed = row.b.result.events.find(e => e.event === 'typed-before-start');
      assert.ok(Date.parse(typed.at) < Date.parse(row.a.result.connectClickedAt));
    }
    verified++;
  }
}
assert.equal(verified, 96);
assert.equal(data.ui.length, 2);
for (const row of data.ui) { assert.equal(row.checks.length, 14); assert.ok(!row.error); }
console.log('PASS: historical 96 click-start trials, 48 baseline records, 28 UI checks, and previous-page SHA-256');
const timed = JSON.parse(readFileSync(new URL('../results/wall-clock.json', import.meta.url)));
const finalPage = readFileSync(new URL('../../../field-test.html', import.meta.url));
assert.equal(createHash('sha256').update(finalPage).digest('hex'), timed.finalPageSha256);
assert.equal(createHash('sha256').update(page).digest('hex'), timed.previousPageSha256);
function verifyRun(run, skew, smoke = false) {
  assert.equal(run.pageSha256,timed.finalPageSha256);
  assert.equal(run.startGapMs, 1000);
  assert.equal(run.variant, 'final');
  assert.equal(run.rows.length, smoke ? 1 : skew ? 14 : 6);
  assert.deepEqual([...new Set(run.rows.map(r=>r.delaySeconds))].sort((a,b)=>a-b), skew || smoke ? [0] : [0,30,180]);
  assert.deepEqual([...new Set(run.rows.map(r=>r.skewSeconds))].sort((a,b)=>a-b), skew ? [-5,-2,-1,0,1,2,5] : [0]);
  const cells = new Set();
  for (const row of run.rows) {
    assert.ok(!row.error, row.error);
    const cell = `${row.rawA}-${row.delaySeconds}-${row.skewSeconds}`;
    assert.ok(!cells.has(cell)); cells.add(cell);
    assert.equal(row.beforeConnect.ice, 'new'); assert.equal(row.beforeConnect.connection, 'new');
    for (const side of ['a','b']) {
      const r = row[side].result;
      assert.equal(r.version, 3); assert.equal(r.stun, false);
      assert.ok(r.armedAt && r.appliedAt && r.scheduledAAt && r.scheduledBAt);
      assert.equal(Date.parse(r.scheduledAAt)%30000, 0);
      assert.equal(Date.parse(r.scheduledBAt)-Date.parse(r.scheduledAAt), 1000);
      assert.ok(r.startLatenessMs >= 0 && r.startLatenessMs <= 1000);
      assert.ok(r.clockSamples.length && r.clockSamples.every(s=>s.includesCarryingTime && typeof s.apparentOffsetMs==='number'));
      assert.deepEqual(row[side].errors, []);
    }
    const a = row.a.result, b = row.b.result;
    assert.ok(Math.abs(row.realStartGapMs-(1000-row.skewSeconds*1000))<=1000);
    assert.equal(a.attemptId,b.attemptId); assert.ok(!ids.has(a.attemptId)); ids.add(a.attemptId);
    assert.equal(a.scheduledAAt,b.scheduledAAt);
    assert.ok(Date.parse(a.scheduledAAt)-Date.parse(a.armedAt)>=9900);
    assert.ok(b.readyToStartMs >= row.delaySeconds*1000);
    assert.equal(b.camera,false);
    assert.equal(a.localCandidates.some(c=>c.startsWith('udp host 10.77.0.10 ')), row.rawA);
    if (run.policy==='nomcast') {
      assert.equal(b.typedFallback,true); assert.ok(b.typedCandidates.length);
      assert.ok(Date.parse(b.events.find(e=>e.event==='typed-before-start').at)<=Date.parse(b.armedAt));
    }
    if (!skew || row.skewSeconds===0) assert.ok(row.connected && row.bulkPassed,row.key);
    if (row.connected) {
      assert.ok(row.bulkPassed,row.key); assert.equal(a.bulk.bytes,20*1048576); assert.equal(b.bulkRx.bytes,20*1048576);
    } else {
      assert.ok(a.failedAt || b.failedAt,row.key);
      assert.ok(a.diagnosis || b.diagnosis,row.key);
    }
  }
}
assert.equal(timed.acceptance.length,8); assert.equal(timed.skew.length,8);
for (const collection of [timed.acceptance,timed.skew]) {
  const pairings = new Set();
  for (const run of collection) {
    const pair = run.rows[0].key.split('-').slice(0,2).join('-');
    const key = run.policy+'-'+pair; assert.ok(!pairings.has(key)); pairings.add(key);
    verifyRun(run, collection===timed.skew);
  }
  for (const policy of ['open','nomcast']) for (const pair of ['firefox-firefox','chromium-chromium','firefox-chromium','chromium-firefox']) assert.ok(pairings.has(policy+'-'+pair));
}
assert.equal(timed.probes.length,2);
for (const run of timed.probes) { assert.equal(run.startOffsetMs,16000); assert.equal(run.rows.length,2); for (const row of run.rows) assert.ok(!row.connected && !row.error); }
assert.equal(timed.smoke.length,1); verifyRun(timed.smoke[0],false,true);
assert.equal(timed.ui.length,3);
for (const row of timed.ui) { assert.equal(row.pageSha256,timed.finalPageSha256); assert.equal(row.checks.length,35); assert.ok(!row.error,row.error); assert.deepEqual(row.errors,[]); }
console.log('PASS: 48 timed-start trials, 112 skew outcomes, 1 typed-wait smoke, 4 rejected-window probes, 105 UI checks, and final-page SHA-256');
