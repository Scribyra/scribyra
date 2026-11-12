// Anonymous delivery sessions: lifetime and build-time sampling. Pure, so the build,
// the transport and the tests share one definition.

// Grafana ends a Frontend Observability session after at most four hours; a shorter
// cap only splits one sitting into more billed sessions.
export const SESSION_MAX_AGE_MS=4*3600000;
// The only shares of sessions a build may send, matching Rust's SESSION_RATES.
export const SESSION_RATES=Object.freeze([1,.5,.25,.1,.01]);

// A build value: unset or empty means every session; anything else must be listed.
// Returns NaN for an invalid value, so a caller can refuse to collect at all.
export function parseSessionRate(value){
 if(value===undefined||value===null||value==='')return 1;
 const text=String(value).trim(),rate=/^(?:1|0\.5|0\.25|0\.1|0\.01)$/.test(text)?Number(text):NaN;
 return SESSION_RATES.includes(rate)?rate:NaN;
}

// Decided once from the session's own random ID: the same ID always gets the same
// answer, and a session in at a lower rate is also in at every higher one.
export function sessionSampled(id,rate){
 if(!/^[a-f0-9]{16}$/.test(id)||!SESSION_RATES.includes(rate))return false;
 return rate===1||parseInt(id.slice(8),16)<Math.floor(rate*4294967296);
}
