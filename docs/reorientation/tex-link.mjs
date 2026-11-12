import {gzipSync} from 'node:zlib';
import {readFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {TEX_LINK_LIMITS} from '../../web/tex-link.js';

// Wire format: gzip(UTF-8 source), then unpadded RFC 4648 base64url. No filename
// or project options are accepted: the receiving app always creates main.tex.
export function createTexLink(source,base){
 const bytes=Buffer.from(source,'utf8');
 if(bytes.length>TEX_LINK_LIMITS.source)throw new Error('Source exceeds 65,536 UTF-8 bytes.');
 const encoded=gzipSync(bytes).toString('base64url');
 if(encoded.length>TEX_LINK_LIMITS.encoded)throw new Error('Compressed source exceeds 16,384 base64url characters.');
 const url=new URL(base);
 if(!['http:','https:'].includes(url.protocol))throw new Error('Use an HTTP(S) app URL.');
 url.hash=`tex=${encoded}`;return url.href;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 const [base,file]=process.argv.slice(2);
 if(!base||!file)throw new Error('Usage: node docs/reorientation/tex-link.mjs APP_URL SOURCE.tex');
 console.log(createTexLink(await readFile(file,'utf8'),base));
}
