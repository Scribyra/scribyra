// The GitHub and GitLab plugin (plugins/github-gitlab, docs/git-sync.md) in all three
// engines, against faithful fakes of the GitHub and GitLab REST APIs
// (tests/helpers/fake-git-hosts.mjs) with real Git object ids. Each test installs the
// official plugin through the Plugins manager and consent. The plugin addresses
// https://api.github.com, https://gitlab.com and https://gitlab.example.org through the
// host's fetch proxy; an init script sends those requests on to the fakes on 127.0.0.1, so
// the browser makes real cross-origin requests under CORS. Nothing contacts GitHub or GitLab.
import {test,expect} from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import {zipSync,unzipSync,strToU8} from 'fflate';
import {mkdirSync} from 'node:fs';
import {readFile} from 'node:fs/promises';
import {fakeGitHubApi,fakeGitLabApi} from '../helpers/fake-git-hosts.mjs';
import {openManager,browserTraces,notice} from './plugin-helpers.js';
test.use({actionTimeout:15000});
test.setTimeout(300000);

const shots=process.env.SCRIBYRA_SCREENSHOTS;
const GH_TOKEN='github_pat_11TESTONLY0fake_token_for_scribyra_tests_0123456789abcdefghijklmnopqrstuvwxyzABCD';
const WRONG_TOKEN='github_pat_wrong_token_000000000000';
const GL_TOKEN='glpat-TESTONLYfake-token-0123456789',GL_READ_TOKEN='glpat-TESTONLYread-only-token-9876543210';
const PNG=new Uint8Array(await readFile('fixtures/article/figure.png')),PNG_B=PNG.slice();PNG_B[PNG_B.length-1]^=0xff;
const MAIN=Array.from({length:10},(_,i)=>i===0?'\\documentclass{article}\n':i===1?'\\begin{document}\n':i===9?'\\end{document}\n':`Line ${i+1} of the paper.\n`).join('');
const BIB='@article{one,\n  title = {First title},\n  year = {2020},\n}\n\n@article{two,\n  title = {Second title},\n  year = {2021},\n}\n';
const PLUGIN='GitHub and GitLab';

/** Starts the fakes and points the page's fetch at them; records every request the page makes. */
async function hosts(page){
  const gh=fakeGitHubApi(),gl=fakeGitLabApi(),own=fakeGitLabApi({origin:'https://gitlab.example.org'});
  const urls=await gh.start();
  const map=[['https://api.github.com',urls.api],['https://raw.githubusercontent.com',urls.raw],['https://gitlab.com',await gl.start()],['https://gitlab.example.org',await own.start()]];
  await page.addInitScript(map=>{
    const original=window.fetch.bind(window);
    window.fetch=(input,options)=>{const url=input instanceof Request?input.url:String(input);for(const [from,to]of map)if(url.startsWith(from+'/'))return original(to+url.slice(from.length),options);return original(input,options);};
  },map);
  const seen=[],outside=[];
  page.on('request',request=>{
    seen.push({url:request.url(),headers:JSON.stringify(request.headers()),body:request.postData()||''});
    const url=new URL(request.url());if(!['127.0.0.1','localhost'].includes(url.hostname)&&!['data:','blob:'].includes(url.protocol))outside.push(request.url());
  });
  return {gh,gl,own,urls:Object.fromEntries(map),seen,outside,close:()=>Promise.all([gh.close(),gl.close(),own.close()])};
}
async function openProject(page,files,name='git-paper.zip'){
  await page.goto('/');const chooser=page.waitForEvent('filechooser');await page.getByRole('button',{name:'Import ZIP',exact:true}).click();
  await (await chooser).setFiles({name,mimeType:'application/zip',buffer:Buffer.from(zipSync(Object.fromEntries(Object.entries(files).map(([path,content])=>[path,typeof content==='string'?strToU8(content):content]))))});
  await expect(page.locator('.cm-content')).toBeVisible();
}
async function installPlugin(page){
  const manager=await openManager(page);
  await manager.getByRole('button',{name:'Browse official plugins'}).click();
  await manager.getByRole('button',{name:`Install ${PLUGIN}`}).click();
  const consent=page.getByRole('dialog',{name:`Install ${PLUGIN}?`});await expect(consent).toBeVisible();
  for(const line of ['Read every file in the open project, including images and other binary files','Add, change and delete any file in the open project, in changes you confirm','Contact https://api.github.com and https://gitlab.com','Ask you to allow other https:// addresses (self-hosted GitLab servers you add)','Keep secrets such as API keys on this device','Show a status item above the open project'])await expect(consent).toContainText(line);
  await consent.getByRole('button',{name:'Install',exact:true}).click();
  await expect(manager.getByRole('status')).toContainText(`${PLUGIN} 1.0.0 installed and enabled.`);
  await manager.getByRole('button',{name:'Close',exact:true}).click();await expect(manager).toBeHidden();
}
const status=page=>page.getByRole('group',{name:'Repository link',exact:true});
const source=(page,path)=>page.evaluate(path=>window.scribyra.agent.readSource({path,startLine:1,endLine:200}).value?.content??null,path);
const paths=page=>page.evaluate(()=>window.scribyra.agent.readTree({limit:100}).value.items.filter(item=>item.kind!=='folder').map(item=>item.path).sort());
async function edit(page,path,find,replace){await page.evaluate(([path,find,replace])=>{const api=window.scribyra.agent,result=api.patchSource({expectedRevision:api.status().revision,edits:[{path,find,replace}]});if(!result.ok)throw Error(JSON.stringify(result));},[path,find,replace]);}
async function morePanel(page){
  await page.getByRole('button',{name:'More tools'}).click();await page.getByRole('button',{name:PLUGIN,exact:true}).click();
  const panel=page.getByRole('dialog',{name:PLUGIN,exact:true});await expect(panel).toBeVisible();return panel;
}
async function shoot(page,name,locator){
  if(!shots)return;mkdirSync(shots,{recursive:true});const engine=test.info().project.name;
  for(const theme of ['light','dark']){await page.evaluate(theme=>{document.documentElement.dataset.theme=theme;},theme);await page.waitForTimeout(150);await (locator||page).screenshot({path:`${shots}/${name}-${theme}-${engine}.png`});}
  await page.evaluate(()=>{document.documentElement.dataset.theme='light';});
}
async function axe(page,selector){const result=await new AxeBuilder({page}).include(selector).analyze();expect(result.violations.map(v=>`${v.id}: ${v.nodes.map(n=>n.target).join(' ')}`)).toEqual([]);}
/** Fills the link dialog for GitHub and checks access; leaves it open. */
async function fillGitHub(page,{repository='octo/paper',branch='',folder='',token=GH_TOKEN}={}){
  const dialog=page.getByRole('dialog',{name:'Link to a repository'});await expect(dialog).toBeVisible();
  await dialog.getByLabel('Repository (owner/name)').fill(repository);
  await dialog.getByLabel('Branch').fill(branch);
  await dialog.getByLabel('Folder in the repository (optional)').fill(folder);
  await dialog.getByLabel(/^Access token/).fill(token);
  await dialog.getByRole('button',{name:'Check access'}).click();
  await expect(dialog.getByRole('status')).toContainText(/Token for octocat can read octo\/paper \(private\)\. Branch main is at [0-9a-f]{7}\./);
  return dialog;
}
const downloaded=async download=>new Uint8Array(await readFile(await download.path()));
function contains(bytes,secret){const text=new TextDecoder('latin1').decode(bytes);if(text.includes(secret))return true;try{return Object.values(unzipSync(bytes)).some(entry=>new TextDecoder('latin1').decode(entry).includes(secret));}catch{return false;}}

