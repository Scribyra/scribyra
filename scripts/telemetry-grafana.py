#!/usr/bin/env python3
"""Provision only Scribyra's private dashboard folder using a management token.

Credentials are read from an environment variable, never arguments or artifacts.
Optional --run-links adds only two named fields to the selected Loki datasource.
Other datasource settings and notification policies are preserved.
"""
import argparse
import json
import os
from pathlib import Path
import urllib.error
import urllib.parse
import urllib.request

ROOT = Path(__file__).resolve().parent.parent
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--url', required=True)
parser.add_argument('--profile', choices=['cloud', 'self-hosted'], default='cloud')
parser.add_argument('--token-env', default='SCRIBYRA_GRAFANA_TOKEN')
parser.add_argument('--apply', action='store_true')
parser.add_argument('--alerts', action='store_true', help='Provision the seven dashboard-only Cloud alert rules without sending notifications')
parser.add_argument('--run-links', action='store_true', help='Also configure the two named Loki run links; requires datasource write access')
args = parser.parse_args()
base = args.url.rstrip('/')
url = urllib.parse.urlsplit(base)
if (url.scheme != 'https' and not (url.scheme=='http' and url.hostname in ['127.0.0.1','localhost','::1'])) or url.username or url.password or url.query or url.fragment or url.path:
    parser.error('Use an HTTPS root URL, or HTTP loopback')
token = os.environ.get(args.token_env)
if not token:
    parser.error('The management-token environment variable is missing')
mapping = {'scribyra-prom':'grafanacloud-prom','scribyra-loki':'grafanacloud-logs','scribyra-tempo':'grafanacloud-traces'} if args.profile=='cloud' else {}
folder = 'scribyra-telemetry'

class ApiError(Exception):
    def __init__(self, status, method='GET', path=''):
        self.status = status
        super().__init__(f'Grafana API returned HTTP {status} for {method} {path}; response details suppressed')

class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None

opener = urllib.request.build_opener(NoRedirect)
def api(path, method='GET', payload=None, authenticated=True):
    headers = {'Accept':'application/json'}
    if authenticated:
        headers['Authorization'] = 'Bearer '+token
    data = None if payload is None else json.dumps(payload).encode()
    if data is not None:
        headers['Content-Type'] = 'application/json'
    try:
        with opener.open(urllib.request.Request(base+path, data=data, headers=headers, method=method), timeout=20) as response:
            body = response.read(8*1024*1024+1)
            if len(body)>8*1024*1024:
                raise RuntimeError('Grafana response exceeds budget')
            return json.loads(body) if body else None
    except urllib.error.HTTPError as error:
        raise ApiError(error.code, method, path) from None
    except urllib.error.URLError:
        raise RuntimeError('Grafana request failed; connection details suppressed') from None

def optional(path):
    try:
        return api(path)
    except ApiError as error:
        if error.status==404:
            return None
        raise

def replace(value):
    if isinstance(value, str):
        return mapping.get(value,value)
    if isinstance(value, list):
        return [replace(item) for item in value]
    if isinstance(value, dict):
        return {key:replace(item) for key,item in value.items()}
    return value

