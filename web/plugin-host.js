// Capability API v1, host side (docs/plugins.md#capability-api-v1). One instance per
// running plugin and open project. Every request is checked here: the method, the
// permission the person granted, the open project and its files, file ownership, the
// person's mode and the network origin. The plugin id used for storage and secrets comes
// from the instance record, never from a message. Nothing here records telemetry.
import {matchesAny,PluginError} from './plugin-manifest.js';
import {createSandbox} from './plugin-sandbox.js';
import {pluginStore} from './plugin-store.js';
import {projectFiles,projectNode,assertPath} from './model.js';
import {AgentOrigin} from './change-origins.js';
import {delegatedAuthorId} from './direct-provenance.js';
import {directEnabled} from './direct-state.js';
import {validateDialogSpec} from './plugin-dialog.js';
import {failure} from './plugin-errors.js';
export {failure};

export const LIMITS=Object.freeze({message:8*1024*1024,inflight:64,storage:1024*1024,projectData:4*1024*1024,secretBytes:4096,secretNames:32,notify:500,response:16*1024*1024,citations:20000,completions:2000,hostRequestMs:10*60*1000,errors:20,dialogs:3,activationMs:30000,tags:8,patchEdits:2000});
const isObject=value=>!!value&&typeof value==='object'&&!Array.isArray(value);
const text=(value,max,name)=>{if(typeof value!=='string'||value.length>max)throw failure('invalid_request',`${name} must be text of at most ${max} characters.`);return value;};
const KEY=/^[A-Za-z0-9._:/-]{1,128}$/;
const FORBIDDEN_HEADERS=/^(accept-charset|accept-encoding|access-control-.*|connection|content-length|cookie2?|date|dnt|expect|host|keep-alive|origin|referer|set-cookie|te|trailer|transfer-encoding|upgrade|via|proxy-.*|sec-.*)$/i;
const METHODS=new Set(['GET','HEAD','POST','PUT','PATCH','DELETE']);
const freePathOf=(doc,path)=>{
  const taken=new Set(projectFiles(doc).map(file=>file.path.toLowerCase()));
  if(!taken.has(path.toLowerCase()))return path;
  const slash=path.lastIndexOf('/'),dot=path.lastIndexOf('.'),stem=dot>slash?path.slice(0,dot):path,ext=dot>slash?path.slice(dot):'';
  for(let n=2;n<1000;n++){const next=`${stem}-${n}${ext}`;if(!taken.has(next.toLowerCase()))return next;}
  throw failure('invalid_request','Choose another file name.');
};
export {freePathOf as freePath};

/**
 * Starts one plugin for the open project. `env` is supplied by the app:
 *   project()        {doc, projectId, commands, collaboration, owner, mode, transient, activeFileId} or null
 *   notify(text)     workspace notice
 *   activate(id)     open a file in the editor
 *   changed()        decorations, citations or completions changed
 *   openDialog({plugin, spec, onEvent, onClosed}) → {update(spec), close()}
 *   pickFile({plugin, title, files}) → {id, path} | null
 *   fetch(url, init) the browser fetch (resolved at call time)
 *   onCrash(message) the plugin failed and was stopped
 */
