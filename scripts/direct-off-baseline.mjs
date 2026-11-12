#!/usr/bin/env node
// Runs tests/helpers/direct-off-scenario.mjs against another git ref's web/ code (default
// `main`) and prints its digest. With --write it records the result as the baseline that
// tests/direct-off.test.mjs compares this tree against.
//
//   node scripts/direct-off-baseline.mjs [--ref=main] [--write]
//
// The ref's web/ and tests/helpers/ are extracted under tmp/direct-off/<ref>/; this tree's
// generated web/pkg (the same Rust validators) and node_modules are reused, and so is this
// tree's scenario, so both sides perform exactly the same operations.
import {execFileSync} from 'node:child_process';
import {cpSync,mkdirSync,rmSync,symlinkSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
const args=Object.fromEntries(process.argv.slice(2).map(arg=>{const [key,value]=arg.replace(/^--/,'').split('=');return[key,value??true];}));
const ref=args.ref||'main',root=resolve('.'),tree=resolve('tmp/direct-off',ref.replace(/[^A-Za-z0-9._-]/g,'_'));
rmSync(tree,{recursive:true,force:true});mkdirSync(tree,{recursive:true});
execFileSync('sh',['-c',`git archive ${JSON.stringify(ref)} web tests/helpers | tar -x -C ${JSON.stringify(tree)}`],{stdio:'inherit'});
cpSync(resolve(root,'web/pkg'),resolve(tree,'web/pkg'),{recursive:true});
cpSync(resolve(root,'tests/helpers/direct-off-scenario.mjs'),resolve(tree,'tests/helpers/direct-off-scenario.mjs'));
symlinkSync(resolve(root,'node_modules'),resolve(tree,'node_modules'),'dir');
writeFileSync(resolve(tree,'package.json'),JSON.stringify({type:'module'}));
const output=execFileSync(process.execPath,[resolve(tree,'tests/helpers/direct-off-scenario.mjs')],{cwd:tree,encoding:'utf8'});
const result={ref,commit:execFileSync('git',['rev-parse',ref],{encoding:'utf8'}).trim(),...JSON.parse(output)};
if(args.write)writeFileSync(resolve(root,'fixtures/direct-off-main.json'),JSON.stringify(result,null,1)+'\n');
process.stdout.write(JSON.stringify(result,null,1)+'\n');
if(!args.keep)rmSync(tree,{recursive:true,force:true});
