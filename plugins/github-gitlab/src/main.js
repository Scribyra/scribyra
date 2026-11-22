// The GitHub and GitLab plugin (docs/git-sync.md, docs/plugins.md). It runs in Scribyra's
// plugin sandbox and does everything through the capability API: it reads the open
// project's files (text and binary), applies the changes the person confirmed with
// project.apply, keeps the access token as a secret bound to the host's origin, contacts
// only api.github.com, gitlab.com and GitLab servers the person allowed, draws its dialogs
// declaratively and shows a status item above the project. Scribyra enforces each of
// these. Comments, reviews and history are not project files: they are never pushed.
import {displayDiff,merge3} from '../../../web/line-diff.js';
import {GITHUB,gitlabHost,githubClient,gitlabClient,normalRepository,HostError,PUSH_FILE_BYTES} from './hosts.js';
import {remoteFiles,planPull,planPush,countLocalChanges,recordsAfterPull,recordsAfterPush,recordsAtLink,SKIP_REASONS} from './sync.js';
import {normalSubfolder,toRepoPath,isTextPath,decodeText,isLfsPointer,ignoreMatcher,secretProblem,validBranch} from './paths.js';
import {gitBlobId} from './sha1.js';
import {gitStore} from './store.js';
import {runDialog} from './dialog.js';

/* global scribyra */
const store=gitStore(scribyra);
const call=(method,params,options)=>scribyra.call(method,params,options);
const notify=text=>call('ui.notify',{text:text.slice(0,500)}).catch(()=>{});
const encoder=new TextEncoder();
const plural=(n,one,many=`${one}s`)=>`${n} ${n===1?one:many}`;
const short=sha=>sha?sha.slice(0,7):'';
const size=bytes=>bytes<1024?`${bytes} B`:bytes<1024*1024?`${(bytes/1024).toFixed(1)} KB`:`${(bytes/1024/1024).toFixed(1)} MB`;
const ago=at=>{if(!at)return 'never';const minutes=Math.round((Date.now()-at)/60000);return minutes<1?'just now':minutes<60?`${minutes} min ago`:new Date(at).toLocaleString(undefined,{dateStyle:'medium',timeStyle:'short'});};
const STATUS_LABEL='Repository link';

// ---- Host access ------------------------------------------------------------------
let online=true;
async function net(url,{method='GET',headers={},body,responseType='text',auth}={}){
  try{
    const result=await call('net.fetch',{url,method,headers:Object.entries(headers),body,responseType,auth,requestId:`r${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`});
    online=true;return {status:result.status,headers:new Headers(result.headers),body:result.body};
  }catch(error){
    if(error.code==='offline'){online=false;throw new HostError('offline','This device is offline. Pull and push need a connection; everything else keeps working.');}
    if(error.code==='too_large')throw new HostError('too_large','A file is larger than 16 MiB, more than Scribyra handles in one request.');
    throw new HostError(error.code||'network',error.message||String(error));
  }
}
const hostOf=link=>link.kind==='github'?GITHUB:gitlabHost(link.origin);
function client(link,secret=link.account){
  return link.kind==='github'?githubClient({net,repository:link.repository,secret}):gitlabClient({net,origin:link.origin,repository:link.repository,secret});
}
const repoUrl=link=>`${hostOf(link).web}/${link.repository}`;

// ---- The open project ---------------------------------------------------------------
let link=null,records={},opened=false;
async function context(){const value=await call('app.context');online=value.online;if(!value.project)throw new Error('Open a project first.');return value;}
/** The project's files by path, with fingerprints: {path → {id, path, hash, size, binary}}. */
async function localFiles(){const list=await call('project.files',{hashes:true});return new Map(list.map(file=>[file.path,file]));}
async function readFile(file){
  const result=await call('project.read',{fileId:file.id});
  return result.binary?{bytes:result.bytes,text:null,hash:result.hash}:{bytes:encoder.encode(result.text),text:result.text,hash:result.hash};
}
// Git blob ids of local files, by fingerprint, so unchanged files are hashed once.
const blobIds=new Map();
async function localBlobId(file){if(!blobIds.has(file.hash)){const {bytes}=await readFile(file);blobIds.set(file.hash,gitBlobId(bytes));}return blobIds.get(file.hash);}
/** What is never synced: .scribyraignore patterns and the link's own exclusions. */
async function exclusions(local,current=link){
  const lines=[...(current?.excludes||[])],file=local.get('.scribyraignore');
  // Without a text extension the project keeps it as a binary file; it is UTF-8 all the same.
  if(file){const content=await readFile(file),text=content.text??decodeText(content.bytes);if(text)lines.push(...text.split('\n'));}
  return ignoreMatcher(lines);
}
function modeBlocked(mode,doing){
  if(mode==='viewing')return `Viewing is read only. Switch to Editing to ${doing}.`;
  return '';
}

