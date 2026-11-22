// Faithful stand-ins for the GitHub and GitLab REST endpoints the GitHub and GitLab
// plugin uses (docs/git-sync.md#requests), with real Git object ids, mutable branches and
// tokens, so tests never contact either host or need an account. Shapes, status codes and
// messages follow the public documentation (checked November 22, 2026); where a message is
// not documented, the text the hosts are widely seen to send is used and marked "(seen)".
//
// GitHub REST (https://docs.github.com/en/rest), api.github.com:
//   GET  /user                                         {login, id, …}; 401 Bad credentials (seen)
//   GET  /repos/{o}/{r}                                {full_name, private, default_branch, html_url, permissions{admin,maintain,push,triage,pull}}
//   GET  /repos/{o}/{r}/git/ref/heads/{branch}         {ref, node_id, url, object{type, sha, url}}; 404; 409 empty repository
//   GET  /repos/{o}/{r}/git/commits/{sha}              {sha, tree{sha,url}, parents[{sha,url,html_url}], message, …}
//   GET  /repos/{o}/{r}/git/trees/{sha}[?recursive=1]  {sha, url, tree[{path, mode, type, sha, size?, url}], truncated}
//   GET  /repos/{o}/{r}/git/blobs/{sha}                Accept application/vnd.github.raw+json → raw bytes; else JSON base64
//   POST /repos/{o}/{r}/git/blobs                      {content, encoding utf-8|base64} → 201 {url, sha}
//   POST /repos/{o}/{r}/git/trees                      {base_tree, tree[{path, mode, type, sha|content}]}; sha null deletes → 201
//   POST /repos/{o}/{r}/git/commits                    {message, tree, parents} → 201
//   PATCH /repos/{o}/{r}/git/refs/heads/{branch}       {sha, force=false}; 422 "Update is not a fast forward" (seen)
//   POST /repos/{o}/{r}/git/refs                       {ref, sha}; 422 "Reference already exists" (seen)
//   GET  /repos/{o}/{r}/compare/{base}...{head}        {status ahead|behind|diverged|identical, ahead_by, behind_by, total_commits, commits}
//   Fine-grained tokens: GETs need Contents read; POST/PATCH need Contents write, else 403
//   "Resource not accessible by personal access token" with X-Accepted-GitHub-Permissions;
//   a repository the token cannot see is 404. Rate limit headers: 5,000 an hour per token.
//   CORS: ACAO *, preflight allows Authorization, Content-Type, If-Match, If-Modified-Since,
//   If-None-Match, If-Unmodified-Since, X-Requested-With; methods GET, POST, PATCH, PUT, DELETE.
// GitLab REST v4 (https://docs.gitlab.com/api/), {origin}/api/v4:
//   GET  /user, GET /personal_access_tokens/self {scopes, …}
//   GET  /projects/{id}                                {path_with_namespace, default_branch, visibility, web_url, empty_repo, permissions{project_access{access_level}}}
//   GET  /projects/{id}/repository/branches/{branch}   {name, commit{id, short_id, parent_ids, …}, protected, can_push, …}; 404 "404 Branch Not Found" (seen)
//   GET  /projects/{id}/repository/tree?ref&path&recursive&per_page&pagination=keyset → [{id, name, type, path, mode}], Link rel="next"
//   GET  /projects/{id}/repository/blobs/{sha}/raw     bytes
//   HEAD /projects/{id}/repository/files/{path}?ref    X-Gitlab-Blob-Id, -Commit-Id, -Last-Commit-Id, -Size, …; 404 "404 File Not Found"
//   GET  /projects/{id}/repository/compare?from&to&straight → {commit, commits, diffs, compare_timeout, compare_same_ref, web_url}
//   POST /projects/{id}/repository/commits             {branch, commit_message, actions[], start_sha?} → 201 {id, short_id, parent_ids, …};
//        400 {"message": …}: "The file has changed since you started editing it: <path>",
//        "A file with this name already exists" (seen), "A file with this name doesn't exist" (seen),
//        "A branch called '<b>' already exists. Switch to that branch in order to make changes" (seen)
//   Scopes: tree, raw blobs, compare need read_api or api; HEAD files also read_repository;
//   commits need api. Missing scope: 403 {"error":"insufficient_scope", …} with WWW-Authenticate.
//   Bad token: 401 {"message":"401 Unauthorized"}. Pushing needs access level 30 (Developer).
//   CORS: ACAO *, any headers and methods, credentials false, the expose list below.
import http from 'node:http';
import {createHash} from 'node:crypto';