test('GitHub: link a folder, pull, refuse a push when the branch moved, pull per file, push, and the token never leaves this device',async({page})=>{
  const fake=await hosts(page),errors=[];page.on('pageerror',error=>errors.push(error.message));
  try{
    const repo=fake.gh.addRepo('octo/paper');fake.gh.addToken(GH_TOKEN,{login:'octocat',repos:{'octo/paper':'write'}});
    repo.commitFiles('main',{'README.md':'# Paper\n','paper/main.tex':MAIN,'paper/refs.bib':BIB,'paper/sections/intro.tex':'\\section{Intro}\nOld intro.\n','paper/figure.png':PNG,'paper/link.tex':{content:'main.tex',mode:'120000'},'paper/vendor':{submodule:'1111111111111111111111111111111111111111'}},{message:'Initial paper'});
    await openProject(page,{'main.tex':MAIN,'notes.tex':'Local notes.\n','.env':'API_KEY=local-only\n','leak.tex':`% ${'ghp_'+'A'.repeat(36)}\n`,'.scribyraignore':'build/\n*.log\n','build/out.log':'log\n'});
    await installPlugin(page);
    // Not linked, not imported: no status item yet.
    await expect(status(page)).toHaveCount(0);
    const panel=await morePanel(page);await expect(panel).toContainText('This project is not linked to a repository.');
    await panel.getByRole('button',{name:'Link to a repository…'}).click();
    const link=page.getByRole('dialog',{name:'Link to a repository'});
    await expect(link.getByRole('link',{name:'fine-grained personal access token'})).toHaveAttribute('href','https://github.com/settings/personal-access-tokens/new');
    await expect(link).toContainText('set “Contents” to “Read and write” (“Read-only” is enough to pull)');
    await expect(link).toContainText('bound to https://api.github.com');
    await expect(link.getByRole('button',{name:'Link and pull'})).toBeDisabled();
    // A wrong token is refused and forgotten.
    await fillGitHub(page,{folder:'paper',token:WRONG_TOKEN}).catch(()=>{});
    await expect(link.getByRole('status')).toContainText('GitHub did not accept the token');
    await fillGitHub(page,{folder:'paper'});
    await expect(link.getByLabel(/^Access token/)).toHaveValue('');
    await shoot(page,'git-link-dialog',link);await axe(page,'.plugin-dialog');
    await link.getByRole('button',{name:'Link and pull'}).click();
    await expect(notice(page)).toContainText('Linked to https://github.com/octo/paper (main, folder paper). The token is saved only on this device.');
    // First pull: the remote's files arrive; main.tex is already the same; symlinks and submodules are not synced.
    const pull=page.getByRole('dialog',{name:'Pull from GitHub'});await expect(pull).toBeVisible();
    await expect(pull).toContainText('3 files changed on GitHub since your last sync.');
    for(const path of ['refs.bib','sections/intro.tex','figure.png'])await expect(pull.getByRole('group',{name:path,exact:true})).toBeVisible();
    await expect(pull.getByRole('group',{name:'main.tex',exact:true})).toHaveCount(0);
    await expect(pull.getByRole('group',{name:'figure.png',exact:true})).toContainText('Binary file: on GitHub');
    await expect(pull.getByRole('list',{name:'Not synced'})).toContainText('link.texSymbolic link, not synced');
    await expect(pull.getByRole('list',{name:'Not synced'})).toContainText('vendorGit submodule, not synced');
    await expect(pull.getByRole('group',{name:'Changes to refs.bib'})).toContainText('@article{one,');
    await pull.getByRole('button',{name:'Apply selected'}).click();await expect(pull).toBeHidden();
    await expect(notice(page)).toContainText(/Pulled main at [0-9a-f]{7}: 3 added, 0 changed, 0 removed\./);
    expect(await source(page,'refs.bib')).toBe(BIB);expect(await source(page,'sections/intro.tex')).toBe('\\section{Intro}\nOld intro.\n');
    expect(await paths(page)).toEqual(['.env','.scribyraignore','build/out.log','figure.png','leak.tex','main.tex','notes.tex','refs.bib','sections/intro.tex']);
    // The status item: repository, folder, branch and local changes (build/ is excluded).
    await expect(status(page)).toContainText('octo/paper/paper · main · 4 local changes · up to date with GitHub');
    await expect(status(page)).toContainText('GitHub and GitLab plugin');
    await shoot(page,'git-status-bar',page.locator('.editor-header'));
    // Someone pushes to the branch; Check finds it; a push is refused until a pull.
    const before=repo.commitFiles('main',{'paper/sections/intro.tex':'\\section{Intro}\nNew intro from GitHub.\n','paper/refs.bib':null,'paper/appendix.tex':'\\appendix\n'},{message:'Remote edits',author:'Grace'});
    await status(page).getByRole('button',{name:'Check'}).click();
    await expect(notice(page)).toContainText('main on GitHub has 1 new commit. Pull to review them.');
    await expect(status(page)).toContainText('1 new commit on GitHub');
    await edit(page,'main.tex','Line 5 of the paper.','Line 5, edited here.');
    await status(page).getByRole('button',{name:'Push'}).click();
    await expect(notice(page)).toContainText(/main on GitHub moved since your last sync \([0-9a-f]{7} → [0-9a-f]{7}\)\. Pull first; Scribyra never force-pushes\./);
    expect(repo.branches.get('main')).toBe(before);
    // Pull per file: take two changes, leave the new appendix for later.
    await status(page).getByRole('button',{name:'Pull'}).click();await expect(pull).toBeVisible();
    await expect(pull.getByRole('group',{name:'sections/intro.tex',exact:true})).toContainText('Changed on GitHub');
    await expect(pull.getByRole('group',{name:'Changes to sections/intro.tex'}).locator('li.is-removed')).toContainText('Old intro.');
    await expect(pull.getByRole('group',{name:'Changes to sections/intro.tex'}).locator('li.is-added')).toContainText('New intro from GitHub.');
    await expect(pull.getByRole('group',{name:'refs.bib',exact:true})).toContainText('Removed on GitHub');
    await pull.getByRole('group',{name:'appendix.tex',exact:true}).getByRole('radio',{name:'Not now'}).check();
    await shoot(page,'git-pull-diff',pull);await axe(page,'.plugin-dialog');
    await pull.getByRole('button',{name:'Apply selected'}).click();await expect(pull).toBeHidden();
    await expect(notice(page)).toContainText(/Pulled main at [0-9a-f]{7}: 0 added, 1 changed, 1 removed\. 1 change left for later\./);
    expect(await source(page,'sections/intro.tex')).toContain('New intro from GitHub.');
    expect(await paths(page)).not.toContain('refs.bib');expect(await paths(page)).not.toContain('appendix.tex');
    expect(await source(page,'main.tex')).toContain('Line 5, edited here.');
    // Push: secrets and excluded files stay here.
    await status(page).getByRole('button',{name:'Push'}).click();
    const push=page.getByRole('dialog',{name:'Push to GitHub'});await expect(push).toBeVisible();
    await expect(push.getByRole('group',{name:'main.tex',exact:true})).toContainText('Changed here');
    await expect(push.getByRole('group',{name:'Changes to main.tex'}).locator('li.is-added')).toContainText('Line 5, edited here.');
    await expect(push.getByLabel('Include main.tex')).toBeChecked();await expect(push.getByLabel('Include notes.tex')).toBeChecked();await expect(push.getByLabel('Include .scribyraignore')).toBeChecked();
    await expect(push.getByLabel('Include .env')).not.toBeChecked();await expect(push.getByRole('group',{name:'.env',exact:true})).toContainText('Its name looks like a key or credentials file');
    await expect(push.getByLabel('Include leak.tex')).toBeDisabled();await expect(push.getByRole('group',{name:'leak.tex',exact:true})).toContainText('Contains what looks like a GitHub access token; Scribyra will not push it.');
    await expect(push).toContainText('1 excluded file (.scribyraignore or settings)');
    await expect(push).toContainText('Comments, reviews and history stay on this device.');
    await push.getByRole('button',{name:'Push',exact:true}).click();await expect(push.getByRole('status')).toHaveText('Write a commit message.');
    await push.getByLabel('Commit message').fill('Edit the paper in Scribyra');
    await shoot(page,'git-push-dialog',push);await axe(page,'.plugin-dialog');
    await push.getByRole('button',{name:'Push',exact:true}).click();await expect(push).toBeHidden();
    await expect(notice(page)).toContainText(/Pushed 3 files to main on GitHub as [0-9a-f]{7}\. 2 changes stay here, not pushed\./);
    const head=repo.branches.get('main'),commit=repo.objects.get(head);
    expect(commit.parents).toEqual([before]);expect(commit.message).toBe('Edit the paper in Scribyra');expect(commit.author).toBe('octocat');
    const remote=repo.files('main');
    expect(Object.keys(remote).sort()).toEqual(['README.md','paper/.scribyraignore','paper/appendix.tex','paper/figure.png','paper/link.tex','paper/main.tex','paper/notes.tex','paper/sections/intro.tex','paper/vendor']);
    expect(remote['paper/main.tex']).toContain('Line 5, edited here.');expect(remote['paper/notes.tex']).toBe('Local notes.\n');expect(remote['paper/appendix.tex']).toBe('\\appendix\n');
    expect(repo.flatten(commit.tree).get('paper/link.tex').mode).toBe('120000');expect(repo.flatten(commit.tree).get('paper/vendor').mode).toBe('160000');
    await expect(status(page)).toContainText('octo/paper/paper · main · 2 local changes · up to date with GitHub');
    // The change left for later is still offered.
    await status(page).getByRole('button',{name:'Pull'}).click();await expect(pull).toBeVisible();
    await expect(pull).toContainText('1 file changed on GitHub since your last sync.');await expect(pull.getByRole('group',{name:'appendix.tex',exact:true})).toBeVisible();
    await pull.getByRole('button',{name:'Apply selected'}).click();await expect(pull).toBeHidden();
    expect(await source(page,'appendix.tex')).toBe('\\appendix\n');

    // The token: sent only to api.github.com (the fake), as Authorization, never anywhere else.
    expect(fake.outside).toEqual([]);
    const authorized=fake.gh.api.log.filter(request=>request.method!=='OPTIONS');
    expect(authorized.length).toBeGreaterThan(10);
    // The one wrong token was tried once, on /user, and refused.
    expect(authorized.filter(request=>request.headers.authorization===`Bearer ${WRONG_TOKEN}`).map(request=>request.url)).toEqual(['/user']);
    for(const request of authorized)if(request.headers.authorization!==`Bearer ${WRONG_TOKEN}`)expect(request.headers.authorization,request.url).toBe(`Bearer ${GH_TOKEN}`);
    for(const request of fake.seen)if(request.headers.includes(GH_TOKEN)||request.url.includes(GH_TOKEN)||request.body.includes(GH_TOKEN))expect(request.url.startsWith(fake.urls['https://api.github.com']+'/'),request.url).toBe(true);
    for(const request of [...fake.gl.requests(),...fake.own.requests()])expect(JSON.stringify(request)).not.toContain(GH_TOKEN);
    // Stored only in the plugins' device-only secrets: not in projects, history, plugin data,
    // local or session storage, the source ZIP, the complete backup or diagnostics.
    await page.evaluate(()=>new Promise(resolve=>setTimeout(resolve,600)));
    const traces=await browserTraces(page);
    expect(traces.databases['scribyra-plugin-secrets']).toContain(GH_TOKEN);expect(traces.databases['scribyra-plugin-secrets']).not.toContain(WRONG_TOKEN);
    for(const [name,text]of Object.entries(traces.databases))if(name!=='scribyra-plugin-secrets')expect(text.includes(GH_TOKEN),name).toBe(false);
    expect(traces.databases['scribyra-plugins']).toContain('octo/paper');
    expect(traces.local.includes(GH_TOKEN)).toBe(false);expect(traces.session.includes(GH_TOKEN)).toBe(false);
    let download=page.waitForEvent('download');await page.getByRole('button',{name:'Export',exact:true}).click();
    const zip=await downloaded(await download);expect(Object.keys(unzipSync(zip))).toContain('sections/intro.tex');expect(contains(zip,GH_TOKEN)).toBe(false);
    const history=page.getByRole('region',{name:'Project history',exact:true});
    await page.getByRole('button',{name:'History',exact:true}).click();await history.getByRole('button',{name:'Manage history',exact:true}).click();
    download=page.waitForEvent('download');await history.getByRole('button',{name:'Export complete backup',exact:true}).click();
    const backup=await downloaded(await download);expect(backup.length).toBeGreaterThan(100);expect(contains(backup,GH_TOKEN)).toBe(false);
    await page.getByRole('button',{name:'History',exact:true}).click();
    await page.evaluate(()=>window.scribyra.action('diagnostics'));const diagnostics=page.getByRole('dialog',{name:'Local diagnostics'});await expect(diagnostics).toBeVisible();
    expect((await diagnostics.textContent()).includes(GH_TOKEN)).toBe(false);await page.keyboard.press('Escape');
    expect(errors).toEqual([]);
  }finally{await fake.close();}
});

