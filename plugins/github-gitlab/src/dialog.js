// The same small helper as the Zotero plugin’s (plugins/zotero/src/dialog.js) over the declarative dialog API: open a spec, route its events, update
// it and resolve when it closes. Scribyra renders and themes the dialog.
const sessions=new Map();
let listening=false;
export function runDialog(scribyra,{spec,onEvent}){
  if(!listening){listening=true;scribyra.on('dialog.event',event=>sessions.get(event.dialogId)?.(event));}
  return new Promise((resolve,reject)=>{
    let dialogId=null,done=false,queue=Promise.resolve();
    const control={
      update:()=>done||!dialogId?Promise.resolve():scribyra.call('ui.dialog.update',{dialogId,spec:spec()}).catch(()=>{}),
      close:value=>{if(done)return;done=true;sessions.delete(dialogId);if(dialogId)void scribyra.call('ui.dialog.close',{dialogId}).catch(()=>{});resolve(value);},
      get closed(){return done;},
    };
    scribyra.call('ui.dialog.open',{spec:spec()}).then(result=>{
      dialogId=result.dialogId;
      sessions.set(dialogId,event=>{
        // The host's Dismiss button closed it already.
        if(event.type==='close'){if(done)return;done=true;sessions.delete(dialogId);queue=queue.then(()=>onEvent(event,control)).catch(()=>{});resolve(control.dismissed??null);return;}
        queue=queue.then(()=>onEvent(event,control)).catch(error=>{reject(error);control.close(null);});
      });
    },reject);
  });
}
