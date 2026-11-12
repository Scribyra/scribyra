#!/usr/bin/env python3
"""Run a safe suite with optional operator-configured CI publication."""
import os
import functools
import http.server
import threading
from pathlib import Path
import subprocess
import sys

if len(sys.argv)!=2 or sys.argv[1] not in ['rust','javascript','build','browser-pages']:
    raise SystemExit('Choose an approved CI suite: rust, javascript, build, browser-pages')
root=Path(__file__).resolve().parent.parent
command=[sys.executable,str(root/'scripts/telemetry-run.py'),'--suite',sys.argv[1]]
endpoint=os.environ.get('SCRIBYRA_CI_INGRESS_ENDPOINT')
token_file=os.environ.get('SCRIBYRA_CI_INGRESS_TOKEN_FILE')
if bool(endpoint)!=bool(token_file):
    raise SystemExit('CI publication requires both an endpoint and private ingest file variable')
if endpoint:
    command+=['--endpoint',endpoint,'--token-file',token_file]
if sys.argv[1]=='browser-pages':
    subprocess.check_call(['npm','run','fixtures'],cwd=root)
    class Quiet(http.server.SimpleHTTPRequestHandler):
        def log_message(self,*_):pass
    server=http.server.ThreadingHTTPServer(('127.0.0.1',0),functools.partial(Quiet,directory=str(root/'.pages')))
    thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
    env=os.environ.copy();env['SCRIBYRA_TEST_PAGES_URL']=f'http://127.0.0.1:{server.server_port}/'
    try:status=subprocess.call(command,cwd=root,env=env)
    finally:server.shutdown();server.server_close();thread.join(timeout=5)
else:status=subprocess.call(command,cwd=root)
raise SystemExit(status)
