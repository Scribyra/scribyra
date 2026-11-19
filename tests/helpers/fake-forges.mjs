// Faithful stand-ins for the public endpoints "Open in Scribyra" links use, so tests never
// contact GitHub, GitLab or a file host. Shapes follow the public documentation and the
// replies the real hosts sent to anonymous requests with an Origin header on
// November 19, 2026 (recorded in docs/open-links.md, "What the real hosts allow"):
//
// GitHub REST (https://docs.github.com/en/rest): api.github.com
//   GET /repos/{o}/{r}/commits/{ref}   Accept: application/vnd.github.sha → the SHA as text;
//       otherwise JSON. 404 unknown/private repo, 422 unknown ref, 409 empty repository.
//   GET /repos/{o}/{r}/git/trees/{sha}?recursive=1 → {sha,url,tree:[{path,mode,type,sha,size?,url}],truncated}
//   Every reply: Access-Control-Allow-Origin: *, Access-Control-Expose-Headers (ETag, Link,
//   Retry-After, X-RateLimit-*…), x-ratelimit-limit 60 / remaining / used / reset / resource core.
//   Over the limit: 403 {"message":"API rate limit exceeded for …"} with remaining 0.
// raw.githubusercontent.com: GET /{o}/{r}/{sha-or-ref}/{path} → bytes, ACAO *, 404 "404: Not Found".
// codeload.github.com sends ACAO https://render.githubusercontent.com only, so it is not modelled.
// GitLab REST v4 (https://docs.gitlab.com/api/): {host}/api/v4
//   GET /projects/{id}                       → project JSON with default_branch
//   GET /projects/{id}/repository/commits/{ref} → {id, short_id, …}; 404 {"message":"404 Commit Not Found"}
//   GET /projects/{id}/repository/tree?recursive=true&per_page&pagination=keyset&ref&path
//       → [{id,name,type,path,mode}], Link rel="next" with page_token; 404 "404 Tree Not Found"
//   GET /projects/{id}/repository/archive.zip?sha&path → ZIP with one top folder
//       <project>-<sha>-<sha>[-<path>]; export-ignore files left out; symlinks as Unix links.
//   Every reply: ACAO *, Access-Control-Expose-Headers (Link, X-Total…, no RateLimit-*),
//   RateLimit-* headers (not readable cross-origin). Throttled: 429 "Retry later".
import http from 'node:http';
import {createHash} from 'node:crypto';
import {zipSync,strToU8} from 'fflate';

const GITHUB_EXPOSE='ETag, Link, Location, Retry-After, X-GitHub-OTP, X-RateLimit-Limit, X-RateLimit-Remaining, X-RateLimit-Used, X-RateLimit-Resource, X-RateLimit-Reset, X-OAuth-Scopes, X-Accepted-OAuth-Scopes, X-Poll-Interval, X-GitHub-Media-Type, X-GitHub-SSO, X-GitHub-Request-Id, Deprecation, Sunset, Warning';
const GITLAB_EXPOSE='Link, X-Total, X-Total-Pages, X-Per-Page, X-Page, X-Next-Page, X-Prev-Page, X-Gitlab-Blob-Id, X-Gitlab-Commit-Id, X-Gitlab-Content-Sha256, X-Gitlab-Encoding, X-Gitlab-File-Name, X-Gitlab-File-Path, X-Gitlab-Last-Commit-Id, X-Gitlab-Ref, X-Gitlab-Size, X-Request-Id, ETag, X-Streaming-Format';
const bytesOf=content=>typeof content==='string'?strToU8(content):content;
const sha1=(...parts)=>createHash('sha1').update(Buffer.concat(parts.map(part=>Buffer.from(part)))).digest('hex');
const gitObject=(type,body)=>sha1(Buffer.from(`${type} ${body.length}\0`),body);

/**
 * A repository snapshot from {path: content | {content, mode, size, exportIgnore}} plus
 * submodules {path: commitSha}. Object IDs are real Git hashes of this content.
 */
