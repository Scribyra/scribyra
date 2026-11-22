// First-run welcome (docs/templates.md#first-run-welcome). The dashboard shows it until
// the person dismisses it or starts a first project; either is remembered in this browser.
// It is part of the page, not a dialog, so it never covers the telemetry consent card or
// anything else, and it is never shown again once remembered.
export const WELCOME_KEY='scribyra:welcome:v1';

const read=storage=>{try{return storage.getItem(WELCOME_KEY);}catch{return 'unavailable';}};
const write=(storage,value)=>{try{storage.setItem(WELCOME_KEY,value);}catch{}};

/** Whether this browser still gets the welcome. Without storage it is not shown at all. */
export const welcomePending=(storage=localStorage)=>read(storage)===null;

/** The welcome applies to an empty workspace only: someone with projects is not new here. */
export function welcomeVisible(projectCount,storage=localStorage){
 if(!welcomePending(storage))return false;
 if(projectCount>0){write(storage,'started');return false;}
 return true;
}
export const dismissWelcome=(storage=localStorage)=>write(storage,'dismissed');
export const welcomeStarted=(storage=localStorage)=>{if(welcomePending(storage))write(storage,'started');};
