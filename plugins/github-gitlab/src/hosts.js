// GitHub and GitLab REST clients over the host's fetch proxy (docs/git-sync.md#requests).
// `net(url, init)` is the plugin's net.fetch; the access token is a secret bound to the
// host's origin, which Scribyra adds to each request itself (`auth`), so this code never
// holds it after it is saved. Every function returns plain data or throws a HostError
// whose message is meant for the person.
//
// GitHub: the Git database API (refs, commits, trees, blobs) on api.github.com, which
// answers CORS requests with Authorization. GitLab: REST v4 (projects, branches,
// repository tree, raw blobs, compare, commits with actions) on gitlab.com or a
// self-hosted origin the person allowed. Requests are sequential; nothing retries.

export class HostError extends Error{constructor(code,message,{status=0}={}){super(message);this.name='HostError';this.code=code;this.status=status;}}
const encoder=new TextEncoder();
const json=value=>encoder.encode(JSON.stringify(value));
export function base64(bytes){let text='';for(let i=0;i<bytes.length;i+=0x8000)text+=String.fromCharCode(...bytes.subarray(i,i+0x8000));return btoa(text);}
const segments=value=>value.split('/').map(encodeURIComponent).join('/');
const parse=text=>{try{return JSON.parse(text);}catch{return null;}};
const when=seconds=>{const at=new Date(seconds*1000);return `${at.toLocaleTimeString(undefined,{hour:'2-digit',minute:'2-digit'})} (in about ${Math.max(1,Math.round((seconds*1000-Date.now())/60000))} minutes)`;};

// Requests carry at most 8 MiB. Base64 grows bytes by a third and JSON escapes LaTeX's
// backslashes, so a pushed file is at most 5.5 MiB, request bodies are measured as the
// JSON actually sent, and a GitLab commit (one request) holds at most that much JSON.
export const PUSH_FILE_BYTES=5.5*1024*1024,REQUEST_BYTES=7.5*1024*1024,INLINE_TEXT_BYTES=1024*1024;
const jsonBytes=value=>encoder.encode(JSON.stringify(value)).length;

export const GITHUB={
  kind:'github',name:'GitHub',origin:'https://api.github.com',web:'https://github.com',
  tokenUrl:'https://github.com/settings/personal-access-tokens/new',
  docsUrl:'https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens#creating-a-fine-grained-personal-access-token',
};
export const gitlabHost=(origin='https://gitlab.com')=>({
  kind:'gitlab',name:origin==='https://gitlab.com'?'GitLab':new URL(origin).host,origin,web:origin,
  tokenUrl:`${origin}/-/user_settings/personal_access_tokens?name=Scribyra&scopes=api`,
  docsUrl:'https://docs.gitlab.com/user/project/settings/project_access_tokens/',
});
/** "owner/repo" for GitHub, "group/…/project" for GitLab, from text or a pasted address. */
export function normalRepository(kind,value){
  let text=String(value??'').trim().replace(/\.git$/,'').replace(/\/+$/,'');
  const match=/^(?:https?:\/\/[^/]+\/|git@[^:]+:)(.+)$/.exec(text);if(match)text=match[1].replace(/\/-\/.*$/,'').replace(/\/(?:tree|blob)\/.*$/,'');
  if(kind==='github')return /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/.test(text)?text:null;
  return text.length<=255&&/^[A-Za-z0-9_.][A-Za-z0-9_.-]*(?:\/[A-Za-z0-9_.][A-Za-z0-9_.-]*)+$/.test(text)&&!text.split('/').some(part=>part==='.'||part==='..')?text:null;
}

function githubError(response,what){
  const body=parse(response.body),message=String(body?.message||'');
  const header=name=>response.headers.get(name);
  if(response.status===401)return new HostError('unauthorized','GitHub did not accept the token (it may be wrong, expired or revoked). Create a new one and enter it again.',{status:401});
  if((response.status===403||response.status===429)&&(header('x-ratelimit-remaining')==='0'||/rate limit/i.test(message))){
    const reset=Number(header('x-ratelimit-reset')),retry=Number(header('retry-after'));
    return new HostError('rate_limited',`GitHub is limiting requests from this token${Number.isFinite(retry)&&retry>0?`; try again in ${Math.ceil(retry/60)} minutes`:Number.isFinite(reset)&&reset>0?`; try again after ${when(reset)}`:'; try again later'}.`,{status:response.status});
  }
  if(response.status===403)return new HostError('forbidden',`GitHub refused ${what}: ${message||'forbidden'}. The token needs “Contents: Read and write” for this repository (and “Workflows” to change .github/workflows).`,{status:403});
  if(response.status===404)return new HostError('not_found',`GitHub has no ${what} that this token can see. Check the name, and that the token’s repository access includes it.`,{status:404});
  if(response.status===409)return new HostError('empty','This GitHub repository is empty. Add a first commit on GitHub (for example a README), then link it again.',{status:409});
  return new HostError(response.status===422?'conflict':'failed',`GitHub could not ${what.replace(/^the /,'read the ')}${message?`: ${message}`:` (HTTP ${response.status})`}.`,{status:response.status});
}

