// Network side of "Open in Scribyra" links. Called only after the person chose
// "Check repository" in the confirmation dialog. Requests go straight from the browser
// to the host's public, CORS-enabled endpoints: no cookies, no referrer, no tokens.
//
// GitHub: api.github.com (2 requests: commit SHA, recursive tree) + raw.githubusercontent.com
//   per file. codeload.github.com (the zipball) only allows render.githubusercontent.com
//   as a CORS origin, so browsers cannot use it.
// GitLab: /api/v4 project, commit, tree pages and repository/archive.zip, all CORS-enabled.
// ZIP: one GET of the given https URL, which must send Access-Control-Allow-Origin.
import {planImport,readZipDirectory,zipEntries,extractZipEntry,isLfsPointer,lfsMatcher,ImportRefused,IMPORT_LIMITS} from './open-link.js';

export class FetchProblem extends Error{constructor(message,{retryAt=null,code='failed'}={}){super(message);this.name='FetchProblem';this.retryAt=retryAt;this.code=code;}}
const segments=path=>path.split('/').map(encodeURIComponent).join('/');
const when=ms=>new Date(ms).toLocaleTimeString(undefined,{hour:'2-digit',minute:'2-digit'});
const minutes=ms=>Math.max(1,Math.ceil((ms-Date.now())/60000));

async function get(url,{signal,accept,host}){
 try{return await fetch(url,{signal,credentials:'omit',referrerPolicy:'no-referrer',mode:'cors',headers:accept?{Accept:accept}:{}});}
 catch(error){
  if(signal?.aborted)throw error;
  throw new FetchProblem(`Scribyra could not reach ${host}. Check your connection. If it keeps failing, ${host} may be limiting requests or may not allow other sites to download from it.`,{code:'network'});
 }
}
/** Reads a body, refusing it as soon as it passes `limit` bytes. */
async function body(response,limit,what){
 const declared=Number(response.headers.get('content-length'));
 if(Number.isFinite(declared)&&declared>limit)throw new ImportRefused(`${what} is larger than ${Math.round(limit/1024/1024)} MiB.`);
 const reader=response.body.getReader(),chunks=[];let size=0;
 try{for(;;){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>limit)throw new ImportRefused(`${what} is larger than ${Math.round(limit/1024/1024)} MiB.`);chunks.push(value);}}
 finally{reader.releaseLock?.();}
 const bytes=new Uint8Array(size);let at=0;for(const chunk of chunks){bytes.set(chunk,at);at+=chunk.length;}
 return bytes;
}
async function json(response,limit=32*1024*1024){
 try{return JSON.parse(new TextDecoder().decode(await body(response,limit,'The reply')));}
 catch(error){if(error instanceof ImportRefused)throw error;throw new FetchProblem('The host sent a reply Scribyra could not read.');}
}