test('GitHub: conflicts resolved per file (keep mine, combine, edit), a push racing another push, and a new branch',async({page})=>{
  const fake=await hosts(page),errors=[];page.on('pageerror',error=>errors.push(error.message));
  try{
    const repo=fake.gh.addRepo('octo/paper');fake.gh.addToken(GH_TOKEN,{login:'octocat',repos:{'octo/paper':'write'}});
    repo.commitFiles('main',{'main.tex':MAIN,'refs.bib':BIB,'figure.png':PNG});
    await openProject(page,{'main.tex':MAIN,'refs.bib':BIB,'figure.png':PNG_B});
    await installPlugin(page);
    const panel=await morePanel(page);await panel.getByRole('button',{name:'Link to a repository…'}).click();
    const link=await fillGitHub(page);await link.getByRole('button',{name:'Link and pull'}).click();
    // Both sides have figure.png with different bytes: a conflict that needs a choice.
    const pull=page.getByRole('dialog',{name:'Pull from GitHub'});await expect(pull).toBeVisible();
    const figure=pull.getByRole('group',{name:'figure.png',exact:true});
    await expect(figure).toContainText('Added here too');await expect(figure.getByRole('radio')).toHaveCount(2);
    await pull.getByRole('button',{name:'Apply selected'}).click();
    await expect(pull.getByRole('status')).toHaveText('Choose what to do with figure.png first.');
    await figure.getByRole('radio',{name:'Keep mine'}).check();
    await pull.getByRole('button',{name:'Apply selected'}).click();await expect(pull).toBeHidden();
    await expect(notice(page)).toContainText('Kept your version of 1 file.');
    await expect(status(page)).toContainText('octo/paper · main · 1 local change');
    // Both sides edit: main.tex overlaps (line 3), refs.bib does not.
    await edit(page,'main.tex','Line 3 of the paper.','Line 3, as I wrote it.');
    await edit(page,'refs.bib','First title','First title, revised here');
    const moved=repo.commitFiles('main',{'main.tex':MAIN.replace('Line 3 of the paper.','Line 3, as GitHub has it.').replace('Line 9 of the paper.','Line 9, also from GitHub.'),'refs.bib':BIB.replace('Second title','Second title, revised on GitHub')});
    await status(page).getByRole('button',{name:'Push'}).click();
    await expect(notice(page)).toContainText('Pull first; Scribyra never force-pushes.');expect(repo.branches.get('main')).toBe(moved);
    await status(page).getByRole('button',{name:'Pull'}).click();await expect(pull).toBeVisible();
    await expect(pull).toContainText('2 files changed on GitHub since your last sync; 2 of them were also changed here.');
    const main=pull.getByRole('group',{name:'main.tex',exact:true}),bib=pull.getByRole('group',{name:'refs.bib',exact:true});
    await expect(main.getByRole('group',{name:'Your changes to main.tex'}).locator('li.is-added')).toHaveText(/Line 3, as I wrote it\./);
    await expect(main.getByRole('group',{name:'Changes on GitHub to main.tex'}).locator('li.is-added')).toHaveText([/Line 3, as GitHub has it\./,/Line 9, also from GitHub\./]);
    // Overlapping edits cannot be combined automatically; separate ones can.
    await expect(main.getByRole('radio',{name:/Combine both/})).toHaveCount(0);
    await bib.getByRole('radio',{name:'Combine both (they changed different lines)'}).check();
    await main.getByRole('radio',{name:'Edit the result'}).check();
    const result=main.getByLabel('Result for main.tex');await expect(result).toBeVisible();
    await expect(result).toHaveValue(/<<<<<<< mine \(this project\)\nLine 3, as I wrote it\.\n\|\|\|\|\|\|\| base \(last sync\)\nLine 3 of the paper\.\n=======\nLine 3, as GitHub has it\.\n>>>>>>> theirs \(GitHub\)\n/);
    await expect(result).toHaveValue(/Line 9, also from GitHub\./);
    await shoot(page,'git-conflict',pull);await axe(page,'.plugin-dialog');
    await pull.getByRole('button',{name:'Apply selected'}).click();
    await expect(pull.getByRole('status')).toHaveText('main.tex still has conflict markers. Edit them out first.');
    const resolved=MAIN.replace('Line 3 of the paper.','Line 3, written together.').replace('Line 9 of the paper.','Line 9, also from GitHub.');
    await result.fill(resolved);
    await pull.getByRole('button',{name:'Apply selected'}).click();await expect(pull).toBeHidden();
    expect(await source(page,'main.tex')).toBe(resolved);
    expect(await source(page,'refs.bib')).toBe(BIB.replace('First title','First title, revised here').replace('Second title','Second title, revised on GitHub'));
    // A push that races another: GitHub only fast-forwards, so nothing of ours lands.
    let other=null;fake.gh.state.beforeRefUpdate=()=>{fake.gh.state.beforeRefUpdate=null;other=repo.commitFiles('main',{'README.md':'Someone else.\n'},{author:'Grace'});};
    await status(page).getByRole('button',{name:'Push'}).click();
    const push=page.getByRole('dialog',{name:'Push to GitHub'});await expect(push).toBeVisible();
    await expect(push.getByRole('group',{name:'figure.png',exact:true})).toContainText('Binary');
    await push.getByLabel('Commit message').fill('Merge my edits');await push.getByRole('button',{name:'Push',exact:true}).click();await expect(push).toBeHidden();
    await expect(notice(page)).toContainText('Someone pushed to main on GitHub while you were pushing. Nothing was changed there. Pull, then push again.');
    expect(repo.branches.get('main')).toBe(other);expect(repo.files('main')['main.tex']).toBe(repo.files(moved)['main.tex']);
    // Pull the other change, then the push goes through on top of it.
    await status(page).getByRole('button',{name:'Pull'}).click();await expect(pull).toBeVisible();
    await expect(pull.getByRole('group',{name:'README.md',exact:true})).toContainText('Added on GitHub');
    await pull.getByRole('button',{name:'Apply selected'}).click();await expect(pull).toBeHidden();
    await status(page).getByRole('button',{name:'Push'}).click();await expect(push).toBeVisible();
    await push.getByLabel('Commit message').fill('Merge my edits');await push.getByRole('button',{name:'Push',exact:true}).click();await expect(push).toBeHidden();
    await expect(notice(page)).toContainText(/Pushed 3 files to main on GitHub as [0-9a-f]{7}\./);
    const merged=repo.objects.get(repo.branches.get('main'));expect(merged.parents).toEqual([other]);
    expect(repo.files('main')['main.tex']).toBe(resolved);expect(Buffer.compare(repo.files('main',{binary:true})['figure.png'],Buffer.from(PNG_B))).toBe(0);
    // A new branch: main stays where it is and the project follows the new branch.
    const mainHead=repo.branches.get('main');
    await edit(page,'main.tex','Line 7 of the paper.','Line 7, a draft.');
    await status(page).getByRole('button',{name:'Push'}).click();await expect(push).toBeVisible();
    await push.getByRole('radio',{name:'To a new branch'}).check();
    await push.getByLabel('New branch name').fill('bad..name');await push.getByLabel('Commit message').fill('Draft');await push.getByRole('button',{name:'Push',exact:true}).click();
    await expect(push.getByRole('status')).toHaveText('Enter a valid new branch name, like scribyra/my-changes.');
    await push.getByLabel('New branch name').fill('scribyra/draft');await push.getByRole('button',{name:'Push',exact:true}).click();await expect(push).toBeHidden();
    await expect(notice(page)).toContainText('to scribyra/draft on GitHub');await expect(notice(page)).toContainText('This project now follows scribyra/draft.');
    expect(repo.branches.get('main')).toBe(mainHead);expect(repo.objects.get(repo.branches.get('scribyra/draft')).parents).toEqual([mainHead]);
    await expect(status(page)).toContainText('octo/paper · scribyra/draft · no local changes');
    expect(errors).toEqual([]);
  }finally{await fake.close();}
});

