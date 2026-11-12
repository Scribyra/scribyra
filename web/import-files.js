import { assertPath, isText, MAX_BYTES, MAX_FILES } from './model.js';
import {private_folder_state_path} from './pkg/scribyra_app.js';

// Browser permissions and directory enumeration stay here; all mutations pass through
// the same atomic project command after every entry has been read and validated.
function collector() {
  const entries=[];let files=0,bytes=0;
  return {
    entries,
    add(entry) {
      assertPath(entry.path);
      if(private_folder_state_path(entry.path))return;
      if(entries.length>=1024)throw new Error('Import exceeds 1024 files and folders.');
      if(!entry.folder) {
        if(++files>MAX_FILES)throw new Error('Import exceeds 512 files.');
        if(!Number.isSafeInteger(entry.file.size)||entry.file.size<0)throw new Error('Invalid file size.');
        bytes+=entry.file.size;if(bytes>MAX_BYTES)throw new Error('Import exceeds 64 MiB.');
      }
      entries.push(entry);
    },
  };
}
async function decode(entries) {
  const result=[];let total=0;
  for(const entry of entries) {
    if(entry.folder){result.push({path:entry.path,folder:true});continue;}
    const bytes=new Uint8Array(await entry.file.arrayBuffer());total+=bytes.length;
    if(total>MAX_BYTES)throw new Error('Import exceeds 64 MiB.');
    let content=bytes;
    if(isText(entry.path)) {
      try{content=new TextDecoder('utf-8',{fatal:true}).decode(bytes);}
      catch{throw new Error(`“${entry.path}” is not valid UTF-8 text. Convert its encoding before importing.`);}
    }
    result.push({path:entry.path,content});
  }
  return result;
}
export async function readBrowserFiles(files,prefix='',relative=false) {
  const collection=collector();
  for(const file of files)collection.add({path:prefix+(relative&&file.webkitRelativePath||file.name),file});
  return decode(collection.entries);
}
export async function readDirectory(handle,prefix='') {
  const collection=collector();
  async function visit(item,parent) {
    const path=parent+item.name;
    if(private_folder_state_path(path))return;
    if(item.kind==='directory') {
      collection.add({path,folder:true});
      for await(const child of item.values())await visit(child,path+'/');
    }else if(item.kind==='file')collection.add({path,file:await item.getFile()});
    else throw new Error('Unsupported directory entry.');
  }
  await visit(handle,prefix);return decode(collection.entries);
}
export async function readDroppedFiles(transfer,prefix='') {
  // Capture entries inside the drop event, before the protected transfer store expires.
  const roots=[...(transfer.items||[])].filter(item=>item.kind==='file').map(item=>({entry:item.webkitGetAsEntry?.(),file:item.getAsFile()}));
  if(!roots.length)return readBrowserFiles([...transfer.files],prefix);
  const collection=collector();
  async function visit(entry,parent) {
    const path=parent+entry.name;
    if(private_folder_state_path(path))return;
    if(entry.isDirectory) {
      collection.add({path,folder:true});const reader=entry.createReader();
      // Chromium returns batches of at most 100 entries: read until empty.
      while(true){const batch=await new Promise((resolve,reject)=>reader.readEntries(resolve,reject));if(!batch.length)break;for(const child of batch)await visit(child,path+'/');}
    }else if(entry.isFile)collection.add({path,file:await new Promise((resolve,reject)=>entry.file(resolve,reject))});
    else throw new Error('Unsupported dropped entry.');
  }
  for(const root of roots){if(root.entry?.isDirectory)await visit(root.entry,prefix);else if(root.file)collection.add({path:prefix+root.file.name,file:root.file});else if(root.entry)await visit(root.entry,prefix);else throw new Error('This browser could not read the dropped item. Use folder or ZIP import.');}
  return decode(collection.entries);
}