export function snapshot(files,{submodules={},message='Snapshot'}={}){
 const blobs=new Map();
 for(const [path,spec]of Object.entries(files)){
  const item=spec instanceof Uint8Array||typeof spec==='string'?{content:spec}:spec;
  const content=bytesOf(item.content??'');
  blobs.set(path,{path,content,mode:item.mode||'100644',size:item.size??content.length,sha:gitObject('blob',content),exportIgnore:!!item.exportIgnore});
 }
 const entries=[...blobs.values()].map(blob=>({path:blob.path,type:'blob',mode:blob.mode,sha:blob.sha,size:blob.size}));
 for(const [path,sha]of Object.entries(submodules))entries.push({path,type:'commit',mode:'160000',sha});
 // Directories, with real tree hashes built bottom-up.
 const dirs=new Map([['',[]]]);
 for(const entry of entries){const parts=entry.path.split('/');for(let i=1;i<parts.length;i++){const dir=parts.slice(0,i).join('/');if(!dirs.has(dir))dirs.set(dir,[]);}}
 const parent=path=>path.includes('/')?path.slice(0,path.lastIndexOf('/')):'';
 for(const entry of entries)dirs.get(parent(entry.path)).push(entry);
 const treeSha=new Map();
 const hashTree=dir=>{
  const children=[...dirs.get(dir)];
  for(const [other]of dirs)if(other&&parent(other)===dir)children.push({path:other,type:'tree',mode:'040000',sha:hashTree(other)});
  const name=entry=>entry.path.slice(dir?dir.length+1:0);
  children.sort((a,b)=>(name(a)+(a.type==='tree'?'/':'')).localeCompare(name(b)+(b.type==='tree'?'/':'')));
  const body=Buffer.concat(children.map(entry=>Buffer.concat([Buffer.from(`${entry.mode==='040000'?'40000':entry.mode} ${name(entry)}\0`),Buffer.from(entry.sha,'hex')])));
  const sha=gitObject('tree',body);treeSha.set(dir,sha);return sha;
 };
 const root=hashTree('');
 for(const [dir,sha]of treeSha)if(dir)entries.push({path:dir,type:'tree',mode:'040000',sha});
 entries.sort((a,b)=>a.path.localeCompare(b.path));
 const commit=gitObject('commit',Buffer.from(`tree ${root}\nauthor Fake <fake@example.org> 1795000000 +0000\ncommitter Fake <fake@example.org> 1795000000 +0000\n\n${message}\n`));
 return {commit,tree:root,entries,blobs};
}
/** {defaultBranch, refs: {name: snapshot}}. */
export function repository(refs,{defaultBranch=Object.keys(refs)[0]}={}){return {defaultBranch,refs};}
function resolve(repo,ref){
 if(!ref||ref==='HEAD')return repo.refs[repo.defaultBranch];
 if(repo.refs[ref])return repo.refs[ref];
 return Object.values(repo.refs).find(snap=>snap.commit===ref||ref.length>=7&&/^[0-9a-f]+$/.test(ref)&&snap.commit.startsWith(ref))||null;
}

function listen(handler){
 const log=[];
 const server=http.createServer((req,res)=>{
  log.push({method:req.method,url:req.url,headers:{...req.headers}});
  Promise.resolve(handler(req,res)).catch(error=>{if(!res.headersSent)res.writeHead(500);res.end(String(error));});
 });
 return {log,server,async listen(){await new Promise(done=>server.listen(0,'127.0.0.1',done));return `http://127.0.0.1:${server.address().port}`;},close:()=>new Promise(done=>{server.closeAllConnections?.();server.close(done);})};
}
const send=(res,status,headers,body='')=>{const data=typeof body==='string'?Buffer.from(body):Buffer.from(body);res.writeHead(status,{...headers,'Content-Length':data.length});res.end(data);};

