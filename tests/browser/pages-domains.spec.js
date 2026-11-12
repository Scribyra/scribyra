import {test,expect} from '@playwright/test';
import {officialTelemetryEndpoint} from '../../scripts/official-telemetry.mjs';
import {zipSync,strToU8} from 'fflate';
import {createServer} from 'node:http';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {resolve,extname,sep} from 'node:path';
import {execFileSync} from 'node:child_process';
let server,directory,presentation,application;
test.beforeAll(async()=>{
 directory=await mkdtemp(resolve('.cache/pages-domain-'));
 server=createServer(async(req,res)=>{
  try{
   const path=resolve(directory,'.'+decodeURIComponent(new URL(req.url,'http://localhost').pathname));
   if(path!==directory&&!path.startsWith(directory+sep)){res.writeHead(403).end();return;}
   const file=path.endsWith(sep)||path===directory?resolve(path,'index.html'):path;
   const types={'.html':'text/html','.js':'text/javascript','.mjs':'text/javascript','.css':'text/css','.json':'application/json','.wasm':'application/wasm','.svg':'image/svg+xml','.png':'image/png','.md':'text/markdown'};
   const data=await readFile(file);res.writeHead(200,{'Content-Type':types[extname(file)]||'application/octet-stream'});res.end(data);
  }catch{res.writeHead(404).end();}
 });
 await new Promise(resolve=>server.listen(0,resolve));
 const port=server.address().port;presentation=`http://127.0.0.1:${port}/`;application=`http://localhost:${port}/`;
 execFileSync(process.execPath,['scripts/ci-pages.mjs'],{env:{...process.env,SCRIBYRA_PAGES_OUTPUT:directory,SCRIBYRA_PRESENTATION_URL:presentation,SCRIBYRA_APP_URL:application}});
});
test.afterAll(async()=>{if(server)await new Promise(resolve=>server.close(resolve));if(directory)await rm(directory,{recursive:true,force:true});});
test('separate presentation and root app hosts compile online and offline',async({page,context})=>{
 // Abort any collector request while online. Firefox stops serving navigations from the
 // service worker while a route is installed, so the offline half watches requests instead;
 // offline, nothing can reach the collector anyway.
 const telemetryRequests=[];context.on('request',request=>{if(request.url().startsWith(officialTelemetryEndpoint))telemetryRequests.push(request.method());});
 await context.route(officialTelemetryEndpoint,route=>route.abort());
 const wrong=[];page.on('request',request=>{if(new URL(request.url()).pathname.startsWith('/core/'))wrong.push(request.url());});
 await page.goto(presentation);
 const open=page.getByRole('link',{name:/^Open app/}).first();await expect(open).toHaveAttribute('href',application);await open.click();
 await expect(page).toHaveURL(application);
 await expect(page.locator('head link[rel="alternate"][type="text/markdown"]')).toHaveAttribute('href','agent.md');
 const recipe=await(await page.request.get(new URL('agent.md',application).href)).text();expect(recipe).toContain('# Scribyra agent (experimental)');
 await expect(page.getByRole('button',{name:'Import ZIP',exact:true})).toBeVisible();
 const consent=page.getByRole('complementary',{name:'Telemetry consent',exact:true});await expect(consent).toContainText('Grafana Cloud, a third-party service');await expect(consent.getByRole('link',{name:'What Scribyra collects',exact:true})).toHaveAttribute('href','/telemetry.html');
 const chooser=page.waitForEvent('filechooser');await page.getByRole('button',{name:'Import ZIP',exact:true}).click();await(await chooser).setFiles({name:'domain-test.zip',mimeType:'application/zip',buffer:Buffer.from(zipSync({'main.tex':strToU8('\\documentclass{article}\n\\begin{document}Custom domain smoke test.\\end{document}')}))});
 await expect(page.locator('.cm-content')).toBeVisible();
 async function compile(){await page.evaluate(()=>window.scribyra.lastCompile=null);await page.getByRole('button',{name:'Compile',exact:true}).click();await expect.poll(()=>page.evaluate(()=>window.scribyra.lastCompile),{timeout:180000}).toBeTruthy();expect((await page.evaluate(()=>window.scribyra.lastCompile)).success).toBeTruthy();}
 await compile();await expect(page.locator('#pdf-viewer canvas').first()).toBeVisible();
 await page.waitForFunction(()=>navigator.serviceWorker.controller);
 expect(await page.evaluate(async()=>new URL((await navigator.serviceWorker.ready).scope).pathname)).toBe('/');
 await context.unroute(officialTelemetryEndpoint);await context.setOffline(true);
 try{await page.reload();await expect(page).toHaveURL(application);await page.getByRole('button',{name:/domain-test.*file/}).click();await expect(page.locator('.cm-content')).toBeVisible();await compile();const response=await page.goto(new URL('agent.md',application).href);expect(response.headers()['content-type']).toContain('text/markdown');expect(await page.locator('body').textContent()).toBe(recipe);}
 finally{await context.setOffline(false);}
 expect(wrong).toEqual([]);expect(telemetryRequests).toEqual([]);
});

