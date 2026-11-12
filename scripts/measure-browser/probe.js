// Measurement-only wrapper. Weak references avoid keeping discarded instances
// alive. Linear-memory capacity is not RSS, heap use or a worker's total memory.
(()=>{
 if(globalThis.__scribyraMemoryProbe)return;
 const probe=globalThis.__scribyraMemoryProbe={instances:[],growths:[],peakIndividualBytes:0};
 let previous='';
 const emit=()=>{const memories=[...new Set(probe.instances.map(ref=>ref.deref()).filter(Boolean))],linearBytes=memories.map(m=>m.buffer.byteLength);probe.peakIndividualBytes=Math.max(probe.peakIndividualBytes,...linearBytes);const value=JSON.stringify({kind:globalThis.__scribyraMeasurementKind||'unknown',linearBytes,peakIndividualBytes:probe.peakIndividualBytes});if(previous!==value){previous=value;console.debug('SCRIBYRA_MEASURE_LINEAR '+value);}};
 const record=result=>{const instance=result?.instance||result;if(instance?.exports)for(const value of Object.values(instance.exports))if(value instanceof WebAssembly.Memory){probe.instances.push(new WeakRef(value));probe.peakIndividualBytes=Math.max(probe.peakIndividualBytes,value.buffer.byteLength);}emit();return result;};
 for(const name of ['instantiate','instantiateStreaming']){const original=WebAssembly[name];if(original)WebAssembly[name]=function(...args){return original.apply(this,args).then(record);};}
 const grow=WebAssembly.Memory.prototype.grow;WebAssembly.Memory.prototype.grow=function(...args){const value=grow.apply(this,args);probe.peakIndividualBytes=Math.max(probe.peakIndividualBytes,this.buffer.byteLength);probe.growths.push(this.buffer.byteLength);emit();return value;};
 const post=globalThis.postMessage;if(post)globalThis.postMessage=function(...args){emit();return post.apply(this,args);};
})();