// ---- Status item ----------------------------------------------------------------------
let statusTimer=null,statusRunning=false,statusAgain=false;
function scheduleStatus(delay=800){clearTimeout(statusTimer);statusTimer=setTimeout(()=>void updateStatus(),delay);}
async function updateStatus(){
  if(statusRunning){statusAgain=true;return;}
  statusRunning=true;
  try{
    if(!opened)return;
    if(!link){
      const source=await importSource();
      if(source&&!await store.dismissed())await call('ui.status.set',{status:{label:STATUS_LABEL,text:`Imported from ${source.host}/${source.repo}${source.path?` (${source.path})`:''}`,title:'This project came from an Open in Scribyra link. Link it to that repository to pull and push.',tone:'neutral',actions:[{id:'link-source',label:'Link to this repository',title:`Link this project to ${source.host}/${source.repo}`,modes:['editing','reviewing'],blockedTitle:'Viewing is read only'},{id:'dismiss',label:'Not now'}]}});
      else await call('ui.status.set',{status:null});
      return;
    }
    const local=await localFiles(),excluded=await exclusions(local),count=countLocalChanges({records,local,excluded});
    const host=hostOf(link),sync=link.sync||{};
    const remote=!sync.commit?' · not pulled yet':typeof sync.behind==='number'&&sync.checkedAt?(sync.behind?` · ${plural(sync.behind,'new commit')} on ${host.name}`:` · up to date with ${host.name}`):'';
    await call('ui.status.set',{status:{label:STATUS_LABEL,
      text:`${link.repository}${link.subfolder?`/${link.subfolder}`:''} · ${link.branch} · ${count?plural(count,'local change'):'no local changes'}${remote}`,
      title:`Linked to ${repoUrl(link)}, branch ${link.branch}${link.subfolder?`, folder ${link.subfolder}`:''}. Last sync ${ago(sync.at)}${sync.commit?` at ${short(sync.commit)}`:''}${sync.checkedAt?`; checked ${ago(sync.checkedAt)}`:''}.`,
      tone:sync.behind&&count?'attention':'neutral',
      actions:[
        {id:'pull',label:'Pull',title:`Bring in the latest commit of ${link.branch}; you review every change first`,modes:['editing','reviewing'],blockedTitle:'Viewing is read only. Switch to Editing to pull.'},
        {id:'push',label:'Push',title:`Commit your changes to ${link.branch} on ${host.name}`,modes:['editing','reviewing'],blockedTitle:'Viewing is read only. Switch to Editing to push.'},
        {id:'check',label:'Check',title:`Ask ${host.name} whether ${link.branch} has new commits`},
      ]}});
  }catch{/* the project closed or the plugin stopped */}
  finally{statusRunning=false;if(statusAgain){statusAgain=false;scheduleStatus(200);}}
}
async function importSource(){
  const source=await call('project.source').catch(()=>null);
  return source&&['github','gitlab'].includes(source.kind)&&source.repo?source:null;
}
async function load(){
  try{link=await store.link();records=link?await store.records():{};}catch{link=null;records={};}
  await updateStatus();
  if(link?.checkOnOpen&&link.account)void check({quietly:true});
}
async function save(next=link,nextRecords=records){await store.save(next,nextRecords);link=next;records=nextRecords;scheduleStatus(0);}

/** Asks the host how far the branch moved since the last sync. */
async function check({quietly=false}={}){
  if(!link)return;
  try{
    const remote=client(link),head=await remote.head(link.branch);
    if(!head)throw new HostError('not_found',`${hostOf(link).name} has no branch ${link.branch} in ${link.repository}.`);
    const behind=!link.sync?.commit?null:head===link.sync.commit?0:(await remote.behind(link.sync.commit,head)).behind;
    await save({...link,sync:{...link.sync,behind,checkedAt:Date.now()}});
    if(!quietly)await notify(behind?`${link.branch} on ${hostOf(link).name} has ${plural(behind,'new commit')}. Pull to review them.`:link.sync?.commit?`${link.branch} on ${hostOf(link).name} has nothing new since your last sync.`:`${link.branch} on ${hostOf(link).name} is at ${short(head)}. Pull to bring it in.`);
  }catch(error){if(!quietly)throw error;}
}