test('site pages may be indexed, with a sitemap, and every page they link to in the release exists',async({page})=>{
 const robots=await readFile(resolve(directory,'robots.txt'),'utf8');expect(robots).toContain('Allow: /');expect(robots).not.toMatch(/^Disallow: \/$/m);expect(robots).toContain('Sitemap: https://scribyra.com/sitemap.xml');
 expect((await page.request.get(new URL('sitemap.xml',presentation).href)).ok()).toBe(true);
 for(const name of ['','privacy.html','licenses.html','telemetry.html']){
  await page.goto(new URL(name,presentation).href);await expect(page.locator('meta[name=robots]')).toHaveCount(0);
  const hrefs=await page.locator('a[href]').evaluateAll(links=>links.map(link=>link.getAttribute('href')));expect(hrefs.filter(href=>/gitlab\.com\/urundead-labs/.test(href)),`${name||'index'} links to the GitLab repository`).toEqual([]);
  if(name!=='telemetry.html'){const github=page.getByRole('banner').getByRole('link',{name:'Source code on GitHub',exact:true});await expect(github).toBeVisible();await expect(github).toHaveAttribute('href','https://github.com/Scribyra/scribyra');await expect(github).toContainText('GitHub');await expect(page.getByRole('contentinfo').getByRole('link',{name:'Source ↗',exact:true})).toHaveAttribute('href','https://github.com/Scribyra/scribyra');}
  for(const href of await page.locator('a[href]').evaluateAll(links=>links.map(link=>link.getAttribute('href')))){
   if(/^(https?:|mailto:|#)/.test(href))continue;
   const target=new URL(href,page.url()).href,response=await page.request.get(target);expect(response.ok(),`${name||'index'} links to ${href}`).toBe(true);
  }
 }
 for(const notice of ['LICENSE.txt','COPYRIGHT.txt','THIRD_PARTY.txt','LICENSE.TL.txt','LICENSE.CTAN.txt','release-texlive.txt','tex-support-NOTICE.txt','tex-catalog-NOTICE.txt'])expect((await page.request.get(new URL(`licenses/${notice}`,presentation).href)).ok(),notice).toBe(true);
 await page.goto(new URL('privacy.html',presentation).href);await expect(page.getByRole('link',{name:'tlnet.yihui.org',exact:true})).toBeVisible();await expect(page.locator('main')).not.toContainText(/end-to-end encrypt/i);
 await expect(page.getByRole('link',{name:'What telemetry contains',exact:true})).toHaveAttribute('href','telemetry.html');await expect(page.locator('main')).toContainText('Grafana Cloud, a third-party service');
 await expect(page.locator('main')).toContainText('URUNDEAD LABS S.R.L. operates Scribyra. It is the data controller');await expect(page.locator('#who + p')).toContainText('EUID ROONRC.J2026034271001');await expect(page.getByRole('link',{name:'dataprotection.ro',exact:true})).toHaveAttribute('href','https://www.dataprotection.ro/');
 for(const name of ['','privacy.html','licenses.html','telemetry.html']){await page.goto(new URL(name,presentation).href);await expect(page.getByRole('contentinfo')).toContainText('© 2026 URUNDEAD LABS S.R.L. · Reg. Com. J2026034271001 · CUI 54762154 · VAT RO55538423 · Strada Pitar Moș 27, et. 5, ap. 17, 010452 București, Romania');}
 expect(await(await page.request.get(new URL('licenses/COPYRIGHT.txt',presentation).href)).text()).toContain('Copyright (C) 2026 URUNDEAD LABS S.R.L.');
});

