import {test,expect,chromium,firefox} from '@playwright/test';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdir,readFile,rm} from 'node:fs/promises';
import {webdriverShim} from '../helpers/webdriver-shim.mjs';
import {parseArguments,plan,tunnelArguments,remoteScript} from '../../scripts/direct-session-trial.mjs';
const run=promisify(execFile);

test('the SSH plan uses store browsers, reverse tunnels and exact-PID cleanup, and carries no capability',async({},info)=>{
 test.skip(info.project.name!=='chromium','Argument checks need one engine.');
 const config=parseArguments(['--mode=mixed','--a=one.example','--b=two.example','--user=person','--key=/k']),[a,b]=config.machines,args=tunnelArguments(a,config,5000,5001),script=remoteScript(a,config);
 expect(args).toEqual(expect.arrayContaining(['-R','18765:127.0.0.1:5000','-R','18787:127.0.0.1:5001','-L','9411:127.0.0.1:9411','-L','9412:127.0.0.1:9412','person@one.example']));
 expect(script).toContain("not in this machine's Nix store");expect(script).toContain('kill "$g" "$c"');expect(script).not.toMatch(/pkill|killall|nix-shell|nix run|curl|bearer/i);
 expect(b.gecko).not.toBe(a.gecko);
 const sessions=plan('mixed',1,config.machines);expect(sessions).toHaveLength(4);
 for(const session of sessions)expect([...session.browsers].sort()).toEqual(['chromium','firefox']);
 expect(new Set(sessions.map(s=>s.browsers[0]+s.machines[0].host)).size).toBe(4);
 expect(plan('smoke',1,config.machines)).toEqual([{machines:[a,b],browsers:['firefox','chromium']}]);
 expect(plan('full',1,config.machines)).toHaveLength(8);
 expect(()=>parseArguments(['--mode=mixed','--a=x'])).toThrow(/both machines/);
 const help=await run('node',['scripts/direct-session-trial.mjs','--help']);expect(help.stdout).toContain('--mode=smoke');
 const dry=await run('node',['scripts/direct-session-trial.mjs','--mode=smoke','--a=one.example','--b=two.example','--dry-run']);expect(dry.stdout).toContain('one.example');expect(dry.stdout).toContain('1 session(s)');
});

test('the trial takes hosts, SSH user and key only from arguments or environment',async({},info)=>{
 test.skip(info.project.name!=='chromium','Argument checks need one engine.');
 // With nothing named, SSH's own configuration decides: the script supplies no identity.
 const bare=parseArguments(['--a=one.example','--b=two.example'],{}),args=tunnelArguments(bare.machines[0],bare,5000,5001);
 expect(bare.user).toBeNull();expect(bare.key).toBeNull();expect(args).not.toContain('-i');expect(args).not.toContain('IdentitiesOnly=yes');expect(args).toContain('one.example');expect(args.join(' ')).not.toContain('@');
 // Environment names them; an explicit argument wins.
 const env={SCRIBYRA_TRIAL_HOST_A:'env-a.example',SCRIBYRA_TRIAL_HOST_B:'env-b.example',SCRIBYRA_TRIAL_USER:'env-user',SCRIBYRA_TRIAL_KEY:'/keys/env'},named=parseArguments([],env),namedArgs=tunnelArguments(named.machines[0],named,5000,5001);
 expect(namedArgs).toEqual(expect.arrayContaining(['-i','/keys/env','IdentitiesOnly=yes','env-user@env-a.example']));expect(named.machines[1].host).toBe('env-b.example');
 const argued=parseArguments(['--a=arg.example','--user=arg-user','--key=/keys/arg'],env);expect(tunnelArguments(argued.machines[0],argued,1,2)).toEqual(expect.arrayContaining(['-i','/keys/arg','arg-user@arg.example']));
 expect(()=>parseArguments(['--mode=smoke'],{})).toThrow(/both machines/);
 const dry=await run('node',['scripts/direct-session-trial.mjs','--mode=smoke','--dry-run'],{env:{...process.env,...env}});expect(dry.stdout).toContain('env-user@env-a.example');expect(dry.stdout).toContain('1 session(s)');
 // No default in the script can name a person's account or key, whatever the environment.
 const text=await readFile('scripts/direct-session-trial.mjs','utf8');expect(text).not.toMatch(/\.ssh\/|homedir\(\),|default [a-z]+_[a-z]+\)/);
});

for(const mode of ['smoke','mixed'])test(`the trial's ${mode} mode drives the real app and service to convergence`,async({},info)=>{
 test.skip(info.project.name!=='chromium','The script starts both engines itself, once.');test.setTimeout(420000);
 const gecko=await webdriverShim(firefox,{executablePath:process.env.PLAYWRIGHT_FIREFOX_EXECUTABLE_PATH||undefined}),chrome=await webdriverShim(chromium,{executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH||undefined,args:['--no-sandbox']}),output=`tmp/direct/shim-${mode}.jsonl`;
 try{
  await mkdir('tmp/direct',{recursive:true});await rm(output,{force:true});
  // Mixed covers one machine direction here: "local" names both ends, so the two flips repeat.
  const result=await run('node',['scripts/direct-session-trial.mjs',`--mode=${mode}`,'--a=local','--b=local',`--local-gecko=${gecko.port}`,`--local-chrome=${chrome.port}`,'--a-ifc=lo','--b-ifc=lo','--mesh-ifc=none0','--rounds=2','--bulk-kib=256',`--output=${output}`],{maxBuffer:1<<20}).catch(error=>error);
  const text=await readFile(output,'utf8').catch(()=>''),rows=text.trim().split('\n').filter(Boolean).map(line=>JSON.parse(line));
  console.log(String(result.stdout||'').split('\n').filter(line=>/Session|CONVERGED|FAILED|converged/.test(line)).join('\n'));
  expect(result.code??0,String(result.stderr||result.stdout).slice(-800)).toBe(0);
  expect(rows).toHaveLength(mode==='smoke'?1:4);
  for(const row of rows){
   expect(row.ok,JSON.stringify(row).slice(0,800)).toBe(true);expect(row.rules.codesMatch).toBe(true);expect(row.rules.noLostEdits).toBe(true);expect(row.rules.commentsAndSuggestions).toBe(true);expect(row.rules.authorityDecision).toBe(true);expect(row.rules.chromiumOffers).toBe(true);
   if(mode==='mixed'){expect(row.rules.rejoinKeepsOfflineWork).toBe(true);expect(row.bytes.bulk.a.wifiTx).toBeGreaterThan(256*1024);}
   expect(row.a.version).not.toBe('unknown');
  }
  // The report must stay free of source, invites, codes and capabilities.
  expect(text).not.toMatch(/#direct=|% typed|% patched|Trial comment|bearer|[0-9a-f]{4} [0-9a-f]{4} [0-9a-f]{4}/);
 }finally{await gecko.close();await chrome.close();await rm(output,{force:true});}
});
