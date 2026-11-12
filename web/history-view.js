// Pure presentation helpers for the History view. Nothing here decides what can be restored.
const MAX_ROWS=1500;
export const bytesLabel=size=>{
  if(!Number.isFinite(size))return '';
  if(size<1024)return size+' B';
  if(size<1024*1024)return (size/1024).toFixed(size<10240?1:0)+' KB';
  return (size/1024/1024).toFixed(1)+' MB';
};
const MAX_WORD_TOKENS=1500;
const tokens=text=>text.match(/\n|[\p{L}\p{N}_]+|[^\S\n]+|[^\p{L}\p{N}_\s]/gu)||[];
/** Longest common token subsequence, marking which tokens on each side are unchanged. */
function commonTokens(a,b){
  const width=b.length+1,table=new Uint16Array((a.length+1)*width);
  for(let i=a.length-1;i>=0;i--)for(let j=b.length-1;j>=0;j--)table[i*width+j]=a[i]===b[j]?table[(i+1)*width+j+1]+1:Math.max(table[(i+1)*width+j],table[i*width+j+1]);
  const keepA=new Uint8Array(a.length),keepB=new Uint8Array(b.length);let i=0,j=0;
  while(i<a.length&&j<b.length){
    if(a[i]===b[j]){keepA[i++]=1;keepB[j++]=1;}
    else if(table[(i+1)*width+j]>=table[i*width+j+1])i++;
    else j++;
  }
  return[keepA,keepB];
}
/** Give each row its text as unchanged and changed segments, merging neighbours; whitespace between two changes reads as changed. */
function assign(rows,list,keep){
  let row=0,segments=[];
  const push=(text,changed)=>{const last=segments.at(-1);if(last?.changed===changed)last.text+=text;else segments.push({text,changed});};
  const finish=()=>{rows[row].segments=segments;segments=[];row++;};
  list.forEach((token,index)=>{
    if(token==='\n'){finish();return;}
    const blank=!token.trim(),changed=!keep[index]||(blank&&keep[index]&&!keep[index-1]&&!keep[index+1]&&list[index-1]!=='\n'&&list[index+1]!=='\n'&&index>0&&index<list.length-1);
    push(token,changed);
  });
  finish();
}
/** Small edits highlight only the words that changed, even when a line was split or joined. Mostly rewritten text is shown whole. */
function emphasise(run){
  const removed=run.filter(row=>row.kind==='delete'),added=run.filter(row=>row.kind==='add');
  const whole=()=>run.forEach(row=>{row.segments=[{text:row.text,changed:true}];});
  if(removed.length&&added.length){
    const a=tokens(removed.map(row=>row.text).join('\n')),b=tokens(added.map(row=>row.text).join('\n'));
    if(a.length<=MAX_WORD_TOKENS&&b.length<=MAX_WORD_TOKENS){
      const [keepA,keepB]=commonTokens(a,b),weight=(list,keep)=>list.reduce((sum,token,index)=>sum+(keep[index]&&token.trim()?token.length:0),0),size=list=>list.reduce((sum,token)=>sum+(token.trim()?token.length:0),0);
      if(weight(a,keepA)*2>=Math.min(size(a),size(b))){assign(removed,a,keepA);assign(added,b,keepB);run.forEach(row=>{delete row.text;});return;}
    }
  }
  whole();run.forEach(row=>{delete row.text;});
}
/** Turn a unified patch into display rows with both line numbers. */
export function parsePatch(patch){
  const rows=[];let additions=0,deletions=0,oldLine=0,newLine=0,previousEnd=1,run=[],started=false,truncated=false;
  const flush=()=>{if(run.length){emphasise(run);run=[];}};
  for(const line of patch.split('\n')){
    if(rows.length>=MAX_ROWS){truncated=true;break;}
    const hunk=/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if(hunk){
      flush();started=true;oldLine=Number(hunk[1]);newLine=Number(hunk[2]);
      const hidden=Math.max(0,oldLine-previousEnd);
      if(hidden)rows.push({kind:'gap',label:hidden===1?'1 unchanged line':hidden+' unchanged lines'});
      continue;
    }
    if(!started||line.startsWith('\\'))continue;
    const marker=line[0],text=line.slice(1);
    if(marker==='-'){rows.push({kind:'delete',oldLine:String(oldLine++),text});run.push(rows.at(-1));deletions++;previousEnd=oldLine;}
    else if(marker==='+'){rows.push({kind:'add',newLine:String(newLine++),text});run.push(rows.at(-1));additions++;}
    else if(marker===' '){flush();rows.push({kind:'context',oldLine:String(oldLine++),newLine:String(newLine++),segments:[{text,changed:false}]});previousEnd=oldLine;}
  }
  flush();
  return{rows,additions,deletions,truncated};
}
/** Whole-file rows for an added or deleted file whose patch was too large to include. */
export function wholeFileRows(text,kind){
  const lines=text.replace(/\n$/,'').split('\n'),shown=lines.slice(0,MAX_ROWS);
  return{total:lines.length,rows:shown.map((line,index)=>({kind,[kind==='add'?'newLine':'oldLine']:String(index+1),segments:[{text:line,changed:true}]}))};
}
/** Collapse one change per concern into one row per file. */
export function fileChanges(result,beforeNodes,afterNodes){
  const files=new Map();
  for(const change of result.changes){
    if(!change.fileId)continue;
    const before=beforeNodes.get(change.fileId),after=afterNodes.get(change.fileId);
    if((before||after)?.folder)continue;
    if(!files.has(change.fileId))files.set(change.fileId,{fileId:change.fileId,path:after?.path||change.toPath||before?.path||change.fromPath||change.fileId,fromPath:'',status:'edited',binary:!!(before||after)?.binary,additions:0,deletions:0,large:false,lineDiff:null,asset:null,textChanged:false});
    const file=files.get(change.fileId);
    if(change.kind==='add')file.status='added';
    else if(change.kind==='delete')file.status='deleted';
    else if(change.kind==='rename'){file.fromPath=change.fromPath;if(file.status==='edited')file.status='renamed';}
    else if(change.kind==='text'){file.textChanged=true;file.lineDiff=change.lineDiff;file.large=!!change.truncated;if(!change.truncated&&change.lineDiff){const parsed=parsePatch(change.lineDiff);file.additions=parsed.additions;file.deletions=parsed.deletions;}}
    else if(change.kind==='asset')file.asset={before:change.before||null,after:change.after||null};
  }
  return[...files.values()].sort((a,b)=>a.path.localeCompare(b.path));
}
const filesLabel=count=>count===1?'1 file changed':count+' files changed';
export function summaryOf(files,others=[]){
  if(files.length)return filesLabel(files.length);
  return others[0]||'Same files as the version before';
}
const initialsOf=name=>{
  const words=String(name||'').trim().split(/\s+/).filter(Boolean);
  if(!words.length)return '?';
  return (words.length>1?[words[0],words.at(-1)]:[words[0]]).map(word=>[...word][0]).join('').toUpperCase();
};
export function authorChip(id,name){
  let hash=0;for(const char of String(id))hash=(hash*31+char.charCodeAt(0))>>>0;
  return{id:String(id),name:name||'Unknown author',initials:name?initialsOf(name):'?',tone:String(hash%6)};
}
const pad=value=>String(value).padStart(2,'0');
const dayKey=date=>date.getFullYear()+'-'+pad(date.getMonth()+1)+'-'+pad(date.getDate());
export function dayLabel(timestamp,now=Date.now()){
  if(!timestamp)return{key:'unknown',label:'Date unknown'};
  const date=new Date(timestamp),today=new Date(now),yesterday=new Date(now);yesterday.setDate(today.getDate()-1);
  const key=dayKey(date);
  if(key===dayKey(today))return{key,label:'Today'};
  if(key===dayKey(yesterday))return{key,label:'Yesterday'};
  const options={weekday:'short',day:'numeric',month:'short'};
  if(date.getFullYear()!==today.getFullYear())options.year='numeric';
  return{key,label:date.toLocaleDateString(undefined,options)};
}
export const timeLabel=timestamp=>timestamp?new Date(timestamp).toLocaleTimeString(undefined,{hour:'numeric',minute:'2-digit'}):'';
export const whenLabel=timestamp=>timestamp?dayLabel(timestamp).label+', '+timeLabel(timestamp):'an unknown date';
export function groupByDay(entries){
  const groups=[];
  for(const entry of entries){
    if(groups.at(-1)?.key!==entry.dayKey)groups.push({key:entry.dayKey,label:entry.dayLabel,entries:[]});
    groups.at(-1).entries.push(entry);
  }
  return groups;
}
/** Friendly wording for what a current-project restore does to one file. */
export function restoreLine(file){
  if(file.status==='added')return'Comes back from this version';
  if(file.status==='deleted')return'Removed, because this version does not have it';
  if(file.status==='renamed')return'Renamed back from '+file.fromPath+(file.textChanged?', and its text goes back':'');
  if(file.binary)return'Replaced by the file in this version';
  return'Text goes back to this version';
}
/** A plain size comparison, for example "40 B smaller". */
export function sizeChange(before,after){
  const change=after-before;
  return change===0?'Same size':bytesLabel(Math.abs(change))+(change>0?' larger':' smaller');
}
