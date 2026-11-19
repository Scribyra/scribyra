// Import planning for "Open in Scribyra" links (docs/open-links.md): which entries of a
// repository or archive become project files, which are skipped and why, ZIP reading
// with hard bounds, main-file detection and the provenance record kept in the project.
// Everything here treats repository content as untrusted data. No network, no storage.
import {Inflate,strFromU8} from 'fflate';
import {validPath,isText,MAX_BYTES,MAX_FILES} from './model.js';
import {private_folder_state_path} from './pkg/scribyra_app.js';

export const IMPORT_LIMITS=Object.freeze({
 files:MAX_FILES,            // the project bound
 bytes:MAX_BYTES,            // 64 MiB, the project bound
 fileBytes:16*1024*1024,     // larger files are skipped and reported
 archiveBytes:96*1024*1024,  // largest ZIP or repository archive downloaded
 listedEntries:20000,        // largest tree or archive directory examined
});
export const SKIP_REASONS=Object.freeze({
 unsafe:'Unsafe or invalid name, refused',
 symlink:'Symbolic link, not imported',
 submodule:'Git submodule, not imported',
 lfs:'Git LFS pointer, file content not imported',
 large:`Larger than ${IMPORT_LIMITS.fileBytes/1024/1024} MiB, skipped`,
 total:`Skipped to stay within the ${MAX_BYTES/1024/1024} MiB project limit`,
 encoding:'Not valid UTF-8 text, skipped',
 private:'Scribyra sync or Git metadata, skipped',
 unsupported:'Encrypted or unsupported compression, skipped',
 exportIgnore:'Left out of the archive by the repository (.gitattributes export-ignore)',
});
export class ImportRefused extends Error{constructor(message){super(message);this.name='ImportRefused';}}
const refuse=message=>{throw new ImportRefused(message);};
const mib=bytes=>`${(bytes/1024/1024).toFixed(bytes<10*1024*1024?1:0)} MiB`;

/** True for a path the project accepts and that is not Git or Scribyra private state. */
function pathProblem(path){
 if(typeof path!=='string'||!path||!validPath(path))return 'unsafe';
 if(/^\.git(?:\/|$)|\/\.git(?:\/|$)/i.test(path)||private_folder_state_path(path))return 'private';
 return null;
}
/**
 * entries: [{path, size, kind: 'file'|'symlink'|'submodule'|'unsupported'|'exportIgnore', ...extra}]
 * with paths already relative to the import root. Returns {files, skipped, bytes}.
 * Throws ImportRefused when the result could not be a usable project.
 */
export function planImport(entries){
 if(entries.length>IMPORT_LIMITS.listedEntries)refuse(`This source lists more than ${IMPORT_LIMITS.listedEntries.toLocaleString('en')} entries. Link to the folder that holds the document with path=.`);
 const files=[],skipped=[],seen=new Set();
 for(const entry of entries){
  const problem=pathProblem(entry.path);
  if(problem){skipped.push({path:String(entry.path).slice(0,300),reason:problem});continue;}
  if(entry.kind!=='file'){skipped.push({path:entry.path,reason:entry.kind});continue;}
  if(!Number.isSafeInteger(entry.size)||entry.size<0)refuse('The source reported an invalid file size.');
  const key=entry.path.normalize('NFC').toLowerCase();
  if(seen.has(key))refuse(`The source contains “${entry.path}” more than once (names differing only in case or Unicode form). Scribyra cannot import both safely.`);
  seen.add(key);
  if(entry.size>IMPORT_LIMITS.fileBytes){skipped.push({path:entry.path,reason:'large',size:entry.size});continue;}
  files.push(entry);
 }
 let bytes=files.reduce((sum,file)=>sum+file.size,0);
 if(bytes>MAX_BYTES){
  // Drop the largest non-source files first; sources stay.
  const binaries=files.filter(file=>!isText(file.path)).sort((a,b)=>b.size-a.size||a.path.localeCompare(b.path));
  for(const file of binaries){if(bytes<=MAX_BYTES)break;files.splice(files.indexOf(file),1);bytes-=file.size;skipped.push({path:file.path,reason:'total',size:file.size});}
  if(bytes>MAX_BYTES)refuse(`The source files alone are ${mib(bytes)}, more than the ${mib(MAX_BYTES)} a project can hold. Link to a smaller folder with path=.`);
 }
 if(files.length>IMPORT_LIMITS.files)refuse(`This source has ${files.length} files; a project holds at most ${IMPORT_LIMITS.files}. Link to the folder that holds the document with path=.`);
 if(!files.length)refuse('There are no files to import here.');
 files.sort((a,b)=>a.path.localeCompare(b.path));
 return {files,skipped,bytes};
}

