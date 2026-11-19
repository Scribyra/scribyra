// Bibliography field values as plain text for lists and completion: accents and
// macros resolved, braces dropped. Pure; shared by the completion index and plugins.
const ACCENTS=/\\[`'^"~=.]\s*\{?\s*([A-Za-z])\s*\}?|\\(?:[ckvuHrdb])\s*\{\s*([A-Za-z])\s*\}/g;
export function plainBibText(value){
  return value.replace(/\\(La)?TeX\b\s*/g,(_,la)=>la?'LaTeX':'TeX').replace(ACCENTS,(_,a,b)=>a||b).replace(/\\(ss|ae|oe|aa|o|l|AE|OE|AA|O|L)\b\s*/g,'$1').replace(/\\&/g,'&').replace(/\\[A-Za-z]+\s*/g,'').replace(/[{}]/g,'').replace(/~/g,' ').replace(/\s+/g,' ').trim();
}
export function shortAuthors(value){
  const names=plainBibText(value).split(/\s+and\s+/i).map(name=>name.trim()).filter(Boolean);if(!names.length)return '';
  const last=name=>name.includes(',')?name.slice(0,name.indexOf(',')).trim():name.split(' ').at(-1);
  if(names.length===1)return last(names[0]);if(names.length===2)return `${last(names[0])} and ${last(names[1])}`;return `${last(names[0])} et al.`;
}
