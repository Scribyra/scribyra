// Line diffs and three-way merges (docs/plugins.md, docs/git-sync.md). Pure: no DOM,
// storage or network. The host uses `editHunks` to turn a plugin's whole-file change into
// reviewable suggestions in Reviewing; the GitHub and GitLab plugin bundles this module
// for its pull and push diffs and for merging local and remote edits of the same file.
//
// Lines keep their terminators, so joining them gives back the exact text, including
// "\r\n" endings and a last line without a newline.

/** Splits text into lines that keep their "\n" (or "\r\n"). */
export function splitLines(text){
  if(!text)return [];
  const lines=[];let start=0;
  for(;;){const at=text.indexOf('\n',start);if(at<0){if(start<text.length)lines.push(text.slice(start));break;}lines.push(text.slice(start,at+1));start=at+1;}
  return lines;
}

// Myers' O(ND) difference algorithm over lines. Beyond MAX_EDITS the result falls back
// to one replaced block between the common prefix and suffix: still correct, only less
// precise, so a pathological file cannot stall the page or the plugin.
const MAX_EDITS=1500;
/**
 * Hunks turning a into b: [{aStart, aEnd, bStart, bEnd}] with half-open line ranges,
 * sorted, non-overlapping, never empty on both sides.
 */
export function diffLines(a,b){
  let start=0;while(start<a.length&&start<b.length&&a[start]===b[start])start++;
  let endA=a.length,endB=b.length;while(endA>start&&endB>start&&a[endA-1]===b[endB-1]){endA--;endB--;}
  const x=a.slice(start,endA),y=b.slice(start,endB);
  if(!x.length&&!y.length)return [];
  if(!x.length||!y.length)return [{aStart:start,aEnd:endA,bStart:start,bEnd:endB}];
  const n=x.length,m=y.length,max=Math.min(n+m,MAX_EDITS),offset=max+1;
  const v=new Int32Array(2*max+3),trace=[];let found=-1;
  for(let d=0;d<=max&&found<0;d++){
    // Only the diagonals -d…d can be read back for step d, so keep just that window:
    // memory grows with the number of edits squared, at most about 9 MB.
    trace.push(v.slice(offset-d-1,offset+d+2));
    for(let k=-d;k<=d;k+=2){
      let i=k===-d||(k!==d&&v[offset+k-1]<v[offset+k+1])?v[offset+k+1]:v[offset+k-1]+1,j=i-k;
      while(i<n&&j<m&&x[i]===y[j]){i++;j++;}
      v[offset+k]=i;
      if(i>=n&&j>=m){found=d;break;}
    }
  }
  if(found<0)return [{aStart:start,aEnd:endA,bStart:start,bEnd:endB}];
  // Walk back through the saved frontiers to recover the edit script.
  const steps=[];let i=n,j=m;
  for(let d=found;d>0;d--){
    const window=trace[d],at=index=>window[index+d+1],k=i-j;
    const down=k===-d||(k!==d&&at(k-1)<at(k+1));
    const prevK=down?k+1:k-1,prevI=at(prevK),prevJ=prevI-prevK;
    while(i>prevI&&j>prevJ){i--;j--;}
    if(down){j--;steps.push({type:'insert',i,j});}else{i--;steps.push({type:'delete',i,j});}
    i=prevI;j=prevJ;
  }
  steps.reverse();
  const hunks=[];
  for(const step of steps){
    const last=hunks.at(-1);
    const ai=start+step.i,bj=start+step.j;
    if(last&&last.aEnd===ai&&last.bEnd===bj){if(step.type==='delete')last.aEnd++;else last.bEnd++;}
    else hunks.push(step.type==='delete'?{aStart:ai,aEnd:ai+1,bStart:bj,bEnd:bj}:{aStart:ai,aEnd:ai,bStart:bj,bEnd:bj+1});
  }
  return hunks;
}

/**
 * Display lines for a diff from `before` to `after` with `context` unchanged lines
 * around each change: [{kind: 'context'|'removed'|'added'|'gap', text, old, new}].
 * At most `limit` lines; `truncated` says whether more were left out.
 */