// GitHub ------------------------------------------------------------------------------
const GITHUB_API='https://api.github.com',GITHUB_RAW='https://raw.githubusercontent.com';
function githubLimit(response){
 const remaining=response.headers.get('x-ratelimit-remaining'),reset=Number(response.headers.get('x-ratelimit-reset')),retry=Number(response.headers.get('retry-after'));
 if((response.status===403||response.status===429)&&(remaining==='0'||retry>0)){
  const at=retry>0?Date.now()+retry*1000:reset*1000;
  const limit=response.headers.get('x-ratelimit-limit')||'60';
  return new FetchProblem(`GitHub allows ${limit} requests an hour from your network without signing in, and they are used up. Try again after ${when(at)} (in about ${minutes(at)} ${minutes(at)===1?'minute':'minutes'}). Nothing was imported.`,{retryAt:at,code:'rate_limited'});
 }
 return null;
}
function githubRate(response){const remaining=Number(response.headers.get('x-ratelimit-remaining')),limit=Number(response.headers.get('x-ratelimit-limit')),reset=Number(response.headers.get('x-ratelimit-reset'));return Number.isFinite(remaining)&&response.headers.has('x-ratelimit-remaining')?{remaining,limit,reset:reset*1000}:null;}
async function githubCheck(link,{signal}){
 const api=`${GITHUB_API}/repos/${link.repo}`,host='api.github.com';
 const commitResponse=await get(`${api}/commits/${link.ref?segments(link.ref):'HEAD'}`,{signal,accept:'application/vnd.github.sha',host});
 const limited=githubLimit(commitResponse);if(limited)throw limited;
 if(commitResponse.status===404)throw new FetchProblem(`GitHub has no public repository ${link.repo}${link.ref?` with “${link.ref}”`:''}. It may be private: Scribyra opens public repositories only (private ones will come with the Git plugins).`,{code:'not_found'});
 if(commitResponse.status===422)throw new FetchProblem(`GitHub has no branch, tag or commit “${link.ref}” in ${link.repo}.`,{code:'not_found'});
 if(commitResponse.status===409)throw new FetchProblem(`The repository ${link.repo} is empty.`,{code:'not_found'});
 if(!commitResponse.ok)throw new FetchProblem(`GitHub refused the request (HTTP ${commitResponse.status}). Try again later.`);
 const commit=new TextDecoder().decode(await body(commitResponse,1024,'The reply')).trim();
 if(!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(commit))throw new FetchProblem('GitHub sent a commit Scribyra could not read.');
 const treeResponse=await get(`${api}/git/trees/${commit}?recursive=1`,{signal,accept:'application/vnd.github+json',host});
 const treeLimited=githubLimit(treeResponse);if(treeLimited)throw treeLimited;
 if(!treeResponse.ok)throw new FetchProblem(`GitHub refused the file list (HTTP ${treeResponse.status}). Try again later.`);
 const tree=await json(treeResponse);
 if(!Array.isArray(tree?.tree))throw new FetchProblem('GitHub sent a file list Scribyra could not read.');
 if(tree.truncated)throw new ImportRefused('This repository is too large for GitHub to list in one reply. Link to a smaller repository.');
 if(tree.tree.length>IMPORT_LIMITS.listedEntries)throw new ImportRefused(`This repository lists more than ${IMPORT_LIMITS.listedEntries.toLocaleString('en')} entries. Link to the folder that holds the document with path=.`);
 const prefix=link.path?link.path+'/':'';
 if(link.path&&!tree.tree.some(item=>item.type==='tree'&&item.path===link.path))throw new FetchProblem(`The folder “${link.path}” does not exist in ${link.repo} at ${link.ref||'the default branch'}.`,{code:'not_found'});
 // Git LFS: the raw endpoint serves pointers, not content. The root .gitattributes tells
 // which files are pointers before anything is downloaded; downloads are checked again.
 let lfs=()=>false;
 const attributes=tree.tree.find(item=>item?.path==='.gitattributes'&&item.type==='blob'&&item.size<=64*1024);
 if(attributes){
  const response=await get(`${GITHUB_RAW}/${link.repo}/${commit}/.gitattributes`,{signal,host:'raw.githubusercontent.com'});
  if(response.ok)lfs=lfsMatcher(new TextDecoder().decode(await body(response,64*1024,'.gitattributes')));
 }
 const entries=[];
 for(const item of tree.tree){
  if(typeof item?.path!=='string'||!item.path.startsWith(prefix)||item.type==='tree')continue;
  const path=item.path.slice(prefix.length);
  if(item.type==='commit')entries.push({path,size:0,kind:'submodule'});
  else if(item.mode==='120000')entries.push({path,size:0,kind:'symlink'});
  else if(item.type==='blob'&&item.size<1024&&lfs(item.path))entries.push({path,size:item.size,kind:'lfs'});
  else if(item.type==='blob')entries.push({path,size:item.size,kind:'file',source:item.path});
 }
 return {commit,plan:planImport(entries),rate:githubRate(treeResponse)};
}
async function githubFile(link,commit,file,{signal}){
 const response=await get(`${GITHUB_RAW}/${link.repo}/${commit}/${segments(file.source)}`,{signal,host:'raw.githubusercontent.com'});
 if(response.status===429){const retry=Number(response.headers.get('retry-after'));const at=Date.now()+(retry>0?retry:60)*1000;throw new FetchProblem(`raw.githubusercontent.com is limiting downloads from your network. Try again after ${when(at)}. Nothing was imported.`,{retryAt:at,code:'rate_limited'});}
 if(!response.ok)throw new FetchProblem(`GitHub could not send “${file.path}” (HTTP ${response.status}). Nothing was imported.`);
 const bytes=await body(response,file.size,`“${file.path}”`);
 if(bytes.length!==file.size)throw new FetchProblem(`“${file.path}” arrived with a different size than GitHub listed. Nothing was imported; try again.`);
 return bytes;
}

