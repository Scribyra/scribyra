// "Open in Scribyra" links, format version 1 (docs/open-links.md).
//
//   https://app.scribyra.com/#open?repo=github.com/OWNER/REPO&ref=REF&path=DIR&main=FILE.tex&name=NAME
//   https://app.scribyra.com/#open?repo=gitlab.com/GROUP/SUBGROUP/PROJECT
//   https://app.scribyra.com/#open?repo=https://gitlab.example.org/GROUP/PROJECT
//   https://app.scribyra.com/#open?zip=https://example.org/paper.zip&main=paper.tex
//
// This module has no imports: the app bundles it and the presentation site serves it
// as is to the link generator (site/open.html). It only parses and formats; it never
// fetches anything. Everything in a link is untrusted input.
export const OPEN_LINK_VERSION=1;
export const DEFAULT_APP_URL='https://app.scribyra.com/';
export const OPEN_LINK_MAX_CHARS=4096;
const OPTIONS=['v','repo','zip','ref','path','main','name'];

export class OpenLinkError extends Error{constructor(message){super(message);this.name='OpenLinkError';}}
const fail=message=>{throw new OpenLinkError(message);};
const bytes=text=>new TextEncoder().encode(text).length;
// Control characters, and bidirectional overrides that could disguise a name or path.
const UNSAFE_TEXT=/[\u0000-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩]/;

