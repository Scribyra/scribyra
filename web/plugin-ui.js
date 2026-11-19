// The Plugins manager (More tools → Plugins), the consent dialog and the file picker a
// plugin may ask for (docs/plugins.md#flows). These are Scribyra's own dialogs: plugins
// never draw here. The official registry is loaded only when the person chooses Browse.
import {restoreDialogFocus} from './input.js';
import {describePermissions,PluginError} from './plugin-manifest.js';
import {developerMode,setDeveloperMode} from './plugin-store.js';

function el(tag,props={},...children){
  const node=document.createElement(tag);
  for(const [key,value]of Object.entries(props)){
    if(value===undefined||value===null||value===false)continue;
    if(key==='className')node.className=value;else if(key==='text')node.textContent=value;else if(key.startsWith('on'))node.addEventListener(key.slice(2),value);else if(key==='checked'||key==='disabled'||key==='value')node[key]=value;else node.setAttribute(key,value===true?'':value);
  }
  for(const child of children.flat())if(child!==null&&child!==undefined&&child!==false)node.append(child);
  return node;
}
// replaceChildren would turn a skipped (null) part into the text “null”.
const present=(...nodes)=>nodes.filter(node=>node!==null&&node!==undefined&&node!==false);
const button=(text,onclick,{primary=false,danger=false,...props}={})=>el('button',{type:'button',className:`button ${primary?'primary':'secondary'}${danger?' danger':''}`,text,onclick,...props});
const sourceText=(source,url)=>source==='official'?'From the official Scribyra plugin registry. Its signature and checksum were verified.':`From ${url||'a URL'} in developer mode.`;

function permissionList(permissions,{label='Permissions'}={}){
  const lines=describePermissions(permissions);
  if(!lines.length)return el('p',{className:'plugin-text tone-muted',text:'It asks for no permissions: it cannot read your project, contact any address or keep secrets.'});
  return el('ul',{className:'plugin-permissions','aria-label':label},lines.map(line=>el('li',{'data-permission':line.key},el('span',{text:line.text}),line.detail?el('small',{text:line.detail}):null)));
}

/**
 * Asks before installing or updating. `added` lists only what is new for an update.
 * Resolves to true when the person agrees.
 */
export function consentDialog({manifest,source,sourceUrl,sha256,existing=null,added,regrant=false}){
  return new Promise(resolve=>{
    const update=!!existing,newOnly=update&&Object.keys(added).length>0;
    const title=regrant?`Allow ${manifest.name} again?`:update?`Update ${manifest.name} to ${manifest.version}?`:`Install ${manifest.name}?`;
    const dialog=el('dialog',{className:'modal plugin-consent','aria-label':title});restoreDialogFocus(dialog);
    const finish=value=>{dialog.close();dialog.remove();resolve(value);};
    dialog.append(...present(
      el('h2',{text:title}),
      el('p',{className:'plugin-meta',text:`${manifest.name} ${manifest.version} · by ${manifest.publisher}${update&&!regrant?` · now ${existing.version}`:''}`}),
      manifest.description?el('p',{text:manifest.description}):null,
      source==='developer'?el('div',{className:'plugin-warning',role:'alert'},
        el('strong',{text:'Not reviewed by Scribyra.'}),
        el('p',{text:`This plugin comes from ${sourceUrl} and is not signed. Install it only if you trust its author and have read its code. It runs in a sandbox, but whatever you allow below, it can do.`}),
        el('p',{className:'plugin-hash'},'SHA-256 ',el('code',{text:sha256}))):el('p',{className:'plugin-text tone-note',text:sourceText(source)}),
      el('h3',{text:regrant?'It will be able to:':newOnly?'This version asks for more:':update?'It asks for nothing new.':'It will be able to:'}),
      newOnly||!update?permissionList(newOnly?added:manifest.permissions,{label:newOnly?'New permissions':'Permissions'}):null,
      el('p',{className:'plugin-text tone-muted',text:'It runs in a sandbox: it cannot see your other projects, this browser’s storage, other plugins’ data, or any address not listed. You can revoke permissions, disable or uninstall it anytime in More tools → Plugins.'}),
      el('div',{className:'modal-actions'},button('Cancel',()=>finish(false)),button(regrant?'Allow':update?'Update':'Install',()=>finish(true),{primary:true}))));
    dialog.addEventListener('cancel',event=>{event.preventDefault();finish(false);});
    document.body.append(dialog);dialog.showModal();dialog.querySelector('.button.primary').focus();
  });
}

