// A staging build (release dev-<number>-<sha>, served at dev.scribyra.com) shows a
// permanent "Staging" badge and prefixes the tab title, so nobody mistakes it for
// production. Production and local builds show nothing.
export const STAGING_TITLE_PREFIX='Staging · ';
export function isStagingRelease(release){return typeof release==='string'&&/^dev-[1-9]\d{0,11}-[a-f0-9]{7,40}$/.test(release);}
export function stagingMarker(release,{document:doc=globalThis.document}={}){
  if(!isStagingRelease(release)||!doc?.body)return null;
  const badge=doc.createElement('div');badge.className='staging-marker';badge.setAttribute('role','note');badge.setAttribute('aria-label','Staging build');
  badge.textContent='Staging';badge.title=`Staging build ${release}. Projects here are separate from app.scribyra.com and may be reset.`;
  doc.body.append(badge);doc.documentElement.dataset.scribyraStaging='1';
  // The app retitles the tab per project; keep the prefix on every title it sets.
  const prefix=()=>{if(!doc.title.startsWith(STAGING_TITLE_PREFIX))doc.title=STAGING_TITLE_PREFIX+doc.title;};prefix();
  if(typeof MutationObserver==='function'){const title=doc.querySelector('title');if(title)new MutationObserver(prefix).observe(title,{childList:true,characterData:true,subtree:true});}
  return badge;
}