export function githubClient({net,repository,secret}){
  const root=`${GITHUB.origin}/repos/${segments(repository)}`;
  async function request(url,{method='GET',body,accept='application/vnd.github+json',bytes=false,what='the repository'}={}){
    const response=await net(url,{method,headers:{Accept:accept,...(body?{'Content-Type':'application/json'}:{})},body:body===undefined?undefined:json(body),responseType:bytes?'bytes':'text',auth:{secret,header:'Authorization',scheme:'Bearer'}});
    if(response.status<200||response.status>299)throw githubError(response,what);
    return bytes?response.body:parse(response.body);
  }
  const tree=(sha,recursive)=>request(`${root}/git/trees/${sha}${recursive?'?recursive=1':''}`,{what:'the file list'});
  return {
    host:GITHUB,
    async account(){const user=await request(`${GITHUB.origin}/user`,{what:'the account'});return {login:String(user.login||'')};},
    async repository(){
      const repo=await request(root,{what:`repository ${repository}`});
      return {fullName:repo.full_name||repository,defaultBranch:repo.default_branch||'main',private:!!repo.private,canPush:repo.permissions?!!repo.permissions.push:null,webUrl:repo.html_url||`${GITHUB.web}/${repository}`};
    },
    /** The branch's commit id, or null when there is no such branch. */
    async head(branch){
      try{const ref=await request(`${root}/git/ref/heads/${segments(branch)}`,{what:`branch ${branch}`});return ref?.object?.type==='commit'?ref.object.sha:null;}
      catch(error){if(error.code==='not_found')return null;throw error;}
    },
    /** {commit, tree, entries:[{path, mode, type, sha, size}]} of a commit, under `subfolder` only. */
    async tree(commit,subfolder=''){
      const data=await request(`${root}/git/commits/${commit}`,{what:'the commit'});
      let sha=data.tree.sha,prefix='';
      // Walk down to the subfolder so a large repository is listed only where it matters.
      for(const part of subfolder?subfolder.split('/'):[]){
        const level=await tree(sha,false),entry=level.tree.find(item=>item.type==='tree'&&item.path===part);
        if(!entry)return {commit,tree:data.tree.sha,entries:[]};
        sha=entry.sha;prefix+=`${part}/`;
      }
      const listing=await tree(sha,true);
      if(listing.truncated)throw new HostError('too_large','This repository folder has too many files for GitHub to list at once (more than 100,000). Link a smaller subfolder.');
      return {commit,tree:data.tree.sha,entries:listing.tree.map(item=>({path:prefix+item.path,mode:item.mode,type:item.type,sha:item.sha,size:item.size??null}))};
    },
    blob:sha=>request(`${root}/git/blobs/${sha}`,{accept:'application/vnd.github.raw+json',bytes:true,what:'a file'}),
    /** How many commits the branch is ahead of `base`. */
    async behind(base,head){const data=await request(`${root}/compare/${base}...${head}`,{what:'the comparison'});return {behind:Number(data.ahead_by)||0,diverged:data.status==='diverged'};},
    /**
     * One commit on top of `base` with `changes` [{path, op, bytes, text, mode}], then the
     * branch moves to it only as a fast-forward: if anyone pushed meanwhile, GitHub refuses
     * and nothing changes on the branch. A new branch starts at `base`.
     */
    async push({branch,newBranch,base,baseTree,message,changes}){
      const entries=[];
      for(const change of changes){
        if(change.op==='delete'){entries.push({path:change.path,mode:change.mode||'100644',type:'blob',sha:null});continue;}
        // Small text goes inline in the tree; larger and binary files become blobs first.
        if(typeof change.text==='string'&&change.bytes.length<=INLINE_TEXT_BYTES)entries.push({path:change.path,mode:change.mode||'100644',type:'blob',content:change.text});
        else{const blob=await request(`${root}/git/blobs`,{method:'POST',body:{content:base64(change.bytes),encoding:'base64'},what:'a file'});entries.push({path:change.path,mode:change.mode||'100644',type:'blob',sha:blob.sha});}
      }
      // Trees are built in batches that each fit in one request, each on top of the last.
      let tree=baseTree;
      for(let i=0;i<entries.length;){
        const batch=[];let size=200;
        while(i<entries.length&&(!batch.length||size+jsonBytes(entries[i])<=REQUEST_BYTES)){size+=jsonBytes(entries[i])+1;batch.push(entries[i++]);}
        tree=(await request(`${root}/git/trees`,{method:'POST',body:{base_tree:tree,tree:batch},what:'the new file list'})).sha;
      }
      const commit=await request(`${root}/git/commits`,{method:'POST',body:{message,tree,parents:[base]},what:'the commit'});
      if(newBranch){
        try{await request(`${root}/git/refs`,{method:'POST',body:{ref:`refs/heads/${newBranch}`,sha:commit.sha},what:`branch ${newBranch}`});}
        catch(error){if(error.code==='conflict')throw new HostError('branch_exists',`A branch called ${newBranch} already exists on GitHub. Choose another name.`);throw error;}
      }else{
        try{await request(`${root}/git/refs/heads/${segments(branch)}`,{method:'PATCH',body:{sha:commit.sha,force:false},what:`branch ${branch}`});}
        catch(error){if(error.code==='conflict')throw new HostError('moved',`Someone pushed to ${branch} on GitHub while you were pushing. Nothing was changed there. Pull, then push again.`);throw error;}
      }
      return {commit:commit.sha,tree,parents:[base]};
    },
  };
}

