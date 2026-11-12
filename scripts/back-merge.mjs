// After a push to main (a merged hotfix), opens one merge request main → dev so the fix
// reaches the next release. Does nothing when dev already has every change on main
// (for example right after a release merge). CI_JOB_TOKEN cannot create merge
// requests, so the job uses SCRIBYRA_BACKMERGE_TOKEN: a masked, protected CI variable
// holding a personal access token (scope `api`) of a Developer-role bot user.
// Without that variable it prints the manual command and exits 42 (an allowed failure).
//
//   node scripts/back-merge.mjs [--dry-run]
import {execFileSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';

export const SOURCE='main',TARGET='dev',MISSING_TOKEN_EXIT=42;
export function backMergeTitle(subject){return`Back-merge main into dev: ${subject.replace(/\s+/g,' ').trim().slice(0,180)}`;}
export function backMergeDescription(commits,pipelineUrl=null){
 return['Automatic back-merge so production fixes reach the next release.','',
  ...(commits.length?['Commits on `main` that `dev` does not have yet:','',...commits.map(line=>`- ${line}`),'']:[]),
  'Merge with a merge commit; do not delete `main`. If this has conflicts, resolve them on a branch made from `dev` (see docs/delivery.md, "Hotfix").',
  ...(pipelineUrl?['',`Opened by ${pipelineUrl}`]:[])].join('\n');
}
// The request body for POST /projects/:id/merge_requests.
export function backMergeRequest({subject,commits,pipelineUrl=null,assignees=[]}){
 const body={source_branch:SOURCE,target_branch:TARGET,title:backMergeTitle(subject),description:backMergeDescription(commits,pipelineUrl),remove_source_branch:false,squash:false,labels:'back-merge'};
 if(assignees.length)body.assignee_ids=assignees;
 return body;
}
export function manualCommand(){return`glab mr create --source-branch ${SOURCE} --target-branch ${TARGET} --title "Back-merge main into dev" --remove-source-branch=false --yes`;}

// Decides from git alone whether main has anything dev lacks.
export function pendingCommits(git,head,target=`origin/${TARGET}`){
 try{git(['merge-base','--is-ancestor',head,target]);return[];}catch{}
 // Changes on main since it last met dev; empty for a release merge (same tree as dev).
 try{git(['diff','--quiet',`${target}...${head}`]);return[];}catch{}
 return git(['log','--no-merges','--format=%h %s',`${target}..${head}`]).split('\n').filter(Boolean);
}

export async function run({env=process.env,git=args=>execFileSync('git',args,{encoding:'utf8',stdio:['ignore','pipe','pipe']}),fetcher=fetch,log=console.log,dry=false}={}){
 const head=env.CI_COMMIT_SHA||git(['rev-parse','HEAD']).trim();
 git(['fetch','--no-tags','origin',`+refs/heads/${TARGET}:refs/remotes/origin/${TARGET}`]);
 const commits=pendingCommits(git,head);
 if(!commits.length){log(`dev already contains every change on main; no back-merge needed.`);return 0;}
 const subject=git(['log','-1','--format=%s',head]).trim();
 const body=backMergeRequest({subject,commits,pipelineUrl:env.CI_PIPELINE_URL||null,assignees:(env.SCRIBYRA_BACKMERGE_ASSIGNEE_IDS||'').split(',').map(Number).filter(Number.isInteger).filter(id=>id>0)});
 if(dry){log(JSON.stringify(body,null,1));return 0;}
 const token=env.SCRIBYRA_BACKMERGE_TOKEN;
 if(!token){log(`main has ${commits.length} commit(s) that dev lacks, and SCRIBYRA_BACKMERGE_TOKEN is not set.\nOpen the back-merge by hand:\n  ${manualCommand()}`);return MISSING_TOKEN_EXIT;}
 const api=`${env.CI_API_V4_URL}/projects/${env.CI_PROJECT_ID}/merge_requests`,headers={'PRIVATE-TOKEN':token,'Content-Type':'application/json'};
 const open=await fetcher(`${api}?state=opened&source_branch=${SOURCE}&target_branch=${TARGET}`,{headers});
 if(!open.ok)throw Error(`Listing merge requests failed: HTTP ${open.status}`);
 const existing=await open.json();
 if(existing.length){log(`A back-merge is already open and now includes this commit: ${existing[0].web_url}`);return 0;}
 const created=await fetcher(api,{method:'POST',headers,body:JSON.stringify(body)});
 if(!created.ok)throw Error(`Creating the back-merge failed: HTTP ${created.status}; response details suppressed`);
 log(`Opened back-merge ${(await created.json()).web_url}`);return 0;
}

if(import.meta.url===pathToFileURL(process.argv[1]).href)process.exitCode=await run({dry:process.argv.includes('--dry-run')});
