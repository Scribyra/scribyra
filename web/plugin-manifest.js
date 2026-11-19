// Plugin manifests, packages, permissions and the organisation policy (docs/plugins.md).
// Pure: no DOM, storage or network, so Node tests exercise every rule. Anything a
// manifest can ask for is listed here; unknown fields and permissions are errors, so a
// package can never hold authority the consent dialog did not show.
export const MANIFEST_VERSION=1,PLUGIN_API=1,PACKAGE_FORMAT='scribyra-plugin',PACKAGE_FORMAT_VERSION=1;
export const MAX_PACKAGE_BYTES=4*1024*1024;
export const OFFICIAL_PREFIX='com.scribyra.';
export const MODES=['editing','reviewing','viewing'];
export const ICONS=['link','restore','book','download','upload','open','file-plus','check','eye','copy'];
export const PERMISSIONS=['project.read','project.write','network','secrets','ui.dialog','ui.command','ui.fileAction','completion','bibliography'];
const RESERVED={'ui.panel':'“ui.panel” (a sandboxed iframe panel) is reserved and not available in plugin API 1. Use “ui.dialog”.'};

export class PluginError extends Error{constructor(code,message){super(message);this.name='PluginError';this.code=code;}}
const fail=(message,code='invalid_manifest')=>{throw new PluginError(code,message);};
const isObject=value=>!!value&&typeof value==='object'&&!Array.isArray(value);
function only(object,allowed,where){for(const key of Object.keys(object))if(!allowed.includes(key))fail(`${where} has an unknown field “${key}”.`);}
// Control, bidirectional and zero-width characters can disguise what a label says.
const HIDDEN=/[\u0000-\u001f\u007f\u00ad\u061c\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/;
function text(value,where,max,{optional=false,min=1}={}){
  if(value===undefined&&optional)return undefined;
  if(typeof value!=='string'||value.trim().length<min||value.length>max||HIDDEN.test(value))fail(`${where} must be text of at most ${max} characters.`);
  return value.trim();
}
// Plugin labels may not pass for Scribyra's own menu items.
const BUILT_IN=new Set(['project settings','tex environment','diagnostics','share project','plugins','mcp providers','rust companion and mcp','report a problem','privacy','licences','source code on github','new file','new folder','upload files','import folder','import bibliography…','import bibliography','rename','move','duplicate','delete','restore last deletion','export','history']);
const label=(value,where)=>{const result=text(value,where,60);if(BUILT_IN.has(result.toLowerCase()))fail(`${where} “${result}” is the name of a Scribyra item.`);return result;};
const ID=/^[a-z][a-z0-9-]{0,30}(\.[a-z][a-z0-9-]{0,30})+$/;
export const validPluginId=id=>typeof id==='string'&&id.length<=64&&ID.test(id);
const SEMVER=/^(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;
export function parseVersion(version){
  const match=typeof version==='string'&&version.length<=64?version.match(SEMVER):null;
  if(!match)return null;
  return {major:+match[1],minor:+match[2],patch:+match[3],pre:match[4]?match[4].split('.'):[]};
}
/** Semantic-version order: negative when a < b. Pre-releases sort before their release. */
export function compareVersions(a,b){
  const x=parseVersion(a),y=parseVersion(b);if(!x||!y)throw new PluginError('invalid_version','Not a semantic version.');
  for(const key of ['major','minor','patch'])if(x[key]!==y[key])return x[key]-y[key];
  if(!x.pre.length||!y.pre.length)return y.pre.length-x.pre.length;
  for(let i=0;i<Math.max(x.pre.length,y.pre.length);i++){
    const p=x.pre[i],q=y.pre[i];if(p===undefined)return -1;if(q===undefined)return 1;
    const pn=/^\d+$/.test(p),qn=/^\d+$/.test(q);
    if(pn&&qn&&+p!==+q)return +p-+q;if(pn!==qn)return pn?-1:1;if(p!==q)return p<q?-1:1;
  }
  return 0;
}
/** `*`, an exact version, `^1.2.3` (same major, or same minor below 1.0) or `~1.2.3` (same minor). */
export function versionInRange(version,range){
  if(range===undefined||range==='*')return true;
  if(typeof range!=='string')return false;
  const head=range[0],base=head==='^'||head==='~'?range.slice(1):range,b=parseVersion(base),v=parseVersion(version);
  if(!b||!v)return false;
  if(head!=='^'&&head!=='~')return compareVersions(version,base)===0;
  if(compareVersions(version,base)<0)return false;
  if(head==='~'||b.major===0)return v.major===b.major&&v.minor===b.minor;
  return v.major===b.major;
}

/** File globs: `*` stays within a folder, `**` crosses folders, `?` is one character.
 * A glob without “/” matches the file name in any folder, as .gitignore does. */
export function globMatch(glob,path){
  if(typeof glob!=='string'||typeof path!=='string')return false;
  const subject=glob.includes('/')?path:path.slice(path.lastIndexOf('/')+1);
  let pattern='';
  for(let i=0;i<glob.length;i++){
    const char=glob[i];
    if(char==='*'&&glob[i+1]==='*'){i++;if(glob[i+1]==='/'){pattern+='(?:.*/)?';i++;}else pattern+='.*';}
    else if(char==='*')pattern+='[^/]*';
    else if(char==='?')pattern+='[^/]';
    else pattern+=char.replace(/[.+^${}()|[\]\\]/g,'\\$&');
  }
  return new RegExp(`^${pattern}$`,'i').test(subject);
}
export const matchesAny=(globs,path)=>Array.isArray(globs)&&globs.some(glob=>globMatch(glob,path));
function globs(value,where){
  if(!Array.isArray(value)||value.length>32)fail(`${where} must be a list of at most 32 file patterns.`);
  for(const glob of value)if(typeof glob!=='string'||!glob||glob.length>128||/[\u0000-\u001f\\]|^\/|(^|\/)\.\.(\/|$)/.test(glob))fail(`${where} has an invalid file pattern.`);
  return [...new Set(value)].sort();
}
const LOOPBACK=/^http:\/\/(127\.0\.0\.1|localhost)(:\d{1,5})?$/;
/** A network origin as `https://host[:port]`; loopback http only for developer packages. */
export function normalOrigin(value,{developer=false}={}){
  let url;try{url=new URL(value);}catch{fail(`“${value}” is not a network origin.`);}
  if(typeof value!=='string'||url.origin!==value.replace(/\/$/,'')||url.username||url.password||url.search||url.hash||(url.pathname!=='/'&&url.pathname!==''))fail(`Network permissions name exact origins like https://api.example.org, not “${value}”.`);
  if(url.protocol==='https:'&&!url.hostname.includes('*'))return url.origin;
  if(developer&&LOOPBACK.test(url.origin))return url.origin;
  fail(`Network permissions need https:// origins; “${value}” is not one.`);
}

/** Normalises a permissions object; `developer` packages may name a loopback origin. */
export function normalPermissions(value,{developer=false}={}){
  if(!isObject(value))fail('“permissions” must be an object.');
  const result={};
  for(const [key,grant]of Object.entries(value)){
    if(RESERVED[key])fail(RESERVED[key]);
    if(!PERMISSIONS.includes(key))fail(`Unknown permission “${key}”.`);
    switch(key){
      case 'project.read':if(!isObject(grant))fail('“project.read” needs {"files": [patterns]}.');only(grant,['files'],'“project.read”');result[key]={files:globs(grant.files,'“project.read.files”')};break;
      case 'project.write':{
        if(!isObject(grant))fail('“project.write” needs {"create": [patterns], "pick": true|false}.');only(grant,['create','pick'],'“project.write”');
        const create=grant.create===undefined?[]:globs(grant.create,'“project.write.create”');
        if(grant.pick!==undefined&&typeof grant.pick!=='boolean')fail('“project.write.pick” must be true or false.');
        if(!create.length&&!grant.pick)fail('“project.write” must allow creating files or picking them.');
        result[key]={create,pick:!!grant.pick};break;
      }
      case 'network':{
        if(!Array.isArray(grant)||!grant.length||grant.length>8)fail('“network” must list one to eight origins.');
        result[key]=[...new Set(grant.map(origin=>normalOrigin(origin,{developer})))].sort();break;
      }
      default:if(grant!==true)fail(`“${key}” must be true.`);result[key]=true;
    }
  }
  if(result['project.write']&&!result['project.read'])fail('“project.write” also needs “project.read”.');
  return Object.fromEntries(Object.keys(result).sort().map(key=>[key,result[key]]));
}

function contributions(value,permissions){
  if(value===undefined)return {commands:[],fileActions:[]};
  if(!isObject(value))fail('“contributes” must be an object.');only(value,['commands','fileActions'],'“contributes”');
  const ids=new Set(),id=(item,where)=>{if(typeof item.id!=='string'||!/^[a-z][a-z0-9-]{0,31}$/.test(item.id)||ids.has(item.id))fail(`${where} needs a unique id of lowercase letters, digits and hyphens.`);ids.add(item.id);return item.id;};
  const modes=(list,where)=>{if(list===undefined)return [...MODES];if(!Array.isArray(list)||!list.length||list.some(mode=>!MODES.includes(mode)))fail(`${where} “modes” lists editing, reviewing or viewing.`);return MODES.filter(mode=>list.includes(mode));};
  const commands=(value.commands||[]).map((item,i)=>{
    const where=`Command ${i+1}`;if(!isObject(item))fail(`${where} must be an object.`);only(item,['id','label','hint'],where);
    return {id:id(item,where),label:label(item.label,`${where} label`),...(item.hint!==undefined?{hint:text(item.hint,`${where} hint`,80)}:{})};
  });
  if(!Array.isArray(value.commands||[])||commands.length>8)fail('At most eight commands.');
  if(commands.length&&!permissions['ui.command'])fail('Commands need the “ui.command” permission.');
  if(!Array.isArray(value.fileActions||[])||(value.fileActions||[]).length>12)fail('At most twelve file actions.');
  const fileActions=(value.fileActions||[]).map((item,i)=>{
    const where=`File action ${i+1}`;if(!isObject(item))fail(`${where} must be an object.`);only(item,['id','label','hint','icon','when','modes'],where);
    if(!isObject(item.when))fail(`${where} needs “when”.`);only(item.when,['target','files','tag'],`${where} “when”`);
    if(!['root','folder','file'].includes(item.when.target))fail(`${where} “when.target” is root, folder or file.`);
    if(item.icon!==undefined&&!ICONS.includes(item.icon))fail(`${where} icon must be one of ${ICONS.join(', ')}.`);
    if(item.when.tag!==undefined&&(typeof item.when.tag!=='string'||!/^[a-z][a-z0-9-]{0,31}$/.test(item.when.tag)))fail(`${where} “when.tag” must be a short lowercase tag.`);
    const when={target:item.when.target,...(item.when.files!==undefined?{files:globs(item.when.files,`${where} “when.files”`)}:{}),...(item.when.tag!==undefined?{tag:item.when.tag}:{})};
    return {id:id(item,where),label:label(item.label,`${where} label`),...(item.hint!==undefined?{hint:text(item.hint,`${where} hint`,80)}:{}),...(item.icon?{icon:item.icon}:{}),when,modes:modes(item.modes,where)};
  });
  if(fileActions.length&&!permissions['ui.fileAction'])fail('File actions need the “ui.fileAction” permission.');
  return {commands,fileActions};
}

/** A validated, normalised manifest, or a PluginError explaining what is wrong. */
export function validateManifest(manifest,{developer=false}={}){
  if(!isObject(manifest))fail('The manifest must be a JSON object.');
  if(manifest.manifestVersion!==MANIFEST_VERSION)fail(Number.isInteger(manifest.manifestVersion)&&manifest.manifestVersion>MANIFEST_VERSION?'This plugin needs a newer version of Scribyra.':'Unsupported “manifestVersion”; this Scribyra reads version 1.','unsupported_version');
  only(manifest,['manifestVersion','id','name','version','publisher','description','homepage','api','main','permissions','contributes'],'The manifest');
  if(!validPluginId(manifest.id))fail('“id” must be reverse-DNS, such as org.example.my-plugin (lowercase, at most 64 characters).');
  if(!parseVersion(manifest.version))fail('“version” must be a semantic version such as 1.0.0.');
  if(manifest.api!==PLUGIN_API)fail(Number.isInteger(manifest.api)&&manifest.api>PLUGIN_API?'This plugin needs a newer plugin API than this Scribyra offers.':'“api” must be 1.','unsupported_version');
  if(typeof manifest.main!=='string'||!/^[A-Za-z0-9._-]{1,64}\.js$/.test(manifest.main))fail('“main” must name a .js file in the package.');
  let homepage;
  if(manifest.homepage!==undefined){let url;try{url=new URL(manifest.homepage);}catch{}if(!url||url.protocol!=='https:'||manifest.homepage.length>200)fail('“homepage” must be an https:// address.');homepage=url.href;}
  const permissions=normalPermissions(manifest.permissions??{},{developer});
  if(!manifest.id.startsWith(OFFICIAL_PREFIX)&&/scribyra/i.test(`${manifest.name} ${manifest.publisher}`))fail('Only official plugins may use “Scribyra” in their name or publisher.');
  return {
    manifestVersion:MANIFEST_VERSION,id:manifest.id,name:text(manifest.name,'“name”',40),version:manifest.version,
    publisher:text(manifest.publisher,'“publisher”',60),description:text(manifest.description,'“description”',300,{optional:true})??'',
    ...(homepage?{homepage}:{}),api:PLUGIN_API,main:manifest.main,permissions,contributes:contributions(manifest.contributes,permissions),
  };
}

const FILE_NAME=/^(?!(?:__proto__|constructor|prototype)$)[A-Za-z0-9._-]{1,64}$/,BASE64=/^[A-Za-z0-9+/]*={0,2}$/;
/** Parses a package (JSON text or bytes); returns {manifest, files, binary} with binary files as Uint8Array. */
export function readPackage(input,{developer=false}={}){
  const bytes=typeof input==='string'?new TextEncoder().encode(input):input;
  if(!(bytes instanceof Uint8Array))fail('A plugin package is a JSON file.','invalid_package');
  if(bytes.length>MAX_PACKAGE_BYTES)fail('This plugin package is larger than 4 MiB.','invalid_package');
  let value;try{value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}catch{fail('This is not a Scribyra plugin package (not JSON).','invalid_package');}
  if(!isObject(value)||value.format!==PACKAGE_FORMAT)fail('This is not a Scribyra plugin package.','invalid_package');
  if(value.formatVersion!==PACKAGE_FORMAT_VERSION)fail('This plugin package needs a newer version of Scribyra.','unsupported_version');
  only(value,['format','formatVersion','manifest','files','binary'],'The package');
  const manifest=validateManifest(value.manifest,{developer});
  if(!isObject(value.files))fail('The package has no files.','invalid_package');
  const files=Object.create(null),binary=Object.create(null);
  for(const [name,content]of Object.entries(value.files)){if(!FILE_NAME.test(name)||typeof content!=='string')fail(`Package file “${name}” is not valid.`,'invalid_package');files[name]=content;}
  for(const [name,content]of Object.entries(value.binary??{})){
    if(!FILE_NAME.test(name)||typeof content!=='string'||!BASE64.test(content)||name in files)fail(`Package file “${name}” is not valid.`,'invalid_package');
    binary[name]=base64Bytes(content);
  }
  if(typeof files[manifest.main]!=='string')fail(`The package does not contain its main file “${manifest.main}”.`,'invalid_package');
  return {manifest,files,binary};
}
export function base64Bytes(text){
  if(typeof atob==='function'){const raw=atob(text),out=new Uint8Array(raw.length);for(let i=0;i<raw.length;i++)out[i]=raw.charCodeAt(i);return out;}
  return new Uint8Array(Buffer.from(text,'base64'));
}
export const isOfficialId=id=>id.startsWith(OFFICIAL_PREFIX);

/** What a new version asks for beyond what was granted: whole permissions or widened ones. */
export function addedPermissions(granted,requested){
  const added={};
  for(const [key,grant]of Object.entries(requested)){
    const before=granted?.[key];
    if(before===undefined){added[key]=grant;continue;}
    if(key==='project.read'){const extra=grant.files.filter(glob=>!before.files.includes(glob));if(extra.length)added[key]={files:extra};}
    else if(key==='project.write'){const extra=grant.create.filter(glob=>!before.create.includes(glob));if(extra.length||grant.pick&&!before.pick)added[key]={create:extra,pick:grant.pick&&!before.pick};}
    else if(key==='network'){const extra=grant.filter(origin=>!before.includes(origin));if(extra.length)added[key]=extra;}
  }
  return added;
}
const privateOrigin=origin=>{const host=new URL(origin).hostname.replace(/^\[|\]$/g,'');return /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|::1$|f[cd]|fe80:)/i.test(host)||host.endsWith('.local');};
const list=items=>items.length<=1?items.join(''):`${items.slice(0,-1).join(', ')} and ${items.at(-1)}`;
/** Plain words for the consent dialog and the manager, one line per permission. */
// Most consequential first: what it reads and changes, where it sends, what it keeps.
const ORDER=['project.read','project.write','network','secrets','bibliography','completion','ui.dialog','ui.command','ui.fileAction'];
export function describePermissions(permissions){
  const lines=[];
  for(const [key,grant]of Object.entries(permissions).sort(([a],[b])=>ORDER.indexOf(a)-ORDER.indexOf(b))){
    switch(key){
      case 'project.read':lines.push({key,text:`Read files in the open project matching ${list(grant.files)}`,detail:'Only the project you have open, never your other projects, history or comments.'});break;
      case 'project.write':lines.push({key,text:[grant.create.length?`Create ${list(grant.create)} files and change the files it created`:'',grant.pick?'Change files you pick for it':''].filter(Boolean).join('; '),detail:'In Reviewing its changes become suggestions; in Viewing it cannot change anything.'});break;
      case 'network':lines.push({key,text:`Contact ${list(grant)}`,detail:`It can send what it reads from the open project there. No other address.${grant.some(privateOrigin)?' Some of these are on your own computer or local network.':''}`});break;
      case 'secrets':lines.push({key,text:'Keep secrets such as API keys on this device',detail:'Never in projects, history, backups, exports, diagnostics or telemetry.'});break;
      case 'ui.dialog':lines.push({key,text:'Show dialogs'});break;
      case 'ui.command':lines.push({key,text:'Add items to More tools'});break;
      case 'ui.fileAction':lines.push({key,text:'Add actions to the file tree and a bar above its files'});break;
      case 'completion':lines.push({key,text:'Suggest LaTeX commands while you type'});break;
      case 'bibliography':lines.push({key,text:'Suggest citations while you type'});break;
    }
  }
  return lines;
}

/** The organisation or build policy. Unset means a personal browser: official plugins
 * allowed, developer mode available. */
export function normalPolicy(value){
  if(value===undefined||value===null||value==='')return {userInstall:true,developerMode:true,allow:null};
  const policy=typeof value==='string'?JSON.parse(value):value;
  if(!isObject(policy))throw new PluginError('invalid_policy','The plugin policy must be a JSON object.');
  only(policy,['userInstall','developerMode','allow'],'The plugin policy');
  const allow=policy.allow===undefined||policy.allow===null?null:policy.allow;
  if(allow!==null&&(!Array.isArray(allow)||allow.some(rule=>!isObject(rule)||!validPluginId(rule.id)||(rule.versions!==undefined&&typeof rule.versions!=='string')||(rule.sha256!==undefined&&(!Array.isArray(rule.sha256)||rule.sha256.some(hash=>!/^[a-f0-9]{64}$/.test(hash)))))))throw new PluginError('invalid_policy','The plugin policy “allow” list is not valid.');
  return {userInstall:policy.userInstall!==false,developerMode:policy.developerMode!==false,allow};
}
/** '' when allowed, else the reason. `candidate` is {id, version, sha256, source, action}. */
export function policyDecision(policy,{id,version,sha256,source,action='run'}){
  if(source==='developer'&&!policy.developerMode)return 'Your organisation does not allow plugins from developer mode.';
  if(action==='install'&&!policy.userInstall&&!policy.allow?.some(rule=>rule.id===id))return 'Your organisation installs plugins for you; this one is not on its list.';
  if(policy.allow){
    const rule=policy.allow.find(rule=>rule.id===id);
    if(!rule)return 'Your organisation has not allowed this plugin.';
    if(!versionInRange(version,rule.versions))return `Your organisation allows ${id} only in versions ${rule.versions}.`;
    if(rule.sha256&&!rule.sha256.includes(sha256))return 'Your organisation has not allowed this build of the plugin.';
  }
  return '';
}
