// Official releases select the public Faro collector; ordinary builds stay unset.
// `--staging` builds the dev.scribyra.com site instead: no collector address, a
// dev-<pipeline>-<sha> release label, its own domain file and output folder
// (.cache/staging), then scripts/staging-pages.mjs adds noindex, robots.txt and the
// staging banner. scripts/deploy-staging.mjs publishes it to the staging project.
import {execFileSync} from 'node:child_process';
import {officialTelemetryEnv,officialSessionRateEnv} from './official-telemetry.mjs';
const staging=process.argv.includes('--staging');
if(!staging){
 // A self-hoster's own address must not inherit the official label or disclosure page.
 // Only the official destination takes the CI session rate; a self-hoster sets its own
 // VITE_TELEMETRY_SESSION_RATE, if any, with its own address.
 const env={...process.env,...(process.env.VITE_TELEMETRY_INGEST_URL?{}:{...officialTelemetryEnv,...officialSessionRateEnv(process.env.SCRIBYRA_TELEMETRY_SESSION_RATE)})};
 execFileSync('npm',['run','build','--','--base=/app/'],{env,stdio:'inherit'});
 execFileSync('npx',['vite','build','--base=/','--outDir=.cache/pages-root-shell'],{env:{...env,SCRIBYRA_ROOT_SHELL:'1',VITE_TEX_ASSET_BASE:'/app/core/busytex'},stdio:'inherit'});
 execFileSync('node',['scripts/ci-pages.mjs'],{env,stdio:'inherit'});
}else{
 // Staging never reports anywhere: drop every telemetry and CI-ingress variable.
 const env=Object.fromEntries(Object.entries(process.env).filter(([name])=>!name.startsWith('VITE_TELEMETRY_')&&!name.startsWith('SCRIBYRA_CI_INGRESS_')));
 const sha=(process.env.CI_COMMIT_SHA||execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim()).slice(0,8);
 env.SCRIBYRA_RELEASE=process.env.SCRIBYRA_RELEASE||`dev-${process.env.CI_PIPELINE_IID||'1'}-${sha}`;
 if(!/^dev-[1-9]\d{0,11}-[a-f0-9]{7,40}$/.test(env.SCRIBYRA_RELEASE))throw Error('Staging release must look like dev-<number>-<short sha>');
 execFileSync('npm',['run','build','--','--base=/app/','--outDir=.cache/staging/app'],{env,stdio:'inherit'});
 execFileSync('npx',['vite','build','--base=/','--outDir=.cache/staging/root-shell'],{env:{...env,SCRIBYRA_ROOT_SHELL:'1',VITE_TEX_ASSET_BASE:'/app/core/busytex'},stdio:'inherit'});
 execFileSync('node',['scripts/ci-pages.mjs'],{env:{...env,SCRIBYRA_PAGES_OUTPUT:'.cache/staging/site',SCRIBYRA_PAGES_APP_DIR:'.cache/staging/app',SCRIBYRA_PAGES_SHELL_DIR:'.cache/staging/root-shell',SCRIBYRA_PAGES_DOMAINS:'ops/pages/domains.staging.json'},stdio:'inherit'});
 execFileSync('node',['scripts/staging-pages.mjs','prepare','.cache/staging'],{env,stdio:'inherit'});
 execFileSync('node',['scripts/staging-pages.mjs','check','.cache/staging'],{env,stdio:'inherit'});
 console.log('Staging site ready in .cache/staging/site, release',env.SCRIBYRA_RELEASE);
}
