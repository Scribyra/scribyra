// Tells an open tab, quietly, that a newer release has been deployed. Detection
// reads only the app's own release.json (same origin, no credentials, no cache);
// nothing is sent anywhere and nothing is recorded.
export const RELEASE_CHECK_INTERVAL_MS=30*60*1000,FOCUS_CHECK_GAP_MS=10*1000,KEPT_MESSAGE_MS=1600,FIRST_CHECK_DELAY_MS=30*1000,WORKER_SETTLE_MS=15*1000,RELOAD_WATCHDOG_MS=20*1000;
// Production releases are web-<pipeline IID>; staging builds (dev.scribyra.com) are
// dev-<pipeline IID>-<short revision>. Both channels order by the pipeline number, and a
// tab only ever compares releases of its own channel.
const RELEASE=/^(web)-([1-9]\d{0,11})$|^(dev)-([1-9]\d{0,11})-[a-f0-9]{7,40}$/,REVISION=/^[a-f0-9]{40}$/;

export function releaseLabel(value){const match=typeof value==='string'&&RELEASE.exec(value);return match?{channel:match[1]||match[3],number:Number(match[2]||match[4])}:null;}
export function releaseNumber(value){return releaseLabel(value)?.number??null;}
export function parseRelease(value){
  if(!value||typeof value!=='object')return null;
  const label=releaseLabel(value.release);if(label===null)return null;
  return{release:value.release,number:label.number,channel:label.channel,revision:typeof value.revision==='string'&&REVISION.test(value.revision)?value.revision:null};
}

// The running build's release is embedded at build time from the pipeline. A local
// build carries only its Git revision; it learns its own release number from the
// first release.json that names that revision, and never orders anything else.
export function releaseTracker({release=null,revision=null}={}){
  const label=releaseLabel(release);
  let current=label?.number??null,channel=label?.channel??null,dismissed=0;
  const own=typeof revision==='string'&&REVISION.test(revision)?revision:null;
  return{
    get current(){return current;},
    get channel(){return channel;},
    // Returns the newer release to announce, or null for the same, an older, an unknown
    // one, or one from the other channel (staging never announces production, nor back).
    observe(value){
      const seen=parseRelease(value);if(!seen)return null;
      if(current===null){if(own&&seen.revision===own){current=seen.number;channel=seen.channel;}return null;}
      if(seen.channel!==channel||seen.number<=current||(own&&seen.revision===own))return null;
      return seen.number>dismissed?seen:null;
    },
    dismiss(seen){if(seen)dismissed=Math.max(dismissed,seen.number);},
  };
}

// The service worker does not replace the running one by itself (no skipWaiting on
// install): a reload started just as a new worker takes over can be lost in Chromium,
// the navigation never answered and the tab frozen. Reload therefore hands over
// explicitly: wait for any update check and install in progress, ask the waiting
// worker to take over, and reload only once it controls this tab and is activated.
// That also moves every other open tab of the app to the new worker (they keep
// working and show their own notice); nothing else swaps workers while a tab is open.
// Resolves true when handed over or nothing is waiting; false on the time limit.
export const SKIP_WAITING='scribyra-skip-waiting';
export function handOver(registration,{serviceWorker=globalThis.navigator?.serviceWorker,updating=null,timeout=WORKER_SETTLE_MS,setTimer=setTimeout,clearTimer=clearTimeout}={}){
  return new Promise(resolve=>{
    let done=false,timer=null,watched=null,asked=null,changed=false;
    const unwatch=()=>{try{watched?.removeEventListener?.('statechange',look);}catch{}try{registration?.removeEventListener?.('updatefound',look);}catch{}watched=null;};
    const onChange=()=>{changed=true;look();};
    const finish=value=>{if(done)return;done=true;clearTimer(timer);unwatch();try{serviceWorker?.removeEventListener?.('controllerchange',onChange);}catch{}resolve(value);};
    const follow=worker=>{watched=worker;worker.addEventListener('statechange',look);registration.addEventListener?.('updatefound',look);};
    function look(){
      if(done)return;unwatch();
      try{
        if(asked&&asked.state!=='redundant'){
          if(asked.state==='activated'&&(changed||serviceWorker?.controller===asked)){finish(true);return;}
          follow(asked);return;
        }
        asked=null;
        const waiting=registration?.waiting;
        if(waiting){asked=waiting;follow(waiting);waiting.postMessage({type:SKIP_WAITING});return;}
        const installing=registration?.installing||(registration?.active?.state==='activating'?registration.active:null);
        if(installing){follow(installing);return;}
        finish(true);
      }catch{finish(true);}
    }
    try{serviceWorker?.addEventListener?.('controllerchange',onChange);}catch{}
    timer=setTimer(()=>finish(false),timeout);
    Promise.resolve(updating).catch(()=>{}).then(look);
  });
}