// ---- Link -----------------------------------------------------------------------------
const TOKEN_HELP={
  github:host=>['Create a ',{link:host.tokenUrl,text:'fine-grained personal access token'},': under “Repository access” choose “Only select repositories” and pick this one; under “Repository permissions” set “Contents” to “Read and write” (“Read-only” is enough to pull). GitHub adds “Metadata: Read-only” itself. Give it an expiry. ',{link:host.docsUrl,text:'How tokens work'},'.'],
  gitlab:host=>['Narrowest: a ',{link:host.docsUrl,text:'project access token'},' for this project only (project Settings → Access tokens), role Developer (Maintainer for a protected branch), scope “api”. Or a ',{link:host.tokenUrl,text:'personal access token'},' with scope “api”. Pulling alone needs “read_api”. GitLab’s “read_repository” and “write_repository” scopes do not work with its API, so they cannot push from a browser.'],
};
async function linkDialog({prefill=null}={}){
  const open=await context(),blocked=modeBlocked(open.mode,'link a repository')||(open.project.transient?'Accept and save this project before linking a repository.':'');
  if(blocked){await notify(blocked);return;}
  const source=prefill?await importSource():null;
  const accounts=await store.accounts().catch(()=>[]);
  const sourceKind=source?(source.kind==='github'?'github':source.host==='gitlab.com'?'gitlab':'custom'):'github';
  let values={kind:sourceKind,server:sourceKind==='custom'?`https://${source.host}`:'',repository:source?.repo||'',branch:source&&!/^[0-9a-f]{40}$/.test(source.ref)?source.ref:'',subfolder:source?.path||'',token:''};
  let checked=null,busy=false,status='',tokenVersion=0,abort=null;const fresh=new Set();
  const hostFor=kind=>kind==='github'?GITHUB:kind==='gitlab'?gitlabHost():values.server?(()=>{try{return gitlabHost(new URL(values.server).origin);}catch{return gitlabHost();}})():gitlabHost();
  const savedFor=(kind,origin)=>accounts.find(account=>account.kind===(kind==='github'?'github':'gitlab')&&account.origin===origin)||null;
  const spec=()=>{
    const host=hostFor(values.kind),saved=savedFor(values.kind,host.origin);
    return {title:'Link to a repository',initialFocus:'repository',children:[
      {type:'text',text:'Links this project to a branch of a GitHub or GitLab repository. Pull brings in its latest commit after you review every change; Push commits your changes to it. Nothing is sent until you pull or push. Comments, reviews and history stay on this device.'},
      ...(source?[{type:'text',tone:'source',text:`Imported from ${source.host}/${source.repo}${source.ref?` · ${source.ref}`:''}${source.commit?` · commit ${short(source.commit)}`:''}${source.path?` · folder ${source.path}`:''}`}]:[]),
      {type:'group',legend:'1. Repository',disabled:busy,children:[
        {type:'field',id:'kind',input:'select',label:'Host',value:values.kind,options:[{value:'github',label:'GitHub (github.com)'},{value:'gitlab',label:'GitLab (gitlab.com)'},{value:'custom',label:'Self-hosted GitLab'}]},
        ...(values.kind==='custom'?[{type:'field',id:'server',input:'text',label:'GitLab server address',value:values.server,placeholder:'https://gitlab.example.org',help:'Scribyra asks you before the plugin may contact it.'}]:[]),
        {type:'field',id:'repository',input:'text',label:values.kind==='github'?'Repository (owner/name)':'Project (group/…/name)',value:values.repository,placeholder:values.kind==='github'?'octo/paper':'group/paper'},
        {type:'field',id:'branch',input:'text',label:'Branch',value:values.branch,placeholder:'The default branch'},
        {type:'field',id:'subfolder',input:'text',label:'Folder in the repository (optional)',value:values.subfolder,placeholder:'For example paper',help:'Only this folder is synced, and its files are the project’s files.'},
      ]},
      {type:'group',legend:'2. Access token',disabled:busy,children:[
        {type:'field',id:'token',input:'password',label:saved?`Access token (saved for ${saved.login||host.name}; leave empty to use it)`:'Access token',value:'',version:tokenVersion,placeholder:saved?'Saved on this device':values.kind==='github'?'github_pat_…':'glpat-…',help:TOKEN_HELP[values.kind==='github'?'github':'gitlab'](host)},
        {type:'text',tone:'privacy',text:`The token is kept only in this browser on this device, bound to ${host.origin}: Scribyra adds it to requests to that address and nowhere else. It is never put into the project, its history, backups, exports, diagnostics, telemetry or the repository. Remove it anytime from More tools → GitHub and GitLab.`},
        {type:'actions',buttons:[{id:'check',label:'Check access',primary:!checked,disabled:busy}]},
      ]},
      {type:'status',id:'status',text:status},
      {type:'actions',buttons:[{id:'cancel',label:busy?'Stop':'Cancel'},{id:'link',label:'Link and pull',primary:!!checked,disabled:busy||!checked}]},
    ]};
  };
  const result=await runDialog(scribyra,{spec,async onEvent(event,dialog){
    values={...values,...event.values};
    const work=task=>{
      if(busy)return;busy=true;abort=new AbortController();void dialog.update();
      void (async()=>{
        try{await task(abort.signal);}
        catch(error){if(!dialog.closed)status=error.name==='AbortError'?'Stopped. Nothing was linked.':error.message||String(error);}
        finally{busy=false;abort=null;if(!dialog.closed)await dialog.update();}
      })();
    };
    if(event.type==='close'){abort?.abort();return;}
    if(event.type==='cancel'||event.type==='click'&&event.control==='cancel'){if(busy)abort?.abort();else dialog.close(null);return;}
    if(event.type==='change'&&['kind','server','repository','branch','subfolder'].includes(event.control)){if(checked){checked=null;status='Check access again for these settings.';}if(event.control==='kind')await dialog.update();return;}
    if(event.type==='click'&&event.control==='check')work(async()=>{
      status='Checking…';await dialog.update();
      const kind=values.kind==='github'?'github':'gitlab';
      let origin=kind==='github'?GITHUB.origin:'https://gitlab.com';
      if(values.kind==='custom'){
        let url;try{url=new URL(values.server.trim());}catch{throw new Error('Enter the GitLab server’s address, like https://gitlab.example.org.');}
        if(url.protocol!=='https:'||url.username||url.password)throw new Error('The GitLab server needs an https:// address.');
        origin=url.origin;
        if(origin==='https://gitlab.com')values.kind='gitlab';
        else{const answer=await call('net.requestOrigin',{origin,reason:'to reach the GitLab server you entered'});if(!answer.granted)throw new Error(`You did not allow ${origin}. Nothing was linked.`);}
      }
      const repository=normalRepository(kind,values.repository);
      if(!repository)throw new Error(kind==='github'?'Enter the repository as owner/name, for example octo/paper.':'Enter the project path as group/name, for example group/paper.');
      const subfolder=normalSubfolder(values.subfolder);if(subfolder===null)throw new Error('The folder must be a plain path like paper or docs/paper.');
      const branchInput=values.branch.trim();if(branchInput&&!validBranch(branchInput))throw new Error('That is not a valid branch name.');
      const saved=savedFor(kind,origin),typed=values.token.trim();
      if(!typed&&!saved)throw new Error('Enter an access token.');
      if(typed&&!/^[\x21-\x7e]{8,400}$/.test(typed))throw new Error('That does not look like an access token.');
      // The token is saved bound to the host's origin first, so the check already goes
      // through Scribyra, which adds it to requests to that origin only.
      const name=typed?await store.saveToken({kind,origin,login:'',token:typed}):saved.name;
      if(typed)fresh.add(name);
      tokenVersion++;values.token='';checked=null;
      const probe={kind,origin,repository};
      try{
        const remote=client(probe,name),account=await remote.account(),repo=await remote.repository();
        const branch=branchInput||repo.defaultBranch,head=await remote.head(branch);
        if(!head&&!(kind==='gitlab'&&repo.empty))throw new Error(`${hostFor(values.kind).name} has no branch ${branch} in ${repo.fullName}.${branchInput?' Leave the branch empty for the default branch.':''}`);
        const scopes=kind==='gitlab'?await remote.scopes().catch(()=>null):null;
        await store.setLogin(name,account.login);
        checked={account:name,fresh:!!typed,kind,origin,repository:repo.fullName,branch,subfolder,head,repo,login:account.login,scopes};
        const notes=[];
        if(repo.canPush===false)notes.push('Your account cannot push to it, so you can pull but not push.');
        if(scopes&&!scopes.includes('api'))notes.push(scopes.includes('read_api')?'The token has “read_api”: you can pull, but pushing needs “api”.':'The token lacks “api”/“read_api”; GitLab will refuse its API requests.');
        if(kind==='github')notes.push('Pushing needs “Contents: Read and write” on the token.');
        status=`Token for ${account.login||'your account'} can read ${repo.fullName} (${repo.private?'private':'public'}). Branch ${branch}${head?` is at ${short(head)}`:' does not exist yet'}.${notes.length?` ${notes.join(' ')}`:''}`;
      }catch(error){if(typed){fresh.delete(name);await store.removeToken(name).catch(()=>{});}throw error;}
    });
    if(event.type==='click'&&event.control==='link'&&checked)work(async()=>{
      const now=await context(),again=modeBlocked(now.mode,'link a repository');if(again)throw new Error(again);
      status='Linking…';await dialog.update();
      const next={version:1,kind:checked.kind,origin:checked.origin,repository:checked.repository,branch:checked.branch,subfolder:checked.subfolder,account:checked.account,excludes:[],checkOnOpen:false,linkedAt:Date.now(),sync:{commit:null,tree:null,at:null,behind:null,checkedAt:null}};
      let nextRecords={};
      // A project from an Open in Scribyra link starts from the commit it was imported at,
      // so a pull is a real three-way merge with what changed since.
      const same=source&&source.commit&&(checked.kind==='github'?source.kind==='github':source.kind==='gitlab'&&`https://${source.host}`===checked.origin)&&source.repo.toLowerCase()===checked.repository.toLowerCase()&&(source.path||'')===checked.subfolder;
      if(same){
        status=`Comparing the project with commit ${short(source.commit)}…`;await dialog.update();
        const remote=client(next),tree=await remote.tree(source.commit,next.subfolder),files=remoteFiles(tree.entries,next.subfolder),local=await localFiles(),ids={};
        for(const [path,file]of local)if(files.has(path))ids[path]=await localBlobId(file);
        nextRecords=recordsAtLink({remote:files,local,blobIds:ids});
        next.sync={...next.sync,commit:source.commit,tree:tree.tree,at:source.importedAt||Date.now()};
      }
      await save(next,nextRecords);
      dialog.close({pull:true});
    });
  }});
  // Tokens typed in this dialog but not used by the link are forgotten.
  for(const name of fresh)if(link?.account!==name)await store.removeToken(name).catch(()=>{});
  if(!result)return;
  await notify(`Linked to ${repoUrl(link)} (${link.branch}${link.subfolder?`, folder ${link.subfolder}`:''}). The token is saved only on this device.`);
  if(result.pull)await pull();
}

