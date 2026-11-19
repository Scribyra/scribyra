// The Zotero plugin's device-local data, kept by Scribyra for this plugin only
// (docs/plugins.md): accounts in `storage`, API keys as `secrets`, and one `projectData`
// entry per linked file of the open project. web/plugin-migration.js writes the same
// layout when it moves links and keys from the former built-in Zotero.
//
//   storage 'accounts'          {userId → {userId, username, write, savedAt}}
//   secrets 'key-<userId>'      the API key
//   projectData 'link:<fileId>' {fileId, userId, library, collection, format, version,
//                                items, textHash, linkedAt, refreshedAt}
export function zoteroStore(scribyra){
  const call=(method,params)=>scribyra.call(method,params);
  async function accounts(){return (await call('storage.get',{key:'accounts'}))||{};}
  return {
    async savedKey(userId){
      if(!userId)return null;const account=(await accounts())[String(userId)];if(!account)return null;
      const apiKey=await call('secrets.get',{name:`key-${userId}`});return apiKey?{...account,apiKey}:null;
    },
    /** Saved accounts without their keys, for listing. */
    async keys(){const all=await accounts(),names=new Set(await call('secrets.keys'));return Object.values(all).filter(account=>names.has(`key-${account.userId}`));},
    async anyKey(){const list=(await this.keys()).sort((a,b)=>b.savedAt-a.savedAt);return list.length?this.savedKey(list[0].userId):null;},
    async saveKey(record){
      const userId=String(record.userId),all=await accounts();
      await call('secrets.set',{name:`key-${userId}`,value:record.apiKey});
      all[userId]={userId,username:record.username||'',write:!!record.write,savedAt:Date.now()};
      await call('storage.set',{key:'accounts',value:all});
    },
    async removeKey(userId){
      await call('secrets.delete',{name:`key-${userId}`});
      const all=await accounts();delete all[String(userId)];await call('storage.set',{key:'accounts',value:all});
    },
    async link(fileId){return (await call('projectData.get',{key:`link:${fileId}`}))||null;},
    async links(){
      const keys=(await call('projectData.keys')).filter(key=>key.startsWith('link:'));
      return (await Promise.all(keys.map(key=>call('projectData.get',{key})))).filter(Boolean);
    },
    async saveLink(record){
      if('apiKey' in record)throw new Error('A Zotero link never holds the API key.');
      await call('projectData.set',{key:`link:${record.fileId}`,value:record});
    },
    async unlink(fileId){await call('projectData.delete',{key:`link:${fileId}`});},
  };
}
export async function textHash(text){
  const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map(byte=>byte.toString(16).padStart(2,'0')).join('');
}
