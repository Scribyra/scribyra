#!/usr/bin/env python3
"""Register the pipeline-built web release using the job's scoped token.

GitLab: the release web-<pipeline IID> through the release API with CI_JOB_TOKEN.
GitHub Actions: the GitHub Release named by SCRIBYRA_RELEASE (web-N, the number the
production workflow built with) with GITHUB_TOKEN (permission contents: write). Both
carry the same text: who built it and where the deployed app is.
"""
import json
import os
import re
import urllib.error
import urllib.request
import urllib.parse
from pathlib import Path

domains=json.loads((Path(__file__).resolve().parent.parent/'ops/pages/domains.json').read_text())

def description(run_url,app):
    return 'Production browser app built by '+run_url+'\n\nOpen the latest deployed release: '+app

def gitlab():
    version='web-'+os.environ['CI_PIPELINE_IID']
    app=domains['application'] if domains['active'] else os.environ['CI_PAGES_URL'].rstrip('/')+'/app/'
    payload={'name':'Scribyra '+version,'tag_name':version,'ref':os.environ['CI_COMMIT_SHA'],
             'description':description(os.environ['CI_PIPELINE_URL'],app),
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

# GitHub has no release link assets; the link goes into the body. The tag is created by
# the release itself, on the deployed commit.
def github_payload(version,sha,run_url,app):
    return {'tag_name':version,'target_commitish':sha,'name':'Scribyra '+version,
            'body':description(run_url,app)+'\n\n[Open browser app]('+app+')',
            'draft':False,'prerelease':False,'make_latest':'true'}

def github():
    version=os.environ.get('SCRIBYRA_RELEASE','')
    if not re.fullmatch(r'web-[1-9]\d{0,11}',version):raise SystemExit('SCRIBYRA_RELEASE must be web-<number>')
    sha=os.environ['CI_COMMIT_SHA']
    if not re.fullmatch(r'[0-9a-f]{40}',sha):raise SystemExit('CI_COMMIT_SHA must be a full commit id')
    repository=os.environ['GITHUB_REPOSITORY']
    run_url=os.environ['GITHUB_SERVER_URL']+'/'+repository+'/actions/runs/'+os.environ['GITHUB_RUN_ID']
    if not domains['active']:raise SystemExit('ops/pages/domains.json must be active on GitHub (no Pages fallback address)')
    api=os.environ.get('GITHUB_API_URL','https://api.github.com')+'/repos/'+repository
    headers={'Authorization':'Bearer '+os.environ['GITHUB_TOKEN'],'Accept':'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28'}
    request=urllib.request.Request(api+'/releases',data=json.dumps(github_payload(version,sha,run_url,domains['application'])).encode(),headers={**headers,'Content-Type':'application/json'})
    try:
        with urllib.request.urlopen(request,timeout=30) as response:print('Registered workflow-built release:',version,response.status)
    except urllib.error.HTTPError as error:
        # 422: the tag or release exists already, as when a run is re-run.
        if error.code==422:
            check=urllib.request.Request(api+'/git/ref/tags/'+urllib.parse.quote(version,safe=''),headers=headers)
            try:
                with urllib.request.urlopen(check,timeout=30) as response:existing=json.load(response)
            except urllib.error.HTTPError:existing={}
            if existing.get('object',{}).get('sha')==sha:
                print('Workflow release already registered:',version)
                raise SystemExit(0)
        raise SystemExit(f'Release registration failed: HTTP {error.code}; response details suppressed')

if __name__=='__main__':
    github() if os.environ.get('GITHUB_ACTIONS')=='true' else gitlab()