const GITHUB_EXPOSE='ETag, Link, Location, Retry-After, X-GitHub-OTP, X-RateLimit-Limit, X-RateLimit-Remaining, X-RateLimit-Used, X-RateLimit-Resource, X-RateLimit-Reset, X-OAuth-Scopes, X-Accepted-OAuth-Scopes, X-Poll-Interval, X-GitHub-Media-Type, X-GitHub-SSO, X-GitHub-Request-Id, Deprecation, Sunset';
const GITLAB_EXPOSE='Link, X-Total, X-Total-Pages, X-Per-Page, X-Page, X-Next-Page, X-Prev-Page, X-Gitlab-Blob-Id, X-Gitlab-Commit-Id, X-Gitlab-Content-Sha256, X-Gitlab-Encoding, X-Gitlab-File-Name, X-Gitlab-File-Path, X-Gitlab-Last-Commit-Id, X-Gitlab-Ref, X-Gitlab-Size, X-Request-Id, ETag, X-Streaming-Format';
const sha1=buffer=>createHash('sha1').update(buffer).digest('hex');
const object=(type,body)=>sha1(Buffer.concat([Buffer.from(`${type} ${body.length}\0`),body]));

/** A Git repository in memory: content-addressed objects and branches. */
export function gitRepository(){
  const objects=new Map(),branches=new Map();let clock=1795000000;
  const repo={
    objects,branches,
    blob(content){const data=Buffer.from(typeof content==='string'?Buffer.from(content,'utf8'):content),sha=object('blob',data);objects.set(sha,{type:'blob',data});return sha;},
    /** Writes the trees for {path → {sha, mode}}; returns the root tree id. */
    tree(files){
      const dirs=new Map([['',new Map()]]);
      for(const [path,entry]of files){
        const parts=path.split('/');
        for(let i=1;i<parts.length;i++){const dir=parts.slice(0,i).join('/'),parent=parts.slice(0,i-1).join('/');if(!dirs.has(dir)){dirs.set(dir,new Map());}dirs.get(parent).set(parts[i-1],{type:'tree',dir});}
        dirs.get(parts.slice(0,-1).join('/')).set(parts.at(-1),{type:entry.mode==='160000'?'commit':'blob',mode:entry.mode||'100644',sha:entry.sha});
      }
      const write=dir=>{
        const items=[...dirs.get(dir)].map(([name,item])=>item.type==='tree'?{name,type:'tree',mode:'040000',sha:write(item.dir)}:{name,...item});
        items.sort((a,b)=>Buffer.compare(Buffer.from(a.name+(a.type==='tree'?'/':'')),Buffer.from(b.name+(b.type==='tree'?'/':''))));
        const body=Buffer.concat(items.map(item=>Buffer.concat([Buffer.from(`${item.mode==='040000'?'40000':item.mode} ${item.name}\0`),Buffer.from(item.sha,'hex')])));
        const sha=object('tree',body);objects.set(sha,{type:'tree',entries:items});return sha;
      };
      return write('');
    },
    /** {path → {sha, mode, type}} of a tree, recursively. */
    flatten(treeSha,prefix=''){
      const files=new Map();
      for(const item of objects.get(treeSha)?.entries||[]){
        const path=prefix+item.name;
        if(item.type==='tree')for(const [child,value]of repo.flatten(item.sha,path+'/'))files.set(child,value);
        else files.set(path,{sha:item.sha,mode:item.mode,type:item.type});
      }
      return files;
    },
    commit({tree,parents=[],message='Commit',author='Fake Author'}){
      clock+=60;
      const body=Buffer.from(`tree ${tree}\n${parents.map(parent=>`parent ${parent}\n`).join('')}author ${author} <fake@example.org> ${clock} +0000\ncommitter ${author} <fake@example.org> ${clock} +0000\n\n${message}\n`);
      const sha=object('commit',body);objects.set(sha,{type:'commit',tree,parents,message,author,time:clock});return sha;
    },
    /** Commits {path → content | {content, mode} | {submodule: sha} | null (delete)} on top of a branch. */
    commitFiles(branch,changes,{message='Change',author}={}){
      const parent=branches.get(branch)||null,files=parent?repo.flatten(objects.get(parent).tree):new Map();
      for(const [path,value]of Object.entries(changes)){
        if(value===null){files.delete(path);continue;}
        if(value?.submodule){files.set(path,{sha:value.submodule,mode:'160000'});continue;}
        const spec=typeof value==='string'||value instanceof Uint8Array||Buffer.isBuffer(value)?{content:value}:value;
        files.set(path,{sha:repo.blob(spec.content),mode:spec.mode||'100644'});
      }
      const sha=repo.commit({tree:repo.tree(files),parents:parent?[parent]:[],message,author});branches.set(branch,sha);return sha;
    },
    /** {path → text} at a branch or commit (submodules and binary as their ids or Buffers). */
    files(ref,{binary=false}={}){
      const sha=branches.get(ref)||ref,result={};
      for(const [path,entry]of repo.flatten(objects.get(sha).tree))result[path]=entry.type==='blob'?(binary?objects.get(entry.sha).data:objects.get(entry.sha).data.toString('utf8')):`<submodule ${entry.sha}>`;
      return result;
    },
    ancestors(sha){const seen=new Set(),stack=[sha];while(stack.length){const next=stack.pop();if(!next||seen.has(next))continue;seen.add(next);stack.push(...(objects.get(next)?.parents||[]));}return seen;},
    isAncestor(a,b){return repo.ancestors(b).has(a);},
    /** Commits reachable from `head` but not from `base`, oldest first. */
    between(base,head){const exclude=repo.ancestors(base),list=[...repo.ancestors(head)].filter(sha=>!exclude.has(sha));return list.sort((a,b)=>objects.get(a).time-objects.get(b).time);},
    /** The last commit on the first-parent line of `ref` that changed `path`. */
    lastCommitFor(ref,path){
      let sha=branches.get(ref)||ref;
      while(sha){const current=repo.flatten(objects.get(sha).tree).get(path)?.sha,parent=objects.get(sha).parents[0],before=parent?repo.flatten(objects.get(parent).tree).get(path)?.sha:undefined;if(current!==before)return sha;sha=parent;}
      return null;
    },
  };
  return repo;
}