const LFS=/^version https:\/\/git-lfs\.github\.com\/spec\/v1\n/;
/** Small text files that are Git LFS pointers rather than the real content. */
export function isLfsPointer(bytes){return bytes.length<1024&&LFS.test(strFromU8(bytes.subarray(0,64),true));}
/**
 * Turns downloaded bytes into project entries. Text files must be UTF-8; others stay
 * binary. Returns {entries, skipped} and never applies .gitattributes filters.
 */
export function projectEntries(downloaded){
 const entries=[],skipped=[];let total=0;
 for(const {path,bytes}of downloaded){
  if(isLfsPointer(bytes)){skipped.push({path,reason:'lfs'});continue;}
  total+=bytes.length;if(total>MAX_BYTES)refuse(`The downloaded files exceed ${mib(MAX_BYTES)}.`);
  if(isText(path)){
   try{entries.push({path,content:new TextDecoder('utf-8',{fatal:true}).decode(bytes)});}
   catch{skipped.push({path,reason:'encoding'});}
  }else entries.push({path,content:bytes});
 }
 return {entries,skipped};
}

// LaTeX root documents: \documentclass and \begin{document}, outside comments.
const uncommented=text=>text.replace(/(^|[^\\])%.*$/gm,'$1');
export function isRootDocument(text){const source=uncommented(text.slice(0,512*1024));return /\\documentclass\s*(?:\[[^\]]*\]\s*)?\{[^}]+\}/.test(source)&&/\\begin\s*\{document\}/.test(source);}
/** The most likely main file: shallowest root document, preferring main.tex and non-standalone classes. */
export function detectMainFile(entries){
 const candidates=entries.filter(entry=>/\.tex$/i.test(entry.path)&&typeof entry.content==='string'&&isRootDocument(entry.content));
 const rank=entry=>[/\\documentclass\s*(?:\[[^\]]*\]\s*)?\{standalone\}/.test(uncommented(entry.content))?1:0,entry.path.split('/').length,entry.path.split('/').at(-1).toLowerCase()==='main.tex'?0:1];
 candidates.sort((a,b)=>{const x=rank(a),y=rank(b);for(let i=0;i<x.length;i++)if(x[i]!==y[i])return x[i]-y[i];return a.path.localeCompare(b.path);});
 return candidates[0]?.path||'';
}

