// BibTeX and BibLaTeX files as data: entries with their exact source ranges, the
// problems a person should hear about before importing, and the comparisons that
// Zotero refresh uses. Pure and synchronous; nothing here touches a project.
//
// The reader follows BibTeX's rules: text outside an entry is a comment, an entry
// is `@type{key, field = value, …}` (or with parentheses), values are braced,
// quoted, numbers or macro names joined by `#`. It recovers at the next line that
// starts with `@`, so one broken entry does not hide the problems after it.

const SKIPPED=new Set(['comment','preamble','string']);
// BibTeX's month macros are always defined.
const BUILTIN_MACROS=new Set(['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec']);
// Characters BibTeX, Biber and LaTeX's \cite cannot take in a citation key.
const BAD_KEY=/[\s{}"#%'(),=\\~]/;
export const validCitationKey=key=>typeof key==='string'&&key.length>0&&key.length<=200&&!BAD_KEY.test(key);

function lineStarts(text){const starts=[0];for(let i=text.indexOf('\n');i>=0;i=text.indexOf('\n',i+1))starts.push(i+1);return starts;}
function lineOf(starts,offset){let low=0,high=starts.length-1;while(low<high){const mid=(low+high+1)>>1;if(starts[mid]<=offset)low=mid;else high=mid-1;}return low+1;}
const atLineStart=(text,i)=>{for(let j=i-1;j>=0;j--){const c=text[j];if(c==='\n')return true;if(c!==' '&&c!=='\t'&&c!=='\r')return false;}return true;};
/** Whether `i` sits after a `%` on its line (Biber treats such lines as comments). */
function inPercentComment(text,i){for(let j=i-1;j>=0&&text[j]!=='\n';j--)if(text[j]==='%'&&text[j-1]!=='\\')return true;return false;}

/**
 * The end of a delimited body starting at `open` ({ or (), or -1 if it is not closed
 * before the end of the text or before a line that starts a new `@` entry.
 */
function closing(text,open){
  const close=text[open]==='{'?'}':')';let depth=0;
  for(let i=open;i<text.length;i++){
    const c=text[i];
    if(c==='\\'){i++;continue;}
    if(c==='@'&&i>open&&atLineStart(text,i)&&/^@\s*[A-Za-z]+\s*[{(]/.test(text.slice(i,i+40)))return -1;
    if(c==='{')depth++;
    else if(c==='}'){depth--;if(close==='}'&&depth===0)return i;if(depth<0)return -1;}
    else if(c===')'&&close===')'&&depth===0)return i;
  }
  return -1;
}
function braced(body,start){let depth=0;for(let i=start;i<body.length;i++){const c=body[i];if(c==='\\'){i++;continue;}if(c==='{')depth++;else if(c==='}'&&--depth===0)return i;}return -1;}

/** Fields of one entry body (after the key), with problems found while reading them. */
function readFields(body,report,macros){
  const fields=new Map(),order=[];let i=0;
  const skip=()=>{while(i<body.length&&/\s/.test(body[i]))i++;};
  while(true){
    skip();if(i>=body.length)break;
    if(body[i]===','){i++;continue;}
    const name=/[A-Za-z_][\w\-:.+]*/y;name.lastIndex=i;const found=name.exec(body);
    if(!found){report(i,`Expected a field name, found “${body.slice(i,i+20).split('\n')[0]}”.`);break;}
    const field=found[0].toLowerCase();i=name.lastIndex;skip();
    if(body[i]!=='='){report(i,`Field “${found[0]}” has no “=” and value.`);break;}
    i++;skip();
    const parts=[];let raw='';const valueStart=i;
    while(true){
      skip();
      if(body[i]==='{'){const end=braced(body,i);if(end<0){report(i,`The value of “${found[0]}” has an unmatched “{”.`);return {fields,order,broken:true};}parts.push(body.slice(i+1,end));i=end+1;}
      else if(body[i]==='"'){let end=i+1,depth=0;for(;end<body.length;end++){const c=body[end];if(c==='\\'){end++;continue;}if(c==='{')depth++;else if(c==='}')depth--;else if(c==='"'&&depth===0)break;}if(end>=body.length){report(i,`The value of “${found[0]}” has an unmatched quotation mark.`);return {fields,order,broken:true};}parts.push(body.slice(i+1,end));i=end+1;}
      else{const word=/[^\s,#{}"=]+/y;word.lastIndex=i;const token=word.exec(body);if(!token){report(i,`Field “${found[0]}” has an empty value.`);return {fields,order,broken:true};}i=word.lastIndex;const value=token[0];if(!/^\d+$/.test(value)&&!macros.has(value.toLowerCase())&&!BUILTIN_MACROS.has(value.toLowerCase()))report(valueStart,`Field “${found[0]}” uses “${value}”, which no @string defines. Put the value in braces if it is text.`,'warning');parts.push(value);}
      skip();if(body[i]==='#'){i++;continue;}break;
    }
    raw=body.slice(valueStart,i).trim();
    if(fields.has(field))report(valueStart,`Field “${found[0]}” appears twice; BibTeX keeps only one.`,'warning');
    else order.push(field);
    fields.set(field,{value:parts.join(''),raw});
    skip();
    if(i<body.length&&body[i]!==','){const next=/[A-Za-z_][\w\-:.+]*\s*=/y;next.lastIndex=i;report(i,next.test(body)?`A comma is missing before field “${body.slice(i).match(/^[A-Za-z_][\w\-:.+]*/)[0]}”.`:`Unexpected text “${body.slice(i,i+20).split('\n')[0]}” after field “${found[0]}”.`);if(!next.lastIndex)break;continue;}
  }
  return {fields,order,broken:false};
}

/**
 * Reads a .bib text. Entries keep their exact source range [start, end) so callers can
 * replace one entry without touching anything else. Problems carry a line number and a
 * severity: errors are what BibTeX or Biber would reject or misread; warnings are
 * suspicious but importable.
 */
export function readBibliography(input){
  const text=String(input??'');const starts=lineStarts(text),line=offset=>lineOf(starts,offset);
  const entries=[],problems=[],macros=new Set(),strings=[];
  let i=0;
  while(i<text.length){
    const at=text.indexOf('@',i);if(at<0)break;
    if(inPercentComment(text,at)){i=at+1;continue;}
    const head=/@\s*([A-Za-z][\w-]*)\s*/y;head.lastIndex=at;const found=head.exec(text);
    if(!found){i=at+1;continue;}
    const type=found[1].toLowerCase(),open=head.lastIndex;
    if(text[open]!=='{'&&text[open]!=='('){
      if(!SKIPPED.has(type))problems.push({severity:'error',line:line(at),message:`“@${found[1]}” is not followed by “{”.`});
      i=open;continue;
    }
    const end=closing(text,open);
    if(type==='comment'){i=end<0?open+1:end+1;continue;}
    if(end<0){
      const key=text.slice(open+1).match(/^\s*([^,\s{}()]*)/)?.[1]||'';
      problems.push({severity:'error',line:line(at),key:SKIPPED.has(type)?undefined:key||undefined,message:`${SKIPPED.has(type)?`@${found[1]}`:key?`Entry “${key}”`:`The @${found[1]} entry`} is not closed: a “${text[open]==='{'?'}':')'}” is missing.`});
      // Resume at the next line that starts an entry.
      const next=text.slice(open+1).search(/\n\s*@\s*[A-Za-z]+\s*[{(]/);i=next<0?text.length:open+1+next+1;continue;
    }
    const body=text.slice(open+1,end);
    if(type==='preamble'){i=end+1;continue;}
    if(type==='string'){const name=body.match(/^\s*([A-Za-z_][\w\-:.+]*)\s*=/);if(name){macros.add(name[1].toLowerCase());strings.push(name[1]);}else problems.push({severity:'error',line:line(at),message:'@string needs the form @string{name = "value"}.'});i=end+1;continue;}
    const comma=body.indexOf(','),rawKey=(comma<0?body:body.slice(0,comma)).trim();
    const entryProblems=[];
    const report=(offset,message,severity='error')=>entryProblems.push({severity,line:line(open+1+comma+1+offset),key:rawKey||undefined,message:`${rawKey?`“${rawKey}”: `:''}${message}`});
    if(!rawKey)problems.push({severity:'error',line:line(at),message:`An @${found[1]} entry has no citation key.`});
    else if(comma<0&&/\s/.test(rawKey)){problems.push({severity:'error',line:line(at),message:`The @${found[1]} entry starting “${rawKey.split(/\s/)[0]}” needs a comma after its citation key.`});i=end+1;continue;}
    else if(!validCitationKey(rawKey))problems.push({severity:'error',line:line(at),key:rawKey,message:`Citation key “${rawKey}” contains a character LaTeX cannot cite (spaces, braces, commas, quotes, #, %, =, \\ or ~).`});
    const {fields,order}=comma<0?{fields:new Map(),order:[]}:readFields(body.slice(comma+1),report,macros);
    problems.push(...entryProblems);
    if(rawKey&&validCitationKey(rawKey))entries.push({key:rawKey,type,start:at,end:end+1,line:line(at),raw:text.slice(at,end+1),fields,order});
    i=end+1;
  }
  const seen=new Map();
  for(const entry of entries){
    const lower=entry.key.toLowerCase(),first=seen.get(lower);
    if(first)problems.push({severity:'error',line:entry.line,key:entry.key,message:`Citation key “${entry.key}” is used again (first on line ${first.line}). BibTeX and Biber keep only one of them.`});
    else seen.set(lower,entry);
  }
  problems.sort((a,b)=>a.line-b.line);
  return {entries,problems,strings};
}

/** Problems worth showing before an import, summarised. */
export function checkBibliography(text){
  const {entries,problems}=readBibliography(text);
  const errors=problems.filter(p=>p.severity==='error').length;
  return {entries:entries.length,problems,errors,warnings:problems.length-errors,keys:entries.map(entry=>entry.key)};
}

const squash=value=>value.replace(/\s+/g,' ').trim();
/**
 * What an entry means, ignoring layout: type, key and fields with whitespace collapsed,
 * in name order. Two entries with the same fingerprint are the same reference.
 */
export function entryFingerprint(entry,{withKey=true}={}){
  const parsed=typeof entry==='string'?readBibliography(entry).entries[0]:entry;if(!parsed)return '';
  return JSON.stringify([parsed.type,withKey?parsed.key:'',[...parsed.fields].map(([name,field])=>[name,squash(field.raw)]).sort((a,b)=>a[0]<b[0]?-1:a[0]>b[0]?1:0)]);
}
/** The entry's text with its citation key replaced; the rest is kept byte for byte. */
export function withCitationKey(raw,key){
  if(!validCitationKey(key))throw new Error(`“${key}” is not a valid citation key.`);
  return raw.replace(/^(@\s*[A-Za-z][\w-]*\s*[{(]\s*)([^,\s]*)/,(_,head)=>head+key);
}
/** Field-level differences between two entries, for a refresh preview. */
export function fieldChanges(before,after){
  const a=typeof before==='string'?readBibliography(before).entries[0]:before,b=typeof after==='string'?readBibliography(after).entries[0]:after;
  const changes=[];if(!a||!b)return changes;
  if(a.type!==b.type)changes.push({field:'entry type',before:a.type,after:b.type});
  if(a.key!==b.key)changes.push({field:'citation key',before:a.key,after:b.key});
  const names=[...new Set([...a.order,...b.order])];
  for(const name of names){const x=a.fields.get(name)?.raw,y=b.fields.get(name)?.raw;if((x&&squash(x))!==(y&&squash(y)))changes.push({field:name,before:x??null,after:y??null});}
  return changes;
}

const CITE=/\\([A-Za-z]*[Cc]ite[A-Za-z]*|nocite)\*?/g;
/**
 * Citation keys a LaTeX source uses: every \cite-like command (natbib, biblatex and
 * BibTeX's \nocite), skipping optional arguments and reading every key group of the
 * biblatex multicite forms such as \cites{a}{b}. Comments are ignored.
 */
export function citedKeys(source){
  const text=source.replace(/(\\[\s\S])|%[^\n]*/g,(match,escaped)=>escaped||'');const keys=new Set();
  for(const match of text.matchAll(CITE)){
    let i=match.index+match[0].length;const multi=/cites$/i.test(match[1]);
    for(let group=0;group<(multi?32:1);group++){
      for(let optional=0;optional<4;optional++){const rest=text.slice(i).match(/^\s*(\([^)]*\)|\[[^\]]*\])/);if(!rest)break;i+=rest[0].length;}
      const open=text.slice(i).match(/^\s*\{/);if(!open)break;i+=open[0].length;const close=text.indexOf('}',i);if(close<0)break;
      for(const key of text.slice(i,close).split(','))if(key.trim()&&key.trim()!=='*')keys.add(key.trim());
      i=close+1;
    }
  }
  return keys;
}
