#!/usr/bin/env python3
"""Run the pinned private single-node storage stack; Ctrl-C stops its processes.

State is retained for restarts. No Docker, Cloud account, public listener or TeX
download is required. Install tools explicitly with telemetry-tools.py first.
"""
import argparse
import fcntl
from collections import deque
import json
import os
from pathlib import Path
import secrets
import signal
import subprocess
import sys
import threading
import time
import urllib.request
import urllib.parse

ROOT = Path(__file__).resolve().parent.parent
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--state', type=Path, required=True)
parser.add_argument('--port-base', type=int, default=18789)
parser.add_argument('--origin', default='http://127.0.0.1:'+os.environ.get('SCRIBYRA_TEST_PORT', '4173'))
parser.add_argument('--ingress-binary', type=Path, default=ROOT/'target/debug/scribyra-telemetry', help='Explicit prebuilt ingress executable (release build for operated services)')
parser.add_argument('--grafana', action='store_true', help='Include private Grafana OSS with provisioned views/alerts')
parser.add_argument('--cloud', action='store_true', help='Run only ingress/Alloy, exporting to an explicitly configured Cloud OTLP endpoint')
args = parser.parse_args()
if args.cloud and args.grafana:
    parser.error('--cloud and --grafana are separate deployment profiles')
if not 1024 <= args.port_base <= 65525:
    parser.error('Choose a port base between 1024 and 65525')
state = args.state.resolve()
state.mkdir(parents=True, exist_ok=True, mode=0o700)
state.chmod(0o700)
lock = open(state/'stack.lock', 'a', opener=lambda p,f: os.open(p,f,0o600))
try:
    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
except BlockingIOError:
    parser.error('This state directory already has a running stack')
env = os.environ.copy()
env['SCRIBYRA_STATE'] = str(state)
pins = json.loads((ROOT/'ops/telemetry/tools.lock.json').read_text())
names = ['ingress', 'alloy', 'otlp', 'prometheus', 'loki', 'loki_grpc',
         'tempo', 'tempo_grpc', 'tempo_otlp']
if args.cloud:
    names = names[:3]
if args.grafana:
    names.append('grafana')
ports = {name: args.port_base+i for i, name in enumerate(names)}
urls = {name: f'http://127.0.0.1:{port}' for name, port in ports.items()}
for name in ([] if args.cloud else ['loki', 'loki_grpc', 'tempo', 'tempo_grpc', 'tempo_otlp']):
    env['SCRIBYRA_'+name.upper()+'_PORT'] = str(ports[name])
env.update(SCRIBYRA_OTLP_LISTEN=f'127.0.0.1:{ports["otlp"]}',
           SCRIBYRA_TELEMETRY_BIND=f'127.0.0.1:{ports["ingress"]}',
           SCRIBYRA_ALLOY_URL=urls['otlp'], SCRIBYRA_ALLOWED_ORIGINS=args.origin)
if args.cloud:
    endpoint = urllib.parse.urlsplit(env.get('SCRIBYRA_CLOUD_OTLP_URL',''))
    if endpoint.scheme!='https' or not endpoint.hostname or endpoint.username or endpoint.password or endpoint.query or endpoint.fragment:
        parser.error('Cloud mode requires an explicit HTTPS root/OTLP destination without credentials or query parameters')
    for name in ['SCRIBYRA_CLOUD_USERNAME_FILE','SCRIBYRA_CLOUD_TOKEN_FILE']:
        path = Path(env.get(name,''))
        if not path.is_file() or path.stat().st_mode & 0o077:
            parser.error('Cloud mode requires owner-only username/token runtime files')
    env['SCRIBYRA_INGRESS_SCRAPE'] = f'127.0.0.1:{ports["ingress"]}'
else:
    env.update(SCRIBYRA_PROMETHEUS_URL=urls['prometheus'],
               SCRIBYRA_LOKI_URL=urls['loki'], SCRIBYRA_TEMPO_OTLP_URL=urls['tempo_otlp'])
token_file = state/'ingress.token'
if not token_file.exists():
    with open(token_file, 'x', opener=lambda path, flags: os.open(path, flags, 0o600)) as f:
        f.write(secrets.token_hex(32))
token_file.chmod(0o600)
env['SCRIBYRA_INGRESS_TOKEN_FILE'] = str(token_file)
prom_config = state/'prometheus.yml'
if not args.cloud:
    prom_config.write_text((ROOT/'ops/telemetry/prometheus.yml').read_text().replace('${SCRIBYRA_INGRESS_PORT}', str(ports['ingress'])))
if args.grafana:
    password = state/'grafana-admin.password'
    if not password.exists():
        with open(password, 'x', opener=lambda p,f: os.open(p,f,0o600)) as f:
            f.write(secrets.token_urlsafe(32))
    password.chmod(0o600)
    grafana_config = (ROOT/'ops/telemetry/grafana/grafana.ini').read_text()
    values = {'SCRIBYRA_STATE':str(state), 'SCRIBYRA_GRAFANA_PORT':str(ports['grafana']),
              'SCRIBYRA_GRAFANA_PROVISIONING':str(ROOT/'ops/telemetry/grafana/provisioning')}
    for key,value in values.items():
        grafana_config = grafana_config.replace('${'+key+'}', value)
    (state/'grafana.ini').write_text(grafana_config)
    env.update(SCRIBYRA_TEMPO_URL=urls['tempo'],
               SCRIBYRA_GRAFANA_DASHBOARDS=str(ROOT/'ops/telemetry/grafana/dashboards'))
