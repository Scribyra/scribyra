// Validates an address a build was given. No address lives in application code.
export function telemetryDestination(endpoint,anonymous){
 let url;try{url=new URL(endpoint);}catch{throw Error('Enter a telemetry endpoint.');}
 const faro=anonymous&&/^\/collect(?:\/[a-zA-Z0-9_-]+)?$/.test(url.pathname);
 if(url.href!==endpoint||url.username||url.password||url.search||url.hash||!faro&&url.pathname!==(anonymous?'/v1/browser-events':'/v1/events')||!['https:','http:'].includes(url.protocol)||url.protocol==='http:'&&!['127.0.0.1','localhost','[::1]'].includes(url.hostname))throw Error('Use HTTPS, or loopback HTTP, with /collect[/id] or the ingestion path.');
 return{url,faro};
}
