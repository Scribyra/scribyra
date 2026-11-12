import {cachedMetadataUsage,cacheSettings,updateCacheSettings,interruptedDownloads,clearInterruptedDownloads,removeInterruptedDownload} from './tex-cache.js';
import {downloads} from './downloads.js';
import {prepareRuntime,runtimeStatus,clearRuntime} from './runtime-assets.js';
import {restoreDialogFocus} from './input.js';
import {texPackages,cachedPackages,removeCachedArchive,clearPackageCache} from './tex-packages.js';
import {TEX_RUNTIME,TEX_ASSETS,MAX_BUNDLE_BYTES,environmentJson,packageLabel} from './tex-environment.js';
const mib=bytes=>`${(bytes/1048576).toFixed(2)} MiB`;
function dependencyDetails(pkg){
 if(!pkg?.dependencyProvenance||!Array.isArray(pkg.dependencies))return null;
 const details=document.createElement('details'),summary=document.createElement('summary'),body=document.createElement('p'),source=pkg.dependencyProvenance;
 summary.textContent=`Declared dependencies of ${source.package} r${source.revision}`;
 body.textContent=(pkg.dependencies.length?pkg.dependencies.join(', '):'No upstream dependencies declared.')+' These declarations are not a minimal compilation environment; TeX can request more files while compiling.';
 if(pkg.requires?.length)body.textContent+=` Tested runtime prerequisites: ${pkg.requires.join(', ')}.`;
 details.append(summary,body);return details;
}
function chooseFile(accept){return new Promise(resolve=>{const input=document.createElement('input');input.type='file';input.accept=accept;input.onchange=()=>resolve(input.files[0]);input.oncancel=()=>resolve(null);input.click();});}
export function environmentDialog({signal,getState,setLock,download}){
 return new Promise(resolve=>{
  let closed=false,busy=false,ready=false,operation,offline=null;
  const dialog=document.createElement('dialog');dialog.className='modal tex-environment';dialog.setAttribute('aria-label','TeX environment');restoreDialogFocus(dialog);
  const heading=document.createElement('h2');heading.textContent='TeX environment';
  const help=document.createElement('p');help.textContent='Lock the compiler and supplemental package versions after a successful build. Package caches can be removed without deleting your sources. A package bundle contains public TeX archives and verified metadata, not project files or the compiler runtime.';
  const indicator=document.createElement('p');indicator.className='offline-indicator';indicator.setAttribute('aria-live','polite');
  const summary=document.createElement('p'),packages=document.createElement('div');packages.className='environment-packages';
  const status=document.createElement('p');status.setAttribute('role','status');status.setAttribute('aria-live','polite');
  const actions=document.createElement('div');actions.className='modal-actions';const buttons=[];
  const limits=document.createElement('fieldset'),legend=document.createElement('legend');limits.className='environment-limits';legend.textContent='Cache limits on this device';limits.append(legend);const inputs=new Map();
  for(const[key,label]of [['archiveBytes','Package archives (MiB)'],['metadataBytes','Metadata (MiB)'],['runtimeBytes','Compiler runtime (MiB)'],['partialBytes','Interrupted downloads (MiB)']]){const row=document.createElement('label'),input=document.createElement('input');row.textContent=label;input.type='number';input.disabled=true;input.required=true;input.min='0';input.step='1';input.max=String(downloads.policy.maximum[key]/1048576);input.className='input';input.setAttribute('aria-label',label);row.append(input);limits.append(row);inputs.set(key,input);}
  const limitHelp=document.createElement('p');limitHelp.textContent='Zero disables a cache. Lower limits can remove cached compiler data; project sources and history are separate.';limits.append(limitHelp);
  const partialList=document.createElement('details'),partialTitle=document.createElement('summary');partialList.append(partialTitle);
  const button=(label,handler)=>{const node=document.createElement('button');node.type='button';node.className='button secondary';node.textContent=label;node.onclick=handler;node.disabled=true;buttons.push(node);actions.append(node);return node;};
  function finish(){if(closed)return;closed=true;operation?.abort();signal?.removeEventListener('abort',finish);dialog.close();dialog.remove();resolve();}
  const progress=message=>{if(!closed)status.textContent=message;};
  async function refresh(){
   if(closed)return;for(const button of buttons)button.disabled=busy||!ready;let state;try{state=getState();}catch(error){progress(error.message);return;}let entries;
   try{entries=await cachedPackages();}catch{progress('Package cache is unavailable on this device.');entries=[];}
   if(closed)return;
   let metadata,settings,runtimeUsage,partials;try{metadata=await cachedMetadataUsage();settings=await cacheSettings();partials=await interruptedDownloads();}catch{metadata={count:0,bytes:0};settings=downloads.policy.defaults;partials=[];}try{runtimeUsage=await downloads.pruneRuntime();}catch{runtimeUsage={bytes:0};}if(closed)return;
   ready=true;for(const button of buttons)button.disabled=busy;
   for(const[key,input]of inputs){input.value=String(settings[key]/1048576);input.disabled=busy;}
   partialTitle.textContent=`Interrupted downloads (${partials.length})`;partialList.replaceChildren(partialTitle);
   for(const item of partials){const row=document.createElement('div'),text=document.createElement('span'),remove=document.createElement('button');row.className='environment-cache-row';text.textContent=`${item.label} · ${mib(item.length)} / ${mib(item.size)}`;remove.type='button';remove.className='button secondary compact';remove.textContent='Discard';remove.disabled=busy;remove.setAttribute('aria-label',`Discard interrupted ${item.label}`);remove.onclick=()=>run('Discarding interrupted download',async()=>{await removeInterruptedDownload(item.id);progress('Interrupted download discarded.');});row.append(text,remove);partialList.append(row);}
   const lock=state.lock,locked=lock!==null,candidate=state.candidate,declared=lock?.packages||candidate?.packages||{};
   const cache=new Map(entries.map(entry=>[entry.hash,entry]));
   const count=Object.values(declared).filter(pkg=>cache.has(pkg.sha512)).length;
   summary.textContent=`${locked?'Locked':'Unlocked'} · ${Object.keys(declared).length} supplemental packages · ${count} cached. Shared archive cache: ${mib(entries.reduce((total,item)=>total+item.size,0))} / ${mib(settings.archiveBytes)}. Metadata: ${metadata.count} records, ${mib(metadata.bytes)} / ${mib(settings.metadataBytes)}. Runtime: ${mib(runtimeUsage.bytes)} / ${mib(settings.runtimeBytes)}. Interrupted: ${mib(partials.reduce((sum,item)=>sum+item.length,0))} / ${mib(settings.partialBytes)}. ${locked?'Compiler, adapter and catalog fingerprints are pinned.':'Compile unchanged sources successfully before locking.'} Cache presence is checked again when packages are loaded; offline compilation also needs the app and compiler assets on this device.`;
   if(!locked)offline=null;indicator.textContent=offline===null?'Offline availability not checked.':offline.ready?'Verified offline for this locked environment.':`Offline preparation needed · ${offline.reason}`;
   prepare.disabled=busy||(!lock&&!candidate);checkOffline.disabled=busy||!lock;clearCompiler.disabled=busy;
   packages.replaceChildren();
   const list=document.createElement('ul');list.setAttribute('aria-label','Supplemental TeX packages');
   for(const [name,pkg]of Object.entries(declared)){
    const item=document.createElement('li'),text=document.createElement('span'),info=cache.get(pkg.sha512)?.package||pkg;text.textContent=`${packageLabel(name,info)} · ${mib(pkg.size)} · ${cache.has(pkg.sha512)?'cached':'not cached'}`;item.append(text);const declared=dependencyDetails(info);if(declared)item.append(declared);list.append(item);
   }
   if(!Object.keys(declared).length){const item=document.createElement('li');item.textContent='No supplemental packages recorded. The bundled TeX baseline is separate.';list.append(item);}
   packages.append(list);
   lockButton.disabled=busy||!candidate;unlockButton.disabled=busy||!locked;cacheButton.disabled=busy||!lock;exportLock.disabled=busy||!lock;exportBundle.disabled=busy||!lock;
   for(const node of [importLock,importBundle,clear])node.disabled=busy;
   const inventory=document.createElement('details'),title=document.createElement('summary');title.textContent=`All cached archives (${entries.length})`;inventory.append(title);
   for(const entry of entries){const row=document.createElement('div');row.className='environment-cache-row';const text=document.createElement('span');text.textContent=entry.package?`${packageLabel(entry.package.name,entry.package)} · ${mib(entry.size)}`:`Unlabelled archive ${String(entry.hash).slice(0,12)}… · ${mib(entry.size)}`;
    const remove=document.createElement('button');remove.type='button';remove.className='button secondary compact';remove.textContent='Remove';remove.setAttribute('aria-label',`Remove cached ${entry.package?.name||entry.hash}`);remove.disabled=busy;remove.onclick=()=>run('Removing cached archive',async()=>{offline=null;await removeCachedArchive(entry.hash);progress('Cached archive removed. Sources and environment locks are unchanged.');});row.append(text,remove);inventory.append(row);}
   packages.append(inventory);
   const runtime=document.createElement('details'),caption=document.createElement('summary');caption.textContent='Compiler and catalog identity';runtime.append(caption);const identity=lock?.runtime||TEX_RUNTIME,fields=document.createElement('dl');
   for(const [label,key]of [['Engine','engine'],['Catalog snapshot','snapshot'],['Compiler archive SHA-256','distributionSha256'],['Adapter SHA-256','adapterSha256'],['Catalog SHA-256','catalogSha256']]){const term=document.createElement('dt'),value=document.createElement('dd'),code=document.createElement('code');term.textContent=label;code.textContent=identity?.[key]||'Unavailable';value.append(code);fields.append(term,value);}if(TEX_ASSETS.compatibility){const compatibility=TEX_ASSETS.compatibility;for(const[label,text]of [['Compiler implementation',`${compatibility.implementation} ${compatibility.implementationVersion}`],['Prebuilt format',compatibility.format.name],['Format SHA-256',compatibility.format.sha256],['Package updates','Pinned compiler release; unlock and review to change environments']]){const term=document.createElement('dt'),value=document.createElement('dd');term.textContent=label;value.textContent=text;fields.append(term,value);}}runtime.append(fields);packages.append(runtime);
  }
  async function run(label,work){
   if(closed||busy)return;busy=true;operation=new AbortController();for(const node of dialog.querySelectorAll('button,input'))if(node!==closeButton&&node!==cancel)node.disabled=true;cancel.disabled=false;progress(label+'…');
   let api;
   try{const state=getState();api=texPackages(operation.signal,progress);await work(api,state,operation.signal);}
   catch(error){progress(error.name==='AbortError'?'Package operation cancelled. Project lock is unchanged.':error.message||String(error));}
   finally{api?.close();busy=false;cancel.disabled=true;await refresh();}
  }
  const lockButton=button('Lock current environment',()=>run('Validating environment',async(api,state,abort)=>{if(!state.candidate)throw new Error('Compile unchanged sources successfully before locking.');const lock=await api.check(state.candidate);abort.throwIfAborted();setLock(lock,state.revision);offline=null;progress('Environment locked. New supplemental dependencies require an explicit unlock.');}));
  const unlockButton=button('Unlock environment',()=>run('Unlocking environment',async(_api,state)=>{setLock(null,state.revision);offline=null;progress('Environment unlocked. Compile again before locking a new package set.');}));
  const cacheButton=button('Cache locked packages',()=>run('Caching locked packages',async(api,state)=>{offline=null;if(!state.lock)throw new Error('Lock an environment first.');const receipts=await api.preload(state.lock);if(receipts.some(p=>!p.saved))throw new Error('Some verified packages could not be saved. Increase the relevant cache limit or free storage before relying on the cache.');progress('All locked supplemental archives are verified and cached. The app and compiler assets must also be available for offline use.');}));
  button('Download catalogue dependency manifest',()=>run('Verifying declared dependency manifest',async(api,_state,abort)=>{const bytes=await api.dependencyGraph();abort.throwIfAborted();download(bytes,'tex-dependencies.json','application/json');progress('Public dependency manifest exported. It contains upstream declarations and tested prerequisites, not project files.');}));
  const exportLock=button('Export environment lock',()=>run('Validating lock',async(api,state)=>{const lock=await api.check(state.lock);download(new TextEncoder().encode(environmentJson(lock)),'tex-environment.lock.json','application/json');progress('Environment lock exported. Source ZIPs remain source-only.');}));
  const importLock=button('Import environment lock',()=>run('Importing lock',async(api,state,abort)=>{const file=await chooseFile('.json');if(!file)return;if(file.size>65536)throw new Error('Environment lock exceeds 64 KiB.');const lock=await api.check(JSON.parse(await file.text()));abort.throwIfAborted();setLock(lock,state.revision);offline=null;progress('Compatible environment lock imported. Cache its packages before going offline.');}));
  const exportBundle=button('Export package bundle',()=>run('Verifying cached package bundle',async(api,state,abort)=>{const bytes=await api.exportBundle(state.lock);abort.throwIfAborted();download(bytes,'tex-packages.scribyra-tex','application/octet-stream');progress('Verified package bundle exported. It includes its lock and supplemental archives; source files and compiler assets are separate.');}));
  const importBundle=button('Import package bundle',()=>run('Verifying package bundle',async(api,state,abort)=>{const file=await chooseFile('.scribyra-tex');if(!file)return;if(file.size>MAX_BUNDLE_BYTES)throw new Error('Package bundle exceeds 120 MiB plus manifest overhead.');const lock=await api.importBundle(new Uint8Array(await file.arrayBuffer()));abort.throwIfAborted();setLock(lock,state.revision);offline=null;progress('Verified package bundle cached and its lock applied to this project.');}));
  const clear=button('Clear TeX package cache',()=>run('Clearing supplemental cache',async()=>{offline=null;await clearPackageCache();progress('Supplemental archives cleared. Sources, history and project locks are unchanged.');}));
  async function checkAvailability(api,state,abort){
    offline=null;const packages=await api.inspectCache(state.lock),runtime=await runtimeStatus(abort);if(getState().revision!==state.revision)throw new Error('Project changed. Check offline availability again.');offline={ready:packages.ready&&runtime.ready,reason:!packages.metadata.ready?`${packages.metadata.missing.length} metadata records are missing or invalid.`:!packages.ready?`${packages.missing.length} package archives are missing or invalid.`:`${runtime.entries.filter(item=>!item.valid).length} compiler assets need preparation.`};progress(offline.ready?'Offline environment verified.':'Offline preparation is incomplete.');
  }
  const prepare=button('Prepare this project for offline use',()=>run('Preparing offline compilation',async(api,state,abort)=>{
    offline=null;const lock=await api.check(state.lock||state.candidate),receipts=await api.preload(lock);if(receipts.some(pkg=>!pkg.saved))throw new Error('Some packages could not be saved. Increase the archive cache limit or free browser storage before preparing offline compilation.');if(!(await api.prepareMetadata(lock)).ready)throw new Error('Required TeX metadata could not be saved. Increase the relevant cache limit or free storage before preparing offline compilation.');await prepareRuntime(abort,progress);if(getState().revision!==state.revision)throw new Error('Project changed. Prepare the current environment again.');if(!state.lock)setLock(lock,state.revision);await checkAvailability(api,{...state,lock,revision:getState().revision},abort);
  }));
  const checkOffline=button('Check offline availability',()=>run('Verifying offline environment',(api,state,abort)=>checkAvailability(api,state,abort)));
  const clearCompiler=button('Clear compiler cache',()=>run('Clearing compiler cache',async(_api,_state,abort)=>{offline=null;const result=await clearRuntime(abort);progress(result.legacyCleared?'Compiler caches cleared. Project sources and package archives are unchanged.':'Compiler assets cleared. Close older Scribyra tabs to release their legacy preload cache.');}));
  button('Apply cache limits',()=>{const next={version:1};for(const[key,input]of inputs){if(!input.checkValidity()){input.reportValidity();return;}next[key]=Number(input.value)*1048576;}return run('Applying cache limits',async()=>{offline=null;await updateCacheSettings(next);const cleared=await downloads.clearLegacyRuntime();progress(cleared?'Cache limits saved on this device. Project sources and locks are unchanged.':'Cache limits saved. Close older Scribyra tabs to release their legacy compiler cache, then apply the limits again.');});});
  button('Discard interrupted downloads',()=>run('Discarding interrupted downloads',async()=>{await clearInterruptedDownloads();progress('Interrupted downloads discarded. Verified package archives and project sources are unchanged.');}));
  const cancel=document.createElement('button');cancel.type='button';cancel.className='button secondary';cancel.textContent='Cancel package operation';cancel.disabled=true;cancel.onclick=()=>operation?.abort();actions.append(cancel);
  const closeButton=document.createElement('button');closeButton.type='button';closeButton.className='button primary';closeButton.textContent='Close';closeButton.onclick=finish;actions.append(closeButton);
  dialog.append(heading,help,summary,indicator,limits,partialList,packages,status,actions);dialog.addEventListener('cancel',event=>{event.preventDefault();finish();});signal?.addEventListener('abort',finish,{once:true});document.body.append(dialog);dialog.showModal();if(signal?.aborted)finish();else void refresh().then(()=>{if(closed)return;try{if(getState().lock)void run('Verifying offline environment',(api,state,abort)=>checkAvailability(api,state,abort));}catch(error){progress(error.message);}});
 });
}
