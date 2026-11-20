// After a push to main (a merged hotfix), opens one pull request main → dev so the fix
// reaches the next release. Does nothing when dev already has every change on main
// (for example right after a release merge).
//
// It uses the workflow's GITHUB_TOKEN (permission pull-requests: write); no bot user is
// needed. The repository setting "Allow GitHub Actions to create and approve pull
// requests" must be on; when it is off (HTTP 403), or when there is no token, the job
// prints the manual command and exits 42 (an allowed failure).
//
//   node scripts/back-merge.mjs [--dry-run]
import {execFileSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';

export const SOURCE='main',TARGET='dev',MISSING_TOKEN_EXIT=42;
export function backMergeTitle(subject){return`Back-merge main into dev: ${subject.replace(/\s+/g,' ').trim().slice(0,180)}`;}
export function backMergeDescription(commits,pipelineUrl=null){
 return['Automatic back-merge so production fixes reach the next release.','',
  ...(commits.length?['Commits on `main` that `dev` does not have yet:','',...commits.map(line=>`- ${line}`),'']:[]),
  'Merge with a merge commit; do not delete `main`. If this has conflicts, resolve them on a branch made from `dev` (see docs/delivery.md, "A hotfix").',
  ...(pipelineUrl?['',`Opened by ${pipelineUrl}`]:[])].join('\n');
}
export function manualCommand(){
 return`gh pr create --head ${SOURCE} --base ${TARGET} --title "Back-merge main into dev" --label back-merge --body "Production fixes for the next release."`;
}
// The request body for POST /repos/:owner/:repo/pulls. Labels and assignees are set
// afterwards through the issues API, which is how GitHub attaches them to a pull request.
export function githubPullRequest({subject,commits,runUrl=null}){
 return{head:SOURCE,base:TARGET,title:backMergeTitle(subject),body:backMergeDescription(commits,runUrl),maintainer_can_modify:false,draft:false};
}

async function runGithub({env,head,commits,subject,fetcher,log}){
 const token=env.GITHUB_TOKEN,repository=env.GITHUB_REPOSITORY,api=`${env.GITHUB_API_URL||'https://api.github.com'}/repos/${repository}`;
 if(!token||!/^[\w.-]+\/[\w.-]+$/.test(repository||'')){log(`main has ${commits.length} commit(s) that dev lacks, and no GITHUB_TOKEN is available.\nOpen the back-merge by hand:\n  ${manualCommand()}`);return MISSING_TOKEN_EXIT;}
 const headers={Authorization:`Bearer ${token}`,Accept:'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28','Content-Type':'application/json'};
 const owner=repository.split('/')[0];
 const open=await fetcher(`${api}/pulls?state=open&head=${encodeURIComponent(`${owner}:${SOURCE}`)}&base=${TARGET}`,{headers});
 if(!open.ok)throw Error(`Listing pull requests failed: HTTP ${open.status}`);
 const existing=await open.json();
 if(existing.length){log(`A back-merge is already open and now includes this commit: ${existing[0].html_url}`);return 0;}
 const runUrl=env.GITHUB_RUN_ID?`${env.GITHUB_SERVER_URL||'https://github.com'}/${repository}/actions/runs/${env.GITHUB_RUN_ID}`:null;
 const created=await fetcher(`${api}/pulls`,{method:'POST',headers,body:JSON.stringify(githubPullRequest({subject,commits,runUrl}))});
 if(created.status===403){log(`GitHub refused to let this workflow open a pull request (HTTP 403). Turn on "Allow GitHub Actions to create and approve pull requests" (docs/delivery.md, "Repository settings"), or open it by hand:\n  ${manualCommand()}`);return MISSING_TOKEN_EXIT;}
 if(!created.ok)throw Error(`Creating the back-merge failed: HTTP ${created.status}; response details suppressed`);
 const pull=await created.json();
 // Best effort: a missing label or assignee must not hide the pull request itself.
 const assignees=(env.SCRIBYRA_BACKMERGE_ASSIGNEES||'').split(',').map(name=>name.trim()).filter(name=>/^[A-Za-z0-9-]{1,39}$/.test(name));
 for(const[path,body]of [['labels',{labels:['back-merge']}],...(assignees.length?[['assignees',{assignees}]]:[])]){
  const response=await fetcher(`${api}/issues/${pull.number}/${path}`,{method:'POST',headers,body:JSON.stringify(body)});
  if(!response.ok)log(`Could not set ${path} on the back-merge: HTTP ${response.status}`);
 }
 log(`Opened back-merge ${pull.html_url}`);return 0;
}

// Decides from git alone whether main has anything dev lacks.
export function pendingCommits(git,head,target=`origin/${TARGET}`){
 try{git(['merge-base','--is-ancestor',head,target]);return[];}catch{}
 // Changes on main since it last met dev; empty for a release merge (same tree as dev).
 try{git(['diff','--quiet',`${target}...${head}`]);return[];}catch{}
 return git(['log','--no-merges','--format=%h %s',`${target}..${head}`]).split('\n').filter(Boolean);
}

export async function run({env=process.env,git=args=>execFileSync('git',args,{encoding:'utf8',stdio:['ignore','pipe','pipe']}),fetcher=fetch,log=console.log,dry=false}={}){
 const head=env.CI_COMMIT_SHA||env.GITHUB_SHA||git(['rev-parse','HEAD']).trim();
 git(['fetch','--no-tags','origin',`+refs/heads/${TARGET}:refs/remotes/origin/${TARGET}`]);
 const commits=pendingCommits(git,head);
 if(!commits.length){log(`dev already contains every change on main; no back-merge needed.`);return 0;}
 const subject=git(['log','-1','--format=%s',head]).trim();
 if(dry){log(JSON.stringify(githubPullRequest({subject,commits}),null,1));return 0;}
 return runGithub({env,head,commits,subject,fetcher,log});
}

if(import.meta.url===pathToFileURL(process.argv[1]).href)process.exitCode=await run({dry:process.argv.includes('--dry-run')});
