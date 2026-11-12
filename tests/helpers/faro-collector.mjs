// What the production Faro collector does with a request, as probed against it.
// The first two messages are the collector's exact words. It was not seen to answer a
// header that disagrees with meta.session.id; that third message is ours.
export const FARO_ALLOWED_HEADERS='content-type,x-faro-session-id';
export const FARO_MISSING_SESSION='missing X-Faro-Session-Id header, activate the SessionInstrumentation';
export const FARO_MISSING_SDK='no SDK version';
export const FARO_SESSION_MISMATCH='X-Faro-Session-Id header does not match meta.session.id';

// A preflight passes only if every requested header is one the collector allows.
export function faroPreflightAllows(headers){
 const requested=String(headers['access-control-request-headers']??'').split(',').map(name=>name.trim().toLowerCase()).filter(Boolean);
 const allowed=FARO_ALLOWED_HEADERS.split(',');
 return headers['access-control-request-method']==='POST'&&requested.every(name=>allowed.includes(name));
}

export function faroPreflightHeaders(headers){
 return faroPreflightAllows(headers)?{'Access-Control-Allow-Origin':headers.origin||'null','Access-Control-Allow-Headers':FARO_ALLOWED_HEADERS,'Access-Control-Allow-Methods':'POST,OPTIONS'}:{};
}

// Returns the status and body the real collector would send for this POST.
export function faroVerdict(headers,encoded){
 const session=headers['x-faro-session-id'];
 if(typeof session!=='string'||!session)return{status:400,message:FARO_MISSING_SESSION};
 let body;try{body=JSON.parse(encoded);}catch{return{status:400,message:'invalid payload'};}
 const sdk=body?.meta?.sdk;
 if(typeof sdk?.version!=='string'||!sdk.version)return{status:400,message:FARO_MISSING_SDK};
 if(body.meta.session?.id!==session)return{status:400,message:FARO_SESSION_MISMATCH};
 return{status:202,message:'ok'};
}