/** A small modal question above another modal dialog; resolves to true on confirm. */
function confirmDialog({title,message,label,danger=false}){
  return new Promise(resolve=>{
    const dialog=el('dialog',{className:'modal plugin-confirm','aria-label':title});restoreDialogFocus(dialog);
    const finish=value=>{dialog.close();dialog.remove();resolve(value);};
    dialog.append(el('h2',{text:title}),el('p',{text:message}),el('div',{className:'modal-actions'},button('Cancel',()=>finish(false)),button(label,()=>finish(true),{primary:true,danger})));
    dialog.addEventListener('cancel',event=>{event.preventDefault();finish(false);});
    document.body.append(dialog);dialog.showModal();dialog.querySelector('.button.secondary').focus();
  });
}

/** A file a plugin asked the person to choose; resolves to {id, path} or null. */
export function pickFileDialog({plugin,title,files,signal}){
  return new Promise(resolve=>{
    const dialog=el('dialog',{className:'modal plugin-pick','aria-label':title});restoreDialogFocus(dialog);
    const name=`plugin-pick-${Math.random().toString(36).slice(2)}`;
    const finish=value=>{dialog.close();dialog.remove();resolve(value);};
    const choices=files.map(file=>el('label',{className:'plugin-choice'},el('input',{type:'radio',name,value:file.id}),el('span',{text:file.path})));
    dialog.append(...present(el('h2',{text:title}),
      el('p',{text:`${plugin.name} asks you to choose a file. It will be able to read and change the file you choose; nothing else changes.`}),
      files.length?el('div',{className:'plugin-choices vertical',role:'radiogroup','aria-label':'Files'},choices):el('p',{className:'plugin-text tone-muted',text:'No file in this project fits.'}),
      el('div',{className:'modal-actions'},button('Cancel',()=>finish(null)),button('Choose file',()=>{const id=dialog.querySelector('input:checked')?.value;finish(files.find(file=>file.id===id)||null);},{primary:true}))));
    dialog.addEventListener('cancel',event=>{event.preventDefault();finish(null);});
    // The plugin stopped (disabled, revoked, uninstalled): its picker goes with it.
    signal?.addEventListener('abort',()=>{if(dialog.isConnected)finish(null);},{once:true});
    document.body.append(dialog);dialog.showModal();(dialog.querySelector('input')||dialog.querySelector('.button.primary')).focus();
  });
}

/**
 * More tools → Plugins. `system` is the plugin system; `catalog()` loads the official
 * registry module on demand; `fetchPackage(url)` reads a sideloaded package.
 */
