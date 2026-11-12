import {projectNode} from './model.js';

// Synchronous input journal. A save acknowledgement can clear only its own generation.
export function reviewDraftJournal(key,store=localStorage){
  const active=new Map();
  return{read:()=>Object.keys(store).filter(k=>k.startsWith(key)).map(k=>JSON.parse(store.getItem(k))),
    write:entry=>store.setItem(key+entry.id,JSON.stringify(entry)),
    checkpoint(draft){const entry={...draft,id:active.get(draft.fileId)?.id||crypto.randomUUID()};active.set(draft.fileId,entry);store.setItem(key+entry.id,JSON.stringify(entry));return entry;},
    pending:()=>[...active.values()],
    acknowledge(entries){for(const entry of entries)if(active.get(entry.fileId)===entry){store.removeItem(key+entry.id);active.delete(entry.fileId);}},
    release(fileId){active.delete(fileId);},remove:entry=>store.removeItem(key+entry.id),
  };
}

// Recovery is device-local and separate from accepted source and shared proposals.
export function reviewDrafts(context){
  const key=`scribyra:review-drafts:${context.projectId}:${context.author.id}:`;
  const recovered=new Set(),signature=draft=>JSON.stringify([draft.fileId,draft.text]);
  let drafts=[];const unsaved=new Set(),journal=reviewDraftJournal(key);
  try{drafts=journal.read();}catch{throw new Error('Retained review drafts could not be read. Keep this tab open.');}
  const section=document.createElement('section');section.setAttribute('aria-label','Retained review drafts');
  const save=draft=>{if(context.canPersistDrafts?.()===false)throw new Error('Save or download the retained draft before closing this temporary project.');journal.write(draft);};
  function render(){
    section.replaceChildren();section.hidden=!drafts.length;
    if(!section.isConnected)document.getElementById('code-editor')?.before(section);
    for(const draft of drafts){
      const title=document.createElement('p');title.textContent=`Retained review draft · ${draft.path}. This draft could not be published; your text is kept here. Save the text to recover it, or discard it explicitly.`;
      const text=document.createElement('textarea');text.readOnly=true;text.value=draft.text;text.setAttribute('aria-label',`Retained draft for ${draft.path}`);
      const keep=document.createElement('button');keep.type='button';keep.textContent='Save draft text';keep.onclick=()=>{const url=URL.createObjectURL(new Blob([draft.text],{type:'text/plain;charset=utf-8'})),a=document.createElement('a');a.href=url;a.download=draft.path.split('/').at(-1)+'.review-draft.txt';a.click();recovered.add(signature(draft));unsaved.delete(draft.id);context.onDraftPending?.(journal.pending().length>0||unsaved.size>0);setTimeout(()=>URL.revokeObjectURL(url),1000);};
      const discard=document.createElement('button');discard.type='button';discard.textContent='Discard draft';discard.onclick=async()=>{if(!await context.confirm?.('Discard review draft','Discard this retained text? This cannot be undone.'))return;const previous=drafts;drafts=drafts.filter(d=>d.id!==draft.id);try{journal.remove(draft);recovered.add(signature(draft));unsaved.delete(draft.id);context.onDraftPending?.(journal.pending().length>0||unsaved.size>0);render();}catch(e){drafts=previous;context.onError?.(e);}};
      section.append(title,text,keep,discard);
    }
  }
  render();
  return{render,recovery:()=>[...drafts,...journal.pending()],checkpoint(draft){
    const entry={...draft,path:projectNode(context.doc,draft.fileId)?.path||draft.fileId};
    context.onDraftPending?.(true);
    try{if(context.canPersistDrafts?.()===false)throw new Error();return journal.checkpoint(entry);}
    catch{const pending=journal.pending().find(d=>d.fileId===draft.fileId);journal.release(draft.fileId);const retained=pending||{...entry,id:crypto.randomUUID()};drafts.push(retained);unsaved.add(retained.id);render();throw new Error('Draft retained in this tab, but local recovery storage failed. Save draft text before leaving.');}
  },pending:journal.pending,acknowledge(entries){
    journal.acknowledge(entries);context.onDraftPending?.(journal.pending().length>0||unsaved.size>0);
  },retain(draft){
    const pending=journal.pending().find(d=>d.fileId===draft.fileId);
    if(recovered.has(signature(draft)))return;
    const existing=drafts.find(d=>d.fileId===draft.fileId&&d.text===draft.text),retained=existing||{...draft,id:pending?.id||crypto.randomUUID(),path:projectNode(context.doc,draft.fileId)?.path||draft.fileId};
    if(!existing)drafts.push(retained);
    render();try{save(retained);unsaved.delete(retained.id);journal.release(draft.fileId);}catch{unsaved.add(retained.id);context.onDraftPending?.(true);throw new Error('Draft retained in this tab, but local recovery storage failed. Save draft text before leaving.');}
  },close(){section.remove();}};
}
