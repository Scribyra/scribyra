#!/usr/bin/env python3
"""Execute approved suites, validate a safe summary in Rust, optionally publish it.
Raw stdout/stderr, test names, paths and failure messages are never artifacts.
"""
import argparse
import xml.etree.ElementTree as ET
import glob
import json
import os
from pathlib import Path
import re
import shlex
import signal
import subprocess
import tempfile
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid

ROOT=Path(__file__).resolve().parent.parent
parser=argparse.ArgumentParser(description=__doc__)
parser.add_argument('--suite',required=True,choices=['rust','javascript','browser','browser-pages','build','synthetic-pass','synthetic-fail'])
parser.add_argument('--browser',choices=['chromium','firefox','webkit'],default='chromium')
parser.add_argument('--output',type=Path,default=ROOT/'.telemetry')
parser.add_argument('--endpoint')
parser.add_argument('--token-file',type=Path)
parser.add_argument('--timeout',type=int,default=3600)
args=parser.parse_args()
if not 1<=args.timeout<=86390:parser.error('Timeout must be 1–86390 seconds')
validator=ROOT/'target/debug/scribyra-telemetry'
if not validator.is_file():parser.error('Build scribyra-telemetry first; the shared Rust validator is required')
ci=os.environ.get('GITLAB_CI')=='true'
source='ci' if ci else 'synthetic' if args.suite.startswith('synthetic-') else 'local_test'
suite='browser' if args.suite.startswith('browser') else 'fault_validation' if args.suite.startswith('synthetic-') else args.suite
env=os.environ.copy();env['SCRIBYRA_TELEMETRY_SOURCE']=source;env.pop('FORCE_COLOR',None);env.pop('NODE_TEST_CONTEXT',None);env['NO_COLOR']='1'
run_id=uuid.uuid4().hex
def git(*arguments):return subprocess.check_output(['git',*arguments],cwd=ROOT,text=True,stderr=subprocess.DEVNULL).strip()
identity={'version':json.loads((ROOT/'package.json').read_text())['version'],'revision':git('rev-parse','HEAD'),'dirty':bool(git('status','--porcelain'))}
env['SCRIBYRA_BUILD_REVISION']=identity['revision'];env['SCRIBYRA_BUILD_DIRTY']='1' if identity['dirty'] else '0'
context=None
if ci:
 try:context={key:int(os.environ[name]) for key,name in [('projectId','CI_PROJECT_ID'),('pipelineId','CI_PIPELINE_ID'),('jobId','CI_JOB_ID')]}
 except (KeyError,ValueError):parser.error('GitLab CI identity is incomplete')

endpoint=None;token=None
if args.endpoint or args.token_file:
 if not args.endpoint or not args.token_file:parser.error('Publishing requires both endpoint and token file')
 endpoint=urllib.parse.urlsplit(args.endpoint)
 if (endpoint.scheme!='https' and not(endpoint.scheme=='http' and endpoint.hostname in ['127.0.0.1','localhost','::1'])) or endpoint.username or endpoint.password or endpoint.query or endpoint.fragment or endpoint.path!='/v1/runs':parser.error('Use an HTTPS /v1/runs endpoint or loopback HTTP without embedded credentials')
 if not args.token_file.is_file() or args.token_file.stat().st_size>66 or os.name=='posix' and args.token_file.stat().st_mode&0o077:parser.error('Ingest token file must be regular, bounded and owner-only')
 token=args.token_file.read_text().strip()
 if not re.fullmatch('[a-fA-F0-9]{64}',token):parser.error('Use a 64-hex ingest token')

class Parse:
 def __init__(self):self.rust=[];self.tap={};self.oversize=False;self.bytes=0
 def line(self,line):
  match=re.fullmatch(r'test result: (?:ok|FAILED)\. (\d+) passed; (\d+) failed; (\d+) ignored; \d+ measured; \d+ filtered out; finished in .+',line)
  if match:self.rust.append(tuple(map(int,match.groups())))
  match=re.fullmatch(r'# (tests|pass|fail|cancelled|skipped|todo) (\d+)',line)
  if match:self.tap[match[1]]=int(match[2])
 def drain(self,stream,parse=False):
  pending=b'';dropping=False
  while chunk:=stream.read(4096):
   if not parse:continue
   self.bytes+=len(chunk)
   if self.bytes>16*1024*1024:self.oversize=True;continue
   for part in chunk.splitlines(keepends=True):
    if not dropping:pending+=part
    if len(pending)>16384:pending=b'';dropping=True
    if part.endswith(b'\n'):
     if not dropping:self.line(pending.decode('utf8','replace').strip())
     pending=b'';dropping=False
 def counts(self):
  if self.oversize:return None
  if self.rust:
   passed=sum(row[0] for row in self.rust);failed=sum(row[1] for row in self.rust);skipped=sum(row[2] for row in self.rust)
   return dict(total=passed+failed+skipped,passed=passed,failed=failed,skipped=skipped,cancelled=0,todo=0,flaky=0)
  if set(self.tap)=={'tests','pass','fail','cancelled','skipped','todo'}:
   return dict(total=self.tap['tests'],passed=self.tap['pass'],failed=self.tap['fail'],skipped=self.tap['skipped'],cancelled=self.tap['cancelled'],todo=self.tap['todo'],flaky=0)
  return None