function listen(handler){
  const log=[];
  const server=http.createServer((req,res)=>{
    const chunks=[];req.on('data',chunk=>chunks.push(chunk));
    req.on('end',()=>{
      const body=Buffer.concat(chunks);log.push({method:req.method,url:req.url,headers:{...req.headers},body:body.length<4096?body.toString('utf8'):`<${body.length} bytes>`});
      Promise.resolve(handler(req,res,body)).catch(error=>{if(!res.headersSent)res.writeHead(500,{'Access-Control-Allow-Origin':'*'});res.end(String(error?.stack||error));});
    });
  });
  return {log,server,async listen(){await new Promise(done=>server.listen(0,'127.0.0.1',done));return `http://127.0.0.1:${server.address().port}`;},close:()=>new Promise(done=>{server.closeAllConnections?.();server.close(done);})};
}
const send=(res,status,headers,body='')=>{const data=Buffer.isBuffer(body)?body:Buffer.from(body);res.writeHead(status,{...headers,'Content-Length':data.length});res.end(data);};
const parseJson=body=>{try{return JSON.parse(body.toString('utf8')||'null');}catch{return undefined;}};

/**
 * GitHub's REST API. `tokens` {token → {login, repos: {"o/r": 'read' | 'write'}}};
 * `repos` {"o/r" → {repo: gitRepository(), private, defaultBranch}}.
 */
