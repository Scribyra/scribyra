import {test} from 'node:test';
import assert from 'node:assert/strict';
test('controlled fixture whose raw diagnostics must stay private',()=>{
 assert.equal(process.env.SCRIBYRA_SYNTHETIC_FAIL,'0','PRIVATE_FAILURE_SOURCE_MARKER SECRET_HEADER_MARKER');
});
