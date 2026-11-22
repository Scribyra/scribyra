// Zotero refresh as a three-way merge over BibTeX entries. Pure: the caller fetches,
// stores and applies the text edits through the project command layer.
//
// The base is what Scribyra last wrote for each Zotero item (by Zotero's stable item
// key): the citation key it used, the entry text, the item version and the key Zotero
// generated. Comparing the linked file with the base finds local edits; comparing
// Zotero's current export with the base finds remote changes. An entry changed on only
// one side takes that side; an entry changed on both is a conflict the person decides.
// Entries the person added by hand are never touched.
import {readBibliography,entryFingerprint,withCitationKey,fieldChanges,validCitationKey} from '../../../web/bibtex.js';

/** One Zotero item's export (`include=biblatex` or `bibtex`) as an entry, or null for notes and attachments. */
export function remoteEntry(item,format){
  const exported=typeof item?.[format]==='string'?item[format]:'';
  const entry=readBibliography(exported).entries[0];
  if(!entry||typeof item.key!=='string'||!/^[A-Z0-9]{8}$/.test(item.key))return null;
  return {itemKey:item.key,version:Number(item.version)||0,raw:entry.raw.trim(),zoteroKey:entry.key};
}

function uniqueKey(key,taken){
  if(!taken.has(key.toLowerCase()))return key;
  // Zotero's own disambiguation: smith2020, smith2020a, smith2020b, …
  for(let n=0;n<26*27;n++){const suffix=n<26?String.fromCharCode(97+n):String.fromCharCode(97+Math.floor(n/26)-1)+String.fromCharCode(97+n%26);const next=key+suffix;if(!taken.has(next.toLowerCase()))return next;}
  throw new Error(`No free citation key near “${key}”.`);
}

export const LINKED_HEADER=(source)=>`% Linked to Zotero: ${source}.\n% “Refresh from Zotero” in Scribyra updates entries from Zotero and asks before changing any you edited here.\n\n`;

/** The first contents of a linked file and its base. Entries are sorted by citation key. */
export function composeLinkedFile(entries,source){
  const taken=new Set(),items={},blocks=[];
  for(const entry of [...entries].sort((a,b)=>a.zoteroKey.localeCompare(b.zoteroKey)||a.itemKey.localeCompare(b.itemKey))){
    const key=uniqueKey(entry.zoteroKey,taken);taken.add(key.toLowerCase());
    const raw=key===entry.zoteroKey?entry.raw:withCitationKey(entry.raw,key);
    items[entry.itemKey]={key,zoteroKey:entry.zoteroKey,entry:raw,version:entry.version};blocks.push(raw);
  }
  return {text:LINKED_HEADER(source)+blocks.map(block=>block+'\n').join('\n'),items};
}

/**
 * Compares the linked file with the base and Zotero's current state.
 * `present` is every item key Zotero currently has in the linked library or collection;
 * `fetched` holds the export of each item whose version moved past the base (and new ones).
 * `cited` maps citation keys used in the project's TeX sources to the files citing them;
 * `elsewhere` holds keys other .bib files still define.
 */