export function displayDiff(before,after,{context=3,limit=400}={}){
  const a=splitLines(before),b=splitLines(after),hunks=diffLines(a,b),lines=[];let truncated=false,added=0,removed=0;
  const push=line=>{if(lines.length>=limit){truncated=true;return false;}lines.push(line);return true;};
  const strip=text=>text.replace(/\r?\n$/,'');
  let shownA=0;
  for(let h=0;h<hunks.length;h++){
    const hunk=hunks[h];added+=hunk.bEnd-hunk.bStart;removed+=hunk.aEnd-hunk.aStart;
    if(truncated)continue;
    const from=Math.max(shownA,hunk.aStart-context);
    if(from>shownA||(h===0&&from>0))push({kind:'gap',text:`${from-shownA} unchanged ${from-shownA===1?'line':'lines'}`,old:null,new:null});
    const shift=hunk.bStart-hunk.aStart;
    for(let i=from;i<hunk.aStart&&!truncated;i++)push({kind:'context',text:strip(a[i]),old:i+1,new:i+1+shift});
    for(let i=hunk.aStart;i<hunk.aEnd&&!truncated;i++)push({kind:'removed',text:strip(a[i]),old:i+1,new:null});
    for(let j=hunk.bStart;j<hunk.bEnd&&!truncated;j++)push({kind:'added',text:strip(b[j]),old:null,new:j+1});
    const next=hunks[h+1],until=Math.min(a.length,hunk.aEnd+context,next?next.aStart:Infinity),after=hunk.bEnd-hunk.aEnd;
    for(let i=hunk.aEnd;i<until&&!truncated;i++)push({kind:'context',text:strip(a[i]),old:i+1,new:i+1+after});
    shownA=until;
  }
  if(!truncated&&hunks.length&&shownA<a.length)push({kind:'gap',text:`${a.length-shownA} unchanged ${a.length-shownA===1?'line':'lines'}`,old:null,new:null});
  return {lines,truncated,added,removed};
}

/**
 * Character edits turning `before` into `after`, one per changed block of lines:
 * [{start, end, before, after}] with offsets into `before`, in order. Reviewing turns each
 * into its own suggestion, so a reviewer can accept a pull line block by line block.
 */
export function editHunks(before,after){
  const a=splitLines(before),b=splitLines(after),offsets=[0];
  for(const line of a)offsets.push(offsets.at(-1)+line.length);
  return diffLines(a,b).map(hunk=>({start:offsets[hunk.aStart],end:offsets[hunk.aEnd],before:a.slice(hunk.aStart,hunk.aEnd).join(''),after:b.slice(hunk.bStart,hunk.bEnd).join('')}));
}

/**
 * A three-way merge of lines (diff3). `base` is the last synced version, `mine` the local
 * one and `theirs` the remote one. Changes on one side only are taken; the same change on
 * both sides is taken once; different changes to overlapping (or touching) lines are a
 * conflict. Returns {clean, conflicts, text} where `text` marks each conflict:
 *
 *   <<<<<<< mine / ||||||| base / ======= / >>>>>>> theirs
 */
export function merge3(base,mine,theirs,{labels={mine:'mine',base:'base',theirs:'theirs'}}={}){
  const o=splitLines(base),a=splitLines(mine),b=splitLines(theirs);
  const hunks=[...diffLines(o,a).map(h=>({...h,side:'a'})),...diffLines(o,b).map(h=>({...h,side:'b'}))].sort((x,y)=>x.aStart-y.aStart||x.aEnd-y.aEnd);
  const out=[];let conflicts=0,at=0,i=0;
  // One side's lines for the base range [lo, hi) of a region holding its hunks `list`.
  const side=(lines,list,lo,hi)=>{const first=list[0],last=list.at(-1);return lines.slice(first.bStart-(first.aStart-lo),last.bEnd+(hi-last.aEnd));};
  while(i<hunks.length){
    // A region: hunks whose base ranges overlap or touch. Hunks of one side never touch
    // each other, so touching means both sides changed neighbouring lines, as Git treats it.
    let lo=hunks[i].aStart,hi=hunks[i].aEnd;const region=[hunks[i++]];
    while(i<hunks.length&&hunks[i].aStart<=hi){hi=Math.max(hi,hunks[i].aEnd);region.push(hunks[i++]);}
    out.push(...o.slice(at,lo));
    const ofA=region.filter(h=>h.side==='a'),ofB=region.filter(h=>h.side==='b');
    const textA=ofA.length?side(a,ofA,lo,hi):o.slice(lo,hi),textB=ofB.length?side(b,ofB,lo,hi):o.slice(lo,hi);
    if(!ofB.length)out.push(...textA);
    else if(!ofA.length)out.push(...textB);
    else if(textA.join('')===textB.join(''))out.push(...textA);
    else{
      conflicts++;
      const ending=lines=>lines.length&&!/\n$/.test(lines.at(-1))?[...lines.slice(0,-1),lines.at(-1)+'\n']:lines;
      out.push(`<<<<<<< ${labels.mine}\n`,...ending(textA),`||||||| ${labels.base}\n`,...ending(o.slice(lo,hi)),'=======\n',...ending(textB),`>>>>>>> ${labels.theirs}\n`);
    }
    at=hi;
  }
  out.push(...o.slice(at));
  return {clean:conflicts===0,conflicts,text:out.join('')};
}
