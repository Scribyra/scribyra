import {test,expect} from '@playwright/test';
import {officialTelemetryEndpoint} from '../../scripts/official-telemetry.mjs';
import {zipSync,strToU8} from 'fflate';
test('presentation opens the pipeline app at its own path and compiles after offline reload',async({page,context})=>{
 const url=process.env.SCRIBYRA_TEST_PAGES_URL;
 test.skip(!url,'Requires the assembled Pages release served by a local HTTP server.');
 // Abort any collector request while online. Firefox stops serving navigations from the
 // service worker while a route is installed, so the offline half watches requests instead.
 const telemetryRequests=[];context.on('request',request=>{if(request.url().startsWith(officialTelemetryEndpoint))telemetryRequests.push(request.method());});
 await context.route(officialTelemetryEndpoint,route=>route.abort());
 const wrong=[];page.on('request',request=>{const path=new URL(request.url()).pathname;if(path.startsWith('/assets/')&&!['/assets/workspace.png','/assets/mark.svg'].includes(path)||path.startsWith('/core/'))wrong.push(path);});
 await page.goto(url);await expect(page.locator('#privacy')).toContainText('Grafana Cloud, a third-party service');
 const open=page.getByRole('link',{name:/^Open app/}).first();await expect(open).toHaveAttribute('href','app/');await open.click();
 await expect(page).toHaveURL(/\/app\/$/);
 const recipeUrl=new URL('agent.md',page.url()).href;
 await expect(page.locator('head link[rel="alternate"][type="text/markdown"]')).toHaveAttribute('href','/app/agent.md');
 const recipe=await(await page.request.get(recipeUrl)).text();expect(recipe).toContain('# Scribyra agent (experimental)');
 await expect(page.getByRole('button',{name:'Import ZIP',exact:true})).toBeVisible();
 const consent=page.getByRole('complementary',{name:'Telemetry consent',exact:true});await expect(consent).toContainText('Grafana Cloud, a third-party service');await expect(consent.getByRole('link',{name:'What Scribyra collects',exact:true})).toHaveAttribute('href','/telemetry.html');
 const chooser=page.waitForEvent('filechooser');await page.getByRole('button',{name:'Import ZIP',exact:true}).click();await(await chooser).setFiles({name:'release-test.zip',mimeType:'application/zip',buffer:Buffer.from(zipSync({'main.tex':strToU8('\\documentclass{article}\n\\begin{document}Pipeline release smoke test.\\end{document}')}))});
 await expect(page.locator('.cm-content')).toBeVisible();
 async function compile(){await page.evaluate(()=>window.scribyra.lastCompile=null);await page.getByRole('button',{name:'Compile',exact:true}).click();await expect.poll(()=>page.evaluate(()=>window.scribyra.lastCompile),{timeout:180000}).toBeTruthy();expect((await page.evaluate(()=>window.scribyra.lastCompile)).success).toBeTruthy();}
 await compile();await expect(page.locator('#pdf-viewer canvas').first()).toBeVisible();
 await page.waitForFunction(()=>navigator.serviceWorker.controller);
 expect(await page.evaluate(async()=>new URL((await navigator.serviceWorker.ready).scope).pathname)).toBe('/app/');
 await context.unroute(officialTelemetryEndpoint);await context.setOffline(true);
 try{await page.reload();await page.getByRole('button',{name:/release-test.*file/}).click();await expect(page.locator('.cm-content')).toBeVisible();await compile();const response=await page.goto(recipeUrl);expect(response.headers()['content-type']).toContain('text/markdown');expect(await page.locator('body').textContent()).toBe(recipe);}
 finally{await context.setOffline(false);}
 expect(wrong).toEqual([]);expect(telemetryRequests).toEqual([]);
});