/** Reads a ZIP central directory without inflating anything. Refuses layouts it cannot bound. */
export function readZipDirectory(bytes){
 if(!(bytes instanceof Uint8Array))refuse('Invalid ZIP archive.');
 if(bytes.length>IMPORT_LIMITS.archiveBytes)refuse(`The archive is larger than ${mib(IMPORT_LIMITS.archiveBytes)}.`);
 const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
 let end=-1;
 for(let i=bytes.length-22;i>=Math.max(0,bytes.length-65557);i--)if(view.getUint32(i,true)===0x06054b50&&i+22+view.getUint16(i+20,true)===bytes.length){end=i;break;}
 if(end<0)refuse('This is not a ZIP archive, or it is damaged.');
 const disk=view.getUint16(end+4,true),startDisk=view.getUint16(end+6,true),count=view.getUint16(end+10,true),size=view.getUint32(end+12,true),start=view.getUint32(end+16,true);
 if(disk||startDisk||count===0xffff||start===0xffffffff)refuse('Split or ZIP64 archives are not supported.');
 if(count>IMPORT_LIMITS.listedEntries)refuse(`The archive lists more than ${IMPORT_LIMITS.listedEntries.toLocaleString('en')} entries.`);
 if(start+size!==end)refuse('The ZIP directory is damaged.');
 const entries=[];let cursor=start;
 for(let i=0;i<count;i++){
  if(cursor+46>end||view.getUint32(cursor,true)!==0x02014b50)refuse('The ZIP directory is damaged.');
  const madeBy=view.getUint16(cursor+4,true),flags=view.getUint16(cursor+8,true),method=view.getUint16(cursor+10,true),compressed=view.getUint32(cursor+20,true),uncompressed=view.getUint32(cursor+24,true);
  const nameLength=view.getUint16(cursor+28,true),extra=view.getUint16(cursor+30,true),comment=view.getUint16(cursor+32,true),external=view.getUint32(cursor+38,true),offset=view.getUint32(cursor+42,true);
  if(cursor+46+nameLength+extra+comment>end)refuse('The ZIP directory is damaged.');
  if(compressed===0xffffffff||uncompressed===0xffffffff||offset===0xffffffff)refuse('ZIP64 archives are not supported.');
  const raw=bytes.subarray(cursor+46,cursor+46+nameLength);let name=null;
  try{name=new TextDecoder('utf-8',{fatal:true}).decode(raw);}catch{}
  const mode=(madeBy>>8)===3?external>>>16:0;
  const directory=name!==null&&name.endsWith('/')||(external&0x10)!==0||(mode&0xf000)===0x4000;
  const symlink=(mode&0xf000)===0xa000;
  entries.push({name,directory,symlink,encrypted:(flags&1)!==0,method,compressed,size:uncompressed,offset});
  cursor+=46+nameLength+extra+comment;
 }
 return entries;
}
/** Inflates one entry, stopping as soon as it produces more than its declared size. */
export function extractZipEntry(bytes,entry){
 const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength),at=entry.offset;
 if(at+30>bytes.length||view.getUint32(at,true)!==0x04034b50)refuse('A ZIP entry is damaged.');
 const start=at+30+view.getUint16(at+26,true)+view.getUint16(at+28,true),stop=start+entry.compressed;
 if(stop>bytes.length)refuse('A ZIP entry is damaged.');
 const data=bytes.subarray(start,stop);
 if(entry.method===0){if(data.length!==entry.size)refuse('A ZIP entry does not match its declared size.');return data.slice();}
 if(entry.method!==8)refuse('A ZIP entry uses unsupported compression.');
 const output=new Uint8Array(entry.size);let written=0,done=false;
 const inflate=new Inflate();
 inflate.ondata=(chunk,final)=>{
  if(written+chunk.length>entry.size)refuse('A ZIP entry expands beyond its declared size. The archive was refused.');
  output.set(chunk,written);written+=chunk.length;if(final)done=true;
 };
 // Small input steps bound the memory one step can produce (deflate expands at most ~1032×).
 try{for(let i=0;i<data.length;i+=4096)inflate.push(data.subarray(i,Math.min(i+4096,data.length)),i+4096>=data.length);if(!data.length)inflate.push(new Uint8Array(),true);}
 catch(error){if(error instanceof ImportRefused)throw error;refuse('A ZIP entry is damaged.');}
 if(!done||written!==entry.size)refuse('A ZIP entry does not match its declared size.');
 return output;
}
/**
 * Lists the importable entries of an archive under `prefix` (a folder inside it, '' for
 * all). A single top-level folder that holds everything is removed first, as in
 * repository archives. Returns [{path, size, kind, zip}].
 */
