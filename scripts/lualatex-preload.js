// Scribyra loader for a verified, content-addressed LuaLaTeX baseline.
// The LZ4 package API belongs to Emscripten; no filesystem implementation is copied.
(function(info){
  BusytexPipeline.preRun.push(function(Module){
    const dependency='scribyra-lualatex-'+info.sha256;
    Module.addRunDependency(dependency);
    const observe=operation=>{let span;try{span=Module.scribyraObserve?.(operation);}catch{}return(...args)=>{try{span?.end(...args);}catch{}};};
    const download=observe('download');let verify,category='network';
    (async()=>{
      const response=await fetch(typeof Module.locateFile==='function'?Module.locateFile(info.dataFile,''):new URL(info.dataFile,self.location.href).href,{credentials:'same-origin'});
      if(!response.ok)throw new Error('LuaLaTeX baseline download failed (HTTP '+response.status+').');
      if(!response.body)throw new Error('LuaLaTeX baseline has no body.');
      const bytes=new Uint8Array(info.size),reader=response.body.getReader();let offset=0,last=0;
      try{for(;;){const{done,value}=await reader.read();if(done)break;if(offset+value.length>bytes.length){category='integrity';throw new Error('LuaLaTeX baseline exceeds its manifest size.');}bytes.set(value,offset);offset+=value.length;const now=performance.now();if(now-last>100||offset===bytes.length){last=now;Module.setStatus('Downloading data... ('+offset+'/'+bytes.length+')');}}}
      catch(error){await reader.cancel().catch(()=>{});throw error;}
      if(offset!==bytes.length){category='integrity';throw new Error('LuaLaTeX baseline was truncated.');}
      download('success',undefined,[{name:'bytes',value:offset}]);verify=observe('verify');
      const hash=[...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(byte=>byte.toString(16).padStart(2,'0')).join('');
      if(hash!==info.sha256)throw new Error('LuaLaTeX baseline checksum differs from the manifest.');
      verify('success',undefined,[{name:'bytes',value:offset}]);
      Module.LZ4.loadPackage({metadata:{files:info.files},compressedData:{...info.compressed,data:bytes}},false);
      Module.setStatus('All downloads complete.');Module.removeRunDependency(dependency);
    })().catch(error=>{download('failure',category);verify?.('failure','integrity');self.postMessage({exception:error.message||String(error)});});
  });
})(__SCRIBYRA_BASELINE__);