test('Reviewing turns pulled text changes into suggestions credited to the plugin; Viewing refuses',async({page})=>{
  const fake=await hosts(page),errors=[];page.on('pageerror',error=>errors.push(error.message));
  try{
    const repo=fake.gh.addRepo('octo/paper');fake.gh.addToken(GH_TOKEN,{login:'octocat',repos:{'octo/paper':'write'}});
    repo.commitFiles('main',{'main.tex':MAIN});
    await openProject(page,{'main.tex':MAIN});
    await installPlugin(page);
    const panel=await morePanel(page);await panel.getByRole('button',{name:'Link to a repository…'}).click();
    const link=await fillGitHub(page);await link.getByRole('button',{name:'Link and pull'}).click();
    await expect(notice(page)).toContainText('nothing to change here');
    repo.commitFiles('main',{'main.tex':MAIN.replace('Line 4 of the paper.','Line 4, from GitHub.'),'new.tex':'New file.\n'});
    // Viewing: the buttons say why they are off, and the panel's Pull is refused.
    await page.getByRole('combobox',{name:'Editor mode'}).selectOption('viewing');
    await expect(status(page).getByRole('button',{name:'Pull'})).toBeDisabled();
    await expect(status(page).getByRole('button',{name:'Pull'})).toHaveAttribute('title','Viewing is read only. Switch to Editing to pull.');
    await expect(status(page).getByRole('button',{name:'Push'})).toBeDisabled();
    const more=await morePanel(page);await more.getByRole('button',{name:'Pull…'}).click();
    await expect(notice(page)).toContainText('Viewing is read only. Switch to Editing to pull.');
    expect(await source(page,'main.tex')).toBe(MAIN);
    // Reviewing: text changes become suggestions; the new file waits for Editing.
    await page.getByRole('combobox',{name:'Editor mode'}).selectOption('reviewing');
    await expect(status(page).getByRole('button',{name:'Pull'})).toBeEnabled();
    await status(page).getByRole('button',{name:'Pull'}).click();
    const pull=page.getByRole('dialog',{name:'Pull from GitHub'});await expect(pull).toBeVisible();
    await expect(pull).toContainText('You are Reviewing: text changes become suggestions credited to this plugin');
    await pull.getByRole('button',{name:'Suggest selected'}).click();await expect(pull).toBeHidden();
    await expect(notice(page)).toContainText('1 suggestion from main are in the review “GitHub and GitLab suggestions”. Accept them, then pull again to finish.');
    await expect(notice(page)).toContainText('1 file added, deleted or binary need Editing: new.tex.');
    expect(await source(page,'main.tex')).toBe(MAIN);expect(await paths(page)).toEqual(['main.tex']);
    await expect.poll(()=>page.evaluate(()=>[...document.querySelectorAll('*')].some(node=>node.children.length===0&&node.textContent?.includes('GitHub and GitLab (plugin)')))).toBe(true);
    await expect.poll(()=>page.evaluate(()=>document.body.textContent.includes('Line 4, from GitHub.'))).toBe(true);
    // Editing: the same changes are still offered, and now apply.
    await page.getByRole('combobox',{name:'Editor mode'}).selectOption('editing');
    await status(page).getByRole('button',{name:'Pull'}).click();await expect(pull).toBeVisible();
    await expect(pull).toContainText('2 files changed on GitHub since your last sync.');
    await pull.getByRole('button',{name:'Apply selected'}).click();await expect(pull).toBeHidden();
    expect(await source(page,'main.tex')).toContain('Line 4, from GitHub.');expect(await source(page,'new.tex')).toBe('New file.\n');
    expect(errors).toEqual([]);
  }finally{await fake.close();}
});