// ---- Pull -----------------------------------------------------------------------------
const KIND_TEXT={added:'Added on',changed:'Changed on',removed:'Removed on'};
function diffNode(label,before,after){
  const diff=displayDiff(before??'',after??'',{limit:300});
  return {type:'diff',label,lines:diff.lines.length?diff.lines:[{kind:'gap',text:'No line differences (only line endings or the final newline)'}],note:diff.truncated?`Showing the first 300 lines of the difference (${diff.added} added, ${diff.removed} removed in all).`:undefined};
}
async function pull(){
  const open=await context(),blocked=modeBlocked(open.mode,'pull')||(open.project.transient?'Accept and save this project before pulling.':'');
  if(blocked){await notify(blocked);return;}
  if(!link){await linkDialog();return;}
  if(!open.online){await notify('This device is offline. Pull needs a connection.');return;}
  const host=hostOf(link),remote=client(link);
  const head=await remote.head(link.branch);
  if(!head)throw new HostError('not_found',`${host.name} has no branch ${link.branch} in ${link.repository}.`);
  const pending=Object.values(records).some(record=>record.base!==record.remote);
  if(head===link.sync?.commit&&!pending){await save({...link,sync:{...link.sync,behind:0,checkedAt:Date.now()}});await notify(`Already up to date with ${link.branch} on ${host.name} (${short(head)}).`);return;}
  const tree=await remote.tree(head,link.subfolder),files=remoteFiles(tree.entries,link.subfolder);
  const local=await localFiles(),excluded=await exclusions(local),plan=planPull({records,remote:files,local,excluded});
  // Both sides changed: if the local file already equals theirs, there is nothing to do.
  for(const item of plan.items)if(item.kind==='check')item.kind=await localBlobId(item.file)===item.remote.sha?'same':'conflict';
  const shown=plan.items.filter(item=>item.kind==='take'||item.kind==='conflict');
  // Download what the dialog shows: theirs, the base for text conflicts, and ours.
  const contents=new Map(),skipped=[...plan.skipped];
  for(const item of shown){
    const entry={theirs:null,base:null,mine:null,text:false};
    if(item.remote){
      const bytes=await remote.blob(item.remote.sha);
      if(isLfsPointer(bytes)){skipped.push({path:item.path,reason:'lfs'});item.kind='skip';continue;}
      const text=(item.file?!item.file.binary:isTextPath(item.path))?decodeText(bytes):null;
      if((item.file?!item.file.binary:isTextPath(item.path))&&text===null){skipped.push({path:item.path,reason:'encoding'});item.kind='skip';continue;}
      entry.theirs={bytes,text};entry.text=text!==null;
    }
    if(item.file){const mine=await readFile(item.file);entry.mine=mine;entry.text=mine.text!==null;}
    if(item.kind==='conflict'&&entry.text&&item.record?.base){const bytes=await remote.blob(item.record.base);entry.base={bytes,text:decodeText(bytes)};}
    contents.set(item.path,entry);
  }
  const items=shown.filter(item=>item.kind!=='skip'),quiet=plan.items.filter(item=>item.kind==='same'||item.kind==='record');
  const outcomes={};
  for(const item of quiet)outcomes[item.path]={result:'same',exists:!!item.file,hash:item.file?.hash};
  if(!items.length){
    await save({...link,sync:{commit:head,tree:tree.tree,at:Date.now(),behind:0,checkedAt:Date.now()}},recordsAfterPull({records,remote:files,outcomes}));
    await notify(`Pulled ${link.branch} at ${short(head)}: nothing to change here.${skipped.length?` ${plural(skipped.length,'file')} not synced (see More tools → GitHub and GitLab).`:''}`);return;
  }
  const decision=await pullDialog({items,contents,skipped,head,host,mode:open.mode});
  if(!decision){await notify('Pull cancelled. Nothing changed.');return;}
  const now=await context(),again=modeBlocked(now.mode,'pull');if(again)throw new Error(again);
  const changes=[],planned=new Map(),later=[];
  for(const [index,item]of items.entries()){
    const choice=decision.choices[index],entry=contents.get(item.path);
    if(choice==='skip'){outcomes[item.path]={result:'pending'};continue;}
    if(choice==='mine'){outcomes[item.path]={result:'mine'};continue;}
    let content=entry.theirs;
    if(choice==='merged'||choice==='edit')content={text:choice==='edit'?decision.edits[index]:merge3(entry.base?.text??'',entry.mine.text,entry.theirs.text).text};
    if(!content){// theirs is a deletion
      if(item.file&&now.mode==='reviewing'){later.push(item.path);outcomes[item.path]={result:'pending'};}
      else if(item.file){changes.push({op:'delete',fileId:item.file.id,expect:item.file.hash});planned.set(item.path,{exists:false});}
      else outcomes[item.path]={result:'same',exists:false};
      continue;
    }
    const body=content.text!==null&&content.text!==undefined?{text:content.text}:{bytes:content.bytes};
    if(now.mode==='reviewing'&&(!item.file||item.file.binary||body.text===undefined)){later.push(item.path);outcomes[item.path]={result:'pending'};continue;}
    if(item.file)changes.push({op:'update',fileId:item.file.id,expect:item.file.hash,...body});
    else changes.push({op:'add',path:item.path,...body});
    // A merge or an edited result differs from theirs: it is a local change to push.
    planned.set(item.path,{exists:true,differs:body.text!==undefined&&gitBlobId(encoder.encode(body.text))!==item.remote?.sha});
  }
  let summary='';
  if(changes.length){
    const result=await call('project.apply',{changes});
    if(now.mode==='reviewing'){
      for(const path of planned.keys())outcomes[path]={result:'pending'};
      summary=`${plural(result.suggested||0,'suggestion')} from ${link.branch} are in the review “GitHub and GitLab suggestions”. Accept them, then pull again to finish.`;
    }else{
      const hashes=new Map(result.files.map(file=>[file.path,file]));
      for(const [path,{exists,differs}]of planned)outcomes[path]={result:'applied',exists,hash:differs?null:hashes.get(path)?.hash};
      const count=kind=>items.filter((item,i)=>planned.has(item.path)&&item.remoteState===kind&&decision.choices[i]!=='mine').length;
      summary=`Pulled ${link.branch} at ${short(head)}: ${count('added')} added, ${count('changed')} changed, ${count('removed')} removed.`;
    }
  }else summary=`Pulled ${link.branch} at ${short(head)}: nothing applied.`;
  const kept=items.filter((item,i)=>decision.choices[i]==='mine').length,notNow=items.filter((item,i)=>decision.choices[i]==='skip').length;
  await save({...link,sync:{commit:head,tree:tree.tree,at:Date.now(),behind:0,checkedAt:Date.now()}},recordsAfterPull({records,remote:files,outcomes}));
  await notify(`${summary}${kept?` Kept your version of ${plural(kept,'file')}.`:''}${notNow?` ${plural(notNow,'change')} left for later.`:''}${later.length?` ${plural(later.length,'file')} added, deleted or binary need Editing: ${later.slice(0,3).join(', ')}${later.length>3?'…':''}.`:''}`);
}

