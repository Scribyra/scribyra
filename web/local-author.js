import {boundedText} from './build-errors.js';
// Device attribution is descriptive metadata, never an authorization grant.
export function localAuthor(preferences=globalThis.localStorage){
 let author;try{author=JSON.parse(preferences?.getItem('scribyra:author'));}catch{}
 if(!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(author?.id||''))author={id:crypto.randomUUID(),displayName:'Local author'};
 author={id:author.id,kind:'human',displayName:boundedText(author.displayName||'Local author',160)};
 try{preferences?.setItem('scribyra:author',JSON.stringify(author));}catch{}
 return author;
}
