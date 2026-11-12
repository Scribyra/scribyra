#!/usr/bin/env python3
"""Re-query real browser-test evidence, including after a storage-stack restart."""
import argparse
import base64
import datetime
import json
from pathlib import Path
import re
import urllib.parse
import urllib.request

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--state', required=True, type=Path)
parser.add_argument('--port-base', type=int, default=18789)
args = parser.parse_args()
evidence = json.loads((args.state/'readback-evidence.json').read_text())
trace_id = evidence['traceId']
if not re.fullmatch('[a-f0-9]{32}', trace_id):
    raise SystemExit('Invalid evidence trace ID')

def query(offset, path, parameters=None):
    url = f'http://127.0.0.1:{args.port_base+offset}'+path
    if parameters:
        url += '?'+urllib.parse.urlencode(parameters)
    with urllib.request.urlopen(urllib.request.Request(url, headers={'Accept':'application/json'}), timeout=5) as response:
        body = response.read(8*1024*1024+1)
    if len(body)>8*1024*1024:
        raise SystemExit('Readback exceeds evidence budget')
    return json.loads(body)

instant = datetime.datetime.fromisoformat(evidence['verifiedAt'].replace('Z','+00:00')).timestamp()
metric = query(3, '/api/v1/query', {'query':'scribyra_operation_total{scribyra_operation="compile",scribyra_outcome="success"}', 'time':instant})
if not any(float(row['value'][1])>0 for row in metric.get('data',{}).get('result',[])):
    raise SystemExit('Stored compile metric missing')
logs = query(4, '/loki/api/v1/query_range', {'query':'{service_name="scribyra"} |= "'+trace_id+'"', 'start':evidence['since'], 'limit':1000})
events = [json.loads(body) for row in logs.get('data',{}).get('result',[]) for _,body,*_ in row['values']]
if not any(e.get('operation')=='compile' and e.get('outcome')=='success' and e.get('traceId')==trace_id for e in events):
    raise SystemExit('Stored compile log missing')
trace = query(6, '/api/traces/'+trace_id)
spans = [span for batch in trace.get('batches',trace.get('resourceSpans',[])) for scope in batch.get('scopeSpans',batch.get('instrumentationLibrarySpans',[])) for span in scope.get('spans',[])]
names = {span.get('name') for span in spans}
if not {'compile','tex_pass'} <= names:
    raise SystemExit('Stored compile/worker trace missing')
for span in spans:
    value = span['traceId']
    actual = value if re.fullmatch('[a-f0-9]{32}',value) else base64.b64decode(value,validate=True).hex()
    if actual!=trace_id:
        raise SystemExit('Trace correlation failed')
print(json.dumps({'source':evidence['source'],'metric':'verified','logs':'verified','trace':'verified','workerCorrelation':'verified'}))
