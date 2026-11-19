// The JavaScript shim of a Rust/WebAssembly plugin (docs/plugins.md#writing-a-plugin).
// Build the module, then pack:
//   cargo build --release --target wasm32-unknown-unknown
//   mkdir -p assets && cp target/wasm32-unknown-unknown/release/word_count.wasm assets/
//   node ../../scripts/plugins.mjs pack .
// The module gets exactly the host imports passed below (here only env.log); all
// capability calls stay in this shim, so the WebAssembly code holds no authority.

/* global scribyra */
let instance=null;
async function wasm(){
  if(instance)return instance;
  const memory=()=>new Uint8Array(instance.exports.memory.buffer);
  const imports={env:{log:(ptr,len)=>{console.debug('[word count]',new TextDecoder().decode(memory().subarray(ptr,ptr+len)));}}};
  ({instance}=await WebAssembly.instantiate(scribyra.files['word_count.wasm'],imports));
  return instance;
}
async function countWords(text){
  const {exports}=await wasm(),bytes=new TextEncoder().encode(text),ptr=exports.alloc(bytes.length);
  new Uint8Array(exports.memory.buffer).set(bytes,ptr);
  try{return exports.count_words(ptr,bytes.length);}finally{exports.dealloc(ptr,bytes.length);}
}
scribyra.handle('command.run',async({command})=>{
  if(command!=='count')return;
  const rows=[];
  for(const file of await scribyra.call('project.files'))rows.push([file.path,String(await countWords((await scribyra.call('project.read',{fileId:file.id})).text))]);
  const total=rows.reduce((sum,row)=>sum+Number(row[1]),0);
  const {dialogId}=await scribyra.call('ui.dialog.open',{spec:{title:'Word count (Rust)',children:[
    {type:'text',text:`${total} ${total===1?'word':'words'}, counted in WebAssembly.`},
    {type:'table',caption:'Words per file',columns:['File','Words'],rows},
    {type:'actions',buttons:[{id:'close',label:'Close',primary:true}]},
  ]}});
  await new Promise(resolve=>{const stop=scribyra.on('dialog.event',event=>{if(event.dialogId===dialogId&&event.type!=='change'){stop();resolve();}});});
  await scribyra.call('ui.dialog.close',{dialogId});
});