export function fakeGitHubApi(){
  const repos=new Map(),tokens=new Map(),state={limit:5000,used:0,reset:Math.floor(Date.now()/1000)+3600,beforeRefUpdate:null};
  const origin='https://api.github.com';
  const cors={'Access-Control-Allow-Origin':'*','Access-Control-Expose-Headers':GITHUB_EXPOSE,'Vary':'Accept-Encoding, Accept, X-Requested-With'};
  const rate=()=>({'x-ratelimit-limit':String(state.limit),'x-ratelimit-remaining':String(Math.max(0,state.limit-state.used)),'x-ratelimit-used':String(state.used),'x-ratelimit-reset':String(state.reset),'x-ratelimit-resource':'core'});
  const json=(res,status,value,extra={})=>send(res,status,{...cors,...rate(),'Content-Type':'application/json; charset=utf-8',...extra},JSON.stringify(value));
  const error=(res,status,message,docs='https://docs.github.com/rest',extra={})=>json(res,status,{message,documentation_url:docs,status:String(status)},extra);
  const api=listen((req,res,body)=>{
    if(req.method==='OPTIONS'){send(res,204,{...cors,'Access-Control-Allow-Headers':'Authorization, Content-Type, If-Match, If-Modified-Since, If-None-Match, If-Unmodified-Since, X-Requested-With','Access-Control-Allow-Methods':'GET, POST, PATCH, PUT, DELETE','Access-Control-Max-Age':'86400'});return;}
    const auth=/^(?:Bearer|token) (.+)$/i.exec(req.headers.authorization||'')?.[1]||null,token=auth?tokens.get(auth):null;
    if(auth&&!token){error(res,401,'Bad credentials','https://docs.github.com/rest');return;}
    if(state.used>=state.limit){error(res,403,`API rate limit exceeded for user ID 1.`,'https://docs.github.com/rest/overview/rate-limits-for-the-rest-api');return;}
    state.used++;
    const url=new URL(req.url,'http://x');
    if(url.pathname==='/user'){if(!token){error(res,401,'Requires authentication','https://docs.github.com/rest/users/users#get-the-authenticated-user');return;}json(res,200,{login:token.login,id:1,type:'User',name:token.login});return;}
    const match=/^\/repos\/([^/]+)\/([^/]+)(\/.*)?$/.exec(url.pathname);
    if(!match){error(res,404,'Not Found');return;}
    const name=`${decodeURIComponent(match[1])}/${decodeURIComponent(match[2])}`,entry=repos.get(name.toLowerCase()),access=token?.repos[entry?.name]||(entry&&!entry.private?'public':null);
    if(!entry||!access){error(res,404,'Not Found','https://docs.github.com/rest/repos/repos#get-a-repository');return;}
    const {repo}=entry,rest=match[3]||'',write=req.method!=='GET'&&req.method!=='HEAD';
    if(write&&access!=='write'){error(res,403,'Resource not accessible by personal access token','https://docs.github.com/rest',{'X-Accepted-GitHub-Permissions':'contents=write'});return;}
    const repoUrl=`${origin}/repos/${entry.name}`;
    const commitJson=sha=>{const commit=repo.objects.get(sha);const person={name:commit.author,email:'fake@example.org',date:new Date(commit.time*1000).toISOString()};return {sha,node_id:`C_${sha.slice(0,8)}`,url:`${repoUrl}/git/commits/${sha}`,html_url:`https://github.com/${entry.name}/commit/${sha}`,author:person,committer:person,message:commit.message,tree:{sha:commit.tree,url:`${repoUrl}/git/trees/${commit.tree}`},parents:commit.parents.map(parent=>({sha:parent,url:`${repoUrl}/git/commits/${parent}`,html_url:`https://github.com/${entry.name}/commit/${parent}`})),verification:{verified:false,reason:'unsigned',signature:null,payload:null}};};
    const refJson=branch=>({ref:`refs/heads/${branch}`,node_id:'REF_fake',url:`${repoUrl}/git/refs/heads/${branch}`,object:{sha:repo.branches.get(branch),type:'commit',url:`${repoUrl}/git/commits/${repo.branches.get(branch)}`}});
    if(!rest){json(res,200,{id:1,node_id:'R_fake',name:entry.name.split('/')[1],full_name:entry.name,private:entry.private,html_url:`https://github.com/${entry.name}`,default_branch:entry.defaultBranch,visibility:entry.private?'private':'public',permissions:{admin:false,maintain:false,push:access==='write',triage:access==='write',pull:true}});return;}
    if(!repo.branches.size&&rest.startsWith('/git')){error(res,409,'Git Repository is empty.','https://docs.github.com/rest/git/refs#get-a-reference');return;}
    let m;
    if(req.method==='GET'&&(m=/^\/git\/ref\/heads\/(.+)$/.exec(rest))){const branch=decodeURIComponent(m[1]);if(!repo.branches.has(branch)){error(res,404,'Not Found','https://docs.github.com/rest/git/refs#get-a-reference');return;}json(res,200,refJson(branch));return;}
    if(req.method==='GET'&&(m=/^\/git\/commits\/([0-9a-f]{40})$/.exec(rest))){if(repo.objects.get(m[1])?.type!=='commit'){error(res,404,'Not Found');return;}json(res,200,commitJson(m[1]));return;}
    if(req.method==='GET'&&(m=/^\/git\/trees\/([0-9a-f]{40})$/.exec(rest))){
      const tree=repo.objects.get(m[1]);if(tree?.type!=='tree'){error(res,404,'Not Found','https://docs.github.com/rest/git/trees#get-a-tree');return;}
      const items=[],walk=(sha,prefix)=>{for(const item of repo.objects.get(sha).entries){const path=prefix+item.name;items.push({path,mode:item.mode,type:item.type,sha:item.sha,...(item.type==='blob'?{size:repo.objects.get(item.sha).data.length}:{}),...(item.type==='commit'?{}:{url:`${repoUrl}/git/${item.type}s/${item.sha}`})});if(item.type==='tree'&&url.searchParams.has('recursive'))walk(item.sha,path+'/');}};
      walk(m[1],'');json(res,200,{sha:m[1],url:`${repoUrl}/git/trees/${m[1]}`,tree:items,truncated:false});return;
    }
    if(req.method==='GET'&&(m=/^\/git\/blobs\/([0-9a-f]{40})$/.exec(rest))){
      const blob=repo.objects.get(m[1]);if(blob?.type!=='blob'){error(res,404,'Not Found','https://docs.github.com/rest/git/blobs#get-a-blob');return;}
      if(/application\/vnd\.github\.raw/.test(req.headers.accept||'')){send(res,200,{...cors,...rate(),'Content-Type':'application/vnd.github.raw; charset=utf-8'},blob.data);return;}
      json(res,200,{sha:m[1],node_id:'B_fake',size:blob.data.length,url:`${repoUrl}/git/blobs/${m[1]}`,content:blob.data.toString('base64').replace(/(.{60})/g,'$1\n'),encoding:'base64'});return;
    }
    if(req.method==='GET'&&(m=/^\/compare\/([0-9a-f]{40})\.\.\.([0-9a-f]{40})$/.exec(rest))){
      const [base,head]=[m[1],m[2]];if(!repo.objects.has(base)||!repo.objects.has(head)){error(res,404,'Not Found');return;}
      const ahead=repo.between(base,head),behind=repo.between(head,base);
      json(res,200,{url:`${repoUrl}/compare/${base}...${head}`,status:base===head?'identical':!behind.length?'ahead':!ahead.length?'behind':'diverged',ahead_by:ahead.length,behind_by:behind.length,total_commits:ahead.length,commits:ahead.map(commitJson),files:[]});return;
    }
    const input=parseJson(body);
    if(write&&input===undefined){error(res,400,'Problems parsing JSON');return;}
    if(req.method==='POST'&&rest==='/git/blobs'){
      if(typeof input?.content!=='string'){error(res,422,'Invalid request.\n\n"content" wasn\'t supplied.');return;}
      const sha=repo.blob(input.encoding==='base64'?Buffer.from(input.content,'base64'):Buffer.from(input.content,'utf8'));
      json(res,201,{url:`${repoUrl}/git/blobs/${sha}`,sha},{Location:`${repoUrl}/git/blobs/${sha}`});return;
    }
    if(req.method==='POST'&&rest==='/git/trees'){
      const files=input.base_tree?repo.flatten(input.base_tree):new Map();
      if(input.base_tree&&repo.objects.get(input.base_tree)?.type!=='tree'){error(res,422,'Invalid tree info');return;}
      for(const item of input.tree||[]){
        if(typeof item.path!=='string'||item.path.startsWith('/')||item.path.split('/').some(part=>!part||part==='.'||part==='..'||part==='.git')){error(res,422,`tree.path contains a malformed path component`);return;}
        if(item.sha===null){if(!files.has(item.path)&&![...files.keys()].some(path=>path.startsWith(item.path+'/'))){error(res,422,`GitRPC::BadObjectState`);return;}for(const path of [...files.keys()])if(path===item.path||path.startsWith(item.path+'/'))files.delete(path);continue;}
        const sha=typeof item.content==='string'?repo.blob(item.content):item.sha;
        if(repo.objects.get(sha)?.type!=='blob'){error(res,422,'Invalid tree info');return;}
        files.set(item.path,{sha,mode:item.mode||'100644'});
      }
      const sha=repo.tree(files);
      json(res,201,{sha,url:`${repoUrl}/git/trees/${sha}`,tree:repo.objects.get(sha).entries.map(item=>({path:item.name,mode:item.mode,type:item.type,sha:item.sha,url:`${repoUrl}/git/${item.type}s/${item.sha}`})),truncated:false});return;
    }
    if(req.method==='POST'&&rest==='/git/commits'){
      if(repo.objects.get(input.tree)?.type!=='tree'||!Array.isArray(input.parents)||input.parents.some(parent=>repo.objects.get(parent)?.type!=='commit')){error(res,422,'Invalid request.');return;}
      const sha=repo.commit({tree:input.tree,parents:input.parents,message:String(input.message||''),author:token.login});
      json(res,201,commitJson(sha),{Location:`${repoUrl}/git/commits/${sha}`});return;
    }
    if(req.method==='PATCH'&&(m=/^\/git\/refs\/heads\/(.+)$/.exec(rest))){
      const branch=decodeURIComponent(m[1]);if(!repo.branches.has(branch)){error(res,422,'Reference does not exist','https://docs.github.com/rest/git/refs#update-a-reference');return;}
      state.beforeRefUpdate?.(branch);
      if(repo.objects.get(input.sha)?.type!=='commit'){error(res,422,'Object does not exist');return;}
      if(!input.force&&!repo.isAncestor(repo.branches.get(branch),input.sha)){error(res,422,'Update is not a fast forward','https://docs.github.com/rest/git/refs#update-a-reference');return;}
      repo.branches.set(branch,input.sha);json(res,200,refJson(branch));return;
    }
    if(req.method==='POST'&&rest==='/git/refs'){
      const branch=/^refs\/heads\/(.+)$/.exec(input.ref||'')?.[1];
      if(!branch||repo.objects.get(input.sha)?.type!=='commit'){error(res,422,'Invalid request.');return;}
      if(repo.branches.has(branch)){error(res,422,'Reference already exists','https://docs.github.com/rest/git/refs#create-a-reference');return;}
      repo.branches.set(branch,input.sha);json(res,201,refJson(branch),{Location:`${repoUrl}/git/refs/heads/${branch}`});return;
    }
    error(res,404,'Not Found');
  });
  return {
    api,origin,state,
    addRepo(name,{repo=gitRepository(),private:isPrivate=true,defaultBranch='main'}={}){repos.set(name.toLowerCase(),{name,repo,private:isPrivate,defaultBranch});return repo;},
    addToken(token,{login='octocat',repos:access={}}={}){tokens.set(token,{login,repos:access});return this;},
    repo:name=>repos.get(name.toLowerCase()).repo,
    start:()=>api.listen(),close:()=>api.close(),requests:()=>api.log,
  };
}