function gitlabError(response,what,host){
  const body=parse(response.body),message=String(body?.message||body?.error_description||body?.error||'').replace(/^\d{3} /,'');
  if(response.status===401)return new HostError('unauthorized',`${host.name} did not accept the token (it may be wrong, expired or revoked). Create a new one and enter it again.`,{status:401});
  if(response.status===403&&(body?.error==='insufficient_scope'||/scope/i.test(message)))return new HostError('scope',`The token’s scopes do not allow ${what}. Create one with the “api” scope (or “read_api” to pull only).`,{status:403});
  if(response.status===403)return new HostError('forbidden',`${host.name} refused ${what}${message?`: ${message}`:''}. The token needs the Developer role (Maintainer for a protected branch).`,{status:403});
  if(response.status===404)return new HostError('not_found',`${host.name} has no ${what} that this token can see.`,{status:404});
  if(response.status===429)return new HostError('rate_limited',`${host.name} is limiting requests; try again in a minute or two.`,{status:429});
  if(response.status===400&&/changed since|has changed|already exists|does not exist/i.test(message))return new HostError('moved',`${host.name} refused the commit: ${message}. Someone changed these files meanwhile; nothing was pushed. Pull, then push again.`,{status:400});
  return new HostError('failed',`${host.name} could not do ${what}${message?`: ${message}`:` (HTTP ${response.status})`}.`,{status:response.status});
}

