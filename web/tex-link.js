export const TEX_LINK_LIMITS=Object.freeze({encoded:16384,source:65536});
const tooBig='TeX link is too big. Use at most 16,384 encoded characters and 65,536 UTF-8 source bytes. Import a ZIP for larger documents.';
const invalid='Invalid TeX link. Expected unpadded base64url of gzip-compressed UTF-8 source.';

// Consume before startup/telemetry, including rejected links. Never retain the
// URL in history state, storage, errors or project metadata.
export function takeTexFragment(browser){
 const hash=browser.location.hash;
 if(!hash.startsWith('#tex='))return null;
 browser.history.replaceState(null,'',browser.location.pathname+browser.location.search);
 return hash.length-5>TEX_LINK_LIMITS.encoded?{error:tooBig}:{encoded:hash.slice(5)};
}
export async function decodeTexSource(encoded){
 if(encoded.length>TEX_LINK_LIMITS.encoded)throw new Error(tooBig);
 if(!encoded||!/^[A-Za-z0-9_-]+$/.test(encoded)||encoded.length%4===1)throw new Error(invalid);
 let reader;
 try{
  const binary=atob(encoded.replaceAll('-','+').replaceAll('_','/'));
  if(btoa(binary).replaceAll('+','-').replaceAll('/','_').replace(/=+$/,'')!==encoded)throw new Error(invalid);
  const bytes=Uint8Array.from(binary,char=>char.charCodeAt(0));
  reader=new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip')).getReader();
  const chunks=[];let size=0;
  for(;;){
   const {done,value}=await reader.read();if(done)break;
   size+=value.length;if(size>TEX_LINK_LIMITS.source)throw new Error(tooBig);
   chunks.push(value);
  }
  const source=new Uint8Array(size);let offset=0;
  for(const chunk of chunks){source.set(chunk,offset);offset+=chunk.length;}
  const text=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(source);
  if(text.includes('\0'))throw new Error(invalid);
  return text;
 }catch(error){throw new Error(error.message===tooBig?tooBig:invalid);}
 finally{if(reader)await reader.cancel().catch(()=>{});}
}

export function texLinkEntry({initial,create,approve,compile,preferences=localStorage}){
 let current=null,allowed=false,banner,error='',pending=null,processing=false,started=false;
 const observer=new ResizeObserver(()=>document.documentElement.style.setProperty('--tex-link-height',`${banner?.offsetHeight||0}px`));
 const render=()=>{
  banner?.remove();banner=null;observer.disconnect();document.body.removeAttribute('data-tex-link');
  if(!current&&!error)return;
  banner=document.createElement('section');banner.className='tex-link-banner';banner.setAttribute('role','region');banner.setAttribute('aria-label','TeX link');
  const text=document.createElement('p');text.textContent=error||(allowed?'Scratch project from a TeX link. You allowed local saving and compilation in this session.':'Scratch project from a TeX link. Link content is untrusted. Nothing has compiled in this session. New links stay in memory until you accept. Review the source, then allow local saving and compilation in this browser.');banner.append(text);
  if(current&&!allowed){
   const button=document.createElement('button');button.className='button primary';button.textContent='Allow and compile';
   // Stop hostile links and synthetic clicks. An agent controlling real browser
   // input can approve through this DOM; this is not a boundary against that agent.
   button.addEventListener('click',async event=>{
    if(!event.isTrusted||button.disabled)return;
    const target=current;button.disabled=true;
    try{await approve();if(current!==target)return;allowed=true;error='';render();compile();}
    catch{if(current===target){error='Could not save the TeX link scratch project. Check local storage and try again.';render();}}
   });banner.append(button);
  }
  if(error){const dismiss=document.createElement('button');dismiss.className='button secondary';dismiss.textContent='Dismiss link message';dismiss.onclick=()=>{error='';render();};banner.append(dismiss);}
  document.body.prepend(banner);document.body.setAttribute('data-tex-link','');observer.observe(banner);
 };
 const accept=entry=>{
  if(!entry)return;
  // Coalesce rapid fragment changes: one decode and one pending link at most.
  pending=entry;if(processing)return;processing=true;
  void(async()=>{
   try{while(pending){
    const next=pending;pending=null;
    try{if(next.error)throw new Error(next.error);const source=await decodeTexSource(next.encoded);if(pending)continue;await create(source);error='';}
    catch(failure){error=[tooBig,invalid].includes(failure.message)?failure.message:'Could not open the TeX link scratch project. Try again.';}
    render();
   }}finally{processing=false;}
  })();
 };
 return{
  start(){if(started)return;started=true;accept(initial);initial=null;window.addEventListener('hashchange',()=>accept(takeTexFragment(window)));},
  mark(doc){doc.getMap('meta').set('texLinkOrigin','link');},
  open(id,doc){
   // Carry provenance in the document so every clone/recovery inherits it.
   // Recognize the earlier device marker when reopening an existing scratch.
   try{if(preferences.getItem(`scribyra:tex-link:${id}`)==='link')this.mark(doc);}catch{}
   current=doc.getMap('meta').get('texLinkOrigin')==='link'?doc:null;allowed=false;error='';render();
  },
  close(){current=null;allowed=false;render();},
  assertAllowed(){if(current&&!allowed)throw Object.assign(new Error('Review the TeX link source and click Allow and compile first.'),{code:'permission_denied'});},
 };
}
