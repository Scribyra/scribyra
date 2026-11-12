const failure=(code,message)=>Object.assign(new Error(message),{code});
const boundary=(text,at)=>at>0&&at<text.length&&/[\uD800-\uDBFF]/.test(text[at-1])&&/[\uDC00-\uDFFF]/.test(text[at]);
export function sourceChunk(text,offset,limit){
 if(offset>text.length||boundary(text,offset))throw failure('invalid_request','The read offset is outside the file or splits a UTF-16 surrogate pair.');
 let end=Math.min(text.length,offset+limit);if(boundary(text,end))end--;if(end===offset&&offset<text.length)throw failure('invalid_request','Increase the chunk limit to include the complete UTF-16 surrogate pair.');
 return{content:text.slice(offset,end),offset,nextOffset:end,eof:end===text.length};
}
export function projectBuildResult(result,projectId){
 if(result?.projectId!==projectId)return null;
 return Object.fromEntries(['success','jobId','projectId','sourceRevision','engine','bytes','durationMs','diagnostic','errorType','report'].map(key=>[key,result[key]]));
}
