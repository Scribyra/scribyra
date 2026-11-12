#!/usr/bin/env python3
"""Register the pipeline-built web release using the job's scoped GitLab token."""
import json
import os
import urllib.error
import urllib.request
import urllib.parse
version='web-'+os.environ['CI_PIPELINE_IID']
from pathlib import Path
domains=json.loads((Path(__file__).resolve().parent.parent/'ops/pages/domains.json').read_text())
app=domains['application'] if domains['active'] else os.environ['CI_PAGES_URL'].rstrip('/')+'/app/'
payload={'name':'Scribyra '+version,'tag_name':version,'ref':os.environ['CI_COMMIT_SHA'],
         'description':'Production browser app built by '+os.environ['CI_PIPELINE_URL']+'\n\nOpen the latest deployed release: '+app,
         'assets':{'links':[{'name':'Open browser app','url':app,'link_type':'other'}]}}
url=os.environ['CI_API_V4_URL']+'/projects/'+os.environ['CI_PROJECT_ID']+'/releases'
request=urllib.request.Request(url,data=json.dumps(payload).encode(),headers={'JOB-TOKEN':os.environ['CI_JOB_TOKEN'],'Content-Type':'application/json'})
try:
    with urllib.request.urlopen(request,timeout=30) as response:print('Registered pipeline-built release:',version,response.status)
except urllib.error.HTTPError as error:
    if error.code==409:
        check=urllib.request.Request(url+'/'+urllib.parse.quote(version,safe=''),headers={'JOB-TOKEN':os.environ['CI_JOB_TOKEN']})
        with urllib.request.urlopen(check,timeout=30) as response:existing=json.load(response)
        if existing.get('commit',{}).get('id')==os.environ['CI_COMMIT_SHA']:
            print('Pipeline release already registered:',version)
            raise SystemExit(0)
    raise SystemExit(f'Release registration failed: HTTP {error.code}; response details suppressed')