/** GitLab's REST API v4 for one origin (gitlab.com or self-hosted). */
export function fakeGitLabApi({origin='https://gitlab.com'}={}){
  const projects=new Map(),tokens=new Map();let nextId=4200;const state={beforeCommit:null};
  const cors={'Access-Control-Allow-Origin':'*','Access-Control-Expose-Headers':GITLAB_EXPOSE};
  const json=(res,status,value,extra={})=>send(res,status,{...cors,'Content-Type':'application/json',...extra},JSON.stringify(value));
  const server=listen((req,res,body)=>{
    if(req.method==='OPTIONS'){send(res,204,{...cors,'Access-Control-Allow-Methods':req.headers['access-control-request-method']||'GET','Access-Control-Allow-Headers':req.headers['access-control-request-headers']||'','Access-Control-Max-Age':'7200'});return;}
    const secret=req.headers['private-token']||/^Bearer (.+)$/i.exec(req.headers.authorization||'')?.[1]||null,token=secret?tokens.get(secret):null;
    if(secret&&!token){json(res,401,{message:'401 Unauthorized'});return;}
    const url=new URL(req.url,'http://x'),parts=url.pathname.split('/');
    if(parts[1]!=='api'||parts[2]!=='v4'){json(res,404,{error:'404 Not Found'});return;}
    const scope=needed=>{
      if(!token)return true;
      if(needed.some(item=>token.scopes.includes(item)))return true;
      json(res,403,{error:'insufficient_scope',error_description:'The request requires higher privileges than provided by the access token.',scope:needed.join(' ')},{'WWW-Authenticate':`Bearer realm="GitLab", error="insufficient_scope", error_description="The request requires higher privileges than provided by the access token.", scope="${needed.join(' ')}"`});return false;
    };
    if(parts[3]==='user'&&parts.length===4){if(!token){json(res,401,{message:'401 Unauthorized'});return;}if(!scope(['read_user','read_api','api']))return;json(res,200,{id:7,username:token.username,name:token.username,state:'active'});return;}
    if(parts[3]==='personal_access_tokens'&&parts[4]==='self'){if(!token){json(res,401,{message:'401 Unauthorized'});return;}json(res,200,{id:11,name:'Scribyra',revoked:false,created_at:'2026-11-01T00:00:00.000Z',scopes:token.scopes,user_id:7,active:true,expires_at:'2027-11-01'});return;}
    if(parts[3]!=='projects'){json(res,404,{error:'404 Not Found'});return;}
    const id=decodeURIComponent(parts[4]||''),project=projects.get(id.toLowerCase())||[...projects.values()].find(item=>String(item.id)===id);
    const level=project?(token?.projects[project.path]??(project.visibility==='public'?10:0)):0;
    if(!project||!level){json(res,404,{message:'404 Project Not Found'});return;}
    const {repo}=project,rest=parts.slice(5),web=`${origin}/${project.path}`;
    const commitJson=sha=>{const commit=repo.objects.get(sha),at=new Date(commit.time*1000).toISOString();return {id:sha,short_id:sha.slice(0,8),created_at:at,parent_ids:commit.parents,title:commit.message.split('\n')[0],message:commit.message,author_name:commit.author,author_email:'fake@example.org',authored_date:at,committer_name:commit.author,committer_email:'fake@example.org',committed_date:at,web_url:`${web}/-/commit/${sha}`};};
    if(!rest.length){if(!scope(['read_api','api']))return;json(res,200,{id:project.id,name:project.path.split('/').at(-1),path_with_namespace:project.path,default_branch:repo.branches.size?project.defaultBranch:null,visibility:project.visibility,web_url:web,empty_repo:!repo.branches.size,permissions:{project_access:{access_level:level,notification_level:3},group_access:null}});return;}
    if(rest[0]!=='repository'){json(res,404,{error:'404 Not Found'});return;}
    if(rest[1]==='files'&&(req.method==='HEAD'||req.method==='GET')){
      if(!scope(['read_repository','read_api','api']))return;
      const path=decodeURIComponent(rest.slice(2).join('/')),ref=url.searchParams.get('ref')||project.defaultBranch,sha=repo.branches.get(ref)||ref;
      const entry=repo.objects.get(sha)?.type==='commit'?repo.flatten(repo.objects.get(sha).tree).get(path):null;
      if(!entry){json(res,404,{message:'404 File Not Found'});return;}
      const data=repo.objects.get(entry.sha).data;
      const headers={...cors,'Content-Type':'application/json','X-Gitlab-Blob-Id':entry.sha,'X-Gitlab-Commit-Id':sha,'X-Gitlab-Content-Sha256':createHash('sha256').update(data).digest('hex'),'X-Gitlab-Encoding':'base64','X-Gitlab-File-Name':path.split('/').at(-1),'X-Gitlab-File-Path':path,'X-Gitlab-Last-Commit-Id':repo.lastCommitFor(sha,path),'X-Gitlab-Ref':ref,'X-Gitlab-Size':String(data.length),'X-Gitlab-Execute-Filemode':String(entry.mode==='100755')};
      if(req.method==='HEAD'){res.writeHead(200,headers);res.end();return;}
      send(res,200,headers,JSON.stringify({file_name:path.split('/').at(-1),file_path:path,size:data.length,encoding:'base64',content:data.toString('base64'),ref,blob_id:entry.sha,commit_id:sha,last_commit_id:repo.lastCommitFor(sha,path)}));return;
    }
    if(rest[1]==='branches'){
      if(!scope(['read_api','api']))return;
      const branch=decodeURIComponent(rest.slice(2).join('/'));if(!repo.branches.has(branch)){json(res,404,{message:'404 Branch Not Found'});return;}
      json(res,200,{name:branch,commit:commitJson(repo.branches.get(branch)),merged:false,protected:false,default:branch===project.defaultBranch,developers_can_push:true,developers_can_merge:true,can_push:level>=30,web_url:`${web}/-/tree/${branch}`});return;
    }
    if(rest[1]==='tree'){
      if(!scope(['read_api','api']))return;
      const ref=url.searchParams.get('ref')||project.defaultBranch,sha=repo.branches.get(ref)||ref,commit=repo.objects.get(sha);
      if(commit?.type!=='commit'){json(res,404,{message:'404 Tree Not Found'});return;}
      const prefix=(url.searchParams.get('path')||'').replace(/\/$/,''),recursive=url.searchParams.get('recursive')==='true',perPage=Math.min(100,Number(url.searchParams.get('per_page')||20));
      const all=[];const walk=(treeSha,base)=>{for(const item of repo.objects.get(treeSha).entries){const path=base+item.name;all.push({id:item.sha,name:item.name,type:item.type,path,mode:item.mode});if(item.type==='tree'&&recursive)walk(item.sha,path+'/');}};
      let start=commit.tree;
      if(prefix){for(const part of prefix.split('/')){const next=repo.objects.get(start).entries.find(item=>item.type==='tree'&&item.name===part);if(!next){json(res,404,{message:'404 Tree Not Found'});return;}start=next.sha;}}
      walk(start,prefix?prefix+'/':'');
      const tokenParam=url.searchParams.get('page_token'),from=tokenParam?all.findIndex(item=>item.path===JSON.parse(Buffer.from(tokenParam,'base64').toString()).file_name)+1:0;
      const page=all.slice(from,from+perPage),headers={};
      if(from+perPage<all.length){const link=new URL(`${origin}/api/v4/projects/${encodeURIComponent(project.path)}/repository/tree`);for(const [key,value]of url.searchParams)if(key!=='page_token')link.searchParams.set(key,value);link.searchParams.set('page_token',Buffer.from(JSON.stringify({file_name:page.at(-1).path})).toString('base64'));headers.Link=`<${link.href}>; rel="next"`;}
      json(res,200,page,headers);return;
    }
    if(rest[1]==='blobs'&&rest[3]==='raw'){
      if(!scope(['read_api','api']))return;
      const blob=repo.objects.get(rest[2]);if(blob?.type!=='blob'){json(res,404,{message:'404 Blob Not Found'});return;}
      send(res,200,{...cors,'Content-Type':'text/plain; charset=utf-8','X-Content-Type-Options':'nosniff'},blob.data);return;
    }
    if(rest[1]==='compare'){
      if(!scope(['read_api','api']))return;
      const from=url.searchParams.get('from'),to=url.searchParams.get('to');if(!repo.objects.has(from)||!repo.objects.has(to)){json(res,404,{message:'404 Ref Not Found'});return;}
      const commits=repo.between(from,to);
      json(res,200,{commit:commits.length?commitJson(commits.at(-1)):null,commits:commits.map(commitJson),diffs:[],compare_timeout:false,compare_same_ref:from===to,web_url:`${web}/-/compare/${from}...${to}`});return;
    }
    if(rest[1]==='commits'&&req.method==='POST'){
      if(!scope(['api']))return;
      if(level<30){json(res,403,{message:'403 Forbidden - You are not allowed to push into this branch'});return;}
      const input=parseJson(body);if(!input||typeof input.branch!=='string'||typeof input.commit_message!=='string'||!Array.isArray(input.actions)){json(res,400,{error:'branch is missing, commit_message is missing'});return;}
      state.beforeCommit?.(input.branch);
      let parent;
      if(input.start_sha){if(repo.branches.has(input.branch)){json(res,400,{message:`A branch called '${input.branch}' already exists. Switch to that branch in order to make changes`});return;}parent=input.start_sha;if(repo.objects.get(parent)?.type!=='commit'){json(res,400,{message:'Invalid start_sha'});return;}}
      else{parent=repo.branches.get(input.branch);if(!parent){json(res,400,{message:`You can only create or edit files when you are on a branch`});return;}}
      const files=repo.flatten(repo.objects.get(parent).tree);
      for(const action of input.actions){
        const path=action.file_path;
        if(typeof path!=='string'||path.split('/').some(part=>!part||part==='..'||part==='.git')){json(res,400,{message:'Invalid file path'});return;}
        if(action.last_commit_id&&['update','delete','move'].includes(action.action)&&repo.lastCommitFor(parent,path)!==action.last_commit_id){json(res,400,{message:`The file has changed since you started editing it: ${path}`});return;}
        if(action.action==='create'&&files.has(path)){json(res,400,{message:'A file with this name already exists'});return;}
        if(['update','delete'].includes(action.action)&&!files.has(path)){json(res,400,{message:"A file with this name doesn't exist"});return;}
        if(action.action==='delete'){files.delete(path);continue;}
        if(!['create','update'].includes(action.action)){json(res,400,{message:'Unknown action'});return;}
        const content=action.encoding==='base64'?Buffer.from(action.content||'','base64'):Buffer.from(action.content||'','utf8');
        files.set(path,{sha:repo.blob(content),mode:action.execute_filemode?'100755':files.get(path)?.mode||'100644'});
      }
      const sha=repo.commit({tree:repo.tree(files),parents:[parent],message:input.commit_message,author:token.username});
      repo.branches.set(input.branch,sha);
      json(res,201,{...commitJson(sha),stats:{additions:0,deletions:0,total:0},status:null,project_id:project.id});return;
    }
    json(res,404,{error:'404 Not Found'});
  });
  return {
    server,origin,state,
    addProject(path,{repo=gitRepository(),visibility='private',defaultBranch='main'}={}){projects.set(path.toLowerCase(),{id:nextId++,path,repo,visibility,defaultBranch});return repo;},
    addToken(token,{username='ada',scopes=['api'],projects:access={}}={}){tokens.set(token,{username,scopes,projects:access});return this;},
    repo:path=>projects.get(path.toLowerCase()).repo,
    start:()=>server.listen(),close:()=>server.close(),requests:()=>server.log,
  };
}
