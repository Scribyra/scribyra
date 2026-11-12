// Undo boundary, deleted-content disclosure, tab-level behaviour relevant to joining.
import {Lab,save,sleep,manual} from './lab.mjs';const out={};
for(const ea of ['chromium','firefox']){const lab=new Lab();const r={};try{const ha=await lab.host('a'),hb=await lab.host('b');const a=await lab.agent(ha,ea),b=await lab.agent(hb,ea);await a.call('setup',{me:'a',fixture:'/thesis.json'});await b.call('setup',{me:'b',seedless:true});
 await manual(a,b,'p');await b.call('initialSync',{id:'p'});await a.call('live',{id:'p'});await b.call('live',{id:'p'});
 await a.call('undoInit',{});await b.call('undoInit',{});await a.call('edit',{text:'%ALICE%'});await b.call('waitText',{text:'%ALICE%'});await b.call('edit',{text:'%BOB%'});await a.call('waitText',{text:'%BOB%'});
 r.undoDepth={a:await a.call('undoDepth'),b:await b.call('undoDepth')};await b.call('undoNow');await a.call('waitText',{text:'%ALICE%'});await sleep(300);r.afterBobUndo={a:await a.call('read',{n:30}),b:await b.call('read',{n:30})};
 r.trash=await a.call('deleteProbe');r.deleted=await a.call('inPlaceDeleteProbe');r.deletedWithUndoManager=await a.call('inPlaceDeleteProbeUndoTracked');
}catch(e){r.error=String(e).slice(0,400);}out[ea]=r;console.log(ea,JSON.stringify(r));await lab.close();}
save('app',out);process.exit(0);
