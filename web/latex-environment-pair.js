// Paired environment names, as in Overleaf's editor: typing in the name of `\begin{x}` changes the
// matching `\end{x}` in the same transaction (and the other way round), so one undo reverts both.
// Only the partner found by nesting of that same name changes; other environments are left alone.
import {Annotation,EditorState} from '@codemirror/state';

/** Marks the transaction that carries both halves. Reviewing reads it to record one suggestion. */
export const pairedEnvironmentEdit=Annotation.define();
const TOKEN=/\\(begin|end)\s*\{([^{}\\%\n]*)\}/g,VALID=/^[A-Za-z0-9@*:._-]*$/,LIMIT=1_000_000;
const blank=text=>text.replace(/(\\[\s\S])|%[^\r\n]*/g,(match,escaped)=>escaped||' '.repeat(match.length));

/** The `\begin{…}`/`\end{…}` whose name holds the range [from, to], or null. */
export function environmentTokenAt(doc,from,to=from){
  const line=doc.lineAt(from);if(to>line.to)return null;
  const source=blank(line.text);
  for(const match of source.matchAll(TOKEN)){
    const nameFrom=line.from+match.index+match[0].indexOf('{')+1,nameTo=nameFrom+match[2].length;
    if(from>=nameFrom&&to<=nameTo)return {kind:match[1],name:line.text.slice(nameFrom-line.from,nameTo-line.from),from:line.from+match.index,nameFrom,nameTo};
  }
  return null;
}
/** The partner of a token: the `\end` that closes this `\begin` (or the reverse), counting only the same name. */
export function matchingEnvironment(doc,token,{limit=LIMIT}={}){
  const make=(match,offset)=>{const nameFrom=offset+match.index+match[0].indexOf('{')+1;return {kind:match[1],name:match[2],from:offset+match.index,nameFrom,nameTo:nameFrom+match[2].length};};
  if(token.kind==='begin'){
    const start=token.nameTo+1,text=blank(doc.sliceString(start,Math.min(doc.length,start+limit)));let depth=0;
    for(const match of text.matchAll(TOKEN)){if(match[2]!==token.name)continue;if(match[1]==='begin')depth++;else if(depth--===0)return make(match,start);}
    return null;
  }
  const start=Math.max(0,token.from-limit),matches=[...blank(doc.sliceString(start,token.from)).matchAll(TOKEN)].filter(m=>m[2]===token.name);let depth=0;
  for(let i=matches.length-1;i>=0;i--){if(matches[i][1]==='end')depth++;else if(depth--===0)return make(matches[i],start);}
  return null;
}

/**
 * The extension. `allowSpan(from, to, state)` may refuse a pair (Reviewing refuses one that would
 * cross another author's suggestion). Read-only editors, undo, redo and remote changes are left alone.
 */
export function environmentPairing({allowSpan=()=>true}={}){
  return EditorState.transactionFilter.of(tr=>{
    if(!tr.docChanged||tr.startState.readOnly||tr.annotation(pairedEnvironmentEdit))return tr;
    if(!tr.isUserEvent('input')&&!tr.isUserEvent('delete'))return tr;
    const doc=tr.startState.doc,changes=[];
    tr.changes.iterChanges((fromA,toA,_fromB,_toB,inserted)=>changes.push({fromA,toA,text:inserted.toString()}));
    if(changes.length>16)return tr;
    const tokens=new Map();
    for(const change of changes){
      const token=environmentTokenAt(doc,change.fromA,change.toA);if(!token)continue;
      if(!tokens.has(token.nameFrom))tokens.set(token.nameFrom,{token,changes:[]});
      tokens.get(token.nameFrom).changes.push(change);
    }
    const extra=[];
    for(const {token,changes:inside} of tokens.values()){
      let name=token.name;
      for(const change of [...inside].reverse())name=name.slice(0,change.fromA-token.nameFrom)+change.text+name.slice(change.toA-token.nameFrom);
      if(name===token.name||!VALID.test(name))continue;
      const partner=matchingEnvironment(doc,token);
      if(!partner||changes.some(c=>c.fromA<=partner.nameTo&&c.toA>=partner.nameFrom))continue;
      if(!allowSpan(Math.min(token.nameFrom,partner.nameFrom),Math.max(token.nameTo,partner.nameTo),tr.startState))continue;
      extra.push({from:tr.changes.mapPos(partner.nameFrom,-1),to:tr.changes.mapPos(partner.nameTo,1),insert:name});
    }
    return extra.length?[tr,{changes:extra,sequential:true,annotations:pairedEnvironmentEdit.of(true)}]:tr;
  });
}
