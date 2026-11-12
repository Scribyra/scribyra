// Turns an assembled Pages folder into the dev.scribyra.com staging site, and checks it.
//
//   node scripts/staging-pages.mjs prepare .cache/staging   (after build-pages --staging)
//   node scripts/staging-pages.mjs check   .cache/staging
//
// <root>/site is the folder that scripts/deploy-staging.mjs publishes as `public/` in
// the staging project (urundead-labs/scribyra-staging), whose own pages job serves it.
import {readFile,writeFile,readdir,rename,rm} from 'node:fs/promises';
import {join,relative,extname,sep} from 'node:path';
import {pathToFileURL} from 'node:url';
import {officialTelemetryEndpoint} from './official-telemetry.mjs';

export const NOINDEX='<meta name="robots" content="noindex, nofollow">';
export const BANNER_ATTRIBUTE='data-scribyra-staging-banner';
export const BANNER=`<div ${BANNER_ATTRIBUTE} role="note" style="position:sticky;top:0;z-index:2147483000;margin:0;padding:6px 12px;background:#b45309;color:#fff;font:600 13px/1.4 system-ui,sans-serif;text-align:center">Staging — a test build of the next release. Projects here are separate from app.scribyra.com and may be reset.</div>`;
export const ROBOTS='User-agent: *\nDisallow: /\n';
const STAGING_RELEASE=/^dev-[1-9]\d{0,11}-[a-f0-9]{7,40}$/;
const TEXT=new Set(['.html','.js','.mjs','.css','.json','.md','.txt','.xml','.svg','.webmanifest']);
const FORBIDDEN=[officialTelemetryEndpoint,'faro-collector','grafana.net/collect'];

// Every page gets noindex; site pages (not the app's own shell) also get the banner.
// The root index.html is the domain router: on dev.scribyra.com it replaces the body
// with the app, whose own badge then marks it; on any other host the banner stays.
export function stagingHtml(html,{banner=true}={}){
 let out=html;
 // Pages may omit <head> and <body> (both are optional in HTML); then noindex goes right
 // after <html>, or first, and the banner is fixed at the top from the end of the page.
 if(!/<meta\s+name="robots"\s+content="noindex/i.test(out)){const head=/<head[^>]*>/i.exec(out)||/<html[^>]*>/i.exec(out);const at=head?head.index+head[0].length:0;out=out.slice(0,at)+NOINDEX+out.slice(at);}
 if(banner&&!out.includes(BANNER_ATTRIBUTE)){const body=/<body[^>]*>/i.exec(out);if(body)out=out.slice(0,body.index+body[0].length)+BANNER+out.slice(body.index+body[0].length);else{const end=/<\/html>\s*$/i.exec(out),at=end?end.index:out.length;out=out.slice(0,at)+BANNER.replace('position:sticky;top:0','position:fixed;top:0;left:0;right:0')+out.slice(at);}}
 return out;
}

async function* files(directory){for(const entry of await readdir(directory,{withFileTypes:true})){const path=join(directory,entry.name);if(entry.isDirectory())yield*files(path);else if(entry.isFile())yield path;}}
const urlPath=(site,file)=>'/'+relative(site,file).split(sep).join('/');

export async function prepare(root){
 const site=join(root,'site');let pages=0;
 for await(const file of files(site)){
  if(extname(file)!=='.html')continue;
  // Files are hard links into the build folders; write a new file rather than through the link.
  const html=stagingHtml(await readFile(file,'utf8'),{banner:urlPath(site,file)!=='/app/index.html'});
  await writeFile(file+'.tmp',html);await rename(file+'.tmp',file);pages++;
 }
 await writeFile(join(site,'robots.txt.tmp'),ROBOTS);await rename(join(site,'robots.txt.tmp'),join(site,'robots.txt'));
 // Production's sitemap lists scribyra.com pages; staging offers none.
 await rm(join(site,'sitemap.xml'),{force:true});
 return pages;
}

// Returns a list of problems; empty means the folder is a valid staging site.
export async function check(root){
 const site=join(root,'site'),problems=[];let marker=false;
 for await(const file of files(site)){
  if(!TEXT.has(extname(file)))continue;
  const path=urlPath(site,file),text=await readFile(file,'utf8');
  if(FORBIDDEN.some(value=>text.includes(value)))problems.push(`${path} contains a telemetry collector address`);
  if(extname(file)==='.html'){
   if(!/<meta\s+name="robots"\s+content="noindex/i.test(text))problems.push(`${path} lacks noindex`);
   if(path!=='/app/index.html'&&!text.includes(BANNER_ATTRIBUTE))problems.push(`${path} lacks the staging banner`);
  }
  if(extname(file)==='.js'&&text.includes('staging-marker')&&/dev-[1-9]\d*-[a-f0-9]{7,40}/.test(text))marker=true;
 }
 if(!marker)problems.push('No app bundle carries the staging marker and a dev release label');
 const read=async path=>{try{return await readFile(join(site,path),'utf8');}catch{return null;}};
 if(await read('robots.txt')!==ROBOTS)problems.push('robots.txt does not disallow everything');
 if(await read('sitemap.xml')!==null)problems.push('sitemap.xml must not be published on staging');
 for(const path of ['release.json','app/release.json']){
  let release;try{release=JSON.parse(await read(path)??'null')?.release;}catch{}
  if(!STAGING_RELEASE.test(release||''))problems.push(`${path} does not name a dev-<number>-<sha> release`);
 }
 for(const path of ['index.html','sw.js','domain-router.js','app/index.html','app/sw.js'])if(await read(path)===null)problems.push(`${path} is missing`);
 return problems;
}

if(import.meta.url===pathToFileURL(process.argv[1]).href){
 const[command,root]=process.argv.slice(2);
 if(!['prepare','check'].includes(command)||!root)throw Error('Usage: staging-pages.mjs prepare|check <folder>');
 if(command==='prepare')console.log(`Staging site prepared: noindex on ${await prepare(root)} page(s), robots.txt disallows all.`);
 else{const problems=await check(root);if(problems.length){console.error('Staging check failed:\n- '+problems.join('\n- '));process.exit(1);}console.log('Staging check passed: noindex, robots, staging marker, no collector address.');}
}
