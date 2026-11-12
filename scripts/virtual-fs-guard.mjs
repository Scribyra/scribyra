// The bundled engine rejects ../ textually even when it stays inside a project.
// With openout_any=r, enforce normalized virtual-filesystem write boundaries here.
// This function is embedded verbatim in the pinned classic-script worker wrapper.
export function scribyraProjectWrites(Module, projectDir, cacheDir, run, seedFonts=false) {
  const FS=Module.FS,originals=new Map();
  // This WASM distribution ships a prebuilt font database. Preserve it when
  // selecting a writable scratch cache; rebuilding it is not supported here.
  if(seedFonts&&!Module.scribyraFontCacheSeeded) {
    const copy=(from,to)=>{
      if(!FS.analyzePath(from).exists)return;
      if(FS.isDir(FS.stat(from).mode)) {
        if(!FS.analyzePath(to).exists)FS.mkdir(to);
        for(const entry of FS.readdir(from))if(entry!=='.'&&entry!=='..')copy(from+'/'+entry,to+'/'+entry);
      }else FS.writeFile(to,FS.readFile(from),{canOwn:true});
    };
    copy(cacheDir+'/luatex-cache','/tmp/luatex-cache');Module.scribyraFontCacheSeeded=true;
  }
  function absolute(path) {
    if(typeof path!=='string')path=FS.getPath(path);
    const parts=[];
    for(const part of (path.startsWith('/')?path:FS.cwd()+'/'+path).split('/')) {
      if(part==='..')parts.pop();else if(part&&part!=='.')parts.push(part);
    }
    return '/'+parts.join('/');
  }
  function canonical(path,depth=0) {
    if(depth>40)throw new FS.ErrnoError(2);
    const name=absolute(path);
    try{return FS.lookupPath(name,{follow:true}).path;}
    catch(error) {
      if(error.errno!==44)throw error; // ENOENT: writes may create a new leaf.
      try {
        const node=FS.lookupPath(name,{follow:false}).node;
        if(FS.isLink(node.mode))return canonical(FS.readlink(name),depth+1);
      }catch(inner){if(inner.errno!==44)throw inner;}
      const slash=name.lastIndexOf('/'),parent=name.slice(0,slash)||'/';
      const resolved=FS.lookupPath(parent,{follow:true}).path;
      return resolved.replace(/\/$/,'')+name.slice(slash);
    }
  }
  const roots=[absolute(projectDir),'/tmp'];
  const devices=new Set(['/dev/null','/dev/tty','/dev/tty1','/dev/stdout','/dev/stderr']);
  function allowed(path) {
    const resolved=canonical(path);
    if(!devices.has(resolved)&&!roots.some(root=>resolved===root||resolved.startsWith(root+'/')))throw new FS.ErrnoError(2);
  }
  function wrap(name,check) {
    const original=FS[name];if(typeof original!=='function')return;
    originals.set(name,original);FS[name]=function(...args){check(...args);return original.apply(this,args);};
  }
  const open=FS.open;originals.set('open',open);
  FS.open=function(path,flags,...args){
    if(typeof flags==='string'?flags!=='r':(flags&(3|64|512|1024))!==0)allowed(path);
    const stream=open.call(this,path,flags,...args);
    if(Module.scribyraInputs && (typeof flags==='string'?flags.includes('r')||flags.includes('+'):(flags&3)!==1)){
      try{const resolved=canonical(path);if(resolved.startsWith(roots[0]+'/')){
        if(resolved.length<=512&&Module.scribyraInputs.size<2048)Module.scribyraInputs.add(resolved);else Module.scribyraInputsTruncated=true;
      }}catch{} // Evidence collection must not change engine I/O behavior.
    }
    return stream;
  };
  for(const name of ['mknod','mkdir','rmdir','unlink','chmod','lchmod','chown','lchown','truncate','utime'])wrap(name,path=>allowed(path));
  wrap('rename',(from,to)=>{allowed(from);allowed(to);});
  wrap('symlink',(target,path)=>{allowed(path);allowed(target.startsWith('/')?target:absolute(path).slice(0,absolute(path).lastIndexOf('/')+1)+target);});
  try{return run();}finally{for(const [name,original]of originals)FS[name]=original;}
}
