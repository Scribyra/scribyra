// The plugin system (docs/plugins.md) in all three engines: the Plugins manager and
// consent, enable/disable/revoke/update/rollback/uninstall with cleanup, and a malicious
// test plugin whose every attempt to leave its sandbox or scope is refused.
import {test,expect} from '@playwright/test';
import {mkdirSync} from 'node:fs';
import AxeBuilder from '@axe-core/playwright';
import {ZOTERO_ID,openProject,openManager,installZotero,storeRecords,pluginServer,pluginPackage,sideload,notice} from './plugin-helpers.js';
test.use({actionTimeout:15000});
test.setTimeout(180000);
const shots=process.env.SCRIBYRA_SCREENSHOTS;
const MAIN='\\documentclass{article}\n\\begin{document}\nHello.\n\\end{document}\n';
async function shoot(page,name,locator){
  if(!shots)return;mkdirSync(shots,{recursive:true});const engine=test.info().project.name;
  for(const theme of ['light','dark']){await page.evaluate(theme=>{document.documentElement.dataset.theme=theme;},theme);await page.waitForTimeout(150);await (locator||page).screenshot({path:`${shots}/${name}-${theme}-${engine}.png`});}
  await page.evaluate(()=>{document.documentElement.dataset.theme='light';});
}
const moreTools=async(page,name)=>{await page.getByRole('button',{name:'More tools'}).click();const item=page.locator('#more-tools-menu').getByRole('button',{name,exact:true});return item;};

test('nothing is fetched or run before the person installs; consent shows permissions; install, disable, enable and uninstall',async({page})=>{
  const errors=[],requests=[];page.on('pageerror',error=>errors.push(error.message));page.on('request',request=>requests.push(request.url()));
  await openProject(page,{'main.tex':MAIN});
  // No plugin runs and the registry was not requested: nothing installed, nothing browsed.
  expect(await page.locator('iframe.plugin-sandbox').count()).toBe(0);
  expect(requests.filter(url=>/scribyra-plugin[^/]*\.json|registry[^/]*\.json|^data:application\/json/.test(url))).toEqual([]);
  const manager=await openManager(page);
  await expect(manager).toContainText('No plugins are installed in this browser.');
  expect(requests.filter(url=>/scribyra-plugin[^/]*\.json|registry[^/]*\.json|^data:application\/json/.test(url))).toEqual([]);
  await shoot(page,'plugins-manager-empty',manager);
  await manager.getByRole('button',{name:'Browse official plugins'}).click();
  await expect(manager.getByRole('list',{name:'Official plugins'})).toContainText('Zotero');
  // Consent lists each permission in plain words; Cancel installs nothing.
  await manager.getByRole('button',{name:'Install Zotero'}).click();
  const consent=page.getByRole('dialog',{name:'Install Zotero?'});await expect(consent).toBeVisible();
  const permissions=consent.getByRole('list',{name:'Permissions'});
  await expect(permissions).toContainText('Read files in the open project matching *.bib, *.ltx and *.tex');
  await expect(permissions).toContainText('Create *.bib files and change the files it created');
  await expect(permissions).toContainText('Contact https://api.zotero.org');
  await expect(permissions).toContainText('Keep secrets such as API keys on this device');
  await expect(consent).toContainText('From the official Scribyra plugin registry. Its signature and checksum were verified.');
  await shoot(page,'plugins-consent',consent);
  const axeConsent=await new AxeBuilder({page}).include('.plugin-consent').analyze();expect(axeConsent.violations.map(v=>v.id)).toEqual([]);
  await consent.getByRole('button',{name:'Cancel'}).click();
  await expect(manager.getByRole('status')).toHaveText('Nothing was installed.');
  expect(await storeRecords(page,'scribyra-plugins','plugins')).toEqual([]);
  await manager.getByRole('button',{name:'Install Zotero'}).click();await consent.getByRole('button',{name:'Install',exact:true}).click();
  await expect(manager.getByRole('status')).toContainText('Zotero 1.0.0 installed and enabled.');
  const card=manager.locator(`[data-plugin="${ZOTERO_ID}"]`);
  await expect(card.getByRole('switch',{name:'Enable Zotero'})).toBeChecked();
  await expect(card).toContainText('Official');
  await expect(page.locator(`iframe.plugin-sandbox[data-plugin="${ZOTERO_ID}"]`)).toHaveCount(1);
  await shoot(page,'plugins-manager',manager);
  const axe=await new AxeBuilder({page}).include('.plugin-manager').analyze();expect(axe.violations.map(v=>v.id)).toEqual([]);
  await manager.getByRole('button',{name:'Close',exact:true}).click();
  // Its command appears in More tools, and its tree action on the root.
  await expect(await moreTools(page,'Zotero')).toBeVisible();await page.keyboard.press('Escape');
  await page.locator('.tree-root').click({button:'right'});await expect(page.getByRole('menuitem',{name:/^Link to Zotero/})).toBeEnabled();await page.keyboard.press('Escape');
  // Disable: the sandbox goes and so do its contributions; enable brings them back.
  await openManager(page);await card.getByRole('switch',{name:'Enable Zotero'}).uncheck();
  await expect(manager.getByRole('status')).toHaveText('Zotero is disabled.');
  await expect(page.locator('iframe.plugin-sandbox')).toHaveCount(0);
  await manager.getByRole('button',{name:'Close',exact:true}).click();
  await expect(await moreTools(page,'Zotero')).toHaveCount(0);await page.keyboard.press('Escape');
  await page.locator('.tree-root').click({button:'right'});await expect(page.getByRole('menuitem',{name:/^Link to Zotero/})).toHaveCount(0);await page.keyboard.press('Escape');
  await openManager(page);await card.getByRole('switch',{name:'Enable Zotero'}).check();await expect(manager.getByRole('status')).toHaveText('Zotero is enabled.');
  await expect(page.locator(`iframe.plugin-sandbox[data-plugin="${ZOTERO_ID}"]`)).toHaveCount(1);
  // Reload: installed plugins persist and start again with the project.
  await manager.getByRole('button',{name:'Close',exact:true}).click();
  await expect(page.locator('.save-indicator')).toHaveText('Saved locally');await page.reload();await page.locator('.card-open').first().click();await expect(page.locator('.cm-content')).toBeVisible();
  await expect(page.locator(`iframe.plugin-sandbox[data-plugin="${ZOTERO_ID}"]`)).toHaveCount(1);
  // Uninstall asks, then removes the plugin, its package and all its data.
  await openManager(page);await card.getByRole('button',{name:'Uninstall Zotero'}).click();
  await page.getByRole('dialog',{name:'Uninstall Zotero'}).getByRole('button',{name:'Uninstall'}).click();
  await expect(manager.getByRole('status')).toContainText('Zotero was uninstalled and its data and secrets were removed from this device.');
  await expect(page.locator('iframe.plugin-sandbox')).toHaveCount(0);
  for(const store of ['plugins','packages','data','owned'])expect(await storeRecords(page,'scribyra-plugins',store),store).toEqual([]);
  expect(await storeRecords(page,'scribyra-plugin-secrets','secrets')).toEqual([]);
  expect(errors).toEqual([]);
});
