// Collect this worktree's retained wall-clock trials; historical evidence stays separate.
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
const root = process.env.SCRATCH;
if (!root) throw new Error('Set SCRATCH to the directory containing acceptance, skew, ui and probes.');
const runs = dir => readdirSync(`${root}/${dir}`).filter(f => f.endsWith('.json')).sort().map(f => JSON.parse(readFileSync(`${root}/${dir}/${f}`)));
const hash = path => createHash('sha256').update(readFileSync(new URL(path, import.meta.url))).digest('hex');
const output = new URL('../results/wall-clock.json', import.meta.url);
const retained = existsSync(output) ? JSON.parse(readFileSync(output)) : {};
const result = {
  finalPageSha256:hash('../../../field-test.html'),
  previousPageSha256:hash('./field-test-before-wall-clock.html'),
  conditions:'Separate Linux network namespaces, port 5191, no ICE servers. Raw Firefox uses a preference plus fake capture. One sample per cell; skew shifts B Date only, not monotonic time or timers.',
  acceptance:runs('acceptance'), skew:runs('skew'), probes:runs('probes'), smoke:runs('smoke'),
  preliminary:existsSync(`${root}/preliminary.json`) ? JSON.parse(readFileSync(`${root}/preliminary.json`)) : retained.preliminary || [],
  ui:JSON.parse(readFileSync(`${root}/ui/ui-check.json`)),
  limits:'No Firefox 151, real Wi-Fi, public HTTPS, real camera behavior, Safari/macOS/Windows or suspended-tab connectivity claim. Late-tab refusal is a simulated clock jump. A must convey its exact boundary to B after arming; no server can convey it automatically.'
};
writeFileSync(output, JSON.stringify(result, null, 2)+'\n');
console.log('Recorded', result.acceptance.reduce((n,r)=>n+r.rows.length,0), 'acceptance and', result.skew.reduce((n,r)=>n+r.rows.length,0), 'skew trials;', result.ui.reduce((n,r)=>n+r.checks.length,0), 'UI checks');