function pullDialog({items,contents,skipped,head,host,mode}){
  const choices=items.map(item=>item.kind==='take'?'apply':''),edits=items.map(()=>null);
  let status='',version=0;
  const conflicts=items.filter(item=>item.kind==='conflict').length;
  const node=(item,i)=>{
    const entry=contents.get(item.path),theirs=entry.theirs,mine=entry.mine,text=entry.text;
    const badges=[{text:`${KIND_TEXT[item.remoteState]} ${host.name}`,tone:item.remoteState}];
    if(item.kind==='conflict')badges.push({text:item.localState==='deleted'?'Deleted here':item.localState==='added'?'Added here too':'Changed here too',tone:'conflict'});
    if(!text)badges.push({text:'Binary',tone:'neutral'});
    const children=[{type:'badges',items:badges}];
    if(!text){
      const sizes=[mine?`here ${size(mine.bytes.length)}`:'',theirs?`on ${host.name} ${size(theirs.bytes.length)}`:''].filter(Boolean).join(' · ');
      children.push({type:'text',tone:'summary',text:`Binary file${sizes?`: ${sizes}`:''}. Choose which version to keep.`});
    }else if(item.kind==='take')children.push(diffNode(`Changes to ${item.path}`,mine?.text??'',theirs?.text??''));
    else{
      const base=entry.base?.text;
      if(base!==undefined&&base!==null){
        if(mine)children.push(diffNode(`Your changes to ${item.path}`,base,mine.text));
        if(theirs)children.push(diffNode(`Changes on ${host.name} to ${item.path}`,base,theirs.text));
      }else children.push(diffNode(`Differences between yours and ${host.name}’s ${item.path}`,mine?.text??'',theirs?.text??''));
    }
    let options;
    if(item.kind==='take')options=[{value:'apply',label:item.remoteState==='removed'?'Delete it here too':item.remoteState==='added'?'Add it here':'Apply this change'},{value:'skip',label:'Not now'}];
    else{
      options=[{value:'mine',label:item.localState==='deleted'?'Keep it deleted':'Keep mine'},{value:'theirs',label:theirs?'Take theirs':'Delete it here too'}];
      if(text&&mine&&theirs&&entry.base){const merged=merge3(entry.base.text??'',mine.text,theirs.text);if(merged.clean)options.push({value:'merged',label:'Combine both (they changed different lines)'});}
      if(text&&mine&&theirs)options.push({value:'edit',label:'Edit the result'});
    }
    children.push({type:'choice',id:`c${i}`,label:`Choice for ${item.path}`,options,value:choices[i]});
    if(choices[i]==='edit'){
      const start=edits[i]??merge3(entry.base?.text??'',mine.text,theirs.text,{labels:{mine:'mine (this project)',base:'base (last sync)',theirs:`theirs (${host.name})`}}).text;
      edits[i]??=start;
      children.push({type:'field',id:`e${i}`,input:'textarea',label:`Result for ${item.path}`,value:start,version:version,rows:14,help:'Edit the file as it should be. Remove every <<<<<<<, ||||||| , ======= and >>>>>>> line Scribyra added.'});
    }
    return {type:'group',legend:item.path,legendCode:true,tone:item.kind==='conflict'?'conflict':undefined,kind:item.kind,children};
  };
  const spec=()=>({title:`Pull from ${host.name}`,wide:true,children:[
    {type:'text',tone:'source',text:`${link.repository}${link.subfolder?`/${link.subfolder}`:''} · ${link.branch} · ${short(link.sync?.commit)||'first pull'} → ${short(head)}`},
    {type:'text',text:`${plural(items.length,'file')} changed on ${host.name} since your last sync${conflicts?`; ${plural(conflicts,'of them was','of them were')} also changed here. Choose for each conflict: nothing is overwritten unless you say so`:''}. Nothing changes until you apply.${mode==='reviewing'?' You are Reviewing: text changes become suggestions credited to this plugin; added, deleted and binary files wait for Editing.':''}`},
    ...(conflicts?[{type:'section',label:'Conflicts',children:items.map((item,i)=>item.kind==='conflict'?node(item,i):null).filter(Boolean)}]:[]),
    ...(items.length>conflicts?[{type:'section',label:'Changes',children:items.map((item,i)=>item.kind==='take'?node(item,i):null).filter(Boolean)}]:[]),
    ...(skipped.length?[{type:'heading',text:'Not synced'},{type:'list',label:'Not synced',items:skipped.slice(0,200).map(item=>({title:item.path,detail:SKIP_REASONS[item.reason]||item.reason}))}]:[]),
    {type:'status',id:'status',text:status},
    {type:'actions',buttons:[{id:'cancel',label:'Cancel'},{id:'none',label:'Apply none'},{id:'apply',label:mode==='reviewing'?'Suggest selected':'Apply selected',primary:true}]},
  ]});
  return runDialog(scribyra,{spec,async onEvent(event,dialog){
    for(const [key,value]of Object.entries(event.values||{})){
      if(/^c\d+$/.test(key))choices[+key.slice(1)]=value;
      if(/^e\d+$/.test(key))edits[+key.slice(1)]=value;
    }
    if(event.type==='cancel'||event.type==='click'&&event.control==='cancel'){dialog.close(null);return;}
    if(event.type==='change'&&/^c\d+$/.test(event.control)){await dialog.update();return;}
    if(event.type==='click'&&event.control==='none'){for(let i=0;i<items.length;i++)if(items[i].kind==='take')choices[i]='skip';version++;await dialog.update();return;}
    if(event.type==='click'&&event.control==='apply'){
      const open=items.findIndex((item,i)=>!choices[i]);
      if(open>=0){status=`Choose what to do with ${items[open].path} first.`;await dialog.update();return;}
      const marked=items.findIndex((item,i)=>choices[i]==='edit'&&/^(<{7}|\|{7}|={7}|>{7})( |$)/m.test(edits[i]||''));
      if(marked>=0){status=`${items[marked].path} still has conflict markers. Edit them out first.`;await dialog.update();return;}
      dialog.close({choices:[...choices],edits:[...edits]});
    }
  }});
}

