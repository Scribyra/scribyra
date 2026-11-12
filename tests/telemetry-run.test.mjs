import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,readFileSync,readdirSync,rmSync,writeFileSync,statSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

test('actual passing and failing suite processes export only shared-policy evidence and preserve exit status',()=>{
 const dir=mkdtempSync(join(tmpdir(),'scribyra-run-policy-'));
 try{
  const token=join(dir,'token');writeFileSync(token,'a'.repeat(64),{mode:0o600});
  for(const [suite,status,failed] of [['synthetic-pass',0,0],['synthetic-fail',1,1]]){
   const output=join(dir,suite);
   // An unavailable collector must preserve the real child exit code.
   const result=spawnSync('python3',['scripts/telemetry-run.py','--suite',suite,'--output',output,'--endpoint','http://127.0.0.1:1/v1/runs','--token-file',token],{encoding:'utf8',timeout:15000,env:{...process.env,GITLAB_CI:'false',GITHUB_ACTIONS:'false'}});
   assert.equal(result.status,status);
   const report=JSON.parse(result.stdout);assert.equal(report.delivery,'unavailable');assert.equal(report.source,'synthetic');
   const files=readdirSync(output).sort();assert.equal(files.length,2);
   const json=readFileSync(join(output,report.runId+'.json'),'utf8');
   const record=JSON.parse(json);assert.equal(record.exitCode,status);assert.equal(record.counts.total,1);assert.equal(record.counts.failed,failed);assert.equal(record.counts.passed,1-failed);
   const xml=readFileSync(join(output,report.runId+'.xml'),'utf8');
   assert.equal(xml.includes('<failure'),failed===1);
   assert(![json,xml,result.stdout,result.stderr].some(x=>/PRIVATE_FAILURE_SOURCE_MARKER|SECRET_HEADER_MARKER/.test(x)));
   for(const file of files)assert.equal(statSync(join(output,file)).mode&0o077,0);
  }
 }finally{rmSync(dir,{recursive:true,force:true});}
});
