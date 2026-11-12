// Serialized into the pinned Biber loader. Observe its existing ArrayBuffer,
// without making a second read/copy or inspecting input, output, URLs or errors.
export async function scribyraRuntimeDownload(work,observe){
 let span;try{span=observe?.('download');}catch{}
 const end=(...args)=>{try{span?.end(...args);}catch{}};
 try{const bytes=await work();end('success',undefined,[{name:'bytes',value:bytes.byteLength}]);return bytes;}
 catch(error){let cancelled=false;try{cancelled=error?.name==='AbortError';}catch{}end(cancelled?'cancelled':'failure',cancelled?undefined:'network');throw error;}
}
export function patchRuntimeDownload(source){
 const begin='// BEGIN SCRIBYRA RUNTIME DOWNLOAD',end='// END SCRIBYRA RUNTIME DOWNLOAD';
 if(source.startsWith(begin)){const stop=source.indexOf(end);if(stop<0)throw new Error('Invalid runtime download patch.');source=source.slice(stop+end.length).replace(/^\n/,'');}
 const before='processPackageData(await fetchRemotePackage(REMOTE_PACKAGE_NAME, REMOTE_PACKAGE_SIZE));';
 const after='processPackageData(await scribyraRuntimeDownload(() => fetchRemotePackage(REMOTE_PACKAGE_NAME, REMOTE_PACKAGE_SIZE), Module.scribyraObserve));';
 if(source.includes(before))source=source.replace(before,after);else if(!source.includes(after))throw new Error('Unexpected runtime download framing.');
 return begin+'\n'+scribyraRuntimeDownload.toString()+'\n'+end+'\n'+source;
}
