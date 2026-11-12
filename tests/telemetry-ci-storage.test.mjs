import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir,stat} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {telemetryReadback,eventDigest,traceSpans,hex} from './helpers/telemetry-readback.mjs';

// An operator-selected real private GitLab job, not a fabricated GITLAB_CI env.
// Opt-in only: ordinary unit tests never contact GitLab or managed Grafana.
test('authenticated GitLab job artifacts match retained CI metrics, logs and traces',{
 skip:!process.env.SCRIBYRA_TEST_CI_JOB||!process.env.SCRIBYRA_TEST_STORAGE_STATE,timeout:480000
},async()=>{
 const readback=await telemetryReadback(),retained=process.env.SCRIBYRA_TEST_CI_READBACK_ONLY==='1';
 const jobId=Number(process.env.SCRIBYRA_TEST_CI_JOB);assert(Number.isSafeInteger(jobId)&&jobId>0,'Select a numeric GitLab job');
 const directory=readback.state+'/ci-job-'+jobId;let records,proof,gitlabToken='';
 if(retained){proof=JSON.parse(await readFile(directory+'/evidence.json','utf8'));records=await Promise.all(proof.runs.map(async row=>JSON.parse(await readFile(directory+'/'+row.runId+'.json','utf8'))));}
 else{
  assert(process.env.SCRIBYRA_TEST_GITLAB_TOKEN_FILE,'Use an explicit private GitLab token file');
  const credential=await stat(process.env.SCRIBYRA_TEST_GITLAB_TOKEN_FILE);assert(credential.isFile()&&credential.size<=258&&!(credential.mode&0o077),'GitLab credential file must be owner-only and bounded');
  gitlabToken=(await readFile(process.env.SCRIBYRA_TEST_GITLAB_TOKEN_FILE,'utf8')).trim();assert(gitlabToken.length>=20&&gitlabToken.length<=256,'Use a bounded GitLab credential');
  const base='https://gitlab.com/api/v4/projects/88410471';
  async function gitlab(path,{anonymous=false,limit=1048576,text=false}={}){
   const response=await fetch(base+path,{redirect:'error',headers:anonymous?{}:{'PRIVATE-TOKEN':gitlabToken},signal:AbortSignal.timeout(30000)});
   if(anonymous){await response.body?.cancel();return response.status;}
   assert(response.ok,'Authenticated GitLab evidence request failed');let size=0;const chunks=[];
   for await(const chunk of response.body){size+=chunk.length;assert(size<=limit,'GitLab evidence exceeds byte budget');chunks.push(chunk);}
   const value=Buffer.concat(chunks).toString();return text?value:JSON.parse(value);
  }
  const project=await gitlab(''),job=await gitlab('/jobs/'+jobId);
  assert(project.id===88410471&&project.visibility==='private'&&project.pages_access_level==='private','Keep project and Pages private');
  assert(project.keep_latest_artifact===false,'Latest-artifact override must not bypass configured expiry');
  assert(job.id===jobId&&['success','failed','canceled'].includes(job.status),'Use a terminal actual job');
  const pipelineId=job.pipeline?.id,revision=job.commit?.id;assert(Number.isSafeInteger(pipelineId)&&/^[a-f0-9]{40}$/.test(revision),'Job provenance is required');
  const expires=Date.parse(job.artifacts_expire_at),finished=Date.parse(job.finished_at);assert(Number.isFinite(expires)&&Number.isFinite(finished)&&expires>finished&&expires-finished<=26*3600000,'Verify the actual one-day artifact expiry metadata');
  const trace=await gitlab('/jobs/'+jobId+'/trace',{text:true,limit:5242880}),ids=[...new Set([...trace.matchAll(/\{"runId":\s*"([a-f0-9]{32})"/g)].map(match=>match[1]))];
  assert(ids.length>0&&ids.length<=16,'Use bounded safe run IDs from the actual job trace');records=[];
  for(const runId of ids){
   const path='/jobs/'+jobId+'/artifacts/.telemetry/'+runId+'.json';
   assert.equal(await gitlab(path,{anonymous:true}),404,'Anonymous artifact requests must be denied');
   const raw=await gitlab(path,{text:true,limit:4096});
   const env=Object.fromEntries(Object.entries(process.env).filter(([key])=>!/(?:TOKEN|PASSWORD|SECRET|BW_SESSION)/i.test(key)));
   const validated=spawnSync('target/debug/scribyra-telemetry',['validate-run'],{input:raw,encoding:'utf8',timeout:10000,maxBuffer:8192,env});
   assert.equal(validated.status,0,'The shared Rust policy must accept the CI artifact');const record=JSON.parse(validated.stdout);
   assert(record.runId===runId&&record.source==='ci'&&record.ci?.projectId===88410471&&record.ci?.pipelineId===pipelineId&&record.ci?.jobId===jobId&&record.identity.revision===revision,'Artifact must match authenticated job provenance');
   records.push(record);
  }
  proof={version:1,projectId:88410471,pipelineId,jobId,revision,jobStatus:job.status,artifactsExpireAt:job.artifacts_expire_at,keepLatestArtifact:false,anonymousArtifactStatus:404,verifiedVia:'authenticated-gitlab-job-and-artifacts',runs:[]};
  await mkdir(directory,{recursive:true,mode:0o700});
  for(const record of records)await writeFile(directory+'/'+record.runId+'.json',JSON.stringify(record,null,2)+'\n',{mode:0o600});
 }
 assert(proof.jobId===jobId&&proof.projectId===88410471,'Retained evidence must match the selected job');
 const results=[];
 for(const record of records){
  console.log(JSON.stringify({jobId,runId:record.runId,suite:record.suite,phase:retained?'retained-query':'validated-artifact'}));
  const original=retained?proof.runs.find(row=>row.runId===record.runId):null;assert(!retained||original?.digest===eventDigest(record),'Retained artifact changed');
  const since=retained?original.ingestedSince:Date.now()/1000;
  if(!retained){const response=await fetch(`http://127.0.0.1:${readback.base}/v1/runs`,{method:'POST',redirect:'error',headers:{Authorization:'Bearer '+readback.token,'Content-Type':'application/json'},body:JSON.stringify(record),signal:AbortSignal.timeout(10000)});await response.body?.cancel();assert.equal(response.status,202,'Validated actual CI artifact must enter the existing run route');}
  const observedAt=retained?original.observedAt:undefined;
  const labels=`scribyra_source="ci",scribyra_suite="${record.suite}",scribyra_outcome="${record.outcome}"`;
  const query='scribyra_run_total{'+labels+'}';let metricTime=observedAt;
  await readback.poll(async()=>{const time=observedAt||Date.now()/1000;const response=await readback.metric('timestamp('+query+')',time);if(response.data.result.some(row=>Number(row.value[1])>=since-.001)){metricTime=time;return true;}return false;},Boolean,'Fresh actual CI metric missing');
  const metric=await readback.metric(query,metricTime);assert(metric.data.result.some(row=>Number(row.value[1])>=1),'Actual CI counter missing');
  if(record.counts){const cases=await readback.metric('scribyra_run_cases_total{'+labels+'}',metricTime);for(const key of ['passed','failed','skipped','cancelled','todo','flaky'])assert(cases.data.result.some(row=>row.metric.scribyra_case_outcome===key&&Number(row.value[1])>=record.counts[key]),'Actual CI case count missing');readback.privateData(cases,[gitlabToken]);}
  const logs=await readback.poll(()=>readback.logs('{service_name="scribyra"} |= "'+record.runId+'"',String(BigInt(record.startedUnixMs-1000)*1000000n)),response=>readback.events(response).some(value=>eventDigest(value)===eventDigest(record)),'Exact authenticated CI artifact missing from retained logs');
  const trace=await readback.poll(()=>readback.trace(record.runId),response=>traceSpans(response).some(span=>span.name==='test_run'&&hex(span.traceId)===record.runId),'Actual CI suite trace missing');
  readback.privateData({metric,logs,trace},[gitlabToken]);
  const span=traceSpans(trace).find(span=>span.name==='test_run'&&hex(span.traceId)===record.runId),attrs=Object.fromEntries(span.attributes.map(a=>[a.key,a.value.stringValue]));
  assert(attrs['scribyra.runtime']==='ci'&&attrs['scribyra.build.revision']===proof.revision&&attrs['scribyra.ci.project_id']==='88410471'&&attrs['scribyra.ci.job_id']===String(jobId)&&attrs['scribyra.ci.pipeline_id']===String(proof.pipelineId),'Stored trace must preserve actual CI context');
  const start=BigInt(record.startedUnixMs)*1000000n,expectedEnd=start+BigInt(Math.round(record.durationMs*1000000));
  const abs=n=>n<0n?-n:n;assert(abs(BigInt(span.startTimeUnixNano)-start)<=1000000n&&abs(BigInt(span.endTimeUnixNano)-expectedEnd)<=1000000n,'Original CI execution time must be preserved');
  results.push({runId:record.runId,suite:record.suite,outcome:record.outcome,counts:record.counts,digest:eventDigest(record),ingestedSince:since,observedAt:metricTime});
 }
 const view=(await readback.api('/api/dashboards/uid/scribyra-test-runs')).dashboard;
 assert(view.templating.list.find(v=>v.name==='source').options.some(v=>v.value==='ci'),'Deployed dashboard must expose actual CI filtering');
 const panel=view.panels.find(p=>p.type==='logs'&&p.title==='Safe run summaries and artifact IDs');assert(panel,'Actual CI log panel is required');
 const expr=panel.targets[0].expr.replace(/\$\{(\w+):regex\}/g,(_,name)=>name==='source'?'ci':'.*');
 const dashboardLogs=await readback.poll(()=>readback.logs(expr,String(BigInt(Math.min(...records.map(r=>r.startedUnixMs))-1000)*1000000n)),response=>records.every(record=>readback.events(response).some(value=>eventDigest(value)===eventDigest(record))),'Actual deployed CI panel query must return each authenticated artifact');
 readback.privateData(dashboardLogs,[gitlabToken]);
 proof.runs=results;proof.readbackVerifiedAt=new Date().toISOString();proof.checks=['authenticated-job-artifact-provenance','anonymous-artifacts-denied','actual-expiry-metadata','rust-schema','fresh-ci-metrics','case-counts','exact-safe-logs','correlated-ci-trace','original-ci-execution-time','actual-ci-dashboard-log-query','credentials-excluded'];
 await writeFile(directory+'/evidence.json',JSON.stringify(proof,null,2)+'\n',{mode:0o600});
});
