import {build} from 'esbuild';
import {readFile} from 'node:fs/promises';
// Compile the real main module with a controlled compiler and test-only entry points.
// Scheduling, document updates, command dispatch and IndexedDB remain unchanged.
// Like a default Vite build, it has no telemetry destination, so no consent prompt.
export async function foundationMain(){
 const result=await build({entryPoints:['web/main.js'],bundle:true,format:'esm',platform:'browser',write:false,loader:{'.css':'empty'},define:{'import.meta.env.PROD':'false','import.meta.env.BASE_URL':'"/"','import.meta.env.VITE_TELEMETRY_INGEST_URL':'undefined','import.meta.env.VITE_TELEMETRY_DESTINATION_LABEL':'undefined','import.meta.env.VITE_TELEMETRY_ABOUT_URL':'undefined','import.meta.env.VITE_TELEMETRY_SESSION_RATE':'undefined'},plugins:[{name:'foundation-main',setup(build){
  build.onResolve({filter:/\?url$/},args=>({path:args.path,namespace:'foundation-url'}));
  build.onLoad({filter:/.*/,namespace:'foundation-url'},()=>({contents:'export default "/unused-foundation-worker.js";',loader:'js'}));
  build.onLoad({filter:/\/web\/compiler\.js$/},()=>({contents:`
   window.foundationJobs=[];
   export function compileProject(inputs){return new Promise(resolve=>window.foundationJobs.push({inputs,resolve}));}
   export function cancelCompile(){}
  `,loader:'js'}));
  build.onLoad({filter:/\/web\/main\.js$/},async args=>({contents:await readFile(args.path,'utf8')+`
   import {collaborationCommands as foundationCommands} from './collaboration-commands.js';
   window.foundationMain={async start(kind){
    await flushSave();const head=(await storage.listProjects()).find(p=>p.id===projectId),host=foundationCommands({doc,projectId,storage,flushSave});
    host.register('history.name',{capabilities:['history'],prepare:()=>Y.encodeStateAsUpdate(doc),async commit(update,scope){
     await scope.commitPrepared(head.sequence,update,[],[],result=>({valueVersion:1,localSequence:result.sequence}));scope.guard();
     if(kind==='preview')await builds.run({projectId,revision:commands.revision(),inputs:{files:[{path:'main.tex',content:'preview source'}],mainFile:'main.tex',engine:'lualatex'},destination:()=>{}});
     else await runCompile();
     return{valueVersion:1};
    }});
    window.foundationPending=host.execute({version:2,requestId:crypto.randomUUID(),projectId,expectedRevision:host.revision(),command:{op:'history.name'}}).finally(()=>host.close());
   },state:()=>({busy:state.busy,pending:autoPending}),leave:()=>leaveProject()};
  `,loader:'js'}));
 }}]});return result.outputFiles[0].text;
}