export function planRefresh({items,text,present,fetched,cited=new Map(),elsewhere=new Set(),edited=false}){
  const {entries}=readBibliography(text),byKey=new Map(entries.map(entry=>[entry.key,entry]));
  const tracked=new Set(Object.values(items).map(item=>item.key));
  const untracked=entries.filter(entry=>!tracked.has(entry.key));
  const taken=new Set(entries.map(entry=>entry.key.toLowerCase()));
  const changes=[],base={},renamedFrom=new Map();
  const citedIn=key=>cited.get(key)||[];
  // An entry whose key the person changed here is still the same Zotero item.
  function localFor(item){
    const direct=byKey.get(item.key);if(direct)return direct;
    const shape=entryFingerprint(item.entry,{withKey:false});
    const moved=untracked.find(entry=>!renamedFrom.has(entry.key)&&entryFingerprint(entry,{withKey:false})===shape);
    if(moved)renamedFrom.set(moved.key,item.key);return moved||null;
  }
  for(const [itemKey,item] of Object.entries(items)){
    const local=localFor(item),state=!local?'deleted':entryFingerprint(local)===entryFingerprint(item.entry)?'same':'edited';
    const current=local?.key||item.key;
    if(!present.has(itemKey)){
      if(state==='deleted')continue;
      const cites=elsewhere.has(current)?[]:citedIn(current);
      changes.push({itemKey,kind:'removed',local:state,conflict:state==='edited',key:current,before:local.raw,after:null,range:[local.start,local.end],fields:[],cited:cites,choice:state==='edited'||cites.length?'local':'zotero'});
      continue;
    }
    const remote=fetched.get(itemKey);
    if(!remote){base[itemKey]={...item,key:current};continue;}
    // Keep the key the source uses; follow Zotero's generated key only while nothing cites it and the person never changed it.
    let key=current,note='';
    if(remote.zoteroKey!==item.zoteroKey){
      if(current===item.zoteroKey&&!citedIn(current).length&&validCitationKey(remote.zoteroKey)){
        const free=new Set(taken);free.delete(current.toLowerCase());key=uniqueKey(remote.zoteroKey,free);
        note=`Zotero now generates “${remote.zoteroKey}”; nothing cites “${current}”, so the key changes.`;
      }else note=`Zotero now generates “${remote.zoteroKey}”; the key stays “${current}” because ${citedIn(current).length?`it is cited in ${citedIn(current).join(', ')}`:'you chose it'}.`;
    }
    const after=withCitationKey(remote.raw,key);
    const next={key,zoteroKey:remote.zoteroKey,entry:after,version:remote.version};
    if(entryFingerprint(after)===entryFingerprint(withCitationKey(item.entry,key))&&key===current){base[itemKey]=next;continue;}
    // Both sides made the same change: nothing to decide.
    if(local&&entryFingerprint(local)===entryFingerprint(after)){base[itemKey]=next;continue;}
    if(key!==current){taken.delete(current.toLowerCase());taken.add(key.toLowerCase());}
    changes.push({itemKey,kind:'changed',local:state,conflict:state!=='same',key,previousKey:current,before:local?.raw??null,after,range:local?[local.start,local.end]:null,fields:fieldChanges(local?.raw??item.entry,after),note,cited:[],next,choice:state==='same'?'zotero':'local'});
  }
  for(const [itemKey,remote] of fetched){
    if(items[itemKey])continue;
    const key=uniqueKey(remote.zoteroKey,taken);taken.add(key.toLowerCase());
    const after=key===remote.zoteroKey?remote.raw:withCitationKey(remote.raw,key);
    changes.push({itemKey,kind:'added',local:null,conflict:false,key,before:null,after,range:null,fields:[],note:key===remote.zoteroKey?'':`“${remote.zoteroKey}” is already used in this file, so this entry is added as “${key}”.`,cited:[],next:{key,zoteroKey:remote.zoteroKey,entry:after,version:remote.version},choice:'zotero'});
  }
  const order={changed:0,added:1,removed:2};
  changes.sort((a,b)=>Number(b.conflict)-Number(a.conflict)||order[a.kind]-order[b.kind]||a.key.localeCompare(b.key));
  changes.forEach((change,index)=>{change.id=`change-${index}`;});
  const review=changes.some(change=>change.conflict||change.cited.length)||edited&&changes.length>0;
  return {changes,base,review,edited,untracked:untracked.filter(entry=>!renamedFrom.has(entry.key)).map(entry=>entry.key)};
}

/**
 * Applies the person's choices (`zotero` or `local`, by change id; unspecified changes
 * use their default) to `text`. Returns non-overlapping edits against `text`, the
 * resulting text, the next base, and cited keys that leave the file.
 */
export function applyRefresh(text,plan,choices={},{cited=new Map(),elsewhere=new Set()}={}){
  const items={...plan.base},edits=[],appended=[];
  for(const change of plan.changes){
    const choice=choices[change.id]??change.choice;if(choice!=='zotero'&&choice!=='local')throw new Error('Choose Zotero or this file for every change.');
    if(change.kind==='removed'){if(choice==='zotero'){let [start,end]=change.range;while(text[end]==='\n'||text[end]==='\r')end++;if(end===text.length)while(start>0&&/\s/.test(text[start-1]))start--;edits.push({start,end,before:text.slice(start,end),after:''});}continue;}
    items[change.itemKey]=change.next;
    if(choice==='local'){
      // Kept as it is here; the base still records what Zotero has, so the same
      // Zotero change is not offered again, and the local key stays if the person renamed it.
      if(change.kind==='changed'&&change.range&&change.previousKey!==change.key)items[change.itemKey]={...change.next,key:change.previousKey,entry:withCitationKey(change.next.entry,change.previousKey)};
      continue;
    }
    if(change.range){const [start,end]=change.range;edits.push({start,end,before:text.slice(start,end),after:change.after});}
    else appended.push(change.after);
  }
  if(appended.length){const at=text.length,lead=!text.length?'':text.endsWith('\n\n')?'':text.endsWith('\n')?'\n':'\n\n';edits.push({start:at,end:at,before:'',after:lead+appended.join('\n\n')+'\n'});}
  edits.sort((a,b)=>a.start-b.start);
  let result='',at=0;for(const edit of edits){result+=text.slice(at,edit.start)+edit.after;at=edit.end;}result+=text.slice(at);
  const before=new Set(readBibliography(text).entries.map(entry=>entry.key)),after=new Set(readBibliography(result).entries.map(entry=>entry.key));
  const lost=[...before].filter(key=>!after.has(key)&&!elsewhere.has(key)&&cited.has(key)).sort();
  return {edits,text:result,items,lost};
}