/** GitHub: the REST API and raw.githubusercontent.com, on two origins. */
export function fakeGitHub({limit=60,used=0,resetIn=1800}={}){
 const repos=new Map(),state={used,limit,reset:Math.floor(Date.now()/1000)+resetIn,truncated:false};
 const cors={'Access-Control-Allow-Origin':'*','Access-Control-Expose-Headers':GITHUB_EXPOSE,'Vary':'Accept-Encoding, Accept, X-Requested-With'};
 const rate=()=>({'x-ratelimit-limit':String(state.limit),'x-ratelimit-remaining':String(Math.max(0,state.limit-state.used)),'x-ratelimit-used':String(state.used),'x-ratelimit-reset':String(state.reset),'x-ratelimit-resource':'core'});
 const json=(res,status,value,extra={})=>send(res,status,{...cors,...rate(),'Content-Type':'application/json; charset=utf-8',...extra},JSON.stringify(value));
 const api=listen((req,res)=>{
  if(req.method==='OPTIONS'){send(res,204,{...cors,'Access-Control-Allow-Headers':'Authorization, Content-Type, If-Match, If-Modified-Since, If-None-Match, If-Unmodified-Since, Accept-Encoding, X-GitHub-OTP, X-Requested-With, User-Agent, GraphQL-Features, X-Github-Next-Global-ID, X-GitHub-Api-Version','Access-Control-Allow-Methods':'GET, POST, PATCH, PUT, DELETE','Access-Control-Max-Age':'86400'});return;}
  if(state.used>=state.limit){json(res,403,{message:'API rate limit exceeded for 203.0.113.7. (But here\'s the good news: Authenticated requests get a higher rate limit. Check out the documentation for more details.)',documentation_url:'https://docs.github.com/rest/overview/resources-in-the-rest-api#rate-limiting'});return;}
  state.used++;
  const url=new URL(req.url,'http://x'),match=/^\/repos\/([^/]+)\/([^/]+)\/(commits|git\/trees)\/(.+)$/.exec(url.pathname);
  const repo=match&&repos.get(`${match[1]}/${match[2]}`.toLowerCase());
  if(!repo){json(res,404,{message:'Not Found',documentation_url:'https://docs.github.com/rest/repos/repos#get-a-repository',status:'404'});return;}
  const ref=decodeURIComponent(match[4]);
  if(match[3]==='commits'){
   const snap=resolve(repo,ref);
   if(!snap){json(res,422,{message:`No commit found for SHA: ${ref}`,documentation_url:'https://docs.github.com/rest/commits/commits#get-a-commit',status:'422'});return;}
   if(req.headers.accept==='application/vnd.github.sha'){send(res,200,{...cors,...rate(),'Content-Type':'application/vnd.github.sha; charset=utf-8'},snap.commit);return;}
   json(res,200,{sha:snap.commit,node_id:'C_fake',commit:{tree:{sha:snap.tree,url:''},message:'Snapshot'},files:[]});return;
  }
  const snap=Object.values(repo.refs).find(item=>item.commit===ref||item.tree===ref)||resolve(repo,ref);
  if(!snap){json(res,404,{message:'Not Found',documentation_url:'https://docs.github.com/rest/git/trees#get-a-tree',status:'404'});return;}
  const recursive=url.searchParams.has('recursive');
  const tree=snap.entries.filter(entry=>recursive||!entry.path.includes('/')).map(entry=>({path:entry.path,mode:entry.mode,type:entry.type,sha:entry.sha,...(entry.type==='blob'?{size:entry.size}:{}),...(entry.type==='commit'?{}:{url:`https://api.github.com/repos/${match[1]}/${match[2]}/git/${entry.type}s/${entry.sha}`})}));
  json(res,200,{sha:snap.tree,url:`https://api.github.com/repos/${match[1]}/${match[2]}/git/trees/${snap.tree}`,tree,truncated:state.truncated});
 });
 const rawCors={'Access-Control-Allow-Origin':'*'};
 const raw=listen((req,res)=>{
  const parts=new URL(req.url,'http://x').pathname.split('/').slice(1).map(decodeURIComponent);
  const repo=repos.get(`${parts[0]}/${parts[1]}`.toLowerCase()),snap=repo&&resolve(repo,parts[2]),blob=snap?.blobs.get(parts.slice(3).join('/'));
  if(!blob){send(res,404,{...rawCors,'Content-Type':'text/plain; charset=utf-8'},'404: Not Found');return;}
  send(res,200,{...rawCors,'Content-Type':'text/plain; charset=utf-8','ETag':`"${blob.sha}"`,'Cache-Control':'max-age=300'},blob.content);
 });
 return {
  api,raw,state,
  add(name,repo){repos.set(name.toLowerCase(),repo);return this;},
  async start(){return {api:await api.listen(),raw:await raw.listen()};},
  close:()=>Promise.all([api.close(),raw.close()]),
  requests:()=>[...api.log,...raw.log],
 };
}

