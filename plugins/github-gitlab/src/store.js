// The plugin's device-local data, kept by Scribyra for this plugin only (docs/plugins.md):
//
//   storage 'accounts'            {name → {name, kind, origin, login, savedAt}}
//   secrets '<name>'              the access token, bound to `origin`: Scribyra adds it to
//                                 requests to that origin and never hands it back
//   projectData 'link'            {version, kind, origin, repository, branch, subfolder,
//                                 account, excludes, checkOnOpen, linkedAt,
//                                 sync: {commit, tree, at, behind, checkedAt}}
//   projectData 'records'         {path → record} (src/sync.js)
//   projectData 'source-dismissed' true once the person said "Not now" to the offer
//
// None of it is part of the project, so none of it reaches history, backups, exports or
// a repository.
export function gitStore(scribyra){
  const call=(method,params)=>scribyra.call(method,params);
  const accounts=async()=>(await call('storage.get',{key:'accounts'}))||{};
  return {
    async accounts(){const all=await accounts(),names=new Set(await call('secrets.keys'));return Object.values(all).filter(account=>names.has(account.name));},
    async account(name){return name?(await this.accounts()).find(account=>account.name===name)||null:null;},
    /** Saves a token bound to its host's origin; returns the account name. */
    async saveToken({kind,origin,login,token,name}){
      const all=await accounts();
      name||=`token-${kind}-${Date.now().toString(36)}${Math.random().toString(36).slice(2,6)}`;
      await call('secrets.set',{name,value:token,origin});
      all[name]={name,kind,origin,login:login||'',savedAt:Date.now()};
      await call('storage.set',{key:'accounts',value:all});return name;
    },
    async setLogin(name,login){const all=await accounts();if(all[name]){all[name].login=login;await call('storage.set',{key:'accounts',value:all});}},
    async removeToken(name){await call('secrets.delete',{name});const all=await accounts();delete all[name];await call('storage.set',{key:'accounts',value:all});},
    async link(){return (await call('projectData.get',{key:'link'}))||null;},
    async records(){return (await call('projectData.get',{key:'records'}))||{};},
    async save(link,records){
      if(link&&('token' in link))throw new Error('A link never holds the token.');
      await call('projectData.set',{key:'link',value:link});
      if(records)await call('projectData.set',{key:'records',value:records});
    },
    async unlink(){await call('projectData.delete',{key:'link'});await call('projectData.delete',{key:'records'});},
    async dismissed(){return !!await call('projectData.get',{key:'source-dismissed'}).catch(()=>false);},
    async dismiss(){await call('projectData.set',{key:'source-dismissed',value:true});},
  };
}
