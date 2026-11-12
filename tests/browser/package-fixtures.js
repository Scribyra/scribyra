import {readFileSync} from 'node:fs';
const romanian=[...readFileSync(new URL('../fixtures/tex-packages/babel-romanian.tar.xz',import.meta.url))];
// Keep the production checksum, unpacking and cache path; only the mirror response is local.
export async function romanianPackage(page){
 await page.addInitScript(bytes=>{
  const original=window.fetch.bind(window);
  window.fetch=async(input,options)=>{
   const url=input instanceof Request?input.url:String(input);
   if(url!=='https://tlnet.yihui.org/archive/babel-romanian.tar.xz')return original(input,options);
   if(!navigator.onLine)throw new Error('Unexpected offline package fetch');
   return new Response(new Uint8Array(bytes),{headers:{'Content-Type':'application/octet-stream'}});
  };
 },romanian);
}
