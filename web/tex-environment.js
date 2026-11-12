// Supplied by Vite from the pinned distribution, wrapper/adapter bytes and catalog.
export const TEX_RUNTIME=typeof __TEX_RUNTIME__==='undefined'?null:__TEX_RUNTIME__;
export const MAX_BUNDLE_BYTES=120*1024*1024+80*1024;
export function environmentJson(lock){return JSON.stringify(lock,null,2)+'\n';}

export class TexEnvironmentError extends Error {name='TexEnvironmentError';}

export const TEX_ASSETS=typeof __TEX_ASSETS__==='undefined'?null:__TEX_ASSETS__;
export const TEX_ASSET_BASE=(import.meta.env?.VITE_TEX_ASSET_BASE||`${import.meta.env?.BASE_URL||'/'}core/busytex`).replace(/\/$/,'');
export function packageLabel(name,info){return info?.origin==='distribution'||name.startsWith('dist--')?`${info?.label||name.replace(/^dist--/,'')} · bundled component`:`${name} r${info.revision}${info.archive?' · static support':''}`;}
