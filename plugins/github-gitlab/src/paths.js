// Paths between a repository and a project, and what is never synced (docs/git-sync.md).
// Everything from a remote tree is untrusted: a path is used only after it passes the
// project's own rules (the same as web/model.js validPath, crates/core valid_path) and is
// not Git or Scribyra private state. The host checks paths again when it applies changes.

const encoder=new TextEncoder();
/** Why a project path from a remote tree is refused, or '' when it is fine. */
export function pathProblem(path){
  if(typeof path!=='string'||!path||encoder.encode(path).length>240||/[\\:\0]/.test(path)||/\p{Cc}/u.test(path))return 'unsafe';
  // Bidirectional and zero-width characters can make a name look like another.
  if(/[\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/.test(path))return 'unsafe';
  const parts=path.split('/');
  if(parts.some(part=>!part||part==='.'||part==='..'))return 'unsafe';
  if(parts.some(part=>{const lower=part.toLowerCase();return lower==='.git'||lower==='.scribyra-sync'||lower.startsWith('.scribyra-sync-');}))return 'private';
  return '';
}
/** A subfolder of the repository as "a/b" ('' for the root), or null if it is not one. */
export function normalSubfolder(value){
  const path=String(value??'').trim().replace(/^\/+|\/+$/g,'');
  if(!path)return '';
  return pathProblem(path)?null:path;
}
/** The project path for a repository path, or null when it lies outside the subfolder. */
export function toProjectPath(subfolder,repoPath){
  if(!subfolder)return repoPath;
  return repoPath.startsWith(subfolder+'/')?repoPath.slice(subfolder.length+1):null;
}
export const toRepoPath=(subfolder,path)=>subfolder?`${subfolder}/${path}`:path;

// The project's text extensions (web/model.js isText): these become text files, the rest
// stay binary, byte for byte, as Open in Scribyra imports them.
export const isTextPath=path=>/\.(tex|bib|sty|cls|txt|md|csv|bst|cfg|def|json|yaml|yml|toml)$/i.test(path);
export function decodeText(bytes){try{return new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes);}catch{return null;}}
const LFS=/^version https:\/\/git-lfs\.github\.com\/spec\/v1\n/;
export const isLfsPointer=bytes=>bytes.length<1024&&LFS.test(new TextDecoder().decode(bytes.subarray(0,64)));

/**
 * A matcher for .scribyraignore lines (and the plugin's own exclusion setting), with
 * .gitignore's rules: `#` comments, `!` re-includes, a trailing `/` matches folders only,
 * a `/` elsewhere anchors to the project root, `*` and `?` stay within a name, `**`
 * crosses folders. A matching folder excludes everything in it. The last match wins.
 */
export function ignoreMatcher(lines){
  const rules=[];
  for(let raw of lines){
    raw=String(raw).replace(/\r$/,'');
    if(!raw.trim()||raw.startsWith('#'))continue;
    let pattern=raw.replace(/(?<!\\) +$/,''),negate=false;
    if(pattern.startsWith('!')){negate=true;pattern=pattern.slice(1);}
    else if(pattern.startsWith('\\!')||pattern.startsWith('\\#'))pattern=pattern.slice(1);
    const folder=pattern.endsWith('/');if(folder)pattern=pattern.replace(/\/+$/,'');
    if(!pattern)continue;
    const anchored=pattern.includes('/');pattern=pattern.replace(/^\//,'');
    let source='';
    for(let i=0;i<pattern.length;i++){
      const char=pattern[i];
      if(char==='*'&&pattern[i+1]==='*'){
        const before=i===0||pattern[i-1]==='/',after=pattern[i+2]==='/'||i+2===pattern.length;
        if(before&&pattern[i+2]==='/'){source+='(?:.*/)?';i+=2;continue;}
        if(before&&after){source+='.*';i++;continue;}
        source+='[^/]*';i++;continue;
      }
      if(char==='*')source+='[^/]*';
      else if(char==='?')source+='[^/]';
      else if(char==='\\'&&i+1<pattern.length)source+=pattern[++i].replace(/[.+^${}()|[\]\\*?]/g,'\\$&');
      else source+=char.replace(/[.+^${}()|[\]\\]/g,'\\$&');
    }
    rules.push({regex:new RegExp(`${anchored?'^':'(?:^|/)'}${source}$`),negate,folder});
  }
  return path=>{
    const parts=path.split('/'),candidates=parts.map((_,i)=>({path:parts.slice(0,i+1).join('/'),folder:i<parts.length-1}));
    // A path is excluded when it or a folder above it matches. Git cannot re-include a
    // file inside an excluded folder; neither does this.
    for(const candidate of candidates){
      let excluded=false;
      for(const rule of rules)if((!rule.folder||candidate.folder)&&rule.regex.test(candidate.path))excluded=!rule.negate;
      if(excluded)return true;
    }
    return false;
  };
}

// Never pushed without a decision: files that look like keys or credentials by name are
// left out unless the person ticks them; files whose content holds an access token or a
// private key are refused outright.
const SECRET_NAME=/(^|\/)(\.env(\.(?!example$|sample$|template$)[^/]+)?|id_(rsa|dsa|ecdsa|ed25519)(\.pub)?|[^/]*\.(pem|key|p12|pfx|jks|keystore|kdbx)|\.netrc|\.npmrc|\.pypirc|credentials(\.json)?|secrets?\.(json|ya?ml|toml))$/i;
const SECRET_CONTENT=[
  [/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36}\b/,'a GitHub access token'],
  [/\bgithub_pat_[A-Za-z0-9_]{22,}/,'a GitHub access token'],
  [/\bglpat-[A-Za-z0-9_-]{20,}/,'a GitLab access token'],
  [/-----BEGIN (?:[A-Z]+ )*PRIVATE KEY-----/,'a private key'],
  [/\bAKIA[0-9A-Z]{16}\b/,'an AWS access key'],
  [/\bxox[abposr]-[A-Za-z0-9-]{10,}/,'a Slack token'],
];
/** {block, reason} when a file must not be pushed as it is, else null. */
export function secretProblem(path,text){
  if(typeof text==='string'){
    for(const [pattern,what]of SECRET_CONTENT)if(pattern.test(text.length>4*1024*1024?text.slice(0,4*1024*1024):text))return {block:true,reason:`Contains what looks like ${what}; Scribyra will not push it. Remove the secret first.`};
  }
  if(SECRET_NAME.test(path))return {block:false,reason:'Its name looks like a key or credentials file, so it is left out unless you tick it.'};
  return null;
}

/** Git's branch-name rules (git check-ref-format), at most 200 characters. */
export function validBranch(name){
  return typeof name==='string'&&name.length>0&&name.length<=200&&!/[\x00-\x20~^:?*[\\\x7f]|\.\.|@\{|\/\/|^\/|\/$|^-|\.lock$|\.lock\/|(^|\/)\./.test(name)&&name!=='@'&&!name.endsWith('.');
}
