import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';

// Explicit operator state only. Never retain response/error bodies or credentials
// in test failures/artifacts; individual scenarios project safe IDs and counts.
export async function telemetryReadback(){
 const state=process.env.SCRIBYRA_TEST_STORAGE_STATE;
 assert(state,'Select an explicitly started private telemetry stack');
 const base=Number(process.env.SCRIBYRA_TEST_STORAGE_PORT_BASE||18789),cloud=Boolean(process.env.SCRIBYRA_TEST_GRAFANA_URL);
 assert(Number.isInteger(base)&&base>=1024&&base<=65525,'Select a valid private stack port base');
 const grafana=(process.env.SCRIBYRA_TEST_GRAFANA_URL||`http://127.0.0.1:${base+9}`).replace(/\/$/,'');
 let target;try{target=new URL(grafana);}catch{assert.fail('Use a valid private Grafana root URL');}
 assert((target.protocol==='https:'||target.protocol==='http:'&&['127.0.0.1','localhost','[::1]'].includes(target.hostname))&&!target.username&&!target.password&&!target.search&&!target.hash&&target.pathname==='/','Grafana readback requires HTTPS or loopback HTTP without embedded credentials');
 const password=cloud?'':(await readFile(state+'/grafana-admin.password','utf8')).trim();
 const management=process.env.SCRIBYRA_TEST_GRAFANA_TOKEN||'';
 const tokenFile=state+'/ingress.token',token=(await readFile(tokenFile,'utf8')).trim();
 const authorization=cloud?'Bearer '+management:'Basic '+Buffer.from('operator:'+password).toString('base64');
 const source=process.env.SCRIBYRA_TELEMETRY_SOURCE||'local_test';
 assert(['local_test','ci','synthetic'].includes(source),'Automated evidence must have an explicit non-application source');
 async function api(path){
  if(cloud)for(const [a,b]of[['scribyra-prom','grafanacloud-prom'],['scribyra-loki','grafanacloud-logs'],['scribyra-tempo','grafanacloud-traces']])path=path.replace('/uid/'+a,'/uid/'+b);
  const response=await fetch(grafana+path,{redirect:'error',credentials:'omit',headers:{Authorization:authorization,Accept:'application/json'},signal:AbortSignal.timeout(10000)});
  assert(response.ok,`Private Grafana readback HTTP ${response.status}`);
  const chunks=[];let size=0;
  for await(const bytes of response.body){size+=bytes.length;if(size>8*1024*1024)throw Error('Readback response exceeds budget');chunks.push(bytes);}
  return JSON.parse(Buffer.concat(chunks).toString());
 }
 async function poll(read,check,description){
  const deadline=Date.now()+60000;
  do{try{const result=await read();if(check(result))return result;}catch{}await new Promise(r=>setTimeout(r,500));}while(Date.now()<deadline);
  assert.fail(description||'Stored native evidence did not satisfy the readback deadline');
 }
 async function logs(query,since,end){const params={query,start:since||String(BigInt(Date.now()-3600000)*1000000n),limit:'1000'};if(end)params.end=end;return api('/api/datasources/proxy/uid/scribyra-loki/loki/api/v1/query_range?'+new URLSearchParams(params));}
 const events=result=>result.data.result.flatMap(row=>row.values.map(([,body])=>JSON.parse(body)));
 const trace=id=>{assert(/^[a-f0-9]{32}$/.test(id),'Use a closed trace ID');return api('/api/datasources/proxy/uid/scribyra-tempo/api/traces/'+id);};
 const metric=(query,time=Date.now()/1000)=>api('/api/datasources/proxy/uid/scribyra-prom/api/v1/query?'+new URLSearchParams({query,time:String(time)}));
 async function freshMetric(query,since,time){const result=await metric('timestamp('+query+')',time);return result.data.result.some(row=>Number(row.value[1])>=Number(since)/1e9);}
 function privateData(value,extra=[]){const encoded=JSON.stringify(value);assert(![token,password,management,...extra].filter(Boolean).some(secret=>encoded.includes(secret)),'Private content/credentials must be absent from stored telemetry');}
 function nativeEnvironment(directory=''){
  const env={...process.env};
  for(const key of Object.keys(env))if(key.startsWith('SCRIBYRA_CLOUD_')||['SCRIBYRA_TEST_GRAFANA_TOKEN','SCRIBYRA_GRAFANA_TOKEN','BW_PASSWORD','BW_SESSION'].includes(key))delete env[key];
  const git=(...args)=>execFileSync('git',args,{encoding:'utf8',stdio:['ignore','pipe','ignore']}).trim();
  return {...env,SCRIBYRA_DIAGNOSTICS:'1',SCRIBYRA_DIAGNOSTICS_DIR:directory,SCRIBYRA_TELEMETRY_SOURCE:source,SCRIBYRA_TELEMETRY_SAMPLE_PERCENT:'100',SCRIBYRA_TELEMETRY_ENDPOINT:`http://127.0.0.1:${base}/v1/events`,SCRIBYRA_TELEMETRY_TOKEN_FILE:tokenFile,SCRIBYRA_BUILD_REVISION:git('rev-parse','HEAD'),SCRIBYRA_BUILD_DIRTY:git('status','--porcelain')?'1':'0'};
 }
 return{state,base,source,token,tokenFile,nativeEnvironment,endpoint:`http://127.0.0.1:${base}/v1/events`,api,poll,logs,events,trace,metric,freshMetric,privateData};
}
export function traceSpans(trace){return(trace.batches||trace.resourceSpans||[]).flatMap(batch=>(batch.scopeSpans||batch.instrumentationLibrarySpans||[]).flatMap(scope=>scope.spans||[]));}
export const hex=value=>/^[a-f0-9]{16}(?:[a-f0-9]{16})?$/.test(value)?value:Buffer.from(value,'base64').toString('hex');

// Stable only for the closed JSON records used by these tests. Not a signature
// or an authenticity claim; it detects changed stored values after restart.
function ordered(value){return Array.isArray(value)?value.map(ordered):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(key=>[key,ordered(value[key])])):value;}
export const eventDigest=value=>createHash('sha256').update(JSON.stringify(ordered(value))).digest('hex');
export function nativeChain(trace,record){
 const spans=traceSpans(trace),runtime=span=>(span.attributes||[]).find(a=>a.key==='scribyra.runtime')?.value.stringValue;
 const compile=spans.find(s=>s.name==='compile'&&hex(s.spanId)===record.compileSpanId&&hex(s.traceId)===record.traceId);
 const browser=compile&&spans.find(s=>s.name==='mcp'&&runtime(s)==='browser'&&hex(s.spanId)===record.browserMcpSpanId&&hex(s.spanId)===hex(compile.parentSpanId));
 const native=browser&&spans.find(s=>s.name==='mcp'&&runtime(s)==='companion'&&hex(s.spanId)===record.nativeMcpSpanId&&hex(s.spanId)===hex(browser.parentSpanId));
 const workers=spans.filter(s=>s.name==='worker_pass'&&hex(s.parentSpanId)===record.compileSpanId&&hex(s.traceId)===record.traceId);
 return Boolean(native&&spans.some(s=>s.name==='tex_pass'&&hex(s.traceId)===record.traceId&&workers.some(p=>hex(p.spanId)===hex(s.parentSpanId))));
}
