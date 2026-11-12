// Host-controlled Biber input staging. Keep project paths and the main directory
// instead of flattening bibliography filenames into a shared temporary folder.
export function scribyraBiberProject(FS,workDir,controlPath,files){
 const root=workDir.replace(/\/$/,'')+'/project',seen=new Set();let total=0;
 const path=value=>{
  if(typeof value!=='string'||value.length>1024||value.startsWith('/')||value.split('/').some(part=>!part||part==='.'||part==='..')||/[\\:\x00-\x1f\x7f]/.test(value))throw new Error('Unsafe Biber project input path.');
  return root+'/'+value;
 };
 const control=path(controlPath);
 if(files.length>10000)throw new Error('Too many Biber input files.');
 const prepared=files.map(({path:name,contents})=>{
  const target=path(name),bytes=typeof contents==='string'?new TextEncoder().encode(contents):contents;
  if(seen.has(target)||!(bytes instanceof Uint8Array)||bytes.length>32*1024*1024||(total+=bytes.length)>128*1024*1024)throw new Error('Biber input files are duplicate, invalid or exceed their memory budget.');
  seen.add(target);return{target,bytes};
 });
 if(!seen.has(control))throw new Error('Biber control file is missing.');
 for(const{target,bytes}of prepared){FS.mkdirTree(target.slice(0,target.lastIndexOf('/')));FS.writeFile(target,bytes);}
 FS.chdir(control.slice(0,control.lastIndexOf('/')));
 return{controlFile:controlPath.slice(controlPath.lastIndexOf('/')+1),outputFile:control.replace(/\.bcf$/i,'.bbl')};
}
