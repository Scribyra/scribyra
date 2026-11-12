import {telemetryExport} from './telemetry-export.js';
import {telemetry_consent_record} from './pkg/scribyra_app.js';
import {SESSION_RATES} from './telemetry-session.js';
import './telemetry-consent.css';

const key='scribyra:telemetry-consent:v1',tombstoneKey='scribyra:telemetry-withdrawn:v1',budgetKey='scribyra:telemetry-budget:v1',minute=60000;
const categories=[
 ['performance','Performance and timing','Rounded durations, PDF and download size ranges, and worker memory range.'],
 ['errors','Errors and failures','Which operation failed, with a fixed category. No messages or logs.'],
 ['usage','Feature usage','Which operations ran, with rounded counts. Never individual edits.'],
];
const empty=()=>({performance:false,errors:false,usage:false});
const privacy='Never sent: document contents, file or project names, paths, prompts, tokens, credentials or per-edit activity.';

export function telemetryConsent({endpoint,destination,about,identity,originUnixMs,collection,storage,session,sessionRate=1,events=window}={}){
 // There is deliberately no destination fallback, runtime discovery or probe.
 if(!endpoint)return;
 // A build with an unusable session rate collects nothing rather than guess one.
 if(!SESSION_RATES.includes(sessionRate))return;
 storage??={getItem:key=>localStorage.getItem(key),setItem:(key,value)=>localStorage.setItem(key,value),removeItem:key=>localStorage.removeItem(key)};
 session??={getItem:key=>sessionStorage.getItem(key),setItem:(key,value)=>sessionStorage.setItem(key,value)};
 const quiet=work=>{try{return work();}catch{return undefined;}};
 // A budget survives reloads in this tab, so a crash-reload loop cannot reset it.
 const spent=Number(quiet(()=>session.getItem(budgetKey)));
 const transport=telemetryExport({anonymous:true,identity,originUnixMs:Math.floor(originUnixMs/minute)*minute,allowed:()=>sync(),spent:Number.isSafeInteger(spent)&&spent>0?spent:0,onSpend:value=>quiet(()=>session.setItem(budgetKey,String(value)))}),listeners=new Set(),admitted=new Set();
 let card,returnFocus,stored=true,seen=null,refused=quiet(()=>session.getItem(tombstoneKey))??null;
 const blank=()=>({endpoint,decided:false,visits:0,choices:empty()});
 // What this tab may act on. Anything unreadable, malformed or withdrawn is no consent.
 function read(){
  let text;try{text=storage.getItem(key);}catch{seen=undefined;return{...blank(),visits:2};}
  seen=text;
  if(text!==null&&text===refused)return{...blank(),visits:2};
  try{const saved=JSON.parse(text);if(saved?.endpoint===endpoint)return{endpoint,decided:saved.decided===true,visits:Math.min(2,Math.max(0,Number.isInteger(saved.visits)?saved.visits:0)),choices:Object.fromEntries(categories.map(([id])=>[id,saved.decided===true&&saved.choices?.[id]===true]))};}catch{}
  return blank();
 }
 let state=read();
 // A failed write must never leave an older, broader choice in force anywhere.
 function persist(){
  const text=JSON.stringify(state);
  try{storage.setItem(key,text);seen=text;refused=null;stored=true;quiet(()=>session.setItem(tombstoneKey,''));return true;}catch{}
  stored=false;
  try{storage.removeItem(key);seen=null;}catch{if(seen!==undefined&&seen!==null){refused=seen;quiet(()=>session.setItem(tombstoneKey,seen));}}
  return false;
 }
 const sending=()=>state.decided&&Object.values(state.choices).some(Boolean);
 function apply(){
  transport.configure({enabled:false});admitted.clear();
  const enabled=sending();
  collection(enabled);transport.collection(enabled);
  if(enabled)transport.configure({enabled:true,endpoint,usage:state.choices.usage,sessionRate});
  for(const listener of listeners)listener();
 }
 // No event reports same-tab clearing, so every admission and send re-reads consent.
 function sync(){
  let text,unreadable=false;try{text=storage.getItem(key);}catch{unreadable=true;}
  if(unreadable?seen!==undefined||sending():text!==seen){state=read();apply();}
  return sending();
 }
 const deliveryState=()=>{const s=transport.status();return !sending()?'off':s.error==='invalid'||s.error==='permission'||s.halted?'failing':s.error?'retrying':'ok';};
 function deliveryText(){
  const s=transport.status(),counts=`${s.sent} sent · ${s.pending} waiting · ${s.failures} failed`;
  if(!sending())return'Delivery: off. Nothing is sent.';
  if(s.error==='invalid')return`Delivery failing: the destination rejected these records, so this tab stopped sending them. ${counts}.`;
  if(s.error==='permission')return`Delivery failing: the destination refused this site, so this tab stopped sending. ${counts}.`;
  if(s.halted)return`Delivery stopped for this tab: ${s.error==='budget'?'its send limit was reached':'the destination stayed unavailable'}. ${counts}.`;
  if(s.error)return`Delivery retrying: the destination is unavailable. ${counts}.`;
  if(s.skipped)return`Delivery: this build sends from ${Math.round(s.sessionRate*100)}% of sessions, and this one was not picked, so nothing is sent. ${counts}.`;
  return`Delivery: ${counts}.`;
 }
 const visible=node=>node?.isConnected&&node.getClientRects().length>0&&!node.disabled;
 const focusTarget=()=>{const buttons=[...document.querySelectorAll('button')].filter(node=>visible(node)&&!card.contains(node));const named=name=>buttons.find(node=>(node.getAttribute('aria-label')||node.textContent).trim()===name);return visible(returnFocus)?returnFocus:named('Diagnostics')||named('More tools')||buttons[0];};
 // The docked card takes its height from the dashboard rather than covering it.
 let resizing;
 function reserve(){const set=()=>{if(card)document.documentElement.style.setProperty('--telemetry-card-height',`${Math.ceil(card.getBoundingClientRect().height)}px`);};set();if(typeof ResizeObserver==='function'){resizing=new ResizeObserver(set);resizing.observe(card);}}
 function remove(){if(!card)return;const focused=card.contains(document.activeElement),target=focused?focusTarget():undefined;resizing?.disconnect();card.remove();card=undefined;document.documentElement.style.removeProperty('--telemetry-card-height');target?.focus({preventScroll:true});}
 function choose(choices){state={...state,decided:true,choices:{...choices}};persist();apply();remove();}
 function controls({prompt=false}={}){
  const root=document.createElement('fieldset');root.className='telemetry-choices';
  const legend=document.createElement('legend');legend.textContent=prompt?'Help improve Scribyra?':'Telemetry choices';root.append(legend);
  const where=document.createElement('p');where.className='telemetry-destination';where.textContent=`Send only your chosen categories to ${destination||endpoint}.`;root.append(where);
  const draft=prompt?empty():{...state.choices},inputs={},rows=document.createElement('div');rows.className='telemetry-categories';
  for(const[id,title,description]of categories){
   const label=document.createElement('label'),input=document.createElement('input'),text=document.createElement('span'),name=document.createElement('strong'),help=document.createElement('span');
   input.type='checkbox';input.checked=draft[id];input.setAttribute('aria-label',title);help.id=`telemetry-${prompt?'prompt':'settings'}-${id}`;input.setAttribute('aria-describedby',help.id);
   name.textContent=title;help.textContent=description;text.append(name,help);label.append(input,text);rows.append(label);inputs[id]=input;
   input.onchange=()=>{draft[id]=input.checked;if(!prompt)choose(draft);};
  }
  root.append(rows);
  const shared=document.createElement('details'),summary=document.createElement('summary'),metadata=document.createElement('p');summary.textContent='Shared fields and connection details';metadata.textContent='Records include operation type, runtime, random correlation IDs, time rounded to the minute, app build, delivery counts and the share of sessions that send. Timings and failures also reveal use. The host sees your IP address and normal browser request metadata.';shared.append(summary,metadata);
  const excluded=document.createElement('p');excluded.textContent=prompt?`${privacy} The host sees your IP address.`:privacy;
  const hint=document.createElement('p');const updateHint=()=>hint.textContent=!stored?'Choices could not be stored. Changes apply to this tab only.':prompt?'All off until saved. Change anytime in Diagnostics.':'Local diagnostics and reviewed exports have separate controls.';updateHint();
  const docs=about&&/^(\/[^/]|https:\/\/)/.test(about)?Object.assign(document.createElement('a'),{className:'telemetry-about',href:about,textContent:'What Scribyra collects',target:'_blank',rel:'noopener noreferrer'}):null;
  if(!prompt){
   // Delivery must never look healthy while the destination refuses every record.
   const delivery=document.createElement('p');delivery.className='telemetry-delivery';delivery.setAttribute('role','status');
   const report=()=>{const text=deliveryText();if(delivery.textContent!==text)delivery.textContent=text;delivery.dataset.state=deliveryState();};report();const ticker=setInterval(report,1000);
   if(docs)root.append(docs);root.append(delivery,shared,excluded,hint);const update=()=>{for(const[id]of categories){draft[id]=state.choices[id];inputs[id].checked=draft[id];}updateHint();report();};listeners.add(update);return{element:root,close:()=>{clearInterval(ticker);listeners.delete(update);}};
  }
  root.append(excluded);
  const actions=document.createElement('div');actions.className='telemetry-actions';
  for(const[title,work,style]of [['Save choices',()=>choose(draft),'primary'],['No thanks',()=>choose(empty()),'secondary']]){const button=document.createElement('button');button.type='button';button.className=`button compact ${style}`;button.textContent=title;button.onclick=work;actions.append(button);}
  if(docs)actions.append(docs);actions.append(hint);
  root.append(actions);return{element:root};
 }
 apply();
 if(!state.decided&&state.visits<2){
  state.visits++;
  if(persist()){
  card=document.createElement('aside');card.className='telemetry-consent';card.setAttribute('aria-label','Telemetry consent');
  const close=document.createElement('button');close.type='button';close.className='icon-button telemetry-close';close.setAttribute('aria-label','Dismiss telemetry prompt');close.textContent='×';close.onclick=remove;
  card.append(close,controls({prompt:true}).element);card.addEventListener('focusin',event=>{if(event.relatedTarget&&!card.contains(event.relatedTarget))returnFocus=event.relatedTarget;});card.addEventListener('keydown',event=>{if(event.key==='Escape'){event.stopPropagation();remove();}});document.body.append(card);reserve();
  }
 }
 // Another tab counting its own visit must not take this tab's unanswered card.
 const changed=event=>{if(event.key!==key&&event.key!==null)return;state=read();apply();if(state.decided)remove();};
 events.addEventListener('storage',changed);
 events.addEventListener('pagehide',()=>{transport.configure({enabled:false});collection(false);});
 events.addEventListener('pageshow',event=>{if(!event.persisted)return;if(stored)state=read();else if(!sync())return;apply();});
 return{dismiss:remove,settings:()=>controls(),delivery:()=>({state:deliveryState(),text:deliveryText()}),clear:()=>transport.clear(),record(encoded){
  if(!sync())return false;
  const record=telemetry_consent_record(encoded,state.choices.performance,state.choices.errors,state.choices.usage);
  if(!record)return false;
  // Once coarse, a repeat within the minute says nothing new; random IDs don't count.
  const {traceId,spanId,parentSpanId,...facts}=JSON.parse(record),signature=JSON.stringify(facts);
  if(admitted.has(signature))return true;
  if(admitted.size>=256)admitted.clear();
  admitted.add(signature);transport.enqueue(record);return true;
 }};
}