// ---- Push -----------------------------------------------------------------------------
async function push(){
  const open=await context(),blocked=modeBlocked(open.mode,'push')||(open.project.transient?'Accept and save this project before pushing.':'');
  if(blocked){await notify(blocked);return;}
  if(!link){await linkDialog();return;}
  if(!open.online){await notify('This device is offline. Push needs a connection.');return;}
  const host=hostOf(link),remote=client(link),head=await remote.head(link.branch);
  if(head!==(link.sync?.commit||null)){
    await save({...link,sync:{...link.sync,behind:head?Math.max(1,link.sync?.behind||0):link.sync?.behind,checkedAt:Date.now()}});
    await notify(head?`${link.branch} on ${host.name} moved since your last sync (${short(link.sync?.commit)||'never synced'} → ${short(head)}). Pull first; Scribyra never force-pushes.`:`${host.name} has no branch ${link.branch} any more.`);return;
  }
  const local=await localFiles(),excluded=await exclusions(local),plan=planPush({records,local,excluded});
  if(plan.behind.length){await notify(`Pull first: ${plural(plan.behind.length,'file')} changed on ${host.name} that you have not taken yet (${plan.behind.slice(0,3).join(', ')}${plan.behind.length>3?'…':''}).`);return;}
  if(!plan.items.length){await notify(`Nothing to push: the project matches ${link.branch} at ${short(head)}.${plan.excluded.length?` ${plural(plan.excluded.length,'excluded file')} stay here.`:''}`);return;}
  const items=[];
  for(const item of plan.items){
    const content=item.file?await readFile(item.file):null,problem=content?secretProblem(item.path,content.text):null;
    let base=null;
    if(item.record?.base&&(content?.text!==null||!item.file)&&items.length<60&&(!item.file||!item.file.binary)){try{const bytes=await remote.blob(item.record.base);base=decodeText(bytes);}catch{base=null;}}
    items.push({...item,content,base,problem,tooLarge:content&&content.bytes.length>PUSH_FILE_BYTES});
  }
  const decision=await pushDialog({items,host,excludedPaths:plan.excluded,head});
  if(!decision)return;
  const now=await context(),again=modeBlocked(now.mode,'push');if(again)throw new Error(again);
  const chosen=items.filter((item,i)=>decision.include[i]);
  // What is pushed is what was reviewed: a file edited meanwhile stops the push.
  const fresh=await localFiles();
  for(const item of chosen){const file=fresh.get(item.path);if((file?.hash??null)!==(item.file?.hash??null))throw new Error(`${item.path} changed while you reviewed the push. Nothing was pushed; push again.`);}
  const latest=await remote.head(link.branch);
  if(latest!==head)throw new HostError('moved',`${link.branch} on ${host.name} moved while you reviewed the push. Nothing was pushed. Pull, then push again.`);
  const changes=chosen.map(item=>({path:toRepoPath(link.subfolder,item.path),op:item.op,mode:item.record?.mode||'100644',...(item.content?{bytes:item.content.bytes,...(item.content.text!==null?{text:item.content.text}:{})}:{})}));
  const target=decision.newBranch||link.branch;
  await notify(`Pushing ${plural(changes.length,'file')} to ${target} on ${host.name}…`);
  const result=await remote.push({branch:link.branch,newBranch:decision.newBranch,base:head,baseTree:link.sync?.tree,message:decision.message,changes});
  if(result.parents.length&&result.parents[0]!==head){
    // GitLab applied the commit on top of someone else's (no file overlapped). Their
    // changes are not here yet, so the link stays where it was: the next pull brings both.
    await notify(`Pushed to ${target} as ${short(result.commit)}, but someone else pushed at the same time. Pull to bring their changes in.`);
    await save({...link,sync:{...link.sync,behind:1,checkedAt:Date.now()}});return;
  }
  const pushed=chosen.map(item=>({path:item.path,op:item.op,sha:item.content?gitBlobId(item.content.bytes):null,mode:item.record?.mode||'100644',hash:item.file?.hash||null}));
  const tree=result.tree||(link.kind==='github'?null:link.sync?.tree);
  await save({...link,branch:target,sync:{commit:result.commit,tree,at:Date.now(),behind:0,checkedAt:Date.now()}},recordsAfterPush({records,pushed}));
  const left=items.length-chosen.length;
  await notify(`Pushed ${plural(chosen.length,'file')} to ${target} on ${host.name} as ${short(result.commit)}.${decision.newBranch?` This project now follows ${target}.`:''}${left?` ${plural(left,'change')} stay here, not pushed.`:''}`);
}