test('self-hosted GitLab: Scribyra asks before a new origin, token scopes are explained, pull and push with the commits API, a concurrent edit is refused',async({page})=>{
  const fake=await hosts(page),errors=[];page.on('pageerror',error=>errors.push(error.message));
  try{
    const repo=fake.own.addProject('team/report');
    fake.own.addToken(GL_TOKEN,{username:'ada',scopes:['api'],projects:{'team/report':30}}).addToken(GL_READ_TOKEN,{username:'ada',scopes:['read_api'],projects:{'team/report':30}});
    const REPORT='\\documentclass{report}\n\\begin{document}\nSelf-hosted.\n\\end{document}\n';
    repo.commitFiles('main',{'report.tex':REPORT,'img/figure.png':PNG});
    await openProject(page,{'report.tex':REPORT,'local.tex':'Only here.\n'});
    await installPlugin(page);
    const panel=await morePanel(page);await panel.getByRole('button',{name:'Link to a repository…'}).click();
    const link=page.getByRole('dialog',{name:'Link to a repository'});
    await link.getByLabel('Host').selectOption('custom');
    await link.getByLabel('GitLab server address').fill('https://gitlab.example.org');
    await link.getByLabel('Project (group/…/name)').fill('https://gitlab.example.org/team/report');
    await expect(link.getByRole('link',{name:'project access token'})).toHaveAttribute('href','https://docs.gitlab.com/user/project/settings/project_access_tokens/');
    await expect(link).toContainText('scope “api”. Pulling alone needs “read_api”.');
    await link.getByLabel(/^Access token/).fill(GL_READ_TOKEN);
    await link.getByRole('button',{name:'Check access'}).click();
    // Scribyra's own dialog, not the plugin's, asks about the new origin.
    const ask=page.getByRole('dialog',{name:'Allow GitHub and GitLab to contact gitlab.example.org?'});await expect(ask).toBeVisible();
    await expect(ask).toContainText('It asks to contact https://gitlab.example.org (self-hosted GitLab servers you add).');
    await expect(ask).toContainText('GitHub and GitLab says: to reach the GitLab server you entered');
    await shoot(page,'git-origin-consent',ask);await axe(page,'.plugin-origin');
    await ask.getByRole('button',{name:'Allow',exact:true}).click();
    await expect(link.getByRole('status')).toContainText('Token for ada can read team/report (private). Branch main is at');
    await expect(link.getByRole('status')).toContainText('The token has “read_api”: you can pull, but pushing needs “api”.');
    await link.getByLabel(/^Access token/).fill(GL_TOKEN);await link.getByRole('button',{name:'Check access'}).click();
    await expect(link.getByRole('status')).not.toContainText('read_api');await expect(link.getByRole('status')).toContainText('Token for ada can read team/report');
    await link.getByRole('button',{name:'Link and pull'}).click();
    const pull=page.getByRole('dialog',{name:'Pull from gitlab.example.org'});await expect(pull).toBeVisible();
    await expect(pull.getByRole('group',{name:'img/figure.png',exact:true})).toContainText('Added on gitlab.example.org');
    await pull.getByRole('button',{name:'Apply selected'}).click();await expect(pull).toBeHidden();
    expect(await paths(page)).toEqual(['img/figure.png','local.tex','report.tex']);
    await expect(status(page)).toContainText('team/report · main · 1 local change · up to date with gitlab.example.org');
    // Push: one commit with actions; changed files name their last commit.
    await edit(page,'report.tex','Self-hosted.','Self-hosted, edited.');
    await status(page).getByRole('button',{name:'Push'}).click();
    const push=page.getByRole('dialog',{name:'Push to gitlab.example.org'});await expect(push).toBeVisible();
    await push.getByLabel('Commit message').fill('Edit the report');await push.getByRole('button',{name:'Push',exact:true}).click();await expect(push).toBeHidden();
    await expect(notice(page)).toContainText(/Pushed 2 files to main on gitlab\.example\.org as [0-9a-f]{7}\./);
    const head=repo.branches.get('main');expect(repo.objects.get(head).message).toBe('Edit the report');
    expect(repo.files('main')).toMatchObject({'report.tex':REPORT.replace('Self-hosted.','Self-hosted, edited.'),'local.tex':'Only here.\n'});
    const commitRequest=fake.own.requests().find(request=>request.method==='POST'&&request.url.endsWith('/repository/commits'));
    const body=JSON.parse(commitRequest.body);
    expect(body).toMatchObject({branch:'main',commit_message:'Edit the report'});
    expect(body.actions.map(action=>[action.action,action.file_path,!!action.last_commit_id])).toEqual([['create','local.tex',false],['update','report.tex',true]]);
    // Someone edits report.tex while we push: GitLab refuses the whole commit.
    await edit(page,'report.tex','Self-hosted, edited.','Self-hosted, edited twice.');
    fake.own.state.beforeCommit=()=>{fake.own.state.beforeCommit=null;repo.commitFiles('main',{'report.tex':REPORT.replace('Self-hosted.','Someone else.')},{author:'grace'});};
    await status(page).getByRole('button',{name:'Push'}).click();await expect(push).toBeVisible();
    await push.getByLabel('Commit message').fill('Again');await push.getByRole('button',{name:'Push',exact:true}).click();await expect(push).toBeHidden();
    await expect(notice(page)).toContainText('gitlab.example.org refused the commit: The file has changed since you started editing it: report.tex. Someone changed these files meanwhile; nothing was pushed. Pull, then push again.');
    expect(repo.files('main')['report.tex']).toContain('Someone else.');
    // The allowed origin is listed in the manager, where it can be removed.
    const manager=await openManager(page);
    const allowed=manager.getByRole('list',{name:'Addresses you allowed for GitHub and GitLab'});
    await expect(allowed).toContainText('Also contact https://gitlab.example.org (you allowed it)');
    await allowed.getByRole('button',{name:'Remove https://gitlab.example.org'}).click();
    await expect(manager.getByRole('status')).toContainText('GitHub and GitLab can no longer contact https://gitlab.example.org.');
    await manager.getByRole('button',{name:'Close',exact:true}).click();
    await status(page).getByRole('button',{name:'Check'}).click();
    await expect(notice(page)).toContainText('This plugin may not contact https://gitlab.example.org: it was removed in the Plugins manager, with the token bound to it.');
    await expect(page.getByRole('dialog',{name:'GitLab access token needed'})).toHaveCount(0);
    // Removing the origin deleted the token bound to it.
    expect((await browserTraces(page)).databases['scribyra-plugin-secrets']).not.toContain(GL_TOKEN);
    // Tokens went only to the self-hosted server, as PRIVATE-TOKEN.
    expect(fake.outside).toEqual([]);
    for(const request of fake.own.requests().filter(request=>request.method!=='OPTIONS'))expect([GL_TOKEN,GL_READ_TOKEN]).toContain(request.headers['private-token']);
    for(const request of [...fake.gh.requests(),...fake.gl.requests()]){expect(JSON.stringify(request)).not.toContain(GL_TOKEN);expect(JSON.stringify(request)).not.toContain(GL_READ_TOKEN);}
    expect(fake.gl.requests()).toEqual([]);
    const traces=await browserTraces(page);
    for(const [name,text]of Object.entries(traces.databases))if(name!=='scribyra-plugin-secrets')expect(text.includes(GL_TOKEN),name).toBe(false);
    expect(errors).toEqual([]);
  }finally{await fake.close();}
});

