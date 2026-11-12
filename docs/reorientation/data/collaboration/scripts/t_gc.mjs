import {createRequire} from 'node:module';const require=createRequire('<repo>/package.json');const Y=require('yjs');
const has=(d,m)=>Buffer.from(Y.encodeStateAsUpdate(d)).includes(m);
{const d=new Y.Doc(),t=d.getText('x');t.insert(0,'KEEP');t.insert(0,'SECRET1');t.delete(0,7);console.log('no UndoManager, deleted text in update:',has(d,'SECRET1'));}
{const d=new Y.Doc(),t=d.getText('x');const u=new Y.UndoManager(t,{trackedOrigins:new Set([null]),captureTimeout:0});t.insert(0,'SECRET2');t.delete(0,7);const inLive=has(d,'SECRET2');const r=new Y.Doc();Y.applyUpdate(r,Y.encodeStateAsUpdate(d));console.log('UndoManager attached, in update:',inLive,'| after reload into a fresh doc:',has(r,'SECRET2'));u.destroy();}
{const d=new Y.Doc(),t=d.getText('x');const u=new Y.UndoManager(t,{trackedOrigins:new Set([null]),captureTimeout:0});t.insert(0,'SECRET3');t.delete(0,7);const sv=new Y.Doc();Y.applyUpdate(sv,Y.encodeStateAsUpdate(d));const st=Buffer.from(Y.encodeStateAsUpdate(sv));console.log('peer receiving from a doc with live UM; peer holds marker after apply:',st.includes('SECRET3'));}
{const d=new Y.Doc(),t=d.getText('x');t.insert(0,'abc');console.log('update exposes clientIDs only; example SV size',Y.encodeStateVector(d).length);}
process.exit(0);
