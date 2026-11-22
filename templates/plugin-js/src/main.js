// A Scribyra plugin in JavaScript (docs/plugins.md#writing-a-plugin).
//
// The code runs in a sandboxed Web Worker: no DOM, no network, no storage of the app.
// Everything goes through `scribyra`, the capability API, and only what manifest.json
// asks for (and the person allowed) is permitted:
//   scribyra.call(method, params)  → Promise; errors have .code (permission_denied, …)
//   scribyra.on(event, handler)    project.opened, project.closed, project.activeFile, project.mode, dialog.event
//   scribyra.handle(method, fn)    command.run, fileAction.run, fileBar.run
//   scribyra.files                 this package's files (text, or Uint8Array for .wasm)
// Modules and npm packages are fine: `node scripts/plugins.mjs pack <folder>` bundles
// src/main.js into one script. Note: crypto.subtle and crypto.randomUUID may be missing
// in the sandbox (Chromium does not treat it as a secure context).

/* global scribyra */
const words=text=>text
  .replace(/(^|[^\\])%.*$/gm,'$1')          // comments
  .replace(/\\[a-zA-Z@]+\*?/g,' ')           // commands
  .replace(/[{}[\]$&#^_~\\]/g,' ')           // TeX punctuation
  .split(/\s+/).filter(word=>/\p{L}/u.test(word)).length;

async function count(){
  const files=await scribyra.call('project.files');
  const rows=[];
  for(const file of files)rows.push([file.path,String(words((await scribyra.call('project.read',{fileId:file.id})).text))]);
  const total=rows.reduce((sum,row)=>sum+Number(row[1]),0);
  // A declarative dialog: Scribyra draws it in its own theme and sends events back.
  const {dialogId}=await scribyra.call('ui.dialog.open',{spec:{title:'Word count',children:[
    {type:'text',text:`${total} ${total===1?'word':'words'} in ${rows.length} TeX ${rows.length===1?'file':'files'}, without commands and comments.`},
    {type:'table',caption:'Words per file',columns:['File','Words'],rows},
    {type:'actions',buttons:[{id:'close',label:'Close',primary:true}]},
  ]}});
  await new Promise(resolve=>{
    const stop=scribyra.on('dialog.event',event=>{
      if(event.dialogId!==dialogId)return;
      if(event.type==='click'||event.type==='cancel'||event.type==='close'){stop();resolve();}
    });
  });
  await scribyra.call('ui.dialog.close',{dialogId});
}

scribyra.handle('command.run',async({command})=>{if(command==='count')await count();});