test('Open in Scribyra: an imported project is offered “Link to this repository” and merges from the commit it was imported at',async({page})=>{
  const fake=await hosts(page),errors=[];page.on('pageerror',error=>errors.push(error.message));
  try{
    const repo=fake.gh.addRepo('octo/paper',{private:false});fake.gh.addToken(GH_TOKEN,{login:'octocat',repos:{'octo/paper':'write'}});
    repo.commitFiles('main',{'README.md':'# Paper\n','paper/main.tex':MAIN,'paper/refs.bib':BIB});
    const imported=repo.branches.get('main');
    // The plugin is installed once, in any project; it then runs for every project.
    await openProject(page,{'scratch.tex':'scratch\n'});await installPlugin(page);
    await page.goto('/#open?repo=github.com/octo/paper&path=paper');
    const open=page.getByRole('dialog');await expect(open).toBeVisible();
    await open.getByRole('button',{name:'Check repository',exact:true}).click();
    await expect(open.getByRole('button',{name:'Import',exact:true})).toBeVisible({timeout:60000});
    await open.getByRole('button',{name:'Import',exact:true}).click();
    await expect(page.getByRole('textbox',{name:'LaTeX source',exact:true})).toBeVisible({timeout:60000});
    await expect(status(page)).toContainText('Imported from github.com/octo/paper (paper)',{timeout:30000});
    await expect(status(page).getByRole('button',{name:'Link to this repository'})).toBeVisible();
    // After the import: a local edit and a remote commit to different lines of main.tex.
    await edit(page,'main.tex','Line 3 of the paper.','Line 3, edited after import.');
    repo.commitFiles('main',{'paper/main.tex':MAIN.replace('Line 8 of the paper.','Line 8, from GitHub.'),'paper/refs.bib':BIB.replace('First title','First title, on GitHub')});
    await status(page).getByRole('button',{name:'Link to this repository'}).click();
    const link=page.getByRole('dialog',{name:'Link to a repository'});await expect(link).toBeVisible();
    await expect(link).toContainText(`Imported from github.com/octo/paper · commit ${imported.slice(0,7)} · folder paper`);
    await expect(link.getByLabel('Repository (owner/name)')).toHaveValue('octo/paper');await expect(link.getByLabel('Folder in the repository (optional)')).toHaveValue('paper');
    await link.getByLabel(/^Access token/).fill(GH_TOKEN);await link.getByRole('button',{name:'Check access'}).click();
    await expect(link.getByRole('status')).toContainText('Token for octocat can read octo/paper (public).');
    await link.getByRole('button',{name:'Link and pull'}).click();
    // The import commit is the base: refs.bib changed only there; main.tex changed on both sides, apart.
    const pull=page.getByRole('dialog',{name:'Pull from GitHub'});await expect(pull).toBeVisible();
    await expect(pull).toContainText(`${imported.slice(0,7)} → `);
    const bib=pull.getByRole('group',{name:'refs.bib',exact:true});await expect(bib).toContainText('Changed on GitHub');await expect(bib).not.toContainText('here too');
    const main=pull.getByRole('group',{name:'main.tex',exact:true});await expect(main).toContainText('Changed here too');
    await main.getByRole('radio',{name:'Combine both (they changed different lines)'}).check();
    await pull.getByRole('button',{name:'Apply selected'}).click();await expect(pull).toBeHidden();
    expect(await source(page,'main.tex')).toBe(MAIN.replace('Line 3 of the paper.','Line 3, edited after import.').replace('Line 8 of the paper.','Line 8, from GitHub.'));
    expect(await source(page,'refs.bib')).toBe(BIB.replace('First title','First title, on GitHub'));
    await expect(status(page)).toContainText('octo/paper/paper · main · 1 local change · up to date with GitHub');
    expect(fake.outside).toEqual([]);
    expect(errors).toEqual([]);
  }finally{await fake.close();}
});
