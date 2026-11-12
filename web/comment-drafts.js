const key='scribyra:comment-drafts:v1';
const size=value=>new TextEncoder().encode(JSON.stringify(value)).length;
export const COMMENT_DRAFT_LIMITS={entryBytes:64*1024,totalBytes:1024*1024,entries:128};

// Device preferences only: never part of a Y.Doc or project transfer.
export function commentDrafts(projectId,store){
  let unavailable;try{store??=globalThis.localStorage;}catch(error){unavailable=error;}
  function read(){
    if(unavailable)throw unavailable;
    if(!store)return [];
    const entries=JSON.parse(store.getItem(key)||'[]');
    if(!Array.isArray(entries)||entries.some(entry=>!entry||typeof entry.id!=='string'||typeof entry.projectId!=='string'||typeof entry.draft!=='string'||size(entry)>COMMENT_DRAFT_LIMITS.entryBytes)||entries.length>COMMENT_DRAFT_LIMITS.entries||size(entries)>COMMENT_DRAFT_LIMITS.totalBytes)throw new Error('Comment draft storage could not be read.');
    return entries;
  }
  function write(entries){if(unavailable)throw unavailable;if(!store)throw new Error('Comment draft storage is unavailable.');store.setItem(key,JSON.stringify(entries));}
  return{
    read:()=>read().filter(entry=>entry.projectId===projectId).sort((a,b)=>b.updatedAt-a.updatedAt),
    save(draft){
      const entry={...draft,projectId,updatedAt:Date.now()};
      if(size(entry)>COMMENT_DRAFT_LIMITS.entryBytes)throw new Error('Comment draft exceeds the 64 KiB local recovery limit.');
      const entries=read().filter(previous=>previous.projectId!==projectId||previous.id!==entry.id);entries.push(entry);
      if(entries.length>COMMENT_DRAFT_LIMITS.entries||size(entries)>COMMENT_DRAFT_LIMITS.totalBytes)throw new Error('Comment draft storage is full (128 drafts / 1 MiB).');
      write(entries);
    },
    remove(id){write(read().filter(entry=>entry.projectId!==projectId||entry.id!==id));},
  };
}