// GitLab ------------------------------------------------------------------------------
function gitlabProblem(response,host,what){
 if(response.status===429)return new FetchProblem(`${host} is limiting requests from your network. Try again in a minute or two. Nothing was imported.`,{retryAt:Date.now()+60000,code:'rate_limited'});
 if(response.status===404||response.status===401||response.status===403)return new FetchProblem(`${host} has no public ${what}. It may be private: Scribyra opens public repositories only (private ones will come with the Git plugins).`,{code:'not_found'});
 return new FetchProblem(`${host} refused the request (HTTP ${response.status}). Try again later.`);
}
async function gitlabCheck(link,{signal}){
 const host=link.host,api=`https://${host}/api/v4/projects/${encodeURIComponent(link.repo)}`;
 const projectResponse=await get(api,{signal,host});
 if(!projectResponse.ok)throw gitlabProblem(projectResponse,host,`project ${link.repo}`);
 const project=await json(projectResponse,1024*1024);
 const ref=link.ref||project?.default_branch;
 if(!ref)throw new FetchProblem(`The project ${link.repo} is empty.`,{code:'not_found'});
 const commitResponse=await get(`${api}/repository/commits/${encodeURIComponent(ref)}`,{signal,host});
 if(!commitResponse.ok)throw commitResponse.status===404?new FetchProblem(`${host} has no branch, tag or commit “${ref}” in ${link.repo}.`,{code:'not_found'}):gitlabProblem(commitResponse,host,`project ${link.repo}`);
 const commit=(await json(commitResponse,1024*1024))?.id;
 if(typeof commit!=='string'||!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(commit))throw new FetchProblem(`${host} sent a commit Scribyra could not read.`);
 // The tree tells symbolic links and submodules apart; the archive carries the content.
 const listed=new Map();
 let next=`${api}/repository/tree?recursive=true&per_page=100&pagination=keyset&ref=${commit}${link.path?`&path=${encodeURIComponent(link.path)}`:''}`;
 for(let page=0;next;page++){
  if(page>=Math.ceil(4096/100))throw new ImportRefused('This folder has more than 4,096 files and folders. Link to the folder that holds the document with path=.');
  const response=await get(next,{signal,host});
  if(response.status===404&&link.path)throw new FetchProblem(`The folder “${link.path}” does not exist in ${link.repo} at ${link.ref||'the default branch'}.`,{code:'not_found'});
  if(!response.ok)throw gitlabProblem(response,host,`project ${link.repo}`);
  const items=await json(response,8*1024*1024);
  if(!Array.isArray(items))throw new FetchProblem(`${host} sent a file list Scribyra could not read.`);
  for(const item of items)if(typeof item?.path==='string')listed.set(item.path,item);
  next=null;
  const header=response.headers.get('link')||'',match=/<([^>]+)>;\s*rel="next"/.exec(header);
  if(match){const url=new URL(match[1]);if(url.origin!==new URL(api).origin)throw new FetchProblem(`${host} pointed the file list somewhere else. Nothing was imported.`);next=url.href;}
 }
 if(link.path&&!listed.size)throw new FetchProblem(`The folder “${link.path}” does not exist in ${link.repo} at ${link.ref||'the default branch'}.`,{code:'not_found'});
 const archiveResponse=await get(`${api}/repository/archive.zip?sha=${commit}${link.path?`&path=${encodeURIComponent(link.path)}`:''}`,{signal,host});
 if(!archiveResponse.ok)throw gitlabProblem(archiveResponse,host,`archive of ${link.repo}`);
 const archive=await body(archiveResponse,IMPORT_LIMITS.archiveBytes,'The repository archive');
 const directory=readZipDirectory(archive),inArchive=new Map(zipEntries(directory,link.path).map(entry=>[entry.path,entry]));
 const prefix=link.path?link.path+'/':'',entries=[];
 for(const [full,item]of listed){
  if(!full.startsWith(prefix)||item.type==='tree')continue;
  const path=full.slice(prefix.length);
  if(item.type==='commit'){entries.push({path,size:0,kind:'submodule'});continue;}
  if(item.mode==='120000'){entries.push({path,size:0,kind:'symlink'});continue;}
  const found=inArchive.get(path);
  if(!found){entries.push({path,size:0,kind:'exportIgnore'});continue;}
  entries.push(found.kind==='file'?{...found,kind:'file'}:found);
 }
 // Archive entries the tree does not list are refused: they cannot come from the commit.
 for(const [path,entry]of inArchive)if(!listed.has(prefix+path)&&entry.kind==='file')entries.push({path,size:0,kind:'unsafe'});
 return {commit,plan:planImport(markPointers(archive,entries)),archive};
}