// Reloading ends this tab's part in a live direct session; the relay capability and the
// connection are not kept. While one is active, Reload says so and asks once more.
export const LEAVE_SESSION_TEXT='Reloading leaves the direct session. Your copy stays on this device; to rejoin, open the invite again and enter your relay capability.';
export function updateNotice({build,releaseUrl,beforeReload,inSession=()=>false,reload=()=>location.reload(),serviceWorker=globalThis.navigator?.serviceWorker,fetcher=(...args)=>fetch(...args),now=()=>Date.now()}){
  const tracker=releaseTracker(build||{});
  let pending=null,checking=null,lastCheck=-Infinity,reloading=false,registration=null,updating=null,element,message,status,reloadButton,stayButton,timer,confirming=false;
  const live=()=>{try{return!!inSession();}catch{return false;}};
  const hidden=()=>document.visibilityState==='hidden';
  function render(){
    if(!pending){element?.remove();element=null;return;}
    if(!element){
      element=document.createElement('aside');element.className='update-notice';element.setAttribute('aria-label','Update available');
      // One polite region; it announces without taking focus from the editor.
      message=document.createElement('p');message.className='update-notice-message';message.setAttribute('role','status');message.setAttribute('aria-live','polite');
      status=document.createElement('p');status.className='update-notice-detail';status.setAttribute('role','status');status.setAttribute('aria-live','polite');
      const actions=document.createElement('div');actions.className='update-notice-actions';
      reloadButton=document.createElement('button');reloadButton.type='button';reloadButton.className='button primary compact';reloadButton.textContent='Reload';reloadButton.onclick=()=>void reloadNow();
      stayButton=document.createElement('button');stayButton.type='button';stayButton.className='button secondary compact';stayButton.textContent='Stay in session';stayButton.onclick=()=>{confirming=false;say('');render();reloadButton.focus();};
      const close=document.createElement('button');close.type='button';close.className='icon-button update-notice-close';close.setAttribute('aria-label','Dismiss update notice');close.textContent='×';close.onclick=dismiss;
      actions.append(reloadButton,stayButton,close);element.append(message,status,actions);document.body.append(element);
      element.addEventListener('keydown',event=>{if(event.key==='Escape'&&!event.defaultPrevented){event.preventDefault();event.stopPropagation();dismiss();}});
      // Filled after insertion so assistive technology hears the change, not a new node.
      setTimeout(()=>{if(message)message.textContent='A new version of Scribyra is ready';},50);
    }
    place();
    const session=live();if(!session)confirming=false;
    reloadButton.textContent=session?(confirming?'Leave session and reload':'Reload and leave session'):'Reload';
    stayButton.hidden=!confirming;
    element.classList.toggle('update-notice-session',session);
    reloadButton.disabled=reloading;
  }
  // On a narrow screen the editor and preview fill the width; the notice sits over the
  // file list's lower end instead, stacked to the list's width.
  function place(){
    if(!element)return;
    const sidebar=document.querySelector('.workspace .file-sidebar'),box=sidebar?.getBoundingClientRect();
    const narrow=innerWidth<=740&&box&&box.width>=120&&getComputedStyle(sidebar).display!=='none';
    element.classList.toggle('update-notice-stacked',!!narrow);
    if(narrow){element.style.setProperty('--update-notice-left',`${Math.round(box.left)+6}px`);element.style.setProperty('--update-notice-width',`${Math.round(box.width)-12}px`);}
  }
  let placing=0;const replace=()=>{if(element&&!placing)placing=requestAnimationFrame(()=>{placing=0;if(element)render();});};
  window.addEventListener('resize',replace);window.addEventListener('scribyra:state',replace);
  function say(text){if(status)status.textContent=text;}
  function dismiss(){
    const focused=element?.contains(document.activeElement);tracker.dismiss(pending);pending=null;confirming=false;render();
    if(focused)document.querySelector('.cm-content')?.focus();
  }
  async function reloadNow(){
    if(reloading||!pending)return;
    // The first choice in a live session only explains; the second confirms leaving it.
    const session=live();
    if(session&&!confirming){confirming=true;render();say(LEAVE_SESSION_TEXT);return;}
    reloading=true;render();say('Saving your work before reloading…');
    try{
      const result=await beforeReload();
      if(!result?.ok){say(result?.reason||'Not reloaded.');return;}
      // Kept state is named first, so the person learns it survives the reload.
      if(result.kept){say(result.kept);await new Promise(resolve=>setTimeout(resolve,KEPT_MESSAGE_MS));}
      if(result.still&&!result.still()){say('Not reloaded. Your work changed meanwhile; choose Reload again.');return;}
      // A session that started after the choice was not confirmed for leaving.
      if(live()&&!session){say('Not reloaded. A direct session started meanwhile; reloading would leave it.');return;}
      // Hand the app to the new service worker first, so the reload is not lost in the swap.
      if(registration&&!await handOver(registration,{serviceWorker,updating})){say('Not reloaded. The new version is still being installed; choose Reload again in a moment.');return;}
      if(result.still&&!result.still()){say('Not reloaded. Your work changed meanwhile; choose Reload again.');return;}
      say(session?'Saved. Leaving the session and reloading…':'Saved. Reloading…');const undo=result.commit?.({leaveSession:session});
      // Stays 'reloading' while the page unloads. If the browser drops the reload, the
      // tab says so and takes back what the reload had relaxed (the leave warning).
      const left=new Promise(resolve=>{addEventListener('pagehide',resolve,{once:true});setTimeout(resolve,RELOAD_WATCHDOG_MS);});
      let gone=false;addEventListener('pagehide',()=>{gone=true;},{once:true});
      reload();await left;
      if(gone)return;
      try{undo?.();}catch{}
      say('The reload did not complete. Your work is saved; choose Reload again.');
    }catch(error){say(`Not reloaded: ${error?.message||String(error)}`);}
    finally{reloading=false;if(!live())confirming=false;if(element)render();}
  }
  async function check({force=false,gap=FOCUS_CHECK_GAP_MS}={}){
    // A hidden tab, an offline one, or one showing a dialog is left alone.
    if(hidden()||globalThis.navigator?.onLine===false||reloading||document.querySelector('dialog[open]'))return;
    if(!force&&now()-lastCheck<gap)return;
    if(checking)return checking;lastCheck=now();
    // Also let the browser look for a changed service worker; failures stay silent.
    if(!force)try{const update=registration?.update?.();if(update){const current=update.catch(()=>{});updating=current;void current.then(()=>{if(updating===current)updating=null;});}}catch{}
    checking=(async()=>{
      try{
        const response=await fetcher(releaseUrl,{cache:'no-store',credentials:'omit',mode:'same-origin',redirect:'error',headers:{Accept:'application/json'}});
        if(!response.ok||!/json/.test(response.headers.get('Content-Type')||''))return;
        const text=await response.text();if(text.length>4096)return;
        const seen=tracker.observe(JSON.parse(text));
        if(seen&&(!pending||seen.number>pending.number)){pending=seen;render();}
      }catch{/* Offline or not deployed: stay silent. */}
      finally{checking=null;}
    })();
    return checking;
  }
  // Focus and visibility each invite a check (at most one per 10 s); while visible,
  // a background check runs every 30 minutes. A hidden tab never checks.
  const onFocus=()=>void check();
  const onVisible=()=>{if(!hidden())void check();};
  window.addEventListener('focus',onFocus);document.addEventListener('visibilitychange',onVisible);
  timer=setInterval(()=>void check(),RELEASE_CHECK_INTERVAL_MS);
  // A new service worker means a deployment; confirm the release before saying so.
  let hadController=!!serviceWorker?.controller;
  const watch=value=>{
    registration=value;
    registration?.addEventListener?.('updatefound',()=>{const worker=registration.installing;if(!hadController)return;worker?.addEventListener('statechange',()=>{if(worker.state==='installed'||worker.state==='activated')void check({force:true});});});
  };
  serviceWorker?.addEventListener?.('controllerchange',()=>{if(hadController)void check({force:true});hadController=true;});
  // The first look waits until the app has settled; focus may come sooner.
  const first=setTimeout(()=>void check(),FIRST_CHECK_DELAY_MS);
  return{watch,check,get pending(){return pending;},close(){clearInterval(timer);clearTimeout(first);window.removeEventListener('resize',replace);window.removeEventListener('scribyra:state',replace);window.removeEventListener('focus',onFocus);document.removeEventListener('visibilitychange',onVisible);element?.remove();}};
}