// Hosts a link may name. Local and private-network names are refused, so a link can
// never point the browser at a device on the person's own network.
const PRIVATE_SUFFIX=/(?:^|\.)(?:localhost|local|internal|intranet|lan|home|corp|home\.arpa|localdomain|invalid)$/;
export function checkHost(host){
 const match=/^([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+)(?::(\d{1,5}))?$/.exec(host);
 if(!match||host.length>253)fail(`“${host}” is not a valid host name.`);
 const [,name,port]=match,labels=name.split('.');
 if(port!==undefined&&(Number(port)<1||Number(port)>65535||port.startsWith('0')))fail(`“${host}” has an invalid port.`);
 if(/^\d+$/.test(labels.at(-1))||!/[a-z]/.test(labels.at(-1)))fail('Links must name a host, not an IP address.');
 if(PRIVATE_SUFFIX.test(name))fail(`“${name}” is a local or private network name. Links can only open public hosts.`);
 return name+(port?`:${port}`:'');
}
/** A relative folder or file path inside a repository or archive: no traversal, no empty segments. */
export function cleanPath(value,what){
 const path=String(value).replace(/^\/+|\/+$/g,'');
 if(!path)return '';
 if(bytes(path)>240||UNSAFE_TEXT.test(path)||/[\\:*?"<>|]/.test(path))fail(`The ${what} “${path.slice(0,80)}” is not a safe relative path.`);
 for(const segment of path.split('/'))if(!segment||segment==='.'||segment==='..'||segment.trim()!==segment)fail(`The ${what} “${path.slice(0,80)}” is not a safe relative path.`);
 return path;
}
/** Git's own rules for branch and tag names (git check-ref-format), or a commit SHA. */
export function checkRef(ref){
 if(!ref)return '';
 if(ref.length>255||/[\u0000- \u007f~^:?*[\\]/.test(ref)||ref.includes('..')||ref.includes('@{')||ref==='@'||ref.includes('//')||/^[-/]|[/.]$|\.lock$|(^|\/)\./.test(ref)||ref.split('/').some(part=>part.endsWith('.lock')))fail(`“${ref.slice(0,80)}” is not a valid branch, tag or commit.`);
 return ref;
}
const GITHUB_OWNER=/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/,GITHUB_REPO=/^[A-Za-z0-9._-]{1,100}$/,GITLAB_SEGMENT=/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,254}$/;
/** `github.com/OWNER/REPO`, `gitlab.com/GROUP/…/PROJECT` or `https://HOST/GROUP/…/PROJECT` (self-hosted GitLab). */
export function parseRepo(value){
 let text=String(value).trim();
 if(/^[a-z][a-z0-9+.-]*:/i.test(text)){
  if(!/^https:\/\//i.test(text))fail('Repository addresses must use https://.');
  text=text.slice(8);
 }
 const slash=text.indexOf('/');if(slash<0)fail('Give the repository as host/owner/name, for example github.com/OWNER/REPO.');
 let host=text.slice(0,slash).toLowerCase(),path=text.slice(slash+1).replace(/\/+$/,'');
 if(host.includes('@'))fail('Repository addresses cannot contain a user name or password.');
 host=checkHost(host);if(host==='www.github.com')host='github.com';if(host==='www.gitlab.com')host='gitlab.com';
 if(/[?#%]/.test(path))fail('Give the repository without query, fragment or escaped characters; use ref= and path= for a branch or folder.');
 const segments=path.split('/');
 if(segments.at(-1)?.toLowerCase().endsWith('.git'))segments[segments.length-1]=segments.at(-1).slice(0,-4);
 if(host==='github.com'){
  if(segments.length!==2||!GITHUB_OWNER.test(segments[0])||!GITHUB_REPO.test(segments[1])||segments[1]==='.'||segments[1]==='..')fail('A GitHub repository is github.com/OWNER/REPO. Use ref= for a branch and path= for a folder.');
  return {kind:'github',host,repo:segments.join('/')};
 }
 // Every other host is treated as GitLab (gitlab.com or self-hosted).
 if(segments.length<2||segments.length>20||segments.some(part=>!GITLAB_SEGMENT.test(part)||part==='-'||/\.(?:git|atom)$/.test(part)))fail('A GitLab project is HOST/GROUP/…/PROJECT. Use ref= for a branch and path= for a folder.');
 return {kind:'gitlab',host,repo:segments.join('/')};
}
export function parseZipUrl(value){
 let url;try{url=new URL(String(value).trim());}catch{fail('The ZIP address is not a valid URL.');}
 if(url.protocol!=='https:')fail('ZIP addresses must use https://.');
 if(url.username||url.password)fail('ZIP addresses cannot contain a user name or password.');
 checkHost(url.host);url.hash='';
 if(url.href.length>2048)fail('The ZIP address is too long.');
 return url.href;
}
function checkName(value){
 const name=String(value).trim();
 if(!name)return '';
 if(name.length>160||UNSAFE_TEXT.test(name))fail('The project name must be at most 160 characters, without control characters.');
 return name;
}
/**
 * Parses `#open?…` (with or without the leading `#`). Returns a normalized link:
 * {version, kind: 'github'|'gitlab'|'zip', host, repo, url, ref, path, main, name}.
 * Throws OpenLinkError with a message meant for people.
 */
export function parseOpenLink(fragment){
 const text=String(fragment).replace(/^#/,'');
 if(text.length>OPEN_LINK_MAX_CHARS)fail(`This link is too long. Open links are at most ${OPEN_LINK_MAX_CHARS.toLocaleString('en')} characters.`);
 if(!/^open(?:\?|$)/.test(text))fail('This is not an Open in Scribyra link.');
 let params;try{params=new URLSearchParams(text.slice(5));}catch{fail('This link is damaged.');}
 const values=new Map();
 for(const [key,value]of params){
  if(!OPTIONS.includes(key))fail(`This link has an option Scribyra does not know (“${key.slice(0,40)}”). It may need a newer version of Scribyra.`);
  if(values.has(key))fail(`This link gives “${key}” twice.`);
  values.set(key,value);
 }
 if(values.has('v')&&values.get('v')!==String(OPEN_LINK_VERSION))fail('This link needs a newer version of Scribyra. Reload the app to update it.');
 const repo=values.get('repo')?.trim(),zip=values.get('zip')?.trim();
 if(!repo===!zip)fail('An open link names either a repository (repo=) or a ZIP file (zip=).');
 const link={version:OPEN_LINK_VERSION,...(repo?{...parseRepo(repo),url:''}:{kind:'zip',host:new URL(parseZipUrl(zip)).host,repo:'',url:parseZipUrl(zip)}),ref:'',path:'',main:'',name:''};
 if(zip&&values.get('ref'))fail('ref= applies to repositories, not ZIP files.');
 link.ref=checkRef(values.get('ref')?.trim()||'');
 link.path=cleanPath(values.get('path')||'','folder');
 link.main=cleanPath(values.get('main')||'','main file');
 if(link.main&&!/\.tex$/i.test(link.main))fail('The main file must be a .tex file.');
 link.name=checkName(values.get('name')||'');
 return link;
}
// Keep / and : readable; encode everything that would end or split a parameter.
const encode=value=>encodeURIComponent(value).replace(/%2F/g,'/').replace(/%3A/g,':').replace(/%40/g,'@');
export function repoAddress(link){return link.kind==='github'||link.host==='gitlab.com'?`${link.host}/${link.repo}`:`https://${link.host}/${link.repo}`;}
/** The canonical link for a parsed or hand-made description. Validates by parsing its own output. */
export function formatOpenLink(input,app=DEFAULT_APP_URL){
 const parts=[];
 if(input.kind==='zip')parts.push(['zip',input.url]);else parts.push(['repo',repoAddress(input)]);
 for(const key of ['ref','path','main','name'])if(input[key])parts.push([key,input[key]]);
 const base=new URL(app);base.hash='';
 const link=`${base.href}#open?${parts.map(([key,value])=>`${key}=${encode(value)}`).join('&')}`;
 parseOpenLink(new URL(link).hash);
 return link;
}
/** Where a person can look at the source: the repository page at that ref and folder, or the ZIP address. */
export function sourcePage(link){
 if(link.kind==='zip')return link.url;
 const base=`https://${link.host}/${link.repo}`,tail=link.path?`/${link.path.split('/').map(encodeURIComponent).join('/')}`:'';
 if(!link.ref&&!link.path)return base;
 const ref=link.ref?link.ref.split('/').map(encodeURIComponent).join('/'):'HEAD';
 return link.kind==='github'?`${base}/tree/${ref}${tail}`:`${base}/-/tree/${ref}${tail}`;
}
/** Identity of what a link imports, for "Open existing copy". Hosts and repository names are case-insensitive. */
export function sourceKey(link){
 return JSON.stringify([link.kind,link.host.toLowerCase(),link.repo.toLowerCase(),link.url,link.ref,link.path]);
}
export function defaultProjectName(link){
 if(link.name)return link.name;
 if(link.kind==='zip'){const last=new URL(link.url).pathname.split('/').filter(Boolean).at(-1)||'Imported ZIP';let name=last;try{name=decodeURIComponent(last);}catch{}return checkSafeName(name.replace(/\.zip$/i,''))||'Imported ZIP';}
 const name=link.repo.split('/').at(-1);
 return link.path?`${name} · ${link.path.split('/').at(-1)}`:name;
}
const checkSafeName=name=>{try{return checkName(name);}catch{return '';}};

/**
 * Reads what a person pastes into the generator: a repository page (including /tree/REF/DIR
 * or /blob/REF/FILE.tex), a clone address, host/owner/repo, an existing open link, or a
 * .zip address. Returns a partial description; fields it cannot know stay empty.
 */
export function parseRepositoryInput(value){
 const text=String(value).trim();
 if(!text)fail('Paste a GitHub or GitLab repository address, or the address of a ZIP file.');
 const hash=text.indexOf('#open');
 if(hash>=0)return parseOpenLink(text.slice(hash));
 const ssh=/^git@([^:]+):(.+)$/.exec(text);
 if(ssh)return {...parseRepo(`${ssh[1]}/${ssh[2]}`),url:'',ref:'',path:'',main:''};
 let url;try{url=new URL(/^[a-z][a-z0-9+.-]*:/i.test(text)?text:`https://${text}`);}catch{fail('That address is not valid.');}
 if(url.protocol==='http:')fail('Use an https:// address.');
 if(url.protocol!=='https:')fail('That address is not a web address.');
 if(/\.zip$/i.test(url.pathname)&&!/\/(?:-\/)?archive\//.test(url.pathname))return {kind:'zip',host:checkHost(url.host),repo:'',url:parseZipUrl(url.href),ref:'',path:'',main:''};
 let segments=url.pathname.split('/').filter(Boolean).map(part=>{try{return decodeURIComponent(part);}catch{return part;}});
 let ref='',path='',main='',rest=null;
 const host=url.host.toLowerCase().replace(/^www\./,'');
 if(host==='github.com'){
  if(segments.length>=4&&['tree','blob'].includes(segments[2])){rest=segments.slice(3);const kind=segments[2];segments=segments.slice(0,2);ref=rest.shift();if(kind==='blob'){const file=rest.join('/');if(/\.tex$/i.test(file)){main=file.split('/').at(-1);path=rest.slice(0,-1).join('/');}else path=rest.slice(0,-1).join('/');}else path=rest.join('/');}
  else segments=segments.slice(0,2);
 }else{
  const dash=segments.indexOf('-');
  if(dash>0){rest=segments.slice(dash+1);segments=segments.slice(0,dash);if(['tree','blob'].includes(rest[0])&&rest.length>1){const kind=rest.shift();ref=rest.shift();if(kind==='blob'){const file=rest.join('/');if(/\.tex$/i.test(file))main=file.split('/').at(-1);path=rest.slice(0,-1).join('/');}else path=rest.join('/');}}
 }
 const repo=parseRepo(`https://${host}/${segments.join('/')}`);
 return {...repo,url:'',ref:checkRef(ref),path:cleanPath(path,'folder'),main:main?cleanPath(main,'main file'):''};
}
