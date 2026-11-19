// Installed plugins for this browser and the ones running for the open project
// (docs/plugins.md#flows). Plugins run only when installed, enabled, allowed by the
// policy and a project is open; sideloaded ones also need developer mode. Nothing here
// contacts a registry: the official catalog is loaded on demand by the Plugins manager.
import {readPackage,policyDecision,matchesAny,addedPermissions,compareVersions,isOfficialId,PluginError} from './plugin-manifest.js';
import {sha256Hex} from './plugin-registry.js';
import {pluginStore,developerMode} from './plugin-store.js';
import {startPlugin} from './plugin-host.js';

export function pluginSystem({env,policy,notify,changed}){
  let records=new Map(),loading=null,generation=0;
  const instances=new Map();
  const before=[];// work that must finish before plugins start (the Zotero migration)
  function load(){loading||=pluginStore.list().then(list=>{records=new Map(list.map(record=>[record.id,record]));}).catch(()=>{records=new Map();});return loading;}
  const reload=()=>{loading=null;return load();};
  const blockedReason=record=>policyDecision(policy,{id:record.id,version:record.version,sha256:record.sha256,source:record.source,action:'run'})||(record.source==='developer'&&!developerMode()?'Turn on developer mode to run plugins installed from a URL.':'');
  const runnable=record=>record.enabled&&!blockedReason(record);
  let contributions=0,merged=null;
  const update=()=>{contributions++;changed();};

  async function start(record,session){
    const bytes=await pluginStore.packageBytes(record.id,record.version);
    if(!bytes)throw new PluginError('missing_package',`${record.manifest.name} is missing its package. Reinstall it.`);
    // What runs is exactly what the person accepted at install.
    if(await sha256Hex(bytes)!==record.sha256)throw new PluginError('integrity',`${record.manifest.name}'s stored package changed. Reinstall it.`);
    const pkg=readPackage(bytes,{developer:record.source==='developer'});
    if(session!==generation)return;
    const instance=startPlugin({record,pkg,env:{...env,changed:update,onCrash:message=>{instances.delete(record.id);notify(`${record.manifest.name} stopped: ${message}`);update();}}});
    instances.set(record.id,instance);
    const project=env.project();
    instance.event('project.opened',{transient:!!project?.transient});
    instance.event('project.mode',{mode:project?.mode??null});
    instance.event('project.activeFile',{fileId:instance.readableId(project?.activeFileId)});
    update();
  }
  async function startAll(){
    const session=generation;
    await Promise.all(before);await load();
    if(session!==generation||!env.project())return;
    for(const record of records.values())if(runnable(record)&&!instances.has(record.id))await start(record,session).catch(error=>notify(`${record.manifest.name} could not start: ${error.message}`));
  }
  function stop(id){const instance=instances.get(id);if(instance){instances.delete(id);instance.stop();}}
  function stopAll(){for(const id of [...instances.keys()])stop(id);update();}
  async function restart(id){stop(id);await reload();const record=records.get(id);if(record&&runnable(record)&&env.project())await start(record,generation);update();}

  const running=()=>[...instances.values()].filter(instance=>!instance.stopped);
  const recordOf=id=>records.get(id);

  return {
    /** Work (the legacy Zotero migration) that plugins wait for before starting. */
    before(promise){before.push(promise.catch(()=>{}));},
    projectOpened(){generation++;stopAll();return startAll();},
    projectClosed(){generation++;for(const instance of running())instance.event('project.closed',{});stopAll();},
    activeFileChanged(fileId){for(const instance of running())instance.event('project.activeFile',{fileId:instance.readableId(fileId)});},
    modeChanged(mode){for(const instance of running())instance.event('project.mode',{mode});},
    forgetProject:projectId=>pluginStore.forgetProject(projectId).catch(()=>{}),
    running:id=>instances.has(id),
    instance:id=>instances.get(id)||null,

    // Contributions, drawn by the app.
    commands(){
      return running().flatMap(instance=>(recordOf(instance.plugin.id)?.manifest.contributes.commands||[]).map(command=>({plugin:instance.plugin.id,pluginName:instance.plugin.name,id:command.id,label:command.label,hint:command.hint||''})));
    },
    /** Tree menu items for a node (null = the project root). */
    fileActions(node,{mode,blocked=''}){
      const items=[];
      for(const instance of running()){
        for(const action of recordOf(instance.plugin.id)?.manifest.contributes.fileActions||[]){
          const when=action.when,isRoot=!node,isFolder=!!node?.folder;
          if(when.target==='root'&&!isRoot||when.target==='folder'&&!isRoot&&!isFolder||when.target==='file'&&(isRoot||isFolder))continue;
          if(when.target==='file'){const fileId=instance.readableId(node.id);if(!fileId||when.files&&!matchesAny(when.files,node.path)||when.tag&&!instance.decoration(fileId)?.tags.has(when.tag))continue;}
          // Actions limited to some modes are also off while the tree refuses edits.
          const disabled=!action.modes.includes(mode||'editing')||!!blocked&&!action.modes.includes('viewing');
          items.push({label:action.label,value:`plugin:${instance.plugin.id}:${action.id}`,icon:action.icon,hint:action.hint,disabled});
        }
      }
      return items;
    },
    /** The bar above the active file, if a plugin set one. */
    bar(fileId,mode){
      for(const instance of running()){
        const id=instance.readableId(fileId),bar=id?instance.decoration(id)?.bar:null;
        if(bar)return {plugin:instance.plugin.id,label:bar.label,text:bar.text,actions:bar.actions.map(action=>{const blocked=!action.modes.includes(mode||'editing');return {plugin:instance.plugin.id,id:action.id,label:action.label,title:blocked?action.blockedTitle||`Not available in ${mode}`:action.title,disabled:blocked};})};
      }
      return null;
    },
    /** The completion index with citations and names plugins contribute. */
    completionIndex(index){
      if(!index)return index;
      const contributing=running().filter(instance=>instance.citations.length||instance.completions.length);
      if(!contributing.length)return index;
      return Object.create(index,{snapshot:{value(){
        const base=index.snapshot();
        if(merged?.base===base&&merged.version===contributions)return merged.value;
        const byKey=new Map(base.citations.map((citation,i)=>[citation.key,i])),citations=[...base.citations],commands=[...base.commands],environments=[...base.environments];
        for(const instance of contributing){
          for(const entry of instance.citations){
            const at=byKey.get(entry.key);
            if(at!==undefined){if(!citations[at].path.includes(' · '))citations[at]={...citations[at],path:`${citations[at].path} · ${instance.plugin.name}`};}
            else{byKey.set(entry.key,citations.length);citations.push({...entry,path:`${instance.plugin.name} plugin`});}
          }
          for(const item of instance.completions)(item.kind==='command'?commands:environments).push({name:item.name,args:item.args,optional:false,plugin:instance.plugin.name,path:`${instance.plugin.name} plugin`,line:0});
        }
        const value={...base,citations,commands,environments};
        merged={base,version:contributions,value};return value;
      }}});
    },
    async runCommand(pluginId,command){const instance=instances.get(pluginId);if(!instance)throw new Error('That plugin is not running.');return instance.request('command.run',{command});},
    async runFileAction(pluginId,action,{nodeId=null,directory=''}={}){const instance=instances.get(pluginId);if(!instance)throw new Error('That plugin is not running.');return instance.request('fileAction.run',{action,fileId:nodeId?instance.readableId(nodeId):null,directory});},
    async runBarAction(pluginId,action,fileId){const instance=instances.get(pluginId);if(!instance)throw new Error('That plugin is not running.');return instance.request('fileBar.run',{action,fileId:instance.readableId(fileId)});},

    // The manager.
    async installed(){await load();return [...records.values()].sort((a,b)=>a.manifest.name.localeCompare(b.manifest.name)).map(record=>({...record,running:instances.has(record.id),blocked:blockedReason(record)}));},
    blockedReason,
    compare:compareVersions,
    policyReason:candidate=>policyDecision(policy,candidate),
    /** Checks a package before consent; returns what consent needs to show. */
    async prepare(bytes,{source,sourceUrl=null,expected=null}){
      const developer=source==='developer',pkg=readPackage(bytes,{developer}),sha256=await sha256Hex(bytes);
      if(expected&&expected.sha256!==sha256)throw new PluginError('integrity','The plugin package does not match the registry.');
      if(developer&&isOfficialId(pkg.manifest.id))throw new PluginError('reserved_id',`Plugin ids starting with com.scribyra. belong to the official registry; “${pkg.manifest.id}” cannot be installed from a URL.`);
      await load();const existing=records.get(pkg.manifest.id);
      if(existing&&existing.source!==source)throw new PluginError('conflict',`${existing.manifest.name} is already installed from ${existing.source==='official'?'the official registry':'a URL'}. Uninstall it first.`);
      const reason=policyDecision(policy,{id:pkg.manifest.id,version:pkg.manifest.version,sha256,source,action:existing?'update':'install'});
      if(reason)throw new PluginError('policy',reason);
      return {pkg,sha256,source,sourceUrl,existing,added:existing?addedPermissions(existing.granted,pkg.manifest.permissions):pkg.manifest.permissions};
    },
    /** Stores a prepared package the person agreed to, keeping the previous version for rollback. */
    async commit(prepared,bytes){
      const {pkg,sha256,source,sourceUrl,existing}=prepared,now=Date.now();
      const record={id:pkg.manifest.id,version:pkg.manifest.version,manifest:pkg.manifest,sha256,source,sourceUrl,granted:pkg.manifest.permissions,enabled:existing?existing.enabled:true,installedAt:existing?.installedAt||now,updatedAt:now,
        previous:existing&&existing.version!==pkg.manifest.version?{version:existing.version,manifest:existing.manifest,sha256:existing.sha256,granted:existing.granted}:existing?.previous||null};
      // Revoked permissions stay revoked across an update unless the new version asks again.
      if(existing)for(const key of Object.keys(record.granted))if(!existing.granted[key]&&existing.manifest.permissions[key]&&!prepared.added[key])delete record.granted[key];
      await pluginStore.install(record,bytes);
      if(existing?.previous&&record.previous?.version!==existing.previous.version)await pluginStore.deletePackage(record.id,existing.previous.version).catch(()=>{});
      await restart(record.id);return record;
    },
    async rollback(id){
      await load();const record=records.get(id);if(!record?.previous)throw new Error('There is no earlier version to roll back to.');
      const bytes=await pluginStore.packageBytes(id,record.previous.version);if(!bytes)throw new Error('The earlier version is no longer stored.');
      const reason=policyDecision(policy,{id,version:record.previous.version,sha256:record.previous.sha256,source:record.source,action:'update'});if(reason)throw new Error(reason);
      const next={...record,version:record.previous.version,manifest:record.previous.manifest,sha256:record.previous.sha256,granted:record.previous.granted,updatedAt:Date.now(),previous:{version:record.version,manifest:record.manifest,sha256:record.sha256,granted:record.granted}};
      await pluginStore.put(next);await restart(id);return next;
    },
    async setEnabled(id,enabled){
      await load();const record=records.get(id);if(!record)return;
      if(enabled){const reason=blockedReason({...record,enabled:true});if(reason)throw new Error(reason);}
      await pluginStore.put({...record,enabled});await restart(id);
    },
    async revoke(id,permission){await load();const record=records.get(id);if(!record)return;const granted={...record.granted};delete granted[permission];await pluginStore.put({...record,granted});await restart(id);},
    async grant(id,permission){await load();const record=records.get(id);if(!record||!record.manifest.permissions[permission])return;await pluginStore.put({...record,granted:{...record.granted,[permission]:record.manifest.permissions[permission]}});await restart(id);},
    async uninstall(id){stop(id);await pluginStore.uninstall(id);await reload();update();},
    /** After developer mode changes: sideloaded plugins start or stop. */
    async refresh(){await reload();for(const record of records.values()){if(!runnable(record))stop(record.id);}if(env.project())await startAll();update();},
    newerVersion(record,entry){const versions=(entry?.versions||[]).filter(version=>version.compatible&&compareVersions(version.version,record.version)>0);return versions.sort((a,b)=>compareVersions(b.version,a.version))[0]||null;},
  };
}
