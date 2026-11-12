// The WebDriver subset the direct-session trial uses, over Playwright browsers, so the
// trial script itself can run here without SSH, drivers or a second machine. It checks
// the script's logic against the real app and service; it says nothing about networks,
// real geckodriver/chromedriver behaviour, or Firefox's WebDriver sandbox.
import {createServer} from 'node:http';
import {randomUUID} from 'node:crypto';
const ELEMENT='element-6066-11e4-a52e-4f735466cecf';
export async function webdriverShim(browserType,launchOptions={}){
 const browser=await browserType.launch(launchOptions),sessions=new Map();
 const handlers={
  async session(){const context=await browser.newContext({serviceWorkers:'block'}),page=await context.newPage(),sessionId=randomUUID();sessions.set(sessionId,{context,page,elements:new Map()});return{sessionId,capabilities:{browserVersion:browser.version()}};},
  async url(s,body){await s.page.goto(body.url);return null;},
  async 'execute/sync'(s,body){return s.page.evaluate(({script,args})=>new Function(script).apply(null,args),{script:body.script,args:body.args});},
  async element(s,body){const id=randomUUID();s.elements.set(id,body.value);return{[ELEMENT]:id};},
  async value(s,body,id){const locator=s.page.locator(s.elements.get(id));await locator.click();await s.page.keyboard.press('ControlOrMeta+End');await s.page.keyboard.type(body.text.replaceAll('\uE007','\n'));return null;},
  async permissions(s,body){if(browserType.name()==='chromium')await s.context.grantPermissions([body.descriptor.name]);return null;},
  async 'window/rect'(s,body){await s.page.setViewportSize({width:body.width,height:body.height});return null;},
 };
 const server=createServer(async(request,response)=>{
  let text='';for await(const part of request)text+=part;
  const reply=(status,value)=>{response.writeHead(status,{'content-type':'application/json'});response.end(JSON.stringify({value}));};
  try{
   const parts=new URL(request.url,'http://x').pathname.split('/').filter(Boolean),body=text?JSON.parse(text):{};
   if(parts[0]==='status')return reply(200,{ready:true});
   if(parts[0]==='session'&&parts.length===1)return reply(200,await handlers.session());
   const s=sessions.get(parts[1]);if(!s)return reply(404,{error:'invalid session id',message:parts[1]});
   if(request.method==='DELETE'){sessions.delete(parts[1]);await s.context.close();return reply(200,null);}
   if(parts[2]==='element'&&parts[4]==='value')return reply(200,await handlers.value(s,body,parts[3]));
   const handler=handlers[parts.slice(2).join('/')];if(!handler)return reply(404,{error:'unknown command',message:request.url});
   reply(200,await handler(s,body));
  }catch(error){reply(500,{error:'javascript error',message:String(error.message)});}
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 return{port:server.address().port,async close(){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await browser.close();}};
}
