// Scripted (no model) S1-S7 for plugin delivery routes. Same fixture specs as r1-option1-measure.mjs.
import {mcpClient,PW,DT,CHROMIUM,P,BASE,cl100k} from './lib.mjs';
import {readFileSync,writeFileSync,existsSync,mkdirSync,rmSync} from 'node:fs';import {spawn} from 'node:child_process';
const HELPER=readFileSync(P+'/package/skills/scribyra/scripts/sc.js','utf8').trim();
const FIX='<repo>/fixtures/';
const SPEC={
 'missing-package':{file:'main.tex',line:1,find:'\\usepackage{scribyra-does-not-exist}',replace:'',expect7:true,expect1:false,hasFile:'main.tex'},
 article:{file:'main.tex',line:5,find:'Mathematics',replace:'Mathematics revised',expect7:true,expect1:true},
 thesis:{file:'chapters/page-050.tex',line:6,find:'Chapter 50',replace:'Chapter Fifty \\undefinedcmd',expect7:false,expect1:true},
};
const args=Object.fromEntries(process.argv.slice(2).map(a=>a.replace(/^--/,'').split(/=(.*)/s).slice(0,2)));
const route=args.route,fixtures=(args.fixtures||'missing-package,article,thesis').split(','),runs=+(args.runs||1);
const outPath=P+'/measure/out/rows-'+route+'.json',rows=existsSync(outPath)?JSON.parse(readFileSync(outPath)):[];
const FLAGS=['--headless','--executable-path',CHROMIUM,'--no-sandbox','--viewport-size','1440x1000','--isolated','--codegen','none','--snapshot-mode','none','--timeout-action','15000','--output-dir',P+'/measure/out/mcp'];
const J=JSON.stringify;
// inline route: what a model must write each step if the skill only lists snippets.
const IN={
 st:`()=>({project:document.querySelector('.project-title')?.textContent,active:document.querySelector('[role=tab][aria-selected=true]')?.textContent,busy:document.querySelector('.compile-button').textContent.includes('Cancel')})`,
 compile:`async()=>{if(document.querySelector('.compile-button').textContent.includes('Cancel'))return'busy';await scribyra.action('compile');const r=scribyra.lastCompile;return{ok:r.success,issues:(r.report?.issues||[]).length,warnings:(r.log.match(/^(LaTeX|Package|Class) .*Warning/gm)||[]).length,status:document.querySelector('.editor-status span[aria-live]').textContent}}`,
 sum:`()=>document.querySelector('.editor-status span[aria-live]').textContent`,
 diag:`()=>(scribyra.lastCompile.report?.issues||[]).slice(0,10).map(i=>[i.severity,i.summary,i.file,i.line])`,
 open:p=>`async()=>{[...document.querySelectorAll('[role=treeitem]')].find(t=>t.getAttribute('aria-label')===${J(p)}||t.textContent.trim()===${J(p)}).click();await new Promise(r=>setTimeout(r,200));return document.querySelector('[role=tab][aria-selected=true]').textContent}`,
 read:(n)=>`()=>{const d=document.querySelector('.cm-content').cmTile.view.state.doc,o=[];for(let i=Math.max(1,${n}-5);i<=Math.min(d.lines,${n}+5);i++)o.push(i+'|'+d.line(i).text);return o.join('\\n')}`,
 edit:(f,r)=>`()=>{const v=document.querySelector('.cm-content').cmTile.view,t=v.state.doc.toString(),i=t.indexOf(${J(f)});if(i<0||t.indexOf(${J(f)},i+1)>=0)return'not-unique';v.dispatch({changes:{from:i,to:i+${J(f)}.length,insert:${J(r)}}});return'edited'}`,
};
const SC={st:`()=>__sc.st()`,compile:`()=>__sc.compile()`,sum:`()=>__sc.sum()`,diag:`()=>__sc.diag()`,open:p=>`()=>__sc.open(${J(p)})`,read:n=>`()=>__sc.read(${n})`,edit:(f,r)=>`()=>__sc.edit(${J(f)},${J(r)})`};
const R=route==='inline'?IN:SC;
async function flow(fx,run){
 const spec=SPEC[fx];let setup,drv,br,evalTool='browser_evaluate',evalArg='function';
 if(route==='dt-slim'){
  const prof=P+'/measure/profile-dt';rmSync(prof,{recursive:true,force:true});mkdirSync(prof,{recursive:true});
  br=spawn(CHROMIUM,['--headless=new','--no-sandbox','--no-first-run','--remote-debugging-port=9592','--user-data-dir='+prof,'--window-size=1440,1000','about:blank'],{stdio:'ignore'});
  for(let i=0;i<100;i++){try{if((await fetch('http://127.0.0.1:9592/json/version')).ok)break;}catch{}await new Promise(r=>setTimeout(r,100));}
  setup=await mcpClient(PW,['--cdp-endpoint','http://127.0.0.1:9592','--codegen','none','--snapshot-mode','none','--timeout-action','15000','--output-dir',P+'/measure/out/mcp']);
  drv=await mcpClient(DT,['--slim','--browserUrl','http://127.0.0.1:9592','--no-usage-statistics','--no-performance-crux']);
  evalTool='evaluate';evalArg='script';
 }else{
  const extra=route==='helper-init'?['--init-script',P+'/measure/out/sc-init.js']:[];
  drv=setup=await mcpClient(PW,[...FLAGS,...extra]);
 }
 // S0 setup, excluded
 await setup.call('browser_navigate',{url:BASE});
 for(let i=0;i<40;i++){const r=await setup.call('browser_evaluate',{function:`()=>!!document.querySelector('button')`});if(/true/.test(r.text))break;await new Promise(r=>setTimeout(r,250));}
 await setup.call('browser_click',{target:'role=button[name="Import ZIP"]',element:'Import ZIP'});
 await new Promise(r=>setTimeout(r,300));
 const u=await setup.call('browser_file_upload',{paths:[P+'/measure/out/'+fx+'.zip']});if(u.isError)throw Error('upload '+u.text);
 for(let i=0;i<60;i++){const r=await setup.call('browser_evaluate',{function:`()=>!!document.querySelector('.cm-content')`});if(/true/.test(r.text))break;await new Promise(r=>setTimeout(r,250));}
 if(setup!==drv){/* leave setup connected only for verification */}
 const step=async(name,calls,check)=>{let bytes=0,chars=0,req=0,cl=0,clreq=0,ms=0,trips=0,last='',err=false;
  for(const fn0 of calls){const fn=route==='dt-slim'?(fn0.startsWith('()=>__sc.')?fn0.slice(4):'('+fn0+')()'):fn0;const a={[evalArg]:fn};const r=await drv.call(evalTool,a);bytes+=r.bytes;chars+=r.text.length;req+=r.req;cl+=cl100k(r.text);clreq+=cl100k(J({name:evalTool,arguments:a}));ms+=r.ms;trips++;last=r.text;err=err||r.isError;}
  let ok=!err,note='';if(check){const c=check(last);ok=ok&&c.ok;note=c.note||'';}
  rows.push({route,fixture:fx,run,step:name,bytes,req_bytes:req,tokens_est:Math.round(chars/4),req_tokens_est:Math.round(req/4),cl100k:cl,req_cl100k:clreq,trips,ms:Math.round(ms),ok,note:note.slice(0,300)});
  console.log(route,fx,run,name,bytes,req,Math.round(ms),ok,note.slice(0,120));return last;};
 if(route==='helper-paste'||route==='dt-slim')await step('S0b-inject',[HELPER],t=>({ok:/sc1/.test(t)}));
 await step('S1',[R.st],t=>({ok:new RegExp(fx).test(t)&&/main\.tex/.test(t),note:t}));
 await step('S2',[R.compile],t=>({ok:spec.expect1?/ok=1|"?ok"?: ?true/.test(t):/ok=0|"?ok"?: ?false/.test(t),note:t}));
 await step('S3',[R.sum],t=>({ok:/Compil|Missing|·/.test(t),note:t}));
 await step('S4',[R.diag],t=>({ok:true,note:t}));
 const gt=readFileSync(FIX+fx+'/'+spec.file,'utf8').split('\n');const gtLine=gt[spec.line-1]?.trim();
 const needOpen=spec.file!=='main.tex';
 await step('S5',[...(needOpen?[R.open(spec.file)]:[]),R.read(spec.line)],t=>({ok:gtLine===''||t.includes(gtLine.slice(0,40).replaceAll('\\','\\\\'))||t.includes(gtLine.slice(0,40)),note:'want '+gtLine.slice(0,50)}));
 await step('S6',[R.edit(spec.find,spec.replace)],t=>({ok:/edited/.test(t),note:t}));
 await step('S7',[R.compile],t=>({ok:spec.expect7?/ok=1|"?ok"?: ?true/.test(t):/ok=0|"?ok"?: ?false/.test(t),note:t}));
 if(fx==='thesis'){const truthLine=readFileSync(FIX+fx+'/'+spec.file,'utf8').split('\n').findIndex(l=>l.includes(spec.find))+1;
  await step('S8',[R.sum,R.diag],t=>({ok:true,note:'truth '+spec.file+':'+truthLine+' got '+t}));
  if(route!=='inline'){const r=await drv.call(evalTool,{[evalArg]:route==='dt-slim'?'__sc.sum()':'()=>__sc.sum()'});rows.push({route,fixture:fx,run,step:'S8-attr',bytes:0,req_bytes:0,tokens_est:0,req_tokens_est:0,cl100k:0,req_cl100k:0,trips:0,ms:0,ok:r.text.includes(spec.file+':'+truthLine),note:r.text.slice(0,200)+' truth '+spec.file+':'+truthLine});console.log('ATTR',r.text.slice(0,200),'truth',spec.file+':'+truthLine);}
 }
 writeFileSync(outPath,J(rows));
 await drv.close();if(setup!==drv)await setup.close();if(br){br.kill('SIGKILL');await new Promise(r=>setTimeout(r,300));}
}
if(route==='helper-init')writeFileSync(P+'/measure/out/sc-init.js','('+HELPER.replace(/;return'sc1'}$/,'}')+')();\n'.replace(/^/,''));
let n=0;for(const fx of fixtures)for(let i=0;i<runs;i++){await flow(fx,++n).catch(e=>{console.log('FLOWERR',fx,e.message);rows.push({route,fixture:fx,run:n,step:'flow',ok:false,note:e.message.slice(0,300)});writeFileSync(outPath,J(rows));});}
