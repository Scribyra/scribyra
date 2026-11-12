import { readFile, writeFile, readdir, mkdir } from 'node:fs/promises';
import os from 'node:os';
const files = (await readdir('test-results')).filter(f => /^benchmarks-(chromium|firefox|webkit)\.json$/.test(f));
if (files.length !== 3) throw new Error('Run the full browser compilation matrix before generating the report; expected Chromium, Firefox and WebKit result files. Existing report preserved.');
const report = {
  capturedAt: new Date().toISOString(), cpu: os.cpus()[0].model, logicalCpus: os.cpus().length, memoryBytes: os.totalmem(), platform: `${os.platform()} ${os.release()}`,
  compiler: 'TeXlyre-BusyTeX 1.4.1 / TeX Live 2026',
  methodology: 'Single sequential sample per case on a loopback static server; cold means a newly initialized worker, not necessarily an empty HTTP/package cache. Article first sample has fresh browser storage. Warm reuses the live worker. Main-thread heap excludes compiler worker/WASM memory. Timer gap is a 16 ms interval probe, not a production latency percentile.',
  browsers: {},
};
for (const file of files) {
  const browser = file.match(/^benchmarks-(.+)\.json$/)[1];
  const rows = JSON.parse(await readFile(`test-results/${file}`,'utf8'));
  report.browsers[browser] = rows.map(row => Object.fromEntries(['fixture','engine','success','cold','durationMs','exitCode','bytes','mainThreadMaxTimerGapMs','mainThreadHeapBytes'].filter(k => row[k] !== undefined).map(k => [k, row[k]])));
}
await mkdir('docs/measurements',{recursive:true});
await writeFile('docs/measurements/browsers.json', JSON.stringify(report,null,2)+'\n');
console.log(`Recorded ${files.length} browser result sets in docs/measurements/browsers.json`);