/** GitLab REST v4 for one host (gitlab.com or self-hosted). */
export function fakeGitLab({host='gitlab.com',throttleAfter=Infinity}={}){
 const projects=new Map();let next=1000,count=0;
 const cors={'Access-Control-Allow-Origin':'*','Access-Control-Allow-Methods':'GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS','Access-Control-Expose-Headers':GITLAB_EXPOSE,'Access-Control-Max-Age':'7200'};
 const rate=()=>({'RateLimit-Limit':'500','RateLimit-Name':'throttle_unauthenticated_api','RateLimit-Observed':String(count),'RateLimit-Remaining':String(Math.max(0,500-count)),'RateLimit-Reset':String(Math.floor(Date.now()/1000)+60)});
 const json=(res,status,value,extra={})=>send(res,status,{...cors,...rate(),'Content-Type':'application/json',...extra},JSON.stringify(value));
 const server=listen((req,res)=>{
  if(req.method==='OPTIONS'){send(res,204,{...cors,'Access-Control-Allow-Headers':'Authorization, Content-Type, Private-Token'});return;}
  count++;
  if(count>throttleAfter){send(res,429,{...cors,...rate(),'Retry-After':'60','Content-Type':'text/plain'},'Retry later\n');return;}
  const url=new URL(req.url,'http://x'),parts=url.pathname.split('/');
  if(parts[1]!=='api'||parts[2]!=='v4'||parts[3]!=='projects'){json(res,404,{error:'404 Not Found'});return;}
  const id=decodeURIComponent(parts[4]||''),project=projects.get(id.toLowerCase())||[...projects.values()].find(item=>String(item.id)===id);
  if(!project){json(res,404,{message:'404 Project Not Found'});return;}
  const rest=parts.slice(5);
  if(!rest.length){json(res,200,{id:project.id,description:'',name:project.path.split('/').at(-1),name_with_namespace:project.path.split('/').join(' / '),path:project.path.split('/').at(-1),path_with_namespace:project.path,created_at:'2026-01-01T00:00:00.000Z',default_branch:project.repo.defaultBranch,tag_list:[],topics:[],ssh_url_to_repo:`git@${host}:${project.path}.git`,http_url_to_repo:`https://${host}/${project.path}.git`,web_url:`https://${host}/${project.path}`,readme_url:null,forks_count:0,avatar_url:null,star_count:0,last_activity_at:'2026-11-01T00:00:00.000Z',namespace:{id:1,name:project.path.split('/')[0],path:project.path.split('/')[0],kind:'group',full_path:project.path.split('/').slice(0,-1).join('/')}});return;}
  if(rest[0]!=='repository'){json(res,404,{error:'404 Not Found'});return;}
  if(rest[1]==='commits'){
   const ref=decodeURIComponent(rest.slice(2).join('/')),snap=resolve(project.repo,ref);
   if(!snap){json(res,404,{message:'404 Commit Not Found'});return;}
   json(res,200,{id:snap.commit,short_id:snap.commit.slice(0,8),created_at:'2026-11-01T00:00:00.000+00:00',parent_ids:[],title:'Snapshot',message:'Snapshot\n',author_name:'Fake',author_email:'fake@example.org',web_url:`https://${host}/${project.path}/-/commit/${snap.commit}`});return;
  }
  const snap=resolve(project.repo,url.searchParams.get(rest[1]==='tree'?'ref':'sha')||'');
  if(!snap){json(res,404,{message:'404 Tree Not Found'});return;}
  const prefix=(url.searchParams.get('path')||'').replace(/\/$/,'');
  if(rest[1]==='tree'){
   const recursive=url.searchParams.get('recursive')==='true',perPage=Math.min(100,Number(url.searchParams.get('per_page')||20));
   let items=snap.entries.filter(entry=>prefix?entry.path.startsWith(prefix+'/'):true).filter(entry=>recursive||!entry.path.slice(prefix?prefix.length+1:0).includes('/'));
   if(prefix&&!snap.entries.some(entry=>entry.type==='tree'&&entry.path===prefix)){json(res,404,{message:'404 Tree Not Found'});return;}
   const token=url.searchParams.get('page_token');
   const start=token?items.findIndex(entry=>entry.path===JSON.parse(Buffer.from(token,'base64').toString()).file_name)+1:0;
   const page=items.slice(start,start+perPage),headers={};
   if(start+perPage<items.length){
    const link=new URL(`https://${host}/api/v4/projects/${encodeURIComponent(project.path)}/repository/tree`);
    for(const [key,value]of url.searchParams)if(key!=='page_token')link.searchParams.set(key,value);
    link.searchParams.set('id',project.path);link.searchParams.set('page',1);link.searchParams.set('page_token',Buffer.from(JSON.stringify({file_name:page.at(-1).path,tree_oid:page.at(-1).sha})).toString('base64'));
    headers.Link=`<${link.href}>; rel="next"`;
   }
   json(res,200,page.map(entry=>({id:entry.sha,name:entry.path.split('/').at(-1),type:entry.type,path:entry.path,mode:entry.mode})),headers);return;
  }
  if(rest[1]==='archive.zip'){
   if(project.archive){send(res,200,{...cors,'Content-Type':'application/zip','Content-Disposition':'attachment; filename="archive.zip"'},project.archive);return;}
   const root=`${project.path.split('/').at(-1)}-${snap.commit}-${snap.commit}${prefix?'-'+prefix.replaceAll('/','-'):''}/`;
   const files={[root]:[new Uint8Array(),{os:3,attrs:(0o40755<<16)>>>0}]};
   for(const entry of snap.entries){
    if(prefix&&!entry.path.startsWith(prefix+'/'))continue;
    if(entry.type==='tree'||entry.type==='commit'){files[root+entry.path+'/']=[new Uint8Array(),{os:3,attrs:(0o40755<<16)>>>0}];continue;}
    const blob=snap.blobs.get(entry.path);if(blob.exportIgnore)continue;
    files[root+entry.path]=[blob.content,{os:3,attrs:((blob.mode==='120000'?0o120777:blob.mode==='100755'?0o100755:0o100644)<<16)>>>0}];
   }
   send(res,200,{...cors,'Content-Type':'application/zip','Content-Disposition':`attachment; filename="${root.slice(0,-1)}.zip"`},zipSync(files));return;
  }
  json(res,404,{error:'404 Not Found'});
 });
 return {
  server,host,
  add(path,repo,{archive}={}){projects.set(path.toLowerCase(),{id:next++,path,repo,archive});return this;},
  start:()=>server.listen(),close:()=>server.close(),requests:()=>server.log,
 };
}

/** A plain file host: paths to bytes, with or without CORS. */
export function fakeFiles(){
 const files=new Map();
 const server=listen((req,res)=>{
  const file=files.get(new URL(req.url,'http://x').pathname);
  if(!file){send(res,404,{'Access-Control-Allow-Origin':'*','Content-Type':'text/plain'},'Not found');return;}
  send(res,200,{...(file.cors?{'Access-Control-Allow-Origin':'*'}:{}),'Content-Type':'application/zip'},file.bytes);
 });
 return {server,add(path,bytes,{cors=true}={}){files.set(path,{bytes,cors});return this;},start:()=>server.listen(),close:()=>server.close(),requests:()=>server.log};
}
