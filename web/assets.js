import * as Y from 'yjs';
import { blob_hash, valid_blob_hash } from './pkg/scribyra_app.js';

const caches = new WeakMap();
const MAX_BYTES = 64 * 1024 * 1024;
function cache(doc) {
  let blobs = caches.get(doc);
  if (!blobs) {
    blobs = new Map(); caches.set(doc,blobs);
    doc.getMap('assets').observe(() => {
      const used = new Set([...doc.getMap('assets').values()].map(ref=>ref?.hash).filter(Boolean));
      for (const hash of blobs.keys()) if (!used.has(hash)) blobs.delete(hash);
    });
  }
  return blobs;
}
export function isBlobRef(ref) { return ref && typeof ref.hash === 'string' && valid_blob_hash(ref.hash) && Number.isSafeInteger(ref.size) && ref.size >= 0 && ref.size <= MAX_BYTES; }
export function blobRefs(doc) {
  const refs = new Map();
  for (const value of doc.getMap('assets').values()) {
    if (value instanceof Uint8Array) continue; // Historical revisions retain their original representation.
    if (!isBlobRef(value)) throw new Error('Invalid binary asset reference.');
    if (refs.has(value.hash) && refs.get(value.hash).size !== value.size) throw new Error('Inconsistent binary asset size.');
    refs.set(value.hash,value);
  }
  return [...refs.values()];
}
export function prepareBlob(doc, bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength > MAX_BYTES) throw new Error('Binary asset exceeds 64 MiB or has invalid bytes.');
  const copy = new Uint8Array(bytes), hash = blob_hash(copy);
  cache(doc).set(hash,copy); return { hash, size: copy.byteLength };
}
export function verifyBlob(ref, bytes) {
  if (!isBlobRef(ref) || !(bytes instanceof Uint8Array) || ref.size !== bytes.byteLength || blob_hash(bytes) !== ref.hash) throw new Error('Binary asset integrity check failed.');
}
export function installBlob(doc, ref, bytes) {
  verifyBlob(ref,bytes);
  cache(doc).set(ref.hash,new Uint8Array(bytes));
}
// Internal adapters treat returned buffers as immutable. User-facing reads get copies.
export function knownBlob(doc, hash) { return cache(doc).get(hash); }
export function copyBlobs(source, target) { for (const [hash,bytes] of cache(source)) cache(target).set(hash,bytes); }
export function cloneProject(doc) { const copy=new Y.Doc();Y.applyUpdate(copy,Y.encodeStateAsUpdate(doc));copyBlobs(doc,copy);return copy; }
export function assetBytes(doc, id) {
  const ref=doc.getMap('assets').get(id);
  if (ref instanceof Uint8Array) return new Uint8Array(ref);
  if (!isBlobRef(ref)) throw new Error('Binary asset is missing or invalid.');
  const bytes=knownBlob(doc,ref.hash);
  if (!bytes) throw new Error('Binary asset is not available on this device yet. Reconnect to its source.');
  return new Uint8Array(bytes);
}
export function assetSize(doc,id) { const ref=doc.getMap('assets').get(id);return ref instanceof Uint8Array ? ref.byteLength : isBlobRef(ref) ? ref.size : 0; }
export function migrateAssets(doc) {
  for (const [id,value] of doc.getMap('assets')) if (value instanceof Uint8Array) doc.getMap('assets').set(id,prepareBlob(doc,value));
}