try:
    for uid,kind in [('scribyra-prom','prometheus'),('scribyra-loki','loki'),('scribyra-tempo','tempo')]:
        source = api('/api/datasources/uid/'+mapping.get(uid,uid))
        if source.get('type')!=kind:
            raise RuntimeError('Expected datasource type is unavailable')
    existing_folder = optional('/api/folders/'+folder)
    if existing_folder and existing_folder.get('title')!='Scribyra':
        raise RuntimeError('Target folder UID belongs to a different folder')
    views = []
    for path in sorted((ROOT/'ops/telemetry/grafana/dashboards').glob('*.json')):
        view = replace(json.loads(path.read_text()))
        previous = optional('/api/dashboards/uid/'+view['uid'])
        if previous:
            if previous['dashboard'].get('title')!=view['title'] or 'scribyra' not in previous['dashboard'].get('tags',[]) or previous.get('meta',{}).get('folderUid')!=folder:
                raise RuntimeError('Target dashboard UID belongs to a different deployment')
            view['version'] = previous['dashboard']['version']
        views.append(view)
    alerts=[]
    if args.alerts:
        if args.profile!='cloud':
            raise RuntimeError('Self-hosted alert rules are provisioned from the versioned file')
        group=json.loads((ROOT/'ops/telemetry/grafana/provisioning/alerting/scribyra.json').read_text())['groups'][0]
        for rule in replace(group['rules']):
            previous=optional('/api/v1/provisioning/alert-rules/'+rule['uid'])
            if previous and (previous.get('folderUID')!=folder or previous.get('ruleGroup')!=group['name'] or previous.get('labels',{}).get('product')!='scribyra'):
                raise RuntimeError('Target alert UID belongs to a different deployment')
            rule.update(folderUID=folder,ruleGroup=group['name'])
            alerts.append((rule,previous is not None))
    if not args.apply:
        print(json.dumps({'action':'plan','folder':folder,'dashboards':[view['uid'] for view in views],'alerts':[rule['uid'] for rule,_ in alerts]}))
        raise SystemExit(0)
    if not existing_folder:
        api('/api/folders','POST',{'uid':folder,'title':'Scribyra'})
    # Organization administrators retain implicit access. Remove default Viewer/
    # Editor grants; broader sharing can be added deliberately by the operator.
    api('/api/folders/'+folder+'/permissions','POST',{'items':[]})
    permissions = api('/api/folders/'+folder+'/permissions')
    if any(item.get('role') in ['Viewer','Editor'] for item in permissions):
        raise RuntimeError('Default broad folder grants remain; refusing publication')
    if args.profile=='cloud' and args.run_links:
        # Add only our two named run links. Preserve every unrelated derived
        # field, datasource setting and existing server-side credential.
        uid=mapping['scribyra-loki']
        source=api('/api/datasources/uid/'+uid)
        links=replace(json.loads((ROOT/'ops/telemetry/grafana/run-links.json').read_text()))
        settings=dict(source.get('jsonData',{}))
        fields=list(settings.get('derivedFields',[]))
        owned={link['name'] for link in links}
        fields=[field for field in fields if field.get('name') not in owned]+links
        if fields!=settings.get('derivedFields',[]):
            settings['derivedFields']=fields
            payload={key:value for key,value in source.items() if key not in ['secureJsonFields','secureJsonData','readOnly']}
            payload['jsonData']=settings
            api('/api/datasources/uid/'+uid,'PUT',payload)
        stored=api('/api/datasources/uid/'+uid)
        if stored.get('jsonData',{}).get('derivedFields')!=fields:
            raise RuntimeError('Stored run links differ from requested links')
    for view in views:
        api('/api/dashboards/db','POST',{'dashboard':view,'folderUid':folder,'overwrite':True,'message':'Provision versioned Scribyra observability views'})
        current = api('/api/dashboards/uid/'+view['uid'])
        if current['meta'].get('folderUid')!=folder or current['dashboard'].get('panels')!=view['panels']:
            raise RuntimeError('Stored dashboard differs from requested view')
        public = optional('/api/dashboards/uid/'+view['uid']+'/public-dashboards')
        if public and public.get('isEnabled'):
            raise RuntimeError('A public-dashboard configuration is enabled')
        try:
            api('/api/dashboards/uid/'+view['uid'], authenticated=False)
        except ApiError as error:
            if error.status not in [401,403]:
                raise
        else:
            raise RuntimeError('Dashboard API is readable without authentication')
        print(json.dumps({'action':'verified','private':True,'url':base+'/d/'+view['uid'],'panels':len(view['panels'])}))
    if alerts:
        # Keep alert state/evaluation available without sending messages through
        # an existing organization contact point. Only these owned rules refer
        # to this all-time mute; unrelated notification routes are unchanged.
        mute=json.loads((ROOT/'ops/telemetry/grafana/dashboard-only-mute.json').read_text())
        mute_path='/api/v1/provisioning/mute-timings/'+mute['name']
        previous=optional(mute_path)
        if previous and previous.get('time_intervals')!=mute['time_intervals']:
            raise RuntimeError('Target mute interval belongs to a different configuration')
        if not previous:
            api('/api/v1/provisioning/mute-timings','POST',mute)
        current=api(mute_path)
        if current.get('time_intervals')!=mute['time_intervals']:
            raise RuntimeError('Stored dashboard-only mute differs from requested interval')
        receiver=api('/api/v1/provisioning/policies').get('receiver')
        if not receiver:
            raise RuntimeError('Cannot identify an existing alert receiver; no rules created')
        for rule,exists in alerts:
            rule['notification_settings']={'receiver':receiver,'mute_time_intervals':[mute['name']]}
            path='/api/v1/provisioning/alert-rules'+('/'+rule['uid'] if exists else '')
            api(path,'PUT' if exists else 'POST',rule)
            stored=api('/api/v1/provisioning/alert-rules/'+rule['uid'])
            for key in ['folderUID','ruleGroup','title','condition','noDataState','execErrState','for','labels','isPaused']:
                if stored.get(key)!=rule.get(key):
                    raise RuntimeError('Stored alert policy differs from requested policy')
            if stored.get('notification_settings',{}).get('mute_time_intervals')!=[mute['name']]:
                raise RuntimeError('Alert notifications are not dashboard-only')
            expected=rule['data'][0]
            actual=stored['data'][0]
            if expected['datasourceUid']!=actual['datasourceUid'] or expected['model']['expr']!=actual['model']['expr']:
                raise RuntimeError('Stored alert query differs from requested query')
            print(json.dumps({'action':'verified-alert','uid':rule['uid'],'notifications':'muted','paused':False}))
        interval_text=group['interval']
        if not interval_text.endswith('s') or not interval_text[:-1].isdigit():
            raise RuntimeError('Alert evaluation interval must use whole seconds')
        interval=int(interval_text[:-1])
        group_path='/api/v1/provisioning/folder/'+folder+'/rule-groups/'+urllib.parse.quote(group['name'],safe='')
        stored_group=api(group_path)
        expected_uids={rule['uid'] for rule,_ in alerts}
        if {rule['uid'] for rule in stored_group.get('rules',[])}!=expected_uids:
            raise RuntimeError('Alert group contains unexpected rules; evaluation interval left unchanged')
        api(group_path,'PUT',{'folderUid':folder,'title':group['name'],'interval':interval,'rules':[rule for rule,_ in alerts]})
        if api(group_path).get('interval')!=interval:
            raise RuntimeError('Stored alert evaluation interval differs from requested interval')
except (ApiError, RuntimeError) as error:
    raise SystemExit(str(error))