with tempfile.TemporaryDirectory(prefix='scribyra-safe-run-') as temporary:
 private=Path(temporary);summary=private/'counts.json';env['SCRIBYRA_RUN_SUMMARY_FILE']=str(summary)
 if args.suite=='rust':command=['cargo','test','-p','scribyra-core','-p','scribyra-telemetry','-p','scribyra-assets','-p','scribyra-companion','-p','scribyra-folders','-p','scribyra-sync','--locked','--color','never']
 elif args.suite=='javascript':
  patterns=shlex.split(json.loads((ROOT/'package.json').read_text())['scripts']['test'].rsplit(' && node --test ',1)[1]);files=[]
  for pattern in patterns:
   if not re.fullmatch(r'tests/[a-zA-Z0-9_*.-]+\.test\.mjs',pattern):parser.error('Unapproved JavaScript suite manifest')
   files.extend(sorted(glob.glob(pattern,root_dir=ROOT)))
  command=['node','--test','--test-reporter=tap',*files]
 elif suite=='browser':
  command=['npx','playwright','test',*(['tests/browser/pages.spec.js','tests/browser/pages-domains.spec.js','tests/browser/agent-surface.spec.js','tests/browser/agent-recipe.spec.js'] if args.suite=='browser-pages' else []),'--project='+args.browser,'--reporter=./scripts/telemetry-playwright-reporter.mjs','--trace=off','--output='+str(private/'browser-output')]
 elif args.suite=='build':command=['npm','run','build:pages']
 else:
  env['SCRIBYRA_SYNTHETIC_FAIL']='1' if args.suite=='synthetic-fail' else '0';command=['node','--test','--test-reporter=tap','tests/fixtures/telemetry-synthetic.mjs']
 started=int(time.time()*1000);clock=time.monotonic();process=subprocess.Popen(command,cwd=ROOT,env=env,stdout=subprocess.PIPE,stderr=subprocess.PIPE,start_new_session=os.name=='posix')
 reader=Parse();threads=[threading.Thread(target=reader.drain,args=(stream,parse),daemon=True) for stream,parse in [(process.stdout,True),(process.stderr,False)]]
 for thread in threads:thread.start()
 cancelled=False
 def cancel(*_):
  global cancelled
  if cancelled:return
  cancelled=True
  if process.poll() is None:
   if os.name=='posix':os.killpg(process.pid,signal.SIGTERM)
   else:process.terminate()
   def force():
    try:
     if os.name=='posix':os.killpg(process.pid,signal.SIGKILL)
     elif process.poll() is None:process.kill()
    except ProcessLookupError:pass
   killer=threading.Timer(5,force);killer.daemon=True;killer.start()
 signal.signal(signal.SIGTERM,cancel);signal.signal(signal.SIGINT,cancel)
 try:code=process.wait(timeout=args.timeout)
 except subprocess.TimeoutExpired:
  cancel()
  try:code=process.wait(timeout=5)
  except subprocess.TimeoutExpired:
   if os.name=='posix':os.killpg(process.pid,signal.SIGKILL)
   else:process.kill()
   code=process.wait()
 for thread in threads:thread.join(timeout=5)
 duration=(time.monotonic()-clock)*1000
 counts=None if suite=='build' else reader.counts()
 if summary.is_file() and summary.stat().st_size<=4096:
  try:counts=json.loads(summary.read_text())
  except (ValueError,OSError):counts=None
 record=dict(version=1,runId=run_id,source=source,suite=suite,identity=identity,startedUnixMs=started,durationMs=duration,outcome='cancelled' if cancelled or code<0 else 'success' if code==0 else 'failure',exitCode=code if code>=0 else None,counts=counts)
 if suite=='browser':record['browser']=args.browser
 if context:record['ci']=context
 validated=subprocess.run([str(validator),'validate-run'],input=json.dumps(record).encode(),capture_output=True,timeout=10)
 if validated.returncode:raise SystemExit('Run summary rejected by shared Rust policy; no artifact published')
 safe=json.loads(validated.stdout);args.output.mkdir(parents=True,exist_ok=True,mode=0o700)
 target=args.output/(run_id+'.json')
 with open(target,'x',opener=lambda p,f:os.open(p,f,0o600)) as output:output.write(json.dumps(safe,indent=2)+'\n')
 junit=ET.Element('testsuite',name=suite,tests='1',failures='1' if safe['outcome']=='failure' else '0',skipped='1' if safe['outcome']=='cancelled' else '0',time=str(duration/1000))
 case=ET.SubElement(junit,'testcase',name=suite,classname=source,time=str(duration/1000))
 if safe['outcome']=='failure':ET.SubElement(case,'failure',message='Suite process failed; see safe run summary').text='runId='+run_id
 elif safe['outcome']=='cancelled':ET.SubElement(case,'skipped',message='Suite process cancelled')
 with open(args.output/(run_id+'.xml'),'xb',opener=lambda p,f:os.open(p,f,0o600)) as output:output.write(ET.tostring(junit,encoding='utf-8',xml_declaration=True))
 delivery='off' 
 if endpoint:
  class NoRedirect(urllib.request.HTTPRedirectHandler):
   def redirect_request(self,*args,**kwargs):return None
  client=urllib.request.build_opener(NoRedirect);delivery='unavailable'
  body=json.dumps(safe,separators=(',',':')).encode()
  for attempt in range(3):
   try:
    with client.open(urllib.request.Request(args.endpoint,data=body,headers={'Authorization':'Bearer '+token,'Content-Type':'application/json'}),timeout=3) as response:
     if response.status==202:delivery='accepted';break
   except urllib.error.HTTPError as error:
    if error.code in [400,401,403,409,413]:delivery='rejected';break
   except Exception:pass
   if attempt<2:time.sleep(.25*(2**attempt))
 print(json.dumps({'runId':run_id,'source':source,'suite':suite,'outcome':safe['outcome'],'counts':counts,'durationMs':round(duration),'delivery':delivery}))
 raise SystemExit(130 if cancelled or code<0 else code)
