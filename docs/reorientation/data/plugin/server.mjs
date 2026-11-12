// Read-only static server for main checkout dist on 5192; optionally serves draft agent docs at /agent.md.
import http from 'node:http';import fs from 'node:fs';import path from 'node:path';
const DIST='<repo>/dist';const HERE=path.dirname(new URL(import.meta.url).pathname);
const MIME={'.html':'text/html; charset=utf-8','.js':'text/javascript','.mjs':'text/javascript','.css':'text/css','.json':'application/json','.wasm':'application/wasm','.svg':'image/svg+xml','.gz':'application/gzip','.xz':'application/x-xz','.md':'text/markdown; charset=utf-8','.txt':'text/plain'};
http.createServer((req,res)=>{let p=decodeURIComponent(new URL(req.url,'http://x').pathname);if(p==='/'){res.writeHead(302,{location:'/app/'});return res.end();}if(p.startsWith('/app/'))p=p.slice(4);else if(p!=='/agent.md'){res.writeHead(404);return res.end();}
 if(p==='/agent.md'){res.writeHead(200,{'content-type':MIME['.md']});return res.end(fs.readFileSync(HERE+'/../package/skills/scribyra/references/page-recipe.md'));}
 let f=path.join(DIST,p==='/'?'index.html':p);if(!f.startsWith(DIST)||!fs.existsSync(f)||fs.statSync(f).isDirectory())f=path.join(DIST,'index.html');
 res.writeHead(200,{'content-type':MIME[path.extname(f)]||'application/octet-stream','content-length':fs.statSync(f).size,'cache-control':'no-cache'});fs.createReadStream(f).pipe(res);
}).listen(5192,'127.0.0.1',()=>console.log('5192 up'));
