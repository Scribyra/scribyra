// Development-only native Gecko IME driver. Never used by the application.
import net from 'node:net';
import {realpath} from 'node:fs/promises';
export async function reserveMarionettePort(){
 // The pinned Firefox build listens on 2828 despite the launch port preference.
 // Fail before launch if another process owns it; never attach to an existing browser.
 const lease=net.createServer();await new Promise((resolve,reject)=>{lease.once('error',reject);lease.listen(2828,'127.0.0.1',resolve);});
 await new Promise(resolve=>lease.close(resolve));
}
export async function firefoxIme(profile,origin){
 let socket;
 for(let i=0;i<100;i++){
  try{socket=await new Promise((resolve,reject)=>{const s=net.connect(2828,'127.0.0.1');s.once('error',reject);s.once('connect',()=>resolve(s));});break;}
  catch{await new Promise(resolve=>setTimeout(resolve,100));}
 }
 if(!socket)throw new Error('Isolated Firefox Marionette listener did not start.');
 let buffer=Buffer.alloc(0),sequence=0;const pending=new Map();
 const fail=error=>{for(const item of pending.values()){clearTimeout(item.timer);item.reject(error);}pending.clear();};
 socket.on('error',fail);socket.on('close',()=>fail(new Error('Native IME connection closed.')));
 socket.on('data',chunk=>{
  buffer=Buffer.concat([buffer,chunk]);
  try{for(;;){
   const colon=buffer.indexOf(58);if(colon<0){if(buffer.length>10)throw new Error('Invalid Marionette header.');break;}
   const header=buffer.subarray(0,colon).toString();if(!/^\d{1,10}$/.test(header))throw new Error('Invalid Marionette frame.');const size=Number(header);if(size>2*1024*1024)throw new Error('Native IME reply exceeds limit.');
   if(buffer.length<colon+1+size)break;const packet=JSON.parse(buffer.subarray(colon+1,colon+1+size).toString());buffer=buffer.subarray(colon+1+size);
   if(!Array.isArray(packet)||packet[0]!==1)continue;
   const item=pending.get(packet[1]);if(!item)continue;pending.delete(packet[1]);clearTimeout(item.timer);packet[2]?item.reject(new Error(JSON.stringify(packet[2]))):item.resolve(packet[3]);
  }}catch(error){fail(error);socket.destroy();}
 });
 const call=(method,params={})=>new Promise((resolve,reject)=>{
  const id=++sequence,timer=setTimeout(()=>{pending.delete(id);reject(new Error(`Native IME command timed out: ${method}`));},10000);pending.set(id,{resolve,reject,timer});
  const bytes=Buffer.from(JSON.stringify([0,id,method,params]));socket.write(Buffer.concat([Buffer.from(bytes.length+':'),bytes]));
 });
 try{
  const session=await call('WebDriver:NewSession',{capabilities:{alwaysMatch:{acceptInsecureCerts:true}}});
  if(await realpath(session.capabilities['moz:profile'])!==await realpath(profile))throw new Error('Refusing native input: Marionette is not controlling our temporary profile.');
  await call('Marionette:SetContext',{value:'chrome'});
  const prefix=`const windows=Components.classes['@mozilla.org/appshell/window-mediator;1'].getService(Components.interfaces.nsIWindowMediator).getEnumerator('navigator:browser');let win;while(windows.hasMoreElements()){const candidate=windows.getNext();if([...candidate.gBrowser.browsers].some(browser=>browser.currentURI.spec.startsWith(${JSON.stringify(origin+'/')})))win=candidate;}if(!win)throw new Error('Isolated Scribyra window not found');`;
  const execute=async script=>(await call('WebDriver:ExecuteScript',{script:prefix+script,args:[],newSandbox:false,sandbox:'system',line:1,filename:'scribyra-native-ime-test'})).value;
  const begin=await execute("win.__scribyraTIP=Components.classes['@mozilla.org/text-input-processor;1'].createInstance(Components.interfaces.nsITextInputProcessor);return win.__scribyraTIP.beginInputTransactionForTests(win);");
  if(!begin)throw new Error('Gecko refused the native input transaction.');
  return {
   async preedit(text){const ok=await execute(`const tip=win.__scribyraTIP;tip.setPendingCompositionString(${JSON.stringify(text)});tip.appendClauseToPendingComposition(${text.length},tip.ATTR_RAW_CLAUSE);tip.setCaretInPendingComposition(${text.length});return tip.flushPendingComposition();`);if(!ok)throw new Error('Gecko refused the composition.');},
   controlEnter:()=>execute("const tip=win.__scribyraTIP,control=new win.KeyboardEvent('',{key:'Control',code:'ControlLeft',location:1}),enter=new win.KeyboardEvent('',{key:'Enter',code:'Enter'});tip.keydown(control);try{tip.keydown(enter);tip.keyup(enter);}finally{tip.keyup(control);}return true;"),
   commit:text=>execute(`win.__scribyraTIP.commitCompositionWith(${JSON.stringify(text)});return true;`),
   cancel:()=>execute('win.__scribyraTIP.cancelComposition();return true;'),
   close(){socket.destroy();},
  };
 }catch(error){socket.destroy();throw error;}
}