export function zipEntries(directory,prefix=''){
 const names=new Set();
 for(const entry of directory){if(entry.name===null)continue;if(names.has(entry.name))refuse('The archive lists the same name twice. It was refused.');names.add(entry.name);}
 const named=directory.filter(entry=>entry.name!==null),roots=new Set(named.map(entry=>entry.name.split('/')[0]));
 const wrapped=roots.size===1&&named.every(entry=>entry.name.includes('/')||entry.directory);
 const strip=wrapped?[...roots][0]+'/':'';
 const result=[],folder=prefix?prefix+'/':'';
 for(const entry of directory){
  if(entry.name===null){result.push({path:'(name is not valid UTF-8)',size:0,kind:'unsafe'});continue;}
  if(entry.directory)continue;
  let path=entry.name;
  if(strip){if(!path.startsWith(strip))continue;path=path.slice(strip.length);}
  if(folder){if(!path.startsWith(folder))continue;path=path.slice(folder.length);}
  const kind=entry.symlink?'symlink':entry.encrypted||![0,8].includes(entry.method)?'unsupported':'file';
  // Absolute names, backslashes, drive letters and .. are caught by the path check later.
  result.push({path,size:entry.size,kind,zip:entry});
 }
 return result;
}
/**
 * Which repository paths the root .gitattributes stores in Git LFS (`filter=lfs`).
 * Supports the usual forms: `*.pdf`, `name`, `dir/**`, `dir/*.png`. Later lines win, as in Git.
 */
export function lfsMatcher(text){
 const rules=[];
 for(const line of text.split(/\r?\n/).slice(0,2000)){
  const parts=line.trim().split(/\s+/);if(!parts[0]||parts[0].startsWith('#')||parts[0].length>200)continue;
  const filter=parts.slice(1).find(part=>/^-?filter(?:=|$)|^!filter$/.test(part));if(!filter)continue;
  if((parts[0].match(/\*/g)||[]).length>6)continue;
  const pattern=parts[0].replace(/^\//,''),anchored=parts[0].includes('/')&&!parts[0].endsWith('/');
  const source=pattern.replace(/[.+^${}()|\\]/g,'\\$&').replace(/\*\*\//g,'\u0000').replace(/\*\*/g,'\u0001').replace(/\*/g,'[^/]*').replace(/\?/g,'[^/]').replace(/\u0000/g,'(?:.*/)?').replace(/\u0001/g,'.*');
  const regex=new RegExp(anchored?`^${source}$`:`(?:^|/)${source}$`);
  rules.push({regex,lfs:filter==='filter=lfs'});
 }
 return path=>{let result=false;for(const rule of rules)if(rule.regex.test(path))result=rule.lfs;return result;};
}

// The provenance record kept in project metadata (meta.importSource), so a later Git
// plugin can offer to link the project. Public facts only: never tokens or cookies.
const HEX=/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
export function importSourceRecord(link,{commit='',archiveSha256='',importedAt=Date.now(),main=''}={}){
 return {version:1,kind:link.kind,host:link.host,repo:link.repo,url:link.url,ref:link.ref,commit,path:link.path,main,archiveSha256,importedAt};
}
export function validImportSource(value){
 if(!value||typeof value!=='object'||Array.isArray(value))return false;
 const keys=['archiveSha256','commit','host','importedAt','kind','main','path','ref','repo','url','version'];
 if(Object.keys(value).sort().join(',')!==keys.join(','))return false;
 if(value.version!==1||!['github','gitlab','zip'].includes(value.kind)||!Number.isSafeInteger(value.importedAt)||value.importedAt<0)return false;
 for(const key of keys.filter(key=>!['version','importedAt'].includes(key)))if(typeof value[key]!=='string'||value[key].length>2048)return false;
 if(!/^[a-z0-9.-]+(?::\d{1,5})?$/.test(value.host)||(value.commit&&!HEX.test(value.commit))||(value.archiveSha256&&!/^[0-9a-f]{64}$/.test(value.archiveSha256)))return false;
 if(value.kind==='zip'?!value.url.startsWith('https://')||value.repo:value.url||!value.repo)return false;
 return true;
}
