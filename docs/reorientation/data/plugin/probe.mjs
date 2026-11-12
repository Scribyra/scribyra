import {mcpClient,PW,CHROMIUM,P,BASE} from './lib.mjs';
import {spawn} from 'node:child_process';import {mkdirSync,rmSync} from 'node:fs';
const prof=P+'/measure/profile';rmSync(prof,{recursive:true,force:true});mkdirSync(prof,{recursive:true});
const br=spawn(CHROMIUM,['--headless=new','--no-sandbox','--no-first-run','--remote-debugging-port=9592','--user-data-dir='+prof,'--window-size=1440,1000','about:blank'],{stdio:'ignore'});
for(let i=0;i<100;i++){try{if((await fetch('http://127.0.0.1:9592/json/version')).ok)break;}catch{}await new Promise(r=>setTimeout(r,100));}
const log=(k,v)=>console.log('##',k,typeof v==='string'?v.slice(0,700):JSON.stringify(v).slice(0,700));
try{
 const base=['--cdp-endpoint','http://127.0.0.1:9592','--codegen','none','--snapshot-mode','none','--timeout-action','15000','--output-dir',P+'/measure/out/mcp'];
 const a=await mcpClient(PW,base);
 await a.call('browser_navigate',{url:BASE});
 await a.call('browser_click',{target:'role=button[name="Import ZIP"]',element:'Import ZIP'});
 await new Promise(r=>setTimeout(r,300));const u=await a.call('browser_file_upload',{paths:[P+'/measure/out/article.zip']});log('upload',u.text);
 await new Promise(r=>setTimeout(r,3000));
 let r=await a.call('browser_evaluate',{function:`()=>{const c=document.querySelector('.cm-content');return{keys:Object.keys(c),cmView:!!c.cmView,cmTile:!!c.cmTile,view:!!(c.cmView?.view||c.cmTile?.view),docLen:(c.cmView?.view||c.cmTile?.view)?.state.doc.length,top:typeof window.scribyra,sk:Object.keys(window.scribyra)}}`});log('cm',r.text);
 r=await a.call('browser_evaluate',{function:`()=>1`});log('evalOverheadNoCodegen',r.text+' ['+r.bytes+' bytes]');
 r=await a.call('browser_run_code_unsafe',{filename:'run-file.js'});log('runFile in-root',r.text+' err='+r.isError);
 r=await a.call('browser_run_code_unsafe',{filename:'<repo>/package.json'});log('runFile outside-root',r.text+' err='+r.isError);
 await a.close();
 const b=await mcpClient(PW,[...base,'--init-script',P+'/measure/out/probe-helper.js']);
 r=await b.call('browser_tabs',{action:'list'});log('tabs',r.text);
 r=await b.call('browser_evaluate',{function:`()=>({probe:window.__probe??null,url:location.href,hasCm:!!document.querySelector('.cm-content')})`});log('init-script existing tab',r.text);
 await b.call('browser_navigate',{url:BASE});
 r=await b.call('browser_evaluate',{function:`()=>({probe:window.__probe??null,url:location.href,hasCm:!!document.querySelector('.cm-content')})`});log('init-script after re-navigate',r.text);
 await b.close();
}finally{br.kill('SIGKILL');}