function pushDialog({items,host,excludedPaths,head}){
  const include=items.map(item=>!item.problem&&!item.tooLarge);
  let message='',target='branch',newBranch='',status='';
  const OP={add:['Added here','added'],update:['Changed here','changed'],delete:['Deleted here','removed']};
  const spec=()=>({title:`Push to ${host.name}`,wide:true,initialFocus:'message',children:[
    {type:'text',tone:'source',text:`${link.repository}${link.subfolder?`/${link.subfolder}`:''} · ${link.branch} at ${short(head)||'—'}`},
    {type:'text',text:`Commits the files you tick as one commit on top of ${short(head)}. If anyone pushes before you, ${host.name} refuses it and nothing changes there: Scribyra never force-pushes. Comments, reviews and history stay on this device.`},
    {type:'field',id:'message',input:'text',label:'Commit message',value:message,placeholder:'Describe your changes'},
    {type:'choice',id:'target',label:'Where to push',options:[{value:'branch',label:`To ${link.branch}`},{value:'new',label:'To a new branch'}],value:target},
    ...(target==='new'?[{type:'field',id:'newbranch',input:'text',label:'New branch name',value:newBranch,placeholder:'scribyra/my-changes',help:`It starts at ${short(head)}; this project then follows it.`}]:[]),
    {type:'section',label:'Files',children:items.map((item,i)=>{
      const [label,tone]=OP[item.op],children=[{type:'badges',items:[{text:label,tone},...(item.content&&item.content.text===null?[{text:'Binary',tone:'neutral'}]:[])]}];
      if(item.problem)children.push({type:'text',tone:'warning',text:item.problem.reason});
      if(item.tooLarge)children.push({type:'text',tone:'warning',text:`Larger than ${PUSH_FILE_BYTES/1024/1024} MiB, more than Scribyra sends in one request. Push it with Git instead.`});
      if(item.content?.text!==null&&item.content?.text!==undefined)children.push(diffNode(`Changes to ${item.path}`,item.base??'',item.content.text));
      else if(item.op==='delete'&&item.base!==null)children.push(diffNode(`Changes to ${item.path}`,item.base,''));
      else if(item.content)children.push({type:'text',tone:'summary',text:`Binary file, ${size(item.content.bytes.length)}.`});
      children.push({type:'field',id:`p${i}`,input:'checkbox',label:`Include ${item.path}`,value:include[i],disabled:!!item.problem?.block||item.tooLarge});
      return {type:'group',legend:item.path,legendCode:true,kind:item.op,children};
    })},
    ...(excludedPaths.length?[{type:'details',summary:`${plural(excludedPaths.length,'excluded file')} (.scribyraignore or settings)`,text:excludedPaths.join('\n')}]:[]),
    {type:'status',id:'status',text:status},
    {type:'actions',buttons:[{id:'cancel',label:'Cancel'},{id:'push',label:'Push',primary:true}]},
  ]});
  return runDialog(scribyra,{spec,async onEvent(event,dialog){
    const values=event.values||{};
    if(typeof values.message==='string')message=values.message;if(typeof values.target==='string')target=values.target;if(typeof values.newbranch==='string')newBranch=values.newbranch;
    for(let i=0;i<items.length;i++)if(typeof values[`p${i}`]==='boolean')include[i]=values[`p${i}`]&&!items[i].problem?.block&&!items[i].tooLarge;
    if(event.type==='cancel'||event.type==='click'&&event.control==='cancel'){dialog.close(null);return;}
    if(event.type==='change'&&event.control==='target'){await dialog.update();return;}
    if(event.type==='click'&&event.control==='push'){
      const problem=!message.trim()?'Write a commit message.':!include.some(Boolean)?'Tick at least one file.':target==='new'&&!validBranch(newBranch.trim())?'Enter a valid new branch name, like scribyra/my-changes.':'';
      if(problem){status=problem;await dialog.update();return;}
      dialog.close({message:message.trim().slice(0,5000),newBranch:target==='new'?newBranch.trim():null,include:[...include]});
    }
  }});
}

