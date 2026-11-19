import init from './pkg/scribyra_app.js';
import {packageOperations} from './tex-packages-ops.js';
const ready=init();ready.catch(()=>{});
const handle=packageOperations({ready});
self.onmessage=({data})=>handle(data,(message,transfer)=>self.postMessage(message,transfer));
