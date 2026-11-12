import * as Y from 'yjs';
import {isBlobRef} from './assets.js';
function versions(doc){
 const result=new Map();for(const[id,file]of doc.getMap('files'))if(file.binary&&!file.folder){const ref=doc.getMap('assets').get(id);if(isBlobRef(ref))result.set(id,ref.hash);}return result;
}
export function concurrentBinaryVersions(a,b){
 const av=versions(a),bv=versions(b);if(![...new Set([...av.keys(),...bv.keys()])].some(id=>av.get(id)!==bv.get(id)))return false;
 // Delete sets matter too: state vectors alone miss concurrent deletion-only edits.
 return !Y.snapshotContainsUpdate(Y.snapshot(a),Y.encodeStateAsUpdate(b))&&!Y.snapshotContainsUpdate(Y.snapshot(b),Y.encodeStateAsUpdate(a));
}
export function binaryRecoverySources(a,b,merged){
 const final=versions(merged),loss=source=>[...versions(source)].some(([id,hash])=>final.get(id)!==hash);
 return[a,b].filter(loss);
}