// ---- More tools → GitHub and GitLab ---------------------------------------------------
async function panel(){
  const open=await context();
  let accounts=await store.accounts().catch(()=>[]),status='';
  const source=link?null:await importSource();
  const spec=()=>{
    const children=[];
    if(link){
      const sync=link.sync||{};
      children.push(
        {type:'text',tone:'source',text:`${repoUrl(link)} · ${link.branch}${link.subfolder?` · folder ${link.subfolder}`:''}`},
        {type:'text',text:`Last sync ${ago(sync.at)}${sync.commit?` at ${short(sync.commit)}`:' (never pulled)'}.${modeBlocked(open.mode,'pull or push')?` ${modeBlocked(open.mode,'pull or push')}`:''}`},
        {type:'field',id:'excludes',input:'textarea',rows:4,label:'Never sync these files (one pattern per line, as in .gitignore)',value:(link.excludes||[]).join('\n'),help:'Added to the project’s own .scribyraignore. Excluded files are neither pulled nor pushed.'},
        {type:'field',id:'checkOnOpen',input:'checkbox',label:`Ask ${hostOf(link).name} for new commits when this project opens`,value:!!link.checkOnOpen},
        {type:'actions',buttons:[{id:'save',label:'Save settings'},{id:'unlink',label:'Unlink',danger:true}]},
      );
    }else{
      children.push({type:'text',text:'This project is not linked to a repository.'});
      if(source)children.push({type:'text',tone:'source',text:`It was imported from ${source.host}/${source.repo}${source.path?` (folder ${source.path})`:''}.`});
    }
    children.push({type:'heading',text:'Tokens on this device'},
      {type:'list',label:'Tokens on this device',empty:'No access token is saved on this device.',items:accounts.map((account,i)=>({title:`${account.login||'Account'} · ${account.origin}`,detail:`Saved ${ago(account.savedAt)}`,actions:[{id:`token-${i}`,label:'Remove token',ariaLabel:`Remove token for ${account.login||account.origin}`}]}))},
      {type:'status',id:'status',text:status},
      {type:'actions',buttons:link?[{id:'close',label:'Close'},{id:'check',label:'Check'},{id:'push',label:'Push…'},{id:'pull',label:'Pull…',primary:true}]:[{id:'close',label:'Close'},...(source?[{id:'link-source',label:'Link to this repository'}]:[]),{id:'link',label:'Link to a repository…',primary:!source}]});
    return {title:'GitHub and GitLab',children};
  };
  const next=await runDialog(scribyra,{spec,async onEvent(event,dialog){
    if(event.type==='cancel'||event.type==='click'&&event.control==='close'){dialog.close(null);return;}
    if(event.type!=='click')return;
    if(['pull','push','check','link','link-source'].includes(event.control)){dialog.close({action:event.control});return;}
    if(event.control==='save'){
      const lines=String(event.values.excludes||'').split('\n').map(line=>line.trimEnd()).filter(Boolean).slice(0,200);
      await save({...link,excludes:lines,checkOnOpen:!!event.values.checkOnOpen});status='Settings saved.';await dialog.update();return;
    }
    if(event.control==='unlink'){const was=repoUrl(link);await store.unlink();link=null;records={};scheduleStatus(0);status=`No longer linked to ${was}. The files stay as they are.`;await dialog.update();return;}
    const match=/^token-(\d+)$/.exec(event.control);
    if(match){const account=accounts[+match[1]];await store.removeToken(account.name);accounts=accounts.filter(item=>item!==account);status='Token removed from this device. Pulling and pushing ask for one again.';await dialog.update();}
  }});
  if(next?.action)await run(next.action);
}

/** A link whose token is not on this device (removed, or a backup restored elsewhere). */
async function tokenMissing(){
  if(!link||(await store.accounts()).some(account=>account.name===link.account))return false;
  const host=hostOf(link);let status='',version=0;
  const saved=await runDialog(scribyra,{spec:()=>({title:`${host.name} access token needed`,initialFocus:'token',children:[
    {type:'text',text:`This device has no access token for ${repoUrl(link)}. Enter one; it is kept only on this device, bound to ${host.origin}. The link and its sync state stay as they are.`},
    {type:'field',id:'token',input:'password',label:'Access token',value:'',version,submit:'save',help:TOKEN_HELP[link.kind==='github'?'github':'gitlab'](host)},
    {type:'status',id:'status',text:status},
    {type:'actions',buttons:[{id:'cancel',label:'Cancel'},{id:'save',label:'Save token',primary:true}]},
  ]}),async onEvent(event,dialog){
    if(event.type==='cancel'||event.type==='click'&&event.control==='cancel'){dialog.close(false);return;}
    if(event.type!=='click'||event.control!=='save')return;
    const token=String(event.values.token||'').trim();version++;
    if(!/^[\x21-\x7e]{8,400}$/.test(token)){status='That does not look like an access token.';await dialog.update();return;}
    await store.saveToken({kind:link.kind,origin:link.origin,token,name:link.account});
    try{const account=await client(link).account();await store.setLogin(link.account,account.login);dialog.close(true);}
    catch(error){await store.removeToken(link.account).catch(()=>{});status=error.message;await dialog.update();}
  }});
  return !saved;
}
async function run(action){
  if(action==='pull'){if(!await tokenMissing())await pull();}
  else if(action==='push'){if(!await tokenMissing())await push();}
  else if(action==='check'){if(!await tokenMissing())await check();}
  else if(action==='link')await linkDialog();
  else if(action==='link-source')await linkDialog({prefill:true});
  else if(action==='dismiss'){await store.dismiss();scheduleStatus(0);}
  else if(action==='open')await panel();
}

// Failures are explained to the person here; plugins never report to telemetry.
const quiet=task=>async(...args)=>{try{return await task(...args);}catch(error){if(error?.name!=='AbortError')await notify(error?.message||String(error));}finally{scheduleStatus(0);}return null;};
scribyra.on('project.opened',()=>{opened=true;blobIds.clear();void load();});
scribyra.on('project.closed',()=>{opened=false;link=null;records={};});
scribyra.on('project.changed',()=>scheduleStatus(1500));
scribyra.on('project.mode',()=>scheduleStatus(0));
scribyra.handle('command.run',quiet(async({command})=>{if(command==='open')await panel();}));
scribyra.handle('status.run',quiet(async({action})=>run(action)));
