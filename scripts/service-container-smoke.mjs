// Local archive only: no registry, bearer credentials or external service.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir,mkdtemp,writeFile,rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { resolve,join } from 'node:path';
import { randomBytes,createHash } from 'node:crypto';
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
await mkdir('tmp',{recursive:true});
const root=await mkdtemp(resolve('tmp/service-container-'));
const store=join(root,'store'),run=join(root,'run'),name=`scribyra-smoke-${process.pid}`;
const flags=['--root',store,'--runroot',run,'--storage-driver','vfs','--events-backend','none'];
const podman=(...args)=>execFileSync('podman',[...flags,...args],{encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
const hostNetwork=process.argv.includes('--host-network');
let created=false,checks=0;
try {
  execFileSync('skopeo',['--policy',resolve('deploy/service-image-policy.json'),'copy',
    `docker-archive:${resolve(process.argv.slice(2).find(arg=>!arg.startsWith('--'))||'result')}`,`containers-storage:[vfs@${store}+${run}]localhost/scribyra-sync:0.1.0-s1`],{stdio:'pipe'});
  const image=podman('image','inspect','localhost/scribyra-sync:0.1.0-s1','--format','{{.Id}}');checks++;
  const bearer=randomBytes(32).toString('hex'),namespace=randomBytes(32).toString('hex');
  const config=join(root,'service.json');
  const probe=createServer();await new Promise(resolve=>probe.listen(0,'127.0.0.1',resolve));
  const port=probe.address().port;await new Promise(resolve=>probe.close(resolve));
  await writeFile(config,JSON.stringify({bind:hostNetwork?`127.0.0.1:${port}`:'0.0.0.0:8787',data:'/data',principals:[{token_hash:hash(bearer),namespace,storage:true,relay:true}]}),{mode:0o644});
  podman('create','--name',name,'--pull=never','--read-only','--cap-drop=ALL',
    '--security-opt=no-new-privileges','--cgroups=disabled','--log-driver=k8s-file',
    ...(hostNetwork?['--network=host']:['--network=slirp4netns','-p',`127.0.0.1:${port}:8787`]),
    '-v',`${name}-data:/data`,'-v',`${config}:/config.json:ro`,
    '-e','SCRIBYRA_SERVICE_CONFIG=/config.json','-e',`SCRIBYRA_SERVICE_BIND=${hostNetwork?`127.0.0.1:${port}`:'0.0.0.0:8787'}`,image);created=true;
  podman('start',name);
  const base=`http://127.0.0.1:${port}`;
  async function ready() {
    for(let n=0;n<100;n++) {
      try {if((await fetch(base+'/ready',{signal:AbortSignal.timeout(500)})).status===200)return;}
      catch {}
      await new Promise(resolve=>setTimeout(resolve,50));
    }
    throw Error('Container readiness deadline: '+podman('inspect',name,'--format','{{json .State}}')+' '+podman('logs',name));
  }
  await ready();checks++;
  assert.equal((await fetch(base+'/health')).status,200);checks++;
  const bytes=randomBytes(32),headers={Authorization:`Bearer ${bearer}`},url=`${base}/v1/objects/${namespace}/${hash(bytes)}`;
  assert.equal((await fetch(url,{method:'PUT',headers,body:bytes})).status,201);checks++;
  podman('stop','--time','30',name);podman('start',name);await ready();checks++;
  const response=await fetch(url,{headers});assert.equal(response.status,200);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()),bytes);checks++;
  assert.equal(podman('inspect',name,'--format','{{.Config.User}}'),'10001:10001');checks++;
  console.log(JSON.stringify({checks,passed:checks,failed:0,image,rootless:true,readOnly:true,cgroups:'disabled',network:hostNetwork?'host loopback only':'slirp4netns',restart:'same container and named volume'}));
} finally {
  if(created){podman('rm','--force',name);podman('volume','rm',`${name}-data`);}
  // The store is exclusive to this drill; unshare removes its subordinate-UID files.
  podman('unshare','rm','-rf',root);
  await rm(root,{recursive:true,force:true});
}
