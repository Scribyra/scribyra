// Generates the changelog for a release merge request (dev → main): every merge
// request merged into dev since the latest web-<N> release tag, from the merge
// commits. GitLab writes "Merge branch 'x' into 'dev'", then the MR title, then "See
// merge request group/project!N"; GitHub writes "Merge pull request #N from owner/x",
// then the pull request title (repository setting: merge commit message = pull
// request title). A range may hold both kinds around the move. Read-only: it only
// runs git log/tag.
//
//   node scripts/release-changelog.mjs [--from web-N] [--to origin/dev] [--main origin/main] [--tests FILE]
import {execFileSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';

export function releaseNumber(tag){const match=/^web-([1-9]\d*)$/.exec(tag);return match?Number(match[1]):null;}
// The newest release tag by number (tags are created only by CI on main).
export function latestRelease(tags){
 let best=null;for(const tag of tags){const number=releaseNumber(tag.trim());if(number!==null&&(best===null||number>releaseNumber(best)))best=tag.trim();}
 return best;
}
const TRAILER=/^(Co-authored-by|Signed-off-by|Reviewed-by|Approved-by|Merged-by):/i;
// One merge commit → {branch, target, title, mr, ref} or null for anything else. A
// GitHub merge commit does not name its target branch: `target` is the branch whose
// first-parent history is being read.
export function parseMergeCommit(subject,body='',{target=null}={}){
 const pull=/^Merge pull request #(\d+) from [^/\s]+\/(\S+)$/.exec(subject.trim());
 if(pull){
  const title=body.split('\n').map(line=>line.trim()).find(line=>line&&!TRAILER.test(line))||pull[2];
  return{branch:pull[2],target,title,mr:Number(pull[1]),ref:`#${pull[1]}`};
 }
 const match=/^Merge branch '([^']+)' into '([^']+)'$/.exec(subject.trim());if(!match)return null;
 const lines=body.split('\n').map(line=>line.trim());
 const reference=lines.map(line=>/^See merge request (\S+)?!(\d+)$/.exec(line)).find(Boolean);
 const title=lines.find(line=>line&&!/^See merge request /.test(line)&&!TRAILER.test(line))||match[1];
 const mr=reference?Number(reference[2]):null;
 return{branch:match[1],target:match[2],title,mr,ref:mr===null?null:`!${mr}`};
}
export function category(branch){
 if(/^feature\//.test(branch))return'Features';
 if(/^hotfix\//.test(branch)||branch==='main')return'Fixes from production';
 if(/^(fix|bugfix)\//.test(branch))return'Fixes';
 return'Other changes';
}
const ORDER=['Features','Fixes','Fixes from production','Other changes','Direct commits'];
export function renderChangelog(entries,{since=null,target='dev',tests=null,direct=[]}={}){
 const groups=new Map();
 for(const entry of entries){if(entry.target!==target)continue;const name=category(entry.branch);if(!groups.has(name))groups.set(name,[]);groups.get(name).push(entry);}
 if(direct.length)groups.set('Direct commits',direct.map(title=>({title,mr:null,branch:null})));
 const out=[`## Changes since ${since||'the first commit'}`,''];
 if(!groups.size)out.push('No merge requests were merged since the last release.','');
 for(const name of ORDER){
  const items=groups.get(name);if(!items)continue;
  out.push(`### ${name}`,'');
  for(const item of items){
   const ref=item.ref||(item.mr?`!${item.mr}`:null);
   if(item.branch==='main'){out.push(`- Production fixes merged back into ${target}${ref?` (${ref})`:''}`);continue;}
   out.push(`- ${item.title}${ref?` (${ref})`:''}`);
  }
  out.push('');
 }
 out.push('## Test results','',tests?tests.trim():'_Link the passing pipeline (or workflow run) and any manual checks here._','');
 return out.join('\n');
}

function git(args){return execFileSync('git',args,{encoding:'utf8',stdio:['ignore','pipe','pipe']});}
export function collect({from=null,to='origin/dev',main='origin/main'}={}){
 const since=from||latestRelease(git(['tag','--list','web-*','--merged',main]).split('\n'));
 const range=since?`${since}..${to}`:to;
 // First parent only: the merge commits made on dev, not commits inside feature branches.
 const log=git(['log','--first-parent','--format=%P%x1f%s%x1f%b%x1e',range]);
 const entries=[],direct=[];
 for(const record of log.split('\x1e')){
  if(!record.trim())continue;const[parents,subject,body]=record.replace(/^\n/,'').split('\x1f');
  const merged=parents.trim().split(' ').length>1?parseMergeCommit(subject,body,{target:to.replace(/^.*\//,'')}):null;
  if(merged)entries.push(merged);else direct.push(subject.trim());
 }
 return{since,entries:entries.reverse(),direct:direct.reverse()};
}

if(import.meta.url===pathToFileURL(process.argv[1]).href){
 const args=process.argv.slice(2),option=name=>{const index=args.indexOf(name);return index>=0?args[index+1]:undefined;};
 const{since,entries,direct}=collect({from:option('--from'),to:option('--to')||'origin/dev',main:option('--main')||'origin/main'});
 const tests=option('--tests')?readFileSync(option('--tests'),'utf8'):null;
 process.stdout.write(renderChangelog(entries,{since,tests,direct}));
}