export function startPlugin({record,pkg,env,container}){
  const plugin=Object.freeze({id:record.id,name:record.manifest.name,version:record.version,source:record.source});
  const granted=structuredClone(record.granted||{});
  const opened=env.project();
  if(!opened)throw new PluginError('project_closed','Open a project first.');
  const session={doc:opened.doc,projectId:opened.projectId};
  let stopped=false,inflight=0,activeRequests=0,activationUntil=0,errors=0,nextHostId=1;
  const owned=new Map(),dialogs=new Map(),fetches=new Map(),waiting=new Map();
  const decorations=new Map();let citations=[],completions=[];
  const ready=pluginStore.owned(plugin.id,session.projectId).then(items=>{for(const item of items)owned.set(item.fileId,item.how);}).catch(()=>{});
  const sandbox=createSandbox({code:pkg.files[pkg.manifest.main],files:pkg.files,binary:pkg.binary,plugin:{id:plugin.id,name:plugin.name,version:plugin.version,api:1},container,onExit:message=>crash(message)});
  const port=sandbox.port;
  const send=message=>{if(!stopped)port.postMessage({scribyra:1,...message});};

  function project(){
    const now=env.project();
    if(stopped||!now||now.doc!==session.doc)throw failure('project_closed','The project this plugin was started for is no longer open.');
    return now;
  }
  const need=key=>{if(!granted[key])throw failure('permission_denied',`This plugin does not have the “${key}” permission.`);};
  const textFile=(doc,id)=>{const file=typeof id==='string'?projectNode(doc,id):null;return file&&!file.folder&&!file.binary?file:null;};
  const readable=(doc,file)=>!!file&&(owned.has(file.id)||(!!granted['project.read']&&matchesAny(granted['project.read'].files,file.path)));
  function readableFile(doc,id){
    need('project.read');
    const file=textFile(doc,id);
    if(!file||!readable(doc,file))throw failure('not_found','No file this plugin may read has that id in the open project.');
    return file;
  }
  function writeMode(now,{create=false}={}){
    if(now.transient)throw failure('transient_project','Accept and save this project before a plugin changes it.');
    if(now.mode==='viewing')throw failure('viewing_mode','Viewing is read only. Switch to Editing to let a plugin change files.');
    if(create&&now.mode==='reviewing')throw failure('reviewing_mode','Reviewing records suggestions; a plugin cannot create files. Switch to Editing.');
  }
  const activated=()=>activeRequests>0||dialogs.size>0||Date.now()<activationUntil;

  // Reviewing: a plugin's edits become suggestions in its own review, credited to an
  // author record of kind "agent" named after the plugin (docs/plugins.md#modes).
  let actor=null,suggestionReview=null;
  function pluginActor(now){
    if(actor)return actor;
    const sessionId=crypto.randomUUID(),authorId=directEnabled()?delegatedAuthorId(now.owner.id,sessionId):crypto.randomUUID();
    actor=Object.freeze({author:Object.freeze({id:authorId,kind:'agent',displayName:`${plugin.name} (plugin)`.slice(0,80),ownerAuthorId:now.owner.id}),sessionId,origin:fields=>new AgentOrigin({authorId,ownerAuthorId:now.owner.id,sessionId,...fields})});
    return actor;
  }
  function suggest(now,edits){
    const commands=now.collaboration.commands,act=pluginActor(now);
    const call=command=>{const result=commands.execute({version:2,requestId:crypto.randomUUID(),projectId:now.projectId,expectedRevision:commands.revision(),command},undefined,{actor:act});if(!result.ok)throw failure(result.error.code,result.error.message);return result.value;};
    const title=`${plugin.name} suggestions`.slice(0,120);
    suggestionReview??=call({op:'review.create',title}).reviewId;
    const ids=edits.map((edit,i)=>{
      const propose=()=>call({op:'suggestion.propose',reviewId:suggestionReview,fileId:edit.fileId,start:edit.start,end:edit.end,before:edit.before,after:edit.after}).suggestionId;
      try{return propose();}catch(error){if(i||error.code!=='decision_conflict')throw error;suggestionReview=call({op:'review.create',title}).reviewId;return propose();}
    });
    return {suggested:ids.length,reviewId:suggestionReview};
  }

  async function keyValue(scope,limit,op,params){
    if(!isObject(params))throw failure('invalid_request','Expected an object.');
    if(op==='keys')return pluginStore.dataKeys(plugin.id,scope);
    if(typeof params.key!=='string'||!KEY.test(params.key))throw failure('invalid_request','Keys are 1–128 letters, digits and . _ : / -.');
    if(op==='get')return (await pluginStore.dataGet(plugin.id,scope,params.key))??null;
    if(op==='delete'){await pluginStore.dataDelete(plugin.id,scope,params.key);return {};}
    let value;try{value=JSON.parse(JSON.stringify(params.value??null));}catch{throw failure('invalid_request','Values must be JSON.');}
    if(!await pluginStore.dataSet(plugin.id,scope,params.key,value,limit))throw failure('quota_exceeded',`This plugin's ${scope?'project data':'storage'} is full (${Math.round(limit/1024/1024)} MiB).`);
    return {};
  }
  const projectScope=()=>{const now=project();return now.projectId;};

  const methods={
    'app.context':async()=>{
      const now=env.project(),same=now&&now.doc===session.doc&&!stopped,active=same?textFile(now.doc,now.activeFileId):null;
      return {api:1,mode:same?now.mode:null,project:same?{open:true,transient:!!now.transient,activeFileId:active&&readable(now.doc,active)?active.id:null}:null,online:globalThis.navigator?.onLine!==false};
    },
    'ui.notify':async params=>{project();env.notify(text(params?.text,LIMITS.notify,'Notice text'));return {};},
    'storage.get':params=>keyValue('',LIMITS.storage,'get',params),
    'storage.set':params=>keyValue('',LIMITS.storage,'set',params),
    'storage.delete':params=>keyValue('',LIMITS.storage,'delete',params),
    'storage.keys':params=>keyValue('',LIMITS.storage,'keys',params||{}),
    'projectData.get':params=>keyValue(projectScope(),LIMITS.projectData,'get',params),
    'projectData.set':params=>{if(project().transient)throw failure('transient_project','Accept and save this project first.');return keyValue(projectScope(),LIMITS.projectData,'set',params);},
    'projectData.delete':params=>keyValue(projectScope(),LIMITS.projectData,'delete',params),
    'projectData.keys':params=>keyValue(projectScope(),LIMITS.projectData,'keys',params||{}),
    'project.files':async()=>{
      need('project.read');const now=project();
      return projectFiles(now.doc).filter(file=>!file.binary&&!file.folder&&readable(now.doc,file)).map(file=>({id:file.id,path:file.path,owned:owned.has(file.id)}));
    },
    'project.read':async params=>{const now=project(),file=readableFile(now.doc,params?.fileId);return {id:file.id,path:file.path,text:now.doc.getText(`text:${file.id}`).toString()};},
    'project.freePath':async params=>{
      need('project.write');const now=project(),path=text(params?.path,240,'Path');
      try{assertPath(path);}catch(error){throw failure('invalid_request',error.message);}
      if(!matchesAny(granted['project.write'].create,path))throw failure('permission_denied',`This plugin may not create “${path}”.`);
      return freePathOf(now.doc,path);
    },
    'project.create':async params=>{
      need('project.write');const now=project();writeMode(now,{create:true});
      const path=text(params?.path,240,'Path'),content=text(params?.content??'',LIMITS.message,'Content');
      try{assertPath(path);}catch(error){throw failure('invalid_request',error.message);}
      if(!matchesAny(granted['project.write'].create,path))throw failure('permission_denied',`This plugin may not create “${path}”; its permission covers ${granted['project.write'].create.join(', ')||'no new files'}.`);
      if(projectFiles(now.doc).some(file=>file.path.toLowerCase()===path.toLowerCase()))throw failure('exists',`${path} already exists.`);
      await ready;const after=project();if(after.doc!==now.doc)throw failure('project_closed','The project changed.');writeMode(after,{create:true});
      const id=after.commands.run({op:'files.add',entries:[{kind:'text',path,content}]}).ids[0];
      owned.set(id,'created');await pluginStore.own(plugin.id,session.projectId,id,'created');
      return {id,path};
    },
    'project.patch':async params=>{
      need('project.write');await ready;const now=project();
      const file=readableFile(now.doc,params?.fileId);
      if(!owned.has(file.id))throw failure('permission_denied','This plugin can change only files it created or files you picked for it.');
      writeMode(now);
      if(!Array.isArray(params.edits)||!params.edits.length||params.edits.length>LIMITS.patchEdits)throw failure('invalid_request',`Send one to ${LIMITS.patchEdits} edits.`);
      const source=now.doc.getText(`text:${file.id}`).toString();
      const edits=params.edits.map(edit=>{
        if(!isObject(edit)||!Number.isInteger(edit.start)||!Number.isInteger(edit.end)||edit.start<0||edit.end<edit.start||edit.end>source.length||typeof edit.before!=='string'||typeof edit.after!=='string')throw failure('invalid_request','Each edit needs start, end, before and after.');
        if(source.slice(edit.start,edit.end)!==edit.before)throw failure('revision_conflict',`${file.path} changed; read it again before editing.`);
        return {fileId:file.id,start:edit.start,end:edit.end,before:edit.before,after:edit.after};
      });
      if(now.mode==='reviewing')return suggest(now,edits);
      const result=now.commands.run({op:'text.patch',edits});
      return {applied:result.count};
    },
    'project.pick':async params=>{
      need('project.write');if(!granted['project.write'].pick)throw failure('permission_denied','This plugin may not ask you to pick files.');
      if(!activated())throw failure('not_allowed','A plugin can ask you to pick a file only right after you used it.');
      const now=project(),files=Array.isArray(params?.files)?params.files.filter(glob=>typeof glob==='string').slice(0,16):['*'];
      const choice=await env.pickFile({plugin,title:text(params?.title??'Choose a file',120,'Title'),files:projectFiles(now.doc).filter(file=>!file.binary&&!file.folder&&matchesAny(files,file.path))});
      if(!choice||project().doc!==now.doc)return null;
      owned.set(choice.id,'picked');await pluginStore.own(plugin.id,session.projectId,choice.id,'picked');
      return {id:choice.id,path:choice.path};
    },
    'project.activate':async params=>{
      const now=project(),file=readableFile(now.doc,params?.fileId);
      if(!activated())throw failure('not_allowed','A plugin can open a file only right after you used it.');
      env.activate(file.id);return {};
    },
    'secrets.get':async params=>{need('secrets');return pluginStore.secretGet(plugin.id,secretName(params));},
    'secrets.keys':async()=>{need('secrets');return pluginStore.secretNames(plugin.id);},
    'secrets.delete':async params=>{need('secrets');await pluginStore.secretDelete(plugin.id,secretName(params));return {};},
    'secrets.set':async params=>{
      need('secrets');const name=secretName(params),value=text(params?.value,LIMITS.secretBytes,'A secret');
      const names=await pluginStore.secretNames(plugin.id);if(!names.includes(name)&&names.length>=LIMITS.secretNames)throw failure('quota_exceeded',`A plugin can keep at most ${LIMITS.secretNames} secrets.`);
      await pluginStore.secretSet(plugin.id,name,value);return {};
    },
    'net.fetch':params=>networkFetch(params),
    'net.abort':async params=>{need('network');fetches.get(params?.requestId)?.abort();return {};},
    'ui.dialog.open':async params=>{
      need('ui.dialog');project();
      if(!activated())throw failure('not_allowed','A plugin can open a dialog only while you are using it.');
      if(dialogs.size>=LIMITS.dialogs)throw failure('rate_limited','This plugin already has dialogs open.');
      const spec=validateDialogSpec(params?.spec),dialogId=`d${nextHostId++}`;
      const handle=env.openDialog({plugin,spec,onEvent:event=>{if(stopped)return;if(event.type!=='change')activationUntil=Date.now()+LIMITS.activationMs;send({type:'event',event:'dialog.event',data:{dialogId,...event}});},onClosed:()=>{dialogs.delete(dialogId);activationUntil=Date.now()+LIMITS.activationMs;}});
      dialogs.set(dialogId,handle);return {dialogId};
    },
    'ui.dialog.update':async params=>{need('ui.dialog');const handle=dialogs.get(params?.dialogId);if(!handle)throw failure('not_found','That dialog is closed.');handle.update(validateDialogSpec(params.spec));return {};},
    'ui.dialog.close':async params=>{need('ui.dialog');const handle=dialogs.get(params?.dialogId);if(handle){dialogs.delete(params.dialogId);handle.close();}return {};},
    'ui.files.decorate':async params=>{
      need('ui.fileAction');const now=project(),file=readableFile(now.doc,params?.fileId);
      const tags=Array.isArray(params.tags)?params.tags:[];
      if(tags.length>LIMITS.tags||tags.some(tag=>typeof tag!=='string'||!/^[a-z][a-z0-9-]{0,31}$/.test(tag)))throw failure('invalid_request','Tags are short lowercase words.');
      let bar=null;
      if(params.bar!==null&&params.bar!==undefined){
        const value=params.bar;if(!isObject(value))throw failure('invalid_request','A bar is an object.');
        const actions=Array.isArray(value.actions)?value.actions:[];if(actions.length>3)throw failure('invalid_request','A bar has at most three buttons.');
        bar={label:text(value.label,60,'Bar label'),text:text(value.text,300,'Bar text'),actions:actions.map(action=>{
          if(!isObject(action)||typeof action.id!=='string'||!/^[a-z][a-z0-9-]{0,31}$/.test(action.id))throw failure('invalid_request','Bar buttons need an id.');
          const modes=Array.isArray(action.modes)?action.modes.filter(mode=>['editing','reviewing','viewing'].includes(mode)):['editing','reviewing','viewing'];
          return {id:action.id,label:text(action.label,40,'Button label'),title:action.title===undefined?'':text(action.title,160,'Button title'),blockedTitle:action.blockedTitle===undefined?'':text(action.blockedTitle,160,'Button title'),modes};
        })};
      }
      if(!tags.length&&!bar)decorations.delete(file.id);else decorations.set(file.id,{tags:new Set(tags),bar});
      env.changed();return {};
    },
    'bibliography.set':async params=>{
      need('bibliography');project();
      const entries=Array.isArray(params?.entries)?params.entries:null;
      if(!entries||entries.length>LIMITS.citations)throw failure('invalid_request',`Send at most ${LIMITS.citations} entries.`);
      citations=entries.map(entry=>{
        if(!isObject(entry)||typeof entry.key!=='string'||!entry.key||entry.key.length>200)throw failure('invalid_request','Each entry needs a citation key.');
        const field=name=>typeof entry[name]==='string'?entry[name].slice(0,name==='title'?160:80):'';
        return {key:entry.key,type:field('type')||'misc',author:field('author'),year:field('year'),title:field('title')};
      });
      env.changed();return {};
    },
    'completion.set':async params=>{
      need('completion');project();
      const items=Array.isArray(params?.items)?params.items:null;
      if(!items||items.length>LIMITS.completions)throw failure('invalid_request',`Send at most ${LIMITS.completions} items.`);
      completions=items.map(item=>{
        if(!isObject(item)||!['command','environment'].includes(item.kind)||typeof item.name!=='string'||!/^[A-Za-z@*]{1,64}$/.test(item.name))throw failure('invalid_request','Each item needs a kind (command or environment) and a name.');
        return {kind:item.kind,name:item.name,args:Number.isInteger(item.args)&&item.args>=0&&item.args<=9?item.args:0};
      });
      env.changed();return {};
    },
  };
  function secretName(params){if(typeof params?.name!=='string'||!/^[A-Za-z0-9._-]{1,64}$/.test(params.name))throw failure('invalid_request','Secret names are 1–64 letters, digits and . _ -.');return params.name;}

  async function networkFetch(params){
    need('network');project();
    if(!isObject(params))throw failure('invalid_request','Expected an object.');
    let url;try{url=new URL(params.url);}catch{throw failure('invalid_request','Not a URL.');}
    if(url.username||url.password||!granted.network.includes(url.origin))throw failure('network_denied',`This plugin may not contact ${url.origin}. It may contact ${granted.network.join(', ')}.`);
    const method=(params.method||'GET').toUpperCase();if(!METHODS.has(method))throw failure('invalid_request','Unsupported request method.');
    const headers=new Headers();
    for(const [name,value]of Array.isArray(params.headers)?params.headers:Object.entries(isObject(params.headers)?params.headers:{})){
      if(typeof name!=='string'||typeof value!=='string'||value.length>8192)throw failure('invalid_request','Headers are text.');
      if(!FORBIDDEN_HEADERS.test(name))headers.set(name,value);
    }
    const body=params.body===undefined||params.body===null?undefined:typeof params.body==='string'||params.body instanceof Uint8Array?params.body:null;
    if(body===null||body?.length>LIMITS.message)throw failure('invalid_request','A request body is text or bytes of at most 8 MiB.');
    if(body!==undefined&&(method==='GET'||method==='HEAD'))throw failure('invalid_request','GET and HEAD requests have no body.');
    if(globalThis.navigator?.onLine===false)throw failure('offline','This device is offline.');
    const requestId=typeof params.requestId==='string'&&params.requestId.length<=64?params.requestId:crypto.randomUUID(),controller=new AbortController();
    fetches.set(requestId,controller);
    try{
      let response;
      try{response=await env.fetch(url.href,{method,headers,body,credentials:'omit',referrerPolicy:'no-referrer',cache:'no-store',redirect:'error',mode:'cors',signal:controller.signal});}
      catch(error){if(controller.signal.aborted)throw failure('aborted','The request was stopped.');if(globalThis.navigator?.onLine===false)throw failure('offline','This device is offline.');throw failure('network_error',`Scribyra could not reach ${url.origin}.`);}
      const reader=response.body?.getReader(),chunks=[];let size=0;
      if(reader)for(;;){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>LIMITS.response){controller.abort();throw failure('too_large','The response is larger than 16 MiB.');}chunks.push(value);}
      const bytes=new Uint8Array(size);let at=0;for(const chunk of chunks){bytes.set(chunk,at);at+=chunk.length;}
      const responseHeaders=[...response.headers].filter(([name])=>!/^set-cookie2?$/i.test(name));
      return {status:response.status,statusText:response.statusText,headers:responseHeaders,body:params.responseType==='bytes'?bytes:new TextDecoder().decode(bytes)};
    }finally{fetches.delete(requestId);}
  }

  port.onmessage=async event=>{
    if(stopped)return;
    const message=event.data;
    if(!isObject(message)||message.scribyra!==1)return;
    if(message.type==='response'){const entry=waiting.get(message.id);if(!entry)return;waiting.delete(message.id);clearTimeout(entry.timer);if(isObject(message.error))entry.reject(failure(String(message.error.code||'failed').slice(0,64),String(message.error.message||'The plugin failed.').slice(0,2000)));else entry.resolve(message.result);return;}
    if(message.type==='event'){if(message.event==='plugin.error'&&++errors>LIMITS.errors)crash('It reported too many errors.');return;}
    if(message.type!=='request'||!Number.isSafeInteger(message.id))return;
    const reply=fields=>send({type:'response',id:message.id,...fields});
    if(inflight>=LIMITS.inflight){reply({error:{code:'rate_limited',message:'Too many requests at once.'}});return;}
    const handler=typeof message.method==='string'&&Object.hasOwn(methods,message.method)?methods[message.method]:null;
    if(!handler){reply({error:{code:'unknown_method',message:`Plugin API 1 has no method “${String(message.method).slice(0,64)}”.`}});return;}
    let size=0;try{size=JSON.stringify(message.params??null)?.length??0;}catch{size=Infinity;}
    if(size>LIMITS.message){reply({error:{code:'too_large',message:'The request is larger than 8 MiB.'}});return;}
    inflight++;
    try{await ready;reply({result:(await handler(message.params??{}))??null});}
    catch(error){reply({error:{code:typeof error?.code==='string'?error.code:'failed',message:String(error?.message||error).slice(0,2000)}});}
    finally{inflight--;}
  };

  /** Asks the plugin to do something the person chose; resolves to its answer. */
  function request(method,params){
    if(stopped)return Promise.reject(failure('stopped','This plugin is not running.'));
    activeRequests++;activationUntil=Date.now()+LIMITS.activationMs;
    const id=`h${nextHostId++}`;
    return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{waiting.delete(id);reject(failure('timeout',`${plugin.name} did not answer.`));},LIMITS.hostRequestMs);
      waiting.set(id,{resolve,reject,timer});send({type:'request',id,method,params});
    }).finally(()=>{activeRequests--;activationUntil=Date.now()+LIMITS.activationMs;});
  }
  function event(name,data){send({type:'event',event:name,data});}
  function crash(message){if(stopped)return;stop();env.onCrash?.(message);}
  function stop(){
    if(stopped)return;stopped=true;
    for(const controller of fetches.values())controller.abort();
    for(const handle of dialogs.values())handle.close();dialogs.clear();
    for(const entry of waiting.values()){clearTimeout(entry.timer);entry.reject(failure('stopped','The plugin stopped.'));}waiting.clear();
    decorations.clear();citations=[];completions=[];
    sandbox.stop();env.changed();
  }
  return {
    plugin,request,event,stop,
    get stopped(){return stopped;},
    readableId(id){const now=env.project();if(!now||now.doc!==session.doc)return null;const file=textFile(now.doc,id);return file&&readable(now.doc,file)?file.id:null;},
    decoration:id=>decorations.get(id)||null,
    get citations(){return citations;},
    get completions(){return completions;},
    // For tests and the manager: nothing secret.
    get state(){return {inflight,dialogs:dialogs.size,owned:owned.size};},
  };
}