/** Archives carry content: small entries that are LFS pointers are reported before import. */
function markPointers(archive,entries){
 return entries.map(entry=>entry.kind==='file'&&entry.size<1024&&isLfsPointer(extractZipEntry(archive,entry.zip))?{path:entry.path,size:entry.size,kind:'lfs'}:entry);
}

// ZIP ---------------------------------------------------------------------------------
async function zipCheck(link,{signal}){
 const response=await get(link.url,{signal,host:link.host});
 if(!response.ok)throw new FetchProblem(`${link.host} could not send the ZIP file (HTTP ${response.status}).`,{code:response.status===404?'not_found':'failed'});
 const archive=await body(response,IMPORT_LIMITS.archiveBytes,'The ZIP file');
 const directory=readZipDirectory(archive),entries=zipEntries(directory,link.path);
 if(link.path&&!entries.length)throw new FetchProblem(`The folder “${link.path}” is not in the ZIP file.`,{code:'not_found'});
 const digest=new Uint8Array(await crypto.subtle.digest('SHA-256',archive));
 return {commit:'',archiveSha256:Array.from(digest,b=>b.toString(16).padStart(2,'0')).join(''),plan:planImport(markPointers(archive,entries)),archive};
}

/** Looks the source up: commit, file list, sizes and what will be skipped. Downloads archives (GitLab, ZIP). */
export function checkSource(link,options){
 return link.kind==='github'?githubCheck(link,options):link.kind==='gitlab'?gitlabCheck(link,options):zipCheck(link,options);
}
/** Downloads (GitHub) or extracts (archives) the planned files. Returns [{path, bytes}]. */
export async function downloadFiles(link,checked,{signal,progress=()=>{}}){
 const files=checked.plan.files,result=new Array(files.length);let done=0;
 if(checked.archive){
  for(const [i,file]of files.entries()){signal?.throwIfAborted();result[i]={path:file.path,bytes:extractZipEntry(checked.archive,file.zip)};progress(++done,files.length);}
  return result;
 }
 let next=0;
 const worker=async()=>{while(next<files.length){const i=next++;signal?.throwIfAborted();result[i]={path:files[i].path,bytes:await githubFile(link,checked.commit,files[i],{signal})};progress(++done,files.length);}};
 await Promise.all(Array.from({length:Math.min(6,files.length)},worker));
 return result;
}