export function pluginManager({system,catalog,fetchPackage,policy,notify}){
  return new Promise(resolve=>{
    let closed=false,busy=false,registry=null,browseError='';
    const dialog=el('dialog',{className:'modal plugin-manager','aria-label':'Plugins'});restoreDialogFocus(dialog);
    const status=el('p',{className:'plugin-status',role:'status','aria-live':'polite'});
    const installedList=el('ul',{className:'plugin-cards','aria-label':'Installed plugins'});
    const official=el('div',{className:'plugin-official'});
    const developer=el('div',{className:'plugin-developer'});
    const say=text=>{status.textContent=text;};
    async function work(task){
      if(busy)return;busy=true;dialog.setAttribute('aria-busy','true');
      try{await task();}catch(error){if(!closed)say(error instanceof PluginError||error?.message?error.message:String(error));}
      finally{busy=false;dialog.removeAttribute('aria-busy');if(!closed)await draw();}
    }
    // Keep focus on the control that was used when the lists are redrawn.
    function refocus(key){if(!key)return;const target=dialog.querySelector(`[data-focus="${CSS.escape(key)}"]`);if(target&&!target.disabled)target.focus();else dialog.querySelector('.plugin-manager-close')?.focus();}
    async function install(prepared,bytes){
      if(!await consentDialog({manifest:prepared.pkg.manifest,source:prepared.source,sourceUrl:prepared.sourceUrl,sha256:prepared.sha256,existing:prepared.existing,added:prepared.added})){say('Nothing was installed.');return;}
      const record=await system.commit(prepared,bytes);
      say(prepared.existing?`${record.manifest.name} updated to ${record.version}.`:`${record.manifest.name} ${record.version} installed and enabled.`);
    }
    async function installOfficial(plugin,entry){
      const {officialPackage}=await catalog();
      const {bytes}=await officialPackage(plugin,entry);
      await install(await system.prepare(bytes,{source:'official',expected:entry}),bytes);
    }
    async function draw(){
      const focusKey=dialog.contains(document.activeElement)?document.activeElement.dataset.focus:null;
      const records=await system.installed();
      installedList.replaceChildren(...(records.length?records.map(record=>{
        const name=record.manifest.name,entry=registry?.plugins.find(plugin=>plugin.id===record.id),newer=record.source==='official'?system.newerVersion(record,entry):null;
        const permissions=describePermissions(record.manifest.permissions);
        return el('li',{className:'plugin-card','data-plugin':record.id},
          el('div',{className:'plugin-card-head'},el('h4',{text:name}),el('span',{className:'plugin-meta',text:`${record.version} · ${record.manifest.publisher}`}),
            el('span',{className:`plugin-badge tone-${record.source==='official'?'neutral':'warning'}`,text:record.source==='official'?'Official':'Developer'}),
            record.blocked?el('span',{className:'plugin-badge tone-error',text:'Not running'}):null),
          record.manifest.description?el('p',{className:'plugin-text',text:record.manifest.description}):null,
          record.blocked&&record.enabled?el('p',{className:'plugin-text tone-warning',text:record.blocked}):null,
          el('label',{className:'plugin-switch'},el('input',{type:'checkbox',role:'switch',checked:record.enabled,'data-focus':`enable:${record.id}`,'aria-label':`Enable ${name}`,disabled:busy,onchange:event=>{const on=event.target.checked;void work(async()=>{await system.setEnabled(record.id,on);say(`${name} is ${on?'enabled':'disabled'}.`);});}}),el('span',{text:'Enabled'})),
          el('ul',{className:'plugin-permissions','aria-label':`Permissions of ${name}`},permissions.map(line=>{
            const granted=!!record.granted[line.key];
            return el('li',{'data-permission':line.key,'data-granted':String(granted)},el('span',{text:line.text}),
              granted?button('Revoke',()=>void work(async()=>{await system.revoke(record.id,line.key);say(`${name} can no longer: ${line.text.toLowerCase()}.`);}),{'aria-label':`Revoke: ${line.text}`,'data-focus':`perm:${record.id}:${line.key}`,disabled:busy})
                :el('span',{className:'plugin-revoked'},el('small',{text:'Revoked'}),button('Grant again',()=>void work(async()=>{
                  if(!await consentDialog({manifest:record.manifest,source:record.source,sourceUrl:record.sourceUrl,sha256:record.sha256,existing:{version:record.version},added:{[line.key]:record.manifest.permissions[line.key]},regrant:true}))return;
                  await system.grant(record.id,line.key);say(`${name} can again: ${line.text.toLowerCase()}.`);}),{'aria-label':`Grant again: ${line.text}`,'data-focus':`perm:${record.id}:${line.key}`,disabled:busy})));
          })),
          el('div',{className:'plugin-card-actions'},
            newer?button(`Update to ${newer.version}`,()=>void work(()=>installOfficial(entry,newer)),{primary:true,'data-focus':`update:${record.id}`,disabled:busy}):null,
            record.previous?button(`Roll back to ${record.previous.version}`,()=>void work(async()=>{const next=await system.rollback(record.id);say(`${name} rolled back to ${next.version}.`);}),{'data-focus':`rollback:${record.id}`,disabled:busy}):null,
            button('Uninstall',()=>void work(async()=>{
              if(!await confirmDialog({title:`Uninstall ${name}`,message:`${name} and everything it kept on this device go: its settings, its data for every project, and its secrets such as API keys. Files it created stay in your projects as ordinary files.`,label:'Uninstall',danger:true}))return;
              await system.uninstall(record.id);say(`${name} was uninstalled and its data and secrets were removed from this device.`);}),{danger:true,'aria-label':`Uninstall ${name}`,'data-focus':`uninstall:${record.id}`,disabled:busy})));
      }):[el('li',{className:'plugin-empty',text:'No plugins are installed in this browser.'})]));
      // Official registry: nothing is fetched until Browse.
      if(!registry)official.replaceChildren(...present(el('p',{className:'plugin-text',text:'Browse the plugins Scribyra publishes. Each is signed and checked before it is offered.'}),browseError?el('p',{className:'plugin-text tone-warning',text:browseError}):null,
        button('Browse official plugins',()=>void work(async()=>{browseError='';const {officialRegistry}=await catalog();try{registry=await officialRegistry();}catch(error){browseError=error.message;throw error;}say(`${registry.plugins.length} official ${registry.plugins.length===1?'plugin':'plugins'} available.`);}),{primary:!records.length,'data-focus':'browse',disabled:busy})));
      else official.replaceChildren(el('ul',{className:'plugin-cards','aria-label':'Official plugins'},registry.plugins.map(plugin=>{
        const latest=[...plugin.versions].filter(version=>version.compatible).sort((a,b)=>system.compare(b.version,a.version))[0],installed=records.find(record=>record.id===plugin.id);
        const reason=latest?system.policyReason({id:plugin.id,version:latest.version,sha256:latest.sha256,source:'official',action:installed?'update':'install'}):'This plugin needs a newer Scribyra.';
        return el('li',{className:'plugin-card','data-registry':plugin.id},
          el('div',{className:'plugin-card-head'},el('h4',{text:plugin.name}),el('span',{className:'plugin-meta',text:`${latest?.version||''} · ${plugin.publisher}`})),
          el('p',{className:'plugin-text',text:plugin.description}),
          reason?el('p',{className:'plugin-text tone-warning',text:reason}):null,
          el('div',{className:'plugin-card-actions'},installed?el('span',{className:'plugin-badge tone-neutral',text:`Installed · ${installed.version}`}):button(`Install ${plugin.name}`,()=>void work(()=>installOfficial(plugin,latest)),{primary:true,disabled:busy||!!reason,'data-focus':`install:${plugin.id}`})));
      })));
      const devOn=developerMode()&&policy.developerMode;
      developer.replaceChildren(...present(
        policy.developerMode?el('label',{className:'plugin-switch'},el('input',{type:'checkbox',role:'switch',checked:devOn,'data-focus':'developer',disabled:busy,onchange:event=>{const on=event.target.checked;void work(async()=>{setDeveloperMode(on);await system.refresh();say(on?'Developer mode is on. Only install plugins you trust.':'Developer mode is off. Plugins installed from a URL are stopped.');});}}),el('span',{text:'Developer mode'})):el('p',{className:'plugin-text tone-muted',text:'Your organisation does not allow developer mode.'}),
        devOn?el('div',{className:'plugin-warning',role:'note'},el('strong',{text:'Developer mode installs unreviewed code.'}),el('p',{text:'Plugins from a URL are not signed or reviewed by Scribyra. Anyone can publish one. Install only plugins you are developing or whose code you have read.'})):null,
        devOn?el('div',{className:'plugin-url'},el('label',{for:'plugin-url-input',text:'Plugin package URL'}),el('input',{id:'plugin-url-input',className:'input',type:'url',placeholder:'https://example.org/my-plugin-1.0.0.scribyra-plugin.json',autocomplete:'off',spellcheck:'false','data-focus':'url'}),
          button('Install from URL',()=>void work(async()=>{
            const value=dialog.querySelector('#plugin-url-input').value.trim();let url;try{url=new URL(value);}catch{throw new Error('Enter the full address of a .scribyra-plugin.json package.');}
            if(url.protocol!=='https:'&&!/^(127\.0\.0\.1|localhost)$/.test(url.hostname))throw new Error('Use an https:// address (or http://localhost while developing).');
            say(`Reading ${url.href}…`);const bytes=await fetchPackage(url.href);
            await install(await system.prepare(bytes,{source:'developer',sourceUrl:url.href}),bytes);
          }),{'data-focus':'install-url',disabled:busy})):null));
      refocus(focusKey);
    }
    const finish=()=>{if(closed)return;closed=true;dialog.close();dialog.remove();resolve();};
    dialog.addEventListener('cancel',event=>{event.preventDefault();finish();});
    const restricted=policy.allow||!policy.userInstall;
    dialog.append(...present(el('h2',{text:'Plugins'}),
      el('p',{text:'Plugins add features to Scribyra. Each one runs in a sandbox, apart from your projects and this browser’s storage, and can do only what you allow when you install it.'}),
      restricted?el('p',{className:'plugin-text tone-note',role:'note',text:'Your organisation chooses which plugins can be installed here.'}):null,
      el('section',{'aria-labelledby':'plugins-installed'},el('h3',{id:'plugins-installed',text:'Installed'}),installedList),
      el('section',{'aria-labelledby':'plugins-official'},el('h3',{id:'plugins-official',text:'Official plugins'}),official),
      el('section',{'aria-labelledby':'plugins-developer'},el('h3',{id:'plugins-developer',text:'Developer'}),developer),
      status,el('div',{className:'modal-actions'},button('Close',finish,{className:'button secondary plugin-manager-close'}))));
    document.body.append(dialog);dialog.showModal();
    void draw().then(()=>{if(!closed)(dialog.querySelector('.plugin-cards input[role=switch]')||dialog.querySelector('[data-focus="browse"]')||dialog.querySelector('.plugin-manager-close')).focus();});
  });
}
