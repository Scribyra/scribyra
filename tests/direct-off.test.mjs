import {test} from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
// Off means off (the owner's decision, 8 November 2026). The same deterministic operations, run
// by this tree with direct sessions never turned on, must store and export exactly what
// `main` (without any direct-session code) does. Regenerate the baseline from main with
// `node scripts/direct-off-baseline.mjs --ref=main --write`; a difference here is a change
// to what an ordinary project writes, never something to re-record without that check.
test('with direct sessions never turned on, a project is byte-for-byte what main produces',()=>{
 const run=JSON.parse(execFileSync(process.execPath,[new URL('./helpers/direct-off-scenario.mjs',import.meta.url).pathname],{encoding:'utf8'}));
 const {ref,commit,...main}=JSON.parse(readFileSync(new URL('../fixtures/direct-off-main.json',import.meta.url),'utf8'));
 assert.equal(ref,'main');assert.match(commit,/^[0-9a-f]{40}$/);
 assert.equal(run.generatedKeys,0,'a key was created');
 assert.deepEqual(run.opened,['scribyra-v1'],'another database was opened');
 assert.equal(run.directFields,false,'a direct-session field was written');
 assert.equal(run.authorId,main.authorId,'the local author ID differs from main');
 assert.deepEqual(run,main);
});
