export const insertionOrder=patch=>patch.insertionOrder??(parseInt((patch.key||patch.id).replaceAll('-','').slice(0,12),16)/0x1000000000000||0);
export const compareInsertions=(a,b)=>insertionOrder(a)-insertionOrder(b)||(a.key||a.id).localeCompare(b.key||b.id);