children = []
stopping = threading.Event()

def binary(name):
    path = ROOT/'.cache/telemetry-tools'/f'{name}-{pins[name]["version"]}'
    executable = path/pins[name]['executable'] if pins[name].get('directory') else path
    if not executable.is_file():
        raise RuntimeError(f'Install {name} with scripts/telemetry-tools.py first')
    return str(path)

def start(name, command, process_env=None):
    log = deque(maxlen=40)
    child = subprocess.Popen(command, env=process_env or env, cwd=ROOT, stdout=subprocess.PIPE,
                             stderr=subprocess.STDOUT)
    def drain():
        # Keep bounded diagnostics locally; do not publish raw service output.
        while block := child.stdout.read(1024):
            log.append(block)
    threading.Thread(target=drain, daemon=True).start()
    children.append((name, child, log))

def healthy(url):
    try:
        with urllib.request.urlopen(url, timeout=1) as response:
            return response.status == 200
    except Exception:
        return False

def stop(_signum=None, _frame=None):
    stopping.set()

signal.signal(signal.SIGINT, stop)
signal.signal(signal.SIGTERM, stop)
try:
    if not args.cloud:
        start('prometheus', [binary('prometheus'),
            '--config.file='+str(prom_config),
            '--web.listen-address=127.0.0.1:'+str(ports['prometheus']),
            '--web.enable-otlp-receiver', '--storage.tsdb.path='+str(state/'prometheus'),
            '--storage.tsdb.retention.time=7d', '--storage.tsdb.retention.size=512MB',
            '--log.level=warn'])
        start('loki', [binary('loki'), '-config.expand-env=true',
            '-config.file='+str(ROOT/'ops/telemetry/loki.yml')])
        start('tempo', [binary('tempo'), '-config.expand-env=true',
            '-config.file='+str(ROOT/'ops/telemetry/tempo.yml')])
    start('alloy', [binary('alloy'), 'run', '--disable-reporting',
          '--stability.level=experimental',
          '--server.http.listen-addr=127.0.0.1:'+str(ports['alloy']),
          '--storage.path='+str(state/'alloy'), str(ROOT/('ops/telemetry/cloud.alloy' if args.cloud else 'ops/telemetry/storage.alloy'))])
    start('ingress', [str(args.ingress_binary.resolve())])
    if args.grafana:
        home = binary('grafana')
        # This private profile owns Grafana's settings. Unrelated inherited GF_*
        # variables must not enable anonymous access, SMTP or external listeners.
        grafana_env = {key:value for key,value in env.items() if not key.startswith('GF_')}
        start('grafana', [str(Path(home)/'bin/grafana'), 'server', '--homepath='+home,
                         '--config='+str(state/'grafana.ini')], grafana_env)
    checks = [urls['alloy']+'/-/ready', urls['ingress']+'/health']
    if not args.cloud:
        checks.extend([urls['prometheus']+'/-/ready', urls['loki']+'/ready', urls['tempo']+'/ready'])
    if args.grafana:
        checks.append(urls['grafana']+'/api/health')
    deadline = time.monotonic()+90
    while not stopping.is_set():
        failed = next((name for name, child, _ in children if child.poll() is not None), None)
        if failed:
            # Configs contain no user data or credentials; retain a private bounded
            # startup log for local troubleshooting, never stdout or telemetry.
            name, _, log = next(row for row in children if row[0] == failed)
            with open(state/(name+'.startup.log'), 'wb', opener=lambda p,f: os.open(p,f,0o600)) as f:
                f.write(b''.join(log))
            raise RuntimeError(f'{name} exited; see its private startup log in the state directory')
        if all(healthy(url) for url in checks):
            break
        if time.monotonic() > deadline:
            raise RuntimeError('Storage readiness deadline exceeded')
        stopping.wait(.25)
    if not stopping.is_set():
        print(json.dumps({'event': 'ready', 'urls': urls, 'tokenFile': str(token_file)}), flush=True)
    while not stopping.wait(1):
        if any(child.poll() is not None for _, child, _ in children):
            raise RuntimeError('A storage process exited')
except Exception as error:
    print(str(error), file=sys.stderr)
    sys.exit(1)
finally:
    for _, child, _ in reversed(children):
        if child.poll() is None:
            child.terminate()
    for _, child, _ in reversed(children):
        try:
            child.wait(timeout=30)
        except subprocess.TimeoutExpired:
            child.kill()
            child.wait()
    for name, _, log in children:
        with open(state/(name+'.startup.log'), 'wb', opener=lambda p,f: os.open(p,f,0o600)) as f:
            f.write(b''.join(log))
