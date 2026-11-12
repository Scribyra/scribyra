// Per-document memo for values that depend only on one source text and the file tree,
// such as resolved comment anchors. Comment, review and editor views each resolve every
// anchor on every keystroke; in a long project that walked each text's item list hundreds
// of times per key (docs/large-projects.md). Entries for a text are dropped before any
// observer runs for a transaction that changed it (or the tree), and nothing is cached
// while a transaction is open.
const memos=new WeakMap();
export function textMemo(doc,fileId,key,compute){
  const name='text:'+fileId;
  if(doc._transaction||!doc.share.has(name))return compute();
  let memo=memos.get(doc);
  if(!memo){
    memo=new Map();memos.set(doc,memo);
    const tree=['files','trash','assets'].map(root=>doc.getMap(root));
    const drop=transaction=>{
      if(tree.some(map=>transaction.changed.has(map))){memo.clear();return;}
      for(const [id,entry] of memo)if(transaction.changed.has(entry.type))memo.delete(id);
    };
    // Before observers (which may read the memo), and again afterwards for edits that
    // other beforeObserverCalls handlers added to the same transaction.
    doc.on('beforeObserverCalls',drop);doc.on('afterTransaction',drop);
  }
  let entry=memo.get(fileId);
  // getText, not share.get: a root first seen in an update is a placeholder until it is typed.
  if(!entry){entry={type:doc.getText(name),values:new Map()};memo.set(fileId,entry);}
  if(!entry.values.has(key))entry.values.set(key,compute());
  return entry.values.get(key);
}

// The same for values that depend only on one shared map, such as a review projection over
// discussionEvents (computed four times per suggestion per keystroke before this memo).
const mapMemos=new WeakMap();
export function mapMemo(doc,root,key,compute){
  if(doc._transaction)return compute();
  let memos=mapMemos.get(doc);if(!memos){memos=new Map();mapMemos.set(doc,memos);}
  let memo=memos.get(root);
  if(!memo){
    const map=doc.getMap(root);memo=new Map();memos.set(root,memo);
    const drop=transaction=>{if(transaction.changed.has(map))memo.clear();};
    doc.on('beforeObserverCalls',drop);doc.on('afterTransaction',drop);
  }
  if(!memo.has(key))memo.set(key,compute());
  return memo.get(key);
}