export function gitlabClient({net,origin,repository,secret}){
  const host=gitlabHost(origin),api=`${origin}/api/v4`,project=`${api}/projects/${encodeURIComponent(repository)}`;
  async function request(url,{method='GET',body,bytes=false,what='the project',raw=false}={}){
    const response=await net(url,{method,headers:body?{'Content-Type':'application/json'}:{},body:body===undefined?undefined:json(body),responseType:bytes?'bytes':'text',auth:{secret,header:'PRIVATE-TOKEN',scheme:''}});
    if(raw)return response;
    if(response.status<200||response.status>299)throw gitlabError(response,what,host);
    return bytes?response.body:parse(response.body);
  }
  return {
    host,
    async account(){const user=await request(`${api}/user`,{what:'the account'});return {login:String(user.username||'')};},
    /** The token's scopes when the instance tells (personal and project tokens), else null. */
    async scopes(){const response=await request(`${api}/personal_access_tokens/self`,{raw:true});if(response.status!==200)return null;const data=parse(response.body);return Array.isArray(data?.scopes)?data.scopes.map(String):null;},
    async repository(){
      const data=await request(project,{what:`project ${repository}`}),level=Math.max(data.permissions?.project_access?.access_level||0,data.permissions?.group_access?.access_level||0);
      return {fullName:data.path_with_namespace||repository,defaultBranch:data.default_branch||'main',private:data.visibility!=='public',canPush:data.permissions?level>=30:null,webUrl:data.web_url||`${origin}/${repository}`,empty:!!data.empty_repo};
    },
    async head(branch){
      try{const data=await request(`${project}/repository/branches/${encodeURIComponent(branch)}`,{what:`branch ${branch}`});return data?.commit?.id||null;}
      catch(error){if(error.code==='not_found')return null;throw error;}
    },
    async tree(commit,subfolder=''){
      const entries=[];
      let url=`${project}/repository/tree?${new URLSearchParams({ref:commit,recursive:'true',per_page:'100',pagination:'keyset',...(subfolder?{path:subfolder}:{})})}`;
      while(url){
        const response=await request(url,{raw:true});
        if(response.status===404&&subfolder&&!entries.length)return {commit,tree:null,entries:[]};
        if(response.status!==200)throw gitlabError(response,'the file list',host);
        const page=parse(response.body);if(!Array.isArray(page))throw new HostError('failed',`${host.name} sent a file list Scribyra could not read.`);
        for(const item of page)entries.push({path:item.path,mode:item.mode,type:item.type,sha:item.id,size:null});
        if(entries.length>20000)throw new HostError('too_large','This repository folder lists more than 20,000 entries. Link a smaller subfolder.');
        const next=/<([^>]+)>;\s*rel="next"/.exec(response.headers.get('link')||'')?.[1]||null;
        // A full page without a readable next link may be cut short (a proxy that hides
        // Link): stop rather than take missing files for deleted ones.
        if(!next&&page.length>=100)throw new HostError('failed',`${host.name} did not say whether more files follow (its Link header is not readable). Scribyra stops rather than guess.`);
        // Follow only links to this same API.
        if(next&&!next.startsWith(`${api}/`))throw new HostError('failed',`${host.name} pointed the file list at another address.`);
        url=next;
      }
      return {commit,tree:null,entries};
    },
    blob:sha=>request(`${project}/repository/blobs/${sha}/raw`,{bytes:true,what:'a file'}),
    async behind(base,head){const data=await request(`${project}/repository/compare?${new URLSearchParams({from:base,to:head,straight:'true'})}`,{what:'the comparison'});return {behind:Array.isArray(data?.commits)?data.commits.length:0,diverged:false};},
    /** The last commit that touched a file at `ref`, for GitLab's per-file conflict check. */
    async lastCommit(path,ref){
      const response=await request(`${project}/repository/files/${encodeURIComponent(path)}?ref=${encodeURIComponent(ref)}`,{method:'HEAD',raw:true});
      if(response.status!==200)throw gitlabError(response,`file ${path}`,host);
      // Without it GitLab cannot refuse a concurrent edit, so Scribyra does not push blind.
      const id=response.headers.get('x-gitlab-last-commit-id');
      if(!/^[0-9a-f]{40}$/.test(id||''))throw new HostError('failed',`${host.name} did not say which commit last changed ${path} (its X-Gitlab-Last-Commit-Id header is not readable), so Scribyra cannot push safely.`);
      return id;
    },
    /**
     * One commit with actions. GitLab applies them on the branch as it is; each changed or
     * deleted file names the last commit that touched it, so if someone changed it
     * meanwhile GitLab refuses the whole commit, and a created file must not exist yet.
     */
    async push({branch,newBranch,base,message,changes}){
      const actions=[];
      for(const change of changes){
        const last=change.op==='add'?null:await this.lastCommit(change.path,base);
        if(change.op==='delete'){actions.push({action:'delete',file_path:change.path,...(last?{last_commit_id:last}:{})});continue;}
        actions.push({action:change.op==='add'?'create':'update',file_path:change.path,...(typeof change.text==='string'?{content:change.text,encoding:'text'}:{content:base64(change.bytes),encoding:'base64'}),...(last?{last_commit_id:last}:{}),...(change.op==='add'&&change.mode==='100755'?{execute_filemode:true}:{})});
      }
      const body={branch:newBranch||branch,commit_message:message,actions,...(newBranch?{start_sha:base}:{})};
      if(jsonBytes(body)>REQUEST_BYTES)throw new HostError('too_large',`GitLab takes a commit in one request: at most about ${(REQUEST_BYTES/1024/1024).toFixed(1)} MiB of changes at once. Push fewer files at a time.`);
      const data=await request(`${project}/repository/commits`,{method:'POST',body,what:'the commit'}).catch(error=>{if(newBranch&&error.code==='moved'&&/already exists/i.test(error.message))throw new HostError('branch_exists',`A branch called ${newBranch} already exists on ${host.name}. Choose another name.`);throw error;});
      return {commit:data.id,tree:null,parents:Array.isArray(data.parent_ids)?data.parent_ids:[]};
    },
  };
}
